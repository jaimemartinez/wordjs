// @ts-nocheck
"use client";

/**
 * «Turnos» (conference-manager 2.32.0) — the meal groups A–F and each service's call times.
 *
 * Everyone gets a letter from a priority score (age + «Condiciones de salud»), cut into six groups of nearly the
 * same size; each service calls the groups in order, one after another, at the pace the kitchen can serve
 * (filas × platos por minuto × 85 %). The server computes all of it (server/meal-priority.js); this tab shows it,
 * turns it on, sets the pace and the condition weights, fixes the groups before printing badges, and lets a
 * coordinator move a person to another group by hand.
 *
 * Alimentación › ver sees letters, counts and times; › gestionar changes them. A score and why only with
 * Datos de salud › ver (the server leaves them out otherwise).
 */
import React, { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { useModal } from "@/contexts/ModalContext";
import { conferenceApi } from "../lib/conference";
import { dayLabel, makeTxn, mealName, useTx } from "./MealScanner";
import { usePerms } from "./perms";
import { GROUP_TONES, MEAL_GROUPS, groupSizeSpread, peopleFilter, turnLine } from "../lib/mealTurns";
import { Select } from "../lib/Select";

const card = 'bg-white rounded-3xl border border-gray-100 shadow-sm';
const labelCls = 'block text-[10px] font-black text-gray-500 uppercase tracking-widest ml-1 mb-1';
const inputCls = 'w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm';
const btnGhost = 'min-h-[44px] px-4 py-2.5 rounded-xl bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400 font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50';
const btnPrimary = 'min-h-[44px] px-5 py-2.5 rounded-xl bg-blue-600 text-white hover:bg-blue-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-blue-500/20 transition-all disabled:opacity-50';
const PAGE = 50;

export function GroupBadge({ g, size = 'md' }: { g: string | null; size?: 'sm' | 'md' | 'lg' }) {
    if (!g) return null;
    const dim = size === 'lg' ? 'w-12 h-12 text-xl' : size === 'sm' ? 'w-6 h-6 text-[11px]' : 'w-8 h-8 text-sm';
    return <span className={`${dim} shrink-0 inline-flex items-center justify-center rounded-lg font-black text-white ${GROUP_TONES[g] || 'bg-gray-500'}`} data-meal-group={g}>{g}</span>;
}

export default function MealTurnsTab({ conferenceId }: { conferenceId: number }) {
    const tx = useTx();
    const txn = makeTxn(tx);
    const { language } = useI18n();
    // Decimals the reader's way (3,4 in Spanish and Portuguese).
    const num = (n: number) => { try { return Number(n).toLocaleString(language || 'es', { maximumFractionDigits: 1 }); } catch { return String(n); } };
    const { addToast } = useToast();
    const { confirm } = useModal();
    const perms = usePerms();
    const canManage = perms.can('meals', 'manage');
    const [data, setData] = useState<any>(null);
    const [failed, setFailed] = useState('');
    const [busy, setBusy] = useState('');
    const [pace, setPace] = useState<{ lines: string; per_min: string; companions_max: string }>({ lines: '', per_min: '', companions_max: '' });
    const [paceError, setPaceError] = useState('');
    const [weights, setWeights] = useState<Record<string, string>>({});
    const [weightError, setWeightError] = useState('');
    const [q, setQ] = useState('');
    const [groupFilter, setGroupFilter] = useState('');
    const [page, setPage] = useState(1);
    const [serviceId, setServiceId] = useState<number | null>(null);

    const load = async () => {
        try {
            const d = await conferenceApi.getMealPriority(conferenceId);
            setData(d); setFailed('');
            setPace({ lines: String(d.config.lines), per_min: String(d.config.per_min), companions_max: String(d.config.companions_max) });
            const w: Record<string, string> = {};
            for (const c of d.health_options || []) w[c] = String(d.config.weights?.[c] ?? d.default_weights?.[c] ?? d.unknown_weight);
            setWeights(w);
            setServiceId((cur) => (cur != null && d.services.some((s) => s.id === cur) ? cur : (d.services[0]?.id ?? null)));
        } catch (e: any) { setFailed(e?.message || tx('turns.load.failed', 'No se pudieron cargar los turnos.')); }
    };
    useEffect(() => { setData(null); load(); }, [conferenceId]);

    const people = useMemo(() => peopleFilter(data?.people || [], q, groupFilter), [data, q, groupFilter]);
    useEffect(() => { setPage(1); }, [q, groupFilter]);

    if (!data) return failed
        ? <div className="text-center py-16 space-y-3"><p className="text-sm font-bold text-gray-600">{failed}</p><button type="button" className={btnGhost} onClick={load}>{tx('meals.retry', 'Reintentar')}</button></div>
        : <div className="text-center py-16 text-gray-400 text-xs font-bold uppercase tracking-widest">{tx('loading', 'Cargando…')}</div>;

    const act = async (key: string, fn: () => Promise<any>, ok?: string) => {
        setBusy(key);
        try { await fn(); if (ok) addToast(ok, 'success'); await load(); }
        catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setBusy(''); }
    };
    const toggleEnabled = () => act('enabled', () => conferenceApi.saveMealPriorityConfig(conferenceId, { enabled: !data.config.enabled }),
        data.config.enabled ? tx('turns.off.done', 'Turnos de comida desactivados.') : tx('turns.on.done', 'Turnos de comida activados.'));
    const savePace = () => {
        const lines = Number(pace.lines), per = Number(String(pace.per_min).replace(',', '.')), comp = Number(pace.companions_max);
        if (!Number.isInteger(lines) || lines < 1 || lines > 50) return setPaceError(tx('turns.pace.error.lines', 'Las filas de entrega deben ser un número entero entre 1 y 50.'));
        if (!(per >= 0.1 && per <= 60)) return setPaceError(tx('turns.pace.error.rate', 'Los platos por minuto deben estar entre 0,1 y 60.'));
        if (!Number.isInteger(comp) || comp < 0 || comp > 20) return setPaceError(tx('turns.pace.error.companions', 'Los acompañantes deben ser un número entero entre 0 y 20.'));
        setPaceError('');
        act('pace', () => conferenceApi.saveMealPriorityConfig(conferenceId, { lines, per_min: per, companions_max: comp }), tx('turns.saved', 'Guardado.'));
    };
    const saveWeights = () => {
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(weights)) {
            const n = Number(String(v).replace(',', '.'));
            if (String(v).trim() === '' || !(n >= 0 && n <= 60)) return setWeightError(tx('turns.weights.error', 'Cada peso debe ser un número entre 0 y 60 («{name}»).', { name: k }));
            out[k] = Math.round(n);
        }
        setWeightError('');
        act('weights', () => conferenceApi.saveMealPriorityConfig(conferenceId, { weights: out }), tx('turns.saved', 'Guardado.'));
    };
    const freeze = async (unfreeze = false) => {
        if (!unfreeze && data.frozen_at && !await confirm(tx('turns.recalc.confirm', 'Se vuelven a calcular los grupos de todos (los cambios hechos a mano se mantienen). Las escarapelas ya impresas pueden quedar con otra letra. ¿Recalcular?'), tx('turns.recalc', 'Recalcular grupos'))) return;
        if (unfreeze && !await confirm(tx('turns.unfreeze.confirm', 'Los grupos volverán a cambiar con cada inscripción. ¿Continuar?'), tx('turns.unfreeze', 'Volver a automático'))) return;
        act('freeze', () => conferenceApi.freezeMealGroups(conferenceId, unfreeze), unfreeze ? tx('turns.unfrozen.done', 'Los grupos vuelven a ser automáticos.') : tx('turns.frozen.done', 'Grupos fijados.'));
    };
    const setGroup = (id: number, g: string) => act(`p${id}`, () => conferenceApi.setMealGroup(id, g || null), tx('turns.person.done', 'Grupo actualizado.'));

    const svc = data.services.find((s) => s.id === serviceId) || null;
    const spread = groupSizeSpread(data.counts);
    const shown = people.slice((page - 1) * PAGE, page * PAGE);
    const pages = Math.max(1, Math.ceil(people.length / PAGE));

    return (
        <div className="space-y-6" data-meal-turns="">
            {/* On / off + state */}
            <div className={`${card} p-6 space-y-4`}>
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                    <div className="min-w-0">
                        <h3 className="text-lg font-black text-gray-900">{tx('turns.title', 'Turnos de comida')}</h3>
                        <p className="text-sm text-gray-600 mt-1 max-w-2xl">{tx('turns.intro', 'Cada persona recibe un grupo (A a F) según su edad y sus condiciones de salud. Los seis grupos tienen casi la misma cantidad de personas; el grupo A come primero. Cada comida llama a los grupos uno tras otro, al ritmo que la cocina puede servir.')}</p>
                    </div>
                    {canManage && (
                        <button type="button" role="switch" aria-checked={!!data.config.enabled} onClick={toggleEnabled} disabled={busy === 'enabled'}
                            className="inline-flex items-center gap-3 min-h-[44px] shrink-0 text-sm font-bold text-gray-800" data-turns-enabled="">
                            <span className={`relative inline-block w-11 h-6 rounded-full transition-colors ${data.config.enabled ? 'bg-blue-600' : 'bg-gray-300'}`} aria-hidden="true">
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${data.config.enabled ? 'translate-x-5' : ''}`}></span>
                            </span>
                            {data.config.enabled ? tx('turns.on', 'Activados') : tx('turns.off', 'Desactivados')}
                        </button>
                    )}
                </div>
                {!data.config.enabled && <p className="text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2">{tx('turns.off.hint', 'Mientras estén desactivados, los grupos solo se ven aquí: no salen en las escarapelas, en «Mi inscripción» ni en el escáner.')}</p>}
                {!data.has_age_field && <p className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2" data-turns-warn="age"><i className="fa-solid fa-triangle-exclamation mr-1.5" aria-hidden="true"></i>{tx('turns.warn.noage', 'El formulario no pregunta la edad: añade la plantilla «Edad» en Campos.')}</p>}
                {!data.has_health_field && <p className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2" data-turns-warn="health"><i className="fa-solid fa-triangle-exclamation mr-1.5" aria-hidden="true"></i>{tx('turns.warn.nohealth', 'El formulario no pregunta por condiciones de salud: añade la plantilla «Condiciones de salud» en Campos.')}</p>}
                {data.has_age_field && data.missing_age > 0 && <p className="text-xs text-gray-600">{txn('turns.missing.age', '{n} personas no tienen edad: cuentan como adultos.', '{n} persona no tiene edad: cuenta como adulta.', data.missing_age)}</p>}
                <div className="flex flex-wrap items-center gap-3 pt-1">
                    <span className={`inline-flex items-center gap-2 text-xs font-bold px-3 py-1.5 rounded-full ${data.frozen_at ? 'bg-emerald-50 text-emerald-800' : 'bg-blue-50 text-blue-800'}`} data-turns-state={data.frozen_at ? 'frozen' : 'live'}>
                        <i className={`fa-solid ${data.frozen_at ? 'fa-lock' : 'fa-rotate'}`} aria-hidden="true"></i>
                        {data.frozen_at ? tx('turns.frozen', 'Grupos fijados') : tx('turns.live', 'Grupos automáticos: cambian con cada inscripción')}
                    </span>
                    {canManage && (
                        <>
                            <button type="button" className={btnPrimary} disabled={!!busy || !data.total} onClick={() => freeze(false)} data-turns-freeze="">
                                <i className="fa-solid fa-lock mr-1.5" aria-hidden="true"></i>{data.frozen_at ? tx('turns.recalc', 'Recalcular grupos') : tx('turns.freeze', 'Fijar grupos')}
                            </button>
                            {data.frozen_at && <button type="button" className={btnGhost} disabled={!!busy} onClick={() => freeze(true)}>{tx('turns.unfreeze', 'Volver a automático')}</button>}
                        </>
                    )}
                </div>
                {!data.frozen_at && data.total > 0 && <p className="text-[11px] text-gray-500">{tx('turns.freeze.hint', 'Fija los grupos antes de imprimir las escarapelas: así nadie cambia de letra después. Quien se inscriba más tarde entra en el grupo que le corresponde.')}</p>}
            </div>

            {/* The six groups */}
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3" data-turns-counts="">
                {MEAL_GROUPS.map((g) => (
                    <button key={g} type="button" onClick={() => setGroupFilter(groupFilter === g ? '' : g)} aria-pressed={groupFilter === g}
                        className={`${card} p-3 flex flex-col items-center gap-1.5 transition ${groupFilter === g ? 'ring-2 ring-blue-500' : 'hover:border-gray-300'}`}>
                        <GroupBadge g={g} />
                        <span className="text-xl font-black text-gray-900 tabular-nums">{data.counts[g] || 0}</span>
                        <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">{tx('turns.people', 'personas')}</span>
                    </button>
                ))}
            </div>
            {spread > 0 && <p className="text-[11px] text-gray-500 -mt-3">{txn('turns.spread', 'Los grupos difieren en hasta {n} personas (familias que van juntas y cambios hechos a mano).', 'Los grupos difieren en hasta {n} persona (familias que van juntas y cambios hechos a mano).', spread)}</p>}

            {/* Call times per service */}
            <div className={`${card} p-6 space-y-4`}>
                <h3 className="text-base font-black text-gray-900">{tx('turns.times', 'Horas de llamado')}</h3>
                {!data.services.length ? <p className="text-sm text-gray-500">{tx('meals.services.none', 'Todavía no hay servicios de comida.')}</p> : (
                    <>
                        <div className="max-w-sm">
                            <label htmlFor="cm-turns-service" className={labelCls}>{tx('turns.service', 'Comida')}</label>
                            <Select id="cm-turns-service" className={inputCls} value={serviceId ?? ''} onChange={(e) => setServiceId(Number(e.target.value))}>
                                {data.services.map((s) => <option key={s.id} value={s.id}>{dayLabel(s.date, language, true)} · {s.label || mealName(tx, s.meal)}</option>)}
                            </Select>
                        </div>
                        {svc && (
                            <>
                                <p className="text-xs text-gray-600">{[
                                    txn('turns.summary.people', '{n} personas con derecho', '{n} persona con derecho', svc.entitled),
                                    txn('turns.summary.lines', '{n} filas de entrega', '{n} fila de entrega', svc.lines),
                                    tx('turns.summary.rate', '{rate} platos/min por fila → unas {k} personas por minuto', { rate: num(svc.per_min), k: num(svc.per_minute) }),
                                ].join(' · ')}. {tx('turns.summary.end', 'Termina a las {end}.', { end: svc.end })}</p>
                                {svc.overflow && <p className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2" data-turns-overflow=""><i className="fa-solid fa-clock mr-1.5" aria-hidden="true"></i>{tx('turns.overflow', 'El último grupo termina después de la hora de cierre de esta comida: añade filas de entrega o amplía el horario.')}</p>}
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm" data-turns-slots="">
                                        <thead><tr className="text-left text-[10px] uppercase tracking-widest text-gray-500">
                                            <th className="py-2 pr-3">{tx('turns.col.order', 'Orden')}</th><th className="py-2 pr-3">{tx('turns.col.group', 'Grupo')}</th>
                                            <th className="py-2 pr-3 text-right">{tx('turns.col.people', 'Personas')}</th><th className="py-2 pr-3">{tx('turns.col.call', 'Llamado')}</th><th className="py-2">{tx('turns.col.minutes', 'Duración')}</th>
                                        </tr></thead>
                                        <tbody>
                                            {svc.slots.map((s, i) => (
                                                <tr key={s.group} className="border-t border-gray-100">
                                                    <td className="py-2 pr-3 text-gray-500 tabular-nums">{i + 1}</td>
                                                    <td className="py-2 pr-3"><GroupBadge g={s.group} size="sm" /></td>
                                                    <td className="py-2 pr-3 text-right tabular-nums font-bold">{s.count}</td>
                                                    <td className="py-2 pr-3 font-black tabular-nums whitespace-nowrap">{turnLine(s)}</td>
                                                    <td className="py-2 text-gray-600 tabular-nums whitespace-nowrap">{tx('turns.minutes', '{n} min', { n: num(s.minutes) })}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                {data.zero_only.length > 1 && <p className="text-[11px] text-gray-500">{tx('turns.rotation', 'Los grupos sin prioridad ({list}) alternan su orden cada día, para que no coman últimos siempre los mismos.', { list: data.zero_only.join(', ') })}</p>}
                            </>
                        )}
                    </>
                )}
            </div>

            {/* Pace + weights (Alimentación › gestionar) */}
            {canManage && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className={`${card} p-6 space-y-4`}>
                        <h3 className="text-base font-black text-gray-900">{tx('turns.pace', 'Ritmo de la cocina')}</h3>
                        <div className="grid grid-cols-1 gap-3">
                            <div><label htmlFor="cm-turns-lines" className={labelCls}>{tx('turns.lines', 'Filas de entrega')}</label>
                                <input id="cm-turns-lines" inputMode="numeric" className={inputCls} value={pace.lines} onChange={(e) => setPace({ ...pace, lines: e.target.value })} /></div>
                            <div><label htmlFor="cm-turns-rate" className={labelCls}>{tx('turns.rate', 'Platos por minuto (cada fila)')}</label>
                                <input id="cm-turns-rate" inputMode="decimal" className={inputCls} value={pace.per_min} onChange={(e) => setPace({ ...pace, per_min: e.target.value })} /></div>
                            <div><label htmlFor="cm-turns-comp" className={labelCls}>{tx('turns.companions', 'Acompañantes por persona prioritaria')}</label>
                                <input id="cm-turns-comp" inputMode="numeric" className={inputCls} value={pace.companions_max} onChange={(e) => setPace({ ...pace, companions_max: e.target.value })} /></div>
                        </div>
                        <p className="text-[11px] text-gray-500">{tx('turns.pace.hint', 'Se usa el 85 % de esa capacidad, para dejar margen a quien se demora. Los acompañantes de una familia van en el grupo de su familiar prioritario.')}</p>
                        {paceError && <p role="alert" className="text-xs font-semibold text-rose-600">{paceError}</p>}
                        <button type="button" className={btnPrimary} disabled={!!busy} onClick={savePace}>{tx('save', 'Guardar')}</button>
                    </div>
                    <div className={`${card} p-6 space-y-4`}>
                        <h3 className="text-base font-black text-gray-900">{tx('turns.weights', 'Peso de cada condición')}</h3>
                        {!data.health_options.length ? <p className="text-sm text-gray-500">{tx('turns.weights.none', 'El formulario no tiene «Condiciones de salud».')}</p> : (
                            <>
                                <p className="text-[11px] text-gray-500">{tx('turns.weights.hint', 'Puntos de 0 a 60. La condición más fuerte de cada persona cuenta completa, la segunda la mitad, la tercera un cuarto (máximo 60). La edad suma aparte: 0–2 años 40, 3–5 años 30, 6–11 años 15, 60–69 años 20, 70–79 años 35, 80 o más 50.')}</p>
                                <div className="grid grid-cols-1 gap-2">
                                    {data.health_options.map((c) => (
                                        <label key={c} className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 px-3 py-2 text-sm">
                                            <span className="min-w-0 text-gray-800 break-words">{c}</span>
                                            <input inputMode="numeric" aria-label={tx('turns.weight.of', 'Peso de «{name}»', { name: c })} className="w-16 shrink-0 border-2 border-gray-100 rounded-lg px-2 py-1.5 text-right tabular-nums text-sm"
                                                value={weights[c] ?? ''} onChange={(e) => setWeights({ ...weights, [c]: e.target.value })} />
                                        </label>
                                    ))}
                                </div>
                                {weightError && <p role="alert" className="text-xs font-semibold text-rose-600">{weightError}</p>}
                                <button type="button" className={btnPrimary} disabled={!!busy} onClick={saveWeights}>{tx('save', 'Guardar')}</button>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* People */}
            <div className={`${card} p-6 space-y-4`}>
                <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
                    <h3 className="text-base font-black text-gray-900">{tx('turns.people.title', 'Personas y su grupo')}</h3>
                    <div className="sm:w-72"><label htmlFor="cm-turns-q" className="sr-only">{tx('search', 'Buscar')}</label>
                        <input id="cm-turns-q" className={inputCls} placeholder={tx('turns.search', 'Buscar por nombre o localidad')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
                </div>
                {groupFilter && <p className="text-xs text-gray-600">{tx('turns.filtered', 'Solo el grupo {g}.', { g: groupFilter })} <button type="button" className="font-bold text-blue-700 underline" onClick={() => setGroupFilter('')}>{tx('turns.filter.clear', 'Ver todos')}</button></p>}
                {!people.length ? <p className="text-sm text-gray-500">{tx('turns.people.none', 'No hay personas que mostrar.')}</p> : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm" data-turns-people="">
                            <thead><tr className="text-left text-[10px] uppercase tracking-widest text-gray-500">
                                <th className="py-2 pr-3">{tx('turns.col.person', 'Persona')}</th><th className="py-2 pr-3">{tx('location', 'Localidad')}</th>
                                {data.sees_health && <th className="py-2 pr-3 text-right">{tx('turns.col.score', 'Puntos')}</th>}
                                <th className="py-2">{tx('turns.col.group', 'Grupo')}</th>
                            </tr></thead>
                            <tbody>
                                {shown.map((p) => (
                                    <tr key={p.id} className="border-t border-gray-100 align-middle">
                                        <td className="py-2 pr-3 font-semibold text-gray-900" style={{ overflowWrap: 'anywhere' }}>{p.name}{p.family_group ? <span className="block text-[11px] font-normal text-gray-500">{p.family_group}</span> : null}</td>
                                        <td className="py-2 pr-3 text-gray-600">{p.location || '—'}</td>
                                        {data.sees_health && (
                                            <td className="py-2 pr-3 text-right tabular-nums" title={tx('turns.score.why', 'Edad {a} + salud {h}', { a: p.age_points, h: num(p.health_points) })}>
                                                <span className="font-bold">{num(p.score)}</span>
                                                <span className="block text-[10px] text-gray-500">{tx('turns.score.parts', 'edad {a} · salud {h}', { a: p.age_points, h: num(p.health_points) })}</span>
                                            </td>
                                        )}
                                        <td className="py-2">
                                            <div className="flex items-center gap-2">
                                                <GroupBadge g={p.group} size="sm" />
                                                {canManage ? (
                                                    <Select aria-label={tx('turns.person.group', 'Grupo de {name}', { name: p.name })} className="border-2 border-gray-100 rounded-lg px-2 py-1.5 text-xs font-bold bg-white min-h-[36px]"
                                                        value={p.manual ? p.group : ''} disabled={busy === `p${p.id}`} onChange={(e) => setGroup(p.id, e.target.value)} data-turns-person={p.id}>
                                                        <option value="">{tx('turns.auto', 'Automático')}</option>
                                                        {MEAL_GROUPS.map((g) => <option key={g} value={g}>{tx('turns.manual.group', 'A mano: {g}', { g })}</option>)}
                                                    </Select>
                                                ) : p.manual ? <span className="text-[10px] font-bold uppercase tracking-widest text-gray-500">{tx('turns.manual', 'A mano')}</span> : null}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {pages > 1 && (
                    <div className="flex items-center justify-between gap-3 pt-2">
                        <button type="button" className={btnGhost} disabled={page <= 1} onClick={() => setPage(page - 1)}>{tx('previous', 'Anterior')}</button>
                        <span className="text-xs text-gray-500 tabular-nums">{page} / {pages}</span>
                        <button type="button" className={btnGhost} disabled={page >= pages} onClick={() => setPage(page + 1)}>{tx('next', 'Siguiente')}</button>
                    </div>
                )}
            </div>
        </div>
    );
}
