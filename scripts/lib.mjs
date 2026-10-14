// Utilidades compartidas por los scripts de administración (Node.js ≥ 20).
import { spawnSync } from "node:child_process";

export const DB_NAME = "bloom-db";

export function arg(name, fallback = undefined) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

export function target() {
  const remote = process.argv.includes("--remote");
  const local = process.argv.includes("--local");
  if (remote === local) {
    console.error("Indica --local (desarrollo) o --remote (Cloudflare).");
    process.exit(1);
  }
  return remote ? "--remote" : "--local";
}

/** Ejecuta wrangler con argumentos ya validados (sin interpolar datos del usuario). */
export function wrangler(args, opts = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], {
    stdio: opts.input !== undefined ? ["pipe", "inherit", "inherit"] : opts.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    input: opts.input,
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    if (opts.quiet) console.error(r.stdout, r.stderr);
    console.error(`wrangler terminó con código ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

/** Lee una línea sin mostrarla en pantalla. */
export function askHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    if (!stdin.isTTY) {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (d) => (buf += d));
      stdin.on("end", () => resolve(buf.split(/\r?\n/)[0]));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (ch) => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value);
      } else if (ch === "\u0003") {
        process.stdout.write("\n");
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
