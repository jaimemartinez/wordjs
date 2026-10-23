// @ts-nocheck
"use client";

/**
 * Admin page for the Digital Downloads plugin (/admin/plugin/downloads).
 * Tabs: Productos (CRUD + sales/download counters), Pedidos (pending badge, mark-paid → auto-email,
 * CSV export), Configuración (currency symbol, manual-payment instructions, notify email,
 * link expiry days, max uses). All calls go through the host api helpers (session cookie).
 *
 * Product files are PRIVATE media items: picked from (or uploaded straight into) the private part of
 * the core media library via /api/v1/media?visibility=private. Products created before 1.1.0 kept a
 * PUBLIC file URL; they are flagged with a warning until their file is re-selected as private.
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected by the
 * host admin shell and scoped to .plugin-admin-downloads) — the markup below only uses cf-*
 * classes plus sparse inline styles for one-off layout.
 */

import React, { useEffect, useMemo, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";
import { useT } from "./i18n";
import { useModal } from "@/contexts/ModalContext";

const BASE = "/plugin/digital-downloads";

const EMPTY_FORM = { name: "", slug: "", description: "", price: "0", media_id: "", legacy_file_url: "", file_label: "", image_url: "", is_published: true };

const fmtSize = (bytes) => {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
};

const fmtMoney = (cents, symbol) => `${symbol || "$"}${((Number(cents) || 0) / 100).toFixed(2)}`;

// "9,99" / "9.99" → integer cents; null when unparseable/negative.
const priceToCents = (str) => {
    const n = Number(String(str ?? "").trim().replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
};

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconDownload = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m7 10 5 5 5-5" />
        <path d="M12 15V3" />
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
const IconBox = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
        <path d="m3.3 7 8.7 5 8.7-5" />
        <path d="M12 22V12" />
    </svg>
);
const IconReceipt = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
        <path d="M16 8H8" />
        <path d="M16 12H8" />
    </svg>
);

