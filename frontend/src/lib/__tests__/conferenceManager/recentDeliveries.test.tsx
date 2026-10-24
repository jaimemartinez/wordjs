/**
 * conference-manager 2.17.0 — «Últimas entregas» says WHAT was delivered.
 *
 * The site owner, testing «Alimentación» on an iPhone: «en la parte de alimentación en últimas entregas no
 * muestra qué se le entregó». Each row of «Entrega» › «Últimas entregas» named the person, the location, the
 * method and who recorded it — never the meal — and a delivery made with the phone scanner appeared there
 * only at the next 15 s poll. Pinned here (node environment, no DOM: server-rendered markup, the pure
 * loader, and the wiring lines on the source):
 *   - every row names the person (prominent, never cut), the meal («Desayuno · Vie 11/12», with the
 *     service's label), the method as a chip, the time, the location and who recorded it; the header names
 *     the service; nothing is truncated; «Deshacer» is a 44 px target whose inline confirmation names the meal
 *     and the person; the text meets WCAG AA;
 *   - the twins: the «Entregado» / «Ya recibió» cards (in «Entrega» and in the phone scanner) name the meal —
 *     the server's service first — and the «Por persona» notice names it;
 *   - createLatestLoader: a poll answering late never puts back a list without the latest delivery, yet in a
 *     rush every answer newer than the one shown is applied (applying only the very last load's froze the
 *     list until scanning paused); an answer for a service no longer selected is dropped; a failure keeps
 *     what is shown and does not drop an older answer that is still newer;
 *   - wiring: «Entrega» renders RecentDeliveries with the service the server answered for, loads through the
 *     latest-wins loader, and reloads at once when MealsPage signals a delivery / undo in the phone scanner
 *     or its closing — while its own deliveries, undos and the poll keep working as before; the page's totals
 *     reload at most every 2 s while the scanner reports a rush (createThrottle), at once when it closes, and
 *     «Entrega» does not poll under the scanner;
 *   - the phone scanner's verdict card fits the camera area: on every phone from 320×460 up its short status,
 *     the meal, the person's NAME and every button (44 px) stay in view without scrolling inside the card;
 *     the meal line keeps to one line on a short phone (only the label gives way), the other details give way
 *     first, the armed question by whole sentences, the name last;
 *   - the inline confirmations that open below the fold in «Entrega» («¿Deshacer…?» of «Últimas entregas»,
 *     «¿Entregar de todas formas?» of the verdict card) scroll themselves into view — the latter spanning the
 *     card with the short question, its buttons first when it is still taller than the screen (320×460);
 *   - the person's other data end on a whole line with «Más abajo» under the cut (never a lone label or the
 *     tops of a value), and the camera's aim hint hides while a card reaches it.
 */
import { describe, it, expect, vi } from 'vitest';
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
    ASK_LEVELS, DeliveryForceAsk, ForceAsk, NO_CAMERA_LINE_COVERED, SCANNER_CSS, ScanPill, VERDICT_ASK_MIN, VERDICT_BOX, VERDICT_CSS, VERDICT_FIT, VERDICT_MORE_STYLE, VerdictCard,
    askClipped, askGiveWay, askStepDown, coveredCameraLines, coversHint, detailsStyle, sameCameraLines,
    clippedPx, makeTx, mealLine, methodLabel, openMealStyle,
} from '../../../../../marketplace/plugins/conference-manager/client/admin/MealScanner';
import { METHOD_CHIP, RecentDeliveries, UNDO_ASK_BUTTON_STYLE, UNDO_TARGET, undoQuestion } from '../../../../../marketplace/plugins/conference-manager/client/admin/RecentDeliveries';
import { createLatestLoader, createThrottle, stampTime } from '../../../../../marketplace/plugins/conference-manager/client/lib/meals';
import { REVEAL_MARGIN_PX, UNDO_ASK_LEVELS, revealAsk, revealNearest, undoAskStepDown } from '../../../../../marketplace/plugins/conference-manager/client/lib/mealConfirm';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';
import { AA, contrastOf, textClassOf } from '../helpers/tailwindContrast';

const es = makeTx((k: string) => translations.es[k] ?? k);
const en = makeTx((k: string) => translations.en[k] ?? k);
const flat = (html: string) => html.replace(/<!-- -->/g, '');
const render = (node: React.ReactNode) => flat(renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>));
/** The opening tag of the element carrying `attr`, and its classes. */
const tagWith = (html: string, attr: string) => {
    const i = html.indexOf(attr);
    expect(i, attr).toBeGreaterThan(-1);
    return html.slice(html.lastIndexOf('<', i), html.indexOf('>', i) + 1);
};
const classesOf = (tag: string) => (/class="([^"]*)"/.exec(tag)?.[1] || '');
/** The whole element carrying `attr` (its closing tag found by depth), and its text. */
const elementOf = (html: string, attr: string) => {
    const tag = tagWith(html, attr);
    const start = html.indexOf(tag);
    const name = /^<([a-z0-9]+)/.exec(tag)![1];
    const re = new RegExp(`<${name}[\\s>]|</${name}>`, 'g');
    re.lastIndex = start + tag.length;
    let depth = 1; let m: RegExpExecArray | null;
    while (depth > 0 && (m = re.exec(html))) depth += m[0].startsWith('</') ? -1 : 1;
    return html.slice(start, re.lastIndex);
};
// Tags out until none is left, then the entities React writes — &amp; last, so nothing is unescaped twice.
const stripTags = (html: string) => { let out = html, prev; do { prev = out; out = out.replace(/<[^>]*>/g, ''); } while (out !== prev); return out; };
const textOf = (html: string, attr: string) => stripTags(elementOf(html, attr)).replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
/** The markup without the card's own stylesheet (its selectors name every part). */
const noStyle = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '');

const ADMIN = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client/admin');
const PAGE = fs.readFileSync(path.join(ADMIN, 'MealsPage.tsx'), 'utf8');
const RECENT_SRC = fs.readFileSync(path.join(ADMIN, 'RecentDeliveries.tsx'), 'utf8');

/** Friday 11 December 2026, breakfast. */
const BREAKFAST = { id: 7, service_date: '2026-12-11', meal: 'desayuno', label: null, start_time: null, end_time: null };
const LUNCH = { id: 8, service_date: '2027-03-01', meal: 'almuerzo', label: 'Campestre', start_time: null, end_time: null };
const ROWS = [
    { delivery_id: 3, service_id: 7, inscription_id: 11, name: 'María Fernanda Rodríguez Castañeda de la Torre', location: 'Bogotá', location_id: 1, family_group: null, reg_code: null, delivered_at: '2026-12-11 12:31:05', delivered_by: 'cocina1', method: 'scan', note: null },
    { delivery_id: 2, service_id: 7, inscription_id: 12, name: 'Beto Gómez', location: null, location_id: null, family_group: null, reg_code: null, delivered_at: '2026-12-11 12:30:00', delivered_by: 'boss', method: 'override', note: 'Autorizado en la entrega' },
    { delivery_id: 1, service_id: 7, inscription_id: 13, name: 'Ana Pérez', location: 'Cali', location_id: 2, family_group: null, reg_code: null, delivered_at: '2026-12-11 12:29:00', delivered_by: 'cocina2', method: 'manual', note: null },
];
const rowsOf = (html: string) => html.split(/(?=<li[^>]*data-recent-row=)/).slice(1);

describe('mealLine: WHAT was delivered, the meal first', () => {
    it('«Desayuno · Vie 11/12», the label after the meal, translated; nothing without a service', () => {
        expect(mealLine(es, BREAKFAST, 'es')).toBe('Desayuno · Vie 11/12');
        expect(mealLine(es, LUNCH, 'es')).toBe('Almuerzo — Campestre · Lun 01/03');
        expect(mealLine(en, BREAKFAST, 'en')).toBe('Breakfast · Fri 11/12');
        expect(mealLine(es, null, 'es')).toBe('');
        expect(methodLabel(es, 'scan')).toBe('Escaneo');
        expect(methodLabel(es, 'manual')).toBe('Manual');
        expect(methodLabel(es, 'override')).toBe('Sin derecho (autorizado)');
    });
});

