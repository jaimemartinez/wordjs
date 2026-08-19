/**
 * WordJS Gateway — THE PROCESS THAT ROUTES MUST DERIVE WHAT IT AUTHORIZES WITH.
 *
 * THE CLASS (round-2 re-verify of audit #22 / #20): the gateway must never authorize a request with a
 * value the PEER supplied when it holds an attribute it can verify itself (the static prefix→role map,
 * or the peer's certificate CN) — and it must re-derive that value in EVERY process that consumes it,
 * not only in the one where the guard was first written.
 *
 * Wave 3 closed two of the three readers of the group label: `applyRegistration` (which used to copy
 * `req.body.name`) and the PRIMARY's `loadRegistry`. The third one is the one that decides: the WORKER
 * reads gateway-registry.json by itself and built its map with `{ ...v, targets: new Set(v.targets) }`,
 * so the label a pre-fix gateway had written from the peer's body was copied verbatim into the object
 * `routing.resolveTarget` authorizes with. With `{"/": {"name": "backend", "targets": ["<frontend>"]}}`
 * on disk, every worker proxied POST /api/v1/auth/login — password in the body — to the frontend node.
 * And nothing corrected it: the primary only broadcasts on a registration or a health TRANSITION, so a
 * healthy cluster never overwrote the worker's view of the file.
 *
 * These tests drive the REAL functions the worker calls (routing.hydrateRegistry → routing.resolveTarget)
 * over a TABLE of poisoning vectors × every backend-owned path, and then read gateway/src/index.js
 * itself to assert that the worker has no OTHER way of building the map — so a fourth loader added
 * later fails here instead of re-opening the same hole one call site over.
 *
 * MUTATION PROOF: restore the `{ ...v }` spread in either worker call site and "no worker-side registry
 * map is built outside the normalizer" fails; make hydrateRegistry copy `raw.name` and the whole
 * poisoned-label table fails; restore `group.name || prefixOwner(prefix)` in resolveTarget and the
 * "a map built anywhere else still cannot beat the static map" case fails.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const routing = require('../src/routing');
const registration = require('../src/registration');

const FRONTEND_NODE = 'https://frontend-node:3001';
const BACKEND_NODE = 'https://backend-node:4000';

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
/** Only the worker half of index.js — the primary's loader is a different (already-closed) member. */
const WORKER_SRC = INDEX_SRC.slice(INDEX_SRC.indexOf('// WORKER PROCESS'));

/**
 * Every path that MUST be served by the backend, derived from the role map itself rather than listed
 * here — a route added to ROLE_ROUTES.backend tomorrow is covered by this table automatically.
 */
const BACKEND_PATHS = [...routing.ROLE_ROUTES.backend].flatMap((prefix) => [
    prefix,
    `${prefix}/v1/auth/login`,
    `${prefix}/x.png?cache=1`,
]);

/**
 * The ways a label can arrive from a source the peer influenced. Each one is written into a
 * registry FILE (the worker's boot source) and into a broadcast PAYLOAD (its other source) — both go
 * through the same normalizer, so the table covers both entry points.
 *
 * The type variants are here on purpose: round 2's other critical was a field the code assumed was a
 * string arriving as an array, so "the label is a string that says 'backend'" is only one member of
 * the shape this map has to survive.
 */
const POISONED_LABELS = [
    ['a plain stolen label', 'backend'],
    ['an array (=== against a string never matches, but a sink may coerce it)', ['backend']],
    ['an object with a toString', { toString: () => 'backend' }],
    ['a prototype-polluting name', '__proto__'],
    ['a number', 4000],
    ['null', null],
    ['absent entirely', undefined],
];

/** A registry FILE as a pre-fix gateway would have written it: the catch-all labelled by the peer. */
function poisonedFile(label) {
    const group = { targets: [FRONTEND_NODE], metrics: {} };
    if (label !== undefined) group.name = label;
    return { '/': group };
}

