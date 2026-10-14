// Crea (o restablece la contraseña de) una cuenta administrativa.
// La contraseña se pide sin mostrarse, se convierte a hash PBKDF2 en tu computadora
// y solo el hash se envía a D1. Nunca se guarda en el repositorio ni en archivos.
//
// Uso:
//   npm run admin:create -- --remote --username leilani --name "Leilani"
//   npm run admin:create -- --local  --username admin
import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DB_NAME, arg, askHidden, target, wrangler } from "./lib.mjs";

const where = target();
const username = String(arg("username", "")).trim().toLowerCase();
const displayName = String(arg("name", username)).trim();

if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
  console.error("--username debe tener de 3 a 40 caracteres: letras minúsculas, números, punto, guion o guion bajo.");
  process.exit(1);
}
if (!/^[\p{L}\p{N} .'-]{1,80}$/u.test(displayName)) {
  console.error("--name contiene caracteres no permitidos.");
  process.exit(1);
}

let password = process.env.BLOOM_ADMIN_PASSWORD; // solo para automatización local/pruebas
if (!password) {
  password = await askHidden(`Contraseña para "${username}" (mínimo 12 caracteres): `);
  const again = await askHidden("Repite la contraseña: ");
  if (password !== again) {
    console.error("Las contraseñas no coinciden.");
    process.exit(1);
  }
}
if (password.length < 12 || password.length > 200) {
  console.error("La contraseña debe tener entre 12 y 200 caracteres.");
  process.exit(1);
}

// 100 000 es el máximo que admite PBKDF2 en Workers. Si en el plan gratuito el inicio de
// sesión excede el límite de CPU (error 1102), vuelve a ejecutar con --iterations 50000.
const iterations = Number(arg("iterations", 100000));
if (!Number.isInteger(iterations) || iterations < 10000 || iterations > 100000) {
  console.error("--iterations debe estar entre 10000 y 100000.");
  process.exit(1);
}
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
const stored = `pbkdf2_sha256$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`;
const sqlStr = (s) => "'" + s.replace(/'/g, "''") + "'";

const sql = `
INSERT INTO admins (id, username, display_name, password_hash, password_changed_at)
VALUES (${sqlStr(randomUUID())}, ${sqlStr(username)}, ${sqlStr(displayName)}, ${sqlStr(stored)}, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, display_name = excluded.display_name,
  active = 1, password_changed_at = excluded.password_changed_at;
DELETE FROM admin_sessions WHERE admin_id = (SELECT id FROM admins WHERE username = ${sqlStr(username)});
INSERT INTO audit_log (admin_id, action, entity_type, entity_id, details)
SELECT id, 'admin_configurado_cli', 'admin', id, '{}' FROM admins WHERE username = ${sqlStr(username)};
`;

const dir = mkdtempSync(join(tmpdir(), "bloom-"));
const file = join(dir, "admin.sql");
try {
  writeFileSync(file, sql, { mode: 0o600 });
  const config = arg("config");
  wrangler(["d1", "execute", DB_NAME, where, "--file", file, "--yes", ...(typeof config === "string" ? ["--config", config] : [])]);
  console.log(`\nAdministrador "${username}" listo (${where === "--remote" ? "Cloudflare" : "local"}).`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
