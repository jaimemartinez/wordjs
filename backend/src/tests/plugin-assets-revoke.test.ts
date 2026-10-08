/**
 * REVOKING assets:write TAKES A PLUGIN'S <script> OFF THE PUBLIC SITE — at the next read, and in the
 * frontend's cache.
 *
 * The enqueue registry (`plugin_assets`) is written while the plugin holds assets:write and was emitted by
 * GET /api/v1/plugins/assets for as long as the plugin stayed active: the permissions screen answered
 * "changes are in effect" and every public page kept loading the script, on the admin app's origin, for
 * every visitor including logged-in administrators. getActiveAssets now re-checks the grant on the way
 * out (the first suite drives the REAL producer — the plugin's own `assets.enqueueScript` bridge — and the
 * REAL revoke route).
 *
 * The second suite closes the cache half. The public layout fetches that list with a 120-second
 * revalidate and the `plugin-assets` tag (frontend/src/lib/server-api.ts getPublicAssets), and nothing
 * ever purged the tag when what it lists changed, so already-rendered pages kept the script for up to two
 * minutes after the revoke. Every option the list is computed from — the registry, the grant store and
 * the active list — now purges the tag when it changes, whoever writes it. GET /plugins/assets used to
 * answer `Cache-Control: public, max-age=60`, so a shared cache placed between the frontend and the API
 * could hold a revoked plugin's entry for that minute, out of reach of any purge; it now answers
 * `private, no-cache` (the frontend's Data Cache never read that header — it is tag-purged), and the last
 * test here pins it.
 *
 * MUTATION PROOF: remove the isGranted check in getActiveAssets and the revoke suite still lists the
 * script; remove the plugin-asset branch of the updated_option hook in core/frontend-purge and the
 * purge suite times out; put `public, max-age=60` back on the route and the cache-header test fails.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

const SLUG = 'wjs-assets-revoke';

// A stub frontend that resolves on the NEXT purge it receives (same shape as menu-purge.test.ts).
function stubFrontend() {
    const waiters: any[] = [];
    const server = http.createServer((req: any, res: any) => {
        let body = '';
        req.on('data', (c: any) => (body += c));
        req.on('end', () => {
            waiters.splice(0).forEach((w: any) => w({ url: req.url, body }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"revalidated":true}');
        });
    });
    const next = (ms = 8000) => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no purge arrived within ${ms}ms`)), ms);
        waiters.push((hit: any) => { clearTimeout(timer); resolve(hit); });
    });
    return { server, next };
}
const listen = (server: any) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server: any) => new Promise<void>((r) => (server ? server.close(() => r()) : r()));
const tagsOf = (hit: any): string[] => JSON.parse(hit.body).tags || [];

describe('revoking assets:write', () => {
    let dir = '', cwd = '';
    let front: any, database: any, request: any, app: any;
    let perms: any, updateOption: any, getOption: any;
    let adminToken = '';
    const madeDirs: string[] = [];

    before(async () => {
        cwd = process.cwd();
        front = stubFrontend();
        const frontPort = await listen(front.server);
        // configManager (via frontend-purge) and PLUGINS_DIR both resolve against the cwd at load: chdir FIRST.
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-assets-revoke-'));
        fs.writeFileSync(path.join(dir, 'wordjs-config.json'), JSON.stringify({
            installedAt: new Date().toISOString(),
            dbDriver: 'sqlite-native',
            siteUrl: 'http://localhost:3000',
            frontendUrl: `http://127.0.0.1:${frontPort}`,
            revalidateSecret: 'lab-secret',
        }));
        process.chdir(dir);
        process.env.WORDJS_BACKEND_ROOT = dir;

        const config = require('../config/app');
        config.dbPath = path.join(dir, 'assets-revoke.db');
        config.dbDriver = 'sqlite-native';
        database = require('../config/database');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        const dbAsync = database.getDbAsync();
        const r = await dbAsync.run("INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('admin', 'x', 'a@example.com', 'admin')");
        await dbAsync.run("INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')", [r.lastID]);
        await require('../core/roles').loadRoles();
        adminToken = jwt.sign({ userId: r.lastID, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        // The plugin: declares assets:write and ships public/t.js. core/plugins resolves the plugins
        // directory against the cwd and core/plugin-context against its own location; in production both
        // are backend/plugins (the process runs from backend/). Here the cwd is the sandbox, so the plugin
        // is written to both.
        for (const root of [path.join(dir, 'plugins'), path.resolve(__dirname, '..', '..', 'plugins')]) {
            const pdir = path.join(root, SLUG);
            fs.mkdirSync(path.join(pdir, 'public'), { recursive: true });
            madeDirs.push(pdir);
            fs.writeFileSync(path.join(pdir, 'manifest.json'), JSON.stringify({
                name: SLUG, version: '1.0.0', isolated: true, permissions: [{ scope: 'assets', access: 'write' }],
            }));
            fs.writeFileSync(path.join(pdir, 'index.js'), "'use strict';\nmodule.exports = { init() {} };\n");
            fs.writeFileSync(path.join(pdir, 'public', 't.js'), 'window.tracked = 1;\n');
        }

        perms = require('../core/plugin-permissions');
        ({ updateOption, getOption } = require('../core/options'));
        await perms.loadGrants();

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        request = require('supertest');
        app = express();
        app.use(express.json());
        app.use('/api/v1/plugins', require('../routes/plugins'));
        app.use(errorHandler);
    });

    after(async () => {
        process.chdir(cwd);
        try { await database.closeDatabase(); } catch { /* */ }
        await close(front.server);
        for (const d of madeDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    });

    const listed = async (): Promise<string[]> => {
        const res = await request(app).get('/api/v1/plugins/assets');
        assert.strictEqual(res.status, 200);
        return res.body.scripts.map((s: any) => s.src);
    };
    const SRC = `/plugins/${SLUG}/public/t.js`;

    describe('the list follows the grant', () => {
        it('enqueued while granted, emitted; revoked on the permissions screen, gone at the next read', async () => {
            await updateOption('active_plugins', [SLUG]);
            await perms.setGrants(SLUG, ['assets:write'], { adminDecision: true });
            const { createPluginApi } = require('../core/plugin-api');
            const { runWithContext } = require('../core/plugin-context');
            await runWithContext(SLUG, () => createPluginApi(SLUG).assets.enqueueScript({ handle: 't', src: 'public/t.js' }));
            assert.deepStrictEqual(await listed(), [SRC], 'precondition: the producer enqueued it');

            const res = await request(app).post(`/api/v1/plugins/${SLUG}/permissions`)
                .set('Authorization', `Bearer ${adminToken}`).send({ granted: [] });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.deepStrictEqual(await listed(), [], 'the revoke took the script off the public list');
            // The row is still there (it is the plugin's registration); what is emitted is what the grant allows.
            const stored = (await getOption('plugin_assets', {})) || {};
            assert.ok(Array.isArray(stored[SLUG]) && stored[SLUG].length === 1);
        });

        it('no shared cache may keep the list: it is answered private and must be revalidated', async () => {
            const res = await request(app).get('/api/v1/plugins/assets');
            assert.strictEqual(res.status, 200);
            const cc = String(res.headers['cache-control'] || '');
            assert.match(cc, /\bprivate\b/, cc);
            assert.match(cc, /\bno-cache\b/, cc);
            assert.doesNotMatch(cc, /\bpublic\b|s-maxage|max-age=[1-9]/, `a shared cache may hold it: ${cc}`);
        });

        it('deactivating and reactivating without the grant does not bring it back; granting again does', async () => {
            await updateOption('active_plugins', []);
            await updateOption('active_plugins', [SLUG]);
            assert.deepStrictEqual(await listed(), []);
            await perms.setGrants(SLUG, ['assets:write'], { adminDecision: true });
            assert.deepStrictEqual(await listed(), [SRC]);
            await perms.setGrants(SLUG, [], { adminDecision: true });
        });
    });

    describe('the frontend cache follows the list', () => {
        before(() => { require('../core/frontend-purge').initFrontendPurge(); });

        for (const [option, value] of [
            ['plugin_grants', () => ({ [SLUG]: [] })],
            ['active_plugins', () => []],
            ['plugin_assets', () => ({})],
        ] as const) {
            it(`a change to ${option} purges the plugin-assets tag`, async () => {
                const arrival = front.next();
                await updateOption(option, (value as any)());
                const hit = await arrival;
                assert.strictEqual(hit.url, '/api/revalidate');
                assert.ok(tagsOf(hit).includes('plugin-assets'), `expected the plugin-assets tag, got: ${hit.body}`);
            });
        }

        it('the revoke route itself reaches the frontend (through the grant store write)', async () => {
            await updateOption('active_plugins', [SLUG]);
            await perms.setGrants(SLUG, ['assets:write'], { adminDecision: true });
            await new Promise((r) => setTimeout(r, 1500)); // let the debounced flush of the setup writes go out
            const arrival = front.next();
            const res = await request(app).post(`/api/v1/plugins/${SLUG}/permissions`)
                .set('Authorization', `Bearer ${adminToken}`).send({ granted: [] });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.ok(tagsOf(await arrival).includes('plugin-assets'));
        });
    });
});
