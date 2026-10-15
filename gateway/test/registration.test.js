/**
 * WordJS Gateway — a registration may not choose the label the proxy authorizes with.
 *
 * Adversarial re-verify of audit #22. The owner check added to routing.resolveTarget decides with
 * `group.name`, and the registry write copied that name straight out of the REQUEST BODY. The three
 * guards on /register inspect the declared routes, the target URL and who owns that URL — none of
 * them ever looked at `req.body.name`. A node with a legitimate `CN=frontend` certificate could
 * therefore register `{ name: 'backend', url: <its own host>, routes: ['/'] }`, pass every guard, and
 * end up owning the catch-all UNDER THE BACKEND'S NAME. With no `/api` entry present — first boot, or
 * the window while the backend restarts — `/api/v1/auth/login` then resolves to the frontend node:
 * the credential capture this whole control exists to prevent, granted BY the control.
 *
 * These tests drive the REAL producer (src/registration.applyRegistration, the function src/index.js
 * calls) and then ask the REAL routing decision (src/routing.resolveTarget) what it does with the
 * registry that producer just wrote — no re-implementation of either.
 *
 * MUTATION PROOF: restore `name: service.name` in applyRegistration and the first two tests fail
 * (resolveTarget hands /api/v1/auth/login to the frontend node). Drop the re-stamp of an existing
 * group and the third fails. Drop groupOwner()'s prefix precedence and the fourth fails.
 */

const test = require('node:test');
const assert = require('node:assert');

const registration = require('../src/registration');
const routing = require('../src/routing');

const FRONTEND_NODE = 'https://frontend-node:3001';
const BACKEND_NODE = 'https://backend-node:3000';

/** The worker's view of the primary's registry (targets Set, metrics plain object). */
const workerView = (registry) => {
    const out = new Map();
    registry.forEach((group, route) => {
        out.set(route, { name: group.name, targets: new Set(group.targets), index: 0, metrics: {} });
    });
    return out;
};

test('the group label comes from the authenticated identity, not from the body', () => {
    const registry = new Map();
    const targetOwner = new Map();

    // Exactly what a rogue-but-authenticated frontend sends: its own host, a route its role owns,
    // and a `name` claiming to be the backend.
    registration.applyRegistration(
        registry,
        targetOwner,
        { url: FRONTEND_NODE, routes: ['/'], name: 'backend' },
        'frontend'
    );

    assert.strictEqual(registry.get('/').name, 'frontend', 'the label must be the peer identity');
    assert.strictEqual(targetOwner.get(FRONTEND_NODE), 'frontend');

    // And the control that reads that label refuses the credential path, with no /api entry present.
    const view = workerView(registry);
    assert.strictEqual(routing.resolveTarget(view, '/api/v1/auth/login'), null, 'no /api target may exist');
    assert.strictEqual(routing.resolveTarget(view, '/uploads/2026/x.png'), null);
    assert.strictEqual(routing.resolveTarget(view, '/metrics'), null);
    // …while what the node legitimately serves still resolves.
    assert.strictEqual(routing.resolveTarget(view, '/about'), FRONTEND_NODE);
});

test('an honest registration is unaffected: the backend still owns /api', () => {
    const registry = new Map();
    const targetOwner = new Map();
    registration.applyRegistration(registry, targetOwner, { url: BACKEND_NODE, routes: ['/api', '/uploads'] }, 'backend');
    registration.applyRegistration(registry, targetOwner, { url: FRONTEND_NODE, routes: ['/', '/admin'] }, 'frontend');

    const view = workerView(registry);
    assert.strictEqual(routing.resolveTarget(view, '/api/v1/auth/login'), BACKEND_NODE);
    assert.strictEqual(routing.resolveTarget(view, '/uploads/a.png'), BACKEND_NODE);
    assert.strictEqual(routing.resolveTarget(view, '/admin/posts'), FRONTEND_NODE);
    assert.strictEqual(routing.resolveTarget(view, '/'), FRONTEND_NODE);
});

test('a poisoned label already in the registry is re-stamped by the next registration', () => {
    // The state a pre-fix gateway persisted into gateway-registry.json, or that survived in memory.
    const registry = new Map([
        ['/', { name: 'backend', targets: new Set([FRONTEND_NODE]), index: 0, metrics: new Map() }],
    ]);
    const targetOwner = new Map();

    registration.applyRegistration(registry, targetOwner, { url: FRONTEND_NODE, routes: ['/'], name: 'backend' }, 'frontend');

    assert.strictEqual(registry.get('/').name, 'frontend');
    assert.strictEqual(routing.resolveTarget(workerView(registry), '/api/v1/posts'), null);
});

