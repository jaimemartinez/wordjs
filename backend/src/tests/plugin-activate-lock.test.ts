/**
 * WordJS — activate/deactivate are serialized against install/update/delete of the same plugin.
 *
 * Install, update and delete already took a per-slug operation lock (an in-process guard plus a
 * `wordjs:plugin-op:<slug>` distributed lease). Activation and deactivation — which move the same
 * plugin's code in and out of a live child process, and rewrite the same `active_plugins` option — did
 * not, so three of the four mutating operations were mutually exclusive and the other two were free to
 * interleave with all of them.
 *
 * WHAT THAT COSTS, concretely. `loadIsolatedPlugin` is an await: while an activation sits inside it, the
 * flag has not been written yet, so a DELETE that arrives passes its "is the plugin active?" check,
 * treats the freshly-registered child as an orphan, stops it and rmSync's the directory — and the
 * activation then carries on and completes its `active_plugins` write, leaving the flag naming a slug
 * with no code on disk. The mirror image is an update stashing the code aside from under an activation
 * that is about to spawn from it.
 *
 * The last test drives exactly that interleaving: it parks the activation inside loadIsolatedPlugin and
 * fires the DELETE while it is there.
 *
 * Driven through the REAL router over supertest (real JWT, real admin gate, real per-slug lock) and the
 * REAL core/plugins.activatePlugin, because the lock lives in the route and the whole question is which
 * HTTP answer the second caller gets. Only core/plugin-isolate is faked — no child is spawned here.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// regenerateRegistry() shells out to the frontend registry generators unless NODE_ENV is production,
// and one of them writes an absolute path from THIS temp root into a file the project forbids
// committing. Pin it (same reason as plugin-update.test.ts / plugin-delete-orphan.test.ts).
process.env.NODE_ENV = 'production';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-activate-lock-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const PLUGINS_DIR = path.join(TMP_ROOT, 'plugins');
const SLUG = 'lockable';
const ADMIN = 'lock-admin';
const PASSWORD = 'Str0ng-Pa55word!';

// --- the isolate REGISTRY, faked ---------------------------------------------------------------

const liveIsolates = new Set<string>();
/** When set, loadIsolatedPlugin parks here until the test resolves it — the await the race lives in. */
let loadGate: Promise<void> | null = null;
/** Resolves once a load has actually entered the gate, so the test never races the request. */
let loadEntered: (() => void) | null = null;

const fakeIsolate: any = {
    loadIsolatedPlugin: async (slug: string) => {
        if (loadGate) {
            const gate = loadGate;
            if (loadEntered) { const f = loadEntered; loadEntered = null; f(); }
            await gate;
        }
        liveIsolates.add(slug);
        return { ok: true };
    },
    unloadIsolatedPlugin: (slug: string) => { liveIsolates.delete(slug); },
    isIsolated: (slug: string) => liveIsolates.has(slug),
    reloadIsolatedPlugin: async () => null,
    getIsolateStatus: () => null,
    getAllIsolateStatuses: () => ({}),
};

const isolatePath = require.resolve('../core/plugin-isolate');
const stub = new Module(isolatePath, null);
stub.filename = isolatePath;
stub.loaded = true;
stub.exports = fakeIsolate;
require.cache[isolatePath] = stub;

// --- the app -----------------------------------------------------------------------------------

const jwt = require('jsonwebtoken');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/plugins', require('../routes/plugins'));

const { acquirePluginOpLock } = require('../routes/plugins');

function seedPluginDir(slug: string) {
    const dir = path.join(PLUGINS_DIR, slug);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        id: slug, name: 'Lockable', version: '1.0.0', isolated: true, bundled: true, permissions: [],
    }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'exports.init = () => 1;\n');
    return dir;
}

