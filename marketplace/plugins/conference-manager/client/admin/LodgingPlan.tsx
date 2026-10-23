// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * «Sugerir reparto» (2.20.0) — which free rooms to give each location, and who sleeps in each, with the fewest
 * rooms and the fewest empty beds, breaking no hard rule (POST /assignment/plan). The plan places the people
 * itself, so what this sheet shows is exactly what «Aplicar reparto» (POST /assignment/plan/apply) leaves — the
 * allotments and the placements; nobody who has a bed is moved. A plan that changed meanwhile is refused and the
 * sheet shows the new one.
 * When the free beds do not reach everyone (2.21.0), they go location by location in the order shown, which the
 * admin changes here (↑ ↓, POST /assignment/location-order); a hard «mantener juntos» group bigger than every room
 * is explained (no arrangement keeps it together).
 * Opened from Alojamiento, Asignación and Localidades (Hospedaje › gestionar). Layer 1.
 */
import React, { useEffect, useRef, useState } from "react";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { useModal } from "@/contexts/ModalContext";
import { LAYER } from "../lib/overlay";
import { conferenceApi } from "../lib/conference";
import { lockText } from "../lib/lodgingView";
import { Overlay } from "./Overlay";
import { useTx } from "./MealScanner";
import { Select } from "../lib/Select";

const btn = 'min-h-[44px] px-4 rounded-2xl font-black text-[11px] uppercase tracking-widest inline-flex items-center justify-center gap-2 disabled:opacity-50';
const ghost = `${btn} bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400`;
const primary = `${btn} bg-gray-900 text-white hover:bg-blue-600`;
const chip = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest';

