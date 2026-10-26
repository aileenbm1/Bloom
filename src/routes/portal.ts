import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { TOKEN_PATTERN, safeEqual, sha256Hex } from "../lib/crypto";
import { getClientSummary, getPayments, getPurchases, nowIso } from "../lib/db";
import { PORTAL_COOKIE, hit, isLimited, sameOrigin } from "../lib/http";
import { MAX_DEVICES_PER_LINK, ensurePushSchema, getVapid, localToday, parseSubscription } from "../lib/push";
import { HttpError, ValidationError } from "../lib/validate";

export { localToday };

const WINDOW = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 20;
const COOKIE_MAX_AGE = 60 * 60; // 1 h

export const portal = new Hono<AppEnv>();

async function resolveToken(db: D1Database, token: string): Promise<{ tokenId: string; clientId: string } | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const hash = await sha256Hex(token);
  const row = await db
    .prepare(`SELECT id, client_id, token_hash FROM access_tokens WHERE token_hash = ?1 AND revoked_at IS NULL`)
    .bind(hash)
    .first<{ id: string; client_id: string; token_hash: string }>();
  if (!row || !safeEqual(row.token_hash, hash)) return null;
  return { tokenId: row.id, clientId: row.client_id };
}

/**
 * Paso 1: el cliente abre /cuenta/TOKEN. Se valida el token, se guarda en una cookie
 * HttpOnly (nunca en localStorage) y se redirige a /cuenta para quitarlo de la barra de
 * direcciones, del historial y de cualquier encabezado Referer.
 */
portal.get("/cuenta/:token", (c) => enter(c, c.req.param("token")));

/**
 * Lo mismo, pegando el enlace en un formulario. Hace falta en iPhone: la app instalada en la
 * pantalla de inicio no comparte cookies con Safari y no tiene barra de direcciones.
 */
