// @ts-nocheck
"use client";

/**
 * Puck block "OnlineStore" — product grid + client-side cart + checkout.
 *
 * Runs in the editor iframe AND on the public page: all data arrives via client-mount fetches
 * against the plugin's PUBLIC endpoints, guarded with res.ok (an inactive plugin 404s — the block
 * degrades to a quiet Spanish placeholder instead of crashing the page).
 *
 * Money: the server only ever receives product ids + quantities; every price shown here is a
 * display convenience — totals are recomputed server-side at checkout. Cart state lives in
 * localStorage under 'wjstore_cart'.
 */

import React, { useEffect, useMemo, useState } from "react";

const BASE = "/api/v1/plugin/online-store";
const CART_KEY = "wjstore_cart";

const STYLES = `
.wjst-wrap { font-family: var(--wjs-font-family-base, inherit); color: var(--wjs-color-text, #111827); }
.wjst-grid { display: grid; gap: 1rem; }
.wjst-cols-2 { grid-template-columns: repeat(2, 1fr); }
.wjst-cols-3 { grid-template-columns: repeat(3, 1fr); }
.wjst-cols-4 { grid-template-columns: repeat(4, 1fr); }
@media (max-width: 991.98px) { .wjst-cols-3, .wjst-cols-4 { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 575.98px) { .wjst-cols-2, .wjst-cols-3, .wjst-cols-4 { grid-template-columns: 1fr; } }
.wjst-card { border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.75rem); overflow: hidden; background: var(--wjs-bg-surface, #fff); display: flex; flex-direction: column; }
.wjst-card-img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block; background: #f3f4f6; }
.wjst-card-noimg { width: 100%; aspect-ratio: 4 / 3; display: flex; align-items: center; justify-content: center; background: #f3f4f6; color: #9ca3af; font-size: 2rem; }
.wjst-card-body { padding: .9rem; display: flex; flex-direction: column; gap: .4rem; flex: 1; }
.wjst-chip { display: inline-block; align-self: flex-start; font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; background: #eef2ff; color: #4338ca; border-radius: 999px; padding: .15rem .6rem; }
.wjst-name { font-weight: 700; font-size: 1rem; line-height: 1.3; margin: 0; }
.wjst-desc { font-size: .82rem; color: var(--wjs-color-text-muted, #6b7280); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wjst-price { font-weight: 800; font-size: 1.05rem; margin-top: auto; }
.wjst-btn { border: none; cursor: pointer; border-radius: .6rem; padding: .55rem .9rem; font-weight: 700; font-size: .85rem; background: var(--wjs-color-primary, #111827); color: #fff; transition: opacity .15s; }
.wjst-btn:hover { opacity: .85; }
.wjst-btn:disabled { background: #d1d5db; color: #6b7280; cursor: not-allowed; }
.wjst-btn-ghost { background: transparent; color: var(--wjs-color-text, #111827); border: 1px solid var(--wjs-border-subtle, #d1d5db); }
.wjst-search { width: 100%; max-width: 340px; padding: .55rem .9rem; border: 1px solid var(--wjs-border-subtle, #d1d5db); border-radius: .6rem; font-size: .9rem; margin-bottom: 1rem; }
.wjst-empty { padding: 2rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.5rem); font-size: .9rem; }
.wjst-fab { position: fixed; right: 18px; bottom: 18px; z-index: 9000; width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer; background: var(--wjs-color-primary, #111827); color: #fff; font-size: 1.3rem; box-shadow: 0 6px 20px rgba(0,0,0,.25); display: flex; align-items: center; justify-content: center; }
.wjst-fab-count { position: absolute; top: -4px; right: -4px; min-width: 22px; height: 22px; border-radius: 999px; background: #dc2626; color: #fff; font-size: .72rem; font-weight: 800; display: flex; align-items: center; justify-content: center; padding: 0 5px; }
.wjst-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 9001; }
.wjst-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100vw); background: #fff; color: #111827; z-index: 9002; display: flex; flex-direction: column; box-shadow: -8px 0 30px rgba(0,0,0,.2); }
.wjst-drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.1rem; border-bottom: 1px solid #e5e7eb; }
.wjst-drawer-title { font-weight: 800; font-size: 1.05rem; margin: 0; }
.wjst-x { border: none; background: transparent; cursor: pointer; font-size: 1.3rem; line-height: 1; color: #6b7280; }
.wjst-drawer-body { flex: 1; overflow-y: auto; padding: 1rem 1.1rem; }
.wjst-line { display: flex; gap: .7rem; align-items: center; padding: .6rem 0; border-bottom: 1px solid #f3f4f6; }
.wjst-line-img { width: 52px; height: 52px; object-fit: cover; border-radius: .5rem; background: #f3f4f6; flex-shrink: 0; }
.wjst-line-info { flex: 1; min-width: 0; }
.wjst-line-name { font-weight: 700; font-size: .85rem; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wjst-line-price { font-size: .8rem; color: #6b7280; }
.wjst-qty { display: flex; align-items: center; gap: .35rem; }
.wjst-qty button { width: 24px; height: 24px; border-radius: .4rem; border: 1px solid #d1d5db; background: #fff; cursor: pointer; font-weight: 700; line-height: 1; }
.wjst-qty span { min-width: 22px; text-align: center; font-weight: 700; font-size: .85rem; }
.wjst-remove { border: none; background: transparent; color: #dc2626; cursor: pointer; font-size: .95rem; padding: .2rem; }
.wjst-totals { padding: .8rem 0 0; font-size: .9rem; display: flex; flex-direction: column; gap: .35rem; }
.wjst-trow { display: flex; justify-content: space-between; }
.wjst-trow strong { font-size: 1rem; }
.wjst-coupon { display: flex; gap: .5rem; margin-top: .8rem; }
.wjst-coupon input { flex: 1; padding: .5rem .7rem; border: 1px solid #d1d5db; border-radius: .5rem; font-size: .85rem; text-transform: uppercase; }
.wjst-msg-ok { font-size: .8rem; color: #047857; margin-top: .35rem; }
.wjst-msg-err { font-size: .8rem; color: #dc2626; margin-top: .35rem; }
.wjst-drawer-foot { padding: 1rem 1.1rem; border-top: 1px solid #e5e7eb; }
.wjst-field { margin-bottom: .7rem; }
.wjst-field label { display: block; font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; margin-bottom: .25rem; }
.wjst-field input, .wjst-field textarea { width: 100%; padding: .55rem .7rem; border: 1px solid #d1d5db; border-radius: .5rem; font-size: .9rem; }
.wjst-pay { display: flex; flex-direction: column; gap: .45rem; margin: .6rem 0 .8rem; }
.wjst-pay label { display: flex; align-items: center; gap: .5rem; font-size: .88rem; cursor: pointer; border: 1px solid #e5e7eb; border-radius: .5rem; padding: .55rem .7rem; }
.wjst-banner { border-radius: .6rem; padding: .8rem 1rem; font-size: .9rem; font-weight: 600; margin-bottom: 1rem; }
.wjst-banner-ok { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
.wjst-banner-warn { background: #fffbeb; color: #b45309; border: 1px solid #fde68a; }
.wjst-token { font-family: monospace; font-size: .95rem; background: #f3f4f6; border-radius: .5rem; padding: .5rem .7rem; word-break: break-all; margin: .5rem 0; }
.wjst-success { text-align: center; padding: 1rem .3rem; }
.wjst-success h4 { margin: .3rem 0 .6rem; font-size: 1.15rem; }
.wjst-success p { font-size: .88rem; color: #4b5563; line-height: 1.5; }
`;

