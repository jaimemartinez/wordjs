/**
 * WordJS — DELETE /plugins/:slug must not remove the directory of a plugin that is still RUNNING.
 *
 * The handler gated on `isPluginActive`, i.e. on the `active_plugins` OPTION. That option is a stored
 * intention; whether a child process is registered for the slug is a different fact, and the two
 * disagree exactly in the orphan state an activation that threw after registering its isolate leaves
 * behind (see core/plugins.activatePlugin's guard and plugin-activate-orphan.test.ts). In that state
 * the option check passes and the handler rmSync'd the directory of a live process — one still holding
 * this plugin's hooks, routes and any claimed provider (the system mail sender), now pointing at code
 * that no longer exists. The admin cannot pre-empt it either: `deactivatePlugin` early-returns
 * 'Plugin not active' for precisely this state, so "deactivate it first" is not an available step.
 *
 * AND THE ISOLATE REGISTRY IS NOT THE WHOLE ANSWER EITHER. Gating the teardown on "is a child
 * registered?" still misses the other thing the slug can own: a PENDING SUPERVISED RESTART. A crashed
 * child is removed from the registry before the backoff restart is scheduled, so for up to a minute the
 * registry says nothing is running while a live timer is waiting to spawn from the very directory this
 * handler is about to delete — and that timer is cancelled ONLY by unloadIsolatedPlugin. So the teardown
 * is unconditional, and the registry is consulted afterwards, to VERIFY.
 *
 * Driven through the REAL router over supertest (real JWT, real admin gate, real password check, real
 * per-slug operation lock) because the guard lives in the handler and its whole job is which HTTP
 * answer the admin gets. core/plugin-isolate is faked — no child is spawned here, and the point is the
 * registry's answer to "is something running?", not the spawn (plugin-isolate.test.ts covers that).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// regenerateRegistry() shells out to the three frontend registry generators unless NODE_ENV is
// production — and one of them writes an absolute path from THIS temp root into a file the project
// forbids committing. Pin it (same reason as plugin-update.test.ts).
process.env.NODE_ENV = 'production';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-plugin-delete-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const PLUGINS_DIR = path.join(TMP_ROOT, 'plugins');
const SLUG = 'deletable';
const ADMIN = 'delete-admin';
const PASSWORD = 'Str0ng-Pa55word!';

// --- the isolate REGISTRY, faked ---------------------------------------------------------------
//
// Modelled on core/plugin-isolate's ACTUAL bookkeeping, because the second half of this file turns on a
// distinction the real module makes and a naive fake would erase:
//   - `isolates` (here: liveIsolates) is what isIsolated() answers from;
//   - `restartTimers` (here: pendingRestarts) holds a scheduled backoff restart after a crash. The exit
//     handler DELETES the crashed child from `isolates` (plugin-isolate.ts:1413) and only then calls
//     superviseRestart, so throughout that window — up to 60s of backoff, 5 attempts — isIsolated() is
//     FALSE while the slug is still owned by a live timer;
//   - unloadIsolatedPlugin (plugin-isolate.ts:1442-1452) is the ONLY thing that cancels that timer, and
//     it does so BEFORE it touches the handle — hence unconditionally with respect to `unloadIsNoop`.

/** Slugs a child process is registered for (`isolates`). */
const liveIsolates = new Set<string>();
/** Slugs with a pending supervised restart (`restartTimers`) — deliberately NOT in liveIsolates. */
const pendingRestarts = new Set<string>();
/** When set, unloadIsolatedPlugin does NOT clear the slug — a child that refuses to die. */
let unloadIsNoop = false;
let unloadCalls: string[] = [];

const fakeIsolate: any = {
    loadIsolatedPlugin: async (slug: string) => { liveIsolates.add(slug); pendingRestarts.delete(slug); return { ok: true }; },
    unloadIsolatedPlugin: (slug: string) => {
        unloadCalls.push(slug);
        pendingRestarts.delete(slug);            // clearTimeout(restartTimers.get(slug)) — always runs
        if (!unloadIsNoop) liveIsolates.delete(slug);
    },
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

function seedPluginDir(slug: string) {
    const dir = path.join(PLUGINS_DIR, slug);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        id: slug, name: 'Deletable', version: '1.0.0', isolated: true, permissions: [],
    }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'exports.init = () => 1;\n');
    return dir;
}

