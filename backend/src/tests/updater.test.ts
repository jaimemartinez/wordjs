/**
 * WordJS — Admin → Updates (core/updater, routes/update.ts, scripts/update-rollback.js), on the REAL app.
 * The network (GitHub's releases feed) and the process runner (the release's own create-wordjs, run by
 * this Node binary) are injected;
 * everything around them is real:
 *
 *   - where the panel refuses, and what it says to do instead: a container, a git checkout, split mode,
 *     code this process cannot write, no supervisor;
 *   - the releases: only the project's published tags with a bundle, newest first, never a downgrade,
 *     and never one that publishes no checksum for its bundle (listed, but refused with its reason);
 *   - POST /system/update: password AND a fresh two-factor code, administrators only, never an API token;
 *     then a backup, the CLI the installed release shipped (<root>/packages/create-wordjs/index.js) with
 *     exactly `upgrade <root> --yes --version <tag>` — no registry package, no shell — the state
 *     `applied` and a restart (exit code 75 to the supervisor);
 *   - a failed CLI run puts the previous version back (`--version v<current> --force`) and says so;
 *   - the first boot after an update marks it done; the supervisor rolls back one that does not start,
 *     once, and only right after the update.
 *
 * MUTATION PROOF (verified once each): drop requireStepUp from POST /system/update → the "no code" case
 * starts an update; drop the not-newer check → a downgrade runs; drop the rollback branch → a failed
 * update stays failed with no second CLI run; make shouldRollBack ignore the state → an old `done`
 * update is rolled back.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const ORIGINAL_CWD = process.cwd();
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-update-${process.pid}-`));
const BACKEND = path.join(ROOT, 'backend');
for (const d of ['backend/data', 'frontend']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({ name: 'wordjs', version: '2.7.0' }));
fs.writeFileSync(path.join(BACKEND, 'package.json'), JSON.stringify({ name: 'backend', version: '2.7.0' }));
// The upgrade CLI every release ships; the panel runs this copy, never one fetched at update time.
fs.mkdirSync(path.join(ROOT, 'packages', 'create-wordjs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'packages', 'create-wordjs', 'index.js'), '// fixture\n');
const CLI = path.join(ROOT, 'packages', 'create-wordjs', 'index.js');
const MAIN = 'localhost:3000';
fs.writeFileSync(path.join(BACKEND, 'wordjs-config.json'), JSON.stringify({ installedAt: '2026-01-01T00:00:00.000Z', dbDriver: 'sqlite-native', siteUrl: `http://${MAIN}` }, null, 2));
process.chdir(BACKEND);
const ENV_KEYS = ['WORDJS_SUPERVISED', 'WORDJS_EMBEDDED', 'WORDJS_DOCKER', 'KUBERNETES_SERVICE_HOST'];
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) { SAVED_ENV[key] = process.env[key]; delete process.env[key]; }
process.env.WORDJS_SUPERVISED = '1';
process.env.WORDJS_EMBEDDED = '1';

const config = require('../config/app');
config.dbPath = path.join(BACKEND, 'data', 'wordjs-native.db');
config.dbDriver = 'sqlite-native';
config.siteUrl = `http://${MAIN}`;
config.site.url = `http://${MAIN}`;
config.nodeEnv = 'production';

// This run's version is the fixture's (the real resolveProductVersion reads the repo's package.json).
require('../config/product-version').resolveProductVersion = () => current;
let current = '2.7.0';

const updater = require('../core/updater');
const restart = require('../core/restart');
const RELEASES = [
    { tag_name: 'v2.8.0', name: 'WordJS 2.8.0', body: '## What changed\n- Panel updates', published_at: '2026-10-21T00:00:00Z', assets: [{ name: 'wordjs-v2.8.0.zip' }, { name: 'wordjs-v2.8.0.zip.sha256' }] },
    { tag_name: 'v2.9.0-rc.1', name: 'RC', prerelease: true, assets: [{ name: 'wordjs-v2.9.0-rc.1.zip' }] },
    // Newer, with a bundle but no checksum: listed, never installed by the panel.
    { tag_name: 'v2.8.1', name: 'WordJS 2.8.1', published_at: '2026-10-22T00:00:00Z', assets: [{ name: 'wordjs-v2.8.1.zip' }] },
    { tag_name: 'v2.7.0', name: 'WordJS 2.7.0', assets: [{ name: 'wordjs-v2.7.0.zip' }] },
    { tag_name: 'v2.6.0', name: 'WordJS 2.6.0', assets: [{ name: 'wordjs-v2.6.0.zip' }] },
    { tag_name: 'nightly', assets: [] },
];
const runs: string[][] = [];
let exitCodes: number[] = [];
const probeState = { docker: false, podman: false, git: false, writable: true, noCli: false };
updater._setForTests({
    fetchJson: async () => RELEASES,
    runner: async (args: string[]) => { runs.push(args); return exitCodes.length ? exitCodes.shift()! : 0; },
    probe: {
        exists: (p: string) => (p === '/.dockerenv' ? probeState.docker : p === '/run/.containerenv' ? probeState.podman
            : p.endsWith(`${path.sep}.git`) ? probeState.git : (p === CLI && probeState.noCli) ? false : fs.existsSync(p)),
        writable: () => probeState.writable,
    },
});
// The backup runs for real elsewhere (backup-private-media.test.ts); here it must exist and be first.
const backup = require('../core/backup');
let backups = 0;
backup.createBackup = async () => { backups++; return { filename: `backup-${backups}.zip` }; };

const request = require('supertest');
const database = require('../config/database');
const siteContext = require('../core/site-context');
const totp = require('../core/totp');
const mfa = require('../core/mfa');
const User = require('../models/User');
const app = require('../index');

const API = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
let server: any;
const U: Record<string, number> = {};
const tokens: Record<string, string> = {};
let secret = '';
const exits: number[] = [];
const realNow = Date.now;
let offsetMs = 0;
Date.now = () => realNow() + offsetMs;
const freshCode = () => { offsetMs += 31 * 1000; return totp.totp(secret); };
const as = (who: string, method: string, url: string) => (request(server) as any)[method](url).set('Host', MAIN).set('Origin', `http://${MAIN}`).set('Authorization', `Bearer ${tokens[who]}`);

async function settle(): Promise<void> {
    for (let i = 0; i < 100 && updater.status().running; i++) await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 80 && !exits.length; i++) await new Promise((r) => setTimeout(r, 25));
}

before(async () => {
    restart.setExitHandlerForTests((code: number) => { exits.push(code); });
    await siteContext.runWithSite(1, async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        await require('../core/options').initDefaultOptions(config);
        await require('../core/roles').loadRoles();
        const db = database.getDbAsync();
        for (const [login, role] of [['owner', 'administrator'], ['writer', 'author'], ['plain', 'administrator']]) {
            const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`, [login, bcrypt.hashSync(PASSWORD, 10), `${login}@example.com`, login]);
            await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
            U[login] = r.lastID;
        }
    });
    require('../core/plugins-ready').markPluginsReady();
    server = http.createServer(app);
    await new Promise<void>((resolve) => siteContext.runWithSite(null, () => server.listen(0, '127.0.0.1', resolve)));
    // 'plain' is an administrator without two-factor authentication; 'owner' enrols below.
    for (const login of ['owner', 'writer', 'plain']) {
        const res = await (request(server) as any).post(`${API}/auth/login`).set('Host', MAIN).set('Origin', `http://${MAIN}`).send({ username: login, password: PASSWORD });
        const cookie = ([] as string[]).concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('wordjs_token='));
        tokens[login] = decodeURIComponent(String(cookie).split(';')[0].slice('wordjs_token='.length));
    }
    tokens.apiToken = (await as('owner', 'post', `${API}/auth/tokens`).send({ name: 'automation', scopes: '*' })).body.token;
    secret = totp.generateSecret();
    await siteContext.runWithSite(1, async () => {
        await User.updateMeta(U.owner, mfa.META.lastStep, '-1');
        await User.updateMeta(U.owner, mfa.META.secret, secret);
        await User.updateMeta(U.owner, mfa.META.backup, JSON.stringify([]));
        await User.updateMeta(U.owner, mfa.META.enabled, '1');
    });
});

after(async () => {
    restart.setExitHandlerForTests(null);
    Date.now = realNow;
    try { await new Promise<void>((resolve) => server.close(() => resolve())); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const key of ENV_KEYS) { if (SAVED_ENV[key] === undefined) delete process.env[key]; else process.env[key] = SAVED_ENV[key]; }
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
});

describe('where the panel may update, and what it says otherwise', () => {
    test('a release install under the supervisor may; each other case is refused with its instruction', () => {
        assert.strictEqual(updater.environment().canUpdate, true, JSON.stringify(updater.environment()));
        const cases: Array<[string, () => void, () => void, RegExp]> = [
            ['docker', () => { probeState.docker = true; }, () => { probeState.docker = false; }, /pull the new image/],
            // containerd / CRI-O (every Kubernetes node) write no /.dockerenv: the pod's own variable says so.
            ['docker', () => { process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1'; }, () => { delete process.env.KUBERNETES_SERVICE_HOST; }, /Kubernetes: update the image tag .*helm upgrade/],
            ['docker', () => { process.env.WORDJS_DOCKER = '1'; }, () => { delete process.env.WORDJS_DOCKER; }, /pull the new image/],
            ['docker', () => { probeState.podman = true; }, () => { probeState.podman = false; }, /pull the new image/],
            ['source_checkout', () => { probeState.git = true; }, () => { probeState.git = false; }, /git pull/],
            ['not_writable', () => { probeState.writable = false; }, () => { probeState.writable = true; }, /sudo npx create-wordjs@latest upgrade/],
            // A release without its upgrade CLI cannot be updated by the panel (nothing is fetched instead).
            ['not_a_release', () => { probeState.noCli = true; }, () => { probeState.noCli = false; }, /does not look like a WordJS release/],
            ['split_mode', () => { delete process.env.WORDJS_EMBEDDED; }, () => { process.env.WORDJS_EMBEDDED = '1'; }, /each machine/],
            ['no_supervisor', () => { delete process.env.WORDJS_SUPERVISED; }, () => { process.env.WORDJS_SUPERVISED = '1'; }, /supervisor/],
        ];
        for (const [reason, set, reset, how] of cases) {
            set();
            try {
                const env = updater.environment();
                assert.strictEqual(env.canUpdate, false, reason);
                assert.strictEqual(env.reason, reason);
                assert.match(env.how, how, reason);
            } finally { reset(); }
        }
    });
});

describe('a container is recognised however it was started (FALLOS 131)', () => {
    test('Kubernetes wins over the other signs, since its instruction is the one that works there', () => {
        assert.strictEqual(updater.containerKind({ KUBERNETES_SERVICE_HOST: '10.96.0.1', WORDJS_DOCKER: '1' }), 'kubernetes');
        assert.strictEqual(updater.containerKind({ WORDJS_DOCKER: '1' }), 'container');
        assert.strictEqual(updater.containerKind({}), null);
    });

    test('the image and the Helm chart set WORDJS_DOCKER=1, so no in-place update is offered in a pod', () => {
        const repo = path.resolve(__dirname, '../../..');
        const dockerfile = fs.readFileSync(path.join(repo, 'Dockerfile'), 'utf8');
        assert.match(dockerfile, /^ENV [\s\S]*?\bWORDJS_DOCKER=1\b/m);
        const deployment = fs.readFileSync(path.join(repo, 'deploy/helm/wordjs/templates/deployment.yaml'), 'utf8');
        assert.match(deployment, /- name: WORDJS_DOCKER\s*\n\s*value: "1"/);
    });
});

describe('Admin → Updates', () => {
    test('GET lists the newer published releases with their notes; administrators only, never an API token', async () => {
        const res = await as('owner', 'get', `${API}/system/update`);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.current, '2.7.0');
        assert.strictEqual(res.body.latest.tag, 'v2.8.1');
        assert.deepStrictEqual(res.body.newer.map((r: any) => r.tag), ['v2.8.1', 'v2.8.0'], 'no pre-release, no older, no unversioned tag');
        assert.strictEqual(res.body.newer[0].hasChecksum, false, 'the one without a checksum says so');
        assert.match(res.body.newer[1].notes, /Panel updates/);
        assert.strictEqual(res.body.newer[1].hasChecksum, true);
        assert.strictEqual(res.body.environment.canUpdate, true);
        assert.strictEqual((await as('writer', 'get', `${API}/system/update`)).status, 403);
        assert.strictEqual((await (request(server) as any).get(`${API}/system/update`).set('Host', MAIN).set('Authorization', `Bearer ${tokens.apiToken}`)).status, 403);
    });

    test('installing takes the password and a fresh code; no downgrade, no unpublished tag', async () => {
        const noCode = await as('owner', 'post', `${API}/system/update`).send({ tag: 'v2.8.0', currentPassword: PASSWORD });
        assert.strictEqual(noCode.status, 403);
        assert.strictEqual(noCode.body.code, 'rest_mfa_step_up_required');
        const badPw = await as('owner', 'post', `${API}/system/update`).send({ tag: 'v2.8.0', currentPassword: 'nope', mfaCode: freshCode() });
        assert.strictEqual(badPw.status, 403);
        const older = await as('owner', 'post', `${API}/system/update`).send({ tag: 'v2.6.0', currentPassword: PASSWORD, mfaCode: freshCode() });
        assert.strictEqual(older.status, 409, JSON.stringify(older.body));
        assert.strictEqual(older.body.code, 'update_not_newer');
        const fake = await as('owner', 'post', `${API}/system/update`).send({ tag: 'v9.9.9', currentPassword: PASSWORD, mfaCode: freshCode() });
        assert.strictEqual(fake.status, 400);
        assert.strictEqual(fake.body.code, 'update_unknown_release');
        const unverified = await as('owner', 'post', `${API}/system/update`).send({ tag: 'v2.8.1', currentPassword: PASSWORD, mfaCode: freshCode() });
        assert.strictEqual(unverified.status, 409, JSON.stringify(unverified.body));
        assert.strictEqual(unverified.body.code, 'update_unverified_release');
        assert.match(unverified.body.message, /publishes no checksum/);
        const shell = await as('owner', 'post', `${API}/system/update`).send({ tag: 'v2.8.0; rm -rf /', currentPassword: PASSWORD, mfaCode: freshCode() });
        assert.strictEqual(shell.status, 400);
        assert.strictEqual(shell.body.code, 'update_invalid_tag');
        assert.deepStrictEqual(runs, [], 'nothing ran');
        assert.strictEqual(backups, 0);
    });

    test('a successful update: backup first, the official CLI with the exact arguments, applied, restart', async () => {
        const res = await as('owner', 'post', `${API}/system/update`).send({ tag: 'v2.8.0', currentPassword: PASSWORD, mfaCode: freshCode() });
        assert.strictEqual(res.status, 202, JSON.stringify(res.body));
        await settle();
        assert.strictEqual(backups, 1, 'a backup was taken');
        assert.deepStrictEqual(runs, [[CLI, 'upgrade', ROOT, '--yes', '--version', 'v2.8.0']]);
        const state = updater.readState();
        assert.strictEqual(state.state, 'applied');
        assert.strictEqual(state.fromTag, 'v2.7.0');
        assert.strictEqual(state.backup, 'backup-1.zip');
        assert.deepStrictEqual(exits.splice(0), [restart.RESTART_EXIT_CODE]);
        restart.resetForTests();
        const row = await siteContext.runWithSite(1, () => database.getDbAsync().get("SELECT detail FROM audit_log WHERE action = 'system.update.start'"));
        assert.match(String(row.detail), /2\.8\.0/);
        assert.match(String(row.detail), /"reauth":"password\+2fa"/, 'the audit says the password and a code confirmed it');

        // The new version comes up: the update is done.
        current = '2.8.0';
        updater.markBootCompleted();
        assert.strictEqual(updater.readState().state, 'done');
        current = '2.7.0';
    });

    test('a failed CLI run puts the previous version back and says so (started by an administrator without 2FA, on the password alone)', async () => {
        runs.length = 0;
        exitCodes = [1, 0];
        const wrongPw = await as('plain', 'post', `${API}/system/update`).send({ tag: 'v2.8.0', currentPassword: 'nope' });
        assert.strictEqual(wrongPw.status, 403);
        assert.strictEqual(wrongPw.body.code, 'rest_bad_current_password');
        assert.deepStrictEqual(runs, [], 'a wrong password starts nothing');
        const res = await as('plain', 'post', `${API}/system/update`).send({ tag: 'v2.8.0', currentPassword: PASSWORD });
        assert.strictEqual(res.status, 202, JSON.stringify(res.body));
        const started = await siteContext.runWithSite(1, () => database.getDbAsync().all("SELECT detail FROM audit_log WHERE action = 'system.update.start'"));
        assert.ok(started.some((r: any) => /"reauth":"password"/.test(String(r.detail))), 'audited as confirmed by the password alone');
        await settle();
        assert.deepStrictEqual(runs, [
            [CLI, 'upgrade', ROOT, '--yes', '--version', 'v2.8.0'],
            [CLI, 'upgrade', ROOT, '--yes', '--version', 'v2.7.0', '--force'],
        ]);
        const state = updater.readState();
        assert.strictEqual(state.state, 'rolled_back');
        assert.match(state.error, /exit code 1/);
        restart.resetForTests();
        exits.length = 0;
    });
});

describe('the supervisor rolls back a new version that does not start', () => {
    const rollback = require('../../scripts/update-rollback.js');
    const file = () => path.join(BACKEND, 'data', 'update-state.json');
    const write = (s: any) => fs.writeFileSync(file(), JSON.stringify(s));

    test('right after an applied update: the previous tag is re-applied once', () => {
        write({ state: 'applied', from: '2.7.0', fromTag: 'v2.7.0', to: '2.8.0', appliedAt: new Date(realNow()).toISOString() });
        const calls: any[] = [];
        const ok = rollback.rollBack({ file: file(), root: ROOT, log: () => {}, spawnSync: (cmd: string, args: string[], opts: any) => { calls.push({ cmd, args, shell: opts.shell, nodePath: opts.env.NODE_PATH }); return { status: 0 }; } });
        assert.strictEqual(ok, true);
        assert.deepStrictEqual(calls, [{ cmd: process.execPath, args: [CLI, 'upgrade', ROOT, '--yes', '--version', 'v2.7.0', '--force'], shell: false, nodePath: path.join(ROOT, 'backend', 'node_modules') }]);
        assert.strictEqual(JSON.parse(fs.readFileSync(file(), 'utf8')).state, 'rolled_back');
        assert.strictEqual(rollback.rollBack({ file: file(), root: ROOT, log: () => {}, spawnSync: () => { throw new Error('must not run twice'); } }), false);
    });

    test('never for a done update, an old one, or no update at all', () => {
        const never = () => { throw new Error('must not run'); };
        write({ state: 'done', fromTag: 'v2.7.0', appliedAt: new Date(realNow()).toISOString() });
        assert.strictEqual(rollback.rollBack({ file: file(), root: ROOT, log: () => {}, spawnSync: never }), false);
        write({ state: 'applied', fromTag: 'v2.7.0', appliedAt: new Date(realNow() - 60 * 60 * 1000).toISOString() });
        assert.strictEqual(rollback.rollBack({ file: file(), root: ROOT, log: () => {}, spawnSync: never }), false);
        fs.rmSync(file(), { force: true });
        assert.strictEqual(rollback.rollBack({ file: file(), root: ROOT, log: () => {}, spawnSync: never }), false);
    });
});

describe('the upgrade runs the shipped CLI with this Node binary and no shell', () => {
    test('arguments arrive exactly as given, whatever the install path contains', async () => {
        // A path a shell would split or interpret: spaces, an ampersand, a quote and a dollar sign.
        const odd = fs.mkdtempSync(path.join(os.tmpdir(), "wjs update & $HOME 'x' "));
        try {
            const cli = path.join(odd, 'packages', 'create-wordjs', 'index.js');
            const out = path.join(odd, 'argv.json');
            fs.mkdirSync(path.dirname(cli), { recursive: true });
            fs.writeFileSync(cli, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), nodePath: process.env.NODE_PATH, exec: process.execPath }));\nconsole.log('Syncing runtime dependencies');\n`);
            const lines: string[] = [];
            const code = await updater._defaultRunner(updater.upgradeArgs(odd, 'v2.8.0'), odd, (l: string) => lines.push(l));
            assert.strictEqual(code, 0, lines.join('\n'));
            const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
            assert.deepStrictEqual(seen.argv, ['upgrade', odd, '--yes', '--version', 'v2.8.0']);
            assert.strictEqual(seen.nodePath, path.join(odd, 'backend', 'node_modules'));
            assert.strictEqual(seen.exec, process.execPath);
            assert.ok(lines.some((l) => /Syncing runtime dependencies/.test(l)));
        } finally {
            fs.rmSync(odd, { recursive: true, force: true });
        }
    });
});
