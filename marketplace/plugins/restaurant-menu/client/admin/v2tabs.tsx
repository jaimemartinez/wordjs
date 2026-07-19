// @ts-nocheck
"use client";

/**
 * v2 admin tabs: Modificadores, Cocina (live SSE board), Mesas (QR), Reservas, Informes.
 * Each tab is self-contained (loads its own data) and receives flash(msg) for feedback.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";
import {
    BASE, SSE_URL, inputCls, labelCls, btnCls, btnGhostCls, cardCls, chipOnCls, chipOffCls,
    STATUS_META, RES_STATUS_META, PAY_META,
    fmtMoney, centsToInput, inputToCentsSigned, fmtDate, todayISO, daysAgoISO, elapsedLabel,
    downloadText, Modal,
} from "./shared";
import { qrSvg } from "./qr";

// ================================================================================================
// MODIFICADORES
// ================================================================================================

function GroupModal({ initial, busy, onSave, onClose }) {
    const [name, setName] = useState(initial ? initial.name : "");
    const [nameEn, setNameEn] = useState(initial ? initial.name_en || "" : "");
    const [minSel, setMinSel] = useState(initial ? String(initial.min_select) : "0");
    const [maxSel, setMaxSel] = useState(initial ? String(initial.max_select) : "1");
    const submit = (e) => {
        e.preventDefault();
        onSave({
            name: name.trim(),
            name_en: nameEn.trim(),
            min_select: parseInt(minSel, 10) || 0,
            max_select: parseInt(maxSel, 10) || 1,
        });
    };
    return (
        <Modal title={initial ? "Editar grupo" : "Nuevo grupo de opciones"} onClose={onClose}>
            <form onSubmit={submit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Nombre</label>
                        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Tamaño, Extras…" className={inputCls} maxLength={120} required autoFocus />
                    </div>
                    <div>
                        <label className={labelCls}>Nombre en inglés (opcional)</label>
                        <input type="text" value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="Size, Extras…" className={inputCls} maxLength={120} />
                    </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Mínimo a elegir</label>
                        <input type="number" min={0} max={20} value={minSel} onChange={(e) => setMinSel(e.target.value)} className={inputCls} />
                        <p className="text-[11px] text-gray-400 mt-1.5">0 = opcional · 1+ = obligatorio</p>
                    </div>
                    <div>
                        <label className={labelCls}>Máximo a elegir</label>
                        <input type="number" min={1} max={20} value={maxSel} onChange={(e) => setMaxSel(e.target.value)} className={inputCls} />
                        <p className="text-[11px] text-gray-400 mt-1.5">1 = elegir uno (ej. tamaño)</p>
                    </div>
                </div>
                <div className="flex justify-end gap-3 pt-2">
                    <button type="button" onClick={onClose} className={btnGhostCls}>Cancelar</button>
                    <button type="submit" disabled={busy || !name.trim()} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>
            </form>
        </Modal>
    );
}

function OptionModal({ initial, busy, onSave, onClose }) {
    const [name, setName] = useState(initial ? initial.name : "");
    const [nameEn, setNameEn] = useState(initial ? initial.name_en || "" : "");
    const [deltaStr, setDeltaStr] = useState(initial ? centsToInput(initial.price_delta_cents) : "0.00");
    const submit = (e) => {
        e.preventDefault();
        const delta = inputToCentsSigned(deltaStr);
        if (delta === null) return;
        onSave({ name: name.trim(), name_en: nameEn.trim(), price_delta_cents: delta });
    };
    return (
        <Modal title={initial ? "Editar opción" : "Nueva opción"} onClose={onClose}>
            <form onSubmit={submit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Nombre</label>
                        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Grande, Queso extra…" className={inputCls} maxLength={120} required autoFocus />
                    </div>
                    <div>
                        <label className={labelCls}>Nombre en inglés (opcional)</label>
                        <input type="text" value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="Large, Extra cheese…" className={inputCls} maxLength={120} />
                    </div>
                </div>
                <div>
                    <label className={labelCls}>Precio adicional (puede ser 0 o negativo)</label>
                    <input type="text" inputMode="decimal" value={deltaStr} onChange={(e) => setDeltaStr(e.target.value)} placeholder="0.00" className={inputCls} />
                </div>
                <div className="flex justify-end gap-3 pt-2">
                    <button type="button" onClick={onClose} className={btnGhostCls}>Cancelar</button>
                    <button type="submit" disabled={busy || !name.trim() || inputToCentsSigned(deltaStr) === null} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>
            </form>
        </Modal>
    );
}

export function ModifiersTab({ flash, symbol }) {
    const [groups, setGroups] = useState(null);
    const [busy, setBusy] = useState(false);
    const [groupModal, setGroupModal] = useState(null); // {group|null}
    const [optionModal, setOptionModal] = useState(null); // {option|null, groupId}

    const load = async () => {
        try {
            const data = await api(`${BASE}/modifier-groups`);
            setGroups(data.groups || []);
        } catch (e) {
            setGroups([]);
            flash(`Error al cargar modificadores: ${e?.message || e}`);
        }
    };
    useEffect(() => { load(); }, []);

    const run = async (fn, okMsg) => {
        setBusy(true);
        try {
            await fn();
            if (okMsg) flash(okMsg);
            await load();
        } catch (e) {
            flash(`Error: ${e?.message || e}`);
        } finally {
            setBusy(false);
        }
    };

    const saveGroup = (payload) => run(async () => {
        if (groupModal && groupModal.group) await apiPut(`${BASE}/modifier-groups/${groupModal.group.id}`, payload);
        else await apiPost(`${BASE}/modifier-groups`, payload);
        setGroupModal(null);
    }, "Grupo guardado.");
    const saveOption = (payload) => run(async () => {
        if (optionModal && optionModal.option) await apiPut(`${BASE}/modifier-options/${optionModal.option.id}`, payload);
        else await apiPost(`${BASE}/modifier-options`, { ...payload, group_id: optionModal.groupId });
        setOptionModal(null);
    }, "Opción guardada.");
    const deleteGroup = (g) => {
        if (typeof window !== "undefined" && !window.confirm(`¿Eliminar el grupo "${g.name}" con sus opciones? Se quitará de todos los platos.`)) return;
        run(() => apiDelete(`${BASE}/modifier-groups/${g.id}`), "Grupo eliminado.");
    };
    const deleteOption = (o) => {
        if (typeof window !== "undefined" && !window.confirm(`¿Eliminar la opción "${o.name}"?`)) return;
        run(() => apiDelete(`${BASE}/modifier-options/${o.id}`), "Opción eliminada.");
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-gray-400 font-bold max-w-xl">
                    Los grupos (ej. "Tamaño", "Extras") se crean una vez y se asignan a los platos desde el botón Editar de cada plato en la pestaña Menú.
                </p>
                <button type="button" onClick={() => setGroupModal({ group: null })} className={btnCls}>+ Nuevo grupo</button>
            </div>

            {groups === null ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>Cargando…</div>
            ) : groups.length === 0 ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>
                    Sin grupos todavía. Crea "Tamaño" (mínimo 1, máximo 1) o "Extras" (mínimo 0) y agrégales opciones con precio.
                </div>
            ) : (
                groups.map((g, gi) => (
                    <div key={g.id} className={`${cardCls} overflow-hidden ${g.is_active ? "" : "opacity-60"}`}>
                        <div className="flex items-center gap-2 px-5 py-4 bg-gray-50/60 flex-wrap">
                            <h2 className="font-black text-gray-900 flex-1 truncate">
                                {g.name}
                                {g.name_en ? <span className="text-[11px] text-gray-400 font-bold ml-2">EN: {g.name_en}</span> : null}
                            </h2>
                            <span className="text-[10px] font-black uppercase tracking-wider text-gray-400 bg-white border border-gray-200 rounded-full px-2.5 py-1">
                                {g.min_select === 0 ? "Opcional" : `Mín ${g.min_select}`} · Máx {g.max_select}
                            </span>
                            <span className="text-[10px] font-black uppercase tracking-wider text-gray-400 bg-white border border-gray-200 rounded-full px-2.5 py-1">
                                En {g.attached_items} plato{g.attached_items === 1 ? "" : "s"}
                            </span>
                            <button type="button" disabled={busy || gi === 0} onClick={() => run(() => apiPost(`${BASE}/modifier-groups/${g.id}/move`, { dir: "up" }))} className={btnGhostCls}>↑</button>
                            <button type="button" disabled={busy || gi === groups.length - 1} onClick={() => run(() => apiPost(`${BASE}/modifier-groups/${g.id}/move`, { dir: "down" }))} className={btnGhostCls}>↓</button>
                            <button type="button" disabled={busy} onClick={() => run(() => apiPut(`${BASE}/modifier-groups/${g.id}`, { is_active: !g.is_active }))} className={btnGhostCls}>
                                {g.is_active ? "Desactivar" : "Activar"}
                            </button>
                            <button type="button" disabled={busy} onClick={() => setGroupModal({ group: g })} className={btnGhostCls}>Editar</button>
                            <button type="button" disabled={busy} onClick={() => deleteGroup(g)} className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-500 rounded-xl font-bold text-xs">✕</button>
                        </div>
                        <div className="divide-y divide-gray-50">
                            {(g.options || []).length === 0 ? (
                                <p className="px-5 py-4 text-sm text-gray-400">Sin opciones en este grupo.</p>
                            ) : (
                                g.options.map((o, oi) => (
                                    <div key={o.id} className={`px-5 py-2.5 flex items-center gap-3 flex-wrap ${o.is_available ? "" : "opacity-50"}`}>
                                        <span className="font-bold text-sm text-gray-900 flex-1 min-w-[120px] truncate">
                                            {o.name}
                                            {o.name_en ? <span className="text-[11px] text-gray-400 font-bold ml-2">EN: {o.name_en}</span> : null}
                                        </span>
                                        <span className={`font-black text-xs tabular-nums ${o.price_delta_cents < 0 ? "text-green-600" : "text-gray-500"}`}>
                                            {o.price_delta_cents === 0 ? "±0" : (o.price_delta_cents > 0 ? "+" : "") + fmtMoney(o.price_delta_cents, symbol)}
                                        </span>
                                        <label className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-gray-400 cursor-pointer select-none">
                                            <input type="checkbox" checked={!!o.is_available} disabled={busy} onChange={() => run(() => apiPut(`${BASE}/modifier-options/${o.id}`, { is_available: !o.is_available }))} className="w-4 h-4 accent-green-600" />
                                            Disponible
                                        </label>
                                        <div className="flex gap-1.5">
                                            <button type="button" disabled={busy || oi === 0} onClick={() => run(() => apiPost(`${BASE}/modifier-options/${o.id}/move`, { dir: "up" }))} className={btnGhostCls}>↑</button>
                                            <button type="button" disabled={busy || oi === g.options.length - 1} onClick={() => run(() => apiPost(`${BASE}/modifier-options/${o.id}/move`, { dir: "down" }))} className={btnGhostCls}>↓</button>
                                            <button type="button" disabled={busy} onClick={() => setOptionModal({ option: o, groupId: g.id })} className={btnGhostCls}>Editar</button>
                                            <button type="button" disabled={busy} onClick={() => deleteOption(o)} className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-500 rounded-xl font-bold text-xs">✕</button>
                                        </div>
                                    </div>
                                ))
                            )}
                            <div className="px-5 py-3">
                                <button type="button" onClick={() => setOptionModal({ option: null, groupId: g.id })} className="text-xs font-black uppercase tracking-widest text-gray-400 hover:text-gray-900 transition-colors">
                                    + Agregar opción
                                </button>
                            </div>
                        </div>
                    </div>
                ))
            )}

            {groupModal ? <GroupModal initial={groupModal.group} busy={busy} onSave={saveGroup} onClose={() => setGroupModal(null)} /> : null}
            {optionModal ? <OptionModal initial={optionModal.option} busy={busy} onSave={saveOption} onClose={() => setOptionModal(null)} /> : null}
        </div>
    );
}

// ================================================================================================
// COCINA (live board)
// ================================================================================================

export function KitchenTab({ flash }) {
    const [orders, setOrders] = useState(null);
    const [busy, setBusy] = useState(false);
    const [live, setLive] = useState(false);
    const [now, setNow] = useState(Date.now());
    const loadedAt = useRef(Date.now());

    const load = async () => {
        try {
            const data = await api(`${BASE}/kitchen`);
            loadedAt.current = Date.now();
            setOrders(data.orders || []);
        } catch (e) {
            // Keep the last-known board on transient failures; only seed [] on the very first load.
            setOrders((prev) => (prev === null ? [] : prev));
        }
    };

    useEffect(() => {
        load();
        // Real-time: the plugin broadcasts zero-PII 'restaurant_*' events on the core SSE bus.
        let es = null;
        try {
            es = new EventSource(SSE_URL, { withCredentials: true });
            es.onopen = () => setLive(true);
            es.onerror = () => setLive(false);
            es.onmessage = (ev) => {
                if (!ev.data || ev.data.startsWith(":")) return;
                try {
                    const n = JSON.parse(ev.data);
                    if (n && typeof n.type === "string" && n.type.indexOf("restaurant_") === 0) load();
                } catch { /* non-JSON frame */ }
            };
        } catch { setLive(false); }
        const poll = setInterval(load, 20000);      // fallback when SSE is unavailable
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => {
            if (es) es.close();
            clearInterval(poll);
            clearInterval(tick);
        };
    }, []);

    const setStatus = async (id, status) => {
        setBusy(true);
        try {
            await apiPost(`${BASE}/orders/${id}/status`, { status });
            await load();
        } catch (e) {
            flash(`Error: ${e?.message || e}`);
        } finally {
            setBusy(false);
        }
    };

    const cols = useMemo(() => ({
        new: (orders || []).filter((o) => o.status === "new"),
        preparing: (orders || []).filter((o) => o.status === "preparing"),
        ready: (orders || []).filter((o) => o.status === "ready"),
    }), [orders]);

    const ageOf = (o) => (o.age_seconds || 0) + (now - loadedAt.current) / 1000;

    const card = (o) => {
        const age = ageOf(o);
        const late = age > 20 * 60;
        const next = o.status === "new" ? { s: "preparing", label: "Preparar →" }
            : o.status === "preparing" ? { s: "ready", label: "Listo →" }
            : { s: "delivered", label: "Entregado ✓" };
        const pay = PAY_META[o.payment_method] || PAY_META.whatsapp;
        return (
            <div key={o.id} className={`bg-white border-2 rounded-2xl p-4 shadow-sm ${o.status === "new" ? "border-blue-200" : late ? "border-red-300" : "border-gray-100"}`}>
                <div className="flex justify-between items-start gap-2 flex-wrap">
                    <span className="font-black text-lg text-gray-900">#{o.id}</span>
                    <div className="flex items-center gap-2">
                        {o.table_label ? (
                            <span className="px-2.5 py-1 rounded-full text-[11px] font-black bg-purple-50 text-purple-700 border border-purple-200">🪑 {o.table_label}</span>
                        ) : (
                            <span className="px-2.5 py-1 rounded-full text-[11px] font-black bg-gray-50 text-gray-500 border border-gray-200">
                                {o.delivery_type === "delivery" ? "🛵 Domicilio" : "🏪 Recoger"}
                            </span>
                        )}
                        <span className={`px-2.5 py-1 rounded-full text-[11px] font-black tabular-nums ${late ? "bg-red-50 text-red-600 border border-red-200" : "bg-gray-50 text-gray-500 border border-gray-200"}`}>
                            ⏱ {elapsedLabel(age)}
                        </span>
                    </div>
                </div>
                <p className="text-[11px] text-gray-400 font-bold mt-1">
                    {o.customer_name} · {pay.emoji} {pay.label}
                    {o.payment_status === "paid" ? <span className="text-green-600 ml-1">· PAGADO ✓</span> : null}
                    {o.payment_status === "pending" ? <span className="text-amber-600 ml-1">· pago pendiente</span> : null}
                </p>
                <div className="mt-3 space-y-1.5">
                    {(Array.isArray(o.items) ? o.items : []).map((it, i) => (
                        <div key={i} className="text-[15px] leading-snug">
                            <span className="font-black">{it.qty}×</span> <span className="font-bold">{it.name}</span>
                            {(it.options || []).length > 0 ? (
                                <span className="text-gray-500 text-[13px]"> · {it.options.map((x) => x.name).join(", ")}</span>
                            ) : null}
                            {it.note ? <p className="text-[12px] text-amber-700 font-bold ml-5">▸ {it.note}</p> : null}
                        </div>
                    ))}
                </div>
                {o.notes ? <p className="mt-2 text-[12px] bg-amber-50 text-amber-700 rounded-xl px-3 py-2 font-bold">📝 {o.notes}</p> : null}
                <div className="flex gap-2 mt-3">
                    <button type="button" disabled={busy} onClick={() => setStatus(o.id, next.s)} className="flex-1 px-3 py-2.5 bg-gray-900 hover:bg-orange-600 text-white rounded-xl font-black text-xs uppercase tracking-wider transition-all disabled:opacity-50">
                        {next.label}
                    </button>
                    {o.status !== "ready" ? (
                        <button type="button" disabled={busy} onClick={() => { if (typeof window === "undefined" || window.confirm(`¿Cancelar el pedido #${o.id}?`)) setStatus(o.id, "cancelled"); }} className="px-3 py-2.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl font-black text-xs uppercase tracking-wider transition-all disabled:opacity-50">
                            ✕
                        </button>
                    ) : null}
                </div>
            </div>
        );
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
                <span className={`px-3 py-1.5 rounded-full text-[11px] font-black border ${live ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-50 text-gray-400 border-gray-200"}`}>
                    {live ? "● En vivo" : "○ Actualizando cada 20 s"}
                </span>
                <button type="button" onClick={load} className={btnGhostCls}>⟳ Actualizar</button>
            </div>
            {orders === null ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>Cargando cocina…</div>
            ) : (
                <div className="grid lg:grid-cols-3 gap-4">
                    {["new", "preparing", "ready"].map((st) => (
                        <div key={st} className="bg-gray-50/80 rounded-3xl p-4 border border-gray-100">
                            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3 flex items-center justify-between">
                                {STATUS_META[st].label}
                                <span className={`px-2 py-0.5 rounded-full border text-[10px] ${STATUS_META[st].color}`}>{cols[st].length}</span>
                            </p>
                            <div className="space-y-3">
                                {cols[st].length === 0 ? <p className="text-xs text-gray-300 text-center py-6">Sin pedidos</p> : cols[st].map(card)}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ================================================================================================
// MESAS (QR)
// ================================================================================================

function tableUrl(menuPageUrl, token) {
    let base = String(menuPageUrl || "").trim();
    if (!base && typeof window !== "undefined") base = `${window.location.origin}/`;
    if (base.startsWith("/") && typeof window !== "undefined") base = `${window.location.origin}${base}`;
    // The token must live in the query string, never after a #fragment (the block reads searchParams).
    let hash = "";
    const hashAt = base.indexOf("#");
    if (hashAt >= 0) {
        hash = base.slice(hashAt);
        base = base.slice(0, hashAt);
    }
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}rm_table=${token}${hash}`;
}

function QRModal({ table, menuPageUrl, onClose }) {
    const url = tableUrl(menuPageUrl, table.token);
    const svg = qrSvg(url, 5);
    return (
        <Modal title={`QR — ${table.label}`} onClose={onClose}>
            <div className="text-center space-y-4">
                {svg ? (
                    <div className="inline-block border border-gray-100 rounded-2xl p-2 bg-white" dangerouslySetInnerHTML={{ __html: svg }} />
                ) : (
                    <p className="text-sm text-red-500">No se pudo generar el QR (URL demasiado larga).</p>
                )}
                <p className="text-xs text-gray-500 break-all font-mono bg-gray-50 rounded-xl px-3 py-2">{url}</p>
                {!menuPageUrl ? (
                    <p className="text-[11px] text-amber-600 font-bold">
                        ⚠ Configura la "URL de la página del menú" en Configuración para que el QR apunte a la página correcta.
                    </p>
                ) : null}
                <button type="button" onClick={onClose} className={btnGhostCls}>Cerrar</button>
            </div>
        </Modal>
    );
}

/** Print sheet: opens a minimal document with one QR card per active table and calls print(). */
function printAllQRs(tables, menuPageUrl) {
    if (typeof window === "undefined") return;
    const w = window.open("", "_blank", "noopener=false");
    if (!w) return;
    const cards = tables.filter((t) => t.is_active).map((t) => {
        const url = tableUrl(menuPageUrl, t.token);
        const svg = qrSvg(url, 4);
        if (!svg) return `<div class="card"><h2>${String(t.label).replace(/[<>&]/g, "")}</h2><p>⚠ URL demasiado larga para el QR — acorta la URL del menú</p></div>`;
        return `<div class="card"><div class="qr">${svg}</div><h2>${String(t.label).replace(/[<>&]/g, "")}</h2><p>Escanea para ver el menú y pedir</p></div>`;
    }).join("");
    w.document.write(`<!doctype html><html><head><title>QR mesas</title><style>
        body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; }
        .grid { display: flex; flex-wrap: wrap; gap: 16px; }
        .card { border: 2px dashed #bbb; border-radius: 16px; padding: 18px 22px; text-align: center; page-break-inside: avoid; }
        .card h2 { margin: 10px 0 2px; font-size: 20px; }
        .card p { margin: 0; color: #666; font-size: 12px; }
        .qr svg { width: 180px; height: 180px; }
    </style></head><body><div class="grid">${cards}</div><script>window.onload=function(){window.print();}<\/script></body></html>`);
    w.document.close();
}

export function TablesTab({ flash }) {
    const [tables, setTables] = useState(null);
    const [menuPageUrl, setMenuPageUrl] = useState("");
    const [label, setLabel] = useState("");
    const [busy, setBusy] = useState(false);
    const [qrModal, setQrModal] = useState(null);

    const load = async () => {
        try {
            const data = await api(`${BASE}/tables`);
            setTables(data.tables || []);
            setMenuPageUrl(data.menuPageUrl || "");
        } catch (e) {
            setTables([]);
        }
    };
    useEffect(() => { load(); }, []);

    const run = async (fn, okMsg) => {
        setBusy(true);
        try {
            await fn();
            if (okMsg) flash(okMsg);
            await load();
        } catch (e) {
            flash(`Error: ${e?.message || e}`);
        } finally {
            setBusy(false);
        }
    };

    const addTable = (e) => {
        e.preventDefault();
        if (!label.trim()) return;
        run(async () => {
            await apiPost(`${BASE}/tables`, { label: label.trim() });
            setLabel("");
        }, "Mesa creada.");
    };

    return (
        <div className="space-y-4">
            <form onSubmit={addTable} className={`${cardCls} p-5 flex items-end gap-3 flex-wrap`}>
                <div className="flex-1 min-w-[200px]">
                    <label className={labelCls}>Nueva mesa</label>
                    <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ej. Mesa 1, Terraza 3, Barra…" className={inputCls} maxLength={60} />
                </div>
                <button type="submit" disabled={busy || !label.trim()} className={btnCls}>+ Crear</button>
                <button type="button" disabled={busy || !tables || tables.filter((t) => t.is_active).length === 0} onClick={() => printAllQRs(tables || [], menuPageUrl)} className={btnGhostCls}>
                    🖨 Imprimir todos los QR
                </button>
            </form>

            {!menuPageUrl ? (
                <div className="bg-amber-50 text-amber-700 rounded-2xl px-4 py-3 text-xs font-bold">
                    ⚠ Aún no configuraste la "URL de la página del menú" (Configuración → Pedidos en mesa). Los QR usarán la portada del sitio.
                </div>
            ) : null}

            {tables === null ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>Cargando mesas…</div>
            ) : tables.length === 0 ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>
                    Sin mesas. Crea una mesa y pega su QR en la mesa física: los clientes escanean, piden y el pedido llega directo a Cocina.
                </div>
            ) : (
                <div className={`${cardCls} divide-y divide-gray-50`}>
                    {tables.map((t, ti) => (
                        <div key={t.id} className={`px-5 py-3 flex items-center gap-3 flex-wrap ${t.is_active ? "" : "opacity-50"}`}>
                            <span className="font-black text-sm text-gray-900 flex-1 min-w-[120px] truncate">🪑 {t.label}</span>
                            <button type="button" onClick={() => setQrModal(t)} className={btnGhostCls}>Ver QR</button>
                            <label className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-gray-400 cursor-pointer select-none">
                                <input type="checkbox" checked={!!t.is_active} disabled={busy} onChange={() => run(() => apiPut(`${BASE}/tables/${t.id}`, { is_active: !t.is_active }))} className="w-4 h-4 accent-green-600" />
                                Activa
                            </label>
                            <div className="flex gap-1.5">
                                <button type="button" disabled={busy || ti === 0} onClick={() => run(() => apiPost(`${BASE}/tables/${t.id}/move`, { dir: "up" }))} className={btnGhostCls}>↑</button>
                                <button type="button" disabled={busy || ti === tables.length - 1} onClick={() => run(() => apiPost(`${BASE}/tables/${t.id}/move`, { dir: "down" }))} className={btnGhostCls}>↓</button>
                                <button type="button" disabled={busy} title="Regenerar el enlace (invalida el QR impreso)" onClick={() => { if (typeof window === "undefined" || window.confirm("¿Regenerar el enlace? El QR impreso dejará de funcionar.")) run(() => apiPut(`${BASE}/tables/${t.id}`, { regenerate_token: true }), "Enlace regenerado."); }} className={btnGhostCls}>⟳</button>
                                <button type="button" disabled={busy} onClick={() => { if (typeof window === "undefined" || window.confirm(`¿Eliminar la mesa "${t.label}"?`)) run(() => apiDelete(`${BASE}/tables/${t.id}`), "Mesa eliminada."); }} className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-500 rounded-xl font-bold text-xs">✕</button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {qrModal ? <QRModal table={qrModal} menuPageUrl={menuPageUrl} onClose={() => setQrModal(null)} /> : null}
        </div>
    );
}

// ================================================================================================
// RESERVAS
// ================================================================================================

function ReservationModal({ busy, onSave, onClose }) {
    const [name, setName] = useState("");
    const [phone, setPhone] = useState("");
    const [email, setEmail] = useState("");
    const [date, setDate] = useState(todayISO());
    const [time, setTime] = useState("19:00");
    const [party, setParty] = useState("2");
    const [notes, setNotes] = useState("");
    const submit = (e) => {
        e.preventDefault();
        onSave({
            customer_name: name.trim(),
            customer_phone: phone.trim(),
            customer_email: email.trim(),
            date, time,
            party_size: parseInt(party, 10) || 2,
            notes: notes.trim(),
            status: "confirmed",
        });
    };
    return (
        <Modal title="Nueva reserva (manual)" onClose={onClose}>
            <form onSubmit={submit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Nombre</label>
                        <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} maxLength={120} required autoFocus />
                    </div>
                    <div>
                        <label className={labelCls}>Teléfono</label>
                        <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} maxLength={30} />
                    </div>
                </div>
                <div>
                    <label className={labelCls}>Email (opcional — para enviar confirmación)</label>
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} maxLength={200} />
                </div>
                <div className="grid grid-cols-3 gap-4">
                    <div>
                        <label className={labelCls}>Fecha</label>
                        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} required />
                    </div>
                    <div>
                        <label className={labelCls}>Hora</label>
                        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputCls} required />
                    </div>
                    <div>
                        <label className={labelCls}>Personas</label>
                        <input type="number" min={1} max={200} value={party} onChange={(e) => setParty(e.target.value)} className={inputCls} required />
                    </div>
                </div>
                <div>
                    <label className={labelCls}>Notas</label>
                    <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} maxLength={500} />
                </div>
                <div className="flex justify-end gap-3 pt-2">
                    <button type="button" onClick={onClose} className={btnGhostCls}>Cancelar</button>
                    <button type="submit" disabled={busy || !name.trim()} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>
            </form>
        </Modal>
    );
}

export function ReservationsTab({ flash }) {
    const [data, setData] = useState(null); // {reservations, counts, today}
    const [busy, setBusy] = useState(false);
    const [dateFilter, setDateFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [showAll, setShowAll] = useState(false);
    const [modal, setModal] = useState(false);

    const load = async (date = dateFilter, status = statusFilter, all = showAll) => {
        try {
            const params = new URLSearchParams();
            if (date) params.set("date", date);
            if (status) params.set("status", status);
            if (all) params.set("all", "1");
            const qs = params.toString();
            setData(await api(`${BASE}/reservations${qs ? `?${qs}` : ""}`));
        } catch (e) {
            setData({ reservations: [], counts: {}, today: todayISO() });
        }
    };
    useEffect(() => { load(); }, []);

    const run = async (fn, okMsg) => {
        setBusy(true);
        try {
            const out = await fn();
            if (okMsg) flash(okMsg + (out && out.mailNote ? ` (${out.mailNote})` : ""));
            await load();
        } catch (e) {
            flash(`Error: ${e?.message || e}`);
        } finally {
            setBusy(false);
        }
    };

    const counts = (data && data.counts) || {};
    const rows = (data && data.reservations) || [];

    return (
        <div className="space-y-4">
            <div className="flex items-end gap-3 flex-wrap">
                <div>
                    <label className={labelCls}>Día</label>
                    <input type="date" value={dateFilter} onChange={(e) => { setDateFilter(e.target.value); load(e.target.value, statusFilter, showAll); }} className={inputCls} />
                </div>
                <div className="flex gap-1.5 flex-wrap items-center pb-1">
                    <button type="button" onClick={() => { setStatusFilter(""); load(dateFilter, "", showAll); }}
                        className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition-all ${statusFilter === "" ? chipOnCls : chipOffCls}`}>
                        Todas
                    </button>
                    {Object.keys(RES_STATUS_META).map((s) => (
                        <button key={s} type="button" onClick={() => { setStatusFilter(s); load(dateFilter, s, showAll); }}
                            className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition-all ${statusFilter === s ? chipOnCls : chipOffCls}`}>
                            {RES_STATUS_META[s].label} {counts[s] ? `(${counts[s]})` : ""}
                        </button>
                    ))}
                    <label className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-gray-400 cursor-pointer select-none ml-2">
                        <input type="checkbox" checked={showAll} onChange={(e) => { setShowAll(e.target.checked); load(dateFilter, statusFilter, e.target.checked); }} className="w-4 h-4 accent-gray-900" />
                        Incluir pasadas
                    </label>
                </div>
                <div className="flex-1"></div>
                <button type="button" onClick={() => setModal(true)} className={btnCls}>+ Reserva manual</button>
            </div>

            {data === null ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>Cargando reservas…</div>
            ) : rows.length === 0 ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>Sin reservas para el filtro elegido.</div>
            ) : (
                <div className={`${cardCls} divide-y divide-gray-50`}>
                    {rows.map((r) => {
                        const meta = RES_STATUS_META[r.status] || RES_STATUS_META.pending;
                        const isToday = data && r.reserved_date === data.today;
                        return (
                            <div key={r.id} className="px-5 py-3.5 flex items-center gap-3 flex-wrap">
                                <div className="text-center min-w-[76px]">
                                    <p className={`text-sm font-black ${isToday ? "text-orange-600" : "text-gray-900"}`}>{isToday ? "HOY" : r.reserved_date}</p>
                                    <p className="text-lg font-black tabular-nums leading-none">{r.reserved_time}</p>
                                </div>
                                <div className="flex-1 min-w-[160px]">
                                    <p className="font-bold text-sm text-gray-900 truncate">
                                        {r.customer_name} <span className="text-gray-400 font-black">· {r.party_size}p</span>
                                    </p>
                                    <p className="text-xs text-gray-400 font-bold truncate">
                                        {r.customer_phone}{r.customer_email ? ` · ${r.customer_email}` : ""}{r.notes ? ` · 📝 ${r.notes}` : ""}
                                    </p>
                                </div>
                                <span className={`px-3 py-1 rounded-full text-xs font-black border ${meta.color}`}>{meta.label}</span>
                                <div className="flex gap-1.5 flex-wrap">
                                    {r.status === "pending" ? (
                                        <button type="button" disabled={busy} onClick={() => run(() => apiPost(`${BASE}/reservations/${r.id}/status`, { status: "confirmed" }), "Reserva confirmada.")} className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-xl font-black text-[11px] uppercase tracking-wider disabled:opacity-50">
                                            Confirmar
                                        </button>
                                    ) : null}
                                    {(r.status === "pending" || r.status === "confirmed") ? (
                                        <>
                                            <button type="button" disabled={busy} onClick={() => run(() => apiPost(`${BASE}/reservations/${r.id}/status`, { status: "completed" }))} className={btnGhostCls}>Completada</button>
                                            <button type="button" disabled={busy} onClick={() => run(() => apiPost(`${BASE}/reservations/${r.id}/status`, { status: "no_show" }))} className={btnGhostCls}>No llegó</button>
                                            <button type="button" disabled={busy} onClick={() => run(() => apiPost(`${BASE}/reservations/${r.id}/status`, { status: "cancelled" }))} className="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl font-bold text-[11px] uppercase tracking-wider disabled:opacity-50">
                                                Cancelar
                                            </button>
                                        </>
                                    ) : null}
                                    <button type="button" disabled={busy} onClick={() => { if (typeof window === "undefined" || window.confirm("¿Eliminar esta reserva definitivamente?")) run(() => apiDelete(`${BASE}/reservations/${r.id}`), "Reserva eliminada."); }} className="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-500 rounded-xl font-bold text-xs">✕</button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {modal ? (
                <ReservationModal busy={busy} onClose={() => setModal(false)} onSave={(payload) => run(async () => {
                    await apiPost(`${BASE}/reservations`, payload);
                    setModal(false);
                }, "Reserva creada.")} />
            ) : null}
        </div>
    );
}

// ================================================================================================
// INFORMES
// ================================================================================================

function Tile({ label, value, accent }) {
    return (
        <div className={`${cardCls} p-5`}>
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">{label}</p>
            <p className={`text-2xl font-black tabular-nums mt-1 ${accent || "text-gray-900"}`}>{value}</p>
        </div>
    );
}

function BarRow({ values, labels, title }) {
    const max = Math.max(1, ...values);
    return (
        <div className={`${cardCls} p-5`}>
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">{title}</p>
            <div className="flex items-end gap-[3px] h-24">
                {values.map((v, i) => (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1" title={`${labels[i]}: ${v}`}>
                        <div className="w-full bg-orange-500/80 rounded-t-md min-h-[2px]" style={{ height: `${Math.round((v / max) * 88)}px` }}></div>
                    </div>
                ))}
            </div>
            <div className="flex gap-[3px] mt-1">
                {labels.map((l, i) => (
                    <span key={i} className="flex-1 text-center text-[8px] font-bold text-gray-400 overflow-hidden">{l}</span>
                ))}
            </div>
        </div>
    );
}

export function ReportsTab({ flash, symbol }) {
    const [from, setFrom] = useState(daysAgoISO(29));
    const [to, setTo] = useState(todayISO());
    const [report, setReport] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = async (f = from, t = to) => {
        setBusy(true);
        try {
            setReport(await api(`${BASE}/reports?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`));
        } catch (e) {
            flash(`Error al cargar informes: ${e?.message || e}`);
        } finally {
            setBusy(false);
        }
    };
    useEffect(() => { load(); }, []);

    const exportCsv = async () => {
        setBusy(true);
        try {
            const data = await api(`${BASE}/reports/csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
            downloadText(data.filename || "pedidos.csv", data.csv || "");
        } catch (e) {
            flash(`Error al exportar: ${e?.message || e}`);
        } finally {
            setBusy(false);
        }
    };

    const r = report;
    const money = (c) => fmtMoney(c, symbol);

    return (
        <div className="space-y-4">
            <div className="flex items-end gap-3 flex-wrap">
                <div>
                    <label className={labelCls}>Desde</label>
                    <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
                </div>
                <div>
                    <label className={labelCls}>Hasta</label>
                    <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
                </div>
                <button type="button" disabled={busy} onClick={() => load()} className={btnCls}>{busy ? "Cargando…" : "Aplicar"}</button>
                <div className="flex-1"></div>
                <button type="button" disabled={busy || !r} onClick={exportCsv} className={btnGhostCls}>⬇ Exportar CSV</button>
            </div>

            {!r ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>Cargando informes…</div>
            ) : (
                <>
                    <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
                        <Tile label="Pedidos" value={r.totals.orders} />
                        <Tile label="Ingresos" value={money(r.totals.revenue_cents)} accent="text-green-700" />
                        <Tile label="Ticket promedio" value={money(r.totals.avg_ticket_cents)} />
                        <Tile label="Cobrado en línea" value={money(r.totals.paid_online_cents)} />
                        <Tile label="Cancelados" value={r.totals.cancelled} accent={r.totals.cancelled > 0 ? "text-red-500" : "text-gray-900"} />
                    </div>

                    <div className="grid lg:grid-cols-2 gap-4">
                        <BarRow
                            title="Ventas por día"
                            values={r.byDay.map((d) => d.revenue_cents / 100)}
                            labels={r.byDay.map((d) => d.date.slice(5))}
                        />
                        <BarRow
                            title="Horas pico (pedidos por hora local)"
                            values={r.peakHours}
                            labels={r.peakHours.map((_, h) => (h % 3 === 0 ? String(h) : ""))}
                        />
                    </div>

                    <div className="grid lg:grid-cols-2 gap-4">
                        <div className={`${cardCls} p-5`}>
                            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">Platos más vendidos</p>
                            {r.topDishes.length === 0 ? (
                                <p className="text-sm text-gray-400">Sin ventas en el rango.</p>
                            ) : (
                                <div className="divide-y divide-gray-50">
                                    {r.topDishes.map((d, i) => (
                                        <div key={i} className="flex items-center gap-3 py-2 text-sm">
                                            <span className="w-6 text-center font-black text-gray-300">{i + 1}</span>
                                            <span className="flex-1 font-bold text-gray-900 truncate">{d.name}</span>
                                            <span className="font-black text-gray-500 tabular-nums">{d.qty} uds</span>
                                            <span className="font-black tabular-nums">{money(d.revenue_cents)}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div className="space-y-4">
                            <div className={`${cardCls} p-5`}>
                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">Cómo pagan</p>
                                <div className="flex gap-2 flex-wrap">
                                    {Object.keys(PAY_META).map((k) => (
                                        <span key={k} className="px-3 py-1.5 rounded-full text-xs font-black bg-gray-50 border border-gray-200 text-gray-600">
                                            {PAY_META[k].emoji} {PAY_META[k].label}: {r.byPayment[k] || 0}
                                        </span>
                                    ))}
                                </div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mt-4 mb-2">De dónde vienen</p>
                                <div className="flex gap-2 flex-wrap">
                                    <span className="px-3 py-1.5 rounded-full text-xs font-black bg-gray-50 border border-gray-200 text-gray-600">🌐 Web: {r.bySource.web || 0}</span>
                                    <span className="px-3 py-1.5 rounded-full text-xs font-black bg-gray-50 border border-gray-200 text-gray-600">🪑 Mesa (QR): {r.bySource.table || 0}</span>
                                    <span className="px-3 py-1.5 rounded-full text-xs font-black bg-gray-50 border border-gray-200 text-gray-600">🏪 Recoger: {r.byType.pickup || 0}</span>
                                    <span className="px-3 py-1.5 rounded-full text-xs font-black bg-gray-50 border border-gray-200 text-gray-600">🛵 Domicilio: {r.byType.delivery || 0}</span>
                                </div>
                            </div>
                            <div className={`${cardCls} p-5`}>
                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">Reservas en el rango</p>
                                <div className="flex gap-2 flex-wrap">
                                    {Object.keys(RES_STATUS_META).map((s) => (
                                        <span key={s} className={`px-3 py-1.5 rounded-full text-xs font-black border ${RES_STATUS_META[s].color}`}>
                                            {RES_STATUS_META[s].label}: {r.reservations[s] || 0}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
