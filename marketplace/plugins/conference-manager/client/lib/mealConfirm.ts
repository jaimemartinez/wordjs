/**
 * Meals (2.16.0) — the delivery CONFIRMATION, as pure pieces shared by the phone scanner and «Entrega».
 *
 * Before 2.16.0 a valid scan was recorded at once. Now (by default, per device) a scan only ASKS the server
 * (POST /meals/check, read-only) and opens a card with the meal and the person's configured data:
 *   - 'ready'         → «Entregar» (POST /meals/deliver with the SAME body) or «Cancelar»;
 *   - 'not_entitled'  → «Entregar sin derecho (autorizar)» (deliver with force:true) or «Cancelar»;
 *   - anything else   → information + «Cerrar».
 * «Cancelar» records NOTHING: the person stays pending, and the next scan of the same badge opens the card
 * again. Only the server's 'delivered' verdict ever reads «Entregado».
 *
 * `createConfirmFlow` is the state machine both screens drive. While a decision card is open (or a request
 * runs) a new scan never touches it: «Entrega» queues it (a USB wedge must not deliver the open card's
 * person by accident, and no code may be dropped), the phone scanner ignores it (decoding is paused).
 * «Entregar» always applies to the card's own scan, never to one that arrived after it. In «Entrega» the
 * queue also waits for the delivery's RESULT to be seen: «Entregado» stays `settleMs` before the next card,
 * and any other result (offline, error, a race with another station) waits for the operator (Enter, Esc, a
 * click) — the next card must never hide a delivery that was not recorded.
 *
 * Accidental decisions are filtered out on both screens: Enter only answers a card that has been on screen
 * for ENTER_ARM_MS and is never a held-down key or the second key of a burst (a scanner's CR+LF suffix, a
 * double press); a tap only counts once a card has been on screen for TAP_ARM_MS — and the «Entregado» card
 * that replaces a pressed «Entregar» (its «Deshacer» sits where «Entregar» was) for VERDICT_TAP_ARM_MS.
 */
import { normalizeCode } from './meals';

export type CheckResult = 'ready' | 'not_entitled' | 'already' | 'cancelled' | 'unknown' | 'other_conference';
/** A card's result: the server's verdict, or a client-side outcome of the check request. */
export type CardResult = CheckResult | 'offline' | 'no_service' | 'error';
export type ScanBody = { code?: string; inscription_id?: number };
/** One configured entry of the card (server: person.fields). Built-in keys start with '@'. */
export type DisplayField = { key: string; label: string; value: string | null; hidden?: boolean };
export type AvailableField = { key: string; label: string; builtin: boolean; type?: string };

/** A card that waits for a decision («Entregar» / «Cancelar»). Everything else only informs. */
export const isDecision = (r: CardResult | null | undefined): boolean => r === 'ready' || r === 'not_entitled';

// ── Per-device preference («Confirmar antes de entregar», default ON) ─────────────────────────────────
export const CONFIRM_PREF_KEY = 'conference-manager:meals.confirm';
/** Fired on `window` after a write, so an open «Entrega» tab and the scanner stay in step. */
export const CONFIRM_PREF_EVENT = 'cm-meals-confirm-pref';
type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void } | null | undefined;
const defaultStorage = (): StorageLike => {
    try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
};
/** ON unless this device switched it off. Blocked / missing storage (private mode, previews) = ON. */
export function readConfirmPref(storage: StorageLike = defaultStorage()): boolean {
    try { return storage ? storage.getItem(CONFIRM_PREF_KEY) !== '0' : true; } catch { return true; }
}
/** Remembers the choice on this device; never throws (the toggle still works for this page load). */
export function writeConfirmPref(on: boolean, storage: StorageLike = defaultStorage()): void {
    try { storage?.setItem(CONFIRM_PREF_KEY, on ? '1' : '0'); } catch { /* blocked storage */ }
    try { if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new CustomEvent(CONFIRM_PREF_EVENT, { detail: on })); } catch { /* no CustomEvent */ }
}

// ── Keyboard («Entrega»: a USB / Bluetooth wedge types the code + Enter into the scan input) ──────────
export type CardKeyAction = 'deliver' | 'cancel' | 'close' | null;
/** Enter only answers a card (or a delivery outcome waiting to be seen) that has been on screen this long. */
export const ENTER_ARM_MS = 500;
/**
 * An Enter this soon after the previous key belongs to the same burst — the second Enter of a scanner's
 * CR+LF suffix, a double press — and is never a decision.
 */
export const ENTER_BURST_MS = 300;
/** When the key came, relative to what is on screen (one clock: the caller's). */
export type KeyContext = {
    now: number;
    /** When the card (or the outcome waiting to be seen) appeared. */
    shownAt?: number | null;
    /** The previous keydown in the scan input (a typed character, the previous Enter). */
    lastKeyAt?: number | null;
    /** KeyboardEvent.repeat: the key is held down. */
    repeat?: boolean;
};
/**
 * What a key does to the open card — `result` is the card's, or 'held' for a delivery outcome waiting to be
 * seen. Enter with ANYTHING typed in the input is a new scan (the caller queues it, or drops garbage) —
 * never «Entregar» for the card on screen. Only Enter on an EMPTY input confirms a 'ready' card or closes an
 * informative one / the held outcome; it never authorises a 'not_entitled' one (that takes the button).
 * Escape = «Cancelar» (or «Cerrar»). With `ctx` (the live screen always passes it): a held-down key does
 * nothing; an Enter within ENTER_BURST_MS of the previous key, or within ENTER_ARM_MS of the card
 * appearing, does nothing.
 */
