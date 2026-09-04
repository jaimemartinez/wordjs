/**
 * END-TO-END SANDBOX ESCAPE HARNESS
 *
 * Every OTHER sandbox/security test in this repo proves containment by calling a guard function
 * IN-PROCESS (runWithContext(slug, ...) against the monkey-patched fs/require of THIS process) or by
 * statically scanning source (the AST scanner). The ONE exception, plugin-isolate.test.ts, forks a real
 * worker but only asserts NETWORK containment.
 *
 * This harness closes that gap: it BOOTS actual malicious plugins in the real child_process isolation
 * (loadIsolatedPlugin → fork of plugin-worker.js, which re-installs io-guard + secure-require + the
 * ESM/net guards inside the child) and drives each escape attempt over the real RPC/HTTP path, asserting
 * containment. It covers vectors that are STRUCTURALLY impossible to exercise in-process — e.g. the raw
 * DB-file block is gated on `global.__WORDJS_ISOLATED__`, which is only ever set inside the fork.
 *
 * LOAD-BEARING BY CONSTRUCTION: every probe is arranged so exactly ONE guard can deny it, and a host
 * positive-control proves the same operation succeeds from trusted core context. io-guard checks in order
 * BLOCKED_FILES → DB-file → exec-write → secret-pattern → safe-zones, so, e.g., the fork-only DB-file
 * rule is isolated by putting a `.db` decoy INSIDE the plugin's own (zone-allowed) dir — the zone would
 * allow it, so only the DB rule can block it. The zone rule itself is isolated with a benign-named file
 * OUTSIDE every zone. If the specific guard under test were deleted, the corresponding probe flips to
 * "not blocked" and the test fails — a broken sandbox cannot pass this file.
 *
 * Two fixtures:
 *   • UNGRANTED (permissions:[], no grants) — the always-on isolation: fs, require, ESM import, network,
 *     secret-env, IPC bridge-allowlist, and self-grant immutability (none depend on a permission grant).
 *   • GRANTED (database + settings + network, actually granted via _setGrantsInMemory before load) — proves
 *     the guards contain even a FULLY-granted plugin: the SQL scope guard, protected-option guard, and the
 *     egress guard (SSRF) still hold.
 *
 * DELIBERATELY DEFERRED (heavier infra / CI-flaky; tracked as follow-ups, NOT silently dropped): off-heap
 * memory-exhaustion (the 512MB memWatch self-terminate — a real balloon is slow and flaky in CI);
 * DNS-rebind and HTTP-redirect-to-private SSRF (need a harness DNS + redirect server); and a fully custom
 * raw-IPC worker entry that bypasses the wordjs bridge (this file exercises the host bridge allowlist via
 * process.send, which is the channel actually reachable from plugin code).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app'); // preload trusted host context (io-guard no-ops for core)
// Repoint the DB at a throwaway temp file BEFORE the DB layer / plugin-isolate resolve it, so the GRANTED
// fixture's db RPC (own-table create/select control) has a live DB — and the real data DB is never touched.
const TMP_DB = path.join(os.tmpdir(), `wjs-escape-e2e-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const express = require('express');
const request = require('supertest');
const net = require('net');
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');
const { setApp } = require('../core/appRegistry');
const perms = require('../core/plugin-permissions');

const PLUGINS_ROOT = path.resolve(__dirname, '../../plugins');
const UNGRANTED = 'wjs-escape-ungranted';
const GRANTED = 'wjs-escape-granted';
const SIBLING_TABLE = 'wjp_online_store_orders'; // a table owned by a DIFFERENT (absent) plugin's prefix
const PREFIX = ('wjp_' + GRANTED.replace(/[^A-Za-z0-9]+/g, '_') + '_').toLowerCase();

// Secrets we plant in the HOST env: the child's env is a strict allowlist (SAFE_ENV_KEYS), so these must be
// present in the host but ABSENT in the child. Using real secret names makes the assertion load-bearing.
const ENV_SENTINELS: Record<string, string> = {
    JWT_SECRET: 'wjs-sentinel-jwt-' + process.pid,
    SESSION_SECRET: 'wjs-sentinel-session-' + process.pid,
    DATABASE_URL: 'postgres://sentinel:' + process.pid + '@127.0.0.1/x',
    DB_PASSWORD: 'wjs-sentinel-dbpass-' + process.pid,
};

const app = express();
app.use(express.json());

// A benign-named file OUTSIDE every safe-zone: only the ZONE rule (not BLOCKED_FILES/DB/secret-pattern) can
// deny it, so it isolates the zone boundary. It EXISTS + is host-readable so a "blocked" result can't be a
// false ENOENT. The out-of-zone WRITE target reuses the same dir.
const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-esc-'));
const benignOutOfZone = path.join(secretDir, 'notes.txt');
const benignOutOfZoneWrite = path.join(secretDir, 'written-by-plugin.txt');
const SECRET_CONTENT = 'TOP-SECRET-' + process.pid;

// Host-owned loopback listener: a network-granted plugin's SSRF attempt to it must be egress-blocked, so
// this must record ZERO connections. If egress-guard were broken, the connection would land here.
let ssrfHits = 0;
const ssrfListener = net.createServer((s: any) => { ssrfHits++; try { s.destroy(); } catch { /* */ } });
let ssrfPort = 0;

