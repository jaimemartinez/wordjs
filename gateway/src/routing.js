'use strict';
/**
 * WHICH REGISTERED NODE SERVES A REQUEST — the gateway's routing decision, in one place.
 *
 * It lives here, next to identity.js, for the same reason that one does: this is a security control,
 * and a security control that cannot be required from a test is a security control nobody checks.
 * gateway/test/proxy.integration.test.js and gateway/test/dispatcher-parity.test.js drive THESE
 * functions — not a re-implementation of them.
 *
 * THE BUG THIS EXISTS TO CLOSE (audit 2026-08-18 #22). Routing used to be a bare longest-prefix match
 * over whatever was in the registry:
 *
 *     for (const [prefix, group] of sortedByLengthDesc) if (url.startsWith(prefix)) …
 *
 * The frontend owns `/`, which is a prefix of everything. So the moment the health sweep evicted the
 * backend — three failed 30 s probes: a schema migration, an OOM, or one of the restarts the product
 * itself triggers — the primary ran `registry.delete('/api')` and every `/api/*` request fell through
 * to the frontend node: `POST /auth/login` with the password in the body, session cookies,
 * `Authorization` headers, uploads. The control plane has three separate guards against precisely that
 * outcome at `/register` (ROLE_ROUTES, certCoversHost, target ownership) and the code says so in as
 * many words — "a compromised/least-privileged `frontend` node registers `/api/v1/auth` → credential
 * capture". The guard protected the REGISTRATION; the ROUTING handed over what the registration
 * refused, with nobody having to compromise anything.
 *
 * Two properties fix it, and both are enforced below:
 *
 *  1. OWNER-AWARE. A path under a prefix that belongs to a ROLE may only be served by a group of that
 *     role. If no such group can serve it the answer is "no target" — which the caller turns into a
 *     502/503 — and NEVER a fall-through to a shorter prefix owned by somebody else.
 *  2. AN EMPTY GROUP STILL MATCHES. Health eviction empties a group instead of deleting the route
 *     (see index.js), so `/api` keeps covering the catch-all while the backend restarts, and the
 *     `final.length === 0` guard returns null instead of letting `/` inherit the namespace.
 */

/**
 * The routes each ROLE (peer certificate CN) is allowed to claim at /register — and, now, the only
 * role allowed to SERVE them. These sets mirror exactly what backend/src/index.ts and the frontend's
 * instrumentation.ts legitimately declare.
 *
 * null-prototype so a CN like '__proto__' / 'constructor' cannot make the lookup a truthy inherited
 * value.
 */
const ROLE_ROUTES = Object.assign(Object.create(null), {
    backend: new Set(['/api', '/uploads', '/themes', '/plugins', '/public', '/.well-known', '/healthz', '/readyz', '/metrics']),
    frontend: new Set(['/', '/admin', '/login', '/install', '/migration', '/portal', '/_next']),
});

/**
 * The `/api` paths the NEXT App Router owns (`frontend/src/app/api/**`), which therefore must NOT be
 * routed to the backend even though `/api` is the backend's prefix.
 *
 * DUPLICATED ON PURPOSE, and bound by a test rather than by a require: `gateway/` is its own npm
 * package with its own package.json and can be deployed on a box that carries no `frontend/` tree at
 * all (separate mode), so `require('../../frontend/backend-proxy-target.js')` would be a boot crash
 * waiting for that deployment. gateway/test/dispatcher-parity.test.js asserts this list is identical
 * to the one in frontend/backend-proxy-target.js and that all three dispatchers (gateway, frontend
 * replica proxy, monolith) return the same verdict for the same route table.
 *
 * Why the gateway needs it at all: when `frontendUrl` is the gateway's own public origin — the split
 * default — the backend's on-demand cache purge POSTs `/api/revalidate` straight at this listener. A
 * plain prefix match sends it to the backend, which does not mount that route, so every purge 404s and
 * content stays stale until the ISR window expires.
 */
const NEXT_OWNED_API_PATHS = ['/api/revalidate'];