export function cardKeyAction(key: string, result: CardResult | 'held' | null | undefined, inputText = '', ctx?: KeyContext): CardKeyAction {
    if (!result) return null;
    if (ctx?.repeat) return null;
    if (key === 'Escape') return isDecision(result as CardResult) ? 'cancel' : 'close';
    if (key !== 'Enter') return null;
    if (String(inputText ?? '').trim()) return null;
    if (result === 'not_entitled') return null;
    if (ctx) {
        if (ctx.lastKeyAt != null && ctx.now - ctx.lastKeyAt < ENTER_BURST_MS) return null;
        if (ctx.shownAt != null && ctx.now - ctx.shownAt < ENTER_ARM_MS) return null;
    }
    return result === 'ready' ? 'deliver' : 'close';
}

// ── Taps ─────────────────────────────────────────────────────────────────────────────────────────────
/** A confirmation card's buttons ignore taps for this long after it appears. */
export const TAP_ARM_MS = 400;
/** The verdict card that follows «Entregar» ignores taps for this long («Deshacer» sits where «Entregar» was). */
export const VERDICT_TAP_ARM_MS = 600;
/** A tap counts: the element has been on screen at least `ms` (no `ms`, or an unknown time = always). */
export const tapArmed = (shownAt: number | null | undefined, now: number, ms: number | null | undefined): boolean =>
    !ms || shownAt == null || now - shownAt >= ms;

// ── The flow ─────────────────────────────────────────────────────────────────────────────────────────
export type ConfirmCard = {
    /** Increments per card, so an identical answer still re-renders. */
    seq: number;
    serviceId: number;
    /** Exactly what was scanned / picked: «Entregar» sends this body, nothing else. */
    body: ScanBody;
    result: CardResult;
    /** The server's answer (service, person with fields, source, delivery fields…). */
    verdict?: any;
    message?: string;
    /** The normalized code (shown on «Código no encontrado»). */
    code?: string;
    /** When the card appeared (the flow's clock): Enter and taps arm after it. */
    shownAt?: number;
};
export type ConfirmState = {
    card: ConfirmCard | null;
    /** Scans waiting behind an open decision card or a delivery's result («Entrega» only). */
    waiting: number;
    checking: boolean;
    delivering: boolean;
    /** «Entrega»: a delivery's result other than 'delivered' waits to be seen (close() acknowledges it). */
    held: boolean;
    /** When `held` began (the flow's clock), else null. */
    heldAt: number | null;
    /** «Entrega»: «Entregado» stays on screen for `settleMs` before the next queued card. */
    settling: boolean;
};
export type CheckAnswer = { result: CardResult; verdict?: any; message?: string; code?: string };
export type ConfirmFlowOptions = {
    /** POST /meals/check — must resolve (never reject) to the card's result. */
    check: (serviceId: number, body: ScanBody) => Promise<CheckAnswer>;
    /** POST /meals/deliver — resolves to the delivery outcome (any shape; handed to onResult). */
    deliver: (serviceId: number, body: ScanBody & { force?: boolean; note?: string }) => Promise<any>;
    onChange?: (s: ConfirmState) => void;
    /** A check answered (sound, service sheet…). */
    onCheck?: (card: ConfirmCard) => void;
    /** «Entregar» / «Entregar sin derecho» answered: the delivery outcome and the card it was for. */
    onResult?: (outcome: any, card: ConfirmCard) => void;
    /**
     * A card left the screen: 'deliver' | 'cancel' | 'close' | 'replaced' | 'reset' — with the delivery
     * outcome for 'deliver'.
     */
    onClose?: (card: ConfirmCard, why: string, outcome?: any) => void;
    /**
     * true («Entrega»): scans during a decision are queued, and the queue waits for the delivery's result to
     * be seen; false (phone): ignored.
     */
    queue?: boolean;
    /** At most this many queued scans (older ones are kept; extra ones are refused). */
    maxQueue?: number;
    /** «Entrega»: how long «Entregado» stays before the next queued card (default 1200 ms; 0 = none). */
    settleMs?: number;
    /** The clock (tests). */
    now?: () => number;
};
export type ScanAccepted = 'checking' | 'queued' | 'ignored';