function Switch({ on, onChange, title, hint, disabled }: any) {
    return (
        <button type="button" role="switch" aria-checked={!!on} disabled={disabled} onClick={() => onChange(!on)}
            className="w-full flex items-start gap-3 text-left disabled:opacity-60">
            <span className={`mt-0.5 w-11 h-6 shrink-0 rounded-full transition-colors relative ${on ? 'bg-blue-600' : 'bg-gray-200'}`}>
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`}></span>
            </span>
            <span className="min-w-0">
                <span className="block text-sm font-bold text-gray-800">{title}</span>
                {hint && <span className="block text-[11px] text-gray-500">{hint}</span>}
            </span>
        </button>
    );
}

export default function LodgingPlan({ conferenceId, hotels, onClose, onApplied }: { conferenceId: number; hotels: any[]; onClose: () => void; onApplied?: () => void }) {
    const tx = useTx();
    const { addToast } = useToast();
    const { confirm } = useModal();
    const [replan, setReplan] = useState(true);
    const [share, setShare] = useState(true);
    const [hotelId, setHotelId] = useState('');
    // «Rehacer todo el reparto» (2.21.0): the arrangement thought again from scratch — people who have a bed move.
    const [fresh, setFresh] = useState(false);
    // «Dividir familias» (2.21.0): plan the answer with the preferred families divided to use fewer rooms. Both answers
    // are always calculated and shown; this picks the one planned and applied.
    const [divide, setDivide] = useState(false);
    const [plan, setPlan] = useState<any>(null);
    const [busy, setBusy] = useState<'' | 'plan' | 'apply'>('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [applied, setApplied] = useState(false);
    const [showAll, setShowAll] = useState(false);
    // While the «¿Continuar?» question is open, Escape answers it — it must not close the sheet too.
    const [confirming, setConfirming] = useState(false);
    const seq = useRef(0);
    const opts = () => ({ replan, share, hotel_id: hotelId ? Number(hotelId) : null, fresh, divide_families: divide });
    // A counter in the right number: the «.one» text for 1 («1 habitación»), else the plural.
    const cnt = (key: string, n: number, many: string, one: string, extra: any = {}) => tx(n === 1 ? `${key}.one` : key, n === 1 ? one : many, { n, ...extra });

    // Only the latest calculation lands (the options can change while one is on its way).
    const calculate = async (note = '') => {
        const mine = ++seq.current;
        setBusy('plan'); setError(''); setNotice(note);
        try { const r = await conferenceApi.planLodging(conferenceId, opts()); if (mine === seq.current) { setPlan(r.plan); setApplied(false); } }
        catch (e: any) { if (mine === seq.current) { setError(e?.message || 'Error'); setPlan(null); } }
        finally { if (mine === seq.current) setBusy(''); }
    };
    // The suggestion follows the options: a changed switch or hotel calculates again (the plan shown is always
    // the one «Aplicar» sends).
    useEffect(() => { if (!applied) calculate(); }, [conferenceId, replan, share, hotelId, fresh, divide]); // eslint-disable-line react-hooks/exhaustive-deps

    // Beds short: move a location up or down the order, save it, calculate again.
    const move = async (index: number, delta: number) => {
        if (!plan || !plan.order || busy) return;
        const ids = plan.order.map((o: any) => o.location_id);
        const to = index + delta;
        if (to < 0 || to >= ids.length) return;
        [ids[index], ids[to]] = [ids[to], ids[index]];
        setBusy('plan');
        try { await conferenceApi.setLodgingOrder(conferenceId, ids); }
        catch (e: any) { setBusy(''); setError(e?.message || 'Error'); return; }
        setBusy('');
        await calculate();
    };

    const apply = async () => {
        if (!plan || busy || plan.worse) return;
        setConfirming(true);
        // Today's arrangement kept (nothing changes): applying only runs the automatic assignment for whoever waits.
        const yes = await confirm(plan.keeps_today
            ? cnt('plan.apply.confirm.today', plan.outcome.run_placed || 0, 'No se cambia ninguna habitación ni se mueve a nadie: la asignación automática acomoda a las {n} personas que esperan cama. ¿Continuar?', 'No se cambia ninguna habitación ni se mueve a nadie: la asignación automática acomoda a la persona que espera cama. ¿Continuar?')
            : plan.options.fresh
            ? cnt('plan.apply.confirm.fresh', plan.moved || 0, 'Se rehace el reparto de las localidades en borrador: {n} personas que ya tenían cama cambiarán de habitación o quedarán sin cama, como muestra la sugerencia. Las localidades enviadas o validadas no se tocan. ¿Continuar?', 'Se rehace el reparto de las localidades en borrador: 1 persona que ya tenía cama cambiará de habitación o quedará sin cama, como muestra la sugerencia. Las localidades enviadas o validadas no se tocan. ¿Continuar?')
            : cnt('plan.apply.confirm', plan.placements.length + (plan.outcome.run_placed || 0), 'Las localidades recibirán sus habitaciones y {n} personas quedarán acomodadas como muestra la sugerencia. Nadie que ya tenga cama se mueve. ¿Continuar?', 'Las localidades recibirán sus habitaciones y 1 persona quedará acomodada como muestra la sugerencia. Nadie que ya tenga cama se mueve. ¿Continuar?'), tx('plan.apply', 'Aplicar reparto'), !!plan.options.fresh && !plan.keeps_today);
        setConfirming(false);
        if (!yes) return;
        setBusy('apply'); setError('');
        try {
            // The options the plan on screen was calculated with.
            const r = await conferenceApi.applyLodgingPlan(conferenceId, plan.token, { replan: plan.options.replan, share: plan.options.share, hotel_id: plan.options.hotel_id, fresh: !!plan.options.fresh, divide_families: !!plan.options.divide_families });
            setPlan(r.plan); setApplied(true); setNotice('');
            addToast(cnt('plan.applied', (r.placed || 0) + (r.run_placed || 0), 'Listo: {n} personas acomodadas.', 'Listo: 1 persona acomodada.'), 'success');
            if (onApplied) onApplied();
        } catch (e: any) {
            if (e?.code === 'plan_changed') { setBusy(''); await calculate(tx('plan.changed', 'Algo cambió desde que se calculó (inscripciones, habitaciones o repartos). Esta es la sugerencia actualizada: revísala antes de aplicarla.')); return; }
            setError(e?.message || 'Error');
        } finally { setBusy(''); }
    };
    const allotText = (a: any) => {
        if (!a || a.kind === 'pool') return tx('plan.pool', 'Libre (pool)');
        if (a.kind === 'whole') return a.location_name || '—';
        return a.shares.map((x: any) => `${x.location_name || '—'} ${x.beds}`).join(' · ');
    };
    const ok = plan && plan.outcome.hard === 0 && plan.outcome.unplaced === 0;
    const unplaced = plan ? plan.outcome.unplaced : 0;
    const hardList = plan ? plan.outcome.violations.filter((v: any) => v.hard) : [];
    // Locations with everyone in a bed whose arrangement breaks a hard rule today (a rule added since): only
    // «Rehacer todo» touches them.
    const settledBroken = plan && !plan.options.fresh ? plan.locations.filter((l: any) => l.settled && l.violations.some((v: any) => v.hard)) : [];
    // Groups no room holds whole: a rule misused on a whole value (hundreds of people — «mantener juntos» by gender)
    // is explained apart; families a bit bigger than the rooms are listed per rule, as information.
    const oversized = plan && plan.oversized ? plan.oversized : [];
    const misused = oversized.filter((o: any) => o.people > 3 * o.largest_room);
    const bigFamilies = oversized.filter((o: any) => o.people <= 3 * o.largest_room);
    const bigByRule = [...new Set(bigFamilies.map((o: any) => o.rule))].map((rule) => ({ rule, groups: bigFamilies.filter((o: any) => o.rule === rule) }));
    const softList = plan ? plan.outcome.violations.filter((v: any) => !v.hard) : [];
    const shownRooms = plan ? (showAll ? plan.rooms : plan.rooms.filter((r: any) => r.changed || r.had_people)) : [];
    // The rooms the plan may fill, one set for every number (see «The rooms as the sheet shows them» in index.js):
    // used, free, and the empty beds of the rooms used. An older answer without them: the plan's own measure.
    const usedOf = (m: any): number => (m.used_rooms == null ? m.rooms : m.used_rooms);
    const emptyOf = (m: any): number => (m.used_empty_beds == null ? m.empty_beds : m.used_empty_beds);
    // «4 habitaciones usadas · 2 habitaciones libres · 1 cama vacía en las usadas · 0 sin cama · 0 reglas obligatorias rotas».
    const compareLine = (m: any) => [
        m.used_rooms == null ? cnt('plan.rooms.n', m.rooms, '{n} habitaciones', '1 habitación') : cnt('plan.variants.used', m.used_rooms, '{n} habitaciones usadas', '1 habitación usada'),
        ...(m.free_rooms != null ? [cnt('plan.variants.free', m.free_rooms, '{n} habitaciones libres', '1 habitación libre')] : []),
        m.used_rooms == null ? cnt('plan.totals.empty', m.empty_beds, '{n} camas vacías', '1 cama vacía') : cnt('plan.variants.empty', m.used_empty_beds, '{n} camas vacías en las usadas', '1 cama vacía en las usadas'),
        cnt('plan.unplaced.n', m.unplaced, '{n} sin cama', '1 sin cama'),
        cnt('plan.hard.n', m.hard, '{n} reglas obligatorias rotas', '1 regla obligatoria rota'),
    ].join(' · ');

    return (
        <Overlay layer={LAYER.sheet} onBackdrop={busy || confirming ? undefined : onClose} onEscape={busy || confirming ? undefined : onClose}>
            <div role="dialog" aria-modal="true" aria-labelledby="lodging-plan-title" data-lodging-plan=""
                className="bg-white rounded-[32px] shadow-2xl w-full max-w-3xl border border-gray-100 overflow-hidden flex flex-col max-h-[92dvh]">
                <div className="bg-gray-50/50 px-5 sm:px-7 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h2 id="lodging-plan-title" className="font-black text-xl text-gray-900 italic tracking-tighter">{tx('plan.title', 'Sugerir reparto')}</h2>
                        <p className="text-[11px] text-gray-500 font-medium mt-0.5">{tx('plan.subtitle', 'Qué habitaciones darle a cada localidad y quién duerme en cada una: las menos habitaciones y las menos camas vacías, sin romper ninguna regla obligatoria. Al aplicarla, las personas quedan acomodadas tal cual y la asignación automática acomoda a quien falte.')}</p>
                    </div>
                    <button type="button" onClick={onClose} disabled={!!busy} aria-label={tx('close', 'Cerrar')} className="shrink-0 w-11 h-11 flex items-center justify-center rounded-2xl text-gray-500 hover:bg-gray-100 disabled:opacity-40">
                        <i className="fa-solid fa-xmark text-xl" aria-hidden="true"></i>
                    </button>
                </div>

                <div className="px-5 sm:px-7 py-5 overflow-y-auto space-y-5">
                    <div className="space-y-3" data-plan-options="">
                        <Switch on={replan} disabled={!!busy || applied} onChange={setReplan} title={tx('plan.replan', 'Rehacer los repartos que aún no tienen a nadie acomodado')}
                            hint={tx('plan.replan.hint', 'Las habitaciones ya dadas a una localidad que siguen vacías se vuelven a pensar; se mantienen si siguen siendo las mejores.')} />
                        <Switch on={share} disabled={!!busy || applied} onChange={setShare} title={tx('plan.share', 'Compartir habitaciones entre localidades si así se usan menos')}
                            hint={tx('plan.share.hint', 'Cada localidad recibe sus camas en la habitación; nunca se mezclan personas que una regla obligatoria separa.')} />
                        <Switch on={fresh} disabled={!!busy || applied} onChange={setFresh} title={tx('plan.fresh', 'Rehacer todo el reparto')}
                            hint={tx('plan.fresh.hint', 'Vuelve a pensar todas las habitaciones y personas de las localidades en borrador, como si nadie tuviera cama — por ejemplo, después de cambiar una regla. Al aplicarlo, quien ya tenía cama puede cambiar de habitación. Las localidades enviadas o validadas no se tocan.')} />
                        <div className="flex flex-wrap items-center gap-2">
                            <Select value={hotelId} disabled={!!busy || applied} onChange={(e) => setHotelId(e.target.value)} aria-label={tx('plan.hotel', 'Hotel')}
                                className="flex-1 min-w-[12rem] border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/40 text-sm font-medium text-gray-900" data-plan-hotel="">
                                <option value="">{tx('plan.hotel.all', 'Todos los hoteles')}</option>
                                {(hotels || []).map((h: any) => <option key={h.id} value={String(h.id)}>{h.name}</option>)}
                            </Select>
                            {!applied && <button type="button" className={ghost} onClick={() => calculate()} disabled={!!busy} data-plan-calc="">
                                <i className={`fa-solid ${busy === 'plan' ? 'fa-spinner animate-spin' : 'fa-rotate'}`} aria-hidden="true"></i>{tx('plan.calc', 'Volver a calcular')}
                            </button>}
                        </div>
                    </div>

                    {notice && <p className="text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2" role="status">{notice}</p>}
                    {error && <p className="text-sm font-bold text-rose-600" role="alert">{error}</p>}
                    {!plan && busy === 'plan' && <div className="py-10 text-center text-gray-400 text-xs font-black uppercase tracking-widest"><i className="fa-solid fa-spinner animate-spin mr-2" aria-hidden="true"></i>{tx('plan.loading', 'Calculando el mejor reparto…')}</div>}

                    {plan && (
                        <>
                            {plan.people === 0 ? (
                                <div className="text-sm font-bold text-gray-600 bg-gray-50 border border-gray-100 rounded-2xl px-4 py-3 space-y-1" data-plan-nothing="">
                                    <p>{tx('plan.nothing', 'Nadie está esperando cama en una localidad que se pueda repartir: no hay nada que sugerir.')}</p>
                                    {!fresh && <p className="text-[11px] font-medium text-gray-500">{tx('plan.nothing.fresh', 'Para rehacer el reparto que ya está (por ejemplo, después de cambiar una regla), activa «Rehacer todo el reparto».')}</p>}
                                </div>
                            ) : (
                                <>
                                {plan.variants && (() => {
                                    // Both answers side by side; the one picked is the plan below (and what «Aplicar» writes).
                                    const v = plan.variants;
                                    const saved = v.same ? 0 : usedOf(v.keep) - usedOf(v.divide);
                                    // The beds over are the same both ways; what changes is how many are empty in the rooms used
                                    // and how many in free rooms (the owner: «¿no deberían quedar las mismas camas vacías?»). Said
                                    // only when it is so: the same beds over, placed differently.
                                    const overOf = (x: any) => (x.free_beds == null || x.used_empty_beds == null ? null : x.used_empty_beds + x.free_beds);
                                    const spare = !v.same && overOf(v.keep) != null && overOf(v.keep) === overOf(v.divide) && (overOf(v.keep) as number) > 0
                                        && v.keep.used_empty_beds !== v.divide.used_empty_beds ? overOf(v.keep) as number : 0;
                                    return (
                                        <div className="rounded-2xl border border-gray-100 px-4 py-3 space-y-2" data-plan-variants={v.chosen}>
                                            <p className="text-xs font-black text-gray-800">{tx('plan.variants.title', 'Familias (regla preferente): ¿juntas o divididas?')}</p>
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label={tx('plan.variants.title', 'Familias (regla preferente): ¿juntas o divididas?')}>
                                                {(['keep', 'divide'] as const).map(k => {
                                                    const x = v[k];
                                                    const on = v.chosen === k;
                                                    return (
                                                        <button key={k} type="button" role="radio" aria-checked={on} onClick={() => setDivide(k === 'divide')} disabled={!!busy || applied}
                                                            className={`text-left rounded-xl border-2 px-3 py-2.5 transition-colors ${on ? 'border-indigo-500 bg-indigo-50' : 'border-gray-100 hover:border-indigo-300'} disabled:cursor-default`} data-plan-variant={k}>
                                                            <span className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-gray-500">
                                                                <i className={`fa-solid ${on ? 'fa-circle-dot text-indigo-600' : 'fa-circle text-gray-300'}`} aria-hidden="true"></i>
                                                                {k === 'keep' ? tx('plan.variants.keep', 'Familias juntas') : tx('plan.variants.divide', 'Dividiendo familias')}
                                                            </span>
                                                            <span className="block mt-1 text-base font-black text-gray-900 tabular-nums" data-plan-variant-rooms={usedOf(x)}>{cnt('plan.variants.used', usedOf(x), '{n} habitaciones usadas', '1 habitación usada')}</span>
                                                            {x.free_rooms != null && <span className="block text-[11px] font-bold text-gray-800 tabular-nums" data-plan-variant-free={x.free_rooms}>
                                                                {x.free_rooms > 0
                                                                    ? `${cnt('plan.variants.free', x.free_rooms, '{n} habitaciones libres', '1 habitación libre')} (${cnt('plan.totals.beds', x.free_beds as number, '{n} camas', '1 cama')})`
                                                                    : tx('plan.variants.free.none', 'Ninguna habitación libre')}
                                                            </span>}
                                                            <span className="block text-[11px] text-gray-600 tabular-nums">
                                                                {cnt('plan.variants.empty', emptyOf(x), '{n} camas vacías en las usadas', '1 cama vacía en las usadas')}
                                                                {x.unplaced > 0 ? ` · ${cnt('plan.variants.unplaced', x.unplaced, '{n} sin cama', '1 sin cama')}` : ''}
                                                            </span>
                                                            <span className={`block text-[11px] tabular-nums ${x.families_divided > 0 ? 'font-bold text-gray-800' : 'text-gray-500'}`} data-plan-variant-divided={x.families_divided}>
                                                                {x.families_divided > 0 ? cnt('plan.variants.divided', x.families_divided, '{n} familias divididas', '1 familia dividida') : tx('plan.variants.none', 'Ninguna familia dividida')}
                                                            </span>
                                                            {x.today && <span className="block mt-1 text-[11px] font-bold text-emerald-700" data-plan-variant-today="">
                                                                <i className="fa-solid fa-equals mr-1" aria-hidden="true"></i>{tx('plan.variants.today', 'Las habitaciones de hoy: no se cambia ninguna.')}
                                                            </span>}
                                                            <span className="block mt-1 text-[10px] text-gray-400">{k === 'keep' ? tx('plan.variants.keep.hint', 'Una familia solo se divide si así alguien más tiene cama.') : tx('plan.variants.divide.hint', 'Las familias se dividen por género si así se usan menos habitaciones.')}</span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                            {spare > 0 && <p className="text-[11px] text-gray-600" data-plan-variants-spare={spare}>
                                                {cnt('plan.variants.spare', spare, 'En los dos casos sobran {n} camas; lo que cambia es cuántas quedan vacías dentro de las habitaciones usadas y cuántas en habitaciones enteras libres.', 'En los dos casos sobra una cama; lo que cambia es si queda vacía dentro de una habitación usada o como una habitación libre.')}
                                            </p>}
                                            <p className="text-[11px] font-bold text-gray-700" data-plan-variants-saved={saved > 0 ? saved : 0}>
                                                {saved > 0
                                                    ? cnt('plan.variants.saves', saved, 'Dividiendo familias se usan {n} habitaciones menos.', 'Dividiendo familias se usa 1 habitación menos.')
                                                    : tx('plan.variants.same', 'El motor no encontró un reparto con menos habitaciones dividiendo familias.')}
                                            </p>
                                        </div>
                                    );
                                })()}
                                <div className={`rounded-2xl border px-4 py-3 ${ok && !plan.worse ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`} data-plan-verdict={ok && !plan.worse ? 'ok' : 'warn'} role="status" aria-live="polite">
                                    <p className={`text-sm font-black ${ok ? 'text-emerald-800' : 'text-amber-800'}`}>
                                        <i className={`fa-solid ${ok ? 'fa-circle-check' : 'fa-triangle-exclamation'} mr-1.5`} aria-hidden="true"></i>
                                        {ok ? cnt('plan.ok', plan.people, 'Las {n} personas quedan acomodadas sin romper ninguna regla obligatoria.', 'La persona queda acomodada sin romper ninguna regla obligatoria.')
                                            : unplaced ? cnt('plan.short', unplaced, 'No alcanzan las habitaciones libres: {n} personas quedarían sin cama.', 'No alcanzan las habitaciones libres: 1 persona quedaría sin cama.')
                                            : tx('plan.hard', 'Con las habitaciones libres no se pueden cumplir todas las reglas obligatorias:')}
                                    </p>
                                    {!ok && hardList.length > 0 && <ul className="mt-1.5 space-y-0.5 text-[11px] text-amber-900 list-disc pl-5">{hardList.slice(0, 8).map((v: any, i: number) => <li key={i}>{v.detail}</li>)}</ul>}
                                    {/* Nothing the plan found beats today's arrangement (the engine counts today as an answer too). */}
                                    {plan.keeps_today && <p className="mt-1.5 text-xs font-bold text-gray-800" data-plan-keeps-today="">
                                        <i className="fa-solid fa-equals mr-1.5 text-emerald-700" aria-hidden="true"></i>
                                        {plan.outcome.run_placed > 0
                                            ? cnt('plan.keeps.today.run', plan.outcome.run_placed, 'No hace falta cambiar ninguna habitación: el motor no encontró un reparto mejor que el de hoy. Al aplicar, la asignación automática acomoda a las {n} personas que esperan en las camas que ya hay.', 'No hace falta cambiar ninguna habitación: el motor no encontró un reparto mejor que el de hoy. Al aplicar, la asignación automática acomoda a la persona que espera en las camas que ya hay.')
                                            : tx('plan.keeps.today', 'Lo mejor es dejarlo como está: el motor no encontró un reparto mejor que el de hoy.')}
                                    </p>}
                                    {!plan.keeps_today && <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-bold text-gray-700" data-plan-totals="">
                                        <span>{cnt('plan.totals.rooms', plan.totals.rooms, '{n} habitaciones', '1 habitación')}</span>
                                        <span>{cnt('plan.totals.beds', plan.totals.beds, '{n} camas', '1 cama')}</span>
                                        <span>{cnt('plan.totals.empty.in', plan.totals.empty_beds, '{n} camas vacías en ellas', '1 cama vacía en ellas')}</span>
                                        {plan.totals.shared > 0 && <span>{cnt('plan.totals.shared', plan.totals.shared, '{n} compartidas', '1 compartida')}</span>}
                                    </div>}
                                    {plan.current && (
                                        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]" data-plan-compare="">
                                            <dt className="font-bold text-gray-500">{tx('plan.today', 'Hoy, sin cambiar nada')}</dt>
                                            <dd className="text-gray-700">{compareLine(plan.current)}</dd>
                                            <dt className="font-bold text-gray-500">{tx('plan.with', 'Con la sugerencia')}</dt>
                                            <dd className="text-gray-900 font-bold">{compareLine(plan.after)}</dd>
                                        </dl>
                                    )}
                                    {plan.proof && (
                                        <div className="mt-2 space-y-0.5 text-[11px]" data-plan-proof={plan.proof.beds_optimal ? 'optimal' : 'bound'}>
                                            {plan.proof.beds_optimal ? (
                                                <p className="font-bold text-emerald-800">
                                                    <i className="fa-solid fa-square-check mr-1.5" aria-hidden="true"></i>
                                                    {plan.proof.unplaced_min > 0
                                                        ? tx('plan.proof.beds', 'Demostrado: ningún reparto puede dar cama a más personas — hay {beds} camas para {people} personas, así que al menos {min} quedan sin cama.', { beds: plan.proof.beds, people: plan.proof.people, min: plan.proof.unplaced_min })
                                                        : tx('plan.proof.all', 'Demostrado: todas las personas tienen cama.')}
                                                </p>
                                            ) : (
                                                <p className="text-gray-600">
                                                    <i className="fa-solid fa-calculator mr-1.5 text-gray-400" aria-hidden="true"></i>
                                                    {tx('plan.proof.bound', 'Límite matemático: con {beds} camas para {people} personas, ningún reparto deja menos de {min} sin cama; esta sugerencia deja {n}. La diferencia viene de las reglas (por ejemplo, separar por género) y del tamaño de las habitaciones.', { beds: plan.proof.beds, people: plan.proof.people, min: plan.proof.unplaced_min, n: plan.after.unplaced })}
                                                    {!plan.options.fresh && <> {tx('plan.proof.fresh', 'Esta sugerencia no mueve a quien ya tiene cama: con «Rehacer todo el reparto» puede acercarse a ese límite.')}</>}
                                                </p>
                                            )}
                                            {plan.proof.rooms_optimal && (
                                                <p className="font-bold text-emerald-800">
                                                    <i className="fa-solid fa-square-check mr-1.5" aria-hidden="true"></i>
                                                    {tx('plan.proof.rooms', 'Y no se pueden usar menos habitaciones: {rooms} es el mínimo para acomodar a {placed} personas.', { rooms: plan.proof.rooms_min, placed: plan.proof.people - plan.after.unplaced })}
                                                </p>
                                            )}
                                        </div>
                                    )}
                                    {plan.worse && <p className="mt-2 text-xs font-black text-rose-700" data-plan-worse="">{tx('plan.worse', 'Esta sugerencia dejaría a las personas peor que el reparto actual: no se puede aplicar.')}</p>}
                                </div>
                                </>
                            )}

                            {settledBroken.length > 0 && (
                                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 space-y-2" data-plan-settled-broken="">
                                    <p className="text-[12px] font-bold text-rose-800">
                                        <i className="fa-solid fa-triangle-exclamation mr-1.5" aria-hidden="true"></i>
                                        {tx('plan.settled.broken', '{list} ya tienen cama para todos, pero su acomodación rompe una regla obligatoria (por ejemplo, una regla nueva). La sugerencia solo reparte camas libres: para corregirlas, rehaz todo el reparto.', { list: settledBroken.map((l: any) => l.name).join(', ') })}
                                    </p>
                                    <button type="button" className={ghost} onClick={() => setFresh(true)} disabled={!!busy || applied} data-plan-fresh-on="">
                                        <i className="fa-solid fa-rotate" aria-hidden="true"></i>{tx('plan.fresh.on', 'Rehacer todo el reparto')}
                                    </button>
                                </div>
                            )}
                            {misused.length > 0 && (
                                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 space-y-1" data-plan-oversized="">
                                    {misused.map((o: any, i: number) => (
                                        <p key={i} className="text-[11px] text-amber-900">
                                            <i className="fa-solid fa-people-group mr-1.5" aria-hidden="true"></i>
                                            {tx('plan.oversized', 'La regla «{rule}» pide juntar en una sola habitación a las {n} personas con «{value}», y ninguna habitación tiene más de {max} camas: no se puede cumplir, así que se acomodan por separado. Si lo que buscas es que no compartan habitación con otros, usa una regla «Separar por».', { rule: o.rule, value: o.value, n: o.people, max: o.largest_room })}
                                        </p>
                                    ))}
                                </div>
                            )}
                            {bigByRule.map(({ rule, groups }) => (
                                <p key={rule} className="text-[11px] text-gray-600 bg-gray-50 border border-gray-100 rounded-2xl px-4 py-2.5" data-plan-big-groups={groups.length}>
                                    <i className="fa-solid fa-people-roof mr-1.5 text-gray-400" aria-hidden="true"></i>
                                    {groups.length === 1
                                        ? tx('plan.big.one', '«{value}» ({n} personas) no cabe completo en una habitación —la más grande tiene {max} camas—: «{rule}» lo acomoda en el menor número de habitaciones, lo más junto posible.', { value: groups[0].value, n: groups[0].people, max: groups[0].largest_room, rule })
                                        : tx('plan.big', '{k} grupos de «{rule}» no caben completos en una habitación —la más grande tiene {max} camas—, así que cada uno se acomoda en el menor número de habitaciones, lo más junto posible: {list}.', { k: groups.length, rule, max: groups[0].largest_room, list: groups.slice(0, 6).map((o: any) => `${o.value} (${o.people})`).join(', ') + (groups.length > 6 ? tx('plan.big.more', ' y {n} más', { n: groups.length - 6 }) : '') })}
                                </p>
                            ))}
                            {plan.short && plan.order && plan.order.length > 1 && (
                                <div className="rounded-2xl border border-gray-100 px-4 py-3 space-y-2" data-plan-order="">
                                    <p className="text-[11px] text-gray-700">
                                        <i className="fa-solid fa-list-ol mr-1.5 text-gray-400" aria-hidden="true"></i>
                                        {tx('plan.order.hint', 'No alcanzan las camas: {people} personas esperan y hay {beds} camas libres. Se reparten por localidad, en este orden: la primera recibe todo lo que necesita, luego la siguiente. Cámbialo con las flechas.', { people: plan.short.people, beds: plan.short.beds })}
                                    </p>
                                    <ol className="divide-y divide-gray-100 rounded-xl border border-gray-100">
                                        {plan.order.map((o: any, i: number) => (
                                            <li key={o.location_id} className="flex items-center gap-2 px-3 py-1.5" data-plan-order-item={o.location_id}>
                                                <span className="w-6 text-[11px] font-black text-gray-400 text-right">{i + 1}.</span>
                                                <span className="flex-1 min-w-0 truncate text-sm font-bold text-gray-800">{o.name}</span>
                                                {o.state === 'settled' && <span className={`${chip} bg-emerald-50 text-emerald-700`}>{tx('plan.order.settled', 'Todos con cama')}</span>}
                                                {o.state === 'frozen' && <span className={`${chip} bg-gray-100 text-gray-500`}>{tx('plan.order.frozen', 'Enviada')}</span>}
                                                <button type="button" onClick={() => move(i, -1)} disabled={!!busy || applied || i === 0}
                                                    aria-label={tx('plan.order.up', 'Subir {name}', { name: o.name })}
                                                    className="w-9 h-9 rounded-xl text-gray-500 hover:bg-gray-100 disabled:opacity-30"><i className="fa-solid fa-arrow-up" aria-hidden="true"></i></button>
                                                <button type="button" onClick={() => move(i, 1)} disabled={!!busy || applied || i === plan.order.length - 1}
                                                    aria-label={tx('plan.order.down', 'Bajar {name}', { name: o.name })}
                                                    className="w-9 h-9 rounded-xl text-gray-500 hover:bg-gray-100 disabled:opacity-30"><i className="fa-solid fa-arrow-down" aria-hidden="true"></i></button>
                                            </li>
                                        ))}
                                    </ol>
                                </div>
                            )}
                            {plan.held && (plan.held.rooms > 0 || plan.held.people > 0) && (
                                <p className="text-[11px] text-gray-600" data-plan-held={`${plan.held.rooms}/${plan.held.people}`}>
                                    <i className="fa-solid fa-lock mr-1.5 text-amber-500" aria-hidden="true"></i>
                                    {tx('plan.held', 'Se quedan como están: {rooms} y {people}.', {
                                        rooms: cnt('plan.held.rooms', plan.held.rooms, '{n} habitaciones bloqueadas', '1 habitación bloqueada'),
                                        people: cnt('plan.held.people', plan.held.people, '{n} personas fijadas', '1 persona fijada'),
                                    })}
                                </p>
                            )}
                            {(plan.rooms || []).some((r: any) => r.after.kind === 'shared' && (r.after.lock || []).length > 0) && (
                                <p className="text-[11px] text-gray-600" data-plan-lock-note="">
                                    <i className="fa-solid fa-lock mr-1.5 text-rose-400" aria-hidden="true"></i>
                                    {tx('plan.lock.note', 'Cada habitación compartida queda fija para el género que le da el reparto: ninguna localidad podrá acomodar allí a otra persona (el admin puede liberarla en «Repartir camas»).')}
                                </p>
                            )}
                            {/* With both answers on screen their cards say it; otherwise (beds short) this line does. */}
                            {!plan.variants && plan.families_split > 0 && <p className="text-[11px] text-gray-600" data-plan-families-split={plan.families_split}>{cnt('plan.families.split', plan.families_split, 'Para dar cama a más personas, {n} familias (regla preferente) quedan divididas.', 'Para dar cama a más personas, 1 familia (regla preferente) queda dividida.')}</p>}
                            {plan.options.fresh && plan.moved > 0 && <p className="text-[11px] font-bold text-amber-800" data-plan-moved={plan.moved}>{cnt('plan.moved', plan.moved, '{n} personas que ya tenían cama cambian de habitación (o quedan sin cama).', '1 persona que ya tenía cama cambia de habitación (o queda sin cama).')}</p>}
                            {plan.outcome.run_placed > 0 && <p className="text-[11px] text-gray-600" data-plan-run-placed={plan.outcome.run_placed}>{cnt('plan.run.more', plan.outcome.run_placed, 'Después, la asignación automática acomoda a {n} personas más.', 'Después, la asignación automática acomoda a 1 persona más.')}</p>}
                            {plan.kept > 0 && <p className="text-[11px] text-gray-600" data-plan-kept={plan.kept}>{cnt('plan.kept', plan.kept, '{n} personas van a camas que su localidad ya tenía.', '1 persona va a una cama que su localidad ya tenía.')}</p>}
                            {softList.length > 0 && (
                                <details className="rounded-2xl border border-gray-100 px-4 py-3" data-plan-soft="">
                                    <summary className="text-xs font-bold text-gray-700 cursor-pointer">{cnt('plan.soft', softList.length, '{n} preferencias no se cumplen', '1 preferencia no se cumple')}</summary>
                                    <ul className="mt-2 space-y-0.5 text-[11px] text-gray-600 list-disc pl-5">{softList.slice(0, 30).map((v: any, i: number) => <li key={i}>{v.detail}</li>)}</ul>
                                </details>
                            )}

                            {plan.locations.length > 0 && (
                                <div className="space-y-2" data-plan-locations="">
                                    <h3 className="text-[11px] font-black uppercase tracking-widest text-gray-500">{tx('plan.locations', 'Por localidad')}</h3>
                                    <ul className="divide-y divide-gray-100 rounded-2xl border border-gray-100">
                                        {plan.locations.map((l: any) => (
                                            <li key={l.location_id} className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1" data-plan-location={l.location_id} data-plan-settled={l.settled ? '' : undefined}>
                                                <span className="text-sm font-bold text-gray-900 min-w-0 truncate">{l.name}</span>
                                                {l.settled ? (
                                                    <span className="text-[11px] text-gray-600">
                                                        {cnt('plan.settled', l.people, '{n} personas · todas con cama (no se tocan)', '1 persona · con cama (no se toca)')}
                                                        {l.violations.some((v: any) => v.hard) && <span className="ml-1 font-bold text-rose-600">{cnt('plan.settled.hard', l.violations.filter((v: any) => v.hard).length, '· rompe {n} reglas obligatorias', '· rompe 1 regla obligatoria')}</span>}
                                                    </span>
                                                ) : (
                                                <span className="text-[11px] text-gray-600">
                                                    {`${cnt('plan.people', l.people, '{n} personas', '1 persona')} → ${cnt('plan.rooms.n', l.rooms, '{n} habitaciones', '1 habitación')} (${cnt('plan.beds.n', l.beds, '{n} camas', '1 cama')})`}
                                                    {l.shared_rooms > 0 ? ` · ${cnt('plan.location.shared', l.shared_rooms, '{n} compartidas', '1 compartida')}` : ''}
                                                    {l.unplaced > 0 && <span className="ml-1 font-bold text-rose-600">{tx('plan.location.unplaced', '· {n} sin cama', { n: l.unplaced })}</span>}
                                                </span>
                                                )}
                                            </li>
                                        ))}
                                        {plan.pool && plan.pool.people > 0 && (
                                            <li className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1" data-plan-location="pool">
                                                <span className="text-sm font-bold text-gray-700">{tx('plan.pool.people', 'Sin localidad')}</span>
                                                <span className="text-[11px] text-gray-600">{`${cnt('plan.people', plan.pool.people, '{n} personas', '1 persona')} → ${cnt('plan.free.rooms', plan.pool.rooms, '{n} habitaciones libres', '1 habitación libre')}`}</span>
                                            </li>
                                        )}
                                    </ul>
                                </div>
                            )}

                            {(plan.rooms.length > 0 || plan.released.length > 0) && (
                                <div className="space-y-2" data-plan-rooms="">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <h3 className="text-[11px] font-black uppercase tracking-widest text-gray-500">{tx('plan.rooms', 'Habitaciones')}</h3>
                                        {plan.rooms.some((r: any) => !r.changed) && (
                                            <button type="button" className="text-[11px] font-bold text-blue-600 hover:underline" onClick={() => setShowAll((v) => !v)}>
                                                {showAll ? tx('plan.rooms.changed', 'Solo las que cambian') : tx('plan.rooms.all', 'Ver también las que se quedan igual')}
                                            </button>
                                        )}
                                    </div>
                                    <ul className="divide-y divide-gray-100 rounded-2xl border border-gray-100">
                                        {shownRooms.map((r: any) => (
                                            <li key={r.room_id} className="px-4 py-2.5 space-y-1" data-plan-room={r.room_id}>
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="text-sm font-black text-gray-900">{r.hotel_name} · {r.room_number}</span>
                                                    <span className="text-[11px] text-gray-500">{cnt('plan.room.beds', r.capacity, '{n} camas', '1 cama')}</span>
                                                    {r.after.kind === 'shared' && <span className={`${chip} bg-violet-50 text-violet-700`}>{tx('plan.room.shared', 'Compartida')}</span>}
                                                    {r.after.kind === 'shared' && (r.after.lock || []).length > 0 && (
                                                        <span className={`${chip} bg-rose-50 text-rose-700`} data-plan-room-lock="">
                                                            <i className="fa-solid fa-lock mr-1" aria-hidden="true"></i>
                                                            {tx('plan.room.lock', 'Solo {v}', { v: lockText(r.after.lock, { F: tx('room.lock.women', 'Mujeres').toLowerCase(), M: tx('room.lock.men', 'Hombres').toLowerCase() }) })}
                                                        </span>
                                                    )}
                                                    {r.had_people && <span className={`${chip} bg-sky-50 text-sky-700`}>{tx('plan.room.had', 'Ya tenía personas')} · +{r.added}</span>}
                                                    {!r.changed && !r.had_people && <span className={`${chip} bg-gray-100 text-gray-500`}>{tx('plan.room.same', 'Se queda igual')}</span>}
                                                    {r.empty_beds > 0 && <span className={`${chip} bg-amber-50 text-amber-700`}>{cnt('plan.room.empty', r.empty_beds, '{n} vacías', '1 vacía')}</span>}
                                                </div>
                                                <p className="text-[11px] text-gray-600">
                                                    {(r.people || []).map((m: any) => `${m.location_name || tx('plan.pool.people', 'Sin localidad')} (${m.count})`).join(' + ')}
                                                    {r.labels && r.labels.length ? ` · ${r.labels.join(', ')}` : ''}
                                                </p>
                                                {r.changed && <p className="text-[10px] text-gray-400">{tx('plan.room.before', 'Antes: {a}', { a: allotText(r.before) })}</p>}
                                            </li>
                                        ))}
                                        {plan.released.map((r: any) => (
                                            <li key={`x${r.room_id}`} className="px-4 py-2.5" data-plan-released={r.room_id}>
                                                <span className="text-sm font-bold text-gray-700">{r.hotel_name} · {r.room_number}</span>
                                                <span className="ml-2 text-[11px] text-gray-500">{tx('plan.room.released', 'Se libera (antes: {a})', { a: allotText(r.before) })}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {plan.skipped_frozen.length > 0 && (
                                <p className="text-[11px] text-gray-500" data-plan-frozen="">
                                    <i className="fa-solid fa-lock mr-1" aria-hidden="true"></i>
                                    {tx('plan.frozen', 'No se tocan las localidades enviadas o validadas: {list}.', { list: plan.skipped_frozen.map((l: any) => l.name).join(', ') })}
                                </p>
                            )}
                        </>
                    )}
                </div>

                <div className="px-5 sm:px-7 py-4 border-t border-gray-100 flex flex-wrap justify-end gap-2 bg-white">
                    {applied ? (
                        <button type="button" className={primary} onClick={onClose} data-plan-done="">
                            <i className="fa-solid fa-check" aria-hidden="true"></i>{tx('plan.done', 'Listo')}
                        </button>
                    ) : (
                        <>
                            <button type="button" className={ghost} onClick={onClose} disabled={!!busy}>{tx('cancel', 'Cancelar')}</button>
                            {/* Nothing would change (no allotment, nobody placed, nobody moved): disabled. */}
                            {plan && plan.people > 0 && <button type="button" className={primary} onClick={apply} disabled={!!busy || plan.worse || (!plan.totals.changed && !plan.placements.length && !plan.moved && !plan.outcome.run_placed)} data-plan-apply="">
                                <i className={`fa-solid ${busy === 'apply' ? 'fa-spinner animate-spin' : 'fa-check'}`} aria-hidden="true"></i>{tx('plan.apply', 'Aplicar reparto')}
                            </button>}
                        </>
                    )}
                </div>
            </div>
        </Overlay>
    );
}