function writeFixture(slug: string, manifestPerms: any[], initBody: string) {
    const dir = path.join(PLUGINS_ROOT, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'),
        JSON.stringify({ name: slug, isolated: true, permissions: manifestPerms }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'exports.init = function (wordjs) {\n' + initBody + '\n};\n');
    return dir;
}

// ── UNGRANTED fixture: the always-on isolation (no permission grants involved) ───────────────────────
// Each probe reports booleans where TRUE == the escape was BLOCKED (contained). Decoys named 'decoy.db'
// and 'wordjs-config.json' are written by the harness INTO this plugin's own dir (a zone-allowed read
// area), so ONLY the DB-file rule / BLOCKED_FILES rule can deny reading them — isolating those guards.
const UNGRANTED_INIT = `
  wordjs.http.route('get', '/fs-read', async (req, res) => {
    const q = req.query || {};
    const fsm = require('fs'); const p = require('path');
    const blk = (target) => { if (!target) return null; try { fsm.readFileSync(target, 'utf8'); return false; } catch { return true; } };
    const out = {};
    out.inZoneDb = blk(p.join(__dirname, 'decoy.db'));             // own dir (zone OK) -> only the .db rule can block
    out.inZoneConfig = blk(p.join(__dirname, 'wordjs-config.json'));// own dir (zone OK) -> only BLOCKED_FILES can block
    out.outOfZoneBenign = blk(q.benign);                           // benign name, out of zone -> only the zone rule
    out.realDb = q.realdb ? blk(q.realdb) : null;                  // the actual configured DB path
    try { await fsm.promises.readFile(q.benign, 'utf8'); out.promises = false; } catch { out.promises = true; }
    out.stream = await new Promise((resolve) => {
      try {
        const s = fsm.createReadStream(q.benign);
        s.on('error', () => resolve(true));
        s.on('data', () => { try { s.destroy(); } catch (e) {} resolve(false); });
        s.on('end', () => resolve(true));
      } catch { resolve(true); }
    });
    res.json(out);
  });

  wordjs.http.route('get', '/fs-write', (req, res) => {
    const fsm = require('fs'); const p = require('path'); const q = req.query || {};
    const out = {};
    // A non-exec write in the plugin's OWN dir IS allowed — precondition proving the launder/exec blocks below
    // are the exec-extension rule, not a blanket own-dir write denial.
    out.ownTxtWrite = (() => { try { fsm.writeFileSync(p.join(__dirname, 'payload.txt'), 'x'); return true; } catch { return false; } })();
    out.execWrite = (() => { try { fsm.writeFileSync(p.join(__dirname, 'pwn.js'), 'x'); return false; } catch { return true; } })();
    out.copyLaunder = (() => { try { fsm.copyFileSync(p.join(__dirname, 'payload.txt'), p.join(__dirname, 'copied.js')); return false; } catch { return true; } })();
    out.outWrite = q.out ? (() => { try { fsm.writeFileSync(q.out, 'x'); return false; } catch { return true; } })() : null; // benign, out of zone -> zone rule
    // symlink to an IN-ZONE own-dir target: the zone would allow the path, so only link-denial (or, on
    // Windows, the unprivileged-symlink EPERM) can block it — isolating the link rule.
    out.symlink = (() => { try { fsm.symlinkSync(p.join(__dirname, 'manifest.json'), p.join(__dirname, 'link.txt')); return false; } catch { return true; } })();
    res.json(out);
  });

  wordjs.http.route('get', '/require', (req, res) => {
    const out = {};
    // secure-require returns an INERT hard-blocking proxy for dangerous modules — require() itself does NOT
    // throw, and property access may hand back a throwing STUB function. So the only honest test is to
    // actually INVOKE the dangerous capability: blocked == the exploit threw before doing anything.
    const blk = (name, exploit) => { try { exploit(require(name)); return false; } catch { return true; } };
    out.child_process = blk('child_process', m => m.execSync('echo wjs'));
    out.node_child_process = blk('node:child_process', m => m.execSync('echo wjs'));
    out.worker_threads = blk('worker_threads', m => { const w = new m.Worker('data:text/javascript,0'); w.terminate(); });
    out.vm = blk('vm', m => m.runInNewContext('1'));
    out.net = blk('net', m => m.connect(1, '127.0.0.1').destroy());
    out.dgram = blk('dgram', m => m.createSocket('udp4').close());
    out.binding = (() => { try { process.binding('spawn_sync'); return false; } catch { return true; } })();
    out.dlopen = (() => { try { process.dlopen({ exports: {} }, __filename); return false; } catch { return true; } })();
    out.getBuiltinModule = (() => {
      try { const m = process.getBuiltinModule && process.getBuiltinModule('child_process'); if (!m || typeof m.execSync !== 'function') return true; m.execSync('echo wjs'); return false; }
      catch { return true; }
    })();
    out.rce = (() => { try { require('child_process').execSync('echo pwned'); return false; } catch { return true; } })();

    // Surface reached WITHOUT the module loader. \`process\` is a global, so the denylist never sees it;
    // each of these is an individually patched method. A probe here must distinguish "the sandbox
    // refused" from "this Node/OS does not have it" — otherwise it passes for the wrong reason on a
    // platform where the API simply is not implemented, which is no evidence at all.
    const SEC = /not permitted|blocked|sandbox|Security/i;
    const blkProc = (name, exploit) => {
      if (typeof process[name] !== 'function') return 'absent';
      try { exploit(); return false; } catch (e) { return SEC.test(String(e && e.message)) ? true : 'other:' + String(e && e.message).slice(0, 60); }
    };
    // Replaces the process image with another executable — discards every JS-level guard in one call.
    out.execve = blkProc('execve', () => process.execve('/bin/true', ['/bin/true'], {}));
    // Signals a process to start its inspector; a native path the blocked \`inspector\` module never sees.
    out.debugProcess = blkProc('_debugProcess', () => process._debugProcess(process.pid));
    // Reads a file in C++ (never reaching io-guard) and merges it into process.env.
    out.loadEnvFile = blkProc('loadEnvFile', () => process.loadEnvFile('/nonexistent-wordjs-probe.env'));
    // Subscribing to the host's internal channels yields its outbound requests, headers included.
    out.diagnostics_channel = blk('diagnostics_channel', m => m.subscribe('http.client.request.created', () => {}));
    out.node_diagnostics_channel = blk('node:diagnostics_channel', m => m.subscribe('http.client.request.created', () => {}));

    res.json(out);
  });

  wordjs.http.route('get', '/esm', async (req, res) => {
    // ESM import() uses the V8 loader, NOT the CJS require proxy. Prove each dangerous import cannot yield a
    // WORKING exploit (run a command, read a forbidden file, open a socket, spawn a thread) — testing actual
    // exploitation, not mere capability presence (fs's readFileSync exists but io-guard patches it in place).
    const q = req.query || {};
    const pick = (m, k) => (m && m[k]) || (m && m.default && m.default[k]);
    const blk = async (spec, exploit) => { try { const m = await import(spec); await exploit(m); return false; } catch { return true; } };
    const out = {};
    out.child_process = await blk('node:child_process', m => pick(m, 'execSync')('echo wjs'));
    out.fs = await blk('node:fs', m => pick(m, 'readFileSync')(q.benign, 'utf8'));  // read a forbidden path
    out.net = await blk('node:net', m => pick(m, 'connect')(1, '127.0.0.1').destroy());
    out.worker_threads = await blk('node:worker_threads', m => { const w = new (pick(m, 'Worker'))('data:text/javascript,0'); w.terminate(); });
    res.json(out);
  });

  wordjs.http.route('get', '/net', (req, res) => {
    const out = {};
    out.fetchTrapped = (() => { try { void fetch; return false; } catch { return true; } })();
    out.net = (() => { try { require('net').createConnection(80, 'example.com'); return false; } catch { return true; } })();
    out.dgram = (() => { try { require('dgram').createSocket('udp4'); return false; } catch { return true; } })();
    out.http = (() => { try { require('http').get('http://example.com'); return false; } catch { return true; } })();
    res.json(out);
  });

  wordjs.http.route('get', '/secrets-env', (req, res) => {
    res.json({
      jwt: process.env.JWT_SECRET || null,
      session: process.env.SESSION_SECRET || null,
      dbUrl: process.env.DATABASE_URL || null,
      dbPass: process.env.DB_PASSWORD || process.env.PGPASSWORD || null,
    });
  });

  wordjs.http.route('get', '/self-grant', (req, res) => {
    const out = {};
    const beforeSlug = global.__WORDJS_PLUGIN_SLUG__;
    try { global.__WORDJS_PLUGIN_SLUG__ = null; } catch (e) {}
    try { delete global.__WORDJS_PLUGIN_SLUG__; } catch (e) {}
    try { Object.defineProperty(global, '__WORDJS_PLUGIN_SLUG__', { value: 'core' }); } catch (e) {}
    out.slugImmutable = global.__WORDJS_PLUGIN_SLUG__ === beforeSlug && beforeSlug != null;
    const beforeNet = global.__WORDJS_PLUGIN_NETWORK__;
    try { global.__WORDJS_PLUGIN_NETWORK__ = true; } catch (e) {}
    out.netImmutable = global.__WORDJS_PLUGIN_NETWORK__ === beforeNet;
    res.json(out);
  });

  wordjs.http.route('get', '/ipc', async (req, res) => {
    // Even though plugin code CAN reach the raw IPC channel, the HOST enforces ALLOWED_BRIDGE_METHODS: a
    // raw {kind:'call'} for a real api method that is NOT on the allowlist (provideMail — becoming the mail
    // provider) must be rejected with "not permitted", never executed. Post it directly and read the reply.
    // process.send is now refused at the source for plugin code (secure-require PROC_BLOCKED): a
    // forged control frame never leaves the child. That is contained, and strictly stronger than
    // the host allowlist refusing it. Probe the guard first; fall through to the host path only if
    // the guard is somehow absent, so that the host allowlist remains the second line.
    let blockedAtSource = false;
    try { process.send({ kind: 'call', id: 'wjs-guard-probe', method: 'provideMail', args: [{}] }); }
    catch (e) { blockedAtSource = /not permitted|SECURITY BLOCK/i.test(String(e && e.message || e)); }
    if (blockedAtSource) return res.json({ reachable: false, notPermitted: true, blockedAtSource: true });
    const reachable = typeof process.send === 'function' && typeof process.on === 'function';
    if (!reachable) return res.json({ reachable: false, notPermitted: true });
    const reply = await new Promise((resolve) => {
      const id = 'wjs-evil-ipc';
      const onMsg = (m) => { if (m && m.kind === 'reply' && m.id === id) { try { process.removeListener('message', onMsg); } catch (e) {} resolve(m); } };
      process.on('message', onMsg);
      try { process.send({ kind: 'call', id, method: 'provideMail', args: [{}] }); } catch (e) {}
      setTimeout(() => { try { process.removeListener('message', onMsg); } catch (e) {} resolve(null); }, 1500);
    });
    const notPermitted = !!(reply && reply.ok === false && /not permitted/i.test(String(reply.error || '')));
    res.json({ reachable, notPermitted, reply: reply ? { ok: reply.ok, error: String(reply.error || '').slice(0, 120) } : null });
  });
`;

// ── GRANTED fixture: db + settings + network actually granted — guards must STILL contain it ──────────
const GRANTED_INIT = `
  const PREFIX = ${JSON.stringify(PREFIX)};
  const SIBLING = ${JSON.stringify(SIBLING_TABLE)};

  wordjs.http.route('get', '/sql', async (req, res) => {
    const out = {};
    const blk = async (sql, params) => { try { await wordjs.db.all(sql, params || []); return false; } catch { return true; } };
    const blkRun = async (sql) => { try { await wordjs.db.run(sql); return false; } catch { return true; } };
    // Positive control INSIDE the sandbox: the plugin's OWN prefixed table works (so the denials below mean
    // "scope guard blocked it", not "db bridge is dead" or "no such table").
    out.ownCreate = await (async () => { try { await wordjs.db.run('CREATE TABLE IF NOT EXISTS ' + PREFIX + 'probe (id INTEGER)'); return true; } catch (e) { return String(e && e.message || e); } })();
    out.ownSelect = await (async () => { try { await wordjs.db.all('SELECT * FROM ' + PREFIX + 'probe'); return true; } catch (e) { return String(e && e.message || e); } })();
    // Escapes (TRUE == blocked). Every core/sibling target EXISTS in the DB, so the ONLY possible denial is
    // the scope guard (assertSqlAllowed), never a "no such table".
    out.users = await blk('SELECT * FROM users');
    out.userPass = await blk('SELECT user_pass FROM users LIMIT 1');
    out.optionsSecret = await blk("SELECT option_value FROM options WHERE option_name = 'jwt_secret'");
    out.sibling = await blk('SELECT * FROM ' + SIBLING);
    out.commaJoin = await blk('SELECT * FROM ' + PREFIX + 'probe, users');
    out.subquery = await blk('SELECT (SELECT user_pass FROM users LIMIT 1) AS x FROM ' + PREFIX + 'probe');
    out.union = await blk('SELECT id FROM ' + PREFIX + 'probe UNION SELECT id FROM users');
    out.quotedAlias = await blk('SELECT * FROM "users"');
    out.commented = await blk('SELECT * FROM ' + PREFIX + 'probe /* , users */ , users');
    out.pragma = await blk('PRAGMA table_info(users)');
    out.catalog = await blk('SELECT name FROM sqlite_master');
    out.attach = await blkRun("ATTACH DATABASE 'x.db' AS y");           // via run (all() would reject non-returning first)
    out.stacked = await blk('SELECT 1 FROM ' + PREFIX + 'probe; DROP TABLE users');
    out.returning = await blkRun('DELETE FROM ' + PREFIX + 'probe RETURNING id');
    res.json(out);
  });

  wordjs.http.route('get', '/options', async (req, res) => {
    const out = {};
    out.jwtSecret = await (async () => { try { await wordjs.options.get('jwt_secret'); return false; } catch { return true; } })();
    out.pluginGrants = await (async () => { try { await wordjs.options.get('plugin_grants'); return false; } catch { return true; } })();
    out.userRoles = await (async () => { try { await wordjs.options.get('user_roles'); return false; } catch { return true; } })();
    // Control: a NON-secret option is readable (proves the options bridge itself works — getOption returns
    // null without throwing when unguarded, so a guarded rejection above is load-bearing).
    out.blognameReadable = await (async () => { try { await wordjs.options.get('blogname'); return true; } catch { return false; } })();
    res.json(out);
  });

  wordjs.http.route('get', '/ssrf', async (req, res) => {
    const out = {};
    const port = req.query && req.query.port;
    // Discriminator: for a NETWORK-GRANTED plugin fetch is DEFINED (vs trapped-on-access when ungranted) —
    // proving the grant flipped, so the blocks below are the egress guard, not the blanket network trap.
    out.fetchDefined = (() => { try { return typeof fetch === 'function'; } catch { return false; } })();
    const tryFetch = async (url) => { try { await fetch(url); return false; } catch { return true; } };
    out.loopback = await tryFetch('http://127.0.0.1:' + port + '/');
    out.metadata = await tryFetch('http://169.254.169.254/latest/meta-data/');
    out.ipv6Loopback = await tryFetch('http://[::1]:' + port + '/');
    out.ipv4Mapped = await tryFetch('http://[::ffff:127.0.0.1]:' + port + '/');
    out.rfc1918 = await tryFetch('http://10.0.0.1/');
    out.netConnect = await new Promise((resolve) => {
      try {
        const s = require('net').connect(Number(port), '127.0.0.1');
        s.on('error', () => resolve(true));
        s.on('connect', () => { try { s.destroy(); } catch (e) {} resolve(false); });
        setTimeout(() => { try { s.destroy(); } catch (e) {} resolve(true); }, 1500);
      } catch { resolve(true); }
    });
    res.json(out);
  });
`;

let ungrantedDir = '';
let grantedDir = '';

// clearTimeout is load-bearing: on the common path the load resolves well before `ms`, leaving the
// ref'd 45s timer armed and keeping this subprocess alive → `--test-force-exit` hard-kills it mid-IPC →
// the intermittent "Unable to deserialize cloned data" flake. Drain it so the subprocess exits cleanly.
const loadWithTimeout = (slug: string, entry: string, ms = 45000) => {
    let timer: any;
    return Promise.race([
        loadIsolatedPlugin(slug, entry),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`isolated plugin load timed out: ${slug}`)), ms); }),
    ]).finally(() => clearTimeout(timer));
};