export function createConfirmFlow(opts: ConfirmFlowOptions) {
    const maxQueue = opts.maxQueue ?? 50;
    const settleMs = opts.settleMs ?? 1200;
    const now = opts.now ?? (() => Date.now());
    let card: ConfirmCard | null = null;
    let checking = false;
    let delivering = false;
    let held = false;
    let heldAt: number | null = null;
    let settleTimer: any = null;
    let gen = 0;
    let seq = 0;
    let disposed = false;
    const pending: { serviceId: number; body: ScanBody }[] = [];
    const snapshot = (): ConfirmState => ({ card, waiting: pending.length, checking, delivering, held, heldAt, settling: settleTimer !== null });
    const emit = () => { if (!disposed) opts.onChange?.(snapshot()); };
    const busy = () => checking || delivering;
    const blocked = () => busy() || held || settleTimer !== null || (!!card && isDecision(card.result));
    const stopSettle = () => { if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; } };
    const unhold = () => { held = false; heldAt = null; stopSettle(); };

    const closeCard = (why: string, outcome?: any) => {
        const c = card;
        card = null;
        if (c && !disposed) opts.onClose?.(c, why, outcome);
    };
    // The next queued scan, when nothing blocks.
    const next = () => {
        if (disposed || blocked() || !pending.length) { emit(); return; }
        const n = pending.shift()!;
        runCheck(n.serviceId, n.body);
    };
    const runCheck = (serviceId: number, body: ScanBody) => {
        const my = gen;
        if (card) closeCard('replaced');
        checking = true;
        emit();
        Promise.resolve()
            .then(() => opts.check(serviceId, body))
            .catch((e: any) => ({ result: 'error' as CardResult, message: e?.message }))
            .then((a: CheckAnswer) => {
                if (disposed || my !== gen) return;
                checking = false;
                card = { seq: ++seq, serviceId, body, result: a?.result || 'error', verdict: a?.verdict, message: a?.message, code: a?.code ?? (body.code ? normalizeCode(body.code) || String(body.code).trim() : undefined), shownAt: now() };
                // The service is gone: the scans queued for it would only repeat the same answer.
                if (card.result === 'no_service') for (let i = pending.length - 1; i >= 0; i--) if (pending[i].serviceId === serviceId) pending.splice(i, 1);
                opts.onCheck?.(card);
                if (isDecision(card.result)) emit();
                else next();     // an informative card never holds the line
            });
    };
    const runDeliver = (extra: { force?: boolean; note?: string }) => {
        const c = card!;
        const my = gen;
        delivering = true;
        emit();
        Promise.resolve()
            .then(() => opts.deliver(c.serviceId, { ...c.body, ...extra }))
            .catch((e: any) => ({ result: 'error', message: e?.message }))
            .then((outcome: any) => {
                if (disposed || my !== gen) return;
                delivering = false;
                if (card === c) closeCard('deliver', outcome);
                opts.onResult?.(outcome, c);
                if (opts.queue) {
                    if (outcome?.result !== 'delivered') { held = true; heldAt = now(); }
                    else if (settleMs > 0) {
                        settleTimer = setTimeout(() => {
                            settleTimer = null;
                            if (!disposed && my === gen) next();
                        }, settleMs);
                    }
                }
                next();
            });
    };

    return {
        /** A code was read (camera, USB wedge, typed in «Entrega»'s scan input). */
        scan(serviceId: number, body: ScanBody): ScanAccepted {
            if (disposed || !serviceId) return 'ignored';
            if (blocked()) {
                if (!opts.queue || pending.length >= maxQueue) return 'ignored';
                pending.push({ serviceId, body });
                emit();
                return 'queued';
            }
            runCheck(serviceId, body);
            return 'checking';
        },
        /**
         * A MANUAL entry (a person picked by name, a code typed in the phone's sheet): the operator chose THIS
         * person now. It replaces a card waiting for a decision (closed as «Cancelar»: nothing was recorded)
         * or a result waiting to be seen, and goes before the queued scans. While a request runs it waits at
         * the head of the queue («Entrega») or is ignored (phone).
         */
        pick(serviceId: number, body: ScanBody): ScanAccepted {
            if (disposed || !serviceId) return 'ignored';
            if (busy()) {
                if (!opts.queue) return 'ignored';
                pending.unshift({ serviceId, body });
                emit();
                return 'queued';
            }
            if (card && isDecision(card.result)) closeCard('cancel');
            unhold();
            runCheck(serviceId, body);
            return 'checking';
        },
        /** «Entregar» — only a 'ready' card, once. */
        deliver(): boolean {
            if (disposed || busy() || !card || card.result !== 'ready') return false;
            runDeliver({});
            return true;
        },
        /** «Entregar sin derecho (autorizar)» — only a 'not_entitled' card: the authorised override. */
        authorize(note?: string): boolean {
            if (disposed || busy() || !card || card.result !== 'not_entitled') return false;
            runDeliver({ force: true, ...(note ? { note } : {}) });
            return true;
        },
        /** «Cancelar»: records NOTHING — the card closes, the person stays pending. */
        cancel(): boolean {
            if (disposed || delivering || !card || !isDecision(card.result)) return false;
            closeCard('cancel');
            next();
            return true;
        },
        /** «Cerrar» an informative card — or acknowledge a delivery's result that holds the queue. */
        close(): boolean {
            if (disposed) return false;
            if (!card && held) { held = false; heldAt = null; next(); return true; }
            if (!card || isDecision(card.result)) return false;
            closeCard('close');
            next();
            return true;
        },
        /** Another service / the toggle switched off: drop the card, the queue and any answer still on its way. */
        reset() {
            gen++;
            pending.length = 0;
            checking = false; delivering = false;
            unhold();
            if (card) closeCard('reset');
            emit();
        },
        dispose() { gen++; pending.length = 0; unhold(); card = null; disposed = true; },
        state: snapshot,
        /** A card is on screen (the phone scanner pauses decoding). */
        isOpen: () => !!card,
        isBusy: busy,
    };
}
export type ConfirmFlow = ReturnType<typeof createConfirmFlow>;

