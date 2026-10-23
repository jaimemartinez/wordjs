// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

import React, { useState, useEffect } from "react";
import { ToastProvider, useToast } from "@/contexts/ToastContext";
import { csrfHeaders } from "@/lib/csrf";
// Pure form helpers (seeding, string-only values, request body, money) — see form.ts for the contract
// with conference-manager: values travel as strings, the SERVER canonicalises numbers.
import { SWITCH_OFF, SWITCH_ON, fieldOptions, fmtMoney, formBody, initialFormValues, inputToFormValue, isLocationFull, isSwitchOn, paymentMethodsOf, seatsLabel, type PortalField } from "./form";
// The Hospedajes tab (lodging per location): its own data flow, one GET /portal/lodging, mounted only while selected.
import Hospedajes from "./LodgingTab";
// Participantes: the paged roster with compact rows and the «⋮» participant sheet (participants.ts holds the rules).
import ParticipantList from "./ParticipantList";
import ParticipantSheet from "./ParticipantSheet";
import { consentT } from "../lib/consentI18n";
import { familyGroupsOf, isCancelled, personName, pruneSelection, type PortalPerson } from "./participants";
// «Pagos de cuotas» (conference-manager ≥ 2.18.0): the tab, its data hub and its sheets (feePayments.ts holds the rules).
import FeePaymentsTab, { FeeSheets, useFeeHub } from "./FeePaymentsTab";
import { feeBadge, hasFeePayments, mergeBalances, rowBalanceC, type PortalFeeView } from "./feePayments";
import { hasBadges } from "./badges";
import { PortalBadgeBulk } from "./PortalBadges";
// Version skew: the old bulk-payment dialog, only for a plugin without «Pagos de cuotas».
import LegacyBulkPayment from "./LegacyBulkPayment";
import { useFieldErrors } from "../lib/useFieldErrors";
// Visual primitives shared with the conference-manager admin design language (see ui.tsx).
import { Badge, Button, Card, CardHeader, EmptyState, Field, HeroCard, IconButton, Notice, Spinner, captionCls, captionWideCls, cx, headingCls, inputBoldCls, inputCls, selectCls } from "./ui";
import { HealthConditionsInput } from "../lib/HealthConditionsInput";
import { HEALTH_FIELD, healthAnswerError, healthPayload, isHealthField } from "../lib/health";
import { DateField } from "../lib/DateField";
import { PhoneInput } from "../lib/PhoneInput";
import { isPhoneField } from "../lib/phone";
import { Select } from "../lib/Select";
// Import global API helper specifically suitable for handling custom headers or URLs if needed,
// but basically we can reuse the generic apiGet/Post if we can override headers or just use fetch for the auth ones.
// We'll create a simple local fetcher for the portal to manage the custom token auth simpler.
// import { apiGet } from "../../src/lib/api"; // Unused

// Reusing types from plugin (re-defined here to avoid complex relative imports or just hardcode generic)
interface Conference {
    id: number;
    name: string;
    slug: string;
    date_start?: string;
    date_end?: string;
    description?: string;
    status?: string;
}

interface Location {
    id: number;
    name: string;
    responsible_name: string;
    conference_id?: number;
    /** Admin-set maximum registrants; null/absent = no limit (see form.ts). */
    capacity?: number | null;
    /** Seats taken (non-cancelled inscriptions), as counted by the server. */
    inscribed?: number | null;
    /** Forms of payment enabled for this location (see paymentMethodsOf). */
    payment_methods?: string[];
    /** conference-manager ≥ 2.18.0: `{ fee_payments: 1 }` — «Pagos de cuotas» exists (else the old bulk flow). */
    features?: { fee_payments?: number; badges?: number };
    /** The fee tab's badge: this location's own payments returned by / awaiting the administration. */
    fees?: { pending?: number; returned?: number };
}

// A roster row of GET /portal/inscriptions (participants.ts PortalPerson): the payment columns, the form's
// field columns flat on the row (custom_data fallback for legacy rows) and, from 2.18.0, pending_amount /
// returned_amount / cancelled. Names follow the form (form.ts portalPersonName), as in the admin.
type Inscription = PortalPerson;

