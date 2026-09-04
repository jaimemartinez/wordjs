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
import path from 'node:path';
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
    it('loads through the real Next TypeScript-config compiler', async () => {
        // Importing next.config.ts through Vitest does not reproduce how Next executes it: Next 16
        // transpiles the file into an in-memory next.config.compiled.js. A relative require from that
        // virtual module failed on clean Node 22 runners even though embed-hosts.js was tracked.
        const frontendDir = path.resolve(import.meta.dirname, '../../..');
        const loaderPath = path.join(frontendDir, 'node_modules/next/dist/build/next-config-ts/transpile-config.js');
        const { transpileConfig } = await import(loaderPath);
        const loaded = await transpileConfig({
            nextConfigPath: path.join(frontendDir, 'next.config.ts'),
            dir: frontendDir,
        });
        const config = loaded.default || loaded;
        expect(config).toBeTruthy();
        expect(typeof config.headers).toBe('function');
        expect(typeof config.rewrites).toBe('function');
        await expect(config.headers()).resolves.toBeTruthy();
        await expect(config.rewrites()).resolves.toBeTruthy();
    });

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

/**
 * `'unsafe-eval'` was removed from script-src. It had been there for the Puck visual editor, which is
 * retired: the real production client build carries no `eval(` and no `new Function(`, and the only two
 * `Function("` strings in the chunks are core-js's and decimal.js's global-object fallbacks, which
 * short-circuit on globalThis/self and never run in a browser. The bundled plugin admin bundles are clean
 * too. This reads the header the browser actually receives, so re-adding the keyword fails the build.
 */
describe("script-src is narrowed: no 'unsafe-eval'", () => {
    it('the removed keyword cannot creep back in', async () => {
        const scriptSrc = (await cspDirectives()).get('script-src');
        expect(scriptSrc, 'script-src must be present, not left to default-src').toBeTruthy();
        expect(scriptSrc).not.toContain("'unsafe-eval'");
        // Nor may it hide in a sibling script directive, or in worker-src (workers execute script too).
        for (const name of ['script-src-elem', 'script-src-attr', 'worker-src', 'default-src']) {
            expect(
                (await cspDirectives()).get(name) ?? [],
                `${name} must not allow 'unsafe-eval' either`,
            ).not.toContain("'unsafe-eval'");
        }
    });

    it('and the values that MUST stay are still there', async () => {
        // Guards against "fixing" the assertion above by gutting the directive.
        //   blob:           — plugin admin bundles via import(URL.createObjectURL(blob)) (pluginBundleLoader)
        //   https:          — analytics-tag's third-party tags, incl. an admin-entered Matomo origin
        //   'unsafe-inline' — the Next.js App Router bootstrap (nonce migration is a documented follow-up)
        const scriptSrc = (await cspDirectives()).get('script-src')!;
        expect(scriptSrc).toEqual(["'self'", "'unsafe-inline'", 'blob:', 'https:']);
        expect((await cspDirectives()).get('worker-src')).toEqual(["'self'", 'blob:']);
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
