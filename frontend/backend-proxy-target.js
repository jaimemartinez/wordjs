/**
 * WordJS — WHICH BACKEND THIS FRONTEND TALKS TO.
 *
 * The browser never holds an absolute API URL: `src/lib/api.ts` returns the RELATIVE `/api/v1` so the
 * same bundle works behind a gateway on any host, port or protocol, and the collaboration transport
 * (`src/lib/verso/collab/transport.ts`) opens its `EventSource` on that same relative path. Something
 * has to turn those relative URLs into a real upstream, and this module is the single place that
 * decides which one.
 *
 * Until now the upstream could only come from `wordjs-config.json` (`gatewayPort` → the gateway on
 * THIS host). That is right when one frontend sits next to one gateway, and it is not enough for
 * horizontal scaling: N frontend replicas each pinned to a different backend are the same files with
 * the same config file — the only thing that can differ per replica is its environment. Hence the
 * override.
 *
 * PRECEDENCE (strongest first):
 *   1. `WORDJS_BACKEND_URL` — this process's upstream origin, e.g. `http://10.0.1.23:4000`.
 *      Unset or empty means "no opinion" and falls through; a value that is not a usable origin is a
 *      hard error (see below), never a silent fallback.
 *   2. `wordjs-config.json` → `gatewayPort` — the gateway on this host, `https://localhost:<port>`.
 *   3. The compiled-in default, `http://localhost:3000` (the gateway's default public port).
 *
 * WHY THE OVERRIDE IS APPLIED TWICE — and why that is not belt-and-braces:
 *
 * Next resolves `rewrites()` ONCE, during `next build`, and writes the result into
 * `.next/routes-manifest.json`; `next start` loads that file and never calls the config function
 * again (`next/dist/server/next-server.js#getRoutesManifest`). An env var read only by
 * `next.config.ts` would therefore be honoured by `next dev` and by a build from source, and would
 * SILENTLY DO NOTHING on the pre-compiled release — which ships a prebuilt `.next` and is exactly the
 * artifact an operator deploys to N nodes. A setting that appears to work and does nothing is the
 * failure this project keeps paying for, so `server.js` applies the SAME resolution at runtime: when
 * `WORDJS_BACKEND_URL` is set, the frontend's own server proxies `/api/*` and `/uploads/*` before
 * Next sees the request, and the baked rewrite is never consulted. When it is NOT set, this module
 * changes nothing anywhere — the runtime proxy stays off and the rewrite behaves exactly as before.
 *
 * A MALFORMED OVERRIDE THROWS. Every other candidate here comes from a file the deploy already
 * trusts; `WORDJS_BACKEND_URL` is a deliberate act by an operator who is telling this replica where
 * its backend is. Quietly dropping it and proxying to `localhost:3000` instead would send that
 * replica's editors — including their live collaboration stream — to the wrong place, or to nowhere,
 * with nothing in the logs tying it back to the typo. Failing at boot names the variable and the
 * value.
 *
 * The shape rules are the ones `src/lib/server-api.ts` already applies to a backend base, for the
 * same reason: this is configuration data that SELECTS A DESTINATION, so it is validated against a
 * positive allowlist and REBUILT from the validated pieces rather than used as it was read.
 *
 * CommonJS on purpose: `next.config.ts` and `server.js` are the two consumers, and `server.js` is a
 * plain CommonJS custom server that cannot import TypeScript.
 */

/** The environment variable that pins this frontend replica to a backend. */
const BACKEND_URL_ENV = 'WORDJS_BACKEND_URL';

/** Compiled-in fallback: the gateway's default public port on this host. */
const DEFAULT_PROXY_TARGET = 'http://localhost:3000';

const PROXY_PROTOCOLS = ['http:', 'https:'];
// A host name or IPv4 literal: labels joined by dots, optional FQDN root dot. Underscores are allowed
// (illegal in DNS, ordinary in a Docker/compose service name, and unable to change a URL's
// structure). What the allowlist keeps OUT is what can: `@ : / \ ? # [ ]` and space.
const PROXY_HOST_RE = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*\.?$/;
/** A bracketed IPv6 literal, as URL.hostname reports it. */
const PROXY_IPV6_RE = /^\[[0-9a-f:]+\]$/;
/** An optional path prefix: `/segment` repeated, each segment from a positive character allowlist. */
const PROXY_PATH_RE = /^(?:\/[a-z0-9._~-]+)*$/i;

