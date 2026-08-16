// @ts-nocheck
"use client";

/**
 * Verso block "DigitalDownloads" — grid of downloadable products with a token-gated buy/download flow.
 *
 * Registered via manifest.frontend.versoComponents; the generated versoPluginRegistry composes
 * { ...versoComponentDef, render: default export }, so versoComponentDef must NOT carry a render.
 * Runs in the editor iframe AND on the public page, so all data arrives via client-mount fetches
 * against the plugin's PUBLIC endpoints, guarded with res.ok (an inactive plugin 404s — the block
 * degrades to a quiet Spanish placeholder instead of crashing the page).
 *
 * Flow: card button → mini email form → POST /public/order.
 *   - free product: order is created 'paid'; success view offers "Descargar ahora" (calls
 *     /public/download, which reveals the file URL only after the token checks pass).
 *   - paid product: order is created 'pending'; the view shows the manual-payment instructions
 *     and the order token; the admin marks it paid and the link is auto-emailed.
 * On mount, a ?dl=<token> URL param (from the emailed link) — or a locally stored recent order —
 * renders a status banner with a big download button when the order is paid.
 */

import React, { useEffect, useState } from "react";

const API = "/api/v1/plugin/digital-downloads";
const LS_KEY = "wjdd_last_order"; // plugin-prefixed localStorage key

const STYLES = `
.wjdd-wrap { width: 100%; }
.wjdd-grid { display: grid; gap: 1.25rem; }
.wjdd-cols-1 { grid-template-columns: 1fr; }
.wjdd-cols-2 { grid-template-columns: repeat(2, 1fr); }
.wjdd-cols-3 { grid-template-columns: repeat(3, 1fr); }
@media (max-width: 899.98px) { .wjdd-cols-3 { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 639.98px) { .wjdd-cols-2, .wjdd-cols-3 { grid-template-columns: 1fr; } }
.wjdd-card { display: flex; flex-direction: column; border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.75rem); background: var(--wjs-bg-surface, #fff); overflow: hidden; }
.wjdd-img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; display: block; background: #f3f4f6; }
.wjdd-body { padding: 1.1rem 1.2rem 1.3rem; display: flex; flex-direction: column; gap: .55rem; flex: 1; }
.wjdd-name { font-weight: 700; font-size: 1.05rem; line-height: 1.3; margin: 0; color: var(--wjs-color-text, #111827); }
.wjdd-desc { font-size: .88rem; color: var(--wjs-color-text-muted, #6b7280); margin: 0; line-height: 1.45; }
.wjdd-meta { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; margin-top: auto; padding-top: .5rem; }
.wjdd-price { font-weight: 800; font-size: 1rem; color: var(--wjs-color-text, #111827); }
.wjdd-price.wjdd-free { color: #059669; }
.wjdd-chip { font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: .2rem .55rem; border-radius: 999px; background: var(--wjs-bg-muted, #f3f4f6); color: var(--wjs-color-text-muted, #6b7280); }
.wjdd-btn { display: inline-block; border: none; cursor: pointer; font-weight: 800; font-size: .85rem; padding: .65rem 1.15rem; border-radius: .65rem; background: var(--wjs-color-primary, #111827); color: #fff; transition: opacity .15s; text-align: center; }
.wjdd-btn:hover { opacity: .85; }
.wjdd-btn:disabled { opacity: .5; cursor: default; }
.wjdd-btn-ghost { background: var(--wjs-bg-muted, #f3f4f6); color: var(--wjs-color-text, #374151); }
.wjdd-form { display: flex; flex-direction: column; gap: .55rem; margin-top: .35rem; }
.wjdd-input { width: 100%; padding: .6rem .8rem; border: 1px solid var(--wjs-border-subtle, #d1d5db); border-radius: .6rem; font-size: .9rem; background: var(--wjs-bg-surface, #fff); color: var(--wjs-color-text, #111827); }
.wjdd-hp { position: absolute; left: -9999px; top: -9999px; height: 1px; width: 1px; overflow: hidden; opacity: 0; }
.wjdd-note { font-size: .8rem; color: var(--wjs-color-text-muted, #6b7280); line-height: 1.45; margin: 0; }
.wjdd-error { font-size: .82rem; color: #dc2626; margin: 0; }
.wjdd-ok { font-size: .9rem; color: #059669; font-weight: 700; margin: 0; }
.wjdd-token { display: block; font-family: monospace; font-size: .82rem; background: var(--wjs-bg-muted, #f3f4f6); padding: .5rem .7rem; border-radius: .5rem; word-break: break-all; color: var(--wjs-color-text, #111827); }
.wjdd-instructions { white-space: pre-wrap; font-size: .85rem; background: var(--wjs-bg-muted, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); padding: .7rem .9rem; border-radius: .6rem; color: var(--wjs-color-text, #374151); margin: 0; }
.wjdd-banner { border: 2px solid var(--wjs-color-primary, #111827); border-radius: var(--wjs-radius, 0.75rem); padding: 1.2rem 1.4rem; margin-bottom: 1.25rem; background: var(--wjs-bg-surface, #fff); display: flex; flex-direction: column; gap: .6rem; }
.wjdd-banner h3 { margin: 0; font-size: 1.1rem; color: var(--wjs-color-text, #111827); }
.wjdd-banner .wjdd-btn { align-self: flex-start; font-size: 1rem; padding: .8rem 1.6rem; }
.wjdd-empty { padding: 2rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.5rem); font-size: .9rem; }
`;

