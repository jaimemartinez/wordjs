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
import { consentMessage, copyLangOf, copyText, rememberCopyLang, whatsappUrl } from '../../../../../marketplace/plugins/conference-manager/client/lib/consentMessage';
import { CopyLangPicker } from '../../../../../marketplace/plugins/conference-manager/client/lib/CopyLangPicker';
import { HEALTH_LABELS_ES } from '../../../../../marketplace/plugins/conference-manager/client/lib/HealthConditionsInput';
import { translations as cmTranslations } from '../../../../../marketplace/plugins/conference-manager/client/lib/i18n';
import * as phone from '../../../../../marketplace/plugins/conference-manager/client/lib/phone';
import { PhoneInput } from '../../../../../marketplace/plugins/conference-manager/client/lib/PhoneInput';
import { waNumber as badgeWa } from '../../../../../marketplace/plugins/conference-manager/client/lib/badges';
import { Select, filterItems, itemsOf } from '../../../../../marketplace/plugins/conference-manager/client/lib/Select';

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
    for (const rel of ['client/portal/consent/ConsentPage.tsx', 'client/admin/ConsentAdmin.tsx', 'client/portal/ConsentBits.tsx', 'client/lib/consentMessage.ts', 'client/lib/PhoneInput.tsx', 'client/admin/PhoneCountrySetting.tsx', 'client/lib/Select.tsx', 'client/lib/CountrySelect.tsx', 'client/lib/Flag.tsx', 'client/lib/CopyLangPicker.tsx']) {
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
        // 2.36.8: the plugin's one copy helper (lib/clipboard) — the browser is stood in by `{ nav, doc, win }`.
        const got: string[] = [];
        expect(await copyText('hola', { nav: { clipboard: { writeText: async (t: string) => { got.push(t); } } }, doc: null })).toBe(true);
        expect(got).toEqual(['hola']);
        expect(await copyText('hola', { nav: {}, doc: null })).toBe(false);
        expect(await copyText('hola', { nav: { clipboard: { writeText: async () => { throw new Error('denied'); } } }, doc: null })).toBe(false);
        expect(await copyText('hola', { nav: null, doc: null })).toBe(false);
    });
    it('both screens offer it next to the send action, through the share routes', () => {
        const admin = src('client/admin/ConsentAdmin.tsx'), portal = src('client/portal/ConsentBits.tsx');
        expect(admin).toContain('/consent/share');
        // 2.36.16: the row's action lives in the people list (and the person's sheet).
        expect(src('client/admin/ConsentPeopleList.tsx')).toContain('data-consent-copy=');
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
        for (const [lang, country, colombia] of [['es', 'Indicativo de país', 'Colombia +57'], ['en', 'Country code', 'Colombia +57'], ['pt', 'Código do país', 'Colômbia +57']]) {
            const html = renderToStaticMarkup(React.createElement(PhoneInput, { value: '', onChange: () => {}, defaultCountry: 'CO', lang, label: 'Teléfono', dataField: 'phone' }));
            expect(html).toContain(`aria-label="Teléfono · ${country}: ${colombia}"`);
            expect(html).toContain('aria-haspopup="listbox"');
            expect(html).toContain('data-country-button="CO"');
            expect(html).toContain('data-flag="CO"');
            expect(html).toContain('type="tel"');
            expect(html).not.toContain('required');
            expect(html).not.toContain('<select');
        }
        const ec = renderToStaticMarkup(React.createElement(PhoneInput, { value: '+593991234567', onChange: () => {}, defaultCountry: 'CO' }));
        expect(ec).toContain('data-country-button="EC"');
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

describe('CM select (2.33.2): one styled dropdown with scroll and search for every select of the plugin', () => {
    it('reads <option> / <optgroup> children like the browser does', () => {
        const items = itemsOf([
            React.createElement('option', { key: 'a', value: '' }, 'Elige…'),
            React.createElement('optgroup', { key: 'g', label: 'Lunes' },
                React.createElement('option', { value: 1 }, 'Desayuno'),
                React.createElement('option', { value: 2, disabled: true }, 'Almuerzo')),
            null, false,
            React.createElement(React.Fragment, { key: 'f' }, React.createElement('option', null, 'Cena')),
        ]);
        expect(items).toEqual([
            { value: '', label: 'Elige…', disabled: false, group: undefined },
            { value: '1', label: 'Desayuno', disabled: false, group: 'Lunes' },
            { value: '2', label: 'Almuerzo', disabled: true, group: 'Lunes' },
            { value: 'Cena', label: 'Cena', disabled: false, group: undefined },
        ]);
    });
    it('searches without accents, labels starting with the text first', () => {
        const items = ['Bogotá', 'Barranquilla', 'Santa Marta', 'Cúcuta'].map(l => ({ value: l, label: l }));
        expect(filterItems(items, 'cuc').map(i => i.value)).toEqual(['Cúcuta']);
        expect(filterItems(items, 'ta').map(i => i.value)).toEqual(['Bogotá', 'Santa Marta', 'Cúcuta']);
        expect(filterItems(items, '').length).toBe(4);
    });
    it('closed: a button that names the choice, keeps id / aria / data, never the browser’s required bubble', () => {
        const html = renderToStaticMarkup(React.createElement(Select, { id: 'x', value: 2, onChange: () => {}, required: true, 'aria-label': 'Bus', 'data-field': 'bus' },
            React.createElement('option', { value: 1 }, 'Uno'), React.createElement('option', { value: 2 }, 'Dos')));
        expect(html).toMatch(/^<button type="button" id="x"/);
        expect(html).toContain('aria-label="Bus: Dos"');
        expect(html).toContain('data-field="bus"');
        expect(html).toContain('aria-haspopup="listbox"');
        expect(html).toContain('data-value="2"');
        expect(html).toContain('>Dos</span>');
        expect(html).not.toContain('required');
        // A value no option has shows the first one, as the browser's select does.
        expect(renderToStaticMarkup(React.createElement(Select, { value: 'zz', onChange: () => {} }, React.createElement('option', { value: 'a' }, 'A')))).toContain('>A</span>');
    });
    it('no native <select> is left in the plugin’s screens', () => {
        const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx$/.test(e.name) ? [path.join(d, e.name)] : []));
        const left = walk(path.join(CM, 'client')).filter(f => /<select[\s>]/.test(fs.readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '')));
        expect(left.map(f => path.relative(CM, f))).toEqual([]);
    });
});

describe('no e-mail on file (2.33.3)', () => {
    it('the copied message says the page asks for the e-mail, in each language', () => {
        const info = { link: 'https://site.example/portal/conference/autorizacion#t=0123456789abcdef0123456789abcdef', first_name: 'Ana', conference: 'Asume el Riesgo', policy_version: '1.0', policy_url: 'https://site.example/p', link_days: 14, email_masked: '' };
        expect(consentMessage('es', info)).toContain('escribe tu correo en la página');
        expect(consentMessage('en', info)).toContain('enter your e-mail on the page');
        expect(consentMessage('pt', info)).toContain('escreva seu e-mail na página');
        for (const l of ['es', 'en', 'pt']) expect(consentMessage(l, info)).toContain(info.link);
    });
    it('the consent page asks for it only when there is none, with its error in place', () => {
        const page = src('client/portal/consent/ConsentPage.tsx');
        expect(page).toContain('{view.needs_email && (');
        expect(page).toContain('...(view.needs_email ? { email: email.trim() } : {})');
        expect(page).toContain('err("email")');
    });
});

describe('languages (2.33.4)', () => {
    it('the health justification carries no example, in any language', () => {
        expect(HEALTH_LABELS_ES.consent).toBe('Usaremos esta información solo para atenderte mejor. Solo la ve el equipo autorizado. Puedes no responder.');
        for (const lang of ['es', 'en', 'pt'] as const) expect(cmTranslations[lang]['health.consent']).not.toMatch(/ejemplo|example|exemplo|turno|turn/i);
        expect(src('client/portal/consent/ConsentPage.tsx')).not.toMatch(/for example|por exemplo|por ejemplo/);
    });
    it('the copied message language: the e-mail language first, then the last one chosen on this device', () => {
        const store = new Map<string, string>();
        const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
        const prev = (globalThis as any).localStorage;
        (globalThis as any).localStorage = ls;
        try {
            expect(copyLangOf('pt')).toBe('pt');
            expect(copyLangOf('fr')).toBe('es');
            rememberCopyLang('en');
            expect(copyLangOf('pt')).toBe('en');
        } finally { (globalThis as any).localStorage = prev; }
        // Private mode: no storage at all still answers.
        (globalThis as any).localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
        try { expect(copyLangOf('pt')).toBe('pt'); expect(() => rememberCopyLang('en')).not.toThrow(); } finally { (globalThis as any).localStorage = prev; }
    });
    it('the picker is labelled, says which is chosen, and both dialogs use it', () => {
        const html = renderToStaticMarkup(React.createElement(CopyLangPicker, { value: 'en', onChange: () => {}, label: 'Idioma del mensaje' }));
        expect(html).toContain('aria-label="Idioma del mensaje"');
        expect(html).toMatch(/lang="en" aria-pressed="true"/);
        expect(html).toMatch(/lang="pt" aria-pressed="false"/);
        for (const rel of ['client/admin/ConsentAdmin.tsx', 'client/portal/ConsentBits.tsx']) {
            const s = src(rel);
            expect(s).toContain('<CopyLangPicker');
            expect(s).toContain('copyLangOf(');
            expect(s).toContain('consentMessage(share.lang, share.info)');
        }
    });
    it('the consent page: starts in the conference language, the person may switch, server refusals in its language', () => {
        const page = src('client/portal/consent/ConsentPage.tsx');
        expect(page).toContain('const lang = picked || serverLang || langNow();');
        expect(page).toContain('data-consent-lang-option={l}');
        for (const l of ['es', 'en', 'pt']) {
            const t = consentT(l);
            for (const code of ['general', 'representative', 'nocode', 'code_expired', 'code_bad', 'code_burnt', 'email', 'wait', 'throttled', 'mail']) expect(t(`err.${code}`)).not.toBe(`err.${code}`);
        }
    });
});