portal.post("/cuenta/entrar", async (c) => {
  if (!sameOrigin(c)) return page(c, 403, "Origen no permitido", "<p>Abre tu enlace de nuevo.</p>");
  const form = await c.req.parseBody();
  const text = typeof form.enlace === "string" ? form.enlace.trim().slice(0, 300) : "";
  const m = text.match(/\/cuenta\/([A-Za-z0-9_-]{43})(?:[/?#]|$)/) ?? text.match(/^([A-Za-z0-9_-]{43})$/);
  return enter(c, m ? m[1] : "");
});

async function enter(c: Context<AppEnv>, token: string) {
  const db = c.env.DB;
  const ipKey = `portal:ip:${c.get("ipHash")}`;
  if (await isLimited(db, ipKey, MAX_FAILURES_PER_IP, WINDOW)) {
    return page(c, 429, "Demasiados intentos", "<p>Se detectaron demasiados intentos. Espera unos minutos e inténtalo de nuevo.</p>");
  }
  const found = await resolveToken(db, token);
  if (!found) {
    await hit(db, ipKey, WINDOW);
    return invalidLink(c);
  }
  setCookie(c, PORTAL_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: COOKIE_MAX_AGE });
  return c.redirect("/cuenta", 303);
}

/** Paso 2: muestra el estado de cuenta. El token se vuelve a validar en cada visita (revocación inmediata). */
portal.get("/cuenta", async (c) => {
  const token = getCookie(c, PORTAL_COOKIE);
  if (!token) {
    return page(
      c,
      401,
      "Abre tu enlace",
      `<p>Para consultar tu cuenta abre el enlace privado que te envió ${esc(c.env.BUSINESS_NAME)}.</p>
      <form method="post" action="/cuenta/entrar" class="paste">
        <label for="enlace">¿Estás en la app? Pega aquí tu enlace:</label>
        <input id="enlace" name="enlace" type="url" inputmode="url" autocomplete="off" required placeholder="https://…/cuenta/…">
        <button class="btn" type="submit">Ver mi cuenta</button>
      </form>`,
    );
  }
  const db = c.env.DB;
  const found = await resolveToken(db, token);
  if (!found) {
    deleteCookie(c, PORTAL_COOKIE, { path: "/", secure: true });
    return invalidLink(c);
  }
  c.executionCtx.waitUntil(
    db.prepare(`UPDATE access_tokens SET last_used_at = ?1 WHERE id = ?2`).bind(nowIso(), found.tokenId).run(),
  );
  const [client, purchases, payments, vapid] = await Promise.all([
    getClientSummary(db, found.clientId),
    getPurchases(db, found.clientId, true),
    getPayments(db, found.clientId, true),
    getVapid(db),
  ]);
  if (!client) return invalidLink(c);
  return page(c, 200, "Estado de cuenta", renderAccount(c.env.BUSINESS_NAME, c.env.WHATSAPP_NUMBER, client, purchases, payments, vapid.publicKey));
});

// --- Avisos push (la clienta los activa con su permiso) ---------------------------

async function portalSession(c: Context<AppEnv>) {
  if (!sameOrigin(c)) throw new HttpError(400, "Origen no permitido");
  await ensurePushSchema(c.env.DB);
  const token = getCookie(c, PORTAL_COOKIE);
  return token ? resolveToken(c.env.DB, token) : null;
}

portal.post("/cuenta/avisos", async (c) => {
  const found = await portalSession(c);
  if (!found) return c.json({ error: "Abre tu enlace de nuevo" }, 401);
  const sub = parseSubscription(await c.req.json().catch(() => null));
  if (!sub) throw new ValidationError("endpoint", "Suscripción no válida");
  const db = c.env.DB;
  const others = await db
    .prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE token_id = ?1 AND endpoint <> ?2`)
    .bind(found.tokenId, sub.endpoint)
    .first<{ n: number }>();
  if ((others?.n ?? 0) >= MAX_DEVICES_PER_LINK) throw new HttpError(409, "Ya hay demasiados dispositivos con avisos activos");
  await db
    .prepare(
      `INSERT INTO push_subscriptions (id, client_id, token_id, endpoint, p256dh, auth) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(endpoint) DO UPDATE SET client_id = excluded.client_id, token_id = excluded.token_id,
         p256dh = excluded.p256dh, auth = excluded.auth, payday_sent_on = NULL, reminder_sent_at = NULL`,
    )
    .bind(crypto.randomUUID(), found.clientId, found.tokenId, sub.endpoint, sub.p256dh, sub.auth)
    .run();
  return c.json({ ok: true }, 201);
});

portal.post("/cuenta/avisos/baja", async (c) => {
  const found = await portalSession(c);
  if (!found) return c.json({ error: "Abre tu enlace de nuevo" }, 401);
  const b = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (typeof b?.endpoint !== "string") throw new ValidationError("endpoint", "Falta el dispositivo");
  await c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?1 AND client_id = ?2`).bind(b.endpoint, found.clientId).run();
  return c.json({ ok: true });
});

portal.post("/cuenta/salir", (c) => {
  deleteCookie(c, PORTAL_COOKIE, { path: "/", secure: true });
  return c.redirect("/cuenta", 303);
});

function invalidLink(c: Context<AppEnv>) {
  return page(
    c,
    404,
    "Enlace no válido",
    `<p>Este enlace no es válido o fue revocado.</p><p>Si necesitas consultar tu cuenta, pide a ${esc(c.env.BUSINESS_NAME)} un enlace nuevo.</p>`,
  );
}

// --- Plantillas ----------------------------------------------------------------

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const mxn = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
export const fmtMoney = (cents: number) => mxn.format(cents / 100);
const dateFmt = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const fmtDate = (d: string | null) => (d ? dateFmt.format(new Date(d.slice(0, 10) + "T00:00:00Z")) : "");

const METHOD: Record<string, string> = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  tarjeta: "Tarjeta",
  deposito: "Depósito",
  otro: "Otro",
};

