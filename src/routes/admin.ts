import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
  audit,
  getClientSummary,
  getPayments,
  getPurchases,
  ensureClientSchema,
  listClientSummaries,
  NOT_DELETED,
  nowIso,
  purchaseRemainingExpr,
} from "../lib/db";
import { requireAdmin } from "../lib/http";
import { dropClientPush, ensurePushSchema, localToday, pushStats, sendReminders } from "../lib/push";
import { SCHEDULE_EVERY, ensureScheduleSchema, getSchedule, nextDue, planDates, type ScheduleEvery } from "../lib/schedule";
import { activeLink, linkUrl, newAccessToken, revokeActiveTokens } from "../lib/links";
import { csvResponse, money } from "../lib/csv";
import {
  HttpError,
  ValidationError,
  integer,
  isUuid,
  isoDate,
  obj,
  parseMoney,
  paymentMethod,
  phone,
  text,
  uuid,
} from "../lib/validate";

export const admin = new Hono<AppEnv>();
admin.use("*", requireAdmin);
admin.use("*", async (c, next) => {
  await Promise.all([ensurePushSchema(c.env.DB), ensureClientSchema(c.env.DB), ensureScheduleSchema(c.env.DB)]);
  await next();
});


async function body(c: { req: { json: () => Promise<unknown> } }) {
  return obj(await c.req.json().catch(() => null));
}

function idParam(v: string | undefined): string {
  if (!v || !isUuid(v)) throw new HttpError(404, "No encontrado");
  return v;
}

// Compras y abonos de clientas no eliminadas (para totales del resumen).
const LIVE_CLIENT = `client_id NOT IN (SELECT client_id FROM deleted_clients)`;

/** La clienta existe y no fue eliminada. */
async function requireClient(db: D1Database, id: string) {
  const exists = await db.prepare(`SELECT id FROM clients c WHERE c.id = ?1 AND ${NOT_DELETED}`).bind(id).first();
  if (!exists) throw new HttpError(404, "Cliente no encontrado");
}

function isGuardFailure(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return m.includes("NOT NULL constraint failed: payments.amount_cents");
}

// --- Indicadores -------------------------------------------------------------

