/**
 * MENU MUTATIONS PURGE THE FRONTEND CACHE (instant-purge contract, M7).
 *
 * The public nav renders from Next Data Cache entries tagged 'menus' + 'menu:<ref>' with a 60s
 * revalidate (frontend/src/lib/server-api.ts). frontend-purge's docstring lists 'menus' among the
 * tags it exists to make INSTANT — yet no menu mutation ever enqueued them: routes/menus.ts fired
 * no hooks and never called purgeFrontend, and 'nav_menu_locations' (written by Menu.setLocation)
 * was dropped by the updated_option filter. Result: the Verso editor showed the new nav immediately
 * (invalidateEditorMenus) while the public site served the stale one for up to a minute.
 *
 * This suite drives the REAL stack end to end, like frontend-purge-direct.test.ts: the actual
 * /menus routes over supertest, the real debounced flush, and a genuine HTTP request into a stub
 * frontend — asserting every mutation surface delivers a purge carrying the 'menus' tag, and that
 * the nav_menu_locations option path purges via the hook even when no route is involved.
 *
 * MUTATION PROOF: remove the purgeFrontend call from any exercised route (or the
 * nav_menu_locations branch of the updated_option hook) and the corresponding test times out.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

// A stub frontend that resolves as soon as it is purged (same shape as frontend-purge-direct).
function stubFrontend() {
    const received: any[] = [];
    const waiters: any[] = [];
    const server = http.createServer((req: any, res: any) => {
        let body = '';
        req.on('data', (c: any) => (body += c));
        req.on('end', () => {
            const hit = { url: req.url, secret: req.headers['x-revalidate-secret'], body };
            received.push(hit);
            waiters.splice(0).forEach((w: any) => w(hit));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"revalidated":true}');
        });
    });
    // Always waits for the NEXT arrival, so each test can attribute one flush to its own mutation.
    const next = (ms = 8000) => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no purge arrived within ${ms}ms`)), ms);
        waiters.push((hit: any) => { clearTimeout(timer); resolve(hit); });
    });
    return { server, received, next };
}
const listen = (server: any) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server: any) => new Promise<void>((r) => (server ? server.close(() => r()) : r()));

function tagsOf(hit: any): string[] {
    const parsed = JSON.parse(hit.body);
    assert.ok(Array.isArray(parsed.tags), `purge body has no tags array: ${hit.body}`);
    return parsed.tags;
}

describe('menu mutations purge the menus tag (instant-purge contract)', () => {
    let dir: string;
    let cwd: string;
    let front: any;
    let database: any;
    let request: any;
    let app: any;
    let adminId = 0;
    let menuId = 0;
    let itemId = 0;
    let SECRET = '';

    const asAdmin = (m: string, p: string) =>
        (request(app) as any)[m](`/api/v1${p}`).set(
            'Authorization',
            `Bearer ${jwt.sign({ userId: adminId, username: 'admin' }, SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`,
        );

    before(async () => {
        cwd = process.cwd();
        front = stubFrontend();
        const frontPort = await listen(front.server);

        // A single-host split config whose frontendUrl is the stub. configManager resolves
        // wordjs-config.json from the cwd AT LOAD TIME, and requiring the menus router loads
        // frontend-purge → configManager transitively — so chdir BEFORE any app require.
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-menu-purge-'));
        fs.writeFileSync(path.join(dir, 'wordjs-config.json'), JSON.stringify({
            installedAt: new Date().toISOString(),
            dbDriver: 'sqlite-native',
            siteUrl: 'http://localhost:3000',
            frontendUrl: `http://127.0.0.1:${frontPort}`,
            revalidateSecret: 'lab-secret',
        }));
        process.chdir(dir);

        const config = require('../config/app');
        config.dbPath = path.join(dir, 'menu-purge.db');
        config.dbDriver = 'sqlite-native';
        SECRET = config.jwt.secret;

        database = require('../config/database');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        const dbAsync = database.getDbAsync();
        const r = await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('admin', 'x', 'a@example.com', 'admin')`,
        );
        adminId = r.lastID;
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [adminId]);
        await require('../core/roles').loadRoles();

        // Only the router under test: the purge wiring lives inside routes/menus.ts itself.
        const express = require('express');
        request = require('supertest');
        app = express();
        app.use(express.json());
        app.use('/api/v1/menus', require('../routes/menus'));

        // Seed a menu + item; their purges flush once (debounced) — drain it so every test below
        // attributes exactly one arrival to its own mutation.
        const menu = await asAdmin('post', '/menus').send({ name: 'Principal', slug: `principal-${process.pid}` });
        assert.strictEqual(menu.status, 201, `menu create: ${menu.status} ${JSON.stringify(menu.body)}`);
        menuId = menu.body.id;
        const item = await asAdmin('post', `/menus/${menuId}/items`).send({ title: 'Inicio', url: '/' });
        assert.strictEqual(item.status, 201, `item create: ${item.status} ${JSON.stringify(item.body)}`);
        itemId = item.body.id;
        const seeded = await front.next();
        assert.ok(tagsOf(seeded).includes('menus'), 'creating a menu/item purges the menus tag');
    });

    after(async () => {
        process.chdir(cwd);
        try { await database.closeDatabase(); } catch { /* best effort */ }
        await close(front.server);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    test('editing a menu item purges the menus tag, authenticated with the shared secret', async () => {
        const res = await asAdmin('put', `/menus/items/${itemId}`).send({ title: 'Renombrado' });
        assert.strictEqual(res.status, 200, `item update: ${res.status} ${JSON.stringify(res.body)}`);
        const hit = await front.next();
        assert.strictEqual(hit.url, '/api/revalidate');
        assert.strictEqual(hit.secret, 'lab-secret');
        assert.ok(tagsOf(hit).includes('menus'), `expected the menus tag, got: ${hit.body}`);
    });

    test('assigning a menu to a location purges (the route path, hooks not wired)', async () => {
        const res = await asAdmin('post', `/menus/${menuId}/location`).send({ location: 'header' });
        assert.strictEqual(res.status, 200, `set location: ${res.status} ${JSON.stringify(res.body)}`);
        assert.ok(tagsOf(await front.next()).includes('menus'));
    });

    test('deleting a menu item purges', async () => {
        const res = await asAdmin('delete', `/menus/items/${itemId}`);
        assert.strictEqual(res.status, 200, `item delete: ${res.status} ${JSON.stringify(res.body)}`);
        assert.ok(tagsOf(await front.next()).includes('menus'));
    });

    test('the nav_menu_locations OPTION path purges via the updated_option hook (non-route writers)', async () => {
        // Menu.setLocation writes an option, and importers/plugins can too — with the hooks wired
        // (initialize() does this in production) the option write alone must purge the menu caches,
        // and with the 'menus' tag, not 'settings' (the option is not in the public settings payload).
        require('../core/frontend-purge').initFrontendPurge();
        await require('../core/options').updateOption('nav_menu_locations', { footer: menuId });
        const hit = await front.next();
        const tags = tagsOf(hit);
        assert.ok(tags.includes('menus'), `expected the menus tag, got: ${hit.body}`);
        assert.ok(!tags.includes('settings'), `nav_menu_locations must not masquerade as a settings change: ${hit.body}`);
    });
});
