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