// ── «Entrega»: the decision is always in view ────────────────────────────────────────────────────────
/**
 * What «Entrega»'s slot under the scan input shows NOW, as a key that changes exactly when something new
 * appears there: the check on its way, a card (each scan has its own seq), a delivery's result (and, with the
 * confirmation ON, again when that result starts holding the queue). A re-render of the same thing (the waiting
 * count, «Registrando…») keeps the key. null = nothing to bring into view: an empty slot.
 * 2.17.0 live round: with the confirmation OFF (a USB wedge delivers at once) the verdict was never capped nor
 * scrolled to — at 320×460 «Sin derecho» opened with «Entregar de todas formas» 570 px below the fold, «Entregado»
 * with «Deshacer» 370 px below it, and on a 1280×800 desktop the card started at y 771. Now every result is,
 * whichever way it was recorded (a scan, a name picked, «Sí, entregar»); the confirmation OFF has no card and
 * no check of its own, so only its results count.
 */
export function decisionSlotKey(s: { confirmOn: boolean; card?: { seq: number } | null; checking?: boolean; outcome?: { seq?: number } | null; held?: boolean }): string | null {
    if (s.confirmOn && s.card) return `card:${s.card.seq}`;
    if (s.confirmOn && s.checking) return 'checking';
    if (s.outcome) return `result:${s.outcome.seq ?? ''}${s.confirmOn && s.held ? ':held' : ''}`;
    return null;
}

/** The few DOM members the reveal reads: an Element in the page, a stub in the tests. */
export type RevealEl = {
    getBoundingClientRect(): { top: number; bottom: number };
    parentElement: RevealEl | null;
    querySelector?: (selector: string) => { getBoundingClientRect(): { height: number }; scrollHeight?: number; clientHeight?: number } | null;
    scrollIntoView?: (arg?: boolean | { block?: 'start' | 'center' | 'end' | 'nearest'; inline?: 'start' | 'center' | 'end' | 'nearest'; behavior?: 'auto' | 'smooth' }) => void;
    style?: { setProperty(name: string, value: string): void };
};
export type RevealWin = {
    innerHeight: number;
    visualViewport?: { offsetTop: number; height: number } | null;
    getComputedStyle?: (el: any) => { overflowY?: string };
    matchMedia?: (query: string) => { matches: boolean };
};
/** Room kept between the card and the edges of the visible band. */
export const REVEAL_MARGIN_PX = 12;
/** The CSS custom property (set on the slot) that the card's wrapper reads as its max-height. */
export const REVEAL_FIT_VAR = '--cm-fit';

/**
 * The band of the screen where `el` can be seen: the visual viewport (an on-screen keyboard and pinch-zoom
 * included), clipped by every ancestor that clips its content — the admin's and the plugin's own scrollers,
 * whose headers sit OUTSIDE the band (on a phone the plugin's header alone takes 250 px above it).
 */
export function visibleBand(el: RevealEl, win: RevealWin): { top: number; bottom: number } {
    const vv = win.visualViewport;
    let top = vv ? vv.offsetTop : 0;
    let bottom = vv ? vv.offsetTop + vv.height : win.innerHeight;
    for (let a = el.parentElement; a; a = a.parentElement) {
        let overflow = '';
        try { overflow = String(win.getComputedStyle?.(a)?.overflowY || ''); } catch { /* detached node */ }
        if (/^(auto|scroll|hidden|clip|overlay)$/.test(overflow)) {
            const r = a.getBoundingClientRect();
            top = Math.max(top, r.top);
            bottom = Math.min(bottom, r.bottom);
        }
    }
    return { top, bottom };
}
/**
 * What of a confirmation card inside `el` must stay on screen: its meal band, the header with the status and
 * the NAME, and the buttons (plus its 3 px borders) — the parts that never shrink. 0 = no card there. The name
 * gives way last, scrolling inside its header (2.17.0); measured while a cap squeezes it, the lines it hides
 * count too — the card's essentials hold the WHOLE name.
 * 2.17.0 — «Entrega»'s verdict card is capped the same way (live round at 320×460: 888 px tall, «Deshacer» far
 * below the fold): everything of it but the part that gives way (the person's other data and «Más abajo» under
 * them) — the head with the status and the meal, the NAME (whole), the buttons, an open question, its padding.
 */
