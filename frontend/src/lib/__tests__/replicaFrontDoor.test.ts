/**
 * WordJS — A FRONTEND REPLICA AS THE FRONT DOOR (`WORDJS_BACKEND_URL` set): what the backend is told
 * about the client, for EVERY request the replica lets through.
 *
 * The replica has two ways to reach the backend: its own proxy (proxyToBackend) for the paths
 * isProxiedPath() claims, and Next's `/api/:path*` rewrite for whatever Next routes there itself. Next
 * matches the rewrite against the WHATWG-resolved path, so `/x/../api/v1/auth/login` or
 * `/x/%2e%2e/api/v1/auth/login` is not isProxiedPath() here and still reached the backend through Next's
 * rewrite; so did every WebSocket upgrade, which server.js never saw and Next's own upgrade listener
 * rewrote. Next's proxy relays the request's headers as they are, so the client's X-Forwarded-For /
 * X-Forwarded-Proto / X-Real-IP / Forwarded arrived at a backend that believes them from this hop: the
 * address its limiters, login gate and audit log key on, and the scheme its Secure-cookie and sign-in
 * rules read, were the client's choice.
 *
 * These tests drive the REAL handlers server.js mounts (createReplicaDispatch /
 * createReplicaUpgradeHandler). Next is stood in for by its own pieces: the rewrite sources of the real
 * next.config.ts compiled with Next's matcher and the config's own case sensitivity, applied to the path
 * as Next's parser resolves it, and Next's own proxyRequest — against a real upstream that records what
 * it received.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import http from 'node:http';
import url from 'node:url';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import nextConfig from '../../../next.config';
import mod from '../../../backend-proxy-target.js';

const { createReplicaDispatch, createReplicaUpgradeHandler, hasDotSegments } = mod as any;
const nodeRequire = createRequire(import.meta.url);
const { proxyRequest } = nodeRequire('next/dist/server/lib/router-utils/proxy-request.js');

type Listening = { url: string; port: number; server: http.Server; close: () => Promise<void> };
type Matcher = (pathname: string) => unknown;

function listen(handler: http.RequestListener, onUpgrade?: (...a: any[]) => void): Promise<Listening> {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        if (onUpgrade) server.on('upgrade', onUpgrade);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve({
                url: `http://127.0.0.1:${port}`,
                port,
                server,
                close: () =>
                    new Promise<void>((done) => {
                        server.closeAllConnections?.();
                        server.close(() => done());
                    }),
            });
        });
    });
}

/** Next's rewrite matchers, compiled from the real next.config.ts the way Next compiles them. */
async function rewriteMatchers(sensitive: boolean | undefined): Promise<Matcher[]> {
    const rewrites = (await nextConfig.rewrites!()) as Array<{ source: string }>;
    return rewrites.map((r) => getPathMatch(r.source, { removeUnnamedParams: true, strict: true, sensitive }));
}

/** Where Next's router sends a request: the backend when a rewrite matches the resolved path, else null. */
function nextRewriteTarget(matchers: Matcher[], backendUrl: string, rawUrl: string): url.UrlWithParsedQuery | null {
    const resolved = new URL(rawUrl, 'http://next.invalid'); // parseRelativeUrl: dot segments resolved
    if (!matchers.some((m) => m(resolved.pathname) !== false)) return null;
    return url.parse(`${backendUrl}${resolved.pathname}${resolved.search}`, true);
}

function nextStandIn(matchers: Matcher[], backendUrl: string) {
    return (req: http.IncomingMessage, res: http.ServerResponse) => {
        const parsed = nextRewriteTarget(matchers, backendUrl, req.url || '/');
        if (!parsed) {
            res.writeHead(200, { 'Content-Type': 'text/plain' }).end('a Next page');
            return;
        }
        void proxyRequest(req, res, parsed).catch(() => {});
    };
}

function replicaServer(backendTarget: string | null, handle: (req: any, res: any, parsed?: any) => void) {
    return listen((req, res) => createReplicaDispatch({ backendTarget, handle })(req, res, url.parse(req.url || '/', true)));
}

