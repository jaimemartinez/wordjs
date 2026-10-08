/**
 * THE PLUGIN POLICY STORE: what lands in memory, and what a child is spawned with, when reads and writes
 * of `plugin_grants` / `plugin_egress_hosts` overlap or fail.
 *
 * The in-memory maps in core/plugin-permissions.ts are what the host gates read and what an isolate's cfg
 * is built from, so the ORDER in which loads and writes reach them is the policy. Each case below forces
 * one interleaving (by holding a read or a write at a gate) or one database failure, and asserts the
 * outcome where it matters — what a real child, spawned afterwards, can do (fixtures/policy-probe-plugin):
 *   · a write's DB commit and a reload overlapping must never leave the OLD value in memory — the
 *     permission/egress routes respawn the child right after the write, from memory;
 *   · a read-modify-write must not write back a blob read through a stale cache (a peer's change lost);
 *   · a failed database read must not be mistaken for an empty policy (no grants / allow-all egress).
 * The shared ACTIVE SET gets the same two checks (its read-modify-write, and the reconcile that stops a
 * plugin no node has active without ever stopping one whose activation is still in flight here).
 */
process.env.NODE_ENV = 'production'; // the routes regenerate frontend registries outside production

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-policy-order-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const cache = require('../core/cache');
const express = require('express');
const request = require('supertest');
const roles = require('../core/roles');
const options = require('../core/options');
const perms = require('../core/plugin-permissions');
const hooks = require('../core/hooks');
const { setApp } = require('../core/appRegistry');
const iso = require('../core/plugin-isolate');
const pluginsRouter = require('../routes/plugins');
const { writeProbePlugin, probeFilterName } = require('./fixtures/policy-probe-plugin');

const SLUG = `wjs-order-${process.pid}`;
const app = express();
app.use(express.json());
app.use('/api/v1/plugins', pluginsRouter);
let adminToken = '';
let entry = '';
const cleanupDirs: string[] = [];
const post = (url: string, body: any) => request(app).post(url).set('Authorization', `Bearer ${adminToken}`).send(body);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(): Promise<any> {
    const out = await hooks.applyFilters(probeFilterName(SLUG), '');
    return out ? JSON.parse(out) : null;
}
async function respawn(): Promise<any> {
    if (iso.isIsolated(SLUG)) await iso.reloadIsolatedPlugin(SLUG);
    else await iso.loadIsolatedPlugin(SLUG, entry);
    return probe();
}

/** A gate: `wait()` blocks until `open()`; `entered` resolves the first time something waits on it. */
function gate() {
    let open!: () => void;
    let entered!: () => void;
    const opened = new Promise<void>((r) => { open = r; });
    const enteredP = new Promise<void>((r) => { entered = r; });
    return { open, entered: enteredP, wait: () => { entered(); return opened; } };
}

/** Hold the WRITE of option `name` (the DB commit) at a gate — once. Policy writes go through persistOption. */
function holdWrite(name: string) {
    const g = gate();
    const orig = options.persistOption;
    let armed = true;
    options.persistOption = async (n: string, ...rest: any[]) => {
        if (armed && n === name) { armed = false; await g.wait(); }
        return orig(n, ...rest);
    };
    return { ...g, restore: () => { options.persistOption = orig; } };
}

/**
 * Hold the `updated_option` hook fan-out of option `name` — once — the way a slow isolated plugin that
 * subscribed to it does (each subscriber is awaited in turn, up to its RPC timeout).
 */
function holdFanOut(name: string) {
    const g = gate();
    let armed = true;
    const listener = async (n: string) => {
        if (armed && n === name) { armed = false; await g.wait(); }
    };
    hooks.addAction('updated_option', listener);
    return { ...g, restore: () => { g.open(); hooks.removeAction('updated_option', listener); } };
}

/** Resolve with `p`'s value, or with TIMED_OUT if it has not settled within `ms`. */
const TIMED_OUT = 'timed out';
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    return Promise.race([p, new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), ms))]);
}

/** The console.warn lines matching `re` printed while `fn` runs. */
async function warnsDuring(re: RegExp, fn: () => Promise<void>): Promise<string[]> {
    const seen: string[] = [];
    const orig = console.warn;
    console.warn = (...args: any[]) => {
        const line = require('util').format(...args);
        if (re.test(line)) seen.push(line);
        orig.apply(console, args);
    };
    try { await fn(); } finally { console.warn = orig; }
    return seen;
}

/**
 * Let the next READ of option `name` hit the database now, but hand its result back only at the gate.
 * Every reader is wrapped — the cached one and the fresh one the policy loaders and writers use
 * (readStoredOption; getOptionFresh reads through it) — and only the first read is held.
 */
function holdRead(name: string) {
    const g = gate();
    const orig = { getOption: options.getOption, getOptionFresh: options.getOptionFresh, readStoredOption: options.readStoredOption };
    let armed = true;
    const wrap = (fn: any) => async (n: string, ...rest: any[]) => {
        if (armed && n === name) { armed = false; const v = await fn(n, ...rest); await g.wait(); return v; }
        return fn(n, ...rest);
    };
    options.getOption = wrap(orig.getOption);
    options.getOptionFresh = wrap(orig.getOptionFresh);
    options.readStoredOption = wrap(orig.readStoredOption);
    return { ...g, restore: () => { Object.assign(options, orig); } };
}

