'use strict';
/**
 * WordJS — the EDGE half of the host policy: what the public listener does with the address a request
 * was sent to, before anything is proxied, rendered or upgraded.
 *
 * Two public listeners exist, one per deployment shape: the gateway worker (split and separate mode)
 * and the monolith's dispatcher. Both call THIS module, so a 421 page, a www→apex redirect or a refused
 * WebSocket cannot look different, or be decided differently, depending on how WordJS was deployed. The
 * decision itself (parse, which class of address, refuse or accept) is host-policy.js — the module the
 * backend's own gate runs, byte for byte — so the edge and the backend cannot disagree about a Host.
 *
 * WHAT THE EDGE ADDS OVER THE BACKEND GATE. The backend gate (phase 1) covers backend API paths only:
 * Next pages, static trees and WebSocket upgrades were never guarded, so a foreign domain pointed at
 * this server rendered the whole public site. At the edge (phase 2):
 *   - an unknown address gets a static 421 page (no script, no form, one link to the main address) or,
 *     on an API path, the same JSON 421 the backend gate answers;
 *   - a `mode: "redirect"` alias gets a 308 to the main address for GET/HEAD outside the API;
 *   - a repeated or malformed Host gets 400, and a WebSocket upgrade to an unknown address is refused;
 *   - the port-80 ACME listener redirects to an address the site answers, never to a raw Host.
 * Probes and ACME challenges stay exempt: they are addressed by pod/container IP or by a name whose
 * certificate does not exist yet.
 *
 * WHAT IT DOES TO FORWARDED HEADERS (gateway, phase 1). The gateway tells the upstream how the client
 * connected (X-Forwarded-Host/-Proto), and the backend trusts those headers from the gateway. So the
 * client's own values must never survive the hop: they are pinned here, for HTTP and for upgrades.
 *
 * WHERE THE GATEWAY'S POLICY COMES FROM. The gateway has no wordjs-config.json of its own in separate
 * mode, so the backend PUSHES the inputs of buildPolicy to the internal mTLS listener (POST /host-policy,
 * CN=backend only). The primary stores them in one file; every worker re-reads that file when its
 * modification time changes, so a new address takes effect without restarting a worker. Until the
 * first push the edge enforces nothing (`enforce: false`): exactly the behaviour before it existed.
 *
 * Plain CommonJS with Node built-ins and ./host-policy only: monolith.js requires this file, and the
 * gateway's test job installs nothing but gateway/node_modules.
 */
const fs = require('fs');
const path = require('path');
const hp = require('./host-policy');

// ─── Forwarded headers (gateway) ────────────────────────────────────────────────────────────────────

/** The scheme this listener's socket speaks — what the client actually used to reach the edge. */
function listenerScheme(req) {
    const sock = req && (req.socket || req.connection);
    return sock && sock.encrypted ? 'https' : 'http';
}

/**
 * Before proxy.web: state how the client connected, never what the client CLAIMED about it.
 *
 * X-Forwarded-Host becomes the Host this listener received (http-proxy's xfwd would otherwise keep a
 * client-supplied value). X-Forwarded-Proto and -Port are DELETED so http-proxy's xfwd writes exactly
 * the listener's scheme and port: it APPENDS to an existing value, so a client sending
 * `X-Forwarded-Proto: https` over plain http used to reach the backend as `https,http` — and the first
 * element is the one a trusted hop is believed on, which is how a cleartext request posed as TLS (the
 * Secure-cookie and sign-in rules read it).
 */
function pinForwardedHeaders(req) {
    req.headers['x-forwarded-host'] = req.headers.host || '';
    delete req.headers['x-forwarded-server'];
    delete req.headers['x-forwarded-proto'];
    delete req.headers['x-forwarded-port'];
}

/**
 * Before proxy.ws: the same pins for an upgrade. http-proxy's WebSocket pass never touches
 * X-Forwarded-Host at all, so without this a client's forged value reached the upstream verbatim. Its
 * proto is `ws`/`wss`, which no reader of X-Forwarded-Proto understands, so the listener's http scheme
 * is pinned first and http-proxy appends after it (`https,wss`): the first element — the one a trusted
 * hop is read by — is the real scheme.
 */
function pinUpgradeHeaders(req) {
    req.headers['x-forwarded-host'] = req.headers.host || '';
    delete req.headers['x-forwarded-server'];
    delete req.headers['x-forwarded-port'];
    req.headers['x-forwarded-proto'] = listenerScheme(req);
}