test('CLASS: no peer-supplied label on the catch-all can make a backend path resolve to the frontend', () => {
    for (const [what, label] of POISONED_LABELS) {
        for (const source of ['file', 'broadcast']) {
            const view = routing.hydrateRegistry(poisonedFile(label));
            for (const url of BACKEND_PATHS) {
                assert.strictEqual(
                    routing.resolveTarget(view, url), null,
                    `${source}: ${what} — ${url} must not resolve to the frontend catch-all`
                );
            }
            // …and the paths the catch-all legitimately owns still work: this is a routing control,
            // not an outage.
            assert.strictEqual(routing.resolveTarget(view, '/some/page'), FRONTEND_NODE, `${source}: ${what}`);
            assert.strictEqual(routing.resolveTarget(view, '/api/revalidate'), FRONTEND_NODE, `${source}: ${what}`);
        }
    }
});

test('CLASS: the label the normalizer keeps is the DERIVED one, for every registrable prefix', () => {
    const file = {};
    for (const role of Object.keys(routing.ROLE_ROUTES)) {
        for (const prefix of routing.ROLE_ROUTES[role]) {
            // Every prefix arrives labelled as the OTHER role — the shape of the exploit.
            const lie = role === 'backend' ? 'frontend' : 'backend';
            file[prefix] = { name: lie, targets: [lie === 'backend' ? FRONTEND_NODE : BACKEND_NODE], metrics: {} };
        }
    }
    const view = routing.hydrateRegistry(file);
    for (const [prefix, group] of view) {
        assert.strictEqual(
            group.name, registration.groupOwner(prefix),
            `${prefix}: the worker's label must equal the derivation the primary/registration use`
        );
    }
    // The sink agrees: a backend path never lands on the node the file claimed owned it.
    for (const url of BACKEND_PATHS) {
        assert.notStrictEqual(routing.resolveTarget(view, url), FRONTEND_NODE, url);
    }
});

test('CLASS: a map built ANYWHERE else still cannot beat the static prefix→role map', () => {
    // resolveTarget is reachable with maps this module did not build (the primary's own, a future
    // caller). Deriving inside resolveTarget is what makes the guarantee independent of the builder.
    const handBuilt = new Map([
        ['/', { name: 'backend', targets: new Set([FRONTEND_NODE]), index: 0, metrics: {} }],
    ]);
    for (const url of BACKEND_PATHS) {
        assert.strictEqual(routing.resolveTarget(handBuilt, url), null, url);
    }
});

test('the normalizer survives every field arriving as the wrong type (no throw, no inherited key)', () => {
    const junk = {
        '/api': { targets: 'https://evil', metrics: 'nope', name: 'backend' },       // targets not an array
        '/uploads': { targets: [BACKEND_NODE, 42, null, ''], metrics: [] },           // mixed target types
        '/themes': { targets: [BACKEND_NODE], metrics: { [BACKEND_NODE]: null } },
        '/plugins': null,
        '/public': 7,
        '__proto__': { targets: [FRONTEND_NODE] },
    };
    const view = routing.hydrateRegistry(junk);
    assert.strictEqual(routing.resolveTarget(view, '/api/v1/posts'), null, 'a non-array targets is empty, not a string of chars');
    assert.strictEqual(routing.resolveTarget(view, '/uploads/a.png'), BACKEND_NODE, 'the string targets survive; the junk ones are dropped');
    assert.strictEqual(routing.resolveTarget(view, '/themes/a.css'), BACKEND_NODE);
    assert.ok(!view.has('/plugins') || view.get('/plugins').targets.size === 0);
    assert.strictEqual(Object.getPrototypeOf({}).targets, undefined, 'no prototype pollution from a key named __proto__');
    // extra keys in the file are dropped, never inherited into the routing object
    const extra = routing.hydrateRegistry({ '/api': { targets: [BACKEND_NODE], metrics: {}, owners: { x: 'y' }, evil: 1 } });
    assert.deepStrictEqual(Object.keys(extra.get('/api')).sort(), ['index', 'metrics', 'name', 'targets']);
});