before(async () => {
    setApp(app);
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    // A sibling-owned table so the granted fixture's cross-plugin SELECT is denied by the SCOPE guard, not
    // by "no such table" (host context — created directly, bypassing the plugin guard).
    const dbAsync = database.getDbAsync();
    await dbAsync.run(`CREATE TABLE IF NOT EXISTS ${SIBLING_TABLE} (id INTEGER PRIMARY KEY, note TEXT)`);
    await dbAsync.run(`INSERT INTO ${SIBLING_TABLE} (note) VALUES ('sibling-secret')`);

    // Plant real secret names in the host env; the child's env allowlist must strip them.
    for (const [k, v] of Object.entries(ENV_SENTINELS)) process.env[k] = v;

    fs.writeFileSync(benignOutOfZone, SECRET_CONTENT);
    await new Promise<void>((resolve) => ssrfListener.listen(0, '127.0.0.1', () => resolve()));
    ssrfPort = (ssrfListener.address() as any).port;

    ungrantedDir = writeFixture(UNGRANTED, [], UNGRANTED_INIT);
    // In-zone decoys inside the UNGRANTED plugin's own dir: only the DB-file / BLOCKED_FILES rules can deny
    // reading these (the own-dir zone would otherwise allow them), isolating those guards.
    fs.writeFileSync(path.join(ungrantedDir, 'decoy.db'), SECRET_CONTENT);
    fs.writeFileSync(path.join(ungrantedDir, 'wordjs-config.json'), '{"secret":"' + SECRET_CONTENT + '"}');

    grantedDir = writeFixture(GRANTED, [
        { scope: 'database', access: 'read' },
        { scope: 'database', access: 'write' },
        { scope: 'settings', access: 'read' },
    ], GRANTED_INIT);

    // Grant the GRANTED fixture BEFORE load so cfg.network resolves true at spawn (host context — allowed).
    perms._setGrantsInMemory(GRANTED, ['database:read', 'database:write', 'settings:read', perms.NETWORK_TOKEN]);

    await loadWithTimeout(UNGRANTED, path.join(ungrantedDir, 'index.js'));
    await loadWithTimeout(GRANTED, path.join(grantedDir, 'index.js'));
}, { timeout: 120000 });

