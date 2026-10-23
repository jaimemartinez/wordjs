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
import { useT } from "./i18n";
import { useModal } from "@/contexts/ModalContext";

// ================================================================================================
// MODIFICADORES
// ================================================================================================

function GroupModal({ initial, busy, onSave, onClose }) {
    const { t } = useT();
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
        <Modal title={initial ? t("group.edit") : t("group.new")} onClose={onClose}>
            <form onSubmit={submit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>{t("common.name")}</label>
                        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("group.namePh")} className={inputCls} maxLength={120} required autoFocus />
                    </div>
                    <div>
                        <label className={labelCls}>{t("common.nameEnOptional")}</label>
                        <input type="text" value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="Size, Extras…" className={inputCls} maxLength={120} />
                    </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>{t("group.min")}</label>
                        <input type="number" min={0} max={20} value={minSel} onChange={(e) => setMinSel(e.target.value)} className={inputCls} />
                        <p className="text-[11px] text-gray-400 mt-1.5">{t("group.minHelp")}</p>
                    </div>
                    <div>
                        <label className={labelCls}>{t("group.max")}</label>
                        <input type="number" min={1} max={20} value={maxSel} onChange={(e) => setMaxSel(e.target.value)} className={inputCls} />
                        <p className="text-[11px] text-gray-400 mt-1.5">{t("group.maxHelp")}</p>
                    </div>
                </div>
                <div className="flex justify-end gap-3 pt-2">
                    <button type="button" onClick={onClose} className={btnGhostCls}>{t("common.cancel")}</button>
                    <button type="submit" disabled={busy || !name.trim()} className={btnCls}>{busy ? t("common.saving") : t("common.save")}</button>
                </div>
            </form>
        </Modal>
    );
}

function OptionModal({ initial, busy, onSave, onClose }) {
    const { t } = useT();
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
        <Modal title={initial ? t("option.edit") : t("option.new")} onClose={onClose}>
            <form onSubmit={submit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>{t("common.name")}</label>
                        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("option.namePh")} className={inputCls} maxLength={120} required autoFocus />
                    </div>
                    <div>
                        <label className={labelCls}>{t("common.nameEnOptional")}</label>
                        <input type="text" value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="Large, Extra cheese…" className={inputCls} maxLength={120} />
                    </div>
                </div>
                <div>
                    <label className={labelCls}>{t("option.priceDelta")}</label>
                    <input type="text" inputMode="decimal" value={deltaStr} onChange={(e) => setDeltaStr(e.target.value)} placeholder="0.00" className={inputCls} />
                </div>
                <div className="flex justify-end gap-3 pt-2">
                    <button type="button" onClick={onClose} className={btnGhostCls}>{t("common.cancel")}</button>
                    <button type="submit" disabled={busy || !name.trim() || inputToCentsSigned(deltaStr) === null} className={btnCls}>{busy ? t("common.saving") : t("common.save")}</button>
                </div>
            </form>
        </Modal>
    );
}

