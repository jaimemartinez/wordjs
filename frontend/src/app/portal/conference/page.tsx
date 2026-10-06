"use client";

import React, { useState, useEffect } from "react";
import { ToastProvider, useToast } from "@/contexts/ToastContext";
import { csrfHeaders } from "@/lib/csrf";
// Pure form helpers (seeding, string-only values, request body, money) — see form.ts for the contract
// with conference-manager: values travel as strings, the SERVER canonicalises numbers.
import { fieldOptions, fmtMoney, formBody, initialFormValues, inputToFormValue, isLocationFull, paymentMethodsOf, seatsLabel, type PortalField } from "./form";
// The Hospedajes tab (lodging per location): its own data flow, one GET /portal/lodging, mounted only while selected.
import Hospedajes from "./LodgingTab";
// Visual primitives shared with the conference-manager admin design language (see ui.tsx).
import { Button, Card, CardHeader, EmptyState, Field, HeroCard, IconButton, Modal, Notice, Spinner, captionCls, captionWideCls, checkboxCls, cx, headingCls, inputBoldCls, inputCls, selectCls, tdCls, thCls, trCls } from "./ui";
import { StatCard } from "@/components/ui/StatCard";
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
}

interface Inscription {
    id: number;
    first_name: string;
    last_name: string;
    gender: string;
    email: string;
    phone: string;
    status: string;
    payment_status: string;
    total_due: number;
    amount_paid: number;
}

// The registration form is the source of truth: attendee data lives in real columns named after each
// field (custom_data fallback for legacy rows). These read a field's value + build a display name —
// same helpers as the admin list so both views follow the form (no hardcoded person columns).
const fieldVal = (person: any, field: any) => {
    const v = person?.[field.name];
    if (v !== undefined && v !== null && v !== '') return v;
    const cd = person?.custom_data?.[field.name];
    return (cd !== undefined && cd !== null && cd !== '') ? cd : '';
};
const personDisplayName = (person: any, fields: any[]) => {
    const fl = fields || [];
    // Prefer the fields tagged with the name roles; fall back to the first 1-2 form fields.
    const named = ['first_name', 'last_name']
        .map((role) => fl.find((f: any) => f.role === role))
        .filter(Boolean)
        .map((f: any) => fieldVal(person, f))
        .filter((v: any) => v !== '' && v != null);
    const parts = named.length ? named : fl.map((f: any) => fieldVal(person, f)).filter((v: any) => v !== '' && v != null).slice(0, 2);
    const name = parts.join(' ').trim();
    return name || `#${person?.id ?? ''}`;
};