// ─── The edge decision ──────────────────────────────────────────────────────────────────────────────

// Answered on every address, as before the edge existed: liveness/readiness/metrics are scraped by pod
// or container IP (and `ipLiterals` may be `none`), and an ACME HTTP-01 challenge is fetched for a name
// that may not be declared until its certificate exists. Everything else — pages, static trees,
// uploads — belongs to the site and is answered only on the site's addresses.
const EDGE_EXEMPT_PATHS = Object.freeze(['/.well-known/acme-challenge', '/health', '/healthz', '/readyz', '/metrics']);

// The headers only a forwarding proxy adds (REDTEAM R4), WITHOUT X-Forwarded-Host. See createHostEdge.
const FORWARDING_MARKERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'via'];

function requestPath(req) {
    return String((req && req.url) || '/').split('?')[0];
}

function matchesPrefix(p, prefixes) {
    return prefixes.some((prefix) => p === prefix || p.startsWith(prefix + '/'));
}

function isApiPath(p) {
    return p === '/api' || p.startsWith('/api/');
}

/** Node keeps the FIRST of two Host headers and drops the second; rawHeaders still has both. */
function countHostHeaders(req) {
    const raw = req.rawHeaders;
    if (!Array.isArray(raw)) return req.headers && req.headers.host !== undefined ? 1 : 0;
    let count = 0;
    for (let i = 0; i < raw.length; i += 2) if (String(raw[i]).toLowerCase() === 'host') count += 1;
    return count;
}

function hasForwardingMarkers(req) {
    const headers = (req && req.headers) || {};
    return FORWARDING_MARKERS.some((name) => headers[name] !== undefined);
}

/**
 * A redirect target that cannot leave `origin`. The path is the request's own, with leading slashes
 * and backslashes collapsed to one `/` (so `//evil.example/x` cannot become a protocol-relative URL),
 * an absolute-form request target (`GET http://x/ HTTP/1.1`) is replaced by `/`, and the result is
 * re-parsed and REFUSED unless its origin is still `origin` — then the bare origin is used instead.
 * Returns WHATWG's serialisation, which percent-encodes anything a Location header cannot carry.
 */
function safeLocation(origin, rawUrl) {
    const expected = new URL(origin).origin;
    let target = typeof rawUrl === 'string' && rawUrl.startsWith('/') ? rawUrl : '/';
    target = target.replace(/^[/\\]+/, '/');
    let u;
    try {
        u = new URL(expected + target);
    } catch {
        return expected + '/';
    }
    return u.origin === expected ? u.href : expected + '/';
}

/**
 * The edge for one public listener. Options:
 *
 *   getPolicy()      the HostPolicy to enforce, or null for "not enforcing" (the gateway before its
 *                    first push). A policy without a valid canonical is not enforced either — the
 *                    backend gate's step 6, where the operator is told; refusing every address of a
 *                    site whose main address is broken would be a lockout, not a safeguard.
 *   isInstalled()    optional; false = not enforcing (the install wizard is reached by any address).
 *   forwardedHostIsMarker
 *                    whether an X-Forwarded-Host that differs from Host marks a forwarding proxy for
 *                    R4. True (the default, host-policy's own rule) for the monolith: nothing
 *                    legitimate sends it one. FALSE for the gateway: a frontend node's SSR addresses
 *                    the gateway by IP (gatewayUrl / internalApiUrl) and relays the public host in
 *                    X-Forwarded-Host, which the gateway then discards (pinForwardedHeaders) — counting
 *                    it would refuse the site's own server-side rendering.
 *   logger, refused  where refusals are logged (throttled) and counted; refused defaults to
 *                    host-policy's per-process tracker. The monolith passes the BACKEND's tracker so
 *                    Settings → Site address lists page refusals too.
 *   now()            clock for alias expiry.
 *
 * Returns { decide(req), handle(req, res), handleUpgrade(req, socket) }. `handle` and `handleUpgrade`
 * return true when they answered the request (the caller must stop) and false to let it through.
 */
