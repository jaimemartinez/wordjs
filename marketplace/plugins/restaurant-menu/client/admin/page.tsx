// @ts-nocheck
"use client";

/**
 * Admin page for the Restaurant Menu plugin v2 (/admin/plugin/restaurant).
 * Tabs: Menú (secciones + platos con i18n/alérgenos/prep/modificadores), Modificadores,
 * Pedidos (board + detalle con pago/mesa), Cocina (en vivo por SSE), Mesas (QR),
 * Reservas, Informes y Configuración (horarios, zona horaria, pagos Stripe, mesa QR, idioma).
 * All money handled as integer cents; inputs show decimals.
 */

import React, { useEffect, useMemo, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";
import {
    BASE, inputCls, labelCls, btnCls, btnGhostCls, cardCls, chipOnCls, chipOffCls,
    TAGS, ALLERGENS, STATUS_META, PAY_META, DAY_ORDER, DAY_LABELS,
    fmtMoney, centsToInput, inputToCents, fmtDate, tagsToArray, Modal,
} from "./shared";
import { ModifiersTab, KitchenTab, TablesTab, ReservationsTab, ReportsTab } from "./v2tabs";

// ---- module-level modals (NEVER define components inside components — focus loss) ----------------

function SectionModal({ initial, busy, onSave, onClose }) {
    const [name, setName] = useState(initial ? initial.name : "");
    const [nameEn, setNameEn] = useState(initial ? initial.name_en || "" : "");
    return (
        <Modal title={initial ? "Editar sección" : "Nueva sección"} onClose={onClose}>
            <form onSubmit={(e) => { e.preventDefault(); onSave({ name: name.trim(), name_en: nameEn.trim() }); }}>
                <div className="mb-4">
                    <label className={labelCls}>Nombre de la sección</label>
                    <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Entradas, Platos fuertes, Bebidas…" className={inputCls} maxLength={120} required autoFocus />
                </div>
                <div className="mb-5">
                    <label className={labelCls}>Nombre en inglés (opcional)</label>
                    <input type="text" value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="Starters, Mains, Drinks…" className={inputCls} maxLength={120} />
                </div>
                <div className="flex justify-end gap-3">
                    <button type="button" onClick={onClose} className={btnGhostCls}>Cancelar</button>
                    <button type="submit" disabled={busy || !name.trim()} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>
            </form>
        </Modal>
    );
}

function ItemModal({ initial, sections, groups, defaultSectionId, busy, onSave, onClose }) {
    const [name, setName] = useState(initial ? initial.name : "");
    const [description, setDescription] = useState(initial ? initial.description || "" : "");
    const [priceStr, setPriceStr] = useState(initial ? centsToInput(initial.price_cents) : "");
    const [imageUrl, setImageUrl] = useState(initial ? initial.image_url || "" : "");
    const [sectionId, setSectionId] = useState(initial ? initial.section_id : defaultSectionId);
    const [tags, setTags] = useState(initial ? tagsToArray(initial.tags) : []);
    // v2 fields
    const [nameEn, setNameEn] = useState(initial ? initial.name_en || "" : "");
    const [descriptionEn, setDescriptionEn] = useState(initial ? initial.description_en || "" : "");
    const [allergens, setAllergens] = useState(initial ? tagsToArray(initial.allergens) : []);
    const [prepStr, setPrepStr] = useState(initial && initial.prep_minutes ? String(initial.prep_minutes) : "");
    const [groupIds, setGroupIds] = useState(initial ? (initial.modifier_group_ids || []) : []);

    const toggleTag = (id) => setTags((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
    const toggleAllergen = (id) => setAllergens((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
    const toggleGroup = (id) => setGroupIds((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));

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
            name_en: nameEn.trim(),
            description_en: descriptionEn.trim(),
            allergens: allergens.join(","),
            prep_minutes: prepStr === "" ? 0 : (parseInt(prepStr, 10) || 0),
        }, groupIds);
    };

    return (
        <Modal title={initial ? "Editar plato" : "Nuevo plato"} onClose={onClose} wide>
            <form onSubmit={submit} className="space-y-4">
                <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Nombre del plato</label>
                        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Pizza Margarita" className={inputCls} maxLength={160} required autoFocus />
                    </div>
                    <div>
                        <label className={labelCls}>Nombre en inglés (opcional)</label>
                        <input type="text" value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="Margherita Pizza" className={inputCls} maxLength={160} />
                    </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Descripción</label>
                        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ingredientes, presentación…" className={inputCls} rows={2} maxLength={1000} />
                    </div>
                    <div>
                        <label className={labelCls}>Descripción en inglés (opcional)</label>
                        <textarea value={descriptionEn} onChange={(e) => setDescriptionEn(e.target.value)} placeholder="Ingredients…" className={inputCls} rows={2} maxLength={1000} />
                    </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
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
                    <div>
                        <label className={labelCls}>Prep. (min, opcional)</label>
                        <input type="number" min={0} max={600} value={prepStr} onChange={(e) => setPrepStr(e.target.value)} placeholder="—" className={inputCls} />
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
                                className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition-all ${tags.includes(t.id) ? chipOnCls : chipOffCls}`}>
                                {t.emoji} {t.label}
                            </button>
                        ))}
                    </div>
                </div>
                <div>
                    <label className={labelCls}>Alérgenos (UE-14)</label>
                    <div className="flex flex-wrap gap-1.5">
                        {ALLERGENS.map((a) => (
                            <button key={a.id} type="button" onClick={() => toggleAllergen(a.id)} title={a.label}
                                className={`px-2.5 py-1 rounded-full text-[11px] font-bold border-2 transition-all ${allergens.includes(a.id) ? "bg-amber-500 text-white border-amber-500" : chipOffCls}`}>
                                {a.emoji} {a.label}
                            </button>
                        ))}
                    </div>
                </div>
                {groups && groups.length > 0 ? (
                    <div>
                        <label className={labelCls}>Grupos de opciones (modificadores)</label>
                        <div className="flex flex-wrap gap-2">
                            {groups.map((g) => (
                                <button key={g.id} type="button" onClick={() => toggleGroup(g.id)}
                                    className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition-all ${groupIds.includes(g.id) ? "bg-purple-600 text-white border-purple-600" : chipOffCls}`}>
                                    {g.name} <span className="opacity-60">({(g.options || []).length})</span>
                                </button>
                            ))}
                        </div>
                        <p className="text-[11px] text-gray-400 mt-1.5">Se crean en la pestaña Modificadores (ej. Tamaño, Extras).</p>
                    </div>
                ) : null}
                <div className="flex justify-end gap-3 pt-2">
                    <button type="button" onClick={onClose} className={btnGhostCls}>Cancelar</button>
                    <button type="submit" disabled={busy || !name.trim() || inputToCents(priceStr) === null} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>
            </form>
        </Modal>
    );
}

