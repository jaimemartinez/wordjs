"use client";

/**
 * «Mi inscripción» (conference-manager 2.23.0) — the page a registrant's badge QR opens:
 * /portal/conference/yo#c=<registration code>. The code is read from the FRAGMENT (no request ever carries it).
 * The person confirms their identity document (type and number, as registered); the plugin then answers their
 * own registration — badge, answers, meals delivered (and when) and to come, hotel, room and a map —
 * and a session token this phone keeps (localStorage) so the document is not asked again here, until it expires
 * or they leave. Nothing personal is rendered on the server; the layout marks the page noindex / no-referrer.
 */
import React, { useCallback, useEffect, useState } from "react";
import { csrfHeaders } from "@/lib/csrf";
import { BadgeCard, type DisplayList } from "../badge/BadgeCard";
import { OsmMap } from "./OsmMap";
import { BusAlerts, dropPushSubscription, type Bus } from "./BusAlerts";

type Meal = { date: string; meal: string; label: string | null; start_time: string | null; end_time: string | null; delivered_at?: string | null };
type View = {
    name: string; conference: string; location: string | null; code: string;
    answers: { label: string; value: string }[];
    meals: { delivered: Meal[]; pending: Meal[] };
    lodging: { hotel: string; room: string; address: string | null; lat: number | null; lng: number | null } | null;
    badge: { badge: DisplayList; plate: string | null; images?: Record<string, string> } | null;
    transport?: Bus[];
    push_key?: string | null;
    expires_on: string | null;
};
type Form = { code: string; fromLink: boolean; conference: string | null; docTypes: string[] | null; needsType: boolean; numberLabel: string };
type State =
    | { kind: "loading" }
    | { kind: "form"; form: Form; error: string }
    | { kind: "ok"; view: View; session: string }
    | { kind: "error"; code: string; message: string };

const API = "/api/v1/plugin/conference-manager/public/me";
const STORE = "cm-mi-inscripcion";
const ERRORS: Record<string, [string, string]> = {
    disabled: ["Página no disponible", "Los organizadores no han activado esta página para el evento."],
    inactive: ["Inscripción no activa", "Esta inscripción fue cancelada. Si es un error, comunícate con los organizadores."],
    expired: ["Evento terminado", "La información de este evento ya no está disponible."],
    nodoc: ["Falta tu documento", "Tu inscripción no tiene número de documento registrado. Pide ayuda a los organizadores."],
    network: ["No se pudo cargar", "Revisa tu conexión e inténtalo de nuevo."],
    unavailable: ["No disponible todavía", "Esta página no está disponible en este momento. Inténtalo más tarde."],
};
const MEAL_NAMES: Record<string, string> = { desayuno: "Desayuno", almuerzo: "Almuerzo", cena: "Cena" };