function createHostEdge(opts) {
    const o = opts || {};
    if (typeof o.getPolicy !== 'function') throw new TypeError('createHostEdge: getPolicy() is required');
    const logger = o.logger || console;
    const refused = o.refused || hp.refusedHosts;
    const now = typeof o.now === 'function' ? o.now : Date.now;
    const exempt = o.exemptPaths || EDGE_EXEMPT_PATHS;
    const forwardedHostIsMarker = o.forwardedHostIsMarker !== false;
    let policyErrorReported = false;

    function enforcingPolicy() {
        if (typeof o.isInstalled === 'function' && !o.isInstalled()) return null;
        let pol = null;
        try {
            pol = o.getPolicy();
        } catch (e) {
            // The backend gate still guards the API; the edge must not take every page down with it.
            if (!policyErrorReported) {
                policyErrorReported = true;
                logger.error(`[host-edge] the host policy could not be read (${e && e.message}); the edge address check is off until it can.`);
            }
            return null;
        }
        policyErrorReported = false;
        return pol && pol.canonical ? pol : null;
    }

    function isProxied(req, pol) {
        if (hp.trustedHop(req, pol) !== null) return false;
        return forwardedHostIsMarker ? hp.hasProxyMarkers(req) : hasForwardingMarkers(req);
    }

    /**
     * { action: 'pass', reason, cls? } | { action: 'invalid' } | { action: 'redirect', location }
     * | { action: 'refuse', hostname, reason, hint, canonicalOrigin }
     *
     * The edge judges `Host`: the very value it forwards as X-Forwarded-Host. Judging anything else
     * (a relayed X-Forwarded-Host) would check one value and send another upstream.
     */
    function decide(req) {
        const p = requestPath(req);
        if (matchesPrefix(p, exempt)) return { action: 'pass', reason: 'exempt' };
        const pol = enforcingPolicy();
        if (!pol) return { action: 'pass', reason: 'not-enforcing' };
        if (countHostHeaders(req) > 1) return { action: 'invalid' };
        const raw = (req.headers || {}).host;
        // HTTP/1.0 without Host: nothing to judge. The backend's CSRF and CORS already fail closed on it.
        if (raw === undefined || raw === '') return { action: 'pass', reason: 'no-host' };
        const parsed = hp.parseHost(raw);
        if (!parsed) return { action: 'invalid' };

        const verdict = hp.classify(parsed, pol, { proxied: isProxied(req, pol), now: now() });
        if (verdict.cls === 'unknown') {
            const hint = hp.refusalHint(parsed, pol, verdict.reason);
            if (refused.record(parsed.hostname, hint)) {
                // The hostname passed the parser grammar ([a-z0-9._-], brackets, colons): safe to log.
                logger.warn(`[host-edge] 421 for ${hp.serialize(parsed)} (${verdict.reason})` + (hint ? ': ' + hp.REFUSAL_HINTS[hint] : '; add it in Settings > Site address if it should work.'));
            }
            return { action: 'refuse', hostname: parsed.hostname, reason: verdict.reason, hint, canonicalOrigin: pol.canonical.origin };
        }
        if (verdict.cls === 'alias' && verdict.entry && verdict.entry.mode === 'redirect'
            && (req.method === 'GET' || req.method === 'HEAD') && !isApiPath(p)) {
            return { action: 'redirect', location: safeLocation(pol.canonical.origin, req.url) };
        }
        return { action: 'pass', reason: 'accepted', cls: verdict.cls };
    }

    return {
        decide,
        handle(req, res) {
            const v = decide(req);
            if (v.action === 'pass') return false;
            if (v.action === 'invalid') sendEdgeInvalid(req, res);
            else if (v.action === 'refuse') sendEdgeRefusal(req, res, v.canonicalOrigin);
            else sendRedirect(res, v.location);
            return true;
        },
        /** A WebSocket cannot follow a redirect, so a redirect alias is served on upgrades. */
        handleUpgrade(req, socket) {
            const v = decide(req);
            if (v.action !== 'invalid' && v.action !== 'refuse') return false;
            rejectUpgrade(socket, v.action === 'refuse' ? 421 : 400);
            return true;
        },
    };
}

// ─── Responses ──────────────────────────────────────────────────────────────────────────────────────

const REFUSAL_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * The 421 page. Static and inert on purpose: no script (nothing to inject into), no form (nothing to
 * phish with — the old /migration page asked for a password on any host), and exactly one link, to the
 * main address. The requested host is not echoed back.
 */
