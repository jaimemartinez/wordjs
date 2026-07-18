// @ts-nocheck
"use client";

/**
 * Puck block "RestaurantMenu" — elegant restaurant menu with optional online ordering.
 *
 * Registered via manifest.frontend.puckComponents; the generated registry composes
 * { ...puckComponentDef, render: default export }, so puckComponentDef must NOT carry a render.
 * Runs in the editor iframe AND on the public page: data arrives via client-mount fetches against
 * the plugin's PUBLIC endpoints, guarded with res.ok (an inactive plugin 404s — the block degrades
 * to a quiet Spanish placeholder instead of crashing the page).
 *
 * Ordering (only effective when the server config has orderingEnabled): '+' per dish → floating
 * cart → drawer with quantities and per-item notes → checkout mini-form → POST /public/order →
 * success view with an 'Enviar pedido por WhatsApp' button (wa.me handoff with the server-built
 * summary) and the order token.
 */

import React, { useEffect, useMemo, useState } from "react";

const BASE = "/api/v1/plugin/restaurant-menu";
const CART_KEY = "wjrm_cart_v1";

const TAG_META = {
    "vegano": { emoji: "🌱", label: "Vegano" },
    "picante": { emoji: "🌶️", label: "Picante" },
    "sin-gluten": { emoji: "🚫🌾", label: "Sin gluten" },
    "nuevo": { emoji: "✨", label: "Nuevo" },
    "popular": { emoji: "⭐", label: "Popular" },
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
/* drawer */
.wjrm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 9001; }
.wjrm-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100vw); background: #fff; color: #1f2937; z-index: 9002; display: flex; flex-direction: column; box-shadow: -12px 0 32px rgba(0,0,0,.2); font-family: system-ui, sans-serif; }
.wjrm-drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.1rem; border-bottom: 1px solid #e5e7eb; }
.wjrm-drawer-title { font-weight: 800; font-size: 1.02rem; margin: 0; }
.wjrm-close { border: none; background: #f3f4f6; border-radius: 999px; width: 30px; height: 30px; cursor: pointer; font-size: .95rem; }
.wjrm-drawer-body { flex: 1; overflow-y: auto; padding: 1rem 1.1rem; }
.wjrm-line { border-bottom: 1px solid #f3f4f6; padding: .7rem 0; }
.wjrm-line-top { display: flex; align-items: center; gap: .6rem; }
.wjrm-line-name { flex: 1; font-weight: 600; font-size: .92rem; min-width: 0; }
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
.wjrm-field input, .wjrm-field textarea { width: 100%; padding: .55rem .7rem; border: 1px solid #d1d5db; border-radius: 10px; font-size: .9rem; }
.wjrm-seg { display: flex; gap: .5rem; }
.wjrm-seg button { flex: 1; border: 1px solid #d1d5db; background: #fff; border-radius: 10px; padding: .55rem .5rem; cursor: pointer; font-size: .85rem; font-weight: 700; color: #374151; }
.wjrm-seg button.wjrm-seg-on { background: var(--wjs-color-primary, #111827); color: #fff; border-color: var(--wjs-color-primary, #111827); }
.wjrm-error { background: #fef2f2; color: #b91c1c; border-radius: 10px; padding: .6rem .8rem; font-size: .85rem; margin-bottom: .75rem; }
.wjrm-success { text-align: center; padding: 1.25rem .5rem; }
.wjrm-success-icon { font-size: 2.4rem; }
.wjrm-success h4 { margin: .5rem 0 .35rem; font-size: 1.1rem; }
.wjrm-success p { margin: 0 0 1rem; font-size: .88rem; color: #6b7280; }
.wjrm-token { font-family: ui-monospace, monospace; font-size: .78rem; background: #f3f4f6; border-radius: 8px; padding: .45rem .6rem; word-break: break-all; margin: .75rem 0; }
@media (max-width: 640px) { .wjrm-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); } }
`;

// ---- cart persistence (module-level helpers; localStorage under a plugin-prefixed key) ----------
function readCart() {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(CART_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter((l) => l && l.item_id && l.qty > 0) : [];
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
    return `${symbol || "$"}${((Number(cents) || 0) / 100).toFixed(2)}`;
}

// ---- module-level subcomponents (NEVER define components inside components — focus loss) ---------

function TagChips({ tags }) {
    if (!tags || tags.length === 0) return null;
    return (
        <span className="wjrm-tags">
            {tags.map((t) => {
                const meta = TAG_META[t];
                if (!meta) return null;
                return (
                    <span key={t} className="wjrm-tag" title={meta.label}>
                        {meta.emoji} {meta.label}
                    </span>
                );
            })}
        </span>
    );
}

function DishRow({ item, symbol, showImages, showTags, canOrder, onAdd }) {
    return (
        <div className="wjrm-item">
            <div className="wjrm-item-line">
                {showImages && item.image_url ? (
                    <img className="wjrm-row-img" src={item.image_url} alt={item.name} decoding="async" />
                ) : null}
                <div className="wjrm-item-body">
                    <div className="wjrm-row">
                        <span className="wjrm-row-name">{item.name}</span>
                        {showTags ? <TagChips tags={item.tags} /> : null}
                        <span className="wjrm-leader" aria-hidden="true"></span>
                        <span className="wjrm-row-price">{fmt(item.price_cents, symbol)}</span>
                        {canOrder ? (
                            <button type="button" className="wjrm-add" aria-label={`Agregar ${item.name}`} onClick={() => onAdd(item)}>+</button>
                        ) : null}
                    </div>
                    {item.description ? <p className="wjrm-row-desc">{item.description}</p> : null}
                </div>
            </div>
        </div>
    );
}

function DishCard({ item, symbol, showImages, showTags, canOrder, onAdd }) {
    return (
        <div className="wjrm-card">
            {showImages && item.image_url ? (
                <img className="wjrm-card-img" src={item.image_url} alt={item.name} decoding="async" />
            ) : null}
            <div className="wjrm-card-body">
                <h4 className="wjrm-card-name">{item.name}</h4>
                {showTags ? <TagChips tags={item.tags} /> : null}
                {item.description ? <p className="wjrm-card-desc">{item.description}</p> : null}
                <div className="wjrm-card-foot">
                    <span className="wjrm-card-price">{fmt(item.price_cents, symbol)}</span>
                    {canOrder ? (
                        <button type="button" className="wjrm-add" aria-label={`Agregar ${item.name}`} onClick={() => onAdd(item)}>+</button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

function CartLines({ cart, symbol, onQty, onNote, onRemove }) {
    return (
        <>
            {cart.map((line) => (
                <div key={line.item_id} className="wjrm-line">
                    <div className="wjrm-line-top">
                        <span className="wjrm-line-name">{line.name}</span>
                        <span className="wjrm-qty">
                            <button type="button" aria-label="Menos" onClick={() => onQty(line.item_id, -1)}>−</button>
                            <span>{line.qty}</span>
                            <button type="button" aria-label="Más" onClick={() => onQty(line.item_id, 1)}>+</button>
                        </span>
                        <span className="wjrm-line-price">{fmt(line.price_cents * line.qty, symbol)}</span>
                    </div>
                    <input
                        className="wjrm-note"
                        type="text"
                        maxLength={200}
                        placeholder="Nota (ej. sin cebolla)"
                        value={line.note || ""}
                        onChange={(e) => onNote(line.item_id, e.target.value)}
                    />
                    <button type="button" className="wjrm-remove" onClick={() => onRemove(line.item_id)}>Quitar</button>
                </div>
            ))}
        </>
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
        enableOrdering: {
            type: "radio",
            label: "Pedidos en línea",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        layout: "list",
        showImages: true,
        showTags: true,
        enableOrdering: true,
        elementId: "",
    },
};

export default function RestaurantMenuPuck({ layout, showImages, showTags, enableOrdering, elementId }) {
    const [menu, setMenu] = useState(null);      // null = loading; {sections:[]} = loaded
    const [config, setConfig] = useState(null);
    const [failed, setFailed] = useState(false);

    const [cart, setCart] = useState([]);        // [{item_id, name, price_cents, qty, note}]
    const [open, setOpen] = useState(false);
    const [stage, setStage] = useState("cart");  // 'cart' | 'checkout' | 'done'
    const [sending, setSending] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState(null);  // {token, waText}

    // checkout form
    const [name, setName] = useState("");
    const [phone, setPhone] = useState("");
    const [deliveryType, setDeliveryType] = useState("pickup");
    const [address, setAddress] = useState("");
    const [notes, setNotes] = useState("");

    useEffect(() => {
        let alive = true;
        fetch(`${BASE}/public/menu`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!alive) return;
                if (data && Array.isArray(data.sections)) setMenu(data);
                else { setMenu({ sections: [] }); setFailed(true); }
            })
            .catch(() => { if (alive) { setMenu({ sections: [] }); setFailed(true); } });
        fetch(`${BASE}/public/config`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => { if (alive) setConfig(data || {}); })
            .catch(() => { if (alive) setConfig({}); });
        return () => { alive = false; };
    }, []);

    // Hydrate the cart from localStorage AFTER mount (avoids SSR/client mismatch).
    useEffect(() => { setCart(readCart()); }, []);

    const orderingActive = !!(enableOrdering && config && config.orderingEnabled);
    const symbol = (config && config.currencySymbol) || "$";
    const deliveryCents = (config && Number(config.deliveryCents)) || 0;

    const cartCount = useMemo(() => cart.reduce((n, l) => n + l.qty, 0), [cart]);
    const subtotal = useMemo(() => cart.reduce((n, l) => n + l.price_cents * l.qty, 0), [cart]);
    const total = subtotal + (deliveryType === "delivery" ? deliveryCents : 0);

    const updateCart = (next) => { setCart(next); writeCart(next); };

    const addToCart = (item) => {
        const next = cart.slice();
        const existing = next.find((l) => l.item_id === item.id);
        if (existing) existing.qty = Math.min(99, existing.qty + 1);
        else next.push({ item_id: item.id, name: item.name, price_cents: item.price_cents, qty: 1, note: "" });
        updateCart(next);
        setOpen(true);
        setStage("cart");
    };
    const changeQty = (itemId, delta) => {
        const next = cart
            .map((l) => (l.item_id === itemId ? { ...l, qty: Math.min(99, l.qty + delta) } : l))
            .filter((l) => l.qty > 0);
        updateCart(next);
    };
    const changeNote = (itemId, note) => {
        updateCart(cart.map((l) => (l.item_id === itemId ? { ...l, note } : l)));
    };
    const removeLine = (itemId) => {
        updateCart(cart.filter((l) => l.item_id !== itemId));
    };

    const submitOrder = async (e) => {
        if (e && e.preventDefault) e.preventDefault();
        setError("");
        if (!name.trim()) { setError("Escribe tu nombre."); return; }
        if (!phone.trim()) { setError("Escribe tu teléfono."); return; }
        if (deliveryType === "delivery" && !address.trim()) { setError("Escribe la dirección de entrega."); return; }
        if (cart.length === 0) { setError("El carrito está vacío."); return; }
        setSending(true);
        try {
            const res = await fetch(`${BASE}/public/order`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    customer_name: name.trim(),
                    customer_phone: phone.trim(),
                    customer_address: address.trim(),
                    delivery_type: deliveryType,
                    items: cart.map((l) => ({ item_id: l.item_id, qty: l.qty, note: l.note || "" })),
                    notes: notes.trim(),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
                setError(data.error || "No se pudo enviar el pedido. Intenta de nuevo.");
                return;
            }
            setResult({ token: data.token, waText: data.waText });
            updateCart([]);
            setStage("done");
        } catch {
            setError("Error de conexión. Intenta de nuevo.");
        } finally {
            setSending(false);
        }
    };

    const openWhatsApp = () => {
        if (!result || !config || !config.whatsappNumber) return;
        if (typeof window !== "undefined") {
            window.open(`https://wa.me/${config.whatsappNumber}?text=${encodeURIComponent(result.waText)}`, "_blank", "noopener");
        }
    };

    const sections = (menu && menu.sections) || [];
    const hasDishes = sections.some((s) => s.items && s.items.length > 0);

    return (
        <div id={elementId || undefined} className="wjrm">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />

            {menu === null ? (
                <div className="wjrm-empty">Cargando menú…</div>
            ) : !hasDishes ? (
                <div className="wjrm-empty">
                    {failed
                        ? "El menú no está disponible en este momento."
                        : "El menú aún no tiene platos — configúralo en Admin → Restaurante."}
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
                                        <DishCard key={item.id} item={item} symbol={symbol} showImages={showImages} showTags={showTags} canOrder={orderingActive} onAdd={addToCart} />
                                    ))}
                                </div>
                            ) : (
                                section.items.map((item) => (
                                    <DishRow key={item.id} item={item} symbol={symbol} showImages={showImages} showTags={showTags} canOrder={orderingActive} onAdd={addToCart} />
                                ))
                            )}
                        </section>
                    )
                )
            )}

            {orderingActive && cartCount > 0 && !open ? (
                <button type="button" className="wjrm-fab" onClick={() => { setOpen(true); if (stage === "done") setStage("cart"); }}>
                    🛒 Ver pedido <span className="wjrm-fab-badge">{cartCount}</span>
                </button>
            ) : null}

            {orderingActive && open ? (
                <>
                    <div className="wjrm-overlay" onClick={() => setOpen(false)}></div>
                    <div className="wjrm-drawer" role="dialog" aria-label="Tu pedido">
                        <div className="wjrm-drawer-head">
                            <h4 className="wjrm-drawer-title">
                                {stage === "done" ? "Pedido enviado" : stage === "checkout" ? "Tus datos" : "Tu pedido"}
                            </h4>
                            <button type="button" className="wjrm-close" aria-label="Cerrar" onClick={() => setOpen(false)}>✕</button>
                        </div>

                        <div className="wjrm-drawer-body">
                            {stage === "cart" ? (
                                cart.length === 0 ? (
                                    <div className="wjrm-empty">Tu carrito está vacío — agrega platos con el botón +.</div>
                                ) : (
                                    <>
                                        <CartLines cart={cart} symbol={symbol} onQty={changeQty} onNote={changeNote} onRemove={removeLine} />
                                        <div className="wjrm-totals">
                                            <div><span>Subtotal</span><span>{fmt(subtotal, symbol)}</span></div>
                                        </div>
                                    </>
                                )
                            ) : null}

                            {stage === "checkout" ? (
                                <form onSubmit={submitOrder}>
                                    {error ? <div className="wjrm-error">{error}</div> : null}
                                    <div className="wjrm-field">
                                        <label>Nombre</label>
                                        <input type="text" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" />
                                    </div>
                                    <div className="wjrm-field">
                                        <label>Teléfono</label>
                                        <input type="tel" maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Ej. 300 123 4567" />
                                    </div>
                                    <div className="wjrm-field">
                                        <label>Entrega</label>
                                        <div className="wjrm-seg">
                                            <button type="button" className={deliveryType === "pickup" ? "wjrm-seg-on" : ""} onClick={() => setDeliveryType("pickup")}>
                                                {(config && config.pickupLabel) || "Recoger en local"}
                                            </button>
                                            <button type="button" className={deliveryType === "delivery" ? "wjrm-seg-on" : ""} onClick={() => setDeliveryType("delivery")}>
                                                {(config && config.deliveryLabel) || "Domicilio"}
                                                {deliveryCents > 0 ? ` (+${fmt(deliveryCents, symbol)})` : ""}
                                            </button>
                                        </div>
                                    </div>
                                    {deliveryType === "delivery" ? (
                                        <div className="wjrm-field">
                                            <label>Dirección</label>
                                            <input type="text" maxLength={300} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Calle, número, referencias" />
                                        </div>
                                    ) : null}
                                    <div className="wjrm-field">
                                        <label>Notas (opcional)</label>
                                        <textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Alguna indicación para el restaurante" />
                                    </div>
                                    <div className="wjrm-totals">
                                        <div><span>Subtotal</span><span>{fmt(subtotal, symbol)}</span></div>
                                        {deliveryType === "delivery" && deliveryCents > 0 ? (
                                            <div><span>Envío</span><span>{fmt(deliveryCents, symbol)}</span></div>
                                        ) : null}
                                        <div className="wjrm-total"><span>Total</span><span>{fmt(total, symbol)}</span></div>
                                    </div>
                                </form>
                            ) : null}

                            {stage === "done" && result ? (
                                <div className="wjrm-success">
                                    <div className="wjrm-success-icon">✅</div>
                                    <h4>¡Pedido registrado!</h4>
                                    <p>
                                        {config && config.whatsappNumber
                                            ? "Envía el resumen por WhatsApp para confirmarlo con el restaurante."
                                            : "El restaurante recibió tu pedido."}
                                    </p>
                                    {config && config.whatsappNumber ? (
                                        <button type="button" className="wjrm-btn-wa" onClick={openWhatsApp}>
                                            Enviar pedido por WhatsApp
                                        </button>
                                    ) : null}
                                    <div className="wjrm-token">Referencia: {result.token}</div>
                                </div>
                            ) : null}
                        </div>

                        <div className="wjrm-drawer-foot">
                            {stage === "cart" ? (
                                <>
                                    <button type="button" className="wjrm-btn" disabled={cart.length === 0} onClick={() => { setError(""); setStage("checkout"); }}>
                                        Continuar — {fmt(subtotal, symbol)}
                                    </button>
                                    <button type="button" className="wjrm-btn-ghost" onClick={() => setOpen(false)}>Seguir viendo el menú</button>
                                </>
                            ) : null}
                            {stage === "checkout" ? (
                                <>
                                    <button type="button" className="wjrm-btn" disabled={sending} onClick={submitOrder}>
                                        {sending ? "Enviando…" : `Confirmar pedido — ${fmt(total, symbol)}`}
                                    </button>
                                    <button type="button" className="wjrm-btn-ghost" onClick={() => setStage("cart")}>Volver al carrito</button>
                                </>
                            ) : null}
                            {stage === "done" ? (
                                <button type="button" className="wjrm-btn-ghost" onClick={() => { setOpen(false); setStage("cart"); }}>Cerrar</button>
                            ) : null}
                        </div>
                    </div>
                </>
            ) : null}
        </div>
    );
}