const FORGED = {
    'X-Forwarded-For': '203.0.113.9',
    'X-Forwarded-Host': 'evil.example',
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Port': '443',
    'X-Forwarded-Server': 'evil.example',
    'X-Real-IP': '203.0.113.9',
    Forwarded: 'for=203.0.113.9;host=evil.example;proto=https',
};

function send(port: number, path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const r = http.request(
            { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: 'site.example', ...FORGED } },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => (body += c));
                res.on('end', () => resolve({ status: res.statusCode || 0, body }));
            },
        );
        r.on('error', reject);
        r.end();
    });
}

function expectPinned(seen: Record<string, any>) {
    // The peer the replica actually saw, the Host it received and the scheme of its own listener —
    // never the client's claims.
    expect(seen['x-forwarded-for']).toBe('127.0.0.1');
    expect(seen['x-forwarded-host']).toBe('site.example');
    expect(seen['x-forwarded-proto']).toBe('http');
    for (const name of ['forwarded', 'x-real-ip', 'x-forwarded-port', 'x-forwarded-server']) {
        expect(seen[name], name).toBeUndefined();
    }
}

// What the GATEWAY sends to a frontend replica over mTLS: it changed the origin (Host is the replica's
// own internal host) and pinned the forwarding headers at its edge — X-Forwarded-Host is the SITE's
// canonical host it judged, X-Forwarded-For carries the real client, X-Forwarded-Proto is the gateway's
// public scheme. A replica that re-pins here would clobber all three.
const GATEWAY_FORWARDED = {
    Host: 'frontend-replica-7.internal',
    'X-Forwarded-Host': 'site.example',
    'X-Forwarded-For': '198.51.100.7',
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Port': '443',
};

function replicaServerTrusted(backendTarget: string | null, handle: (req: any, res: any, parsed?: any) => void) {
    return listen((req, res) => createReplicaDispatch({ backendTarget, handle, trustForwardedHeaders: true })(req, res, url.parse(req.url || '/', true)));
}

function sendWith(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode || 0, body }));
        });
        r.on('error', reject);
        r.end();
    });
}

function expectGatewayPreserved(seen: Record<string, any>) {
    // The gateway's judged values survive untouched — NOT overwritten with the replica's internal Host,
    // the gateway's own address, or the replica listener's scheme.
    expect(seen['x-forwarded-host']).toBe('site.example');
    expect(seen['x-forwarded-for']).toBe('198.51.100.7');
    expect(seen['x-forwarded-proto']).toBe('https');
    expect(seen['x-forwarded-port']).toBe('443');
}

const DOT_SEGMENT_PATHS = [
    '/x/../api/v1/auth/login',
    '/x/%2e%2e/api/v1/auth/login',
    '/x/%2E./api/v1/users',
    '/x/.%2e/api/v1/users',
    '/uploads/../api/v1/users/me',
    '/./api/v1/users',
];

let configMatchers: Matcher[] = [];
beforeAll(async () => {
    configMatchers = await rewriteMatchers(nextConfig.experimental?.caseSensitiveRoutes);
});

