/**
 * HOST RECONNAISSANCE via `os` is denied to plugins.
 *
 * `os` grants no fs/network/process capability, so it was handed to plugins raw. But its RECON surface
 * undercuts the sandbox's own SSRF defense: the egress guard blocks a network-granted plugin from
 * reaching 169.254.169.254 / RFC1918 / loopback precisely so it cannot talk to internal hosts — and then
 * `os.networkInterfaces()` handed an UNGRANTED plugin the full internal-IP map for free (a ready target
 * list, exfiltrable over any channel). `userInfo()`/`hostname()`/`homedir()` likewise disclosed the
 * service account and host identity. Found by red-teaming the real fork; this pins the fix.
 *
 * The recon methods are scrubbed for plugin context; everything a plugin legitimately branches on
 * (platform / arch / cpus / memory / tmpdir …) passes straight through. Core context is untouched.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { installSecureRequire } = require('../core/secure-require');
const { runWithContext } = require('../core/plugin-context');

installSecureRequire();

const SLUG = 'sandbox-os-recon-probe';
const asPlugin = (fn: () => any) => runWithContext(SLUG, fn);

describe('os recon — scrubbed for plugins', () => {
    test('networkInterfaces returns only loopback, never the real NICs', () => {
        const ifaces = asPlugin(() => require('os').networkInterfaces());
        const names = Object.keys(ifaces);
        assert.deepStrictEqual(names, ['lo'], `internal interfaces leaked: ${names.join(', ')}`);
        assert.strictEqual(ifaces.lo[0].address, '127.0.0.1');
        // No entry may carry a non-loopback address.
        for (const list of Object.values<any>(ifaces)) {
            for (const a of list) assert.ok(a.internal === true && /^127\.|^::1$/.test(a.address), `leaked ${a.address}`);
        }
    });

    test('userInfo does not disclose the service account', () => {
        const u = asPlugin(() => require('os').userInfo());
        assert.strictEqual(u.username, 'sandbox');
        assert.strictEqual(u.uid, -1);
        assert.notStrictEqual(u.username, require('os').userInfo().username, 'the REAL username leaked through');
    });

    test('hostname is neutralised', () => {
        assert.strictEqual(asPlugin(() => require('os').hostname()), 'sandbox');
    });

    test('setPriority (host process control) is denied', () => {
        assert.throws(() => asPlugin(() => require('os').setPriority(0, 0)), /not permitted|sandbox|Security/i);
    });

    test('benign info a plugin legitimately uses still passes through', () => {
        asPlugin(() => {
            const os = require('os');
            assert.strictEqual(os.platform(), process.platform, 'platform must be real');
            assert.strictEqual(os.arch(), process.arch, 'arch must be real');
            assert.ok(Array.isArray(os.cpus()) && os.cpus().length > 0, 'cpus must be real');
            assert.ok(typeof os.totalmem() === 'number' && os.totalmem() > 0, 'totalmem must be real');
            assert.ok(typeof os.tmpdir() === 'string' && os.tmpdir().length > 0, 'tmpdir must be real');
            assert.ok(typeof os.uptime() === 'number', 'uptime must be real');
        });
    });

    test('CORE context is unaffected — the real interfaces are returned outside plugin context', () => {
        // No runWithContext: this is core. It must see the genuine module. (The require() facade is
        // context-gated; the isolate-only singleton scrub is never installed on this main-thread test.)
        const real = require('os').networkInterfaces();
        assert.ok(Object.keys(real).length >= 1);
        // At least one real host has more than just a fabricated single loopback entry, but don't assume
        // the CI runner's topology — just assert we did NOT get the scrubbed shape.
        const onlyFakeLoopback = Object.keys(real).length === 1 && real.lo && real.lo.length === 1 && real.lo[0].mac === '00:00:00:00:00:00';
        assert.strictEqual(onlyFakeLoopback, false, 'core got the scrubbed os, not the real one');
    });
});
