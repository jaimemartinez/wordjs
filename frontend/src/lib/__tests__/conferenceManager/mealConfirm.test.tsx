/**
 * conference-manager 2.16.0 — the kitchen CONFIRMS before a meal is recorded.
 *
 * The site owner: «apenas lee un código enseguida sale entregado, el usuario debería de poder validar si lo
 * entrega o no», and the card must show the meal and the person's data he chooses. Pinned here (node
 * environment, no DOM — the state machine both screens drive, the pure helpers, the server-rendered cards,
 * and the wiring lines on the source):
 *   - createConfirmFlow: a scan only CHECKS; «Entregar» delivers exactly the card's own scan; «Cancelar»
 *     never delivers and a re-scan opens the card again; nothing is ever delivered twice; a scan while a
 *     decision card is open is queued («Entrega») or ignored (phone) — never applied to the open card;
 *     informative cards never hold the line; a reset drops answers still on their way;
 *   - the keyboard of «Entrega»: Enter on an empty input = Entregar (never «autorizar»), Enter after a code =
 *     a new scan, Esc = Cancelar;
 *   - the per-device toggle (default ON, storage failures never break it);
 *   - the phone scanner pauses decoding while a card is open, and a closed card's badge must leave the
 *     view before it opens a card again (otherwise «Cancelar» would bring it straight back);
 *   - the card's states (ready / not_entitled / informative) and the configured person fields;
 *   - the «Qué se muestra al entregar» helpers (order, up/down, preview).
 * Review round 1 (each block names the finding it pins): Enter arming in «Entrega» (repeat, CR+LF burst,
 * the card just appeared), the queue waiting for a delivery's result to be seen, a name picked replacing the
 * open card, the tap arming of the cards, the phone's hold rules (never after a reset or a failure; a hint
 * after «Cancelar»), the card's layout on short phones, the not-entitled buttons, the label contrast, the
 * «ready» cue, «Restablecer» without saving, the name locked first, and the dialog's honest wording.
 * Live round (the end of this file): the decision under «Entrega»'s scan input is always brought into view,
 * and the counter tiles keep their words inside at every width. 2.17.0 live round (320×460): the status and the
 * name are the card's own header, never inside the part that scrolls; the meal band keeps to one line where only
 * the label gives way; «Autorizar» on a narrow or short phone; the rest ends on a whole line (detailsCut).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('react-dom', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-dom')>();
    return { ...actual, createPortal: (node: React.ReactNode) => node };
});

import { I18nProvider } from '@/contexts/I18nContext';
import {
    CheckingCard, ConfirmCard, ConfirmToggle, PersonFields, ReadCard, SCANNER_CSS, VerdictCard, confirmTone, createFeedback, displayLabelsOf, makeTx, scanPaused,
    CONFIRM_CSS, CONFIRM_MORE_STYLE, CONFIRM_SCROLL, MoreCue, detailsMore, detailsShown, detailsStyle,
    BUTTON_LABEL_FIT, BUTTON_SHRINKS, CONFIRM_MEAL_MORE_STYLE, AuthorizeLabel, CONFIRM_WHY_STYLE,
} from '../../../../../marketplace/plugins/conference-manager/client/admin/MealScanner';
import {
    CONFIRM_PREF_EVENT, CONFIRM_PREF_KEY, DEFAULT_DISPLAY_KEYS, ENTER_ARM_MS, ENTER_BURST_MS, TAP_ARM_MS, VERDICT_TAP_ARM_MS,
    canMoveDisplayKey, cardKeyAction, createConfirmFlow, displayLabel, displayOptions, displaySaveKeys, displayValue, holdAfterClose, isDecision,
    moveDisplayKey, previewDisplayFields, readConfirmPref, splitPersonFields, tapArmed, toggleDisplayKey, withName, writeConfirmPref,
    REVEAL_FIT_VAR, REVEAL_MARGIN_PX, cardEssentials, decisionSlotKey, fitHeight, prefersReducedMotion, revealSlot, visibleBand,
    DETAIL_ENTRY_SELECTOR, MORE_CUE_PX, detailsCut, detailsStale, measureDetails, valueLineBottoms,
    openMealCut, textLineBottoms, LABEL_MAX_LINES, labelTooLong,
    type CheckAnswer, type ScanBody,
} from '../../../../../marketplace/plugins/conference-manager/client/lib/mealConfirm';
import { COUNTER_TILE_MIN_REM, Counter, Counters, countersCss, countersFitRem } from '../../../../../marketplace/plugins/conference-manager/client/admin/Counters';
import { createReadRouter } from '../../../../../marketplace/plugins/conference-manager/client/lib/meals';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';

const es = makeTx((k: string) => translations.es[k] ?? k);
const flat = (html: string) => html.replace(/<!-- -->/g, '');
const render = (node: React.ReactNode) => flat(renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>));
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { vi.unstubAllGlobals(); });

// ── A fake server: the same rule as /meals/check + /meals/deliver ──────────────────────────────────────

/** Ana (ANAPEREZ23) is entitled, Beto (BETTYGMZ23) is not; a delivery is recorded once. */
function fakeServer() {
    const delivered = new Set<string>();
    const calls = { check: [] as any[], deliver: [] as any[] };
    const who = (b: ScanBody) => (b.code === 'ANAPEREZ23' || b.inscription_id === 1 ? 'ana' : b.code === 'BETTYGMZ23' || b.inscription_id === 2 ? 'beto' : null);
    const gates: (() => void)[] = [];
    let hold = false;
    const wait = () => (hold ? new Promise<void>((r) => gates.push(r)) : Promise.resolve());
    return {
        delivered, calls,
        /** Hold every answer until release() (a slow network). */
        hold() { hold = true; },
        release() { hold = false; while (gates.length) gates.shift()!(); },
        async check(serviceId: number, body: ScanBody): Promise<CheckAnswer> {
            calls.check.push({ serviceId, ...body });
            await wait();
            const p = who(body);
            if (!p) return { result: 'unknown' };
            if (delivered.has(`${serviceId}:${p}`)) return { result: 'already', verdict: { person: { id: p === 'ana' ? 1 : 2, name: p } } };
            return { result: p === 'ana' ? 'ready' : 'not_entitled', verdict: { person: { id: p === 'ana' ? 1 : 2, name: p }, source: 'none' } };
        },
        async deliver(serviceId: number, body: any) {
            calls.deliver.push({ serviceId, ...body });
            await wait();
            const p = who(body);
            if (!p) return { result: 'unknown' };
            if (delivered.has(`${serviceId}:${p}`)) return { result: 'already' };
            if (p === 'beto' && body.force !== true) return { result: 'not_entitled' };
            delivered.add(`${serviceId}:${p}`);
            return { result: 'delivered', method: body.force ? 'override' : 'scan' };
        },
    };
}
function makeFlow(server: ReturnType<typeof fakeServer>, opts: any = {}) {
    const results: any[] = [], closed: string[] = [], checked: string[] = [];
    const flow = createConfirmFlow({
        check: server.check, deliver: server.deliver, queue: opts.queue, settleMs: opts.settleMs, now: opts.now,
        onResult: (o, c) => results.push({ o, c }),
        onClose: (_c, why) => closed.push(why),
        onCheck: (c) => checked.push(c.result),
    });
    return { flow, results, closed, checked };
}

describe('createConfirmFlow: a scan only asks; «Entregar» records; «Cancelar» records nothing', () => {
    it('ready → «Entregar» delivers the card\'s own scan, once', async () => {
        const s = fakeServer();
        const { flow, results, closed } = makeFlow(s);
        expect(flow.scan(7, { code: 'ANAPEREZ23' })).toBe('checking');
        expect(flow.state().checking).toBe(true);
        await tick();
        expect(flow.state().card).toMatchObject({ result: 'ready', serviceId: 7, body: { code: 'ANAPEREZ23' }, code: 'ANAPEREZ23' });
        expect(s.calls.deliver).toHaveLength(0);           // the check recorded nothing
        expect(flow.isOpen()).toBe(true);
        expect(flow.deliver()).toBe(true);
        expect(flow.deliver()).toBe(false);                 // a double press never delivers twice
        expect(flow.state().delivering).toBe(true);
        await tick();
        expect(s.calls.deliver).toEqual([{ serviceId: 7, code: 'ANAPEREZ23' }]);
        expect(results.map((r) => r.o.result)).toEqual(['delivered']);
        expect(flow.state().card).toBeNull();
        expect(closed).toEqual(['deliver']);
    });

    it('«Cancelar» never calls deliver; the person stays pending and a later scan shows «ready» again', async () => {
        const s = fakeServer();
        const { flow, closed } = makeFlow(s);
        flow.scan(7, { code: 'ANAPEREZ23' });
        await tick();
        expect(flow.cancel()).toBe(true);
        expect(flow.state().card).toBeNull();
        expect(closed).toEqual(['cancel']);
        expect(s.calls.deliver).toHaveLength(0);
        expect(s.delivered.size).toBe(0);
        // Later, the same badge again: the card again, still «ready».
        expect(flow.scan(7, { code: 'ANAPEREZ23' })).toBe('checking');
        await tick();
        expect(flow.state().card?.result).toBe('ready');
        expect(s.calls.check).toHaveLength(2);
        expect(s.calls.deliver).toHaveLength(0);
    });

    it('not entitled: only «Entregar sin derecho (autorizar)» delivers, with force and the note', async () => {
        const s = fakeServer();
        const { flow, results } = makeFlow(s);
        flow.scan(7, { code: 'BETTYGMZ23' });
        await tick();
        expect(flow.state().card?.result).toBe('not_entitled');
        expect(flow.deliver()).toBe(false);                 // plain «Entregar» does not exist for it
        expect(s.calls.deliver).toHaveLength(0);
        expect(flow.authorize('Autorizado al confirmar la entrega')).toBe(true);
        await tick();
        expect(s.calls.deliver).toEqual([{ serviceId: 7, code: 'BETTYGMZ23', force: true, note: 'Autorizado al confirmar la entrega' }]);
        expect(results[0].o).toMatchObject({ result: 'delivered', method: 'override' });
    });

    it('authorize() never forces a ready card; cancel() / close() only act on their kind of card', async () => {
        const s = fakeServer();
        const { flow } = makeFlow(s);
        flow.scan(7, { code: 'ANAPEREZ23' });
        await tick();
        expect(flow.authorize('x')).toBe(false);
        expect(flow.close()).toBe(false);                   // a decision is cancelled, not closed
        flow.cancel();
        flow.scan(7, { code: 'NOPE000000' });
        await tick();
        expect(flow.state().card?.result).toBe('unknown');
        expect(flow.cancel()).toBe(false);
        expect(flow.deliver()).toBe(false);
        expect(flow.close()).toBe(true);
        expect(s.calls.deliver).toHaveLength(0);
    });

    it('«Entrega» (queue): a scan while a card waits is QUEUED, never applied to the open card', async () => {
        const s = fakeServer();
        const { flow, results, checked } = makeFlow(s, { queue: true });
        flow.scan(7, { code: 'BETTYGMZ23' });
        await tick();
        expect(flow.state().card?.result).toBe('not_entitled');
        // A USB wedge sends the next badge while Beto's card is open.
        expect(flow.scan(7, { code: 'ANAPEREZ23' })).toBe('queued');
        expect(flow.state().waiting).toBe(1);
        expect(flow.state().card?.body).toEqual({ code: 'BETTYGMZ23' }); // the card on screen is still Beto's
        expect(s.calls.check).toHaveLength(1);
        expect(s.calls.deliver).toHaveLength(0);
        // «Cancelar» Beto: nothing recorded, Ana's card comes next.
        flow.cancel();
        await tick();
        expect(flow.state().card).toMatchObject({ result: 'ready', body: { code: 'ANAPEREZ23' } });
        expect(flow.state().waiting).toBe(0);
        flow.deliver();
        await tick();
        expect(s.calls.deliver).toEqual([{ serviceId: 7, code: 'ANAPEREZ23' }]);
        expect(results.map((r) => r.c.body.code)).toEqual(['ANAPEREZ23']);
        expect(checked).toEqual(['not_entitled', 'ready']);
    });

    it('«Entregar» on the open card delivers THAT person even when another scan is queued behind it', async () => {
        const s = fakeServer();
        const { flow } = makeFlow(s, { queue: true, settleMs: 0 });
        flow.scan(7, { code: 'ANAPEREZ23' });
        await tick();
        flow.scan(7, { code: 'BETTYGMZ23' });
        flow.deliver();
        await tick(); await tick();
        expect(s.calls.deliver).toEqual([{ serviceId: 7, code: 'ANAPEREZ23' }]);
        expect(flow.state().card?.body).toEqual({ code: 'BETTYGMZ23' }); // Beto's own card is next
    });

    it('phone (no queue): a scan while a card is open — or its check runs — is ignored', async () => {
        const s = fakeServer();
        s.hold();
        const { flow } = makeFlow(s);
        expect(flow.scan(7, { code: 'ANAPEREZ23' })).toBe('checking');
        expect(flow.scan(7, { code: 'ANAPEREZ23' })).toBe('ignored');   // no second check in flight
        s.release();
        await tick();
        expect(flow.scan(7, { code: 'BETTYGMZ23' })).toBe('ignored');
        expect(s.calls.check).toHaveLength(1);
        expect(flow.state().card?.body).toEqual({ code: 'ANAPEREZ23' });
    });

    it('an informative card never holds the line: the next scan replaces it, queued scans run at once', async () => {
        const s = fakeServer();
        const { flow, closed } = makeFlow(s, { queue: true });
        flow.scan(7, { code: 'NOPE000000' });
        await tick();
        expect(isDecision(flow.state().card?.result)).toBe(false);
        expect(flow.scan(7, { code: 'ANAPEREZ23' })).toBe('checking');
        await tick();
        expect(flow.state().card?.result).toBe('ready');
        expect(closed).toEqual(['replaced']);
    });

    it('a reset (another service / toggle off) drops the card, the queue and any answer still on its way', async () => {
        const s = fakeServer();
        s.hold();
        const { flow, checked, results } = makeFlow(s, { queue: true });
        flow.scan(7, { code: 'ANAPEREZ23' });
        flow.scan(7, { code: 'BETTYGMZ23' });
        flow.reset();
        s.release();
        await tick();
        expect(flow.state()).toEqual({ card: null, waiting: 0, checking: false, delivering: false, held: false, heldAt: null, settling: false });
        expect(checked).toEqual([]);
        // …also a delivery answer: nothing is shown for the old service.
        flow.scan(8, { code: 'ANAPEREZ23' });
        await tick();
        s.hold();
        flow.deliver();
        flow.reset();
        s.release();
        await tick();
        expect(results).toEqual([]);
    });

    it('«Servicio no encontrado» drops the scans queued for that service; a failing check is an error card', async () => {
        const s = fakeServer();
        const calls: any[] = [];
        const flow = createConfirmFlow({
            queue: true,
            check: async (sid, body) => { calls.push(body); return sid === 9 ? { result: 'no_service' } : s.check(sid, body); },
            deliver: s.deliver,
        });
        flow.scan(7, { code: 'BETTYGMZ23' });
        await tick();
        flow.scan(9, { code: 'ANAPEREZ23' });
        flow.scan(9, { code: 'ANAPEREZ24' });
        flow.cancel();
        await tick();
        expect(flow.state().card?.result).toBe('no_service');
        expect(flow.state().waiting).toBe(0);
        expect(calls).toHaveLength(2);
        const broken = createConfirmFlow({ check: async () => { throw new Error('boom'); }, deliver: s.deliver });
        broken.scan(7, { code: 'ANAPEREZ23' });
        await tick();
        expect(broken.state().card).toMatchObject({ result: 'error', message: 'boom' });
    });

    it('nothing is scanned without a service; a disposed flow does nothing', async () => {
        const s = fakeServer();
        const changes: any[] = [];
        const flow = createConfirmFlow({ check: s.check, deliver: s.deliver, onChange: (st) => changes.push(st) });
        expect(flow.scan(0, { code: 'ANAPEREZ23' })).toBe('ignored');
        flow.scan(7, { code: 'ANAPEREZ23' });
        flow.dispose();
        await tick();
        const n = changes.length;
        expect(flow.scan(7, { code: 'ANAPEREZ23' })).toBe('ignored');
        expect(changes.length).toBe(n);
    });
});

// ── Keyboard («Entrega») ─────────────────────────────────────────────────────────────────────────────

describe('cardKeyAction: Enter = Entregar, Esc = Cancelar — and a wedge scan never confirms', () => {
    it('Enter on an empty input confirms a ready card and closes an informative one', () => {
        expect(cardKeyAction('Enter', 'ready', '')).toBe('deliver');
        expect(cardKeyAction('Enter', 'ready', '   ')).toBe('deliver');
        for (const r of ['already', 'cancelled', 'unknown', 'other_conference', 'offline', 'no_service', 'error'] as const) expect(cardKeyAction('Enter', r, '')).toBe('close');
    });
    it('Enter after a code (what a USB wedge sends) is a NEW scan, never «Entregar» for the open card', () => {
        expect(cardKeyAction('Enter', 'ready', 'ANAPEREZ23')).toBeNull();
        expect(cardKeyAction('Enter', 'ready', ']C0ANAPEREZ23\r')).toBeNull();
        expect(cardKeyAction('Enter', 'ready', '---')).toBeNull();       // anything typed: never a confirmation
    });
    it('Enter never authorises a delivery without entitlement (that takes the button)', () => {
        expect(cardKeyAction('Enter', 'not_entitled', '')).toBeNull();
    });
    it('Escape = Cancelar on a decision, Cerrar on information; nothing without a card', () => {
        expect(cardKeyAction('Escape', 'ready', '')).toBe('cancel');
        expect(cardKeyAction('Escape', 'not_entitled', 'ABC')).toBe('cancel');
        expect(cardKeyAction('Escape', 'unknown', '')).toBe('close');
        expect(cardKeyAction('Escape', null, '')).toBeNull();
        expect(cardKeyAction('Enter', null, '')).toBeNull();
        expect(cardKeyAction('Tab', 'ready', '')).toBeNull();
    });
});

// ── The per-device toggle ────────────────────────────────────────────────────────────────────────────

describe('«Confirmar antes de entregar»: per device, default ON, storage failures never break it', () => {
    const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, v); }, m }; };
    it('default ON; remembered OFF / ON', () => {
        const st = memory();
        expect(readConfirmPref(st)).toBe(true);
        writeConfirmPref(false, st);
        expect(st.m.get(CONFIRM_PREF_KEY)).toBe('0');
        expect(readConfirmPref(st)).toBe(false);
        writeConfirmPref(true, st);
        expect(readConfirmPref(st)).toBe(true);
        expect(CONFIRM_PREF_KEY).toBe('conference-manager:meals.confirm');
    });
    it('blocked / missing storage: reads ON, writes never throw', () => {
        const blocked = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceeded'); } };
        expect(readConfirmPref(blocked)).toBe(true);
        expect(() => writeConfirmPref(false, blocked)).not.toThrow();
        expect(readConfirmPref(null)).toBe(true);
        expect(() => writeConfirmPref(false, null)).not.toThrow();
        vi.stubGlobal('window', { get localStorage() { throw new Error('denied'); } });
        expect(readConfirmPref()).toBe(true);
    });
    it('a write tells the other screen (the scanner and «Entrega» share it), with the value', () => {
        const events: any[] = [];
        vi.stubGlobal('window', { dispatchEvent: (e: any) => events.push(e), localStorage: memory() });
        vi.stubGlobal('CustomEvent', class { type: string; detail: any; constructor(t: string, o: any) { this.type = t; this.detail = o?.detail; } });
        writeConfirmPref(false);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: CONFIRM_PREF_EVENT, detail: false });
    });
});

