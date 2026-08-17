/**
 * WordJS — WHICH BACKEND A FRONTEND REPLICA TALKS TO (`WORDJS_BACKEND_URL`).
 *
 * Two things are pinned here, and they are different in kind.
 *
 * RESOLUTION — the precedence env > config `gatewayPort` > compiled-in default, plus the rule that a
 * malformed override THROWS instead of quietly falling back. That rule is the whole point of the
 * feature: an operator who mistypes the address of their backend must find out at boot, not from
 * editors whose collaboration stream lands on the wrong node.
 *
 * PROXYING — the runtime path. Next bakes `rewrites()` into `.next/routes-manifest.json` at build
 * time, so on a pre-compiled release the rewrite cannot honour an env var at all; `server.js` proxies
 * `/api` and `/uploads` itself. These tests drive `proxyToBackend` against a real upstream and assert
 * the two properties that decide whether live collaboration survives the hop: the request the backend
 * sees is byte-for-byte what Next's own rewrite proxy would have sent (`Host` = target,
 * `x-forwarded-host` = caller — its CSRF/Origin and host guards depend on exactly this), and an SSE
 * response is STREAMED, not accumulated. A proxy that buffers looks perfect in a unit test that waits
 * for the end of the response and delivers a collaborative editor that updates once, when the other
 * author closes the tab.
 */
import { describe, expect, test } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import mod from '../../../backend-proxy-target.js';

const {
    BACKEND_URL_ENV,
    DEFAULT_PROXY_TARGET,
    sanitizeProxyTarget,
    resolveBackendProxyTarget,
    backendUrlFromEnv,
    upstreamPath,
    isProxiedPath,
    proxyToBackend,
} = mod as any;

describe('resolveBackendProxyTarget — precedence', () => {
    test('the env override wins over a configured gateway port', () => {
        const r = resolveBackendProxyTarget({ env: 'http://10.0.1.23:4000', gatewayPort: 3000 });
        expect(r).toEqual({ target: 'http://10.0.1.23:4000', source: 'env' });
    });

    test('without the override, the configured gateway port is used — the historical behaviour', () => {
        const r = resolveBackendProxyTarget({ gatewayPort: 3443 });
        expect(r).toEqual({ target: 'https://localhost:3443', source: 'config' });
    });

    test('with neither, the compiled-in default', () => {
        expect(resolveBackendProxyTarget({})).toEqual({ target: DEFAULT_PROXY_TARGET, source: 'default' });
        expect(DEFAULT_PROXY_TARGET).toBe('http://localhost:3000');
    });

    test('an empty or whitespace override means UNSET, not malformed — it falls through', () => {
        expect(resolveBackendProxyTarget({ env: '', gatewayPort: 3000 }).source).toBe('config');
        expect(resolveBackendProxyTarget({ env: '   ', gatewayPort: 3000 }).source).toBe('config');
        expect(resolveBackendProxyTarget({ env: undefined, gatewayPort: 3000 }).source).toBe('config');
        expect(resolveBackendProxyTarget({ env: null, gatewayPort: 3000 }).source).toBe('config');
    });

    test('a junk gatewayPort is dropped (it falls through), unlike a junk override', () => {
        expect(resolveBackendProxyTarget({ gatewayPort: 'not-a-port' }).source).toBe('default');
        expect(resolveBackendProxyTarget({ gatewayPort: 99999 }).source).toBe('default');
    });

    test('the override is canonicalised, not echoed: trailing slashes and case go away', () => {
        expect(resolveBackendProxyTarget({ env: 'HTTP://Backend-A.Internal:4000/' }).target).toBe(
            'http://backend-a.internal:4000',
        );
        expect(resolveBackendProxyTarget({ env: '  http://10.0.1.23:4000  ' }).target).toBe('http://10.0.1.23:4000');
    });

    test('a path prefix survives (a backend published under a sub-path)', () => {
        expect(resolveBackendProxyTarget({ env: 'https://edge.internal/wordjs' }).target).toBe(
            'https://edge.internal/wordjs',
        );
    });

    test('a `..` in the prefix is RESOLVED by the parser, so no traversal reaches the request', () => {
        // The target is rebuilt from the parsed pieces, and URL parsing has already collapsed the
        // dot-segments — what goes on the wire can never contain `..`, whatever was configured.
        const { target } = resolveBackendProxyTarget({ env: 'http://edge.internal:4000/a/../b' });
        expect(target).toBe('http://edge.internal:4000/b');
        expect(upstreamPath(target, '/api/v1/posts')).toBe('/b/api/v1/posts');
    });
});