// ---- module-level cart helpers (localStorage, guarded for SSR) --------------------------------
function readCart() {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(CART_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr)) return [];
        return arr.filter((l) => l && Number(l.id) > 0 && Number(l.qty) > 0);
    } catch (e) {
        return [];
    }
}
function writeCart(cart) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch (e) {
        /* storage unavailable — cart stays in memory */
    }
}

const fmt = (cents, symbol) => `${symbol || "$"}${((Number(cents) || 0) / 100).toFixed(2)}`;

// Module-level component (never define a component inside a component).
function ProductCard({ product, symbol, showAdd, onAdd }) {
    const out = product.stock === 0;
    return (
        <div className="wjst-card">
            {product.image_url ? (
                <img className="wjst-card-img" src={product.image_url} alt={product.name} decoding="async" />
            ) : (
                <div className="wjst-card-noimg" aria-hidden="true">&#128722;</div>
            )}
            <div className="wjst-card-body">
                {product.category ? <span className="wjst-chip">{product.category}</span> : null}
                <h3 className="wjst-name">{product.name}</h3>
                {product.description ? <div className="wjst-desc">{product.description}</div> : null}
                <div className="wjst-price">{fmt(product.price_cents, symbol)}</div>
                {showAdd && (
                    <button type="button" className="wjst-btn" disabled={out} onClick={() => onAdd(product)}>
                        {out ? "Agotado" : "Añadir al carrito"}
                    </button>
                )}
            </div>
        </div>
    );
}

