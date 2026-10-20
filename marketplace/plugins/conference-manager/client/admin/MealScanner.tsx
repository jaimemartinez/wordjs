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
 *
 * 2.16.0 («apenas lee un código enseguida sale entregado»): with «Confirmar antes de entregar» (default ON,
 * per device, shared with «Entrega») a read registration code only ASKS the server (POST /meals/check,
 * read-only) and opens `ConfirmCard` over the camera — the meal, the person's data the meals manager chose
 * («Qué se muestra al entregar») and the status — with «Entregar» / «Cancelar» («Entregar sin derecho
 * (autorizar)» / «Cancelar» without entitlement, «Cerrar» for the rest). Decoding pauses while it is open;
 * «Cancelar» records nothing and the badge must leave the view before it opens a card again (shown again,
 * it says so). The state machine is lib/mealConfirm.ts (createConfirmFlow). With the toggle OFF, a scan
 * delivers at once (2.15.x). On a short phone the card takes the whole camera area (the counters fold away)
 * and the person's name sits above the part that scrolls; its buttons — and those of the «Entregado» card
 * that follows — ignore taps for a moment after they appear, so an impatient second tap cannot «Deshacer».
 *
 * 2.17.0 («en últimas entregas no muestra qué se le entregó»): the «Entregado» and «Ya recibió» cards name
 * the meal under their title («Desayuno · Vie 11/12», `mealLine`), here and in «Entrega»; «Últimas
 * entregas» (RecentDeliveries.tsx) names it on every row. Over the camera the verdict card is bounded by the
 * camera area like the confirmation card and, on every phone from 320×460 up, shows without scrolling its
 * status, the meal, the person's NAME and all its buttons — 44 px targets; the person's other data give way
 * and scroll (VERDICT_FIT), ending on a whole line with «Más abajo» under the cut (useWholeEntries). So does
 * the confirmation card: its status and the name are its own header, no longer inside the part that scrolls
 * (on a 320×460 phone that part was shorter than the header and the name was cut or hidden), the meal keeps
 * to one line on a short phone, and «Entregar sin derecho (autorizar)» reads «Autorizar» there (CONFIRM_CSS) and
 * wherever it would take more than two lines — every phone width (useLabelFit). WHY a not-entitled person has no
 * right to the meal is a line of that header, never one of the data that give way (CONFIRM_WHY_STYLE).
 * The camera's aiming hint hides while a card reaches it. A tap on the meal shows it whole on both cards
 * (useOpenMeal: only when the card cannot hold it, its whole lines that fit, «Más abajo» and a scroll).
 * «Entrega»'s verdict card is bounded the same way (VERDICT_BOX) and capped by the tab to the visible band, and
 * its confirmation card keeps «Cancelar» / «Entregar» inside a 320 px phone's card.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { conferenceApi } from "../lib/conference";
import { createReadRouter, createScanMeter, normalizeCode, scanLoopDelay, sortServices, stampTime, verdictTone, groupByDay } from "../lib/meals";
import {
    CONFIRM_PREF_EVENT, CONFIRM_PREF_KEY, LABEL_MAX_LINES, MORE_CUE_PX, REVEAL_MARGIN_PX, TAP_ARM_MS, VERDICT_TAP_ARM_MS, createConfirmFlow, detailsStale, displayLabel, displayValue, holdAfterClose, isDecision,
    labelTooLong, measureDetails, openMealCut, readConfirmPref, revealAsk, revealNearest, splitPersonFields, tapArmed, textLineBottoms, writeConfirmPref,
    type DetailsFit,
} from "../lib/mealConfirm";
import { aimCrop, decodeVideoRegion, formatLabel } from "../lib/barcodeScan";
import { decodeQrVideoRegion, qrSquare } from "../lib/qrScan";
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
 * WHAT was delivered, the meal first: «Desayuno · Vie 11/12» (« — label» after the meal). The rows of
 * «Últimas entregas» and the «Entregado» / «Ya recibió» cards name the meal with it.
 */
export const mealLine = (tx, s, language?: string) =>
    s ? `${mealName(tx, s.meal)}${s.label ? ` — ${s.label}` : ''} · ${dayLabel(s.service_date, language)}` : '';
/** How a delivery was recorded: «Escaneo» (a code), «Manual» (picked by name), «Sin derecho (autorizado)». */
export const methodLabel = (tx, m) =>
    m === 'scan' ? tx('meals.method.scan', 'Escaneo') : m === 'manual' ? tx('meals.method.manual', 'Manual') : m === 'override' ? tx('meals.method.override', 'Sin derecho (autorizado)') : (m || '');

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

// ── Confirmation (2.16.0) ────────────────────────────────────────────────────────────────────────────
/** POST /meals/check → the card's result; like useMealDelivery, every failure becomes a result (never throws). */
export async function checkMealOutcome(body: { service_id: number; code?: string; inscription_id?: number }) {
    try {
        const v = await conferenceApi.checkMeal(body);
        return { result: v?.result || 'error', verdict: v };
    } catch (e: any) {
        if (e?.status === 404) return { result: 'no_service', message: e?.message };
        if (isOffline(e)) return { result: 'offline', message: e?.message };
        return { result: 'error', message: e?.message };
    }
}

/**
 * The confirmation state machine (lib/mealConfirm.ts) bound to the API and to React state. The handlers are
 * read through a ref, so the flow is created once per screen. Unmounting RESETS it (an answer that lands
 * after the screen is gone is dropped) instead of disposing it: StrictMode unmounts and remounts effects once
 * in development while the memoised flow survives, and a disposed flow would ignore every scan after that.
 */
export function useConfirmFlow({ queue = false, onCheck, onResult, onClose }: any = {}) {
    const deliver = useMealDelivery();
    const handlers = useRef({ onCheck, onResult, onClose, deliver });
    handlers.current = { onCheck, onResult, onClose, deliver };
    const [state, setState] = useState<any>({ card: null, waiting: 0, checking: false, delivering: false, held: false, heldAt: null, settling: false });
    const flow = useMemo(() => createConfirmFlow({
        queue,
        check: (serviceId, body) => checkMealOutcome({ service_id: serviceId, ...body }),
        deliver: (serviceId, body) => handlers.current.deliver({ service_id: serviceId, ...body }),
        onChange: (s) => setState(s),
        onCheck: (card) => handlers.current.onCheck?.(card),
        onResult: (outcome, card) => handlers.current.onResult?.(outcome, card),
        onClose: (card, why) => handlers.current.onClose?.(card, why),
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), []);
    useEffect(() => () => flow.reset(), [flow]);
    return [flow, state] as const;
}

/** «Confirmar antes de entregar»: per device (localStorage, guarded), default ON, shared by every screen. */
export function useConfirmPref(): [boolean, (on: boolean) => void] {
    const [on, setOn] = useState<boolean>(() => readConfirmPref());
    useEffect(() => {
        if (typeof window === 'undefined') return;
        // The event carries the value: with storage blocked a re-read would always say ON.
        const onPref = (e: any) => setOn(typeof e?.detail === 'boolean' ? e.detail : readConfirmPref());
        const onStorage = (e: any) => { if (!e || e.key === CONFIRM_PREF_KEY) setOn(readConfirmPref()); };
        window.addEventListener(CONFIRM_PREF_EVENT, onPref);
        window.addEventListener('storage', onStorage);
        return () => { window.removeEventListener(CONFIRM_PREF_EVENT, onPref); window.removeEventListener('storage', onStorage); };
    }, []);
    const set = useCallback((v: boolean) => { setOn(!!v); writeConfirmPref(!!v); }, []);
    return [on, set];
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
        /**
         * 2.16.0: a person is ready to be confirmed («Puede recibir esta comida»): two rising tones and a
         * double pulse — by ear, never the blip of a barcode that is not a registration code.
         */
        attention: () => { tone(660, 0, 0.08); tone(990, 0.1, 0.1); vibrate([30, 40, 30]); },
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
 * 2.17.0 — the phone scanner's verdict card fits the room it is given: the camera area (the verdict slot,
 * bounded like the confirmation card's). The live round on short phones (iPhone SE in Safari 375×548 and
 * 375×667, a first-generation SE 320×460, an iPhone 13 in Safari 390×664) found it scrolling the person's
 * name and location away, cutting a not-entitled head («Sin derecho a Jue 08/10 · Almuerzo — …») mid-phrase
 * with no cue and hiding «Sí, entregar» / «Cancelar». Now, on every phone from 320×460 up and without
 * scrolling inside the card:
 *   - the HEAD never shrinks: the icon and a SHORT status — «Entregado», «Ya recibió», «Sin derecho» — then
 *     WHAT: the meal line «Almuerzo — label · Jue 08/10» (up to three lines; on a short screen ONE line where
 *     only the label gives way, with an ellipsis, the meal and the day stay; a tap shows it WHOLE — useOpenMeal
 *     — and the whole text is its title and its accessible text), and «Sin derecho (autorizado)» for an override;
 *   - the person's NAME is its own line under the head, never in the part that scrolls: it gives way LAST,
 *     and never below one line;
 *   - the person's other data (location, the configured entries, «Recibió a las…», the unknown code) give way
 *     FIRST, and scroll — WHOLE entries only, «Más abajo ↓» under the cut, left out when not even one fits
 *     (useWholeEntries; never a lone label or the tops of a value); the armed question takes all their room
 *     before it loses a sentence (askGiveWay);
 *   - the buttons never shrink and are 44 px targets: «Deshacer», «Entregar de todas formas» and, once armed,
 *     «Sí, entregar» / «Cancelar» side by side under a short question — the card already names the person,
 *     the meal and «Sin derecho»; the whole question is the dialog's accessible name. The question gives way
 *     before the name, by whole sentences (ASK_LEVELS), its box never below its buttons (VERDICT_ASK_MIN).
 * `flex-shrink` weights set that order (100000 → 1000 → 1). Short screens get a tighter card whose body is no
 * longer indented under the icon: the whole width for the name (VERDICT_CSS). «Entrega»'s card (VERDICT_BOX)
 * gives way in the same order inside the cap its tab sets (desktop keeps its sizes and layout), and its
 * «¿Entregar de todas formas?», which opens under the button that was tapped, spans the card's whole width
 * (no longer indented under the icon: at 320 px it was a 16-line column), asks the short question (the card
 * names the person and the service right above; the whole sentence is its accessible name), gives way by whole
 * sentences inside the cap (askStepDown; on a phone its two buttons share a row) and scrolls into view with the
 * card — the question alone, or its buttons, only when the card is taller than the screen (revealAsk).
 * Structure INLINE (see SCANNER_ROOT_STYLE); the media rules ship with the card.
 */
/** The armed question's box at its smallest — its buttons alone: border 2 + padding 2 × 12 + the 44 px buttons. */
export const VERDICT_ASK_MIN = 70;
export const VERDICT_FIT: Record<string, React.CSSProperties> = {
    card: { display: 'flex', flexDirection: 'column', maxHeight: '100%', minHeight: 0, overflowY: 'auto' },
    row: { display: 'flex', alignItems: 'flex-start', gap: 16, flexShrink: 0 },
    icon: { flexShrink: 0, width: 48, textAlign: 'center' },
    head: { minWidth: 0, flex: '1 1 0%' },
    body: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '0 1 auto', paddingLeft: 64 },
    name: { flex: '0 1 auto', minHeight: '1.15em', overflowY: 'auto', fontSize: 26, fontWeight: 900, lineHeight: 1.15, overflowWrap: 'anywhere', marginTop: 6 },
    scroll: { position: 'relative', overflowY: 'auto', minHeight: 0, flex: '0 100000 auto' },
    actions: { flexShrink: 0 },
    ask: { display: 'flex', flexDirection: 'column', gap: 8, flex: '0 1000 auto', minHeight: VERDICT_ASK_MIN, marginTop: 12, marginLeft: -64, padding: 12 },
    askText: { flex: '0 1 auto', minHeight: 0, overflow: 'hidden' },
    askButtons: { display: 'flex', gap: 8, flexShrink: 0 },
    askButton: { flex: '1 1 auto', minWidth: 0, minHeight: 44, paddingLeft: 10, paddingRight: 10, letterSpacing: '0.06em' },
    target: { minHeight: 44 },
};
/**
 * 2.17.0 — «Entrega»'s verdict card (not large), bounded like its confirmation card. The live round at 320×460
 * found it 888 px tall: its body sat in a 124 px column under the icon (the name broke mid-word, «Villavicen /
 * cio»; the meal took six lines) and «Deshacer» was 450 px below the fold. Now the tab caps it to the visible
 * band (REVEAL_FIT_VAR, cardEssentials) and it gives way inside that cap in the phone scanner's order: the
 * person's other data first (whole entries, «Más abajo» under the cut), then an open question's sentences (whole
 * ones, askStepDown), the name last (never below one line); the head and the buttons never. The tab caps it
 * whether the confirmation is ON or OFF (decisionSlotKey). Its status is short — «Sin derecho» too, with the meal
 * line under it like «Entregado» (2.17.0: «Sin derecho a Jue 08/10 · Almuerzo — …» took 8 lines beside the icon at
 * 320 px). The name breaks only between words (inside one only when a
 * single word is wider than the card). On a phone (VERDICT_CSS) its body takes the card's whole width and the
 * meal keeps to one line where only its label gives way (a tap shows it whole). Desktop: as before — the body
 * in line with the title (the icon's 36 px + the 16 px gap), the meal whole.
 */
