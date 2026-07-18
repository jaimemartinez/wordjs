// @ts-nocheck
"use client";

/**
 * Admin page for the Marketplace plugin (/admin/plugin/vendor-marketplace).
 * Tabs: Vendedores (approve/suspend/rotate-code/edit/delete + create), Productos (moderation),
 * Consultas (buyer inquiries), Reporte (per-vendor counts + editable commission + currency symbol).
 * API calls go through the host's api helpers (session cookie).
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected by the
 * host admin shell and scoped to .plugin-admin-vendor-marketplace) — the markup below only uses
 * cf-* classes plus sparse inline styles for one-off layout.
 */

import React, { useEffect, useMemo, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";

const BASE = "/plugin/vendor-marketplace";

const STATUS_LABEL = { pending: "Pendiente", approved: "Aprobada", suspended: "Suspendida" };
const STATUS_BADGE = { pending: "is-warn", approved: "is-ok", suspended: "is-danger" };
const INQ_LABEL = { new: "Nueva", replied: "Respondida", closed: "Cerrada" };

const fmtMoney = (cents, symbol) => `${symbol || "$"}${((Number(cents) || 0) / 100).toFixed(2)}`;
const fmtDate = (v) => (v ? String(v).slice(0, 16).replace("T", " ") : "—");

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconStore = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
        <path d="M3 6h18" />
        <path d="M16 10a4 4 0 0 1-8 0" />
    </svg>
);
const IconPlus = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" {...props}>
        <path d="M12 5v14M5 12h14" />
    </svg>
);
const IconPen = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
);
const IconCopy = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
);

// Module-level (never define a component inside a component — remounting steals input focus).
function VendorFormModal({ initial, title, busy, onSave, onClose }) {
    const [form, setForm] = useState(() => ({
        name: initial.name || "",
        email: initial.email || "",
        phone: initial.phone || "",
        description: initial.description || "",
        logo_url: initial.logo_url || "",
        commission_pct: String(initial.commission_pct ?? 0),
    }));
    const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

    return (
        <div className="cf-overlay" onClick={onClose}>
            <div className="cf-letter" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
                <div className="cf-letter-body">
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem", marginBottom: "1.35rem" }}>
                        <h3 className="cf-editor-title" style={{ marginBottom: 0 }}><IconPen /> {title}</h3>
                        <button type="button" onClick={onClose} aria-label="Cerrar" className="cf-iconbtn">✕</button>
                    </div>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            onSave({ ...form, commission_pct: Number(form.commission_pct) });
                        }}
                    >
                        <div className="cf-grid">
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="vm-name">Nombre de la tienda *</label>
                                <input id="vm-name" type="text" className="cf-input" value={form.name} onChange={set("name")} required maxLength={120} />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="vm-email">Email *</label>
                                <input id="vm-email" type="email" className="cf-input" value={form.email} onChange={set("email")} required maxLength={200} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="vm-phone">Teléfono</label>
                                <input id="vm-phone" type="text" className="cf-input" value={form.phone} onChange={set("phone")} maxLength={40} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="vm-commission">Comisión % (informativa)</label>
                                <input id="vm-commission" type="number" min="0" max="100" step="1" className="cf-input" value={form.commission_pct} onChange={set("commission_pct")} />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="vm-logo">Logo (URL)</label>
                                <input id="vm-logo" type="text" className="cf-input" value={form.logo_url} onChange={set("logo_url")} placeholder="https://… o /uploads/…" maxLength={500} />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="vm-desc">Descripción</label>
                                <textarea id="vm-desc" className="cf-input" style={{ minHeight: "90px" }} value={form.description} onChange={set("description")} maxLength={2000} />
                            </div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.5rem" }}>
                            <button type="button" className="cf-btn-ghost" onClick={onClose}>Cancelar</button>
                            <button type="submit" className="cf-btn" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}

