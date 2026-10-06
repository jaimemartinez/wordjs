// @ts-nocheck
"use client";

/**
 * Meals (2.14.0) — «Alimentación».
 *
 * 1. Plan: the conference's services (one meal on one day), created in bulk from a date range × meals,
 *    and the location × service matrix that says who gets what («solo alguna de ellas» = any subset).
 * 2. Por persona: an attendee's services with where each entitlement comes from, and a three-state
 *    adjustment per service (inherit from the location / include / exclude).
 * 3. Entrega: the kitchen screen — USB/Bluetooth scanners type the code + Enter into a big autofocused
 *    input; the phone «Modo escáner» uses the camera (see MealScanner.tsx).
 * 4. Reporte: per service totals, per location, who is pending / served, Excel export.
 *
 * Entitlement and every counter are computed by the server; this page never decides who may eat.
 *
 * Staff roles (2.15.0): Plan / Por persona / Reporte need Alimentación › ver (editing the plan and the
 * per-person adjustments needs › gestionar); Entrega and «Modo escáner» need Entrega de comidas › operar
 * — the kitchen can deliver without seeing (or touching) the plan. Administrators see everything.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { useModal } from "@/contexts/ModalContext";
import { conferenceApi } from "../lib/conference";
import { buildXlsx, downloadXlsx } from "../lib/xlsx";
import { exportFilename, withoutColumn } from "../lib/exports";
import {
    MEALS, DEFAULT_WINDOWS, buildMealReportWorkbook, chunk, columnState, dateRange, filterReportRows, groupByDay,
    normalizeCode, pickCurrentService, planKey, planSet, rowState, serviceWindow, sortServices, stampDayTime, stampTime,
} from "../lib/meals";
import { MealScanner, PersonSearch, VerdictCard, MEAL_ICON, dayLabel, mealName, serviceName, servedLine, isOffline, useMealDelivery, useTx, makeTxn, createFeedback } from "./MealScanner";
import { usePerms, ReadOnlyNotice } from "./perms";

type Tab = 'plan' | 'people' | 'delivery' | 'report';
const TABS: Tab[] = ['plan', 'people', 'delivery', 'report'];
const TAB_KEY = 'conference-manager:meals.tab';

const inputCls = 'w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm';
const labelCls = 'block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1';
const btnGhost = 'px-4 py-2.5 rounded-xl bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400 font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50';
const btnPrimary = 'px-6 py-3 rounded-2xl bg-blue-600 text-white hover:bg-blue-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-blue-500/30 transition-all active:scale-95 disabled:opacity-50';
const card = 'bg-white rounded-3xl border border-gray-100 shadow-sm';

function Modal({ title, subtitle, onClose, children, footer, wide = false }: any) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4 animate-in fade-in duration-200" onClick={onClose}>
            <div className={`bg-white rounded-[32px] shadow-2xl w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} border border-gray-100 overflow-hidden max-h-[92vh] flex flex-col`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
                <div className="bg-gray-50/50 px-6 sm:px-8 py-5 border-b border-gray-100 flex items-start justify-between gap-4 shrink-0">
                    <div className="min-w-0">
                        <h3 className="font-black text-2xl italic tracking-tighter text-gray-900 break-words">{title}</h3>
                        {subtitle && <p className="text-xs font-semibold text-gray-500 mt-1">{subtitle}</p>}
                    </div>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-2 hover:bg-gray-100 rounded-2xl" aria-label="Cerrar"><i className="fa-solid fa-xmark text-xl"></i></button>
                </div>
                <div className="p-6 sm:p-8 space-y-4 overflow-y-auto">{children}</div>
                {footer && <div className="px-6 sm:px-8 py-4 border-t border-gray-50 bg-gray-50/30 flex flex-wrap justify-end gap-3 shrink-0">{footer}</div>}
            </div>
        </div>
    );
}

const Spinner = ({ label }: any) => (
    <div className="text-center py-16">
        <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-3"></div>
        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{label}</p>
    </div>
);

const Counter = ({ label, value, tone = 'text-gray-900', icon }: any) => (
    <div className="bg-gray-50/80 px-4 py-3 rounded-2xl border border-gray-100">
        <div className="text-[9px] font-black text-gray-400 uppercase tracking-widest">{icon && <i className={`fa-solid ${icon} mr-1`} aria-hidden="true"></i>}{label}</div>
        <div className={`text-2xl font-black italic tracking-tighter mt-0.5 tabular-nums ${tone}`}>{value}</div>
    </div>
);

export default function MealsPage({ conferenceId, slug, conference }: { conferenceId: number; slug?: string; conference?: any }) {
    const tx = useTx();
    const { language } = useI18n();
    const { addToast } = useToast();
    const perms = usePerms();
    const canPlan = perms.can('meals');
    const canDeliver = perms.can('meals_delivery', 'manage');
    // The sub-tabs this role may open, in order; a saved tab it may not open falls back to the first.
    const allowedTabs = TABS.filter((k) => (k === 'delivery' ? canDeliver : canPlan));
    const [tab, setTabState] = useState<Tab>(() => {
        try { const v = localStorage.getItem(TAB_KEY) as Tab; return TABS.includes(v) ? v : 'plan'; } catch { return 'plan'; }
    });
    const setTab = (v: Tab) => { setTabState(v); try { localStorage.setItem(TAB_KEY, v); } catch { /* blocked storage */ } };
    const shownTab: Tab = allowedTabs.includes(tab) ? tab : (allowedTabs[0] || 'plan');
    const [data, setData] = useState<any>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [serviceId, setServiceId] = useState<number | null>(null);
    const [scanner, setScanner] = useState(false);

    const reload = useCallback(async () => {
        try { const d = await conferenceApi.getMeals(conferenceId); setData(d); setLoadFailed(false); return d; }
        catch (e: any) { setLoadFailed(true); addToast(e?.message || 'Error', 'error'); return null; }
    }, [conferenceId, addToast]);
    // Set when the selected service disappeared under us (deleted by another admin): from then on nothing
    // is picked automatically — every following scan would otherwise land on whatever service happens to be
    // «current» (lunch scans recorded as dinner). The user must choose; choosing clears the flag.
    const lostRef = useRef(false);
    useEffect(() => { setData(null); setServiceId(null); lostRef.current = false; reload(); }, [conferenceId]);
    const chooseService = useCallback((id: number | null) => { lostRef.current = false; setServiceId(id); }, []);

    const services = useMemo(() => sortServices(data?.services), [data]);
    // The selected service (Entrega / Reporte / scanner): kept while it exists; picked automatically only
    // on the first load (the service being served now).
    useEffect(() => {
        if (!data) return;
        if (serviceId != null) {
            if (services.some((s) => s.id === serviceId)) return;
            lostRef.current = true;
            setServiceId(null);
            return;
        }
        if (!lostRef.current) setServiceId(pickCurrentService(services)?.id ?? null);
    }, [data, services, serviceId]);

    if (!data) return loadFailed
        ? <div className="text-center py-16 space-y-3"><p className="text-sm font-bold text-gray-600">{tx('meals.load.failed', 'No se pudo cargar la alimentación.')}</p><button className={btnGhost} onClick={reload}>{tx('meals.retry', 'Reintentar')}</button></div>
        : <Spinner label={tx('loading', 'Cargando…')} />;

    const totals = services.reduce((a, s) => ({ entitled: a.entitled + (s.entitled || 0), delivered: a.delivered + (s.delivered || 0) }), { entitled: 0, delivered: 0 });
    const tabMeta: Record<Tab, [string, string]> = {
        plan: [tx('meals.tab.plan', 'Plan'), 'fa-table-cells'],
        people: [tx('meals.tab.people', 'Por persona'), 'fa-user'],
        delivery: [tx('meals.tab.delivery', 'Entrega'), 'fa-barcode'],
        report: [tx('meals.tab.report', 'Reporte'), 'fa-clipboard-list'],
    };

    return (
        // inert while the phone scanner is open: nothing underneath may take the focus or a wedge scanner's keys.
        <div className="space-y-6 animate-in fade-in duration-500" data-meals-page="" inert={scanner || undefined}>
            {/* Header */}
            <div className="relative overflow-hidden bg-white rounded-3xl p-6 sm:p-8 border border-gray-100 shadow-xl shadow-gray-100/50">
                <div className="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 bg-orange-50/70 rounded-full blur-3xl pointer-events-none"></div>
                <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                    <div>
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 rounded-xl bg-orange-500 flex items-center justify-center text-white shadow-lg shadow-orange-200"><i className="fa-solid fa-utensils"></i></div>
                            <span className="text-[10px] font-bold text-orange-600 uppercase tracking-[0.2em]">{tx('meals', 'Alimentación')}</span>
                        </div>
                        <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter">{tx('meals.title', 'Comidas y entregas')}</h2>
                        <p className="text-xs text-gray-500 mt-1 max-w-xl">{tx('meals.subtitle', 'Define qué comidas recibe cada localidad, ajusta por persona y registra cada entrega con el código de barras del participante.')}</p>
                    </div>
                    {canDeliver && <button type="button" onClick={() => setScanner(true)} disabled={!services.length}
                        className="px-6 py-4 rounded-2xl bg-gray-900 text-white hover:bg-black font-black text-xs uppercase tracking-widest shadow-lg transition-all active:scale-95 disabled:opacity-50">
                        <i className="fa-solid fa-mobile-screen-button mr-2" aria-hidden="true"></i>{tx('meals.scanner.open', 'Modo escáner (celular)')}
                    </button>}
                </div>
                <div className="relative grid grid-cols-3 gap-3 mt-6">
                    <Counter label={tx('meals.count.services', 'Servicios')} value={services.length} icon="fa-utensils" />
                    <Counter label={tx('meals.count.entitled.all', 'Raciones con derecho')} value={totals.entitled} icon="fa-users" />
                    <Counter label={tx('meals.count.delivered.all', 'Raciones entregadas')} value={totals.delivered} tone="text-emerald-600" icon="fa-circle-check" />
                </div>
            </div>

            {/* Sub-tabs (only the ones the role may open) */}
            <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={tx('meals', 'Alimentación')}>
                {allowedTabs.map((k) => (
                    <button key={k} type="button" role="tab" aria-selected={shownTab === k} onClick={() => setTab(k)}
                        className={`flex items-center gap-2 px-5 py-3 rounded-2xl border-2 font-black text-[11px] uppercase tracking-widest whitespace-nowrap transition-all ${shownTab === k ? 'border-orange-400 bg-orange-50 text-orange-700' : 'border-gray-100 bg-white text-gray-500 hover:border-gray-300'}`}>
                        <i className={`fa-solid ${tabMeta[k][1]}`} aria-hidden="true"></i>{tabMeta[k][0]}
                    </button>
                ))}
            </div>
            {shownTab !== 'delivery' && <ReadOnlyNotice section="meals" alsoManage={shownTab === 'people' ? ['meals_delivery'] : []} />}

            {shownTab === 'plan' && canPlan && <PlanTab conferenceId={conferenceId} conference={conference} data={data} services={services} reload={reload} />}
            {shownTab === 'people' && canPlan && <PeopleTab conferenceId={conferenceId} data={data} services={services} reload={reload} />}
            {shownTab === 'delivery' && canDeliver && <DeliveryTab conferenceId={conferenceId} services={services} locations={data.locations || []} serviceId={serviceId} setServiceId={chooseService} reload={reload} paused={scanner} onScanner={() => setScanner(true)} />}
            {shownTab === 'report' && canPlan && <ReportTab services={services} serviceId={serviceId} setServiceId={chooseService} slug={slug} />}

            {scanner && canDeliver && (
                <MealScanner conferenceId={conferenceId} services={services} serviceId={serviceId} language={language}
                    onServiceChange={chooseService} onChanged={reload} onClose={() => { setScanner(false); reload(); }} />
            )}
        </div>
    );
}