/** Make the database fail every read of the given option names (the L1 is dropped so the read happens). */
function failReads(names: string[]) {
    const drv = database.getDbAsync();
    const orig = drv.get;
    drv.get = function (sql: string, params: any[], ...rest: any[]) {
        if (/FROM options WHERE option_name/i.test(String(sql)) && Array.isArray(params) && names.includes(params[0])) {
            return Promise.reject(new Error('simulated database outage'));
        }
        return orig.call(this, sql, params, ...rest);
    };
    cache._l1.clear();
    return { restore: () => { drv.get = orig; } };
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await roles.loadRoles();
    const User = require('../models/User');
    const admin = await User.create({ username: 'orderadmin', email: 'orderadmin@example.com', password: 'correct-horse-battery-9', role: 'administrator' });
    adminToken = jwt.sign({ userId: admin.id, username: 'orderadmin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
    setApp(app);
    entry = writeProbePlugin(pluginsRouter.resolveSafePluginDir(SLUG), SLUG);
    await perms.loadGrants();
}, { timeout: 60000 });

after(async () => {
    for (const s of iso.listIsolates()) { try { iso.unloadIsolatedPlugin(s); } catch { /* */ } }
    for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    try { fs.rmSync(pluginsRouter.resolveSafePluginDir(SLUG), { recursive: true, force: true }); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
});

// FIRST, while no egress load has ever succeeded in this process.
test('a database error while loading the egress policy at boot leaves it NOT loaded: the child spawns deny-all, not allow-all', async () => {
    await perms.setGrants(SLUG, ['network']);
    const f = failReads(['plugin_egress_hosts']);
    try {
        await perms.loadEgressHosts();
        assert.strictEqual(perms.isEgressPolicyLoaded(), false, 'an unreadable policy is not a loaded, empty policy');
        const p = await respawn();
        assert.strictEqual(p.network, true, 'precondition: the child holds the network grant');
        assert.deepStrictEqual([p.a, p.b], ['blocked', 'blocked'], 'fail closed: no public host is reachable');
    } finally {
        f.restore();
    }
    await perms.loadEgressHosts();
    assert.strictEqual(perms.isEgressPolicyLoaded(), true);
});

test('a database error on a RE-read keeps the last-known-good grants and allowlist in force', async () => {
    await perms.setGrants(SLUG, ['network']);
    await perms.setEgressAllowlist(SLUG, ['192.0.2.10']);
    await perms.loadGrants();
    await perms.loadEgressHosts();
    const f = failReads(['plugin_grants', 'plugin_egress_hosts']);
    try {
        await perms.loadGrants();
        await perms.loadEgressHosts();
        assert.deepStrictEqual(perms.getGrants(SLUG), ['network']);
        assert.deepStrictEqual(perms.getEgressAllowlist(SLUG), ['192.0.2.10']);
        const p = await respawn();
        assert.deepStrictEqual([p.network, p.a, p.b], [true, 'allowed', 'blocked'],
            'a transient read failure must neither strip the grant nor widen the allowlist to allow-all');
    } finally {
        f.restore();
    }
});

test('POST /permissions: a reload landing while the revoke is being written cannot resurrect the network, and the respawned child has none', async () => {
    await perms.setGrants(SLUG, ['network']);
    await perms.setEgressAllowlist(SLUG, []);
    assert.strictEqual((await respawn()).network, true, 'precondition');
    const w = holdWrite('plugin_grants');
    try {
        const res = post(`/api/v1/plugins/${SLUG}/permissions`, { granted: [] }).then((r: any) => r);
        await w.entered;                       // the revoke is between "decided" and "committed"
        const reload = perms.loadGrants();     // e.g. a peer's option-changed broadcast arrives now
        await sleep(50);
        w.open();
        const r = await res;
        await reload;
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.reloaded, true, 'the route respawned the child');
        assert.deepStrictEqual(perms.getGrants(SLUG), [], 'memory still holds the revoked grant');
        assert.strictEqual((await probe()).network, false, 'the child the route respawned still holds the revoked network');
    } finally {
        w.restore();
    }
});

test('POST /egress-hosts: a reload landing while the new allowlist is being written cannot resurrect the old one', async () => {
    await perms.setGrants(SLUG, ['network']);
    await perms.setEgressAllowlist(SLUG, ['192.0.2.20']);
    assert.deepStrictEqual(((p) => [p.a, p.b])(await respawn()), ['blocked', 'allowed'], 'precondition');
    const w = holdWrite('plugin_egress_hosts');
    try {
        const res = post(`/api/v1/plugins/${SLUG}/egress-hosts`, { hosts: ['192.0.2.10'] }).then((r: any) => r);
        await w.entered;
        const reload = perms.loadEgressHosts();
        await sleep(50);
        w.open();
        const r = await res;
        await reload;
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(perms.getEgressAllowlist(SLUG), ['192.0.2.10']);
        const p = await probe();
        assert.deepStrictEqual([p.a, p.b], ['allowed', 'blocked'], 'the respawned child runs the OLD allowlist');
    } finally {
        w.restore();
    }
});

test('a load that READ before a write committed and applies after it does not put the old grants back', async () => {
    await perms.setGrants(SLUG, ['network']);
    const g = holdRead('plugin_grants');
    try {
        const load = perms.loadGrants();      // reads ['network'] now, applies it at the gate
        await g.entered;
        const write = perms.setGrants(SLUG, []);
        await sleep(50);
        g.open();
        await Promise.all([load, write]);
        assert.deepStrictEqual(perms.getGrants(SLUG), [], 'the stale read was applied over the newer write');
        assert.strictEqual((await respawn()).network, false);
    } finally {
        g.restore();
    }
});

test('removeGrants: a reload overlapping the uninstall cannot resurrect the removed grants', async () => {
    await perms.setGrants(SLUG, ['network']);
    const w = holdWrite('plugin_grants');
    try {
        const removal = perms.removeGrants(SLUG);
        await w.entered;
        const reload = perms.loadGrants();
        await sleep(50);
        w.open();
        await Promise.all([removal, reload]);
        assert.deepStrictEqual(perms.getGrants(SLUG), [], 'an uninstalled plugin still holds grants in memory');
    } finally {
        w.restore();
    }
});

test('setGrants reads the blob it rewrites from the database, not a stale cache: a peer\'s change to ANOTHER plugin survives', async () => {
    await perms.setGrants(SLUG, []);
    await options.getOption('plugin_grants', {}); // this node's L1 now holds the blob
    // Another node grants a different plugin. Its cache-invalidation broadcast never reached us.
    const blob = await options.getOptionFresh('plugin_grants', {});
    blob['peer-plugin'] = ['database:read'];
    await database.dbAsync.run('UPDATE options SET option_value = ? WHERE option_name = ?', [JSON.stringify(blob), 'plugin_grants']);

    await perms.setGrants(SLUG, ['network']);
    const stored = await options.getOptionFresh('plugin_grants', {});
    assert.deepStrictEqual(stored['peer-plugin'], ['database:read'], 'the peer\'s grant was overwritten by a stale blob');
    assert.deepStrictEqual(stored[SLUG], ['network']);
});

test('a policy write that cannot take the cluster lease is refused, and nothing changes', async () => {
    await perms.setGrants(SLUG, ['network']);
    const distLock = require('../core/dist-lock');
    const orig = distLock.acquireBlocking;
    distLock.acquireBlocking = async () => ({ held: false, release: async () => { } });
    try {
        await assert.rejects(() => perms.setGrants(SLUG, []), /lock/i);
        await assert.rejects(() => perms.setEgressAllowlist(SLUG, ['192.0.2.10']), /lock/i);
    } finally {
        distLock.acquireBlocking = orig;
    }
    assert.deepStrictEqual(perms.getGrants(SLUG), ['network'], 'memory changed although the write was refused');
    const stored = await options.getOptionFresh('plugin_grants', {});
    assert.deepStrictEqual(stored[SLUG], ['network'], 'the database changed although the write was refused');
});

// ── Persist-first means memory IMMEDIATELY after the commit, not after the hook fan-out ───────────────

async function until(pred: () => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await sleep(20); }
    return pred();
}

