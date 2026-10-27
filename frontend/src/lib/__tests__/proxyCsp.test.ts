/**
 * THE POLICY src/proxy.ts WRITES ON EVERY DOCUMENT.
 *
 * The dynamic documents (admin, sign-in, install, migration, portals) get a fresh nonce on each request,
 * in the response header AND in the request header Next reads to stamp its scripts. The public pages —
 * served from the ISR cache — get no nonce, never take one from the client, and allow only the script
 * origins the active plugins declare in GET /plugins/assets.
 *
 * MUTATION PROOF: hand the public pages the old `https:`, or skip deleting the client's request policy
 * header, and a case below fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../../proxy';
import { _clearPublicScriptOrigins } from '../publicScriptOrigins';

const req = (path: string, headers: Record<string, string> = {}) => new NextRequest(new URL(path, 'http://example.com'), { headers });

function scriptSrc(csp: string | null): string[] {
    const d = String(csp || '').split(';').map((x) => x.trim()).find((x) => x.startsWith('script-src '));
    return d ? d.split(/\s+/).slice(1) : [];
}

/** The request headers the proxy hands to Next (its override list). */
function passed(res: Response, name: string): string | null {
    return res.headers.get(`x-middleware-request-${name}`);
}

describe('proxy: every document gets its Content-Security-Policy', () => {
    let calls = 0;
    beforeEach(() => {
        _clearPublicScriptOrigins();
        calls = 0;
        vi.stubGlobal('fetch', async (url: string) => {
            calls += 1;
            expect(String(url)).toMatch(/\/plugins\/assets$/);
            return new Response(JSON.stringify({ scripts: [
                { handle: 'analytics-tag:analytics-tag-loader', src: '/plugins/analytics-tag/public/loader.js', origins: ['https://plausible.io'] },
                { handle: 'x:y', src: '/plugins/x/public/y.js', origins: ['https:', '*', 'https://evil.example.com/path'] },
            ], styles: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('a dynamic document gets a fresh nonce, in the response and in what Next reads', async () => {
        const nonces = new Set<string>();
        for (const p of ['/admin', '/admin/plugin/tracking', '/login', '/install', '/portal/x']) {
            const res = await proxy(req(p));
            const csp = res.headers.get('content-security-policy');
            const src = scriptSrc(csp);
            const nonce = src.find((s) => s.startsWith("'nonce-"));
            expect(nonce, p).toBeTruthy();
            expect(src, p).toContain("'strict-dynamic'");
            expect(src, p).not.toContain("'unsafe-inline'");
            expect(passed(res, 'content-security-policy'), p).toBe(csp);
            nonces.add(nonce!);
        }
        expect(nonces.size).toBe(5);
        expect(calls, 'a dynamic document does not need the declared origins').toBe(0);
    });

    it('a public page gets no nonce, only the declared origins, and the client cannot hand it one', async () => {
        const res = await proxy(req('/about', { 'content-security-policy': "script-src 'nonce-attacker'" }));
        const src = scriptSrc(res.headers.get('content-security-policy'));
        expect(src).toEqual(["'self'", "'unsafe-inline'", 'blob:', 'https://plausible.io']);
        expect(src.some((s) => s.startsWith("'nonce-"))).toBe(false);
        // Next must not see a policy on the request of a cached page: it would read the client's nonce.
        expect(passed(res, 'content-security-policy')).toBeNull();
        expect(String(res.headers.get('x-middleware-override-headers') || '')).not.toMatch(/content-security-policy/);
    });

    it('the declared origins are read once for a while, not on every request', async () => {
        for (let i = 0; i < 5; i++) await proxy(req('/'));
        expect(calls).toBe(1);
    });

    it('a backend that does not answer leaves the public pages with no third-party origin', async () => {
        vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
        const res = await proxy(req('/'));
        expect(scriptSrc(res.headers.get('content-security-policy'))).toEqual(["'self'", "'unsafe-inline'", 'blob:']);
    });

    it('a 404 or 400 the proxy answers itself still carries a policy', async () => {
        const nf = await proxy(req('/wjs-site/two.example.org'));
        expect(nf.status).toBe(404);
        expect(nf.headers.get('content-security-policy')).toMatch(/form-action 'self'/);
    });
});
