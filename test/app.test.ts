import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { localToday } from "../src/routes/portal";
import { BASE, PASSWORD, cookieFrom, ensureAdmin, login, newClient, newPurchase, openPortal, rawLogin } from "./helpers";

describe("1 · Autenticación administrativa", () => {
  it("el administrador inicia sesión con cookie HttpOnly, Secure y SameSite=Strict", async () => {
    await ensureAdmin("ana");
    const res = await rawLogin("ana", PASSWORD);
    expect(res.status).toBe(200);
    const sc = res.headers.getSetCookie().find((c) => c.startsWith("__Host-bloom_admin="))!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(sc).toMatch(/Path=\//);
    const s = await login("ana");
    const me = await s.json("GET", "/api/auth/session");
    expect(me.status).toBe(200);
    expect(me.data.admin.username).toBe("ana");
  });

  it("rechaza contraseña incorrecta sin revelar si el usuario existe", async () => {
    await ensureAdmin("bea");
    const a = await rawLogin("bea", "incorrecta-123456", "203.0.113.50");
    const b = await rawLogin("no-existe", "incorrecta-123456", "203.0.113.50");
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(await a.json()).toEqual(await b.json());
  });

  it("bloquea por fuerza bruta tras 5 intentos fallidos", async () => {
    await ensureAdmin("carla");
    for (let i = 0; i < 5; i++) expect((await rawLogin("carla", "mala-" + i, "203.0.113.60")).status).toBe(401);
    // Incluso la contraseña correcta se bloquea durante la ventana.
    expect((await rawLogin("carla", PASSWORD, "203.0.113.61")).status).toBe(429);
  });

  it("las rutas administrativas exigen sesión", async () => {
    for (const p of ["/api/admin/clients", "/api/admin/dashboard", "/api/admin/export/clientes.csv", "/api/admin/audit"]) {
      const r = await SELF.fetch(BASE + p);
      expect(r.status, p).toBe(401);
    }
  });

  it("protege contra CSRF: exige token y mismo origen", async () => {
    const s = await login();
    const noToken = await SELF.fetch(BASE + "/api/admin/clients", {
      method: "POST",
      headers: { Cookie: `__Host-bloom_admin=${s.cookie}`, Origin: BASE, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect(noToken.status).toBe(403);
    const otherOrigin = await SELF.fetch(BASE + "/api/admin/clients", {
      method: "POST",
      headers: { Cookie: `__Host-bloom_admin=${s.cookie}`, Origin: "https://evil.example", "X-CSRF-Token": s.csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect(otherOrigin.status).toBe(403);
  });

  it("cerrar sesión invalida la cookie", async () => {
    const s = await login();
    expect((await s.json("POST", "/api/auth/logout", {})).status).toBe(200);
    expect((await s.json("GET", "/api/admin/clients")).status).toBe(401);
  });
});

describe("2-4 · Clientes, compras y enlaces privados", () => {
  it("registra clientes y compras con varias prendas", async () => {
    const s = await login();
    const { client } = await newClient(s, "María López", "55 1234 5678");
    const r = await newPurchase(s, client.id, [
      { description: "Vestido floral", size: "M", quantity: 1, unit_price: "850.50" },
      { description: "Blusa blanca", size: "CH", quantity: 2, unit_price: "299.99" },
    ], { discount: "50", due_date: "2026-11-15" });
    expect(r.status).toBe(201);
    expect(r.data.total_cents).toBe(85050 + 2 * 29999 - 5000);
    const d = await s.json("GET", `/api/admin/clients/${client.id}`);
    expect(d.data.client.phone).toBe("5512345678");
    expect(d.data.client.balance_cents).toBe(140048);
    expect(d.data.client.status).toBe("pendiente");
    expect(d.data.client.next_due_date).toBe("2026-11-15");
    expect(d.data.purchases[0].items).toHaveLength(2);
  });

  it("cada cliente obtiene un enlace distinto, aleatorio y sin datos personales", async () => {
    const s = await login();
    const a = await newClient(s, "Cliente Uno", "5511111111");
    const b = await newClient(s, "Cliente Dos", "5522222222");
    expect(a.link).not.toBe(b.link);
    for (const l of [a.link, b.link]) {
      const token = l.split("/cuenta/")[1];
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(l).not.toContain("5511111111");
      expect(l.toLowerCase()).not.toContain("cliente");
    }
    // En la base solo se guarda el hash, nunca el token en claro.
    const token = a.link.split("/cuenta/")[1];
    const rows = await env.DB.prepare(`SELECT token_hash, token_encrypted FROM access_tokens WHERE client_id = ?1`).bind(a.client.id).all<{ token_hash: string; token_encrypted: string }>();
    expect(rows.results[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.results[0].token_hash).not.toContain(token);
    expect(rows.results[0].token_encrypted).not.toContain(token);
  });

  it("cada enlace muestra solo la cuenta autorizada", async () => {
    const s = await login();
    const a = await newClient(s, "Ximena Ruiz");
    const b = await newClient(s, "Yolanda Pérez");
    await newPurchase(s, a.client.id, [{ description: "Falda plisada", unit_price: "400" }]);
    await newPurchase(s, b.client.id, [{ description: "Chamarra de mezclilla", unit_price: "1200" }]);
    const pa = await openPortal(a.link);
    expect(pa.first.status).toBe(303);
    expect(pa.first.headers.get("Location")).toBe("/cuenta"); // el token sale de la URL
    expect(pa.html).toContain("Ximena Ruiz");
    expect(pa.html).toContain("Falda plisada");
    expect(pa.html).not.toContain("Yolanda");
    expect(pa.html).not.toContain("Chamarra");
    const pb = await openPortal(b.link);
    expect(pb.html).toContain("Yolanda Pérez");
    expect(pb.html).not.toContain("Ximena");
  });

  it("el portal no se indexa y no filtra el token (encabezados de seguridad)", async () => {
    const s = await login();
    const a = await newClient(s, "Zoe Seguridad");
    const p = await openPortal(a.link);
    for (const r of [p.first, p.page!]) {
      expect(r.headers.get("X-Robots-Tag")).toContain("noindex");
      expect(r.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(r.headers.get("Cache-Control")).toBe("no-store");
      expect(r.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
      expect(r.headers.get("X-Frame-Options")).toBe("DENY");
    }
    const sc = p.first.headers.getSetCookie().find((c) => c.startsWith("__Host-bloom_cuenta="))!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    // El HTML no contiene el token ni recursos externos (salvo el enlace de WhatsApp).
    const token = a.link.split("/cuenta/")[1];
    expect(p.html).not.toContain(token);
    expect(p.html).not.toMatch(/<(script|link|img)[^>]+https?:\/\//);
    expect(p.html).not.toContain("localStorage");
  });
});

describe("5-7 · Abonos y saldos", () => {
  it("un abono reduce el saldo correctamente", async () => {
    const s = await login();
    const { client } = await newClient(s, "Paola Abonos");
    await newPurchase(s, client.id, [{ description: "Vestido", unit_price: "1000.00" }]);
    const r = await s.json("POST", `/api/admin/clients/${client.id}/payments`, { amount: "250.25", paid_at: "2026-10-05", method: "efectivo", note: "Primer abono" });
    expect(r.status).toBe(201);
    expect(r.data.client.paid_cents).toBe(25025);
    expect(r.data.client.balance_cents).toBe(74975);
    const r2 = await s.json("POST", `/api/admin/clients/${client.id}/payments`, { amount: "1,00.10", paid_at: "2026-10-06", method: "transferencia" });
    expect(r2.status).toBe(201); // "1,00.10" → 100.10 tras quitar separadores
    expect(r2.data.client.balance_cents).toBe(74975 - 10010);
  });

  it("no acepta importes inválidos", async () => {
    const s = await login();
    const { client } = await newClient(s, "Inés Inválidos");
    const pur = await newPurchase(s, client.id, [{ description: "Bolso", unit_price: "500" }]);
    const bad: unknown[] = ["-10", "0", "0.00", "abc", "10.555", "1e3", "", null, "NaN", "Infinity", -5, 0, 10.555, "１００", "99999999999"];
    for (const amount of bad) {
      const r = await s.json("POST", `/api/admin/clients/${client.id}/payments`, { amount, paid_at: "2026-10-05", method: "efectivo" });
      expect(r.status, JSON.stringify(amount)).toBe(400);
    }
    // Mayor que lo que resta de la compra a la que se aplica
    const over = await s.json("POST", `/api/admin/clients/${client.id}/payments`, { amount: "500.01", paid_at: "2026-10-05", method: "efectivo", purchase_id: pur.data.purchase_id });
    expect(over.status).toBe(409);
    // Método o fecha inválidos
    expect((await s.json("POST", `/api/admin/clients/${client.id}/payments`, { amount: "10", paid_at: "2026-02-30", method: "efectivo" })).status).toBe(400);
    expect((await s.json("POST", `/api/admin/clients/${client.id}/payments`, { amount: "10", paid_at: "2026-10-05", method: "bitcoin" })).status).toBe(400);
    // Precio de prenda inválido y descuento mayor que el subtotal
    expect((await newPurchase(s, client.id, [{ description: "X", unit_price: "-1" }])).status).toBe(400);
    expect((await newPurchase(s, client.id, [{ description: "X", unit_price: "10" }], { discount: "11" })).status).toBe(400);
    const d = await s.json("GET", `/api/admin/clients/${client.id}`);
    expect(d.data.client.balance_cents).toBe(50000);
    expect(d.data.payments).toHaveLength(0);
  });

  it("una cuenta liquidada muestra saldo cero", async () => {
    const s = await login();
    const c = await newClient(s, "Lucía Liquidada");
    await newPurchase(s, c.client.id, [{ description: "Pantalón", quantity: 2, unit_price: "350.50" }]);
    await s.json("POST", `/api/admin/clients/${c.client.id}/payments`, { amount: "500", paid_at: "2026-10-02", method: "efectivo" });
    const r = await s.json("POST", `/api/admin/clients/${c.client.id}/payments`, { amount: "201.00", paid_at: "2026-10-03", method: "tarjeta" });
    expect(r.data.client.balance_cents).toBe(0);
    expect(r.data.client.status).toBe("liquidada");
    const list = await s.json("GET", "/api/admin/clients?status=liquidada");
    expect(list.data.clients.map((x: any) => x.id)).toContain(c.client.id);
    const pending = await s.json("GET", "/api/admin/clients?status=pendiente");
    expect(pending.data.clients.map((x: any) => x.id)).not.toContain(c.client.id);
    const p = await openPortal(c.link);
    expect(p.html).toContain("Al corriente");
    expect(p.html).toMatch(/Saldo pendiente<\/span><strong>\$0\.00<\/strong>/);
  });

  it("un abono mayor al saldo deja saldo a favor que se descuenta de la siguiente compra", async () => {
    const s = await login();
    const c = await newClient(s, "Fernanda Favor");
    const pur = await newPurchase(s, c.client.id, [{ description: "Blusa", unit_price: "400" }]);
    // Aplicado a la compra no puede exceder lo que resta de ella.
    expect((await s.json("POST", `/api/admin/clients/${c.client.id}/payments`, { amount: "400.01", paid_at: "2026-10-03", method: "efectivo", purchase_id: pur.data.purchase_id })).status).toBe(409);
    // A la cuenta general sí: queda saldo a favor.
    const r = await s.json("POST", `/api/admin/clients/${c.client.id}/payments`, { amount: "550", paid_at: "2026-10-03", method: "efectivo" });
    expect(r.status).toBe(201);
    expect(r.data.client.balance_cents).toBe(-15000);
    expect(r.data.client.status).toBe("a_favor");
    const list = await s.json("GET", "/api/admin/clients?status=a_favor");
    expect(list.data.clients.map((x: any) => x.id)).toContain(c.client.id);
    const dash = (await s.json("GET", "/api/admin/dashboard")).data;
    expect(dash.credit_cents).toBeGreaterThanOrEqual(15000);
    expect(dash.clients_credit).toBeGreaterThanOrEqual(1);
    const p = await openPortal(c.link);
    expect(p.html).toMatch(/Saldo a tu favor<\/span><strong>\$150\.00<\/strong>/);
    const csv = await (await s.get("/api/admin/export/clientes.csv")).text();
    expect(csv.split("\r\n").find((l) => l.includes("Fernanda Favor"))).toContain(",400.00,550.00,0.00,150.00,A favor,");
    // La siguiente compra consume el saldo a favor.
    const next = await newPurchase(s, c.client.id, [{ description: "Falda", unit_price: "200" }]);
    expect(next.data.client.balance_cents).toBe(5000);
    expect(next.data.client.status).toBe("pendiente");
    // Un anticipo sin compras también cuenta como saldo a favor.
    const d = await newClient(s, "Nora Anticipo");
    const adv = await s.json("POST", `/api/admin/clients/${d.client.id}/payments`, { amount: "300", paid_at: "2026-10-03", method: "transferencia" });
    expect(adv.data.client.status).toBe("a_favor");
  });

  it("corrige un abono de forma atómica y auditada", async () => {
    const s = await login();
    const c = await newClient(s, "Carmen Corrección");
    const pur = await newPurchase(s, c.client.id, [{ description: "Abrigo", unit_price: "900" }]);
    const p = await s.json("POST", `/api/admin/clients/${c.client.id}/payments`, { amount: "300", paid_at: "2026-10-02", method: "efectivo" });
    // Corrección inválida (excede lo que resta de la compra): no debe quedar nada a medias.
    const bad = await s.json("POST", `/api/admin/payments/${p.data.payment_id}/correct`, { amount: "901", paid_at: "2026-10-02", method: "efectivo", purchase_id: pur.data.purchase_id, reason: "Error de captura" });
    expect(bad.status).toBe(409);
    let d = await s.json("GET", `/api/admin/clients/${c.client.id}`);
    expect(d.data.payments.filter((x: any) => x.status === "valid")).toHaveLength(1);
    expect(d.data.client.balance_cents).toBe(60000);
    // Corrección válida
    const ok = await s.json("POST", `/api/admin/payments/${p.data.payment_id}/correct`, { amount: "350", paid_at: "2026-10-02", method: "transferencia", reason: "Error de captura" });
    expect(ok.status).toBe(201);
    expect(ok.data.client.balance_cents).toBe(55000);
    d = await s.json("GET", `/api/admin/clients/${c.client.id}`);
    const old = d.data.payments.find((x: any) => x.id === p.data.payment_id);
    expect(old.status).toBe("voided");
    // Repetir la corrección sobre el abono ya anulado no duplica.
    expect((await s.json("POST", `/api/admin/payments/${p.data.payment_id}/correct`, { amount: "10", paid_at: "2026-10-02", method: "efectivo", reason: "otra" })).status).toBe(409);
    // Anular
    const v = await s.json("POST", `/api/admin/payments/${ok.data.payment_id}/void`, { reason: "Pago rebotado" });
    expect(v.data.client.balance_cents).toBe(90000);
    const audit = await s.json("GET", `/api/admin/audit?entity_id=${c.client.id}`);
    const actions = audit.data.entries.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["cliente_creado", "compra_registrada", "abono_registrado", "abono_corregido", "abono_anulado"]));
  });

  it("auditoría por cliente: recuadros, historial y detalle de cada operación", async () => {
    const s = await login();
    const c = await newClient(s, "Diana Auditoría");
    await newPurchase(s, c.client.id, [{ description: "Vestido", unit_price: "500" }]);
    await s.json("POST", `/api/admin/clients/${c.client.id}/payments`, { amount: "200", paid_at: "2026-10-05", method: "tarjeta", note: "Primer pago" });

    const grid = await s.json("GET", "/api/admin/audit/clients");
    expect(grid.status).toBe(200);
    const card = grid.data.clients.find((x: any) => x.id === c.client.id);
    expect(card.entries).toBe(3);
    expect(grid.data.system.entries).toBeGreaterThan(0); // inicios de sesión

    const hist = await s.json("GET", `/api/admin/audit?entity_id=${c.client.id}`);
    expect(hist.data.client.name).toBe("Diana Auditoría");
    const sys = await s.json("GET", "/api/admin/audit?entity_id=sistema");
    expect(sys.data.entries.every((e: any) => e.entity_type === "admin")).toBe(true);

    const byAction = (a: string) => hist.data.entries.find((e: any) => e.action === a);
    const buy = await s.json("GET", `/api/admin/audit/entry/${byAction("compra_registrada").id}`);
    expect(buy.data.client.id).toBe(c.client.id);
    expect(buy.data.purchase.items[0].description).toBe("Vestido");
    const pay = await s.json("GET", `/api/admin/audit/entry/${byAction("abono_registrado").id}`);
    expect(pay.data.payment).toMatchObject({ amount_cents: 20000, method: "tarjeta", note: "Primer pago" });
    expect((await s.json("GET", "/api/admin/audit/entry/abc")).status).toBe(404);
  });

  it("cancelar compra exige anular antes sus abonos", async () => {
    const s = await login();
    const c = await newClient(s, "Rosa Cancelación");
    const pur = await newPurchase(s, c.client.id, [{ description: "Saco", unit_price: "700" }]);
    const pay = await s.json("POST", `/api/admin/clients/${c.client.id}/payments`, { amount: "100", paid_at: "2026-10-02", method: "efectivo", purchase_id: pur.data.purchase_id });
    expect(pay.status).toBe(201);
    expect((await s.json("POST", `/api/admin/purchases/${pur.data.purchase_id}/cancel`, { reason: "Devolución" })).status).toBe(409);
    await s.json("POST", `/api/admin/payments/${pay.data.payment_id}/void`, { reason: "Devolución" });
    const ok = await s.json("POST", `/api/admin/purchases/${pur.data.purchase_id}/cancel`, { reason: "Devolución" });
    expect(ok.status).toBe(200);
    expect(ok.data.client.balance_cents).toBe(0);
  });

  it("la base de datos impide alterar importes o saldos sin operación registrada", async () => {
    const s = await login();
    const c = await newClient(s, "Sonia Integridad");
    const pur = await newPurchase(s, c.client.id, [{ description: "Top", unit_price: "200" }]);
    const pay = await s.json("POST", `/api/admin/clients/${c.client.id}/payments`, { amount: "50", paid_at: "2026-10-02", method: "efectivo" });
    await expect(env.DB.prepare(`UPDATE payments SET amount_cents = 1 WHERE id = ?1`).bind(pay.data.payment_id).run()).rejects.toThrow();
    await expect(env.DB.prepare(`UPDATE purchases SET total_cents = 1, subtotal_cents = 1 WHERE id = ?1`).bind(pur.data.purchase_id).run()).rejects.toThrow();
    await expect(env.DB.prepare(`DELETE FROM payments WHERE id = ?1`).bind(pay.data.payment_id).run()).rejects.toThrow();
    await expect(env.DB.prepare(`UPDATE purchase_items SET unit_price_cents = 1`).run()).rejects.toThrow();
    await expect(env.DB.prepare(`DELETE FROM audit_log`).run()).rejects.toThrow();
  });
});

describe("Aviso del día de pago", () => {
  it("usa la fecha de México, no la de UTC", () => {
    // 27 oct 01:30 UTC = 26 oct 19:30 en Ciudad de México.
    expect(localToday(new Date("2026-10-27T01:30:00Z"))).toBe("2026-10-26");
  });

  it("aparece cuando una compra vence hoy y hay saldo pendiente", async () => {
    const s = await login();
    const today = localToday();
    const c = await newClient(s, "Paola Pagadía");
    await newPurchase(s, c.client.id, [{ description: "Vestido", unit_price: "800" }], { purchase_date: today, due_date: today });
    const p = await openPortal(c.link);
    expect(p.html).toContain('id="aviso-pago"');
    expect(p.html).toContain("¡Hoy es tu día de pago, Paola!");
    expect(p.html).toContain("$800.00");
  });

  it("no aparece si la fecha límite es otro día o la cuenta está liquidada", async () => {
    const s = await login();
    const today = localToday();
    const otro = await newClient(s, "Olga Otrodía");
    await newPurchase(s, otro.client.id, [{ description: "Blusa", unit_price: "300" }], { purchase_date: "2026-01-01", due_date: "2099-12-31" });
    expect((await openPortal(otro.link)).html).not.toContain('id="aviso-pago"');

    const pagada = await newClient(s, "Lina Liquidada");
    await newPurchase(s, pagada.client.id, [{ description: "Falda", unit_price: "300" }], { purchase_date: today, due_date: today });
    await s.json("POST", `/api/admin/clients/${pagada.client.id}/payments`, { amount: "300", paid_at: today, method: "efectivo" });
    expect((await openPortal(pagada.link)).html).not.toContain('id="aviso-pago"');
  });
});

describe("8-9 · Revocación y aislamiento del cliente", () => {
  it("un enlace revocado deja de funcionar de inmediato (incluida la cookie ya emitida)", async () => {
    const s = await login();
    const c = await newClient(s, "Diana Revocada");
    const p = await openPortal(c.link);
    expect(p.html).toContain("Diana Revocada");
    expect((await s.json("POST", `/api/admin/clients/${c.client.id}/link/revoke`, {})).status).toBe(200);
    const again = await openPortal(c.link);
    expect(again.first.status).toBe(404);
    expect(again.html).not.toContain("Diana");
    const withCookie = await SELF.fetch(BASE + "/cuenta", { headers: { Cookie: `__Host-bloom_cuenta=${p.cookie}` } });
    expect(withCookie.status).toBe(404);
    // Regenerar entrega un enlace nuevo que sí funciona.
    const reg = await s.json("POST", `/api/admin/clients/${c.client.id}/link/regenerate`, {});
    expect(reg.data.url).not.toBe(c.link);
    expect((await openPortal(reg.data.url)).html).toContain("Diana Revocada");
    expect((await openPortal(c.link)).first.status).toBe(404);
  });

  it("el cliente no puede editar su saldo, registrar abonos ni consultar otras cuentas", async () => {
    const s = await login();
    const a = await newClient(s, "Elena Aislada");
    const b = await newClient(s, "Fernanda Ajena");
    await newPurchase(s, a.client.id, [{ description: "Vestido", unit_price: "100" }]);
    const p = await openPortal(a.link);
    const portalCookie = `__Host-bloom_cuenta=${p.cookie}`;
    // Con la cookie del portal no hay acceso a la API administrativa.
    const attempts: [string, string, unknown?][] = [
      ["GET", `/api/admin/clients/${b.client.id}`],
      ["GET", `/api/admin/clients`],
      ["POST", `/api/admin/clients/${a.client.id}/payments`, { amount: "100", paid_at: "2026-10-01", method: "efectivo" }],
      ["PATCH", `/api/admin/clients/${a.client.id}`, { name: "Hack" }],
      ["GET", `/api/admin/export/clientes.csv`],
    ];
    for (const [method, path, body] of attempts) {
      const r = await SELF.fetch(BASE + path, {
        method,
        headers: { Cookie: portalCookie, Origin: BASE, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(r.status, method + " " + path).toBe(401);
    }
    // El portal no acepta escrituras.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await SELF.fetch(BASE + "/cuenta", { method, headers: { Cookie: portalCookie, Origin: BASE } });
      expect([404, 405]).toContain(r.status);
    }
    // No existe forma de pedir otra cuenta por id: el portal solo usa el token.
    const r = await SELF.fetch(BASE + `/cuenta?id=${b.client.id}`, { headers: { Cookie: portalCookie } });
    const html = await r.text();
    expect(html).toContain("Elena Aislada");
    expect(html).not.toContain("Fernanda");
    // Tokens alterados o adivinados no funcionan.
    const token = a.link.split("/cuenta/")[1];
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect((await SELF.fetch(BASE + "/cuenta/" + tampered, { redirect: "manual" })).status).toBe(404);
    expect((await SELF.fetch(BASE + "/cuenta/" + b.client.id, { redirect: "manual" })).status).toBe(404);
    expect((await SELF.fetch(BASE + "/cuenta/1", { redirect: "manual" })).status).toBe(404);
    const d = await s.json("GET", `/api/admin/clients/${a.client.id}`);
    expect(d.data.client.balance_cents).toBe(10000);
    expect(d.data.client.name).toBe("Elena Aislada");
  });

  it("limita los intentos de adivinar enlaces", async () => {
    const ip = "192.0.2.99";
    for (let i = 0; i < 20; i++) {
      const fake = "A".repeat(42) + String.fromCharCode(66 + (i % 20));
      const r = await SELF.fetch(BASE + "/cuenta/" + fake, { redirect: "manual", headers: { "CF-Connecting-IP": ip } });
      expect(r.status).toBe(404);
    }
    const blocked = await SELF.fetch(BASE + "/cuenta/" + "C".repeat(43), { redirect: "manual", headers: { "CF-Connecting-IP": ip } });
    expect(blocked.status).toBe(429);
  });
});

describe("11 · Exportaciones", () => {
  it("el CSV contiene importes correctos y es compatible con Excel", async () => {
    const s = await login();
    const c = await newClient(s, "Gabriela Export, \"G\"", "5533334444");
    await newPurchase(s, c.client.id, [{ description: "=HYPERLINK(\"x\")", quantity: 3, unit_price: "123.45" }], { discount: "0.35" });
    await s.json("POST", `/api/admin/clients/${c.client.id}/payments`, { amount: "100.10", paid_at: "2026-10-04", method: "deposito", note: "+nota" });
    const res = await s.get("/api/admin/export/clientes.csv");
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect([...buf.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM UTF-8
    const text = new TextDecoder().decode(buf);
    const line = text.split("\r\n").find((l) => l.includes("Gabriela"))!;
    expect(line).toBe('"Gabriela Export, ""G""",55 3333 4444,1,370.00,100.10,269.90,0.00,Debe,,2026-10-04');
    const compras = await (await s.get("/api/admin/export/compras.csv")).text();
    const cl = compras.split("\r\n").find((l) => l.includes("Gabriela"))!;
    expect(cl).toContain("370.35,0.35,370.00");
    expect(cl).toContain('"3 x =HYPERLINK(""x"")"'); // no inicia con "=": Excel lo trata como texto
    // Un nombre que inicia con "=", "+", "-" o "@" se neutraliza con apóstrofo.
    await newClient(s, "=SUMA(A1:A9)");
    const clientes = await (await s.get("/api/admin/export/clientes.csv")).text();
    expect(clientes).toContain("\r\n'=SUMA(A1:A9),");
    const abonos = await (await s.get("/api/admin/export/abonos.csv")).text();
    const al = abonos.split("\r\n").find((l) => l.includes("Gabriela"))!;
    expect(al).toContain(",100.10,deposito,'+nota,Válido");
  });

  it("los indicadores suman correctamente", async () => {
    const s = await login();
    const before = (await s.json("GET", "/api/admin/dashboard")).data;
    const c = await newClient(s, "Hilda Indicadores");
    await newPurchase(s, c.client.id, [{ description: "A", unit_price: "1000" }]);
    await s.json("POST", `/api/admin/clients/${c.client.id}/payments`, { amount: "400", paid_at: new Date().toISOString().slice(0, 10), method: "efectivo" });
    const after = (await s.json("GET", "/api/admin/dashboard")).data;
    expect(after.purchases_cents - before.purchases_cents).toBe(100000);
    expect(after.paid_cents - before.paid_cents).toBe(40000);
    expect(after.balance_cents - before.balance_cents).toBe(60000);
    expect(after.paid_month_cents - before.paid_month_cents).toBe(40000);
  });

  it("busca por nombre y teléfono", async () => {
    const s = await login();
    await newClient(s, "Itzel Búsqueda", "5599887766");
    const byName = await s.json("GET", "/api/admin/clients?q=itzel");
    expect(byName.data.clients.map((c: any) => c.name)).toContain("Itzel Búsqueda");
    const byPhone = await s.json("GET", "/api/admin/clients?q=" + encodeURIComponent("99 88"));
    expect(byPhone.data.clients.map((c: any) => c.name)).toContain("Itzel Búsqueda");
    const wildcard = await s.json("GET", "/api/admin/clients?q=%25");
    expect(wildcard.data.clients).toHaveLength(0);
  });
});

describe("Errores y encabezados", () => {
  it("los errores no exponen datos internos", async () => {
    const s = await login();
    const r = await s.json("GET", "/api/admin/clients/00000000-0000-4000-8000-000000000000");
    expect(r.status).toBe(404);
    const bad = await SELF.fetch(BASE + "/api/admin/clients", {
      method: "POST",
      headers: { Cookie: `__Host-bloom_admin=${s.cookie}`, Origin: BASE, "X-CSRF-Token": s.csrf, "Content-Type": "application/json" },
      body: "{no es json",
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toMatch(/stack|sqlite|D1_/i);
  });

  it("los archivos del panel se sirven con encabezados de seguridad", async () => {
    const r = await SELF.fetch(BASE + "/admin/");
    expect(r.status).toBe(200);
    expect(r.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(r.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(await r.text()).toContain("BLOOM");
  });
});

describe("Desarrollo en GitHub Codespaces", () => {
  it("acepta el origen reenviado por Codespaces solo en localhost", async () => {
    await ensureAdmin("codespace");
    const body = JSON.stringify({ username: "codespace", password: PASSWORD });
    const fwd = "mi-codespace-8787.app.github.dev";
    const local = await SELF.fetch("http://localhost:8787/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `https://${fwd}`, "X-Forwarded-Host": fwd },
      body,
    });
    expect(local.status).toBe(200);
    // En producción el encabezado X-Forwarded-Host no amplía los orígenes permitidos.
    const prod = await SELF.fetch(BASE + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example", "X-Forwarded-Host": "evil.example" },
      body,
    });
    expect(prod.status).toBe(403);
  });
});