// ── Phone scanner: pause and the gate ────────────────────────────────────────────────────────────────

describe('phone scanner: decoding pauses while a card is open; a closed card\'s badge must leave the view', () => {
    it('scanPaused: a card open or its request running pauses the loop (as a sheet / a request did)', async () => {
        const s = fakeServer();
        s.hold();
        const { flow } = makeFlow(s);
        expect(scanPaused({ flow })).toBe(false);
        expect(scanPaused({ inFlight: true, flow })).toBe(true);
        expect(scanPaused({ sheet: 'code', flow })).toBe(true);
        expect(scanPaused({ armed: true, flow })).toBe(true);
        flow.scan(7, { code: 'ANAPEREZ23' });
        expect(scanPaused({ flow })).toBe(true);           // checking
        s.release();
        await tick();
        expect(scanPaused({ flow })).toBe(true);           // card open
        flow.cancel();
        expect(scanPaused({ flow })).toBe(false);          // resumed after the decision
    });
    it('router.hold: after «Cancelar» the badge still in view does not reopen the card; out of view for 3 s it does', () => {
        const r = createReadRouter(3000);
        expect(r.route('ANAPEREZ23', 'code_128', false, 0)).toEqual({ action: 'submit', code: 'ANAPEREZ23' });
        // The card is open for 10 s (the loop is paused: no sightings), then «Cancelar».
        r.hold('ANAPEREZ23', 10_000);
        expect(r.route('ANAPEREZ23', 'code_128', false, 10_200)).toBeNull();   // still under the camera
        expect(r.route('ANAPEREZ23', 'code_128', false, 12_000)).toBeNull();
        expect(r.route('ANAPEREZ23', 'code_128', false, 15_100)).toEqual({ action: 'submit', code: 'ANAPEREZ23' }); // left the view > 3 s
        // Without the hold, the same badge would reopen the card at once after a long decision.
        const plain = createReadRouter(3000);
        plain.route('ANAPEREZ23', 'code_128', false, 0);
        expect(plain.route('ANAPEREZ23', 'code_128', false, 10_200)).toEqual({ action: 'submit', code: 'ANAPEREZ23' });
    });
});

// ── What the cards show ──────────────────────────────────────────────────────────────────────────────

const SERVICE = { id: 7, service_date: '2027-03-01', meal: 'almuerzo', label: 'Campestre', start_time: null, end_time: null };
// The server always sends the name first (see the backend test «the name is always on the card, first»).
const FIELDS = [
    { key: '@name', label: 'Nombre completo', value: 'Ana Pérez' },
    { key: 'dieta', label: 'Dieta', value: 'Vegetariana' },
    { key: '@location', label: 'Localidad', value: null },
    { key: '@payment_status', label: 'Estado de pago', value: 'paid' },
    { key: '@reg_code', label: 'Código de inscripción', value: null, hidden: true },
];
const card = (result: string, extra: any = {}) => ({
    seq: 1, serviceId: 7, body: { code: 'ANAPEREZ23' }, result, code: 'ANAPEREZ23',
    verdict: { service: SERVICE, person: { id: 1, name: 'Ana Pérez', fields: FIELDS }, source: 'none', ...extra },
});

describe('ConfirmCard: the meal, the configured data, the status and the decision', () => {
    it('ready: the meal prominent, the fields in order, «Entregar» + «Cancelar»', () => {
        const html = render(<ConfirmCard card={card('ready')} language="es" />);
        expect(html).toContain('data-confirm-card="ready"');
        // The meal, then the service's label (its own part: on a short phone only the label gives way).
        expect(html).toMatch(/data-confirm-meal=""[\s\S]*<span data-confirm-meal-meal="">Almuerzo<\/span><span data-confirm-meal-label=""> — Campestre<\/span>/);
        expect(html).toContain('01/03');
        expect(html).toContain('Puede recibir esta comida');
        const order = ['Ana Pérez', 'Vegetariana', 'Sin localidad', 'Pagado', '(oculto)'].map((t) => html.indexOf(t));
        expect(order.every((i) => i > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(html).toContain('data-confirm-deliver=""');
        expect(html).toContain('data-confirm-cancel=""');
        expect(html).not.toContain('data-confirm-authorize');
        expect(html).not.toContain('data-confirm-close');
        expect(html).toMatch(/data-confirm-cancel=""[^>]*>Cancelar</);
        expect(html).toMatch(/data-confirm-deliver=""[^>]*>.*Entregar</);
        // The decision is at the bottom: «Cancelar» then the primary «Entregar», after the data.
        expect(html.indexOf('data-confirm-actions')).toBeGreaterThan(html.indexOf('Pagado'));
        expect(html.indexOf('data-confirm-deliver')).toBeGreaterThan(html.indexOf('data-confirm-cancel'));
        expect(html).toContain('role="alertdialog"');
    });
    it('not entitled: «Entregar sin derecho (autorizar)» + «Cancelar», and why', () => {
        const html = render(<ConfirmCard card={card('not_entitled', { source: 'exclude' })} language="es" />);
        expect(html).toContain('Sin derecho a esta comida');
        expect(html).toContain('Se la quitaron a esta persona');
        expect(html).toContain('data-confirm-authorize=""');
        expect(html).toContain('Entregar sin derecho (autorizar)');
        expect(html).toContain('data-confirm-cancel=""');
        expect(html).not.toContain('data-confirm-deliver');
        expect(render(<ConfirmCard card={card('not_entitled', { source: 'none' })} />)).toContain('No está en el plan de su localidad');
    });
    it('informative states: the facts + «Cerrar», no decision', () => {
        const already = render(<ConfirmCard card={card('already', { delivered_at: '2027-03-01 17:31:00', delivered_by: 'cocina' })} />);
        expect(already).toContain('Ya recibió');
        expect(already).toContain('registró cocina');
        for (const [r, text] of [['already', 'Ya recibió'], ['cancelled', 'Inscripción cancelada'], ['unknown', 'Código no encontrado'], ['other_conference', 'Ese código es de otra conferencia'], ['offline', 'Sin conexión'], ['no_service', 'Servicio no encontrado']] as const) {
            const html = render(<ConfirmCard card={card(r)} />);
            expect(html, r).toContain(text);
            expect(html, r).toContain('data-confirm-close=""');
            expect(html, r).toContain('Cerrar');
            expect(html, r).not.toContain('data-confirm-deliver');
            expect(html, r).not.toContain('data-confirm-cancel');
            expect(html, r).not.toContain('data-confirm-authorize');
            expect(html, r).toContain('role="status"');
        }
        const unknown = render(<ConfirmCard card={{ seq: 2, serviceId: 7, body: { code: 'zz' }, result: 'unknown', code: 'ZZZZ234567', verdict: { service: SERVICE } }} />);
        expect(unknown).toContain('ZZZZ234567');
        expect(unknown).toContain('Almuerzo');
    });
    it('while recording: «Registrando…» and no second press; queued scans and the keys are announced', () => {
        const html = render(<ConfirmCard card={card('ready')} delivering waiting={2} keyHints />);
        expect(html).toContain('Registrando…');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-confirm-deliver/);
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-confirm-cancel/);
        expect(html).toContain('2 códigos en espera');
        expect(html).toContain('Enter = Entregar · Esc = Cancelar');
        expect(render(<ConfirmCard card={card('ready')} waiting={1} />)).toContain('1 código en espera');
        expect(render(<ConfirmCard card={card('not_entitled')} keyHints />)).toContain('Enter no autoriza');
        expect(render(<ConfirmCard card={null} />)).toBe('');
        expect(render(<CheckingCard />)).toContain('Comprobando…');
    });
    it('the colours follow the result', () => {
        expect(confirmTone('ready')).toBe('ready');
        expect(confirmTone('not_entitled')).toBe('not_entitled');
        expect(confirmTone('already')).toBe('bad');
        expect(confirmTone('unknown')).toBe('muted');
    });
});

describe('PersonFields / VerdictCard: the configured data, also on the «Entregado» card', () => {
    it('PersonFields: the name as a heading, the rest «LABEL value», translated built-ins', () => {
        const html = render(<PersonFields fields={FIELDS} />);
        expect(html).toMatch(/data-field="@name"[^>]*font-size:22px[^>]*>Ana Pérez</);
        expect(html).toContain('Dieta');                    // a form field keeps the admin's label
        expect(html).toContain('Sin localidad');
        expect(html).toContain('Pagado');
        expect(html).toContain('(oculto)');
    });
    it('VerdictCard shows the configured fields when the server sent them, the 2.15 line otherwise', () => {
        const withFields = render(<VerdictCard outcome={{ result: 'delivered', seq: 1, at: 0, verdict: { delivery_id: 3, person: { id: 1, name: 'Ana Pérez', location: 'Bogotá', location_id: 2, family_group: 'Pérez', reg_code: null, fields: FIELDS } } }} />);
        expect(withFields).toContain('data-person-fields=""');
        expect(withFields).toContain('Vegetariana');
        expect(withFields).not.toContain('Grupo familiar');
        const legacy = render(<VerdictCard outcome={{ result: 'delivered', seq: 1, at: 0, verdict: { delivery_id: 3, person: { id: 1, name: 'Ana Pérez', location: 'Bogotá', location_id: 2, family_group: 'Pérez', reg_code: null } } }} />);
        expect(legacy).not.toContain('data-person-fields');
        expect(legacy).toContain('Ana Pérez');
        expect(legacy).toContain('Bogotá');
        expect(legacy).toContain('Grupo familiar: Pérez');
    });
    it('the toggle renders its state', () => {
        expect(render(<ConfirmToggle on onChange={() => { }} />)).toMatch(/data-confirm-toggle="on"[\s\S]*checked=""/);
        const off = render(<ConfirmToggle on={false} onChange={() => { }} />);
        expect(off).toContain('data-confirm-toggle="off"');
        expect(off).not.toContain('checked=""');
        expect(off).toContain('Confirmar antes de entregar');
    });
});

// ── «Qué se muestra al entregar» ─────────────────────────────────────────────────────────────────────

