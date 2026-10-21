'use strict';
/**
 * The cluster as the admin panel drives it (src/cluster-admin.js, mounted at /cluster* in src/index.js):
 * the node list with health, removal that a heartbeat cannot undo, and the inputs a join token takes.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('../src/cluster-admin');

function registryOf(entries) {
    const registry = new Map();
    for (const [route, urls, metrics] of entries) {
        registry.set(route, { name: route, targets: new Set(urls), index: 0, metrics: new Map(Object.entries(metrics || {})) });
    }
    return registry;
}

test('describeNodes groups routes by node, with its role and the health sweep verdict', () => {
    const registry = registryOf([
        ['/api', ['https://10.0.0.2:4000', 'https://10.0.0.3:4000'], { 'https://10.0.0.2:4000': { status: 'Healthy', latency: 12 }, 'https://10.0.0.3:4000': { status: 'Failing', lastError: 'ECONNREFUSED', latency: 46 } }],
        ['/uploads', ['https://10.0.0.2:4000'], { 'https://10.0.0.2:4000': { status: 'Healthy', latency: 9 } }],
        ['/', ['https://10.0.0.9:3001'], {}],
    ]);
    const owners = new Map([['https://10.0.0.2:4000', 'backend'], ['https://10.0.0.3:4000', 'backend'], ['https://10.0.0.9:3001', 'frontend']]);
    const nodes = admin.describeNodes(registry, owners);
    assert.deepStrictEqual(nodes.map((n) => [n.url, n.role, n.status]), [
        ['https://10.0.0.2:4000', 'backend', 'up'],
        ['https://10.0.0.3:4000', 'backend', 'down'],
        ['https://10.0.0.9:3001', 'frontend', 'unknown'],
    ]);
    assert.deepStrictEqual(nodes[0].routes.sort(), ['/api', '/uploads']);
    assert.strictEqual(nodes[1].lastError, 'ECONNREFUSED');
    // A down node shows no latency: the one measured while it was up is stale (QA X1-04).
    assert.strictEqual(nodes[1].latencyMs, null);
    assert.strictEqual(nodes[0].latencyMs, 9);
});

test('removeNode takes the node out of every route; the removed store keeps it out until its host is re-admitted', () => {
    const registry = registryOf([['/api', ['https://10.0.0.2:4000', 'https://10.0.0.3:4000']], ['/uploads', ['https://10.0.0.2:4000']]]);
    const owners = new Map([['https://10.0.0.2:4000', 'backend'], ['https://10.0.0.3:4000', 'backend']]);
    assert.strictEqual(admin.removeNode(registry, owners, 'https://10.0.0.2:4000'), 2);
    assert.deepStrictEqual([...registry.get('/api').targets], ['https://10.0.0.3:4000']);
    assert.strictEqual(registry.get('/uploads').targets.size, 0, 'the route stays, empty (never falls through to another role)');
    assert.strictEqual(owners.has('https://10.0.0.2:4000'), false);

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-removed-')), 'cluster-removed.json');
    const store = admin.removedStore(file);
    store.add('https://10.0.0.2:4000');
    assert.strictEqual(admin.removedStore(file).has('https://10.0.0.2:4000'), true, 'persisted across a gateway restart');
    assert.strictEqual(store.clearHost('10.0.0.3'), 0);
    assert.strictEqual(store.clearHost('10.0.0.2'), 1, 'a new token pinned to the host re-admits it');
    assert.strictEqual(admin.removedStore(file).has('https://10.0.0.2:4000'), false);
});

test('join token inputs: lifetime 1-60 minutes (15 by default) and a host that is an IP or a DNS name', () => {
    assert.strictEqual(admin.ttlMinutes(undefined), 15);
    assert.strictEqual(admin.ttlMinutes(60), 60);
    for (const bad of [0, 61, 2.5, 'x', -1]) assert.strictEqual(admin.ttlMinutes(bad), null, String(bad));
    assert.strictEqual(admin.pinnedHost(''), null);
    assert.strictEqual(admin.pinnedHost('10.0.0.7'), '10.0.0.7');
    assert.strictEqual(admin.pinnedHost('Node-2.Internal'), 'node-2.internal');
    for (const bad of ['10.0.0.7 --start', 'a/b', 'x;rm', `${'a'.repeat(254)}`]) assert.strictEqual(admin.pinnedHost(bad), undefined, bad);
    const cmd = admin.joinCommand({ role: 'backend', gatewayHost: '10.0.0.1', enrollPort: 3101, token: 'wjc.backend.abc', caFingerprint: 'AA:BB', host: '10.0.0.7' });
    assert.match(cmd, /--role backend --gateway 10\.0\.0\.1/);
    assert.match(cmd, /--token wjc\.backend\.abc/);
    assert.match(cmd, /--advertise 10\.0\.0\.7 --start/);
});