function page(c: Context<AppEnv>, status: number, title: string, content: string) {
  const brand = esc(c.env.BUSINESS_NAME || "BLOOM");
  const html = `<!doctype html>
<html lang="es-MX">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · ${brand}</title>
<meta name="theme-color" content="#6a2f8f">
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="manifest" href="/portal.webmanifest">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png?v=2">
<link rel="stylesheet" href="/portal.css">
<script src="/tema.js"></script>
</head>
<body>
<header class="brand"><img class="logo" src="/logo-wordmark.png" alt="${brand}" width="102" height="56"><button type="button" class="theme-toggle no-print" data-action="tema" aria-label="Cambiar tema">🌙</button></header>
<main class="wrap">${content}</main>
<script src="/portal.js"></script>
</body>
</html>`;
  return c.html(html, status as 200);
}

function renderAccount(
  business: string,
  whatsapp: string,
  client: NonNullable<Awaited<ReturnType<typeof getClientSummary>>>,
  purchases: Awaited<ReturnType<typeof getPurchases>>,
  payments: Awaited<ReturnType<typeof getPayments>>,
  vapidKey: string,
): string {
  const settled = client.balance_cents <= 0;
  const credit = client.balance_cents < 0;
  const statusLabel = credit ? "Saldo a favor" : settled ? "Al corriente" : "Pendiente";
  const today = localToday();
  const wa = /^\d{10,15}$/.test(whatsapp)
    ? `<a class="btn wa" href="https://wa.me/${whatsapp}?text=${encodeURIComponent(`Hola ${business}, soy ${client.name}. Tengo una pregunta sobre mi cuenta.`)}" target="_blank" rel="noopener noreferrer">Contactar por WhatsApp</a>`
    : "";

  const purchaseRows = purchases.length
    ? purchases
        .map(
          (p) => `
      <article class="card purchase">
        <div class="row"><strong>Compra del ${esc(fmtDate(p.purchase_date))}</strong><span>${esc(fmtMoney(p.total_cents))}</span></div>
        ${p.due_date ? `<div class="muted">Fecha límite: ${esc(fmtDate(p.due_date))}</div>` : ""}
        <table class="items"><thead><tr><th>Prenda</th><th>Cant.</th><th class="num">Importe</th></tr></thead><tbody>
        ${p.items
          .map(
            (i) =>
              `<tr><td>${esc(i.description)}${i.size ? ` <span class="muted">(${esc(i.size)})</span>` : ""}</td><td>${i.quantity}</td><td class="num">${esc(fmtMoney(i.line_total_cents))}</td></tr>`,
          )
          .join("")}
        </tbody>
        ${p.discount_cents > 0 ? `<tfoot><tr><td colspan="2">Descuento</td><td class="num">−${esc(fmtMoney(p.discount_cents))}</td></tr></tfoot>` : ""}
        </table>
      </article>`,
        )
        .join("")
    : `<p class="muted">Sin compras registradas.</p>`;

  const paymentRows = payments.length
    ? `<table class="list"><thead><tr><th>Fecha</th><th>Método</th><th class="num">Importe</th></tr></thead><tbody>${payments
        .map((y) => `<tr><td>${esc(fmtDate(y.paid_at))}</td><td>${esc(METHOD[y.method] ?? y.method)}</td><td class="num">${esc(fmtMoney(y.amount_cents))}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">Aún no hay abonos registrados.</p>`;

  const overdue = client.next_due_date && client.next_due_date < today;
  // Día de pago: alguna compra activa vence hoy y todavía hay saldo pendiente.


  return `
  <section class="hero">
    <p class="muted">Estado de cuenta de</p>
    <h1>${esc(client.name)}</h1>
    <span class="badge ${settled ? "ok" : "pending"}">${statusLabel}</span>
  </section>

  <section class="totals">
    <div class="tile"><span>Total de compras</span><strong>${esc(fmtMoney(client.purchases_cents))}</strong></div>
    <div class="tile"><span>Total abonado</span><strong>${esc(fmtMoney(client.paid_cents))}</strong></div>
    ${
      credit
        ? `<div class="tile main credit"><span>Saldo a tu favor</span><strong>${esc(fmtMoney(-client.balance_cents))}</strong><small>Se descontará de tu próxima compra.</small></div>`
        : `<div class="tile main"><span>Saldo pendiente</span><strong>${esc(fmtMoney(client.balance_cents))}</strong></div>`
    }
    ${client.next_due_date ? `<div class="tile ${overdue ? "late" : ""}"><span>Fecha límite</span><strong>${esc(fmtDate(client.next_due_date))}</strong></div>` : ""}
  </section>

  <div class="actions no-print">
    <button type="button" class="btn" data-action="print">Descargar o imprimir estado de cuenta</button>
    ${wa}
  </div>

  <section class="avisos no-print" id="avisos" data-key="${esc(vapidKey)}" hidden>
    <h2>Avisos en tu celular</h2>
    <p class="muted small" data-avisos-msg>Te avisamos con una notificación el día de tu pago.</p>
    <button type="button" class="btn soft" data-action="avisos-on">🔔 Avisarme mi día de pago</button>
    <button type="button" class="link" data-action="avisos-off" hidden>Desactivar avisos</button>
  </section>

  <h2>Historial de abonos</h2>
  ${paymentRows}

  <h2>Compras y prendas</h2>
  ${purchaseRows}

  ${renderPaymentNotice(business, whatsapp, client, today)}

  <p class="muted small">Consulta generada el ${esc(fmtDate(today))}. Este enlace es personal: no lo compartas.</p>
  <form method="post" action="/cuenta/salir" class="no-print"><button class="link" type="submit">Cerrar esta consulta</button></form>`;
}

