"use strict";
// Portal del cliente: imprime y muestra el aviso del día de pago. No guarda nada en el navegador.
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action=print]");
  if (t) window.print();
});

// --- Aviso del día de pago -------------------------------------------------------
// El servidor solo incluye el <dialog> cuando una compra vence hoy y hay saldo pendiente.
(function () {
  const dialog = document.getElementById("aviso-pago");
  if (!dialog) return;

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");

  // Tocar fuera del recuadro también lo cierra.
  dialog.addEventListener("click", (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close();
  });

  // Sonido de caja registradora suave, generado en el navegador (sin archivos externos).
  // Los navegadores bloquean el audio hasta que la persona toca la pantalla: si está
  // bloqueado, suena con el primer toque.
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  let ctx;
  try {
    ctx = new AC();
  } catch (_) {
    return;
  }
  let played = false;
  const play = () => {
    if (played || ctx.state !== "running") return;
    played = true;
    kaching(ctx);
  };
  const onGesture = () => {
    ctx.resume().then(play, () => {});
    document.removeEventListener("pointerdown", onGesture, true);
    document.removeEventListener("keydown", onGesture, true);
  };
  if (ctx.state === "running") play();
  else {
    ctx.resume().then(play, () => {});
    document.addEventListener("pointerdown", onGesture, true);
    document.addEventListener("keydown", onGesture, true);
  }
})();

function kaching(ctx) {
  const t0 = ctx.currentTime + 0.02;
  const master = ctx.createGain();
  master.gain.value = 0.3; // volumen bajo
  const soften = ctx.createBiquadFilter();
  soften.type = "lowpass";
  soften.frequency.value = 4500;
  master.connect(soften).connect(ctx.destination);

  // "ka": golpecito corto del cajón (ruido filtrado).
  const len = Math.floor(ctx.sampleRate * 0.05);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 2200;
  band.Q.value = 1.2;
  const ng = ctx.createGain();
  ng.gain.value = 0.35;
  noise.connect(band).connect(ng).connect(master);
  noise.start(t0);

  // "ching": dos campanitas con armónicos de campana que se desvanecen.
  [
    [1568, 0.1],
    [2093, 0.17],
  ].forEach(([f, delay]) => {
    [
      [1, 0.22],
      [2.76, 0.06],
      [5.4, 0.02],
    ].forEach(([mult, peak]) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f * mult;
      const g = ctx.createGain();
      const s = t0 + delay;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(peak, s + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 1.1);
      o.connect(g).connect(master);
      o.start(s);
      o.stop(s + 1.15);
    });
  });
}
