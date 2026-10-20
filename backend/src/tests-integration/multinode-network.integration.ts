/**
 * Multi-node NETWORK coherence — two backend nodes, one multisite network, shared Postgres + Redis.
 *
 * Node A is this process; node B (multinode-network-peer.ts) is a SEPARATE OS PROCESS booted from the
 * same configuration. Node B starts BEFORE the network has any site but the main one, so everything it
 * learns about the sites node A then creates comes through the shared network store and the Redis bus:
 *
 *   - registry coherence   a site created on A is answered by B, with its own data (its schema);
 *                          a session signed in on A is valid on B for that site and no other
 *   - per-site cache bus   a setting changed on A for one site is seen by B for that site (the cache
 *                          invalidation carries the site), and the main site's value on B is untouched
 *   - collaboration        an operation on A reaches B's member of the SAME site's room, never B's
 *                          member of the twin site's room of the same post id
 *   - certificates         an HTTP-01 answer recorded on A is served by B
 *   - lifecycle            a site suspended on A answers 503 on B; deleted on A, it is gone on B
 *
 * Runs in `npm run test:multinode` (CI: "Multi-node coherence", Postgres 16 + Redis 7). Locally it skips
 * without a reachable Postgres and Redis; under WORDJS_CI_DB=1 it fails instead.
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { fork } = require('child_process');
const bcrypt = require('bcryptjs');
const boot = require('./multinode-network-boot');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SECRET = crypto.randomBytes(48).toString('hex');
const TWO = 'two.example.com';
const THREE = 'three.example.com';

let child: any = null;
let nodeA: any = null;

after(async () => {
    try { if (child) { child.send('shutdown'); await sleep(500); child.kill('SIGKILL'); } } catch { /* */ }
    try { if (nodeA && nodeA.server) nodeA.server.close(); } catch { /* */ }
    try { require('../core/collab-rooms')._resetForTests(); } catch { /* */ }
    try { await require('../config/database').closeSiteDatabases(); } catch { /* */ }
    try { await require('../config/database').closeDatabase(); } catch { /* */ }
    try { require('../core/network').closeNetworkStore(); } catch { /* */ }
    try { await require('../core/cache').closeAll(); } catch { /* */ }
});

const skipOrFail = (t: any, reason: string) => {
    if (process.env.WORDJS_CI_DB === '1') assert.fail(reason);
    return t.skip(reason);
};

/** One HTTP request to a node (its loopback port), as a browser on `host` would send it. */
function call(port: number, method: string, url: string, host: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any; text: string; headers: any }> {
    return new Promise((resolve, reject) => {
        const data = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body));
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: {
            Host: host, Origin: `http://${host}`,
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
        } }, (res: any) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => { text += c; });
            res.on('end', () => { let body: any = null; try { body = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, body, text, headers: res.headers }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

/** Sign in on `host` through node `port`; the session JWT (the cookie's value), used as a Bearer from then on. */
async function signIn(port: number, host: string, username: string): Promise<string> {
    const res = await call(port, 'POST', '/api/v1/auth/login', host, { body: { username, password: boot.PASSWORD } });
    assert.strictEqual(res.status, 200, `sign-in on ${host}: ${res.status} ${res.text.slice(0, 200)}`);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('wordjs_token='));
    assert.ok(cookie, 'a session cookie');
    return decodeURIComponent(String(cookie).split(';')[0].slice('wordjs_token='.length));
}

/** Ask until `ok` holds (the bus and the store's re-read are asynchronous), within `ms`. */
async function eventually<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, ms = 12000): Promise<T> {
    const end = Date.now() + ms;
    let last: T = await fn();
    while (!ok(last) && Date.now() < end) { await sleep(150); last = await fn(); }
    assert.ok(ok(last), `${what} (last: ${JSON.stringify(last).slice(0, 300)})`);
    return last;
}

/** An SSE collaboration stream on a node. */
function openStream(port: number, host: string, token: string, postId: number, nonce: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: `/api/v1/collab/${postId}/stream?siteId=${nonce}`,
            headers: { Host: host, Origin: `http://${host}`, Accept: 'text/event-stream', Authorization: `Bearer ${token}` } }, (res: any) => {
            const events: any[] = [];
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
                buf += chunk;
                let i: number;
                while ((i = buf.indexOf('\n\n')) !== -1) {
                    const frame = buf.slice(0, i); buf = buf.slice(i + 2);
                    const ev = frame.split('\n').find((l) => l.startsWith('event: '));
                    const da = frame.split('\n').find((l) => l.startsWith('data: '));
                    if (ev && da) { try { events.push({ event: ev.slice(7), data: JSON.parse(da.slice(6)) }); } catch { /* */ } }
                }
            });
            resolve({ status: res.statusCode, events, close: () => { req.destroy(); res.destroy(); } });
        });
        req.on('error', reject);
    });
}