function renderRefusalPage(canonicalOrigin) {
    const origin = escapeHtml(canonicalOrigin);
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
        + '<title>Address not configured</title><style>'
        + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
        + 'font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f7f7;color:#1d2327}'
        + 'main{max-width:34rem;padding:2rem 1rem}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0 0 .75rem}'
        + 'a{color:#2271b1}small{color:#50575e}'
        + '@media (prefers-color-scheme:dark){body{background:#1d2327;color:#f0f0f1}a{color:#72aee6}small{color:#a7aaad}}'
        + '</style></head><body><main>'
        + '<h1>This address is not configured for this site.</h1>'
        + `<p>The site is at <a href="${origin}/">${origin}</a>.</p>`
        + '<p><small>If you administer this site and this address should work, add it in Settings &rarr; Site address, '
        + 'or on the server with <code>npm run site -- add &lt;url&gt;</code>.</small></p>'
        + '</main></body></html>';
}

function writeBody(res, status, headers, body) {
    res.statusCode = status;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
}

/** 421: the JSON the backend gate answers on API paths (the client's api.ts reads it), the page elsewhere. */
function sendEdgeRefusal(req, res, canonicalOrigin) {
    if (isApiPath(requestPath(req))) return hp.sendHostNotAllowed(res);
    writeBody(res, 421, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': REFUSAL_PAGE_CSP,
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
    }, renderRefusalPage(canonicalOrigin));
}

function sendEdgeInvalid(req, res) {
    if (isApiPath(requestPath(req))) return hp.sendInvalidHost(res);
    writeBody(res, 400, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    }, 'Bad Request: the Host header is malformed or repeated.\n');
}

/**
 * 308 keeps the method and body semantics and is what search engines read as "this name moved". The
 * cache lifetime is short on purpose: a permanent redirect without one is cached by browsers
 * indefinitely, and an operator who turns the alias back into a served address must not have to wait
 * for every visitor's cache to forget it.
 */
function sendRedirect(res, location) {
    writeBody(res, 308, {
        Location: location,
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'max-age=3600',
    }, `Permanent Redirect: ${location}\n`);
}

/** Answer an upgrade on the raw socket (there is no ServerResponse) and close it. */
function rejectUpgrade(socket, status) {
    const body = status === 421
        ? JSON.stringify({ code: 'rest_host_not_allowed', error: 'host_not_allowed', message: 'This address is not configured for this site.', data: { status: 421 } })
        : JSON.stringify({ code: 'rest_invalid_host', error: 'invalid_host', message: 'The Host header is malformed or repeated.', data: { status: 400 } });
    const reason = status === 421 ? 'Misdirected Request' : 'Bad Request';
    try {
        socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\n`
            + `Cache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } catch {
        socket.destroy();
    }
}

// ─── ACME HTTP-01 listener (port 80) ────────────────────────────────────────────────────────────────

/**
 * Where the plain-HTTP listener sends a browser: `https://<host>[:port]<path>`. The host is the one the
 * request named when the site answers it, the main address when it does not (or when it is a redirect
 * alias — one hop instead of two), and the request's own host only while nothing is enforced. The old
 * listener used `Host.split(':')[0]`, which echoed any name into the Location and cut `[::1]` to `[`.
 * Returns null when there is no usable host at all (the caller answers 400).
 *
 * opts: { getPolicy, isInstalled?, port, now?, forwardedHostIsMarker? } — the same meaning as for
 * createHostEdge.
 */
function acmeRedirectLocation(req, opts) {
    const o = opts || {};
    const suffix = Number(o.port) === 443 || !o.port ? '' : ':' + Number(o.port);
    let pol = null;
    if (typeof o.isInstalled !== 'function' || o.isInstalled()) {
        try {
            pol = typeof o.getPolicy === 'function' ? o.getPolicy() : null;
        } catch {
            pol = null;
        }
    }
    if (pol && !pol.canonical) pol = null;
    const parsed = countHostHeaders(req) > 1 ? null : hp.parseHost((req.headers || {}).host);

    let hostname = null;
    if (pol) {
        hostname = pol.canonical.hostname;
        if (parsed) {
            const proxied = hp.trustedHop(req, pol) === null
                && (o.forwardedHostIsMarker === false ? hasForwardingMarkers(req) : hp.hasProxyMarkers(req));
            const now = typeof o.now === 'function' ? o.now() : Date.now();
            const v = hp.classify(parsed, pol, { proxied, now });
            const redirectAlias = v.cls === 'alias' && v.entry && v.entry.mode === 'redirect';
            if (v.cls !== 'unknown' && !redirectAlias) hostname = parsed.hostname;
        }
    } else if (parsed) {
        hostname = parsed.hostname;
    }
    if (!hostname) return null;
    return safeLocation(`https://${hostname}${suffix}`, req.url);
}

