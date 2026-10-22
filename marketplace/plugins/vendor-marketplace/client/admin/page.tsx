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
import { useT } from "./i18n";

const BASE = "/plugin/vendor-marketplace";

// Label maps hold i18n keys; they resolve through t() at render time (see i18n.ts).
const STATUS_LABEL = { pending: "status.pending", approved: "status.approved", suspended: "status.suspended" };
const STATUS_BADGE = { pending: "is-warn", approved: "is-ok", suspended: "is-danger" };
const INQ_LABEL = { new: "inq.new", replied: "inq.replied", closed: "inq.closed" };

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
    const { t } = useT();
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
                        <button type="button" onClick={onClose} aria-label={t("common.close")} className="cf-iconbtn">✕</button>
                    </div>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            onSave({ ...form, commission_pct: Number(form.commission_pct) });
                        }}
                    >
                        <div className="cf-grid">
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="vm-name">{t("form.name")}</label>
                                <input id="vm-name" type="text" className="cf-input" value={form.name} onChange={set("name")} required maxLength={120} />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="vm-email">{t("form.email")}</label>
                                <input id="vm-email" type="email" className="cf-input" value={form.email} onChange={set("email")} required maxLength={200} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="vm-phone">{t("form.phone")}</label>
                                <input id="vm-phone" type="text" className="cf-input" value={form.phone} onChange={set("phone")} maxLength={40} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="vm-commission">{t("form.commission")}</label>
                                <input id="vm-commission" type="number" min="0" max="100" step="1" className="cf-input" value={form.commission_pct} onChange={set("commission_pct")} />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="vm-logo">{t("form.logo")}</label>
                                <input id="vm-logo" type="text" className="cf-input" value={form.logo_url} onChange={set("logo_url")} placeholder={t("form.logoPlaceholder")} maxLength={500} />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="vm-desc">{t("form.description")}</label>
                                <textarea id="vm-desc" className="cf-input" style={{ minHeight: "90px" }} value={form.description} onChange={set("description")} maxLength={2000} />
                            </div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.5rem" }}>
                            <button type="button" className="cf-btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
                            <button type="submit" className="cf-btn" disabled={busy}>{busy ? t("common.saving") : t("common.save")}</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}