test('a revoked grant is out of force on the writing node while plugins are still being told about it', async () => {
    await perms.setGrants(SLUG, ['database:write']);
    assert.strictEqual(perms.isGranted(SLUG, 'database', 'write'), true, 'precondition');
    const h = holdFanOut('plugin_grants');
    try {
        const revoke = perms.setGrants(SLUG, []);
        await h.entered; // committed; the updated_option subscribers are being told, slowly
        assert.strictEqual(perms.isGranted(SLUG, 'database', 'write'), false,
            'the revoked database:write still passes the host gate while the hook fan-out runs');
        h.open();
        await revoke;
    } finally {
        h.restore();
    }
});

test('twin: a narrowed egress allowlist is in force on the writing node while plugins are still being told about it', async () => {
    await perms.setGrants(SLUG, ['network']);
    await perms.setEgressAllowlist(SLUG, []);
    const h = holdFanOut('plugin_egress_hosts');
    try {
        const narrow = perms.setEgressAllowlist(SLUG, ['192.0.2.10']);
        await h.entered;
        assert.deepStrictEqual(perms.getEgressAllowlist(SLUG), ['192.0.2.10'],
            'the host still allows every public host (the old allowlist) while the hook fan-out runs');
        h.open();
        await narrow;
    } finally {
        h.restore();
    }
});

test('twin: a slow hook fan-out holds neither the cluster policy lease nor this node\'s re-syncs and later writes', async () => {
    await perms.setGrants(SLUG, ['network']);
    const distLock = require('../core/dist-lock');
    const origAcquire = distLock.acquireBlocking;
    let leasesHeld = 0;
    distLock.acquireBlocking = async (name: string, o: any) => {
        const lease = await origAcquire(name, o);
        if (name !== 'wordjs:plugin-policy' || !lease.held) return lease;
        leasesHeld += 1;
        return { ...lease, release: async () => { leasesHeld -= 1; return lease.release(); } };
    };
    const h = holdFanOut('plugin_grants');
    try {
        const revoke = perms.setGrants(SLUG, []);
        await h.entered;
        assert.strictEqual(leasesHeld, 0, 'the policy lease is held while plugins are being told: every other node\'s policy write waits (or times out)');
        assert.notStrictEqual(await within(perms.loadGrants(), 3000), TIMED_OUT, 'a re-sync on this node waits for the hook fan-out');
        const later = perms.setEgressAllowlist(SLUG, ['192.0.2.20']);
        assert.ok(await until(() => perms.getEgressAllowlist(SLUG)[0] === '192.0.2.20', 3000),
            'a later policy write is not applied until the earlier write\'s fan-out finishes');
        h.open();
        await Promise.all([revoke, later]);
        assert.deepStrictEqual(perms.getGrants(SLUG), []);
    } finally {
        h.restore();
        distLock.acquireBlocking = origAcquire;
    }
});

// ── …and the routes act on the CHILD at that point too ───────────────────────────────────────────────
//
// A running child holds what it was spawned with (the network grant, the egress allowlist, the child-side
// fs gate), so the host's memory being current is not enough: the permission and egress-hosts routes have
// to respawn the child — or re-scan it and stop it — as soon as the change is in memory. Each case holds
// the write's `updated_option` fan-out (a slow subscriber) and looks at the child while it is held.

/** Poll the probe until `pred` holds; null = no probe filter registered (no child, or one mid-respawn). */
async function probeUntil(pred: (p: any) => boolean, ms: number): Promise<any> {
    const end = Date.now() + ms;
    let last: any = null;
    while (Date.now() < end) {
        try { last = await probe(); } catch { last = null; }
        if (pred(last)) return last;
        await sleep(50);
    }
    return last;
}

test('POST /permissions: the running child loses a revoked network grant at once, not after every subscriber has been told', async () => {
    await perms.setGrants(SLUG, ['network']);
    await perms.setEgressAllowlist(SLUG, []);
    const before0 = await respawn();
    assert.strictEqual(before0.network, true, 'precondition: the child holds the network grant');
    const h = holdFanOut('plugin_grants');
    try {
        const res = post(`/api/v1/plugins/${SLUG}/permissions`, { granted: [] }).then((r: any) => r);
        await h.entered; // committed and in memory; the updated_option subscribers are still being told
        const p = await probeUntil((x) => !!x && x.spawn !== before0.spawn, 20000);
        assert.ok(p && p.spawn !== before0.spawn, `the child was not respawned while the hook fan-out ran (${JSON.stringify(p)})`);
        assert.strictEqual(p.network, false, 'the respawned child still holds the revoked network');
        h.open();
        const r = await res;
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.reloaded, true);
        assert.strictEqual((await probe()).spawn, p.spawn, 'the route respawned the child a second time after the fan-out');
    } finally {
        h.restore();
    }
});

test('twin: POST /egress-hosts: the running child enforces a switched allowlist at once, not after every subscriber has been told', async () => {
    await perms.loadEgressHosts(); // an allowlist decides, not the deny-all of a policy never loaded
    await perms.setGrants(SLUG, ['network']);
    await perms.setEgressAllowlist(SLUG, ['192.0.2.20']);
    const before0 = await respawn();
    assert.deepStrictEqual([before0.network, before0.a, before0.b], [true, 'blocked', 'allowed'], 'precondition');
    const h = holdFanOut('plugin_egress_hosts');
    try {
        const res = post(`/api/v1/plugins/${SLUG}/egress-hosts`, { hosts: ['192.0.2.10'] }).then((r: any) => r);
        await h.entered;
        const p = await probeUntil((x) => !!x && x.spawn !== before0.spawn, 20000);
        assert.ok(p && p.spawn !== before0.spawn, `the child was not respawned while the hook fan-out ran (${JSON.stringify(p)})`);
        assert.deepStrictEqual([p.a, p.b], ['allowed', 'blocked'], 'the respawned child still runs the old allowlist');
        h.open();
        const r = await res;
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.reloaded, true);
    } finally {
        h.restore();
    }
});