/**
 * Validate + canonicalise one upstream candidate. Returns null — never a "cleaned up" variant — when
 * the candidate is not exactly `scheme://host[:port][/path]` with scheme from the allowlist and no
 * credentials, query or fragment.
 */
function sanitizeProxyTarget(candidate) {
    if (typeof candidate !== 'string') return null;
    const raw = candidate.trim();
    if (!raw) return null;

    let u;
    try {
        u = new URL(raw);
    } catch {
        return null; // not a URL at all
    }
    // Pick the matching LITERAL out of the allowlist, so what ends up in the request is this file's
    // constant rather than the configured text.
    const protocol = PROXY_PROTOCOLS.find((p) => p === u.protocol);
    if (!protocol) return null;
    // Credentials are the classic "the host is not what you think it is" trick, and an upstream
    // origin has no business carrying a query or a fragment.
    if (u.username || u.password || u.search || u.hash) return null;

    const host = u.hostname.toLowerCase();
    if (!PROXY_HOST_RE.test(host) && !PROXY_IPV6_RE.test(host)) return null;

    // URL.port is '' or digits only; still bound it to the real port range.
    const port = u.port;
    if (port) {
        if (!/^[0-9]{1,5}$/.test(port)) return null;
        const n = Number(port);
        if (n < 1 || n > 65535) return null;
    }

    const path = u.pathname.replace(/\/+$/, '');
    if (!PROXY_PATH_RE.test(path)) return null;

    return `${protocol}//${host}${port ? `:${port}` : ''}${path}`;
}

/**
 * Resolve the upstream for `/api` and `/uploads` from the two things that can decide it. Pure: the
 * callers read the environment and the config file and hand the values in, so the precedence is
 * testable without a filesystem.
 *
 * @param {{ env?: string|null|undefined, gatewayPort?: unknown }} sources
 * @returns {{ target: string, source: 'env'|'config'|'default' }}
 * @throws {Error} when `env` is set to something that is not a usable origin.
 */
function resolveBackendProxyTarget(sources) {
    const { env, gatewayPort } = sources || {};

    // 1. The per-replica override. An empty/whitespace value is "unset" (the ordinary shell way of
    //    clearing a variable), not a malformed one.
    if (env !== undefined && env !== null && String(env).trim() !== '') {
        const target = sanitizeProxyTarget(String(env));
        if (!target) {
            throw new Error(
                `[WordJS] ${BACKEND_URL_ENV} is not a usable backend origin: ${JSON.stringify(String(env))}. ` +
                    'Expected an absolute http(s) origin with no credentials, query or fragment — ' +
                    'for example http://10.0.1.23:4000 or https://backend-a.internal.',
            );
        }
        return { target, source: 'env' };
    }

    // 2. The gateway on this host, as configured. A junk port is dropped rather than thrown on: it
    //    comes from the same config file the rest of the deploy already reads, and the historical
    //    behaviour for it is to fall through to the default.
    if (gatewayPort !== undefined && gatewayPort !== null && String(gatewayPort).trim() !== '') {
        const target = sanitizeProxyTarget(`https://localhost:${String(gatewayPort).trim()}`);
        if (target) return { target, source: 'config' };
    }

    // 3. Compiled-in default.
    return { target: DEFAULT_PROXY_TARGET, source: 'default' };
}

/** The override as this process sees it, or null when the process has no opinion. */
function backendUrlFromEnv(env) {
    const raw = (env || process.env)[BACKEND_URL_ENV];
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    return resolveBackendProxyTarget({ env: raw }).target;
}

/**
 * The upstream request path for an inbound `/api/...` or `/uploads/...` URL. The target may carry a
 * path prefix (a backend published under `/wordjs`, say), so the two are joined here rather than at
 * each call site — and the inbound URL is used verbatim, query string included.
 */
function upstreamPath(target, requestUrl) {
    const base = new URL(target);
    const prefix = base.pathname.replace(/\/+$/, '');
    return `${prefix}${requestUrl}`;
}

