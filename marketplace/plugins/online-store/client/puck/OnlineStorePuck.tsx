// @ts-nocheck
"use client";

/**
 * Puck blocks for the Online Store plugin v2 (multi-block export):
 *   - OnlineStore  — catalog grid + filters + product detail deep link (?producto=<slug>) with
 *                    gallery + variant selector + client-side SEO, cart drawer and a checkout
 *                    step with shipping method (pickup / zones / flat) + tax preview.
 *   - StoreOrders  — "Mis pedidos": order history for the logged-in account (strong user_id link
 *                    captured at checkout) with a guest fallback that looks up a single order by
 *                    its tracking token.
 *
 * Runs in the editor iframe AND on the public page: all data arrives via client-mount fetches
 * against the plugin's endpoints, guarded with res.ok (an inactive plugin 404s — the blocks
 * degrade to a quiet Spanish placeholder instead of crashing the page).
 *
 * Money: the server only ever receives ids + quantities + a shipping method choice; every price
 * shown here is a display convenience — totals are recomputed server-side at checkout. Cart state
 * lives in localStorage under 'wjstore_cart' (v2 lines carry variant_id; v1 lines hydrate as
 * variant_id 0 and stay valid).
 *
 * SEO: the detail view syncs document.title, meta description, og:* tags, a canonical link and a
 * JSON-LD Product snippet client-side. Google renders JS so this indexes; social scrapers that
 * skip JS will fall back to the page's own SSR meta — a documented platform limit (plugin blocks
 * have no SSR data pass).
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
.wjst-card-img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block; background: #f3f4f6; cursor: pointer; }
.wjst-card-noimg { width: 100%; aspect-ratio: 4 / 3; display: flex; align-items: center; justify-content: center; background: #f3f4f6; color: #9ca3af; font-size: 2rem; cursor: pointer; }
.wjst-card-body { padding: .9rem; display: flex; flex-direction: column; gap: .4rem; flex: 1; }
.wjst-chip { display: inline-block; align-self: flex-start; font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; background: #eef2ff; color: #4338ca; border-radius: 999px; padding: .15rem .6rem; }
.wjst-name { font-weight: 700; font-size: 1rem; line-height: 1.3; margin: 0; cursor: pointer; }
.wjst-name:hover { text-decoration: underline; }
.wjst-desc { font-size: .82rem; color: var(--wjs-color-text-muted, #6b7280); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wjst-price { font-weight: 800; font-size: 1.05rem; margin-top: auto; }
.wjst-price small { font-weight: 600; font-size: .72rem; color: var(--wjs-color-text-muted, #6b7280); }
.wjst-btn { border: none; cursor: pointer; border-radius: .6rem; padding: .55rem .9rem; font-weight: 700; font-size: .85rem; background: var(--wjs-color-primary, #111827); color: #fff; transition: opacity .15s; }
.wjst-btn:hover { opacity: .85; }
.wjst-btn:disabled { background: #d1d5db; color: #6b7280; cursor: not-allowed; }
.wjst-btn-ghost { background: transparent; color: var(--wjs-color-text, #111827); border: 1px solid var(--wjs-border-subtle, #d1d5db); }
.wjst-toolbar { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-bottom: 1rem; }
.wjst-search { flex: 1 1 220px; max-width: 340px; padding: .55rem .9rem; border: 1px solid var(--wjs-border-subtle, #d1d5db); border-radius: .6rem; font-size: .9rem; }
.wjst-sort { padding: .55rem .7rem; border: 1px solid var(--wjs-border-subtle, #d1d5db); border-radius: .6rem; font-size: .85rem; background: var(--wjs-bg-surface, #fff); color: inherit; }
.wjst-cats { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: 1rem; }
.wjst-cat { border: 1px solid var(--wjs-border-subtle, #d1d5db); background: transparent; color: inherit; border-radius: 999px; padding: .3rem .8rem; font-size: .8rem; font-weight: 700; cursor: pointer; }
.wjst-cat.on { background: var(--wjs-color-primary, #111827); color: #fff; border-color: transparent; }
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
.wjst-line-variant { font-size: .72rem; color: #6b7280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
.wjst-field input, .wjst-field textarea, .wjst-field select { width: 100%; padding: .55rem .7rem; border: 1px solid #d1d5db; border-radius: .5rem; font-size: .9rem; background: #fff; color: #111827; }
.wjst-pay { display: flex; flex-direction: column; gap: .45rem; margin: .6rem 0 .8rem; }
.wjst-pay label { display: flex; align-items: center; gap: .5rem; font-size: .88rem; cursor: pointer; border: 1px solid #e5e7eb; border-radius: .5rem; padding: .55rem .7rem; }
.wjst-pay small { color: #6b7280; margin-left: auto; font-weight: 700; }
.wjst-banner { border-radius: .6rem; padding: .8rem 1rem; font-size: .9rem; font-weight: 600; margin-bottom: 1rem; }
.wjst-banner-ok { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
.wjst-banner-warn { background: #fffbeb; color: #b45309; border: 1px solid #fde68a; }
.wjst-token { font-family: monospace; font-size: .95rem; background: #f3f4f6; border-radius: .5rem; padding: .5rem .7rem; word-break: break-all; margin: .5rem 0; }
.wjst-success { text-align: center; padding: 1rem .3rem; }
.wjst-success h4 { margin: .3rem 0 .6rem; font-size: 1.15rem; }
.wjst-success p { font-size: .88rem; color: #4b5563; line-height: 1.5; }
.wjst-detail { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 1.6rem; }
@media (max-width: 767.98px) { .wjst-detail { grid-template-columns: 1fr; } }
.wjst-back { border: none; background: transparent; color: var(--wjs-color-primary, #2563eb); cursor: pointer; font-weight: 700; font-size: .88rem; padding: 0; margin-bottom: 1rem; }
.wjst-gal-main { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: var(--wjs-radius, .75rem); background: #f3f4f6; border: 1px solid var(--wjs-border-subtle, #e5e7eb); }
.wjst-gal-thumbs { display: flex; gap: .5rem; margin-top: .6rem; flex-wrap: wrap; }
.wjst-gal-thumb { width: 64px; height: 64px; object-fit: cover; border-radius: .5rem; background: #f3f4f6; cursor: pointer; border: 2px solid transparent; }
.wjst-gal-thumb.on { border-color: var(--wjs-color-primary, #111827); }
.wjst-d-name { font-size: 1.5rem; font-weight: 800; margin: 0 0 .3rem; line-height: 1.2; }
.wjst-d-price { font-size: 1.3rem; font-weight: 800; margin: .5rem 0; }
.wjst-d-desc { font-size: .92rem; color: var(--wjs-color-text-muted, #4b5563); line-height: 1.6; white-space: pre-line; margin: .8rem 0; }
.wjst-vars { display: flex; flex-wrap: wrap; gap: .45rem; margin: .6rem 0 .9rem; }
.wjst-var { border: 1px solid var(--wjs-border-subtle, #d1d5db); background: transparent; color: inherit; border-radius: .55rem; padding: .45rem .8rem; font-size: .85rem; font-weight: 700; cursor: pointer; }
.wjst-var.on { border-color: var(--wjs-color-primary, #111827); background: var(--wjs-color-primary, #111827); color: #fff; }
.wjst-var.off { opacity: .45; text-decoration: line-through; cursor: not-allowed; }
.wjst-d-row { display: flex; gap: .6rem; align-items: center; margin-top: .6rem; }
.wjst-d-qty { width: 74px; padding: .5rem .6rem; border: 1px solid #d1d5db; border-radius: .55rem; font-size: .95rem; text-align: center; }
.wjst-stockline { font-size: .8rem; color: var(--wjs-color-text-muted, #6b7280); margin-top: .5rem; }
.wjst-orders { display: flex; flex-direction: column; gap: .8rem; }
.wjst-order { border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, .75rem); padding: .9rem 1rem; background: var(--wjs-bg-surface, #fff); }
.wjst-order-head { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: baseline; justify-content: space-between; }
.wjst-order-id { font-weight: 800; }
.wjst-order-date { font-size: .8rem; color: var(--wjs-color-text-muted, #6b7280); }
.wjst-pills { display: flex; gap: .4rem; flex-wrap: wrap; }
.wjst-pill { font-size: .68rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; border-radius: 999px; padding: .2rem .6rem; }
.wjst-pill-blue { background: #dbeafe; color: #1d4ed8; }
.wjst-pill-amber { background: #fef3c7; color: #b45309; }
.wjst-pill-green { background: #d1fae5; color: #047857; }
.wjst-pill-gray { background: #e5e7eb; color: #6b7280; }
.wjst-pill-purple { background: #ede9fe; color: #6d28d9; }
.wjst-pill-rose { background: #ffe4e6; color: #be123c; }
.wjst-order-items { font-size: .84rem; color: var(--wjs-color-text-muted, #4b5563); margin: .4rem 0; line-height: 1.5; }
.wjst-order-total { font-weight: 800; }
.wjst-order-token { font-size: .74rem; color: var(--wjs-color-text-muted, #9ca3af); font-family: monospace; margin-top: .3rem; word-break: break-all; }
`;

// ---- module-level cart helpers (localStorage, guarded for SSR) --------------------------------
// v2 lines: { id, variant_id, name, variant_name, price_cents, image_url, qty }.
// v1 lines (no variant_id) hydrate as variant_id 0 and stay valid.
function readCart() {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(CART_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr)) return [];
        return arr
            .filter((l) => l && Number(l.id) > 0 && Number(l.qty) > 0)
            .map((l) => ({ ...l, variant_id: Number(l.variant_id) || 0, variant_name: l.variant_name || "" }));
    } catch (e) {
        return [];
    }
}
function writeCart(cart) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(CART_KEY, JSON.stringify(cart));
        // Notify other OnlineStore blocks in the SAME document (the native 'storage' event only
        // fires in OTHER tabs), so two blocks on one page stay in sync instead of clobbering.
        window.dispatchEvent(new CustomEvent("wjstore-cart-sync"));
    } catch (e) {
        /* storage unavailable — cart stays in memory */
    }
}
const lineKey = (l) => `${Number(l.id)}:${Number(l.variant_id) || 0}`;