export const VERDICT_BOX: Record<string, React.CSSProperties> = {
    card: { display: 'flex', flexDirection: 'column', maxHeight: '100%', minHeight: 0, overflowY: 'auto', scrollMarginTop: REVEAL_MARGIN_PX, scrollMarginBottom: REVEAL_MARGIN_PX },
    row: { flexShrink: 0 },
    icon: { flexShrink: 0, width: 36, textAlign: 'center' },
    body: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '0 1 auto', paddingLeft: 52 },
    name: { flex: '0 1 auto', minHeight: '1.15em', overflowY: 'auto', fontSize: 22, fontWeight: 900, lineHeight: 1.15, overflowWrap: 'break-word', marginTop: 4 },
    scroll: VERDICT_FIT.scroll,
    actions: { flexShrink: 0 },
    ask: { flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, scrollMarginTop: REVEAL_MARGIN_PX, scrollMarginBottom: REVEAL_MARGIN_PX },
    askButtons: { display: 'flex', flexWrap: 'wrap', gap: 8, scrollMarginTop: REVEAL_MARGIN_PX, scrollMarginBottom: REVEAL_MARGIN_PX },
};
/** A server without the configured entries (2.15): the plain name as «Entrega» always showed it (20 px, bold). */
VERDICT_BOX.plainName = { ...VERDICT_BOX.name, fontSize: 20, fontWeight: 700, lineHeight: 1.4 };
/** How many px of an element's content it cannot show (it scrolls inside itself, or clips): 0 for none. */
export const clippedPx = (el: { scrollHeight: number; clientHeight: number } | null | undefined): number =>
    (el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0);
/**
 * The meal line shown whole on a tap, on both cards (lib/mealConfirm textLineBottoms / openMealCut). The live
 * round at 320×460 found it cut after two lines, mid-phrase, with no cue (a fixed max-height). Now `open` shows it
 * WHOLE — the person's other data give way to it — and, after every layout while it is open and the card's
 * essentials lack `over()` px (the name scrolling inside itself, the card or its header clipping), it keeps the
 * whole lines that fit (`cap`) with «Más abajo ↓» under them and scrolls to the rest; when not even one line
 * fits it closes again (the name always wins). A new card (`key`) closes it; another window size measures it
 * again from whole. `atEnd`: scrolled to its end, the cue says nothing more. `cuePx`: the room the cue takes
 * (none in the confirmation card's band, where it sits at the end of the day's line).
 */
export function useOpenMeal(key: unknown, over: () => number, cuePx = MORE_CUE_PX) {
    const [open, setOpen] = useState(false);
    const [cap, setCap] = useState<number | null>(null);
    const [atEnd, setAtEnd] = useState(false);
    const ref = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => { setOpen(false); }, [key]);
    useLayoutEffect(() => { setCap(null); setAtEnd(false); }, [key, open]);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!open || !el) return;
        const cut = openMealCut(textLineBottoms(el), el.clientHeight, over(), cap != null, cuePx);
        if (cut == null) return;
        if (cut > 0) setCap(cut); else setOpen(false);
    });
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const refit = () => { setCap(null); setAtEnd(false); };
        window.addEventListener('resize', refit);
        return () => window.removeEventListener('resize', refit);
    }, []);
    const onScroll = useCallback(() => {
        const el = ref.current;
        if (el) setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight <= 2);
    }, []);
    return { open, setOpen, cap, atEnd, ref, onScroll };
}
/** The open meal line as it is shown: whole, or cut on a whole line and scrolling (useOpenMeal `cap`). */
export const openMealStyle = (cap: number | null): React.CSSProperties | undefined =>
    (cap != null ? { maxHeight: cap, overflowY: 'auto' } : undefined);
/** «Más abajo ↓» on the coloured verdict card: small capitals in the card's own colour. */
export const VERDICT_MORE_STYLE: React.CSSProperties = { fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase' };
/**
 * The person's other data on both cards show WHOLE entries (lib/mealConfirm wholeEntries): measured after
 * layout, the part that scrolls (`ref`) is cut at the bottom of the last entry that fits with the «Más abajo»
 * line under it, or left out when not even one does. `key` — a new card, the question armed, the meal line
 * opened or closed — and another window size measure it again from the uncut layout (`fit` null renders it
 * uncut). «Entrega» caps its card in ITS layout effect, after this card's: a room that changed since is
 * measured again after paint (detailsStale). `atEnd`: scrolled to its end, the line says nothing more.
 */
export function useWholeEntries(key: unknown) {
    const ref = useRef<HTMLDivElement | null>(null);
    const [fit, setFit] = useState<DetailsFit | null>(null);
    const [atEnd, setAtEnd] = useState(false);
    useLayoutEffect(() => { setFit(null); setAtEnd(false); }, [key]);
    useLayoutEffect(() => {
        if (fit) return;
        const el = ref.current;
        if (el) setFit(measureDetails(el));
    });
    useEffect(() => {
        const el = ref.current;
        if (el && fit && detailsStale(fit, el)) setFit(null);
    });
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const refit = () => { setFit(null); setAtEnd(false); };
        window.addEventListener('resize', refit);
        return () => window.removeEventListener('resize', refit);
    }, []);
    const onScroll = useCallback(() => {
        const el = ref.current;
        if (el) setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight <= 2);
    }, []);
    return { ref, fit, atEnd, onScroll };
}
/** The part that scrolls, for what was measured: uncut (or not measured yet), or cut at the last whole entry. */
export const detailsStyle = (base: React.CSSProperties, fit: DetailsFit | null): React.CSSProperties =>
    (fit && fit.height != null ? { ...base, maxHeight: fit.height } : base);
/** Whether the part is shown (left out when not even one entry fits) and whether «Más abajo» goes under it. */
export const detailsShown = (fit: DetailsFit | null) => !fit || fit.height !== 0;
export const detailsMore = (fit: DetailsFit | null) => !!fit && !!fit.height && fit.hidden > 0;
/**
 * «Más abajo ↓» under the cut (MORE_CUE_PX tall, never shrinks): some of the person's data are below, scroll
 * them. Hidden — its room kept — once they are scrolled to their end. Not a control (aria-hidden).
 */
export function MoreCue({ atEnd = false, attr, style }: any) {
    const tx = useTx();
    return (
        <div {...{ [attr]: '' }} aria-hidden="true" style={{
            flexShrink: 0, height: MORE_CUE_PX, lineHeight: `${MORE_CUE_PX}px`, overflow: 'hidden', whiteSpace: 'nowrap', fontWeight: 900,
            visibility: atEnd ? 'hidden' : undefined, ...style,
        }}>
            {tx('meals.confirm.more', 'Más abajo')} <i className="fa-solid fa-arrow-down" aria-hidden="true"></i>
        </div>
    );
}
/**
 * The armed question («¿Entregar de todas formas?» + «Quedará registrado como autorizado.») gives way by
 * WHOLE sentences: level 0 shows both, 1 the question, 2 none — the buttons stay, and the dialog's accessible
 * name always holds the whole question with the person and the service. A level is cut when its text needs
 * more than 2 px beyond the room it got.
 */
export const ASK_LEVELS = 3;
export const askClipped = (el: { scrollHeight: number; clientHeight: number } | null | undefined): boolean =>
    !!el && el.scrollHeight > el.clientHeight + 2;
/**
 * What gives way next while the armed question is cut: the person's other data first — ALL of them, they
 * come last — and only then a sentence of the question (null: it is not cut).
 */
export const askGiveWay = (clipped: boolean, detailsShown: boolean): 'details' | 'sentence' | null =>
    (!clipped ? null : detailsShown ? 'details' : 'sentence');
/**
 * «Entrega»'s armed question (2.17.0 live round: with the confirmation OFF, at 320×460 … 390×664, the status and
 * the name sat above the top edge while it was open): the level it shows next — one more WHOLE sentence gone while
 * the card its tab capped lacks `over` px for it (the name or the card scrolling inside itself; 2 px is rounding),
 * never below none (ASK_LEVELS); its buttons always stay.
 */
export const askStepDown = (level: number, over: number): number =>
    (over > 2 && level < ASK_LEVELS - 1 ? level + 1 : level);
/**
 * The phone scanner's «¿Entregar de todas formas?» (VERDICT_FIT.ask), once armed: the question as much as
 * fits — `level` 0 both sentences, 1 the question, 2 none (ASK_LEVELS) — over «Sí, entregar» / «Cancelar» side
 * by side. `label` (the dialog's accessible name) is the whole question, with the person and the service.
 */
export function ForceAsk({ level = 0, label, yes, no, askRef, textRef }: any) {
    const tx = useTx();
    return (
        <div ref={askRef} className="rounded-2xl bg-amber-950/10 border border-amber-950/20" style={VERDICT_FIT.ask} role="alertdialog" aria-label={label} data-verdict-ask="">
            {level < 2 && (
                <p ref={textRef} className="text-sm font-bold" style={VERDICT_FIT.askText} data-verdict-ask-text={level}>
                    {tx('meals.force.confirm.ask', '¿Entregar de todas formas?')}
                    {level === 0 && <span className="font-semibold">{' '}{tx('meals.force.confirm.note', 'Quedará registrado como autorizado.')}</span>}
                </p>
            )}
            <div style={VERDICT_FIT.askButtons}>{yes}{no}</div>
        </div>
    );
}
/**
 * «Entrega»'s «¿Entregar de todas formas?» (VERDICT_BOX.ask), once armed: the card's whole width, the question
 * as much as the capped card holds — `level` 0 both sentences, 1 the question, 2 none (askStepDown) — over
 * «Sí, entregar» / «Cancelar» (on a phone side by side, VERDICT_CSS). `label` (the dialog's accessible name) is
 * the whole question, with the person and the service.
 */
export function DeliveryForceAsk({ level = 0, label, yes, no, askRef, buttonsRef }: any) {
    const tx = useTx();
    return (
        <div ref={askRef} className="mt-3 rounded-2xl bg-amber-950/10 border border-amber-950/20 p-3" style={VERDICT_BOX.ask} role="alertdialog" aria-label={label} data-verdict-ask="">
            {level < 2 && (
                <p className="text-sm font-bold" data-verdict-ask-text={level}>
                    {tx('meals.force.confirm.ask', '¿Entregar de todas formas?')}
                    {level === 0 && <span className="font-semibold">{' '}{tx('meals.force.confirm.note', 'Quedará registrado como autorizado.')}</span>}
                </p>
            )}
            <div ref={buttonsRef} style={VERDICT_BOX.askButtons} data-verdict-ask-buttons="">{yes}{no}</div>
        </div>
    );
}
/**
 * The meal line (up to three lines; tapped: WHOLE — useOpenMeal), and the short screens — the phones whose
 * scanner folds its counters for a confirmation card (an iPhone SE shows 375×667, 375×548 in Safari; an iPhone 13
 * 390×664 in Safari): tighter paddings, a smaller icon beside the head, smaller text, the meal on ONE line (only
 * its label gives way), the body under the icon at full width. The shortest (a first-generation SE in Safari,
 * 320×460): tighter still. Narrow ones: the armed buttons' labels fit side by side. Inline styles win over a
 * stylesheet, hence !important. The large card changes with the screen's height; «Entrega»'s (not large) only
 * on a phone (≤ 600 px wide; VERDICT_BOX): a smaller icon beside the status, then the meal and the body at the
 * card's whole width (a 320 px phone leaves 144 px beside the icon) — the meal on one line where only its label
 * gives way, with an ellipsis (a tap shows it whole); where not even the meal and the day fit on one line, the
 * day goes to a second one, whole: never cut, never past the card's edge. On the narrowest (≤ 380 px: a 184 px
 * line at 320) the closed line leaves out the meal's icon, so the label keeps room for a whole «…». The armed
 * «Sí, entregar» / «Cancelar» of «Entrega» share a row on a phone, as wide as each other — a row of their own
 * only when not even their longest words fit side by side — and, on the narrowest, with smaller labels and
 * paddings (with their wide desktop labels they wrapped to two rows at 320 px, taking a name line's room twice).
 */
