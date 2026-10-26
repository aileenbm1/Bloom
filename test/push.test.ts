import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { b64url, fromB64url } from "../src/lib/crypto";
import { localToday, sendPaydayPushes, sendReminders } from "../src/lib/push";
import type { Env } from "../src/env";
import { BASE, login, newClient, newPurchase, openPortal } from "./helpers";

const appEnv = env as unknown as Env;

const enc = new TextEncoder();

/** Simula el navegador: claves de la suscripción y un endpoint de FCM. */
async function fakeBrowser() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const endpoint = "https://fcm.googleapis.com/fcm/send/" + crypto.randomUUID();
  return { pair, auth, json: { endpoint, keys: { p256dh: b64url(raw), auth: b64url(auth) } } };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** Descifra como lo haría el navegador (RFC 8291), para comprobar el cifrado. */
async function decrypt(b: Awaited<ReturnType<typeof fakeBrowser>>, body: Uint8Array) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const uaPublic = fromB64url(b.json.keys.p256dh);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as any, b.pair.privateKey, 256));
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(b.auth, ecdh, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, cipher));
  expect(plain[plain.length - 1]).toBe(2);
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

/** fetch falso que registra los envíos al servicio push. */
function fakePush(status = 201) {
  const calls: { url: string; headers: Headers; body: Uint8Array }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers), body: new Uint8Array(init.body as ArrayBuffer) });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { fn, calls, to: (endpoint: string) => calls.filter((c) => c.url === endpoint) };
}