// ─── The gateway's pushed policy ────────────────────────────────────────────────────────────────────

const PUSH_ENV_KEYS = Object.freeze(['WORDJS_ALLOWED_HOSTS', 'WORDJS_IP_HOSTS', 'WORDJS_DEV_ORIGINS', 'WORDJS_TRUST_PROXY']);
const MAX_ALIASES = 256;
const MAX_URL = 2048;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function boundedString(v, max) {
    return typeof v === 'string' && v.length <= max;
}

/** One siteAliases entry: a bare URL string, or an object whose known fields have the right types. */
function sanitizeAlias(item, i) {
    if (typeof item === 'string') return boundedString(item, MAX_URL) ? { value: item } : { error: `config.siteAliases[${i}] is too long` };
    if (!isPlainObject(item)) return { error: `config.siteAliases[${i}] must be a URL or an object` };
    if (!boundedString(item.url, MAX_URL)) return { error: `config.siteAliases[${i}].url must be a string` };
    const out = { url: item.url };
    const fields = [['mode', 'string', 16], ['signIn', 'boolean'], ['expiresAt', 'string', 64], ['label', 'string', 100], ['source', 'string', 20]];
    for (const [name, type, max] of fields) {
        const v = item[name];
        if (v === undefined || (v === null && name === 'expiresAt')) continue;
        if (typeof v !== type || (type === 'string' && v.length > max)) return { error: `config.siteAliases[${i}].${name} has the wrong type or length` };
        out[name] = v;
    }
    return { value: out };
}

function sanitizeTrustProxy(v) {
    if (v === undefined || v === null || typeof v === 'boolean') return { value: v };
    if (typeof v === 'number') return Number.isFinite(v) ? { value: v } : { error: 'config.trustProxy must be finite' };
    if (typeof v === 'string') return v.length <= 1024 ? { value: v } : { error: 'config.trustProxy is too long' };
    if (Array.isArray(v) && v.length <= 64 && v.every((x) => boundedString(x, 64))) return { value: v.slice() };
    return { error: 'config.trustProxy must be a string, a list of strings, a boolean or a number' };
}

/**
 * Validate a POST /host-policy body (and the file it is stored in): the inputs of buildPolicy, with
 * nothing else. Returns { ok: true, value: { enforce, config, env, nodeEnv } } or { ok: false, error }.
 *
 * The peer is the cluster's own backend (mTLS CN=backend), but what it sends decides which addresses
 * every page of the site answers on, so the shape is checked like any wire input: an allowlist of keys
 * (unknown ones are dropped), exact types, bounded lengths and counts. The VALUES are left to
 * buildPolicy, which already refuses bad addresses entry by entry and reports them as warnings.
 */