export const VERDICT_CSS = `
[data-verdict][data-verdict-large] [data-verdict-meal] { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; overflow-wrap: anywhere; margin-top: 2px; cursor: pointer; }
[data-verdict][data-verdict-large] [data-verdict-meal][data-open] { display: block; -webkit-line-clamp: none; }
[data-verdict][data-verdict-large] [data-verdict-meal-icon] { margin-right: 6px; }
@media (max-height: 700px) {
  [data-verdict][data-verdict-large] { padding: 16px !important; }
  [data-verdict][data-verdict-large] [data-verdict-row] { gap: 10px !important; align-items: center !important; }
  [data-verdict][data-verdict-large] [data-verdict-icon] { font-size: 36px !important; width: 36px !important; }
  [data-verdict][data-verdict-large] [data-verdict-title] { font-size: 24px !important; }
  [data-verdict][data-verdict-large] [data-verdict-meal] { font-size: 16px !important; }
  [data-verdict][data-verdict-large] [data-verdict-meal]:not([data-open]) { display: flex; align-items: baseline; white-space: pre; }
  [data-verdict][data-verdict-large] [data-verdict-meal]:not([data-open]) > * { flex-shrink: 0; }
  [data-verdict][data-verdict-large] [data-verdict-meal]:not([data-open]) > [data-verdict-meal-label] { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  [data-verdict][data-verdict-large] [data-verdict-body] { padding-left: 0 !important; }
  [data-verdict][data-verdict-large] [data-verdict-name] { font-size: 22px !important; margin-top: 8px !important; }
  [data-verdict][data-verdict-large] [data-verdict-scroll] [data-field] > span:last-child { font-size: 16px !important; }
  [data-verdict][data-verdict-large] [data-verdict-actions] > * { margin-top: 8px !important; }
  [data-verdict][data-verdict-large] [data-verdict-ask] { margin-top: 8px !important; margin-left: 0 !important; }
}
@media (max-height: 520px) {
  [data-verdict][data-verdict-large] { padding: 12px !important; }
  [data-verdict][data-verdict-large] [data-verdict-icon] { font-size: 30px !important; width: 30px !important; }
  [data-verdict][data-verdict-large] [data-verdict-title] { font-size: 22px !important; }
  [data-verdict][data-verdict-large] [data-verdict-meal] { font-size: 15px !important; }
  [data-verdict][data-verdict-large] [data-verdict-name] { font-size: 20px !important; margin-top: 6px !important; }
  [data-verdict][data-verdict-large] [data-verdict-ask] { padding: 8px !important; gap: 6px !important; min-height: 62px !important; }
}
@media (max-width: 380px) {
  [data-verdict][data-verdict-large] [data-verdict-ask] button { font-size: 11px !important; letter-spacing: 0.03em !important; padding-left: 6px !important; padding-right: 6px !important; }
}
@media (max-width: 600px) {
  [data-verdict]:not([data-verdict-large]) { padding: 16px !important; }
  [data-verdict]:not([data-verdict-large]) [data-verdict-row] { display: grid !important; grid-template-columns: auto minmax(0, 1fr); gap: 0 10px !important; align-items: center !important; }
  [data-verdict]:not([data-verdict-large]) [data-verdict-head] { display: contents; }
  [data-verdict]:not([data-verdict-large]) [data-verdict-icon] { font-size: 30px !important; width: 30px !important; margin-top: 0 !important; }
  [data-verdict]:not([data-verdict-large]) [data-verdict-meal], [data-verdict]:not([data-verdict-large]) [data-verdict-method] { grid-column: 1 / -1; }
  [data-verdict]:not([data-verdict-large]) [data-verdict-meal] { font-size: 15px !important; margin-top: 6px !important; cursor: pointer; }
  [data-verdict]:not([data-verdict-large]) [data-verdict-meal]:not([data-open]) { display: flex; flex-wrap: wrap; align-items: baseline; white-space: pre; }
  [data-verdict]:not([data-verdict-large]) [data-verdict-meal]:not([data-open]) > * { flex: 0 0 auto; }
  [data-verdict]:not([data-verdict-large]) [data-verdict-meal]:not([data-open]) > [data-verdict-meal-label] { flex: 1 1 0%; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  [data-verdict]:not([data-verdict-large]) [data-verdict-body] { padding-left: 0 !important; }
  [data-verdict]:not([data-verdict-large]) [data-verdict-ask-buttons] > button { flex: 1 1 0%; }
}
@media (max-width: 380px) {
  [data-verdict]:not([data-verdict-large]) [data-verdict-meal] { font-size: 14px !important; }
  [data-verdict]:not([data-verdict-large]) [data-verdict-meal]:not([data-open]) > [data-verdict-meal-icon] { display: none; }
  [data-verdict]:not([data-verdict-large]) [data-verdict-ask] { padding: 8px !important; }
  [data-verdict]:not([data-verdict-large]) [data-verdict-ask] button { font-size: 11px !important; letter-spacing: 0.03em !important; padding-left: 6px !important; padding-right: 6px !important; }
}`;

/**
 * `onForce(outcome)` is called only after the inline confirmation; `onArmedChange(true|false)` lets the
 * phone scanner pause decoding while someone is deciding. `armMs` (2.16.0, when it follows a pressed
 * «Entregar» of the confirmation card): taps on it — «Deshacer», «Entregar de todas formas», dismiss — count
 * only once it has been on screen that long; «Deshacer» sits where «Entregar» was, and an impatient second
 * tap must not undo the delivery it just recorded. Without `armMs` (the immediate 2.15 delivery) nothing
 * changes. `large`: the phone scanner's card (VERDICT_FIT); else «Entrega»'s (VERDICT_BOX), which the tab caps
 * to the visible band.
 */
export function VerdictCard({ outcome, service, onForce, onUndo, onDismiss, onArmedChange, busy, large = false, language, armMs = 0 }: any) {
    const tx = useTx();
    const [armed, setArmed] = useState(false);
    /** How much of «¿Entregar de todas formas? Quedará registrado…» the phone scanner's card shows (ASK_LEVELS). */
    const [askLevel, setAskLevel] = useState(0);
    /** The person's other data left out while the armed question needs their room (askGiveWay). */
    const [dropDetails, setDropDetails] = useState(false);
    const askRef = useRef<HTMLDivElement | null>(null);
    const askTextRef = useRef<HTMLParagraphElement | null>(null);
    const askButtonsRef = useRef<HTMLDivElement | null>(null);
    const nameRef = useRef<HTMLDivElement | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);
    const seq = outcome?.seq;
    /** The meal line shown whole (a tap on it): whole, or its whole lines that fit with «Más abajo» (useOpenMeal). */
    const meal = useOpenMeal(seq, () => Math.max(clippedPx(nameRef.current), clippedPx(cardRef.current)));
    const mealOpen = meal.open;
    /** The person's other data: whole entries (useWholeEntries). */
    const restFit = useWholeEntries(`${seq}:${armed}:${mealOpen}:${meal.cap}`);
    // When THIS outcome appeared (a new seq = a new card).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const shownAt = useMemo(() => Date.now(), [seq]);
    const tapOk = () => tapArmed(shownAt, Date.now(), armMs);
    useEffect(() => { setArmed(false); }, [seq]);
    useEffect(() => { onArmedChange?.(armed); }, [armed]);
    useEffect(() => () => onArmedChange?.(false), []);
    // «Entrega»: «¿Entregar de todas formas?» opens under the button that was tapped. Once it has settled (the next
    // frame: the sentences that give way are gone), bring into view the whole card when it fits on screen — the
    // status and the name with the question — else the question, else its buttons (320×460; revealAsk). The phone
    // scanner's card fits its slot.
    useEffect(() => {
        if (!armed || large || typeof window === 'undefined') return;
        const reveal = () => { revealAsk(askRef.current, window, askButtonsRef.current, cardRef.current); };
        if (typeof window.requestAnimationFrame !== 'function') { reveal(); return; }
        const frame = window.requestAnimationFrame(reveal);
        return () => window.cancelAnimationFrame(frame);
    }, [armed, large]);
    // «Entrega»: the meal line shown whole makes the card taller — its buttons stay in view.
    useEffect(() => { if (mealOpen && !large && typeof window !== 'undefined') revealNearest(cardRef.current, window); }, [mealOpen, meal.cap, large]);
    // The phone scanner's card, after every layout: while the armed question would be cut, leave the person's
    // other data out, then step the question down by whole sentences (never a half line). A new card, a new
    // question, the meal line opened or closed, another window size: everything again, then as much as fits.
    useLayoutEffect(() => { setAskLevel(0); setDropDetails(false); }, [seq, armed, mealOpen]);
    useLayoutEffect(() => {
        if (!large) return;
        const way = askGiveWay(askClipped(askTextRef.current), !!restFit.ref.current);
        if (way === 'details') setDropDetails(true);
        else if (way === 'sentence') setAskLevel((l) => Math.min(ASK_LEVELS - 1, l + 1));
    });
    // «Entrega»'s card, after every layout: while the card its tab capped cannot hold the armed question with the
    // WHOLE name (the name or the card scrolls inside itself; the person's other data have already given way, they
    // shrink first), the question steps down by whole sentences — its buttons stay (askStepDown).
    useLayoutEffect(() => {
        if (large || !armed) return;
        const next = askStepDown(askLevel, Math.max(clippedPx(nameRef.current), clippedPx(cardRef.current)));
        if (next !== askLevel) setAskLevel(next);
    });
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const refit = () => { setAskLevel(0); setDropDetails(false); };
        window.addEventListener('resize', refit);
        return () => window.removeEventListener('resize', refit);
    }, []);
    if (!outcome) return null;
    const r = outcome.result;
    const v = outcome.verdict || {};
    const p = v.person;
    const tone = r === 'no_service' || r === 'error' ? 'bad' : verdictTone(r);
    const svc = service ? serviceName(tx, service, language) : '';
    const title =
        r === 'delivered' ? tx('meals.verdict.delivered', 'Entregado')
            : r === 'already' ? tx('meals.verdict.already', 'Ya recibió')
                : r === 'not_entitled' ? tx('meals.verdict.not_entitled.short', 'Sin derecho')
                    : r === 'cancelled' ? tx('meals.verdict.cancelled', 'Inscripción cancelada')
                        : r === 'unknown' ? tx('meals.verdict.unknown', 'Código no encontrado')
                            : r === 'other_conference' ? tx('meals.verdict.other_conference', 'Ese código es de otra conferencia')
                                : r === 'offline' ? tx('meals.verdict.offline', 'Sin conexión — vuelve a escanear')
                                    : r === 'no_service' ? tx('meals.verdict.no_service', 'Servicio no encontrado: elige otro')
                                        : (outcome.message || tx('meals.verdict.error', 'No se pudo registrar'));
    // WHAT was delivered (or already received, or what a not-entitled person has no right to — its status is
    // short on both cards; 2.17.0 live round: «Entrega»'s «Sin derecho a Jue 08/10 · Almuerzo — …» took 8 lines,
    // 240 px, in the 144 px beside the icon at 320×460): the service the server answered for, else the selected one.
    const ms = v.service || service || null;
    const what = (r === 'delivered' || r === 'already' || r === 'not_entitled') && ms ? mealLine(tx, ms, language) : '';
    const icon = r === 'delivered' ? 'fa-circle-check' : r === 'not_entitled' ? 'fa-triangle-exclamation' : r === 'unknown' || r === 'other_conference' ? 'fa-circle-question' : r === 'offline' ? 'fa-wifi' : 'fa-circle-xmark';
    const loc = p ? (p.location_id == null ? tx('meals.no.location', 'Sin localidad') : (p.location || '')) : '';
    const canForce = r === 'not_entitled' && onForce && p;
    const canUndo = r === 'delivered' && onUndo && v.delivery_id;
    const confirmText = canForce ? tx('meals.force.confirm', '{name} no tiene derecho a {service}. ¿Entregar de todas formas? Quedará registrado como autorizado.', { name: p.name, service: svc }) : '';
    const yes = (style?: React.CSSProperties, cls = 'px-4 py-3 rounded-2xl bg-amber-950 text-amber-50 font-black text-xs uppercase tracking-widest disabled:opacity-50') => (
        <button type="button" disabled={busy} onMouseDown={keepFocus} onClick={(e) => { e.stopPropagation(); setArmed(false); onForce(outcome); }}
            className={cls} style={style} data-force-confirm="">
            <i className="fa-solid fa-check mr-1.5" aria-hidden="true"></i>{tx('meals.force.yes', 'Sí, entregar')}
        </button>
    );
    const no = (style?: React.CSSProperties, cls = 'px-4 py-3 rounded-2xl bg-white/60 text-amber-950 font-black text-xs uppercase tracking-widest') => (
        <button type="button" onMouseDown={keepFocus} onClick={(e) => { e.stopPropagation(); setArmed(false); }}
            className={cls} style={style} data-force-cancel="">
            {tx('cancel', 'Cancelar')}
        </button>
    );
    const forceBtn = (
        <button type="button" disabled={busy} onMouseDown={keepFocus} onClick={(e) => { e.stopPropagation(); if (tapOk()) setArmed(true); }}
            className="px-4 py-3 rounded-2xl bg-amber-950 text-amber-50 font-black text-xs uppercase tracking-widest disabled:opacity-50" style={VERDICT_FIT.target} data-force="">
            <i className="fa-solid fa-hand mr-1.5" aria-hidden="true"></i>{tx('meals.force', 'Entregar de todas formas')}
        </button>
    );
    const undoBtn = (
        <button type="button" disabled={busy} onMouseDown={keepFocus} onClick={(e) => { e.stopPropagation(); if (tapOk()) onUndo(v.delivery_id, outcome); }}
            className="px-4 py-2.5 rounded-2xl bg-white/20 hover:bg-white/30 font-black text-[11px] uppercase tracking-widest disabled:opacity-50" style={VERDICT_FIT.target} data-verdict-undo="">
            <i className="fa-solid fa-rotate-left mr-1.5" aria-hidden="true"></i>{tx('meals.undo', 'Deshacer')}
        </button>
    );
    const alreadyAt = r === 'already' && v.delivered_at ? (v.delivered_by
        ? tx('meals.verdict.already.at.by', 'Recibió a las {time} · registró {who}', { time: stampTime(v.delivered_at), who: v.delivered_by })
        : tx('meals.verdict.already.at', 'Recibió a las {time}', { time: stampTime(v.delivered_at) })) : '';

    // Both cards: head → name → the rest (gives way, scrolls) → the decision (VERDICT_FIT / VERDICT_BOX).
    const L = displayLabelsOf(tx);
    const withFields = !!(p && Array.isArray(p.fields) && p.fields.length > 0);
    const { name, rest } = withFields ? splitPersonFields(p) : { name: null, rest: [] };
    const nameText = !p ? '' : name ? displayValue(name, L) : String(p.name || '');
    const plain = p && !withFields ? [loc, p.family_group ? tx('meals.family', 'Grupo familiar: {name}', { name: p.family_group }) : '', p.reg_code || ''].filter(Boolean).join(' · ') : '';
    const code = r === 'unknown' && outcome.code ? outcome.code : '';
    const details = rest.length > 0 || !!plain || !!alreadyAt || !!code;
    // WHAT, as parts (on a short screen only the label gives way); tapped: whole (useOpenMeal), «Más abajo» under
    // it when the card cannot hold it. The tap never dismisses the card, and in «Entrega» never takes the focus
    // from the scan input.
    const mealLineEl = (cls: string, iconCls: string) => (what ? <>
        <div ref={meal.ref} className={cls} title={what} data-verdict-meal="" data-open={mealOpen ? '' : undefined} style={openMealStyle(meal.cap)} onScroll={meal.onScroll}
            onMouseDown={large ? undefined : keepFocus} onClick={(e) => { e.stopPropagation(); meal.setOpen((o) => !o); }}>
            <i className={`fa-solid ${MEAL_ICON[ms.meal] || 'fa-utensils'}${iconCls}`} aria-hidden="true" data-verdict-meal-icon=""></i>
            <span data-verdict-meal-name="">{mealName(tx, ms.meal)}</span>
            {ms.label ? <span data-verdict-meal-label="">{` — ${ms.label}`}</span> : null}
            <span data-verdict-meal-day="">{` · ${dayLabel(ms.service_date, language)}`}</span>
        </div>
        {mealOpen && meal.cap != null && <MoreCue attr="data-verdict-meal-more" atEnd={meal.atEnd} style={VERDICT_MORE_STYLE} />}
    </> : null);
    const method = r === 'delivered' && v.method === 'override' && <div className="text-xs font-black uppercase tracking-widest mt-1 opacity-90" data-verdict-method="override">{tx('meals.method.override', 'Sin derecho (autorizado)')}</div>;
    const F = large ? VERDICT_FIT : VERDICT_BOX;
    const body = (
        <div style={F.body} data-verdict-body="">
            {/* WHO: gives way last, never below one line. */}
            {nameText && <div ref={nameRef} style={!large && !withFields ? VERDICT_BOX.plainName : F.name} data-verdict-name="" data-field="@name">{nameText}</div>}
            {/* The rest of the person's data: gives way first, and scrolls — whole entries, «Más abajo» under the cut. */}
            {details && !dropDetails && detailsShown(restFit.fit) && (
                <div ref={restFit.ref} onScroll={restFit.onScroll} style={detailsStyle(F.scroll, restFit.fit)} data-verdict-scroll="" data-more={detailsMore(restFit.fit) ? '' : undefined}>
                    {rest.length > 0 && <div className="mt-1"><PersonFields fields={rest} large={large} onColour={tone !== 'warn'} /></div>}
                    {plain && <div className={`text-sm font-semibold opacity-90 ${large ? 'mt-1' : 'mt-0.5'}`} data-entry="">{plain}</div>}
                    {alreadyAt && <div className="text-sm font-bold mt-1" data-entry="">{alreadyAt}</div>}
                    {code && <div className="text-sm font-mono font-bold mt-1 opacity-90 break-all" data-entry="">{code}</div>}
                </div>
            )}
            {details && !dropDetails && detailsMore(restFit.fit) && <MoreCue attr="data-verdict-more" atEnd={restFit.atEnd} style={VERDICT_MORE_STYLE} />}
            {/* «¿Entregar de todas formas?» (the phone scanner's): the question gives way before the name; its buttons never. */}
            {large && canForce && armed && (
                <ForceAsk askRef={askRef} textRef={askTextRef} level={askLevel} label={confirmText}
                    yes={yes(VERDICT_FIT.askButton, 'rounded-2xl bg-amber-950 text-amber-50 font-black text-xs uppercase disabled:opacity-50')}
                    no={no(VERDICT_FIT.askButton, 'rounded-2xl bg-white/60 text-amber-950 font-black text-xs uppercase')} />
            )}
            {/* The decision and «Deshacer»: never shrink; 44 px targets. */}
            {((canForce && !armed) || canUndo) ? (
                <div style={F.actions} data-verdict-actions="">
                    <div className="flex flex-wrap gap-2 mt-3">
                        {canForce && !armed && forceBtn}
                        {canUndo && undoBtn}
                    </div>
                </div>
            ) : null}
        </div>
    );

    if (large) {
        // The phone scanner's card (VERDICT_FIT): head → name → the rest (scrolls) → the decision.
        return (
            <div ref={cardRef} className={`rounded-3xl border-2 shadow-xl ${TONE_CLS[tone]} p-6 animate-in fade-in zoom-in-95 duration-150`} style={VERDICT_FIT.card} role="status" aria-live="assertive" data-verdict={r} data-verdict-large="" onClick={() => { if (!armed && tapOk()) onDismiss?.(); }}>
                {/* The verdict and WHAT: never shrinks. */}
                <div style={VERDICT_FIT.row} data-verdict-row="">
                    <i className={`fa-solid ${icon} text-5xl`} style={VERDICT_FIT.icon} aria-hidden="true" data-verdict-icon=""></i>
                    <div style={VERDICT_FIT.head} data-verdict-head="">
                        <div className="text-3xl font-black tracking-tight leading-tight break-words" data-verdict-title="">{title}</div>
                        {mealLineEl('text-lg font-black leading-snug', '')}
                        {method}
                    </div>
                </div>
                {body}
                {/* Last child: the meal line's and the short screens' rules (VERDICT_CSS); it takes no room. */}
                <style>{VERDICT_CSS}</style>
            </div>
        );
    }

    // «Entrega» (VERDICT_BOX): the same order, capped by the tab to the visible band; on a phone the body takes the
    // card's whole width (VERDICT_CSS).
    return (
        <div ref={cardRef} className={`rounded-3xl border-2 shadow-xl ${TONE_CLS[tone]} p-5 animate-in fade-in zoom-in-95 duration-150`} style={VERDICT_BOX.card} role="status" aria-live="assertive" data-verdict={r} onClick={() => { if (!armed && tapOk()) onDismiss?.(); }}>
            <div className="flex items-start gap-4" style={VERDICT_BOX.row} data-verdict-row="">
                <i className={`fa-solid ${icon} text-4xl mt-0.5`} style={VERDICT_BOX.icon} aria-hidden="true" data-verdict-icon=""></i>
                <div className="min-w-0 flex-1" data-verdict-head="">
                    <div className="text-2xl font-black tracking-tight leading-tight break-words" data-verdict-title="">{title}</div>
                    {mealLineEl('text-base font-black leading-snug mt-0.5 break-words', ' mr-1.5')}
                    {method}
                </div>
            </div>
            {body}
            {/* Armed: the card's whole width (not indented under the icon), the short question — the card names
                the person and the service right above; the whole sentence is the dialog's name — and its buttons.
                Inside the cap the question gives way by whole sentences (askStepDown), its buttons never; on a
                phone they share a row (VERDICT_CSS). */}
            {canForce && armed && (
                <DeliveryForceAsk askRef={askRef} buttonsRef={askButtonsRef} level={askLevel} label={confirmText}
                    yes={yes(VERDICT_FIT.target)} no={no(VERDICT_FIT.target)} />
            )}
            {/* Last child: the phone rules (VERDICT_CSS); it takes no room. */}
            <style>{VERDICT_CSS}</style>
        </div>
    );
}

