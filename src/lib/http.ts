import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { hashIp, safeEqual, sha256Hex } from "./crypto";

export const ADMIN_COOKIE = "__Host-bloom_admin";
export const PORTAL_COOKIE = "__Host-bloom_cuenta";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 h absolutas
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // 2 h de inactividad

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

/** Encabezados de seguridad para todas las respuestas (API, panel, portal y archivos). */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();

  // Algunas respuestas (ASSETS, redirecciones) tienen encabezados inmutables: se copian.
  c.res = new Response(c.res.body, c.res);
  const hh = c.res.headers;
  hh.set("X-Content-Type-Options", "nosniff");
  hh.set("Content-Security-Policy", CSP);
  hh.set("Referrer-Policy", "no-referrer");
  hh.set("X-Frame-Options", "DENY");
  hh.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  hh.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
  hh.set("Cross-Origin-Opener-Policy", "same-origin");
  hh.set("Cross-Origin-Resource-Policy", "same-origin");
  hh.set("Strict-Transport-Security", "max-age=31536000");
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/") || path.startsWith("/cuenta") || path.startsWith("/admin") || path === "/") {
    hh.set("Cache-Control", "no-store");
  }
};

export function clientIp(c: Context<AppEnv>): string {
  return c.req.header("CF-Connecting-IP") ?? "local";
}

export const withIpHash: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("ipHash", await hashIp(c.env.APP_SECRET, clientIp(c)));
  await next();
};

/**
 * Exige que APP_SECRET exista y tenga longitud suficiente. Si falta, responde 503 con
 * instrucciones (sin revelar ningún valor) en lugar de un error 500 genérico.
 */
export const requireSecret: MiddlewareHandler<AppEnv> = async (c, next) => {
  const s = c.env.APP_SECRET;
  if (typeof s === "string" && s.length >= 32) return next();
  const local = ["localhost", "127.0.0.1"].includes(new URL(c.req.url).hostname);
  const fix = local
    ? "Falta APP_SECRET en el entorno local. Detén el servidor y ejecuta: npm run setup:local  (o simplemente npm run dev, que lo hace automáticamente)."
    : "Falta el secreto APP_SECRET. En Cloudflare abre este Worker → Settings → Build y pon como Deploy command: npm run deploy. El siguiente despliegue lo crea automáticamente.";
  console.error(JSON.stringify({ level: "error", message: "APP_SECRET ausente o demasiado corto" }));
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    return c.json({ error: "Configuración incompleta del servidor. " + fix }, 503);
  }
  return c.html(
    `<!doctype html><html lang="es-MX"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>BLOOM · Configuración pendiente</title><link rel="stylesheet" href="/portal.css"></head><body><header class="brand"><span class="logo">BLOOM</span></header><main class="wrap"><h1>Configuración pendiente</h1><p>${fix}</p></main></body></html>`,
    503,
  );
};

// --- Limitación de intentos (ventana fija, almacenada en D1) -----------------

export async function isLimited(db: D1Database, key: string, max: number, windowMs: number): Promise<boolean> {
  const cutoff = Date.now() - windowMs;
  const row = await db
    .prepare(`SELECT count FROM rate_limits WHERE key = ?1 AND window_start >= ?2`)
    .bind(key, cutoff)
    .first<{ count: number }>();
  return (row?.count ?? 0) >= max;
}

export async function hit(db: D1Database, key: string, windowMs: number): Promise<number> {
  const now = Date.now();
  const cutoff = now - windowMs;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start < ?3 THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN rate_limits.window_start < ?3 THEN ?2 ELSE rate_limits.window_start END
       RETURNING count`,
    )
    .bind(key, now, cutoff)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

export async function clearLimit(db: D1Database, key: string): Promise<void> {
  await db.prepare(`DELETE FROM rate_limits WHERE key = ?1`).bind(key).run();
}

// --- Sesión administrativa ---------------------------------------------------

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const raw = getCookie(c, ADMIN_COOKIE);
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return c.json({ error: "No autenticado" }, 401);
  const idHash = await sha256Hex(raw);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT s.id_hash, s.csrf_token, s.expires_at, s.last_seen_at, a.id, a.username, a.display_name
     FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.id_hash = ?1 AND a.active = 1`,
  )
    .bind(idHash)
    .first<{ id_hash: string; csrf_token: string; expires_at: number; last_seen_at: number; id: string; username: string; display_name: string }>();
  if (!row || row.expires_at < now || row.last_seen_at + SESSION_IDLE_MS < now) {
    if (row) await c.env.DB.prepare(`DELETE FROM admin_sessions WHERE id_hash = ?1`).bind(idHash).run();
    return c.json({ error: "Sesión vencida" }, 401);
  }
  // Autorización + CSRF en métodos que modifican datos.
  if (!["GET", "HEAD"].includes(c.req.method)) {
    if (!sameOrigin(c)) return c.json({ error: "Origen no permitido" }, 403);
    const sent = c.req.header("X-CSRF-Token") ?? "";
    if (!safeEqual(sent, row.csrf_token)) return c.json({ error: "Token CSRF inválido" }, 403);
  }
  if (now - row.last_seen_at > 60_000) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare(`UPDATE admin_sessions SET last_seen_at = ?1 WHERE id_hash = ?2`).bind(now, idHash).run(),
    );
  }
  c.set("admin", { id: row.id, username: row.username, display_name: row.display_name, csrf_token: row.csrf_token, session_hash: idHash });
  await next();
};

export function sameOrigin(c: Context<AppEnv>): boolean {
  const url = new URL(c.req.url);
  const allowed = [url.origin];
  // Solo en desarrollo local: GitHub Codespaces reenvía el puerto 8787 desde
  // https://<nombre>-8787.app.github.dev e indica el host original en X-Forwarded-Host.
  const fwd = c.req.header("X-Forwarded-Host");
  if (fwd && (url.hostname === "localhost" || url.hostname === "127.0.0.1") && /^[a-z0-9.-]+(:\d+)?$/i.test(fwd)) {
    allowed.push(`https://${fwd}`);
  }
  if (url.hostname.endsWith(".app.github.dev")) allowed.push(`https://${url.host}`);
  const origin = c.req.header("Origin");
  if (origin) return allowed.includes(origin);
  // Sin Origin: se acepta solo si el navegador declara misma procedencia.
  return c.req.header("Sec-Fetch-Site") === "same-origin";
}
