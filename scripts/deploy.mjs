// Despliegue usado por `npm run deploy` (también como "Deploy command" en Workers Builds).
//  1. Si el Worker aún no tiene el secreto APP_SECRET, genera uno aleatorio y lo sube como
//     secreto cifrado de Cloudflare junto con el despliegue. Nunca se muestra ni se guarda en disco
//     más que en un archivo temporal que se borra al terminar.
//  2. Despliega el Worker (Wrangler crea la base D1 "bloom-db" si no existe).
//  3. Aplica las migraciones pendientes de D1.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB_NAME } from "./lib.mjs";

const shell = process.platform === "win32";
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };

function wr(args, capture = false) {
  const r = spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", shell, env, stdio: capture ? "pipe" : "inherit" });
  return { ok: r.status === 0, status: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "" };
}

// ¿Ya existe APP_SECRET? Solo se genera uno nuevo cuando es seguro afirmar que no existe:
// si la consulta falla por otra razón, no se toca para no cambiar una clave en uso.
let addSecret = false;
const list = wr(["secret", "list", "--format", "json"], true);
if (list.ok) {
  try {
    const i = list.stdout.search(/[\[{]/);
    addSecret = !JSON.parse(list.stdout.slice(i)).some((s) => s.name === "APP_SECRET");
  } catch {
    console.warn("⚠ No se pudo leer la lista de secretos; APP_SECRET no se modifica.");
  }
} else if (/not found|does not exist|10007/i.test(list.out)) {
  addSecret = true; // primer despliegue: el Worker todavía no existe
} else {
  console.warn("⚠ No se pudo consultar los secretos del Worker; APP_SECRET no se modifica.");
}

const tmp = mkdtempSync(join(tmpdir(), "bloom-"));
let deploy;
try {
  const args = ["deploy"];
  if (addSecret) {
    const file = join(tmp, "secrets.json");
    writeFileSync(file, JSON.stringify({ APP_SECRET: randomBytes(48).toString("base64url") }), { mode: 0o600 });
    args.push("--secrets-file", file);
    console.log("· APP_SECRET no existe: se genera uno aleatorio y se guarda como secreto cifrado de Cloudflare.");
  }
  deploy = wr(args);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (!deploy.ok) process.exit(deploy.status);

const migrate = wr(["d1", "migrations", "apply", DB_NAME, "--remote"]);
process.exit(migrate.status);
