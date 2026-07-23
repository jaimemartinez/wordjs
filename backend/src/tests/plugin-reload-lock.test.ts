/**
 * WordJS — every route that RELOADS an isolate is serialized with the other plugin operations.
 *
 * reloadIsolatedPlugin is an unload followed by an AWAITED load, i.e. a window in which the slug has no
 * registered child and a fresh one is about to appear. Four admin routes drove it outside any lock:
 * POST /:slug/permissions, POST /:slug/egress-hosts, POST /:slug/reload and POST /:slug/free-port. So:
 *
 *   - a DEACTIVATE landing inside that window unloads a child that is already gone and rewrites
 *     `active_plugins`; the reload then registers a new child for a plugin the option no longer lists —
 *     the orphan state that only DELETE can clear;
 *   - a DEACTIVATE + DELETE landing there is worse. DELETE's own post-unload verify runs BEFORE the
 *     reload's registration, so it sees a quiet slug, answers 200 and removes the directory — and the
 *     reload then registers a live child for a plugin that no longer exists on disk.
 *
 * The fix is the same per-slug operation lock the other mutating routes already take. This file drives
 * the REAL router over supertest (real JWT, real admin gate, real lock) and fakes only
 * core/plugin-isolate — no child is spawned here; the question is which HTTP answer the second caller
 * gets and what state is left behind.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// regenerateRegistry() shells out to the frontend registry generators unless NODE_ENV is production,
// and one of them writes an absolute path from THIS temp root into a file the project forbids
// committing. Pin it (same reason as the sibling plugin route tests).
process.env.NODE_ENV = 'production';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-reload-lock-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');

const PLUGINS_DIR = path.join(TMP_ROOT, 'plugins');
const SLUG = 'reloadable';
const ADMIN = 'reload-admin';
const PASSWORD = 'Str0ng-Pa55word!';
const CLAIMED_PORT = 2525;

// --- the isolate REGISTRY, faked ---------------------------------------------------------------

const liveIsolates = new Set<string>();
const livePids = new Map<string, Set<number>>();
let nextPid = 50000;
function addPid(slug: string) {
    let s = livePids.get(slug);
    if (!s) { s = new Set<number>(); livePids.set(slug, s); }
    s.add(++nextPid);
}
/** When set, reloadIsolatedPlugin parks INSIDE the unload→load window until the test opens it. */
let reloadGate: Promise<void> | null = null;
/** Resolves once a reload has actually entered the gate, so the test never races the request. */
let reloadEntered: (() => void) | null = null;
let reloadCalls = 0;

const fakeIsolate: any = {
    loadIsolatedPlugin: async (slug: string) => { liveIsolates.add(slug); addPid(slug); return { ok: true }; },
    unloadIsolatedPlugin: (slug: string) => { liveIsolates.delete(slug); setTimeout(() => livePids.delete(slug), 1); },
    isIsolated: (slug: string) => liveIsolates.has(slug),
    getLivePids: (slug: string) => Array.from(livePids.get(slug) || []),
    awaitIsolateStopped: async (slug: string, timeoutMs = 3000) => {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        for (;;) {
            if (!liveIsolates.has(slug) && (livePids.get(slug) || new Set()).size === 0) return true;
            if (Date.now() >= deadline) return false;
            await new Promise((r) => setTimeout(r, 5));
        }
    },
    // Faithful to the real one: unload FIRST (the slug goes quiet), then an awaited load.
    reloadIsolatedPlugin: async (slug: string) => {
        reloadCalls++;
        fakeIsolate.unloadIsolatedPlugin(slug);
        if (reloadGate) {
            const gate = reloadGate;
            if (reloadEntered) { const f = reloadEntered; reloadEntered = null; f(); }
            await gate;
        }
        return fakeIsolate.loadIsolatedPlugin(slug);
    },
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
        id: slug, name: 'Reloadable', version: '1.0.0', isolated: true, bundled: true,
        permissions: ['network'], claimPorts: [CLAIMED_PORT],
    }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'exports.init = () => 1;\n');
    return dir;
}

