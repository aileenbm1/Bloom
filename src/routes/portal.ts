import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { TOKEN_PATTERN, safeEqual, sha256Hex } from "../lib/crypto";
import { getClientSummary, getPayments, getPurchases, nowIso } from "../lib/db";
import { PORTAL_COOKIE, hit, isLimited } from "../lib/http";

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
portal.get("/cuenta/:token", async (c) => {
  const db = c.env.DB;
  const ipKey = `portal:ip:${c.get("ipHash")}`;
  if (await isLimited(db, ipKey, MAX_FAILURES_PER_IP, WINDOW)) {
    return page(c, 429, "Demasiados intentos", "<p>Se detectaron demasiados intentos. Espera unos minutos e inténtalo de nuevo.</p>");
  }
  const token = c.req.param("token");
  const found = await resolveToken(db, token);
  if (!found) {
    await hit(db, ipKey, WINDOW);
    return invalidLink(c);
  }
  setCookie(c, PORTAL_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: COOKIE_MAX_AGE });
  return c.redirect("/cuenta", 303);
});

/** Paso 2: muestra el estado de cuenta. El token se vuelve a validar en cada visita (revocación inmediata). */
portal.get("/cuenta", async (c) => {
  const token = getCookie(c, PORTAL_COOKIE);
  if (!token) {
    return page(c, 401, "Abre tu enlace", "<p>Para consultar tu cuenta abre el enlace privado que te envió " + esc(c.env.BUSINESS_NAME) + ".</p>");
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
  const [client, purchases, payments] = await Promise.all([
    getClientSummary(db, found.clientId),
    getPurchases(db, found.clientId, true),
    getPayments(db, found.clientId, true),
  ]);
  if (!client) return invalidLink(c);
  return page(c, 200, "Estado de cuenta", renderAccount(c.env.BUSINESS_NAME, c.env.WHATSAPP_NUMBER, client, purchases, payments));
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

// Las clientas están en México: "hoy" se calcula en su hora local, no en UTC
// (a las 7 p. m. en CDMX ya es el día siguiente en UTC).
const localDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit" });
export const localToday = (now = new Date()) => localDayFmt.format(now);

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
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="stylesheet" href="/portal.css">
</head>
<body>
<header class="brand"><img class="logo" src="/logo-wordmark.png" alt="${brand}" width="102" height="56"></header>
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
  const payday = !settled && purchases.some((p) => p.status === "active" && p.due_date === today);

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

  <h2>Historial de abonos</h2>
  ${paymentRows}

  <h2>Compras y prendas</h2>
  ${purchaseRows}

  ${payday ? renderPaydayDialog(client.name, client.balance_cents, today) : ""}

  <p class="muted small">Consulta generada el ${esc(fmtDate(today))}. Este enlace es personal: no lo compartas.</p>
  <form method="post" action="/cuenta/salir" class="no-print"><button class="link" type="submit">Cerrar esta consulta</button></form>`;
}

/** Aviso emergente del día de pago. portal.js lo abre al cargar y reproduce el sonido. */
function renderPaydayDialog(name: string, balanceCents: number, today: string): string {
  const firstName = name.trim().split(/\s+/)[0] ?? "";
  return `
  <dialog class="payday no-print" id="aviso-pago" aria-labelledby="aviso-pago-titulo">
    <div class="sparkles" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <p class="payday-kicker">✨ ${esc(fmtDate(today))} ✨</p>
    <h2 id="aviso-pago-titulo">¡Hoy es tu día de pago${firstName ? `, ${esc(firstName)}` : ""}!</h2>
    <p>Tu saldo pendiente es de</p>
    <p class="payday-amount">${esc(fmtMoney(balanceCents))}</p>
    <p class="small">Gracias por estar al día. 💜</p>
    <form method="dialog"><button class="btn" type="submit" autofocus>Entendido</button></form>
  </dialog>`;
}