describe('a replica with a pinned backend: what reaches the backend through Next', () => {
    test("a dot-segment path, which Next's rewrite resolves into /api, is refused at the door and never reaches the backend", async () => {
        // Control: with the real config Next WOULD rewrite each of these to the backend.
        for (const p of DOT_SEGMENT_PATHS) {
            expect(nextRewriteTarget(configMatchers, 'http://b.invalid', p), p).not.toBeNull();
        }
        let hits = 0;
        const backend = await listen((_req, res) => {
            hits += 1;
            res.writeHead(200).end('ok');
        });
        const replica = await replicaServer(backend.url, nextStandIn(configMatchers, backend.url));
        try {
            for (const path of [...DOT_SEGMENT_PATHS, '/x/..;/api/v1/users', '/x\\..\\api/v1/users']) {
                const { status, body } = await send(replica.port, path);
                expect(status, path).toBe(400);
                expect(JSON.parse(body).code, path).toBe('rest_bad_path');
            }
            expect(hits).toBe(0);
            // A dot inside a NAME is not a dot segment.
            expect(hasDotSegments('/uploads/2026/10/photo.final.jpg')).toBe(false);
            expect(hasDotSegments('/.well-known/acme-challenge/abc')).toBe(false);
            expect((await send(replica.port, '/blog/v1.2-release')).status).toBe(200);
        } finally {
            await replica.close();
            await backend.close();
        }
    });

    test("whatever Next forwards carries this hop's forwarding headers: the pin does not depend on the two dispatchers agreeing", async () => {
        // Next's DEFAULT routing (caseSensitiveRoutes off) is one such disagreement: `/API/...` is not
        // isProxiedPath() and Next's rewrite still takes it. Any future one gets the same treatment.
        const defaultMatchers = await rewriteMatchers(false);
        const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
        const backend = await listen((req, res) => {
            seen.push({ url: req.url || '', headers: req.headers });
            res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
        });
        const replica = await replicaServer(backend.url, nextStandIn(defaultMatchers, backend.url));
        try {
            for (const path of ['/API/v1/auth/login', '/Api/v1/users/me?context=edit', '/api/v1/auth/login']) {
                expect((await send(replica.port, path)).status, path).toBe(200);
            }
            expect(seen.map((s) => s.url)).toEqual(['/API/v1/auth/login', '/Api/v1/users/me?context=edit', '/api/v1/auth/login']);
            for (const s of seen) expectPinned(s.headers);
        } finally {
            await replica.close();
            await backend.close();
        }
    });

    test('pages Next serves itself see the pinned values too (an SSR read relays them to the backend)', async () => {
        let seenByNext: http.IncomingHttpHeaders | null = null;
        const replica = await replicaServer('http://127.0.0.1:1', (r: http.IncomingMessage, s: http.ServerResponse) => {
            seenByNext = { ...r.headers };
            s.writeHead(200).end('page');
        });
        try {
            expect((await send(replica.port, '/preview/42')).status).toBe(200);
            expectPinned(seenByNext as any);
        } finally {
            await replica.close();
        }
    });

    test('with NO backend pinned nothing changes: Next receives the request exactly as it arrived', async () => {
        let seenByNext: http.IncomingHttpHeaders | null = null;
        const replica = await replicaServer(null, (r: http.IncomingMessage, s: http.ServerResponse) => {
            seenByNext = { ...r.headers };
            s.writeHead(200).end('page');
        });
        try {
            expect((await send(replica.port, '/x/../api/v1/users')).status).toBe(200);
            expect((seenByNext as any)['x-forwarded-for']).toBe('203.0.113.9');
            expect((seenByNext as any)['x-real-ip']).toBe('203.0.113.9');
        } finally {
            await replica.close();
        }
    });
});

describe('a gateway-fronted replica (mTLS listener) keeps the gateway\'s forwarding headers', () => {
    test('the backend sees the gateway\'s judged X-Forwarded-* through the replica\'s /api proxy, not re-pinned', async () => {
        let seen: http.IncomingHttpHeaders | null = null;
        const backend = await listen((req, res) => {
            seen = req.headers;
            res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
        });
        const replica = await replicaServerTrusted(backend.url, (_r: any, s: any) => s.writeHead(200).end('page'));
        try {
            expect((await sendWith(replica.port, '/api/v1/users/me', GATEWAY_FORWARDED)).status).toBe(200);
            expect(seen, 'the request reached the backend').not.toBeNull();
            expectGatewayPreserved(seen as any);
        } finally {
            await replica.close();
            await backend.close();
        }
    });

    test('a page Next serves (SSR) also sees the gateway\'s headers, not the replica\'s', async () => {
        let seenByNext: http.IncomingHttpHeaders | null = null;
        const replica = await replicaServerTrusted('http://127.0.0.1:1', (r: http.IncomingMessage, s: http.ServerResponse) => {
            seenByNext = { ...r.headers };
            s.writeHead(200).end('page');
        });
        try {
            expect((await sendWith(replica.port, '/preview/42', GATEWAY_FORWARDED)).status).toBe(200);
            expectGatewayPreserved(seenByNext as any);
        } finally {
            await replica.close();
        }
    });

    test('a dot-segment path is still refused when the gateway\'s forwarding headers are trusted', async () => {
        let hits = 0;
        const backend = await listen((_req, res) => { hits += 1; res.writeHead(200).end('ok'); });
        const replica = await replicaServerTrusted(backend.url, nextStandIn(configMatchers, backend.url));
        try {
            const { status, body } = await sendWith(replica.port, '/x/%2e%2e/api/v1/auth/login', GATEWAY_FORWARDED);
            expect(status).toBe(400);
            expect(JSON.parse(body).code).toBe('rest_bad_path');
            expect(hits).toBe(0);
        } finally {
            await replica.close();
            await backend.close();
        }
    });
});