test('twin: an updated_option subscriber that throws neither keeps the old policy in the child nor fails a change that took effect', async () => {
    await perms.loadEgressHosts();
    await perms.setGrants(SLUG, ['network']);
    await perms.setEgressAllowlist(SLUG, ['192.0.2.20']);
    const before0 = await respawn();
    assert.deepStrictEqual([before0.network, before0.a, before0.b], [true, 'blocked', 'allowed'], 'precondition');
    const listener = async (n: string) => {
        if (n === 'plugin_grants' || n === 'plugin_egress_hosts') throw new Error(`subscriber failure on ${n}`);
    };
    hooks.addAction('updated_option', listener);
    try {
        let r: any;
        let warned = await warnsDuring(/subscriber failure on plugin_egress_hosts/, async () => {
            r = await post(`/api/v1/plugins/${SLUG}/egress-hosts`, { hosts: ['192.0.2.10'] });
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        let p = await probe();
        assert.notStrictEqual(p.spawn, before0.spawn, 'the child was not respawned after the allowlist change');
        assert.deepStrictEqual([p.a, p.b], ['allowed', 'blocked'], 'the child still runs the old allowlist');
        assert.strictEqual(warned.length, 1, 'the failing subscriber was not reported');

        const mid = p.spawn;
        warned = await warnsDuring(/subscriber failure on plugin_grants/, async () => {
            r = await post(`/api/v1/plugins/${SLUG}/permissions`, { granted: [] });
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.reloaded, true);
        p = await probe();
        assert.notStrictEqual(p.spawn, mid, 'the child was not respawned after the revoke');
        assert.strictEqual(p.network, false, 'the child still holds the revoked network');
        assert.strictEqual(warned.length, 1, 'the failing subscriber was not reported');
    } finally {
        hooks.removeAction('updated_option', listener);
    }
});

test('twin: POST /permissions: a revoke that condemns an ACTIVE plugin stops its child at once, not after every subscriber has been told', async () => {
    const core = require('../core/plugins');
    const slug = `wjs-order-condemn-${process.pid}`;
    const dir = pluginsRouter.resolveSafePluginDir(slug);
    cleanupDirs.push(dir);
    writeProbePlugin(dir, slug); // its code resolves names, so it needs the network it declares
    try {
        let r = await post(`/api/v1/plugins/${slug}/activate`, {});
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.ok(iso.isIsolated(slug), 'precondition: the plugin runs');
        const h = holdFanOut('plugin_grants');
        try {
            const res = post(`/api/v1/plugins/${slug}/permissions`, { granted: [] }).then((x: any) => x);
            await h.entered;
            assert.ok(await until(() => !iso.isIsolated(slug), 10000),
                'the plugin whose code needs the revoked network kept running while the hook fan-out ran');
            h.open();
            r = await res;
            assert.strictEqual(r.status, 200, JSON.stringify(r.body));
            assert.strictEqual(r.body.deactivated, true, JSON.stringify(r.body));
            assert.strictEqual(await core.isPluginActive(slug), false);
        } finally {
            h.restore();
        }
    } finally {
        try { await core.deactivatePlugin(slug); } catch { /* */ }
    }
});

// ── Grant tokens: one shape on both sides of the store ─────────────────────────────────────────────

test('setGrants does not store a malformed grant token, so re-reading the store neither respawns the child nor warns', async () => {
    await perms.setGrants(SLUG, ['network']);
    await perms.setEgressAllowlist(SLUG, []);
    await perms.setGrants(SLUG, ['network', 'Not A Token', 'database:write']);
    const stored = await options.getOptionFresh('plugin_grants', {});
    assert.deepStrictEqual([...stored[SLUG]].sort(), ['database:write', 'network'], 'a malformed token was persisted');
    await respawn(); // the child is spawned with what memory holds right after the write
    const coherence = require('../core/coherence');
    let respawned: string[] = [];
    const warned = await warnsDuring(/not a token/i, async () => {
        respawned = await coherence.resyncPluginPolicy([SLUG]);
        respawned = respawned.concat(await coherence.resyncPluginPolicy([SLUG]));
    });
    assert.deepStrictEqual(respawned, [], 'a re-read found the child spawned with a policy the store does not hold, and respawned it');
    assert.deepStrictEqual(warned, [], 'every re-read warns about a token the writer itself stored');
});

test('a malformed entry already in the store is reported once per distinct value, not on every re-read', async () => {
    const BAD = `wjs-order-legacy-${process.pid}`;
    const poison = async (name: string, edit: (blob: any) => void) => {
        const blob = await options.getOptionFresh(name, {});
        edit(blob);
        await database.dbAsync.run('UPDATE options SET option_value = ? WHERE option_name = ?', [JSON.stringify(blob), name]);
    };
    // Written by some older version or by hand: a bad grant token, a bad egress host, and a record under a
    // key that may never be one (a magic name), in each blob.
    await poison('plugin_grants', (b) => { b[BAD] = ['database:read', 'BAD TOKEN ONE']; b.constructor = ['database:read']; });
    await poison('plugin_egress_hosts', (b) => { b[BAD] = ['api.example.com', 'http://bad host/']; b.constructor = ['x.example']; });
    try {
        const reread = async (times: number) => { for (let i = 0; i < times; i++) { await perms.loadGrants(); await perms.loadEgressHosts(); } };
        const warned = await warnsDuring(/BAD TOKEN|bad host|unsafe plugin key 'constructor'/i, () => reread(3));
        const count = (re: RegExp) => warned.filter((l) => re.test(l)).length;
        assert.strictEqual(count(/BAD TOKEN ONE/), 1, `the malformed grant token was reported ${count(/BAD TOKEN ONE/)} times in 3 re-reads`);
        assert.strictEqual(count(/bad host/), 1, `the malformed egress host was reported ${count(/bad host/)} times in 3 re-reads`);
        assert.strictEqual(count(/unsafe plugin key 'constructor'.*plugin_grants/), 1, 'the unsafe grant key was not reported exactly once');
        assert.strictEqual(count(/unsafe plugin key 'constructor'.*plugin_egress_hosts/), 1, 'the unsafe egress key was not reported exactly once');
        assert.deepStrictEqual(perms.getGrants(BAD), ['database:read'], 'the well-formed part of the record still loads');
        assert.deepStrictEqual(perms.getEgressAllowlist(BAD), ['api.example.com']);

        // A DIFFERENT malformed value is news, and is reported (once).
        await poison('plugin_grants', (b) => { b[BAD] = ['database:read', 'BAD TOKEN TWO']; });
        const warned2 = await warnsDuring(/BAD TOKEN/i, () => reread(2));
        assert.deepStrictEqual(warned2.map((l) => /BAD TOKEN TWO/.test(l)), [true]);
    } finally {
        await poison('plugin_grants', (b) => { delete b[BAD]; delete b.constructor; });
        await poison('plugin_egress_hosts', (b) => { delete b[BAD]; delete b.constructor; });
        await perms.loadGrants();
        await perms.loadEgressHosts();
    }
});

// ── Grant-on-activate seeds a plugin that holds no grants an administrator decided ───────────────────
//
// From 1.12.12 on, every in-place update of a plugin with no grant record stored an empty one for it, so
// on an existing site an empty record alone does not mean "an administrator revoked everything" — and
// reading it that way started such a plugin, on its first activation, with none of what it declares. An
// administrator's revoke of every grant, though, is recorded as their decision (ADMIN_DECISIONS_MARKER,
// written with the grants by POST /permissions and by the activation's own seed), and must survive a
// re-activation. The rule lives in ONE function (shouldSeedDeclaredGrants): no record ⇒ seed; an empty
// record ⇒ seed only when no administrator decided it; a record holding grants ⇒ keep.

/** Write a plugin that declares `permissions` and needs none of them at run time. */
function writeQuietPlugin(slug: string, permissions: Array<{ scope: string; access: string }>): void {
    const dir = pluginsRouter.resolveSafePluginDir(slug);
    cleanupDirs.push(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: slug, version: '1.0.0', isolated: true, permissions }));
    fs.writeFileSync(path.join(dir, 'index.js'), "'use strict';\nexports.init = function () {};\n");
}

test('shouldSeedDeclaredGrants: no record, and an empty record nobody decided, are seeded; a decided empty record and a record holding grants are kept', () => {
    assert.strictEqual(perms.shouldSeedDeclaredGrants('some-plugin', null), true);
    assert.strictEqual(perms.shouldSeedDeclaredGrants('some-plugin', []), true);
    assert.strictEqual(perms.shouldSeedDeclaredGrants('some-plugin', ['settings:read']), false);
    assert.strictEqual(perms.shouldSeedDeclaredGrants('some-plugin', [], true), false, 'an administrator\'s revoke of every grant was re-seeded');
    assert.strictEqual(perms.shouldSeedDeclaredGrants('some-plugin', null, true), true, 'no record at all is seeded whatever the bookkeeping says');
    assert.strictEqual(perms.shouldSeedDeclaredGrants('some-plugin', ['settings:read'], true), false);
});

test('a plugin whose stored grant record is the empty list an in-place update left gets its declared grants on its first activation', async () => {
    const core = require('../core/plugins');
    const slug = `wjs-order-legacy-update-${process.pid}`;
    writeQuietPlugin(slug, [{ scope: 'settings', access: 'read' }, { scope: 'database', access: 'read' }]);
    // What an in-place update stores for a never-activated plugin that has no record (from 1.12.12 on,
    // and still: ensureGrantRecord) — and no administrator decision for it (another plugin's decision
    // does not count).
    const blob = await options.getOptionFresh('plugin_grants', {});
    blob[slug] = [];
    blob['@host'] = { ...(blob['@host'] || {}), adminDecisions: { ...((blob['@host'] || {}).adminDecisions || {}), 'some-other-plugin': '2026-01-01T00:00:00.000Z' } };
    await database.dbAsync.run('UPDATE options SET option_value = ? WHERE option_name = ?', [JSON.stringify(blob), 'plugin_grants']);
    await perms.loadGrants();
    assert.strictEqual(perms.hasGrantRecord(slug), true, 'precondition: an empty record, not none');
    assert.deepStrictEqual(perms.getGrants(slug), [], 'precondition');
    assert.strictEqual(await perms.hasAdminGrantDecision(slug), false, 'precondition: nobody decided it');
    try {
        const r = await post(`/api/v1/plugins/${slug}/activate`, {});
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(perms.getGrants(slug).sort(), ['database:read', 'settings:read'],
            'the first activation started the plugin with none of the permissions it declares');
        const stored = await options.getOptionFresh('plugin_grants', {});
        assert.deepStrictEqual([...stored[slug]].sort(), ['database:read', 'settings:read'], 'the seed was not persisted');
        assert.strictEqual(await perms.hasAdminGrantDecision(slug), true, 'the activation dialog\'s seed is the administrator\'s decision');
        assert.ok(stored['@host'].adminDecisions['some-other-plugin'], 'another plugin\'s decision survived the seed');
    } finally {
        try { await core.deactivatePlugin(slug); } catch { /* */ }
    }
});

test('a partial revoke and a revoke of EVERY grant both survive a re-activation', async () => {
    const core = require('../core/plugins');
    const slug = `wjs-order-seed-${process.pid}`;
    writeQuietPlugin(slug, [{ scope: 'settings', access: 'read' }, { scope: 'database', access: 'read' }]);
    try {
        let r = await post(`/api/v1/plugins/${slug}/activate`, {});
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(perms.getGrants(slug).sort(), ['database:read', 'settings:read'], 'control: the first activation grants what the plugin declares');

        r = await post(`/api/v1/plugins/${slug}/permissions`, { granted: ['settings:read'] });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));

        // Activated again while it is still active (the admin pressing Activate twice, a stale admin tab).
        r = await post(`/api/v1/plugins/${slug}/activate`, {});
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(perms.getGrants(slug), ['settings:read'], 're-activating an active plugin re-granted what the administrator revoked');

        // Deactivated and activated again.
        await core.deactivatePlugin(slug);
        r = await post(`/api/v1/plugins/${slug}/activate`, {});
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(perms.getGrants(slug), ['settings:read'], 'a re-activation re-granted what the administrator revoked');

        // Everything revoked: the store holds an empty record, and POST /permissions recorded it as the
        // administrator's decision, so it is NOT an old update's leftover and activation does not seed it.
        r = await post(`/api/v1/plugins/${slug}/permissions`, { granted: [] });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual((await options.getOptionFresh('plugin_grants', {}))[slug], []);
        assert.strictEqual(await perms.hasAdminGrantDecision(slug), true, 'the permissions route did not record the administrator\'s decision');
        await core.deactivatePlugin(slug);
        r = await post(`/api/v1/plugins/${slug}/activate`, {});
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(perms.getGrants(slug), [], 'a re-activation re-seeded the grants the administrator revoked');
        assert.deepStrictEqual((await options.getOptionFresh('plugin_grants', {}))[slug], [], 'the revoke of every grant was overwritten in the store');
    } finally {
        try { await core.deactivatePlugin(slug); } catch { /* */ }
    }
});