export const puckComponentDef = {
    category: "Tienda",
    fields: {
        category: { type: "text", label: "Categoría (vacío = todas)" },
        columns: {
            type: "radio",
            label: "Columnas",
            options: [
                { label: "2", value: 2 },
                { label: "3", value: 3 },
                { label: "4", value: 4 },
            ],
        },
        showSearch: {
            type: "radio",
            label: "Buscador",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        showCart: {
            type: "radio",
            label: "Carrito",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        category: "",
        columns: 3,
        showSearch: true,
        showCart: true,
        elementId: "",
    },
};

export default function OnlineStorePuck({ category, columns, showSearch, showCart, elementId }) {
    const [products, setProducts] = useState(null); // null = loading, [] = loaded-empty
    const [cfg, setCfg] = useState(null);
    const [search, setSearch] = useState("");
    const [cart, setCart] = useState([]);
    const [open, setOpen] = useState(false);
    const [view, setView] = useState("cart"); // 'cart' | 'checkout' | 'success'

    // Coupon preview state (server re-validates + consumes at checkout).
    const [couponInput, setCouponInput] = useState("");
    const [applied, setApplied] = useState(null); // { code, discount_cents, message }
    const [couponMsg, setCouponMsg] = useState(null); // { ok, text }

    // Checkout form state.
    const [custName, setCustName] = useState("");
    const [custEmail, setCustEmail] = useState("");
    const [custPhone, setCustPhone] = useState("");
    const [custAddress, setCustAddress] = useState("");
    const [payMethod, setPayMethod] = useState("manual");
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState("");
    const [success, setSuccess] = useState(null); // { token, manualInstructions, warning }

    // Stripe return-leg banner: null | 'checking' | 'paid' | 'failed'
    const [payBanner, setPayBanner] = useState(null);

    // Load catalog + store config on mount / when the block's category changes.
    useEffect(() => {
        let alive = true;
        const params = new URLSearchParams();
        if (category) params.set("category", category);
        params.set("limit", "200");
        fetch(`${BASE}/public/products?${params.toString()}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => { if (alive) setProducts((data && data.products) || []); })
            .catch(() => { if (alive) setProducts([]); });
        fetch(`${BASE}/public/store-config`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => { if (alive && data) setCfg(data); })
            .catch(() => { /* quiet — defaults below */ });
        return () => { alive = false; };
    }, [category]);

    // Hydrate the cart from localStorage after mount (SSR-safe).
    useEffect(() => { setCart(readCart()); }, []);

    // Stripe return leg: ?session_id=...&order=<token> → confirm against the server.
    useEffect(() => {
        if (typeof window === "undefined") return;
        let alive = true;
        const params = new URLSearchParams(window.location.search);
        const sid = params.get("session_id");
        const order = params.get("order");
        if (!sid || !order) return;
        setPayBanner("checking");
        fetch(`${BASE}/public/confirm-stripe?session_id=${encodeURIComponent(sid)}&token=${encodeURIComponent(order)}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!alive) return;
                if (data && data.paid) {
                    setPayBanner("paid");
                    writeCart([]);
                    setCart([]);
                } else {
                    setPayBanner("failed");
                }
            })
            .catch(() => { if (alive) setPayBanner("failed"); });
        return () => { alive = false; };
    }, []);

    const symbol = (cfg && cfg.currencySymbol) || "$";
    const shipping = (cfg && Number(cfg.shippingCents)) || 0;
    const stripeEnabled = !!(cfg && cfg.stripeEnabled);

    const subtotal = useMemo(() => cart.reduce((s, l) => s + (Number(l.price_cents) || 0) * (Number(l.qty) || 0), 0), [cart]);
    const discount = applied ? Math.min(Number(applied.discount_cents) || 0, subtotal) : 0;
    const total = Math.max(0, subtotal - discount) + (cart.length ? shipping : 0);
    const cartCount = cart.reduce((s, l) => s + (Number(l.qty) || 0), 0);

    // Re-check an applied coupon quietly whenever the subtotal changes (min-total may stop holding).
    // Debounced so rapid +/- clicks don't burn the shared global rate budget; the coupon is only
    // cleared when the server EXPLICITLY answers valid:false — a 429/5xx/network failure keeps the
    // previous preview (checkout re-validates server-side anyway, so nothing is trusted from here).
    const appliedCode = applied ? applied.code : "";
    useEffect(() => {
        if (!appliedCode || subtotal <= 0) return;
        let alive = true;
        const timer = setTimeout(() => {
            fetch(`${BASE}/public/validate-coupon`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: appliedCode, subtotal_cents: subtotal }),
            })
                .then((res) => (res.ok ? res.json() : null))
                .then((data) => {
                    if (!alive || !data) return; // non-ok / transient — keep the previous preview
                    if (data.valid) setApplied({ code: appliedCode, discount_cents: data.discount_cents, message: data.message });
                    else { setApplied(null); setCouponMsg({ ok: false, text: data.message || "El cupón ya no aplica." }); }
                })
                .catch(() => { /* keep the previous preview */ });
        }, 500);
        return () => { alive = false; clearTimeout(timer); };
    }, [appliedCode, subtotal]);

    const updateCart = (next) => { setCart(next); writeCart(next); };

    const addToCart = (product) => {
        const next = [...cart];
        const idx = next.findIndex((l) => Number(l.id) === Number(product.id));
        if (idx >= 0) next[idx] = { ...next[idx], qty: Math.min(99, (Number(next[idx].qty) || 0) + 1) };
        else next.push({ id: product.id, name: product.name, price_cents: product.price_cents, image_url: product.image_url || "", qty: 1 });
        updateCart(next);
        setOpen(true);
        setView("cart");
    };

    const changeQty = (id, delta) => {
        const next = cart
            .map((l) => (Number(l.id) === Number(id) ? { ...l, qty: Math.max(0, Math.min(99, (Number(l.qty) || 0) + delta)) } : l))
            .filter((l) => l.qty > 0);
        updateCart(next);
    };

    const removeLine = (id) => updateCart(cart.filter((l) => Number(l.id) !== Number(id)));

    const applyCoupon = () => {
        const code = couponInput.trim().toUpperCase();
        if (!code) { setCouponMsg({ ok: false, text: "Ingresa un código de cupón." }); return; }
        fetch(`${BASE}/public/validate-coupon`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code, subtotal_cents: subtotal }),
        })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (data && data.valid) {
                    setApplied({ code, discount_cents: data.discount_cents, message: data.message });
                    setCouponMsg({ ok: true, text: data.message });
                } else {
                    setApplied(null);
                    setCouponMsg({ ok: false, text: (data && data.message) || "No se pudo validar el cupón." });
                }
            })
            .catch(() => setCouponMsg({ ok: false, text: "No se pudo validar el cupón." }));
    };

    const submitCheckout = (e) => {
        e.preventDefault();
        if (submitting || !cart.length) return;
        setSubmitting(true);
        setSubmitError("");
        const pageUrl = typeof window !== "undefined" ? window.location.origin + window.location.pathname : "";
        fetch(`${BASE}/public/checkout`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                items: cart.map((l) => ({ product_id: Number(l.id), qty: Number(l.qty) })),
                customer: { name: custName, email: custEmail, phone: custPhone, address: custAddress },
                coupon_code: applied ? applied.code : "",
                payment_method: payMethod,
                page_url: pageUrl,
            }),
        })
            .then(async (res) => {
                const data = await res.json().catch(() => null);
                if (!res.ok) throw new Error((data && data.error) || "No se pudo completar el pedido.");
                return data;
            })
            .then((data) => {
                if (data && data.checkoutUrl) {
                    // Keep the cart: if the customer cancels on Stripe, nothing is lost. It is
                    // cleared when the return leg confirms the payment.
                    if (typeof window !== "undefined") window.location.href = data.checkoutUrl;
                    return;
                }
                updateCart([]);
                setApplied(null);
                setCouponInput("");
                setSuccess({
                    token: (data && data.token) || "",
                    manualInstructions: (data && data.manualInstructions) || "",
                    warning: (data && data.warning) || "",
                });
                setView("success");
                setSubmitting(false);
            })
            .catch((err) => {
                setSubmitError(err && err.message ? err.message : "No se pudo completar el pedido.");
                setSubmitting(false);
            });
    };

    const visible = useMemo(() => {
        if (!Array.isArray(products)) return [];
        const q = search.trim().toLowerCase();
        if (!q) return products;
        return products.filter((p) => `${p.name} ${p.description || ""} ${p.category || ""}`.toLowerCase().includes(q));
    }, [products, search]);

    const colClass = columns === 2 ? "wjst-cols-2" : columns === 4 ? "wjst-cols-4" : "wjst-cols-3";
    const cartEnabled = showCart !== false;

    return (
        <div id={elementId || undefined} className="wjst-wrap">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />

            {payBanner === "paid" && <div className="wjst-banner wjst-banner-ok">&#10004; ¡Pago confirmado! Gracias por tu compra — recibirás un correo con los detalles.</div>}
            {payBanner === "checking" && <div className="wjst-banner wjst-banner-warn">Verificando tu pago…</div>}
            {payBanner === "failed" && <div className="wjst-banner wjst-banner-warn">No pudimos confirmar el pago todavía. Si ya pagaste, tu pedido se actualizará en breve.</div>}

            {showSearch !== false && (
                <input
                    type="search"
                    className="wjst-search"
                    placeholder="Buscar productos…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
            )}

            {products === null ? (
                <div className="wjst-empty">Cargando productos…</div>
            ) : visible.length === 0 ? (
                <div className="wjst-empty">No hay productos para mostrar.</div>
            ) : (
                <div className={`wjst-grid ${colClass}`}>
                    {visible.map((p) => (
                        <ProductCard key={p.id} product={p} symbol={symbol} showAdd={cartEnabled} onAdd={addToCart} />
                    ))}
                </div>
            )}

            {cartEnabled && (
                <button type="button" className="wjst-fab" aria-label="Abrir carrito" onClick={() => { setOpen(true); setView(success ? "success" : "cart"); }}>
                    &#128722;
                    {cartCount > 0 && <span className="wjst-fab-count">{cartCount}</span>}
                </button>
            )}

            {cartEnabled && open && (
                <>
                    <div className="wjst-overlay" onClick={() => setOpen(false)} />
                    <div className="wjst-drawer" role="dialog" aria-label="Carrito de compras">
                        <div className="wjst-drawer-head">
                            <h3 className="wjst-drawer-title">
                                {view === "cart" ? "Tu carrito" : view === "checkout" ? "Finalizar compra" : "Pedido recibido"}
                            </h3>
                            <button type="button" className="wjst-x" aria-label="Cerrar" onClick={() => setOpen(false)}>&#215;</button>
                        </div>

                        {view === "cart" && (
                            <>
                                <div className="wjst-drawer-body">
                                    {cart.length === 0 ? (
                                        <div className="wjst-empty">Tu carrito está vacío.</div>
                                    ) : (
                                        <>
                                            {cart.map((l) => (
                                                <div className="wjst-line" key={l.id}>
                                                    {l.image_url ? (
                                                        <img className="wjst-line-img" src={l.image_url} alt={l.name} decoding="async" />
                                                    ) : (
                                                        <div className="wjst-line-img" aria-hidden="true" />
                                                    )}
                                                    <div className="wjst-line-info">
                                                        <p className="wjst-line-name">{l.name}</p>
                                                        <span className="wjst-line-price">{fmt(l.price_cents, symbol)} c/u</span>
                                                    </div>
                                                    <div className="wjst-qty">
                                                        <button type="button" aria-label="Menos" onClick={() => changeQty(l.id, -1)}>&#8722;</button>
                                                        <span>{l.qty}</span>
                                                        <button type="button" aria-label="Más" onClick={() => changeQty(l.id, 1)}>+</button>
                                                    </div>
                                                    <button type="button" className="wjst-remove" aria-label="Quitar" onClick={() => removeLine(l.id)}>&#128465;</button>
                                                </div>
                                            ))}
                                            <div className="wjst-coupon">
                                                <input
                                                    type="text"
                                                    placeholder="Cupón"
                                                    value={couponInput}
                                                    onChange={(e) => setCouponInput(e.target.value)}
                                                />
                                                <button type="button" className="wjst-btn wjst-btn-ghost" onClick={applyCoupon}>Aplicar</button>
                                            </div>
                                            {couponMsg && <div className={couponMsg.ok ? "wjst-msg-ok" : "wjst-msg-err"}>{couponMsg.text}</div>}
                                            <div className="wjst-totals">
                                                <div className="wjst-trow"><span>Subtotal</span><span>{fmt(subtotal, symbol)}</span></div>
                                                {discount > 0 && <div className="wjst-trow"><span>Descuento ({applied ? applied.code : ""})</span><span>-{fmt(discount, symbol)}</span></div>}
                                                <div className="wjst-trow"><span>Envío</span><span>{shipping > 0 ? fmt(shipping, symbol) : "Gratis"}</span></div>
                                                <div className="wjst-trow"><strong>Total</strong><strong>{fmt(total, symbol)}</strong></div>
                                            </div>
                                        </>
                                    )}
                                </div>
                                <div className="wjst-drawer-foot">
                                    <button
                                        type="button"
                                        className="wjst-btn"
                                        style={{ width: "100%" }}
                                        disabled={cart.length === 0}
                                        onClick={() => { setSubmitError(""); setView("checkout"); }}
                                    >
                                        Finalizar compra
                                    </button>
                                </div>
                            </>
                        )}

                        {view === "checkout" && (
                            <form onSubmit={submitCheckout} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
                                <div className="wjst-drawer-body">
                                    <div className="wjst-field">
                                        <label>Nombre *</label>
                                        <input type="text" value={custName} onChange={(e) => setCustName(e.target.value)} required maxLength={200} />
                                    </div>
                                    <div className="wjst-field">
                                        <label>Correo electrónico *</label>
                                        <input type="email" value={custEmail} onChange={(e) => setCustEmail(e.target.value)} required maxLength={200} />
                                    </div>
                                    <div className="wjst-field">
                                        <label>Teléfono</label>
                                        <input type="tel" value={custPhone} onChange={(e) => setCustPhone(e.target.value)} maxLength={50} />
                                    </div>
                                    <div className="wjst-field">
                                        <label>Dirección de envío</label>
                                        <textarea rows={2} value={custAddress} onChange={(e) => setCustAddress(e.target.value)} maxLength={500} />
                                    </div>
                                    <div className="wjst-pay">
                                        <label>
                                            <input type="radio" name="wjst-pay" checked={payMethod === "manual"} onChange={() => setPayMethod("manual")} />
                                            Pago manual (transferencia / instrucciones)
                                        </label>
                                        {stripeEnabled && (
                                            <label>
                                                <input type="radio" name="wjst-pay" checked={payMethod === "stripe"} onChange={() => setPayMethod("stripe")} />
                                                Tarjeta (Stripe)
                                            </label>
                                        )}
                                    </div>
                                    <div className="wjst-totals">
                                        <div className="wjst-trow"><span>Subtotal</span><span>{fmt(subtotal, symbol)}</span></div>
                                        {discount > 0 && <div className="wjst-trow"><span>Descuento</span><span>-{fmt(discount, symbol)}</span></div>}
                                        <div className="wjst-trow"><span>Envío</span><span>{shipping > 0 ? fmt(shipping, symbol) : "Gratis"}</span></div>
                                        <div className="wjst-trow"><strong>Total</strong><strong>{fmt(total, symbol)}</strong></div>
                                    </div>
                                    {submitError && <div className="wjst-msg-err">{submitError}</div>}
                                </div>
                                <div className="wjst-drawer-foot">
                                    <div style={{ display: "flex", gap: ".5rem" }}>
                                        <button type="button" className="wjst-btn wjst-btn-ghost" onClick={() => setView("cart")}>Volver</button>
                                        <button type="submit" className="wjst-btn" style={{ flex: 1 }} disabled={submitting}>
                                            {submitting ? "Procesando…" : payMethod === "stripe" ? "Pagar con tarjeta" : "Confirmar pedido"}
                                        </button>
                                    </div>
                                </div>
                            </form>
                        )}

                        {view === "success" && success && (
                            <div className="wjst-drawer-body">
                                <div className="wjst-success">
                                    <div style={{ fontSize: "2rem" }} aria-hidden="true">&#127881;</div>
                                    <h4>¡Pedido recibido!</h4>
                                    {success.warning && <div className="wjst-banner wjst-banner-warn">{success.warning}</div>}
                                    <p>Guarda tu código de seguimiento — con él puedes consultar el estado de tu pedido:</p>
                                    <div className="wjst-token">{success.token}</div>
                                    {success.manualInstructions && (
                                        <>
                                            <p><strong>Instrucciones de pago:</strong></p>
                                            <p>{success.manualInstructions}</p>
                                        </>
                                    )}
                                    <p>También te enviamos un correo con el resumen del pedido.</p>
                                    <button type="button" className="wjst-btn" onClick={() => { setSuccess(null); setView("cart"); setOpen(false); }}>
                                        Seguir comprando
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
