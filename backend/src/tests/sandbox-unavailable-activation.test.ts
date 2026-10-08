/**
 * POST /api/v1/plugins/:slug/activate when the PLUGIN SANDBOX refuses: 409 `sandbox_unavailable`, with
 * the reason, instead of a bare 500.
 *
 * THE INCIDENT. A Linux host ran WordJS as an unprivileged user with
 * `AmbientCapabilities=CAP_NET_BIND_SERVICE`. The Landlock/seccomp shim died on
 * `SHIM-FAIL: setgroups(clear): Operation not permitted`, the probe went 'degraded', and the fail-closed
 * policy refused every plugin - correctly. But the refusal was a plain Error, core/plugins.ts wrapped
 * it, and errorHandler answered `500 rest_internal_error` "The server encountered an internal error".
 * The administrator saw "failed" on the one screen they were looking at, while the diagnosis sat in the
 * server log. The shim no longer fails on that shape (sandbox-linux-shim.test.ts), but a sandbox can
 * still be unavailable for other reasons, and when it is the activation must SAY so.
 *
 * WHAT IS PINNED
 *   . the refusal the fail-closed gate throws (`__nativeGateRefusal`): 409, the stable code, the shim's
 *     own line, an operator action - and no filesystem path,
 *   . which shim exits are attributed to the sandbox (classifyShimLaunchFailure): ONLY output produced
 *     before the plugin could have run; a plugin printing `SHIM-FAIL:` and exiting 79 is NOT,
 *   . the route, end to end through the REAL core/plugins.ts activation (and its wrapping of the error):
 *     the refusal answers 409 with the reason; an unrelated failure keeps its 500; a validation reject
 *     keeps its 400.
 * The launch itself is stubbed at loadIsolatedPlugin - the one seam between the activation and the
 * sandbox - because a real fail-closed refusal cannot be produced on demand on every host (the source
 * worker on Windows is exempt from the gate by design).
 */
