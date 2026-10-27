/**
 * MEDIA OFFLOAD — the two frontend halves (backend/src/core/media-storage.ts is the source of truth).
 *
 *   1. THE CSP ORIGIN (frontend/media-csp.js). The page CSP is baked at build time; the custom servers
 *      add the configured media/CDN origin at response time — to img-src and media-src, and NOTHING
 *      else. Read from the policy the REAL src/proxy.ts writes (lib/contentSecurityPolicy), through a real Node response.
 *   2. THE DELIVERY REWRITE (lib/mediaDelivery). Content keeps relative /uploads paths; only the SSR
 *      copy of a page points at the CDN, and only real /uploads URLs (not fonts, not absolute URLs).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { contentSecurityPolicy } from '../contentSecurityPolicy';
import { normalizeMediaBase, rewriteMediaString, rewriteMediaUrls, mediaBaseFromSettings } from '../mediaDelivery';
import { refreshMediaCdnOrigin, publishMediaCdnOrigin } from '../server-api';
import mediaCsp from '../../../media-csp.js';

const { withMediaOrigin, installMediaCsp, currentMediaOrigin, GLOBAL_KEY } = mediaCsp as {
    withMediaOrigin: (csp: string, origin: string | null) => string;
    installMediaCsp: (res: http.ServerResponse, getOrigin?: () => string | null) => http.ServerResponse;
    currentMediaOrigin: (env?: Record<string, string | undefined>) => string | null;
    GLOBAL_KEY: string;
};

/** The page policy src/proxy.ts writes on a public page (the one the custom servers then amend). */
async function builtCsp(): Promise<string> {
    return contentSecurityPolicy({});
}
const directives = (csp: string) => new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...v] = d.split(/\s+/);
    return [name, v] as [string, string[]];
}));