test('multi-node network: two nodes over shared Postgres + Redis serve the same sites, coherently', async (t: any) => {
    // A fresh database for the network (every site's schema and the network store live in it).
    try {
        const { Client } = require('pg');
        const admin = new Client({ ...boot.pgSettings(), database: 'postgres', connectionTimeoutMillis: 5000 });
        await admin.connect();
        try {
            await admin.query(`DROP DATABASE IF EXISTS ${boot.NET_DB} WITH (FORCE)`);
            await admin.query(`CREATE DATABASE ${boot.NET_DB} TEMPLATE template0 ENCODING 'UTF8'`);
        } finally { await admin.end(); }
    } catch (e: any) {
        return skipOrFail(t, `no reachable Postgres: ${e && e.message}`);
    }

    const m = await boot.bootNode('a', SECRET);
    await boot.startNode(m);
    let up = false;
    for (let i = 0; i < 50; i++) { if (m.cache.pubsubAvailable()) { up = true; break; } await sleep(100); }
    if (!up) return skipOrFail(t, 'no reachable Redis (pubsubAvailable=false)');

    // The network: site 1 and its network administrator.
    let adminId = 0;
    await m.siteContext.runWithSite(1, async () => {
        const db = m.database.getDbAsync();
        const r = await db.run('INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)',
            ['netadmin', bcrypt.hashSync(boot.PASSWORD, 10), 'netadmin@main.example.com', 'netadmin']);
        await db.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')", [r.lastID]);
        adminId = Number(r.lastID);
        await m.network.registerPrimarySite(boot.MAIN_URL);
        await m.network.addNetworkAdmin(adminId, 'netadmin');
    });
    nodeA = await boot.listen(m);
    const A = nodeA.port;

    // Node B: a second process, started while the network has no other site.
    child = fork(path.join(__dirname, 'multinode-network-peer.ts'), [], {
        execArgv: ['-r', 'ts-node/register/transpile-only'],
        cwd: path.join(__dirname, '..', '..'),
        env: { ...process.env, REDIS_ENABLED: 'true', WJ_MN_SECRET: SECRET, TSX_DISABLE_CACHE: '1' },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const B: number = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('node B did not start within 90s')), 90000);
        child.on('message', (msg: any) => {
            if (msg && msg.type === 'ready') { clearTimeout(timer); resolve(msg.port); }
            else if (msg && msg.type === 'error') { clearTimeout(timer); reject(new Error(msg.error)); }
        });
        child.on('exit', (code: number) => { clearTimeout(timer); reject(new Error(`node B exited (code ${code})`)); });
    });
    assert.strictEqual((await call(B, 'GET', '/api/v1/settings', TWO)).status, 421, 'before the site exists, node B refuses its address');

    // Sign in on A; create two sites there.
    const netToken = await signIn(A, 'main.example.com', 'netadmin');
    for (const [slug, host, title] of [['two', TWO, 'Site Two'], ['three', THREE, 'Site Three']]) {
        const r = await call(A, 'POST', '/api/v1/network/sites', 'main.example.com', { token: netToken, body: {
            slug, url: `http://${host}`, title, adminUsername: 'admin', adminEmail: `admin@${host}`, adminPassword: boot.PASSWORD, currentPassword: boot.PASSWORD } });
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    }
    const ids = { two: m.network.listSites().find((s: any) => s.slug === 'two').id, three: m.network.listSites().find((s: any) => s.slug === 'three').id };

    // Registry coherence: node B answers the new sites, each with its own data.
    await eventually('node B answers the site created on node A', () => call(B, 'GET', '/api/v1/settings', TWO), (r) => r.status === 200 && r.body.blogname === 'Site Two');
    assert.strictEqual((await call(B, 'GET', '/api/v1/settings', THREE)).body.blogname, 'Site Three');

    // A session made on node A for site two is valid on node B for site two, and only there.
    const twoToken = await signIn(A, TWO, 'admin');
    const threeToken = await signIn(A, THREE, 'admin');
    assert.strictEqual((await call(B, 'GET', '/api/v1/users/me', TWO, { token: twoToken })).status, 200);
    assert.strictEqual((await call(B, 'GET', '/api/v1/users/me', THREE, { token: twoToken })).status, 401);

    // Per-site cache invalidation over the bus: B has site two's title cached; A changes it.
    assert.strictEqual((await call(B, 'GET', '/api/v1/settings', TWO)).body.blogname, 'Site Two');
    const put = await call(A, 'PUT', '/api/v1/settings', TWO, { token: twoToken, body: { blogname: 'Two, renamed on node A' } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    const started = Date.now();
    await eventually('node B sees site two\'s new title', () => call(B, 'GET', '/api/v1/settings', TWO), (r) => r.body && r.body.blogname === 'Two, renamed on node A', 8000);
    assert.ok(Date.now() - started < 8000, 'well inside the 30 s cache cap: the bus delivered it');
    assert.strictEqual((await call(B, 'GET', '/api/v1/settings', 'main.example.com')).body.blogname, 'WordJS', "the main site's value on node B is untouched");
    assert.strictEqual((await call(B, 'GET', '/api/v1/settings', THREE)).body.blogname, 'Site Three', "the twin site's value on node B is untouched");

    // Collaboration across nodes, per site: same post id on the twins.
    const p2 = await call(A, 'POST', '/api/v1/posts', TWO, { token: twoToken, body: { title: 'Co-edited on two nodes', content: 'x', status: 'draft' } });
    const p3 = await call(A, 'POST', '/api/v1/posts', THREE, { token: threeToken, body: { title: 'The twin', content: 'y', status: 'draft' } });
    assert.strictEqual(p2.body.id, p3.body.id, 'same post id on both sites');
    const postId = p2.body.id;
    const onA = await openStream(A, TWO, twoToken, postId, 's_aaaaaaaaaaaaaaaa');
    const onB = await openStream(B, TWO, twoToken, postId, 's_bbbbbbbbbbbbbbbb');
    const twinOnB = await openStream(B, THREE, threeToken, postId, 's_cccccccccccccccc');
    try {
        const welcomeA = await eventually('welcome on A', async () => onA.events.find((e: any) => e.event === 'welcome'), (x) => !!x);
        await eventually('welcome on B', async () => onB.events.find((e: any) => e.event === 'welcome'), (x) => !!x);
        await eventually('welcome on B (twin)', async () => twinOnB.events.find((e: any) => e.event === 'welcome'), (x) => !!x);
        const self = welcomeA.data.self.siteId;
        const op = { k: 'propSet', id: { site: self, counter: 1 }, hlc: { l: 101, c: 0, site: self }, nodeId: 'n1', key: 'color', value: '#abcdef' };
        const pushed = await call(A, 'POST', `/api/v1/collab/${postId}/ops`, TWO, { token: twoToken, body: { siteId: self, epoch: welcomeA.data.epoch, ops: [op] } });
        assert.strictEqual(pushed.status, 200, JSON.stringify(pushed.body));
        await eventually('node B\'s member of the same site receives the operation', async () => onB.events.find((e: any) => e.event === 'ops' && JSON.stringify(e.data).includes('#abcdef')), (x) => !!x);
        await sleep(500);
        assert.ok(!twinOnB.events.some((e: any) => e.event === 'ops'), "node B's member of the twin site's room receives nothing");
    } finally {
        onA.close(); onB.close(); twinOnB.close();
    }

    // Certificates: an HTTP-01 answer recorded on A is served by B.
    await m.siteContext.runWithSite(1, () => require('../core/site-certs').rememberChallenge('tok_two_nodes', 'tok_two_nodes.thumb'));
    const challenge = await call(B, 'GET', '/.well-known/acme-challenge/tok_two_nodes', TWO);
    assert.strictEqual(challenge.status, 200);
    assert.strictEqual(challenge.text, 'tok_two_nodes.thumb');

    // Lifecycle: suspended on A → 503 on B; deleted on A → gone on B.
    assert.strictEqual((await call(A, 'POST', `/api/v1/network/sites/${ids.three}/suspend`, 'main.example.com', { token: netToken, body: { currentPassword: boot.PASSWORD } })).status, 200);
    await eventually('node B suspends site three', () => call(B, 'GET', '/api/v1/settings', THREE), (r) => r.status === 503);
    const del = await call(A, 'DELETE', `/api/v1/network/sites/${ids.three}`, 'main.example.com', { token: netToken, body: { currentPassword: boot.PASSWORD, confirmSlug: 'three' } });
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    await eventually('node B no longer answers the deleted site', () => call(B, 'GET', '/api/v1/settings', THREE), (r) => r.status === 421);
    assert.strictEqual((await call(B, 'GET', '/api/v1/settings', TWO)).status, 200, 'the other site is still served by node B');
});