describe('display-field helpers: labels, values, order, preview', () => {
    const L = displayLabelsOf(es);
    const AVAILABLE = [
        { key: '@name', label: 'Nombre completo', builtin: true }, { key: '@location', label: 'Localidad', builtin: true },
        { key: '@reg_code', label: 'Código', builtin: true }, { key: 'dieta', label: 'Dieta', builtin: false, type: 'select' },
        { key: 'talla', label: 'Talla', builtin: false, type: 'text' },
    ];
    it('labels: built-ins translated, form fields with the admin\'s label', () => {
        expect(displayLabel({ key: '@payment_status', label: 'x' }, L)).toBe('Estado de pago');
        expect(displayLabel({ key: 'dieta', label: 'Dieta' }, L)).toBe('Dieta');
        const en = displayLabelsOf(makeTx((k: string) => translations.en[k] ?? k));
        expect(displayLabel({ key: '@name', label: 'Nombre completo' }, en)).toBe('Full name');
        expect(displayValue({ key: '@payment_status', label: '', value: 'unpaid' }, en)).toBe('Unpaid');
    });
    it('values: empty, hidden, no location / room, payment status', () => {
        expect(displayValue({ key: 'dieta', label: 'Dieta', value: '  ' }, L)).toBe('—');
        expect(displayValue({ key: '@room', label: '', value: null }, L)).toBe('Sin habitación');
        expect(displayValue({ key: '@location', label: '', value: '' }, L)).toBe('Sin localidad');
        expect(displayValue({ key: '@reg_code', label: '', value: null, hidden: true }, L)).toBe('(oculto)');
        expect(displayValue({ key: '@payment_status', label: '', value: 'partial' }, L)).toBe('Parcial');
        expect(displayValue({ key: 'talla', label: '', value: 'M' }, L)).toBe('M');
    });
    it('the list: the name first and LOCKED, the other chosen keys in their order, then the rest as offered', () => {
        const opts = displayOptions(AVAILABLE, ['dieta', '@name']);
        expect(opts.map((o) => [o.key, o.on, o.index, o.locked])).toEqual([['@name', true, 0, true], ['dieta', true, 1, false], ['@location', false, -1, false], ['@reg_code', false, -1, false], ['talla', false, -1, false]]);
        expect(displayOptions(AVAILABLE, ['gone', '@name']).filter((o) => o.on).map((o) => o.key)).toEqual(['@name']);
        // A list without the name (an older setting) still shows it, ticked and locked.
        expect(displayOptions(AVAILABLE, ['talla']).filter((o) => o.on).map((o) => [o.key, o.locked])).toEqual([['@name', true], ['talla', false]]);
    });
    it('tick / untick; up / down (touch buttons), stopping at the ends and below the locked name', () => {
        expect(toggleDisplayKey(['@name'], 'dieta')).toEqual(['@name', 'dieta']);
        expect(toggleDisplayKey(['@name', 'dieta'], 'dieta')).toEqual(['@name']);
        expect(moveDisplayKey(['@name', 'a', 'b', 'c'], 'c', -1)).toEqual(['@name', 'a', 'c', 'b']);
        expect(moveDisplayKey(['@name', 'a', 'b', 'c'], 'a', 1)).toEqual(['@name', 'b', 'a', 'c']);
        expect(moveDisplayKey(['@name', 'a', 'b', 'c'], 'c', 1)).toEqual(['@name', 'a', 'b', 'c']);
        expect(moveDisplayKey(['@name', 'a', 'b'], 'zz', 1)).toEqual(['@name', 'a', 'b']);
    });
    it('the preview: the name first, then the chosen keys in order, with sample values', () => {
        const prev = previewDisplayFields(['talla', '@name'], AVAILABLE, (f) => (f.key === '@name' ? 'María Pérez' : 'Ejemplo'));
        expect(prev).toEqual([{ key: '@name', label: 'Nombre completo', value: 'María Pérez' }, { key: 'talla', label: 'Talla', value: 'Ejemplo' }]);
        const html = render(<ConfirmCard card={{ seq: 0, serviceId: 7, body: {}, result: 'ready', verdict: { service: SERVICE, person: { id: 0, name: '', fields: prev } } }} />);
        expect(html.indexOf('María Pérez')).toBeLessThan(html.indexOf('Talla'));
    });
    it('every new message exists in es, en and pt', () => {
        const src = ['MealScanner.tsx', 'MealsPage.tsx'].map((f) => fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin', f), 'utf8')).join('\n');
        const keys = new Set([...src.matchAll(/tx\('(meals\.(?:confirm|display)[^']*)'/g)].map((m) => m[1]));
        for (const k of ['@name', '@location', '@reg_code', '@payment_status', '@room']) keys.add(`meals.display.${k}`);
        keys.add('meals.confirm.waiting.one');
        keys.add('meals.scanner.read.held');
        expect(keys.size).toBeGreaterThan(30);
        for (const lang of ['es', 'en', 'pt'] as const) for (const k of keys) expect(translations[lang][k], `${lang} ${k}`).toBeTruthy();
        expect(translations.es['meals.confirm.deliver']).toBe('Entregar');
        expect(translations.es['meals.confirm.cancel']).toBe('Cancelar');
        expect(translations.en['meals.confirm.deliver']).toBe('Deliver');
        expect(translations.en['meals.confirm.cancel']).toBe('Cancel');
        expect(translations.pt['meals.confirm.deliver']).toBe('Entregar');
        expect(translations.pt['meals.confirm.cancel']).toBe('Cancelar');
    });
});

// ── Review round 1 ───────────────────────────────────────────────────────────────────────────────────

/** A line of people who are all entitled; `offline` codes fail to deliver (the network dropped). */
function lineServer(offline: string[] = []) {
    const delivered: string[] = [];
    const calls = { check: [] as ScanBody[], deliver: [] as any[] };
    return {
        delivered, calls,
        async check(_sid: number, b: ScanBody): Promise<CheckAnswer> {
            calls.check.push(b);
            return delivered.includes(String(b.code)) ? { result: 'already' } : { result: 'ready', verdict: { person: { id: 1, name: b.code } } };
        },
        async deliver(_sid: number, b: any) {
            calls.deliver.push(b);
            if (offline.includes(String(b.code))) return { result: 'offline' };
            if (delivered.includes(String(b.code))) return { result: 'already' };
            delivered.push(String(b.code));
            return { result: 'delivered' };
        },
    };
}

/**
 * «Entrega»'s key path — DeliveryTab's onScanKey + submit (pinned on the source below) — on the real flow
 * and the real cardKeyAction, with a hand-driven clock: a USB wedge types a code and Enter (and, with a
 * CR+LF suffix, a second Enter a few ms later).
 */
function deliveryDesk(server: any, flowOpts: any = {}) {
    let t = 0;
    const flow = createConfirmFlow({ queue: true, settleMs: 0, check: server.check, deliver: server.deliver, now: () => t, ...flowOpts });
    let input = '';
    let lastKeyAt: number | null = null;
    const keyTarget = (st: any) => (st.card ? st.card.result : st.held ? 'held' : null);
    const key = (k: string, repeat = false) => {
        const prev = lastKeyAt;
        lastKeyAt = t;
        if (k !== 'Enter') { input += k; return; }
        const raw = input;
        input = '';
        const st = flow.state();
        const a = cardKeyAction('Enter', keyTarget(st), raw, { now: t, lastKeyAt: prev, repeat, shownAt: st.card ? st.card.shownAt : st.heldAt });
        if (a === 'deliver') { flow.deliver(); return; }
        if (a === 'close') { flow.close(); return; }
        if (raw) flow.scan(7, { code: raw });
    };
    /** The wedge: one character every 3 ms, then Enter (+ a second Enter 5 ms later with CR+LF). */
    const wedge = (code: string, crlf = false) => {
        for (const c of code) { key(c); t += 3; }
        key('Enter');
        if (crlf) { t += 5; key('Enter'); }
    };
    return { flow, key, wedge, advance: (ms: number) => { t += ms; }, now: () => t };
}

describe('«Entrega» keyboard: Enter decides once, on a card that has been seen (correctness F1, UX F2)', () => {
    const T = 10_000;
    it('a held-down Enter, the second Enter of a burst and an Enter right after the card appeared do nothing', () => {
        const ok = { now: T, shownAt: T - ENTER_ARM_MS, lastKeyAt: T - ENTER_BURST_MS };
        expect(cardKeyAction('Enter', 'ready', '', ok)).toBe('deliver');
        expect(cardKeyAction('Enter', 'ready', '', { ...ok, repeat: true })).toBeNull();
        expect(cardKeyAction('Enter', 'ready', '', { ...ok, lastKeyAt: T - 5 })).toBeNull();       // CR+LF: 5 ms after the first Enter
        expect(cardKeyAction('Enter', 'ready', '', { ...ok, shownAt: T - 100 })).toBeNull();      // the card has just appeared
        expect(cardKeyAction('Enter', 'unknown', '', { ...ok, shownAt: T - 100 })).toBeNull();
        expect(cardKeyAction('Enter', 'held', '', ok)).toBe('close');
        expect(cardKeyAction('Enter', 'held', '', { ...ok, shownAt: T - 100 })).toBeNull();      // a failed result just appeared
        expect(cardKeyAction('Escape', 'ready', '', { now: T, repeat: true })).toBeNull();       // a held Esc
        expect(cardKeyAction('Escape', 'ready', '', { now: T, shownAt: T })).toBe('cancel');     // «Cancelar» is never delayed
        expect(cardKeyAction('Escape', 'held', '', { now: T })).toBe('close');
        expect(ENTER_ARM_MS).toBeGreaterThanOrEqual(400);
        expect(ENTER_BURST_MS).toBeGreaterThanOrEqual(150);
    });
    it('the reviewer\'s CR+LF case: a wedge scanning B while A waits queues B and the trailing Enter does NOT deliver A', async () => {
        const srv = lineServer();
        const d = deliveryDesk(srv);
        d.wedge('ANAPEREZ23');
        await tick();
        expect(d.flow.state().card?.body).toEqual({ code: 'ANAPEREZ23' });
        d.advance(5000);                                      // A walks away undecided
        d.wedge('BETOGOMEZ4', true);
        await tick();
        expect(srv.calls.deliver).toEqual([]);                // nothing delivered without a decision
        expect(d.flow.state().card?.body).toEqual({ code: 'ANAPEREZ23' });
        expect(d.flow.state().waiting).toBe(1);
        // A deliberate Enter later still works.
        d.advance(1000);
        d.key('Enter');
        await tick(); await tick();
        expect(srv.calls.deliver).toEqual([{ code: 'ANAPEREZ23' }]);
    });
    it('holding Enter never walks down the queue: the next card is seen before Enter can confirm it', async () => {
        const srv = lineServer();
        const d = deliveryDesk(srv);
        d.wedge('ANAPEREZ23');
        await tick();
        for (const c of ['BETOGOMEZ4', 'CARLARUIZ5', 'DANISOTO66']) d.wedge(c);
        d.advance(2000);
        d.key('Enter');                                       // the operator confirms A…
        for (let i = 0; i < 20; i++) { await tick(); d.advance(30); d.key('Enter', true); }   // …and the key repeats
        await tick();
        expect(srv.delivered).toEqual(['ANAPEREZ23']);
        expect(d.flow.state().card?.body).toEqual({ code: 'BETOGOMEZ4' });
        // A double press (two separate presses 150 ms apart) on the next card: one decision at most.
        d.advance(1000);
        d.key('Enter');
        d.advance(150);
        d.key('Enter');
        for (let i = 0; i < 4; i++) await tick();
        expect(srv.delivered).toEqual(['ANAPEREZ23', 'BETOGOMEZ4']);
        expect(d.flow.state().card?.body).toEqual({ code: 'CARLARUIZ5' });
    });
    it('every card is stamped with when it appeared (the flow\'s clock)', async () => {
        let t = 42;
        const flow = createConfirmFlow({ check: lineServer().check, deliver: async () => ({ result: 'delivered' }), now: () => t });
        flow.scan(7, { code: 'ANAPEREZ23' });
        t = 99;
        await tick();
        expect(flow.state().card?.shownAt).toBe(99);
    });
});

describe('«Entrega»: the queue waits until the delivery\'s result has been seen (UX F1)', () => {
    afterEach(() => { vi.useRealTimers(); });
    it('a delivery that was NOT recorded holds the queue until it is acknowledged — the next card never hides it', async () => {
        const srv = lineServer(['ANAPEREZ23']);
        let t = 1000;
        const results: any[] = [];
        const flow = createConfirmFlow({ queue: true, check: srv.check, deliver: srv.deliver, now: () => t, onResult: (o) => results.push(o.result) });
        flow.scan(7, { code: 'ANAPEREZ23' });
        await tick();
        expect(flow.scan(7, { code: 'BETOGOMEZ4' })).toBe('queued');
        t = 2000;
        expect(flow.deliver()).toBe(true);
        await tick(); await tick();
        expect(results).toEqual(['offline']);
        expect(flow.state()).toMatchObject({ card: null, held: true, heldAt: 2000, waiting: 1, checking: false });
        expect(srv.calls.check.map((b) => b.code)).toEqual(['ANAPEREZ23']);       // B was NOT checked
        expect(flow.scan(7, { code: 'CARLARUIZ5' })).toBe('queued');              // a new scan waits too
        expect(flow.cancel()).toBe(false);
        expect(flow.close()).toBe(true);                                           // Enter / Esc / a click
        await tick();
        expect(flow.state()).toMatchObject({ held: false, heldAt: null, waiting: 1 });
        expect(flow.state().card?.body).toEqual({ code: 'BETOGOMEZ4' });
    });
    it('«Entregado» stays settleMs (default 1.2 s) before the next queued card', async () => {
        vi.useFakeTimers();
        const flush = () => vi.advanceTimersByTimeAsync(0);
        const srv = lineServer();
        const flow = createConfirmFlow({ queue: true, check: srv.check, deliver: srv.deliver });
        flow.scan(7, { code: 'ANAPEREZ23' });
        await flush();
        flow.scan(7, { code: 'BETOGOMEZ4' });
        flow.deliver();
        await flush();
        expect(srv.delivered).toEqual(['ANAPEREZ23']);
        expect(flow.state()).toMatchObject({ card: null, settling: true, held: false, waiting: 1 });
        expect(flow.scan(7, { code: 'CARLARUIZ5' })).toBe('queued');
        await vi.advanceTimersByTimeAsync(1199);
        expect(srv.calls.check.map((b) => b.code)).toEqual(['ANAPEREZ23']);
        await vi.advanceTimersByTimeAsync(1);
        await flush();
        expect(flow.state().settling).toBe(false);
        expect(flow.state().card?.body).toEqual({ code: 'BETOGOMEZ4' });
        // A reset (another service) drops a settle still running.
        flow.deliver();
        await flush();
        expect(flow.state().settling).toBe(true);
        flow.reset();
        expect(flow.state()).toMatchObject({ settling: false, held: false, waiting: 0 });
        await vi.advanceTimersByTimeAsync(2000);
        expect(flow.state().card).toBeNull();
    });
    it('the phone (no queue) never holds: after a failed delivery the scanner is free at once', async () => {
        const srv = lineServer(['ANAPEREZ23']);
        const flow = createConfirmFlow({ check: srv.check, deliver: srv.deliver });
        flow.scan(7, { code: 'ANAPEREZ23' });
        await tick();
        flow.deliver();
        await tick(); await tick();
        expect(flow.state()).toMatchObject({ held: false, settling: false, card: null });
        expect(flow.scan(7, { code: 'ANAPEREZ23' })).toBe('checking');             // «vuelve a escanear» works
    });
});

describe('a person picked by name replaces the open card, in «Entrega» as on the phone (correctness F3)', () => {
    it('the open card closes as «Cancelar» (nothing recorded), the pick goes before the queue, and Enter can no longer deliver the old card', async () => {
        const s = fakeServer();
        const { flow, closed } = makeFlow(s, { queue: true, settleMs: 0 });
        flow.scan(7, { code: 'ANAPEREZ23' });                 // Ana: ready
        await tick();
        flow.scan(7, { code: 'NOPE000000' });                 // a wedge scan waiting in line
        expect(flow.pick(7, { inscription_id: 2 })).toBe('checking');   // Beto, picked by name
        expect(closed).toEqual(['cancel']);
        await tick();
        expect(flow.state().card).toMatchObject({ body: { inscription_id: 2 }, result: 'not_entitled' });
        expect(flow.state().waiting).toBe(1);
        expect(cardKeyAction('Enter', flow.state().card?.result, '', { now: 1e9, shownAt: 0, lastKeyAt: 0 })).toBeNull();
        expect(flow.deliver()).toBe(false);
        expect(s.calls.deliver).toEqual([]);                 // Ana was never delivered
    });
    it('while a request runs the pick waits at the HEAD of the queue («Entrega») or is ignored (phone); it acknowledges a held result', async () => {
        const s = fakeServer();
        s.hold();
        const desk = makeFlow(s, { queue: true, settleMs: 0 });
        desk.flow.scan(7, { code: 'NOPE000000' });           // checking
        desk.flow.scan(7, { code: 'ANAPEREZ23' });           // queued behind the check: a decision card
        expect(desk.flow.pick(7, { inscription_id: 2 })).toBe('queued');
        s.release();
        for (let i = 0; i < 4; i++) await tick();
        expect(desk.flow.state().card?.body).toEqual({ inscription_id: 2 });  // before Ana's queued scan
        expect(desk.flow.state().waiting).toBe(1);
        const phone = createConfirmFlow({ check: s.check, deliver: s.deliver });
        s.hold();
        phone.scan(7, { code: 'ANAPEREZ23' });
        expect(phone.pick(7, { inscription_id: 2 })).toBe('ignored');
        s.release();
        await tick();
        const srv = lineServer(['ANAPEREZ23']);
        const held = createConfirmFlow({ queue: true, check: srv.check, deliver: srv.deliver });
        held.scan(7, { code: 'ANAPEREZ23' });
        await tick();
        held.deliver();
        await tick(); await tick();
        expect(held.state().held).toBe(true);
        expect(held.pick(7, { code: 'BETOGOMEZ4' })).toBe('checking');
        expect(held.state().held).toBe(false);
    });
});

describe('taps: a card\'s buttons arm a moment after it appears (UX F3)', () => {
    it('tapArmed: nothing counts before `ms`; without `ms` (the immediate 2.15 delivery) everything counts', () => {
        expect(tapArmed(1000, 1000 + TAP_ARM_MS - 1, TAP_ARM_MS)).toBe(false);
        expect(tapArmed(1000, 1000 + TAP_ARM_MS, TAP_ARM_MS)).toBe(true);
        expect(tapArmed(1000, 1000 + 150, VERDICT_TAP_ARM_MS)).toBe(false);   // the impatient second tap on «Entregar»
        expect(tapArmed(1000, 1000 + 700, VERDICT_TAP_ARM_MS)).toBe(true);
        expect(tapArmed(1000, 1001, 0)).toBe(true);
        expect(tapArmed(undefined, 5, TAP_ARM_MS)).toBe(true);
        expect(VERDICT_TAP_ARM_MS).toBeGreaterThan(TAP_ARM_MS);
    });
});

describe('phone: which badge is held after its card closed (UX F4, F7)', () => {
    const c = (result: string, code = 'ANAPEREZ23') => ({ result, body: { code } } as any);
    it('holdAfterClose: never after a reset / replacement or a failure; a hint only after «Cancelar»', () => {
        expect(holdAfterClose(c('ready'), 'reset')).toBeNull();
        expect(holdAfterClose(c('ready'), 'replaced')).toBeNull();
        expect(holdAfterClose(c('offline'), 'close')).toBeNull();
        expect(holdAfterClose(c('error'), 'close')).toBeNull();
        expect(holdAfterClose(c('no_service'), 'close')).toBeNull();
        expect(holdAfterClose(c('ready'), 'deliver', { result: 'offline' })).toBeNull();
        expect(holdAfterClose(c('ready'), 'deliver', { result: 'error' })).toBeNull();
        expect(holdAfterClose(c('ready'), 'cancel')).toEqual({ code: 'ANAPEREZ23', hint: true });
        expect(holdAfterClose(c('ready'), 'deliver', { result: 'delivered' })).toEqual({ code: 'ANAPEREZ23', hint: false });
        expect(holdAfterClose(c('already'), 'close')).toEqual({ code: 'ANAPEREZ23', hint: false });
        expect(holdAfterClose({ result: 'ready', body: { inscription_id: 3 } } as any, 'cancel')).toBeNull();   // a pick has no badge
    });
    it('another service picked with a card open: the badge still in view opens the new service\'s card at once (2.15)', async () => {
        // The scanner's pieces: pickService → router.reset(); the serviceId effect → flow.reset() → onClose.
        const router = createReadRouter(3000);
        let clock = 0;
        const flow = createConfirmFlow({
            check: fakeServer().check, deliver: async () => ({ result: 'delivered' }),
            onClose: (card, why, o) => { const h = holdAfterClose(card, why, o); if (h) router.hold(h.code, clock, h.hint); },
        });
        expect(router.route('ANAPEREZ23', 'code_128', false, clock)).toEqual({ action: 'submit', code: 'ANAPEREZ23' });
        flow.scan(7, { code: 'ANAPEREZ23' });
        await tick();
        clock = 4000;
        router.reset();
        flow.reset();
        expect(router.route('ANAPEREZ23', 'code_128', false, 4050)).toEqual({ action: 'submit', code: 'ANAPEREZ23' });
    });
    it('after «Cancelar» the badge shown again says why (the hint once, kept alive while in view), then opens after 3 s away', () => {
        const r = createReadRouter(3000);
        r.route('ANAPEREZ23', 'code_128', false, 0);
        r.hold('ANAPEREZ23', 10_000, true);
        expect(r.route('ANAPEREZ23', 'code_128', false, 10_200)).toEqual({ action: 'held', code: 'ANAPEREZ23', fresh: true });
        expect(r.route('ANAPEREZ23', 'code_128', false, 10_400)).toEqual({ action: 'held', code: 'ANAPEREZ23', fresh: false });
        expect(r.route('ANAPEREZ23', 'code_128', true, 10_500)).toBeNull();                  // busy: nothing
        expect(r.route('ANAPEREZ23', 'code_128', false, 13_500)).toEqual({ action: 'submit', code: 'ANAPEREZ23' });
        expect(r.route('ANAPEREZ23', 'code_128', false, 13_600)).toBeNull();                 // in view after a submit: silent, as in 2.15
        r.hold('BETTYGMZ23', 20_000);                                                         // a delivered / closed card: silent
        expect(r.route('BETTYGMZ23', 'code_128', false, 20_100)).toBeNull();
        const html = render(<ReadCard read={{ value: 'ANAPEREZ23', format: '', seq: 1, held: true }} tx={es} />);
        expect(html).toContain('data-scan-read="held"');
        expect(html).toContain('Entrega cancelada. Para volver a abrirla, aparta el código unos segundos y vuelve a acercarlo.');
        expect(html).not.toContain('no es un código de inscripción');
    });
});

describe('the card on a short phone: WHO it is never scrolls away (UX F5; 2.17.0 live round at 320×460)', () => {
    // 2.16.0 put the status and the name in a sticky header INSIDE the part that scrolls. The 2.17.0 live round
    // on a first-generation SE (320×460) with a long service label (a three-line meal band, 100 px): that part
    // got 81 px for a 156 px header — the name cut for good, partly under «Entregar»; on a not-entitled card
    // «Entregar sin derecho (autorizar)» wrapped to four lines and left 34 px — the name hidden, staff could
    // authorise without seeing who. Measured since in Chromium (scratchpad harness: the real scanner frame + this
    // card, 320×460 … 414×736, long names and labels): status, whole name and every button in view, no entry
    // cut mid-line. Pinned here: the structure, the rules and the labels that do it.
    const tagOf = (html: string, attr: string) => { const i = html.indexOf(attr); expect(i, attr).toBeGreaterThan(-1); return html.slice(html.lastIndexOf('<', i), html.indexOf('>', i) + 1); };
    const styleOf = (html: string, attr: string) => (/style="([^"]*)"/.exec(tagOf(html, attr))?.[1] || '');
    const elementOf = (html: string, attr: string) => {
        const tag = tagOf(html, attr);
        const start = html.indexOf(tag);
        const name = /^<([a-z0-9]+)/.exec(tag)![1];
        const re = new RegExp(`<${name}[\\s>]|</${name}>`, 'g');
        re.lastIndex = start + tag.length;
        let depth = 1; let m: RegExpExecArray | null;
        while (depth > 0 && (m = re.exec(html))) depth += m[0].startsWith('</') ? -1 : 1;
        return html.slice(start, re.lastIndex);
    };
    const SRC = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/MealScanner.tsx'), 'utf8');
    const CARD_SRC = SRC.slice(SRC.indexOf('export function ConfirmCard('), SRC.indexOf('/** «Comprobando…»'));
    const short = CONFIRM_CSS.slice(CONFIRM_CSS.indexOf('@media (max-height: 640px)'), CONFIRM_CSS.indexOf('@media (max-height: 520px)'));
    const shortest = CONFIRM_CSS.slice(CONFIRM_CSS.indexOf('@media (max-height: 520px)'), CONFIRM_CSS.indexOf('@media (max-width: 380px), (max-height: 640px)'));

    it('WHO is its own header, never inside the part that scrolls: meal → status + name → the rest (scrolls) → the buttons', () => {
        for (const r of ['ready', 'not_entitled', 'already'] as const) {
            const html = render(<ConfirmCard card={card(r)} large />);
            const at = (attr: string) => html.indexOf(attr);
            expect(at('data-confirm-meal=""'), r).toBeGreaterThan(0);
            expect(at('data-confirm-head=""'), r).toBeGreaterThan(at('data-confirm-meal=""'));
            expect(at('data-confirm-status=""'), r).toBeGreaterThan(at('data-confirm-head=""'));
            expect(at('data-confirm-name=""'), r).toBeGreaterThan(at('data-confirm-status=""'));
            expect(at('data-confirm-scroll=""'), r).toBeGreaterThan(at('data-confirm-name=""'));
            expect(at('data-confirm-actions=""'), r).toBeGreaterThan(at('data-confirm-scroll=""'));
            // The part that scrolls holds the rest — never the status or the name (a header inside it was cut for good).
            const scroll = elementOf(html, 'data-confirm-scroll=""');
            expect(scroll, r).not.toContain('data-confirm-name');
            expect(scroll, r).not.toContain('data-confirm-status');
            expect(scroll, r).not.toContain('data-confirm-head');
            expect(scroll, r).toContain('Vegetariana');
            expect(elementOf(html, 'data-confirm-head=""'), r).toMatch(/data-confirm-name=""[^>]*>Ana Pérez</);
            expect(html.match(/Ana Pérez/g)?.length, r).toBe(1);                  // the name once
            // Who gives way: the rest first (100000), the name last (1, never below one line, then it scrolls inside
            // itself); the meal band, the status and the buttons never.
            expect(styleOf(html, 'data-confirm-head=""'), r).toBe('flex:0 1 auto;min-height:0;overflow:hidden;padding:12px 16px 8px;display:flex;flex-direction:column;gap:8px;min-width:0');
            expect(styleOf(html, 'data-confirm-status=""'), r).toMatch(/^align-self:flex-start;flex-shrink:0;/);
            expect(styleOf(html, 'data-confirm-name=""'), r).toBe('flex:0 1 auto;min-height:1.15em;overflow-y:auto;font-size:26px;font-weight:900;line-height:1.15;overflow-wrap:anywhere');
            expect(styleOf(html, 'data-confirm-scroll=""'), r).toBe('position:relative;overflow-y:auto;min-height:0;flex:0 100000 auto');
            expect(CONFIRM_SCROLL).toEqual({ position: 'relative', overflowY: 'auto', minHeight: 0, flex: '0 100000 auto' });
            expect(styleOf(html, 'data-confirm-meal=""'), r).toMatch(/flex-shrink:0$/);
            expect(styleOf(html, 'data-confirm-actions=""'), r).toMatch(/flex-shrink:0$/);
            expect(html, r).toContain('data-confirm-large=""');
        }
        // A server without fields: the plain name in the same place; «Entrega» (not large) the same structure.
        expect(render(<ConfirmCard card={{ ...card('ready'), verdict: { service: SERVICE, person: { id: 1, name: 'Ana Pérez' } } }} />)).toMatch(/data-confirm-head="[^"]*"[^>]*>[\s\S]*data-confirm-name=""[^>]*>Ana Pérez</);
        const entrega = render(<ConfirmCard card={card('ready')} />);
        expect(elementOf(entrega, 'data-confirm-scroll=""')).not.toContain('data-confirm-name');
        expect(splitPersonFields({ name: 'Ana', fields: [{ key: 'dieta', label: 'Dieta', value: 'x' }] })).toEqual({ name: { key: '@name', label: '', value: 'Ana' }, rest: [{ key: 'dieta', label: 'Dieta', value: 'x' }] });
    });

    it('the meal: three lines at most; on a short screen ONE where only the label gives way (320×460: the day on it too); a tap shows it WHOLE, never at the name\'s cost', () => {
        const html = render(<ConfirmCard card={card('ready')} large language="es" />);
        // The whole text is the band's title; the meal and its label are separate parts.
        expect(tagOf(html, 'data-confirm-meal=""')).toContain('title="Lunes 01/03 · Almuerzo — Campestre"');
        expect(html).toMatch(/<span data-confirm-meal-meal="">Almuerzo<\/span><span data-confirm-meal-label=""> — Campestre<\/span>/);
        // Every height: three lines at most (a 120-character label took ten and cut the name at 375×667); tapped,
        // WHOLE — no fixed cap at any height (2.17.0 live round: «a tap shows it whole» showed two lines at 320×460,
        // cut mid-phrase with no cue); useOpenMeal cuts it only when the card cannot hold it (pinned below).
        expect(CONFIRM_CSS).toContain('[data-confirm-card][data-confirm-large] [data-confirm-meal]:not([data-open]) [data-confirm-meal-name] { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }');
        expect(CONFIRM_CSS).not.toMatch(/\[data-open\][^{]*\{[^}]*max-height/);
        // Short: one line, only the label shrinks (an ellipsis), the meal stays.
        for (const rule of [
            '[data-confirm-card][data-confirm-large] [data-confirm-meal]:not([data-open]) [data-confirm-meal-name] { display: flex; align-items: baseline; white-space: pre; }',
            '[data-confirm-card][data-confirm-large] [data-confirm-meal]:not([data-open]) [data-confirm-meal-name] > * { flex-shrink: 0; }',
            '[data-confirm-card][data-confirm-large] [data-confirm-meal]:not([data-open]) [data-confirm-meal-label] { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }',
        ]) expect(short, rule).toContain(rule);
        // The shortest: the day and the meal on that one line; tapped, they wrap.
        for (const rule of [
            '[data-confirm-card][data-confirm-large] [data-confirm-meal] { flex-wrap: nowrap; padding: 6px 12px !important; }',
            '[data-confirm-card][data-confirm-large] [data-confirm-meal][data-open] { flex-wrap: wrap; }',
            '[data-confirm-card][data-confirm-large] [data-confirm-day] { flex-shrink: 0; }',
        ]) expect(shortest, rule).toContain(rule);
        // A tap toggles it (never deciding anything, and in «Entrega» the click still reaches the tab, which gives
        // the scan input its focus back); a new card closes it (useOpenMeal's key); shown whole it never costs the
        // name, the status or the buttons a line: when they lack room it keeps its whole lines that fit, «Más
        // abajo» at the end of the day's line (no room of its own), and scrolls — or closes when not one fits.
        expect(CARD_SRC).toMatch(/onClick=\{s \? \(\) => meal\.setOpen\(\(o\) => !o\) : undefined\}/);
        const band = CARD_SRC.slice(CARD_SRC.indexOf('<div data-confirm-meal=""'), CARD_SRC.indexOf('{s ? <>'));
        expect(band).not.toContain('stopPropagation');
        expect(CARD_SRC).toMatch(/data-open=\{mealOpen \? '' : undefined\}/);
        expect(CARD_SRC).toMatch(/const meal = useOpenMeal\(card\?\.seq, \(\) => Math\.max\(clippedPx\(nameRef\.current\), clippedPx\(headRef\.current\), clippedPx\(cardRef\.current\)\), 0\);/);
        expect(CARD_SRC).not.toMatch(/setMealOpen\(false\)/);
        expect(CARD_SRC).toMatch(/\{s \? <>\s+\{mealOpen && meal\.cap != null && <MoreCue attr="data-confirm-meal-more" atEnd=\{meal\.atEnd\} style=\{CONFIRM_MEAL_MORE_STYLE\} \/>\}\s+<div data-confirm-day=""/);
        expect(CARD_SRC).toMatch(/<div ref=\{meal\.ref\} data-confirm-meal-name="" onScroll=\{meal\.onScroll\} style=\{\{ [^}]*order: 2, \.\.\.openMealStyle\(meal\.cap\) \}\}>/);
        expect(CARD_SRC).toMatch(/<div ref=\{headRef\} data-confirm-head=""/);
        expect(CARD_SRC).toMatch(/<div ref=\{cardRef\} role=/);
        expect(CARD_SRC).toMatch(/\{name && <div ref=\{nameRef\} data-confirm-name=""/);
        // «Entrega» (not large): the same whole text as its title; its layout changes only on a narrow AND short phone.
        const entrega = tagOf(render(<ConfirmCard card={card('ready')} language="es" />), 'data-confirm-meal=""');
        expect(entrega).toContain('title="Lunes 01/03 · Almuerzo — Campestre"');
        expect(entrega).not.toContain('data-open');
    });

    it('«Entrega» on a narrow AND short phone: its meal on one line and «Autorizar» too — at 320×460 under the admin header its cap could not hold its buttons', () => {
        // Measured (harness: the tab's slot, capped by revealSlot): a four-line meal, a five-line name and a six-line
        // «Entregar sin derecho (autorizar)» made its essentials taller than the visible band, so it was not capped
        // and its buttons stayed below the edge. Desktop and taller phones keep their layout.
        const entregaRules = CONFIRM_CSS.slice(CONFIRM_CSS.indexOf('@media (max-width: 600px) and (max-height: 640px)'));
        expect(entregaRules.length).toBeGreaterThan(0);
        for (const rule of [
            '[data-confirm-card]:not([data-confirm-large]) [data-confirm-meal]:not([data-open]) [data-confirm-meal-name] { display: flex; align-items: baseline; white-space: pre; }',
            '[data-confirm-card]:not([data-confirm-large]) [data-confirm-meal]:not([data-open]) [data-confirm-meal-name] > * { flex-shrink: 0; }',
            '[data-confirm-card]:not([data-confirm-large]) [data-confirm-meal]:not([data-open]) [data-confirm-meal-label] { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }',
            '[data-confirm-card]:not([data-confirm-large]) [data-label-long] { display: none !important; }',
            '[data-confirm-card]:not([data-confirm-large]) [data-label-short] { display: inline !important; }',
        ]) expect(entregaRules, rule).toContain(rule);
        // Tapped: whole, as on the phone (no fixed cap; useOpenMeal).
        expect(entregaRules).not.toMatch(/\{[^}]*max-height/);
        // Every other rule stays the phone scanner's (large) card's.
        const rest = CONFIRM_CSS.slice(0, CONFIRM_CSS.indexOf('@media (max-width: 600px) and (max-height: 640px)'));
        for (const sel of rest.match(/^\s*\[data-confirm-card\][^{]*/gm) || []) expect(sel, sel).toContain('[data-confirm-card][data-confirm-large]');
        // The short label is in «Entrega»'s button too (hidden until then), its accessible name whole.
        const html = render(<ConfirmCard card={card('not_entitled')} keyHints />);
        expect(html).toMatch(/aria-label="Entregar sin derecho \(autorizar\)"><i class="fa-solid fa-hand" aria-hidden="true"><\/i><span data-label-long="">Entregar sin derecho \(autorizar\)<\/span><span data-label-short="" style="display:none">Autorizar<\/span>/);
    });

    it('«Entregar sin derecho (autorizar)» reads «Autorizar» on a narrow or short phone (four lines there hid the name); its accessible name stays whole', () => {
        const html = render(<ConfirmCard card={card('not_entitled')} large />);
        expect(tagOf(html, 'data-confirm-authorize=""')).toContain('aria-label="Entregar sin derecho (autorizar)"');
        expect(html).toMatch(/<span data-label-long="">Entregar sin derecho \(autorizar\)<\/span><span data-label-short="" style="display:none">Autorizar<\/span><\/button>/);
        expect(CONFIRM_CSS).toContain('@media (max-width: 380px), (max-height: 640px) {\n  [data-confirm-card][data-confirm-large] [data-label-long] { display: none !important; }\n  [data-confirm-card][data-confirm-large] [data-label-short] { display: inline !important; }\n}');
        expect(translations.es['meals.confirm.authorize.short']).toBe('Autorizar');
        expect(translations.en['meals.confirm.authorize.short']).toBe('Authorize');
        expect(translations.pt['meals.confirm.authorize.short']).toBe('Autorizar');
        // While recording: «Registrando…» alone, also as its name.
        const busy = render(<ConfirmCard card={card('not_entitled')} large delivering />);
        expect(tagOf(busy, 'data-confirm-authorize=""')).toContain('aria-label="Registrando…"');
        expect(busy).not.toContain('<span data-label-short');
        // Still the outlined, smaller button on the left; «Cancelar» the big one on the right (UX F6).
        expect(html.indexOf('data-confirm-authorize')).toBeLessThan(html.indexOf('data-confirm-cancel'));
    });

    it('short screens: tighter paddings and slimmer buttons (44 px or more); the shortest tighter still; the scanner folds its counters while a card is open', () => {
        expect(short).toContain('[data-confirm-card][data-confirm-large] [data-confirm-meal] { display: flex !important; flex-wrap: wrap; align-items: baseline; column-gap: 10px; padding-top: 8px !important; padding-bottom: 8px !important; }');
        expect(short).toContain('[data-confirm-card][data-confirm-large] [data-confirm-actions] button { min-height: 50px !important; padding-top: 6px !important; padding-bottom: 6px !important; }');
        for (const rule of [
            '[data-confirm-card][data-confirm-large] [data-confirm-meal-name] { font-size: 18px !important; }',
            '[data-confirm-card][data-confirm-large] [data-confirm-head] { padding: 6px 12px 4px !important; }',
            '[data-confirm-card][data-confirm-large] [data-confirm-status] { padding: 4px 10px !important; font-size: 13px !important; }',
            '[data-confirm-card][data-confirm-large] [data-confirm-name] { font-size: 20px !important; }',
            '[data-confirm-card][data-confirm-large] [data-confirm-actions] { padding: 0 12px 10px !important; }',
            '[data-confirm-card][data-confirm-large] [data-confirm-actions] button { min-height: 46px !important; }',
        ]) expect(shortest, rule).toContain(rule);
        expect(CONFIRM_CSS).toMatch(/@media \(max-width: 380px\) \{\s+\[data-confirm-card\]\[data-confirm-large\] \[data-long-label\] \{ font-size: 13px !important;/);
        expect(render(<ConfirmCard card={card('not_entitled')} large />)).toMatch(/data-confirm-authorize="" data-long-label=""/);
        expect(render(<ConfirmCard card={card('ready')} large />)).toContain('@media (max-height: 640px)');
        expect(SCANNER_CSS).toMatch(/@media \(max-height: 700px\) \{ \[data-meal-scanner\]\[data-card-open\] \[data-scanner-counters\] \{ display: none !important; \} \}/);
    });
});

describe('the person\'s other data end on a WHOLE line, «Más abajo» under the cut (2.17.0 live round)', () => {
    // Live round + skeptic: a lone faded «LOCALIDAD» with no value (320×460, 375×548), an «EMAIL» label with only
    // the tops of its value (390×844), a sliver of a label above «Más abajo» (375×548). On both cards.
    it('detailsCut: uncut when it fits; else after a whole entry or a whole line of a VALUE — never a label alone — with room for «Más abajo»', () => {
        expect(MORE_CUE_PX).toBe(20);
        // Fits (1 px is rounding).
        expect(detailsCut([{ bottom: 40 }, { bottom: 100 }], 100, 100)).toEqual({ height: null, hidden: 0 });
        expect(detailsCut([{ bottom: 40 }, { bottom: 101 }], 100, 101)).toEqual({ height: null, hidden: 0 });
        // Only the bottom padding is out of view: every entry whole, nothing to say.
        expect(detailsCut([{ bottom: 40 }, { bottom: 80 }], 84, 94)).toEqual({ height: 80, hidden: 0 });
        // Whole entries that fit with the cue's 20 px.
        expect(detailsCut([{ bottom: 40 }, { bottom: 80 }, { bottom: 120 }], 100, 130)).toEqual({ height: 80, hidden: 1 });
        // Inside an entry: after a whole line of its value (LOCALIDAD on line 1 ends at 18 — not a cut point).
        const loc = { bottom: 100, lines: [45, 72, 100] };
        expect(detailsCut([loc], 70, 110)).toEqual({ height: 45, hidden: 1 });
        expect(detailsCut([loc], 92, 110)).toEqual({ height: 72, hidden: 1 });
        // Not even the label and one line of its value: left out (height 0) — never a lone label.
        expect(detailsCut([loc], 60, 110)).toEqual({ height: 0, hidden: 1 });
        // After a whole entry, the next one's first line.
        expect(detailsCut([{ bottom: 22 }, { bottom: 110, lines: [59, 86, 110] }], 90, 120)).toEqual({ height: 59, hidden: 1 });
        expect(detailsCut([{ bottom: 22 }, { bottom: 110, lines: [59, 86, 110] }], 60, 120)).toEqual({ height: 22, hidden: 1 });
        expect(detailsCut([], 10, 14)).toEqual({ height: 0, hidden: 0 });
    });

    it('measureDetails: entries in layout px (offsetTop + offsetHeight); value lines from their rects, un-scaled (the card\'s entry animation) and scrolled', () => {
        // The part: 90 px laid out, drawn at 0.95 (zoom-in-95) from y 300; the entry «LOCALIDAD» + a 3-line value.
        const scale = 0.95, top = 300;
        const lineBox = (b: number) => ({ bottom: top + b * scale, height: 20 * scale });
        const value = { kind: 'value' };
        const doc = { createRange: () => { let t: any = null; return { selectNodeContents: (x: any) => { t = x; }, getClientRects: () => (t === value ? [lineBox(45), lineBox(72), lineBox(99), { bottom: top, height: 0 }] : []) }; } };
        const entries = [
            { offsetTop: 0, offsetHeight: 22, lastElementChild: null, ownerDocument: { createRange: () => ({ selectNodeContents() { }, getClientRects: () => [lineBox(20)] }) } },
            { offsetTop: 32, offsetHeight: 68, lastElementChild: value, ownerDocument: doc },
        ];
        const el = { clientHeight: 90, scrollHeight: 114, offsetHeight: 90, scrollTop: 0, getBoundingClientRect: () => ({ top, height: 90 * scale }), querySelectorAll: (s: string) => { expect(s).toBe(DETAIL_ENTRY_SELECTOR); return entries; } };
        expect(DETAIL_ENTRY_SELECTOR).toBe('[data-field],[data-entry]');
        expect(valueLineBottoms(entries[1], top, scale)).toEqual([45, 72, 99]);
        expect(measureDetails(el)).toEqual({ height: 45, hidden: 1 });       // 90 − 20 = 70 of room: «LOCALIDAD» + one line
        // Scrolled by 10 (its content drawn 10 px higher): the same layout positions.
        expect(valueLineBottoms(entries[1], top + 10 * scale, scale, 10)).toEqual([45, 72, 99]);
        // No Range, no layout: no line cut points (whole entries only), never a throw.
        expect(valueLineBottoms({ lastElementChild: null }, 0, 1)).toEqual([]);
        expect(valueLineBottoms({ ownerDocument: doc, lastElementChild: value }, 0, 0)).toEqual([]);
        expect(valueLineBottoms({ ownerDocument: { createRange: () => { throw new Error('x'); } } }, 0, 1)).toEqual([]);
        expect(measureDetails({ clientHeight: 90, scrollHeight: 90, querySelectorAll: () => [] })).toEqual({ height: null, hidden: 0 });
        // Measured again when the room changed since (a cap after the card's own layout).
        expect(detailsStale({ height: null, hidden: 0 }, { scrollHeight: 120, clientHeight: 100 })).toBe(true);
        expect(detailsStale({ height: null, hidden: 0 }, { scrollHeight: 101, clientHeight: 100 })).toBe(false);
        expect(detailsStale({ height: 80, hidden: 1 }, { scrollHeight: 200, clientHeight: 60 })).toBe(true);
        expect(detailsStale({ height: 80, hidden: 1 }, { scrollHeight: 200, clientHeight: 80 })).toBe(false);
    });

    it('both cards: the cut part, «Más abajo ↓» (20 px, never a control) under it, left out when nothing fits; the cards\' own lines are entries', () => {
        expect(detailsStyle(CONFIRM_SCROLL, null)).toEqual(CONFIRM_SCROLL);
        expect(detailsStyle(CONFIRM_SCROLL, { height: null, hidden: 0 })).toEqual(CONFIRM_SCROLL);
        expect(detailsStyle(CONFIRM_SCROLL, { height: 59, hidden: 2 })).toEqual({ ...CONFIRM_SCROLL, maxHeight: 59 });
        expect(detailsShown(null)).toBe(true);
        expect(detailsShown({ height: 0, hidden: 3 })).toBe(false);
        expect(detailsMore({ height: 59, hidden: 2 })).toBe(true);
        expect(detailsMore({ height: 80, hidden: 0 })).toBe(false);
        expect(detailsMore({ height: 0, hidden: 3 })).toBe(false);
        expect(detailsMore(null)).toBe(false);
        const cue = render(<MoreCue attr="data-confirm-more" style={CONFIRM_MORE_STYLE} />);
        expect(cue).toMatch(/^<div data-confirm-more="" aria-hidden="true" style="flex-shrink:0;height:20px;line-height:20px;overflow:hidden;white-space:nowrap;font-weight:900;text-align:center;font-size:12px;color:#374151">Más abajo <i class="fa-solid fa-arrow-down" aria-hidden="true"><\/i><\/div>$/);
        expect(render(<MoreCue attr="data-verdict-more" atEnd style={{}} />)).toContain('visibility:hidden');
        // Measured on every new card / question / meal line opened, and on every window size (useWholeEntries).
        const SRC = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/MealScanner.tsx'), 'utf8');
        const hook = SRC.slice(SRC.indexOf('export function useWholeEntries('), SRC.indexOf('/** The part that scrolls, for what was measured'));
        expect(hook).toMatch(/useLayoutEffect\(\(\) => \{ setFit\(null\); setAtEnd\(false\); \}, \[key\]\);/);
        expect(hook).toMatch(/useLayoutEffect\(\(\) => \{\s+if \(fit\) return;\s+const el = ref\.current;\s+if \(el\) setFit\(measureDetails\(el\)\);\s+\}\);/);
        expect(hook).toMatch(/if \(el && fit && detailsStale\(fit, el\)\) setFit\(null\);/);
        expect(hook).toMatch(/const refit = \(\) => \{ setFit\(null\); setAtEnd\(false\); \};\s+window\.addEventListener\('resize', refit\);/);
        expect(SRC).toMatch(/const restFit = useWholeEntries\(`\$\{seq\}:\$\{armed\}:\$\{mealOpen\}:\$\{meal\.cap\}`\);/);
        // The confirmation card: also when «Entregar sin derecho (autorizar)» switches to «Autorizar» (useLabelFit).
        expect(SRC).toMatch(/const restFit = useWholeEntries\(`\$\{card\?\.seq\}:\$\{mealOpen\}:\$\{meal\.cap\}:\$\{authorizeFit\.short\}`\);/);
        expect(SRC).toMatch(/\{detailsShown\(restFit\.fit\) && \(\s+<div data-confirm-scroll="" ref=\{restFit\.ref\} onScroll=\{restFit\.onScroll\} style=\{detailsStyle\(CONFIRM_SCROLL, restFit\.fit\)\}>/);
        expect(SRC).toMatch(/\{detailsMore\(restFit\.fit\) && <MoreCue attr="data-confirm-more" atEnd=\{restFit\.atEnd\} style=\{CONFIRM_MORE_STYLE\} \/>\}\s+<div data-confirm-actions=""/);
        // The confirmation card's own lines are entries («Recibió a las…», the code, the queue, the keys). WHY a
        // not-entitled person has no right to the meal is not one any more: it is part of the status, in the header that
        // never gives way (2.17.0 live round at 320×460: it went with the part that scrolls — pinned at the end of this file).
        const html = render(<ConfirmCard card={card('not_entitled')} waiting={2} keyHints />);
        expect(html).not.toMatch(/data-entry=""[^>]*>No está en el plan de su localidad/);
        expect(html).toContain('No está en el plan de su localidad');
        expect(html).toMatch(/data-confirm-waiting="2" data-entry=""/);
        expect(html).toMatch(/<div data-entry="" style="font-size:11px;[^"]*">Enter no autoriza/);
        expect(render(<ConfirmCard card={card('already', { delivered_at: '2027-03-01 17:31:00' })} />)).toMatch(/<div data-entry="" style="font-size:14px;font-weight:700">Recibió a las/);
        // Uncut until measured (the server render, the first layout): no cut, no «Más abajo».
        expect(html).toContain('data-confirm-scroll="" style="position:relative;overflow-y:auto;min-height:0;flex:0 100000 auto"');
        expect(html).not.toContain('data-confirm-more');
    });
});

describe('not entitled: the routine tap never authorises (UX F6)', () => {
    it('«Entregar sin derecho (autorizar)» is the smaller, outlined button on the LEFT; «Cancelar» the big one on the right', () => {
        const html = render(<ConfirmCard card={card('not_entitled')} large />);
        expect(html.indexOf('data-confirm-authorize')).toBeLessThan(html.indexOf('data-confirm-cancel'));
        expect(html).toMatch(/data-confirm-cancel="" style="flex:2 1 0%;[^"]*background:#111827/);
        expect(html).toMatch(/data-confirm-authorize="" data-long-label="" style="flex:1 1 0%;[^"]*border:2px solid #b45309/);
        expect(html).toMatch(/data-confirm-authorize="" data-long-label="" style="[^"]*background:#fff;/);
        // «ready» keeps «Cancelar» small on the left and «Entregar» big on the right.
        const ready = render(<ConfirmCard card={card('ready')} large />);
        expect(ready.indexOf('data-confirm-cancel')).toBeLessThan(ready.indexOf('data-confirm-deliver'));
        expect(ready).toMatch(/data-confirm-deliver="" style="flex:2 1 0%;/);
        expect(ready).toMatch(/data-confirm-cancel="" style="flex:1 1 0%;/);
    });
});

describe('contrast on the coloured verdict card (UX F8)', () => {
    it('labels at full strength on colour; the meal band\'s day line is not dimmed', () => {
        expect(render(<PersonFields fields={FIELDS} onColour />)).toMatch(/data-field-label="" style="font-size:12px;[^"]*opacity:1"/);
        expect(render(<PersonFields fields={FIELDS} />)).toMatch(/data-field-label="" style="font-size:11px;[^"]*opacity:0.7"/);
        const delivered = render(<VerdictCard outcome={{ result: 'delivered', seq: 1, at: 0, verdict: { delivery_id: 3, person: { id: 1, name: 'Ana Pérez', fields: FIELDS } } }} />);
        expect(delivered).toMatch(/data-field-label="" style="[^"]*opacity:1"/);
        expect(delivered).not.toMatch(/data-field-label="" style="[^"]*opacity:0.7"/);
        expect(render(<ConfirmCard card={card('ready')} />)).not.toMatch(/data-confirm-day="" style="[^"]*opacity/);
    });
});

describe('«ready» has its own sound (UX F9)', () => {
    it('attention(): two rising tones and a double pulse — never the blip of a barcode that is not a registration code', () => {
        const freqs: number[] = [];
        const vib: any[] = [];
        class Ctx {
            state = 'running'; currentTime = 0; destination = {};
            resume() { return Promise.resolve(); }
            close() { }
            createOscillator() { const o: any = { type: '', frequency: { value: 0 }, connect() { }, start() { }, stop() { freqs.push(o.frequency.value); } }; return o; }
            createGain() { return { gain: { setValueAtTime() { }, exponentialRampToValueAtTime() { } }, connect() { } }; }
            createBuffer() { return {}; }
            createBufferSource() { return { connect() { }, start() { } }; }
        }
        vi.stubGlobal('window', { AudioContext: Ctx });
        vi.stubGlobal('navigator', { vibrate: (p: any) => { vib.push(p); return true; } });
        const fb = createFeedback();
        fb.attention();
        expect(freqs).toEqual([660, 990]);
        expect(vib).toEqual([[30, 40, 30]]);
        freqs.length = 0; vib.length = 0;
        fb.info();
        expect(freqs).toEqual([880]);
        expect(vib).toEqual([25]);
    });
});

describe('«Qué se muestra al entregar»: «Restablecer» does not save; the name is locked; the wording is honest (UX F10, F11, correctness F2)', () => {
    it('displaySaveKeys: the default, however it was reached, saves as «not configured»', () => {
        expect(displaySaveKeys(['@name', '@location'])).toBeNull();
        expect(displaySaveKeys(['@location'])).toBeNull();
        expect(displaySaveKeys(withName(DEFAULT_DISPLAY_KEYS), DEFAULT_DISPLAY_KEYS)).toBeNull();
        expect(displaySaveKeys(['@name', 'dieta'])).toEqual(['@name', 'dieta']);
        expect(displaySaveKeys(['dieta'])).toEqual(['@name', 'dieta']);
        expect(displaySaveKeys(['@location', '@name', 'dieta'])).toEqual(['@name', '@location', 'dieta']);
    });
    it('the name can be neither unticked nor moved, and nothing moves above it', () => {
        expect(withName(['dieta', '@name', 'talla'])).toEqual(['@name', 'dieta', 'talla']);
        expect(withName([])).toEqual(['@name']);
        expect(toggleDisplayKey(['@name', 'dieta'], '@name')).toEqual(['@name', 'dieta']);
        expect(toggleDisplayKey(['dieta'], '@name')).toEqual(['@name', 'dieta']);
        expect(canMoveDisplayKey(['@name', 'a', 'b'], '@name', 1)).toBe(false);
        expect(canMoveDisplayKey(['@name', 'a', 'b'], 'a', -1)).toBe(false);
        expect(canMoveDisplayKey(['@name', 'a', 'b'], 'b', -1)).toBe(true);
        expect(canMoveDisplayKey(['@name', 'a', 'b'], 'b', 1)).toBe(false);
        expect(moveDisplayKey(['@name', 'a'], 'a', -1)).toEqual(['@name', 'a']);
        expect(moveDisplayKey(['@name', 'a'], '@name', 1)).toEqual(['@name', 'a']);
    });
    it('the dialog promises only what the API does, in es / en / pt', () => {
        for (const lang of ['es', 'en', 'pt'] as const) {
            const t = translations[lang];
            expect(t['meals.display.subtitle'], lang).not.toMatch(/Solo estos datos llegan|Only these items reach|Só estes dados chegam/);
            expect(t['meals.display.note'], lang).toBeTruthy();
        }
        expect(translations.es['meals.display.note']).toMatch(/solo se envían a la tarjeta si los eliges/);
        expect(translations.es['meals.display.note']).toMatch(/búsqueda por nombre/);
        expect(translations.en['meals.display.note']).toMatch(/search by name/);
        expect(translations.pt['meals.display.note']).toMatch(/busca por nome/);
    });
});

/**
 * WIRING. The screens need a browser; the lines that connect the tested pieces to them are pinned on the
 * source (if one is dropped, the piece it connects is tested but dead).
 */
describe('wiring (source): both screens run the tested pieces', () => {
    const ADMIN = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin');
    const scanner = fs.readFileSync(path.join(ADMIN, 'MealScanner.tsx'), 'utf8');
    const page = fs.readFileSync(path.join(ADMIN, 'MealsPage.tsx'), 'utf8');
    const body = scanner.slice(scanner.indexOf('export function MealScanner('));
    const tab = page.slice(page.indexOf('function DeliveryTab('), page.indexOf('function DisplayFieldsDialog('));
    const confirmCard = scanner.slice(scanner.indexOf('export function ConfirmCard('), scanner.indexOf('export function CheckingCard('));
    const verdictCard = scanner.slice(scanner.indexOf('export function VerdictCard('), scanner.indexOf('// ── Confirmation card (2.16.0)'));

    it('the phone scanner: a read code opens the card (toggle ON) or delivers (OFF); decoding pauses; the badge is held', () => {
        expect(body).toMatch(/if \(!confirmRef\.current\) \{ submit\(body\); return; \}/);
        // A manual entry (typed code, name picked) replaces the open card; a camera read never does.
        expect(body).toMatch(/if \(\(manual \? f\.pick\(sid, body\) : f\.scan\(sid, body\)\) === 'checking'\)/);
        expect(body).toMatch(/scanBody\(\{ code: raw \}, true\)/);
        expect(body).toMatch(/scanBody\(\{ inscription_id: p\.id \}, true\)/);
        expect(body).toMatch(/router\.current\.route\(raw, format, inFlight\.current \|\| f\.isOpen\(\) \|\| f\.isBusy\(\)\)/);
        expect(body).toMatch(/if \(r\.action === 'submit'\) \{ scanBody\(\{ code: r\.code \}\); return; \}/);
        expect(body).toMatch(/if \(scanPaused\(\{ inFlight: inFlight\.current, sheet: sheetRef\.current, armed: armedRef\.current, flow: flowRef\.current \}\)\) meter\.current\.pause\(\);/);
        // UX F4 / F7: the hold rules of holdAfterClose, with the «Cancelar» hint; a held badge shows it.
        expect(body).toMatch(/onClose: \(card, why, outcome\) => \{ const h = holdAfterClose\(card, why, outcome\); if \(h\) router\.current\.hold\(h\.code, Date\.now\(\), h\.hint\); \}/);
        expect(body).not.toMatch(/router\.current\.hold\(c\)/);
        expect(body).toMatch(/if \(r\.action === 'held'\) \{ if \(r\.fresh\) \{ setRead\(\{ value: r\.code, format: '', held: true, seq: Date\.now\(\) \}\); feedback\.current\.info\(\); \} return; \}/);
        expect(body).toMatch(/queue: false,/);
        expect(body).toMatch(/onDeliver=\{\(\) => flow\.deliver\(\)\}/);
        expect(body).toMatch(/onCancel=\{\(\) => flow\.cancel\(\)\}/);
        expect(body).toMatch(/onAuthorize=\{\(\) => flow\.authorize\(/);
        // Only the server's 'delivered' reads «Entregado»: the delivery answer goes to the usual verdict.
        expect(body).toMatch(/onResult: \(o\) => \{ if \(aliveRef\.current\) show\(o\); \}/);
        // UX F9: a ready card has its own cue.
        expect(body).toMatch(/if \(card\.result === 'ready'\) feedback\.current\.attention\(\);/);
        // Esc: a sheet, then the card, then the scanner.
        expect(body).toMatch(/else if \(f\.isOpen\(\)\) \{ if \(!f\.cancel\(\)\) f\.close\(\); \}/);
        // Another service resets the flow; the toggle lives in the service sheet.
        expect(body).toMatch(/useEffect\(\(\) => \{ flow\.reset\(\); \}, \[serviceId, flow\]\);/);
        expect(body).toMatch(/<ConfirmToggle dark on=\{confirmOn\} onChange=\{setConfirmOn\} \/>/);
        // UX F5: the card may use the whole camera area; the counters fold away on a short phone.
        expect(body).toMatch(/data-confirm-slot="" style=\{\{ position: 'absolute', left: SAFE_LEFT, right: SAFE_RIGHT, bottom: 12, top: 8,/);
        expect(body).toMatch(/data-card-open=\{confirm\.card \|\| confirm\.checking \? '' : undefined\}/);
        expect(body).toMatch(/<div data-scanner-counters="" /);
        // UX F3: the «Entregado» card after a confirmation ignores taps for a moment (OFF = 2.15, no delay).
        expect(body).toMatch(/armMs=\{confirmOn \? VERDICT_TAP_ARM_MS : 0\}/);
        // Unmount RESETS the shared hook's flow (StrictMode remounts effects; a disposed flow would ignore
        // every later scan) — a reset flow keeps working, see the reset test above.
        expect(scanner).toMatch(/useEffect\(\(\) => \(\) => flow\.reset\(\), \[flow\]\);/);
        expect(scanner).not.toMatch(/flow\.dispose\(\)/);
    });
    it('the cards arm their buttons (UX F3)', () => {
        expect(confirmCard).toMatch(/const decide = \(fn\?: \(\) => void\) => \(e: React\.MouseEvent\) => \{ e\.stopPropagation\(\); if \(tapArmed\(card\.shownAt, Date\.now\(\), armMs\)\) fn\?\.\(\); \};/);
        for (const b of ['onCancel', 'onDeliver', 'onAuthorize']) expect(confirmCard).toContain(`onClick={decide(${b})}`);
        expect(confirmCard).toMatch(/armMs = TAP_ARM_MS/);
        expect(verdictCard).toMatch(/const tapOk = \(\) => tapArmed\(shownAt, Date\.now\(\), armMs\);/);
        expect(verdictCard).toMatch(/onClick=\{\(\) => \{ if \(!armed && tapOk\(\)\) onDismiss\?\.\(\); \}\}/);
        expect(verdictCard).toMatch(/if \(tapOk\(\)\) onUndo\(v\.delivery_id, outcome\);/);
        expect(verdictCard).toMatch(/if \(tapOk\(\)\) setArmed\(true\);/);
        expect(verdictCard).toMatch(/armMs = 0/);
        expect(verdictCard).toMatch(/<PersonFields fields=\{rest\} large=\{large\} onColour=\{tone !== 'warn'\} \/>/);
    });
    it('«Entrega»: queue ON; Enter (keydown) answers the card only when armed; Esc cancels; a pick replaces; OFF = the immediate run()', () => {
        expect(tab).toMatch(/queue: true,/);
        // Enter is read on keydown (repeat + the previous key), the form submit is only a fallback.
        expect(tab).toMatch(/onKeyDown=\{onScanKey\}/);
        expect(tab).toMatch(/const prev = lastKeyAt\.current;\s+lastKeyAt\.current = at;\s+if \(e\.key !== 'Enter'\) return;\s+e\.preventDefault\(\);\s+submit\(\{ now: at, lastKeyAt: prev, repeat: e\.repeat \}\);/);
        expect(tab).toMatch(/<form noValidate onSubmit=\{\(e\) => \{ e\.preventDefault\(\); submit\(\); \}\}/);
        expect(tab).toMatch(/const a = cardKeyAction\('Enter', keyTarget\(st\), raw, \{ now: key\?\.now \?\? Date\.now\(\), lastKeyAt: key \? key\.lastKeyAt : lastKeyAt\.current, repeat: !!key\?\.repeat, shownAt: st\.card \? st\.card\.shownAt : st\.heldAt \}\);\s+if \(a === 'deliver'\) \{ flow\.deliver\(\); return; \}\s+if \(a === 'close'\) \{ ack\(\); return; \}/);
        expect(tab).toMatch(/const keyTarget = \(st: any\) => \(st\.card \? st\.card\.result : st\.held \? 'held' : null\);/);
        expect(tab).toMatch(/const a = cardKeyAction\('Escape', keyTarget\(f\.state\(\)\), '', \{ now: Date\.now\(\), repeat: e\.repeat \}\);\s+if \(a === 'cancel'\) \{ e\.preventDefault\(\); f\.cancel\(\); \}\s+else if \(a === 'close'\) \{ e\.preventDefault\(\); ackRef\.current\(\); \}/);
        expect(tab).toMatch(/if \(!confirmRef\.current\) \{ run\(body\); return; \}/);
        // Correctness F3: a person picked by name replaces the open card (flow.pick).
        expect(tab).toMatch(/const r = manual \? flow\.pick\(serviceId, body\) : flow\.scan\(serviceId, body\);/);
        expect(tab).toMatch(/onPick=\{\(p\) => \{ setSearching\(false\); scanBody\(\{ inscription_id: p\.id \}, true\); \}\}/);
        // UX F1: a queued card clears the previous verdict; dismissing a held result lets the queue go on;
        // the wait is announced.
        expect(tab).toMatch(/setOutcome\(null\);\s+if \(card\.result === 'ready'\) feedback\.current\.attention\(\); else feedback\.current\.bad\(\);/);
        expect(tab).toMatch(/onDismiss=\{\(\) => \{ setOutcome\(null\); flow\.close\(\); focusInput\(\); \}\}/);
        expect(tab).toMatch(/const ack = \(\) => \{ if \(flowRef\.current\.close\(\)\) setOutcome\(null\); \};/);
        expect(tab).toMatch(/data-confirm-queue=\{confirm\.held \? 'held' : 'waiting'\}/);
        expect(tab).toMatch(/tx\('meals\.confirm\.held', /);
        expect(tab).toMatch(/armMs=\{confirmOn \? VERDICT_TAP_ARM_MS : 0\}/);
        expect(tab).toMatch(/useEffect\(\(\) => \{ flow\.reset\(\); \}, \[serviceId, confirmOn, flow\]\);/);
        expect(tab).toMatch(/<ConfirmToggle on=\{confirmOn\}/);
        // The configuration is offered to Alimentación › gestionar only.
        expect(tab).toMatch(/\{canPlanEdit && \(\s+<button[^>]*onClick=\{\(\) => setDisplayOpen\(true\)\}/);
        expect(tab).toMatch(/\{displayOpen && canPlanEdit && <DisplayFieldsDialog/);
        // While the dialog is open the scan input never steals the focus (nor, with a decision on screen, scrolls it away).
        expect(tab).toMatch(/!displayOpenRef\.current && alive\.current\) inputRef\.current\?\.focus\(slotKeyRef\.current \? \{ preventScroll: true \} : undefined\)/);
    });
    it('the dialog is the Overlay-based Modal with touch-sized, always-visible up/down buttons and an inert preview', () => {
        const dlg = page.slice(page.indexOf('function DisplayFieldsDialog('), page.indexOf('// 4. REPORTE'));
        expect(dlg).toMatch(/<Modal wide title=/);
        expect(dlg).toMatch(/const arrow = 'w-11 h-11 /);
        expect(dlg).not.toMatch(/group-hover|hover:opacity|opacity-0/);
        expect(dlg).toMatch(/moveDisplayKey\(s, f\.key, -1\)/);
        expect(dlg).toMatch(/moveDisplayKey\(s, f\.key, 1\)/);
        expect(dlg).toMatch(/<div data-display-preview="" inert>/);
        expect(dlg).toMatch(/conferenceApi\.setMealDisplayFields\(conferenceId, keys\)/);
        expect(page).toMatch(/function Modal\([^)]*\) \{[\s\S]*?<Overlay layer=\{2\}/);
        // UX F10: «Restablecer» only fills the form; «Guardar» saves (null when it is the default).
        expect(dlg).toMatch(/onClick=\{\(\) => setSelected\(withName\(d\?\.default_keys \|\| DEFAULT_DISPLAY_KEYS\)\)\} data-display-reset=""/);
        expect(dlg).toMatch(/onClick=\{\(\) => save\(displaySaveKeys\(selected, d\?\.default_keys\)\)\}/);
        expect(dlg).not.toMatch(/save\(null\)/);
        // UX F11: the name ticked, locked and never moved.
        expect(dlg).toMatch(/setSelected\(withName\(r\.keys \|\| \[\]\)\)/);
        expect(dlg).toMatch(/checked=\{f\.on\} disabled=\{f\.locked\}/);
        expect(dlg).toMatch(/\{f\.on && !f\.locked && <>/);
        expect(dlg).toMatch(/disabled=\{!canMoveDisplayKey\(selected, f\.key, -1\)\}/);
        expect(dlg).toMatch(/disabled=\{!canMoveDisplayKey\(selected, f\.key, 1\)\}/);
        // Correctness F2: the honest note is on screen.
        expect(dlg).toMatch(/data-display-note="">\{tx\('meals\.display\.note', /);
    });
});

// ── Live round (2.16.0): the decision is always in view; the counter tiles fit their words ──────────────
/**
 * Found live in «Entrega» (real Chromium, the real plugin behind the real admin page): at 1280×800 the
 * confirmation card opened at y≈771 — below the fold — and nothing scrolled it into view (1440×900: only the
 * meal band showed); a USB-wedge operator would have confirmed blind. And the «Entrega» panel's counter tiles
 * (71 px wide at 1280×800) spilled «ENTREGADOS» into «Con derecho». After the fix the same harness measured
 * the checking card, the card (meal, name AND buttons) and a held verdict whole in view at 1280×800,
 * 1366×768, 1440×900, 1536×864, 1920×1080, 1024×768, 768×1024, 412×740, 390×664 and 375×667, and no counter
 * label leaving its tile or splitting a word from 320 to 1920 px, in es / en / pt. Pinned here: the pieces.
 */
describe('«Entrega»: the decision is always in view (live round)', () => {
    /** A fake chain: the slot → the plugin's scroller (clips; the measured 1280×800 band 191..776) → the page. */
    function dom(o: { inner?: number; scroller?: { top: number; bottom: number }; essentials?: number[]; scroll?: boolean; scrollThrows?: boolean; reduce?: boolean; vv?: { offsetTop: number; height: number } | null; mmThrows?: boolean } = {}) {
        const calls: any[] = [];
        const props = new Map<string, string>();
        const page: any = { getBoundingClientRect: () => ({ top: 0, bottom: 2400 }), parentElement: null, overflowY: 'visible' };
        const scroller: any = { getBoundingClientRect: () => o.scroller || { top: 191, bottom: 776 }, parentElement: page, overflowY: 'auto' };
        const parts: Record<string, number> = o.essentials ? { '[data-confirm-meal]': o.essentials[0], '[data-confirm-head]': o.essentials[1], '[data-confirm-actions]': o.essentials[2] } : {};
        const el: any = {
            getBoundingClientRect: () => ({ top: 771, bottom: 1112 }),
            parentElement: scroller,
            querySelector: (s: string) => (parts[s] != null ? { getBoundingClientRect: () => ({ height: parts[s] }) } : null),
            style: { setProperty: (k: string, v: string) => { props.set(k, v); } },
        };
        if (o.scroll !== false) el.scrollIntoView = (arg: any) => { if (o.scrollThrows) throw new Error('old engine'); calls.push(arg); };
        const win: any = {
            innerHeight: o.inner ?? 800,
            visualViewport: o.vv ?? null,
            getComputedStyle: (a: any) => ({ overflowY: a.overflowY }),
            matchMedia: (q: string) => { if (o.mmThrows) throw new Error('no matchMedia'); return { matches: !!o.reduce && q === '(prefers-reduced-motion: reduce)' }; },
        };
        return { el, win, calls, props };
    }

    it('decisionSlotKey: a new key exactly when something new appears — a result also with the confirmation OFF', () => {
        expect(decisionSlotKey({ confirmOn: true })).toBeNull();
        expect(decisionSlotKey({ confirmOn: true, checking: true })).toBe('checking');
        expect(decisionSlotKey({ confirmOn: true, card: { seq: 3 } })).toBe('card:3');
        // The open card wins over a stale result; a re-render keeps the key, the next scan changes it.
        expect(decisionSlotKey({ confirmOn: true, card: { seq: 3 }, checking: true, outcome: { seq: 9 } })).toBe('card:3');
        expect(decisionSlotKey({ confirmOn: true, card: { seq: 4 } })).not.toBe(decisionSlotKey({ confirmOn: true, card: { seq: 3 } }));
        // A delivery's result, and again when it starts holding the queue.
        expect(decisionSlotKey({ confirmOn: true, outcome: { seq: 9 } })).toBe('result:9');
        expect(decisionSlotKey({ confirmOn: true, outcome: { seq: 9 }, held: true })).toBe('result:9:held');
        // OFF (a USB wedge delivers at once): every verdict is capped and brought into view too, a new key per delivery
        // (2.17.0 live round: F0 «Sin derecho», Y1 «Entregado», Y2 «Ya recibió» opened below the fold, uncapped).
        expect(decisionSlotKey({ confirmOn: false, outcome: { seq: 9 } })).toBe('result:9');
        expect(decisionSlotKey({ confirmOn: false, outcome: { seq: 10 } })).toBe('result:10');
        // Nothing holds a queue with the confirmation OFF; no card, no check of its own (a stale one never counts).
        expect(decisionSlotKey({ confirmOn: false, outcome: { seq: 9 }, held: true })).toBe('result:9');
        expect(decisionSlotKey({ confirmOn: false, card: { seq: 3 }, checking: true })).toBeNull();
        expect(decisionSlotKey({ confirmOn: false, card: { seq: 3 }, checking: true, outcome: { seq: 9 } })).toBe('result:9');
        expect(decisionSlotKey({ confirmOn: false })).toBeNull();
    });

    it('revealSlot: caps the card to the visible band, then scrolls the NEAREST edge into view — smooth, instant under reduced motion', () => {
        const a = dom();
        expect(revealSlot(a.el, a.win)).toBe(true);
        expect(a.calls).toEqual([{ block: 'nearest', inline: 'nearest', behavior: 'smooth' }]);
        // 1280×800: the plugin's scroller shows 191..776 → the card may be 585 − 2 × 12 px tall.
        expect(REVEAL_FIT_VAR).toBe('--cm-fit');
        expect(a.props.get(REVEAL_FIT_VAR)).toBe(`${585 - 2 * REVEAL_MARGIN_PX}px`);
        const r = dom({ reduce: true });
        expect(revealSlot(r.el, r.win)).toBe(true);
        expect(r.calls).toEqual([{ block: 'nearest', inline: 'nearest', behavior: 'auto' }]);
        // A matchMedia that throws (an old engine): still revealed.
        const old = dom({ mmThrows: true });
        expect(revealSlot(old.el, old.win)).toBe(true);
        expect(old.calls).toEqual([{ block: 'nearest', inline: 'nearest', behavior: 'smooth' }]);
        expect(prefersReducedMotion(null)).toBe(false);
        expect(prefersReducedMotion(r.win)).toBe(true);
    });

    it('revealSlot never throws: no slot, no window, no scrollIntoView, a throwing one', () => {
        const a = dom();
        expect(revealSlot(null, a.win)).toBe(false);
        expect(revealSlot(undefined, a.win)).toBe(false);
        expect(revealSlot(a.el, null)).toBe(false);
        expect(a.calls).toEqual([]);
        const none = dom({ scroll: false });
        expect(revealSlot(none.el, none.win)).toBe(false);
        expect(none.props.get(REVEAL_FIT_VAR)).toBe('561px');     // the cap still applies
        const bad = dom({ scrollThrows: true });
        expect(revealSlot(bad.el, bad.win)).toBe(false);
    });

    it('visibleBand: the visual viewport (an on-screen keyboard), clipped by every ancestor that clips', () => {
        const a = dom();
        expect(visibleBand(a.el, a.win)).toEqual({ top: 191, bottom: 776 });
        const kb = dom({ vv: { offsetTop: 0, height: 400 } });
        expect(visibleBand(kb.el, kb.win)).toEqual({ top: 191, bottom: 400 });
        const short = dom({ inner: 700 });
        expect(visibleBand(short.el, short.win)).toEqual({ top: 191, bottom: 700 });
    });

    it('the card is capped only while its essentials (meal, status + name, buttons) fit — the margins give way first; else its top shows', () => {
        // Measured on phones: meal band 62 + status/name header 107 + buttons 124 (+ 6 of borders) = 299.
        expect(cardEssentials(dom({ essentials: [62, 107, 124] }).el)).toBe(299);
        expect(cardEssentials(dom().el)).toBe(0);
        expect(fitHeight({ top: 318, bottom: 643 }, 299)).toBe(301);   // 375×667: room for the margins
        expect(fitHeight({ top: 318, bottom: 640 }, 299)).toBe(299);   // 390×664: the margins give way
        expect(fitHeight({ top: 350, bottom: 544 }, 299)).toBeNull();  // 320×568 (194 px): no cap
        expect(fitHeight({ top: 0, bottom: 10 })).toBeNull();
        const tight = dom({ scroller: { top: 350, bottom: 544 }, essentials: [62, 107, 124] });
        expect(revealSlot(tight.el, tight.win)).toBe(true);
        expect(tight.props.get(REVEAL_FIT_VAR)).toBe('none');          // its top (meal, status, name) comes into view
        const phone = dom({ scroller: { top: 318, bottom: 640 }, essentials: [62, 107, 124] });
        revealSlot(phone.el, phone.win);
        expect(phone.props.get(REVEAL_FIT_VAR)).toBe('299px');
        // The card shrinks inside the cap: a flex column whose middle scrolls (pinned with the short phone above).
        expect(render(<ConfirmCard card={{ seq: 1, serviceId: 7, body: { code: 'X' }, result: 'ready', verdict: { person: { id: 1, name: 'Ana Pérez' } } }} />))
            .toMatch(/data-confirm-card="ready"[^>]*style="[^"]*display:flex;flex-direction:column;max-height:100%;min-height:0;scroll-margin-top:12px;scroll-margin-bottom:12px"/);
    });

    it('the essentials hold the WHOLE name: measured while a cap squeezes it (2.17.0: the name gives way last, scrolling inside its header), its hidden lines count', () => {
        const parts: Record<string, any> = {
            '[data-confirm-meal]': { getBoundingClientRect: () => ({ height: 62 }) },
            '[data-confirm-head]': { getBoundingClientRect: () => ({ height: 80 }) },
            '[data-confirm-actions]': { getBoundingClientRect: () => ({ height: 124 }) },
            '[data-confirm-name]': { getBoundingClientRect: () => ({ height: 30 }), scrollHeight: 57, clientHeight: 30 },
        };
        const el: any = { getBoundingClientRect: () => ({ top: 0, bottom: 0 }), parentElement: null, querySelector: (sel: string) => parts[sel] || null };
        expect(cardEssentials(el)).toBe(62 + 80 + 124 + 27 + 6);
        // Not squeezed: the parts alone.
        parts['[data-confirm-name]'].scrollHeight = 30;
        expect(cardEssentials(el)).toBe(62 + 80 + 124 + 6);
        // No name (an informative card), or a node that throws: the parts alone, never a throw.
        delete parts['[data-confirm-name]'];
        expect(cardEssentials(el)).toBe(62 + 80 + 124 + 6);
        const throwing: any = { ...el, querySelector: (sel: string) => { if (sel === '[data-confirm-name]') throw new Error('detached'); return parts[sel] || null; } };
        expect(cardEssentials(throwing)).toBe(62 + 80 + 124 + 6);
    });

    it('wiring (source): «Entrega» reveals its slot on every new key (layout effect, the next frame, resize), caps the card, and taking the focus back never scrolls it away', () => {
        const page = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/MealsPage.tsx'), 'utf8');
        const tab = page.slice(page.indexOf('function DeliveryTab('), page.indexOf('function DisplayFieldsDialog('));
        expect(tab).toMatch(/const slotKey = decisionSlotKey\(\{ confirmOn, card: confirm\.card, checking: confirm\.checking, outcome, held: confirm\.held \}\);\s+slotKeyRef\.current = slotKey;/);
        // Before paint — and once more on the next frame, when the card has settled: 2.17.0 live round (the confirmation
        // OFF, 320×460), «Ya recibió» replacing «Entregado» re-measured its details AFTER this effect and grew from 285
        // to 358 px, ending 50 px under the fold. Cancelled with the key; resize as before.
        expect(tab).toMatch(/useLayoutEffect\(\(\) => \{\s+(\/\/[^\n]*\s+)?if \(!slotKey\) \{ slotRef\.current\?\.style\.removeProperty\(REVEAL_FIT_VAR\); return; \}\s+const reveal = \(\) => \{ revealSlot\(slotRef\.current, window\); \};\s+reveal\(\);\s+const frame = typeof window\.requestAnimationFrame === 'function' \? window\.requestAnimationFrame\(reveal\) : null;\s+window\.addEventListener\('resize', reveal\);\s+return \(\) => \{ if \(frame != null\) window\.cancelAnimationFrame\(frame\); window\.removeEventListener\('resize', reveal\); \};\s+\}, \[slotKey\]\);/);
        expect(tab).toMatch(/<div className="min-h-\[96px\]" ref=\{slotRef\} data-decision-slot="" style=\{\{ scrollMarginTop: REVEAL_MARGIN_PX, scrollMarginBottom: REVEAL_MARGIN_PX \}\}>/);
        expect(tab).toMatch(/\? <div data-confirm-fit="" style=\{\{ display: 'flex', flexDirection: 'column', maxHeight: `var\(\$\{REVEAL_FIT_VAR\}, none\)` \}\}>\s+<ConfirmCard card=\{confirm\.card\}/);
        expect(tab).toMatch(/inputRef\.current\?\.focus\(slotKeyRef\.current \? \{ preventScroll: true \} : undefined\)/);
        // The checking card, the result and the queue line live in that same slot.
        const slot = tab.slice(tab.indexOf('data-decision-slot'));
        const end = slot.indexOf("tx('meals.confirm.held'");
        expect(end).toBeGreaterThan(0);
        expect(slot.slice(0, end)).toMatch(/<CheckingCard \/>[\s\S]*<VerdictCard [\s\S]*data-confirm-queue=/);
        expect(page).toMatch(/import React, \{ useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState \} from "react";/);
    });
});

describe('counter tiles fit their words at every width (Counters, live round)', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/MealsPage.tsx'), 'utf8');
    const tab = page.slice(page.indexOf('function DeliveryTab('), page.indexOf('function DisplayFieldsDialog('));

    it('one tile per row by default; side by side only from a grid width that leaves every tile 8.5rem', () => {
        // The widest label word measured (Arial fallback, 9 px black, 0.1em): «(AUTORIZADOS)» 91.6 px + 34 px of padding and border.
        expect(COUNTER_TILE_MIN_REM * 16).toBeGreaterThanOrEqual(91.6 + 34);
        expect(countersFitRem(3, 8)).toBe(26.5);
        expect(countersFitRem(3, 12)).toBe(27);
        const css = countersCss(3, 8);
        expect(css).toContain('[data-cm-counters="3-8"]{container:cm-counters / inline-size}');
        expect(css).toContain('[data-cm-counters="3-8"]>[data-counter-grid]{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}');
        // One per row: the label on the left (wraps between words; inside one only as a last resort), the number on the right.
        expect(css).toContain('[data-cm-counters="3-8"] [data-counter]{display:flex;align-items:center;justify-content:space-between;column-gap:12px;min-width:0}');
        expect(css).toContain('[data-cm-counters="3-8"] [data-counter-label]{min-width:0;overflow-wrap:break-word}');
        expect(css).toContain('@container cm-counters (min-width:26.5rem){[data-cm-counters="3-8"]>[data-counter-grid]{grid-template-columns:repeat(3,minmax(0,1fr))}[data-cm-counters="3-8"] [data-counter]{display:block}');
        expect(css.match(/@container/g)).toHaveLength(1);
        expect(css.split('\n').filter((l) => !l.startsWith('@container')).join('\n')).not.toMatch(/repeat\(/);
        // Four tiles: 4 → 2 → 1 per row.
        const four = countersCss(4, 12);
        expect(four).toContain('@container cm-counters (min-width:17.75rem){[data-cm-counters="4-12"]>[data-counter-grid]{grid-template-columns:repeat(2,minmax(0,1fr))}');
        expect(four).toContain('@container cm-counters (min-width:36.25rem){[data-cm-counters="4-12"]>[data-counter-grid]{grid-template-columns:repeat(4,minmax(0,1fr))}');
    });

    it('renders the scoped grid with its own rules; no fixed column count, nothing truncated', () => {
        const html = render(<Counters cols={3} gap={8}><Counter label="Entregados" value={3} tone="text-emerald-600" /><Counter label="Con derecho" value={5} /><Counter label="Pendientes" value={2} /></Counters>);
        expect(html).toMatch(/^<div data-cm-counters="3-8"><div data-counter-grid="">/);
        expect(html.match(/data-counter=""/g)).toHaveLength(3);
        expect(html).toMatch(/<div data-counter-label="" class="[^"]*uppercase[^"]*">Entregados<\/div><div data-counter-value="" class="[^"]*text-emerald-600">3<\/div>/);
        expect(html).toContain(`<style>${countersCss(3, 8)}</style>`);
        expect(html).not.toMatch(/grid-cols-|truncate|whitespace-nowrap|text-ellipsis/);
    });

    it('every counter label word in es / en / pt is within the measured budget (≤ 13 characters, «(AUTORIZADOS)»)', () => {
        const keys = ['meals.count.services', 'meals.count.entitled.all', 'meals.count.delivered.all', 'meals.count.delivered', 'meals.count.entitled', 'meals.count.pending', 'meals.count.overrides.short'];
        for (const lang of ['es', 'en', 'pt'] as const) {
            for (const k of keys) {
                const label = (translations as any)[lang][k];
                expect(label, `${lang} ${k}`).toBeTruthy();
                for (const w of String(label).split(/\s+/)) expect(w.length, `${lang} ${k} «${w}»`).toBeLessThanOrEqual(13);
            }
        }
    });

    it('wiring (source): every Counter of the page sits in a Counters grid — header, «Entrega» panel, «Reporte»', () => {
        expect(page).toMatch(/import \{ Counter, Counters \} from "\.\/Counters";/);
        expect(page).not.toMatch(/const Counter = /);
        expect(page).toMatch(/<Counters cols=\{3\} gap=\{12\} className="relative mt-6">(\s+<Counter [^\n]+){3}\s+<\/Counters>/);
        expect(tab).toMatch(/<Counters cols=\{3\} gap=\{8\}>(\s+<Counter [^\n]+){3}\s+<\/Counters>/);
        expect(page).toMatch(/<Counters cols=\{4\} gap=\{12\}>(\s+<Counter [^\n]+){4}\s+<\/Counters>/);
        expect(page.match(/<Counter /g)).toHaveLength(10);
        expect(page).not.toMatch(/grid-cols-\d[^"]*">\s+<Counter /);
    });
});

describe('2.17.0 live round at 320×460: «Entrega»\'s buttons fit its card; the meal tapped open is WHOLE; «Entrega»\'s verdict is capped', () => {
    const SRC = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/MealScanner.tsx'), 'utf8');
    const PAGE_SRC = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/MealsPage.tsx'), 'utf8');
    const tab = PAGE_SRC.slice(PAGE_SRC.indexOf('function DeliveryTab('), PAGE_SRC.indexOf('function DisplayFieldsDialog('));
    const styleOf = (html: string, attr: string) => { const i = html.indexOf(attr); expect(i, attr).toBeGreaterThan(-1); const tag = html.slice(html.lastIndexOf('<', i), html.indexOf('>', i) + 1); return /style="([^"]*)"/.exec(tag)?.[1] || ''; };

    it('«Entrega»\'s confirmation card on a narrow phone: «Cancelar» + «Entregar» (or «Autorizar») side by side INSIDE the card; the row wraps rather than cut a button', () => {
        // Live round: in a 214 px card (320 px phone, the tab's paddings) «Entregar» ran 28 px past the card's right
        // edge and was cut by it («Entrega»); «Cancelar» of the not-entitled card 8 px. Measured since (Inter 900):
        // at 14 px with 8 px paddings «Cancelar» 79.4 + 6 + «✓ Entregar» 95.2 = 180.6 ≤ 190 (214 − 2 × 12).
        const narrow = CONFIRM_CSS.slice(CONFIRM_CSS.lastIndexOf('@media (max-width: 380px) {'));
        for (const rule of [
            '[data-confirm-card]:not([data-confirm-large]) [data-confirm-meal] { padding-left: 12px !important; padding-right: 12px !important; }',
            '[data-confirm-card]:not([data-confirm-large]) [data-confirm-head] { padding-left: 12px !important; padding-right: 12px !important; }',
            '[data-confirm-card]:not([data-confirm-large]) [data-confirm-body] { padding-left: 12px !important; padding-right: 12px !important; }',
            '[data-confirm-card]:not([data-confirm-large]) [data-confirm-actions] { gap: 6px !important; padding-left: 12px !important; padding-right: 12px !important; }',
            '[data-confirm-card]:not([data-confirm-large]) [data-confirm-actions] button { padding-left: 8px !important; padding-right: 8px !important; gap: 6px !important; font-size: 14px !important; }',
            '[data-confirm-card]:not([data-confirm-large]) [data-confirm-actions] button[data-long-label] { font-size: 13px !important; }',
        ]) expect(narrow, rule).toContain(rule);
        // Only «Entrega»'s card (the phone scanner's has the camera area's width).
        for (const sel of narrow.match(/^\s*\[data-confirm-card\][^{]*/gm) || []) expect(sel, sel).toContain(':not([data-confirm-large])');
        // Whatever the language or the font: the row wraps, a button is never cut (44 px targets stay: 52 px).
        for (const r of ['ready', 'not_entitled', 'already'] as const) {
            const html = render(<ConfirmCard card={card(r)} />);
            expect(styleOf(html, 'data-confirm-actions=""'), r).toBe('display:flex;flex-wrap:wrap;gap:8px;padding:0 14px 14px;flex-shrink:0');
            expect(html.match(/<button [^>]*style="[^"]*min-height:52px/g)?.length, r).toBeGreaterThan(0);
        }
        expect(styleOf(render(<ConfirmCard card={card('ready')} large />), 'data-confirm-actions=""')).toBe('display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 16px;flex-shrink:0');
        // «Registrando…» (a moment, a longer word) shrinks its button with «…» instead of pushing «Cancelar» to a
        // second row; the whole word stays its text. At rest both keep their words whole (no min-width:0).
        const busy = render(<ConfirmCard card={card('ready')} delivering />);
        expect(styleOf(busy, 'data-confirm-deliver=""')).toMatch(/;min-width:0$/);
        expect(busy).toMatch(/data-confirm-deliver=""[^>]*><i class="fa-solid fa-check" aria-hidden="true"><\/i><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Registrando…<\/span><\/button>/);
        expect(styleOf(render(<ConfirmCard card={card('ready')} />), 'data-confirm-deliver=""')).not.toMatch(/min-width/);
        const busyNe = render(<ConfirmCard card={card('not_entitled')} delivering />);
        expect(styleOf(busyNe, 'data-confirm-authorize=""')).toMatch(/;min-width:0$/);
        expect(busyNe).toMatch(/aria-label="Registrando…"><i class="fa-solid fa-hand" aria-hidden="true"><\/i><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Registrando…<\/span><\/button>/);
        expect(BUTTON_SHRINKS).toEqual({ minWidth: 0 });
        expect(BUTTON_LABEL_FIT).toEqual({ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    });

    it('openMealCut: whole when nothing lacks room; else up to the last whole line that fits with «Más abajo»; 0 (close) when not one does', () => {
        const lines = [20, 40, 60];
        // Nothing lacks room (2 px is rounding): whole.
        expect(openMealCut(lines, 60, 0, false)).toBeNull();
        expect(openMealCut(lines, 60, 2, false)).toBeNull();
        // The name lacks 15 px: 60 − 15 − the cue's 20 = 25 → one line.
        expect(openMealCut(lines, 60, 15, false)).toBe(20);
        expect(MORE_CUE_PX).toBe(20);
        // The cue already under it: its room is not taken twice.
        expect(openMealCut(lines, 40, 3, true)).toBe(20);
        // A cue that takes no room (the confirmation card's band: at the end of the day's line).
        expect(openMealCut(lines, 60, 15, false, 0)).toBe(40);
        // The last px of a line is rounding.
        expect(openMealCut(lines, 60, 19, false)).toBe(20);
        expect(openMealCut(lines, 60, 21, false, 0)).toBe(40);
        expect(openMealCut(lines, 60, 22, false, 0)).toBe(20);
        // Not one line: 0 (it closes again — the name always wins).
        expect(openMealCut(lines, 60, 50, false)).toBe(0);
        expect(openMealCut([], 60, 10, false)).toBe(0);
        // Every cut is shorter than what was shown (it converges).
        for (let over = 3; over < 60; over++) for (const cue of [true, false]) {
            const cut = openMealCut(lines, 60, over, cue)!;
            expect(cut, `${over} ${cue}`).toBeLessThan(60);
        }
    });

    it('textLineBottoms: each LINE of the meal (its icon and spans merged), un-scaled and scrolled; between two lines whose glyph boxes overlap; never a throw', () => {
        // The card's entry animation draws it at 0.95 from y 300; three lines at line-height 1.1 (19.8 px) whose glyph
        // boxes (21 px) overlap: the icon and two spans on line 1.
        const scale = 0.95, top = 300;
        const at = (t: number, b: number) => ({ top: top + t * scale, bottom: top + b * scale, height: (b - t) * scale });
        const rects = [at(1, 19), at(-1, 20), at(-1, 20), at(18.8, 39.8), at(38.6, 59.6), { top: top, bottom: top, height: 0 }];
        const el: any = {
            offsetHeight: 60, scrollTop: 0, getBoundingClientRect: () => ({ top, height: 60 * scale }),
            ownerDocument: { createRange: () => ({ selectNodeContents() { }, getClientRects: () => rects }) },
        };
        expect(textLineBottoms(el)).toEqual([20, 40, 60]);
        // Scrolled by 20 (its content drawn 20 px higher): the same layout positions.
        const scrolled: any = { ...el, scrollTop: 20, ownerDocument: { createRange: () => ({ selectNodeContents() { }, getClientRects: () => rects.map((r) => ({ ...r, top: r.top - 20 * scale, bottom: r.bottom - 20 * scale })) }) } };
        expect(textLineBottoms(scrolled)).toEqual([20, 40, 60]);
        // Measured in Chromium (the confirmation card's band, 26 px at line-height 1.1 = 28.6 px lines): the glyph
        // boxes are 31 px tall, so each overlaps the next by 2.4 px — the cut goes on the line boxes' edge (28, 57),
        // not on a glyph box's bottom (29, 58: the top of the next line's accents would show).
        const big: any = { ...el, offsetHeight: 86, getBoundingClientRect: () => ({ top, height: 86 }), ownerDocument: { createRange: () => ({ selectNodeContents() { }, getClientRects: () => [[1, 27], [-2, 29], [26.6, 57.6], [55.2, 86.2]].map(([t, b]) => ({ top: top + t, bottom: top + b, height: b - t })) }) } };
        expect(textLineBottoms(big)).toEqual([28, 57, 87]);
        // Lines that do not overlap: their own bottoms.
        const apart: any = { ...el, ownerDocument: { createRange: () => ({ selectNodeContents() { }, getClientRects: () => [at(0, 18), at(24, 42)] }) } };
        expect(textLineBottoms(apart)).toEqual([18, 42]);
        // No layout, no Range, a throw: no lines (nothing is cut).
        expect(textLineBottoms({ ...el, offsetHeight: 0 })).toEqual([]);
        expect(textLineBottoms({ ...el, ownerDocument: {} })).toEqual([]);
        expect(textLineBottoms({ getBoundingClientRect: () => { throw new Error('detached'); } })).toEqual([]);
    });

    it('useOpenMeal: whole on a tap; cut on a whole line with «Más abajo» only while the card lacks room; closed when not one line fits; a new card / another window size: whole again', () => {
        const hook = SRC.slice(SRC.indexOf('export function useOpenMeal('), SRC.indexOf('/** The open meal line as it is shown'));
        expect(hook).toMatch(/useLayoutEffect\(\(\) => \{ setOpen\(false\); \}, \[key\]\);/);
        expect(hook).toMatch(/useLayoutEffect\(\(\) => \{ setCap\(null\); setAtEnd\(false\); \}, \[key, open\]\);/);
        expect(hook).toMatch(/const cut = openMealCut\(textLineBottoms\(el\), el\.clientHeight, over\(\), cap != null, cuePx\);\s+if \(cut == null\) return;\s+if \(cut > 0\) setCap\(cut\); else setOpen\(false\);/);
        expect(hook).toMatch(/const refit = \(\) => \{ setCap\(null\); setAtEnd\(false\); \};\s+window\.addEventListener\('resize', refit\);/);
        expect(hook).toMatch(/export function useOpenMeal\(key: unknown, over: \(\) => number, cuePx = MORE_CUE_PX\)/);
        // The confirmation card's band: «Más abajo» at the end of the day's line, no room of its own (on a 320×460
        // phone a line of its own decided between one line of the meal and none) — floated right of the day (block
        // layout), or after it in the band's wrapping row with the meal next (`order`).
        expect(CONFIRM_MEAL_MORE_STYLE).toEqual({ float: 'right', order: 1, marginLeft: 'auto', height: 16, lineHeight: '16px', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase' });
        expect(render(<MoreCue attr="data-confirm-meal-more" style={CONFIRM_MEAL_MORE_STYLE} />)).toMatch(/^<div data-confirm-meal-more="" aria-hidden="true" style="flex-shrink:0;height:16px;line-height:16px;overflow:hidden;white-space:nowrap;font-weight:900;float:right;order:1;margin-left:auto;font-size:11px;letter-spacing:0.08em;text-transform:uppercase">Más abajo /);
        // «Entrega» (not large): the card made taller by the open meal is brought back into view, buttons included
        // (both cards; the phone scanner's sits in a fixed slot).
        expect(SRC.match(/useEffect\(\(\) => \{ if \(mealOpen && !large && typeof window !== 'undefined'\) revealNearest\(cardRef\.current, window\); \}, \[mealOpen, meal\.cap, large\]\);/g)).toHaveLength(2);
        // Closed (the server render): no cut, no cue.
        const html = render(<ConfirmCard card={card('ready')} large />);
        expect(html).not.toContain('data-confirm-meal-more=""');
        expect(styleOf(html, 'data-confirm-meal-name=""')).toBe('font-size:26px;font-weight:900;line-height:1.1;overflow-wrap:anywhere;order:2');
    });

    it('«Entrega» with the confirmation OFF (USB wedge): every result is capped and brought into view — a scan, a name picked, «Sí, entregar»', () => {
        // Live round (the confirmation OFF): F0 «Sin derecho» right after the wedge opened with «Entregar de todas
        // formas» at y 1029 of 460 (desktop: the card at y 771 of 800); Y1 «Entregado» with «Deshacer» at y 826 of 460
        // (desktop y 1108); Y2 «Ya recibió» with the name below the fold. decisionSlotKey returned null for them: no cap,
        // no scroll. Only the force two-step was revealed (`inSlot`); now every result is, so that flag is gone.
        for (const seq of [1, 2, 3]) expect(decisionSlotKey({ confirmOn: false, outcome: { seq } })).toBe(`result:${seq}`);
        expect(tab).toMatch(/const run = \(body: any\) => \{/);
        expect(tab).toMatch(/await showOutcome\(o, sid\);/);
        expect(tab).toMatch(/run\(\{ inscription_id: p\.id, force: true, note: tx\('meals\.force\.note\.kitchen', 'Autorizado en la entrega'\) \}\);/);
        expect(tab).not.toMatch(/inSlot/);
        // A scan and a name picked with the confirmation OFF go through `run` — the same slot key, reveal and cap.
        expect(tab).toMatch(/if \(!confirmRef\.current\) \{ run\(body\); return; \}/);
        expect(tab).toMatch(/const slotKey = decisionSlotKey\(\{ confirmOn, card: confirm\.card, checking: confirm\.checking, outcome, held: confirm\.held \}\);/);
        // The verdict sits in the capped wrapper whichever way it was recorded.
        expect(tab).toMatch(/: outcome\s+(\/\/[^\n]*\n\s*)*\? <div data-verdict-fit="" style=\{\{ display: 'flex', flexDirection: 'column', maxHeight: `var\(\$\{REVEAL_FIT_VAR\}, none\)` \}\}>/);
        // Taking the focus back (the wedge keeps typing) never scrolls the revealed result away.
        expect(tab).toMatch(/inputRef\.current\?\.focus\(slotKeyRef\.current \? \{ preventScroll: true \} : undefined\)/);
        // Nothing to reveal: no cap either — never one left from an earlier card.
        expect(tab).toMatch(/if \(!slotKey\) \{ slotRef\.current\?\.style\.removeProperty\(REVEAL_FIT_VAR\); return; \}/);
    });

    it('cardEssentials of «Entrega»\'s verdict card: all of it but the part that gives way, its hidden name lines counted', () => {
        const parts: Record<string, any> = {
            '[data-verdict]': { getBoundingClientRect: () => ({ height: 500 }) },
            '[data-verdict-scroll]': { getBoundingClientRect: () => ({ height: 200 }) },
            '[data-verdict-more]': { getBoundingClientRect: () => ({ height: 20 }) },
            '[data-verdict-name]': { getBoundingClientRect: () => ({ height: 50 }), scrollHeight: 80, clientHeight: 50 },
        };
        const el: any = { getBoundingClientRect: () => ({ top: 0, bottom: 0 }), parentElement: null, querySelector: (sel: string) => parts[sel] || null };
        expect(cardEssentials(el)).toBe(500 - 200 - 20 + 30);
        // Not squeezed, no cut: the card less the part that gives way.
        parts['[data-verdict-name]'].scrollHeight = 50;
        delete parts['[data-verdict-more]'];
        expect(cardEssentials(el)).toBe(300);
        // The details left out (nothing fits): the whole card.
        delete parts['[data-verdict-scroll]'];
        expect(cardEssentials(el)).toBe(500);
        // A confirmation card is measured as before.
        expect(cardEssentials({ ...el, querySelector: (s: string) => ({ '[data-confirm-meal]': 62, '[data-confirm-head]': 107, '[data-confirm-actions]': 124 } as any)[s] != null ? { getBoundingClientRect: () => ({ height: ({ '[data-confirm-meal]': 62, '[data-confirm-head]': 107, '[data-confirm-actions]': 124 } as any)[s] }) } : null })).toBe(299);
        // Live round, 320×460: the essentials (head, 5-line name, «Deshacer», paddings) ≈ 290 px fit the 359 px band,
        // so the card is capped and its other data scroll; it was 888 px tall.
        expect(fitHeight({ top: 77, bottom: 460 }, 290)).toBe(383 - 2 * REVEAL_MARGIN_PX);
    });
});

describe('2.17.0 live round (r6): «Autorizar» at every phone width; WHY there is no right to the meal never gives way', () => {
    const SRC = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/MealScanner.tsx'), 'utf8');
    const CARD_SRC = SRC.slice(SRC.indexOf('export function ConfirmCard('), SRC.indexOf('/** «Comprobando…»'));
    const tagOf = (html: string, attr: string) => { const i = html.indexOf(attr); expect(i, attr).toBeGreaterThan(-1); return html.slice(html.lastIndexOf('<', i), html.indexOf('>', i) + 1); };
    const elementOf = (html: string, attr: string) => {
        const tag = tagOf(html, attr);
        const start = html.indexOf(tag);
        const name = /^<([a-z0-9]+)/.exec(tag)![1];
        const re = new RegExp(`<${name}[\\s>]|</${name}>`, 'g');
        re.lastIndex = start + tag.length;
        let depth = 1; let m: RegExpExecArray | null;
        while (depth > 0 && (m = re.exec(html))) depth += m[0].startsWith('</') ? -1 : 1;
        return html.slice(start, re.lastIndex);
    };
    /** A laid-out label: `n` lines of 17 px (rects un-scaled, from y 500). */
    const label = (n: number, extra: any = {}) => ({
        offsetHeight: n * 17, scrollTop: 0, getBoundingClientRect: () => ({ top: 500, height: n * 17 }),
        ownerDocument: { createRange: () => ({ selectNodeContents() { }, getClientRects: () => Array.from({ length: n }, (_, i) => ({ top: 500 + i * 17, bottom: 517 + i * 17, height: 17 })) }) },
        ...extra,
    });

    it('labelTooLong: the whole label shows only while it takes at most two lines — measured, whatever the width, language or font', () => {
        // Live (r5-2): «Entregar sin derecho (autorizar)» in four lines in a 118 px button at 390×664 and 390×844 (both
        // cards), three or four at 412×915 — the media rules gave «Autorizar» only up to 380 px wide or on a short screen.
        expect(LABEL_MAX_LINES).toBe(2);
        expect(labelTooLong(label(4))).toBe(true);
        expect(labelTooLong(label(3))).toBe(true);
        expect(labelTooLong(label(2))).toBe(false);
        expect(labelTooLong(label(1))).toBe(false);
        expect(labelTooLong(label(3), 3)).toBe(false);
        // Hidden by a media rule (no layout), no Range, a throw: no lines — never too long (the CSS decides there).
        expect(labelTooLong(label(4, { offsetHeight: 0 }))).toBe(false);
        expect(labelTooLong(label(4, { ownerDocument: {} }))).toBe(false);
        expect(labelTooLong({ getBoundingClientRect: () => { throw new Error('detached'); } })).toBe(false);
    });

    it('AuthorizeLabel: the whole label (measured, the short one hidden), the short one ALONE once the whole one is too long, «Registrando…» while recording', () => {
        const whole = render(<AuthorizeLabel text="Entregar sin derecho (autorizar)" shortText="Autorizar" />);
        expect(whole).toBe('<span data-label-long="">Entregar sin derecho (autorizar)</span><span data-label-short="" style="display:none">Autorizar</span>');
        const short = render(<AuthorizeLabel text="Entregar sin derecho (autorizar)" shortText="Autorizar" short />);
        expect(short).toBe('<span data-label-short="" data-label-fit="short">Autorizar</span>');
        expect(short).not.toContain('Entregar sin derecho');
        expect(render(<AuthorizeLabel text="Registrando…" shortText="Autorizar" short delivering />)).toBe('<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Registrando…</span>');
        // The button keeps its whole accessible name, and stays the smaller one on the left (UX F6).
        const html = render(<ConfirmCard card={card('not_entitled')} large />);
        expect(tagOf(html, 'data-confirm-authorize=""')).toContain('aria-label="Entregar sin derecho (autorizar)"');
        expect(html.indexOf('data-confirm-authorize')).toBeLessThan(html.indexOf('data-confirm-cancel'));
    });

    it('useLabelFit: measured after layout and before paint; again for a new card or text, another window size, a web font loaded; the details measured again after the switch', () => {
        const hook = SRC.slice(SRC.indexOf('export function useLabelFit('), SRC.indexOf('export function AuthorizeLabel('));
        expect(hook).toMatch(/export function useLabelFit\(key: unknown, max = LABEL_MAX_LINES\)/);
        expect(hook).toMatch(/useLayoutEffect\(\(\) => \{ setShort\(false\); \}, \[key\]\);/);
        expect(hook).toMatch(/useLayoutEffect\(\(\) => \{\s+if \(short\) return;\s+const el = ref\.current;\s+if \(el && labelTooLong\(el, max\)\) setShort\(true\);\s+\}\);/);
        expect(hook).toMatch(/const refit = \(\) => setShort\(false\);/);
        expect(hook).toMatch(/window\.addEventListener\('resize', refit\);/);
        expect(hook).toMatch(/fonts\?\.addEventListener\?\.\('loadingdone', refit\)/);
        expect(hook).toMatch(/window\.removeEventListener\('resize', refit\);/);
        // The card: a new card or another text measures again; the shorter buttons leave the person's other data more
        // room — measured again (live, 412×915: cut at the old room, the bottom of the part hidden with no cue).
        expect(CARD_SRC).toMatch(/const authorizeFit = useLabelFit\(`\$\{card\?\.seq\}:\$\{card\?\.result\}:\$\{authorizeWhole\}`\);\s+const restFit = useWholeEntries\(`\$\{card\?\.seq\}:\$\{mealOpen\}:\$\{meal\.cap\}:\$\{authorizeFit\.short\}`\);/);
        expect(CARD_SRC).toMatch(/<AuthorizeLabel text=\{authorize\} shortText=\{tx\('meals\.confirm\.authorize\.short', 'Autorizar'\)\} delivering=\{delivering\} short=\{authorizeFit\.short\} labelRef=\{authorizeFit\.ref\} \/>/);
        // The media rules stay (no JS needed on a narrow or short phone).
        expect(CONFIRM_CSS).toContain('@media (max-width: 380px), (max-height: 640px) {\n  [data-confirm-card][data-confirm-large] [data-label-long] { display: none !important; }');
    });

    it('on the narrowest phones «Autorizar» keeps to one line: the hand icon gives way (both cards)', () => {
        const narrowLarge = CONFIRM_CSS.slice(CONFIRM_CSS.indexOf('@media (max-width: 380px) {'), CONFIRM_CSS.indexOf('@media (max-width: 600px) and (max-height: 640px)'));
        expect(narrowLarge).toContain('[data-confirm-card][data-confirm-large] button[data-long-label] > i { display: none; }');
        const narrowEntrega = CONFIRM_CSS.slice(CONFIRM_CSS.lastIndexOf('@media (max-width: 380px) {'));
        expect(narrowEntrega).toContain('[data-confirm-card]:not([data-confirm-large]) button[data-long-label] > i { display: none; }');
        // Only the authorize button's icon.
        expect(CONFIRM_CSS.match(/> i \{ display: none; \}/g)).toHaveLength(2);
    });

    it('WHY (not entitled): a compact line of the header, under the status — never in the part that scrolls, which is left out when nothing fits', () => {
        // Live (r5-2, 320×460): the person's other data were left out (not even one entry fits) and «No está en el plan
        // de su localidad» went with them — staff authorised without knowing why. Every taller phone showed it.
        for (const large of [true, false]) {
            for (const [source, why] of [['none', 'No está en el plan de su localidad'], ['exclude', 'Se la quitaron a esta persona']] as const) {
                const html = render(<ConfirmCard card={card('not_entitled', { source })} large={large} />);
                const head = elementOf(html, 'data-confirm-head=""');
                expect(head, `${large} ${source}`).toContain(`data-confirm-why="" style="flex-shrink:0;font-size:13px;font-weight:700;line-height:1.25;color:#92400e;overflow-wrap:anywhere">${why}</div>`);
                // Status → why → name.
                expect(head.indexOf('data-confirm-status')).toBeLessThan(head.indexOf('data-confirm-why'));
                expect(head.indexOf('data-confirm-why')).toBeLessThan(head.indexOf('data-confirm-name'));
                expect(elementOf(html, 'data-confirm-scroll=""'), `${large} ${source}`).not.toContain(why);
                expect(html.split(why).length - 1).toBe(1);
            }
        }
        expect(CONFIRM_WHY_STYLE('#92400e')).toEqual({ flexShrink: 0, fontSize: 13, fontWeight: 700, lineHeight: 1.25, color: '#92400e', overflowWrap: 'anywhere' });
        // Only a not-entitled card says why.
        for (const r of ['ready', 'already', 'cancelled', 'unknown'] as const) expect(render(<ConfirmCard card={card(r)} large />), r).not.toContain('data-confirm-why=""');
        // In the header, it counts among the card's essentials («Entrega» caps the card to hold them).
        expect(CARD_SRC).toMatch(/<\/div>\s+\{\/\*[^*]*\*\/\}\s+\{why && <div data-confirm-why="" style=\{CONFIRM_WHY_STYLE\(tone\.text\)\}>\{why\}<\/div>\}\s+\{name && <div ref=\{nameRef\} data-confirm-name=""/);
    });

    it('the room for it on the shortest phones: a compact line; «Entrega»\'s card at 320×460 tighter (its essentials must fit the 383 px band, or it is not capped)', () => {
        const short = CONFIRM_CSS.slice(CONFIRM_CSS.indexOf('@media (max-height: 640px)'), CONFIRM_CSS.indexOf('@media (max-height: 520px)'));
        expect(short).toContain('[data-confirm-card][data-confirm-large] [data-confirm-why] { font-size: 12px !important; line-height: 1.2 !important; margin-top: -2px; }');
        const tight = CONFIRM_CSS.slice(CONFIRM_CSS.indexOf('@media (max-width: 380px) and (max-height: 520px)'));
        expect(tight.length).toBeGreaterThan(0);
        for (const rule of [
            '[data-confirm-card]:not([data-confirm-large]) [data-confirm-head] { padding-top: 8px !important; padding-bottom: 6px !important; gap: 6px !important; }',
            '[data-confirm-card]:not([data-confirm-large]) [data-confirm-status] { padding: 4px 10px !important; font-size: 13px !important; }',
            '[data-confirm-card]:not([data-confirm-large]) [data-confirm-why] { font-size: 12px !important; line-height: 1.2 !important; margin-top: -2px; }',
            '[data-confirm-card]:not([data-confirm-large]) [data-confirm-name] { font-size: 20px !important; }',
            '[data-confirm-card]:not([data-confirm-large]) [data-confirm-actions] { padding-bottom: 10px !important; }',
        ]) expect(tight, rule).toContain(rule);
        for (const sel of tight.match(/^\s*\[data-confirm-card\][^{]*/gm) || []) expect(sel, sel).toContain(':not([data-confirm-large])');
        // Measured live (320×460, the confirmation card under «Entrega»'s scan input): 345 px of essentials in the 359 px
        // the band leaves — capped; with the line and the old sizes it was 389 px and nothing was capped.
        expect(fitHeight({ top: 77, bottom: 460 }, 345)).toBe(359);
        expect(fitHeight({ top: 77, bottom: 460 }, 389)).toBeNull();
    });
});

// ── 2.36.5: calling the meal groups ─────────────────────────────────────────────────────────────────────
describe('«Llamar grupos» (2.36.5): an uncalled group waits; «Dejar pasar igual» only after its own confirmation', () => {
    const CM = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager');
    const read = (rel: string) => fs.readFileSync(path.join(CM, rel), 'utf8');
    const group = { result: 'group_not_called', verdict: { person: { id: 3, name: 'Carla', meal_group: 'C' }, group: 'C', called_groups: ['A', 'B'], service: { id: 7, service_date: '2027-03-01', meal: 'almuerzo' } } };

    it('the flow: a decision card; Enter never lets them in; allowGroup() delivers with allow_group, nothing else does', async () => {
        expect(isDecision('group_not_called' as any)).toBe(true);
        expect(cardKeyAction('Enter', 'group_not_called' as any, '')).toBe(null);
        expect(cardKeyAction('Escape', 'group_not_called' as any, '')).toBe('cancel');
        const delivered: any[] = [];
        const flow = createConfirmFlow({ check: async () => group as any, deliver: async (sid, body) => { delivered.push({ sid, ...body }); return { result: 'delivered', method: 'group_exception' }; } });
        flow.scan(7, { inscription_id: 3 });
        await tick();
        expect(flow.state().card?.result).toBe('group_not_called');
        expect(flow.deliver()).toBe(false);
        expect(flow.authorize('x')).toBe(false);
        expect(flow.allowGroup('Dejado pasar')).toBe(true);
        await tick();
        expect(delivered).toEqual([{ sid: 7, inscription_id: 3, allow_group: true, note: 'Dejado pasar' }]);
        // allowGroup() never serves a ready card.
        const ready = createConfirmFlow({ check: async () => ({ result: 'ready', verdict: { person: { id: 1, name: 'Ana' } } }) as any, deliver: async () => ({ result: 'delivered' }) });
        ready.scan(7, { inscription_id: 1 });
        await tick();
        expect(ready.allowGroup('x')).toBe(false);
    });

    it('the confirm card: red, the letter and the groups called so far, «Dejar pasar igual» and «Cancelar»', () => {
        expect(confirmTone('group_not_called')).toBe('group');
        const html = render(<ConfirmCard card={{ ...group, seq: 1, shownAt: 0 }} service={group.verdict.service} language="es" onAllowGroup={() => {}} onCancel={() => {}} />);
        expect(html).toContain('data-confirm-card="group_not_called"');
        expect(html).toContain('Tu grupo aún no ha sido llamado');
        expect(html).toContain('Es del grupo C. Llamados hasta ahora: A, B.');
        expect(html).toContain('data-confirm-allow=""');
        expect(html).toContain('Dejar pasar igual');
        expect(html).toContain('data-confirm-cancel=""');
        expect(html).not.toContain('data-confirm-deliver=""');
        expect(html).toContain('border:3px solid #be123c');
    });

    it('the verdict card: the same warning, «Dejar pasar igual» through the in-card confirmation; an exception is labelled', () => {
        const html = render(<VerdictCard outcome={{ ...group, seq: 1, at: 0 }} service={group.verdict.service} language="es" onForce={() => {}} />);
        expect(html).toContain('data-verdict="group_not_called"');
        expect(html).toContain('Tu grupo aún no ha sido llamado');
        expect(html).toContain('Grupo C · llamados: A, B');
        expect(html).toContain('Dejar pasar igual');
        const done = render(<VerdictCard outcome={{ result: 'delivered', verdict: { person: { id: 3, name: 'Carla' }, method: 'group_exception', service: group.verdict.service }, seq: 2, at: 0 }} service={group.verdict.service} language="es" />);
        expect(done).toContain('data-verdict-method="group_exception"');
        expect(done).toContain('Antes de su grupo (excepción)');
        const s = read('client/admin/MealScanner.tsx');
        expect(s).toContain("if (o.result === 'group_not_called') await submit({ inscription_id: p.id, allow_group: true");
        expect(read('client/admin/MealsPage.tsx')).toContain("if (o.result === 'group_not_called') run({ inscription_id: p.id, allow_group: true");
    });

    it('the control screen: next group in order, per-group counts, undo behind the in-app confirmation, the audit; fresh every 10 s', async () => {
        const { nextToCall } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/mealTurns');
        expect(nextToCall(['A', 'B', 'C'], [])).toBe('A');
        expect(nextToCall(['A', 'B', 'C'], ['A', 'C'])).toBe('B');
        expect(nextToCall(['A', 'B'], ['A', 'B'])).toBe(null);
        const t = read('client/admin/MealCallsTab.tsx');
        expect(t).toContain('conferenceApi.callMealGroup(sid, g, undo)');
        expect(t).toMatch(/if \(undo && !await confirm\(tx\('calls\.undo\.confirm'/);
        expect(t).toContain('const POLL_MS = 10000;');
        expect(t).toContain('data-calls-next={next}');
        expect(t).toContain('data-calls-exception-list=""');
        expect(t).toContain('<Select ');
        expect(t).not.toMatch(/<select\b/);
        expect(t).not.toMatch(/\bwindow\.(alert|confirm|prompt)\s*\(|[^.\w](alert|prompt)\s*\(/);
        const page = read('client/admin/MealsPage.tsx');
        expect(page).toContain("k === 'calls' ? canPlan || canDeliver");
        expect(read('client/lib/conference.ts')).toContain("'/plugin/conference-manager/meals/priority/call'");
        for (const k of [...t.matchAll(/tx\('((?:calls|meals)\.[a-z_.]+)'/g)].map((m) => m[1])) for (const l of ['es', 'en', 'pt'] as const) expect((translations as any)[l][k], `${l} ${k}`).toBeTruthy();
        for (const k of ['meals.verdict.group_not_called', 'meals.group.allow', 'meals.group.confirm', 'meals.group.why', 'meals.method.group_exception', 'meals.tab.calls']) for (const l of ['es', 'en', 'pt'] as const) expect((translations as any)[l][k], `${l} ${k}`).toBeTruthy();
    });

    it('«Mi inscripción»: «Tu grupo ya puede pasar a comer», fresh while waiting; the notices switch without a bus; the phone\'s language', () => {
        const m = read('client/portal/yo/MyRegistration.tsx');
        expect(m).toContain('Tu grupo ya puede pasar a comer');
        expect(m).toContain('data-self-meal-called=""');
        expect(m).toContain('const t = setInterval(again, 30000);');
        expect(m).toContain('e.data.type === "cm-meal-call"');
        // 2.36.6: ONE switch for every notice (the «Avisos» card), no longer one per section.
        expect(m).toContain('<PushSwitch session={state.session} pushKey={view.push_key} post={post} code={view.code} />');
        expect((m.match(/<PushSwitch /g) || []).length).toBe(1);
        const b = read('client/portal/yo/BusAlerts.tsx');
        expect(b).toContain('export function PushSwitch(');
        expect(b).not.toContain('<PushSwitch ');
        expect((b.match(/lang: phoneLang\(\)/g) || []).length).toBe(2);
        const sw = read('client/portal/sw.js');
        expect(sw).toContain("c.postMessage({ type: meal ? 'cm-meal-call' : 'cm-bus-notice' })");
    });
});

describe('2.36.6 «Mi inscripción»: the badge first, then meals, then transport; one «Activar avisos»', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager', rel), 'utf8');
    const m = read('client/portal/yo/MyRegistration.tsx');
    it('the sections in the owner\'s order, with what is happening now in a strip at the top that leads down to them', () => {
        const at = (needle: string) => { const i = m.indexOf(needle); expect(i, needle).toBeGreaterThan(0); return i; };
        const order = ['data-self-alerts=""', 'data-self-badge=""', 'data-self-notices=""', 'data-self-meals=""', '<BusAlerts ', 'data-self-lodging=""'].map(at);
        expect([...order].sort((x, y) => x - y)).toEqual(order);
        expect(m).toContain('href="#mis-comidas"');
        expect(m).toContain('href="#mi-transporte"');
        expect(m).toContain('id="mis-comidas"');
        expect(read('client/portal/yo/BusAlerts.tsx')).toContain('id="mi-transporte"');
        // The strip hears the buses as «Mi transporte» polls them.
        expect(m).toContain('onBuses={setLiveBuses}');
        expect(m).toContain('const boarding = buses.filter((b) => b.status === "boarding");');
    });
    it('one switch, one state, every notice: meal calls, bus boarding / departure / messages; iPhone and blocked said', () => {
        const b = read('client/portal/yo/BusAlerts.tsx');
        expect(b).toContain('button: "Activar avisos",');
        expect(b).toContain('on: "Avisos activados en este teléfono.",');
        expect(b).toContain('cuando llamen a tu grupo a comer, cuando tu bus empiece a embarcar o salga');
        expect(b).not.toMatch(/Activar avisos (del bus|de comida)/);
        expect(b).toContain('data-push-ios=""');
        expect(b).toContain('Los avisos están bloqueados en este navegador.');
        // The server keeps one subscription per phone and fans every notice out to it: no «bus only» kind to migrate.
        const push = read('server/transport-push.js');
        expect(push).toContain("await createUniqueIndex(`${P}uidx_push_subs_endpoint`, T.pushSubs, 'endpoint_hash');");
        const subsTable = push.slice(push.indexOf('await db.createTable(T.pushSubs'), push.indexOf('await db.createTable(T.busNotices'));
        expect(subsTable).not.toMatch(/kind|what/);
    });
});

describe('2.36.18 meal groups: the minors\' companions, and one approximate time per group on «Mi inscripción»', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager', rel), 'utf8');
    it('«Turnos» asks for the age and the number, checks both in place, and sends them with the kitchen pace', () => {
        const m = read('client/admin/MealTurnsTab.tsx');
        expect(m).toContain('data-turns-minor-age=""');
        expect(m).toContain('data-turns-minor-companions=""');
        expect(m).toContain("companions_max: comp, minor_age: minorAge, minor_companions: minorComp }");
        expect(m).toContain("tx('turns.pace.error.minor.age'");
        expect(m).toContain("disabled={String(pace.minor_age).trim() === ''}");
        expect(m).not.toMatch(/window\.(alert|confirm|prompt)\(|\balert\(/);
    });
    it('«Mi inscripción» shows «Grupo C · hacia las 12:15», never «Tu turno: 12:10–12:25»', () => {
        const page = read('client/portal/yo/MyRegistration.tsx');
        expect(page).toContain('{view.meal_group ? `Grupo ${view.meal_group} · ` : ""}hacia las {m.turn_approx}');
        expect(page).not.toContain('Tu turno:');
        expect(page).not.toContain('turn_end');
    });
});
