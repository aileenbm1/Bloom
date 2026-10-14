// Verificación previa a `npm run deploy`: evita publicar con la configuración incompleta.
import { readFileSync } from "node:fs";

const cfg = readFileSync("wrangler.jsonc", "utf8");
const id = /"database_id"\s*:\s*"([^"]*)"/.exec(cfg)?.[1] ?? "";
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
  console.error(
    "\n✘ Falta el ID real de la base D1 en wrangler.jsonc.\n" +
      "  1) npm run db:create\n" +
      '  2) Copia el "database_id" que imprime y pégalo en wrangler.jsonc en lugar de "' + id + '"\n' +
      "  3) npm run db:migrate:remote\n",
  );
  process.exit(1);
}
console.log("✔ wrangler.jsonc tiene un database_id válido.");
