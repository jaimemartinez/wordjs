// @ts-nocheck
"use client";

/**
 * Admin page for the Online Store plugin (/admin/plugin/store).
 * Tabs: Pedidos (orders + CSV export), Productos (CRUD), Cupones (CRUD), Configuración
 * (currency / shipping / manual instructions / store email / write-only Stripe key).
 * All money is INTEGER CENTS server-side; this page converts decimal inputs to cents on save.
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected by the
 * host admin shell and scoped to .plugin-admin-store) — the markup below only uses cf-* classes
 * plus sparse inline styles for one-off layout.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

const B = "/plugin/online-store";

const ORDER_STATUSES = ["new", "processing", "shipped", "completed", "cancelled"];
const STATUS_LABELS = { new: "Nuevo", processing: "En proceso", shipped: "Enviado", completed: "Completado", cancelled: "Cancelado" };
const STATUS_PILL = {
    new: "is-new",
    processing: "is-processing",
    shipped: "is-shipped",
    completed: "is-completed",
    cancelled: "is-cancelled",
};
const PAYMENT_STATUSES = ["pending", "paid", "cancelled"];
const PAY_LABELS = { pending: "Pendiente", paid: "Pagado", cancelled: "Cancelado" };
const PAY_PILL = { pending: "is-pending", paid: "is-paid", cancelled: "is-cancelled" };

// Decimal string -> integer cents (null when invalid).
const parseMoney = (s) => {
    const n = parseFloat(String(s == null ? "" : s).replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
};
const centsToInput = (cents) => ((Number(cents) || 0) / 100).toFixed(2);

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconCart = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <circle cx="9" cy="21" r="1" />
        <circle cx="20" cy="21" r="1" />
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
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
const IconBox = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <path d="m3.27 6.96 8.73 5.05 8.73-5.05" />
        <path d="M12 22.08V12" />
    </svg>
);
const IconTicket = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
        <path d="M13 5v2M13 11v2M13 17v2" />
    </svg>
);

// Module-level modal (never define a component inside a component).
function Modal({ title, onClose, children, wide }) {
    return (
        <div className="cf-overlay" onClick={onClose}>
            <div
                className="cf-letter"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                style={wide ? { maxWidth: "48rem" } : undefined}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="cf-letter-body">
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem", marginBottom: "1.15rem" }}>
                        <h3 className="cf-editor-title" style={{ marginBottom: 0 }}>{title}</h3>
                        <button type="button" onClick={onClose} className="cf-iconbtn" aria-label="Cerrar">&#215;</button>
                    </div>
                    {children}
                </div>
            </div>
        </div>
    );
}

const EMPTY_PRODUCT = { id: 0, name: "", price: "", description: "", image_url: "", category: "", stock: "", is_published: true };
const EMPTY_COUPON = { id: 0, code: "", type: "percent", value: "", minTotal: "", maxUses: "", is_active: true };

export default function OnlineStoreAdminPage() {
    const [tab, setTab] = useState("orders");
    const [msg, setMsg] = useState(null); // { ok, text }
    const [busy, setBusy] = useState(false);
    const [cfg, setCfg] = useState(null);

    // ---- orders state ----
    const [orders, setOrders] = useState([]);
    const [counts, setCounts] = useState({});
    const [ordersTotal, setOrdersTotal] = useState(0);
    const [statusFilter, setStatusFilter] = useState("");
    const [orderSearch, setOrderSearch] = useState("");
    const [detail, setDetail] = useState(null);

    // ---- products state ----
    const [products, setProducts] = useState([]);
    const [productForm, setProductForm] = useState(null);

    // ---- coupons state ----
    const [coupons, setCoupons] = useState([]);
    const [couponForm, setCouponForm] = useState(null);

    // ---- config state ----
    const [cfgForm, setCfgForm] = useState(null);
    const [hasStripeKey, setHasStripeKey] = useState(false);
    const [stripeKeyInput, setStripeKeyInput] = useState("");
    const [clearStripeKey, setClearStripeKey] = useState(false);

    const symbol = (cfg && cfg.currencySymbol) || "$";
    const fmt = (cents) => `${symbol}${((Number(cents) || 0) / 100).toFixed(2)}`;
    const flash = (ok, text) => { setMsg({ ok, text }); };

    const loadConfig = async () => {
        try {
            const c = await api(`${B}/config`);
            setCfg(c);
            setCfgForm({
                currencySymbol: c.currencySymbol || "$",
                currencyCode: (c.currencyCode || "usd").toUpperCase(),
                shipping: centsToInput(c.shippingCents),
                manualPaymentInstructions: c.manualPaymentInstructions || "",
                storeEmail: c.storeEmail || "",
            });
        } catch { /* first paint without config is fine */ }
        try {
            const s = await api(`${B}/stripe-status`);
            setHasStripeKey(!!(s && s.hasKey));
        } catch { /* ignore */ }
    };

    const loadOrders = async (status = statusFilter, search = orderSearch) => {
        try {
            const params = new URLSearchParams();
            if (status) params.set("status", status);
            if (search) params.set("search", search);
            params.set("limit", "100");
            const d = await api(`${B}/orders?${params.toString()}`);
            setOrders(d.orders || []);
            setCounts(d.counts || {});
            setOrdersTotal(d.total || 0);
        } catch (e) { flash(false, `Error al cargar pedidos: ${e?.message || e}`); }
    };

    const loadProducts = async () => {
        try {
            const d = await api(`${B}/products`);
            setProducts(d.products || []);
        } catch (e) { flash(false, `Error al cargar productos: ${e?.message || e}`); }
    };

    const loadCoupons = async () => {
        try {
            const d = await api(`${B}/coupons`);
            setCoupons(d.coupons || []);
        } catch (e) { flash(false, `Error al cargar cupones: ${e?.message || e}`); }
    };

    useEffect(() => { loadConfig(); loadOrders(); loadProducts(); loadCoupons(); }, []);

    // ---- orders actions ----
    const applyOrderStatus = async (id, status) => {
        try {
            const d = await apiPost(`${B}/orders/${id}/status`, { status });
            setDetail(d.order);
            loadOrders();
        } catch (e) { flash(false, `Error: ${e?.message || e}`); }
    };
    const applyPaymentStatus = async (id, payment_status) => {
        try {
            const d = await apiPost(`${B}/orders/${id}/payment`, { payment_status });
            setDetail(d.order);
            loadOrders();
            if (payment_status === "paid") flash(true, "Pago marcado como recibido (se intentó enviar el recibo por correo).");
        } catch (e) { flash(false, `Error: ${e?.message || e}`); }
    };
    const deleteOrder = async (id) => {
        if (typeof window !== "undefined" && !window.confirm("¿Eliminar este pedido definitivamente?")) return;
        try {
            await apiDelete(`${B}/orders/${id}`);
            setDetail(null);
            loadOrders();
            flash(true, "Pedido eliminado.");
        } catch (e) { flash(false, `Error: ${e?.message || e}`); }
    };
    const exportCsv = async () => {
        setBusy(true);
        try {
            const d = await api(`${B}/orders/export`);
            // The isolate JSON-encodes string bodies, so the CSV travels inside JSON and the
            // download is built client-side as a Blob.
            const blob = new Blob([d.csv || ""], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = d.filename || "pedidos.csv";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) { flash(false, `Error al exportar: ${e?.message || e}`); }
        finally { setBusy(false); }
    };

    // ---- products actions ----
    const saveProduct = async (e) => {
        e.preventDefault();
        const f = productForm;
        const cents = parseMoney(f.price);
        if (cents === null) { flash(false, "Precio no válido."); return; }
        let stock = -1;
        if (String(f.stock).trim() !== "") {
            stock = parseInt(f.stock, 10);
            if (!Number.isInteger(stock) || stock < -1) { flash(false, "Stock no válido (usa un entero, vacío o -1 = ilimitado)."); return; }
        }
        setBusy(true);
        try {
            await apiPost(`${B}/products`, {
                id: f.id || undefined,
                name: f.name,
                price_cents: cents,
                description: f.description,
                image_url: f.image_url,
                category: f.category,
                stock,
                is_published: !!f.is_published,
            });
            setProductForm(null);
            loadProducts();
            flash(true, "Producto guardado.");
        } catch (err) { flash(false, `Error al guardar: ${err?.message || err}`); }
        finally { setBusy(false); }
    };
    const deleteProduct = async (id) => {
        if (typeof window !== "undefined" && !window.confirm("¿Eliminar este producto?")) return;
        try {
            await apiDelete(`${B}/products/${id}`);
            loadProducts();
            flash(true, "Producto eliminado.");
        } catch (e) { flash(false, `Error: ${e?.message || e}`); }
    };

    // ---- coupons actions ----
    const saveCoupon = async (e) => {
        e.preventDefault();
        const f = couponForm;
        let value;
        if (f.type === "percent") {
            value = parseInt(f.value, 10);
            if (!Number.isInteger(value) || value < 1 || value > 100) { flash(false, "El porcentaje debe ser un entero entre 1 y 100."); return; }
        } else {
            value = parseMoney(f.value);
            if (value === null || value < 1) { flash(false, "El monto del descuento no es válido."); return; }
        }
        const minTotal = String(f.minTotal).trim() === "" ? 0 : parseMoney(f.minTotal);
        if (minTotal === null) { flash(false, "La compra mínima no es válida."); return; }
        let maxUses = -1;
        if (String(f.maxUses).trim() !== "") {
            maxUses = parseInt(f.maxUses, 10);
            if (!Number.isInteger(maxUses) || maxUses < -1) { flash(false, "Usos máximos no válidos (vacío o -1 = ilimitado)."); return; }
        }
        setBusy(true);
        try {
            await apiPost(`${B}/coupons`, {
                id: f.id || undefined,
                code: f.code,
                type: f.type,
                value,
                min_total_cents: minTotal,
                max_uses: maxUses,
                is_active: !!f.is_active,
            });
            setCouponForm(null);
            loadCoupons();
            flash(true, "Cupón guardado.");
        } catch (err) { flash(false, `Error al guardar: ${err?.message || err}`); }
        finally { setBusy(false); }
    };
    const deleteCoupon = async (id) => {
        if (typeof window !== "undefined" && !window.confirm("¿Eliminar este cupón?")) return;
        try {
            await apiDelete(`${B}/coupons/${id}`);
            loadCoupons();
            flash(true, "Cupón eliminado.");
        } catch (e) { flash(false, `Error: ${e?.message || e}`); }
    };

    // ---- config actions ----
    const saveConfig = async (e) => {
        e.preventDefault();
        const f = cfgForm;
        const shippingCents = String(f.shipping).trim() === "" ? 0 : parseMoney(f.shipping);
        if (shippingCents === null) { flash(false, "El costo de envío no es válido."); return; }
        setBusy(true);
        try {
            const c = await apiPost(`${B}/config`, {
                currencySymbol: f.currencySymbol,
                currencyCode: f.currencyCode,
                shippingCents,
                manualPaymentInstructions: f.manualPaymentInstructions,
                storeEmail: f.storeEmail,
            });
            setCfg(c);
            // Stripe key semantics: absent = keep, '' = clear, value = replace.
            if (clearStripeKey) {
                const s = await apiPost(`${B}/stripe-key`, { key: "" });
                setHasStripeKey(!!s.hasKey);
                setClearStripeKey(false);
            } else if (stripeKeyInput.trim()) {
                const s = await apiPost(`${B}/stripe-key`, { key: stripeKeyInput.trim() });
                setHasStripeKey(!!s.hasKey);
            }
            setStripeKeyInput("");
            flash(true, "Configuración guardada.");
        } catch (err) { flash(false, `Error al guardar: ${err?.message || err}`); }
        finally { setBusy(false); }
    };

    const tabs = [
        { id: "orders", label: `Pedidos${ordersTotal ? ` (${ordersTotal})` : ""}` },
        { id: "products", label: "Productos" },
        { id: "coupons", label: "Cupones" },
        { id: "config", label: "Configuración" },
    ];

    return (
        <div className="cf-shell">
            {/* header: stamp + title + airmail rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconCart /></div>
                <div>
                    <h1 className="cf-title">Tienda Online</h1>
                    <p className="cf-subtitle">Catálogo + carrito + checkout con cupones y Stripe opcional</p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* tabs */}
            <div className="cf-tabs" role="tablist">
                {tabs.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === t.id}
                        onClick={() => { setTab(t.id); setMsg(null); }}
                        className={`cf-tab ${tab === t.id ? "is-active" : ""}`}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {msg && (
                <div role={msg.ok ? "status" : "alert"} className={`cf-flash ${msg.ok ? "is-ok" : "is-error"}`}>
                    {msg.text}
                </div>
            )}

            {/* ============================ PEDIDOS ============================ */}
            {tab === "orders" && (
                <div className="cf-card-item">
                    <div className="cf-toolbar">
                        <div className="cf-toolbar-left" style={{ flex: 1 }}>
                            <select
                                aria-label="Filtrar por estado"
                                value={statusFilter}
                                onChange={(e) => { setStatusFilter(e.target.value); loadOrders(e.target.value, orderSearch); }}
                                className="cf-select"
                            >
                                <option value="">Todos los estados</option>
                                {ORDER_STATUSES.map((s) => (
                                    <option key={s} value={s}>{STATUS_LABELS[s]}{counts[s] ? ` (${counts[s]})` : ""}</option>
                                ))}
                            </select>
                            <input
                                type="search"
                                aria-label="Buscar pedidos"
                                placeholder="Buscar cliente, email o código…"
                                value={orderSearch}
                                onChange={(e) => setOrderSearch(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") loadOrders(statusFilter, orderSearch); }}
                                className="cf-input"
                                style={{ flex: 1, minWidth: "200px", width: "auto" }}
                            />
                        </div>
                        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                            <button type="button" onClick={() => loadOrders(statusFilter, orderSearch)} className="cf-btn-ghost">Buscar</button>
                            <button type="button" onClick={exportCsv} disabled={busy} className="cf-btn"><IconDownload /> Exportar CSV</button>
                        </div>
                    </div>

                    {orders.length === 0 ? (
                        <div className="cf-empty">
                            <IconBox />
                            <span>No hay pedidos todavía.</span>
                        </div>
                    ) : (
                        <div className="cf-table-wrap">
                            <table className="cf-table">
                                <thead>
                                    <tr>
                                        <th>#</th>
                                        <th>Fecha</th>
                                        <th>Cliente</th>
                                        <th>Total</th>
                                        <th>Pago</th>
                                        <th>Estado</th>
                                        <th style={{ width: "4rem" }}></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {orders.map((o) => (
                                        <tr key={o.id}>
                                            <td className="cf-cell-strong">#{o.id}</td>
                                            <td className="cf-cell-date">{String(o.created_at || "").slice(0, 16)}</td>
                                            <td>
                                                <div className="cf-cell-strong">{o.customer_name}</div>
                                                <div className="cf-cell-sub">{o.customer_email}</div>
                                            </td>
                                            <td className="cf-cell-money">{fmt(o.total_cents)}</td>
                                            <td>
                                                <span className={`cf-pill ${PAY_PILL[o.payment_status] || ""}`}>
                                                    {PAY_LABELS[o.payment_status] || o.payment_status}
                                                </span>
                                            </td>
                                            <td>
                                                <span className={`cf-pill ${STATUS_PILL[o.status] || ""}`}>
                                                    {STATUS_LABELS[o.status] || o.status}
                                                </span>
                                            </td>
                                            <td style={{ textAlign: "right" }}>
                                                <button type="button" onClick={() => setDetail(o)} className="cf-btn-ghost">Ver</button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {/* ============================ PRODUCTOS ============================ */}
            {tab === "products" && (
                <div className="cf-card-item">
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1.25rem" }}>
                        <h2 className="cf-form-name">Productos ({products.length})</h2>
                        <button type="button" onClick={() => setProductForm({ ...EMPTY_PRODUCT })} className="cf-btn"><IconPlus /> Nuevo producto</button>
                    </div>
                    {products.length === 0 ? (
                        <div className="cf-empty">
                            <IconCart />
                            <span>Sin productos — crea el primero para que aparezca en el bloque OnlineStore.</span>
                        </div>
                    ) : (
                        <div className="cf-product-grid">
                            {products.map((p) => (
                                <div key={p.id} className="cf-product-card">
                                    {p.image_url ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={p.image_url} alt={p.name} className="cf-product-img" decoding="async" />
                                    ) : (
                                        <div className="cf-product-ph" aria-hidden="true"><IconCart /></div>
                                    )}
                                    <div className="cf-product-body">
                                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
                                            <span className="cf-product-name" style={{ flex: 1 }}>{p.name}</span>
                                            {!p.is_published && <span className="cf-pill is-cancelled">Oculto</span>}
                                        </div>
                                        <div className="cf-product-meta">{p.category || "Sin categoría"} · {p.stock < 0 ? "Stock ilimitado" : `Stock: ${p.stock}`}</div>
                                        <div className="cf-product-price">{fmt(p.price_cents)}</div>
                                        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.7rem" }}>
                                            <button
                                                type="button"
                                                onClick={() => setProductForm({
                                                    id: p.id, name: p.name, price: centsToInput(p.price_cents),
                                                    description: p.description || "", image_url: p.image_url || "",
                                                    category: p.category || "", stock: p.stock < 0 ? "" : String(p.stock),
                                                    is_published: !!p.is_published,
                                                })}
                                                className="cf-btn-ghost"
                                            >
                                                <IconPen /> Editar
                                            </button>
                                            <button type="button" onClick={() => deleteProduct(p.id)} className="cf-btn-danger">Eliminar</button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ============================ CUPONES ============================ */}
            {tab === "coupons" && (
                <div className="cf-card-item">
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1.25rem" }}>
                        <h2 className="cf-form-name">Cupones ({coupons.length})</h2>
                        <button type="button" onClick={() => setCouponForm({ ...EMPTY_COUPON })} className="cf-btn"><IconPlus /> Nuevo cupón</button>
                    </div>
                    {coupons.length === 0 ? (
                        <div className="cf-empty">
                            <IconTicket />
                            <span>Sin cupones todavía.</span>
                        </div>
                    ) : (
                        <div className="cf-table-wrap">
                            <table className="cf-table">
                                <thead>
                                    <tr>
                                        <th>Código</th>
                                        <th>Descuento</th>
                                        <th>Mínimo</th>
                                        <th>Usos</th>
                                        <th>Activo</th>
                                        <th style={{ width: "9rem" }}></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {coupons.map((c) => (
                                        <tr key={c.id}>
                                            <td><span className="cf-code cf-cell-strong">{c.code}</span></td>
                                            <td className="cf-cell-money">{c.type === "percent" ? `${c.value}%` : fmt(c.value)}</td>
                                            <td>{c.min_total_cents > 0 ? fmt(c.min_total_cents) : "—"}</td>
                                            <td style={{ whiteSpace: "nowrap" }}>{c.used_count}{c.max_uses >= 0 ? ` / ${c.max_uses}` : " / ∞"}</td>
                                            <td>
                                                <span className={`cf-pill ${c.is_active ? "is-completed" : "is-cancelled"}`}>
                                                    {c.is_active ? "Sí" : "No"}
                                                </span>
                                            </td>
                                            <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                                                <div style={{ display: "inline-flex", gap: "0.5rem" }}>
                                                    <button
                                                        type="button"
                                                        onClick={() => setCouponForm({
                                                            id: c.id, code: c.code, type: c.type,
                                                            value: c.type === "percent" ? String(c.value) : centsToInput(c.value),
                                                            minTotal: c.min_total_cents > 0 ? centsToInput(c.min_total_cents) : "",
                                                            maxUses: c.max_uses >= 0 ? String(c.max_uses) : "",
                                                            is_active: !!c.is_active,
                                                        })}
                                                        className="cf-btn-ghost"
                                                    >
                                                        <IconPen /> Editar
                                                    </button>
                                                    <button type="button" onClick={() => deleteCoupon(c.id)} className="cf-btn-danger">Eliminar</button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {/* ============================ CONFIGURACIÓN ============================ */}
            {tab === "config" && cfgForm && (
                <form onSubmit={saveConfig} className="cf-editor" style={{ maxWidth: "42rem" }}>
                    <div className="cf-editor-body">
                        <div className="cf-grid-3">
                            <div>
                                <label className="cf-label" htmlFor="st-symbol">Símbolo de moneda</label>
                                <input id="st-symbol" type="text" value={cfgForm.currencySymbol} onChange={(e) => setCfgForm({ ...cfgForm, currencySymbol: e.target.value })} className="cf-input" maxLength={8} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="st-code">Código de moneda (ISO)</label>
                                <input id="st-code" type="text" value={cfgForm.currencyCode} onChange={(e) => setCfgForm({ ...cfgForm, currencyCode: e.target.value })} placeholder="USD" className="cf-input" maxLength={3} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="st-shipping">Envío fijo ({cfgForm.currencySymbol})</label>
                                <input id="st-shipping" type="text" inputMode="decimal" value={cfgForm.shipping} onChange={(e) => setCfgForm({ ...cfgForm, shipping: e.target.value })} placeholder="0.00" className="cf-input" />
                            </div>
                        </div>
                        <div style={{ marginTop: "1.05rem" }}>
                            <label className="cf-label" htmlFor="st-instructions">Instrucciones de pago manual</label>
                            <textarea id="st-instructions" rows={3} value={cfgForm.manualPaymentInstructions} onChange={(e) => setCfgForm({ ...cfgForm, manualPaymentInstructions: e.target.value })} className="cf-input" maxLength={2000} />
                            <p className="cf-help">Se muestran al cliente al elegir pago manual y se incluyen en el correo de confirmación.</p>
                        </div>
                        <div style={{ marginTop: "1.05rem" }}>
                            <label className="cf-label" htmlFor="st-store-email">Correo de la tienda (notificaciones de pedidos)</label>
                            <input id="st-store-email" type="email" value={cfgForm.storeEmail} onChange={(e) => setCfgForm({ ...cfgForm, storeEmail: e.target.value })} placeholder="ventas@mitienda.com" className="cf-input" maxLength={200} />
                        </div>
                        <div className="cf-config-sep">
                            <label className="cf-label" htmlFor="st-stripe-key">
                                Stripe secret key {hasStripeKey ? <span className="cf-ok-text">· configurada</span> : <span className="cf-faint-text">· sin configurar</span>}
                            </label>
                            <input
                                id="st-stripe-key"
                                type="password"
                                value={stripeKeyInput}
                                onChange={(e) => { setStripeKeyInput(e.target.value); setClearStripeKey(false); }}
                                placeholder={hasStripeKey ? "(configurada — escribe para reemplazar)" : "sk_live_… / sk_test_…"}
                                className="cf-input"
                                autoComplete="new-password"
                            />
                            <p className="cf-help">
                                La key nunca se muestra de vuelta (solo escribir). Con key configurada, el checkout ofrece
                                "Tarjeta (Stripe)". <strong>Probar:</strong> usa una key <span className="cf-code">sk_test_</span> y
                                haz un pedido de prueba desde el bloque — si la key es inválida, el pedido cae automáticamente a pago manual
                                y el error de Stripe aparece como aviso.
                            </p>
                            {hasStripeKey && (
                                <label className="cf-check">
                                    <input type="checkbox" checked={clearStripeKey} onChange={(e) => { setClearStripeKey(e.target.checked); if (e.target.checked) setStripeKeyInput(""); }} />
                                    Quitar la key (desactivar Stripe)
                                </label>
                            )}
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.5rem" }}>
                            <button type="submit" disabled={busy} className="cf-btn">{busy ? "Guardando…" : "Guardar configuración"}</button>
                        </div>
                    </div>
                </form>
            )}

            {/* ============================ MODAL: DETALLE PEDIDO ============================ */}
            {detail && (
                <Modal title={`Pedido #${detail.id}`} onClose={() => setDetail(null)} wide>
                    <div className="cf-grid" style={{ marginBottom: "1.3rem" }}>
                        <div>
                            <div className="cf-label">Cliente</div>
                            <div className="cf-cell-strong">{detail.customer_name}</div>
                            <div className="cf-detail-line">{detail.customer_email}</div>
                            {detail.customer_phone && <div className="cf-detail-line">{detail.customer_phone}</div>}
                            {detail.customer_address && <div className="cf-detail-line" style={{ whiteSpace: "pre-line" }}>{detail.customer_address}</div>}
                        </div>
                        <div>
                            <div className="cf-label">Pedido</div>
                            <div className="cf-detail-line">Fecha: {String(detail.created_at || "").slice(0, 16)}</div>
                            <div className="cf-detail-line">Código: <span className="cf-code">{detail.token}</span></div>
                            <div className="cf-detail-line">Método: {detail.payment_method === "stripe" ? "Tarjeta (Stripe)" : "Pago manual"}</div>
                            {detail.coupon_code && <div className="cf-detail-line">Cupón: <span className="cf-code">{detail.coupon_code}</span></div>}
                        </div>
                    </div>

                    <div className="cf-table-wrap" style={{ marginBottom: "1rem" }}>
                        <table className="cf-table">
                            <thead>
                                <tr>
                                    <th>Producto</th>
                                    <th>Precio</th>
                                    <th>Cant.</th>
                                    <th style={{ textAlign: "right" }}>Importe</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(detail.items || []).map((i, idx) => (
                                    <tr key={idx}>
                                        <td className="cf-cell-strong">{i.name}</td>
                                        <td>{fmt(i.price_cents)}</td>
                                        <td>x{i.qty}</td>
                                        <td className="cf-cell-money" style={{ textAlign: "right" }}>{fmt(i.price_cents * i.qty)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div className="cf-totals" style={{ marginBottom: "1.4rem" }}>
                        <div className="cf-totals-row"><span>Subtotal</span><span>{fmt(detail.subtotal_cents)}</span></div>
                        {detail.discount_cents > 0 && <div className="cf-totals-row"><span>Descuento</span><span>-{fmt(detail.discount_cents)}</span></div>}
                        <div className="cf-totals-row"><span>Envío</span><span>{fmt(detail.shipping_cents)}</span></div>
                        <div className="cf-totals-row is-grand"><span>Total</span><span>{fmt(detail.total_cents)}</span></div>
                    </div>

                    <div className="cf-grid" style={{ marginBottom: "1.4rem" }}>
                        <div>
                            <label className="cf-label" htmlFor="st-order-status">Estado del pedido</label>
                            <select id="st-order-status" value={detail.status} onChange={(e) => applyOrderStatus(detail.id, e.target.value)} className="cf-select">
                                {ORDER_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="st-pay-status">Estado del pago</label>
                            <select id="st-pay-status" value={detail.payment_status} onChange={(e) => applyPaymentStatus(detail.id, e.target.value)} className="cf-select">
                                {PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{PAY_LABELS[s]}</option>)}
                            </select>
                        </div>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
                        <button type="button" onClick={() => deleteOrder(detail.id)} className="cf-btn-danger">Eliminar pedido</button>
                        <button type="button" onClick={() => setDetail(null)} className="cf-btn-ghost">Cerrar</button>
                    </div>
                </Modal>
            )}

            {/* ============================ MODAL: PRODUCTO ============================ */}
            {productForm && (
                <Modal title={productForm.id ? "Editar producto" : "Nuevo producto"} onClose={() => setProductForm(null)}>
                    <form onSubmit={saveProduct} style={{ display: "grid", gap: "1.05rem" }}>
                        <div>
                            <label className="cf-label" htmlFor="st-p-name">Nombre *</label>
                            <input id="st-p-name" type="text" value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} className="cf-input" required maxLength={200} />
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.05rem" }}>
                            <div>
                                <label className="cf-label" htmlFor="st-p-price">Precio ({symbol}) *</label>
                                <input id="st-p-price" type="text" inputMode="decimal" value={productForm.price} onChange={(e) => setProductForm({ ...productForm, price: e.target.value })} placeholder="19.99" className="cf-input" required />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="st-p-stock">Stock (vacío = ilimitado)</label>
                                <input id="st-p-stock" type="text" inputMode="numeric" value={productForm.stock} onChange={(e) => setProductForm({ ...productForm, stock: e.target.value })} placeholder="∞" className="cf-input" />
                            </div>
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="st-p-desc">Descripción</label>
                            <textarea id="st-p-desc" rows={3} value={productForm.description} onChange={(e) => setProductForm({ ...productForm, description: e.target.value })} className="cf-input" maxLength={5000} />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="st-p-img">URL de imagen</label>
                            <input id="st-p-img" type="text" value={productForm.image_url} onChange={(e) => setProductForm({ ...productForm, image_url: e.target.value })} placeholder="/uploads/2026/07/producto.jpg" className="cf-input" maxLength={1000} />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="st-p-cat">Categoría</label>
                            <input id="st-p-cat" type="text" value={productForm.category} onChange={(e) => setProductForm({ ...productForm, category: e.target.value })} placeholder="ropa, accesorios…" className="cf-input" maxLength={100} />
                        </div>
                        <label className="cf-check">
                            <input type="checkbox" checked={!!productForm.is_published} onChange={(e) => setProductForm({ ...productForm, is_published: e.target.checked })} />
                            Publicado (visible en la tienda)
                        </label>
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
                            <button type="button" onClick={() => setProductForm(null)} className="cf-btn-ghost">Cancelar</button>
                            <button type="submit" disabled={busy} className="cf-btn">{busy ? "Guardando…" : "Guardar"}</button>
                        </div>
                    </form>
                </Modal>
            )}

            {/* ============================ MODAL: CUPÓN ============================ */}
            {couponForm && (
                <Modal title={couponForm.id ? "Editar cupón" : "Nuevo cupón"} onClose={() => setCouponForm(null)}>
                    <form onSubmit={saveCoupon} style={{ display: "grid", gap: "1.05rem" }}>
                        <div>
                            <label className="cf-label" htmlFor="st-c-code">Código *</label>
                            <input id="st-c-code" type="text" value={couponForm.code} onChange={(e) => setCouponForm({ ...couponForm, code: e.target.value.toUpperCase() })} placeholder="VERANO10" className="cf-input cf-code" style={{ textTransform: "uppercase" }} required maxLength={50} />
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.05rem" }}>
                            <div>
                                <label className="cf-label" htmlFor="st-c-type">Tipo</label>
                                <select id="st-c-type" value={couponForm.type} onChange={(e) => setCouponForm({ ...couponForm, type: e.target.value })} className="cf-select">
                                    <option value="percent">Porcentaje (%)</option>
                                    <option value="fixed">Monto fijo ({symbol})</option>
                                </select>
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="st-c-value">{couponForm.type === "percent" ? "Porcentaje (1–100)" : `Monto (${symbol})`}</label>
                                <input id="st-c-value" type="text" inputMode="decimal" value={couponForm.value} onChange={(e) => setCouponForm({ ...couponForm, value: e.target.value })} placeholder={couponForm.type === "percent" ? "10" : "5.00"} className="cf-input" required />
                            </div>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.05rem" }}>
                            <div>
                                <label className="cf-label" htmlFor="st-c-min">Compra mínima ({symbol})</label>
                                <input id="st-c-min" type="text" inputMode="decimal" value={couponForm.minTotal} onChange={(e) => setCouponForm({ ...couponForm, minTotal: e.target.value })} placeholder="0.00" className="cf-input" />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="st-c-max">Usos máximos (vacío = ∞)</label>
                                <input id="st-c-max" type="text" inputMode="numeric" value={couponForm.maxUses} onChange={(e) => setCouponForm({ ...couponForm, maxUses: e.target.value })} placeholder="∞" className="cf-input" />
                            </div>
                        </div>
                        <label className="cf-check">
                            <input type="checkbox" checked={!!couponForm.is_active} onChange={(e) => setCouponForm({ ...couponForm, is_active: e.target.checked })} />
                            Activo
                        </label>
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
                            <button type="button" onClick={() => setCouponForm(null)} className="cf-btn-ghost">Cancelar</button>
                            <button type="submit" disabled={busy} className="cf-btn">{busy ? "Guardando…" : "Guardar"}</button>
                        </div>
                    </form>
                </Modal>
            )}
        </div>
    );
}
