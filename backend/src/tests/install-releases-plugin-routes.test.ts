/**
 * WordJS — A FRESH INSTALL OPENS THE PLUGIN ROUTES IN THE SAME PROCESS.
 *
 * Found live while testing plugin roles: boot a site UNINSTALLED (setup mode), finish the wizard, activate
 * a plugin — activation answers 200 and the isolate starts — and every /api/v1/plugin/<slug>/* request
 * still answers 503 `plugins_starting` ("Plugins are still starting. Retry in a moment."), forever, until
 * the process restarts. The plugin's admin page could not even load the user's permissions.
 *
 * THE MECHANISM. index.ts shuts /api/v1/plugin/* behind a 503 while the boot forks the active isolates,
 * and opened it only inside initialize()'s INSTALLED branch, after loadActivePlugins(). A process that
 * booted in setup mode never runs that branch, and POST /setup/install never opened the guard either, so
 * it stayed shut for the life of the process. The install now releases it (core/plugins-ready).
 *
 * HOW THIS DRIVES IT. The REAL app (../index), booted through the REAL initialize() in setup mode, takes
 * the REAL POST /api/v1/setup/install against a SQLite database in a temp directory. The plugin route is
 * then registered at the seam an isolated plugin's routes land on — `getApp()[method]('/api/v1/plugin/
 * <slug>…')` followed by fixMiddlewareOrder(), which is what plugin-isolate.ts does for each route a child
 * declares — without forking a sandboxed child: the defect is in the host's middleware stack, not in the
 * isolate, and the stack in front of that route (host gate, install funnel, CSRF, the plugin guard, the
 * MFA gate, the 404 handler) is the real one.
 *
 * WHAT IS SANDBOXED. The cwd is a temp directory before any application module loads: configManager's
 * wordjs-config.json, the database file and the themes directory all resolve against it. config/app.ts
 * anchors its own read of the config to backend/wordjs-config.json, so that one path is redirected to
 * the same temp file (as in install-jwt-secret-continuity.test.ts). Stubbed, because they write outside
 * the temp directory or reach the network and bear on nothing here: the mTLS certificate minting
 * (backend/certs), the install-token file (backend/data/install-token) and the frontend cache purge.
 *
 * MUTATION PROOF: delete `require('../core/plugins-ready').markPluginsReady();` from the install handler
 * in routes/setup.ts and "a plugin route registered after the install is reachable" fails with
 * 503 plugins_starting.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the cwd FIRST: configManager, the database driver and core/themes resolve against it.
const ORIGINAL_CWD = process.cwd();
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-install-plugin-routes-'));
process.chdir(TMP_ROOT);

// 2. config/app.ts reads backend/wordjs-config.json instead. Point that one path at the sandbox, so both
//    modules read ONE file, as they do in production, and a developer's real config is never touched.
const SANDBOX_CONFIG = path.join(TMP_ROOT, 'wordjs-config.json');
const ANCHORED_CONFIG = path.resolve(__dirname, '..', '..', 'wordjs-config.json');
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
const redirect = (p: any) =>
    (typeof p === 'string' && norm(path.resolve(p)) === norm(ANCHORED_CONFIG) ? SANDBOX_CONFIG : p);
const realFs = { existsSync: fs.existsSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync };
fs.existsSync = (p: any, ...rest: any[]) => realFs.existsSync(redirect(p), ...rest);
fs.readFileSync = (p: any, ...rest: any[]) => realFs.readFileSync(redirect(p), ...rest);
fs.writeFileSync = (p: any, ...rest: any[]) => realFs.writeFileSync(redirect(p), ...rest);

// Monolith: initialize() does not open a listener of its own, and the installer skips the cluster
// distribution (which writes the repo's gateway/frontend directories). Anchored paths go to the sandbox.
const SAVED_ENV = { WORDJS_EMBEDDED: process.env.WORDJS_EMBEDDED, WORDJS_BACKEND_ROOT: process.env.WORDJS_BACKEND_ROOT };
process.env.WORDJS_EMBEDDED = '1';
process.env.WORDJS_BACKEND_ROOT = TMP_ROOT;

// 3. What the installer touches outside the sandbox. Patched on the real modules BEFORE ../index loads,
//    so the routers that destructure these exports at load bind the patched functions.
const INSTALL_TOKEN = 'install-releases-plugin-routes-token';
const installToken = require('../core/install-token');
Object.assign(installToken, {
    generateInstallToken: () => INSTALL_TOKEN,
    getInstallToken: () => INSTALL_TOKEN,
    verifyInstallToken: (t: unknown) => t === INSTALL_TOKEN,
    clearInstallTokenFile: () => {},
});
const certManagerFile = require.resolve('../core/certManager');
require.cache[certManagerFile] = {
    id: certManagerFile, filename: certManagerFile, loaded: true,
    exports: { generateClusterCA: () => ({ key: 'stub-ca-key', cert: 'stub-ca-cert' }), generateServiceCert: () => {} },
} as any;
Object.assign(require('../core/frontend-purge'), { initFrontendPurge: () => {}, purgeFrontend: () => {} });

const request = require('supertest');
const configManager = require('../core/configManager');
const database = require('../config/database');
const pluginsReady = require('../core/plugins-ready');
const app = require('../index');

const API = '/api/v1';
const SITE_URL = 'http://localhost:3710';
const SLUG = 'install-route-probe';

/** Silence the boot and install banners; a failing assertion prints what was said. */
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