describe('«Últimas entregas»: every row says what was delivered, to whom, how and when', () => {
    const html = render(<RecentDeliveries service={BREAKFAST} rows={ROWS} onAskUndo={() => { }} onUndo={() => { }} />);
    const rows = rowsOf(html);

    it('the header names the service; each row the person, then the meal, then the method chip, time, location and who', () => {
        expect(tagWith(html, 'data-recent-service=""')).toBeTruthy();
        expect(html).toMatch(/data-recent-service="">.*Desayuno · Vie 11\/12<\/p>/);
        expect(rows).toHaveLength(3);
        const [maria, beto, ana] = rows;
        for (const [row, r] of [[maria, ROWS[0]], [beto, ROWS[1]], [ana, ROWS[2]]] as const) {
            expect(row).toContain(`>${r.name}</div>`);
            expect(row).toMatch(/data-recent-meal="">.*Desayuno · Vie 11\/12<\/div>/);
            // The name is the row's heading: it comes first, the meal right under it.
            expect(row.indexOf(r.name)).toBeLessThan(row.indexOf('data-recent-meal'));
            expect(row).toContain(`data-recent-method="${r.method}"`);
            expect(row).toContain(`>${stampTime(r.delivered_at)}</span>`);
            expect(row).toContain(r.delivered_by);
        }
        expect(maria).toContain('>Escaneo</span>');
        expect(maria).toContain('Bogotá · cocina1');
        expect(beto).toContain('>Sin derecho (autorizado)</span>');
        expect(beto).toContain('Sin localidad · boss');
        expect(ana).toContain('>Manual</span>');
    });

    it('the service\'s own label is part of what was delivered', () => {
        const lunch = render(<RecentDeliveries service={LUNCH} rows={[{ ...ROWS[2], service_id: 8 }]} />);
        expect(lunch).toMatch(/data-recent-meal="">.*Almuerzo — Campestre · Lun 01\/03<\/div>/);
        expect(lunch).toMatch(/data-recent-service="">.*Almuerzo — Campestre · Lun 01\/03<\/p>/);
    });

    it('the method chips: neutral for a scan, blue for a pick by name, amber for an authorised override', () => {
        expect(classesOf(tagWith(rows[0], 'data-recent-method="scan"'))).toContain(METHOD_CHIP.scan);
        expect(classesOf(tagWith(rows[2], 'data-recent-method="manual"'))).toContain(METHOD_CHIP.manual);
        expect(classesOf(tagWith(rows[1], 'data-recent-method="override"'))).toContain(METHOD_CHIP.override);
        expect(METHOD_CHIP.override).toMatch(/\bbg-amber-/);
    });

    it('phone-first: nothing is truncated — the name, the meal and the details wrap (iPhone SE, 320 px)', () => {
        expect(html).not.toMatch(/\btruncate\b|text-ellipsis|whitespace-nowrap|line-clamp/);
        for (const attr of ['data-recent-name=""', 'data-recent-meal=""', 'data-recent-service=""']) expect(classesOf(tagWith(html, attr))).toMatch(/\bbreak-words\b/);
        // The chip may wrap inside the row instead of overflowing it.
        expect(classesOf(tagWith(html, 'data-recent-method="override"'))).toMatch(/\bmax-w-full\b.*\bbreak-words\b/);
        // The details line wraps as a whole (chip, time, place · who).
        expect(rows[0]).toMatch(/<div class="[^"]*\bflex-wrap\b[^"]*"><span class="[^"]*" data-recent-method=/);
    });

    it('«Deshacer» is a 44 px target named after the meal and the person; it never takes the scan input\'s focus', () => {
        expect(UNDO_TARGET).toBe('w-11 h-11');
        const undo = tagWith(rows[0], 'data-recent-undo=""');
        expect(classesOf(undo)).toContain(UNDO_TARGET);
        expect(classesOf(undo)).toMatch(/\bshrink-0\b/);
        expect(undo).toContain(`aria-label="Deshacer la entrega de Desayuno · Vie 11/12 a ${ROWS[0].name}"`);
        expect(RECENT_SRC).toMatch(/onMouseDown=\{keepFocus\} onClick=\{\(\) => onAskUndo\?\.\(r\.delivery_id\)\} data-recent-undo=""/);
        expect(RECENT_SRC).toMatch(/const keepFocus = \(e: React\.MouseEvent\) => e\.preventDefault\(\);/);
        expect(RECENT_SRC.match(/onMouseDown=\{keepFocus\}/g)).toHaveLength(3);
    });

    it('the inline confirmation names the meal and the person, with 44 px buttons; the row\'s undo icon gives way to it', () => {
        const asking = rowsOf(render(<RecentDeliveries service={BREAKFAST} rows={ROWS} undoAsk={2} onAskUndo={() => { }} onUndo={() => { }} />));
        const beto = asking[1];
        expect(beto).not.toContain('data-recent-undo=""');
        expect(beto).toMatch(/role="alertdialog" aria-label="¿Deshacer la entrega de Desayuno · Vie 11\/12 a Beto Gómez\?"/);
        expect(beto).toContain('>¿Deshacer la entrega de Desayuno · Vie 11/12 a Beto Gómez?</span>');
        for (const attr of ['data-recent-undo-confirm=""', 'data-recent-undo-cancel=""']) expect(tagWith(beto, attr)).toMatch(/style="[^"]*min-height:44px/);
        expect(beto).toContain('>Deshacer</button>');
        expect(beto).toContain('>Cancelar</button>');
        // The other rows keep their undo.
        expect(asking[0]).toContain('data-recent-undo=""');
        expect(asking[0]).not.toContain('role="alertdialog"');
        // «Deshacer» calls onUndo with THAT delivery; «Cancelar» closes the question.
        expect(RECENT_SRC).toMatch(/onClick=\{\(\) => onUndo\?\.\(r\.delivery_id\)\} data-recent-undo-confirm=""/);
        expect(RECENT_SRC).toMatch(/onClick=\{\(\) => onAskUndo\?\.\(null\)\} data-recent-undo-cancel=""/);
    });

    it('no deliveries yet: says so, and still names the service', () => {
        const empty = render(<RecentDeliveries service={BREAKFAST} rows={[]} />);
        expect(empty).toContain('Aún no hay entregas en este servicio.');
        expect(empty).toMatch(/data-recent-service="">.*Desayuno · Vie 11\/12/);
        expect(empty).not.toContain('data-recent-row');
    });

    it('WCAG AA: the name, the meal, the details, the chips and the question', () => {
        const pairs: [string, string][] = [
            [textClassOf(classesOf(tagWith(html, 'data-recent-name=""'))), 'white'],
            [textClassOf(classesOf(tagWith(html, 'data-recent-meal=""'))), 'white'],
            [textClassOf(classesOf(tagWith(html, 'data-recent-service=""'))), 'white'],
            ['text-gray-600', 'white'],    // the details line
            ['text-gray-500', 'white'],    // «Aún no hay entregas…»
        ];
        for (const [fg, bg] of pairs) expect(contrastOf(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(AA);
        expect(rows[0]).toMatch(/<div class="[^"]*\btext-gray-600\b[^"]*"><span class="[^"]*" data-recent-method=/);
        for (const chip of Object.values(METHOD_CHIP)) {
            const fg = textClassOf(chip);
            const bg = chip.split(/\s+/).find((k) => k.startsWith('bg-'))!;
            expect(contrastOf(fg, bg), chip).toBeGreaterThanOrEqual(AA);
        }
        expect(contrastOf('text-rose-800', 'bg-rose-50')).toBeGreaterThanOrEqual(AA);
        // The undo icon (non-text, 3:1).
        expect(contrastOf('text-gray-500', 'white')).toBeGreaterThanOrEqual(3);
    });
});

describe('the twins: the «Entregado» / «Ya recibió» cards and «Por persona» name the meal', () => {
    const person = { id: 1, name: 'Ana Pérez', location: 'Bogotá', location_id: 2, family_group: null, reg_code: null };
    it('«Entregado» names the meal under its title — the service the server answered for first', () => {
        const fromServer = render(<VerdictCard service={LUNCH} language="es" outcome={{ result: 'delivered', seq: 1, at: 0, verdict: { delivery_id: 3, service: BREAKFAST, person } }} />);
        expect(textOf(fromServer, 'data-verdict-meal=""')).toBe('Desayuno · Vie 11/12');
        expect(fromServer).not.toContain('Almuerzo');
        // The title stays «Entregado»; the meal follows it, then the person.
        expect(fromServer.indexOf('Entregado')).toBeLessThan(fromServer.indexOf('data-verdict-meal'));
        expect(fromServer.indexOf('data-verdict-meal')).toBeLessThan(fromServer.indexOf('Ana Pérez'));
        const selected = render(<VerdictCard service={LUNCH} language="es" outcome={{ result: 'delivered', seq: 1, at: 0, verdict: { delivery_id: 3, person } }} />);
        expect(textOf(selected, 'data-verdict-meal=""')).toBe('Almuerzo — Campestre · Lun 01/03');
        expect(tagWith(selected, 'data-verdict-meal=""')).toContain('title="Almuerzo — Campestre · Lun 01/03"');
        // The phone scanner's card: the same words (its parts can give way on a short screen, see below), the
        // whole line as its title.
        const large = render(<VerdictCard large service={LUNCH} language="es" outcome={{ result: 'delivered', seq: 1, at: 0, verdict: { delivery_id: 3, person } }} />);
        expect(tagWith(large, 'data-verdict-meal=""')).toContain('title="Almuerzo — Campestre · Lun 01/03"');
        expect(textOf(large, 'data-verdict-meal=""')).toBe('Almuerzo — Campestre · Lun 01/03');
    });
    it('«Ya recibió» names it too, and «Sin derecho» what they have no right to (its status is short); the other verdicts do not (they received nothing)', () => {
        const already = render(<VerdictCard service={BREAKFAST} language="es" outcome={{ result: 'already', seq: 1, at: 0, verdict: { person, delivered_at: '2026-12-11 07:10:00', delivered_by: 'cocina1' } }} />);
        expect(textOf(already, 'data-verdict-meal=""')).toBe('Desayuno · Vie 11/12');
        const notEntitled = render(<VerdictCard service={BREAKFAST} language="es" outcome={{ result: 'not_entitled', seq: 1, at: 0, verdict: { person } }} />);
        expect(textOf(notEntitled, 'data-verdict-title=""')).toBe('Sin derecho');
        expect(textOf(notEntitled, 'data-verdict-meal=""')).toBe('Desayuno · Vie 11/12');
        for (const result of ['cancelled', 'unknown', 'offline', 'error', 'no_service']) {
            const other = render(<VerdictCard service={BREAKFAST} language="es" outcome={{ result, seq: 1, at: 0, verdict: { person } }} />);
            expect(noStyle(other), result).not.toContain('data-verdict-meal');
        }
        // Without any service there is nothing to name (never an empty line).
        expect(noStyle(render(<VerdictCard language="es" outcome={{ result: 'delivered', seq: 1, at: 0, verdict: { person } }} />))).not.toContain('data-verdict-meal');
    });
    it('«Por persona»: the delivery notice names the meal (server\'s service first)', () => {
        const dialog = PAGE.slice(PAGE.indexOf('function PersonMealsDialog('), PAGE.indexOf('// 3. ENTREGA'));
        expect(dialog).toMatch(/const meal = mealLine\(tx, o\.verdict\?\.service \|\| s, language\);/);
        expect(dialog).toMatch(/if \(o\.result === 'delivered'\) addToast\(tx\('meals\.delivered\.what', 'Entregado: \{meal\}', \{ meal \}\), 'success'\);/);
        expect(dialog).toMatch(/else if \(o\.result === 'already'\) addToast\(tx\('meals\.already\.what', 'Ya recibió: \{meal\}', \{ meal \}\), 'error'\);/);
        expect(es('meals.delivered.what', '', { meal: mealLine(es, BREAKFAST, 'es') })).toBe('Entregado: Desayuno · Vie 11/12');
    });
});

describe('createLatestLoader: the newest load wins, for the service still selected', () => {
    function deferred<T>() {
        let resolve!: (v: T) => void, reject!: (e: unknown) => void;
        const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
        return { promise, resolve, reject };
    }
    it('a poll that answers AFTER the reload following a delivery never puts the older list back', async () => {
        const answers = [deferred<string>(), deferred<string>()];
        let calls = 0;
        const applied: string[] = [];
        const refresh = createLatestLoader<string>({ load: () => answers[calls++].promise, current: () => 7, apply: (_id, list) => { applied.push(list); } });
        const poll = refresh(7);             // the 15 s poll leaves…
        const afterDelivery = refresh(7);    // …a delivery is recorded and «Entrega» reloads
        answers[1].resolve('with the new delivery');
        expect(await afterDelivery).toBe('applied');
        answers[0].resolve('without it');    // the poll's older answer lands late
        expect(await poll).toBe('stale');
        expect(applied).toEqual(['with the new delivery']);
    });
    it('a rush: every answer newer than the one shown is applied, even when another load has left since', async () => {
        // A USB scanner reading a family back to back: each delivery starts a reload before the previous
        // reload answers. Applying only the very last load's answer dropped every one of them (the counters
        // and the list froze until scanning paused).
        const answers = [deferred<string>(), deferred<string>(), deferred<string>()];
        let calls = 0;
        const applied: string[] = [];
        const refresh = createLatestLoader<string>({ load: () => answers[calls++].promise, current: () => 7, apply: (_id, list) => { applied.push(list); } });
        const first = refresh(7);
        const second = refresh(7);               // left before the first answered
        answers[0].resolve('after delivery 1');
        expect(await first).toBe('applied');
        const third = refresh(7);                // left before the second answered
        answers[1].resolve('after delivery 2');
        expect(await second).toBe('applied');
        answers[2].resolve('after delivery 3');
        expect(await third).toBe('applied');
        expect(applied).toEqual(['after delivery 1', 'after delivery 2', 'after delivery 3']);
    });
    it('a failed newest load does not throw away an older answer that is still newer than the one shown', async () => {
        const answers = [deferred<string>(), deferred<string>()];
        let calls = 0;
        const applied: string[] = [];
        const refresh = createLatestLoader<string>({ load: () => answers[calls++].promise, current: () => 7, apply: (_id, list) => { applied.push(list); } });
        const older = refresh(7);
        const newer = refresh(7);
        answers[1].reject(Object.assign(new Error('offline'), { status: 0 }));
        expect(await newer).toBe('failed');
        answers[0].resolve('with the delivery');
        expect(await older).toBe('applied');
        expect(applied).toEqual(['with the delivery']);
    });
    it('in order, every load is applied', async () => {
        const applied: number[] = [];
        let n = 0;
        const refresh = createLatestLoader<number>({ load: async () => ++n, current: () => 7, apply: (_id, v) => { applied.push(v); } });
        expect(await refresh(7)).toBe('applied');
        expect(await refresh(7)).toBe('applied');
        expect(applied).toEqual([1, 2]);
    });
    it('an answer for a service that is no longer selected (or a screen that is gone) is dropped', async () => {
        let selected: number | null = 7;
        const applied: [number, string][] = [];
        const d = deferred<string>();
        const refresh = createLatestLoader<string>({ load: () => d.promise, current: () => selected, apply: (id, v) => { applied.push([id, v]); } });
        const p = refresh(7);
        selected = 9;
        d.resolve('breakfast list');
        expect(await p).toBe('stale');
        selected = null;
        expect(await createLatestLoader<string>({ load: async () => 'x', current: () => selected, apply: () => applied.push([0, 'x']) })(7)).toBe('stale');
        expect(applied).toEqual([]);
    });
    it('a failure keeps what is shown (nothing applied, never thrown)', async () => {
        const applied: string[] = [];
        const refresh = createLatestLoader<string>({ load: async () => { throw Object.assign(new Error('offline'), { status: 0 }); }, current: () => 7, apply: (_id, v) => { applied.push(v); } });
        await expect(refresh(7)).resolves.toBe('failed');
        expect(applied).toEqual([]);
    });
});

describe('wiring (source): «Entrega» shows the rows with their meal and reloads after the phone scanner', () => {
    const tab = PAGE.slice(PAGE.indexOf('function DeliveryTab('), PAGE.indexOf('function DisplayFieldsDialog('));
    const page = PAGE.slice(PAGE.indexOf('export default function MealsPage('), PAGE.indexOf('// ── Service picker'));

    it('«Últimas entregas» is RecentDeliveries, named after the service the server answered the rows for', () => {
        expect(tab).toContain('<RecentDeliveries service={recentService || service} rows={recent} busy={busy} undoAsk={undoAsk} onAskUndo={setUndoAsk} onUndo={undo} />');
        expect(tab).toMatch(/apply: \(_sid: number, \[s, r\]: any\) => \{ setStats\(s\); setRecent\(r\.deliveries \|\| \[\]\); setRecentService\(r\.service \|\| null\); \},/);
        // A new service starts empty — never the previous service's rows under the new name.
        expect(tab).toMatch(/setStats\(null\); setRecent\(\[\]\); setRecentService\(null\); setUndoAsk\(null\);\s+refresh\(\);\s+const h = setInterval\(\(\) => \{ if \(!pausedRef\.current\) refresh\(\); \}, 15000\);/);
        // The old inline list (name cut with «…», no meal) is gone.
        expect(tab).not.toMatch(/tx\('meals\.recent'|recent\.map\(/);
        expect(PAGE).not.toMatch(/meals\.undo\.person|meals\.undo\.confirm\.person/);
    });

    it('the counters and the list load through the latest-wins loader, for the selected service only', () => {
        expect(tab).toMatch(/const loadRecent = useMemo\(\(\) => createLatestLoader\(\{\s+load: \(sid: number\) => Promise\.all\(\[conferenceApi\.getMealServiceStats\(sid\), conferenceApi\.getMealServiceDeliveries\(sid, 20\)\]\),\s+current: \(\) => \(alive\.current \? sidRef\.current : null\),/);
        expect(tab).toMatch(/await loadRecent\(serviceId\);/);
    });

    it('a delivery or an undo in the phone scanner, and its closing, reload «Entrega» at once — not at the next poll', () => {
        expect(page).toMatch(/const \[deliveriesRev, setDeliveriesRev\] = useState\(0\);/);
        expect(page).toMatch(/const deliveriesChanged = useCallback\(\(\) => \{ setDeliveriesRev\(\(n\) => n \+ 1\); totalsReload\.run\(\); \}, \[totalsReload\]\);/);
        expect(page).toMatch(/const scannerClosed = useCallback\(\(\) => \{ setScanner\(false\); setDeliveriesRev\(\(n\) => n \+ 1\); totalsReload\.now\(\); \}, \[totalsReload\]\);/);
        expect(page).toContain('onChanged={deliveriesChanged} onClose={scannerClosed}');
        expect(page).toMatch(/<DeliveryTab [^\n]*changed=\{deliveriesRev\} \/>/);
        expect(tab).toMatch(/function DeliveryTab\(\{[^}]*changed = 0 \}: any\)/);
        expect(tab).toMatch(/const seenChange = useRef\(changed\);\s+useEffect\(\(\) => \{\s+if \(seenChange\.current === changed\) return;\s+seenChange\.current = changed;\s+refreshRef\.current\(\);\s+\}, \[changed\]\);/);
    });

    it('a rush in the phone scanner: the page totals reload at most every 2 s, at once when it closes; «Entrega» does not poll under it', () => {
        // Every scanner delivery used to fire GET /meals (a stats query per service) on top of the scanner's
        // and «Entrega»'s own reloads, without any debounce.
        expect(page).toMatch(/const reloadRef = useRef\(reload\);\s+reloadRef\.current = reload;/);
        expect(page).toMatch(/const totalsReload = useMemo\(\(\) => createThrottle\(\(\) => \{ reloadRef\.current\(\); \}, 2000\), \[\]\);/);
        expect(page).toMatch(/useEffect\(\(\) => \(\) => totalsReload\.cancel\(\), \[totalsReload\]\);/);
        // No unthrottled reload left on the scanner's path.
        expect(page).not.toMatch(/deliveriesChanged[^\n]*return reload\(\)/);
        expect(page).not.toMatch(/onClose=\{\(\) => \{ setScanner\(false\);/);
        // The DeliveryTab under the scanner (paused) skips its 15 s poll; the scanner's events and its closing reload it.
        expect(tab).toMatch(/const pausedRef = useRef\(paused\);\s+pausedRef\.current = paused;/);
        expect(tab).toMatch(/const h = setInterval\(\(\) => \{ if \(!pausedRef\.current\) refresh\(\); \}, 15000\);/);
        expect(tab).not.toMatch(/setInterval\(refresh, 15000\)/);
    });

    it('no regression: «Entrega»\'s own deliveries and undos still reload the list at once; the scanner still calls onChanged', () => {
        // showOutcome (immediate mode, «Entregar» on the card, «Entregar de todas formas»): the list right away.
        expect(tab).toMatch(/if \(o\.result === 'delivered'\) scheduleReload\(\);\s+refreshRef\.current\(\);/);
        expect(tab).toMatch(/onResult: \(o, card\) => \{ showOutcome\(o, card\.serviceId\); \},/);
        // «Deshacer» (the list's and the verdict card's): the list and the page totals.
        expect(tab).toMatch(/addToast\(tx\('meals\.undone', 'Entrega deshecha'\), 'success'\);\s+setOutcome\(\(o\) => \(o\?\.verdict\?\.delivery_id === deliveryId \? null : o\)\);\s+refreshRef\.current\(\); reload\(\);/);
        expect(tab).toMatch(/onUndo=\{undo\} onDismiss=/);
        // The phone scanner reports every delivery and undo through onChanged.
        const scanner = fs.readFileSync(path.join(ADMIN, 'MealScanner.tsx'), 'utf8');
        const body = scanner.slice(scanner.indexOf('export function MealScanner('));
        expect(body).toMatch(/if \(good\) \{ loadStats\(\); onChanged\?\.\(\); \}/);
        expect(body).toMatch(/await conferenceApi\.undoMealDelivery\(deliveryId\); if \(aliveRef\.current\) \{ setOutcome\(null\); loadStats\(\); onChanged\?\.\(\); \}/);
        expect(body).toMatch(/if \(o\.result === 'delivered'\) \{ feedback\.current\.ok\(\); onChanged\?\.\(\); \}/);
    });

    it('every new message exists in es, en and pt, with its placeholders; the replaced ones are gone', () => {
        for (const lang of ['es', 'en', 'pt'] as const) {
            const t = translations[lang];
            for (const k of ['meals.undo.confirm.meal', 'meals.undo.meal']) {
                expect(t[k], `${lang} ${k}`).toContain('{meal}');
                expect(t[k], `${lang} ${k}`).toContain('{name}');
            }
            for (const k of ['meals.delivered.what', 'meals.already.what']) expect(t[k], `${lang} ${k}`).toContain('{meal}');
            expect(t['meals.undo.person'], lang).toBeUndefined();
            expect(t['meals.undo.confirm.person'], lang).toBeUndefined();
        }
        expect(translations.en['meals.undo.confirm.meal']).toBe('Undo the delivery of {meal} to {name}?');
        expect(translations.pt['meals.delivered.what']).toBe('Entregue: {meal}');
    });
});

describe('createThrottle: the page totals during a rush in the phone scanner', () => {
    it('a lone call runs at once; the calls of the next 2 s fold into ONE run at its end; none is lost', () => {
        vi.useFakeTimers();
        try {
            const fn = vi.fn();
            const t = createThrottle(fn, 2000);
            t.run();
            expect(fn).toHaveBeenCalledTimes(1);           // at once (a deleted service must leave the list now)
            t.run(); t.run(); t.run();                     // a family scanned back to back
            expect(fn).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(1999);
            expect(fn).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(1);
            expect(fn).toHaveBeenCalledTimes(2);           // one run for the three
            vi.advanceTimersByTime(2000);
            expect(fn).toHaveBeenCalledTimes(2);           // nothing folded: no extra run
            t.run();
            expect(fn).toHaveBeenCalledTimes(3);           // a lone call again: at once
            vi.advanceTimersByTime(10000);
            expect(fn).toHaveBeenCalledTimes(3);
        } finally { vi.useRealTimers(); }
    });
    it('now() (the scanner closing) runs at once and covers the folded run; cancel() (unmount) drops it', () => {
        vi.useFakeTimers();
        try {
            const fn = vi.fn();
            const t = createThrottle(fn, 2000);
            t.run(); t.run();
            expect(fn).toHaveBeenCalledTimes(1);
            t.now();
            expect(fn).toHaveBeenCalledTimes(2);
            vi.advanceTimersByTime(5000);
            expect(fn).toHaveBeenCalledTimes(2);           // the folded run was covered by now()
            t.run();                                       // window after now() is over: at once
            expect(fn).toHaveBeenCalledTimes(3);
            t.run();
            t.cancel();
            vi.advanceTimersByTime(5000);
            expect(fn).toHaveBeenCalledTimes(3);           // dropped
            t.run();
            expect(fn).toHaveBeenCalledTimes(4);           // still usable after cancel (StrictMode remount)
        } finally { vi.useRealTimers(); }
    });
});

describe('the phone scanner\'s verdict card: status, name and every button on every phone from 320×460 up', () => {
    // The live round (short phones: iPhone SE in Safari 375×548 and 375×667, a first-generation SE 320×460,
    // an iPhone 13 in Safari 390×664) found the person's name and location scrolled away, a not-entitled head
    // cut mid-phrase («Sin derecho a Jue 08/10 · Almuerzo — …») with no cue, «Sí, entregar» / «Cancelar» hidden
    // (320×460) or clipped (375×548). These pin the structure that keeps them; the geometry itself was
    // measured in Chromium on the real scanner frame at 8 phone sizes (see the round's report).
    const SCANNER = fs.readFileSync(path.join(ADMIN, 'MealScanner.tsx'), 'utf8');
    const body = SCANNER.slice(SCANNER.indexOf('export function MealScanner('));
    const card = SCANNER.slice(SCANNER.indexOf('export function VerdictCard('), SCANNER.indexOf('// ── Confirmation card (2.16.0)'));
    const NAME = 'María de los Ángeles Rodríguez-Villavicencio Santamaría';
    const FIELDS = [
        { key: '@name', label: 'Nombre completo', value: NAME },
        { key: 'location', label: 'Localidad', value: 'Bogotá' },
        { key: 'dieta', label: 'Dieta', value: 'Vegetariana' },
    ];
    const person = { id: 1, name: NAME, location: 'Bogotá', location_id: 2, fields: FIELDS };
    const styleOf = (html: string, attr: string) => (/style="([^"]*)"/.exec(tagWith(html, attr))?.[1] || '');
    const big = (result: string, verdict: any = {}, extra: any = {}) => render(
        <VerdictCard large service={LUNCH} language="es" onUndo={() => { }} onForce={() => { }} {...extra} outcome={{ result, seq: 1, at: 0, verdict: { person, ...verdict } }} />);

    it('the slot is bounded by the camera area like the confirmation card\'s: anchored at the bottom, never past the top', () => {
        expect(body).toMatch(/<div data-verdict-slot="" style=\{\{ position: 'absolute', left: SAFE_LEFT, right: SAFE_RIGHT, bottom: 12, top: 8, zIndex: 4, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', pointerEvents: 'none' \}\}>\s+<div ref=\{cardBoxRef\} style=\{\{ pointerEvents: 'auto', minHeight: 0, maxHeight: '100%', display: 'flex', flexDirection: 'column' \}\}>\s+<VerdictCard outcome=\{outcome\} service=\{service\} large /);
        expect(body).not.toMatch(/bottom: 12, zIndex: 4 \}\}>/);
    });

    it('the order: the head (never shrinks) → the NAME (its own line, never in the part that scrolls) → the rest (scrolls) → the buttons', () => {
        const html = big('delivered', { delivery_id: 3, method: 'override' });
        const at = (attr: string) => html.indexOf(attr);
        expect(at('data-verdict-row=""')).toBeGreaterThan(0);
        expect(at('data-verdict-head=""')).toBeGreaterThan(at('data-verdict-row=""'));
        expect(at('data-verdict-title=""')).toBeGreaterThan(at('data-verdict-head=""'));
        expect(at('data-verdict-meal=""')).toBeGreaterThan(at('data-verdict-title=""'));
        expect(at('data-verdict-method="override"')).toBeGreaterThan(at('data-verdict-meal=""'));
        expect(at('data-verdict-body=""')).toBeGreaterThan(at('data-verdict-method="override"'));
        expect(at('data-verdict-name=""')).toBeGreaterThan(at('data-verdict-body=""'));
        expect(at('data-verdict-scroll=""')).toBeGreaterThan(at('data-verdict-name=""'));
        expect(at('data-verdict-actions=""')).toBeGreaterThan(at('data-verdict-scroll=""'));
        // The name is its own element (the configured «@name»), NOT inside the part that scrolls; the rest is.
        expect(textOf(html, 'data-verdict-name=""')).toBe(NAME);
        expect(tagWith(html, 'data-verdict-name=""')).toContain('data-field="@name"');
        const scroll = elementOf(html, 'data-verdict-scroll=""');
        expect(scroll).not.toContain(NAME);
        expect(scroll).not.toContain('data-field="@name"');
        expect(scroll).toContain('Bogotá');
        expect(scroll).toContain('Vegetariana');
        expect(elementOf(html, 'data-verdict-actions=""')).toContain('data-verdict-undo=""');
        // A server without the configured entries (2.15): the plain name, the location line in the part that scrolls.
        const plain = render(<VerdictCard large service={LUNCH} language="es" onUndo={() => { }} outcome={{ result: 'delivered', seq: 1, at: 0, verdict: { delivery_id: 3, person: { id: 1, name: 'Ana Pérez', location: 'Bogotá', location_id: 2, family_group: 'Pérez', reg_code: 'ABCD234XYZ' } } }} />);
        expect(textOf(plain, 'data-verdict-name=""')).toBe('Ana Pérez');
        expect(textOf(plain, 'data-verdict-scroll=""')).toBe('Bogotá · Grupo familiar: Pérez · ABCD234XYZ');
        // «Ya recibió»: when, in the part that scrolls; nothing to press, no empty bar.
        const already = big('already', { delivered_at: '2026-12-11 07:10:00', delivered_by: 'cocina1' });
        expect(elementOf(already, 'data-verdict-scroll=""')).toContain('Recibió a las');
        expect(already).not.toContain('data-verdict-actions=""');
        expect(textOf(already, 'data-verdict-name=""')).toBe(NAME);
    });

    it('who gives way: the rest first (100000), then the question (1000, never below its buttons), the name last (1, never below one line); the head and the buttons never', () => {
        const html = big('delivered', { delivery_id: 3 });
        expect(styleOf(html, 'data-verdict="delivered"')).toBe('display:flex;flex-direction:column;max-height:100%;min-height:0;overflow-y:auto');
        expect(styleOf(html, 'data-verdict-row=""')).toBe('display:flex;align-items:flex-start;gap:16px;flex-shrink:0');
        expect(styleOf(html, 'data-verdict-head=""')).toBe('min-width:0;flex:1 1 0%');
        expect(styleOf(html, 'data-verdict-body=""')).toBe('display:flex;flex-direction:column;min-height:0;flex:0 1 auto;padding-left:64px');
        expect(styleOf(html, 'data-verdict-name=""')).toBe('flex:0 1 auto;min-height:1.15em;overflow-y:auto;font-size:26px;font-weight:900;line-height:1.15;overflow-wrap:anywhere;margin-top:6px');
        expect(styleOf(html, 'data-verdict-scroll=""')).toBe('position:relative;overflow-y:auto;min-height:0;flex:0 100000 auto');
        expect(styleOf(html, 'data-verdict-actions=""')).toBe('flex-shrink:0');
        expect(VERDICT_FIT.ask).toMatchObject({ flex: '0 1000 auto', minHeight: VERDICT_ASK_MIN });
        // Its smallest box holds its buttons: border 2 + padding 2 × 12 + 44 px (and the ≤ 520 px rule: 2 + 2 × 8 + 44).
        expect(VERDICT_ASK_MIN).toBe(2 + 2 * 12 + 44);
        expect(VERDICT_CSS).toContain('[data-verdict-ask] { padding: 8px !important; gap: 6px !important; min-height: 62px !important; }');
        expect(VERDICT_FIT.askText).toEqual({ flex: '0 1 auto', minHeight: 0, overflow: 'hidden' });
        expect(VERDICT_FIT.askButtons).toEqual({ display: 'flex', gap: 8, flexShrink: 0 });
        // Every button: a 44 px target.
        expect(VERDICT_FIT.target).toEqual({ minHeight: 44 });
        expect(VERDICT_FIT.askButton).toMatchObject({ minHeight: 44, minWidth: 0 });
        expect(styleOf(html, 'data-verdict-undo=""')).toBe('min-height:44px');
        expect(styleOf(big('not_entitled'), 'data-force=""')).toBe('min-height:44px');
    });

    it('the head is short: «Entregado», «Ya recibió», «Sin derecho» — then WHAT (the meal line), never the whole service in the title', () => {
        const ne = big('not_entitled');
        // It used to be «Sin derecho a Jue 08/10 · Almuerzo — Almuerzo campestre en la finca del congreso», cut mid-phrase.
        expect(textOf(ne, 'data-verdict-title=""')).toBe('Sin derecho');
        expect(textOf(ne, 'data-verdict-meal=""')).toBe('Almuerzo — Campestre · Lun 01/03');
        expect(ne).not.toContain('Sin derecho a ');
        for (const [lang, short] of [['es', 'Sin derecho'], ['en', 'Not entitled'], ['pt', 'Sem direito']] as const) {
            expect(translations[lang]['meals.verdict.not_entitled.short']).toBe(short);
        }
        expect(textOf(big('delivered', { delivery_id: 3 }), 'data-verdict-title=""')).toBe('Entregado');
        expect(textOf(big('already'), 'data-verdict-title=""')).toBe('Ya recibió');
        // «Entrega» too (2.17.0 live round, the confirmation OFF: «Sin derecho a Jue 08/10 · Almuerzo — Almuerzo
        // campestre en la finca del congreso» took 8 lines, 240 px, in the 144 px beside the icon at 320×460, and pushed
        // «Entregar de todas formas» 570 px below the fold): the short status, then the meal line like «Entregado».
        const entrega = render(<VerdictCard service={LUNCH} language="es" onForce={() => { }} outcome={{ result: 'not_entitled', seq: 1, at: 0, verdict: { person } }} />);
        expect(textOf(entrega, 'data-verdict-title=""')).toBe('Sin derecho');
        expect(textOf(entrega, 'data-verdict-meal=""')).toBe('Almuerzo — Campestre · Lun 01/03');
        expect(tagWith(entrega, 'data-verdict-meal=""')).toContain('title="Almuerzo — Campestre · Lun 01/03"');
        expect(noStyle(entrega)).not.toContain('Sin derecho a ');
        // The server's service first, like «Entregado» (the selected one only when the answer has none).
        const answered = render(<VerdictCard service={LUNCH} language="es" onForce={() => { }} outcome={{ result: 'not_entitled', seq: 1, at: 0, verdict: { person, service: BREAKFAST } }} />);
        expect(textOf(answered, 'data-verdict-meal=""')).toBe('Desayuno · Vie 11/12');
        // The whole sentence stays the armed question's accessible name; the long title is gone from every language.
        for (const lang of ['es', 'en', 'pt'] as const) expect((translations as any)[lang]['meals.verdict.not_entitled'], lang).toBeUndefined();
    });

    it('the meal line: the meal, the label, the day as parts — on a short screen ONE line where only the label gives way; the whole text as its title; a tap shows it WHOLE', () => {
        const html = big('delivered', { delivery_id: 3 });
        expect(textOf(html, 'data-verdict-meal-name=""')).toBe('Almuerzo');
        expect(textOf(html, 'data-verdict-meal-label=""')).toBe(' — Campestre');
        expect(textOf(html, 'data-verdict-meal-day=""')).toBe(' · Lun 01/03');
        expect(tagWith(html, 'data-verdict-meal=""')).toContain('title="Almuerzo — Campestre · Lun 01/03"');
        // No label: no empty part.
        const plain = render(<VerdictCard large service={BREAKFAST} language="es" onUndo={() => { }} outcome={{ result: 'delivered', seq: 1, at: 0, verdict: { delivery_id: 3, person } }} />);
        expect(plain).not.toContain('data-verdict-meal-label=""');
        expect(textOf(plain, 'data-verdict-meal=""')).toBe('Desayuno · Vie 11/12');
        // Up to three lines; short screens: one, where only the label shrinks (an ellipsis), the meal and the day stay.
        expect(VERDICT_CSS).toContain('[data-verdict][data-verdict-large] [data-verdict-meal] { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; overflow-wrap: anywhere; margin-top: 2px; cursor: pointer; }');
        const short = VERDICT_CSS.slice(VERDICT_CSS.indexOf('@media (max-height: 700px)'), VERDICT_CSS.indexOf('@media (max-height: 520px)'));
        expect(short).toContain('[data-verdict][data-verdict-large] [data-verdict-meal]:not([data-open]) { display: flex; align-items: baseline; white-space: pre; }');
        expect(short).toContain('[data-verdict][data-verdict-large] [data-verdict-meal]:not([data-open]) > * { flex-shrink: 0; }');
        expect(short).toContain('[data-verdict][data-verdict-large] [data-verdict-meal]:not([data-open]) > [data-verdict-meal-label] { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }');
        // Tapped: WHOLE at every height — and the tap does not dismiss the card. 2.17.0 live round at 320×460: a fixed
        // 2.8em cap cut it mid-phrase with no cue («Almuerzo — Almuerzo / campestre en la finca del», the day gone).
        expect(VERDICT_CSS).toContain('[data-verdict][data-verdict-large] [data-verdict-meal][data-open] { display: block; -webkit-line-clamp: none; }');
        expect(VERDICT_CSS).not.toMatch(/\[data-open\][^{]*\{[^}]*max-height/);
        expect(card).toMatch(/data-open=\{mealOpen \? '' : undefined\} style=\{openMealStyle\(meal\.cap\)\} onScroll=\{meal\.onScroll\}\s+onMouseDown=\{large \? undefined : keepFocus\} onClick=\{\(e\) => \{ e\.stopPropagation\(\); meal\.setOpen\(\(o\) => !o\); \}\}>/);
        // …and it never costs the name, the status or the buttons a line: when the card lacks room it keeps its whole
        // lines that fit, «Más abajo» under them, and scrolls (useOpenMeal; closed again when not one fits).
        expect(card).toMatch(/const meal = useOpenMeal\(seq, \(\) => Math\.max\(clippedPx\(nameRef\.current\), clippedPx\(cardRef\.current\)\)\);/);
        expect(card).toMatch(/<div ref=\{meal\.ref\} className=\{cls\} title=\{what\} data-verdict-meal=""/);
        expect(card).toMatch(/\{mealOpen && meal\.cap != null && <MoreCue attr="data-verdict-meal-more" atEnd=\{meal\.atEnd\} style=\{VERDICT_MORE_STYLE\} \/>\}/);
        expect(card).toMatch(/<div ref=\{cardRef\} className=\{`rounded-3xl border-2 shadow-xl \$\{TONE_CLS\[tone\]\} p-6 /);
        expect(card).not.toMatch(/setMealOpen/);
        expect(card).toMatch(/<div ref=\{nameRef\} style=\{!large && !withFields \? VERDICT_BOX\.plainName : F\.name\} data-verdict-name=""/);
        expect(card).toMatch(/useEffect\(\(\) => \{ setArmed\(false\); \}, \[seq\]\);/);
        expect(openMealStyle(null)).toBeUndefined();
        expect(openMealStyle(41)).toEqual({ maxHeight: 41, overflowY: 'auto' });
        expect(clippedPx({ scrollHeight: 69, clientHeight: 54 })).toBe(15);
        expect(clippedPx({ scrollHeight: 54, clientHeight: 54 })).toBe(0);
        expect(clippedPx(null)).toBe(0);
    });

    it('short screens: a tighter card, the body under the icon at full width (the name gets the room); the shortest tighter still and fold the counters', () => {
        const html = big('delivered', { delivery_id: 3 });
        expect(html).toContain('data-verdict-large=""');
        expect(html).toMatch(/<style>[^<]*@media \(max-height: 700px\)[^<]*<\/style><\/div>$/);
        const short = VERDICT_CSS.slice(VERDICT_CSS.indexOf('@media (max-height: 700px)'), VERDICT_CSS.indexOf('@media (max-height: 520px)'));
        for (const rule of [
            '[data-verdict][data-verdict-large] { padding: 16px !important; }',
            '[data-verdict][data-verdict-large] [data-verdict-row] { gap: 10px !important; align-items: center !important; }',
            '[data-verdict][data-verdict-large] [data-verdict-icon] { font-size: 36px !important; width: 36px !important; }',
            '[data-verdict][data-verdict-large] [data-verdict-title] { font-size: 24px !important; }',
            '[data-verdict][data-verdict-large] [data-verdict-meal] { font-size: 16px !important; }',
            '[data-verdict][data-verdict-large] [data-verdict-body] { padding-left: 0 !important; }',
            '[data-verdict][data-verdict-large] [data-verdict-name] { font-size: 22px !important; margin-top: 8px !important; }',
            '[data-verdict][data-verdict-large] [data-verdict-ask] { margin-top: 8px !important; margin-left: 0 !important; }',
        ]) expect(short, rule).toContain(rule);
        const shortest = VERDICT_CSS.slice(VERDICT_CSS.indexOf('@media (max-height: 520px)'), VERDICT_CSS.indexOf('@media (max-width: 380px)'));
        for (const rule of [
            '[data-verdict][data-verdict-large] { padding: 12px !important; }',
            '[data-verdict][data-verdict-large] [data-verdict-icon] { font-size: 30px !important; width: 30px !important; }',
            '[data-verdict][data-verdict-large] [data-verdict-title] { font-size: 22px !important; }',
            '[data-verdict][data-verdict-large] [data-verdict-meal] { font-size: 15px !important; }',
            '[data-verdict][data-verdict-large] [data-verdict-name] { font-size: 20px !important; margin-top: 6px !important; }',
        ]) expect(shortest, rule).toContain(rule);
        // Narrow phones: «Sí, entregar» and «Cancelar» keep to one row.
        expect(VERDICT_CSS).toContain('@media (max-width: 380px) {\n  [data-verdict][data-verdict-large] [data-verdict-ask] button { font-size: 11px !important; letter-spacing: 0.03em !important; padding-left: 6px !important; padding-right: 6px !important; }\n}');
        // Tall screens: the question box spans the card under the icon too (its two buttons side by side).
        expect(VERDICT_FIT.ask).toMatchObject({ marginLeft: -64 });
        expect(VERDICT_FIT.body).toMatchObject({ paddingLeft: 64 });
        // A first-generation SE (320×460): the counters fold away while a verdict is shown.
        expect(SCANNER_CSS).toContain('@media (max-height: 520px) { [data-meal-scanner][data-verdict-open] [data-scanner-counters] { display: none !important; } }');
        expect(body).toMatch(/data-verdict-open=\{outcome && !confirm\.card && !confirm\.checking \? '' : undefined\}/);
        expect(SCANNER_CSS).toContain('@media (max-height: 700px) { [data-meal-scanner][data-card-open] [data-scanner-counters] { display: none !important; } }');
    });

    it('armed: «Sí, entregar» / «Cancelar» side by side under the question, which gives way by WHOLE sentences; the dialog keeps the whole question', () => {
        const yes = <button type="button" data-force-confirm="">Sí, entregar</button>;
        const no = <button type="button" data-force-cancel="">Cancelar</button>;
        const LABEL = `${NAME} no tiene derecho a Lun 01/03 · Almuerzo — Campestre. ¿Entregar de todas formas? Quedará registrado como autorizado.`;
        const at = (level: number) => render(<ForceAsk level={level} label={LABEL} yes={yes} no={no} />);
        for (const level of [0, 1, 2]) {
            const html = at(level);
            expect(html, `level ${level}`).toMatch(/^<div class="rounded-2xl bg-amber-950\/10 border border-amber-950\/20" style="[^"]*" role="alertdialog" aria-label="[^"]+" data-verdict-ask="">/);
            expect(tagWith(html, 'data-verdict-ask=""')).toContain(`aria-label="${LABEL}"`);
            // The buttons are always there, in one row: «Sí, entregar» first.
            expect(html).toMatch(/<div style="display:flex;gap:8px;flex-shrink:0"><button type="button" data-force-confirm="">Sí, entregar<\/button><button type="button" data-force-cancel="">Cancelar<\/button><\/div><\/div>$/);
        }
        expect(textOf(at(0), 'data-verdict-ask-text="0"')).toBe('¿Entregar de todas formas? Quedará registrado como autorizado.');
        expect(textOf(at(1), 'data-verdict-ask-text="1"')).toBe('¿Entregar de todas formas?');
        expect(at(2)).not.toContain('data-verdict-ask-text');
        expect(ASK_LEVELS).toBe(3);
        expect(styleOf(at(0), 'data-verdict-ask=""')).toBe('display:flex;flex-direction:column;gap:8px;flex:0 1000 auto;min-height:70px;margin-top:12px;margin-left:-64px;padding:12px');
        // Clipped = it needs more than 2 px beyond its room (a subpixel is not a cut).
        expect(askClipped({ scrollHeight: 40, clientHeight: 40 })).toBe(false);
        expect(askClipped({ scrollHeight: 42, clientHeight: 40 })).toBe(false);
        expect(askClipped({ scrollHeight: 43, clientHeight: 40 })).toBe(true);
        expect(askClipped({ scrollHeight: 20, clientHeight: 0 })).toBe(true);
        expect(askClipped(null)).toBe(false);
        // While it is cut, the person's other data give way first — all of them — and only then a sentence.
        expect(askGiveWay(false, true)).toBeNull();
        expect(askGiveWay(true, true)).toBe('details');
        expect(askGiveWay(true, false)).toBe('sentence');
        // Wiring: after every layout; never below none; a new card, a new question, the meal opened or closed,
        // another window size: everything again (the whole question, the details back).
        expect(card).toMatch(/useLayoutEffect\(\(\) => \{ setAskLevel\(0\); setDropDetails\(false\); \}, \[seq, armed, mealOpen\]\);/);
        expect(card).toMatch(/useLayoutEffect\(\(\) => \{\s+if \(!large\) return;\s+const way = askGiveWay\(askClipped\(askTextRef\.current\), !!restFit\.ref\.current\);\s+if \(way === 'details'\) setDropDetails\(true\);\s+else if \(way === 'sentence'\) setAskLevel\(\(l\) => Math\.min\(ASK_LEVELS - 1, l \+ 1\)\);/);
        expect(card).toMatch(/\{details && !dropDetails && detailsShown\(restFit\.fit\) && \(/);
        expect(card).toMatch(/const refit = \(\) => \{ setAskLevel\(0\); setDropDetails\(false\); \};\s+window\.addEventListener\('resize', refit\);/);
        expect(card).toMatch(/<ForceAsk askRef=\{askRef\} textRef=\{askTextRef\} level=\{askLevel\} label=\{confirmText\}\s+yes=\{yes\(VERDICT_FIT\.askButton, /);
        expect(card).toMatch(/no=\{no\(VERDICT_FIT\.askButton, /);
        // «Sí, entregar» forces, «Cancelar» only disarms (no regression of the two-step override).
        expect(card).toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); setArmed\(false\); onForce\(outcome\); \}\}\s+className=\{cls\} style=\{style\} data-force-confirm=""/);
        expect(card).toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); setArmed\(false\); \}\}\s+className=\{cls\} style=\{style\} data-force-cancel=""/);
        for (const lang of ['es', 'en', 'pt'] as const) {
            expect(translations[lang]['meals.force.confirm.ask'], lang).toBeTruthy();
            expect(translations[lang]['meals.force.confirm.note'], lang).toBeTruthy();
            expect(translations[lang]['meals.force.confirm.short'], lang).toBeUndefined();
        }
        expect(translations.en['meals.force.confirm.ask']).toBe('Deliver anyway?');
        expect(translations.pt['meals.force.confirm.note']).toBe('Ficará registrado como autorizado.');
    });

    it('the rest of the person\'s data end on a WHOLE line, «Más abajo ↓» under the cut — never a lone label or the tops of a value (was: a fade)', () => {
        // Skeptic of the live round: a lone faded «LOCALIDAD» (320×460, 375×548 armed), a full-strength «EMAIL» label
        // with only the tops of its value (390×844), «EMAIL» slivers (375×667, 390×664 armed). The fade is gone: the
        // part is cut on a whole line (lib/mealConfirm detailsCut, pinned with the confirmation card).
        expect(card).not.toMatch(/maskImage|VERDICT_MORE_FADE|detailsFit/);
        expect(detailsStyle(VERDICT_FIT.scroll, { height: 59, hidden: 2 })).toEqual({ ...VERDICT_FIT.scroll, maxHeight: 59 });
        expect(detailsStyle(VERDICT_FIT.scroll, null)).toEqual(VERDICT_FIT.scroll);
        expect(card).toMatch(/<div ref=\{restFit\.ref\} onScroll=\{restFit\.onScroll\} style=\{detailsStyle\(F\.scroll, restFit\.fit\)\} data-verdict-scroll="" data-more=\{detailsMore\(restFit\.fit\) \? '' : undefined\}>/);
        expect(card).toMatch(/const F = large \? VERDICT_FIT : VERDICT_BOX;/);
        expect(card).toMatch(/\{details && !dropDetails && detailsMore\(restFit\.fit\) && <MoreCue attr="data-verdict-more" atEnd=\{restFit\.atEnd\} style=\{VERDICT_MORE_STYLE\} \/>\}/);
        expect(VERDICT_MORE_STYLE).toEqual({ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase' });
        // Measured again for a new card, the question armed, the meal line opened, closed or cut.
        expect(card).toMatch(/const restFit = useWholeEntries\(`\$\{seq\}:\$\{armed\}:\$\{mealOpen\}:\$\{meal\.cap\}`\);/);
        // The card's own lines are entries (the configured ones carry data-field).
        const plain = render(<VerdictCard large service={LUNCH} language="es" onUndo={() => { }} outcome={{ result: 'delivered', seq: 1, at: 0, verdict: { delivery_id: 3, person: { id: 1, name: 'Ana Pérez', location: 'Bogotá', location_id: 2, family_group: null, reg_code: 'ABCD234XYZ' } } }} />);
        expect(plain).toMatch(/<div class="text-sm font-semibold opacity-90 mt-1" data-entry="">Bogotá · ABCD234XYZ<\/div>/);
        expect(big('already', { delivered_at: '2026-12-11 07:10:00' })).toMatch(/<div class="text-sm font-bold mt-1" data-entry="">Recibió a las/);
        expect(render(<VerdictCard large service={LUNCH} language="es" outcome={{ result: 'unknown', code: 'ZZZZ234567', seq: 1, at: 0, verdict: {} }} />)).toMatch(/data-entry="">ZZZZ234567<\/div>/);
        expect(elementOf(big('delivered', { delivery_id: 3 }), 'data-verdict-scroll=""')).toMatch(/data-field="location"/);
        // Not measured yet (the server render): uncut, no «Más abajo».
        expect(big('delivered', { delivery_id: 3 })).not.toContain('data-verdict-more');
    });

    it('«Entrega»: the same order, bounded — capped by the tab to the visible band; desktop as before, a phone at the card\'s whole width (live round, 320×460: 888 px tall, «Villavicen/cio», «Deshacer» 450 px below the fold)', () => {
        const html = render(<VerdictCard service={BREAKFAST} language="es" onUndo={() => { }} outcome={{ result: 'delivered', seq: 1, at: 0, verdict: { delivery_id: 3, person: { id: 1, name: 'Ana Pérez', location: 'Bogotá', location_id: 2 } } }} />);
        // The order: the head (status, meal) → the NAME → the rest (gives way, scrolls) → «Deshacer».
        const at = (attr: string) => html.indexOf(attr);
        expect(at('data-verdict-head=""')).toBeGreaterThan(at('data-verdict-row=""'));
        expect(at('data-verdict-meal=""')).toBeGreaterThan(at('data-verdict-title=""'));
        expect(at('data-verdict-body=""')).toBeGreaterThan(at('data-verdict-meal=""'));
        expect(at('data-verdict-name=""')).toBeGreaterThan(at('data-verdict-body=""'));
        expect(at('data-verdict-scroll=""')).toBeGreaterThan(at('data-verdict-name=""'));
        expect(at('data-verdict-actions=""')).toBeGreaterThan(at('data-verdict-scroll=""'));
        expect(textOf(html, 'data-verdict-title=""')).toBe('Entregado');
        expect(textOf(html, 'data-verdict-meal=""')).toBe('Desayuno · Vie 11/12');
        expect(textOf(html, 'data-verdict-name=""')).toBe('Ana Pérez');
        expect(textOf(html, 'data-verdict-scroll=""')).toBe('Bogotá');
        expect(elementOf(html, 'data-verdict-actions=""')).toContain('>Deshacer</button>');
        expect(noStyle(html)).not.toContain('data-verdict-large');
        // Who gives way (VERDICT_BOX): the rest first (100000), the name last (1, never below one line); the head
        // and the buttons never. The tab brings the card into view with its margins.
        expect(styleOf(html, 'data-verdict="delivered"')).toBe('display:flex;flex-direction:column;max-height:100%;min-height:0;overflow-y:auto;scroll-margin-top:12px;scroll-margin-bottom:12px');
        expect(styleOf(html, 'data-verdict-row=""')).toBe('flex-shrink:0');
        expect(styleOf(html, 'data-verdict-body=""')).toBe('display:flex;flex-direction:column;min-height:0;flex:0 1 auto;padding-left:52px');
        expect(styleOf(html, 'data-verdict-scroll=""')).toBe('position:relative;overflow-y:auto;min-height:0;flex:0 100000 auto');
        expect(styleOf(html, 'data-verdict-actions=""')).toBe('flex-shrink:0');
        // The name (the configured «@name», 22 px heavy as PersonFields showed it) breaks between words — inside one
        // only when a single word is wider than the card.
        const configured = render(<VerdictCard service={BREAKFAST} language="es" onUndo={() => { }} outcome={{ result: 'delivered', seq: 1, at: 0, verdict: { delivery_id: 3, person: { id: 1, name: 'Ana Pérez', fields: [{ key: '@name', label: '', value: 'Ana Pérez' }] } } }} />);
        expect(styleOf(configured, 'data-verdict-name=""')).toBe('flex:0 1 auto;min-height:1.15em;overflow-y:auto;font-size:22px;font-weight:900;line-height:1.15;overflow-wrap:break-word;margin-top:4px');
        // Desktop as before: p-5, a 36 px icon (text-4xl), a 16 px gap, the title text-2xl, the meal whole, the body in
        // line with the title.
        expect(classesOf(tagWith(html, 'data-verdict="delivered"'))).toContain('p-5');
        expect(classesOf(tagWith(html, 'data-verdict-row=""'))).toBe('flex items-start gap-4');
        expect(styleOf(html, 'data-verdict-icon=""')).toBe('flex-shrink:0;width:36px;text-align:center');
        expect(classesOf(tagWith(html, 'data-verdict-icon=""'))).toContain('text-4xl');
        expect(classesOf(tagWith(html, 'data-verdict-title=""'))).toContain('text-2xl');
        expect(classesOf(tagWith(html, 'data-verdict-meal=""'))).toBe('text-base font-black leading-snug mt-0.5 break-words');
        expect(VERDICT_BOX.body.paddingLeft).toBe(36 + 16);
        expect(styleOf(html, 'data-verdict-undo=""')).toBe('min-height:44px');
        // A phone (≤ 600 px wide; a 320 px phone left 144 px beside the icon): a smaller icon beside the status, the
        // meal and the body at the card's whole width; the meal on one line where only its label gives way — the
        // meal and the day never cut (the day goes to a second line rather than past the edge).
        const phone = VERDICT_CSS.slice(VERDICT_CSS.indexOf('@media (max-width: 600px)'));
        for (const rule of [
            '[data-verdict]:not([data-verdict-large]) { padding: 16px !important; }',
            '[data-verdict]:not([data-verdict-large]) [data-verdict-row] { display: grid !important; grid-template-columns: auto minmax(0, 1fr); gap: 0 10px !important; align-items: center !important; }',
            '[data-verdict]:not([data-verdict-large]) [data-verdict-head] { display: contents; }',
            '[data-verdict]:not([data-verdict-large]) [data-verdict-icon] { font-size: 30px !important; width: 30px !important; margin-top: 0 !important; }',
            '[data-verdict]:not([data-verdict-large]) [data-verdict-meal], [data-verdict]:not([data-verdict-large]) [data-verdict-method] { grid-column: 1 / -1; }',
            '[data-verdict]:not([data-verdict-large]) [data-verdict-meal]:not([data-open]) { display: flex; flex-wrap: wrap; align-items: baseline; white-space: pre; }',
            '[data-verdict]:not([data-verdict-large]) [data-verdict-meal]:not([data-open]) > * { flex: 0 0 auto; }',
            '[data-verdict]:not([data-verdict-large]) [data-verdict-meal]:not([data-open]) > [data-verdict-meal-label] { flex: 1 1 0%; min-width: 0; overflow: hidden; text-overflow: ellipsis; }',
            '[data-verdict]:not([data-verdict-large]) [data-verdict-body] { padding-left: 0 !important; }',
        ]) expect(phone, rule).toContain(rule);
        // The narrowest (a 184 px line at 320): 14 px, and the closed line leaves out the meal's icon — the label then
        // keeps room for a whole «…» (with the icon it got 14 px and showed two dots of it).
        expect(phone).toContain('@media (max-width: 380px) {\n  [data-verdict]:not([data-verdict-large]) [data-verdict-meal] { font-size: 14px !important; }\n  [data-verdict]:not([data-verdict-large]) [data-verdict-meal]:not([data-open]) > [data-verdict-meal-icon] { display: none; }\n');
        // These rules never touch the phone scanner's card, and its rules never touch this one.
        for (const sel of phone.match(/^\s*\[data-verdict\][^{]*/gm) || []) expect(sel, sel).toContain(':not([data-verdict-large])');
        const scanner = VERDICT_CSS.slice(0, VERDICT_CSS.indexOf('@media (max-width: 600px)'));
        for (const sel of scanner.match(/^\s*\[data-verdict\][^{]*/gm) || []) expect(sel, sel).toContain('[data-verdict][data-verdict-large]');
        // The rules ship with the card (last child, no room).
        expect(html).toMatch(/<style>[^<]*@media \(max-width: 600px\)[^<]*<\/style><\/div>$/);
        // The meal tapped: whole, the card brought back into view; the scan input keeps the focus.
        expect(card).toMatch(/onMouseDown=\{large \? undefined : keepFocus\}/);
        expect(card).toMatch(/useEffect\(\(\) => \{ if \(mealOpen && !large && typeof window !== 'undefined'\) revealNearest\(cardRef\.current, window\); \}, \[mealOpen, meal\.cap, large\]\);/);
        // The tab caps it like its confirmation card (cardEssentials counts this card too).
        const tab = PAGE.slice(PAGE.indexOf('function DeliveryTab('), PAGE.indexOf('function DisplayFieldsDialog('));
        expect(tab).toMatch(/\? <div data-verdict-fit="" style=\{\{ display: 'flex', flexDirection: 'column', maxHeight: `var\(\$\{REVEAL_FIT_VAR\}, none\)` \}\}>\s+<VerdictCard outcome=\{outcome\} service=\{service\}/);
        expect(tab).not.toMatch(/<VerdictCard [^>]*\blarge\b/);
        // Armed (a tap away): «Sí, entregar» / «Cancelar» as 44 px targets in a box that comes into view — it opens
        // under the button that was tapped (iPhone SE: its buttons landed below the bottom edge). Live round, 320×460:
        // the box sat in the column indented under the icon (123 px wide) and held the whole sentence — 16 lines,
        // taller than the screen, so its nearest edge was its top and both buttons stayed below. Now it spans the
        // card, asks the short question (the card names the person and the service right above; the whole sentence
        // is the dialog's name) and, when it is still taller than the screen, its BUTTONS come into view (revealAsk).
        const entrega = card.slice(card.indexOf('// «Entrega» (VERDICT_BOX)'));
        expect(entrega).toMatch(/\{canForce && armed && \(\s+<DeliveryForceAsk askRef=\{askRef\} buttonsRef=\{askButtonsRef\} level=\{askLevel\} label=\{confirmText\}\s+yes=\{yes\(VERDICT_FIT\.target\)\} no=\{no\(VERDICT_FIT\.target\)\} \/>/);
        expect(VERDICT_BOX.ask).toEqual({ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, scrollMarginTop: REVEAL_MARGIN_PX, scrollMarginBottom: REVEAL_MARGIN_PX });
        expect(VERDICT_BOX.askButtons).toEqual({ display: 'flex', flexWrap: 'wrap', gap: 8, scrollMarginTop: REVEAL_MARGIN_PX, scrollMarginBottom: REVEAL_MARGIN_PX });
        // Not under the icon: a sibling of the body (the card's whole width), after it; the phone scanner's question
        // stays inside its body (ForceAsk, `large` only).
        expect(entrega.indexOf('{body}')).toBeLessThan(entrega.indexOf('{canForce && armed && ('));
        expect(card).toMatch(/\{large && canForce && armed && \(\s+<ForceAsk /);
        expect(card).toMatch(/const yes = \(style\?: React\.CSSProperties, cls = 'px-4 py-3 rounded-2xl bg-amber-950 text-amber-50 font-black text-xs uppercase tracking-widest disabled:opacity-50'\)/);
        expect(card).toMatch(/const no = \(style\?: React\.CSSProperties, cls = 'px-4 py-3 rounded-2xl bg-white\/60 text-amber-950 font-black text-xs uppercase tracking-widest'\)/);
        // Desktop as before: the box spans the card under the body, both sentences over the two 44 px buttons.
        const yes = <button type="button" style={{ minHeight: 44 }} data-force-confirm="">Sí, entregar</button>;
        const no = <button type="button" style={{ minHeight: 44 }} data-force-cancel="">Cancelar</button>;
        const LABEL = `${NAME} no tiene derecho a Lun 01/03 · Almuerzo — Campestre. ¿Entregar de todas formas? Quedará registrado como autorizado.`;
        const ask0 = render(<DeliveryForceAsk level={0} label={LABEL} yes={yes} no={no} />);
        expect(ask0).toMatch(/^<div class="mt-3 rounded-2xl bg-amber-950\/10 border border-amber-950\/20 p-3" style="flex-shrink:0;display:flex;flex-direction:column;gap:8px;scroll-margin-top:12px;scroll-margin-bottom:12px" role="alertdialog" aria-label="[^"]+" data-verdict-ask="">/);
        expect(tagWith(ask0, 'data-verdict-ask=""')).toContain(`aria-label="${LABEL}"`);
        expect(textOf(ask0, 'data-verdict-ask-text="0"')).toBe('¿Entregar de todas formas? Quedará registrado como autorizado.');
        expect(ask0).toMatch(/<div style="display:flex;flex-wrap:wrap;gap:8px;scroll-margin-top:12px;scroll-margin-bottom:12px" data-verdict-ask-buttons=""><button type="button" style="min-height:44px" data-force-confirm="">Sí, entregar<\/button><button type="button" style="min-height:44px" data-force-cancel="">Cancelar<\/button><\/div><\/div>$/);
    });

    it('«Entrega» armed, inside its cap (2.17.0 live round, the confirmation OFF: at 320×460 … 390×664 the status and the name sat above the top edge): the question gives way by WHOLE sentences, the buttons share a row, the card comes into view', () => {
        const yes = <button type="button" data-force-confirm="">Sí, entregar</button>;
        const no = <button type="button" data-force-cancel="">Cancelar</button>;
        const at = (level: number) => render(<DeliveryForceAsk level={level} label="L" yes={yes} no={no} />);
        // Level 1: the question alone; level 2: none — the buttons always, the dialog's name always whole.
        expect(textOf(at(1), 'data-verdict-ask-text="1"')).toBe('¿Entregar de todas formas?');
        expect(at(2)).not.toContain('data-verdict-ask-text');
        for (const level of [0, 1, 2]) {
            expect(at(level), `level ${level}`).toContain('<div style="display:flex;flex-wrap:wrap;gap:8px;scroll-margin-top:12px;scroll-margin-bottom:12px" data-verdict-ask-buttons=""><button type="button" data-force-confirm="">Sí, entregar</button><button type="button" data-force-cancel="">Cancelar</button></div>');
            expect(tagWith(at(level), 'data-verdict-ask=""'), `level ${level}`).toContain('aria-label="L"');
        }
        // One more sentence goes while the capped card lacks more than 2 px for it (the name or the card scrolling
        // inside itself), never past none; nothing lacking: it stays.
        expect(askStepDown(0, 0)).toBe(0);
        expect(askStepDown(0, 2)).toBe(0);
        expect(askStepDown(0, 3)).toBe(1);
        expect(askStepDown(1, 40)).toBe(2);
        expect(askStepDown(2, 40)).toBe(2);
        expect(askStepDown(ASK_LEVELS - 1, 999)).toBe(ASK_LEVELS - 1);
        // Wiring: after every layout while armed («Entrega» only), measured on the name and the card; reset for a new
        // card / question / meal line and on another window size (both cards now).
        expect(card).toMatch(/useLayoutEffect\(\(\) => \{\s+if \(large \|\| !armed\) return;\s+const next = askStepDown\(askLevel, Math\.max\(clippedPx\(nameRef\.current\), clippedPx\(cardRef\.current\)\)\);\s+if \(next !== askLevel\) setAskLevel\(next\);\s+\}\);/);
        expect(card).toMatch(/useLayoutEffect\(\(\) => \{ setAskLevel\(0\); setDropDetails\(false\); \}, \[seq, armed, mealOpen\]\);/);
        expect(card).toMatch(/useEffect\(\(\) => \{\s+if \(typeof window === 'undefined'\) return;\s+const refit = \(\) => \{ setAskLevel\(0\); setDropDetails\(false\); \};\s+window\.addEventListener\('resize', refit\);\s+return \(\) => window\.removeEventListener\('resize', refit\);\s+\}, \[\]\);/);
        // Brought into view once it has settled (the next frame), the CARD first (revealAsk).
        expect(card).toMatch(/useEffect\(\(\) => \{\s+if \(!armed \|\| large \|\| typeof window === 'undefined'\) return;\s+const reveal = \(\) => \{ revealAsk\(askRef\.current, window, askButtonsRef\.current, cardRef\.current\); \};\s+if \(typeof window\.requestAnimationFrame !== 'function'\) \{ reveal\(\); return; \}\s+const frame = window\.requestAnimationFrame\(reveal\);\s+return \(\) => window\.cancelAnimationFrame\(frame\);\s+\}, \[armed, large\]\);/);
        // A phone: the two buttons as wide as each other on one row (a row of their own only when not even their longest
        // words fit side by side); the narrowest: smaller labels and paddings. Desktop keeps them as they were.
        const phone = VERDICT_CSS.slice(VERDICT_CSS.indexOf('@media (max-width: 600px)'));
        expect(phone).toContain('  [data-verdict]:not([data-verdict-large]) [data-verdict-ask-buttons] > button { flex: 1 1 0%; }\n}');
        const narrowest = phone.slice(phone.indexOf('@media (max-width: 380px)'));
        expect(narrowest).toContain('[data-verdict]:not([data-verdict-large]) [data-verdict-ask] { padding: 8px !important; }');
        expect(narrowest).toContain('[data-verdict]:not([data-verdict-large]) [data-verdict-ask] button { font-size: 11px !important; letter-spacing: 0.03em !important; padding-left: 6px !important; padding-right: 6px !important; }');
        expect(VERDICT_CSS.slice(0, VERDICT_CSS.indexOf('@media (max-width: 600px)'))).not.toContain('[data-verdict-ask-buttons]');
    });

    it('«Entrega»\'s verdict (not armed) keeps its structure: a server without the configured entries, the configured name', () => {
        // A server without the configured entries (2.15): the plain name, the location line in the part that gives way.
        const plain = render(<VerdictCard service={LUNCH} language="es" onUndo={() => { }} outcome={{ result: 'delivered', seq: 1, at: 0, verdict: { delivery_id: 3, person: { id: 1, name: 'Ana Pérez', location: 'Bogotá', location_id: 2, family_group: 'Pérez', reg_code: 'ABCD234XYZ' } } }} />);
        expect(textOf(plain, 'data-verdict-name=""')).toBe('Ana Pérez');
        expect(textOf(plain, 'data-verdict-scroll=""')).toBe('Bogotá · Grupo familiar: Pérez · ABCD234XYZ');
        // …looking as it always did in «Entrega» (text-xl, bold; the line 2 px under it).
        expect(styleOf(plain, 'data-verdict-name=""')).toBe('flex:0 1 auto;min-height:1.15em;overflow-y:auto;font-size:20px;font-weight:700;line-height:1.4;overflow-wrap:break-word;margin-top:4px');
        expect(plain).toMatch(/<div class="text-sm font-semibold opacity-90 mt-0\.5" data-entry="">Bogotá · Grupo familiar: Pérez · ABCD234XYZ<\/div>/);
        // The configured entries: the name its own line, the rest in the part that gives way.
        const NAME_F = 'María de los Ángeles Rodríguez-Villavicencio Santamaría';
        const fields = render(<VerdictCard service={LUNCH} language="es" onUndo={() => { }} outcome={{ result: 'delivered', seq: 1, at: 0, verdict: { delivery_id: 3, person: { id: 1, name: NAME_F, fields: [{ key: '@name', label: '', value: NAME_F }, { key: 'dieta', label: 'Dieta', value: 'Vegetariana' }] } } }} />);
        expect(textOf(fields, 'data-verdict-name=""')).toBe(NAME_F);
        expect(elementOf(fields, 'data-verdict-scroll=""')).not.toContain(NAME_F);
        expect(elementOf(fields, 'data-verdict-scroll=""')).toContain('Vegetariana');
    });
});

describe('«Últimas entregas»: the inline «¿Deshacer…?» scrolls itself into view (iPhone SE: its buttons landed at the bottom edge)', () => {
    function stub({ reduce = false, scroll = true, throws = false } = {}) {
        const calls: any[] = [];
        const el: any = scroll ? { scrollIntoView: (o: any) => { if (throws) throw new Error('detached'); calls.push(o); } } : {};
        const win = { matchMedia: (q: string) => ({ matches: reduce && q === '(prefers-reduced-motion: reduce)' }) };
        return { el, win, calls };
    }
    it('revealNearest: the nearest edge — nothing moves when it is on screen, one below the fold comes up; smooth, instant under reduced motion; never throws', () => {
        const a = stub();
        expect(revealNearest(a.el, a.win)).toBe(true);
        expect(a.calls).toEqual([{ block: 'nearest', inline: 'nearest', behavior: 'smooth' }]);
        const r = stub({ reduce: true });
        expect(revealNearest(r.el, r.win)).toBe(true);
        expect(r.calls).toEqual([{ block: 'nearest', inline: 'nearest', behavior: 'auto' }]);
        expect(revealNearest(null, a.win)).toBe(false);
        expect(revealNearest(a.el, null)).toBe(false);
        expect(revealNearest(stub({ scroll: false }).el, a.win)).toBe(false);
        expect(revealNearest(stub({ throws: true }).el, a.win)).toBe(false);
    });
    it('the question keeps a margin from the edges and is brought into view when it opens (not on every re-render), its focus untouched', () => {
        const html = render(<RecentDeliveries service={BREAKFAST} rows={ROWS} undoAsk={2} onAskUndo={() => { }} onUndo={() => { }} />);
        expect(REVEAL_MARGIN_PX).toBe(12);
        expect(tagWith(html, 'data-recent-undo-ask=""')).toContain('style="display:flex;flex-direction:column;gap:8px;scroll-margin-top:12px;scroll-margin-bottom:12px"');
        // 2.17.0 live round at 320×460: the question's own edge came in and the row's name stayed under the admin
        // header — now the WHOLE ROW is brought in (revealAsk with the row as its card; pinned in the block below).
        expect(RECENT_SRC).toMatch(/import \{ REVEAL_MARGIN_PX, revealAsk, undoAskStepDown \} from "\.\.\/lib\/mealConfirm";/);
        expect(RECENT_SRC).toMatch(/useEffect\(\(\) => \{\s+if \(undoAsk == null \|\| typeof window === 'undefined'\) return;\s+const reveal = \(\) => \{ revealAsk\(askRef\.current, window, askButtonsRef\.current, rowRef\.current\); \};[\s\S]{0,200}window\.requestAnimationFrame\(reveal\);[\s\S]{0,120}\}, \[undoAsk\]\);/);
        expect(RECENT_SRC).toMatch(/<div ref=\{askRef\} className="mt-2 rounded-xl bg-rose-50 px-3 py-2" style=\{\{ display: 'flex', flexDirection: 'column', gap: 8, \.\.\.margins \}\} role="alertdialog"/);
        expect(RECENT_SRC).toMatch(/const margins = \{ scrollMarginTop: REVEAL_MARGIN_PX, scrollMarginBottom: REVEAL_MARGIN_PX \};/);
        // revealNearest never focuses: the USB wedge keeps typing into the scan input.
        const lib = fs.readFileSync(path.resolve(ADMIN, '../lib/mealConfirm.ts'), 'utf8');
        const fn = lib.slice(lib.indexOf('export function revealNearest('), lib.indexOf('// ── Phone: which badge'));
        expect(fn).not.toMatch(/focus/);
        // «Entrega»'s decision slot reveals through the same function (unchanged behaviour).
        expect(lib).toMatch(/el\.style\?\.setProperty\(REVEAL_FIT_VAR, fit == null \? 'none' : `\$\{fit\}px`\);\s+\} catch \{ \/\* no CSSOM \*\/ \}\s+return revealNearest\(el, win\);/);
    });
});

describe('«Entrega»: «¿Entregar de todas formas?» shows its buttons on the shortest phone (live round, 320×460)', () => {
    /** The question → the page's scroller (it clips: the band under the admin header) → nothing. */
    function dom({ top = 89, bottom = 571, band = { top: 77, bottom: 460 }, buttons = true, throws = false } = {}) {
        const calls: any[] = [];
        const main: any = { getBoundingClientRect: () => band, parentElement: null, overflowY: 'auto' };
        const ask: any = {
            getBoundingClientRect: () => { if (throws) throw new Error('detached'); return { top, bottom }; },
            parentElement: main, scrollIntoView: (o: any) => calls.push(['question', o]),
        };
        const row: any = buttons ? { scrollIntoView: (o: any) => calls.push(['buttons', o]) } : null;
        const win: any = { innerHeight: 460, visualViewport: null, getComputedStyle: (a: any) => ({ overflowY: a.overflowY }), matchMedia: () => ({ matches: false }) };
        return { ask, row, win, calls };
    }
    const nearest = { block: 'nearest', inline: 'nearest', behavior: 'smooth' };
    it('revealAsk: the whole question when it fits in the visible band, else its BUTTONS — so «Sí, entregar» / «Cancelar» are never left below the edge', () => {
        // Measured: 482 px of question under a 383 px band (77..460) — its nearest edge was its top, the buttons below.
        const tall = dom();
        expect(revealAsk(tall.ask, tall.win, tall.row)).toBe(true);
        expect(tall.calls).toEqual([['buttons', nearest]]);
        // It fits with a margin at each end: the whole question (as before, revealNearest).
        const fits = dom({ top: 300, bottom: 480 });
        expect(revealAsk(fits.ask, fits.win, fits.row)).toBe(true);
        expect(fits.calls).toEqual([['question', nearest]]);
        // The edge: the band less both margins (383 − 2 × 12 = 359) still fits; one px more does not.
        const edge = dom({ top: 100, bottom: 100 + 383 - 2 * REVEAL_MARGIN_PX });
        revealAsk(edge.ask, edge.win, edge.row);
        expect(edge.calls[0][0]).toBe('question');
        const over = dom({ top: 100, bottom: 101 + 383 - 2 * REVEAL_MARGIN_PX });
        revealAsk(over.ask, over.win, over.row);
        expect(over.calls[0][0]).toBe('buttons');
        // Reduced motion: instant.
        const still = dom();
        still.win.matchMedia = (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' });
        revealAsk(still.ask, still.win, still.row);
        expect(still.calls).toEqual([['buttons', { ...nearest, behavior: 'auto' }]]);
        // No buttons given, or no layout: the question (never a throw); nothing to reveal: false.
        const lone = dom({ buttons: false });
        revealAsk(lone.ask, lone.win, lone.row);
        expect(lone.calls).toEqual([['question', nearest]]);
        const detached = dom({ throws: true });
        expect(revealAsk(detached.ask, detached.win, detached.row)).toBe(true);
        expect(detached.calls).toEqual([['question', nearest]]);
        expect(revealAsk(null, tall.win, tall.row)).toBe(false);
        expect(revealAsk(tall.ask, null, tall.row)).toBe(false);
    });
    it('revealAsk with its card: the whole CARD when it fits in the visible band (the status and the name with the question), else as before', () => {
        // Live round (the confirmation OFF, 320×460 … 390×664): the question's own edge was brought in and the status and
        // the name stayed above the top edge. The card its tab capped fits: it comes into view whole.
        // The question sits IN the card, which scrolls inside itself when it must (overflow-y: auto): the band is the
        // one the page shows the card in (77..460 under the admin header), never the card's own box.
        const inCard = (top: number, bottom: number, o: { askTop?: number; askBottom?: number } = {}) => {
            const d = dom({ top: o.askTop ?? top + 216, bottom: o.askBottom ?? bottom - 18 });
            const main = d.ask.parentElement;
            const card: any = { getBoundingClientRect: () => ({ top, bottom }), parentElement: main, overflowY: 'auto', scrollIntoView: (x: any) => d.calls.push(['card', x]) };
            d.ask.parentElement = card;
            return { ...d, card };
        };
        // Measured live at 320×460 (the confirmation OFF): the 353 px card at 125.5..478.5 after «Entregar de todas
        // formas» was scrolled to the bottom edge — the question's own band was cut at the card's top (310 px left), so
        // the question came in and the status and the name stayed where they were. The card fits the 359 px: it comes in.
        const capped = inCard(125.5, 478.5);
        expect(revealAsk(capped.ask, capped.win, capped.row, capped.card)).toBe(true);
        expect(capped.calls).toEqual([['card', nearest]]);
        // The edge: the band less both margins (383 − 24 = 359) still fits; one px more does not.
        const edge = inCard(90, 90 + 383 - 2 * REVEAL_MARGIN_PX);
        revealAsk(edge.ask, edge.win, edge.row, edge.card);
        expect(edge.calls).toEqual([['card', nearest]]);
        // A card taller than the band (no cap could hold its essentials): the question when it fits, else its buttons.
        const tallCard = inCard(90, 91 + 383 - 2 * REVEAL_MARGIN_PX, { askTop: 300, askBottom: 480 });
        revealAsk(tallCard.ask, tallCard.win, tallCard.row, tallCard.card);
        expect(tallCard.calls).toEqual([['question', nearest]]);
        const both = inCard(-200, 900, { askTop: 89, askBottom: 571 });
        revealAsk(both.ask, both.win, both.row, both.card);
        expect(both.calls).toEqual([['buttons', nearest]]);
        // No card given: exactly as before; a card that throws: the question.
        const none = dom({ top: 300, bottom: 480 });
        revealAsk(none.ask, none.win, none.row, null);
        expect(none.calls).toEqual([['question', nearest]]);
        const broken = dom({ top: 300, bottom: 480 });
        revealAsk(broken.ask, broken.win, broken.row, { getBoundingClientRect: () => { throw new Error('detached'); }, parentElement: null, scrollIntoView: () => broken.calls.push(['card']) });
        expect(broken.calls).toEqual([['question', nearest]]);
    });
    it('the armed question: the whole sentence as the dialog\'s name, the short question shown, the buttons a 44 px row with a margin from the edges', () => {
        const ana = { id: 1, name: 'Ana Pérez', location: 'Bogotá', location_id: 2 };
        // Armed through the server render is not possible (a tap): the pieces it is made of.
        const card = fs.readFileSync(path.join(ADMIN, 'MealScanner.tsx'), 'utf8');
        // 2.36.5: the same armed question also answers «Dejar pasar igual» (a group not called yet) with its own sentence.
        expect(card).toMatch(/const confirmText = !canForce \? '' : groupWait\s*\? tx\('meals\.group\.confirm', .*\s*: tx\('meals\.force\.confirm', '\{name\} no tiene derecho a \{service\}\. ¿Entregar de todas formas\? Quedará registrado como autorizado\.', \{ name: p\.name, service: svc \}\);/);
        expect(es('meals.force.confirm.ask', '')).toBe('¿Entregar de todas formas?');
        expect(es('meals.force.confirm.note', '')).toBe('Quedará registrado como autorizado.');
        // Not armed: «Entregar de todas formas» in the column under the title, as before.
        const html = render(<VerdictCard service={LUNCH} language="es" onForce={() => { }} outcome={{ result: 'not_entitled', seq: 1, at: 0, verdict: { person: ana } }} />);
        expect(elementOf(html, 'data-verdict-actions=""')).toContain('data-force=""');
        expect(noStyle(html)).not.toContain('data-verdict-ask');
    });
});

describe('the camera\'s aim hint hides while a card reaches it (390×664: a card\'s top edge cut its letters in half)', () => {
    it('coversHint: hidden exactly while the card\'s box starts above the hint\'s bottom', () => {
        expect(coversHint({ bottom: 191 }, { top: 190.5, height: 300 })).toBe(true);
        expect(coversHint({ bottom: 191 }, { top: 191, height: 300 })).toBe(false);
        expect(coversHint({ bottom: 191 }, { top: 0, height: 0 })).toBe(false);        // no card
        expect(coversHint(null, { top: 0, height: 10 })).toBe(false);                  // no hint (camera off)
        expect(coversHint({ bottom: 10 }, null)).toBe(false);
    });
    it('wiring: both slots\' boxes are measured, again whenever they or the camera area change size (ResizeObserver) and when the pill appears; each line keeps its place', () => {
        const SCANNER = fs.readFileSync(path.join(ADMIN, 'MealScanner.tsx'), 'utf8');
        const body = SCANNER.slice(SCANNER.indexOf('export function MealScanner('));
        expect(body.match(/<div ref=\{cardBoxRef\} style=\{\{ pointerEvents: 'auto', minHeight: 0, maxHeight: '100%', display: 'flex', flexDirection: 'column' \}\}>/g)?.length).toBe(2);
        expect(body).toMatch(/const slotKind = confirm\.card \|\| confirm\.checking \? 'card' : outcome \? 'verdict' : '';/);
        expect(body).toMatch(/const pillOn = cam === 'on' && !playBlocked && !!health && health\.state !== 'stalled';/);
        expect(body).toMatch(/useLayoutEffect\(\(\) => \{\s+const box = cardBoxRef\.current;\s+if \(!slotKind \|\| !box\) \{ setCovered\(NO_CAMERA_LINE_COVERED\); return; \}\s+const rect = [^\n]+\s+const check = \(\) => \{\s+const now = coveredCameraLines\(\{ hint: rect\(hintRef\), pill: rect\(pillRef\), focus: rect\(focusHintRef\) \}, box\.getBoundingClientRect\(\)\);\s+setCovered\(\(was\) => \(sameCameraLines\(was, now\) \? was : now\)\);\s+\};\s+check\(\);\s+if \(typeof ResizeObserver === 'undefined'\) return;\s+const ro = new ResizeObserver\(check\);\s+ro\.observe\(box\);\s+if \(cameraAreaRef\.current\) ro\.observe\(cameraAreaRef\.current\);\s+return \(\) => ro\.disconnect\(\);\s+\}, \[slotKind, cam, pillOn\]\);/);
        expect(body).toMatch(/<div ref=\{hintRef\} data-scanner-aim-hint="" style=\{\{ position: 'absolute', top: 12, [^}]*visibility: covered\.hint \? 'hidden' : undefined \}\}>\{tx\('meals\.scanner\.aim', 'Apunta al código de barras del participante'\)\}<\/div>/);
        // 2.17.0 live round at 412×915: the offline / error card's top edge ran through «En pausa» (the pill under the
        // aiming frame), its lower half hidden — the aim hint's twin. The pill and the focus hint under it hide too.
        expect(body).toMatch(/<ScanPill health=\{health\} tx=\{tx\} pillRef=\{pillRef\} covered=\{covered\.pill\} \/>/);
        expect(body).toMatch(/<div ref=\{focusHintRef\} data-scanner-focus-hint="" style=\{\{ [^}]*visibility: covered\.focus \? 'hidden' : undefined \}\}>\s+\{tx\('meals\.scanner\.focus\.hint', /);
        expect(body).toMatch(/<div ref=\{cameraAreaRef\} className="relative flex-1 min-h-0 overflow-hidden" data-camera-area=""/);
    });
    it('coveredCameraLines: the aim hint, the heartbeat pill and the focus hint, each hidden exactly while the card\'s box reaches it (412×915: «En pausa» half under the card)', () => {
        // Measured at 412×915 (E3 offline / E4 error card): the card's top at y 552.2, «En pausa»'s pill ending at 556.
        const box = { top: 552.2, height: 320 };
        expect(coveredCameraLines({ hint: { bottom: 191 }, pill: { bottom: 556 }, focus: { bottom: 590 } }, box)).toEqual({ hint: false, pill: true, focus: true });
        // Clear of the card (6.5–17 px gaps at other sizes): all shown.
        expect(coveredCameraLines({ hint: { bottom: 191 }, pill: { bottom: 545 }, focus: { bottom: 552 } }, box)).toEqual({ hint: false, pill: false, focus: false });
        // A card reaching the top (the aim hint too); no card; lines not rendered (camera off, a stalled pill).
        expect(coveredCameraLines({ hint: { bottom: 191 }, pill: { bottom: 545 }, focus: { bottom: 552 } }, { top: 100, height: 700 })).toEqual({ hint: true, pill: true, focus: true });
        expect(coveredCameraLines({ hint: { bottom: 191 }, pill: { bottom: 545 } }, { top: 0, height: 0 })).toEqual(NO_CAMERA_LINE_COVERED);
        expect(coveredCameraLines({ hint: null, pill: undefined, focus: null }, box)).toEqual(NO_CAMERA_LINE_COVERED);
        expect(NO_CAMERA_LINE_COVERED).toEqual({ hint: false, pill: false, focus: false });
        expect(sameCameraLines({ hint: true, pill: false, focus: true }, { hint: true, pill: false, focus: true })).toBe(true);
        for (const k of ['hint', 'pill', 'focus'] as const) expect(sameCameraLines(NO_CAMERA_LINE_COVERED, { ...NO_CAMERA_LINE_COVERED, [k]: true }), k).toBe(false);
        // The pill hidden keeps its place (visibility), its text and state; shown, exactly as before.
        const shown = render(<ScanPill health={{ state: 'paused', fps: 0 }} tx={es} />);
        const hidden = render(<ScanPill health={{ state: 'paused', fps: 0 }} tx={es} covered />);
        expect(tagWith(shown, 'data-scan-state="paused"')).not.toContain('visibility');
        expect(tagWith(hidden, 'data-scan-state="paused"')).toContain('visibility:hidden');
        expect(hidden.replace(';visibility:hidden', '')).toBe(shown);
        expect(textOf(hidden, 'data-scan-state="paused"')).toBe('En pausa');
    });
});

describe('«Últimas entregas» «¿Deshacer…?» at 320×460: the WHOLE row comes into view below the admin header (2.17.0 live round, r6)', () => {
    // Live (r5-2, 320×460): the question's own nearest edge came in (the row was 397 px, the band 383 px under the 77 px
    // admin header), and the admin header's edge sliced the row's name («Paula Andrea Galeano Rojas de», «Torre»).
    // Measured since (lab, r7): the row with its question and its buttons on one row is 348.6 px (Paula, the whole
    // question) or 321 px (María Fernanda…, the short one), inside 77..460 with a 12 px margin at each end.
    /** A row in the page's scroller, which clips under the admin header (77..460). */
    function rowIn(top: number, bottom: number, { band = { top: 77, bottom: 460 }, throws = false } = {}) {
        const calls: any[] = [];
        const scroller: any = { getBoundingClientRect: () => band, parentElement: null, overflowY: 'auto' };
        const row: any = { getBoundingClientRect: () => { if (throws) throw new Error('detached'); return { top, bottom }; }, parentElement: scroller, scrollIntoView: (o: any) => calls.push(['row', o]) };
        const ask: any = { getBoundingClientRect: () => ({ top: bottom - 170, bottom: bottom - 10 }), parentElement: row, scrollIntoView: (o: any) => calls.push(['question', o]) };
        const buttons: any = { scrollIntoView: (o: any) => calls.push(['buttons', o]) };
        const win: any = { innerHeight: 460, visualViewport: null, getComputedStyle: (a: any) => ({ overflowY: a.overflowY }), matchMedia: () => ({ matches: false }) };
        return { row, ask, buttons, win, calls };
    }
    const nearest = { block: 'nearest', inline: 'nearest', behavior: 'smooth' };

    it('undoAskStepDown: the short question while the row with the whole one is taller than the band less a margin at each end; never below it', () => {
        expect(UNDO_ASK_LEVELS).toBe(2);
        // Paula (the whole question, buttons on one row): 348.6 px ≤ 383 − 24 — the whole question stays.
        expect(undoAskStepDown(0, rowIn(99, 447.6).row, rowIn(99, 447.6).win)).toBe(0);
        // María Fernanda… (three-line name, three-line location, a seven-line question): 392 px — the short question.
        const tall = rowIn(60, 452);
        expect(undoAskStepDown(0, tall.row, tall.win)).toBe(1);
        // Already short: stays (nothing shorter; a row taller than the band on its own shows its question first).
        expect(undoAskStepDown(1, tall.row, tall.win)).toBe(1);
        expect(undoAskStepDown(1, rowIn(-400, 900).row, tall.win)).toBe(1);
        // The edge: the band less both margins (359) fits; 1 px over is rounding; 2 px over steps down.
        expect(undoAskStepDown(0, rowIn(89, 89 + 359).row, tall.win)).toBe(0);
        expect(undoAskStepDown(0, rowIn(89, 89 + 360).row, tall.win)).toBe(0);
        expect(undoAskStepDown(0, rowIn(89, 89 + 361).row, tall.win)).toBe(1);
        // The visible band is what counts: an on-screen keyboard (visual viewport 0..300) makes the same row too tall.
        const kb = rowIn(99, 447.6);
        expect(undoAskStepDown(0, kb.row, { ...kb.win, visualViewport: { offsetTop: 0, height: 300 } })).toBe(1);
        // No row, no window, a detached node: as it is.
        expect(undoAskStepDown(0, null, tall.win)).toBe(0);
        expect(undoAskStepDown(0, tall.row, null)).toBe(0);
        expect(undoAskStepDown(0, rowIn(60, 452, { throws: true }).row, tall.win)).toBe(0);
    });

    it('revealAsk with the row as its card: the WHOLE row (its name included) when it fits the band, else the question, else its buttons', () => {
        const fits = rowIn(-120, 228.6);         // opened at the bottom edge, its name above the band
        expect(revealAsk(fits.ask, fits.win, fits.buttons, fits.row)).toBe(true);
        expect(fits.calls).toEqual([['row', nearest]]);
        // A row taller than the band on its own (a very long name and location): the question, as before.
        const tall = rowIn(-200, 400);
        revealAsk(tall.ask, tall.win, tall.buttons, tall.row);
        expect(tall.calls).toEqual([['question', nearest]]);
    });

    it('the question: whole (level 0, the server render) or short with the meal (level 1); the dialog always named by the whole one; «Deshacer» / «Cancelar» on ONE row, as wide as each other', () => {
        const html = render(<RecentDeliveries service={BREAKFAST} rows={ROWS} undoAsk={2} onAskUndo={() => { }} onUndo={() => { }} />);
        const beto = rowsOf(html)[1];
        const whole = '¿Deshacer la entrega de Desayuno · Vie 11/12 a Beto Gómez?';
        expect(beto).toContain(`<span class="text-xs font-bold text-rose-800 break-words" data-recent-undo-question="0">${whole}</span>`);
        expect(tagWith(beto, 'data-recent-undo-ask=""')).toContain(`aria-label="${whole}"`);
        expect(undoQuestion(es, BREAKFAST, whole, 1)).toBe('¿Deshacer la entrega de Desayuno?');
        expect(undoQuestion(en, LUNCH, 'x', 1)).toBe('Undo the delivery of Lunch?');
        expect(undoQuestion(es, BREAKFAST, whole, 0)).toBe(whole);
        expect(undoQuestion(es, null, whole, 1)).toBe(whole);                 // no service: nothing shorter to say
        // The buttons: their own row under the question (at 320 px «Cancelar» took a row of its own, 52 px more).
        const buttons = elementOf(beto, 'data-recent-undo-buttons=""');
        expect(tagWith(beto, 'data-recent-undo-buttons=""')).toContain('style="display:flex;gap:8px;scroll-margin-top:12px;scroll-margin-bottom:12px"');
        expect(buttons).toContain('data-recent-undo-confirm=""');
        expect(buttons).toContain('data-recent-undo-cancel=""');
        for (const attr of ['data-recent-undo-confirm=""', 'data-recent-undo-cancel=""']) {
            expect(tagWith(beto, attr)).toContain('style="flex:1 1 0%;min-width:0;min-height:44px;padding-left:8px;padding-right:8px;overflow-wrap:break-word"');
        }
        expect(UNDO_ASK_BUTTON_STYLE).toEqual({ flex: '1 1 0%', minWidth: 0, minHeight: 44, paddingLeft: 8, paddingRight: 8, overflowWrap: 'break-word' });
        // Every row keeps a margin from the band's edges when it is brought in.
        for (const row of rowsOf(html)) expect(row).toMatch(/^<li class="py-2\.5" style="scroll-margin-top:12px;scroll-margin-bottom:12px" data-recent-row=/);
        expect(translations.pt['meals.undo.confirm']).toBe('Desfazer a entrega de {service}?');
    });

    it('wiring: the question steps down after layout (again for a new question or another window size), then — the next frame — the row comes into view', () => {
        expect(RECENT_SRC).toMatch(/const \[askLevel, setAskLevel\] = useState\(0\);\s+useLayoutEffect\(\(\) => \{ setAskLevel\(0\); \}, \[undoAsk\]\);/);
        expect(RECENT_SRC).toMatch(/useLayoutEffect\(\(\) => \{\s+if \(undoAsk == null \|\| typeof window === 'undefined'\) return;\s+const next = undoAskStepDown\(askLevel, rowRef\.current, window\);\s+if \(next !== askLevel\) setAskLevel\(next\);\s+\}\);/);
        expect(RECENT_SRC).toMatch(/const refit = \(\) => setAskLevel\(0\);\s+window\.addEventListener\('resize', refit\);/);
        expect(RECENT_SRC).toMatch(/const reveal = \(\) => \{ revealAsk\(askRef\.current, window, askButtonsRef\.current, rowRef\.current\); \};\s+if \(typeof window\.requestAnimationFrame !== 'function'\) \{ reveal\(\); return; \}\s+const frame = window\.requestAnimationFrame\(reveal\);\s+return \(\) => window\.cancelAnimationFrame\(frame\);\s+\}, \[undoAsk\]\);/);
        expect(RECENT_SRC).toMatch(/<li key=\{r\.delivery_id\} ref=\{asking \? rowRef : undefined\} className="py-2\.5" style=\{margins\} data-recent-row=\{r\.delivery_id\}>/);
        expect(RECENT_SRC).toMatch(/<div ref=\{askButtonsRef\} style=\{\{ display: 'flex', gap: 8, \.\.\.margins \}\} data-recent-undo-buttons="">/);
        expect(RECENT_SRC).toMatch(/data-recent-undo-question=\{askLevel\}>\{undoQuestion\(tx, service, ask, askLevel\)\}<\/span>/);
        // Nothing takes the scan input's focus (the three buttons keep it).
        expect(RECENT_SRC.match(/onMouseDown=\{keepFocus\}/g)).toHaveLength(3);
    });
});