function sanitizePolicyPush(body) {
    if (!isPlainObject(body)) return { ok: false, error: 'the body must be a JSON object' };
    const enforce = body.enforce === undefined ? true : body.enforce;
    if (typeof enforce !== 'boolean') return { ok: false, error: 'enforce must be a boolean' };

    const config = {};
    if (body.config !== undefined && body.config !== null) {
        if (!isPlainObject(body.config)) return { ok: false, error: 'config must be an object' };
        const c = body.config;
        if (c.siteUrl !== undefined && c.siteUrl !== null) {
            if (!boundedString(c.siteUrl, MAX_URL)) return { ok: false, error: 'config.siteUrl must be a string' };
            config.siteUrl = c.siteUrl;
        }
        if (c.siteAliases !== undefined && c.siteAliases !== null) {
            if (!Array.isArray(c.siteAliases) || c.siteAliases.length > MAX_ALIASES) return { ok: false, error: `config.siteAliases must be a list of at most ${MAX_ALIASES}` };
            const aliases = [];
            for (let i = 0; i < c.siteAliases.length; i += 1) {
                const r = sanitizeAlias(c.siteAliases[i], i);
                if (r.error) return { ok: false, error: r.error };
                aliases.push(r.value);
            }
            config.siteAliases = aliases;
        }
        if (c.hostPolicy !== undefined && c.hostPolicy !== null) {
            if (!isPlainObject(c.hostPolicy)) return { ok: false, error: 'config.hostPolicy must be an object' };
            const hostPolicy = {};
            if (c.hostPolicy.ipLiterals !== undefined) {
                if (!boundedString(c.hostPolicy.ipLiterals, 16)) return { ok: false, error: 'config.hostPolicy.ipLiterals must be a string' };
                hostPolicy.ipLiterals = c.hostPolicy.ipLiterals;
            }
            if (c.hostPolicy.ipSignIn !== undefined) {
                if (typeof c.hostPolicy.ipSignIn !== 'boolean') return { ok: false, error: 'config.hostPolicy.ipSignIn must be a boolean' };
                hostPolicy.ipSignIn = c.hostPolicy.ipSignIn;
            }
            config.hostPolicy = hostPolicy;
        }
        const trust = sanitizeTrustProxy(c.trustProxy);
        if (trust.error) return { ok: false, error: trust.error };
        if (trust.value !== undefined && trust.value !== null) config.trustProxy = trust.value;
    } else if (enforce) {
        return { ok: false, error: 'config is required when enforce is true' };
    }

    const env = {};
    if (body.env !== undefined && body.env !== null) {
        if (!isPlainObject(body.env)) return { ok: false, error: 'env must be an object' };
        for (const name of PUSH_ENV_KEYS) {
            const v = body.env[name];
            if (v === undefined || v === null) continue;
            if (!boundedString(v, 4096)) return { ok: false, error: `env.${name} must be a string` };
            env[name] = v;
        }
    }

    let nodeEnv = null;
    if (body.nodeEnv !== undefined && body.nodeEnv !== null) {
        if (!boundedString(body.nodeEnv, 32)) return { ok: false, error: 'nodeEnv must be a string' };
        nodeEnv = body.nodeEnv;
    }
    return { ok: true, value: { enforce, config, env, nodeEnv } };
}

function policyFromPush(value, ownAddresses) {
    if (!value.enforce) return null;
    return hp.buildPolicy({ config: value.config, env: value.env, nodeEnv: value.nodeEnv || undefined, ownAddresses });
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Store a validated push atomically: write a sibling temp file, then rename it over the target, so a
 * worker never reads half a policy. Windows refuses the rename while another process has the target
 * open for a moment (a worker reading it, an antivirus scan, OneDrive); that is retried briefly before
 * falling back to a plain write, which a reader that catches it mid-write simply ignores (it keeps its
 * last good policy and re-reads on the next check).
 */
function writePolicyFile(file, value) {
    const doc = { format: 1, receivedAt: new Date().toISOString(), enforce: value.enforce, config: value.config, env: value.env, nodeEnv: value.nodeEnv };
    const text = JSON.stringify(doc, null, 2) + '\n';
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
        try {
            fs.renameSync(tmp, file);
            return;
        } catch (e) {
            if (!['EPERM', 'EBUSY', 'EACCES'].includes(e && e.code) || attempt >= 5) {
                try {
                    fs.writeFileSync(file, text, { mode: 0o600 });
                } finally {
                    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
                }
                return;
            }
            sleepSync(25 * (attempt + 1));
        }
    }
}

/**
 * A worker's view of the pushed policy. `get()` returns the HostPolicy to enforce, or null (nothing was
 * pushed yet, or the last push said `enforce: false`).
 *
 * At most once per `checkEveryMs` it stats the file; only when the modification time, size or inode
 * changed — or the file is younger than the file system's timestamp granularity could hide — is it
 * read again. A file that cannot be read or parsed keeps the LAST GOOD policy (REDTEAM R10: a policy
 * that silently dropped to "nothing enforced" would reopen every address while an operator is merely
 * mid-edit). A file that disappears means nothing is enforced, exactly like before the first push.
 */