after(async () => {
    try { unloadIsolatedPlugin(UNGRANTED); } catch { /* */ }
    try { unloadIsolatedPlugin(GRANTED); } catch { /* */ }
    try { ssrfListener.close(); } catch { /* */ }
    try { perms._setGrantsInMemory(GRANTED, []); } catch { /* */ }
    for (const k of Object.keys(ENV_SENTINELS)) { try { delete process.env[k]; } catch { /* */ } }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const d of [ungrantedDir, grantedDir, secretDir]) {
        try { if (d) fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ }
    }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* */ }
    }
}, { timeout: 30000 });

const probe = async (slug: string, route: string, qs = '') =>
    (await request(app).get(`/api/v1/plugin/${slug}/${route}${qs}`)).body;

const allTrue = (obj: any, keys: string[]) => {
    for (const k of keys) assert.strictEqual(obj[k], true, `expected ${k} to be BLOCKED (true), got ${JSON.stringify(obj[k])}`);
};

// ── NEGATIVE CONTROL: the same targets are reachable from trusted host/core context ──────────────────
// If these fail, the "blocked" results below would be meaningless (ENOENT / broken op / vacuous absence).
describe('negative control (trusted host context can do what the sandbox blocks)', () => {
    test('host CAN read the in-zone .db + blocked-name decoys and the out-of-zone benign file (they exist)', () => {
        assert.strictEqual(fs.readFileSync(path.join(ungrantedDir, 'decoy.db'), 'utf8'), SECRET_CONTENT);
        assert.ok(fs.readFileSync(path.join(ungrantedDir, 'wordjs-config.json'), 'utf8').includes(SECRET_CONTENT));
        assert.strictEqual(fs.readFileSync(benignOutOfZone, 'utf8'), SECRET_CONTENT);
    });
    test('the secret env sentinels ARE set in the host process (so the child stripping them is meaningful)', () => {
        for (const [k, v] of Object.entries(ENV_SENTINELS)) assert.strictEqual(process.env[k], v, `${k} must be set in the host`);
    });
    test('host CAN require child_process and connect to the loopback listener', async () => {
        assert.ok(require('child_process').execSync, 'core can load child_process');
        await new Promise<void>((resolve, reject) => {
            const s = net.connect(ssrfPort, '127.0.0.1');
            s.on('connect', () => { s.destroy(); resolve(); });
            s.on('error', reject);
        });
        assert.ok(ssrfHits >= 1, 'the loopback listener accepts real connections (so a plugin hit would register)');
    });
});