admin.get("/dashboard", async (c) => {
  const db = c.env.DB;
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + "01";
  const [totals, month, clients] = await db.batch([
    db.prepare(
      `SELECT
         COALESCE((SELECT SUM(total_cents) FROM purchases WHERE status = 'active' AND ${LIVE_CLIENT}), 0) AS purchases_cents,
         COALESCE((SELECT SUM(amount_cents) FROM payments WHERE status = 'valid' AND ${LIVE_CLIENT}), 0) AS paid_cents`,
    ),
    db
      .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS paid_month_cents, COUNT(*) AS payments_month FROM payments WHERE status = 'valid' AND paid_at >= ?1 AND ${LIVE_CLIENT}`)
      .bind(monthStart),
    db.prepare(`SELECT COUNT(*) AS n FROM clients c WHERE ${NOT_DELETED}`),
  ]);
  const t = totals.results[0] as { purchases_cents: number; paid_cents: number };
  const m = month.results[0] as { paid_month_cents: number; payments_month: number };
  const list = await listClientSummaries(db);
  const pending = list.filter((x) => x.status === "pendiente");
  const credit = list.filter((x) => x.status === "a_favor");
  const overdue = pending.filter((x) => x.next_due_date && x.next_due_date < today);
  // Abonos programados que tocan hoy o ya vencieron sin cubrirse.
  const local = localToday();
  const { results: withDue } = await db
    .prepare(`SELECT DISTINCT client_id FROM scheduled_payments s WHERE due_date <= ?1 AND client_id NOT IN (SELECT client_id FROM deleted_clients) LIMIT 200`)
    .bind(local)
    .all<{ client_id: string }>();
  const names = new Map(list.map((x) => [x.id, x.name]));
  const scheduledDue = (
    await Promise.all(
      withDue.map(async ({ client_id }) => {
        const n = nextDue(await getSchedule(db, client_id, local));
        return n && n.due_date <= local ? { client_id, name: names.get(client_id) ?? "", due_date: n.due_date, remaining_cents: n.remaining_cents, state: n.state } : null;
      }),
    )
  )
    .filter((x) => x !== null)
    .sort((x, y) => x.due_date.localeCompare(y.due_date));
  return c.json({
    purchases_cents: t.purchases_cents,
    paid_cents: t.paid_cents,
    // Lo que deben las clientas, sin restar los saldos a favor de otras.
    balance_cents: pending.reduce((sum, x) => sum + x.balance_cents, 0),
    credit_cents: credit.reduce((sum, x) => sum - x.balance_cents, 0),
    paid_month_cents: m.paid_month_cents,
    payments_month: m.payments_month,
    clients_total: (clients.results[0] as { n: number }).n,
    clients_pending: pending.length,
    clients_settled: list.filter((x) => x.status === "liquidada").length,
    clients_credit: credit.length,
    clients_overdue: overdue.length,
    scheduled_due: scheduledDue,
    top_pending: pending.sort((a, b) => b.balance_cents - a.balance_cents).slice(0, 5),
  });
});

// --- Clientes ----------------------------------------------------------------

admin.get("/clients", async (c) => {
  const q = c.req.query("q") ?? "";
  const status = c.req.query("status") ?? "";
  const deleted = status === "eliminadas";
  return c.json({ clients: await listClientSummaries(c.env.DB, { q, status: deleted ? "" : status, deleted }) });
});

admin.post("/clients", async (c) => {
  const b = await body(c);
  const name = text("name", b.name, { required: true, max: 120 });
  const tel = phone("phone", b.phone);
  const notes = text("notes", b.notes, { max: 1000 });
  const a = c.get("admin");
  const db = c.env.DB;
  const id = crypto.randomUUID();
  const link = await newAccessToken(db, c.env.APP_SECRET, id, a.id);
  await db.batch([
    db.prepare(`INSERT INTO clients (id, name, phone, notes) VALUES (?1, ?2, ?3, ?4)`).bind(id, name, tel, notes),
    link.stmt,
    audit(db, { adminId: a.id, action: "cliente_creado", entityType: "client", entityId: id, details: { name, phone: tel }, ipHash: c.get("ipHash") }),
  ]);
  return c.json({ client: await getClientSummary(db, id), link: linkUrl(new URL(c.req.url).origin, link.token) }, 201);
});

admin.get("/clients/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  const db = c.env.DB;
  await requireClient(db, id);
  const client = await getClientSummary(db, id);
  if (!client) throw new HttpError(404, "Cliente no encontrado");
  const [purchases, payments, link, push, schedule] = await Promise.all([
    getPurchases(db, id),
    getPayments(db, id),
    activeLink(db, c.env.APP_SECRET, id),
    pushStats(db, id),
    getSchedule(db, id, localToday()),
  ]);
  return c.json({
    client,
    purchases,
    payments,
    push: { devices: push.devices },
    schedule,
    link: link
      ? { active: true, url: link.token ? linkUrl(new URL(c.req.url).origin, link.token) : null, created_at: link.created_at, last_used_at: link.last_used_at }
      : { active: false, url: null },
  });
});

admin.patch("/clients/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  const b = await body(c);
  const db = c.env.DB;
  const before = await db.prepare(`SELECT name, phone, notes FROM clients WHERE id = ?1`).bind(id).first<{ name: string; phone: string; notes: string }>();
  if (!before) throw new HttpError(404, "Cliente no encontrado");
  const after = {
    name: b.name !== undefined ? text("name", b.name, { required: true, max: 120 }) : before.name,
    phone: b.phone !== undefined ? phone("phone", b.phone) : before.phone,
    notes: b.notes !== undefined ? text("notes", b.notes, { max: 1000 }) : before.notes,
  };
  await db.batch([
    db.prepare(`UPDATE clients SET name = ?1, phone = ?2, notes = ?3, updated_at = ?4 WHERE id = ?5`).bind(after.name, after.phone, after.notes, nowIso(), id),
    audit(db, { adminId: c.get("admin").id, action: "cliente_editado", entityType: "client", entityId: id, details: { before, after }, ipHash: c.get("ipHash") }),
  ]);
  return c.json({ client: await getClientSummary(db, id) });
});

// --- Abonos programados ------------------------------------------------------------

/** Fecha de abono programado: válida y no anterior a hoy (hora de México). */
function futureDate(field: string, v: unknown): string {
  const d = isoDate(field, v, { required: true })!;
  if (d < localToday()) throw new ValidationError(field, "La fecha no puede ser anterior a hoy");
  return d;
}

async function loadScheduled(db: D1Database, clientId: string, sid: string) {
  const row = await db
    .prepare(`SELECT id, due_date, amount_cents FROM scheduled_payments WHERE id = ?1 AND client_id = ?2`)
    .bind(sid, clientId)
    .first<{ id: string; due_date: string; amount_cents: number }>();
  if (!row) throw new HttpError(404, "Abono programado no encontrado");
  return row;
}

/** Programa uno o varios abonos: primera fecha, importe y cada cuánto. */
admin.post("/clients/:id/schedule", async (c) => {
  const id = idParam(c.req.param("id"));
  const db = c.env.DB;
  await requireClient(db, id);
  const b = await body(c);
  const first = futureDate("first_date", b.first_date);
  const amount = parseMoney("amount", b.amount);
  const every = (SCHEDULE_EVERY as readonly string[]).includes(String(b.every)) ? (b.every as ScheduleEvery) : "una_vez";
  const count = every === "una_vez" ? 1 : integer("count", b.count ?? 1, 1, 52);
  const existing = await db.prepare(`SELECT COUNT(*) AS n FROM scheduled_payments WHERE client_id = ?1`).bind(id).first<{ n: number }>();
  if ((existing?.n ?? 0) + count > 104) throw new ValidationError("count", "Demasiados abonos programados para esta clienta");
  const a = c.get("admin");
  const today = localToday();
  const dates = planDates(first, every, count);
  await db.batch([
    ...dates.map((d) =>
      db
        .prepare(`INSERT INTO scheduled_payments (id, client_id, due_date, amount_cents, created_on, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
        .bind(crypto.randomUUID(), id, d, amount, today, a.id),
    ),
    audit(db, {
      adminId: a.id,
      action: "abonos_programados",
      entityType: "client",
      entityId: id,
      details: { amount_cents: amount, count: dates.length, first_date: first, every },
      ipHash: c.get("ipHash"),
    }),
  ]);
  return c.json({ schedule: await getSchedule(db, id, today) }, 201);
});

