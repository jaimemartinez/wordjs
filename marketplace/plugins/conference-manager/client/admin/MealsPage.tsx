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
 *
 * 2.16.0: «Entrega» confirms before recording (per device, «Confirmar antes de entregar», default ON): a
 * scan opens the confirmation card (meal + the person's configured data + status) — Enter = Entregar,
 * Esc = Cancelar (records nothing); a code scanned while a card waits is QUEUED, never applied to it. Enter
 * only answers a card that has been on screen for a moment and is never a held-down key or the second Enter
 * of a scanner's CR+LF suffix; the queue also waits until the delivery's result has been seen («Entregado»
 * for a moment; anything else until Enter / Esc / a click). A person picked by name replaces the open card.
 * «Qué se muestra al entregar» (Alimentación › gestionar) chooses and orders the data on that card.
 * Whatever appears under the scan input (the check on its way, the card, a delivery's result) is brought
 * into view at once — on common desktop sizes it opened below the fold — and the card is capped to the
 * visible band, so its meal, name and buttons are on screen together; the counter tiles share a row only
 * where their words fit (Counters.tsx).
 *
 * 2.17.0 («en últimas entregas no muestra qué se le entregó»): «Últimas entregas» names WHAT was delivered on
 * every row and in its header (RecentDeliveries.tsx), and reloads — with the counters beside it — as soon as
 * the phone scanner records or undoes a delivery and when it closes, not at the next 15 s poll; an older
 * poll answering late can no longer put back a list without the newest delivery, and in a rush every newer
 * answer is applied (the list never freezes until scanning pauses). While the scanner covers the page its
 * totals reload at most every 2 s (createThrottle) and «Entrega» skips its poll: the scanner's deliveries
 * and its closing reload them.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { useModal } from "@/contexts/ModalContext";
import { conferenceApi } from "../lib/conference";
import { buildXlsx, downloadXlsx } from "../lib/xlsx";
import { exportFilename, withoutColumn } from "../lib/exports";
import {
    MEALS, DEFAULT_WINDOWS, buildMealReportWorkbook, chunk, columnState, createLatestLoader, createThrottle, dateRange, filterReportRows, groupByDay,
    normalizeCode, pickCurrentService, planKey, planSet, rowState, serviceWindow, sortServices, stampDayTime, stampTime,
} from "../lib/meals";
import {
    MealScanner, PersonSearch, VerdictCard, MEAL_ICON, dayLabel, mealLine, mealName, methodLabel, serviceName, servedLine, isOffline, useMealDelivery, useTx, makeTxn, createFeedback, primeScannerAudio,
    CheckingCard, ConfirmCard, ConfirmToggle, displayLabelsOf, useConfirmFlow, useConfirmPref,
} from "./MealScanner";
import { RecentDeliveries } from "./RecentDeliveries";
import {
    DEFAULT_DISPLAY_KEYS, REVEAL_FIT_VAR, REVEAL_MARGIN_PX, VERDICT_TAP_ARM_MS, canMoveDisplayKey, cardKeyAction, decisionSlotKey, displayLabel, displayOptions, displaySaveKeys,
    moveDisplayKey, previewDisplayFields, revealSlot, toggleDisplayKey, withName,
} from "../lib/mealConfirm";
import { Overlay } from "./Overlay";
import { Counter, Counters } from "./Counters";
import { TAB_STRIP_CSS } from "../lib/phoneLayout";
import { useStripOverflow, useRevealActive, stripMoreAttrs } from "../lib/useStripOverflow";
import { usePerms, ReadOnlyNotice } from "./perms";
import MealTurnsTab from "./MealTurnsTab";
import MealCallsTab from "./MealCallsTab";
import { DateField } from "../lib/DateField";
import { Select } from "../lib/Select";

type Tab = 'plan' | 'people' | 'turns' | 'calls' | 'delivery' | 'report';
// «Turnos» (2.32.0): the meal groups A–F and each service's call times (MealTurnsTab.tsx).
// «Llamar grupos» (2.36.5): the live calling of a service's groups (MealCallsTab.tsx) — the delivery team too.
const TABS: Tab[] = ['plan', 'people', 'turns', 'calls', 'delivery', 'report'];
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
        <Overlay layer={2} onBackdrop={onClose}>
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
        </Overlay>
    );
}