// ── Confirmation card (2.16.0) ───────────────────────────────────────────────────────────────────────
/** Translations for the configured entries (lib/mealConfirm displayLabel / displayValue). */
export const displayLabelsOf = (tx) => ({
    builtin: (key: string) => { const s = tx(`meals.display.${key}`, ''); return s || null; },
    noLocation: tx('meals.no.location', 'Sin localidad'),
    noRoom: tx('meals.display.no.room', 'Sin habitación'),
    hidden: tx('meals.display.hidden', '(oculto)'),
    empty: '—',
    payment: (s: string) => (s === 'paid' ? tx('paid', 'Pagado') : s === 'partial' ? tx('partial', 'Parcial') : s === 'unpaid' ? tx('unpaid', 'Sin Pagar') : s),
});

/**
 * The person's configured entries, in the configured order: the full name as a heading, every other entry
 * as «LABEL value». Colours are inherited (it sits on the white confirmation card and on the coloured
 * verdict card alike); `onColour` (the verdict card): labels at full strength — 70% white on emerald /
 * rose was ≈2.6:1, unreadable at arm's length.
 */
export function PersonFields({ fields, large = false, onColour = false }: any) {
    const tx = useTx();
    const L = displayLabelsOf(tx);
    return (
        <div data-person-fields="" style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            {(fields || []).map((f) => (f.key === '@name'
                ? <div key={f.key} data-field={f.key} style={{ fontSize: large ? 26 : 22, fontWeight: 900, lineHeight: 1.15, overflowWrap: 'anywhere' }}>{displayValue(f, L)}</div>
                : <div key={f.key} data-field={f.key} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, minWidth: 0 }}>
                    <span data-field-label="" style={{ fontSize: onColour ? 12 : 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: onColour ? 1 : 0.7 }}>{displayLabel(f, L)}</span>
                    <span style={{ fontSize: large ? 18 : 16, fontWeight: 800, overflowWrap: 'anywhere', minWidth: 0 }}>{displayValue(f, L)}</span>
                </div>))}
        </div>
    );
}

const CONFIRM_TONE = {
    ready: { band: '#047857', chip: '#d1fae5', text: '#065f46', icon: 'fa-circle-check' },
    not_entitled: { band: '#b45309', chip: '#fef3c7', text: '#92400e', icon: 'fa-triangle-exclamation' },
    bad: { band: '#be123c', chip: '#ffe4e6', text: '#9f1239', icon: 'fa-circle-xmark' },
    muted: { band: '#374151', chip: '#f3f4f6', text: '#1f2937', icon: 'fa-circle-question' },
};
export const confirmTone = (r: string) =>
    (r === 'ready' ? 'ready' : r === 'not_entitled' ? 'not_entitled' : r === 'already' || r === 'cancelled' || r === 'no_service' || r === 'error' ? 'bad' : 'muted');

/**
 * The phone scanner's card: the meal under the day takes at most three lines (a 120-character label took ten
 * and cut the name on a 375×667 phone); a tap on the band shows it WHOLE (useOpenMeal: only when the card
 * cannot hold it, its whole lines that fit with «Más abajo» under them; its title holds the whole text too).
 * Short screens (an iPhone SE in Safari shows 375×548, a first-generation SE 320×460):
 * tighter paddings and slimmer buttons, and the meal keeps to ONE line where only the service's label gives
 * way (an ellipsis; the meal stays) — a long label took three lines (100 px) on a 320×460 phone and pushed the
 * person's name under the buttons. The shortest (320×460): the day and the meal share that line, and
 * everything is tighter still. Narrow or short ones: «Entregar sin derecho (autorizar)» reads «Autorizar» (its
 * accessible name stays whole) — it wrapped to four lines and took the name's room. Inline styles win over a
 * stylesheet, hence !important; these change only the phone scanner's card (`large`). «Entrega»'s card keeps
 * its layout except on a narrow AND short phone, where its meal too keeps to one line and «Autorizar» is
 * short: on a 320×460 phone under the admin header its four-line meal and six-line «Entregar sin derecho
 * (autorizar)» left no room for its buttons (the cap could not hold them). On a narrow phone (≤ 380 px: a 214 px
 * card at 320) its paddings and buttons are tighter so «Cancelar» + «Entregar» (or «Autorizar») fit side by side
 * — the live round found «Entregar» 28 px wider than the card, cut by it («Entrega»). The row wraps rather than
 * cut a button, whatever the language or the font.
 * 2.17.0 live round (r6): wherever else the whole «Entregar sin derecho (autorizar)» would take more than two lines
 * (390–412 px phones: four lines in a 118 px button) the card shows «Autorizar» too (useLabelFit, measured); on the
 * narrowest (≤ 380 px) its hand icon gives way so «Autorizar» keeps to one line. WHY a not-entitled person has no
 * right to the meal is a line of the header (CONFIRM_WHY_STYLE), compact on a short screen; to make room for it,
 * «Entrega»'s card on the shortest narrow phone (320×460) is tighter still — its essentials must fit the band
 * under the admin header, or the tab cannot cap it and its buttons end below the edge.
 */
