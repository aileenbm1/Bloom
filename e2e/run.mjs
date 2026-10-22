// Prueba de extremo a extremo con `wrangler dev` y una D1 local persistente:
//  · persistencia tras reiniciar el servidor (prueba 10)
//  · respaldo con `wrangler d1 export` y restauración en una base vacía (prueba 13)
//  · uso desde un teléfono con Chromium en modo móvil (prueba 12)
// Uso: npm run test:e2e   (requiere Chromium; define CHROMIUM_PATH si no está en /opt/pw-browsers)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const OUT = "e2e/out";
// Cada "instalación" usa su propia configuración y su propia carpeta .wrangler/state,
// igual que dos bases D1 distintas (la original y la restaurada).
const STATE = `${OUT}/original/wrangler.json`;
const RESTORED = `${OUT}/restaurada/wrangler.json`;

function makeConfig(path) {
  const base = JSON.parse(readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, ""));
  base.main = resolve("src/index.ts");
  base.assets.directory = resolve("public");
  base.d1_databases[0].migrations_dir = resolve("migrations");
  delete base.$schema;
  delete base.triggers;
  mkdirSync(path.replace(/\/wrangler\.json$/, ""), { recursive: true });
  writeFileSync(path, JSON.stringify(base, null, 2));
}
const SECRET = randomBytes(48).toString("base64url");
const PASSWORD = "E2e-contraseña-segura-2026";
const shell = process.platform === "win32";
const results = [];