test('twin: the permissions route records the decision itself — a revoke of every grant of a plugin nobody had decided survives its activation', async () => {
    const core = require('../core/plugins');
    const slug = `wjs-order-undecided-${process.pid}`;
    writeQuietPlugin(slug, [{ scope: 'settings', access: 'read' }]);
    // Grants written by a boot step (the backfill of an already-active plugin), not by an administrator.
    await perms.setGrants(slug, ['settings:read']);
    assert.strictEqual(await perms.hasAdminGrantDecision(slug), false, 'precondition: nobody decided these grants');
    try {
        let r = await post(`/api/v1/plugins/${slug}/permissions`, { granted: [] });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(await perms.hasAdminGrantDecision(slug), true, 'the permissions route did not record the administrator\'s decision');
        r = await post(`/api/v1/plugins/${slug}/activate`, {});
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(perms.getGrants(slug), [], 'the activation re-seeded what the administrator revoked');
        assert.deepStrictEqual((await options.getOptionFresh('plugin_grants', {}))[slug], []);
    } finally {
        try { await core.deactivatePlugin(slug); } catch { /* */ }
    }
});

test('twin: undoing a seed (a failed activation) drops the grant record AND the decision recorded with it', async () => {
    const slug = `wjs-order-undo-${process.pid}`;
    assert.strictEqual(await perms.seedGrants(slug, ['settings:read'], { adminDecision: true }), true);
    assert.strictEqual(await perms.hasAdminGrantDecision(slug), true, 'precondition');
    await perms.clearGrants(slug);
    assert.strictEqual(perms.hasGrantRecord(slug), false);
    assert.strictEqual(Object.hasOwn(await options.getOptionFresh('plugin_grants', {}), slug), false);
    assert.strictEqual(await perms.hasAdminGrantDecision(slug), false,
        'a plugin that never ran kept an administrator decision, and a later empty record would never be seeded');
});