// Combobox for the GROUPING field: search/pick an existing group (with member preview) or create a
// new one. Module-level (never define a component inside a component — it steals input focus).
function GroupPicker({ field, value, onChange, groups, id }: any) {
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
    // Dashboard tab. The participants tab is the pre-existing UI, untouched; Hospedajes mounts on demand.
    const [tab, setTab] = useState<'participants' | 'lodging'>('participants');
    const [error, setError] = useState<string | null>(null);

    // Dynamic Form Data. Every value is a STRING (a blank number field is '' — never 0 — and the raw
    // input text is sent as-is; the plugin canonicalises "0030" → "30" and rejects non-numbers with 400).
    const [formData, setFormData] = useState<Record<string, string>>({});
    const [fields, setFields] = useState<PortalField[]>([]);
    const [groups, setGroups] = useState<any[]>([]);
    // Live fee quote for the form being filled (POST /public/quote). `null` = not available yet, or the
    // current values are not quotable (a 400 for an invalid number just hides the line until it is fixed).
    const [quote, setQuote] = useState<{ total: number } | null>(null);

    // Payment State
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    const [showPaymentModal, setShowPaymentModal] = useState(false);
    const [paymentForm, setPaymentForm] = useState({
        amount_per_person: '',
        method: 'Efectivo',
        reference: '',
        proof: ''
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
                    body: JSON.stringify({ conference_id: conferenceId, fields: formBody(formData) }),
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
        setToken(null);
        setMyLocation(null);
        setInscriptions([]);
        setSelectedIds([]);
        setStep('login');
        loadConferences();
    };

    // Re-read the seat count after a registration (the list projection has no status, so it cannot
    // be derived client-side; the server counts non-cancelled inscriptions).
    const refreshMyLocation = async () => {
        try {
            const res = await fetch('/api/v1/plugin/conference-manager/portal/me', { credentials: 'include', headers: portalAuthHeaders() });
            if (res.ok) setMyLocation(await res.json());
        } catch { /* non-critical: the header keeps the last known count */ }
    };

    const loadInscriptions = async () => {
        try {
            const res = await fetch('/api/v1/plugin/conference-manager/portal/inscriptions', {
                credentials: 'include',
                headers: portalAuthHeaders()
            });
            if (res.ok) setInscriptions(await res.json());
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
        setLoading(true);
        try {
            const res = await fetch('/api/v1/plugin/conference-manager/portal/inscriptions', {
                method: 'POST',
                headers: portalAuthHeaders({ 'Content-Type': 'application/json' }),
                // Strings only, trimmed, '' kept — the server canonicalises and runs the required checks.
                body: JSON.stringify(formBody(formData)),
                credentials: 'include'
            });
            if (res.ok) {
                addToast('Inscripción creada correctamente', 'success');
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

    const handleBulkPayment = async (e: React.FormEvent) => {
        e.preventDefault();
        if (selectedIds.length === 0) return;
        const amt = Number(paymentForm.amount_per_person);
        if (!Number.isFinite(amt) || amt <= 0) {
            addToast('El monto debe ser mayor que cero.', 'error');
            return;
        }
        if (!paymentForm.proof) {
            addToast('El comprobante es obligatorio.', 'error');
            return;
        }
        setLoading(true);
        try {
            const res = await fetch('/api/v1/plugin/conference-manager/portal/payments/bulk', {
                method: 'POST',
                headers: portalAuthHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    inscription_ids: selectedIds,
                    amount_per_person: amt,
                    method: paymentForm.method,
                    reference: paymentForm.reference,
                    proof: paymentForm.proof
                }),
                credentials: 'include'
            });

            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                // Report what actually applied — the backend now returns applied/skipped counts.
                const applied = data.applied ?? selectedIds.length;
                const skipped = data.skipped ?? 0;
                addToast(skipped > 0 ? `Se registraron ${applied} pagos (${skipped} omitidos) — pendientes de validación.` : 'Pagos registrados — pendientes de validación por un administrador.', skipped > 0 ? 'warning' : 'success');
                setShowPaymentModal(false);
                setSelectedIds([]);
                setPaymentForm({ amount_per_person: '', method: 'Efectivo', reference: '', proof: '' });
                loadInscriptions();
            } else {
                addToast(data.error || 'Error al procesar pagos', 'error');
            }
        } catch {
            addToast('Error de conexión', 'error');
        } finally {
            setLoading(false);
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        // Cap the receipt photo — the data URL is embedded in the JSON body (and stored per row).
        if (file.size > 1024 * 1024) {
            addToast('La imagen es demasiado grande (máx. 1 MB).', 'error');
            e.target.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onloadend = () => {
            setPaymentForm({ ...paymentForm, proof: reader.result as string });
        };
        reader.readAsDataURL(file);
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
                    <div className="w-14 h-14 rounded-2xl bg-rose-500 text-white flex items-center justify-center text-2xl shadow-xl shadow-rose-200 mx-auto mb-5">
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

                    <form onSubmit={handleLogin} className="space-y-5">
                        <Field label={<>
                            Conferencia
                            {isConferenceLocked && <i className="fa-solid fa-lock text-[9px] text-gray-400 ml-2" title="Conferencia pre-seleccionada"></i>}
                        </>}>
                            {(id) => (
                                <select
                                    id={id}
                                    className={cx(selectCls, isConferenceLocked && 'cursor-not-allowed opacity-75')}
                                    value={selectedConference}
                                    onChange={e => setSelectedConference(e.target.value)}
                                    disabled={isConferenceLocked}
                                    required
                                >
                                    <option value="">Seleccione una conferencia</option>
                                    {conferences.map(c => (
                                        <option key={c.id} value={c.id}>{c.name}</option>
                                    ))}
                                </select>
                            )}
                        </Field>

                        <Field label="Localidad">
                            {(id) => (
                                <select
                                    id={id}
                                    className={selectCls}
                                    value={selectedLocation}
                                    onChange={e => setSelectedLocation(e.target.value)}
                                    disabled={!selectedConference}
                                    required
                                >
                                    <option value="">Seleccione su localidad</option>
                                    {locations.map(l => (
                                        <option key={l.id} value={l.id}>{l.name}</option>
                                    ))}
                                </select>
                            )}
                        </Field>

                        <Field label="Código de Acceso">
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
    const paidCount = inscriptions.filter(i => i.payment_status === 'paid').length;
    const totalPaid = inscriptions.reduce((sum, i) => sum + (Number(i.amount_paid) || 0), 0);
    const totalPending = inscriptions.reduce((sum, i) => sum + ((Number(i.total_due) || 0) - (Number(i.amount_paid) || 0)), 0);
    const locationFull = isLocationFull(myLocation);
    const methods = paymentMethodsOf(myLocation);
    return (
        <div className="min-h-screen bg-gray-50">
            {/* Slim sticky bar: product name + logout. The location identity lives in the hero below, as the admin dashboard. */}
            <header className="bg-white/90 backdrop-blur border-b border-gray-100 shadow-sm shadow-gray-100/50 sticky top-0 z-30">
                <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex justify-between items-center gap-4 py-3">
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
                            title="Cerrar Sessión"
                            className="shrink-0"
                        />
                    </div>
                </div>
            </header>

            <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 animate-in fade-in duration-500">
                {/* The admin ConferenceDashboard hero: tile + caption, black italic name, gray-50 pills */}
                <HeroCard tone="blue">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-200 shrink-0">
                            <i className="fa-solid fa-map-marker-alt"></i>
                        </div>
                        <span className={cx(captionWideCls, "text-blue-600 truncate")}>{myLocation?.responsible_name}</span>
                    </div>
                    <h1 className={cx("text-3xl sm:text-4xl mb-3 break-words", headingCls)}>{myLocation?.name}</h1>
                    <div className="flex flex-wrap items-center gap-3 sm:gap-4">
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

                {/* Stats */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                    <StatCard icon="fa-users" label="Total Inscritos" value={inscriptions.length} color="blue" />
                    <StatCard icon="fa-sack-dollar" label="Total Recaudado" value={`$${fmtMoney(totalPaid)}`} color="green" />
                    <StatCard icon="fa-hourglass-half" label="Saldo Pendiente" value={`$${fmtMoney(totalPending)}`} color="red" />
                </div>

                {/* Tabs: Participantes (the original dashboard) | Hospedajes (lodging per location) */}
                <div className="flex border-b border-gray-200 overflow-x-auto" role="tablist" data-testid="portal-tabs">
                    {([['participants', 'Participantes', 'fa-users'], ['lodging', 'Hospedajes', 'fa-bed']] as const).map(([key, label, icon]) => (
                        <button
                            key={key}
                            type="button"
                            role="tab"
                            aria-selected={tab === key}
                            onClick={() => setTab(key)}
                            className={`flex items-center gap-2 px-6 py-3 border-b-2 font-medium text-sm transition-colors whitespace-nowrap ${tab === key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
                        >
                            <i className={`fa-solid ${icon}`}></i> {label}
                        </button>
                    ))}
                </div>

                {/* storageScope ties the lodging explorer's remembered hotel/room to THIS location, so a shared
                    device never reopens another coordinator's place. */}
                {tab === 'lodging' ? (
                    <Hospedajes authHeaders={portalAuthHeaders} onLocationRefresh={refreshMyLocation}
                        storageScope={myLocation ? `${myLocation.conference_id ?? ""}:${myLocation.id}` : undefined} />
                ) : (
                <Card className="animate-in slide-in-from-bottom-4 duration-500">
                    <CardHeader
                        icon={view === 'list' ? 'fa-users' : 'fa-user-plus'}
                        title={view === 'list' ? 'Participantes' : 'Nueva Inscripción'}
                        caption={view === 'list' ? (
                            <span className="inline-flex flex-wrap items-center gap-3">
                                <span>{inscriptions.length} {inscriptions.length === 1 ? 'participante' : 'participantes'}</span>
                                <span className="w-1 h-1 rounded-full bg-gray-200"></span>
                                <span className="text-blue-500 font-black">{paidCount} {paidCount === 1 ? 'pagado' : 'pagados'}</span>
                            </span>
                        ) : undefined}
                        actions={view === 'list' ? (
                            <>
                                {selectedIds.length > 0 && (
                                    <Button
                                        variant="success"
                                        icon="fa-file-invoice-dollar"
                                        onClick={() => {
                                            // Pre-fill amount if only one selected or just leave blank
                                            const defaultAmount = selectedIds.length === 1 ? (inscriptions.find(i => i.id === selectedIds[0])?.total_due || 0) - (inscriptions.find(i => i.id === selectedIds[0])?.amount_paid || 0) : '';
                                            const methods = paymentMethodsOf(myLocation);
                                            setPaymentForm(prev => ({ ...prev, amount_per_person: String(defaultAmount), method: methods.includes(prev.method) ? prev.method : (methods[0] || '') }));
                                            setShowPaymentModal(true);
                                        }}
                                        disabled={paymentMethodsOf(myLocation).length === 0}
                                        title={paymentMethodsOf(myLocation).length === 0 ? 'No hay formas de pago habilitadas para esta localidad.' : undefined}
                                        className="animate-in zoom-in duration-200"
                                    >
                                        Registrar Pago ({selectedIds.length})
                                    </Button>
                                )}
                                <Button
                                    icon="fa-plus"
                                    onClick={() => setView('add')}
                                    disabled={isLocationFull(myLocation)}
                                    title={isLocationFull(myLocation) ? 'La localidad ha alcanzado su cupo máximo.' : undefined}
                                >
                                    Registrar Nuevo
                                </Button>
                            </>
                        ) : (
                            <Button variant="ghost" icon="fa-arrow-left" onClick={() => setView('list')}>
                                Volver a la lista
                            </Button>
                        )}
                    />

                    {view === 'list' ? (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left border-collapse">
                                <thead>
                                    <tr className="bg-gray-50/50">
                                        <th scope="col" className={cx(thCls, "w-10 text-center")}>
                                            <input
                                                type="checkbox"
                                                aria-label="Seleccionar todos los participantes"
                                                checked={selectedIds.length === inscriptions.length && inscriptions.length > 0}
                                                onChange={(e) => {
                                                    if (e.target.checked) setSelectedIds(inscriptions.map(i => i.id));
                                                    else setSelectedIds([]);
                                                }}
                                                className={checkboxCls}
                                            />
                                        </th>
                                        <th scope="col" className={cx(thCls, "px-8")}>Participante</th>
                                        {fields.map((field) => (
                                            <th key={field.name} scope="col" className={thCls}>{field.label}</th>
                                        ))}
                                        <th scope="col" className={cx(thCls, "text-center")}>Pago</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-50">
                                    {inscriptions.length === 0 ? (
                                        <tr>
                                            <td colSpan={fields.length + 3} className="p-6">
                                                <EmptyState icon="fa-users" padding="sm" title="No hay participantes registrados en esta localidad." />
                                            </td>
                                        </tr>
                                    ) : (
                                        inscriptions.map(i => (
                                            <tr key={i.id} className={cx(trCls, selectedIds.includes(i.id) && 'bg-blue-50/50')}>
                                                <td className={cx(tdCls, "text-center")}>
                                                    <input
                                                        type="checkbox"
                                                        aria-label={`Seleccionar a ${personDisplayName(i, fields)}`}
                                                        checked={selectedIds.includes(i.id)}
                                                        onChange={(e) => {
                                                            if (e.target.checked) setSelectedIds([...selectedIds, i.id]);
                                                            else setSelectedIds(selectedIds.filter(id => id !== i.id));
                                                        }}
                                                        className={checkboxCls}
                                                    />
                                                </td>
                                                <td className="px-8 py-5 font-bold text-gray-900 group-hover/row:text-blue-700 transition-colors whitespace-nowrap">
                                                    {/* Display name follows the form — first 1-2 field values. */}
                                                    {personDisplayName(i, fields)}
                                                </td>
                                                {fields.map((field) => {
                                                    const v = String(fieldVal(i, field) || '');
                                                    return (
                                                        <td key={field.name} className={tdCls}>
                                                            <div className="text-gray-600 text-xs font-medium truncate max-w-[180px]">
                                                                {v !== '' ? v : <span className="text-gray-300 italic">-</span>}
                                                            </div>
                                                        </td>
                                                    );
                                                })}
                                                <td className={tdCls}>
                                                    <div className="flex flex-col items-center gap-1">
                                                        <span className={`px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest whitespace-nowrap ${i.payment_status === 'paid' ? 'bg-emerald-50 text-emerald-600' :
                                                            i.payment_status === 'partial' ? 'bg-amber-50 text-amber-600' : 'bg-rose-50 text-rose-600'
                                                            }`}>
                                                            {i.payment_status === 'unpaid' ? 'Sin Pagar' : (i.payment_status === 'paid' ? 'Pagado' : 'Abono')}
                                                        </span>
                                                        <div className="text-[10px] text-gray-400 font-bold whitespace-nowrap">
                                                            PAGADO: <span className="text-gray-900">${fmtMoney(i.amount_paid)}</span> / <span className="text-gray-400">${fmtMoney(i.total_due)}</span>
                                                        </div>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className="p-6 sm:p-8">
                            {isLocationFull(myLocation) && (
                                <Notice tone="rose" icon="fa-circle-exclamation" className="max-w-2xl mx-auto mb-6">
                                    <span>La localidad ha alcanzado su cupo máximo ({seatsLabel(myLocation)}). No es posible registrar más participantes; contacta al administrador si necesitas ampliar el cupo.</span>
                                </Notice>
                            )}
                            <form onSubmit={handleCreateInscription} className="max-w-2xl mx-auto space-y-6">
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
                                                className={field.width === 50 ? 'col-span-1' : 'md:col-span-2'}
                                                label={<>{field.label} {field.is_required ? <span className="text-rose-500">*</span> : ''}</>}
                                            >
                                                {(id) => field.is_group ? (
                                                    <GroupPicker
                                                        id={id}
                                                        field={field}
                                                        value={formData[field.name] ?? ''}
                                                        onChange={(v: string) => setFormData({ ...formData, [field.name]: inputToFormValue(field, v) })}
                                                        groups={groups}
                                                    />
                                                ) : field.type === 'select' ? (
                                                    <select
                                                        id={id}
                                                        required={!!field.is_required}
                                                        className={selectCls}
                                                        value={formData[field.name] ?? ''}
                                                        onChange={(e) => setFormData({ ...formData, [field.name]: inputToFormValue(field, e.target.value) })}
                                                    >
                                                        {fieldOptions(field).map((opt: string) => (
                                                            <option key={opt} value={opt}>{opt}</option>
                                                        ))}
                                                    </select>
                                                ) : field.type === 'textarea' ? (
                                                    <textarea
                                                        id={id}
                                                        required={!!field.is_required}
                                                        className={cx(inputCls, "resize-none")}
                                                        rows={3}
                                                        value={formData[field.name] ?? ''}
                                                        onChange={(e) => setFormData({ ...formData, [field.name]: inputToFormValue(field, e.target.value) })}
                                                    />
                                                ) : (
                                                    <input
                                                        id={id}
                                                        type={field.type}
                                                        required={!!field.is_required}
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
            {showPaymentModal && (
                <Modal
                    title="Registrar Pago Grupal"
                    subtitle={`Se aplicará a ${selectedIds.length} personas seleccionadas`}
                    onClose={() => setShowPaymentModal(false)}
                    footer={(
                        <>
                            <Button variant="ghost" onClick={() => setShowPaymentModal(false)}>
                                Cancelar
                            </Button>
                            <Button
                                type="submit"
                                form="bulk-payment-form"
                                size="lg"
                                disabled={loading || !paymentForm.amount_per_person || !paymentForm.proof}
                            >
                                {loading ? 'Procesando...' : 'Confirmar Pago'}
                            </Button>
                        </>
                    )}
                >
                    <form id="bulk-payment-form" onSubmit={handleBulkPayment} className="space-y-5">
                        <Field label="Monto por Persona">
                            {(id) => (
                                <div className="relative">
                                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 font-bold">$</span>
                                    <input
                                        id={id}
                                        required
                                        type="number"
                                        min="0"
                                        step="any"
                                        className={cx(inputBoldCls, "pl-10")}
                                        value={paymentForm.amount_per_person}
                                        onChange={e => setPaymentForm({ ...paymentForm, amount_per_person: e.target.value })}
                                        placeholder="0.00"
                                    />
                                </div>
                            )}
                        </Field>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <Field label="Método">
                                {(id) => (
                                    <>
                                        <select
                                            id={id}
                                            className={selectCls}
                                            value={paymentForm.method}
                                            onChange={e => setPaymentForm({ ...paymentForm, method: e.target.value })}
                                        >
                                            {paymentMethodsOf(myLocation).map(m => <option key={m} value={m}>{m}</option>)}
                                        </select>
                                        {paymentMethodsOf(myLocation).length === 0 && (
                                            <p className="text-xs text-rose-600 font-medium ml-1">No hay formas de pago habilitadas para esta localidad; contacta al administrador.</p>
                                        )}
                                    </>
                                )}
                            </Field>
                            <Field label="Referencia (Opcional)">
                                {(id) => (
                                    <input
                                        id={id}
                                        className={inputCls}
                                        value={paymentForm.reference}
                                        onChange={e => setPaymentForm({ ...paymentForm, reference: e.target.value })}
                                        placeholder="# Recibo / Trans"
                                    />
                                )}
                            </Field>
                        </div>

                        <Field label={<>Comprobante de Pago <span className="text-rose-500">*</span></>}>
                            {(id) => (
                                <>
                                    <div className="border-2 border-dashed border-gray-200 rounded-2xl p-4 bg-gray-50/30 transition-colors hover:border-blue-400 focus-within:border-blue-500 relative overflow-hidden group">
                                        <input
                                            id={id}
                                            type="file"
                                            accept="image/*"
                                            aria-label="Adjuntar foto del comprobante"
                                            onChange={handleFileChange}
                                            className="absolute inset-0 opacity-0 cursor-pointer z-10"
                                        />
                                        {paymentForm.proof ? (
                                            <div className="flex items-center gap-3">
                                                <img src={paymentForm.proof} alt="Comprobante de pago" className="w-14 h-14 rounded-xl object-cover border border-gray-200 shadow-sm" />
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-xs font-bold text-blue-600 truncate">Imagen cargada correctamente</p>
                                                    <p className="text-[10px] text-gray-400 italic">Haz clic para cambiar</p>
                                                </div>
                                                <button type="button" onClick={() => setPaymentForm({ ...paymentForm, proof: '' })} title="Quitar comprobante" aria-label="Quitar comprobante" className="relative z-20 w-9 h-9 flex items-center justify-center rounded-xl bg-white text-rose-500 hover:bg-rose-600 hover:text-white transition-all shadow-sm border border-rose-100">
                                                    <i className="fa-solid fa-trash-can text-xs"></i>
                                                </button>
                                            </div>
                                        ) : (
                                            <div className="text-center py-2">
                                                <i className="fa-solid fa-cloud-arrow-up text-gray-300 text-2xl mb-2 group-hover:text-blue-400 transition-colors"></i>
                                                <p className="text-xs text-gray-500 font-bold">Adjuntar foto del comprobante</p>
                                            </div>
                                        )}
                                    </div>
                                    <p className="text-[10px] text-gray-400 italic ml-1">Obligatorio. El pago quedará <b>pendiente de validación</b> por un administrador.</p>
                                </>
                            )}
                        </Field>
                    </form>
                </Modal>
            )}
        </div>
    );
}

export default function LocationPortalPage() {
    return (
        <ToastProvider>
            <LocationPortalContent />
        </ToastProvider>
    );
}
