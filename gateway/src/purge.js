'use strict';
/**
 * Cluster cache-purge fan-out (separate mode).
 *
 * On one host the backend purges the frontend's Next.js cache by POSTing straight at `frontendUrl`.
 * Across machines it cannot: the backend has no idea where the frontend nodes live (its `frontendUrl`
 * is the gateway's public origin, whose `/api` prefix routes back to the backend itself), and there may
 * be N frontend replicas behind the gateway rather than one. The gateway already holds that knowledge —
 * the service registry every node registers into over mTLS — so it, not the backend, resolves the
 * targets and delivers the purge.
 *
 * The backend asks over the EXISTING internal mTLS channel (`POST /purge`, identity `CN=backend`); this
 * module turns that request into one `/api/revalidate` call per registered frontend target.
 *
 * Security model (unchanged from backend/core/frontend-purge.ts):
 *  - A purge can only INVALIDATE caches (forcing a re-render). It can never inject content, so the blast
 *    radius of a leaked `revalidateSecret` is extra renders, not integrity loss.
 *  - Nothing here is reachable without a cluster-CA client certificate carrying the backend identity —
 *    the caller mounts these handlers on the internal mTLS listener behind requireIdentity(['backend']).
 *  - The payload is re-sanitised here (caps + shape) so a compromised backend cannot use the gateway to
 *    amplify an unbounded list into every frontend node.
 *  - Fan-out is best effort: an unreachable frontend just keeps serving TTL-fresh content, and the
 *    result set says so instead of failing the caller's write path.
 */

const http = require('http');
const https = require('https');
const { requireIdentity } = require('./identity');

// Mirror the frontend route's own limits (frontend/src/app/api/revalidate/route.ts) so the gateway never
// forwards a payload the receiver would silently truncate anyway.
const MAX_ENTRIES = 100;
const MAX_LEN = 200;
const PURGE_TIMEOUT_MS = 3000;

const cleanList = (v, pred) =>
    Array.isArray(v)
        ? [...new Set(v.filter((s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_LEN && pred(s)))].slice(0, MAX_ENTRIES)
        : [];

/** Normalise an untrusted `{ tags, paths }` body into the exact shape the frontend route accepts. */
function sanitizePurgePayload(body) {
    const b = body && typeof body === 'object' ? body : {};
    return {
        tags: cleanList(b.tags, () => true),
        paths: cleanList(b.paths, (s) => s.startsWith('/'))
    };
}

/**
 * Every distinct target URL currently registered by a FRONTEND node.
 *
 * The registry is keyed by route prefix and the same node owns several of them ('/', '/admin', '/_next',
 * …), so the same URL appears many times — dedupe, or a publish would hit each replica once per route.
 * Accepts the primary's live `Map` as well as the plain-object form persisted in gateway-registry.json.
 */
function collectFrontendTargets(registry) {
    const groups = registry instanceof Map ? [...registry.values()] : Object.values(registry || {});
    const urls = new Set();
    for (const group of groups) {
        if (!group || group.name !== 'frontend') continue;
        const targets = group.targets instanceof Set ? [...group.targets] : (group.targets || []);
        for (const url of targets) if (typeof url === 'string' && url) urls.add(url);
    }
    return [...urls];
}

/**
 * Deliver one purge to one frontend target. Resolves with the outcome instead of rejecting — the caller
 * reports partial delivery rather than treating one dead replica as a total failure.
 */
function postPurge(targetUrl, payload, { secret, agent, timeoutMs = PURGE_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        let url;
        try { url = new URL(String(targetUrl).replace(/\/+$/, '') + '/api/revalidate'); }
        catch { return resolve({ url: String(targetUrl), ok: false, error: 'invalid target url' }); }

        const isHttps = url.protocol === 'https:';
        const body = JSON.stringify(payload);
        const req = (isHttps ? https : http).request({
            method: 'POST',
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            agent: isHttps ? agent : undefined,
            timeout: timeoutMs,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'x-revalidate-secret': secret || ''
            }
        }, (res) => {
            res.resume(); // drain so the socket can be reused
            resolve({ url: targetUrl, ok: res.statusCode === 200, status: res.statusCode });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (e) => resolve({ url: targetUrl, ok: false, error: e.message }));
        req.write(body);
        req.end();
    });
}

/** Fan a purge out to every target concurrently. Never rejects. */
async function fanOutPurge({ targets = [], payload, secret, agent, timeoutMs = PURGE_TIMEOUT_MS } = {}) {
    const results = await Promise.all(targets.map((t) => postPurge(t, payload, { secret, agent, timeoutMs })));
    return {
        delivered: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results
    };
}

/**
 * `GET /revalidate-secret` — let a frontend node FETCH the purge secret it should already have.
 *
 * The secret rides enrollment: `/enroll` hands it to every joining node. That leaves one deployment
 * permanently broken and silent about it — a cluster enrolled BEFORE the secret existed. Its frontend
 * has full cluster identity (certificates, gateway wiring) but no `revalidateSecret`, so every purge
 * the gateway delivers is refused with 403 and the site quietly falls back to TTL freshness, for good.
 * The documented remedy was for a human to remember to re-enroll the node, which is the kind of thing
 * nobody remembers.
 *
 * So the node repairs itself over the mTLS channel it already holds. This is not a new trust decision:
 * the internal listener already treats `CN=backend` as sufficient authorization to REQUEST a purge, and
 * a `CN=frontend` certificate is what the gateway hands the secret to at enrollment anyway. A peer that
 * can present it is, by definition, a node the gateway would already have given the secret to — and the
 * worst a leaked purge secret buys is extra re-renders, never content injection.
 *
 * Deliberately GET and side-effect-free from the caller's point of view: the value is minted lazily and
 * persisted by `ensureSecret`, exactly as the fan-out path does.
 *
 * @param {import('express').Express} app the internal mTLS app
 * @param {{ensureSecret: () => string, logger: {info: Function, warn: Function, error: Function}}} deps
 */
function mountRevalidateSecret(app, { ensureSecret, logger }) {
    app.get('/revalidate-secret', requireIdentity(['frontend'], logger), (req, res) => {
        try {
            const secret = ensureSecret();
            if (!secret) {
                logger.warn('[Gateway] [Purge] a frontend node asked for the revalidate secret and there is none to give');
                return res.status(503).json({ error: 'revalidate secret unavailable' });
            }
            // Worth a line in the log: it means a node was missing it, which only happens on a cluster
            // enrolled before the secret existed (or after a config was restored without it).
            logger.info('[Gateway] [Purge] handed the revalidate secret to a CN=frontend node (self-repair)');
            res.json({ revalidateSecret: String(secret) });
        } catch (e) {
            logger.error(`[Gateway] [Purge] could not serve the revalidate secret: ${e.message}`);
            if (!res.headersSent) res.status(500).json({ error: 'revalidate secret unavailable' });
        }
    });
}

module.exports = {
    sanitizePurgePayload, collectFrontendTargets, postPurge, fanOutPurge,
    mountRevalidateSecret, MAX_ENTRIES, MAX_LEN
};