export const CONFIRM_CSS = `
[data-confirm-card][data-confirm-large] [data-confirm-meal] { cursor: pointer; }
[data-confirm-card][data-confirm-large] [data-confirm-meal]:not([data-open]) [data-confirm-meal-name] { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
@media (max-height: 640px) {
  [data-confirm-card][data-confirm-large] [data-confirm-meal] { display: flex !important; flex-wrap: wrap; align-items: baseline; column-gap: 10px; padding-top: 8px !important; padding-bottom: 8px !important; }
  [data-confirm-card][data-confirm-large] [data-confirm-meal-name] { font-size: 20px !important; min-width: 0; }
  [data-confirm-card][data-confirm-large] [data-confirm-meal]:not([data-open]) [data-confirm-meal-name] { display: flex; align-items: baseline; white-space: pre; }
  [data-confirm-card][data-confirm-large] [data-confirm-meal]:not([data-open]) [data-confirm-meal-name] > * { flex-shrink: 0; }
  [data-confirm-card][data-confirm-large] [data-confirm-meal]:not([data-open]) [data-confirm-meal-label] { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  [data-confirm-card][data-confirm-large] [data-confirm-head] { padding-top: 8px !important; gap: 6px !important; }
  [data-confirm-card][data-confirm-large] [data-confirm-name] { font-size: 22px !important; }
  [data-confirm-card][data-confirm-large] [data-confirm-body] { padding-bottom: 8px !important; }
  [data-confirm-card][data-confirm-large] [data-confirm-actions] { padding-bottom: 12px !important; }
  [data-confirm-card][data-confirm-large] [data-confirm-actions] button { min-height: 50px !important; padding-top: 6px !important; padding-bottom: 6px !important; }
  [data-confirm-card][data-confirm-large] [data-confirm-why] { font-size: 12px !important; line-height: 1.2 !important; margin-top: -2px; }
}
@media (max-height: 520px) {
  [data-confirm-card][data-confirm-large] [data-confirm-meal] { flex-wrap: nowrap; padding: 6px 12px !important; }
  [data-confirm-card][data-confirm-large] [data-confirm-meal][data-open] { flex-wrap: wrap; }
  [data-confirm-card][data-confirm-large] [data-confirm-day] { flex-shrink: 0; }
  [data-confirm-card][data-confirm-large] [data-confirm-meal-name] { font-size: 18px !important; }
  [data-confirm-card][data-confirm-large] [data-confirm-head] { padding: 6px 12px 4px !important; }
  [data-confirm-card][data-confirm-large] [data-confirm-status] { padding: 4px 10px !important; font-size: 13px !important; }
  [data-confirm-card][data-confirm-large] [data-confirm-name] { font-size: 20px !important; }
  [data-confirm-card][data-confirm-large] [data-confirm-body] { padding-left: 12px !important; padding-right: 12px !important; }
  [data-confirm-card][data-confirm-large] [data-confirm-actions] { padding: 0 12px 10px !important; }
  [data-confirm-card][data-confirm-large] [data-confirm-actions] button { min-height: 46px !important; }
}
@media (max-width: 380px), (max-height: 640px) {
  [data-confirm-card][data-confirm-large] [data-label-long] { display: none !important; }
  [data-confirm-card][data-confirm-large] [data-label-short] { display: inline !important; }
}
@media (max-width: 380px) {
  [data-confirm-card][data-confirm-large] [data-long-label] { font-size: 13px !important; padding-left: 8px !important; padding-right: 8px !important; }
  [data-confirm-card][data-confirm-large] button[data-long-label] > i { display: none; }
}
@media (max-width: 600px) and (max-height: 640px) {
  [data-confirm-card]:not([data-confirm-large]) [data-confirm-meal] { cursor: pointer; }
  [data-confirm-card]:not([data-confirm-large]) [data-confirm-meal]:not([data-open]) [data-confirm-meal-name] { display: flex; align-items: baseline; white-space: pre; }
  [data-confirm-card]:not([data-confirm-large]) [data-confirm-meal]:not([data-open]) [data-confirm-meal-name] > * { flex-shrink: 0; }
  [data-confirm-card]:not([data-confirm-large]) [data-confirm-meal]:not([data-open]) [data-confirm-meal-label] { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  [data-confirm-card]:not([data-confirm-large]) [data-label-long] { display: none !important; }
  [data-confirm-card]:not([data-confirm-large]) [data-label-short] { display: inline !important; }
}
@media (max-width: 380px) {
  [data-confirm-card]:not([data-confirm-large]) [data-confirm-meal] { padding-left: 12px !important; padding-right: 12px !important; }
  [data-confirm-card]:not([data-confirm-large]) [data-confirm-head] { padding-left: 12px !important; padding-right: 12px !important; }
  [data-confirm-card]:not([data-confirm-large]) [data-confirm-body] { padding-left: 12px !important; padding-right: 12px !important; }
  [data-confirm-card]:not([data-confirm-large]) [data-confirm-actions] { gap: 6px !important; padding-left: 12px !important; padding-right: 12px !important; }
  [data-confirm-card]:not([data-confirm-large]) [data-confirm-actions] button { padding-left: 8px !important; padding-right: 8px !important; gap: 6px !important; font-size: 14px !important; }
  [data-confirm-card]:not([data-confirm-large]) [data-confirm-actions] button[data-long-label] { font-size: 13px !important; }
  [data-confirm-card]:not([data-confirm-large]) button[data-long-label] > i { display: none; }
}
@media (max-width: 380px) and (max-height: 520px) {
  [data-confirm-card]:not([data-confirm-large]) [data-confirm-head] { padding-top: 8px !important; padding-bottom: 6px !important; gap: 6px !important; }
  [data-confirm-card]:not([data-confirm-large]) [data-confirm-status] { padding: 4px 10px !important; font-size: 13px !important; }
  [data-confirm-card]:not([data-confirm-large]) [data-confirm-why] { font-size: 12px !important; line-height: 1.2 !important; margin-top: -2px; }
  [data-confirm-card]:not([data-confirm-large]) [data-confirm-name] { font-size: 20px !important; }
  [data-confirm-card]:not([data-confirm-large]) [data-confirm-actions] { padding-bottom: 10px !important; }
}`;
/** «Más abajo ↓» on the white confirmation card. */
export const CONFIRM_MORE_STYLE: React.CSSProperties = { textAlign: 'center', fontSize: 12, color: '#374151' };
/**
 * 2.17.0 — WHY a not-entitled person has no right to the meal («No está en el plan de su localidad», «Se la quitaron
 * a esta persona»): a compact line under the status, in the header that never gives way. It was the first entry of
 * the part that scrolls, and the live round at 320×460 found it gone with that part (left out when not even one
 * entry fits) — staff authorised without knowing why. It never shrinks; it wraps.
 */
export const CONFIRM_WHY_STYLE = (color: string): React.CSSProperties => ({ flexShrink: 0, fontSize: 13, fontWeight: 700, lineHeight: 1.25, color, overflowWrap: 'anywhere' });
/**
 * «Más abajo ↓» over the open meal in the coloured band: at the end of the day's line, taking no room of its own —
 * floated right of it (the band's block layout), or after it in the row with the meal next (`order`, the band's
 * wrapping row on a short screen); 16 px, inside the day's 18 px line. On a 320×460 phone the 20 px of a line of
 * its own decided between one line of the meal and none.
 */
export const CONFIRM_MEAL_MORE_STYLE: React.CSSProperties = { float: 'right', order: 1, marginLeft: 'auto', height: 16, lineHeight: '16px', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase' };
/**
 * «Registrando…» replaces «Entregar» (or «Autorizar») while the delivery is recorded: a moment, and a longer word.
 * That button may then shrink, its label ending in «…», instead of pushing «Cancelar» to a second row (the card
 * would jump) or out of the card. Its accessible name stays the whole word (the text is all there).
 */
export const BUTTON_SHRINKS: React.CSSProperties = { minWidth: 0 };
export const BUTTON_LABEL_FIT: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
/** The part of the confirmation card that scrolls (whole entries: useWholeEntries); it gives way first. */
export const CONFIRM_SCROLL: React.CSSProperties = { position: 'relative', overflowY: 'auto', minHeight: 0, flex: '0 100000 auto' };
/**
 * 2.17.0 — a button's whole label shows only while it takes at most `max` lines (lib/mealConfirm labelTooLong):
 * measured after layout, before paint; `short` once it would take more — the button then shows its short label
 * (its accessible name stays whole). The live round found «Entregar sin derecho (autorizar)» in four lines in a
 * 118 px button at 390×664 and 390×844 (both cards) and at 412×915: the media rules (CONFIRM_CSS) give «Autorizar»
 * only on a narrow or short screen, and stay as they are; this covers every other width, language and font. A new
 * `key` (another card, another text), another window size or a web font that finished loading measure it again
 * from the whole label. `ref`: the whole label's element.
 */
export function useLabelFit(key: unknown, max = LABEL_MAX_LINES) {
    const ref = useRef<HTMLSpanElement | null>(null);
    const [short, setShort] = useState(false);
    useLayoutEffect(() => { setShort(false); }, [key]);
    useLayoutEffect(() => {
        if (short) return;
        const el = ref.current;
        if (el && labelTooLong(el, max)) setShort(true);
    });
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const refit = () => setShort(false);
        const fonts: any = typeof document !== 'undefined' ? (document as any).fonts : null;
        window.addEventListener('resize', refit);
        try { fonts?.addEventListener?.('loadingdone', refit); } catch { /* no FontFaceSet events */ }
        return () => {
            window.removeEventListener('resize', refit);
            try { fonts?.removeEventListener?.('loadingdone', refit); } catch { /* ignore */ }
        };
    }, []);
    return { ref, short };
}
/**
 * «Entregar sin derecho (autorizar)»'s label: «Registrando…» while it records (it shortens with «…»); the short one
 * alone once the whole one would take more than two lines (useLabelFit); else both, the short one hidden — the media
 * rules (CONFIRM_CSS) swap them on a narrow or short screen. `labelRef` goes on the whole one (it is measured).
 */
export function AuthorizeLabel({ text, shortText, delivering = false, short = false, labelRef }: any) {
    if (delivering) return <span style={BUTTON_LABEL_FIT}>{text}</span>;
    if (short) return <span data-label-short="" data-label-fit="short">{shortText}</span>;
    return <>
        <span ref={labelRef} data-label-long="">{text}</span>
        <span data-label-short="" style={{ display: 'none' }}>{shortText}</span>
    </>;
}

/**
 * The confirmation card (2.16.0): the meal (day + meal, prominent; never shrinks), then WHO — the status and
 * the person's NAME, a header that gives way last (2.17.0: no longer inside the part that scrolls, where a
 * header taller than that part was cut for good on a 320×460 phone; now the name gives way only after
 * everything else, never below one line, scrolling inside itself) — then the other configured entries, the
 * part that gives way first and scrolls, WHOLE entries with «Más abajo» under the cut (useWholeEntries; iOS
 * hides scrollbars), and the decision at the bottom (thumb reach; never shrinks, so no screen can push the
 * buttons out of the card):
 *   'ready'        → «Cancelar» + «Entregar» (primary, right)
 *   'not_entitled' → «Entregar sin derecho (autorizar)» (outlined, left; «Autorizar» where the whole label would
 *                    take more than two lines) + «Cancelar» (primary, right): the routine tap on the big right-hand
 *                    button never authorises an override. WHY (not in the plan of their location, removed for
 *                    this person) is a line of the header, under the status: it never gives way
 *   anything else  → «Cerrar».
 * The decision buttons ignore taps for `armMs` after the card appears (a tap meant for what was there before
 * must not decide for this person). Structure and colours are INLINE (it lives inside the phone scanner, see
 * SCANNER_ROOT_STYLE). Its buttons never take the focus from «Entrega»'s scan input. `keyHints`: say what
 * Enter / Esc do (USB scanners).
 */
