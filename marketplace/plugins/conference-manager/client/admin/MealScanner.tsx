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
 *   aiming frame, BarcodeDetector when the browser has it and the plugin's own decoder otherwise
 *   (iPhone Safari, Firefox), continuous scanning with a sliding per-code gate, wake lock, torch, camera
 *   switch, beep + vibration, manual code entry and search by name.
 *
 * 2.15.1 (an iPhone in production showed a band of camera over the page, a white dot for a frame and never
 * reacted to anything): the overlay's structural styles are INLINE (black, full screen, above the admin
 * chrome, bars with safe-area padding, the aiming frame) because the plugin's Tailwind classes did not
 * exist on the live site; the page behind is pinned (iOS ignores overflow:hidden); the scanner shows
 * WHATEVER it reads — a value that is not a registration code (a product box: EAN/UPC, Code 39, a QR on
 * Android…) gets a «Código leído: …» card with its symbology instead of silence; a heartbeat driven by the
 * decode loop says it is scanning («Escaneando · N cuadros/s») and says so when the camera delivers no
 * image; a rejected video.play() (iOS Low Power Mode) offers «Toca para activar la cámara»; the audio is
 * unlocked inside the tap that opens the scanner; the band under the aiming frame is decoded at full
 * resolution from a 1920×1080 stream.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { conferenceApi } from "../lib/conference";
import { createReadRouter, createScanMeter, normalizeCode, sortServices, stampTime, verdictTone, groupByDay } from "../lib/meals";
import { aimCrop, decodeVideoRegion, formatLabel } from "../lib/barcodeScan";
import { lockBodyScroll } from "../lib/overlay";
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
const audioCtor = () => (typeof window === 'undefined' ? null : ((window as any).AudioContext || (window as any).webkitAudioContext || null));
/** Resume a context and play one silent sample: inside a user gesture, that unlocks Web Audio on iOS. */
const unlockAudio = (c: any) => {
    try { if (c.state === 'suspended') c.resume().catch(() => { }); } catch { /* ignore */ }
    try { const b = c.createBuffer(1, 1, 22050); const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0); } catch { /* ignore */ }
};
let primedAudio: AudioContext | null = null;
/**
 * iOS only lets a page sound from an AudioContext created or resumed INSIDE a user gesture; 2.15.0
 * created it in an effect after the scanner opened, outside the tap, and the iPhone stayed silent.
 * Call this synchronously in the click that opens the scanner: the scanner's feedback ADOPTS the
 * unlocked context (and closes it when the scanner closes).
 */
export function primeScannerAudio() {
    try {
        if (!primedAudio || (primedAudio as any).state === 'closed') { const C = audioCtor(); primedAudio = C ? new C() : null; }
        if (primedAudio) unlockAudio(primedAudio);
    } catch { primedAudio = null; }
    return primedAudio;
}

/**
 * Web Audio beeps; the context is created on the first user gesture (opening the scanner / a scan) —
 * with `adopt`, the one `primeScannerAudio()` unlocked in the opening tap. `prime()` (called on every
 * press inside the scanner) resumes and unlocks it again.
 * After close() nothing plays any more: a verdict that lands after the screen is gone must neither beep
 * nor create a new AudioContext that nobody closes.
 */