export function ModifiersTab({ flash, symbol }) {
    const { confirm } = useModal();
    const { t } = useT();
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
            flash(t("mod.loadError", { msg: e?.message || e }));
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
            flash(t("common.error", { msg: e?.message || e }));
        } finally {
            setBusy(false);
        }
    };

    const saveGroup = (payload) => run(async () => {
        if (groupModal && groupModal.group) await apiPut(`${BASE}/modifier-groups/${groupModal.group.id}`, payload);
        else await apiPost(`${BASE}/modifier-groups`, payload);
        setGroupModal(null);
    }, t("mod.groupSaved"));
    const saveOption = (payload) => run(async () => {
        if (optionModal && optionModal.option) await apiPut(`${BASE}/modifier-options/${optionModal.option.id}`, payload);
        else await apiPost(`${BASE}/modifier-options`, { ...payload, group_id: optionModal.groupId });
        setOptionModal(null);
    }, t("mod.optionSaved"));
    const deleteGroup = async (g) => {
        if (!(await confirm(t("mod.groupDeleteConfirm", { name: g.name }), undefined, true))) return;
        run(() => apiDelete(`${BASE}/modifier-groups/${g.id}`), t("mod.groupDeleted"));
    };
    const deleteOption = async (o) => {
        if (!(await confirm(t("mod.optionDeleteConfirm", { name: o.name }), undefined, true))) return;
        run(() => apiDelete(`${BASE}/modifier-options/${o.id}`), t("mod.optionDeleted"));
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-gray-400 font-bold max-w-xl">
                    {t("mod.intro")}
                </p>
                <button type="button" onClick={() => setGroupModal({ group: null })} className={btnCls}>{t("mod.newGroup")}</button>
            </div>

            {groups === null ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>{t("common.loading")}</div>
            ) : groups.length === 0 ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>
                    {t("mod.empty")}
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
                                {g.min_select === 0 ? t("mod.optional") : t("mod.min", { n: g.min_select })} · {t("mod.max", { n: g.max_select })}
                            </span>
                            <span className="text-[10px] font-black uppercase tracking-wider text-gray-400 bg-white border border-gray-200 rounded-full px-2.5 py-1">
                                {t(g.attached_items === 1 ? "mod.attachedOne" : "mod.attachedMany", { n: g.attached_items })}
                            </span>
                            <button type="button" disabled={busy || gi === 0} onClick={() => run(() => apiPost(`${BASE}/modifier-groups/${g.id}/move`, { dir: "up" }))} className={btnGhostCls}>↑</button>
                            <button type="button" disabled={busy || gi === groups.length - 1} onClick={() => run(() => apiPost(`${BASE}/modifier-groups/${g.id}/move`, { dir: "down" }))} className={btnGhostCls}>↓</button>
                            <button type="button" disabled={busy} onClick={() => run(() => apiPut(`${BASE}/modifier-groups/${g.id}`, { is_active: !g.is_active }))} className={btnGhostCls}>
                                {g.is_active ? t("mod.deactivate") : t("mod.activate")}
                            </button>
                            <button type="button" disabled={busy} onClick={() => setGroupModal({ group: g })} className={btnGhostCls}>{t("common.edit")}</button>
                            <button type="button" disabled={busy} onClick={() => deleteGroup(g)} className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-500 rounded-xl font-bold text-xs">✕</button>
                        </div>
                        <div className="divide-y divide-gray-50">
                            {(g.options || []).length === 0 ? (
                                <p className="px-5 py-4 text-sm text-gray-400">{t("mod.noOptions")}</p>
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
                                            {t("common.available")}
                                        </label>
                                        <div className="flex gap-1.5">
                                            <button type="button" disabled={busy || oi === 0} onClick={() => run(() => apiPost(`${BASE}/modifier-options/${o.id}/move`, { dir: "up" }))} className={btnGhostCls}>↑</button>
                                            <button type="button" disabled={busy || oi === g.options.length - 1} onClick={() => run(() => apiPost(`${BASE}/modifier-options/${o.id}/move`, { dir: "down" }))} className={btnGhostCls}>↓</button>
                                            <button type="button" disabled={busy} onClick={() => setOptionModal({ option: o, groupId: g.id })} className={btnGhostCls}>{t("common.edit")}</button>
                                            <button type="button" disabled={busy} onClick={() => deleteOption(o)} className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-500 rounded-xl font-bold text-xs">✕</button>
                                        </div>
                                    </div>
                                ))
                            )}
                            <div className="px-5 py-3">
                                <button type="button" onClick={() => setOptionModal({ option: null, groupId: g.id })} className="text-xs font-black uppercase tracking-widest text-gray-400 hover:text-gray-900 transition-colors">
                                    {t("mod.addOption")}
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
    const { confirm } = useModal();
    const { t } = useT();
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
            flash(t("common.error", { msg: e?.message || e }));
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
        const next = o.status === "new" ? { s: "preparing", label: t("order.next.prepare") }
            : o.status === "preparing" ? { s: "ready", label: t("order.next.ready") }
            : { s: "delivered", label: t("order.next.delivered") };
        const pay = PAY_META[o.payment_method] || PAY_META.whatsapp;
        const payKey = PAY_META[o.payment_method] ? o.payment_method : "whatsapp";
        return (
            <div key={o.id} className={`bg-white border-2 rounded-2xl p-4 shadow-sm ${o.status === "new" ? "border-blue-200" : late ? "border-red-300" : "border-gray-100"}`}>
                <div className="flex justify-between items-start gap-2 flex-wrap">
                    <span className="font-black text-lg text-gray-900">#{o.id}</span>
                    <div className="flex items-center gap-2">
                        {o.table_label ? (
                            <span className="px-2.5 py-1 rounded-full text-[11px] font-black bg-purple-50 text-purple-700 border border-purple-200">🪑 {o.table_label}</span>
                        ) : (
                            <span className="px-2.5 py-1 rounded-full text-[11px] font-black bg-gray-50 text-gray-500 border border-gray-200">
                                {o.delivery_type === "delivery" ? `🛵 ${t("order.deliveryShort")}` : `🏪 ${t("order.pickupShort")}`}
                            </span>
                        )}
                        <span className={`px-2.5 py-1 rounded-full text-[11px] font-black tabular-nums ${late ? "bg-red-50 text-red-600 border border-red-200" : "bg-gray-50 text-gray-500 border border-gray-200"}`}>
                            ⏱ {elapsedLabel(age)}
                        </span>
                    </div>
                </div>
                <p className="text-[11px] text-gray-400 font-bold mt-1">
                    {o.customer_name} · {pay.emoji} {t(`pay.${payKey}`)}
                    {o.payment_status === "paid" ? <span className="text-green-600 ml-1">{t("kitchen.paid")}</span> : null}
                    {o.payment_status === "pending" ? <span className="text-amber-600 ml-1">{t("kitchen.payPending")}</span> : null}
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
                        <button type="button" disabled={busy} onClick={async () => { if (await confirm(t("kitchen.cancelConfirm", { id: o.id }), undefined, true)) setStatus(o.id, "cancelled"); }} className="px-3 py-2.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl font-black text-xs uppercase tracking-wider transition-all disabled:opacity-50">
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
                    {live ? t("kitchen.live") : t("kitchen.polling")}
                </span>
                <button type="button" onClick={load} className={btnGhostCls}>{t("common.refresh")}</button>
            </div>
            {orders === null ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>{t("kitchen.loading")}</div>
            ) : (
                <div className="grid lg:grid-cols-3 gap-4">
                    {["new", "preparing", "ready"].map((st) => (
                        <div key={st} className="bg-gray-50/80 rounded-3xl p-4 border border-gray-100">
                            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3 flex items-center justify-between">
                                {t(`status.${st}`)}
                                <span className={`px-2 py-0.5 rounded-full border text-[10px] ${STATUS_META[st].color}`}>{cols[st].length}</span>
                            </p>
                            <div className="space-y-3">
                                {cols[st].length === 0 ? <p className="text-xs text-gray-300 text-center py-6">{t("common.noOrders")}</p> : cols[st].map(card)}
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
    const { t } = useT();
    const url = tableUrl(menuPageUrl, table.token);
    const svg = qrSvg(url, 5);
    return (
        <Modal title={`QR — ${table.label}`} onClose={onClose}>
            <div className="text-center space-y-4">
                {svg ? (
                    <div className="inline-block border border-gray-100 rounded-2xl p-2 bg-white" dangerouslySetInnerHTML={{ __html: svg }} />
                ) : (
                    <p className="text-sm text-red-500">{t("qr.error")}</p>
                )}
                <p className="text-xs text-gray-500 break-all font-mono bg-gray-50 rounded-xl px-3 py-2">{url}</p>
                {!menuPageUrl ? (
                    <p className="text-[11px] text-amber-600 font-bold">
                        {t("qr.configureHint")}
                    </p>
                ) : null}
                <button type="button" onClick={onClose} className={btnGhostCls}>{t("common.close")}</button>
            </div>
        </Modal>
    );
}

/** Print sheet: opens a minimal document with one QR card per active table and calls print().
 *  `t` is the caller's translator (this is a plain function, not a component). */
function printAllQRs(tables, menuPageUrl, t) {
    if (typeof window === "undefined") return;
    const w = window.open("", "_blank", "noopener=false");
    if (!w) return;
    const cards = tables.filter((tb) => tb.is_active).map((tb) => {
        const url = tableUrl(menuPageUrl, tb.token);
        const svg = qrSvg(url, 4);
        if (!svg) return `<div class="card"><h2>${String(tb.label).replace(/[<>&]/g, "")}</h2><p>${t("qr.printTooLong")}</p></div>`;
        return `<div class="card"><div class="qr">${svg}</div><h2>${String(tb.label).replace(/[<>&]/g, "")}</h2><p>${t("qr.printScan")}</p></div>`;
    }).join("");
    w.document.write(`<!doctype html><html><head><title>${t("qr.printTitle")}</title><style>
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
    const { confirm } = useModal();
    const { t } = useT();
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
            flash(t("common.error", { msg: e?.message || e }));
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
        }, t("tables.created"));
    };

    return (
        <div className="space-y-4">
            <form onSubmit={addTable} className={`${cardCls} p-5 flex items-end gap-3 flex-wrap`}>
                <div className="flex-1 min-w-[200px]">
                    <label className={labelCls}>{t("tables.new")}</label>
                    <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("tables.newPh")} className={inputCls} maxLength={60} />
                </div>
                <button type="submit" disabled={busy || !label.trim()} className={btnCls}>{t("tables.create")}</button>
                <button type="button" disabled={busy || !tables || tables.filter((tb) => tb.is_active).length === 0} onClick={() => printAllQRs(tables || [], menuPageUrl, t)} className={btnGhostCls}>
                    {t("tables.printAll")}
                </button>
            </form>

            {!menuPageUrl ? (
                <div className="bg-amber-50 text-amber-700 rounded-2xl px-4 py-3 text-xs font-bold">
                    {t("tables.noMenuUrl")}
                </div>
            ) : null}

            {tables === null ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>{t("tables.loading")}</div>
            ) : tables.length === 0 ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>
                    {t("tables.empty")}
                </div>
            ) : (
                <div className={`${cardCls} divide-y divide-gray-50`}>
                    {tables.map((tb, ti) => (
                        <div key={tb.id} className={`px-5 py-3 flex items-center gap-3 flex-wrap ${tb.is_active ? "" : "opacity-50"}`}>
                            <span className="font-black text-sm text-gray-900 flex-1 min-w-[120px] truncate">🪑 {tb.label}</span>
                            <button type="button" onClick={() => setQrModal(tb)} className={btnGhostCls}>{t("tables.viewQr")}</button>
                            <label className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-gray-400 cursor-pointer select-none">
                                <input type="checkbox" checked={!!tb.is_active} disabled={busy} onChange={() => run(() => apiPut(`${BASE}/tables/${tb.id}`, { is_active: !tb.is_active }))} className="w-4 h-4 accent-green-600" />
                                {t("tables.active")}
                            </label>
                            <div className="flex gap-1.5">
                                <button type="button" disabled={busy || ti === 0} onClick={() => run(() => apiPost(`${BASE}/tables/${tb.id}/move`, { dir: "up" }))} className={btnGhostCls}>↑</button>
                                <button type="button" disabled={busy || ti === tables.length - 1} onClick={() => run(() => apiPost(`${BASE}/tables/${tb.id}/move`, { dir: "down" }))} className={btnGhostCls}>↓</button>
                                <button type="button" disabled={busy} title={t("tables.regenTitle")} onClick={async () => { if (await confirm(t("tables.regenConfirm"), undefined, true)) run(() => apiPut(`${BASE}/tables/${tb.id}`, { regenerate_token: true }), t("tables.regenerated")); }} className={btnGhostCls}>⟳</button>
                                <button type="button" disabled={busy} onClick={async () => { if (await confirm(t("tables.deleteConfirm", { name: tb.label }), undefined, true)) run(() => apiDelete(`${BASE}/tables/${tb.id}`), t("tables.deleted")); }} className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-500 rounded-xl font-bold text-xs">✕</button>
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
    const { t } = useT();
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
        <Modal title={t("resv.newManualTitle")} onClose={onClose}>
            <form onSubmit={submit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>{t("common.name")}</label>
                        <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} maxLength={120} required autoFocus />
                    </div>
                    <div>
                        <label className={labelCls}>{t("resv.phone")}</label>
                        <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} maxLength={30} />
                    </div>
                </div>
                <div>
                    <label className={labelCls}>{t("resv.email")}</label>
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} maxLength={200} />
                </div>
                <div className="grid grid-cols-3 gap-4">
                    <div>
                        <label className={labelCls}>{t("resv.date")}</label>
                        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} required />
                    </div>
                    <div>
                        <label className={labelCls}>{t("resv.time")}</label>
                        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputCls} required />
                    </div>
                    <div>
                        <label className={labelCls}>{t("resv.party")}</label>
                        <input type="number" min={1} max={200} value={party} onChange={(e) => setParty(e.target.value)} className={inputCls} required />
                    </div>
                </div>
                <div>
                    <label className={labelCls}>{t("resv.notes")}</label>
                    <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} maxLength={500} />
                </div>
                <div className="flex justify-end gap-3 pt-2">
                    <button type="button" onClick={onClose} className={btnGhostCls}>{t("common.cancel")}</button>
                    <button type="submit" disabled={busy || !name.trim()} className={btnCls}>{busy ? t("common.saving") : t("common.save")}</button>
                </div>
            </form>
        </Modal>
    );
}

export function ReservationsTab({ flash }) {
    const { confirm } = useModal();
    const { t } = useT();
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
            flash(t("common.error", { msg: e?.message || e }));
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
                    <label className={labelCls}>{t("resv.day")}</label>
                    <input type="date" value={dateFilter} onChange={(e) => { setDateFilter(e.target.value); load(e.target.value, statusFilter, showAll); }} className={inputCls} />
                </div>
                <div className="flex gap-1.5 flex-wrap items-center pb-1">
                    <button type="button" onClick={() => { setStatusFilter(""); load(dateFilter, "", showAll); }}
                        className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition-all ${statusFilter === "" ? chipOnCls : chipOffCls}`}>
                        {t("resv.all")}
                    </button>
                    {Object.keys(RES_STATUS_META).map((s) => (
                        <button key={s} type="button" onClick={() => { setStatusFilter(s); load(dateFilter, s, showAll); }}
                            className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition-all ${statusFilter === s ? chipOnCls : chipOffCls}`}>
                            {t(`res.${s}`)} {counts[s] ? `(${counts[s]})` : ""}
                        </button>
                    ))}
                    <label className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-gray-400 cursor-pointer select-none ml-2">
                        <input type="checkbox" checked={showAll} onChange={(e) => { setShowAll(e.target.checked); load(dateFilter, statusFilter, e.target.checked); }} className="w-4 h-4 accent-gray-900" />
                        {t("resv.includePast")}
                    </label>
                </div>
                <div className="flex-1"></div>
                <button type="button" onClick={() => setModal(true)} className={btnCls}>{t("resv.manual")}</button>
            </div>

            {data === null ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>{t("resv.loading")}</div>
            ) : rows.length === 0 ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>{t("resv.empty")}</div>
            ) : (
                <div className={`${cardCls} divide-y divide-gray-50`}>
                    {rows.map((r) => {
                        const meta = RES_STATUS_META[r.status] || RES_STATUS_META.pending;
                        const statusKey = RES_STATUS_META[r.status] ? r.status : "pending";
                        const isToday = data && r.reserved_date === data.today;
                        return (
                            <div key={r.id} className="px-5 py-3.5 flex items-center gap-3 flex-wrap">
                                <div className="text-center min-w-[76px]">
                                    <p className={`text-sm font-black ${isToday ? "text-orange-600" : "text-gray-900"}`}>{isToday ? t("resv.today") : r.reserved_date}</p>
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
                                <span className={`px-3 py-1 rounded-full text-xs font-black border ${meta.color}`}>{t(`res.${statusKey}`)}</span>
                                <div className="flex gap-1.5 flex-wrap">
                                    {r.status === "pending" ? (
                                        <button type="button" disabled={busy} onClick={() => run(() => apiPost(`${BASE}/reservations/${r.id}/status`, { status: "confirmed" }), t("resv.confirmed"))} className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-xl font-black text-[11px] uppercase tracking-wider disabled:opacity-50">
                                            {t("resv.confirm")}
                                        </button>
                                    ) : null}
                                    {(r.status === "pending" || r.status === "confirmed") ? (
                                        <>
                                            <button type="button" disabled={busy} onClick={() => run(() => apiPost(`${BASE}/reservations/${r.id}/status`, { status: "completed" }))} className={btnGhostCls}>{t("res.completed")}</button>
                                            <button type="button" disabled={busy} onClick={() => run(() => apiPost(`${BASE}/reservations/${r.id}/status`, { status: "no_show" }))} className={btnGhostCls}>{t("res.no_show")}</button>
                                            <button type="button" disabled={busy} onClick={() => run(() => apiPost(`${BASE}/reservations/${r.id}/status`, { status: "cancelled" }))} className="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl font-bold text-[11px] uppercase tracking-wider disabled:opacity-50">
                                                {t("common.cancel")}
                                            </button>
                                        </>
                                    ) : null}
                                    <button type="button" disabled={busy} onClick={async () => { if (await confirm(t("resv.deleteConfirm"), undefined, true)) run(() => apiDelete(`${BASE}/reservations/${r.id}`), t("resv.deleted")); }} className="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-500 rounded-xl font-bold text-xs">✕</button>
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
                }, t("resv.created"))} />
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
    const { t } = useT();
    const [from, setFrom] = useState(daysAgoISO(29));
    const [to, setTo] = useState(todayISO());
    const [report, setReport] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = async (f = from, toDate = to) => {
        setBusy(true);
        try {
            setReport(await api(`${BASE}/reports?from=${encodeURIComponent(f)}&to=${encodeURIComponent(toDate)}`));
        } catch (e) {
            flash(t("rep.loadError", { msg: e?.message || e }));
        } finally {
            setBusy(false);
        }
    };
    useEffect(() => { load(); }, []);

    const exportCsv = async () => {
        setBusy(true);
        try {
            const data = await api(`${BASE}/reports/csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
            downloadText(data.filename || t("rep.csvName"), data.csv || "");
        } catch (e) {
            flash(t("rep.exportError", { msg: e?.message || e }));
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
                    <label className={labelCls}>{t("rep.from")}</label>
                    <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
                </div>
                <div>
                    <label className={labelCls}>{t("rep.to")}</label>
                    <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
                </div>
                <button type="button" disabled={busy} onClick={() => load()} className={btnCls}>{busy ? t("common.loading") : t("rep.apply")}</button>
                <div className="flex-1"></div>
                <button type="button" disabled={busy || !r} onClick={exportCsv} className={btnGhostCls}>{t("rep.export")}</button>
            </div>

            {!r ? (
                <div className={`${cardCls} p-8 text-center text-sm text-gray-400`}>{t("rep.loading")}</div>
            ) : (
                <>
                    <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
                        <Tile label={t("rep.orders")} value={r.totals.orders} />
                        <Tile label={t("rep.revenue")} value={money(r.totals.revenue_cents)} accent="text-green-700" />
                        <Tile label={t("rep.avgTicket")} value={money(r.totals.avg_ticket_cents)} />
                        <Tile label={t("rep.paidOnline")} value={money(r.totals.paid_online_cents)} />
                        <Tile label={t("rep.cancelled")} value={r.totals.cancelled} accent={r.totals.cancelled > 0 ? "text-red-500" : "text-gray-900"} />
                    </div>

                    <div className="grid lg:grid-cols-2 gap-4">
                        <BarRow
                            title={t("rep.salesByDay")}
                            values={r.byDay.map((d) => d.revenue_cents / 100)}
                            labels={r.byDay.map((d) => d.date.slice(5))}
                        />
                        <BarRow
                            title={t("rep.peakHours")}
                            values={r.peakHours}
                            labels={r.peakHours.map((_, h) => (h % 3 === 0 ? String(h) : ""))}
                        />
                    </div>

                    <div className="grid lg:grid-cols-2 gap-4">
                        <div className={`${cardCls} p-5`}>
                            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">{t("rep.topDishes")}</p>
                            {r.topDishes.length === 0 ? (
                                <p className="text-sm text-gray-400">{t("rep.noSales")}</p>
                            ) : (
                                <div className="divide-y divide-gray-50">
                                    {r.topDishes.map((d, i) => (
                                        <div key={i} className="flex items-center gap-3 py-2 text-sm">
                                            <span className="w-6 text-center font-black text-gray-300">{i + 1}</span>
                                            <span className="flex-1 font-bold text-gray-900 truncate">{d.name}</span>
                                            <span className="font-black text-gray-500 tabular-nums">{t("rep.units", { n: d.qty })}</span>
                                            <span className="font-black tabular-nums">{money(d.revenue_cents)}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div className="space-y-4">
                            <div className={`${cardCls} p-5`}>
                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">{t("rep.howPay")}</p>
                                <div className="flex gap-2 flex-wrap">
                                    {Object.keys(PAY_META).map((k) => (
                                        <span key={k} className="px-3 py-1.5 rounded-full text-xs font-black bg-gray-50 border border-gray-200 text-gray-600">
                                            {PAY_META[k].emoji} {t(`pay.${k}`)}: {r.byPayment[k] || 0}
                                        </span>
                                    ))}
                                </div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mt-4 mb-2">{t("rep.whereFrom")}</p>
                                <div className="flex gap-2 flex-wrap">
                                    <span className="px-3 py-1.5 rounded-full text-xs font-black bg-gray-50 border border-gray-200 text-gray-600">{t("rep.web", { n: r.bySource.web || 0 })}</span>
                                    <span className="px-3 py-1.5 rounded-full text-xs font-black bg-gray-50 border border-gray-200 text-gray-600">{t("rep.table", { n: r.bySource.table || 0 })}</span>
                                    <span className="px-3 py-1.5 rounded-full text-xs font-black bg-gray-50 border border-gray-200 text-gray-600">{t("rep.pickup", { n: r.byType.pickup || 0 })}</span>
                                    <span className="px-3 py-1.5 rounded-full text-xs font-black bg-gray-50 border border-gray-200 text-gray-600">{t("rep.delivery", { n: r.byType.delivery || 0 })}</span>
                                </div>
                            </div>
                            <div className={`${cardCls} p-5`}>
                                <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">{t("rep.reservations")}</p>
                                <div className="flex gap-2 flex-wrap">
                                    {Object.keys(RES_STATUS_META).map((s) => (
                                        <span key={s} className={`px-3 py-1.5 rounded-full text-xs font-black border ${RES_STATUS_META[s].color}`}>
                                            {t(`res.${s}`)}: {r.reservations[s] || 0}
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
