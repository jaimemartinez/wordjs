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
        expect(src('client/admin/ConsentAdmin.tsx')).toContain('!noEmail.has(p.id)');
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
    it('a phone toggles between the sheet and the list; a wide screen shows both; the photo is a second view of the sheet', () => {
        const s = src('client/lib/PaperConsent.tsx');
        expect(s).toContain('<Dialog wide');
        expect(s).toContain('data-paper-pane-toggle={k}');
        expect(s).toContain('lg:grid lg:grid-cols-2');
        expect(s).toContain('hidden lg:block');
        expect(s).toContain('data-paper-photo-toggle');
        expect(src('client/admin/ConsentAdmin.tsx')).toContain('wide ? "max-w-5xl"');
        expect(src('client/portal/ConsentBits.tsx')).toContain('size={wide ? "xl" : "lg"}');
        for (const k of ['paper.view.sheet', 'paper.view.list']) for (const l of ['es', 'en', 'pt']) expect(consentT(l)(k)).not.toBe(k);
    });
    it('delete: only an unused sheet offers it, confirmed in the host dialog, never a native one', () => {
        const s = src('client/lib/PaperConsent.tsx');
        expect(s).toContain('canManage && s.deletable &&');
        expect(s).toContain('testId="paper-delete"');
        expect(s).toContain('action: "delete", sheet_id: del.sheet.id');
        expect(s).not.toMatch(/\b(alert|confirm|prompt)\s*\(/);
    });
});