export default function MarketplaceAdminPage() {
    const { t } = useT();
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

    const isError = /Error|Erro|falló|no enviado|not sent|não enviado/i.test(message);

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
            setMessage(t("msg.loadError", { msg: err?.message || err }));
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
            setMessage(t("common.error", { msg: err?.message || err }));
        } finally {
            setBusy(false);
        }
    };

    // ---- vendor actions ----
    const approve = (v) => run(
        () => apiPost(`${BASE}/vendors/${v.id}/approve`, {}),
        (out) => t(out.mailed ? "msg.approvedMailed" : "msg.approvedNotMailed", { name: v.name, code: out.access_code })
    );
    const suspend = (v) => {
        if (!window.confirm(t("confirm.suspend", { name: v.name }))) return;
        run(() => apiPost(`${BASE}/vendors/${v.id}/suspend`, {}), t("msg.suspended", { name: v.name }));
    };
    const rotateCode = (v) => {
        if (!window.confirm(t("confirm.rotate", { name: v.name }))) return;
        run(() => apiPost(`${BASE}/vendors/${v.id}/rotate-code`, {}), (out) => t("msg.newCode", { name: v.name, code: out.access_code }));
    };
    const removeVendor = (v) => {
        if (!window.confirm(t("confirm.deleteVendor", { name: v.name }))) return;
        run(() => apiDelete(`${BASE}/vendors/${v.id}`), t("msg.vendorDeleted", { name: v.name }));
    };
    const saveVendorEdit = (form) => run(async () => {
        await apiPut(`${BASE}/vendors/${editVendor.id}`, form);
        setEditVendor(null);
    }, t("msg.vendorUpdated"));
    const createVendor = (form) => run(async () => {
        const out = await apiPost(`${BASE}/vendors`, form);
        setCreating(false);
        return out;
    }, (out) => t("msg.vendorCreated", { code: out.access_code }));
    const copyCode = async (code) => {
        try {
            await navigator.clipboard.writeText(String(code));
            setMessage(t("msg.codeCopied"));
        } catch {
            setMessage(t("msg.copyFailed"));
        }
    };

    // ---- product / inquiry actions ----
    const togglePublish = (p) => run(
        () => apiPost(`${BASE}/products/${p.id}/publish`, { is_published: p.is_published ? 0 : 1 }),
        p.is_published ? t("msg.productHidden", { name: p.name }) : t("msg.productPublished", { name: p.name })
    );
    const removeProduct = (p) => {
        if (!window.confirm(t("confirm.deleteProduct", { name: p.name }))) return;
        run(() => apiDelete(`${BASE}/products/${p.id}`), t("msg.productDeleted", { name: p.name }));
    };
    const setInquiryStatus = (i, status) => run(
        () => apiPost(`${BASE}/inquiries/${i.id}/status`, { status }),
        t("msg.inquiryUpdated")
    );

    // ---- report / settings actions ----
    const saveCommission = (vendorId) => {
        const pct = Number(commissionDrafts[vendorId]);
        if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
            setMessage(t("msg.commissionInvalid"));
            return;
        }
        run(() => apiPut(`${BASE}/vendors/${vendorId}`, { commission_pct: pct }), t("msg.commissionUpdated"));
    };
    const saveSymbol = () => run(
        () => apiPost(`${BASE}/settings`, { currencySymbol: symbolDraft.trim() }),
        t("msg.symbolSaved")
    );

    const pendingCount = useMemo(() => vendors.filter((v) => v.status === "pending").length, [vendors]);
    const visibleVendors = useMemo(
        () => (statusFilter ? vendors.filter((v) => v.status === statusFilter) : vendors),
        [vendors, statusFilter]
    );

    const tabs = [
        { id: "vendors", label: t("tab.vendors"), badge: pendingCount },
        { id: "products", label: t("tab.products") },
        { id: "inquiries", label: t("tab.inquiries") },
        { id: "report", label: t("tab.report") },
    ];

    return (
        <div className="cf-shell">
            {/* header: stamp + title + rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconStore /></div>
                <div>
                    <h1 className="cf-title">{t("app.title")}</h1>
                    <p className="cf-subtitle">
                        {t("app.subtitle")}
                    </p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* v1 scope banner — this marketplace generates LEADS, it does not process payments. */}
            <div className="cf-note">
                <strong>{t("app.noteStrong")}</strong>{t("app.note")}
            </div>

            {/* tabs */}
            <div className="cf-tabs" role="tablist">
                {tabs.map((tb) => (
                    <button
                        key={tb.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === tb.id}
                        onClick={() => { setTab(tb.id); setMessage(""); }}
                        className={`cf-tab ${tab === tb.id ? "is-active" : ""}`}
                    >
                        {tb.label}
                        {tb.badge ? <span className="cf-badge">{tb.badge}</span> : null}
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
                            <h2 className="cf-card-title">{t("vendors.title")}</h2>
                            <select
                                value={statusFilter}
                                onChange={(e) => setStatusFilter(e.target.value)}
                                className="cf-select"
                                aria-label={t("vendors.filter")}
                            >
                                <option value="">{t("vendors.allStatuses")}</option>
                                <option value="pending">{t("vendors.fPending")}</option>
                                <option value="approved">{t("vendors.fApproved")}</option>
                                <option value="suspended">{t("vendors.fSuspended")}</option>
                            </select>
                        </div>
                        <button type="button" className="cf-btn" onClick={() => setCreating(true)}><IconPlus /> {t("vendors.create")}</button>
                    </div>

                    <div className="cf-table-wrap">
                        <table className="cf-table">
                            <thead>
                                <tr>
                                    <th>{t("vendors.colStore")}</th>
                                    <th>{t("vendors.colContact")}</th>
                                    <th>{t("vendors.colStatus")}</th>
                                    <th>{t("vendors.colCode")}</th>
                                    <th>{t("vendors.colCounts")}</th>
                                    <th>{t("vendors.colActions")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {visibleVendors.length === 0 ? (
                                    <tr><td colSpan={6} className="cf-cell-empty">{statusFilter ? t("vendors.emptyFiltered") : t("vendors.empty")}</td></tr>
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
                                                {STATUS_LABEL[v.status] ? t(STATUS_LABEL[v.status]) : v.status}
                                            </span>
                                        </td>
                                        <td>
                                            {v.access_code ? (
                                                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                                                    <code className="cf-code">{v.access_code}</code>
                                                    <button type="button" title={t("vendors.copyCode")} className="cf-btn-ghost" onClick={() => copyCode(v.access_code)}><IconCopy /> {t("vendors.copy")}</button>
                                                </span>
                                            ) : <span className="cf-void">{t("vendors.onApprove")}</span>}
                                        </td>
                                        <td>
                                            <span className="cf-strong" style={{ whiteSpace: "nowrap" }}>{v.product_count} / {v.inquiry_count}</span>
                                        </td>
                                        <td>
                                            <div className="cf-row-actions">
                                                {v.status !== "approved" && (
                                                    <button type="button" disabled={busy} className="cf-btn" onClick={() => approve(v)}>{t("vendors.approve")}</button>
                                                )}
                                                {v.status === "approved" && (
                                                    <button type="button" disabled={busy} className="cf-btn-ghost" onClick={() => suspend(v)}>{t("vendors.suspend")}</button>
                                                )}
                                                {v.access_code && (
                                                    <button type="button" disabled={busy} className="cf-btn-ghost" onClick={() => rotateCode(v)}>{t("vendors.rotate")}</button>
                                                )}
                                                <button type="button" disabled={busy} className="cf-btn-ghost" onClick={() => setEditVendor(v)}><IconPen /> {t("common.edit")}</button>
                                                <button type="button" disabled={busy} className="cf-btn-danger" onClick={() => removeVendor(v)}>{t("common.delete")}</button>
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
                    <h2 className="cf-card-title" style={{ marginBottom: "1.15rem" }}>{t("products.title")}</h2>
                    <div className="cf-table-wrap">
                        <table className="cf-table">
                            <thead>
                                <tr>
                                    <th>{t("products.colProduct")}</th>
                                    <th>{t("products.colStore")}</th>
                                    <th>{t("products.colPrice")}</th>
                                    <th>{t("products.colCategory")}</th>
                                    <th>{t("products.colVisibility")}</th>
                                    <th>{t("products.colActions")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {products.length === 0 ? (
                                    <tr><td colSpan={6} className="cf-cell-empty">{t("products.empty")}</td></tr>
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
                                            {p.vendor_status !== "approved" ? <span className="cf-danger-note">({STATUS_LABEL[p.vendor_status] ? t(STATUS_LABEL[p.vendor_status]) : p.vendor_status})</span> : null}
                                        </td>
                                        <td><span className="cf-strong">{fmtMoney(p.price_cents, symbol)}</span></td>
                                        <td>{p.category || "—"}</td>
                                        <td>
                                            <span className={`cf-pill ${p.is_published ? "is-ok" : "is-muted"}`}>
                                                {p.is_published ? t("products.published") : p.admin_hidden ? t("products.hiddenModeration") : t("products.hidden")}
                                            </span>
                                        </td>
                                        <td>
                                            <div className="cf-row-actions">
                                                <button type="button" disabled={busy} className="cf-btn-ghost" onClick={() => togglePublish(p)}>
                                                    {p.is_published ? t("products.hide") : t("products.publish")}
                                                </button>
                                                <button type="button" disabled={busy} className="cf-btn-danger" onClick={() => removeProduct(p)}>{t("common.delete")}</button>
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
                    <h2 className="cf-card-title" style={{ marginBottom: "1.15rem" }}>{t("inquiries.title")}</h2>
                    <div className="cf-table-wrap">
                        <table className="cf-table">
                            <thead>
                                <tr>
                                    <th>{t("inquiries.colBuyer")}</th>
                                    <th>{t("inquiries.colProduct")}</th>
                                    <th>{t("inquiries.colMessage")}</th>
                                    <th>{t("inquiries.colDate")}</th>
                                    <th>{t("inquiries.colStatus")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {inquiries.length === 0 ? (
                                    <tr><td colSpan={5} className="cf-cell-empty">{t("inquiries.empty")}</td></tr>
                                ) : inquiries.map((i) => (
                                    <tr key={i.id}>
                                        <td>
                                            <div className="cf-strong">{i.buyer_name}</div>
                                            <a href={`mailto:${i.buyer_email}`} className="cf-link">{i.buyer_email}</a>
                                        </td>
                                        <td>
                                            <div>{i.product_name || <span className="cf-void">{t("inquiries.productDeleted")}</span>}</div>
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
                                                aria-label={t("inquiries.statusLabel")}
                                                style={{ width: "auto" }}
                                            >
                                                {Object.keys(INQ_LABEL).map((s) => <option key={s} value={s}>{t(INQ_LABEL[s])}</option>)}
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
                                <h2 className="cf-card-title">{t("report.settings")}</h2>
                                <p className="cf-help">{t("report.symbolHelp")}</p>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                <input type="text" value={symbolDraft} onChange={(e) => setSymbolDraft(e.target.value)} maxLength={8} className="cf-input" style={{ width: "6rem" }} aria-label={t("report.symbolLabel")} />
                                <button type="button" className="cf-btn" disabled={busy || !symbolDraft.trim()} onClick={saveSymbol}>{t("common.save")}</button>
                            </div>
                        </div>
                    </div>

                    <div className="cf-card-item">
                        <h2 className="cf-card-title">{t("report.title")}</h2>
                        {report?.note ? <p className="cf-help" style={{ marginBottom: "1.15rem" }}>{t("report.note")}</p> : <div style={{ marginBottom: "1.15rem" }}></div>}
                        <div className="cf-table-wrap">
                            <table className="cf-table">
                                <thead>
                                    <tr>
                                        <th>{t("report.colStore")}</th>
                                        <th>{t("report.colProducts")}</th>
                                        <th>{t("report.colInquiries")}</th>
                                        <th>{t("report.colCatalog")}</th>
                                        <th>{t("report.colCommission")}</th>
                                        <th>{t("report.colEstimated")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {!report || report.vendors.length === 0 ? (
                                        <tr><td colSpan={6} className="cf-cell-empty">{t("report.empty")}</td></tr>
                                    ) : report.vendors.map((v) => {
                                        const pct = Number(commissionDrafts[v.id]);
                                        const estCents = Number.isFinite(pct) ? Math.round((Number(v.catalog_cents) || 0) * pct / 100) : 0;
                                        return (
                                            <tr key={v.id}>
                                                <td>
                                                    <div className="cf-strong">{v.name}</div>
                                                    <span className={`cf-pill ${STATUS_BADGE[v.status] || "is-muted"}`}>{STATUS_LABEL[v.status] ? t(STATUS_LABEL[v.status]) : v.status}</span>
                                                </td>
                                                <td><span className="cf-strong">{v.products}</span> <span className="cf-sub">{t("report.publishedCount", { n: v.published_products })}</span></td>
                                                <td><span className="cf-strong">{v.inquiries}</span> <span className="cf-sub">{t("report.newCount", { n: v.new_inquiries })}</span></td>
                                                <td>{fmtMoney(v.catalog_cents, report.currencySymbol || symbol)}</td>
                                                <td>
                                                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                                                        <input
                                                            type="number" min="0" max="100" step="1"
                                                            value={commissionDrafts[v.id] ?? ""}
                                                            onChange={(e) => setCommissionDrafts({ ...commissionDrafts, [v.id]: e.target.value })}
                                                            className="cf-input"
                                                            style={{ width: "5rem" }}
                                                            aria-label={t("report.commissionOf", { name: v.name })}
                                                        />
                                                        <button type="button" disabled={busy} className="cf-btn-ghost" onClick={() => saveCommission(v.id)}>{t("common.ok")}</button>
                                                    </div>
                                                </td>
                                                <td>
                                                    <span className="cf-sub" title={t("report.estimateHelp")}>
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
                            {t("report.usage1")}<strong>Marketplace</strong>{t("report.usage2")}
                        </p>
                    </div>
                </div>
            )}

            {editVendor && (
                <VendorFormModal
                    key={`edit-${editVendor.id}`}
                    initial={editVendor}
                    title={t("form.editTitle", { name: editVendor.name })}
                    busy={busy}
                    onSave={saveVendorEdit}
                    onClose={() => setEditVendor(null)}
                />
            )}
            {creating && (
                <VendorFormModal
                    key="create"
                    initial={{}}
                    title={t("form.createTitle")}
                    busy={busy}
                    onSave={createVendor}
                    onClose={() => setCreating(false)}
                />
            )}
        </div>
    );
}
