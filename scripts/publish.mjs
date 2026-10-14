// Publicación completa en Cloudflare con un solo comando (pensado para GitHub Codespaces):
//   npm run publicar
// Es seguro repetirlo: cada paso comprueba si ya está hecho.
//  1. Verifica la autenticación (CLOUDFLARE_API_TOKEN o `wrangler login`).
//  2. Despliega el Worker; Wrangler crea la base D1 "bloom-db" si no existe y, en el primer
//     despliegue, se sube un APP_SECRET aleatorio (sin mostrarlo).
//  3. Aplica las migraciones pendientes a la base remota.
//  4. Crea el primer administrador si aún no hay ninguno (pide usuario y contraseña).
//  5. Comprueba la URL pública real y que la base D1 responde desde el Worker.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DB_NAME } from "./lib.mjs";

const shell = process.platform === "win32";

function wr(args, { capture = true, input } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    shell,
    input,
    stdio: capture ? ["pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "" };
}

function fail(msg) {
  console.error("\n✘ " + msg + "\n");
  process.exit(1);
}

function jsonFrom(text) {
  const i = text.search(/[\[{]/);
  if (i < 0) throw new Error("sin JSON");
  return JSON.parse(text.slice(i));
}

console.log("BLOOM · Publicación en Cloudflare\n");

// 1 · Autenticación ------------------------------------------------------------
const who = wr(["whoami"]);
if (!who.ok || /not authenticated|You are not authenticated/i.test(who.out)) {
  fail(
    "Wrangler no está autenticado.\n" +
      "  En Codespaces: crea los secretos CLOUDFLARE_API_TOKEN y CLOUDFLARE_ACCOUNT_ID (README → Codespaces)\n" +
      "  y reconstruye el codespace. En tu computadora: npx wrangler login",
  );
}
console.log("✔ Autenticado en Cloudflare");

// 2 · Despliegue (crea la base D1 automáticamente si no existe) ------------------
const secrets = wr(["secret", "list", "--format", "json"]);
let hasSecret = false;
try {
  hasSecret = secrets.ok && jsonFrom(secrets.stdout).some((s) => s.name === "APP_SECRET");
} catch {}
const tmp = mkdtempSync(join(tmpdir(), "bloom-"));
let deploy;
try {
  const args = ["deploy"];
  if (!hasSecret) {
    const file = join(tmp, "secrets.json");
    writeFileSync(file, JSON.stringify({ APP_SECRET: randomBytes(48).toString("base64url") }), { mode: 0o600 });
    args.push("--secrets-file", file);
  }
  deploy = wr(args);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (!deploy.ok) fail("Falló el despliegue.\n" + deploy.out.slice(-1500));
const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(deploy.out)?.[0];
console.log("✔ Worker desplegado" + (hasSecret ? "" : " (APP_SECRET generado y guardado como secreto cifrado)"));
if (!url) {
  console.log(deploy.out.slice(-1500));
  fail(
    "No se encontró la URL workers.dev en la salida. Si es tu primer Worker, abre dash.cloudflare.com → Workers & Pages\n" +
      "  para registrar tu subdominio workers.dev y vuelve a ejecutar npm run publicar.",
  );
}

// 3 · Migraciones (la base "bloom-db" ya existe: el despliegue la crea si faltaba) --------
const mig = wr(["d1", "migrations", "apply", DB_NAME, "--remote"]);
if (!mig.ok) fail("Falló la migración remota.\n" + mig.out.slice(-1200));
console.log("✔ Base D1 \"" + DB_NAME + "\" lista y migraciones aplicadas");

// 4 · Primer administrador -----------------------------------------------------------
const count = wr(["d1", "execute", DB_NAME, "--remote", "--json", "--command", "SELECT COUNT(*) AS n FROM admins WHERE active = 1"]);
let admins = -1;
try {
  admins = jsonFrom(count.stdout)[0].results[0].n;
} catch {}
if (admins === 0) {
  console.log("\nNo hay administradores todavía. Vamos a crear el primero.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = [];
  let waiting = null;
  rl.on("line", (l) => (waiting ? (waiting(l), (waiting = null)) : lines.push(l)));
  const ask = (q) => {
    process.stdout.write(q);
    return lines.length ? Promise.resolve(lines.shift()) : new Promise((res) => (waiting = res));
  };
  const username = ((await ask("Usuario (minúsculas, sin espacios) [leilani]: ")).trim() || "leilani").toLowerCase();
  const name = (await ask("Nombre para mostrar [Leilani]: ")).trim() || "Leilani";
  rl.close();
  const r = spawnSync("node", ["scripts/create-admin.mjs", "--remote", "--username", username, "--name", name], { stdio: "inherit", shell });
  if (r.status !== 0) fail("No se creó el administrador. Repite: npm run admin:create -- --remote --username " + username);
} else if (admins > 0) {
  console.log(`✔ Administradores existentes: ${admins}`);
}

// 5 · Verificación de la URL pública y de D1 -----------------------------------------
console.log(`\nComprobando ${url} …`);
async function check() {
  const page = await fetch(url + "/admin/");
  if (page.status !== 200) throw new Error("/admin/ respondió " + page.status);
  // Un login con credenciales inexistentes recorre D1 (límite de intentos y tabla admins).
  const probe = await fetch(url + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: url },
    body: JSON.stringify({ username: "verificacion-" + randomBytes(4).toString("hex"), password: "x" }),
  });
  const body = await probe.json().catch(() => ({}));
  if (probe.status !== 401) throw new Error(`la API respondió ${probe.status}: ${JSON.stringify(body)}`);
}
let lastErr;
for (let i = 0; i < 12; i++) {
  try {
    await check();
    lastErr = null;
    break;
  } catch (e) {
    lastErr = e;
    await new Promise((r) => setTimeout(r, 5000)); // el subdominio nuevo puede tardar en propagarse
  }
}
if (lastErr) fail("El Worker se desplegó pero la verificación falló: " + lastErr.message);
console.log("✔ La URL pública responde y el Worker lee y escribe en D1");
console.log(`\n🌸 BLOOM publicado en: ${url}/admin/\n`);