const Spinner = ({ label }: any) => (
    <div className="text-center py-16">
        <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-3"></div>
        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{label}</p>
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
    const allowedTabs = TABS.filter((k) => (k === 'delivery' ? canDeliver : k === 'calls' ? canPlan || canDeliver : canPlan));
    const [tab, setTabState] = useState<Tab>(() => {
        try { const v = localStorage.getItem(TAB_KEY) as Tab; return TABS.includes(v) ? v : 'plan'; } catch { return 'plan'; }
    });
    const setTab = (v: Tab) => { setTabState(v); try { localStorage.setItem(TAB_KEY, v); } catch { /* blocked storage */ } };
    const shownTab: Tab = allowedTabs.includes(tab) ? tab : (allowedTabs[0] || 'plan');
    const [data, setData] = useState<any>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [serviceId, setServiceId] = useState<number | null>(null);
    const [scanner, setScanner] = useState(false);
    // Synchronously inside the tap: iOS only unlocks Web Audio within a user gesture (the scanner adopts it).
    const openScanner = () => { primeScannerAudio(); setScanner(true); };

    const reload = useCallback(async () => {
        try { const d = await conferenceApi.getMeals(conferenceId); setData(d); setLoadFailed(false); return d; }
        catch (e: any) { setLoadFailed(true); addToast(e?.message || 'Error', 'error'); return null; }
    }, [conferenceId, addToast]);
    // A delivery or an undo made in the phone scanner (and the scanner closing): the page's totals AND
    // «Entrega» underneath — its counters and «Últimas entregas» reload at once (`changed`), not at its 15 s
    // poll; the list used to show the scanner's deliveries only after it. The page's totals (GET /meals: the
    // stats of EVERY service) reload at most every 2 s while the scanner reports a rush — they are hidden under
    // it — and at once for a lone event and when it closes (lib/meals createThrottle).
    const [deliveriesRev, setDeliveriesRev] = useState(0);
    const reloadRef = useRef(reload);
    reloadRef.current = reload;
    const totalsReload = useMemo(() => createThrottle(() => { reloadRef.current(); }, 2000), []);
    useEffect(() => () => totalsReload.cancel(), [totalsReload]);
    const deliveriesChanged = useCallback(() => { setDeliveriesRev((n) => n + 1); totalsReload.run(); }, [totalsReload]);
    const scannerClosed = useCallback(() => { setScanner(false); setDeliveriesRev((n) => n + 1); totalsReload.now(); }, [totalsReload]);
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

    // The sub-tab strip fades out on the side that has more tabs (lib/useStripOverflow.ts); it mounts with the
    // data. The active sub-tab is kept clear of that fade (useRevealActive), like the conference tabs.
    const subTabsRef = useRef<HTMLDivElement | null>(null);
    const subTabsMore = useStripOverflow(subTabsRef, [!!data, allowedTabs.length, shownTab]);
    useRevealActive(subTabsRef, '[aria-selected="true"]', [!!data, allowedTabs.length, shownTab]);

    if (!data) return loadFailed
        ? <div className="text-center py-16 space-y-3"><p className="text-sm font-bold text-gray-600">{tx('meals.load.failed', 'No se pudo cargar la alimentación.')}</p><button className={btnGhost} onClick={reload}>{tx('meals.retry', 'Reintentar')}</button></div>
        : <Spinner label={tx('loading', 'Cargando…')} />;

    const totals = services.reduce((a, s) => ({ entitled: a.entitled + (s.entitled || 0), delivered: a.delivered + (s.delivered || 0) }), { entitled: 0, delivered: 0 });
    const tabMeta: Record<Tab, [string, string]> = {
        plan: [tx('meals.tab.plan', 'Plan'), 'fa-table-cells'],
        people: [tx('meals.tab.people', 'Por persona'), 'fa-user'],
        turns: [tx('meals.tab.turns', 'Turnos'), 'fa-people-line'],
        calls: [tx('meals.tab.calls', 'Llamar grupos'), 'fa-bullhorn'],
        delivery: [tx('meals.tab.delivery', 'Entrega'), 'fa-qrcode'],
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
                            <div className="w-10 h-10 shrink-0 rounded-xl bg-orange-500 flex items-center justify-center text-white shadow-lg shadow-orange-200"><i className="fa-solid fa-utensils"></i></div>
                            <span className="text-[10px] font-bold text-orange-600 uppercase tracking-[0.2em]">{tx('meals', 'Alimentación')}</span>
                        </div>
                        <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter">{tx('meals.title', 'Comidas y entregas')}</h2>
                        <p className="text-xs text-gray-500 mt-1 max-w-xl">{tx('meals.subtitle', 'Define qué comidas recibe cada localidad, ajusta por persona y registra cada entrega con el código de barras del participante.')}</p>
                    </div>
                    {canDeliver && <button type="button" onClick={openScanner} disabled={!services.length}
                        className="px-6 py-4 rounded-2xl bg-gray-900 text-white hover:bg-black font-black text-xs uppercase tracking-widest shadow-lg transition-all active:scale-95 disabled:opacity-50">
                        <i className="fa-solid fa-mobile-screen-button mr-2" aria-hidden="true"></i>{tx('meals.scanner.open', 'Modo escáner (celular)')}
                    </button>}
                </div>
                <Counters cols={3} gap={12} className="relative mt-6">
                    <Counter label={tx('meals.count.services', 'Servicios')} value={services.length} icon="fa-utensils" />
                    <Counter label={tx('meals.count.entitled.all', 'Raciones con derecho')} value={totals.entitled} icon="fa-users" />
                    <Counter label={tx('meals.count.delivered.all', 'Raciones entregadas')} value={totals.delivered} tone="text-emerald-600" icon="fa-circle-check" />
                </Counters>
            </div>

            {/* Sub-tabs (only the ones the role may open). On a phone they scroll sideways: the strip fades out on
                the side that has more (lib/phoneLayout.ts TAB_STRIP_CSS). */}
            <style>{TAB_STRIP_CSS}</style>
            <div ref={subTabsRef} className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={tx('meals', 'Alimentación')} data-cm-scroll-strip="" {...stripMoreAttrs(subTabsMore)}>
                {allowedTabs.map((k) => (
                    <button key={k} type="button" role="tab" aria-selected={shownTab === k} onClick={() => setTab(k)}
                        className={`flex items-center gap-2 px-5 py-3 rounded-2xl border-2 font-black text-[11px] uppercase tracking-widest whitespace-nowrap transition-all ${shownTab === k ? 'border-orange-400 bg-orange-50 text-orange-700' : 'border-gray-100 bg-white text-gray-500 hover:border-gray-300'}`}>
                        <i className={`fa-solid ${tabMeta[k][1]}`} aria-hidden="true"></i>{tabMeta[k][0]}
                    </button>
                ))}
            </div>
            {shownTab !== 'delivery' && <ReadOnlyNotice section="meals" alsoManage={shownTab === 'people' || shownTab === 'calls' ? ['meals_delivery'] : []} />}

            {shownTab === 'plan' && canPlan && <PlanTab conferenceId={conferenceId} conference={conference} data={data} services={services} reload={reload} />}
            {shownTab === 'people' && canPlan && <PeopleTab conferenceId={conferenceId} data={data} services={services} reload={reload} />}
            {shownTab === 'turns' && canPlan && <MealTurnsTab conferenceId={conferenceId} />}
            {shownTab === 'calls' && (canPlan || canDeliver) && <MealCallsTab conferenceId={conferenceId} services={services} serviceId={serviceId} setServiceId={chooseService} />}
            {shownTab === 'delivery' && canDeliver && <DeliveryTab conferenceId={conferenceId} services={services} locations={data.locations || []} serviceId={serviceId} setServiceId={chooseService} reload={reload} paused={scanner} onScanner={openScanner} changed={deliveriesRev} />}
            {shownTab === 'report' && canPlan && <ReportTab services={services} serviceId={serviceId} setServiceId={chooseService} slug={slug} />}

            {scanner && canDeliver && (
                <MealScanner conferenceId={conferenceId} services={services} serviceId={serviceId} language={language}
                    onServiceChange={chooseService} onChanged={deliveriesChanged} onClose={scannerClosed} />
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
        <Select id={id} className={inputCls} value={serviceId ?? ''} onChange={(e) => setServiceId(e.target.value ? Number(e.target.value) : null)}>
            {!services.length && <option value="">{tx('meals.services.none', 'Todavía no hay servicios de comida.')}</option>}
            {/* Nothing selected (e.g. the service was deleted): say so instead of showing the first one. */}
            {services.length > 0 && serviceId == null && <option value="">{tx('meals.scanner.pick', 'Elige un servicio')}</option>}
            {days.map((d) => (
                <optgroup key={d.date} label={dayLabel(d.date, language, true)}>
                    {d.services.map((s) => <option key={s.id} value={s.id}>{serviceName(tx, s, language)}</option>)}
                </optgroup>
            ))}
        </Select>
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
                <div className="space-y-1.5"><label htmlFor="ms-from" className={labelCls}>{tx('meals.create.from', 'Desde')}</label><DateField id="ms-from" value={from} max={to || undefined} onChange={(v) => setFrom(v)} /></div>
                <div className="space-y-1.5"><label htmlFor="ms-to" className={labelCls}>{tx('meals.create.to', 'Hasta')}</label><DateField id="ms-to" value={to} min={from || undefined} onChange={(v) => setTo(v)} /></div>
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
                    <Select id="mp-loc" className={inputCls} value={loc} onChange={(e) => setLoc(e.target.value)}>
                        <option value="">{tx('meals.location.all', 'Todas')}</option>
                        {(data.locations || []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                        <option value="none">{tx('meals.no.location', 'Sin localidad')}</option>
                    </Select></div>
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
            // The toast names the meal, like the «Entregado» card and «Últimas entregas».
            const meal = mealLine(tx, o.verdict?.service || s, language);
            if (o.result === 'delivered') addToast(tx('meals.delivered.what', 'Entregado: {meal}', { meal }), 'success');
            else if (o.result === 'already') addToast(tx('meals.already.what', 'Ya recibió: {meal}', { meal }), 'error');
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
function DeliveryTab({ conferenceId, services, locations, serviceId, setServiceId, reload, paused, onScanner, changed = 0 }: any) {
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
    /** The service the server answered «Últimas entregas» for: what every row delivered. */
    const [recentService, setRecentService] = useState<any>(null);
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
    /** «Qué se muestra al entregar» is open: nothing here takes the focus or a key from it. */
    const [displayOpen, setDisplayOpen] = useState(false);
    const displayOpenRef = useRef(displayOpen);
    displayOpenRef.current = displayOpen;

    // The counters and «Últimas entregas», loaded every 15 s and after every delivery / undo: an answer is
    // applied unless a load that left later is already shown (lib/meals createLatestLoader) — a poll that
    // left before a delivery must not put back the list without it, and in a rush every newer answer still
    // lands — and only while its service is still selected.
    const loadRecent = useMemo(() => createLatestLoader({
        load: (sid: number) => Promise.all([conferenceApi.getMealServiceStats(sid), conferenceApi.getMealServiceDeliveries(sid, 20)]),
        current: () => (alive.current ? sidRef.current : null),
        apply: (_sid: number, [s, r]: any) => { setStats(s); setRecent(r.deliveries || []); setRecentService(r.service || null); },
    }), []);
    const refresh = useCallback(async () => {
        if (!serviceId) { setStats(null); setRecent([]); setRecentService(null); return; }
        await loadRecent(serviceId);   // a failure keeps the last numbers
    }, [serviceId, loadRecent]);
    const refreshRef = useRef(refresh);
    refreshRef.current = refresh;
    // A new service: fresh numbers. The «Servicio no encontrado» card stays while nothing is selected. No poll
    // while the phone scanner covers this screen: its deliveries / undos and its closing reload (`changed`).
    useEffect(() => {
        setOutcome((o) => (!serviceId && o?.result === 'no_service' ? o : null));
        setStats(null); setRecent([]); setRecentService(null); setUndoAsk(null);
        refresh();
        const h = setInterval(() => { if (!pausedRef.current) refresh(); }, 15000);
        return () => clearInterval(h);
    }, [refresh]);
    // A delivery or an undo made in the phone scanner over this screen, or the scanner closing (MealsPage
    // `changed`): reload now instead of at the next poll.
    const seenChange = useRef(changed);
    useEffect(() => {
        if (seenChange.current === changed) return;
        seenChange.current = changed;
        refreshRef.current();
    }, [changed]);

    // The scan input keeps the focus (a USB / Bluetooth scanner types into whatever is focused) — except
    // while the name search is open, the phone scanner covers this screen or a dialog is open. While the slot
    // shows something to decide or read, taking the focus back never scrolls it out of view.
    const slotKeyRef = useRef<string | null>(null);
    const focusInput = () => { if (!searchingRef.current && !pausedRef.current && !displayOpenRef.current && alive.current) inputRef.current?.focus(slotKeyRef.current ? { preventScroll: true } : undefined); };
    useEffect(() => { focusInput(); }, [serviceId, searching, paused, displayOpen]);

    // The page header's totals: one GET /meals a moment after a burst of scans, not one per scan.
    const reloadTimer = useRef<any>(null);
    const scheduleReload = () => { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(() => reload(), 2000); };
    useEffect(() => () => clearTimeout(reloadTimer.current), []);
    // Scans are posted one after another, in order: a USB scanner can send the next code while the
    // previous request is still running, and no code may be dropped.
    const queue = useRef<Promise<void>>(Promise.resolve());
    const pending = useRef(0);
    // A delivery's verdict on screen (immediate mode, «Entregar» of the confirmation card, the inline
    // «Entregar de todas formas»): sound, the card, the counters.
    const showOutcome = async (o: any, sid: number) => {
        if (!alive.current) return;
        if (o.result === 'delivered') feedback.current.ok(); else feedback.current.bad();
        // The service changed while this scan was queued: its verdict would read as the new one's.
        if (sid !== sidRef.current) { if (o.result === 'delivered') scheduleReload(); return; }
        setOutcome(o);
        if (o.result === 'no_service') { await reload(); return; }   // the parent then asks for a service
        if (o.result === 'delivered') scheduleReload();
        refreshRef.current();
    };
    // Its result is capped and brought into view like every result in the slot (decisionSlotKey), the
    // confirmation ON or OFF.
    const run = (body: any) => {
        if (!serviceId) return;
        const sid = serviceId;
        pending.current++; setBusy(true);
        queue.current = queue.current.then(async () => {
            try {
                const o = await deliver({ service_id: sid, ...body });
                await showOutcome(o, sid);
            } finally {
                if (--pending.current === 0 && alive.current) { setBusy(false); setTimeout(focusInput, 0); }
            }
        });
    };

    // ── 2.16.0: confirm before delivering (per device, default ON; OFF = `run`, today's immediate delivery) ──
    const [confirmOn, setConfirmOn] = useConfirmPref();
    const confirmRef = useRef(confirmOn);
    confirmRef.current = confirmOn;
    const [flow, confirm] = useConfirmFlow({
        // A USB wedge never waits: a code scanned while a card asks for a decision is queued behind it — and
        // the queue also waits until the delivery's result has been seen («Entregado» for a moment; any other
        // result until Enter / Esc / a click: a delivery that was NOT recorded must never be hidden).
        queue: true,
        onCheck: (card) => {
            if (!alive.current) return;
            // The previous delivery's verdict belongs to someone else: it must not come back after «Cancelar».
            setOutcome(null);
            if (card.result === 'ready') feedback.current.attention(); else feedback.current.bad();
            if (card.result === 'no_service') reload();
        },
        onResult: (o, card) => { showOutcome(o, card.serviceId); },
        onClose: () => { setTimeout(focusInput, 0); },
    });
    const flowRef = useRef(flow);
    flowRef.current = flow;
    // Another service, or the confirmation switched off: the open card and the queue belong to the old state.
    useEffect(() => { flow.reset(); }, [serviceId, confirmOn, flow]);
    // The decision is always in view (lib/mealConfirm revealSlot): whatever newly appears in the slot — the
    // check on its way, a card, a delivery's result (the confirmation ON or OFF) — is capped to the visible band
    // and scrolled into view before it is painted; once more on the next frame, when the card has settled (a
    // result that replaces another one re-measures its details after this effect and may grow: «Ya recibió»
    // after «Entregado» ended 50 px under the fold at 320×460); again when the window is resized.
    const slotRef = useRef<HTMLDivElement>(null);
    const slotKey = decisionSlotKey({ confirmOn, card: confirm.card, checking: confirm.checking, outcome, held: confirm.held });
    slotKeyRef.current = slotKey;
    useLayoutEffect(() => {
        // Nothing to bring into view (an empty slot): no cap either — never a stale one.
        if (!slotKey) { slotRef.current?.style.removeProperty(REVEAL_FIT_VAR); return; }
        const reveal = () => { revealSlot(slotRef.current, window); };
        reveal();
        const frame = typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(reveal) : null;
        window.addEventListener('resize', reveal);
        return () => { if (frame != null) window.cancelAnimationFrame(frame); window.removeEventListener('resize', reveal); };
    }, [slotKey]);
    /** What a key answers: the open card, or the delivery result that holds the queue. */
    const keyTarget = (st: any) => (st.card ? st.card.result : st.held ? 'held' : null);
    /** The result on screen was seen (Enter / Esc / a click): «Cerrar» an informative card, or let the queue go on. */
    const ack = () => { if (flowRef.current.close()) setOutcome(null); };
    const ackRef = useRef(ack);
    ackRef.current = ack;
    // Esc = «Cancelar» (records nothing) / «Cerrar» — wherever the focus is, unless the phone scanner or a
    // dialog is on top (they have their own Esc). A held-down Esc does nothing.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || pausedRef.current || displayOpenRef.current || !confirmRef.current) return;
            const f = flowRef.current;
            const a = cardKeyAction('Escape', keyTarget(f.state()), '', { now: Date.now(), repeat: e.repeat });
            if (a === 'cancel') { e.preventDefault(); f.cancel(); }
            else if (a === 'close') { e.preventDefault(); ackRef.current(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
    // A code (scanned or typed) or a person picked. Confirmation ON: the card — or the queue behind an
    // open one; never «Entregar» for the card on screen. A person picked by name (`manual`) is the
    // operator's choice NOW: it replaces the open card, like on the phone (flow.pick).
    const scanBody = (body: any, manual = false) => {
        if (!serviceId) return;
        if (!confirmRef.current) { run(body); return; }
        const r = manual ? flow.pick(serviceId, body) : flow.scan(serviceId, body);
        if (r === 'checking') setOutcome(null);
        else if (r === 'ignored') feedback.current.bad();
    };
    /** The previous keydown in the scan input: an Enter right after it is part of the same burst. */
    const lastKeyAt = useRef<number | null>(null);
    // Enter in the scan input (keydown, so a held-down key and a CR+LF burst can be told apart).
    const onScanKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        const at = Date.now();
        const prev = lastKeyAt.current;
        lastKeyAt.current = at;
        if (e.key !== 'Enter') return;
        e.preventDefault();
        submit({ now: at, lastKeyAt: prev, repeat: e.repeat });
    };
    const submit = (key?: { now: number; lastKeyAt: number | null; repeat?: boolean }) => {
        const raw = code;
        setCode('');
        if (confirmRef.current) {
            // Enter on an EMPTY input answers the card on screen (a wedge's Enter always follows a code,
            // which makes it a new scan instead) — once the card has been seen, never as a repeat or burst.
            const st = flow.state();
            const a = cardKeyAction('Enter', keyTarget(st), raw, { now: key?.now ?? Date.now(), lastKeyAt: key ? key.lastKeyAt : lastKeyAt.current, repeat: !!key?.repeat, shownAt: st.card ? st.card.shownAt : st.heldAt });
            if (a === 'deliver') { flow.deliver(); return; }
            if (a === 'close') { ack(); return; }
        }
        if (!normalizeCode(raw)) return;      // Enter on an empty / garbage input is ignored
        scanBody({ code: raw });
    };
    // Called by the VerdictCard after its inline confirmation.
    const force = (o: any) => {
        const p = o.verdict?.person;
        if (!p) return;
        if (o.result === 'group_not_called') run({ inscription_id: p.id, allow_group: true, note: tx('meals.group.note.kitchen', 'Dejado pasar antes de su grupo en la entrega') });
        else run({ inscription_id: p.id, force: true, note: tx('meals.force.note.kitchen', 'Autorizado en la entrega') });
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
                    {/* Enter is handled on keydown (onScanKey); the submit is the fallback of a virtual keyboard's «Ir». */}
                    <form noValidate onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-2">
                        <label htmlFor="md-code" className={labelCls}>{tx('meals.delivery.scan', 'Escanea el código (o escríbelo y pulsa Enter)')}</label>
                        <input id="md-code" ref={inputRef} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={onScanKey} autoFocus autoComplete="off" spellCheck={false} autoCapitalize="characters"
                            className="w-full border-4 border-orange-200 focus:border-orange-500 rounded-3xl px-6 py-5 text-3xl font-mono font-black tracking-[0.2em] text-gray-900 outline-none bg-orange-50/30"
                            placeholder="▌▌▌ ▌▌ ▌▌▌" disabled={!serviceId} data-scan-input="" />
                    </form>
                    <div className="min-h-[96px]" ref={slotRef} data-decision-slot="" style={{ scrollMarginTop: REVEAL_MARGIN_PX, scrollMarginBottom: REVEAL_MARGIN_PX }}>
                        {confirm.card
                            // Capped to the visible band (REVEAL_FIT_VAR, set by revealSlot): the middle scrolls, the meal,
                            // the name and the buttons stay on screen.
                            ? <div data-confirm-fit="" style={{ display: 'flex', flexDirection: 'column', maxHeight: `var(${REVEAL_FIT_VAR}, none)` }}>
                                <ConfirmCard card={confirm.card} service={service} language={language} delivering={confirm.delivering} waiting={confirm.waiting} keyHints
                                    onDeliver={() => flow.deliver()}
                                    onAuthorize={() => flow.authorize(tx('meals.force.note.kitchen', 'Autorizado en la entrega'))}
                                    onAllowGroup={() => flow.allowGroup(tx('meals.group.note.kitchen', 'Dejado pasar antes de su grupo en la entrega'))}
                                    onCancel={() => flow.cancel()}
                                    onClose={() => flow.close()} />
                            </div>
                            : confirm.checking ? <CheckingCard />
                                : outcome
                                    // Capped the same way (2.17.0, live round at 320×460: 888 px tall, «Deshacer» far below the
                                    // fold): the status, the meal, the name and «Deshacer» on screen at once.
                                    ? <div data-verdict-fit="" style={{ display: 'flex', flexDirection: 'column', maxHeight: `var(${REVEAL_FIT_VAR}, none)` }}>
                                        <VerdictCard outcome={outcome} service={service} busy={busy || confirm.delivering} language={language} armMs={confirmOn ? VERDICT_TAP_ARM_MS : 0}
                                            onForce={outcome.result === 'not_entitled' || outcome.result === 'group_not_called' ? force : undefined} onUndo={undo} onDismiss={() => { setOutcome(null); flow.close(); focusInput(); }} />
                                    </div>
                                    : <div className="h-full rounded-3xl border-2 border-dashed border-gray-100 flex items-center justify-center text-sm font-bold text-gray-400 py-8"><i className="fa-solid fa-qrcode mr-2" aria-hidden="true"></i>{tx('meals.delivery.waiting', 'Esperando un código…')}</div>}
                        {/* The queue waits behind a delivery's result: say so, and how to go on. */}
                        {confirmOn && !confirm.card && !confirm.checking && (confirm.held || confirm.waiting > 0) && (
                            <div data-confirm-queue={confirm.held ? 'held' : 'waiting'} className="mt-2 text-xs font-black text-gray-600" role="status">
                                {[confirm.waiting > 0 ? txn('meals.confirm.waiting', '{n} códigos en espera', '{n} código en espera', confirm.waiting) : '',
                                    confirm.held ? tx('meals.confirm.held', 'Revisa el resultado: Enter o Esc para continuar') : ''].filter(Boolean).join(' · ')}
                            </div>
                        )}
                    </div>
                    <div>
                        {!searching
                            ? <button type="button" className={btnGhost} onClick={() => setSearching(true)}><i className="fa-solid fa-magnifying-glass mr-1.5" aria-hidden="true"></i>{tx('meals.scanner.search', 'Buscar por nombre')}</button>
                            : <div className="rounded-2xl border border-gray-100 p-4 space-y-3">
                                <div className="flex items-center justify-between"><span className={labelCls}>{tx('meals.scanner.search', 'Buscar por nombre')}</span>
                                    <button type="button" className="text-gray-400 hover:text-gray-600 p-1" onClick={() => setSearching(false)} aria-label={tx('close', 'Cerrar')}><i className="fa-solid fa-xmark" aria-hidden="true"></i></button></div>
                                <PersonSearch conferenceId={conferenceId} busy={busy || confirm.delivering} action={confirmOn ? tx('meals.confirm.pick', 'Elegir') : undefined}
                                    onPick={(p) => { setSearching(false); scanBody({ inscription_id: p.id }, true); }} />
                            </div>}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
                        <ConfirmToggle on={confirmOn} onChange={(v) => { setConfirmOn(v); setTimeout(focusInput, 0); }} />
                        {canPlanEdit && (
                            <button type="button" className={`${btnGhost} w-full min-h-[52px]`} onClick={() => setDisplayOpen(true)} data-display-open="">
                                <i className="fa-solid fa-id-card mr-1.5" aria-hidden="true"></i>{tx('meals.display.open', 'Qué se muestra al entregar')}
                            </button>
                        )}
                    </div>
                </div>
            </div>
            {displayOpen && canPlanEdit && <DisplayFieldsDialog conferenceId={conferenceId} service={service} locations={locations} onClose={() => { setDisplayOpen(false); }} />}

            <div className="space-y-5">
                <div className={`${card} p-5 space-y-3`}>
                    {/* A third of a desktop, the whole width of a phone: the tiles share a row only where they fit. */}
                    <Counters cols={3} gap={8}>
                        <Counter label={tx('meals.count.delivered', 'Entregados')} value={stats?.delivered ?? '—'} tone="text-emerald-600" />
                        <Counter label={tx('meals.count.entitled', 'Con derecho')} value={stats?.entitled ?? '—'} />
                        <Counter label={tx('meals.count.pending', 'Pendientes')} value={stats?.pending ?? '—'} tone="text-orange-600" />
                    </Counters>
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
                {/* WHAT was delivered, to whom (RecentDeliveries.tsx): the service the server answered the rows
                    for — the selected one until it answers. */}
                <RecentDeliveries service={recentService || service} rows={recent} busy={busy} undoAsk={undoAsk} onAskUndo={setUndoAsk} onUndo={undo} />
            </div>
        </div>
    );
}

/// «Qué se muestra al entregar» (2.16.0, Alimentación › gestionar): which of the person's data the delivery
// card shows, in which order — a checkbox list with up/down buttons (always visible, touch-sized) and a live
// preview of the card. The full name is LOCKED first (staff must see who they deliver to; the server
// enforces it too). «Restablecer» only puts the default back in the form (review it in the preview, then
// «Guardar»); saving the default stores «not configured». The server validates every key against the
// conference's current form.
function DisplayFieldsDialog({ conferenceId, service, locations, onClose }: any) {
    const tx = useTx();
    const { language } = useI18n();
    const { addToast } = useToast();
    const [d, setD] = useState<any>(null);
    const [failed, setFailed] = useState(false);
    const [selected, setSelected] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let alive = true;
        conferenceApi.getMealDisplayFields(conferenceId)
            .then((r) => { if (alive) { setD(r); setSelected(withName(r.keys || [])); } })
            .catch((e) => { if (alive) { setFailed(true); addToast(e?.message || 'Error', 'error'); } });
        return () => { alive = false; };
    }, [conferenceId]);
    const L = displayLabelsOf(tx);
    const labelOf = (f: any) => displayLabel(f, L);
    const options = d ? displayOptions(d.available || [], selected) : [];
    const sample = (f: any) => (f.key === '@name' ? tx('meals.display.sample.name', 'María Pérez')
        : f.key === '@location' ? ((locations || [])[0]?.name || labelOf(f))
            : f.key === '@reg_code' ? 'ABCD234XYZ'
                : f.key === '@payment_status' ? 'paid'
                    : f.key === '@room' ? tx('meals.display.sample.room', 'Hotel Central · 204')
                        : tx('meals.display.sample', 'Ejemplo'));
    const preview = d ? {
        seq: 0, serviceId: service?.id || 0, body: {}, result: 'ready',
        verdict: { service: service || null, person: { id: 0, name: '', fields: previewDisplayFields(selected, d.available || [], sample) } },
    } : null;
    const save = async (keys: string[] | null) => {
        setBusy(true);
        try {
            await conferenceApi.setMealDisplayFields(conferenceId, keys);
            addToast(tx('meals.display.saved', 'Datos de la entrega guardados'), 'success');
            onClose();
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setBusy(false); }
    };
    const arrow = 'w-11 h-11 shrink-0 rounded-xl border-2 border-gray-100 bg-white text-gray-700 flex items-center justify-center disabled:opacity-30';
    return (
        <Modal wide title={tx('meals.display.open', 'Qué se muestra al entregar')} subtitle={tx('meals.display.subtitle', 'Elige y ordena los datos de la persona que verá quien entrega la comida. El nombre siempre aparece, arriba.')} onClose={onClose}
            footer={<>
                <button type="button" className={btnGhost} disabled={busy || !d} onClick={() => setSelected(withName(d?.default_keys || DEFAULT_DISPLAY_KEYS))} data-display-reset="">{tx('meals.display.reset', 'Restablecer')}</button>
                <button type="button" onClick={onClose} className="px-6 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">{tx('cancel', 'Cancelar')}</button>
                <button type="button" onClick={() => save(displaySaveKeys(selected, d?.default_keys))} disabled={busy || !d || !selected.length} className={btnPrimary} data-display-save="">{tx('save', 'Guardar')}</button>
            </>}>
            {!d ? (failed
                ? <p className="text-sm font-bold text-rose-600" role="alert">{tx('meals.display.load.failed', 'No se pudo cargar la configuración.')}</p>
                : <Spinner label={tx('loading', 'Cargando…')} />)
                : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-2">
                            <ul className="space-y-2" data-display-options="">
                                {options.map((f) => (
                                    <li key={f.key} data-display-option={f.key} data-on={f.on ? '1' : '0'} data-locked={f.locked ? '1' : undefined}
                                        className={`flex items-center gap-2 rounded-2xl border-2 px-3 py-1.5 ${f.on ? 'border-emerald-300 bg-emerald-50/50' : 'border-gray-100 bg-white'}`}>
                                        <label className={`flex items-center gap-3 flex-1 min-w-0 py-2 ${f.locked ? '' : 'cursor-pointer'}`}>
                                            <input type="checkbox" className="w-5 h-5 accent-emerald-600 shrink-0" checked={f.on} disabled={f.locked} onChange={() => setSelected((s) => toggleDisplayKey(s, f.key))} />
                                            <span className="min-w-0">
                                                <span className="block text-base font-black text-gray-900 break-words">{labelOf(f)}</span>{' '}
                                                <span className="block text-[10px] font-black uppercase tracking-widest text-gray-400">{f.locked ? tx('meals.display.name.locked', 'Siempre se muestra, arriba') : f.builtin ? tx('meals.display.builtin', 'Del sistema') : tx('meals.display.form', 'Del formulario')}</span>
                                            </span>
                                        </label>
                                        {f.on && !f.locked && <>
                                            <button type="button" className={arrow} disabled={!canMoveDisplayKey(selected, f.key, -1)} onClick={() => setSelected((s) => moveDisplayKey(s, f.key, -1))}
                                                aria-label={tx('meals.display.up', 'Subir «{label}»', { label: labelOf(f) })} data-display-up={f.key}><i className="fa-solid fa-arrow-up" aria-hidden="true"></i></button>
                                            <button type="button" className={arrow} disabled={!canMoveDisplayKey(selected, f.key, 1)} onClick={() => setSelected((s) => moveDisplayKey(s, f.key, 1))}
                                                aria-label={tx('meals.display.down', 'Bajar «{label}»', { label: labelOf(f) })} data-display-down={f.key}><i className="fa-solid fa-arrow-down" aria-hidden="true"></i></button>
                                        </>}
                                    </li>
                                ))}
                            </ul>
                            {!selected.length && <p className="text-xs font-bold text-rose-600" role="alert">{tx('meals.display.none', 'Elige al menos un dato.')}</p>}
                            <p className="text-[11px] text-gray-500">{tx('meals.display.default', 'Por defecto: nombre completo y localidad.')}</p>
                            <p className="text-[11px] text-gray-500" data-display-note="">{tx('meals.display.note', 'Las respuestas del formulario, el estado de pago y la habitación solo se envían a la tarjeta si los eliges aquí. El nombre y la localidad también aparecen en la búsqueda por nombre de quien entrega.')}</p>
                            {selected.includes('@reg_code') && <p className="text-[11px] text-gray-500">{tx('meals.display.reg_code.hint', 'El código solo se ve con permiso para ver inscripciones.')}</p>}
                        </div>
                        <div className="space-y-2">
                            <div className={labelCls}>{tx('meals.display.preview', 'Vista previa')}</div>
                            {/* A picture of the card: its buttons do nothing here (inert). */}
                            <div data-display-preview="" inert>
                                <ConfirmCard card={preview} service={service} language={language} />
                            </div>
                        </div>
                    </div>
                )}
        </Modal>
    );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// 4. REPORTE
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
function ReportTab({ services, serviceId, setServiceId, slug }: any) {
    const tx = useTx();
    const txn = makeTxn(tx);
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
                    <Counters cols={4} gap={12}>
                        <Counter label={tx('meals.count.entitled', 'Con derecho')} value={t.entitled} />
                        <Counter label={tx('meals.count.delivered', 'Entregados')} value={t.delivered} tone="text-emerald-600" />
                        <Counter label={tx('meals.count.pending', 'Pendientes')} value={t.pending} tone="text-orange-600" />
                        <Counter label={tx('meals.count.overrides.short', 'Sin derecho (autorizados)')} value={t.overrides_delivered} tone="text-amber-600" />
                    </Counters>
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