function step(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) {
    process.exitCode = 1;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function run(cmd, args, env = {}) {
  console.log("· " + cmd + " " + args.slice(0, 4).join(" "));
  const r = spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8", shell, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

let server;
let browser;
let activePage;
async function startServer(state) {
  server = spawn("npx", ["wrangler", "dev", "--config", state, "--port", String(PORT), "--ip", "127.0.0.1", "--var", `APP_SECRET:${SECRET}`, "--var", "WHATSAPP_NUMBER:5215512345678"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell,
    detached: !shell,
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE + "/admin/");
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev no arrancó:\n" + log);
}
async function stopServer() {
  if (!server) return;
  const done = new Promise((r) => server.once("exit", r));
  if (shell) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"]);
  else process.kill(-server.pid, "SIGTERM");
  await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
  server = null;
  await new Promise((r) => setTimeout(r, 500));
}

function cookieFrom(res, name) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (pair.slice(0, i) === name) return pair.slice(i + 1);
  }
  return null;
}

async function adminLogin() {
  const t0 = performance.now();
  const res = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ username: "e2e", password: PASSWORD }),
  });
  const ms = Math.round(performance.now() - t0);
  assert(res.status === 200, "login " + res.status);
  const { csrfToken } = await res.json();
  const cookie = cookieFrom(res, "__Host-bloom_admin");
  const call = async (method, path, body) => {
    const r = await fetch(BASE + path, {
      method,
      headers: { Cookie: `__Host-bloom_admin=${cookie}`, Origin: BASE, "X-CSRF-Token": csrfToken, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: r.status, data, text };
  };
  return { call, ms };
}

async function portalHtml(link) {
  const path = new URL(link).pathname;
  const first = await fetch(BASE + path, { redirect: "manual" });
  const cookie = cookieFrom(first, "__Host-bloom_cuenta");
  if (first.status !== 303) return { status: first.status, html: await first.text() };
  const page = await fetch(BASE + "/cuenta", { headers: { Cookie: `__Host-bloom_cuenta=${cookie}` } });
  return { status: page.status, html: await page.text() };
}

try {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  makeConfig(STATE);
  makeConfig(RESTORED);

  // Preparación: migraciones y administrador (contraseña hasheada en Node, como en producción).
  run("npx", ["wrangler", "d1", "migrations", "apply", "bloom-db", "--local", "--config", STATE]);
  run("node", ["scripts/create-admin.mjs", "--local", "--username", "e2e", "--name", "Prueba E2E", "--config", STATE], { BLOOM_ADMIN_PASSWORD: PASSWORD });
  step("Migraciones aplicadas y administrador creado con el script", true);

  await startServer(STATE);
  let { call, ms } = await adminLogin();
  step("Inicio de sesión contra wrangler dev", true, `${ms} ms (incluye PBKDF2 100 000 iteraciones)`);

  const c = await call("POST", "/api/admin/clients", { name: "Valeria Persistente", phone: "5544332211" });
  assert(c.status === 201, "crear cliente");
  const clientId = c.data.client.id;
  const link = c.data.link;
  const p = await call("POST", `/api/admin/clients/${clientId}/purchases`, {
    purchase_date: "2026-10-10",
    due_date: "2026-11-10",
    items: [
      { description: "Vestido largo", size: "M", quantity: 1, unit_price: "1299.90" },
      { description: "Aretes", quantity: 2, unit_price: "150" },
    ],
  });
  assert(p.status === 201, "compra");
  const y = await call("POST", `/api/admin/clients/${clientId}/payments`, { amount: "599.90", paid_at: "2026-10-12", method: "transferencia", note: "SPEI" });
  assert(y.status === 201, "abono");
  const balance = y.data.client.balance_cents;
  step("Cliente, compra y abono registrados", balance === 100000, `saldo ${balance / 100} MXN`);
  const portal1 = await portalHtml(link);
  step("Portal del cliente responde con su cuenta", portal1.status === 200 && portal1.html.includes("Valeria Persistente") && portal1.html.includes("1,000.00"));

  // 10 · Persistencia tras reinicio
  await stopServer();
  await startServer(STATE);
  ({ call } = await adminLogin());
  const after = await call("GET", `/api/admin/clients/${clientId}`);
  step(
    "10 · Los datos sobreviven al reinicio del servidor",
    after.status === 200 && after.data.client.balance_cents === 100000 && after.data.payments.length === 1 && after.data.purchases[0].items.length === 2,
  );
  const portal2 = await portalHtml(link);
  step("10 · El enlace privado sigue funcionando tras el reinicio", portal2.status === 200 && portal2.html.includes("Valeria Persistente"));

  // 11 · Exportación con importes correctos (contra el servidor real)
  const csv = await call("GET", "/api/admin/export/clientes.csv");
  const line = csv.text.split("\r\n").find((l) => l.includes("Valeria"));
  step("11 · CSV exportado con importes correctos", line === "Valeria Persistente,55 4433 2211,1,1599.90,599.90,1000.00,0.00,Debe,2026-11-10,2026-10-12", line);

  // 13 · Respaldo y restauración
  await stopServer();
  const backup = `${OUT}/respaldo.sql`;
  run("npx", ["wrangler", "d1", "export", "bloom-db", "--local", "--config", STATE, "--output", backup]);
  const dump = readFileSync(backup, "utf8");
  step("13 · Respaldo exportado", dump.includes("Valeria Persistente"), `${dump.length} bytes`);
  run("npx", ["wrangler", "d1", "execute", "bloom-db", "--local", "--config", RESTORED, "--file", backup, "--yes"]);
  const pending = run("npx", ["wrangler", "d1", "migrations", "list", "bloom-db", "--local", "--config", RESTORED]);
  step("13 · La base restaurada no tiene migraciones pendientes", /No migrations to apply/i.test(pending));
  await startServer(RESTORED);
  ({ call } = await adminLogin());
  const restored = await call("GET", `/api/admin/clients/${clientId}`);
  step("13 · La base restaurada conserva clientes, compras, abonos y saldo", restored.status === 200 && restored.data.client.balance_cents === 100000 && restored.data.payments.length === 1);
  const portal3 = await portalHtml(link);
  step("13 · El enlace privado funciona en la base restaurada", portal3.status === 200 && portal3.html.includes("Valeria Persistente"));
  const auditRows = await call("GET", "/api/admin/audit?limit=500");
  step("13 · La auditoría se conserva", auditRows.data.entries.some((e) => e.action === "abono_registrado"));

  // 12 · Uso desde un teléfono (Chromium en modo móvil)
  const chromium = process.env.CHROMIUM_PATH || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find((p) => existsSync(p));
  if (!chromium) {
    step("12 · Prueba móvil omitida (define CHROMIUM_PATH)", true);
  } else {
    const { chromium: pw } = await import("playwright-core");
    browser = await pw.launch({ executablePath: chromium });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "es-MX" });
    const page = await ctx.newPage();
    activePage = page;
    const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    await page.goto(BASE + "/admin/");
    await page.fill("input[name=username]", "e2e");
    await page.fill("input[name=password]", PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForSelector("text=Saldo pendiente");
    step("12 · Login en el panel desde un teléfono", true);
    await page.screenshot({ path: `${OUT}/movil-resumen.png`, fullPage: true });
    // Registrar un cliente nuevo, una compra y un abono desde la interfaz móvil.
    await page.goto(BASE + "/admin/#/clientes");
    await page.fill("#nc-name", "Renata Móvil");
    await page.fill("#nc-phone", "5511223344");
    await page.click("text=Registrar cliente");
    await page.waitForSelector("h1:has-text('Renata Móvil')");
    await page.fill(".item-row input[name=description]", "Blusa satinada");
    await page.fill(".item-row input[name=unit_price]", "450");
    await page.click("text=Guardar compra");
    await page.waitForSelector("text=Compra del");
    await page.fill("form:has(h2:has-text('Registrar abono')) input[name=amount]", "200");
    await page.click("form:has(h2:has-text('Registrar abono')) button[type=submit]");
    await page.waitForSelector("td:has-text('$200.00')");
    const saldo = await page.locator(".tile.main strong").first().textContent();
    step("12 · Compra y abono capturados desde el teléfono", saldo.includes("250.00"), "saldo " + saldo);
    step("12 · El panel no desborda horizontalmente a 390 px", await noHScroll());
    await page.screenshot({ path: `${OUT}/movil-cliente.png`, fullPage: true });
    const mobileLink = await page.locator(".linkbox code").textContent();
    // Portal en otro contexto (como el teléfono de la clienta)
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "es-MX" });
    const page2 = await ctx2.newPage();
    await page2.goto(mobileLink);
    await page2.waitForSelector("text=Renata Móvil");
    const url = page2.url();
    step("12 · Portal móvil: el token desaparece de la barra de direcciones", url === BASE + "/cuenta", url);
    const stored = await page2.evaluate(() => localStorage.length + sessionStorage.length);
    step("12 · Portal móvil: no guarda nada en localStorage/sessionStorage", stored === 0);
    step("12 · Portal móvil: sin desbordamiento horizontal", await page2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    const jsCookie = await page2.evaluate(() => document.cookie);
    step("12 · Portal móvil: la cookie del enlace no es accesible desde JavaScript", jsCookie === "");
    await page2.screenshot({ path: `${OUT}/movil-portal.png`, fullPage: true });
  }
} catch (err) {
  step("Error inesperado", false, err.message.slice(0, 2000));
  if (activePage) {
    await activePage.screenshot({ path: `${OUT}/error.png`, fullPage: true }).catch(() => {});
    const msg = await activePage.locator(".error:not([hidden])").allTextContents().catch(() => []);
    if (msg.length) console.log("Mensaje en pantalla:", msg.join(" | "));
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopServer();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} comprobaciones correctas.`);
}
