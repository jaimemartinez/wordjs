/**
 * WordJS — DELETE /api/v1/plugins/:slug must prove the child process is GONE before it removes the
 * plugin's files. Real router, real admin auth, real child processes.
 *
 * WHAT IS UNDER TEST. The active-plugins check the handler starts with ("Cannot delete an active
 * plugin") reads a stored INTENTION; the isolate registry is the running TRUTH, and the two disagree in
 * ordinary states — a load that failed after registering its child, a cross-node/dev-watcher load, a
 * crashed child with a backoff restart still armed. In those states the handler used to walk straight
 * into rmSync and pull the directory out from under a LIVE process that still holds this plugin's
 * hooks, routes and any claimed provider. The fix is three things, and each is asserted here:
 *   1. unloadIsolatedPlugin is called UNCONDITIONALLY (kills the child, cancels a pending restart),
 *   2. the handler then WAITS for the process to actually be observed gone — not for the registry
 *      entry to disappear, which unloadIsolatedPlugin does synchronously while kill() is async,
 *   3. and if it is still alive when the bounded wait expires it REFUSES: 409 { stillRunning: true },
 *      files untouched.
 *
 * REAL CHILDREN ON PURPOSE. A registry fake cannot show any of this: the whole failure is that a
 * PROCESS outlives its files, so the fixtures fork actual plugin workers and the assertions are about
 * pids the host observed exiting, the plugin's filter no longer applying, and the directory on disk.
 */

// The successful-delete path ends in regenerateRegistry(), which in a non-production env spawns the
// three frontend generators — and those REWRITE frontend/src/lib/*Registry.ts in the working tree. That
// is a dev-HMR convenience with nothing to do with teardown, and a test suite must not edit the repo it
// runs in, so pin the env the way a real install runs and the generator hop no-ops. Must be set before
// anything reads it. (config.nodeEnv already defaults to 'production' when NODE_ENV is unset, so this
// makes the two agree rather than changing the app's shape.)
process.env.NODE_ENV = 'production';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-plugin-delete-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const express = require('express');
const request = require('supertest');
const roles = require('../core/roles');
const hooks = require('../core/hooks');
const { setApp } = require('../core/appRegistry');
const isolate = require('../core/plugin-isolate');
const { loadIsolatedPlugin, isIsolated, getLivePids, awaitIsolateStopped } = isolate;

const pluginsRouter = require('../routes/plugins');
// The route's OWN slug→directory resolver. Deriving the fixture path from it (instead of re-deriving
// './plugins' here) means the test can only ever write where the handler will look; a change to that
// resolution moves both sides together or fails loudly, it cannot silently make these tests vacuous.
const { resolveSafePluginDir } = pluginsRouter;

const app = express();
app.use(express.json());
app.use('/api/v1/plugins', pluginsRouter);

const ADMIN_PASS = 'correct-horse-battery-staple-9';
const SECRET = config.jwt.secret;
let adminToken = '';

/** An isolated plugin that registers a host filter, so "is this child still wired in?" is observable. */
const LIVE_ENTRY =
    "exports.init = function (wordjs) {\n" +
    "  wordjs.hooks.addFilter('delete_teardown_filter', (v) => '[live]' + v);\n" +
    "};\n";

function writePlugin(slug: string, source = LIVE_ENTRY): string {
    const dir = resolveSafePluginDir(slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: slug, isolated: true, permissions: [] }));
    fs.writeFileSync(path.join(dir, 'index.js'), source);
    return dir;
}

const SLUGS = ['test-delete-stopped', 'test-delete-running', 'test-delete-wont-stop', 'test-delete-await'];

const del = (slug: string, body: any = { password: ADMIN_PASS }) =>
    request(app).delete(`/api/v1/plugins/${slug}`).set('Authorization', `Bearer ${adminToken}`).send(body);