export function ConfirmCard({ card, service, language, delivering = false, waiting = 0, large = false, keyHints = false, armMs = TAP_ARM_MS, onDeliver, onAuthorize, onCancel, onClose }: any) {
    const tx = useTx();
    const txn = makeTxn(tx);
    const L = displayLabelsOf(tx);
    const nameRef = useRef<HTMLDivElement | null>(null);
    const headRef = useRef<HTMLDivElement | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);
    /**
     * The meal band shown whole (a tap on it: on a short screen it keeps to one line): whole, or — when the card
     * cannot hold it without cutting the status, the name or the buttons — its whole lines that fit with «Más
     * abajo» under them (useOpenMeal; the name always wins).
     */
    const meal = useOpenMeal(card?.seq, () => Math.max(clippedPx(nameRef.current), clippedPx(headRef.current), clippedPx(cardRef.current)), 0);
    const mealOpen = meal.open;
    // «Entregar sin derecho (autorizar)»: whole while it takes at most two lines, else «Autorizar» (useLabelFit). The
    // switch makes the buttons shorter: the person's other data are measured again for the room it leaves.
    const authorizeWhole = tx('meals.confirm.authorize', 'Entregar sin derecho (autorizar)');
    const authorizeFit = useLabelFit(`${card?.seq}:${card?.result}:${authorizeWhole}`);
    const restFit = useWholeEntries(`${card?.seq}:${mealOpen}:${meal.cap}:${authorizeFit.short}`);
    // «Entrega»: the meal band shown whole makes the card taller — its buttons stay in view.
    useEffect(() => { if (mealOpen && !large && typeof window !== 'undefined') revealNearest(cardRef.current, window); }, [mealOpen, meal.cap, large]);
    if (!card) return null;
    const r = card.result;
    const v = card.verdict || {};
    const p = v.person;
    const { name, rest } = splitPersonFields(p);
    const s = v.service || service || null;
    const tone = CONFIRM_TONE[confirmTone(r)];
    const decision = isDecision(r);
    const status =
        r === 'ready' ? tx('meals.confirm.ready', 'Puede recibir esta comida')
            : r === 'not_entitled' ? tx('meals.confirm.not_entitled', 'Sin derecho a esta comida')
                : r === 'already' ? tx('meals.verdict.already', 'Ya recibió')
                    : r === 'cancelled' ? tx('meals.verdict.cancelled', 'Inscripción cancelada')
                        : r === 'unknown' ? tx('meals.verdict.unknown', 'Código no encontrado')
                            : r === 'other_conference' ? tx('meals.verdict.other_conference', 'Ese código es de otra conferencia')
                                : r === 'offline' ? tx('meals.verdict.offline', 'Sin conexión — vuelve a escanear')
                                    : r === 'no_service' ? tx('meals.verdict.no_service', 'Servicio no encontrado: elige otro')
                                        : (card.message || tx('meals.verdict.error', 'No se pudo registrar'));
    const why = r !== 'not_entitled' ? ''
        : v.source === 'exclude' ? tx('meals.confirm.not_entitled.exclude', 'Se la quitaron a esta persona') : tx('meals.confirm.not_entitled.none', 'No está en el plan de su localidad');
    const btn = (background: string, color: string, flex: string): React.CSSProperties => ({
        flex, minHeight: large ? 60 : 52, padding: '10px 14px', borderRadius: 16, border: 0, background, color, cursor: 'pointer',
        fontWeight: 900, fontSize: large ? 18 : 16, lineHeight: 1.15, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: delivering ? 0.6 : 1,
    });
    const press = (fn?: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn?.(); };
    // A decision counts only once the card has been on screen for `armMs`.
    const decide = (fn?: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); if (tapArmed(card.shownAt, Date.now(), armMs)) fn?.(); };
    const cancelBtn = (primary: boolean) => (
        <button type="button" disabled={delivering} onMouseDown={keepFocus} onClick={decide(onCancel)} data-confirm-cancel=""
            style={primary ? btn('#111827', '#fff', '2 1 0%') : btn('#f3f4f6', '#111827', '1 1 0%')}>
            {tx('meals.confirm.cancel', 'Cancelar')}
        </button>
    );
    const authorize = delivering ? tx('meals.confirm.delivering', 'Registrando…') : authorizeWhole;
    const mealText = s ? `${dayLabel(s.service_date, language, true)} · ${mealName(tx, s.meal)}${s.label ? ` — ${s.label}` : ''}` : '';
    return (
        <div ref={cardRef} role={decision ? 'alertdialog' : 'status'} aria-live="assertive" aria-label={tx('meals.confirm.title', 'Confirmar entrega')} data-confirm-card={r} data-confirm-large={large ? '' : undefined}
            style={{ background: '#fff', color: '#111827', borderRadius: 24, overflow: 'hidden', border: `3px solid ${tone.band}`, boxShadow: '0 12px 40px rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', maxHeight: '100%', minHeight: 0, scrollMarginTop: REVEAL_MARGIN_PX, scrollMarginBottom: REVEAL_MARGIN_PX }}>
            <div data-confirm-meal="" title={s ? mealText : undefined} data-open={mealOpen ? '' : undefined}
                onClick={s ? () => meal.setOpen((o) => !o) : undefined}
                style={{ background: tone.band, color: '#fff', padding: large ? '12px 16px' : '10px 14px', flexShrink: 0 }}>
                {s ? <>
                    {mealOpen && meal.cap != null && <MoreCue attr="data-confirm-meal-more" atEnd={meal.atEnd} style={CONFIRM_MEAL_MORE_STYLE} />}
                    <div data-confirm-day="" style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{dayLabel(s.service_date, language, true)}</div>
                    <div ref={meal.ref} data-confirm-meal-name="" onScroll={meal.onScroll} style={{ fontSize: large ? 26 : 22, fontWeight: 900, lineHeight: 1.1, overflowWrap: 'anywhere', order: 2, ...openMealStyle(meal.cap) }}>
                        <i className={`fa-solid ${MEAL_ICON[s.meal] || 'fa-utensils'}`} aria-hidden="true" style={{ marginRight: 8 }}></i>
                        <span data-confirm-meal-meal="">{mealName(tx, s.meal)}</span>
                        {s.label ? <span data-confirm-meal-label="">{` — ${s.label}`}</span> : null}
                    </div>
                </> : <div style={{ fontSize: 18, fontWeight: 900 }}>{tx('meals.confirm.title', 'Confirmar entrega')}</div>}
            </div>
            {/* WHO: the status and the name — they give way last (the name never below one line). */}
            <div ref={headRef} data-confirm-head="" style={{ flex: '0 1 auto', minHeight: 0, overflow: 'hidden', padding: large ? '12px 16px 8px' : '12px 14px 8px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                <div data-confirm-status="" style={{ alignSelf: 'flex-start', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 999, background: tone.chip, color: tone.text, fontWeight: 900, fontSize: 14 }}>
                    <i className={`fa-solid ${r === 'offline' ? 'fa-wifi' : tone.icon}`} aria-hidden="true"></i>{status}
                </div>
                {/* WHY there is no right to it: decision information, part of the status — never a detail that gives way. */}
                {why && <div data-confirm-why="" style={CONFIRM_WHY_STYLE(tone.text)}>{why}</div>}
                {name && <div ref={nameRef} data-confirm-name="" data-field="@name" style={{ flex: '0 1 auto', minHeight: '1.15em', overflowY: 'auto', fontSize: large ? 26 : 22, fontWeight: 900, lineHeight: 1.15, overflowWrap: 'anywhere' }}>{displayValue(name, L)}</div>}
            </div>
            {/* The rest gives way first and scrolls: whole entries, «Más abajo» under the cut, left out when none fits. */}
            {detailsShown(restFit.fit) && (
                <div data-confirm-scroll="" ref={restFit.ref} onScroll={restFit.onScroll} style={detailsStyle(CONFIRM_SCROLL, restFit.fit)}>
                    <div data-confirm-body="" style={{ padding: large ? '2px 16px 14px' : '2px 14px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {rest.length > 0 && <PersonFields fields={rest} large={large} />}
                        {r === 'already' && v.delivered_at && (
                            <div data-entry="" style={{ fontSize: 14, fontWeight: 700 }}>{v.delivered_by
                                ? tx('meals.verdict.already.at.by', 'Recibió a las {time} · registró {who}', { time: stampTime(v.delivered_at), who: v.delivered_by })
                                : tx('meals.verdict.already.at', 'Recibió a las {time}', { time: stampTime(v.delivered_at) })}</div>
                        )}
                        {r === 'unknown' && card.code && <div data-entry="" style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: 15, overflowWrap: 'anywhere' }}>{card.code}</div>}
                        {waiting > 0 && <div data-confirm-waiting={waiting} data-entry="" style={{ fontSize: 12, fontWeight: 800, color: '#6b7280' }}>{txn('meals.confirm.waiting', '{n} códigos en espera', '{n} código en espera', waiting)}</div>}
                        {keyHints && decision && <div data-entry="" style={{ fontSize: 11, fontWeight: 700, color: '#6b7280' }}>{r === 'ready' ? tx('meals.confirm.keys', 'Enter = Entregar · Esc = Cancelar') : tx('meals.confirm.keys.authorize', 'Enter no autoriza: usa el botón · Esc = Cancelar')}</div>}
                    </div>
                </div>
            )}
            {detailsMore(restFit.fit) && <MoreCue attr="data-confirm-more" atEnd={restFit.atEnd} style={CONFIRM_MORE_STYLE} />}
            <div data-confirm-actions="" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: large ? '0 16px 16px' : '0 14px 14px', flexShrink: 0 }}>
                {r === 'ready' ? <>
                    {cancelBtn(false)}
                    <button type="button" disabled={delivering} onMouseDown={keepFocus} onClick={decide(onDeliver)} data-confirm-deliver="" style={{ ...btn('#059669', '#fff', '2 1 0%'), ...(delivering ? BUTTON_SHRINKS : null) }}>
                        <i className="fa-solid fa-check" aria-hidden="true"></i>{delivering ? <span style={BUTTON_LABEL_FIT}>{tx('meals.confirm.delivering', 'Registrando…')}</span> : tx('meals.confirm.deliver', 'Entregar')}
                    </button>
                </> : r === 'not_entitled' ? <>
                    <button type="button" disabled={delivering} onMouseDown={keepFocus} onClick={decide(onAuthorize)} data-confirm-authorize="" data-long-label=""
                        style={{ ...btn('#fff', '#92400e', '1 1 0%'), border: '2px solid #b45309', fontSize: large ? 15 : 14, flexWrap: 'wrap', textAlign: 'center', ...(delivering ? BUTTON_SHRINKS : null) }} aria-label={authorize}>
                        <i className="fa-solid fa-hand" aria-hidden="true"></i>
                        <AuthorizeLabel text={authorize} shortText={tx('meals.confirm.authorize.short', 'Autorizar')} delivering={delivering} short={authorizeFit.short} labelRef={authorizeFit.ref} />
                    </button>
                    {cancelBtn(true)}
                </> : (
                    <button type="button" onMouseDown={keepFocus} onClick={press(onClose)} data-confirm-close="" style={btn('#111827', '#fff', '1 1 0%')}>
                        {tx('meals.confirm.close', 'Cerrar')}
                    </button>
                )}
            </div>
            {/* Last child: the short-screen rules (CONFIRM_CSS); display:none, it takes no room. */}
            <style>{CONFIRM_CSS}</style>
        </div>
    );
}

/** «Comprobando…» while the check of a scan is on its way. */
export function CheckingCard() {
    const tx = useTx();
    return (
        <div data-confirm-checking="" role="status" style={{ background: '#fff', color: '#111827', borderRadius: 20, padding: '12px 16px', fontWeight: 800, fontSize: 15, boxShadow: '0 10px 30px rgba(0,0,0,0.35)' }}>
            <i className="fa-solid fa-spinner fa-spin" aria-hidden="true" style={{ marginRight: 8 }}></i>{tx('meals.confirm.checking', 'Comprobando…')}
        </div>
    );
}

/** «Confirmar antes de entregar» (per device, see useConfirmPref). */
export function ConfirmToggle({ on, onChange, dark = false }: any) {
    const tx = useTx();
    return (
        <label data-confirm-toggle={on ? 'on' : 'off'} style={{
            display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer', padding: '10px 12px', borderRadius: 16,
            border: `2px solid ${dark ? 'rgba(255,255,255,0.2)' : '#f3f4f6'}`, background: dark ? 'rgba(255,255,255,0.06)' : '#fff',
        }}>
            <input type="checkbox" role="switch" checked={!!on} onChange={(e) => onChange(e.target.checked)} style={{ width: 22, height: 22, marginTop: 2, accentColor: '#059669', flexShrink: 0 }} />
            <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 16, fontWeight: 900, color: dark ? '#fff' : '#111827' }}>{tx('meals.confirm.toggle', 'Confirmar antes de entregar')}</span>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: dark ? 'rgba(255,255,255,0.65)' : '#6b7280' }}>{tx('meals.confirm.toggle.hint', 'Muestra la comida y los datos de la persona, y espera a que pulses Entregar. Se recuerda en este dispositivo.')}</span>
            </span>
        </label>
    );
}

