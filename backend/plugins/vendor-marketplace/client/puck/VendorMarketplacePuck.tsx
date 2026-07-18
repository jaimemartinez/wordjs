// @ts-nocheck
"use client";

/**
 * Puck block "Marketplace" — public multi-vendor catalog + inline vendor portal.
 *
 * Registered via manifest.frontend.puckComponents; the generated puckPluginRegistry composes
 * { ...puckComponentDef, render: default export }, so puckComponentDef must NOT carry a render.
 * Runs in the editor iframe AND on the public page, so all data arrives via client-mount fetches
 * against the plugin's PUBLIC endpoints, guarded with res.ok (an inactive plugin 404s — the block
 * degrades to a quiet Spanish placeholder instead of crashing the page).
 *
 * Views (state-switched INSIDE the block, modeled on the conference-manager portal UX):
 *  - market:  product cards (vendor/category/search filter + inquiry modal) or vendor cards.
 *  - portal:  vendor login (store select + 6-digit code) -> own product CRUD + inquiries list.
 *    The session token also lives in localStorage (plugin-prefixed key) and is sent via the
 *    x-portal-token header — the HttpOnly namespaced cookie is the primary path.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

const API = "/api/v1/plugin/vendor-marketplace";
const TOKEN_KEY = "wjmk_portal_token";

// ---- module-level helpers (no component-inside-component; storage guarded for SSR) --------------
function readToken() {
    if (typeof window === "undefined") return "";
    try { return window.localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
function writeToken(t) {
    if (typeof window === "undefined") return;
    try {
        if (t) window.localStorage.setItem(TOKEN_KEY, t);
        else window.localStorage.removeItem(TOKEN_KEY);
    } catch { /* storage may be unavailable (private mode) — cookie still works */ }
}
function fmtMoney(cents, symbol) {
    return `${symbol || "$"}${((Number(cents) || 0) / 100).toFixed(2)}`;
}
async function jsonOrNull(res) {
    try { return await res.json(); } catch { return null; }
}
/** Portal fetch with the x-portal-token header (cookie rides along as a fallback). */
async function portalFetch(path, token, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (token) headers["x-portal-token"] = token;
    if (opts.body) headers["Content-Type"] = "application/json";
    const res = await fetch(API + path, { ...opts, headers });
    const data = await jsonOrNull(res);
    if (!res.ok) throw new Error((data && data.error) || "Error de conexión.");
    return data;
}

const INQUIRY_LABELS = { new: "Nueva", replied: "Respondida", closed: "Cerrada" };

