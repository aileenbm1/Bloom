import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { DUMMY_HASH, b64url, hashPassword, randomBytes, safeEqual, sha256Hex, verifyPassword } from "../lib/crypto";
import { audit } from "../lib/db";
import { ADMIN_COOKIE, SESSION_TTL_MS, clearLimit, hit, isLimited, requireAdmin, sameOrigin } from "../lib/http";
import { ValidationError, obj, text } from "../lib/validate";

const WINDOW = 15 * 60 * 1000;
const MAX_PER_USER = 5;
const MAX_PER_IP = 20;

export const auth = new Hono<AppEnv>();

// --- Primer administrador desde el navegador ---------------------------------
// Solo funciona mientras no exista ningún administrador y exige como "código de
// configuración" el mismo valor de APP_SECRET guardado en Cloudflare.

async function adminCount(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM admins`).first<{ n: number }>();
  return row?.n ?? 0;
}

auth.get("/setup", async (c) => c.json({ needed: (await adminCount(c.env.DB)) === 0 }));

auth.post("/setup", async (c) => {
  if (!sameOrigin(c)) return c.json({ error: "Origen no permitido" }, 403);
  const db = c.env.DB;
  if ((await adminCount(db)) > 0) return c.json({ error: "Ya existe un administrador. Inicia sesión." }, 409);
  const ipKey = `setup:ip:${c.get("ipHash")}`;
  if (await isLimited(db, ipKey, MAX_PER_USER, WINDOW)) {
    return c.json({ error: "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo." }, 429);
  }
  const body = obj(await c.req.json().catch(() => null));
  const code = typeof body.setup_code === "string" ? body.setup_code.trim() : "";
  if (!safeEqual(code, c.env.APP_SECRET)) {
    await hit(db, ipKey, WINDOW);
    return c.json({ error: "El código de configuración no coincide con APP_SECRET." }, 403);
  }
  const username = text("username", body.username, { required: true, max: 40 }).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new ValidationError("username", "Usuario: 3 a 40 caracteres (letras, números, punto, guion o guion bajo)");
  }
  const displayName = text("display_name", body.display_name, { max: 80 }) || username;
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 12 || password.length > 200) throw new ValidationError("password", "La contraseña debe tener al menos 12 caracteres");

  const id = crypto.randomUUID();
  const [ins] = await db.batch([
    db
      .prepare(
        `INSERT INTO admins (id, username, display_name, password_hash, password_changed_at)
         SELECT ?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS (SELECT 1 FROM admins)`,
      )
      .bind(id, username, displayName, await hashPassword(password)),
    db
      .prepare(
        `INSERT INTO audit_log (admin_id, action, entity_type, entity_id, details, ip_hash)
         SELECT ?1, 'admin_creado_web', 'admin', ?1, '{}', ?2 WHERE EXISTS (SELECT 1 FROM admins WHERE id = ?1)`,
      )
      .bind(id, c.get("ipHash")),
  ]);
  if (!ins.meta.changes) return c.json({ error: "Ya existe un administrador. Inicia sesión." }, 409);
  await clearLimit(db, ipKey);
  return c.json({ ok: true, username }, 201);
});

auth.post("/login", async (c) => {
  if (!sameOrigin(c)) return c.json({ error: "Origen no permitido" }, 403);
  const body = obj(await c.req.json().catch(() => null));
  const username = text("username", body.username, { required: true, max: 60 }).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 1 || password.length > 200) throw new ValidationError("password", "Contraseña requerida");

  const ipKey = `login:ip:${c.get("ipHash")}`;
  const userKey = `login:user:${username}`;
  const db = c.env.DB;
  if ((await isLimited(db, ipKey, MAX_PER_IP, WINDOW)) || (await isLimited(db, userKey, MAX_PER_USER, WINDOW))) {
    return c.json({ error: "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo." }, 429);
  }

  const admin = await db
    .prepare(`SELECT id, username, display_name, password_hash FROM admins WHERE username = ?1 AND active = 1`)
    .bind(username)
    .first<{ id: string; username: string; display_name: string; password_hash: string }>();
  const ok = await verifyPassword(password, admin?.password_hash ?? DUMMY_HASH);
  if (!admin || !ok) {
    await hit(db, ipKey, WINDOW);
    await hit(db, userKey, WINDOW);
    await audit(db, { adminId: null, action: "login_fallido", entityType: "admin", entityId: null, details: { username }, ipHash: c.get("ipHash") }).run();
    return c.json({ error: "Usuario o contraseña incorrectos" }, 401);
  }
  await clearLimit(db, userKey);

  const sessionId = b64url(randomBytes(32));
  const csrf = b64url(randomBytes(32));
  const now = Date.now();
  await db.batch([
    db
      .prepare(`INSERT INTO admin_sessions (id_hash, admin_id, csrf_token, created_at, expires_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?4)`)
      .bind(await sha256Hex(sessionId), admin.id, csrf, now, now + SESSION_TTL_MS),
    audit(db, { adminId: admin.id, action: "login", entityType: "admin", entityId: admin.id, ipHash: c.get("ipHash") }),
  ]);
  setCookie(c, ADMIN_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return c.json({ admin: { username: admin.username, display_name: admin.display_name }, csrfToken: csrf });
});

auth.get("/session", requireAdmin, (c) => {
  const a = c.get("admin");
  return c.json({ admin: { username: a.username, display_name: a.display_name }, csrfToken: a.csrf_token });
});

auth.post("/logout", requireAdmin, async (c) => {
  const a = c.get("admin");
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM admin_sessions WHERE id_hash = ?1`).bind(a.session_hash),
    audit(c.env.DB, { adminId: a.id, action: "logout", entityType: "admin", entityId: a.id, ipHash: c.get("ipHash") }),
  ]);
  deleteCookie(c, ADMIN_COOKIE, { path: "/", secure: true });
  return c.json({ ok: true });
});

auth.post("/password", requireAdmin, async (c) => {
  const a = c.get("admin");
  const body = obj(await c.req.json().catch(() => null));
  const current = typeof body.current === "string" ? body.current : "";
  const next = typeof body.next === "string" ? body.next : "";
  if (next.length < 12 || next.length > 200) throw new ValidationError("next", "La nueva contraseña debe tener al menos 12 caracteres");
  const key = `pwchange:${a.id}`;
  if (await isLimited(c.env.DB, key, MAX_PER_USER, WINDOW)) return c.json({ error: "Demasiados intentos" }, 429);
  const row = await c.env.DB.prepare(`SELECT password_hash FROM admins WHERE id = ?1`).bind(a.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(current, row.password_hash))) {
    await hit(c.env.DB, key, WINDOW);
    return c.json({ error: "La contraseña actual no es correcta" }, 400);
  }
  // Conserva el número de iteraciones elegido al crear la cuenta (ver scripts/create-admin.mjs).
  const iterations = Number(row.password_hash.split("$")[1]) || undefined;
  const hash = await hashPassword(next, iterations);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE admins SET password_hash = ?1, password_changed_at = ?2 WHERE id = ?3`).bind(hash, new Date().toISOString(), a.id),
    // Cierra las demás sesiones abiertas.
    c.env.DB.prepare(`DELETE FROM admin_sessions WHERE admin_id = ?1 AND id_hash <> ?2`).bind(a.id, a.session_hash),
    audit(c.env.DB, { adminId: a.id, action: "cambio_contrasena", entityType: "admin", entityId: a.id, ipHash: c.get("ipHash") }),
  ]);
  return c.json({ ok: true });
});
