/**
 * ADMIN-APPROVED PRIVATE DESTINATIONS — the one way an isolated plugin reaches a non-public address.
 *
 * Plugins reach public addresses only (core/egress-guard). An operator's SMTP smarthost on the LAN is a
 * legitimate private destination, so an administrator can approve EXACTLY one host on EXACTLY one port for a
 * plugin (POST /plugins/:slug/private-egress). These tests pin the narrowness of that exception:
 *   · parsing — link-local (cloud metadata), unspecified and multicast addresses can never be approved, and
 *     an entry is always host + port;
 *   · enforcement inside a REAL child — the approved host:port connects, the same host on another port and
 *     another private host stay blocked, a hostname entry also matches the address the guard itself resolved
 *     for it (how nodemailer connects), and withdrawing the approval closes it again;
 *   · the store — the approvals live beside the egress allowlist without changing it, and an API token may
 *     withdraw an approval but never make one.
 */
process.env.NODE_ENV = 'production'; // the routes regenerate frontend registries outside production

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-private-egress-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const express = require('express');
const request = require('supertest');
const roles = require('../core/roles');
const perms = require('../core/plugin-permissions');
const hooks = require('../core/hooks');
const { setApp } = require('../core/appRegistry');
const iso = require('../core/plugin-isolate');
const eg = require('../core/egress-guard');
const pluginsRouter = require('../routes/plugins');

const SLUG = `wjs-privegress-${process.pid}`;
const FILTER = `wjs_private_egress_probe_${String(SLUG).replace(/[^a-z0-9]/gi, '_')}`;
const app = express();
app.use(express.json());
app.use(config.api.prefix, require('../routes'));
let adminToken = '';
let apiToken = '';
let entry = '';
const servers: any[] = [];
let P = 0; // the port that gets approved
let Q = 0; // another listening port on the same host — never approved

// From INSIDE the child: may it open a TCP connection to host:port? 'allowed' | 'blocked' | 'error:…'.
const PROBE_SOURCE = [
    "'use strict';",
    'exports.init = function (wordjs) {',
    `  wordjs.hooks.addFilter(${JSON.stringify(FILTER)}, async function (value) {`,
    '    const { p, q } = JSON.parse(value);',
    "    const net = require('net');",
    '    const tryConnect = (host, port) => new Promise((resolve) => {',
    '      let s; let done = false; const fin = (v) => { if (!done) { done = true; try { s && s.destroy(); } catch (e) { } resolve(v); } };',
    "      const verdict = (e) => (/blocked/i.test(String(e && e.message)) ? 'blocked' : 'error:' + String(e && e.message));",
    '      try { s = net.connect({ host, port }); } catch (e) { return fin(verdict(e)); }',
    "      s.once('connect', () => fin('allowed'));",
    "      s.once('error', (e) => fin(verdict(e)));",
    "      setTimeout(() => fin('timeout'), 4000);",
    '    });',
    "    const out = { approved: await tryConnect('127.0.0.1', p), otherPort: await tryConnect('127.0.0.1', q), otherHost: await tryConnect('127.0.0.2', p) };",
    "    out.byName = await tryConnect('localhost', p);",
    // What nodemailer does: resolve the name itself, then connect to the address.
    "    try { const r = await require('dns').promises.lookup('localhost', { family: 4 }); out.byResolvedAddress = await tryConnect(r.address, p); }",
    "    catch (e) { out.byResolvedAddress = 'error:' + String(e && e.message); }",
    '    return JSON.stringify(out);',
    '  });',
    '};',
    '',
].join('\n');

function listen(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer((sock: any) => sock.end());
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => { servers.push(srv); resolve(srv.address().port); });
    });
}

async function respawnAndProbe(): Promise<any> {
    if (iso.isIsolated(SLUG)) await iso.reloadIsolatedPlugin(SLUG);
    else await iso.loadIsolatedPlugin(SLUG, entry);
    return JSON.parse(await hooks.applyFilters(FILTER, JSON.stringify({ p: P, q: Q })));
}

