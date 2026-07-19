// @ts-nocheck
"use client";

/**
 * Puck block "RestaurantMenu" v2 — full restaurant experience with online ordering.
 *
 * Registered via manifest.frontend.puckComponents; the generated registry composes
 * { ...puckComponentDef, render: default export }, so puckComponentDef must NOT carry a render.
 * Runs in the editor iframe AND on the public page: data arrives via client-mount fetches against
 * the plugin's PUBLIC endpoints, guarded with res.ok (an inactive plugin 404s — the block degrades
 * to a quiet placeholder instead of crashing the page).
 *
 * v2: dish modifiers (picker modal, server re-prices everything), es/en menu + allergen chips,
 * opening-hours awareness (closed banner + rejected orders), table mode via ?rm_table= (QR),
 * Stripe Checkout (redirect + ?rm_order/?rm_session return verification), native reservations,
 * ETA + live order-status lookup. All prices are recomputed server-side; the client only sends
 * item ids, quantities and option ids.
 */

import React, { useEffect, useMemo, useState } from "react";

const BASE = "/api/v1/plugin/restaurant-menu";
const CART_KEY = "wjrm_cart_v2";

const TAG_META = {
    "vegano": { emoji: "🌱", es: "Vegano", en: "Vegan" },
    "picante": { emoji: "🌶️", es: "Picante", en: "Spicy" },
    "sin-gluten": { emoji: "🚫🌾", es: "Sin gluten", en: "Gluten-free" },
    "nuevo": { emoji: "✨", es: "Nuevo", en: "New" },
    "popular": { emoji: "⭐", es: "Popular", en: "Popular" },
};

const ALLERGEN_META = {
    "gluten": { emoji: "🌾", es: "Gluten", en: "Gluten" },
    "crustaceos": { emoji: "🦐", es: "Crustáceos", en: "Crustaceans" },
    "huevo": { emoji: "🥚", es: "Huevo", en: "Egg" },
    "pescado": { emoji: "🐟", es: "Pescado", en: "Fish" },
    "cacahuetes": { emoji: "🥜", es: "Cacahuetes", en: "Peanuts" },
    "soja": { emoji: "🫘", es: "Soja", en: "Soy" },
    "lacteos": { emoji: "🥛", es: "Lácteos", en: "Dairy" },
    "frutos-secos": { emoji: "🌰", es: "Frutos secos", en: "Tree nuts" },
    "apio": { emoji: "🥬", es: "Apio", en: "Celery" },
    "mostaza": { emoji: "🟡", es: "Mostaza", en: "Mustard" },
    "sesamo": { emoji: "⚪", es: "Sésamo", en: "Sesame" },
    "sulfitos": { emoji: "🍷", es: "Sulfitos", en: "Sulphites" },
    "altramuces": { emoji: "🫛", es: "Altramuces", en: "Lupin" },
    "moluscos": { emoji: "🐚", es: "Moluscos", en: "Molluscs" },
};

const STR = {
    es: {
        loading: "Cargando menú…", unavailable: "El menú no está disponible en este momento.",
        emptyMenu: "El menú aún no tiene platos — configúralo en Admin → Restaurante.",
        viewOrder: "Ver pedido", yourOrder: "Tu pedido", yourInfo: "Tus datos", orderSent: "Pedido enviado",
        emptyCart: "Tu carrito está vacío — agrega platos con el botón +.",
        note: "Nota (ej. sin cebolla)", remove: "Quitar", subtotal: "Subtotal", total: "Total",
        deliveryFee: "Envío", continueBtn: "Continuar", keepBrowsing: "Seguir viendo el menú",
        name: "Nombre", phone: "Teléfono", delivery: "Entrega", address: "Dirección",
        addressPh: "Calle, número, referencias", notes: "Notas (opcional)",
        notesPh: "Alguna indicación para el restaurante", confirm: "Confirmar pedido",
        sending: "Enviando…", backToCart: "Volver al carrito", close: "Cerrar",
        registered: "¡Pedido registrado!", sendWa: "Enviar pedido por WhatsApp",
        waHint: "Envía el resumen por WhatsApp para confirmarlo con el restaurante.",
        kitchenHint: "Tu pedido llegó a la cocina.", ref: "Referencia", eta: "Tiempo estimado",
        payment: "Pago", payWa: "Coordinar por WhatsApp", payCash: "Pagar en el local",
        payCashTable: "Pagar en la mesa", payCard: "Pagar con tarjeta",
        table: "Mesa", tableBanner: "Estás pidiendo en la mesa", min: "min",
        closedTitle: "Estamos cerrados", hours: "Horario", reserve: "Reservar mesa",
        resName: "Nombre", resPhone: "Teléfono", resEmail: "Email (opcional)", resDate: "Fecha",
        resTime: "Hora", resParty: "Personas", resNotes: "Notas (opcional)", resSend: "Enviar reserva",
        resTitle: "Reservar mesa", resOk: "¡Reserva recibida!", checkStatus: "Actualizar estado",
        statusLabel: { new: "Recibido", preparing: "En preparación", ready: "¡Listo!", delivered: "Entregado", cancelled: "Cancelado" },
        payOk: "¡Pago confirmado!", payOkHint: "Tu pedido está pagado y en cocina.",
        payFail: "No pudimos confirmar el pago todavía.", payRetry: "Reintentar",
        errName: "Escribe tu nombre.", errPhone: "Escribe tu teléfono.", errAddress: "Escribe la dirección de entrega.",
        errEmpty: "El carrito está vacío.", errConn: "Error de conexión. Intenta de nuevo.",
        errSend: "No se pudo enviar el pedido. Intenta de nuevo.",
        chooseMin: "Elige al menos", chooseMax: "máximo", addFor: "Agregar",
        days: ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"], closedDay: "Cerrado",
    },
    en: {
        loading: "Loading menu…", unavailable: "The menu is unavailable right now.",
        emptyMenu: "The menu has no dishes yet.",
        viewOrder: "View order", yourOrder: "Your order", yourInfo: "Your details", orderSent: "Order sent",
        emptyCart: "Your cart is empty — add dishes with the + button.",
        note: "Note (e.g. no onion)", remove: "Remove", subtotal: "Subtotal", total: "Total",
        deliveryFee: "Delivery", continueBtn: "Continue", keepBrowsing: "Keep browsing",
        name: "Name", phone: "Phone", delivery: "Delivery", address: "Address",
        addressPh: "Street, number, references", notes: "Notes (optional)",
        notesPh: "Anything the restaurant should know", confirm: "Confirm order",
        sending: "Sending…", backToCart: "Back to cart", close: "Close",
        registered: "Order placed!", sendWa: "Send order via WhatsApp",
        waHint: "Send the summary via WhatsApp to confirm it with the restaurant.",
        kitchenHint: "Your order reached the kitchen.", ref: "Reference", eta: "Estimated time",
        payment: "Payment", payWa: "Arrange via WhatsApp", payCash: "Pay at the restaurant",
        payCashTable: "Pay at the table", payCard: "Pay by card",
        table: "Table", tableBanner: "You are ordering at table", min: "min",
        closedTitle: "We are closed", hours: "Opening hours", reserve: "Book a table",
        resName: "Name", resPhone: "Phone", resEmail: "Email (optional)", resDate: "Date",
        resTime: "Time", resParty: "Guests", resNotes: "Notes (optional)", resSend: "Send reservation",
        resTitle: "Book a table", resOk: "Reservation received!", checkStatus: "Refresh status",
        statusLabel: { new: "Received", preparing: "Being prepared", ready: "Ready!", delivered: "Delivered", cancelled: "Cancelled" },
        payOk: "Payment confirmed!", payOkHint: "Your order is paid and in the kitchen.",
        payFail: "We could not confirm the payment yet.", payRetry: "Retry",
        errName: "Enter your name.", errPhone: "Enter your phone.", errAddress: "Enter the delivery address.",
        errEmpty: "The cart is empty.", errConn: "Connection error. Try again.",
        errSend: "The order could not be sent. Try again.",
        chooseMin: "Choose at least", chooseMax: "max", addFor: "Add",
        days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], closedDay: "Closed",
    },
};

