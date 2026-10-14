// Prepara el entorno local (se ejecuta solo antes de `npm run dev`; es seguro repetirlo):
//  1. Crea .dev.vars con un APP_SECRET aleatorio si no existe.
//  2. Aplica las migraciones pendientes a la D1 local.
//  3. Avisa si todavía no hay ningún administrador local.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DB_NAME, wrangler } from "./lib.mjs";

const vars = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8") : "";
const m = /^APP_SECRET=(.*)$/m.exec(vars);
if (!m || m[1].trim().length < 32) {
  const line = `APP_SECRET=${randomBytes(48).toString("base64url")}`;
  const next = m ? vars.replace(/^APP_SECRET=.*$/m, line) : (vars && !vars.endsWith("\n") ? vars + "\n" : vars) + line + "\n";
  writeFileSync(".dev.vars", next, { mode: 0o600 });
  console.log("✔ .dev.vars listo con un APP_SECRET local (no se sube al repositorio).");
}

wrangler(["d1", "migrations", "apply", DB_NAME, "--local"], { quiet: true });
console.log("✔ Base D1 local al día.");

const r = spawnSync("npx", ["wrangler", "d1", "execute", DB_NAME, "--local", "--json", "--command", "SELECT COUNT(*) AS n FROM admins"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
let admins = -1;
try {
  admins = JSON.parse(r.stdout)[0].results[0].n;
} catch {}
if (admins === 0) {
  console.log("\n⚠ Aún no hay administradores en la base local. Créalo con:");
  console.log('  npm run admin:create -- --local --username leilani --name "Leilani"\n');
}
