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
import { useT } from "./i18n";

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
const STATUS_LABELS = { new: "status.new", processing: "status.processing", shipped: "status.shipped", completed: "status.completed", cancelled: "status.cancelled" };
const STATUS_PILL = {
    new: "bg-blue-100 text-blue-700",
    processing: "bg-amber-100 text-amber-700",
    shipped: "bg-purple-100 text-purple-700",
    completed: "bg-green-100 text-green-700",
    cancelled: "bg-gray-200 text-gray-500",
};
const PAYMENT_STATUSES = ["pending", "paid", "cancelled", "refunded"];
const PAY_LABELS = { pending: "pay.pending", paid: "pay.paid", cancelled: "pay.cancelled", refunded: "pay.refunded" };
const PAY_PILL = { pending: "bg-amber-100 text-amber-700", paid: "bg-green-100 text-green-700", cancelled: "bg-gray-200 text-gray-500", refunded: "bg-rose-100 text-rose-700" };
const SHIP_LABELS = { pickup: "ship.pickup", zone: "ship.zone", flat: "ship.flat", "": "ship.flat" };

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
    const { t } = useT();
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-gray-900/50" onClick={onClose} />
            <div className={`relative bg-white rounded-3xl shadow-2xl w-full ${wide ? "max-w-3xl" : "max-w-lg"} max-h-[90vh] overflow-y-auto p-6 sm:p-8`}>
                <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-black text-gray-900 tracking-tight">{title}</h3>
                    <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none font-bold" aria-label={t("common.close")}>&#215;</button>
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
    const { t } = useT();
    // Label maps hold i18n keys; unknown values render as received.
    const statusLabel = (s) => (STATUS_LABELS[s] ? t(STATUS_LABELS[s]) : s);
    const payLabel = (s) => (PAY_LABELS[s] ? t(PAY_LABELS[s]) : s);
    const shipLabel = (m) => (SHIP_LABELS[m] ? t(SHIP_LABELS[m]) : t("ship.fallback"));
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
                cardPendingTtlMinutes: String(c.cardPendingTtlMinutes ?? 60),
                manualPendingTtlHours: String(c.manualPendingTtlHours ?? 72),
                maxLineQty: String(c.maxLineQty ?? 99),
                maxOrderQty: String(c.maxOrderQty ?? 100),
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
        } catch (e) { flash(false, t("err.loadOrders", { msg: e?.message || e })); }
    };

    const loadProducts = async () => {
        try {
            const d = await api(`${B}/products`);
            setProducts(d.products || []);
        } catch (e) { flash(false, t("err.loadProducts", { msg: e?.message || e })); }
    };

    const loadCoupons = async () => {
        try {
            const d = await api(`${B}/coupons`);
            setCoupons(d.coupons || []);
        } catch (e) { flash(false, t("err.loadCoupons", { msg: e?.message || e })); }
    };

    const loadZones = async () => {
        try {
            const d = await api(`${B}/shipping-zones`);
            setZones(d.zones || []);
        } catch (e) { flash(false, t("err.loadZones", { msg: e?.message || e })); }
    };

    const loadReport = async (days = reportDays) => {
        try {
            const d = await api(`${B}/reports?days=${days}`);
            setReport(d);
        } catch (e) { flash(false, t("err.loadReport", { msg: e?.message || e })); }
    };

    useEffect(() => { loadConfig(); loadOrders(); loadProducts(); loadCoupons(); loadZones(); }, []);
    useEffect(() => { if (tab === "reports") loadReport(reportDays); }, [tab, reportDays]);

    // ---- orders actions ----
    const applyOrderStatus = async (id, status) => {
        try {
            const d = await apiPost(`${B}/orders/${id}/status`, { status });
            setDetail(d.order);
            loadOrders();
        } catch (e) { flash(false, t("common.error", { msg: e?.message || e })); }
    };
    const applyPaymentStatus = async (id, payment_status) => {
        try {
            const d = await apiPost(`${B}/orders/${id}/payment`, { payment_status });
            setDetail(d.order);
            loadOrders();
            if (payment_status === "paid") flash(true, t("msg.paidReceipt"));
        } catch (e) { flash(false, t("common.error", { msg: e?.message || e })); }
    };
    const deleteOrder = async (id) => {
        if (typeof window !== "undefined" && !window.confirm(t("confirm.deleteOrder"))) return;
        try {
            await apiDelete(`${B}/orders/${id}`);
            setDetail(null);
            loadOrders();
            flash(true, t("msg.orderDeleted"));
        } catch (e) { flash(false, t("common.error", { msg: e?.message || e })); }
    };
    const submitRefund = async (e) => {
        e.preventDefault();
        const f = refundForm;
        const cents = parseMoney(f.amount);
        if (cents === null || cents < 1) { flash(false, t("err.refundAmount")); return; }
        setBusy(true);
        try {
            const d = await apiPost(`${B}/orders/${f.order.id}/refund`, { amount_cents: cents, restock: !!f.restock });
            setRefundForm(null);
            setDetail(d.order);
            loadOrders();
            flash(true, d.refund_id ? t("msg.refundStripe", { id: d.refund_id }) : t("msg.refundManual"));
        } catch (err) { flash(false, t("err.refund", { msg: err?.message || err })); }
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
            a.download = d.filename || t("csv.orders");
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) { flash(false, t("common.exportError", { msg: e?.message || e })); }
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
            a.download = d.filename || t("csv.report");
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) { flash(false, t("common.exportError", { msg: e?.message || e })); }
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
        if (cents === null) { flash(false, t("err.price")); return; }
        let stock = -1;
        if (String(f.stock).trim() !== "") {
            stock = parseInt(f.stock, 10);
            if (!Number.isInteger(stock) || stock < -1) { flash(false, t("err.stock")); return; }
        }
        const variants = [];
        for (const v of f.variants) {
            if (!String(v.name).trim()) continue;
            let vPrice = -1;
            if (String(v.price).trim() !== "") {
                vPrice = parseMoney(v.price);
                if (vPrice === null) { flash(false, t("err.variantPrice", { name: v.name })); return; }
            }
            let vStock = -1;
            if (String(v.stock).trim() !== "") {
                vStock = parseInt(v.stock, 10);
                if (!Number.isInteger(vStock) || vStock < -1) { flash(false, t("err.variantStock", { name: v.name })); return; }
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
            flash(true, t("msg.productSaved"));
        } catch (err) { flash(false, t("common.saveError", { msg: err?.message || err })); }
        finally { setBusy(false); }
    };
    const deleteProduct = async (id) => {
        if (typeof window !== "undefined" && !window.confirm(t("confirm.deleteProduct"))) return;
        try {
            await apiDelete(`${B}/products/${id}`);
            loadProducts();
            flash(true, t("msg.productDeleted"));
        } catch (e) { flash(false, t("common.error", { msg: e?.message || e })); }
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
            if (!Number.isInteger(value) || value < 1 || value > 100) { flash(false, t("err.couponPercent")); return; }
        } else {
            value = parseMoney(f.value);
            if (value === null || value < 1) { flash(false, t("err.couponAmount")); return; }
        }
        const minTotal = String(f.minTotal).trim() === "" ? 0 : parseMoney(f.minTotal);
        if (minTotal === null) { flash(false, t("err.couponMin")); return; }
        let maxUses = -1;
        if (String(f.maxUses).trim() !== "") {
            maxUses = parseInt(f.maxUses, 10);
            if (!Number.isInteger(maxUses) || maxUses < -1) { flash(false, t("err.couponMaxUses")); return; }
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
            flash(true, t("msg.couponSaved"));
        } catch (err) { flash(false, t("common.saveError", { msg: err?.message || err })); }
        finally { setBusy(false); }
    };
    const deleteCoupon = async (id) => {
        if (typeof window !== "undefined" && !window.confirm(t("confirm.deleteCoupon"))) return;
        try {
            await apiDelete(`${B}/coupons/${id}`);
            loadCoupons();
            flash(true, t("msg.couponDeleted"));
        } catch (e) { flash(false, t("common.error", { msg: e?.message || e })); }
    };

    // ---- shipping/taxes actions ----
    const saveZone = async (e) => {
        e.preventDefault();
        const f = zoneForm;
        const rate = String(f.rate).trim() === "" ? 0 : parseMoney(f.rate);
        if (rate === null) { flash(false, t("err.rate")); return; }
        const freeOver = String(f.freeOver).trim() === "" ? -1 : parseMoney(f.freeOver);
        if (freeOver === null) { flash(false, t("err.freeOver")); return; }
        let taxBp = -1;
        if (String(f.taxPercent).trim() !== "") {
            taxBp = parsePercent(f.taxPercent);
            if (taxBp === null) { flash(false, t("err.tax")); return; }
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
            flash(true, t("msg.zoneSaved"));
        } catch (err) { flash(false, t("common.saveError", { msg: err?.message || err })); }
        finally { setBusy(false); }
    };
    const deleteZone = async (id) => {
        if (typeof window !== "undefined" && !window.confirm(t("confirm.deleteZone"))) return;
        try {
            await apiDelete(`${B}/shipping-zones/${id}`);
            loadZones();
            flash(true, t("msg.zoneDeleted"));
        } catch (e) { flash(false, t("common.error", { msg: e?.message || e })); }
    };
    const saveShipCfg = async (e) => {
        e.preventDefault();
        const f = shipCfgForm;
        let taxBp = 0;
        if (String(f.taxPercent).trim() !== "") {
            taxBp = parsePercent(f.taxPercent);
            if (taxBp === null) { flash(false, t("err.tax")); return; }
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
            flash(true, t("msg.shipSaved"));
        } catch (err) { flash(false, t("common.saveError", { msg: err?.message || err })); }
        finally { setBusy(false); }
    };

    // ---- config actions ----
    const saveConfig = async (e) => {
        e.preventDefault();
        const f = cfgForm;
        const shippingCents = String(f.shipping).trim() === "" ? 0 : parseMoney(f.shipping);
        if (shippingCents === null) { flash(false, t("err.shipping")); return; }
        setBusy(true);
        try {
            const c = await apiPost(`${B}/config`, {
                currencySymbol: f.currencySymbol,
                currencyCode: f.currencyCode,
                shippingCents,
                manualPaymentInstructions: f.manualPaymentInstructions,
                storeEmail: f.storeEmail,
                cardPendingTtlMinutes: String(f.cardPendingTtlMinutes ?? "").trim() === "" ? undefined : Number(f.cardPendingTtlMinutes),
                manualPendingTtlHours: String(f.manualPendingTtlHours ?? "").trim() === "" ? undefined : Number(f.manualPendingTtlHours),
                maxLineQty: String(f.maxLineQty ?? "").trim() === "" ? undefined : Number(f.maxLineQty),
                maxOrderQty: String(f.maxOrderQty ?? "").trim() === "" ? undefined : Number(f.maxOrderQty),
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
            flash(true, t("msg.configSaved"));
        } catch (err) { flash(false, t("common.saveError", { msg: err?.message || err })); }
        finally { setBusy(false); }
    };

    const detailRemaining = detail ? Math.max(0, (Number(detail.total_cents) || 0) - (Number(detail.refund_cents) || 0)) : 0;

    const tabs = [
        { id: "orders", label: ordersTotal ? t("tab.ordersCount", { n: ordersTotal }) : t("tab.orders") },
        { id: "products", label: t("tab.products") },
        { id: "coupons", label: t("tab.coupons") },
        { id: "shipping", label: t("tab.shipping") },
        { id: "reports", label: t("tab.reports") },
        { id: "config", label: t("tab.config") },
    ];

    return (
        <div className="max-w-6xl mx-auto p-4 sm:p-8">
            <div className="mb-8">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">{t("app.title")}</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    {t("app.subtitle")}
                </p>
            </div>

            <div className="flex flex-wrap gap-2 mb-6">
                {tabs.map((tb) => (
                    <button
                        key={tb.id}
                        type="button"
                        onClick={() => { setTab(tb.id); setMsg(null); }}
                        className={`px-4 py-2 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${tab === tb.id ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
                    >
                        {tb.label}
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
                            <option value="">{t("orders.allStatuses")}</option>
                            {ORDER_STATUSES.map((s) => (
                                <option key={s} value={s}>{statusLabel(s)}{counts[s] ? ` (${counts[s]})` : ""}</option>
                            ))}
                        </select>
                        <input
                            type="search"
                            placeholder={t("orders.searchPlaceholder")}
                            value={orderSearch}
                            onChange={(e) => setOrderSearch(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") loadOrders(statusFilter, orderSearch); }}
                            className="flex-1 min-w-[200px] px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl font-medium outline-none"
                        />
                        <button type="button" onClick={() => loadOrders(statusFilter, orderSearch)} className={btnGhostCls}>{t("orders.search")}</button>
                        <button type="button" onClick={exportCsv} disabled={busy} className={btnCls}>{t("common.exportCsv")}</button>
                    </div>

                    {orders.length === 0 ? (
                        <p className="text-sm text-gray-400">{t("orders.empty")}</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                        <th className="py-3 pr-4">#</th>
                                        <th className="py-3 pr-4">{t("orders.colDate")}</th>
                                        <th className="py-3 pr-4">{t("orders.colCustomer")}</th>
                                        <th className="py-3 pr-4">{t("orders.colDelivery")}</th>
                                        <th className="py-3 pr-4">{t("orders.colTotal")}</th>
                                        <th className="py-3 pr-4">{t("orders.colPayment")}</th>
                                        <th className="py-3 pr-4">{t("orders.colStatus")}</th>
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
                                                {o.shipping_method === "zone" ? (o.shipping_zone_name || t("ship.zone")) : shipLabel(o.shipping_method)}
                                            </td>
                                            <td className="py-3 pr-4 font-black">
                                                {fmt(o.total_cents)}
                                                {Number(o.refund_cents) > 0 && <div className="text-[10px] text-rose-500 font-bold">{t("orders.refundedShort", { amount: fmt(o.refund_cents) })}</div>}
                                            </td>
                                            <td className="py-3 pr-4">
                                                <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ${PAY_PILL[o.payment_status] || "bg-gray-100 text-gray-500"}`}>
                                                    {payLabel(o.payment_status)}
                                                </span>
                                            </td>
                                            <td className="py-3 pr-4">
                                                <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ${STATUS_PILL[o.status] || "bg-gray-100 text-gray-500"}`}>
                                                    {statusLabel(o.status)}
                                                </span>
                                            </td>
                                            <td className="py-3 text-right">
                                                <button type="button" onClick={() => setDetail(o)} className={btnGhostCls.replace("px-5 py-3", "px-4 py-2") + " text-[10px]"}>{t("orders.view")}</button>
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
                        <h2 className="font-bold text-gray-800">{t("products.title", { n: products.length })}</h2>
                        <button type="button" onClick={() => openProductForm(null)} className={btnCls}>{t("products.new")}</button>
                    </div>
                    {products.length === 0 ? (
                        <p className="text-sm text-gray-400">{t("products.empty")}</p>
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
                                                {!p.is_published && <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-400 text-[9px] font-black uppercase">{t("products.hidden")}</span>}
                                            </div>
                                            <div className="text-xs text-gray-400">
                                                {p.category || t("products.noCategory")} · {totalStock < 0 ? t("products.unlimitedStock") : t("products.stock", { n: totalStock })}
                                                {activeVariants.length > 0 && t(activeVariants.length > 1 ? "products.variantMany" : "products.variantOne", { n: activeVariants.length })}
                                                {(p.images || []).length > 0 && t("products.images", { n: p.images.length })}
                                            </div>
                                            <div className="font-black text-gray-900 mt-1">{fmt(p.price_cents)}</div>
                                            <div className="flex gap-2 mt-3">
                                                <button type="button" onClick={() => openProductForm(p)} className={btnGhostCls.replace("px-5 py-3", "px-4 py-2") + " text-[10px]"}>
                                                    {t("common.edit")}
                                                </button>
                                                <button type="button" onClick={() => deleteProduct(p.id)} className={btnDangerCls}>{t("common.delete")}</button>
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
                        <h2 className="font-bold text-gray-800">{t("coupons.title", { n: coupons.length })}</h2>
                        <button type="button" onClick={() => setCouponForm({ ...EMPTY_COUPON })} className={btnCls}>{t("coupons.new")}</button>
                    </div>
                    {coupons.length === 0 ? (
                        <p className="text-sm text-gray-400">{t("coupons.empty")}</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                        <th className="py-3 pr-4">{t("coupons.colCode")}</th>
                                        <th className="py-3 pr-4">{t("coupons.colDiscount")}</th>
                                        <th className="py-3 pr-4">{t("coupons.colMin")}</th>
                                        <th className="py-3 pr-4">{t("coupons.colUses")}</th>
                                        <th className="py-3 pr-4">{t("coupons.colActive")}</th>
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
                                                    {c.is_active ? t("common.yes") : t("common.no")}
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
                                                    {t("common.edit")}
                                                </button>
                                                <button type="button" onClick={() => deleteCoupon(c.id)} className={btnDangerCls}>{t("common.delete")}</button>
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
                            <h2 className="font-bold text-gray-800">{t("shipping.zonesTitle", { n: zones.length })}</h2>
                            <button type="button" onClick={() => setZoneForm({ ...EMPTY_ZONE })} className={btnCls}>{t("shipping.newZone")}</button>
                        </div>
                        <p className="text-xs text-gray-400 mb-6">
                            {t("shipping.help")}
                        </p>
                        {zones.length === 0 ? (
                            <p className="text-sm text-gray-400">{t("shipping.empty")}</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                            <th className="py-3 pr-4">{t("shipping.colZone")}</th>
                                            <th className="py-3 pr-4">{t("shipping.colRate")}</th>
                                            <th className="py-3 pr-4">{t("shipping.colFreeFrom")}</th>
                                            <th className="py-3 pr-4">{t("shipping.colTax")}</th>
                                            <th className="py-3 pr-4">{t("shipping.colActive")}</th>
                                            <th className="py-3"></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {zones.map((z) => (
                                            <tr key={z.id} className="border-b border-gray-50 hover:bg-gray-50/60">
                                                <td className="py-3 pr-4 font-bold text-gray-800">{z.name}</td>
                                                <td className="py-3 pr-4">{z.rate_cents > 0 ? fmt(z.rate_cents) : t("shipping.free")}</td>
                                                <td className="py-3 pr-4">{z.free_over_cents >= 0 ? fmt(z.free_over_cents) : "—"}</td>
                                                <td className="py-3 pr-4">{z.tax_rate_bp >= 0 ? `${bpToInput(z.tax_rate_bp)}%` : t("shipping.default")}</td>
                                                <td className="py-3 pr-4">
                                                    <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase ${z.is_active ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-500"}`}>
                                                        {z.is_active ? t("common.yes") : t("common.no")}
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
                                                        {t("common.edit")}
                                                    </button>
                                                    <button type="button" onClick={() => deleteZone(z.id)} className={btnDangerCls}>{t("common.delete")}</button>
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
                            <h2 className="font-bold text-gray-800">{t("pickup.title")}</h2>
                            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                                <input type="checkbox" checked={!!shipCfgForm.pickupEnabled} onChange={(e) => setShipCfgForm({ ...shipCfgForm, pickupEnabled: e.target.checked })} />
                                {t("pickup.enabled")}
                            </label>
                            <div>
                                <label className={labelCls}>{t("pickup.instructions")}</label>
                                <textarea rows={2} value={shipCfgForm.pickupInstructions} onChange={(e) => setShipCfgForm({ ...shipCfgForm, pickupInstructions: e.target.value })} className={inputCls} maxLength={1000} />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className={labelCls}>{t("tax.default")}</label>
                                    <input type="text" inputMode="decimal" value={shipCfgForm.taxPercent} onChange={(e) => setShipCfgForm({ ...shipCfgForm, taxPercent: e.target.value })} placeholder={t("tax.placeholder")} className={inputCls} />
                                    <p className="text-[11px] text-gray-400 mt-2">{t("tax.help")}</p>
                                </div>
                                <div>
                                    <label className={labelCls}>{t("tax.label")}</label>
                                    <input type="text" value={shipCfgForm.taxLabel} onChange={(e) => setShipCfgForm({ ...shipCfgForm, taxLabel: e.target.value })} placeholder={t("tax.labelPlaceholder")} className={inputCls} maxLength={50} />
                                </div>
                            </div>
                            <div className="flex justify-end">
                                <button type="submit" disabled={busy} className={btnCls}>{busy ? t("common.saving") : t("common.save")}</button>
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
                                {d === 365 ? t("reports.months12") : t("reports.days", { n: d })}
                            </button>
                        ))}
                        <div className="flex-1" />
                        <button type="button" onClick={exportReportCsv} disabled={busy || !report} className={btnCls}>{t("common.exportCsv")}</button>
                    </div>

                    {!report ? (
                        <p className="text-sm text-gray-400">{t("reports.loading")}</p>
                    ) : (
                        <>
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                {[
                                    { label: t("reports.revenue"), value: fmt(report.totals.revenue_cents), sub: t("reports.paidOrders", { n: report.totals.paid_orders }) },
                                    { label: t("reports.net"), value: fmt(report.totals.net_cents), sub: t("reports.refunded", { amount: fmt(report.totals.refunds_cents) }) },
                                    { label: t("reports.avg"), value: fmt(report.totals.avg_order_cents), sub: t("reports.items", { n: report.totals.items_sold }) },
                                    { label: t("reports.orders"), value: String(report.totals.orders), sub: t("reports.discounts", { amount: fmt(report.totals.discount_cents) }) },
                                ].map((s) => (
                                    <div key={s.label} className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-5">
                                        <div className="text-[10px] font-black uppercase tracking-widest text-gray-400">{s.label}</div>
                                        <div className="text-2xl font-black text-gray-900 mt-1">{s.value}</div>
                                        <div className="text-[11px] text-gray-400 mt-1">{s.sub}</div>
                                    </div>
                                ))}
                            </div>

                            <div className={cardCls}>
                                <h3 className="font-bold text-gray-800 mb-1">{report.granularity === "month" ? t("reports.byMonth") : t("reports.byDay")}</h3>
                                <p className="text-[11px] text-gray-400 mb-4">{t("reports.taxShip", { tax: fmt(report.totals.tax_cents), ship: fmt(report.totals.shipping_cents) })}{report.truncated ? t("reports.truncated") : ""}</p>
                                {(() => {
                                    const max = Math.max(1, ...report.series.map((b) => b.revenue_cents));
                                    return (
                                        <div className="flex items-end gap-[2px] h-40 overflow-x-auto pb-6">
                                            {report.series.map((b) => (
                                                <div key={b.date} className="flex-1 min-w-[8px] flex flex-col items-center justify-end h-full group relative">
                                                    <div
                                                        className="w-full rounded-t-md bg-blue-500/80 hover:bg-blue-600 transition-all"
                                                        style={{ height: `${Math.max(b.revenue_cents > 0 ? 4 : 1, Math.round((b.revenue_cents / max) * 100))}%` }}
                                                        title={t("reports.barTitle", { date: b.date, amount: fmt(b.revenue_cents), n: b.orders })}
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
                                    <h3 className="font-bold text-gray-800 mb-4">{t("reports.topProducts")}</h3>
                                    {report.topProducts.length === 0 ? (
                                        <p className="text-sm text-gray-400">{t("reports.noSales")}</p>
                                    ) : (
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                                    <th className="py-2 pr-4">{t("reports.colProduct")}</th>
                                                    <th className="py-2 pr-4">{t("reports.colUnits")}</th>
                                                    <th className="py-2 text-right">{t("reports.colRevenue")}</th>
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
                                    <h3 className="font-bold text-gray-800 mb-4">{t("reports.couponsUsed")}</h3>
                                    {report.couponUsage.length === 0 ? (
                                        <p className="text-sm text-gray-400">{t("reports.noCoupons")}</p>
                                    ) : (
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                                    <th className="py-2 pr-4">{t("reports.colCoupon")}</th>
                                                    <th className="py-2 pr-4">{t("reports.colUses")}</th>
                                                    <th className="py-2 text-right">{t("reports.colDiscount")}</th>
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
                            <label className={labelCls}>{t("config.currencySymbol")}</label>
                            <input type="text" value={cfgForm.currencySymbol} onChange={(e) => setCfgForm({ ...cfgForm, currencySymbol: e.target.value })} className={inputCls} maxLength={8} />
                        </div>
                        <div>
                            <label className={labelCls}>{t("config.currencyCode")}</label>
                            <input type="text" value={cfgForm.currencyCode} onChange={(e) => setCfgForm({ ...cfgForm, currencyCode: e.target.value })} placeholder="USD" className={inputCls} maxLength={3} />
                        </div>
                        <div>
                            <label className={labelCls}>{t("config.flatShipping", { symbol: cfgForm.currencySymbol })}</label>
                            <input type="text" inputMode="decimal" value={cfgForm.shipping} onChange={(e) => setCfgForm({ ...cfgForm, shipping: e.target.value })} placeholder="0.00" className={inputCls} />
                            <p className="text-[11px] text-gray-400 mt-2">{t("config.flatShippingHelp")}</p>
                        </div>
                    </div>
                    <div>
                        <label className={labelCls}>{t("config.manualInstructions")}</label>
                        <textarea rows={3} value={cfgForm.manualPaymentInstructions} onChange={(e) => setCfgForm({ ...cfgForm, manualPaymentInstructions: e.target.value })} className={inputCls} maxLength={2000} />
                        <p className="text-[11px] text-gray-400 mt-2">{t("config.manualHelp")}</p>
                    </div>
                    <div>
                        <label className={labelCls}>{t("config.storeEmail")}</label>
                        <input type="email" value={cfgForm.storeEmail} onChange={(e) => setCfgForm({ ...cfgForm, storeEmail: e.target.value })} placeholder={t("config.storeEmailPlaceholder")} className={inputCls} maxLength={200} />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className={labelCls}>{t("config.cardTtl")}</label>
                            <input type="number" min={30} max={1440} value={cfgForm.cardPendingTtlMinutes} onChange={(e) => setCfgForm({ ...cfgForm, cardPendingTtlMinutes: e.target.value })} className={inputCls} />
                        </div>
                        <div>
                            <label className={labelCls}>{t("config.manualTtl")}</label>
                            <input type="number" min={0} max={720} value={cfgForm.manualPendingTtlHours} onChange={(e) => setCfgForm({ ...cfgForm, manualPendingTtlHours: e.target.value })} className={inputCls} />
                            <p className="text-[11px] text-gray-400 mt-2">{t("config.ttlHelp")}</p>
                        </div>
                        <div>
                            <label className={labelCls}>{t("config.maxLine")}</label>
                            <input type="number" min={1} max={99} value={cfgForm.maxLineQty} onChange={(e) => setCfgForm({ ...cfgForm, maxLineQty: e.target.value })} className={inputCls} />
                        </div>
                        <div>
                            <label className={labelCls}>{t("config.maxOrder")}</label>
                            <input type="number" min={1} max={10000} value={cfgForm.maxOrderQty} onChange={(e) => setCfgForm({ ...cfgForm, maxOrderQty: e.target.value })} className={inputCls} />
                        </div>
                    </div>
                    <div className="pt-4 border-t border-gray-100">
                        <label className={labelCls}>
                            {t("config.stripeKey")} {hasStripeKey ? <span className="text-green-600">{t("config.stripeSet")}</span> : <span className="text-gray-300">{t("config.stripeUnset")}</span>}
                        </label>
                        <input
                            type="password"
                            value={stripeKeyInput}
                            onChange={(e) => { setStripeKeyInput(e.target.value); setClearStripeKey(false); }}
                            placeholder={hasStripeKey ? t("config.stripePlaceholderSet") : "sk_live_… / sk_test_…"}
                            className={inputCls}
                            autoComplete="new-password"
                        />
                        <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                            {t("config.stripeHelp1")}<strong>{t("config.stripeWebhook")}</strong>{t("config.stripeHelp2")}<span className="font-mono">/api/v1/plugin/online-store/public/stripe-webhook</span>{t("config.stripeHelp3")}
                        </p>
                        {hasStripeKey && (
                            <label className="flex items-center gap-2 mt-2 text-[11px] text-gray-500 cursor-pointer select-none">
                                <input type="checkbox" checked={clearStripeKey} onChange={(e) => { setClearStripeKey(e.target.checked); if (e.target.checked) setStripeKeyInput(""); }} />
                                {t("config.stripeClear")}
                            </label>
                        )}
                    </div>
                    <div className="flex justify-end">
                        <button type="submit" disabled={busy} className={btnCls}>{busy ? t("common.saving") : t("config.save")}</button>
                    </div>
                </form>
            )}

            {/* ============================ MODAL: DETALLE PEDIDO ============================ */}
            {detail && (
                <Modal title={t("detail.title", { id: detail.id })} onClose={() => setDetail(null)} wide>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6 text-sm">
                        <div>
                            <div className={labelCls}>{t("detail.customer")}</div>
                            <div className="font-bold text-gray-800">{detail.customer_name}</div>
                            <div className="text-gray-500">{detail.customer_email}</div>
                            {detail.customer_phone && <div className="text-gray-500">{detail.customer_phone}</div>}
                            {detail.customer_address && <div className="text-gray-500 whitespace-pre-line">{detail.customer_address}</div>}
                            {Number(detail.user_id) > 0 && <div className="text-[11px] text-blue-500 font-bold mt-1">{t("detail.account", { id: detail.user_id })}</div>}
                        </div>
                        <div>
                            <div className={labelCls}>{t("detail.order")}</div>
                            <div className="text-gray-500">{t("detail.date", { date: String(detail.created_at || "").slice(0, 16) })}</div>
                            <div className="text-gray-500">{t("detail.code")}<span className="font-mono text-xs">{detail.token}</span></div>
                            <div className="text-gray-500">{t("detail.method", { method: detail.payment_method === "stripe" ? t("detail.card") : t("detail.manual") })}</div>
                            <div className="text-gray-500">
                                {t("detail.delivery", { delivery: detail.shipping_method === "zone" ? t("detail.zone", { name: detail.shipping_zone_name || "" }) : shipLabel(detail.shipping_method) })}
                            </div>
                            {detail.coupon_code && <div className="text-gray-500">{t("detail.coupon")}<span className="font-mono">{detail.coupon_code}</span></div>}
                            {detail.refund_id && <div className="text-gray-500">{t("detail.stripeRefund")}<span className="font-mono text-xs">{detail.refund_id}</span></div>}
                        </div>
                    </div>

                    <div className="overflow-x-auto mb-4">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                    <th className="py-2 pr-4">{t("detail.colProduct")}</th>
                                    <th className="py-2 pr-4">{t("detail.colPrice")}</th>
                                    <th className="py-2 pr-4">{t("detail.colQty")}</th>
                                    <th className="py-2 text-right">{t("detail.colAmount")}</th>
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
                        <div className="flex justify-between text-gray-500"><span>{t("detail.subtotal")}</span><span>{fmt(detail.subtotal_cents)}</span></div>
                        {detail.discount_cents > 0 && <div className="flex justify-between text-gray-500"><span>{t("detail.discount")}</span><span>-{fmt(detail.discount_cents)}</span></div>}
                        <div className="flex justify-between text-gray-500"><span>{t("detail.shipping")}</span><span>{fmt(detail.shipping_cents)}</span></div>
                        {Number(detail.tax_cents) > 0 && (
                            <div className="flex justify-between text-gray-500"><span>{(cfg && cfg.taxLabel) || t("detail.taxes")} ({bpToInput(detail.tax_rate_bp)}%)</span><span>{fmt(detail.tax_cents)}</span></div>
                        )}
                        <div className="flex justify-between font-black text-gray-900 text-base"><span>{t("detail.total")}</span><span>{fmt(detail.total_cents)}</span></div>
                        {Number(detail.refund_cents) > 0 && (
                            <div className="flex justify-between text-rose-600 font-bold"><span>{t("detail.refunded")}</span><span>-{fmt(detail.refund_cents)}</span></div>
                        )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                        <div>
                            <label className={labelCls}>{t("detail.orderStatus")}</label>
                            <select value={detail.status} onChange={(e) => applyOrderStatus(detail.id, e.target.value)} className={inputCls}>
                                {ORDER_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className={labelCls}>{t("detail.paymentStatus")}</label>
                            <select value={detail.payment_status} onChange={(e) => applyPaymentStatus(detail.id, e.target.value)} className={inputCls}>
                                {PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{payLabel(s)}</option>)}
                            </select>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <button type="button" onClick={() => deleteOrder(detail.id)} className={btnDangerCls}>{t("detail.delete")}</button>
                        <div className="flex gap-3">
                            {(detail.payment_status === "paid" || detail.payment_status === "refunded") && detailRemaining > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setRefundForm({ order: detail, amount: centsToInput(detailRemaining), restock: false })}
                                    className={btnGhostCls}
                                >
                                    {t("detail.refund")}
                                </button>
                            )}
                            <button type="button" onClick={() => setDetail(null)} className={btnGhostCls}>{t("common.close")}</button>
                        </div>
                    </div>
                </Modal>
            )}

            {/* ============================ MODAL: REEMBOLSO ============================ */}
            {refundForm && (
                <Modal title={t("refund.title", { id: refundForm.order.id })} onClose={() => setRefundForm(null)}>
                    <form onSubmit={submitRefund} className="space-y-4">
                        <p className="text-sm text-gray-500">
                            {refundForm.order.payment_method === "stripe"
                                ? t("refund.stripe")
                                : t("refund.manual")}
                        </p>
                        <div>
                            <label className={labelCls}>{t("refund.amount", { symbol, max: fmt(Math.max(0, refundForm.order.total_cents - (refundForm.order.refund_cents || 0))) })}</label>
                            <input type="text" inputMode="decimal" value={refundForm.amount} onChange={(e) => setRefundForm({ ...refundForm, amount: e.target.value })} className={inputCls} required />
                        </div>
                        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                            <input type="checkbox" checked={!!refundForm.restock} onChange={(e) => setRefundForm({ ...refundForm, restock: e.target.checked })} />
                            {t("refund.restock")}
                        </label>
                        <div className="flex justify-end gap-3">
                            <button type="button" onClick={() => setRefundForm(null)} className={btnGhostCls}>{t("common.cancel")}</button>
                            <button type="submit" disabled={busy} className={btnCls}>{busy ? t("refund.processing") : t("refund.submit")}</button>
                        </div>
                    </form>
                </Modal>
            )}

            {/* ============================ MODAL: PRODUCTO ============================ */}
            {productForm && (
                <Modal title={productForm.id ? t("product.edit") : t("products.new")} onClose={() => setProductForm(null)} wide>
                    <form onSubmit={saveProduct} className="space-y-4">
                        <div>
                            <label className={labelCls}>{t("product.name")}</label>
                            <input type="text" value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} className={inputCls} required maxLength={200} />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelCls}>{t("product.price", { symbol })}</label>
                                <input type="text" inputMode="decimal" value={productForm.price} onChange={(e) => setProductForm({ ...productForm, price: e.target.value })} placeholder="19.99" className={inputCls} required />
                            </div>
                            <div>
                                <label className={labelCls}>{t("product.stock")}</label>
                                <input type="text" inputMode="numeric" value={productForm.stock} onChange={(e) => setProductForm({ ...productForm, stock: e.target.value })} placeholder="∞" className={inputCls} disabled={productForm.variants.some((v) => String(v.name).trim() && v.is_active)} />
                                {productForm.variants.some((v) => String(v.name).trim() && v.is_active) && (
                                    <p className="text-[11px] text-gray-400 mt-1">{t("product.stockByVariant")}</p>
                                )}
                            </div>
                        </div>
                        <div>
                            <label className={labelCls}>{t("product.description")}</label>
                            <textarea rows={3} value={productForm.description} onChange={(e) => setProductForm({ ...productForm, description: e.target.value })} className={inputCls} maxLength={5000} />
                        </div>
                        <div>
                            <label className={labelCls}>{t("product.image")}</label>
                            <div className="flex gap-2">
                                <input type="text" value={productForm.image_url} onChange={(e) => setProductForm({ ...productForm, image_url: e.target.value })} placeholder={t("product.imagePlaceholder")} className={inputCls} maxLength={1000} />
                                <button type="button" onClick={() => setMediaTarget("cover")} className={btnGhostCls + " whitespace-nowrap"}>{t("product.choose")}</button>
                            </div>
                        </div>

                        {/* ---- gallery ---- */}
                        <div className="pt-2 border-t border-gray-100">
                            <div className="flex items-center justify-between mb-2">
                                <label className={labelCls + " mb-0"}>{t("product.gallery", { n: productForm.images.length })}</label>
                                <div className="flex gap-2">
                                    <button type="button" onClick={() => setMediaTarget("gallery")} disabled={productForm.images.length >= 12} className={btnMiniCls}>{t("product.library")}</button>
                                    <button type="button" onClick={() => setProductForm({ ...productForm, images: [...productForm.images, { url: "", alt: "" }] })} disabled={productForm.images.length >= 12} className={btnMiniCls}>{t("product.addUrl")}</button>
                                </div>
                            </div>
                            {productForm.images.length === 0 ? (
                                <p className="text-xs text-gray-400">{t("product.noImages")}</p>
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
                                            <input type="text" value={im.alt} onChange={(e) => setImageField(idx, "alt", e.target.value)} placeholder={t("product.altPlaceholder")} className={inputSmCls + " max-w-[130px]"} />
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
                                <label className={labelCls + " mb-0"}>{t("product.variants", { n: productForm.variants.length })}</label>
                                <button
                                    type="button"
                                    onClick={() => setProductForm({ ...productForm, variants: [...productForm.variants, { ...EMPTY_VARIANT }] })}
                                    disabled={productForm.variants.length >= 40}
                                    className={btnMiniCls}
                                >
                                    {t("product.addVariant")}
                                </button>
                            </div>
                            {productForm.variants.length === 0 ? (
                                <p className="text-xs text-gray-400">{t("product.noVariants")}</p>
                            ) : (
                                <div className="space-y-2">
                                    <div className="grid grid-cols-[1fr_90px_80px_70px_60px_34px] gap-2 text-[9px] font-black uppercase tracking-widest text-gray-400 px-1">
                                        <span>{t("product.vName")}</span><span>{t("product.vSku")}</span><span>{t("product.vPrice")}</span><span>{t("product.vStock")}</span><span>{t("product.vActive")}</span><span></span>
                                    </div>
                                    {productForm.variants.map((v, idx) => (
                                        <div key={idx} className="grid grid-cols-[1fr_90px_80px_70px_60px_34px] gap-2 items-center">
                                            <input type="text" value={v.name} onChange={(e) => setVariantField(idx, "name", e.target.value)} placeholder={t("product.vNamePlaceholder")} className={inputSmCls} maxLength={120} />
                                            <input type="text" value={v.sku} onChange={(e) => setVariantField(idx, "sku", e.target.value)} placeholder={t("product.vSkuPlaceholder")} className={inputSmCls} maxLength={60} />
                                            <input type="text" inputMode="decimal" value={v.price} onChange={(e) => setVariantField(idx, "price", e.target.value)} placeholder={t("product.vPricePlaceholder")} className={inputSmCls} title={t("product.vPriceTitle")} />
                                            <input type="text" inputMode="numeric" value={v.stock} onChange={(e) => setVariantField(idx, "stock", e.target.value)} placeholder="∞" className={inputSmCls} />
                                            <input type="checkbox" checked={!!v.is_active} onChange={(e) => setVariantField(idx, "is_active", e.target.checked)} className="justify-self-center" />
                                            <button type="button" onClick={() => setProductForm({ ...productForm, variants: productForm.variants.filter((_, i) => i !== idx) })} className={btnDangerCls + " justify-self-center"}>&#215;</button>
                                        </div>
                                    ))}
                                    <p className="text-[11px] text-gray-400">{t("product.variantsHelp")}</p>
                                </div>
                            )}
                        </div>

                        <div>
                            <label className={labelCls}>{t("product.category")}</label>
                            <input type="text" value={productForm.category} onChange={(e) => setProductForm({ ...productForm, category: e.target.value })} placeholder={t("product.categoryPlaceholder")} className={inputCls} maxLength={100} />
                        </div>
                        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                            <input type="checkbox" checked={!!productForm.is_published} onChange={(e) => setProductForm({ ...productForm, is_published: e.target.checked })} />
                            {t("product.published")}
                        </label>
                        <div className="flex justify-end gap-3">
                            <button type="button" onClick={() => setProductForm(null)} className={btnGhostCls}>{t("common.cancel")}</button>
                            <button type="submit" disabled={busy} className={btnCls}>{busy ? t("common.saving") : t("common.save")}</button>
                        </div>
                    </form>
                </Modal>
            )}

            {/* ============================ MODAL: CUPÓN ============================ */}
            {couponForm && (
                <Modal title={couponForm.id ? t("coupon.edit") : t("coupons.new")} onClose={() => setCouponForm(null)}>
                    <form onSubmit={saveCoupon} className="space-y-4">
                        <div>
                            <label className={labelCls}>{t("coupon.code")}</label>
                            <input type="text" value={couponForm.code} onChange={(e) => setCouponForm({ ...couponForm, code: e.target.value.toUpperCase() })} placeholder={t("coupon.codePlaceholder")} className={inputCls + " font-mono uppercase"} required maxLength={50} />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelCls}>{t("coupon.type")}</label>
                                <select value={couponForm.type} onChange={(e) => setCouponForm({ ...couponForm, type: e.target.value })} className={inputCls}>
                                    <option value="percent">{t("coupon.percent")}</option>
                                    <option value="fixed">{t("coupon.fixed", { symbol })}</option>
                                </select>
                            </div>
                            <div>
                                <label className={labelCls}>{couponForm.type === "percent" ? t("coupon.percentValue") : t("coupon.amountValue", { symbol })}</label>
                                <input type="text" inputMode="decimal" value={couponForm.value} onChange={(e) => setCouponForm({ ...couponForm, value: e.target.value })} placeholder={couponForm.type === "percent" ? "10" : "5.00"} className={inputCls} required />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelCls}>{t("coupon.minTotal", { symbol })}</label>
                                <input type="text" inputMode="decimal" value={couponForm.minTotal} onChange={(e) => setCouponForm({ ...couponForm, minTotal: e.target.value })} placeholder="0.00" className={inputCls} />
                            </div>
                            <div>
                                <label className={labelCls}>{t("coupon.maxUses")}</label>
                                <input type="text" inputMode="numeric" value={couponForm.maxUses} onChange={(e) => setCouponForm({ ...couponForm, maxUses: e.target.value })} placeholder="∞" className={inputCls} />
                            </div>
                        </div>
                        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                            <input type="checkbox" checked={!!couponForm.is_active} onChange={(e) => setCouponForm({ ...couponForm, is_active: e.target.checked })} />
                            {t("coupon.active")}
                        </label>
                        <div className="flex justify-end gap-3">
                            <button type="button" onClick={() => setCouponForm(null)} className={btnGhostCls}>{t("common.cancel")}</button>
                            <button type="submit" disabled={busy} className={btnCls}>{busy ? t("common.saving") : t("common.save")}</button>
                        </div>
                    </form>
                </Modal>
            )}

            {/* ============================ MODAL: ZONA DE ENVÍO ============================ */}
            {zoneForm && (
                <Modal title={zoneForm.id ? t("zone.edit") : t("zone.new")} onClose={() => setZoneForm(null)}>
                    <form onSubmit={saveZone} className="space-y-4">
                        <div>
                            <label className={labelCls}>{t("zone.name")}</label>
                            <input type="text" value={zoneForm.name} onChange={(e) => setZoneForm({ ...zoneForm, name: e.target.value })} placeholder={t("zone.namePlaceholder")} className={inputCls} required maxLength={100} />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelCls}>{t("zone.rate", { symbol })}</label>
                                <input type="text" inputMode="decimal" value={zoneForm.rate} onChange={(e) => setZoneForm({ ...zoneForm, rate: e.target.value })} placeholder={t("zone.ratePlaceholder")} className={inputCls} />
                            </div>
                            <div>
                                <label className={labelCls}>{t("zone.freeOver", { symbol })}</label>
                                <input type="text" inputMode="decimal" value={zoneForm.freeOver} onChange={(e) => setZoneForm({ ...zoneForm, freeOver: e.target.value })} placeholder="100.00" className={inputCls} />
                            </div>
                        </div>
                        <div>
                            <label className={labelCls}>{t("zone.tax")}</label>
                            <input type="text" inputMode="decimal" value={zoneForm.taxPercent} onChange={(e) => setZoneForm({ ...zoneForm, taxPercent: e.target.value })} placeholder="16" className={inputCls} />
                        </div>
                        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                            <input type="checkbox" checked={!!zoneForm.is_active} onChange={(e) => setZoneForm({ ...zoneForm, is_active: e.target.checked })} />
                            {t("zone.active")}
                        </label>
                        <div className="flex justify-end gap-3">
                            <button type="button" onClick={() => setZoneForm(null)} className={btnGhostCls}>{t("common.cancel")}</button>
                            <button type="submit" disabled={busy} className={btnCls}>{busy ? t("common.saving") : t("common.save")}</button>
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
