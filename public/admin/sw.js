"use strict";
// Service worker mínimo para que el panel se pueda instalar como app.
// No guarda nada en caché: los datos de clientes siempre vienen del servidor.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(
          '<!doctype html><html lang="es-MX"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
            "<title>Sin conexión · BLOOM</title><body><h1>Sin conexión</h1><p>Revisa tu internet y vuelve a abrir BLOOM.</p></body></html>",
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
        ),
    ),
  );
});
