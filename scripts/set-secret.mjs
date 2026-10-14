// Genera APP_SECRET aleatorio y lo guarda como secreto cifrado en Cloudflare
// sin mostrarlo en pantalla ni escribirlo en disco.
//   npm run secret:set
// ADVERTENCIA: cambiar APP_SECRET invalida los enlaces que se muestran en el panel
// (los clientes siguen entrando, pero tendrás que regenerar el enlace para copiarlo).
import { randomBytes } from "node:crypto";
import { wrangler } from "./lib.mjs";

const secret = randomBytes(48).toString("base64url");
wrangler(["secret", "put", "APP_SECRET"], { input: secret + "\n" });
console.log("APP_SECRET configurado en Cloudflare.");
