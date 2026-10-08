/**
 * A server's listen(port, host) and a dgram socket's bind(port, address), in a REAL isolated child, under
 * each of the three egress-policy states.
 *
 * Resolving a name is egress in its own right: the query reaches that domain's nameserver whether or not
 * anything connects afterwards. listen/bind do not go through a connect path; they resolve their host
 * through Node's own dns.lookup (net's lookupAndListen, a dgram socket's default lookup). The child gates
 * that function (egress-guard.installChildResolverGate, installed by plugin-worker.js) so the host they
 * are given gets the connection rule:
 *   · an IP literal, or no host at all, is not a query and behaves exactly as before;
 *   · a NAME is judged by the plugin's egress policy BEFORE it is resolved — an allowlisted plugin may only
 *     resolve a listed name, deny-all resolves none, and with no policy configured it passes through.
 *
 * Three fixtures, one per policy state, each loaded in its own forked plugin-worker.js:
 *   OPEN  — a loaded, empty allowlist (allow-all-public);
 *   LIST  — allowlist ['vendor.example', 'localhost'];
 *   DENY  — the fail-closed state the host spawns when it could not load the policy.
 *
 * A refusal by the policy carries the sandbox's "[sandbox] network egress ... blocked" message, delivered as
 * the server's / socket's 'error' event like any resolution failure. The probe name is under the reserved
 * .invalid TLD and is only ever offered to a child whose policy refuses it, so this file never sends a query
 * for it. 'localhost' resolves without a nameserver. Where the platform's kernel confinement denies
 * inbound sockets outright (the Linux and macOS shims), an allowed listen/bind ends in EPERM/EACCES from the
 * kernel instead of LISTENING/BOUND; either outcome shows the egress policy did not refuse it.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app'); // preload trusted host context (io-guard no-ops for core)
const TMP_DB = path.join(os.tmpdir(), `wjs-listen-bind-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const express = require('express');
const request = require('supertest');
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');
const { setApp } = require('../core/appRegistry');
const perms = require('../core/plugin-permissions');

const PLUGINS_ROOT = path.resolve(__dirname, '../../plugins');
const OPEN = 'wjs-listen-bind-open';
const LIST = 'wjs-listen-bind-list';
const DENY = 'wjs-listen-bind-deny';

const app = express();
app.use(express.json());

// Each probe settles to one string: LISTENING / BOUND, or ERR:<code>:<message>.
const INIT = `
  const NAME = 'wjs-listen-probe-' + process.pid + '.invalid';
  const settle = (fn) => new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try { fn(fin); } catch (e) { fin('THREW:' + String(e && e.message)); }
    setTimeout(() => fin('TIMEOUT'), 8000);
  });
  const errText = (e) => 'ERR:' + ((e && e.code) || '') + ':' + String(e && e.message);
  const listen = (mod, args) => settle((fin) => {
    const srv = require(mod).createServer();
    srv.on('error', (e) => fin(errText(e)));
    srv.listen(...args, () => { srv.close(); fin('LISTENING'); });
  });
  const bind = (args) => settle((fin) => {
    const s = require('dgram').createSocket('udp4');
    s.on('error', (e) => { try { s.close(); } catch (_) {} fin(errText(e)); });
    s.bind(...args, () => { try { s.close(); } catch (_) {} fin('BOUND'); });
  });
  wordjs.http.route('get', '/probe', async (req, res) => {
    const named = req.query && req.query.named === '1';
    const out = {};
    // No host and IP literals: never a query, never judged.
    out.netListenNoHost = await listen('net', [0]);
    out.netListenIp = await listen('net', [0, '127.0.0.1']);
    out.dgramBindNoHost = await bind([0]);
    out.dgramBindIp = await bind([0, '127.0.0.1']);
    // 'localhost' is a NAME: judged by the policy, then resolved locally if allowed.
    out.netListenLocalhost = await listen('net', [0, 'localhost']);
    out.dgramBindLocalhost = await bind([0, 'localhost']);
    // The gated lookup keeps the builtin's promisify marker, so the plugin's dns.lookup still promisifies
    // to { address, family } (an IP literal: no query).
    out.promisifiedLookup = await (async () => { try { return await require('util').promisify(require('dns').lookup)('127.0.0.1'); } catch (e) { return errText(e); } })();
    if (named) {
      // A name the policy refuses, in every argument shape a host can arrive in.
      out.netListenName = await listen('net', [0, NAME]);
      out.netListenOptionsName = await listen('net', [{ port: 0, host: NAME }]);
      out.httpListenName = await listen('http', [0, NAME]);
      out.dgramBindName = await bind([0, NAME]);
      out.dgramBindOptionsName = await bind([{ port: 0, address: NAME }]);
    }
    res.json(out);
  });
`;

function writeFixture(slug: string): string {
    const dir = path.join(PLUGINS_ROOT, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'),
        JSON.stringify({ name: slug, isolated: true, permissions: [{ scope: 'express', access: 'register_route' }] }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'exports.init = function (wordjs) {\n' + INIT + '\n};\n');
    return dir;
}

const loadWithTimeout = (slug: string, entry: string, ms = 45000) => {
    let timer: any;
    return Promise.race([
        loadIsolatedPlugin(slug, entry),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`isolated plugin load timed out: ${slug}`)), ms); }),
    ]).finally(() => clearTimeout(timer));
};

const dirs: string[] = [];
before(async () => {
    setApp(app);
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    for (const slug of [OPEN, LIST, DENY]) {
        dirs.push(writeFixture(slug));
        perms._setGrantsInMemory(slug, ['express:register_route', perms.NETWORK_TOKEN]);
    }
    perms._setEgressAllowlistInMemory(OPEN, []);
    perms._setEgressAllowlistInMemory(LIST, ['vendor.example', 'localhost']);
    await loadWithTimeout(OPEN, path.join(PLUGINS_ROOT, OPEN, 'index.js'));
    await loadWithTimeout(LIST, path.join(PLUGINS_ROOT, LIST, 'index.js'));
    // The host spawns a network-granted plugin deny-all when its egress policy is not loaded (F-06).
    const loaded = perms.isEgressPolicyLoaded;
    perms.isEgressPolicyLoaded = () => false;
    try {
        await loadWithTimeout(DENY, path.join(PLUGINS_ROOT, DENY, 'index.js'));
    } finally {
        perms.isEgressPolicyLoaded = loaded;
    }
}, { timeout: 150000 });

after(async () => {
    for (const slug of [OPEN, LIST, DENY]) {
        try { unloadIsolatedPlugin(slug); } catch { /* */ }
        try { perms._setGrantsInMemory(slug, []); } catch { /* */ }
    }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
}, { timeout: 30000 });

