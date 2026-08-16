/**
 * CROSS-MACHINE CACHE PURGE — which way does a purge leave this node?
 *
 * On one host the backend POSTs the purge straight at the frontend and edits appear instantly. In
 * SEPARATE mode that address does not exist: the installer sets an enrolled node's `frontendUrl` to the
 * gateway's PUBLIC origin, whose `/api` prefix the gateway routes straight back to the backend — so the
 * old code posted `/api/revalidate` at itself, logged `[Purge] frontend unreachable`, and every publish
 * fell back to ~60 s ISR freshness. Guessing harder is not the fix: a cluster can run N frontend
 * replicas and only the gateway knows where they are (it holds the registration registry).
 *
 * So an enrolled node hands the purge to the gateway over the mTLS channel it already uses to register,
 * and the gateway fans it out. These tests pin that choice, and pin that nothing changes for monolith or
 * single-host split — where the direct path is shorter and already works.
 *
 * MUTATION PROOF: against the pre-fix module `purgeTransport` does not exist at all (the test file
 * cannot even destructure it). Make the enrolled branch return `direct` and the cluster tests fail;
 * drop the `certExists` guard and the "enrolled but identity missing" test fails.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { purgeTransport, gatewayPurgeOptions } = require('../core/frontend-purge');

// The shape scripts/node-join.js writes on a SEPARATE-mode node, after the wizard has run.
const enrolled = {
    gatewayHost: '10.0.0.5',
    gatewayInternalPort: 3100,
    gatewayPort: 3000,
    gatewaySecret: 'deadbeef',
    siteUrl: 'https://10.0.0.5:3000',
    // The installer points an enrolled node's frontendUrl at the gateway (the cluster's public origin) —
    // this is exactly the value that made the old direct purge post at the backend itself.
    frontendUrl: 'https://10.0.0.5:3000',
    advertiseHost: '10.0.0.6',
    host: '0.0.0.0',
    port: 4000,
    mtls: { ca: './certs/cluster-ca.crt', key: './certs/backend.key', cert: './certs/backend.crt' },
};

// A single-host split: gateway on 3000, frontend next door on 3001, no cluster enrollment.
const split = {
    siteUrl: 'http://localhost:3000',
    frontendUrl: 'http://localhost:3001',
    port: 4000,
    installedAt: new Date().toISOString(),
};

const certPresent = () => true;
const certAbsent = () => false;

describe('purgeTransport — the direct path stays the direct path', () => {
    test('monolith purges its own Next server on the shared port', () => {
        const t = purgeTransport(split, { WORDJS_MODE: 'mono', PORT: '3000' }, certPresent);
        assert.deepStrictEqual(t, { mode: 'direct', origin: 'http://127.0.0.1:3000' });
    });

    test('single-host split purges the co-located frontend directly (no gateway hop)', () => {
        const t = purgeTransport(split, {}, certPresent);
        assert.deepStrictEqual(t, { mode: 'direct', origin: 'http://localhost:3001' });
    });

    test('a trailing slash on frontendUrl does not produce a double slash', () => {
        const t = purgeTransport({ ...split, frontendUrl: 'http://localhost:3001/' }, {}, certPresent);
        assert.deepStrictEqual(t, { mode: 'direct', origin: 'http://localhost:3001' });
    });

    test('an unconfigured site still resolves to the historical default', () => {
        assert.deepStrictEqual(purgeTransport({}, {}, certPresent), { mode: 'direct', origin: 'http://localhost:3000' });
        assert.deepStrictEqual(purgeTransport(null, {}, certPresent), { mode: 'direct', origin: 'http://localhost:3000' });
    });

    test('MONOLITH WINS over everything: an enrolled config running as mono still goes direct', () => {
        const t = purgeTransport(enrolled, { WORDJS_MODE: 'mono', PORT: '3000' }, certPresent);
        assert.deepStrictEqual(t, { mode: 'direct', origin: 'http://127.0.0.1:3000' });
    });
});

describe('purgeTransport — a cluster node asks the gateway instead of guessing', () => {
    test('an enrolled node routes the purge through the gateway control plane', () => {
        const t = purgeTransport(enrolled, {}, certPresent);
        assert.deepStrictEqual(t, { mode: 'gateway', host: '10.0.0.5', port: 3100 });
    });

    test('it must NOT fall back to frontendUrl — that address is the gateway, i.e. this backend', () => {
        const t = purgeTransport(enrolled, {}, certPresent);
        assert.notStrictEqual(t.mode, 'direct');
    });

    test('the internal port defaults to 3100 when the config omits it', () => {
        const noPort: any = { ...enrolled };
        delete noPort.gatewayInternalPort;
        assert.deepStrictEqual(purgeTransport(noPort, {}, certPresent), { mode: 'gateway', host: '10.0.0.5', port: 3100 });
    });

    test('enrolled-looking config whose identity cert is GONE degrades to direct, never to a broken mTLS call', () => {
        const t = purgeTransport(enrolled, {}, certAbsent);
        assert.strictEqual(t.mode, 'direct');
    });

    test('gateway wiring without an enrollment identity (plain split behind a gateway) stays direct', () => {
        const t = purgeTransport({ ...split, gatewayHost: 'localhost' }, {}, certPresent);
        assert.deepStrictEqual(t, { mode: 'direct', origin: 'http://localhost:3001' });
    });
});

describe('gatewayPurgeOptions — the request rides the existing mTLS identity', () => {
    let dir: string;
    let cfg: any;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-purge-'));
        fs.writeFileSync(path.join(dir, 'cluster-ca.crt'), 'CA');
        fs.writeFileSync(path.join(dir, 'backend.key'), 'KEY');
        fs.writeFileSync(path.join(dir, 'backend.crt'), 'CERT');
        cfg = {
            ...enrolled,
            mtls: {
                ca: path.join(dir, 'cluster-ca.crt'),
                key: path.join(dir, 'backend.key'),
                cert: path.join(dir, 'backend.crt'),
            },
        };
    });

    after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

    test('it targets the gateway INTERNAL port and the /purge endpoint', () => {
        const o = gatewayPurgeOptions(cfg, { host: '10.0.0.5', port: 3100 }, 42);
        assert.strictEqual(o.hostname, '10.0.0.5');
        assert.strictEqual(o.port, 3100);
        assert.strictEqual(o.path, '/purge');
        assert.strictEqual(o.method, 'POST');
    });

    test('it presents this node\'s CN=backend identity and verifies the gateway against the cluster CA', () => {
        const o = gatewayPurgeOptions(cfg, { host: '10.0.0.5', port: 3100 }, 42);
        assert.strictEqual(String(o.ca), 'CA');
        assert.strictEqual(String(o.key), 'KEY');
        assert.strictEqual(String(o.cert), 'CERT');
        assert.strictEqual(o.rejectUnauthorized, true, 'never disable verification on the cluster channel');
    });

    test('no shared secret travels on this leg — the certificate IS the authorization', () => {
        const o = gatewayPurgeOptions(cfg, { host: '10.0.0.5', port: 3100 }, 42);
        assert.strictEqual(o.headers['x-revalidate-secret'], undefined);
    });

    test('unreadable cluster material returns null so the caller can degrade to TTL', () => {
        const broken = { ...cfg, mtls: { ...cfg.mtls, cert: path.join(dir, 'does-not-exist.crt') } };
        assert.strictEqual(gatewayPurgeOptions(broken, { host: '10.0.0.5', port: 3100 }, 42), null);
    });
});