describe('the isolate-reloading routes take the same per-slug lock as the rest', () => {
    let token: string;
    let setActive: (l: string[]) => Promise<any>;
    let readActive: () => Promise<string[]>;

    before(async () => {
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();

        const User = require('../models/User');
        const admin = await User.create({
            username: ADMIN, email: `${ADMIN}@example.com`, password: PASSWORD,
            displayName: 'Reload Admin', role: 'administrator',
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
        livePids.clear();
        reloadGate = null;
        reloadEntered = null;
        reloadCalls = 0;
        seedPluginDir(SLUG);
        await setActive([SLUG]);
        liveIsolates.add(SLUG); addPid(SLUG);
    });

    const auth = (r: any) => r.set('Authorization', `Bearer ${token}`);
    const reload = () => auth(request(app).post(`/plugins/${SLUG}/reload`)).send({});
    const permissions = () => auth(request(app).post(`/plugins/${SLUG}/permissions`)).send({ granted: ['options:read'] });
    const egress = () => auth(request(app).post(`/plugins/${SLUG}/egress-hosts`)).send({ hosts: ['api.example.com'] });
    const freePort = () => auth(request(app).post(`/plugins/${SLUG}/free-port`)).send({ port: CLAIMED_PORT, allowDisable: true });
    const del = () => auth(request(app).delete(`/plugins/${SLUG}`)).send({ password: PASSWORD });
    const deactivate = () => auth(request(app).post(`/plugins/${SLUG}/deactivate`)).send({});

    // `reloadsWhenFree`: whether the route reaches its reload on THIS platform once the slug is free.
    // /free-port cannot — core/port-conflicts refuses off Linux (PORT_NOT_FREEABLE) before any reload —
    // so only the refusal half is portable for it. The refusal is the property under test either way:
    // it must be the LOCK's 409 (busy: true), which is answered before that platform check runs.
    const ROUTES: Array<[string, () => any, boolean]> = [
        ['/reload', reload, true],
        ['/permissions', permissions, true],
        ['/egress-hosts', egress, true],
        ['/free-port', freePort, false],
    ];

    for (const [label, send, reloadsWhenFree] of ROUTES) {
        it(`POST ${label} is refused (409) while another operation holds the slug`, async () => {
            // Stands in for an install/update/delete/activate in flight. Before the fix every one of
            // these four went straight through and reloaded the child under it.
            const held = await acquirePluginOpLock(SLUG);
            assert.strictEqual(held.ok, true);
            try {
                const r = await send();

                assert.strictEqual(r.status, 409, JSON.stringify(r.body));
                assert.strictEqual(r.body.busy, true);
                assert.match(r.body.message, /locked by another install\/update\/uninstall/);
                assert.strictEqual(reloadCalls, 0, 'and no reload was started under the other operation');
            } finally {
                await held.release();
            }

            // Not sticky: once the slug is free the request is no longer refused BY THE LOCK.
            const after = await send();
            assert.notStrictEqual(after.body && after.body.busy, true,
                `${label} is no longer lock-refused once the slug is free: ${JSON.stringify(after.body)}`);
            if (reloadsWhenFree) {
                assert.ok(after.status < 400, `${label} succeeded: ${JSON.stringify(after.body)}`);
                assert.strictEqual(reloadCalls, 1, 'and it did reload this time');
                assert.strictEqual(fakeIsolate.isIsolated(SLUG), true, 'leaving the child registered');
            }
        });
    }

    it('THE RACE: a DELETE that lands mid-reload is refused — the directory is not removed under the new child', async () => {
        // Park the reload in the unload→load window: the slug is quiet, so DELETE's `isPluginActive`
        // check and its post-unload verify BOTH pass, it removes the directory and answers 200 — and the
        // reload then registers a live child for a plugin that no longer exists on disk.
        await setActive([]);                 // the deactivate half of the race already happened
        let openGate: () => void = () => { };
        reloadGate = new Promise<void>((resolve) => { openGate = resolve; });
        const entered = new Promise<void>((resolve) => { reloadEntered = resolve; });

        // .then() is what actually SENDS a supertest request — building the Test object does not.
        const reloading = reload().then((r: any) => r);
        await entered;                       // the reload is now inside its unload→load window
        assert.strictEqual(fakeIsolate.isIsolated(SLUG), false, 'precondition: mid-reload the slug looks quiet');

        const deleted = await del();

        assert.strictEqual(deleted.status, 409, JSON.stringify(deleted.body));
        assert.strictEqual(deleted.body.busy, true, 'THE FIX: the DELETE is refused while the reload owns the slug');
        assert.ok(fs.existsSync(path.join(PLUGINS_DIR, SLUG, 'manifest.json')),
            'so the code is NOT removed under a child that is about to be spawned from it');

        openGate();
        const r = await reloading;
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(fakeIsolate.isIsolated(SLUG), true, 'and the reload completed as a whole');
        assert.ok(fs.existsSync(path.join(PLUGINS_DIR, SLUG, 'index.js')), 'with its code still on disk');
    });

    it('THE MIRROR: a DEACTIVATE that lands mid-reload is refused, so no orphan is created', async () => {
        // Unserialized, the deactivate unloads a child that is already gone and clears the flag; the
        // reload then re-registers one for a plugin `active_plugins` no longer lists — an orphan that
        // deactivatePlugin itself refuses to touch ('Plugin not active').
        let openGate: () => void = () => { };
        reloadGate = new Promise<void>((resolve) => { openGate = resolve; });
        const entered = new Promise<void>((resolve) => { reloadEntered = resolve; });

        const reloading = reload().then((r: any) => r);
        await entered;

        const off = await deactivate();
        assert.strictEqual(off.status, 409, JSON.stringify(off.body));
        assert.deepStrictEqual(await readActive(), [SLUG], 'the flag was not cleared under the reload');

        openGate();
        assert.strictEqual((await reloading).status, 200);
        assert.strictEqual(fakeIsolate.isIsolated(SLUG), true);
        assert.deepStrictEqual(await readActive(), [SLUG],
            'so the registry and the option still agree — which is what "no orphan" means here');
    });

    it('releases the slug even when the reload FAILS, so the admin can retry', async () => {
        // The lock is released in a `finally`. Without it one failed reload would 409 every
        // install/update/delete/activate of that plugin until the 120s lease expired.
        const original = fakeIsolate.reloadIsolatedPlugin;
        fakeIsolate.reloadIsolatedPlugin = async () => { throw new Error('spawn failed'); };
        try {
            const r = await reload();
            assert.ok(r.status >= 400 || r.status === 200, 'the route answered rather than hanging');
        } finally {
            fakeIsolate.reloadIsolatedPlugin = original;
        }

        const held = await acquirePluginOpLock(SLUG);
        assert.strictEqual(held.ok, true, 'the slug is free again');
        await held.release();
    });
});
