/**
 * A SESSION ISSUED AFTER THE INSTALL MUST SURVIVE THE FIRST RESTART.
 *
 * Found live in split mode on the lab: right after finishing the wizard the admin was logged in, and the
 * first backend restart threw every one of those sessions out with 401 `rest_token_invalid`.
 *
 * THE MECHANISM. config/app.ts freezes `jwt.secret = fileConfig.jwtSecret || EPHEMERAL_JWT_SECRET` when
 * the process starts. A fresh box has no config, so it signs with a per-boot random secret. POST
 * /setup/install then generated a NEW jwtSecret and wrote it to wordjs-config.json while the running
 * process went on signing with the ephemeral one — the wizard's own auto-login cookie included. The
 * restart loaded the persisted secret, and nothing minted in between verified against it. Every mode
 * shares the defect: the monolith embeds the same backend, split mode only adds the cluster distributor
 * (which writes the installer's config through unchanged), and on an ENROLLED separate-mode node the
 * secret at boot is the one scripts/node-join.js wrote — which the installer rotated away the same way.
 *
 * HOW THIS DRIVES IT. The REAL install handler (routes/setup.ts), the REAL config loader (config/app.ts)
 * and the REAL session middleware (middleware/auth.ts `authenticate`) run against a wordjs-config.json in
 * a temp directory. A "restart" is what a new process does with that file: config/app.ts is evaluated
 * again from scratch, and the modules that bind it at load are re-required against the new instance.
 * Everything else the installer touches — the database, certificates, themes, the cluster distributor,
 * the core self-tests, the frontend purge — is stubbed: none of it bears on the secret, and all of it
 * writes outside the temp directory.
 *
 * THE OTHER SIDE OF IT. Persisting the boot-time secret makes it permanent, so a value pre-seeded into a
 * not-yet-installed config (a published placeholder, a short or non-string value) must not survive the boot.
 * The old installer overwrote it. The last two suites pin both halves of config/app.ts's gate: such a value is
 * replaced before anything signs with it, and an INSTALLED site's secret is never rotated.
 *
 * MUTATION PROOF: put back `const jwtSecret = crypto.randomBytes(64).toString('hex')` in the install
 * handler and every "still authenticates after a restart" test fails with 401 rest_token_invalid. Drop the
 * pre-install clause of config/app.ts's jwtSecretNeedsReplacing() and the weak-secret suite fails: the
 * deployment guide's old placeholder stays the live key, and the install makes it the persisted one.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the CWD FIRST: core/configManager resolves its CONFIG_FILE against it at module load.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-install-jwt-'));
const ORIGINAL_CWD = process.cwd();
process.chdir(TMP_ROOT);

// 2. config/app.ts anchors the same file to the installation (backend/wordjs-config.json) instead. Point
//    that one path — and only that path — at the sandbox, so both modules read and write ONE file, as
//    they do in production, and a developer's real config is never read or rewritten by this test.
const SANDBOX_CONFIG = path.join(TMP_ROOT, 'wordjs-config.json');
const ANCHORED_CONFIG = path.resolve(__dirname, '..', '..', 'wordjs-config.json');
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
const redirect = (p: any) =>
    (typeof p === 'string' && norm(path.resolve(p)) === norm(ANCHORED_CONFIG) ? SANDBOX_CONFIG : p);
const realFs = { existsSync: fs.existsSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync };
fs.existsSync = (p: any, ...rest: any[]) => realFs.existsSync(redirect(p), ...rest);
fs.readFileSync = (p: any, ...rest: any[]) => realFs.readFileSync(redirect(p), ...rest);
fs.writeFileSync = (p: any, ...rest: any[]) => realFs.writeFileSync(redirect(p), ...rest);

const request = require('supertest');
const jwt = require('jsonwebtoken');
const express = require('express');
const cookieParser = require('cookie-parser');

const INSTALL_TOKEN = 'install-jwt-continuity-token';
const ADMIN = { user: 'continuity', email: 'continuity@example.test', password: 'Continuity-Admin-1' };

// 3. Stubs for everything the installer touches beyond the config file. Registered by resolved filename,
//    so the handler's lazy `require(...)` calls find them.
function stub(file: string, exports: any) {
    require.cache[file] = { id: file, filename: file, loaded: true, exports } as any;
}
const fromHere = (rel: string) => require.resolve(rel);

// One administrator account, in memory — the shape generateToken / authenticate read.
let admin: any = null;
stub(fromHere('../models/User'), {
    findByEmail: async (email: string) => (admin && admin.userEmail === email ? admin : null),
    findByLogin: async (login: string) => (admin && admin.userLogin === login ? admin : null),
    findById: async (id: number) => (admin && admin.id === Number(id) ? admin : null),
    create: async (u: any) => { admin = { id: 1, userLogin: u.username, userEmail: u.email, meta: {} }; return admin; },
    update: async () => true,
});
stub(fromHere('../config/database'), { init: async () => {}, initializeDatabase: async () => {} });
stub(fromHere('../core/options'), { updateOption: async () => true, getOption: async () => null });
stub(fromHere('../core/roles'), { loadRoles: async () => {}, syncRoles: async () => {}, getRoles: () => ({}) });
stub(fromHere('../core/post-types'), { initPostTypes: async () => {}, initTaxonomies: async () => {} });
stub(fromHere('../models/Term'), { create: async () => ({}) });
stub(fromHere('../core/themes'), { createDefaultTheme: () => {} });
stub(fromHere('../core/certManager'), {
    generateClusterCA: () => ({ key: 'stub-ca-key', cert: 'stub-ca-cert' }),
    generateServiceCert: () => {},
});
stub(fromHere('../core/plugin-test-runner'), { runCoreTests: async () => ({ success: true, tests: 0, passed: 0, failed: 0 }) });
stub(fromHere('../core/install-token'), {
    verifyInstallToken: (t: unknown) => t === INSTALL_TOKEN,
    clearInstallTokenFile: () => {},
});
stub(fromHere('../core/mail-provider'), { isEmailProviderAvailable: () => false });
// The enrolled-node scenario keeps its gateway-issued certificate inside the sandbox.
const ENROLLED_CERT = path.join(TMP_ROOT, 'certs', 'backend.crt');
stub(fromHere('../core/frontend-purge'), {
    purgeFrontend: () => {},
    clusterCertPaths: () => ({ ca: path.join(TMP_ROOT, 'certs', 'cluster-ca.crt'), key: path.join(TMP_ROOT, 'certs', 'backend.key'), cert: ENROLLED_CERT }),
});
// Split mode hands the persisted config to the repo-root setup/ package, which rewrites the backend
// config as `{ ...existing, ...config }`. Record what it is handed instead of letting it write the repo.
let distributed: any[] = [];
stub(path.resolve(__dirname, '..', '..', '..', 'setup', 'index.js'), class {
    async distribute(cfg: any) { distributed.push({ ...cfg }); }
});

// Modules that bind `config/app` when they are evaluated. A new process evaluates them afresh.
const BOUND_TO_CONFIG = ['../config/app', '../routes/setup', '../middleware/auth', '../core/mfa'].map(fromHere);

/** Capture console output so the test can assert the secret never reaches a log line. */
async function quietly<T>(fn: () => Promise<T> | T): Promise<{ value: T; output: string }> {
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const saved: any = {};
    const lines: string[] = [];
    for (const m of methods) {
        saved[m] = (console as any)[m];
        (console as any)[m] = (...args: any[]) => { lines.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')); };
    }
    try {
        return { value: await fn(), output: lines.join('\n') };
    } finally {
        for (const m of methods) (console as any)[m] = saved[m];
    }
}

/** Start a "process": config/app.ts runs its boot-time load against whatever is on disk now. */
async function boot(): Promise<{ config: any; output: string }> {
    for (const file of BOUND_TO_CONFIG) delete require.cache[file];
    require('../core/configManager').invalidateConfigCache();
    const { value, output } = await quietly(() => require('../config/app'));
    return { config: value, output };
}

/** POST /setup/install against the current process, as the wizard sends it. */
async function install(body: Record<string, unknown> = {}) {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/setup', require('../routes/setup'));
    const { value: res, output } = await quietly(() =>
        request(app)
            .post('/setup/install')
            .set('x-install-token', INSTALL_TOKEN)
            .send({
                siteName: 'Continuity',
                adminUser: ADMIN.user,
                adminEmail: ADMIN.email,
                adminPassword: ADMIN.password,
                dbDriver: 'sqlite-native',
                demoContent: false,
                siteUrl: 'http://localhost:3000',
                ...body,
            })
    );
    const { SESSION_COOKIE } = require('../middleware/auth');
    const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] || []);
    const session = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    const token = session ? decodeURIComponent(session.split(';')[0].slice(SESSION_COOKIE.length + 1)) : '';
    return { res, token, output };
}