const STYLES = `
.wjrm { color: var(--wjs-color-text, #1f2937); font-family: var(--wjs-font-family-base, Georgia, 'Times New Roman', serif); }
.wjrm * { box-sizing: border-box; }
.wjrm-section { margin: 0 0 2.25rem; }
.wjrm-section-head { display: flex; align-items: center; gap: 1rem; margin: 0 0 1.1rem; }
.wjrm-section-title { font-size: 1.45rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; margin: 0; white-space: nowrap; }
.wjrm-section-rule { flex: 1; height: 1px; background: linear-gradient(90deg, currentColor, transparent); opacity: .25; }
.wjrm-empty { padding: 2rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, .5rem); font-size: .95rem; }
.wjrm-tags { display: inline-flex; gap: .3rem; flex-wrap: wrap; vertical-align: middle; }
.wjrm-tag { font-size: .68rem; line-height: 1; padding: .25rem .45rem; border-radius: 999px; background: var(--wjs-bg-surface, #f3f4f6); border: 1px solid var(--wjs-border-subtle, #e5e7eb); white-space: nowrap; font-family: system-ui, sans-serif; }
.wjrm-allergens { display: inline-flex; gap: .25rem; flex-wrap: wrap; vertical-align: middle; }
.wjrm-allergen { font-size: .66rem; line-height: 1; padding: .22rem .4rem; border-radius: 999px; background: #fffbeb; border: 1px solid #fde68a; color: #92400e; white-space: nowrap; font-family: system-ui, sans-serif; }
/* banners */
.wjrm-banner { display: flex; align-items: center; gap: .6rem; padding: .8rem 1rem; border-radius: var(--wjs-radius, .75rem); margin: 0 0 1.25rem; font-family: system-ui, sans-serif; font-size: .92rem; }
.wjrm-banner-table { background: #f5f3ff; border: 1px solid #ddd6fe; color: #5b21b6; font-weight: 700; }
.wjrm-banner-closed { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; flex-wrap: wrap; }
.wjrm-banner-closed strong { font-weight: 800; }
.wjrm-hours-toggle { border: none; background: none; cursor: pointer; color: inherit; font-weight: 700; text-decoration: underline; font-size: .82rem; padding: 0; }
.wjrm-hours { width: 100%; font-size: .82rem; margin-top: .4rem; }
.wjrm-hours div { display: flex; justify-content: space-between; gap: 1rem; padding: .1rem 0; }
/* top bar */
.wjrm-topbar { display: flex; align-items: center; justify-content: flex-end; gap: .6rem; margin: 0 0 1rem; font-family: system-ui, sans-serif; }
.wjrm-lang { display: inline-flex; border: 1px solid var(--wjs-border-subtle, #d1d5db); border-radius: 999px; overflow: hidden; }
.wjrm-lang button { border: none; background: transparent; padding: .35rem .7rem; cursor: pointer; font-size: .78rem; font-weight: 800; color: var(--wjs-color-text-muted, #6b7280); }
.wjrm-lang button.wjrm-lang-on { background: var(--wjs-color-primary, #111827); color: #fff; }
.wjrm-reserve-btn { border: 1px solid var(--wjs-color-primary, #111827); background: transparent; color: var(--wjs-color-text, #111827); border-radius: 999px; padding: .45rem .9rem; cursor: pointer; font-weight: 800; font-size: .82rem; }
.wjrm-reserve-btn:hover { background: var(--wjs-color-primary, #111827); color: #fff; }
/* list layout */
.wjrm-row { display: flex; align-items: baseline; gap: .5rem; padding: .55rem 0; }
.wjrm-row-name { font-weight: 700; font-size: 1.02rem; }
.wjrm-leader { flex: 1; border-bottom: 2px dotted rgba(128,128,128,.55); transform: translateY(-4px); min-width: 1.5rem; }
.wjrm-row-price { font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; }
.wjrm-row-desc { margin: 0 0 .35rem; font-style: italic; color: var(--wjs-color-text-muted, #6b7280); font-size: .88rem; max-width: 60ch; }
.wjrm-row-img { width: 54px; height: 54px; object-fit: cover; border-radius: .5rem; flex: 0 0 auto; align-self: center; }
.wjrm-item { padding: .15rem 0 .5rem; }
.wjrm-item-line { display: flex; gap: .8rem; align-items: flex-start; }
.wjrm-item-line > .wjrm-item-body { flex: 1; min-width: 0; }
/* cards layout */
.wjrm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 1.1rem; }
.wjrm-card { background: var(--wjs-bg-surface, #fff); border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, .75rem); overflow: hidden; display: flex; flex-direction: column; }
.wjrm-card-img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block; }
.wjrm-card-body { padding: .9rem .95rem 1rem; display: flex; flex-direction: column; gap: .4rem; flex: 1; }
.wjrm-card-name { font-weight: 700; font-size: 1.02rem; margin: 0; }
.wjrm-card-desc { margin: 0; font-size: .85rem; color: var(--wjs-color-text-muted, #6b7280); flex: 1; }
.wjrm-card-foot { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-top: .35rem; }
.wjrm-card-price { font-weight: 800; font-size: 1.05rem; font-variant-numeric: tabular-nums; }
/* add button */
.wjrm-add { border: none; cursor: pointer; width: 30px; height: 30px; border-radius: 999px; background: var(--wjs-color-primary, #111827); color: #fff; font-size: 1.05rem; line-height: 1; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; font-family: system-ui, sans-serif; }
.wjrm-add:hover { opacity: .85; }
/* floating cart */
.wjrm-fab { position: fixed; right: 18px; bottom: 18px; z-index: 9000; border: none; cursor: pointer; background: var(--wjs-color-primary, #111827); color: #fff; border-radius: 999px; padding: .8rem 1.15rem; font-weight: 700; font-size: .92rem; display: flex; align-items: center; gap: .5rem; box-shadow: 0 8px 24px rgba(0,0,0,.25); font-family: system-ui, sans-serif; }
.wjrm-fab-badge { background: #fff; color: #111827; border-radius: 999px; min-width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; font-size: .78rem; padding: 0 .3rem; }
/* drawer + modals */
.wjrm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 9001; }
.wjrm-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100vw); background: #fff; color: #1f2937; z-index: 9002; display: flex; flex-direction: column; box-shadow: -12px 0 32px rgba(0,0,0,.2); font-family: system-ui, sans-serif; }
.wjrm-drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.1rem; border-bottom: 1px solid #e5e7eb; }
.wjrm-drawer-title { font-weight: 800; font-size: 1.02rem; margin: 0; }
.wjrm-close { border: none; background: #f3f4f6; border-radius: 999px; width: 30px; height: 30px; cursor: pointer; font-size: .95rem; }
.wjrm-drawer-body { flex: 1; overflow-y: auto; padding: 1rem 1.1rem; }
.wjrm-line { border-bottom: 1px solid #f3f4f6; padding: .7rem 0; }
.wjrm-line-top { display: flex; align-items: center; gap: .6rem; }
.wjrm-line-name { flex: 1; font-weight: 600; font-size: .92rem; min-width: 0; }
.wjrm-line-opts { margin: .1rem 0 0; font-size: .78rem; color: #6b7280; }
.wjrm-line-price { font-weight: 700; font-size: .9rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
.wjrm-qty { display: inline-flex; align-items: center; gap: .35rem; }
.wjrm-qty button { border: 1px solid #d1d5db; background: #fff; width: 24px; height: 24px; border-radius: 6px; cursor: pointer; line-height: 1; }
.wjrm-qty span { min-width: 20px; text-align: center; font-size: .9rem; font-weight: 700; }
.wjrm-note { width: 100%; margin-top: .45rem; padding: .4rem .55rem; border: 1px solid #e5e7eb; border-radius: 8px; font-size: .82rem; }
.wjrm-remove { border: none; background: none; color: #b91c1c; cursor: pointer; font-size: .75rem; margin-top: .3rem; padding: 0; }
.wjrm-totals { padding: .8rem 0 0; font-size: .92rem; }
.wjrm-totals div { display: flex; justify-content: space-between; padding: .15rem 0; }
.wjrm-totals .wjrm-total { font-weight: 800; font-size: 1.05rem; }
.wjrm-drawer-foot { padding: 1rem 1.1rem; border-top: 1px solid #e5e7eb; }
.wjrm-btn { width: 100%; border: none; cursor: pointer; background: var(--wjs-color-primary, #111827); color: #fff; border-radius: 12px; padding: .85rem 1rem; font-weight: 800; font-size: .95rem; }
.wjrm-btn:disabled { opacity: .55; cursor: default; }
.wjrm-btn-ghost { width: 100%; border: 1px solid #d1d5db; cursor: pointer; background: #fff; color: #374151; border-radius: 12px; padding: .7rem 1rem; font-weight: 700; font-size: .88rem; margin-top: .5rem; }
.wjrm-btn-wa { width: 100%; border: none; cursor: pointer; background: #25d366; color: #fff; border-radius: 12px; padding: .85rem 1rem; font-weight: 800; font-size: .95rem; }
/* checkout form */
.wjrm-field { margin-bottom: .75rem; }
.wjrm-field label { display: block; font-size: .72rem; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; margin-bottom: .3rem; }
.wjrm-field input, .wjrm-field textarea, .wjrm-field select { width: 100%; padding: .55rem .7rem; border: 1px solid #d1d5db; border-radius: 10px; font-size: .9rem; }
.wjrm-seg { display: flex; gap: .5rem; flex-wrap: wrap; }
.wjrm-seg button { flex: 1; border: 1px solid #d1d5db; background: #fff; border-radius: 10px; padding: .55rem .5rem; cursor: pointer; font-size: .85rem; font-weight: 700; color: #374151; min-width: 110px; }
.wjrm-seg button.wjrm-seg-on { background: var(--wjs-color-primary, #111827); color: #fff; border-color: var(--wjs-color-primary, #111827); }
.wjrm-error { background: #fef2f2; color: #b91c1c; border-radius: 10px; padding: .6rem .8rem; font-size: .85rem; margin-bottom: .75rem; }
.wjrm-warning { background: #fffbeb; color: #92400e; border-radius: 10px; padding: .6rem .8rem; font-size: .85rem; margin: .75rem 0 0; }
.wjrm-success { text-align: center; padding: 1.25rem .5rem; }
.wjrm-success-icon { font-size: 2.4rem; }
.wjrm-success h4 { margin: .5rem 0 .35rem; font-size: 1.1rem; }
.wjrm-success p { margin: 0 0 1rem; font-size: .88rem; color: #6b7280; }
.wjrm-token { font-family: ui-monospace, monospace; font-size: .78rem; background: #f3f4f6; border-radius: 8px; padding: .45rem .6rem; word-break: break-all; margin: .75rem 0; }
.wjrm-eta { display: inline-block; background: #eff6ff; color: #1d4ed8; border-radius: 999px; padding: .35rem .8rem; font-size: .82rem; font-weight: 800; margin-bottom: .5rem; }
.wjrm-status-chip { display: inline-block; background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; border-radius: 999px; padding: .35rem .8rem; font-size: .85rem; font-weight: 800; margin: .3rem 0 .6rem; }
/* modifier + reservation modal */
.wjrm-modal { position: fixed; inset: 0; z-index: 9003; display: flex; align-items: center; justify-content: center; padding: 1rem; font-family: system-ui, sans-serif; }
.wjrm-modal-card { position: relative; background: #fff; color: #1f2937; border-radius: 16px; width: min(430px, 96vw); max-height: 88vh; overflow-y: auto; padding: 1.2rem 1.2rem 1.1rem; box-shadow: 0 24px 64px rgba(0,0,0,.3); }
.wjrm-modal-title { font-weight: 800; font-size: 1.05rem; margin: 0 0 .2rem; padding-right: 2rem; }
.wjrm-modal-sub { margin: 0 0 .8rem; font-size: .82rem; color: #6b7280; }
.wjrm-group { margin-bottom: .9rem; }
.wjrm-group-name { font-weight: 800; font-size: .85rem; margin: 0 0 .1rem; text-transform: uppercase; letter-spacing: .04em; }
.wjrm-group-hint { font-size: .74rem; color: #9ca3af; margin: 0 0 .4rem; }
.wjrm-opt { display: flex; align-items: center; gap: .6rem; padding: .45rem .2rem; cursor: pointer; border-bottom: 1px solid #f8fafc; }
.wjrm-opt input { width: 16px; height: 16px; accent-color: #111827; }
.wjrm-opt-name { flex: 1; font-size: .9rem; font-weight: 600; }
.wjrm-opt-price { font-size: .82rem; font-weight: 700; color: #6b7280; font-variant-numeric: tabular-nums; }
@media (max-width: 640px) { .wjrm-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); } }
`;