const fmt = (cents, symbol) => `${symbol || "$"}${((Number(cents) || 0) / 100).toFixed(2)}`;
const fmtBp = (bp) => `${((Number(bp) || 0) / 100).toFixed(2).replace(/\.00$/, "")}%`;

const STATUS_LABELS = { new: "Nuevo", processing: "En proceso", shipped: "Enviado", completed: "Completado", cancelled: "Cancelado" };
const STATUS_PILL = { new: "wjst-pill-blue", processing: "wjst-pill-amber", shipped: "wjst-pill-purple", completed: "wjst-pill-green", cancelled: "wjst-pill-gray" };
const PAY_LABELS = { pending: "Pago pendiente", paid: "Pagado", cancelled: "Pago cancelado", refunded: "Reembolsado" };
const PAY_PILL = { pending: "wjst-pill-amber", paid: "wjst-pill-green", cancelled: "wjst-pill-gray", refunded: "wjst-pill-rose" };

// Module-level components (never define a component inside a component).
function ProductCard({ product, symbol, showAdd, onAdd, onOpen }) {
    const out = !product.has_variants && product.stock === 0;
    const priceNode = product.has_variants && product.price_from_cents !== product.price_cents
        ? <span><small>Desde </small>{fmt(product.price_from_cents, symbol)}</span>
        : fmt(product.has_variants ? product.price_from_cents : product.price_cents, symbol);
    return (
        <div className="wjst-card">
            {product.image_url ? (
                <img className="wjst-card-img" src={product.image_url} alt={product.name} decoding="async" onClick={() => onOpen(product)} />
            ) : (
                <div className="wjst-card-noimg" aria-hidden="true" onClick={() => onOpen(product)}>&#128722;</div>
            )}
            <div className="wjst-card-body">
                {product.category ? <span className="wjst-chip">{product.category}</span> : null}
                <h3 className="wjst-name" onClick={() => onOpen(product)}>{product.name}</h3>
                {product.description ? <div className="wjst-desc">{product.description}</div> : null}
                <div className="wjst-price">{priceNode}</div>
                {showAdd && (
                    product.has_variants ? (
                        <button type="button" className="wjst-btn wjst-btn-ghost" onClick={() => onOpen(product)}>Ver opciones</button>
                    ) : (
                        <button type="button" className="wjst-btn" disabled={out} onClick={() => onAdd(product, null, 1)}>
                            {out ? "Agotado" : "Añadir al carrito"}
                        </button>
                    )
                )}
            </div>
        </div>
    );
}