function subscribe(cookie: string, body: unknown, origin = BASE) {
  return SELF.fetch(BASE + "/cuenta/avisos", {
    method: "POST",
    headers: { Cookie: `__Host-bloom_cuenta=${cookie}`, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function clientDueToday(name: string) {
  const s = await login();
  const today = localToday();
  const c = await newClient(s, name);
  await newPurchase(s, c.client.id, [{ description: "Vestido", unit_price: "800" }], { purchase_date: today, due_date: today });
  const p = await openPortal(c.link);
  return { s, c, p, today };
}

describe("Avisos push · suscripción desde el portal", () => {
  it("el portal ofrece el botón con la clave pública VAPID", async () => {
    const { p } = await clientDueToday("Valeria Vapid");
    const key = p.html.match(/id="avisos" data-key="([A-Za-z0-9_-]+)"/)?.[1];
    expect(key).toBeDefined();
    expect(fromB64url(key!).length).toBe(65);
    expect(p.html).toContain("Avisarme mi día de pago");
    expect(p.html).toContain('rel="manifest" href="/portal.webmanifest"');
  });

  it("requiere la cookie del portal, mismo origen y un servicio push conocido", async () => {
    const { p } = await clientDueToday("Sofía Suscrita");
    const b = await fakeBrowser();
    const noCookie = await SELF.fetch(BASE + "/cuenta/avisos", { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify(b.json) });
    expect(noCookie.status).toBe(401);
    expect((await subscribe(p.cookie!, b.json, "https://malo.example")).status).toBe(400);
    expect((await subscribe(p.cookie!, { ...b.json, endpoint: "https://169.254.169.254/latest" })).status).toBe(400);
    expect((await subscribe(p.cookie!, { ...b.json, keys: { p256dh: "abc", auth: "def" } })).status).toBe(400);
    expect((await subscribe(p.cookie!, b.json)).status).toBe(201);
    // Repetir con el mismo dispositivo no duplica.
    expect((await subscribe(p.cookie!, b.json)).status).toBe(201);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?1`).bind(b.json.endpoint).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("la clienta puede desactivarlos", async () => {
    const { p } = await clientDueToday("Daniela Desactiva");
    const b = await fakeBrowser();
    await subscribe(p.cookie!, b.json);
    const r = await SELF.fetch(BASE + "/cuenta/avisos/baja", {
      method: "POST",
      headers: { Cookie: `__Host-bloom_cuenta=${p.cookie}`, Origin: BASE, "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: b.json.endpoint }),
    });
    expect(r.status).toBe(200);
    expect(await env.DB.prepare(`SELECT 1 FROM push_subscriptions WHERE endpoint = ?1`).bind(b.json.endpoint).first()).toBeNull();
  });

  it("se puede entrar pegando el enlace (app instalada en iPhone)", async () => {
    const s = await login();
    const c = await newClient(s, "Isabel iPhone");
    const r = await SELF.fetch(BASE + "/cuenta/entrar", {
      method: "POST",
      redirect: "manual",
      headers: { Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ enlace: "  " + c.link + "  " }),
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("Location")).toBe("/cuenta");
    expect(r.headers.getSetCookie().some((x) => x.startsWith("__Host-bloom_cuenta="))).toBe(true);
    const bad = await SELF.fetch(BASE + "/cuenta/entrar", {
      method: "POST",
      redirect: "manual",
      headers: { Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ enlace: "hola" }),
    });
    expect(bad.status).toBe(404);
  });
});

describe("Avisos push · envío", () => {
  it("el día de pago envía un aviso cifrado y firmado, una sola vez", async () => {
    const { p } = await clientDueToday("Paula Push");
    const key = p.html.match(/data-key="([A-Za-z0-9_-]+)"/)![1];
    const b = await fakeBrowser();
    await subscribe(p.cookie!, b.json);

    const push = fakePush();
    await sendPaydayPushes(appEnv, new Date(), push.fn);
    const mine = push.to(b.json.endpoint);
    expect(mine).toHaveLength(1);
    const h = mine[0].headers;
    expect(h.get("Content-Encoding")).toBe("aes128gcm");
    expect(Number(h.get("TTL"))).toBeGreaterThan(0);
    const m = h.get("Authorization")!.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/)!;
    expect(m[4]).toBe(key);
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(m[2])));
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    const pub = await crypto.subtle.importKey("raw", fromB64url(key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromB64url(m[3]), enc.encode(`${m[1]}.${m[2]}`));
    expect(valid).toBe(true);

    const msg = await decrypt(b, mine[0].body);
    expect(msg.title).toContain("Hoy es tu día de pago");
    expect(JSON.stringify(msg)).not.toContain("800"); // sin montos en la pantalla de bloqueo

    const again = fakePush();
    await sendPaydayPushes(appEnv, new Date(), again.fn);
    expect(again.to(b.json.endpoint)).toHaveLength(0);
  });

  it("no avisa si no vence hoy o si ya pagó", async () => {
    const s = await login();
    const otro = await newClient(s, "Olivia Otrodía");
    await newPurchase(s, otro.client.id, [{ description: "Blusa", unit_price: "300" }], { purchase_date: "2026-01-01", due_date: "2099-12-31" });
    const po = await openPortal(otro.link);
    const bo = await fakeBrowser();
    await subscribe(po.cookie!, bo.json);

    const { c, p, today } = await clientDueToday("Pilar Pagada");
    const bp = await fakeBrowser();
    await subscribe(p.cookie!, bp.json);
    await s.json("POST", `/api/admin/clients/${c.client.id}/payments`, { amount: "800", paid_at: today, method: "efectivo" });

    const push = fakePush();
    await sendPaydayPushes(appEnv, new Date(), push.fn);
    expect(push.to(bo.json.endpoint)).toHaveLength(0);
    expect(push.to(bp.json.endpoint)).toHaveLength(0);
  });

  it("revocar o regenerar el enlace borra sus avisos", async () => {
    const { s, c, p } = await clientDueToday("Renata Revocada");
    const b = await fakeBrowser();
    await subscribe(p.cookie!, b.json);
    await s.json("POST", `/api/admin/clients/${c.client.id}/link/regenerate`, {});
    expect(await env.DB.prepare(`SELECT 1 FROM push_subscriptions WHERE endpoint = ?1`).bind(b.json.endpoint).first()).toBeNull();
    const push = fakePush();
    await sendPaydayPushes(appEnv, new Date(), push.fn);
    expect(push.to(b.json.endpoint)).toHaveLength(0);
  });

  it("si el navegador ya no existe (410), se borra la suscripción", async () => {
    const { p } = await clientDueToday("Gabriela Gone");
    const b = await fakeBrowser();
    await subscribe(p.cookie!, b.json);
    await sendPaydayPushes(appEnv, new Date(), fakePush(410).fn);
    expect(await env.DB.prepare(`SELECT 1 FROM push_subscriptions WHERE endpoint = ?1`).bind(b.json.endpoint).first()).toBeNull();
  });
});

describe("Avisos push · recordatorios desde el panel", () => {
  it("por clienta: requiere avisos activos y saldo, y queda en el historial", async () => {
    const { s, c, p } = await clientDueToday("Regina Recordatorio");
    const sin = await s.json("POST", `/api/admin/clients/${c.client.id}/push/reminder`, {});
    expect(sin.status).toBe(409);
    const b = await fakeBrowser();
    await subscribe(p.cookie!, b.json);
    const detail = await s.json("GET", `/api/admin/clients/${c.client.id}`);
    expect(detail.data.push.devices).toBe(1);
    // Sin CSRF no se puede enviar.
    const forged = await SELF.fetch(BASE + `/api/admin/clients/${c.client.id}/push/reminder`, {
      method: "POST",
      headers: { Cookie: `__Host-bloom_admin=${s.cookie}`, Origin: BASE },
    });
    expect(forged.status).toBe(403);
    const audit = await s.json("GET", `/api/admin/audit?entity_id=${c.client.id}`);
    expect(audit.data.entries.some((e: any) => e.action === "recordatorio_enviado")).toBe(false);
  });

  it("el recordatorio llega cifrado; el general no se repite en 12 horas", async () => {
    const { c, p } = await clientDueToday("Romina Recordada");
    const b = await fakeBrowser();
    await subscribe(p.cookie!, b.json);
    const one = fakePush();
    const r1 = await sendReminders(appEnv, c.client.id, one.fn);
    expect(r1).toMatchObject({ clients: 1, devices: 1, sent: 1, failed: 0 });
    expect((await decrypt(b, one.to(b.json.endpoint)[0].body)).title).toContain("Recordatorio de pago");

    const all = fakePush();
    await sendReminders(appEnv, null, all.fn);
    expect(all.to(b.json.endpoint)).toHaveLength(0); // ya recibió uno hace menos de 12 h
  });

  it("general: cuenta clientas con avisos y saldo pendiente", async () => {
    const s = await login();
    const stats = await s.json("GET", "/api/admin/push");
    expect(stats.status).toBe(200);
    expect(typeof stats.data.with_balance).toBe("number");
  });
});
