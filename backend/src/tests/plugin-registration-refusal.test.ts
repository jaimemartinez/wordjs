/**
 * A REGISTRATION REFUSED FOR A MISSING GRANT DOES NOT TAKE THE PLUGIN DOWN (FALLOS 148, core side).
 *
 * Every marketplace plugin adds its admin sidebar entry from init without awaiting it, and several enqueue
 * public scripts/styles the same way. Both are gated host-side (admin_menu:register, assets:write), and an
 * administrator may leave those grants off — on the permission screen, or unticked in the consent dialog
 * of a Marketplace update. The refusal reached the plugin as an unhandled rejection, which the sandbox
 * treats as fatal: the plugin crash-looped through its restarts and its routes went down with it.
 *
 * Real forked children (plugin-worker.js), not a stub:
 *   DENIED  — declares admin_menu:register and assets:write, granted neither. Its init calls adminMenu.add,
 *             assets.enqueueScript and assets.enqueueStyle without awaiting, and once each awaited (to see
 *             what the call resolves to). It must stay up and keep answering its route, and nothing of what
 *             was refused may be registered on the host — the host still refuses exactly as before.
 *   GRANTED — the same plugin with both grants: the menu entry and the assets ARE registered (control).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app'); // preload trusted host context (io-guard no-ops for core)
const TMP_DB = path.join(os.tmpdir(), `wjs-reg-refusal-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const express = require('express');
const request = require('supertest');
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');
const { setApp } = require('../core/appRegistry');
const perms = require('../core/plugin-permissions');

const PLUGINS_ROOT = path.resolve(__dirname, '../../plugins');
const DENIED = `wjs-regref-denied-${process.pid}`;
const GRANTED = `wjs-regref-granted-${process.pid}`;

const app = express();
app.use(express.json());

const INIT = `
  const results = {};
  // Fire-and-forget, the way the marketplace plugins call them.
  wordjs.adminMenu.add({ href: '/admin/plugin/' + wordjs.slug, label: 'X', icon: 'fa-x', order: 90, cap: 'manage_options' });
  wordjs.assets.enqueueScript({ handle: 'regref-js', src: 'public/pub.js' });
  wordjs.assets.enqueueStyle({ handle: 'regref-css', src: 'public/pub.css' });
  // Awaited: what a refused registration resolves to.
  results.menu = await wordjs.adminMenu.add({ href: '/admin/plugin/' + wordjs.slug, label: 'Y', icon: 'fa-y', order: 91, cap: 'manage_options' });
  results.script = await wordjs.assets.enqueueScript({ handle: 'regref-js2', src: 'public/pub.js' });
  wordjs.http.route('get', '/status', async (req, res) => res.json({ alive: true, pid: process.pid, results }));
`;

function writeFixture(slug: string): string {
    const dir = path.join(PLUGINS_ROOT, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        name: slug, isolated: true, version: '1.0.0',
        permissions: [
            { scope: 'express', access: 'register_route' },
            { scope: 'admin_menu', access: 'register' },
            { scope: 'assets', access: 'write' },
        ],
    }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'exports.init = async function (wordjs) {\n' + INIT + '\n};\n');
    fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'public', 'pub.js'), '/* public */\n');
    fs.writeFileSync(path.join(dir, 'public', 'pub.css'), '/* public */\n');
    return dir;
}

const loadWithTimeout = (slug: string, ms = 45000) => {
    let timer: any;
    return Promise.race([
        loadIsolatedPlugin(slug, path.join(PLUGINS_ROOT, slug, 'index.js')),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`isolated plugin load timed out: ${slug}`)), ms); }),
    ]).finally(() => clearTimeout(timer));
};

const status = async (slug: string) => request(app).get(`/api/v1/plugin/${slug}/status`).timeout(60000);
const menusOf = (slug: string) => require('../core/adminMenu').getAdminMenuItems().filter((m: any) => m.plugin === slug);
/** What the host stored for the plugin (option plugin_assets): the fixtures are not in active_plugins. */
const assetsOf = async (slug: string) => {
    const store = (await require('../core/options').getOption('plugin_assets', {})) || {};
    return Array.isArray(store[slug]) ? store[slug] : [];
};

const dirs: string[] = [];
before(async () => {
    setApp(app);
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    for (const slug of [DENIED, GRANTED]) dirs.push(writeFixture(slug));
    perms._setGrantsInMemory(DENIED, ['express:register_route']);
    perms._setGrantsInMemory(GRANTED, ['express:register_route', 'admin_menu:register', 'assets:write']);
    await loadWithTimeout(DENIED);
    await loadWithTimeout(GRANTED);
}, { timeout: 120000 });

after(async () => {
    for (const slug of [DENIED, GRANTED]) {
        try { unloadIsolatedPlugin(slug); } catch { /* */ }
        try { perms._setGrantsInMemory(slug, []); } catch { /* */ }
    }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
}, { timeout: 30000 });

describe('a registration refused for a missing grant (real fork)', () => {
    test('adminMenu.add without admin_menu:register: the plugin stays up, its routes answer, no menu entry', async () => {
        const first = await status(DENIED);
        assert.strictEqual(first.status, 200, JSON.stringify(first.body));
        assert.strictEqual(first.body.alive, true);
        assert.strictEqual(first.body.results.menu, null, 'a refused registration resolves to null');
        // Give a fatal rejection time to land: the same child must still be answering.
        await new Promise((r) => setTimeout(r, 1500));
        const again = await status(DENIED);
        assert.strictEqual(again.status, 200, 'the plugin went down after its init');
        assert.strictEqual(again.body.pid, first.body.pid, 'the child was restarted (it crashed)');
        assert.deepStrictEqual(menusOf(DENIED), [], 'the host still refuses: nothing was added');
    }, { timeout: 120000 });

    test('assets.enqueueScript / enqueueStyle without assets:write: the same — refused on the host, not fatal here', async () => {
        const r = await status(DENIED);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.results.script, null);
        assert.deepStrictEqual(await assetsOf(DENIED), [], 'no script or style was enqueued');
    }, { timeout: 120000 });

    test('control: with the grants, the menu entry and the assets are registered as before', async () => {
        const r = await status(GRANTED);
        assert.strictEqual(r.status, 200);
        assert.notStrictEqual(r.body.results.script, null, 'a granted enqueue still answers');
        assert.strictEqual(menusOf(GRANTED).length, 1, 'the entry (the same href twice is kept once)');
        assert.ok((await assetsOf(GRANTED)).length >= 2, JSON.stringify(await assetsOf(GRANTED)));
    }, { timeout: 120000 });
});