/** Reprograma un abono: nueva fecha y/o importe. */
admin.patch("/clients/:id/schedule/:sid", async (c) => {
  const id = idParam(c.req.param("id"));
  const sid = idParam(c.req.param("sid"));
  const db = c.env.DB;
  await requireClient(db, id);
  const before = await loadScheduled(db, id, sid);
  const b = await body(c);
  const due = b.due_date !== undefined ? futureDate("due_date", b.due_date) : before.due_date;
  const amount = b.amount !== undefined && b.amount !== "" ? parseMoney("amount", b.amount) : before.amount_cents;
  await db.batch([
    db
      .prepare(
        `UPDATE scheduled_payments SET due_date = ?1, amount_cents = ?2,
           rescheduled_from = CASE WHEN ?1 <> due_date THEN COALESCE(rescheduled_from, due_date) ELSE rescheduled_from END
         WHERE id = ?3`,
      )
      .bind(due, amount, sid),
    audit(db, {
      adminId: c.get("admin").id,
      action: "abono_reprogramado",
      entityType: "client",
      entityId: id,
      details: { before: { due_date: before.due_date, amount_cents: before.amount_cents }, after: { due_date: due, amount_cents: amount } },
      ipHash: c.get("ipHash"),
    }),
  ]);
  return c.json({ schedule: await getSchedule(db, id, localToday()) });
});

admin.delete("/clients/:id/schedule/:sid", async (c) => {
  const id = idParam(c.req.param("id"));
  const sid = idParam(c.req.param("sid"));
  const db = c.env.DB;
  await requireClient(db, id);
  const before = await loadScheduled(db, id, sid);
  await db.batch([
    db.prepare(`DELETE FROM scheduled_payments WHERE id = ?1`).bind(sid),
    audit(db, {
      adminId: c.get("admin").id,
      action: "abono_programado_quitado",
      entityType: "client",
      entityId: id,
      details: { due_date: before.due_date, amount_cents: before.amount_cents },
      ipHash: c.get("ipHash"),
    }),
  ]);
  return c.json({ schedule: await getSchedule(db, id, localToday()) });
});

// --- Eliminar y recuperar ---------------------------------------------------------

/**
 * Elimina a la clienta del panel. No borra compras, abonos ni auditoría (son inmutables):
 * deja de aparecer en listas, totales, exportaciones y avisos, y su enlace se revoca.
 */
admin.delete("/clients/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  const db = c.env.DB;
  await requireClient(db, id);
  const client = (await getClientSummary(db, id))!;
  const a = c.get("admin");
  await db.batch([
    dropClientPush(db, id),
    revokeActiveTokens(db, id, a.id, nowIso()),
    db.prepare(`INSERT INTO deleted_clients (client_id, deleted_by) VALUES (?1, ?2)`).bind(id, a.id),
    audit(db, {
      adminId: a.id,
      action: "cliente_eliminado",
      entityType: "client",
      entityId: id,
      details: { name: client.name, balance_cents: client.balance_cents },
      ipHash: c.get("ipHash"),
    }),
  ]);
  return c.json({ deleted: true });
});