function OrderDetailModal({ order, symbol, busy, onStatus, onPaid, onDelete, onClose }) {
    const meta = STATUS_META[order.status] || STATUS_META.new;
    const phoneDigits = String(order.customer_phone || "").replace(/\D/g, "");
    const pay = PAY_META[order.payment_method] || PAY_META.whatsapp;
    const lineTotal = (it) => (Number.isFinite(it.line_cents) ? it.line_cents : it.price_cents * it.qty);
    return (
        <Modal title={`Pedido #${order.id}`} onClose={onClose}>
            <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                    <span className={`px-3 py-1 rounded-full text-xs font-black border ${meta.color}`}>{meta.label}</span>
                    {order.table_label ? (
                        <span className="px-3 py-1 rounded-full text-xs font-black bg-purple-50 text-purple-700 border border-purple-200">🪑 {order.table_label}</span>
                    ) : null}
                    <span className={`px-3 py-1 rounded-full text-xs font-black border ${order.payment_status === "paid" ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-50 text-gray-500 border-gray-200"}`}>
                        {pay.emoji} {pay.label}{order.payment_status === "paid" ? " · PAGADO ✓" : order.payment_status === "pending" ? " · pendiente" : ""}
                    </span>
                    <span className="text-xs text-gray-400 font-bold">{fmtDate(order.created_at)}</span>
                </div>
                <div className="bg-gray-50 rounded-2xl p-4 text-sm space-y-1">
                    <p><span className="font-black">{order.customer_name}</span></p>
                    {order.customer_phone ? (
                        <p className="flex flex-wrap gap-3">
                            <a href={`tel:${order.customer_phone}`} className="text-blue-600 font-bold hover:underline">📞 {order.customer_phone}</a>
                            {phoneDigits ? (
                                <a href={`https://wa.me/${phoneDigits}`} target="_blank" rel="noopener noreferrer" className="text-green-600 font-bold hover:underline">WhatsApp</a>
                            ) : null}
                        </p>
                    ) : null}
                    <p className="text-gray-500">
                        {order.delivery_type === "table" ? `🪑 En mesa: ${order.table_label || "—"}`
                            : order.delivery_type === "delivery" ? `🛵 Domicilio: ${order.customer_address || "—"}`
                            : "🏪 Recoger en local"}
                    </p>
                </div>
                <div>
                    <p className={labelCls}>Productos</p>
                    <div className="divide-y divide-gray-100 border border-gray-100 rounded-2xl overflow-hidden">
                        {(Array.isArray(order.items) ? order.items : []).map((it, i) => (
                            <div key={i} className="px-4 py-2.5 text-sm">
                                <div className="flex justify-between gap-3">
                                    <span className="font-bold">{it.qty}x {it.name}</span>
                                    <span className="font-black tabular-nums">{fmtMoney(lineTotal(it), symbol)}</span>
                                </div>
                                {(it.options || []).map((o, oi) => (
                                    <p key={oi} className="text-xs text-gray-500 mt-0.5 ml-1">
                                        • {o.name}{o.price_delta_cents ? ` (${o.price_delta_cents > 0 ? "+" : ""}${fmtMoney(o.price_delta_cents, symbol)})` : ""}
                                    </p>
                                ))}
                                {it.note ? <p className="text-xs text-amber-600 font-bold mt-0.5">▸ {it.note}</p> : null}
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
                                className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition-all disabled:opacity-40 ${order.status === s ? chipOnCls : chipOffCls}`}>
                                {STATUS_META[s].label}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="flex justify-between items-center pt-2 flex-wrap gap-2">
                    <div className="flex gap-2">
                        <button type="button" disabled={busy} onClick={() => onPaid(order.id, order.payment_status !== "paid")}
                            className={`px-3 py-1.5 rounded-xl font-bold text-xs transition-all disabled:opacity-50 ${order.payment_status === "paid" ? "bg-gray-100 text-gray-600 hover:bg-gray-200" : "bg-green-600 text-white hover:bg-green-700"}`}>
                            {order.payment_status === "paid" ? "Desmarcar pago" : "💵 Marcar pagado"}
                        </button>
                        <button type="button" disabled={busy} onClick={() => onDelete(order.id)} className="text-xs font-bold text-red-500 hover:text-red-700 px-2">Eliminar pedido</button>
                    </div>
                    <button type="button" onClick={onClose} className={btnGhostCls}>Cerrar</button>
                </div>
            </div>
        </Modal>
    );
}

// ---- configuración -------------------------------------------------------------------------------

function HoursEditor({ weekHours, onChange }) {
    const setRange = (day, idx, pos, value) => {
        const next = { ...weekHours };
        const ranges = (next[String(day)] || []).map((r) => r.slice());
        ranges[idx][pos] = value;
        next[String(day)] = ranges;
        onChange(next);
    };
    const addRange = (day) => {
        const next = { ...weekHours };
        const ranges = (next[String(day)] || []).map((r) => r.slice());
        if (ranges.length >= 3) return;
        ranges.push(ranges.length === 0 ? ["12:00", "22:00"] : ["18:00", "23:00"]);
        next[String(day)] = ranges;
        onChange(next);
    };
    const removeRange = (day, idx) => {
        const next = { ...weekHours };
        next[String(day)] = (next[String(day)] || []).filter((_, i) => i !== idx);
        onChange(next);
    };
    const copyToAll = (day) => {
        const src = (weekHours[String(day)] || []).map((r) => r.slice());
        const next = {};
        for (let d = 0; d <= 6; d++) next[String(d)] = src.map((r) => r.slice());
        onChange(next);
    };
    return (
        <div className="space-y-2">
            {DAY_ORDER.map((day) => {
                const ranges = weekHours[String(day)] || [];
                return (
                    <div key={day} className="flex items-center gap-3 flex-wrap bg-gray-50/60 rounded-2xl px-4 py-2.5">
                        <span className="w-24 text-xs font-black text-gray-700">{DAY_LABELS[day]}</span>
                        {ranges.length === 0 ? (
                            <span className="text-xs font-bold text-red-400 uppercase tracking-wider">Cerrado</span>
                        ) : (
                            ranges.map((r, i) => (
                                <span key={i} className="flex items-center gap-1.5">
                                    <input type="time" value={r[0]} onChange={(e) => setRange(day, i, 0, e.target.value)} className="px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-xs font-bold" />
                                    <span className="text-gray-400 text-xs">–</span>
                                    <input type="time" value={r[1]} onChange={(e) => setRange(day, i, 1, e.target.value)} className="px-2 py-1.5 bg-white border border-gray-200 rounded-lg text-xs font-bold" />
                                    <button type="button" onClick={() => removeRange(day, i)} className="text-red-400 hover:text-red-600 font-bold text-xs px-1">✕</button>
                                </span>
                            ))
                        )}
                        <button type="button" onClick={() => addRange(day)} disabled={ranges.length >= 3} className="text-[11px] font-black uppercase tracking-wider text-gray-400 hover:text-gray-900 disabled:opacity-30">+ Horario</button>
                        <div className="flex-1"></div>
                        <button type="button" onClick={() => copyToAll(day)} title="Copiar este horario a todos los días" className="text-[10px] font-bold text-gray-300 hover:text-gray-600">copiar a todos</button>
                    </div>
                );
            })}
            <p className="text-[11px] text-gray-400">Un cierre posterior a medianoche se escribe tal cual (ej. 20:00 – 02:00).</p>
        </div>
    );
}

function StripeKeyBox({ flash }) {
    const [hasKey, setHasKey] = useState(null);
    const [key, setKey] = useState("");
    const [busy, setBusy] = useState(false);
    const load = async () => {
        try { setHasKey((await api(`${BASE}/stripe-status`)).hasKey); } catch { setHasKey(false); }
    };
    useEffect(() => { load(); }, []);
    const save = async (value) => {
        setBusy(true);
        try {
            const out = await apiPost(`${BASE}/stripe-key`, { key: value });
            setHasKey(out.hasKey);
            setKey("");
            flash(value ? "Clave de Stripe guardada." : "Clave de Stripe eliminada.");
        } catch (e) {
            flash(`Error: ${e?.message || e}`);
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="bg-gray-50/60 rounded-2xl px-5 py-4 space-y-3">
            <p className="text-xs font-bold text-gray-500">
                Clave secreta de Stripe (sk_test_… / sk_live_…). Solo escritura: nunca se vuelve a mostrar.{" "}
                {hasKey === null ? "" : hasKey ? <span className="text-green-600 font-black">● Configurada</span> : <span className="text-gray-400 font-black">○ Sin configurar</span>}
            </p>
            <div className="flex gap-2 flex-wrap">
                <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk_test_…" className={`${inputCls} flex-1 min-w-[220px]`} autoComplete="off" />
                <button type="button" disabled={busy || !key.trim()} onClick={() => save(key.trim())} className={btnCls}>Guardar clave</button>
                {hasKey ? <button type="button" disabled={busy} onClick={() => save("")} className={btnGhostCls}>Quitar</button> : null}
            </div>
        </div>
    );
}

function ConfigForm({ initial, busy, onSave, flash }) {
    const [orderingEnabled, setOrderingEnabled] = useState(!!initial.orderingEnabled);
    const [whatsappNumber, setWhatsappNumber] = useState(initial.whatsappNumber || "");
    const [deliveryStr, setDeliveryStr] = useState(centsToInput(initial.deliveryCents));
    const [pickupLabel, setPickupLabel] = useState(initial.pickupLabel || "Recoger en local");
    const [deliveryLabel, setDeliveryLabel] = useState(initial.deliveryLabel || "Domicilio");
    const [notifyEmail, setNotifyEmail] = useState(initial.notifyEmail || "");
    const [currencySymbol, setCurrencySymbol] = useState(initial.currencySymbol || "$");
    const [currencyCode, setCurrencyCode] = useState(initial.currencyCode || "usd");
    // hours
    const [hoursEnabled, setHoursEnabled] = useState(!!initial.hoursEnabled);
    const [timezone, setTimezone] = useState(initial.timezone || "");
    const [weekHours, setWeekHours] = useState(initial.weekHours || {});
    const [closedMessage, setClosedMessage] = useState(initial.closedMessage || "");
    const [prepStr, setPrepStr] = useState(String(initial.prepMinutesDefault ?? 30));
    // table QR
    const [tableOrderingEnabled, setTableOrderingEnabled] = useState(!!initial.tableOrderingEnabled);
    const [menuPageUrl, setMenuPageUrl] = useState(initial.menuPageUrl || "");
    // reservations
    const [reservationsEnabled, setReservationsEnabled] = useState(!!initial.reservationsEnabled);
    const [partyMax, setPartyMax] = useState(String(initial.reservationPartyMax ?? 10));
    // payments + i18n
    const [payOnlineEnabled, setPayOnlineEnabled] = useState(!!initial.payOnlineEnabled);
    const [i18nEnabled, setI18nEnabled] = useState(!!initial.i18nEnabled);

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
            currencyCode: currencyCode.trim().toLowerCase() || "usd",
            hoursEnabled,
            timezone: timezone.trim(),
            weekHours,
            closedMessage: closedMessage.trim(),
            prepMinutesDefault: parseInt(prepStr, 10) || 0,
            tableOrderingEnabled,
            menuPageUrl: menuPageUrl.trim(),
            reservationsEnabled,
            reservationPartyMax: parseInt(partyMax, 10) || 10,
            payOnlineEnabled,
            i18nEnabled,
        });
    };

    const toggleRow = (checked, onToggle, title, hint) => (
        <label className="flex items-center justify-between gap-4 cursor-pointer select-none bg-gray-50 rounded-2xl px-5 py-4">
            <span>
                <span className="block font-black text-gray-900 text-sm">{title}</span>
                <span className="block text-xs text-gray-400 mt-0.5">{hint}</span>
            </span>
            <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} className="w-5 h-5 accent-gray-900" />
        </label>
    );

    return (
        <form onSubmit={submit} className="space-y-5">
            <div className={`${cardCls} p-6 sm:p-8 space-y-5`}>
                <h3 className="font-black text-gray-900 text-sm uppercase tracking-widest">Pedidos y entrega</h3>
                {toggleRow(orderingEnabled, setOrderingEnabled, "Pedidos en línea", "Habilita el carrito y el envío de pedidos desde el bloque del menú.")}
                <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Número de WhatsApp</label>
                        <input type="text" value={whatsappNumber} onChange={(e) => setWhatsappNumber(e.target.value)} placeholder="Ej. 573001234567 (con código de país)" className={inputCls} />
                        <p className="text-[11px] text-gray-400 mt-1.5">Solo dígitos, con código de país. El cliente enviará ahí el resumen del pedido.</p>
                    </div>
                    <div>
                        <label className={labelCls}>Email de notificación (opcional)</label>
                        <input type="email" value={notifyEmail} onChange={(e) => setNotifyEmail(e.target.value)} placeholder="pedidos@mirestaurante.com" className={inputCls} />
                        <p className="text-[11px] text-gray-400 mt-1.5">Se envía un correo por cada pedido o reserva nuevos.</p>
                    </div>
                </div>
                <div className="grid sm:grid-cols-3 gap-4">
                    <div>
                        <label className={labelCls}>Costo de domicilio</label>
                        <input type="text" inputMode="decimal" value={deliveryStr} onChange={(e) => setDeliveryStr(e.target.value)} placeholder="0.00" className={inputCls} />
                    </div>
                    <div>
                        <label className={labelCls}>Símbolo de moneda</label>
                        <input type="text" value={currencySymbol} onChange={(e) => setCurrencySymbol(e.target.value)} placeholder="$" maxLength={5} className={inputCls} />
                    </div>
                    <div>
                        <label className={labelCls}>Código ISO (para Stripe)</label>
                        <input type="text" value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} placeholder="usd, eur, cop…" maxLength={3} className={inputCls} />
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
            </div>

            <div className={`${cardCls} p-6 sm:p-8 space-y-5`}>
                <h3 className="font-black text-gray-900 text-sm uppercase tracking-widest">Horario de apertura</h3>
                {toggleRow(hoursEnabled, setHoursEnabled, "Aceptar pedidos solo en horario", "Fuera del horario el bloque muestra \"cerrado\" y rechaza pedidos.")}
                <div className="grid sm:grid-cols-3 gap-4">
                    <div>
                        <label className={labelCls}>Zona horaria (IANA)</label>
                        <input type="text" list="rm-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/Bogota (vacío = servidor)" className={inputCls} />
                        <datalist id="rm-tz">
                            {["America/Bogota", "America/Mexico_City", "America/Argentina/Buenos_Aires", "America/Santiago", "America/Lima", "Europe/Madrid", "America/New_York", "America/Los_Angeles"].map((z) => <option key={z} value={z} />)}
                        </datalist>
                    </div>
                    <div>
                        <label className={labelCls}>Preparación por defecto (min)</label>
                        <input type="number" min={0} max={600} value={prepStr} onChange={(e) => setPrepStr(e.target.value)} className={inputCls} />
                    </div>
                    <div>
                        <label className={labelCls}>Mensaje al estar cerrado (opcional)</label>
                        <input type="text" value={closedMessage} onChange={(e) => setClosedMessage(e.target.value)} maxLength={300} placeholder="Automático si se deja vacío" className={inputCls} />
                    </div>
                </div>
                <HoursEditor weekHours={weekHours} onChange={setWeekHours} />
            </div>

            <div className={`${cardCls} p-6 sm:p-8 space-y-5`}>
                <h3 className="font-black text-gray-900 text-sm uppercase tracking-widest">Pedidos en mesa (QR)</h3>
                {toggleRow(tableOrderingEnabled, setTableOrderingEnabled, "Pedidos desde la mesa", "Los clientes escanean el QR de su mesa y el pedido llega directo a Cocina.")}
                <div>
                    <label className={labelCls}>URL de la página del menú</label>
                    <input type="text" value={menuPageUrl} onChange={(e) => setMenuPageUrl(e.target.value)} placeholder="/menu o https://mirestaurante.com/menu" maxLength={600} className={inputCls} />
                    <p className="text-[11px] text-gray-400 mt-1.5">La página pública donde está el bloque del menú — los QR de las mesas apuntan ahí.</p>
                </div>
            </div>

            <div className={`${cardCls} p-6 sm:p-8 space-y-5`}>
                <h3 className="font-black text-gray-900 text-sm uppercase tracking-widest">Reservas</h3>
                {toggleRow(reservationsEnabled, setReservationsEnabled, "Reservas en línea", "El bloque muestra el botón \"Reservar mesa\". Las confirmas en la pestaña Reservas.")}
                <div className="max-w-xs">
                    <label className={labelCls}>Máximo de personas por reserva</label>
                    <input type="number" min={1} max={100} value={partyMax} onChange={(e) => setPartyMax(e.target.value)} className={inputCls} />
                </div>
            </div>

            <div className={`${cardCls} p-6 sm:p-8 space-y-5`}>
                <h3 className="font-black text-gray-900 text-sm uppercase tracking-widest">Pago en línea (Stripe)</h3>
                {toggleRow(payOnlineEnabled, setPayOnlineEnabled, "Ofrecer pago con tarjeta", "Además de WhatsApp/efectivo. Requiere la clave secreta de Stripe.")}
                <StripeKeyBox flash={flash} />
            </div>

            <div className={`${cardCls} p-6 sm:p-8 space-y-5`}>
                <h3 className="font-black text-gray-900 text-sm uppercase tracking-widest">Idiomas</h3>
                {toggleRow(i18nEnabled, setI18nEnabled, "Menú bilingüe (es/en)", "El bloque muestra un selector de idioma y usa los nombres en inglés cuando existan.")}
            </div>

            <div className="flex justify-end">
                <button type="submit" disabled={busy} className={btnCls}>{busy ? "Guardando…" : "Guardar configuración"}</button>
            </div>
        </form>
    );
}

// ---- page ------------------------------------------------------------------------------------------

export default function RestaurantAdminPage() {
    const [tab, setTab] = useState("menu"); // menu | modifiers | orders | kitchen | tables | reservations | reports | config
    const [sections, setSections] = useState(null);
    const [groups, setGroups] = useState([]);            // modifier groups (for the item modal)
    const [ordersData, setOrdersData] = useState(null);  // {orders, counts}
    const [config, setConfig] = useState(null);
    const [expanded, setExpanded] = useState({});
    const [showHistory, setShowHistory] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");

    const [sectionModal, setSectionModal] = useState(null);   // {section|null}
    const [itemModal, setItemModal] = useState(null);         // {item|null, sectionId}
    const [selectedOrder, setSelectedOrder] = useState(null);
    const flashTimer = React.useRef(null);

    const symbol = (config && config.currencySymbol) || "$";

    const flash = (msg) => {
        setMessage(msg);
        if (typeof window !== "undefined") {
            if (flashTimer.current) window.clearTimeout(flashTimer.current);
            flashTimer.current = window.setTimeout(() => setMessage(""), 4000);
        }
    };

    // The item modal offers modifier-group chips — refresh them on open so groups created or
    // deleted in the Modificadores tab are current (stale ids would 404 the attach call).
    const openItemModal = (item, sectionId) => {
        loadGroups();
        setItemModal({ item, sectionId });
    };

    const loadMenu = async () => {
        try {
            const data = await api(`${BASE}/admin/menu`);
            setSections(data.sections || []);
            setExpanded((prev) => {
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
    const loadGroups = async () => {
        try {
            const data = await api(`${BASE}/modifier-groups`);
            setGroups(data.groups || []);
        } catch (e) {
            setGroups([]);
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

    useEffect(() => { loadMenu(); loadGroups(); loadOrders(); loadConfig(); }, []);

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
    const saveItem = (payload, groupIds) => run(async () => {
        let itemId;
        if (itemModal && itemModal.item) {
            await apiPut(`${BASE}/items/${itemModal.item.id}`, payload);
            itemId = itemModal.item.id;
        } else {
            const out = await apiPost(`${BASE}/items`, payload);
            itemId = out && out.id;
        }
        if (itemId) await apiPut(`${BASE}/items/${itemId}/modifier-groups`, { group_ids: groupIds || [] });
        setItemModal(null);
        await loadMenu();
        await loadGroups(); // attach counters
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
    const setOrderPaid = (id, paid) => run(async () => {
        await apiPost(`${BASE}/orders/${id}/paid`, { paid });
        await loadOrders();
        setSelectedOrder((prev) => (prev && prev.id === id ? { ...prev, payment_status: paid ? "paid" : "none" } : prev));
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
        const pay = PAY_META[o.payment_method] || PAY_META.whatsapp;
        return (
            <div key={o.id} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm">
                <button type="button" className="w-full text-left" onClick={() => setSelectedOrder(o)}>
                    <div className="flex justify-between items-start gap-2">
                        <span className="font-black text-sm text-gray-900">#{o.id} · {o.customer_name}</span>
                        <span className="font-black text-sm tabular-nums">{fmtMoney(o.total_cents, symbol)}</span>
                    </div>
                    <p className="text-[11px] text-gray-400 font-bold mt-0.5">
                        {o.table_label ? `🪑 ${o.table_label}` : o.delivery_type === "delivery" ? "🛵 Domicilio" : "🏪 Recoger"}
                        {" · "}{(Array.isArray(o.items) ? o.items : []).reduce((n, it) => n + (it.qty || 0), 0)} items
                        {" · "}{pay.emoji}{o.payment_status === "paid" ? " ✓" : ""}
                        {" · "}{fmtDate(o.created_at)}
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
                    Menú · modificadores · pedidos en línea y en mesa · reservas · cocina en vivo · informes
                </p>
            </div>

            <div className="flex flex-wrap gap-2 mb-6">
                {tabBtn("menu", "Menú", 0)}
                {tabBtn("modifiers", "Modificadores", 0)}
                {tabBtn("orders", "Pedidos", counts.new || 0)}
                {tabBtn("kitchen", "Cocina", (counts.new || 0) + (counts.preparing || 0))}
                {tabBtn("tables", "Mesas", 0)}
                {tabBtn("reservations", "Reservas", 0)}
                {tabBtn("reports", "Informes", 0)}
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
                                        {s.name_en ? <span className="text-[10px] text-gray-300 font-bold ml-2">EN: {s.name_en}</span> : null}
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
                                                        <p className="text-xs text-gray-400 font-black tabular-nums">
                                                            {fmtMoney(it.price_cents, symbol)}
                                                            {it.prep_minutes > 0 ? <span className="font-bold text-gray-300 ml-2">⏱ {it.prep_minutes}m</span> : null}
                                                            {(it.modifier_group_ids || []).length > 0 ? <span className="font-bold text-purple-400 ml-2">⚙ {it.modifier_group_ids.length}</span> : null}
                                                            {tagsToArray(it.allergens).length > 0 ? <span className="font-bold text-amber-400 ml-2">⚠ {tagsToArray(it.allergens).length}</span> : null}
                                                        </p>
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
                                                        <button type="button" disabled={busy} onClick={() => openItemModal(it, s.id)} className={btnGhostCls}>Editar</button>
                                                        <button type="button" disabled={busy} onClick={() => deleteItem(it)} className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-500 rounded-xl font-bold text-xs">✕</button>
                                                    </div>
                                                </div>
                                            ))
                                        )}
                                        <div className="px-5 py-3">
                                            <button type="button" onClick={() => openItemModal(null, s.id)} className="text-xs font-black uppercase tracking-widest text-gray-400 hover:text-gray-900 transition-colors">+ Agregar plato</button>
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        ))
                    )}
                </div>
            ) : null}

            {/* ============================== MODIFICADORES ============================== */}
            {tab === "modifiers" ? <ModifiersTab flash={flash} symbol={symbol} /> : null}

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
                                                    {o.table_label ? <span className="text-[10px] font-black text-purple-500">🪑 {o.table_label}</span> : null}
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

            {/* ============================== COCINA ============================== */}
            {tab === "kitchen" ? <KitchenTab flash={flash} /> : null}

            {/* ============================== MESAS ============================== */}
            {tab === "tables" ? <TablesTab flash={flash} /> : null}

            {/* ============================== RESERVAS ============================== */}
            {tab === "reservations" ? <ReservationsTab flash={flash} /> : null}

            {/* ============================== INFORMES ============================== */}
            {tab === "reports" ? <ReportsTab flash={flash} symbol={symbol} /> : null}

            {/* ============================== CONFIGURACIÓN ============================== */}
            {tab === "config" ? (
                config === null ? (
                    <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>Cargando configuración…</div>
                ) : (
                    <ConfigForm initial={config} busy={busy} onSave={saveConfig} flash={flash} />
                )
            ) : null}

            {/* modals */}
            {sectionModal ? (
                <SectionModal initial={sectionModal.section} busy={busy} onSave={saveSection} onClose={() => setSectionModal(null)} />
            ) : null}
            {itemModal && sections ? (
                <ItemModal initial={itemModal.item} sections={sections} groups={groups} defaultSectionId={itemModal.sectionId} busy={busy} onSave={saveItem} onClose={() => setItemModal(null)} />
            ) : null}
            {selectedOrder ? (
                <OrderDetailModal order={selectedOrder} symbol={symbol} busy={busy} onStatus={setOrderStatus} onPaid={setOrderPaid} onDelete={deleteOrder} onClose={() => setSelectedOrder(null)} />
            ) : null}
        </div>
    );
}