// ---- cart persistence ----------------------------------------------------------------------------
function readCart() {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(CART_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter((l) => l && l.item_id && l.qty > 0 && typeof l.key === "string") : [];
    } catch {
        return [];
    }
}
function writeCart(cart) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {
        // Storage unavailable (private mode) — cart just won't persist across reloads.
    }
}

function fmt(cents, symbol) {
    const n = Number(cents) || 0;
    const sign = n < 0 ? "−" : "";
    return `${sign}${symbol || "$"}${(Math.abs(n) / 100).toFixed(2)}`;
}
function lineKey(itemId, optionIds) {
    return `${itemId}:${(optionIds || []).slice().sort((a, b) => a - b).join(".")}`;
}
/** Current page URL without the plugin's own rm_* params (used for Stripe return/cancel). */
function cleanPageUrl() {
    if (typeof window === "undefined") return "";
    try {
        const u = new URL(window.location.href);
        u.searchParams.delete("rm_order");
        u.searchParams.delete("rm_session");
        u.hash = "";
        return u.toString().slice(0, 900);
    } catch {
        return "";
    }
}

// ---- module-level subcomponents (NEVER define components inside components — focus loss) ---------

function TagChips({ tags, lang }) {
    if (!tags || tags.length === 0) return null;
    return (
        <span className="wjrm-tags">
            {tags.map((t) => {
                const meta = TAG_META[t];
                if (!meta) return null;
                return (
                    <span key={t} className="wjrm-tag" title={meta[lang] || meta.es}>
                        {meta.emoji} {meta[lang] || meta.es}
                    </span>
                );
            })}
        </span>
    );
}

