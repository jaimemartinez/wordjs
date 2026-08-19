'use strict';
/**
 * THREE DISPATCHERS, ONE VERDICT.
 *
 * WordJS decides "is this URL the backend's?" in three different processes, one per deployment shape:
 *
 *   1. gateway/src/routing.js          — the gateway worker's proxy (split + separate mode)
 *   2. frontend/backend-proxy-target.js — the frontend replica's own server, when WORDJS_BACKEND_URL
 *                                          pins it to a backend (horizontal scaling)
 *   3. monolith.js                      — the single-process dispatcher
 *
 * Audit 2026-08-18 #28: they had drifted. monolith.js KNEW that `/api/revalidate` is a Next route and
 * exempted it with an explicit comment; the other two did not, so in the two modes with more than one
 * process the backend's on-demand cache purge was forwarded to the backend, 404'd, and
 * `revalidateTag`/`revalidatePath` never ran — every publish, edit and settings change stayed
 * invisible until the ISR window expired. A comment in one file is not a mechanism.
 *
 * This test IS the mechanism. It drives the REAL exported predicates (not copies of their logic),
 * walks `frontend/src/app/api/**` to catch a new Next route that nobody classified, and demands the
 * same answer from all three for every path in one table. Divergences that are DELIBERATE are listed
 * at the bottom with the reason they exist — anything else fails.
 *
 * NOTE ON REQUIRING monolith.js: it exports its dispatcher and boots only under
 * `require.main === module`, and its module scope pulls in nothing outside the repo — so this file
 * works in the gateway CI job, which installs gateway/node_modules and nothing else.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const gatewayRouting = require('../src/routing');
const frontendProxy = require('../../frontend/backend-proxy-target.js');
const monolith = require('../../monolith.js');

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Each dispatcher, reduced to the one question they all answer. */
const dispatchers = {
    gateway: (url) => gatewayRouting.requiredRoleForPath(url) === 'backend',
    'frontend replica': (url) => frontendProxy.isProxiedPath(String(url).split('?')[0]),
    monolith: (url) => monolith.isBackendPath(url),
};

// [path, isBackend] — the verdict every dispatcher must reach.
const ROUTE_TABLE = [
    ['/api/v1/posts', true],
    ['/api/v1/auth/login', true],
    ['/api', true],
    ['/api/internal/gateway-update', true],   // CONTESTED: the backend mounts it for real (see below)
    ['/api/revalidate', false],               // NEXT owns it — the on-demand purge receiver
    ['/api/revalidate/', false],
    ['/api/revalidateXYZ', true],             // segment boundary: not the Next route
    ['/uploads/2026/08/pic.png', true],
    ['/uploads', true],
    ['/themes/default/style.css', true],
    ['/plugins/online-store/frontend.bundle.js', true],
    ['/public/css/wordjs-ui.css', true],
    ['/.well-known/acme-challenge/token', true],
    ['/', false],
    ['/about', false],
    ['/admin/posts/1/edit', false],
    ['/_next/static/chunk.js', false],
    // A page whose slug merely starts with a backend prefix belongs to the site.
    ['/apiary', false],
    ['/uploadsomething', false],
    ['/themesong', false],
];

test('all three dispatchers agree on who owns each path', () => {
    for (const [url, expected] of ROUTE_TABLE) {
        for (const [name, decide] of Object.entries(dispatchers)) {
            assert.strictEqual(
                decide(url), expected,
                `${name} disagrees on ${url}: expected ${expected ? 'BACKEND' : 'NEXT/frontend'}`,
            );
        }
    }
});

test('the query string never changes the verdict', () => {
    for (const [url, expected] of ROUTE_TABLE) {
        for (const [name, decide] of Object.entries(dispatchers)) {
            assert.strictEqual(decide(`${url}?x=1&y=2`), expected, `${name} disagrees on ${url} with a query string`);
        }
    }
});

test('the gateway and the frontend module carry the SAME Next-owned list', () => {
    assert.deepStrictEqual(
        [...gatewayRouting.NEXT_OWNED_API_PATHS].sort(),
        [...frontendProxy.NEXT_OWNED_API_PATHS].sort(),
        'gateway/src/routing.js and frontend/backend-proxy-target.js must exempt exactly the same routes — ' +
        'the gateway keeps its own copy on purpose (it can be deployed without a frontend/ tree), and this ' +
        'assertion is what binds them.',
    );
});

/** Every `route.ts` under frontend/src/app/api, as the URL path it is served at. */
function discoverNextApiRoutes() {
    const base = path.join(REPO_ROOT, 'frontend', 'src', 'app', 'api');
    const found = [];
    const walk = (dir, segments) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                // Route groups `(name)` do not appear in the URL.
                walk(full, /^\(.*\)$/.test(entry.name) ? segments : segments.concat(entry.name));
            } else if (/^route\.(ts|tsx|js|mjs)$/.test(entry.name)) {
                found.push('/' + segments.join('/'));
            }
        }
    };
    walk(base, ['api']);
    return found.sort();
}

