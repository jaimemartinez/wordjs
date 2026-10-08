/**
 * A PLUGIN GRANT OR EGRESS-ALLOWLIST CHANGE MADE ON ONE NODE REACHES THE PLUGIN'S CHILD ON ANOTHER NODE.
 *
 * Two backend cores in two OS processes sharing one database file:
 *   · node A — THIS process: the real /api/v1/plugins router behind real admin auth. Its publishes go
 *     through cache.publish, which here forwards them to node B over IPC — or drops them, to model the
 *     broadcast that Redis loses (a blip, a subscriber reconnect, the boot window before subscribing).
 *   · node B — fixtures/policy-peer-node.ts: boots like a node with the plugin already active (loads the
 *     policy from the database, spawns the plugin's isolate) and joins the bus through the real
 *     core/coherence.ts.
 * The assertion is always what the plugin's CHILD on node B can do (fixtures/policy-probe-plugin.ts):
 * whether it holds the network and which host its egress guard lets it resolve — never which functions
 * were called. A different spawn token proves the child was respawned rather than patched in place.
 * The same harness covers the activation messages: a cross-node activation whose grant broadcast was lost,
 * and a deactivation whose broadcast was lost (node B must stop the plugin, and only that one).
 *
 * What is NOT real here: Redis. The bus is the IPC forwarder above; ordering and loss are what it models.
 */
process.env.NODE_ENV = 'production'; // activation regenerates the frontend registries outside production

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-policy-multinode-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const cache = require('../core/cache');
const express = require('express');
const request = require('supertest');
const roles = require('../core/roles');
const perms = require('../core/plugin-permissions');
const { getOptionFresh, updateOption } = require('../core/options');
const { setApp } = require('../core/appRegistry');
const pluginsRouter = require('../routes/plugins');
const { writeProbePlugin } = require('./fixtures/policy-probe-plugin');

const PEER_SCRIPT = path.join(__dirname, 'fixtures', 'policy-peer-node.ts');
const tag = String(process.pid);
const P_ROUTES = `wjs-mn-routes-${tag}`;     // running on node B from the start
const P_ACTIVATE = `wjs-mn-activate-${tag}`; // activated by a message node B receives
const P_SEED = `wjs-mn-seed-${tag}`;         // activated through the real route on node A
const P_KEEP = `wjs-mn-keep-${tag}`;         // stays active: must survive the stray-plugin reconcile

const app = express();
app.use(express.json());
app.use('/api/v1/plugins', pluginsRouter);
let adminToken = '';
const post = (url: string, body: any) => request(app).post(url).set('Authorization', `Bearer ${adminToken}`).send(body);

// ── node A's bus ─────────────────────────────────────────────────────────────────────────────────────
let forwarding = true;
let peer: any = null;
const onPublish: Array<(channel: string, payload: string) => void> = [];
cache.publish = async (channel: string, payload: any) => {
    const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const f of onPublish) f(channel, msg);
    if (forwarding && peer && peer.connected) {
        // updateOption() del()s the option's cache key (a 'wordjs:cache-del' broadcast) right before it
        // publishes 'wordjs:option-changed' — deliver both, in that order, as Redis would.
        if (channel === 'wordjs:option-changed') peer.send({ type: 'bus', channel: 'wordjs:cache-del', payload: `option:${msg}` });
        peer.send({ type: 'bus', channel, payload: msg });
    }
    return true;
};