export function cardEssentials(el: RevealEl): number {
    const h = (selector: string) => { try { return el.querySelector?.(selector)?.getBoundingClientRect().height || 0; } catch { return 0; } };
    const hiddenOf = (selector: string) => {
        try {
            const n = el.querySelector?.(selector);
            return Math.max(0, (Number(n?.scrollHeight) || 0) - (Number(n?.clientHeight) || 0));
        } catch { return 0; }     // detached node
    };
    const verdict = h('[data-verdict]');
    if (verdict > 0) return Math.ceil(verdict - h('[data-verdict-scroll]') - h('[data-verdict-more]') + hiddenOf('[data-verdict-name]'));
    const parts = h('[data-confirm-meal]') + h('[data-confirm-head]') + h('[data-confirm-actions]');
    return parts > 0 ? Math.ceil(parts + hiddenOf('[data-confirm-name]') + 6) : 0;
}

/**
 * 2.17.0 — the person's other data on both cards (the confirmation card and the phone scanner's verdict card)
 * end on a WHOLE line. The live round on short phones found the part that scrolls ending anywhere: a lone
 * faded «LOCALIDAD» with no value, an «EMAIL» with only the tops of its value, a sliver of a label above «Más
 * abajo». Now, measured after layout: when everything fits, nothing changes; when it does not, the part is cut
 * at the last line that fits together with the «Más abajo» line under it (MORE_CUE_PX) — after a whole entry,
 * or inside one after a whole line of its VALUE (a label never stands alone) — and scrolls to show the rest;
 * when not even that fits, the part is left out (height 0). The status, the name and the buttons never give
 * way to it. Each entry: its `bottom` from the top of the part that scrolls, and the `lines` its value may be
 * cut after (in order); `room`: the part's height as laid out; `content`: its scrollHeight — layout px, whole
 * numbers (1 px is rounding, 2 px a cut line). `height` null = all of it, uncut; `hidden` = the entries not
 * wholly shown.
 */
export const MORE_CUE_PX = 20;
export type DetailsFit = { height: number | null; hidden: number };
export type DetailEntry = { bottom: number; lines?: number[] };
export function detailsCut(entries: DetailEntry[], room: number, content: number, cue = MORE_CUE_PX): DetailsFit {
    if (content <= room + 1) return { height: null, hidden: 0 };
    const last = entries.length ? entries[entries.length - 1].bottom : 0;
    // Only the part's bottom padding is out of view: every entry is whole, nothing more to say.
    if (entries.length && last <= room + 1) return { height: last, hidden: 0 };
    const avail = room - cue;
    let height = 0, whole = 0;
    for (const e of entries) {
        if (e.bottom <= avail) { height = e.bottom; whole++; continue; }
        // It does not fit whole: up to the last line of its value that fits, if one does.
        for (const l of e.lines || []) if (l <= avail && l > height) height = l;
        break;
    }
    return { height, hidden: entries.length - whole };
}
/** The part that scrolls (`position: relative`: its entries' offsetParent), as measureDetails reads it. */
export type DetailsEl = {
    clientHeight: number; scrollHeight: number; offsetHeight?: number; scrollTop?: number;
    getBoundingClientRect?: () => { top: number; height: number };
    querySelectorAll(selector: string): ArrayLike<any>;
};
/** The entries: the configured ones (`data-field`: «LABEL value») and the card's own lines (`data-entry`). */
export const DETAIL_ENTRY_SELECTOR = '[data-field],[data-entry]';
/**
 * Where an entry may be cut inside: the bottom of each line of its value — its last element (the value of
 * «LABEL value»), or its own text — in the part's layout px (rects / the card's entry-animation scale +
 * scrollTop). The bottom of a line's text, not of its line box: the next line's glyphs start below it.
 */
export function valueLineBottoms(entry: any, top: number, scale: number, scrollTop = 0): number[] {
    try {
        const target = entry.lastElementChild || entry;
        const range = entry.ownerDocument?.createRange?.();
        if (!range || !(scale > 0)) return [];
        range.selectNodeContents(target);
        const rects = Array.from(range.getClientRects() as ArrayLike<{ bottom: number; height: number }>).filter((r) => r.height > 0);
        // Rounded up to a whole px (0.01 px of float noise is not a line).
        return [...new Set(rects.map((r) => Math.ceil((r.bottom - top) / scale + scrollTop - 0.01)))].sort((a, b) => a - b);
    } catch { return []; }
}
export function measureDetails(el: DetailsEl): DetailsFit {
    let top = 0, scale = 0;
    try {
        const box = el.getBoundingClientRect?.();
        if (box && el.offsetHeight) { top = box.top; scale = box.height / el.offsetHeight; }
    } catch { /* no layout */ }
    const entries = Array.from(el.querySelectorAll(DETAIL_ENTRY_SELECTOR)).map((e) => ({
        bottom: e.offsetTop + e.offsetHeight,
        lines: valueLineBottoms(e, top, scale, el.scrollTop || 0),
    }));
    return detailsCut(entries, el.clientHeight, el.scrollHeight);
}
/**
 * The room changed since the part was measured (another layout capped the card — «Entrega» does it in its own
 * layout effect, after the card's): measure it again. Uncut, it now overflows; cut, it is now shorter than the cut.
 */
export const detailsStale = (fit: DetailsFit, el: { scrollHeight: number; clientHeight: number }): boolean =>
    (fit.height == null ? el.scrollHeight > el.clientHeight + 1 : el.clientHeight < fit.height - 1);