// Combobox for the GROUPING field: search/pick an existing group (with member preview) or create a
// new one. Module-level (never define a component inside a component — it steals input focus).
function GroupPicker({ field, value, onChange, groups, id, invalid, describedBy }: any) {
    const [open, setOpen] = useState(false);
    const val = value == null ? '' : String(value);
    const lower = val.trim().toLowerCase();
    const list = groups || [];
    const filtered = lower ? list.filter((g: any) => g.name.toLowerCase().includes(lower)) : list;
    const exact = list.find((g: any) => g.name.toLowerCase() === lower);
    return (
        <div className="relative">
            <input
                id={id}
                type="text"
                required={!!field.is_required}
                data-field={field.name} aria-invalid={invalid} aria-describedby={describedBy}
                className={inputCls}
                placeholder="Buscar grupo existente o escribir uno nuevo…"
                value={val}
                onChange={(e) => onChange(e.target.value)}
                onFocus={() => setOpen(true)}
                onBlur={() => setTimeout(() => setOpen(false), 180)}
                autoComplete="off"
            />
            {open && (
                <div className="absolute z-40 left-0 right-0 mt-2 bg-white border border-gray-100 rounded-3xl shadow-2xl max-h-64 overflow-y-auto p-2 animate-in slide-in-from-top-2 duration-200">
                    {filtered.length === 0 && !val && (
                        <div className="px-4 py-3 text-xs font-bold text-gray-500 italic">Aún no hay grupos en esta localidad. Escribe para crear el primero.</div>
                    )}
                    {filtered.map((g: any) => (
                        <button
                            type="button"
                            key={g.name}
                            onMouseDown={(e) => { e.preventDefault(); onChange(g.name); setOpen(false); }}
                            className="w-full text-left px-4 py-3 hover:bg-blue-50 rounded-2xl transition-all group"
                        >
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-bold text-gray-700 group-hover:text-blue-700 transition-colors truncate">{g.name}</span>
                                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest whitespace-nowrap">{g.count} {g.count === 1 ? 'persona' : 'personas'}</span>
                            </div>
                            {g.members && g.members.length > 0 && (
                                <div className="text-[11px] text-gray-400 truncate mt-0.5">{g.members.map((m: any) => m.name).join(', ')}</div>
                            )}
                        </button>
                    ))}
                    {val.trim() && !exact && (
                        <button
                            type="button"
                            onMouseDown={(e) => { e.preventDefault(); setOpen(false); }}
                            className="w-full text-left px-4 py-3 mt-1 rounded-2xl text-blue-600 hover:bg-blue-50 font-bold text-sm border-t border-gray-50 transition-all"
                        >
                            <i className="fa-solid fa-plus mr-2"></i>Crear grupo «{val.trim()}»
                        </button>
                    )}
                </div>
            )}
            {exact && exact.members && exact.members.length > 0 && (
                <div className="mt-2 text-xs text-gray-600 bg-blue-50/60 rounded-xl px-4 py-2.5 border border-blue-100">
                    <span className="font-bold text-blue-900">En «{exact.name}» ({exact.count}):</span> {exact.members.map((m: any) => m.name).join(', ')}
                </div>
            )}
        </div>
    );
}

