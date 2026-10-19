/**
 * WordJS — A FRESH INSTALL STARTS CRON AND THE WEBHOOK DISPATCHER IN THE SAME PROCESS.
 *
 * Found in a lab install of a monolith: the wizard finishes, an outgoing webhook is created, its "Send
 * test" ping delivers — and no post, comment, term or settings event is ever enqueued (0 rows in
 * webhook_deliveries) until the service is restarted. Scheduled posts never published either.
 *
 * THE MECHANISM. initialize() starts cron, the coherence and cluster buses, the webhook dispatcher and
 * the content outbox only inside its INSTALLED branch. A process that booted in setup mode never runs
 * that branch, and POST /setup/install did not start them either, so they stayed off for the life of the
 * process. Both paths now go through core/runtime-services.
 *
 * HOW THIS DRIVES IT. The REAL app (../index), booted through the REAL initialize() in setup mode, takes
 * the REAL POST /api/v1/setup/install against a SQLite database in a temp directory; then a webhook is
 * subscribed and a post is published through the model, the same path the REST route takes. The
 * sandboxing is the one install-releases-plugin-routes.test.ts documents.
 *
 * MUTATION PROOF: delete the `startRuntimeServices()` call from the install handler in routes/setup.ts
 * and both "cron is armed" and "publishing a post enqueues a webhook delivery" fail.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { captureLogLines } = require('./fixtures/log-capture');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the cwd FIRST: configManager, the database driver and core/themes resolve against it.
const ORIGINAL_CWD = process.cwd();
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-install-runtime-services-'));
process.chdir(TMP_ROOT);

// 2. config/app.ts reads backend/wordjs-config.json instead. Point that one path at the sandbox.
const SANDBOX_CONFIG = path.join(TMP_ROOT, 'wordjs-config.json');
const ANCHORED_CONFIG = path.resolve(__dirname, '..', '..', 'wordjs-config.json');
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
const redirect = (p: any) =>
    (typeof p === 'string' && norm(path.resolve(p)) === norm(ANCHORED_CONFIG) ? SANDBOX_CONFIG : p);
const realFs = { existsSync: fs.existsSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync };
fs.existsSync = (p: any, ...rest: any[]) => realFs.existsSync(redirect(p), ...rest);
fs.readFileSync = (p: any, ...rest: any[]) => realFs.readFileSync(redirect(p), ...rest);
fs.writeFileSync = (p: any, ...rest: any[]) => realFs.writeFileSync(redirect(p), ...rest);

// Monolith: no listener of its own, no cluster distribution. Anchored paths go to the sandbox.
const SAVED_ENV = { WORDJS_EMBEDDED: process.env.WORDJS_EMBEDDED, WORDJS_BACKEND_ROOT: process.env.WORDJS_BACKEND_ROOT };
process.env.WORDJS_EMBEDDED = '1';
process.env.WORDJS_BACKEND_ROOT = TMP_ROOT;

// 3. What the installer touches outside the sandbox, patched BEFORE ../index loads.
const INSTALL_TOKEN = 'install-starts-runtime-services-token';
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
const cron = require('../core/cron');
const webhooks = require('../core/webhooks');
const contentOutbox = require('../core/content-outbox');
const runtimeServices = require('../core/runtime-services');
const app = require('../index');

const API = '/api/v1';
const SITE_URL = 'http://localhost:3712';
const ADMIN = 'services-admin';

/** Silence the boot and install banners; a failing assertion prints what was said. */
async function quietly<T>(fn: () => Promise<T> | T): Promise<{ value: T; output: string }> {
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const saved: any = {};
    const lines: string[] = [];
    for (const m of methods) {
        saved[m] = (console as any)[m];
        (console as any)[m] = (...args: any[]) => { lines.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')); };
    }
    const logged = captureLogLines(undefined, { raw: true });
    let value: T;
    try {
        value = await fn();
    } finally {
        for (const m of methods) (console as any)[m] = saved[m];
        lines.push(...logged.stop());
    }
    return { value, output: lines.join('\n') };
}

/** Rows the dispatcher queued for `event`. */
async function deliveries(event: string): Promise<any[]> {
    const { dbAsync } = require('../config/database');
    return dbAsync.all('SELECT id, webhook_id, event FROM webhook_deliveries WHERE event = ?', [event]);
}

after(async () => {
    // Nothing else stops them in a test process: the timers are unref'd, but the database closes below.
    try { cron.stopCron(); } catch { /* never started */ }
    try { webhooks.stopPoller(); webhooks.unregisterListeners(); } catch { /* never started */ }
    try { contentOutbox.stopPoller(); } catch { /* never started */ }
    try { require('../core/coherence').stopCoherence(); } catch { /* never started */ }
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

describe('a process that booted uninstalled runs cron and webhooks once the wizard finishes', () => {
    let boot: { output: string };

    before(async () => {
        assert.strictEqual(configManager.CONFIG_FILE, SANDBOX_CONFIG, 'configManager must read the sandboxed config');
        boot = await quietly(() => app.initialize());
    });

    it('boots in setup mode, with no runtime service started', () => {
        assert.strictEqual(configManager.isInstalled(), false);
        assert.match(boot.output, /NOT installed\. Starting in SETUP MODE/);
        assert.strictEqual(runtimeServices.areRuntimeServicesStarted(), false, 'a setup-mode boot has no database to run them against');
        assert.strictEqual(cron.isCronRunning(), false);
    });

    it('the install succeeds in this process', async () => {
        const { value: res, output } = await quietly(() => request(app)
            .post(`${API}/setup/install`)
            .set('Origin', SITE_URL)
            .set('x-install-token', INSTALL_TOKEN)
            .send({
                siteName: 'Runtime services after install',
                adminUser: ADMIN,
                adminEmail: 'services-admin@example.test',
                adminPassword: 'Services-Admin-Password-1',
                dbDriver: 'sqlite-native',
                demoContent: false,
                siteUrl: SITE_URL,
            }));
        assert.strictEqual(res.status, 200, `${JSON.stringify(res.body)}\n${output}`);
        assert.strictEqual(configManager.isInstalled(), true);
    });

    it('cron is armed: the loop runs and the default events are scheduled', async () => {
        assert.strictEqual(runtimeServices.areRuntimeServicesStarted(), true);
        assert.strictEqual(cron.isCronRunning(), true, 'cron did not start after an in-process install: scheduled posts never publish until a restart');
        const { HOOK: ANALYTICS_PRUNE_HOOK } = require('../core/analytics-retention');
        assert.ok(await cron.nextScheduled(ANALYTICS_PRUNE_HOOK), 'the daily analytics prune was not scheduled');
        assert.strictEqual(typeof (global as any).wordjs?.scheduleEvent, 'function', 'the cron API was not exposed to plugins');
    });

    it('publishing a post enqueues a webhook delivery', async () => {
        const User = require('../models/User');
        const Webhook = require('../models/Webhook');
        const Post = require('../models/Post');
        const admin = await User.findByLogin(ADMIN);
        assert.ok(admin, 'the installer created no administrator');
        // An unresolvable host: the row is what matters here, not the HTTP attempt the poller may make.
        await Webhook.create({ userId: admin.id, name: 'probe', url: 'https://hooks.example.invalid/wordjs', events: ['post.published'] });

        const { output } = await quietly(() => Post.create({ authorId: admin.id, title: 'Hello from a fresh install', type: 'post', status: 'publish' }));

        // The listener runs after COMMIT, from the content-outbox dispatch: give it a moment.
        let rows: any[] = [];
        for (let i = 0; i < 50 && !rows.length; i++) {
            rows = await deliveries('post.published');
            if (!rows.length) await new Promise((r) => setTimeout(r, 100));
        }
        assert.strictEqual(rows.length, 1,
            `no post.published delivery was enqueued after an in-process install (the dispatcher is not subscribed until a restart)\n${output}`);
    });
});
