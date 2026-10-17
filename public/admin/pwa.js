"use strict";
// Instalación del panel como app en el celular (PWA).

(() => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/admin/sw.js", { scope: "/admin/" }).catch(() => {});
  }

  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (standalone) return;

  const bar = document.getElementById("install");
  const text = document.getElementById("install-text");
  const btn = document.getElementById("install-btn");
  const close = document.getElementById("install-close");
  const KEY = "bloom-install-dismissed";

  function dismissed() {
    try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
  }
  close.addEventListener("click", () => {
    bar.hidden = true;
    try { localStorage.setItem(KEY, "1"); } catch {}
  });

  // Android / Chrome / Edge: el navegador ofrece el diálogo de instalación.
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    if (dismissed()) return;
    text.textContent = "Instala BLOOM en tu celular para abrirlo como app.";
    btn.hidden = false;
    bar.hidden = false;
  });
  btn.addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    deferred = null;
    bar.hidden = true;
  });
  window.addEventListener("appinstalled", () => { bar.hidden = true; });

  // iPhone / iPad (Safari no tiene botón de instalar): se explica el paso manual.
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios && !dismissed()) {
    text.textContent = "Para instalar BLOOM: toca Compartir y luego «Agregar a inicio».";
    btn.hidden = true;
    bar.hidden = false;
  }
})();