describe('sandbox escape — filesystem (ungranted fixture, real fork)', () => {
    test('cannot READ: in-zone .db (DB rule), in-zone wordjs-config.json (BLOCKED_FILES), out-of-zone benign (zone rule)', async () => {
        const qs = `?benign=${encodeURIComponent(benignOutOfZone)}&realdb=${encodeURIComponent(String(config.dbPath || TMP_DB))}`;
        const r = await probe(UNGRANTED, 'fs-read', qs);
        allTrue(r, ['inZoneDb', 'inZoneConfig', 'outOfZoneBenign', 'promises', 'stream']);
        if (r.realDb !== null) assert.strictEqual(r.realDb, true, 'the real configured DB file must be unreadable from the fork');
    });
    test('cannot WRITE: executable code, launder txt→js, out-of-zone, or symlink', async () => {
        const r = await probe(UNGRANTED, 'fs-write', `?out=${encodeURIComponent(benignOutOfZoneWrite)}`);
        assert.strictEqual(r.ownTxtWrite, true, 'a plugin CAN write a non-exec file in its own dir (precondition for the launder/exec tests)');
        allTrue(r, ['execWrite', 'copyLaunder', 'outWrite', 'symlink']);
        assert.ok(!fs.existsSync(benignOutOfZoneWrite), 'the out-of-zone write must not have landed on disk');
    });
});