/** Poll until every pid the host spawned for the slug has been observed to exit (or give up). */
async function pidsGone(slug: string, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (getLivePids(slug).length === 0) return true;
        await new Promise((r) => setTimeout(r, 25));
    }
    return false;
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await roles.loadRoles();

    const User = require('../models/User');
    const admin = await User.create({
        username: 'deladmin', email: 'deladmin@example.com', password: ADMIN_PASS, role: 'administrator',
    });
    adminToken = jwt.sign({ userId: admin.id, username: 'deladmin' }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });

    setApp(app); // the host owns Express; an isolated plugin's routes mount here
});

after(async () => {
    for (const slug of SLUGS) {
        try { isolate.unloadIsolatedPlugin(slug); } catch { /* */ }
        try { fs.rmSync(resolveSafePluginDir(slug), { recursive: true, force: true }); } catch { /* */ }
    }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* */ } }
});

test('DELETE removes a plugin that has no child process at all', async () => {
    // The ordinary case, and the control for everything below: the teardown step added in front of the
    // rmSync must not get in the way of deleting a plugin that was never running. unloadIsolatedPlugin
    // is called unconditionally here too (it is idempotent) and awaitIsolateStopped must be satisfied
    // immediately, because nothing is registered and no pid was ever spawned for this slug.
    const dir = writePlugin('test-delete-stopped');
    assert.strictEqual(isIsolated('test-delete-stopped'), false, 'precondition: nothing is running');

    const r = await del('test-delete-stopped');

    assert.strictEqual(r.status, 200, `a stopped plugin deletes normally (body: ${JSON.stringify(r.body)})`);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(fs.existsSync(dir), false, 'and its directory is gone');
});

test('DELETE tears down a RUNNING orphaned child before it removes the directory', async () => {
    // THE STATE THE ACTIVE-CHECK CANNOT SEE. The slug is NOT in active_plugins — so `isPluginActive` is
    // false and the "deactivate it first" guard passes — while a real child is registered and applying
    // a filter to host content. Deactivating is not an option the admin has either: deactivatePlugin
    // early-returns 'Plugin not active' for exactly this state, so DELETE is the only thing that can
    // clear it, and before the fix DELETE deleted the files and left the process running.
    const slug = 'test-delete-running';
    const dir = writePlugin(slug);
    await loadIsolatedPlugin(slug, path.join(dir, 'index.js'));

    assert.strictEqual(isIsolated(slug), true, 'precondition: a child is registered');
    assert.strictEqual(getLivePids(slug).length, 1, 'precondition: exactly one live child');
    assert.strictEqual(await hooks.applyFilters('delete_teardown_filter', 'x'), '[live]x',
        'precondition: and it is really wired into the host');
    assert.strictEqual(await require('../core/plugins').isPluginActive(slug), false,
        'precondition: yet the plugin is NOT listed active — the guard above this code passes');

    const r = await del(slug);

    assert.strictEqual(r.status, 200, `the orphaned isolate is stopped and the delete proceeds (body: ${JSON.stringify(r.body)})`);
    // Checked WITHOUT polling, on purpose: the handler only answers once the process has been observed
    // to exit, so by the time this response is in hand the pid set must already be empty. Polling here
    // would hide precisely the race the wait exists to close (unloadIsolatedPlugin drops the registry
    // entry synchronously while kill() is still in flight).
    assert.deepStrictEqual(getLivePids(slug), [], 'the child was observed gone BEFORE the response');
    assert.strictEqual(isIsolated(slug), false, 'nothing is left registered');
    assert.strictEqual(await hooks.applyFilters('delete_teardown_filter', 'x'), 'x',
        'and its filter no longer touches host content');
    assert.strictEqual(fs.existsSync(dir), false, 'the directory is removed');
});