/**
 * Proxy one request to the resolved backend, mirroring what Next's own rewrite proxy does so that
 * turning the override on cannot change how the backend sees a request: the upstream `Host` is the
 * target's (httpxy `changeOrigin: true`) and the caller's `Host` is preserved in `x-forwarded-host`
 * (`next/dist/server/lib/router-utils/proxy-request.js`). The backend's Origin/Referer CSRF check and
 * its host guards therefore see exactly what they saw through the rewrite.
 *
 * Streaming is the point, not a detail: `/api/v1/collab/:id/stream` is a live SSE channel, so the
 * response is piped straight through with no buffering, no aggregation and NO proxy timeout (Next's
 * proxy imposes 30s, which its 15s keepalive stays under — here there is nothing to trip over at
 * all), and Nagle is disabled so a 40-byte event leaves immediately instead of waiting for company.
 */
function proxyToBackend(req, res, target, options) {
    const base = new URL(target);
    const isHttps = base.protocol === 'https:';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const transport = require(isHttps ? 'https' : 'http');

    const headers = Object.assign({}, req.headers, {
        host: base.host,
        'x-forwarded-host': req.headers.host || '',
    });
    // Hop-by-hop headers belong to THIS connection and must not be relayed to the next one.
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['proxy-authorization'];

    const upstream = transport.request(
        {
            protocol: base.protocol,
            hostname: base.hostname,
            port: base.port || (isHttps ? 443 : 80),
            method: req.method,
            path: upstreamPath(target, req.url),
            headers,
            // The gateway/backend inside a cluster serves a cluster-CA cert; the frontend process is
            // started with NODE_EXTRA_CA_CERTS pointing at that CA (scripts/start-frontend.js), so
            // normal verification applies and is never disabled here.
            ...(options && options.agent ? { agent: options.agent } : {}),
        },
        (upstreamRes) => {
            const outHeaders = Object.assign({}, upstreamRes.headers);
            // Let Node frame the response for THIS connection.
            delete outHeaders.connection;
            delete outHeaders['keep-alive'];
            delete outHeaders['transfer-encoding'];
            res.writeHead(upstreamRes.statusCode || 502, outHeaders);
            if (typeof res.flushHeaders === 'function') res.flushHeaders();
            if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);
            upstreamRes.pipe(res);
            res.on('close', () => upstreamRes.destroy());
        },
    );

    upstream.on('error', (err) => {
        if (res.headersSent) {
            res.destroy();
            return;
        }
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'backend_unreachable', message: `Backend proxy failed: ${err.message}` }));
    });
    // A client that walks away must not leave the upstream request (and its SSE room membership)
    // hanging: Node does not fire `aborted` on an already-closed request, so `close` is the signal.
    res.on('close', () => {
        if (!upstream.destroyed) upstream.destroy();
    });

    req.pipe(upstream);
}

/**
 * THE URL PREFIXES THE BACKEND OWNS.
 *
 * Not a guess and not a list that grew by accident: the gateway already keeps the authoritative set
 * of prefixes a backend is allowed to claim (`gateway/src/index.js` — `/api`, `/uploads`, `/themes`,
 * `/plugins`, `/public`, `/.well-known`, plus the operational probes), and every one of them is
 * mounted by `backend/src/index.ts`. When a frontend is reached THROUGH the gateway none of this
 * matters. When it is the front door — which is the whole point of `WORDJS_BACKEND_URL` — forwarding
 * a subset means the parts it left out simply 404 against the Next app.
 *
 * That is not theoretical: with only `/api` and `/uploads` forwarded, `/themes/<theme>/style.css`
 * and `/public/css/wordjs-ui.css` came back as the Next 404 page, so the browser refused them for
 * their MIME type and the editor canvas rendered unstyled — visible, but with nothing pointing at
 * the cause.
 *
 * The operational probes (`/healthz`, `/readyz`, `/metrics`) are deliberately NOT here: they answer
 * "is this node healthy", and a frontend replica answering them on a backend's behalf would report
 * the wrong node's health to whatever is watching.
 */
const PROXIED_PREFIXES = ['/api/', '/uploads/', '/themes/', '/plugins/', '/public/', '/.well-known/'];

