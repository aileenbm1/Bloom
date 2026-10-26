// Notificaciones push (Web Push) sin dependencias: VAPID (RFC 8292) y cifrado aes128gcm (RFC 8291)
// con WebCrypto. Las claves VAPID se generan solas la primera vez y se guardan en D1, igual que APP_SECRET.

import type { Env } from "../env";
import { b64url, fromB64url } from "./crypto";

const enc = new TextEncoder();

// Las clientas están en México: "hoy" se calcula en su hora local, no en UTC
// (a las 7 p. m. en CDMX ya es el día siguiente en UTC).
const localDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit" });
export const localToday = (now = new Date()) => localDayFmt.format(now);

// Solo se envían avisos a los servicios push de los navegadores (evita que el servidor
// haga peticiones a direcciones arbitrarias).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9.-]+\.notify\.windows\.com$/];
/** Debe coincidir con wrangler.jsonc. Vive aquí: el módulo principal del Worker solo puede exportar handlers. */
export const PAYDAY_CRON = "0 15-18 * * *";
export const MAX_DEVICES_PER_LINK = 5;
/** Cloudflare (plan gratuito) permite 50 peticiones externas por ejecución; se deja margen. */
export const MAX_SENDS_PER_RUN = 40;
/** El recordatorio general del panel no se repite a la misma clienta en este lapso. */
export const REMINDER_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Valida la suscripción que manda el navegador. Devuelve null si no es aceptable. */
export function parseSubscription(b: unknown): PushSubscriptionInput | null {
  if (!b || typeof b !== "object") return null;
  const o = b as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof o.endpoint !== "string" || o.endpoint.length > 1024) return null;
  let url: URL;
  try {
    url = new URL(o.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || !PUSH_HOSTS.some((r) => r.test(url.hostname))) return null;
  const p256dh = o.keys?.p256dh;
  const auth = o.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string" || !/^[A-Za-z0-9_-]+=*$/.test(p256dh) || !/^[A-Za-z0-9_-]+=*$/.test(auth)) return null;
  try {
    const pk = fromB64url(p256dh.replace(/=+$/, ""));
    const au = fromB64url(auth.replace(/=+$/, ""));
    if (pk.length !== 65 || pk[0] !== 4 || au.length !== 16) return null;
  } catch {
    return null;
  }
  return { endpoint: o.endpoint, p256dh: p256dh.replace(/=+$/, ""), auth: auth.replace(/=+$/, "") };
}

// --- Esquema ---------------------------------------------------------------------

let schemaReady: Promise<void> | null = null;

/**
 * Crea la tabla de suscripciones si el despliegue todavía no aplicó la migración 0002
 * (por ejemplo, si el comando de despliegue de Cloudflare no ejecuta las migraciones).
 * Así revocar enlaces o abrir una ficha nunca falla por la tabla faltante.
 */
export function ensurePushSchema(db: D1Database): Promise<void> {
  schemaReady ??= db
    .batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        token_id TEXT NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE CHECK (length(endpoint) <= 1024),
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        payday_sent_on TEXT,
        reminder_sent_at INTEGER)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_push_client ON push_subscriptions(client_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_push_token ON push_subscriptions(token_id)`),
    ])
    .then(
      () => undefined,
      (e) => {
        schemaReady = null;
        throw e;
      },
    );
  return schemaReady;
}

// --- Claves VAPID ------------------------------------------------------------------

interface Vapid {
  publicKey: string; // punto P-256 sin comprimir, base64url (lo usa el navegador)
  privateKey: CryptoKey;
}

let vapidCache: Promise<Vapid> | null = null;

export function getVapid(db: D1Database): Promise<Vapid> {
  vapidCache ??= loadOrCreateVapid(db).catch((e) => {
    vapidCache = null;
    throw e;
  });
  return vapidCache;
}

async function loadOrCreateVapid(db: D1Database): Promise<Vapid> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).run();
  let row = await db.prepare(`SELECT value FROM app_config WHERE key = 'vapid_jwk'`).first<{ value: string }>();
  if (!row) {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    await db.prepare(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('vapid_jwk', ?1)`).bind(JSON.stringify(jwk)).run();
    row = await db.prepare(`SELECT value FROM app_config WHERE key = 'vapid_jwk'`).first<{ value: string }>();
    if (!row) throw new Error("No se pudieron crear las claves VAPID");
  }
  const jwk = JSON.parse(row.value) as JsonWebKey;
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(fromB64url(jwk.x!), 1);
  raw.set(fromB64url(jwk.y!), 33);
  return { publicKey: b64url(raw), privateKey };
}

async function vapidAuthorization(v: Vapid, endpoint: string, subject: string): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(
    enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })),
  );
  const unsigned = `${header}.${claims}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.privateKey, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${v.publicKey}`;
}

// --- Cifrado del contenido (RFC 8291, aes128gcm) --------------------------------------

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};