/** Recupera a una clienta eliminada. Su enlace sigue revocado: hay que generar uno nuevo. */
admin.post("/clients/:id/restore", async (c) => {
  const id = idParam(c.req.param("id"));
  const db = c.env.DB;
  const a = c.get("admin");
  const row = await db
    .prepare(`SELECT c.name FROM deleted_clients d JOIN clients c ON c.id = d.client_id WHERE d.client_id = ?1`)
    .bind(id)
    .first<{ name: string }>();
  if (!row) throw new HttpError(404, "Cliente no encontrado entre las eliminadas");
  await db.batch([
    db.prepare(`DELETE FROM deleted_clients WHERE client_id = ?1`).bind(id),
    audit(db, { adminId: a.id, action: "cliente_recuperado", entityType: "client", entityId: id, details: { name: row.name }, ipHash: c.get("ipHash") }),
  ]);
  return c.json({ client: await getClientSummary(db, id) });
});

// --- Enlaces privados ----------------------------------------------------------

admin.post("/clients/:id/link/regenerate", async (c) => {
  const id = idParam(c.req.param("id"));
  const db = c.env.DB;
  await requireClient(db, id);
  const a = c.get("admin");
  const link = await newAccessToken(db, c.env.APP_SECRET, id, a.id);
  await db.batch([
    dropClientPush(db, id),
    revokeActiveTokens(db, id, a.id, nowIso()),
    link.stmt,
    audit(db, { adminId: a.id, action: "enlace_regenerado", entityType: "client", entityId: id, details: { token_id: link.id }, ipHash: c.get("ipHash") }),
  ]);
  return c.json({ url: linkUrl(new URL(c.req.url).origin, link.token) });
});

admin.post("/clients/:id/link/revoke", async (c) => {
  const id = idParam(c.req.param("id"));
  const db = c.env.DB;
  await requireClient(db, id);
  const a = c.get("admin");
  const [, res] = await db.batch([
    dropClientPush(db, id),
    revokeActiveTokens(db, id, a.id, nowIso()),
    audit(db, { adminId: a.id, action: "enlace_revocado", entityType: "client", entityId: id, ipHash: c.get("ipHash") }),
  ]);
  return c.json({ revoked: res.meta.changes });
});

// --- Avisos push ----------------------------------------------------------------

admin.get("/push", async (c) => c.json(await pushStats(c.env.DB)));

/** Recordatorio de pago a todas las clientas con avisos activos y saldo pendiente. */
admin.post("/push/reminder", async (c) => {
  const db = c.env.DB;
  const r = await sendReminders(c.env, null);
  await audit(db, { adminId: c.get("admin").id, action: "recordatorio_general", entityType: "push", entityId: null, details: r, ipHash: c.get("ipHash") }).run();
  return c.json(r);
});

/** Recordatorio de pago a una clienta (todos sus dispositivos con avisos activos). */
admin.post("/clients/:id/push/reminder", async (c) => {
  const id = idParam(c.req.param("id"));
  const db = c.env.DB;
  const client = await getClientSummary(db, id);
  if (!client) throw new HttpError(404, "Cliente no encontrado");
  if (client.balance_cents <= 0) throw new HttpError(409, "Esta clienta no tiene saldo pendiente");
  if ((await pushStats(db, id)).devices === 0) throw new HttpError(409, "Esta clienta no ha activado los avisos en su portal");
  const r = await sendReminders(c.env, id);
  await audit(db, { adminId: c.get("admin").id, action: "recordatorio_enviado", entityType: "client", entityId: id, details: r, ipHash: c.get("ipHash") }).run();
  return c.json(r);
});

// --- Compras -------------------------------------------------------------------