test('groupOwner derives the label from the prefix, and only then from the CN', () => {
    // The static role→routes map is the strongest statement available and /register already enforced
    // it, so it wins even over the authenticated CN.
    assert.strictEqual(registration.groupOwner('/', 'backend'), 'frontend');
    assert.strictEqual(registration.groupOwner('/api', 'frontend'), 'backend');
    // A route no role declares can never be registered; falling back to the identity keeps a legacy
    // entry judged by something the peer had to PROVE, and `undefined` is the safe answer otherwise.
    assert.strictEqual(registration.groupOwner('/weird', 'frontend'), 'frontend');
    assert.strictEqual(registration.groupOwner('/weird'), undefined);
    // The persisted-file path (index.js loadRegistry) calls it with no CN at all.
    assert.strictEqual(registration.groupOwner('/'), 'frontend');
    assert.strictEqual(registration.groupOwner('/api'), 'backend');
});

test('a re-registration that drops a route removes it instead of leaving a ghost', () => {
    const registry = new Map();
    const targetOwner = new Map();
    registration.applyRegistration(registry, targetOwner, { url: BACKEND_NODE, routes: ['/api', '/metrics'] }, 'backend');
    assert.deepStrictEqual([...registry.keys()], ['/api', '/metrics']);

    registration.applyRegistration(registry, targetOwner, { url: BACKEND_NODE, routes: ['/api'] }, 'backend');
    assert.deepStrictEqual([...registry.keys()], ['/api'], 'the route it no longer declares is gone');
    assert.strictEqual(routing.resolveTarget(workerView(registry), '/api/v1/posts'), BACKEND_NODE);
});

/*
 * A frontend that booted before setup registers in plain HTTP; after its first restart the SAME socket
 * listens with mTLS and registers in HTTPS. The registry is persisted, so the new registration must
 * replace the old one — otherwise round-robin sends every other request as plain HTTP into a TLS socket.
 *
 * MUTATION PROOF: return [] from schemeTwins and the first test fails; drop its owner comparison and the
 * second fails; drop its host comparison and the third fails.
 */
const FRONTEND_PLAIN = 'http://127.0.0.1:3001';
const FRONTEND_TLS = 'https://127.0.0.1:3001';
const FE_ROUTES = ['/', '/admin', '/_next'];

test('a registration in the other scheme replaces the same node\'s target at that host and port', () => {
    const registry = new Map();
    const targetOwner = new Map();
    registration.applyRegistration(registry, targetOwner, { url: FRONTEND_PLAIN, routes: FE_ROUTES }, 'frontend');
    registration.applyRegistration(registry, targetOwner, { url: FRONTEND_TLS, routes: FE_ROUTES }, 'frontend');
    for (const route of FE_ROUTES) {
        assert.deepStrictEqual([...registry.get(route).targets], [FRONTEND_TLS], `${route} keeps only the new scheme`);
    }
    assert.strictEqual(targetOwner.has(FRONTEND_PLAIN), false, 'the replaced target loses its owner entry');
    assert.strictEqual(targetOwner.get(FRONTEND_TLS), 'frontend');
});

test('another identity\'s target at the same host and port is never displaced', () => {
    const registry = new Map();
    const targetOwner = new Map();
    registration.applyRegistration(registry, targetOwner, { url: FRONTEND_PLAIN, routes: ['/'] }, 'frontend');
    registration.applyRegistration(registry, targetOwner, { url: FRONTEND_TLS, routes: ['/'] }, 'backend');
    assert.deepStrictEqual([...registry.get('/').targets].sort(), [FRONTEND_PLAIN, FRONTEND_TLS]);
    assert.strictEqual(targetOwner.get(FRONTEND_PLAIN), 'frontend');
});

test('the same node on another port, or a registration without an identity, replaces nothing', () => {
    const registry = new Map();
    const targetOwner = new Map();
    registration.applyRegistration(registry, targetOwner, { url: FRONTEND_PLAIN, routes: ['/'] }, 'frontend');
    registration.applyRegistration(registry, targetOwner, { url: 'https://127.0.0.1:3002', routes: ['/'] }, 'frontend');
    assert.deepStrictEqual([...registry.get('/').targets].sort(), [FRONTEND_PLAIN, 'https://127.0.0.1:3002']);
    assert.deepStrictEqual(registration.schemeTwins(FRONTEND_TLS, targetOwner, undefined), []);
});
