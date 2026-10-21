/**
 * HOST CODE SERVING A PLUGIN IS STILL THE HOST (FALLOS 113 / 112, QA M4-01 / M4-02 / S3-19).
 *
 * Isolated plugins run in their own process; on the host the only code that runs inside
 * runWithContext(slug) is the host answering that plugin's bridged call. Two things went wrong there:
 *
 *   1. node-postgres opens a new pool connection with a LAZY `require('net')` (pg/lib/stream.js). Under the
 *      plugin's async context the require hook handed it the PLUGIN's egress-guarded module, so the host's
 *      own database connection was refused for a database on a private address — the plugin failed at every
 *      boot ("network egress to 192.168.x.x is blocked — only public destinations are allowed for plugins").
 *   2. That refusal escaped as an uncaught exception. The host's handler called process.exit(1), the
 *      sandbox's process-control guard refused it for the same leaked context, the handler threw inside
 *      Node's fatal-exception path and the whole monolith died with exit code 7.
 *
 * Pinned here: the require policy keys on the module that asks (host modules get the real builtin, plugin
 * frames and forged parents do not); the database driver and the per-plugin DB principal run as the host;
 * an exception raised while serving a plugin never kills the process, and the host's exit is never vetoed.
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Module = require('module');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-host-separation-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const { installSecureRequire } = require('../core/secure-require');
const { runWithContext, getCurrentPlugin } = require('../core/plugin-context');

// Captured OUTSIDE any plugin context, before the hook is installed.
const RAW_NET = require('net');
const RAW_TLS = require('tls');

installSecureRequire();

const BACKEND = path.resolve(__dirname, '..', '..');
const SLUG = 'zz-host-separation-probe';
const PROBE_DIR = path.join(BACKEND, 'plugins', SLUG);
fs.mkdirSync(PROBE_DIR, { recursive: true });
fs.writeFileSync(path.join(PROBE_DIR, 'manifest.json'), JSON.stringify({
    name: 'Host separation probe', version: '1.0.0', isolated: true,
    permissions: [{ scope: 'database', access: 'read' }, { scope: 'database', access: 'write' }],
}));
// A plugin-owned file: whatever it calls runs with a plugin frame on the stack.
fs.writeFileSync(path.join(PROBE_DIR, 'frame.js'), 'module.exports = function callThrough(fn) { return fn(); };\n');

after(async () => {
    try { await require('../config/database').closeDatabase(); } catch { /* not opened */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
    fs.rmSync(PROBE_DIR, { recursive: true, force: true });
});

test('a host module requiring a network builtin while serving a plugin gets the REAL module', () => {
    // The plugin holds no Network grant: before the fix this was the inert blocked proxy.
    const [net, tls] = runWithContext(SLUG, () => [require('net'), require('tls')]);
    assert.strictEqual(net, RAW_NET, 'host code got the plugin-guarded net');
    assert.strictEqual(tls, RAW_TLS, 'host code got the plugin-guarded tls');
});

test("node-postgres' lazy socket factory builds a real, unguarded socket inside a plugin's context", () => {
    const { getStream } = require('pg/lib/stream');
    const sock = runWithContext(SLUG, () => getStream(false));
    try {
        assert.ok(sock instanceof RAW_NET.Socket, 'pg built its connection socket from a guarded module');
        assert.strictEqual(Object.getPrototypeOf(sock).constructor, RAW_NET.Socket, 'the pool connection must use the real net.Socket, not GuardedSocket');
    } finally { sock.destroy(); }
});

test('a FORGED parent handed to the loader does not pass for host code', () => {
    // Not the module object Node cached for that filename, so the requirer test refuses it.
    const forged = { filename: __filename, id: __filename, paths: [] };
    const got = runWithContext(SLUG, () => Module._load('net', forged, false));
    assert.notStrictEqual(got, RAW_NET, 'a {filename} look-alike unlocked the real net');
});

