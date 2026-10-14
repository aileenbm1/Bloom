"use strict";
// Portal del cliente: solo imprime. No guarda nada en el navegador.
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action=print]");
  if (t) window.print();
});
