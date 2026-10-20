import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Footer from '../Footer';
import { footerStrings } from '@/lib/public/uiStrings';

/**
 * The footer's social icons, at RENDER time.
 *
 * `footer_socials` is a stored setting: its `url` is whatever was written into the database, and it
 * used to go straight into `href`. An `<a href>` is an XSS sink — `javascript:…` executes on click,
 * which is the stored-XSS shape this product already shipped once — so the URL is now checked with
 * the same guard the theme chrome uses (isSafeChromeHref: root-relative or http(s) only). An icon
 * whose URL fails still renders; it just is not a link.
 *
 * Rendered with `previewSocials`, the prop path that seeds state without the effect's fetch.
 */
const render = (socials: Array<{ platform: string; url: string; icon: string }>) =>
    renderToStaticMarkup(<Footer previewSettings={{ blogname: 'Site' }} previewMenu={[]} previewSocials={socials} />);

const hrefs = (html: string) => [...html.matchAll(/<a[^>]*\shref="([^"]*)"/g)].map((m) => m[1]);

describe('Footer — social link hrefs', () => {
    it('keeps http(s) and root-relative social links as real links', () => {
        const html = render([
            { platform: 'GitHub', url: 'https://github.com/wordjs', icon: 'fa-brands fa-github' },
            { platform: 'Web', url: '/contact', icon: 'fa-solid fa-globe' },
        ]);
        expect(hrefs(html)).toEqual(['https://github.com/wordjs', '/contact']);
    });

    it('never emits a script-bearing or off-site-authority href', () => {
        for (const url of [
            'javascript:alert(1)',
            'JaVaScRiPt:alert(1)',
            ' javascript:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'vbscript:msgbox(1)',
            '//evil.test/pwn',
            '/\\evil.test/pwn',
            // Contrabando authority-relative con los caracteres que el parser del navegador BORRA
            // antes de parsear: las tres empiezan por '/' y su segundo caracter no es '/' ni '\',
            // asi que pasaban el chequeo sobre la cadena cruda — y el navegador resuelve las tres a
            // https://evil.test/ (open redirect almacenado sobre un <a target="_blank">).
            '/\t/evil.test',
            '/\n/evil.test',
            '/\r\\evil.test',
        ]) {
            const html = render([{ platform: 'X', url, icon: 'fa-brands fa-x-twitter' }]);
            expect(hrefs(html), url).toEqual([]);
            // The icon survives — the fix drops the navigation, not the content.
            expect(html, url).toContain('fa-x-twitter');
            expect(html, url).toContain('aria-label="X"');
        }
    });
});

/**
 * The built-in footer's column headings follow the SITE language (WPLANG), resolved on the server by
 * lib/public/uiStrings — they were hard-coded English, so a Spanish site showed «Quick Links».
 */
describe('Footer — column headings', () => {
    const menu = [{ id: 1, title: 'Home', url: '/' }];
    const socials = [{ platform: 'Web', url: '/contact', icon: 'fa-solid fa-globe' }];
    const renderIn = (wplang?: string) => renderToStaticMarkup(
        <Footer previewSettings={{ blogname: 'Site' }} previewMenu={menu} previewSocials={socials}
            strings={wplang === undefined ? undefined : footerStrings({ WPLANG: wplang })} />,
    );

    it('renders them in the site language', () => {
        expect(renderIn('es_ES')).toContain('>Enlaces rápidos<');
        expect(renderIn('es_ES')).toContain('>Síguenos<');
        expect(renderIn('pt_BR')).toContain('>Links rápidos<');
        expect(renderIn('en_US')).toContain('>Quick Links<');
        expect(renderIn('en_US')).toContain('>Connect<');
    });

    it('keeps the English headings when no strings are passed (editor canvas)', () => {
        expect(renderIn()).toContain('>Quick Links<');
        expect(renderIn()).toContain('>Connect<');
    });
});