test('twin: the boot backfill does not invent an empty grant record for an active plugin that declares nothing', async () => {
    const slug = `wjs-order-backfill-${process.pid}`;
    await perms.loadGrants();
    assert.strictEqual(perms.hasGrantRecord(slug), false, 'precondition');
    assert.deepStrictEqual(await perms.backfillActive([{ slug, requested: [] }]), [slug]);
    assert.strictEqual(perms.hasGrantRecord(slug), false,
        'memory now holds an empty grant record the store does not have');
});

/**
 * A second node's copy of core/plugin-permissions, with its own in-memory maps (nothing loaded yet) and
 * the same database — what a node that is booting holds while this process's copy plays every other node.
 * The module cache is put back at once, so every other module keeps using this process's copy.
 */
function bootingNode(): any {
    const key = require.resolve('../core/plugin-permissions');
    const mine = require.cache[key];
    delete require.cache[key];
    try {
        return require('../core/plugin-permissions');
    } finally {
        require.cache[key] = mine;
    }
}

/** Make the next `count` fresh reads of option `name` fail like a database outage, then recover. */
function failNextReads(name: string, count: number) {
    const orig = options.readStoredOption;
    let left = count;
    options.readStoredOption = async (n: string, ...rest: any[]) => {
        if (n === name && left > 0) { left--; throw new Error('simulated database outage'); }
        return orig(n, ...rest);
    };
    return { restore: () => { options.readStoredOption = orig; } };
}

test('the boot backfill writes nothing while the grants could not be read: a partial revoke survives a boot whose first reads failed', async () => {
    const slug = `wjs-order-backfill-unread-${process.pid}`;
    const declared = ['settings:read', 'database:write'];
    // An administrator narrowed the plugin to one of the two permissions it declares.
    await perms.setGrants(slug, ['settings:read'], { adminDecision: true });
    const node = bootingNode();
    // Boot's load fails, the backfill's own retry fails, and the database is back for whatever comes next.
    const f = failNextReads('plugin_grants', 2);
    let backfilled: string[];
    try {
        await node.loadGrants();
        backfilled = await node.backfillActive([{ slug, requested: declared }]);
    } finally {
        f.restore();
    }
    assert.deepStrictEqual((await options.getOptionFresh('plugin_grants', {}))[slug], ['settings:read'],
        'the declared set was written over the administrator\'s partial revoke');
    assert.deepStrictEqual(backfilled, [], 'the backfill granted plugins while it had not read the grants');
    assert.strictEqual(await perms.hasAdminGrantDecision(slug), true);
    // The node picks the stored record up at its next successful load.
    await node.loadGrants();
    assert.deepStrictEqual(node.getGrants(slug), ['settings:read']);
});

test('the boot backfill is insert-if-absent on the stored row: a record another node stored after this node loaded is kept and mirrored', async () => {
    const updated = `wjs-order-backfill-updated-${process.pid}`;
    const revoked = `wjs-order-backfill-revoked-${process.pid}`;
    const absent = `wjs-order-backfill-absent-${process.pid}`;
    const declared = ['network', 'database:write'];
    const node = bootingNode();
    await node.loadGrants();
    for (const s of [updated, revoked, absent]) assert.strictEqual(node.hasGrantRecord(s), false, 'precondition');

    // Between this node's load and its backfill, other nodes store records: an in-place update's empty
    // record (ensureGrantRecord) and an administrator's revoke of every grant.
    assert.strictEqual(await perms.ensureGrantRecord(updated), true);
    await perms.setGrants(revoked, [], { adminDecision: true });

    const backfilled = await node.backfillActive([
        { slug: updated, requested: declared },
        { slug: revoked, requested: declared },
        { slug: absent, requested: declared },
    ]);
    const stored = await options.getOptionFresh('plugin_grants', {});
    assert.deepStrictEqual(stored[updated], [], 'the update\'s empty record was replaced by what the new version declares');
    assert.deepStrictEqual(stored[revoked], [], 'the administrator\'s revoke was replaced by the declared set');
    assert.deepStrictEqual(stored[absent], declared, 'a plugin with no record is still grandfathered');
    assert.deepStrictEqual(backfilled, [absent], 'only the plugin with no stored record is backfilled');
    assert.strictEqual(await perms.hasAdminGrantDecision(revoked), true);
    // The booting node's memory mirrors the row it decided on.
    assert.deepStrictEqual([node.getGrants(updated), node.getGrants(revoked)], [[], []]);
    assert.strictEqual(node.hasGrantRecord(updated), true);
    assert.strictEqual(node.isNetworkGranted(revoked), false);
    assert.deepStrictEqual(node.getGrants(absent), declared);
});

