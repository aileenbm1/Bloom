"use strict";
// BLOOM · Panel administrativo. Sin dependencias externas.
// Todo el texto se inserta con textContent (nunca innerHTML con datos) para evitar XSS.
// El token CSRF vive solo en memoria; la sesión es una cookie HttpOnly.

(() => {
  const state = { csrf: null, admin: null };
  const app = document.getElementById("app");
  const topbar = document.getElementById("topbar");

  // ---------- utilidades ----------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const mxn = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
  const money = (cents) => mxn.format((cents || 0) / 100);
  const dateFmt = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const fdate = (d) => (d ? dateFmt.format(new Date(d.slice(0, 10) + "T00:00:00Z")) : "");
  const dtFmt = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short" });
  const fdatetime = (d) => (d ? dtFmt.format(new Date(d.slice(0, 24))) : "");
  function today() {
    // Fecha local de México
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    return parts;
  }
  const STATUS = { pendiente: "Pendiente", liquidada: "Liquidada", sin_compras: "Sin compras" };
  const METHODS = [
    ["efectivo", "Efectivo"],
    ["transferencia", "Transferencia"],
    ["tarjeta", "Tarjeta"],
    ["deposito", "Depósito"],
    ["otro", "Otro"],
  ];
  const methodLabel = (m) => (METHODS.find((x) => x[0] === m) || [m, m])[1];

  let toastTimer;
  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  async function api(method, path, body) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && state.csrf) headers["X-CSRF-Token"] = state.csrf;
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
    });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (res.status === 401 && !path.startsWith("/api/auth/login")) {
      state.csrf = null;
      state.admin = null;
      renderLogin(path === "/api/auth/session" ? "" : "Tu sesión terminó. Inicia sesión de nuevo.");
      throw new ApiError(401, "No autenticado");
    }
    if (!res.ok) throw new ApiError(res.status, data.error || "Error inesperado");
    return data;
  }

  function formData(form) {
    const out = {};
    for (const [k, v] of new FormData(form).entries()) out[k] = typeof v === "string" ? v : "";
    return out;
  }

  function errorBox() {
    return h("p", { class: "error", role: "alert", hidden: true });
  }
  function showError(box, err) {
    box.textContent = err && err.message ? err.message : String(err);
    box.hidden = false;
  }

  async function submitting(form, fn) {
    const btns = form.querySelectorAll("button");
    btns.forEach((b) => (b.disabled = true));
    try {
      await fn();
    } finally {
      btns.forEach((b) => (b.disabled = false));
    }
  }

  function setView(...nodes) {
    app.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
    window.scrollTo(0, 0);
  }

  function markNav() {
    const hash = location.hash || "#/";
    topbar.querySelectorAll("nav a").forEach((a) => {
      const href = a.getAttribute("href");
      a.classList.toggle("active", href === "#/" ? hash === "#/" : hash.startsWith(href.replace(/s$/, "")));
    });
  }

  function confirmDialog({ title, message, fields = [], confirmText = "Confirmar", danger = false }) {
    return new Promise((resolve) => {
      const err = errorBox();
      const form = h(
        "form",
        { method: "dialog" },
        h("h3", {}, title),
        message ? h("p", { class: "muted" }, message) : null,
        fields,
        err,
        h(
          "div",
          { class: "actions" },
          h("button", { type: "submit", class: danger ? "danger" : "", value: "ok" }, confirmText),
          h("button", { type: "button", class: "ghost", onclick: () => { dlg.close(); resolve(null); } }, "Cancelar"),
        ),
      );
      const dlg = h("dialog", {}, form);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (!form.reportValidity()) return;
        const data = formData(form);
        dlg.close();
        dlg.remove();
        resolve(data);
      });
      dlg.addEventListener("cancel", () => resolve(null));
      document.body.append(dlg);
      dlg.showModal();
    });
  }

  function badge(status) {
    return h("span", { class: "badge " + status }, STATUS[status] || status);
  }

  function waNumber(phone) {
    if (!phone) return null;
    if (/^\d{10}$/.test(phone)) return "52" + phone;
    return phone;
  }

  // ---------- autenticación ----------
  function renderLogin(message) {
    topbar.hidden = true;
    const err = errorBox();
    if (message) showError(err, { message });
    const form = h(
      "form",
      { class: "card", autocomplete: "on" },
      h("p", { class: "muted", style: null }, "Control de pagos · Acceso administrativo"),
      h("div", { class: "field" }, h("label", { for: "u" }, "Usuario"), h("input", { id: "u", name: "username", required: true, autocomplete: "username", autocapitalize: "none" })),
      h("div", { class: "field" }, h("label", { for: "p" }, "Contraseña"), h("input", { id: "p", name: "password", type: "password", required: true, autocomplete: "current-password" })),
      err,
      h("button", { type: "submit" }, "Iniciar sesión"),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submitting(form, async () => {
        try {
          const data = await api("POST", "/api/auth/login", formData(form));
          state.csrf = data.csrfToken;
          state.admin = data.admin;
          if (!location.hash || location.hash === "#/login") location.hash = "#/";
          route();
        } catch (e2) {
          showError(err, e2);
        }
      });
    });
    setView(h("div", { class: "login" }, h("img", { class: "logo", src: "/logo.png", alt: "BLOOM · A tu manera", width: 280, height: 216 }), form));
    form.querySelector("input").focus();
  }

  document.getElementById("logout").addEventListener("click", async () => {
    try {
      await api("POST", "/api/auth/logout", {});
    } catch {}
    state.csrf = null;
    state.admin = null;
    renderLogin("Sesión cerrada.");
  });

  // ---------- resumen ----------
  async function viewDashboard() {
    const d = await api("GET", "/api/admin/dashboard");
    setView(
      h("h1", {}, "Resumen"),
      h(
        "div",
        { class: "grid" },
        tile("Deuda total registrada", money(d.purchases_cents)),
        tile("Pagos recibidos", money(d.paid_cents)),
        tile("Saldo pendiente", money(d.balance_cents), true),
        tile("Abonos este mes", money(d.paid_month_cents) + " · " + d.payments_month),
        tile("Clientes con saldo", String(d.clients_pending) + " de " + d.clients_total),
        tile("Cuentas liquidadas", String(d.clients_settled)),
        tile("Con fecha límite vencida", String(d.clients_overdue)),
      ),
      h("h2", {}, "Mayores saldos pendientes"),
      d.top_pending.length ? clientList(d.top_pending) : h("p", { class: "muted" }, "No hay saldos pendientes."),
      h("h2", {}, "Exportar a Excel (CSV)"),
      h(
        "div",
        { class: "actions" },
        h("a", { class: "btn secondary", href: "/api/admin/export/clientes.csv" }, "Saldos por cliente"),
        h("a", { class: "btn secondary", href: "/api/admin/export/compras.csv" }, "Compras"),
        h("a", { class: "btn secondary", href: "/api/admin/export/abonos.csv" }, "Abonos"),
      ),
    );
  }
  function tile(label, value, main) {
    return h("div", { class: "tile" + (main ? " main" : "") }, h("span", {}, label), h("strong", {}, value));
  }

  function clientList(list) {
    const t = today();
    return h(
      "ul",
      { class: "client-list card", style: null },
      list.map((c) =>
        h(
          "li",
          {},
          h(
            "a",
            { href: "#/cliente/" + c.id },
            h("span", { class: "who" }, h("strong", {}, c.name), h("span", { class: "muted small" }, c.phone || "Sin teléfono")),
            h(
              "span",
              { class: "num" },
              h("strong", {}, money(Math.max(c.balance_cents, 0))),
              " ",
              badge(c.status),
              c.next_due_date && c.next_due_date < t ? [" ", h("span", { class: "badge late" }, "Vencida")] : null,
            ),
          ),
        ),
      ),
    );
  }

  // ---------- clientes ----------
  async function viewClients() {
    const params = new URLSearchParams((location.hash.split("?")[1]) || "");
    const q = params.get("q") || "";
    const status = params.get("status") || "";
    const search = h("input", { type: "search", name: "q", placeholder: "Buscar por nombre o teléfono", value: q, "aria-label": "Buscar" });
    const filter = h(
      "select",
      { name: "status", "aria-label": "Filtrar" },
      [["", "Todas"], ["pendiente", "Pendientes"], ["liquidada", "Liquidadas"], ["sin_compras", "Sin compras"]].map(([v, l]) =>
        h("option", { value: v, selected: v === status }, l),
      ),
    );
    const listBox = h("div", {});
    const toolbar = h("form", { class: "toolbar", role: "search" }, search, filter, h("button", { type: "submit" }, "Buscar"));
    const go = () => {
      const p = new URLSearchParams();
      if (search.value.trim()) p.set("q", search.value.trim());
      if (filter.value) p.set("status", filter.value);
      location.hash = "#/clientes" + (p.toString() ? "?" + p : "");
    };
    toolbar.addEventListener("submit", (e) => {
      e.preventDefault();
      go();
    });
    filter.addEventListener("change", go);

    const err = errorBox();
    const newForm = h(
      "form",
      { class: "card" },
      h("h2", { style: null }, "Nuevo cliente"),
      h(
        "div",
        { class: "form-grid" },
        h("div", {}, h("label", { for: "nc-name" }, "Nombre"), h("input", { id: "nc-name", name: "name", required: true, maxlength: 120 })),
        h("div", {}, h("label", { for: "nc-phone" }, "Teléfono (10 dígitos)"), h("input", { id: "nc-phone", name: "phone", inputmode: "tel", maxlength: 20 })),
      ),
      h("div", { class: "field" }, h("label", { for: "nc-notes" }, "Notas"), h("textarea", { id: "nc-notes", name: "notes", maxlength: 1000 })),
      err,
      h("button", { type: "submit" }, "Registrar cliente"),
    );
    newForm.addEventListener("submit", (e) => {
      e.preventDefault();
      submitting(newForm, async () => {
        try {
          const r = await api("POST", "/api/admin/clients", formData(newForm));
          toast("Cliente registrado");
          location.hash = "#/cliente/" + r.client.id;
        } catch (e2) {
          showError(err, e2);
        }
      });
    });

    setView(h("h1", {}, "Clientes"), toolbar, listBox, newForm);
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (status) qs.set("status", status);
    const data = await api("GET", "/api/admin/clients?" + qs);
    listBox.replaceChildren(
      h("p", { class: "muted small" }, data.clients.length + " cuenta(s)"),
      data.clients.length ? clientList(data.clients) : h("p", { class: "muted" }, "Sin resultados."),
    );
  }

  // ---------- detalle de cliente ----------
  async function viewClient(id) {
    const d = await api("GET", "/api/admin/clients/" + encodeURIComponent(id));
    const c = d.client;
    const t = today();
    const activePurchases = d.purchases.filter((p) => p.status === "active");

    setView(
      h("p", { class: "no-print" }, h("a", { href: "#/clientes" }, "← Clientes")),
      h("div", { class: "print-only" }, h("h2", {}, "BLOOM · Estado de cuenta"), h("p", { class: "muted" }, "Generado el " + fdate(t))),
      h("h1", {}, c.name, " ", badge(c.status)),
      h("p", { class: "muted" }, c.phone ? "Tel. " + c.phone : "Sin teléfono", c.notes ? " · " + c.notes : ""),
      h(
        "div",
        { class: "grid" },
        tile("Total de compras", money(c.purchases_cents)),
        tile("Total abonado", money(c.paid_cents)),
        tile("Saldo pendiente", money(Math.max(c.balance_cents, 0)), true),
        c.next_due_date ? tile("Fecha límite" + (c.next_due_date < t ? " (vencida)" : ""), fdate(c.next_due_date)) : null,
      ),
      h(
        "div",
        { class: "actions no-print" },
        h("button", { type: "button", onclick: () => window.print() }, "Imprimir / PDF estado de cuenta"),
        h("button", { type: "button", class: "secondary", onclick: () => editClient(c) }, "Editar datos"),
      ),
      linkSection(c, d.link),
      paymentForm(c, activePurchases),
      purchaseForm(c),
      h("h2", {}, "Abonos"),
      paymentsTable(c, d.payments, d.purchases),
      h("h2", {}, "Compras"),
      d.purchases.length ? d.purchases.map((p) => purchaseCard(c, p)) : h("p", { class: "muted" }, "Sin compras registradas."),
      h("h2", { class: "no-print" }, "Historial de operaciones"),
      auditBox(c.id),
    );
  }

  function linkSection(c, link) {
    const box = h("section", { class: "card no-print" }, h("h2", { style: null }, "Enlace privado del cliente"));
    box.append(
      h(
        "p",
        { class: "notice" },
        "El enlace funciona como una contraseña: cualquier persona que lo tenga puede ver esta cuenta. Envíalo solo al cliente. Si se comparte por error, revócalo de inmediato.",
      ),
    );
    if (link.active && link.url) {
      const wa = waNumber(c.phone);
      const msg = `Hola ${c.name}, este es tu enlace privado para consultar tu estado de cuenta en BLOOM: ${link.url}\nNo lo compartas con nadie.`;
      box.append(
        h("div", { class: "linkbox" }, h("code", {}, link.url)),
        h("p", { class: "muted small" }, "Creado: " + fdatetime(link.created_at) + (link.last_used_at ? " · Último acceso: " + fdatetime(link.last_used_at) : " · Aún sin abrir")),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", onclick: () => copy(link.url) }, "Copiar enlace"),
          wa
            ? h("a", { class: "btn secondary", href: "https://wa.me/" + wa + "?text=" + encodeURIComponent(msg), target: "_blank", rel: "noopener noreferrer" }, "Enviar por WhatsApp")
            : h("button", { type: "button", class: "secondary", onclick: () => copy(msg) }, "Copiar mensaje"),
          h("button", { type: "button", class: "secondary", onclick: () => regenerate(c) }, "Regenerar"),
          h("button", { type: "button", class: "danger", onclick: () => revoke(c) }, "Revocar"),
        ),
      );
    } else if (link.active) {
      box.append(
        h("p", {}, "Hay un enlace activo, pero no se puede mostrar (la clave del servidor cambió). Regenera el enlace para obtener uno nuevo."),
        h("div", { class: "actions" }, h("button", { type: "button", onclick: () => regenerate(c) }, "Regenerar enlace"), h("button", { type: "button", class: "danger", onclick: () => revoke(c) }, "Revocar")),
      );
    } else {
      box.append(h("p", {}, "Este cliente no tiene un enlace activo."), h("button", { type: "button", onclick: () => regenerate(c) }, "Generar enlace"));
    }
    return box;
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copiado al portapapeles");
    } catch {
      window.prompt("Copia el texto:", text);
    }
  }

  async function regenerate(c) {
    const ok = await confirmDialog({
      title: "Generar un enlace nuevo",
      message: "El enlace anterior dejará de funcionar inmediatamente. Tendrás que enviar el nuevo al cliente.",
      confirmText: "Generar",
    });
    if (!ok) return;
    try {
      await api("POST", `/api/admin/clients/${c.id}/link/regenerate`, {});
      toast("Enlace nuevo generado");
      route();
    } catch (e) {
      toast(e.message);
    }
  }

  async function revoke(c) {
    const ok = await confirmDialog({
      title: "Revocar enlace",
      message: "El cliente ya no podrá consultar su cuenta con el enlace actual.",
      confirmText: "Revocar",
      danger: true,
    });
    if (!ok) return;
    try {
      await api("POST", `/api/admin/clients/${c.id}/link/revoke`, {});
      toast("Enlace revocado");
      route();
    } catch (e) {
      toast(e.message);
    }
  }

  async function editClient(c) {
    const data = await confirmDialog({
      title: "Editar cliente",
      fields: [
        h("div", { class: "field" }, h("label", {}, "Nombre"), h("input", { name: "name", required: true, maxlength: 120, value: c.name })),
        h("div", { class: "field" }, h("label", {}, "Teléfono"), h("input", { name: "phone", inputmode: "tel", maxlength: 20, value: c.phone })),
        h("div", { class: "field" }, h("label", {}, "Notas"), (() => { const t = h("textarea", { name: "notes", maxlength: 1000 }); t.value = c.notes; return t; })()),
      ],
      confirmText: "Guardar",
    });
    if (!data) return;
    try {
      await api("PATCH", "/api/admin/clients/" + c.id, data);
      toast("Datos actualizados");
      route();
    } catch (e) {
      toast(e.message);
    }
  }

  function paymentFields(activePurchases, defaults = {}) {
    return [
      h(
        "div",
        { class: "form-grid" },
        h("div", {}, h("label", {}, "Importe (MXN)"), h("input", { name: "amount", required: true, inputmode: "decimal", pattern: "^\\$?[0-9]{1,3}(,?[0-9]{3})*(\\.[0-9]{1,2})?$", placeholder: "0.00", value: defaults.amount || "" })),
        h("div", {}, h("label", {}, "Fecha"), h("input", { name: "paid_at", type: "date", required: true, value: defaults.paid_at || today() })),
        h(
          "div",
          {},
          h("label", {}, "Método"),
          h("select", { name: "method", required: true }, METHODS.map(([v, l]) => h("option", { value: v, selected: v === (defaults.method || "efectivo") }, l))),
        ),
        h(
          "div",
          {},
          h("label", {}, "Aplicar a"),
          h(
            "select",
            { name: "purchase_id" },
            h("option", { value: "" }, "Cuenta general"),
            activePurchases.map((p) =>
              h("option", { value: p.id, selected: p.id === defaults.purchase_id }, "Compra " + fdate(p.purchase_date) + " · resta " + money(p.total_cents - p.paid_cents)),
            ),
          ),
        ),
      ),
      h("div", { class: "field" }, h("label", {}, "Nota (opcional)"), h("input", { name: "note", maxlength: 300, value: defaults.note || "" })),
    ];
  }

  function paymentForm(c, activePurchases) {
    const err = errorBox();
    const form = h("form", { class: "card no-print" }, h("h2", { style: null }, "Registrar abono"), paymentFields(activePurchases), err, h("button", { type: "submit", disabled: c.balance_cents <= 0 }, "Registrar abono"));
    if (c.balance_cents <= 0) form.append(h("p", { class: "muted small" }, "La cuenta no tiene saldo pendiente."));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submitting(form, async () => {
        try {
          await api("POST", `/api/admin/clients/${c.id}/payments`, formData(form));
          toast("Abono registrado");
          route();
        } catch (e2) {
          showError(err, e2);
        }
      });
    });
    return form;
  }

  function itemRow() {
    const row = h(
      "div",
      { class: "item-row" },
      h("div", { class: "desc" }, h("label", {}, "Prenda"), h("input", { name: "description", required: true, maxlength: 200, placeholder: "Vestido floral" })),
      h("div", {}, h("label", {}, "Talla"), h("input", { name: "size", maxlength: 30 })),
      h("div", {}, h("label", {}, "Cant."), h("input", { name: "quantity", type: "number", min: 1, max: 1000, value: 1, required: true })),
      h("div", {}, h("label", {}, "Precio unitario"), h("input", { name: "unit_price", required: true, inputmode: "decimal", placeholder: "0.00" })),
      h("button", { type: "button", class: "ghost", "aria-label": "Quitar prenda", onclick: () => { if (row.parentElement.children.length > 1) row.remove(); } }, "✕"),
    );
    return row;
  }

  function purchaseForm(c) {
    const err = errorBox();
    const items = h("div", {}, itemRow());
    const form = h(
      "form",
      { class: "card no-print" },
      h("h2", { style: null }, "Registrar compra"),
      h(
        "div",
        { class: "form-grid" },
        h("div", {}, h("label", {}, "Fecha de compra"), h("input", { name: "purchase_date", type: "date", required: true, value: today() })),
        h("div", {}, h("label", {}, "Fecha límite de pago (opcional)"), h("input", { name: "due_date", type: "date" })),
        h("div", {}, h("label", {}, "Descuento (MXN)"), h("input", { name: "discount", inputmode: "decimal", placeholder: "0.00" })),
      ),
      h("h3", { style: null }, "Prendas"),
      items,
      h("button", { type: "button", class: "secondary small", onclick: () => items.append(itemRow()) }, "+ Agregar prenda"),
      h("div", { class: "field" }, h("label", {}, "Notas (opcional)"), h("input", { name: "notes", maxlength: 500 })),
      err,
      h("button", { type: "submit" }, "Guardar compra"),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const f = formData(form);
      const payload = {
        purchase_date: f.purchase_date,
        due_date: f.due_date || null,
        discount: f.discount || "0",
        notes: f.notes,
        items: [...items.querySelectorAll(".item-row")].map((r) => ({
          description: r.querySelector("[name=description]").value,
          size: r.querySelector("[name=size]").value,
          quantity: Number(r.querySelector("[name=quantity]").value),
          unit_price: r.querySelector("[name=unit_price]").value,
        })),
      };
      submitting(form, async () => {
        try {
          await api("POST", `/api/admin/clients/${c.id}/purchases`, payload);
          toast("Compra registrada");
          route();
        } catch (e2) {
          showError(err, e2);
        }
      });
    });
    return form;
  }

  function paymentsTable(c, payments, purchases) {
    if (!payments.length) return h("p", { class: "muted" }, "Sin abonos.");
    const activePurchases = purchases.filter((p) => p.status === "active");
    return h(
      "div",
      { class: "card table-scroll" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, "Fecha"), h("th", {}, "Método"), h("th", { class: "hide-sm" }, "Nota"), h("th", { class: "num" }, "Importe"), h("th", { class: "no-print" }, ""))),
        h(
          "tbody",
          {},
          payments.map((y) =>
              h(
                "tr",
                { class: y.status === "voided" ? "voided no-print" : "" },
                h("td", {}, fdate(y.paid_at)),
                h("td", {}, methodLabel(y.method)),
                h("td", { class: "hide-sm" }, y.note, y.status === "voided" ? h("div", { class: "small keep" }, "Anulado: " + (y.void_reason || "")) : null),
                h("td", { class: "num" }, money(y.amount_cents)),
                h(
                  "td",
                  { class: "no-print keep" },
                  y.status === "valid"
                    ? [
                        h("button", { type: "button", class: "secondary small", onclick: () => correctPayment(y, activePurchases) }, "Corregir"),
                        " ",
                        h("button", { type: "button", class: "danger small", onclick: () => voidPayment(y) }, "Anular"),
                      ]
                    : null,
                ),
              ),
            ),
        ),
      ),
    );
  }

  const reasonField = () => h("div", { class: "field" }, h("label", {}, "Motivo (queda en la auditoría)"), h("input", { name: "reason", required: true, minlength: 3, maxlength: 300 }));

  async function voidPayment(y) {
    const data = await confirmDialog({ title: "Anular abono de " + money(y.amount_cents), message: "El saldo del cliente aumentará en ese importe.", fields: [reasonField()], confirmText: "Anular", danger: true });
    if (!data) return;
    try {
      await api("POST", `/api/admin/payments/${y.id}/void`, data);
      toast("Abono anulado");
      route();
    } catch (e) {
      toast(e.message);
    }
  }

  async function correctPayment(y, activePurchases) {
    const data = await confirmDialog({
      title: "Corregir abono",
      message: "Se anulará el abono original y se registrará el correcto en una sola operación auditada.",
      fields: [paymentFields(activePurchases, { amount: (y.amount_cents / 100).toFixed(2), paid_at: y.paid_at, method: y.method, note: y.note, purchase_id: y.purchase_id }), reasonField()],
      confirmText: "Guardar corrección",
    });
    if (!data) return;
    try {
      await api("POST", `/api/admin/payments/${y.id}/correct`, data);
      toast("Abono corregido");
      route();
    } catch (e) {
      toast(e.message);
    }
  }

  function purchaseCard(c, p, readonly = false) {
    const cancelled = p.status === "cancelled";
    return h(
      "article",
      { class: "card" + (cancelled ? " no-print" : "") },
      h(
        "div",
        { class: "toolbar", style: null },
        h("strong", {}, "Compra del " + fdate(p.purchase_date)),
        cancelled ? h("span", { class: "badge sin_compras" }, "Cancelada") : null,
        p.due_date ? h("span", { class: "muted small" }, "Fecha límite: " + fdate(p.due_date)) : null,
        h("span", { style: null, class: "num", }, money(p.total_cents)),
      ),
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, h("th", {}, "Prenda"), h("th", {}, "Talla"), h("th", { class: "num" }, "Cant."), h("th", { class: "num" }, "P. unit."), h("th", { class: "num" }, "Importe"))),
          h(
            "tbody",
            { class: cancelled ? "" : "" },
            p.items.map((i) => h("tr", { class: cancelled ? "cancelled" : "" }, h("td", {}, i.description), h("td", {}, i.size), h("td", { class: "num" }, i.quantity), h("td", { class: "num" }, money(i.unit_price_cents)), h("td", { class: "num" }, money(i.line_total_cents)))),
          ),
          h(
            "tfoot",
            {},
            p.discount_cents ? h("tr", {}, h("td", { colspan: 4 }, "Descuento"), h("td", { class: "num" }, "−" + money(p.discount_cents))) : null,
            h("tr", {}, h("td", { colspan: 4 }, h("strong", {}, "Total")), h("td", { class: "num" }, h("strong", {}, money(p.total_cents)))),
            !cancelled ? h("tr", {}, h("td", { colspan: 4 }, "Abonado a esta compra"), h("td", { class: "num" }, money(p.paid_cents))) : null,
          ),
        ),
      ),
      p.notes ? h("p", { class: "muted small" }, p.notes) : null,
      cancelled
        ? h("p", { class: "muted small" }, "Cancelada" + (p.cancelled_at ? " el " + fdatetime(p.cancelled_at) : "") + ": " + (p.cancel_reason || ""))
        : readonly
          ? null
          : h("div", { class: "actions no-print" }, h("button", { type: "button", class: "danger small", onclick: () => cancelPurchase(p) }, "Cancelar compra")),
    );
  }

  async function cancelPurchase(p) {
    const data = await confirmDialog({
      title: "Cancelar compra de " + money(p.total_cents),
      message: "La compra dejará de sumar al saldo. Si tiene abonos asociados, anúlalos primero.",
      fields: [reasonField()],
      confirmText: "Cancelar compra",
      danger: true,
    });
    if (!data) return;
    try {
      await api("POST", `/api/admin/purchases/${p.id}/cancel`, data);
      toast("Compra cancelada");
      route();
    } catch (e) {
      toast(e.message);
    }
  }

  const ACTIONS = {
    login: "Inicio de sesión",
    login_fallido: "Intento de acceso fallido",
    logout: "Cierre de sesión",
    cambio_contrasena: "Cambio de contraseña",
    cliente_creado: "Cliente registrado",
    cliente_editado: "Cliente editado",
    enlace_regenerado: "Enlace regenerado",
    enlace_revocado: "Enlace revocado",
    compra_registrada: "Compra registrada",
    compra_cancelada: "Compra cancelada",
    abono_registrado: "Abono registrado",
    abono_anulado: "Abono anulado",
    abono_corregido: "Abono corregido",
  };

  function auditDetail(e) {
    let d = {};
    try {
      d = JSON.parse(e.details || "{}");
    } catch {}
    const parts = [];
    if (d.amount_cents !== undefined) parts.push(money(d.amount_cents));
    if (d.total_cents !== undefined) parts.push("Total " + money(d.total_cents));
    if (d.old_amount_cents !== undefined) parts.push(money(d.old_amount_cents) + " → " + money(d.new_amount_cents));
    if (d.reason) parts.push("Motivo: " + d.reason);
    if (d.username) parts.push("Usuario: " + d.username);
    if (d.name) parts.push(d.name);
    return parts.join(" · ");
  }

  function auditTable(entries) {
    if (!entries.length) return h("p", { class: "muted" }, "Sin registros.");
    return h(
      "div",
      { class: "card table-scroll" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, "Fecha"), h("th", {}, "Operación"), h("th", {}, "Detalle"), h("th", { class: "hide-sm" }, "Usuario"))),
        h("tbody", {}, entries.map((e) => h("tr", {}, h("td", {}, fdatetime(e.created_at)), h("td", {}, ACTIONS[e.action] || e.action), h("td", {}, auditDetail(e)), h("td", { class: "hide-sm" }, e.username || "—")))),
      ),
    );
  }

  function auditBox(clientId) {
    const box = h("div", { class: "no-print" }, h("p", { class: "muted" }, "Cargando…"));
    api("GET", "/api/admin/audit?limit=50&entity_id=" + encodeURIComponent(clientId))
      .then((d) => box.replaceChildren(auditTable(d.entries), h("p", {}, h("a", { href: "#/auditoria/" + clientId }, "Ver historial completo por fechas →"))))
      .catch(() => box.replaceChildren(h("p", { class: "muted" }, "No se pudo cargar.")));
    return box;
  }

  // ---------- auditoría: recuadros por cliente → historial por fechas → detalle ----------
  const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
  const dayLongFmt = new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const timeFmt = new Intl.DateTimeFormat("es-MX", { timeStyle: "short" });
  const tsDate = (d) => new Date(d.slice(0, 24));
  const dayKey = (d) => dayKeyFmt.format(tsDate(d));
  const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  async function viewAudit() {
    const d = await api("GET", "/api/admin/audit/clients");
    const search = h("input", { type: "search", placeholder: "Buscar cliente", "aria-label": "Buscar cliente" });
    const grid = h("div", { class: "audit-grid" });
    const card = (href, title, sub, entries, lastAt) =>
      h(
        "a",
        { class: "audit-card", href },
        h("strong", {}, title),
        h("span", { class: "muted small" }, sub),
        h("span", { class: "audit-count" }, entries + (entries === 1 ? " operación" : " operaciones")),
        h("span", { class: "muted small" }, lastAt ? "Última: " + fdatetime(lastAt) : "Sin movimientos"),
      );
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const list = d.clients.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.phone || "").includes(q));
      grid.replaceChildren(...list.map((c) => card("#/auditoria/" + c.id, c.name, c.phone || "Sin teléfono", c.entries, c.last_at)));
      if (!q) grid.append(card("#/auditoria/sistema", "Sistema", "Accesos y contraseñas", d.system.entries, d.system.last_at));
      if (!grid.children.length) grid.append(h("p", { class: "muted" }, "Sin resultados."));
    };
    search.addEventListener("input", render);
    render();
    setView(
      h("h1", {}, "Auditoría"),
      h("p", { class: "muted" }, "Elige un cliente para ver su historial. Este registro no se puede editar ni borrar."),
      h("div", { class: "toolbar" }, search),
      grid,
    );
  }

  const owed = (p) => Math.max(p.total_cents - p.paid_cents, 0);
  const PURCHASE_BOXES = [
    ["hechas", "Compras hechas", "No canceladas", (p) => p.status === "active"],
    ["canceladas", "Compras canceladas", "Ya no suman al saldo", (p) => p.status === "cancelled"],
    ["apartados", "Sin abono o apartados", "Aún deben algo", (p) => p.status === "active" && owed(p) > 0],
    ["todas", "Compras", "Todas, incluidas canceladas", () => true],
  ];
  const isPhone = () => window.matchMedia("(max-width: 640px)").matches;

  function purchaseGroups(purchases, inRange = () => true) {
    return PURCHASE_BOXES.map(([key, label, sub, pick]) => {
      const ps = purchases.filter((p) => pick(p) && inRange(p.purchase_date));
      const amount = key === "apartados" ? "Deben " + money(ps.reduce((n, p) => n + owed(p), 0)) : money(ps.reduce((n, p) => n + p.total_cents, 0));
      return { key, label, sub, ps, amount };
    });
  }

  function purchaseRow(client, p) {
    const cancelled = p.status === "cancelled";
    const pieces = p.items.reduce((n, i) => n + i.quantity, 0);
    return h(
      "details",
      { class: "purchase-row" + (cancelled ? " is-cancelled" : "") },
      h(
        "summary",
        {},
        h("span", { class: "audit-what" }, h("strong", {}, "Compra del " + fdate(p.purchase_date)), h("span", { class: "muted small" }, pieces + (pieces === 1 ? " prenda" : " prendas") + (cancelled ? " · Cancelada" : owed(p) > 0 ? " · Debe " + money(owed(p)) : " · Pagada"))),
        h("strong", { class: "num" }, money(p.total_cents)),
      ),
      purchaseCard(client, p, true),
    );
  }

  function purchaseSection(client, g) {
    return h(
      "section",
      { class: "card purchase-box" },
      h("div", { class: "purchase-box-head" }, h("h2", {}, g.label, h("span", { class: "muted small" }, " (" + g.ps.length + ")")), h("strong", { class: "num" }, g.amount)),
      g.ps.length ? g.ps.map((p) => purchaseRow(client, p)) : h("p", { class: "muted" }, "Sin compras."),
    );
  }

  // Pantalla propia de un recuadro de compras (la que se abre en el celular).
  async function viewAuditPurchases(cid, key) {
    const acct = await api("GET", "/api/admin/clients/" + encodeURIComponent(cid));
    const g = purchaseGroups(acct.purchases).find((x) => x.key === key);
    if (!g) {
      location.hash = "#/auditoria/" + cid;
      return;
    }
    setView(h("p", {}, h("a", { href: "#/auditoria/" + cid }, "← " + acct.client.name)), h("h1", {}, g.label), h("p", { class: "muted" }, g.sub), purchaseSection(acct.client, g));
  }

  async function viewAuditClient(cid) {
    const [d, acct] = await Promise.all([
      api("GET", "/api/admin/audit?limit=500&entity_id=" + encodeURIComponent(cid)),
      cid === "sistema" ? null : api("GET", "/api/admin/clients/" + encodeURIComponent(cid)).catch(() => null),
    ]);
    const title = cid === "sistema" ? "Sistema" : d.client ? d.client.name : "Cliente eliminado";
    const purchases = acct ? acct.purchases : [];
    let open = null;
    const boxes = h("div", {});
    const from = h("input", { type: "date", "aria-label": "Desde" });
    const to = h("input", { type: "date", "aria-label": "Hasta" });
    const clear = h("button", { type: "button", class: "ghost small" }, "Quitar filtro");
    const list = h("div", {});
    const inRange = (k) => (!from.value || k >= from.value) && (!to.value || k <= to.value);
    const renderBoxes = () => {
      const groups = purchaseGroups(purchases, inRange);
      const grid = h(
        "div",
        { class: "audit-grid" },
        groups.map((g) =>
          h(
            "button",
            {
              type: "button",
              class: "audit-card" + (open === g.key ? " selected" : ""),
              "aria-expanded": String(open === g.key),
              onclick: () => {
                // En el celular la lista quedaría fuera de la pantalla: se abre en su propia pantalla.
                if (isPhone()) return void (location.hash = "#/auditoria/" + cid + "/compras/" + g.key);
                open = open === g.key ? null : g.key;
                renderBoxes();
              },
            },
            h("strong", {}, g.label),
            h("span", { class: "muted small" }, g.sub),
            h("span", { class: "audit-count" }, g.ps.length + (g.ps.length === 1 ? " compra" : " compras")),
            h("span", { class: "muted small" }, g.amount),
          ),
        ),
      );
      const sel = groups.find((g) => g.key === open);
      boxes.replaceChildren(
        grid,
        ...(sel ? [purchaseSection(d.client, sel)] : []),
      );
    };
    const render = () => {
      if (acct) renderBoxes();
      const entries = d.entries.filter((e) => {
        const k = dayKey(e.created_at);
        return (!from.value || k >= from.value) && (!to.value || k <= to.value);
      });
      const days = new Map();
      for (const e of entries) {
        const k = dayKey(e.created_at);
        if (!days.has(k)) days.set(k, []);
        days.get(k).push(e);
      }
      if (!entries.length) return list.replaceChildren(h("p", { class: "muted" }, "Sin operaciones en esas fechas."));
      list.replaceChildren(
        ...[...days].flatMap(([, items]) => [
          h("h2", { class: "audit-day" }, capital(dayLongFmt.format(tsDate(items[0].created_at))), h("span", { class: "muted small" }, " · " + items.length)),
          h(
            "div",
            { class: "card audit-entries" },
            items.map((e) =>
              h(
                "a",
                { class: "audit-entry", href: "#/auditoria/" + cid + "/" + e.id },
                h("span", { class: "audit-time" }, timeFmt.format(tsDate(e.created_at))),
                h("span", { class: "audit-what" }, h("strong", {}, ACTIONS[e.action] || e.action), h("span", { class: "muted small" }, auditDetail(e))),
                h("span", { class: "muted small hide-sm" }, e.username || "—"),
                h("span", { class: "audit-go", "aria-hidden": "true" }, "›"),
              ),
            ),
          ),
        ]),
      );
    };
    [from, to].forEach((i) => i.addEventListener("change", render));
    clear.addEventListener("click", () => {
      from.value = to.value = "";
      render();
    });
    render();
    setView(
      h("p", {}, h("a", { href: "#/auditoria" }, "← Auditoría")),
      h("h1", {}, title),
      d.client ? h("p", {}, h("a", { href: "#/cliente/" + d.client.id }, "Ver cuenta del cliente")) : null,
      h("div", { class: "toolbar" }, h("label", { class: "inline" }, "Desde ", from), h("label", { class: "inline" }, "Hasta ", to), clear),
      boxes,
      acct ? h("h2", {}, "Historial por fechas") : null,
      list,
    );
  }

  const FIELD_LABELS = { name: "Nombre", phone: "Teléfono", notes: "Notas" };

  async function viewAuditEntry(cid, eid) {
    const d = await api("GET", "/api/admin/audit/entry/" + encodeURIComponent(eid));
    const e = d.entry;
    let det = {};
    try {
      det = JSON.parse(e.details || "{}");
    } catch {}
    const row = (k, v) => (v === null || v === undefined || v === "" ? null : [h("dt", {}, k), h("dd", {}, v)]);
    const sections = [];

    if (e.action === "cliente_editado" && det.before && det.after) {
      const changed = Object.keys(FIELD_LABELS).filter((k) => (det.before[k] || "") !== (det.after[k] || ""));
      sections.push(
        h("h2", {}, "Cambios"),
        changed.length
          ? h(
              "div",
              { class: "card table-scroll" },
              h(
                "table",
                {},
                h("thead", {}, h("tr", {}, h("th", {}, "Dato"), h("th", {}, "Antes"), h("th", {}, "Después"))),
                h("tbody", {}, changed.map((k) => h("tr", {}, h("td", {}, FIELD_LABELS[k]), h("td", {}, det.before[k] || "—"), h("td", {}, det.after[k] || "—")))),
              ),
            )
          : h("p", { class: "muted" }, "Se guardó sin cambios."),
      );
    }

    if (d.purchase) {
      const p = d.purchase;
      sections.push(
        h("h2", {}, "Compra"),
        h(
          "div",
          { class: "card" },
          h(
            "dl",
            { class: "kv" },
            row("Fecha de compra", fdate(p.purchase_date)),
            row("Fecha límite", p.due_date ? fdate(p.due_date) : null),
            row("Estado actual", p.status === "cancelled" ? "Cancelada" : "Activa"),
            row("Motivo de cancelación", p.cancel_reason),
            row("Notas", p.notes),
          ),
          h(
            "div",
            { class: "table-scroll" },
            h(
              "table",
              {},
              h("thead", {}, h("tr", {}, h("th", {}, "Prenda"), h("th", {}, "Talla"), h("th", { class: "num" }, "Cant."), h("th", { class: "num" }, "Precio"), h("th", { class: "num" }, "Importe"))),
              h(
                "tbody",
                {},
                p.items.map((it) =>
                  h("tr", {}, h("td", {}, it.description), h("td", {}, it.size || "—"), h("td", { class: "num" }, it.quantity), h("td", { class: "num" }, money(it.unit_price_cents)), h("td", { class: "num" }, money(it.line_total_cents))),
                ),
              ),
            ),
          ),
          h("dl", { class: "kv" }, row("Subtotal", money(p.subtotal_cents)), p.discount_cents ? row("Descuento", "− " + money(p.discount_cents)) : null, row("Total", h("strong", {}, money(p.total_cents)))),
        ),
      );
    }

    if (d.payment) {
      const y = d.payment;
      sections.push(
        h("h2", {}, "Abono"),
        h(
          "div",
          { class: "card" },
          h(
            "dl",
            { class: "kv" },
            row("Importe", h("strong", {}, money(y.amount_cents))),
            row("Fecha del pago", fdate(y.paid_at)),
            row("Forma de pago", methodLabel(y.method)),
            row("Aplicado a", y.purchase_date ? "Compra del " + fdate(y.purchase_date) + " (" + money(y.purchase_total_cents) + ")" : "Saldo general"),
            row("Nota", y.note),
            row("Estado actual", y.status === "voided" ? "Anulado" : "Válido"),
            row("Motivo de anulación", y.void_reason),
          ),
        ),
      );
    }

    setView(
      h("p", {}, h("a", { href: "#/auditoria/" + cid }, "← Historial")),
      h("h1", {}, ACTIONS[e.action] || e.action),
      h(
        "div",
        { class: "card" },
        h(
          "dl",
          { class: "kv" },
          row("Fecha", capital(dayLongFmt.format(tsDate(e.created_at)))),
          row("Hora", timeFmt.format(tsDate(e.created_at))),
          row("Cliente", d.client ? h("a", { href: "#/cliente/" + d.client.id }, d.client.name) : null),
          row("Realizado por", e.display_name ? e.display_name + " (" + e.username + ")" : e.username || "—"),
          row("Importe anterior", det.old_amount_cents !== undefined ? money(det.old_amount_cents) : null),
          row("Importe nuevo", det.new_amount_cents !== undefined ? money(det.new_amount_cents) : null),
          row("Motivo", det.reason),
          row("Usuario intentado", e.action === "login_fallido" ? det.username : null),
          row("Nombre registrado", e.action === "cliente_creado" ? det.name : null),
          row("Teléfono registrado", e.action === "cliente_creado" ? det.phone : null),
        ),
      ),
      sections,
    );
  }

  function viewAccount() {
    const err = errorBox();
    const form = h(
      "form",
      { class: "card" },
      h("h2", { style: null }, "Cambiar contraseña"),
      h("div", { class: "field" }, h("label", {}, "Contraseña actual"), h("input", { name: "current", type: "password", required: true, autocomplete: "current-password" })),
      h("div", { class: "field" }, h("label", {}, "Nueva contraseña (mínimo 12 caracteres)"), h("input", { name: "next", type: "password", required: true, minlength: 12, autocomplete: "new-password" })),
      err,
      h("button", { type: "submit" }, "Actualizar"),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submitting(form, async () => {
        try {
          await api("POST", "/api/auth/password", formData(form));
          form.reset();
          toast("Contraseña actualizada. Las demás sesiones se cerraron.");
        } catch (e2) {
          showError(err, e2);
        }
      });
    });
    setView(h("h1", {}, "Mi cuenta"), h("p", {}, "Sesión iniciada como ", h("strong", {}, state.admin ? state.admin.display_name : "")), form);
  }

  // ---------- router ----------
  async function route() {
    if (!state.csrf) {
      try {
        const s = await api("GET", "/api/auth/session");
        state.csrf = s.csrfToken;
        state.admin = s.admin;
      } catch (e) {
        // 401: renderLogin ya se mostró. Otro error (p. ej. configuración pendiente): mostrarlo.
        if (e.status !== 401) setView(h("div", { class: "login" }, h("div", { class: "card" }, h("h2", {}, "BLOOM"), h("p", { class: "error" }, e.message))));
        return;
      }
    }
    topbar.hidden = false;
    markNav();
    const hash = location.hash || "#/";
    try {
      if (hash === "#/" || hash === "#") await viewDashboard();
      else if (hash.startsWith("#/clientes")) await viewClients();
      else if (hash.startsWith("#/cliente/")) await viewClient(hash.slice("#/cliente/".length));
      else if (hash.startsWith("#/auditoria")) {
        const [cid, eid, key] = hash.slice("#/auditoria".length).split("/").filter(Boolean).map(decodeURIComponent);
        if (eid === "compras" && key) await viewAuditPurchases(cid, key);
        else if (eid) await viewAuditEntry(cid, eid);
        else if (cid) await viewAuditClient(cid);
        else await viewAudit();
      }
      else if (hash.startsWith("#/cuenta")) viewAccount();
      else location.hash = "#/";
    } catch (e) {
      if (e.status === 401) return;
      setView(h("p", { class: "error" }, e.message || "Error"), h("a", { href: "#/" }, "Volver al resumen"));
    }
  }

  window.addEventListener("hashchange", route);
  route();
})();