describe('media-csp: the configured media origin joins img-src and media-src only', () => {
    it('adds exactly one origin, creates media-src when the build set none, and changes nothing else', async () => {
        const base = await builtCsp();
        const out = withMediaOrigin(base, 'https://cdn.example.com/some/path?x=1');
        const before = directives(base);
        const after = directives(out);
        expect(after.get('img-src')).toEqual([...(before.get('img-src') || []), 'https://cdn.example.com']);
        expect(after.get('media-src')).toEqual(before.has('media-src')
            ? [...(before.get('media-src') || []), 'https://cdn.example.com']
            : ["'self'", 'https://cdn.example.com']);
        for (const [name, values] of before) {
            if (name === 'img-src' || name === 'media-src') continue;
            expect(after.get(name), name).toEqual(values);
        }
        expect([...after.keys()].filter((k) => !before.has(k))).toEqual(before.has('media-src') ? [] : ['media-src']);
    });

    it('without an origin — or with a value that is not an http(s) origin — the header is untouched', async () => {
        const base = await builtCsp();
        for (const bad of [null, '', 'javascript:alert(1)', "https://x.example.com; script-src *", 'data:text/html,x', 'not a url']) {
            // A value smuggling a second directive is not a URL at all (a space cannot be in a host).
            expect(withMediaOrigin(base, bad as any), String(bad)).toBe(base);
        }
        expect(withMediaOrigin(withMediaOrigin(base, 'https://cdn.example.com'), 'https://cdn.example.com'))
            .toBe(withMediaOrigin(base, 'https://cdn.example.com'));
    });

    it('amends a real response just before its head is written (setHeader then implicit writeHead)', async () => {
        const base = await builtCsp();
        const server = http.createServer((req, res) => {
            installMediaCsp(res, () => 'http://127.0.0.1:9000');
            res.setHeader('Content-Security-Policy', base);
            res.end('ok');
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        try {
            const { port } = server.address() as AddressInfo;
            const res = await fetch(`http://127.0.0.1:${port}/`);
            const csp = res.headers.get('content-security-policy') || '';
            expect(directives(csp).get('media-src')).toContain('http://127.0.0.1:9000');
            expect(directives(csp).get('img-src')).toContain('http://127.0.0.1:9000');
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    it('origin precedence: env override, then what the SSR last read, then nothing', () => {
        const g = globalThis as Record<string, unknown>;
        const saved = g[GLOBAL_KEY];
        try {
            g[GLOBAL_KEY] = 'https://cdn.from-settings.example';
            expect(currentMediaOrigin({ WORDJS_MEDIA_CDN_ORIGIN: 'https://cdn.env.example/x' })).toBe('https://cdn.env.example');
            expect(currentMediaOrigin({})).toBe('https://cdn.from-settings.example');
            g[GLOBAL_KEY] = '';
            expect(currentMediaOrigin({})).toBe(null); // the backend said: no media origin
        } finally {
            g[GLOBAL_KEY] = saved;
        }
    });
});

describe('mediaDelivery: SSR rewrite of /uploads to the CDN base', () => {
    const BASE = 'https://cdn.example.com/uploads';

    it('rewrites src values, srcset candidates and HTML attributes — not fonts, not absolute URLs', () => {
        expect(rewriteMediaString('/uploads/2026/10/a.jpg', BASE)).toBe(`${BASE}/2026/10/a.jpg`);
        expect(rewriteMediaString('/uploads/a-640w.jpg 640w, /uploads/a-960w.jpg 960w', BASE))
            .toBe(`${BASE}/a-640w.jpg 640w, ${BASE}/a-960w.jpg 960w`);
        expect(rewriteMediaString('<img src="/uploads/a.jpg" srcset="/uploads/a.webp 1x">', BASE))
            .toBe(`<img src="${BASE}/a.jpg" srcset="${BASE}/a.webp 1x">`);
        expect(rewriteMediaString('/uploads/fonts/inter.woff2', BASE)).toBe('/uploads/fonts/inter.woff2');
        expect(rewriteMediaString('https://site.example/uploads/a.jpg', BASE)).toBe('https://site.example/uploads/a.jpg');
        expect(rewriteMediaString('/uploadsx/a.jpg', BASE)).toBe('/uploadsx/a.jpg');
    });

    it('deep-copies block data, keeps the original untouched, and returns the same reference when nothing changed', () => {
        const data = { root: { props: {} }, content: [{ type: 'Image', props: { src: '/uploads/a.jpg', srcSetModern: { 'image/avif': '/uploads/a.avif 1400w' }, alt: 'x' } }] };
        const out = rewriteMediaUrls(data, BASE);
        expect(out).not.toBe(data);
        expect(out.content[0].props.src).toBe(`${BASE}/a.jpg`);
        expect(out.content[0].props.srcSetModern['image/avif']).toBe(`${BASE}/a.avif 1400w`);
        expect(data.content[0].props.src).toBe('/uploads/a.jpg');
        const noMedia = { content: [{ type: 'Heading', props: { text: 'hi' } }] };
        expect(rewriteMediaUrls(noMedia, BASE)).toBe(noMedia);
        expect(rewriteMediaUrls(data, '')).toBe(data);
    });

    it('only an http(s) base from the settings is used', () => {
        expect(mediaBaseFromSettings({ media_public_base: 'https://cdn.example.com/uploads/' })).toBe('https://cdn.example.com/uploads');
        expect(mediaBaseFromSettings({ media_public_base: '' })).toBe('');
        expect(mediaBaseFromSettings({ media_public_base: 'javascript:alert(1)' })).toBe('');
        expect(mediaBaseFromSettings(null)).toBe('');
        expect(normalizeMediaBase('https://cdn.example.com/x?y=1')).toBe('');
    });
});

describe('media-csp: a settings purge refreshes the published origin at once', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
        delete (globalThis as Record<string, unknown>).__WORDJS_MEDIA_CDN_REFRESHED_AT__;
    });

    it('a page render cannot put the stale origin back for a minute after a refresh', async () => {
        vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
        publishMediaCdnOrigin({ media_cdn_origin: 'https://old-cdn.example.com' });
        expect(currentMediaOrigin({})).toBe('https://old-cdn.example.com');
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ media_cdn_origin: 'http://media.lan:3900' }), { status: 200 }));
        await refreshMediaCdnOrigin();
        // getSettings, answering from the stale cache entry after the purge:
        vi.setSystemTime(1_000_000 + 20_000);
        publishMediaCdnOrigin({ media_cdn_origin: 'https://old-cdn.example.com' });
        expect(currentMediaOrigin({})).toBe('http://media.lan:3900');
        // ...and once the window is over, renders publish again (a later change without a purge):
        vi.setSystemTime(1_000_000 + 61_000);
        publishMediaCdnOrigin({ media_cdn_origin: 'https://next-cdn.example.com' });
        expect(currentMediaOrigin({})).toBe('https://next-cdn.example.com');
    });

    it('re-reads media_cdn_origin from the backend with no cache, and keeps the old value on failure', async () => {
        (globalThis as Record<string, unknown>)[GLOBAL_KEY] = 'https://old-cdn.example.com';
        const calls: Array<{ url: string; init: any }> = [];
        vi.stubGlobal('fetch', async (url: string, init: any) => {
            calls.push({ url: String(url), init });
            return new Response(JSON.stringify({ media_cdn_origin: 'http://media.lan:3900' }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        await refreshMediaCdnOrigin();
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toMatch(/\/settings$/);
        expect(calls[0].init.cache).toBe('no-store');
        expect(currentMediaOrigin({})).toBe('http://media.lan:3900');

        vi.stubGlobal('fetch', async () => new Response('down', { status: 502 }));
        await refreshMediaCdnOrigin();
        expect(currentMediaOrigin({})).toBe('http://media.lan:3900');
        vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED'); });
        await refreshMediaCdnOrigin();
        expect(currentMediaOrigin({})).toBe('http://media.lan:3900');
    });
});