test('every Next API route is classified — a new one cannot slip in unnoticed', () => {
    const discovered = discoverNextApiRoutes();
    assert.ok(discovered.length > 0, 'expected to find route handlers under frontend/src/app/api');

    const classified = new Set([
        ...frontendProxy.NEXT_OWNED_API_PATHS,
        ...frontendProxy.CONTESTED_API_PATHS,
    ]);
    for (const route of discovered) {
        assert.ok(
            classified.has(route),
            `Next API route ${route} is not classified in frontend/backend-proxy-target.js. Add it to ` +
            'NEXT_OWNED_API_PATHS (and to the gateway\'s copy) if Next must serve it, or to ' +
            'CONTESTED_API_PATHS with the reason it stays with the backend. Leaving it out is how ' +
            '/api/revalidate ended up 404ing on every replica.',
        );
    }

    // And the classification must describe reality: what is exempted has to exist as a route.
    for (const route of frontendProxy.NEXT_OWNED_API_PATHS) {
        assert.ok(discovered.includes(route), `${route} is exempted but has no route handler under frontend/src/app/api`);
    }
});

// ---------------------------------------------------------------------------------------------
// THE BACKEND PREFIX SET LIVES IN FOUR COPIES. THIS BINDS THEM TO ONE DERIVED VALUE.
//
// ROUND-3 FINDING (verify3 #44): the Next half of this file derived its population — it walks
// `frontend/src/app/api/**` — but the BACKEND half did not. `ROUTE_TABLE` above is a list of
// EXAMPLES, and the set it samples exists four times, written out by hand in four files:
//
//   · backend/src/index.ts              the `routes: […]` the backend ADVERTISES at /register
//   · gateway/src/routing.js            ROLE_ROUTES.backend — what the gateway proxies, and what it
//                                       lets a peer with the `backend` CN claim
//   · frontend/backend-proxy-target.js  PROXIED_PREFIXES — the replica's own proxy
//   · monolith.js                       BACKEND_PREFIXES — the single-process dispatcher
//
// Add '/exports' to two of them and this suite stayed GREEN while the prefix 404'd in replica and in
// monolith mode — defect #28 all over again, in the file that exists to prevent it. Worse: advertise
// it in the backend's `routes:` without adding it to ROLE_ROUTES and the gateway answers 403 to
// /register (gateway/src/index.js checks `bad.length`), so the backend stops registering AT ALL.
//
// So the four are bound to ONE derived set: what backend/src/index.ts advertises. The two divergences
// that are DELIBERATE are declared below as transforms of that set, and each transform is itself
// checked against the derived set, so an exemption cannot go stale silently. Everything else fails.
// ---------------------------------------------------------------------------------------------

/**
 * The route prefixes a process ADVERTISES at /register, read out of its own source.
 *
 * Comments are stripped first (prose that quotes `routes: [...]` must not be mistaken for the
 * declaration, and a declaration must not be hidden inside one), and the match count is asserted to be
 * exactly one: zero means the shape moved and this gate went blind, more than one means the set is
 * declared twice, which is the defect this whole file is about.
 */
function advertisedRoutes(relPath) {
    const src = fs.readFileSync(path.join(REPO_ROOT, ...relPath.split('/')), 'utf8');
    const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '\n')
        .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const matches = [...code.matchAll(/\broutes\s*:\s*\[([^\]]*)\]/g)];
    assert.strictEqual(
        matches.length, 1,
        `${relPath} must declare its advertised route prefixes exactly once — found ${matches.length}. ` +
        'Zero means this gate can no longer see the declaration (fix the gate, do not delete it); more ' +
        'than one means the set is declared twice, which is the drift this file exists to catch.',
    );
    const literals = (matches[0][1].match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1));
    assert.ok(literals.length >= 5, `${relPath}: parsed only ${literals.length} prefixes — the parse is wrong`);
    return literals;
}

const BACKEND_ADVERTISED = advertisedRoutes('backend/src/index.ts');
const FRONTEND_ADVERTISED = advertisedRoutes('frontend/src/instrumentation.ts');

/**
 * DELIBERATE DIVERGENCE 1 — the operational probes are advertised by the backend but must NOT be
 * proxied by a frontend replica: "is this node healthy" answered on another node's behalf reports the
 * wrong node's health to whatever is watching.
 */
const REPLICA_NOT_PROXIED = ['/healthz', '/readyz', '/metrics'];

/**
 * DELIBERATE DIVERGENCE 2 — the monolith answers /healthz itself in dispatch() (liveness, before the
 * backend app exists), and forwards the backend's own '/health' tree instead.
 */
const MONOLITH_RENAMES = { '/healthz': '/health' };

test('the gateway lets each role claim exactly what that role advertises', () => {
    assert.deepStrictEqual(
        [...gatewayRouting.ROLE_ROUTES.backend].sort(), [...BACKEND_ADVERTISED].sort(),
        'gateway/src/routing.js ROLE_ROUTES.backend has drifted from the `routes: […]` backend/src/index.ts ' +
        'advertises. A prefix the backend claims but the gateway does not know makes /register answer 403 — ' +
        'the backend then never registers, and NOTHING is proxied to it.',
    );
    assert.deepStrictEqual(
        [...gatewayRouting.ROLE_ROUTES.frontend].sort(), [...FRONTEND_ADVERTISED].sort(),
        'gateway/src/routing.js ROLE_ROUTES.frontend has drifted from frontend/src/instrumentation.ts',
    );
});