// An API token (wjt_…), the credential that may narrow a plugin's reach but never widen it.
const postAsToken = (url: string, body: any) => request(app).post(url).set('Authorization', `Bearer ${apiToken}`).send(body);

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await roles.loadRoles();
    const User = require('../models/User');
    const admin = await User.create({ username: 'privegressadmin', email: 'privegressadmin@example.com', password: 'correct-horse-battery-9', role: 'administrator' });
    adminToken = jwt.sign({ userId: admin.id, username: 'privegressadmin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
    setApp(app);
    await require('../core/post-types').initPostTypes();
    const minted = await request(app).post(`${config.api.prefix}/auth/tokens`).set('Authorization', `Bearer ${adminToken}`).send({ name: 'ci', scopes: 'write' });
    assert.strictEqual(minted.status, 201, JSON.stringify(minted.body));
    apiToken = minted.body.token;
    const dir = pluginsRouter.resolveSafePluginDir(SLUG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, version: '1.0.0', isolated: true, permissions: [{ scope: 'network' }] }));
    entry = path.join(dir, 'index.js');
    fs.writeFileSync(entry, PROBE_SOURCE);
    await perms.loadGrants();
    await perms.loadEgressHosts();
    await perms.setGrants(SLUG, ['network']);
    P = await listen();
    Q = await listen();
}, { timeout: 60000 });