/**
 * 2.17.0 — the meal line shown whole on a tap (both cards). The live round at 320×460 found it cut mid-phrase
 * with no cue: a fixed two-line cap («Almuerzo — Almuerzo / campestre en la finca del», the day that was on
 * screen before the tap gone). Now it is WHOLE, and the person's other data give way to it; only when the card
 * cannot hold it without cutting the essentials (the name scrolling inside itself, the card or its header
 * clipping) does it keep the whole lines that fit, «Más abajo ↓» under them, and scroll to the rest.
 * `textLineBottoms`: the bottom of each LINE of `el`'s text (an icon and the spans of one line merged), in its
 * layout px from its top — rects un-scaled (the card's entry animation) and scrolled — rounded up; where a line's
 * glyph box overlaps the next one's (line-height 1.1), halfway between them.
 */
export function textLineBottoms(el: any): number[] {
    try {
        const box = el.getBoundingClientRect();
        const scale = el.offsetHeight ? box.height / el.offsetHeight : 0;
        const range = el.ownerDocument?.createRange?.();
        if (!range || !(scale > 0)) return [];
        range.selectNodeContents(el);
        const rects = Array.from(range.getClientRects() as ArrayLike<{ top: number; bottom: number; height: number }>)
            .filter((r) => r.height > 0)
            .map((r) => ({ top: (r.top - box.top) / scale + (el.scrollTop || 0), bottom: (r.bottom - box.top) / scale + (el.scrollTop || 0) }))
            .sort((a, b) => a.top - b.top);
        const lines: { top: number; bottom: number }[] = [];
        for (const r of rects) {
            const last = lines[lines.length - 1];
            // The same line: it starts above the middle of the line so far.
            if (last && r.top < (last.top + last.bottom) / 2) last.bottom = Math.max(last.bottom, r.bottom);
            else lines.push({ ...r });
        }
        // A tight line-height (1.1) makes a line's glyph box overlap the next one's: the cut goes between them.
        return lines.map((l, i) => {
            const next = lines[i + 1];
            return Math.ceil((next && next.top < l.bottom ? (l.bottom + next.top) / 2 : l.bottom) - 0.01);
        });
    } catch { return []; }
}
/**
 * 2.17.0 — the most lines a button's whole label may take («Entregar sin derecho (autorizar)» of the
 * confirmation card). The live round found it in four lines in a 118 px button on a 390×664 / 390×844 phone, and
 * in three or four on a 412×915 one — the media rules gave «Autorizar» only up to 380 px wide or on a short
 * screen. Now the whole label shows only while it takes at most this many lines, at whatever width, language or
 * font; else the short one (its accessible name stays whole).
 */
export const LABEL_MAX_LINES = 2;
/**
 * Whether `el`'s text (the whole label, laid out) takes more than `max` lines (textLineBottoms). Without a layout
 * (hidden by a media rule, no Range, a throw) it has no lines: never too long — what shows then is the CSS's call.
 */
export const labelTooLong = (el: any, max = LABEL_MAX_LINES): boolean => textLineBottoms(el).length > max;
/**
 * How tall the open meal line may be: up to the bottom of its last line that fits in its height less what the
 * essentials lack (`over`) and less the «Más abajo» line it then needs (`cueShown`: already under it) — or 0,
 * not even one line: it closes again (the name always wins). `over` ≤ 2 px is rounding: nothing to do (null).
 */
export function openMealCut(lines: number[], height: number, over: number, cueShown: boolean, cue = MORE_CUE_PX): number | null {
    if (!(over > 2)) return null;
    const room = height - over - (cueShown ? 0 : cue);
    let cut = 0;
    for (const b of lines) if (b <= room + 1 && b > cut) cut = b;
    return cut;
}
/**
 * The max-height the card gets: the room inside `band` less a margin at each end (its middle scrolls below
 * that), never less than its essentials while the band can hold them (the margins give way first) — or null,
 * no cap, when the band cannot hold even those (a 320×568 phone under the plugin's header): then the card
 * keeps its height and its top (meal, status, name) is what comes into view.
 */
