/**
 * A FAILED INSTALL LEAVES THE WIZARD RUNNABLE.
 *
 * Found by an operator running a source checkout in development on Windows. The dependencies had been
 * installed with `npm install --ignore-scripts`, which skips better-sqlite3's install script — the step
 * that puts its compiled binary in place. `require('better-sqlite3')` still succeeds (the binary is only
 * opened by the first `new Database()`), so nothing noticed until POST /setup/install had already written
 * wordjs-config.json and then failed to open the database with "Could not locate the bindings file". That
 * file marks the site installed, so every retry was answered "Already installed" — no database, no
 * administrator — until it was deleted by hand.
 *
 * Two fixes, both driven here through the REAL install handler (routes/setup.ts) and the REAL config
 * writer (core/configManager) against a wordjs-config.json in a temp directory; everything else the
 * installer touches is stubbed, in memory:
 *   1. The native driver is asked BEFORE anything is written; the answer says how to fix it.
 *   2. A failure before the administrator account exists puts the config back exactly as it was (no file
 *      on a fresh box), and every step before that point can be repeated, so the wizard simply runs
 *      again. After it, the site exists and the config is kept.
 *
 * MUTATION PROOF (each applied to routes/setup.ts, watched to fail, restored): drop the sqlite-native
 * check before the write (suite 1 fails: the config is written); make failedText() never call
 * undoInstall() (suite 2 fails: "Already installed" on the retry); drop the Term.findBySlug guard (the
 * retry after a failure past the default category fails with "Term already exists"); set adminReady
 * before User.create (the failure before the account keeps the config).
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the CWD FIRST: core/configManager resolves its CONFIG_FILE against it at module load.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-install-undo-'));
const ORIGINAL_CWD = process.cwd();
process.chdir(TMP_ROOT);

// 2. config/app.ts anchors the same file to backend/wordjs-config.json. Point that one path at the
//    sandbox, so a developer's real config is never read or rewritten by this test.
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
const express = require('express');
const cookieParser = require('cookie-parser');

const INSTALL_TOKEN = 'install-undo-token';

function stub(file: string, exports: any) {
    require.cache[file] = { id: file, filename: file, loaded: true, exports } as any;
}
const fromHere = (rel: string) => require.resolve(rel);

// What the stubs remember, and where a scenario makes the install fail.
let admin: any = null;
let terms: Set<string> = new Set();
let nativeError: Error | null = null;
let failAt: 'roles' | 'theme' | 'admin' | 'core-tests' | null = null;
const boom = (where: string) => { throw new Error(`stubbed failure at ${where}`); };

stub(fromHere('../models/User'), {
    findByEmail: async (email: string) => (admin && admin.userEmail === email ? admin : null),
    findByLogin: async (login: string) => (admin && admin.userLogin === login ? admin : null),
    findById: async (id: number) => (admin && admin.id === Number(id) ? admin : null),
    create: async (u: any) => { if (failAt === 'admin') boom('admin'); admin = { id: 1, userLogin: u.username, userEmail: u.email, meta: {} }; return admin; },
    update: async () => true,
});
stub(fromHere('../config/database'), {
    init: async () => {},
    initializeDatabase: async () => {},
    nativeSqliteLoadError: () => nativeError,
});
stub(fromHere('../core/options'), { updateOption: async () => true, getOption: async () => null });
stub(fromHere('../core/roles'), {
    loadRoles: async () => {},
    syncRoles: async () => { if (failAt === 'roles') boom('roles'); },
    getRoles: () => ({}),
});
stub(fromHere('../core/post-types'), { initPostTypes: async () => {}, initTaxonomies: async () => {} });
// Like the real model: a second create of the same term throws.
stub(fromHere('../models/Term'), {
    findBySlug: async (slug: string, taxonomy: string) => (terms.has(`${taxonomy}:${slug}`) ? { slug } : null),
    create: async (t: any) => {
        const key = `${t.taxonomy}:${t.slug}`;
        if (terms.has(key)) throw new Error('Term already exists');
        terms.add(key);
        return {};
    },
});
stub(fromHere('../core/themes'), { createDefaultTheme: () => { if (failAt === 'theme') boom('theme'); } });
stub(fromHere('../core/certManager'), {
    generateClusterCA: () => ({ key: 'stub-ca-key', cert: 'stub-ca-cert' }),
    generateServiceCert: () => {},
});
stub(fromHere('../core/plugin-test-runner'), {
    runCoreTests: async () => {
        if (failAt === 'core-tests') boom('core-tests');
        return { success: true, tests: 0, passed: 0, failed: 0 };
    },
});
stub(fromHere('../core/install-token'), {
    verifyInstallToken: (t: unknown) => t === INSTALL_TOKEN,
    clearInstallTokenFile: () => {},
});
stub(fromHere('../core/mail-provider'), { isEmailProviderAvailable: () => false });
stub(fromHere('../core/frontend-purge'), {
    purgeFrontend: () => {},
    clusterCertPaths: () => ({ ca: path.join(TMP_ROOT, 'certs', 'cluster-ca.crt'), key: path.join(TMP_ROOT, 'certs', 'backend.key'), cert: path.join(TMP_ROOT, 'certs', 'backend.crt') }),
});
stub(path.resolve(__dirname, '..', '..', '..', 'setup', 'index.js'), class {
    async distribute() { /* the repo's other services are not touched by a test */ }
});

