import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, rawLogin } from "./helpers";

const SECRET = "secreto-de-pruebas-solo-para-vitest-0123456789";

function setup(body: Record<string, unknown>, origin = BASE, ip = "203.0.113.90") {
  return SELF.fetch(BASE + "/api/auth/setup", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
}

describe("Primer administrador desde el navegador", () => {
  it("bloquea por fuerza bruta el código de configuración", async () => {
    for (let i = 0; i < 5; i++) expect((await setup({ setup_code: "x" + i }, BASE, "203.0.113.91")).status).toBe(403);
    expect((await setup({ setup_code: SECRET }, BASE, "203.0.113.91")).status).toBe(429);
  });
  it("solo con el código correcto, una sola vez, y luego permite iniciar sesión", async () => {
    await env.DB.prepare(`DELETE FROM admin_sessions`).run();
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM admins`).first("n")).toBe(0);
    expect(await (await SELF.fetch(BASE + "/api/auth/setup")).json()).toEqual({ needed: true });

    const good = { setup_code: SECRET, username: "Dueña", display_name: "Dueña", password: "una-contraseña-larga" };
    expect((await setup({ ...good, setup_code: "incorrecto" })).status).toBe(403);
    expect((await setup(good, "https://evil.example")).status).toBe(403);
    expect((await setup({ ...good, username: "duena", password: "corta" })).status).toBe(400);

    const ok = await setup({ ...good, username: "duena" });
    expect(ok.status).toBe(201);
    expect(await (await SELF.fetch(BASE + "/api/auth/setup")).json()).toEqual({ needed: false });
    expect((await setup({ ...good, username: "otra" })).status).toBe(409);
    expect((await rawLogin("duena", "una-contraseña-larga")).status).toBe(200);

    const log = await env.DB.prepare(`SELECT action FROM audit_log WHERE action = 'admin_creado_web'`).all();
    expect(log.results).toHaveLength(1);
  });

});