/**
 * The path part of a request URL, without query or fragment.
 *
 * ABSOLUTE-FORM REQUEST LINES are normalised here (`POST http://host/api/v1/auth/login HTTP/1.1` is
 * legal HTTP and Node hands it to us verbatim). Left alone, such a URL matches no backend prefix and
 * falls to the `/` catch-all — the very confusion this module exists to prevent, arriving through the
 * request line instead of through the registry.
 */
function requestPath(url) {
    const raw = String(url || '/').split('#')[0].split('?')[0] || '/';
    if (raw.startsWith('/')) return raw;
    try { return new URL(raw).pathname || '/'; } catch { return '/'; }
}

/**
 * Segment-boundary prefix match. `/apiary` is NOT under `/api` — the old raw `startsWith` said it was,
 * which sent a page whose slug happens to start with a backend prefix to the backend. `/` matches
 * everything (it is the catch-all, by definition).
 */
function underPrefix(path, prefix) {
    if (prefix === '/') return true;
    return path === prefix || path.startsWith(prefix + '/');
}

/** Which ROLE is allowed to claim this registered prefix, or null when no role declares it. */
function prefixOwner(prefix) {
    for (const role of Object.keys(ROLE_ROUTES)) {
        if (ROLE_ROUTES[role].has(prefix)) return role;
    }
    return null;
}

/** True when the App Router owns this path. */
function isNextOwnedApiPath(path) {
    return NEXT_OWNED_API_PATHS.some((route) => underPrefix(requestPath(path), route));
}

/**
 * The role that MUST serve this path, or null when any registered group may (the frontend catch-all
 * and everything under it).
 *
 * Derived from the path, not from the prefix that happened to match: that is what makes the guarantee
 * survive a missing/deleted `/api` entry, which is exactly the state the eviction bug created.
 */
function requiredRoleForPath(url) {
    const path = requestPath(url);
    if (isNextOwnedApiPath(path)) return 'frontend';
    for (const prefix of ROLE_ROUTES.backend) {
        if (underPrefix(path, prefix)) return 'backend';
    }
    return null;
}

/**
 * Pick the upstream for one request from the worker's view of the registry.
 *
 * @param {Map<string, {name?: string, targets: Set<string>|string[], index?: number, metrics?: any}>} registry
 *        the WORKER's copy: `targets` is a Set and `metrics` the plain object the primary broadcasts
 * @param {string} url the raw request URL (query included)
 * @returns {string|null} the target origin, or null when nothing may serve it (caller → 502/404)
 */
function resolveTarget(registry, url) {
    const path = requestPath(url);
    const role = requiredRoleForPath(path);
    const entries = Array.from(registry.entries()).sort((a, b) => b[0].length - a[0].length);

    for (const [prefix, group] of entries) {
        if (!underPrefix(path, prefix)) continue;
        // OWNER-AWARE (1): a group of the wrong role may not serve this path — not even as a
        // fallback, and not even if it is the only thing left in the registry. Skipping (rather than
        // returning) lets a correctly-owned longer prefix further down the list still win; if none
        // exists the loop ends at null and the request 502s instead of leaking to the catch-all.
        //
        // A group with no `name` (a registry.json from before groups carried one) is judged by the
        // role that OWNS the prefix it is registered under — which /register already enforced when
        // the entry was created. Without that fallback an old file would 502 /api until the backend
        // happened to restart, and turning an availability fix into an availability bug is not a fix.
        // THE CLASS THIS GUARD STATES (round-2 re-verify of #22): the decision is made from the
        // attribute the gateway can VERIFY ITSELF — the static prefix→role map — and a STORED label
        // may only ever restrict it further, never grant. The old form was `group.name ||
        // prefixOwner(prefix)`, i.e. the label FIRST, and that is what made a peer-influenced value
        // load-bearing: `name` reaches a process through gateway-registry.json on disk and through the
        // IPC broadcast, so any consumer that had not re-derived it (the WORKER, which is the process
        // that routes) would hand `/api/v1/auth/login` to a frontend node labelled 'backend'.
        //
        // Two conditions, deliberately a CONJUNCTION and both fail-closed:
        //  1. the prefix's OWNER — derived, or the stored label only when no role declares the prefix
        //     (a legacy/unknown entry; such a prefix can never cover a path that requires a role
        //     anyway, since requiredRoleForPath is derived from the PATH) — must be the required role;
        //  2. a stored label that CONTRADICTS the derived owner refuses the group outright: the two
        //     sources disagreeing is itself the signal, and a mislabelled group is never worth serving.
        // A non-string label (an array/number/object — the other round-2 class) is not a label at all:
        // it is ignored, and the derived owner decides alone.
        const declared = typeof group.name === 'string' ? group.name : null;
        const derived = prefixOwner(prefix);
        if (role && ((derived || declared) !== role || (declared && declared !== role))) continue;

        const targets = Array.from(group.targets || []);
        const metrics = group.metrics;
        const healthy = targets.filter((t) => !metrics || (metrics[t] && metrics[t].status) !== 'Failing');
        const final = healthy.length > 0 ? healthy : targets;
        // EMPTY GROUP (2): the route is still OURS — the backend is restarting, not gone. Answer "no
        // target" so the caller degrades to the loopback bootstrap or a 502, instead of continuing the
        // loop into the frontend's `/`.
        if (final.length === 0) return null;
        const target = final[(group.index || 0) % final.length];
        group.index = (group.index || 0) + 1;
        return target;
    }
    return null;
}

