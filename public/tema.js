"use strict";
// Modo claro / oscuro para el panel y el portal. Se carga en <head> para aplicar el tema
// antes de pintar. La elección se guarda en una cookie "tema" que solo dice claro u oscuro
// (no tiene datos de la cuenta); sin elección, se sigue el modo del celular o la computadora.
(function () {
  const root = document.documentElement;
  const saved = (document.cookie.match(/(?:^|;\s*)tema=(claro|oscuro)/) || [])[1];
  const system = () => (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "oscuro" : "claro");
  const apply = (t) => {
    root.dataset.theme = t === "oscuro" ? "dark" : "light";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t === "oscuro" ? "#1a1124" : "#6a2f8f";
    document.querySelectorAll("[data-action=tema]").forEach((b) => {
      b.textContent = t === "oscuro" ? "☀️" : "🌙";
      b.setAttribute("aria-label", t === "oscuro" ? "Cambiar a modo claro" : "Cambiar a modo oscuro");
      b.title = b.getAttribute("aria-label");
    });
  };
  let current = saved || system();
  apply(current);
  if (!saved && window.matchMedia) {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (!document.cookie.match(/(?:^|;\s*)tema=/)) apply((current = system()));
    });
  }
  document.addEventListener("DOMContentLoaded", () => apply(current));
  document.addEventListener("click", (e) => {
    if (!e.target.closest("[data-action=tema]")) return;
    current = current === "oscuro" ? "claro" : "oscuro";
    document.cookie = `tema=${current}; path=/; max-age=31536000; SameSite=Lax; Secure`;
    apply(current);
  });
})();
