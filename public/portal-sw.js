"use strict";
// Service worker del portal: solo muestra los avisos push y abre la cuenta al tocarlos.
// No guarda nada en caché ni en almacenamiento: los datos siempre vienen del servidor.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let msg = { title: "BLOOM", body: "Toca para ver tu estado de cuenta.", tag: "bloom" };
  try {
    if (event.data) msg = Object.assign(msg, event.data.json());
  } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(String(msg.title).slice(0, 80), {
      body: String(msg.body).slice(0, 200),
      tag: String(msg.tag).slice(0, 40),
      icon: "/icons/icon-192.png?v=2",
      badge: "/icons/icon-192.png?v=2",
      lang: "es-MX",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const w of list) {
        if (new URL(w.url).pathname.startsWith("/cuenta") && "focus" in w) return w.navigate("/cuenta").then((x) => (x || w).focus());
      }
      return self.clients.openWindow("/cuenta");
    }),
  );
});