// ---- localStorage helpers (module level) ----
function readStoredOrder() {
    try {
        if (typeof window === "undefined") return null;
        const raw = window.localStorage.getItem(LS_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}
function writeStoredOrder(order) {
    try {
        if (typeof window !== "undefined") window.localStorage.setItem(LS_KEY, JSON.stringify(order));
    } catch {
        // storage full / privacy mode — the on-screen token still covers the user
    }
}

function formatPrice(cents, symbol) {
    const n = Number(cents) || 0;
    return n === 0 ? "Gratis" : `${symbol || "$"}${(n / 100).toFixed(2)}`;
}

// Module-level component (never define a component inside a component — remounts steal focus).
function DownloadNow({ token, big }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [remaining, setRemaining] = useState(null);

    const go = async () => {
        setBusy(true); setError("");
        try {
            const res = await fetch(`${API}/public/download?token=${encodeURIComponent(token)}`);
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.url) {
                setError((data && data.error) || "No se pudo obtener la descarga. Intenta de nuevo.");
                return;
            }
            setRemaining(data.remaining);
            // The revealed URL is a public media-library file — navigate to start the download.
            if (typeof window !== "undefined") window.location.href = data.url;
        } catch {
            setError("Error de red. Intenta de nuevo.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div>
            <button type="button" className="wjdd-btn" style={big ? undefined : { fontSize: ".85rem" }} onClick={go} disabled={busy}>
                {busy ? "Preparando…" : "Descargar ahora"}
            </button>
            {remaining !== null && <p className="wjdd-note" style={{ marginTop: ".45rem" }}>Te quedan {remaining} descargas con este enlace.</p>}
            {error && <p className="wjdd-error" style={{ marginTop: ".45rem" }}>{error}</p>}
        </div>
    );
}

export const versoComponentDef = {
    category: "Tienda",
    fields: {
        productSlug: { type: "text", label: "Slug del producto (vacío = todos)" },
        columns: {
            type: "radio",
            label: "Columnas",
            options: [
                { label: "1", value: 1 },
                { label: "2", value: 2 },
                { label: "3", value: 3 },
            ],
        },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        productSlug: "",
        columns: 3,
        elementId: "",
    },
};

export default function DigitalDownloadsVerso({ productSlug, columns, elementId }) {
    const [data, setData] = useState(null); // null = loading; {products, currencySymbol} | false = failed
    const [banner, setBanner] = useState(null); // { token, status } from ?dl= or stored order
    // Purchase flow: null | { productId, stage: 'form' | 'done', result }
    const [flow, setFlow] = useState(null);
    const [formName, setFormName] = useState("");
    const [formEmail, setFormEmail] = useState("");
    const [hp, setHp] = useState(""); // honeypot — humans never see or fill it
    const [openedAt, setOpenedAt] = useState(0);
    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState("");

    // Load the public product list (never includes file URLs).
    useEffect(() => {
        let alive = true;
        const p = new URLSearchParams();
        const slug = String(productSlug || "").trim();
        if (slug) p.set("slug", slug);
        p.set("limit", "60");
        fetch(`${API}/public/products?${p.toString()}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((d) => {
                if (!alive) return;
                if (d && Array.isArray(d.products)) setData(d);
                else setData(false);
            })
            .catch(() => { if (alive) setData(false); });
        return () => { alive = false; };
    }, [productSlug]);

    // ?dl=<token> from the emailed link — or a recent order stored locally (refresh-safe).
    useEffect(() => {
        if (typeof window === "undefined") return;
        let token = "";
        try { token = new URLSearchParams(window.location.search).get("dl") || ""; } catch { token = ""; }
        if (!token) {
            const stored = readStoredOrder();
            if (stored && stored.token && Date.now() - (stored.ts || 0) < 30 * 24 * 60 * 60 * 1000) token = stored.token;
        }
        if (!/^[A-Za-z0-9]{32}$/.test(token)) return;
        let alive = true;
        fetch(`${API}/public/status?token=${encodeURIComponent(token)}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((st) => { if (alive && st && st.payment_status) setBanner({ token, status: st }); })
            .catch(() => { /* quiet — the grid still renders */ });
        return () => { alive = false; };
    }, []);

    const openForm = (product) => {
        setFlow({ productId: product.id, stage: "form" });
        setFormName(""); setFormEmail(""); setHp(""); setFormError("");
        setOpenedAt(Date.now());
    };

    const submitOrder = async (e, product) => {
        e.preventDefault();
        const email = formEmail.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setFormError("Escribe un correo electrónico válido."); return; }
        setSubmitting(true); setFormError("");
        try {
            const body = {
                product_id: product.id,
                customer_name: formName.trim(),
                customer_email: email,
                hp,
                elapsed: Date.now() - openedAt,
                page_url: typeof window !== "undefined" ? window.location.pathname : "/",
            };
            const res = await fetch(`${API}/public/order`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const result = await res.json().catch(() => null);
            if (!res.ok || !result || !result.success) {
                setFormError((result && result.error) || "No se pudo procesar la solicitud. Intenta de nuevo.");
                return;
            }
            if (result.token) writeStoredOrder({ token: result.token, free: !!result.free, ts: Date.now() });
            setFlow({ productId: product.id, stage: "done", result });
        } catch {
            setFormError("Error de red. Intenta de nuevo.");
        } finally {
            setSubmitting(false);
        }
    };

    const cols = [1, 2, 3].includes(Number(columns)) ? Number(columns) : 3;
    const symbol = (data && data.currencySymbol) || "$";
    const products = (data && data.products) || [];

    return (
        <div id={elementId || undefined} className="wjdd-wrap">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />

            {banner && (
                <div className="wjdd-banner">
                    <h3>{banner.status.product_name || "Tu pedido"}</h3>
                    {banner.status.payment_status === "paid" ? (
                        <>
                            <p className="wjdd-note">
                                Tu descarga está lista{banner.status.expires_at ? ` — el enlace caduca el ${new Date(banner.status.expires_at).toLocaleDateString()}` : ""}.
                                Descargas disponibles: {banner.status.remaining}.
                            </p>
                            <DownloadNow token={banner.token} big />
                        </>
                    ) : (
                        <p className="wjdd-note">
                            Tu pago está <strong>pendiente de confirmación</strong>. En cuanto lo confirmemos recibirás el enlace de descarga por correo.
                        </p>
                    )}
                </div>
            )}

            {data === null ? (
                <div className="wjdd-empty">Cargando productos…</div>
            ) : data === false ? (
                <div className="wjdd-empty">No se pudieron cargar los productos.</div>
            ) : products.length === 0 ? (
                <div className="wjdd-empty">
                    No hay productos disponibles{String(productSlug || "").trim() ? " con ese slug — revísalo en Admin → Descargas Digitales" : " — crea uno en Admin → Descargas Digitales"}.
                </div>
            ) : (
                <div className={`wjdd-grid wjdd-cols-${cols}`}>
                    {products.map((p) => {
                        const isFree = (Number(p.price_cents) || 0) === 0;
                        const active = flow && flow.productId === p.id;
                        return (
                            <div key={p.id} className="wjdd-card">
                                {p.image_url && (
                                    <img src={p.image_url} alt={p.name} className="wjdd-img" decoding="async" />
                                )}
                                <div className="wjdd-body">
                                    <h3 className="wjdd-name">{p.name}</h3>
                                    {p.description && <p className="wjdd-desc">{p.description}</p>}
                                    <div className="wjdd-meta">
                                        <span className={`wjdd-price${isFree ? " wjdd-free" : ""}`}>{formatPrice(p.price_cents, symbol)}</span>
                                        {p.file_label && <span className="wjdd-chip">{p.file_label}</span>}
                                    </div>

                                    {!active && (
                                        <button type="button" className="wjdd-btn" onClick={() => openForm(p)}>
                                            {isFree ? "Descargar gratis" : "Comprar"}
                                        </button>
                                    )}

                                    {active && flow.stage === "form" && (
                                        <form className="wjdd-form" onSubmit={(e) => submitOrder(e, p)}>
                                            <input
                                                type="text" className="wjdd-input" placeholder="Tu nombre (opcional)"
                                                value={formName} onChange={(e) => setFormName(e.target.value)} maxLength={200}
                                            />
                                            <input
                                                type="email" className="wjdd-input" placeholder="Tu correo electrónico" required
                                                value={formEmail} onChange={(e) => setFormEmail(e.target.value)} maxLength={254}
                                            />
                                            {/* Honeypot: hidden from humans; bots that fill it get silently dropped. */}
                                            <div className="wjdd-hp" aria-hidden="true">
                                                <input type="text" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} placeholder="website" />
                                            </div>
                                            {formError && <p className="wjdd-error">{formError}</p>}
                                            <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
                                                <button type="submit" className="wjdd-btn" disabled={submitting}>
                                                    {submitting ? "Enviando…" : isFree ? "Recibir descarga" : "Realizar pedido"}
                                                </button>
                                                <button type="button" className="wjdd-btn wjdd-btn-ghost" onClick={() => setFlow(null)} disabled={submitting}>
                                                    Cancelar
                                                </button>
                                            </div>
                                        </form>
                                    )}

                                    {active && flow.stage === "done" && flow.result && (
                                        flow.result.free ? (
                                            <div className="wjdd-form">
                                                <p className="wjdd-ok">¡Listo! {flow.result.emailSent ? "Revisa tu correo — te enviamos el enlace." : "Tu descarga está lista."}</p>
                                                {flow.result.token && <DownloadNow token={flow.result.token} />}
                                            </div>
                                        ) : (
                                            <div className="wjdd-form">
                                                <p className="wjdd-ok">Pedido recibido.</p>
                                                {flow.result.manualInstructions ? (
                                                    <p className="wjdd-instructions">{flow.result.manualInstructions}</p>
                                                ) : (
                                                    <p className="wjdd-note">Te contactaremos para completar el pago.</p>
                                                )}
                                                {flow.result.token && (
                                                    <>
                                                        <p className="wjdd-note">Tu código de pedido (guárdalo — sirve para consultar el estado):</p>
                                                        <span className="wjdd-token">{flow.result.token}</span>
                                                    </>
                                                )}
                                                <p className="wjdd-note">Cuando confirmemos tu pago recibirás el enlace de descarga por correo.</p>
                                            </div>
                                        )
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