export function fitHeight(band: { top: number; bottom: number }, essentials = 0, margin = REVEAL_MARGIN_PX): number | null {
    const height = Math.floor(band.bottom - band.top);
    if (essentials > height) return null;
    const cap = Math.max(essentials, height - 2 * margin);
    return cap > 0 ? cap : null;
}
/** The user asked the system for less motion (a failing matchMedia counts as no). */
export function prefersReducedMotion(win: Pick<RevealWin, 'matchMedia'> | null | undefined): boolean {
    try { return !!win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch { return false; }
}
/**
 * Bring «Entrega»'s decision slot into view (live round of 2.16.0: at 1280×800 the card opened at y≈771,
 * below the fold, and nothing scrolled — a USB-wedge operator would have confirmed blind). First the card is
 * capped to the visible band (REVEAL_FIT_VAR on the slot), so its meal, name and buttons fit on screen at
 * once (see fitHeight); then the slot's NEAREST edge is scrolled into view: nothing moves when it is already
 * visible, the scan input right above it stays visible whenever both fit, and a slot taller than the band
 * shows its top. Instant under prefers-reduced-motion, smooth
 * otherwise. The focus is never touched (the wedge keeps typing into the scan input). Returns whether it
 * scrolled.
 */
export function revealSlot(el: RevealEl | null | undefined, win: RevealWin | null | undefined): boolean {
    if (!el || !win) return false;
    try {
        const fit = fitHeight(visibleBand(el, win), cardEssentials(el));
        el.style?.setProperty(REVEAL_FIT_VAR, fit == null ? 'none' : `${fit}px`);
    } catch { /* no CSSOM */ }
    return revealNearest(el, win);
}
/**
 * Scroll `el`'s NEAREST edge into view (its scroll-margin kept): nothing moves when it is already on screen,
 * one that opened below the fold comes up until its bottom is in view (a taller one shows its top). Instant
 * under prefers-reduced-motion, smooth otherwise; the focus is never touched (a USB wedge keeps typing into
 * the scan input). 2.17.0: «Últimas entregas»' inline «¿Deshacer…?» and «Entrega»'s «¿Entregar de todas
 * formas?» open UNDER the button that was tapped — on an iPhone SE their buttons landed at, or below, the
 * bottom edge. Returns whether it scrolled.
 */
export function revealNearest(el: Pick<RevealEl, 'scrollIntoView'> | null | undefined, win: Pick<RevealWin, 'matchMedia'> | null | undefined): boolean {
    if (!el || !win || typeof el.scrollIntoView !== 'function') return false;
    try {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion(win) ? 'auto' : 'smooth' });
        return true;
    } catch { return false; }
}
/**
 * An inline question that opened under the button that was tapped («Entrega»'s «¿Entregar de todas formas?»):
 * the whole CARD it sits in into view when that fits in the visible band — the operator authorises seeing the
 * status and the name (2.17.0 live round: with the question's own edge brought in, the status and the name sat
 * above the top edge from 320×460 to 390×664) — else the whole question when it fits (revealNearest, its
 * scroll-margins kept), else its BUTTONS (live round, 320×460: the question was taller than the screen, so its
 * nearest edge was its top, and «Sí, entregar» / «Cancelar» stayed below the bottom edge). Returns whether it
 * scrolled; never throws.
 */
export function revealAsk(el: RevealEl | null | undefined, win: RevealWin | null | undefined, buttons?: Pick<RevealEl, 'scrollIntoView'> | null, card?: RevealEl | null): boolean {
    if (!el || !win) return false;
    let target: Pick<RevealEl, 'scrollIntoView'> = el;
    if (buttons || card) {
        try {
            // The band the page shows the card in — measured from the card when there is one: the card scrolls inside
            // itself when it must, so from the question's side the card's own box clipped the band (live: a 353 px
            // card in a 383 px band was «too tall» for the 310 px left of it under its top edge).
            const band = visibleBand(card || el, win);
            const room = band.bottom - band.top - 2 * REVEAL_MARGIN_PX;
            const tall = (n: Pick<RevealEl, 'getBoundingClientRect'>) => { const r = n.getBoundingClientRect(); return r.bottom - r.top > room; };
            if (card && !tall(card)) target = card;
            else if (buttons && tall(el)) target = buttons;
        } catch { /* no layout: the whole question */ }
    }
    return revealNearest(target, win);
}
/**
 * 2.17.0 — «Últimas entregas»' «¿Deshacer…?» opens under the row whose undo was tapped. The live round at 320×460
 * scrolled the question's nearest edge into view, and the top of the row — the person's name — was left above the
 * band, sliced by the edge under the admin header. Now the WHOLE ROW is brought into view (revealAsk with the row as
 * the card: the visible band below that header, the scroll-margins kept); for that it must fit the band. Level 0
 * asks the whole question (the meal and the person); level 1 the short one («¿Deshacer la entrega de Almuerzo?» —
 * the row right above names both; the whole question stays the dialog's accessible name), taken while the row with
 * the whole question is taller than the band less a margin at each end (1 px is rounding). Never below level 1.
 */
export const UNDO_ASK_LEVELS = 2;
export function undoAskStepDown(level: number, row: RevealEl | null | undefined, win: RevealWin | null | undefined, margin = REVEAL_MARGIN_PX): number {
    if (!row || !win || level >= UNDO_ASK_LEVELS - 1) return level;
    try {
        const band = visibleBand(row, win);
        const r = row.getBoundingClientRect();
        return r.bottom - r.top > band.bottom - band.top - 2 * margin + 1 ? level + 1 : level;
    } catch { return level; }      // detached node, no layout
}

// ── Phone: which badge to hold after its card closed ─────────────────────────────────────────────────
const failedResult = (r: unknown) => r === 'offline' || r === 'error' || r === 'no_service';
/**
 * The phone scanner holds the badge of a card that just closed: it must leave the camera for 3 s before it
 * opens a card again («Cancelar» would otherwise bring the same card straight back). Never after a reset
 * (another service, the toggle switched off — like 2.15, the same badge can be read again at once) or a
 * replacement, and never when the check or the delivery failed (offline, error, no service): «vuelve a
 * escanear» must work. `hint`: after «Cancelar», the badge shown again says why nothing opens.
 */
