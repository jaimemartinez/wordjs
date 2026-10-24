// @ts-nocheck
"use client";

/**
 * «Llamar grupos» (conference-manager 2.36.5) — the live screen of a meal service: the kitchen calls the meal groups
 * one after another («Llamar grupo B»), and a called group stays called. Every group shows how many people it has
 * for this service, how many have been served, how many are still to come, and how many were let in before their
 * group was called (exceptions). A call reaches the group's phones (a notification, and «Mi inscripción» says
 * «Tu grupo ya puede pasar a comer»). «Deshacer» undoes a call made by mistake, after the in-app confirmation.
 *
 * The owner's rule is the scanner's (server/meal-priority.js callGate): once a group has been called, the people of
 * the others are not served on a scan; «Dejar pasar igual» serves them as an exception, logged. Priority people
 * wait for their group too.
 *
 * Alimentación › gestionar or Entrega de comidas › gestionar call; Alimentación › ver only looks.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { useModal } from "@/contexts/ModalContext";
import { conferenceApi } from "../lib/conference";
import { dayLabel, mealName, useTx } from "./MealScanner";
import { stampTime } from "../lib/meals";
import { usePerms } from "./perms";
import { GroupBadge } from "./MealTurnsTab";
import { Select } from "../lib/Select";
import { nextToCall } from "../lib/mealTurns";

const card = 'bg-white rounded-3xl border border-gray-100 shadow-sm';
const labelCls = 'block text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1 mb-1';
const inputCls = 'w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm';
const POLL_MS = 10000;

export default function MealCallsTab({ conferenceId, services, serviceId, setServiceId }: { conferenceId: number; services: any[]; serviceId: number | null; setServiceId: (id: number | null) => void }) {
    const tx = useTx();
    const { language } = useI18n();
    const { addToast } = useToast();
    const { confirm } = useModal();
    const perms = usePerms();
    const canCall = perms.can('meals', 'manage') || perms.can('meals_delivery', 'manage');
    const [state, setState] = useState<any>(null);
    const [failed, setFailed] = useState('');
    const [busy, setBusy] = useState('');
    const [showLog, setShowLog] = useState(false);
    const sid = serviceId ?? (services[0] ? services[0].id : null);

    const load = useCallback(async () => {
        if (!sid) return;
        try { const d = await conferenceApi.getMealCalls(conferenceId, sid); setState(d.calls || null); setFailed(''); }
        catch (e: any) { setFailed(e?.message || 'Error'); }
    }, [conferenceId, sid]);
    // Fresh while open: the kitchen scans on other phones, so the counts move — every 10 s while visible.
    useEffect(() => {
        setState(null);
        load();
        const t = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState === 'visible') load(); }, POLL_MS);
        return () => clearInterval(t);
    }, [load]);

    const next = useMemo(() => (state ? nextToCall(state.order, state.called) : null), [state]);
    const call = async (g: string, undo = false) => {
        if (busy) return;
        if (undo && !await confirm(tx('calls.undo.confirm', '¿Deshacer el llamado del grupo {g}? Sus personas vuelven a esperar en el escáner. Quedará registrado.', { g }), tx('calls.undo', 'Deshacer'), true)) return;
        setBusy(g);
        try {
            const r = await conferenceApi.callMealGroup(sid, g, undo);
            setState(r.state);
            if (undo) addToast(tx('calls.undone', 'Llamado del grupo {g} deshecho.', { g }), 'success');
            else if (r.push && r.push.network === false && r.push.subscribers) addToast(tx('calls.done.nonet', 'Grupo {g} llamado. El aviso al teléfono necesita el permiso «Red» del plugin; en «Mi inscripción» ya se ve.', { g }), 'warning');
            else addToast(tx('calls.done', 'Grupo {g} llamado · teléfonos avisados: {n}.', { g, n: r.push ? r.push.sent : 0 }), 'success');
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); load(); }
        finally { setBusy(''); }
    };

    if (!services.length) return <div className={`${card} p-6 text-sm text-gray-500`}>{tx('meals.services.none', 'Todavía no hay servicios de comida.')}</div>;
    const svcLabel = (s: any) => `${dayLabel(s.service_date || s.date, language, true)} · ${s.label || mealName(tx, s.meal)}`;
    const groups = state ? (state.order || []).map((g: string) => state.groups.find((x: any) => x.group === g)).filter(Boolean) : [];
    const slotOf = (g: string) => (state && state.slots ? state.slots.find((s: any) => s.group === g) : null);
    const totals = groups.reduce((a: any, g: any) => ({ entitled: a.entitled + g.entitled, served: a.served + g.served, exceptions: a.exceptions + g.exceptions }), { entitled: 0, served: 0, exceptions: 0 });

    return (
        <div className="space-y-6" data-meal-calls="">
            <div className={`${card} p-5 sm:p-6 space-y-4`}>
                <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                    <div className="flex-1 min-w-0">
                        <label className={labelCls} htmlFor="calls-service">{tx('calls.service', 'Servicio')}</label>
                        <Select id="calls-service" className={inputCls} value={sid ? String(sid) : ''} onChange={(e) => setServiceId(Number(e.target.value) || null)}>
                            {services.map((s) => <option key={s.id} value={String(s.id)}>{svcLabel(s)}</option>)}
                        </Select>
                    </div>
                    {state && state.enabled && canCall && next && (
                        <button type="button" disabled={!!busy} onClick={() => call(next)} data-calls-next={next}
                            className="min-h-[56px] px-6 rounded-2xl bg-orange-600 hover:bg-orange-700 text-white font-black text-sm uppercase tracking-widest shadow-lg shadow-orange-500/30 disabled:opacity-50 inline-flex items-center justify-center gap-3">
                            <i className={`fa-solid ${busy === next ? 'fa-spinner animate-spin' : 'fa-bullhorn'}`} aria-hidden="true"></i>{tx('calls.next', 'Llamar grupo {g}', { g: next })}
                        </button>
                    )}
                </div>
                {failed && <p className="text-sm font-bold text-rose-700" role="alert">{failed}</p>}
                {state && !state.enabled && <p className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2" data-calls-off=""><i className="fa-solid fa-circle-info mr-1.5" aria-hidden="true"></i>{tx('calls.off', 'Activa «Turnos de comida» en la pestaña «Turnos» para llamar a los grupos.')}</p>}
                {state && state.enabled && (
                    <p className="text-xs text-gray-600" data-calls-rule="">
                        {state.called.length
                            ? tx('calls.rule.on', 'Llamados: {called}. En el escáner, quien es de otro grupo espera; «Dejar pasar igual» queda como excepción.', { called: state.called.join(', ') })
                            : tx('calls.rule.off', 'Ningún grupo llamado todavía: el escáner sirve a todos. Al llamar el primero, los demás esperan su turno.')}
                    </p>
                )}
                {state && (
                    <div className="flex flex-wrap gap-2 text-[11px] font-black uppercase tracking-widest text-gray-500" data-calls-totals="">
                        <span className="rounded-full bg-gray-100 px-3 py-1">{tx('calls.total.entitled', 'Con derecho: {n}', { n: totals.entitled })}</span>
                        <span className="rounded-full bg-emerald-50 text-emerald-800 px-3 py-1">{tx('calls.total.served', 'Servidos: {n}', { n: totals.served })}</span>
                        {totals.exceptions > 0 && <span className="rounded-full bg-rose-50 text-rose-800 px-3 py-1" data-calls-exceptions={totals.exceptions}>{tx('calls.total.exceptions', 'Excepciones: {n}', { n: totals.exceptions })}</span>}
                    </div>
                )}
            </div>

            {!state ? (!failed && <div className="text-center py-10 text-sm text-gray-400">{tx('loading', 'Cargando…')}</div>) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4" data-calls-groups="">
                    {groups.map((g: any) => {
                        const called = !!g.called_at;
                        const pct = g.entitled ? Math.round((g.served / g.entitled) * 100) : 0;
                        const slot = slotOf(g.group);
                        return (
                            <div key={g.group} className={`${card} p-5 space-y-3 ${called ? 'ring-2 ring-emerald-400' : ''}`} data-calls-group={g.group} data-called={called ? '' : undefined}>
                                <div className="flex items-center gap-3">
                                    <GroupBadge g={g.group} size="lg" />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-black text-gray-900">{tx('meals.group', 'Grupo {g}', { g: g.group })}</p>
                                        <p className="text-[11px] text-gray-500">{slot && slot.start ? tx('calls.slot', 'Hora prevista {start}–{end}', { start: slot.start, end: slot.end }) : tx('calls.noslot', 'Sin hora prevista')}</p>
                                    </div>
                                    {called ? (
                                        <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-emerald-600 text-white px-3 py-1 text-[10px] font-black uppercase tracking-widest" data-calls-state="called">
                                            <i className="fa-solid fa-bullhorn" aria-hidden="true"></i>{tx('calls.called.at', 'Llamado {time}', { time: stampTime(g.called_at) })}
                                        </span>
                                    ) : <span className="shrink-0 rounded-full bg-gray-100 text-gray-600 px-3 py-1 text-[10px] font-black uppercase tracking-widest" data-calls-state="waiting">{tx('calls.waiting', 'En espera')}</span>}
                                </div>
                                <div className="grid grid-cols-3 gap-2 text-center">
                                    <div className="rounded-xl bg-gray-50 py-2"><p className="text-xl font-black text-gray-900 tabular-nums">{g.entitled}</p><p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">{tx('calls.entitled', 'Personas')}</p></div>
                                    <div className="rounded-xl bg-emerald-50 py-2"><p className="text-xl font-black text-emerald-800 tabular-nums" data-calls-served={g.served}>{g.served}</p><p className="text-[10px] font-bold uppercase tracking-widest text-emerald-800">{tx('calls.served', 'Servidos')}</p></div>
                                    <div className="rounded-xl bg-amber-50 py-2"><p className="text-xl font-black text-amber-900 tabular-nums" data-calls-pending={g.pending}>{g.pending}</p><p className="text-[10px] font-bold uppercase tracking-widest text-amber-900">{tx('calls.pending', 'Faltan')}</p></div>
                                </div>
                                <div className="h-2 rounded-full bg-gray-100 overflow-hidden" aria-hidden="true"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }}></div></div>
                                {g.exceptions > 0 && <p className="text-[11px] font-bold text-rose-700" data-calls-group-exceptions={g.exceptions}><i className="fa-solid fa-hand mr-1" aria-hidden="true"></i>{tx('calls.group.exceptions', 'Dejados pasar antes del llamado: {n}', { n: g.exceptions })}</p>}
                                {state.enabled && canCall && (called ? (
                                    <button type="button" disabled={!!busy} onClick={() => call(g.group, true)} data-calls-undo={g.group}
                                        className="w-full min-h-[44px] rounded-xl bg-white border-2 border-gray-100 text-gray-600 hover:border-rose-300 font-black text-[10px] uppercase tracking-widest disabled:opacity-50">
                                        <i className="fa-solid fa-rotate-left mr-1.5" aria-hidden="true"></i>{tx('calls.undo', 'Deshacer')}
                                    </button>
                                ) : (
                                    <button type="button" disabled={!!busy} onClick={() => call(g.group)} data-calls-call={g.group}
                                        className="w-full min-h-[52px] rounded-xl bg-gray-900 hover:bg-black text-white font-black text-xs uppercase tracking-widest disabled:opacity-50">
                                        <i className={`fa-solid ${busy === g.group ? 'fa-spinner animate-spin' : 'fa-bullhorn'} mr-2`} aria-hidden="true"></i>{tx('calls.call', 'Llamar grupo {g}', { g: g.group })}
                                    </button>
                                ))}
                            </div>
                        );
                    })}
                </div>
            )}

            {state && (state.exceptions.length > 0 || state.log.length > 0) && (
                <div className={`${card} p-5 sm:p-6 space-y-3`} data-calls-audit="">
                    <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-black text-gray-900">{tx('calls.audit', 'Registro del servicio')}</h3>
                        <button type="button" className="text-xs font-bold text-blue-700 underline" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>{showLog ? tx('calls.audit.hide', 'Ocultar') : tx('calls.audit.show', 'Ver todo')}</button>
                    </div>
                    {state.exceptions.length > 0 && (
                        <ul className="divide-y divide-gray-50 text-sm" aria-label={tx('calls.exceptions', 'Excepciones')} data-calls-exception-list="">
                            {state.exceptions.map((x: any, i: number) => (
                                <li key={i} className="py-2 flex items-center gap-3">
                                    <GroupBadge g={x.group} size="sm" />
                                    <span className="min-w-0 flex-1 truncate font-semibold text-gray-800">{x.name}</span>
                                    <span className="shrink-0 text-[11px] text-gray-500">{tx('calls.exception.by', '{time} · dejó pasar {who}', { time: stampTime(x.at), who: x.by || '—' })}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                    {showLog && (
                        <ol className="text-xs text-gray-600 space-y-1" data-calls-log="">
                            {state.log.map((x: any, i: number) => (
                                <li key={i}>{stampTime(x.at)} · {x.kind === 'call' ? tx('calls.log.call', 'Llamado del grupo {g}', { g: x.group }) : x.kind === 'undo' ? tx('calls.log.undo', 'Llamado del grupo {g} deshecho', { g: x.group }) : tx('calls.log.exception', '{name} (grupo {g}) pasó antes de su llamado', { name: x.name, g: x.group })}{x.by ? ` · ${x.by}` : ''}</li>
                            ))}
                        </ol>
                    )}
                </div>
            )}
        </div>
    );
}