// ── the one-time browser:script upgrade: decided on the stored record, and only once it was read ────
//
// core/plugins migrateBrowserCapabilityGrants runs at boot right after the backfill, and core/plugins
// requires plugin-permissions when it runs — so the booting node's copy is put in front of that require
// for the duration of the boot sequence (runAsNode).

/** bootingNode(), as the module record runAsNode() puts in front of every require of plugin-permissions. */
function bootingNodeModule(): any {
    const key = require.resolve('../core/plugin-permissions');
    const mine = require.cache[key];
    delete require.cache[key];
    try {
        require('../core/plugin-permissions');
        return require.cache[key];
    } finally {
        require.cache[key] = mine;
    }
}

/** Run `fn` with `nodeModule` answering every require of core/plugin-permissions (core/plugins included). */
async function runAsNode<T>(nodeModule: any, fn: () => Promise<T>): Promise<T> {
    const key = require.resolve('../core/plugin-permissions');
    const mine = require.cache[key];
    require.cache[key] = nodeModule;
    try {
        return await fn();
    } finally {
        require.cache[key] = mine;
    }
}

/** What the upgrade candidates below declare besides browser code (the backfill grants it to a plugin with no record). */
const CANDIDATE_DECLARES = ['settings:read', 'database:write'];

/**
 * ACTIVE plugins that ship browser code (a hooks bundle), on a site not marked as upgraded yet — the shape
 * the upgrade step exists for. Restores the active list and drops their grant records afterwards.
 */