const { describe, it, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-sandbox-409-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';

// THE SEAM, installed before core/plugins.ts is loaded: it destructures loadIsolatedPlugin at load time.
const isolate = require('../core/plugin-isolate');
let launch: (slug: string) => Promise<any> = async () => ({ ok: true });
isolate.loadIsolatedPlugin = (slug: string) => launch(slug);

const database = require('../config/database');
const jwt = require('jsonwebtoken');
const linux = require('../core/sandbox-linux');
const refusal = require('../core/sandbox-refusal');

const INCIDENT_LINE = 'SHIM-FAIL: setgroups(clear): Operation not permitted';

describe('operatorSafeText — what a refusal may show a client', () => {
    test('absolute paths are redacted (POSIX, drive letter, UNC) and control characters flattened', () => {
        const s = refusal.operatorSafeText("SHIM-FAIL: cannot grant the read root /srv/site/backend/plugins/acme\n(also C:\\Users\\op\\wordjs and \\\\host\\share\\x, open '/etc/shadow')");
        assert.ok(!/\/srv|C:\\|\\\\host|\/etc\/shadow/.test(s), s);
        assert.match(s, /cannot grant the read root <path>/);
        assert.ok(!s.includes('\n'));
    });
    test('ratios and option values that merely contain a slash survive', () => {
        assert.strictEqual(refusal.operatorSafeText('landlock=abi8/19 seccomp=on/88'), 'landlock=abi8/19 seccomp=on/88');
    });
    test('keepPaths keeps host-authored fixed paths but still flattens control characters', () => {
        assert.strictEqual(refusal.operatorSafeText('/usr/bin/perl is\nabsent', 100, { keepPaths: true }), '/usr/bin/perl is absent');
    });
    test('a path with SPACES is redacted whole — the part after the space is the one that names a person or a site', () => {
        // Each of these leaked its tail ("Martinez\sites\acme", "Site/backend/plugins/acme") when a path
        // ended at the first space.
        assert.strictEqual(refusal.operatorSafeText('could not grant AppContainer read access to C:\\Program Files\\nodejs, C:\\Users\\Jaime Martinez\\sites\\acme\\backend\\plugins\\acme'),
            'could not grant AppContainer read access to <path>, <path>');
        assert.strictEqual(refusal.operatorSafeText('SHIM-FAIL: cannot grant the writable zone /srv/My Site/backend/plugins/acme'),
            'SHIM-FAIL: cannot grant the writable zone <path>');
        assert.strictEqual(refusal.operatorSafeText("EACCES: permission denied, open '/home/Jane Doe/site/x.json'"),
            "EACCES: permission denied, open '<path>'");
    });
    test('a backtick-quoted path is redacted too, and the words around a path survive', () => {
        assert.strictEqual(refusal.operatorSafeText('cannot read `/home/op/wordjs/backend/plugins/acme`'), 'cannot read `<path>`');
        assert.strictEqual(refusal.operatorSafeText('wjs-sandbox: 1: exec: /usr/bin/perl: not found'), 'wjs-sandbox: 1: exec: <path>: not found');
        assert.strictEqual(refusal.operatorSafeText('the zone /srv/x. Then (/srv/y) failed'), 'the zone <path>. Then (<path>) failed');
        assert.strictEqual(refusal.operatorSafeText('a sandbox path resolved to / (/srv/link)'), 'a sandbox path resolved to / (<path>)');
    });
});

describe('classifyShimLaunchFailure — attribute only what happened before the plugin could run', () => {
    const { classifyShimLaunchFailure } = linux;
    test('exit 79 with the shim\'s own SHIM-FAIL line and no SHIM: line is the sandbox refusing', () => {
        assert.deepStrictEqual(classifyShimLaunchFailure(79, `${INCIDENT_LINE}\n`), { kind: 'fail', line: INCIDENT_LINE });
    });
    test('Perl warnings in front of the line do not hide it', () => {
        const r = classifyShimLaunchFailure(79, `Hexadecimal number > 0xffffffff non-portable at shim.pl line 336.\n${INCIDENT_LINE}\n`);
        assert.strictEqual(r && r.line, INCIDENT_LINE);
    });
    test('exit 78 SHIM-UNSUPPORTED is "this kernel cannot"', () => {
        assert.deepStrictEqual(classifyShimLaunchFailure(78, 'SHIM-UNSUPPORTED: landlock_create_ruleset is unavailable on this kernel (Function not implemented)\n'),
            { kind: 'unsupported', line: 'SHIM-UNSUPPORTED: landlock_create_ruleset is unavailable on this kernel (Function not implemented)' });
    });
    test('the line is made path-free', () => {
        const r = classifyShimLaunchFailure(79, 'SHIM-FAIL: cannot grant the writable zone /srv/wordjs/backend/plugins/acme\n');
        assert.strictEqual(r && r.line, 'SHIM-FAIL: cannot grant the writable zone <path>');
    });
    test('ANYTHING after the SHIM: line is NOT attributed — the plugin could have printed it', () => {
        const confined = 'SHIM: landlock=abi8/19 landlock-net=on scoped=unix+signal seccomp=on/88 network=deny arch=x86_64 zones=6 privdrop=none\n';
        // A plugin forging the shim's refusal to make an administrator switch the sandbox off.
        assert.strictEqual(classifyShimLaunchFailure(79, `${confined}${INCIDENT_LINE}\n`), null);
        assert.strictEqual(classifyShimLaunchFailure(78, `${confined}SHIM-UNSUPPORTED: forged\n`), null);
        // Even the shim's own exec failure: after the SHIM: line the same bytes are producible by plugin code.
        assert.strictEqual(classifyShimLaunchFailure(127, `${confined}SHIM-FAIL: exec /usr/bin/node: Permission denied\n`), null);
    });
    test('exit 127 with no SHIM: line is the launcher in front of the shim (perl or the script missing)', () => {
        assert.deepStrictEqual(classifyShimLaunchFailure(127, 'wjs-sandbox: 1: exec: /usr/bin/perl: not found\n'),
            { kind: 'launcher', line: 'wjs-sandbox: 1: exec: <path>: not found' });
    });
    test('no evidence, no attribution: empty stderr, a code that is not the shim\'s, or the wrong marker', () => {
        assert.strictEqual(classifyShimLaunchFailure(79, ''), null);
        assert.strictEqual(classifyShimLaunchFailure(127, ''), null);
        assert.strictEqual(classifyShimLaunchFailure(1, `${INCIDENT_LINE}\n`), null);
        assert.strictEqual(classifyShimLaunchFailure(null, `${INCIDENT_LINE}\n`), null);
        assert.strictEqual(classifyShimLaunchFailure(78, `${INCIDENT_LINE}\n`), null, 'exit 78 is only ever SHIM-UNSUPPORTED');
    });
});

describe('the fail-closed gate\'s refusal', () => {
    test('the incident: landlock degraded by a privilege-drop failure → 409, stable code, the shim line, the capability fix', () => {
        const e = isolate.__nativeGateRefusal('acme', 'landlock', 'degraded', { note: 'irrelevant', shimFailure: INCIDENT_LINE });
        assert.strictEqual(e.code, 'sandbox_unavailable');
        assert.strictEqual(e.status, 409);
        assert.strictEqual(e.sandbox.mechanism, 'landlock');
        assert.strictEqual(e.sandbox.state, 'degraded');
        assert.strictEqual(e.sandbox.failure, INCIDENT_LINE);
        assert.match(e.message, /Plugin 'acme' was not started/);
        assert.match(e.sandbox.action, /AmbientCapabilities=/);
        assert.match(e.sandbox.action, /ip_unprivileged_port_start/);
        assert.match(e.sandbox.action, /health\/details/);
        assert.ok(!/requireHardening=false/.test(`${e.message} ${e.sandbox.action}`),
            'the client-facing action must not lead with switching the sandbox off');
    });
    test('without a shim line the probe note is the reason, and the action fits the state', () => {
        const u = isolate.__nativeGateRefusal('acme', 'landlock', 'unsupported', { note: 'this kernel has no usable Landlock', shimFailure: null });
        assert.match(u.sandbox.reason, /'unsupported' on this server: this kernel has no usable Landlock\./);
        assert.strictEqual(u.sandbox.failure, null);
        assert.match(u.sandbox.action, /Landlock enabled \(5\.13 or newer/);
        const d = isolate.__nativeGateRefusal('acme', 'landlock', 'disabled', { note: 'switched off', shimFailure: null });
        assert.match(d.sandbox.action, /useKernelHardening=false/);
    });
    test('every mechanism refuses with the same contract', () => {
        for (const mech of ['appcontainer', 'seatbelt', 'none']) {
            const e = isolate.__nativeGateRefusal('acme', mech, 'degraded', { note: '', shimFailure: null }, 'probe note');
            assert.strictEqual(e.code, 'sandbox_unavailable', mech);
            assert.strictEqual(e.status, 409, mech);
            assert.strictEqual(e.sandbox.mechanism, mech);
            assert.ok(e.sandbox.action.length > 20, mech);
        }
    });
    test('a refusal of ONE launch on a CERTIFIED sandbox (state active) says so — never "the probe could not certify"', () => {
        // The exit-path refusal (exit 79 before exec), the launcher's exit 127 and the argv-build failure
        // are all built with state 'active': GET /health/details shows the sandbox certified, and an action
        // that sends the operator after a certification failure points at something that does not exist.
        const perLaunch = linux.classifyShimLaunchFailure(79, 'SHIM-FAIL: cannot grant the read root /srv/x/node_modules\n');
        for (const failure of [perLaunch.line, 'wjs-sandbox: 1: exec: <path>: not found', 'none of the io-guard write zones exist on this install']) {
            const e = refusal.sandboxUnavailable('acme', { mechanism: 'landlock', state: 'active', reason: 'r', failure });
            assert.match(e.sandbox.action, /certified on this server; it refused THIS plugin's launch/, failure);
            assert.match(e.sandbox.action, /\[Sandbox\] the Linux shim refused to launch isolated plugin/);
            assert.ok(!/could not certify/.test(e.sandbox.action), failure);
        }
        for (const mechanism of ['appcontainer', 'seatbelt']) {
            const e = refusal.sandboxUnavailable('acme', { mechanism, state: 'active', reason: 'r', failure: 'x' });
            assert.match(e.sandbox.action, /certified on this server; it could not be set up for THIS plugin/, mechanism);
            assert.ok(!/must be on/.test(e.sandbox.action), `${mechanism}: the switch IS on when the sandbox is active`);
        }
    });
    test('a privilege-drop step that failed for lack of AUTHORITY is matched too, and the action does not send the operator after setcap', () => {
        for (const line of ['SHIM-FAIL: setgroups(clear): Operation not permitted', 'SHIM-FAIL: prctl(SECUREBITS): Operation not permitted',
            'SHIM-FAIL: CapBnd survived the privilege drop', 'SHIM-FAIL: privilege drop: capset(clear): Operation not permitted',
            'SHIM-FAIL: supplementary groups survived the privilege drop', 'SHIM-FAIL: prctl(GET_SECUREBITS): Invalid argument']) {
            assert.ok(refusal.isPrivilegeDropFailure(line), line);
        }
        const e = isolate.__nativeGateRefusal('acme', 'landlock', 'degraded', { note: 'n', shimFailure: 'SHIM-FAIL: setgroups(clear): Operation not permitted' });
        assert.match(e.sandbox.action, /unprivileged user holding no capabilities/);
        assert.ok(!/setcap/.test(e.sandbox.action), 'a file capability on node never reaches the shim, so it cannot be what failed here');
    });
});

/**
 * The BOOT banner for the sandbox state. It said, unconditionally, that a degraded host runs plugins
 * "WITHOUT the native OS backstop" and suggested "set sandbox.requireHardening=true" - under the default
 * policy plugins are REFUSED and the setting is already on, and the host-privilege warning printed next
 * to it said so. The text now follows the launch posture.
 */
describe('sandboxBootBanner — what the boot log may say a degraded sandbox does to plugins', () => {
    const banner = (state: string, p: Partial<{ wouldRefuse: boolean; exempt: boolean; requireHardening: boolean }>) =>
        isolate.sandboxBootBanner(state, { wouldRefuse: false, exempt: false, requireHardening: true, ...p });
    test('fail-closed (the default): plugins are REFUSED, and requireHardening is not "suggested"', () => {
        const b = banner('degraded', { wouldRefuse: true });
        const text = b.lines.join('\n');
        assert.strictEqual(b.level, 'warn');
        assert.match(text, /requireHardening is ON — isolated plugins are REFUSED/);
        assert.ok(!/WITHOUT the native OS backstop/.test(text), text);
        assert.ok(!/Set it to true|set sandbox\.requireHardening=true/i.test(text), text);
    });
    test('policy off: plugins run unconfined, and that is when the setting is suggested', () => {
        const text = banner('degraded', { requireHardening: false }).lines.join('\n');
        assert.match(text, /run WITHOUT the native OS backstop, because[\s\S]*requireHardening is off\. Set it to true to fail closed/);
    });
    test('exempt development host: unconfined, and exempt said plainly', () => {
        assert.match(banner('degraded', { exempt: true }).lines.join('\n'), /WITHOUT the native OS backstop[\s\S]*exempt/);
    });
    test('unsupported and disabled follow the same posture; active is one line', () => {
        assert.match(banner('unsupported', { wouldRefuse: true }).lines[0], /REFUSED/);
        assert.match(banner('unsupported', { requireHardening: false }).lines[0], /process separation \+ JS guards/);
        assert.match(banner('disabled', { wouldRefuse: true }).lines[0], /REFUSED/);
        assert.deepStrictEqual(banner('active', {}), { level: 'log', lines: ['🛡️  Plugin sandbox: native kernel confinement ACTIVE.'] });
    });
});

describe('a refusal thrown RAW renders the same contract', () => {
    test('the error carries details.sandbox, which is what errorHandler forwards', () => {
        const e = refusal.sandboxUnavailable('acme', { mechanism: 'landlock', state: 'degraded', reason: 'r', failure: INCIDENT_LINE });
        assert.deepStrictEqual(e.details, { sandbox: e.sandbox });
        assert.deepStrictEqual(refusal.sandboxRefusalBody(e), {
            code: 'sandbox_unavailable', message: e.message, error: e.message, data: { status: 409 }, details: { sandbox: e.sandbox },
        });
    });
});

describe('findSandboxUnavailable — through the wrapping core/plugins.ts applies', () => {
    test('found as the cause of "Failed to activate plugin …", and as the error itself', () => {
        const inner = refusal.sandboxUnavailable('acme', { mechanism: 'landlock', state: 'degraded', reason: 'r', failure: INCIDENT_LINE });
        const wrapped = new Error('Failed to activate plugin acme: …', { cause: inner });
        assert.strictEqual(refusal.findSandboxUnavailable(wrapped), inner);
        assert.strictEqual(refusal.findSandboxUnavailable(inner), inner);
    });
    test('an error that merely carries the code string is not a refusal, and a cyclic cause cannot hang', () => {
        const fake: any = new Error('x'); fake.code = 'sandbox_unavailable';
        assert.strictEqual(refusal.findSandboxUnavailable(fake), null);
        const a: any = new Error('a'); const b: any = new Error('b'); a.cause = b; b.cause = a;
        assert.strictEqual(refusal.findSandboxUnavailable(a), null);
        assert.strictEqual(refusal.findSandboxUnavailable(undefined), null);
    });
});

describe('POST /api/v1/plugins/:slug/activate — the sandbox refusal reaches the administrator', () => {
    let request: any;
    let app: any;
    let adminToken: string;

    function writePlugin(slug: string, indexJs: string) {
        const dir = path.join(TMP_ROOT, 'plugins', slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: slug, version: '1.0.0', isolated: true, permissions: [] }));
        fs.writeFileSync(path.join(dir, 'index.js'), indexJs);
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

        writePlugin('refused', 'module.exports = { init() {} };\n');
        writePlugin('broken', 'module.exports = { init() {} };\n');
        writePlugin('dangerous', 'module.exports = { init() { eval("1"); } };\n');

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use('/api/v1/plugins', require('../routes/plugins'));
        app.use(errorHandler);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('a fail-closed refusal answers 409 sandbox_unavailable with the reason, the shim line and the action', async () => {
        launch = async (slug: string) => { throw isolate.__nativeGateRefusal(slug, 'landlock', 'degraded', { note: 'n', shimFailure: INCIDENT_LINE }); };
        const res = await request(app).post('/api/v1/plugins/refused/activate').set('Authorization', `Bearer ${adminToken}`).send({});
        assert.strictEqual(res.status, 409, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'sandbox_unavailable');
        assert.strictEqual(res.body.data && res.body.data.status, 409);
        assert.match(res.body.message, /Plugin 'refused' was not started: the plugin sandbox could not confine it/);
        assert.strictEqual(res.body.error, res.body.message);
        assert.strictEqual(res.body.details.sandbox.mechanism, 'landlock');
        assert.strictEqual(res.body.details.sandbox.state, 'degraded');
        assert.strictEqual(res.body.details.sandbox.failure, INCIDENT_LINE);
        assert.match(res.body.details.sandbox.action, /AmbientCapabilities=/);
    });

    it('a shim refusal of THIS launch (attributed from its pre-exec line) answers the same way, path-free', async () => {
        launch = async (slug: string) => {
            const r = linux.classifyShimLaunchFailure(79, 'SHIM-FAIL: cannot grant the read root /srv/wordjs/backend/node_modules\n');
            throw refusal.sandboxUnavailable(slug, { mechanism: 'landlock', state: 'active', reason: 'The Landlock/seccomp shim refused to confine this plugin, so it was not started.', failure: r.line });
        };
        const res = await request(app).post('/api/v1/plugins/refused/activate').set('Authorization', `Bearer ${adminToken}`).send({});
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.details.sandbox.failure, 'SHIM-FAIL: cannot grant the read root <path>');
        assert.ok(!JSON.stringify(res.body).includes('/srv/wordjs'), 'no filesystem path may reach the client');
    });

    it('an UNRELATED launch failure keeps its 500 — only a sandbox refusal is a 409', async () => {
        launch = async () => { throw new Error('Isolated plugin \'broken\' exited during startup (code 1)'); };
        const res = await request(app).post('/api/v1/plugins/broken/activate').set('Authorization', `Bearer ${adminToken}`).send({});
        assert.strictEqual(res.status, 500);
        assert.strictEqual(res.body.code, 'rest_internal_error');
    });

    it('a validation reject keeps its 400 with the structured details', async () => {
        launch = async () => { throw new Error('the launch must not be reached'); };
        const res = await request(app).post('/api/v1/plugins/dangerous/activate').set('Authorization', `Bearer ${adminToken}`).send({});
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.ok(Array.isArray(res.body.details && res.body.details.dangerousCalls));
        assert.notStrictEqual(res.body.code, 'sandbox_unavailable');
    });

    it('a refusal thrown raw (not wrapped) is rendered as the same 409 by the global error handler', async () => {
        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        const raw = express();
        const thrown = refusal.sandboxUnavailable('acme', { mechanism: 'landlock', state: 'degraded', reason: 'r', failure: INCIDENT_LINE });
        raw.get('/x', (_req: any, _res: any, next: any) => next(thrown));
        raw.use(errorHandler);
        const res = await request(raw).get('/x');
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.code, 'sandbox_unavailable');
        assert.strictEqual(res.body.message, thrown.message);
        // The part a client acts on: without it the admin UI rendered mechanism/state 'unknown' and no action.
        assert.deepStrictEqual(res.body.details, { sandbox: thrown.sandbox });
    });

    /**
     * THE TWIN SURFACES. Every route that restarts an isolate can be refused by the sandbox, not only
     * activation - and reloadIsolatedPlugin STOPS the running child before the refused load, so the
     * plugin ends up stopped. Each must answer the refusal contract (and say what was saved and what
     * stopped), not a 200 "success" with the refusal in a console.warn, nor a 409 without details.
     */
    describe('the routes that restart a plugin answer the same 409', () => {
        const refusedReload = async (slug: string) => { throw isolate.__nativeGateRefusal(slug, 'landlock', 'degraded', { note: 'n', shimFailure: INCIDENT_LINE }); };
        let saved: Record<string, any>;
        before(() => {
            writePlugin('twin', 'module.exports = { init() {} };\n');
            const dir = path.join(TMP_ROOT, 'plugins', 'twin');
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'twin', version: '1.0.0', isolated: true, permissions: [], claimPorts: [2525] }));
            saved = { isIsolated: isolate.isIsolated, reloadIsolatedPlugin: isolate.reloadIsolatedPlugin };
            isolate.isIsolated = () => true;
            isolate.reloadIsolatedPlugin = refusedReload;
        });
        after(() => { Object.assign(isolate, saved); });

        const expectRefusal = (res: any) => {
            assert.strictEqual(res.status, 409, JSON.stringify(res.body));
            assert.strictEqual(res.body.code, 'sandbox_unavailable');
            assert.strictEqual(res.body.error, res.body.message);
            assert.deepStrictEqual(res.body.data, { status: 409 });
            assert.strictEqual(res.body.details.sandbox.failure, INCIDENT_LINE);
            assert.match(res.body.details.sandbox.action, /unprivileged user holding no capabilities/);
        };

        it('POST /:slug/reload', async () => {
            const res = await request(app).post('/api/v1/plugins/twin/reload').set('Authorization', `Bearer ${adminToken}`).send({});
            expectRefusal(res);
            assert.strictEqual(res.body.stopped, true);
            assert.match(res.body.message, /'twin' is now STOPPED: the plugin sandbox refused to restart it/);
        });

        it('POST /:slug/permissions — the grants are saved, the plugin is stopped, and the answer says both', async () => {
            const res = await request(app).post('/api/v1/plugins/twin/permissions').set('Authorization', `Bearer ${adminToken}`).send({ granted: [], network: true });
            expectRefusal(res);
            assert.strictEqual(res.body.saved, true);
            assert.strictEqual(res.body.stopped, true);
            assert.strictEqual(res.body.reloaded, false);
            assert.deepStrictEqual(res.body.granted, ['network']);
            assert.match(res.body.message, /were saved \(1 granted\), but the plugin is now STOPPED/);
            assert.ok(!/Reactivate the plugin to fully apply/.test(res.body.message));
            assert.deepStrictEqual(require('../core/plugin-permissions').getGrants('twin'), ['network']);
        });

        it('POST /:slug/egress-hosts — the allowlist is saved, the plugin is stopped', async () => {
            const res = await request(app).post('/api/v1/plugins/twin/egress-hosts').set('Authorization', `Bearer ${adminToken}`).send({ hosts: ['api.example.com'] });
            expectRefusal(res);
            assert.strictEqual(res.body.saved, true);
            assert.strictEqual(res.body.stopped, true);
            assert.deepStrictEqual(res.body.hosts, ['api.example.com']);
        });

        it('POST /:slug/free-port — the port was freed, the restart refused', async () => {
            const pc = require('../core/port-conflicts');
            const realFree = pc.freeClaimedPort;
            pc.freeClaimedPort = async (port: number) => ({ freed: true, port, label: 'Postfix' });
            try {
                const res = await request(app).post('/api/v1/plugins/twin/free-port').set('Authorization', `Bearer ${adminToken}`).send({ port: 2525, allowDisable: true });
                expectRefusal(res);
                assert.strictEqual(res.body.freed, true);
                assert.strictEqual(res.body.stopped, true);
                assert.match(res.body.message, /Port 2525 was freed, but plugin 'twin' is now STOPPED/);
            } finally { pc.freeClaimedPort = realFree; }
        });

        it('an UNRELATED reload failure on the grants route keeps its old best-effort 200', async () => {
            isolate.reloadIsolatedPlugin = async () => { throw new Error('child exited during startup (code 1)'); };
            try {
                const res = await request(app).post('/api/v1/plugins/twin/permissions').set('Authorization', `Bearer ${adminToken}`).send({ granted: [] });
                assert.strictEqual(res.status, 200);
                assert.strictEqual(res.body.reloaded, false);
            } finally { isolate.reloadIsolatedPlugin = refusedReload; }
        });
    });

    /**
     * runPluginUpdate (marketplace /install|/update): an update of an ACTIVE plugin reactivates it, and on
     * a host whose sandbox is down that reactivation - and the rollback's - is refused. It answered a
     * generic 500 "rolled back" while the plugin had in fact been switched off.
     */
    it('a marketplace update whose reactivation the sandbox refuses: 409, rolled back, and NOT running — said explicitly', async () => {
        const { updateOption, getOption } = require('../core/options');
        const origins = require('../core/plugin-origins');
        const { runPluginUpdate, createInstallTmp } = require('../routes/plugins');
        const AdmZip = require('adm-zip');
        writePlugin('upd', 'module.exports = { init() {} };\n');
        const origin = { source: 'https://catalog.example/download', catalogId: 'upd' };
        await origins.setPluginOrigin('upd', origin);
        await updateOption('active_plugins', ['upd']);
        launch = async (slug: string) => { throw isolate.__nativeGateRefusal(slug, 'landlock', 'degraded', { note: 'n', shimFailure: INCIDENT_LINE }); };
        const zip = new AdmZip();
        zip.addFile('upd/manifest.json', Buffer.from(JSON.stringify({ name: 'upd', version: '1.1.0', isolated: true, permissions: [] })));
        zip.addFile('upd/index.js', Buffer.from('module.exports = { init() {} };\n'));
        const tmp = createInstallTmp();
        try {
            zip.writeZip(tmp.zipPath);
            const r = await runPluginUpdate('upd', tmp.zipPath, origin);
            assert.strictEqual(r.status, 409, JSON.stringify(r.body));
            assert.strictEqual(r.body.code, 'sandbox_unavailable');
            assert.strictEqual(r.body.details.sandbox.failure, INCIDENT_LINE);
            assert.strictEqual(r.body.rolledBack, true);
            assert.strictEqual(r.body.restoredVersion, '1.0.0');
            assert.strictEqual(r.body.reactivated, false);
            assert.match(r.body.message, /back on disk but is NOT running/);
            assert.deepStrictEqual(await getOption('active_plugins', []), [], 'the answer must match what happened: the plugin is inactive');
            assert.strictEqual(JSON.parse(fs.readFileSync(path.join(TMP_ROOT, 'plugins', 'upd', 'manifest.json'), 'utf8')).version, '1.0.0');
        } finally {
            tmp.dispose();
            launch = async () => ({ ok: true });
        }
    });
});
