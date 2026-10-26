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

// --- Avisos push: la clienta los activa tocando el botón (el navegador pide permiso) ----
(function () {
  const box = document.getElementById("avisos");
  if (!box) return;
  const msg = box.querySelector("[data-avisos-msg]");
  const on = box.querySelector("[data-action=avisos-on]");
  const off = box.querySelector("[data-action=avisos-off]");
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const installed = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  const say = (text) => {
    msg.textContent = text;
    help.hidden = true;
  };
  // Pasos para desbloquear el permiso cuando el navegador ya no muestra la pregunta.
  const help = document.createElement("ol");
  help.className = "avisos-help small";
  help.hidden = true;
  on.before(help);
  const blocked = (lead) => {
    msg.textContent = lead + " (estado: " + Notification.permission + ")";
    help.replaceChildren(
      ...[
        "Toca el ícono que está a la izquierda de la dirección, arriba (o la campanita tachada si aparece).",
        "Entra a Permisos o Notificaciones y elige Permitir.",
        "Revisa Ajustes del celular → Aplicaciones → tu navegador (Chrome o Samsung Internet) → Notificaciones: deben estar activadas. Si están apagadas, el navegador no te puede preguntar.",
        "En Chrome: menú ⋮ → Configuración → Configuración de sitios → Notificaciones → apaga “Usar mensajes más discretos”.",
        "Regresa aquí y toca el botón otra vez.",
      ].map((t) => {
        const li = document.createElement("li");
        li.textContent = t;
        return li;
      }),
    );
    help.hidden = false;
  };
  const show = (subscribed) => {
    on.hidden = subscribed;
    off.hidden = !subscribed;
    say(subscribed ? "✅ Avisos activados en este dispositivo. Te avisaremos el día de tu pago." : "Te avisamos con una notificación el día de tu pago.");
  };

  if (!supported) {
    if (ios && !installed) {
      box.hidden = false;
      on.hidden = true;
      say("En iPhone: toca Compartir y luego “Agregar a inicio”. Abre BLOOM desde ese ícono, pega tu enlace y activa los avisos ahí.");
    }
    return;
  }
  box.hidden = false;

  const keyBytes = () => {
    const s = box.dataset.key.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  };
  const post = (path, body) =>
    fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });

  function notSubscribed() {
    show(false);
    if (Notification.permission === "denied") blocked("Los avisos de BLOOM están bloqueados en este navegador. Para activarlos:");
  }

  const ready = navigator.serviceWorker.register("/portal-sw.js", { scope: "/cuenta" }).then(() => navigator.serviceWorker.ready);
  ready
    .then((reg) => reg.pushManager.getSubscription())
    .then((sub) => {
      if (sub && Notification.permission === "granted") {
        show(true);
        post("/cuenta/avisos", sub.toJSON()).catch(() => {}); // por si el enlace se regeneró
      } else notSubscribed();
    })
    .catch(notSubscribed);

  on.addEventListener("click", async () => {
    on.disabled = true;
    try {
      const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (perm === "denied") {
        blocked("Tu navegador tiene bloqueados los avisos de BLOOM, por eso no te preguntó. Para activarlos:");
        return;
      }
      if (perm !== "granted") {
        blocked("No se eligió “Permitir”. Si no viste la pregunta, tu navegador la ocultó. Para activarlos:");
        return;
      }
      const reg = await ready;
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes() }));
      const res = await post("/cuenta/avisos", sub.toJSON());
      if (res.status === 401) {
        await sub.unsubscribe();
        say("Tu consulta expiró. Abre tu enlace de nuevo para activar los avisos.");
        return;
      }
      if (!res.ok) {
        await sub.unsubscribe();
        const data = await res.json().catch(() => ({}));
        say(data.error || "No se pudieron activar los avisos. Inténtalo más tarde.");
        return;
      }
      show(true);
      reg.showNotification("Avisos activados ✨", { body: "Te avisaremos aquí el día de tu pago.", icon: "/icons/icon-192.png?v=2", tag: "bienvenida" });
    } catch (_) {
      say("Este navegador no permitió activar los avisos.");
    } finally {
      on.disabled = false;
    }
  });

  off.addEventListener("click", async () => {
    off.disabled = true;
    try {
      const reg = await ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await post("/cuenta/avisos/baja", { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      show(false);
      say("Avisos desactivados en este dispositivo.");
    } finally {
      off.disabled = false;
    }
  });
})();
