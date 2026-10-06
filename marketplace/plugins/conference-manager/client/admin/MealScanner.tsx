// @ts-nocheck
"use client";

/**
 * Meals (2.14.0) — delivery building blocks shared by the «Entrega» tab and the phone scanner.
 *
 * - `useMealDelivery` posts a delivery and turns EVERY outcome into a verdict the UI can show: the
 *   server's ('delivered', 'already', 'not_entitled', 'cancelled', 'unknown', 'other_conference'),
 *   a 404 ('no_service': the service was deleted), a network failure ('offline') or another error.
 *   Nothing is ever marked delivered locally: only a 'delivered' verdict from the server counts.
 * - `VerdictCard` is the big result card. «Entregar de todas formas» confirms INLINE (two steps on the
 *   card itself): the shared useModal dialog sits at z-50, under any overlay, and it would take the focus
 *   away from a USB scanner's input.
 * - `MealScanner` is the full-screen «Modo escáner» for phones (the primary scanner): live camera with an
 *   aiming frame, BarcodeDetector when the browser has it and the plugin's own Code 128 decoder otherwise
 *   (iPhone Safari, Firefox), continuous scanning with a sliding per-code gate, wake lock, torch, camera
 *   switch, beep + vibration, manual code entry and search by name.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { conferenceApi } from "../lib/conference";
import { createScanGate, isRegCode, normalizeCode, sortServices, stampTime, verdictTone, groupByDay } from "../lib/meals";
import { decodeCode128Image } from "../lib/barcodeScan";
import { fillVars } from "../lib/lodgingView";

// ── i18n ─────────────────────────────────────────────────────────────────────────────────────────────
/** `t(key)` with a Spanish fallback (t() returns the key itself when missing) and {placeholder} filling. */
export const makeTx = (t: (k: string) => string) => (key: string, fallback: string, vars?: Record<string, string | number>) => {
    const s = t(key);
    const base = s && s !== key ? s : fallback;
    return vars ? fillVars(base, vars) : base;
};
/** Count strings: `key` holds the plural, `${key}.one` the singular (es / en / pt use it for exactly 1). */
export const makeTxn = (tx: ReturnType<typeof makeTx>) =>
    (key: string, other: string, one: string, n: number, vars: Record<string, string | number> = {}) =>
        (Number(n) === 1 ? tx(`${key}.one`, one, { n, ...vars }) : tx(key, other, { n, ...vars }));
export const useTx = () => {
    const { t, language } = useI18n();
    return useMemo(() => makeTx(t), [t, language]);
};

export const mealName = (tx, meal: string) =>
    meal === 'desayuno' ? tx('meals.meal.desayuno', 'Desayuno') : meal === 'almuerzo' ? tx('meals.meal.almuerzo', 'Almuerzo') : meal === 'cena' ? tx('meals.meal.cena', 'Cena') : String(meal || '');
export const MEAL_ICON: Record<string, string> = { desayuno: 'fa-mug-hot', almuerzo: 'fa-bowl-food', cena: 'fa-moon' };

/** «mié 12/11» in the UI language. */
export const dayLabel = (date: string, language?: string, long = false) => {
    const m = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return String(date || '');
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
    try {
        const wd = d.toLocaleDateString(language || 'es', { weekday: long ? 'long' : 'short' });
        return `${wd.charAt(0).toUpperCase()}${wd.slice(1).replace(/\.$/, '')} ${m[3]}/${m[2]}`;
    } catch { return `${m[3]}/${m[2]}`; }
};
/** «Mié 12/11 · Almuerzo» (+ « — label»). */
export const serviceName = (tx, s, language?: string) =>
    s ? `${dayLabel(s.service_date, language)} · ${mealName(tx, s.meal)}${s.label ? ` — ${s.label}` : ''}` : '';

/**
 * «{served} de {entitled} entregados» (+ « · +{n} sin derecho»). `delivered` from the server also counts
 * the authorized deliveries to people without entitlement (delivered = entitled − pending + overrides), so
 * «delivered of entitled» could read «105 de 100» while entitled people are still waiting.
 */
export const servedLine = (tx, s) => {
    const entitled = Number(s?.entitled) || 0;
    const served = Math.max(0, entitled - (Number(s?.pending) || 0));
    const extra = Number(s?.overrides_delivered) || 0;
    return tx('meals.service.counts', '{delivered} de {entitled} entregados', { delivered: served, entitled })
        + (extra > 0 ? tx('meals.service.counts.overrides', ' · +{n} sin derecho', { n: extra }) : '');
};

/** A failed request with no HTTP status, or a gateway 502-504: the network / backend is unreachable. */
export const isOffline = (e: any) => !e?.status || [502, 503, 504].includes(Number(e.status));

// ── Delivery ─────────────────────────────────────────────────────────────────────────────────────────
export type Outcome = {
    result: 'delivered' | 'already' | 'not_entitled' | 'cancelled' | 'unknown' | 'other_conference' | 'offline' | 'no_service' | 'error';
    verdict?: any;
    message?: string;
    /** What was scanned/typed (shown on «Código no encontrado»). */
    code?: string;
    /** The service the request was made for. */
    serviceId?: number;
    /** Increments per outcome so an identical verdict still re-renders / re-flashes. */
    seq: number;
    at: number;
};