test('the frontend replica proxies exactly the advertised set, minus the probes it must not answer for', () => {
    for (const probe of REPLICA_NOT_PROXIED) {
        assert.ok(BACKEND_ADVERTISED.includes(probe),
            `${probe} is exempted from the replica proxy but the backend no longer advertises it — stale exemption`);
    }
    const normalized = frontendProxy.PROXIED_PREFIXES.map((p) => p.replace(/\/+$/, '')).sort();
    const expected = BACKEND_ADVERTISED.filter((p) => !REPLICA_NOT_PROXIED.includes(p)).sort();
    assert.deepStrictEqual(
        normalized, expected,
        'frontend/backend-proxy-target.js PROXIED_PREFIXES has drifted from what the backend advertises. ' +
        'A prefix missing here 404s on every horizontally-scaled replica (that is how /themes and /public ' +
        'came back as the Next 404 page and the editor canvas rendered unstyled).',
    );
});

test('the monolith dispatcher carries exactly the advertised set, modulo its declared renames', () => {
    for (const from of Object.keys(MONOLITH_RENAMES)) {
        assert.ok(BACKEND_ADVERTISED.includes(from),
            `${from} is renamed for the monolith but the backend no longer advertises it — stale rename`);
    }
    const expected = BACKEND_ADVERTISED.map((p) => MONOLITH_RENAMES[p] || p).sort();
    assert.deepStrictEqual(
        [...monolith.BACKEND_PREFIXES].sort(), expected,
        'monolith.js BACKEND_PREFIXES has drifted from what the backend advertises — the prefix would 404 ' +
        'in monolith mode only, which is the mode most installs run.',
    );
});

test('every ADVERTISED prefix is claimed by all three dispatchers (population, not examples)', () => {
    // Derived from BACKEND_ADVERTISED rather than from ROUTE_TABLE: a prefix added to index.ts is driven
    // through all three dispatchers here without anyone remembering to add a row.
    for (const prefix of BACKEND_ADVERTISED) {
        if (REPLICA_NOT_PROXIED.includes(prefix)) continue;   // covered by the probe test at the bottom
        for (const [name, decide] of Object.entries(dispatchers)) {
            assert.strictEqual(decide(`${prefix}/derived-probe`), true,
                `${name} does not claim ${prefix}/derived-probe, which backend/src/index.ts advertises`);
            // …and the prefix is a SEGMENT: a page whose slug merely starts with it belongs to the site.
            assert.strictEqual(decide(`${prefix}sibling`), false,
                `${name} swallows ${prefix}sibling — a public page whose slug starts with a backend prefix`);
        }
    }
});

test('the contested route is contested for a REASON: the backend mounts it too', () => {
    // /api/internal/gateway-update exists in BOTH trees (backend/src/index.ts mounts /api/internal,
    // and frontend/src/app/api/internal/gateway-update/route.ts exists). Exempting it would take a
    // live, secret-gated backend endpoint away from the backend. Pinning the fact here so the next
    // person to touch the list meets the collision instead of discovering it in production.
    const backendIndex = fs.readFileSync(path.join(REPO_ROOT, 'backend', 'src', 'index.ts'), 'utf8');
    assert.match(backendIndex, /app\.use\('\/api\/internal'/, 'the backend still mounts /api/internal');
    assert.ok(frontendProxy.CONTESTED_API_PATHS.includes('/api/internal/gateway-update'));
    for (const decide of Object.values(dispatchers)) {
        assert.strictEqual(decide('/api/internal/gateway-update'), true);
    }
});

// ---------------------------------------------------------------------------------------------
// DELIBERATE DIVERGENCES — pinned so they stay deliberate.
//
// The operational probes are the only paths the three treat differently, and the difference is the
// point: a frontend replica must NOT answer "/healthz" on a backend's behalf, because whatever is
// watching would then read the wrong node's health. The monolith is one process, so its /health*
// belongs to the backend app; the gateway answers /healthz itself and proxies /readyz onward.
// ---------------------------------------------------------------------------------------------
test('the probe paths diverge on purpose, and only the probe paths', () => {
    for (const probe of ['/healthz', '/readyz', '/metrics']) {
        assert.strictEqual(dispatchers['frontend replica'](probe), false, `${probe} must never be proxied by a frontend replica`);
        assert.strictEqual(dispatchers.gateway(probe), true, `${probe} is the backend's on the gateway`);
    }
    // The monolith's list says '/health' (its own liveness answer is /healthz, handled before dispatch).
    assert.strictEqual(monolith.isBackendPath('/health'), true);
    assert.strictEqual(monolith.isBackendPath('/readyz'), true);
    assert.strictEqual(monolith.isBackendPath('/metrics'), true);
});