const STYLES = `
.wjmk { font-family: inherit; color: var(--wjs-color-text, #1f2937); }
.wjmk * { box-sizing: border-box; }
.wjmk-grid { display: grid; gap: 1rem; grid-template-columns: 1fr; }
@media (min-width: 640px) { .wjmk-grid { grid-template-columns: repeat(2, minmax(0,1fr)); } }
@media (min-width: 1024px) {
  .wjmk-cols-2 { grid-template-columns: repeat(2, minmax(0,1fr)); }
  .wjmk-cols-3 { grid-template-columns: repeat(3, minmax(0,1fr)); }
  .wjmk-cols-4 { grid-template-columns: repeat(4, minmax(0,1fr)); }
}
.wjmk-card { border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, .75rem); overflow: hidden; background: var(--wjs-bg-surface, #fff); cursor: pointer; transition: box-shadow .15s ease, transform .15s ease; display: flex; flex-direction: column; }
.wjmk-card:hover { box-shadow: 0 8px 24px rgba(0,0,0,.08); transform: translateY(-2px); }
.wjmk-img { width: 100%; aspect-ratio: 4 / 3; background: #f3f4f6; display: flex; align-items: center; justify-content: center; overflow: hidden; color: #9ca3af; font-size: 2rem; }
.wjmk-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.wjmk-body { padding: .8rem .9rem 1rem; display: flex; flex-direction: column; gap: .35rem; flex: 1; }
.wjmk-name { font-weight: 700; font-size: 1rem; line-height: 1.3; margin: 0; }
.wjmk-price { font-weight: 800; font-size: 1.05rem; }
.wjmk-chip { display: inline-flex; align-items: center; gap: .3rem; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; background: #eef2ff; color: #4338ca; border-radius: 999px; padding: .15rem .6rem; width: fit-content; }
.wjmk-cat { font-size: .75rem; color: #6b7280; }
.wjmk-filter { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
.wjmk-input, .wjmk-select, .wjmk-textarea { border: 1px solid var(--wjs-border-subtle, #d1d5db); border-radius: .55rem; padding: .55rem .7rem; font-size: .9rem; background: var(--wjs-bg-surface, #fff); color: inherit; max-width: 100%; }
.wjmk-filter .wjmk-input { flex: 1 1 160px; }
.wjmk-filter .wjmk-select { flex: 0 1 180px; }
.wjmk-textarea { width: 100%; min-height: 90px; resize: vertical; }
.wjmk-btn { display: inline-flex; align-items: center; justify-content: center; gap: .4rem; border: none; border-radius: .6rem; background: var(--wjs-color-primary, #111827); color: #fff; font-weight: 700; font-size: .85rem; padding: .6rem 1.1rem; cursor: pointer; }
.wjmk-btn:disabled { opacity: .5; cursor: default; }
.wjmk-btn-ghost { background: transparent; color: inherit; border: 1px solid var(--wjs-border-subtle, #d1d5db); }
.wjmk-btn-sm { padding: .3rem .6rem; font-size: .75rem; border-radius: .45rem; }
.wjmk-btn-danger { background: #dc2626; }
.wjmk-empty { padding: 2rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, .75rem); font-size: .9rem; }
.wjmk-portal-row { margin-top: 1rem; text-align: right; }
.wjmk-portal-link { background: none; border: none; padding: 0; font-size: .82rem; color: var(--wjs-color-primary, #4338ca); text-decoration: underline; cursor: pointer; }
.wjmk-backdrop { position: fixed; inset: 0; background: rgba(17,24,39,.55); z-index: 9998; display: flex; align-items: center; justify-content: center; padding: 1rem; }
.wjmk-modal { background: var(--wjs-bg-surface, #fff); color: var(--wjs-color-text, #1f2937); border-radius: 1rem; max-width: 560px; width: 100%; max-height: 90vh; overflow-y: auto; padding: 1.25rem 1.25rem 1.5rem; position: relative; }
.wjmk-close { position: absolute; top: .6rem; right: .8rem; border: none; background: none; font-size: 1.4rem; cursor: pointer; color: #6b7280; line-height: 1; }
.wjmk-modal-img { width: 100%; aspect-ratio: 16 / 9; background: #f3f4f6; border-radius: .7rem; overflow: hidden; margin-bottom: .8rem; }
.wjmk-modal-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.wjmk-form { display: flex; flex-direction: column; gap: .6rem; margin-top: .8rem; }
.wjmk-form-row { display: flex; gap: .6rem; flex-wrap: wrap; }
.wjmk-form-row > * { flex: 1 1 140px; }
.wjmk-msg-ok { background: #ecfdf5; color: #047857; padding: .6rem .8rem; border-radius: .6rem; font-size: .85rem; }
.wjmk-msg-err { background: #fef2f2; color: #b91c1c; padding: .6rem .8rem; border-radius: .6rem; font-size: .85rem; }
.wjmk-hp { position: absolute; left: -9999px; top: -9999px; height: 1px; width: 1px; opacity: 0; }
.wjmk-vcard { text-align: center; align-items: center; padding-top: 1.2rem; cursor: default; }
.wjmk-logo { width: 84px; height: 84px; border-radius: 50%; background: #f3f4f6; overflow: hidden; display: flex; align-items: center; justify-content: center; font-size: 1.8rem; font-weight: 800; color: #9ca3af; margin: 0 auto; }
.wjmk-logo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.wjmk-portal { border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, .75rem); padding: 1.25rem; background: var(--wjs-bg-surface, #fff); }
.wjmk-portal-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .6rem; margin-bottom: 1rem; }
.wjmk-h { font-size: 1.15rem; font-weight: 800; margin: 0; }
.wjmk-sub { font-size: .8rem; color: #6b7280; margin: .15rem 0 0; }
.wjmk-table-wrap { overflow-x: auto; }
.wjmk-table { width: 100%; border-collapse: collapse; font-size: .85rem; }
.wjmk-table th { text-align: left; font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; padding: .45rem .6rem; border-bottom: 2px solid var(--wjs-border-subtle, #e5e7eb); }
.wjmk-table td { padding: .5rem .6rem; border-bottom: 1px solid var(--wjs-border-subtle, #f3f4f6); vertical-align: top; }
.wjmk-badge { display: inline-block; font-size: .68rem; font-weight: 800; text-transform: uppercase; padding: .12rem .5rem; border-radius: 999px; }
.wjmk-badge-new { background: #fef3c7; color: #92400e; }
.wjmk-badge-replied { background: #dbeafe; color: #1d4ed8; }
.wjmk-badge-closed { background: #e5e7eb; color: #4b5563; }
.wjmk-badge-on { background: #d1fae5; color: #047857; }
.wjmk-badge-off { background: #fee2e2; color: #b91c1c; }
.wjmk-section { margin-top: 1.4rem; }
.wjmk-actions { display: flex; gap: .35rem; flex-wrap: wrap; }
.wjmk-inq { border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: .7rem; padding: .8rem .9rem; margin-bottom: .6rem; }
.wjmk-inq p { margin: .35rem 0 0; font-size: .85rem; white-space: pre-wrap; }
.wjmk-inq-meta { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; font-size: .8rem; color: #6b7280; }
@media (max-width: 639.98px) { .wjmk-filter .wjmk-select { flex: 1 1 100%; } }
`;