describe('sandbox escape — module system (ungranted fixture, real fork)', () => {
    test('CJS require() of every dangerous builtin cannot INVOKE its capability (no RCE / raw sockets / codegen)', async () => {
        const r = await probe(UNGRANTED, 'require');
        allTrue(r, ['child_process', 'node_child_process', 'worker_threads', 'vm', 'net', 'dgram',
            'binding', 'dlopen', 'getBuiltinModule', 'rce',
            'diagnostics_channel', 'node_diagnostics_channel']);
    });
    test('host-reaching process methods are refused BY THE SANDBOX (not merely absent)', async () => {
        const r = await probe(UNGRANTED, 'require');
        for (const k of ['execve', 'debugProcess', 'loadEnvFile']) {
            // 'absent' = this Node/OS does not implement it, which is safe but proves nothing; anything
            // starting with 'other:' means it threw for an unrelated reason and the guard never ran.
            assert.ok(r[k] === true || r[k] === 'absent',
                `process.${k} was not refused by the sandbox — got ${JSON.stringify(r[k])}`);
        }
        // On a POSIX CI runner these MUST be genuinely guarded, not absent.
        if (process.platform === 'linux') {
            assert.strictEqual(r.execve, true, 'process.execve must be sandbox-blocked on Linux');
            assert.strictEqual(r.loadEnvFile, true, 'process.loadEnvFile must be sandbox-blocked');
        }
    });
    test('ESM dynamic import() cannot produce a WORKING exploit (RCE / forbidden read / socket / thread)', async () => {
        const r = await probe(UNGRANTED, 'esm', `?benign=${encodeURIComponent(benignOutOfZone)}`);
        allTrue(r, ['child_process', 'fs', 'net', 'worker_threads']);
    });
});