test('round-robin position survives a reload (the normalizer is not a reset)', () => {
    const file = { '/api': { targets: [BACKEND_NODE, 'https://backend-2:4000'], metrics: {} } };
    let view = routing.hydrateRegistry(file);
    const first = routing.resolveTarget(view, '/api/x');
    const second = routing.resolveTarget(view, '/api/x');
    assert.notStrictEqual(first, second, 'two targets must alternate');
    view = routing.hydrateRegistry(file, view);           // a REGISTRY_UPDATE arrives
    assert.strictEqual(routing.resolveTarget(view, '/api/x'), first, 'the cursor carried over');
});

test('THE REAL TRACKED gateway-registry.json, through the worker path, routes nothing to the wrong role', () => {
    const file = path.join(__dirname, '..', 'gateway-registry.json');
    if (!fs.existsSync(file)) return; // a deployment without a persisted registry: nothing to prove
    const view = routing.hydrateRegistry(JSON.parse(fs.readFileSync(file, 'utf8')));
    for (const url of BACKEND_PATHS) {
        const target = routing.resolveTarget(view, url);
        if (target === null) continue;
        const group = [...view.entries()].find(([, g]) => g.targets.has(target));
        assert.strictEqual(group[1].name, 'backend', `${url} → ${target} (group ${group[0]})`);
    }
});

test('THE WORKER\'S OWN LOADER, executed verbatim, refuses the poisoned file', () => {
    // Not a re-implementation of the worker's loader (which is how this defect stayed invisible: both
    // existing suites hand-build the worker's view and never touch it) — the REAL source text of
    // `loadWorkerRegistry` from gateway/src/index.js, run against a poisoned registry.json on disk,
    // with the real fs and the real routing module. Everything the worker does except being a process.
    const body = WORKER_SRC.match(/const loadWorkerRegistry = \(\) => \{[\s\S]*?\n {4}\};/);
    assert.ok(body, 'loadWorkerRegistry not found in the worker half of index.js — update this gate');

    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-gw-registry-'));
    const file = path.join(dir, 'gateway-registry.json');
    // Exactly what a pre-fix gateway wrote when a CN=frontend node sent `name: 'backend'`.
    fs.writeFileSync(file, JSON.stringify({ '/': { name: 'backend', targets: [FRONTEND_NODE], metrics: {} } }));
    try {
        const run = new Function('fs', 'REGISTRY_FILE', 'routing',
            `let workerRegistry = new Map();\n${body[0]}\nloadWorkerRegistry();\nreturn workerRegistry;`);
        const workerRegistry = run(fs, file, routing);
        assert.strictEqual(workerRegistry.get('/').name, 'frontend', 'the label was re-derived from the prefix');
        for (const url of BACKEND_PATHS) {
            assert.strictEqual(routing.resolveTarget(workerRegistry, url), null, `worker getTarget(${url})`);
        }
        assert.strictEqual(routing.resolveTarget(workerRegistry, '/about'), FRONTEND_NODE, 'the catch-all still serves its own paths');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('SOURCE GATE: the worker builds its registry ONLY through the normalizer', () => {
    const assignments = WORKER_SRC.match(/workerRegistry\s*=\s*[^;]+/g) || [];
    assert.ok(assignments.length >= 2, 'expected the file loader and the IPC handler');
    for (const a of assignments) {
        assert.ok(
            /=\s*new Map\(\)\s*$/.test(a.trim()) || a.includes('routing.hydrateRegistry('),
            `a worker-side registry map is built outside routing.hydrateRegistry: ${a.trim().slice(0, 120)}`
        );
    }
    assert.ok(!/\{\s*\.\.\.v\s*,/.test(WORKER_SRC), 'a spread of a persisted/broadcast group is back in the worker');
    assert.ok(WORKER_SRC.includes('routing.resolveTarget(workerRegistry'), 'the worker still routes with the map it hydrated');
});

test('SOURCE GATE: the primary pushes its derived view at every worker that comes online', () => {
    // Without this the file stays a parallel source of truth: broadcastRegistry only runs on a
    // registration or a health TRANSITION, and a healthy cluster produces neither.
    assert.match(INDEX_SRC, /cluster\.on\('online',\s*\(worker\)\s*=>\s*sendRegistryTo\(worker\)\)/);
    assert.match(INDEX_SRC, /const broadcastRegistry = \(\) => \{[\s\S]{0,200}sendRegistryTo/);
});