export async function encryptPayload(p256dh: string, auth: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  const as = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", as.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, as.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// --- Envío -------------------------------------------------------------------------

/** Lo que aparece en la pantalla de bloqueo. Sin montos ni datos personales. */
export interface PushMessage {
  title: string;
  body: string;
  tag: string;
}

export function paydayMessage(business: string): PushMessage {
  return { title: "✨ Hoy es tu día de pago", body: `Toca para ver tu estado de cuenta en ${business}.`, tag: "dia-de-pago" };
}

export function reminderMessage(business: string): PushMessage {
  return { title: "💜 Recordatorio de pago", body: `Tienes un saldo pendiente con ${business}. Toca para ver tu estado de cuenta.`, tag: "recordatorio" };
}

type SubRow = { id: string; endpoint: string; p256dh: string; auth: string };
export type SendResult = "sent" | "gone" | "failed";

export async function sendPush(env: Env, sub: SubRow, msg: PushMessage, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const v = await getVapid(env.DB);
  const subject = env.PUSH_CONTACT && /^(mailto:|https:)/.test(env.PUSH_CONTACT) ? env.PUSH_CONTACT : "mailto:avisos@bloom.invalid";
  try {
    const body = await encryptPayload(sub.p256dh, sub.auth, enc.encode(JSON.stringify(msg)));
    const res = await fetchImpl(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(v, sub.endpoint, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(12 * 3600),
        Urgency: "normal",
        Topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, ""),
      },
      body,
    });
    if (res.status === 404 || res.status === 410) {
      await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id = ?1`).bind(sub.id).run();
      return "gone";
    }
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

// Suscripciones vigentes: el enlace con el que se activaron sigue sin revocar.
const ACTIVE_SUBS = `
SELECT s.id, s.endpoint, s.p256dh, s.auth, s.client_id FROM push_subscriptions s
JOIN access_tokens t ON t.id = s.token_id AND t.revoked_at IS NULL`;

// Saldo pendiente calculado igual que en db.ts (compras activas − abonos válidos).
const HAS_BALANCE = `
  COALESCE((SELECT SUM(p.total_cents) FROM purchases p WHERE p.client_id = s.client_id AND p.status = 'active'), 0)
  - COALESCE((SELECT SUM(y.amount_cents) FROM payments y WHERE y.client_id = s.client_id AND y.status = 'valid'), 0) > 0`;

/**
 * Aviso automático: a cada clienta con avisos activos, saldo pendiente y una compra que vence hoy.
 * Se puede ejecutar varias veces al día: cada dispositivo lo recibe una sola vez.
 */
export async function sendPaydayPushes(env: Env, now = new Date(), fetchImpl: typeof fetch = fetch) {
  await ensurePushSchema(env.DB);
  const today = localToday(now);
  const { results } = await env.DB.prepare(
    `${ACTIVE_SUBS}
     WHERE (s.payday_sent_on IS NULL OR s.payday_sent_on <> ?1)
       AND EXISTS (SELECT 1 FROM purchases p WHERE p.client_id = s.client_id AND p.status = 'active' AND p.due_date = ?1)
       AND ${HAS_BALANCE}
     LIMIT ?2`,
  )
    .bind(today, MAX_SENDS_PER_RUN)
    .all<SubRow>();
  const msg = paydayMessage(env.BUSINESS_NAME || "BLOOM");
  let sent = 0;
  for (const sub of results) {
    const r = await sendPush(env, sub, msg, fetchImpl);
    if (r === "sent") sent++;
    // Se marca aunque falle, para no reintentar en bucle el mismo día.
    if (r !== "gone") await env.DB.prepare(`UPDATE push_subscriptions SET payday_sent_on = ?1 WHERE id = ?2`).bind(today, sub.id).run();
  }
  return { devices: results.length, sent };
}

/**
 * Recordatorio desde el panel: a una clienta o a todas las que tienen avisos activos y saldo pendiente.
 * El envío general omite a quien ya recibió uno en las últimas 12 horas.
 */
export async function sendReminders(env: Env, clientId: string | null, fetchImpl: typeof fetch = fetch) {
  const now = Date.now();
  const where = clientId
    ? `WHERE s.client_id = ?1 AND ${HAS_BALANCE}`
    : `WHERE (s.reminder_sent_at IS NULL OR s.reminder_sent_at < ?1) AND ${HAS_BALANCE}`;
  const { results } = await env.DB.prepare(`${ACTIVE_SUBS} ${where} LIMIT ?2`)
    .bind(clientId ?? now - REMINDER_COOLDOWN_MS, MAX_SENDS_PER_RUN)
    .all<SubRow & { client_id: string }>();
  const msg = reminderMessage(env.BUSINESS_NAME || "BLOOM");
  const reached = new Set<string>();
  let sent = 0;
  let failed = 0;
  for (const sub of results) {
    const r = await sendPush(env, sub, msg, fetchImpl);
    if (r === "sent") {
      sent++;
      reached.add(sub.client_id);
    } else if (r === "failed") failed++;
    if (r !== "gone") await env.DB.prepare(`UPDATE push_subscriptions SET reminder_sent_at = ?1 WHERE id = ?2`).bind(now, sub.id).run();
  }
  const pending = clientId
    ? 0
    : ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM (${ACTIVE_SUBS} WHERE (s.reminder_sent_at IS NULL OR s.reminder_sent_at < ?1) AND ${HAS_BALANCE})`)
        .bind(now - REMINDER_COOLDOWN_MS)
        .first<{ n: number }>())?.n ?? 0);
  return { clients: reached.size, devices: results.length, sent, failed, pending };
}

/** Cuántas clientas tienen avisos activos (en total y con saldo pendiente). */
export async function pushStats(db: D1Database, clientId?: string) {
  const filter = clientId ? `WHERE s.client_id = ?1` : "";
  const q = db.prepare(
    `SELECT COUNT(DISTINCT s.client_id) AS clients,
            COUNT(DISTINCT CASE WHEN ${HAS_BALANCE} THEN s.client_id END) AS with_balance,
            COUNT(*) AS devices
     FROM (${ACTIVE_SUBS}) s ${filter}`,
  );
  const row = await (clientId ? q.bind(clientId) : q).first<{ clients: number; with_balance: number; devices: number }>();
  return row ?? { clients: 0, with_balance: 0, devices: 0 };
}

/** Borra las suscripciones de los enlaces activos de una clienta (antes de revocarlos). */
export function dropClientPush(db: D1Database, clientId: string): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM push_subscriptions WHERE token_id IN (SELECT id FROM access_tokens WHERE client_id = ?1 AND revoked_at IS NULL)`)
    .bind(clientId);
}
