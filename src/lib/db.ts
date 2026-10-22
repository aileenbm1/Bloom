// Consultas de lectura compartidas y cálculo de saldos.
// El saldo nunca se guarda: siempre se calcula a partir de compras activas y abonos válidos.

export interface ClientSummary {
  id: string;
  name: string;
  phone: string;
  notes: string;
  created_at: string;
  updated_at: string;
  purchases_cents: number;
  paid_cents: number;
  balance_cents: number;
  purchase_count: number;
  next_due_date: string | null;
  last_payment_at: string | null;
  /** pendiente: debe dinero · liquidada: al corriente · a_favor: pagó de más (saldo negativo). */
  status: "pendiente" | "liquidada" | "a_favor" | "sin_compras";
}

export const CLIENT_STATUSES = ["pendiente", "liquidada", "a_favor", "sin_compras"] as const;

const SUMMARY_SELECT = `
SELECT c.id, c.name, c.phone, c.notes, c.created_at, c.updated_at,
  COALESCE((SELECT SUM(p.total_cents) FROM purchases p WHERE p.client_id = c.id AND p.status = 'active'), 0) AS purchases_cents,
  COALESCE((SELECT SUM(y.amount_cents) FROM payments y WHERE y.client_id = c.id AND y.status = 'valid'), 0) AS paid_cents,
  (SELECT COUNT(*) FROM purchases p WHERE p.client_id = c.id AND p.status = 'active') AS purchase_count,
  (SELECT MIN(p.due_date) FROM purchases p WHERE p.client_id = c.id AND p.status = 'active' AND p.due_date IS NOT NULL
     AND p.total_cents > COALESCE((SELECT SUM(y.amount_cents) FROM payments y WHERE y.purchase_id = p.id AND y.status = 'valid'), 0)
  ) AS next_due_date,
  (SELECT MAX(y.paid_at) FROM payments y WHERE y.client_id = c.id AND y.status = 'valid') AS last_payment_at
FROM clients c`;

type SummaryRow = Omit<ClientSummary, "balance_cents" | "status">;

function finish(r: SummaryRow): ClientSummary {
  const balance = r.purchases_cents - r.paid_cents;
  return {
    ...r,
    balance_cents: balance,
    next_due_date: balance > 0 ? r.next_due_date : null,
    status: balance > 0 ? "pendiente" : balance < 0 ? "a_favor" : r.purchase_count === 0 ? "sin_compras" : "liquidada",
  };
}

export async function getClientSummary(db: D1Database, id: string): Promise<ClientSummary | null> {
  const r = await db.prepare(`${SUMMARY_SELECT} WHERE c.id = ?1`).bind(id).first<SummaryRow>();
  return r ? finish(r) : null;
}

export async function listClientSummaries(
  db: D1Database,
  opts: { q?: string; status?: string } = {},
): Promise<ClientSummary[]> {
  const q = (opts.q ?? "").trim().slice(0, 80);
  let rows: SummaryRow[];
  if (q) {
    const digits = q.replace(/\D/g, "");
    const like = "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
    const phoneLike = digits.length >= 3 ? "%" + digits + "%" : null;
    const res = await db
      .prepare(`${SUMMARY_SELECT} WHERE c.name LIKE ?1 ESCAPE '\\' OR (?2 IS NOT NULL AND c.phone LIKE ?2) ORDER BY c.name COLLATE NOCASE`)
      .bind(like, phoneLike)
      .all<SummaryRow>();
    rows = res.results;
  } else {
    const res = await db.prepare(`${SUMMARY_SELECT} ORDER BY c.name COLLATE NOCASE`).all<SummaryRow>();
    rows = res.results;
  }
  const list = rows.map(finish);
  if ((CLIENT_STATUSES as readonly string[]).includes(opts.status ?? "")) {
    return list.filter((c) => c.status === opts.status);
  }
  return list;
}

export interface PurchaseWithItems {
  id: string;
  purchase_date: string;
  due_date: string | null;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  paid_cents: number;
  notes: string;
  status: "active" | "cancelled";
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  items: {
    id: string;
    description: string;
    size: string;
    quantity: number;
    unit_price_cents: number;
    line_total_cents: number;
  }[];
}

export async function getPurchases(db: D1Database, clientId: string, onlyActive = false): Promise<PurchaseWithItems[]> {
  const [ps, items] = await db.batch([
    db
      .prepare(
        `SELECT p.id, p.purchase_date, p.due_date, p.subtotal_cents, p.discount_cents, p.total_cents, p.notes, p.status,
                p.cancelled_at, p.cancel_reason, p.created_at,
                COALESCE((SELECT SUM(y.amount_cents) FROM payments y WHERE y.purchase_id = p.id AND y.status = 'valid'), 0) AS paid_cents
         FROM purchases p WHERE p.client_id = ?1 ${onlyActive ? "AND p.status = 'active'" : ""}
         ORDER BY p.purchase_date DESC, p.created_at DESC`,
      )
      .bind(clientId),
    db
      .prepare(
        `SELECT i.id, i.purchase_id, i.description, i.size, i.quantity, i.unit_price_cents, i.line_total_cents
         FROM purchase_items i JOIN purchases p ON p.id = i.purchase_id
         WHERE p.client_id = ?1 ORDER BY i.purchase_id, i.position`,
      )
      .bind(clientId),
  ]);
  const byPurchase = new Map<string, PurchaseWithItems["items"]>();
  for (const it of items.results as (PurchaseWithItems["items"][number] & { purchase_id: string })[]) {
    const { purchase_id, ...rest } = it;
    if (!byPurchase.has(purchase_id)) byPurchase.set(purchase_id, []);
    byPurchase.get(purchase_id)!.push(rest);
  }
  return (ps.results as Omit<PurchaseWithItems, "items">[]).map((p) => ({ ...p, items: byPurchase.get(p.id) ?? [] }));
}

export interface PaymentRow {
  id: string;
  purchase_id: string | null;
  amount_cents: number;
  paid_at: string;
  method: string;
  note: string;
  status: "valid" | "voided";
  voided_at: string | null;
  void_reason: string | null;
  replaces_payment_id: string | null;
  created_at: string;
}

export async function getPayments(db: D1Database, clientId: string, onlyValid = false): Promise<PaymentRow[]> {
  const res = await db
    .prepare(
      `SELECT id, purchase_id, amount_cents, paid_at, method, note, status, voided_at, void_reason, replaces_payment_id, created_at
       FROM payments WHERE client_id = ?1 ${onlyValid ? "AND status = 'valid'" : ""}
       ORDER BY paid_at DESC, created_at DESC`,
    )
    .bind(clientId)
    .all<PaymentRow>();
  return res.results;
}

export function purchaseRemainingExpr(param: string): string {
  return `(COALESCE((SELECT total_cents FROM purchases WHERE id = ${param} AND status = 'active'), 0)
         - COALESCE((SELECT SUM(amount_cents) FROM payments WHERE purchase_id = ${param} AND status = 'valid'), 0))`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function audit(
  db: D1Database,
  a: { adminId: string | null; action: string; entityType: string; entityId: string | null; details?: unknown; ipHash?: string | null },
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO audit_log (admin_id, action, entity_type, entity_id, details, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(a.adminId, a.action, a.entityType, a.entityId, JSON.stringify(a.details ?? {}), a.ipHash ?? null);
}
