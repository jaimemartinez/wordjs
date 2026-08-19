/**
 * #26 — THE CSP AND THE EMBED ALLOWLIST ARE ONE LIST.
 *
 * `frame-src` used to be written out by hand in next.config.ts, next to a comment claiming it covered
 * "the sanitizer's permitted youtube/vimeo embeds" — while naming a DIFFERENT list. The block resolves
 * URLs against ALLOWED_EMBED_HOSTS, which includes `www.youtube-nocookie.com`: exactly the URL YouTube
 * hands an author who ticks "Enable privacy-enhanced mode" under Share → Embed. So the block accepted
 * it, rendered a real <iframe>, and the browser refused the frame. No placeholder either, because as
 * far as the code was concerned the embed had resolved — just an empty hole, on the public site AND in
 * /admin, in all three deploy modes.
 *
 * The test drives the REAL producers on both sides: `nextConfig.headers()` (the function Next calls to
 * build the header) and `resolveVideoEmbedUrl` (the function the block calls to build the src). A test
 * that compared two copies of the host list to each other would have passed while the header was
 * wrong — the header string is the thing the browser enforces, so the header string is what is read.
 */
import { describe, expect, it } from 'vitest';
import nextConfig from '../../../next.config';
import { ALLOWED_EMBED_HOSTS, ALLOWED_IFRAME_HOSTS, resolveVideoEmbedUrl } from '../sanitize';
// CommonJS with no `export` statement → tsc sees a script, not a module (backend/tsconfig.json sets
// `moduleDetection: force`; the frontend's does not). Resolution and execution are fine.
// @ts-expect-error -- CommonJS module, no ESM export statement
import backendMeta from '../../../../backend/src/core/sanitize-meta';

const be = backendMeta as unknown as { sanitize: (html: string) => string };

async function cspDirectives(): Promise<Map<string, string[]>> {
    const groups = await (nextConfig.headers as () => Promise<any[]>)();
    const csp = groups
        .flatMap((g: any) => g.headers as Array<{ key: string; value: string }>)
        .find((h) => h.key === 'Content-Security-Policy');
    expect(csp, 'every route must still carry a CSP').toBeTruthy();
    const out = new Map<string, string[]>();
    for (const directive of csp!.value.split(';')) {
        const [name, ...values] = directive.trim().split(/\s+/);
        if (name) out.set(name, values);
    }
    return out;
}

describe('frame-src is derived from ALLOWED_EMBED_HOSTS', () => {
    it('permits exactly self plus one https origin per allowed embed host', async () => {
        const frameSrc = (await cspDirectives()).get('frame-src');
        expect(frameSrc).toEqual(["'self'", ...ALLOWED_EMBED_HOSTS.map((h) => `https://${h}`)]);
    });

    it('a host cannot be added to one list and forgotten in the other', async () => {
        const frameSrc = new Set((await cspDirectives()).get('frame-src'));
        for (const host of ALLOWED_EMBED_HOSTS) {
            expect(frameSrc.has(`https://${host}`), `frame-src is missing ${host}`).toBe(true);
        }
        // …and nothing the block would never build a src for is quietly framed either.
        for (const origin of frameSrc) {
            if (origin === "'self'") continue;
            expect(ALLOWED_EMBED_HOSTS.map((h) => `https://${h}`)).toContain(origin);
        }
    });

    it('the regression itself: a privacy-enhanced YouTube embed resolves AND is framable', async () => {
        const src = resolveVideoEmbedUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
        expect(src).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1');
        const origin = new URL(src!).origin;
        expect((await cspDirectives()).get('frame-src')).toContain(origin);
    });

    it('the structural directives this header exists for are untouched', async () => {
        const csp = await cspDirectives();
        expect(csp.get('frame-ancestors')).toEqual(["'self'"]);
        expect(csp.get('object-src')).toEqual(["'none'"]);
        expect(csp.get('base-uri')).toEqual(["'self'"]);
    });
});

describe('the backend copy of the list does not delete what the frontend accepts', () => {
    it('sanitize() keeps an iframe on every allowed embed host', () => {
        for (const host of ALLOWED_EMBED_HOSTS) {
            const html = `<iframe src="https://${host}/embed/x" width="560" height="315"></iframe>`;
            expect(be.sanitize(html), `backend sanitize() dropped ${host}`).toContain(host);
        }
    });

    it('and still drops an iframe on any other host', () => {
        expect(be.sanitize('<iframe src="https://evil.example/embed/x"></iframe>')).not.toContain('evil.example');
        // A look-alike host must not pass by prefix/suffix either.
        expect(be.sanitize('<iframe src="https://www.youtube.com.evil.example/embed/x"></iframe>'))
            .not.toContain('evil.example');
    });

    it('ALLOWED_EMBED_HOSTS is ALLOWED_IFRAME_HOSTS plus the cookie-less mirror', () => {
        for (const host of ALLOWED_IFRAME_HOSTS) expect(ALLOWED_EMBED_HOSTS).toContain(host);
        expect(ALLOWED_EMBED_HOSTS).toContain('www.youtube-nocookie.com');
    });
});