describe('resolveBackendProxyTarget — a malformed override is a boot failure, never a silent fallback', () => {
    // Every one of these used to be a way to send a replica's traffic somewhere the operator did not
    // mean. They must not resolve to DEFAULT_PROXY_TARGET; they must stop the process.
    const rejected: Array<[string, string]> = [
        ['not a URL at all', 'backend-a.internal:4000'],
        ['scheme outside the allowlist', 'ftp://backend-a.internal:4000'],
        ['a file: URL', 'file:///etc/passwd'],
        ['javascript:', 'javascript:alert(1)'],
        ['credentials in the URL', 'http://someone@169.254.169.254'],
        ['credentials with a password', 'http://user:pass@backend-a.internal:4000'],
        ['a query string', 'http://backend-a.internal:4000?x=1'],
        ['a fragment', 'http://backend-a.internal:4000#frag'],
        ['port 0', 'http://backend-a.internal:0'],
        ['a path segment outside the allowlist', 'http://backend-a.internal:4000/a b'],
        ['a percent-escape in the path', 'http://backend-a.internal:4000/a%2f..%2fb'],
    ];

    for (const [why, value] of rejected) {
        test(`rejects ${why}: ${value}`, () => {
            expect(() => resolveBackendProxyTarget({ env: value, gatewayPort: 3000 })).toThrow(BACKEND_URL_ENV);
            expect(sanitizeProxyTarget(value)).toBeNull();
        });
    }

    test('the error names the variable AND the offending value', () => {
        let message = '';
        try {
            resolveBackendProxyTarget({ env: 'nonsense' });
        } catch (e: any) {
            message = String(e.message);
        }
        expect(message).toContain('WORDJS_BACKEND_URL');
        expect(message).toContain('nonsense');
    });

    test('accepts the shapes an operator actually types', () => {
        for (const ok of [
            'http://10.0.1.23:4000',
            'https://backend-a.internal',
            'http://backend_a:4000', // underscores: legal in a compose/service name
            'http://[::1]:4000',
            'https://192.168.182.138:4000',
        ]) {
            expect(sanitizeProxyTarget(ok)).not.toBeNull();
        }
    });
});

describe('backendUrlFromEnv', () => {
    test('reads the variable from a supplied environment and returns null when unset', () => {
        expect(backendUrlFromEnv({ [BACKEND_URL_ENV]: 'http://10.0.1.23:4000' })).toBe('http://10.0.1.23:4000');
        expect(backendUrlFromEnv({})).toBeNull();
        expect(backendUrlFromEnv({ [BACKEND_URL_ENV]: '' })).toBeNull();
    });

    test('BACKEND_URL_ENV is the documented name', () => {
        expect(BACKEND_URL_ENV).toBe('WORDJS_BACKEND_URL');
    });
});