// ---- product detail + inquiry modal --------------------------------------------------------------
function ProductModal({ product, symbol, onClose }) {
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [message, setMessage] = useState("");
    const [hp, setHp] = useState("");
    const [busy, setBusy] = useState(false);
    const [ok, setOk] = useState("");
    const [err, setErr] = useState("");
    // Anti-spam elapsed: measured from the moment the modal opened.
    const openedAtRef = useRef(Date.now());

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true); setErr(""); setOk("");
        try {
            const res = await fetch(`${API}/public/inquiry`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    product_id: product.id,
                    buyer_name: name,
                    buyer_email: email,
                    message,
                    hp,
                    elapsed: Date.now() - openedAtRef.current,
                }),
            });
            const data = await jsonOrNull(res);
            if (!res.ok) throw new Error((data && data.error) || "No se pudo enviar la consulta.");
            setOk((data && data.message) || "Consulta enviada. El vendedor te contactará pronto.");
            setName(""); setEmail(""); setMessage("");
        } catch (e2) {
            setErr(e2.message || "No se pudo enviar la consulta.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="wjmk-backdrop" onClick={onClose}>
            <div className="wjmk-modal" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="wjmk-close" aria-label="Cerrar" onClick={onClose}>×</button>
                {product.image_url ? (
                    <div className="wjmk-modal-img"><img src={product.image_url} alt={product.name} decoding="async" /></div>
                ) : null}
                <span className="wjmk-chip">{product.vendor_name}</span>
                <h3 className="wjmk-h" style={{ marginTop: ".45rem" }}>{product.name}</h3>
                <div className="wjmk-price">{fmtMoney(product.price_cents, symbol)}</div>
                {product.category ? <div className="wjmk-cat">Categoría: {product.category}</div> : null}
                {product.description ? <p style={{ fontSize: ".9rem", whiteSpace: "pre-wrap" }}>{product.description}</p> : null}

                <h4 style={{ margin: "1rem 0 0", fontSize: ".95rem", fontWeight: 800 }}>Consultar al vendedor</h4>
                <p className="wjmk-sub">Tu consulta llega directo a {product.vendor_name}; te responderá por email.</p>
                {ok ? (
                    <div className="wjmk-msg-ok" style={{ marginTop: ".6rem" }}>{ok}</div>
                ) : (
                    <form className="wjmk-form" onSubmit={submit}>
                        <div className="wjmk-form-row">
                            <input className="wjmk-input" type="text" placeholder="Tu nombre" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
                            <input className="wjmk-input" type="email" placeholder="Tu email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={200} />
                        </div>
                        <textarea className="wjmk-textarea" placeholder="¿Qué quieres preguntar sobre este producto?" value={message} onChange={(e) => setMessage(e.target.value)} required maxLength={3000} />
                        {/* Honeypot: hidden from humans, tempting for bots. */}
                        <input className="wjmk-hp" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" value={hp} onChange={(e) => setHp(e.target.value)} placeholder="No llenar" />
                        {err ? <div className="wjmk-msg-err">{err}</div> : null}
                        <div><button type="submit" className="wjmk-btn" disabled={busy}>{busy ? "Enviando…" : "Enviar consulta"}</button></div>
                    </form>
                )}
            </div>
        </div>
    );
}