function LocationPortalContent() {
    const { addToast } = useToast();
    // Auth State. The portal session is an HttpOnly, host-namespaced + path-scoped cookie
    // (wjp_conference_manager_wordjs_portal_token) set by the login route. We also keep the token in
    // state and send it as the `x-portal-token` header on authenticated calls — a belt-and-braces
    // fallback the backend accepts in case the namespaced cookie isn't carried.
    const [token, setToken] = useState<string | null>(null);
    // Authenticated requests forward the token via header when available (cookie is the primary path).
    const portalAuthHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
        ...extra,
        // Not the portal's own credential (that is x-portal-token below): these are same-origin calls
        // to /api/v1/plugin/*, so a visitor who is ALSO signed in to WordJS sends their session cookie
        // with them, and the double-submit gate then requires this header (see lib/csrf.ts). Sent on
        // reads too — the backend only checks mutating methods, so one helper covers both.
        ...csrfHeaders(),
        ...(token ? { 'x-portal-token': token } : {}),
    });
    const [myLocation, setMyLocation] = useState<Location | null>(null);
    const [step, setStep] = useState<'login' | 'dashboard'>('login');
    // The portal's screens are Spanish only, so its field messages are too (not the site's <html lang>).
    const feLogin = useFieldErrors('es');
    const fe = useFieldErrors('es');
    const [loading, setLoading] = useState(false);

    // Login State
    const [conferences, setConferences] = useState<Conference[]>([]);
    const [selectedConference, setSelectedConference] = useState<string>('');
    const [isConferenceLocked, setIsConferenceLocked] = useState(false);
    const [locations, setLocations] = useState<Location[]>([]);
    const [selectedLocation, setSelectedLocation] = useState<string>('');
    const [code, setCode] = useState('');

    // Dashboard State
    const [inscriptions, setInscriptions] = useState<Inscription[]>([]);
    const [view, setView] = useState<'list' | 'add'>('list');
    // Dashboard tab. «Pagos de cuotas» exists only when the plugin says so (features.fee_payments); it and
    // Hospedajes mount on demand (one request each).
    const [tab, setTab] = useState<'participants' | 'fees' | 'lodging'>('participants');
    const [error, setError] = useState<string | null>(null);

    // Dynamic Form Data. Every value is a STRING (a blank number field is '' — never 0 — and the raw
    // input text is sent as-is; the plugin canonicalises "0030" → "30" and rejects non-numbers with 400).
    const [formData, setFormData] = useState<Record<string, string>>({});
    const [fields, setFields] = useState<PortalField[]>([]);
    // «Condiciones de salud» (2.32.0) is asked on registration and never read back: the lists, the sheet, the
    // search and the price quote work on the other fields.
    const listFields = fields.filter((f) => !isHealthField(f));
    const [healthError, setHealthError] = useState<string | null>(null);
    const [groups, setGroups] = useState<any[]>([]);
    // Live fee quote for the form being filled (POST /public/quote). `null` = not available yet, or the
    // current values are not quotable (a 400 for an invalid number just hides the line until it is fixed).
    const [quote, setQuote] = useState<{ total: number } | null>(null);

    // The participant whose sheet («⋮») is open — read BY ID from the live roster, so it shows the new
    // balance after a payment and closes itself if the person disappears.
    const [sheetId, setSheetId] = useState<number | null>(null);
    // Version skew only (a plugin without «Pagos de cuotas»): the old multi-select and bulk dialog.
    const [legacySelected, setLegacySelected] = useState<number[]>([]);
    const [legacyPayIds, setLegacyPayIds] = useState<number[] | null>(null);
    const [legacyAmount, setLegacyAmount] = useState('');
    // «Pagos de cuotas»: its data and sheets live here so both tabs reach them (a participant's sheet opens
    // the payment sheet on top). Every fresh view patches the roster rows and the tab's badge — no reload.
    const feeHub = useFeeHub({
        authHeaders: (extra) => portalAuthHeaders(extra),
        onView: (v: PortalFeeView) => {
            setInscriptions((rows) => mergeBalances(rows, v.people));
            setMyLocation((l) => (l ? { ...l, fees: { pending: v.counts.pending, returned: v.counts.returned } } : l));
        },
        onUnauthorized: () => sessionExpired(),
        notify: (m, t) => addToast(m, t),
        // A participant's sheet open: the hub says things in it (a payment sent from it), not in a toast over it.
        sheetOpen: () => sheetId != null,
    });

    // 1. Initial Load: Check token (via cookie) & Load Conferences
    useEffect(() => {
        // We no longer check localStorage for portal_token.
        // Instead, we just try to verify our session with the server.
        verifyToken();
    }, []);

    // 2. Load Locations when Conference Selected
    useEffect(() => {
        if (selectedConference) {
            loadLocations(selectedConference);
        } else {
            setLocations([]);
        }
    }, [selectedConference]);

    // Load the dynamic form fields for a conference and seed formData. Extracted so BOTH the login
    // flow and session-restore can call it — without it, registering after a refresh showed
    // "no fields configured" and a disabled submit button.
    const loadFields = async (confId: number | string) => {
        try {
            const res = await fetch(`/api/v1/plugin/conference-manager/public/fields?conference_id=${confId}`);
            if (!res.ok) return;
            const fieldsData: PortalField[] = await res.json();
            setFields(fieldsData);
            setFormData(initialFormValues(fieldsData));
        } catch (e) { console.error(e); }
    };

    // Live quote: whenever a form value changes while registering, ask the plugin what the fee would be
    // (the SERVER decides which fields are fee-relevant — one SELECT per quote). Debounced, abortable, and
    // a 400 (an invalid number mid-typing) just hides the line; the definitive fee is fixed on save.
    useEffect(() => {
        if (view !== 'add') { setQuote(null); return; }
        if (!myLocation?.conference_id || fields.length === 0) return;
        const conferenceId = myLocation.conference_id;
        const ctrl = new AbortController();
        const h = setTimeout(async () => {
            try {
                const res = await fetch('/api/v1/plugin/conference-manager/public/quote', {
                    method: 'POST', signal: ctrl.signal, credentials: 'include',
                    headers: portalAuthHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ conference_id: conferenceId, fields: formBody(Object.fromEntries(Object.entries(formData).filter(([k]) => k !== HEALTH_FIELD))) }),
                });
                if (!res.ok) { setQuote(null); return; }
                const data = await res.json().catch(() => null);
                setQuote(data && Number.isFinite(Number(data.total)) ? { total: Number(data.total) } : null);
            } catch { /* aborted / offline — keep the last quote */ }
        }, 350);
        return () => { clearTimeout(h); ctrl.abort(); };
        // portalAuthHeaders is a plain closure over `token`; re-quoting on token change is not needed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [formData, view, fields, myLocation?.conference_id]);

    const verifyToken = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/v1/plugin/conference-manager/portal/me', {
                credentials: 'include',
                headers: portalAuthHeaders()
            });
            if (res.ok) {
                const data = await res.json();
                setMyLocation(data);
                setStep('dashboard');
                loadInscriptions();
                if (data.conference_id) loadFields(data.conference_id); // so registration works after refresh
            } else {
                // If not logged in, load the conferences for the login screen
                loadConferences();
            }
        } catch {
            loadConferences();
        } finally {
            setLoading(false);
        }
    };

    const loadConferences = async () => {
        try {
            const res = await fetch('/api/v1/plugin/conference-manager/public/list');
            if (!res.ok) {
                setError('No se pudieron cargar las conferencias. Inténtalo de nuevo más tarde.');
                return;
            }
            const data = await res.json();
            setConferences(data);

            if (typeof window !== 'undefined') {
                const params = new URLSearchParams(window.location.search);
                const slug = params.get('slug');
                if (slug) {
                    const found = data.find((c: Conference) => c.slug === slug);
                    if (found) {
                        setSelectedConference(found.id.toString());
                        setIsConferenceLocked(true);
                    } else {
                        setError('La conferencia solicitada no está disponible o el formulario no ha sido publicado.');
                    }
                } else if (data.length === 0) {
                    setError('No hay conferencias disponibles en este momento.');
                }
            }
        } catch (e) {
            console.error(e);
            setError('Error de conexión al cargar las conferencias.');
        }
    };

    const loadLocations = async (confId: string) => {
        try {
            const res = await fetch(`/api/v1/plugin/conference-manager/public/locations?conference_id=${confId}`);
            if (res.ok) {
                setLocations(await res.json());
                loadFields(confId); // shared loader — guards NULL options, seeds formData
            } else if (res.status === 403) {
                const err = await res.json();
                addToast(err.error, 'error');
                setSelectedConference('');
            }
        } catch (e) { console.error(e); }
    };

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            const res = await fetch('/api/v1/plugin/conference-manager/portal/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
                body: JSON.stringify({ location_id: selectedLocation, code }),
                credentials: 'include'
            });
            // Parse defensively — a 500/HTML/proxy error must not throw before we can read the status.
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                // A new session: nothing a previous coordinator of this device left loading may show up.
                feeHub.reset();
                setToken(data.token);
                setMyLocation(data.location);
                setStep('dashboard');
                loadInscriptions();
                if (data.location?.conference_id) loadFields(data.location.conference_id);
            } else {
                addToast(data.error || 'No se pudo iniciar sesión. Verifica el código.', 'error');
            }
        } catch {
            addToast('Error de conexión', 'error');
        } finally {
            setLoading(false);
        }
    };

    const logout = async () => {
        // Clear the HttpOnly cookie server-side so a refresh on a shared device doesn't re-login.
        try {
            await fetch('/api/v1/plugin/conference-manager/portal/logout', {
                method: 'POST',
                credentials: 'include',
                headers: portalAuthHeaders()
            });
        } catch { /* clearing local state below is enough to log out this tab */ }
        // Forget the lodging explorer's remembered place on this device (it is per location anyway).
        try {
            for (let i = sessionStorage.length - 1; i >= 0; i--) {
                const k = sessionStorage.key(i);
                if (k && k.startsWith("cm.portal.lodging.explorer.")) sessionStorage.removeItem(k);
            }
        } catch { /* storage unavailable: nothing to forget */ }
        resetDashboard();
        loadConferences();
    };

    // Everything that belongs to the signed-in location goes (a shared device must never show the
    // previous coordinator's people or payments).
    const resetDashboard = () => {
        setToken(null);
        setMyLocation(null);
        setInscriptions([]);
        setSheetId(null);
        setLegacySelected([]);
        setLegacyPayIds(null);
        setTab('participants');
        feeHub.reset();
        setStep('login');
    };

    // Re-read the seat count after a registration (the list projection has no status, so it cannot
    // be derived client-side; the server counts non-cancelled inscriptions).
    const refreshMyLocation = async () => {
        try {
            const res = await fetch('/api/v1/plugin/conference-manager/portal/me', { credentials: 'include', headers: portalAuthHeaders() });
            if (res.ok) setMyLocation(await res.json());
        } catch { /* non-critical: the header keeps the last known count */ }
    };
    // What the conference turned on or off meanwhile («Escarapelas», «Pagos de cuotas»): re-read when the
    // coordinator comes back to the page (tab, window, phone, back button) and once a minute while it is on
    // screen, so a portal left open sees it without a reload. At most one read every 5 s.
    useEffect(() => {
        if (step !== 'dashboard') return undefined;
        let last = Date.now();
        const reread = () => {
            if (document.visibilityState !== 'visible' || Date.now() - last < 5000) return;
            last = Date.now();
            refreshMyLocation();
        };
        document.addEventListener('visibilitychange', reread);
        window.addEventListener('focus', reread);
        window.addEventListener('pageshow', reread);
        const timer = window.setInterval(reread, 60000);
        return () => {
            document.removeEventListener('visibilitychange', reread);
            window.removeEventListener('focus', reread);
            window.removeEventListener('pageshow', reread);
            window.clearInterval(timer);
        };
        // refreshMyLocation is a plain closure over the portal token.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step]);

    const loadInscriptions = async () => {
        try {
            const res = await fetch('/api/v1/plugin/conference-manager/portal/inscriptions', {
                credentials: 'include',
                headers: portalAuthHeaders()
            });
            if (res.ok) {
                const rows: Inscription[] = await res.json();
                setInscriptions(rows);
                setLegacySelected((sel) => pruneSelection(sel, rows.filter((r) => !isCancelled(r)).map((r) => Number(r.id))));
            }
        } catch (e) { console.error(e); }
        loadGroups();
    };

    // Existing groups (of the grouping field) for this location, with members — powers the group picker.
    const loadGroups = async () => {
        try {
            const res = await fetch('/api/v1/plugin/conference-manager/portal/groups', {
                credentials: 'include',
                headers: portalAuthHeaders()
            });
            if (res.ok) { const d = await res.json(); setGroups(d.groups || []); }
        } catch (e) { /* non-critical */ }
    };

    const handleCreateInscription = async (e: React.FormEvent) => {
        e.preventDefault();
        // «Condiciones de salud»: its errors are said under the field (never a browser bubble).
        const healthField = fields.find(isHealthField);
        if (healthField) {
            const err = healthAnswerError(healthField, formData[HEALTH_FIELD] || null);
            if (err) {
                setHealthError(err === 'other' ? 'Escribe cuál es la otra condición.' : 'Marca al menos una opción (o «Prefiero no responder»).');
                if (typeof document !== 'undefined') document.getElementById('cm-health-input')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                return;
            }
        }
        setHealthError(null);
        setLoading(true);
        try {
            const { [HEALTH_FIELD]: healthValue, ...rest } = formData;
            const res = await fetch('/api/v1/plugin/conference-manager/portal/inscriptions', {
                method: 'POST',
                headers: portalAuthHeaders({ 'Content-Type': 'application/json' }),
                // Strings only, trimmed, '' kept — the server canonicalises and runs the required checks. The health
                // answer travels as its own object.
                body: JSON.stringify({ ...formBody(rest), ...(healthField ? { [HEALTH_FIELD]: healthPayload(healthField, healthValue || null) } : {}) }),
                credentials: 'include'
            });
            if (res.ok) {
                // «Autorización de datos» (2.33.0): say where the consent link went (or that it did not).
                const made = await res.json().catch(() => ({}));
                const ct = consentT('es');
                if (made && made.consent) addToast(made.consent.sent ? ct('portal.registered', { email: made.consent.email_masked }) : ct('portal.registered.failed'), made.consent.sent ? 'success' : 'warning');
                else addToast('Inscripción creada correctamente', 'success');
                setView('list');
                // Reset form with initials
                setFormData(initialFormValues(fields));
                loadInscriptions();
                refreshMyLocation();
            } else {
                const err = await res.json().catch(() => ({}));
                addToast(err.error || 'Error', 'error');
                if (res.status === 409) refreshMyLocation(); // the location filled up under us
            }
        } catch {
            addToast('Error de conexión', 'error');
        } finally {
            setLoading(false);
        }
    };

    // A request answered 401 (the session expired or the access code changed): back to the login screen.
    const sessionExpired = () => {
        addToast('Tu sesión terminó. Vuelve a ingresar con el código de tu localidad.', 'warning');
        resetDashboard();
        loadConferences();
    };

    if (loading && !myLocation && step === 'dashboard') {
        return (
            <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
                <Spinner label="Cargando..." />
            </div>
        );
    }

    // === ERROR VIEW ===
    if (error) {
        return (
            <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
                <HeroCard tone="rose" className="w-full max-w-md text-center">
                    <div className="w-14 h-14 shrink-0 rounded-2xl bg-rose-500 text-white flex items-center justify-center text-2xl shadow-xl shadow-rose-200 mx-auto mb-5">
                        <i className="fa-solid fa-triangle-exclamation"></i>
                    </div>
                    <h1 className={cx("text-3xl", headingCls, "mb-2")}>Acceso No Disponible</h1>
                    <p className="text-sm text-gray-500 font-medium leading-relaxed mb-8">{error}</p>
                    <Button
                        block
                        size="lg"
                        onClick={() => { setError(null); window.history.pushState({}, '', window.location.pathname); loadConferences(); }}
                    >
                        Ver otras conferencias
                    </Button>
                </HeroCard>
            </div>
        );
    }

    // === LOGIN VIEW ===
    if (step === 'login') {
        return (
            <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
                <HeroCard tone="blue" className="w-full max-w-md">
                    <div className="flex items-center gap-4 mb-8">
                        <div className="w-14 h-14 rounded-2xl bg-blue-600 text-white flex items-center justify-center text-2xl shadow-xl shadow-blue-200 shrink-0">
                            <i className="fa-solid fa-map-marker-alt"></i>
                        </div>
                        <div className="min-w-0">
                            <h1 className={cx("text-2xl sm:text-3xl", headingCls)}>Portal de Localidades</h1>
                            <p className={cx(captionCls, "mt-1")}>Gestión de inscripciones</p>
                        </div>
                    </div>

                    <form {...feLogin.form(handleLogin)} className="space-y-5">
                        <Field error={feLogin.error('conference')} errorId={feLogin.errorId('conference')} label={<>
                            Conferencia
                            {isConferenceLocked && <i className="fa-solid fa-lock text-[9px] text-gray-400 ml-2" title="Conferencia pre-seleccionada"></i>}
                        </>}>
                            {(id) => (
                                <Select
                                    id={id}
                                    className={cx(selectCls, isConferenceLocked && 'cursor-not-allowed opacity-75')}
                                    value={selectedConference}
                                    onChange={e => setSelectedConference(e.target.value)}
                                    disabled={isConferenceLocked}
                                    required
                                    data-field="conference" aria-invalid={feLogin.invalid('conference')} aria-describedby={feLogin.describedBy('conference')}
                                >
                                    <option value="">Seleccione una conferencia</option>
                                    {conferences.map(c => (
                                        <option key={c.id} value={c.id}>{c.name}</option>
                                    ))}
                                </Select>
                            )}
                        </Field>

                        <Field label="Localidad" error={feLogin.error('location')} errorId={feLogin.errorId('location')}>
                            {(id) => (
                                <Select
                                    id={id}
                                    className={selectCls}
                                    value={selectedLocation}
                                    onChange={e => setSelectedLocation(e.target.value)}
                                    disabled={!selectedConference}
                                    required
                                    data-field="location" aria-invalid={feLogin.invalid('location')} aria-describedby={feLogin.describedBy('location')}
                                >
                                    <option value="">Seleccione su localidad</option>
                                    {locations.map(l => (
                                        <option key={l.id} value={l.id}>{l.name}</option>
                                    ))}
                                </Select>
                            )}
                        </Field>

                        <Field label="Código de Acceso" error={feLogin.error('code')} errorId={feLogin.errorId('code')}>
                            {(id) => (
                                <div className="relative">
                                    <input
                                        id={id}
                                        type="password"
                                        className={cx(inputBoldCls, "pl-11 tracking-[0.3em]")}
                                        placeholder="••••••"
                                        maxLength={6}
                                        value={code}
                                        onChange={e => setCode(e.target.value)}
                                        required
                                        data-field="code" aria-invalid={feLogin.invalid('code')} aria-describedby={feLogin.describedBy('code')}
                                    />
                                    <i className="fa-solid fa-lock absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-xs"></i>
                                </div>
                            )}
                        </Field>

                        <Button
                            type="submit"
                            block
                            size="lg"
                            icon="fa-arrow-right-to-bracket"
                            disabled={loading || !selectedLocation || !code}
                            className="mt-2"
                        >
                            {loading ? 'Verificando...' : 'Ingresar'}
                        </Button>
                    </form>
                </HeroCard>
            </div>
        );
    }

    // === DASHBOARD VIEW ===
    const paidCount = inscriptions.filter(i => !isCancelled(i) && i.payment_status === 'paid').length;
    // The caption counts what the hero counts: ACTIVE inscriptions, the cancelled ones apart (the admin's words).
    const cancelledCount = inscriptions.filter((i) => isCancelled(i)).length;
    const activeCount = inscriptions.length - cancelledCount;
    const locationFull = isLocationFull(myLocation);
    const methods = paymentMethodsOf(myLocation);
    // «Pagos de cuotas» only when the plugin has it (an older one keeps the bulk flow — version skew).
    const feesOn = hasFeePayments(myLocation);
    // «Escarapelas» (conference-manager ≥ 2.19.0): while the conference lets coordinators share them.
    const badgesOn = hasBadges(myLocation);
    const conferenceName = (conferences.find((c) => String(c.id) === String(selectedConference)) || { name: '' }).name || '';
    const activeTab = tab === 'fees' && !feesOn ? 'participants' : tab;
    const badge = feesOn ? feeBadge(myLocation?.fees) : null;
    const byId = new Map(inscriptions.map((i) => [Number(i.id), i]));
    const nameOf = (id: number) => { const p = byId.get(id); return p ? personName(p, listFields) : `#${id}`; };
    const familyGroups = familyGroupsOf(inscriptions, listFields);
    const sheetPerson = sheetId != null ? byId.get(sheetId) ?? null : null;
    const tabs: { key: 'participants' | 'fees' | 'lodging'; label: string; icon: string }[] = [
        { key: 'participants', label: 'Participantes', icon: 'fa-users' },
        ...(feesOn ? [{ key: 'fees' as const, label: 'Pagos de cuotas', icon: 'fa-file-invoice-dollar' }] : []),
        { key: 'lodging', label: 'Hospedajes', icon: 'fa-bed' },
    ];
    // A participant's «Registrar pago»: the new payment sheet on top of theirs, or (an older plugin) the old dialog.
    const payFor = (id: number) => {
        if (feesOn) { void feeHub.openRegister([id]); return; }
        const p = byId.get(id);
        setLegacyPayIds([id]);
        setLegacyAmount(p ? (rowBalanceC(p).toCover / 100).toFixed(2) : '');
    };
    const seePaymentsOf = (id: number) => {
        setSheetId(null);
        feeHub.setPersonFilter(id);
        feeHub.setSegment('transfers');
        setTab('fees');
    };
    return (
        <div className="min-h-screen bg-gray-50">
            {/* Slim sticky bar: product name + logout. The location identity lives in the hero below, as the admin dashboard. */}
            <header className="bg-white/90 backdrop-blur border-b border-gray-100 shadow-sm shadow-gray-100/50 sticky top-0 z-30 pt-[env(safe-area-inset-top)]">
                <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex justify-between items-center gap-4 py-2 sm:py-3">
                        <div className="flex items-center gap-3 min-w-0">
                            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center text-white text-sm shadow-lg shadow-blue-200 shrink-0">
                                <i className="fa-solid fa-map-marker-alt"></i>
                            </div>
                            <span className={cx(captionWideCls, "text-blue-600 truncate")}>Portal de Localidades</span>
                        </div>
                        <IconButton
                            icon="fa-right-from-bracket"
                            tone="rose"
                            onClick={logout}
                            title="Cerrar sesión"
                            aria-label="Cerrar sesión"
                            className="shrink-0"
                        />
                    </div>
                </div>
            </header>

            <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-8 space-y-5 sm:space-y-8 animate-in fade-in duration-500">
                {/* The admin ConferenceDashboard hero: tile + caption, black italic name, gray-50 pills (smaller on phones) */}
                <HeroCard tone="blue">
                    <div className="flex items-center gap-3 mb-2 sm:mb-3">
                        <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-200 shrink-0">
                            <i className="fa-solid fa-map-marker-alt"></i>
                        </div>
                        <span className={cx(captionWideCls, "text-blue-600 truncate")}>{myLocation?.responsible_name}</span>
                    </div>
                    <h1 className={cx("text-2xl sm:text-4xl mb-3 break-words", headingCls)}>{myLocation?.name}</h1>
                    <div className="flex flex-wrap items-center gap-2 sm:gap-4">
                        <div className="flex items-center gap-2 bg-gray-50 px-3 py-1.5 rounded-full border border-gray-100" data-testid="portal-seats">
                            <i className={cx("fa-solid fa-users text-xs text-center w-4", locationFull ? "text-rose-500" : "text-emerald-500")}></i>
                            <span className={cx("text-xs font-bold", locationFull ? "text-rose-600" : "text-gray-600")}>
                                {seatsLabel(myLocation)}{locationFull ? ' · Cupo lleno' : ''}
                            </span>
                        </div>
                        {methods.length > 0 && (
                            <div className="flex items-center gap-2 bg-gray-50 px-3 py-1.5 rounded-full border border-gray-100">
                                <i className="fa-solid fa-money-bill-wave text-xs text-blue-500 text-center w-4"></i>
                                <span className="text-xs font-bold text-gray-600">{methods.join(' · ')}</span>
                            </div>
                        )}
                    </div>
                </HeroCard>

                {/* Tabs: Participantes | Pagos de cuotas (plugin ≥ 2.18.0) | Hospedajes. The money figures live in
                    «Pagos de cuotas › Resumen» (the old StatCards above the tabs counted cancelled people). */}
                {/* On a phone the tabs share the width in equal columns (icon over a label that may wrap), so all
                    three are always visible — no strip scrolling sideways; from 640 px, one row as before. */}
                <div className="grid grid-flow-col auto-cols-fr sm:flex border-b border-gray-200" role="tablist" data-testid="portal-tabs">
                    {tabs.map(({ key, label, icon }) => (
                        <button
                            key={key}
                            type="button"
                            role="tab"
                            aria-selected={activeTab === key}
                            onClick={() => setTab(key)}
                            className={`relative flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 px-1 sm:px-6 py-2 sm:py-0 min-h-14 sm:min-h-12 min-w-0 border-b-2 font-medium text-xs sm:text-sm leading-tight text-center transition-colors sm:whitespace-nowrap ${activeTab === key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
                            data-tab={key}
                        >
                            <i className={`fa-solid ${icon}`} aria-hidden="true"></i>
                            <span className="break-words">{label}</span>
                            {key === 'fees' && badge && <Badge tone={badge.tone} size="xs" className="whitespace-nowrap" data-testid="fees-badge">{badge.text}</Badge>}
                        </button>
                    ))}
                </div>

                {/* storageScope ties the lodging explorer's remembered hotel/room to THIS location, so a shared
                    device never reopens another coordinator's place. */}
                {activeTab === 'lodging' ? (
                    <Hospedajes authHeaders={portalAuthHeaders} onLocationRefresh={refreshMyLocation}
                        storageScope={myLocation ? `${myLocation.conference_id ?? ""}:${myLocation.id}` : undefined} />
                ) : activeTab === 'fees' ? (
                    <FeePaymentsTab hub={feeHub} nameOf={nameOf} groups={familyGroups} onOpenPerson={setSheetId} />
                ) : (
                <Card clip className="animate-in slide-in-from-bottom-4 duration-500">
                    <CardHeader
                        icon={view === 'list' ? 'fa-users' : 'fa-user-plus'}
                        title={view === 'list' ? 'Participantes' : 'Nueva Inscripción'}
                        caption={view === 'list' ? (
                            // Each fact whole, its «·» with it: on a phone the line breaks BETWEEN them, never leaving a
                            // separator alone at the end of a line.
                            <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5" data-testid="participants-caption">
                                <span className="whitespace-nowrap">{activeCount} {activeCount === 1 ? 'participante' : 'participantes'}</span>
                                <span className="whitespace-nowrap text-blue-500 font-black">· {paidCount} {paidCount === 1 ? 'pagado' : 'pagados'}</span>
                                {cancelledCount > 0 && <span className="whitespace-nowrap">· {cancelledCount === 1 ? '1 cancelada' : `${cancelledCount} canceladas`}</span>}
                            </span>
                        ) : undefined}
                        actions={view === 'list' ? (
                            <Button
                                icon="fa-plus"
                                block
                                className="sm:w-auto"
                                onClick={() => setView('add')}
                                disabled={isLocationFull(myLocation)}
                                title={isLocationFull(myLocation) ? 'La localidad ha alcanzado su cupo máximo.' : undefined}
                            >
                                Registrar Nuevo
                            </Button>
                        ) : (
                            <Button variant="ghost" icon="fa-arrow-left" onClick={() => setView('list')}>
                                Volver a la lista
                            </Button>
                        )}
                    />

                    {view === 'list' && badgesOn && inscriptions.length > 0 && (
                        <PortalBadgeBulk authHeaders={portalAuthHeaders} nameOf={nameOf} />
                    )}
                    {view === 'list' ? (
                        <ParticipantList
                            people={inscriptions}
                            fields={listFields}
                            onOpen={setSheetId}
                            openId={sheetId}
                            legacy={feesOn ? null : {
                                selected: legacySelected,
                                setSelected: setLegacySelected,
                                canPay: methods.length > 0,
                                onPay: (ids) => { setLegacyPayIds(ids); setLegacyAmount(''); },
                            }}
                        />
                    ) : (
                        <div className="p-6 sm:p-8">
                            {isLocationFull(myLocation) && (
                                <Notice tone="rose" icon="fa-circle-exclamation" className="max-w-2xl mx-auto mb-6">
                                    <span>La localidad ha alcanzado su cupo máximo ({seatsLabel(myLocation)}). No es posible registrar más participantes; contacta al administrador si necesitas ampliar el cupo.</span>
                                </Notice>
                            )}
                            <form {...fe.form(handleCreateInscription)} className="max-w-2xl mx-auto space-y-6">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                    {fields.length === 0 ? (
                                        <EmptyState
                                            icon="fa-triangle-exclamation"
                                            title="No hay campos configurados para este formulario."
                                            className="md:col-span-2"
                                        />
                                    ) : (
                                        fields.map((field) => (
                                            <Field
                                                key={field.name}
                                                error={fe.error(field.name)}
                                                errorId={fe.errorId(field.name)}
                                                className={field.width === 50 && !isHealthField(field) ? 'col-span-1' : 'md:col-span-2'}
                                                label={<>{field.label} {field.is_required ? <span className="text-rose-500">*</span> : ''}</>}
                                            >
                                                {(id) => isHealthField(field) ? (
                                                    // «Condiciones de salud» (2.32.0): write-only here — the portal never reads an answer back.
                                                    <HealthConditionsInput
                                                        id="cm-health-input"
                                                        field={field}
                                                        value={formData[field.name] || null}
                                                        onChange={(v) => { setFormData({ ...formData, [field.name]: v }); setHealthError(null); }}
                                                        error={healthError}
                                                    />
                                                ) : field.is_group ? (
                                                    <GroupPicker
                                                        id={id}
                                                        field={field}
                                                        value={formData[field.name] ?? ''}
                                                        onChange={(v: string) => setFormData({ ...formData, [field.name]: inputToFormValue(field, v) })}
                                                        groups={groups}
                                                        invalid={fe.invalid(field.name)}
                                                        describedBy={fe.describedBy(field.name)}
                                                    />
                                                ) : field.type === 'switch' ? (
                                                    // A Sí / No switch (2.31.0 — «Requiere hospedaje»).
                                                    <button
                                                        id={id}
                                                        type="button"
                                                        role="switch"
                                                        aria-checked={isSwitchOn(formData[field.name])}
                                                        data-cm-switch={field.name}
                                                        onClick={() => setFormData({ ...formData, [field.name]: isSwitchOn(formData[field.name]) ? SWITCH_OFF : SWITCH_ON })}
                                                        className="inline-flex items-center gap-3 min-h-[44px] py-1 text-sm font-semibold text-gray-800"
                                                    >
                                                        <span className={cx("relative inline-block w-11 h-6 rounded-full transition-colors", isSwitchOn(formData[field.name]) ? "bg-blue-600" : "bg-gray-300")} aria-hidden="true">
                                                            <span className={cx("absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform", isSwitchOn(formData[field.name]) ? "translate-x-5" : "")}></span>
                                                        </span>
                                                        {isSwitchOn(formData[field.name]) ? SWITCH_ON : SWITCH_OFF}
                                                    </button>
                                                ) : field.type === 'select' ? (
                                                    <Select
                                                        id={id}
                                                        required={!!field.is_required}
                                                        data-field={field.name} aria-invalid={fe.invalid(field.name)} aria-describedby={fe.describedBy(field.name)}
                                                        className={selectCls}
                                                        value={formData[field.name] ?? ''}
                                                        onChange={(e) => setFormData({ ...formData, [field.name]: inputToFormValue(field, e.target.value) })}
                                                    >
                                                        {fieldOptions(field).map((opt: string) => (
                                                            <option key={opt} value={opt}>{opt}</option>
                                                        ))}
                                                    </Select>
                                                ) : field.type === 'textarea' ? (
                                                    <textarea
                                                        id={id}
                                                        required={!!field.is_required}
                                                        data-field={field.name} aria-invalid={fe.invalid(field.name)} aria-describedby={fe.describedBy(field.name)}
                                                        className={cx(inputCls, "resize-none")}
                                                        rows={3}
                                                        value={formData[field.name] ?? ''}
                                                        onChange={(e) => setFormData({ ...formData, [field.name]: inputToFormValue(field, e.target.value) })}
                                                    />
                                                ) : isPhoneField(field) ? (
                                                    // 2.33.2: the country's calling code next to the number; E.164 is sent.
                                                    <PhoneInput id={id} dataField={field.name} label={field.label} lang="es" invalid={fe.invalid(field.name)} describedBy={fe.describedBy(field.name)}
                                                        defaultCountry={(conferences.find((c) => String(c.id) === String(myLocation?.conference_id ?? selectedConference)) || {}).phone_country}
                                                        selectClassName={inputCls} inputClassName={inputCls}
                                                        value={formData[field.name] ?? ''} onChange={(v) => setFormData({ ...formData, [field.name]: inputToFormValue(field, v) })} />
                                                ) : field.type === 'date' ? (
                                                    // The host's calendar (2.33.1) instead of the browser's.
                                                    <DateField id={id} dataField={field.name} required={!!field.is_required}
                                                        value={formData[field.name] ?? ''} onChange={(v) => setFormData({ ...formData, [field.name]: inputToFormValue(field, v) })} />
                                                ) : (
                                                    <input
                                                        id={id}
                                                        type={field.type}
                                                        required={!!field.is_required}
                                                        data-field={field.name} aria-invalid={fe.invalid(field.name)} aria-describedby={fe.describedBy(field.name)}
                                                        className={inputCls}
                                                        value={formData[field.name] ?? ''}
                                                        onChange={(e) => setFormData({ ...formData, [field.name]: inputToFormValue(field, e.target.value) })}
                                                    />
                                                )}
                                            </Field>
                                        ))
                                    )}
                                </div>

                                {fields.length > 0 && (
                                    <Notice tone="blue" icon="fa-receipt" data-testid="portal-quote">
                                        {quote ? (
                                            <>
                                                <div className="font-medium">Cuota estimada: <b className="text-gray-900">${fmtMoney(quote.total)}</b></div>
                                                <div className="text-xs text-blue-900/60 mt-0.5">Se calcula con las reglas de precio de la conferencia; el valor definitivo se fija al guardar.</div>
                                            </>
                                        ) : (
                                            <div className="text-blue-900/70">Cuota: se calculará al guardar.</div>
                                        )}
                                    </Notice>
                                )}

                                <div className="flex flex-wrap justify-end gap-3 pt-6 border-t border-gray-50">
                                    <Button variant="ghost" onClick={() => setView('list')}>
                                        Cancelar
                                    </Button>
                                    <Button type="submit" size="lg" disabled={loading || fields.length === 0}>
                                        Guardar Inscripción
                                    </Button>
                                </div>
                            </form>
                        </div>
                    )}
                </Card>
                )}
            </main>
            {sheetPerson && (
                <ParticipantSheet
                    person={sheetPerson}
                    fields={listFields}
                    onClose={() => { setSheetId(null); feeHub.clearNotice(); }}
                    notice={feeHub.sheet ? null : feeHub.notice}
                    feesOn={feesOn}
                    canRecord={methods.length > 0}
                    onPay={payFor}
                    onSeePayments={feesOn ? seePaymentsOf : undefined}
                    badges={badgesOn ? { authHeaders: portalAuthHeaders, conferenceName } : null}
                    consent={sheetPerson.consent ? { authHeaders: portalAuthHeaders, onChanged: loadInscriptions } : null}
                    payBusy={feeHub.preparing}
                />
            )}
            {feesOn && <FeeSheets hub={feeHub} nameOf={nameOf} groups={familyGroups} />}
            {!feesOn && legacyPayIds && (
                <LegacyBulkPayment
                    ids={legacyPayIds}
                    methods={methods}
                    defaultAmount={legacyAmount}
                    authHeaders={portalAuthHeaders}
                    notify={(m, t) => addToast(m, t)}
                    onClose={() => setLegacyPayIds(null)}
                    onDone={() => { setLegacyPayIds(null); setLegacySelected([]); loadInscriptions(); }}
                />
            )}
        </div>
    );
}

export default function LocationPortalPage() {
    return (
        <ToastProvider closeLabel="Cerrar">
            <LocationPortalContent />
        </ToastProvider>
    );
}