// ── Manual search (by name / document / code) ────────────────────────────────────────────────────────
/** `action`: the word on each row (default «Entregar»; «Elegir» when picking only opens the confirmation card). */
export function PersonSearch({ conferenceId, onPick, busy, autoFocus = true, dark = false, action }: any) {
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
                                <span className={`text-[10px] font-black uppercase tracking-widest whitespace-nowrap ${dark ? 'text-emerald-300' : 'text-emerald-700'}`}>{action || tx('meals.deliver', 'Entregar')}</span>
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
/**
 * What BarcodeDetector is asked for when it cannot list its formats: the badges' QR (2.22.0), the Code 128
 * of the badges printed before, and the retail ones.
 */
export const NATIVE_DEFAULT_FORMATS = ['qr_code', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39'];
/**
 * The formats to ask BarcodeDetector for: EVERY one it supports (the scanner shows whatever it reads —
 * 2.15.0 asked for Code 128 only, so a product box was invisible), or null when it cannot read the
 * badges' QR (the built-in reader, which reads QR and Code 128, is used then).
 */
export function pickNativeFormats(supported: string[] | null | undefined): string[] | null {
    if (!Array.isArray(supported)) return [...NATIVE_DEFAULT_FORMATS];
    const list = supported.filter((f) => typeof f === 'string' && f && f !== 'unknown');
    return list.includes('qr_code') ? list : null;
}

let detectorPromise: Promise<any> | null = null;
/** A BarcodeDetector (Chrome / Android) for every format it reads, QR included; else null. */
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
 * One built-in decode of the current frame: first a QR (the badges since 2.22.0) in a square around the aiming
 * frame (`frameEl`), then the band under it at the camera's full resolution in every barcode symbology the
 * plugin reads (the Code 128 badges printed before, retail codes), nothing filtered (`regCodeOnly: false` —
 * the caller decides what is a registration code and shows the rest). Falls back to the whole frame when
 * the aiming frame has no layout.
 */
export function decodeCameraFrame(video: any, canvas: any, frameEl: any): { text: string; format: string } | null {
    let band = null;
    try {
        if (frameEl && typeof video.getBoundingClientRect === 'function') {
            const v = video.getBoundingClientRect(), f = frameEl.getBoundingClientRect();
            band = aimCrop(video.videoWidth, video.videoHeight, { width: v.width, height: v.height }, { x: f.left - v.left, y: f.top - v.top, width: f.width, height: f.height });
        }
    } catch { band = null; }
    const qr = decodeQrVideoRegion(video, canvas, qrSquare(video.videoWidth, video.videoHeight, band));
    if (qr) return qr;
    return decodeVideoRegion(video, canvas, band, { regCodeOnly: false });
}

// ── Scanner pieces (inline styles: they must exist even where the plugin's Tailwind classes do not) ──
/**
 * Keyframes of the scan line and the heartbeat dot (no motion with prefers-reduced-motion). The sweep
 * moves a frame-sized layer with `transform` — composited, so the line keeps moving while the built-in
 * reader holds the main thread (animating `top` re-ran layout on the main thread and stuttered exactly
 * while a frame was being decoded). translateY(%) is relative to the layer's own height, the frame's.
 * The counters fold away on a short phone while a confirmation card is open, and on the shortest ones
 * (a first-generation SE in Safari, 320×460) while a verdict card is shown (2.17.0: its meal and «Deshacer»
 * need the room).
 */
export const SCANNER_CSS = `
@keyframes cm-scan-sweep { 0%, 100% { transform: translateY(14%); } 50% { transform: translateY(86%); } }
@keyframes cm-scan-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { [data-scan-line], [data-scan-dot] { animation: none !important; } }
@media (max-height: 700px) { [data-meal-scanner][data-card-open] [data-scanner-counters] { display: none !important; } }
@media (max-height: 520px) { [data-meal-scanner][data-verdict-open] [data-scanner-counters] { display: none !important; } }
`;
export const SCANNER_ROOT_STYLE: React.CSSProperties = {
    position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, height: '100dvh', zIndex: 6000,
    background: '#000', color: '#fff', display: 'flex', flexDirection: 'column', overscrollBehavior: 'none',
};
export const SCANNER_BAR_STYLE: React.CSSProperties = { background: 'rgba(0,0,0,0.8)', flexShrink: 0 };
/**
 * Side margins of everything laid across the scanner's full width (bars, cards, the side buttons): 12 px,
 * or the notch / rounded corner in landscape — the admin viewport is `viewport-fit=cover`, so a fixed
 * full-width element now reaches under them (env() is 0 everywhere else).
 */
export const SAFE_LEFT = 'max(12px, env(safe-area-inset-left))';
export const SAFE_RIGHT = 'max(12px, env(safe-area-inset-right))';
/** The aim hint is hidden while a card's box reaches it — its top above the hint's bottom (no hint, no box: shown). */
export const coversHint = (hint: { bottom: number } | null | undefined, box: { top: number; height: number } | null | undefined): boolean =>
    !!hint && !!box && box.height > 0 && box.top < hint.bottom;
/**
 * The camera's own lines a card can reach, each hidden (its place kept) while the card's box does (coversHint):
 * the aim hint at the top, and under the aiming frame the heartbeat pill («En pausa») and the focus hint. 2.17.0
 * live round: at 412×915 the offline / error card's top edge ran through «En pausa», its lower half hidden — the
 * aim hint's twin, which hid itself while that pill did not.
 */
export type CameraLines = { hint: boolean; pill: boolean; focus: boolean };
export const NO_CAMERA_LINE_COVERED: CameraLines = { hint: false, pill: false, focus: false };
type Bottom = { bottom: number } | null | undefined;
export const coveredCameraLines = (lines: { hint?: Bottom; pill?: Bottom; focus?: Bottom }, box: { top: number; height: number } | null | undefined): CameraLines =>
    ({ hint: coversHint(lines.hint, box), pill: coversHint(lines.pill, box), focus: coversHint(lines.focus, box) });
export const sameCameraLines = (a: CameraLines, b: CameraLines): boolean => a.hint === b.hint && a.pill === b.pill && a.focus === b.focus;
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
                position: 'absolute', left: 12, right: 12, top: 0, height: '100%', pointerEvents: 'none',
                transform: 'translateY(50%)', willChange: 'transform',
                opacity: scanning ? 1 : 0.35, animation: scanning ? 'cm-scan-sweep 1.8s ease-in-out infinite' : 'none',
            }}>
                <div style={{ height: 3, borderRadius: 2, background: 'rgba(244,63,94,0.95)', boxShadow: '0 0 10px rgba(244,63,94,0.9)' }} />
            </div>
        </div>
    );
}

/**
 * The heartbeat under the aiming frame, driven by the decode loop: «Escaneando · N cuadros/s» with a
 * pulsing dot, «En pausa» while a sheet / a verdict / a request holds the loop. Nothing when stalled
 * (CameraNotice covers the camera then). «Escaneando…» without a number while no frame has been analysed
 * in the last second (the camera just turned on, a slow first native detect()): «0 cuadros/s» on the
 * screen meant to reassure the operator read like a fault. `covered`: a card reaches it — hidden, its place
 * kept (coveredCameraLines).
 */