const probe = async (slug: string, named: boolean) =>
    (await request(app).get(`/api/v1/plugin/${slug}/probe${named ? '?named=1' : ''}`).timeout(120000)).body;

// Refused by the egress policy, before any resolution.
const REFUSED = /^ERR::\[sandbox\] network egress to .* is blocked/;
// Not refused by the policy: it listened, or the platform's kernel confinement denied the inbound socket.
const NOT_REFUSED = /^(LISTENING|BOUND|ERR:(EPERM|EACCES):)/;

function expectAll(r: any, keys: string[], re: RegExp, why: string) {
    for (const k of keys) assert.match(String(r && r[k]), re, `${k}: ${why} (got ${JSON.stringify(r && r[k])})`);
}

const UNJUDGED = ['netListenNoHost', 'netListenIp', 'dgramBindNoHost', 'dgramBindIp'];
const LOCALHOST = ['netListenLocalhost', 'dgramBindLocalhost'];
const NAMED = ['netListenName', 'netListenOptionsName', 'httpListenName', 'dgramBindName', 'dgramBindOptionsName'];

describe('listen/bind host under the egress policy (real fork)', () => {
    test('no policy configured: names, IP literals and no host all listen as before', async () => {
        const r = await probe(OPEN, false);
        expectAll(r, [...UNJUDGED, ...LOCALHOST], NOT_REFUSED, 'nothing is refused without a policy');
        assert.deepStrictEqual(r.promisifiedLookup, { address: '127.0.0.1', family: 4 }, 'util.promisify(dns.lookup) keeps its { address, family } shape');
    }, { timeout: 150000 });

    test('allowlist: a name off the list is refused before it is resolved; a listed name and IP literals are not', async () => {
        const r = await probe(LIST, true);
        expectAll(r, NAMED, REFUSED, 'an off-allowlist name must be refused by the policy, not resolved');
        expectAll(r, LOCALHOST, NOT_REFUSED, "'localhost' is on the allowlist");
        expectAll(r, UNJUDGED, NOT_REFUSED, 'an IP literal or no host is not a query');
    }, { timeout: 150000 });

    test('deny-all: every name is refused, including localhost; IP literals and no host are not', async () => {
        const r = await probe(DENY, true);
        expectAll(r, [...NAMED, ...LOCALHOST], REFUSED, 'deny-all resolves no name');
        expectAll(r, UNJUDGED, NOT_REFUSED, 'an IP literal or no host is not a query');
    }, { timeout: 150000 });
});
