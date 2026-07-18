// @ts-nocheck
"use client";

/**
 * Admin page for the Marketplace plugin (/admin/plugin/vendor-marketplace).
 * Tabs: Vendedores (approve/suspend/rotate-code/edit/delete + create), Productos (moderation),
 * Consultas (buyer inquiries), Reporte (per-vendor counts + editable commission + currency symbol).
 * API calls go through the host's api helpers (session cookie).
 */

import React, { useEffect, useMemo, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";

const BASE = "/plugin/vendor-marketplace";
const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnGhostCls = "px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-bold text-[11px] uppercase tracking-wider transition-all disabled:opacity-50";
const btnSmCls = "px-3 py-1.5 rounded-xl font-bold text-[11px] uppercase tracking-wider transition-all disabled:opacity-50";
const cardCls = "bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8";
const thCls = "text-left text-[10px] font-black uppercase tracking-widest text-gray-400 px-3 py-2";
const tdCls = "px-3 py-3 text-sm text-gray-700 align-top";

const STATUS_LABEL = { pending: "Pendiente", approved: "Aprobada", suspended: "Suspendida" };
const STATUS_BADGE = {
    pending: "bg-amber-100 text-amber-700",
    approved: "bg-emerald-100 text-emerald-700",
    suspended: "bg-red-100 text-red-700",
};
const INQ_LABEL = { new: "Nueva", replied: "Respondida", closed: "Cerrada" };

const fmtMoney = (cents, symbol) => `${symbol || "$"}${((Number(cents) || 0) / 100).toFixed(2)}`;
const fmtDate = (v) => (v ? String(v).slice(0, 16).replace("T", " ") : "—");

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
        <div className="fixed inset-0 z-50 bg-gray-900/50 flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-white rounded-3xl p-6 sm:p-8 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-black text-gray-900 mb-5">{title}</h3>
                <form
                    className="space-y-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        onSave({ ...form, commission_pct: Number(form.commission_pct) });
                    }}
                >
                    <div>
                        <label className={labelCls}>Nombre de la tienda *</label>
                        <input type="text" className={inputCls} value={form.name} onChange={set("name")} required maxLength={120} />
                    </div>
                    <div>
                        <label className={labelCls}>Email *</label>
                        <input type="email" className={inputCls} value={form.email} onChange={set("email")} required maxLength={200} />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className={labelCls}>Teléfono</label>
                            <input type="text" className={inputCls} value={form.phone} onChange={set("phone")} maxLength={40} />
                        </div>
                        <div>
                            <label className={labelCls}>Comisión % (informativa)</label>
                            <input type="number" min="0" max="100" step="1" className={inputCls} value={form.commission_pct} onChange={set("commission_pct")} />
                        </div>
                    </div>
                    <div>
                        <label className={labelCls}>Logo (URL)</label>
                        <input type="text" className={inputCls} value={form.logo_url} onChange={set("logo_url")} placeholder="https://… o /uploads/…" maxLength={500} />
                    </div>
                    <div>
                        <label className={labelCls}>Descripción</label>
                        <textarea className={`${inputCls} min-h-[90px]`} value={form.description} onChange={set("description")} maxLength={2000} />
                    </div>
                    <div className="flex justify-end gap-3 pt-2">
                        <button type="button" className={btnGhostCls} onClick={onClose}>Cancelar</button>
                        <button type="submit" className={btnCls} disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button>
                    </div>
                </form>
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
        <div className="max-w-6xl mx-auto p-4 sm:p-8">
            <div className="mb-6">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Marketplace</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Directorio multi-vendedor · portal de vendedores con código de acceso
                </p>
            </div>

            {/* v1 scope banner — this marketplace generates LEADS, it does not process payments. */}
            <div className="bg-blue-50 border border-blue-100 text-blue-800 text-sm rounded-2xl px-5 py-4 mb-6 leading-relaxed">
                <strong>Marketplace v1 = generación de contactos (leads).</strong> Los compradores consultan por producto
                y cada vendedor cierra la venta por su cuenta. No hay checkout centralizado ni cobro de comisiones
                automático — el porcentaje de comisión del reporte es informativo.
            </div>

            <div className="flex flex-wrap gap-2 mb-6">
                {tabs.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        onClick={() => { setTab(t.id); setMessage(""); }}
                        className={`px-4 py-2.5 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${tab === t.id ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                    >
                        {t.label}
                        {t.badge ? <span className="ml-2 inline-flex items-center justify-center min-w-[1.3rem] h-5 px-1 rounded-full bg-amber-400 text-gray-900 text-[10px]">{t.badge}</span> : null}
                    </button>
                ))}
            </div>

            {message && (
                <div className={`text-sm px-4 py-3 rounded-xl mb-5 ${isError ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>{message}</div>
            )}

            {/* ============================== VENDEDORES ============================== */}
            {tab === "vendors" && (
                <div className={cardCls}>
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
                        <div className="flex items-center gap-3">
                            <h2 className="font-bold text-gray-800">Vendedores</h2>
                            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-3 py-2 bg-gray-50 border-2 border-gray-100 rounded-xl text-xs font-bold outline-none">
                                <option value="">Todos los estados</option>
                                <option value="pending">Pendientes</option>
                                <option value="approved">Aprobadas</option>
                                <option value="suspended">Suspendidas</option>
                            </select>
                        </div>
                        <button type="button" className={btnCls} onClick={() => setCreating(true)}>+ Crear vendedor</button>
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead>
                                <tr className="border-b-2 border-gray-100">
                                    <th className={thCls}>Tienda</th>
                                    <th className={thCls}>Contacto</th>
                                    <th className={thCls}>Estado</th>
                                    <th className={thCls}>Código</th>
                                    <th className={thCls}>Prod. / Cons.</th>
                                    <th className={thCls}>Acciones</th>
                                </tr>
                            </thead>
                            <tbody>
                                {visibleVendors.length === 0 ? (
                                    <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-gray-400">Sin vendedores{statusFilter ? " en este estado" : " todavía — las solicitudes públicas aparecerán aquí"}.</td></tr>
                                ) : visibleVendors.map((v) => (
                                    <tr key={v.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                                        <td className={tdCls}>
                                            <div className="font-bold text-gray-900">{v.name}</div>
                                            <div className="text-[11px] text-gray-400">/{v.slug} · {fmtDate(v.created_at)}</div>
                                            {v.description ? <div className="text-[11px] text-gray-400 max-w-[220px] truncate">{v.description}</div> : null}
                                        </td>
                                        <td className={tdCls}>
                                            <div>{v.email}</div>
                                            {v.phone ? <div className="text-[11px] text-gray-400">{v.phone}</div> : null}
                                        </td>
                                        <td className={tdCls}>
                                            <span className={`inline-block px-2.5 py-1 rounded-full text-[10px] font-black uppercase ${STATUS_BADGE[v.status] || "bg-gray-100 text-gray-600"}`}>
                                                {STATUS_LABEL[v.status] || v.status}
                                            </span>
                                        </td>
                                        <td className={tdCls}>
                                            {v.access_code ? (
                                                <span className="inline-flex items-center gap-1.5">
                                                    <code className="bg-gray-100 rounded-lg px-2 py-1 font-mono text-xs font-bold">{v.access_code}</code>
                                                    <button type="button" title="Copiar código" className="text-gray-400 hover:text-gray-700 text-xs font-bold" onClick={() => copyCode(v.access_code)}>Copiar</button>
                                                </span>
                                            ) : <span className="text-gray-300 text-xs">— al aprobar —</span>}
                                        </td>
                                        <td className={tdCls}>
                                            <span className="text-xs font-bold">{v.product_count} / {v.inquiry_count}</span>
                                        </td>
                                        <td className={tdCls}>
                                            <div className="flex flex-wrap gap-1.5">
                                                {v.status !== "approved" && (
                                                    <button type="button" disabled={busy} className={`${btnSmCls} bg-emerald-100 hover:bg-emerald-200 text-emerald-700`} onClick={() => approve(v)}>Aprobar</button>
                                                )}
                                                {v.status === "approved" && (
                                                    <button type="button" disabled={busy} className={`${btnSmCls} bg-amber-100 hover:bg-amber-200 text-amber-700`} onClick={() => suspend(v)}>Suspender</button>
                                                )}
                                                {v.access_code && (
                                                    <button type="button" disabled={busy} className={`${btnSmCls} bg-gray-100 hover:bg-gray-200 text-gray-600`} onClick={() => rotateCode(v)}>Rotar código</button>
                                                )}
                                                <button type="button" disabled={busy} className={`${btnSmCls} bg-blue-100 hover:bg-blue-200 text-blue-700`} onClick={() => setEditVendor(v)}>Editar</button>
                                                <button type="button" disabled={busy} className={`${btnSmCls} bg-red-100 hover:bg-red-200 text-red-700`} onClick={() => removeVendor(v)}>Eliminar</button>
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
                <div className={cardCls}>
                    <h2 className="font-bold text-gray-800 mb-5">Todos los productos</h2>
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead>
                                <tr className="border-b-2 border-gray-100">
                                    <th className={thCls}>Producto</th>
                                    <th className={thCls}>Tienda</th>
                                    <th className={thCls}>Precio</th>
                                    <th className={thCls}>Categoría</th>
                                    <th className={thCls}>Visibilidad</th>
                                    <th className={thCls}>Acciones</th>
                                </tr>
                            </thead>
                            <tbody>
                                {products.length === 0 ? (
                                    <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-gray-400">Sin productos todavía — los vendedores los crean desde su portal.</td></tr>
                                ) : products.map((p) => (
                                    <tr key={p.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                                        <td className={tdCls}>
                                            <div className="flex items-center gap-2">
                                                {p.image_url ? <img src={p.image_url} alt={p.name} decoding="async" className="w-10 h-10 rounded-lg object-cover border border-gray-100" /> : null}
                                                <div>
                                                    <div className="font-bold text-gray-900">{p.name}</div>
                                                    <div className="text-[11px] text-gray-400">{fmtDate(p.created_at)}</div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className={tdCls}>
                                            {p.vendor_name}
                                            {p.vendor_status !== "approved" ? <span className="ml-1 text-[10px] font-black uppercase text-red-500">({STATUS_LABEL[p.vendor_status] || p.vendor_status})</span> : null}
                                        </td>
                                        <td className={tdCls}><span className="font-bold">{fmtMoney(p.price_cents, symbol)}</span></td>
                                        <td className={tdCls}>{p.category || "—"}</td>
                                        <td className={tdCls}>
                                            <span className={`inline-block px-2.5 py-1 rounded-full text-[10px] font-black uppercase ${p.is_published ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>
                                                {p.is_published ? "Publicado" : "Oculto"}
                                            </span>
                                        </td>
                                        <td className={tdCls}>
                                            <div className="flex flex-wrap gap-1.5">
                                                <button type="button" disabled={busy} className={`${btnSmCls} bg-gray-100 hover:bg-gray-200 text-gray-600`} onClick={() => togglePublish(p)}>
                                                    {p.is_published ? "Ocultar" : "Publicar"}
                                                </button>
                                                <button type="button" disabled={busy} className={`${btnSmCls} bg-red-100 hover:bg-red-200 text-red-700`} onClick={() => removeProduct(p)}>Eliminar</button>
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
                <div className={cardCls}>
                    <h2 className="font-bold text-gray-800 mb-5">Consultas de compradores</h2>
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead>
                                <tr className="border-b-2 border-gray-100">
                                    <th className={thCls}>Comprador</th>
                                    <th className={thCls}>Producto / Tienda</th>
                                    <th className={thCls}>Mensaje</th>
                                    <th className={thCls}>Fecha</th>
                                    <th className={thCls}>Estado</th>
                                </tr>
                            </thead>
                            <tbody>
                                {inquiries.length === 0 ? (
                                    <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-gray-400">Sin consultas todavía.</td></tr>
                                ) : inquiries.map((i) => (
                                    <tr key={i.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                                        <td className={tdCls}>
                                            <div className="font-bold text-gray-900">{i.buyer_name}</div>
                                            <a href={`mailto:${i.buyer_email}`} className="text-[11px] text-blue-500">{i.buyer_email}</a>
                                        </td>
                                        <td className={tdCls}>
                                            <div>{i.product_name || <span className="text-gray-300">(producto eliminado)</span>}</div>
                                            <div className="text-[11px] text-gray-400">{i.vendor_name}</div>
                                        </td>
                                        <td className={`${tdCls} max-w-[280px]`}><div className="whitespace-pre-wrap break-words text-xs">{i.message}</div></td>
                                        <td className={tdCls}><span className="text-xs">{fmtDate(i.created_at)}</span></td>
                                        <td className={tdCls}>
                                            <select
                                                value={i.status}
                                                disabled={busy}
                                                onChange={(e) => setInquiryStatus(i, e.target.value)}
                                                className="px-2 py-1.5 bg-gray-50 border-2 border-gray-100 rounded-xl text-xs font-bold outline-none"
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
                <div className="space-y-6">
                    <div className={cardCls}>
                        <div className="flex flex-wrap items-end justify-between gap-4">
                            <div>
                                <h2 className="font-bold text-gray-800">Configuración</h2>
                                <p className="text-[11px] text-gray-400 mt-1">Símbolo con el que se muestran los precios (solo visual — los precios se guardan en centavos).</p>
                            </div>
                            <div className="flex items-center gap-2">
                                <input type="text" value={symbolDraft} onChange={(e) => setSymbolDraft(e.target.value)} maxLength={8} className="w-24 px-3 py-2.5 bg-gray-50 border-2 border-gray-100 rounded-xl text-sm font-bold outline-none focus:border-blue-500" />
                                <button type="button" className={btnCls} disabled={busy || !symbolDraft.trim()} onClick={saveSymbol}>Guardar</button>
                            </div>
                        </div>
                    </div>

                    <div className={cardCls}>
                        <h2 className="font-bold text-gray-800 mb-1">Reporte por vendedor</h2>
                        {report?.note ? <p className="text-[11px] text-gray-400 mb-5">{report.note}</p> : null}
                        <div className="overflow-x-auto">
                            <table className="w-full">
                                <thead>
                                    <tr className="border-b-2 border-gray-100">
                                        <th className={thCls}>Tienda</th>
                                        <th className={thCls}>Productos (publ.)</th>
                                        <th className={thCls}>Consultas (nuevas)</th>
                                        <th className={thCls}>Valor catálogo</th>
                                        <th className={thCls}>Comisión %</th>
                                        <th className={thCls}>Comisión estimada</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {!report || report.vendors.length === 0 ? (
                                        <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-gray-400">Sin datos todavía.</td></tr>
                                    ) : report.vendors.map((v) => {
                                        const pct = Number(commissionDrafts[v.id]);
                                        const estCents = Number.isFinite(pct) ? Math.round((Number(v.catalog_cents) || 0) * pct / 100) : 0;
                                        return (
                                            <tr key={v.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                                                <td className={tdCls}>
                                                    <div className="font-bold text-gray-900">{v.name}</div>
                                                    <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${STATUS_BADGE[v.status] || "bg-gray-100 text-gray-600"}`}>{STATUS_LABEL[v.status] || v.status}</span>
                                                </td>
                                                <td className={tdCls}><span className="font-bold">{v.products}</span> <span className="text-gray-400 text-xs">({v.published_products} publ.)</span></td>
                                                <td className={tdCls}><span className="font-bold">{v.inquiries}</span> <span className="text-gray-400 text-xs">({v.new_inquiries} nuevas)</span></td>
                                                <td className={tdCls}>{fmtMoney(v.catalog_cents, report.currencySymbol || symbol)}</td>
                                                <td className={tdCls}>
                                                    <div className="flex items-center gap-1.5">
                                                        <input
                                                            type="number" min="0" max="100" step="1"
                                                            value={commissionDrafts[v.id] ?? ""}
                                                            onChange={(e) => setCommissionDrafts({ ...commissionDrafts, [v.id]: e.target.value })}
                                                            className="w-16 px-2 py-1.5 bg-gray-50 border-2 border-gray-100 rounded-xl text-xs font-bold outline-none focus:border-blue-500"
                                                        />
                                                        <button type="button" disabled={busy} className={`${btnSmCls} bg-gray-100 hover:bg-gray-200 text-gray-600`} onClick={() => saveCommission(v.id)}>OK</button>
                                                    </div>
                                                </td>
                                                <td className={tdCls}>
                                                    <span className="text-xs text-gray-500" title="Estimación informativa: valor del catálogo publicado × comisión. No hay ventas registradas en v1.">
                                                        ≈ {fmtMoney(estCents, report.currencySymbol || symbol)}
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                        <p className="text-[11px] text-gray-400 mt-5 leading-relaxed">
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