let outcomeSeq = 0;
export function useMealDelivery() {
    return useCallback(async (body: { service_id: number; code?: string; inscription_id?: number; force?: boolean; note?: string }): Promise<Outcome> => {
        const base = { seq: ++outcomeSeq, at: Date.now(), serviceId: body.service_id, code: body.code ? normalizeCode(body.code) || String(body.code).trim() : undefined };
        try {
            const v = await conferenceApi.deliverMeal(body);
            return { ...base, result: v?.result || 'error', verdict: v };
        } catch (e: any) {
            if (e?.status === 404) return { ...base, result: 'no_service', message: e?.message };
            // Nothing was recorded when the network or the backend is unreachable: scan again.
            if (isOffline(e)) return { ...base, result: 'offline', message: e?.message };
            return { ...base, result: 'error', message: e?.message };
        }
    }, []);
}

// ── Feedback: beep + vibration ───────────────────────────────────────────────────────────────────────
/**
 * Web Audio beeps; the context is created on the first user gesture (opening the scanner / a scan).
 * After close() nothing plays any more: a verdict that lands after the screen is gone must neither beep
 * nor create a new AudioContext that nobody closes.
 */
export function createFeedback() {
    let ctx: AudioContext | null = null;
    let closed = false;
    const audio = () => {
        if (closed) return null;
        try {
            if (!ctx) { const C = (window as any).AudioContext || (window as any).webkitAudioContext; if (C) ctx = new C(); }
            if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => { });
        } catch { ctx = null; }
        return ctx;
    };
    const tone = (freq: number, start: number, dur: number) => {
        const c = audio();
        if (!c) return;
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'square'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, c.currentTime + start);
        g.gain.exponentialRampToValueAtTime(0.18, c.currentTime + start + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
        o.connect(g); g.connect(c.destination);
        o.start(c.currentTime + start); o.stop(c.currentTime + start + dur + 0.02);
    };
    const vibrate = (p: number | number[]) => { if (closed) return; try { (navigator as any).vibrate?.(p); } catch { /* not supported */ } };
    return {
        prime: () => { audio(); },
        ok: () => { tone(1320, 0, 0.12); vibrate(60); },
        bad: () => { tone(330, 0, 0.14); tone(330, 0.2, 0.14); vibrate([80, 60, 80]); },
        close: () => { closed = true; try { ctx?.close(); } catch { /* ignore */ } ctx = null; },
    };
}

// ── Verdict card ─────────────────────────────────────────────────────────────────────────────────────
const TONE_CLS = {
    ok: 'bg-emerald-600 text-white border-emerald-700',
    warn: 'bg-amber-400 text-amber-950 border-amber-500',
    bad: 'bg-rose-600 text-white border-rose-700',
    muted: 'bg-gray-700 text-white border-gray-800',
};
/** Buttons that must not take the focus from a USB scanner's input (its Enter would press them). */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

/**
 * `onForce(outcome)` is called only after the inline confirmation; `onArmedChange(true|false)` lets the
 * phone scanner pause decoding while someone is deciding.
 */