test('awaitIsolateStopped reports a live child as NOT stopped, and only flips once the pid is gone', async () => {
    // The primitive the 409 rests on, exercised against real state with nothing stubbed. `isIsolated`
    // alone would be a false green here: it goes false the instant unloadIsolatedPlugin runs, whether
    // or not the SIGKILL has landed, which is exactly the check the DELETE path used to be limited to.
    const slug = 'test-delete-await';
    const dir = writePlugin(slug);
    await loadIsolatedPlugin(slug, path.join(dir, 'index.js'));

    const started = Date.now();
    assert.strictEqual(await awaitIsolateStopped(slug, 250), false,
        'a registered, live child means NOT stopped — and it waits for the deadline before saying so');
    assert.ok(Date.now() - started >= 200, 'it really waited rather than answering instantly');

    isolate.unloadIsolatedPlugin(slug);
    assert.strictEqual(await awaitIsolateStopped(slug, 5000), true, 'and it flips to true once the child exits');
    assert.deepStrictEqual(getLivePids(slug), [], 'with no pid left behind');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('DELETE REFUSES with 409 stillRunning when the child cannot be stopped — and deletes nothing', async () => {
    // FORCING THE UNSTOPPABLE CHILD. A healthy SIGKILL always lands, so the only way to reach this
    // branch is to make the STOP fail while the process keeps running: unloadIsolatedPlugin is made to
    // throw, which the handler catches and logs. Everything the branch actually reads is real — a real
    // forked child, really registered, with a real live pid — and the real awaitIsolateStopped polls
    // that real state until its real deadline. The 409 below is derived from a process that IS alive,
    // not from a stubbed boolean.
    const slug = 'test-delete-wont-stop';
    const dir = writePlugin(slug);
    await loadIsolatedPlugin(slug, path.join(dir, 'index.js'));
    const pidBefore = getLivePids(slug)[0];
    assert.ok(pidBefore, 'precondition: a real child is running');

    const realUnload = isolate.unloadIsolatedPlugin;
    isolate.unloadIsolatedPlugin = () => { throw new Error('simulated: the child refuses to stop'); };

    let r: any;
    const started = Date.now();
    try {
        r = await del(slug);
    } finally {
        isolate.unloadIsolatedPlugin = realUnload;
    }
    const elapsed = Date.now() - started;

    assert.strictEqual(r.status, 409, `the delete is refused (body: ${JSON.stringify(r.body)})`);
    assert.strictEqual(r.body.stillRunning, true, 'and flagged so the admin UI can tell this apart from a 409 conflict');
    assert.ok(r.body.pids.includes(pidBefore), `the response names the pid that is still alive (got ${JSON.stringify(r.body.pids)})`);
    // The escalation the operator needs, because this refusal can persist: a pid whose exit event never
    // arrives is never cleared from the in-process live set, so DELETE keeps answering 409 for this slug
    // until the server restarts. The message has to say so.
    assert.match(r.body.message, /restart the server/i, 'the message states the guaranteed way out');
    assert.match(r.body.message, /nothing was deleted/i, 'and that the files are still there');

    // THE POINT. A refusal that still deleted the files would be worse than no check at all.
    assert.strictEqual(fs.existsSync(dir), true, 'the plugin directory was NOT touched');
    assert.strictEqual(fs.existsSync(path.join(dir, 'index.js')), true, 'nor its contents');
    assert.strictEqual(isIsolated(slug), true, 'and the child is still running (it was never stopped)');

    // The wait is BOUNDED — it answered rather than hanging the admin request forever on a condition
    // that may never be satisfiable — and it is a real wait, not an instant give-up.
    assert.ok(elapsed >= 2000, `it waited for the child (${elapsed}ms)`);
    assert.ok(elapsed < 30000, `but bounded, not indefinite (${elapsed}ms)`);

    // POSITIVE CONTROL: with the stop working again the SAME request succeeds, so the 409 above was
    // caused by the live child and by nothing else (a broken route, bad auth, a missing directory).
    const ok = await del(slug);
    assert.strictEqual(ok.status, 200, `once the child can be stopped the delete goes through (body: ${JSON.stringify(ok.body)})`);
    assert.ok(await pidsGone(slug), 'the child is gone');
    assert.strictEqual(fs.existsSync(dir), false, 'and the directory is finally removed');
});