export default function MarketplaceAdminPage() {
    const [tab, setTab] = useState("vendors");
    const [vendors, setVendors] = useState([]);
    const [products, setProducts] = useState([]);
    const [inquiries, setInquiries] = useState([]);
    const [report, setReport] = useState(null);
    const [symbol, setSymbol] = useState("$");
    const [symbolDraft, setSymbolDraft] = useState("$");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [editVendor, setEditVendor] = useState(null);   // vendor being edited
    const [creating, setCreating] = useState(false);       // create-vendor modal
    const [commissionDrafts, setCommissionDrafts] = useState({});

    const isError = /Error|falló|no enviado/i.test(message);

    const loadAll = async () => {
        try {
            const [vs, ps, is, rep, st] = await Promise.all([
                api(`${BASE}/vendors`),
                api(`${BASE}/products`),
                api(`${BASE}/inquiries`),
                api(`${BASE}/report`),
                api(`${BASE}/settings`),
            ]);
            setVendors(Array.isArray(vs) ? vs : []);
            setProducts(Array.isArray(ps) ? ps : []);
            setInquiries(Array.isArray(is) ? is : []);
            setReport(rep || null);
            const sym = (st && st.currencySymbol) || "$";
            setSymbol(sym);
            setSymbolDraft(sym);
            const drafts = {};
            for (const v of (rep && rep.vendors) || []) drafts[v.id] = String(v.commission_pct ?? 0);
            setCommissionDrafts(drafts);
        } catch (err) {
            setMessage(`Error al cargar: ${err?.message || err}`);
        }
    };

    useEffect(() => { loadAll(); }, []);

    const run = async (fn, okMsg) => {
        setBusy(true); setMessage("");
        try {
            const out = await fn();
            setMessage(typeof okMsg === "function" ? okMsg(out) : okMsg);
            await loadAll();
        } catch (err) {
            setMessage(`Error: ${err?.message || err}`);
        } finally {
            setBusy(false);
        }
    };

    // ---- vendor actions ----
    const approve = (v) => run(
        () => apiPost(`${BASE}/vendors/${v.id}/approve`, {}),
        (out) => `Tienda "${v.name}" aprobada. Código: ${out.access_code}${out.mailed ? " (enviado por email)" : " — correo no enviado, cópialo y compártelo manualmente"}.`
    );
    const suspend = (v) => {
        if (!window.confirm(`¿Suspender la tienda "${v.name}"? Sus productos dejarán de mostrarse.`)) return;
        run(() => apiPost(`${BASE}/vendors/${v.id}/suspend`, {}), `Tienda "${v.name}" suspendida.`);
    };
    const rotateCode = (v) => {
        if (!window.confirm(`¿Generar un nuevo código para "${v.name}"? El código anterior dejará de funcionar.`)) return;
        run(() => apiPost(`${BASE}/vendors/${v.id}/rotate-code`, {}), (out) => `Nuevo código para "${v.name}": ${out.access_code}.`);
    };
    const removeVendor = (v) => {
        if (!window.confirm(`¿Eliminar la tienda "${v.name}"? Se borrarán también sus productos y consultas. Esta acción no se puede deshacer.`)) return;
        run(() => apiDelete(`${BASE}/vendors/${v.id}`), `Tienda "${v.name}" eliminada.`);
    };
    const saveVendorEdit = (form) => run(async () => {
        await apiPut(`${BASE}/vendors/${editVendor.id}`, form);
        setEditVendor(null);
    }, "Tienda actualizada.");
    const createVendor = (form) => run(async () => {
        const out = await apiPost(`${BASE}/vendors`, form);
        setCreating(false);
        return out;
    }, (out) => `Tienda creada y aprobada. Código de acceso: ${out.access_code}.`);
    const copyCode = async (code) => {
        try {
            await navigator.clipboard.writeText(String(code));
            setMessage("Código copiado al portapapeles.");
        } catch {
            setMessage("Error: no se pudo copiar (copia manualmente).");
        }
    };

    // ---- product / inquiry actions ----
    const togglePublish = (p) => run(
        () => apiPost(`${BASE}/products/${p.id}/publish`, { is_published: p.is_published ? 0 : 1 }),
        p.is_published ? `Producto "${p.name}" ocultado.` : `Producto "${p.name}" publicado.`
    );
    const removeProduct = (p) => {
        if (!window.confirm(`¿Eliminar el producto "${p.name}"?`)) return;
        run(() => apiDelete(`${BASE}/products/${p.id}`), `Producto "${p.name}" eliminado.`);
    };
    const setInquiryStatus = (i, status) => run(
        () => apiPost(`${BASE}/inquiries/${i.id}/status`, { status }),
        "Estado de la consulta actualizado."
    );

    // ---- report / settings actions ----
    const saveCommission = (vendorId) => {
        const pct = Number(commissionDrafts[vendorId]);
        if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
            setMessage("Error: la comisión debe ser un entero entre 0 y 100.");
            return;
        }
        run(() => apiPut(`${BASE}/vendors/${vendorId}`, { commission_pct: pct }), "Comisión actualizada.");
    };
    const saveSymbol = () => run(
        () => apiPost(`${BASE}/settings`, { currencySymbol: symbolDraft.trim() }),
        "Símbolo de moneda guardado."
    );

    const pendingCount = useMemo(() => vendors.filter((v) => v.status === "pending").length, [vendors]);
    const visibleVendors = useMemo(
        () => (statusFilter ? vendors.filter((v) => v.status === statusFilter) : vendors),
        [vendors, statusFilter]
    );

    const tabs = [
        { id: "vendors", label: "Vendedores", badge: pendingCount },
        { id: "products", label: "Productos" },
        { id: "inquiries", label: "Consultas" },
        { id: "report", label: "Reporte" },
    ];

    return (
        <div className="cf-shell">
            {/* header: stamp + title + rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconStore /></div>
                <div>
                    <h1 className="cf-title">Marketplace</h1>
                    <p className="cf-subtitle">
                        Directorio multi-vendedor · portal de vendedores con código de acceso
                    </p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* v1 scope banner — this marketplace generates LEADS, it does not process payments. */}
            <div className="cf-note">
                <strong>Marketplace v1 = generación de contactos (leads).</strong> Los compradores consultan por producto
                y cada vendedor cierra la venta por su cuenta. No hay checkout centralizado ni cobro de comisiones
                automático — el porcentaje de comisión del reporte es informativo.
            </div>

            {/* tabs */}
            <div className="cf-tabs" role="tablist">
                {tabs.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === t.id}
                        onClick={() => { setTab(t.id); setMessage(""); }}
                        className={`cf-tab ${tab === t.id ? "is-active" : ""}`}
                    >
                        {t.label}
                        {t.badge ? <span className="cf-badge">{t.badge}</span> : null}
                    </button>
                ))}
            </div>

            {message && (
                <div role={isError ? "alert" : "status"} className={`cf-flash ${isError ? "is-error" : "is-ok"}`}>{message}</div>
            )}

            {/* ============================== VENDEDORES ============================== */}
            {tab === "vendors" && (
                <div className="cf-card-item">
                    <div className="cf-toolbar">
                        <div className="cf-toolbar-left">
                            <h2 className="cf-card-title">Vendedores</h2>
                            <select
                                value={statusFilter}
                                onChange={(e) => setStatusFilter(e.target.value)}
                                className="cf-select"
                                aria-label="Filtrar por estado"
                            >
                                <option value="">Todos los estados</option>
                                <option value="pending">Pendientes</option>
                                <option value="approved">Aprobadas</option>
                                <option value="suspended">Suspendidas</option>
                            </select>
                        </div>
                        <button type="button" className="cf-btn" onClick={() => setCreating(true)}><IconPlus /> Crear vendedor</button>
                    </div>

                    <div className="cf-table-wrap">
                        <table className="cf-table">
                            <thead>
                                <tr>
                                    <th>Tienda</th>
                                    <th>Contacto</th>
                                    <th>Estado</th>
                                    <th>Código</th>
                                    <th>Prod. / Cons.</th>
                                    <th>Acciones</th>
                                </tr>
                            </thead>
                            <tbody>
                                {visibleVendors.length === 0 ? (
                                    <tr><td colSpan={6} className="cf-cell-empty">Sin vendedores{statusFilter ? " en este estado" : " todavía — las solicitudes públicas aparecerán aquí"}.</td></tr>
                                ) : visibleVendors.map((v) => (
                                    <tr key={v.id}>
                                        <td>
                                            <div className="cf-strong">{v.name}</div>
                                            <div className="cf-sub">/{v.slug} · {fmtDate(v.created_at)}</div>
                                            {v.description ? <div className="cf-sub" style={{ maxWidth: "14rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.description}</div> : null}
                                        </td>
                                        <td>
                                            <div>{v.email}</div>
                                            {v.phone ? <div className="cf-sub">{v.phone}</div> : null}
                                        </td>
                                        <td>
                                            <span className={`cf-pill ${STATUS_BADGE[v.status] || "is-muted"}`}>
                                                {STATUS_LABEL[v.status] || v.status}
                                            </span>
                                        </td>
                                        <td>
                                            {v.access_code ? (
                                                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                                                    <code className="cf-code">{v.access_code}</code>
                                                    <button type="button" title="Copiar código" className="cf-btn-ghost" onClick={() => copyCode(v.access_code)}><IconCopy /> Copiar</button>
                                                </span>
                                            ) : <span className="cf-void">— al aprobar —</span>}
                                        </td>
                                        <td>
                                            <span className="cf-strong" style={{ whiteSpace: "nowrap" }}>{v.product_count} / {v.inquiry_count}</span>
                                        </td>
                                        <td>
                                            <div className="cf-row-actions">
                                                {v.status !== "approved" && (
                                                    <button type="button" disabled={busy} className="cf-btn" onClick={() => approve(v)}>Aprobar</button>
                                                )}
                                                {v.status === "approved" && (
                                                    <button type="button" disabled={busy} className="cf-btn-ghost" onClick={() => suspend(v)}>Suspender</button>
                                                )}
                                                {v.access_code && (
                                                    <button type="button" disabled={busy} className="cf-btn-ghost" onClick={() => rotateCode(v)}>Rotar código</button>
                                                )}
                                                <button type="button" disabled={busy} className="cf-btn-ghost" onClick={() => setEditVendor(v)}><IconPen /> Editar</button>
                                                <button type="button" disabled={busy} className="cf-btn-danger" onClick={() => removeVendor(v)}>Eliminar</button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* ============================== PRODUCTOS ============================== */}
            {tab === "products" && (
                <div className="cf-card-item">
                    <h2 className="cf-card-title" style={{ marginBottom: "1.15rem" }}>Todos los productos</h2>
                    <div className="cf-table-wrap">
                        <table className="cf-table">
                            <thead>
                                <tr>
                                    <th>Producto</th>
                                    <th>Tienda</th>
                                    <th>Precio</th>
                                    <th>Categoría</th>
                                    <th>Visibilidad</th>
                                    <th>Acciones</th>
                                </tr>
                            </thead>
                            <tbody>
                                {products.length === 0 ? (
                                    <tr><td colSpan={6} className="cf-cell-empty">Sin productos todavía — los vendedores los crean desde su portal.</td></tr>
                                ) : products.map((p) => (
                                    <tr key={p.id}>
                                        <td>
                                            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                                                {p.image_url ? <img src={p.image_url} alt={p.name} decoding="async" className="cf-thumb" /> : null}
                                                <div>
                                                    <div className="cf-strong">{p.name}</div>
                                                    <div className="cf-sub">{fmtDate(p.created_at)}</div>
                                                </div>
                                            </div>
                                        </td>
                                        <td>
                                            {p.vendor_name}
                                            {p.vendor_status !== "approved" ? <span className="cf-danger-note">({STATUS_LABEL[p.vendor_status] || p.vendor_status})</span> : null}
                                        </td>
                                        <td><span className="cf-strong">{fmtMoney(p.price_cents, symbol)}</span></td>
                                        <td>{p.category || "—"}</td>
                                        <td>
                                            <span className={`cf-pill ${p.is_published ? "is-ok" : "is-muted"}`}>
                                                {p.is_published ? "Publicado" : "Oculto"}
                                            </span>
                                        </td>
                                        <td>
                                            <div className="cf-row-actions">
                                                <button type="button" disabled={busy} className="cf-btn-ghost" onClick={() => togglePublish(p)}>
                                                    {p.is_published ? "Ocultar" : "Publicar"}
                                                </button>
                                                <button type="button" disabled={busy} className="cf-btn-danger" onClick={() => removeProduct(p)}>Eliminar</button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* ============================== CONSULTAS ============================== */}
            {tab === "inquiries" && (
                <div className="cf-card-item">
                    <h2 className="cf-card-title" style={{ marginBottom: "1.15rem" }}>Consultas de compradores</h2>
                    <div className="cf-table-wrap">
                        <table className="cf-table">
                            <thead>
                                <tr>
                                    <th>Comprador</th>
                                    <th>Producto / Tienda</th>
                                    <th>Mensaje</th>
                                    <th>Fecha</th>
                                    <th>Estado</th>
                                </tr>
                            </thead>
                            <tbody>
                                {inquiries.length === 0 ? (
                                    <tr><td colSpan={5} className="cf-cell-empty">Sin consultas todavía.</td></tr>
                                ) : inquiries.map((i) => (
                                    <tr key={i.id}>
                                        <td>
                                            <div className="cf-strong">{i.buyer_name}</div>
                                            <a href={`mailto:${i.buyer_email}`} className="cf-link">{i.buyer_email}</a>
                                        </td>
                                        <td>
                                            <div>{i.product_name || <span className="cf-void">(producto eliminado)</span>}</div>
                                            <div className="cf-sub">{i.vendor_name}</div>
                                        </td>
                                        <td className="cf-cell-msg">{i.message}</td>
                                        <td className="cf-cell-date">{fmtDate(i.created_at)}</td>
                                        <td>
                                            <select
                                                value={i.status}
                                                disabled={busy}
                                                onChange={(e) => setInquiryStatus(i, e.target.value)}
                                                className="cf-select"
                                                aria-label="Estado de la consulta"
                                                style={{ width: "auto" }}
                                            >
                                                {Object.keys(INQ_LABEL).map((s) => <option key={s} value={s}>{INQ_LABEL[s]}</option>)}
                                            </select>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* ============================== REPORTE ============================== */}
            {tab === "report" && (
                <div>
                    <div className="cf-card-item">
                        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: "1rem" }}>
                            <div>
                                <h2 className="cf-card-title">Configuración</h2>
                                <p className="cf-help">Símbolo con el que se muestran los precios (solo visual — los precios se guardan en centavos).</p>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                <input type="text" value={symbolDraft} onChange={(e) => setSymbolDraft(e.target.value)} maxLength={8} className="cf-input" style={{ width: "6rem" }} aria-label="Símbolo de moneda" />
                                <button type="button" className="cf-btn" disabled={busy || !symbolDraft.trim()} onClick={saveSymbol}>Guardar</button>
                            </div>
                        </div>
                    </div>

                    <div className="cf-card-item">
                        <h2 className="cf-card-title">Reporte por vendedor</h2>
                        {report?.note ? <p className="cf-help" style={{ marginBottom: "1.15rem" }}>{report.note}</p> : <div style={{ marginBottom: "1.15rem" }}></div>}
                        <div className="cf-table-wrap">
                            <table className="cf-table">
                                <thead>
                                    <tr>
                                        <th>Tienda</th>
                                        <th>Productos (publ.)</th>
                                        <th>Consultas (nuevas)</th>
                                        <th>Valor catálogo</th>
                                        <th>Comisión %</th>
                                        <th>Comisión estimada</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {!report || report.vendors.length === 0 ? (
                                        <tr><td colSpan={6} className="cf-cell-empty">Sin datos todavía.</td></tr>
                                    ) : report.vendors.map((v) => {
                                        const pct = Number(commissionDrafts[v.id]);
                                        const estCents = Number.isFinite(pct) ? Math.round((Number(v.catalog_cents) || 0) * pct / 100) : 0;
                                        return (
                                            <tr key={v.id}>
                                                <td>
                                                    <div className="cf-strong">{v.name}</div>
                                                    <span className={`cf-pill ${STATUS_BADGE[v.status] || "is-muted"}`}>{STATUS_LABEL[v.status] || v.status}</span>
                                                </td>
                                                <td><span className="cf-strong">{v.products}</span> <span className="cf-sub">({v.published_products} publ.)</span></td>
                                                <td><span className="cf-strong">{v.inquiries}</span> <span className="cf-sub">({v.new_inquiries} nuevas)</span></td>
                                                <td>{fmtMoney(v.catalog_cents, report.currencySymbol || symbol)}</td>
                                                <td>
                                                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                                                        <input
                                                            type="number" min="0" max="100" step="1"
                                                            value={commissionDrafts[v.id] ?? ""}
                                                            onChange={(e) => setCommissionDrafts({ ...commissionDrafts, [v.id]: e.target.value })}
                                                            className="cf-input"
                                                            style={{ width: "5rem" }}
                                                            aria-label={`Comisión % de ${v.name}`}
                                                        />
                                                        <button type="button" disabled={busy} className="cf-btn-ghost" onClick={() => saveCommission(v.id)}>OK</button>
                                                    </div>
                                                </td>
                                                <td>
                                                    <span className="cf-sub" title="Estimación informativa: valor del catálogo publicado × comisión. No hay ventas registradas en v1.">
                                                        ≈ {fmtMoney(estCents, report.currencySymbol || symbol)}
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                        <p className="cf-usage">
                            En el editor visual, agrega el bloque <strong>Marketplace</strong> — modo productos o tiendas,
                            filtros por tienda/categoría/búsqueda y el enlace "Acceso vendedores" que abre el portal de
                            autogestión dentro del propio bloque.
                        </p>
                    </div>
                </div>
            )}

            {editVendor && (
                <VendorFormModal
                    key={`edit-${editVendor.id}`}
                    initial={editVendor}
                    title={`Editar "${editVendor.name}"`}
                    busy={busy}
                    onSave={saveVendorEdit}
                    onClose={() => setEditVendor(null)}
                />
            )}
            {creating && (
                <VendorFormModal
                    key="create"
                    initial={{}}
                    title="Crear vendedor (aprobado directamente)"
                    busy={busy}
                    onSave={createVendor}
                    onClose={() => setCreating(false)}
                />
            )}
        </div>
    );
}