after(async () => {
    for (const s of iso.listIsolates()) { try { iso.unloadIsolatedPlugin(s); } catch { /* */ } }
    for (const srv of servers) { try { srv.close(); } catch { /* */ } }
    try { fs.rmSync(pluginsRouter.resolveSafePluginDir(SLUG), { recursive: true, force: true }); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
});

test('an entry is exactly one host and one port; metadata, link-local, unspecified and multicast can never be approved', () => {
    assert.deepStrictEqual(eg.parsePrivateDestination('192.168.1.20:587'), { host: '192.168.1.20', ip: 'v4:192.168.1.20', port: 587 });
    assert.strictEqual(eg.parsePrivateDestination('Relay.LAN:25').host, 'relay.lan');
    assert.strictEqual(eg.parsePrivateDestination('[fd00::25]:2525').port, 2525);
    for (const bad of [
        '192.168.1.20', 'relay.lan', '192.168.1.20:0', '192.168.1.20:70000', '*.lan:25', 'http://relay:25',
        '169.254.169.254:80', '169.254.1.1:25', '[fe80::1]:25', '0.0.0.0:25', '[::]:25', '224.0.0.1:25',
        '[::ffff:169.254.169.254]:80', 'fd00::25:25', 'a b:25', '',
    ]) {
        assert.strictEqual(eg.parsePrivateDestination(bad), null, `expected ${JSON.stringify(bad)} to be refused`);
    }
    // The store keeps the canonical spelling, de-duplicated and capped.
    assert.deepStrictEqual(perms.normalizePrivateDestinations(['192.168.1.20:587', ' 192.168.1.20:587 ', '[FD00::25]:25', '169.254.169.254:80']),
        ['192.168.1.20:587', '[fd00::25]:25']);
    assert.strictEqual(perms.normalizePrivateDestinations(['10.0.0.1:1', '10.0.0.1:2', '10.0.0.1:3', '10.0.0.1:4', '10.0.0.1:5']).length, 4);
    // The host ships approvals inside the allowlist it hands the child; they never switch the allowlist on.
    try { eg.setAllowedHosts(['192.168.1.20:587']); assert.strictEqual(eg.isHostAllowed('any.example.com'), true); }
    finally { eg.setAllowedHosts(null); }
});

// The metadata endpoint and the other never-approvable addresses have IPv6 spellings a translator, relay
// or tunnel routes to (NAT64, 6to4, ISATAP, Teredo — the same embedded-IPv4 forms isBlockedIp reads), and
// AWS also serves instance metadata at fd00:ec2::254. None of them can be approved; the private LAN
// addresses those forms wrap still can, exactly like their plain IPv4 spelling.
// MUTATION PROOF: isNeverExemptIp reading only the mapped/compatible form fails the first loop.
test('the IPv6 spellings of metadata and link-local addresses can never be approved either', () => {
    for (const bad of [
        '[64:ff9b::a9fe:a9fe]:80',          // NAT64 of 169.254.169.254
        '[64:ff9b::169.254.169.254]:80',    // the same, dotted
        '[2002:a9fe:a9fe::1]:80',           // 6to4 of 169.254.169.254
        '[2002:0:0::1]:25',                 // 6to4 of 0.0.0.0
        '[2002:e000:1::1]:25',              // 6to4 of 224.0.0.1 (multicast)
        '[2001:db8::5efe:a9fe:a9fe]:80',    // ISATAP of 169.254.169.254
        '[2001:0:a9fe:a9fe::1]:80',         // Teredo whose server is 169.254.169.254
        '[2001:0:4136:e378:8000:63bf:5601:5601]:80', // Teredo whose client is 169.254.169.254 (XOR-obfuscated)
        '[fd00:ec2::254]:80',               // AWS IMDS over IPv6
        '[fd00:0ec2:0000:0000:0000:0000:0000:0254]:80',
    ]) {
        assert.strictEqual(eg.parsePrivateDestination(bad), null, `expected ${JSON.stringify(bad)} to be refused`);
        assert.strictEqual(eg.isNeverExemptIp(bad.slice(1, bad.lastIndexOf(']'))), true, bad);
    }
    // A private LAN host stays approvable in every spelling, and a neighbouring fd00:ec2:: address is not the metadata one.
    for (const ok of ['[64:ff9b::c0a8:114]:587', '[2002:c0a8:114::1]:587', '[fd00:ec2::253]:53', '[::ffff:192.168.1.20]:587']) {
        assert.ok(eg.parsePrivateDestination(ok), `expected ${JSON.stringify(ok)} to be approvable`);
    }
    // And the plain loopback stays what it was.
    assert.strictEqual(eg.isNeverExemptIp('::1'), false);
});

test('without an approval a network-granted plugin reaches no private address', async () => {
    const r = await respawnAndProbe();
    assert.strictEqual(r.approved, 'blocked');
    assert.strictEqual(r.otherPort, 'blocked');
    assert.strictEqual(r.byName, 'blocked');
});

test('an API token cannot approve a private destination (it may only narrow)', async () => {
    const res = await postAsToken(`/api/v1/plugins/${SLUG}/private-egress`, { destinations: [`127.0.0.1:${P}`] });
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_token_management_forbidden');
    assert.deepStrictEqual(perms.getPrivateDestinations(SLUG), []);
});

test('an approved host:port connects; the same host on another port and another private host stay blocked', async () => {
    await perms.applyPrivateDestinations(SLUG, [`127.0.0.1:${P}`]);
    const r = await respawnAndProbe();
    assert.strictEqual(r.approved, 'allowed');
    assert.strictEqual(r.otherPort, 'blocked');
    assert.strictEqual(r.otherHost, 'blocked');
});

test('a hostname entry matches the name and the address the guard resolved for it', async () => {
    await perms.applyPrivateDestinations(SLUG, [`localhost:${P}`]);
    const r = await respawnAndProbe();
    assert.strictEqual(r.byName, 'allowed');
    assert.strictEqual(r.byResolvedAddress, 'allowed');
    assert.strictEqual(r.otherPort, 'blocked');
});

test('the approvals live beside the egress allowlist without changing it', async () => {
    await perms.applyPrivateDestinations(SLUG, [`127.0.0.1:${P}`]);
    await perms.setEgressAllowlist(SLUG, ['192.0.2.10']);
    assert.deepStrictEqual(perms.getEgressAllowlist(SLUG), ['192.0.2.10']);
    assert.deepStrictEqual(perms.getPrivateDestinations(SLUG), [`127.0.0.1:${P}`]);
    // An allowlist narrows PUBLIC egress; the approved private destination still connects.
    const r = await respawnAndProbe();
    assert.strictEqual(r.approved, 'allowed');
    await perms.setEgressAllowlist(SLUG, []);
    assert.deepStrictEqual(perms.getPrivateDestinations(SLUG), [`127.0.0.1:${P}`], 'clearing the allowlist keeps the approval');
});

test('GET lists the approvals; withdrawing them (allowed for a token) closes the destination again', async () => {
    const got = await request(app).get(`/api/v1/plugins/${SLUG}/private-egress`).set('Authorization', `Bearer ${adminToken}`);
    assert.strictEqual(got.status, 200);
    assert.deepStrictEqual(got.body.destinations, [`127.0.0.1:${P}`]);
    assert.strictEqual(got.body.network, true);
    const res = await postAsToken(`/api/v1/plugins/${SLUG}/private-egress`, { destinations: [] });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.destinations, []);
    assert.strictEqual(res.body.reloaded, true);
    const r = JSON.parse(await hooks.applyFilters(FILTER, JSON.stringify({ p: P, q: Q })));
    assert.strictEqual(r.approved, 'blocked');
});
