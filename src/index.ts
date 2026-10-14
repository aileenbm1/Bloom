import { Hono } from "hono";
import type { AppEnv, Env } from "./env";
import { requireSecret, securityHeaders, withIpHash } from "./lib/http";
import { HttpError, ValidationError } from "./lib/validate";
import { admin } from "./routes/admin";
import { auth } from "./routes/auth";
import { portal } from "./routes/portal";

const app = new Hono<AppEnv>();

app.use("*", securityHeaders);
// Solo la API y el portal necesitan APP_SECRET (si falta, se genera y guarda en D1).
for (const path of ["/api/*", "/cuenta", "/cuenta/*"]) {
  app.use(path, requireSecret);
  app.use(path, withIpHash);
}

app.get("/", (c) => c.redirect("/admin/", 302));
app.get("/admin", (c) => c.redirect("/admin/", 301));
app.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 301));

app.route("/api/auth", auth);
app.route("/api/admin", admin);
app.route("/", portal);

app.all("/api/*", (c) => c.json({ error: "No encontrado" }, 404));

// Archivos estáticos (panel, estilos, scripts).
app.all("*", async (c) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.json({ error: "Método no permitido" }, 405);
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  if (err instanceof ValidationError) return c.json({ error: err.message, field: err.field }, 400);
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof SyntaxError) return c.json({ error: "Solicitud inválida" }, 400);
  // No se registran datos personales ni secretos: solo el tipo de error y la ruta sin parámetros.
  const route = c.req.routePath ?? "";
  console.error(JSON.stringify({ level: "error", route, name: err.name, message: err.message.slice(0, 200) }));
  return c.json({ error: "Error interno. Inténtalo de nuevo." }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM admin_sessions WHERE expires_at < ?1`).bind(now),
      env.DB.prepare(`DELETE FROM rate_limits WHERE window_start < ?1`).bind(now - 24 * 60 * 60 * 1000),
    ]);
  },
} satisfies ExportedHandler<Env>;

export { app };