export function createFeedback({ adopt = false }: { adopt?: boolean } = {}) {
    let ctx: AudioContext | null = null;
    let closed = false;
    const audio = () => {
        if (closed) return null;
        try {
            if (!ctx && adopt && primedAudio && (primedAudio as any).state !== 'closed') { ctx = primedAudio; primedAudio = null; }
            if (!ctx) { const C = audioCtor(); if (C) ctx = new C(); }
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
        prime: () => { const c = audio(); if (c) unlockAudio(c); },
        ok: () => { tone(1320, 0, 0.12); vibrate(60); },
        bad: () => { tone(330, 0, 0.14); tone(330, 0.2, 0.14); vibrate([80, 60, 80]); },
        /** Something was read that is not a registration code: one short neutral blip. */
        info: () => { tone(880, 0, 0.07); vibrate(25); },
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
/** What BarcodeDetector is asked for when it cannot list its formats: the badge's and the retail ones. */
export const NATIVE_DEFAULT_FORMATS = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39'];
/**
 * The formats to ask BarcodeDetector for: EVERY one it supports (the scanner shows whatever it reads —
 * 2.15.0 asked for Code 128 only, so a product box was invisible), or null when it cannot read the
 * badges' Code 128 (the built-in reader is used then).
 */
export function pickNativeFormats(supported: string[] | null | undefined): string[] | null {
    if (!Array.isArray(supported)) return [...NATIVE_DEFAULT_FORMATS];
    const list = supported.filter((f) => typeof f === 'string' && f && f !== 'unknown');
    return list.includes('code_128') ? list : null;
}

let detectorPromise: Promise<any> | null = null;
/** A BarcodeDetector (Chrome / Android) for every format it reads, Code 128 included; else null. */
export function getNativeDetector(): Promise<any> {
    if (detectorPromise) return detectorPromise;
    detectorPromise = (async () => {
        try {
            const BD = (window as any).BarcodeDetector;
            if (!BD) return null;
            const formats = pickNativeFormats(typeof BD.getSupportedFormats === 'function' ? await BD.getSupportedFormats() : null);
            return formats ? new BD({ formats }) : null;
        } catch { return null; }
    })();
    return detectorPromise;
}

/**
 * One built-in decode of the current frame: the band under the aiming frame (`frameEl`), at the camera's
 * full resolution, in every symbology the plugin reads, nothing filtered (`regCodeOnly: false` — the
 * caller decides what is a registration code and shows the rest). Falls back to the whole frame when
 * the aiming frame has no layout.
 */
export function decodeCameraFrame(video: any, canvas: any, frameEl: any) {
    let band = null;
    try {
        if (frameEl && typeof video.getBoundingClientRect === 'function') {
            const v = video.getBoundingClientRect(), f = frameEl.getBoundingClientRect();
            band = aimCrop(video.videoWidth, video.videoHeight, { width: v.width, height: v.height }, { x: f.left - v.left, y: f.top - v.top, width: f.width, height: f.height });
        }
    } catch { band = null; }
    return decodeVideoRegion(video, canvas, band, { regCodeOnly: false });
}

// ── Scanner pieces (inline styles: they must exist even where the plugin's Tailwind classes do not) ──
/** Keyframes of the scan line and the heartbeat dot (no motion with prefers-reduced-motion). */
export const SCANNER_CSS = `
@keyframes cm-scan-sweep { 0%, 100% { top: 14%; } 50% { top: 86%; } }
@keyframes cm-scan-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { [data-scan-line], [data-scan-dot] { animation: none !important; } }
`;
export const SCANNER_ROOT_STYLE: React.CSSProperties = {
    position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, height: '100dvh', zIndex: 6000,
    background: '#000', color: '#fff', display: 'flex', flexDirection: 'column', overscrollBehavior: 'none',
};
export const SCANNER_BAR_STYLE: React.CSSProperties = { background: 'rgba(0,0,0,0.8)', flexShrink: 0 };
const pill: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 999,
    background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 12, fontWeight: 800, lineHeight: 1.2,
};

/** The aiming frame: 82% wide (≤ 448 px), 2.6:1, the camera dimmed around it, a sweeping red line while scanning. */
export function AimFrame({ frameRef, scanning }: any) {
    return (
        <div ref={frameRef} data-aim-frame="" style={{
            position: 'relative', width: '82%', maxWidth: 448, aspectRatio: '2.6 / 1', borderRadius: 16,
            border: '4px solid rgba(255,255,255,0.9)', boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
        }}>
            <div data-scan-line="" style={{
                position: 'absolute', left: 12, right: 12, top: '50%', height: 3, borderRadius: 2,
                background: 'rgba(244,63,94,0.95)', boxShadow: '0 0 10px rgba(244,63,94,0.9)',
                opacity: scanning ? 1 : 0.35, animation: scanning ? 'cm-scan-sweep 1.8s ease-in-out infinite' : 'none',
            }} />
        </div>
    );
}

/**
 * The heartbeat under the aiming frame, driven by the decode loop: «Escaneando · N cuadros/s» with a
 * pulsing dot, «En pausa» while a sheet / a verdict / a request holds the loop. Nothing when stalled
 * (CameraNotice covers the camera then).
 */
export function ScanPill({ health, tx }: any) {
    if (!health || health.state === 'stalled') return null;
    const scanning = health.state === 'scanning';
    return (
        <div data-scan-state={health.state} role="status" aria-live="off" style={pill}>
            <span data-scan-dot="" aria-hidden="true" style={{
                width: 8, height: 8, borderRadius: 999, background: scanning ? '#34d399' : '#fbbf24',
                animation: scanning ? 'cm-scan-pulse 1s ease-in-out infinite' : 'none',
            }} />
            {scanning
                ? tx('meals.scanner.scanning', 'Escaneando · {n} cuadros/s', { n: health.fps })
                : tx('meals.scanner.paused', 'En pausa')}
        </div>
    );
}

/**
 * Over the camera when it shows nothing useful: video.play() was refused (iOS Low Power Mode, autoplay
 * rules) → a big «Toca para activar la cámara» button; no frame analysed for 2 s with the camera on →
 * «La cámara no entrega imagen» + Reintentar.
 */
export function CameraNotice({ health, playBlocked, onActivate, onRetry, tx }: any) {
    const box: React.CSSProperties = {
        position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 2, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, textAlign: 'center', background: 'rgba(0,0,0,0.75)', color: '#fff',
    };
    const btn: React.CSSProperties = { padding: '14px 22px', borderRadius: 16, background: '#fff', color: '#000', fontWeight: 900, fontSize: 15, border: 0 };
    if (playBlocked) {
        return (
            <div data-camera-notice="blocked" style={box}>
                <button type="button" onClick={onActivate} style={btn} data-camera-activate="">
                    <i className="fa-solid fa-play mr-2" aria-hidden="true"></i>{tx('meals.camera.tap', 'Toca para activar la cámara')}
                </button>
            </div>
        );
    }
    if (health?.state !== 'stalled') return null;
    return (
        <div data-camera-notice="stalled" role="alert" style={box}>
            <i className="fa-solid fa-video-slash" aria-hidden="true" style={{ fontSize: 36, opacity: 0.7 }}></i>
            <p style={{ fontSize: 16, fontWeight: 800, maxWidth: 360, margin: 0 }}>{tx('meals.camera.noframes', 'La cámara no entrega imagen')}</p>
            <p style={{ fontSize: 13, fontWeight: 600, opacity: 0.75, maxWidth: 360, margin: 0 }}>{tx('meals.camera.noframes.hint', 'Cierra otras apps que usen la cámara y desactiva el modo de bajo consumo si está activo.')}</p>
            <button type="button" onClick={onRetry} style={btn} data-camera-retry="">{tx('meals.camera.retry', 'Reintentar')}</button>
        </div>
    );
}

/** Longest value shown on the read card (a QR can carry a whole paragraph). */
const READ_SHOWN_MAX = 120;
/**
 * What the camera read that is NOT a registration code — shown, never silence: «Código leído: <valor> —
 * no es un código de inscripción», with its symbology. Tap to dismiss.
 */
export function ReadCard({ read, tx, onDismiss }: any) {
    if (!read) return null;
    const v = String(read.value || '');
    const shown = v.length > READ_SHOWN_MAX ? `${v.slice(0, READ_SHOWN_MAX)}…` : v;
    return (
        <div data-scan-read={read.format || ''} role="status" aria-live="polite" onClick={onDismiss} style={{
            background: 'rgba(17,24,39,0.94)', color: '#fff', border: '2px solid rgba(255,255,255,0.3)', borderRadius: 20,
            padding: '12px 16px', boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
        }}>
            <div style={{ fontSize: 10, fontWeight: 900, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.75 }}>
                <i className="fa-solid fa-barcode mr-1.5" aria-hidden="true"></i>{read.format ? formatLabel(read.format) : tx('meals.scanner.read.symbology', 'Código de barras')}
            </div>
            <div style={{ fontSize: 16, fontWeight: 800, marginTop: 2, overflowWrap: 'anywhere' }}>
                {tx('meals.scanner.read.other', 'Código leído: {value} — no es un código de inscripción', { value: shown })}
            </div>
        </div>
    );
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
    const router = useRef(createReadRouter(3000));
    const meter = useRef(createScanMeter(2000));
    const aimRef = useRef<HTMLDivElement | null>(null);
    const lastReadAt = useRef(0);
    const feedback = useRef(createFeedback({ adopt: true }));
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
    const [health, setHealth] = useState<{ state: string; fps: number } | null>(null);
    const [playBlocked, setPlayBlocked] = useState(false);
    /** The last value read that is not a registration code (shown while it stays in view + 2.5 s). */
    const [read, setRead] = useState<{ value: string; format: string; seq: number } | null>(null);
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

    // A registration code is posted (once per sighting, never while a request is in flight); ANYTHING else
    // the camera reads is shown on the read card — the operator sees the scanner works and what it saw.
    const onCode = useCallback((raw: string, format = '') => {
        const r = router.current.route(raw, format, inFlight.current);
        if (!r) return;
        if (r.action === 'submit') { submit({ code: r.code }); return; }
        lastReadAt.current = Date.now();
        if (r.fresh) { setRead({ value: r.value, format: r.format, seq: Date.now() }); feedback.current.info(); }
    }, [submit]);
    // The frame loop is started once per camera start: it reads the CURRENT handler through a ref.
    const onCodeRef = useRef(onCode);
    onCodeRef.current = onCode;
    // The read card stays while the value stays in view, and 2.5 s after it left.
    useEffect(() => {
        if (!read) return;
        const h = setInterval(() => { if (Date.now() - lastReadAt.current > 2500) setRead(null); }, 500);
        return () => clearInterval(h);
    }, [read]);

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

    // Every turn either analyses a frame (meter.frame), skips one on purpose (meter.pause: a sheet, a
    // verdict awaiting a decision, a request in flight) or finds no playable frame (nothing recorded):
    // the heartbeat and the «no image» notice are read from what the loop really did.
    const scanLoop = useCallback(async () => {
        const video = videoRef.current;
        const stream = streamRef.current;
        if (!video || !stream) return;
        try {
            if (inFlight.current || sheetRef.current || armedRef.current) meter.current.pause();
            else if (video.readyState >= 2 && video.videoWidth > 0 && !video.paused) {
                const native = await getNativeDetector();
                if (native) {
                    const codes = await native.detect(video);
                    if (streamRef.current !== stream || !aliveRef.current) return;   // stopped meanwhile
                    meter.current.frame();
                    for (const c of codes || []) onCodeRef.current(String(c.rawValue || ''), String(c.format || ''));
                } else {
                    const canvas = canvasRef.current || (canvasRef.current = document.createElement('canvas'));
                    const hit = decodeCameraFrame(video, canvas, aimRef.current);
                    meter.current.frame();
                    if (hit) onCodeRef.current(hit.text, hit.format);
                }
            }
        } catch { /* a bad frame: try the next one */ }
        if (streamRef.current === stream && aliveRef.current) loopRef.current = window.setTimeout(scanLoop, 80);
    }, []);

    const startCamera = useCallback(async (wanted?: string) => {
        const avail = cameraAvailability();
        if (avail !== 'ok') { setCam(avail); return; }
        stopCamera();
        const gen = camGen.current;
        const stale = () => gen !== camGen.current || !aliveRef.current;
        setCam('starting'); setCamError(''); setPlayBlocked(false);
        try {
            // 1920×1080 ideal: the band under the aiming frame is decoded at the camera's resolution, and
            // a product barcode's 1-module bars need it.
            const video: MediaTrackConstraints = wanted
                ? { deviceId: { exact: wanted }, width: { ideal: 1920 }, height: { ideal: 1080 } }
                : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } };
            const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
            // Salir / page hidden / a newer start while the permission prompt or the camera was opening.
            if (stale()) { stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* stopped */ } }); return; }
            streamRef.current = stream;
            const el = videoRef.current;
            if (el) {
                el.srcObject = stream; el.setAttribute('playsinline', 'true'); el.muted = true;
                // Not awaited (a play() that never settles must not hold the scanner): a REFUSED play
                // (iOS Low Power Mode, autoplay rules) leaves a black video — ask for a tap instead of
                // swallowing it. An AbortError only means a newer start replaced this stream.
                const p = el.play();
                if (p && typeof p.then === 'function') p.then(() => { if (!stale()) setPlayBlocked(false); }, (err: any) => { if (!stale() && err?.name !== 'AbortError') setPlayBlocked(true); });
            }
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
            meter.current.start();
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
        // iOS ignores overflow:hidden on <body>: pin the page (position:fixed at -scrollY, restored on close).
        const releaseScroll = lockBodyScroll();
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
            releaseScroll();
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
        if (id !== serviceId) { onServiceChange(id); router.current.reset(); }
        setOutcome(null); setSheet(null);
    };
    // The heartbeat: twice a second while the camera is on, from what the decode loop really did.
    useEffect(() => {
        if (cam !== 'on') { setHealth(null); return; }
        const tick = () => setHealth((h) => {
            const n = meter.current.health();
            return h && h.state === n.state && h.fps === n.fps ? h : n;
        });
        tick();
        const h = setInterval(tick, 500);
        return () => clearInterval(h);
    }, [cam]);
    // «Toca para activar la cámara»: play() again, now inside a tap (and unlock the audio with it).
    const activateVideo = () => {
        feedback.current.prime();
        const el = videoRef.current;
        if (!el) return;
        const p = el.play();
        if (p && typeof p.then === 'function') p.then(() => { if (aliveRef.current) { setPlayBlocked(false); meter.current.start(); } }, () => { /* still refused: the button stays */ });
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
    // Structural styles are INLINE: on the live site the plugin's Tailwind classes did not exist and this
    // screen was a transparent band of camera over the page (see SCANNER_ROOT_STYLE).
    const fill: React.CSSProperties = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 };
    const centred: React.CSSProperties = { ...fill, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, textAlign: 'center' };
    const scanning = cam === 'on' && !playBlocked && health?.state === 'scanning';
    return createPortal(
        <div ref={rootRef} tabIndex={-1} className="fixed inset-0 z-[6000] bg-black text-white flex flex-col select-none outline-none" style={SCANNER_ROOT_STYLE} role="dialog" aria-modal="true" aria-label={tx('meals.scanner', 'Modo escáner')} data-meal-scanner="" data-engine={engine}
            onPointerDown={() => feedback.current.prime()}>
            <style>{SCANNER_CSS}</style>
            {/* Top: service + exit */}
            <div className="flex items-center gap-2 px-3 pt-[max(env(safe-area-inset-top),0.75rem)] pb-2 bg-black/80" style={{ ...SCANNER_BAR_STYLE, display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 12, paddingBottom: 8, paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
                <button type="button" onClick={() => setSheet('service')} className="flex-1 min-w-0 text-left px-4 py-3 rounded-2xl bg-white/10 active:bg-white/20" style={{ flex: '1 1 0%', minWidth: 0 }} aria-label={tx('meals.scanner.change.service', 'Cambiar servicio')}>
                    <span className="block text-[10px] font-black uppercase tracking-widest text-white/60" style={{ display: 'block' }}>{tx('meals.scanner.service', 'Servicio')}</span>
                    <span className="block text-base font-black truncate" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{service ? serviceName(tx, service, language) : tx('meals.scanner.pick', 'Elige un servicio')}</span>
                </button>
                <button type="button" onClick={onClose} className="px-4 py-3 rounded-2xl bg-white/10 active:bg-white/20 font-black text-sm" aria-label={tx('meals.scanner.exit', 'Salir')}>
                    <i className="fa-solid fa-xmark mr-1.5" aria-hidden="true"></i>{tx('meals.scanner.exit', 'Salir')}
                </button>
            </div>

            {/* Counters */}
            <div className="grid grid-cols-3 gap-2 px-3 pb-2 text-center bg-black/80" style={{ ...SCANNER_BAR_STYLE, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, paddingLeft: 12, paddingRight: 12, paddingBottom: 8, textAlign: 'center' }}>
                {[[tx('meals.count.delivered', 'Entregados'), stats?.delivered], [tx('meals.count.entitled', 'Con derecho'), stats?.entitled], [tx('meals.count.pending', 'Pendientes'), stats?.pending]].map(([label, n]: any) => (
                    <div key={label} className="rounded-xl bg-white/10 py-1.5">
                        <div className="text-xl font-black tabular-nums">{n ?? '—'}</div>
                        <div className="text-[9px] font-black uppercase tracking-widest text-white/60">{label}</div>
                    </div>
                ))}
            </div>

            {/* Camera — no page panning or pinch-zoom on it (touch-action), the bars and sheets keep theirs */}
            <div className="relative flex-1 min-h-0 overflow-hidden" data-camera-area="" style={{
                position: 'relative', flex: '1 1 0%', minHeight: 0, overflow: 'hidden', touchAction: 'none',
                boxShadow: flash === 'ok' ? 'inset 0 0 0 8px #10b981' : flash === 'bad' ? 'inset 0 0 0 8px #f43f5e' : 'none',
            }}>
                <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" style={{ ...fill, width: '100%', height: '100%', objectFit: 'cover', opacity: cam === 'on' ? 1 : 0 }} playsInline muted aria-hidden="true" />
                {cam === 'on' && !playBlocked && health?.state !== 'stalled' && (
                    <div style={{ ...fill, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, pointerEvents: 'none' }}>
                        <AimFrame frameRef={aimRef} scanning={scanning} />
                        <ScanPill health={health} tx={tx} />
                        <div style={{ maxWidth: 320, margin: '0 16px', padding: '4px 10px', borderRadius: 10, background: 'rgba(0,0,0,0.55)', textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.85)' }}>
                            {tx('meals.scanner.focus.hint', 'Mantén el código recto a unos 15–20 cm: más cerca la cámara no enfoca.')}
                        </div>
                    </div>
                )}
                {cam === 'on' && (
                    <div style={{ position: 'absolute', top: 12, left: 0, right: 0, textAlign: 'center', fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.85)', pointerEvents: 'none', textShadow: '0 1px 2px #000' }}>{tx('meals.scanner.aim', 'Apunta al código de barras del participante')}</div>
                )}
                {cam === 'on' && read && (
                    <div style={{ position: 'absolute', top: 40, left: 12, right: 72, zIndex: 1 }}>
                        <ReadCard read={read} tx={tx} onDismiss={() => setRead(null)} />
                    </div>
                )}
                {cam === 'starting' && <div style={{ ...centred, color: 'rgba(255,255,255,0.75)', fontWeight: 700 }}><span><i className="fa-solid fa-camera mr-2 animate-pulse" aria-hidden="true"></i>{tx('meals.camera.starting', 'Abriendo la cámara…')}</span></div>}
                {camMessage && cam !== 'starting' && (
                    <div style={centred}>
                        <i className="fa-solid fa-video-slash text-4xl text-white/60" aria-hidden="true" style={{ fontSize: 36, opacity: 0.7 }}></i>
                        <p className="text-base font-bold text-white/90 max-w-sm" style={{ fontSize: 16, fontWeight: 700, maxWidth: 384, margin: 0 }}>{camMessage}</p>
                        {(cam === 'denied' || cam === 'error' || cam === 'off') && (
                            <button type="button" onClick={() => startCamera(deviceId || undefined)} className="px-5 py-3 rounded-2xl bg-white text-black font-black text-sm" style={{ background: '#fff', color: '#000' }}>{tx('meals.camera.retry', 'Reintentar')}</button>
                        )}
                    </div>
                )}
                {cam === 'on' && (
                    <CameraNotice health={health} playBlocked={playBlocked} tx={tx} onActivate={activateVideo} onRetry={() => startCamera(deviceId || undefined)} />
                )}
                {cam === 'on' && (
                    <div className="absolute right-3 top-10 flex flex-col gap-2" style={{ position: 'absolute', right: 12, top: 40, zIndex: 3, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {torch.supported && (
                            <button type="button" onClick={toggleTorch} className={`w-12 h-12 rounded-full flex items-center justify-center ${torch.on ? 'bg-yellow-300 text-black' : 'bg-black/60 text-white'}`} style={{ width: 48, height: 48, borderRadius: 999, background: torch.on ? '#fde047' : 'rgba(0,0,0,0.6)', color: torch.on ? '#000' : '#fff' }} aria-pressed={torch.on} aria-label={tx('meals.camera.torch', 'Linterna')}>
                                <i className="fa-solid fa-bolt" aria-hidden="true"></i>
                            </button>
                        )}
                        {devices.length > 1 && (
                            <button type="button" onClick={switchCamera} className="w-12 h-12 rounded-full bg-black/60 text-white flex items-center justify-center" style={{ width: 48, height: 48, borderRadius: 999, background: 'rgba(0,0,0,0.6)', color: '#fff' }} aria-label={tx('meals.camera.switch', 'Cambiar de cámara')}>
                                <i className="fa-solid fa-camera-rotate" aria-hidden="true"></i>
                            </button>
                        )}
                    </div>
                )}

                {/* Verdict over the bottom third */}
                {outcome && (
                    <div className="absolute left-3 right-3 bottom-3" style={{ position: 'absolute', left: 12, right: 12, bottom: 12, zIndex: 4 }}>
                        <VerdictCard outcome={outcome} service={service} large busy={busy} language={language}
                            onForce={outcome.result === 'not_entitled' ? force : undefined}
                            onArmedChange={(a) => { armedRef.current = !!a; }}
                            onUndo={undo}
                            onDismiss={() => setOutcome(null)} />
                    </div>
                )}
            </div>

            {/* Bottom actions */}
            <div className="grid grid-cols-2 gap-2 px-3 pt-2 pb-[max(env(safe-area-inset-bottom),0.75rem)] bg-black/80" style={{ ...SCANNER_BAR_STYLE, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' }}>
                <button type="button" onClick={() => { setTyped(''); setSheet('code'); }} className="py-4 rounded-2xl bg-white/10 active:bg-white/20 font-black text-sm">
                    <i className="fa-solid fa-keyboard mr-2" aria-hidden="true"></i>{tx('meals.scanner.type', 'Escribir código')}
                </button>
                <button type="button" onClick={() => setSheet('search')} className="py-4 rounded-2xl bg-white/10 active:bg-white/20 font-black text-sm">
                    <i className="fa-solid fa-magnifying-glass mr-2" aria-hidden="true"></i>{tx('meals.scanner.search', 'Buscar por nombre')}
                </button>
            </div>

            {/* Sheets */}
            {sheet && (
                <div className="absolute inset-0 z-10 bg-black/70 flex items-end" style={{ ...fill, zIndex: 10, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end' }} onClick={() => setSheet(null)}>
                    <div className="w-full max-h-[85%] overflow-y-auto rounded-t-3xl bg-gray-900 p-4 pb-[max(env(safe-area-inset-bottom),1rem)] space-y-3" style={{ width: '100%', maxHeight: '85%', overflowY: 'auto', overscrollBehavior: 'contain', borderRadius: '24px 24px 0 0', background: '#111827', paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }} onClick={(e) => e.stopPropagation()}>
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
