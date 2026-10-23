// @ts-nocheck
"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { ConferenceProvider, useConference } from "../contexts/ConferenceContext";
// Import from GLOBAL context/lib
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { registerTranslations } from "../../../../../frontend/src/lib/i18n";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
// Import local translations data
import { translations } from "../lib/i18n";
import { conferenceApi, feePaymentsApi, PAYMENT_METHODS, Conference, Inscription, Hotel, Room, Location, ConferenceField, LodgingReview, buildInscriptionPayload, seedLocationId, fmtMoney, isLodgingFrozen, LODGING_NO_WAIT, LODGING_NO_CLOSE } from "../lib/conference";
// Administration adjustments of a submitted / validated lodging arrangement (2.17.0).
import { AdjustStamp, DotList, adjustConfirmText, adjustStampOf, adjustText, reviewSeen, withAdjusted } from "./LodgingAdjust";
import { useModal } from "@/contexts/ModalContext";
import TransportPage from "./TransportPage";
import AccountingPage from "./AccountingPage";
import MealsPage from "./MealsPage";
import { qrSvg, qrPng } from "../lib/qr";
import { parseGeo, GEO_MESSAGES, mapsUrl } from "../lib/geo";
import { PlacePicker } from "./PlacePicker";
import { buildXlsx, downloadXlsx } from "../lib/xlsx";
import { availableColumns, defaultColumnKeys, filterRoster, buildRosterSheet, buildHotelReport, exportFilename, transportByPerson, withoutColumn } from "../lib/exports";
import { StatCard } from "../../../../../frontend/src/components/ui/StatCard";
import { ActionCard } from "../../../../../frontend/src/components/ui/ActionCard";
import { Overlay } from "./Overlay";
import { canAutoFocus, LAYER } from "../lib/overlay";
// Phones (2.16.0): the shell scrolls with the page; the tab strip reveals the active tab.
import { DECO_LAYER_CLASS, HERO_HEAD_CLASS, SHELL_CSS, STAT_GRID_CLASS, TAB_STRIP_CSS } from "../lib/phoneLayout";
import { useStripOverflow, useRevealActive, stripMoreAttrs } from "../lib/useStripOverflow";
// Lodging explorer (2.13.0) and the pure helpers it shares with this page (status meta, display
// names, field values, {placeholder} filling) — they live in lib/lodgingView.ts so the explorer never
// imports this file.
import LodgingExplorer from "./LodgingExplorer";
import { fillVars, genderKey, hotelStats, lodgingStatusMeta, personDisplayName, indexOccupants, moveAdjustments, occupantLocationIds, reviewedLocationOf, reviewedLocationsAmong, runSummaryOf, sharedBedFree, lockMismatch, lockText, pinnedHere, needsLodging } from "../lib/lodgingView";
// Staff & permissions (2.15.0): who sees which view and which controls (perms.tsx); «Equipo y permisos».
import { PermsProvider, usePerms, hasAnySection, ReadOnlyNotice, canReadRoster, canReadHotels } from "./perms";
import type { Perms } from "./perms";
import StaffPage from "./StaffPage";
import BadgesPage from "./BadgesPage";
import ConsentAdmin from "./ConsentAdmin";
import { consentT } from "../lib/consentI18n";
import { BadgeActions } from "./BadgeActions";
import { useFieldErrors, FieldError } from "../lib/useFieldErrors";
import { useTx } from "./MealScanner";
// Form fields (2.16.0): templates for the base fields, what a deletion switches off, rules on deleted fields.
import { fieldDependents, isOrphanFeeRule, isSwitchOn, LODGING_FIELD, missingRuleFields, moveItem, publishRefusal, SWITCH_OFF, SWITCH_ON, templateStates, TEMPLATE_OPEN_CLASS, TEMPLATE_DONE_CLASS, TEMPLATE_DESC_CLASS } from "../lib/fields";
import { NO_ACCESS_TEXT, noAccessReason } from "../lib/team";
import { paymentMethodLabel, switchLabel } from "../lib/labels";
import { HealthConditionsInput } from "../lib/HealthConditionsInput";
import { DateField } from "../lib/DateField";
import { PhoneInput } from "../lib/PhoneInput";
import { PhoneCountrySetting } from "./PhoneCountrySetting";
import { isPhoneField } from "../lib/phone";
import { HEALTH_FIELD, healthAnswerError, healthAnswerText, healthPayload, isHealthField, sameHealthAnswer } from "../lib/health";
// Inscription tables + «Pagos de cuotas» (2.18.0): browser-side search / filters / paging, the person sheet
// (⋮), split fee payments.
import {
    ROSTER_CSS, EMPTY_ROSTER_FILTERS, EMPTY_ROSTER_NAV, activeFilterCount, applyRosterFilters, defaultRosterColumns, formIsDirty, groupByLocation,
    parseRosterColumns, parseRosterNav, pendingCount, rawFieldValue, rosterColumnsKey, rosterLocationKey, rosterNavKey, rosterSort, rowHaystack,
    focusFirstVisible, rosterNeighborSelectors,
} from "../lib/roster";
import { clampPage, pageAfterResize, pagedScroll, readPageSize, writePageSize } from "../lib/paging";
import { personBalance } from "../lib/feePayments";
import { toCents } from "../lib/feeSplit";
import RosterGroup from "./RosterGroup";
import RosterFilters from "./RosterFilters";
import PersonSheet from "./PersonSheet";
import RegisterPaymentSheet, { buildPersonOptions } from "./RegisterPaymentSheet";
import TransferSheet from "./TransferSheet";
import FeePaymentsPage from "./FeePaymentsPage";
import { money as feeMoney } from "./FeeBits";
import LodgingPlan from "./LodgingPlan";
import { Select } from "../lib/Select";

// Register plugin translations
registerTranslations(translations);

type View = 'list' | 'dashboard' | 'inscriptions' | 'consent' | 'fees' | 'lodging' | 'transport' | 'meals' | 'badges' | 'accounting' | 'locations' | 'reports' | 'assignment' | 'fields' | 'pricing' | 'staff';

/**
 * The conference views in tab order (the first one the role may open is the default). 2.18.0: the money tabs
 * sit together — «Pagos de cuotas» and «Contabilidad» right after «Inscripciones» (D-P16).
 */
const TAB_VIEWS: View[] = ['dashboard', 'inscriptions', 'fees', 'accounting', 'consent', 'lodging', 'transport', 'meals', 'badges', 'locations', 'assignment', 'fields', 'pricing', 'reports', 'staff'];

/**
 * View → section (2.15.0). «Inscripciones» opens with Inscripciones › ver — since 2.18.0 no longer with
 * Pagos alone (D-P20): the fee payments have their own tab, «Pagos de cuotas» (Pagos › ver to look, › gestionar
 * to register and validate), and a payments-only role lands there. «Asignación» belongs to Hospedaje;
 * «Campos» and «Precios» to Configuración; «Alimentación» opens with the meals plan (view) OR the kitchen's
 * delivery (operate); «Equipo y permisos» is for WordJS administrators only. The conference list is open to
 * every staff member.
 */
export const viewAllowed = (v: View, p: Perms): boolean => {
    switch (v) {
        case 'list': return true;
        case 'dashboard': return p.can('dashboard');
        case 'inscriptions': return p.can('inscriptions');
        // «Autorizaciones» (2.33.0): the states with Inscripciones › ver; its settings with Configuración › gestionar.
        case 'consent': return p.can('inscriptions');
        case 'fees': return p.can('payments');
        case 'lodging': return p.can('lodging');
        case 'assignment': return p.can('lodging');
        case 'transport': return p.can('transport');
        case 'meals': return p.can('meals') || p.can('meals_delivery', 'manage');
        case 'badges': return p.can('badges');
        case 'locations': return p.can('locations');
        case 'fields': return p.can('settings');
        case 'pricing': return p.can('settings');
        case 'reports': return p.can('reports');
        case 'accounting': return p.can('accounting');
        case 'staff': return p.isAdmin;
        default: return false;
    }
};
const firstAllowedView = (p: Perms): View => TAB_VIEWS.find(v => viewAllowed(v, p)) || 'list';

// LODGING_STATUS_META / lodgingStatusMeta and withName ({name} placeholder; t() has no interpolation)
// moved to lib/lodgingView.ts in 2.13.0.

function ConferenceManagerContent() {
    const { currentConference, setCurrentConference, loading } = useConference();
    // useI18n from global context
    const { t, language } = useI18n();
    const tx = useTx();
    const perms = usePerms();
    const [view, setViewState] = useState<View>('list');
    const firstView = firstAllowedView(perms);

    // Initialize state from local storage — a saved view the role may not open falls back to the first
    // one it may (the conference list stays the start page when nothing was saved).
    useEffect(() => {
        const savedView = localStorage.getItem('conference-manager:view') as View;
        if (savedView && ['list', 'dashboard', 'inscriptions', 'fees', 'consent', 'lodging', 'transport', 'meals', 'badges', 'locations', 'assignment', 'fields', 'pricing', 'reports', 'accounting', 'staff'].includes(savedView)) {
            setViewState(viewAllowed(savedView, perms) ? savedView : firstView);
        }
    }, []);

    const setView = (newView: View) => {
        const next = viewAllowed(newView, perms) ? newView : firstView;
        setViewState(next);
        try { localStorage.setItem('conference-manager:view', next); } catch { /* blocked storage */ }
    };

    // «Ver ocupación» (Hoteles y habitaciones) → the lodging explorer in «Asignación», opened at that
    // hotel / room; «Ajustar en Asignación» (the lodging review, 2.17.0) → the explorer filtered by that
    // location. The explorer consumes the focus once and clears it (onFocusConsumed); it never goes
    // through the browser history (the admin lives inside the Next.js app router).
    const [lodgingFocus, setLodgingFocus] = useState<{ hotelId?: number | null; roomId?: number | null; locationId?: number | null } | null>(null);
    const openLodgingExplorer = (focus: { hotelId?: number | null; roomId?: number | null; locationId?: number | null }) => {
        setLodgingFocus(focus.hotelId == null && focus.locationId != null
            ? { locationId: Number(focus.locationId) }
            : { hotelId: Number(focus.hotelId), roomId: focus.roomId != null ? Number(focus.roomId) : null });
        setView('assignment');
    };
    // «Pagos de cuotas» opened at one part (2.18.0): the dashboard's «Pagos por validar» card → the queue; a
    // person's «Ver sus pagos» → «Pagos» filtered to them. Consumed once, like the lodging focus.
    const [feesFocus, setFeesFocus] = useState<{ section: string; inscriptionId?: number } | null>(null);
    const openFees = (focus: { section: string; inscriptionId?: number }) => { setFeesFocus(focus); setView('fees'); };

    // Cuando se selecciona una conferencia, cambiar a dashboard (o a la primera vista que permita el rol)
    const handleManageConference = (conference: Conference) => {
        setCurrentConference(conference);
        setView(viewAllowed('dashboard', perms) ? 'dashboard' : firstView);
    };

    // Cuando se cambia de vista, asegurar que hay una conferencia seleccionada («Equipo y permisos» no la
    // necesita: es del plugin entero).
    useEffect(() => {
        if (!loading && view !== 'list' && view !== 'staff' && !currentConference) {
            setView('list');
        }
    }, [view, currentConference, loading]);

    // A view the role may not open is never drawn, not even for one render.
    const shown: View = viewAllowed(view, perms) ? view : firstView;
    const openStaff = perms.isAdmin ? () => setView('staff') : undefined;

    // A phone shows three of the twelve tabs: bring the active one into the strip's view, clear of its edge
    // fade (after a reload the saved «Campos» was off-screen; tapped at the edge it stayed under the fade).
    // Scrolls the strip only, never the page.
    const tabStripRef = useRef<HTMLDivElement | null>(null);
    useRevealActive(tabStripRef, '[aria-current="page"]', [shown, !!currentConference]);
    // Which sides of the strip have more tabs: it fades out there (lib/phoneLayout.ts TAB_STRIP_CSS).
    const stripMore = useStripOverflow(tabStripRef, [shown, !!currentConference]);

    if (shown === 'list') {
        return <ConferenceList onManage={handleManageConference} onOpenStaff={openStaff} />;
    }

    // «Equipo y permisos» without a conference selected (no conference yet, or opened from the list).
    if (shown === 'staff' && !currentConference) {
        return (
            <div className="h-full overflow-auto p-6">
                <button type="button" onClick={() => setView('list')} className="mb-4 text-gray-400 hover:text-gray-600 transition-colors inline-flex items-center gap-2 text-sm font-bold">
                    <i className="fa-solid fa-arrow-left"></i>{tx('staff.back.list', 'Volver a los congresos')}
                </button>
                <StaffPage />
            </div>
        );
    }

    if (!currentConference) {
        return <ConferenceList onManage={handleManageConference} onOpenStaff={openStaff} />;
    }

    const tabs = [
        { name: t('dashboard'), view: 'dashboard' as View, icon: 'fa-chart-pie' },
        { name: t('inscriptions'), view: 'inscriptions' as View, icon: 'fa-users' },
        { name: tx('fees.title', 'Pagos de cuotas'), view: 'fees' as View, icon: 'fa-file-invoice-dollar' },
        { name: t('accounting') || 'Contabilidad', view: 'accounting' as View, icon: 'fa-scale-balanced' },
        { name: consentT(language)('admin.tab'), view: 'consent' as View, icon: 'fa-file-signature' },
        { name: t('lodging'), view: 'lodging' as View, icon: 'fa-bed' },
        { name: t('transport') || 'Transporte', view: 'transport' as View, icon: 'fa-bus' },
        { name: t('meals') || 'Alimentación', view: 'meals' as View, icon: 'fa-utensils' },
        { name: tx('badges.title', 'Escarapelas'), view: 'badges' as View, icon: 'fa-id-badge' },
        { name: t('locations'), view: 'locations' as View, icon: 'fa-map-marker-alt' },
        { name: t('assignment'), view: 'assignment' as View, icon: 'fa-wand-magic-sparkles' },
        { name: t('fields'), view: 'fields' as View, icon: 'fa-list-check' },
        { name: t('pricing') || 'Precios', view: 'pricing' as View, icon: 'fa-tags' },
        { name: t('reports'), view: 'reports' as View, icon: 'fa-file-lines' },
        { name: tx('staff', 'Equipo y permisos'), view: 'staff' as View, icon: 'fa-user-shield' },
    ].filter(tab => viewAllowed(tab.view, perms));

    // On a phone (lib/phoneLayout.ts SHELL_CSS) the shell takes its natural height and scrolls with the page;
    // from 768 px wide and 600 px high it stays the fixed panel below.
    return (
        <div className="h-full flex flex-col overflow-hidden" data-cm-shell="">
            <style>{SHELL_CSS}</style>
            <div className="flex-shrink-0 p-6 pb-0" data-cm-shell-head="">
                <div className="mb-8">
                    <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                        <div>
                            <div className="flex items-center gap-3 mb-2">
                                {/* 44 px and named (it was a bare 14 × 24 px icon): back to the conference list. */}
                                <button
                                    type="button"
                                    onClick={() => setView('list')}
                                    aria-label={tx('staff.back.list', 'Volver a los congresos')}
                                    title={tx('staff.back.list', 'Volver a los congresos')}
                                    className="w-11 h-11 -ml-3 shrink-0 inline-flex items-center justify-center rounded-xl text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                                    data-cm-back=""
                                >
                                    <i className="fa-solid fa-arrow-left" aria-hidden="true"></i>
                                </button>
                                <h1 className="text-2xl font-bold text-gray-900">{t('conference.manager')}</h1>
                            </div>
                            <p className="text-gray-500">{t('conference.manager.description')}</p>
                        </div>
                        <div className="flex items-center gap-4">
                            <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-200">
                                <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">{t('conference')}:</span>
                                <span className="text-sm font-bold text-gray-900">{currentConference.name}</span>
                            </div>
                        </div>
                    </div>
                </div>

                <style>{TAB_STRIP_CSS}</style>
                <div ref={tabStripRef} className="flex border-b border-gray-200 mb-6 overflow-x-auto" data-cm-shell-tabs=""
                    {...stripMoreAttrs(stripMore)}>
                    {tabs.map((tab) => {
                        const isActive = shown === tab.view;
                        return (
                            <button
                                key={tab.view}
                                onClick={() => setView(tab.view)}
                                aria-current={isActive ? 'page' : undefined}
                                className={`flex items-center gap-2 px-6 py-3 border-b-2 font-medium text-sm transition-colors whitespace-nowrap
                                    ${isActive
                                        ? 'border-blue-600 text-blue-600'
                                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                                    }`}
                            >
                                <i className={`fa-solid ${tab.icon}`}></i>
                                {tab.name}
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="flex-1 px-6 pb-6 overflow-hidden min-h-0" data-cm-shell-body="">
                <div className="h-full bg-white rounded-xl shadow-sm border border-gray-200 p-6 overflow-auto flex flex-col" data-cm-shell-panel="">
                    {shown === 'dashboard' && <ConferenceDashboard conferenceId={currentConference.id} onNavigate={setView} onOpenFees={openFees} />}
                    {shown === 'inscriptions' && <InscriptionsPage conferenceId={currentConference.id} onSeePayments={viewAllowed('fees', perms) ? (p) => openFees({ section: 'transfers', inscriptionId: p.id }) : undefined} />}
                    {shown === 'fees' && <FeePaymentsPage conferenceId={currentConference.id} slug={currentConference.slug} focus={feesFocus} onFocusConsumed={() => setFeesFocus(null)}
                        onOpenAccounting={viewAllowed('accounting', perms) ? () => setView('accounting') : undefined} />}
                    {shown === 'lodging' && <LodgingPage conferenceId={currentConference.id} onOpenExplorer={openLodgingExplorer} />}
                    {shown === 'transport' && <TransportPage conferenceId={currentConference.id} slug={currentConference.slug} />}
                    {shown === 'meals' && <MealsPage conferenceId={currentConference.id} slug={currentConference.slug} conference={currentConference} />}
                    {shown === 'consent' && <ConsentAdmin conferenceId={currentConference.id} />}
                    {shown === 'badges' && <BadgesPage conferenceId={currentConference.id} conference={currentConference} />}
                    {shown === 'accounting' && <AccountingPage conferenceId={currentConference.id} slug={currentConference.slug} onOpenFees={viewAllowed('fees', perms) ? () => setView('fees') : undefined} />}
                    {shown === 'locations' && <LocationsPage conferenceId={currentConference.id} onOpenExplorer={viewAllowed('assignment', perms) ? openLodgingExplorer : undefined} />}
                    {shown === 'assignment' && <AssignmentPage conferenceId={currentConference.id} focus={lodgingFocus} onFocusConsumed={() => setLodgingFocus(null)} />}
                    {shown === 'fields' && <FieldsPage conferenceId={currentConference.id} />}
                    {shown === 'pricing' && <PricingPage conferenceId={currentConference.id} />}
                    {shown === 'reports' && <ReportsPage conferenceId={currentConference.id} />}
                    {shown === 'staff' && <StaffPage />}
                </div>
            </div>
        </div>
    );
}

/**
 * The page root (2.15.0): GET /staff/me first. While it loads, the usual spinner; a signed-in WordJS user
 * who is neither an administrator nor on the team (or whose role opens nothing) gets a friendly screen
 * instead of a page of 403s. Everyone else gets the admin, filtered by their role.
 */
function PermsGate() {
    const perms = usePerms();
    const tx = useTx();
    if (perms.loading) {
        return (
            <div className="text-center py-20">
                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-gray-500">{tx('loading', 'Cargando...')}</p>
            </div>
        );
    }
    if (perms.error) {
        return (
            <div className="max-w-lg mx-auto text-center py-20 px-6 space-y-4" role="alert">
                <i className="fa-solid fa-triangle-exclamation text-3xl text-rose-400"></i>
                <p className="text-sm font-bold text-rose-700">{tx('perm.load.failed', 'No se pudieron cargar tus permisos.')}</p>
                <p className="text-xs text-gray-500">{perms.error}</p>
                <button type="button" onClick={perms.reload} className="px-6 py-3 rounded-2xl bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400 font-black text-[10px] uppercase tracking-widest">{tx('staff.retry', 'Reintentar')}</button>
            </div>
        );
    }
    // Why there is nothing to show (2.16.0): no WordJS team role, not on the team, deactivated, or a team
    // role that opens no section — each says what to ask the administrator for.
    const reason = noAccessReason(perms, hasAnySection(perms));
    if (reason) {
        const text = NO_ACCESS_TEXT[reason];
        return (
            <div className="max-w-xl mx-auto text-center py-20 px-6" data-no-access={reason}>
                <div className="w-20 h-20 shrink-0 mx-auto mb-6 rounded-3xl bg-gray-50 border border-gray-100 flex items-center justify-center text-gray-300 text-3xl">
                    <i className="fa-solid fa-user-lock"></i>
                </div>
                <h2 className="text-2xl font-black text-gray-900 italic tracking-tighter mb-3">{tx('perm.noaccess.title', 'Sin acceso')}</h2>
                <p className="text-base font-medium text-gray-600 leading-relaxed">{tx(text.key, text.fallback)}</p>
            </div>
        );
    }
    return (
        <ConferenceProvider>
            <ConferenceManagerContent />
        </ConferenceProvider>
    );
}

// Conference List Component
function ConferenceList({ onManage, onOpenStaff }: { onManage: (conf: Conference) => void; onOpenStaff?: () => void }) {
    const { conferences, refreshConferences, loading: confLoading } = useConference();
    const { t, language } = useI18n();
    const fe = useFieldErrors(language);
    const tx = useTx();
    const { addToast } = useToast();
    // Creating / deleting a conference is Configuración › gestionar; the per-card counts are read only
    // from the sections the role may see (no request is made just to be refused).
    const perms = usePerms();
    const canManageSettings = perms.can('settings', 'manage');
    // A Pagos-only role does not read the roster (D-P20): it counts the people of «Pagos de cuotas» instead.
    const countPeopleVia = canReadRoster(perms) ? 'roster' : perms.can('payments') ? 'fees' : null;
    const canCountPeople = countPeopleVia != null;
    const canCountHotels = canReadHotels(perms);
    const [loading, setLoading] = useState(true);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [newConference, setNewConference] = useState({
        name: '',
        slug: '',
        date_start: '',
        date_end: '',
        fee_default: 0
    });
    const [creating, setCreating] = useState(false);
    const [deleting, setDeleting] = useState<number | null>(null);
    const [conferenceStats, setConferenceStats] = useState<Record<number, {
        inscriptions: number;
        hotels: number;
        rooms: number;
    }>>({});

    useEffect(() => {
        const loadStats = async () => {
            const stats: Record<number, { inscriptions: number; hotels: number; rooms: number }> = {};

            for (const conf of conferences) {
                try {
                    const [inscriptions, hotels] = await Promise.all([
                        countPeopleVia === 'roster' ? conferenceApi.getInscriptions(conf.id).catch(() => [])
                            : countPeopleVia === 'fees' ? feePaymentsApi.getView(conf.id).then((v: any) => (Array.isArray(v?.people) ? v.people : []), () => [])
                            : Promise.resolve([]),
                        canCountHotels ? conferenceApi.getHotels(conf.id).catch(() => []) : Promise.resolve([])
                    ]);

                    stats[conf.id] = {
                        inscriptions: inscriptions.length,
                        hotels: hotels.length,
                        rooms: hotels.reduce((sum, h) => sum + (h.rooms?.length || 0), 0)
                    };
                } catch (error) {
                    stats[conf.id] = { inscriptions: 0, hotels: 0, rooms: 0 };
                }
            }

            setConferenceStats(stats);
            setLoading(false);
        };

        if (conferences.length > 0) {
            loadStats();
        } else {
            setLoading(false);
        }
    }, [conferences]);

    const generateSlug = (name: string) => {
        return name
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    };

    const { confirm } = useModal();

    const handleCreateConference = async (e: React.FormEvent) => {
        e.preventDefault();
        setCreating(true);
        try {
            await conferenceApi.createConference({ ...newConference, fee_default: Number(newConference.fee_default) || 0 });
            await refreshConferences();
            setShowCreateModal(false);
            setNewConference({ name: '', slug: '', date_start: '', date_end: '', fee_default: 0 });
            addToast(t('conference.created') || 'Conferencia creada', 'success');
        } catch (error: any) {
            addToast(error.message || 'Error creating conference', 'error');
        } finally {
            setCreating(false);
        }
    };

    const handleDeleteConference = async (id: number) => {
        if (!await confirm(t('confirm.delete.conference'), t('delete'), true)) {
            return;
        }

        setDeleting(id);
        try {
            await conferenceApi.deleteConference(id);
            await refreshConferences();
            addToast(t('conference.deleted') || 'Conferencia eliminada', 'success');
        } catch (error: any) {
            addToast(error.message || 'Error deleting conference', 'error');
        } finally {
            setDeleting(null);
        }
    };

    if (loading) {
        return (
            <div className="text-center py-20">
                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-gray-500">{t('loading')}</p>
            </div>
        );
    }

    return (
        <div className="p-10 max-sm:px-4 max-sm:py-6 space-y-10 animate-in fade-in duration-500">
            <div className="flex flex-wrap justify-between items-end gap-4 mb-8">
                <div>
                    <h2 className="text-4xl font-black text-gray-900 italic tracking-tighter mb-2">{t('conference.list')}</h2>
                    <p className="text-sm font-bold text-gray-500 uppercase tracking-widest">{t('conference.manager.description')}</p>
                </div>
                {onOpenStaff && (
                    <button
                        type="button"
                        onClick={onOpenStaff}
                        className="px-6 py-3 bg-white border-2 border-gray-100 hover:border-indigo-500 hover:text-indigo-600 text-gray-700 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2"
                    >
                        <i className="fa-solid fa-user-shield"></i>{tx('staff', 'Equipo y permisos')}
                    </button>
                )}
            </div>

            {!confLoading && !canManageSettings && conferences.length === 0 && (
                <div className="text-center py-16 px-6 bg-gray-50/50 border-2 border-dashed border-gray-100 rounded-3xl">
                    <i className="fa-solid fa-calendar-xmark text-3xl text-gray-300 mb-3"></i>
                    <p className="text-sm font-bold text-gray-500">{tx('perm.no.conferences', 'Todavía no hay congresos. Un administrador debe crearlos.')}</p>
                </div>
            )}

            {/* Columns follow the space the page really has (the admin sidebar takes a share of the window),
                not the window width: viewport breakpoints squeezed three cards into ~180px and the text ran out. */}
            <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 18rem), 1fr))' }}>
                {/* Nueva Conferencia Card - Premium (Configuración › gestionar) */}
                {canManageSettings && <div
                    onClick={() => setShowCreateModal(true)}
                    className="group bg-gradient-to-br from-blue-600 to-indigo-700 rounded-[40px] p-8 flex flex-col items-center justify-center text-white hover:shadow-2xl hover:shadow-blue-500/40 hover:-translate-y-2 transition-all duration-500 cursor-pointer min-h-[320px] relative overflow-hidden ring-4 ring-white ring-offset-4 ring-offset-gray-50"
                >
                    <div className="absolute top-0 right-0 w-64 h-64 bg-white opacity-5 rounded-full blur-[80px] group-hover:blur-[60px] transition-all duration-700"></div>
                    <div className="absolute bottom-0 left-0 w-48 h-48 bg-purple-500 opacity-20 rounded-full blur-[60px]"></div>

                    <div className="relative z-10 flex flex-col items-center">
                        <div className="w-20 h-20 shrink-0 rounded-3xl bg-white/10 backdrop-blur-md flex items-center justify-center mb-6 shadow-inner border border-white/20 group-hover:scale-110 group-hover:bg-white/20 transition-all duration-500">
                            <i className="fa-solid fa-plus text-3xl"></i>
                        </div>
                        <span className="font-black text-2xl italic tracking-tight">{t('create.conference')}</span>
                        {/* White: blue-200 on this blue→indigo gradient was 3.7–4.7:1 (AA asks 4.5:1 for text this size). */}
                        <span className="mt-2 text-xs font-bold uppercase tracking-widest text-white" data-create-subtitle="">{tx('conference.create.start', 'Comenzar nuevo evento')}</span>
                    </div>
                </div>}

                {/* Conference Cards */}
                {conferences.map(conf => {
                    const stats = conferenceStats[conf.id] || { inscriptions: 0, hotels: 0, rooms: 0 };
                    const isDeleting = deleting === conf.id;

                    return (
                        <div
                            key={conf.id}
                            className={`
                                group bg-white rounded-[40px] p-8 shadow-sm hover:shadow-2xl hover:-translate-y-2 transition-all duration-500 relative flex flex-col justify-between min-h-[320px] overflow-hidden border-2
                                ${conf.status === 'active' ? 'border-emerald-100 hover:border-emerald-500 shadow-emerald-100/50' :
                                    conf.status === 'draft' ? 'border-gray-100 hover:border-gray-400 shadow-gray-100/50' :
                                        'border-orange-100 hover:border-orange-500 shadow-orange-100/50'}
                            `}
                        >
                            {/* Decorative background element - Status Based */}
                            <div className={`absolute top-0 right-0 -mr-16 -mt-16 w-48 h-48 rounded-full opacity-0 group-hover:opacity-100 transition-opacity blur-[60px] duration-700 pointer-events-none
                                ${conf.status === 'active' ? 'bg-emerald-100' :
                                    conf.status === 'draft' ? 'bg-gray-100' :
                                        'bg-orange-100'}
                            `}></div>

                            <div>
                                <div className="flex items-start justify-between mb-8 relative z-10">
                                    <div className={`w-16 h-16 rounded-3xl flex items-center justify-center text-2xl shrink-0 transition-all duration-500 shadow-inner group-hover:scale-110
                                        ${conf.status === 'active' ? 'bg-emerald-50 text-emerald-600' :
                                            conf.status === 'draft' ? 'bg-gray-50 text-gray-500' :
                                                'bg-orange-50 text-orange-600'}
                                    `}>
                                        <i className={`fa-solid ${conf.status === 'active' ? 'fa-satellite-dish' : 'fa-box-archive'}`}></i>
                                    </div>
                                    <div className="flex gap-2">
                                        {canManageSettings && <button
                                            onClick={(e) => { e.stopPropagation(); handleDeleteConference(conf.id); }}
                                            aria-label={t('delete')} title={t('delete')}
                                            className="w-10 h-10 shrink-0 flex items-center justify-center rounded-2xl text-gray-500 hover:bg-rose-50 hover:text-rose-600 transition-all duration-300 transform opacity-100 translate-x-0 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:translate-x-4 group-hover:opacity-100 group-hover:translate-x-0 focus-visible:opacity-100 focus-visible:translate-x-0"
                                            disabled={isDeleting}
                                        >
                                            {isDeleting ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-trash-can"></i>}
                                        </button>}
                                    </div>
                                </div>

                                <div className="relative z-10">
                                    <h3 className="font-black text-3xl text-gray-900 leading-tight mb-3 italic tracking-tighter group-hover:underline decoration-4 underline-offset-4 decoration-transparent group-hover:decoration-current transition-all" style={{ overflowWrap: 'anywhere' }}>
                                        {conf.name}
                                    </h3>

                                    <div className="flex flex-wrap gap-2 mb-6">
                                        <span className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest border ${conf.status === 'active' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' :
                                            conf.status === 'draft' ? 'bg-gray-50 text-gray-600 border-gray-100' :
                                                'bg-orange-50 text-orange-700 border-orange-100'
                                            }`}>
                                            {t(conf.status)}
                                        </span>
                                        {conf.date_start && (
                                            <span className="bg-white border border-gray-100 text-gray-500 px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase flex items-center gap-1.5">
                                                <i className="fa-solid fa-calendar-day text-gray-300"></i>
                                                {new Date(conf.date_start).toLocaleDateString()}
                                            </span>
                                        )}
                                    </div>

                                    {conf.description && (
                                        <p className="text-sm text-gray-500 font-medium line-clamp-2 mb-4 leading-relaxed">{conf.description}</p>
                                    )}
                                </div>
                            </div>

                            {/* Wraps: in a narrow card (three columns beside the sidebar) «Estadísticas» and «Gestionar»
                                did not fit side by side and the button ran into the label and out of the card. */}
                            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 mt-auto relative z-10 pt-6 border-t border-gray-50" data-card-footer="">
                                <div className={`space-y-1.5 ${canCountPeople || canCountHotels ? '' : 'invisible'}`}>
                                    <div className="text-gray-500 text-[9px] font-black uppercase tracking-[0.2em] whitespace-nowrap" data-card-stats-label="">{t('stats') || 'ESTADISTICAS'}</div>
                                    <div className="flex items-center gap-4 text-xs font-bold text-gray-600">
                                        {canCountPeople && <span className="flex items-center gap-1.5" title={t('inscription.plural')}>
                                            <i className="fa-solid fa-users text-blue-400"></i>
                                            {stats.inscriptions}
                                        </span>}
                                        {canCountHotels && <span className="flex items-center gap-1.5" title={t('hotels')}>
                                            <i className="fa-solid fa-bed text-indigo-400"></i>
                                            {stats.hotels}
                                        </span>}
                                    </div>
                                </div>

                                <button
                                    onClick={() => onManage(conf)}
                                    className="ml-auto shrink-0 whitespace-nowrap px-6 py-3 bg-gray-900 text-white text-[10px] font-black uppercase tracking-widest rounded-2xl hover:bg-blue-600 hover:shadow-xl hover:shadow-blue-500/30 transition-all duration-300 flex items-center gap-2 transform active:scale-95"
                                >
                                    {t('manage')} <i className="fa-solid fa-arrow-right-long text-[10px]"></i>
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Create Conference Modal */}
            {showCreateModal && (
                <Overlay layer={1}>
                    <div className="bg-white rounded-t-[32px] sm:rounded-[40px] shadow-2xl w-full max-w-lg border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-6 py-5 sm:px-10 sm:py-8 border-b border-gray-100 flex items-center justify-between">
                            <div>
                                <h3 className="font-black text-2xl text-gray-900 italic tracking-tighter">{t('create.conference')}</h3>
                                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">Configura tu nuevo evento</p>
                            </div>
                            <button
                                onClick={() => setShowCreateModal(false)}
                                className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-2xl"
                            >
                                <i className="fa-solid fa-xmark text-xl"></i>
                            </button>
                        </div>
                        <form {...fe.form(handleCreateConference)} className="p-6 sm:p-10 space-y-4 sm:space-y-6">
                            <div className="space-y-2">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">
                                    {t('conference.name')} *
                                </label>
                                <input
                                    data-field="conference_name" aria-invalid={fe.invalid('conference_name')} aria-describedby={fe.describedBy('conference_name')}
                                    required
                                    type="text"
                                    className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-300"
                                    value={newConference.name}
                                    onChange={(e) => {
                                        const name = e.target.value;
                                        setNewConference({
                                            ...newConference,
                                            name,
                                            slug: generateSlug(name)
                                        });
                                    }}
                                    placeholder="e.g. Conferencia Anual 2024"
                                    autoFocus={canAutoFocus()}
                                />
                                <FieldError message={fe.error('conference_name')} id={fe.errorId('conference_name')} />
                            </div>
                            <div className="space-y-2">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('conference.slug')} *</label>
                                <div className="relative">
                                    <input
                                        data-field="conference_slug" aria-invalid={fe.invalid('conference_slug')} aria-describedby={fe.describedBy('conference_slug')}
                                        required
                                        type="text"
                                        className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-mono text-base sm:text-sm pl-4"
                                        value={newConference.slug}
                                        onChange={(e) => setNewConference({ ...newConference, slug: e.target.value })}
                                        placeholder="conferencia-anual-2024"
                                    />
                                    <i className="fa-solid fa-link absolute right-4 top-1/2 -translate-y-1/2 text-gray-300"></i>
                                </div>
                                <p className="text-[10px] text-gray-400 italic ml-1">{t('slug.help')}</p>
                                <FieldError message={fe.error('conference_slug')} id={fe.errorId('conference_slug')} />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('conference.start.date')}</label>
                                    <div className="relative">
                                        <DateField withTime ariaLabel={t('conference.start.date')} value={newConference.date_start}
                                            onChange={(v) => setNewConference({ ...newConference, date_start: v })} />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('conference.end.date')}</label>
                                    <div className="relative">
                                        <DateField withTime ariaLabel={t('conference.end.date')} value={newConference.date_end} min={newConference.date_start || undefined}
                                            onChange={(v) => setNewConference({ ...newConference, date_end: v })} />
                                    </div>
                                </div>
                            </div>
                            <div className="space-y-2">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('conference.default.fee')}</label>
                                <div className="relative">
                                    <span className="absolute left-6 top-1/2 -translate-y-1/2 text-gray-400 font-black text-lg">$</span>
                                    <input
                                        data-field="conference_fee" aria-invalid={fe.invalid('conference_fee')} aria-describedby={fe.describedBy('conference_fee')}
                                        type="number"
                                        step="0.01"
                                        className="w-full border-2 border-gray-100 rounded-2xl px-12 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-black text-lg"
                                        value={newConference.fee_default ?? ''}
                                        onChange={(e) => setNewConference({ ...newConference, fee_default: (e.target.value === '' ? '' : Number(e.target.value)) as any })}
                                        placeholder="0.00"
                                    />
                                </div>
                                <FieldError message={fe.error('conference_fee')} id={fe.errorId('conference_fee')} />
                            </div>
                            <div className="pt-6 flex gap-4 border-t border-gray-50" data-cm-sheet-foot="">
                                <button
                                    type="button"
                                    onClick={() => setShowCreateModal(false)}
                                    className="flex-1 px-6 py-4 text-gray-400 font-black text-[10px] uppercase tracking-widest hover:bg-gray-100 rounded-xl transition-all"
                                >
                                    {t('cancel')}
                                </button>
                                <button
                                    type="submit"
                                    disabled={creating}
                                    className="flex-[2] px-8 py-4 bg-gray-900 text-white font-black text-[10px] uppercase tracking-widest rounded-xl shadow-xl shadow-gray-200 hover:shadow-blue-500/30 hover:bg-blue-600 transition-all transform active:scale-95 disabled:opacity-50"
                                >
                                    {creating ? t('creating') : t('create.conference')}
                                </button>
                            </div>
                        </form>
                    </div>
                </Overlay>
            )}
        </div>
    );
}

// Dashboard Component
function ConferenceDashboard({ conferenceId, onNavigate, onOpenFees }: { conferenceId: number, onNavigate: (view: View) => void, onOpenFees?: (focus: { section: string }) => void }) {
    const { currentConference } = useConference();
    const { t } = useI18n(); // Get t() function
    const tx = useTx();
    // A card whose source the role may not read shows «—» instead of a misleading 0, and the shortcuts
    // only lead to views the role may open.
    const perms = usePerms();
    const canOpen = (v: View) => viewAllowed(v, perms);
    const [stats, setStats] = useState<any>({
        inscriptions: 0,
        hotels: 0,
        rooms: 0,
        paid: 0,
        unpaid: 0,
        lodgingToValidate: 0,
        feesPending: null as null | { n: number; cents: number },
    });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!conferenceId) return;

        const loadStats = async () => {
            try {
                // null = that source could not be read (e.g. a 403 for a role without the section).
                const [inscriptions, hotels, locData, fees] = await Promise.all([
                    conferenceApi.getInscriptions(conferenceId).catch(() => null),
                    conferenceApi.getHotels(conferenceId).catch(() => null),
                    conferenceApi.getLocations(conferenceId).catch(() => null),
                    // «Pagos por validar» (2.18.0): only for a role that may open «Pagos de cuotas».
                    viewAllowed('fees', perms) ? feePaymentsApi.getView(conferenceId).catch(() => null) : Promise.resolve(null),
                ]);
                const na = '—';

                // 2.18.0, the per-person model of «Pagos de cuotas» (and «Reportes»): «Pagados» = ACTIVE people whose
                // validated money covers the fee (a cancelled inscription owes nothing and is counted nowhere);
                // «Con saldo» = active people with something NO payment covers yet — money that is only awaiting
                // validation does not count as owed. The same figure as «Pagos de cuotas › Saldos › Con saldo».
                const paid = inscriptions ? inscriptions.filter(i => { const b = personBalance(i); return !b.cancelled && b.state === 'paid'; }).length : na;
                const unpaid = inscriptions ? inscriptions.filter(i => personBalance(i).toCover > 0).length : na;
                const pendingTransfers = fees ? (fees.transfers || []).filter((x: any) => x.status === 'pending') : null;
                const totalRooms = hotels ? hotels.reduce((sum, h) => sum + (h.rooms?.length || 0), 0) : na;
                // Locations whose coordinator sent the lodging and is waiting for the admin's validation.
                const lodgingToValidate = locData ? (locData.locations || []).filter(l => l.lodging_status === 'submitted').length : na;

                setStats({
                    inscriptions: inscriptions ? inscriptions.length : na,
                    hotels: hotels ? hotels.length : na,
                    rooms: totalRooms,
                    paid,
                    unpaid,
                    lodgingToValidate,
                    feesPending: pendingTransfers ? { n: pendingTransfers.length, cents: pendingTransfers.reduce((sum: number, x: any) => sum + toCents(x.amount), 0) } : null,
                });
            } catch (error) {
                console.error('Failed to load stats:', error);
            } finally {
                setLoading(false);
            }
        };

        loadStats();
    }, [conferenceId]);

    if (loading) {
        return (
            <div className="text-center py-20">
                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-gray-500">{t('loading.stats')}</p>
            </div>
        );
    }

    if (!currentConference) return null;

    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            {/* Premium Header Banner */}
            <div className="relative overflow-hidden bg-white rounded-3xl p-8 border border-gray-100 shadow-xl shadow-gray-100/50">
                <div className="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 bg-blue-50/50 rounded-full blur-3xl"></div>
                <div className="absolute bottom-0 left-0 -ml-16 -mb-16 w-48 h-48 bg-indigo-50/50 rounded-full blur-3xl"></div>

                <div className="relative flex flex-wrap items-center justify-between gap-6">
                    <div className="min-w-0">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 shrink-0 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-200">
                                <i className="fa-solid fa-gauge-high"></i>
                            </div>
                            <span className="text-[10px] font-bold text-blue-600 uppercase tracking-[0.2em]">{t('dashboard')}</span>
                        </div>
                        <h2 className="text-4xl font-black text-gray-900 italic tracking-tighter mb-2">{currentConference.name}</h2>

                        <div className="flex flex-wrap items-center gap-4">
                            {currentConference.date_start && (
                                <div className="flex items-center gap-2 bg-gray-50 px-3 py-1.5 rounded-full border border-gray-100">
                                    <i className="fa-solid fa-calendar text-blue-500 text-xs text-center w-4"></i>
                                    <span className="text-xs font-bold text-gray-600">
                                        {new Date(currentConference.date_start).toLocaleDateString()}
                                        {currentConference.date_end && ` - ${new Date(currentConference.date_end).toLocaleDateString()}`}
                                    </span>
                                </div>
                            )}
                            {/* The status in the admin's language (it showed the raw «ACTIVE»), like the conference list,
                                in colours that meet WCAG AA on their tint (the -600 shades did not). */}
                            <div className={`px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border-2 shadow-sm ${currentConference.status === 'active' ? 'bg-emerald-50 text-emerald-700 border-emerald-100' :
                                currentConference.status === 'draft' ? 'bg-gray-50 text-gray-600 border-gray-100' :
                                    'bg-amber-50 text-amber-700 border-amber-100'
                                }`} data-cm-conference-status={currentConference.status}>
                                {t(currentConference.status)}
                            </div>
                        </div>
                    </div>

                    {canOpen('fields') && <div className="flex items-center gap-3">
                        <button
                            onClick={() => onNavigate('fields')}
                            className="px-6 py-3 bg-white border-2 border-gray-100 hover:border-blue-500 hover:text-blue-600 transition-all rounded-2xl text-xs font-black uppercase tracking-widest flex items-center gap-2 group"
                        >
                            <i className="fa-solid fa-pen-to-square group-hover:scale-110 transition-transform"></i>
                            Configurar Registro
                        </button>
                    </div>}
                </div>
            </div>

            {/* Stats Grid — as many columns as fit cards of 15rem (icon, gap and a label like «INSCRIPCIONES»).
                It was xl:grid-cols-6 by the WINDOW's width: at 1280 px the panel beside the sidebar is ~860 px,
                six cards of ~120 px squeezed the icons into pills and clipped the labels («INSCRIP», «HOTELE»). */}
            <div className={STAT_GRID_CLASS} data-cm-stat-grid="">
                <StatCard icon="fa-users" label={t('inscriptions')} value={stats.inscriptions} color="blue" />
                <StatCard icon="fa-bed" label={t('hotels')} value={stats.hotels} color="purple" />
                <StatCard icon="fa-door-open" label={t('rooms')} value={stats.rooms} color="indigo" />
                <StatCard icon="fa-circle-check" label={t('paid')} value={stats.paid} color="green" />
                <StatCard icon="fa-circle-xmark" label={tx('fees.balances.owing', 'Con saldo')} value={stats.unpaid} color="red" />
                <StatCard icon="fa-clipboard-check" label={t('lodging.pending.validation') || 'Hospedajes por validar'} value={stats.lodgingToValidate} color={Number(stats.lodgingToValidate) > 0 ? 'orange' : 'gray'} onClick={canOpen('locations') ? () => onNavigate('locations') : undefined} />
                {stats.feesPending && <StatCard icon="fa-file-invoice-dollar" label={tx('fees.dashboard.pending', 'Pagos por validar')}
                    value={stats.feesPending.n ? `${stats.feesPending.n} · ${feeMoney(stats.feesPending.cents)}` : 0}
                    color={stats.feesPending.n > 0 ? 'orange' : 'gray'} onClick={onOpenFees ? () => onOpenFees({ section: 'queue' }) : undefined} />}
            </div>

            {/* Actions Grid — only the shortcuts to views the role may open */}
            {(canOpen('inscriptions') || canOpen('lodging') || canOpen('reports')) && <div className="space-y-6 pt-2">
                <div className="flex items-center gap-3">
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-gray-200 to-transparent"></div>
                    <h3 className="text-[10px] font-black text-gray-400 uppercase tracking-[0.3em] whitespace-nowrap">{t('quick.actions')}</h3>
                    <div className="h-px flex-1 bg-gradient-to-r from-transparent via-gray-200 to-transparent"></div>
                </div>

                <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 15rem), 1fr))' }}>
                    {canOpen('inscriptions') && <ActionCard
                        icon="fa-user-plus"
                        title={t('register.participant')}
                        description={t('new.inscription.desc')}
                        onClick={() => onNavigate('inscriptions')}
                        color="blue"
                    />}
                    {canOpen('lodging') && <ActionCard
                        icon="fa-bed"
                        title={t('manage.lodging')}
                        description={t('manage.lodging.desc')}
                        onClick={() => onNavigate('lodging')}
                        color="purple"
                    />}
                    {canOpen('reports') && <ActionCard
                        icon="fa-file-lines"
                        title={t('view.reports')}
                        description={t('view.reports.desc')}
                        onClick={() => onNavigate('reports')}
                        color="green"
                    />}
                </div>
            </div>}
        </div>
    );
}

// StatCard is imported from global ui components

// ActionCard is imported from global ui components


// Inscriptions Component
// The registration form is the source of truth: attendee data lives in real columns named after each
// field (with a custom_data fallback for legacy rows). fieldVal / personDisplayName read a field's value
// and build a display name — both live in lib/lodgingView.ts (shared with the lodging explorer).
// Registration-code viewer (admin-only): the QR of an attendee's reg_code (2.22.0; Code 128 before), with
// print, SVG download and copy. The SVG is generated locally from a code of a fixed alphabet (escaped anyway).
function BarcodeModal({ code, name, onClose, conferenceId }: { code: string; name: string; onClose: () => void; conferenceId?: number }) {
    const { t } = useI18n();
    const { addToast } = useToast();
    // 2.23.0: the same QR as the badge — the «Mi inscripción» link with the code when the page is on.
    const [prefix, setPrefix] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        if (conferenceId) conferenceApi.qrLink(conferenceId).then(r => { if (alive) setPrefix(r && r.prefix ? r.prefix : null); }).catch(() => { /* the bare code */ });
        return () => { alive = false; };
    }, [conferenceId]);
    const svg = useMemo(() => { try { return qrSvg(prefix ? prefix + code : code, { module: prefix ? 6 : 8, showText: false }); } catch { return ''; } }, [code, prefix]);
    const print = () => {
        const w = window.open('', '_blank', 'width=520,height=360');
        if (!w) { addToast(t('reg.code.print') || 'Imprimir', 'error'); return; }
        w.document.open();
        w.document.write(`<!doctype html><html><head><title>${code}</title><style>body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif}h1{font-size:16px;margin:0 0 12px}</style></head><body><h1></h1>${svg}</body></html>`);
        w.document.close();
        const h1 = w.document.querySelector('h1');
        if (h1) h1.textContent = name; // text node, never markup
        w.focus();
        setTimeout(() => w.print(), 250);
    };
    const download = () => {
        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        const a = document.createElement('a');
        a.href = url; a.download = `codigo-${code}.svg`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const copy = async () => {
        try { await navigator.clipboard.writeText(code); addToast(t('reg.code.copied') || 'Código copiado', 'success'); }
        catch { addToast(code, 'info'); }
    };
    return (
        <Overlay layer={2} onBackdrop={onClose} onEscape={onClose}>
            <div className="bg-white rounded-[40px] shadow-2xl w-full max-w-lg border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
                <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <h3 className="font-black text-2xl text-gray-900 italic tracking-tighter">{t('reg.code.title') || 'Código de inscripción'}</h3>
                        <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1 truncate">{name}</p>
                    </div>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-2xl" aria-label="Cerrar">
                        <i className="fa-solid fa-xmark text-xl"></i>
                    </button>
                </div>
                <div className="p-8 flex flex-col items-center gap-5">
                    <div className="w-full overflow-x-auto flex justify-center bg-white rounded-2xl border border-gray-100 p-4" dangerouslySetInnerHTML={{ __html: svg }} />
                    <div className="font-mono text-2xl font-black tracking-[0.3em] text-gray-900">{code}</div>
                    <p className="text-[11px] text-gray-500"><i className="fa-solid fa-lock mr-1"></i>{t('reg.code.admin.only') || 'Solo visible para el administrador.'}</p>
                    <div className="flex flex-wrap justify-center gap-2">
                        <button onClick={print} className="px-5 py-3 rounded-2xl bg-blue-600 text-white hover:bg-blue-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-blue-500/30 transition-all"><i className="fa-solid fa-print mr-1.5"></i>{t('reg.code.print') || 'Imprimir'}</button>
                        <button onClick={download} className="px-5 py-3 rounded-2xl bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-500 hover:text-blue-600 font-black text-[10px] uppercase tracking-widest transition-all"><i className="fa-solid fa-download mr-1.5"></i>{t('reg.code.download') || 'Descargar QR (SVG)'}</button>
                        <button onClick={copy} className="px-5 py-3 rounded-2xl bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-500 hover:text-blue-600 font-black text-[10px] uppercase tracking-widest transition-all"><i className="fa-solid fa-copy mr-1.5"></i>{t('reg.code.copy') || 'Copiar código'}</button>
                    </div>
                </div>
            </div>
        </Overlay>
    );
}

// ── Excel exports (2.10.0) ───────────────────────────────────────────────────────────────────────────
// Everything is built in the browser from the admin's own API data (the sandbox can only answer JSON):
// client/lib/exports.ts shapes the sheets, client/lib/xlsx.ts writes the file, client/lib/qr.ts
// rasterises each registration code for the optional QR column.
async function downloadHotelReport(conferenceId: number, slug: string | undefined, onlyHotelId: number | null = null, withCodes = true) {
    const [hotels, people, fields, locs] = await Promise.all([
        conferenceApi.getHotels(conferenceId),
        conferenceApi.getInscriptions(conferenceId),
        conferenceApi.getFields(conferenceId),
        conferenceApi.getLocations(conferenceId),
    ]);
    const built = buildHotelReport({ hotels: hotels as any, people: people as any, fields: fields as any, locations: (locs.locations || []) as any, onlyHotelId });
    const sheets = withCodes ? built : withoutColumn(built, 'Código');
    const hotelName = onlyHotelId != null ? (hotels.find((h: any) => Number(h.id) === Number(onlyHotelId))?.name || 'hotel') : '';
    downloadXlsx(buildXlsx(sheets), exportFilename(onlyHotelId != null ? 'hotel-' + String(hotelName).toLowerCase() : 'hoteles', slug));
}

function ExcelExportModal({ conferenceId, slug, onClose }: { conferenceId: number; slug?: string; onClose: () => void }) {
    const { t } = useI18n();
    const tx = useTx();
    const { addToast } = useToast();
    // The registration codes reach the browser only with Inscripciones › ver: no barcode option without them.
    const canBarcode = usePerms().can('inscriptions');
    // «Condiciones de salud» (2.32.0): a column only for Datos de salud › ver (the rows carry it only then).
    const canHealth = usePerms().can('health');
    const storeKey = `cm:excel:${conferenceId}`;
    const [fields, setFields] = useState<ConferenceField[]>([]);
    const [people, setPeople] = useState<Inscription[]>([]);
    const [locs, setLocs] = useState<Location[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<string[]>([]);
    const [barcode, setBarcode] = useState(false);
    const [locationId, setLocationId] = useState('');
    const [paymentStatus, setPaymentStatus] = useState('');
    const [excludeCancelled, setExcludeCancelled] = useState(true);
    const [progress, setProgress] = useState<{ n: number; total: number } | null>(null);
    // Transport per attendee (bus names, ticket prices, transport payments) for the transport columns.
    const [transport, setTransport] = useState<Map<number, any>>(new Map());

    useEffect(() => {
        let alive = true;
        Promise.all([conferenceApi.getFields(conferenceId, { health: canHealth }), conferenceApi.getInscriptions(conferenceId), conferenceApi.getLocations(conferenceId), conferenceApi.getBuses(conferenceId).catch(() => [])])
            .then(([f, p, l, b]) => {
                if (!alive) return;
                setFields(f); setPeople(p); setLocs(l.locations || []); setTransport(transportByPerson((b || []) as any));
                const all = new Set(availableColumns(f as any).filter(c => canBarcode || c.key !== 'reg_code').map(c => c.key));
                let saved: any = null;
                try { saved = JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch { saved = null; }
                const keys = Array.isArray(saved?.columns) ? saved.columns.filter((k: string) => all.has(k)) : [];
                setSelected(keys.length ? keys : defaultColumnKeys(f as any).filter(k => all.has(k)));
                if (saved && typeof saved.barcode === 'boolean') setBarcode(saved.barcode);
            })
            .catch((e: any) => addToast(e?.message || 'Error', 'error'))
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [conferenceId]);

    const columns = useMemo(() => availableColumns(fields as any).filter(c => canBarcode || c.key !== 'reg_code'), [fields, canBarcode]);
    const label = (k: string) => columns.find(c => c.key === k)?.label || k;
    const rows = useMemo(() => filterRoster(people as any, {
        locationId: locationId ? Number(locationId) : null,
        paymentStatus: paymentStatus || null,
        excludeCancelled,
    }), [people, locationId, paymentStatus, excludeCancelled]);

    const toggle = (k: string) => setSelected(s => s.includes(k) ? s.filter(x => x !== k) : [...s, k]);
    const move = (i: number, d: number) => setSelected(s => {
        const j = i + d;
        if (j < 0 || j >= s.length) return s;
        const n = [...s]; [n[i], n[j]] = [n[j], n[i]]; return n;
    });

    const generate = async () => {
        if (!selected.length) { addToast(t('excel.columns.none') || 'Elige al menos una columna.', 'warning'); return; }
        try { localStorage.setItem(storeKey, JSON.stringify({ columns: selected, barcode })); } catch { /* private mode */ }
        try {
            let images: Map<number, any> | null = null;
            if (barcode && canBarcode) {
                images = new Map();
                // 2.23.0: the badge's QR — the «Mi inscripción» link with the code when that page is on.
                const qrPrefix = await conferenceApi.qrLink(conferenceId).then(r => (r && r.prefix) || null).catch(() => null);
                const withCode = rows.filter((p: any) => p.reg_code);
                setProgress({ n: 0, total: withCode.length });
                for (let i = 0; i < withCode.length; i++) {
                    const p: any = withCode[i];
                    images.set(Number(p.id), await qrPng(qrPrefix ? qrPrefix + String(p.reg_code) : String(p.reg_code), { module: qrPrefix ? 3 : 4, fontSize: 12 }));
                    if (i % 25 === 0) setProgress({ n: i + 1, total: withCode.length });
                }
            }
            const sheet = buildRosterSheet({ people: rows as any, fields: fields as any, columnKeys: selected, barcodes: images, transport });
            downloadXlsx(buildXlsx([sheet]), exportFilename('inscripciones', slug));
            addToast(t('excel.done') || 'Excel generado', 'success');
        } catch (e: any) {
            addToast(e?.message || 'Error', 'error');
        } finally {
            setProgress(null);
        }
    };

    const busy = !!progress;
    const input = 'w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-sm font-medium text-gray-900';
    return (
        <Overlay layer={2}>
            <div className="bg-white rounded-[40px] shadow-2xl w-full max-w-4xl border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200 max-h-[92vh] flex flex-col" role="dialog" aria-modal="true">
                <div className="bg-gray-50/50 px-8 sm:px-10 py-6 border-b border-gray-100 flex items-start justify-between gap-4 shrink-0">
                    <div>
                        <h3 className="font-black text-2xl text-gray-900 italic tracking-tighter"><i className="fa-solid fa-file-excel text-emerald-600 mr-2"></i>{t('excel.custom') || 'Excel personalizado'}</h3>
                        <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">{t('excel.custom.subtitle') || 'Elige las columnas, su orden y los filtros'}</p>
                    </div>
                    <button onClick={onClose} disabled={busy} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-2xl disabled:opacity-40" aria-label="Cerrar">
                        <i className="fa-solid fa-xmark text-xl"></i>
                    </button>
                </div>
                {loading ? (
                    <div className="text-center py-20"><div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div></div>
                ) : (
                    <div className="p-6 sm:p-10 space-y-6 overflow-y-auto">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('excel.filter.location') || 'Localidad'}</label>
                                <Select value={locationId} onChange={e => setLocationId(e.target.value)} className={input}>
                                    <option value="">{t('excel.filter.all') || 'Todas'}</option>
                                    {locs.map(l => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                                </Select>
                            </div>
                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('excel.filter.payment') || 'Estado de pago'}</label>
                                <Select value={paymentStatus} onChange={e => setPaymentStatus(e.target.value)} className={input}>
                                    <option value="">{t('excel.filter.all') || 'Todas'}</option>
                                    {/* The roster pill's words (2.18.0): Pagado / Abono / Sin pagar. */}
                                    <option value="paid">{tx('fees.pill.paid', 'Pagado')}</option>
                                    <option value="partial">{tx('fees.pill.partial', 'Abono')}</option>
                                    <option value="unpaid">{tx('fees.pill.unpaid', 'Sin pagar')}</option>
                                </Select>
                            </div>
                            <label className="flex items-center gap-3 sm:mt-6 px-4 py-2.5 rounded-xl border-2 border-gray-100 cursor-pointer">
                                <input type="checkbox" checked={excludeCancelled} onChange={e => setExcludeCancelled(e.target.checked)} className="accent-blue-600 w-4 h-4" />
                                <span className="text-sm font-bold text-gray-700">{t('excel.filter.cancelled') || 'Excluir cancelados'}</span>
                            </label>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1 mb-2">{t('excel.columns.available') || 'Columnas disponibles'}</div>
                                <div className="rounded-2xl border border-gray-100 divide-y divide-gray-50 max-h-80 overflow-y-auto">
                                    {columns.map(c => (
                                        <label key={c.key} className="flex items-center gap-3 px-4 py-2.5 hover:bg-blue-50/40 cursor-pointer">
                                            <input type="checkbox" checked={selected.includes(c.key)} onChange={() => toggle(c.key)} className="accent-blue-600 w-4 h-4" />
                                            <span className="text-sm font-medium text-gray-800">{c.label}</span>
                                            {c.key.startsWith('field:') && <span className="ml-auto text-[9px] font-black uppercase tracking-widest text-gray-300">form</span>}
                                        </label>
                                    ))}
                                </div>
                            </div>
                            <div>
                                <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1 mb-2">{t('excel.columns.selected') || 'Columnas del Excel (en orden)'}</div>
                                <div className="rounded-2xl border border-gray-100 divide-y divide-gray-50 max-h-80 overflow-y-auto">
                                    {selected.length === 0 && <div className="px-4 py-6 text-center text-xs text-gray-400 italic">{t('excel.columns.none') || 'Elige al menos una columna.'}</div>}
                                    {selected.map((k, i) => (
                                        <div key={k} className="flex items-center gap-2 px-4 py-2">
                                            <span className="w-6 text-[10px] font-black text-gray-300">{i + 1}</span>
                                            <span className="flex-1 min-w-0 truncate text-sm font-bold text-gray-800">{label(k)}</span>
                                            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title={t('excel.move.up') || 'Subir'} className="w-8 h-8 rounded-lg bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white disabled:opacity-30"><i className="fa-solid fa-arrow-up text-[10px]"></i></button>
                                            <button type="button" onClick={() => move(i, 1)} disabled={i === selected.length - 1} title={t('excel.move.down') || 'Bajar'} className="w-8 h-8 rounded-lg bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white disabled:opacity-30"><i className="fa-solid fa-arrow-down text-[10px]"></i></button>
                                            <button type="button" onClick={() => toggle(k)} title={t('excel.remove') || 'Quitar'} className="w-8 h-8 rounded-lg bg-gray-50 text-gray-400 hover:bg-rose-600 hover:text-white"><i className="fa-solid fa-xmark text-[10px]"></i></button>
                                        </div>
                                    ))}
                                </div>
                                {canBarcode && <label className="mt-4 flex items-start gap-3 px-4 py-3 rounded-2xl border-2 border-gray-100 cursor-pointer">
                                    <input type="checkbox" checked={barcode} onChange={e => setBarcode(e.target.checked)} className="accent-blue-600 w-4 h-4 mt-0.5" />
                                    <span>
                                        <span className="block text-sm font-bold text-gray-800"><i className="fa-solid fa-qrcode mr-1.5"></i>{t('excel.barcode') || 'Incluir código QR'}</span>
                                        <span className="block text-[11px] text-gray-500 mt-0.5">{t('excel.barcode.help') || 'Agrega una columna con la imagen del código QR de cada inscripción.'}</span>
                                    </span>
                                </label>}
                            </div>
                        </div>
                    </div>
                )}
                <div className="px-6 sm:px-10 py-5 border-t border-gray-50 bg-gray-50/30 flex flex-wrap items-center justify-between gap-3 shrink-0">
                    <span className="text-xs font-bold text-gray-500">{(t('excel.rows') || '{n} inscripciones se exportarán').replace('{n}', String(rows.length))}</span>
                    <div className="flex gap-3">
                        <button onClick={onClose} disabled={busy} className="px-6 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition-all disabled:opacity-40">{t('cancel') || 'Cancelar'}</button>
                        <button onClick={generate} disabled={busy || loading || !selected.length} className="px-8 py-3 bg-emerald-600 text-white rounded-2xl hover:bg-emerald-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-emerald-500/30 transition-all disabled:opacity-50">
                            {progress
                                ? <><i className="fa-solid fa-spinner fa-spin mr-1.5"></i>{(t('excel.generating') || 'Generando… {n}/{total}').replace('{n}', String(progress.n)).replace('{total}', String(progress.total))}</>
                                : <><i className="fa-solid fa-file-excel mr-1.5"></i>{t('excel.generate') || 'Generar Excel'}</>}
                        </button>
                    </div>
                </div>
            </div>
        </Overlay>
    );
}

/**
 * «Inscripciones» (2.18.0, tables-design.md + the owner's decisions): the roster is downloaded ONCE and
 * searched, filtered, grouped and paged in the browser (D1, D10). One card per location with a sticky header
 * and its own pager (D3, 20 per page, «Mostrar 10/20/50/100» remembered per device, D2). Compact rows on a
 * phone, a slim table with up to 3 chosen columns on a desktop (D4); the row's ⋮ (or a tap on a phone row, or
 * the name) opens the person sheet, which holds every action (D5, D6) — the Pago pill opens it at «Pago»
 * and the Código opens the barcode. Cancelled people show struck through, «Ocultar canceladas» off by
 * default (D8); «Por validar (N)» filters people with money awaiting validation (D9).
 *
 * After an action only the affected rows are re-read (GET /inscriptions/:id) — no full reload. The search,
 * filters, pages and collapsed cards survive a tab switch (sessionStorage `cm:insc:<conference>`).
 * The fee payments themselves live in «Pagos de cuotas»; the person sheet registers a payment for one
 * person (or their family group) and opens each of their payments (layer 2 above the sheet).
 */
export function InscriptionsPage({ conferenceId, onSeePayments, initial = null }: { conferenceId: number; onSeePayments?: (person: Inscription) => void; initial?: { rows: Inscription[]; fields: ConferenceField[]; locations: Location[] } | null }) {
    const { t, language } = useI18n();
    const fe = useFieldErrors(language);
    const tx = useTx();
    const { addToast } = useToast();
    // Inscripciones › gestionar = new / edit / cancel / delete; Pagos › ver = the person's payments, › gestionar
    // = register / validate…; Hospedaje › gestionar = the room; Reportes = the Excel export.
    const perms = usePerms();
    const canManage = perms.can('inscriptions', 'manage');
    const canSeeCodes = perms.can('inscriptions');
    const canPayView = perms.can('payments');
    const canPayManage = perms.can('payments', 'manage');
    const canAssign = perms.can('lodging', 'manage');
    const canExcel = perms.can('reports');
    // «Condiciones de salud» (2.32.0): Datos de salud › ver shows the field (list, sheet, form); › gestionar edits it.
    const canHealthView = perms.can('health');
    const canHealthWrite = perms.can('health', 'manage');
    const [healthForm, setHealthForm] = useState<{ value: any; original: any; error: string | null; loading: boolean }>({ value: null, original: null, error: null, loading: false });
    const [barcodeFor, setBarcodeFor] = useState<Inscription | null>(null);
    // «Escarapela» (2.19.0): the person whose badge actions are open.
    const [badgeFor, setBadgeFor] = useState<Inscription | null>(null);
    const canBadges = perms.can('badges') && canSeeCodes;
    const [showExcel, setShowExcel] = useState(false);
    const { currentConference: excelConf } = useConference();
    // `initial`: rows already in hand (drawn at once, then reloaded) — also what lets a server render draw the tables.
    const [inscriptions, setInscriptions] = useState<Inscription[]>(initial?.rows || []);
    const [fields, setFields] = useState<ConferenceField[]>(initial?.fields || []);
    const [confLocations, setConfLocations] = useState<Location[]>(initial?.locations || []);
    const [loading, setLoading] = useState(!initial);
    const [loadErr, setLoadErr] = useState('');
    const [showAddModal, setShowAddModal] = useState(false);
    const [formData, setFormData] = useState<any>({});
    // The row the edit form was seeded from — the PUT body carries only the keys that differ from it.
    const [formOriginal, setFormOriginal] = useState<any>(null);
    const [editId, setEditId] = useState<number | null>(null); // null = create, id = editing
    const [saving, setSaving] = useState(false);
    const [rowBusy, setRowBusy] = useState('');
    // In-app confirm, above every sheet of this page (layer 4). Never a window.confirm. `cancelLabel`: the
    // way back, when «Cancelar» would read like the action itself («Cancelar inscripción»).
    const [confirmState, setConfirmState] = useState<{ message: string; label: string; danger: boolean; cancelLabel?: string; resolve: (v: boolean) => void } | null>(null);
    const confirm = (message: string, label = 'Confirmar', danger = false, cancelLabel?: string) =>
        new Promise<boolean>(resolve => setConfirmState({ message, label, danger, cancelLabel, resolve }));

    // Manual room-assignment modal state.
    const [assignTarget, setAssignTarget] = useState<Inscription | null>(null);
    const [assignHotels, setAssignHotels] = useState<Hotel[]>([]);
    const [assignLoading, setAssignLoading] = useState(false);

    // The person sheet (by id: it always shows the live row) and what it opens.
    const [openId, setOpenId] = useState<number | null>(null);
    const [focusPay, setFocusPay] = useState(false);
    const [paymentsKey, setPaymentsKey] = useState(0);
    const [register, setRegister] = useState<{ ids: number[] } | null>(null);
    const [transferId, setTransferId] = useState<number | null>(null);
    const [feeEdit, setFeeEdit] = useState<{ mode: 'edit' | 'duplicate'; transfer: any } | null>(null);

    // Search, filters, pages, collapsed cards — kept per conference for the tab switch.
    const navKey = rosterNavKey(conferenceId);
    const [nav, setNav] = useState<RosterNav>(() => { try { return parseRosterNav(sessionStorage.getItem(navKey)); } catch { return EMPTY_ROSTER_NAV; } });
    useEffect(() => { try { sessionStorage.setItem(navKey, JSON.stringify(nav)); } catch { /* blocked storage */ } }, [nav, navKey]);
    const filters = nav.filters;
    // A filter change starts every location again at page 1.
    const setFilters = (f: RosterFilters) => setNav((n) => ({ ...n, filters: f, pages: {} }));
    const [size, setSize] = useState<number>(() => readPageSize());
    const [qNow, setQNow] = useState(filters.q);
    useEffect(() => { const h = setTimeout(() => setQNow(filters.q), 150); return () => clearTimeout(h); }, [filters.q]);

    const colsKey = rosterColumnsKey(conferenceId);
    const [columnNames, setColumnNames] = useState<string[] | null>(initial ? defaultRosterColumns(initial.fields || []) : null);
    const setColumns = (cols: string[]) => { setColumnNames(cols); try { localStorage.setItem(colsKey, JSON.stringify(cols)); } catch { /* blocked */ } };

    const load = async () => {
        if (!conferenceId) return;
        if (!inscriptions.length) setLoading(true);
        setLoadErr('');
        try {
            const [rows, fieldsData, locData] = await Promise.all([
                conferenceApi.getInscriptions(conferenceId),
                conferenceApi.getFields(conferenceId, { health: canHealthView }),
                conferenceApi.getLocations(conferenceId).catch(() => null),
            ]);
            setInscriptions(Array.isArray(rows) ? rows : []);
            setFields(fieldsData || []);
            setConfLocations(locData?.locations || []);
            let stored: string[] | null = null;
            try { stored = parseRosterColumns(localStorage.getItem(colsKey), fieldsData || []); } catch { stored = null; }
            setColumnNames(stored ?? defaultRosterColumns(fieldsData || []));
        } catch (e: any) {
            console.error(e);
            setLoadErr(e?.message || t('error.loading.inscriptions') || 'Error al cargar inscripciones');
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => { load(); }, [conferenceId]);

    /** Re-read only these rows (after an edit, a room, a payment…); a row that is gone leaves the list. */
    const patchRows = async (ids: number[]) => {
        const list = [...new Set((ids || []).map(Number).filter(Boolean))];
        if (!list.length) return;
        const fresh = await Promise.all(list.map((id) => conferenceApi.getInscription(id).then((r) => r, (e) => (Number(e?.status) === 404 ? null : undefined))));
        setInscriptions((rows) => {
            let next = rows;
            list.forEach((id, i) => {
                const r = fresh[i];
                if (r === undefined) return;            // a failed read keeps the row as it was
                next = r === null ? next.filter((x) => Number(x.id) !== id) : next.map((x) => (Number(x.id) === id ? r : x));
            });
            return next;
        });
    };

    const nameOf = (p: any) => personDisplayName(p, fields);
    const sorted = useMemo(() => rosterSort(inscriptions as any, nameOf), [inscriptions, fields]);
    const locName = (p: any) => {
        const k = rosterLocationKey(p, confLocations);
        return k === 'none' ? '' : (confLocations.find((l) => String(l.id) === k)?.name || p.location || '');
    };
    const haystacks = useMemo(() => new Map(sorted.map((p: any) => [p.id, rowHaystack(p, fields, [nameOf(p), locName(p)])])), [sorted, fields, confLocations]);
    const activeFilters = useMemo(() => ({ ...filters, q: qNow }), [filters, qNow]);
    const filtered = useMemo(() => applyRosterFilters(sorted, activeFilters, { locations: confLocations, haystackOf: (p) => haystacks.get(p.id) || '' }), [sorted, activeFilters, confLocations, haystacks]);
    const groups = useMemo(() => groupByLocation(filtered, confLocations, t('no.location') || 'Sin localidad'), [filtered, confLocations]);
    const pendingTotal = useMemo(() => pendingCount(inscriptions as any), [inscriptions]);
    const locationOptions = useMemo(() => {
        const opts = confLocations.map((l) => ({ key: String(l.id), name: l.name }));
        for (const p of inscriptions as any[]) {
            const k = rosterLocationKey(p, confLocations);
            if (k !== 'none' && !opts.some((o) => o.key === k)) opts.push({ key: k, name: p.location || `#${k}` });
        }
        return [...opts.sort((a, b) => a.name.localeCompare(b.name)), { key: 'none', name: t('no.location') || 'Sin localidad' }];
    }, [confLocations, inscriptions]);
    const columns = useMemo(() => (columnNames || []).map((n) => fields.find((f) => f.name === n)).filter(Boolean), [columnNames, fields]);

    // Pages: per location card. A page change brings that CARD back into view once the new page has
    // rendered (lib/paging.ts pagedScroll) — never its sticky header, which is already stuck at the top while
    // the pager at the card's bottom shows (scrolling it does nothing, and the shorter page would leave the
    // screen inside the next location's card).
    const cardRefs = useRef(new Map<string, HTMLElement | null>());
    const pageScroll = useRef(pagedScroll()).current;
    const pageOf = (g) => clampPage(nav.pages[g.key] || 1, g.rows.length, size);
    const goPage = (g, p: number) => {
        pageScroll.request(g.key);
        setNav((n) => ({ ...n, pages: { ...n.pages, [g.key]: p } }));
    };
    useEffect(() => { pageScroll.flush((key) => cardRefs.current.get(key)); }, [nav.pages]);
    const changeSize = (next: number) => {
        setNav((n) => ({ ...n, pages: Object.fromEntries(Object.entries(n.pages).map(([k, p]) => [k, pageAfterResize(p as number, size, next)])) }));
        setSize(next);
        writePageSize(next);
    };
    const toggleCollapse = (key: string) => setNav((n) => ({ ...n, collapsed: n.collapsed.includes(key) ? n.collapsed.filter((k) => k !== key) : [...n.collapsed, key] }));

    // ── create / edit ──────────────────────────────────────────────────────────────────────────────
    const openCreate = () => {
        setEditId(null);
        setFormOriginal(null);
        setFormData({});
        setHealthForm({ value: null, original: null, error: null, loading: false });
        setShowAddModal(true);
    };
    // Dynamic (custom) field values are flattened onto formData so the same form renders them; the location
    // select works on the id (legacy rows that only carry the label are resolved by name).
    const openEdit = (person: Inscription) => {
        setEditId(person.id);
        const seed = { ...person, ...(person.custom_data || {}), location_id: seedLocationId(person, confLocations), notes: person.notes ?? '' };
        setFormOriginal(seed);
        setFormData(seed);
        setShowAddModal(true);
        // The structured answer (the roster row only carries it as text).
        setHealthForm({ value: null, original: null, error: null, loading: canHealthView && fields.some(isHealthField) });
        if (canHealthView && fields.some(isHealthField)) {
            conferenceApi.getInscriptionHealth(person.id)
                .then((r) => setHealthForm({ value: r.answer || null, original: r.answer || null, error: null, loading: false }))
                .catch((e: any) => setHealthForm({ value: null, original: null, error: e?.message || tx('health.load.error', 'No se pudo cargar la respuesta de salud.'), loading: false }));
        }
    };
    const closeForm = () => { setShowAddModal(false); setEditId(null); setFormOriginal(null); };
    // Escape: an untouched form closes; one with changes asks first — on 0d390616 Escape did nothing here, and
    // the 2.18 escape stack must not throw an admin's half-typed edits away with one key. ✕ / «Cancelar» close.
    const escapeForm = async () => {
        if (saving) return;
        if (!formIsDirty(formData, formOriginal)) { closeForm(); return; }
        if (await confirm(tx('form.discard.confirm', '¿Descartar los cambios de esta inscripción?'), tx('form.discard', 'Descartar cambios'), true, tx('form.keep.editing', 'Seguir editando'))) closeForm();
    };
    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!conferenceId) return;
        // «Condiciones de salud»: its errors are said under the field (never a browser bubble).
        const healthField = canHealthWrite ? fields.find(isHealthField) : null;
        if (healthField) {
            if (healthForm.loading) return;
            const err = healthAnswerError(healthField, healthForm.value);
            if (err) {
                setHealthForm((h) => ({ ...h, error: err === 'other' ? tx('health.error.other', 'Escribe cuál es la otra condición.') : tx('health.error.required', 'Marca al menos una opción (o «Prefiero no responder»).') }));
                return;
            }
        }
        setSaving(true);
        try {
            // Only defined form fields + location_id/notes/status travel; never the row's derived columns.
            const payload = buildInscriptionPayload(fields, formData, editId ? formOriginal : null);
            if (healthField && (!editId || !sameHealthAnswer(healthPayload(healthField, healthForm.value), healthPayload(healthField, healthForm.original)))) {
                payload[HEALTH_FIELD] = healthPayload(healthField, healthForm.value);
            }
            if (editId) {
                const result = await conferenceApi.updateInscription(editId, payload);
                // Moving someone out of (or, with their bed, into) a submitted / validated arrangement, or
                // freeing one of its beds: the same toast says it was recorded as an adjustment.
                addToast(withAdjusted(tx, t('inscription.updated') || 'Inscripción actualizada', result), 'success');
                await patchRows([editId]);
            } else {
                await conferenceApi.createInscription(conferenceId, payload);
                addToast(t('inscription.created') || 'Inscripción creada', 'success');
                await load();
            }
            closeForm();
            setFormData({});
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        } finally {
            setSaving(false);
        }
    };
    const handleFormChange = (name: string, value: any) => setFormData((prev: any) => ({ ...prev, [name]: value }));

    // ── cancel / reactivate / delete ───────────────────────────────────────────────────────────────
    // What they did is said IN the person sheet, above its buttons (PersonSheet `notice`; 2.18.0 review PUX-2):
    // a toast covered that pinned row on a phone and a 409's steps vanished after 3 s, never announced. An
    // error stays until the next action or the sheet closes; another person's sheet starts without it.
    const [sheetNotice, setSheetNotice] = useState<{ id: number; text: string; type: 'error' | 'success' } | null>(null);
    useEffect(() => { setSheetNotice(null); }, [openId]);
    // After «Eliminar», the focus goes to the neighbouring row of the same card (PUX-8): the row and its «⋮» go
    // with the person, and the sheet's way back to its opener found nothing — the focus fell to <body>.
    const refocus = useRef<string[] | null>(null);
    useEffect(() => {
        if (openId != null || !refocus.current || typeof document === 'undefined') return;
        const sels = refocus.current;
        refocus.current = null;
        focusFirstVisible(document, sels);
    }, [openId, inscriptions]);
    const toggleCancel = async (person: Inscription) => {
        const cancelling = person.status !== 'cancelled';
        // Two buttons that never read alike on a phone: «No, mantenerla» | «Sí, cancelar inscripción».
        if (cancelling && !await confirm(tx('roster.confirm.cancel', '¿Cancelar la inscripción de {name}? Libera su cama y deja de deber la cuota; se puede reactivar.', { name: nameOf(person) }),
            tx('roster.cancel.yes', 'Sí, cancelar inscripción'), true, tx('roster.cancel.keep', 'No, mantenerla'))) return;
        setRowBusy('cancel');
        setSheetNotice(null);
        try {
            // Cancelling frees the bed: in a submitted / validated arrangement that is recorded as an
            // administration adjustment (2.17.0), and the notice says so.
            const result = await conferenceApi.updateInscription(person.id, { status: cancelling ? 'cancelled' : 'active' });
            setSheetNotice({ id: person.id, type: 'success', text: withAdjusted(tx, cancelling ? tx('roster.done.cancelled', 'Inscripción cancelada.') : tx('roster.done.reactivated', 'Inscripción reactivada.'), result) });
            await patchRows([person.id]);
            setPaymentsKey((k) => k + 1);
        } catch (error: any) {
            // Reactivating answers 409 when the location is full (its message says so).
            setSheetNotice({ id: person.id, type: 'error', text: error?.message || 'Error' });
        } finally { setRowBusy(''); }
    };
    const handleDelete = async (person: Inscription) => {
        if (!await confirm(`${t('confirm.delete.inscription') || '¿Eliminar la inscripción de'} ${nameOf(person)}?`, t('delete') || 'Eliminar', true)) return;
        setRowBusy('delete');
        setSheetNotice(null);
        // Read where the focus goes BEFORE the row is gone.
        const neighbours = typeof document !== 'undefined' ? rosterNeighborSelectors(document, person.id) : [];
        try {
            const result = await conferenceApi.deleteInscription(person.id);
            // The sheet closes with the person: a toast, nothing left under it to cover.
            addToast(withAdjusted(tx, t('inscription.deleted') || 'Inscripción eliminada', result), 'success');
            refocus.current = neighbours;
            setOpenId(null);
            setInscriptions((rows) => rows.filter((r) => r.id !== person.id));
        } catch (error: any) {
            // 409: it has payments (or shares one) — the message says what to do, «Cancelar inscripción» of this sheet included.
            setSheetNotice({ id: person.id, type: 'error', text: error?.message || 'Error' });
        } finally { setRowBusy(''); }
    };

    // ── room ───────────────────────────────────────────────────────────────────────────────────────
    const openAssign = async (person: Inscription) => {
        setAssignTarget(person);
        setAssignLoading(true);
        try {
            setAssignHotels(await conferenceApi.getHotels(conferenceId));
        } catch (e) {
            addToast(t('error.loading.hotels') || 'Error al cargar hoteles', 'error');
        } finally {
            setAssignLoading(false);
        }
    };
    const doAssign = async (roomId: number | null) => {
        if (!assignTarget) return;
        try {
            const result = await conferenceApi.assignRoom(assignTarget.id, roomId);
            addToast(withAdjusted(tx, roomId ? (t('room.assigned') || 'Habitación asignada') : (t('room.unassigned') || 'Asignación removida'), result), 'success');
            const id = assignTarget.id;
            setAssignTarget(null);
            await patchRows([id]);
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        }
    };

    // ── fee payments from the sheet ────────────────────────────────────────────────────────────────
    const personOptions = useMemo(() => (register || feeEdit ? buildPersonOptions(inscriptions as any, nameOf, confLocations) : []), [register, feeEdit, inscriptions, fields, confLocations]);
    const afterFees = async (ids: number[]) => { setPaymentsKey((k) => k + 1); await patchRows(ids); };
    const openPerson = (p: any, opts: { pay?: boolean } = {}) => { setFocusPay(!!opts.pay); setOpenId(p.id); };
    const openPersonRow = openId == null ? null : (inscriptions.find((r) => r.id === openId) || null);
    // The sheet closes itself when its row disappears (deleted elsewhere).
    useEffect(() => { if (openId != null && !loading && !openPersonRow) setOpenId(null); }, [openId, openPersonRow, loading]);
    const familyIdsOf = (p: any) => {
        const fam = String(rawFieldValue(p, 'family_group') || '').trim();
        if (!fam) return [];
        return (inscriptions as any[]).filter((r) => String(rawFieldValue(r, 'family_group') || '').trim() === fam && personBalance(r).payable).map((r) => r.id);
    };

    const anyFilter = activeFilterCount(filters) > 0 || !!filters.q.trim();
    return (
        <div className="flex flex-col" data-roster-page="">
            <style>{ROSTER_CSS}</style>
            <ReadOnlyNotice section="inscriptions" alsoManage={['payments', 'lodging']} className="mb-4" />
            {showExcel && <ExcelExportModal conferenceId={conferenceId} slug={excelConf?.slug} onClose={() => setShowExcel(false)} />}
            {badgeFor && (
                <BadgeActions person={badgeFor} name={personDisplayName(badgeFor, fields)} fields={fields} conferenceId={conferenceId}
                    conferenceName={excelConf?.name || ''} canManage={perms.can('badges', 'manage')} onClose={() => setBadgeFor(null)} />
            )}
            {barcodeFor && barcodeFor.reg_code && (
                <BarcodeModal code={barcodeFor.reg_code} name={personDisplayName(barcodeFor, fields)} onClose={() => setBarcodeFor(null)} conferenceId={conferenceId} />
            )}
            <RosterFilters filters={filters} setFilters={setFilters} locationOptions={locationOptions} pendingTotal={pendingTotal}
                size={size} onSize={changeSize} fields={fields} columns={columnNames || []} setColumns={setColumns}
                canExcel={canExcel} canManage={canManage} onExcel={() => setShowExcel(true)} onNew={openCreate} />

            {loading ? (
                <div className="text-center py-20">
                    <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                    <p className="text-gray-500">{t('loading.inscriptions')}</p>
                </div>
            ) : loadErr ? (
                <div role="alert" className="rounded-2xl border-2 border-rose-200 bg-rose-50 px-4 py-4 text-sm font-bold text-rose-700 flex flex-wrap items-center gap-3">
                    <span className="flex-1">{loadErr}</span>
                    <button type="button" onClick={load} className="min-h-[44px] px-4 rounded-xl bg-white border-2 border-rose-200 text-xs font-black uppercase tracking-widest">{tx('staff.retry', 'Reintentar')}</button>
                </div>
            ) : inscriptions.length === 0 ? (
                <div className="text-center py-20 text-gray-500">
                    <i className="fa-solid fa-users text-4xl mb-4 opacity-50"></i>
                    <p>{t('no.inscriptions')}</p>
                </div>
            ) : groups.length === 0 ? (
                <div className="text-center py-16 text-gray-600 space-y-3" data-roster-empty="">
                    <p className="text-sm font-bold">{tx('roster.none.match', 'Nadie coincide con la búsqueda o los filtros.')}</p>
                    {anyFilter && <button type="button" onClick={() => setFilters(EMPTY_ROSTER_FILTERS)} className="min-h-[44px] px-4 rounded-xl border-2 border-gray-100 text-xs font-black uppercase tracking-widest">{tx('accounting.clear.filters', 'Quitar filtros')}</button>}
                </div>
            ) : (
                <div className="space-y-8">
                    <p className="text-[11px] font-black uppercase tracking-widest text-gray-500" aria-live="polite" data-roster-total="">
                        {tx('roster.shown', '{n} de {total} inscripciones', { n: filtered.length, total: inscriptions.length })}
                    </p>
                    {groups.map((g) => (
                        <RosterGroup key={g.key} group={g} page={pageOf(g)} size={size} onPage={(p) => goPage(g, p)}
                            collapsed={nav.collapsed.includes(g.key)} onToggle={() => toggleCollapse(g.key)}
                            columns={columns} nameOf={nameOf} canSeeCodes={canSeeCodes} openId={openId}
                            onOpen={openPerson} onBarcode={(p) => setBarcodeFor(p)}
                            cardRef={(el) => { cardRefs.current.set(g.key, el); }} />
                    ))}
                </div>
            )}

            {openPersonRow && (
                <PersonSheet person={openPersonRow} fields={fields} locations={confLocations} nameOf={nameOf}
                    canManage={canManage} canSeeCodes={canSeeCodes} canPayView={canPayView} canPayManage={canPayManage} canAssign={canAssign}
                    focusPay={focusPay} paymentsKey={paymentsKey} familyIds={familyIdsOf(openPersonRow)} busy={rowBusy}
                    notice={sheetNotice && sheetNotice.id === openPersonRow.id ? sheetNotice : null}
                    onClose={() => setOpenId(null)}
                    onEdit={canManage ? openEdit : undefined}
                    onAssign={canAssign ? openAssign : undefined}
                    onBarcode={(p) => setBarcodeFor(p)}
                    onBadge={canBadges && openPersonRow.status !== 'cancelled' ? (p) => setBadgeFor(p) : undefined}
                    onToggleCancel={canManage ? toggleCancel : undefined}
                    onDelete={canManage ? handleDelete : undefined}
                    onRegister={canPayManage ? (ids) => setRegister({ ids }) : undefined}
                    onOpenTransfer={canPayView ? (id) => setTransferId(id) : undefined}
                    onSeePayments={canPayView && onSeePayments ? (p) => { setOpenId(null); onSeePayments(p); } : undefined} />
            )}
            {register && (
                <RegisterPaymentSheet mode="create" conferenceId={conferenceId} options={personOptions} locations={confLocations} ids={register.ids}
                    confirm={confirm} onClose={() => setRegister(null)}
                    onStale={() => patchRows(register.ids)}
                    onSaved={({ ids }) => { setRegister(null); afterFees(ids); }} />
            )}
            {transferId != null && (
                <TransferSheet id={transferId} canManage={canPayManage} confirm={confirm} onClose={() => setTransferId(null)}
                    onChanged={({ action, ids }) => { afterFees(ids || []); if (action === 'remove') setTransferId(null); }}
                    onEdit={(tr) => { setTransferId(null); setFeeEdit({ mode: 'edit', transfer: tr }); }}
                    onDuplicate={(tr) => { setTransferId(null); setFeeEdit({ mode: 'duplicate', transfer: tr }); }} />
            )}
            {feeEdit && (
                <RegisterPaymentSheet mode={feeEdit.mode} conferenceId={conferenceId} options={personOptions} locations={confLocations} transfer={feeEdit.transfer}
                    confirm={confirm} onClose={() => setFeeEdit(null)}
                    onStale={() => patchRows((feeEdit.transfer.allocations || []).map((a) => a.inscription_id))}
                    onSaved={({ id, ids }) => { setFeeEdit(null); afterFees(ids); if (id) setTransferId(id); }} />
            )}

            {showAddModal && (
                <Overlay layer={LAYER.modal} onEscape={escapeForm}>
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200" role="dialog" aria-modal="true" aria-labelledby="cm-inscription-form-title">
                        <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between">
                            <h3 id="cm-inscription-form-title" className="font-bold text-xl text-gray-900 italic">{editId ? (t('edit.inscription') || 'Editar Inscripción') : t('new.inscription')}</h3>
                            <button type="button" onClick={closeForm} aria-label={tx('close', 'Cerrar')} className="text-gray-500 hover:text-gray-700 transition-colors w-11 h-11 shrink-0 flex items-center justify-center hover:bg-gray-100 rounded-lg">
                                <i className="fa-solid fa-xmark text-lg"></i>
                            </button>
                        </div>
                        <form {...fe.form(handleSubmit)} className="p-8 space-y-6">
                            {/* Location — the admin picks it explicitly (the portal auto-sets it). */}
                            {confLocations.length > 0 ? (
                                <div>
                                    <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest ml-1 mb-1.5">
                                        {t('location') || 'Localidad'} <span className="text-rose-500">*</span>
                                    </label>
                                    <Select
                                        data-field="location_id" aria-invalid={fe.invalid('location_id')} aria-describedby={fe.describedBy('location_id')}
                                        required
                                        className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                        value={formData.location_id ?? ''}
                                        onChange={e => handleFormChange('location_id', e.target.value ? Number(e.target.value) : null)}
                                    >
                                        <option value="">Seleccionar localidad...</option>
                                        {confLocations.map((loc: any) => (
                                            <option key={loc.id} value={loc.id}>{loc.name}</option>
                                        ))}
                                    </Select>
                                    {(() => {
                                        // Moving someone who holds a bed OUT of a submitted / validated arrangement, or
                                        // INTO one with the bed they keep (2.17.0): an administration adjustment — and
                                        // Hospedaje › gestionar's to make (the server answers 409 to a role that may only
                                        // manage inscriptions). Without a bed, in or out: no hint (the bed rule). Mirror
                                        // of PUT /inscriptions/:id: lib/lodgingView.ts moveAdjustments.
                                        const move = editId && formOriginal ? moveAdjustments(formOriginal, formData, confLocations) : null;
                                        if (!move || (!move.out && !move.into && !move.intoMaybe)) return null;
                                        const notes = [
                                            move.out && { kind: 'out', loc: move.out, hint: ['lodging.adjust.move.hint', 'El hospedaje de «{name}» {state}: sacar de ahí a este participante quedará registrado como ajuste de la administración.'], denied: ['lodging.adjust.move.denied', 'El hospedaje de «{name}» {state}: sacar de ahí a este participante lo hace quien gestiona el Hospedaje (o se podrá {release}).'] },
                                            move.into && { kind: 'into', loc: move.into, hint: ['lodging.adjust.movein.hint', 'El hospedaje de «{name}» {state}: este participante entra en él con la cama que ya tiene, y eso quedará registrado como ajuste de la administración.'], denied: ['lodging.adjust.movein.denied', 'El hospedaje de «{name}» {state}: que este participante entre en él con la cama que ya tiene lo hace quien gestiona el Hospedaje (sin habitación sí podría entrar; con ella, se podrá {release}).'] },
                                            move.intoMaybe && { kind: 'into', loc: move.intoMaybe, hint: ['lodging.adjust.movein.shared.hint', 'El hospedaje de «{name}» {state}: su habitación es compartida y conservará la cama solo si queda una libre para esa localidad (o del pool); si la conserva, quedará registrado como ajuste de la administración.'], denied: ['lodging.adjust.movein.shared.denied', 'El hospedaje de «{name}» {state}: su habitación es compartida; si conservara la cama, ese cambio lo hace quien gestiona el Hospedaje (se podrá {release}).'] },
                                        ].filter(Boolean) as any[];
                                        return notes.map(n => canAssign
                                            ? <p key={n.kind} className="mt-2 text-[11px] font-medium text-blue-900 bg-blue-50 border border-blue-200 rounded-xl px-3 py-2" data-move-adjust="hint" data-move-dir={n.kind}><i className="fa-solid fa-pen-to-square mr-1.5" aria-hidden="true"></i>{adjustText(tx, n.hint[0], n.hint[1], n.loc)}</p>
                                            : <p key={n.kind} className="mt-2 text-[11px] font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2" data-move-adjust="denied" data-move-dir={n.kind}><i className="fa-solid fa-lock mr-1.5" aria-hidden="true"></i>{adjustText(tx, n.denied[0], n.denied[1], n.loc)}</p>);
                                    })()}
                                    <FieldError message={fe.error('location_id')} id={fe.errorId('location_id')} />
                                </div>
                            ) : (
                                <p className="text-[10px] text-gray-500 italic px-1">Sin localidades configuradas. Créalas en la pestaña «Localidades» para poder asignarlas aquí.</p>
                            )}
                            {fields.length === 0 ? (
                                <div className="text-center py-10 bg-orange-50 rounded-2xl border-2 border-dashed border-orange-100 p-6">
                                    <i className="fa-solid fa-triangle-exclamation text-orange-400 text-3xl mb-4"></i>
                                    <p className="text-orange-900 font-black italic tracking-tight mb-1">Formulario no configurado</p>
                                    <p className="text-xs text-orange-700 leading-relaxed max-w-[280px] mx-auto">Debes crear campos en la pestaña "Campos" antes de poder registrar participantes.</p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                    {fields.map(field => (
                                        <div key={field.id} className={field.type === 'notes' || field.type === 'textarea' || isHealthField(field) ? 'md:col-span-2' : ''}>
                                            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest ml-1 mb-1.5">
                                                {field.label} {field.is_required ? <span className="text-rose-500">*</span> : ''}
                                            </label>
                                            {isHealthField(field) ? (
                                                // «Condiciones de salud» (2.32.0): only Datos de salud › ver gets this field at all.
                                                healthForm.loading ? (
                                                    <p className="text-sm text-gray-500 px-1"><i className="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>{tx('loading', 'Cargando…')}</p>
                                                ) : canHealthWrite ? (
                                                    <HealthConditionsInput
                                                        id={`cm-health-${editId || 'new'}`}
                                                        field={field}
                                                        value={healthForm.value}
                                                        onChange={(v) => setHealthForm((h) => ({ ...h, value: v, error: null }))}
                                                        error={healthForm.error}
                                                        labels={{
                                                            consent: tx('health.consent', 'Usaremos esta información solo para atenderte mejor (por ejemplo, el turno de comida). Solo la ve el equipo autorizado. Puedes no responder.'),
                                                            other: tx('health.other', 'Otros'), otherPlaceholder: tx('health.other.placeholder', '¿Cuál?'),
                                                            none: tx('health.none', 'Ninguna'), declined: tx('health.declined', 'Prefiero no responder'),
                                                        }}
                                                    />
                                                ) : (
                                                    <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-2.5 text-sm text-gray-800" data-health-readonly="">
                                                        {healthAnswerText(healthForm.value) || '—'}
                                                        <p className="mt-1 text-[11px] text-gray-500">{tx('health.readonly', 'Para cambiarla hace falta el permiso «Datos de salud › gestionar».')}</p>
                                                        {healthForm.error && <p role="alert" className="mt-1 text-xs font-semibold text-rose-600">{healthForm.error}</p>}
                                                    </div>
                                                )
                                            ) : field.type === 'switch' ? (
                                                // A Sí / No switch (2.31.0 — «Requiere hospedaje»). Blank reads as «Sí».
                                                <button
                                                    type="button"
                                                    role="switch"
                                                    aria-checked={isSwitchOn(formData[field.name])}
                                                    aria-label={field.label}
                                                    data-cm-switch={field.name}
                                                    onClick={() => handleFormChange(field.name, isSwitchOn(formData[field.name]) ? SWITCH_OFF : SWITCH_ON)}
                                                    className="inline-flex items-center gap-3 min-h-[44px] py-1 text-sm font-semibold text-gray-800"
                                                >
                                                    <span className={`relative inline-block w-11 h-6 rounded-full transition-colors ${isSwitchOn(formData[field.name]) ? 'bg-blue-600' : 'bg-gray-300'}`} aria-hidden="true">
                                                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${isSwitchOn(formData[field.name]) ? 'translate-x-5' : ''}`}></span>
                                                    </span>
                                                    {switchLabel(tx, isSwitchOn(formData[field.name]))}
                                                </button>
                                            ) : isPhoneField(field) ? (
                                                // 2.33.2: the country's calling code next to the number; E.164 is sent.
                                                <PhoneInput dataField={field.name} label={field.label} lang={language} defaultCountry={excelConf?.phone_country}
                                                    invalid={fe.invalid(field.name)} describedBy={fe.describedBy(field.name)}
                                                    selectClassName="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm" inputClassName="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                                    value={formData[field.name] ?? ''} onChange={v => handleFormChange(field.name, v)} />
                                            ) : field.type === 'select' ? (
                                                <Select
                                                    data-field={field.name} aria-invalid={fe.invalid(field.name)} aria-describedby={fe.describedBy(field.name)}
                                                    required={!!field.is_required}
                                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                                    value={formData[field.name] ?? ''}
                                                    onChange={e => handleFormChange(field.name, e.target.value)}
                                                >
                                                    <option value="">{t('select.option') || 'Seleccionar...'}</option>
                                                    {field.options?.split(',').map(opt => (
                                                        <option key={opt.trim()} value={opt.trim()}>{opt.trim()}</option>
                                                    ))}
                                                </Select>
                                            ) : field.type === 'date' ? (
                                                <DateField dataField={field.name} required={!!field.is_required} ariaLabel={field.label}
                                                    value={formData[field.name] ?? ''} onChange={v => handleFormChange(field.name, v)} />
                                            ) : field.type === 'textarea' || field.type === 'notes' ? (
                                                <textarea
                                                    data-field={field.name} aria-invalid={fe.invalid(field.name)} aria-describedby={fe.describedBy(field.name)}
                                                    rows={3}
                                                    placeholder={field.label}
                                                    required={!!field.is_required}
                                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm resize-none"
                                                    value={formData[field.name] ?? ''}
                                                    onChange={e => handleFormChange(field.name, e.target.value)}
                                                />
                                            ) : (
                                                <input
                                                    data-field={field.name} aria-invalid={fe.invalid(field.name)} aria-describedby={fe.describedBy(field.name)}
                                                    type={field.type === 'number' ? 'number' : 'text'}
                                                    placeholder={field.label}
                                                    required={!!field.is_required}
                                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                                    value={formData[field.name] ?? ''}
                                                    onChange={e => handleFormChange(field.name, e.target.value)}
                                                />
                                            )}
                                            <FieldError message={fe.error(field.name)} id={fe.errorId(field.name)} />
                                        </div>
                                    ))}
                                </div>
                            )}
                            {/* «Notas internas» (2.18.0): the admin's own notes on the inscription, never shown to the coordinator. */}
                            {editId && (
                                <div>
                                    <label htmlFor="cm-inscription-notes" className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest ml-1 mb-1.5">{tx('roster.notes', 'Notas internas')}</label>
                                    <textarea id="cm-inscription-notes" rows={3} value={formData.notes ?? ''} onChange={e => handleFormChange('notes', e.target.value)}
                                        className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm resize-none" />
                                </div>
                            )}

                            <div className="pt-6 flex justify-end gap-3 border-t border-gray-50" data-cm-sheet-foot="">
                                <button type="button" onClick={closeForm} className="min-h-[44px] px-6 py-2.5 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition">{t('cancel')}</button>
                                {fields.length > 0 && (
                                    <button type="submit" disabled={saving} className="min-h-[44px] px-8 py-2.5 bg-blue-600 text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 hover:bg-blue-700 transition disabled:opacity-50">{saving ? (t('saving') || 'Guardando…') : t('save')}</button>
                                )}
                            </div>
                        </form>
                    </div>
                </Overlay>
            )}

            {/* In-app confirm — the top layer, above the person sheet and anything it opened. */}
            {confirmState && (
                <Overlay layer={LAYER.confirm} onEscape={() => { confirmState.resolve(false); setConfirmState(null); }}>
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-150" role="alertdialog" aria-modal="true"
                        aria-label={tx('confirm.title', 'Confirmar')} aria-describedby="cm-insc-confirm-msg">
                        <div className="p-6">
                            <p id="cm-insc-confirm-msg" className="text-gray-800 font-medium leading-relaxed">{confirmState.message}</p>
                        </div>
                        <div className="px-6 py-4 bg-gray-50/50 border-t border-gray-100 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => { confirmState.resolve(false); setConfirmState(null); }}
                                className="min-h-[44px] px-5 py-2 text-gray-600 font-bold hover:bg-gray-100 rounded-xl transition"
                                data-confirm-cancel=""
                            >
                                {confirmState.cancelLabel || t('cancel') || 'Cancelar'}
                            </button>
                            <button
                                type="button"
                                onClick={() => { confirmState.resolve(true); setConfirmState(null); }}
                                className={`min-h-[44px] px-5 py-2 text-white font-bold rounded-xl shadow-lg transition ${confirmState.danger ? 'bg-rose-600 hover:bg-rose-700 shadow-rose-500/30' : 'bg-blue-600 hover:bg-blue-700 shadow-blue-500/30'}`}
                            >
                                {confirmState.label}
                            </button>
                        </div>
                    </div>
                </Overlay>
            )}

            {/* Manual room-assignment modal */}
            {assignTarget && (
                <Overlay layer={LAYER.modal} onEscape={() => setAssignTarget(null)}>
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200" role="dialog" aria-modal="true" aria-labelledby="cm-assign-title">
                        <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between">
                            <div>
                                <h3 id="cm-assign-title" className="font-bold text-xl text-gray-900 italic">{t('assign.room') || 'Asignar habitación'}</h3>
                                <p className="text-xs text-gray-500 mt-0.5">{personDisplayName(assignTarget, fields)}</p>
                            </div>
                            <button type="button" onClick={() => setAssignTarget(null)} aria-label={tx('close', 'Cerrar')} className="text-gray-500 hover:text-gray-700 transition-colors w-11 h-11 shrink-0 flex items-center justify-center hover:bg-gray-100 rounded-lg">
                                <i className="fa-solid fa-xmark text-lg"></i>
                            </button>
                        </div>
                        {(() => {
                            // The attendee's location (by id, or by name for legacy rows) decides which allotted
                            // rooms are open to them. A submitted / validated arrangement is still the admin's to
                            // change (2.17.0): the modal says the change is recorded as an adjustment.
                            const targetLocId = seedLocationId(assignTarget, confLocations);
                            const reviewed = reviewedLocationOf(assignTarget.location_id, confLocations);
                            return (
                        <div className="p-8 max-h-[65vh] overflow-y-auto modern-scrollbar">
                            {reviewed && (
                                <div className="mb-4 p-4 rounded-2xl bg-blue-50 border border-blue-200 text-blue-900 flex items-start gap-3" data-adjust-notice={reviewed.lodging_status}>
                                    <i className="fa-solid fa-pen-to-square mt-0.5 shrink-0" aria-hidden="true"></i>
                                    <p className="text-sm font-medium leading-relaxed">
                                        <span className={`inline-block mr-1.5 px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest align-middle ${lodgingStatusMeta(reviewed.lodging_status).cls}`}>
                                            {t(lodgingStatusMeta(reviewed.lodging_status).key) || lodgingStatusMeta(reviewed.lodging_status).fallback}
                                        </span>
                                        {adjustText(tx, 'lodging.adjust.notice', 'El hospedaje de «{name}» {state}: puedes cambiarlo igualmente. Cada cambio queda registrado como ajuste de la administración y el encargado lo verá en su portal.', reviewed)}
                                    </p>
                                </div>
                            )}
                            <>
                            {assignTarget.room_id && (
                                <button
                                    onClick={() => doAssign(null)}
                                    className="w-full mb-4 px-4 py-3 rounded-xl border-2 border-dashed border-rose-200 text-rose-600 font-bold text-sm hover:bg-rose-50 transition flex items-center justify-center gap-2"
                                >
                                    <i className="fa-solid fa-xmark"></i> {t('unassign.room') || 'Quitar asignación actual'}
                                </button>
                            )}
                            {!needsLodging(assignTarget) && !assignTarget.room_id ? (
                                // «Requiere hospedaje: No» (2.31.0): the server refuses any room for them.
                                <p className="text-sm text-gray-500 text-center py-6" data-cm-no-lodging=""><i className="fa-solid fa-bed mr-2 opacity-40" aria-hidden="true"></i>{tx('board.no.lodging', 'No requiere hospedaje: no se le puede asignar habitación')}</p>
                            ) : assignLoading ? (
                                <div className="text-center py-10"><div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div></div>
                            ) : assignHotels.length === 0 ? (
                                <div className="text-center py-10 text-gray-400 bg-gray-50 rounded-xl border border-dashed">
                                    <i className="fa-solid fa-hotel text-3xl mb-3 opacity-30"></i>
                                    <p className="font-medium text-sm">{t('no.hotels') || 'No hay hoteles configurados.'}</p>
                                </div>
                            ) : (
                                <div className="space-y-6">
                                    {assignHotels.map(hotel => (
                                        <div key={hotel.id}>
                                            <h4 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">{hotel.name}</h4>
                                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                                {(hotel.rooms || []).map(room => {
                                                    const full = (room.occupied || 0) >= room.capacity && assignTarget.room_id !== room.id;
                                                    const current = assignTarget.room_id === room.id;
                                                    // A room allotted to another location is closed to this attendee (roomAllows).
                                                    const foreign = room.location_id != null && Number(room.location_id) !== Number(targetLocId);
                                                    // A shared room (2.18.0) with no bed left for the attendee's location (its beds, then the pool's).
                                                    // The raw location_id, like the server (a legacy row with only a label has none).
                                                    const noBed = !current && !full && !foreign && !sharedBedFree(room, { id: assignTarget.id, location_id: assignTarget.location_id ?? null }, null);
                                                    // A shared room «Sugerir reparto» fixed for another gender (2.21.0).
                                                    const locked = !current && !full && !foreign && !noBed && lockMismatch(room, assignTarget as any);
                                                    const blocked = full || foreign || noBed || locked;
                                                    const sharedLabel = (room.shares || []).length ? (room.shares || []).map(s => `${s.location_name || `#${s.location_id}`} ${s.beds}`).join(' · ') : null;
                                                    const roomLoc = room.location_id != null ? (room.location_name || `#${room.location_id}`) : sharedLabel;
                                                    return (
                                                        <button
                                                            key={room.id}
                                                            disabled={blocked}
                                                            title={foreign ? roomLoc || undefined : noBed ? (t('board.room.shared.full') || 'Sin cama para su localidad en esta habitación compartida') : locked ? (t('board.room.locked') || 'Habitación compartida fijada para otro género') : undefined}
                                                            onClick={() => doAssign(room.id)}
                                                            className={`px-3 py-2.5 rounded-xl border-2 text-left transition-all ${current
                                                                ? 'border-blue-500 bg-blue-50'
                                                                : blocked
                                                                    ? 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                                                                    : 'border-gray-100 hover:border-emerald-400 hover:bg-emerald-50'}`}
                                                        >
                                                            <div className="font-black text-sm text-gray-900">{room.room_number}</div>
                                                            {roomLoc && (
                                                                <div className={`text-[9px] font-black uppercase tracking-widest truncate ${foreign || noBed || locked ? 'text-rose-500' : sharedLabel && room.location_id == null ? 'text-violet-600' : 'text-indigo-500'}`}>
                                                                    <i className={`fa-solid ${sharedLabel && room.location_id == null ? 'fa-bed' : 'fa-map-pin'} mr-1`}></i>{roomLoc}
                                                                </div>
                                                            )}
                                                            <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">
                                                                {(room.occupied || 0)}/{room.capacity}
                                                            </div>
                                                        </button>
                                                    );
                                                })}
                                                {(hotel.rooms || []).length === 0 && (
                                                    <div className="col-span-full text-xs text-gray-300 italic">{t('no.rooms') || 'Sin habitaciones'}</div>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                            </>
                        </div>
                            );
                        })()}
                    </div>
                </Overlay>
            )}
        </div>
    );
}

/**
 * One room tile of «Hoteles y habitaciones». The tile is a plain container: its one action (open the
 * explorer at this room, or toggle it in selection mode) is a real <button>, and the delete button is
 * its SIBLING — never an interactive control nested in a role=button, whose children screen readers
 * flatten (axe nested-interactive). `names` = the occupants' display names, sorted.
 */
function LodgingRoomTile({ room, names, selecting, selected, onActivate, onDelete, onSplit, t }: {
    room: Room; names: string[]; selecting: boolean; selected: boolean;
    onActivate?: () => void; onDelete?: () => void; onSplit?: () => void; t: (k: string) => string;
}) {
    const shares = room.shares || [];
    const cap = room.capacity || 0;
    const occ = room.occupied || 0;
    const isFull = cap > 0 && occ >= cap;
    const occupancyPercent = cap > 0 ? Math.min(100, (occ / cap) * 100) : 0;
    const badge = room.location_id != null ? (room.location_name || `#${room.location_id}`) : null;
    const shownNames = names.slice(0, 3);
    const openLabel = fillVars(t('explorer.tile.open') || 'Ver ocupación de la habitación {n}', { n: room.room_number });
    const actionLabel = selecting
        ? fillVars(t('explorer.tile.select') || 'Seleccionar la habitación {n}', { n: room.room_number })
        : `${openLabel} (${occ}/${room.capacity ?? 0})${names.length ? `: ${names.join(', ')}` : ''}`;
    const Body: any = onActivate ? 'button' : 'div';
    const bodyProps = onActivate
        ? { type: 'button', onClick: onActivate, 'aria-label': actionLabel, 'aria-pressed': selecting ? selected : undefined, title: selecting ? undefined : openLabel }
        : {};
    return (
        <div
            data-room-tile={room.id}
            className={`
            group/room rounded-3xl border-2 transition-all duration-300 relative overflow-hidden
            ${selected
                ? 'bg-indigo-50 border-indigo-500 shadow-lg'
                : isFull
                    ? 'bg-white border-rose-100 shadow-sm opacity-80'
                    : 'bg-white border-white shadow-sm hover:border-blue-400 hover:shadow-xl hover:-translate-y-1'}
        `}>
            {/* Decor first: the body below is positioned and paints over it. */}
            {isFull && <div className="absolute inset-0 bg-rose-50/10 pointer-events-none"></div>}
            <Body
                {...bodyProps}
                className={`relative w-full h-full text-left p-4 sm:p-5 flex flex-col justify-between gap-3 min-h-[9rem] rounded-3xl ${onActivate ? 'cursor-pointer focus:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-blue-200' : ''}`}
            >
                {/* pr-7 / pr-14 keep the room number / badges clear of the buttons above it. */}
                <div className={`flex justify-between items-start gap-2 ${onSplit && onDelete ? 'pr-14' : 'pr-7'} w-full`}>
                    <div className="min-w-0">
                        <span className="font-black text-xl text-gray-900 italic tracking-tighter">{room.room_number}</span>
                        {badge && (
                            <div className="mt-0.5 max-w-full truncate px-1.5 py-0.5 rounded-md bg-indigo-50 text-indigo-600 text-[8px] font-black uppercase tracking-widest" title={badge}>
                                <i className="fa-solid fa-map-pin mr-1" aria-hidden="true"></i>{badge}
                            </div>
                        )}
                        {/* A shared room (2.18.0): each location's beds (taken / given), then the pool's. */}
                        {shares.length > 0 && (
                            <div className="mt-0.5 flex flex-col items-start gap-0.5 max-w-full">
                                {shares.map(s => {
                                    const name = s.location_name || `#${s.location_id}`;
                                    const count = `${s.occupied || 0}/${s.beds}`;
                                    // Only the name is cut: the beds count always shows.
                                    return (
                                        <div key={s.location_id} className="max-w-full min-w-0 flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-violet-50 text-violet-700 text-[8px] font-black uppercase tracking-widest" title={`${name} ${count}`}>
                                            <i className="fa-solid fa-bed shrink-0" aria-hidden="true"></i>
                                            <span className="truncate min-w-0">{name}</span>
                                            <span className="shrink-0 tabular-nums">{count}</span>
                                        </div>
                                    );
                                })}
                                {(room.pool_beds || 0) > 0 && (
                                    <div className="max-w-full truncate px-1.5 py-0.5 rounded-md bg-gray-100 text-gray-500 text-[8px] font-black uppercase tracking-widest">
                                        {t('beds.pool.chip') || 'Pool'} {room.pool_occupied || 0}/{room.pool_beds}
                                    </div>
                                )}
                                {Number(room.blocked) ? (
                                    <div className="max-w-full truncate px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-800 text-[8px] font-black uppercase tracking-widest" data-room-blocked="">
                                        <i className="fa-solid fa-lock mr-1" aria-hidden="true"></i>{t('room.blocked.chip') || 'Bloqueada'}
                                    </div>
                                ) : null}
                                {/* The class «Sugerir reparto» fixed for the whole room (2.21.0). */}
                                {(room.lock || []).length > 0 && (
                                    <div className="max-w-full truncate px-1.5 py-0.5 rounded-md bg-rose-50 text-rose-700 text-[8px] font-black uppercase tracking-widest" data-room-lock="" title={t('room.lock.title') || 'El reparto dejó esta habitación compartida para este género'}>
                                        <i className="fa-solid fa-lock mr-1" aria-hidden="true"></i>{t('room.lock.only') || 'Solo'} {lockText(room.lock, { F: t('room.lock.women') || 'Mujeres', M: t('room.lock.men') || 'Hombres' })}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        {selecting && (
                            <div className={`w-5 h-5 shrink-0 rounded-full flex items-center justify-center text-[8px] border-2 ${selected ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-gray-200 text-transparent'}`} aria-hidden="true">
                                <i className="fa-solid fa-check"></i>
                            </div>
                        )}
                        {room.notes && (
                            <div className="w-5 h-5 shrink-0 rounded-full bg-blue-50 flex items-center justify-center text-blue-400 group-hover/room:bg-blue-100 transition-colors" title={room.notes}>
                                <i className="fa-solid fa-info text-[8px]" aria-hidden="true"></i>
                            </div>
                        )}
                    </div>
                </div>

                {/* Who sleeps here: the first 3 names (wrapping, never cut to «Mar…»), then «+N». */}
                <ul className="space-y-0.5 min-w-0 w-full">
                    {shownNames.map((n, i) => (
                        <li key={i} className="text-sm leading-snug font-semibold text-gray-700 break-words line-clamp-2" title={n}>{n}</li>
                    ))}
                    {names.length > shownNames.length && (
                        <li className="text-[10px] font-bold text-gray-400">{fillVars(t('explorer.tile.more') || '+{n} más', { n: names.length - shownNames.length })}</li>
                    )}
                    {occ === 0 && (
                        <li className="text-[10px] font-bold text-gray-300 italic">{t('explorer.tile.empty') || 'Sin ocupantes'}</li>
                    )}
                </ul>

                <div className="space-y-3 w-full">
                    <div className="flex justify-between items-end">
                        <span className={`text-[10px] font-black uppercase tracking-widest ${isFull ? 'text-rose-500' : 'text-gray-400'}`}>
                            {isFull ? (t('explorer.tile.full') || 'Completa') : (t('explorer.tile.free') || 'Libre')}
                        </span>
                        <span className="text-xs font-bold text-gray-900">
                            {room.occupied || 0}<span className="text-gray-300">/</span>{room.capacity}
                        </span>
                    </div>

                    <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden" aria-hidden="true">
                        <div
                            className={`h-full rounded-full transition-all duration-500 ${isFull ? 'bg-rose-500' : 'bg-blue-500'}`}
                            style={{ width: `${occupancyPercent}%` }}
                        ></div>
                    </div>
                </div>
            </Body>
            {onSplit && <button
                type="button"
                onClick={onSplit}
                title={t('beds.split.open') || 'Repartir camas'}
                aria-label={`${t('beds.split.open') || 'Repartir camas'} ${room.room_number}`}
                className={`absolute top-4 ${onDelete ? 'right-11 sm:right-12' : 'right-4 sm:right-5'} sm:top-5 z-10 w-6 h-6 rounded-full flex items-center justify-center text-gray-300 hover:text-violet-600 hover:bg-violet-50 transition-colors opacity-0 group-hover/room:opacity-100 group-focus-within/room:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 [@media(hover:none)]:opacity-100`}
            >
                <i className="fa-solid fa-people-arrows text-[10px]" aria-hidden="true"></i>
            </button>}
            {onDelete && <button
                type="button"
                onClick={onDelete}
                title={t('delete.room') || 'Eliminar habitación'}
                aria-label={`${t('delete.room') || 'Eliminar habitación'} ${room.room_number}`}
                className="absolute top-4 right-4 sm:top-5 sm:right-5 z-10 w-6 h-6 rounded-full flex items-center justify-center text-gray-300 hover:text-rose-600 hover:bg-rose-50 transition-colors opacity-0 group-hover/room:opacity-100 group-focus-within/room:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 [@media(hover:none)]:opacity-100"
            >
                <i className="fa-solid fa-trash-can text-[9px]" aria-hidden="true"></i>
            </button>}
        </div>
    );
}

// Lodging Component
// `onOpenExplorer`: a room tile (outside selection mode) or a hotel's «Ver ocupación» opens the lodging
// explorer in «Asignación» at that hotel / room (see ConferenceManagerContent.openLodgingExplorer).
// «Repartir camas» (2.18.0): how many beds of ONE room each location gets. The rest are pool beds (the
// admin's conference-wide assignment). Every bed to one location = its whole room; none = a pool room.
// The server refuses (409) a split the room's occupants would not fit; the message surfaces as a toast.
function RoomBedsSheet({ room, locations, onClose, onSaved }: { room: Room; locations: Location[]; onClose: () => void; onSaved: (result: unknown) => void }) {
    const { t } = useI18n();
    const tx = useTx();
    const { addToast } = useToast();
    const { confirm } = useModal();
    const cap = room.capacity || 0;
    const initial = useMemo(() => {
        const m: Record<number, number> = {};
        if (room.location_id != null) m[Number(room.location_id)] = cap;
        for (const s of room.shares || []) m[Number(s.location_id)] = Number(s.beds) || 0;
        return m;
    }, [room, cap]);
    const [beds, setBeds] = useState<Record<number, number>>(initial);
    const [busy, setBusy] = useState(false);
    // The class «Sugerir reparto» fixed (2.21.0), and the admin's «Liberarla».
    // In a sentence: «para hombres» (the words in lower case; any other value as the form spells it).
    const lockLabel = lockText(room.lock, { F: tx('room.lock.women', 'Mujeres').toLowerCase(), M: tx('room.lock.men', 'Hombres').toLowerCase() });
    const [release, setRelease] = useState(false);
    const given = Object.values(beds).reduce((n, v) => n + (Number(v) || 0), 0);
    const pool = cap - given;
    const owners = Object.entries(beds).filter(([, v]) => v > 0);
    const wholeOf = owners.length === 1 && owners[0][1] === cap ? locations.find(l => Number(l.id) === Number(owners[0][0])) : null;
    const step = (id: number, delta: number) => setBeds(prev => {
        const next = Math.max(0, Math.min(cap, (prev[id] || 0) + delta));
        return { ...prev, [id]: next };
    });
    const save = async () => {
        if (busy || given > cap) return;
        const shares = Object.entries(beds).map(([id, v]) => ({ location_id: Number(id), beds: Math.max(0, Math.floor(Number(v) || 0)) })).filter(s => s.beds > 0);
        // A submitted / validated arrangement whose beds in this room change (2.17.0 adjustments).
        const changed = [...new Set([...Object.keys(initial), ...Object.keys(beds)].map(Number))].filter(id => (initial[id] || 0) !== (beds[id] || 0));
        const adjustNote = adjustConfirmText(tx, reviewedLocationsAmong([], locations, changed));
        if (adjustNote && !await confirm(adjustNote, tx('beds.split.save', 'Guardar reparto'), false)) return;
        setBusy(true);
        try {
            const result = await conferenceApi.setRoomBeds(room.id, shares, release ? { release_lock: true } : undefined);
            onSaved(result);
        } catch (e: any) {
            addToast(e?.message || 'Error', 'error');
        } finally {
            setBusy(false);
        }
    };
    return (
        <Overlay layer={1}>
            <div role="dialog" aria-modal="true" aria-labelledby="beds-split-title" className="bg-white rounded-[32px] shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-h-[90dvh]">
                <div className="bg-gray-50/50 px-6 sm:px-8 py-5 border-b border-gray-100 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <h3 id="beds-split-title" className="font-black text-xl text-gray-900 italic tracking-tighter">{tx('beds.split.title', 'Repartir camas de la habitación {n}', { n: room.room_number })}</h3>
                        <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">
                            {tx('beds.split.summary', 'Capacidad {cap} · Repartidas {given} · Pool {pool}', { cap, given, pool: Math.max(0, pool) })}
                        </p>
                    </div>
                    <button type="button" onClick={onClose} aria-label={t('cancel') || 'Cancelar'} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-2xl shrink-0">
                        <i className="fa-solid fa-xmark text-xl"></i>
                    </button>
                </div>
                <div className="px-6 sm:px-8 py-4 overflow-y-auto space-y-2">
                    <p className="text-[11px] text-gray-500 font-medium">{tx('beds.split.hint', 'Cada localidad llena solo sus camas con su gente; las camas del pool las usa la asignación del admin.')}</p>
                    {lockLabel && (
                        <div className="rounded-2xl border-2 border-rose-100 bg-rose-50/50 px-3 py-2.5 space-y-2" data-beds-lock="">
                            <p className="text-[11px] font-bold text-rose-800">
                                <i className="fa-solid fa-lock mr-1.5" aria-hidden="true"></i>
                                {tx('beds.lock.text', 'El reparto sugerido dejó esta habitación compartida para {v}: ni el motor, ni los encargados, ni el admin pueden acomodar aquí a otra persona.', { v: lockLabel })}
                            </p>
                            <label className="flex items-center gap-2 text-[11px] font-bold text-gray-700 cursor-pointer">
                                <input type="checkbox" checked={release} onChange={e => setRelease(e.target.checked)} disabled={busy} className="w-4 h-4 shrink-0 accent-rose-600" data-beds-lock-release="" />
                                {tx('beds.lock.release', 'Liberarla: que cualquiera pueda ocupar sus camas libres')}
                            </label>
                        </div>
                    )}
                    {locations.length === 0 && <p className="text-xs text-gray-400 italic">{t('allot.no.locations') || 'Crea una localidad para poder asignarle habitaciones.'}</p>}
                    {locations.map(l => {
                        const n = beds[Number(l.id)] || 0;
                        return (
                            <div key={l.id} className={`flex items-center justify-between gap-3 px-3 py-2 rounded-2xl border-2 ${n > 0 ? 'border-violet-200 bg-violet-50/40' : 'border-gray-100'}`}>
                                <span className="text-sm font-bold text-gray-800 truncate min-w-0" title={l.name}>{l.name}</span>
                                <div className="flex items-center gap-2 shrink-0">
                                    <button type="button" onClick={() => step(Number(l.id), -1)} disabled={n <= 0 || busy}
                                        aria-label={tx('beds.split.less', 'Una cama menos para {name}', { name: l.name })}
                                        className="w-9 h-9 shrink-0 rounded-xl border-2 border-gray-100 text-gray-500 hover:border-violet-300 disabled:opacity-30 flex items-center justify-center">
                                        <i className="fa-solid fa-minus text-[10px]"></i>
                                    </button>
                                    <span className="w-6 text-center font-black text-gray-900 tabular-nums" aria-live="polite">{n}</span>
                                    <button type="button" onClick={() => step(Number(l.id), 1)} disabled={pool <= 0 || busy}
                                        aria-label={tx('beds.split.more', 'Una cama más para {name}', { name: l.name })}
                                        className="w-9 h-9 shrink-0 rounded-xl border-2 border-gray-100 text-gray-500 hover:border-violet-300 disabled:opacity-30 flex items-center justify-center">
                                        <i className="fa-solid fa-plus text-[10px]"></i>
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                    {given > cap && <p className="text-xs font-bold text-rose-600">{tx('beds.split.over', 'El reparto supera la capacidad de la habitación.')}</p>}
                    {given === 0 && <p className="text-[11px] font-bold text-gray-400">{tx('beds.split.pool', 'La habitación queda en el pool.')}</p>}
                    {wholeOf && <p className="text-[11px] font-bold text-indigo-600">{tx('beds.split.whole', 'La habitación será entera de {name}.', { name: wholeOf.name })}</p>}
                </div>
                <div className="px-6 sm:px-8 py-4 border-t border-gray-100 flex justify-end gap-2">
                    <button type="button" onClick={onClose} className="px-5 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest border-2 border-gray-100 text-gray-500 hover:border-gray-300">{t('cancel') || 'Cancelar'}</button>
                    <button type="button" onClick={save} disabled={busy || given > cap}
                        className="px-5 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest bg-gray-900 text-white hover:bg-violet-600 disabled:opacity-50 flex items-center gap-2">
                        {busy && <i className="fa-solid fa-spinner animate-spin text-[10px]"></i>}{tx('beds.split.save', 'Guardar reparto')}
                    </button>
                </div>
            </div>
        </Overlay>
    );
}

function LodgingPage({ conferenceId, onOpenExplorer }: { conferenceId: number; onOpenExplorer?: (focus: { hotelId: number; roomId?: number | null }) => void }) {
    const { t, language } = useI18n(); // Get t() function
    const fe = useFieldErrors(language);
    const tx = useTx();
    const { addToast } = useToast();
    const { currentConference: lodgingConf } = useConference();
    // Hospedaje › gestionar = hotels, rooms and their allotment to locations; Reportes = the Excel files.
    const perms = usePerms();
    const canManage = perms.can('lodging', 'manage');
    const canExcel = perms.can('reports');
    const [reportBusy, setReportBusy] = useState<number | 'all' | null>(null);
    const hotelReport = async (hotelId: number | null) => {
        setReportBusy(hotelId ?? 'all');
        try { await downloadHotelReport(conferenceId, lodgingConf?.slug, hotelId, perms.can('inscriptions')); }
        catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setReportBusy(null); }
    };
    const { confirm } = useModal();
    const [hotels, setHotels] = useState<Hotel[]>([]);
    const [loading, setLoading] = useState(true);
    const [showHotelModal, setShowHotelModal] = useState(false);
    const [showRoomModal, setShowRoomModal] = useState<number | null>(null);
    const [hotelForm, setHotelForm] = useState<Partial<Hotel>>({ name: '', address: '', capacity: 0, location: '' });
    // The hotel being edited (2.23.0: name, address, capacity and its position for «Mi inscripción»'s map), or null = new.
    const [editHotelId, setEditHotelId] = useState<number | null>(null);
    const openHotelForm = (hotel: Hotel | null) => {
        setEditHotelId(hotel ? hotel.id : null);
        setHotelForm(hotel ? { name: hotel.name, address: hotel.address || '', capacity: hotel.capacity || 0, location: hotel.geo || '' } : { name: '', address: '', capacity: 0, location: '' });
        setShowHotelModal(true);
    };
    const [roomForm, setRoomForm] = useState<Partial<Room>>({ room_number: '', capacity: 2, notes: '' });
    const [isBulk, setIsBulk] = useState(false);
    const [bulkConfig, setBulkConfig] = useState({ start: 1, end: 10, prefix: '' });
    // A room batch in flight: the submit button shows «Creando n/N» and a second tap starts nothing (one
    // request per room took a few seconds, and every extra tap used to start the whole batch again).
    const [roomBusy, setRoomBusy] = useState<null | { done: number; total: number }>(null);
    const roomBusyRef = useRef(false);
    // Allotment of rooms to locations: the locations of the conference, the location picked per hotel
    // ('' = pool), the hotel whose tiles are in selection mode and the selected room ids.
    const [locations, setLocations] = useState<Location[]>([]);
    const [allotTarget, setAllotTarget] = useState<Record<number, string>>({});
    const [selectHotel, setSelectHotel] = useState<number | null>(null);
    // The hotel entered (2.21.0): the page lists the hotels; a hotel's rooms show only once it is entered.
    const [openHotelId, setOpenHotelId] = useState<number | null>(null);
    const enterHotel = (id: number | null) => { setOpenHotelId(id); setSelectHotel(null); if (typeof window !== 'undefined') window.scrollTo({ top: 0 }); };
    const [selectedRooms, setSelectedRooms] = useState<Set<number>>(new Set());
    const [allotting, setAllotting] = useState<number | null>(null);
    // «Camas por localidad» (2.18.0): the room whose split is open, and the per-hotel «Dar camas» form.
    const [splitRoom, setSplitRoom] = useState<Room | null>(null);
    // «Sugerir reparto» (2.20.0): the allotment suggestion sheet.
    const [showPlan, setShowPlan] = useState(false);
    const [bedsTarget, setBedsTarget] = useState<Record<number, string>>({});
    const [bedsCount, setBedsCount] = useState<Record<number, string>>({});
    const [givingBeds, setGivingBeds] = useState<number | null>(null);
    // Who sleeps in each room, for the names on the tiles. A failed load only hides the names: the
    // counts keep coming from GET /hotels (room.occupied). Only the latest of overlapping loads lands.
    const [people, setPeople] = useState<Inscription[]>([]);
    const [formFields, setFormFields] = useState<ConferenceField[]>([]);
    const peopleSeq = useRef(0);
    const occupantsByRoom = useMemo(() => indexOccupants(people), [people]);

    const fetchPeople = async () => {
        if (!conferenceId) return;
        const seq = ++peopleSeq.current;
        try {
            const [ins, flds] = await Promise.all([conferenceApi.getInscriptions(conferenceId), conferenceApi.getFields(conferenceId)]);
            if (seq !== peopleSeq.current) return;
            setPeople(ins || []);
            setFormFields(flds || []);
        } catch (e) {
            console.error(e);
        }
    };

    // `quiet`: refresh in place, without the spinner that replaces the list (and loses the scroll position).
    const fetchHotels = async (quiet = false) => {
        if (!conferenceId) return;
        if (!quiet) setLoading(true);
        try {
            const data = await conferenceApi.getHotels(conferenceId);
            setHotels(data);
        } catch (e) {
            console.error(e);
        } finally {
            if (!quiet) setLoading(false);
        }
    };

    const fetchLocations = async () => {
        if (!conferenceId) return;
        try {
            const data = await conferenceApi.getLocations(conferenceId);
            setLocations(data?.locations || []);
        } catch (e) {
            console.error(e);
        }
    };

    useEffect(() => {
        fetchHotels();
        fetchLocations();
        fetchPeople();
    }, [conferenceId]);

    // Allot the whole hotel, or only the selected tiles, to the location picked in that hotel's select.
    // The server refuses it (409) when an occupant belongs to another location; that message surfaces as a
    // toast untouched. A submitted / validated location on either side is no refusal (2.17.0): the change
    // goes through as an administration adjustment, and the confirmation says so first.
    const applyAllot = async (hotel: Hotel, roomIds?: number[]) => {
        const raw = allotTarget[hotel.id] || '';
        const locationId = raw === '' ? null : Number(raw);
        if (roomIds && roomIds.length === 0) { addToast(t('allot.none.selected') || 'Selecciona al menos una habitación.', 'warning'); return; }
        // A submitted / validated arrangement on either side of the rooms that change hands (2.17.0): the
        // change goes through and is recorded as an administration adjustment — say so before it does.
        // A shared room (2.18.0) changes hands too: it becomes a whole room (or a pool room) and its sharers
        // lose their beds there.
        const isShared = (r: Room) => r.location_id == null && (r.shares || []).length > 0;
        const changing = (hotel.rooms || []).filter(r => (!roomIds || roomIds.includes(r.id)) && ((r.location_id == null ? null : Number(r.location_id)) !== locationId || isShared(r)));
        const sharers = changing.flatMap(r => (r.shares || []).map(s => Number(s.location_id)));
        const adjustNote = adjustConfirmText(tx, reviewedLocationsAmong(changing, locations, changing.length ? [locationId, ...sharers] : []));
        const sharedChanging = changing.filter(isShared);
        // The select defaults to the pool: a stray click on "Aplicar" would silently take every allotted
        // room of the hotel away from its coordinators — confirm when the click actually un-allots one.
        if (locationId === null) {
            const affected = (hotel.rooms || []).filter(r => (r.location_id != null || isShared(r)) && (!roomIds || roomIds.includes(r.id)));
            // The adjustment sentence goes BEFORE the closing question («… {adjust} ¿Continuar?»).
            const sharedNote = sharedChanging.length
                ? tx('allot.confirm.pool.shared', 'Las camas repartidas entre localidades ({rooms}) también vuelven al pool.', { rooms: sharedChanging.map(r => r.room_number).join(', ') })
                : '';
            const fullAdjust = [sharedNote, adjustNote].filter(Boolean).join(' ');
            const poolText = fullAdjust
                ? tx('allot.confirm.pool.adjust', 'Se devolverán al pool las habitaciones de este hotel ya asignadas a una localidad; sus encargados dejarán de verlas. {adjust} ¿Continuar?', { adjust: fullAdjust })
                : (t('allot.confirm.pool') || 'Se devolverán al pool las habitaciones de este hotel ya asignadas a una localidad; sus encargados dejarán de verlas. ¿Continuar?');
            if (affected.length > 0 && !await confirm(poolText, t('allot.apply.hotel') || 'Aplicar', true)) return;
        } else if (sharedChanging.length) {
            // A whole allotment replaces the split of every shared room it covers — say so before it does.
            const target = locations.find(l => Number(l.id) === locationId);
            const text = tx('allot.confirm.shared', 'Las habitaciones repartidas por camas ({rooms}) pasarán a ser enteras de «{name}»; las demás localidades pierden sus camas en ellas.', { rooms: sharedChanging.map(r => r.room_number).join(', '), name: target ? target.name : '' });
            if (!await confirm(adjustNote ? `${text} ${adjustNote}` : text, t('allot.apply.hotel') || 'Aplicar', true)) return;
        } else if (adjustNote && !await confirm(adjustNote, t('allot.apply.hotel') || 'Aplicar', false)) return;
        setAllotting(hotel.id);
        try {
            const result = await conferenceApi.allotHotel(hotel.id, roomIds ? { location_id: locationId, room_ids: roomIds } : { location_id: locationId });
            addToast(withAdjusted(tx, t('allot.done') || 'Habitaciones actualizadas', result), 'success');
            if (selectHotel === hotel.id) { setSelectHotel(null); setSelectedRooms(new Set()); }
            fetchHotels();
            fetchLocations();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        } finally {
            setAllotting(null);
        }
    };

    // Give the picked location N free beds of this hotel: empty rooms whole first, then shared beds.
    const giveBeds = async (hotel: Hotel) => {
        if (givingBeds !== null) return;
        const locationId = Number(bedsTarget[hotel.id] || 0);
        const n = Math.floor(Number(bedsCount[hotel.id] || 0));
        const location = locations.find(l => Number(l.id) === locationId);
        if (!location || !(n >= 1)) { addToast(tx('beds.give.pick', 'Elige la localidad y cuántas camas.'), 'warning'); return; }
        const adjustNote = adjustConfirmText(tx, reviewedLocationsAmong([], locations, [locationId]));
        if (adjustNote && !await confirm(adjustNote, tx('beds.give.apply', 'Dar camas'), false)) return;
        setGivingBeds(hotel.id);
        try {
            const result = await conferenceApi.giveLocationBeds(locationId, { beds: n, hotel_id: hotel.id });
            const sharedBeds = (result.shared_rooms || []).reduce((sum, r) => sum + (Number(r.added) || 0), 0);
            const wholeRooms = (result.whole_rooms || []).length;
            // «4 camas a Malambo: 1 habitación entera» — singular / plural, and no «0 …» part.
            const parts = [
                wholeRooms ? (wholeRooms === 1 ? tx('beds.give.part.whole.one', '1 habitación entera') : tx('beds.give.part.whole', '{n} habitaciones enteras', { n: wholeRooms })) : '',
                sharedBeds ? (sharedBeds === 1 ? tx('beds.give.part.shared.one', '1 cama en una habitación compartida') : tx('beds.give.part.shared', '{n} camas en habitaciones compartidas', { n: sharedBeds })) : '',
            ].filter(Boolean).join(tx('beds.give.part.and', ' y '));
            const done = n === 1
                ? tx('beds.give.done.one', '1 cama para {name}: {parts}.', { name: location.name, parts })
                : tx('beds.give.done', '{n} camas para {name}: {parts}.', { n, name: location.name, parts });
            addToast(withAdjusted(tx, done, result), 'success');
            setBedsCount(prev => ({ ...prev, [hotel.id]: '' }));
            fetchHotels(true);
            fetchLocations();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        } finally {
            setGivingBeds(null);
        }
    };

    const toggleSelectMode = (hotel: Hotel) => {
        if (selectHotel === hotel.id) { setSelectHotel(null); setSelectedRooms(new Set()); return; }
        setSelectHotel(hotel.id);
        setSelectedRooms(new Set());
    };

    const toggleRoomSelected = (roomId: number) => {
        setSelectedRooms(prev => {
            const next = new Set(prev);
            if (next.has(roomId)) next.delete(roomId); else next.add(roomId);
            return next;
        });
    };

    const handleHotelSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!conferenceId) return;
        const geo = parseGeo(hotelForm.location);
        if (!geo.ok && geo.code !== 'empty') { addToast(GEO_MESSAGES[geo.code], 'error'); return; }
        const data = { name: hotelForm.name, address: hotelForm.address, capacity: Number(hotelForm.capacity) || 0, location: geo.ok ? geo.geo : '' };
        try {
            if (editHotelId) await conferenceApi.updateHotel(editHotelId, data);
            else await conferenceApi.createHotel(conferenceId, data);
            setShowHotelModal(false);
            setEditHotelId(null);
            setHotelForm({ name: '', address: '', capacity: 0, location: '' });
            fetchHotels();
            addToast(editHotelId ? (tx('hotel.updated', 'Hotel actualizado')) : t('hotel.created'), 'success');
        } catch (error: any) {
            addToast(error.message || 'Error creating hotel', 'error');
        }
    };

    const handleDeleteHotel = async (hotel: Hotel) => {
        // The rooms' owners, and whoever sleeps in them: a pool room's occupant belongs to their location's
        // arrangement too (the server stamps both).
        const adjustNote = adjustConfirmText(tx, reviewedLocationsAmong(hotel.rooms, locations, [...occupantLocationIds(hotel.rooms, occupantsByRoom), ...(hotel.rooms || []).flatMap(r => (r.shares || []).map(s => Number(s.location_id)))]));
        if (!await confirm(`${t('confirm.delete.hotel') || '¿Eliminar el hotel'} "${hotel.name}"? ${t('delete.hotel.warning') || 'Se eliminarán sus habitaciones y se liberarán los huéspedes.'}${adjustNote ? ` ${adjustNote}` : ''}`, t('delete.hotel') || 'Eliminar hotel', true)) return;
        try {
            const result = await conferenceApi.deleteHotel(hotel.id);
            addToast(withAdjusted(tx, t('hotel.deleted') || 'Hotel eliminado', result), 'success');
            fetchHotels();
            fetchPeople();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        }
    };

    const handleDeleteRoom = async (room: Room) => {
        const adjustNote = adjustConfirmText(tx, reviewedLocationsAmong([room], locations, [...occupantLocationIds([room], occupantsByRoom), ...(room.shares || []).map(s => Number(s.location_id))]));
        if (!await confirm(`${t('confirm.delete.room') || '¿Eliminar la habitación'} ${room.room_number}?${adjustNote ? ` ${adjustNote}` : ''}`, t('delete.room') || 'Eliminar habitación', true)) return;
        try {
            const result = await conferenceApi.deleteRoom(room.id);
            addToast(withAdjusted(tx, t('room.deleted') || 'Habitación eliminada', result), 'success');
            fetchHotels();
            fetchPeople();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        }
    };

    const handleRoomSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!showRoomModal || roomBusyRef.current) return;
        roomBusyRef.current = true;
        const isDuplicate = (error: any) => error?.code === 'duplicate_room' || error?.status === 409;
        try {
            if (isBulk) {
                const start = Number(bulkConfig.start);
                const end = Number(bulkConfig.end);

                if (start > end) throw new Error(tx('rooms.range.invalid', 'El número inicial no puede ser mayor que el final.'));
                if (end - start + 1 > 100) throw new Error(tx('rooms.range.max', 'Máximo 100 habitaciones a la vez.'));

                const total = end - start + 1;
                let created = 0;
                const skipped: string[] = [];
                setRoomBusy({ done: 0, total });
                for (let i = start; i <= end; i++) {
                    const roomNumber = `${bulkConfig.prefix}${i}`;
                    try {
                        await conferenceApi.createRoom({
                            ...roomForm,
                            hotel_id: showRoomModal,
                            room_number: roomNumber
                        });
                        created++;
                    } catch (error: any) {
                        // A number the hotel already has is skipped, not created twice.
                        if (!isDuplicate(error)) throw error;
                        skipped.push(roomNumber);
                    }
                    setRoomBusy({ done: i - start + 1, total });
                }
                if (skipped.length) {
                    addToast(tx('rooms.created.skipped', '{created} habitaciones creadas. {skipped} ya existían en este hotel: {list}.', { created, skipped: skipped.length, list: skipped.slice(0, 10).join(', ') + (skipped.length > 10 ? '…' : '') }), created ? 'success' : 'info');
                } else {
                    addToast(t('rooms.created'), 'success');
                }
            } else {
                setRoomBusy({ done: 0, total: 1 });
                await conferenceApi.createRoom({ ...roomForm, hotel_id: showRoomModal });
                addToast(t('room.created'), 'success');
            }

            setShowRoomModal(null);
            setRoomForm({ room_number: '', capacity: 2, notes: '' });
            setIsBulk(false);
            fetchHotels();
        } catch (error: any) {
            addToast(error.message || 'Error creating room', 'error');
            fetchHotels();
        } finally {
            roomBusyRef.current = false;
            setRoomBusy(null);
        }
    };

    return (
        <div className="space-y-10 animate-in fade-in duration-500">
            <ReadOnlyNotice section="lodging" />
            {showPlan && <LodgingPlan conferenceId={conferenceId} hotels={hotels} onClose={() => setShowPlan(false)} onApplied={() => { fetchHotels(true); fetchPeople(); }} />}
            <div className="flex flex-wrap items-center justify-between gap-4 bg-gray-50/50 p-5 sm:p-8 rounded-[32px] border-2 border-white shadow-sm">
                <div className="min-w-0">
                    <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter">{t('hotels.and.rooms')}</h2>
                    <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">Gestión de alojamiento y disponibilidad</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                {canExcel && <button
                    onClick={() => hotelReport(null)}
                    disabled={reportBusy !== null}
                    className="bg-white border-2 border-gray-100 text-emerald-700 px-6 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:border-emerald-500 transition-all flex items-center gap-2 disabled:opacity-50"
                >
                    <i className={`fa-solid ${reportBusy === 'all' ? 'fa-spinner animate-spin' : 'fa-file-excel'} text-[10px]`}></i> {t('excel.hotels') || 'Reporte de hoteles (Excel)'}
                </button>}
                {canManage && hotels.length > 0 && <button
                    onClick={() => setShowPlan(true)}
                    className="bg-white border-2 border-gray-100 text-blue-700 px-6 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:border-blue-500 transition-all flex items-center gap-2"
                    data-plan-open=""
                >
                    <i className="fa-solid fa-wand-magic-sparkles text-[10px]"></i> {tx('plan.open', 'Sugerir reparto')}
                </button>}
                {canManage && <button
                    onClick={() => openHotelForm(null)}
                    className="bg-gray-900 text-white px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-blue-600 transition-all duration-500 shadow-xl hover:shadow-blue-500/30 flex items-center gap-3 transform active:scale-95 translate-y-0 hover:-translate-y-1"
                >
                    <i className="fa-solid fa-plus text-[8px]"></i> {t('add.hotel')}
                </button>}
                </div>
            </div>

            {loading ? (
                <div className="flex-1 flex flex-col justify-center items-center py-20 bg-white rounded-3xl border border-gray-100">
                    <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                    <p className="text-gray-400 mt-4 text-xs font-bold uppercase tracking-widest">{t('loading.lodging')}</p>
                </div>
            ) : (() => {
                // A hotel deleted while entered: back to the list.
                const open = openHotelId == null ? null : hotels.find(h => h.id === openHotelId) || null;
                return (open ? [open] : hotels).map(hotel => (
                <div key={hotel.id} className="group bg-white rounded-[40px] border-2 border-gray-50 overflow-hidden shadow-sm hover:border-blue-500 hover:shadow-2xl transition-all duration-500 relative" data-hotel-card={hotel.id} data-hotel-entered={open ? '' : undefined}>
                    {open && (
                        <div className="relative px-4 sm:px-8 pt-5">
                            <button type="button" onClick={() => enterHotel(null)} data-hotels-back=""
                                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gray-50 border border-gray-100 text-[10px] font-black uppercase tracking-widest text-gray-600 hover:bg-gray-900 hover:text-white transition-all">
                                <i className="fa-solid fa-arrow-left text-[9px]" aria-hidden="true"></i> {tx('hotels.back', 'Todos los hoteles')}
                            </button>
                        </div>
                    )}
                    <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-br from-blue-50 to-transparent rounded-bl-[100px] opacity-50 pointer-events-none"></div>

                    <div className="relative p-5 sm:p-8 border-b border-gray-50 flex flex-col md:flex-row md:flex-wrap justify-between items-start md:items-center gap-6">
                        <div className="flex items-center gap-4 sm:gap-6 min-w-0">
                            <div className="w-20 h-20 shrink-0 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl shadow-inner flex items-center justify-center text-blue-600 text-3xl group-hover:scale-110 transition-transform duration-500">
                                <i className="fa-solid fa-hotel"></i>
                            </div>
                            <div className="min-w-0">
                                <h3 className="text-3xl font-black text-gray-900 italic tracking-tighter leading-none mb-2" style={{ overflowWrap: 'anywhere' }}>{hotel.name}</h3>
                                <div className="flex flex-wrap items-center gap-4">
                                    <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-100">
                                        <i className="fa-solid fa-location-dot text-[10px] text-gray-400"></i>
                                        <span className="text-xs font-bold text-gray-600 uppercase tracking-widest">{hotel.address}</span>
                                    </div>
                                    <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 rounded-lg border border-blue-100 text-blue-600">
                                        <i className="fa-solid fa-users text-[10px]"></i>
                                        <span className="text-xs font-black uppercase tracking-widest">
                                            {t('capacity')}: {hotel.rooms?.reduce((acc, r) => acc + (r.capacity || 0), 0) || 0}
                                        </span>
                                    </div>
                                    {/* 2.23.0: the position the guests' map uses — or a hint that it is missing. */}
                                    {hotel.geo ? (
                                        <a href={mapsUrl(hotel.geo)} target="_blank" rel="noopener noreferrer" data-hotel-map={hotel.id}
                                            className="flex items-center gap-2 px-3 py-1.5 bg-emerald-50 rounded-lg border border-emerald-100 text-emerald-700 text-xs font-black uppercase tracking-widest hover:bg-emerald-100">
                                            <i className="fa-solid fa-map-location-dot text-[10px]" aria-hidden="true"></i>{tx('hotel.location.set', 'En el mapa')}
                                        </a>
                                    ) : (
                                        <span className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 rounded-lg border border-amber-100 text-amber-700 text-xs font-black uppercase tracking-widest" data-hotel-nomap={hotel.id}>
                                            <i className="fa-solid fa-map-location-dot text-[10px]" aria-hidden="true"></i>{tx('hotel.location.missing', 'Sin ubicación')}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                            {onOpenExplorer && (
                                <button
                                    onClick={() => onOpenExplorer({ hotelId: hotel.id })}
                                    className="bg-gray-900 text-white px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-600 transition-all flex items-center gap-2 shadow-sm focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-200"
                                >
                                    <i className="fa-solid fa-door-open text-[10px]"></i> {t('explorer.hotel.view') || 'Ver ocupación'}
                                </button>
                            )}
                            {canManage && <button
                                type="button" onClick={() => openHotelForm(hotel)} data-hotel-edit={hotel.id}
                                className="bg-white border-2 border-gray-100 px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest text-gray-500 hover:border-blue-500 hover:text-blue-600 transition-all flex items-center gap-2 shadow-sm"
                            >
                                <i className="fa-solid fa-pen text-[9px]" aria-hidden="true"></i> {tx('hotel.edit.short', 'Editar')}
                            </button>}
                            {canManage && <button
                                onClick={() => setShowRoomModal(hotel.id)}
                                className="bg-white border-2 border-gray-100 px-6 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest text-gray-500 hover:border-blue-500 hover:text-white hover:bg-blue-600 transition-all flex items-center gap-2 shadow-sm"
                            >
                                <i className="fa-solid fa-plus text-[8px]"></i> {t('add.room')}
                            </button>}
                            {canExcel && <button
                                onClick={() => hotelReport(hotel.id)}
                                disabled={reportBusy !== null}
                                title={t('excel.hotel.one') || 'Excel de este hotel'}
                                className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl bg-white border-2 border-gray-100 text-emerald-600 hover:border-emerald-400 hover:bg-emerald-600 hover:text-white transition-all disabled:opacity-50"
                            >
                                <i className={`fa-solid ${reportBusy === hotel.id ? 'fa-spinner animate-spin' : 'fa-file-excel'} text-xs`}></i>
                            </button>}
                            {canManage && <button
                                onClick={() => handleDeleteHotel(hotel)}
                                title={t('delete.hotel') || 'Eliminar hotel'}
                                className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl bg-white border-2 border-gray-100 text-gray-400 hover:border-rose-400 hover:bg-rose-600 hover:text-white transition-all shadow-sm"
                            >
                                <i className="fa-solid fa-trash-can text-xs"></i>
                            </button>}
                        </div>
                    </div>

                    {open ? (
                    <div className="p-4 sm:p-8 bg-gray-50/30">
                        {canManage && (hotel.rooms && hotel.rooms.length > 0) && (
                            <div className="mb-6 p-4 bg-white rounded-2xl border border-gray-100 shadow-sm flex flex-col lg:flex-row lg:items-center gap-3">
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-500 flex items-center justify-center text-sm shrink-0">
                                        <i className="fa-solid fa-map-location-dot"></i>
                                    </div>
                                    <div className="min-w-0">
                                        <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{t('allot.title') || 'Asignar habitaciones a localidad'}</div>
                                        {locations.length === 0 && <div className="text-[10px] text-gray-400">{t('allot.no.locations') || 'Crea una localidad para poder asignarle habitaciones.'}</div>}
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
                                    <Select
                                        value={allotTarget[hotel.id] || ''}
                                        onChange={e => setAllotTarget({ ...allotTarget, [hotel.id]: e.target.value })}
                                        className="border-2 border-gray-100 rounded-xl px-3 py-2 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-xs"
                                    >
                                        <option value="">{t('allot.pool') || 'Sin asignar (pool)'}</option>
                                        {locations.map(l => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                                    </Select>
                                    <button
                                        type="button"
                                        disabled={allotting === hotel.id}
                                        onClick={() => applyAllot(hotel)}
                                        className="px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest bg-gray-900 text-white hover:bg-indigo-600 transition-all disabled:opacity-50 flex items-center gap-2"
                                    >
                                        <i className="fa-solid fa-hotel text-[8px]"></i> {t('allot.apply.hotel') || 'Aplicar a todo el hotel'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => toggleSelectMode(hotel)}
                                        className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border-2 transition-all flex items-center gap-2 ${selectHotel === hotel.id ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-100 bg-white text-gray-500 hover:border-indigo-300'}`}
                                    >
                                        <i className={`fa-solid ${selectHotel === hotel.id ? 'fa-xmark' : 'fa-object-group'} text-[8px]`}></i>
                                        {selectHotel === hotel.id ? (t('allot.select.cancel') || 'Cancelar selección') : (t('allot.select.mode') || 'Seleccionar habitaciones')}
                                    </button>
                                    {selectHotel === hotel.id && (
                                        <button
                                            type="button"
                                            disabled={allotting === hotel.id || selectedRooms.size === 0}
                                            onClick={() => applyAllot(hotel, Array.from(selectedRooms))}
                                            className="px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest bg-indigo-600 text-white hover:bg-indigo-700 transition-all disabled:opacity-50 flex items-center gap-2"
                                        >
                                            <i className="fa-solid fa-check text-[8px]"></i> {t('allot.apply.selection') || 'Aplicar a la selección'} ({selectedRooms.size})
                                        </button>
                                    )}
                                </div>
                                {selectHotel === hotel.id && (
                                    <p className="w-full lg:w-auto lg:basis-full text-[10px] text-indigo-500 font-medium">{t('allot.hint') || 'Pulsa las habitaciones que quieras y aplica la localidad elegida a la selección.'}</p>
                                )}
                            </div>
                        )}
                        {canManage && (hotel.rooms && hotel.rooms.length > 0) && locations.length > 0 && (
                            <div className="-mt-3 mb-6 p-4 bg-white rounded-2xl border border-gray-100 shadow-sm flex flex-col lg:flex-row lg:items-center gap-3">
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className="w-9 h-9 rounded-xl bg-violet-50 text-violet-500 flex items-center justify-center text-sm shrink-0">
                                        <i className="fa-solid fa-bed"></i>
                                    </div>
                                    <div className="min-w-0">
                                        <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{tx('beds.give.title', 'Dar camas a una localidad')}</div>
                                        <div className="text-[10px] text-gray-400">{tx('beds.give.hint', 'Usa camas libres de este hotel: primero habitaciones vacías enteras; si faltan, comparte una habitación.')}</div>
                                    </div>
                                </div>
                                <form
                                    className="flex flex-wrap items-center gap-2 lg:ml-auto"
                                    {...fe.form(e => { e.preventDefault(); giveBeds(hotel); })}
                                >
                                    <Select
                                        value={bedsTarget[hotel.id] || ''}
                                        onChange={e => setBedsTarget({ ...bedsTarget, [hotel.id]: e.target.value })}
                                        aria-label={tx('beds.give.location', 'Localidad')}
                                        className="min-w-0 max-w-full border-2 border-gray-100 rounded-xl px-3 py-2 bg-gray-50/30 focus:bg-white focus:border-violet-500 transition-all outline-none text-gray-900 font-medium text-xs"
                                    >
                                        <option value="">{tx('beds.give.location.pick', 'Elige localidad…')}</option>
                                        {locations.map(l => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                                    </Select>
                                    <input
                                        data-field="beds_count" aria-invalid={fe.invalid('beds_count')} aria-describedby={fe.describedBy('beds_count')}
                                        type="number"
                                        inputMode="numeric"
                                        min={1}
                                        max={5000}
                                        value={bedsCount[hotel.id] || ''}
                                        onChange={e => setBedsCount({ ...bedsCount, [hotel.id]: e.target.value })}
                                        placeholder={tx('beds.give.count', 'Camas')}
                                        aria-label={tx('beds.give.count', 'Camas')}
                                        className="w-24 border-2 border-gray-100 rounded-xl px-3 py-2 bg-gray-50/30 focus:bg-white focus:border-violet-500 transition-all outline-none text-gray-900 font-bold text-base sm:text-xs"
                                    />
                                    <button
                                        type="submit"
                                        disabled={givingBeds === hotel.id}
                                        className="px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest bg-violet-600 text-white hover:bg-violet-700 transition-all disabled:opacity-50 flex items-center gap-2"
                                    >
                                        <i className={`fa-solid ${givingBeds === hotel.id ? 'fa-spinner animate-spin' : 'fa-bed'} text-[8px]`}></i> {tx('beds.give.apply', 'Dar camas')}
                                    </button>
                                    <FieldError message={fe.error('beds_count')} id={fe.errorId('beds_count')} className="basis-full w-full" />
                                </form>
                            </div>
                        )}
                        {(!hotel.rooms || hotel.rooms.length === 0) ? (
                            <div className="flex flex-col items-center justify-center py-16 text-gray-300 border-2 border-dashed border-gray-200 rounded-3xl bg-white/50">
                                <i className="fa-solid fa-door-closed text-4xl mb-4 opacity-30"></i>
                                <p className="text-xs font-black uppercase tracking-widest opacity-60">{t('no.rooms')}</p>
                                {canManage && <p className="text-[10px] uppercase tracking-widest opacity-40 mt-1">Añade habitaciones para comenzar</p>}
                            </div>
                        ) : (
                            <>
                            {onOpenExplorer && selectHotel !== hotel.id && (
                                <p className="mb-3 text-[11px] text-gray-400 font-medium"><i className="fa-solid fa-hand-pointer mr-1.5"></i>{t('explorer.tile.hint') || 'Pulsa una habitación para ver quién duerme ahí y gestionar sus camas.'}</p>
                            )}
                            <div className="grid grid-cols-1 min-[440px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 sm:gap-4">
                                {hotel.rooms.map(room => {
                                    const selecting = selectHotel === hotel.id;
                                    // Outside selection mode a tile opens the explorer at this room; in it, it toggles the selection.
                                    const activate = selecting
                                        ? () => toggleRoomSelected(room.id)
                                        : onOpenExplorer ? () => onOpenExplorer({ hotelId: hotel.id, roomId: room.id }) : undefined;
                                    return (
                                        <LodgingRoomTile
                                            key={room.id}
                                            room={room}
                                            names={(occupantsByRoom.get(Number(room.id)) || []).map(p => personDisplayName(p, formFields)).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }))}
                                            selecting={selecting}
                                            selected={selecting && selectedRooms.has(room.id)}
                                            onActivate={activate}
                                            onDelete={canManage ? () => handleDeleteRoom(room) : undefined}
                                            onSplit={canManage && locations.length > 0 && !selecting ? () => setSplitRoom(room) : undefined}
                                            t={t}
                                        />
                                    );
                                })}
                            </div>
                            </>
                        )}
                    </div>
                    ) : (() => {
                        // The list: the hotel's summary and the way in — no rooms here.
                        const st = hotelStats(hotel as any, occupantsByRoom as any, locations as any);
                        const locNames = st.locations.map(l => l.name);
                        return (
                            <button type="button" onClick={() => enterHotel(hotel.id)} data-hotel-enter={hotel.id}
                                className="relative w-full text-left p-4 sm:p-8 bg-gray-50/30 hover:bg-blue-50/40 transition-all flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
                                <div className="flex-1 min-w-0 space-y-2">
                                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-bold text-gray-600">
                                        <span>{st.rooms === 1 ? tx('hotels.rooms.one', '1 habitación') : tx('hotels.rooms', '{n} habitaciones', { n: st.rooms })}</span>
                                        <span>{st.beds === 1 ? tx('hotels.beds.one', '1 cama') : tx('hotels.beds', '{n} camas', { n: st.beds })}</span>
                                        <span className="text-emerald-700">{tx('hotels.occupied', '{n} ocupadas', { n: st.occupied })}</span>
                                        <span className={st.free > 0 ? 'text-blue-700' : 'text-gray-400'}>{tx('hotels.free', '{n} libres', { n: st.free })}</span>
                                    </div>
                                    <div className="h-2 rounded-full bg-gray-100 overflow-hidden" aria-hidden="true"><div className="h-full bg-emerald-500" style={{ width: `${st.pct}%` }}></div></div>
                                    {locNames.length > 0 && (
                                        <p className="text-[11px] text-gray-500 truncate">
                                            <i className="fa-solid fa-map-location-dot mr-1.5 text-gray-400" aria-hidden="true"></i>
                                            {locNames.slice(0, 4).join(', ')}{locNames.length > 4 ? tx('hotels.locations.more', ' y {n} más', { n: locNames.length - 4 }) : ''}
                                        </p>
                                    )}
                                </div>
                                <span className="shrink-0 inline-flex items-center gap-2 self-start sm:self-center px-5 py-3 rounded-xl bg-blue-600 text-white text-[10px] font-black uppercase tracking-widest shadow-sm">
                                    {tx('hotels.enter', 'Ver habitaciones')} <i className="fa-solid fa-arrow-right text-[9px]" aria-hidden="true"></i>
                                </span>
                            </button>
                        );
                    })()}
                </div>
            ));
            })()}

            {splitRoom && (
                <RoomBedsSheet
                    room={splitRoom}
                    locations={locations}
                    onClose={() => setSplitRoom(null)}
                    onSaved={(result) => {
                        addToast(withAdjusted(tx, tx('beds.split.saved', 'Reparto guardado'), result), 'success');
                        setSplitRoom(null);
                        fetchHotels(true);
                        fetchLocations();
                    }}
                />
            )}

            {showHotelModal && (
                <Overlay layer={1}>
                    <div className="bg-white rounded-[40px] shadow-2xl w-full max-w-lg border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-10 py-8 border-b border-gray-100 flex items-center justify-between">
                            <div>
                                <h3 className="font-black text-2xl text-gray-900 italic tracking-tighter">{editHotelId ? tx('hotel.edit', 'Editar hotel') : t('add.hotel')}</h3>
                                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">{editHotelId ? tx('hotel.edit.sub', 'Nombre, dirección y ubicación') : 'Registra un nuevo alojamiento'}</p>
                            </div>
                            <button onClick={() => setShowHotelModal(false)} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-2xl">
                                <i className="fa-solid fa-xmark text-xl"></i>
                            </button>
                        </div>
                        <form {...fe.form(handleHotelSubmit)} className="p-10 space-y-6">
                            <div className="space-y-2">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('hotel.name')}</label>
                                <input
                                    data-field="hotel_name" aria-invalid={fe.invalid('hotel_name')} aria-describedby={fe.describedBy('hotel_name')}
                                    required
                                    placeholder="Ej. Hotel Central"
                                    className="w-full border-2 border-gray-100 rounded-2xl px-5 py-4 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-200"
                                    value={hotelForm.name}
                                    onChange={e => setHotelForm({ ...hotelForm, name: e.target.value })}
                                    autoFocus={canAutoFocus()}
                                />
                                <FieldError message={fe.error('hotel_name')} id={fe.errorId('hotel_name')} />
                            </div>
                            <div className="space-y-2">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('hotel.address')}</label>
                                <div className="relative">
                                    <i className="fa-solid fa-location-dot absolute left-5 top-1/2 -translate-y-1/2 text-gray-300"></i>
                                    <input
                                        placeholder="Dirección completa"
                                        className="w-full border-2 border-gray-100 rounded-2xl pl-12 pr-5 py-4 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-200"
                                        value={hotelForm.address}
                                        onChange={e => setHotelForm({ ...hotelForm, address: e.target.value })}
                                    />
                                </div>
                            </div>
                            {/* 2.23.0 / 2.24.0: the hotel's place for the map on each guest's «Mi inscripción» page — search, map, pin. */}
                            <PlacePicker location={hotelForm.location || ''} onLocation={(v) => setHotelForm(f => ({ ...f, location: v }))}
                                initialQuery={[hotelForm.name, hotelForm.address].filter(Boolean).join(', ')}
                                onAddress={(a) => setHotelForm(f => (f.address ? f : { ...f, address: a }))} tx={tx} />
                            <div className="space-y-2">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('capacity') || 'Capacidad'}</label>
                                <input
                                    data-field="hotel_capacity" aria-invalid={fe.invalid('hotel_capacity')} aria-describedby={fe.describedBy('hotel_capacity')}
                                    type="number" min="0"
                                    placeholder="0"
                                    className="w-full border-2 border-gray-100 rounded-2xl px-5 py-4 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-200"
                                    value={hotelForm.capacity ?? ''}
                                    onChange={e => setHotelForm({ ...hotelForm, capacity: (e.target.value === '' ? '' : Number(e.target.value)) as any })}
                                />
                                <FieldError message={fe.error('hotel_capacity')} id={fe.errorId('hotel_capacity')} />
                            </div>
                            <div className="flex gap-4 pt-6" data-cm-sheet-foot="">
                                <button
                                    type="button"
                                    onClick={() => setShowHotelModal(false)}
                                    className="flex-1 px-6 py-4 rounded-xl font-black text-[10px] uppercase tracking-widest text-gray-400 hover:bg-gray-100 transition-all"
                                >
                                    {t('cancel')}
                                </button>
                                <button
                                    type="submit"
                                    className="flex-[2] bg-gray-900 text-white px-6 py-4 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-blue-600 shadow-xl shadow-gray-200 hover:shadow-blue-500/30 transition-all transform active:scale-95"
                                >
                                    {t('save') || 'Crear Hotel'}
                                </button>
                            </div>
                        </form>
                    </div>
                </Overlay>
            )}

            {showRoomModal && (
                <Overlay layer={1}>
                    <div className="bg-white rounded-[40px] shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-10 py-8 border-b border-gray-100 flex items-center justify-between">
                            <div>
                                <h3 className="font-black text-2xl text-gray-900 italic tracking-tighter">{t('add.room')}</h3>
                                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">Configura nuevas habitaciones</p>
                            </div>
                            <button onClick={() => setShowRoomModal(null)} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-2xl">
                                <i className="fa-solid fa-xmark text-xl"></i>
                            </button>
                        </div>

                        <div className="px-10 pt-8">
                            <div className="flex bg-gray-50 p-1.5 rounded-xl border border-gray-100">
                                <button
                                    type="button"
                                    onClick={() => setIsBulk(false)}
                                    className={`flex-1 py-3 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${!isBulk
                                        ? 'bg-white shadow-md text-blue-600 ring-1 ring-black/5'
                                        : 'text-gray-400 hover:text-gray-600'
                                        }`}
                                >
                                    {t('room.individual.mode')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setIsBulk(true)}
                                    className={`flex-1 py-3 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${isBulk
                                        ? 'bg-white shadow-md text-blue-600 ring-1 ring-black/5'
                                        : 'text-gray-400 hover:text-gray-600'
                                        }`}
                                >
                                    {t('room.bulk.mode')}
                                </button>
                            </div>
                        </div>

                        <form {...fe.form(handleRoomSubmit)} className="p-10 space-y-6">
                            {isBulk ? (
                                <div className="space-y-6">
                                    <div className="grid grid-cols-3 gap-4">
                                        <div className="col-span-1 space-y-2">
                                            <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('room.prefix')}</label>
                                            <input
                                                placeholder="Ej: A-"
                                                className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-300 text-center"
                                                value={bulkConfig.prefix}
                                                onChange={e => setBulkConfig({ ...bulkConfig, prefix: e.target.value })}
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('room.range.start')}</label>
                                            <input
                                                data-field="rooms_from" aria-invalid={fe.invalid('rooms_from')} aria-describedby={fe.describedBy('rooms_from')}
                                                type="number"
                                                required
                                                className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold text-center"
                                                value={bulkConfig.start ?? ''}
                                                onChange={e => setBulkConfig({ ...bulkConfig, start: (e.target.value === '' ? '' : Number(e.target.value)) as any })}
                                            />
                                            <FieldError message={fe.error('rooms_from')} id={fe.errorId('rooms_from')} />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('room.range.end')}</label>
                                            <input
                                                data-field="rooms_to" aria-invalid={fe.invalid('rooms_to')} aria-describedby={fe.describedBy('rooms_to')}
                                                type="number"
                                                required
                                                className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold text-center"
                                                value={bulkConfig.end ?? ''}
                                                onChange={e => setBulkConfig({ ...bulkConfig, end: (e.target.value === '' ? '' : Number(e.target.value)) as any })}
                                            />
                                            <FieldError message={fe.error('rooms_to')} id={fe.errorId('rooms_to')} />
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('room.capacity')}</label>
                                        <div className="relative">
                                            <i className="fa-solid fa-users absolute left-5 top-1/2 -translate-y-1/2 text-gray-300"></i>
                                            <input
                                                data-field="rooms_capacity" aria-invalid={fe.invalid('rooms_capacity')} aria-describedby={fe.describedBy('rooms_capacity')}
                                                type="number"
                                                placeholder={t('room.capacity')}
                                                className="w-full border-2 border-gray-100 rounded-2xl pl-12 pr-5 py-4 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-200"
                                                required min="1"
                                                value={roomForm.capacity ?? ''}
                                                onChange={e => setRoomForm({ ...roomForm, capacity: (e.target.value === '' ? '' : Number(e.target.value)) as any })}
                                            />
                                        </div>
                                        <FieldError message={fe.error('rooms_capacity')} id={fe.errorId('rooms_capacity')} />
                                    </div>
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('room.number')}</label>
                                        <div className="relative">
                                            <i className="fa-solid fa-tag absolute left-5 top-1/2 -translate-y-1/2 text-gray-300"></i>
                                            <input
                                                data-field="room_number" aria-invalid={fe.invalid('room_number')} aria-describedby={fe.describedBy('room_number')}
                                                required
                                                placeholder="Ej. 101"
                                                className="w-full border-2 border-gray-100 rounded-2xl pl-12 pr-5 py-4 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-200"
                                                value={roomForm.room_number}
                                                onChange={e => setRoomForm({ ...roomForm, room_number: e.target.value })}
                                                autoFocus={canAutoFocus()}
                                            />
                                        </div>
                                        <FieldError message={fe.error('room_number')} id={fe.errorId('room_number')} />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('room.capacity')}</label>
                                        <div className="relative">
                                            <i className="fa-solid fa-users absolute left-5 top-1/2 -translate-y-1/2 text-gray-300"></i>
                                            <input
                                                data-field="room_capacity" aria-invalid={fe.invalid('room_capacity')} aria-describedby={fe.describedBy('room_capacity')}
                                                type="number"
                                                placeholder="2"
                                                className="w-full border-2 border-gray-100 rounded-2xl pl-12 pr-5 py-4 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-200"
                                                required min="1"
                                                value={roomForm.capacity ?? ''}
                                                onChange={e => setRoomForm({ ...roomForm, capacity: (e.target.value === '' ? '' : Number(e.target.value)) as any })}
                                            />
                                        </div>
                                        <FieldError message={fe.error('room_capacity')} id={fe.errorId('room_capacity')} />
                                    </div>
                                </div>
                            )}
                            <div className="space-y-2">
                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{t('room.notes')}</label>
                                <textarea
                                    className="w-full border-2 border-gray-100 rounded-2xl px-5 py-4 bg-gray-50/50 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-bold placeholder:text-gray-200 text-sm resize-none"
                                    rows={2}
                                    placeholder="Ej: Camas dobles, aire acondicionado..."
                                    value={roomForm.notes || ''}
                                    onChange={e => setRoomForm({ ...roomForm, notes: e.target.value })}
                                />
                            </div>
                            <div className="flex gap-4 pt-6" data-cm-sheet-foot="">
                                <button
                                    type="button"
                                    disabled={!!roomBusy}
                                    onClick={() => setShowRoomModal(null)}
                                    className="flex-1 px-6 py-4 rounded-xl font-black text-[10px] uppercase tracking-widest text-gray-400 hover:bg-gray-100 transition-all disabled:opacity-40"
                                >
                                    {t('cancel')}
                                </button>
                                <button
                                    type="submit"
                                    disabled={!!roomBusy}
                                    aria-busy={roomBusy ? true : undefined}
                                    data-room-submit=""
                                    className="flex-[2] bg-gray-900 text-white px-6 py-4 rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-blue-600 shadow-xl shadow-gray-200 hover:shadow-blue-500/30 transition-all transform active:scale-95 disabled:opacity-70 disabled:cursor-wait"
                                >
                                    {roomBusy
                                        ? <><i className="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>{roomBusy.total > 1 ? tx('rooms.creating.progress', 'Creando {done}/{total}…', { done: roomBusy.done, total: roomBusy.total }) : tx('rooms.creating', 'Creando…')}</>
                                        : t('add.room')}
                                </button>
                            </div>
                        </form>
                    </div>
                </Overlay>
            )}
        </div>
    );
}

// Pricing Component — base fee + field-driven pricing rules (each rule 'set's or 'add's an amount
// when the attendee's field value matches a condition). Evaluated server-side on registration.
const FEE_OPERATORS = [
    { value: 'eq', label: 'es igual a', needsValue: true },
    { value: 'neq', label: 'no es igual a', needsValue: true },
    { value: 'contains', label: 'contiene', needsValue: true },
    { value: 'gt', label: 'mayor que', needsValue: true },
    { value: 'gte', label: 'mayor o igual que', needsValue: true },
    { value: 'lt', label: 'menor que', needsValue: true },
    { value: 'lte', label: 'menor o igual que', needsValue: true },
    { value: 'filled', label: 'tiene valor', needsValue: false },
    { value: 'empty', label: 'está vacío', needsValue: false },
    { value: 'any', label: 'siempre (sin condición)', needsValue: false },
];

function PricingPage({ conferenceId }: { conferenceId: number }) {
    const tx = useTx();
    const { language } = useI18n();
    const fe = useFieldErrors(language);
    const { addToast } = useToast();
    const { confirm } = useModal();
    // Configuración › gestionar = base fee, rules and the re-pricing; «ver» only reads them.
    const canManage = usePerms().can('settings', 'manage');
    const [fields, setFields] = useState<any[]>([]);
    const [rules, setRules] = useState<any[]>([]);
    const [baseFee, setBaseFee] = useState<string>('0');
    const [loading, setLoading] = useState(true);
    const [savingBase, setSavingBase] = useState(false);
    const [showModal, setShowModal] = useState(false);
    const [form, setForm] = useState<any>(null);
    const [repricing, setRepricing] = useState(false);

    const load = async () => {
        setLoading(true);
        try {
            const [flds, rls, confs] = await Promise.all([
                conferenceApi.getFields(conferenceId),
                conferenceApi.getFeeRules(conferenceId),
                conferenceApi.getConferences(),
            ]);
            setFields(flds || []);
            setRules(rls || []);
            const conf = (confs || []).find((c: any) => c.id === conferenceId);
            setBaseFee(String(conf?.fee_default ?? 0));
        } catch (e: any) { addToast(e?.message || 'Error al cargar precios', 'error'); }
        finally { setLoading(false); }
    };
    useEffect(() => { load(); }, [conferenceId]);

    const saveBase = async () => {
        setSavingBase(true);
        try { await conferenceApi.updateConference(conferenceId, { fee_default: Number(baseFee) || 0 } as any); addToast('Cuota base guardada', 'success'); }
        catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setSavingBase(false); }
    };

    const openNew = () => { setForm({ label: '', field_name: '', operator: 'any', value: '', action: 'set', amount: '', priority: (rules.length + 1) * 10, enabled: 1 }); setShowModal(true); };
    const openEdit = (r: any) => { setForm({ ...r, amount: String(r.amount) }); setShowModal(true); };

    const saveRule = async (e: any) => {
        e.preventDefault();
        try {
            await conferenceApi.saveFeeRule({ ...form, conference_id: conferenceId, amount: Number(form.amount) || 0, priority: Number(form.priority) || 0 });
            setShowModal(false); setForm(null); addToast('Regla guardada', 'success'); load();
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
    };
    const toggleRule = async (r: any) => { try { await conferenceApi.saveFeeRule({ ...r, conference_id: conferenceId, enabled: r.enabled ? 0 : 1 }); load(); } catch (e: any) { addToast(e?.message || 'Error', 'error'); } };
    const delRule = async (r: any) => { if (!await confirm(`¿Eliminar la regla "${r.label || 'sin nombre'}"?`, 'Eliminar', true)) return; try { await conferenceApi.deleteFeeRule(r.id); load(); } catch (e: any) { addToast(e?.message || 'Error', 'error'); } };

    const repriceAll = async () => {
        if (!await confirm('Se recalcularán las cuotas de TODOS los inscritos con las reglas y la cuota base actuales. Los pagos ya registrados no se tocan. ¿Continuar?', 'Recalcular precios', false)) return;
        setRepricing(true);
        try {
            const r = await conferenceApi.repriceAll(conferenceId);
            addToast(`Precios recalculados: ${r.updated} de ${r.total} inscritos actualizados.`, 'success');
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setRepricing(false); }
    };

    const fieldLabel = (name: string) => fields.find(f => f.name === name)?.label || name;
    const opLabel = (op: string) => FEE_OPERATORS.find(o => o.value === op)?.label || op;
    const money = (n: any) => '$' + fmtMoney(n);
    const opNeedsValue = (op: string) => FEE_OPERATORS.find(o => o.value === op)?.needsValue;

    if (loading) return <div className="text-center py-20"><div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div></div>;

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <ReadOnlyNotice section="settings" className="mb-4 flex-shrink-0" />
            <div className="flex flex-wrap items-center justify-between gap-4 mb-6 flex-shrink-0">
                <div>
                    <h2 className="text-2xl font-black text-gray-900 italic tracking-tighter">Precios</h2>
                    <p className="text-sm text-gray-400 font-medium">Cuota base + reglas según los campos del formulario</p>
                </div>
                {canManage && <div className="flex items-center gap-2">
                    <button onClick={repriceAll} disabled={repricing} className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-5 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2 disabled:opacity-50" title="Aplica las reglas actuales a los inscritos existentes">
                        <i className={`fa-solid ${repricing ? 'fa-spinner animate-spin' : 'fa-arrows-rotate'}`}></i> Recalcular todos
                    </button>
                    <button onClick={openNew} className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2 shadow-lg">
                        <i className="fa-solid fa-plus"></i> Nueva regla
                    </button>
                </div>}
            </div>

            <div className="flex-1 overflow-y-auto modern-scrollbar min-h-0 space-y-6">
                {/* Base fee */}
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Cuota base (por defecto)</label>
                    <div className="flex items-center gap-3">
                        <div className="relative flex-1 max-w-xs">
                            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 font-bold">$</span>
                            <input type="number" min="0" value={baseFee} onChange={e => setBaseFee(e.target.value)} disabled={!canManage}
                                className="w-full border-2 border-gray-100 rounded-xl pl-8 pr-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none font-bold text-gray-900 disabled:opacity-70 disabled:cursor-not-allowed" />
                        </div>
                        {canManage && <button onClick={saveBase} disabled={savingBase} className="px-6 py-3 bg-gray-900 hover:bg-black text-white rounded-xl font-black text-xs uppercase tracking-widest transition disabled:opacity-50">{savingBase ? 'Guardando…' : 'Guardar'}</button>}
                    </div>
                    <p className="text-[11px] text-gray-400 mt-2">Se aplica a todos; luego las reglas la fijan o la ajustan según los campos.</p>
                </div>

                {/* Rules */}
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
                        <h3 className="font-bold text-gray-800">Reglas de precio</h3>
                        <span className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">{rules.length} reglas · orden por prioridad</span>
                    </div>
                    {rules.length === 0 ? (
                        <div className="text-center py-12 text-gray-400">
                            <i className="fa-solid fa-tags text-3xl mb-3 opacity-30"></i>
                            <p className="text-sm">Sin reglas — todos pagan la cuota base. Crea una con "Nueva regla".</p>
                        </div>
                    ) : (
                        <div className="divide-y divide-gray-50">
                            {rules.map(r => (
                                <div key={r.id} className={`p-5 flex items-center justify-between gap-4 ${r.enabled ? '' : 'opacity-50'}`}>
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="font-black text-gray-900">{r.label || 'Regla'}</span>
                                            <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full ${r.action === 'add' ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600'}`}>
                                                {r.action === 'add' ? 'Suma' : 'Fija'} {money(r.amount)}
                                            </span>
                                        </div>
                                        <div className="text-xs text-gray-500">
                                            {r.operator === 'any' || !r.field_name
                                                ? 'Siempre'
                                                : <>Si <span className="font-bold text-gray-700">{fieldLabel(r.field_name)}</span> {opLabel(r.operator)} {opNeedsValue(r.operator) && <span className="font-mono bg-gray-100 px-1.5 py-0.5 rounded">{r.value}</span>}</>}
                                            <span className="ml-2 text-gray-300">· prioridad {r.priority}</span>
                                        </div>
                                        {isOrphanFeeRule(r, fields) && (
                                            <div className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 text-[11px] font-bold text-amber-700" data-fee-rule-orphan={r.id}>
                                                <i className="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                                                {tx('fee.rule.missing.field', 'El campo «{field}» ya no está en el formulario: esta regla no se aplica.', { field: r.field_name })}
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <button onClick={() => toggleRule(r)} disabled={!canManage} title={r.enabled ? 'Desactivar' : 'Activar'} className={`w-11 h-6 rounded-full relative transition disabled:cursor-not-allowed disabled:opacity-60 ${r.enabled ? 'bg-emerald-500' : 'bg-gray-200'}`}>
                                            <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition ${r.enabled ? 'left-6' : 'left-1'}`}></span>
                                        </button>
                                        {canManage && <button onClick={() => openEdit(r)} title="Editar" className="w-9 h-9 shrink-0 flex items-center justify-center rounded-xl bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white transition"><i className="fa-solid fa-pen text-xs"></i></button>}
                                        {canManage && <button onClick={() => delRule(r)} title="Eliminar" className="w-9 h-9 shrink-0 flex items-center justify-center rounded-xl bg-gray-50 text-gray-400 hover:bg-rose-600 hover:text-white transition"><i className="fa-solid fa-trash text-xs"></i></button>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Rule modal */}
            {showModal && form && (
                <Overlay layer={1}>
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between">
                            <h3 className="font-bold text-xl text-gray-900 italic">{form.id ? 'Editar regla' : 'Nueva regla de precio'}</h3>
                            <button onClick={() => { setShowModal(false); setForm(null); }} className="text-gray-400 hover:text-gray-600 p-2 hover:bg-gray-100 rounded-lg"><i className="fa-solid fa-xmark text-lg"></i></button>
                        </div>
                        <form {...fe.form(saveRule)} className="p-8 space-y-5">
                            <div>
                                <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">Nombre de la regla</label>
                                <input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="Ej. Estudiantes" className="w-full border-2 border-gray-100 rounded-xl px-4 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none font-medium" />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                                <div className="sm:col-span-1">
                                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">Campo</label>
                                    <Select value={form.field_name} onChange={e => setForm({ ...form, field_name: e.target.value, operator: e.target.value ? (form.operator === 'any' ? 'eq' : form.operator) : 'any' })} className="w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none font-medium text-sm">
                                        <option value="">(Siempre)</option>
                                        {fields.map(f => <option key={f.id} value={f.name}>{f.label}</option>)}
                                    </Select>
                                </div>
                                <div className="sm:col-span-1">
                                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">Condición</label>
                                    <Select value={form.operator} onChange={e => setForm({ ...form, operator: e.target.value })} disabled={!form.field_name} className="w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none font-medium text-sm disabled:opacity-50">
                                        {FEE_OPERATORS.filter(o => form.field_name ? o.value !== 'any' : o.value === 'any').map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    </Select>
                                </div>
                                <div className="sm:col-span-1">
                                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">Valor</label>
                                    <input value={form.value} onChange={e => setForm({ ...form, value: e.target.value })} disabled={!opNeedsValue(form.operator)} placeholder="—" className="w-full border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none font-medium text-sm disabled:opacity-40" />
                                </div>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">Acción</label>
                                    <div className="flex gap-2">
                                        <button type="button" onClick={() => setForm({ ...form, action: 'set' })} className={`flex-1 py-2.5 rounded-xl text-xs font-bold border-2 transition ${form.action === 'set' ? 'border-blue-500 bg-blue-50/50 text-blue-700' : 'border-gray-100 text-gray-500'}`}>Fijar en</button>
                                        <button type="button" onClick={() => setForm({ ...form, action: 'add' })} className={`flex-1 py-2.5 rounded-xl text-xs font-bold border-2 transition ${form.action === 'add' ? 'border-amber-500 bg-amber-50/50 text-amber-700' : 'border-gray-100 text-gray-500'}`}>Sumar/restar</button>
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">Monto</label>
                                    <div className="relative">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 font-bold text-sm">$</span>
                                        <input data-field="price_amount" aria-invalid={fe.invalid('price_amount')} aria-describedby={fe.describedBy('price_amount')} type="number" step="any" required value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0" className="w-full border-2 border-gray-100 rounded-xl pl-7 pr-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none font-bold" />
                                    </div>
                                    <FieldError message={fe.error('price_amount')} id={fe.errorId('price_amount')} />
                                </div>
                            </div>
                            <div>
                                <label className="block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">Prioridad (menor = primero)</label>
                                <input data-field="price_priority" aria-invalid={fe.invalid('price_priority')} aria-describedby={fe.describedBy('price_priority')} type="number" step="1" placeholder="0" value={form.priority ?? ''} onChange={e => setForm({ ...form, priority: e.target.value === '' ? '' : Number(e.target.value) })} className="w-32 border-2 border-gray-100 rounded-xl px-3 py-2.5 bg-gray-50/30 focus:bg-white focus:border-blue-500 outline-none font-medium" />
                                <FieldError message={fe.error('price_priority')} id={fe.errorId('price_priority')} />
                            </div>
                            <div className="flex justify-end gap-3 pt-4 border-t border-gray-50" data-cm-sheet-foot="">
                                <button type="button" onClick={() => { setShowModal(false); setForm(null); }} className="px-6 py-2.5 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition">Cancelar</button>
                                <button type="submit" className="px-8 py-2.5 bg-blue-600 text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 hover:bg-blue-700 transition">Guardar regla</button>
                            </div>
                        </form>
                    </div>
                </Overlay>
            )}
        </div>
    );
}

// Reports Component
/**
 * «Reportes» derived figures (2.18.0) from /reports/summary's totals: «Saldo pendiente» = Cuotas − Validado
 * (never negative: the server's figures exclude cancelled people and cap each person's money at the fee),
 * and the pill bar over ACTIVE people (cancelled inscriptions are counted apart). An older plugin's totals
 * (no `people`) fall back to every inscription.
 */
export function reportView(totals: any) {
    const pending = Math.max(0, (Number(totals?.due) || 0) - (Number(totals?.paid) || 0));
    const active = totals && totals.people !== undefined && Number.isFinite(Number(totals.people)) ? Number(totals.people) : (Number(totals?.total) || 0);
    const paidPct = active ? Math.round(((Number(totals?.paid_count) || 0) / active) * 100) : 0;
    return { pending, active, paidPct };
}

function ReportsPage({ conferenceId }: { conferenceId: number }) {
    const { t } = useI18n();
    const tx = useTx();
    const { addToast } = useToast();
    const [summary, setSummary] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let alive = true;
        setLoading(true);
        conferenceApi.getReportSummary(conferenceId)
            .then(s => { if (alive) setSummary(s); })
            .catch(() => { if (alive) addToast(t('error.loading.reports') || 'Error al cargar el reporte', 'error'); })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [conferenceId]);

    const money = (n: number) => '$' + fmtMoney(n);

    const [exporting, setExporting] = useState(false);
    const [showExcel, setShowExcel] = useState(false);
    const [hotelsBusy, setHotelsBusy] = useState(false);
    const { currentConference: reportConf } = useConference();
    const codesOk = usePerms().can('inscriptions');
    const hotelsExcel = async () => {
        setHotelsBusy(true);
        try { await downloadHotelReport(conferenceId, reportConf?.slug, null, codesOk); }
        catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setHotelsBusy(false); }
    };
    const downloadCsv = async () => {
        setExporting(true);
        try {
            // The sandbox can only return JSON, so fetch the CSV string and build the file locally.
            const data = await conferenceApi.exportCsv(conferenceId);
            const blob = new Blob([data.csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = data.filename || `inscripciones-${conferenceId}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e: any) {
            addToast(e?.message || t('error.loading.reports') || 'Error', 'error');
        } finally {
            setExporting(false);
        }
    };

    if (loading) {
        return (
            <div className="text-center py-20">
                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-gray-500">{t('loading') || 'Cargando…'}</p>
            </div>
        );
    }

    // 2.18.0: the server computes every figure on «Pagos de cuotas» › Resumen's per-person model
    // (fees.reportFigures): «Recaudado» = Validado (up to each fee), «Por validar», «Saldo pendiente» =
    // Cuotas − Validado = Por validar + Por cobrar, «A favor» apart; a cancelled inscription owes nothing.
    // The counts are the roster pills of ACTIVE people; cancelled ones are counted apart.
    const totals = summary?.totals || {};
    const { pending, active, paidPct } = reportView(totals);

    const statCards = [
        { label: t('total.registered') || 'Inscritos', value: totals.total || 0, icon: 'fa-users', color: 'text-blue-600', bg: 'bg-blue-50' },
        { label: t('collected') || 'Recaudado', value: money(totals.paid), icon: 'fa-sack-dollar', color: 'text-emerald-600', bg: 'bg-emerald-50' },
        // 2.18.0: fee money registered but not validated yet («Pagos de cuotas › Por validar»).
        { label: tx('fees.kpi.pending', 'Por validar'), value: money(Number(totals.pending) || 0), icon: 'fa-clock', color: 'text-amber-700', bg: 'bg-amber-50' },
        { label: t('pending.balance') || 'Saldo pendiente', value: money(pending), icon: 'fa-clock', color: 'text-rose-500', bg: 'bg-rose-50' },
        ...(Number(totals.credit) > 0 ? [{ label: tx('fees.kpi.credit', 'A favor'), value: money(Number(totals.credit)), icon: 'fa-hand-holding-dollar', color: 'text-sky-700', bg: 'bg-sky-50' }] : []),
        { label: t('assigned') || 'Alojados', value: `${totals.assigned_count || 0}/${totals.total || 0}`, icon: 'fa-bed', color: 'text-indigo-600', bg: 'bg-indigo-50' },
    ];

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-8 flex-shrink-0">
                <div>
                    <h2 className="text-2xl font-black text-gray-900 italic tracking-tighter">{t('reports.title') || 'Reportes'}</h2>
                    <p className="text-sm text-gray-400 font-medium">{t('reports.subtitle') || 'Resumen de inscripciones y pagos'}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                {showExcel && <ExcelExportModal conferenceId={conferenceId} slug={reportConf?.slug} onClose={() => setShowExcel(false)} />}
                <button
                    onClick={() => setShowExcel(true)}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2 shadow-lg shadow-emerald-500/30"
                >
                    <i className="fa-solid fa-file-excel"></i> {t('excel.custom') || 'Excel personalizado'}
                </button>
                <button
                    onClick={hotelsExcel}
                    disabled={hotelsBusy}
                    className="bg-white border-2 border-gray-100 text-gray-700 hover:border-emerald-500 hover:text-emerald-700 px-6 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2 disabled:opacity-50"
                >
                    <i className={`fa-solid ${hotelsBusy ? 'fa-spinner animate-spin' : 'fa-hotel'}`}></i> {t('excel.hotels') || 'Reporte de hoteles (Excel)'}
                </button>
                <button
                    onClick={downloadCsv}
                    disabled={exporting}
                    className="bg-gray-900 hover:bg-black text-white px-6 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all flex items-center gap-2 shadow-lg disabled:opacity-50"
                >
                    <i className={`fa-solid ${exporting ? 'fa-spinner animate-spin' : 'fa-file-csv'}`}></i> {t('export.csv') || 'Exportar CSV'}
                </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto modern-scrollbar min-h-0 space-y-8">
                {/* Stat cards */}
                {/* Columns from the available width: five fixed columns left ~65px for amounts like $12.345.678,00. */}
                <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 11rem), 1fr))' }}>
                    {statCards.map((c) => (
                        <div key={c.label} className="bg-white p-5 rounded-2xl border border-gray-100 shadow-sm min-w-0">
                            <div className={`w-10 h-10 shrink-0 rounded-xl ${c.bg} ${c.color} flex items-center justify-center mb-3`}>
                                <i className={`fa-solid ${c.icon}`}></i>
                            </div>
                            <div className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1">{c.label}</div>
                            <div className={`text-2xl font-black ${c.color}`} style={{ overflowWrap: 'anywhere' }}>{c.value}</div>
                        </div>
                    ))}
                </div>

                {/* Payment progress */}
                <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="font-bold text-gray-800">{t('payment.status') || 'Estado de pagos'}</h3>
                        <span className="text-xs font-black text-emerald-600">{paidPct}% {t('paid').toLowerCase()}</span>
                    </div>
                    <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden flex">
                        <div className="bg-emerald-500 h-full" style={{ width: `${active ? (totals.paid_count / active) * 100 : 0}%` }}></div>
                        <div className="bg-amber-400 h-full" style={{ width: `${active ? (totals.partial_count / active) * 100 : 0}%` }}></div>
                    </div>
                    <div className="flex flex-wrap gap-4 mt-3 text-xs font-bold">
                        <span className="text-emerald-600" data-report-count="paid"><i className="fa-solid fa-circle text-[8px] mr-1"></i>{tx('fees.pill.paid', 'Pagado')}: {totals.paid_count || 0}</span>
                        <span className="text-amber-500" data-report-count="partial"><i className="fa-solid fa-circle text-[8px] mr-1"></i>{tx('fees.pill.partial', 'Abono')}: {totals.partial_count || 0}</span>
                        <span className="text-rose-500" data-report-count="unpaid"><i className="fa-solid fa-circle text-[8px] mr-1"></i>{tx('fees.pill.unpaid', 'Sin pagar')}: {totals.unpaid_count || 0}</span>
                        {Number(totals.cancelled_count) > 0 && <span className="text-gray-600" data-report-count="cancelled">{Number(totals.cancelled_count) === 1 ? tx('roster.count.cancelled.one', '1 cancelada') : tx('roster.count.cancelled', '{n} canceladas', { n: totals.cancelled_count })}</span>}
                    </div>
                </div>

                {/* By location */}
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-50">
                        <h3 className="font-bold text-gray-800">{t('by.location') || 'Por localidad'}</h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-gray-50/50 text-[10px] uppercase tracking-widest text-gray-400 font-black">
                                <tr>
                                    <th className="px-6 py-3">{t('location')}</th>
                                    <th className="px-6 py-3 text-right">{t('inscriptions')}</th>
                                    <th className="px-6 py-3 text-right">{t('collected') || 'Recaudado'}</th>
                                    <th className="px-6 py-3 text-right">{tx('fees.kpi.pending', 'Por validar')}</th>
                                    <th className="px-6 py-3 text-right">{t('pending.balance') || 'Pendiente'}</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {(summary?.byLocation || []).length === 0 ? (
                                    <tr><td colSpan={5} className="px-6 py-8 text-center text-gray-400">{t('no.inscriptions')}</td></tr>
                                ) : (summary.byLocation.map((row: any) => (
                                    <tr key={row.location} className="hover:bg-gray-50/50">
                                        <td className="px-6 py-3 font-bold text-gray-900">{row.location}</td>
                                        <td className="px-6 py-3 text-right font-medium text-gray-600">{row.count}</td>
                                        <td className="px-6 py-3 text-right font-bold text-emerald-600">{money(row.paid)}</td>
                                        <td className="px-6 py-3 text-right font-bold text-amber-700" data-report-pending="">{money(Number(row.pending) || 0)}</td>
                                        <td className="px-6 py-3 text-right font-bold text-rose-500">{money((Number(row.due) || 0) - (Number(row.paid) || 0))}</td>
                                    </tr>
                                )))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
}

// Fields Component
// 2.16.0: a new conference starts with NO field. «Añadir campo» offers the base fields as TEMPLATES (created by
// the server with the exact name / type / options / role the other features look them up by) next to a
// custom field; every field can be edited and deleted while the form is unpublished (the server keeps the
// published-form lock). Deleting a field other features read asks first, naming what stops working — an
// inline two-step confirm (the shared useModal dialog is z-50, under this page's z-[100] modal).
const EMPTY_FIELD: Partial<ConferenceField> = { name: '', label: '', type: 'text', options: '', is_required: 0, sort_order: 0, width: 100, is_group: 0, is_unique: 0 };
function FieldsPage({ conferenceId }: { conferenceId: number }) {
    const { t, language } = useI18n();
    const fe = useFieldErrors(language);
    const tx = useTx();
    const { addToast } = useToast();
    // Configuración › gestionar = add / edit / delete / reorder fields and publish the form.
    const canManage = usePerms().can('settings', 'manage');
    const [fields, setFields] = useState<ConferenceField[]>([]);
    const [conference, setConference] = useState<Conference | null>(null);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [formData, setFormData] = useState<Partial<ConferenceField>>({ ...EMPTY_FIELD });
    const [openSelect, setOpenSelect] = useState<'type' | 'required' | null>(null);
    // The rules that read a field (named in the delete confirmation). A list the role may not read stays [].
    const [feeRules, setFeeRules] = useState<any[]>([]);
    const [assignmentRules, setAssignmentRules] = useState<any[]>([]);
    const [deleteAsk, setDeleteAsk] = useState<number | null>(null);
    const [deleteBusy, setDeleteBusy] = useState(false);
    const [templateBusy, setTemplateBusy] = useState<string | null>(null);

    const FIELD_TYPES = [
        { value: 'text', label: t('type.text'), icon: 'fa-font', color: 'text-blue-500', bg: 'bg-blue-50' },
        { value: 'number', label: t('type.number'), icon: 'fa-hashtag', color: 'text-indigo-500', bg: 'bg-indigo-50' },
        { value: 'select', label: t('type.select'), icon: 'fa-list-ul', color: 'text-purple-500', bg: 'bg-purple-50' },
        { value: 'date', label: t('type.date'), icon: 'fa-calendar-day', color: 'text-orange-500', bg: 'bg-orange-50' },
        { value: 'switch', label: tx('type.switch', 'Sí / No (interruptor)'), icon: 'fa-toggle-on', color: 'text-emerald-500', bg: 'bg-emerald-50' },
        // 2.32.0: only through its template (never offered in the type menu below).
        { value: 'health', label: tx('type.health', 'Condiciones de salud'), icon: 'fa-notes-medical', color: 'text-rose-500', bg: 'bg-rose-50' }
    ];

    const loadData = async () => {
        setLoading(true);
        try {
            const [fieldsData, locData, feeData, ruleData] = await Promise.all([
                conferenceApi.getFields(conferenceId, { health: true }),
                conferenceApi.getLocations(conferenceId),
                conferenceApi.getFeeRules(conferenceId).catch(() => []),
                conferenceApi.getAssignmentRules(conferenceId, { all: true }).catch(() => []),
            ]);
            setFields(fieldsData);
            setConference(locData.conference);
            setFeeRules(Array.isArray(feeData) ? feeData : []);
            setAssignmentRules(Array.isArray(ruleData) ? ruleData : []);
        } catch (e) {
            addToast(tx('fields.load.error', 'No se pudieron cargar los campos.'), 'error');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { loadData(); }, [conferenceId]);

    const { confirm } = useModal();

    // «Publicar» on an empty form is refused next to the button (not in a toast): a toast stayed on screen
    // over the «Nuevo campo» dialog the user opened to fix it, covering its «O un campo propio» field on a
    // phone. The notice goes away when that dialog opens or the form gets a field.
    const [publishRefused, setPublishRefused] = useState(false);
    useEffect(() => { if (fields.length > 0) setPublishRefused(false); }, [fields.length]);

    const openNewField = () => { setPublishRefused(false); setFormData({ ...EMPTY_FIELD }); setOpenSelect(null); setShowModal(true); };

    // A base field from its template: the server fixes name / type / options / role and refuses a duplicate.
    const addTemplate = async (key: string, label: string) => {
        setTemplateBusy(key);
        try {
            await conferenceApi.addFieldTemplate(conferenceId, key, label);
            addToast(tx('fields.template.added', 'Campo «{label}» añadido', { label }), 'success');
            setShowModal(false);
            setFormData({ ...EMPTY_FIELD });
        } catch (e: any) {
            addToast(e?.message || tx('fields.save.error', 'No se pudo guardar el campo.'), 'error');
        } finally {
            setTemplateBusy(null);
            loadData();
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const dataToSave = { ...formData, conference_id: conferenceId };
            // Generate a unique key if it's a new field
            if (!dataToSave.id && !dataToSave.name) {
                const randomPart = Math.random().toString(36).substring(2, 7);
                dataToSave.name = `f_${Date.now().toString().slice(-6)}_${randomPart}`;
            }
            await conferenceApi.saveField(dataToSave);
            addToast(tx('fields.saved', 'Campo guardado'), 'success');
            setShowModal(false);
            setFormData({ ...EMPTY_FIELD });
            loadData();
        } catch (e: any) {
            addToast(e?.message || tx('fields.save.error', 'No se pudo guardar el campo.'), 'error');
        }
    };

    // Second step of the inline confirm (the first one is the trash button, which opens it).
    const handleDelete = async (field: ConferenceField) => {
        setDeleteBusy(true);
        try {
            await conferenceApi.deleteField(field.id);
            addToast(tx('fields.deleted', 'Campo «{label}» eliminado', { label: field.label }), 'success');
            setDeleteAsk(null);
            loadData();
        } catch (e: any) {
            addToast(e?.message || tx('fields.delete.error', 'No se pudo eliminar el campo.'), 'error');
        } finally {
            setDeleteBusy(false);
        }
    };

    const isPublished = !!conference?.is_form_published;

    const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

    const handleDragStart = (idx: number) => {
        if (isPublished || !canManage) return;
        setDraggedIndex(idx);
    };

    const handleDragOver = (e: React.DragEvent, idx: number) => {
        e.preventDefault();
        if (isPublished || !canManage || draggedIndex === null || draggedIndex === idx) return;

        const newFields = [...fields];
        const draggedItem = newFields[draggedIndex];
        newFields.splice(draggedIndex, 1);
        newFields.splice(idx, 0, draggedItem);
        setFields(newFields);
        setDraggedIndex(idx);
    };

    // Saves the order on screen (drag & drop with a mouse, or the ↑ / ↓ buttons — a phone has no drag).
    const [reorderBusy, setReorderBusy] = useState(false);
    const saveOrder = async (ordered: ConferenceField[]) => {
        setReorderBusy(true);
        try {
            await Promise.all(ordered.map((f, i) =>
                conferenceApi.saveField({ ...f, sort_order: i, conference_id: conferenceId })
            ));
            addToast(tx('fields.order.saved', 'Orden actualizado'), 'success');
        } catch (e) {
            addToast(tx('fields.order.error', 'Error al guardar el nuevo orden'), 'error');
            loadData();
        } finally {
            setReorderBusy(false);
        }
    };

    const handleDragEnd = async () => {
        if (isPublished || !canManage) return;
        setDraggedIndex(null);
        await saveOrder(fields);
    };

    const moveField = async (idx: number, delta: number) => {
        if (isPublished || !canManage || reorderBusy) return;
        const next = moveItem(fields, idx, idx + delta);
        if (next === fields) return;
        setFields(next);
        await saveOrder(next);
    };

    const handlePublish = async () => {
        const currentlyPublished = !!conference?.is_form_published;
        if (publishRefusal(fields.length, currentlyPublished)) {
            setPublishRefused(true);
            return;
        }
        setPublishRefused(false);

        const msg = currentlyPublished
            ? "¿Seguro que quieres despublicar el formulario?"
            : "¿Seguro que quieres publicar el formulario? Los campos no se podrán añadir ni eliminar después.";

        if (await confirm(msg, currentlyPublished ? 'Despublicar Formulario' : 'Publicar Formulario', currentlyPublished)) {
            try {
                await conferenceApi.publishForm(conferenceId, !currentlyPublished);
                addToast(currentlyPublished ? "Formulario despublicado" : "Formulario publicado", "success");
                loadData();
            } catch (e) {
                addToast("Error al cambiar el estado de publicación", "error");
            }
        }
    };

    return (
        <div className="space-y-10 animate-in fade-in duration-500">
            <ReadOnlyNotice section="settings" />
            {/* «Indicativo por defecto» (2.33.2), while the form has a phone field. */}
            {conference && fields.some(isPhoneField) && (
                <PhoneCountrySetting conference={conference} language={language} canManage={canManage}
                    onSaved={(iso) => setConference({ ...conference, phone_country: iso })} />
            )}
            {/* Premium Publisher Card */}
            <div className={`group relative overflow-hidden rounded-[40px] p-10 max-sm:p-6 border-2 transition-all duration-500 shadow-2xl ${isPublished
                ? 'bg-emerald-50/50 border-emerald-100 shadow-emerald-100/30'
                : 'bg-white border-gray-100 shadow-gray-200/50'
                }`}>
                {/* The blobs in their own clipped layer: the card itself has nothing to scroll (lib/phoneLayout.ts). */}
                <div aria-hidden="true" className={DECO_LAYER_CLASS} data-cm-deco="">
                    <div className={`absolute -right-20 -top-20 w-80 h-80 rounded-full blur-[100px] opacity-30 transition-all duration-1000 group-hover:scale-125 ${isPublished ? 'bg-emerald-400' : 'bg-blue-400'
                        }`}></div>
                    <div className={`absolute -left-20 -bottom-20 w-64 h-64 rounded-full blur-[100px] opacity-20 ${isPublished ? 'bg-teal-300' : 'bg-indigo-300'
                        }`}></div>
                </div>

                <div className="relative flex flex-wrap items-center justify-between gap-10 max-sm:gap-6">
                    <div className="min-w-0" style={{ flex: '1 1 18rem' }}>
                        <div className={HERO_HEAD_CLASS} data-cm-hero-head="">
                            <div className={`w-14 h-14 shrink-0 rounded-2xl flex items-center justify-center text-2xl shadow-xl transition-transform duration-500 group-hover:scale-110 ${isPublished ? 'bg-emerald-500 text-white shadow-emerald-200' : 'bg-blue-600 text-white shadow-blue-200'
                                }`}>
                                <i className={`fa-solid ${isPublished ? 'fa-check-double' : 'fa-wand-magic-sparkles'}`}></i>
                            </div>
                            <div className="min-w-0">
                                <h3 className={`font-black text-3xl italic tracking-tighter ${isPublished ? 'text-emerald-900' : 'text-gray-900'}`}>
                                    {t('visual.form.builder') || 'Visual Form Builder'}
                                </h3>
                                {isPublished && (
                                    <div className="flex items-center gap-2 mt-1">
                                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                                        <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest">
                                            {t('form.live') || 'Formulario en Vivo'}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                        {/* Layout-neutral: the preview is beside the fields on a desktop and BELOW them on a phone. */}
                        <p className={`text-base font-medium leading-relaxed max-w-xl ${isPublished ? 'text-emerald-800/70' : 'text-gray-500'}`} data-builder-intro="">
                            {isPublished
                                ? tx('fields.builder.live', 'El formulario está activo y recibiendo inscripciones. Los campos están bloqueados para mantener la integridad de los datos.')
                                : tx('fields.builder.intro', 'Crea una experiencia de registro única. Diseña el formulario y observa los cambios al instante en la vista previa.')}
                        </p>
                        {publishRefused && !isPublished && (
                            <div className="mt-4 max-w-xl rounded-2xl border-2 border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700 flex items-start gap-3" role="alert" data-publish-refused="">
                                <i className="fa-solid fa-circle-exclamation mt-0.5" aria-hidden="true"></i>
                                <span className="flex-1">{tx('fields.publish.empty', 'No puedes publicar un formulario sin campos: añade al menos uno con «Nuevo campo».')}</span>
                                <button type="button" onClick={() => setPublishRefused(false)} className="text-rose-600 hover:text-rose-800" data-publish-refused-close="" aria-label={tx('close', 'Cerrar')}><i className="fa-solid fa-xmark" aria-hidden="true"></i></button>
                            </div>
                        )}
                    </div>

                    {canManage && <div className="flex flex-wrap items-center gap-4">
                        <button
                            onClick={handlePublish}
                            className={`px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest transition-all duration-500 flex items-center gap-3 shadow-xl transform active:scale-95 ${isPublished
                                ? 'bg-white text-orange-600 hover:bg-orange-50 border-2 border-orange-100 hover:border-orange-200 shadow-orange-100/50'
                                : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-emerald-500/30'
                                }`}
                        >
                            <i className={`fa-solid ${isPublished ? 'fa-eye-slash' : 'fa-paper-plane'} text-[8px]`}></i>
                            {isPublished ? 'Despublicar' : 'Publicar'}
                        </button>
                        {!isPublished && (
                            <button
                                onClick={openNewField}
                                data-add-field=""
                                className="bg-gray-900 text-white px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-blue-600 transition-all duration-500 shadow-xl hover:shadow-blue-500/30 flex items-center gap-3 transform active:scale-95 translate-y-0 hover:-translate-y-1"
                            >
                                <i className="fa-solid fa-plus text-[8px]"></i> {t('add.field')}
                            </button>
                        )}
                    </div>}
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
                {/* Left: Management List */}
                <div className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                        <h4 className="font-bold text-gray-700 text-sm uppercase tracking-wider">Estructura de Campos</h4>
                        <span className="text-xs text-gray-400">{fields.length} campos definidos</span>
                    </div>

                    <div className="space-y-3">
                        {loading ? (
                            <div className="p-20 max-sm:px-6 max-sm:py-12 text-center bg-white border border-gray-100 rounded-3xl">
                                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                                <p className="text-gray-400 mt-4 text-xs font-bold uppercase tracking-widest">Cargando campos...</p>
                            </div>
                        ) : fields.length === 0 ? (
                            <div className="p-20 max-sm:px-6 max-sm:py-12 text-center bg-gray-50/50 border-2 border-dashed border-gray-100 rounded-3xl" data-fields-empty="">
                                <i className="fa-solid fa-layer-group text-4xl text-gray-200 mb-4"></i>
                                <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{tx('fields.empty.title', 'Este formulario todavía no tiene campos')}</p>
                                <p className="text-[11px] text-gray-400 mt-2 max-w-sm mx-auto">{tx('fields.empty.hint', 'Pulsa «Nuevo campo»: puedes empezar por los básicos (nombre, apellido, correo…) desde las plantillas o crear los tuyos.')}</p>
                            </div>
                        ) : fields.map((field, idx) => (
                            <React.Fragment key={field.id}>
                            <div
                                draggable={!isPublished && canManage}
                                onDragStart={() => handleDragStart(idx)}
                                onDragOver={(e) => handleDragOver(e, idx)}
                                onDragEnd={handleDragEnd}
                                className={`bg-white border-2 rounded-2xl p-4 flex items-center justify-between flex-wrap gap-3 group transition-all duration-300 shadow-sm ${draggedIndex === idx ? 'opacity-50 border-blue-500 scale-95 shadow-inner' : 'border-gray-50 hover:border-blue-500 hover:shadow-xl hover:-translate-y-1'} ${!isPublished && canManage ? 'cursor-grab active:cursor-grabbing' : ''}`}
                            >
                                <div className="flex items-center gap-4 min-w-0">
                                    <div className="w-10 h-10 shrink-0 rounded-xl bg-gray-50 text-gray-300 group-hover:bg-blue-50 group-hover:text-blue-500 flex items-center justify-center transition-colors">
                                        <i className="fa-solid fa-grip-vertical"></i>
                                    </div>
                                    <div className="min-w-0">
                                        <div className="font-black text-gray-900 italic tracking-tight break-words">{field.label}</div>
                                        <div className="flex flex-wrap items-center gap-2 mt-0.5">
                                            <span className="text-[10px] text-blue-600 font-bold uppercase bg-blue-50 px-2 py-0.5 rounded shadow-sm">{FIELD_TYPES.find(ft => ft.value === field.type)?.label || field.type}</span>
                                            {field.is_required ? (
                                                <span className="text-[10px] text-rose-500 font-bold uppercase bg-rose-50 px-2 py-0.5 rounded shadow-sm">{tx('field.required.yes', 'Obligatorio')}</span>
                                            ) : (
                                                <span className="text-[10px] text-gray-400 font-bold uppercase bg-gray-50 px-2 py-0.5 rounded">{tx('field.required.no', 'Opcional')}</span>
                                            )}
                                            {field.is_group ? (
                                                <span className="text-[10px] text-indigo-600 font-bold uppercase bg-indigo-50 px-2 py-0.5 rounded shadow-sm"><i className="fa-solid fa-people-group mr-1"></i>{tx('field.badge.group', 'Agrupación')}</span>
                                            ) : null}
                                            {field.is_unique ? (
                                                <span className="text-[10px] text-amber-600 font-bold uppercase bg-amber-50 px-2 py-0.5 rounded shadow-sm"><i className="fa-solid fa-fingerprint mr-1"></i>{tx('field.badge.unique', 'Único')}</span>
                                            ) : null}
                                        </div>
                                    </div>
                                </div>
                                {canManage && <div className="flex flex-wrap justify-end gap-2 max-sm:ml-auto opacity-100 translate-x-0 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:translate-x-2 group-hover:opacity-100 focus-within:opacity-100 transition-all duration-300 group-hover:translate-x-0 focus-within:translate-x-0" data-field-actions={field.name}>
                                    {!isPublished && (
                                        <>
                                            <button type="button" onClick={() => moveField(idx, -1)} disabled={idx === 0 || reorderBusy} data-move-field-up={field.name}
                                                className="w-9 h-9 shrink-0 flex items-center justify-center bg-gray-50 text-gray-500 hover:bg-gray-900 hover:text-white rounded-xl transition-all shadow-sm disabled:opacity-30 disabled:pointer-events-none"
                                                title={tx('fields.move.up', 'Subir')} aria-label={tx('fields.move.up.aria', 'Subir el campo {label}', { label: field.label })}><i className="fa-solid fa-arrow-up text-xs" aria-hidden="true"></i></button>
                                            <button type="button" onClick={() => moveField(idx, 1)} disabled={idx === fields.length - 1 || reorderBusy} data-move-field-down={field.name}
                                                className="w-9 h-9 shrink-0 flex items-center justify-center bg-gray-50 text-gray-500 hover:bg-gray-900 hover:text-white rounded-xl transition-all shadow-sm disabled:opacity-30 disabled:pointer-events-none"
                                                title={tx('fields.move.down', 'Bajar')} aria-label={tx('fields.move.down.aria', 'Bajar el campo {label}', { label: field.label })}><i className="fa-solid fa-arrow-down text-xs" aria-hidden="true"></i></button>
                                        </>
                                    )}
                                    <button onClick={() => { setFormData(field); setOpenSelect(null); setShowModal(true); }} className="w-9 h-9 shrink-0 flex items-center justify-center bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white rounded-xl transition-all shadow-sm" title={tx('fields.edit', 'Editar')} aria-label={tx('fields.edit.aria', 'Editar el campo {label}', { label: field.label })}><i className="fa-solid fa-pen text-xs"></i></button>
                                    {!isPublished && deleteAsk !== field.id && (
                                        <button onClick={() => setDeleteAsk(field.id)} data-delete-field={field.name} className="w-9 h-9 shrink-0 flex items-center justify-center bg-rose-50 text-rose-600 hover:bg-rose-600 hover:text-white rounded-xl transition-all shadow-sm" title={tx('fields.delete', 'Eliminar')} aria-label={tx('fields.delete.aria', 'Eliminar el campo {label}', { label: field.label })}><i className="fa-solid fa-trash text-xs"></i></button>
                                    )}
                                </div>}
                            </div>
                            {deleteAsk === field.id && !isPublished && canManage && (() => {
                                const deps = fieldDependents(field, { feeRules, assignmentRules });
                                return (
                                    <div className="rounded-2xl bg-rose-50 border-2 border-rose-100 px-4 py-3 space-y-2" role="alertdialog" aria-label={tx('fields.delete.confirm', '¿Eliminar el campo «{label}»?', { label: field.label })} data-delete-confirm={field.name}>
                                        <p className="text-sm font-black text-rose-800">{tx('fields.delete.confirm', '¿Eliminar el campo «{label}»?', { label: field.label })}</p>
                                        {deps.length > 0 && (
                                            <div className="text-xs text-rose-800 space-y-1">
                                                <p className="font-bold">{tx('fields.delete.stops', 'Dejará de funcionar:')}</p>
                                                <ul className="list-disc pl-5 space-y-0.5">
                                                    {deps.map((d) => <li key={d.key}>{tx(d.key, d.fallback, d.vars)}</li>)}
                                                </ul>
                                            </div>
                                        )}
                                        <p className="text-[11px] text-rose-700">{tx('fields.delete.data', 'Los datos ya guardados no se borran, pero dejan de verse en el formulario. Podrás volver a añadirlo mientras el formulario no esté publicado.')}</p>
                                        <div className="flex flex-wrap gap-2 pt-1">
                                            <button type="button" disabled={deleteBusy} onClick={() => handleDelete(field)} autoFocus
                                                className="px-4 py-2.5 rounded-xl bg-rose-600 text-white hover:bg-rose-700 font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50">
                                                {deleteBusy ? tx('saving', 'Guardando…') : tx('fields.delete.yes', 'Eliminar campo')}
                                            </button>
                                            <button type="button" onClick={() => setDeleteAsk(null)}
                                                className="px-4 py-2.5 rounded-xl bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400 font-black text-[10px] uppercase tracking-widest transition-all">
                                                {tx('cancel', 'Cancelar')}
                                            </button>
                                        </div>
                                    </div>
                                );
                            })()}
                            </React.Fragment>
                        ))}
                    </div>
                </div>

                <div className="sticky top-6">
                    <div className="flex items-center justify-between mb-6">
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
                            <h4 className="font-black text-gray-900 italic tracking-tight">{t('live.preview')}</h4>
                        </div>
                        <div className="flex gap-1.5 p-1 bg-gray-100 rounded-lg">
                            <div className="w-2.5 h-2.5 rounded-full bg-gray-300"></div>
                            <div className="w-2.5 h-2.5 rounded-full bg-gray-300"></div>
                            <div className="w-2.5 h-2.5 rounded-full bg-gray-300"></div>
                        </div>
                    </div>

                    <div className="bg-white border-8 border-gray-900 rounded-[3rem] shadow-2xl overflow-hidden min-h-[600px] flex flex-col relative">
                        {/* Notch decoration */}
                        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-gray-900 rounded-b-2xl z-20"></div>

                        <div className="bg-gradient-to-br from-blue-600 to-indigo-700 p-8 pt-12 text-white text-center relative overflow-hidden">
                            <div aria-hidden="true" className={DECO_LAYER_CLASS} data-cm-deco=""><div className="absolute -right-10 -top-10 w-32 h-32 bg-white/10 rounded-full blur-2xl"></div></div>
                            <h5 className="font-black text-2xl italic tracking-tight relative z-10">Inscripción</h5>
                            <p className="text-xs font-bold uppercase tracking-widest opacity-60 mt-1 relative z-10">{conference?.name || 'Nombre de la Conferencia'}</p>
                        </div>

                        <div className="p-8 space-y-6 flex-1 bg-white relative">
                            {fields.length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center text-gray-300 text-center p-10 mt-12 bg-gray-50/50 rounded-3xl border-2 border-dashed border-gray-100 mx-4">
                                    <i className="fa-solid fa-wand-sparkles text-5xl mb-4 opacity-10"></i>
                                    <p className="text-xs font-bold uppercase tracking-widest leading-relaxed">El formulario está desierto.<br /><span className="opacity-50 font-medium lowercase italic">Añade campos para empezar</span></p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 gap-x-5 gap-y-5">
                                    {fields.map(f => (
                                        <div key={f.id} className={`space-y-1.5 ${f.width === 50 ? 'col-span-1' : 'col-span-2'}`}>
                                            <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">
                                                {f.label} {f.is_required ? <span className="text-rose-500">*</span> : ''}
                                            </label>
                                            {f.type === 'select' ? (
                                                <div className="relative">
                                                    <div className="w-full border-2 border-gray-100 rounded-2xl p-3 bg-gray-50/30 text-xs font-medium text-gray-400 flex justify-between items-center italic">
                                                        {f.options?.split(',')[0].trim() || 'Seleccione...'}
                                                        <i className="fa-solid fa-chevron-down text-[10px]"></i>
                                                    </div>
                                                </div>
                                            ) : f.type === 'health' ? (
                                                <div className="space-y-1.5 text-xs font-medium text-gray-400 italic">
                                                    {[...String(f.options || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 3), tx('health.other', 'Otros')].map(o => (
                                                        <div key={o} className="flex items-center gap-2"><span className="w-3.5 h-3.5 rounded border-2 border-gray-200" aria-hidden="true"></span>{o}</div>
                                                    ))}
                                                    <p className="text-[10px] not-italic text-gray-400"><i className="fa-solid fa-lock mr-1" aria-hidden="true"></i>{tx('health.preview.note', 'Datos sensibles: solo los ve quien tiene «Datos de salud».')}</p>
                                                </div>
                                            ) : f.type === 'switch' ? (
                                                <div className="flex items-center gap-3 p-1 text-xs font-medium text-gray-400 italic">
                                                    <span className="relative inline-block w-11 h-6 rounded-full bg-blue-600/60" aria-hidden="true"><span className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow translate-x-5"></span></span>
                                                    {switchLabel(tx, true)}
                                                </div>
                                            ) : (
                                                <div className="w-full border-2 border-gray-100 rounded-2xl p-3 bg-gray-50/30 text-xs font-medium text-gray-400 italic">
                                                    {f.type === 'date' ? 'AAAA-MM-DD' : `Ingrese ${f.label.toLowerCase()}...`}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                    <div className="col-span-2 pt-4">
                                        <div className="w-full bg-blue-600 text-white font-black text-xs uppercase tracking-widest py-4 rounded-2xl shadow-lg shadow-blue-500/30 text-center">
                                            Enviar Inscripción
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="p-6 bg-gray-50/50 border-t border-gray-50 text-[10px] text-center text-gray-400 font-bold uppercase tracking-widest">
                            WordJS Preview System
                        </div>
                    </div>
                </div>
            </div>

            {
                showModal && (
                    <Overlay layer={1} backdrop="rgba(17,24,39,0.6)">
                        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg border border-gray-100 animate-in zoom-in-95 duration-200 relative my-auto overflow-visible">
                            <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between">
                                <div>
                                    <h3 className="font-bold text-xl text-gray-900">{formData.id ? tx('edit.field', 'Editar Campo') : tx('add.field', 'Nuevo Campo')}</h3>
                                    <p className="text-xs text-gray-500 mt-0.5">{tx('field.dialog.subtitle', 'Configura las propiedades de este campo personalizado')}</p>
                                </div>
                                <button onClick={() => setShowModal(false)} className="text-gray-500 hover:text-gray-700 transition-colors p-2 hover:bg-gray-100 rounded-lg" aria-label={tx('close', 'Cerrar')}>
                                    <i className="fa-solid fa-xmark text-lg"></i>
                                </button>
                            </div>

                            {!formData.id && (() => {
                                const groupedBy = fields.find(f => Number(f.is_group));
                                return (
                                    <div className="px-8 pt-6 space-y-3" data-field-templates="">
                                        <div>
                                            <h4 className="text-xs font-black text-gray-500 uppercase tracking-widest">{tx('fields.templates.title', 'Campos básicos')}</h4>
                                            <p className="text-[11px] text-gray-500 mt-0.5" data-field-templates-hint="">{tx('fields.templates.hint', 'Plantillas con la configuración que usan el hospedaje, las comidas, las exportaciones y el portal. Después podrás editarlos o eliminarlos como cualquier otro campo.')}</p>
                                        </div>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                            {templateStates(fields).map(({ template, existing }) => {
                                                const label = tx(template.labelKey, template.fallback);
                                                return (
                                                    <button key={template.key} type="button" disabled={!!existing || templateBusy != null}
                                                        onClick={() => addTemplate(template.key, label)} data-template={template.key}
                                                        title={existing ? tx('fields.template.exists', 'Ya está en el formulario como «{label}»', { label: existing.label || existing.name }) : tx(template.hintKey, template.hint)}
                                                        className={`flex items-start gap-3 p-3 rounded-xl border-2 border-gray-100 text-left transition-all disabled:cursor-not-allowed ${existing ? TEMPLATE_DONE_CLASS : TEMPLATE_OPEN_CLASS}`} data-template-state={existing ? 'exists' : 'open'}>
                                                        <span className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${existing ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-white border-gray-100 text-blue-500'}`}><i className={`fa-solid ${existing ? 'fa-check' : template.icon} text-xs`} aria-hidden="true"></i></span>
                                                        <span className="min-w-0">
                                                            <span className="block text-sm font-bold text-gray-800">{templateBusy === template.key ? tx('saving', 'Guardando…') : label}</span>
                                                            <span className={`block text-[10px] leading-snug ${TEMPLATE_DESC_CLASS}`} data-template-desc="">
                                                                {existing ? tx('fields.template.exists', 'Ya está en el formulario como «{label}»', { label: existing.label || existing.name }) : tx(template.hintKey, template.hint)}
                                                            </span>
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                        {groupedBy && !fields.some(f => f.name === 'family_group') && (
                                            <p className="text-[10px] text-gray-600" data-field-templates-note="">{tx('fields.template.group.taken', '«{label}» ya agrupa a los inscritos: «Grupo familiar» se añadiría sin agrupar (solo un campo puede hacerlo).', { label: groupedBy.label })}</p>
                                        )}
                                        <p className="text-[10px] text-gray-600 flex items-start gap-1.5" data-field-templates-note=""><i className="fa-solid fa-location-dot mt-0.5" aria-hidden="true"></i><span>{tx('fields.template.location', 'La localidad no es un campo del formulario: la fija el acceso del encargado en el portal, o la eliges al inscribir desde aquí (pestaña «Localidades»).')}</span></p>
                                        <div className="flex items-center gap-3 pt-2">
                                            <div className="h-px bg-gray-100 flex-1"></div>
                                            <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">{tx('fields.custom.title', 'O un campo propio')}</span>
                                            <div className="h-px bg-gray-100 flex-1"></div>
                                        </div>
                                    </div>
                                );
                            })()}
                            <form {...fe.form(handleSubmit)} className="p-8 space-y-5 overflow-visible pb-20">
                                <div className="space-y-1.5">
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">{t('field.label')}</label>
                                    <div className="relative group">
                                        <input
                                            data-field="field_label" aria-invalid={fe.invalid('field_label')} aria-describedby={fe.describedBy('field_label')}
                                            required
                                            className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all outline-none text-gray-900 placeholder:text-gray-500 font-medium"
                                            value={formData.label}
                                            onChange={e => setFormData({ ...formData, label: e.target.value })}
                                            placeholder={tx('field.label.placeholder', 'Ej: ¿Cuál es su talle de camisa?')}
                                        />
                                    </div>
                                    <FieldError message={fe.error('field_label')} id={fe.errorId('field_label')} />
                                </div>

                                {formData.id && (
                                    <div className="space-y-1.5 opacity-60">
                                        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">{tx('field.system.id', 'ID del Sistema')}</label>
                                        <div className="flex items-center gap-2 bg-gray-50 px-4 py-2 rounded-xl border border-gray-100">
                                            <i className="fa-solid fa-code text-xs text-gray-400"></i>
                                            <span className="text-xs font-mono text-gray-500">{formData.name}</span>
                                        </div>
                                    </div>
                                )}

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                                    <div className="space-y-1.5 relative">
                                        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">{t('field.type')}</label>
                                        <button
                                            type="button"
                                            disabled={formData.name === LODGING_FIELD || formData.type === 'health'}
                                            title={formData.name === LODGING_FIELD ? tx('field.lodging.type.fixed', 'El campo «Requiere hospedaje» siempre es un interruptor Sí / No.') : formData.type === 'health' ? tx('field.health.type.fixed', 'El campo «Condiciones de salud» no cambia de tipo.') : undefined}
                                            onClick={() => setOpenSelect(openSelect === 'type' ? null : 'type')}
                                            className={`w-full flex items-center justify-between border-2 rounded-xl px-4 py-3 transition-all outline-none font-medium ${openSelect === 'type' ? 'bg-white border-blue-500 ring-4 ring-blue-500/10' : 'bg-gray-50/30 border-gray-100 hover:border-gray-200'}`}
                                        >
                                            <div className="flex items-center gap-3">
                                                {(() => {
                                                    const current = FIELD_TYPES.find(t => t.value === formData.type);
                                                    return (
                                                        <>
                                                            <div className={`w-6 h-6 shrink-0 rounded-lg ${current?.bg} flex items-center justify-center`}>
                                                                <i className={`fa-solid ${current?.icon} text-xs ${current?.color}`}></i>
                                                            </div>
                                                            <span className="text-gray-900">{current?.label}</span>
                                                        </>
                                                    )
                                                })()}
                                            </div>
                                            <i className={`fa-solid fa-chevron-down text-xs text-gray-400 transition-transform ${openSelect === 'type' ? 'rotate-180' : ''}`}></i>
                                        </button>

                                        {openSelect === 'type' && (
                                            <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-100 rounded-2xl shadow-xl z-50 p-2 animate-in slide-in-from-top-2 duration-200 overflow-hidden">
                                                {FIELD_TYPES.filter(type => type.value !== 'health').map(type => (
                                                    <button
                                                        key={type.value}
                                                        type="button"
                                                        onClick={() => { setFormData({ ...formData, type: type.value as any }); setOpenSelect(null); }}
                                                        className={`w-full flex items-center gap-4 p-3 rounded-xl transition-colors ${formData.type === type.value ? 'bg-blue-50/50 text-blue-700' : 'hover:bg-gray-50 text-gray-600'}`}
                                                    >
                                                        <div className={`w-8 h-8 shrink-0 rounded-xl ${type.bg} flex items-center justify-center group-hover:scale-110 transition-transform`}>
                                                            <i className={`fa-solid ${type.icon} text-sm ${type.color}`}></i>
                                                        </div>
                                                        <div className="text-left">
                                                            <div className="font-bold text-sm leading-none">{type.label}</div>
                                                        </div>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    <div className="space-y-1.5 relative">
                                        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">{t('field.required')}</label>
                                        <button
                                            type="button"
                                            onClick={() => setOpenSelect(openSelect === 'required' ? null : 'required')}
                                            className={`w-full flex items-center justify-between border-2 rounded-xl px-4 py-3 transition-all outline-none font-medium ${openSelect === 'required' ? 'bg-white border-blue-500 ring-4 ring-blue-500/10' : 'bg-gray-50/30 border-gray-100 hover:border-gray-200'}`}
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className={`w-6 h-6 shrink-0 rounded-lg ${formData.is_required ? 'bg-rose-50' : 'bg-emerald-50'} flex items-center justify-center`}>
                                                    <i className={`fa-solid ${formData.is_required ? 'fa-asterisk text-rose-500' : 'fa-check text-emerald-500'} text-[10px]`}></i>
                                                </div>
                                                <span className="text-gray-900">{formData.is_required ? tx('field.required.yes', 'Obligatorio') : tx('field.required.no', 'Opcional')}</span>
                                            </div>
                                            <i className={`fa-solid fa-chevron-down text-xs text-gray-400 transition-transform ${openSelect === 'required' ? 'rotate-180' : ''}`}></i>
                                        </button>

                                        {openSelect === 'required' && (
                                            <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-100 rounded-2xl shadow-xl z-50 p-2 animate-in slide-in-from-top-2 duration-200">
                                                <button
                                                    type="button"
                                                    onClick={() => { setFormData({ ...formData, is_required: 1 }); setOpenSelect(null); }}
                                                    className={`w-full flex items-center gap-4 p-3 rounded-xl transition-colors ${formData.is_required === 1 ? 'bg-rose-50/50 text-rose-700' : 'hover:bg-gray-50 text-gray-600'}`}
                                                >
                                                    <div className="w-8 h-8 shrink-0 rounded-xl bg-rose-50 flex items-center justify-center">
                                                        <i className="fa-solid fa-asterisk text-xs text-rose-500"></i>
                                                    </div>
                                                    <div className="font-bold text-sm">{tx('field.required.yes', 'Obligatorio')}</div>
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => { setFormData({ ...formData, is_required: 0 }); setOpenSelect(null); }}
                                                    className={`w-full flex items-center gap-4 p-3 rounded-xl transition-colors ${formData.is_required === 0 ? 'bg-emerald-50/50 text-emerald-700' : 'hover:bg-gray-50 text-gray-600'}`}
                                                >
                                                    <div className="w-8 h-8 shrink-0 rounded-xl bg-emerald-50 flex items-center justify-center">
                                                        <i className="fa-solid fa-check text-xs text-emerald-500"></i>
                                                    </div>
                                                    <div className="font-bold text-sm">{tx('field.required.no', 'Opcional')}</div>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-1.5 overflow-visible">
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">{tx('field.width', 'Ancho del Campo')}</label>
                                    <div className="grid grid-cols-2 gap-3">
                                        <button
                                            type="button"
                                            onClick={() => setFormData({ ...formData, width: 100 })}
                                            className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all ${formData.width === 100 ? 'border-blue-500 bg-blue-50/30' : 'border-gray-100 bg-gray-50/30 hover:border-gray-200'}`}
                                        >
                                            <div className="w-full h-8 bg-gray-200 rounded flex items-center px-1">
                                                <div className="w-full h-4 bg-blue-400 rounded"></div>
                                            </div>
                                            <span className={`text-xs font-bold ${formData.width === 100 ? 'text-blue-700' : 'text-gray-500'}`}>{tx('field.width.full', '100% Ancho')}</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setFormData({ ...formData, width: 50 })}
                                            className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all ${formData.width === 50 ? 'border-blue-500 bg-blue-50/30' : 'border-gray-100 bg-gray-50/30 hover:border-gray-200'}`}
                                        >
                                            <div className="w-full h-8 bg-gray-200 rounded flex items-center px-1 gap-1">
                                                <div className="w-1/2 h-4 bg-blue-400 rounded"></div>
                                                <div className="w-1/2 h-4 bg-gray-300 rounded opacity-30"></div>
                                            </div>
                                            <span className={`text-xs font-bold ${formData.width === 50 ? 'text-blue-700' : 'text-gray-500'}`}>{tx('field.width.half', '50% Ancho')}</span>
                                        </button>
                                    </div>
                                </div>

                                {/* Generic per-field behaviours — ANY field can carry these; nothing is tied to a
                                    fixed person attribute. Editable anytime (they don't alter the column). Separate
                                    "by gender / by any field" for lodging lives in the Assignment tab as a rule. */}
                                <div className="space-y-2.5">
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">{tx('field.behaviour', 'Comportamiento del campo')}</label>
                                    <label className="flex items-start gap-3 p-3 rounded-xl border-2 border-gray-100 bg-gray-50/30 cursor-pointer hover:border-blue-200 transition-all">
                                        <input
                                            type="checkbox"
                                            className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                            checked={!!formData.is_group}
                                            onChange={e => setFormData({ ...formData, is_group: e.target.checked ? 1 : 0 })}
                                        />
                                        <span>
                                            <span className="block text-sm font-semibold text-gray-800">{tx('field.group', 'Agrupar inscritos por este campo')}</span>
                                            <span className="block text-[11px] text-gray-500">{tx('field.group.hint', 'Activa los grupos en el portal (p. ej. grupo familiar, delegación). Solo un campo puede agrupar.')}</span>
                                        </span>
                                    </label>
                                    <label className="flex items-start gap-3 p-3 rounded-xl border-2 border-gray-100 bg-gray-50/30 cursor-pointer hover:border-blue-200 transition-all">
                                        <input
                                            type="checkbox"
                                            className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                            checked={!!formData.is_unique}
                                            onChange={e => setFormData({ ...formData, is_unique: e.target.checked ? 1 : 0 })}
                                        />
                                        <span>
                                            <span className="block text-sm font-semibold text-gray-800">{tx('field.unique', 'No permitir valores duplicados')}</span>
                                            <span className="block text-[11px] text-gray-500">{tx('field.unique.hint', 'Rechaza la inscripción si otro inscrito ya tiene el mismo valor (p. ej. documento, email).')}</span>
                                        </span>
                                    </label>
                                </div>

                                {formData.type === 'health' && (
                                    <div className="space-y-1.5 animate-in slide-in-from-top-2 duration-300" data-health-options-editor="">
                                        <label htmlFor="cm-health-options" className="block text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">{tx('field.health.options', 'Condiciones que se ofrecen')}</label>
                                        <textarea
                                            id="cm-health-options"
                                            rows={4}
                                            className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm resize-y"
                                            value={formData.options}
                                            onChange={e => setFormData({ ...formData, options: e.target.value })}
                                        />
                                        <p className="text-[10px] text-gray-500 px-1">{tx('field.health.options.hint', 'Separa las condiciones por comas. «Otros» (con texto), «Ninguna» y «Prefiero no responder» se añaden solos. El peso de cada una para los turnos de comida se ajusta en Alimentación › Turnos.')}</p>
                                    </div>
                                )}

                                {formData.type === 'select' && (
                                    <div className="space-y-1.5 animate-in slide-in-from-top-2 duration-300">
                                        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">{t('field.options')}</label>
                                        <input
                                            className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 placeholder:text-gray-500 font-medium"
                                            value={formData.options}
                                            onChange={e => setFormData({ ...formData, options: e.target.value })}
                                            placeholder={tx('field.options.placeholder', 'Pequeña, Mediana, Grande')}
                                        />
                                        <p className="text-[10px] text-gray-500 px-1 italic">{tx('field.options.hint', '* Separa las opciones por comas')}</p>
                                    </div>
                                )}

                                <div className="flex items-center justify-end gap-3 pt-6" data-cm-sheet-foot="">
                                    <button
                                        type="button"
                                        onClick={() => setShowModal(false)}
                                        className="px-6 py-3 text-gray-500 font-bold hover:text-gray-700 hover:bg-gray-100 rounded-xl transition-all"
                                    >
                                        {t('cancel')}
                                    </button>
                                    <button
                                        type="submit"
                                        className="px-8 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-bold shadow-lg shadow-blue-500/20 active:scale-95 transition-all flex items-center gap-2"
                                    >
                                        <span>{t('save')}</span>
                                        <i className="fa-solid fa-check text-sm opacity-50"></i>
                                    </button>
                                </div>
                            </form>
                        </div>
                    </Overlay>
                )
            }
        </div >
    );
}


// Assignment Component
// The four composable assignment-rule primitives (must match the backend engine's rule types).
const RULE_TYPES = [
    { v: 'keep_together', label: 'Mantener juntos', icon: 'fa-people-group', desc: 'Los inscritos con el mismo valor del campo van a la misma habitación (con tamaño mínimo).' },
    { v: 'separate_by', label: 'Separar por', icon: 'fa-shield-halved', desc: 'Una habitación admite un solo valor de este campo (p. ej. género estricto). Excepción: una familia que una regla «Mantener juntos» de más prioridad deja junta puede estar en una habitación mixta, pero esa habitación es solo para ella.' },
    { v: 'split_by', label: 'Al dividir, agrupar por', icon: 'fa-arrows-split-up-and-left', desc: 'Cuando un grupo no cabe entero, se divide siguiendo este campo.' },
    { v: 'require_companion', label: 'Requiere acompañante', icon: 'fa-user-shield', desc: 'Una habitación con alguien que cumple una condición exige N que cumplen otra (p. ej. un niño necesita un adulto).' },
];
const ruleTypeMeta = (t: string) => RULE_TYPES.find(r => r.v === t) || RULE_TYPES[0];

// Editor for a CONDITION = a list of { field, op, value } predicates AND-ed together. Same vocabulary
// as the pricing rules, reused so the whole plugin speaks one predicate language.
const PRED_OPS = [
    { v: 'eq', l: '=' }, { v: 'neq', l: '≠' }, { v: 'gt', l: '>' }, { v: 'gte', l: '≥' },
    { v: 'lt', l: '<' }, { v: 'lte', l: '≤' }, { v: 'contains', l: 'contiene' },
    { v: 'filled', l: 'tiene valor' }, { v: 'empty', l: 'vacío' },
];
const opNeedsNoValue = (op: string) => op === 'filled' || op === 'empty';
function PredicateEditor({ fields, value, onChange, label }: any) {
    const preds = Array.isArray(value) ? value : [];
    const set = (i: number, patch: any) => onChange(preds.map((p: any, idx: number) => idx === i ? { ...p, ...patch } : p));
    const add = () => onChange([...preds, { field: fields[0]?.name || '', op: 'eq', value: '' }]);
    const remove = (i: number) => onChange(preds.filter((_: any, idx: number) => idx !== i));
    return (
        <div className="space-y-2">
            {label && <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{label}</label>}
            {preds.length === 0 && <p className="text-[10px] text-gray-400 italic px-1">Sin condición (aplica a todos).</p>}
            {preds.map((p: any, i: number) => (
                <div key={i} className="flex items-center gap-2">
                    <Select className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-2 text-xs bg-white" value={p.field} onChange={e => set(i, { field: e.target.value })}>
                        {fields.map((f: any) => <option key={f.name} value={f.name}>{f.label}</option>)}
                    </Select>
                    <Select className="border border-gray-200 rounded-lg px-2 py-2 text-xs bg-white" value={p.op} onChange={e => set(i, { op: e.target.value })}>
                        {PRED_OPS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                    </Select>
                    {!opNeedsNoValue(p.op) && <input className="w-20 border border-gray-200 rounded-lg px-2 py-2 text-xs" value={p.value || ''} onChange={e => set(i, { value: e.target.value })} placeholder="valor" />}
                    <button type="button" onClick={() => remove(i)} className="text-gray-300 hover:text-rose-500 px-1"><i className="fa-solid fa-xmark"></i></button>
                </div>
            ))}
            <button type="button" onClick={add} className="text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-800"><i className="fa-solid fa-plus mr-1"></i>Añadir condición</button>
        </div>
    );
}

// ---------------------------------------------------------------------------------------------
// Accommodation (AssignmentPage): who sleeps where. Since 2.13.0 it is the lodging explorer
// (./LodgingExplorer.tsx) — «Hoteles › Hotel › Habitación» with the same drag & drop contract,
// room picker and frozen / cancelled protections the 2.5.0 board had.
// ---------------------------------------------------------------------------------------------

// `focus` / `onFocusConsumed`: «Ver ocupación» in «Hoteles y habitaciones» opens the explorer at a
// hotel (and room) once — see ConferenceManagerContent.openLodgingExplorer.
function AssignmentPage({ conferenceId, focus, onFocusConsumed }: { conferenceId: number; focus?: { hotelId?: number | null; roomId?: number | null; locationId?: number | null } | null; onFocusConsumed?: () => void }) {
    const { t, language } = useI18n();
    const fe = useFieldErrors(language);
    const tx = useTx();
    const { addToast } = useToast();
    // Hospedaje › gestionar = run / reset the engine, edit its rules, and move people in the explorer
    // (drag & drop and pickers); «ver» explores who sleeps where without changing anything.
    const canManage = usePerms().can('lodging', 'manage');
    const [rules, setRules] = useState<AssignmentRule[]>([]);
    const [fields, setFields] = useState<ConferenceField[]>([]);
    const [stats, setStats] = useState({ total: 0, assigned: 0, unassigned: 0 });
    const [running, setRunning] = useState(false);
    const [loading, setLoading] = useState(true);
    const [showRuleModal, setShowRuleModal] = useState(false);
    const [runReport, setRunReport] = useState<any>(null);
    // «Sugerir reparto» (2.20.0) from here too — the run's own page is where the owner looked for it.
    const [showPlan, setShowPlan] = useState(false);
    // The lodging explorer's data: every attendee, every hotel with its rooms, every location.
    const [inscriptions, setInscriptions] = useState<Inscription[]>([]);
    const [hotels, setHotels] = useState<Hotel[]>([]);
    const [locations, setLocations] = useState<Location[]>([]);
    // Attendees with a move in flight: the explorer refuses a second move of the same attendee until it settles.
    const [pending, setPending] = useState<Set<number>>(() => new Set());
    // The latest load failed: the explorer then keeps its remembered place (it would otherwise fit it to
    // the empty lists and forget it) and offers a retry instead of «No hay hoteles configurados».
    const [loadFailed, setLoadFailed] = useState(false);
    const boardRef = useRef<HTMLDivElement>(null);
    const reportRef = useRef<HTMLDivElement>(null);
    // Reload ordering: two overlapping reloads may resolve out of order; only the latest one is applied.
    const loadSeq = useRef(0);
    const [ruleForm, setRuleForm] = useState<Partial<AssignmentRule>>({
        name: '', type: 'keep_together', enabled: 1, priority: 50, config: '', hard: 0, params: {}
    });
    // params arrives from the API as a JSON string; parse it into the form for editing.
    // Priorities (2.21.0): the higher number goes first, and no two rules share one (the server refuses it). A new
    // rule takes a free number below the others (it goes last); the admin changes it at will.
    const freePriority = () => {
        const used = new Set(rules.map(r => Number(r.priority)));
        let p = (rules.length ? Math.min(...rules.map(r => Number(r.priority) || 0)) : 60) - 10;
        while (p >= 1 && used.has(p)) p--;
        if (p < 1) { p = 1; while (used.has(p) && p < 100) p++; }
        return p;
    };
    const openNewRule = () => { setRuleForm({ name: '', type: 'keep_together', enabled: 1, priority: freePriority(), config: '', hard: 0, params: {} }); setShowRuleModal(true); };
    const openEditRule = (rule: any) => {
        let params: any = {};
        try { params = typeof rule.params === 'string' ? JSON.parse(rule.params || '{}') : (rule.params || {}); } catch { params = {}; }
        setRuleForm({ ...rule, params }); setShowRuleModal(true);
    };

    // silent = refresh the data without the loading spinner (after a run, a reset or a board move).
    const loadData = async (silent = false) => {
        if (!silent) setLoading(true);
        const seq = ++loadSeq.current;
        try {
            const [rulesData, inscriptionsData, fieldsData, hotelsData, locData] = await Promise.all([
                conferenceApi.getAssignmentRules(conferenceId),
                conferenceApi.getInscriptions(conferenceId),
                conferenceApi.getFields(conferenceId),
                conferenceApi.getHotels(conferenceId),
                conferenceApi.getLocations(conferenceId).catch(() => null),
            ]);
            if (seq !== loadSeq.current) return; // a newer load already landed (or is about to)

            setFields(fieldsData);

            // No rule is seeded, here or by the backend (2.16.0: a new conference starts with none) — the
            // admin adds them in this page.
            setRules(rulesData);

            setInscriptions(inscriptionsData || []);
            setHotels(hotelsData || []);
            setLocations(locData?.locations || []);
            setLoadFailed(false);
            // Cancelled attendees are neither placed by the engine nor listed by the board — the header
            // counts (and the run button's gate) leave them out too.
            // «Requiere hospedaje: No» (2.31.0) is not waiting for a bed either (unless one is still held).
            const live = (inscriptionsData || []).filter(i => i.status !== 'cancelled' && (i.room_id || needsLodging(i)));
            const assigned = live.filter(i => i.room_id).length;
            setStats({ total: live.length, assigned, unassigned: live.length - assigned });
        } catch (e) {
            console.error(e);
            if (seq === loadSeq.current) setLoadFailed(true);
        } finally {
            if (!silent && seq === loadSeq.current) setLoading(false);
        }
    };
    const reload = () => loadData(true);

    // One board move: optimistic update, POST /inscriptions/:id/assign, then a silent reload. A server
    // refusal (full / other location / cancelled: 400) reverts THAT attendee only (a whole-list snapshot
    // would undo a newer move that succeeded meanwhile), surfaces its message and re-syncs. A move in a
    // submitted / validated arrangement goes through (2.17.0) and says it was recorded as an adjustment.
    // Resolves true when the move stuck (the modal closes on true).
    const moveAttendee = async (inscriptionId: number, roomId: number | null): Promise<boolean> => {
        if (pending.has(inscriptionId)) return false;
        const before = inscriptions.find(p => p.id === inscriptionId);
        if (!before) return false;
        setPending(set => new Set(set).add(inscriptionId));
        let target: { room: Room; hotel: Hotel } | null = null;
        if (roomId != null) {
            for (const h of hotels) {
                const r = (h.rooms || []).find(x => Number(x.id) === Number(roomId));
                if (r) { target = { room: r, hotel: h }; break; }
            }
        }
        setInscriptions(list => list.map(p => p.id === inscriptionId
            ? { ...p, room_id: roomId, room_number: target ? target.room.room_number : undefined, hotel_name: target ? target.hotel.name : undefined }
            : p));
        try {
            const result = await conferenceApi.assignRoom(inscriptionId, roomId);
            const label = target ? `${target.hotel.name} · ${target.room.room_number}` : `#${roomId}`;
            const done = roomId != null ? fillVars(t('board.moved') || 'Movido a {room}', { room: label }) : (t('board.removed') || 'Quitado de la habitación');
            addToast(withAdjusted(tx, done, result), 'success');
            await reload();
            return true;
        } catch (e: any) {
            setInscriptions(list => list.map(p => p.id === inscriptionId
                ? { ...p, room_id: before.room_id, room_number: before.room_number, hotel_name: before.hotel_name }
                : p));
            addToast(e?.message || 'Error', 'error');
            await reload();
            return false;
        } finally {
            setPending(set => { const next = new Set(set); next.delete(inscriptionId); return next; });
        }
    };

    // Held by the administration (2.21.0): a blocked room and a person fixed in their room are left as they are by
    // every suggestion and run; only the administration changes them by hand.
    const toggleRoomBlock = async (room: Room) => {
        const on = !Number(room.blocked);
        try {
            await conferenceApi.setRoomBlocked(room.id, on);
            addToast(on ? (t('room.block.on.done') || 'Habitación bloqueada') : (t('room.block.off.done') || 'Habitación desbloqueada'), 'success');
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        await reload();
    };
    const togglePin = async (p: Inscription) => {
        const on = !pinnedHere(p as any);
        try {
            await conferenceApi.pinInscription(p.id, on);
            addToast(on ? (t('person.pin.on.done') || 'Fijada en su habitación') : (t('person.pin.off.done') || 'Ya no está fijada'), 'success');
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        await reload();
    };

    useEffect(() => {
        loadData();
    }, [conferenceId]);

    const handleSaveRule = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            // An emptied priority box takes a free number; an emptied «tamaño mínimo» / «al menos» is 1 (the server's default).
            const priority = (ruleForm.priority as any) === '' || ruleForm.priority == null ? freePriority() : Number(ruleForm.priority);
            await conferenceApi.saveAssignmentRule({ ...ruleForm, priority, conference_id: conferenceId });
            setShowRuleModal(false);
            setRuleForm({ name: '', type: 'keep_together', enabled: 1, priority: 50, config: '', hard: 0, params: {} });
            loadData();
        } catch (e: any) {
            addToast(e?.message || 'Error saving rule', 'error');
        }
    };

    const handleToggleRule = async (rule: AssignmentRule) => {
        try {
            await conferenceApi.saveAssignmentRule({ ...rule, enabled: rule.enabled ? 0 : 1 });
            loadData();
        } catch (e: any) {
            addToast(e?.message || 'Error updating rule', 'error');
        }
    };

    const { confirm } = useModal();

    const handleDeleteRule = async (rule: AssignmentRule) => {
        if (!await confirm(`${t('confirm.delete.rule') || '¿Eliminar la regla'} "${rule.name}"?`, t('delete') || 'Eliminar', true)) return;
        try {
            await conferenceApi.deleteAssignmentRule(rule.id);
            addToast(t('rule.deleted') || 'Regla eliminada', 'success');
            loadData();
        } catch (e: any) {
            addToast(e?.message || 'Error deleting rule', 'error');
        }
    };

    const handleRun = async () => {
        setRunning(true);
        setRunReport(null);
        addToast(t('assignment.started'), 'info');
        try {
            const result: any = await conferenceApi.runAssignment(conferenceId);
            setRunReport(result);
            const nv = (result.violations || []).length;
            if (nv > 0) addToast(`Asignados: ${result.assignedCount}. ${nv} punto(s) no se pudieron cumplir del todo — revisa el reporte.`, 'error');
            else addToast(`${t('assignment.completed')}: ${result.assignedCount} ${t('participant.plural')}`, 'success');
            await reload();
            // The board is the answer to "who went where": bring it into view once the new data is in.
            // With violations the toast says "revisa el reporte", so the report (rendered above the
            // board) is what must be on screen, not scrolled out above the board's top edge.
            const el = nv > 0 ? (reportRef.current || boardRef.current) : boardRef.current;
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                if (el === boardRef.current) el.focus({ preventScroll: true });
            }
        } catch (e: any) {
            addToast(e.message || 'Error running assignment', 'error');
        } finally {
            setRunning(false);
        }
    };

    // "«Norte» no se tocó: su hospedaje ya está validado. Ajústalo a mano en «Acomodación» (más abajo); volverá a
    // entrar en la asignación automática cuando se reabra desde Localidades." — the bulk run / reset never rewrite
    // a reviewed arrangement; the explorer below («Acomodación») adjusts it one change at a time (2.17.0). A
    // SUBMITTED one is not reopened but returned to its coordinator: {release} says which (adjustRelease).
    const skippedFrozenLine = (l: { name: string; status?: string | null }) =>
        adjustText(tx, 'assignment.skipped.frozen', '«{name}» no se tocó: su hospedaje {state}. Ajústalo a mano en «Acomodación» (más abajo); volverá a entrar en la asignación automática {release}.', { name: l.name, lodging_status: l.status });

    const handleReset = async () => {
        if (!await confirm(t('confirm.reset.assignments') || 'Reset all assignments?', t('reset.assignments') || "Reset Assignments", true)) return;
        try {
            const result: any = await conferenceApi.resetAssignments(conferenceId);
            const skipped: any[] = (result && result.skipped_frozen) || [];
            if (skipped.length > 0) addToast(`${t('assignment.reset.done')}. ${skipped.map(s => skippedFrozenLine(s)).join(' ')}`, 'warning');
            else addToast(t('assignment.reset.done'), 'success');
            setRunReport(null);
            reload();
        } catch (e) {
            addToast('Error resetting assignments', 'error');
        }
    };

    // One object per run (the board re-opens every hotel when it changes, so it must not change per render).
    // `remaining` is EVERYONE the run left without a bed — those it could not place (no room left) plus those
    // of the submitted / validated locations it did not touch (`skipped`, 2.17.0) — the same number as the
    // explorer's «N sin asignar» and the «Pendientes» above once the run is done; the chip says how many of
    // them were not touched («Pendientes: 0» next to «2 sin asignar» read as a contradiction).
    const runSummary = useMemo(
        () => (runReport ? runSummaryOf(runReport) : null),
        [runReport]
    );

    // Convenience accessors for the current rule's type-specific params blob.
    const rParams: any = ruleForm.params || {};
    // Another rule with the number typed: said at once (the server refuses it too).
    const priorityClash = (ruleForm.priority as any) === '' || ruleForm.priority == null ? null
        : rules.find(r => r.id !== (ruleForm as any).id && Number(r.priority) === Number(ruleForm.priority)) || null;
    // A box the admin may empty while typing: '' stays '' (not snapped back to 1).
    const numOrEmpty = (v: string) => (v === '' ? '' : Number(v));
    const setRParam = (patch: any) => setRuleForm({ ...ruleForm, params: { ...(ruleForm.params || {}), ...patch } });
    const fieldSelect = (
        <div className="space-y-1.5">
            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('rule.field') || 'Campo'}</label>
            <Select
                className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm"
                value={ruleForm.config}
                onChange={e => setRuleForm({ ...ruleForm, config: e.target.value })}
            >
                <option value="">{t('select.field') || 'Seleccionar...'}</option>
                {fields.map(f => (<option key={f.name} value={f.name}>{f.label}</option>))}
            </Select>
        </div>
    );

    return (
        <div className="space-y-10 animate-in fade-in duration-500">
            <ReadOnlyNotice section="lodging" />
            {showPlan && <LodgingPlan conferenceId={conferenceId} hotels={hotels} onClose={() => setShowPlan(false)} onApplied={() => loadData(true)} />}
            {/* Premium Header & Summary */}
            <div className="relative overflow-hidden bg-white rounded-3xl p-8 border border-gray-100 shadow-xl shadow-gray-100/50">
                <div className="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 bg-indigo-50/50 rounded-full blur-3xl"></div>

                <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-8">
                    <div className="flex-1">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 shrink-0 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-lg shadow-indigo-200">
                                <i className="fa-solid fa-wand-magic-sparkles"></i>
                            </div>
                            <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-[0.2em]">{t('assignment')}</span>
                        </div>
                        <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter mb-4">{t('auto.assignment.title') || 'Asignación Automática'}</h2>

                        <div className="flex flex-wrap items-center gap-6">
                            <div className="bg-gray-50/80 px-5 py-3 rounded-2xl border border-gray-100 flex items-center gap-4">
                                <div className="text-center">
                                    <div className="text-sm font-black text-gray-900 leading-none">{stats.total}</div>
                                    <div className="text-[8px] font-black text-gray-400 uppercase tracking-widest mt-1">Total</div>
                                </div>
                                <div className="w-px h-6 bg-gray-200"></div>
                                <div className="text-center">
                                    <div className="text-sm font-black text-emerald-600 leading-none">{stats.assigned}</div>
                                    <div className="text-[8px] font-black text-gray-400 uppercase tracking-widest mt-1">Asignados</div>
                                </div>
                                <div className="w-px h-6 bg-gray-200"></div>
                                <div className="text-center">
                                    <div className="text-sm font-black text-amber-600 leading-none">{stats.unassigned}</div>
                                    <div className="text-[8px] font-black text-gray-400 uppercase tracking-widest mt-1">Pendientes</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {canManage && <div className="flex flex-wrap items-center gap-4">
                        {hotels.length > 0 && <button
                            type="button"
                            onClick={() => setShowPlan(true)}
                            className="px-6 py-4 bg-white text-blue-700 font-black text-[10px] uppercase tracking-widest rounded-2xl border-2 border-gray-100 hover:border-blue-500 transition-all flex items-center gap-2"
                            data-plan-open="assignment"
                        >
                            <i className="fa-solid fa-wand-magic-sparkles text-[10px]"></i> {tx('plan.open', 'Sugerir reparto')}
                        </button>}
                        <button
                            onClick={handleReset}
                            className="px-6 py-4 text-rose-600 font-black text-[10px] uppercase tracking-widest hover:bg-rose-50 rounded-2xl transition-all border-2 border-transparent hover:border-rose-100 flex items-center gap-2 group"
                        >
                            <i className="fa-solid fa-trash-can group-hover:scale-110 transition-transform"></i>
                            {t('reset.all.assignments')}
                        </button>
                        <button
                            onClick={handleRun}
                            disabled={running || stats.unassigned === 0}
                            className={`px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest flex items-center gap-3 transition-all active:scale-95 shadow-xl ${running || stats.unassigned === 0
                                ? 'bg-gray-100 text-gray-400 cursor-not-allowed shadow-none'
                                : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-indigo-500/30'
                                }`}
                        >
                            {running ? <i className="fa-solid fa-spinner fa-spin"></i> : <i className="fa-solid fa-play text-[8px]"></i>}
                            {t('run.auto.assignment')}
                        </button>
                    </div>}
                </div>
            </div>

            {runReport && (
                <div ref={reportRef} className={`rounded-3xl border p-6 shadow-xl ${(runReport.violations || []).length ? 'bg-amber-50/40 border-amber-200' : 'bg-emerald-50/40 border-emerald-200'}`}>
                    <div className="flex items-center gap-3 mb-3">
                        <i className={`fa-solid ${(runReport.violations || []).length ? 'fa-triangle-exclamation text-amber-500' : 'fa-circle-check text-emerald-500'} text-lg`}></i>
                        <h3 className="text-sm font-black text-gray-900 uppercase tracking-widest">Resultado de la asignación</h3>
                        <button onClick={() => setRunReport(null)} className="ml-auto text-gray-300 hover:text-gray-500"><i className="fa-solid fa-xmark"></i></button>
                    </div>
                    {/* Totals: assigned, left without a bed for lack of room, and left as they were in the
                        submitted / validated locations the run does not touch (listed below, with their count) —
                        «sin cupo» + «sin tocar» are the explorer's «N sin asignar» once the run is done. */}
                    <p className="text-xs text-gray-600 mb-3" data-run-totals="">
                        {tx('assignment.report.assigned', 'Asignados')} <b>{runReport.assignedCount}</b>
                        {runReport.remaining ? <> · <span className="text-amber-700 font-bold">{runReport.remaining} {t('assignment.remaining.short') || 'sin cupo'}</span></> : null}
                        {runSummary && runSummary.skipped ? <> · <span className="text-amber-700 font-bold" data-run-untouched={runSummary.skipped}>{tx('assignment.report.untouched', '{n} sin tocar (abajo)', { n: runSummary.skipped })}</span></> : null}.
                    </p>
                    {/* One line per delegated location the run covered, then the frozen ones it skipped. */}
                    {(runReport.by_location || []).length > 0 && (
                        <div className="mb-3">
                            <div className="text-[9px] font-black uppercase tracking-widest text-gray-400 mb-1">{t('assignment.by.location') || 'Por localidad'}</div>
                            <ul className="space-y-1">
                                {runReport.by_location.map((l: any) => (
                                    <li key={l.location_id} className="text-xs text-gray-700 flex items-baseline gap-2" data-run-location={l.location_id}>
                                        <i className="fa-solid fa-map-pin text-[9px] text-indigo-400 shrink-0"></i>
                                        {/* One text run: «Sur: 3 asignados» (as flex items, the name and the colon were a gap apart). */}
                                        <span><b>{l.name}</b>: {l.assignedCount} {Number(l.assignedCount) === 1 ? (t('assignment.assigned.one') || 'asignado') : (t('assignment.assigned.short') || 'asignados')}{Number(l.pool_beds) > 0 ? <span className="text-violet-700" data-run-pool-beds={l.pool_beds}> · {tx('assignment.pool.overflow', '{n} en camas del pool', { n: l.pool_beds })}</span> : null}{l.remaining ? <span className="text-amber-700 font-bold"> · {l.remaining} {t('assignment.remaining.short') || 'sin cupo'}</span> : null}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {(runReport.skipped_frozen || []).length > 0 && (
                        <ul className="mb-3 space-y-1">
                            {runReport.skipped_frozen.map((l: any) => (
                                <li key={l.location_id} className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <i className="fa-solid fa-circle-info text-[9px]" aria-hidden="true"></i>
                                    <span className="min-w-0 flex-1 basis-48">{skippedFrozenLine(l)}</span>
                                    {Number(l.unassigned) > 0 && (
                                        <span className="shrink-0 ml-auto px-2 py-0.5 rounded-full bg-white border border-amber-200 text-[10px] font-black text-amber-700" data-run-skipped-unassigned={l.unassigned}>
                                            {l.unassigned} {t('lodging.unlodged.short') || 'sin habitación'}
                                        </span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    {(runReport.violations || []).length === 0 ? (
                        <p className="text-xs text-emerald-700 font-medium">Todas las reglas se cumplieron. ✓</p>
                    ) : (
                        <ul className="space-y-1.5">
                            {runReport.violations.map((v: any, i: number) => (
                                <li key={i} className="flex items-start gap-2 text-xs text-gray-700">
                                    <span className={`mt-0.5 px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-widest whitespace-nowrap ${v.hard ? 'bg-rose-100 text-rose-600' : 'bg-gray-200 text-gray-500'}`}>{v.hard ? 'Obligatoria' : 'Preferente'}</span>
                                    <span><b>{v.rule}</b> — {v.detail}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {/* Who sleeps where — «Hoteles › Hotel › Habitación», editable by drag & drop and pickers. */}
            <LodgingExplorer
                key={conferenceId}
                conferenceId={conferenceId}
                inscriptions={inscriptions}
                hotels={hotels}
                locations={locations}
                fields={fields}
                onMove={moveAttendee}
                pending={pending}
                loading={loading}
                runSummary={runSummary}
                boardRef={boardRef}
                focus={focus}
                onFocusConsumed={onFocusConsumed}
                suspendKeys={showRuleModal}
                loadFailed={loadFailed}
                onRetry={() => loadData()}
                readOnly={!canManage}
                onToggleBlock={canManage ? toggleRoomBlock : undefined}
                onTogglePin={canManage ? togglePin : undefined}
            />

            <div className="bg-white rounded-3xl border border-gray-100 overflow-hidden shadow-xl shadow-gray-100/30">
                <div className="bg-gray-50/50 border-b border-gray-100 px-8 py-6 flex justify-between items-center">
                    <div>
                        <h3 className="text-sm font-black text-gray-900 uppercase tracking-widest leading-none">{t('assignment.rules')}</h3>
                        <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-2">{t('assignment.rules.desc') || 'Criterios para la distribución de habitaciones'}</p>
                        {rules.length > 1 && <p className="text-[11px] text-gray-500 mt-1" data-rules-order="">{tx('rules.order', 'Se aplican en este orden: de la prioridad más alta a la más baja.')}</p>}
                    </div>
                    {canManage && <button
                        onClick={openNewRule}
                        className="px-5 py-2.5 bg-white border border-gray-200 rounded-xl text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:bg-indigo-50 hover:border-indigo-200 transition-all flex items-center gap-2"
                    >
                        <i className="fa-solid fa-plus"></i>
                        {t('add.rule')}
                    </button>}
                </div>
                <div className="divide-y divide-gray-50">
                    {loading ? (
                        <div className="p-20 text-center">
                            <div className="inline-block w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('loading')}</p>
                        </div>
                    ) : rules.length === 0 ? (
                        <div className="p-20 text-center">
                            <div className="w-16 h-16 shrink-0 rounded-3xl bg-gray-50 flex items-center justify-center text-gray-300 mx-auto mb-4">
                                <i className="fa-solid fa-list-check text-2xl"></i>
                            </div>
                            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest">No hay reglas configuradas</p>
                        </div>
                    ) : rules.map((rule, ruleIndex) => (
                        <div key={rule.id} className="group p-6 flex items-center justify-between hover:bg-indigo-50/30 transition-all">
                            <div className="flex items-center gap-5">
                                <div className={`w-14 h-14 shrink-0 rounded-2xl flex items-center justify-center text-xl shadow-lg transition-all ${rule.enabled
                                    ? 'bg-indigo-600 text-white shadow-indigo-100'
                                    : 'bg-white text-gray-300 border border-gray-100 shadow-none'
                                    }`}>
                                    <i className={`fa-solid ${ruleTypeMeta(rule.type).icon} ${!rule.enabled && 'opacity-30'}`}></i>
                                </div>
                                <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                                        <h4 className={`font-black italic tracking-tighter text-lg ${rule.enabled ? 'text-gray-900' : 'text-gray-400'}`}>{rule.name}</h4>
                                        <div className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest bg-indigo-50 text-indigo-600">{ruleTypeMeta(rule.type).label}</div>
                                        {rule.hard
                                            ? <div className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest bg-rose-50 text-rose-600">Obligatoria</div>
                                            : <div className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest bg-gray-100 text-gray-400">Preferente</div>}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-3">
                                        <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-100 rounded-lg text-[9px] font-bold text-gray-500 uppercase tracking-tight" data-rule-rank={ruleIndex + 1}>
                                            <i className="fa-solid fa-bolt text-amber-500"></i>
                                            {tx('rules.rank', '{n}.ª · prioridad {p}', { n: ruleIndex + 1, p: rule.priority })}
                                        </div>
                                        {rule.config && (rule.type === 'keep_together' || rule.type === 'separate_by' || rule.type === 'split_by') && (
                                            <span className="font-black text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded uppercase text-[8px] tracking-widest">
                                                {fields.find(f => f.name === rule.config)?.label || rule.config}
                                            </span>
                                        )}
                                        {missingRuleFields(rule, fields).length > 0 && (
                                            <span className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 text-[10px] font-bold text-amber-700" data-rule-missing-field={rule.id}>
                                                <i className="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                                                {tx('rule.missing.field', 'Usa un campo que ya no está en el formulario ({fields}): no tiene efecto.', { fields: missingRuleFields(rule, fields).join(', ') })}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-4">
                                <button
                                    onClick={() => handleToggleRule(rule)}
                                    disabled={!canManage}
                                    className={`w-12 h-6 rounded-full transition-all relative disabled:cursor-not-allowed disabled:opacity-60 ${rule.enabled ? 'bg-emerald-500 shadow-lg shadow-emerald-100' : 'bg-gray-200'}`}
                                >
                                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm ${rule.enabled ? 'left-7' : 'left-1'}`}></div>
                                </button>
                                {canManage && <button onClick={() => openEditRule(rule)} title={t('edit') || 'Editar'} className="w-10 h-10 shrink-0 rounded-xl bg-white border border-gray-100 text-gray-400 hover:text-indigo-600 hover:border-indigo-100 hover:bg-indigo-50 transition-all flex items-center justify-center">
                                    <i className="fa-solid fa-pen text-sm"></i>
                                </button>}
                                {canManage && <button onClick={() => handleDeleteRule(rule)} title={t('delete')} className="w-10 h-10 shrink-0 rounded-xl bg-white border border-gray-100 text-gray-400 hover:text-rose-600 hover:border-rose-100 hover:bg-rose-50 transition-all flex items-center justify-center group/del">
                                    <i className="fa-solid fa-trash-can text-sm group-hover/del:scale-110 transition-transform"></i>
                                </button>}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {showRuleModal && (
                <Overlay layer={1}>
                    <div role="dialog" aria-modal="true" className="bg-white rounded-3xl shadow-2xl w-full max-w-lg border border-gray-100 max-h-[92vh] overflow-y-auto animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between sticky top-0 z-10">
                            <div>
                                <h3 className="font-black text-xl text-gray-900 italic tracking-tighter">{ruleForm.id ? 'Editar regla' : t('add.rule')}</h3>
                                <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">Criterio de asignación de habitaciones</p>
                            </div>
                            <button onClick={() => setShowRuleModal(false)} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-xl">
                                <i className="fa-solid fa-xmark text-lg"></i>
                            </button>
                        </div>
                        <form {...fe.form(handleSaveRule)} className="p-8 space-y-6">
                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('rule.name')}</label>
                                <input
                                    data-field="rule_name" aria-invalid={fe.invalid('rule_name')} aria-describedby={fe.describedBy('rule_name')}
                                    required
                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm placeholder:text-gray-300"
                                    value={ruleForm.name}
                                    onChange={e => setRuleForm({ ...ruleForm, name: e.target.value })}
                                    placeholder="Ej: Familias juntas"
                                />
                                <FieldError message={fe.error('rule_name')} id={fe.errorId('rule_name')} />
                            </div>

                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Tipo de regla</label>
                                <Select
                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                    value={ruleForm.type}
                                    onChange={e => setRuleForm({ ...ruleForm, type: e.target.value as any })}
                                >
                                    {RULE_TYPES.map(rt => <option key={rt.v} value={rt.v}>{rt.label}</option>)}
                                </Select>
                                <p className="text-[10px] text-gray-400 italic px-1">{ruleTypeMeta(ruleForm.type as string).desc}</p>
                            </div>

                            {/* Type-specific configuration */}
                            {ruleForm.type === 'keep_together' && (
                                <>
                                    {fieldSelect}
                                    <div className="space-y-1.5">
                                        <label htmlFor="rule-min-size" className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Tamaño mínimo del grupo</label>
                                        <input data-field="rule_min_size" aria-invalid={fe.invalid('rule_min_size')} aria-describedby={fe.describedBy('rule_min_size')} id="rule-min-size" type="number" min="1" step="1" placeholder="1" className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                            value={rParams.min_size ?? ''} onChange={e => setRParam({ min_size: numOrEmpty(e.target.value) })} />
                                        <p className="text-[10px] text-gray-400 italic px-1">Solo se mantienen juntos los grupos de este tamaño o más (p. ej. 3 → una pareja de 2 puede separarse). Vacío = 1 (todos los grupos).</p>
                                        <FieldError message={fe.error('rule_min_size')} id={fe.errorId('rule_min_size')} />
                                    </div>
                                    <PredicateEditor fields={fields} label="Solo aplica si (opcional)" value={rParams.when} onChange={(v: any) => setRParam({ when: v })} />
                                </>
                            )}

                            {(ruleForm.type === 'separate_by' || ruleForm.type === 'split_by') && fieldSelect}

                            {ruleForm.type === 'require_companion' && (
                                <>
                                    <PredicateEditor fields={fields} label="Si en la habitación hay alguien que cumple" value={rParams.subject} onChange={(v: any) => setRParam({ subject: v })} />
                                    <div className="space-y-1.5">
                                        <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Debe haber al menos</label>
                                        <input data-field="rule_companions" aria-invalid={fe.invalid('rule_companions')} aria-describedby={fe.describedBy('rule_companions')} type="number" min="1" step="1" placeholder="1" aria-label="Debe haber al menos" className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                            value={rParams.min ?? ''} onChange={e => setRParam({ min: numOrEmpty(e.target.value) })} />
                                        <FieldError message={fe.error('rule_companions')} id={fe.errorId('rule_companions')} />
                                    </div>
                                    <PredicateEditor fields={fields} label="…que cumplan" value={rParams.needs} onChange={(v: any) => setRParam({ needs: v })} />
                                </>
                            )}

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1.5">
                                    <label htmlFor="rule-priority" className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('rule.priority') || 'Prioridad (1 a 100)'}</label>
                                    <input id="rule-priority" data-field="rule_priority" type="number" min="1" max="100" step="1" className={`w-full border-2 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white transition-all outline-none text-gray-900 font-medium text-sm ${priorityClash ? 'border-rose-300 focus:border-rose-500' : 'border-gray-100 focus:border-indigo-500'}`}
                                        aria-invalid={!!priorityClash || fe.invalid('rule_priority')} aria-describedby={['rule-priority-help', fe.describedBy('rule_priority')].filter(Boolean).join(' ')}
                                        value={(ruleForm.priority as any) ?? ''} onChange={e => setRuleForm({ ...ruleForm, priority: numOrEmpty(e.target.value) as any })} />
                                    {priorityClash && <p className="text-[11px] font-bold text-rose-600 px-1" role="alert" data-priority-clash="">{tx('rules.priority.taken', 'Ya la usa la regla «{name}»: elige otro número.', { name: priorityClash.name })}</p>}
                                    <FieldError message={fe.error('rule_priority')} id={fe.errorId('rule_priority')} />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">Cumplimiento</label>
                                    <Select className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-indigo-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                        value={ruleForm.hard ? '1' : '0'} onChange={e => setRuleForm({ ...ruleForm, hard: e.target.value === '1' ? 1 : 0 })}>
                                        <option value="0">Preferente</option>
                                        <option value="1">Obligatoria</option>
                                    </Select>
                                </div>
                            </div>
                            <p id="rule-priority-help" className="text-[11px] text-gray-500 px-1">{tx('rules.priority.help', 'Prioridad: el número MÁS ALTO se aplica primero (una regla de 90 manda sobre una de 10) y dos reglas no pueden tener el mismo número. «Obligatoria» nunca se incumple; «preferente» se intenta y, si no se logra, se reporta.')}</p>

                            <div className="flex justify-end gap-3 pt-6 border-t border-gray-50">
                                <button type="button" onClick={() => setShowRuleModal(false)} className="px-6 py-3 text-[10px] font-black uppercase tracking-widest text-gray-500 hover:bg-gray-100 rounded-xl transition-all">{t('cancel')}</button>
                                <button type="submit" disabled={!!priorityClash} className="px-8 py-3 bg-indigo-600 text-white text-[10px] font-black uppercase tracking-widest rounded-xl shadow-lg shadow-indigo-200 hover:bg-indigo-700 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed">{t('save')}</button>
                            </div>
                        </form>
                    </div>
                </Overlay>
            )}
        </div>
    );
}

// Main Export
export default function ConferenceManagerAdmin() {
    return (
        <PermsProvider>
            <PermsGate />
        </PermsProvider>
    );
}


// Locations Page Component
function LocationsPage({ conferenceId, onOpenExplorer }: { conferenceId: number; onOpenExplorer?: (focus: { locationId: number }) => void }) {
    const { t } = useI18n();
    const tx = useTx();
    const { addToast } = useToast();
    // Localidades › gestionar = create / delete, coordinators' codes (rotate), seats, forms of payment,
    // the lodging dates (general and each location's own), and the lodging review (validate / return / reopen).
    // «ver» reads all of it (the review included) and can still copy a code or the portal link.
    const locPerms = usePerms();
    const canManage = locPerms.can('locations', 'manage');
    // «Sugerir reparto»: which rooms / beds to give each location (Hospedaje › gestionar, like on Alojamiento).
    const canPlan = locPerms.can('lodging', 'manage');
    const [planHotels, setPlanHotels] = useState<Hotel[] | null>(null);
    const [planLoading, setPlanLoading] = useState(false);
    const canDeadline = canManage || locPerms.can('settings', 'manage');
    // Hospedaje › gestionar adjusts a submitted / validated arrangement directly (2.17.0), in «Asignación».
    const canAdjust = locPerms.can('lodging', 'manage') && !!onOpenExplorer;
    const { conferences } = useConference();
    const currentConference = conferences.find(c => c.id === conferenceId);

    const [locations, setLocations] = useState<Location[]>([]);
    const [conference, setConference] = useState<Conference | null>(null);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [newLocation, setNewLocation] = useState({ name: '', responsible_name: '', responsible_phone: '', capacity: '', payment_methods: [...PAYMENT_METHODS] as string[] });
    const [savingMethods, setSavingMethods] = useState<number | null>(null);
    // The general lodging dates (2.21.0): the two inputs mirror the conference's opening / closing until saved.
    const [datesInput, setDatesInput] = useState({ opens: '', closes: '' });
    const [savingDates, setSavingDates] = useState(false);
    // A location's own dates: the card whose editor is open (each date: the general one, its own, or none) and
    // the one saving.
    const [ownEdit, setOwnEdit] = useState<{ id: number; opensMode: 'general' | 'date' | 'none'; opens: string; closesMode: 'general' | 'date' | 'none'; closes: string } | null>(null);
    const [savingOwn, setSavingOwn] = useState<number | null>(null);
    // Inline capacity editor on a card: which location and the value being typed.
    const [capacityEdit, setCapacityEdit] = useState<{ id: number; value: string } | null>(null);
    const [savingCapacity, setSavingCapacity] = useState(false);
    // "Revisar hospedaje" modal: the location being reviewed, the GET /locations/:id/lodging payload,
    // the observations typed for a return, and the action in flight.
    const [reviewLoc, setReviewLoc] = useState<Location | null>(null);
    const [review, setReview] = useState<LodgingReview | null>(null);
    const [reviewLoading, setReviewLoading] = useState(false);
    const [returnNote, setReturnNote] = useState('');
    const [showReturnForm, setShowReturnForm] = useState(false);
    const [reviewBusy, setReviewBusy] = useState(false);

    const openPlan = async () => {
        setPlanLoading(true);
        try {
            const list = await conferenceApi.getHotels(conferenceId);
            if (!list.length) addToast(tx('plan.nohotels', 'Primero agrega hoteles y habitaciones en Alojamiento.'), 'info');
            else setPlanHotels(list);
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        } finally {
            setPlanLoading(false);
        }
    };

    const loadLocations = async () => {
        setLoading(true);
        try {
            const data = await conferenceApi.getLocations(conferenceId);
            setLocations(data.locations);
            setConference(data.conference);
            setDatesInput({ opens: String(data.conference?.lodging_opens || '').slice(0, 10), closes: String(data.conference?.lodging_deadline || '').slice(0, 10) });
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadLocations();
    }, [conferenceId]);

    // In-page confirm that renders ABOVE this page's own z-[100] modals (the review modal awaits it for
    // Validar / Reabrir) — the shared useModal dialog is z-50 and would sit BEHIND the review modal, so
    // its buttons could never be clicked and the promise would never resolve. Same
    // (message, label, danger) signature as useModal's confirm; the promise resolves to the choice.
    const [confirmState, setConfirmState] = useState<{ message: string; label: string; danger: boolean; resolve: (v: boolean) => void } | null>(null);
    const confirm = (message: string, label = 'Confirmar', danger = false) =>
        new Promise<boolean>(resolve => setConfirmState({ message, label, danger, resolve }));

    const canCreate = !!newLocation.name.trim() && /^\d+$/.test(newLocation.capacity.trim()) && Number(newLocation.capacity) > 0;
    const handleCreate = async () => {
        if (!canCreate) return;
        try {
            await conferenceApi.createLocation(conferenceId, { ...newLocation, capacity: Number(newLocation.capacity) });
            setShowModal(false);
            setNewLocation({ name: '', responsible_name: '', responsible_phone: '', capacity: '', payment_methods: [...PAYMENT_METHODS] });
            loadLocations();
            addToast(t('location.created'), 'success');
        } catch (error: any) {
            addToast(error.message || 'Error', 'error');
        }
    };

    const handleDelete = async (id: number) => {
        if (!await confirm(t('confirm.delete.location'), t('delete.location') || "Delete Location", true)) return;
        try {
            await conferenceApi.deleteLocation(id);
            loadLocations();
            addToast(t('location.deleted') || 'Localidad eliminada', 'success');
        } catch (error: any) {
            addToast(error.message, 'error');
        }
    };

    // Clipboard access throws on non-secure origins (LAN-IP HTTP deployments this repo has hit).
    // Feature-check + fall back to a hidden-textarea copy; only report success when it worked.
    const copyToClipboard = async (text: string): Promise<boolean> => {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            }
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch {
            return false;
        }
    };

    const handleCopyLink = async () => {
        if (!currentConference?.slug) return;
        if (!conference?.is_form_published) {
            addToast('El formulario no está publicado. El enlace no funcionará para el público.', 'warning');
        }
        const fullUrl = `${window.location.protocol}//${window.location.host}/portal/conference?slug=${currentConference.slug}`;
        if (await copyToClipboard(fullUrl)) addToast('Enlace copiado al portapapeles', 'success');
        else addToast(fullUrl, 'info'); // fallback: show the link so it can be copied manually
    };

    const isPublished = !!conference?.is_form_published;

    // 'YYYY-MM-DD' → 'DD/MM/YYYY' (a datetime keeps its clock); anything else verbatim.
    const fmtDeadline = (v: unknown): string => {
        const m = String(v ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
        return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}` : String(v ?? '');
    };
    // The zone the bare dates are judged in: this browser's (the server stores it with the dates).
    const browserZone = (): { lodging_tz?: string } => {
        try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; return tz ? { lodging_tz: tz } : {}; } catch { return {}; }
    };
    const saveDates = async () => {
        setSavingDates(true);
        try {
            await conferenceApi.updateConference(conferenceId, { lodging_opens: datesInput.opens || null, lodging_deadline: datesInput.closes || null, ...browserZone() } as any);
            addToast(t('lodging.dates.saved') || 'Fechas guardadas', 'success');
            loadLocations();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        } finally {
            setSavingDates(false);
        }
    };

    // A location's own dates (null = the general one); both null = back to the general dates.
    const saveOwnDates = async (loc: Location, opens: string | null, closes: string | null) => {
        setSavingOwn(loc.id);
        try {
            await conferenceApi.updateLocation(loc.id, { lodging_opens: opens, lodging_closes: closes, ...browserZone() });
            addToast(opens || closes ? (t('lodging.dates.own.saved') || 'Fechas de la localidad guardadas') : (t('lodging.dates.own.cleared') || 'La localidad usa las fechas generales'), 'success');
            setOwnEdit(null);
            loadLocations();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        } finally {
            setSavingOwn(null);
        }
    };

    const [copiedId, setCopiedId] = useState<number | null>(null);

    const handleCopyCode = async (code: string, id: number) => {
        if (await copyToClipboard(code)) {
            setCopiedId(id);
            setTimeout(() => setCopiedId(null), 2000);
        } else {
            addToast(`${t('code') || 'Código'}: ${code}`, 'info');
        }
    };

    // Enable or disable one form of payment for a location (the server stores the whole enabled set).
    const handleToggleMethod = async (loc: Location, method: string) => {
        const current = Array.isArray(loc.payment_methods) ? loc.payment_methods : [...PAYMENT_METHODS];
        const next = current.includes(method) ? current.filter(m => m !== method) : [...current, method];
        setSavingMethods(loc.id);
        try {
            await conferenceApi.updateLocation(loc.id, { payment_methods: next });
            addToast(t('payment.methods.updated') || 'Formas de pago actualizadas', 'success');
            loadLocations();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        } finally {
            setSavingMethods(null);
        }
    };

    // Raise or lower the cap; the server refuses a value below the seats already taken (409 with the count).
    const handleSaveCapacity = async (loc: Location) => {
        if (!capacityEdit || capacityEdit.id !== loc.id) return;
        const v = capacityEdit.value.trim();
        if (!/^\d+$/.test(v) || Number(v) < 1) { addToast(t('location.capacity.help'), 'warning'); return; }
        setSavingCapacity(true);
        try {
            await conferenceApi.updateLocation(loc.id, { capacity: Number(v) });
            addToast(t('capacity.updated') || 'Cupo actualizado', 'success');
            setCapacityEdit(null);
            loadLocations();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        } finally {
            setSavingCapacity(false);
        }
    };

    const handleRotateCode = async (loc: Location) => {
        if (!await confirm(t('confirm.rotate.code') || '¿Generar un código nuevo? El código actual dejará de funcionar.', t('rotate.code') || 'Rotar código', false)) return;
        try {
            await conferenceApi.updateLocation(loc.id, { rotate_code: true });
            addToast(t('code.rotated') || 'Código actualizado', 'success');
            loadLocations();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        }
    };

    // --- Lodging review (the admin only validates the coordinator's arrangement) ---------------
    const loadReview = async (id: number) => {
        setReviewLoading(true);
        try {
            setReview(await conferenceApi.getLocationLodging(id));
        } catch (error: any) {
            addToast(error?.message || t('lodging.error.loading') || 'Error al cargar el hospedaje', 'error');
        } finally {
            setReviewLoading(false);
        }
    };

    const openReview = (loc: Location) => {
        setReviewLoc(loc);
        setReview(null);
        setReturnNote('');
        setShowReturnForm(false);
        loadReview(loc.id);
    };

    const closeReview = () => {
        setReviewLoc(null);
        setReview(null);
        setShowReturnForm(false);
    };

    // Each transition is a compare-and-set on the server (409 when the status moved meanwhile); after
    // any of them the modal reloads its payload and the cards refresh their status/counters. «Validar» and
    // «Devolver» also send what the admin is looking at (reviewSeen, 2.17.0): when the arrangement changed
    // since (an administration adjustment by someone else, or a new submission), the server answers 409
    // `lodging_changed` and the modal reloads, so the admin decides on what is there now.
    const reviewRefused = async (error: any) => {
        if (error && error.code === 'lodging_changed' && reviewLoc) {
            addToast(tx('lodging.review.changed', 'El hospedaje cambió mientras lo revisabas: ya ves la versión actual. Revísalo antes de validarlo o devolverlo.'), 'warning');
            await loadReview(reviewLoc.id);
            loadLocations();
            return;
        }
        addToast(error?.message || 'Error', 'error');
    };
    const handleValidate = async () => {
        if (!reviewLoc) return;
        if (!await confirm(t('lodging.confirm.validate') || '¿Validar el hospedaje de esta localidad? El encargado no podrá modificarlo hasta que lo reabras.', t('lodging.validate') || 'Validar', false)) return;
        setReviewBusy(true);
        try {
            await conferenceApi.validateLodging(reviewLoc.id, reviewSeen(review));
            addToast(t('lodging.validated.done') || 'Hospedaje validado', 'success');
            await loadReview(reviewLoc.id);
            loadLocations();
        } catch (error: any) {
            await reviewRefused(error);
        } finally {
            setReviewBusy(false);
        }
    };

    const handleReturn = async () => {
        if (!reviewLoc) return;
        const note = returnNote.trim();
        if (!note) { addToast(t('lodging.return.note.required') || 'Indica las observaciones para el encargado.', 'warning'); return; }
        setReviewBusy(true);
        try {
            await conferenceApi.returnLodging(reviewLoc.id, note, reviewSeen(review));
            addToast(t('lodging.returned.done') || 'Hospedaje devuelto al encargado', 'success');
            setShowReturnForm(false);
            setReturnNote('');
            await loadReview(reviewLoc.id);
            loadLocations();
        } catch (error: any) {
            await reviewRefused(error);
        } finally {
            setReviewBusy(false);
        }
    };

    const handleReopen = async () => {
        if (!reviewLoc) return;
        if (!await confirm(t('lodging.confirm.reopen') || '¿Reabrir el hospedaje? El encargado podrá volver a modificarlo.', t('lodging.reopen') || 'Reabrir', false)) return;
        setReviewBusy(true);
        try {
            await conferenceApi.reopenLodging(reviewLoc.id);
            addToast(t('lodging.reopened.done') || 'Hospedaje reabierto', 'success');
            await loadReview(reviewLoc.id);
            loadLocations();
        } catch (error: any) {
            addToast(error?.message || 'Error', 'error');
        } finally {
            setReviewBusy(false);
        }
    };

    // The server stamps CURRENT_TIMESTAMP: SQLite returns `YYYY-MM-DD HH:MM:SS` in UTC with no zone
    // marker (Chrome would read it as local time, Safari as an invalid date) — parse that form as UTC.
    const fmtDate = (v?: string | null) => {
        if (!v) return '';
        const s = String(v).trim();
        const sql = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/.exec(s);
        const d = new Date(sql ? `${sql[1]}T${sql[2]}Z` : s);
        return isNaN(d.getTime()) ? s : d.toLocaleString();
    };
    // The form's name fields (role first_name / last_name); without them, the first filled form fields
    // (2.16.0: the form may have no name field at all), then the attendee's number.
    const occupantName = (p: any) => `${p.first_name || ''} ${p.last_name || ''}`.trim() || personDisplayName(p, review?.fields || []);

    return (
        <div className="space-y-10 animate-in fade-in duration-500">
            <ReadOnlyNotice section="locations" alsoManage={['settings']} />
            {/* Premium Public Link Card */}
            <div className={`group relative overflow-hidden rounded-[40px] p-10 max-sm:p-6 border-2 transition-all duration-500 shadow-2xl ${isPublished
                ? 'bg-emerald-50/50 border-emerald-100 shadow-emerald-100/30'
                : 'bg-white border-gray-100 shadow-gray-100/50'
                }`}>
                <div aria-hidden="true" className={DECO_LAYER_CLASS} data-cm-deco="">
                    <div className={`absolute -right-20 -top-20 w-80 h-80 rounded-full blur-[100px] opacity-30 transition-all duration-1000 group-hover:scale-125 ${isPublished ? 'bg-emerald-400' : 'bg-orange-400'
                        }`}></div>
                    <div className={`absolute -left-20 -bottom-20 w-64 h-64 rounded-full blur-[100px] opacity-20 ${isPublished ? 'bg-teal-300' : 'bg-amber-100'
                        }`}></div>
                </div>

                <div className="relative flex flex-wrap items-center justify-between gap-10 max-sm:gap-6">
                    <div className="min-w-0" style={{ flex: '1 1 18rem' }}>
                        <div className={HERO_HEAD_CLASS} data-cm-hero-head="">
                            <div className={`w-14 h-14 shrink-0 rounded-2xl flex items-center justify-center text-2xl shadow-xl transition-transform duration-500 group-hover:scale-110 ${isPublished ? 'bg-emerald-500 text-white shadow-emerald-200' : 'bg-orange-500 text-white shadow-orange-200/50'
                                }`}>
                                <i className={`fa-solid ${isPublished ? 'fa-link' : 'fa-link-slash'}`}></i>
                            </div>
                            <div className="min-w-0">
                                <h3 className={`font-black text-3xl italic tracking-tighter ${isPublished ? 'text-emerald-900' : 'text-gray-900'}`}>
                                    {t('public.portal.link') || 'Link del Portal Público'}
                                </h3>
                                {isPublished ? (
                                    <div className="flex items-center gap-2 mt-1">
                                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                                        <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest">Activo</span>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 mt-1">
                                        <div className="w-2 h-2 rounded-full bg-orange-400"></div>
                                        <span className="text-[10px] font-black text-orange-600 uppercase tracking-widest">Borrador</span>
                                    </div>
                                )}
                            </div>
                        </div>
                        <p className={`text-base font-medium leading-relaxed max-w-xl ${isPublished ? 'text-emerald-800/70' : 'text-gray-500'}`}>
                            {isPublished
                                ? 'El portal está listo para recibir inscripciones. Comparte este enlace exclusivo con tus coordinadores y responsables de cada zona para iniciar el proceso.'
                                : 'Tu portal aún está en modo borrador. El enlace no funcionará correctamente hasta que publiques el formulario desde la pestaña de campos.'}
                        </p>
                        <p className={`text-xs font-medium leading-relaxed max-w-xl mt-3 ${isPublished ? 'text-emerald-800/60' : 'text-gray-400'}`}>
                            <i className="fa-solid fa-bed mr-1.5"></i>
                            {t('portal.publish.hint') || 'Los encargados necesitan el formulario publicado para entrar al portal (inscripciones y hospedaje).'}
                        </p>
                    </div>
                    <button
                        onClick={handleCopyLink}
                        className={`px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest transition-all duration-500 flex items-center gap-3 shadow-xl transform active:scale-95 ${isPublished
                            ? 'bg-white text-emerald-600 hover:bg-emerald-50 border-2 border-emerald-100 shadow-emerald-100/50'
                            : 'bg-white text-orange-600 hover:bg-orange-50 border-2 border-orange-100 shadow-orange-100/50'
                            }`}
                    >
                        <i className="fa-solid fa-copy text-[8px]"></i> Copiar Enlace
                    </button>
                </div>
            </div>

            {/* Lodging dates (2.21.0): from when and until when the coordinators may arrange from the portal —
                the general ones; a location may have its own (on its card). */}
            {(() => {
                const curOpens = String(conference?.lodging_opens || '').slice(0, 10);
                const curCloses = String(conference?.lodging_deadline || '').slice(0, 10);
                const win = conference?.lodging_window;
                const state = !curOpens && !curCloses ? 'none' : win?.passed ? 'passed' : win?.not_yet ? 'notyet' : 'open';
                const dirty = datesInput.opens !== curOpens || datesInput.closes !== curCloses;
                const invalid = !!(datesInput.opens && datesInput.closes && datesInput.opens > datesInput.closes);
                const ownCount = locations.filter(l => l.lodging_opens || l.lodging_closes).length;
                const tone = state === 'passed' ? 'rose' : state === 'notyet' ? 'amber' : state === 'open' ? 'blue' : 'gray';
                const boxCls: Record<string, string> = { rose: 'bg-rose-50/60 border-rose-100', amber: 'bg-amber-50/60 border-amber-100', blue: 'bg-blue-50/40 border-blue-100', gray: 'bg-gray-50/50 border-white' };
                const iconCls: Record<string, string> = { rose: 'bg-rose-100 text-rose-600', amber: 'bg-amber-100 text-amber-600', blue: 'bg-blue-100 text-blue-600', gray: 'bg-blue-100 text-blue-600' };
                const textCls: Record<string, string> = { rose: 'text-rose-700', amber: 'text-amber-800', blue: 'text-blue-700', gray: 'text-gray-500' };
                const line = state === 'none'
                    ? (t('lodging.dates.none') || 'Sin fechas: los encargados pueden acomodar en cualquier momento.')
                    : state === 'passed'
                        ? (t('lodging.dates.state.passed') || 'Plazo vencido el {date}: solo el administrador puede modificar los hospedajes.').replace('{date}', fmtDeadline(curCloses))
                        : state === 'notyet'
                            ? (t('lodging.dates.state.notyet') || 'Se habilita el {date}: hasta entonces solo el administrador puede acomodar.').replace('{date}', fmtDeadline(curOpens))
                                + (curCloses ? ' ' + (t('lodging.dates.state.closes') || 'Cierra el {date} (inclusive).').replace('{date}', fmtDeadline(curCloses)) : '')
                            : curCloses
                                ? (t('lodging.dates.state.open') || 'Abierto: los encargados pueden acomodar hasta el {date} (inclusive).').replace('{date}', fmtDeadline(curCloses))
                                : (t('lodging.dates.state.open.nolimit') || 'Abierto: los encargados pueden acomodar, sin fecha de cierre.');
                const dateField = (which: 'opens' | 'closes', label: string) => (
                    <div className="space-y-1">
                        <label htmlFor={`lodging-${which}`} className="block text-[9px] font-bold text-gray-500 uppercase tracking-widest ml-1">{label}</label>
                        <div className="flex items-center gap-1">
                            <div className="min-w-[10rem]">
                                <DateField id={`lodging-${which}`} value={datesInput[which]} clearable={false} disabled={!canDeadline}
                                    max={which === 'opens' ? (datesInput.closes || undefined) : undefined}
                                    min={which === 'closes' ? (datesInput.opens || undefined) : undefined}
                                    onChange={v => setDatesInput(d => ({ ...d, [which]: v }))} />
                            </div>
                            {canDeadline && datesInput[which] && (
                                <button type="button" onClick={() => setDatesInput(d => ({ ...d, [which]: '' }))}
                                    aria-label={`${t('lodging.dates.clear') || 'Quitar'} · ${label}`} title={t('lodging.dates.clear') || 'Quitar'}
                                    className="w-9 h-9 shrink-0 rounded-xl text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition-all">
                                    <i className="fa-solid fa-xmark"></i>
                                </button>
                            )}
                        </div>
                    </div>
                );
                return (
                    <div className={`flex flex-col gap-5 lg:flex-row lg:items-center justify-between p-8 rounded-[32px] border-2 shadow-sm ${boxCls[tone]}`} data-testid="lodging-dates">
                        <div className="flex items-start gap-4 flex-1">
                            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-lg shadow-inner shrink-0 ${iconCls[tone]}`}>
                                <i className={`fa-solid ${state === 'passed' ? 'fa-lock' : state === 'notyet' ? 'fa-hourglass-half' : 'fa-calendar-check'}`}></i>
                            </div>
                            <div>
                                <h3 className="text-xl font-black text-gray-900 italic tracking-tighter">{t('lodging.dates') || 'Fechas para acomodar hospedajes'}</h3>
                                <p className={`text-xs font-bold mt-1 ${textCls[tone]}`} data-testid="lodging-dates-state">{line}</p>
                                <p className="text-[11px] text-gray-400 mt-1 leading-relaxed max-w-xl">
                                    {t('lodging.dates.help') || 'Valen para todas las localidades: desde la apertura y hasta el cierre (los dos días completos) los encargados acomodan y envían sus hospedajes desde el portal; antes y después, solo el administrador puede modificarlos. Una localidad puede tener fechas propias en su tarjeta.'}
                                    {(curOpens || curCloses) && <> {(t('lodging.dates.zone') || 'Hora de {tz}.').replace('{tz}', conference?.lodging_tz || 'UTC')}</>}
                                </p>
                                {ownCount > 0 && (
                                    <p className="text-[11px] font-bold text-violet-700 mt-1">
                                        <i className="fa-solid fa-calendar-day mr-1"></i>
                                        {(ownCount === 1 ? (t('lodging.dates.own.count.one') || '1 localidad con fechas propias') : (t('lodging.dates.own.count') || '{n} localidades con fechas propias')).replace('{n}', String(ownCount))}
                                    </p>
                                )}
                            </div>
                        </div>
                        <div className="flex flex-col gap-2">
                            <div className="flex flex-wrap items-end gap-3">
                                {dateField('opens', t('lodging.dates.opens') || 'Apertura')}
                                {dateField('closes', t('lodging.dates.closes') || 'Cierre')}
                                {canDeadline && <button
                                    type="button"
                                    onClick={saveDates}
                                    disabled={savingDates || !dirty || invalid}
                                    className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                                >
                                    {t('save') || 'Guardar'}
                                </button>}
                            </div>
                            {invalid && <p className="text-[11px] font-bold text-rose-600" role="alert">{t('lodging.dates.invalid') || 'La apertura no puede ser posterior al cierre.'}</p>}
                        </div>
                    </div>
                );
            })()}

            <div className="flex flex-wrap items-center justify-between gap-4 bg-gray-50/50 p-5 sm:p-8 rounded-[32px] border-2 border-white shadow-sm">
                <div className="min-w-0">
                    <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter">{t('locations')}</h2>
                    <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1">Sedes regionales y grupos locales</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                {canPlan && <button
                    type="button"
                    onClick={openPlan}
                    disabled={planLoading}
                    className="bg-white border-2 border-gray-100 text-blue-700 px-6 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:border-blue-500 transition-all flex items-center gap-2 disabled:opacity-50"
                    data-plan-open="locations"
                >
                    <i className={`fa-solid ${planLoading ? 'fa-spinner animate-spin' : 'fa-wand-magic-sparkles'} text-[10px]`}></i> {tx('plan.open', 'Sugerir reparto')}
                </button>}
                {canManage && <button
                    onClick={() => setShowModal(true)}
                    className="bg-gray-900 text-white px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-blue-600 transition-all duration-500 shadow-xl hover:shadow-blue-500/30 flex items-center gap-3 transform active:scale-95 translate-y-0 hover:-translate-y-1"
                >
                    <i className="fa-solid fa-plus text-[8px]"></i> {t('new.location')}
                </button>}
                </div>
            </div>
            {planHotels && <LodgingPlan conferenceId={conferenceId} hotels={planHotels} onClose={() => setPlanHotels(null)} onApplied={() => loadLocations()} />}

            {loading ? (
                <div className="flex-1 flex flex-col justify-center items-center py-20 bg-white rounded-3xl border border-gray-100">
                    <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                    <p className="text-gray-400 mt-4 text-xs font-bold uppercase tracking-widest">{t('loading')}</p>
                </div>
            ) : locations.length === 0 ? (
                <div className="flex-1 flex flex-col justify-center items-center py-20 bg-gray-50/50 border-2 border-dashed border-gray-100 rounded-3xl">
                    <div className="w-20 h-20 shrink-0 bg-white rounded-3xl shadow-sm flex items-center justify-center text-gray-200 text-3xl mb-4">
                        <i className="fa-solid fa-map-location-dot"></i>
                    </div>
                    <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t('no.locations.list')}</p>
                    <p className="text-[10px] text-gray-400 mt-2">Crea tu primera localidad para empezar a recibir inscripciones regionales.</p>
                </div>
            ) : (
                <div className="flex-1">
                    {/* Same as the conference list: columns from the available width, so a card never drops
                        under ~20rem and its chips (formas de pago, hospedaje, fechas) stay inside it. */}
                    <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 20rem), 1fr))' }}>
                        {locations.map(loc => (
                            <div key={loc.id} className="group bg-white p-8 rounded-[32px] border-2 border-gray-50 shadow-sm hover:border-blue-500 hover:shadow-2xl hover:-translate-y-2 transition-all duration-500 relative overflow-hidden">
                                <div aria-hidden="true" className={DECO_LAYER_CLASS} data-cm-deco="">
                                    <div className="absolute -right-10 -bottom-10 w-32 h-32 bg-blue-600 opacity-[0.03] rounded-full group-hover:scale-150 transition-transform duration-700"></div>
                                    <div className="absolute -left-10 -top-10 w-24 h-24 bg-indigo-600 opacity-[0.02] rounded-full group-hover:scale-150 transition-transform duration-700"></div>
                                </div>

                                <div className="flex justify-between items-start mb-8 relative z-10">
                                    <div className="flex items-center gap-4">
                                        <div className="w-14 h-14 shrink-0 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 text-blue-600 flex items-center justify-center text-xl shadow-inner group-hover:scale-110 transition-transform duration-500">
                                            <i className="fa-solid fa-map-location-dot"></i>
                                        </div>
                                        <div>
                                            <h3 className="text-2xl font-black text-gray-900 italic tracking-tighter leading-tight">{loc.name}</h3>
                                            <div className="flex items-center gap-1.5 mt-0.5">
                                                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div>
                                                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('active') || 'Activo'}</span>
                                            </div>
                                        </div>
                                    </div>
                                    {canManage && <button
                                        onClick={() => handleDelete(loc.id)}
                                        className="w-10 h-10 shrink-0 flex items-center justify-center rounded-xl bg-gray-50 text-gray-300 hover:bg-rose-50 hover:text-rose-600 transition-all duration-300 transform opacity-100 translate-x-0 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:translate-x-4 group-hover:opacity-100 group-hover:translate-x-0 focus-visible:opacity-100 focus-visible:translate-x-0"
                                    >
                                        <i className="fa-solid fa-trash-can text-sm"></i>
                                    </button>}
                                </div>

                                <div className="space-y-6 relative z-10">
                                    <div className="p-4 bg-gray-50/50 rounded-2xl border-2 border-white shadow-inner group/code">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-3">
                                                <div className="p-2 bg-white rounded-lg shadow-sm">
                                                    <i className="fa-solid fa-fingerprint text-xs text-blue-500"></i>
                                                </div>
                                                {loc.code
                                                    ? <span className="font-mono text-sm font-black text-gray-600 tracking-tighter uppercase">{loc.code}</span>
                                                    : <span className="text-[11px] font-bold text-gray-400 italic">{tx('perm.location.code.hidden', 'Código oculto: solo lo ve quien gestiona Localidades.')}</span>}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                {loc.code && <button
                                                    onClick={() => handleCopyCode(loc.code, loc.id)}
                                                    className={`text-[10px] font-black uppercase tracking-widest px-4 py-2 rounded-xl transition-all duration-300 shadow-sm ${copiedId === loc.id ? 'bg-emerald-500 text-white' : 'bg-white text-blue-600 hover:bg-blue-600 hover:text-white'}`}
                                                >
                                                    {copiedId === loc.id ? t('copied') || '¡Copiado!' : t('copy') || 'Copiar'}
                                                </button>}
                                                {canManage && <button
                                                    onClick={() => handleRotateCode(loc)}
                                                    title={t('rotate.code') || 'Rotar código'}
                                                    className="w-9 h-9 shrink-0 flex items-center justify-center rounded-xl bg-white text-gray-400 hover:bg-amber-500 hover:text-white transition-all shadow-sm"
                                                >
                                                    <i className="fa-solid fa-rotate text-xs"></i>
                                                </button>}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 gap-3 px-1">
                                        {(() => {
                                            const inscribed = Number(loc.inscribed) || 0;
                                            const cap = loc.capacity == null ? null : Number(loc.capacity);
                                            const full = cap !== null && inscribed >= cap;
                                            const pct = cap ? Math.min(100, Math.round((inscribed / cap) * 100)) : 0;
                                            const editing = capacityEdit?.id === loc.id;
                                            return (
                                                <div className={`p-3 bg-white rounded-xl border shadow-sm transition-colors ${full ? 'border-rose-200' : 'border-gray-50 group-hover:border-blue-100'}`}>
                                                    <div className="flex items-center gap-4">
                                                        <div className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-sm ${full ? 'bg-rose-50 text-rose-500' : 'bg-emerald-50 text-emerald-500'}`}>
                                                            <i className="fa-solid fa-users"></i>
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{t('location.inscribed') || 'Inscritos'} / {t('location.capacity') || 'Cupo máximo'}</div>
                                                            {editing ? (
                                                                <div className="flex items-center gap-2 mt-1">
                                                                    <input
                                                                        type="number" min={Math.max(1, inscribed)} step={1}
                                                                        value={capacityEdit!.value}
                                                                        onChange={e => setCapacityEdit({ id: loc.id, value: e.target.value })}
                                                                        onKeyDown={e => { if (e.key === 'Enter') handleSaveCapacity(loc); if (e.key === 'Escape') setCapacityEdit(null); }}
                                                                        className="w-24 border-2 border-blue-200 rounded-lg px-2 py-1 text-sm font-black text-gray-900 outline-none focus:border-blue-500"
                                                                        autoFocus
                                                                    />
                                                                    <button onClick={() => handleSaveCapacity(loc)} disabled={savingCapacity} className="text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{t('save') || 'Guardar'}</button>
                                                                    <button onClick={() => setCapacityEdit(null)} className="text-[10px] font-black uppercase tracking-widest px-2 py-1.5 rounded-lg text-gray-400 hover:bg-gray-100">{t('cancel') || 'Cancelar'}</button>
                                                                </div>
                                                            ) : (
                                                                <div className="flex items-center gap-2">
                                                                    <span className={`text-xs font-black ${full ? 'text-rose-600' : 'text-gray-700'}`}>{inscribed} / {cap === null ? (t('location.unlimited') || 'Sin límite') : cap}</span>
                                                                    {full && <span className="text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-md bg-rose-50 text-rose-600">{t('location.full') || 'Cupo lleno'}</span>}
                                                                </div>
                                                            )}
                                                        </div>
                                                        {!editing && canManage && (
                                                            <button
                                                                onClick={() => setCapacityEdit({ id: loc.id, value: cap === null ? String(Math.max(1, inscribed)) : String(cap) })}
                                                                title={t('edit.capacity') || 'Editar cupo'}
                                                                className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white transition-all shadow-sm"
                                                            >
                                                                <i className="fa-solid fa-pen text-xs"></i>
                                                            </button>
                                                        )}
                                                    </div>
                                                    {cap !== null && (
                                                        <div className="mt-2 h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
                                                            <div className={`h-full rounded-full transition-all ${full ? 'bg-rose-500' : pct >= 80 ? 'bg-amber-400' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }}></div>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })()}
                                        <div className="p-3 bg-white rounded-xl border border-gray-50 shadow-sm group-hover:border-blue-100 transition-colors">
                                            <div className="flex items-center gap-4">
                                                <div className="w-8 h-8 shrink-0 rounded-lg bg-amber-50 text-amber-500 flex items-center justify-center text-sm">
                                                    <i className="fa-solid fa-money-bill-wave"></i>
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{t('payment.methods') || 'Formas de pago'}</div>
                                                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                                                        {PAYMENT_METHODS.map(m => {
                                                            const on = Array.isArray(loc.payment_methods) ? loc.payment_methods.includes(m) : true;
                                                            return (
                                                                <button
                                                                    key={m}
                                                                    type="button"
                                                                    onClick={() => handleToggleMethod(loc, m)}
                                                                    disabled={savingMethods === loc.id || !canManage}
                                                                    title={!canManage ? tx('perm.readonly.short', 'Solo lectura') : on ? (t('payment.method.disable') || 'Deshabilitar') : (t('payment.method.enable') || 'Habilitar')}
                                                                    className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-lg border transition-all disabled:opacity-50 ${on ? 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100' : 'bg-gray-50 border-gray-200 text-gray-400 line-through hover:bg-gray-100'}`}
                                                                >
                                                                    <i className={`fa-solid ${on ? 'fa-check' : 'fa-ban'} mr-1`}></i>{paymentMethodLabel(tx, m)}
                                                                </button>
                                                            );
                                                        })}
                                                        {Array.isArray(loc.payment_methods) && loc.payment_methods.length === 0 && (
                                                            <span className="text-[10px] font-bold text-rose-500 uppercase tracking-widest">{t('payment.methods.none') || 'Ninguna habilitada'}</span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                        {(() => {
                                            const meta = lodgingStatusMeta(loc.lodging_status);
                                            const unlodged = Number(loc.unlodged) || 0;
                                            return (
                                                <div className={`p-3 bg-white rounded-xl border shadow-sm transition-colors ${loc.lodging_status === 'submitted' ? 'border-amber-200' : 'border-gray-50 group-hover:border-blue-100'}`}>
                                                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-lodging-row="">
                                                        <div className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-sm ${loc.lodging_status === 'submitted' ? 'bg-amber-50 text-amber-500' : loc.lodging_status === 'validated' ? 'bg-emerald-50 text-emerald-500' : 'bg-purple-50 text-purple-400'}`}>
                                                            <i className="fa-solid fa-bed"></i>
                                                        </div>
                                                        <div className="flex-1 min-w-[10rem]">
                                                            <div className="flex items-center gap-2 flex-wrap">
                                                                <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{t('lodging.block') || 'Hospedaje'}</div>
                                                                <span className={`px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest ${meta.cls}`}>
                                                                    <i className={`fa-solid ${meta.icon} mr-1`}></i>{t(meta.key) || meta.fallback}
                                                                </span>
                                                            </div>
                                                            {/* The counts wrap between items only; no «·» is left alone at a line's start or end. */}
                                                            <DotList className="text-[11px] font-bold text-gray-600 mt-1" data-lodging-counts="" items={[
                                                                `${Number(loc.rooms_allotted) || 0} ${t('lodging.rooms.short') || 'hab.'}`,
                                                                `${Number(loc.beds_allotted) || 0} ${t('lodging.beds.short') || 'camas'}`,
                                                                `${Number(loc.lodged) || 0} ${t('lodging.lodged.short') || 'alojados'}`,
                                                                <span className={unlodged > 0 ? 'text-amber-600' : ''}>{unlodged} {t('lodging.unlodged.short') || 'sin habitación'}</span>,
                                                            ]} />
                                                        </div>
                                                        <button
                                                            onClick={() => openReview(loc)}
                                                            title={t('lodging.review') || 'Revisar hospedaje'}
                                                            className={`shrink-0 ml-auto text-[10px] font-black uppercase tracking-widest px-3 py-2 rounded-xl transition-all shadow-sm ${loc.lodging_status === 'submitted' ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-white text-purple-600 hover:bg-purple-600 hover:text-white'}`}
                                                        >
                                                            <i className="fa-solid fa-clipboard-check mr-1"></i>{t('lodging.review') || 'Revisar hospedaje'}
                                                        </button>
                                                    </div>
                                                    {/* Full card width, never inside the row's squeezed middle column; the two-line
                                                        form, the whole sentence in its tooltip (2.17.0). */}
                                                    <AdjustStamp location={loc} tx={tx} compact className="mt-2" />
                                                </div>
                                            );
                                        })()}
                                        {(conference?.lodging_opens || conference?.lodging_deadline || loc.lodging_opens || loc.lodging_closes) && (() => {
                                            // Its lodging dates (2.21.0): the general ones, or its own (the 2.8.0
                                            // «permiso fuera de plazo» became an own closing).
                                            const w = loc.lodging_window;
                                            const ownOpens = loc.lodging_opens || null, ownCloses = loc.lodging_closes || null;
                                            const own = !!(ownOpens || ownCloses);
                                            const genOpens = String(conference?.lodging_opens || '').slice(0, 10);
                                            const genCloses = String(conference?.lodging_deadline || '').slice(0, 10);
                                            const state = w?.passed ? 'passed' : w?.not_yet ? 'notyet' : 'open';
                                            const editing = ownEdit?.id === loc.id;
                                            const label = state === 'passed'
                                                ? (t('lodging.dates.chip.passed') || 'Cerrado: venció el {date}').replace('{date}', fmtDeadline(w?.closes))
                                                : state === 'notyet'
                                                    ? (t('lodging.dates.chip.notyet') || 'Se habilita el {date}').replace('{date}', fmtDeadline(w?.opens))
                                                    : w?.closes
                                                        ? (t('lodging.dates.chip.until') || 'Abierto hasta el {date}').replace('{date}', fmtDeadline(w.closes))
                                                        : (t('lodging.dates.chip.open') || 'Abierto');
                                            const toneCls: Record<string, string> = {
                                                open: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
                                                notyet: 'bg-amber-50 text-amber-700 border border-amber-200',
                                                passed: 'bg-rose-50 text-rose-700 border border-rose-200',
                                            };
                                            const mark = (isOwn: boolean) => isOwn ? <span className="ml-1 text-violet-700">({t('lodging.dates.own.mark') || 'propia'})</span> : null;
                                            const opensText = w?.opens ? fmtDeadline(w.opens) : (t('lodging.dates.opens.none') || 'sin esperar');
                                            const closesText = w?.closes ? fmtDeadline(w.closes) : (t('lodging.dates.closes.none') || 'sin cierre');
                                            const modeOf = (v: string | null, none: string): 'general' | 'date' | 'none' => (v == null ? 'general' : v === none ? 'none' : 'date');
                                            const dayOf = (v: string | null, none: string) => (v == null || v === none ? '' : String(v).slice(0, 10));
                                            const startEdit = () => setOwnEdit({
                                                id: loc.id,
                                                opensMode: modeOf(ownOpens, LODGING_NO_WAIT), opens: dayOf(ownOpens, LODGING_NO_WAIT),
                                                closesMode: modeOf(ownCloses, LODGING_NO_CLOSE), closes: dayOf(ownCloses, LODGING_NO_CLOSE),
                                            });
                                            // The editor's values as the server takes them, and the window they make.
                                            const e = editing ? ownEdit! : null;
                                            const valueOf = (mode: string, day: string, none: string) => (mode === 'general' ? null : mode === 'none' ? none : day || null);
                                            const effOpens = e ? (e.opensMode === 'general' ? genOpens : e.opensMode === 'date' ? e.opens : '') : '';
                                            const effCloses = e ? (e.closesMode === 'general' ? genCloses : e.closesMode === 'date' ? e.closes : '') : '';
                                            const missing = !!e && ((e.opensMode === 'date' && !e.opens) || (e.closesMode === 'date' && !e.closes));
                                            const invalid = !!(effOpens && effCloses && effOpens > effCloses);
                                            const selectCls = 'w-full border-2 border-gray-100 rounded-xl px-3 py-2 bg-white focus:border-blue-500 outline-none text-xs font-bold text-gray-900';
                                            const editorField = (which: 'opens' | 'closes') => {
                                                const isOpens = which === 'opens';
                                                const mode = isOpens ? e!.opensMode : e!.closesMode;
                                                const day = isOpens ? e!.opens : e!.closes;
                                                const gen = isOpens ? genOpens : genCloses;
                                                const set = (patch: Partial<NonNullable<typeof ownEdit>>) => setOwnEdit(cur => (cur ? { ...cur, ...patch } : cur));
                                                return (
                                                    <div className="space-y-1 min-w-0">
                                                        <label htmlFor={`own-${which}-${loc.id}`} className="block text-[9px] font-bold text-gray-400 uppercase tracking-widest ml-1">{isOpens ? (t('lodging.dates.opens') || 'Apertura') : (t('lodging.dates.closes') || 'Cierre')}</label>
                                                        <Select id={`own-${which}-${loc.id}`} value={mode} className={selectCls}
                                                            onChange={ev => set(isOpens ? { opensMode: ev.target.value as any } : { closesMode: ev.target.value as any })}>
                                                            <option value="general">{(t('lodging.dates.general') || 'La general ({date})').replace('{date}', gen ? fmtDeadline(gen) : (isOpens ? (t('lodging.dates.opens.none') || 'sin esperar') : (t('lodging.dates.closes.none') || 'sin cierre')))}</option>
                                                            <option value="date">{t('lodging.dates.other') || 'Otra fecha'}</option>
                                                            <option value="none">{isOpens ? (t('lodging.dates.opens.nowait') || 'Sin esperar') : (t('lodging.dates.closes.never') || 'Sin cierre')}</option>
                                                        </Select>
                                                        {mode === 'date' && (
                                                            <DateField value={day} ariaLabel={`${isOpens ? (t('lodging.dates.opens') || 'Apertura') : (t('lodging.dates.closes') || 'Cierre')} · ${loc.name}`}
                                                                onChange={v => set(isOpens ? { opens: v } : { closes: v })} />
                                                        )}
                                                    </div>
                                                );
                                            };
                                            return (
                                                <div className={`p-3 bg-white rounded-xl border shadow-sm transition-colors ${own ? 'border-violet-100' : 'border-gray-50 group-hover:border-blue-100'}`} data-testid={`lodging-dates-${loc.id}`}>
                                                    {/* The card is narrow (three per row): the buttons go on a row of their own, never beside the text. */}
                                                    <div className="flex items-start gap-3">
                                                        <div className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-sm ${state === 'passed' ? 'bg-rose-50 text-rose-400' : state === 'notyet' ? 'bg-amber-50 text-amber-500' : 'bg-emerald-50 text-emerald-500'}`}>
                                                            <i className={`fa-solid ${state === 'passed' ? 'fa-lock' : state === 'notyet' ? 'fa-hourglass-half' : 'fa-unlock'}`}></i>
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">
                                                                {t('lodging.dates.location') || 'Fechas de hospedaje'}
                                                                <span className={`ml-1 ${own ? 'text-violet-700' : ''}`}>· {own ? (t('lodging.dates.own') || 'Propias') : (t('lodging.dates.generals') || 'Generales')}</span>
                                                            </div>
                                                            <span className={`inline-flex items-center mt-1 px-2 py-0.5 rounded-lg leading-tight text-[9px] font-black uppercase tracking-widest ${toneCls[state]}`}>{label}</span>
                                                            <div className="text-[11px] text-gray-500 mt-1 leading-snug">
                                                                <div>{t('lodging.dates.opens') || 'Apertura'}: <span className="font-bold text-gray-700">{opensText}</span>{mark(!!ownOpens)}</div>
                                                                <div>{t('lodging.dates.closes') || 'Cierre'}: <span className="font-bold text-gray-700">{closesText}</span>{mark(!!ownCloses)}</div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                        {!editing && canManage && (
                                                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                                                <button type="button" onClick={startEdit} disabled={savingOwn === loc.id}
                                                                    className="text-[10px] font-black uppercase tracking-widest px-3 py-2 rounded-xl bg-gray-50 text-gray-600 hover:bg-blue-600 hover:text-white transition-all shadow-sm disabled:opacity-50">
                                                                    <i className="fa-solid fa-calendar-day mr-1"></i>{own ? (t('lodging.dates.change') || 'Cambiar') : (t('lodging.dates.own.set') || 'Fechas propias')}
                                                                </button>
                                                                {own && (
                                                                    <button type="button" onClick={() => saveOwnDates(loc, null, null)} disabled={savingOwn === loc.id}
                                                                        className="text-[10px] font-black uppercase tracking-widest px-3 py-2 rounded-xl bg-gray-50 text-gray-500 hover:bg-rose-600 hover:text-white transition-all shadow-sm disabled:opacity-50">
                                                                        {t('lodging.dates.own.reset') || 'Usar las generales'}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        )}
                                                    {editing && (
                                                        <div className="mt-3 space-y-2">
                                                            <div className="grid gap-2">
                                                                {editorField('opens')}
                                                                {editorField('closes')}
                                                            </div>
                                                            {invalid && <p className="text-[11px] font-bold text-rose-600 ml-1" role="alert">{t('lodging.dates.invalid') || 'La apertura no puede ser posterior al cierre.'}</p>}
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <button type="button" onClick={() => saveOwnDates(loc, valueOf(e!.opensMode, e!.opens, LODGING_NO_WAIT), valueOf(e!.closesMode, e!.closes, LODGING_NO_CLOSE))}
                                                                    disabled={savingOwn === loc.id || missing || invalid}
                                                                    className="text-[10px] font-black uppercase tracking-widest px-4 py-2.5 rounded-xl bg-blue-600 text-white hover:bg-blue-700 transition-all shadow-sm disabled:opacity-50">
                                                                    {t('save') || 'Guardar'}
                                                                </button>
                                                                <button type="button" onClick={() => setOwnEdit(null)}
                                                                    className="text-[10px] font-black uppercase tracking-widest px-3 py-2.5 rounded-xl text-gray-400 hover:bg-gray-100">
                                                                    {t('cancel') || 'Cancelar'}
                                                                </button>
                                                                <p className="basis-full text-[11px] text-gray-500 ml-1">{t('lodging.dates.own.help') || 'Solo para esta localidad. Las fechas incluyen el día completo.'}</p>
                                                            </div>
                                                        </div>
                                                    )}
                                                    {own && w?.open && loc.lodging_status === 'validated' && (
                                                        <p className="mt-2 text-[11px] font-bold text-amber-700"><i className="fa-solid fa-circle-info mr-1"></i>{t('lodging.dates.validated.hint') || 'El hospedaje está validado: reábrelo para que el encargado pueda modificarlo.'}</p>
                                                    )}
                                                    {own && w?.open && loc.lodging_status === 'submitted' && (
                                                        <p className="mt-2 text-[11px] font-bold text-gray-500"><i className="fa-solid fa-circle-info mr-1"></i>{t('lodging.dates.submitted.hint') || 'El encargado puede retirar su envío para volver a acomodar.'}</p>
                                                    )}
                                                </div>
                                            );
                                        })()}
                                        <div className="flex items-center gap-4 p-3 bg-white rounded-xl border border-gray-50 shadow-sm group-hover:border-blue-100 transition-colors">
                                            <div className="w-8 h-8 shrink-0 rounded-lg bg-blue-50 text-blue-400 flex items-center justify-center text-sm">
                                                <i className="fa-solid fa-user-tie"></i>
                                            </div>
                                            <div className="min-w-0">
                                                <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{t('responsible') || 'Responsable'}</div>
                                                <div className="text-xs font-black text-gray-700 break-words">{loc.responsible_name || 'Sin asignar'}</div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-4 p-3 bg-white rounded-xl border border-gray-50 shadow-sm group-hover:border-blue-100 transition-colors">
                                            <div className="w-8 h-8 shrink-0 rounded-lg bg-indigo-50 text-indigo-400 flex items-center justify-center text-sm">
                                                <i className="fa-solid fa-phone"></i>
                                            </div>
                                            <div className="min-w-0">
                                                <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">{t('phone') || 'Teléfono'}</div>
                                                <div className="text-xs font-black text-gray-700">{loc.responsible_phone || 'N/A'}</div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Lodging review modal — fed by GET /locations/:id/lodging; the admin validates / returns / reopens. */}
            {reviewLoc && (() => {
                const status = review?.location?.lodging_status || reviewLoc.lodging_status || 'draft';
                const meta = lodgingStatusMeta(status);
                const counts = review?.counts || { placed: 0, unassigned: 0, hard_violations: 0, soft_violations: 0, placed_elsewhere: 0 };
                const violations = review?.violations || [];
                const note = review ? review.location?.lodging_note : reviewLoc.lodging_note;
                const submittedAt = review ? review.location?.lodging_submitted_at : reviewLoc.lodging_submitted_at;
                const reviewedAt = review ? review.location?.lodging_reviewed_at : reviewLoc.lodging_reviewed_at;
                const hardLabel = t('rule.hard') || 'Obligatoria';
                const softLabel = t('rule.soft') || 'Preferente';
                return (
                    <Overlay layer={1}>
                        <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-4xl border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200 max-h-[92vh] flex flex-col">
                            <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between gap-4">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-3 flex-wrap">
                                        <h3 className="font-bold text-xl text-gray-900 italic truncate">{t('lodging.review.title') || 'Revisión de hospedaje'} — {reviewLoc.name}</h3>
                                        <span className={`px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-widest ${meta.cls}`}>
                                            <i className={`fa-solid ${meta.icon} mr-1`}></i>{t(meta.key) || meta.fallback}
                                        </span>
                                    </div>
                                    <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1 flex flex-wrap gap-x-3">
                                        {submittedAt && <span>{t('lodging.submitted.at') || 'Enviado'}: {fmtDate(submittedAt)}</span>}
                                        {reviewedAt && <span>{t('lodging.reviewed.at') || 'Revisado'}: {fmtDate(reviewedAt)}</span>}
                                    </p>
                                </div>
                                <button onClick={closeReview} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-lg shrink-0">
                                    <i className="fa-solid fa-xmark text-lg"></i>
                                </button>
                            </div>

                            <div className="p-8 space-y-8 overflow-y-auto modern-scrollbar flex-1">
                                {reviewLoading && !review ? (
                                    <div className="text-center py-16"><div className="inline-block w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin"></div></div>
                                ) : !review ? (
                                    <div className="text-center py-16 text-gray-400 text-sm">{t('lodging.error.loading') || 'Error al cargar el hospedaje'}</div>
                                ) : (
                                    <>
                                        {/* The four counts */}
                                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                                            {[
                                                { label: t('lodging.counts.placed') || 'Alojados', value: counts.placed, cls: 'bg-emerald-50 text-emerald-700', icon: 'fa-bed' },
                                                { label: t('lodging.counts.unassigned') || 'Sin habitación', value: counts.unassigned, cls: counts.unassigned > 0 ? 'bg-amber-50 text-amber-700' : 'bg-gray-50 text-gray-500', icon: 'fa-user-slash' },
                                                { label: t('lodging.counts.hard') || 'Faltas obligatorias', value: counts.hard_violations, cls: counts.hard_violations > 0 ? 'bg-rose-50 text-rose-700' : 'bg-gray-50 text-gray-500', icon: 'fa-triangle-exclamation' },
                                                { label: t('lodging.counts.soft') || 'Faltas preferentes', value: counts.soft_violations, cls: counts.soft_violations > 0 ? 'bg-amber-50 text-amber-700' : 'bg-gray-50 text-gray-500', icon: 'fa-circle-exclamation' },
                                            ].map((c, i) => (
                                                <div key={i} className={`rounded-2xl p-4 ${c.cls}`}>
                                                    <div className="text-[9px] font-black uppercase tracking-widest opacity-70"><i className={`fa-solid ${c.icon} mr-1`}></i>{c.label}</div>
                                                    <div className="text-2xl font-black italic tracking-tighter mt-1">{c.value}</div>
                                                </div>
                                            ))}
                                        </div>

                                        {/* Actions by status */}
                                        <div className={`rounded-2xl border p-5 ${status === 'submitted' ? 'bg-amber-50/40 border-amber-200' : status === 'validated' ? 'bg-emerald-50/40 border-emerald-200' : 'bg-gray-50 border-gray-100'}`}>
                                            {status === 'submitted' && !canManage && (
                                                <p className="text-sm text-amber-800 font-medium"><i className="fa-solid fa-hourglass-half mr-2"></i>{tx('perm.lodging.review.readonly', 'Enviado por el encargado y pendiente de validación. Tu rol solo puede consultarlo.')}</p>
                                            )}
                                            {status === 'submitted' && canManage && (
                                                <div className="space-y-4">
                                                    <div className="flex flex-wrap items-center gap-3">
                                                        <button
                                                            onClick={handleValidate}
                                                            disabled={reviewBusy}
                                                            className="px-6 py-3 rounded-xl bg-emerald-600 text-white font-black text-[10px] uppercase tracking-widest hover:bg-emerald-700 transition-all disabled:opacity-50 flex items-center gap-2 shadow-lg shadow-emerald-500/20"
                                                        >
                                                            <i className="fa-solid fa-circle-check"></i> {t('lodging.validate') || 'Validar'}
                                                        </button>
                                                        <button
                                                            onClick={() => setShowReturnForm(v => !v)}
                                                            disabled={reviewBusy}
                                                            className={`px-6 py-3 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50 flex items-center gap-2 border-2 ${showReturnForm ? 'border-amber-500 bg-amber-100 text-amber-800' : 'border-amber-300 bg-white text-amber-700 hover:bg-amber-50'}`}
                                                        >
                                                            <i className="fa-solid fa-rotate-left"></i> {t('lodging.return') || 'Devolver'}
                                                        </button>
                                                    </div>
                                                    {showReturnForm && (
                                                        <div className="space-y-2">
                                                            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest ml-1">{t('lodging.return.note') || 'Observaciones para el encargado'} *</label>
                                                            <textarea
                                                                value={returnNote}
                                                                onChange={e => setReturnNote(e.target.value)}
                                                                rows={3}
                                                                maxLength={2000}
                                                                aria-required="true"
                                                                placeholder={t('lodging.return.note.placeholder') || 'Explica qué debe corregir el encargado…'}
                                                                className="w-full border-2 border-amber-200 rounded-xl px-4 py-3 bg-white focus:border-amber-500 transition-all outline-none text-gray-900 font-medium text-sm"
                                                                autoFocus
                                                            />
                                                            <div className="flex justify-end">
                                                                <button
                                                                    onClick={handleReturn}
                                                                    disabled={reviewBusy || !returnNote.trim()}
                                                                    className="px-6 py-2.5 rounded-xl bg-amber-500 text-white font-black text-[10px] uppercase tracking-widest hover:bg-amber-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                                                >
                                                                    <i className="fa-solid fa-paper-plane"></i> {t('lodging.return') || 'Devolver'}
                                                                </button>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                            {status === 'validated' && (
                                                <div className="flex flex-wrap items-center gap-3">
                                                    <p className="text-sm text-emerald-800 font-medium flex-1"><i className="fa-solid fa-circle-check mr-2"></i>{t('lodging.status.validated') || 'Validado'}</p>
                                                    {canManage && <button
                                                        onClick={handleReopen}
                                                        disabled={reviewBusy}
                                                        className="px-6 py-3 rounded-xl border-2 border-emerald-300 bg-white text-emerald-700 font-black text-[10px] uppercase tracking-widest hover:bg-emerald-50 transition-all disabled:opacity-50 flex items-center gap-2"
                                                    >
                                                        <i className="fa-solid fa-lock-open"></i> {t('lodging.reopen') || 'Reabrir'}
                                                    </button>}
                                                </div>
                                            )}
                                            {status === 'draft' && (
                                                <div className="space-y-3">
                                                    <p className="text-sm text-gray-500 font-medium"><i className="fa-solid fa-hourglass-half mr-2"></i>{t('lodging.not.submitted') || 'El encargado aún no ha enviado el hospedaje'}</p>
                                                    {note && (
                                                        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200">
                                                            <div className="text-[9px] font-black uppercase tracking-widest text-amber-600 mb-1">{t('lodging.note.label') || 'Observaciones enviadas al encargado'}</div>
                                                            <p className="text-sm text-amber-900 whitespace-pre-wrap">{note}</p>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                            {/* 2.17.0: what the administration changed since the coordinator's submission, and
                                                the way to change it without reopening (Hospedaje › gestionar). */}
                                            {(adjustStampOf(review.location) || (canAdjust && isLodgingFrozen(status))) && (
                                                <div className="mt-4 pt-4 border-t border-black/5 space-y-3" data-adjust-review={status}>
                                                    <AdjustStamp location={review.location} tx={tx} detail />
                                                    {canAdjust && isLodgingFrozen(status) && (
                                                        <div className="flex flex-wrap items-center gap-3">
                                                            <p className="text-xs text-gray-600 font-medium flex-1 min-w-[12rem]">{tx('lodging.adjust.review.help', 'Puedes ajustar este hospedaje sin reabrirlo, en Asignación o en Alojamiento: el estado no cambia y cada cambio queda registrado.')}</p>
                                                            <button
                                                                type="button"
                                                                data-adjust-open=""
                                                                onClick={() => { const id = reviewLoc.id; closeReview(); onOpenExplorer!({ locationId: id }); }}
                                                                className="px-5 py-2.5 rounded-xl bg-white border-2 border-blue-200 text-blue-700 font-black text-[10px] uppercase tracking-widest hover:bg-blue-50 transition-all flex items-center gap-2"
                                                            >
                                                                <i className="fa-solid fa-pen-to-square" aria-hidden="true"></i> {tx('lodging.adjust.open', 'Ajustar en Asignación')}
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>

                                        {/* Violations: hard in red, soft in amber */}
                                        <div>
                                            <h4 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">{t('lodging.violations') || 'Reglas incumplidas'}</h4>
                                            {violations.length === 0 ? (
                                                <p className="text-xs text-emerald-700 font-medium"><i className="fa-solid fa-check mr-1"></i>{t('lodging.violations.none') || 'Todas las reglas se cumplen.'}</p>
                                            ) : (
                                                <ul className="space-y-1.5">
                                                    {violations.map((v: any, i: number) => (
                                                        <li key={i} className={`flex items-start gap-2 text-xs p-2.5 rounded-xl border ${v.hard ? 'bg-rose-50 border-rose-200 text-rose-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
                                                            <span className={`mt-0.5 px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-widest whitespace-nowrap ${v.hard ? 'bg-rose-100 text-rose-600' : 'bg-amber-100 text-amber-700'}`}>{v.hard ? hardLabel : softLabel}</span>
                                                            <span><b>{v.rule}</b> — {v.detail}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}
                                        </div>

                                        {/* Rooms with occupants */}
                                        <div>
                                            <h4 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">{t('lodging.rooms.title') || 'Habitaciones y ocupantes'} ({review.rooms.length})</h4>
                                            {review.rooms.length === 0 ? (
                                                <p className="text-xs text-gray-400 italic">{t('lodging.rooms.none') || 'Esta localidad no tiene habitaciones asignadas.'}</p>
                                            ) : (
                                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                                    {review.rooms.map(room => {
                                                        const over = (room.occupied || 0) > (room.capacity || 0);
                                                        return (
                                                            <div key={room.id} className={`p-4 rounded-2xl border ${over ? 'border-rose-200 bg-rose-50/30' : 'border-gray-100 bg-gray-50/40'}`}>
                                                                <div className="flex items-center justify-between gap-2 mb-2">
                                                                    <div className="min-w-0">
                                                                        <div className="font-black text-sm text-gray-900 italic tracking-tighter truncate">{room.room_number}</div>
                                                                        <div className="text-[9px] text-gray-400 font-bold uppercase tracking-widest truncate">{room.hotel_name}</div>
                                                                    </div>
                                                                    <span className={`text-xs font-black whitespace-nowrap ${over ? 'text-rose-600' : 'text-gray-700'}`}>{room.occupied || 0}<span className="text-gray-300">/</span>{room.capacity}</span>
                                                                </div>
                                                                {(room.occupants || []).length === 0 ? (
                                                                    <p className="text-[10px] text-gray-300 italic">{t('lodging.room.empty') || 'Vacía'}</p>
                                                                ) : (
                                                                    <ul className="space-y-1">
                                                                        {room.occupants.map((p: any) => (
                                                                            <li key={p.id} className="text-xs text-gray-700 flex items-center gap-2">
                                                                                <i className={`fa-solid ${genderKey(p.gender) === 'F' ? 'fa-venus text-pink-400' : genderKey(p.gender) === 'M' ? 'fa-mars text-blue-400' : 'fa-user text-gray-300'} text-[9px]`}></i>
                                                                                <span className="truncate">{occupantName(p)}</span>
                                                                                {p.family_group && <span className="text-[8px] font-black uppercase tracking-widest text-indigo-500 bg-indigo-50 px-1.5 rounded">{p.family_group}</span>}
                                                                            </li>
                                                                        ))}
                                                                    </ul>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>

                                        {/* Unassigned */}
                                        <div>
                                            <h4 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">{t('lodging.unassigned.title') || 'Participantes sin habitación'} ({review.unassigned.length})</h4>
                                            {review.unassigned.length === 0 ? (
                                                <p className="text-xs text-emerald-700 font-medium"><i className="fa-solid fa-check mr-1"></i>{t('lodging.unassigned.none') || 'Todos los participantes tienen habitación.'}</p>
                                            ) : (
                                                <div className="flex flex-wrap gap-2">
                                                    {review.unassigned.map((p: any) => (
                                                        <span key={p.id} className="px-3 py-1.5 rounded-xl bg-amber-50 border border-amber-200 text-xs font-bold text-amber-800">{occupantName(p)}</span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        {/* Placed by the admin into pool rooms (read-only for the coordinator) */}
                                        {(review.placed_elsewhere || []).length > 0 && (
                                            <div>
                                                <h4 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">{t('lodging.elsewhere.title') || 'Alojados por el administrador en habitaciones del pool'} ({review.placed_elsewhere.length})</h4>
                                                <ul className="space-y-1">
                                                    {review.placed_elsewhere.map(p => (
                                                        <li key={p.id} className="text-xs text-gray-700 flex items-center gap-2">
                                                            <i className="fa-solid fa-bed text-[9px] text-purple-400"></i>
                                                            <span>{occupantName(p)}</span>
                                                            <span className="text-gray-400">— {p.hotel_name} · {p.room_number}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}

                                        {/* The location's own rules, read-only */}
                                        <div>
                                            <h4 className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1">{t('lodging.rules.title') || 'Reglas propias del encargado'} ({(review.rules?.location || []).length})</h4>
                                            <p className="text-[10px] text-gray-400 mb-3">{t('lodging.rules.conference.hint') || 'Se aplican además las reglas de la conferencia'} ({(review.rules?.conference || []).length}).</p>
                                            {(review.rules?.location || []).length === 0 ? (
                                                <p className="text-xs text-gray-400 italic">{t('lodging.rules.none') || 'El encargado no ha definido reglas propias.'}</p>
                                            ) : (
                                                <div className="divide-y divide-gray-100 rounded-2xl border border-gray-100 overflow-hidden">
                                                    {review.rules.location.map((rule: any) => (
                                                        <div key={rule.id} className={`p-3 flex items-center gap-3 ${rule.enabled ? 'bg-white' : 'bg-gray-50 opacity-60'}`}>
                                                            <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-500 flex items-center justify-center text-xs shrink-0">
                                                                <i className={`fa-solid ${ruleTypeMeta(rule.type).icon}`}></i>
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-2 flex-wrap">
                                                                    <span className="font-black text-sm text-gray-900 truncate">{rule.name}</span>
                                                                    <span className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest bg-indigo-50 text-indigo-600">{ruleTypeMeta(rule.type).label}</span>
                                                                    <span className={`px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest ${rule.hard ? 'bg-rose-50 text-rose-600' : 'bg-gray-100 text-gray-400'}`}>{rule.hard ? hardLabel : softLabel}</span>
                                                                </div>
                                                                <div className="text-[9px] text-gray-400 font-bold uppercase tracking-widest mt-0.5">
                                                                    {t('priority')}: {rule.priority}{rule.config ? ` · ${rule.config}` : ''}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    </Overlay>
                );
            })()}

            {/* Create Location Modal */}
            {showModal && (
                <Overlay layer={1}>
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-center justify-between">
                            <h3 className="font-bold text-xl text-gray-900 italic">{t('new.location')}</h3>
                            <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-lg">
                                <i className="fa-solid fa-xmark text-lg"></i>
                            </button>
                        </div>

                        <div className="p-8 space-y-6">
                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('location.name')}</label>
                                <input
                                    type="text"
                                    value={newLocation.name}
                                    onChange={e => setNewLocation({ ...newLocation, name: e.target.value })}
                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium"
                                    placeholder="Ej. Zona Norte"
                                    autoFocus={canAutoFocus()}
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('location.capacity')} *</label>
                                <input
                                    type="number"
                                    min={1}
                                    step={1}
                                    value={newLocation.capacity}
                                    onChange={e => setNewLocation({ ...newLocation, capacity: e.target.value })}
                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium"
                                    placeholder={t('location.capacity.placeholder')}
                                />
                                <p className="text-[11px] text-gray-400 ml-1 leading-relaxed">{t('location.capacity.help')}</p>
                            </div>

                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('payment.methods')}</label>
                                <div className="flex flex-wrap gap-3">
                                    {PAYMENT_METHODS.map(m => {
                                        const on = newLocation.payment_methods.includes(m);
                                        return (
                                            <label key={m} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 cursor-pointer transition-all ${on ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-gray-100 bg-gray-50/30 text-gray-500'}`}>
                                                <input
                                                    type="checkbox"
                                                    checked={on}
                                                    onChange={() => setNewLocation({ ...newLocation, payment_methods: on ? newLocation.payment_methods.filter(x => x !== m) : [...newLocation.payment_methods, m] })}
                                                    className="accent-emerald-600"
                                                />
                                                <span className="text-sm font-bold">{paymentMethodLabel(tx, m)}</span>
                                            </label>
                                        );
                                    })}
                                </div>
                                <p className="text-[11px] text-gray-400 ml-1 leading-relaxed">{t('payment.methods.help')}</p>
                            </div>

                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('responsible.person')}</label>
                                <input
                                    type="text"
                                    value={newLocation.responsible_name}
                                    onChange={e => setNewLocation({ ...newLocation, responsible_name: e.target.value })}
                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium"
                                    placeholder={t('responsible.person.description')}
                                />
                            </div>

                            <div className="space-y-1.5">
                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{t('responsible.phone')}</label>
                                <input
                                    type="text"
                                    value={newLocation.responsible_phone}
                                    onChange={e => setNewLocation({ ...newLocation, responsible_phone: e.target.value })}
                                    className="w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium"
                                    placeholder="Ej. +1 555-123-4567"
                                />
                            </div>

                            <div className="bg-blue-50/50 p-4 rounded-2xl flex items-start gap-4 border border-blue-50">
                                <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center shrink-0">
                                    <i className="fa-solid fa-info-circle"></i>
                                </div>
                                <p className="text-xs text-blue-700/80 font-medium leading-relaxed">{t('location.code')} {t('slug.help')}</p>
                            </div>

                            <div className="flex justify-end gap-3 pt-4 border-t border-gray-50" data-cm-sheet-foot="">
                                <button
                                    onClick={() => setShowModal(false)}
                                    className="px-6 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl transition-all"
                                >
                                    {t('cancel')}
                                </button>
                                <button
                                    onClick={handleCreate}
                                    disabled={!canCreate}
                                    className="px-8 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-bold shadow-lg shadow-blue-500/30 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {t('create')}
                                </button>
                            </div>
                        </div>
                    </div>
                </Overlay>
            )}

            {/* In-page confirm dialog — z-[120], above the review modal (z-100). */}
            {confirmState && (
                <Overlay layer={3} onEscape={() => { confirmState.resolve(false); setConfirmState(null); }}>
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-150" role="alertdialog" aria-modal="true"
                        aria-label={tx('confirm.title', 'Confirmar')} aria-describedby="cm-loc-confirm-msg">
                        <div className="p-6">
                            <p id="cm-loc-confirm-msg" className="text-gray-800 font-medium leading-relaxed">{confirmState.message}</p>
                        </div>
                        <div className="px-6 py-4 bg-gray-50/50 border-t border-gray-100 flex justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => { confirmState.resolve(false); setConfirmState(null); }}
                                className="min-h-[44px] px-5 py-2 text-gray-600 font-bold hover:bg-gray-100 rounded-xl transition"
                            >
                                {t('cancel') || 'Cancelar'}
                            </button>
                            <button
                                type="button"
                                onClick={() => { confirmState.resolve(true); setConfirmState(null); }}
                                className={`min-h-[44px] px-5 py-2 text-white font-bold rounded-xl shadow-lg transition ${confirmState.danger ? 'bg-rose-600 hover:bg-rose-700 shadow-rose-500/30' : 'bg-blue-600 hover:bg-blue-700 shadow-blue-500/30'}`}
                            >
                                {confirmState.label}
                            </button>
                        </div>
                    </div>
                </Overlay>
            )}
        </div>
    );
}