const configManager = require('../core/configManager');

/** POST /setup/install, as the wizard sends it. Console output is swallowed (the failures are expected). */
async function install(body: Record<string, unknown> = {}) {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/setup', require('../routes/setup'));
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const saved: any = {};
    const output: string[] = [];
    for (const m of methods) { saved[m] = (console as any)[m]; (console as any)[m] = (...a: any[]) => { output.push(a.map(String).join(' ')); }; }
    try {
        const res = await request(app)
            .post('/setup/install')
            .set('x-install-token', INSTALL_TOKEN)
            .send({
                siteName: 'Undo',
                adminUser: 'undo-admin',
                adminEmail: 'undo@example.test',
                adminPassword: 'Undo-Admin-Pass-1',
                dbDriver: 'sqlite-native',
                demoContent: false,
                siteUrl: 'http://localhost:3000',
                ...body,
            });
        return { res, output: output.join('\n') };
    } finally {
        for (const m of methods) (console as any)[m] = saved[m];
    }
}

const configText = () => (realFs.existsSync(SANDBOX_CONFIG) ? String(realFs.readFileSync(SANDBOX_CONFIG, 'utf8')) : null);
const installed = () => { configManager.invalidateConfigCache(); return configManager.isInstalled(); };

const savedEmbedded = process.env.WORDJS_EMBEDDED;

beforeEach(() => {
    try { fs.rmSync(SANDBOX_CONFIG, { force: true }); } catch { /* absent */ }
    admin = null;
    terms = new Set();
    nativeError = null;
    failAt = null;
    delete process.env.WORDJS_EMBEDDED;
    configManager.invalidateConfigCache();
});