describe('sandbox escape — network for an UNGRANTED plugin (real fork)', () => {
    test('global fetch is trapped and raw net/dgram/http are blocked', async () => {
        const r = await probe(UNGRANTED, 'net');
        allTrue(r, ['fetchTrapped', 'net', 'dgram', 'http']);
    });
});

describe('sandbox escape — secrets, self-grant, IPC (ungranted fixture, real fork)', () => {
    test('no host secret env var leaks into the child process (allowlist strips them)', async () => {
        const r = await probe(UNGRANTED, 'secrets-env');
        assert.strictEqual(r.jwt, null, 'JWT secret must not reach the child env');
        assert.strictEqual(r.session, null);
        assert.strictEqual(r.dbUrl, null);
        assert.strictEqual(r.dbPass, null);
    });
    test('cannot mutate the immutable identity globals (no impersonation / self network-grant)', async () => {
        const r = await probe(UNGRANTED, 'self-grant');
        allTrue(r, ['slugImmutable', 'netImmutable']);
    });
    test('a raw IPC call to a real-but-NON-allowlisted bridge method is rejected as "not permitted"', async () => {
        const r = await probe(UNGRANTED, 'ipc');
        assert.strictEqual(r.notPermitted, true, `the bridge allowlist must reject provideMail, got ${JSON.stringify(r)}`);
    });
});

