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
 * appears there: the check on its way, a card (each scan has its own seq), a delivery's result while the
 * confirmation is ON (and again when that result starts holding the queue). A re-render of the same thing
 * (the waiting count, «Registrando…») keeps the key. null = nothing to bring into view: an empty slot, or the
 * confirmation OFF (2.15's immediate delivery, whose verdict was never scrolled to).
 */
export function decisionSlotKey(s: { confirmOn: boolean; card?: { seq: number } | null; checking?: boolean; outcome?: { seq?: number } | null; held?: boolean }): string | null {
    if (!s.confirmOn) return null;
    if (s.card) return `card:${s.card.seq}`;
    if (s.checking) return 'checking';
    if (s.outcome) return `result:${s.outcome.seq ?? ''}${s.held ? ':held' : ''}`;
    return null;
}

/** The few DOM members the reveal reads: an Element in the page, a stub in the tests. */
export type RevealEl = {
    getBoundingClientRect(): { top: number; bottom: number };
    parentElement: RevealEl | null;
    querySelector?: (selector: string) => { getBoundingClientRect(): { height: number } } | null;
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
 * the NAME, and the buttons (plus its 3 px borders) — the parts that never shrink. 0 = no card there.
 */
export function cardEssentials(el: RevealEl): number {
    const h = (selector: string) => { try { return el.querySelector?.(selector)?.getBoundingClientRect().height || 0; } catch { return 0; } };
    const parts = h('[data-confirm-meal]') + h('[data-confirm-head]') + h('[data-confirm-actions]');
    return parts > 0 ? Math.ceil(parts + 6) : 0;
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
    if (typeof el.scrollIntoView !== 'function') return false;
    try {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion(win) ? 'auto' : 'smooth' });
        return true;
    } catch { return false; }
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