// ---- inline vendor portal (login -> own products CRUD + inquiries) ------------------------------
function PortalPanel({ symbol, onBack }) {
    const [token, setToken] = useState(readToken);
    const [me, setMe] = useState(null);
    const [checking, setChecking] = useState(!!readToken());
    const [vendorOptions, setVendorOptions] = useState([]);
    const [loginVendor, setLoginVendor] = useState("");
    const [code, setCode] = useState("");
    const [err, setErr] = useState("");
    const [busy, setBusy] = useState(false);
    const [products, setProducts] = useState([]);
    const [inquiries, setInquiries] = useState([]);
    const [form, setForm] = useState(null); // null = closed; object = create/edit form values
    const [msg, setMsg] = useState("");
    // Public vendor application (reaches /public/apply)
    const [applyOpen, setApplyOpen] = useState(false);
    const [apply, setApply] = useState({ name: "", email: "", phone: "", description: "", hp: "" });
    const [applyOk, setApplyOk] = useState("");
    const applyOpenedAtRef = useRef(0);

    const loadOwn = async (t) => {
        const [prods, inqs] = await Promise.all([
            portalFetch("/portal/products", t),
            portalFetch("/portal/inquiries", t),
        ]);
        setProducts(Array.isArray(prods) ? prods : []);
        setInquiries(Array.isArray(inqs) ? inqs : []);
    };

    // Vendor list for the login select (public route — only approved stores).
    useEffect(() => {
        let alive = true;
        fetch(`${API}/public/vendors`)
            .then((res) => (res.ok ? res.json() : []))
            .then((list) => { if (alive) setVendorOptions(Array.isArray(list) ? list : []); })
            .catch(() => { if (alive) setVendorOptions([]); });
        return () => { alive = false; };
    }, []);

    // Resume an existing session (token in localStorage / cookie).
    useEffect(() => {
        let alive = true;
        const t = readToken();
        if (!t) { setChecking(false); return; }
        (async () => {
            try {
                const v = await portalFetch("/portal/me", t);
                if (!alive) return;
                setMe(v);
                await loadOwn(t);
            } catch {
                if (alive) { writeToken(""); setToken(""); }
            } finally {
                if (alive) setChecking(false);
            }
        })();
        return () => { alive = false; };
    }, []);

    const login = async (e) => {
        e.preventDefault();
        setBusy(true); setErr("");
        try {
            const data = await portalFetch("/portal/login", "", {
                method: "POST",
                body: JSON.stringify({ vendor_id: Number(loginVendor), code: code.trim() }),
            });
            writeToken(data.token);
            setToken(data.token);
            setMe(data.vendor);
            setCode("");
            await loadOwn(data.token);
        } catch (e2) {
            setErr(e2.message || "No se pudo iniciar sesión.");
        } finally {
            setBusy(false);
        }
    };

    const logout = async () => {
        try { await portalFetch("/portal/logout", token, { method: "POST", body: JSON.stringify({}) }); } catch { /* best effort */ }
        writeToken("");
        setToken(""); setMe(null); setProducts([]); setInquiries([]); setForm(null); setMsg("");
    };

    const saveProduct = async (e) => {
        e.preventDefault();
        setBusy(true); setMsg("");
        try {
            const price = parseFloat(String(form.price).replace(",", "."));
            if (!Number.isFinite(price) || price < 0) throw new Error("Precio inválido.");
            const body = {
                name: form.name,
                description: form.description,
                price_cents: Math.round(price * 100), // integer cents on the wire
                image_url: form.image_url,
                category: form.category,
                is_published: form.is_published === "0" ? 0 : 1,
            };
            if (form.id) body.id = form.id;
            await portalFetch("/portal/products", token, { method: "POST", body: JSON.stringify(body) });
            setForm(null);
            setMsg(form.id ? "Producto actualizado." : "Producto creado.");
            await loadOwn(token);
        } catch (e2) {
            setMsg(`Error: ${e2.message}`);
        } finally {
            setBusy(false);
        }
    };

    const deleteProduct = async (p) => {
        if (typeof window !== "undefined" && !window.confirm(`¿Eliminar "${p.name}"?`)) return;
        setBusy(true); setMsg("");
        try {
            await portalFetch(`/portal/products/${p.id}`, token, { method: "DELETE" });
            setMsg("Producto eliminado.");
            await loadOwn(token);
        } catch (e2) {
            setMsg(`Error: ${e2.message}`);
        } finally {
            setBusy(false);
        }
    };

    const setInquiryStatus = async (inq, status) => {
        try {
            await portalFetch(`/portal/inquiries/${inq.id}/status`, token, { method: "POST", body: JSON.stringify({ status }) });
            setInquiries((list) => list.map((i) => (i.id === inq.id ? { ...i, status } : i)));
        } catch (e2) {
            setMsg(`Error: ${e2.message}`);
        }
    };

    const submitApply = async (e) => {
        e.preventDefault();
        setBusy(true); setErr("");
        try {
            const res = await fetch(`${API}/public/apply`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...apply, elapsed: Date.now() - applyOpenedAtRef.current }),
            });
            const data = await jsonOrNull(res);
            if (!res.ok) throw new Error((data && data.error) || "No se pudo enviar la solicitud.");
            setApplyOk((data && data.message) || "Solicitud recibida.");
        } catch (e2) {
            setErr(e2.message || "No se pudo enviar la solicitud.");
        } finally {
            setBusy(false);
        }
    };

    // ---------- render ----------
    if (checking) return <div className="wjmk-empty">Verificando sesión…</div>;

    if (!me) {
        return (
            <div className="wjmk-portal">
                <div className="wjmk-portal-head">
                    <div>
                        <h3 className="wjmk-h">Acceso vendedores</h3>
                        <p className="wjmk-sub">Selecciona tu tienda e ingresa tu código de acceso.</p>
                    </div>
                    <button type="button" className="wjmk-btn wjmk-btn-ghost wjmk-btn-sm" onClick={onBack}>← Volver al marketplace</button>
                </div>
                <form className="wjmk-form" onSubmit={login} style={{ maxWidth: 420 }}>
                    <select className="wjmk-select" value={loginVendor} onChange={(e) => setLoginVendor(e.target.value)} required>
                        <option value="">— Selecciona tu tienda —</option>
                        {vendorOptions.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                    <input className="wjmk-input" type="password" inputMode="numeric" placeholder="Código de acceso (6 dígitos)" value={code} onChange={(e) => setCode(e.target.value)} required maxLength={10} />
                    {err ? <div className="wjmk-msg-err">{err}</div> : null}
                    <div><button type="submit" className="wjmk-btn" disabled={busy || !loginVendor}>{busy ? "Ingresando…" : "Ingresar"}</button></div>
                </form>

                <div className="wjmk-section">
                    {applyOk ? (
                        <div className="wjmk-msg-ok">{applyOk}</div>
                    ) : applyOpen ? (
                        <form className="wjmk-form" onSubmit={submitApply} style={{ maxWidth: 420 }}>
                            <h4 style={{ margin: 0, fontSize: ".95rem", fontWeight: 800 }}>Solicitar una tienda</h4>
                            <input className="wjmk-input" type="text" placeholder="Nombre de la tienda" value={apply.name} onChange={(e) => setApply({ ...apply, name: e.target.value })} required maxLength={120} />
                            <input className="wjmk-input" type="email" placeholder="Email de contacto" value={apply.email} onChange={(e) => setApply({ ...apply, email: e.target.value })} required maxLength={200} />
                            <input className="wjmk-input" type="text" placeholder="Teléfono (opcional)" value={apply.phone} onChange={(e) => setApply({ ...apply, phone: e.target.value })} maxLength={40} />
                            <textarea className="wjmk-textarea" placeholder="¿Qué vendes? Cuéntanos de tu tienda." value={apply.description} onChange={(e) => setApply({ ...apply, description: e.target.value })} maxLength={2000} />
                            <input className="wjmk-hp" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" value={apply.hp} onChange={(e) => setApply({ ...apply, hp: e.target.value })} placeholder="No llenar" />
                            {err ? <div className="wjmk-msg-err">{err}</div> : null}
                            <div className="wjmk-actions">
                                <button type="submit" className="wjmk-btn" disabled={busy}>{busy ? "Enviando…" : "Enviar solicitud"}</button>
                                <button type="button" className="wjmk-btn wjmk-btn-ghost" onClick={() => setApplyOpen(false)}>Cancelar</button>
                            </div>
                        </form>
                    ) : (
                        <button
                            type="button"
                            className="wjmk-portal-link"
                            onClick={() => { setApplyOpen(true); setErr(""); applyOpenedAtRef.current = Date.now(); }}
                        >
                            ¿Aún no tienes tienda? Solicita unirte al marketplace
                        </button>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="wjmk-portal">
            <div className="wjmk-portal-head">
                <div>
                    <h3 className="wjmk-h">{me.name}</h3>
                    <p className="wjmk-sub">Portal de vendedor — gestiona tus productos y consultas.</p>
                </div>
                <div className="wjmk-actions">
                    <button type="button" className="wjmk-btn wjmk-btn-ghost wjmk-btn-sm" onClick={onBack}>← Marketplace</button>
                    <button type="button" className="wjmk-btn wjmk-btn-sm" onClick={logout}>Cerrar sesión</button>
                </div>
            </div>
            {msg ? <div className={msg.startsWith("Error") ? "wjmk-msg-err" : "wjmk-msg-ok"} style={{ marginBottom: ".8rem" }}>{msg}</div> : null}

            <div className="wjmk-actions" style={{ marginBottom: ".6rem" }}>
                <button
                    type="button"
                    className="wjmk-btn wjmk-btn-sm"
                    onClick={() => { setMsg(""); setForm({ id: null, name: "", description: "", price: "", category: "", image_url: "", is_published: "1" }); }}
                >
                    + Nuevo producto
                </button>
            </div>

            {form ? (
                <form className="wjmk-form" onSubmit={saveProduct} style={{ border: "1px solid #e5e7eb", borderRadius: ".7rem", padding: ".9rem", marginBottom: "1rem" }}>
                    <h4 style={{ margin: 0, fontSize: ".95rem", fontWeight: 800 }}>{form.id ? "Editar producto" : "Nuevo producto"}</h4>
                    <div className="wjmk-form-row">
                        <input className="wjmk-input" type="text" placeholder="Nombre del producto" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={150} />
                        <input className="wjmk-input" type="text" inputMode="decimal" placeholder={`Precio (${symbol})`} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} required />
                    </div>
                    <div className="wjmk-form-row">
                        <input className="wjmk-input" type="text" placeholder="Categoría (ej. Ropa)" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} maxLength={60} />
                        <input className="wjmk-input" type="text" placeholder="URL de imagen (https://… o /uploads/…)" value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} maxLength={500} />
                    </div>
                    <textarea className="wjmk-textarea" placeholder="Descripción" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={2000} />
                    <select className="wjmk-select" value={form.is_published} onChange={(e) => setForm({ ...form, is_published: e.target.value })}>
                        <option value="1">Publicado (visible en el marketplace)</option>
                        <option value="0">Oculto (borrador)</option>
                    </select>
                    <div className="wjmk-actions">
                        <button type="submit" className="wjmk-btn" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button>
                        <button type="button" className="wjmk-btn wjmk-btn-ghost" onClick={() => setForm(null)}>Cancelar</button>
                    </div>
                </form>
            ) : null}

            <div className="wjmk-table-wrap">
                <table className="wjmk-table">
                    <thead>
                        <tr><th>Producto</th><th>Precio</th><th>Categoría</th><th>Estado</th><th></th></tr>
                    </thead>
                    <tbody>
                        {products.length === 0 ? (
                            <tr><td colSpan={5} style={{ color: "#9ca3af" }}>Aún no tienes productos — crea el primero.</td></tr>
                        ) : products.map((p) => (
                            <tr key={p.id}>
                                <td style={{ fontWeight: 700 }}>{p.name}</td>
                                <td>{fmtMoney(p.price_cents, symbol)}</td>
                                <td>{p.category || "—"}</td>
                                <td><span className={`wjmk-badge ${p.is_published ? "wjmk-badge-on" : "wjmk-badge-off"}`}>{p.is_published ? "Publicado" : "Oculto"}</span></td>
                                <td>
                                    <div className="wjmk-actions">
                                        <button
                                            type="button"
                                            className="wjmk-btn wjmk-btn-ghost wjmk-btn-sm"
                                            onClick={() => { setMsg(""); setForm({ id: p.id, name: p.name || "", description: p.description || "", price: ((Number(p.price_cents) || 0) / 100).toFixed(2), category: p.category || "", image_url: p.image_url || "", is_published: p.is_published ? "1" : "0" }); }}
                                        >
                                            Editar
                                        </button>
                                        <button type="button" className="wjmk-btn wjmk-btn-danger wjmk-btn-sm" onClick={() => deleteProduct(p)}>Eliminar</button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="wjmk-section">
                <h4 style={{ margin: "0 0 .6rem", fontSize: ".95rem", fontWeight: 800 }}>Consultas de compradores</h4>
                {inquiries.length === 0 ? (
                    <div className="wjmk-empty">Sin consultas todavía.</div>
                ) : inquiries.map((i) => (
                    <div key={i.id} className="wjmk-inq">
                        <div className="wjmk-inq-meta">
                            <strong style={{ color: "inherit" }}>{i.buyer_name}</strong>
                            <a href={`mailto:${i.buyer_email}`}>{i.buyer_email}</a>
                            {i.product_name ? <span>· {i.product_name}</span> : null}
                            {i.created_at ? <span>· {String(i.created_at).slice(0, 16).replace("T", " ")}</span> : null}
                            <span className={`wjmk-badge wjmk-badge-${i.status}`}>{INQUIRY_LABELS[i.status] || i.status}</span>
                        </div>
                        <p>{i.message}</p>
                        <div className="wjmk-actions" style={{ marginTop: ".5rem" }}>
                            {i.status !== "replied" ? <button type="button" className="wjmk-btn wjmk-btn-ghost wjmk-btn-sm" onClick={() => setInquiryStatus(i, "replied")}>Marcar respondida</button> : null}
                            {i.status !== "closed" ? <button type="button" className="wjmk-btn wjmk-btn-ghost wjmk-btn-sm" onClick={() => setInquiryStatus(i, "closed")}>Cerrar</button> : null}
                            {i.status !== "new" ? <button type="button" className="wjmk-btn wjmk-btn-ghost wjmk-btn-sm" onClick={() => setInquiryStatus(i, "new")}>Reabrir</button> : null}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ---- Puck definition (NO render key — the registry composes it with the default export) ----------
export const puckComponentDef = {
    category: "Comercio",
    fields: {
        mode: {
            type: "radio",
            label: "Modo",
            options: [
                { label: "Productos", value: "products" },
                { label: "Tiendas", value: "vendors" },
            ],
        },
        category: { type: "text", label: "Filtrar categoría (opcional)" },
        columns: {
            type: "radio",
            label: "Columnas",
            options: [
                { label: "2", value: 2 },
                { label: "3", value: 3 },
                { label: "4", value: 4 },
            ],
        },
        showFilter: {
            type: "radio",
            label: "Mostrar filtros",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        showVendorPortalLink: {
            type: "radio",
            label: "Enlace 'Acceso vendedores'",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        mode: "products",
        category: "",
        columns: 3,
        showFilter: true,
        showVendorPortalLink: true,
        elementId: "",
    },
};

export default function VendorMarketplacePuck({ mode, category, columns, showFilter, showVendorPortalLink, elementId }) {
    const [view, setView] = useState("market"); // 'market' | 'portal'
    const [symbol, setSymbol] = useState("$");
    const [vendors, setVendors] = useState(null);   // null = loading
    const [products, setProducts] = useState(null); // null = loading
    const [fVendor, setFVendor] = useState("");
    const [fCategory, setFCategory] = useState("");
    const [search, setSearch] = useState("");
    const [selected, setSelected] = useState(null);

    const cols = Number(columns) === 2 || Number(columns) === 4 ? Number(columns) : 3;

    // Currency symbol (public config).
    useEffect(() => {
        let alive = true;
        fetch(`${API}/public/config`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => { if (alive && data && data.currencySymbol) setSymbol(data.currencySymbol); })
            .catch(() => { /* keep default */ });
        return () => { alive = false; };
    }, []);

    // Approved vendors (used by vendors mode AND the products filter bar).
    useEffect(() => {
        let alive = true;
        fetch(`${API}/public/vendors`)
            .then((res) => (res.ok ? res.json() : null))
            .then((list) => { if (alive) setVendors(Array.isArray(list) ? list : []); })
            .catch(() => { if (alive) setVendors([]); });
        return () => { alive = false; };
    }, []);

    // Published products (products mode). The block's category prop pre-filters server-side;
    // the interactive filters below act client-side for instant feedback.
    useEffect(() => {
        if (mode === "vendors") return;
        let alive = true;
        const p = new URLSearchParams();
        if (category) p.set("category", category);
        p.set("limit", "200");
        fetch(`${API}/public/products?${p.toString()}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((list) => { if (alive) setProducts(Array.isArray(list) ? list : []); })
            .catch(() => { if (alive) setProducts([]); });
        return () => { alive = false; };
    }, [mode, category]);

    const categories = useMemo(() => {
        const set = new Set();
        for (const p of products || []) if (p.category) set.add(p.category);
        return Array.from(set).sort();
    }, [products]);

    const vendorChoices = useMemo(() => {
        const seen = new Map();
        for (const p of products || []) if (!seen.has(p.vendor_id)) seen.set(p.vendor_id, p.vendor_name);
        return Array.from(seen, ([id, name]) => ({ id, name })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }, [products]);

    const filtered = useMemo(() => {
        let list = products || [];
        if (fVendor) list = list.filter((p) => String(p.vendor_id) === fVendor);
        if (fCategory) list = list.filter((p) => (p.category || "") === fCategory);
        const q = search.trim().toLowerCase();
        if (q) list = list.filter((p) => String(p.name || "").toLowerCase().includes(q) || String(p.description || "").toLowerCase().includes(q));
        return list;
    }, [products, fVendor, fCategory, search]);

    return (
        <div id={elementId || undefined} className="wjmk">
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />

            {view === "portal" ? (
                <PortalPanel symbol={symbol} onBack={() => setView("market")} />
            ) : (
                <>
                    {mode === "vendors" ? (
                        vendors === null ? (
                            <div className="wjmk-empty">Cargando tiendas…</div>
                        ) : vendors.length === 0 ? (
                            <div className="wjmk-empty">Aún no hay tiendas aprobadas en el marketplace.</div>
                        ) : (
                            <div className={`wjmk-grid wjmk-cols-${cols}`}>
                                {vendors.map((v) => (
                                    <div key={v.id} className="wjmk-card wjmk-vcard">
                                        <div className="wjmk-logo">
                                            {v.logo_url ? <img src={v.logo_url} alt={v.name} decoding="async" /> : <span>{String(v.name || "?").charAt(0).toUpperCase()}</span>}
                                        </div>
                                        <div className="wjmk-body" style={{ alignItems: "center" }}>
                                            <h3 className="wjmk-name">{v.name}</h3>
                                            {v.description ? <p style={{ fontSize: ".82rem", color: "#6b7280", margin: 0 }}>{v.description}</p> : null}
                                            <span className="wjmk-chip">{v.product_count} producto{Number(v.product_count) === 1 ? "" : "s"}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )
                    ) : (
                        <>
                            {showFilter && products !== null && products.length > 0 ? (
                                <div className="wjmk-filter">
                                    <select className="wjmk-select" value={fVendor} onChange={(e) => setFVendor(e.target.value)} aria-label="Filtrar por tienda">
                                        <option value="">Todas las tiendas</option>
                                        {vendorChoices.map((v) => <option key={v.id} value={String(v.id)}>{v.name}</option>)}
                                    </select>
                                    <select className="wjmk-select" value={fCategory} onChange={(e) => setFCategory(e.target.value)} aria-label="Filtrar por categoría">
                                        <option value="">Todas las categorías</option>
                                        {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                    <input className="wjmk-input" type="search" placeholder="Buscar productos…" value={search} onChange={(e) => setSearch(e.target.value)} />
                                </div>
                            ) : null}

                            {products === null ? (
                                <div className="wjmk-empty">Cargando productos…</div>
                            ) : filtered.length === 0 ? (
                                <div className="wjmk-empty">
                                    {products.length === 0
                                        ? "Aún no hay productos publicados en el marketplace."
                                        : "No hay productos que coincidan con el filtro."}
                                </div>
                            ) : (
                                <div className={`wjmk-grid wjmk-cols-${cols}`}>
                                    {filtered.map((p) => (
                                        <div key={p.id} className="wjmk-card" onClick={() => setSelected(p)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setSelected(p); }}>
                                            <div className="wjmk-img">
                                                {/* Deliberately NOT loading="lazy": cards may sit inside transformed
                                                    containers where the lazy heuristic never fires. */}
                                                {p.image_url ? <img src={p.image_url} alt={p.name} decoding="async" /> : <span aria-hidden="true">🛍</span>}
                                            </div>
                                            <div className="wjmk-body">
                                                <span className="wjmk-chip">{p.vendor_name}</span>
                                                <h3 className="wjmk-name">{p.name}</h3>
                                                {p.category ? <span className="wjmk-cat">{p.category}</span> : null}
                                                <span className="wjmk-price">{fmtMoney(p.price_cents, symbol)}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}

                    {showVendorPortalLink ? (
                        <div className="wjmk-portal-row">
                            <button type="button" className="wjmk-portal-link" onClick={() => setView("portal")}>Acceso vendedores</button>
                        </div>
                    ) : null}
                </>
            )}

            {selected ? <ProductModal product={selected} symbol={symbol} onClose={() => setSelected(null)} /> : null}
        </div>
    );
}