after(() => {
    if (savedEmbedded === undefined) delete process.env.WORDJS_EMBEDDED; else process.env.WORDJS_EMBEDDED = savedEmbedded;
    fs.existsSync = realFs.existsSync;
    fs.readFileSync = realFs.readFileSync;
    fs.writeFileSync = realFs.writeFileSync;
    process.chdir(ORIGINAL_CWD);
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('the native SQLite driver is checked before anything is written', () => {
    it('without its binary, the install writes nothing and says how to fix it', async () => {
        nativeError = new Error(`Could not locate the bindings file. Tried:\n → ${path.join(TMP_ROOT, 'node_modules', 'better-sqlite3', 'build', 'better_sqlite3.node')}`);
        const { res, output } = await install();
        assert.strictEqual(res.status, 500);
        assert.match(res.body.error, /npm rebuild better-sqlite3/);
        assert.match(res.body.error, /--ignore-scripts/);
        assert.match(res.body.error, /Nothing was saved/);
        assert.ok(!res.body.error.includes(TMP_ROOT), 'the paths the loader searched stay in the server log');
        assert.match(output, /Could not locate the bindings file/, 'the loader\'s own message is logged for the operator');
        assert.strictEqual(configText(), null, 'no config was written');
        assert.strictEqual(installed(), false);
        assert.strictEqual(admin, null);
    });

    it('the pure-JS driver does not need the binary', async () => {
        nativeError = new Error('Could not locate the bindings file.');
        const { res } = await install({ dbDriver: 'sqlite-legacy' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(installed(), true);
    });

    it('/setup/test-db reports it too, for a wizard that checks the database first', async () => {
        nativeError = new Error('Could not locate the bindings file.');
        const app = express();
        app.use(express.json());
        app.use('/setup', require('../routes/setup'));
        const saved = console.error;
        console.error = () => {};
        try {
            const res = await request(app).post('/setup/test-db').set('x-install-token', INSTALL_TOKEN).send({ dbDriver: 'sqlite-native' });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.ok, false);
            assert.match(res.body.error, /npm rebuild better-sqlite3/);
        } finally {
            console.error = saved;
        }
    });
});

describe('a failure before the administrator exists is undone', () => {
    it('on a fresh box: no config is left behind, and the wizard runs again', async () => {
        failAt = 'roles';
        const first = await install();
        assert.strictEqual(first.res.status, 500);
        assert.match(first.res.body.error, /Nothing was kept: fix the cause and run the wizard again\./);
        assert.strictEqual(configText(), null, 'the config the attempt wrote is gone');
        assert.strictEqual(installed(), false);

        failAt = null;
        const retry = await install();
        assert.notStrictEqual(retry.res.body.error, 'Already installed');
        assert.strictEqual(retry.res.status, 200, JSON.stringify(retry.res.body));
        assert.strictEqual(installed(), true);
        assert.ok(admin, 'the administrator exists after the retry');
    });

    it('a retry repeats the steps the failed attempt had already done (the default category)', async () => {
        failAt = 'theme'; // after the default category, before the administrator
        const first = await install();
        assert.strictEqual(first.res.status, 500);
        assert.ok(terms.has('category:uncategorized'), 'the failed attempt got past the default category');
        assert.strictEqual(installed(), false);

        failAt = null;
        const retry = await install();
        assert.strictEqual(retry.res.status, 200, JSON.stringify(retry.res.body));
        assert.strictEqual(installed(), true);
    });

    it('creating the administrator itself is the last step that is undone', async () => {
        failAt = 'admin';
        const { res } = await install();
        assert.strictEqual(res.status, 500);
        assert.match(res.body.error, /Nothing was kept/);
        assert.strictEqual(admin, null);
        assert.strictEqual(installed(), false);
    });

    it('on a box that already had a config (cluster enrollment): its bytes are put back exactly', async () => {
        // What scripts/node-join.js leaves on a node that still needs the wizard: no install marker.
        const before = JSON.stringify({ gatewayHost: '10.0.0.5', gatewayInternalPort: 3100, gatewaySecret: 'deadbeef', jwtSecret: 'j'.repeat(128) }, null, 2);
        realFs.writeFileSync(SANDBOX_CONFIG, before);
        configManager.invalidateConfigCache();
        assert.strictEqual(installed(), false);

        failAt = 'roles';
        const { res } = await install();
        assert.strictEqual(res.status, 500);
        assert.strictEqual(configText(), before);
        assert.strictEqual(installed(), false);
    });
});

describe('a failure after the administrator exists is not undone', () => {
    it('the site is installed and its config kept', async () => {
        failAt = 'core-tests';
        const { res } = await install();
        assert.strictEqual(res.status, 500);
        assert.doesNotMatch(res.body.error, /Nothing was kept/);
        assert.ok(admin, 'the administrator was created');
        assert.strictEqual(installed(), true, 'a site its administrator can sign in to is not thrown away');
    });
});