describe('POST /plugins/:slug/(de)activate — serialized with install/update/delete', () => {
    let token: string;
    let setActive: (l: string[]) => Promise<any>;
    let readActive: () => Promise<string[]>;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        const User = require('../models/User');
        const admin = await User.create({
            username: ADMIN, email: `${ADMIN}@example.com`, password: PASSWORD,
            displayName: 'Lock Admin', role: 'administrator',
        });
        token = jwt.sign({ userId: admin.id, username: ADMIN }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        const options = require('../core/options');
        setActive = (l: string[]) => options.updateOption('active_plugins', l);
        readActive = async () => (await options.getOption('active_plugins', [])) || [];
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* */ }
        process.chdir(os.tmpdir());
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    beforeEach(async () => {
        liveIsolates.clear();
        loadGate = null;
        loadEntered = null;
        seedPluginDir(SLUG);
        await setActive([]);
    });

    const activate = () => request(app).post(`/plugins/${SLUG}/activate`).set('Authorization', `Bearer ${token}`).send({});
    const deactivate = () => request(app).post(`/plugins/${SLUG}/deactivate`).set('Authorization', `Bearer ${token}`).send({});
    const del = () => request(app).delete(`/plugins/${SLUG}`).set('Authorization', `Bearer ${token}`).send({ password: PASSWORD });

    it('activates normally when nothing else holds the slug', async () => {
        const r = await activate();

        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.success, true);
        assert.strictEqual(fakeIsolate.isIsolated(SLUG), true, 'a child is registered');
        assert.deepStrictEqual(await readActive(), [SLUG]);
    });

    it('refuses to activate while another operation holds the slug, and changes nothing', async () => {
        const held = await acquirePluginOpLock(SLUG);   // stands in for an install/update/delete in flight
        assert.strictEqual(held.ok, true);
        try {
            const r = await activate();

            assert.strictEqual(r.status, 409, JSON.stringify(r.body));
            assert.strictEqual(r.body.busy, true);
            assert.match(r.body.message, /locked by another install\/update\/uninstall/);
            assert.strictEqual(fakeIsolate.isIsolated(SLUG), false, 'nothing was spawned…');
            assert.deepStrictEqual(await readActive(), [], '…and the flag was not written');
        } finally {
            await held.release();
        }

        // The refusal is not sticky: once the other operation finishes, the same request works.
        const after = await activate();
        assert.strictEqual(after.status, 200, JSON.stringify(after.body));
        assert.strictEqual(fakeIsolate.isIsolated(SLUG), true);
    });

    it('refuses to deactivate while another operation holds the slug, and leaves it running', async () => {
        await setActive([SLUG]);
        liveIsolates.add(SLUG);

        const held = await acquirePluginOpLock(SLUG);
        assert.strictEqual(held.ok, true);
        try {
            const r = await deactivate();

            assert.strictEqual(r.status, 409, JSON.stringify(r.body));
            assert.strictEqual(r.body.busy, true);
            assert.strictEqual(fakeIsolate.isIsolated(SLUG), true, 'the child was NOT stopped under the other operation');
            assert.deepStrictEqual(await readActive(), [SLUG], 'and the flag was not rewritten');
        } finally {
            await held.release();
        }

        const after = await deactivate();
        assert.strictEqual(after.status, 200, JSON.stringify(after.body));
        assert.strictEqual(fakeIsolate.isIsolated(SLUG), false);
        assert.deepStrictEqual(await readActive(), []);
    });

    it('THE RACE: a DELETE that lands mid-activation is refused, not interleaved', async () => {
        // Park the activation inside loadIsolatedPlugin — the await where the flag has not been written
        // yet and a child is about to be registered. Unserialized, the DELETE arriving here passes its
        // `isPluginActive` check (the flag is empty), stops the child as an "orphan" and removes the
        // directory, while the activation completes its `active_plugins` write regardless: the flag then
        // names a slug with no code on disk, and only a manual deactivate can clear it.
        let openGate: () => void = () => { };
        loadGate = new Promise<void>((resolve) => { openGate = resolve; });
        const entered = new Promise<void>((resolve) => { loadEntered = resolve; });

        // .then() is what actually SENDS a supertest request — building the Test object does not.
        const activation = activate().then((r: any) => r);
        await entered;                       // the activation is now inside loadIsolatedPlugin

        const deleted = await del();

        assert.strictEqual(deleted.status, 409, JSON.stringify(deleted.body));
        assert.strictEqual(deleted.body.busy, true, 'THE FIX: the DELETE is refused while the activation owns the slug');
        assert.ok(fs.existsSync(path.join(PLUGINS_DIR, SLUG, 'manifest.json')),
            'so the code is NOT pulled out from under an activation that is spawning from it');

        openGate();
        const r = await activation;
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(fakeIsolate.isIsolated(SLUG), true, 'and the activation completed as a whole');
        assert.deepStrictEqual(await readActive(), [SLUG], 'with the flag agreeing with what is on disk');
    });

    it('releases the slug even when the activation FAILS, so the admin can retry', async () => {
        // The lock is released in a `finally`. Without that, one failed activation would 409 every
        // install/update/delete/activate of that plugin until the 120s lease expired.
        fs.writeFileSync(path.join(PLUGINS_DIR, SLUG, 'manifest.json'), JSON.stringify({
            id: SLUG, name: 'Lockable', version: '1.0.0', permissions: [],   // isolated:true removed
        }));

        const r = await activate();
        assert.strictEqual(r.status, 500, JSON.stringify(r.body));

        const held = await acquirePluginOpLock(SLUG);
        assert.strictEqual(held.ok, true, 'the slug is free again');
        await held.release();
    });
});