export default function DigitalDownloadsAdminPage() {
    const { confirm } = useModal();
    const { t, locale } = useT();
    const [tab, setTab] = useState("products");
    const [products, setProducts] = useState([]);
    const [orders, setOrders] = useState([]);
    const [config, setConfig] = useState(null);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);

    // product form state
    const [form, setForm] = useState(EMPTY_FORM);
    const [editingId, setEditingId] = useState(null);
    const [showForm, setShowForm] = useState(false);

    // orders filter
    const [orderFilter, setOrderFilter] = useState("all");

    // PRIVATE media items the product file can be chosen from (core media library, visibility=private).
    const [privateFiles, setPrivateFiles] = useState([]);
    const [uploading, setUploading] = useState(false);
    const loadPrivateFiles = async () => {
        try { setPrivateFiles(await api(`/media?visibility=private&per_page=100&orderby=date&order=desc`)); }
        catch { setPrivateFiles([]); }
    };
    const uploadPrivateFile = async (file) => {
        if (!file) return;
        setUploading(true); setMessage("");
        try {
            const fd = new FormData();
            fd.append("file", file);
            // visibility=private in the QUERY STRING: the host writes the file straight into the private
            // store (never under the public /uploads folder).
            const item = await api(`/media?visibility=private`, { method: "POST", body: fd });
            await loadPrivateFiles();
            setForm((f) => ({ ...f, media_id: String(item.id) }));
            flash(t("msg.uploaded"));
        } catch (err) { flash(t("msg.uploadFailed", { msg: err?.message || err })); }
        finally { setUploading(false); }
    };

    const symbol = config?.currencySymbol || "$";
    const pendingCount = useMemo(() => orders.filter((o) => o.payment_status === "pending").length, [orders]);
    const isError = /erro|inválid|no encontrado|no se pudo|falló|could not|não foi possível|não pôde/i.test(message);

    const loadAll = async () => {
        try { setProducts(await api(`${BASE}/products`)); } catch { setProducts([]); }
        try { setOrders(await api(`${BASE}/orders`)); } catch { setOrders([]); }
        try { setConfig(await api(`${BASE}/config`)); } catch { setConfig(null); }
    };
    useEffect(() => { loadAll(); loadPrivateFiles(); }, []);

    const flash = (msg) => { setMessage(msg); };

    // ---- products ----
    const openCreate = () => { setForm(EMPTY_FORM); setEditingId(null); setShowForm(true); setMessage(""); };
    const openEdit = (p) => {
        setForm({
            name: p.name || "", slug: p.slug || "", description: p.description || "",
            price: ((Number(p.price_cents) || 0) / 100).toFixed(2),
            media_id: p.media_id ? String(p.media_id) : "", legacy_file_url: p.media_id ? "" : (p.file_url || ""),
            file_label: p.file_label || "", image_url: p.image_url || "",
            is_published: !!p.is_published,
        });
        setEditingId(p.id); setShowForm(true); setMessage("");
    };

    const saveProduct = async (e) => {
        e.preventDefault();
        const cents = priceToCents(form.price);
        if (cents === null) return flash(t("msg.badPrice"));
        // A legacy product may be saved without re-selecting (its public URL keeps working, with a
        // warning); a NEW product must have a private file.
        if (!form.media_id && !(editingId && form.legacy_file_url)) return flash(t("msg.needFile"));
        setBusy(true); setMessage("");
        try {
            const body = {
                name: form.name.trim(), slug: form.slug.trim(), description: form.description,
                price_cents: cents, file_label: form.file_label.trim(),
                image_url: form.image_url.trim(), is_published: form.is_published,
            };
            if (form.media_id) body.media_id = Number(form.media_id);
            if (editingId) await apiPut(`${BASE}/products/${editingId}`, body);
            else await apiPost(`${BASE}/products`, body);
            setShowForm(false); setForm(EMPTY_FORM); setEditingId(null);
            flash(editingId ? t("msg.productUpdated") : t("msg.productCreated"));
            loadAll();
        } catch (err) { flash(t("common.error", { msg: err?.message || err })); }
        finally { setBusy(false); }
    };

    const deleteProduct = async (p) => {
        if (!(await confirm(t("confirm.deleteProduct", { name: p.name }), undefined, true))) return;
        setBusy(true);
        try { await apiDelete(`${BASE}/products/${p.id}`); flash(t("msg.productDeleted")); loadAll(); }
        catch (err) { flash(t("common.error", { msg: err?.message || err })); }
        finally { setBusy(false); }
    };

    const togglePublished = async (p) => {
        setBusy(true);
        try { await apiPut(`${BASE}/products/${p.id}`, { is_published: !p.is_published }); loadAll(); }
        catch (err) { flash(t("common.error", { msg: err?.message || err })); }
        finally { setBusy(false); }
    };

    // ---- orders ----
    const markPaid = async (o) => {
        setBusy(true); setMessage("");
        try {
            const r = await apiPost(`${BASE}/orders/${o.id}/paid`, {});
            if (r.already) flash(t("msg.alreadyPaid"));
            else flash(r.emailSent ? t("msg.paidSent") : t("msg.paidNoMail"));
            loadAll();
        } catch (err) { flash(t("common.error", { msg: err?.message || err })); }
        finally { setBusy(false); }
    };

    const deleteOrder = async (o) => {
        if (!(await confirm(t("confirm.deleteOrder", { id: o.id, email: o.customer_email }), undefined, true))) return;
        setBusy(true);
        try { await apiDelete(`${BASE}/orders/${o.id}`); flash(t("msg.orderDeleted")); loadAll(); }
        catch (err) { flash(t("common.error", { msg: err?.message || err })); }
        finally { setBusy(false); }
    };

    const exportCsv = async () => {
        setBusy(true); setMessage("");
        try {
            // The sandbox can't stream files — the CSV arrives as JSON and we build the Blob here.
            const data = await api(`${BASE}/orders/export`);
            const blob = new Blob([data.csv], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = data.filename || t("csv.filename");
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
            flash(t("msg.exported", { count: data.count }));
        } catch (err) { flash(t("common.error", { msg: err?.message || err })); }
        finally { setBusy(false); }
    };

    const copyLink = async (o) => {
        try {
            const path = o.page_path && o.page_path.startsWith("/") ? o.page_path : "/";
            const sep = path.includes("?") ? "&" : "?";
            const link = `${window.location.origin}${path}${sep}dl=${o.token}`;
            await navigator.clipboard.writeText(link);
            flash(t("msg.linkCopied"));
        } catch { flash(t("msg.copyFailed")); }
    };

    // ---- config ----
    const saveConfig = async (e) => {
        e.preventDefault();
        setBusy(true); setMessage("");
        try {
            const saved = await apiPost(`${BASE}/config`, config);
            setConfig(saved);
            flash(t("msg.configSaved"));
        } catch (err) { flash(t("common.error", { msg: err?.message || err })); }
        finally { setBusy(false); }
    };

    const filteredOrders = orderFilter === "all" ? orders : orders.filter((o) => o.payment_status === orderFilter);

    const tabBtn = (id, label, badge) => (
        <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => { setTab(id); setMessage(""); }}
            className={`cf-tab ${tab === id ? "is-active" : ""}`}
        >
            {label}
            {badge > 0 && <span className="cf-badge">{badge}</span>}
        </button>
    );

    return (
        <div className="cf-shell">
            {/* header: stamp + title + rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconDownload /></div>
                <div>
                    <h1 className="cf-title">{t("app.title")}</h1>
                    <p className="cf-subtitle">
                        {t("app.subtitle")}
                    </p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* tabs */}
            <div className="cf-tabs" role="tablist">
                {tabBtn("products", t("tab.products"), 0)}
                {tabBtn("orders", t("tab.orders"), pendingCount)}
                {tabBtn("config", t("tab.config"), 0)}
            </div>

            {message && (
                <div role={isError ? "alert" : "status"} className={`cf-flash ${isError ? "is-error" : "is-ok"}`}>{message}</div>
            )}

            {/* ============ PRODUCTOS ============ */}
            {tab === "products" && (
                <div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
                        <button type="button" onClick={openCreate} className="cf-btn"><IconPlus /> {t("prod.new")}</button>
                    </div>

                    {showForm && (
                        <form onSubmit={saveProduct} className="cf-editor">
                            <div className="cf-editor-body">
                                <h2 className="cf-editor-title">
                                    <IconPen />
                                    {editingId ? t("prod.edit") : t("prod.new")}
                                </h2>
                                <div className="cf-grid">
                                    <div>
                                        <label className="cf-label" htmlFor="dd-name">{t("prod.name")}</label>
                                        <input id="dd-name" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="cf-input" required />
                                    </div>
                                    <div>
                                        <label className="cf-label" htmlFor="dd-slug">{t("prod.slug")}</label>
                                        <input id="dd-slug" type="text" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder={t("prod.slugPh")} className="cf-input" />
                                    </div>
                                    <div className="cf-span-2">
                                        <label className="cf-label" htmlFor="dd-desc">{t("prod.desc")}</label>
                                        <textarea id="dd-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className="cf-input" />
                                    </div>
                                    <div>
                                        <label className="cf-label" htmlFor="dd-price">{t("prod.price", { symbol })}</label>
                                        <input id="dd-price" type="text" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="9.99" className="cf-input" />
                                    </div>
                                    <div>
                                        <label className="cf-label" htmlFor="dd-flabel">{t("prod.fileLabel")}</label>
                                        <input id="dd-flabel" type="text" value={form.file_label} onChange={(e) => setForm({ ...form, file_label: e.target.value })} placeholder="PDF — 12 MB" className="cf-input" />
                                    </div>
                                    <div className="cf-span-2">
                                        <label className="cf-label" htmlFor="dd-file">{t("prod.file")}</label>
                                        {form.legacy_file_url && !form.media_id && (
                                            <div role="alert" className="cf-flash is-error" style={{ marginBottom: "0.6rem" }}>
                                                {t("prod.legacyWarn1", { url: form.legacy_file_url })}
                                                {" "}{t("prod.legacyWarn2")}
                                            </div>
                                        )}
                                        <select id="dd-file" value={form.media_id} onChange={(e) => setForm({ ...form, media_id: e.target.value })} className="cf-input">
                                            <option value="">{t("prod.pickFile")}</option>
                                            {privateFiles.map((m) => (
                                                <option key={m.id} value={String(m.id)}>
                                                    {m.title || `#${m.id}`} ({m.mimeType}{m.mediaDetails?.filesize ? `, ${fmtSize(m.mediaDetails.filesize)}` : ""})
                                                </option>
                                            ))}
                                        </select>
                                        <div style={{ marginTop: "0.5rem" }}>
                                            <label className="cf-btn-ghost" style={{ cursor: uploading ? "default" : "pointer" }}>
                                                {uploading ? t("prod.uploading") : t("prod.upload")}
                                                <input type="file" style={{ display: "none" }} disabled={uploading}
                                                    onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; uploadPrivateFile(f); }} />
                                            </label>
                                        </div>
                                        <p className="cf-help">
                                            {t("prod.fileHelp1")}<strong>{t("prod.fileHelpPrivate")}</strong>{t("prod.fileHelp2")}<code>media:private_read</code>{t("prod.fileHelp3")}
                                        </p>
                                    </div>
                                    <div className="cf-span-2">
                                        <label className="cf-label" htmlFor="dd-img">{t("prod.image")}</label>
                                        <input id="dd-img" type="text" value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} placeholder={t("prod.imagePh")} className="cf-input" />
                                    </div>
                                </div>
                                <div style={{ marginTop: "0.9rem" }}>
                                    <label className="cf-check">
                                        <input type="checkbox" checked={form.is_published} onChange={(e) => setForm({ ...form, is_published: e.target.checked })} />
                                        {t("prod.published")}
                                    </label>
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", justifyContent: "flex-end", marginTop: "1.2rem" }}>
                                    <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }} className="cf-btn-ghost">{t("common.cancel")}</button>
                                    <button type="submit" disabled={busy} className="cf-btn">{busy ? t("common.saving") : t("prod.save")}</button>
                                </div>
                            </div>
                        </form>
                    )}

                    <div className="cf-card-item">
                        <h2 className="cf-card-heading">{t("prod.list", { count: products.length })}</h2>
                        {products.length === 0 ? (
                            <div className="cf-empty">
                                <IconBox />
                                <span>{t("prod.empty1")}<strong>DigitalDownloads</strong>{t("prod.empty2")}</span>
                            </div>
                        ) : (
                            <div className="cf-table-wrap">
                                <table className="cf-table is-static">
                                    <thead>
                                        <tr>
                                            <th>{t("prod.col.product")}</th>
                                            <th>{t("prod.col.price")}</th>
                                            <th>{t("prod.col.sales")}</th>
                                            <th>{t("prod.col.downloads")}</th>
                                            <th>{t("prod.col.status")}</th>
                                            <th></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {products.map((p) => (
                                            <tr key={p.id}>
                                                <td>
                                                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                                                        {p.image_url ? (
                                                            /* eslint-disable-next-line @next/next/no-img-element */
                                                            <img src={p.image_url} alt={p.name} className="cf-thumb" />
                                                        ) : (
                                                            <div className="cf-thumb-ph" aria-hidden="true"><IconDownload /></div>
                                                        )}
                                                        <div style={{ minWidth: 0 }}>
                                                            <div className="cf-prod-name">{p.name}</div>
                                                            <div className="cf-prod-sub">{p.file_label || p.slug}</div>
                                                            {p.file_status === "public_legacy" && (
                                                                <div className="cf-prod-sub" style={{ color: "#b91c1c", fontWeight: 700 }}>
                                                                    {t("prod.publicFile")}
                                                                </div>
                                                            )}
                                                            {p.file_status === "unavailable" && (
                                                                <div className="cf-prod-sub" style={{ color: "#b91c1c", fontWeight: 700 }}>
                                                                    {t("prod.unavailable")}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="cf-cell-money">{(Number(p.price_cents) || 0) === 0 ? <span className="cf-free">{t("common.free")}</span> : fmtMoney(p.price_cents, symbol)}</td>
                                                <td className="cf-cell-num">{p.sales_count}</td>
                                                <td className="cf-cell-num">{p.download_count}</td>
                                                <td>
                                                    <button type="button" onClick={() => togglePublished(p)} disabled={busy}
                                                        className={`cf-pill-btn ${p.is_published ? "is-on" : "is-off"}`}>
                                                        {p.is_published ? t("prod.isPublished") : t("prod.isHidden")}
                                                    </button>
                                                </td>
                                                <td>
                                                    <div className="cf-rowactions">
                                                        <button type="button" onClick={() => openEdit(p)} className="cf-btn-ghost"><IconPen /> {t("common.edit")}</button>
                                                        <button type="button" onClick={() => deleteProduct(p)} disabled={busy} className="cf-btn-danger">{t("common.delete")}</button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ============ PEDIDOS ============ */}
            {tab === "orders" && (
                <div className="cf-card-item">
                    <div className="cf-toolbar">
                        <h2 className="cf-card-heading" style={{ margin: 0 }}>{t("ord.list", { count: filteredOrders.length })}</h2>
                        <div className="cf-toolbar-left">
                            <select
                                value={orderFilter}
                                onChange={(e) => setOrderFilter(e.target.value)}
                                className="cf-select"
                                aria-label={t("ord.filterAria")}
                            >
                                <option value="all">{t("ord.all")}</option>
                                <option value="pending">{t("ord.pendingPl")}</option>
                                <option value="paid">{t("ord.paidPl")}</option>
                            </select>
                            <button type="button" onClick={exportCsv} disabled={busy} className="cf-btn-ghost"><IconDownload /> {t("ord.export")}</button>
                        </div>
                    </div>
                    {filteredOrders.length === 0 ? (
                        <div className="cf-empty">
                            <IconReceipt />
                            <span>{orderFilter === "pending" ? t("ord.emptyPending") : orderFilter === "paid" ? t("ord.emptyPaid") : t("ord.empty")}</span>
                        </div>
                    ) : (
                        <div className="cf-table-wrap">
                            <table className="cf-table is-static">
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>{t("ord.col.product")}</th>
                                        <th>{t("ord.col.customer")}</th>
                                        <th>{t("ord.col.amount")}</th>
                                        <th>{t("ord.col.status")}</th>
                                        <th>{t("ord.col.uses")}</th>
                                        <th>{t("ord.col.expires")}</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredOrders.map((o) => (
                                        <tr key={o.id}>
                                            <td className="cf-cell-num">{o.id}</td>
                                            <td><span className="cf-prod-name">{o.product_name || t("ord.deleted")}</span></td>
                                            <td>
                                                <div className="cf-prod-name">{o.customer_name || "—"}</div>
                                                <div className="cf-prod-sub">{o.customer_email}</div>
                                            </td>
                                            <td className="cf-cell-money">{(Number(o.amount_cents) || 0) === 0 ? <span className="cf-free">{t("common.free")}</span> : fmtMoney(o.amount_cents, symbol)}</td>
                                            <td>
                                                <span className={`cf-pill ${o.payment_status === "paid" ? "is-paid" : "is-pending"}`}>
                                                    {o.payment_status === "paid" ? t("ord.paid") : t("ord.pending")}
                                                </span>
                                            </td>
                                            <td className="cf-cell-num">{o.use_count}/{o.max_uses}</td>
                                            <td className="cf-cell-date">{o.expires_at ? new Date(o.expires_at).toLocaleDateString(locale) : "—"}</td>
                                            <td>
                                                <div className="cf-rowactions">
                                                    {o.payment_status === "pending" && (
                                                        <button type="button" onClick={() => markPaid(o)} disabled={busy} className="cf-btn">{t("ord.markPaid")}</button>
                                                    )}
                                                    {o.payment_status === "paid" && (
                                                        <button type="button" onClick={() => copyLink(o)} className="cf-btn-ghost">{t("ord.copyLink")}</button>
                                                    )}
                                                    <button type="button" onClick={() => deleteOrder(o)} disabled={busy} className="cf-btn-danger">{t("common.delete")}</button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <p className="cf-footnote">
                        {t("ord.foot1")}<strong>{t("ord.markPaid")}</strong>{t("ord.foot2")}
                    </p>
                </div>
            )}

            {/* ============ CONFIGURACIÓN ============ */}
            {tab === "config" && (
                config === null ? (
                    <div className="cf-card-item"><p className="cf-meta" style={{ marginTop: 0 }}>{t("cfg.loading")}</p></div>
                ) : (
                    <form onSubmit={saveConfig} className="cf-card-item">
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))", gap: "1.05rem" }}>
                            <div>
                                <label className="cf-label" htmlFor="dd-cur">{t("cfg.currency")}</label>
                                <input id="dd-cur" type="text" value={config.currencySymbol} onChange={(e) => setConfig({ ...config, currencySymbol: e.target.value })} className="cf-input" maxLength={8} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="dd-days">{t("cfg.linkDays")}</label>
                                <input id="dd-days" type="number" min={1} max={365} value={config.linkDays} onChange={(e) => setConfig({ ...config, linkDays: e.target.value })} className="cf-input" />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="dd-uses">{t("cfg.maxUses")}</label>
                                <input id="dd-uses" type="number" min={1} max={100} value={config.maxUses} onChange={(e) => setConfig({ ...config, maxUses: e.target.value })} className="cf-input" />
                            </div>
                        </div>
                        <div style={{ marginTop: "1.05rem" }}>
                            <label className="cf-label" htmlFor="dd-notify">{t("cfg.notify")}</label>
                            <input id="dd-notify" type="email" value={config.notifyEmail} onChange={(e) => setConfig({ ...config, notifyEmail: e.target.value })} placeholder={t("cfg.notifyPh")} className="cf-input" />
                        </div>
                        <div style={{ marginTop: "1.05rem" }}>
                            <label className="cf-label" htmlFor="dd-instr">{t("cfg.instr")}</label>
                            <textarea id="dd-instr" value={config.manualInstructions} onChange={(e) => setConfig({ ...config, manualInstructions: e.target.value })} rows={5}
                                placeholder={t("cfg.instrPh")}
                                className="cf-input" />
                            <p className="cf-help">
                                {t("cfg.instrHelp")}
                            </p>
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.5rem" }}>
                            <button type="submit" disabled={busy} className="cf-btn">{busy ? t("common.saving") : t("cfg.save")}</button>
                        </div>
                    </form>
                )
            )}
        </div>
    );
}