admin.post("/clients/:id/purchases", async (c) => {
  const clientId = idParam(c.req.param("id"));
  const db = c.env.DB;
  await requireClient(db, clientId);
  const b = await body(c);
  const purchaseDate = isoDate("purchase_date", b.purchase_date, { required: true })!;
  const dueDate = isoDate("due_date", b.due_date);
  if (dueDate && dueDate < purchaseDate) throw new ValidationError("due_date", "La fecha límite no puede ser anterior a la compra");
  const notes = text("notes", b.notes, { max: 500 });
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 50) {
    throw new ValidationError("items", "Agrega entre 1 y 50 prendas");
  }
  const items = b.items.map((raw, i) => {
    const it = obj(raw);
    const quantity = integer(`items.${i}.quantity`, it.quantity ?? 1, 1, 1000);
    const unit = parseMoney(`items.${i}.unit_price`, it.unit_price, { allowZero: true });
    return {
      description: text(`items.${i}.description`, it.description, { required: true, max: 200 }),
      size: text(`items.${i}.size`, it.size, { max: 30 }),
      quantity,
      unit,
      line: quantity * unit,
    };
  });
  const subtotal = items.reduce((s, it) => s + it.line, 0);
  const discount = b.discount === undefined || b.discount === "" ? 0 : parseMoney("discount", b.discount, { allowZero: true });
  if (discount > subtotal) throw new ValidationError("discount", "El descuento no puede ser mayor que el subtotal");
  if (subtotal - discount <= 0) throw new ValidationError("items", "El total de la compra debe ser mayor que cero");
  if (!Number.isSafeInteger(subtotal) || subtotal > 1_000_000_000) throw new ValidationError("items", "Total demasiado grande");

  const a = c.get("admin");
  const id = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO purchases (id, client_id, purchase_date, due_date, subtotal_cents, discount_cents, total_cents, notes, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(id, clientId, purchaseDate, dueDate, subtotal, discount, subtotal - discount, notes, a.id),
    ...items.map((it, i) =>
      db
        .prepare(
          `INSERT INTO purchase_items (id, purchase_id, position, description, size, quantity, unit_price_cents, line_total_cents)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(crypto.randomUUID(), id, i, it.description, it.size, it.quantity, it.unit, it.line),
    ),
    audit(db, {
      adminId: a.id,
      action: "compra_registrada",
      entityType: "purchase",
      entityId: id,
      details: { client_id: clientId, total_cents: subtotal - discount, discount_cents: discount, items: items.length },
      ipHash: c.get("ipHash"),
    }),
  ];
  await db.batch(stmts);
  return c.json({ purchase_id: id, total_cents: subtotal - discount, client: await getClientSummary(db, clientId) }, 201);
});

admin.post("/purchases/:id/cancel", async (c) => {
  const id = idParam(c.req.param("id"));
  const b = await body(c);
  const reason = text("reason", b.reason, { required: true, min: 3, max: 300 });
  const db = c.env.DB;
  const p = await db.prepare(`SELECT client_id, status, total_cents FROM purchases WHERE id = ?1`).bind(id).first<{ client_id: string; status: string; total_cents: number }>();
  if (!p) throw new HttpError(404, "Compra no encontrada");
  if (p.status !== "active") throw new HttpError(409, "La compra ya estaba cancelada");
  const a = c.get("admin");
  const ts = nowIso() + ":" + crypto.randomUUID().slice(0, 8);
  const [upd] = await db.batch([
    db
      .prepare(
        `UPDATE purchases SET status = 'cancelled', cancelled_at = ?1, cancel_reason = ?2, cancelled_by = ?3
         WHERE id = ?4 AND status = 'active'
           AND NOT EXISTS (SELECT 1 FROM payments WHERE purchase_id = ?4 AND status = 'valid')`,
      )
      .bind(ts, reason, a.id, id),
    db
      .prepare(
        `INSERT INTO audit_log (admin_id, action, entity_type, entity_id, details, ip_hash)
         SELECT ?1, 'compra_cancelada', 'purchase', ?2, ?3, ?4
         WHERE EXISTS (SELECT 1 FROM purchases WHERE id = ?2 AND cancelled_at = ?5)`,
      )
      .bind(a.id, id, JSON.stringify({ client_id: p.client_id, total_cents: p.total_cents, reason }), c.get("ipHash"), ts),
  ]);
  if (upd.meta.changes !== 1) {
    throw new HttpError(409, "No se puede cancelar: primero anula los abonos asociados a esta compra");
  }
  return c.json({ ok: true, client: await getClientSummary(db, p.client_id) });
});

// --- Abonos --------------------------------------------------------------------

interface PaymentInput {
  amount: number;
  paidAt: string;
  method: string;
  note: string;
  purchaseId: string | null;
}

function parsePayment(b: Record<string, unknown>): PaymentInput {
  return {
    amount: parseMoney("amount", b.amount),
    paidAt: isoDate("paid_at", b.paid_at, { required: true })!,
    method: paymentMethod("method", b.method),
    note: text("note", b.note, { max: 300 }),
    purchaseId: b.purchase_id ? uuid("purchase_id", b.purchase_id) : null,
  };
}

async function checkPurchaseBelongs(db: D1Database, purchaseId: string | null, clientId: string) {
  if (!purchaseId) return;
  const p = await db.prepare(`SELECT status FROM purchases WHERE id = ?1 AND client_id = ?2`).bind(purchaseId, clientId).first<{ status: string }>();
  if (!p) throw new ValidationError("purchase_id", "La compra no pertenece a este cliente");
  if (p.status !== "active") throw new ValidationError("purchase_id", "La compra está cancelada");
}

/**
 * INSERT protegido. Un abono a la cuenta general puede exceder el saldo (queda saldo a favor);
 * uno aplicado a una compra no puede exceder lo que resta de esa compra. Si la condición falla, el importe es NULL y la restricción NOT NULL
 * aborta todo el lote, de modo que la validación y la escritura son atómicas.
 */
function guardedPaymentInsert(
  db: D1Database,
  p: PaymentInput & { id: string; clientId: string; adminId: string; replaces: string | null; requireVoidedAt: string | null },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO payments (id, client_id, purchase_id, amount_cents, paid_at, method, note, created_by, replaces_payment_id)
       VALUES (?1, ?2, ?3,
         CASE WHEN (?3 IS NULL OR (EXISTS (SELECT 1 FROM purchases WHERE id = ?3 AND client_id = ?2 AND status = 'active')
                                   AND ?4 <= ${purchaseRemainingExpr("?3")}))
               AND (?10 IS NULL OR EXISTS (SELECT 1 FROM payments WHERE id = ?9 AND status = 'voided' AND voided_at = ?10))
              THEN ?4 ELSE NULL END,
         ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(p.id, p.clientId, p.purchaseId, p.amount, p.paidAt, p.method, p.note, p.adminId, p.replaces, p.requireVoidedAt);
}

admin.post("/clients/:id/payments", async (c) => {
  const clientId = idParam(c.req.param("id"));
  const db = c.env.DB;
  await requireClient(db, clientId);
  const input = parsePayment(await body(c));
  await checkPurchaseBelongs(db, input.purchaseId, clientId);
  const a = c.get("admin");
  const id = crypto.randomUUID();
  try {
    await db.batch([
      guardedPaymentInsert(db, { ...input, id, clientId, adminId: a.id, replaces: null, requireVoidedAt: null }),
      audit(db, {
        adminId: a.id,
        action: "abono_registrado",
        entityType: "payment",
        entityId: id,
        details: { client_id: clientId, amount_cents: input.amount, method: input.method, paid_at: input.paidAt, purchase_id: input.purchaseId },
        ipHash: c.get("ipHash"),
      }),
    ]);
  } catch (err) {
    if (isGuardFailure(err)) throw new HttpError(409, "El abono excede lo que resta de la compra");
    throw err;
  }
  return c.json({ payment_id: id, client: await getClientSummary(db, clientId) }, 201);
});

async function loadPayment(db: D1Database, id: string) {
  const p = await db
    .prepare(`SELECT id, client_id, amount_cents, status FROM payments WHERE id = ?1`)
    .bind(id)
    .first<{ id: string; client_id: string; amount_cents: number; status: string }>();
  if (!p) throw new HttpError(404, "Abono no encontrado");
  if (p.status !== "valid") throw new HttpError(409, "El abono ya estaba anulado");
  return p;
}

admin.post("/payments/:id/void", async (c) => {
  const id = idParam(c.req.param("id"));
  const db = c.env.DB;
  const b = await body(c);
  const reason = text("reason", b.reason, { required: true, min: 3, max: 300 });
  const p = await loadPayment(db, id);
  const a = c.get("admin");
  const ts = nowIso() + ":" + crypto.randomUUID().slice(0, 8);
  const [upd] = await db.batch([
    db
      .prepare(`UPDATE payments SET status = 'voided', voided_at = ?1, void_reason = ?2, voided_by = ?3 WHERE id = ?4 AND status = 'valid'`)
      .bind(ts, reason, a.id, id),
    db
      .prepare(
        `INSERT INTO audit_log (admin_id, action, entity_type, entity_id, details, ip_hash)
         SELECT ?1, 'abono_anulado', 'payment', ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM payments WHERE id = ?2 AND voided_at = ?5)`,
      )
      .bind(a.id, id, JSON.stringify({ client_id: p.client_id, amount_cents: p.amount_cents, reason }), c.get("ipHash"), ts),
  ]);
  if (upd.meta.changes !== 1) throw new HttpError(409, "El abono ya estaba anulado");
  return c.json({ ok: true, client: await getClientSummary(db, p.client_id) });
});

/** Corrección auditada: anula el abono original y registra el importe correcto en una sola transacción. */
admin.post("/payments/:id/correct", async (c) => {
  const id = idParam(c.req.param("id"));
  const db = c.env.DB;
  const b = await body(c);
  const reason = text("reason", b.reason, { required: true, min: 3, max: 300 });
  const input = parsePayment(b);
  const old = await loadPayment(db, id);
  await checkPurchaseBelongs(db, input.purchaseId, old.client_id);
  const a = c.get("admin");
  const newId = crypto.randomUUID();
  const ts = nowIso() + ":" + crypto.randomUUID().slice(0, 8);
  try {
    await db.batch([
      db
        .prepare(`UPDATE payments SET status = 'voided', voided_at = ?1, void_reason = ?2, voided_by = ?3 WHERE id = ?4 AND status = 'valid'`)
        .bind(ts, "Corrección: " + reason, a.id, id),
      guardedPaymentInsert(db, { ...input, id: newId, clientId: old.client_id, adminId: a.id, replaces: id, requireVoidedAt: ts }),
      audit(db, {
        adminId: a.id,
        action: "abono_corregido",
        entityType: "payment",
        entityId: newId,
        details: { client_id: old.client_id, replaces: id, old_amount_cents: old.amount_cents, new_amount_cents: input.amount, reason },
        ipHash: c.get("ipHash"),
      }),
    ]);
  } catch (err) {
    if (isGuardFailure(err)) throw new HttpError(409, "La corrección excede lo que resta de la compra o el abono ya fue modificado");
    throw err;
  }
  return c.json({ payment_id: newId, client: await getClientSummary(db, old.client_id) }, 201);
});

// --- Auditoría -------------------------------------------------------------------

// Cliente al que pertenece cada registro (NULL = operaciones del sistema: accesos, contraseñas).
const AUDIT_CLIENT = `CASE WHEN l.entity_type = 'client' THEN l.entity_id ELSE json_extract(l.details, '$.client_id') END`;

admin.get("/audit", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
  const entity = c.req.query("entity_id");
  const db = c.env.DB;
  const cols = `SELECT l.id, l.created_at, l.action, l.entity_type, l.entity_id, l.details, a.username
                FROM audit_log l LEFT JOIN admins a ON a.id = l.admin_id`;
  if (entity === "sistema") {
    const res = await db.prepare(`${cols} WHERE ${AUDIT_CLIENT} IS NULL ORDER BY l.id DESC LIMIT ?1`).bind(limit).all();
    return c.json({ client: null, entries: res.results });
  }
  if (entity && isUuid(entity)) {
    const [client, res] = await Promise.all([
      db.prepare(`SELECT id, name, phone FROM clients WHERE id = ?1`).bind(entity).first(),
      db.prepare(`${cols} WHERE l.entity_id = ?1 OR json_extract(l.details, '$.client_id') = ?1 ORDER BY l.id DESC LIMIT ?2`).bind(entity, limit).all(),
    ]);
    return c.json({ client, entries: res.results });
  }
  const res = await db.prepare(`${cols} ORDER BY l.id DESC LIMIT ?1`).bind(limit).all();
  return c.json({ entries: res.results });
});

/** Un recuadro por cliente con su número de operaciones y la fecha de la última. */
admin.get("/audit/clients", async (c) => {
  const db = c.env.DB;
  const [clients, system] = await db.batch([
    db.prepare(
      `WITH x AS (SELECT ${AUDIT_CLIENT} AS cid, l.created_at FROM audit_log l)
       SELECT c.id, c.name, c.phone, COUNT(x.cid) AS entries, MAX(x.created_at) AS last_at
       FROM clients c LEFT JOIN x ON x.cid = c.id
       GROUP BY c.id ORDER BY last_at IS NULL, last_at DESC, c.name COLLATE NOCASE`,
    ),
    db.prepare(`SELECT COUNT(*) AS entries, MAX(l.created_at) AS last_at FROM audit_log l WHERE ${AUDIT_CLIENT} IS NULL`),
  ]);
  return c.json({ clients: clients.results, system: system.results[0] ?? { entries: 0, last_at: null } });
});

/** Detalle de una operación, con la compra o el abono al que se refiere. */
admin.get("/audit/entry/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(404, "Registro no encontrado");
  const db = c.env.DB;
  const entry = await db
    .prepare(
      `SELECT l.id, l.created_at, l.action, l.entity_type, l.entity_id, l.details, a.username, a.display_name
       FROM audit_log l LEFT JOIN admins a ON a.id = l.admin_id WHERE l.id = ?1`,
    )
    .bind(id)
    .first<{ entity_type: string; entity_id: string | null; details: string }>();
  if (!entry) throw new HttpError(404, "Registro no encontrado");
  let details: Record<string, unknown> = {};
  try {
    details = JSON.parse(entry.details || "{}");
  } catch {}
  const clientId = entry.entity_type === "client" ? entry.entity_id : typeof details.client_id === "string" ? details.client_id : null;
  const client = clientId ? await db.prepare(`SELECT id, name, phone FROM clients WHERE id = ?1`).bind(clientId).first() : null;

  let purchase = null;
  let payment = null;
  if (entry.entity_type === "purchase" && entry.entity_id) {
    const [p, items] = await db.batch([
      db.prepare(
        `SELECT id, purchase_date, due_date, subtotal_cents, discount_cents, total_cents, notes, status, cancelled_at, cancel_reason
         FROM purchases WHERE id = ?1`,
      ).bind(entry.entity_id),
      db.prepare(
        `SELECT description, size, quantity, unit_price_cents, line_total_cents FROM purchase_items WHERE purchase_id = ?1 ORDER BY position`,
      ).bind(entry.entity_id),
    ]);
    if (p.results[0]) purchase = { ...(p.results[0] as object), items: items.results };
  } else if (entry.entity_type === "payment" && entry.entity_id) {
    payment = await db
      .prepare(
        `SELECT y.id, y.amount_cents, y.paid_at, y.method, y.note, y.status, y.voided_at, y.void_reason,
                p.purchase_date AS purchase_date, p.total_cents AS purchase_total_cents
         FROM payments y LEFT JOIN purchases p ON p.id = y.purchase_id WHERE y.id = ?1`,
      )
      .bind(entry.entity_id)
      .first();
  }
  return c.json({ entry, client, purchase, payment });
});

// --- Exportaciones CSV (Excel) -------------------------------------------------

const STATUS_LABEL: Record<string, string> = { pendiente: "Debe", liquidada: "Al corriente", a_favor: "A favor", sin_compras: "Sin compras" };

admin.get("/export/clientes.csv", async (c) => {
  const list = await listClientSummaries(c.env.DB);
  const rows = list.map((x) => [
    x.name,
    x.phone,
    String(x.purchase_count),
    money(x.purchases_cents),
    money(x.paid_cents),
    money(Math.max(x.balance_cents, 0)),
    money(Math.max(-x.balance_cents, 0)),
    STATUS_LABEL[x.status],
    x.next_due_date ?? "",
    x.last_payment_at ?? "",
  ]);
  return csvResponse(
    "bloom-clientes",
    ["Cliente", "Teléfono", "Compras", "Total compras (MXN)", "Total abonado (MXN)", "Saldo pendiente (MXN)", "Saldo a favor (MXN)", "Estado", "Fecha límite", "Último abono"],
    rows,
    [3, 4, 5, 6],
  );
});

admin.get("/export/abonos.csv", async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT y.paid_at, c.name, c.phone, y.amount_cents, y.method, y.note, y.status, y.void_reason, y.purchase_id
     FROM payments y JOIN clients c ON c.id = y.client_id WHERE ${NOT_DELETED} ORDER BY y.paid_at, y.created_at`,
  ).all<{ paid_at: string; name: string; phone: string; amount_cents: number; method: string; note: string; status: string; void_reason: string | null; purchase_id: string | null }>();
  const rows = res.results.map((r) => [
    r.paid_at,
    r.name,
    r.phone,
    money(r.amount_cents),
    r.method,
    r.note,
    r.status === "valid" ? "Válido" : "Anulado",
    r.void_reason ?? "",
    r.purchase_id ?? "",
  ]);
  return csvResponse("bloom-abonos", ["Fecha", "Cliente", "Teléfono", "Importe (MXN)", "Método", "Nota", "Estado", "Motivo de anulación", "Compra"], rows, [3]);
});

