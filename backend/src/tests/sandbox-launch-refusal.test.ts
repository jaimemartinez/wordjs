/**
 * A launch the Linux shim refuses, driven through the REAL startIsolate - the wiring the other sandbox
 * tests stub away.
 *
 * WHAT WAS UNTESTED. sandbox-unavailable-activation.test.ts replaces loadIsolatedPlugin and builds its
 * refusals by hand, so nothing exercised the path that turns a real launcher exit into a refusal: the
 * listener that keeps the child's startup stderr, the wait for that stream to drain, the
 * `code === 78/79/127` branch, classifyShimLaunchFailure on what was captured, and the failLoad that
 * carries the result to the route. Removing any of them left every test green. Nor did anything check
 * what the plugin LIST says after a refusal outside a request - at boot every previously active plugin
 * on a sandbox-less host read "Active" with no runtime and no reason.
 *
 * HOW, ON EVERY HOST. The shim is the one piece replaced: the module's PERL_BIN/shimArgs are pointed at a
 * tiny node script that behaves like the shim's two failure shapes, and the probe is told the Landlock
 * floor is 'active' so startIsolate takes the shim launch. Off Linux, process.platform is presented as
 * 'linux' for the same reason (and restored after). Everything between - argv construction, spawn, the
 * stderr capture, the exit handler, the attribution rule, failLoad, core/plugins.ts's wrapping, the
 * route's 409 and the health record behind GET /plugins - is the production code.
 *   . `refuse` prints the incident's own line, `SHIM-FAIL: setgroups(clear): Operation not permitted`,
 *     and exits 79 BEFORE any `SHIM:` line - the shim refusing. It must answer 409 with that line.
 *   . `forged` prints a `SHIM:` line first, then `SHIM-FAIL: …`, exit 79 - which only a plugin could
 *     produce, the confinement having been applied. It must stay an ordinary failed start (500), or a
 *     plugin could make its own failure read as "the sandbox is broken".
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-shim-refusal-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const jwt = require('jsonwebtoken');
const linux = require('../core/sandbox-linux');
const isolate = require('../core/plugin-isolate');

const INCIDENT_LINE = 'SHIM-FAIL: setgroups(clear): Operation not permitted';
const STUBS = path.join(TMP_ROOT, 'stub-shims');
fs.mkdirSync(STUBS, { recursive: true });
const STUB_REFUSE = path.join(STUBS, 'refuse.js');
const STUB_FORGED = path.join(STUBS, 'forged.js');
// A stub writes its line(s) and exits with the shim's FAIL code. Written with process.stderr.write and
// an exit in its callback, so the line is really on the pipe before the process ends.
fs.writeFileSync(STUB_REFUSE, `process.stderr.write(${JSON.stringify(`${INCIDENT_LINE}\n`)}, () => process.exit(79));\n`);
fs.writeFileSync(STUB_FORGED, `process.stderr.write(${JSON.stringify('SHIM: landlock=abi8/27 landlock-net=on scoped=unix+signal seccomp=on/88 network=deny arch=x86_64 zones=1 privdrop=none\nSHIM-FAIL: forged by the plugin\n')}, () => process.exit(79));\n`);

let currentStub = STUB_REFUSE;
// Unique per run: the isolate's own directory is resolved under the backend's plugins/ (the APP_ROOT the
// launcher computes), so each slug gets one there for the run and it is removed afterwards.
const BASE = `shimref${process.pid}`;
const SLUG = { refused: `${BASE}r`, forged: `${BASE}f`, atboot: `${BASE}b`, nozone: `${BASE}z` };
const { ownPluginDir } = require('../core/sandbox-paths');
const APP_ROOT = path.resolve(__dirname, '..', '..');
const ownDirs = [SLUG.refused, SLUG.forged, SLUG.atboot].map((slug) => ownPluginDir(APP_ROOT, slug));
const realPlatform = process.platform;
const realShim = { PERL_BIN: linux.PERL_BIN, shimArgs: linux.shimArgs, probe: linux.probeLinuxZeroConf, note: linux.getLinuxZeroConfNote };

describe('a shim refusal, through the real launch path', () => {
    let request: any;
    let app: any;
    let adminToken: string;
    let core: any;

    function writePlugin(slug: string) {
        const dir = path.join(TMP_ROOT, 'plugins', slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: slug, version: '1.0.0', isolated: true, permissions: [] }));
        fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = { init() {} };\n');
    }

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        const dbAsync = database.getDbAsync();
        await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`, ['admin', 'x', 'admin@example.com', 'Administrator']);
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [admin.id]);
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        for (const slug of Object.values(SLUG)) writePlugin(slug);
        // The launcher's write zone is the plugin's own directory; one that does not exist is the
        // argv-build refusal (the 'nozone' case below), so the other three get theirs.
        for (const d of ownDirs) fs.mkdirSync(d, { recursive: true });

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use('/api/v1/plugins', require('../routes/plugins'));
        app.use(errorHandler);
        core = require('../core/plugins');

        // THE ONE REPLACED PIECE: the shim. The launcher becomes `node <stub>`, the probe says the floor
        // is certified, and the platform reads as Linux so startIsolate builds the shim launch.
        linux.PERL_BIN = process.execPath;
        linux.shimArgs = () => [currentStub];
        linux.probeLinuxZeroConf = async () => 'active';
        linux.getLinuxZeroConfNote = () => 'certified (test)';
        Object.defineProperty(process, 'platform', { value: 'linux' });
        assert.strictEqual(await isolate.probePlatformConfinement(), 'active');
    });

    after(async () => {
        Object.defineProperty(process, 'platform', { value: realPlatform });
        Object.assign(linux, { PERL_BIN: realShim.PERL_BIN, shimArgs: realShim.shimArgs, probeLinuxZeroConf: realShim.probe, getLinuxZeroConfNote: realShim.note });
        for (const slug of Object.values(SLUG)) { try { isolate.unloadIsolatedPlugin(slug); } catch { /* not loaded */ } }
        for (const d of ownDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('the shim\'s pre-exec SHIM-FAIL answers POST /activate with 409 and THAT line — and the health record says refused', async () => {
        currentStub = STUB_REFUSE;
        const res = await request(app).post(`/api/v1/plugins/${SLUG.refused}/activate`).set('Authorization', `Bearer ${adminToken}`).send({});
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'sandbox_unavailable');
        assert.strictEqual(res.body.details.sandbox.mechanism, 'landlock');
        assert.strictEqual(res.body.details.sandbox.state, 'active');
        assert.strictEqual(res.body.details.sandbox.failure, INCIDENT_LINE);
        assert.match(res.body.message, /The Landlock\/seccomp shim refused to confine this plugin/);
        const st = isolate.getIsolateStatus(SLUG.refused);
        assert.strictEqual(st && st.state, 'refused', JSON.stringify(st));
        assert.strictEqual(st.sandbox.failure, INCIDENT_LINE);
    });

    it('a SHIM-FAIL printed AFTER the SHIM: line is the plugin\'s own output: an ordinary failed start, never a sandbox refusal', async () => {
        currentStub = STUB_FORGED;
        const res = await request(app).post(`/api/v1/plugins/${SLUG.forged}/activate`).set('Authorization', `Bearer ${adminToken}`).send({});
        assert.strictEqual(res.status, 500, JSON.stringify(res.body));
        assert.notStrictEqual(res.body.code, 'sandbox_unavailable');
        const st = isolate.getIsolateStatus(SLUG.forged);
        assert.notStrictEqual(st && st.state, 'refused');
        assert.match(String(st && st.lastError), /exited during startup \(code 79\)/);
    });

    it('a launch whose confinement cannot be BUILT (no write zone on disk) is refused with 409, state active, and the step named', async () => {
        const res = await request(app).post(`/api/v1/plugins/${SLUG.nozone}/activate`).set('Authorization', `Bearer ${adminToken}`).send({});
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'sandbox_unavailable');
        assert.strictEqual(res.body.details.sandbox.state, 'active');
        assert.strictEqual(res.body.details.sandbox.failure, 'none of the io-guard write zones exist on this install');
        // The action fits a CERTIFIED sandbox that refused one launch, not "the probe could not certify".
        assert.match(res.body.details.sandbox.action, /certified on this server; it refused THIS plugin's launch/);
        assert.ok(!/could not certify/.test(res.body.details.sandbox.action));
    });

    it('AT BOOT: a refused plugin is listed active WITH runtime state refused, the refusal and its details', async () => {
        currentStub = STUB_REFUSE;
        const { updateOption } = require('../core/options');
        await updateOption('active_plugins', [SLUG.atboot]);
        await core.loadActivePlugins();
        const res = await request(app).get('/api/v1/plugins').set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(res.status, 200);
        const p = (res.body || []).find((x: any) => x.slug === SLUG.atboot);
        assert.ok(p, JSON.stringify(res.body));
        assert.strictEqual(p.active, true);
        assert.ok(p.runtime, 'a plugin the sandbox refused at boot must not be listed with runtime: null');
        assert.strictEqual(p.runtime.state, 'refused');
        assert.match(p.runtime.lastError, /was not started: the plugin sandbox could not confine it/);
        assert.strictEqual(p.runtime.sandbox.failure, INCIDENT_LINE);
        assert.ok(p.runtime.sandbox.action.length > 20);
    });
});