function AllergenChips({ allergens, lang }) {
    if (!allergens || allergens.length === 0) return null;
    return (
        <span className="wjrm-allergens">
            {allergens.map((a) => {
                const meta = ALLERGEN_META[a];
                if (!meta) return null;
                return (
                    <span key={a} className="wjrm-allergen" title={meta[lang] || meta.es}>
                        {meta.emoji} {meta[lang] || meta.es}
                    </span>
                );
            })}
        </span>
    );
}

function DishRow({ item, symbol, lang, showImages, showTags, showAllergens, canOrder, onAdd }) {
    return (
        <div className="wjrm-item">
            <div className="wjrm-item-line">
                {showImages && item.image_url ? (
                    <img className="wjrm-row-img" src={item.image_url} alt={item.name} decoding="async" />
                ) : null}
                <div className="wjrm-item-body">
                    <div className="wjrm-row">
                        <span className="wjrm-row-name">{item.name}</span>
                        {showTags ? <TagChips tags={item.tags} lang={lang} /> : null}
                        <span className="wjrm-leader" aria-hidden="true"></span>
                        <span className="wjrm-row-price">{fmt(item.price_cents, symbol)}</span>
                        {canOrder ? (
                            <button type="button" className="wjrm-add" aria-label={`+ ${item.name}`} onClick={() => onAdd(item)}>+</button>
                        ) : null}
                    </div>
                    {item.description ? <p className="wjrm-row-desc">{item.description}</p> : null}
                    {showAllergens ? <AllergenChips allergens={item.allergens} lang={lang} /> : null}
                </div>
            </div>
        </div>
    );
}

