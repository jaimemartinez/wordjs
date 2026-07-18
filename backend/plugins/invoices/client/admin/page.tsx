// @ts-nocheck
"use client";

/**
 * Admin page for the Invoices plugin (/admin/plugin/invoices).
 * Dashboard cards (facturado/pendiente/vencido), invoice list with status pills + search,
 * a builder modal (client, dynamic item rows, tax %, discount, dates, notes, live totals),
 * per-row actions (edit / copy public link / send mail / status / delete), CSV export and a
 * config tab (business identity + public invoice page URL + footer note).
 */

import React, { useEffect, useMemo, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const inputSmCls = "w-full px-3 py-2 bg-gray-50/60 border-2 border-gray-100 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none text-sm";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnDark = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnGhost = "px-5 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnMini = "px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all disabled:opacity-40";

const STATUS_META = {
    draft: { label: "Borrador", cls: "bg-gray-100 text-gray-600" },
    sent: { label: "Enviada", cls: "bg-blue-100 text-blue-700" },
    paid: { label: "Pagada", cls: "bg-green-100 text-green-700" },
    overdue: { label: "Vencida", cls: "bg-red-100 text-red-700" },
    void: { label: "Anulada", cls: "bg-gray-200 text-gray-500 line-through" },
};

const money = (cents, symbol) => `${symbol || "$"}${((Number(cents) || 0) / 100).toFixed(2)}`;

// Decimal text input ("12,50" / "12.50") -> integer cents. Empty/garbage -> 0.
const toCents = (str) => {
    const n = parseFloat(String(str == null ? "" : str).replace(",", "."));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};

const buildLink = (pageUrl, token) => {
    let base = String(pageUrl || "").trim();
    if (!base) return "";
    if (base.startsWith("/") && typeof window !== "undefined") base = window.location.origin + base;
    return base + (base.includes("?") ? "&" : "?") + "inv=" + token;
};

// Mirrors the server formula so the modal preview matches what /save will persist.
function previewTotals(rows, taxPctStr, discountStr) {
    let subtotal = 0;
    for (const r of rows) {
        const qty = parseFloat(String(r.qty).replace(",", "."));
        const unit = toCents(r.unit);
        if (Number.isFinite(qty) && qty > 0 && unit >= 0) subtotal += Math.round(qty * unit);
    }
    let taxPct = Math.round(Number(taxPctStr));
    if (!Number.isFinite(taxPct)) taxPct = 0;
    taxPct = Math.min(100, Math.max(0, taxPct));
    const discount = Math.min(toCents(discountStr), subtotal);
    const taxable = subtotal - discount;
    const tax = Math.round((taxable * taxPct) / 100);
    return { subtotal, discount, tax, total: taxable + tax, taxPct };
}

let rowSeq = 1;
const emptyRow = () => ({ key: rowSeq++, description: "", qty: "1", unit: "" });

// Module-level (never define a component inside a component — remounting steals input focus).
function InvoiceModal({ initial, config, onClose, onDone }) {
    const isEdit = !!(initial && initial.id);
    const [clientName, setClientName] = useState(isEdit ? initial.client_name || "" : "");
    const [clientEmail, setClientEmail] = useState(isEdit ? initial.client_email || "" : "");
    const [clientAddress, setClientAddress] = useState(isEdit ? initial.client_address || "" : "");
    const [clientTaxId, setClientTaxId] = useState(isEdit ? initial.client_tax_id || "" : "");
    const [rows, setRows] = useState(() =>
        isEdit && Array.isArray(initial.items) && initial.items.length > 0
            ? initial.items.map((it) => ({ key: rowSeq++, description: it.description || "", qty: String(it.qty ?? 1), unit: ((Number(it.unit_cents) || 0) / 100).toFixed(2) }))
            : [emptyRow()]
    );
    const [taxPct, setTaxPct] = useState(isEdit ? String(initial.tax_pct ?? 0) : "0");
    const [discount, setDiscount] = useState(isEdit && initial.discount_cents ? ((Number(initial.discount_cents) || 0) / 100).toFixed(2) : "");
    const [issuedAt, setIssuedAt] = useState(isEdit ? (initial.issued_at || "").slice(0, 10) : new Date().toISOString().slice(0, 10));
    const [dueAt, setDueAt] = useState(isEdit ? (initial.due_at || "").slice(0, 10) : "");
    const [notes, setNotes] = useState(isEdit ? initial.notes || "" : "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const symbol = (isEdit && initial.currency_symbol) || config?.currencySymbol || "$";
    const totals = useMemo(() => previewTotals(rows, taxPct, discount), [rows, taxPct, discount]);
    const canSendMail = !!clientEmail.trim() && !!(config && config.invoicePageUrl);

    const setRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    const removeRow = (key) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : rs));
    const addRow = () => setRows((rs) => (rs.length < 50 ? [...rs, emptyRow()] : rs));

    const doSave = async (sendAfter) => {
        setBusy(true);
        setError("");
        try {
            const payload = {
                id: isEdit ? initial.id : undefined,
                client_name: clientName,
                client_email: clientEmail,
                client_address: clientAddress,
                client_tax_id: clientTaxId,
                items: rows.map((r) => ({
                    description: r.description,
                    qty: parseFloat(String(r.qty).replace(",", ".")),
                    unit_cents: toCents(r.unit),
                })),
                tax_pct: parseInt(taxPct, 10) || 0,
                discount_cents: toCents(discount),
                issued_at: issuedAt,
                due_at: dueAt,
                notes,
            };
            const data = await apiPost("/plugin/invoices/save", payload);
            const saved = data && data.invoice;
            if (sendAfter && saved) {
                const r = await apiPost(`/plugin/invoices/${saved.id}/send`, {});
                if (r && r.sent) onDone(`Factura ${saved.number} guardada y enviada a ${clientEmail.trim()}.`);
                else onDone(`Factura ${saved.number} guardada, pero el correo falló: ${(r && r.error) || "error desconocido"}.`);
            } else {
                onDone(`Factura ${saved ? saved.number : ""} guardada.`);
            }
        } catch (err) {
            setError(err?.message || String(err));
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl my-8 p-6 sm:p-8">
                <div className="flex items-center justify-between mb-6">
                    <h2 className="text-xl font-black text-gray-900 tracking-tight">
                        {isEdit ? `Editar factura ${initial.number}` : "Nueva factura"}
                    </h2>
                    <button type="button" onClick={onClose} className="w-9 h-9 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 font-bold">×</button>
                </div>

                {/* Client */}
                <div className="grid sm:grid-cols-2 gap-4 mb-5">
                    <div>
                        <label className={labelCls}>Cliente *</label>
                        <input type="text" value={clientName} onChange={(e) => setClientName(e.target.value)} className={inputCls} placeholder="Nombre o razón social" />
                    </div>
                    <div>
                        <label className={labelCls}>Correo del cliente</label>
                        <input type="email" value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} className={inputCls} placeholder="cliente@ejemplo.com" />
                    </div>
                    <div>
                        <label className={labelCls}>Dirección</label>
                        <input type="text" value={clientAddress} onChange={(e) => setClientAddress(e.target.value)} className={inputCls} placeholder="Calle, ciudad…" />
                    </div>
                    <div>
                        <label className={labelCls}>NIF / RFC / Tax ID</label>
                        <input type="text" value={clientTaxId} onChange={(e) => setClientTaxId(e.target.value)} className={inputCls} />
                    </div>
                </div>

                {/* Items */}
                <label className={labelCls}>Conceptos</label>
                <div className="space-y-2 mb-3">
                    {rows.map((r) => (
                        <div key={r.key} className="flex gap-2 items-center">
                            <input type="text" value={r.description} onChange={(e) => setRow(r.key, { description: e.target.value })} className={inputSmCls + " flex-1"} placeholder="Descripción" />
                            <input type="text" inputMode="decimal" value={r.qty} onChange={(e) => setRow(r.key, { qty: e.target.value })} className={inputSmCls + " w-20 text-right"} placeholder="Cant." title="Cantidad" />
                            <input type="text" inputMode="decimal" value={r.unit} onChange={(e) => setRow(r.key, { unit: e.target.value })} className={inputSmCls + " w-28 text-right"} placeholder="Precio" title="Precio unitario" />
                            <div className="w-24 text-right text-sm font-bold text-gray-700 tabular-nums">
                                {money(Math.round((parseFloat(String(r.qty).replace(",", ".")) || 0) * toCents(r.unit)), symbol)}
                            </div>
                            <button type="button" onClick={() => removeRow(r.key)} disabled={rows.length === 1} className="w-8 h-8 rounded-lg bg-red-50 hover:bg-red-100 text-red-500 font-bold disabled:opacity-30" title="Quitar concepto">−</button>
                        </div>
                    ))}
                </div>
                <button type="button" onClick={addRow} disabled={rows.length >= 50} className="text-xs font-black uppercase tracking-widest text-blue-600 hover:text-blue-800 mb-5 disabled:opacity-40">
                    + Agregar concepto
                </button>

                {/* Tax / discount / dates */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
                    <div>
                        <label className={labelCls}>Impuesto %</label>
                        <input type="number" min="0" max="100" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} className={inputSmCls} />
                    </div>
                    <div>
                        <label className={labelCls}>Descuento ({symbol})</label>
                        <input type="text" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} className={inputSmCls} placeholder="0.00" />
                    </div>
                    <div>
                        <label className={labelCls}>Fecha de emisión</label>
                        <input type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} className={inputSmCls} />
                    </div>
                    <div>
                        <label className={labelCls}>Vencimiento</label>
                        <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className={inputSmCls} />
                    </div>
                </div>

                <div className="mb-5">
                    <label className={labelCls}>Notas (visibles en la factura)</label>
                    <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputSmCls} placeholder="Condiciones de pago, cuenta bancaria…" />
                </div>

                {/* Live totals preview */}
                <div className="bg-gray-50 rounded-2xl p-4 mb-5 ml-auto sm:w-72 text-sm">
                    <div className="flex justify-between py-1"><span className="text-gray-500">Subtotal</span><span className="font-bold tabular-nums">{money(totals.subtotal, symbol)}</span></div>
                    {totals.discount > 0 && (
                        <div className="flex justify-between py-1"><span className="text-gray-500">Descuento</span><span className="font-bold tabular-nums text-red-600">−{money(totals.discount, symbol)}</span></div>
                    )}
                    <div className="flex justify-between py-1"><span className="text-gray-500">Impuesto ({totals.taxPct}%)</span><span className="font-bold tabular-nums">{money(totals.tax, symbol)}</span></div>
                    <div className="flex justify-between py-2 border-t border-gray-200 mt-1"><span className="font-black">Total</span><span className="font-black tabular-nums">{money(totals.total, symbol)}</span></div>
                </div>

                {error && <div className="text-sm px-4 py-3 rounded-xl bg-red-50 text-red-600 mb-4">{error}</div>}
                {!config?.invoicePageUrl && (
                    <div className="text-[11px] px-4 py-3 rounded-xl bg-amber-50 text-amber-700 mb-4">
                        Para enviar por correo o copiar el enlace público, configura primero la URL de la página de facturas en la pestaña Configuración.
                    </div>
                )}

                <div className="flex flex-wrap gap-3 justify-end">
                    <button type="button" onClick={onClose} className={btnGhost}>Cancelar</button>
                    <button type="button" onClick={() => doSave(false)} disabled={busy} className={btnGhost}>
                        {busy ? "Guardando…" : isEdit ? "Guardar cambios" : "Guardar borrador"}
                    </button>
                    <button type="button" onClick={() => doSave(true)} disabled={busy || !canSendMail} className={btnDark}
                        title={canSendMail ? "Guardar y enviar el enlace por correo" : "Necesita correo del cliente y la URL de la página de facturas"}>
                        {busy ? "Enviando…" : "Guardar y enviar por correo"}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function InvoicesAdminPage() {
    const [tab, setTab] = useState("list");
    const [invoices, setInvoices] = useState([]);
    const [summary, setSummary] = useState(null);
    const [config, setConfig] = useState(null);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [modal, setModal] = useState(null); // null | { initial: invoice|null }
    const [message, setMessage] = useState("");
    const [busyId, setBusyId] = useState(null);
    const [cfgBusy, setCfgBusy] = useState(false);
    const [cfgMsg, setCfgMsg] = useState("");

    const load = async (searchVal = search, statusVal = statusFilter) => {
        try {
            const p = new URLSearchParams();
            if (searchVal) p.set("search", searchVal);
            if (statusVal) p.set("status", statusVal);
            const data = await api(`/plugin/invoices/list?${p.toString()}`);
            setInvoices(data.invoices || []);
            setSummary(data.summary || null);
        } catch (err) {
            setMessage(`Error al cargar: ${err?.message || err}`);
        }
    };
    const loadConfig = async () => {
        try {
            setConfig(await api("/plugin/invoices/config"));
        } catch {
            setConfig(null);
        }
    };

    useEffect(() => { load(); loadConfig(); }, []);
    useEffect(() => { load(search, statusFilter); }, [statusFilter]);

    const symbol = config?.currencySymbol || "$";

    const onModalDone = (msg) => {
        setModal(null);
        setMessage(msg);
        load();
    };

    const copyLink = async (inv) => {
        if (!config?.invoicePageUrl) {
            setMessage("Configura la URL de la página de facturas en la pestaña Configuración para poder copiar enlaces.");
            return;
        }
        const link = buildLink(config.invoicePageUrl, inv.token);
        try {
            await navigator.clipboard.writeText(link);
            setMessage(`Enlace de ${inv.number} copiado.`);
        } catch {
            window.prompt("Copia el enlace público:", link);
        }
    };

    const sendMail = async (inv) => {
        setBusyId(inv.id);
        try {
            const r = await apiPost(`/plugin/invoices/${inv.id}/send`, {});
            setMessage(r && r.sent ? `Correo enviado a ${inv.client_email}.` : `No se envió: ${(r && r.error) || "error desconocido"}`);
            load();
        } catch (err) {
            setMessage(`No se envió: ${err?.message || err}`);
        } finally {
            setBusyId(null);
        }
    };

    const changeStatus = async (inv, status) => {
        if (!status || status === inv.status) return;
        setBusyId(inv.id);
        try {
            await apiPost(`/plugin/invoices/${inv.id}/status`, { status });
            setMessage(`${inv.number} → ${STATUS_META[status]?.label || status}.`);
            load();
        } catch (err) {
            setMessage(`Error: ${err?.message || err}`);
        } finally {
            setBusyId(null);
        }
    };

    const remove = async (inv) => {
        if (!window.confirm(`¿Eliminar la factura ${inv.number} de ${inv.client_name}? Esta acción no se puede deshacer.`)) return;
        setBusyId(inv.id);
        try {
            await apiDelete(`/plugin/invoices/${inv.id}`);
            setMessage(`Factura ${inv.number} eliminada.`);
            load();
        } catch (err) {
            setMessage(`Error al eliminar: ${err?.message || err}`);
        } finally {
            setBusyId(null);
        }
    };

    const exportCsv = async () => {
        try {
            const data = await api("/plugin/invoices/export");
            const blob = new Blob([data.csv || ""], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = data.filename || "facturas.csv";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            setMessage(`Exportadas ${data.count ?? 0} facturas.`);
        } catch (err) {
            setMessage(`Error al exportar: ${err?.message || err}`);
        }
    };

    const saveConfig = async (e) => {
        e.preventDefault();
        setCfgBusy(true);
        setCfgMsg("");
        try {
            const saved = await apiPost("/plugin/invoices/config", config || {});
            setConfig(saved);
            setCfgMsg("Configuración guardada.");
        } catch (err) {
            setCfgMsg(`Error: ${err?.message || err}`);
        } finally {
            setCfgBusy(false);
        }
    };

    const setCfg = (key, value) => setConfig((c) => ({ ...(c || {}), [key]: value }));

    return (
        <div className="max-w-5xl mx-auto p-4 sm:p-8">
            <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Facturas</h1>
                    <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                        Facturas con enlace público imprimible y envío por correo
                    </p>
                </div>
                <div className="flex gap-2">
                    <button type="button" onClick={() => setTab("list")} className={tab === "list" ? btnDark : btnGhost}>Facturas</button>
                    <button type="button" onClick={() => setTab("config")} className={tab === "config" ? btnDark : btnGhost}>Configuración</button>
                </div>
            </div>

            {message && (
                <div className="text-sm px-4 py-3 rounded-xl bg-blue-50 text-blue-700 mb-6 flex justify-between items-center gap-3">
                    <span>{message}</span>
                    <button type="button" onClick={() => setMessage("")} className="text-blue-400 hover:text-blue-700 font-bold">×</button>
                </div>
            )}

            {tab === "list" && (
                <>
                    {/* Dashboard cards */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
                        <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6">
                            <p className={labelCls}>Facturado (pagadas)</p>
                            <p className="text-2xl font-black text-green-600 tabular-nums">{money(summary?.paid_cents, symbol)}</p>
                            <p className="text-[11px] text-gray-400 mt-1">{summary?.count_paid ?? 0} facturas pagadas</p>
                        </div>
                        <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6">
                            <p className={labelCls}>Pendiente (enviadas + vencidas)</p>
                            <p className="text-2xl font-black text-blue-600 tabular-nums">{money(summary?.pending_cents, symbol)}</p>
                            <p className="text-[11px] text-gray-400 mt-1">{(summary?.count_sent ?? 0) + (summary?.count_overdue ?? 0)} facturas por cobrar</p>
                        </div>
                        <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6">
                            <p className={labelCls}>Vencido</p>
                            <p className="text-2xl font-black text-red-600 tabular-nums">{money(summary?.overdue_cents, symbol)}</p>
                            <p className="text-[11px] text-gray-400 mt-1">{summary?.count_overdue ?? 0} facturas vencidas</p>
                        </div>
                    </div>

                    {/* Toolbar */}
                    <div className="flex flex-wrap items-center gap-3 mb-4">
                        <input
                            type="text" value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") load(); }}
                            placeholder="Buscar por número, cliente o correo…"
                            className={inputSmCls + " max-w-xs"}
                        />
                        <button type="button" onClick={() => load()} className={btnGhost + " !py-2"}>Buscar</button>
                        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputSmCls + " w-40"}>
                            <option value="">Todos los estados</option>
                            <option value="draft">Borrador</option>
                            <option value="sent">Enviada</option>
                            <option value="paid">Pagada</option>
                            <option value="overdue">Vencida</option>
                            <option value="void">Anulada</option>
                        </select>
                        <div className="flex-1" />
                        <button type="button" onClick={exportCsv} className={btnGhost + " !py-2"}>Exportar CSV</button>
                        <button type="button" onClick={() => setModal({ initial: null })} className={btnDark + " !py-2"}>+ Nueva factura</button>
                    </div>

                    {/* List */}
                    <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 overflow-x-auto">
                        {invoices.length === 0 ? (
                            <p className="text-sm text-gray-400 p-8 text-center">No hay facturas todavía — crea la primera con "Nueva factura".</p>
                        ) : (
                            <table className="w-full text-sm min-w-[720px]">
                                <thead>
                                    <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                        <th className="px-5 py-4">Número</th>
                                        <th className="px-3 py-4">Cliente</th>
                                        <th className="px-3 py-4">Emitida</th>
                                        <th className="px-3 py-4">Vence</th>
                                        <th className="px-3 py-4 text-right">Total</th>
                                        <th className="px-3 py-4">Estado</th>
                                        <th className="px-5 py-4 text-right">Acciones</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {invoices.map((inv) => {
                                        const meta = STATUS_META[inv.effective_status] || STATUS_META.draft;
                                        return (
                                            <tr key={inv.id} className="border-b border-gray-50 hover:bg-gray-50/60">
                                                <td className="px-5 py-3 font-black text-gray-800">{inv.number}</td>
                                                <td className="px-3 py-3">
                                                    <div className="font-bold text-gray-700">{inv.client_name}</div>
                                                    {inv.client_email && <div className="text-[11px] text-gray-400">{inv.client_email}</div>}
                                                </td>
                                                <td className="px-3 py-3 text-gray-500">{(inv.issued_at || "").slice(0, 10) || "—"}</td>
                                                <td className="px-3 py-3 text-gray-500">{(inv.due_at || "").slice(0, 10) || "—"}</td>
                                                <td className="px-3 py-3 text-right font-bold tabular-nums">{money(inv.total_cents, inv.currency_symbol)}</td>
                                                <td className="px-3 py-3">
                                                    <span className={`inline-block px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ${meta.cls}`}>{meta.label}</span>
                                                </td>
                                                <td className="px-5 py-3">
                                                    <div className="flex items-center justify-end gap-1.5 flex-wrap">
                                                        <button type="button" onClick={() => setModal({ initial: inv })} disabled={busyId === inv.id} className={btnMini + " bg-gray-100 hover:bg-gray-200 text-gray-700"}>Editar</button>
                                                        <button type="button" onClick={() => copyLink(inv)} disabled={busyId === inv.id} className={btnMini + " bg-gray-100 hover:bg-gray-200 text-gray-700"} title="Copiar enlace público">Enlace</button>
                                                        <button type="button" onClick={() => sendMail(inv)} disabled={busyId === inv.id || !inv.client_email} className={btnMini + " bg-blue-50 hover:bg-blue-100 text-blue-700"} title={inv.client_email ? "Enviar por correo" : "La factura no tiene correo del cliente"}>Correo</button>
                                                        <select
                                                            value={inv.status}
                                                            onChange={(e) => changeStatus(inv, e.target.value)}
                                                            disabled={busyId === inv.id}
                                                            className="px-2 py-1.5 rounded-lg text-[11px] font-bold bg-gray-50 border border-gray-200 outline-none"
                                                            title="Cambiar estado"
                                                        >
                                                            <option value="draft">Borrador</option>
                                                            <option value="sent">Enviada</option>
                                                            <option value="paid">Pagada</option>
                                                            <option value="overdue">Vencida</option>
                                                            <option value="void">Anulada</option>
                                                        </select>
                                                        <button type="button" onClick={() => remove(inv)} disabled={busyId === inv.id} className={btnMini + " bg-red-50 hover:bg-red-100 text-red-600"}>Eliminar</button>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                    </div>
                </>
            )}

            {tab === "config" && (
                <form onSubmit={saveConfig} className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8 space-y-5 max-w-2xl">
                    <h2 className="font-bold text-gray-800">Identidad del negocio</h2>
                    <div className="grid sm:grid-cols-2 gap-4">
                        <div>
                            <label className={labelCls}>Nombre del negocio</label>
                            <input type="text" value={config?.businessName || ""} onChange={(e) => setCfg("businessName", e.target.value)} className={inputCls} />
                        </div>
                        <div>
                            <label className={labelCls}>NIF / RFC / Tax ID</label>
                            <input type="text" value={config?.businessTaxId || ""} onChange={(e) => setCfg("businessTaxId", e.target.value)} className={inputCls} />
                        </div>
                    </div>
                    <div>
                        <label className={labelCls}>Dirección</label>
                        <input type="text" value={config?.businessAddress || ""} onChange={(e) => setCfg("businessAddress", e.target.value)} className={inputCls} />
                    </div>
                    <div className="grid sm:grid-cols-2 gap-4">
                        <div>
                            <label className={labelCls}>Correo del negocio</label>
                            <input type="email" value={config?.businessEmail || ""} onChange={(e) => setCfg("businessEmail", e.target.value)} className={inputCls} />
                        </div>
                        <div>
                            <label className={labelCls}>Símbolo de moneda</label>
                            <input type="text" value={config?.currencySymbol || ""} onChange={(e) => setCfg("currencySymbol", e.target.value)} className={inputCls} placeholder="$" />
                        </div>
                    </div>
                    <div>
                        <label className={labelCls}>URL de la página pública de facturas</label>
                        <input type="text" value={config?.invoicePageUrl || ""} onChange={(e) => setCfg("invoicePageUrl", e.target.value)} className={inputCls} placeholder="/factura o https://misitio.com/factura" />
                        <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                            La página pública que contiene el bloque <strong>Invoices</strong> del editor visual. Los enlaces
                            enviados a los clientes tienen la forma <code>{"<URL>?inv=<token>"}</code>.
                        </p>
                    </div>
                    <div>
                        <label className={labelCls}>Nota al pie de la factura</label>
                        <input type="text" value={config?.footerNote || ""} onChange={(e) => setCfg("footerNote", e.target.value)} className={inputCls} placeholder="Gracias por su confianza." />
                    </div>
                    <div className="flex items-center justify-end gap-3">
                        {cfgMsg && <span className={`text-sm ${/Error/i.test(cfgMsg) ? "text-red-600" : "text-green-600"}`}>{cfgMsg}</span>}
                        <button type="submit" disabled={cfgBusy || !config} className={btnDark}>{cfgBusy ? "Guardando…" : "Guardar configuración"}</button>
                    </div>
                </form>
            )}

            {modal && <InvoiceModal initial={modal.initial} config={config} onClose={() => setModal(null)} onDone={onModalDone} />}
        </div>
    );
}
