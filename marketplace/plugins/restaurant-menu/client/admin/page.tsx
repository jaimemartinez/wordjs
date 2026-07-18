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

// Visual identity (premium/modern) lives in the plugin's OWN stylesheet (client/admin/admin.css,
// scoped to .plugin-admin-restaurant); the markup only references cf-* classes.
const inputCls = "cf-input";
const labelCls = "cf-label";
const btnCls = "cf-btn";
const btnGhostCls = "cf-btn-ghost";
const cardCls = "cf-card-item";

const UtensilsIcon = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
        <path d="M7 2v20" />
        <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
    </svg>
);

const TAGS = [
    { id: "vegano", emoji: "🌱", label: "Vegano" },
    { id: "picante", emoji: "🌶️", label: "Picante" },
    { id: "sin-gluten", emoji: "🚫🌾", label: "Sin gluten" },
    { id: "nuevo", emoji: "✨", label: "Nuevo" },
    { id: "popular", emoji: "⭐", label: "Popular" },
];

// `color` is a cf-pill modifier class (see admin.css).
const STATUS_META = {
    new: { label: "Nuevo", color: "is-accent" },
    preparing: { label: "Preparando", color: "is-warn" },
    ready: { label: "Listo", color: "is-ok" },
    delivered: { label: "Entregado", color: "" },
    cancelled: { label: "Cancelado", color: "is-danger" },
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
        <div className="cf-overlay" onClick={onClose}>
            <div className="cf-letter" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
                <div className="cf-letter-body">
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", marginBottom: "1.1rem" }}>
                        <h3 className="cf-editor-title" style={{ marginBottom: 0 }}>{title}</h3>
                        <button type="button" onClick={onClose} aria-label="Cerrar" className="cf-iconbtn">✕</button>
                    </div>
                    {children}
                </div>
            </div>
        </div>
    );
}

