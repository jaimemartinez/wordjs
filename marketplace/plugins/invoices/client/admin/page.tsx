// @ts-nocheck
"use client";

/**
 * Admin page for the Invoices plugin (/admin/plugin/invoices).
 * Dashboard cards (facturado/pendiente/vencido), invoice list with status pills + search,
 * a builder modal (client, dynamic item rows, tax %, discount, dates, notes, live totals),
 * per-row actions (edit / copy public link / send mail / status / delete), CSV export and a
 * config tab (business identity + public invoice page URL + footer note).
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected by the
 * host admin shell and scoped to .plugin-admin-invoices) — the markup below only uses cf-*
 * classes plus sparse inline styles for one-off layout.
 */

import React, { useEffect, useMemo, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

const STATUS_META = {
    draft: { label: "Borrador", cls: "is-draft" },
    sent: { label: "Enviada", cls: "is-sent" },
    paid: { label: "Pagada", cls: "is-paid" },
    overdue: { label: "Vencida", cls: "is-overdue" },
    void: { label: "Anulada", cls: "is-void" },
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

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconInvoice = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M16 13H8" />
        <path d="M16 17H8" />
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
const IconDownload = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m7 10 5 5 5-5" />
        <path d="M12 15V3" />
    </svg>
);
const IconX = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" {...props}>
        <path d="M18 6 6 18M6 6l12 12" />
    </svg>
);
const IconMinus = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" {...props}>
        <path d="M5 12h14" />
    </svg>
);

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
        <div className="cf-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="cf-letter is-wide" role="dialog" aria-modal="true" aria-label={isEdit ? `Editar factura ${initial.number}` : "Nueva factura"}>
                <div className="cf-letter-body">
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" }}>
                        <h2 className="cf-editor-title" style={{ marginBottom: 0 }}>
                            <IconPen />
                            {isEdit ? `Editar factura ${initial.number}` : "Nueva factura"}
                        </h2>
                        <button type="button" onClick={onClose} aria-label="Cerrar" className="cf-iconbtn"><IconX /></button>
                    </div>

                    {/* Client */}
                    <div className="cf-grid" style={{ marginTop: "1.35rem", marginBottom: "1.35rem" }}>
                        <div>
                            <label className="cf-label" htmlFor="inv-client">Cliente *</label>
                            <input id="inv-client" type="text" value={clientName} onChange={(e) => setClientName(e.target.value)} className="cf-input" placeholder="Nombre o razón social" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="inv-cemail">Correo del cliente</label>
                            <input id="inv-cemail" type="email" value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} className="cf-input" placeholder="cliente@ejemplo.com" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="inv-caddr">Dirección</label>
                            <input id="inv-caddr" type="text" value={clientAddress} onChange={(e) => setClientAddress(e.target.value)} className="cf-input" placeholder="Calle, ciudad…" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="inv-ctax">NIF / RFC / Tax ID</label>
                            <input id="inv-ctax" type="text" value={clientTaxId} onChange={(e) => setClientTaxId(e.target.value)} className="cf-input" />
                        </div>
                    </div>

                    {/* Items */}
                    <span className="cf-label">Conceptos</span>
                    <div style={{ marginBottom: "0.8rem" }}>
                        {rows.map((r) => (
                            <div key={r.key} className="cf-item-row">
                                <input type="text" value={r.description} onChange={(e) => setRow(r.key, { description: e.target.value })} className="cf-input" style={{ flex: 1 }} placeholder="Descripción" aria-label="Descripción" />
                                <input type="text" inputMode="decimal" value={r.qty} onChange={(e) => setRow(r.key, { qty: e.target.value })} className="cf-input" style={{ width: "5rem", flex: "0 0 auto", textAlign: "right" }} placeholder="Cant." title="Cantidad" aria-label="Cantidad" />
                                <input type="text" inputMode="decimal" value={r.unit} onChange={(e) => setRow(r.key, { unit: e.target.value })} className="cf-input" style={{ width: "7rem", flex: "0 0 auto", textAlign: "right" }} placeholder="Precio" title="Precio unitario" aria-label="Precio unitario" />
                                <div className="cf-line-total">
                                    {money(Math.round((parseFloat(String(r.qty).replace(",", ".")) || 0) * toCents(r.unit)), symbol)}
                                </div>
                                <button type="button" onClick={() => removeRow(r.key)} disabled={rows.length === 1} className="cf-iconbtn is-danger" title="Quitar concepto" aria-label="Quitar concepto"><IconMinus /></button>
                            </div>
                        ))}
                    </div>
                    <div style={{ marginBottom: "1.35rem" }}>
                        <button type="button" onClick={addRow} disabled={rows.length >= 50} className="cf-btn-ghost">
                            <IconPlus /> Agregar concepto
                        </button>
                    </div>

                    {/* Tax / discount / dates */}
                    <div className="cf-grid-4" style={{ marginBottom: "1.35rem" }}>
                        <div>
                            <label className="cf-label" htmlFor="inv-tax">Impuesto %</label>
                            <input id="inv-tax" type="number" min="0" max="100" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} className="cf-input" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="inv-discount">Descuento ({symbol})</label>
                            <input id="inv-discount" type="text" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} className="cf-input" placeholder="0.00" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="inv-issued">Fecha de emisión</label>
                            <input id="inv-issued" type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} className="cf-input" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="inv-due">Vencimiento</label>
                            <input id="inv-due" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className="cf-input" />
                        </div>
                    </div>

                    <div style={{ marginBottom: "1.35rem" }}>
                        <label className="cf-label" htmlFor="inv-notes">Notas (visibles en la factura)</label>
                        <textarea id="inv-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="cf-input" placeholder="Condiciones de pago, cuenta bancaria…" />
                    </div>

                    {/* Live totals preview */}
                    <div className="cf-totals">
                        <div className="cf-totals-row"><span>Subtotal</span><span className="cf-totals-val">{money(totals.subtotal, symbol)}</span></div>
                        {totals.discount > 0 && (
                            <div className="cf-totals-row"><span>Descuento</span><span className="cf-totals-val is-danger">−{money(totals.discount, symbol)}</span></div>
                        )}
                        <div className="cf-totals-row"><span>Impuesto ({totals.taxPct}%)</span><span className="cf-totals-val">{money(totals.tax, symbol)}</span></div>
                        <div className="cf-totals-total"><span>Total</span><span>{money(totals.total, symbol)}</span></div>
                    </div>

                    {error && <div className="cf-flash is-error" role="alert">{error}</div>}
                    {!config?.invoicePageUrl && (
                        <div className="cf-note">
                            Para enviar por correo o copiar el enlace público, configura primero la URL de la página de facturas en la pestaña Configuración.
                        </div>
                    )}

                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", justifyContent: "flex-end" }}>
                        <button type="button" onClick={onClose} className="cf-btn-ghost">Cancelar</button>
                        <button type="button" onClick={() => doSave(false)} disabled={busy} className="cf-btn-ghost">
                            {busy ? "Guardando…" : isEdit ? "Guardar cambios" : "Guardar borrador"}
                        </button>
                        <button type="button" onClick={() => doSave(true)} disabled={busy || !canSendMail} className="cf-btn"
                            title={canSendMail ? "Guardar y enviar el enlace por correo" : "Necesita correo del cliente y la URL de la página de facturas"}>
                            {busy ? "Enviando…" : "Guardar y enviar por correo"}
                        </button>
                    </div>
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
        <div className="cf-shell">
            {/* header: stamp + title + airmail rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconInvoice /></div>
                <div>
                    <h1 className="cf-title">Facturas</h1>
                    <p className="cf-subtitle">Facturas con enlace público imprimible y envío por correo</p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* tabs */}
            <div className="cf-tabs" role="tablist">
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "list"}
                    onClick={() => setTab("list")}
                    className={`cf-tab ${tab === "list" ? "is-active" : ""}`}
                >
                    Facturas
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "config"}
                    onClick={() => setTab("config")}
                    className={`cf-tab ${tab === "config" ? "is-active" : ""}`}
                >
                    Configuración
                </button>
            </div>

            {message && (
                <div role="status" className="cf-flash is-info">
                    <span>{message}</span>
                    <button type="button" onClick={() => setMessage("")} aria-label="Cerrar mensaje" className="cf-iconbtn" style={{ flex: "0 0 auto" }}><IconX /></button>
                </div>
            )}

            {tab === "list" && (
                <>
                    {/* Dashboard cards */}
                    <div className="cf-stat-grid">
                        <div className="cf-stat">
                            <p className="cf-label" style={{ marginBottom: 0 }}>Facturado (pagadas)</p>
                            <p className="cf-stat-value is-ok">{money(summary?.paid_cents, symbol)}</p>
                            <p className="cf-stat-sub">{summary?.count_paid ?? 0} facturas pagadas</p>
                        </div>
                        <div className="cf-stat">
                            <p className="cf-label" style={{ marginBottom: 0 }}>Pendiente (enviadas + vencidas)</p>
                            <p className="cf-stat-value is-accent">{money(summary?.pending_cents, symbol)}</p>
                            <p className="cf-stat-sub">{(summary?.count_sent ?? 0) + (summary?.count_overdue ?? 0)} facturas por cobrar</p>
                        </div>
                        <div className="cf-stat">
                            <p className="cf-label" style={{ marginBottom: 0 }}>Vencido</p>
                            <p className="cf-stat-value is-danger">{money(summary?.overdue_cents, symbol)}</p>
                            <p className="cf-stat-sub">{summary?.count_overdue ?? 0} facturas vencidas</p>
                        </div>
                    </div>

                    {/* Toolbar */}
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.75rem", marginBottom: "1.15rem" }}>
                        <input
                            type="text" value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") load(); }}
                            placeholder="Buscar por número, cliente o correo…"
                            aria-label="Buscar facturas"
                            className="cf-input"
                            style={{ maxWidth: "18rem" }}
                        />
                        <button type="button" onClick={() => load()} className="cf-btn-ghost">Buscar</button>
                        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filtrar por estado" className="cf-select" style={{ width: "11rem" }}>
                            <option value="">Todos los estados</option>
                            <option value="draft">Borrador</option>
                            <option value="sent">Enviada</option>
                            <option value="paid">Pagada</option>
                            <option value="overdue">Vencida</option>
                            <option value="void">Anulada</option>
                        </select>
                        <div style={{ flex: 1 }} />
                        <button type="button" onClick={exportCsv} className="cf-btn-ghost"><IconDownload /> Exportar CSV</button>
                        <button type="button" onClick={() => setModal({ initial: null })} className="cf-btn"><IconPlus /> Nueva factura</button>
                    </div>

                    {/* List */}
                    {invoices.length === 0 ? (
                        <div className="cf-empty">
                            <IconInvoice />
                            <span>No hay facturas todavía — crea la primera con "Nueva factura".</span>
                        </div>
                    ) : (
                        <div className="cf-card-item">
                            <div className="cf-table-wrap">
                                <table className="cf-table" style={{ minWidth: "720px" }}>
                                    <thead>
                                        <tr>
                                            <th>Número</th>
                                            <th>Cliente</th>
                                            <th>Emitida</th>
                                            <th>Vence</th>
                                            <th style={{ textAlign: "right" }}>Total</th>
                                            <th>Estado</th>
                                            <th style={{ textAlign: "right" }}>Acciones</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {invoices.map((inv) => {
                                            const meta = STATUS_META[inv.effective_status] || STATUS_META.draft;
                                            return (
                                                <tr key={inv.id}>
                                                    <td className="cf-cell-num">{inv.number}</td>
                                                    <td>
                                                        <div className="cf-client-name">{inv.client_name}</div>
                                                        {inv.client_email && <div className="cf-client-email">{inv.client_email}</div>}
                                                    </td>
                                                    <td className="cf-cell-date">{(inv.issued_at || "").slice(0, 10) || "—"}</td>
                                                    <td className="cf-cell-date">{(inv.due_at || "").slice(0, 10) || "—"}</td>
                                                    <td className="cf-cell-money">{money(inv.total_cents, inv.currency_symbol)}</td>
                                                    <td>
                                                        <span className={`cf-pill ${meta.cls}`}>{meta.label}</span>
                                                    </td>
                                                    <td>
                                                        <div className="cf-rowact">
                                                            <button type="button" onClick={() => setModal({ initial: inv })} disabled={busyId === inv.id} className="cf-btn-mini">Editar</button>
                                                            <button type="button" onClick={() => copyLink(inv)} disabled={busyId === inv.id} className="cf-btn-mini" title="Copiar enlace público">Enlace</button>
                                                            <button type="button" onClick={() => sendMail(inv)} disabled={busyId === inv.id || !inv.client_email} className="cf-btn-mini is-accent" title={inv.client_email ? "Enviar por correo" : "La factura no tiene correo del cliente"}>Correo</button>
                                                            <select
                                                                value={inv.status}
                                                                onChange={(e) => changeStatus(inv, e.target.value)}
                                                                disabled={busyId === inv.id}
                                                                className="cf-select-mini"
                                                                title="Cambiar estado"
                                                                aria-label="Cambiar estado"
                                                            >
                                                                <option value="draft">Borrador</option>
                                                                <option value="sent">Enviada</option>
                                                                <option value="paid">Pagada</option>
                                                                <option value="overdue">Vencida</option>
                                                                <option value="void">Anulada</option>
                                                            </select>
                                                            <button type="button" onClick={() => remove(inv)} disabled={busyId === inv.id} className="cf-btn-mini is-danger">Eliminar</button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </>
            )}

            {tab === "config" && (
                <form onSubmit={saveConfig} className="cf-editor" style={{ maxWidth: "42rem" }}>
                    <div className="cf-editor-body">
                        <h2 className="cf-editor-title"><IconPen /> Identidad del negocio</h2>
                        <div className="cf-grid">
                            <div>
                                <label className="cf-label" htmlFor="inv-cfg-name">Nombre del negocio</label>
                                <input id="inv-cfg-name" type="text" value={config?.businessName || ""} onChange={(e) => setCfg("businessName", e.target.value)} className="cf-input" />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="inv-cfg-taxid">NIF / RFC / Tax ID</label>
                                <input id="inv-cfg-taxid" type="text" value={config?.businessTaxId || ""} onChange={(e) => setCfg("businessTaxId", e.target.value)} className="cf-input" />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="inv-cfg-address">Dirección</label>
                                <input id="inv-cfg-address" type="text" value={config?.businessAddress || ""} onChange={(e) => setCfg("businessAddress", e.target.value)} className="cf-input" />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="inv-cfg-email">Correo del negocio</label>
                                <input id="inv-cfg-email" type="email" value={config?.businessEmail || ""} onChange={(e) => setCfg("businessEmail", e.target.value)} className="cf-input" />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="inv-cfg-symbol">Símbolo de moneda</label>
                                <input id="inv-cfg-symbol" type="text" value={config?.currencySymbol || ""} onChange={(e) => setCfg("currencySymbol", e.target.value)} className="cf-input" placeholder="$" />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="inv-cfg-url">URL de la página pública de facturas</label>
                                <input id="inv-cfg-url" type="text" value={config?.invoicePageUrl || ""} onChange={(e) => setCfg("invoicePageUrl", e.target.value)} className="cf-input" placeholder="/factura o https://misitio.com/factura" />
                                <p className="cf-help">
                                    La página pública que contiene el bloque <strong>Invoices</strong> del editor visual. Los enlaces
                                    enviados a los clientes tienen la forma <code>{"<URL>?inv=<token>"}</code>.
                                </p>
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="inv-cfg-footer">Nota al pie de la factura</label>
                                <input id="inv-cfg-footer" type="text" value={config?.footerNote || ""} onChange={(e) => setCfg("footerNote", e.target.value)} className="cf-input" placeholder="Gracias por su confianza." />
                            </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.5rem" }}>
                            {cfgMsg && <span className={`cf-inline-msg ${/Error/i.test(cfgMsg) ? "is-error" : "is-ok"}`}>{cfgMsg}</span>}
                            <button type="submit" disabled={cfgBusy || !config} className="cf-btn">{cfgBusy ? "Guardando…" : "Guardar configuración"}</button>
                        </div>
                    </div>
                </form>
            )}

            {modal && <InvoiceModal initial={modal.initial} config={config} onClose={() => setModal(null)} onDone={onModalDone} />}
        </div>
    );
}
