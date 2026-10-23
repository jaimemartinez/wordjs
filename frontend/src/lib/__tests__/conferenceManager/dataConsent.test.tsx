/**
 * conference-manager 2.33.0 — «Autorización de datos» on the client.
 *
 * Pinned here (node environment, no DOM): both languages carry every key; the representative's line the consent
 * page shows is byte for byte the one the server signs (so the SHA-256 in the evidence is the hash of what was on
 * screen); the page and the admin tab use in-place errors and in-app dialogs only — no `required` bubble, no
 * native alert / confirm / prompt; the portal chip names each state.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { CONSENT_KEYS, consentLangOf, consentT } from '../../../../../marketplace/plugins/conference-manager/client/lib/consentI18n';
import { ConsentChip } from '../../../../../marketplace/plugins/conference-manager/client/portal/ConsentBits';
import { consentMessage, copyText, whatsappUrl } from '../../../../../marketplace/plugins/conference-manager/client/lib/consentMessage';
import * as phone from '../../../../../marketplace/plugins/conference-manager/client/lib/phone';
import { PhoneInput } from '../../../../../marketplace/plugins/conference-manager/client/lib/PhoneInput';
import { waNumber as badgeWa } from '../../../../../marketplace/plugins/conference-manager/client/lib/badges';

const CM = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager');
const server = require(path.join(CM, 'server/consent.js'));
const src = (rel: string) => fs.readFileSync(path.join(CM, rel), 'utf8');

describe('consent strings', () => {
    it('Spanish, English and Portuguese carry the same keys, and placeholders are filled', () => {
        expect([...CONSENT_KEYS.en].sort()).toEqual([...CONSENT_KEYS.es].sort());
        expect([...CONSENT_KEYS.pt].sort()).toEqual([...CONSENT_KEYS.es].sort());
        expect(consentT('pt-BR')('copy.done')).toBe('Mensagem copiada');
        expect(consentT('en')('page.code.sent', { email: 'a***@e***.org' })).toBe('We sent the code to a***@e***.org. It expires in 10 minutes.');
        expect(consentT('fr')('page.title')).toBe('Autorización de datos');
        expect(consentLangOf('en-US')).toBe('en');
        expect(consentT('es')('no.such.key')).toBe('no.such.key');
    });
});

describe('the signed text', () => {
    it('the page shows the representative line exactly as the server hashes it', () => {
        const page = src('client/portal/consent/ConsentPage.tsx');
        const m = /export const repLine = \(r[^)]*\) =>\s*`([^`]+)`/.exec(page);
        expect(m).toBeTruthy();
        const rep = { name: 'Laura Gómez', document: '52.000.111', relationship: 'Madre' };
        const clientLine = m![1].replace('${r.name}', rep.name).replace('${r.relationship}', rep.relationship).replace('${r.document}', rep.document);
        const signed = server.shownText({
            conference: 'Asume el Riesgo', policyUrl: 'https://example.org/politica-de-datos', policyVersion: '1.0',
            texts: { general: 'G', health: 'H', image: 'I' }, minor: true, representative: rep,
        });
        expect(signed.split('\n')).toContain(clientLine);
        // The page inserts it right before the required authorization, where the server puts it.
        const lines = signed.split('\n');
        expect(lines[lines.indexOf(clientLine) + 1]).toBe('[Obligatoria] G');
    });

    it('masks e-mails for the screens', () => {
        expect(server.maskEmail('ana.perez@example.org')).toBe('a***@e***.org');
        expect(server.maskEmail('x')).toBe('');
    });
});

describe('no native dialogs, no required bubbles', () => {
    for (const rel of ['client/portal/consent/ConsentPage.tsx', 'client/admin/ConsentAdmin.tsx', 'client/portal/ConsentBits.tsx', 'client/lib/consentMessage.ts', 'client/lib/PhoneInput.tsx', 'client/admin/PhoneCountrySetting.tsx']) {
        it(rel, () => {
            const s = src(rel).replace(/^\s*(\/\/|\*).*$/gm, '');
            expect(s).not.toMatch(/\b(window\.)?(alert|confirm|prompt)\s*\(/);
            expect(s).not.toMatch(/\srequired[\s=>{]/);
        });
    }
});

describe('portal chip', () => {
    it('names each state', () => {
        const html = (state: string) => renderToStaticMarkup(React.createElement(ConsentChip, { consent: { state, granted_at: '2026-10-22T15:00:00.000Z', revoked_at: null, email_masked: '', mail_failed: false, link_expired: false } as any }));
        expect(html('pending')).toContain('Autorización pendiente');
        expect(html('granted')).toContain('Autorizada');
        expect(html('revoked')).toContain('Revocada');
        expect(renderToStaticMarkup(React.createElement(ConsentChip, { consent: null }))).toBe('');
    });
});

describe('«Copiar mensaje» (2.33.2)', () => {
    const info = { link: 'https://site.example/portal/conference/autorizacion#t=0123456789abcdef0123456789abcdef', first_name: 'Ana', conference: 'Asume el Riesgo',
        policy_version: '1.0', policy_url: 'https://site.example/politica-de-datos', link_days: 14, email_masked: 'a***@e***.org' };
    it('carries the personal link and the policy version, in each language, as plain text', () => {
        for (const [lang, hello] of [['es', 'Hola, Ana:'], ['en', 'Hi Ana,'], ['pt', 'Olá, Ana:']]) {
            const m = consentMessage(lang, info);
            expect(m.split('\n')[0]).toBe(hello);
            expect(m).toContain(info.link);
            expect(m).toContain('*Asume el Riesgo*');
            expect(m).toContain(info.policy_url);
            expect(m).toMatch(/1\.0/);
            expect(m).toContain('a***@e***.org');
            expect(m).not.toMatch(/<[a-z]/i);
        }
        expect(consentMessage('es', { ...info, first_name: '' }).split('\n')[0]).toBe('Hola:');
    });
    it('wa.me: to the digits the server normalised; without them WhatsApp asks who', () => {
        expect(whatsappUrl('a b&c', '573001234567')).toBe('https://wa.me/573001234567?text=a%20b%26c');
        expect(whatsappUrl('x', '')).toBe('https://wa.me/?text=x');
        expect(whatsappUrl('x', '123')).toBe('https://wa.me/?text=x');
    });
    it('copies with the Clipboard API, and says so when it cannot', async () => {
        const got: string[] = [];
        expect(await copyText('hola', { clipboard: { writeText: async (t: string) => { got.push(t); } } })).toBe(true);
        expect(got).toEqual(['hola']);
        expect(await copyText('hola', {})).toBe(false);
        expect(await copyText('hola', { clipboard: { writeText: async () => { throw new Error('denied'); } } })).toBe(false);
        expect(await copyText('hola', null)).toBe(false);
    });
    it('both screens offer it next to the send action, through the share routes', () => {
        const admin = src('client/admin/ConsentAdmin.tsx'), portal = src('client/portal/ConsentBits.tsx');
        expect(admin).toContain('/consent/share');
        expect(admin).toContain('data-consent-copy=');
        expect(portal).toContain('/portal/consent/share');
        expect(portal).toContain('data-action="consent-copy"');
        for (const s of [admin, portal]) { expect(s).toContain('whatsappUrl('); expect(s).toContain('t("copy.done")'); }
    });
});

describe('phones with their country (2.33.2)', () => {
    const serverPhone = require(path.join(CM, 'server/phone.js'));
    const vectors: [string, string][] = [['+57 300 123 4567', 'CO'], ['300 123 4567', 'CO'], ['0057 300 123 4567', 'CO'], ['573001234567', 'CO'], ['020 7946 0958', 'GB'],
        ['(305) 555-0100', 'US'], ['099 123 4567', 'EC'], ['12', 'CO'], ['abc', 'CO'], ['+1 809 555 1234', 'DO'], ['300 1234567 / 310 7654321', 'CO'], ['', 'CO']];
    it('the client follows the server: same list, same normalisation, same reading back', () => {
        expect(phone.COUNTRY_CODES).toBe(serverPhone.COUNTRY_CODES);
        expect(phone.PRIMARY).toEqual(serverPhone.PRIMARY);
        for (const [v, iso] of vectors) {
            expect(phone.toE164(v, iso)).toBe(serverPhone.toE164(v, iso));
            expect(phone.waDigits(v, iso)).toBe(serverPhone.waDigits(v, iso));
            const e = phone.toE164(v, iso);
            if (e) expect(phone.parseE164(e, iso)).toEqual(serverPhone.parseE164(e, iso));
        }
        expect(new Set(phone.COUNTRIES.map(c => c.iso)).size).toBe(phone.COUNTRIES.length);
    });
    it('splits a stored value for the selector and joins it back in E.164', () => {
        expect(phone.splitPhone('+593991234567', 'CO')).toEqual({ iso: 'EC', national: '991234567' });
        expect(phone.splitPhone('300 123 4567', 'CO')).toEqual({ iso: 'CO', national: '300 123 4567' });
        expect(phone.splitPhone('', 'PE')).toEqual({ iso: 'PE', national: '' });
        expect(phone.splitPhone('', 'ZZ').iso).toBe('CO');
        expect(phone.joinPhone('CO', '300 123 4567')).toBe('+573001234567');
        expect(phone.joinPhone('GB', '07946 0958')).toBe('+4479460958');
        expect(phone.joinPhone('CO', '')).toBe('');
        expect(phone.flagOf('CO')).toBe(String.fromCodePoint(0x1F1E8, 0x1F1F4));
    });
    it('the selector: labelled, in the screen language, the default country chosen, no required bubble', () => {
        for (const [lang, country, colombia] of [['es', 'Indicativo de país', 'Colombia (+57)'], ['en', 'Country code', 'Colombia (+57)'], ['pt', 'Código do país', 'Colômbia (+57)']]) {
            const html = renderToStaticMarkup(React.createElement(PhoneInput, { value: '', onChange: () => {}, defaultCountry: 'CO', lang, label: 'Teléfono', dataField: 'phone' }));
            expect(html).toContain(`aria-label="Teléfono · ${country}"`);
            expect(html).toContain(`<option value="CO" selected="">${colombia}</option>`);
            expect(html).toContain('type="tel"');
            expect(html).not.toContain('required');
        }
        const ec = renderToStaticMarkup(React.createElement(PhoneInput, { value: '+593991234567', onChange: () => {}, defaultCountry: 'CO' }));
        expect(ec).toContain('<option value="EC" selected="">');
        expect(ec).toContain('value="991234567"');
    });
    it('both forms use it for phone fields, and the badges WhatsApp number keeps a stored code', () => {
        for (const rel of ['client/admin/page.tsx', 'client/portal/CoordinatorPortal.tsx']) {
            const s = src(rel);
            const at = s.indexOf('isPhoneField(field) ? (');
            expect(at).toBeGreaterThan(0);
            expect(s.slice(at, at + 300)).toContain('<PhoneInput');
        }
        expect(badgeWa('+593991234567', '57')).toBe('593991234567');
        expect(badgeWa('0991234567', '593')).toBe('593991234567');
        expect(badgeWa('573001234567', '57')).toBe('573001234567');
        expect(badgeWa('300 123 4567', '57')).toBe('573001234567');
    });
});