describe('WebSocket upgrades take the same rewrite, so they get the same rules', () => {
    /** A replica wired as server.js wires it: Next's upgrade listener on the emitter it is given. */
    async function replicaWithNextUpgrades(backendUrl: string) {
        const upgrades = new EventEmitter();
        // Next's router-server upgrade path: resolve the rewrite, then proxyRequest(req, socket, parsedUrl, head).
        upgrades.on('upgrade', (req: http.IncomingMessage, socket: any, head: Buffer) => {
            const parsed = nextRewriteTarget(configMatchers, backendUrl, req.url || '/');
            if (!parsed) return socket.end();
            void proxyRequest(req, socket, parsed, head).catch(() => {});
        });
        const onUpgrade = createReplicaUpgradeHandler({ backendTarget: backendUrl, upgrades });
        return listen((_req, res) => res.writeHead(404).end(), onUpgrade);
    }

    function upgradeRequest(port: number, path: string): Promise<void> {
        return new Promise((resolve) => {
            const r = http.request({
                host: '127.0.0.1',
                port,
                path,
                method: 'GET',
                headers: {
                    Host: 'site.example',
                    Connection: 'Upgrade',
                    Upgrade: 'websocket',
                    'Sec-WebSocket-Version': '13',
                    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                    ...FORGED,
                },
            });
            const done = () => resolve();
            r.on('upgrade', (_res, socket) => {
                socket.destroy();
                done();
            });
            r.on('response', (res) => {
                res.resume();
                res.on('end', done);
                res.on('close', done);
            });
            r.on('error', done);
            r.on('close', done);
            r.end();
        });
    }

    test("an upgrade to /api reaches the backend with this hop's headers, not the client's", async () => {
        // A backend with no WebSocket of its own answers an upgrade request as an ordinary GET.
        let seen: http.IncomingHttpHeaders | null = null;
        const backend = await listen((req, res) => {
            seen = req.headers;
            res.writeHead(200).end('{}');
        });
        const replica = await replicaWithNextUpgrades(backend.url);
        try {
            await upgradeRequest(replica.port, '/api/v1/users/me');
            expect(seen, 'the upgrade reached the backend').not.toBeNull();
            expectPinned(seen as any);
        } finally {
            await replica.close();
            await backend.close();
        }
    });

    test('a dot-segment upgrade is refused, and an upgrade before Next is listening is closed, not left hanging', async () => {
        let hits = 0;
        const backend = await listen((_req, res) => {
            hits += 1;
            res.writeHead(200).end('{}');
        });
        const replica = await replicaWithNextUpgrades(backend.url);
        const idle = await listen(
            (_req, res) => res.writeHead(404).end(),
            createReplicaUpgradeHandler({ backendTarget: backend.url, upgrades: new EventEmitter() }),
        );
        try {
            await upgradeRequest(replica.port, '/x/%2e%2e/api/v1/users/me');
            await upgradeRequest(idle.port, '/api/v1/users/me'); // resolves only because the socket is closed
            expect(hits).toBe(0);
        } finally {
            await idle.close();
            await replica.close();
            await backend.close();
        }
    });
});
