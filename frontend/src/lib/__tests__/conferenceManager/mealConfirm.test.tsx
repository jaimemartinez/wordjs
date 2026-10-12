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
 * and the counter tiles keep their words inside at every width.
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
    CONFIRM_CSS,
} from '../../../../../marketplace/plugins/conference-manager/client/admin/MealScanner';
import {
    CONFIRM_PREF_EVENT, CONFIRM_PREF_KEY, DEFAULT_DISPLAY_KEYS, ENTER_ARM_MS, ENTER_BURST_MS, TAP_ARM_MS, VERDICT_TAP_ARM_MS,
    canMoveDisplayKey, cardKeyAction, createConfirmFlow, displayLabel, displayOptions, displaySaveKeys, displayValue, holdAfterClose, isDecision,
    moveDisplayKey, previewDisplayFields, readConfirmPref, splitPersonFields, tapArmed, toggleDisplayKey, withName, writeConfirmPref,
    REVEAL_FIT_VAR, REVEAL_MARGIN_PX, cardEssentials, decisionSlotKey, fitHeight, prefersReducedMotion, revealSlot, visibleBand,
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
        expect(html).toMatch(/data-confirm-meal=""[\s\S]*Almuerzo — Campestre/);
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

describe('the card on a short phone: WHO it is never scrolls away (UX F5)', () => {
    // Measured in Chromium (scratchpad harness: the real scanner markup + this card) at 375×548, 320×460,
    // 390×664 and 412×740: status, name and the whole button row visible in every case. Pinned here: the
    // structure that guarantees it.
    it('the status and the name are the header that stays at the top of the scrolling middle; band and buttons never shrink', () => {
        for (const r of ['ready', 'not_entitled'] as const) {
            const html = render(<ConfirmCard card={card(r)} large />);
            const scroll = html.indexOf('data-confirm-scroll'), head = html.indexOf('data-confirm-head'), name = html.indexOf('data-confirm-name'), rest = html.indexOf('data-confirm-body');
            expect(scroll, r).toBeGreaterThan(0);
            expect(head, r).toBeGreaterThan(scroll);
            expect(name, r).toBeGreaterThan(head);
            expect(rest, r).toBeGreaterThan(name);
            expect(html, r).toMatch(/data-confirm-head="" style="position:sticky;top:0;z-index:1;background:#fff;/);
            expect(html, r).toMatch(/data-confirm-scroll="" style="position:relative;overflow-y:auto;min-height:0;flex:0 1 auto"/);
            expect(html, r).toMatch(/data-confirm-meal="" style="[^"]*flex-shrink:0"/);
            expect(html, r).toMatch(/data-confirm-actions="" style="[^"]*flex-shrink:0"/);
            expect(html, r).toMatch(/data-confirm-name=""[^>]*>Ana Pérez</);
            expect(html.indexOf('data-confirm-status'), r).toBeGreaterThan(head);
            expect(html.indexOf('data-confirm-status'), r).toBeLessThan(name);
            expect(html.indexOf('Vegetariana'), r).toBeGreaterThan(rest);         // the rest scrolls under the header
            expect(html.match(/Ana Pérez/g)?.length, r).toBe(1);                  // the name once
            expect(html, r).toContain('data-confirm-large=""');
        }
        // A server without fields: the plain name in the same place.
        expect(render(<ConfirmCard card={{ ...card('ready'), verdict: { service: SERVICE, person: { id: 1, name: 'Ana Pérez' } } }} />)).toMatch(/data-confirm-name=""[^>]*>Ana Pérez</);
        expect(splitPersonFields({ name: 'Ana', fields: [{ key: 'dieta', label: 'Dieta', value: 'x' }] })).toEqual({ name: { key: '@name', label: '', value: 'Ana' }, rest: [{ key: 'dieta', label: 'Dieta', value: 'x' }] });
    });
    it('short screens: a one-line meal band and slimmer buttons; the scanner folds its counters while a card is open', () => {
        expect(CONFIRM_CSS).toMatch(/@media \(max-height: 640px\)/);
        expect(CONFIRM_CSS).toMatch(/\[data-confirm-card\]\[data-confirm-large\] \[data-confirm-meal\] \{ display: flex !important;/);
        expect(CONFIRM_CSS).toMatch(/@media \(max-width: 380px\) \{\s+\[data-confirm-card\]\[data-confirm-large\] \[data-long-label\] \{ font-size: 13px !important;/);
        expect(render(<ConfirmCard card={card('not_entitled')} large />)).toMatch(/data-confirm-authorize="" data-long-label=""/);
        expect(render(<ConfirmCard card={card('ready')} large />)).toContain('@media (max-height: 640px)');
        expect(SCANNER_CSS).toMatch(/@media \(max-height: 700px\) \{ \[data-meal-scanner\]\[data-card-open\] \[data-scanner-counters\] \{ display: none !important; \} \}/);
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
        expect(verdictCard).toMatch(/<PersonFields fields=\{p\.fields\} large=\{large\} onColour=\{tone !== 'warn'\} \/>/);
    });
    it('«Entrega»: queue ON; Enter (keydown) answers the card only when armed; Esc cancels; a pick replaces; OFF = the immediate run()', () => {
        expect(tab).toMatch(/queue: true,/);
        // Enter is read on keydown (repeat + the previous key), the form submit is only a fallback.
        expect(tab).toMatch(/onKeyDown=\{onScanKey\}/);
        expect(tab).toMatch(/const prev = lastKeyAt\.current;\s+lastKeyAt\.current = at;\s+if \(e\.key !== 'Enter'\) return;\s+e\.preventDefault\(\);\s+submit\(\{ now: at, lastKeyAt: prev, repeat: e\.repeat \}\);/);
        expect(tab).toMatch(/<form onSubmit=\{\(e\) => \{ e\.preventDefault\(\); submit\(\); \}\}/);
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

    it('decisionSlotKey: a new key exactly when something new appears; none with the confirmation OFF (2.15)', () => {
        expect(decisionSlotKey({ confirmOn: true })).toBeNull();
        expect(decisionSlotKey({ confirmOn: true, checking: true })).toBe('checking');
        expect(decisionSlotKey({ confirmOn: true, card: { seq: 3 } })).toBe('card:3');
        // The open card wins over a stale result; a re-render keeps the key, the next scan changes it.
        expect(decisionSlotKey({ confirmOn: true, card: { seq: 3 }, checking: true, outcome: { seq: 9 } })).toBe('card:3');
        expect(decisionSlotKey({ confirmOn: true, card: { seq: 4 } })).not.toBe(decisionSlotKey({ confirmOn: true, card: { seq: 3 } }));
        // A delivery's result, and again when it starts holding the queue.
        expect(decisionSlotKey({ confirmOn: true, outcome: { seq: 9 } })).toBe('result:9');
        expect(decisionSlotKey({ confirmOn: true, outcome: { seq: 9 }, held: true })).toBe('result:9:held');
        // OFF: the immediate delivery's verdict is never scrolled to (2.15 unchanged).
        expect(decisionSlotKey({ confirmOn: false, outcome: { seq: 9 } })).toBeNull();
        expect(decisionSlotKey({ confirmOn: false, card: { seq: 3 }, checking: true })).toBeNull();
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
            .toMatch(/data-confirm-card="ready"[^>]*style="[^"]*display:flex;flex-direction:column;max-height:100%;min-height:0"/);
    });

    it('wiring (source): «Entrega» reveals its slot on every new key (layout effect + resize), caps the card, and taking the focus back never scrolls it away', () => {
        const page = fs.readFileSync(path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin/MealsPage.tsx'), 'utf8');
        const tab = page.slice(page.indexOf('function DeliveryTab('), page.indexOf('function DisplayFieldsDialog('));
        expect(tab).toMatch(/const slotKey = decisionSlotKey\(\{ confirmOn, card: confirm\.card, checking: confirm\.checking, outcome, held: confirm\.held \}\);\s+slotKeyRef\.current = slotKey;/);
        expect(tab).toMatch(/useLayoutEffect\(\(\) => \{\s+if \(!slotKey\) return;\s+const reveal = \(\) => \{ revealSlot\(slotRef\.current, window\); \};\s+reveal\(\);\s+window\.addEventListener\('resize', reveal\);\s+return \(\) => window\.removeEventListener\('resize', reveal\);\s+\}, \[slotKey\]\);/);
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