function SectionModal({ initial, busy, onSave, onClose }) {
    const [name, setName] = useState(initial ? initial.name : "");
    return (
        <Modal title={initial ? "Editar sección" : "Nueva sección"} onClose={onClose}>
            <form onSubmit={(e) => { e.preventDefault(); onSave({ name: name.trim() }); }}>
                <div style={{ marginBottom: "1.25rem" }}>
                    <label className={labelCls}>Nombre de la sección</label>
                    <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Entradas, Platos fuertes, Bebidas…" className={inputCls} maxLength={120} required autoFocus />
                </div>
                <div className="cf-end">
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
            <form onSubmit={submit} className="cf-stack">
                <div>
                    <label className={labelCls}>Nombre del plato</label>
                    <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Pizza Margarita" className={inputCls} maxLength={160} required autoFocus />
                </div>
                <div>
                    <label className={labelCls}>Descripción</label>
                    <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ingredientes, presentación…" className={inputCls} rows={2} maxLength={1000} />
                </div>
                <div className="cf-grid-2">
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
                    <div className="cf-row">
                        {TAGS.map((t) => (
                            <button key={t.id} type="button" onClick={() => toggleTag(t.id)}
                                className={`cf-tag ${tags.includes(t.id) ? "is-on" : ""}`}>
                                {t.emoji} {t.label}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="cf-end" style={{ paddingTop: "0.5rem" }}>
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
            <div className="cf-stack">
                <div className="cf-row" style={{ alignItems: "center" }}>
                    <span className={`cf-pill ${meta.color}`}>{meta.label}</span>
                    <span className="cf-meta" style={{ marginTop: 0 }}>{fmtDate(order.created_at)}</span>
                </div>
                <div className="cf-subcard">
                    <p style={{ margin: 0, fontWeight: 700 }}>{order.customer_name}</p>
                    <p className="cf-row" style={{ margin: "0.35rem 0 0" }}>
                        <a href={`tel:${order.customer_phone}`} className="cf-link">📞 {order.customer_phone}</a>
                        {phoneDigits ? (
                            <a href={`https://wa.me/${phoneDigits}`} target="_blank" rel="noopener noreferrer" className="cf-link is-ok">WhatsApp</a>
                        ) : null}
                    </p>
                    <p style={{ margin: "0.35rem 0 0", color: "var(--cf-soft)" }}>
                        {order.delivery_type === "delivery" ? `🛵 Domicilio: ${order.customer_address || "—"}` : "🏪 Recoger en local"}
                    </p>
                </div>
                <div>
                    <p className={labelCls}>Productos</p>
                    <div className="cf-line-items">
                        {(Array.isArray(order.items) ? order.items : []).map((it, i) => (
                            <div key={i} className="cf-line-item">
                                <div className="cf-line-head">
                                    <span>{it.qty}x {it.name}</span>
                                    <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtMoney(it.price_cents * it.qty, symbol)}</span>
                                </div>
                                {it.note ? <p className="cf-line-note">▸ {it.note}</p> : null}
                            </div>
                        ))}
                    </div>
                </div>
                <div className="cf-totals">
                    <div className="cf-totals-row"><span>Subtotal</span><span>{fmtMoney(order.subtotal_cents, symbol)}</span></div>
                    {order.delivery_cents > 0 ? (
                        <div className="cf-totals-row"><span>Envío</span><span>{fmtMoney(order.delivery_cents, symbol)}</span></div>
                    ) : null}
                    <div className="cf-totals-row is-total"><span>Total</span><span>{fmtMoney(order.total_cents, symbol)}</span></div>
                </div>
                {order.notes ? (
                    <div className="cf-subcard is-warn">📝 {order.notes}</div>
                ) : null}
                <div>
                    <p className={labelCls}>Cambiar estado</p>
                    <div className="cf-row">
                        {Object.keys(STATUS_META).map((s) => (
                            <button key={s} type="button" disabled={busy || order.status === s} onClick={() => onStatus(order.id, s)}
                                className={`cf-tag ${order.status === s ? "is-on" : ""}`}>
                                {STATUS_META[s].label}
                            </button>
                        ))}
                    </div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: "0.5rem" }}>
                    <button type="button" disabled={busy} onClick={() => onDelete(order.id)} className="cf-linkbtn is-danger">Eliminar pedido</button>
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
        <form onSubmit={submit} className={`${cardCls} cf-stack`}>
            <label className="cf-toggle-card">
                <span>
                    <span className="cf-toggle-title">Pedidos en línea</span>
                    <span className="cf-toggle-desc">Habilita el carrito y el envío de pedidos desde el bloque del menú.</span>
                </span>
                <input type="checkbox" checked={orderingEnabled} onChange={(e) => setOrderingEnabled(e.target.checked)} />
            </label>

            <div className="cf-grid-2">
                <div>
                    <label className={labelCls}>Número de WhatsApp</label>
                    <input type="text" value={whatsappNumber} onChange={(e) => setWhatsappNumber(e.target.value)} placeholder="Ej. 573001234567 (con código de país)" className={inputCls} />
                    <p className="cf-help">Solo dígitos, con código de país. El cliente enviará ahí el resumen del pedido.</p>
                </div>
                <div>
                    <label className={labelCls}>Email de notificación (opcional)</label>
                    <input type="email" value={notifyEmail} onChange={(e) => setNotifyEmail(e.target.value)} placeholder="pedidos@mirestaurante.com" className={inputCls} />
                    <p className="cf-help">Se envía un correo por cada pedido nuevo (si hay proveedor de correo activo).</p>
                </div>
            </div>

            <div className="cf-grid-2">
                <div>
                    <label className={labelCls}>Costo de domicilio</label>
                    <input type="text" inputMode="decimal" value={deliveryStr} onChange={(e) => setDeliveryStr(e.target.value)} placeholder="0.00" className={inputCls} />
                </div>
                <div>
                    <label className={labelCls}>Símbolo de moneda</label>
                    <input type="text" value={currencySymbol} onChange={(e) => setCurrencySymbol(e.target.value)} placeholder="$" maxLength={5} className={inputCls} />
                </div>
            </div>

            <div className="cf-grid-2">
                <div>
                    <label className={labelCls}>Etiqueta "recoger"</label>
                    <input type="text" value={pickupLabel} onChange={(e) => setPickupLabel(e.target.value)} maxLength={60} className={inputCls} />
                </div>
                <div>
                    <label className={labelCls}>Etiqueta "domicilio"</label>
                    <input type="text" value={deliveryLabel} onChange={(e) => setDeliveryLabel(e.target.value)} maxLength={60} className={inputCls} />
                </div>
            </div>

            <div className="cf-end">
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
            className={`cf-tab ${tab === id ? "is-active" : ""}`}>
            {label}
            {badge > 0 ? <span className="cf-badge">{badge}</span> : null}
        </button>
    );

    const orderCard = (o) => {
        const nextAction = o.status === "new" ? { status: "preparing", label: "Preparar →" }
            : o.status === "preparing" ? { status: "ready", label: "Listo →" }
            : o.status === "ready" ? { status: "delivered", label: "Entregado ✓" } : null;
        return (
            <div key={o.id} className="cf-order-card">
                <button type="button" className="cf-order-open" onClick={() => setSelectedOrder(o)}>
                    <div className="cf-order-title">
                        <span>#{o.id} · {o.customer_name}</span>
                        <span>{fmtMoney(o.total_cents, symbol)}</span>
                    </div>
                    <p className="cf-order-meta">
                        {o.delivery_type === "delivery" ? "🛵 Domicilio" : "🏪 Recoger"} · {(Array.isArray(o.items) ? o.items : []).reduce((n, it) => n + (it.qty || 0), 0)} items · {fmtDate(o.created_at)}
                    </p>
                </button>
                <div className="cf-order-actions">
                    {nextAction ? (
                        <button type="button" disabled={busy} onClick={() => setOrderStatus(o.id, nextAction.status)} className="cf-btn-mini">
                            {nextAction.label}
                        </button>
                    ) : null}
                    {(o.status === "new" || o.status === "preparing") ? (
                        <button type="button" disabled={busy} onClick={() => setOrderStatus(o.id, "cancelled")} className="cf-btn-mini is-danger">
                            Cancelar
                        </button>
                    ) : null}
                </div>
            </div>
        );
    };

    return (
        <div className="cf-shell">
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><UtensilsIcon /></div>
                <div>
                    <h1 className="cf-title">Restaurante</h1>
                    <p className="cf-subtitle">Menú por secciones · pedidos en línea · entrega por WhatsApp</p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            <div className="cf-tabs" role="tablist">
                {tabBtn("menu", "Menú", 0)}
                {tabBtn("orders", "Pedidos", counts.new || 0)}
                {tabBtn("config", "Configuración", 0)}
            </div>

            {message ? (
                <div role={/Error/i.test(message) ? "alert" : "status"} className={`cf-flash ${/Error/i.test(message) ? "is-error" : "is-ok"}`}>{message}</div>
            ) : null}

            {/* ============================== MENÚ ============================== */}
            {tab === "menu" ? (
                <div className="cf-stack">
                    <div className="cf-end">
                        <button type="button" onClick={() => setSectionModal({ section: null })} className={btnCls}>+ Nueva sección</button>
                    </div>

                    {sections === null ? (
                        <div className="cf-empty">Cargando menú…</div>
                    ) : sections.length === 0 ? (
                        <div className="cf-empty">
                            Aún no hay secciones. Crea la primera (ej. "Entradas") y luego agrega platos.
                        </div>
                    ) : (
                        sections.map((s, si) => (
                            <div key={s.id} className={`${cardCls} ${s.is_active ? "" : "is-off"}`} style={{ padding: 0, overflow: "hidden" }}>
                                <div className="cf-accordion-head">
                                    <button type="button" onClick={() => setExpanded((p) => ({ ...p, [s.id]: !p[s.id] }))} aria-label={expanded[s.id] ? "Contraer sección" : "Expandir sección"} className="cf-iconbtn">
                                        {expanded[s.id] ? "▾" : "▸"}
                                    </button>
                                    <h2 className="cf-form-name" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}
                                        <span className="cf-meta" style={{ display: "inline", marginLeft: "0.5rem" }}>{(s.items || []).length} platos</span>
                                        {!s.is_active ? <span className="cf-pill is-danger" style={{ marginLeft: "0.5rem" }}>Oculta</span> : null}
                                    </h2>
                                    <button type="button" disabled={busy || si === 0} onClick={() => moveSection(s.id, "up")} className={btnGhostCls} title="Subir">↑</button>
                                    <button type="button" disabled={busy || si === sections.length - 1} onClick={() => moveSection(s.id, "down")} className={btnGhostCls} title="Bajar">↓</button>
                                    <button type="button" disabled={busy} onClick={() => toggleSectionActive(s)} className={btnGhostCls}>{s.is_active ? "Ocultar" : "Mostrar"}</button>
                                    <button type="button" disabled={busy} onClick={() => setSectionModal({ section: s })} className={btnGhostCls}>Editar</button>
                                    <button type="button" disabled={busy} onClick={() => deleteSection(s)} className="cf-iconbtn is-danger">✕</button>
                                </div>

                                {expanded[s.id] ? (
                                    <div>
                                        {(s.items || []).length === 0 ? (
                                            <p style={{ padding: "1rem 1.2rem", fontSize: "0.85rem", color: "var(--cf-faint)", margin: 0 }}>Sin platos en esta sección.</p>
                                        ) : (
                                            s.items.map((it, ii) => (
                                                <div key={it.id} className={`cf-item-row ${it.is_available ? "" : "is-off"}`}>
                                                    {it.image_url ? (
                                                        // eslint-disable-next-line @next/next/no-img-element
                                                        <img src={it.image_url} alt={it.name} className="cf-thumb" />
                                                    ) : (
                                                        <span className="cf-thumb">🍽️</span>
                                                    )}
                                                    <div style={{ flex: 1, minWidth: "140px" }}>
                                                        <p className="cf-item-name">{it.name}</p>
                                                        <p className="cf-item-price">{fmtMoney(it.price_cents, symbol)}</p>
                                                    </div>
                                                    <div className="cf-row" style={{ gap: "0.25rem" }}>
                                                        {TAGS.map((t) => {
                                                            const on = tagsToArray(it.tags).includes(t.id);
                                                            return (
                                                                <button key={t.id} type="button" disabled={busy} title={t.label} onClick={() => toggleItemTag(it, t.id)}
                                                                    className={`cf-tag is-mini ${on ? "is-on" : ""}`}>
                                                                    {t.emoji}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                    <label className="cf-check">
                                                        <input type="checkbox" checked={!!it.is_available} disabled={busy} onChange={() => toggleItemAvailable(it)} />
                                                        Disponible
                                                    </label>
                                                    <div style={{ display: "flex", gap: "0.35rem" }}>
                                                        <button type="button" disabled={busy || ii === 0} onClick={() => moveItem(it.id, "up")} className={btnGhostCls} title="Subir">↑</button>
                                                        <button type="button" disabled={busy || ii === s.items.length - 1} onClick={() => moveItem(it.id, "down")} className={btnGhostCls} title="Bajar">↓</button>
                                                        <button type="button" disabled={busy} onClick={() => setItemModal({ item: it, sectionId: s.id })} className={btnGhostCls}>Editar</button>
                                                        <button type="button" disabled={busy} onClick={() => deleteItem(it)} className="cf-iconbtn is-danger">✕</button>
                                                    </div>
                                                </div>
                                            ))
                                        )}
                                        <div style={{ padding: "0.75rem 1.2rem" }}>
                                            <button type="button" onClick={() => setItemModal({ item: null, sectionId: s.id })} className="cf-linkbtn">+ Agregar plato</button>
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
                <div className="cf-stack">
                    <div className="cf-end">
                        <button type="button" disabled={busy} onClick={loadOrders} className={btnGhostCls}>⟳ Actualizar</button>
                    </div>
                    {ordersData === null ? (
                        <div className="cf-empty">Cargando pedidos…</div>
                    ) : (
                        <>
                            <div className="cf-board">
                                {["new", "preparing", "ready"].map((st) => (
                                    <div key={st} className="cf-board-col">
                                        <p className="cf-board-head">
                                            {STATUS_META[st].label}
                                            <span className={`cf-pill ${STATUS_META[st].color}`}>{board[st].length}</span>
                                        </p>
                                        <div>
                                            {board[st].length === 0 ? (
                                                <p style={{ fontSize: "0.78rem", color: "var(--cf-faint)", textAlign: "center", padding: "1rem 0", margin: 0 }}>Sin pedidos</p>
                                            ) : (
                                                board[st].map(orderCard)
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <div className={cardCls}>
                                <button type="button" onClick={() => setShowHistory((v) => !v)} className="cf-linkbtn">
                                    {showHistory ? "▾" : "▸"} Historial (entregados / cancelados) — {board.history.length}
                                </button>
                                {showHistory ? (
                                    <div style={{ marginTop: "0.75rem" }}>
                                        {board.history.length === 0 ? (
                                            <p style={{ fontSize: "0.85rem", color: "var(--cf-faint)", padding: "0.5rem 0", margin: 0 }}>Sin historial todavía.</p>
                                        ) : (
                                            board.history.map((o) => (
                                                <button key={o.id} type="button" onClick={() => setSelectedOrder(o)} className="cf-history-row">
                                                    <span className={`cf-pill ${(STATUS_META[o.status] || STATUS_META.new).color}`}>{(STATUS_META[o.status] || STATUS_META.new).label}</span>
                                                    <span style={{ fontWeight: 650, color: "var(--cf-ink)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>#{o.id} · {o.customer_name}</span>
                                                    <span style={{ fontSize: "0.76rem", color: "var(--cf-faint)" }}>{fmtDate(o.created_at)}</span>
                                                    <span style={{ fontWeight: 750, fontVariantNumeric: "tabular-nums" }}>{fmtMoney(o.total_cents, symbol)}</span>
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
                    <div className="cf-empty">Cargando configuración…</div>
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