const install = (body: Record<string, unknown>) =>
    request(app)
        .post(`${API}/setup/install`)
        .set('Origin', SITE_URL)
        .set('x-install-token', INSTALL_TOKEN)
        .send({
            siteName: 'Plugin routes after install',
            adminUser: 'routes-admin',
            adminEmail: 'routes-admin@example.test',
            adminPassword: 'Routes-Admin-Password-1',
            dbDriver: 'sqlite-native',
            demoContent: false,
            siteUrl: SITE_URL,
            ...body,
        });

after(async () => {
    try { require('../core/site-address').stopWatching(); } catch { /* never started */ }
    try { await database.closeDatabase(); } catch { /* never opened */ }
    fs.existsSync = realFs.existsSync;
    fs.readFileSync = realFs.readFileSync;
    fs.writeFileSync = realFs.writeFileSync;
    for (const [key, value] of Object.entries(SAVED_ENV)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    process.chdir(ORIGINAL_CWD);
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort on Windows */ }
});

describe('a process that booted uninstalled serves plugin routes once the wizard finishes', () => {
    let boot: { output: string };

    before(async () => {
        assert.strictEqual(configManager.CONFIG_FILE, SANDBOX_CONFIG, 'configManager must read the sandboxed config');
        boot = await quietly(() => app.initialize());
    });

    it('boots in setup mode, with the plugin routes shut', () => {
        assert.strictEqual(configManager.isInstalled(), false);
        assert.match(boot.output, /NOT installed\. Starting in SETUP MODE/);
        assert.strictEqual(pluginsReady.arePluginsReady(), false, 'a setup-mode boot loads no plugins and must not open the guard itself');
    });

    it('an install the handler refuses leaves the guard shut', async () => {
        const { value: res } = await quietly(() => install({ adminPassword: 'short' }));
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.strictEqual(configManager.isInstalled(), false);
        assert.strictEqual(pluginsReady.arePluginsReady(), false);
    });

    it('the install succeeds in this process', async () => {
        const { value: res, output } = await quietly(() => install({}));
        assert.strictEqual(res.status, 200, `${JSON.stringify(res.body)}\n${output}`);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(configManager.isInstalled(), true);
    });

    it('a plugin route registered after the install is reachable (not 503 plugins_starting)', async () => {
        // Where an isolated plugin's route lands (plugin-isolate.ts, 'register-route'), then the reorder
        // every activation runs so the route sits ahead of the 404 handler initialize() installed.
        require('../core/appRegistry').getApp().get(`${API}/plugin/${SLUG}/ping`, (_req: any, res: any) => res.json({ pong: SLUG }));
        require('../core/plugins').fixMiddlewareOrder();

        const res = await request(app).get(`${API}/plugin/${SLUG}/ping`);
        assert.notStrictEqual(res.body && res.body.code, 'plugins_starting',
            'the guard is still shut after a successful in-process install: every plugin route answers 503 until a restart');
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body, { pong: SLUG });
    });

    it('a plugin route nobody registered is a 404, not "still starting"', async () => {
        const res = await request(app).get(`${API}/plugin/not-installed-anywhere/ping`);
        assert.strictEqual(res.status, 404, JSON.stringify(res.body));
    });
});
