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
    for (const rel of ['client/portal/consent/ConsentPage.tsx', 'client/admin/ConsentAdmin.tsx', 'client/portal/ConsentBits.tsx', 'client/lib/consentMessage.ts']) {
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
    it('wa.me: the number only with its country code; the text encoded', () => {
        expect(whatsappUrl('a b&c', '+57 300 123 4567')).toBe('https://wa.me/573001234567?text=a%20b%26c');
        expect(whatsappUrl('x', '573001234567')).toBe('https://wa.me/573001234567?text=x');
        expect(whatsappUrl('x', '300 123 4567')).toBe('https://wa.me/?text=x');
        expect(whatsappUrl('x', '')).toBe('https://wa.me/?text=x');
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
