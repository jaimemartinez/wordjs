/**
 * conference-manager 2.33.1 — FALLOS 141 and the host calendar.
 *
 * Pinned here (node environment, no DOM):
 *   - the values CM stores in Spanish («Efectivo» / «Transferencia», a switch's «Sí» / «No») are SHOWN in the
 *     admin's language, while the stored value never changes; the field dialog's title and subtitle are translated;
 *   - every new key exists in es / en / pt;
 *   - no CM screen draws the browser's date picker any more: every date goes through DateField (the host's
 *     DatePicker / DateTimePicker, core #584), whose companion input keeps a required date in the in-app check of
 *     2.31.1 (useFieldErrors).
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { paymentMethodLabel, shownFieldValue, switchLabel } from '../../../../../marketplace/plugins/conference-manager/client/lib/labels';
import { DateField } from '../../../../../marketplace/plugins/conference-manager/client/lib/DateField';
import { translations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';
import { PAYMENT_METHODS } from '../../../../../marketplace/plugins/conference-manager/client/lib/conference';
import { SWITCH_ON, SWITCH_OFF } from '../../../../../marketplace/plugins/conference-manager/client/lib/fields';

const CM = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager');
const trIn = (lang: 'es' | 'en' | 'pt') => (key: string, fallback: string) => translations[lang][key] || fallback;
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? (d.name === 'vendor' ? [] : walk(p)) : /\.(tsx?|jsx?)$/.test(d.name) ? [p] : [];
});

describe('values stored in Spanish, shown in the admin language', () => {
    it('forms of payment', () => {
        expect(PAYMENT_METHODS.map((m) => paymentMethodLabel(trIn('en'), m))).toEqual(['Cash', 'Bank transfer']);
        expect(PAYMENT_METHODS.map((m) => paymentMethodLabel(trIn('pt'), m))).toEqual(['Dinheiro', 'Transferência']);
        expect(PAYMENT_METHODS.map((m) => paymentMethodLabel(trIn('es'), m))).toEqual(['Efectivo', 'Transferencia']);
        expect(paymentMethodLabel(trIn('en'), 'Consignación')).toBe('Consignación');
        expect(paymentMethodLabel(trIn('en'), null)).toBe('');
    });
    it('a switch field’s answer', () => {
        expect(switchLabel(trIn('en'), true)).toBe('Yes');
        expect(switchLabel(trIn('pt'), false)).toBe('Não');
        expect(shownFieldValue(trIn('en'), { type: 'switch' }, SWITCH_ON)).toBe('Yes');
        expect(shownFieldValue(trIn('en'), { type: 'switch' }, SWITCH_OFF)).toBe('No');
        expect(shownFieldValue(trIn('en'), { type: 'text' }, 'Sí')).toBe('Sí');
        expect(shownFieldValue(trIn('en'), { type: 'switch' }, '')).toBe('');
    });
    it('every new key in es / en / pt, and the field dialog no longer hard-codes Spanish', () => {
        for (const k of ['payment.method.cash', 'payment.method.transfer', 'switch.yes', 'switch.no', 'add.field', 'edit.field', 'field.dialog.subtitle']) {
            for (const l of ['es', 'en', 'pt'] as const) expect(translations[l][k], `${l} ${k}`).toBeTruthy();
        }
        const page = fs.readFileSync(path.join(CM, 'client/admin/page.tsx'), 'utf8');
        expect(page).not.toMatch(/'Editar Campo' : 'Nuevo Campo'/);
        expect(page).not.toMatch(/>Configura las propiedades de este campo personalizado</);
        expect(page).not.toMatch(/\? SWITCH_ON : SWITCH_OFF\}/);
    });
});

describe('the host calendar instead of the browser’s', () => {
    it('no CM screen draws a native date or date-time input', () => {
        const offenders = walk(path.join(CM, 'client')).filter((f) => /<input[^>]*type=["{]["']?(date|datetime-local)\b/.test(fs.readFileSync(f, 'utf8')));
        expect(offenders.map((f) => path.relative(CM, f))).toEqual([]);
    });
    it('a required date keeps the in-app check: a companion input with its key and no tab stop', () => {
        const html = renderToStaticMarkup(<DateField id="d1" dataField="birthday" required value="" onChange={() => {}} />);
        expect(html).toContain('data-date-picker="date"');
        expect(html).toMatch(/<input[^>]*tabindex="-1"[^>]*aria-hidden="true"[^>]*required=""[^>]*data-field="birthday"/);
        const plain = renderToStaticMarkup(<DateField id="d2" value="2027-03-01" onChange={() => {}} />);
        expect(plain).not.toContain('<input');
        expect(plain).toContain('data-value="2027-03-01"');
        expect(renderToStaticMarkup(<DateField id="d3" withTime value="2027-03-01T09:30" onChange={() => {}} />)).toContain('data-date-picker="datetime"');
    });
});
