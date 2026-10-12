/**
 * THE GUARDED dns MODULE, ATTACKED THROUGH THE OBJECT MODEL — not just through its names.
 *
 * secure-require hands a network-granted plugin a GUARDED dns from egress-guard, never the real module:
 * the raw c-ares resolver surface (resolve-x / Resolver / setServers) does DNS over its OWN native sockets,
 * below both egress chokepoints (the connect-time IP guard and validatingLookup), so it would let a
 * plugin resolve any name — exfiltration — under an allowlist or deny-all, and probe internal ip:port.
 *
 * The guard used to be a Proxy with ONLY a `get` trap, and a get-only Proxy forwards every OTHER
 * essential-internal method to the real target. So the deny/governed logic in `get` was bypassable:
 *   · Object.getOwnPropertyDescriptor(dns, 'resolveTxt'|'Resolver'|'reverse').value  →  the REAL member
 *   · Object.getOwnPropertyDescriptor(dns, 'promises').get()                         →  the REAL dns.promises
 *     (then its resolve* the same way)
 *   · a resolver Node ADDS later (dns.resolveTlsa, Node 22.15 / 23.9) is named by no deny-LIST, so even the `get`
 *     trap forwarded it raw.
 * Recovering any of these gives a working raw resolver that ignores the egress policy entirely.
 *
 * The fix rebuilds the guarded dns as a FROZEN allow-set object that never references the real module as
 * a Proxy target, DEFAULT-DENY (every non-governed function is a clear throwing stub). These tests prove
 * no read path yields a usable original. Offline and deterministic: dns.lookup is stubbed, and the only
 * thing that may refuse the governed path is the policy under test.
 */
import { test } from 'node:test';
import assert from 'node:assert';

const eg = require('../core/egress-guard');
const realDns = require('dns');

const PUBLIC_TEST_IP = '203.0.113.10'; // TEST-NET-3: public to the guard, routed nowhere
function stubLookup() {
    const orig = realDns.lookup;
    const queried: string[] = [];
    realDns.lookup = function (host: any, opts: any, cb: any) {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        queried.push(String(host));
        const list = [{ address: PUBLIC_TEST_IP, family: 4 }];
        process.nextTick(() => (opts && opts.all ? cb(null, list) : cb(null, PUBLIC_TEST_IP, 4)));
    };
    for (const sym of Object.getOwnPropertySymbols(orig)) realDns.lookup[sym] = orig[sym];
    return { queried, restore: () => { realDns.lookup = orig; } };
}

// Read a member the way an attacker would recover it past the `get` trap.
function viaDescriptor(obj: any, prop: string): any {
    const d = Object.getOwnPropertyDescriptor(obj, prop);
    if (!d) return undefined;
    return 'value' in d ? d.value : (typeof d.get === 'function' ? d.get.call(obj) : undefined);
}

// A recovered member is CONTAINED only if invoking it throws the sandbox's clear denial. The REAL
// resolver would instead kick off a c-ares query and return without throwing synchronously — which is
// exactly the discriminator these assertions rest on.
function callIsDenied(fn: any): boolean {
    if (typeof fn !== 'function') return true; // nothing usable recovered
    try { fn('example.com', () => { /* */ }); return false; } // ran → NOT contained
    catch (e: any) { return /not permitted|blocked/i.test(String(e && e.message)); }
}

const DENIED = ['resolve', 'resolve4', 'resolveTxt', 'resolveMx', 'reverse', 'Resolver', 'setServers', 'getServers'];

test('the guarded dns is a frozen object, not a view over the real module', () => {
    const dns = eg.getGuardedModule('dns');
    assert.strictEqual(Object.isFrozen(dns), true, 'the guarded dns must be frozen');
    assert.strictEqual(Object.getPrototypeOf(dns), Object.prototype, 'its prototype must not be the real module');
    // Not the real module, and nothing it owns is the real module either.
    assert.notStrictEqual(dns, realDns);
    for (const k of Object.getOwnPropertyNames(dns)) {
        assert.notStrictEqual(dns[k], realDns, `own member '${k}' must not be the real dns module`);
    }
});