/** What the CURRENT process answers for a browser presenting this session cookie on an authenticated route. */
async function whoami(token: string) {
    const { authenticate, SESSION_COOKIE } = require('../middleware/auth');
    const app = express();
    app.use(cookieParser());
    app.get('/me', authenticate, (req: any, res: any) => res.json({ id: req.user.id }));
    return request(app).get('/me').set('Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}`);
}

const persisted = () => JSON.parse(realFs.readFileSync(SANDBOX_CONFIG, 'utf8'));

const savedEmbedded = process.env.WORDJS_EMBEDDED;

/** A brand-new box: no config, no certificates, no account; split mode unless the scenario says otherwise. */
function freshMachine() {
    try { fs.rmSync(SANDBOX_CONFIG, { force: true }); } catch { /* absent */ }
    try { fs.rmSync(path.join(TMP_ROOT, 'certs'), { recursive: true, force: true }); } catch { /* absent */ }
    admin = null;
    distributed = [];
    delete process.env.WORDJS_EMBEDDED;
}

after(() => {
    if (savedEmbedded === undefined) delete process.env.WORDJS_EMBEDDED; else process.env.WORDJS_EMBEDDED = savedEmbedded;
    fs.existsSync = realFs.existsSync;
    fs.readFileSync = realFs.readFileSync;
    fs.writeFileSync = realFs.writeFileSync;
    for (const file of BOUND_TO_CONFIG) delete require.cache[file];
    process.chdir(ORIGINAL_CWD);
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('a fresh single-host install (monolith): sessions minted before the first restart survive it', () => {
    let firstBoot: any;
    let secretAtBoot = '';
    let installed: Awaited<ReturnType<typeof install>>;
    let laterLogin = '';

    before(async () => {
        freshMachine();
        process.env.WORDJS_EMBEDDED = '1'; // monolith: the backend runs inside monolith.js
        // The sandbox is in force: config/app.ts's own path answers from the (empty) temp directory, not
        // from whatever wordjs-config.json the checkout running this test happens to hold.
        assert.strictEqual(fs.existsSync(ANCHORED_CONFIG), false);
        firstBoot = await boot();
        secretAtBoot = firstBoot.config.jwt.secret;
        installed = await install();
        // A login after the wizard, still before any restart: the other half of "sessions minted after
        // the install but before the restart".
        laterLogin = require('../middleware/auth').generateToken(admin);
    });

    it('boots unconfigured, signing with a per-process secret', () => {
        assert.match(firstBoot.output, /No JWT secret configured/);
        // 64 random bytes: this is the value the install persists, so it must be as strong as the secret
        // the installer used to generate itself.
        assert.match(secretAtBoot, /^[0-9a-f]{128}$/, 'an unconfigured boot must sign with 64 random bytes');
    });

    it('the install succeeds and auto-logs the administrator in', () => {
        assert.strictEqual(installed.res.status, 200, JSON.stringify(installed.res.body));
        assert.strictEqual(installed.res.body.autoLoggedIn, true);
        assert.ok(installed.token, 'the install response must carry the session cookie');
    });

    it('the secret on disk is the secret the live process signs with', () => {
        assert.strictEqual(persisted().jwtSecret, firstBoot.config.jwt.secret);
    });

    it('the install never changes the live secret, so values derived from it at load stay valid', () => {
        // core/collab-rooms derives its replica-identity key from jwt.secret ONCE, at module load. Had the
        // installer swapped the live secret instead of persisting it, that key would go stale until the
        // restart and replica ids would change across it.
        assert.strictEqual(firstBoot.config.jwt.secret, secretAtBoot);
    });

    it('both sessions authenticate before the restart', async () => {
        assert.strictEqual((await whoami(installed.token)).status, 200);
        assert.strictEqual((await whoami(laterLogin)).status, 200);
    });

    it('the auto-login session still authenticates after a restart', async () => {
        await boot();
        const res = await whoami(installed.token);
        assert.strictEqual(res.status, 200, `the wizard's own session was rejected after a restart: ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.id, admin.id);
    });

    it('a login made after the install still authenticates after a restart', async () => {
        await boot();
        const res = await whoami(laterLogin);
        assert.strictEqual(res.status, 200, `a post-install login was rejected after a restart: ${JSON.stringify(res.body)}`);
    });

    it('the secret is never logged or answered', async () => {
        const secret = persisted().jwtSecret;
        assert.ok(!installed.output.includes(secret), 'the install logged the JWT secret');
        assert.ok(!firstBoot.output.includes(secret), 'the boot logged the JWT secret');
        assert.ok(!JSON.stringify(installed.res.body).includes(secret), 'the install response carries the JWT secret');
        const restart = await boot();
        assert.ok(!restart.output.includes(secret), 'the restart logged the JWT secret');
    });
});

describe('a fresh split-mode install: the cluster distributor writes the same secret', () => {
    it('the distributor is handed the live secret, and the session survives a restart', async () => {
        freshMachine();
        const first = await boot();
        const { res, token } = await install();
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(distributed.length, 1, 'split mode must hand the config to the cluster distributor');
        assert.strictEqual(distributed[0].jwtSecret, first.config.jwt.secret,
            'the distributor rewrites backend/wordjs-config.json from this object — it must carry the live secret');
        assert.strictEqual(persisted().jwtSecret, first.config.jwt.secret);

        await boot();
        const after = await whoami(token);
        assert.strictEqual(after.status, 200, `split-mode session rejected after a restart: ${JSON.stringify(after.body)}`);
    });
});

describe('an enrolled separate-mode node: the installer keeps the secret it booted with', () => {
    const ENROLLED_SECRET = 'e'.repeat(128);

    it('the enrollment secret is neither rotated nor diverged from, and the session survives a restart', async () => {
        freshMachine();
        // The shape scripts/node-join.js writes, gateway-issued certificate on disk.
        realFs.writeFileSync(SANDBOX_CONFIG, JSON.stringify({
            gatewayHost: '10.0.0.5',
            gatewayInternalPort: 3100,
            gatewayPort: 3000,
            gatewaySecret: 'shared-with-the-gateway',
            gatewaySsl: { enabled: true },
            siteUrl: 'https://10.0.0.5:3000',
            advertiseHost: '10.0.0.6',
            host: '0.0.0.0',
            port: 4000,
            jwtSecret: ENROLLED_SECRET,
            mtls: { ca: './certs/cluster-ca.crt', key: './certs/backend.key', cert: './certs/backend.crt' },
        }, null, 2));
        fs.mkdirSync(path.dirname(ENROLLED_CERT), { recursive: true });
        realFs.writeFileSync(ENROLLED_CERT, 'gateway-issued leaf');

        const first = await boot();
        assert.strictEqual(first.config.jwt.secret, ENROLLED_SECRET, 'an enrolled node boots with the secret enrollment wrote');

        const { res, token, output } = await install({ siteUrl: 'https://10.0.0.5:3000' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.match(output, /cluster-enrolled node detected/, 'the scenario must take the enrolled-node path');
        assert.strictEqual(persisted().jwtSecret, ENROLLED_SECRET, 'the installer rotated the enrolled node\'s JWT secret');

        await boot();
        const after = await whoami(token);
        assert.strictEqual(after.status, 200, `enrolled-node session rejected after a restart: ${JSON.stringify(after.body)}`);
    });
});

/** Whatever a config held before the install, written as an operator would have written it. */
function preseed(cfg: Record<string, unknown>) {
    freshMachine();
    realFs.writeFileSync(SANDBOX_CONFIG, JSON.stringify(cfg, null, 2));
}

describe('a pre-install config with a weak jwtSecret: the install never makes it the signing key', () => {
    // Because the install now persists the secret the process booted with, a value pre-seeded into a
    // not-yet-installed config would become the site's PERMANENT key. The old installer overwrote it with a
    // random one. A value anyone can read (a published placeholder) or guess (a short one) would let them
    // sign an administrator session, so boot must replace it before anything signs with it.
    const weakSecrets: Array<[string, unknown]> = [
        // Verbatim from the example config documentation/deployment.md shipped as "Recommended".
        ['the deployment guide\'s example placeholder', 'auto-generated-secure-secret'],
        ['the docker-compose dev placeholder', 'wordjs-shared-dev-secret-change-me'],
        ['the core default placeholder', 'wordjs-default-secret-change-me'],
        ['a short hand-written value', 'secret'],
        // jsonwebtoken refuses a number as key material: persisted, it would stop the site issuing sessions.
        ['a non-string value', 123456789],
    ];

    for (const [label, weak] of weakSecrets) {
        it(`${label} is replaced at boot, and cannot sign a session once the site is installed`, async () => {
            preseed({
                siteUrl: 'https://my-site.com',
                frontendUrl: 'https://my-site.com',
                port: 4000,
                gatewayPort: 3000,
                jwtSecret: weak,
                gatewaySecret: 'auto-generated-secure-secret',
                nodeEnv: 'production',
            });

            const first = await boot();
            const live = first.config.jwt.secret;
            assert.notStrictEqual(live, weak, 'boot kept the weak secret as the live signing key');
            assert.match(String(live), /^[0-9a-f]{128}$/, 'the replacement must be 64 random bytes');
            assert.strictEqual(persisted().jwtSecret, live, 'boot persists the replacement, as it does for the core placeholder');
            assert.ok(!first.output.includes(live), 'the boot logged the replacement secret');

            const { res, token } = await install();
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body.autoLoggedIn, true, 'the install must be able to sign the administrator in');
            assert.strictEqual(persisted().jwtSecret, live, 'the install persisted something other than the live secret');

            await boot();
            const forged = jwt.sign({ userId: admin.id, username: admin.userLogin }, String(weak), { expiresIn: '2h' });
            const attack = await whoami(forged);
            assert.strictEqual(attack.status, 401,
                `a session signed with the pre-seeded value authenticated after install + restart: ${JSON.stringify(attack.body)}`);
            const legit = await whoami(token);
            assert.strictEqual(legit.status, 200, `the install-time session was rejected after a restart: ${JSON.stringify(legit.body)}`);
        });
    }

    it('a pre-install config with NO jwtSecret gets 64 random bytes, which the install then keeps', async () => {
        preseed({ gatewayPort: 3005 });
        const first = await boot();
        assert.match(first.config.jwt.secret, /^[0-9a-f]{128}$/);
        assert.strictEqual(persisted().jwtSecret, first.config.jwt.secret);
        const { res } = await install();
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(persisted().jwtSecret, first.config.jwt.secret);
    });
});

describe('an INSTALLED site keeps its jwtSecret: the pre-install gate never rotates a live site', () => {
    // Rotating an installed site's secret signs every user out, and on a multi-node tier it splits the
    // replicas that share it (docker-compose's replicas share the dev placeholder on purpose).
    for (const kept of ['wordjs-shared-dev-secret-change-me', 'short-installed-secret']) {
        it(`"${kept}" survives the boot unchanged`, async () => {
            preseed({ installedAt: '2026-01-01T00:00:00.000Z', dbDriver: 'postgres', dbPassword: 'not-the-default', jwtSecret: kept });
            const first = await boot();
            assert.strictEqual(first.config.jwt.secret, kept);
            assert.strictEqual(persisted().jwtSecret, kept);
        });
    }
});