export function ScanPill({ health, tx, pillRef, covered = false }: any) {
    if (!health || health.state === 'stalled') return null;
    const scanning = health.state === 'scanning';
    return (
        <div ref={pillRef} data-scan-state={health.state} role="status" aria-live="off" style={covered ? { ...pill, visibility: 'hidden' } : pill}>
            <span data-scan-dot="" aria-hidden="true" style={{
                width: 8, height: 8, borderRadius: 999, background: scanning ? '#34d399' : '#fbbf24',
                animation: scanning ? 'cm-scan-pulse 1s ease-in-out infinite' : 'none',
            }} />
            {!scanning ? tx('meals.scanner.paused', 'En pausa')
                : health.fps > 0 ? tx('meals.scanner.scanning', 'Escaneando · {n} cuadros/s', { n: health.fps })
                    : tx('meals.scanner.scanning.start', 'Escaneando…')}
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
 * no es un código de inscripción», with its symbology. Tap to dismiss. `read.held` (2.16.0): the badge of a
 * card just cancelled, shown again too soon — say why nothing opens instead of staying silent.
 */
export function ReadCard({ read, tx, onDismiss }: any) {
    if (!read) return null;
    if (read.held) {
        return (
            <div data-scan-read="held" role="status" aria-live="polite" onClick={onDismiss} style={{
                background: 'rgba(17,24,39,0.94)', color: '#fff', border: '2px solid rgba(255,255,255,0.3)', borderRadius: 20,
                padding: '12px 16px', boxShadow: '0 10px 30px rgba(0,0,0,0.45)', fontSize: 15, fontWeight: 800, overflowWrap: 'anywhere',
            }}>
                <i className="fa-solid fa-hand mr-1.5" aria-hidden="true" style={{ marginRight: 6 }}></i>
                {tx('meals.scanner.read.held', 'Entrega cancelada. Para volver a abrirla, aparta el código unos segundos y vuelve a acercarlo.')}
            </div>
        );
    }
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

/**
 * The service's name in the scanner's top bar: up to two lines, then an ellipsis. It was one line, cut on a
 * phone to «Mar 10/11 · Almuerzo — Al…» — the custom label after the dash is what tells two services of the
 * same meal apart. Inline, like the rest of the scanner's frame, so it does not depend on compiled classes.
 */
export const SERVICE_NAME_STYLE: React.CSSProperties = {
    display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', overflowWrap: 'anywhere',
};

/**
 * A getUserMedia failure, as a camera state and (for 'error') the i18n key of its message. Never the
 * browser's own text: it is English whatever the admin's language («Not supported» on the Spanish
 * scanner), and says nothing the user can act on.
 */
export function cameraFailure(e: { name?: string } | null | undefined): { cam: 'denied' | 'unsupported' | 'error'; key: string | null } {
    const name = String(e?.name || '');
    if (name === 'NotAllowedError' || name === 'SecurityError') return { cam: 'denied', key: null };
    if (name === 'NotSupportedError' || name === 'TypeError') return { cam: 'unsupported', key: null };
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return { cam: 'error', key: 'meals.camera.notfound' };
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return { cam: 'error', key: 'meals.camera.busy' };
    return { cam: 'error', key: null };
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * The decode loop skips frames (and the heartbeat says «En pausa») while a request is in flight, a sheet
 * covers the camera, someone is confirming «Entregar de todas formas», or — 2.16.0 — a confirmation card is
 * open or its request runs: no new code may replace the card on screen, nor deliver twice.
 */
export const scanPaused = ({ inFlight, sheet, armed, flow }: any): boolean =>
    !!(inFlight || sheet || armed || (flow && (flow.isOpen() || flow.isBusy())));

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
    const [read, setRead] = useState<{ value: string; format: string; seq: number; held?: boolean } | null>(null);
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

    // ── 2.16.0: confirm before delivering (per device; OFF = `submit` above, the immediate delivery) ──
    const [confirmOn, setConfirmOn] = useConfirmPref();
    const confirmRef = useRef(confirmOn);
    confirmRef.current = confirmOn;
    const [flow, confirm] = useConfirmFlow({
        queue: false,
        onCheck: (card) => {
            if (!aliveRef.current) return;
            // Nothing is recorded yet: «ready» has its own cue (not the blip of a barcode that is not a
            // registration code); anything else that needs attention sounds «bad».
            if (card.result === 'ready') feedback.current.attention();
            else {
                feedback.current.bad();
                setFlash('bad');
                setTimeout(() => { if (aliveRef.current) setFlash(''); }, 350);
            }
            if (card.result === 'no_service') { setSheet('service'); onChanged?.(); }
        },
        // «Entregar» answered: the usual verdict card (only the server's 'delivered' reads «Entregado»). A
        // service change resets the flow, so an answer for the previous service never lands here.
        onResult: (o) => { if (aliveRef.current) show(o); },
        // The badge of a card that just closed (delivered, «Cancelar», «Cerrar») must leave the view before
        // it opens another card — «Cancelar» would otherwise bring the same card straight back. Not after a
        // reset (pickService has just let the badge be read again, as in 2.15) nor after a failure (offline,
        // error: «vuelve a escanear»); see holdAfterClose. After «Cancelar» the badge says why if shown again.
        onClose: (card, why, outcome) => { const h = holdAfterClose(card, why, outcome); if (h) router.current.hold(h.code, Date.now(), h.hint); },
    });
    const flowRef = useRef(flow);
    flowRef.current = flow;
    useEffect(() => { if (!confirmOn) flow.reset(); }, [confirmOn, flow]);
    // An informative card («Ya recibió», «Código no encontrado»…) closes itself after 3 s; a decision waits.
    useEffect(() => {
        const c = confirm.card;
        if (!c || isDecision(c.result)) return;
        const h = setTimeout(() => flowRef.current.close(), 3000);
        return () => clearTimeout(h);
    }, [confirm.card]);

    // Everything that names a person — a badge read, a typed code, a name picked — goes through here. With
    // the confirmation ON it opens the card; a MANUAL entry replaces an open card (flow.pick: nothing was
    // recorded for it), while a camera read never does (decoding is paused while a card is open anyway).
    const scanBody = useCallback((body: any, manual = false) => {
        const sid = serviceRef.current;
        if (!sid) { setSheet('service'); return; }
        if (!confirmRef.current) { submit(body); return; }
        const f = flowRef.current;
        if ((manual ? f.pick(sid, body) : f.scan(sid, body)) === 'checking') { setOutcome(null); setRead(null); }
    }, [submit]);

    // A registration code is posted (once per sighting, never while a request is in flight or a card is
    // open); ANYTHING else the camera reads is shown on the read card — the operator sees the scanner works
    // and what it saw.
    const onCode = useCallback((raw: string, format = '') => {
        const f = flowRef.current;
        const r = router.current.route(raw, format, inFlight.current || f.isOpen() || f.isBusy());
        if (!r) return;
        if (r.action === 'submit') { scanBody({ code: r.code }); return; }
        lastReadAt.current = Date.now();
        // The badge of a card just cancelled, back in view too soon: say why nothing opens.
        if (r.action === 'held') { if (r.fresh) { setRead({ value: r.code, format: '', held: true, seq: Date.now() }); feedback.current.info(); } return; }
        if (r.fresh) { setRead({ value: r.value, format: r.format, seq: Date.now() }); feedback.current.info(); }
    }, [scanBody]);
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
    // verdict awaiting a decision, a confirmation card, a request in flight) or finds no playable frame:
    // the heartbeat and the «no image» notice are read from what the loop really did.
    // The built-in reader runs on the main thread (~20 ms on a blank frame, ~100 ms on printed packaging):
    // the pause before the next frame grows with it (scanLoopDelay), so taps and sheets stay responsive.
    const scanLoop = useCallback(async () => {
        const video = videoRef.current;
        const stream = streamRef.current;
        if (!video || !stream) return;
        let spent = 0;
        try {
            if (scanPaused({ inFlight: inFlight.current, sheet: sheetRef.current, armed: armedRef.current, flow: flowRef.current })) meter.current.pause();
            else if (video.readyState >= 2 && video.videoWidth > 0 && !video.paused) {
                const native = await getNativeDetector();
                if (native) {
                    meter.current.busy();   // a slow first detect() (model loading) is not "no image"
                    const codes = await native.detect(video);
                    if (streamRef.current !== stream || !aliveRef.current) return;   // stopped meanwhile
                    meter.current.frame();
                    for (const c of codes || []) onCodeRef.current(String(c.rawValue || ''), String(c.format || ''));
                } else {
                    const canvas = canvasRef.current || (canvasRef.current = document.createElement('canvas'));
                    const t0 = performance.now();
                    const hit = decodeCameraFrame(video, canvas, aimRef.current);
                    meter.current.frame();
                    if (hit) onCodeRef.current(hit.text, hit.format);
                    spent = performance.now() - t0;
                }
            }
        } catch { meter.current.idle(); /* a bad frame: try the next one */ }
        if (streamRef.current === stream && aliveRef.current) loopRef.current = window.setTimeout(scanLoop, scanLoopDelay(spent));
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
            const failure = cameraFailure(e);
            setCam(failure.cam);
            setCamError(failure.key === 'meals.camera.notfound' ? tx('meals.camera.notfound', 'No se encontró una cámara.')
                : failure.key === 'meals.camera.busy' ? tx('meals.camera.busy', 'Otra aplicación está usando la cámara. Ciérrala y vuelve a intentarlo.')
                    : '');
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

    // Esc: a sheet closes first, then a confirmation card («Cancelar» / «Cerrar»), then the scanner. Tab
    // stays inside the overlay (it is modal).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                const f = flowRef.current;
                if (sheetRef.current) setSheet(null);
                else if (f.isOpen()) { if (!f.cancel()) f.close(); }
                else onClose();
                return;
            }
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
    // Another service (picked here, or the selected one was deleted): a card — and any answer still on its
    // way — belongs to the previous one.
    useEffect(() => { flow.reset(); }, [serviceId, flow]);
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

    // The camera's own lines — the aim hint (top 12 of the camera area), the heartbeat pill and the focus hint
    // under the aiming frame — hide while a card reaches them: a card's top edge over one cut its letters in half
    // (the aim hint at 390×664, «En pausa» at 412×915). Measured on the card's box, again whenever that box or the
    // camera area changes size (the counters folding move the centred frame), and when the pill appears.
    const hintRef = useRef<HTMLDivElement | null>(null);
    const pillRef = useRef<HTMLDivElement | null>(null);
    const focusHintRef = useRef<HTMLDivElement | null>(null);
    const cameraAreaRef = useRef<HTMLDivElement | null>(null);
    const cardBoxRef = useRef<HTMLDivElement | null>(null);
    const [covered, setCovered] = useState<CameraLines>(NO_CAMERA_LINE_COVERED);
    const slotKind = confirm.card || confirm.checking ? 'card' : outcome ? 'verdict' : '';
    const pillOn = cam === 'on' && !playBlocked && !!health && health.state !== 'stalled';
    useLayoutEffect(() => {
        const box = cardBoxRef.current;
        if (!slotKind || !box) { setCovered(NO_CAMERA_LINE_COVERED); return; }
        const rect = (r: React.MutableRefObject<HTMLDivElement | null>) => r.current?.getBoundingClientRect() || null;
        const check = () => {
            const now = coveredCameraLines({ hint: rect(hintRef), pill: rect(pillRef), focus: rect(focusHintRef) }, box.getBoundingClientRect());
            setCovered((was) => (sameCameraLines(was, now) ? was : now));
        };
        check();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(check);
        ro.observe(box);
        if (cameraAreaRef.current) ro.observe(cameraAreaRef.current);
        return () => ro.disconnect();
    }, [slotKind, cam, pillOn]);

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
            data-card-open={confirm.card || confirm.checking ? '' : undefined}
            data-verdict-open={outcome && !confirm.card && !confirm.checking ? '' : undefined}
            onPointerDown={() => feedback.current.prime()}>
            <style>{SCANNER_CSS}</style>
            {/* Top: service + exit */}
            <div className="flex items-center gap-2 px-3 pt-[max(env(safe-area-inset-top),0.75rem)] pb-2 bg-black/80" style={{ ...SCANNER_BAR_STYLE, display: 'flex', alignItems: 'center', gap: 8, paddingLeft: SAFE_LEFT, paddingRight: SAFE_RIGHT, paddingBottom: 8, paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
                <button type="button" onClick={() => setSheet('service')} className="flex-1 min-w-0 text-left px-4 py-3 rounded-2xl bg-white/10 active:bg-white/20" style={{ flex: '1 1 0%', minWidth: 0 }} aria-label={tx('meals.scanner.change.service', 'Cambiar servicio')}>
                    <span className="block text-[10px] font-black uppercase tracking-widest text-white/60" style={{ display: 'block' }}>{tx('meals.scanner.service', 'Servicio')}</span>
                    <span className="block text-base font-black leading-tight" style={SERVICE_NAME_STYLE} data-scanner-service-name="">{service ? serviceName(tx, service, language) : tx('meals.scanner.pick', 'Elige un servicio')}</span>
                </button>
                <button type="button" onClick={onClose} className="px-4 py-3 rounded-2xl bg-white/10 active:bg-white/20 font-black text-sm" aria-label={tx('meals.scanner.exit', 'Salir')}>
                    <i className="fa-solid fa-xmark mr-1.5" aria-hidden="true"></i>{tx('meals.scanner.exit', 'Salir')}
                </button>
            </div>

            {/* Counters — fold away on a short phone while a confirmation card needs the room (SCANNER_CSS) */}
            <div data-scanner-counters="" className="grid grid-cols-3 gap-2 px-3 pb-2 text-center bg-black/80" style={{ ...SCANNER_BAR_STYLE, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, paddingLeft: SAFE_LEFT, paddingRight: SAFE_RIGHT, paddingBottom: 8, textAlign: 'center' }}>
                {[[tx('meals.count.delivered', 'Entregados'), stats?.delivered], [tx('meals.count.entitled', 'Con derecho'), stats?.entitled], [tx('meals.count.pending', 'Pendientes'), stats?.pending]].map(([label, n]: any) => (
                    <div key={label} className="rounded-xl bg-white/10 py-1.5">
                        <div className="text-xl font-black tabular-nums">{n ?? '—'}</div>
                        <div className="text-[9px] font-black uppercase tracking-widest text-white/60">{label}</div>
                    </div>
                ))}
            </div>

            {/* Camera — no page panning or pinch-zoom on it (touch-action), the bars and sheets keep theirs */}
            <div ref={cameraAreaRef} className="relative flex-1 min-h-0 overflow-hidden" data-camera-area="" style={{
                position: 'relative', flex: '1 1 0%', minHeight: 0, overflow: 'hidden', touchAction: 'none',
                boxShadow: flash === 'ok' ? 'inset 0 0 0 8px #10b981' : flash === 'bad' ? 'inset 0 0 0 8px #f43f5e' : 'none',
            }}>
                <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" style={{ ...fill, width: '100%', height: '100%', objectFit: 'cover', opacity: cam === 'on' ? 1 : 0 }} playsInline muted aria-hidden="true" />
                {cam === 'on' && !playBlocked && health?.state !== 'stalled' && (
                    <div style={{ ...fill, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, pointerEvents: 'none' }}>
                        <AimFrame frameRef={aimRef} scanning={scanning} />
                        <ScanPill health={health} tx={tx} pillRef={pillRef} covered={covered.pill} />
                        <div ref={focusHintRef} data-scanner-focus-hint="" style={{ maxWidth: 320, margin: '0 16px', padding: '4px 10px', borderRadius: 10, background: 'rgba(0,0,0,0.55)', textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.85)', visibility: covered.focus ? 'hidden' : undefined }}>
                            {tx('meals.scanner.focus.hint', 'Mantén el código recto a unos 15–20 cm: más cerca la cámara no enfoca.')}
                        </div>
                    </div>
                )}
                {cam === 'on' && (
                    <div ref={hintRef} data-scanner-aim-hint="" style={{ position: 'absolute', top: 12, left: 0, right: 0, textAlign: 'center', fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.85)', pointerEvents: 'none', textShadow: '0 1px 2px #000', visibility: covered.hint ? 'hidden' : undefined }}>{tx('meals.scanner.aim', 'Apunta al código de barras del participante')}</div>
                )}
                {cam === 'on' && read && (
                    <div style={{ position: 'absolute', top: 40, left: SAFE_LEFT, right: `calc(60px + ${SAFE_RIGHT})`, zIndex: 1 }}>
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
                    <div className="absolute right-3 top-10 flex flex-col gap-2" style={{ position: 'absolute', right: SAFE_RIGHT, top: 40, zIndex: 3, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {torch.supported && (
                            <button type="button" onClick={toggleTorch} className={`w-12 h-12 shrink-0 rounded-full flex items-center justify-center ${torch.on ? 'bg-yellow-300 text-black' : 'bg-black/60 text-white'}`} style={{ width: 48, height: 48, borderRadius: 999, background: torch.on ? '#fde047' : 'rgba(0,0,0,0.6)', color: torch.on ? '#000' : '#fff' }} aria-pressed={torch.on} aria-label={tx('meals.camera.torch', 'Linterna')}>
                                <i className="fa-solid fa-bolt" aria-hidden="true"></i>
                            </button>
                        )}
                        {devices.length > 1 && (
                            <button type="button" onClick={switchCamera} className="w-12 h-12 shrink-0 rounded-full bg-black/60 text-white flex items-center justify-center" style={{ width: 48, height: 48, borderRadius: 999, background: 'rgba(0,0,0,0.6)', color: '#fff' }} aria-label={tx('meals.camera.switch', 'Cambiar de cámara')}>
                                <i className="fa-solid fa-camera-rotate" aria-hidden="true"></i>
                            </button>
                        )}
                    </div>
                )}

                {/* 2.16.0: the confirmation card over the camera, buttons at the bottom (thumb reach). It may use
                    the whole camera area (top 8): decoding is paused, the aiming hint and torch are not needed. */}
                {(confirm.card || confirm.checking) && (
                    <div data-confirm-slot="" style={{ position: 'absolute', left: SAFE_LEFT, right: SAFE_RIGHT, bottom: 12, top: 8, zIndex: 4, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', pointerEvents: 'none' }}>
                        {/* A long card shrinks to the camera area and scrolls its middle; the name and the buttons stay visible. */}
                        <div ref={cardBoxRef} style={{ pointerEvents: 'auto', minHeight: 0, maxHeight: '100%', display: 'flex', flexDirection: 'column' }}>
                            {confirm.card
                                ? <ConfirmCard card={confirm.card} service={service} language={language} large delivering={confirm.delivering}
                                    onDeliver={() => flow.deliver()}
                                    onAuthorize={() => flow.authorize(tx('meals.force.note', 'Autorizado en el escáner'))}
                                    onCancel={() => flow.cancel()}
                                    onClose={() => flow.close()} />
                                : <CheckingCard />}
                        </div>
                    </div>
                )}
                {/* The verdict over the camera, at the bottom. 2.17.0: bounded by the camera area like the
                    confirmation card (top 8) — it used to grow upwards past it and lose its head («Entregado» and
                    the meal) on a short phone; now the status, the meal, the name and the buttons stay, the
                    person's other data give way (VERDICT_FIT). */}
                {outcome && !confirm.card && !confirm.checking && (
                    <div data-verdict-slot="" style={{ position: 'absolute', left: SAFE_LEFT, right: SAFE_RIGHT, bottom: 12, top: 8, zIndex: 4, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', pointerEvents: 'none' }}>
                        <div ref={cardBoxRef} style={{ pointerEvents: 'auto', minHeight: 0, maxHeight: '100%', display: 'flex', flexDirection: 'column' }}>
                            <VerdictCard outcome={outcome} service={service} large busy={busy} language={language}
                                armMs={confirmOn ? VERDICT_TAP_ARM_MS : 0}
                                onForce={outcome.result === 'not_entitled' ? force : undefined}
                                onArmedChange={(a) => { armedRef.current = !!a; }}
                                onUndo={undo}
                                onDismiss={() => setOutcome(null)} />
                        </div>
                    </div>
                )}
            </div>

            {/* Bottom actions */}
            <div className="grid grid-cols-2 gap-2 px-3 pt-2 pb-[max(env(safe-area-inset-bottom),0.75rem)] bg-black/80" style={{ ...SCANNER_BAR_STYLE, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, paddingLeft: SAFE_LEFT, paddingRight: SAFE_RIGHT, paddingTop: 8, paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' }}>
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
                    <div className="w-full max-h-[85%] overflow-y-auto rounded-t-3xl bg-gray-900 p-4 pb-[max(env(safe-area-inset-bottom),1rem)] space-y-3" style={{ width: '100%', maxHeight: '85%', overflowY: 'auto', overscrollBehavior: 'contain', borderRadius: '24px 24px 0 0', background: '#111827', paddingLeft: 'max(16px, env(safe-area-inset-left))', paddingRight: 'max(16px, env(safe-area-inset-right))', paddingTop: 16, paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }} onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between">
                            <h2 className="text-lg font-black">
                                {sheet === 'service' ? tx('meals.scanner.pick', 'Elige un servicio') : sheet === 'code' ? tx('meals.scanner.type', 'Escribir código') : tx('meals.scanner.search', 'Buscar por nombre')}
                            </h2>
                            <button type="button" onClick={() => setSheet(null)} className="w-10 h-10 shrink-0 rounded-full bg-white/10 flex items-center justify-center" aria-label={tx('close', 'Cerrar')}><i className="fa-solid fa-xmark" aria-hidden="true"></i></button>
                        </div>
                        {sheet === 'service' && <ConfirmToggle dark on={confirmOn} onChange={setConfirmOn} />}
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
                            <form onSubmit={(e) => { e.preventDefault(); const raw = typed; if (!normalizeCode(raw)) return; setSheet(null); scanBody({ code: raw }, true); }} className="space-y-3">
                                <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoCapitalize="characters" autoComplete="off" spellCheck={false} inputMode="text"
                                    className="w-full rounded-2xl px-4 py-4 bg-white/10 border-2 border-white/20 text-white text-2xl font-mono font-black tracking-widest outline-none focus:border-white"
                                    aria-label={tx('meals.code', 'Código')} placeholder="ABCD234XYZ" />
                                <button type="submit" disabled={!normalizeCode(typed) || busy || confirm.delivering} className="w-full py-4 rounded-2xl bg-emerald-500 text-black font-black disabled:opacity-40">{confirmOn ? tx('meals.confirm.lookup', 'Continuar') : tx('meals.deliver', 'Entregar')}</button>
                            </form>
                        )}
                        {sheet === 'search' && (
                            <PersonSearch conferenceId={conferenceId} dark busy={busy || confirm.delivering} action={confirmOn ? tx('meals.confirm.pick', 'Elegir') : undefined}
                                onPick={(p) => { setSheet(null); scanBody({ inscription_id: p.id }, true); }} />
                        )}
                    </div>
                </div>
            )}
        </div>,
        document.body,
    );
}