describe('DELETE /plugins/:slug — never deletes the directory of a running plugin', () => {
    let token: string;
    let setActive: (l: string[]) => Promise<any>;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        const User = require('../models/User');
        const admin = await User.create({
            username: ADMIN, email: `${ADMIN}@example.com`, password: PASSWORD,
            displayName: 'Delete Admin', role: 'administrator',
        });
        token = jwt.sign({ userId: admin.id, username: ADMIN }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        setActive = (l: string[]) => require('../core/options').updateOption('active_plugins', l);
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* */ }
        process.chdir(os.tmpdir());
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    beforeEach(async () => {
        liveIsolates.clear();
        pendingRestarts.clear();
        unloadCalls = [];
        unloadIsNoop = false;
        await setActive([]);
    });

    const del = (slug: string, body: any = { password: PASSWORD }) =>
        request(app).delete(`/plugins/${slug}`).set('Authorization', `Bearer ${token}`).send(body);

    it('deletes a plugin that is neither flagged active nor running', async () => {
        const dir = seedPluginDir(SLUG);

        const r = await del(SLUG);

        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.success, true);
        assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')), 'the code is gone');
        assert.deepStrictEqual(unloadCalls, [SLUG],
            'the teardown runs even with nothing registered — it is idempotent, and it is also the only '
            + 'thing that cancels a pending supervised restart, which isIsolated() cannot see (next test)');
    });

    it('cancels a PENDING supervised restart, which no "is it running?" check can see', async () => {
        // The state: the child crashed, so plugin-isolate's exit handler removed it from `isolates` and
        // scheduled a backoff restart (up to 60s, 5 attempts). isPluginRunning() is FALSE for that whole
        // window, so a teardown gated on it never runs — and clearing `restartTimers` is something ONLY
        // unloadIsolatedPlugin does. Skip it and the timer fires on a deleted entry file, burns its five
        // attempts and posts a "keeps crashing and was stopped" notice for a plugin the admin deleted;
        // and if the slug is REINSTALLED inside the window, the timer registers an isolate outside
        // activatePlugin — manufacturing the very orphan the previous test cleans up.
        const dir = seedPluginDir(SLUG);
        pendingRestarts.add(SLUG);
        assert.strictEqual(fakeIsolate.isIsolated(SLUG), false, 'precondition: nothing is registered, so no running check fires');

        const r = await del(SLUG);

        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(unloadCalls, [SLUG], 'THE FIX: the teardown is unconditional…');
        assert.strictEqual(pendingRestarts.has(SLUG), false, '…so the scheduled restart is cancelled with the plugin');
        assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')), 'and the code is gone');
    });

    it('refuses a plugin the option flags as ACTIVE (unchanged behaviour)', async () => {
        const dir = seedPluginDir(SLUG);
        liveIsolates.add(SLUG);
        await setActive([SLUG]);

        const r = await del(SLUG);

        assert.strictEqual(r.status, 400);
        assert.match(r.body.message, /Deactivate it first/);
        assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), 'nothing was deleted');
        assert.deepStrictEqual(unloadCalls, [], 'and the running plugin was left alone — this is not the delete path');
    });

    it('stops an ORPHANED child before deleting, although the option says the plugin is not active', async () => {
        // The state core/plugins.activatePlugin's guard exists for: a child is registered, the flag is
        // not set. `isPluginActive` alone waves this through.
        const dir = seedPluginDir(SLUG);
        liveIsolates.add(SLUG);
        await setActive([]);

        const r = await del(SLUG);

        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(unloadCalls, [SLUG], 'THE FIX: the orphan was stopped…');
        assert.strictEqual(fakeIsolate.isIsolated(SLUG), false,
            '…and is really gone — otherwise its hooks, routes and any claimed provider survive the delete, '
            + 'wired to a process whose code no longer exists on disk');
        assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')), 'and only then was the code removed');
    });

    it('refuses to delete at all when the orphan cannot be stopped', async () => {
        // Removing the directory is irreversible, so a child that survives its teardown is a hard stop,
        // not something to delete around.
        const dir = seedPluginDir(SLUG);
        liveIsolates.add(SLUG);
        unloadIsNoop = true;                 // teardown runs and the child is STILL registered
        await setActive([]);

        const r = await del(SLUG);

        assert.strictEqual(r.status, 409, JSON.stringify(r.body));
        assert.strictEqual(r.body.stillRunning, true);
        assert.match(r.body.message, /still has a running process/);
        assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), 'the code was NOT pulled out from under the live child');
        assert.ok(fs.existsSync(path.join(dir, 'data')), 'nor its data');
    });

    it('still requires the admin password (the new guard runs inside the authenticated path)', async () => {
        const dir = seedPluginDir(SLUG);
        liveIsolates.add(SLUG);

        const r = await del(SLUG, { password: 'wrong-password' });

        assert.strictEqual(r.status, 403);
        assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
        assert.deepStrictEqual(unloadCalls, [], 'an unauthenticated caller cannot use the delete route to stop a plugin');
    });
});
