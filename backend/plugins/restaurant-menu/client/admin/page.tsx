// @ts-nocheck
"use client";

/**
 * Admin page for the Restaurant Menu plugin (/admin/plugin/restaurant).
 * Tabs: Menú (sections accordion + inline item rows + CRUD modals), Pedidos (status board
 * Nuevo/Preparando/Listo + detail modal), Configuración (ordering, WhatsApp, delivery fee,
 * labels, notify email, currency). All money handled as integer cents; inputs show decimals.
 */

import React, { useEffect, useMemo, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";

const BASE = "/plugin/restaurant-menu";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-orange-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnGhostCls = "px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-bold text-xs transition-all disabled:opacity-50";
const cardCls = "bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40";

const TAGS = [
    { id: "vegano", emoji: "🌱", label: "Vegano" },
    { id: "picante", emoji: "🌶️", label: "Picante" },
    { id: "sin-gluten", emoji: "🚫🌾", label: "Sin gluten" },
    { id: "nuevo", emoji: "✨", label: "Nuevo" },
    { id: "popular", emoji: "⭐", label: "Popular" },
];

const STATUS_META = {
    new: { label: "Nuevo", color: "bg-blue-50 text-blue-700 border-blue-200" },
    preparing: { label: "Preparando", color: "bg-amber-50 text-amber-700 border-amber-200" },
    ready: { label: "Listo", color: "bg-green-50 text-green-700 border-green-200" },
    delivered: { label: "Entregado", color: "bg-gray-50 text-gray-500 border-gray-200" },
    cancelled: { label: "Cancelado", color: "bg-red-50 text-red-500 border-red-200" },
};

function fmtMoney(cents, symbol) {
    return `${symbol || "$"}${((Number(cents) || 0) / 100).toFixed(2)}`;
}
function centsToInput(cents) {
    return ((Number(cents) || 0) / 100).toFixed(2);
}
function inputToCents(str) {
    const n = parseFloat(String(str).replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
}
function fmtDate(s) {
    if (!s) return "";
    try {
        const iso = String(s).includes("T") ? String(s) : `${String(s).replace(" ", "T")}Z`;
        const d = new Date(iso);
        return isNaN(d.getTime()) ? String(s) : d.toLocaleString();
    } catch {
        return String(s);
    }
}
function tagsToArray(tags) {
    if (Array.isArray(tags)) return tags;
    return String(tags || "").split(",").map((t) => t.trim()).filter(Boolean);
}

// ---- module-level modals (NEVER define components inside components — focus loss) ----------------

function Modal({ title, onClose, children }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/40" onClick={onClose}></div>
            <div className="relative bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 sm:p-8">
                <div className="flex items-center justify-between mb-5">
                    <h3 className="text-lg font-black text-gray-900">{title}</h3>
                    <button type="button" onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 font-bold">✕</button>
                </div>
                {children}
            </div>
        </div>
    );
}

function SectionModal({ initial, busy, onSave, onClose }) {
    const [name, setName] = useState(initial ? initial.name : "");
    return (
        <Modal title={initial ? "Editar sección" : "Nueva sección"} onClose={onClose}>
            <form onSubmit={(e) => { e.preventDefault(); onSave({ name: name.trim() }); }}>
                <div className="mb-5">
                    <label className={labelCls}>Nombre de la sección</label>
                    <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Entradas, Platos fuertes, Bebidas…" className={inputCls} maxLength={120} required autoFocus />
                </div>
                <div className="flex justify-end gap-3">
                    <button type="button" onClick={onClose} className={btnGhostCls}>Cancelar</button>
                    <button type="submit" disabled={busy || !name.trim()} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>
            </form>
        </Modal>
    );
}

function ItemModal({ initial, sections, defaultSectionId, busy, onSave, onClose }) {
    const [name, setName] = useState(initial ? initial.name : "");
    const [description, setDescription] = useState(initial ? initial.description || "" : "");
    const [priceStr, setPriceStr] = useState(initial ? centsToInput(initial.price_cents) : "");
    const [imageUrl, setImageUrl] = useState(initial ? initial.image_url || "" : "");
    const [sectionId, setSectionId] = useState(initial ? initial.section_id : defaultSectionId);
    const [tags, setTags] = useState(initial ? tagsToArray(initial.tags) : []);

    const toggleTag = (id) => {
        setTags((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
    };

    const submit = (e) => {
        e.preventDefault();
        const cents = inputToCents(priceStr);
        if (cents === null) return;
        onSave({
            name: name.trim(),
            description: description.trim(),
            price_cents: cents,
            image_url: imageUrl.trim(),
            tags: tags.join(","),
            section_id: Number(sectionId),
        });
    };

    return (
        <Modal title={initial ? "Editar plato" : "Nuevo plato"} onClose={onClose}>
            <form onSubmit={submit} className="space-y-4">
                <div>
                    <label className={labelCls}>Nombre del plato</label>
                    <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Pizza Margarita" className={inputCls} maxLength={160} required autoFocus />
                </div>
                <div>
                    <label className={labelCls}>Descripción</label>
                    <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ingredientes, presentación…" className={inputCls} rows={2} maxLength={1000} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Precio</label>
                        <input type="text" inputMode="decimal" value={priceStr} onChange={(e) => setPriceStr(e.target.value)} placeholder="0.00" className={inputCls} required />
                    </div>
                    <div>
                        <label className={labelCls}>Sección</label>
                        <select value={sectionId} onChange={(e) => setSectionId(e.target.value)} className={inputCls}>
                            {sections.map((s) => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                        </select>
                    </div>
                </div>
                <div>
                    <label className={labelCls}>Foto (URL, opcional)</label>
                    <input type="text" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="/uploads/2026/07/plato.jpg o https://…" className={inputCls} maxLength={600} />
                </div>
                <div>
                    <label className={labelCls}>Etiquetas</label>
                    <div className="flex flex-wrap gap-2">
                        {TAGS.map((t) => (
                            <button key={t.id} type="button" onClick={() => toggleTag(t.id)}
                                className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition-all ${tags.includes(t.id) ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"}`}>
                                {t.emoji} {t.label}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="flex justify-end gap-3 pt-2">
                    <button type="button" onClick={onClose} className={btnGhostCls}>Cancelar</button>
                    <button type="submit" disabled={busy || !name.trim() || inputToCents(priceStr) === null} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>
            </form>
        </Modal>
    );
}

function OrderDetailModal({ order, symbol, busy, onStatus, onDelete, onClose }) {
    const meta = STATUS_META[order.status] || STATUS_META.new;
    const phoneDigits = String(order.customer_phone || "").replace(/\D/g, "");
    return (
        <Modal title={`Pedido #${order.id}`} onClose={onClose}>
            <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                    <span className={`px-3 py-1 rounded-full text-xs font-black border ${meta.color}`}>{meta.label}</span>
                    <span className="text-xs text-gray-400 font-bold">{fmtDate(order.created_at)}</span>
                </div>
                <div className="bg-gray-50 rounded-2xl p-4 text-sm space-y-1">
                    <p><span className="font-black">{order.customer_name}</span></p>
                    <p className="flex flex-wrap gap-3">
                        <a href={`tel:${order.customer_phone}`} className="text-blue-600 font-bold hover:underline">📞 {order.customer_phone}</a>
                        {phoneDigits ? (
                            <a href={`https://wa.me/${phoneDigits}`} target="_blank" rel="noopener noreferrer" className="text-green-600 font-bold hover:underline">WhatsApp</a>
                        ) : null}
                    </p>
                    <p className="text-gray-500">
                        {order.delivery_type === "delivery" ? `🛵 Domicilio: ${order.customer_address || "—"}` : "🏪 Recoger en local"}
                    </p>
                </div>
                <div>
                    <p className={labelCls}>Productos</p>
                    <div className="divide-y divide-gray-100 border border-gray-100 rounded-2xl overflow-hidden">
                        {(Array.isArray(order.items) ? order.items : []).map((it, i) => (
                            <div key={i} className="px-4 py-2.5 text-sm">
                                <div className="flex justify-between gap-3">
                                    <span className="font-bold">{it.qty}x {it.name}</span>
                                    <span className="font-black tabular-nums">{fmtMoney(it.price_cents * it.qty, symbol)}</span>
                                </div>
                                {it.note ? <p className="text-xs text-gray-400 mt-0.5">▸ {it.note}</p> : null}
                            </div>
                        ))}
                    </div>
                </div>
                <div className="text-sm space-y-1">
                    <div className="flex justify-between text-gray-500"><span>Subtotal</span><span className="tabular-nums">{fmtMoney(order.subtotal_cents, symbol)}</span></div>
                    {order.delivery_cents > 0 ? (
                        <div className="flex justify-between text-gray-500"><span>Envío</span><span className="tabular-nums">{fmtMoney(order.delivery_cents, symbol)}</span></div>
                    ) : null}
                    <div className="flex justify-between font-black text-base"><span>Total</span><span className="tabular-nums">{fmtMoney(order.total_cents, symbol)}</span></div>
                </div>
                {order.notes ? (
                    <div className="bg-amber-50 text-amber-700 rounded-2xl px-4 py-3 text-sm">📝 {order.notes}</div>
                ) : null}
                <div>
                    <p className={labelCls}>Cambiar estado</p>
                    <div className="flex flex-wrap gap-2">
                        {Object.keys(STATUS_META).map((s) => (
                            <button key={s} type="button" disabled={busy || order.status === s} onClick={() => onStatus(order.id, s)}
                                className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition-all disabled:opacity-40 ${order.status === s ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"}`}>
                                {STATUS_META[s].label}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="flex justify-between items-center pt-2">
                    <button type="button" disabled={busy} onClick={() => onDelete(order.id)} className="text-xs font-bold text-red-500 hover:text-red-700">Eliminar pedido</button>
                    <button type="button" onClick={onClose} className={btnGhostCls}>Cerrar</button>
                </div>
            </div>
        </Modal>
    );
}

function ConfigForm({ initial, busy, onSave }) {
    const [orderingEnabled, setOrderingEnabled] = useState(!!initial.orderingEnabled);
    const [whatsappNumber, setWhatsappNumber] = useState(initial.whatsappNumber || "");
    const [deliveryStr, setDeliveryStr] = useState(centsToInput(initial.deliveryCents));
    const [pickupLabel, setPickupLabel] = useState(initial.pickupLabel || "Recoger en local");
    const [deliveryLabel, setDeliveryLabel] = useState(initial.deliveryLabel || "Domicilio");
    const [notifyEmail, setNotifyEmail] = useState(initial.notifyEmail || "");
    const [currencySymbol, setCurrencySymbol] = useState(initial.currencySymbol || "$");

    const submit = (e) => {
        e.preventDefault();
        const cents = inputToCents(deliveryStr);
        onSave({
            orderingEnabled,
            whatsappNumber: whatsappNumber.trim(),
            deliveryCents: cents === null ? 0 : cents,
            pickupLabel: pickupLabel.trim(),
            deliveryLabel: deliveryLabel.trim(),
            notifyEmail: notifyEmail.trim(),
            currencySymbol: currencySymbol.trim() || "$",
        });
    };

    return (
        <form onSubmit={submit} className={`${cardCls} p-6 sm:p-8 space-y-5`}>
            <label className="flex items-center justify-between gap-4 cursor-pointer select-none bg-gray-50 rounded-2xl px-5 py-4">
                <span>
                    <span className="block font-black text-gray-900 text-sm">Pedidos en línea</span>
                    <span className="block text-xs text-gray-400 mt-0.5">Habilita el carrito y el envío de pedidos desde el bloque del menú.</span>
                </span>
                <input type="checkbox" checked={orderingEnabled} onChange={(e) => setOrderingEnabled(e.target.checked)} className="w-5 h-5 accent-gray-900" />
            </label>

            <div className="grid sm:grid-cols-2 gap-4">
                <div>
                    <label className={labelCls}>Número de WhatsApp</label>
                    <input type="text" value={whatsappNumber} onChange={(e) => setWhatsappNumber(e.target.value)} placeholder="Ej. 573001234567 (con código de país)" className={inputCls} />
                    <p className="text-[11px] text-gray-400 mt-1.5">Solo dígitos, con código de país. El cliente enviará ahí el resumen del pedido.</p>
                </div>
                <div>
                    <label className={labelCls}>Email de notificación (opcional)</label>
                    <input type="email" value={notifyEmail} onChange={(e) => setNotifyEmail(e.target.value)} placeholder="pedidos@mirestaurante.com" className={inputCls} />
                    <p className="text-[11px] text-gray-400 mt-1.5">Se envía un correo por cada pedido nuevo (si hay proveedor de correo activo).</p>
                </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
                <div>
                    <label className={labelCls}>Costo de domicilio</label>
                    <input type="text" inputMode="decimal" value={deliveryStr} onChange={(e) => setDeliveryStr(e.target.value)} placeholder="0.00" className={inputCls} />
                </div>
                <div>
                    <label className={labelCls}>Símbolo de moneda</label>
                    <input type="text" value={currencySymbol} onChange={(e) => setCurrencySymbol(e.target.value)} placeholder="$" maxLength={5} className={inputCls} />
                </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
                <div>
                    <label className={labelCls}>Etiqueta "recoger"</label>
                    <input type="text" value={pickupLabel} onChange={(e) => setPickupLabel(e.target.value)} maxLength={60} className={inputCls} />
                </div>
                <div>
                    <label className={labelCls}>Etiqueta "domicilio"</label>
                    <input type="text" value={deliveryLabel} onChange={(e) => setDeliveryLabel(e.target.value)} maxLength={60} className={inputCls} />
                </div>
            </div>

            <div className="flex justify-end">
                <button type="submit" disabled={busy} className={btnCls}>{busy ? "Guardando…" : "Guardar configuración"}</button>
            </div>
        </form>
    );
}

// ---- page ------------------------------------------------------------------------------------------

export default function RestaurantAdminPage() {
    const [tab, setTab] = useState("menu"); // 'menu' | 'orders' | 'config'
    const [sections, setSections] = useState(null);
    const [ordersData, setOrdersData] = useState(null); // {orders, counts}
    const [config, setConfig] = useState(null);
    const [expanded, setExpanded] = useState({});
    const [showHistory, setShowHistory] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");

    const [sectionModal, setSectionModal] = useState(null);   // {section|null}
    const [itemModal, setItemModal] = useState(null);         // {item|null, sectionId}
    const [selectedOrder, setSelectedOrder] = useState(null);

    const symbol = (config && config.currencySymbol) || "$";

    const flash = (msg) => {
        setMessage(msg);
        if (typeof window !== "undefined") window.setTimeout(() => setMessage(""), 4000);
    };

    const loadMenu = async () => {
        try {
            const data = await api(`${BASE}/admin/menu`);
            setSections(data.sections || []);
            setExpanded((prev) => {
                // Expand every section by default on first load.
                if (Object.keys(prev).length > 0) return prev;
                const next = {};
                for (const s of data.sections || []) next[s.id] = true;
                return next;
            });
        } catch (e) {
            setSections([]);
            flash(`Error al cargar el menú: ${e?.message || e}`);
        }
    };
    const loadOrders = async () => {
        try {
            setOrdersData(await api(`${BASE}/orders`));
        } catch (e) {
            setOrdersData({ orders: [], counts: {} });
        }
    };
    const loadConfig = async () => {
        try {
            setConfig(await api(`${BASE}/config`));
        } catch (e) {
            setConfig({});
        }
    };

    useEffect(() => { loadMenu(); loadOrders(); loadConfig(); }, []);

    const run = async (fn, okMsg) => {
        setBusy(true);
        try {
            await fn();
            if (okMsg) flash(okMsg);
        } catch (e) {
            flash(`Error: ${e?.message || e}`);
        } finally {
            setBusy(false);
        }
    };

    // --- section actions ---
    const saveSection = (payload) => run(async () => {
        if (sectionModal && sectionModal.section) await apiPut(`${BASE}/sections/${sectionModal.section.id}`, payload);
        else await apiPost(`${BASE}/sections`, payload);
        setSectionModal(null);
        await loadMenu();
    }, "Sección guardada.");
    const toggleSectionActive = (s) => run(async () => {
        await apiPut(`${BASE}/sections/${s.id}`, { is_active: !s.is_active });
        await loadMenu();
    });
    const moveSection = (id, dir) => run(async () => {
        await apiPost(`${BASE}/sections/${id}/move`, { dir });
        await loadMenu();
    });
    const deleteSection = (s) => {
        if (typeof window !== "undefined" && !window.confirm(`¿Eliminar la sección "${s.name}" y todos sus platos?`)) return;
        run(async () => {
            await apiDelete(`${BASE}/sections/${s.id}`);
            await loadMenu();
        }, "Sección eliminada.");
    };

    // --- item actions ---
    const saveItem = (payload) => run(async () => {
        if (itemModal && itemModal.item) await apiPut(`${BASE}/items/${itemModal.item.id}`, payload);
        else await apiPost(`${BASE}/items`, payload);
        setItemModal(null);
        await loadMenu();
    }, "Plato guardado.");
    const toggleItemAvailable = (it) => run(async () => {
        await apiPut(`${BASE}/items/${it.id}`, { is_available: !it.is_available });
        await loadMenu();
    });
    const toggleItemTag = (it, tagId) => run(async () => {
        const current = tagsToArray(it.tags);
        const next = current.includes(tagId) ? current.filter((t) => t !== tagId) : [...current, tagId];
        await apiPut(`${BASE}/items/${it.id}`, { tags: next.join(",") });
        await loadMenu();
    });
    const moveItem = (id, dir) => run(async () => {
        await apiPost(`${BASE}/items/${id}/move`, { dir });
        await loadMenu();
    });
    const deleteItem = (it) => {
        if (typeof window !== "undefined" && !window.confirm(`¿Eliminar el plato "${it.name}"?`)) return;
        run(async () => {
            await apiDelete(`${BASE}/items/${it.id}`);
            await loadMenu();
        }, "Plato eliminado.");
    };

    // --- order actions ---
    const setOrderStatus = (id, status) => run(async () => {
        await apiPost(`${BASE}/orders/${id}/status`, { status });
        await loadOrders();
        setSelectedOrder((prev) => (prev && prev.id === id ? { ...prev, status } : prev));
    });
    const deleteOrder = (id) => {
        if (typeof window !== "undefined" && !window.confirm("¿Eliminar este pedido definitivamente?")) return;
        run(async () => {
            await apiDelete(`${BASE}/orders/${id}`);
            setSelectedOrder(null);
            await loadOrders();
        }, "Pedido eliminado.");
    };

    // --- config actions ---
    const saveConfig = (payload) => run(async () => {
        const next = await apiPost(`${BASE}/config`, payload);
        setConfig(next);
    }, "Configuración guardada.");

    const counts = (ordersData && ordersData.counts) || {};
    const orders = (ordersData && ordersData.orders) || [];
    const board = useMemo(() => ({
        new: orders.filter((o) => o.status === "new"),
        preparing: orders.filter((o) => o.status === "preparing"),
        ready: orders.filter((o) => o.status === "ready"),
        history: orders.filter((o) => o.status === "delivered" || o.status === "cancelled"),
    }), [orders]);

    const tabBtn = (id, label, badge) => (
        <button type="button" onClick={() => { setTab(id); if (id === "orders") loadOrders(); }}
            className={`px-4 sm:px-5 py-2.5 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2 ${tab === id ? "bg-gray-900 text-white" : "bg-white text-gray-500 hover:bg-gray-100 border border-gray-100"}`}>
            {label}
            {badge > 0 ? <span className="bg-orange-500 text-white rounded-full min-w-[20px] h-5 px-1.5 inline-flex items-center justify-center text-[10px]">{badge}</span> : null}
        </button>
    );

    const orderCard = (o) => {
        const nextAction = o.status === "new" ? { status: "preparing", label: "Preparar →" }
            : o.status === "preparing" ? { status: "ready", label: "Listo →" }
            : o.status === "ready" ? { status: "delivered", label: "Entregado ✓" } : null;
        return (
            <div key={o.id} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
                <button type="button" className="w-full text-left" onClick={() => setSelectedOrder(o)}>
                    <div className="flex justify-between items-start gap-2">
                        <span className="font-black text-sm text-gray-900">#{o.id} · {o.customer_name}</span>
                        <span className="font-black text-sm tabular-nums">{fmtMoney(o.total_cents, symbol)}</span>
                    </div>
                    <p className="text-[11px] text-gray-400 font-bold mt-0.5">
                        {o.delivery_type === "delivery" ? "🛵 Domicilio" : "🏪 Recoger"} · {(Array.isArray(o.items) ? o.items : []).reduce((n, it) => n + (it.qty || 0), 0)} items · {fmtDate(o.created_at)}
                    </p>
                </button>
                <div className="flex gap-2 mt-3">
                    {nextAction ? (
                        <button type="button" disabled={busy} onClick={() => setOrderStatus(o.id, nextAction.status)} className="flex-1 px-3 py-1.5 bg-gray-900 hover:bg-orange-600 text-white rounded-xl font-black text-[11px] uppercase tracking-wider transition-all disabled:opacity-50">
                            {nextAction.label}
                        </button>
                    ) : null}
                    {(o.status === "new" || o.status === "preparing") ? (
                        <button type="button" disabled={busy} onClick={() => setOrderStatus(o.id, "cancelled")} className="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl font-black text-[11px] uppercase tracking-wider transition-all disabled:opacity-50">
                            Cancelar
                        </button>
                    ) : null}
                </div>
            </div>
        );
    };

    return (
        <div className="max-w-6xl mx-auto p-4 sm:p-8">
            <div className="mb-6">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Restaurante</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Menú por secciones · pedidos en línea · entrega por WhatsApp
                </p>
            </div>

            <div className="flex flex-wrap gap-2 mb-6">
                {tabBtn("menu", "Menú", 0)}
                {tabBtn("orders", "Pedidos", counts.new || 0)}
                {tabBtn("config", "Configuración", 0)}
            </div>

            {message ? (
                <div className={`text-sm px-4 py-3 rounded-xl mb-5 ${/Error/i.test(message) ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>{message}</div>
            ) : null}

            {/* ============================== MENÚ ============================== */}
            {tab === "menu" ? (
                <div className="space-y-4">
                    <div className="flex justify-end">
                        <button type="button" onClick={() => setSectionModal({ section: null })} className={btnCls}>+ Nueva sección</button>
                    </div>

                    {sections === null ? (
                        <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>Cargando menú…</div>
                    ) : sections.length === 0 ? (
                        <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>
                            Aún no hay secciones. Crea la primera (ej. "Entradas") y luego agrega platos.
                        </div>
                    ) : (
                        sections.map((s, si) => (
                            <div key={s.id} className={`${cardCls} overflow-hidden ${s.is_active ? "" : "opacity-60"}`}>
                                <div className="flex items-center gap-2 px-5 py-4 bg-gray-50/60">
                                    <button type="button" onClick={() => setExpanded((p) => ({ ...p, [s.id]: !p[s.id] }))} className="w-7 h-7 rounded-lg bg-white border border-gray-200 text-gray-500 text-xs font-black">
                                        {expanded[s.id] ? "▾" : "▸"}
                                    </button>
                                    <h2 className="font-black text-gray-900 flex-1 truncate">{s.name}
                                        <span className="text-[11px] text-gray-400 font-bold ml-2">{(s.items || []).length} platos</span>
                                        {!s.is_active ? <span className="text-[10px] font-black uppercase text-red-400 ml-2">Oculta</span> : null}
                                    </h2>
                                    <button type="button" disabled={busy || si === 0} onClick={() => moveSection(s.id, "up")} className={btnGhostCls} title="Subir">↑</button>
                                    <button type="button" disabled={busy || si === sections.length - 1} onClick={() => moveSection(s.id, "down")} className={btnGhostCls} title="Bajar">↓</button>
                                    <button type="button" disabled={busy} onClick={() => toggleSectionActive(s)} className={btnGhostCls}>{s.is_active ? "Ocultar" : "Mostrar"}</button>
                                    <button type="button" disabled={busy} onClick={() => setSectionModal({ section: s })} className={btnGhostCls}>Editar</button>
                                    <button type="button" disabled={busy} onClick={() => deleteSection(s)} className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-500 rounded-xl font-bold text-xs">✕</button>
                                </div>

                                {expanded[s.id] ? (
                                    <div className="divide-y divide-gray-50">
                                        {(s.items || []).length === 0 ? (
                                            <p className="px-5 py-4 text-sm text-gray-400">Sin platos en esta sección.</p>
                                        ) : (
                                            s.items.map((it, ii) => (
                                                <div key={it.id} className={`px-5 py-3 flex flex-wrap items-center gap-3 ${it.is_available ? "" : "opacity-50"}`}>
                                                    {it.image_url ? (
                                                        // eslint-disable-next-line @next/next/no-img-element
                                                        <img src={it.image_url} alt={it.name} className="w-10 h-10 rounded-lg object-cover border border-gray-100" />
                                                    ) : (
                                                        <span className="w-10 h-10 rounded-lg bg-gray-50 border border-gray-100 flex items-center justify-center text-gray-300">🍽️</span>
                                                    )}
                                                    <div className="flex-1 min-w-[140px]">
                                                        <p className="font-bold text-sm text-gray-900 truncate">{it.name}</p>
                                                        <p className="text-xs text-gray-400 font-black tabular-nums">{fmtMoney(it.price_cents, symbol)}</p>
                                                    </div>
                                                    <div className="flex flex-wrap gap-1">
                                                        {TAGS.map((t) => {
                                                            const on = tagsToArray(it.tags).includes(t.id);
                                                            return (
                                                                <button key={t.id} type="button" disabled={busy} title={t.label} onClick={() => toggleItemTag(it, t.id)}
                                                                    className={`px-2 py-1 rounded-full text-xs border transition-all ${on ? "bg-gray-900 border-gray-900" : "bg-white border-gray-200 opacity-40 hover:opacity-100 grayscale"}`}>
                                                                    {t.emoji}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                    <label className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-gray-400 cursor-pointer select-none">
                                                        <input type="checkbox" checked={!!it.is_available} disabled={busy} onChange={() => toggleItemAvailable(it)} className="w-4 h-4 accent-green-600" />
                                                        Disponible
                                                    </label>
                                                    <div className="flex gap-1.5">
                                                        <button type="button" disabled={busy || ii === 0} onClick={() => moveItem(it.id, "up")} className={btnGhostCls} title="Subir">↑</button>
                                                        <button type="button" disabled={busy || ii === s.items.length - 1} onClick={() => moveItem(it.id, "down")} className={btnGhostCls} title="Bajar">↓</button>
                                                        <button type="button" disabled={busy} onClick={() => setItemModal({ item: it, sectionId: s.id })} className={btnGhostCls}>Editar</button>
                                                        <button type="button" disabled={busy} onClick={() => deleteItem(it)} className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-500 rounded-xl font-bold text-xs">✕</button>
                                                    </div>
                                                </div>
                                            ))
                                        )}
                                        <div className="px-5 py-3">
                                            <button type="button" onClick={() => setItemModal({ item: null, sectionId: s.id })} className="text-xs font-black uppercase tracking-widest text-gray-400 hover:text-gray-900 transition-colors">+ Agregar plato</button>
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        ))
                    )}
                </div>
            ) : null}

            {/* ============================== PEDIDOS ============================== */}
            {tab === "orders" ? (
                <div className="space-y-5">
                    <div className="flex justify-end">
                        <button type="button" disabled={busy} onClick={loadOrders} className={btnGhostCls}>⟳ Actualizar</button>
                    </div>
                    {ordersData === null ? (
                        <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>Cargando pedidos…</div>
                    ) : (
                        <>
                            <div className="grid md:grid-cols-3 gap-4">
                                {["new", "preparing", "ready"].map((st) => (
                                    <div key={st} className="bg-gray-50/80 rounded-3xl p-4 border border-gray-100">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3 flex items-center justify-between">
                                            {STATUS_META[st].label}
                                            <span className={`px-2 py-0.5 rounded-full border text-[10px] ${STATUS_META[st].color}`}>{board[st].length}</span>
                                        </p>
                                        <div className="space-y-3">
                                            {board[st].length === 0 ? (
                                                <p className="text-xs text-gray-300 text-center py-4">Sin pedidos</p>
                                            ) : (
                                                board[st].map(orderCard)
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <div className={`${cardCls} p-5`}>
                                <button type="button" onClick={() => setShowHistory((v) => !v)} className="text-xs font-black uppercase tracking-widest text-gray-400 hover:text-gray-900 transition-colors">
                                    {showHistory ? "▾" : "▸"} Historial (entregados / cancelados) — {board.history.length}
                                </button>
                                {showHistory ? (
                                    <div className="mt-4 divide-y divide-gray-50">
                                        {board.history.length === 0 ? (
                                            <p className="text-sm text-gray-400 py-3">Sin historial todavía.</p>
                                        ) : (
                                            board.history.map((o) => (
                                                <button key={o.id} type="button" onClick={() => setSelectedOrder(o)} className="w-full text-left py-2.5 flex flex-wrap items-center gap-3 hover:bg-gray-50 rounded-xl px-2 transition-colors">
                                                    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-black ${(STATUS_META[o.status] || STATUS_META.new).color}`}>{(STATUS_META[o.status] || STATUS_META.new).label}</span>
                                                    <span className="font-bold text-sm text-gray-700 flex-1 truncate">#{o.id} · {o.customer_name}</span>
                                                    <span className="text-xs text-gray-400">{fmtDate(o.created_at)}</span>
                                                    <span className="font-black text-sm tabular-nums">{fmtMoney(o.total_cents, symbol)}</span>
                                                </button>
                                            ))
                                        )}
                                    </div>
                                ) : null}
                            </div>
                        </>
                    )}
                </div>
            ) : null}

            {/* ============================== CONFIGURACIÓN ============================== */}
            {tab === "config" ? (
                config === null ? (
                    <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>Cargando configuración…</div>
                ) : (
                    <ConfigForm initial={config} busy={busy} onSave={saveConfig} />
                )
            ) : null}

            {/* modals */}
            {sectionModal ? (
                <SectionModal initial={sectionModal.section} busy={busy} onSave={saveSection} onClose={() => setSectionModal(null)} />
            ) : null}
            {itemModal && sections ? (
                <ItemModal initial={itemModal.item} sections={sections} defaultSectionId={itemModal.sectionId} busy={busy} onSave={saveItem} onClose={() => setItemModal(null)} />
            ) : null}
            {selectedOrder ? (
                <OrderDetailModal order={selectedOrder} symbol={symbol} busy={busy} onStatus={setOrderStatus} onDelete={deleteOrder} onClose={() => setSelectedOrder(null)} />
            ) : null}
        </div>
    );
}
