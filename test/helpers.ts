import { SELF, env } from "cloudflare:test";
import { hashPassword } from "../src/lib/crypto";

export const BASE = "https://bloom.test";
export const PASSWORD = "contraseña-de-prueba-123";

export function cookieFrom(res: Response, name: string): string | null {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const [k, ...v] = pair.split("=");
    if (k.trim() === name) return v.join("=");
  }
  return null;
}

export async function ensureAdmin(username = "admin"): Promise<void> {
  const exists = await env.DB.prepare(`SELECT 1 FROM admins WHERE username = ?1`).bind(username).first();
  if (exists) return;
  await env.DB.prepare(`INSERT INTO admins (id, username, display_name, password_hash) VALUES (?1, ?2, ?3, ?4)`)
    .bind(crypto.randomUUID(), username, "Admin " + username, await hashPassword(PASSWORD))
    .run();
}

export interface Session {
  cookie: string;
  csrf: string;
  get(path: string): Promise<Response>;
  json<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }>;
}

export function rawLogin(username: string, password: string, ip = "203.0.113.10") {
  return SELF.fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip },
    body: JSON.stringify({ username, password }),
  });
}

export async function login(username = "admin"): Promise<Session> {
  await ensureAdmin(username);
  const res = await rawLogin(username, PASSWORD);
  if (res.status !== 200) throw new Error("login falló: " + res.status + " " + (await res.text()));
  const data = (await res.json()) as { csrfToken: string };
  const cookie = cookieFrom(res, "__Host-bloom_admin")!;
  const headers = (extra: Record<string, string> = {}) => ({
    Cookie: `__Host-bloom_admin=${cookie}`,
    Origin: BASE,
    "X-CSRF-Token": data.csrfToken,
    ...extra,
  });
  return {
    cookie,
    csrf: data.csrfToken,
    get: (path) => SELF.fetch(BASE + path, { headers: headers() }),
    async json(method, path, body) {
      const res = await SELF.fetch(BASE + path, {
        method,
        headers: headers(body !== undefined ? { "Content-Type": "application/json" } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data: any = text;
      try {
        data = JSON.parse(text);
      } catch {}
      return { status: res.status, data };
    },
  };
}

export async function newClient(s: Session, name: string, phone = "") {
  const r = await s.json("POST", "/api/admin/clients", { name, phone });
  if (r.status !== 201) throw new Error("cliente: " + JSON.stringify(r.data));
  return r.data as { client: { id: string; balance_cents: number }; link: string };
}

export async function newPurchase(s: Session, clientId: string, items: { description: string; quantity?: number; unit_price: string; size?: string }[], extra: Record<string, unknown> = {}) {
  const r = await s.json("POST", `/api/admin/clients/${clientId}/purchases`, {
    purchase_date: "2026-10-01",
    items,
    ...extra,
  });
  return r;
}

/** Abre el enlace privado como lo haría el cliente: sigue la redirección con la cookie. */
export async function openPortal(link: string, ip = "198.51.100.7") {
  const path = new URL(link).pathname;
  const first = await SELF.fetch(BASE + path, { redirect: "manual", headers: { "CF-Connecting-IP": ip } });
  const cookie = cookieFrom(first, "__Host-bloom_cuenta");
  if (first.status !== 303 || !cookie) return { first, page: null as Response | null, html: await first.text(), cookie: null };
  const page = await SELF.fetch(BASE + "/cuenta", { headers: { Cookie: `__Host-bloom_cuenta=${cookie}`, "CF-Connecting-IP": ip } });
  return { first, page, html: await page.text(), cookie };
}
