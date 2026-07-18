// @ts-nocheck
"use client";

/**
 * Admin page for the Online Store plugin (/admin/plugin/store).
 * Tabs: Pedidos (orders + CSV export), Productos (CRUD), Cupones (CRUD), Configuración
 * (currency / shipping / manual instructions / store email / write-only Stripe key).
 * All money is INTEGER CENTS server-side; this page converts decimal inputs to cents on save.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

const B = "/plugin/online-store";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnGhostCls = "px-5 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnDangerCls = "px-4 py-2 bg-red-50 hover:bg-red-600 hover:text-white text-red-600 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all";
const cardCls = "bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8";

const ORDER_STATUSES = ["new", "processing", "shipped", "completed", "cancelled"];
const STATUS_LABELS = { new: "Nuevo", processing: "En proceso", shipped: "Enviado", completed: "Completado", cancelled: "Cancelado" };
const STATUS_PILL = {
    new: "bg-blue-100 text-blue-700",
    processing: "bg-amber-100 text-amber-700",
    shipped: "bg-purple-100 text-purple-700",
    completed: "bg-green-100 text-green-700",
    cancelled: "bg-gray-200 text-gray-500",
};
const PAYMENT_STATUSES = ["pending", "paid", "cancelled"];
const PAY_LABELS = { pending: "Pendiente", paid: "Pagado", cancelled: "Cancelado" };
const PAY_PILL = { pending: "bg-amber-100 text-amber-700", paid: "bg-green-100 text-green-700", cancelled: "bg-gray-200 text-gray-500" };

// Decimal string -> integer cents (null when invalid).
const parseMoney = (s) => {
    const n = parseFloat(String(s == null ? "" : s).replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
};
const centsToInput = (cents) => ((Number(cents) || 0) / 100).toFixed(2);

// Module-level modal (never define a component inside a component).
function Modal({ title, onClose, children, wide }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-gray-900/50" onClick={onClose} />
            <div className={`relative bg-white rounded-3xl shadow-2xl w-full ${wide ? "max-w-3xl" : "max-w-lg"} max-h-[90vh] overflow-y-auto p-6 sm:p-8`}>
                <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-black text-gray-900 tracking-tight">{title}</h3>
                    <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none font-bold" aria-label="Cerrar">&#215;</button>
                </div>
                {children}
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
        <div className="max-w-6xl mx-auto p-4 sm:p-8">
            <div className="mb-8">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Tienda Online</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Catálogo + carrito + checkout con cupones y Stripe opcional
                </p>
            </div>

            <div className="flex flex-wrap gap-2 mb-6">
                {tabs.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        onClick={() => { setTab(t.id); setMsg(null); }}
                        className={`px-4 py-2 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${tab === t.id ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {msg && (
                <div className={`text-sm px-4 py-3 rounded-xl mb-6 ${msg.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
                    {msg.text}
                </div>
            )}

            {/* ============================ PEDIDOS ============================ */}
            {tab === "orders" && (
                <div className={cardCls}>
                    <div className="flex flex-wrap items-center gap-3 mb-6">
                        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); loadOrders(e.target.value, orderSearch); }} className="px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl font-medium outline-none">
                            <option value="">Todos los estados</option>
                            {ORDER_STATUSES.map((s) => (
                                <option key={s} value={s}>{STATUS_LABELS[s]}{counts[s] ? ` (${counts[s]})` : ""}</option>
                            ))}
                        </select>
                        <input
                            type="search"
                            placeholder="Buscar cliente, email o código…"
                            value={orderSearch}
                            onChange={(e) => setOrderSearch(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") loadOrders(statusFilter, orderSearch); }}
                            className="flex-1 min-w-[200px] px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl font-medium outline-none"
                        />
                        <button type="button" onClick={() => loadOrders(statusFilter, orderSearch)} className={btnGhostCls}>Buscar</button>
                        <button type="button" onClick={exportCsv} disabled={busy} className={btnCls}>Exportar CSV</button>
                    </div>

                    {orders.length === 0 ? (
                        <p className="text-sm text-gray-400">No hay pedidos todavía.</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                        <th className="py-3 pr-4">#</th>
                                        <th className="py-3 pr-4">Fecha</th>
                                        <th className="py-3 pr-4">Cliente</th>
                                        <th className="py-3 pr-4">Total</th>
                                        <th className="py-3 pr-4">Pago</th>
                                        <th className="py-3 pr-4">Estado</th>
                                        <th className="py-3"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {orders.map((o) => (
                                        <tr key={o.id} className="border-b border-gray-50 hover:bg-gray-50/60">
                                            <td className="py-3 pr-4 font-black">#{o.id}</td>
                                            <td className="py-3 pr-4 text-gray-500 whitespace-nowrap">{String(o.created_at || "").slice(0, 16)}</td>
                                            <td className="py-3 pr-4">
                                                <div className="font-bold text-gray-800">{o.customer_name}</div>
                                                <div className="text-xs text-gray-400">{o.customer_email}</div>
                                            </td>
                                            <td className="py-3 pr-4 font-black">{fmt(o.total_cents)}</td>
                                            <td className="py-3 pr-4">
                                                <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ${PAY_PILL[o.payment_status] || "bg-gray-100 text-gray-500"}`}>
                                                    {PAY_LABELS[o.payment_status] || o.payment_status}
                                                </span>
                                            </td>
                                            <td className="py-3 pr-4">
                                                <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ${STATUS_PILL[o.status] || "bg-gray-100 text-gray-500"}`}>
                                                    {STATUS_LABELS[o.status] || o.status}
                                                </span>
                                            </td>
                                            <td className="py-3 text-right">
                                                <button type="button" onClick={() => setDetail(o)} className={btnGhostCls.replace("px-5 py-3", "px-4 py-2") + " text-[10px]"}>Ver</button>
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
                <div className={cardCls}>
                    <div className="flex items-center justify-between mb-6">
                        <h2 className="font-bold text-gray-800">Productos ({products.length})</h2>
                        <button type="button" onClick={() => setProductForm({ ...EMPTY_PRODUCT })} className={btnCls}>Nuevo producto</button>
                    </div>
                    {products.length === 0 ? (
                        <p className="text-sm text-gray-400">Sin productos — crea el primero para que aparezca en el bloque OnlineStore.</p>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {products.map((p) => (
                                <div key={p.id} className="border border-gray-100 rounded-2xl overflow-hidden flex flex-col">
                                    {p.image_url ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={p.image_url} alt={p.name} className="w-full aspect-[4/3] object-cover bg-gray-50" decoding="async" />
                                    ) : (
                                        <div className="w-full aspect-[4/3] bg-gray-50 flex items-center justify-center text-gray-300 text-3xl">&#128722;</div>
                                    )}
                                    <div className="p-4 flex flex-col gap-1 flex-1">
                                        <div className="flex items-center gap-2">
                                            <span className="font-bold text-gray-800 flex-1 truncate">{p.name}</span>
                                            {!p.is_published && <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-400 text-[9px] font-black uppercase">Oculto</span>}
                                        </div>
                                        <div className="text-xs text-gray-400">{p.category || "Sin categoría"} · {p.stock < 0 ? "Stock ilimitado" : `Stock: ${p.stock}`}</div>
                                        <div className="font-black text-gray-900 mt-1">{fmt(p.price_cents)}</div>
                                        <div className="flex gap-2 mt-3">
                                            <button
                                                type="button"
                                                onClick={() => setProductForm({
                                                    id: p.id, name: p.name, price: centsToInput(p.price_cents),
                                                    description: p.description || "", image_url: p.image_url || "",
                                                    category: p.category || "", stock: p.stock < 0 ? "" : String(p.stock),
                                                    is_published: !!p.is_published,
                                                })}
                                                className={btnGhostCls.replace("px-5 py-3", "px-4 py-2") + " text-[10px]"}
                                            >
                                                Editar
                                            </button>
                                            <button type="button" onClick={() => deleteProduct(p.id)} className={btnDangerCls}>Eliminar</button>
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
                <div className={cardCls}>
                    <div className="flex items-center justify-between mb-6">
                        <h2 className="font-bold text-gray-800">Cupones ({coupons.length})</h2>
                        <button type="button" onClick={() => setCouponForm({ ...EMPTY_COUPON })} className={btnCls}>Nuevo cupón</button>
                    </div>
                    {coupons.length === 0 ? (
                        <p className="text-sm text-gray-400">Sin cupones todavía.</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                        <th className="py-3 pr-4">Código</th>
                                        <th className="py-3 pr-4">Descuento</th>
                                        <th className="py-3 pr-4">Mínimo</th>
                                        <th className="py-3 pr-4">Usos</th>
                                        <th className="py-3 pr-4">Activo</th>
                                        <th className="py-3"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {coupons.map((c) => (
                                        <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50/60">
                                            <td className="py-3 pr-4 font-black font-mono">{c.code}</td>
                                            <td className="py-3 pr-4">{c.type === "percent" ? `${c.value}%` : fmt(c.value)}</td>
                                            <td className="py-3 pr-4">{c.min_total_cents > 0 ? fmt(c.min_total_cents) : "—"}</td>
                                            <td className="py-3 pr-4">{c.used_count}{c.max_uses >= 0 ? ` / ${c.max_uses}` : " / ∞"}</td>
                                            <td className="py-3 pr-4">
                                                <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase ${c.is_active ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-500"}`}>
                                                    {c.is_active ? "Sí" : "No"}
                                                </span>
                                            </td>
                                            <td className="py-3 text-right whitespace-nowrap">
                                                <button
                                                    type="button"
                                                    onClick={() => setCouponForm({
                                                        id: c.id, code: c.code, type: c.type,
                                                        value: c.type === "percent" ? String(c.value) : centsToInput(c.value),
                                                        minTotal: c.min_total_cents > 0 ? centsToInput(c.min_total_cents) : "",
                                                        maxUses: c.max_uses >= 0 ? String(c.max_uses) : "",
                                                        is_active: !!c.is_active,
                                                    })}
                                                    className={btnGhostCls.replace("px-5 py-3", "px-4 py-2") + " text-[10px] mr-2"}
                                                >
                                                    Editar
                                                </button>
                                                <button type="button" onClick={() => deleteCoupon(c.id)} className={btnDangerCls}>Eliminar</button>
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
                <form onSubmit={saveConfig} className={cardCls + " space-y-5 max-w-2xl"}>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div>
                            <label className={labelCls}>Símbolo de moneda</label>
                            <input type="text" value={cfgForm.currencySymbol} onChange={(e) => setCfgForm({ ...cfgForm, currencySymbol: e.target.value })} className={inputCls} maxLength={8} />
                        </div>
                        <div>
                            <label className={labelCls}>Código de moneda (ISO)</label>
                            <input type="text" value={cfgForm.currencyCode} onChange={(e) => setCfgForm({ ...cfgForm, currencyCode: e.target.value })} placeholder="USD" className={inputCls} maxLength={3} />
                        </div>
                        <div>
                            <label className={labelCls}>Envío fijo ({cfgForm.currencySymbol})</label>
                            <input type="text" inputMode="decimal" value={cfgForm.shipping} onChange={(e) => setCfgForm({ ...cfgForm, shipping: e.target.value })} placeholder="0.00" className={inputCls} />
                        </div>
                    </div>
                    <div>
                        <label className={labelCls}>Instrucciones de pago manual</label>
                        <textarea rows={3} value={cfgForm.manualPaymentInstructions} onChange={(e) => setCfgForm({ ...cfgForm, manualPaymentInstructions: e.target.value })} className={inputCls} maxLength={2000} />
                        <p className="text-[11px] text-gray-400 mt-2">Se muestran al cliente al elegir pago manual y se incluyen en el correo de confirmación.</p>
                    </div>
                    <div>
                        <label className={labelCls}>Correo de la tienda (notificaciones de pedidos)</label>
                        <input type="email" value={cfgForm.storeEmail} onChange={(e) => setCfgForm({ ...cfgForm, storeEmail: e.target.value })} placeholder="ventas@mitienda.com" className={inputCls} maxLength={200} />
                    </div>
                    <div className="pt-4 border-t border-gray-100">
                        <label className={labelCls}>
                            Stripe secret key {hasStripeKey ? <span className="text-green-600">· configurada</span> : <span className="text-gray-300">· sin configurar</span>}
                        </label>
                        <input
                            type="password"
                            value={stripeKeyInput}
                            onChange={(e) => { setStripeKeyInput(e.target.value); setClearStripeKey(false); }}
                            placeholder={hasStripeKey ? "(configurada — escribe para reemplazar)" : "sk_live_… / sk_test_…"}
                            className={inputCls}
                            autoComplete="new-password"
                        />
                        <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                            La key nunca se muestra de vuelta (solo escribir). Con key configurada, el checkout ofrece
                            "Tarjeta (Stripe)". <strong>Probar:</strong> usa una key <span className="font-mono">sk_test_</span> y
                            haz un pedido de prueba desde el bloque — si la key es inválida, el pedido cae automáticamente a pago manual
                            y el error de Stripe aparece como aviso.
                        </p>
                        {hasStripeKey && (
                            <label className="flex items-center gap-2 mt-2 text-[11px] text-gray-500 cursor-pointer select-none">
                                <input type="checkbox" checked={clearStripeKey} onChange={(e) => { setClearStripeKey(e.target.checked); if (e.target.checked) setStripeKeyInput(""); }} />
                                Quitar la key (desactivar Stripe)
                            </label>
                        )}
                    </div>
                    <div className="flex justify-end">
                        <button type="submit" disabled={busy} className={btnCls}>{busy ? "Guardando…" : "Guardar configuración"}</button>
                    </div>
                </form>
            )}

            {/* ============================ MODAL: DETALLE PEDIDO ============================ */}
            {detail && (
                <Modal title={`Pedido #${detail.id}`} onClose={() => setDetail(null)} wide>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6 text-sm">
                        <div>
                            <div className={labelCls}>Cliente</div>
                            <div className="font-bold text-gray-800">{detail.customer_name}</div>
                            <div className="text-gray-500">{detail.customer_email}</div>
                            {detail.customer_phone && <div className="text-gray-500">{detail.customer_phone}</div>}
                            {detail.customer_address && <div className="text-gray-500 whitespace-pre-line">{detail.customer_address}</div>}
                        </div>
                        <div>
                            <div className={labelCls}>Pedido</div>
                            <div className="text-gray-500">Fecha: {String(detail.created_at || "").slice(0, 16)}</div>
                            <div className="text-gray-500">Código: <span className="font-mono text-xs">{detail.token}</span></div>
                            <div className="text-gray-500">Método: {detail.payment_method === "stripe" ? "Tarjeta (Stripe)" : "Pago manual"}</div>
                            {detail.coupon_code && <div className="text-gray-500">Cupón: <span className="font-mono">{detail.coupon_code}</span></div>}
                        </div>
                    </div>

                    <div className="overflow-x-auto mb-4">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                    <th className="py-2 pr-4">Producto</th>
                                    <th className="py-2 pr-4">Precio</th>
                                    <th className="py-2 pr-4">Cant.</th>
                                    <th className="py-2 text-right">Importe</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(detail.items || []).map((i, idx) => (
                                    <tr key={idx} className="border-b border-gray-50">
                                        <td className="py-2 pr-4 font-medium text-gray-800">{i.name}</td>
                                        <td className="py-2 pr-4 text-gray-500">{fmt(i.price_cents)}</td>
                                        <td className="py-2 pr-4 text-gray-500">x{i.qty}</td>
                                        <td className="py-2 text-right font-bold">{fmt(i.price_cents * i.qty)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div className="text-sm space-y-1 mb-6 max-w-xs ml-auto">
                        <div className="flex justify-between text-gray-500"><span>Subtotal</span><span>{fmt(detail.subtotal_cents)}</span></div>
                        {detail.discount_cents > 0 && <div className="flex justify-between text-gray-500"><span>Descuento</span><span>-{fmt(detail.discount_cents)}</span></div>}
                        <div className="flex justify-between text-gray-500"><span>Envío</span><span>{fmt(detail.shipping_cents)}</span></div>
                        <div className="flex justify-between font-black text-gray-900 text-base"><span>Total</span><span>{fmt(detail.total_cents)}</span></div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                        <div>
                            <label className={labelCls}>Estado del pedido</label>
                            <select value={detail.status} onChange={(e) => applyOrderStatus(detail.id, e.target.value)} className={inputCls}>
                                {ORDER_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className={labelCls}>Estado del pago</label>
                            <select value={detail.payment_status} onChange={(e) => applyPaymentStatus(detail.id, e.target.value)} className={inputCls}>
                                {PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{PAY_LABELS[s]}</option>)}
                            </select>
                        </div>
                    </div>

                    <div className="flex justify-between">
                        <button type="button" onClick={() => deleteOrder(detail.id)} className={btnDangerCls}>Eliminar pedido</button>
                        <button type="button" onClick={() => setDetail(null)} className={btnGhostCls}>Cerrar</button>
                    </div>
                </Modal>
            )}

            {/* ============================ MODAL: PRODUCTO ============================ */}
            {productForm && (
                <Modal title={productForm.id ? "Editar producto" : "Nuevo producto"} onClose={() => setProductForm(null)}>
                    <form onSubmit={saveProduct} className="space-y-4">
                        <div>
                            <label className={labelCls}>Nombre *</label>
                            <input type="text" value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} className={inputCls} required maxLength={200} />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelCls}>Precio ({symbol}) *</label>
                                <input type="text" inputMode="decimal" value={productForm.price} onChange={(e) => setProductForm({ ...productForm, price: e.target.value })} placeholder="19.99" className={inputCls} required />
                            </div>
                            <div>
                                <label className={labelCls}>Stock (vacío = ilimitado)</label>
                                <input type="text" inputMode="numeric" value={productForm.stock} onChange={(e) => setProductForm({ ...productForm, stock: e.target.value })} placeholder="∞" className={inputCls} />
                            </div>
                        </div>
                        <div>
                            <label className={labelCls}>Descripción</label>
                            <textarea rows={3} value={productForm.description} onChange={(e) => setProductForm({ ...productForm, description: e.target.value })} className={inputCls} maxLength={5000} />
                        </div>
                        <div>
                            <label className={labelCls}>URL de imagen</label>
                            <input type="text" value={productForm.image_url} onChange={(e) => setProductForm({ ...productForm, image_url: e.target.value })} placeholder="/uploads/2026/07/producto.jpg" className={inputCls} maxLength={1000} />
                        </div>
                        <div>
                            <label className={labelCls}>Categoría</label>
                            <input type="text" value={productForm.category} onChange={(e) => setProductForm({ ...productForm, category: e.target.value })} placeholder="ropa, accesorios…" className={inputCls} maxLength={100} />
                        </div>
                        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                            <input type="checkbox" checked={!!productForm.is_published} onChange={(e) => setProductForm({ ...productForm, is_published: e.target.checked })} />
                            Publicado (visible en la tienda)
                        </label>
                        <div className="flex justify-end gap-3">
                            <button type="button" onClick={() => setProductForm(null)} className={btnGhostCls}>Cancelar</button>
                            <button type="submit" disabled={busy} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                        </div>
                    </form>
                </Modal>
            )}

            {/* ============================ MODAL: CUPÓN ============================ */}
            {couponForm && (
                <Modal title={couponForm.id ? "Editar cupón" : "Nuevo cupón"} onClose={() => setCouponForm(null)}>
                    <form onSubmit={saveCoupon} className="space-y-4">
                        <div>
                            <label className={labelCls}>Código *</label>
                            <input type="text" value={couponForm.code} onChange={(e) => setCouponForm({ ...couponForm, code: e.target.value.toUpperCase() })} placeholder="VERANO10" className={inputCls + " font-mono uppercase"} required maxLength={50} />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelCls}>Tipo</label>
                                <select value={couponForm.type} onChange={(e) => setCouponForm({ ...couponForm, type: e.target.value })} className={inputCls}>
                                    <option value="percent">Porcentaje (%)</option>
                                    <option value="fixed">Monto fijo ({symbol})</option>
                                </select>
                            </div>
                            <div>
                                <label className={labelCls}>{couponForm.type === "percent" ? "Porcentaje (1–100)" : `Monto (${symbol})`}</label>
                                <input type="text" inputMode="decimal" value={couponForm.value} onChange={(e) => setCouponForm({ ...couponForm, value: e.target.value })} placeholder={couponForm.type === "percent" ? "10" : "5.00"} className={inputCls} required />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelCls}>Compra mínima ({symbol})</label>
                                <input type="text" inputMode="decimal" value={couponForm.minTotal} onChange={(e) => setCouponForm({ ...couponForm, minTotal: e.target.value })} placeholder="0.00" className={inputCls} />
                            </div>
                            <div>
                                <label className={labelCls}>Usos máximos (vacío = ∞)</label>
                                <input type="text" inputMode="numeric" value={couponForm.maxUses} onChange={(e) => setCouponForm({ ...couponForm, maxUses: e.target.value })} placeholder="∞" className={inputCls} />
                            </div>
                        </div>
                        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                            <input type="checkbox" checked={!!couponForm.is_active} onChange={(e) => setCouponForm({ ...couponForm, is_active: e.target.checked })} />
                            Activo
                        </label>
                        <div className="flex justify-end gap-3">
                            <button type="button" onClick={() => setCouponForm(null)} className={btnGhostCls}>Cancelar</button>
                            <button type="submit" disabled={busy} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                        </div>
                    </form>
                </Modal>
            )}
        </div>
    );
}