describe('which paths the backend owns', () => {
    test('EVERY prefix the backend mounts, not just the API', () => {
        expect(isProxiedPath('/api/v1/posts')).toBe(true);
        expect(isProxiedPath('/api')).toBe(true);
        expect(isProxiedPath('/uploads/2026/pic.png')).toBe(true);
        expect(isProxiedPath('/uploads')).toBe(true);
        // These four were missing, and their absence is not silent-but-harmless: a frontend reached
        // directly served the Next 404 page for its own theme's stylesheet, so the browser rejected
        // it on MIME type and the admin/editor rendered unstyled.
        expect(isProxiedPath('/themes/default/style.css')).toBe(true);
        expect(isProxiedPath('/public/css/wordjs-ui.css')).toBe(true);
        expect(isProxiedPath('/plugins/online-store/frontend.bundle.js')).toBe(true);
        expect(isProxiedPath('/.well-known/acme-challenge/token')).toBe(true);
    });

    test('the frontend keeps its own routes — and the health probes stay the node\'s own', () => {
        expect(isProxiedPath('/admin/posts/1/edit')).toBe(false);
        expect(isProxiedPath('/')).toBe(false);
        // Not a prefix match on the STRING: a page called /apiary is the frontend's.
        expect(isProxiedPath('/apiary')).toBe(false);
        expect(isProxiedPath('/uploadsomething')).toBe(false);
        expect(isProxiedPath('/themesong')).toBe(false);
        // Answering these for the backend would report the wrong node's health.
        expect(isProxiedPath('/healthz')).toBe(false);
        expect(isProxiedPath('/readyz')).toBe(false);
        expect(isProxiedPath('/metrics')).toBe(false);
    });

    test('the rewrite sources and the runtime proxy cover the SAME prefixes', () => {
        // One list, two consumers: a prefix added for `next build` that the runtime proxy does not
        // know about (or the reverse) is a deployment where half the site works.
        const fromRewrites = mod.rewriteSources().map((s: string) => s.replace('/:path*', ''));
        const fromProxy = mod.PROXIED_PREFIXES.map((p: string) => p.replace(/\/$/, ''));
        expect(fromRewrites).toEqual(fromProxy);
        for (const prefix of fromProxy) expect(isProxiedPath(`${prefix}/anything`)).toBe(true);
    });

    test('upstreamPath keeps the request verbatim and honours a target path prefix', () => {
        expect(upstreamPath('http://10.0.1.23:4000', '/api/v1/collab/7/stream?since=3')).toBe(
            '/api/v1/collab/7/stream?since=3',
        );
        expect(upstreamPath('http://10.0.1.23:4000/wordjs', '/api/v1/posts')).toBe('/wordjs/api/v1/posts');
    });
});

// ---------------------------------------------------------------------------
// The runtime proxy, against a real upstream.
// ---------------------------------------------------------------------------

function listen(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve({
                url: `http://127.0.0.1:${port}`,
                close: () =>
                    new Promise<void>((done) => {
                        server.closeAllConnections?.();
                        server.close(() => done());
                    }),
            });
        });
    });
}

/** A frontend server that proxies everything to `target` — what server.js does for /api. */
function frontendProxying(target: string) {
    return listen((req, res) => proxyToBackend(req, res, target));
}