admin.get("/export/compras.csv", async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT p.id, p.purchase_date, p.due_date, c.name, c.phone, p.subtotal_cents, p.discount_cents, p.total_cents, p.status,
            (SELECT group_concat(i.quantity || ' x ' || i.description || CASE WHEN i.size <> '' THEN ' (' || i.size || ')' ELSE '' END, '; ')
               FROM (SELECT * FROM purchase_items WHERE purchase_id = p.id ORDER BY position) i) AS prendas
     FROM purchases p JOIN clients c ON c.id = p.client_id WHERE ${NOT_DELETED} ORDER BY p.purchase_date, p.created_at`,
  ).all<{ id: string; purchase_date: string; due_date: string | null; name: string; phone: string; subtotal_cents: number; discount_cents: number; total_cents: number; status: string; prendas: string }>();
  const rows = res.results.map((r) => [
    r.purchase_date,
    r.name,
    r.phone,
    r.prendas ?? "",
    money(r.subtotal_cents),
    money(r.discount_cents),
    money(r.total_cents),
    r.status === "active" ? "Activa" : "Cancelada",
    r.due_date ?? "",
    r.id,
  ]);
  return csvResponse(
    "bloom-compras",
    ["Fecha", "Cliente", "Teléfono", "Prendas", "Subtotal (MXN)", "Descuento (MXN)", "Total (MXN)", "Estado", "Fecha límite", "Compra"],
    rows,
    [4, 5, 6],
  );
});
