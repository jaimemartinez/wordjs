// @ts-nocheck
"use client";

/**
 * Admin page for the Online Store plugin v2 (/admin/plugin/store).
 * Tabs: Pedidos (orders + refunds + CSV), Productos (CRUD + variants + gallery), Cupones,
 * Envío e impuestos (zones + pickup + taxes), Informes (sales reports + CSV), Configuración.
 * All money is INTEGER CENTS server-side; this page converts decimal inputs to cents on save.
 * Tax rates are INTEGER BASIS POINTS server-side; this page converts % inputs to bp on save.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";
import MediaPickerModal from "../../../../../frontend/src/components/MediaPickerModal";

const B = "/plugin/online-store";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const inputSmCls = "w-full px-3 py-2 bg-gray-50/60 border-2 border-gray-100 rounded-xl focus:border-blue-500 focus:bg-white transition-all outline-none text-sm font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnGhostCls = "px-5 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnDangerCls = "px-4 py-2 bg-red-50 hover:bg-red-600 hover:text-white text-red-600 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all";
const btnMiniCls = "px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg font-black text-[10px] uppercase tracking-wider transition-all";
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
const PAYMENT_STATUSES = ["pending", "paid", "cancelled", "refunded"];
const PAY_LABELS = { pending: "Pendiente", paid: "Pagado", cancelled: "Cancelado", refunded: "Reembolsado" };
const PAY_PILL = { pending: "bg-amber-100 text-amber-700", paid: "bg-green-100 text-green-700", cancelled: "bg-gray-200 text-gray-500", refunded: "bg-rose-100 text-rose-700" };
const SHIP_LABELS = { pickup: "Recogida en tienda", zone: "Zona", flat: "Envío estándar", "": "Envío estándar" };

// Normalize a locale-typed number string: strip whitespace, treat a comma as either a thousands
// separator ("1,234.56" -> "1234.56") or a decimal comma ("1,50" -> "1.50"). Without this, the
// old `.replace(",", ".")` turned "1,234.56" into "1.234.56" -> parseFloat 1.234, silently saving
// money at ~1/1000 of the intended value.
const normalizeNumStr = (s) => {
    let str = String(s == null ? "" : s).trim().replace(/\s/g, "");
    if (str.includes(",") && str.includes(".")) str = str.replace(/,/g, "");
    else if (str.includes(",")) str = str.replace(/,/g, ".");
    return str;
};
// Decimal string -> integer cents (null when invalid).
const parseMoney = (s) => {
    const n = parseFloat(normalizeNumStr(s));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
};
const centsToInput = (cents) => ((Number(cents) || 0) / 100).toFixed(2);
// Percent string -> integer basis points (null when invalid).
const parsePercent = (s) => {
    const n = parseFloat(normalizeNumStr(s));
    if (!Number.isFinite(n) || n < 0 || n > 50) return null;
    return Math.round(n * 100);
};
const bpToInput = (bp) => {
    const n = (Number(bp) || 0) / 100;
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

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

const EMPTY_PRODUCT = { id: 0, name: "", price: "", description: "", image_url: "", category: "", stock: "", is_published: true, variants: [], images: [] };
const EMPTY_COUPON = { id: 0, code: "", type: "percent", value: "", minTotal: "", maxUses: "", is_active: true };
const EMPTY_ZONE = { id: 0, name: "", rate: "", freeOver: "", taxPercent: "", is_active: true };
const EMPTY_VARIANT = { id: 0, name: "", sku: "", price: "", stock: "", is_active: true };

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
    const [refundForm, setRefundForm] = useState(null); // { order, amount, restock }

    // ---- products state ----
    const [products, setProducts] = useState([]);
    const [productForm, setProductForm] = useState(null);
    const [mediaTarget, setMediaTarget] = useState(null); // 'cover' | 'gallery'

    // ---- coupons state ----
    const [coupons, setCoupons] = useState([]);
    const [couponForm, setCouponForm] = useState(null);

    // ---- shipping/taxes state ----
    const [zones, setZones] = useState([]);
    const [zoneForm, setZoneForm] = useState(null);
    const [shipCfgForm, setShipCfgForm] = useState(null); // pickup + taxes subset of config

    // ---- reports state ----
    const [reportDays, setReportDays] = useState(30);
    const [report, setReport] = useState(null);

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
            setShipCfgForm({
                pickupEnabled: !!c.pickupEnabled,
                pickupInstructions: c.pickupInstructions || "",
                taxPercent: c.taxRateBp > 0 ? bpToInput(c.taxRateBp) : "",
                taxLabel: c.taxLabel || "Impuestos",
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

    const loadZones = async () => {
        try {
            const d = await api(`${B}/shipping-zones`);
            setZones(d.zones || []);
        } catch (e) { flash(false, `Error al cargar zonas: ${e?.message || e}`); }
    };

    const loadReport = async (days = reportDays) => {
        try {
            const d = await api(`${B}/reports?days=${days}`);
            setReport(d);
        } catch (e) { flash(false, `Error al cargar el informe: ${e?.message || e}`); }
    };

    useEffect(() => { loadConfig(); loadOrders(); loadProducts(); loadCoupons(); loadZones(); }, []);
    useEffect(() => { if (tab === "reports") loadReport(reportDays); }, [tab, reportDays]);

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
    const submitRefund = async (e) => {
        e.preventDefault();
        const f = refundForm;
        const cents = parseMoney(f.amount);
        if (cents === null || cents < 1) { flash(false, "Importe de reembolso no válido."); return; }
        setBusy(true);
        try {
            const d = await apiPost(`${B}/orders/${f.order.id}/refund`, { amount_cents: cents, restock: !!f.restock });
            setRefundForm(null);
            setDetail(d.order);
            loadOrders();
            flash(true, d.refund_id ? `Reembolso emitido en Stripe (${d.refund_id}).` : "Reembolso registrado (pago manual: devuelve el dinero por tu canal).");
        } catch (err) { flash(false, `Error al reembolsar: ${err?.message || err}`); }
        finally { setBusy(false); }
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
    const exportReportCsv = async () => {
        setBusy(true);
        try {
            const d = await api(`${B}/reports/export?days=${reportDays}`);
            const blob = new Blob([d.csv || ""], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = d.filename || "informe.csv";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) { flash(false, `Error al exportar: ${e?.message || e}`); }
        finally { setBusy(false); }
    };

    // ---- products actions ----
    const openProductForm = (p) => {
        if (!p) { setProductForm({ ...EMPTY_PRODUCT, variants: [], images: [] }); return; }
        setProductForm({
            id: p.id, name: p.name, price: centsToInput(p.price_cents),
            description: p.description || "", image_url: p.image_url || "",
            category: p.category || "", stock: p.stock < 0 ? "" : String(p.stock),
            is_published: !!p.is_published,
            variants: (p.variants || []).map((v) => ({
                id: v.id, name: v.name, sku: v.sku || "",
                price: Number(v.price_cents) >= 0 ? centsToInput(v.price_cents) : "",
                stock: v.stock < 0 ? "" : String(v.stock),
                is_active: !!v.is_active,
            })),
            images: (p.images || []).map((im) => ({ url: im.url, alt: im.alt || "" })),
        });
    };
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
        const variants = [];
        for (const v of f.variants) {
            if (!String(v.name).trim()) continue;
            let vPrice = -1;
            if (String(v.price).trim() !== "") {
                vPrice = parseMoney(v.price);
                if (vPrice === null) { flash(false, `Precio no válido en la variante "${v.name}".`); return; }
            }
            let vStock = -1;
            if (String(v.stock).trim() !== "") {
                vStock = parseInt(v.stock, 10);
                if (!Number.isInteger(vStock) || vStock < -1) { flash(false, `Stock no válido en la variante "${v.name}".`); return; }
            }
            variants.push({ id: v.id || undefined, name: v.name, sku: v.sku, price_cents: vPrice, stock: vStock, is_active: !!v.is_active });
        }
        const images = f.images.filter((im) => String(im.url).trim()).map((im) => ({ url: im.url.trim(), alt: im.alt || "" }));
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
                variants,
                images,
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
    const setVariantField = (idx, field, value) => {
        const next = productForm.variants.slice();
        next[idx] = { ...next[idx], [field]: value };
        setProductForm({ ...productForm, variants: next });
    };
    const setImageField = (idx, field, value) => {
        const next = productForm.images.slice();
        next[idx] = { ...next[idx], [field]: value };
        setProductForm({ ...productForm, images: next });
    };
    const moveImage = (idx, dir) => {
        const next = productForm.images.slice();
        const j = idx + dir;
        if (j < 0 || j >= next.length) return;
        const tmp = next[idx]; next[idx] = next[j]; next[j] = tmp;
        setProductForm({ ...productForm, images: next });
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

    // ---- shipping/taxes actions ----
    const saveZone = async (e) => {
        e.preventDefault();
        const f = zoneForm;
        const rate = String(f.rate).trim() === "" ? 0 : parseMoney(f.rate);
        if (rate === null) { flash(false, "Tarifa no válida."); return; }
        const freeOver = String(f.freeOver).trim() === "" ? -1 : parseMoney(f.freeOver);
        if (freeOver === null) { flash(false, "El umbral de envío gratis no es válido."); return; }
        let taxBp = -1;
        if (String(f.taxPercent).trim() !== "") {
            taxBp = parsePercent(f.taxPercent);
            if (taxBp === null) { flash(false, "Impuesto no válido (0–50%)."); return; }
        }
        setBusy(true);
        try {
            await apiPost(`${B}/shipping-zones`, {
                id: f.id || undefined,
                name: f.name,
                rate_cents: rate,
                free_over_cents: freeOver,
                tax_rate_bp: taxBp,
                is_active: !!f.is_active,
            });
            setZoneForm(null);
            loadZones();
            flash(true, "Zona guardada.");
        } catch (err) { flash(false, `Error al guardar: ${err?.message || err}`); }
        finally { setBusy(false); }
    };
    const deleteZone = async (id) => {
        if (typeof window !== "undefined" && !window.confirm("¿Eliminar esta zona de envío?")) return;
        try {
            await apiDelete(`${B}/shipping-zones/${id}`);
            loadZones();
            flash(true, "Zona eliminada.");
        } catch (e) { flash(false, `Error: ${e?.message || e}`); }
    };
    const saveShipCfg = async (e) => {
        e.preventDefault();
        const f = shipCfgForm;
        let taxBp = 0;
        if (String(f.taxPercent).trim() !== "") {
            taxBp = parsePercent(f.taxPercent);
            if (taxBp === null) { flash(false, "Impuesto no válido (0–50%)."); return; }
        }
        setBusy(true);
        try {
            const c = await apiPost(`${B}/config`, {
                pickupEnabled: !!f.pickupEnabled,
                pickupInstructions: f.pickupInstructions,
                taxRateBp: taxBp,
                taxLabel: f.taxLabel || "Impuestos",
            });
            setCfg(c);
            flash(true, "Envío e impuestos guardados.");
        } catch (err) { flash(false, `Error al guardar: ${err?.message || err}`); }
        finally { setBusy(false); }
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

    const detailRemaining = detail ? Math.max(0, (Number(detail.total_cents) || 0) - (Number(detail.refund_cents) || 0)) : 0;

    const tabs = [
        { id: "orders", label: `Pedidos${ordersTotal ? ` (${ordersTotal})` : ""}` },
        { id: "products", label: "Productos" },
        { id: "coupons", label: "Cupones" },
        { id: "shipping", label: "Envío e impuestos" },
        { id: "reports", label: "Informes" },
        { id: "config", label: "Configuración" },
    ];

    return (
        <div className="max-w-6xl mx-auto p-4 sm:p-8">
            <div className="mb-8">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Tienda Online</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Variantes · zonas de envío · impuestos · reembolsos · informes · Stripe
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
                                        <th className="py-3 pr-4">Entrega</th>
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
                                            <td className="py-3 pr-4 text-xs text-gray-500">
                                                {o.shipping_method === "zone" ? (o.shipping_zone_name || "Zona") : SHIP_LABELS[o.shipping_method] || "Envío"}
                                            </td>
                                            <td className="py-3 pr-4 font-black">
                                                {fmt(o.total_cents)}
                                                {Number(o.refund_cents) > 0 && <div className="text-[10px] text-rose-500 font-bold">-{fmt(o.refund_cents)} dev.</div>}
                                            </td>
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
                        <button type="button" onClick={() => openProductForm(null)} className={btnCls}>Nuevo producto</button>
                    </div>
                    {products.length === 0 ? (
                        <p className="text-sm text-gray-400">Sin productos — crea el primero para que aparezca en el bloque OnlineStore.</p>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {products.map((p) => {
                                const activeVariants = (p.variants || []).filter((v) => v.is_active);
                                const totalStock = activeVariants.length
                                    ? (activeVariants.some((v) => v.stock < 0) ? -1 : activeVariants.reduce((s, v) => s + v.stock, 0))
                                    : p.stock;
                                return (
                                    <div key={p.id} className="border border-gray-100 rounded-2xl overflow-hidden flex flex-col">
                                        {p.image_url || (p.images && p.images[0]) ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img src={p.image_url || p.images[0].url} alt={p.name} className="w-full aspect-[4/3] object-cover bg-gray-50" decoding="async" />
                                        ) : (
                                            <div className="w-full aspect-[4/3] bg-gray-50 flex items-center justify-center text-gray-300 text-3xl">&#128722;</div>
                                        )}
                                        <div className="p-4 flex flex-col gap-1 flex-1">
                                            <div className="flex items-center gap-2">
                                                <span className="font-bold text-gray-800 flex-1 truncate">{p.name}</span>
                                                {!p.is_published && <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-400 text-[9px] font-black uppercase">Oculto</span>}
                                            </div>
                                            <div className="text-xs text-gray-400">
                                                {p.category || "Sin categoría"} · {totalStock < 0 ? "Stock ilimitado" : `Stock: ${totalStock}`}
                                                {activeVariants.length > 0 && ` · ${activeVariants.length} variante${activeVariants.length > 1 ? "s" : ""}`}
                                                {(p.images || []).length > 0 && ` · ${p.images.length} img`}
                                            </div>
                                            <div className="font-black text-gray-900 mt-1">{fmt(p.price_cents)}</div>
                                            <div className="flex gap-2 mt-3">
                                                <button type="button" onClick={() => openProductForm(p)} className={btnGhostCls.replace("px-5 py-3", "px-4 py-2") + " text-[10px]"}>
                                                    Editar
                                                </button>
                                                <button type="button" onClick={() => deleteProduct(p.id)} className={btnDangerCls}>Eliminar</button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
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

            {/* ============================ ENVÍO E IMPUESTOS ============================ */}
            {tab === "shipping" && (
                <div className="space-y-6">
                    <div className={cardCls}>
                        <div className="flex items-center justify-between mb-2">
                            <h2 className="font-bold text-gray-800">Zonas de envío ({zones.length})</h2>
                            <button type="button" onClick={() => setZoneForm({ ...EMPTY_ZONE })} className={btnCls}>Nueva zona</button>
                        </div>
                        <p className="text-xs text-gray-400 mb-6">
                            Con zonas activas, el cliente elige una en el checkout y su tarifa reemplaza el envío fijo de Configuración.
                            Sin zonas, se usa el envío fijo.
                        </p>
                        {zones.length === 0 ? (
                            <p className="text-sm text-gray-400">Sin zonas — se aplica el envío fijo de la pestaña Configuración.</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                            <th className="py-3 pr-4">Zona</th>
                                            <th className="py-3 pr-4">Tarifa</th>
                                            <th className="py-3 pr-4">Gratis desde</th>
                                            <th className="py-3 pr-4">Impuesto</th>
                                            <th className="py-3 pr-4">Activa</th>
                                            <th className="py-3"></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {zones.map((z) => (
                                            <tr key={z.id} className="border-b border-gray-50 hover:bg-gray-50/60">
                                                <td className="py-3 pr-4 font-bold text-gray-800">{z.name}</td>
                                                <td className="py-3 pr-4">{z.rate_cents > 0 ? fmt(z.rate_cents) : "Gratis"}</td>
                                                <td className="py-3 pr-4">{z.free_over_cents >= 0 ? fmt(z.free_over_cents) : "—"}</td>
                                                <td className="py-3 pr-4">{z.tax_rate_bp >= 0 ? `${bpToInput(z.tax_rate_bp)}%` : "Predeterminado"}</td>
                                                <td className="py-3 pr-4">
                                                    <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase ${z.is_active ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-500"}`}>
                                                        {z.is_active ? "Sí" : "No"}
                                                    </span>
                                                </td>
                                                <td className="py-3 text-right whitespace-nowrap">
                                                    <button
                                                        type="button"
                                                        onClick={() => setZoneForm({
                                                            id: z.id, name: z.name,
                                                            rate: z.rate_cents > 0 ? centsToInput(z.rate_cents) : "",
                                                            freeOver: z.free_over_cents >= 0 ? centsToInput(z.free_over_cents) : "",
                                                            taxPercent: z.tax_rate_bp >= 0 ? bpToInput(z.tax_rate_bp) : "",
                                                            is_active: !!z.is_active,
                                                        })}
                                                        className={btnGhostCls.replace("px-5 py-3", "px-4 py-2") + " text-[10px] mr-2"}
                                                    >
                                                        Editar
                                                    </button>
                                                    <button type="button" onClick={() => deleteZone(z.id)} className={btnDangerCls}>Eliminar</button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    {shipCfgForm && (
                        <form onSubmit={saveShipCfg} className={cardCls + " space-y-5"}>
                            <h2 className="font-bold text-gray-800">Recogida e impuestos</h2>
                            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                                <input type="checkbox" checked={!!shipCfgForm.pickupEnabled} onChange={(e) => setShipCfgForm({ ...shipCfgForm, pickupEnabled: e.target.checked })} />
                                Ofrecer recogida en tienda (sin costo de envío)
                            </label>
                            <div>
                                <label className={labelCls}>Instrucciones de recogida</label>
                                <textarea rows={2} value={shipCfgForm.pickupInstructions} onChange={(e) => setShipCfgForm({ ...shipCfgForm, pickupInstructions: e.target.value })} className={inputCls} maxLength={1000} />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className={labelCls}>Impuesto predeterminado (%)</label>
                                    <input type="text" inputMode="decimal" value={shipCfgForm.taxPercent} onChange={(e) => setShipCfgForm({ ...shipCfgForm, taxPercent: e.target.value })} placeholder="0 = sin impuesto" className={inputCls} />
                                    <p className="text-[11px] text-gray-400 mt-2">Se aplica sobre los productos (tras descuento), nunca sobre el envío. Cada zona puede definir su propio %.</p>
                                </div>
                                <div>
                                    <label className={labelCls}>Etiqueta del impuesto</label>
                                    <input type="text" value={shipCfgForm.taxLabel} onChange={(e) => setShipCfgForm({ ...shipCfgForm, taxLabel: e.target.value })} placeholder="IVA" className={inputCls} maxLength={50} />
                                </div>
                            </div>
                            <div className="flex justify-end">
                                <button type="submit" disabled={busy} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                            </div>
                        </form>
                    )}
                </div>
            )}

            {/* ============================ INFORMES ============================ */}
            {tab === "reports" && (
                <div className="space-y-6">
                    <div className="flex flex-wrap items-center gap-3">
                        {[30, 90, 365].map((d) => (
                            <button
                                key={d}
                                type="button"
                                onClick={() => setReportDays(d)}
                                className={`px-4 py-2 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${reportDays === d ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
                            >
                                {d === 365 ? "12 meses" : `${d} días`}
                            </button>
                        ))}
                        <div className="flex-1" />
                        <button type="button" onClick={exportReportCsv} disabled={busy || !report} className={btnCls}>Exportar CSV</button>
                    </div>

                    {!report ? (
                        <p className="text-sm text-gray-400">Cargando informe…</p>
                    ) : (
                        <>
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                {[
                                    { label: "Ingresos", value: fmt(report.totals.revenue_cents), sub: `${report.totals.paid_orders} pedidos pagados` },
                                    { label: "Neto (tras reembolsos)", value: fmt(report.totals.net_cents), sub: `-${fmt(report.totals.refunds_cents)} reembolsado` },
                                    { label: "Ticket medio", value: fmt(report.totals.avg_order_cents), sub: `${report.totals.items_sold} artículos` },
                                    { label: "Pedidos", value: String(report.totals.orders), sub: `${fmt(report.totals.discount_cents)} en descuentos` },
                                ].map((s) => (
                                    <div key={s.label} className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-5">
                                        <div className="text-[10px] font-black uppercase tracking-widest text-gray-400">{s.label}</div>
                                        <div className="text-2xl font-black text-gray-900 mt-1">{s.value}</div>
                                        <div className="text-[11px] text-gray-400 mt-1">{s.sub}</div>
                                    </div>
                                ))}
                            </div>

                            <div className={cardCls}>
                                <h3 className="font-bold text-gray-800 mb-1">Ingresos por {report.granularity === "month" ? "mes" : "día"}</h3>
                                <p className="text-[11px] text-gray-400 mb-4">Impuestos: {fmt(report.totals.tax_cents)} · Envíos: {fmt(report.totals.shipping_cents)}{report.truncated ? " · (ventana truncada a los últimos 5000 pedidos)" : ""}</p>
                                {(() => {
                                    const max = Math.max(1, ...report.series.map((b) => b.revenue_cents));
                                    return (
                                        <div className="flex items-end gap-[2px] h-40 overflow-x-auto pb-6">
                                            {report.series.map((b) => (
                                                <div key={b.date} className="flex-1 min-w-[8px] flex flex-col items-center justify-end h-full group relative">
                                                    <div
                                                        className="w-full rounded-t-md bg-blue-500/80 hover:bg-blue-600 transition-all"
                                                        style={{ height: `${Math.max(b.revenue_cents > 0 ? 4 : 1, Math.round((b.revenue_cents / max) * 100))}%` }}
                                                        title={`${b.date}: ${fmt(b.revenue_cents)} (${b.orders} pedidos)`}
                                                    />
                                                    {report.series.length <= 32 && (
                                                        <div className="absolute -bottom-5 text-[8px] text-gray-400 font-bold whitespace-nowrap">{b.date.slice(5)}</div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    );
                                })()}
                            </div>

                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                <div className={cardCls}>
                                    <h3 className="font-bold text-gray-800 mb-4">Productos más vendidos</h3>
                                    {report.topProducts.length === 0 ? (
                                        <p className="text-sm text-gray-400">Sin ventas pagadas en el periodo.</p>
                                    ) : (
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                                    <th className="py-2 pr-4">Producto</th>
                                                    <th className="py-2 pr-4">Uds.</th>
                                                    <th className="py-2 text-right">Ingresos</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {report.topProducts.map((p, i) => (
                                                    <tr key={i} className="border-b border-gray-50">
                                                        <td className="py-2 pr-4 font-medium text-gray-800">{p.name}</td>
                                                        <td className="py-2 pr-4 text-gray-500">{p.qty}</td>
                                                        <td className="py-2 text-right font-bold">{fmt(p.revenue_cents)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    )}
                                </div>
                                <div className={cardCls}>
                                    <h3 className="font-bold text-gray-800 mb-4">Cupones usados</h3>
                                    {report.couponUsage.length === 0 ? (
                                        <p className="text-sm text-gray-400">Sin cupones en el periodo.</p>
                                    ) : (
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                                    <th className="py-2 pr-4">Cupón</th>
                                                    <th className="py-2 pr-4">Usos</th>
                                                    <th className="py-2 text-right">Descuento</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {report.couponUsage.map((c) => (
                                                    <tr key={c.code} className="border-b border-gray-50">
                                                        <td className="py-2 pr-4 font-mono font-bold">{c.code}</td>
                                                        <td className="py-2 pr-4 text-gray-500">{c.uses}</td>
                                                        <td className="py-2 text-right font-bold">-{fmt(c.discount_cents)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    )}
                                </div>
                            </div>
                        </>
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
                            <p className="text-[11px] text-gray-400 mt-2">Solo aplica cuando no hay zonas de envío activas.</p>
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
                            "Tarjeta (Stripe)" y los reembolsos de tarjeta se emiten desde el pedido. <strong>Webhook (opcional):</strong> apunta
                            un endpoint de Stripe a <span className="font-mono">/api/v1/plugin/online-store/public/stripe-webhook</span> — cada
                            evento se re-verifica contra la API de Stripe antes de tocar el pedido, y un reconciliador revisa
                            los pagos pendientes cada 5 minutos aunque no configures webhook.
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
                            {Number(detail.user_id) > 0 && <div className="text-[11px] text-blue-500 font-bold mt-1">Cliente con cuenta (#{detail.user_id})</div>}
                        </div>
                        <div>
                            <div className={labelCls}>Pedido</div>
                            <div className="text-gray-500">Fecha: {String(detail.created_at || "").slice(0, 16)}</div>
                            <div className="text-gray-500">Código: <span className="font-mono text-xs">{detail.token}</span></div>
                            <div className="text-gray-500">Método: {detail.payment_method === "stripe" ? "Tarjeta (Stripe)" : "Pago manual"}</div>
                            <div className="text-gray-500">
                                Entrega: {detail.shipping_method === "zone" ? `Zona — ${detail.shipping_zone_name || ""}` : SHIP_LABELS[detail.shipping_method] || "Envío"}
                            </div>
                            {detail.coupon_code && <div className="text-gray-500">Cupón: <span className="font-mono">{detail.coupon_code}</span></div>}
                            {detail.refund_id && <div className="text-gray-500">Reembolso Stripe: <span className="font-mono text-xs">{detail.refund_id}</span></div>}
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
                                        <td className="py-2 pr-4 font-medium text-gray-800">
                                            {i.name}
                                            {i.variant_name && <span className="text-gray-400"> ({i.variant_name})</span>}
                                            {i.sku && <div className="text-[10px] text-gray-400 font-mono">{i.sku}</div>}
                                        </td>
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
                        {Number(detail.tax_cents) > 0 && (
                            <div className="flex justify-between text-gray-500"><span>{(cfg && cfg.taxLabel) || "Impuestos"} ({bpToInput(detail.tax_rate_bp)}%)</span><span>{fmt(detail.tax_cents)}</span></div>
                        )}
                        <div className="flex justify-between font-black text-gray-900 text-base"><span>Total</span><span>{fmt(detail.total_cents)}</span></div>
                        {Number(detail.refund_cents) > 0 && (
                            <div className="flex justify-between text-rose-600 font-bold"><span>Reembolsado</span><span>-{fmt(detail.refund_cents)}</span></div>
                        )}
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

                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <button type="button" onClick={() => deleteOrder(detail.id)} className={btnDangerCls}>Eliminar pedido</button>
                        <div className="flex gap-3">
                            {(detail.payment_status === "paid" || detail.payment_status === "refunded") && detailRemaining > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setRefundForm({ order: detail, amount: centsToInput(detailRemaining), restock: false })}
                                    className={btnGhostCls}
                                >
                                    Reembolsar…
                                </button>
                            )}
                            <button type="button" onClick={() => setDetail(null)} className={btnGhostCls}>Cerrar</button>
                        </div>
                    </div>
                </Modal>
            )}

            {/* ============================ MODAL: REEMBOLSO ============================ */}
            {refundForm && (
                <Modal title={`Reembolsar pedido #${refundForm.order.id}`} onClose={() => setRefundForm(null)}>
                    <form onSubmit={submitRefund} className="space-y-4">
                        <p className="text-sm text-gray-500">
                            {refundForm.order.payment_method === "stripe"
                                ? "Se emitirá un reembolso REAL en Stripe al medio de pago original."
                                : "Pago manual: el reembolso se registra en el pedido y deberás devolver el dinero por tu canal."}
                        </p>
                        <div>
                            <label className={labelCls}>Importe a reembolsar ({symbol}) — máx. {fmt(Math.max(0, refundForm.order.total_cents - (refundForm.order.refund_cents || 0)))}</label>
                            <input type="text" inputMode="decimal" value={refundForm.amount} onChange={(e) => setRefundForm({ ...refundForm, amount: e.target.value })} className={inputCls} required />
                        </div>
                        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                            <input type="checkbox" checked={!!refundForm.restock} onChange={(e) => setRefundForm({ ...refundForm, restock: e.target.checked })} />
                            Devolver artículos al inventario y cancelar el pedido
                        </label>
                        <div className="flex justify-end gap-3">
                            <button type="button" onClick={() => setRefundForm(null)} className={btnGhostCls}>Cancelar</button>
                            <button type="submit" disabled={busy} className={btnCls}>{busy ? "Procesando…" : "Emitir reembolso"}</button>
                        </div>
                    </form>
                </Modal>
            )}

            {/* ============================ MODAL: PRODUCTO ============================ */}
            {productForm && (
                <Modal title={productForm.id ? "Editar producto" : "Nuevo producto"} onClose={() => setProductForm(null)} wide>
                    <form onSubmit={saveProduct} className="space-y-4">
                        <div>
                            <label className={labelCls}>Nombre *</label>
                            <input type="text" value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} className={inputCls} required maxLength={200} />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelCls}>Precio base ({symbol}) *</label>
                                <input type="text" inputMode="decimal" value={productForm.price} onChange={(e) => setProductForm({ ...productForm, price: e.target.value })} placeholder="19.99" className={inputCls} required />
                            </div>
                            <div>
                                <label className={labelCls}>Stock (vacío = ilimitado)</label>
                                <input type="text" inputMode="numeric" value={productForm.stock} onChange={(e) => setProductForm({ ...productForm, stock: e.target.value })} placeholder="∞" className={inputCls} disabled={productForm.variants.some((v) => String(v.name).trim() && v.is_active)} />
                                {productForm.variants.some((v) => String(v.name).trim() && v.is_active) && (
                                    <p className="text-[11px] text-gray-400 mt-1">Con variantes activas, el stock se controla por variante.</p>
                                )}
                            </div>
                        </div>
                        <div>
                            <label className={labelCls}>Descripción</label>
                            <textarea rows={3} value={productForm.description} onChange={(e) => setProductForm({ ...productForm, description: e.target.value })} className={inputCls} maxLength={5000} />
                        </div>
                        <div>
                            <label className={labelCls}>Imagen principal</label>
                            <div className="flex gap-2">
                                <input type="text" value={productForm.image_url} onChange={(e) => setProductForm({ ...productForm, image_url: e.target.value })} placeholder="/uploads/2026/07/producto.jpg" className={inputCls} maxLength={1000} />
                                <button type="button" onClick={() => setMediaTarget("cover")} className={btnGhostCls + " whitespace-nowrap"}>Elegir…</button>
                            </div>
                        </div>

                        {/* ---- gallery ---- */}
                        <div className="pt-2 border-t border-gray-100">
                            <div className="flex items-center justify-between mb-2">
                                <label className={labelCls + " mb-0"}>Galería ({productForm.images.length}/12)</label>
                                <div className="flex gap-2">
                                    <button type="button" onClick={() => setMediaTarget("gallery")} disabled={productForm.images.length >= 12} className={btnMiniCls}>+ Biblioteca</button>
                                    <button type="button" onClick={() => setProductForm({ ...productForm, images: [...productForm.images, { url: "", alt: "" }] })} disabled={productForm.images.length >= 12} className={btnMiniCls}>+ URL</button>
                                </div>
                            </div>
                            {productForm.images.length === 0 ? (
                                <p className="text-xs text-gray-400">Sin imágenes adicionales — la ficha del producto mostrará solo la imagen principal.</p>
                            ) : (
                                <div className="space-y-2">
                                    {productForm.images.map((im, idx) => (
                                        <div key={idx} className="flex items-center gap-2">
                                            {im.url ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img src={im.url} alt="" className="w-10 h-10 rounded-lg object-cover bg-gray-50 flex-shrink-0" />
                                            ) : (
                                                <div className="w-10 h-10 rounded-lg bg-gray-50 flex-shrink-0" />
                                            )}
                                            <input type="text" value={im.url} onChange={(e) => setImageField(idx, "url", e.target.value)} placeholder="/uploads/…" className={inputSmCls} />
                                            <input type="text" value={im.alt} onChange={(e) => setImageField(idx, "alt", e.target.value)} placeholder="Texto alt" className={inputSmCls + " max-w-[130px]"} />
                                            <button type="button" onClick={() => moveImage(idx, -1)} disabled={idx === 0} className={btnMiniCls}>↑</button>
                                            <button type="button" onClick={() => moveImage(idx, 1)} disabled={idx === productForm.images.length - 1} className={btnMiniCls}>↓</button>
                                            <button type="button" onClick={() => setProductForm({ ...productForm, images: productForm.images.filter((_, i) => i !== idx) })} className={btnDangerCls}>&#215;</button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* ---- variants ---- */}
                        <div className="pt-2 border-t border-gray-100">
                            <div className="flex items-center justify-between mb-2">
                                <label className={labelCls + " mb-0"}>Variantes ({productForm.variants.length}/40)</label>
                                <button
                                    type="button"
                                    onClick={() => setProductForm({ ...productForm, variants: [...productForm.variants, { ...EMPTY_VARIANT }] })}
                                    disabled={productForm.variants.length >= 40}
                                    className={btnMiniCls}
                                >
                                    + Variante
                                </button>
                            </div>
                            {productForm.variants.length === 0 ? (
                                <p className="text-xs text-gray-400">Sin variantes — el producto se vende con el precio y stock base. Añade variantes para tallas, colores, etc.</p>
                            ) : (
                                <div className="space-y-2">
                                    <div className="grid grid-cols-[1fr_90px_80px_70px_60px_34px] gap-2 text-[9px] font-black uppercase tracking-widest text-gray-400 px-1">
                                        <span>Nombre (p. ej. Talla M)</span><span>SKU</span><span>Precio</span><span>Stock</span><span>Activa</span><span></span>
                                    </div>
                                    {productForm.variants.map((v, idx) => (
                                        <div key={idx} className="grid grid-cols-[1fr_90px_80px_70px_60px_34px] gap-2 items-center">
                                            <input type="text" value={v.name} onChange={(e) => setVariantField(idx, "name", e.target.value)} placeholder="Talla M / Rojo" className={inputSmCls} maxLength={120} />
                                            <input type="text" value={v.sku} onChange={(e) => setVariantField(idx, "sku", e.target.value)} placeholder="SKU" className={inputSmCls} maxLength={60} />
                                            <input type="text" inputMode="decimal" value={v.price} onChange={(e) => setVariantField(idx, "price", e.target.value)} placeholder="base" className={inputSmCls} title="Vacío = usa el precio base del producto" />
                                            <input type="text" inputMode="numeric" value={v.stock} onChange={(e) => setVariantField(idx, "stock", e.target.value)} placeholder="∞" className={inputSmCls} />
                                            <input type="checkbox" checked={!!v.is_active} onChange={(e) => setVariantField(idx, "is_active", e.target.checked)} className="justify-self-center" />
                                            <button type="button" onClick={() => setProductForm({ ...productForm, variants: productForm.variants.filter((_, i) => i !== idx) })} className={btnDangerCls + " justify-self-center"}>&#215;</button>
                                        </div>
                                    ))}
                                    <p className="text-[11px] text-gray-400">Precio vacío = usa el precio base. Stock vacío = ilimitado. El stock se descuenta por variante al vender.</p>
                                </div>
                            )}
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

            {/* ============================ MODAL: ZONA DE ENVÍO ============================ */}
            {zoneForm && (
                <Modal title={zoneForm.id ? "Editar zona" : "Nueva zona de envío"} onClose={() => setZoneForm(null)}>
                    <form onSubmit={saveZone} className="space-y-4">
                        <div>
                            <label className={labelCls}>Nombre de la zona *</label>
                            <input type="text" value={zoneForm.name} onChange={(e) => setZoneForm({ ...zoneForm, name: e.target.value })} placeholder="Nacional, CDMX, Internacional…" className={inputCls} required maxLength={100} />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelCls}>Tarifa ({symbol})</label>
                                <input type="text" inputMode="decimal" value={zoneForm.rate} onChange={(e) => setZoneForm({ ...zoneForm, rate: e.target.value })} placeholder="0 = gratis" className={inputCls} />
                            </div>
                            <div>
                                <label className={labelCls}>Gratis desde ({symbol}, vacío = nunca)</label>
                                <input type="text" inputMode="decimal" value={zoneForm.freeOver} onChange={(e) => setZoneForm({ ...zoneForm, freeOver: e.target.value })} placeholder="100.00" className={inputCls} />
                            </div>
                        </div>
                        <div>
                            <label className={labelCls}>Impuesto de la zona (%, vacío = predeterminado)</label>
                            <input type="text" inputMode="decimal" value={zoneForm.taxPercent} onChange={(e) => setZoneForm({ ...zoneForm, taxPercent: e.target.value })} placeholder="16" className={inputCls} />
                        </div>
                        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                            <input type="checkbox" checked={!!zoneForm.is_active} onChange={(e) => setZoneForm({ ...zoneForm, is_active: e.target.checked })} />
                            Activa (visible en el checkout)
                        </label>
                        <div className="flex justify-end gap-3">
                            <button type="button" onClick={() => setZoneForm(null)} className={btnGhostCls}>Cancelar</button>
                            <button type="submit" disabled={busy} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                        </div>
                    </form>
                </Modal>
            )}

            {/* ============================ MEDIA PICKER ============================ */}
            <MediaPickerModal
                isOpen={!!mediaTarget}
                onClose={() => setMediaTarget(null)}
                onSelect={(item) => {
                    const url = (item && (item.sourceUrl || item.source_url)) || "";
                    if (!url || !productForm) { setMediaTarget(null); return; }
                    if (mediaTarget === "cover") {
                        setProductForm({ ...productForm, image_url: url });
                    } else if (mediaTarget === "gallery" && productForm.images.length < 12) {
                        setProductForm({ ...productForm, images: [...productForm.images, { url, alt: "" }] });
                    }
                    setMediaTarget(null);
                }}
            />
        </div>
    );
}