describe('sandbox escape — a FULLY-GRANTED plugin is still contained (real fork)', () => {
    test('SQL scope guard: own tables work, but core/sibling tables + every evasion are denied', async () => {
        const r = await probe(GRANTED, 'sql');
        assert.strictEqual(r.ownCreate, true, `own-table CREATE must work, got ${JSON.stringify(r.ownCreate)}`);
        assert.strictEqual(r.ownSelect, true, `own-table SELECT must work, got ${JSON.stringify(r.ownSelect)}`);
        allTrue(r, ['users', 'userPass', 'optionsSecret', 'sibling', 'commaJoin', 'subquery', 'union',
            'quotedAlias', 'commented', 'pragma', 'catalog', 'attach', 'stacked', 'returning']);
    });
    test('protected options are unreadable even WITH settings:read granted; non-secret options work', async () => {
        const r = await probe(GRANTED, 'options');
        allTrue(r, ['jwtSecret', 'pluginGrants', 'userRoles']);
        assert.strictEqual(r.blognameReadable, true, 'a non-secret option must be readable (proves the bridge works)');
    });
    test('egress guard: a network-GRANTED plugin still cannot SSRF loopback / metadata / RFC1918', async () => {
        const before = ssrfHits;
        const r = await probe(GRANTED, 'ssrf', `?port=${ssrfPort}`);
        assert.strictEqual(r.fetchDefined, true, 'network grant must expose a (guarded) fetch — proves the grant flipped');
        allTrue(r, ['loopback', 'metadata', 'ipv6Loopback', 'ipv4Mapped', 'rfc1918', 'netConnect']);
        assert.strictEqual(ssrfHits, before, 'the loopback listener must receive ZERO connections from the plugin');
    });
});