function DishCard({ item, symbol, lang, showImages, showTags, showAllergens, canOrder, onAdd }) {
    return (
        <div className="wjrm-card">
            {showImages && item.image_url ? (
                <img className="wjrm-card-img" src={item.image_url} alt={item.name} decoding="async" />
            ) : null}
            <div className="wjrm-card-body">
                <h4 className="wjrm-card-name">{item.name}</h4>
                {showTags ? <TagChips tags={item.tags} lang={lang} /> : null}
                {item.description ? <p className="wjrm-card-desc">{item.description}</p> : null}
                {showAllergens ? <AllergenChips allergens={item.allergens} lang={lang} /> : null}
                <div className="wjrm-card-foot">
                    <span className="wjrm-card-price">{fmt(item.price_cents, symbol)}</span>
                    {canOrder ? (
                        <button type="button" className="wjrm-add" aria-label={`+ ${item.name}`} onClick={() => onAdd(item)}>+</button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

function CartLines({ cart, symbol, onQty, onNote, onRemove, t }) {
    return (
        <>
            {cart.map((line) => (
                <div key={line.key} className="wjrm-line">
                    <div className="wjrm-line-top">
                        <span className="wjrm-line-name">{line.name}</span>
                        <span className="wjrm-qty">
                            <button type="button" aria-label="−" onClick={() => onQty(line.key, -1)}>−</button>
                            <span>{line.qty}</span>
                            <button type="button" aria-label="+" onClick={() => onQty(line.key, 1)}>+</button>
                        </span>
                        <span className="wjrm-line-price">{fmt(line.unit_cents * line.qty, symbol)}</span>
                    </div>
                    {(line.options || []).length > 0 ? (
                        <p className="wjrm-line-opts">{line.options.map((o) => o.name).join(" · ")}</p>
                    ) : null}
                    <input
                        className="wjrm-note"
                        type="text"
                        maxLength={200}
                        placeholder={t.note}
                        value={line.note || ""}
                        onChange={(e) => onNote(line.key, e.target.value)}
                    />
                    <button type="button" className="wjrm-remove" onClick={() => onRemove(line.key)}>{t.remove}</button>
                </div>
            ))}
        </>
    );
}

/** Modifier picker — radio for pick-exactly-one groups, checkboxes otherwise; min/max enforced. */
function ModifierModal({ item, symbol, t, onConfirm, onClose }) {
    const [picked, setPicked] = useState({}); // groupId -> [optionId]

    // Driven by onClick (not onChange): re-clicking a checked radio fires no change event, which
    // would make optional single-select groups impossible to deselect.
    const toggle = (group, optId) => {
        setPicked((prev) => {
            const cur = prev[group.id] || [];
            const isRadio = group.max_select === 1;
            if (isRadio) return { ...prev, [group.id]: cur.includes(optId) && group.min_select === 0 ? [] : [optId] };
            if (cur.includes(optId)) return { ...prev, [group.id]: cur.filter((x) => x !== optId) };
            if (cur.length >= group.max_select) return prev;
            return { ...prev, [group.id]: [...cur, optId] };
        });
    };

    const allOptionIds = [];
    let extra = 0;
    let valid = true;
    for (const g of item.modifiers) {
        const cur = picked[g.id] || [];
        if (cur.length < g.min_select) valid = false;
        for (const id of cur) {
            allOptionIds.push(id);
            const o = g.options.find((x) => x.id === id);
            if (o) extra += o.price_delta_cents;
        }
    }
    const unit = item.price_cents + extra;

    return (
        <div className="wjrm-modal" role="dialog" aria-label={item.name}>
            <div className="wjrm-overlay" onClick={onClose} style={{ zIndex: 0 }}></div>
            <div className="wjrm-modal-card">
                <button type="button" className="wjrm-close" aria-label={t.close} onClick={onClose} style={{ position: "absolute", right: "0.9rem", top: "0.9rem" }}>✕</button>
                <h4 className="wjrm-modal-title">{item.name}</h4>
                <p className="wjrm-modal-sub">{fmt(item.price_cents, symbol)}</p>
                {item.modifiers.map((g) => (
                    <div key={g.id} className="wjrm-group">
                        <p className="wjrm-group-name">{g.name}</p>
                        <p className="wjrm-group-hint">
                            {g.min_select > 0 ? `${t.chooseMin} ${g.min_select}` : ""}
                            {g.min_select > 0 && g.max_select > 1 ? " · " : ""}
                            {g.max_select > 1 ? `${t.chooseMax} ${g.max_select}` : ""}
                        </p>
                        {g.options.map((o) => {
                            const cur = picked[g.id] || [];
                            const on = cur.includes(o.id);
                            return (
                                <label key={o.id} className="wjrm-opt">
                                    <input
                                        type={g.max_select === 1 ? "radio" : "checkbox"}
                                        name={`wjrm-g${g.id}`}
                                        checked={on}
                                        onChange={() => {}}
                                        onClick={() => toggle(g, o.id)}
                                    />
                                    <span className="wjrm-opt-name">{o.name}</span>
                                    <span className="wjrm-opt-price">
                                        {o.price_delta_cents === 0 ? "" : (o.price_delta_cents > 0 ? "+" : "") + fmt(o.price_delta_cents, symbol)}
                                    </span>
                                </label>
                            );
                        })}
                    </div>
                ))}
                <button type="button" className="wjrm-btn" disabled={!valid} onClick={() => onConfirm(item, allOptionIds, unit)}>
                    {t.addFor} — {fmt(unit, symbol)}
                </button>
            </div>
        </div>
    );
}

/** Reservation form modal (native reservations). */
function ReservationModal({ config, t, onClose }) {
    const [name, setName] = useState("");
    const [phone, setPhone] = useState("");
    const [email, setEmail] = useState("");
    const [date, setDate] = useState("");
    const [time, setTime] = useState("");
    const [party, setParty] = useState("2");
    const [notes, setNotes] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState(null); // {token, message}

    const maxParty = Math.max(1, Number(config.reservationPartyMax) || 10);
    const todayStr = (() => {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    })();

    const submit = async (e) => {
        e.preventDefault();
        setError("");
        if (!name.trim()) { setError(t.errName); return; }
        if (!phone.trim()) { setError(t.errPhone); return; }
        setSending(true);
        try {
            const res = await fetch(`${BASE}/public/reservation`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    customer_name: name.trim(),
                    customer_phone: phone.trim(),
                    customer_email: email.trim(),
                    date, time,
                    party_size: parseInt(party, 10) || 2,
                    notes: notes.trim(),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                setError(data.error || t.errSend);
                return;
            }
            setDone({ token: data.token, message: data.message });
        } catch {
            setError(t.errConn);
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="wjrm-modal" role="dialog" aria-label={t.resTitle}>
            <div className="wjrm-overlay" onClick={onClose} style={{ zIndex: 0 }}></div>
            <div className="wjrm-modal-card">
                <button type="button" className="wjrm-close" aria-label={t.close} onClick={onClose} style={{ position: "absolute", right: "0.9rem", top: "0.9rem" }}>✕</button>
                <h4 className="wjrm-modal-title">📅 {t.resTitle}</h4>
                {done ? (
                    <div className="wjrm-success">
                        <div className="wjrm-success-icon">✅</div>
                        <h4>{t.resOk}</h4>
                        <p>{done.message}</p>
                        <div className="wjrm-token">{t.ref}: {done.token}</div>
                        <button type="button" className="wjrm-btn-ghost" onClick={onClose}>{t.close}</button>
                    </div>
                ) : (
                    <form onSubmit={submit}>
                        {error ? <div className="wjrm-error">{error}</div> : null}
                        <div className="wjrm-field">
                            <label>{t.resName}</label>
                            <input type="text" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
                        </div>
                        <div className="wjrm-field">
                            <label>{t.resPhone}</label>
                            <input type="tel" maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} />
                        </div>
                        <div className="wjrm-field">
                            <label>{t.resEmail}</label>
                            <input type="email" maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} />
                        </div>
                        <div style={{ display: "flex", gap: "0.6rem" }}>
                            <div className="wjrm-field" style={{ flex: 1 }}>
                                <label>{t.resDate}</label>
                                <input type="date" min={todayStr} value={date} onChange={(e) => setDate(e.target.value)} required />
                            </div>
                            <div className="wjrm-field" style={{ flex: 1 }}>
                                <label>{t.resTime}</label>
                                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
                            </div>
                            <div className="wjrm-field" style={{ width: "5.2rem" }}>
                                <label>{t.resParty}</label>
                                <input type="number" min={1} max={maxParty} value={party} onChange={(e) => setParty(e.target.value)} required />
                            </div>
                        </div>
                        <div className="wjrm-field">
                            <label>{t.resNotes}</label>
                            <textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
                        </div>
                        <button type="submit" className="wjrm-btn" disabled={sending}>
                            {sending ? t.sending : t.resSend}
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}

// ---- Puck definition -----------------------------------------------------------------------------

export const puckComponentDef = {
    category: "Restaurante",
    fields: {
        layout: {
            type: "radio",
            label: "Diseño",
            options: [
                { label: "Clásico (lista)", value: "list" },
                { label: "Tarjetas", value: "cards" },
            ],
        },
        showImages: {
            type: "radio",
            label: "Mostrar fotos",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        showTags: {
            type: "radio",
            label: "Mostrar etiquetas",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        showAllergens: {
            type: "radio",
            label: "Mostrar alérgenos",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        enableOrdering: {
            type: "radio",
            label: "Pedidos en línea",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        enableReservations: {
            type: "radio",
            label: "Botón de reservas",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        defaultLang: {
            type: "radio",
            label: "Idioma inicial",
            options: [
                { label: "Español", value: "es" },
                { label: "English", value: "en" },
            ],
        },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        layout: "list",
        showImages: true,
        showTags: true,
        showAllergens: true,
        enableOrdering: true,
        enableReservations: true,
        defaultLang: "es",
        elementId: "",
    },
};

export default function RestaurantMenuPuck({ layout, showImages, showTags, showAllergens, enableOrdering, enableReservations, defaultLang, elementId }) {
    const [menu, setMenu] = useState(null);      // null = loading; {sections:[]} = loaded
    const [config, setConfig] = useState(null);
    const [failed, setFailed] = useState(false);
    const [lang, setLang] = useState(defaultLang === "en" ? "en" : "es");

    const [cart, setCart] = useState([]);        // [{key, item_id, name, unit_cents, options, qty, note}]
    const [open, setOpen] = useState(false);
    const [stage, setStage] = useState("cart");  // cart | checkout | done | payreturn
    const [sending, setSending] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState(null);  // {token, waText, etaMinutes, paymentMethod, warning}
    const [orderStatus, setOrderStatus] = useState(null);

    // table mode (?rm_table=) + stripe return (?rm_order&rm_session)
    const [table, setTable] = useState(null);    // {token, label}
    const [payReturn, setPayReturn] = useState(null); // {token, sessionId, paid|null, error}
    const [modifierItem, setModifierItem] = useState(null);
    const [showReservation, setShowReservation] = useState(false);
    const [showHours, setShowHours] = useState(false);

    // checkout form
    const [name, setName] = useState("");
    const [phone, setPhone] = useState("");
    const [deliveryType, setDeliveryType] = useState("pickup");
    const [address, setAddress] = useState("");
    const [notes, setNotes] = useState("");
    const [payMethod, setPayMethod] = useState("default"); // 'default' (wa/cash) | 'stripe'

    const t = STR[lang] || STR.es;

    const loadMenu = (l) => {
        fetch(`${BASE}/public/menu?lang=${encodeURIComponent(l)}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (data && Array.isArray(data.sections)) setMenu(data);
                else { setMenu({ sections: [] }); setFailed(true); }
            })
            .catch(() => { setMenu({ sections: [] }); setFailed(true); });
    };

    useEffect(() => {
        loadMenu(lang);
        fetch(`${BASE}/public/config`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => setConfig(data || {}))
            .catch(() => setConfig({}));

        // URL modes: table QR + Stripe return leg.
        if (typeof window !== "undefined") {
            try {
                const params = new URL(window.location.href).searchParams;
                const tToken = params.get("rm_table");
                if (tToken && /^[a-z0-9]{16,64}$/.test(tToken)) {
                    fetch(`${BASE}/public/table?token=${encodeURIComponent(tToken)}`)
                        .then((res) => (res.ok ? res.json() : null))
                        .then((data) => { if (data && data.table) setTable({ token: tToken, label: data.table.label }); })
                        .catch(() => {});
                }
                const oToken = params.get("rm_order");
                const session = params.get("rm_session");
                if (oToken && session) {
                    setPayReturn({ token: oToken, sessionId: session, paid: null, error: "" });
                    setOpen(true);
                    setStage("payreturn");
                }
            } catch { /* ignore malformed URLs */ }
        }
    }, []);

    // Refetch menu on language change (server does the substitution).
    useEffect(() => { if (menu !== null) loadMenu(lang); }, [lang]);

    // Hydrate the cart from localStorage AFTER mount (avoids SSR/client mismatch).
    useEffect(() => { setCart(readCart()); }, []);

    // Verify the Stripe session against the server when returning from checkout.
    useEffect(() => {
        if (!payReturn || payReturn.paid !== null) return;
        fetch(`${BASE}/public/confirm-stripe?token=${encodeURIComponent(payReturn.token)}&session_id=${encodeURIComponent(payReturn.sessionId)}`)
            .then((res) => res.json().catch(() => ({})))
            .then((data) => {
                if (data.paid) updateCart([]); // payment confirmed — the kept cart is finally done
                setPayReturn((prev) => (prev ? { ...prev, paid: !!data.paid, error: data.error || "" } : prev));
            })
            .catch(() => setPayReturn((prev) => (prev ? { ...prev, paid: false, error: t.errConn } : prev)));
    }, [payReturn && payReturn.token, payReturn && payReturn.paid === null]);

    const cfg = config || {};
    const isClosed = !!(cfg.hoursEnabled && !cfg.isOpen);
    const orderingActive = !!(enableOrdering && cfg.orderingEnabled) && !isClosed;
    const tableMode = !!(table && cfg.tableOrderingEnabled);
    const symbol = cfg.currencySymbol || "$";
    const deliveryCents = Number(cfg.deliveryCents) || 0;
    const i18nOn = !!cfg.i18nEnabled;

    const cartCount = useMemo(() => cart.reduce((n, l) => n + l.qty, 0), [cart]);
    const subtotal = useMemo(() => cart.reduce((n, l) => n + l.unit_cents * l.qty, 0), [cart]);
    const effectiveDelivery = !tableMode && deliveryType === "delivery" ? deliveryCents : 0;
    const total = subtotal + effectiveDelivery;

    const updateCart = (next) => { setCart(next); writeCart(next); };

    const pushLine = (item, optionIds, unitCents, optionObjs) => {
        const key = lineKey(item.id, optionIds);
        const next = cart.slice();
        const existing = next.find((l) => l.key === key);
        if (existing) existing.qty = Math.min(99, existing.qty + 1);
        else next.push({ key, item_id: item.id, name: item.name, unit_cents: unitCents, options: optionObjs, option_ids: optionIds, qty: 1, note: "" });
        updateCart(next);
        setOpen(true);
        setStage("cart");
    };

    const addToCart = (item) => {
        if ((item.modifiers || []).length > 0) {
            setModifierItem(item);
            return;
        }
        pushLine(item, [], item.price_cents, []);
    };
    const confirmModifiers = (item, optionIds, unitCents) => {
        const objs = [];
        for (const g of item.modifiers) {
            for (const o of g.options) if (optionIds.includes(o.id)) objs.push({ id: o.id, name: o.name });
        }
        setModifierItem(null);
        pushLine(item, optionIds, unitCents, objs);
    };
    const changeQty = (key, delta) => {
        const next = cart
            .map((l) => (l.key === key ? { ...l, qty: Math.min(99, l.qty + delta) } : l))
            .filter((l) => l.qty > 0);
        updateCart(next);
    };
    const changeNote = (key, note) => {
        updateCart(cart.map((l) => (l.key === key ? { ...l, note } : l)));
    };
    const removeLine = (key) => {
        updateCart(cart.filter((l) => l.key !== key));
    };

    const submitOrder = async (e) => {
        if (e && e.preventDefault) e.preventDefault();
        setError("");
        if (!name.trim()) { setError(t.errName); return; }
        if (!tableMode && !phone.trim()) { setError(t.errPhone); return; }
        if (!tableMode && deliveryType === "delivery" && !address.trim()) { setError(t.errAddress); return; }
        if (cart.length === 0) { setError(t.errEmpty); return; }
        setSending(true);
        try {
            const res = await fetch(`${BASE}/public/order`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    customer_name: name.trim(),
                    customer_phone: phone.trim(),
                    customer_address: tableMode ? "" : address.trim(),
                    delivery_type: tableMode ? "" : deliveryType,
                    table_token: tableMode ? table.token : "",
                    payment_method: payMethod === "stripe" ? "stripe" : "",
                    page_url: cleanPageUrl(),
                    items: cart.map((l) => ({ item_id: l.item_id, qty: l.qty, note: l.note || "", option_ids: l.option_ids || [] })),
                    notes: notes.trim(),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                setError(data.error || t.errSend);
                return;
            }
            if (data.checkoutUrl) {
                // Card payment: the order is registered; Stripe hosts the payment page. The cart is
                // kept — if the customer cancels on Stripe they come back to an intact cart; it is
                // cleared only when the return leg confirms the payment.
                if (typeof window !== "undefined") window.location.href = data.checkoutUrl;
                return;
            }
            setResult({
                token: data.token, waText: data.waText, etaMinutes: data.etaMinutes,
                paymentMethod: data.paymentMethod, warning: data.warning || "", table: data.table || "",
            });
            setOrderStatus(null);
            updateCart([]);
            setStage("done");
        } catch {
            setError(t.errConn);
        } finally {
            setSending(false);
        }
    };

    const openWhatsApp = () => {
        if (!result || !result.waText || !cfg.whatsappNumber) return;
        if (typeof window !== "undefined") {
            window.open(`https://wa.me/${cfg.whatsappNumber}?text=${encodeURIComponent(result.waText)}`, "_blank", "noopener");
        }
    };

    const refreshStatus = async (token) => {
        try {
            const res = await fetch(`${BASE}/public/order-status?token=${encodeURIComponent(token)}`);
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.status) setOrderStatus(data);
        } catch { /* transient */ }
    };

    const sections = (menu && menu.sections) || [];
    const hasDishes = sections.some((s) => s.items && s.items.length > 0);
    const showLangToggle = i18nOn;
    const reservationsOn = !!(enableReservations && cfg.reservationsEnabled);
    const payOnlineAvailable = !!cfg.payOnline;

    const weekHoursRows = () => {
        const wh = cfg.weekHours || {};
        const order = [1, 2, 3, 4, 5, 6, 0];
        return order.map((d) => {
            const ranges = wh[String(d)] || [];
            return (
                <div key={d}>
                    <span>{t.days[d]}</span>
                    <span>{ranges.length === 0 ? t.closedDay : ranges.map((r) => `${r[0]}–${r[1]}`).join(", ")}</span>
                </div>
            );
        });
    };

    return (
        <div id={elementId || undefined} className="wjrm">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />

            {(showLangToggle || reservationsOn) && menu !== null ? (
                <div className="wjrm-topbar">
                    {reservationsOn ? (
                        <button type="button" className="wjrm-reserve-btn" onClick={() => setShowReservation(true)}>📅 {t.reserve}</button>
                    ) : null}
                    {showLangToggle ? (
                        <span className="wjrm-lang">
                            <button type="button" className={lang === "es" ? "wjrm-lang-on" : ""} onClick={() => setLang("es")}>ES</button>
                            <button type="button" className={lang === "en" ? "wjrm-lang-on" : ""} onClick={() => setLang("en")}>EN</button>
                        </span>
                    ) : null}
                </div>
            ) : null}

            {tableMode ? (
                <div className="wjrm-banner wjrm-banner-table">🪑 {t.tableBanner}: <strong>{table.label}</strong></div>
            ) : null}

            {isClosed && cfg.orderingEnabled && enableOrdering ? (
                <div className="wjrm-banner wjrm-banner-closed">
                    <span>🕐 <strong>{t.closedTitle}.</strong> {cfg.closedMessage || cfg.nextOpen || ""}</span>
                    <button type="button" className="wjrm-hours-toggle" onClick={() => setShowHours((v) => !v)}>{t.hours}</button>
                    {showHours ? <div className="wjrm-hours">{weekHoursRows()}</div> : null}
                </div>
            ) : null}

            {menu === null ? (
                <div className="wjrm-empty">{t.loading}</div>
            ) : !hasDishes ? (
                <div className="wjrm-empty">
                    {failed ? t.unavailable : t.emptyMenu}
                </div>
            ) : (
                sections.map((section) =>
                    section.items.length === 0 ? null : (
                        <section key={section.id} className="wjrm-section">
                            <div className="wjrm-section-head">
                                <h3 className="wjrm-section-title">{section.name}</h3>
                                <span className="wjrm-section-rule" aria-hidden="true"></span>
                            </div>
                            {layout === "cards" ? (
                                <div className="wjrm-grid">
                                    {section.items.map((item) => (
                                        <DishCard key={item.id} item={item} symbol={symbol} lang={lang} showImages={showImages} showTags={showTags} showAllergens={showAllergens} canOrder={orderingActive} onAdd={addToCart} />
                                    ))}
                                </div>
                            ) : (
                                section.items.map((item) => (
                                    <DishRow key={item.id} item={item} symbol={symbol} lang={lang} showImages={showImages} showTags={showTags} showAllergens={showAllergens} canOrder={orderingActive} onAdd={addToCart} />
                                ))
                            )}
                        </section>
                    )
                )
            )}

            {orderingActive && cartCount > 0 && !open ? (
                <button type="button" className="wjrm-fab" onClick={() => { setOpen(true); if (stage === "done" || stage === "payreturn") setStage("cart"); }}>
                    🛒 {t.viewOrder} <span className="wjrm-fab-badge">{cartCount}</span>
                </button>
            ) : null}

            {(orderingActive || stage === "payreturn") && open ? (
                <>
                    <div className="wjrm-overlay" onClick={() => setOpen(false)}></div>
                    <div className="wjrm-drawer" role="dialog" aria-label={t.yourOrder}>
                        <div className="wjrm-drawer-head">
                            <h4 className="wjrm-drawer-title">
                                {stage === "done" ? t.orderSent : stage === "checkout" ? t.yourInfo : stage === "payreturn" ? t.payment : t.yourOrder}
                            </h4>
                            <button type="button" className="wjrm-close" aria-label={t.close} onClick={() => setOpen(false)}>✕</button>
                        </div>

                        <div className="wjrm-drawer-body">
                            {stage === "cart" ? (
                                cart.length === 0 ? (
                                    <div className="wjrm-empty">{t.emptyCart}</div>
                                ) : (
                                    <>
                                        <CartLines cart={cart} symbol={symbol} onQty={changeQty} onNote={changeNote} onRemove={removeLine} t={t} />
                                        <div className="wjrm-totals">
                                            <div><span>{t.subtotal}</span><span>{fmt(subtotal, symbol)}</span></div>
                                        </div>
                                    </>
                                )
                            ) : null}

                            {stage === "checkout" ? (
                                <form onSubmit={submitOrder}>
                                    {error ? <div className="wjrm-error">{error}</div> : null}
                                    <div className="wjrm-field">
                                        <label>{t.name}</label>
                                        <input type="text" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
                                    </div>
                                    <div className="wjrm-field">
                                        <label>{t.phone}{tableMode ? " (opcional)" : ""}</label>
                                        <input type="tel" maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="300 123 4567" />
                                    </div>
                                    {!tableMode ? (
                                        <div className="wjrm-field">
                                            <label>{t.delivery}</label>
                                            <div className="wjrm-seg">
                                                <button type="button" className={deliveryType === "pickup" ? "wjrm-seg-on" : ""} onClick={() => setDeliveryType("pickup")}>
                                                    {cfg.pickupLabel || "Recoger en local"}
                                                </button>
                                                <button type="button" className={deliveryType === "delivery" ? "wjrm-seg-on" : ""} onClick={() => setDeliveryType("delivery")}>
                                                    {cfg.deliveryLabel || "Domicilio"}
                                                    {deliveryCents > 0 ? ` (+${fmt(deliveryCents, symbol)})` : ""}
                                                </button>
                                            </div>
                                        </div>
                                    ) : null}
                                    {!tableMode && deliveryType === "delivery" ? (
                                        <div className="wjrm-field">
                                            <label>{t.address}</label>
                                            <input type="text" maxLength={300} value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t.addressPh} />
                                        </div>
                                    ) : null}
                                    {payOnlineAvailable ? (
                                        <div className="wjrm-field">
                                            <label>{t.payment}</label>
                                            <div className="wjrm-seg">
                                                <button type="button" className={payMethod !== "stripe" ? "wjrm-seg-on" : ""} onClick={() => setPayMethod("default")}>
                                                    {tableMode ? t.payCashTable : cfg.whatsappNumber ? t.payWa : t.payCash}
                                                </button>
                                                <button type="button" className={payMethod === "stripe" ? "wjrm-seg-on" : ""} onClick={() => setPayMethod("stripe")}>
                                                    💳 {t.payCard}
                                                </button>
                                            </div>
                                        </div>
                                    ) : null}
                                    <div className="wjrm-field">
                                        <label>{t.notes}</label>
                                        <textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t.notesPh} />
                                    </div>
                                    <div className="wjrm-totals">
                                        <div><span>{t.subtotal}</span><span>{fmt(subtotal, symbol)}</span></div>
                                        {effectiveDelivery > 0 ? (
                                            <div><span>{t.deliveryFee}</span><span>{fmt(effectiveDelivery, symbol)}</span></div>
                                        ) : null}
                                        <div className="wjrm-total"><span>{t.total}</span><span>{fmt(total, symbol)}</span></div>
                                    </div>
                                </form>
                            ) : null}

                            {stage === "done" && result ? (
                                <div className="wjrm-success">
                                    <div className="wjrm-success-icon">✅</div>
                                    <h4>{t.registered}</h4>
                                    {result.etaMinutes ? <span className="wjrm-eta">⏱ {t.eta}: ~{result.etaMinutes} {t.min}</span> : null}
                                    {result.table ? <p>🪑 {t.table}: {result.table} — {t.kitchenHint}</p> : (
                                        <p>
                                            {result.waText && cfg.whatsappNumber ? t.waHint : t.kitchenHint}
                                        </p>
                                    )}
                                    {result.warning ? <div className="wjrm-warning">{result.warning}</div> : null}
                                    {/* Table orders go straight to the kitchen — no WhatsApp hand-off needed. */}
                                    {!result.table && result.waText && cfg.whatsappNumber ? (
                                        <button type="button" className="wjrm-btn-wa" onClick={openWhatsApp}>
                                            {t.sendWa}
                                        </button>
                                    ) : null}
                                    {orderStatus ? (
                                        <div>
                                            <span className="wjrm-status-chip">
                                                {t.statusLabel[orderStatus.status] || orderStatus.status}
                                                {orderStatus.payment_status === "paid" ? " · 💳✓" : ""}
                                            </span>
                                        </div>
                                    ) : null}
                                    <button type="button" className="wjrm-btn-ghost" onClick={() => refreshStatus(result.token)}>
                                        ⟳ {t.checkStatus}
                                    </button>
                                    <div className="wjrm-token">{t.ref}: {result.token}</div>
                                </div>
                            ) : null}

                            {stage === "payreturn" && payReturn ? (
                                <div className="wjrm-success">
                                    {payReturn.paid === null ? (
                                        <>
                                            <div className="wjrm-success-icon">⏳</div>
                                            <h4>{t.sending}</h4>
                                        </>
                                    ) : payReturn.paid ? (
                                        <>
                                            <div className="wjrm-success-icon">💳✅</div>
                                            <h4>{t.payOk}</h4>
                                            <p>{t.payOkHint}</p>
                                            {orderStatus ? (
                                                <div>
                                                    <span className="wjrm-status-chip">{t.statusLabel[orderStatus.status] || orderStatus.status}</span>
                                                </div>
                                            ) : null}
                                            <button type="button" className="wjrm-btn-ghost" onClick={() => refreshStatus(payReturn.token)}>
                                                ⟳ {t.checkStatus}
                                            </button>
                                            <div className="wjrm-token">{t.ref}: {payReturn.token}</div>
                                        </>
                                    ) : (
                                        <>
                                            <div className="wjrm-success-icon">⚠️</div>
                                            <h4>{t.payFail}</h4>
                                            {payReturn.error ? <p>{payReturn.error}</p> : null}
                                            <button type="button" className="wjrm-btn-ghost" onClick={() => setPayReturn((p) => ({ ...p, paid: null }))}>
                                                {t.payRetry}
                                            </button>
                                            <div className="wjrm-token">{t.ref}: {payReturn.token}</div>
                                        </>
                                    )}
                                </div>
                            ) : null}
                        </div>

                        <div className="wjrm-drawer-foot">
                            {stage === "cart" ? (
                                <>
                                    <button type="button" className="wjrm-btn" disabled={cart.length === 0} onClick={() => { setError(""); setStage("checkout"); }}>
                                        {t.continueBtn} — {fmt(subtotal, symbol)}
                                    </button>
                                    <button type="button" className="wjrm-btn-ghost" onClick={() => setOpen(false)}>{t.keepBrowsing}</button>
                                </>
                            ) : null}
                            {stage === "checkout" ? (
                                <>
                                    <button type="button" className="wjrm-btn" disabled={sending} onClick={submitOrder}>
                                        {sending ? t.sending : `${t.confirm} — ${fmt(total, symbol)}`}
                                    </button>
                                    <button type="button" className="wjrm-btn-ghost" onClick={() => setStage("cart")}>{t.backToCart}</button>
                                </>
                            ) : null}
                            {(stage === "done" || stage === "payreturn") ? (
                                <button type="button" className="wjrm-btn-ghost" onClick={() => { setOpen(false); setStage("cart"); }}>{t.close}</button>
                            ) : null}
                        </div>
                    </div>
                </>
            ) : null}

            {modifierItem ? (
                <ModifierModal item={modifierItem} symbol={symbol} t={t} onConfirm={confirmModifiers} onClose={() => setModifierItem(null)} />
            ) : null}
            {showReservation ? (
                <ReservationModal config={cfg} t={t} onClose={() => setShowReservation(false)} />
            ) : null}
        </div>
    );
}