// ── Service picker (Entrega / Reporte) ───────────────────────────────────────────────────────────────
function ServiceSelect({ services, serviceId, setServiceId, id }: any) {
    const tx = useTx();
    const { language } = useI18n();
    const days = groupByDay(services);
    return (
        <select id={id} className={inputCls} value={serviceId ?? ''} onChange={(e) => setServiceId(e.target.value ? Number(e.target.value) : null)}>
            {!services.length && <option value="">{tx('meals.services.none', 'Todavía no hay servicios de comida.')}</option>}
            {/* Nothing selected (e.g. the service was deleted): say so instead of showing the first one. */}
            {services.length > 0 && serviceId == null && <option value="">{tx('meals.scanner.pick', 'Elige un servicio')}</option>}
            {days.map((d) => (
                <optgroup key={d.date} label={dayLabel(d.date, language, true)}>
                    {d.services.map((s) => <option key={s.id} value={s.id}>{serviceName(tx, s, language)}</option>)}
                </optgroup>
            ))}
        </select>
    );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. PLAN
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
function PlanTab({ conferenceId, conference, data, services, reload }: any) {
    const tx = useTx();
    const txn = makeTxn(tx);
    const { language } = useI18n();
    const { addToast } = useToast();
    const { confirm } = useModal();
    const canEdit = usePerms().can('meals', 'manage');
    const [creating, setCreating] = useState(false);
    const [editing, setEditing] = useState<any>(null);
    const [busyCell, setBusyCell] = useState<string | null>(null);
    const [plan, setPlan] = useState<Set<string>>(() => planSet(data.plan));
    useEffect(() => { setPlan(planSet(data.plan)); }, [data]);
    const locations = data.locations || [];
    const locationIds = locations.map((l) => Number(l.id));
    const days = groupByDay(services);

    // The count in the confirmation must be today's, not the one loaded minutes ago (the kitchen keeps
    // scanning): re-read the service first. Gone already → just refresh.
    const remove = async (s0: any) => {
        const d = await reload();
        const s = d?.services?.find((x) => x.id === s0.id);
        if (!s) return;
        const name = serviceName(tx, s, language);
        const n = Number(s.delivered) || 0;
        const ok = n > 0
            ? await confirm(txn('meals.delete.confirm.deliveries', '«{service}» ya tiene {n} entregas registradas. ¿Eliminar el servicio y sus entregas?', '«{service}» ya tiene {n} entrega registrada. ¿Eliminar el servicio y su entrega?', n, { service: name }))
            : await confirm(tx('meals.delete.confirm', '¿Eliminar «{service}»?', { service: name }));
        if (ok) doDelete(s, n > 0);
    };
    const doDelete = async (s: any, force: boolean) => {
        try {
            const r = await conferenceApi.deleteMealService(s.id, force);
            const gone = Number(r?.deleted_deliveries) || 0;
            addToast(gone > 0 ? txn('meals.deleted.n', 'Servicio eliminado ({n} entregas borradas)', 'Servicio eliminado ({n} entrega borrada)', gone) : tx('meals.deleted', 'Servicio eliminado'), 'success');
            reload();
        } catch (e: any) {
            // A delivery landed meanwhile (409 asking to confirm): ask again with the fresh count.
            if (e?.status === 409 && !force) { remove(s); return; }
            if (e?.status === 404) reload();
            addToast(e?.message || 'Error', 'error');
        }
    };
    // A 404 means the service / location is gone (another admin): refresh instead of leaving a ghost.
    const failed = (e: any) => { if (e?.status === 404) reload(); addToast(e?.message || 'Error', 'error'); };

    const toggle = async (locationId: number, serviceId: number) => {
        const key = planKey(locationId, serviceId);
        const enabled = !plan.has(key);
        setBusyCell(key);
        try {
            await conferenceApi.toggleMealPlan(locationId, serviceId, enabled);
            setPlan((prev) => { const n = new Set(prev); if (enabled) n.add(key); else n.delete(key); return n; });
            reload();
        } catch (e: any) { failed(e); }
        finally { setBusyCell(null); }
    };
    const setRow = async (locationId: number) => {
        const all = rowState(locationId, services, plan) === 'all';
        setBusyCell(`row:${locationId}`);
        try {
            // PUT /meals/plan takes at most 1000 ids: past that, switch on only the missing cells (idempotent).
            if (!all && services.length > 1000) {
                const missing = services.filter((s) => !plan.has(planKey(locationId, s.id)));
                for (const part of chunk(missing, 10)) await Promise.all(part.map((s) => conferenceApi.toggleMealPlan(locationId, s.id, true)));
            } else {
                await conferenceApi.setLocationMealPlan(conferenceId, locationId, all ? [] : services.map((s) => s.id));
            }
            await reload();
        }
        catch (e: any) { failed(e); }
        finally { setBusyCell(null); }
    };
    const setColumn = async (serviceId: number) => {
        const all = columnState(serviceId, locationIds, plan) === 'all';
        setBusyCell(`col:${serviceId}`);
        try { await conferenceApi.setServiceMealPlan(serviceId, all ? [] : locationIds); await reload(); }
        catch (e: any) { failed(e); }
        finally { setBusyCell(null); }
    };

    return (
        <div className="space-y-6">
            {/* Services by day */}
            <div className={`${card} p-5 sm:p-6 space-y-5`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h3 className="text-lg font-black text-gray-900">{tx('meals.services', 'Servicios de comida')}</h3>
                        <p className="text-xs text-gray-500">{tx('meals.services.hint', 'Cada servicio es una comida de un día. Crea varios de una vez eligiendo las fechas y las comidas.')}</p>
                    </div>
                    {canEdit && <button type="button" className={btnPrimary} onClick={() => setCreating(true)}><i className="fa-solid fa-plus mr-1.5" aria-hidden="true"></i>{tx('meals.create', 'Crear servicios')}</button>}
                </div>
                {!services.length && (
                    <div className="text-center py-10 border-2 border-dashed border-gray-100 rounded-3xl">
                        <i className="fa-solid fa-utensils text-3xl text-gray-300 mb-3" aria-hidden="true"></i>
                        <p className="text-sm font-bold text-gray-500">{tx('meals.services.none', 'Todavía no hay servicios de comida.')}</p>
                    </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {days.map((d) => (
                        <div key={d.date} className="rounded-2xl border border-gray-100 bg-gray-50/40 p-4 space-y-2">
                            <div className="text-xs font-black text-gray-700 uppercase tracking-widest">{dayLabel(d.date, language, true)}</div>
                            {d.services.map((s) => {
                                const [a, b] = serviceWindow(s);
                                return (
                                    <div key={s.id} className="flex items-center gap-3 bg-white rounded-xl border border-gray-100 px-3 py-2.5">
                                        <i className={`fa-solid ${MEAL_ICON[s.meal] || 'fa-utensils'} text-orange-500 w-5 text-center`} aria-hidden="true"></i>
                                        <div className="min-w-0 flex-1">
                                            <div className="text-sm font-black text-gray-900 truncate">{mealName(tx, s.meal)}{s.label ? ` — ${s.label}` : ''}</div>
                                            <div className="text-[11px] font-semibold text-gray-500">{a}–{b} · {servedLine(tx, s)}</div>
                                        </div>
                                        {canEdit && <button type="button" onClick={() => setEditing(s)} className="p-2 text-gray-400 hover:text-blue-600" aria-label={tx('meals.edit', 'Editar servicio')}><i className="fa-solid fa-pen" aria-hidden="true"></i></button>}
                                        {canEdit && <button type="button" onClick={() => remove(s)} className="p-2 text-gray-400 hover:text-rose-600" aria-label={tx('meals.delete', 'Eliminar servicio')}><i className="fa-solid fa-trash" aria-hidden="true"></i></button>}
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>

            {/* Matrix */}
            {services.length > 0 && (
                <div className={`${card} p-5 sm:p-6 space-y-4`}>
                    <div>
                        <h3 className="text-lg font-black text-gray-900">{tx('meals.matrix', 'Qué recibe cada localidad')}</h3>
                        <p className="text-xs text-gray-500">{canEdit ? tx('meals.matrix.hint', 'Marca las comidas de cada localidad. Las personas sin localidad solo reciben lo que se les añada en «Por persona».') : tx('meals.matrix.hint.readonly', 'Las comidas que recibe cada localidad. Las personas sin localidad solo reciben lo que se les añada en «Por persona».')}</p>
                    </div>
                    {!locations.length ? (
                        <p className="text-sm font-bold text-gray-500">{tx('meals.matrix.no.locations', 'Esta conferencia no tiene localidades.')}</p>
                    ) : (
                        <div className="overflow-x-auto border border-gray-100 rounded-2xl" data-meals-matrix="">
                            <table className="min-w-max text-sm border-separate border-spacing-0">
                                <thead>
                                    <tr>
                                        <th rowSpan={2} className="sticky left-0 z-20 bg-gray-50 text-left px-4 py-2 text-[10px] font-black uppercase tracking-widest text-gray-500 border-b border-r border-gray-100 min-w-[180px]">{tx('locations', 'Localidades')}</th>
                                        {days.map((d) => (
                                            <th key={d.date} colSpan={d.services.length} className="bg-gray-50 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-gray-600 border-b border-l border-gray-100 text-center whitespace-nowrap">{dayLabel(d.date, language)}</th>
                                        ))}
                                    </tr>
                                    <tr>
                                        {services.map((s) => {
                                            const st = columnState(s.id, locationIds, plan);
                                            return (
                                                <th key={s.id} className="bg-white px-2 py-2 border-b border-l border-gray-100 text-center align-top min-w-[96px]">
                                                    <div className="text-[11px] font-black text-gray-800 whitespace-nowrap"><i className={`fa-solid ${MEAL_ICON[s.meal] || 'fa-utensils'} mr-1 text-orange-500`} aria-hidden="true"></i>{mealName(tx, s.meal)}</div>
                                                    <div className="text-[10px] font-semibold text-gray-400 tabular-nums" title={tx('meals.matrix.cell.counts', 'entregados / con derecho')}>{Math.max(0, (s.entitled || 0) - (s.pending || 0))}/{s.entitled || 0}{s.overrides_delivered > 0 ? ` +${s.overrides_delivered}` : ''}</div>
                                                    {canEdit && <button type="button" disabled={busyCell != null} onClick={() => setColumn(s.id)}
                                                        className="mt-1 text-[9px] font-black uppercase tracking-widest text-blue-600 hover:underline disabled:opacity-40"
                                                        aria-label={st === 'all' ? tx('meals.matrix.col.none.aria', 'Quitar {service} a todas las localidades', { service: serviceName(tx, s, language) }) : tx('meals.matrix.col.all.aria', 'Dar {service} a todas las localidades', { service: serviceName(tx, s, language) })}>
                                                        {st === 'all' ? tx('meals.matrix.unmark.all', 'Desmarcar todas') : tx('meals.matrix.mark.all', 'Marcar todas')}
                                                    </button>}
                                                </th>
                                            );
                                        })}
                                    </tr>
                                </thead>
                                <tbody>
                                    {locations.map((l) => {
                                        const st = rowState(l.id, services, plan);
                                        return (
                                            <tr key={l.id}>
                                                <th scope="row" className="sticky left-0 z-10 bg-white text-left px-4 py-2 border-b border-r border-gray-100">
                                                    <div className="text-sm font-black text-gray-900 truncate max-w-[200px]">{l.name}</div>
                                                    {canEdit && <button type="button" disabled={busyCell != null} onClick={() => setRow(l.id)}
                                                        className="text-[9px] font-black uppercase tracking-widest text-blue-600 hover:underline disabled:opacity-40">
                                                        {st === 'all' ? tx('meals.matrix.unmark.all', 'Desmarcar todas') : tx('meals.matrix.mark.all', 'Marcar todas')}
                                                    </button>}
                                                </th>
                                                {services.map((s) => {
                                                    const key = planKey(l.id, s.id);
                                                    const on = plan.has(key);
                                                    return (
                                                        <td key={s.id} className={`border-b border-l border-gray-100 text-center ${on ? 'bg-emerald-50/60' : ''}`}>
                                                            <label className={`flex items-center justify-center w-full h-full py-2.5 ${canEdit ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                                                                <input type="checkbox" className="w-5 h-5 accent-emerald-600 disabled:cursor-not-allowed" checked={on} disabled={busyCell != null || !canEdit}
                                                                    onChange={() => toggle(l.id, s.id)}
                                                                    aria-label={tx('meals.matrix.cell.aria', '{location}: {service}', { location: l.name, service: serviceName(tx, s, language) })} />
                                                            </label>
                                                        </td>
                                                    );
                                                })}
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                    {data.overrides_count > 0 && (
                        <p className="text-xs font-semibold text-gray-500"><i className="fa-solid fa-user-pen mr-1" aria-hidden="true"></i>{txn('meals.overrides.count', 'Hay {n} ajustes por persona (ver «Por persona»).', 'Hay {n} ajuste por persona (ver «Por persona»).', data.overrides_count)}</p>
                    )}
                </div>
            )}

            {creating && canEdit && <CreateServicesDialog conferenceId={conferenceId} conference={conference} locations={locations} onClose={() => { setCreating(false); reload(); }} onDone={() => { setCreating(false); reload(); }} />}
            {editing && canEdit && <EditServiceDialog service={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
        </div>
    );
}

function CreateServicesDialog({ conferenceId, conference, locations, onClose, onDone }: any) {
    const tx = useTx();
    const txn = makeTxn(tx);
    const { addToast } = useToast();
    const [from, setFrom] = useState(String(conference?.date_start || '').slice(0, 10));
    const [to, setTo] = useState(String(conference?.date_end || conference?.date_start || '').slice(0, 10));
    const [meals, setMeals] = useState<string[]>([...MEALS]);
    const [locs, setLocs] = useState<number[]>(() => locations.map((l) => Number(l.id)));
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const dates = dateRange(from, to);
    const tooMany = from && to && dateRange(from, to, 367).length > 366;
    const count = dates.length * meals.length;

    // A retry after a failure re-sends the SAME requests: what the failed attempt already created now counts
    // as «skipped», so after a retry only the total is reported (created + skipped = every combination).
    const attempts = useRef(0);
    const run = async () => {
        setBusy(true); setFailure(null);
        attempts.current++;
        let created = 0, skipped = 0;
        try {
            // ≤ 60 dates per request.
            for (const part of chunk(dates, 60)) {
                const r = await conferenceApi.bulkCreateMealServices(conferenceId, { dates: part, meals, location_ids: locs });
                created += r.created || 0; skipped += r.skipped || 0;
            }
            addToast(attempts.current > 1
                ? tx('meals.create.done.total', 'Listo: {n} servicios en el rango elegido', { n: created + skipped })
                : tx('meals.create.done', 'Servicios creados: {created} · ya existían: {skipped}', { created, skipped }), 'success');
            onDone();
        } catch (e: any) {
            setFailure(e?.message || 'Error');
        } finally { setBusy(false); }
    };
    const toggleIn = (list, set, v) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

    return (
        <Modal title={tx('meals.create', 'Crear servicios')} subtitle={tx('meals.create.subtitle', 'Se crean las combinaciones de fecha y comida que falten; las existentes no se tocan.')} onClose={onClose}
            footer={<>
                <button onClick={onClose} className="px-6 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">{tx('cancel', 'Cancelar')}</button>
                <button onClick={run} disabled={busy || !dates.length || !meals.length || tooMany} className={btnPrimary}>
                    {busy ? tx('loading', 'Cargando…') : failure ? tx('meals.retry', 'Reintentar') : txn('meals.create.n', 'Crear {n} servicios', 'Crear {n} servicio', count)}
                </button>
            </>}>
            <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5"><label htmlFor="ms-from" className={labelCls}>{tx('meals.create.from', 'Desde')}</label><input id="ms-from" type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} /></div>
                <div className="space-y-1.5"><label htmlFor="ms-to" className={labelCls}>{tx('meals.create.to', 'Hasta')}</label><input id="ms-to" type="date" className={inputCls} value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></div>
            </div>
            {from && to && !dates.length && <p className="text-xs font-bold text-rose-600">{tx('meals.create.bad.range', 'La fecha final debe ser igual o posterior a la inicial.')}</p>}
            {tooMany && <p className="text-xs font-bold text-rose-600">{tx('meals.create.too.many', 'Elige como máximo 366 días.')}</p>}
            <fieldset className="space-y-2">
                <legend className={labelCls}>{tx('meals.create.meals', 'Comidas')}</legend>
                <div className="grid grid-cols-3 gap-2">
                    {MEALS.map((m) => (
                        <label key={m} className={`flex items-center gap-2 px-3 py-3 rounded-xl border-2 cursor-pointer font-black text-sm ${meals.includes(m) ? 'border-orange-400 bg-orange-50 text-orange-800' : 'border-gray-100 text-gray-500'}`}>
                            <input type="checkbox" className="accent-orange-500" checked={meals.includes(m)} onChange={() => toggleIn(meals, setMeals, m)} />
                            <i className={`fa-solid ${MEAL_ICON[m]}`} aria-hidden="true"></i>{mealName(tx, m)}
                        </label>
                    ))}
                </div>
                <p className="text-[11px] text-gray-400">{tx('meals.create.windows', 'Horario por defecto: desayuno {d}, almuerzo {a}, cena {c}. Se puede cambiar en cada servicio.', { d: DEFAULT_WINDOWS.desayuno.join('–'), a: DEFAULT_WINDOWS.almuerzo.join('–'), c: DEFAULT_WINDOWS.cena.join('–') })}</p>
            </fieldset>
            {locations.length > 0 && (
                <fieldset className="space-y-2">
                    <legend className={labelCls}>{tx('meals.create.locations', 'Localidades que los reciben')}</legend>
                    <div className="flex gap-2 text-[10px] font-black uppercase tracking-widest">
                        <button type="button" className="text-blue-600 hover:underline" onClick={() => setLocs(locations.map((l) => Number(l.id)))}>{tx('meals.matrix.all', 'Todas')}</button>
                        <button type="button" className="text-blue-600 hover:underline" onClick={() => setLocs([])}>{tx('meals.matrix.none', 'Ninguna')}</button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                        {locations.map((l) => (
                            <label key={l.id} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-100 text-sm font-bold text-gray-700 cursor-pointer">
                                <input type="checkbox" className="accent-emerald-600" checked={locs.includes(Number(l.id))} onChange={() => toggleIn(locs, setLocs, Number(l.id))} />{l.name}
                            </label>
                        ))}
                    </div>
                    <p className="text-[11px] text-gray-400">{tx('meals.create.locations.hint', 'Solo se aplica a los servicios nuevos; los que ya existían conservan su plan.')}</p>
                </fieldset>
            )}
            {failure && (
                <div className="rounded-2xl border-2 border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700" role="alert">
                    {failure}
                    <div className="text-xs font-semibold mt-1">{tx('meals.create.retry.hint', 'Puedes reintentar: los servicios ya creados se omiten.')}</div>
                </div>
            )}
        </Modal>
    );
}

function EditServiceDialog({ service, onClose, onDone }: any) {
    const tx = useTx();
    const { language } = useI18n();
    const { addToast } = useToast();
    const [def0, def1] = serviceWindow({ meal: service.meal, start_time: null, end_time: null });
    const [form, setForm] = useState({ label: service.label || '', start_time: service.start_time || '', end_time: service.end_time || '', notes: service.notes || '' });
    const [busy, setBusy] = useState(false);
    const save = async () => {
        setBusy(true);
        try {
            await conferenceApi.updateMealService(service.id, { label: form.label.trim() || null, start_time: form.start_time || null, end_time: form.end_time || null, notes: form.notes.trim() || null });
            addToast(tx('meals.saved', 'Servicio actualizado'), 'success');
            onDone();
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setBusy(false); }
    };
    return (
        <Modal title={tx('meals.edit', 'Editar servicio')} subtitle={`${dayLabel(service.service_date, language, true)} · ${mealName(tx, service.meal)}`} onClose={onClose}
            footer={<>
                <button onClick={onClose} className="px-6 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">{tx('cancel', 'Cancelar')}</button>
                <button onClick={save} disabled={busy} className={btnPrimary}>{tx('save', 'Guardar')}</button>
            </>}>
            <div className="space-y-1.5"><label htmlFor="ms-label" className={labelCls}>{tx('meals.label', 'Nombre (opcional)')}</label>
                <input id="ms-label" className={inputCls} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder={tx('meals.label.placeholder', 'Ej.: Almuerzo campestre')} /></div>
            <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5"><label htmlFor="ms-start" className={labelCls}>{tx('meals.start', 'Desde')}</label><input id="ms-start" type="time" className={inputCls} value={form.start_time} placeholder={def0} onChange={(e) => setForm({ ...form, start_time: e.target.value })} /></div>
                <div className="space-y-1.5"><label htmlFor="ms-end" className={labelCls}>{tx('meals.end', 'Hasta')}</label><input id="ms-end" type="time" className={inputCls} value={form.end_time} placeholder={def1} onChange={(e) => setForm({ ...form, end_time: e.target.value })} /></div>
            </div>
            <p className="text-[11px] text-gray-400">{tx('meals.window.hint', 'Vacío = horario por defecto ({from}–{to}). Solo sirve para preseleccionar el servicio en «Entrega».', { from: def0, to: def1 })}</p>
            <div className="space-y-1.5"><label htmlFor="ms-notes" className={labelCls}>{tx('meals.notes', 'Notas')}</label>
                <textarea id="ms-notes" rows={3} className={inputCls} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
        </Modal>
    );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. POR PERSONA
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
const SOURCE_CHIP = {
    location: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    include: 'bg-blue-50 text-blue-700 border-blue-200',
    exclude: 'bg-rose-50 text-rose-700 border-rose-200',
    none: 'bg-gray-50 text-gray-500 border-gray-200',
};
const sourceLabel = (tx, s) =>
    s === 'location' ? tx('meals.source.location', 'Por localidad') : s === 'include' ? tx('meals.source.include', 'Añadido') : s === 'exclude' ? tx('meals.source.exclude', 'Quitado') : tx('meals.source.none', 'Sin derecho');
const methodLabel = (tx, m) =>
    m === 'scan' ? tx('meals.method.scan', 'Escaneo') : m === 'manual' ? tx('meals.method.manual', 'Manual') : m === 'override' ? tx('meals.method.override', 'Sin derecho (autorizado)') : (m || '');

function PeopleTab({ conferenceId, data, services, reload }: any) {
    const tx = useTx();
    const txn = makeTxn(tx);
    const [q, setQ] = useState('');
    const [loc, setLoc] = useState<string>('');
    const [res, setRes] = useState<{ people: any[]; total: number; services_count: number } | null>(null);
    const [loading, setLoading] = useState(false);
    const [open, setOpen] = useState<number | null>(null);
    const [loadErr, setLoadErr] = useState('');
    const reqRef = useRef(0);
    /** Something was changed in the person dialog: refresh the rows on close (keeping the loaded pages). */
    const dirty = useRef(false);
    const params = () => ({ q: q.trim(), location_id: loc === '' ? '' : loc === 'none' ? 'none' : Number(loc) });

    // A failure is reported as such — never as «nobody matches» — and a failed «Cargar más» keeps the
    // pages already loaded.
    const load = useCallback(async (offset = 0) => {
        const my = ++reqRef.current;
        setLoading(true);
        try {
            const r = await conferenceApi.getMealPeople(conferenceId, { ...params(), limit: 50, offset });
            if (my !== reqRef.current) return;
            setLoadErr('');
            setRes((prev) => (offset && prev ? { ...r, people: [...prev.people, ...(r.people || [])] } : r));
        } catch (e: any) {
            if (my !== reqRef.current) return;
            setLoadErr(isOffline(e) ? tx('meals.search.offline', 'Sin conexión — vuelve a intentarlo') : (e?.message || 'Error'));
            if (!offset) setRes(null);
        }
        finally { if (my === reqRef.current) setLoading(false); }
    }, [conferenceId, q, loc]);
    useEffect(() => { const h = setTimeout(() => load(0), 250); return () => clearTimeout(h); }, [load]);
    // Re-read the rows already on screen (in pages of 100, the server maximum) so the counters of the
    // edited person update without losing the place reached with «Cargar más».
    const reloadWindow = async () => {
        const n = Math.max(50, res?.people.length || 0);
        const my = ++reqRef.current;
        try {
            let people: any[] = [], last: any = null;
            for (let offset = 0; offset < n; offset += 100) {
                last = await conferenceApi.getMealPeople(conferenceId, { ...params(), limit: Math.min(100, n - offset), offset });
                people = people.concat(last.people || []);
                if ((last.people || []).length === 0) break;
            }
            if (my === reqRef.current && last) { setRes({ ...last, people }); setLoadErr(''); }
        } catch { /* keep what is shown */ }
    };

    return (
        <div className={`${card} p-5 sm:p-6 space-y-4`}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2 space-y-1"><label htmlFor="mp-q" className={labelCls}>{tx('meals.search.label', 'Buscar participante')}</label>
                    <input id="mp-q" type="search" className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx('meals.search.placeholder', 'Nombre, documento o código…')} /></div>
                <div className="space-y-1"><label htmlFor="mp-loc" className={labelCls}>{tx('meals.location', 'Localidad')}</label>
                    <select id="mp-loc" className={inputCls} value={loc} onChange={(e) => setLoc(e.target.value)}>
                        <option value="">{tx('meals.location.all', 'Todas')}</option>
                        {(data.locations || []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                        <option value="none">{tx('meals.no.location', 'Sin localidad')}</option>
                    </select></div>
            </div>
            {!res && loading && <Spinner label={tx('loading', 'Cargando…')} />}
            {loadErr && (
                <div role="alert" className="rounded-2xl border-2 border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700 flex flex-wrap items-center gap-3">
                    <span className="flex-1">{loadErr}</span>
                    <button type="button" className={btnGhost} disabled={loading} onClick={() => load(res?.people.length || 0)}>{tx('meals.retry', 'Reintentar')}</button>
                </div>
            )}
            {res && (
                <>
                    <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{txn('meals.people.total', '{n} participantes', '{n} participante', res.total)}</div>
                    {res.people.length === 0 ? <p className="text-sm font-bold text-gray-500 py-6 text-center">{tx('meals.search.none', 'Nadie coincide con la búsqueda.')}</p> : (
                        <ul className="divide-y divide-gray-50 border border-gray-100 rounded-2xl overflow-hidden">
                            {res.people.map((p) => (
                                <li key={p.id}>
                                    <button type="button" onClick={() => setOpen(p.id)} className="w-full text-left px-4 py-3 hover:bg-gray-50 flex flex-wrap items-center gap-3">
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-sm font-black text-gray-900 break-words">{p.name}</span>
                                            <span className="block text-xs font-semibold text-gray-500">{[p.location_id == null ? tx('meals.no.location', 'Sin localidad') : p.location, p.family_group ? tx('meals.family', 'Grupo familiar: {name}', { name: p.family_group }) : '', p.reg_code].filter(Boolean).join(' · ')}</span>
                                        </span>
                                        <span className="flex flex-wrap items-center gap-1.5 text-[10px] font-black uppercase tracking-widest">
                                            <span className="px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700">{tx('meals.people.entitled', '{n} de {total} comidas', { n: p.entitled, total: res.services_count })}</span>
                                            <span className="px-2 py-1 rounded-lg bg-gray-100 text-gray-600">{txn('meals.people.delivered', '{n} entregadas', '{n} entregada', p.delivered)}</span>
                                            {p.includes > 0 && <span className="px-2 py-1 rounded-lg bg-blue-50 text-blue-700">+{p.includes}</span>}
                                            {p.excludes > 0 && <span className="px-2 py-1 rounded-lg bg-rose-50 text-rose-700">−{p.excludes}</span>}
                                        </span>
                                        <i className="fa-solid fa-chevron-right text-gray-300" aria-hidden="true"></i>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {res.people.length < res.total && (
                        <div className="text-center"><button type="button" className={btnGhost} disabled={loading} onClick={() => load(res.people.length)}>{tx('meals.more', 'Cargar más')}</button></div>
                    )}
                </>
            )}
            {open != null && <PersonMealsDialog inscriptionId={open}
                onClose={() => { setOpen(null); if (dirty.current) { dirty.current = false; reloadWindow(); } }}
                onChanged={() => { dirty.current = true; reload(); }} />}
        </div>
    );
}

function PersonMealsDialog({ inscriptionId, onClose, onChanged }: any) {
    const tx = useTx();
    const { language } = useI18n();
    const { addToast } = useToast();
    const perms = usePerms();
    const canAdjust = perms.can('meals', 'manage');
    const canDeliver = perms.can('meals_delivery', 'manage');
    const deliver = useMealDelivery();
    const [d, setD] = useState<any>(null);
    const [busy, setBusy] = useState<string | null>(null);
    /** The service whose «Deshacer» is asking for confirmation — inline, inside this dialog. */
    const [undoAsk, setUndoAsk] = useState<number | null>(null);
    const load = useCallback(async () => {
        try { setD(await conferenceApi.getMealPerson(inscriptionId)); }
        catch (e: any) { addToast(e?.message || 'Error', 'error'); onClose(); }
    }, [inscriptionId]);
    useEffect(() => { load(); }, [load]);

    const setMode = async (s: any, mode: 'inherit' | 'include' | 'exclude') => {
        setBusy(`mode:${s.id}`);
        try { await conferenceApi.setMealOverride(inscriptionId, { service_id: s.id, mode }); await load(); onChanged?.(); }
        catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setBusy(null); }
    };
    const undo = async (s: any) => {
        setUndoAsk(null);
        setBusy(`undo:${s.id}`);
        try { await conferenceApi.undoMealDelivery(s.delivery_id); await load(); onChanged?.(); }
        catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setBusy(null); }
    };
    const markDelivered = async (s: any) => {
        setBusy(`deliver:${s.id}`);
        try {
            const o = await deliver({ service_id: s.id, inscription_id: inscriptionId, force: !s.entitled, note: !s.entitled ? tx('meals.force.note.admin', 'Autorizado desde «Por persona»') : undefined });
            if (o.result === 'delivered') addToast(tx('meals.verdict.delivered', 'Entregado'), 'success');
            else if (o.result === 'already') addToast(tx('meals.verdict.already', 'Ya recibió'), 'error');
            else addToast(o.message || tx('meals.verdict.error', 'No se pudo registrar'), 'error');
            await load(); onChanged?.();
        } finally { setBusy(null); }
    };

    if (!d) return <Modal title={tx('loading', 'Cargando…')} onClose={onClose}><Spinner label={tx('loading', 'Cargando…')} /></Modal>;
    const p = d.person;
    const days = groupByDay(d.services);
    return (
        <Modal wide title={p.name} subtitle={[p.location_id == null ? tx('meals.no.location', 'Sin localidad') : p.location, p.family_group ? tx('meals.family', 'Grupo familiar: {name}', { name: p.family_group }) : '', p.reg_code].filter(Boolean).join(' · ')} onClose={onClose}>
            {p.status === 'cancelled' && <div className="rounded-2xl bg-rose-50 border-2 border-rose-200 px-4 py-3 text-sm font-bold text-rose-700">{tx('meals.verdict.cancelled', 'Inscripción cancelada')}</div>}
            {!d.services.length && <p className="text-sm font-bold text-gray-500">{tx('meals.services.none', 'Todavía no hay servicios de comida.')}</p>}
            <p className="text-xs text-gray-500">{tx('meals.person.hint', '«Heredar» sigue el plan de su localidad; «Incluir» y «Excluir» lo cambian solo para esta persona.')}</p>
            {!canAdjust && <p className="text-xs font-bold text-sky-700"><i className="fa-solid fa-eye mr-1" aria-hidden="true"></i>{tx('perm.meals.person.readonly', 'Tu rol puede ver estos ajustes, pero no cambiarlos.')}</p>}
            {days.map((day) => (
                <div key={day.date} className="space-y-2">
                    <div className="text-[10px] font-black uppercase tracking-widest text-gray-500">{dayLabel(day.date, language, true)}</div>
                    {day.services.map((s) => {
                        const mode = s.override || 'inherit';
                        return (
                            <div key={s.id} className="rounded-2xl border border-gray-100 px-4 py-3 flex flex-wrap items-center gap-3" data-person-service={s.id}>
                                <div className="min-w-[140px] flex-1">
                                    <div className="text-sm font-black text-gray-900"><i className={`fa-solid ${MEAL_ICON[s.meal] || 'fa-utensils'} mr-1.5 text-orange-500`} aria-hidden="true"></i>{mealName(tx, s.meal)}{s.label ? ` — ${s.label}` : ''}</div>
                                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                                        <span className={`px-2 py-0.5 rounded-lg border text-[10px] font-black uppercase tracking-widest ${SOURCE_CHIP[s.source] || SOURCE_CHIP.none}`}>{sourceLabel(tx, s.source)}</span>
                                        {s.delivered_at
                                            ? <span className="text-[11px] font-bold text-emerald-700"><i className="fa-solid fa-circle-check mr-1" aria-hidden="true"></i>{tx('meals.delivered.at', 'Entregado {when}', { when: stampDayTime(s.delivered_at) })}{s.delivered_by ? ` · ${s.delivered_by}` : ''}{s.method ? ` · ${methodLabel(tx, s.method)}` : ''}</span>
                                            : s.entitled ? <span className="text-[11px] font-bold text-gray-500">{tx('meals.pending', 'Pendiente')}</span> : null}
                                    </div>
                                </div>
                                <div className="inline-flex rounded-xl border-2 border-gray-100 overflow-hidden" role="group" aria-label={tx('meals.person.mode', 'Ajuste para {service}', { service: serviceName(tx, s, language) })}>
                                    {([['inherit', tx('meals.mode.inherit', 'Heredar')], ['include', tx('meals.mode.include', 'Incluir')], ['exclude', tx('meals.mode.exclude', 'Excluir')]] as const).map(([m, label]) => (
                                        <button key={m} type="button" disabled={busy != null || !canAdjust} aria-pressed={mode === m} onClick={() => canAdjust && mode !== m && setMode(s, m)}
                                            className={`px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-60 disabled:cursor-not-allowed ${mode === m ? (m === 'include' ? 'bg-blue-600 text-white' : m === 'exclude' ? 'bg-rose-600 text-white' : 'bg-gray-800 text-white') : 'bg-white text-gray-500 hover:bg-gray-50'}`}>{label}</button>
                                    ))}
                                </div>
                                {!canDeliver ? null : s.delivered_at
                                    ? (undoAsk === s.id
                                        ? <span className="inline-flex flex-wrap items-center gap-2" role="alertdialog" aria-label={tx('meals.undo.confirm', '¿Deshacer la entrega de {service}?', { service: serviceName(tx, s, language) })}>
                                            <span className="text-xs font-bold text-gray-700">{tx('meals.undo.confirm', '¿Deshacer la entrega de {service}?', { service: serviceName(tx, s, language) })}</span>
                                            <button type="button" disabled={busy != null} onClick={() => undo(s)} className="px-4 py-2.5 rounded-xl bg-rose-600 text-white font-black text-[10px] uppercase tracking-widest disabled:opacity-50" autoFocus>{tx('meals.undo', 'Deshacer')}</button>
                                            <button type="button" onClick={() => setUndoAsk(null)} className={btnGhost}>{tx('cancel', 'Cancelar')}</button>
                                        </span>
                                        : <button type="button" disabled={busy != null} onClick={() => setUndoAsk(s.id)} className={btnGhost}><i className="fa-solid fa-rotate-left mr-1" aria-hidden="true"></i>{tx('meals.undo', 'Deshacer')}</button>)
                                    : p.status !== 'cancelled' && <button type="button" disabled={busy != null} onClick={() => markDelivered(s)} className={btnGhost} title={!s.entitled ? tx('meals.force', 'Entregar de todas formas') : undefined}>
                                        <i className="fa-solid fa-check mr-1" aria-hidden="true"></i>{s.entitled ? tx('meals.mark.delivered', 'Marcar entregado') : tx('meals.force', 'Entregar de todas formas')}</button>}
                            </div>
                        );
                    })}
                </div>
            ))}
        </Modal>
    );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// 3. ENTREGA (kitchen screen; USB / Bluetooth scanners type the code + Enter)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
function DeliveryTab({ conferenceId, services, locations, serviceId, setServiceId, reload, paused, onScanner }: any) {
    const tx = useTx();
    const canPlanEdit = usePerms().can('meals', 'manage');
    const txn = makeTxn(tx);
    const { language } = useI18n();
    const { addToast } = useToast();
    const deliver = useMealDelivery();
    const service = services.find((s) => s.id === serviceId) || null;
    const locationName = useMemo(() => new Map((locations || []).map((l) => [Number(l.id), l.name])), [locations]);
    const [code, setCode] = useState('');
    const [outcome, setOutcome] = useState<any>(null);
    const [busy, setBusy] = useState(false);
    const [stats, setStats] = useState<any>(null);
    const [recent, setRecent] = useState<any[]>([]);
    const [searching, setSearching] = useState(false);
    /** The «Últimas entregas» row whose undo is asking for confirmation (inline: no dialog takes the focus). */
    const [undoAsk, setUndoAsk] = useState<number | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const feedback = useRef(createFeedback());
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; feedback.current.close(); }; }, []);
    // Late responses and queued scans read the CURRENT selection / search state through refs.
    const sidRef = useRef(serviceId);
    sidRef.current = serviceId;
    const searchingRef = useRef(searching);
    searchingRef.current = searching;
    const pausedRef = useRef(paused);
    pausedRef.current = paused;

    const refresh = useCallback(async () => {
        const sid = serviceId;
        if (!sid) { setStats(null); setRecent([]); return; }
        try {
            const [s, r] = await Promise.all([conferenceApi.getMealServiceStats(sid), conferenceApi.getMealServiceDeliveries(sid, 20)]);
            if (!alive.current || sid !== sidRef.current) return;   // another service is selected now
            setStats(s); setRecent(r.deliveries || []);
        } catch { /* keep the last numbers */ }
    }, [serviceId]);
    const refreshRef = useRef(refresh);
    refreshRef.current = refresh;
    // A new service: fresh numbers. The «Servicio no encontrado» card stays while nothing is selected.
    useEffect(() => {
        setOutcome((o) => (!serviceId && o?.result === 'no_service' ? o : null));
        setStats(null); setRecent([]); setUndoAsk(null);
        refresh();
        const h = setInterval(refresh, 15000);
        return () => clearInterval(h);
    }, [refresh]);

    // The scan input keeps the focus (a USB / Bluetooth scanner types into whatever is focused) — except
    // while the name search is open or the phone scanner covers this screen.
    const focusInput = () => { if (!searchingRef.current && !pausedRef.current && alive.current) inputRef.current?.focus(); };
    useEffect(() => { focusInput(); }, [serviceId, searching, paused]);

    // The page header's totals: one GET /meals a moment after a burst of scans, not one per scan.
    const reloadTimer = useRef<any>(null);
    const scheduleReload = () => { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(() => reload(), 2000); };
    useEffect(() => () => clearTimeout(reloadTimer.current), []);
    // Scans are posted one after another, in order: a USB scanner can send the next code while the
    // previous request is still running, and no code may be dropped.
    const queue = useRef<Promise<void>>(Promise.resolve());
    const pending = useRef(0);
    const run = (body: any) => {
        if (!serviceId) return;
        const sid = serviceId;
        pending.current++; setBusy(true);
        queue.current = queue.current.then(async () => {
            try {
                const o = await deliver({ service_id: sid, ...body });
                if (!alive.current) return;
                if (o.result === 'delivered') feedback.current.ok(); else feedback.current.bad();
                // The service changed while this scan was queued: its verdict would read as the new one's.
                if (sid !== sidRef.current) { if (o.result === 'delivered') scheduleReload(); return; }
                setOutcome(o);
                if (o.result === 'no_service') { await reload(); return; }   // the parent then asks for a service
                if (o.result === 'delivered') scheduleReload();
                refreshRef.current();
            } finally {
                if (--pending.current === 0 && alive.current) { setBusy(false); setTimeout(focusInput, 0); }
            }
        });
    };
    const submit = (e?: any) => {
        e?.preventDefault?.();
        const raw = code;
        setCode('');
        if (!normalizeCode(raw)) return;      // Enter on an empty / garbage input is ignored
        run({ code: raw });
    };
    // Called by the VerdictCard after its inline confirmation.
    const force = (o: any) => {
        const p = o.verdict?.person;
        if (!p) return;
        run({ inscription_id: p.id, force: true, note: tx('meals.force.note.kitchen', 'Autorizado en la entrega') });
    };
    const undo = async (deliveryId: number) => {
        setUndoAsk(null);
        setBusy(true);
        try {
            await conferenceApi.undoMealDelivery(deliveryId);
            if (!alive.current) return;
            addToast(tx('meals.undone', 'Entrega deshecha'), 'success');
            setOutcome((o) => (o?.verdict?.delivery_id === deliveryId ? null : o));
            refreshRef.current(); reload();
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { if (alive.current) { setBusy(false); setTimeout(focusInput, 0); } }
    };
    /** Buttons here must not take the focus from the scan input (the scanner's Enter would press them). */
    const keepFocus = (e: any) => e.preventDefault();

    if (!services.length) return <div className={`${card} p-8 text-center text-sm font-bold text-gray-500`}>{canPlanEdit ? tx('meals.delivery.no.services', 'Crea los servicios en «Plan» para empezar a registrar entregas.') : tx('meals.delivery.no.services.ask', 'Todavía no hay servicios de comida. Pide a quien gestiona Alimentación que los cree.')}</div>;

    return (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6" onClick={(e) => { const tag = (e.target as HTMLElement).closest('button,input,select,textarea,a,label'); if (!tag) focusInput(); }}>
            <div className="xl:col-span-2 space-y-5">
                <div className={`${card} p-5 sm:p-6 space-y-4`}>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                        <div className="md:col-span-2 space-y-1"><label htmlFor="md-service" className={labelCls}>{tx('meals.scanner.service', 'Servicio')}</label>
                            <ServiceSelect id="md-service" services={services} serviceId={serviceId} setServiceId={setServiceId} /></div>
                        <button type="button" onClick={onScanner} className="px-4 py-3 rounded-xl bg-gray-900 text-white font-black text-[10px] uppercase tracking-widest"><i className="fa-solid fa-camera mr-1.5" aria-hidden="true"></i>{tx('meals.scanner.camera', 'Usar la cámara')}</button>
                    </div>
                    <form onSubmit={submit} className="space-y-2">
                        <label htmlFor="md-code" className={labelCls}>{tx('meals.delivery.scan', 'Escanea el código (o escríbelo y pulsa Enter)')}</label>
                        <input id="md-code" ref={inputRef} value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" spellCheck={false} autoCapitalize="characters"
                            className="w-full border-4 border-orange-200 focus:border-orange-500 rounded-3xl px-6 py-5 text-3xl font-mono font-black tracking-[0.2em] text-gray-900 outline-none bg-orange-50/30"
                            placeholder="▌▌▌ ▌▌ ▌▌▌" disabled={!serviceId} data-scan-input="" />
                    </form>
                    <div className="min-h-[96px]">
                        {outcome
                            ? <VerdictCard outcome={outcome} service={service} busy={busy} language={language}
                                onForce={outcome.result === 'not_entitled' ? force : undefined} onUndo={undo} onDismiss={() => { setOutcome(null); focusInput(); }} />
                            : <div className="h-full rounded-3xl border-2 border-dashed border-gray-100 flex items-center justify-center text-sm font-bold text-gray-400 py-8"><i className="fa-solid fa-barcode mr-2" aria-hidden="true"></i>{tx('meals.delivery.waiting', 'Esperando un código…')}</div>}
                    </div>
                    <div>
                        {!searching
                            ? <button type="button" className={btnGhost} onClick={() => setSearching(true)}><i className="fa-solid fa-magnifying-glass mr-1.5" aria-hidden="true"></i>{tx('meals.scanner.search', 'Buscar por nombre')}</button>
                            : <div className="rounded-2xl border border-gray-100 p-4 space-y-3">
                                <div className="flex items-center justify-between"><span className={labelCls}>{tx('meals.scanner.search', 'Buscar por nombre')}</span>
                                    <button type="button" className="text-gray-400 hover:text-gray-600 p-1" onClick={() => setSearching(false)} aria-label={tx('close', 'Cerrar')}><i className="fa-solid fa-xmark" aria-hidden="true"></i></button></div>
                                <PersonSearch conferenceId={conferenceId} busy={busy} onPick={(p) => { setSearching(false); run({ inscription_id: p.id }); }} />
                            </div>}
                    </div>
                </div>
            </div>

            <div className="space-y-5">
                <div className={`${card} p-5 space-y-3`}>
                    <div className="grid grid-cols-3 gap-2">
                        <Counter label={tx('meals.count.delivered', 'Entregados')} value={stats?.delivered ?? '—'} tone="text-emerald-600" />
                        <Counter label={tx('meals.count.entitled', 'Con derecho')} value={stats?.entitled ?? '—'} />
                        <Counter label={tx('meals.count.pending', 'Pendientes')} value={stats?.pending ?? '—'} tone="text-orange-600" />
                    </div>
                    {stats?.overrides_delivered > 0 && <p className="text-[11px] font-bold text-amber-700">{txn('meals.count.overrides', '{n} entregadas sin derecho (autorizadas)', '{n} entregada sin derecho (autorizada)', stats.overrides_delivered)}</p>}
                    {(stats?.by_location || []).length > 0 && (
                        <ul className="divide-y divide-gray-50 text-sm">
                            {stats.by_location.map((b) => (
                                <li key={String(b.location_id)} className="flex items-center justify-between py-1.5 gap-2">
                                    <span className="font-bold text-gray-700 truncate">{b.location_id == null ? tx('meals.no.location', 'Sin localidad') : (b.location || locationName.get(Number(b.location_id)) || '')}</span>
                                    <span className="text-xs font-black tabular-nums whitespace-nowrap flex items-center gap-3">
                                        <span className="text-emerald-700" title={tx('meals.count.delivered', 'Entregados')}><i className="fa-solid fa-circle-check mr-1" aria-hidden="true"></i>{b.delivered}<span className="sr-only"> {tx('meals.count.delivered', 'Entregados')}</span></span>
                                        <span className="text-orange-600" title={tx('meals.count.pending', 'Pendientes')}><i className="fa-solid fa-hourglass-half mr-1" aria-hidden="true"></i>{b.pending ?? Math.max(0, b.entitled - b.delivered)}<span className="sr-only"> {tx('meals.count.pending', 'Pendientes')}</span></span>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                <div className={`${card} p-5 space-y-2`}>
                    <h4 className={labelCls}>{tx('meals.recent', 'Últimas entregas')}</h4>
                    {!recent.length && <p className="text-xs font-semibold text-gray-400">{tx('meals.recent.none', 'Aún no hay entregas en este servicio.')}</p>}
                    <ul className="divide-y divide-gray-50">
                        {recent.map((r) => (
                            <li key={r.delivery_id} className="py-2">
                                <div className="flex items-center gap-2">
                                    <span className="text-[11px] font-black text-gray-400 tabular-nums w-11">{stampTime(r.delivered_at)}</span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm font-bold text-gray-900 truncate">{r.name}</span>
                                        <span className="block text-[11px] text-gray-500 truncate">{[r.location_id == null ? tx('meals.no.location', 'Sin localidad') : r.location, methodLabel(tx, r.method), r.delivered_by].filter(Boolean).join(' · ')}</span>
                                    </span>
                                    {undoAsk !== r.delivery_id && (
                                        <button type="button" disabled={busy} onMouseDown={keepFocus} onClick={() => setUndoAsk(r.delivery_id)}
                                            className="p-2 text-gray-400 hover:text-rose-600 disabled:opacity-40" aria-label={tx('meals.undo.person', 'Deshacer la entrega a {name}', { name: r.name })}><i className="fa-solid fa-rotate-left" aria-hidden="true"></i></button>
                                    )}
                                </div>
                                {undoAsk === r.delivery_id && (
                                    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-rose-50 px-3 py-2" role="alertdialog" aria-label={tx('meals.undo.confirm.person', '¿Deshacer la entrega a {name}?', { name: r.name })}>
                                        <span className="text-xs font-bold text-rose-800 flex-1">{tx('meals.undo.confirm.person', '¿Deshacer la entrega a {name}?', { name: r.name })}</span>
                                        <button type="button" disabled={busy} onMouseDown={keepFocus} onClick={() => undo(r.delivery_id)} className="px-3 py-1.5 rounded-lg bg-rose-600 text-white font-black text-[10px] uppercase tracking-widest disabled:opacity-50">{tx('meals.undo', 'Deshacer')}</button>
                                        <button type="button" onMouseDown={keepFocus} onClick={() => setUndoAsk(null)} className="px-3 py-1.5 rounded-lg bg-white text-gray-600 font-black text-[10px] uppercase tracking-widest">{tx('cancel', 'Cancelar')}</button>
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </div>
    );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// 4. REPORTE
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
function ReportTab({ services, serviceId, setServiceId, slug }: any) {
    const tx = useTx();
    const txn = makeTxn(tx);
    const { language } = useI18n();
    const { addToast } = useToast();
    // The Excel export is a «Reportes» permission, like every other Excel of the plugin.
    const canExcel = usePerms().can('reports');
    const canCodes = usePerms().can('inscriptions');
    const [report, setReport] = useState<any>(null);
    const [loading, setLoading] = useState(false);
    const [filter, setFilter] = useState<'all' | 'pending' | 'delivered' | 'override'>('all');
    const [q, setQ] = useState('');
    useEffect(() => {
        if (!serviceId) { setReport(null); return; }
        let alive = true;
        // Never show (or export) the previous service's report under the new selector while this one loads.
        setLoading(true); setReport(null);
        conferenceApi.getMealServiceReport(serviceId)
            .then((r) => { if (alive) setReport(r); })
            .catch((e) => { if (alive) { setReport(null); addToast(e?.message || 'Error', 'error'); } })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [serviceId]);
    const rows = useMemo(() => filterReportRows(report?.rows, filter, q), [report, filter, q]);
    const excel = () => {
        try {
            const labels = {
                meal: (m) => mealName(tx, m), source: (s) => sourceLabel(tx, s), method: (m) => methodLabel(tx, m),
                noLocation: tx('meals.no.location', 'Sin localidad'), yes: tx('meals.yes', 'Sí'), no: tx('meals.no', 'No'),
            };
            const s = report.service;
            const built = buildMealReportWorkbook(report, { filter, q, labels });
            downloadXlsx(buildXlsx(canCodes ? built : withoutColumn(built, 'Código')), exportFilename(`alimentacion-${s.service_date}-${s.meal}`, slug));
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
    };

    if (!services.length) return <div className={`${card} p-8 text-center text-sm font-bold text-gray-500`}>{tx('meals.services.none', 'Todavía no hay servicios de comida.')}</div>;
    const t = report?.totals;
    return (
        <div className="space-y-5">
            <div className={`${card} p-5 sm:p-6 grid grid-cols-1 md:grid-cols-4 gap-3 items-end`}>
                <div className={`${canExcel ? 'md:col-span-3' : 'md:col-span-4'} space-y-1`}><label htmlFor="mr-service" className={labelCls}>{tx('meals.scanner.service', 'Servicio')}</label>
                    <ServiceSelect id="mr-service" services={services} serviceId={serviceId} setServiceId={setServiceId} /></div>
                {canExcel && <button type="button" onClick={excel} disabled={!report || !rows.length} className="px-4 py-3 rounded-xl bg-white border-2 border-gray-100 text-emerald-700 hover:border-emerald-500 font-black text-[10px] uppercase tracking-widest disabled:opacity-50"><i className="fa-solid fa-file-excel mr-1.5" aria-hidden="true"></i>{tx('meals.excel', 'Excel')}</button>}
            </div>
            {loading && !report && <Spinner label={tx('loading', 'Cargando…')} />}
            {report && (
                <>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <Counter label={tx('meals.count.entitled', 'Con derecho')} value={t.entitled} />
                        <Counter label={tx('meals.count.delivered', 'Entregados')} value={t.delivered} tone="text-emerald-600" />
                        <Counter label={tx('meals.count.pending', 'Pendientes')} value={t.pending} tone="text-orange-600" />
                        <Counter label={tx('meals.count.overrides.short', 'Sin derecho (autorizados)')} value={t.overrides_delivered} tone="text-amber-600" />
                    </div>
                    <div className={`${card} overflow-hidden`}>
                        <table className="w-full text-sm">
                            <thead className="bg-gray-50 text-[10px] font-black uppercase tracking-widest text-gray-500">
                                <tr><th className="text-left px-4 py-2">{tx('meals.location', 'Localidad')}</th><th className="text-right px-4 py-2">{tx('meals.count.entitled', 'Con derecho')}</th><th className="text-right px-4 py-2">{tx('meals.count.delivered', 'Entregados')}</th><th className="text-right px-4 py-2">{tx('meals.count.pending', 'Pendientes')}</th></tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {report.by_location.map((b) => (
                                    <tr key={String(b.location_id)}>
                                        <td className="px-4 py-2 font-bold text-gray-800">{b.location_id == null ? tx('meals.no.location', 'Sin localidad') : b.location}</td>
                                        <td className="px-4 py-2 text-right tabular-nums">{b.entitled}</td>
                                        <td className="px-4 py-2 text-right tabular-nums text-emerald-700 font-bold">{b.delivered}</td>
                                        <td className="px-4 py-2 text-right tabular-nums text-orange-700 font-bold">{b.pending ?? Math.max(0, b.entitled - b.delivered)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className={`${card} p-5 space-y-3`}>
                        <div className="flex flex-wrap gap-2 items-center">
                            {([['all', tx('meals.filter.all', 'Todos')], ['pending', tx('meals.filter.pending', 'Pendientes')], ['delivered', tx('meals.filter.delivered', 'Entregados')], ['override', tx('meals.filter.override', 'Sin derecho')]] as const).map(([k, label]) => (
                                <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}
                                    className={`px-3 py-2 rounded-xl border-2 text-[10px] font-black uppercase tracking-widest ${filter === k ? 'border-orange-400 bg-orange-50 text-orange-700' : 'border-gray-100 text-gray-500'}`}>{label}</button>
                            ))}
                            <input type="search" className={`${inputCls} md:max-w-xs ml-auto`} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx('meals.search.placeholder', 'Nombre, documento o código…')} aria-label={tx('meals.search.label', 'Buscar participante')} />
                        </div>
                        <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{txn('meals.people.total', '{n} participantes', '{n} participante', rows.length)}</div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm min-w-[720px]">
                                <thead className="text-[10px] font-black uppercase tracking-widest text-gray-500 border-b border-gray-100">
                                    <tr>
                                        <th className="text-left py-2 pr-3">{tx('meals.code', 'Código')}</th><th className="text-left py-2 pr-3">{tx('meals.name', 'Nombre')}</th><th className="text-left py-2 pr-3">{tx('meals.location', 'Localidad')}</th>
                                        <th className="text-left py-2 pr-3">{tx('meals.entitlement', 'Derecho')}</th><th className="text-left py-2 pr-3">{tx('meals.delivered.col', 'Entregado')}</th><th className="text-left py-2">{tx('meals.by', 'Por')}</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-50">
                                    {rows.map((r) => (
                                        <tr key={r.inscription_id}>
                                            <td className="py-2 pr-3 font-mono text-xs text-gray-600">{r.reg_code || '—'}</td>
                                            <td className="py-2 pr-3 font-bold text-gray-900">{r.name}{r.family_group ? <span className="block text-[11px] font-semibold text-gray-400">{r.family_group}</span> : null}</td>
                                            <td className="py-2 pr-3 text-gray-700">{r.location_id == null ? tx('meals.no.location', 'Sin localidad') : r.location}</td>
                                            <td className="py-2 pr-3">{(() => {
                                                // Someone served and NOT entitled now (e.g. cancelled afterwards) must not read as «Por localidad».
                                                const chip = r.entitled ? r.source : (r.source === 'exclude' ? 'exclude' : 'none');
                                                return <>
                                                    <span className={`px-2 py-0.5 rounded-lg border text-[10px] font-black uppercase tracking-widest ${SOURCE_CHIP[chip] || SOURCE_CHIP.none}`}>{sourceLabel(tx, chip)}</span>
                                                    {r.status === 'cancelled' && <span className="ml-1 px-2 py-0.5 rounded-lg bg-rose-50 text-rose-700 text-[10px] font-black uppercase tracking-widest">{tx('meals.verdict.cancelled', 'Inscripción cancelada')}</span>}
                                                </>;
                                            })()}</td>
                                            <td className="py-2 pr-3">{r.delivered ? <span className="text-emerald-700 font-bold">{stampTime(r.delivered_at)}{r.method ? <span className="block text-[11px] font-semibold text-gray-400">{methodLabel(tx, r.method)}</span> : null}</span> : <span className="text-orange-600 font-bold">{tx('meals.pending', 'Pendiente')}</span>}</td>
                                            <td className="py-2 text-gray-600 text-xs">{r.delivered_by || ''}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