// ── node B ───────────────────────────────────────────────────────────────────────────────────────────
type Peer = { child: any; probe: (slug: string) => Promise<any>; log: () => string; stop: () => Promise<void> };
function startPeer(resyncMs: number, plugins: Array<[string, string]>): Promise<Peer> {
    return new Promise((resolve, reject) => {
        const child = fork(PEER_SCRIPT, [], {
            execArgv: ['-r', 'ts-node/register/transpile-only'],
            env: { ...process.env, WJS_PEER_DB: TMP_DB, WJS_PEER_RESYNC_MS: String(resyncMs), WJS_PEER_PLUGINS: plugins.map(([s, e]) => `${s}=${e}`).join(',') },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
        let seq = 0;
        const waiting = new Map<number, (r: any) => void>();
        const timer = setTimeout(() => reject(new Error(`node B did not start:\n${out}`)), 90000);
        child.on('message', (m: any) => {
            if (m && m.type === 'ready') {
                clearTimeout(timer);
                resolve({
                    child,
                    log: () => out,
                    probe: (slug: string) => new Promise((res) => { const id = ++seq; waiting.set(id, res); child.send({ type: 'probe', id, slug }); }),
                    stop: () => new Promise<void>((res) => {
                        if (!child.connected) return res();
                        child.once('exit', () => res());
                        child.send({ type: 'shutdown' });
                        setTimeout(() => { try { child.kill(); } catch { /* */ } res(); }, 5000);
                    }),
                });
            } else if (m && m.type === 'fatal') {
                clearTimeout(timer);
                reject(new Error(`node B failed to start: ${m.error}\n${out}`));
            } else if (m && m.type === 'probe') {
                const r = waiting.get(m.id);
                if (r) { waiting.delete(m.id); r(m.result); }
            }
        });
        child.on('exit', (code: number) => { clearTimeout(timer); if (code) reject(new Error(`node B exited ${code}:\n${out}`)); });
    });
}

/** Poll node B's probe until `ok` holds; return the last result (the assertion is the caller's). */
async function probeUntil(p: Peer, slug: string, ok: (r: any) => boolean, timeoutMs = 15000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    let last: any = null;
    while (Date.now() < deadline) {
        last = await p.probe(slug);
        if (ok(last)) return last;
        await new Promise((r) => setTimeout(r, 100));
    }
    return last;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];
function pluginDir(slug: string): string {
    const d = pluginsRouter.resolveSafePluginDir(slug);
    dirs.push(d);
    return d;
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await roles.loadRoles();
    const User = require('../models/User');
    const admin = await User.create({ username: 'mnadmin', email: 'mnadmin@example.com', password: 'correct-horse-battery-9', role: 'administrator' });
    adminToken = jwt.sign({ userId: admin.id, username: 'mnadmin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
    setApp(app);
    await perms.loadGrants();
    await perms.loadEgressHosts();
}, { timeout: 60000 });

after(async () => {
    try { if (peer) await peer.stop(); } catch { /* */ }
    try {
        const iso = require('../core/plugin-isolate');
        for (const s of iso.listIsolates()) { try { iso.unloadIsolatedPlugin(s); } catch { /* */ } }
    } catch { /* */ }
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
});

/** Make the shared active set exactly `slugs` (what activations on some node would have left behind). */
async function setActiveSet(slugs: string[]) {
    const was = forwarding;
    forwarding = false; // seeding the shared state, not an event node B should hear about
    try { await updateOption('active_plugins', slugs); } finally { forwarding = was; }
}

describe('the real permission and egress routes on node A respawn the plugin\'s child on node B', () => {
    let b: Peer;
    before(async () => {
        const entry = writeProbePlugin(pluginDir(P_ROUTES), P_ROUTES);
        writeProbePlugin(pluginDir(P_ACTIVATE), P_ACTIVATE);
        await setActiveSet([P_ROUTES]);
        // A long period: in this block only the bus (or a reconnect) may bring node B up to date.
        b = await startPeer(3_600_000, [[P_ROUTES, entry]]);
        peer = b.child;
    }, { timeout: 120000 });
    after(async () => { await b.stop(); peer = null; });

    test('granting the network on node A: node B\'s child is respawned WITH the network', async () => {
        forwarding = true;
        const before0 = await b.probe(P_ROUTES);
        assert.strictEqual(before0 && before0.network, false, `precondition: no network on node B (${JSON.stringify(before0)})`);
        const r = await post(`/api/v1/plugins/${P_ROUTES}/permissions`, { granted: [], network: true });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const after0 = await probeUntil(b, P_ROUTES, (x) => !!x && x.network === true);
        assert.strictEqual(after0.network, true, `node B never got the network grant:\n${b.log()}`);
        assert.notStrictEqual(after0.spawn, before0.spawn, 'the child was respawned');
    });

    test('narrowing / switching the egress allowlist on node A changes what node B\'s child may resolve', async () => {
        forwarding = true;
        let r = await post(`/api/v1/plugins/${P_ROUTES}/egress-hosts`, { hosts: ['192.0.2.10'] });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        let p = await probeUntil(b, P_ROUTES, (x) => !!x && x.a === 'allowed' && x.b === 'blocked');
        assert.deepStrictEqual([p.a, p.b], ['allowed', 'blocked'], `node B kept the old allowlist:\n${b.log()}`);

        r = await post(`/api/v1/plugins/${P_ROUTES}/egress-hosts`, { hosts: ['192.0.2.20'] });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        p = await probeUntil(b, P_ROUTES, (x) => !!x && x.a === 'blocked' && x.b === 'allowed');
        assert.deepStrictEqual([p.a, p.b], ['blocked', 'allowed'], `node B kept the old allowlist:\n${b.log()}`);
    });

    test('a LOST broadcast is caught up when node B\'s bus reconnects', async () => {
        forwarding = false; // node B hears nothing of this change
        const stale = await b.probe(P_ROUTES);
        const r = await post(`/api/v1/plugins/${P_ROUTES}/egress-hosts`, { hosts: ['192.0.2.10'] });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        await sleep(1500);
        const still = await b.probe(P_ROUTES);
        assert.deepStrictEqual([still.a, still.b], ['blocked', 'allowed'], 'control: with the broadcast lost and no re-sync due, node B is stale');
        assert.strictEqual(still.spawn, stale.spawn);
        b.child.send({ type: 'bus-ready' }); // the subscriber connection came back
        const p = await probeUntil(b, P_ROUTES, (x) => !!x && x.a === 'allowed' && x.b === 'blocked');
        assert.deepStrictEqual([p.a, p.b], ['allowed', 'blocked'], `the reconnect did not re-sync node B:\n${b.log()}`);
    });

    test('a cross-node activation whose grant broadcast was lost still runs with the grants node A persisted', async () => {
        // Node A persisted the grants (publish dropped); node B is then told ONLY that the plugin was
        // activated. It must validate and spawn against the database, not against its stale map — where
        // the declared network is "not granted" and the activation is refused.
        forwarding = false;
        await perms.setGrants(P_ACTIVATE, ['network']);
        await setActiveSet([P_ROUTES, P_ACTIVATE]);
        b.child.send({ type: 'bus', channel: 'wordjs:plugin-changed', payload: JSON.stringify({ slug: P_ACTIVATE, action: 'activate', origin: 'node-a:1:x' }) });
        const p = await probeUntil(b, P_ACTIVATE, (x) => !!x && x.network === true, 30000);
        assert.ok(p && p.network === true, `node B did not load the plugin with its grants (${JSON.stringify(p)}):\n${b.log()}`);
    });

    test('revoking the network on node A takes it away from node B\'s child', async () => {
        forwarding = true;
        const r = await post(`/api/v1/plugins/${P_ROUTES}/permissions`, { granted: [] });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        // The probe's code needs the network, so the revoke condemns it: node A deactivates it cluster-wide
        // (r.body.deactivated). Either way node B's copy must not keep the revoked capability.
        const p = await probeUntil(b, P_ROUTES, (x) => x === null || x.network === false);
        assert.ok(p === null || p.network === false, `node B's child still holds the revoked network (${JSON.stringify(p)}):\n${b.log()}`);
    });
});

describe('with every broadcast lost, node B converges within the re-sync period', () => {
    let b: Peer;
    before(async () => {
        forwarding = false;
        await perms.setGrants(P_ROUTES, []);
        await perms.setEgressAllowlist(P_ROUTES, []);
        await setActiveSet([P_ROUTES, P_KEEP]);
        const keep = writeProbePlugin(pluginDir(P_KEEP), P_KEEP);
        b = await startPeer(300, [[P_ROUTES, path.join(pluginDir(P_ROUTES), 'index.js')], [P_KEEP, keep]]);
        peer = b.child;
    }, { timeout: 120000 });
    after(async () => { await b.stop(); peer = null; });

    test('a grant and an allowlist change made on node A reach node B\'s child with no message at all', async () => {
        forwarding = false;
        const before0 = await b.probe(P_ROUTES);
        assert.strictEqual(before0.network, false, `precondition (${JSON.stringify(before0)})`);
        let r = await post(`/api/v1/plugins/${P_ROUTES}/permissions`, { granted: [], network: true });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        let p = await probeUntil(b, P_ROUTES, (x) => !!x && x.network === true, 8000);
        assert.strictEqual(p.network, true, `node B never re-synced the grant:\n${b.log()}`);

        r = await post(`/api/v1/plugins/${P_ROUTES}/egress-hosts`, { hosts: ['192.0.2.10'] });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        p = await probeUntil(b, P_ROUTES, (x) => !!x && x.a === 'allowed' && x.b === 'blocked', 8000);
        assert.deepStrictEqual([p.a, p.b], ['allowed', 'blocked'], `node B never re-synced the allowlist:\n${b.log()}`);
    });

    test('a deactivation whose broadcast was lost stops the plugin on node B — and only that plugin', async () => {
        forwarding = false;
        assert.ok(await b.probe(P_ROUTES), 'precondition: running on node B');
        await require('../core/plugins').deactivatePlugin(P_ROUTES); // node A: active set rewritten, 'deactivate' dropped
        const gone = await probeUntil(b, P_ROUTES, (x) => x === null, 8000);
        assert.strictEqual(gone, null, `node B still runs a plugin no node has active:\n${b.log()}`);
        const kept = await b.probe(P_KEEP);
        assert.ok(kept && typeof kept.spawn === 'string', 'a plugin that is still active must keep running');
    });
});

describe('grant-on-activate is persisted before the cluster is told about the activation', () => {
    test('when POST /activate publishes "activate", the declared grants are already in the shared database', async () => {
        forwarding = false;
        writeProbePlugin(pluginDir(P_SEED), P_SEED);
        let seen: Promise<any> | null = null;
        const watch = (channel: string, payload: string) => {
            if (channel !== 'wordjs:plugin-changed') return;
            const m = JSON.parse(payload);
            // What another node reads the instant it hears of the activation.
            if (m.slug === P_SEED && m.action === 'activate') seen = getOptionFresh('plugin_grants', {});
        };
        onPublish.push(watch);
        try {
            const r = await post(`/api/v1/plugins/${P_SEED}/activate`, {});
            assert.strictEqual(r.status, 200, JSON.stringify(r.body));
            assert.ok(seen, 'the activation was published');
            const stored = await seen;
            assert.deepStrictEqual(stored && stored[P_SEED], ['network'],
                'another node told of the activation must find the plugin\'s grants in the database');
        } finally {
            onPublish.splice(onPublish.indexOf(watch), 1);
            try { await require('../core/plugins').deactivatePlugin(P_SEED); } catch { /* */ }
        }
    });

    test('a refused activation leaves no grant record behind, in memory or in the database', async () => {
        const slug = `wjs-mn-refused-${tag}`;
        const dir = pluginDir(slug);
        writeProbePlugin(dir, slug);
        // The AST scan refuses this outright (child_process is never permitted), after the seed was persisted.
        fs.writeFileSync(path.join(dir, 'index.js'), "'use strict';\nconst cp = require('child_process');\nexports.init = function () { return cp; };\n");
        const r = await post(`/api/v1/plugins/${slug}/activate`, {});
        assert.strictEqual(r.status, 400, JSON.stringify(r.body));
        assert.deepStrictEqual(perms.getGrants(slug), []);
        const stored = await getOptionFresh('plugin_grants', {});
        assert.strictEqual(Object.prototype.hasOwnProperty.call(stored || {}, slug), false, 'no grant record persisted for a plugin that never ran');
    });
});