test('no resolver member is recoverable as a working function — not via get, getOwnPropertyDescriptor, or new', () => {
    const dns = eg.getGuardedModule('dns');
    for (const name of DENIED) {
        // (a) the plain read
        assert.ok(callIsDenied(dns[name]), `dns.${name} (get) must be a denying stub, not a live resolver`);
        // (b) the descriptor recovery that a get-only Proxy leaked
        assert.ok(callIsDenied(viaDescriptor(dns, name)), `Object.getOwnPropertyDescriptor(dns, '${name}') must not hand back a live resolver`);
        // the recovered member must never be the real one
        assert.notStrictEqual(viaDescriptor(dns, name), realDns[name], `descriptor for '${name}' leaked the real member`);
    }
    // `new dns.Resolver()` (recovered via descriptor) must throw, not construct a raw c-ares resolver.
    const Resolver = viaDescriptor(dns, 'Resolver');
    assert.throws(() => new Resolver(), /not permitted|blocked|not a constructor/i, 'a raw c-ares Resolver must not be constructible');
});

// The members the facade deliberately lets through: the two egress-judged lookups and the ordering helpers.
const NOT_DENIED = new Set(['lookup', 'lookupService', 'getDefaultResultOrder', 'setDefaultResultOrder']);

test('EVERY other function this Node\'s dns has is denied — named in a list or not (no deny-list rot)', () => {
    // Enumerated from the running Node rather than written down, so a resolver a newer Node adds
    // (dns.resolveTlsa, Node 22.15 / 23.9, is named by no list) is covered the day it exists, and a Node that lacks
    // one simply has nothing to check for it.
    for (const [label, real, guarded] of [
        ['dns', realDns, eg.getGuardedModule('dns')],
        ['dns.promises', realDns.promises, viaDescriptor(eg.getGuardedModule('dns'), 'promises')],
        ['dns/promises', realDns.promises, eg.getGuardedModule('dns/promises')],
    ] as Array<[string, any, any]>) {
        const fns = Object.getOwnPropertyNames(real).filter((k) => typeof real[k] === 'function' && !NOT_DENIED.has(k));
        assert.ok(fns.includes('resolveTxt') && fns.includes('Resolver'), `precondition: ${label} exposes the resolver surface`);
        for (const k of fns) {
            assert.ok(callIsDenied(guarded[k]), `${label}.${k} (get) must be denied`);
            assert.ok(callIsDenied(viaDescriptor(guarded, k)), `${label}.${k} (descriptor) must be denied`);
            assert.notStrictEqual(viaDescriptor(guarded, k), real[k], `${label}.${k} leaked the real member`);
        }
    }
});

test('dns.promises cannot be used to recover a raw resolver either', () => {
    const dns = eg.getGuardedModule('dns');
    const promises = viaDescriptor(dns, 'promises');
    assert.notStrictEqual(promises, realDns.promises, 'the promises accessor leaked the real dns.promises');
    assert.strictEqual(Object.isFrozen(promises), true, 'guarded dns.promises must be frozen');
    for (const name of ['resolveTxt', 'Resolver', 'reverse']) {
        const raw = viaDescriptor(promises, name);
        assert.notStrictEqual(raw, realDns.promises[name], `dns.promises descriptor leaked the real '${name}'`);
    }
    // require('dns/promises') is the same guard, not the real promises object.
    const dnsP = eg.getGuardedModule('dns/promises');
    assert.strictEqual(Object.isFrozen(dnsP), true);
    assert.notStrictEqual(dnsP, realDns.promises);
    assert.strictEqual(typeof dnsP.lookup, 'function', 'dns/promises keeps the governed lookup');
    assert.notStrictEqual(viaDescriptor(dnsP, 'resolveTxt'), realDns.promises.resolveTxt, 'dns/promises leaked resolveTxt');
});

test('the one legitimate capability — governed dns.lookup — still works and still obeys the allowlist', async () => {
    const r = stubLookup();
    eg.setAllowedHosts(['vendor.example']);
    try {
        const dns = eg.getGuardedModule('dns');
        // Allowlisted name resolves (callback + util.promisify shapes both survive the rebuild).
        const addr = await new Promise<any>((resolve, reject) => dns.lookup('api.vendor.example', (e: any, a: any) => (e ? reject(e) : resolve(a))));
        assert.strictEqual(addr, PUBLIC_TEST_IP);
        assert.deepStrictEqual(await require('util').promisify(dns.lookup)('api.vendor.example'), { address: PUBLIC_TEST_IP, family: 4 });
        // Off-allowlist name is refused BEFORE the resolver is ever asked.
        const before = r.queried.length;
        const err = await new Promise<any>((resolve) => dns.lookup('secret.attacker.example', (e: any) => resolve(e)));
        assert.match(String(err && err.message), /blocked/, 'off-allowlist lookup must be refused');
        assert.deepStrictEqual(r.queried.slice(before), [], 'no off-allowlist name reached the resolver');
    } finally {
        eg.setAllowedHosts(null);
        r.restore();
    }
});