/**
 * THE `/api` PATHS THAT ARE **NEXT'S**, NOT THE BACKEND'S — the exception list, kept in the SAME
 * module as the prefixes above because the two are one decision and splitting them is what broke.
 *
 * `/api/` is the backend's namespace with exactly one hole in it: the App Router also serves route
 * handlers under `frontend/src/app/api/**`, and a prefix match sends those to the backend, which does
 * not mount them → 404.
 *
 * That is not hypothetical. `monolith.js` knew about `/api/revalidate` and exempted it inline; THIS
 * module — the one that governs the runtime proxy in the horizontally-scaled deployment
 * `WORDJS_BACKEND_URL` exists for — did not. So on every replica, `core/frontend-purge.ts` POSTed the
 * on-demand cache purge at `/api/revalidate`, the frontend's own server forwarded it to the backend,
 * and the backend 404'd it: `revalidateTag`/`revalidatePath` never ran and every publish stayed
 * invisible until the ISR window expired. (The BUILD-time rewrite never had this bug — Next resolves
 * a returned array as `afterFiles`, so the real route handler wins — which is precisely why the
 * runtime proxy, which runs BEFORE Next, had to be taught the same thing.)
 *
 * DERIVED FROM THE REAL ROUTE MAP, not from memory: the two entries below are the `route.ts` files
 * under `frontend/src/app/api/**`, and `src/lib/__tests__/backendProxyTarget.test.ts` walks that tree
 * and fails when a route exists that is not classified here. A new Next API route must therefore be
 * placed in one of these two buckets on purpose.
 *
 *  - `/api/revalidate` → NEXT. Only Next can invalidate its own caches; the backend has no such route.
 *  - `/api/internal/gateway-update` → the BACKEND's, and now unambiguously so. It used to exist
 *    TWICE: `backend/src/index.ts` mounts a real, shared-secret-gated `/api/internal` router (covered
 *    by authz-idor.test.ts) AND `frontend/src/app/api/internal/gateway-update/route.ts` served the same
 *    path from Next. Every dispatcher sends the path to the backend, so the Next handler was
 *    unreachable code — nothing in the repo, the gateway included, ever POSTed at it — that wrote
 *    `gatewayPort` into wordjs-config.json without validating its type. It has been DELETED (audit
 *    #28 leftover) rather than exempted: exempting it would have taken a live endpoint away from the
 *    backend, and renaming it would have kept a second, weaker copy of a control-plane write.
 */
const NEXT_OWNED_API_PATHS = ['/api/revalidate'];
/**
 * Paths under `/api/` that a Next route handler must NOT claim, because a real backend mount already
 * answers them. A tombstone, not a to-do: the Next twin at `/api/internal/gateway-update` is gone, and
 * this entry is what keeps the three dispatchers agreeing that the path is the backend's — and what
 * makes anyone who re-creates a route handler there meet the collision (gateway/test/
 * dispatcher-parity.test.js drives this list) instead of shipping dead code a second time.
 */
const CONTESTED_API_PATHS = ['/api/internal/gateway-update'];

/**
 * True when the App Router owns this path, so no dispatcher may forward it to the backend. Segment
 * boundary, like isProxiedPath: `/api/revalidateXYZ` is not `/api/revalidate`.
 */
function isNextOwnedApiPath(pathname) {
    const p = String(pathname || '');
    return NEXT_OWNED_API_PATHS.some((route) => p === route || p.startsWith(route + '/'));
}

/**
 * True when this request is one the backend owns. Matched at a SEGMENT boundary, never as a string
 * prefix: a page whose slug happens to start with `uploads` belongs to the frontend. The bare form
 * (`/api`, `/themes`) counts as the backend's too.
 *
 * The Next-owned exception is consulted FIRST: it is a hole punched in `/api/`, so a later prefix
 * match must not be able to close it again.
 */
function isProxiedPath(pathname) {
    const p = String(pathname || '');
    if (isNextOwnedApiPath(p)) return false;
    return PROXIED_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix));
}

/** The same set as Next rewrite sources (`/api/:path*`), so both paths forward the same things. */
function rewriteSources() {
    return PROXIED_PREFIXES.map((prefix) => `${prefix.slice(0, -1)}/:path*`);
}

module.exports = {
    BACKEND_URL_ENV,
    DEFAULT_PROXY_TARGET,
    sanitizeProxyTarget,
    resolveBackendProxyTarget,
    backendUrlFromEnv,
    upstreamPath,
    PROXIED_PREFIXES,
    NEXT_OWNED_API_PATHS,
    CONTESTED_API_PATHS,
    isNextOwnedApiPath,
    isProxiedPath,
    rewriteSources,
    proxyToBackend,
};