async function withUpgradeCandidates(slugs: string[], fn: () => Promise<void>): Promise<void> {
    const core = require('../core/plugins');
    const dirs = slugs.map((slug) => path.join(core.PLUGINS_DIR, slug));
    for (const [i, dir] of dirs.entries()) {
        cleanupDirs.push(dir);
        fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            name: slugs[i], version: '1.0.0', isolated: true,
            permissions: [{ scope: 'settings', access: 'read' }, { scope: 'database', access: 'write' }],
        }));
        fs.writeFileSync(path.join(dir, 'index.js'), "'use strict';\nmodule.exports = { init() {} };\n");
        fs.writeFileSync(path.join(dir, 'dist', 'hooks.bundle.js'), 'window.hooked = 1;\n');
    }
    const activeBefore = await options.getOptionFresh('active_plugins', []);
    await options.updateOption('active_plugins', slugs);
    await perms.setHostMarker(core.BROWSER_CAPABILITY_MIGRATION_MARKER, null);
    try {
        await fn();
    } finally {
        await options.updateOption('active_plugins', activeBefore);
        for (const slug of slugs) await perms.removeGrants(slug);
        for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** index.ts's boot sequence for the grants, on `nodeModule`: load, backfill, the one-time upgrade. */
async function bootGrants(nodeModule: any, slugs: string[]): Promise<string[]> {
    const core = require('../core/plugins');
    return runAsNode(nodeModule, async () => {
        await nodeModule.exports.loadGrants();
        await nodeModule.exports.backfillActive(slugs.map((slug) => ({ slug, requested: CANDIDATE_DECLARES })));
        return core.migrateBrowserCapabilityGrants();
    });
}

test('the browser:script upgrade writes nothing while the grants could not be read: a stored record survives a boot whose first reads failed', async () => {
    const recorded = `wjs-order-upgrade-unread-${process.pid}`;
    const unrecorded = `wjs-order-upgrade-norecord-${process.pid}`;
    const core = require('../core/plugins');
    await withUpgradeCandidates([recorded, unrecorded], async () => {
        // An administrator narrowed `recorded` under a version without the decision mark: a record nobody
        // decided. `unrecorded` has no record yet: the backfill grants it what it declares.
        await perms.setGrants(recorded, ['settings:read']);
        const node = bootingNodeModule();
        // Boot's load fails, the backfill's own retry fails, and the database is back for whatever comes next.
        const f = failNextReads('plugin_grants', 2);
        let granted: string[];
        try {
            granted = await bootGrants(node, [recorded, unrecorded]);
        } finally {
            f.restore();
        }
        const afterFailedBoot = await options.getOptionFresh('plugin_grants', {});
        assert.deepStrictEqual(afterFailedBoot[recorded], ['settings:read'], 'the upgrade wrote over a stored record it had not read');
        assert.strictEqual(Object.hasOwn(afterFailedBoot, unrecorded), false,
            'a record was stored for a plugin the skipped backfill has not granted what it declares');
        assert.deepStrictEqual(granted, []);
        assert.strictEqual(await perms.getHostMarker(core.BROWSER_CAPABILITY_MIGRATION_MARKER), null,
            'the upgrade was recorded as done although it did not run');

        // The next boot reads the store: the backfill grants the declared set, and the step ADDS the token
        // to each stored record.
        const next = bootingNodeModule();
        assert.deepStrictEqual((await bootGrants(next, [recorded, unrecorded])).sort(), [recorded, unrecorded].sort());
        const stored = await options.getOptionFresh('plugin_grants', {});
        assert.deepStrictEqual(stored[recorded], ['settings:read', 'browser:script']);
        assert.deepStrictEqual(stored[unrecorded], [...CANDIDATE_DECLARES, 'browser:script']);
        assert.deepStrictEqual(next.exports.getGrants(recorded), ['settings:read', 'browser:script']);
        assert.deepStrictEqual(next.exports.getGrants(unrecorded), [...CANDIDATE_DECLARES, 'browser:script']);
        assert.ok(await perms.getHostMarker(core.BROWSER_CAPABILITY_MIGRATION_MARKER), 'recorded as done once it ran');
        assert.strictEqual(await perms.hasAdminGrantDecision(recorded), false, 'the upgrade is not an administrator decision');
    });
});

test('the browser:script upgrade adds the token to the STORED record: a grant removed after this node loaded stays removed', async () => {
    const slug = `wjs-order-upgrade-stale-${process.pid}`;
    await withUpgradeCandidates([slug], async () => {
        await perms.setGrants(slug, ['settings:read', 'database:write']); // what the backfill granted
        const node = bootingNodeModule();
        await runAsNode(node, () => node.exports.loadGrants());
        assert.deepStrictEqual(node.exports.getGrants(slug), ['settings:read', 'database:write'], 'precondition');
        // After this node's load, another node narrows the record with a write that records no decision
        // (an older version's permissions screen).
        await perms.setGrants(slug, ['settings:read']);

        const core = require('../core/plugins');
        assert.deepStrictEqual(await runAsNode(node, () => core.migrateBrowserCapabilityGrants()), [slug]);
        assert.deepStrictEqual((await options.getOptionFresh('plugin_grants', {}))[slug], ['settings:read', 'browser:script'],
            'a grant removed since this node loaded was written back with the upgrade');
        // The booting node's memory mirrors the row it decided on.
        assert.deepStrictEqual(node.exports.getGrants(slug), ['settings:read', 'browser:script']);
        assert.strictEqual(node.exports.isGranted(slug, 'database', 'write'), false);
    });
});

// ── ensureGrantRecord: the in-place update's one grant write is insert-if-absent ────────────────────
//
// An update gives a plugin with no grant record an empty one (the boot backfill would otherwise grant an
// active plugin whatever its new version declares). It must never replace a record — not one that
// exists, and not one another writer stores between its read and its write.

test('ensureGrantRecord creates an empty, undecided record only where there is none, and touches no existing record', async () => {
    const none = `wjs-order-ensure-none-${process.pid}`;
    const held = `wjs-order-ensure-held-${process.pid}`;
    const revoked = `wjs-order-ensure-revoked-${process.pid}`;
    await perms.setGrants(held, ['settings:read']);
    await perms.setGrants(revoked, [], { adminDecision: true });
    assert.strictEqual(perms.hasGrantRecord(none), false, 'precondition');

    assert.strictEqual(await perms.ensureGrantRecord(none), true);
    assert.strictEqual(await perms.ensureGrantRecord(held), false);
    assert.strictEqual(await perms.ensureGrantRecord(revoked), false);
    assert.strictEqual(await perms.ensureGrantRecord(none), false, 'a second call found the record it created');

    const stored = await options.getOptionFresh('plugin_grants', {});
    assert.deepStrictEqual(stored[none], []);
    assert.deepStrictEqual(stored[held], ['settings:read'], 'an existing record was replaced');
    assert.deepStrictEqual(stored[revoked], []);
    assert.strictEqual(await perms.hasAdminGrantDecision(none), false, 'the created record claims an administrator decision');
    assert.strictEqual(await perms.hasAdminGrantDecision(revoked), true, 'an administrator decision was dropped');
    assert.strictEqual(perms.hasGrantRecord(none), true, 'memory does not mirror the created record');
    assert.strictEqual(perms.shouldSeedDeclaredGrants(none, stored[none], false), true, 'the first activation would not seed it');
});

test('ensureGrantRecord: a record another writer stores between its read and its write is kept, not replaced by the empty one', async () => {
    const slug = `wjs-order-ensure-race-${process.pid}`;
    await perms.loadGrants();
    assert.strictEqual(perms.hasGrantRecord(slug), false, 'precondition');
    const g = holdRead('plugin_grants');
    try {
        const ensure = perms.ensureGrantRecord(slug);   // reads "no record" now, decides at the gate
        await g.entered;
        // Another node's activation seeds the plugin, straight into the row (this node's lease and queue
        // know nothing of it).
        const blob = await options.readStoredOption('plugin_grants');
        const next = { ...(blob.value || {}), [slug]: ['settings:read'] };
        await database.dbAsync.run('UPDATE options SET option_value = ? WHERE option_name = ?', [JSON.stringify(next), 'plugin_grants']);
        g.open();
        assert.strictEqual(await ensure, false, 'it reported creating a record over the one stored meanwhile');
        assert.deepStrictEqual((await options.getOptionFresh('plugin_grants', {}))[slug], ['settings:read'], 'the concurrent record was overwritten');
        assert.deepStrictEqual(perms.getGrants(slug), ['settings:read'], 'memory does not mirror the stored record');
    } finally {
        g.restore();
    }
});

// ── The shared ACTIVE SET, the same two lessons ──────────────────────────────────────────────────────

test('the active-set read-modify-write reads the database, not a stale cache: a peer\'s activation survives a local deactivation', async () => {
    const core = require('../core/plugins');
    await options.updateOption('active_plugins', ['local-x']);
    await options.getOption('active_plugins', []); // this node's L1 now holds ['local-x']
    // Another node activates 'peer-y'. Its cache-invalidation broadcast never reached us.
    await database.dbAsync.run('UPDATE options SET option_value = ? WHERE option_name = ?', [JSON.stringify(['local-x', 'peer-y']), 'active_plugins']);

    await core.deactivatePlugin('local-x');
    assert.deepStrictEqual(await options.getOptionFresh('active_plugins', []), ['peer-y'],
        'the peer\'s activation was overwritten by a stale active set');
});

test('the stray-plugin reconcile never stops a plugin whose activation is still in flight here — and does stop one no node has active', async () => {
    const core = require('../core/plugins');
    const slug = `wjs-order-act-${process.pid}`;
    cleanupDirs.push(pluginsRouter.resolveSafePluginDir(slug));
    writeProbePlugin(pluginsRouter.resolveSafePluginDir(slug), slug);
    await options.updateOption('active_plugins', []);
    await perms.setGrants(slug, ['network']);

    // Hold the activation between "child spawned" and "active set written".
    const distLock = require('../core/dist-lock');
    const orig = distLock.acquireBlocking;
    const g = gate();
    let armed = true;
    distLock.acquireBlocking = async (name: string, o: any) => {
        if (armed && name === 'wordjs:active-plugins') { armed = false; await g.wait(); }
        return orig(name, o);
    };
    try {
        const activation = core.activatePlugin(slug);
        await g.entered;
        assert.strictEqual(iso.isIsolated(slug), true, 'precondition: the child is running, the active set does not list it yet');
        await core.reconcileDeactivatedPlugins();
        await core.reconcileDeactivatedPlugins();
        assert.strictEqual(iso.isIsolated(slug), true, 'an in-flight activation was mistaken for a lost deactivation');
        g.open();
        await activation;
        assert.deepStrictEqual(await options.getOptionFresh('active_plugins', []), [slug]);
    } finally {
        distLock.acquireBlocking = orig;
    }

    // A peer deactivates it and the broadcast is lost: the shared set no longer lists it.
    await options.updateOption('active_plugins', []);
    assert.deepStrictEqual(await core.reconcileDeactivatedPlugins(), [], 'one observation is not enough');
    assert.strictEqual(iso.isIsolated(slug), true);
    assert.deepStrictEqual(await core.reconcileDeactivatedPlugins(), [slug]);
    assert.strictEqual(iso.isIsolated(slug), false, 'a plugin no node has active is still running here');
});