/**
 * TURN A PERSISTED / BROADCAST REGISTRY OBJECT INTO A ROUTING MAP — the one place a process outside
 * the primary is allowed to build the map it routes with.
 *
 * THE CLASS (round-2 re-verify of #22): every consumer of the registry must re-derive the values it
 * AUTHORIZES with, in EVERY process, not only where the guard was first written. Wave 3 re-derived
 * the group label in the primary's loader and in applyRegistration, and the gateway kept routing with
 * a third copy: the WORKER loads gateway-registry.json itself and used to build its Map with
 * `{ ...v, targets: new Set(v.targets) }`, which copies `name` — a label a pre-fix gateway wrote
 * straight out of the peer's request body — verbatim into the object resolveTarget authorizes with.
 * The value that was checked and the value that was used were different objects, in different
 * processes.
 *
 * So the shape is stated once, here, and NOTHING is spread:
 *   · `name` is DERIVED from the prefix (prefixOwner) — the same derivation registration.groupOwner
 *     performs with the authenticated CN as its second term, which is the only other source with any
 *     authority. A label from a file or from IPC is never copied.
 *   · `targets` accepts only strings, and only from an array: every field in a JSON file can arrive
 *     as an object/number/null, and `new Set(<number>)` throws — which used to abort the whole load.
 *   · `metrics` is kept as the plain object the primary broadcasts (health only, no authority).
 *   · `index` is carried over from the previous map so a reload does not restart round-robin.
 * Any other key in the file is DROPPED rather than inherited.
 *
 * @param {object} data  the parsed gateway-registry.json, or the primary's REGISTRY_UPDATE payload
 * @param {Map}    [prev] the map being replaced, to preserve round-robin position
 */
function hydrateRegistry(data, prev) {
    const out = new Map();
    if (!data || typeof data !== 'object') return out;
    for (const [prefix, raw] of Object.entries(data)) {
        if (typeof prefix !== 'string' || !raw || typeof raw !== 'object') continue;
        const targets = Array.isArray(raw.targets) ? raw.targets.filter((t) => typeof t === 'string' && t) : [];
        const metrics = raw.metrics && typeof raw.metrics === 'object' && !Array.isArray(raw.metrics) ? raw.metrics : {};
        out.set(prefix, {
            name: prefixOwner(prefix),
            targets: new Set(targets),
            index: (prev && prev.get(prefix) && prev.get(prefix).index) || 0,
            metrics
        });
    }
    return out;
}

module.exports = {
    ROLE_ROUTES,
    NEXT_OWNED_API_PATHS,
    requestPath,
    underPrefix,
    prefixOwner,
    isNextOwnedApiPath,
    requiredRoleForPath,
    resolveTarget,
    hydrateRegistry,
};