/** Product detail view: gallery + variant selector + qty + add-to-cart + client-side SEO sync. */
function ProductDetail({ slug, symbol, currencyCode, showAdd, onAdd, onBack }) {
    const [product, setProduct] = useState(undefined); // undefined = loading, null = not found
    const [imgIdx, setImgIdx] = useState(0);
    const [variantId, setVariantId] = useState(0);
    const [qty, setQty] = useState(1);

    useEffect(() => {
        let alive = true;
        setProduct(undefined);
        setImgIdx(0);
        setVariantId(0);
        setQty(1);
        fetch(`${BASE}/public/product?slug=${encodeURIComponent(slug)}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => { if (alive) setProduct((data && data.product) || null); })
            .catch(() => { if (alive) setProduct(null); });
        return () => { alive = false; };
    }, [slug]);

    // Client-side SEO: title / meta description / og tags / canonical / JSON-LD Product.
    // Everything is restored or removed when the detail closes.
    useEffect(() => {
        if (typeof document === "undefined" || !product) return;
        const head = document.head;
        const prevTitle = document.title;
        // Guard against double-prepend if another instance/effect already stamped this product.
        const titlePrefix = `${product.name} — `;
        if (!document.title.startsWith(titlePrefix)) document.title = titlePrefix + document.title;
        const restores = [];
        const setMeta = (attr, key, content) => {
            let el = head.querySelector(`meta[${attr}="${key}"]`);
            if (el) {
                const prev = el.getAttribute("content");
                el.setAttribute("content", content);
                restores.push(() => el.setAttribute("content", prev == null ? "" : prev));
            } else {
                el = document.createElement("meta");
                el.setAttribute(attr, key);
                el.setAttribute("content", content);
                head.appendChild(el);
                restores.push(() => el.remove());
            }
        };
        const desc = String(product.description || product.name).replace(/\s+/g, " ").trim().slice(0, 200);
        const imgAbs = product.image_url ? new URL(product.image_url, window.location.origin).href : "";
        const canonicalUrl = (() => {
            const u = new URL(window.location.origin + window.location.pathname);
            u.searchParams.set("producto", product.slug);
            return u.href;
        })();
        setMeta("name", "description", desc);
        setMeta("property", "og:title", product.name);
        setMeta("property", "og:description", desc);
        setMeta("property", "og:type", "product");
        setMeta("property", "og:url", canonicalUrl);
        if (imgAbs) setMeta("property", "og:image", imgAbs);
        let canonical = head.querySelector('link[rel="canonical"]');
        if (canonical) {
            const prev = canonical.getAttribute("href");
            canonical.setAttribute("href", canonicalUrl);
            restores.push(() => canonical.setAttribute("href", prev == null ? "" : prev));
        } else {
            canonical = document.createElement("link");
            canonical.setAttribute("rel", "canonical");
            canonical.setAttribute("href", canonicalUrl);
            head.appendChild(canonical);
            restores.push(() => canonical.remove());
        }
        const ld = document.createElement("script");
        ld.type = "application/ld+json";
        const priceCents = (product.variants && product.variants.length) ? product.price_from_cents : product.price_cents;
        const anyStock = (product.variants && product.variants.length)
            ? product.variants.some((v) => v.stock !== 0)
            : product.stock !== 0;
        ld.text = JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Product",
            name: product.name,
            description: desc,
            ...(imgAbs ? { image: [imgAbs] } : {}),
            ...(product.category ? { category: product.category } : {}),
            offers: {
                "@type": "Offer",
                url: canonicalUrl,
                price: ((Number(priceCents) || 0) / 100).toFixed(2),
                priceCurrency: String(currencyCode || "usd").toUpperCase(),
                availability: anyStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
            },
        });
        head.appendChild(ld);
        restores.push(() => ld.remove());
        return () => {
            document.title = prevTitle;
            for (const r of restores.reverse()) { try { r(); } catch (e) { /* head changed under us */ } }
        };
        // currencyCode is a dep so a late store-config resolve re-runs the effect and the JSON-LD
        // priceCurrency corrects itself instead of being pinned to the initial "usd" default.
    }, [product && product.id, currencyCode]);

    if (product === undefined) return <div className="wjst-empty">Cargando producto…</div>;
    if (product === null) {
        return (
            <div>
                <button type="button" className="wjst-back" onClick={onBack}>&#8592; Volver a la tienda</button>
                <div className="wjst-empty">Producto no encontrado.</div>
            </div>
        );
    }

    const gallery = [];
    if (product.image_url) gallery.push({ url: product.image_url, alt: product.name });
    for (const im of product.images || []) {
        if (!gallery.some((g) => g.url === im.url)) gallery.push(im);
    }
    const mainImg = gallery[Math.min(imgIdx, Math.max(0, gallery.length - 1))];

    const variants = product.variants || [];
    const selected = variants.find((v) => v.id === variantId) || null;
    const needsVariant = variants.length > 0;
    const shownPrice = selected ? selected.price_cents : (needsVariant ? product.price_from_cents : product.price_cents);
    const selectedOut = selected ? selected.stock === 0 : (!needsVariant && product.stock === 0);
    const canAdd = showAdd && !selectedOut && (!needsVariant || !!selected);

    return (
        <div>
            <button type="button" className="wjst-back" onClick={onBack}>&#8592; Volver a la tienda</button>
            <div className="wjst-detail">
                <div>
                    {mainImg ? (
                        <img className="wjst-gal-main" src={mainImg.url} alt={mainImg.alt || product.name} decoding="async" />
                    ) : (
                        <div className="wjst-gal-main" style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: "3rem", color: "#9ca3af" }} aria-hidden="true">&#128722;</div>
                    )}
                    {gallery.length > 1 && (
                        <div className="wjst-gal-thumbs">
                            {gallery.map((g, i) => (
                                <img
                                    key={i}
                                    className={`wjst-gal-thumb${i === imgIdx ? " on" : ""}`}
                                    src={g.url}
                                    alt={g.alt || ""}
                                    decoding="async"
                                    onClick={() => setImgIdx(i)}
                                />
                            ))}
                        </div>
                    )}
                </div>
                <div>
                    {product.category ? <span className="wjst-chip">{product.category}</span> : null}
                    <h2 className="wjst-d-name">{product.name}</h2>
                    <div className="wjst-d-price">
                        {needsVariant && !selected ? <span><small style={{ fontWeight: 600, fontSize: ".78rem", color: "#6b7280" }}>Desde </small>{fmt(product.price_from_cents, symbol)}</span> : fmt(shownPrice, symbol)}
                    </div>
                    {needsVariant && (
                        <>
                            <div style={{ fontSize: ".8rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "#6b7280" }}>Opciones</div>
                            <div className="wjst-vars">
                                {variants.map((v) => (
                                    <button
                                        key={v.id}
                                        type="button"
                                        className={`wjst-var${v.id === variantId ? " on" : ""}${v.stock === 0 ? " off" : ""}`}
                                        disabled={v.stock === 0}
                                        onClick={() => setVariantId(v.id)}
                                        title={v.sku ? `SKU: ${v.sku}` : undefined}
                                    >
                                        {v.name}{v.price_cents !== product.price_cents ? ` · ${fmt(v.price_cents, symbol)}` : ""}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                    {showAdd && (
                        <div className="wjst-d-row">
                            <input
                                type="number"
                                className="wjst-d-qty"
                                min={1}
                                max={99}
                                value={qty}
                                onChange={(e) => setQty(Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1)))}
                                aria-label="Cantidad"
                            />
                            <button
                                type="button"
                                className="wjst-btn"
                                disabled={!canAdd}
                                onClick={() => onAdd(product, selected, qty)}
                                style={{ flex: 1 }}
                            >
                                {selectedOut ? "Agotado" : (needsVariant && !selected ? "Elige una opción" : "Añadir al carrito")}
                            </button>
                        </div>
                    )}
                    {selected && selected.stock >= 0 && (
                        <div className="wjst-stockline">{selected.stock === 0 ? "Sin stock" : `Quedan ${selected.stock} disponibles`}{selected.sku ? ` · SKU ${selected.sku}` : ""}</div>
                    )}
                    {!needsVariant && product.stock >= 0 && (
                        <div className="wjst-stockline">{product.stock === 0 ? "Sin stock" : `Quedan ${product.stock} disponibles`}</div>
                    )}
                    {product.description ? <div className="wjst-d-desc">{product.description}</div> : null}
                </div>
            </div>
        </div>
    );
}

// ======================================================================================
// Block 1: OnlineStore — catalog + detail + cart + checkout
// ======================================================================================

const onlineStoreDef = {
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
        showFilters: {
            type: "radio",
            label: "Filtros (categorías + orden)",
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
        showFilters: true,
        showCart: true,
        elementId: "",
    },
};

export default function OnlineStorePuck({ category, columns, showSearch, showFilters, showCart, elementId }) {
    const [products, setProducts] = useState(null); // null = loading, [] = loaded-empty
    const [cfg, setCfg] = useState(null);
    const [categories, setCategories] = useState([]);
    const [catFilter, setCatFilter] = useState("");
    const [sort, setSort] = useState("default");
    const [search, setSearch] = useState("");
    const [cart, setCart] = useState([]);
    const [open, setOpen] = useState(false);
    const [view, setView] = useState("cart"); // 'cart' | 'checkout' | 'success'
    const [detailSlug, setDetailSlug] = useState(null);
    const [loggedIn, setLoggedIn] = useState(false);

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
    const [shipOptions, setShipOptions] = useState(null); // /public/shipping-options payload
    const [shipMethod, setShipMethod] = useState("");     // 'pickup' | 'zone' | 'flat'
    const [shipZoneId, setShipZoneId] = useState(0);
    const [shipError, setShipError] = useState(false);
    const [shipReloadKey, setShipReloadKey] = useState(0);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState("");
    const [success, setSuccess] = useState(null); // { token, manualInstructions, pickupInstructions, warning }

    // Stripe return-leg banner: null | 'checking' | 'paid' | 'failed'
    const [payBanner, setPayBanner] = useState(null);

    // Load catalog + store config on mount / when filters change.
    useEffect(() => {
        let alive = true;
        const params = new URLSearchParams();
        const effCat = category || catFilter;
        if (effCat) params.set("category", effCat);
        if (sort && sort !== "default") params.set("sort", sort);
        params.set("limit", "200");
        fetch(`${BASE}/public/products?${params.toString()}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => { if (alive) setProducts((data && data.products) || []); })
            .catch(() => { if (alive) setProducts([]); });
        return () => { alive = false; };
    }, [category, catFilter, sort]);

    useEffect(() => {
        let alive = true;
        fetch(`${BASE}/public/store-config`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => { if (alive && data) setCfg(data); })
            .catch(() => { /* quiet — defaults below */ });
        if (showFilters !== false && !category) {
            fetch(`${BASE}/public/categories`)
                .then((res) => (res.ok ? res.json() : null))
                .then((data) => { if (alive && data) setCategories(data.categories || []); })
                .catch(() => { /* quiet */ });
        }
        // Session probe: 200 = logged in (checkout will link the order to the account).
        fetch(`${BASE}/my-orders`)
            .then((res) => { if (alive) setLoggedIn(res.ok); })
            .catch(() => { /* stay guest */ });
        return () => { alive = false; };
    }, [category, showFilters]);

    // Hydrate the cart from localStorage after mount (SSR-safe) and keep it in sync with other
    // tabs ('storage') and other blocks on the same page ('wjstore-cart-sync').
    useEffect(() => {
        setCart(readCart());
        if (typeof window === "undefined") return;
        const resync = (e) => { if (!e || e.type !== "storage" || e.key === CART_KEY) setCart(readCart()); };
        window.addEventListener("storage", resync);
        window.addEventListener("wjstore-cart-sync", resync);
        return () => {
            window.removeEventListener("storage", resync);
            window.removeEventListener("wjstore-cart-sync", resync);
        };
    }, []);

    // Deep link: ?producto=<slug> opens the detail view; back/forward stay in sync.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const read = () => {
            const params = new URLSearchParams(window.location.search);
            setDetailSlug(params.get("producto") || null);
        };
        read();
        window.addEventListener("popstate", read);
        return () => window.removeEventListener("popstate", read);
    }, []);
    const openProduct = (p) => {
        if (typeof window === "undefined" || !p.slug) return;
        const u = new URL(window.location.href);
        u.searchParams.set("producto", p.slug);
        window.history.pushState({}, "", u.toString());
        setDetailSlug(p.slug);
    };
    const closeProduct = () => {
        if (typeof window !== "undefined") {
            const u = new URL(window.location.href);
            u.searchParams.delete("producto");
            window.history.pushState({}, "", u.toString());
        }
        setDetailSlug(null);
    };

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

    // Shipping options load lazily when the checkout step opens.
    useEffect(() => {
        if (view !== "checkout" || shipOptions) return;
        let alive = true;
        setShipError(false);
        fetch(`${BASE}/public/shipping-options`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!alive) return;
                if (!data) { setShipError(true); return; }
                setShipOptions(data);
                if (Array.isArray(data.zones) && data.zones.length > 0) {
                    setShipMethod("zone");
                    setShipZoneId(data.zones[0].id);
                } else if (data.pickupEnabled && data.flatCents === null) {
                    setShipMethod("pickup");
                } else {
                    // Only legal when the store has NO active zones — the server enforces this too.
                    setShipMethod("flat");
                }
            })
            // Never silently fall back to 'flat': if the store has zones the server rejects it, so
            // surface a retry and keep the submit blocked until options actually load.
            .catch(() => { if (alive) setShipError(true); });
        return () => { alive = false; };
    }, [view, shipOptions, shipReloadKey]);

    const symbol = (cfg && cfg.currencySymbol) || "$";
    const stripeEnabled = !!(cfg && cfg.stripeEnabled);
    const taxLabel = (shipOptions && shipOptions.taxLabel) || (cfg && cfg.taxLabel) || "Impuestos";

    const subtotal = useMemo(() => cart.reduce((s, l) => s + (Number(l.price_cents) || 0) * (Number(l.qty) || 0), 0), [cart]);
    const discount = applied ? Math.min(Number(applied.discount_cents) || 0, subtotal) : 0;
    const goods = Math.max(0, subtotal - discount);

    // Shipping + tax PREVIEW (server recomputes authoritatively at checkout).
    const zones = (shipOptions && shipOptions.zones) || [];
    const selZone = zones.find((z) => Number(z.id) === Number(shipZoneId)) || null;
    let shipPreview = 0;
    if (!cart.length) shipPreview = 0;
    else if (shipMethod === "pickup") shipPreview = 0;
    else if (shipMethod === "zone" && selZone) {
        shipPreview = (Number(selZone.free_over_cents) >= 0 && goods >= Number(selZone.free_over_cents)) ? 0 : Number(selZone.rate_cents) || 0;
    } else {
        shipPreview = shipOptions && shipOptions.flatCents !== null && shipOptions.flatCents !== undefined
            ? Number(shipOptions.flatCents)
            : Number((cfg && cfg.shippingCents) || 0);
    }
    const taxBpPreview = (shipMethod === "zone" && selZone)
        ? Number(selZone.tax_rate_bp) || 0
        : Number((shipOptions && shipOptions.taxRateBp) ?? ((cfg && cfg.taxRateBp) || 0));
    const taxPreview = cart.length ? Math.round(goods * taxBpPreview / 10000) : 0;
    const total = goods + (cart.length ? shipPreview : 0) + taxPreview;
    const cartCount = cart.reduce((s, l) => s + (Number(l.qty) || 0), 0);

    // Re-check an applied coupon quietly whenever the subtotal changes (min-total may stop holding).
    // Debounced; only an EXPLICIT valid:false clears it (429/5xx keep the preview — checkout
    // re-validates server-side anyway).
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

    const addToCart = (product, variant, qty) => {
        const line = {
            id: product.id,
            variant_id: variant ? variant.id : 0,
            name: product.name,
            variant_name: variant ? variant.name : "",
            price_cents: variant ? variant.price_cents : product.price_cents,
            image_url: product.image_url || "",
            qty: Math.max(1, Math.min(99, Number(qty) || 1)),
        };
        const next = [...cart];
        const idx = next.findIndex((l) => lineKey(l) === lineKey(line));
        if (idx >= 0) next[idx] = { ...next[idx], qty: Math.min(99, (Number(next[idx].qty) || 0) + line.qty) };
        else next.push(line);
        updateCart(next);
        setOpen(true);
        setView("cart");
    };

    const changeQty = (key, delta) => {
        const next = cart
            .map((l) => (lineKey(l) === key ? { ...l, qty: Math.max(0, Math.min(99, (Number(l.qty) || 0) + delta)) } : l))
            .filter((l) => l.qty > 0);
        updateCart(next);
    };

    const removeLine = (key) => updateCart(cart.filter((l) => lineKey(l) !== key));

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
        const payload = {
            items: cart.map((l) => ({ product_id: Number(l.id), variant_id: Number(l.variant_id) || 0, qty: Number(l.qty) })),
            customer: { name: custName, email: custEmail, phone: custPhone, address: custAddress },
            coupon_code: applied ? applied.code : "",
            payment_method: payMethod,
            shipping: { method: shipMethod || "flat", zone_id: shipMethod === "zone" ? Number(shipZoneId) : undefined },
            page_url: pageUrl,
        };
        const post = (path) => fetch(`${BASE}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        // Logged-in customers post to the authed route so the order links to their account; any
        // auth-shaped failure falls back to the public route (order still created, just unlinked).
        (loggedIn ? post("/checkout-user") : post("/public/checkout"))
            .then(async (res) => {
                if (loggedIn && (res.status === 401 || res.status === 403 || res.status === 419)) {
                    return post("/public/checkout");
                }
                return res;
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
                    pickupInstructions: (data && data.pickupInstructions) || "",
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
    const filtersEnabled = showFilters !== false && !category;

    return (
        <div id={elementId || undefined} className="wjst-wrap">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />

            {payBanner === "paid" && <div className="wjst-banner wjst-banner-ok">&#10004; ¡Pago confirmado! Gracias por tu compra — recibirás un correo con los detalles.</div>}
            {payBanner === "checking" && <div className="wjst-banner wjst-banner-warn">Verificando tu pago…</div>}
            {payBanner === "failed" && <div className="wjst-banner wjst-banner-warn">No pudimos confirmar el pago todavía. Si ya pagaste, tu pedido se actualizará en breve.</div>}

            {detailSlug ? (
                <ProductDetail
                    slug={detailSlug}
                    symbol={symbol}
                    currencyCode={(cfg && cfg.currencyCode) || "usd"}
                    showAdd={cartEnabled}
                    onAdd={addToCart}
                    onBack={closeProduct}
                />
            ) : (
                <>
                    {(showSearch !== false || filtersEnabled) && (
                        <div className="wjst-toolbar">
                            {showSearch !== false && (
                                <input
                                    type="search"
                                    className="wjst-search"
                                    placeholder="Buscar productos…"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                />
                            )}
                            {filtersEnabled && (
                                <select className="wjst-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Ordenar">
                                    <option value="default">Orden destacado</option>
                                    <option value="newest">Novedades</option>
                                    <option value="price_asc">Precio: menor a mayor</option>
                                    <option value="price_desc">Precio: mayor a menor</option>
                                    <option value="name">Nombre A–Z</option>
                                </select>
                            )}
                        </div>
                    )}
                    {filtersEnabled && categories.length > 0 && (
                        <div className="wjst-cats">
                            <button type="button" className={`wjst-cat${catFilter === "" ? " on" : ""}`} onClick={() => setCatFilter("")}>Todo</button>
                            {categories.map((c) => (
                                <button
                                    key={c.name}
                                    type="button"
                                    className={`wjst-cat${catFilter === c.name ? " on" : ""}`}
                                    onClick={() => setCatFilter(c.name)}
                                >
                                    {c.name} ({c.count})
                                </button>
                            ))}
                        </div>
                    )}

                    {products === null ? (
                        <div className="wjst-empty">Cargando productos…</div>
                    ) : visible.length === 0 ? (
                        <div className="wjst-empty">No hay productos para mostrar.</div>
                    ) : (
                        <div className={`wjst-grid ${colClass}`}>
                            {visible.map((p) => (
                                <ProductCard key={p.id} product={p} symbol={symbol} showAdd={cartEnabled} onAdd={addToCart} onOpen={openProduct} />
                            ))}
                        </div>
                    )}
                </>
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
                                                <div className="wjst-line" key={lineKey(l)}>
                                                    {l.image_url ? (
                                                        <img className="wjst-line-img" src={l.image_url} alt={l.name} decoding="async" />
                                                    ) : (
                                                        <div className="wjst-line-img" aria-hidden="true" />
                                                    )}
                                                    <div className="wjst-line-info">
                                                        <p className="wjst-line-name">{l.name}</p>
                                                        {l.variant_name && <div className="wjst-line-variant">{l.variant_name}</div>}
                                                        <span className="wjst-line-price">{fmt(l.price_cents, symbol)} c/u</span>
                                                    </div>
                                                    <div className="wjst-qty">
                                                        <button type="button" aria-label="Menos" onClick={() => changeQty(lineKey(l), -1)}>&#8722;</button>
                                                        <span>{l.qty}</span>
                                                        <button type="button" aria-label="Más" onClick={() => changeQty(lineKey(l), 1)}>+</button>
                                                    </div>
                                                    <button type="button" className="wjst-remove" aria-label="Quitar" onClick={() => removeLine(lineKey(l))}>&#128465;</button>
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
                                                <div className="wjst-trow"><span>Envío e impuestos</span><span>se calculan al finalizar</span></div>
                                                <div className="wjst-trow"><strong>Total parcial</strong><strong>{fmt(goods, symbol)}</strong></div>
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

                                    {shipError && !shipOptions && (
                                        <div className="wjst-msg-err">
                                            No se pudieron cargar las opciones de envío.{" "}
                                            <button type="button" className="wjst-back" style={{ display: "inline" }} onClick={() => setShipReloadKey((k) => k + 1)}>Reintentar</button>
                                        </div>
                                    )}

                                    {/* ---- shipping method ---- */}
                                    {shipOptions && (zones.length > 0 || shipOptions.pickupEnabled) && (
                                        <div className="wjst-pay" role="radiogroup" aria-label="Método de entrega">
                                            {zones.length > 0 && (
                                                <label>
                                                    <input type="radio" name="wjst-ship" checked={shipMethod === "zone"} onChange={() => { setShipMethod("zone"); if (!selZone && zones[0]) setShipZoneId(zones[0].id); }} />
                                                    Envío a domicilio
                                                </label>
                                            )}
                                            {shipMethod === "zone" && zones.length > 0 && (
                                                <div className="wjst-field">
                                                    <select value={shipZoneId} onChange={(e) => setShipZoneId(Number(e.target.value))} aria-label="Zona de envío">
                                                        {zones.map((z) => (
                                                            <option key={z.id} value={z.id}>
                                                                {z.name} — {Number(z.rate_cents) > 0 ? fmt(z.rate_cents, symbol) : "gratis"}
                                                                {Number(z.free_over_cents) >= 0 ? ` (gratis desde ${fmt(z.free_over_cents, symbol)})` : ""}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>
                                            )}
                                            {zones.length === 0 && (
                                                <label>
                                                    <input type="radio" name="wjst-ship" checked={shipMethod === "flat"} onChange={() => setShipMethod("flat")} />
                                                    Envío a domicilio
                                                    <small>{Number(shipOptions.flatCents) > 0 ? fmt(shipOptions.flatCents, symbol) : "gratis"}</small>
                                                </label>
                                            )}
                                            {shipOptions.pickupEnabled && (
                                                <label>
                                                    <input type="radio" name="wjst-ship" checked={shipMethod === "pickup"} onChange={() => setShipMethod("pickup")} />
                                                    Recogida en tienda
                                                    <small>gratis</small>
                                                </label>
                                            )}
                                        </div>
                                    )}

                                    {shipMethod !== "pickup" && (
                                        <div className="wjst-field">
                                            <label>Dirección de envío</label>
                                            <textarea rows={2} value={custAddress} onChange={(e) => setCustAddress(e.target.value)} maxLength={500} />
                                        </div>
                                    )}

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
                                        <div className="wjst-trow"><span>{shipMethod === "pickup" ? "Recogida en tienda" : "Envío"}</span><span>{shipPreview > 0 ? fmt(shipPreview, symbol) : "Gratis"}</span></div>
                                        {taxPreview > 0 && <div className="wjst-trow"><span>{taxLabel} ({fmtBp(taxBpPreview)})</span><span>{fmt(taxPreview, symbol)}</span></div>}
                                        <div className="wjst-trow"><strong>Total</strong><strong>{fmt(total, symbol)}</strong></div>
                                    </div>
                                    {loggedIn && <div className="wjst-msg-ok">El pedido quedará vinculado a tu cuenta.</div>}
                                    {submitError && <div className="wjst-msg-err">{submitError}</div>}
                                </div>
                                <div className="wjst-drawer-foot">
                                    <div style={{ display: "flex", gap: ".5rem" }}>
                                        <button type="button" className="wjst-btn wjst-btn-ghost" onClick={() => setView("cart")}>Volver</button>
                                        <button type="submit" className="wjst-btn" style={{ flex: 1 }} disabled={submitting || !shipOptions}>
                                            {submitting ? "Procesando…" : !shipOptions ? "Cargando envío…" : payMethod === "stripe" ? "Pagar con tarjeta" : "Confirmar pedido"}
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
                                    {success.pickupInstructions && (
                                        <>
                                            <p><strong>Recogida en tienda:</strong></p>
                                            <p>{success.pickupInstructions}</p>
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

// ======================================================================================
// Block 2: StoreOrders — "Mis pedidos" (account history + guest token lookup)
// ======================================================================================

const storeOrdersDef = {
    category: "Tienda",
    fields: {
        title: { type: "text", label: "Título (vacío = sin título)" },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        title: "Mis pedidos",
        elementId: "",
    },
};

function OrderSummaryCard({ order, symbol, taxLabel }) {
    const items = order.items || [];
    return (
        <div className="wjst-order">
            <div className="wjst-order-head">
                <span className="wjst-order-id">Pedido #{order.orderNumber}</span>
                <span className="wjst-order-date">{String(order.created_at || "").slice(0, 16)}</span>
                <div className="wjst-pills">
                    <span className={`wjst-pill ${PAY_PILL[order.payment_status] || "wjst-pill-gray"}`}>{PAY_LABELS[order.payment_status] || order.payment_status}</span>
                    <span className={`wjst-pill ${STATUS_PILL[order.status] || "wjst-pill-gray"}`}>{STATUS_LABELS[order.status] || order.status}</span>
                </div>
            </div>
            <div className="wjst-order-items">
                {items.map((i, idx) => (
                    <div key={idx}>{i.name}{i.variant_name ? ` (${i.variant_name})` : ""} &#215;{i.qty} — {fmt(i.price_cents * i.qty, symbol)}</div>
                ))}
            </div>
            <div className="wjst-totals" style={{ paddingTop: ".2rem" }}>
                {order.discount_cents > 0 && <div className="wjst-trow"><span>Descuento</span><span>-{fmt(order.discount_cents, symbol)}</span></div>}
                <div className="wjst-trow">
                    <span>{order.shipping_method === "pickup" ? "Recogida en tienda" : `Envío${order.shipping_zone_name ? ` (${order.shipping_zone_name})` : ""}`}</span>
                    <span>{order.shipping_cents > 0 ? fmt(order.shipping_cents, symbol) : "Gratis"}</span>
                </div>
                {order.tax_cents > 0 && <div className="wjst-trow"><span>{taxLabel} ({fmtBp(order.tax_rate_bp)})</span><span>{fmt(order.tax_cents, symbol)}</span></div>}
                <div className="wjst-trow"><span className="wjst-order-total">Total</span><span className="wjst-order-total">{fmt(order.total_cents, symbol)}</span></div>
                {order.refund_cents > 0 && <div className="wjst-trow" style={{ color: "#be123c" }}><span>Reembolsado</span><span>-{fmt(order.refund_cents, symbol)}</span></div>}
            </div>
            {order.token && <div className="wjst-order-token">Código de seguimiento: {order.token}</div>}
        </div>
    );
}

export function StoreOrdersPuck({ title, elementId }) {
    const [state, setState] = useState("loading"); // 'loading' | 'authed' | 'guest'
    const [orders, setOrders] = useState([]);
    const [cfg, setCfg] = useState(null);
    const [tokenInput, setTokenInput] = useState("");
    const [lookup, setLookup] = useState(null);      // publicOrder result
    const [lookupErr, setLookupErr] = useState("");
    const [looking, setLooking] = useState(false);

    useEffect(() => {
        let alive = true;
        fetch(`${BASE}/my-orders`)
            .then(async (res) => {
                if (!alive) return;
                if (res.ok) {
                    const data = await res.json().catch(() => null);
                    if (!alive) return;
                    setOrders((data && data.orders) || []);
                    setState("authed");
                } else {
                    setState("guest");
                }
            })
            .catch(() => { if (alive) setState("guest"); });
        fetch(`${BASE}/public/store-config`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => { if (alive && data) setCfg(data); })
            .catch(() => { /* defaults */ });
        return () => { alive = false; };
    }, []);

    const symbol = (cfg && cfg.currencySymbol) || "$";
    const taxLabel = (cfg && cfg.taxLabel) || "Impuestos";

    const doLookup = (e) => {
        e.preventDefault();
        const token = tokenInput.trim().toLowerCase();
        if (!/^[a-z0-9]{32}$/.test(token)) {
            setLookupErr("El código de seguimiento tiene 32 caracteres (letras y números).");
            return;
        }
        setLooking(true);
        setLookupErr("");
        setLookup(null);
        fetch(`${BASE}/public/order?token=${encodeURIComponent(token)}`)
            .then(async (res) => {
                const data = await res.json().catch(() => null);
                if (!res.ok) throw new Error((data && data.error) || "Pedido no encontrado.");
                return data;
            })
            .then((data) => { setLookup((data && data.order) || null); setLooking(false); })
            .catch((err) => { setLookupErr(err && err.message ? err.message : "Pedido no encontrado."); setLooking(false); });
    };

    return (
        <div id={elementId || undefined} className="wjst-wrap">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {title ? <h2 style={{ fontSize: "1.4rem", fontWeight: 800, margin: "0 0 1rem" }}>{title}</h2> : null}

            {state === "loading" && <div className="wjst-empty">Cargando…</div>}

            {state === "authed" && (
                orders.length === 0 ? (
                    <div className="wjst-empty">Aún no tienes pedidos vinculados a tu cuenta. Los pedidos que hagas estando conectado aparecerán aquí.</div>
                ) : (
                    <div className="wjst-orders">
                        {orders.map((o) => <OrderSummaryCard key={o.orderNumber} order={o} symbol={symbol} taxLabel={taxLabel} />)}
                    </div>
                )
            )}

            {state === "guest" && (
                <div>
                    <div className="wjst-empty" style={{ marginBottom: "1rem" }}>
                        Inicia sesión para ver el historial de pedidos de tu cuenta, o consulta un pedido con su código de seguimiento.
                    </div>
                    <form onSubmit={doLookup} style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
                        <input
                            type="text"
                            className="wjst-search"
                            style={{ maxWidth: "420px", fontFamily: "monospace" }}
                            placeholder="Código de seguimiento (32 caracteres)"
                            value={tokenInput}
                            onChange={(e) => setTokenInput(e.target.value)}
                            maxLength={32}
                        />
                        <button type="submit" className="wjst-btn" disabled={looking}>{looking ? "Buscando…" : "Consultar pedido"}</button>
                    </form>
                    {lookupErr && <div className="wjst-msg-err">{lookupErr}</div>}
                    {lookup && (
                        <div style={{ marginTop: "1rem" }}>
                            <OrderSummaryCard order={lookup} symbol={symbol} taxLabel={taxLabel} />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// Multi-block registration: the registry generator spreads this map into the Puck config.
// The key "OnlineStore" MUST keep its v1 name — existing pages reference it in their Puck data.
export const puckComponents = {
    OnlineStore: { ...onlineStoreDef, render: OnlineStorePuck },
    StoreOrders: { ...storeOrdersDef, render: StoreOrdersPuck },
};

// Kept for tooling that expects the single-block convention (the generator prefers
// `puckComponents` when it exists).
export const puckComponentDef = onlineStoreDef;
