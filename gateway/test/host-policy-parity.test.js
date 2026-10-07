'use strict';
/**
 * ONE HOST GRAMMAR, TWO PROCESSES.
 *
 * The backend decides which addresses the site answers (backend/src/core/host-policy.js); the gateway
 * makes the same decision at the edge. If the two parsed a Host header differently, a value one of them
 * accepts and the other reads as a different host is a bypass (a parser differential). So the gateway
 * does not re-implement anything: gateway/src/host-policy.js is a BYTE-IDENTICAL copy of the backend
 * module (the gateway can be deployed without a backend/ tree, so it cannot simply require it).
 *
 * This test is what keeps the copy honest:
 *   1. the two files are byte for byte the same;
 *   2. the copy needs nothing but Node built-ins, so it loads in the gateway's own install;
 *   3. the gateway copy passes every vector in contracts/host-policy-vectors.v1.json — the same file
 *      backend/src/tests/host-policy.test.ts runs.
 *
 * To change the grammar: add the vector first, change backend/src/core/host-policy.js, then copy it over
 * this one (`cp backend/src/core/host-policy.js gateway/src/host-policy.js`).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const REPO_ROOT = path.resolve(__dirname, '../..');
const GATEWAY_COPY = path.join(REPO_ROOT, 'gateway', 'src', 'host-policy.js');
const BACKEND_COPY = path.join(REPO_ROOT, 'backend', 'src', 'core', 'host-policy.js');

const hp = require('../src/host-policy');
const VECTORS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'host-policy-vectors.v1.json'), 'utf8'));
const VECTOR_NOW = Date.parse('2026-10-06T00:00:00Z');

function fakeReq(v) {
    const headers = Object.assign({}, v.headers || {});
    const rawHeaders = [];
    for (const [name, value] of Object.entries(headers)) rawHeaders.push(name, String(value));
    return {
        headers,
        rawHeaders,
        socket: {
            remoteAddress: v.remoteAddress,
            authorized: v.authorized === true,
            encrypted: v.encrypted === true,
            getPeerCertificate: () => (v.peerCN ? { subject: { CN: v.peerCN } } : {}),
        },
    };
}

function vectorPolicy(name) {
    const spec = VECTORS.policies[name];
    assert.ok(spec, `unknown vector policy ${name}`);
    return hp.buildPolicy({ config: spec.config, env: spec.env, nodeEnv: spec.nodeEnv, ownAddresses: () => new Set(spec.ownAddresses) });
}

test('gateway/src/host-policy.js is byte-identical to backend/src/core/host-policy.js', () => {
    const gateway = fs.readFileSync(GATEWAY_COPY);
    const backend = fs.readFileSync(BACKEND_COPY);
    assert.ok(
        gateway.equals(backend),
        'The gateway copy of the host parser has drifted from the backend. Make the change in ' +
        'backend/src/core/host-policy.js and copy that file over gateway/src/host-policy.js — two ' +
        'different parsers for one Host header is how a host check gets bypassed.',
    );
});

test('the parser needs only Node built-ins (it must load in the gateway\'s own install)', () => {
    const source = fs.readFileSync(GATEWAY_COPY, 'utf8');
    const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.ok(required.length > 0, 'expected the module to require something (net, os)');
    for (const name of required) {
        assert.ok(builtinModules.includes(name.replace(/^node:/, '')), `host-policy.js requires '${name}', which is not a Node built-in`);
    }
});

test('vectors: parseHost', () => {
    for (const v of VECTORS.parseHost.accept) {
        assert.deepStrictEqual(hp.parseHost(v.in), { hostname: v.hostname, port: v.port, kind: v.kind }, `parseHost(${JSON.stringify(v.in)})`);
        assert.deepStrictEqual(hp.parseHost(hp.serialize(hp.parseHost(v.in))), hp.parseHost(v.in), `round trip of ${JSON.stringify(v.in)}`);
    }
    for (const v of VECTORS.parseHost.reject) {
        assert.strictEqual(hp.parseHost(v.in), null, `parseHost(${JSON.stringify(v.in)}) must be null: ${v.why}`);
    }
});

test('vectors: parseSiteUrl', () => {
    for (const v of VECTORS.parseSiteUrl.accept) {
        assert.deepStrictEqual(
            hp.parseSiteUrl(v.in),
            { origin: v.origin, scheme: v.scheme, hostname: v.hostname, port: v.port, kind: v.kind },
            `parseSiteUrl(${JSON.stringify(v.in)})`,
        );
    }
    for (const v of VECTORS.parseSiteUrl.reject) {
        assert.strictEqual(hp.parseSiteUrl(v.in), null, `parseSiteUrl(${JSON.stringify(v.in)}) must be null: ${v.why}`);
    }
});

test('vectors: ownAddresses', () => {
    assert.deepStrictEqual([...hp.addressesFromInterfaces(VECTORS.ownAddresses.interfaces)].sort(), [...VECTORS.ownAddresses.expect].sort());
});

test('vectors: compileTrustProxy', () => {
    for (const v of VECTORS.compileTrustProxy) {
        const isTrusted = hp.compileTrustProxy(v.setting);
        assert.strictEqual(isTrusted !== null, v.compiles, `compileTrustProxy(${JSON.stringify(v.setting)})`);
        for (const [peer, expected] of Object.entries(v.peers || {})) {
            assert.strictEqual(isTrusted(peer), expected, `${JSON.stringify(v.setting)} trusts ${peer}?`);
        }
    }
});

test('vectors: policy entries', () => {
    for (const v of VECTORS.policyEntries) {
        const entry = vectorPolicy(v.policy)[v.table].get(v.hostname);
        assert.ok(entry, `${v.policy}.${v.table} has ${v.hostname}`);
        for (const [field, expected] of Object.entries(v.expect)) {
            assert.deepStrictEqual(entry[field], expected, `${v.policy}.${v.table}[${v.hostname}].${field}`);
        }
    }
});

test('vectors: classify', () => {
    for (const v of VECTORS.classify) {
        const p = hp.parseHost(v.host);
        assert.ok(p, `vector host ${v.host} parses`);
        const verdict = hp.classify(p, vectorPolicy(v.policy), { proxied: v.proxied === true, now: v.now ? Date.parse(v.now) : VECTOR_NOW });
        assert.strictEqual(verdict.cls, v.cls, `${v.policy}: ${v.host}${v.proxied ? ' (proxied)' : ''}`);
        if (v.reason) assert.strictEqual(verdict.reason, v.reason, `${v.policy}: ${v.host} reason`);
    }
});

test('vectors: requestAuthority', () => {
    for (const v of VECTORS.requestAuthority) {
        const got = hp.requestAuthority(fakeReq(v.req), { trustProxy: v.trustProxy });
        const e = v.expect;
        if ('host' in e) assert.strictEqual(got.parsed ? hp.serialize(got.parsed) : null, e.host, `${v.name}: host`);
        if ('absent' in e) assert.strictEqual(got.absent, e.absent, `${v.name}: absent`);
        if ('raw' in e) assert.strictEqual(got.raw, e.raw, `${v.name}: raw`);
        if ('hop' in e) assert.strictEqual(got.hop, e.hop, `${v.name}: hop`);
        if ('source' in e) assert.strictEqual(got.source, e.source, `${v.name}: source`);
        if ('proxied' in e) assert.strictEqual(got.proxied, e.proxied, `${v.name}: proxied`);
    }
});

test('vectors: trustedScheme', () => {
    for (const v of VECTORS.trustedScheme) {
        assert.strictEqual(hp.trustedScheme(fakeReq(v.req), { trustProxy: v.trustProxy }), v.expect, v.name);
    }
});

test('vectors: ambiguousPath', () => {
    for (const v of VECTORS.ambiguousPath.ambiguous) assert.strictEqual(hp.isAmbiguousPath(v.in), true, `${v.in}: ${v.why}`);
    for (const v of VECTORS.ambiguousPath.plain) assert.strictEqual(hp.isAmbiguousPath(v.in), false, `${v.in}: ${v.why}`);
});

test('vectors: dotSegments', () => {
    for (const v of VECTORS.dotSegments.dotted) assert.strictEqual(hp.hasDotSegments(v.in), true, `${v.in}: ${v.why}`);
    for (const v of VECTORS.dotSegments.plain) assert.strictEqual(hp.hasDotSegments(v.in), false, `${v.in}: ${v.why}`);
    // Every dotted path is ambiguous too: the edge's rule is a subset of the gate's.
    for (const v of VECTORS.dotSegments.dotted) assert.strictEqual(hp.isAmbiguousPath(v.in), true, v.in);
});
