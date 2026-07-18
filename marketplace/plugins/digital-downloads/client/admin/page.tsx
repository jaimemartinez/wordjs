// @ts-nocheck
"use client";

/**
 * Admin page for the Digital Downloads plugin (/admin/plugin/downloads).
 * Tabs: Productos (CRUD + sales/download counters), Pedidos (pending badge, mark-paid → auto-email,
 * CSV export), Configuración (currency symbol, manual-payment instructions, notify email,
 * link expiry days, max uses). All calls go through the host api helpers (session cookie).
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected by the
 * host admin shell and scoped to .plugin-admin-downloads) — the markup below only uses cf-*
 * classes plus sparse inline styles for one-off layout.
 */

import React, { useEffect, useMemo, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";

const BASE = "/plugin/digital-downloads";

const EMPTY_FORM = { name: "", slug: "", description: "", price: "0", file_url: "", file_label: "", image_url: "", is_published: true };

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

    const symbol = config?.currencySymbol || "$";
    const pendingCount = useMemo(() => orders.filter((o) => o.payment_status === "pending").length, [orders]);
    const isError = /error|inválid|no encontrado|no se pudo|falló/i.test(message);

    const loadAll = async () => {
        try { setProducts(await api(`${BASE}/products`)); } catch { setProducts([]); }
        try { setOrders(await api(`${BASE}/orders`)); } catch { setOrders([]); }
        try { setConfig(await api(`${BASE}/config`)); } catch { setConfig(null); }
    };
    useEffect(() => { loadAll(); }, []);

    const flash = (msg) => { setMessage(msg); };

    // ---- products ----
    const openCreate = () => { setForm(EMPTY_FORM); setEditingId(null); setShowForm(true); setMessage(""); };
    const openEdit = (p) => {
        setForm({
            name: p.name || "", slug: p.slug || "", description: p.description || "",
            price: ((Number(p.price_cents) || 0) / 100).toFixed(2),
            file_url: p.file_url || "", file_label: p.file_label || "", image_url: p.image_url || "",
            is_published: !!p.is_published,
        });
        setEditingId(p.id); setShowForm(true); setMessage("");
    };

    const saveProduct = async (e) => {
        e.preventDefault();
        const cents = priceToCents(form.price);
        if (cents === null) return flash("Error: precio inválido (usa un número, 0 = gratis).");
        if (!form.file_url.trim()) return flash("Error: la URL del archivo es obligatoria.");
        setBusy(true); setMessage("");
        try {
            const body = {
                name: form.name.trim(), slug: form.slug.trim(), description: form.description,
                price_cents: cents, file_url: form.file_url.trim(), file_label: form.file_label.trim(),
                image_url: form.image_url.trim(), is_published: form.is_published,
            };
            if (editingId) await apiPut(`${BASE}/products/${editingId}`, body);
            else await apiPost(`${BASE}/products`, body);
            setShowForm(false); setForm(EMPTY_FORM); setEditingId(null);
            flash(editingId ? "Producto actualizado." : "Producto creado.");
            loadAll();
        } catch (err) { flash(`Error: ${err?.message || err}`); }
        finally { setBusy(false); }
    };

    const deleteProduct = async (p) => {
        if (!window.confirm(`¿Eliminar "${p.name}"? Se eliminarán también sus pedidos y enlaces de descarga.`)) return;
        setBusy(true);
        try { await apiDelete(`${BASE}/products/${p.id}`); flash("Producto eliminado."); loadAll(); }
        catch (err) { flash(`Error: ${err?.message || err}`); }
        finally { setBusy(false); }
    };

    const togglePublished = async (p) => {
        setBusy(true);
        try { await apiPut(`${BASE}/products/${p.id}`, { is_published: !p.is_published }); loadAll(); }
        catch (err) { flash(`Error: ${err?.message || err}`); }
        finally { setBusy(false); }
    };

    // ---- orders ----
    const markPaid = async (o) => {
        setBusy(true); setMessage("");
        try {
            const r = await apiPost(`${BASE}/orders/${o.id}/paid`, {});
            if (r.already) flash("El pedido ya estaba pagado.");
            else flash(r.emailSent ? "Pedido marcado como pagado — enlace enviado por correo." : "Pedido marcado como pagado, pero el correo no se pudo enviar (revisa el proveedor de email). El cliente puede usar su código de pedido.");
            loadAll();
        } catch (err) { flash(`Error: ${err?.message || err}`); }
        finally { setBusy(false); }
    };

    const deleteOrder = async (o) => {
        if (!window.confirm(`¿Eliminar el pedido #${o.id} de ${o.customer_email}? Su enlace de descarga dejará de funcionar.`)) return;
        setBusy(true);
        try { await apiDelete(`${BASE}/orders/${o.id}`); flash("Pedido eliminado."); loadAll(); }
        catch (err) { flash(`Error: ${err?.message || err}`); }
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
            a.href = url; a.download = data.filename || "pedidos.csv";
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
            flash(`Exportados ${data.count} pedidos.`);
        } catch (err) { flash(`Error: ${err?.message || err}`); }
        finally { setBusy(false); }
    };

    const copyLink = async (o) => {
        try {
            const path = o.page_path && o.page_path.startsWith("/") ? o.page_path : "/";
            const sep = path.includes("?") ? "&" : "?";
            const link = `${window.location.origin}${path}${sep}dl=${o.token}`;
            await navigator.clipboard.writeText(link);
            flash("Enlace copiado al portapapeles.");
        } catch { flash("Error: no se pudo copiar el enlace."); }
    };

    // ---- config ----
    const saveConfig = async (e) => {
        e.preventDefault();
        setBusy(true); setMessage("");
        try {
            const saved = await apiPost(`${BASE}/config`, config);
            setConfig(saved);
            flash("Configuración guardada.");
        } catch (err) { flash(`Error: ${err?.message || err}`); }
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
                    <h1 className="cf-title">Descargas Digitales</h1>
                    <p className="cf-subtitle">
                        Productos descargables con enlaces protegidos por token (caducidad + límite de usos)
                    </p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* tabs */}
            <div className="cf-tabs" role="tablist">
                {tabBtn("products", "Productos", 0)}
                {tabBtn("orders", "Pedidos", pendingCount)}
                {tabBtn("config", "Configuración", 0)}
            </div>

            {message && (
                <div role={isError ? "alert" : "status"} className={`cf-flash ${isError ? "is-error" : "is-ok"}`}>{message}</div>
            )}

            {/* ============ PRODUCTOS ============ */}
            {tab === "products" && (
                <div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
                        <button type="button" onClick={openCreate} className="cf-btn"><IconPlus /> Nuevo producto</button>
                    </div>

                    {showForm && (
                        <form onSubmit={saveProduct} className="cf-editor">
                            <div className="cf-editor-body">
                                <h2 className="cf-editor-title">
                                    <IconPen />
                                    {editingId ? "Editar producto" : "Nuevo producto"}
                                </h2>
                                <div className="cf-grid">
                                    <div>
                                        <label className="cf-label" htmlFor="dd-name">Nombre *</label>
                                        <input id="dd-name" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="cf-input" required />
                                    </div>
                                    <div>
                                        <label className="cf-label" htmlFor="dd-slug">Slug (opcional — se genera del nombre)</label>
                                        <input id="dd-slug" type="text" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="mi-ebook" className="cf-input" />
                                    </div>
                                    <div className="cf-span-2">
                                        <label className="cf-label" htmlFor="dd-desc">Descripción</label>
                                        <textarea id="dd-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className="cf-input" />
                                    </div>
                                    <div>
                                        <label className="cf-label" htmlFor="dd-price">Precio ({symbol}) — 0 = gratis</label>
                                        <input id="dd-price" type="text" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="9.99" className="cf-input" />
                                    </div>
                                    <div>
                                        <label className="cf-label" htmlFor="dd-flabel">Etiqueta del archivo</label>
                                        <input id="dd-flabel" type="text" value={form.file_label} onChange={(e) => setForm({ ...form, file_label: e.target.value })} placeholder="PDF — 12 MB" className="cf-input" />
                                    </div>
                                    <div className="cf-span-2">
                                        <label className="cf-label" htmlFor="dd-furl">URL del archivo *</label>
                                        <input id="dd-furl" type="text" value={form.file_url} onChange={(e) => setForm({ ...form, file_url: e.target.value })} placeholder="/uploads/2026/07/mi-ebook.pdf" className="cf-input" required />
                                        <p className="cf-help">
                                            Sube el archivo a la <strong>biblioteca de medios</strong> y pega aquí su URL. El enlace nunca se muestra públicamente:
                                            solo se revela a quien tenga un token de descarga válido.
                                        </p>
                                    </div>
                                    <div className="cf-span-2">
                                        <label className="cf-label" htmlFor="dd-img">URL de imagen (opcional)</label>
                                        <input id="dd-img" type="text" value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} placeholder="/uploads/2026/07/portada.jpg" className="cf-input" />
                                    </div>
                                </div>
                                <div style={{ marginTop: "0.9rem" }}>
                                    <label className="cf-check">
                                        <input type="checkbox" checked={form.is_published} onChange={(e) => setForm({ ...form, is_published: e.target.checked })} />
                                        Publicado (visible en el bloque del editor visual)
                                    </label>
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", justifyContent: "flex-end", marginTop: "1.2rem" }}>
                                    <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }} className="cf-btn-ghost">Cancelar</button>
                                    <button type="submit" disabled={busy} className="cf-btn">{busy ? "Guardando…" : "Guardar producto"}</button>
                                </div>
                            </div>
                        </form>
                    )}

                    <div className="cf-card-item">
                        <h2 className="cf-card-heading">Productos ({products.length})</h2>
                        {products.length === 0 ? (
                            <div className="cf-empty">
                                <IconBox />
                                <span>Sin productos todavía — crea el primero y agrégalo con el bloque <strong>DigitalDownloads</strong> en el editor visual.</span>
                            </div>
                        ) : (
                            <div className="cf-table-wrap">
                                <table className="cf-table is-static">
                                    <thead>
                                        <tr>
                                            <th>Producto</th>
                                            <th>Precio</th>
                                            <th>Ventas</th>
                                            <th>Descargas</th>
                                            <th>Estado</th>
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
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="cf-cell-money">{(Number(p.price_cents) || 0) === 0 ? <span className="cf-free">Gratis</span> : fmtMoney(p.price_cents, symbol)}</td>
                                                <td className="cf-cell-num">{p.sales_count}</td>
                                                <td className="cf-cell-num">{p.download_count}</td>
                                                <td>
                                                    <button type="button" onClick={() => togglePublished(p)} disabled={busy}
                                                        className={`cf-pill-btn ${p.is_published ? "is-on" : "is-off"}`}>
                                                        {p.is_published ? "Publicado" : "Oculto"}
                                                    </button>
                                                </td>
                                                <td>
                                                    <div className="cf-rowactions">
                                                        <button type="button" onClick={() => openEdit(p)} className="cf-btn-ghost"><IconPen /> Editar</button>
                                                        <button type="button" onClick={() => deleteProduct(p)} disabled={busy} className="cf-btn-danger">Eliminar</button>
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
                        <h2 className="cf-card-heading" style={{ margin: 0 }}>Pedidos ({filteredOrders.length})</h2>
                        <div className="cf-toolbar-left">
                            <select
                                value={orderFilter}
                                onChange={(e) => setOrderFilter(e.target.value)}
                                className="cf-select"
                                aria-label="Filtrar pedidos por estado"
                            >
                                <option value="all">Todos</option>
                                <option value="pending">Pendientes</option>
                                <option value="paid">Pagados</option>
                            </select>
                            <button type="button" onClick={exportCsv} disabled={busy} className="cf-btn-ghost"><IconDownload /> Exportar CSV</button>
                        </div>
                    </div>
                    {filteredOrders.length === 0 ? (
                        <div className="cf-empty">
                            <IconReceipt />
                            <span>No hay pedidos {orderFilter === "pending" ? "pendientes" : orderFilter === "paid" ? "pagados" : ""} todavía.</span>
                        </div>
                    ) : (
                        <div className="cf-table-wrap">
                            <table className="cf-table is-static">
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Producto</th>
                                        <th>Cliente</th>
                                        <th>Importe</th>
                                        <th>Estado</th>
                                        <th>Usos</th>
                                        <th>Expira</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredOrders.map((o) => (
                                        <tr key={o.id}>
                                            <td className="cf-cell-num">{o.id}</td>
                                            <td><span className="cf-prod-name">{o.product_name || "(eliminado)"}</span></td>
                                            <td>
                                                <div className="cf-prod-name">{o.customer_name || "—"}</div>
                                                <div className="cf-prod-sub">{o.customer_email}</div>
                                            </td>
                                            <td className="cf-cell-money">{(Number(o.amount_cents) || 0) === 0 ? <span className="cf-free">Gratis</span> : fmtMoney(o.amount_cents, symbol)}</td>
                                            <td>
                                                <span className={`cf-pill ${o.payment_status === "paid" ? "is-paid" : "is-pending"}`}>
                                                    {o.payment_status === "paid" ? "Pagado" : "Pendiente"}
                                                </span>
                                            </td>
                                            <td className="cf-cell-num">{o.use_count}/{o.max_uses}</td>
                                            <td className="cf-cell-date">{o.expires_at ? new Date(o.expires_at).toLocaleDateString() : "—"}</td>
                                            <td>
                                                <div className="cf-rowactions">
                                                    {o.payment_status === "pending" && (
                                                        <button type="button" onClick={() => markPaid(o)} disabled={busy} className="cf-btn">Marcar pagado</button>
                                                    )}
                                                    {o.payment_status === "paid" && (
                                                        <button type="button" onClick={() => copyLink(o)} className="cf-btn-ghost">Copiar enlace</button>
                                                    )}
                                                    <button type="button" onClick={() => deleteOrder(o)} disabled={busy} className="cf-btn-danger">Eliminar</button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <p className="cf-footnote">
                        Al pulsar <strong>Marcar pagado</strong> se reinicia la caducidad del enlace y se envía automáticamente el correo de descarga al cliente.
                    </p>
                </div>
            )}

            {/* ============ CONFIGURACIÓN ============ */}
            {tab === "config" && (
                config === null ? (
                    <div className="cf-card-item"><p className="cf-meta" style={{ marginTop: 0 }}>Cargando configuración…</p></div>
                ) : (
                    <form onSubmit={saveConfig} className="cf-card-item">
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))", gap: "1.05rem" }}>
                            <div>
                                <label className="cf-label" htmlFor="dd-cur">Símbolo de moneda</label>
                                <input id="dd-cur" type="text" value={config.currencySymbol} onChange={(e) => setConfig({ ...config, currencySymbol: e.target.value })} className="cf-input" maxLength={8} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="dd-days">Días de validez del enlace</label>
                                <input id="dd-days" type="number" min={1} max={365} value={config.linkDays} onChange={(e) => setConfig({ ...config, linkDays: e.target.value })} className="cf-input" />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="dd-uses">Máx. descargas por enlace</label>
                                <input id="dd-uses" type="number" min={1} max={100} value={config.maxUses} onChange={(e) => setConfig({ ...config, maxUses: e.target.value })} className="cf-input" />
                            </div>
                        </div>
                        <div style={{ marginTop: "1.05rem" }}>
                            <label className="cf-label" htmlFor="dd-notify">Correo de notificación (nuevos pedidos)</label>
                            <input id="dd-notify" type="email" value={config.notifyEmail} onChange={(e) => setConfig({ ...config, notifyEmail: e.target.value })} placeholder="ventas@midominio.com (vacío = correo del administrador)" className="cf-input" />
                        </div>
                        <div style={{ marginTop: "1.05rem" }}>
                            <label className="cf-label" htmlFor="dd-instr">Instrucciones de pago manual</label>
                            <textarea id="dd-instr" value={config.manualInstructions} onChange={(e) => setConfig({ ...config, manualInstructions: e.target.value })} rows={5}
                                placeholder={"Ej.: Transfiere el importe a la cuenta XX00 0000 0000 e indica tu código de pedido en el concepto. Confirmaremos tu pago en 24h."}
                                className="cf-input" />
                            <p className="cf-help">
                                Se muestran al comprador de productos de pago (y en su correo de "pedido recibido"). El pago con Stripe llegará en una versión futura;
                                en esta versión los pedidos de pago se confirman manualmente desde la pestaña Pedidos.
                            </p>
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.5rem" }}>
                            <button type="submit" disabled={busy} className="cf-btn">{busy ? "Guardando…" : "Guardar configuración"}</button>
                        </div>
                    </form>
                )
            )}
        </div>
    );
}