test('a plugin frame on the stack keeps the require policed, even through a genuine host module', () => {
    const callThrough = require(path.join(PROBE_DIR, 'frame.js'));
    const hostModule = require.cache[__filename];
    assert.ok(hostModule, 'this test file is a cached host module');
    const got = runWithContext(SLUG, () => callThrough(() => Module.prototype.require.call(hostModule, 'net')));
    assert.notStrictEqual(got, RAW_NET, 'a plugin borrowed a host module to obtain the real net');
});

test('the database driver runs as the host while serving a plugin query', async () => {
    const database = require('../config/database');
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    require('../core/plugin-permissions')._setGrantsInMemory(SLUG, ['database:read', 'database:write']);
    const driver = database.getDbAsync();
    const realAll = driver.all;
    const seen: any[] = [];
    driver.all = function (...args: any[]) { seen.push(getCurrentPlugin()); return realAll.apply(this, args); };
    try {
        const rows = await runWithContext(SLUG, () => database.dbAsync.all('SELECT 1 AS one'));
        assert.deepStrictEqual(rows.map((r: any) => r.one), [1]);
        // The permission check above still ran under the plugin (a plugin without the grant is refused).
        assert.deepStrictEqual(seen, [null], 'the driver ran under the plugin context');
        require('../core/plugin-permissions')._setGrantsInMemory(SLUG, []);
        await assert.rejects(async () => runWithContext(SLUG, () => database.dbAsync.all('SELECT 1')), /Security Block|permission/i,
            'running the driver as host must not skip the plugin permission check');
    } finally { driver.all = realAll; }
});

// The whole process is the subject here, so it runs in its own: the same handlers index.ts installs.
function runCrashProbe(mode: 'plugin' | 'core') {
    const script = `
        const path = require('path');
        const core = ${JSON.stringify(path.join(BACKEND, 'src', 'core'))};
        require(path.join(core, 'secure-require')).installSecureRequire();
        const CrashGuard = require(path.join(core, 'crash-guard'));
        CrashGuard.installRuntimeBlameHandlers();
        // index.ts's own handler, verbatim in behaviour.
        process.on('uncaughtException', () => { if (CrashGuard.pluginScopedUncaught()) return; CrashGuard.exitAsHost(1); });
        const { runWithContext } = require(path.join(core, 'plugin-context'));
        const boom = () => { throw new Error('host fault while answering a bridged call'); };
        if (process.env.WJS_CRASH_PROBE_MODE === 'plugin') runWithContext('mail-server', () => setTimeout(boom, 20));
        else setTimeout(boom, 20);
        setTimeout(() => { process.stdout.write('ALIVE\\n'); }, 600);
    `;
    return spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
        cwd: BACKEND, encoding: 'utf8', timeout: 60000, env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', WJS_CRASH_PROBE_MODE: mode },
    });
}

test('REGRESSION: an uncaught error raised while the host serves a plugin never kills the process', () => {
    const r = runCrashProbe('plugin');
    assert.strictEqual(r.status, 0, `process died (status ${r.status}, signal ${r.signal}):\n${r.stderr}`);
    assert.match(r.stdout, /ALIVE/, 'the process stopped serving after a plugin-scoped error');
    assert.doesNotMatch(r.stderr, /attempted unauthorized action: process\.exit/, 'the crash path hit the plugin sandbox');
});

test('an uncaught error in core still exits cleanly with 1 — never vetoed into a fatal abort', () => {
    const r = runCrashProbe('core');
    assert.strictEqual(r.status, 1, `expected the clean exit 1 the supervisor restarts on, got ${r.status}:\n${r.stderr}`);
    assert.doesNotMatch(r.stdout, /ALIVE/);
});

test("index.ts's uncaughtException handler delegates to the crash guard's host-side exit", () => {
    const src = fs.readFileSync(path.join(BACKEND, 'src', 'index.ts'), 'utf8');
    const m = src.match(/process\.on\('uncaughtException', \(error\) => \{([\s\S]*?)\n\}\);/);
    assert.ok(m, 'handler not found');
    assert.match(m![1], /CrashGuard\.pluginScopedUncaught\(\)/);
    assert.match(m![1], /CrashGuard\.exitAsHost\(1\)/);
    assert.doesNotMatch(m![1], /\bprocess\.exit\(/, 'a bare process.exit can be vetoed by a leaked plugin context');
});