const codeFromHash = (): string => {
    if (typeof window === "undefined") return "";
    const m = /(?:^#|&)c=([A-Za-z0-9]{10})(?:&|$)/.exec(window.location.hash || "");
    return m ? m[1].toUpperCase() : "";
};
type Stored = { session: string; code: string };
const readStored = (): Stored | null => {
    try {
        const v = JSON.parse(localStorage.getItem(STORE) || "null");
        return v && typeof v.session === "string" && /^[0-9a-f]{32}$/.test(v.session) && typeof v.code === "string" ? v : null;
    } catch { return null; }
};
const writeStored = (v: Stored | null) => {
    try { if (v) localStorage.setItem(STORE, JSON.stringify(v)); else localStorage.removeItem(STORE); } catch { /* private mode: asked again next time */ }
};
async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${API}/${path}`, {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

// Dates: a service day is a bare 'YYYY-MM-DD' (no time zone); a delivery is an instant shown in the phone's zone.
const dayLabel = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    try { return new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long" }).format(new Date(y, m - 1, day)); } catch { return d; }
};
const whenLabel = (iso: string | null | undefined) => {
    if (!iso) return "";
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return "";
    try { return new Intl.DateTimeFormat("es", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(t); } catch { return t.toLocaleString(); }
};
const mealName = (m: Meal) => m.label || MEAL_NAMES[m.meal] || m.meal;

export default function MyRegistrationPage() {
    const [state, setState] = useState<State>({ kind: "loading" });
    const [busy, setBusy] = useState(false);
    const [docType, setDocType] = useState("");
    const [docNumber, setDocNumber] = useState("");
    const [remember, setRemember] = useState(true);
    const [note, setNote] = useState("");

    const startWith = useCallback(async (code: string, fromLink: boolean) => {
        const empty: Form = { code, fromLink, conference: null, docTypes: null, needsType: false, numberLabel: "Número de documento" };
        if (!code) { setState({ kind: "form", form: { ...empty, fromLink: false }, error: "" }); return; }
        try {
            const r = await post("start", { code });
            if (r.status === 200) {
                setState({ kind: "form", form: { ...empty, conference: r.body.conference || null, docTypes: r.body.doc_types || null, needsType: !!r.body.needs_type, numberLabel: r.body.number_label || empty.numberLabel }, error: "" });
            } else if (r.status === 401 || r.status === 429) {
                setState({ kind: "form", form: { ...empty, fromLink: false }, error: r.body.error || "Revisa el código." });
            } else if (r.status >= 500) setState({ kind: "error", code: "network", message: "" });
            else setState({ kind: "error", code: r.body.code || "unavailable", message: r.body.error || "" });
        } catch { setState({ kind: "error", code: "network", message: "" }); }
    }, []);

    const boot = useCallback(async () => {
        setState({ kind: "loading" });
        const fromHash = codeFromHash();
        const stored = readStored();
        // This phone already confirmed a document: reopen it — unless the QR just scanned is someone else's.
        if (stored && (!fromHash || fromHash === stored.code)) {
            try {
                const r = await post("view", { session: stored.session });
                if (r.status === 200 && r.body.view) { setState({ kind: "ok", view: r.body.view, session: stored.session }); return; }
                if (r.status === 401) writeStored(null);
                else if (r.status >= 500) { setState({ kind: "error", code: "network", message: "" }); return; }
                else { writeStored(null); setState({ kind: "error", code: r.body.code || "unavailable", message: r.body.error || "" }); return; }
            } catch { setState({ kind: "error", code: "network", message: "" }); return; }
        }
        await startWith(fromHash || "", !!fromHash);
    }, [startWith]);

    useEffect(() => {
        boot();
        const onHash = () => boot();
        window.addEventListener("hashchange", onHash);
        return () => window.removeEventListener("hashchange", onHash);
    }, [boot]);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (state.kind !== "form" || busy) return;
        const { form } = state;
        const code = form.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!form.conference) {
            // Typed by hand: first learn which document this code's event asks for.
            setBusy(true);
            try { await startWith(code, false); } finally { setBusy(false); }
            return;
        }
        if (!docNumber.trim() || (form.needsType && !docType)) { setState({ ...state, error: "Completa tu tipo y número de documento." }); return; }
        setBusy(true);
        try {
            const r = await post("verify", { code, doc_type: docType, doc_number: docNumber });
            if (r.status === 200 && r.body.session) {
                if (remember) writeStored({ session: r.body.session, code }); else writeStored(null);
                setDocNumber("");
                setState({ kind: "ok", view: r.body.view, session: r.body.session });
            } else if (r.status === 401 || r.status === 429) setState({ ...state, error: r.body.error || "Los datos no coinciden." });
            else if (r.status >= 500) setState({ ...state, error: "No se pudo comprobar. Revisa tu conexión e inténtalo de nuevo." });
            else setState({ kind: "error", code: r.body.code || "unavailable", message: r.body.error || "" });
        } catch { setState({ ...state, error: "No se pudo comprobar. Revisa tu conexión e inténtalo de nuevo." }); }
        finally { setBusy(false); }
    };

    const leave = async () => {
        if (state.kind !== "ok") return;
        const session = state.session;
        writeStored(null);
        dropPushSubscription();
        post("logout", { session }).catch(() => { /* gone on this phone anyway */ });
        setDocType(""); setDocNumber(""); setNote("");
        await startWith(state.view.code, true);
    };
    const downloadPdf = async () => {
        if (state.kind !== "ok" || busy) return;
        setBusy(true); setNote("");
        try {
            const r = await post("ticket", { session: state.session });
            if (r.status !== 200 || !r.body.d) { setNote(r.body.error || "No se pudo preparar el PDF."); return; }
            window.location.href = `/portal/conference/badge/file?d=${encodeURIComponent(r.body.d)}`;
        } catch { setNote("No se pudo preparar el PDF. Revisa tu conexión."); }
        finally { setBusy(false); }
    };

    if (state.kind === "loading") {
        return (
            <main className="min-h-dvh bg-gray-50 flex items-center justify-center p-6" data-self-page="loading">
                <div className="text-gray-400 text-xs font-black uppercase tracking-widest"><i className="fa-solid fa-spinner animate-spin mr-2" aria-hidden="true"></i>Cargando…</div>
            </main>
        );
    }
    if (state.kind === "error") {
        const [title, text] = ERRORS[state.code] || ERRORS.unavailable;
        return (
            <main className="min-h-dvh bg-gray-50 flex items-center justify-center p-6" data-self-page="error" data-self-error={state.code}>
                <div className="max-w-sm w-full bg-white rounded-3xl border border-gray-100 shadow-sm p-8 text-center space-y-3">
                    <div className="w-14 h-14 shrink-0 mx-auto rounded-2xl bg-gray-100 text-gray-400 flex items-center justify-center text-2xl"><i className="fa-solid fa-id-card" aria-hidden="true"></i></div>
                    <h1 className="text-xl font-black text-gray-900">{title}</h1>
                    <p className="text-sm text-gray-600">{text}</p>
                    {state.code === "network" && <button type="button" onClick={boot} className="min-h-[44px] px-5 rounded-2xl bg-gray-900 text-white font-black text-[11px] uppercase tracking-widest">Reintentar</button>}
                </div>
            </main>
        );
    }

    const input = "w-full min-h-[48px] rounded-2xl border-2 border-gray-200 bg-white px-4 text-base font-bold text-gray-900 outline-none focus:border-blue-500";
    if (state.kind === "form") {
        const { form, error } = state;
        return (
            <main className="min-h-dvh bg-gray-100 px-4 py-8 sm:py-14" data-self-page="form">
                <form onSubmit={submit} className="mx-auto w-full max-w-sm bg-white rounded-3xl border border-gray-100 shadow-sm p-6 sm:p-8 space-y-5" noValidate>
                    <div className="text-center space-y-1">
                        <div className="w-14 h-14 shrink-0 mx-auto rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center text-2xl"><i className="fa-solid fa-id-card" aria-hidden="true"></i></div>
                        <h1 className="text-xl font-black text-gray-900">Mi inscripción</h1>
                        {form.conference && <p className="text-[11px] font-black uppercase tracking-widest text-gray-500">{form.conference}</p>}
                        <p className="text-sm text-gray-600">{form.conference ? "Para ver tu información, confirma tu documento." : "Escribe el código de tu escarapela."}</p>
                    </div>
                    {form.fromLink && form.conference ? (
                        <p className="text-center text-xs text-gray-500">Código <span className="font-mono font-black text-gray-800 tracking-widest">{form.code}</span></p>
                    ) : (
                        <div>
                            <label htmlFor="self-code" className="block text-[11px] font-black uppercase tracking-widest text-gray-500 mb-1">Código de la escarapela</label>
                            <input id="self-code" className={`${input} font-mono tracking-widest uppercase`} value={form.code} maxLength={14} autoComplete="off" autoCapitalize="characters" spellCheck={false}
                                onChange={(e) => setState({ kind: "form", form: { ...form, code: e.target.value, conference: null }, error: "" })} />
                        </div>
                    )}
                    {form.conference && form.needsType && (
                        <div>
                            <label htmlFor="self-type" className="block text-[11px] font-black uppercase tracking-widest text-gray-500 mb-1">Tipo de documento</label>
                            <select id="self-type" className={input} value={docType} onChange={(e) => setDocType(e.target.value)} required>
                                <option value="">Elige…</option>
                                {(form.docTypes || []).map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                        </div>
                    )}
                    {form.conference && (
                        <div>
                            <label htmlFor="self-number" className="block text-[11px] font-black uppercase tracking-widest text-gray-500 mb-1">{form.numberLabel}</label>
                            <input id="self-number" className={input} value={docNumber} onChange={(e) => setDocNumber(e.target.value)} autoComplete="off" inputMode="text" required />
                        </div>
                    )}
                    {form.conference && (
                        <label className="flex items-start gap-2 text-sm text-gray-700">
                            <input type="checkbox" className="mt-1 w-4 h-4 accent-blue-600" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                            <span>Recordar en este teléfono <span className="block text-[11px] text-gray-500">No lo marques si el teléfono no es tuyo.</span></span>
                        </label>
                    )}
                    {error && <p className="text-sm font-bold text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2" role="alert">{error}</p>}
                    <button type="submit" disabled={busy} className="w-full min-h-[52px] rounded-2xl bg-gray-900 text-white font-black text-xs uppercase tracking-widest disabled:opacity-60" data-self-submit="">
                        {busy ? <i className="fa-solid fa-spinner animate-spin" aria-hidden="true"></i> : form.conference ? "Ver mi información" : "Continuar"}
                    </button>
                    <p className="text-center text-[10px] text-gray-400">Tus datos solo se muestran a quien tenga tu escarapela y tu documento.</p>
                </form>
            </main>
        );
    }

    const { view } = state;
    const section = "bg-white rounded-3xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-3";
    const h2 = "text-[11px] font-black uppercase tracking-widest text-gray-500 flex items-center gap-2";
    const lodging = view.lodging;
    const geo = lodging && lodging.lat != null && lodging.lng != null ? `${lodging.lat},${lodging.lng}` : null;
    return (
        <main className="min-h-dvh bg-gray-100 px-4 py-6 sm:py-10" data-self-page="ok">
            <div className="mx-auto w-full max-w-md space-y-4">
                <header className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-[11px] font-black uppercase tracking-widest text-gray-500">{view.conference}</p>
                        <h1 className="text-2xl font-black text-gray-900 leading-tight" style={{ overflowWrap: "anywhere" }}>{view.name}</h1>
                        {view.location && <p className="text-sm text-gray-600"><i className="fa-solid fa-location-dot mr-1 text-gray-400" aria-hidden="true"></i>{view.location}</p>}
                    </div>
                    <button type="button" onClick={leave} className="shrink-0 min-h-[40px] px-3 rounded-xl bg-white border-2 border-gray-200 text-gray-700 font-black text-[10px] uppercase tracking-widest" data-self-leave="">Salir</button>
                </header>

                {view.transport && view.transport.length > 0 && (
                    <BusAlerts session={state.session} initial={view.transport} pushKey={view.push_key || null} post={post} code={view.code} />
                )}

                {view.badge && (
                    <section className={section} data-self-badge="">
                        <h2 className={h2}><i className="fa-solid fa-id-badge" aria-hidden="true"></i>Mi escarapela</h2>
                        <div className={`mx-auto ${view.badge.badge.layout === "vertical" ? "max-w-[260px]" : ""} rounded-[14px] overflow-hidden shadow-lg ring-1 ring-black/5 bg-white`}>
                            <BadgeCard badge={view.badge.badge} plate={view.badge.plate} images={view.badge.images || null} title={`Escarapela de ${view.name}`} />
                        </div>
                        <button type="button" onClick={downloadPdf} disabled={busy} className="w-full min-h-[44px] rounded-2xl bg-white border-2 border-gray-200 text-gray-800 font-black text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 disabled:opacity-60" data-self-pdf="">
                            <i className={`fa-solid ${busy ? "fa-spinner animate-spin" : "fa-file-pdf"}`} aria-hidden="true"></i>Descargar PDF
                        </button>
                        {note && <p className="text-center text-xs font-bold text-gray-600" role="status">{note}</p>}
                    </section>
                )}

                <section className={section} data-self-meals="">
                    <h2 className={h2}><i className="fa-solid fa-utensils" aria-hidden="true"></i>Mis comidas</h2>
                    {!view.meals.delivered.length && !view.meals.pending.length && <p className="text-sm text-gray-500">No tienes comidas asignadas.</p>}
                    {view.meals.delivered.length > 0 && (
                        <ul className="space-y-2" aria-label="Entregadas">
                            {view.meals.delivered.map((m, i) => (
                                <li key={`d${i}`} className="flex items-start gap-3 rounded-2xl bg-emerald-50 border border-emerald-100 px-3 py-2.5" data-meal-delivered="">
                                    <i className="fa-solid fa-circle-check text-emerald-600 mt-0.5" aria-hidden="true"></i>
                                    <div className="min-w-0">
                                        <p className="text-sm font-black text-gray-900">{mealName(m)} <span className="font-medium text-gray-600">· {dayLabel(m.date)}</span></p>
                                        <p className="text-xs text-emerald-800">Entregado {whenLabel(m.delivered_at)}</p>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                    {view.meals.pending.length > 0 && (
                        <>
                            <p className="text-[11px] font-black uppercase tracking-widest text-gray-400 pt-1">Por recibir</p>
                            <ul className="space-y-2" aria-label="Por recibir">
                                {view.meals.pending.map((m, i) => (
                                    <li key={`p${i}`} className="flex items-start gap-3 rounded-2xl bg-gray-50 border border-gray-100 px-3 py-2.5" data-meal-pending="">
                                        <i className="fa-regular fa-clock text-gray-400 mt-0.5" aria-hidden="true"></i>
                                        <p className="text-sm text-gray-800"><span className="font-black">{mealName(m)}</span> · {dayLabel(m.date)}{m.start_time ? ` · ${m.start_time}${m.end_time ? `–${m.end_time}` : ""}` : ""}</p>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </section>

                <section className={section} data-self-lodging="">
                    <h2 className={h2}><i className="fa-solid fa-bed" aria-hidden="true"></i>Mi alojamiento</h2>
                    {!lodging ? (
                        <p className="text-sm text-gray-500">Aún no tienes habitación asignada.</p>
                    ) : (
                        <>
                            <div className="grid grid-cols-2 gap-2">
                                <div className="rounded-2xl bg-gray-50 border border-gray-100 px-3 py-2.5 min-w-0">
                                    <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Hotel</p>
                                    <p className="text-sm font-black text-gray-900" style={{ overflowWrap: "anywhere" }}>{lodging.hotel}</p>
                                </div>
                                <div className="rounded-2xl bg-gray-50 border border-gray-100 px-3 py-2.5 min-w-0">
                                    <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Habitación</p>
                                    <p className="text-sm font-black text-gray-900" style={{ overflowWrap: "anywhere" }}>{lodging.room}</p>
                                </div>
                            </div>
                            {lodging.address && <p className="text-sm text-gray-700"><i className="fa-solid fa-location-dot mr-1 text-gray-400" aria-hidden="true"></i>{lodging.address}</p>}
                            {geo && lodging.lat != null && lodging.lng != null && (
                                <>
                                    <OsmMap lat={lodging.lat} lng={lodging.lng} label={`Mapa con la ubicación de ${lodging.hotel}`} />
                                    <div className="grid grid-cols-2 gap-2">
                                        <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(geo)}`} target="_blank" rel="noopener noreferrer"
                                            className="min-h-[44px] rounded-2xl bg-gray-900 text-white font-black text-[11px] uppercase tracking-widest flex items-center justify-center gap-2" data-self-directions="">
                                            <i className="fa-solid fa-route" aria-hidden="true"></i>Cómo llegar
                                        </a>
                                        <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(geo)}`} target="_blank" rel="noopener noreferrer"
                                            className="min-h-[44px] rounded-2xl bg-white border-2 border-gray-200 text-gray-800 font-black text-[11px] uppercase tracking-widest flex items-center justify-center gap-2">
                                            <i className="fa-solid fa-map" aria-hidden="true"></i>Google Maps
                                        </a>
                                    </div>
                                </>
                            )}
                        </>
                    )}
                </section>

                {view.answers.length > 0 && (
                    <section className={section} data-self-answers="">
                        <h2 className={h2}><i className="fa-solid fa-user" aria-hidden="true"></i>Mis datos</h2>
                        <dl className="divide-y divide-gray-100">
                            {view.answers.map((a, i) => (
                                <div key={i} className="py-2 flex flex-wrap justify-between gap-x-3">
                                    <dt className="text-xs font-bold text-gray-500">{a.label}</dt>
                                    <dd className="text-sm font-bold text-gray-900 text-right" style={{ overflowWrap: "anywhere" }}>{a.value}</dd>
                                </div>
                            ))}
                        </dl>
                        <p className="text-[11px] text-gray-500">Si algo está mal, avísale al encargado de tu localidad.</p>
                    </section>
                )}

                <p className="text-center text-[10px] text-gray-400 pb-4">Código <span className="font-mono">{view.code}</span> · Esta página es personal: no la compartas.</p>
            </div>
        </main>
    );
}