function createPushedPolicySource(opts) {
    const o = opts || {};
    if (typeof o.file !== 'string') throw new TypeError('createPushedPolicySource: file is required');
    const checkEveryMs = typeof o.checkEveryMs === 'number' ? o.checkEveryMs : 1000;
    const now = typeof o.now === 'function' ? o.now : Date.now;
    const logger = o.logger || console;
    let policy = null;
    let signature = null;
    let text = null;
    let lastCheck = -Infinity;
    let badReported = false;

    function reportBad(why) {
        if (badReported) return;
        badReported = true;
        logger.error(`[host-edge] ${path.basename(o.file)} is unreadable (${why}); keeping the last good host policy.`);
    }

    function refresh() {
        let st;
        try {
            st = fs.statSync(o.file);
        } catch (e) {
            if (e && e.code === 'ENOENT') {
                policy = null;
                signature = null;
                text = null;
            }
            return;
        }
        const next = `${st.mtimeMs}:${st.size}:${st.ino}`;
        // Two pushes inside one timestamp tick with the same length (ipLiterals any → own) would share a
        // signature, so a file this young is compared by content instead.
        const young = Date.now() - st.mtimeMs < 2000;
        if (next === signature && !young) return;
        let raw;
        try {
            raw = fs.readFileSync(o.file, 'utf8');
        } catch (e) {
            return reportBad(e && e.code ? e.code : 'read failed');
        }
        if (raw === text) {
            signature = next;
            return;
        }
        let doc;
        try {
            doc = JSON.parse(raw);
        } catch {
            return reportBad('not JSON');
        }
        const checked = sanitizePolicyPush(doc);
        if (!checked.ok) return reportBad(checked.error);
        policy = policyFromPush(checked.value, o.ownAddresses);
        signature = next;
        text = raw;
        badReported = false;
    }

    return {
        get() {
            const t = now();
            if (t - lastCheck >= checkEveryMs) {
                lastCheck = t;
                refresh();
            }
            return policy;
        },
    };
}

/**
 * POST /host-policy on the gateway's INTERNAL mTLS listener: the backend states which addresses the
 * site answers. CN=backend only — the same identity that may already reconfigure the gateway
 * (/config-update) — and validated by sanitizePolicyPush before anything is stored. Workers pick the
 * new file up by its modification time; nothing is restarted, so no request in flight is dropped.
 *
 * Body: { enforce?: boolean = true, config: { siteUrl, siteAliases, hostPolicy, trustProxy },
 *         env?: { WORDJS_ALLOWED_HOSTS, WORDJS_IP_HOSTS, WORDJS_DEV_ORIGINS, WORDJS_TRUST_PROXY },
 *         nodeEnv?: string }
 * Answers { success, enforce, canonical, warnings } — `canonical` is null when the pushed siteUrl is
 * missing or invalid, in which case the edge answers every address (and the warnings say why).
 */
function mountHostPolicyPush(app, opts) {
    const o = opts || {};
    if (typeof o.requireIdentity !== 'function' || typeof o.file !== 'string') {
        throw new TypeError('mountHostPolicyPush: requireIdentity() and file are required');
    }
    const logger = o.logger || console;
    app.post('/host-policy', o.requireIdentity(['backend']), (req, res) => {
        const checked = sanitizePolicyPush(req.body);
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        const pol = policyFromPush(checked.value, o.ownAddresses);
        try {
            writePolicyFile(o.file, checked.value);
        } catch (e) {
            logger.error(`[Gateway] [Internal] could not store the host policy: ${e && e.message}`);
            return res.status(500).json({ error: 'could not store the host policy' });
        }
        const canonical = pol && pol.canonical ? pol.canonical.origin : null;
        if (pol) for (const warning of pol.warnings) logger.warn(`[Gateway] [Internal] host policy: ${warning}`);
        logger.info(checked.value.enforce
            ? `[Gateway] [Internal] host policy received: main address ${canonical || '(none — every address answered)'}, ${pol.aliases.size} other address(es), IP literals ${pol.ipLiterals}`
            : '[Gateway] [Internal] host policy received: not enforced at the edge');
        return res.json({ success: true, enforce: checked.value.enforce, canonical, warnings: pol ? pol.warnings.slice() : [] });
    });
}

module.exports = {
    // forwarded headers
    listenerScheme,
    pinForwardedHeaders,
    pinUpgradeHeaders,
    // the edge
    EDGE_EXEMPT_PATHS,
    createHostEdge,
    safeLocation,
    renderRefusalPage,
    REFUSAL_PAGE_CSP,
    acmeRedirectLocation,
    // the gateway's pushed policy
    PUSH_ENV_KEYS,
    sanitizePolicyPush,
    writePolicyFile,
    createPushedPolicySource,
    mountHostPolicyPush,
};