export function holdAfterClose(card: Pick<ConfirmCard, 'result' | 'body'> | null | undefined, why: string, outcome?: { result?: string } | null): { code: string; hint: boolean } | null {
    if (!card || why === 'reset' || why === 'replaced') return null;
    if (failedResult(card.result) || failedResult(outcome?.result)) return null;
    const code = normalizeCode(card.body?.code);
    return code ? { code, hint: why === 'cancel' } : null;
}

// ── Display fields ───────────────────────────────────────────────────────────────────────────────────
export const BUILTIN_DISPLAY_KEYS = ['@name', '@location', '@reg_code', '@payment_status', '@room'];
export const DEFAULT_DISPLAY_KEYS = ['@name', '@location'];
/** The full name is always on the card, at the top: staff must see WHO they deliver to (the server enforces it too). */
export const NAME_KEY = '@name';
/** The name first, once; the rest in their order. */
export const withName = (keys: string[]): string[] => [NAME_KEY, ...(keys || []).filter((k) => k !== NAME_KEY)];

export type DisplayLabels = {
    /** Translated label of a built-in key, or null to keep the server's. */
    builtin: (key: string) => string | null;
    noLocation: string;
    noRoom: string;
    hidden: string;
    empty: string;
    payment: (status: string) => string;
};
/** The label the card shows: a built-in's translation, a form field's own label (the admin's text). */
export const displayLabel = (f: Pick<DisplayField, 'key' | 'label'>, L: Pick<DisplayLabels, 'builtin'>): string =>
    (f.key.startsWith('@') ? L.builtin(f.key) : null) || f.label || f.key;
/** The text the card shows for one entry. */
export function displayValue(f: DisplayField, L: DisplayLabels): string {
    if (f.hidden) return L.hidden;
    const v = f.value == null ? '' : String(f.value).trim();
    if (f.key === '@location' && !v) return L.noLocation;
    if (f.key === '@room' && !v) return L.noRoom;
    if (!v) return L.empty;
    if (f.key === '@payment_status') return L.payment(v);
    return v;
}

/**
 * Checkbox list order for the configuration: the chosen keys in their order (the name first and LOCKED:
 * always shown, never moved), then the rest as offered.
 */
export function displayOptions(available: AvailableField[], selected: string[]): (AvailableField & { on: boolean; index: number; locked: boolean })[] {
    const byKey = new Map(available.map((f) => [f.key, f]));
    const sel = withName(selected).filter((k) => byKey.has(k));
    const chosen = sel.map((k, index) => ({ ...byKey.get(k)!, on: true, index, locked: k === NAME_KEY }));
    const rest = available.filter((f) => !sel.includes(f.key)).map((f) => ({ ...f, on: false, index: -1, locked: false }));
    return [...chosen, ...rest];
}
/** Tick / untick: a newly ticked key goes to the end of the chosen list. The name cannot be unticked. */
export const toggleDisplayKey = (selected: string[], key: string): string[] =>
    (key === NAME_KEY ? withName(selected) : selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
/** Whether up (-1) / down (+1) can move `key` (the name stays first; nothing moves above it). */
export function canMoveDisplayKey(selected: string[], key: string, dir: -1 | 1): boolean {
    const list = withName(selected);
    const i = list.indexOf(key), j = i + dir;
    return key !== NAME_KEY && i > 0 && j > 0 && j < list.length;
}
/** Up (-1) / down (+1) within the chosen list; at an end (or next to the locked name) it stays put. */
export function moveDisplayKey(selected: string[], key: string, dir: -1 | 1): string[] {
    if (!canMoveDisplayKey(selected, key, dir)) return selected;
    const out = withName(selected);
    const i = out.indexOf(key), j = i + dir;
    [out[i], out[j]] = [out[j], out[i]];
    return out;
}
/** What «Guardar» sends: null (= the default, "not configured") when the choice IS the default. */
export function displaySaveKeys(selected: string[], defaults: string[] = DEFAULT_DISPLAY_KEYS): string[] | null {
    const a = withName(selected), b = withName(defaults);
    return a.length === b.length && a.every((k, i) => k === b[i]) ? null : a;
}
/** The preview card's entries: the chosen keys with sample values (the name first). */
export function previewDisplayFields(selected: string[], available: AvailableField[], sample: (f: AvailableField) => string | null): DisplayField[] {
    const byKey = new Map(available.map((f) => [f.key, f]));
    return withName(selected).filter((k) => byKey.has(k)).map((k) => {
        const f = byKey.get(k)!;
        return { key: f.key, label: f.label, value: sample(f) };
    });
}
/** The card's heading (the name) and the other entries, in order. A server without fields → the plain name. */
export function splitPersonFields(person: { name?: string; fields?: DisplayField[] } | null | undefined): { name: DisplayField | null; rest: DisplayField[] } {
    const fields = Array.isArray(person?.fields) ? person!.fields! : [];
    const name = fields.find((f) => f.key === NAME_KEY) || (person?.name != null && person.name !== '' ? { key: NAME_KEY, label: '', value: String(person.name) } : null);
    return { name, rest: fields.filter((f) => f.key !== NAME_KEY) };
}