/** Días que faltan para el día de pago: 0 es hoy y un número negativo, que ya pasó. */
export function daysUntil(dueDate: string, today: string): number {
  return Math.round((Date.parse(dueDate.slice(0, 10) + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86_400_000);
}

/** Con cuántos días de anticipación se avisa al cliente de su día de pago. */
export const NOTICE_DAYS_BEFORE = 3;

/**
 * Aviso emergente de día de pago (igual que en BloomMultitienda, con los colores de BLOOM):
 * aparece al abrir el estado de cuenta si hay saldo pendiente y la fecha límite más próxima
 * es hoy, ya pasó o llega en los próximos NOTICE_DAYS_BEFORE días. portal.js lo abre y suena.
 */
function renderPaymentNotice(
  business: string,
  whatsapp: string,
  client: NonNullable<Awaited<ReturnType<typeof getClientSummary>>>,
  today: string,
): string {
  if (!client.next_due_date || client.balance_cents <= 0) return "";
  const days = daysUntil(client.next_due_date, today);
  if (days > NOTICE_DAYS_BEFORE) return "";
  const date = esc(fmtDate(client.next_due_date));
  const title = days < 0 ? "Tu pago está vencido" : days === 0 ? "¡Hoy es tu día de pago!" : "Tu día de pago se acerca";
  const when =
    days < 0
      ? `Tu fecha límite fue el ${date}.`
      : days === 0
        ? `Tu fecha límite es hoy, ${date}.`
        : `Tu fecha límite es el ${date} (${days === 1 ? "mañana" : `en ${days} días`}).`;
  const wa = /^\d{10,15}$/.test(whatsapp)
    ? `<a class="btn notice-wa" href="https://wa.me/${whatsapp}?text=${encodeURIComponent(`Hola ${business}, soy ${client.name}. Quiero hacer mi pago.`)}" target="_blank" rel="noopener noreferrer">Avisar a la tienda por WhatsApp</a>`
    : "";
  return `
  <dialog class="payday no-print" id="aviso-pago" aria-labelledby="aviso-pago-titulo">
    <div class="sparkles" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <form method="dialog">
      <img class="payday-logo" src="/logo.png" alt="BLOOM · A tu manera" width="200" height="112">
      <p class="payday-kicker">✦ Aviso de pago ✦</p>
      <h2 id="aviso-pago-titulo">${title}</h2>
      <p>${when}</p>
      <p class="notice-amount"><span>Saldo pendiente</span><strong>${esc(fmtMoney(client.balance_cents))}</strong></p>
      <div class="notice-actions">
        ${wa}
        <button class="btn" value="ok" autofocus>Entendido</button>
      </div>
    </form>
  </dialog>`;
}