describe('proxyToBackend — the request the backend sees', () => {
    test('Host is the target and x-forwarded-host is the caller (Next rewrite contract), cookies intact', async () => {
        let seen: any = null;
        const backend = await listen((req, res) => {
            seen = { method: req.method, url: req.url, headers: req.headers };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
        const frontend = await frontendProxying(backend.url);
        try {
            const res = await fetch(`${frontend.url}/api/v1/collab/7/ops?x=1`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: 'wordjs_token=abc', Origin: frontend.url },
                body: JSON.stringify({ ops: [1, 2, 3] }),
            });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ ok: true });

            const backendHost = new URL(backend.url).host;
            const frontendHost = new URL(frontend.url).host;
            expect(seen.method).toBe('POST');
            // Query string and path relayed verbatim.
            expect(seen.url).toBe('/api/v1/collab/7/ops?x=1');
            // changeOrigin: the upstream sees ITS OWN host…
            expect(seen.headers.host).toBe(backendHost);
            // …and the caller's host survives where the backend's guards look for it.
            expect(seen.headers['x-forwarded-host']).toBe(frontendHost);
            // The session cookie and Origin (the backend's same-origin CSRF check) are untouched.
            expect(seen.headers.cookie).toBe('wordjs_token=abc');
            expect(seen.headers.origin).toBe(frontend.url);
        } finally {
            await frontend.close();
            await backend.close();
        }
    });

    test('the request BODY is relayed (a collab op POST is not swallowed)', async () => {
        let body = '';
        const backend = await listen((req, res) => {
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                res.writeHead(202).end('accepted');
            });
        });
        const frontend = await frontendProxying(backend.url);
        try {
            const payload = JSON.stringify({ ops: Array.from({ length: 60 }, (_, i) => i) });
            const res = await fetch(`${frontend.url}/api/v1/collab/7/ops`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
            });
            expect(res.status).toBe(202);
            expect(body).toBe(payload);
        } finally {
            await frontend.close();
            await backend.close();
        }
    });

    test('an unreachable backend is a 502 that says so, not a hang', async () => {
        // Port 1 on loopback: nothing listens, connection is refused immediately.
        const frontend = await frontendProxying('http://127.0.0.1:1');
        try {
            const res = await fetch(`${frontend.url}/api/v1/posts`);
            expect(res.status).toBe(502);
            expect((await res.json()).code).toBe('backend_unreachable');
        } finally {
            await frontend.close();
        }
    });
});

describe('proxyToBackend — SSE must STREAM, not accumulate', () => {
    test('each event reaches the client before the response ends', async () => {
        // The upstream emits three events spaced in time and never ends, exactly like
        // /api/v1/collab/:id/stream. A buffering proxy delivers nothing until the socket closes.
        const backend = await listen((_req, res) => {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'X-Accel-Buffering': 'no',
            });
            res.write('retry: 3000\n\n');
            let n = 0;
            const timer = setInterval(() => {
                n += 1;
                res.write(`event: ops\ndata: {"n":${n}}\n\n`);
                if (n === 3) clearInterval(timer);
            }, 30);
            res.on('close', () => clearInterval(timer));
        });
        const frontend = await frontendProxying(backend.url);
        try {
            const controller = new AbortController();
            const res = await fetch(`${frontend.url}/api/v1/collab/7/stream`, { signal: controller.signal });
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toBe('text/event-stream');
            // The no-buffering hint the backend sets for nginx must survive the extra hop.
            expect(res.headers.get('x-accel-buffering')).toBe('no');

            const reader = (res.body as ReadableStream<Uint8Array>).getReader();
            const decoder = new TextDecoder();
            const received: string[] = [];
            const deadline = Date.now() + 5000;
            while (received.length < 3 && Date.now() < deadline) {
                const { value, done } = await reader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                for (const m of text.matchAll(/data: (\{"n":\d+\})/g)) received.push(m[1]);
            }
            // Three events arrived while the response was STILL OPEN — the proxy did not wait for the
            // end (there is no end) and did not coalesce them into one flush.
            expect(received).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
            controller.abort();
        } finally {
            await frontend.close();
            await backend.close();
        }
    });

    test('a client that disappears tears down the upstream request (no leaked SSE room)', async () => {
        let upstreamClosed = false;
        const backend = await listen((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('retry: 3000\n\n');
            req.on('close', () => {
                upstreamClosed = true;
            });
        });
        const frontend = await frontendProxying(backend.url);
        try {
            const controller = new AbortController();
            const res = await fetch(`${frontend.url}/api/v1/collab/7/stream`, { signal: controller.signal });
            const reader = (res.body as ReadableStream<Uint8Array>).getReader();
            await reader.read(); // the retry: line — the stream is live
            controller.abort();
            const deadline = Date.now() + 3000;
            while (!upstreamClosed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
            expect(upstreamClosed).toBe(true);
        } finally {
            await frontend.close();
            await backend.close();
        }
    });
});