export function VerdictCard({ outcome, service, onForce, onUndo, onDismiss, onArmedChange, busy, large = false, language }: any) {
    const tx = useTx();
    const [armed, setArmed] = useState(false);
    const seq = outcome?.seq;
    useEffect(() => { setArmed(false); }, [seq]);
    useEffect(() => { onArmedChange?.(armed); }, [armed]);
    useEffect(() => () => onArmedChange?.(false), []);
    if (!outcome) return null;
    const r = outcome.result;
    const v = outcome.verdict || {};
    const p = v.person;
    const tone = r === 'no_service' || r === 'error' ? 'bad' : verdictTone(r);
    const svc = service ? serviceName(tx, service, language) : '';
    const title =
        r === 'delivered' ? tx('meals.verdict.delivered', 'Entregado')
            : r === 'already' ? tx('meals.verdict.already', 'Ya recibió')
                : r === 'not_entitled' ? tx('meals.verdict.not_entitled', 'Sin derecho a {service}', { service: svc })
                    : r === 'cancelled' ? tx('meals.verdict.cancelled', 'Inscripción cancelada')
                        : r === 'unknown' ? tx('meals.verdict.unknown', 'Código no encontrado')
                            : r === 'other_conference' ? tx('meals.verdict.other_conference', 'Ese código es de otra conferencia')
                                : r === 'offline' ? tx('meals.verdict.offline', 'Sin conexión — vuelve a escanear')
                                    : r === 'no_service' ? tx('meals.verdict.no_service', 'Servicio no encontrado: elige otro')
                                        : (outcome.message || tx('meals.verdict.error', 'No se pudo registrar'));
    const icon = r === 'delivered' ? 'fa-circle-check' : r === 'not_entitled' ? 'fa-triangle-exclamation' : r === 'unknown' || r === 'other_conference' ? 'fa-circle-question' : r === 'offline' ? 'fa-wifi' : 'fa-circle-xmark';
    const loc = p ? (p.location_id == null ? tx('meals.no.location', 'Sin localidad') : (p.location || '')) : '';
    const canForce = r === 'not_entitled' && onForce && p;
    const canUndo = r === 'delivered' && onUndo && v.delivery_id;
    return (
        <div className={`rounded-3xl border-2 shadow-xl ${TONE_CLS[tone]} ${large ? 'p-6' : 'p-5'} animate-in fade-in zoom-in-95 duration-150`} role="status" aria-live="assertive" data-verdict={r} onClick={() => { if (!armed) onDismiss?.(); }}>
            <div className="flex items-start gap-4">
                <i className={`fa-solid ${icon} ${large ? 'text-5xl' : 'text-4xl'} shrink-0 mt-0.5`} aria-hidden="true"></i>
                <div className="min-w-0 flex-1">
                    <div className={`${large ? 'text-3xl' : 'text-2xl'} font-black tracking-tight leading-tight break-words`}>{title}</div>
                    {p && <div className={`${large ? 'text-2xl' : 'text-xl'} font-bold mt-1 break-words`}>{p.name}</div>}
                    {p && <div className="text-sm font-semibold opacity-90 mt-0.5">{[loc, p.family_group ? tx('meals.family', 'Grupo familiar: {name}', { name: p.family_group }) : '', p.reg_code || ''].filter(Boolean).join(' · ')}</div>}
                    {r === 'already' && v.delivered_at && (
                        <div className="text-sm font-bold mt-1">{v.delivered_by
                            ? tx('meals.verdict.already.at.by', 'Recibió a las {time} · registró {who}', { time: stampTime(v.delivered_at), who: v.delivered_by })
                            : tx('meals.verdict.already.at', 'Recibió a las {time}', { time: stampTime(v.delivered_at) })}</div>
                    )}
                    {r === 'unknown' && outcome.code && <div className="text-sm font-mono font-bold mt-1 opacity-90 break-all">{outcome.code}</div>}
                    {r === 'delivered' && v.method === 'override' && <div className="text-xs font-black uppercase tracking-widest mt-1 opacity-90">{tx('meals.method.override', 'Sin derecho (autorizado)')}</div>}
                    {canForce && armed && (
                        <div className="mt-3 rounded-2xl bg-amber-950/10 border border-amber-950/20 p-3 space-y-2" role="alertdialog" aria-label={tx('meals.force', 'Entregar de todas formas')}>
                            <p className="text-sm font-bold">{tx('meals.force.confirm', '{name} no tiene derecho a {service}. ¿Entregar de todas formas? Quedará registrado como autorizado.', { name: p.name, service: svc })}</p>
                            <div className="flex flex-wrap gap-2">
                                <button type="button" disabled={busy} onMouseDown={keepFocus} onClick={(e) => { e.stopPropagation(); setArmed(false); onForce(outcome); }}
                                    className="px-4 py-3 rounded-2xl bg-amber-950 text-amber-50 font-black text-xs uppercase tracking-widest disabled:opacity-50" data-force-confirm="">
                                    <i className="fa-solid fa-check mr-1.5" aria-hidden="true"></i>{tx('meals.force.yes', 'Sí, entregar')}
                                </button>
                                <button type="button" onMouseDown={keepFocus} onClick={(e) => { e.stopPropagation(); setArmed(false); }}
                                    className="px-4 py-3 rounded-2xl bg-white/60 text-amber-950 font-black text-xs uppercase tracking-widest">
                                    {tx('cancel', 'Cancelar')}
                                </button>
                            </div>
                        </div>
                    )}
                    {((canForce && !armed) || canUndo) ? (
                        <div className="flex flex-wrap gap-2 mt-3">
                            {canForce && !armed && (
                                <button type="button" disabled={busy} onMouseDown={keepFocus} onClick={(e) => { e.stopPropagation(); setArmed(true); }}
                                    className="px-4 py-3 rounded-2xl bg-amber-950 text-amber-50 font-black text-xs uppercase tracking-widest disabled:opacity-50" data-force="">
                                    <i className="fa-solid fa-hand mr-1.5" aria-hidden="true"></i>{tx('meals.force', 'Entregar de todas formas')}
                                </button>
                            )}
                            {canUndo && (
                                <button type="button" disabled={busy} onMouseDown={keepFocus} onClick={(e) => { e.stopPropagation(); onUndo(v.delivery_id, outcome); }}
                                    className="px-4 py-2.5 rounded-2xl bg-white/20 hover:bg-white/30 font-black text-[11px] uppercase tracking-widest disabled:opacity-50">
                                    <i className="fa-solid fa-rotate-left mr-1.5" aria-hidden="true"></i>{tx('meals.undo', 'Deshacer')}
                                </button>
                            )}
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

// ── Manual search (by name / document / code) ────────────────────────────────────────────────────────
export function PersonSearch({ conferenceId, onPick, busy, autoFocus = true, dark = false }: any) {
    const tx = useTx();
    const [q, setQ] = useState('');
    const [res, setRes] = useState<{ people: any[]; total: number } | null>(null);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState('');
    useEffect(() => {
        const term = q.trim();
        setErr('');
        if (term.length < 2) { setRes(null); setLoading(false); return; }
        let alive = true;
        setLoading(true);
        const h = setTimeout(async () => {
            try { const r = await conferenceApi.getMealPeople(conferenceId, { q: term, limit: 20 }); if (alive) setRes({ people: r.people || [], total: r.total || 0 }); }
            catch (e: any) {
                // A failure is NOT «nobody matches»: the kitchen would turn the attendee away.
                if (alive) { setRes(null); setErr(isOffline(e) ? tx('meals.search.offline', 'Sin conexión — vuelve a intentarlo') : (e?.message || tx('meals.verdict.error', 'No se pudo registrar'))); }
            }
            finally { if (alive) setLoading(false); }
        }, 250);
        return () => { alive = false; clearTimeout(h); };
    }, [q, conferenceId]);
    const input = dark
        ? 'w-full rounded-2xl px-4 py-4 bg-white/10 border-2 border-white/20 text-white placeholder-white/50 text-lg font-bold outline-none focus:border-white'
        : 'w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium';
    return (
        <div className="space-y-3">
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus} className={input}
                placeholder={tx('meals.search.placeholder', 'Nombre, documento o código…')} aria-label={tx('meals.search.label', 'Buscar participante')} />
            {loading && <div className={`text-xs font-bold ${dark ? 'text-white/60' : 'text-gray-400'}`}>{tx('loading', 'Cargando…')}</div>}
            {err && !loading && <div role="alert" className={`text-sm font-bold ${dark ? 'text-rose-300' : 'text-rose-600'}`}><i className="fa-solid fa-wifi mr-1.5" aria-hidden="true"></i>{err}</div>}
            {res && !err && !loading && res.people.length === 0 && <div className={`text-sm font-bold ${dark ? 'text-white/70' : 'text-gray-500'}`}>{tx('meals.search.none', 'Nadie coincide con la búsqueda.')}</div>}
            {res && !err && res.people.length > 0 && (
                <ul className="space-y-2">
                    {res.people.map((p) => (
                        <li key={p.id}>
                            <button type="button" disabled={busy} onClick={() => onPick(p)}
                                className={`w-full text-left px-4 py-3 rounded-2xl border-2 flex items-center gap-3 disabled:opacity-50 ${dark ? 'border-white/15 bg-white/5 hover:bg-white/10' : 'border-gray-100 bg-white hover:border-emerald-400 hover:bg-emerald-50/50'}`}>
                                <span className="min-w-0 flex-1">
                                    <span className={`block font-black break-words ${dark ? 'text-white text-lg' : 'text-gray-900 text-sm'}`}>{p.name}</span>
                                    <span className={`block text-xs font-semibold ${dark ? 'text-white/60' : 'text-gray-500'}`}>{[p.location_id == null ? tx('meals.no.location', 'Sin localidad') : p.location, p.reg_code].filter(Boolean).join(' · ')}</span>
                                </span>
                                <span className={`text-[10px] font-black uppercase tracking-widest whitespace-nowrap ${dark ? 'text-emerald-300' : 'text-emerald-700'}`}>{tx('meals.deliver', 'Entregar')}</span>
                            </button>
                        </li>
                    ))}
                    {res.total > res.people.length && <li className={`text-xs font-bold ${dark ? 'text-white/60' : 'text-gray-400'}`}>{tx('meals.search.more', 'Hay {n} coincidencias: escribe más para afinar.', { n: res.total })}</li>}
                </ul>
            )}
        </div>
    );
}

// ── Camera support ───────────────────────────────────────────────────────────────────────────────────
let detectorPromise: Promise<any> | null = null;
/** A BarcodeDetector for Code 128 when the browser has one (Chrome / Android), else null. */
export function getNativeDetector(): Promise<any> {
    if (detectorPromise) return detectorPromise;
    detectorPromise = (async () => {
        try {
            const BD = (window as any).BarcodeDetector;
            if (!BD) return null;
            const formats = typeof BD.getSupportedFormats === 'function' ? await BD.getSupportedFormats() : ['code_128'];
            return formats.includes('code_128') ? new BD({ formats: ['code_128'] }) : null;
        } catch { return null; }
    })();
    return detectorPromise;
}

export const cameraAvailability = (): 'ok' | 'insecure' | 'unsupported' => {
    if (typeof window === 'undefined') return 'unsupported';
    if (!window.isSecureContext) return 'insecure';
    if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
    return 'ok';
};

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

// ── Full-screen phone scanner ────────────────────────────────────────────────────────────────────────
export function MealScanner({ conferenceId, services, serviceId, onServiceChange, onClose, onChanged, language }: any) {
    const tx = useTx();
    const deliver = useMealDelivery();
    const sorted = useMemo(() => sortServices(services), [services]);
    const service = sorted.find((s) => s.id === serviceId) || null;

    const rootRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const loopRef = useRef<number | null>(null);
    /** Bumped by every stop: a camera start that resolves after it (Salir, page hidden, a newer start) is stale. */
    const camGen = useRef(0);
    const aliveRef = useRef(true);
    const inFlight = useRef(false);
    const gate = useRef(createScanGate(3000));
    const feedback = useRef(createFeedback());
    const wakeLock = useRef<any>(null);
    const serviceRef = useRef(serviceId);
    serviceRef.current = serviceId;

    const [cam, setCam] = useState<'starting' | 'on' | 'off' | 'denied' | 'insecure' | 'unsupported' | 'error'>(() => (cameraAvailability() === 'ok' ? 'starting' : cameraAvailability() as any));
    const [camError, setCamError] = useState('');
    const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
    const [deviceId, setDeviceId] = useState<string>('');
    const [torch, setTorch] = useState<{ supported: boolean; on: boolean }>({ supported: false, on: false });
    const [engine, setEngine] = useState<'native' | 'builtin' | ''>('');
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    const [busy, setBusy] = useState(false);
    const [stats, setStats] = useState<any>(null);
    const [sheet, setSheet] = useState<null | 'service' | 'code' | 'search'>(null);
    const [typed, setTyped] = useState('');
    const [flash, setFlash] = useState<'' | 'ok' | 'bad'>('');
    // Decoding pauses while a sheet covers the verdict or someone is confirming «Entregar de todas formas».
    const sheetRef = useRef(sheet);
    sheetRef.current = sheet;
    const armedRef = useRef(false);
    const deviceIdRef = useRef('');
    deviceIdRef.current = deviceId;

    // Stats: after every delivery and every 20 s — and only for the service still selected.
    const loadStats = useCallback(async () => {
        const sid = serviceRef.current;
        if (!sid) { setStats(null); return; }
        try { const s = await conferenceApi.getMealServiceStats(sid); if (sid === serviceRef.current && aliveRef.current) setStats(s); } catch { /* keep the last numbers */ }
    }, []);
    useEffect(() => { setStats(null); loadStats(); const h = setInterval(loadStats, 20000); return () => clearInterval(h); }, [serviceId, loadStats]);

    // Banner: 2.5 s, tap to dismiss (a not-entitled verdict waits for a decision).
    useEffect(() => {
        if (!outcome || outcome.result === 'not_entitled') return;
        const h = setTimeout(() => setOutcome((o) => (o && o.seq === outcome.seq ? null : o)), 2500);
        return () => clearTimeout(h);
    }, [outcome]);

    const show = useCallback((o: Outcome) => {
        setOutcome(o);
        const good = o.result === 'delivered';
        setFlash(good ? 'ok' : 'bad');
        setTimeout(() => { if (aliveRef.current) setFlash(''); }, 350);
        if (good) feedback.current.ok(); else feedback.current.bad();
        if (o.result === 'no_service') { setSheet('service'); onChanged?.(); }
        if (good) { loadStats(); onChanged?.(); }
    }, [loadStats, onChanged]);

    const submit = useCallback(async (body: any) => {
        const sid = serviceRef.current;
        if (!sid) { setSheet('service'); return; }
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true);
        try {
            const o = await deliver({ service_id: sid, ...body });
            if (!aliveRef.current) return;
            // The service changed while the request ran: its verdict would read as the new service's.
            if (sid !== serviceRef.current) { if (o.result === 'delivered') { feedback.current.ok(); onChanged?.(); } else feedback.current.bad(); return; }
            show(o);
        } finally { inFlight.current = false; if (aliveRef.current) setBusy(false); }
    }, [deliver, show, onChanged]);

    const onCode = useCallback((raw: string) => {
        const code = normalizeCode(raw);
        if (!isRegCode(code)) return;
        if (inFlight.current) return;            // before the gate: a badge seen meanwhile is not marked as seen
        if (!gate.current.accept(code)) return;   // sliding: a badge left in view is never posted twice
        submit({ code: raw });
    }, [submit]);
    // The frame loop is started once per camera start: it reads the CURRENT handler through a ref.
    const onCodeRef = useRef(onCode);
    onCodeRef.current = onCode;

    // ── camera lifecycle ──
    const stopCamera = useCallback(() => {
        camGen.current++;
        if (loopRef.current != null) { clearTimeout(loopRef.current); loopRef.current = null; }
        const s = streamRef.current;
        streamRef.current = null;
        if (s) s.getTracks().forEach((t) => { try { t.stop(); } catch { /* already stopped */ } });
        if (videoRef.current) videoRef.current.srcObject = null;
        if (aliveRef.current) setTorch({ supported: false, on: false });
    }, []);

    const scanLoop = useCallback(async () => {
        const video = videoRef.current;
        const stream = streamRef.current;
        if (!video || !stream) return;
        try {
            if (video.readyState >= 2 && video.videoWidth > 0 && !inFlight.current && !sheetRef.current && !armedRef.current) {
                const native = await getNativeDetector();
                if (native) {
                    const codes = await native.detect(video);
                    if (streamRef.current !== stream || !aliveRef.current) return;   // stopped meanwhile
                    for (const c of codes || []) onCodeRef.current(String(c.rawValue || ''));
                } else {
                    const canvas = canvasRef.current || (canvasRef.current = document.createElement('canvas'));
                    const scale = Math.min(1, 960 / video.videoWidth);
                    const w = Math.max(1, Math.round(video.videoWidth * scale)), h = Math.max(1, Math.round(video.videoHeight * scale));
                    if (canvas.width !== w) canvas.width = w;
                    if (canvas.height !== h) canvas.height = h;
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    if (ctx) {
                        ctx.drawImage(video, 0, 0, w, h);
                        const img = ctx.getImageData(0, 0, w, h);
                        const value = decodeCode128Image({ data: img.data, width: w, height: h, channels: 4 });
                        if (value) onCodeRef.current(value);
                    }
                }
            }
        } catch { /* a bad frame: try the next one */ }
        if (streamRef.current === stream && aliveRef.current) loopRef.current = window.setTimeout(scanLoop, 100);
    }, []);

    const startCamera = useCallback(async (wanted?: string) => {
        const avail = cameraAvailability();
        if (avail !== 'ok') { setCam(avail); return; }
        stopCamera();
        const gen = camGen.current;
        const stale = () => gen !== camGen.current || !aliveRef.current;
        setCam('starting'); setCamError('');
        try {
            const video: MediaTrackConstraints = wanted
                ? { deviceId: { exact: wanted }, width: { ideal: 1280 }, height: { ideal: 720 } }
                : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } };
            const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
            // Salir / page hidden / a newer start while the permission prompt or the camera was opening.
            if (stale()) { stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* stopped */ } }); return; }
            streamRef.current = stream;
            const el = videoRef.current;
            if (el) { el.srcObject = stream; el.setAttribute('playsinline', 'true'); el.muted = true; await el.play().catch(() => { }); }
            if (stale()) return;
            const track = stream.getVideoTracks()[0];
            // The camera can be taken away while the page stays visible (permission revoked, another app).
            if (track) track.addEventListener('ended', () => { if (streamRef.current === stream && aliveRef.current) { stopCamera(); setCam('off'); } });
            const caps = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
            setTorch({ supported: !!(caps as any).torch, on: false });
            const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
            if (settings.deviceId) setDeviceId(String(settings.deviceId));
            try { const all = await navigator.mediaDevices.enumerateDevices(); if (!stale()) setDevices(all.filter((d) => d.kind === 'videoinput')); } catch { if (!stale()) setDevices([]); }
            const native = await getNativeDetector();
            if (stale()) return;
            setEngine(native ? 'native' : 'builtin');
            setCam('on');
            loopRef.current = window.setTimeout(scanLoop, 150);
        } catch (e: any) {
            if (stale()) return;
            stopCamera();
            if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') setCam('denied');
            else if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') { setCam('error'); setCamError(tx('meals.camera.notfound', 'No se encontró una cámara.')); }
            else { setCam('error'); setCamError(e?.message || ''); }
        }
    }, [scanLoop, stopCamera, tx]);

    // Mount: focus, wake lock, audio, camera, body scroll lock; unmount: release everything.
    useEffect(() => {
        aliveRef.current = true;
        const prevFocus = document.activeElement as HTMLElement | null;
        rootRef.current?.focus();
        feedback.current.prime();
        const lock = async () => {
            try {
                if (!(navigator as any).wakeLock?.request || document.visibilityState !== 'visible') return;
                const s = await (navigator as any).wakeLock.request('screen');
                if (!aliveRef.current) { s.release?.(); return; }
                wakeLock.current = s;
            } catch { wakeLock.current = null; }
        };
        lock();
        startCamera();
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onVis = () => {
            if (document.visibilityState === 'hidden') stopCamera();
            else { lock(); if (cameraAvailability() === 'ok') startCamera(deviceIdRef.current || undefined); }
        };
        document.addEventListener('visibilitychange', onVis);
        return () => {
            aliveRef.current = false;
            document.removeEventListener('visibilitychange', onVis);
            stopCamera();
            try { wakeLock.current?.release?.(); } catch { /* released */ }
            wakeLock.current = null;
            feedback.current.close();
            document.body.style.overflow = prevOverflow;
            try { prevFocus?.focus?.(); } catch { /* gone */ }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Esc: a sheet closes first, then the scanner. Tab stays inside the overlay (it is modal).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { if (sheetRef.current) setSheet(null); else onClose(); return; }
            if (e.key !== 'Tab' || !rootRef.current) return;
            const items = Array.from(rootRef.current.querySelectorAll(FOCUSABLE)) as HTMLElement[];
            if (!items.length) { e.preventDefault(); rootRef.current.focus(); return; }
            const first = items[0], last = items[items.length - 1];
            const active = document.activeElement as HTMLElement | null;
            const inside = !!active && rootRef.current.contains(active);
            if (e.shiftKey && (!inside || active === first || active === rootRef.current)) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && (!inside || active === last)) { e.preventDefault(); first.focus(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const switchCamera = () => {
        if (devices.length < 2) return;
        const i = devices.findIndex((d) => d.deviceId === deviceId);
        const next = devices[(i + 1) % devices.length];
        setDeviceId(next.deviceId);
        startCamera(next.deviceId);
    };
    const toggleTorch = async () => {
        const track = streamRef.current?.getVideoTracks()[0];
        if (!track) return;
        try { await track.applyConstraints({ advanced: [{ torch: !torch.on }] } as any); setTorch((t) => ({ ...t, on: !t.on })); } catch { setTorch((t) => ({ ...t, supported: false })); }
    };
    // Called by the VerdictCard after its inline confirmation.
    const force = async (o: Outcome) => {
        const p = o.verdict?.person;
        if (!p) return;
        await submit({ inscription_id: p.id, force: true, note: tx('meals.force.note', 'Autorizado en el escáner') });
    };
    // No gate reset: the badge is usually still in view, and the undone delivery must not come back at
    // once. The sliding gate lets it through only after it has been out of view for 3 s.
    const undo = async (deliveryId: number) => {
        setBusy(true);
        try { await conferenceApi.undoMealDelivery(deliveryId); if (aliveRef.current) { setOutcome(null); loadStats(); onChanged?.(); } }
        catch (e: any) { if (aliveRef.current) setOutcome({ result: 'error', message: e?.message, seq: ++outcomeSeq, at: Date.now() }); }
        finally { if (aliveRef.current) setBusy(false); }
    };
    const pickService = (id: number) => {
        if (id !== serviceId) { onServiceChange(id); gate.current.reset(); }
        setOutcome(null); setSheet(null);
    };

    const camMessage =
        cam === 'insecure' ? tx('meals.camera.insecure', 'La cámara solo funciona con https. Puedes escribir el código o buscar por nombre.')
            : cam === 'unsupported' ? tx('meals.camera.unsupported', 'Este navegador no permite usar la cámara. Puedes escribir el código o buscar por nombre.')
                : cam === 'denied' ? tx('meals.camera.denied', 'No hay permiso para usar la cámara. Actívalo en la configuración del navegador (el candado junto a la dirección → Cámara → Permitir) y vuelve a intentarlo.')
                    : cam === 'error' ? (camError || tx('meals.camera.error', 'No se pudo abrir la cámara.'))
                        : cam === 'off' ? tx('meals.camera.off', 'Cámara pausada.') : '';
    const days = groupByDay(sorted);

    // Portalled to <body> above the admin chrome (header z-5000, sidebar z-5002, its toggle z-5003) and
    // below the toasts (z-9999): an ancestor with a transform / filter would otherwise crop a fixed overlay.
    return createPortal(
        <div ref={rootRef} tabIndex={-1} className="fixed inset-0 z-[6000] bg-black text-white flex flex-col select-none outline-none" role="dialog" aria-modal="true" aria-label={tx('meals.scanner', 'Modo escáner')} data-meal-scanner="">
            {/* Top: service + exit */}
            <div className="flex items-center gap-2 px-3 pt-[max(env(safe-area-inset-top),0.75rem)] pb-2 bg-black/80">
                <button type="button" onClick={() => setSheet('service')} className="flex-1 min-w-0 text-left px-4 py-3 rounded-2xl bg-white/10 active:bg-white/20" aria-label={tx('meals.scanner.change.service', 'Cambiar servicio')}>
                    <span className="block text-[10px] font-black uppercase tracking-widest text-white/60">{tx('meals.scanner.service', 'Servicio')}</span>
                    <span className="block text-base font-black truncate">{service ? serviceName(tx, service, language) : tx('meals.scanner.pick', 'Elige un servicio')}</span>
                </button>
                <button type="button" onClick={onClose} className="px-4 py-3 rounded-2xl bg-white/10 active:bg-white/20 font-black text-sm" aria-label={tx('meals.scanner.exit', 'Salir')}>
                    <i className="fa-solid fa-xmark mr-1.5" aria-hidden="true"></i>{tx('meals.scanner.exit', 'Salir')}
                </button>
            </div>

            {/* Counters */}
            <div className="grid grid-cols-3 gap-2 px-3 pb-2 text-center bg-black/80">
                {[[tx('meals.count.delivered', 'Entregados'), stats?.delivered], [tx('meals.count.entitled', 'Con derecho'), stats?.entitled], [tx('meals.count.pending', 'Pendientes'), stats?.pending]].map(([label, n]: any) => (
                    <div key={label} className="rounded-xl bg-white/10 py-1.5">
                        <div className="text-xl font-black tabular-nums">{n ?? '—'}</div>
                        <div className="text-[9px] font-black uppercase tracking-widest text-white/60">{label}</div>
                    </div>
                ))}
            </div>

            {/* Camera */}
            <div className={`relative flex-1 min-h-0 overflow-hidden ${flash === 'ok' ? 'ring-8 ring-inset ring-emerald-500' : flash === 'bad' ? 'ring-8 ring-inset ring-rose-500' : ''}`}>
                <video ref={videoRef} className={`absolute inset-0 w-full h-full object-cover ${cam === 'on' ? '' : 'opacity-0'}`} playsInline muted aria-hidden="true" />
                {cam === 'on' && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none" aria-hidden="true">
                        <div className="w-[82%] max-w-md aspect-[2.6/1] rounded-2xl border-4 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)] relative">
                            <div className="absolute left-3 right-3 top-1/2 h-0.5 bg-rose-500/80 animate-pulse"></div>
                        </div>
                    </div>
                )}
                {cam === 'on' && (
                    <div className="absolute top-3 left-0 right-0 text-center text-xs font-bold text-white/80 pointer-events-none">{tx('meals.scanner.aim', 'Apunta al código de barras del participante')}</div>
                )}
                {cam === 'starting' && <div className="absolute inset-0 flex items-center justify-center text-white/70 font-bold"><i className="fa-solid fa-camera mr-2 animate-pulse" aria-hidden="true"></i>{tx('meals.camera.starting', 'Abriendo la cámara…')}</div>}
                {camMessage && cam !== 'starting' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
                        <i className="fa-solid fa-video-slash text-4xl text-white/60" aria-hidden="true"></i>
                        <p className="text-base font-bold text-white/90 max-w-sm">{camMessage}</p>
                        {(cam === 'denied' || cam === 'error' || cam === 'off') && (
                            <button type="button" onClick={() => startCamera(deviceId || undefined)} className="px-5 py-3 rounded-2xl bg-white text-black font-black text-sm">{tx('meals.camera.retry', 'Reintentar')}</button>
                        )}
                    </div>
                )}
                {cam === 'on' && (
                    <div className="absolute right-3 top-10 flex flex-col gap-2">
                        {torch.supported && (
                            <button type="button" onClick={toggleTorch} className={`w-12 h-12 rounded-full flex items-center justify-center ${torch.on ? 'bg-yellow-300 text-black' : 'bg-black/60 text-white'}`} aria-pressed={torch.on} aria-label={tx('meals.camera.torch', 'Linterna')}>
                                <i className="fa-solid fa-bolt" aria-hidden="true"></i>
                            </button>
                        )}
                        {devices.length > 1 && (
                            <button type="button" onClick={switchCamera} className="w-12 h-12 rounded-full bg-black/60 text-white flex items-center justify-center" aria-label={tx('meals.camera.switch', 'Cambiar de cámara')}>
                                <i className="fa-solid fa-camera-rotate" aria-hidden="true"></i>
                            </button>
                        )}
                    </div>
                )}
                {cam === 'on' && engine === 'builtin' && <div className="absolute bottom-2 left-0 right-0 text-center text-[10px] font-bold text-white/50 pointer-events-none">{tx('meals.camera.builtin', 'Lector integrado: acerca el código y mantenlo recto')}</div>}

                {/* Verdict over the bottom third */}
                {outcome && (
                    <div className="absolute left-3 right-3 bottom-3">
                        <VerdictCard outcome={outcome} service={service} large busy={busy} language={language}
                            onForce={outcome.result === 'not_entitled' ? force : undefined}
                            onArmedChange={(a) => { armedRef.current = !!a; }}
                            onUndo={undo}
                            onDismiss={() => setOutcome(null)} />
                    </div>
                )}
            </div>

            {/* Bottom actions */}
            <div className="grid grid-cols-2 gap-2 px-3 pt-2 pb-[max(env(safe-area-inset-bottom),0.75rem)] bg-black/80">
                <button type="button" onClick={() => { setTyped(''); setSheet('code'); }} className="py-4 rounded-2xl bg-white/10 active:bg-white/20 font-black text-sm">
                    <i className="fa-solid fa-keyboard mr-2" aria-hidden="true"></i>{tx('meals.scanner.type', 'Escribir código')}
                </button>
                <button type="button" onClick={() => setSheet('search')} className="py-4 rounded-2xl bg-white/10 active:bg-white/20 font-black text-sm">
                    <i className="fa-solid fa-magnifying-glass mr-2" aria-hidden="true"></i>{tx('meals.scanner.search', 'Buscar por nombre')}
                </button>
            </div>

            {/* Sheets */}
            {sheet && (
                <div className="absolute inset-0 z-10 bg-black/70 flex items-end" onClick={() => setSheet(null)}>
                    <div className="w-full max-h-[85%] overflow-y-auto rounded-t-3xl bg-gray-900 p-4 pb-[max(env(safe-area-inset-bottom),1rem)] space-y-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between">
                            <h2 className="text-lg font-black">
                                {sheet === 'service' ? tx('meals.scanner.pick', 'Elige un servicio') : sheet === 'code' ? tx('meals.scanner.type', 'Escribir código') : tx('meals.scanner.search', 'Buscar por nombre')}
                            </h2>
                            <button type="button" onClick={() => setSheet(null)} className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center" aria-label={tx('close', 'Cerrar')}><i className="fa-solid fa-xmark" aria-hidden="true"></i></button>
                        </div>
                        {sheet === 'service' && (
                            sorted.length === 0
                                ? <p className="text-sm font-bold text-white/70">{tx('meals.services.none', 'Todavía no hay servicios de comida.')}</p>
                                : days.map((d) => (
                                    <div key={d.date} className="space-y-2">
                                        <div className="text-[10px] font-black uppercase tracking-widest text-white/50">{dayLabel(d.date, language, true)}</div>
                                        <div className="grid grid-cols-1 gap-2">
                                            {d.services.map((s) => (
                                                <button key={s.id} type="button" onClick={() => pickService(s.id)}
                                                    className={`text-left px-4 py-3 rounded-2xl border-2 font-black ${s.id === serviceId ? 'border-emerald-400 bg-emerald-500/20' : 'border-white/15 bg-white/5'}`} aria-pressed={s.id === serviceId}>
                                                    <i className={`fa-solid ${MEAL_ICON[s.meal] || 'fa-utensils'} mr-2`} aria-hidden="true"></i>{mealName(tx, s.meal)}{s.label ? ` — ${s.label}` : ''}
                                                    <span className="block text-xs font-bold text-white/60 mt-0.5">{servedLine(tx, s)}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ))
                        )}
                        {sheet === 'code' && (
                            <form onSubmit={(e) => { e.preventDefault(); const raw = typed; if (!normalizeCode(raw)) return; setSheet(null); submit({ code: raw }); }} className="space-y-3">
                                <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoCapitalize="characters" autoComplete="off" spellCheck={false} inputMode="text"
                                    className="w-full rounded-2xl px-4 py-4 bg-white/10 border-2 border-white/20 text-white text-2xl font-mono font-black tracking-widest outline-none focus:border-white"
                                    aria-label={tx('meals.code', 'Código')} placeholder="ABCD234XYZ" />
                                <button type="submit" disabled={!normalizeCode(typed) || busy} className="w-full py-4 rounded-2xl bg-emerald-500 text-black font-black disabled:opacity-40">{tx('meals.deliver', 'Entregar')}</button>
                            </form>
                        )}
                        {sheet === 'search' && (
                            <PersonSearch conferenceId={conferenceId} dark busy={busy} onPick={(p) => { setSheet(null); submit({ inscription_id: p.id }); }} />
                        )}
                    </div>
                </div>
            )}
        </div>,
        document.body,
    );
}
