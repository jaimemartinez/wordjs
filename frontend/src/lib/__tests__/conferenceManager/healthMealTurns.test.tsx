/**
 * conference-manager 2.32.0 — «Condiciones de salud» and «Turnos de comida» on the client.
 *
 * Pinned here (node environment, no DOM): the answer helpers both forms use (ticking, «Otros» with its text,
 * «Ninguna» / «Prefiero no responder» exclusive, the in-place errors, the payload in the field's order); the
 * input itself (consent line, «Otros» revealing its box, the error in place — no `required` attribute); the
 * «Turnos» helpers (search, spread, slot line); the three languages carrying every new key; and the wiring that
 * keeps the health field out of every list, picker and quote (getFields, buildInscriptionPayload, the portal).
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import {
    HEALTH_OTHER, chooseSpecial, healthAnswerError, healthAnswerText, healthOptions, healthPayload, isHealthField, sameHealthAnswer, setOtherText, toggleCondition,
} from '../../../../../marketplace/plugins/conference-manager/client/lib/health';
import { HealthConditionsInput } from '../../../../../marketplace/plugins/conference-manager/client/lib/HealthConditionsInput';
import { groupSizeSpread, peopleFilter, turnLine, MEAL_GROUPS, GROUP_TONES } from '../../../../../marketplace/plugins/conference-manager/client/lib/mealTurns';
import { buildInscriptionPayload } from '../../../../../marketplace/plugins/conference-manager/client/lib/conference';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';
import { FIELD_TEMPLATES, fieldDependents } from '../../../../../marketplace/plugins/conference-manager/client/lib/fields';

const CM = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager');
const field = { name: 'health_conditions', label: 'Condiciones de salud', type: 'health', options: 'Diabetes, Embarazo, Asma o EPOC', is_required: 1 };

describe('health answer helpers', () => {
    it('ticks conditions, keeps «Otros» with its text, and the two special answers are exclusive', () => {
        let a = toggleCondition(null, 'Embarazo');
        a = toggleCondition(a, 'Diabetes');
        expect(a).toEqual({ conditions: ['Embarazo', 'Diabetes'], other: '', answer: 'list' });
        expect(healthPayload(field, a)).toEqual({ conditions: ['Diabetes', 'Embarazo'], other: '', answer: 'list' });
        a = setOtherText(a, 'migraña');
        expect(a!.conditions).toContain(HEALTH_OTHER);
        expect(healthAnswerText(healthPayload(field, a))).toBe('Diabetes, Embarazo, Otros: migraña');
        a = chooseSpecial(a, 'none');
        expect(a).toEqual({ conditions: [], other: '', answer: 'none' });
        expect(chooseSpecial(a, 'none')).toBeNull();
        expect(toggleCondition(chooseSpecial(null, 'declined'), 'Diabetes')).toEqual({ conditions: ['Diabetes'], other: '', answer: 'list' });
        expect(toggleCondition(toggleCondition(null, 'Diabetes'), 'Diabetes')).toBeNull();
    });
    it('says what is missing, in place', () => {
        expect(healthAnswerError(field, null)).toBe('required');
        expect(healthAnswerError({ is_required: 0 }, null)).toBeNull();
        expect(healthAnswerError(field, { conditions: [HEALTH_OTHER], other: ' ', answer: 'list' })).toBe('other');
        expect(healthAnswerError(field, { conditions: [], other: '', answer: 'declined' })).toBeNull();
    });
    it('reads its options without «Otros» and compares answers', () => {
        expect(healthOptions({ options: 'A, Otros, B' })).toEqual(['A', 'B']);
        expect(isHealthField({ type: 'health' })).toBe(true);
        expect(isHealthField({ name: 'age', type: 'number' })).toBe(false);
        expect(sameHealthAnswer(null, null)).toBe(true);
    });
});

describe('<HealthConditionsInput>', () => {
    const render = (value: any, error?: string) => renderToStaticMarkup(<HealthConditionsInput id="h" field={field} value={value} onChange={() => {}} error={error} />);
    it('shows the consent line, every condition, «Otros», «Ninguna» and «Prefiero no responder» — and no browser bubble', () => {
        const html = render(null);
        expect(html).toContain('data-health-consent');
        for (const c of ['Diabetes', 'Embarazo', 'Asma o EPOC', 'Otros', 'Ninguna', 'Prefiero no responder']) expect(html).toContain(c);
        expect(html).not.toContain('required');
        expect(html).not.toContain('data-health-other');
    });
    it('«Otros» reveals its box; an error is said under the field', () => {
        const html = render({ conditions: [HEALTH_OTHER], other: '', answer: 'list' }, 'Escribe cuál es la otra condición.');
        expect(html).toContain('data-health-other');
        expect(html).toContain('data-field-error');
        expect(html).toContain('role="alert"');
        expect(html).toContain('Escribe cuál es la otra condición.');
        expect(html).toContain('aria-invalid="true"');
    });
});

describe('«Turnos» helpers', () => {
    it('filters people (accents ignored), measures the spread and writes a slot', () => {
        const rows = [{ name: 'Lucía Pérez', location: 'Norte', group: 'A' }, { name: 'Jorge', location: 'Sur', group: 'B' }];
        expect(peopleFilter(rows, 'lucia', '')).toHaveLength(1);
        expect(peopleFilter(rows, 'sur', 'A')).toHaveLength(0);
        expect(groupSizeSpread({ A: 80, B: 81, C: 80, D: 79, E: 80, F: 80 })).toBe(2);
        expect(turnLine({ start: '12:15', end: '12:23' })).toBe('12:15–12:23');
        expect(turnLine({ start: '12:15', end: '12:15' })).toBe('12:15');
        expect(MEAL_GROUPS.every(g => GROUP_TONES[g])).toBe(true);
    });
});

describe('wiring', () => {
    it('the inscription payload never carries the health field as a string', () => {
        const p = buildInscriptionPayload([{ name: 'first_name' }, field as any], { first_name: 'Ana', health_conditions: 'Diabetes' }, null);
        expect(p).toEqual({ first_name: 'Ana' });
    });
    it('the templates and the delete warnings know both new fields', () => {
        expect(FIELD_TEMPLATES.map(t => t.key)).toEqual(expect.arrayContaining(['age', 'health']));
        expect(fieldDependents(field as any).map(d => d.key)).toContain('fields.dep.health');
        expect(fieldDependents({ name: 'age', role: 'age' } as any).map(d => d.key)).toContain('fields.dep.age');
    });
    it('every new key is in Spanish, English and Portuguese', () => {
        const es = Object.keys(translations.es).filter(k => k.startsWith('turns.') || k.startsWith('health.') || k.startsWith('staff.section.health'));
        expect(es.length).toBeGreaterThan(60);
        for (const k of es) { expect(translations.en[k], k).toBeTruthy(); expect(translations.pt[k], k).toBeTruthy(); }
    });
    it('lists, pickers and the quote leave the health field out; the portal sends it as its own object', () => {
        const conf = fs.readFileSync(path.join(CM, 'client/lib/conference.ts'), 'utf8');
        expect(conf).toMatch(/opts\.health \|\| !Array\.isArray\(list\) \? list : list\.filter\(\(f\) => !isHealthField\(f\)\)/);
        const portal = fs.readFileSync(path.join(CM, 'client/portal/CoordinatorPortal.tsx'), 'utf8');
        expect(portal).toContain('filter(([k]) => k !== HEALTH_FIELD)');
        expect(portal).toContain('fields={listFields}');
        expect(portal).not.toMatch(/fields=\{fields\}/);
    });
});

describe('2.36.9 «Tipo de sangre» and «EPS»: two more optional parts of the health answer', async () => {
    const H = await import('../../../../../marketplace/plugins/conference-manager/client/lib/health');
    const I = await import('../../../../../marketplace/plugins/conference-manager/client/lib/HealthConditionsInput');
    it('the list: the eight groups and «No sabe», the same as the server; a typed «a-» is «A−»', () => {
        expect([...H.BLOOD_TYPES]).toEqual(['A+', 'A−', 'B+', 'B−', 'AB+', 'AB−', 'O+', 'O−', 'No sabe']);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const server = require(path.join(CM, 'server/health.js'));
        expect(server.BLOOD_TYPES).toEqual([...H.BLOOD_TYPES]);
        expect(H.EPS_MAX).toBe(server.MAX_EPS);
        expect(H.bloodTypeOf('a-')).toBe('A−');
        expect(H.bloodTypeOf(' ab+ ')).toBe('AB+');
        expect(H.bloodTypeOf('no sabe')).toBe('No sabe');
        expect(H.bloodTypeOf('C+')).toBe('');
    });
    it('independent of the conditions: ticking, «Ninguna» and «Otros» keep them; clearing everything is null', () => {
        let a = H.setBloodType(null, 'O+');
        expect(a).toEqual({ conditions: [], other: '', answer: 'list', blood_type: 'O+' });
        expect(H.conditionsAnswered(a)).toBe(false);
        a = H.setEps(a, 'Sura');
        a = H.toggleCondition(a, 'Diabetes');
        expect(a).toEqual({ conditions: ['Diabetes'], other: '', answer: 'list', blood_type: 'O+', eps: 'Sura' });
        a = H.chooseSpecial(a, 'none');
        expect(a).toEqual({ conditions: [], other: '', answer: 'none', blood_type: 'O+', eps: 'Sura' });
        a = H.chooseSpecial(a, 'none'); // «Ninguna» again: the conditions part is unanswered, the rest stays
        expect(a).toEqual({ conditions: [], other: '', answer: 'list', blood_type: 'O+', eps: 'Sura' });
        a = H.setOtherText(a, 'migraña');
        expect(a).toMatchObject({ conditions: [HEALTH_OTHER], other: 'migraña', blood_type: 'O+', eps: 'Sura' });
        expect(H.setEps(H.setBloodType(H.setBloodType(null, 'A+'), ''), '')).toBeNull();
        expect(H.toggleCondition(H.toggleCondition(H.setEps(null, 'Sura'), 'Diabetes'), 'Diabetes')).toEqual({ conditions: [], other: '', answer: 'list', eps: 'Sura' });
    });
    it('the payload and the text carry them only when given; a required field still asks for the conditions', () => {
        expect(healthPayload(field, { conditions: ['Embarazo'], other: '', answer: 'list', blood_type: 'B−', eps: '  Nueva EPS ' }))
            .toEqual({ conditions: ['Embarazo'], other: '', answer: 'list', blood_type: 'B−', eps: 'Nueva EPS' });
        expect(healthPayload(field, { conditions: [], other: '', answer: 'list', eps: 'Sura' })).toEqual({ conditions: [], other: '', answer: 'list', eps: 'Sura' });
        expect(healthPayload(field, { conditions: [], other: '', answer: 'declined', blood_type: 'No sabe' })).toEqual({ conditions: [], other: '', answer: 'declined', blood_type: 'No sabe' });
        // Without them the payload is exactly what it was (old answers compare the same).
        expect(healthPayload(field, { conditions: ['Diabetes'], other: '', answer: 'list' })).toEqual({ conditions: ['Diabetes'], other: '', answer: 'list' });
        expect(healthAnswerText({ conditions: ['Diabetes'], other: '', answer: 'list', blood_type: 'O−', eps: 'Sura' })).toBe('Diabetes · Tipo de sangre: O− · EPS: Sura');
        expect(healthAnswerText({ conditions: [], other: '', answer: 'list', eps: 'Sura' })).toBe('EPS: Sura');
        expect(healthAnswerText({ conditions: [], other: '', answer: 'none', blood_type: 'A+' })).toBe('Ninguna · Tipo de sangre: A+');
        expect(healthAnswerError(field, { conditions: [], other: '', answer: 'list', blood_type: 'A+' })).toBe('required');
        expect(healthAnswerError({ is_required: 0 }, { conditions: [], other: '', answer: 'list', blood_type: 'A+' })).toBeNull();
    });
    it('the input: «Tipo de sangre» with the styled select (no native <select>), «EPS» as plain text, both optional, in es/en/pt', () => {
        const html = renderToStaticMarkup(<HealthConditionsInput id="h" field={field} value={{ conditions: [], other: '', answer: 'list', blood_type: 'AB+', eps: 'Sura' }} onChange={() => {}} />);
        expect(html).toContain('data-health-extras');
        expect(html).toContain('data-health-blood');
        expect(html).not.toMatch(/<select/);
        expect(html).toContain('AB+');
        expect(html).toMatch(/<input[^>]*type="text"[^>]*autoComplete="off"[^>]*data-health-eps=""[^>]*value="Sura"/);
        expect(html).not.toContain('<datalist');
        expect(html).toContain('Tipo de sangre');
        expect(html).toContain('(opcional)');
        expect(html).not.toContain('required');
        for (const L of [I.HEALTH_LABELS_ES, I.HEALTH_LABELS_EN, I.HEALTH_LABELS_PT]) {
            for (const k of ['blood', 'bloodPick', 'bloodUnknown', 'eps', 'epsPlaceholder', 'optional']) expect((L as any)[k], k).toBeTruthy();
        }
        // A screen that passes only the older labels still gets the new ones.
        const old = renderToStaticMarkup(<HealthConditionsInput id="h" field={field} value={null} onChange={() => {}} labels={{ consent: 'c', other: 'o', otherPlaceholder: 'p', none: 'n', declined: 'd' }} />);
        expect(old).toContain('Tipo de sangre');
        expect(renderToStaticMarkup(<HealthConditionsInput id="h" field={field} value={null} onChange={() => {}} labels={I.HEALTH_LABELS_EN} />)).toContain('Blood type');
    });
    it('every screen that answers the health field gets them, in its language: the admin (tx keys ×3), the consent page, the portal', () => {
        for (const k of ['health.blood', 'health.blood.pick', 'health.blood.unknown', 'health.eps', 'health.eps.placeholder', 'health.optional']) {
            for (const l of ['es', 'en', 'pt'] as const) expect((translations as any)[l][k], `${l} ${k}`).toBeTruthy();
        }
        const page = fs.readFileSync(path.join(CM, 'client/admin/page.tsx'), 'utf8');
        expect(page).toContain("blood: tx('health.blood', 'Tipo de sangre')");
        expect(page).toContain("eps: tx('health.eps', 'EPS')");
        const consent = fs.readFileSync(path.join(CM, 'client/portal/consent/ConsentPage.tsx'), 'utf8');
        expect(consent).toContain('HEALTH_LABELS_EN, HEALTH_LABELS_PT } from "../../lib/HealthConditionsInput"');
        // The portal renders the same input (Spanish labels, which now carry the two parts).
        expect(fs.readFileSync(path.join(CM, 'client/portal/CoordinatorPortal.tsx'), 'utf8')).toContain('<HealthConditionsInput');
    });
});