describe('paper consent (2.34.0)', () => {
    it('the panel renders in each language, with the host dialog, the styled Select and no native dialog', async () => {
        const { PaperConsent } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/PaperConsent');
        for (const l of ['es', 'en', 'pt']) {
            const t = consentT(l);
            const html = renderToStaticMarkup(React.createElement(PaperConsent, { t, request: async () => ({}), Dialog: () => null, addToast: () => {}, canManage: true }));
            expect(html).toContain('data-consent-paper=""');
            expect(html).toContain(t('paper.title'));
        }
        const s = src('client/lib/PaperConsent.tsx');
        expect(s).not.toMatch(/\b(alert|confirm|prompt)\s*\(/);
        expect(s).not.toMatch(/\brequired\b/);
        expect(s).toContain('<Select');
        expect(s).toContain('<Dialog');
        for (const rel of ['client/admin/ConsentAdmin.tsx', 'client/portal/ConsentBits.tsx']) expect(src(rel)).toContain('<PaperConsent');
    });
    it('every paper string it uses exists in Spanish, English and Portuguese', () => {
        const used = new Set<string>();
        for (const rel of ['client/lib/PaperConsent.tsx', 'client/admin/ConsentAdmin.tsx', 'client/portal/ConsentBits.tsx']) {
            for (const m of src(rel).matchAll(/t\("(paper\.[a-z.]+)"/g)) used.add(m[1]);
        }
        expect(used.size).toBeGreaterThan(30);
        for (const l of ['es', 'en', 'pt'] as const) for (const k of used) expect(CONSENT_KEYS[l]).toContain(k);
    });
    it('the printable sheet escapes every value and needs no script', () => {
        const { sheetHtml, sheetText } = require(path.join(CM, 'server/consent-paper-sheet.js'));
        const s = { lang: 'pt', code: 'ABC123', created_utc: '2026-10-23T10:00:00.000Z', conference: 'Conf <b>', location: 'Norte & Sur',
            policy: { url: 'https://example.org/p', version: '2.0', sha256: 'f'.repeat(64) }, responsible: 'R', contact: 'c@example.org',
            texts: { general: 'G <script>', health: 'H', image: 'I' }, people: [{ row: 1, name: '<img src=x>' }], blank: 3 };
        const html = sheetHtml(s);
        expect(html).not.toMatch(/<script|<img/);
        expect(html).toContain('&lt;img src=x&gt;');
        expect(html).toContain('Página 1 de 1');
        expect(html).toContain('lang="pt"');
        expect(sheetText(s)).toContain('G <script>');
    });
});

describe('verbal health authorization (2.34.0)', () => {
    it('the tick renders with its statement and error, and both registration forms use it', async () => {
        const { VerbalHealthConsent } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/VerbalHealthConsent');
        const html = renderToStaticMarkup(React.createElement(VerbalHealthConsent, { id: 'v', label: consentT('es')('verbal.statement'), checked: false, onChange: () => {}, error: consentT('es')('verbal.missing') }));
        expect(html).toContain('verbalmente');
        expect(html).toContain('role="alert"');
        expect(html).toContain('aria-invalid="true"');
        for (const rel of ['client/admin/page.tsx', 'client/portal/CoordinatorPortal.tsx']) {
            const s = src(rel);
            expect(s).toContain('<VerbalHealthConsent');
            expect(s).toContain('health_verbal_consent');
        }
        for (const l of ['es', 'en', 'pt']) for (const k of ['verbal.statement', 'verbal.missing', 'verbal.overdue', 'verbal.pending', 'admin.kpi.verbal', 'admin.filter.verbal', 'admin.verbal.days']) expect(consentT(l)(k)).not.toBe(k);
        expect(src('client/lib/VerbalHealthConsent.tsx')).not.toMatch(/\brequired\b|\b(alert|confirm|prompt)\s*\(/);
    });
    it('the paper checklist uses opt-out boxes, not Sí / No', () => {
        const s = src('client/lib/PaperConsent.tsx');
        expect(s).toContain('paper.optout.health');
        expect(s).toContain('health: !x.noHealth');
        expect(s).not.toContain('YesNo');
    });
});

describe('registering without an e-mail (2.35.0)', () => {
    it('«Sin correo» is said in each language, the resend button hides, and the toast says what to do', () => {
        for (const l of ['es', 'en', 'pt']) for (const k of ['noemail.badge', 'noemail.hint', 'portal.registered.noemail']) expect(consentT(l)(k)).not.toBe(k);
        expect(src('client/portal/ConsentBits.tsx')).toContain('!consent.no_email &&');
        // 2.36.16: the list row and the person's sheet hide «Enviar solicitud» without an e-mail.
        expect(src('client/admin/ConsentPeopleList.tsx')).toContain('{x.ask && !x.ne && (');
        expect(src('client/admin/ConsentPersonSheet.tsx')).toContain('{ask && !noEmail && (');
        expect(src('client/portal/CoordinatorPortal.tsx')).toContain("ct('portal.registered.noemail')");
    });
});

describe('paper sheets (2.36.2): delete an unused one, and the sheet next to the checklist', () => {
    it('the sheet view follows the paper: printed rows in order, settled rows kept in place, blank rows with their walk-in', async () => {
        const { SheetView } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/PaperConsent');
        const t = consentT('es');
        const sheet = { code: 'ABC', blank: 2, roster: [{ row: 1, inscription_id: 11, name: 'Ana Pérez' }, { row: 2, inscription_id: 12, name: 'Beto Gil' }, { row: 3, inscription_id: 13, name: 'Carla Ruiz' }] };
        const people = [{ id: 11, name: 'Ana Pérez', state: 'pending' }, { id: 12, name: 'Beto Gil', state: 'granted' }, { id: 20, name: 'Dora Paz', state: 'pending' }];
        const rows = [
            { id: 11, name: 'Ana Pérez', row: 1, on: true, noHealth: true, noImage: false, typedRow: '' },
            { id: 20, name: 'Dora Paz', row: null, on: true, noHealth: false, noImage: false, typedRow: '5' },
        ];
        const html = renderToStaticMarkup(React.createElement(SheetView, { t, sheet, rows, people, setRow: () => {} }));
        expect([...html.matchAll(/data-paper-sheet-row="(\d+)"/g)].map(m => Number(m[1]))).toEqual([1, 2, 3, 4, 5]);
        const row = (n: number) => html.split(`data-paper-sheet-row="${n}"`)[1].split('</tr>')[0];
        expect(row(1)).toContain('Ana Pérez');
        expect(row(1)).toContain('aria-pressed="true"');
        expect(row(2)).toContain(t('paper.row.granted'));
        expect(row(3)).toContain(t('paper.row.gone'));
        expect(row(4)).toContain(t('paper.row.blank'));
        expect(row(5)).toContain('Dora Paz');
        // Every box is a fixed square (the core sweep: shrink-0).
        expect(src('client/lib/PaperConsent.tsx')).toContain('inline-flex w-5 h-5 shrink-0');
    });
    it('one screen, no toggle (2.36.3): the uploaded page and the rows of the sheet side by side, or the page on top of the rows on a phone', () => {
        const s = src('client/lib/PaperConsent.tsx');
        expect(s).toContain('<Dialog wide');
        expect(s).not.toContain('data-paper-pane-toggle');
        expect(s).not.toContain('data-paper-photo-toggle');
        expect(s).not.toContain('hidden lg:block');
        expect(s).toContain('lg:grid lg:grid-cols-2');
        // The viewer stays in view while the rows scroll; on a phone its height is dragged (20–70 % of the screen).
        expect(s).toContain('className="sticky top-0 z-10 bg-white pb-1 lg:pb-0" data-paper-viewer-pane=""');
        expect(s).toContain('<PageViewer t={t} files={check.sheet.files || []} load={loadFile} />');
        expect(s).toContain('data-paper-viewer-resize=""');
        expect(s).toContain('Math.min(70, Math.max(20,');
        // Who signed on a blank row is ticked under the sheet; a minor's representative under their row.
        expect(s).toContain('renderDetail={detailOf}');
        expect(s).toContain('data-paper-walkins=""');
        expect(src('client/admin/ConsentAdmin.tsx')).toContain('wide ? "max-w-5xl"');
        expect(src('client/portal/ConsentBits.tsx')).toContain('size={wide ? "xl" : "lg"}');
        for (const k of ['paper.walkins.title', 'paper.viewer.page', 'paper.viewer.zoomIn', 'paper.viewer.resize', 'paper.viewer.pdf.none']) for (const l of ['es', 'en', 'pt']) expect(consentT(l)(k)).not.toBe(k);
    });
    it('a file opens in the viewer, never a download: a photo zooms and moves, a PDF shows page by page', () => {
        const s = src('client/lib/PaperConsent.tsx');
        expect(s).toContain('const openFile = (f: any) => setView({ kind: "file", file: f });');
        expect(s).toContain('<PageViewer t={t} files={[view.file]} load={loadFile} />');
        const v = src('client/lib/PageViewer.tsx');
        expect(v).toContain('const bytes = dataUrlBytes(r.data_url);');
        expect(v).not.toMatch(/window\.open|download\s*=|\.download\b|saveAs/);
        expect(v).toContain('onPointerMove={move}');
        expect(v).toContain('el.addEventListener("wheel", onWheel, { passive: false })');
        expect(v).toContain('onDoubleClick=');
        expect(v).not.toMatch(/\b(alert|confirm|prompt)\s*\(/);
    });
    it('the sheet view carries the detail of a minor under their own row', async () => {
        const { SheetView } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/PaperConsent');
        const t = consentT('es');
        const sheet = { code: 'X', blank: 0, roster: [{ row: 1, inscription_id: 5, name: 'Beto Gil' }] };
        const rows = [{ id: 5, name: 'Beto Gil', row: 1, on: true, noHealth: false, noImage: false, typedRow: '', err: {} }];
        const html = renderToStaticMarkup(React.createElement(SheetView, { t, sheet, rows, people: [{ id: 5, name: 'Beto Gil' }], setRow: () => {}, renderDetail: () => React.createElement('span', null, 'REP-FIELDS') }));
        expect(html).toContain('data-paper-sheet-detail="1"');
        expect(html.indexOf('REP-FIELDS')).toBeGreaterThan(html.indexOf('data-paper-sheet-row="1"'));
    });
    it('delete: only an unused sheet offers it, confirmed in the host dialog, never a native one', () => {
        const s = src('client/lib/PaperConsent.tsx');
        expect(s).toContain('canManage && s.deletable &&');
        expect(s).toContain('testId="paper-delete"');
        expect(s).toContain('action: "delete", sheet_id: del.sheet.id');
        expect(s).not.toMatch(/\b(alert|confirm|prompt)\s*\(/);
    });
});

describe('the signed page shown in place (2.36.3): a scanned PDF\'s pages as images, never a download', () => {
    const fx = (f: string) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', f)));
    it('a phone «scan to PDF» (JPEG pages): every page, in order, as its own JPEG', async () => {
        const { scanPages } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/pdfScan');
        const pages = scanPages(fx('scan-jpeg-2p.pdf'));
        expect(pages.map((p) => p.kind)).toEqual(['jpeg', 'jpeg']);
        for (const p of pages as any[]) {
            expect([p.bytes[0], p.bytes[1], p.bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
            expect([p.bytes[p.bytes.length - 2], p.bytes[p.bytes.length - 1]]).toEqual([0xff, 0xd9]);
            expect(p.width).toBe(320);
        }
        expect(Buffer.from((pages[0] as any).bytes).equals(Buffer.from((pages[1] as any).bytes))).toBe(false);
    });
    it('a scanner\'s lossless page (Flate, RGB or gray, colour space by reference): inflated to its pixels', async () => {
        const { scanPages, rawPixels } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/pdfScan');
        for (const [f, colors, width] of [['scan-flate-1p.pdf', 3, 260], ['scan-gray-1p.pdf', 1, 240]] as const) {
            const [p] = scanPages(fx(f)) as any[];
            expect(p.kind, f).toBe('raw');
            expect([p.colors, p.width], f).toEqual([colors, width]);
            const px = await rawPixels(p);
            expect(px.length, f).toBe(p.width * p.height * colors);
            // The sheet's paper is white: the top-left corner is.
            expect(px[0], f).toBeGreaterThan(240);
        }
    });
    it('not a PDF, or a PDF with no picture: nothing for the scan fast path (pdf.js draws those, 2.36.4)', async () => {
        const { scanPages } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/pdfScan');
        expect(scanPages(new TextEncoder().encode('hello'))).toEqual([]);
        expect(scanPages(new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF'))).toEqual([]);
        const s = src('client/lib/PaperConsent.tsx');
        expect(s).not.toContain('saveAs(r.name');
    });
});

describe('the paper sheet as a real PDF (2.36.3): «Descargar PDF» saves a .pdf, «Abrir para imprimir» opens it — no window.print', () => {
    it('no print-from-a-frame and no .html download any more', () => {
        const s = src('client/lib/PaperConsent.tsx');
        expect(s).not.toMatch(/\.print\(\)/);
        expect(s).not.toContain('srcdoc');
        expect(s).not.toContain('text/html');
        expect(s).toContain('request("get", { sheet_id: s.id, format: "pdf" })');
        expect(s).toContain('saveFile(r.filename, r.mime, r.b64)');
        expect(s).toContain('request("get", { sheet_id: s.id, format: "ticket" })');
        // The new tab opens inside the tap, before the ticket is asked for (a phone allows it only then).
        expect(s).toMatch(/export async function openSheetPdf[\s\S]*?window\.open\("", "_blank"\)[\s\S]*?await ticket\(\)/);
    });
    it('the PDF opens at the core portal file route, the same one the badge and sticker PDFs use', async () => {
        const { sheetFileUrl } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/PaperConsent');
        const manifest = JSON.parse(src('manifest.json'));
        const url = new URL(sheetFileUrl('T'.repeat(24)), 'http://site');
        expect(url.pathname).toBe(`/portal/${manifest.frontend.portalPage.slug}/file`);
        expect(fs.existsSync(path.resolve(__dirname, '../../../app/portal/[slug]/file/route.ts'))).toBe(true);
    });
    it('the labels say PDF in the three languages', () => {
        for (const [l, re] of [['es', /PDF/], ['en', /PDF/], ['pt', /PDF/]] as const) {
            expect(consentT(l)('paper.reprint')).toMatch(re);
            expect(consentT(l)('paper.download')).toMatch(re);
        }
    });
});

describe('any PDF in the viewer (2.36.4): pdf.js, served by the plugin when a PDF is opened', () => {
    const CMDIR = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager');
    // The vendored pdf.js, as the browser gets it (GET /public/pdfjs): two ES modules from base64.
    async function pdfjs() {
        const vendor = require(path.join(CMDIR, 'server/pdfjs-legacy.js'));
        const crypto = require('node:crypto');
        const os = require('node:os');
        const { pathToFileURL } = require('node:url');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-pdfjs-'));
        const files: Record<string, string> = {};
        for (const part of ['main', 'worker']) {
            const bytes = Buffer.from(vendor[part], 'base64');
            expect(crypto.createHash('sha256').update(bytes).digest('hex'), part).toBe(vendor.sha256[part]);
            files[part] = path.join(dir, `${part}.mjs`);
            fs.writeFileSync(files[part], bytes);
        }
        const worker = await import(/* @vite-ignore */ pathToFileURL(files.worker).href);
        (globalThis as any).pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler };
        return import(/* @vite-ignore */ pathToFileURL(files.main).href);
    }
    it('a typed, multi-page PDF (the consent sheet we generate) opens with the viewer\'s options — every page, its text', async () => {
        const { sheetPdf } = require(path.join(CMDIR, 'server/consent-paper-pdf.js'));
        const people = Array.from({ length: 12 }, (_, i) => ({ row: i + 1, name: `Persona ${i + 1}` }));
        const typed = sheetPdf({ lang: 'es', paper: 'letter', code: 'TYPED00001', created_utc: '2026-10-24T10:00:00Z', conference: 'Congreso', location: 'Norte',
            policy: { url: 'https://example.org/p', version: '1.0', sha256: 'a'.repeat(64) }, responsible: 'La iglesia', contact: 'datos@example.org',
            texts: { general: 'Autorizo el tratamiento de mis datos.', health: 'Autorizo mis datos de salud.', image: 'Autorizo el uso de mi imagen.' }, people, blank: 4 });
        const { PDF_OPEN, scansCoverEveryPage } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/pdfRender');
        expect(scansCoverEveryPage(new Uint8Array(typed))).toBe(false);
        const lib = await pdfjs();
        const doc = await lib.getDocument({ data: new Uint8Array(typed), ...PDF_OPEN }).promise;
        expect(doc.numPages).toBe(2);
        for (let n = 1; n <= doc.numPages; n++) {
            const text = (await (await doc.getPage(n)).getTextContent()).items.map((x: any) => x.str).join(' ');
            expect(text, `page ${n}`).toContain('Autorización para el tratamiento de datos personales');
        }
        await doc.destroy();
    }, 30000);
    it('a scanned PDF keeps the fast path (no renderer to download); pdf.js opens it too', async () => {
        const { scansCoverEveryPage, PDF_OPEN } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/pdfRender');
        const scan = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'scan-jpeg-2p.pdf')));
        expect(scansCoverEveryPage(scan)).toBe(true);
        expect(scansCoverEveryPage(new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'scan-flate-1p.pdf'))))).toBe(true);
        const lib = await pdfjs();
        const doc = await lib.getDocument({ data: scan, ...PDF_OPEN }).promise;
        expect(doc.numPages).toBe(2);
        await doc.destroy();
    }, 30000);
    it('the viewer: no «not a scan» dead end; pdf.js loads only for a PDF, as blob modules, no Worker, no eval; never a download', () => {
        const v = src('client/lib/PageViewer.tsx');
        expect(v).toContain('if (scansCoverEveryPage(bytes))');
        expect(v).toContain('await renderPdf(bytes, (n, total, url) => {');
        const r = src('client/lib/pdfRender.ts');
        expect(r).toContain("const PDFJS_URL = '/api/v1/plugin/conference-manager/public/pdfjs';");
        expect(r).toContain("new Blob([bytes], { type: 'text/javascript' })");
        expect(r).toContain('(globalThis as any).pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler };');
        expect(r).toContain('isEvalSupported: false');
        expect(r).not.toMatch(/new Worker\(|window\.open|\.download\b|<iframe/);
        // Not bundled: nothing imports pdf.js statically.
        for (const f of ['client/lib/PageViewer.tsx', 'client/lib/PaperConsent.tsx', 'client/lib/pdfRender.ts']) expect(src(f), f).not.toMatch(/from ['"][^'"]*pdfjs/);
        expect(fs.existsSync(path.join(CMDIR, 'server/pdfjs.LICENSE.txt'))).toBe(true);
        expect(src('server/pdfjs.LICENSE.txt')).toContain('Apache License');
    });
});

describe('2.36.8 «en móviles no me deja copiar el link»: one copy helper, with fallbacks that work on a phone', async () => {
    const clip = await import('../../../../../marketplace/plugins/conference-manager/client/lib/clipboard');
    const { CopyFallback, copyWords } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/CopyFallback');
    const CM = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client');
    // A document that behaves like iOS Safari: select() does nothing; only setSelectionRange selects a field's text,
    // and execCommand('copy') copies what is selected (false when nothing is).
    const fakeDoc = (opts: { iosSelect?: boolean; exec?: boolean | 'throw' } = {}) => {
        const log: any = { copied: null as string | null, appended: 0, removed: 0, focusBack: 0, style: '' };
        const prev = { focus: () => { log.focusBack++; } };
        const doc: any = {
            activeElement: prev,
            body: { appendChild: (n: any) => { log.appended++; log.style = n.style.cssText; } },
            createElement: () => {
                const ta: any = {
                    value: '', style: { cssText: '' }, attrs: {} as Record<string, string>, selectionStart: 0, selectionEnd: 0,
                    setAttribute(k: string, v: string) { this.attrs[k] = v; },
                    focus() { doc.activeElement = ta; },
                    select() { if (!opts.iosSelect) { this.selectionStart = 0; this.selectionEnd = this.value.length; } },
                    setSelectionRange(a: number, b: number) { this.selectionStart = a; this.selectionEnd = b; },
                    remove() { log.removed++; },
                };
                log.ta = ta;
                return ta;
            },
            execCommand: (cmd: string) => {
                if (opts.exec === 'throw') throw new Error('nope');
                if (opts.exec === false) return false;
                const ta = log.ta;
                if (cmd !== 'copy' || !ta || ta.selectionEnd <= ta.selectionStart) return false;
                log.copied = ta.value.slice(ta.selectionStart, ta.selectionEnd);
                return true;
            },
        };
        return { doc, log };
    };

    it('the Clipboard API is called at once (inside the tap), not after an await', async () => {
        let called = 0;
        const p = clip.copyText('x', { nav: { clipboard: { writeText: () => { called++; return Promise.resolve(); } } }, doc: null, win: { isSecureContext: true } });
        expect(called).toBe(1); // synchronously, before the returned promise settles
        expect(await p).toBe(true);
    });
    it('no Clipboard API (an http address): the textarea copy, selected the iOS way — setSelectionRange, not select()', async () => {
        const { doc, log } = fakeDoc({ iosSelect: true });
        const link = 'http://192.168.1.5/portal/conference?slug=asume';
        expect(await clip.copyText(link, { nav: {}, doc, win: { isSecureContext: false } })).toBe(true);
        expect(log.copied).toBe(link);
        // read-only (no keyboard), 16px (Safari does not zoom), removed afterwards, the focus given back
        expect(log.ta.attrs.readonly).toBe('');
        expect(log.style).toContain('font-size:16px');
        expect([log.appended, log.removed, log.focusBack]).toEqual([1, 1, 1]);
    });
    it('an insecure page with a Clipboard API object (some browsers expose one) does not use it', async () => {
        let used = false;
        const { doc, log } = fakeDoc();
        expect(await clip.copyText('abc', { nav: { clipboard: { writeText: async () => { used = true; } } }, doc, win: { isSecureContext: false } })).toBe(true);
        expect([used, log.copied]).toEqual([false, 'abc']);
    });
    it('the Clipboard API refuses (or throws at once): the textarea copy is tried before giving up', async () => {
        const a = fakeDoc();
        expect(await clip.copyText('r', { nav: { clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) } }, doc: a.doc, win: { isSecureContext: true } })).toBe(true);
        expect(a.log.copied).toBe('r');
        const b = fakeDoc();
        expect(await clip.copyText('t', { nav: { clipboard: { writeText: () => { throw new Error('sync'); } } }, doc: b.doc, win: { isSecureContext: true } })).toBe(true);
        expect(b.log.copied).toBe('t');
    });
    it('false — never a «Copiado» — when nothing could be copied: execCommand refused or threw, no document, empty text', async () => {
        const refused = fakeDoc({ exec: false });
        expect(await clip.copyText('x', { nav: {}, doc: refused.doc })).toBe(false);
        expect(refused.log.removed).toBe(1); // the hidden field never stays behind
        const threw = fakeDoc({ exec: 'throw' });
        expect(await clip.copyText('x', { nav: {}, doc: threw.doc })).toBe(false);
        expect(threw.log.removed).toBe(1);
        expect(await clip.copyText('x', { nav: {}, doc: null })).toBe(false);
        expect(await clip.copyText('', { nav: { clipboard: { writeText: async () => undefined } }, doc: null })).toBe(false);
    });
    it('copyLater: a text still on its way is written IN the tap (ClipboardItem); without it, copied when it arrives', async () => {
        let items: any[] | null = null;
        class CI { constructor(public data: any) { } }
        const env = { nav: { clipboard: { write: (x: any[]) => { items = x; return Promise.resolve(); } } }, doc: null, win: { isSecureContext: true, ClipboardItem: CI } };
        const p = clip.copyLater(new Promise<string>((r) => setTimeout(() => r('later'), 5)), env);
        expect(items).not.toBeNull(); // started before the text arrived
        expect(await p).toBe(true);
        const { doc, log } = fakeDoc({ iosSelect: true });
        expect(await clip.copyLater(Promise.resolve('plain'), { nav: {}, doc, win: { isSecureContext: false } })).toBe(true);
        expect(log.copied).toBe('plain');
        expect(await clip.copyLater(Promise.reject(new Error('gone')), { nav: {}, doc: fakeDoc().doc })).toBe(false);
    });
    it('the share sheet: shared, closed by the person (nothing to fall back to), or not there (the caller copies)', async () => {
        const seen: any[] = [];
        expect(clip.canShare({ nav: { share: async () => undefined } })).toBe(true);
        expect(clip.canShare({ nav: {} })).toBe(false);
        expect(await clip.shareText({ url: 'u' }, { nav: { share: async (d: any) => { seen.push(d); } } })).toBe('shared');
        expect(seen).toEqual([{ url: 'u' }]);
        expect(await clip.shareText({ url: 'u' }, { nav: { share: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } } })).toBe('cancelled');
        expect(await clip.shareText({ url: 'u' }, { nav: { share: async () => { throw new Error('NotAllowedError'); } } })).toBe('unsupported');
        expect(await clip.shareText({ url: 'u' }, { nav: {} })).toBe('unsupported');
    });
    it('the hand-copy panel: the text in a read-only 16px field with «Mantén presionado», «Copiar de nuevo» and «Cerrar», in es/en/pt', () => {
        const html = renderToStaticMarkup(React.createElement(CopyFallback, { text: 'https://x.org/portal/conference?slug=a', lang: 'es', onClose: () => undefined }));
        expect(html).toContain('data-copy-fallback=""');
        expect(html).toMatch(/<textarea[^>]*readOnly=""/);
        expect(html).toContain('font-size:16px');
        expect(html).toContain('https://x.org/portal/conference?slug=a');
        expect(html).toContain('Copia el enlace');
        expect(html).toContain('Mantén presionado el texto');
        for (const w of ['Copiar de nuevo', 'Cerrar']) expect(html).toContain(w);
        expect(renderToStaticMarkup(React.createElement(CopyFallback, { text: 'a code', title: 'Código', lang: 'es', onClose: () => undefined }))).toContain('Código');
        for (const l of ['es', 'en', 'pt']) expect(Object.keys(copyWords(l)).sort()).toEqual(Object.keys(copyWords('es')).sort());
        expect(copyWords('en').retry).toBe('Copy again');
        expect(copyWords('pt').share).toBe('Compartilhar');
    });
    it('every copy button goes through the helper: no navigator.clipboard or execCommand anywhere else in the plugin', () => {
        const files: string[] = [];
        const walk = (d: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const f = path.join(d, e.name);
                if (e.isDirectory()) { if (e.name !== 'vendor') walk(f); } else if (/\.(tsx?|js)$/.test(e.name)) files.push(f);
            }
        };
        walk(CM);
        for (const f of files) {
            if (f.endsWith(`lib${path.sep}clipboard.ts`)) continue;
            expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/navigator\.clipboard|execCommand\(/);
        }
        const read = (rel: string) => fs.readFileSync(path.join(CM, rel), 'utf8');
        // The registration link: copied in the tap, a «Compartir» on phones, and no link in a toast any more.
        const page = read('admin/page.tsx');
        expect(page).toContain("copyNow(portalUrl(), { done: 'Enlace copiado al portapapeles' });");
        expect(page).toContain('data-portal-link="share"');
        expect(page).not.toContain("addToast(fullUrl, 'info')");
        // The silent ones: the badge's share fallback, the portal's consent link, the «Mi inscripción» Safari link.
        expect(read('admin/BadgeActions.tsx')).not.toContain("addToast(url, 'info')");
        expect(read('portal/ConsentBits.tsx')).toContain('copyNow(link, { done: t("portal.copied") })');
        expect(read('portal/yo/BusAlerts.tsx')).toContain('const copySelf = () => { copyNow(selfUrl); };');
        expect(read('portal/PortalBadges.tsx')).not.toContain('"Enlace copiado." : url');
        // «Copiar mensaje»: the copy starts in the tap with the message still on its way.
        for (const f of ['admin/ConsentAdmin.tsx', 'portal/ConsentBits.tsx']) expect(read(f), f).toMatch(/const copying = copyLater\(pending\.then\(/);
        // The old helpers are the one helper now.
        expect(read('lib/badges.ts')).toContain("export { copyLater, copyText } from './clipboard';");
        expect(read('portal/badges.ts')).toContain('export { copyText } from "../lib/clipboard";');
        expect(read('lib/consentMessage.ts')).toContain("export { copyText } from './clipboard';");
    });
});

describe('2.36.10 staff registrations: the verbal authorization of the personal data, and the health one only with health data', async () => {
    const { VerbalHealthConsent } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/VerbalHealthConsent');
    const CMC = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client');
    const read = (rel: string) => fs.readFileSync(path.join(CMC, rel), 'utf8');
    it('the box: «general» is its own (its own marks), the health one unchanged; an error in place, never `required`', () => {
        const g = renderToStaticMarkup(<VerbalHealthConsent scope="general" id="g" label="L" checked={false} onChange={() => {}} error="E" />);
        expect(g).toContain('data-general-verbal=""');
        expect(g).toContain('data-general-verbal-box=""');
        expect(g).not.toContain('data-health-verbal');
        expect(g).toContain('role="alert"');
        expect(g).not.toContain('required');
        const h = renderToStaticMarkup(<VerbalHealthConsent id="h" label="L" checked={false} onChange={() => {}} />);
        expect(h).toContain('data-health-verbal=""');
        expect(h).not.toContain('data-general-verbal');
    });
    it('its words in es/en/pt (statement, the missing message, the record badge)', () => {
        for (const l of ['es', 'en', 'pt']) {
            const t = consentT(l);
            for (const k of ['verbal.general.statement', 'verbal.general.missing', 'verbal.general.pending']) expect(t(k), `${l} ${k}`).not.toBe(k);
        }
        expect(consentT('es')('verbal.general.statement')).toMatch(/verbalmente.*datos personales/);
    });
    it('the admin form: both boxes at the END (right above «Guardar»); the health one only with health data; on an edit a recorded authorization is ticked and LOCKED, a legacy one required', () => {
        const page = read('admin/page.tsx');
        // (a) Both boxes come after the last field and right before the footer with «Guardar».
        const general = page.indexOf('<VerbalHealthConsent scope="general" id={`cm-general-verbal-${editId || \'new\'}`}');
        const healthBox = page.indexOf("<VerbalHealthConsent id={`cm-health-verbal-${editId || 'new'}`}");
        const foot = page.indexOf('data-cm-sheet-foot=""', general);
        const notes = page.indexOf('id="cm-inscription-notes"');
        expect(general).toBeGreaterThan(notes);
        expect(healthBox).toBeGreaterThan(general);
        expect(foot).toBeGreaterThan(healthBox);
        expect(page.match(/<VerbalHealthConsent/g)!.length).toBe(2); // not inside the health field any more
        expect(page).toContain('if (!hf || !(verbal.required || verbal.locked) || !healthPayload(hf, healthForm.value)) return null;');
        // (b) The edit form asks how the person's authorizations are recorded: locked when recorded, required when not.
        expect(page).toContain('conferenceApi.getConsentAuthorization(person.id)');
        expect(page).toContain('setVerbalGeneral({ required: !a.general && !a.revoked, checked: !!a.general, error: null, locked: a.general || null });');
        expect(page).toContain("if (a.health) setVerbal((v) => ({ ...v, required: false, checked: true, locked: a.health }));");
        expect(page).toContain('disabled={!!verbalGeneral.locked}');
        expect(page).toContain('disabled={!!verbal.locked}');
        // Submit: the personal box for a new inscription AND a legacy edit; the health box also for unchanged health data then.
        expect(page).toContain('const needGeneral = verbalGeneral.required;');
        expect(page).toContain('const legacyHealth = !!editId && !!healthNow && verbal.required;');
        expect(page).toContain("if (needGeneral && !verbalGeneral.checked) { setVerbalGeneral((v) => ({ ...v, error: consentT(language)('verbal.general.missing') })); blocked = true; }");
        expect(page).toContain('if (needGeneral) payload.general_verbal_consent = true;');
        // A late health read never unlocks a recorded authorization.
        expect(page).toContain('setVerbal((v) => ({ required: !!r.verbal_required && !v.locked, checked: !!v.locked, error: null, locked: v.locked }));');
    });
    it('the portal form: both boxes at the end too (the personal one from /portal/me, the health one with health data); both checked on submit; the flags sent', () => {
        const portal = read('portal/CoordinatorPortal.tsx');
        const general = portal.indexOf('<VerbalHealthConsent scope="general" id="cm-general-verbal"');
        const healthBox = portal.indexOf('<VerbalHealthConsent id="cm-health-verbal"');
        const save = portal.indexOf('Guardar Inscripción');
        expect(general).toBeGreaterThan(portal.indexOf('<HealthConditionsInput'));
        expect(healthBox).toBeGreaterThan(general);
        expect(save).toBeGreaterThan(healthBox);
        expect(portal).toContain('if (!hf || !(hf as any).verbal_consent || !healthPayload(hf, formData[hf.name] || null)) return null;');
        expect(portal).toContain('const generalNeeded = !!(myLocation as any)?.consent_verbal_general;');
        expect(portal).toContain("if (generalNeeded && !verbalGeneralOk) { setVerbalGeneralError(consentT('es')('verbal.general.missing'));");
        expect(portal).toContain('...(generalNeeded ? { general_verbal_consent: true } : {})');
        // Right after the login (the login answer has the location only): /portal/me is read at once.
        expect(portal).toMatch(/setMyLocation\(data\.location\);[\s\S]{0,300}refreshMyLocation\(\);/);
    });
    it('a locked box: ticked, disabled, with the note of how it was recorded (es/en/pt)', () => {
        const html = renderToStaticMarkup(<VerbalHealthConsent scope="general" id="g" label="L" checked onChange={() => {}} disabled note="N" />);
        const input = html.match(/<input[^>]*>/)![0];
        expect(input).toContain('checked=""');
        expect(input).toContain('disabled=""');
        expect(html).toContain('data-verbal-locked=""');
        for (const l of ['es', 'en', 'pt']) for (const k of ['verbal.locked.written', 'verbal.locked.verbal']) expect(consentT(l)(k), `${l} ${k}`).not.toBe(k);
    });
    it('«Historial»: each kind said in words (es/en/pt), the actor named without an admin login on the portal, «Sin registro» for a legacy registration', async () => {
        const H = await import('../../../../../marketplace/plugins/conference-manager/client/lib/HistoryList');
        expect(H.historyText({ kind: 'created', via: 'portal' })).toBe('Inscripción creada desde el portal');
        expect(H.historyText({ kind: 'created', via: 'admin' }, 'en')).toBe('Registered from the administration');
        expect(H.historyText({ kind: 'edited', fields: ['Nombre', 'Teléfono'] })).toBe('Editó: Nombre, Teléfono');
        expect(H.historyText({ kind: 'consent_verbal_granted', scope: 'general' })).toBe('Autorización verbal de los datos personales');
        expect(H.historyText({ kind: 'consent_verbal_granted', scope: 'health' }, 'pt')).toBe('Autorização verbal dos dados de saúde');
        expect(H.historyText({ kind: 'consent_granted', method: 'paper' })).toBe('Autorizó por escrito en papel');
        for (const k of ['withdrawn', 'restored', 'consent_link_sent', 'consent_revoked', 'consent_health_entered']) expect(H.historyText({ kind: k })).not.toBe(k);
        expect(H.historyActor('admin')).toBe('Administración');
        expect(H.historyActor('portal:Norte')).toBe('Portal · Norte');
        expect(H.historyActor(null)).toBe('—');
        for (const l of ['es', 'en', 'pt']) expect(Object.keys(H.historyWords(l)).sort()).toEqual(Object.keys(H.historyWords('es')).sort());
        // Wired into both sheets with a STABLE loader (a new function each render would reload it forever).
        const sheet = read('admin/PersonSheet.tsx');
        expect(sheet).toContain('const loadHistory = useCallback(() => conferenceApi.getInscriptionHistory(p.id), [p && p.id]);');
        expect(sheet).toContain('<HistoryList load={loadHistory} lang={language} titleClass={titleCls} />');
        const ps = read('portal/ParticipantSheet.tsx');
        expect(ps).toContain('const loadHistory = React.useCallback(async () => {');
        expect(ps).toContain('{history && <HistoryList load={loadHistory} lang="es" titleClass={labelCls} />}');
        expect(read('portal/CoordinatorPortal.tsx')).toContain('history={{ authHeaders: portalAuthHeaders }}');
    });
    it('the record: the admin list and the portal chip say a verbal authorization of the data is waiting for the written one', () => {
        // 2.36.16: a verbal authorization of the data is the «Autorizado (verbal)» status, with who recorded it in the sheet.
        expect(read('lib/consentStatus.ts')).toContain('if (st.verbal_general || st.verbal_health) return st.verbal_overdue ? \'overdue\' : \'verbal\';');
        expect(read('admin/ConsentPersonSheet.tsx')).toContain('t("ux.verbal.by", { who: st.verbal_general_by, when: when(st.verbal_general_at) })');
        const chip = renderToStaticMarkup(<ConsentChip consent={{ state: 'pending', granted_at: null, revoked_at: null, email_masked: '', mail_failed: false, link_expired: false, verbal_general: true } as any} />);
        expect(chip).toContain('data-consent-verbal-general');
        expect(chip).toContain(consentT('es')('verbal.general.pending'));
        const granted = renderToStaticMarkup(<ConsentChip consent={{ state: 'granted', granted_at: '2030-01-01T00:00:00Z', revoked_at: null, email_masked: '', mail_failed: false, link_expired: false, verbal_general: false } as any} />);
        expect(granted).not.toContain('data-consent-verbal-general');
    });
});

describe('2.36.11 «Plantillas de correo» and «Correo del encargado» on the admin', async () => {
    const CMC = path.resolve(__dirname, '../../../../../marketplace/plugins/conference-manager/client');
    const read = (rel: string) => fs.readFileSync(path.join(CMC, rel), 'utf8');
    it('the page: administrators only; the preview rendered by the server in a sandboxed frame; chips insert at the cursor; restore asks in-app; desktop / phone widths', () => {
        const page = read('admin/page.tsx');
        expect(page).toContain("case 'emails': return p.isAdmin;");
        expect(page).toContain("{shown === 'emails' && <MailTemplatesPage />}");
        const m = read('admin/MailTemplatesPage.tsx');
        expect(m).toContain('conferenceApi.previewMailTemplate(tpl.id, payload())');
        expect(m).toMatch(/<iframe[^>]*sandbox=""[^>]*srcDoc=\{preview \? preview\.html : ''\}/);
        expect(m).toContain("width: device === 'mobile' ? 375 : '100%'");
        expect(m).toContain('const insert = (p) => {');
        expect(m).toContain("await confirm(tx('mail.restore.confirm'");
        expect(m).not.toMatch(/window\.(alert|confirm|prompt)\(|\balert\(/);
        expect(m).toContain('conferenceApi.testMailTemplate(tpl.id, payload())');
        expect(m).toContain('conferenceApi.restoreMailTemplate(tpl.id, lang)');
        // Errors in place: the required fields checked before anything is sent.
        expect(m).toContain("if (!draft.subject.trim()) e.subject = tx('mail.subject.missing', 'Escribe el asunto.');");
        // The API it calls.
        const api = read('lib/conference.ts');
        for (const s of ['getMailTemplates:', 'saveMailTemplate:', 'restoreMailTemplate:', 'previewMailTemplate:', 'testMailTemplate:', 'sendLocationWelcome:']) expect(api, s).toContain(s);
    });
    it('«Correo del encargado» on each locality: «Agregar» (2.36.12: opens «Editar encargado»), «Enviar bienvenida» / «Reenviar», when it was sent, and that it never carries the code', async () => {
        const { CoordinatorMail } = await import('../../../../../marketplace/plugins/conference-manager/client/admin/CoordinatorMail');
        const tx = (_k: string, d: string) => d;
        const none = renderToStaticMarkup(<CoordinatorMail loc={{ id: 1, responsible_email: null }} canManage tx={tx} onEdit={() => {}} />);
        expect(none).toContain('Sin correo');
        expect(none).toContain('data-coordinator-mail-edit');
        expect(none).not.toContain('data-welcome-send');
        const never = renderToStaticMarkup(<CoordinatorMail loc={{ id: 1, responsible_email: 'enc@example.org' }} canManage tx={tx} />);
        expect(never).toContain('Enviar bienvenida');
        expect(never).toContain('data-welcome-status="never"');
        expect(never).toContain('no lleva el código de acceso');
        const sent = renderToStaticMarkup(<CoordinatorMail loc={{ id: 1, responsible_email: 'enc@example.org', welcome_sent_s: 1900000000 }} canManage tx={tx} />);
        expect(sent).toContain('Reenviar bienvenida');
        expect(sent).toContain('data-welcome-status="sent"');
        const view = renderToStaticMarkup(<CoordinatorMail loc={{ id: 1, responsible_email: null }} canManage={false} tx={tx} onEdit={() => {}} />);
        expect(view).not.toContain('data-welcome-send');
        expect(view).not.toContain('data-coordinator-mail-edit');
        expect(read('admin/page.tsx')).toContain('<CoordinatorMail loc={loc} canManage={canManage} tx={tx} addToast={addToast} onEdit={() => setCoordEdit(loc)}');
        expect(read('admin/CoordinatorMail.tsx')).not.toMatch(/window\.(alert|confirm|prompt)\(|\balert\(/);
    });
    it('the admin words of both screens in es/en/pt', () => {
        const keys = ['mail.templates', 'mail.restore', 'mail.test', 'mail.preview', 'mail.markup', 'mail.before', 'mail.after', 'loc.mail', 'loc.welcome.send', 'loc.welcome.resend', 'loc.welcome.nocode'];
        for (const l of ['es', 'en', 'pt'] as const) for (const k of keys) expect((cmTranslations as any)[l][k], `${l} ${k}`).toBeTruthy();
    });
});

describe('conference-manager 2.36.12 — «Editar encargado»: every piece of a locality\'s coordinator data editable', () => {
    const read = (rel: string) => src(`client/${rel}`);
    it('sends only what changed, checks the phone (E.164 with the default country), the e-mail and the name length', async () => {
        const { coordinatorPatch, draftOf } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/coordinator');
        const loc = { responsible_name: 'Ana', responsible_phone: '300 123 4567 / 310 000', responsible_email: 'ana@example.org' };
        // Nothing changed: nothing sent — an old phone typed before E.164 is not re-checked while left alone.
        expect(coordinatorPatch(loc, draftOf(loc), 'CO')).toEqual({ patch: {}, errors: {}, changed: [] });
        // Only the name.
        expect(coordinatorPatch(loc, { ...draftOf(loc), name: '  Ana   María ' }, 'CO').patch).toEqual({ responsible_name: 'Ana María' });
        // The phone from the selector (E.164) is valid; a typed bad one is said under the field.
        const ok = coordinatorPatch(loc, { ...draftOf(loc), phone: phone.joinPhone('CO', '3001234567') }, 'CO');
        expect(ok).toMatchObject({ patch: { responsible_phone: '+573001234567' }, errors: {}, changed: ['phone'] });
        expect(coordinatorPatch(loc, { ...draftOf(loc), phone: '+12' }, 'CO').errors.phone).toBeTruthy();
        expect(coordinatorPatch(loc, { ...draftOf(loc), email: 'no-at-sign' }, 'CO').errors.email).toBeTruthy();
        expect(coordinatorPatch(loc, { ...draftOf(loc), name: 'x'.repeat(121) }, 'CO').errors.name).toBeTruthy();
        // Clearing a field is a change ('').
        expect(coordinatorPatch(loc, { ...draftOf(loc), email: '' }, 'CO')).toMatchObject({ patch: { responsible_email: '' }, errors: {}, changed: ['email'] });
    });
    it('the welcome state: «No enviado al nuevo correo» when the last one went to another address', async () => {
        const { welcomeState } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/coordinator');
        expect(welcomeState({ responsible_email: null })).toBe('none');
        expect(welcomeState({ responsible_email: 'a@example.org' })).toBe('never');
        expect(welcomeState({ responsible_email: 'a@example.org', welcome_sent_s: 1, welcome_sent_to: 'A@example.org' })).toBe('sent');
        expect(welcomeState({ responsible_email: 'b@example.org', welcome_sent_s: 1, welcome_sent_to: 'a@example.org' })).toBe('stale');
        const { CoordinatorMail } = await import('../../../../../marketplace/plugins/conference-manager/client/admin/CoordinatorMail');
        const tx = (_k: string, d: string) => d;
        const stale = renderToStaticMarkup(<CoordinatorMail loc={{ id: 1, responsible_email: 'b@example.org', welcome_sent_s: 1900000000, welcome_sent_to: 'a@example.org' }} canManage tx={tx} />);
        expect(stale).toContain('data-welcome-status="stale"');
        expect(stale).toContain('No enviado al nuevo correo');
        expect(stale).toContain('Enviar bienvenida');
        expect(stale).not.toContain('Reenviar bienvenida');
    });
    it('the sheet: name, the shared phone selector and the e-mail; errors under each field; the change log; no native dialogs', async () => {
        const { CoordinatorSheet } = await import('../../../../../marketplace/plugins/conference-manager/client/admin/CoordinatorSheet');
        const tx = (_k: string, d: string) => d;
        const loc = { id: 7, name: 'Norte', responsible_name: 'Ana', responsible_phone: '+573001234567', responsible_email: 'ana@example.org', welcome_sent_s: 1900000000, welcome_sent_to: 'ana@example.org',
            coordinator_log: [{ actor: 'boss', at_s: 1900000000, fields: ['name', 'phone'] }] };
        const html = renderToStaticMarkup(<CoordinatorSheet loc={loc} defaultCountry="CO" lang="es" tx={tx} onClose={() => {}} />);
        expect(html).toContain('role="dialog"');
        expect(html).toContain('Editar encargado');
        expect(html).toContain('data-coord-field="name"');
        expect(html).toContain('data-phone-input="responsible_phone"');
        expect(html).toContain('value="3001234567"');
        expect(html).toContain('data-coord-field="email"');
        expect(html).toContain('Cambios del encargado');
        expect(html).toContain('Encargado editado');
        expect(html).toContain('Nombre, Teléfono');
        expect(html).toContain('boss');
        expect(html).not.toMatch(/\srequired[\s=>]/);
        const sheet = read('admin/CoordinatorSheet.tsx');
        expect(sheet).not.toMatch(/window\.(alert|confirm|prompt)\(|\balert\(/);
        expect(sheet).toContain('conferenceApi.updateLocation(loc.id, check.patch as any)');
        expect(sheet).toContain('<Overlay layer={LAYER.modal}');
        // Wired on the card (who may manage the localities) and in the create form (same phone selector + e-mail).
        const page = read('admin/page.tsx');
        expect(page).toContain('onClick={() => setCoordEdit(loc)} data-coordinator-edit={loc.id}');
        expect(page).toContain('<CoordinatorSheet loc={coordEdit} defaultCountry={conference?.phone_country}');
        expect(page).toContain('<PhoneInput id="cm-new-loc-phone"');
        expect(page).toContain('id="cm-new-loc-email"');
    });
    it('the words in es/en/pt', () => {
        const keys = ['loc.coord.title', 'loc.coord.edit', 'loc.coord.name', 'loc.coord.phone', 'loc.coord.phone.invalid', 'loc.coord.saved', 'loc.coord.saved.stale',
            'loc.coord.email.welcome', 'loc.coord.log', 'loc.coord.log.entry', 'loc.welcome.stale', 'loc.welcome.stale.at', 'loc.coord.nophone', 'loc.coord.unassigned', 'loc.coord.name.long'];
        for (const l of ['es', 'en', 'pt'] as const) for (const k of keys) expect((cmTranslations as any)[l][k], `${l} ${k}`).toBeTruthy();
    });
});

describe('conference-manager 2.36.13 — «Enviar por correo» wherever the admin shares a badge', () => {
    const read = (rel: string) => src(`client/${rel}`);
    it('the per-person badge actions (Escarapelas › Personas and the person sheet): only with an e-mail, asked in place with the masked address, a toast with the result', () => {
        const a = read('admin/BadgeActions.tsx');
        expect(a).toContain('{link.email_masked && (');
        expect(a).toContain('data-badge-act="email"');
        expect(a).toContain('data-badge-email-confirm=""');
        expect(a).toContain('<span className="break-all">{link.email_masked}</span>');
        expect(a).toContain('const r = await badgesApi.email(person.id);');
        expect(a).toContain("addToast(tx('badges.act.email.sent', 'Escarapela enviada a {email}.')");
        // Without an e-mail the action is hidden and the sheet says why (as the portal does).
        expect(a).toContain("{!link.email_masked && <p className=\"text-[11px] text-gray-500\" data-badge-missing=\"email\">{tx('badges.act.email.none', 'Enviar por correo: no tiene correo registrado.')}</p>}");
        expect(a).not.toMatch(/window\.(alert|confirm|prompt)\(|\balert\(/);
        // Errors (429 mail_wait, 503 mail_off, …) are the server's words in a toast (act()).
        expect(a).toContain("try { await fn(); } catch (e: any) { addToast(e?.message || 'Error', 'error'); }");
    });
    it('the person list: «Correo» only with an e-mail, opening the actions with the question asked; «Sin correo registrado» otherwise', () => {
        const b = read('admin/BadgesPage.tsx');
        expect(b).toContain('{link && link.email_masked && (');
        expect(b).toContain('onClick={() => { setAskEmail(true); setOpen(r); }} data-badge-row="email"');
        expect(b).toContain('askEmail={askEmail}');
        expect(b).toContain("tx('badges.people.noemail', 'Sin correo registrado')");
        // The person sheet uses the same actions.
        expect(read('admin/page.tsx')).toContain('<BadgeActions person={badgeFor}');
    });
    it('one route for «Regenerar» and «Enviar por correo»; the API and the words', () => {
        expect(read('lib/badges.ts')).toContain('email: (inscriptionId: number) => apiPost<{ sent: boolean; email_masked: string }>(`${BASE}/badges/links/${inscriptionId}/email`, {}),');
        expect(src('index.js')).toContain("{ method: 'post', base: '/badges/links/:iid/:act', members: ['rotate', 'email'] },");
        const keys = ['badges.act.email', 'badges.act.email.confirm', 'badges.act.email.yes', 'badges.act.email.sent', 'badges.act.email.none', 'badges.people.email', 'badges.people.email.title', 'badges.people.noemail'];
        for (const l of ['es', 'en', 'pt'] as const) for (const k of keys) expect((cmTranslations as any)[l][k], `${l} ${k}`).toBeTruthy();
    });
});

describe('conference-manager 2.36.14 — «Plantillas de correo» for a non-technical coordinator', () => {
    const read = (rel: string) => src(`client/${rel}`);
    const P: { key: string; label: Record<string, string>; sample?: Record<string, string>; subject_only?: boolean }[] = [
        { key: 'name', label: { es: 'Nombre de la persona', en: 'Name of the person' }, sample: { es: 'Ana' } },
        { key: 'conference', label: { es: 'Conferencia', en: 'Conference' }, sample: { es: 'Asume el Riesgo' } },
        { key: 'code', label: { es: 'Código (solo en el asunto)' }, subject_only: true },
    ];
    it('the toolbar writes the small markup at the cursor: Negrita, Lista, Enlace', async () => {
        const E = await import('../../../../../marketplace/plugins/conference-manager/client/lib/mailEditor');
        // Negrita: around the selection; with none, a word selected to type over.
        expect(E.applyBold('Hola mundo', 5, 10)).toEqual({ value: 'Hola **mundo**', start: 7, end: 12 });
        expect(E.applyBold('Hola ', 5, 5, 'texto')).toEqual({ value: 'Hola **texto**', start: 7, end: 12 });
        // Lista: the caret's line, or every line selected; a line that already is an item stays as it is.
        expect(E.applyList('Uno\nDos', 5, 5).value).toBe('Uno\n- Dos');
        expect(E.applyList('Uno\nDos\n- Tres', 0, 13).value).toBe('- Uno\n- Dos\n- Tres');
        // Enlace: [texto](url) in place of the selection, the caret after it.
        expect(E.applyLink('Mira aquí.', 5, 9, 'el programa', 'https://ejemplo.org/p')).toEqual({ value: 'Mira [el programa](https://ejemplo.org/p).', start: 41, end: 41 });
        expect(E.applyLink('', 0, 0, '', 'https://ejemplo.org')).toMatchObject({ value: '[https://ejemplo.org](https://ejemplo.org)' });
        // Only https:// and mailto: are links; the check names the bad ones.
        expect(E.isSafeUrl('https://ejemplo.org')).toBe(true);
        expect(E.isSafeUrl('mailto:datos@ejemplo.org')).toBe(true);
        for (const bad of ['http://ejemplo.org', 'javascript:alert(1)', 'https://', 'ejemplo.org']) expect(E.isSafeUrl(bad), bad).toBe(false);
        expect(E.badLinks('Ver [a](https://x.org) y [b](http://y.org)')).toEqual(['http://y.org']);
    });
    it('placeholders read as names and go back to their keys; chips insert at the cursor', async () => {
        const E = await import('../../../../../marketplace/plugins/conference-manager/client/lib/mailEditor');
        const stored = 'Hola {name}: bienvenida a {conference}. {otra cosa}';
        const shown = E.toDisplay(stored, P, 'es');
        expect(shown).toBe('Hola {Nombre de la persona}: bienvenida a {Conferencia}. {otra cosa}');
        expect(E.fromDisplay(shown, P, 'es')).toBe(stored);
        expect(E.fromDisplay(E.toDisplay(stored, P, 'en'), P, 'en')).toBe(stored);
        // A chip: the readable token where the cursor is (replacing a selection), the caret right after.
        const token = E.chipToken(P[0], 'es');
        expect(token).toBe('{Nombre de la persona}');
        expect(E.insertAt('Hola :', 5, 5, token)).toEqual({ value: 'Hola {Nombre de la persona}:', start: 27, end: 27 });
        expect(E.insertAt('Hola XX:', 5, 7, token).value).toBe('Hola {Nombre de la persona}:');
        // Unsaved changes and the last edit of a card.
        expect(E.isDirty({ subject: 'a', body: 'b', after: '', action: '' }, { subject: 'a', body: 'b', after: '', action: '' })).toBe(false);
        expect(E.isDirty({ subject: 'a', body: 'c', after: '', action: '' }, { subject: 'a', body: 'b', after: '', action: '' })).toBe(true);
        expect(E.lastEdited({ es: { updated_at: '2026-10-01T00:00:00Z' }, en: { updated_at: '2026-10-20T00:00:00Z' } })).toBe('2026-10-20T00:00:00Z');
        expect(E.lastEdited({})).toBe(null);
    });
    it('the page: cards with when/state/last edit; side-by-side live preview; toolbar, chips, language tabs; sticky footer; unsaved guard; in-app dialogs', () => {
        const m = read('admin/MailTemplatesPage.tsx');
        for (const s of ['data-mail-cards=""', 'data-mail-when=""', 'data-mail-edited=""', 'data-mail-edit={t.id}',
            'lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]', 'data-mail-pane-switch=""', 'role="toolbar"', 'data-mail-format="bold"', 'data-mail-format="list"', 'data-mail-format="link"',
            'data-mail-placeholder={p.key}', "tx('mail.chip.example', 'Ejemplo: {value}')", 'role="tablist"', 'data-mail-lang-custom={l}', 'data-mail-footer=""', 'data-mail-dirty=',
            "window.addEventListener('beforeunload', on);", "await confirm(tx('mail.leave.confirm'", "tx('mail.link.bad'"]) expect(m, s).toContain(s);
        // Placeholders go back to their keys before anything reaches the server.
        expect(m).toContain('subject: fromDisplay(draft.subject, tpl.placeholders, ui), body: fromDisplay(draft.body, tpl.placeholders, ui)');
        expect(m).not.toMatch(/window\.(alert|confirm|prompt)\(|\balert\(/);
        expect(m).not.toMatch(/\srequired[\s=>]/);
        expect(m).not.toContain('**negrita**, una línea');
    });
    it('the words in es/en/pt', () => {
        const keys = ['mail.templates.intro', 'mail.when.consent.link', 'mail.when.consent.code', 'mail.when.consent.confirmation', 'mail.when.badge.link', 'mail.when.location.welcome',
            'mail.edited.at', 'mail.back', 'mail.leave', 'mail.leave.confirm', 'mail.format.bold', 'mail.format.list', 'mail.format.link', 'mail.link.text', 'mail.link.url', 'mail.link.add', 'mail.link.bad',
            'mail.chips', 'mail.chips.hint', 'mail.chip.example', 'mail.preview.live', 'mail.pane.edit', 'mail.unsaved', 'mail.saved.state', 'mail.test.short', 'mail.restore.short'];
        for (const l of ['es', 'en', 'pt'] as const) for (const k of keys) expect((cmTranslations as any)[l][k], `${l} ${k}`).toBeTruthy();
    });
});

describe('conference-manager 2.36.15 — «Mi escarapela» without a connection', () => {
    const read = (rel: string) => src(`client/${rel}`);
    const mem = () => {
        const m = new Map<string, string>();
        return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
    };
    const VIEW = {
        name: 'Ana Pérez', conference: 'Asume el Riesgo', location: 'Norte', code: 'ABCDEFGH12',
        answers: [{ label: 'Número de documento', value: '2000141' }], meals: { delivered: [], pending: [{ date: '2030-01-10', meal: 'cena' }] },
        lodging: { hotel: 'Hotel', room: '101', address: 'Calle 1', lat: 1, lng: 2 }, transport: [{ id: 1 }], push_key: 'k',
        badge: { badge: { layout: 'horizontal', items: [] }, plate: 'data:image/png;base64,AAA', images: { a: 'data:image/png;base64,BBB' } },
        expires_on: '2030-01-20',
    };
    it('keeps only the badge part — never the answers, meals, hotel or bus — for that code, until the event ends', async () => {
        const O = await import('../../../../../marketplace/plugins/conference-manager/client/portal/yo/offline');
        const copy = O.offlineCopyOf(VIEW, VIEW.code, new Date('2030-01-09T12:00:00Z'));
        expect(Object.keys(copy).sort()).toEqual(['badge', 'code', 'conference', 'expires_on', 'location', 'name', 'saved_at', 'v']);
        expect(JSON.stringify(copy)).not.toContain('2000141');
        expect(JSON.stringify(copy)).not.toContain('Hotel');
        const s = mem();
        expect(O.saveOffline(copy, s)).toBe(true);
        expect(O.readOffline(VIEW.code, s, new Date('2030-01-15'))).toMatchObject({ name: 'Ana Pérez', badge: { plate: 'data:image/png;base64,AAA' } });
        // Another person's code, or the event over: nothing.
        expect(O.readOffline('ZZZZZZZZZZ', s, new Date('2030-01-15'))).toBe(null);
        expect(O.readOffline(VIEW.code, s, new Date('2030-01-21'))).toBe(null);
        // «Salir» forgets it.
        O.clearOffline(s);
        expect(O.readOffline(VIEW.code, s, new Date('2030-01-15'))).toBe(null);
    });
    it('a badge too big for the phone is kept without its photos; a phone that refuses keeps nothing', async () => {
        const O = await import('../../../../../marketplace/plugins/conference-manager/client/portal/yo/offline');
        const big = { ...VIEW, badge: { ...VIEW.badge, images: { photo: 'data:image/jpeg;base64,' + 'A'.repeat(1_600_000) } } };
        const s = mem();
        expect(O.saveOffline(O.offlineCopyOf(big, big.code), s)).toBe(true);
        const kept = O.readOffline(big.code, s, new Date('2030-01-15'));
        expect(kept && kept.badge && kept.badge.images).toBe(null);
        expect(O.saveOffline(O.offlineCopyOf(VIEW, VIEW.code), { setItem: () => { throw new Error('QuotaExceededError'); } })).toBe(false);
        // What counts as «no connection» (not «no access»).
        expect([null, 0, 500, 502, 503].every((x) => O.isOfflineFailure(x as any))).toBe(true);
        expect([200, 401, 403, 404, 410].some((x) => O.isOfflineFailure(x))).toBe(false);
    });
    it('the worker keeps the page and its files, never the person\'s data or the PDF tickets', () => {
        const sw = read('portal/sw.js');
        expect(sw).toContain("self.addEventListener('fetch', (event) => {");
        expect(sw).toContain("if (url.pathname.startsWith('/api/')) return BUNDLE.test(url.pathname);");
        expect(sw).toContain("return url.pathname !== '/portal/conference/file' && !url.pathname.endsWith('/sw.js');");
        expect(sw).toContain("const hit = await cache.match(key, { ignoreSearch: page });");
        // Network first: the live answer whenever there is one.
        expect(sw.indexOf('const res = await fetch(req);')).toBeLessThan(sw.indexOf('const hit = await cache.match('));
        const BUNDLE = /^\/api\/v1\/plugins\/[^/]+\/bundle(\/css)?$/;
        expect(sw).toContain(`const BUNDLE = ${String(BUNDLE)};`);
        for (const ok of ['/api/v1/plugins/conference/bundle', '/api/v1/plugins/conference/bundle/css']) expect(BUNDLE.test(ok), ok).toBe(true);
        for (const no of ['/api/v1/plugin/conference-manager/public/me/view', '/api/v1/plugins/conference/bundle/x']) expect(BUNDLE.test(no), no).toBe(false);
    });
    it('the page: kept only with «Recordar», shown offline with the icon, forgotten on «Salir»; back online reloads', () => {
        const m = read('portal/yo/MyRegistration.tsx');
        expect(m).toContain('if (!stored || stored.code !== okView.code) return;');
        expect(m).toContain('saveOffline(offlineCopyOf(okView, okView.code));');
        expect(m).toContain('data-self-page="offline"');
        expect(m).toContain('<OfflineMark savedAt={saved} />');
        expect(m).toContain('{!online && <OfflineMark />}');
        expect(m).toContain('else { writeStored(null); clearOffline(); }');
        expect(m).toMatch(/writeStored\(null\);\r?\n\s+clearOffline\(\);\r?\n\s+dropPushSubscription\(\);/);
        expect(m).toContain('window.addEventListener("online", on);');
        // Without «Recordar», one line says how to have it offline.
        expect(m).toContain('{(readStored() || { code: "" }).code !== view.code && (');
        expect(m).toContain('Marca «Recordar en este teléfono» para verla sin conexión.');
        // The kept view shows the badge and who it is — nothing else.
        const offline = m.slice(m.indexOf('if (state.kind === "offline") {'), m.indexOf('if (state.kind === "error") {'));
        for (const no of ['answers', 'meals', 'lodging', 'downloadPdf']) expect(offline, no).not.toContain(no);
    });
});

describe('conference-manager 2.36.16 — «Autorizaciones» redesigned', () => {
    const read = (rel: string) => src(`client/${rel}`);
    const ST: Record<string, any> = {
        1: { state: 'pending', verbal_general: true, verbal_overdue: false, email_masked: 'a***@e***.org' },
        2: { state: 'pending', verbal_general: true, verbal_overdue: true, email_masked: 'b***@e***.org' },
        3: { state: 'granted', method: 'otp', general: true, health: true, image: false, email_masked: 'c***@e***.org' },
        4: { state: 'granted', method: 'paper', general: true, health: true, image: true, verbal_health: true },
        5: { state: 'revoked', email_masked: 'd***@e***.org' },
        7: { state: 'pending', email_masked: 'f***@e***.org', link_expired: true },
    };
    const PEOPLE = [
        { id: 1, first_name: 'Ana', last_name: 'Pérez', location: 'Norte', location_id: 10, doc: '1045678901' },
        { id: 2, first_name: 'Beto', last_name: 'Gómez', location: 'Norte', location_id: 10 },
        { id: 3, first_name: 'Carla', last_name: 'Ríos', location: 'Sur', location_id: 20 },
        { id: 4, first_name: 'Diego', last_name: 'Mora', location: 'Sur', location_id: 20 },
        { id: 5, first_name: 'Elena', last_name: 'Vargas', location: 'Norte', location_id: 10 },
        { id: 6, first_name: 'Félix', last_name: 'Núñez', location: 'Norte', location_id: 10 },
        { id: 7, first_name: 'Gina', last_name: 'Ortiz', location: 'Norte', location_id: 10 },
        { id: 8, first_name: 'Hugo', last_name: 'Paz', location: 'Norte', location_id: 10, status: 'cancelled' },
    ];
    it('one status per person, in the owner\'s words, with where the request stands', async () => {
        const S = await import('../../../../../marketplace/plugins/conference-manager/client/lib/consentStatus');
        expect(PEOPLE.slice(0, 7).map((p) => S.statusOf(ST[p.id]))).toEqual(['verbal', 'overdue', 'confirmed_code', 'confirmed_paper', 'revoked', 'none', 'none']);
        expect(S.detailOf(undefined, false)).toBe('never_sent');
        expect(S.detailOf(undefined, true)).toBe('no_email');
        expect(S.detailOf(ST[7], false)).toBe('link_expired');
        expect(S.detailOf({ state: 'pending', email_masked: 'x', mail_failed: true }, false)).toBe('mail_failed');
        expect(S.detailOf(ST[1], false)).toBe('link_sent');
        expect(S.detailOf(ST[4], false)).toBe('health_verbal');
        expect(S.detailOf(ST[3], false)).toBe(null);
        expect(S.canRequest('confirmed_code')).toBe(false);
        expect(S.canRequest('revoked')).toBe(true);
        // Every status has a color and an icon.
        for (const k of S.STATUS_ORDER) expect(S.STATUS_LOOK[k].icon).toMatch(/^fa-/);
    });
    it('the summary counts filter; search finds a name, a document or a locality; cancelled people never count', async () => {
        const S = await import('../../../../../marketplace/plugins/conference-manager/client/lib/consentStatus');
        expect(S.countsOf(PEOPLE, ST)).toEqual({ all: 7, none: 2, verbal: 1, overdue: 1, confirmed_code: 1, confirmed_paper: 1, revoked: 1 });
        const ids = (f: any) => S.filterPeople(PEOPLE, ST, f).map((p: any) => p.id);
        expect(ids({ status: 'overdue' })).toEqual([2]);
        expect(ids({ q: 'nunez' })).toEqual([6]);
        expect(ids({ q: '1045678901' })).toEqual([1]);
        expect(ids({ q: 'sur' })).toEqual([3, 4]);
        expect(ids({ q: 'ana perez' })).toEqual([1]);
        expect(ids({ location: '20' })).toEqual([3, 4]);
        expect(ids({ status: 'none', location: '10' })).toEqual([6, 7]);
        // Bulk: who can be e-mailed (not confirmed, an e-mail on file), and the one locality of a selection.
        expect(S.sendable([1, 3, 4, 6, 7], ST, new Set([6]))).toEqual([1, 7]);
        expect(S.oneLocation([1, 2, 6], PEOPLE)).toBe('10');
        expect(S.oneLocation([1, 3], PEOPLE)).toBe(null);
    });
    it('the list: a table and cards (no sideways scroll), long values wrap anywhere, a checkbox per person, the main actions in reach', async () => {
        const { ConsentPeopleList } = await import('../../../../../marketplace/plugins/conference-manager/client/admin/ConsentPeopleList');
        const t = consentT('es');
        const long = { ...PEOPLE[0], location: 'Localidad con un nombre larguísimo de prueba' };
        const st = { 1: { ...ST[1], email_masked: 'juan.sebastian.delatorre.rodriguez.coordinacion@correo-institucional-muy-largo.example.org' } };
        const html = renderToStaticMarkup(<ConsentPeopleList rows={[long]} states={st} noEmail={new Set()} t={t} nameOf={(p: any) => `${p.first_name} ${p.last_name}`}
            enabled canManage selectable selected={new Set([1])} onToggle={() => {}} onToggleAll={() => {}} onOpen={() => {}} onSend={() => {}} onCopy={() => {}} busyId={null} wide />);
        // 2.36.17: the screen's width picks ONE layout (no `hidden lg:table` that a host's own `hidden` can beat).
        expect(html).toContain('data-consent-layout="table"');
        expect(html).not.toContain('data-consent-layout="cards"');
        expect(html).toContain('overflow-wrap:anywhere');
        expect(html).not.toContain('overflow-x-auto');
        expect(html).toContain('data-consent-select="1"');
        expect(html).toContain('checked=""');
        expect(html).toContain('data-consent-status="verbal"');
        expect(html).toContain('Autorizado (verbal)');
        expect(html).toContain('data-consent-send="1"');
        expect(html).toContain('data-consent-copy="1"');
        expect(html).toContain('data-consent-view="1"');
        // Without an e-mail: no «Enviar solicitud», the «Sin correo» badge, WhatsApp still there.
        const none = renderToStaticMarkup(<ConsentPeopleList rows={[PEOPLE[5]]} states={{}} noEmail={new Set([6])} t={t} nameOf={(p: any) => p.first_name}
            enabled canManage selectable={false} selected={new Set()} onToggle={() => {}} onToggleAll={() => {}} onOpen={() => {}} onSend={() => {}} onCopy={() => {}} busyId={null} />);
        expect(none).not.toContain('data-consent-send=');
        expect(none).toContain('data-consent-noemail');
        expect(none).toContain('data-consent-copy="6"');
        expect(none).not.toContain('data-consent-select=');
    });
    it('the screen: people first, then paper and settings; the summary filters; selection sends or prints; each person in a sheet with the timeline', () => {
        const a = read('admin/ConsentAdmin.tsx');
        expect(a.indexOf('data-consent-tab={k}')).toBeGreaterThan(0);
        expect(a).toContain('["people", "fa-users", t("ux.tab.people")], ["paper", "fa-file-signature", t("ux.tab.paper")]');
        expect(a).toContain('onClick={() => setStatusFilter(k)} data-consent-filter={k}');
        expect(a).toContain('data-consent-bulk-send=""');
        expect(a).toContain('data-consent-bulk-paper=""');
        expect(a).toContain('onlyIds={paperOnly}');
        expect(a).toContain('<ConsentPersonSheet p={openPerson}');
        expect(a).not.toMatch(/window\.(alert|confirm|prompt)\(|\balert\(/);
        const sheet = read('admin/ConsentPersonSheet.tsx');
        expect(sheet).toContain('<HistoryList load={loadHistory} lang={lang} />');
        expect(sheet).toContain('conferenceApi.getInscriptionHistory(p.id)');
        expect(sheet).toContain('{st && isAdmin && (');
        expect(sheet).toContain('{canManage && granted && (');
        // The paper sheet for a selection rides on the existing «create» action.
        expect(read('lib/PaperConsent.tsx')).toContain('...(onlyIds && onlyIds.length ? { inscription_ids: onlyIds } : {})');
    });
    it('the words in es/en/pt', () => {
        const keys = ['ux.title', 'ux.intro', 'ux.tab.people', 'ux.tab.paper', 'ux.tab.settings', 'ux.status.none', 'ux.status.verbal', 'ux.status.overdue', 'ux.status.confirmed_code', 'ux.status.confirmed_paper', 'ux.status.revoked',
            'ux.search', 'ux.bulk.send', 'ux.bulk.paper', 'ux.bulk.sent', 'ux.bulk.paper.one', 'ux.detail.link_sent', 'ux.detail.no_email', 'ux.act.view', 'ux.act.send', 'ux.act.copy', 'ux.act.revoke', 'ux.act.export',
            'ux.explain.verbal', 'ux.explain.overdue', 'ux.overdue.hint', 'paper.only', 'paper.only.clear', 'ux.act.view.short', 'ux.act.resend.short'];
        for (const l of ['es', 'en', 'pt']) for (const k of keys) expect(consentT(l)(k), `${l} ${k}`).not.toBe(k);
        expect(consentT('es')('ux.bulk.sent', { ok: 3, total: 4 })).toBe('Solicitud enviada a 3 de 4.');
    });
});

describe('conference-manager 2.36.17 — «Autorizaciones» shows its list on a computer on any host', () => {
    it('the width picks the table or the cards — never both hidden by host classes', async () => {
        const { ConsentPeopleList, WIDE_QUERY } = await import('../../../../../marketplace/plugins/conference-manager/client/admin/ConsentPeopleList');
        const t = consentT('es');
        const props = { rows: [{ id: 1, first_name: 'Ana', last_name: 'Pérez', location: 'Norte' }], states: {}, noEmail: new Set(), t, nameOf: (p: any) => p.first_name,
            enabled: true, canManage: true, selectable: true, selected: new Set(), onToggle: () => {}, onToggleAll: () => {}, onOpen: () => {}, onSend: () => {}, onCopy: () => {}, busyId: null };
        const table = renderToStaticMarkup(<ConsentPeopleList {...props} wide />);
        const cards = renderToStaticMarkup(<ConsentPeopleList {...props} wide={false} />);
        expect(table).toContain('<table');
        expect(table).toContain('data-consent-row="1"');
        expect(table).not.toContain('data-consent-card=');
        expect(cards).not.toContain('<table');
        expect(cards).toContain('data-consent-card="1"');
        for (const html of [table, cards]) expect(html).not.toMatch(/class="(?:[^"]*\s)?(hidden|lg:hidden|lg:table)(?:\s[^"]*)?"/);
        expect(WIDE_QUERY).toBe('(min-width: 1024px)');
        // No breakpoint class decides what is visible in the list or the status summary.
        const list = src('client/admin/ConsentPeopleList.tsx');
        expect(list).not.toMatch(/className="[^"]*(hidden lg:table|lg:hidden)/);
        expect(src('client/admin/ConsentAdmin.tsx')).toContain('<div className="flex flex-wrap gap-2" role="group" aria-label={t("ux.summary")} data-consent-summary="">');
    });
});

describe('conference-manager 2.36.19 — «Localidades» filters', () => {
    const L = [
        { id: 1, name: 'Norte', responsible_name: 'Carlos Rodríguez', responsible_phone: '+573001234567', responsible_email: 'carlos@example.org', welcome_sent_s: 1, welcome_sent_to: 'carlos@example.org', lodging_status: 'submitted', capacity: 10, inscribed: 10 },
        { id: 2, name: 'Sur', responsible_name: '', responsible_phone: '', responsible_email: '', lodging_status: 'draft', capacity: null, inscribed: 4 },
        { id: 3, name: 'Chocó', responsible_name: 'Lorleyvis Arriaga', responsible_phone: '3109876543', responsible_email: 'lor@example.org', welcome_sent_s: null, lodging_status: 'validated', capacity: 50, inscribed: 12 },
        { id: 4, name: 'Clemencia', responsible_name: 'Ana', responsible_email: 'nueva@example.org', welcome_sent_s: 1, welcome_sent_to: 'vieja@example.org', lodging_status: 'draft', capacity: 0, inscribed: 3 },
    ];
    it('search by the locality or its coordinator (accents, words, phone digits), and one quick filter with its count', async () => {
        const F = await import('../../../../../marketplace/plugins/conference-manager/client/lib/locationFilter');
        const ids = (q: string, f: any = 'all') => F.filterLocations(L, q, f).map((l: any) => l.id);
        expect(ids('choco')).toEqual([3]);
        expect(ids('rodriguez')).toEqual([1]);
        expect(ids('lor@example')).toEqual([3]);
        expect(ids('9876543')).toEqual([3]);
        expect(ids('carlos norte')).toEqual([1]);
        expect(ids('', 'lodging_submitted')).toEqual([1]);
        expect(ids('', 'lodging_validated')).toEqual([3]);
        expect(ids('', 'no_coordinator')).toEqual([2]);
        expect(ids('', 'no_email')).toEqual([2]);
        expect(ids('', 'welcome_pending')).toEqual([3, 4]);
        expect(ids('', 'full')).toEqual([1]);
        expect(F.locationCounts(L)).toEqual({ all: 4, lodging_submitted: 1, lodging_validated: 1, no_coordinator: 1, no_email: 1, welcome_pending: 2, full: 1 });
    });
    it('the screen: the search, the chips (only those with something, plus the chosen one), «n de total», and no breakpoint class deciding what shows', () => {
        const page = src('client/admin/page.tsx');
        expect(page).toContain('data-locations-search=""');
        expect(page).toContain("LOCATION_FILTERS.filter((f) => f === 'all' || locCounts[f] > 0 || locFilter === f)");
        expect(page).toContain('{shownLocations.map(loc => (');
        expect(page).toContain('data-locations-empty=""');
        const block = page.slice(page.indexOf('data-locations-filters=""'), page.indexOf('{shownLocations.map(loc => ('));
        expect(block).not.toMatch(/\b(sm|md|lg|xl):(hidden|block|flex|grid|inline)\b/);
        for (const l of ['es', 'en', 'pt'] as const) for (const k of ['loc.filter.search', 'loc.filter.all', 'loc.filter.lodging_submitted', 'loc.filter.welcome_pending', 'loc.filter.full', 'loc.filter.shown', 'loc.filter.none', 'loc.filter.clear'])
            expect((cmTranslations as any)[l][k], `${l} ${k}`).toBeTruthy();
    });
});

describe('conference-manager 2.36.20 — «Cierre de inscripciones»', () => {
    const tx = (_k: string, fb: string, vars?: Record<string, unknown>) => fb.replace(/\{(\w+)\}/g, (_m, k) => String(vars?.[k] ?? ''));
    it('each locality card shows the date in force — its own, else the general one — and offers to change it', async () => {
        const { LocationRegistrationCloses, shownDateTime } = await import('../../../../../marketplace/plugins/conference-manager/client/admin/RegistrationCloses');
        const card = (loc: any, general: string | null) => renderToStaticMarkup(<LocationRegistrationCloses loc={loc} general={general} canEdit tx={tx} addToast={() => {}} onSaved={() => {}} />);
        expect(shownDateTime('2030-01-05T18:30')).toBe('05/01/2030 18:30');
        const own = card({ id: 1, registration_closes: '2030-01-05T18:30' }, '2030-01-08T12:00');
        expect(own).toContain('data-location-regclose-state="own"');
        expect(own).toContain('Propia: 05/01/2030 18:30');
        expect(own).toContain('data-location-regclose-edit=""');
        const general = card({ id: 2, registration_closes: null }, '2030-01-08T12:00');
        expect(general).toContain('data-location-regclose-state="general"');
        expect(general).toContain('General: 08/01/2030 12:00');
        const past = card({ id: 3, registration_closes: '2001-01-01T00:00' }, null);
        expect(past).toContain('cerradas');
        expect(card({ id: 4 }, null)).toContain('data-location-regclose-state="none"');
        expect(renderToStaticMarkup(<LocationRegistrationCloses loc={{ id: 5 }} general={null} canEdit={false} tx={tx} addToast={() => {}} onSaved={() => {}} />)).not.toContain('data-location-regclose-edit');
    });
    it('the general one lives in «Configurar registro»; the portal says registration closed and stops «Registrar Nuevo»', () => {
        const page = src('client/admin/page.tsx');
        expect(page).toContain('<RegistrationClosesSetting conferenceId={conferenceId}');
        expect(page).toContain('<LocationRegistrationCloses loc={loc}');
        const portal = src('client/portal/CoordinatorPortal.tsx');
        expect(portal).toContain('disabled={isLocationFull(myLocation) || registrationClosed}');
        expect(portal).toContain('data-testid="registration-closed"');
        const comp = src('client/admin/RegistrationCloses.tsx');
        expect(comp.slice(comp.indexOf('export function LocationRegistrationCloses'))).not.toMatch(/\b(sm|md|lg|xl):(hidden|block|flex|grid|inline)\b/);
        for (const l of ['es', 'en', 'pt'] as const) for (const k of ['regclose.title', 'regclose.label', 'regclose.clear', 'regclose.state.none', 'regclose.state.open', 'regclose.state.closed', 'regclose.help', 'regclose.loc.own', 'regclose.loc.from.general', 'regclose.loc.none', 'regclose.loc.change', 'regclose.loc.use.general', 'regclose.loc.hint', 'regclose.loc.saved', 'regclose.loc.general', 'regclose.loc.closed'])
            expect((cmTranslations as any)[l][k], `${l} ${k}`).toBeTruthy();
    });
    it('the cupo editor on a locality card wraps instead of pushing «Cancelar» out of it', () => {
        const page = src('client/admin/page.tsx');
        expect(page).toContain('<div className="flex flex-wrap items-center gap-2 mt-1" data-capacity-edit={loc.id}>');
    });
});

describe('conference-manager 2.36.21 — rename a locality', () => {
    const tx = (_k: string, fb: string) => fb;
    it('the card shows the name with a pencil for whoever manages localities, and only for them', async () => {
        const { LocationName } = await import('../../../../../marketplace/plugins/conference-manager/client/admin/LocationName');
        const html = renderToStaticMarkup(<LocationName loc={{ id: 7, name: 'Chocó' }} canEdit tx={tx} addToast={() => {}} onSaved={() => {}} />);
        expect(html).toContain('Chocó');
        expect(html).toContain('data-location-rename="7"');
        expect(html).toContain('aria-label="Editar nombre"');
        expect(renderToStaticMarkup(<LocationName loc={{ id: 7, name: 'Chocó' }} canEdit={false} tx={tx} addToast={() => {}} onSaved={() => {}} />)).not.toContain('data-location-rename');
    });
    it('wired on the «Localidades» card; the editor wraps, uses no breakpoint class and no required bubble; strings in every language', () => {
        expect(src('client/admin/page.tsx')).toContain('<LocationName loc={loc} canEdit={canManage}');
        const comp = src('client/admin/LocationName.tsx');
        expect(comp).toContain('flex flex-wrap items-center gap-2');
        expect(comp).not.toMatch(/\b(sm|md|lg|xl):(hidden|block|flex|grid|inline)\b/);
        expect(comp).not.toMatch(/\brequired\b/);
        for (const l of ['es', 'en', 'pt'] as const) for (const k of ['loc.rename.edit', 'loc.rename.label', 'loc.rename.saved', 'loc.rename.empty'])
            expect((cmTranslations as any)[l][k], `${l} ${k}`).toBeTruthy();
    });
});

describe('conference-manager 2.36.22 — cupos totals and the family groups in the admin edit form', () => {
    it('capacityTotals sums the cupos of the localities with a limit, the seats taken everywhere and what is still free', async () => {
        const { capacityTotals } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/locationFilter');
        expect(capacityTotals([
            { capacity: 50, inscribed: 12 }, { capacity: '30', inscribed: 35 }, { capacity: null, inscribed: 7 }, { capacity: 0, inscribed: 0 },
        ])).toEqual({ assigned: 80, inscribed: 54, available: 38, unlimited: 2 });
        expect(capacityTotals([])).toEqual({ assigned: 0, inscribed: 0, available: 0, unlimited: 0 });
    });
    it('groupsAmong lists one locality\'s groups (case-insensitive, trimmed), without the cancelled and without the person edited', async () => {
        const { groupsAmong } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/GroupPicker');
        const rows = [
            { id: 1, location_id: 3, family_group: 'Familia Ochoa', first_name: 'Ana' },
            { id: 2, location_id: 3, family_group: ' familia ochoa ', first_name: 'Luis' },
            { id: 3, location_id: 3, family_group: 'Esquivel', first_name: 'Lina' },
            { id: 4, location_id: 9, family_group: 'Otra', first_name: 'Rita' },
            { id: 5, location_id: 3, family_group: 'Baja', first_name: 'Eva', status: 'cancelled' },
            { id: 6, location_id: 3, family_group: '', first_name: 'Sin' },
        ];
        const g = groupsAmong(rows, 'family_group', '3', (r) => r.first_name, 2);
        expect(g.map((x) => [x.name, x.count, x.members!.map((m) => m.name)])).toEqual([['Esquivel', 1, ['Lina']], ['Familia Ochoa', 1, ['Ana']]]);
        expect(groupsAmong(rows, 'family_group', null, (r) => r.first_name)).toEqual([]);
    });
    it('the picker renders the field, with no required bubble', async () => {
        const { GroupPicker } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/GroupPicker');
        const html = renderToStaticMarkup(<GroupPicker field={{ name: 'family_group', is_required: 1 }} value="Esquivel" onChange={() => {}}
            groups={[{ name: 'Esquivel', count: 2, members: [{ id: 1, name: 'Lina' }, { id: 2, name: 'Lily' }] }]} />);
        expect(html).toContain('data-field="family_group"');
        expect(html).toContain('En «Esquivel» (2):');
        expect(html).toContain('Lina, Lily');
        expect(html).not.toContain('required');
    });
    it('wired: «Localidades» shows the totals, the admin form and the portal share the picker; strings in every language', () => {
        const page = src('client/admin/page.tsx');
        expect(page).toContain('data-locations-totals=""');
        expect(page).toContain('groupsAmong(inscriptions, field.name, formData.location_id, nameOf, editId)');
        const portal = src('client/portal/CoordinatorPortal.tsx');
        expect(portal).toContain('import { GroupPicker } from "../lib/GroupPicker"');
        expect(portal).not.toContain('function GroupPicker(');
        expect(src('client/lib/GroupPicker.tsx')).not.toMatch(/\b(sm|md|lg|xl):(hidden|block|flex|grid|inline)\b/);
        for (const l of ['es', 'en', 'pt'] as const) for (const k of ['loc.totals.assigned', 'loc.totals.inscribed', 'loc.totals.available', 'loc.totals.unlimited',
            'group.pick.location', 'group.pick.placeholder', 'group.pick.empty', 'group.pick.person', 'group.pick.people', 'group.pick.create', 'group.pick.in'])
            expect((cmTranslations as any)[l][k], `${l} ${k}`).toBeTruthy();
    });
});

describe('conference-manager 2.36.23 — the custom Excel of «Localidades»', () => {
    const fields = [
        { name: 'first_name', label: 'Nombre', type: 'text' },
        { name: 'age', label: 'Edad', type: 'number', role: 'age' },
        { name: 'gender', label: 'Sexo', type: 'select', options: 'Masculino, Femenino', role: 'gender' },
        { name: 'family_group', label: 'Grupo familiar', type: 'text', is_group: 1 },
        { name: 'health_conditions', label: 'Salud', type: 'select', options: 'A,B', role: 'health' },
    ];
    const locations = [
        { id: 1, name: 'Norte', capacity: 10, inscribed: 4, responsible_name: 'Ana' },
        { id: 2, name: 'Sur', capacity: null, inscribed: 2 },
        { id: 3, name: 'Este', capacity: '5', inscribed: 0 },
    ];
    const people = [
        { id: 1, location_id: 1, age: '3', gender: 'Femenino', family_group: 'Ochoa', payment_status: 'paid' },
        { id: 2, location_id: 1, age: 8, gender: 'masculino ', family_group: ' ochoa', payment_status: 'partial' },
        { id: 3, location_id: 1, age: '65', gender: 'Femenino', family_group: 'Ruiz' },
        { id: 4, location_id: 1, age: '', gender: '' },
        { id: 5, location_id: 1, age: 30, gender: 'Femenino', status: 'cancelled' },
        { id: 6, location_id: 2, age: 17, gender: 'Otro', family_group: '' },
        { id: 7, location_id: 2, age: 'abc', gender: 'Masculino' },
    ];
    it('validates the age ranges: whole years, from ≤ to, no overlap; labels read 0–5 / 60+', async () => {
        const { ageRangesError, ageRangeLabel, normalizeAgeRanges, parseAge, AGE_MAX } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/locationsReport');
        expect(ageRangesError([])).toEqual({ code: 'empty', index: -1 });
        expect(ageRangesError([{ from: '0', to: '5' }, { from: '', to: '9' }])).toEqual({ code: 'invalid', index: 1 });
        expect(ageRangesError([{ from: '9', to: '5' }])).toEqual({ code: 'order', index: 0 });
        expect(ageRangesError([{ from: 0, to: 10 }, { from: 10, to: 20 }])).toEqual({ code: 'overlap', index: 1 });
        expect(ageRangesError([{ from: 0, to: 5 }, { from: 7, to: AGE_MAX }])).toBeNull();
        expect(normalizeAgeRanges([{ from: '60', to: '120' }, { from: '0', to: '5' }])).toEqual([{ from: 0, to: 5 }, { from: 60, to: 120 }]);
        expect([ageRangeLabel({ from: 0, to: 5 }), ageRangeLabel({ from: 60, to: AGE_MAX }), ageRangeLabel({ from: 7, to: 7 })]).toEqual(['0–5', '60+', '7']);
        expect([parseAge(' 4 '), parseAge('4,5'), parseAge('x'), parseAge(-1), parseAge(200), parseAge('')]).toEqual([4, 4, null, null, null, null]);
    });
    it('builds one row per locality in the chosen order, with cupos, ages, a field breakdown and the total row', async () => {
        const { buildLocationsSheet } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/locationsReport');
        const sheet = buildLocationsSheet({
            locations, people, fields,
            keys: ['name', 'capacity', 'inscribed', 'available', 'occupancy', 'cancelled', 'families', 'paid', 'ages', 'by:gender'],
            ageRanges: [{ from: 0, to: 5 }, { from: 6, to: 17 }, { from: 60, to: 120 }],
        });
        expect(sheet.columns.map((c) => c.header)).toEqual([
            'Localidad', 'Cupos asignados', 'Inscritos', 'Cupos disponibles', '% de ocupación', 'Cancelados', 'Grupos familiares', 'Pagado',
            'Edad 0–5', 'Edad 6–17', 'Edad 60+', 'Sin edad', 'Sexo: Masculino', 'Sexo: Femenino', 'Sexo: Otro', 'Sexo: Sin respuesta',
        ]);
        expect(sheet.rows).toEqual([
            ['Norte', 10, 4, 6, 40, 1, 2, 1, 1, 1, 1, 1, 1, 2, 0, 1],
            ['Sur', 'Sin límite', 2, '', '', 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0],
            ['Este', 5, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            ['Total', 15, 6, 11, 26.7, 1, 2, 1, 1, 2, 1, 2, 2, 2, 1, 1],
        ]);
        expect(sheet.boldRows).toEqual([3]);
    });
    it('limits to the ticked localities, drops the total on request, skips columns without data and never offers the health answer', async () => {
        const { buildLocationsSheet, breakdownFields } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/locationsReport');
        const s = buildLocationsSheet({ locations, people, fields: fields.filter((f) => f.role !== 'age' && !f.is_group), keys: ['name', 'ages', 'families', 'by:nope', 'responsible_name'], locationIds: [1], totals: false, labels: { name: 'Locality' } });
        expect(s.columns.map((c) => c.header)).toEqual(['Locality', 'Encargado']);
        expect(s.rows).toEqual([['Norte', 'Ana']]);
        expect(breakdownFields(fields).map((f) => f.name)).toEqual(['gender']);
        const { buildXlsx } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/xlsx');
        expect(buildXlsx([s]).length).toBeGreaterThan(100);
    });
    it('wired: the button on «Localidades», the modal with no native dialogs or required, strings in every language', async () => {
        const page = src('client/admin/page.tsx');
        expect(page).toContain('data-locations-excel-open=""');
        expect(page).toContain('<LocationsExcelModal conferenceId={conferenceId}');
        const modal = src('client/admin/LocationsExcel.tsx');
        expect(modal).not.toMatch(/\b(alert|confirm|prompt)\(/);
        expect(modal).not.toMatch(/\brequired\b/);
        expect(modal).not.toMatch(/<select[\s>]/);
        expect(modal).not.toMatch(/\b(sm|md|lg|xl):(hidden|block|flex|grid|inline)(?![-\w])/);
        const { REPORT_LABELS } = await import('../../../../../marketplace/plugins/conference-manager/client/lib/locationsReport');
        const keys = [...Object.keys(REPORT_LABELS).map((k) => `locx.col.${k}`), ...[...modal.matchAll(/tx\('(locx\.[a-z.]+)'/g)].map((m) => m[1])];
        expect(keys.length).toBeGreaterThan(40);
        for (const l of ['es', 'en', 'pt'] as const) for (const k of keys) expect((cmTranslations as any)[l][k], `${l} ${k}`).toBeTruthy();
    });
});
