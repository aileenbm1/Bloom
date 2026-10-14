// Respaldo completo de D1 (esquema + datos) a un archivo SQL en ./backups/.
//   npm run backup            → base remota (Cloudflare)
//   npm run backup -- --local → base local
import { mkdirSync } from "node:fs";
import { DB_NAME, wrangler } from "./lib.mjs";

const where = process.argv.includes("--local") ? "--local" : "--remote";
mkdirSync("backups", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const file = `backups/bloom-${where.slice(2)}-${stamp}.sql`;
wrangler(["d1", "export", DB_NAME, where, "--output", file]);
console.log(`\nRespaldo guardado en ${file}. Guárdalo fuera de la computadora (por ejemplo, en tu nube personal).`);
