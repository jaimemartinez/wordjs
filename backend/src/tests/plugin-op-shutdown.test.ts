/**
 * WordJS — the graceful shutdown must STOP TAKING PLUGIN WORK before it hands the leases back.
 *
 * A lease sits in dist-lock's `heldLocks` map EXACTLY WHILE ITS CRITICAL SECTION IS RUNNING: the handle
 * returned by acquireBlocking deletes it on release(), runAsLeader in its `finally`. So a shutdown that
 * simply calls releaseAllHeld() on SIGTERM frees, by construction, the leases that are still in use —
 * and 'wordjs:plugin-op:<slug>' is the one where that matters, because a peer node can immediately take
 * it and start extracting into the directory this process is mid-swap on. That is the corruption the
 * per-slug lease exists to prevent, re-created by the code meant to be polite about restarts.
 *
 * The sequence that fixes it, and what each test here pins:
 *   1. refuse NEW plugin operations (otherwise an admin clicking Update while the unit stops keeps the
 *      drain from ever converging),
 *   2. give the in-flight ones a bounded chance to FINISH — they then release their own lease, which
 *      leaves the successor unblocked AND the directory consistent, the best available outcome,
 *   3. release everything else, skipping whatever is still executing at the deadline; that lease
 *      expires on its TTL exactly as an abrupt kill's would, and the boot stash sweep reclaims it.
 *
 * Step 3's skip is tested in dist-lock-lease.test.ts (releaseAllHeld({ skip })). Steps 1 and 2 are here.
 *
 * This file gets its own process on purpose: `beginPluginOpShutdown` latches a module-level flag that
 * is never meant to be cleared, so exercising it anywhere else would silently refuse every later
 * plugin operation in that file. node --test gives each test file its own process.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'production';

// PLUGINS_DIR resolves from the CWD at module load.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-op-shutdown-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';

const pluginRoutes = require('../routes/plugins');
const { acquirePluginOpLock, beginPluginOpShutdown, drainPluginOps, pluginOpLeaseName } = pluginRoutes;

describe('graceful shutdown — plugin operations are drained before the leases are released', () => {
    let inFlightLock: any;

    before(async () => {
        // An operation already running when the signal arrives. This is the ONLY interesting case: with
        // nothing in flight the plugin-op lease is not held at all (its handle released it), so the
        // ordinary restart hands everything back immediately either way.
        inFlightLock = await acquirePluginOpLock('mail-server');
        assert.strictEqual(inFlightLock.ok, true, 'the operation took the lock before the shutdown began');
    });

    after(async () => {
        try { if (inFlightLock && inFlightLock.ok) await inFlightLock.release(); } catch { /* */ }
        process.chdir(os.tmpdir());
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
    });

    it('refuses NEW plugin operations once the shutdown starts, and reports what was already running', async () => {
        const running = beginPluginOpShutdown();
        assert.deepStrictEqual(running, ['mail-server'], 'the caller is told which operations it has to wait for');

        // A different plugin: nothing is holding its key, so only the shutdown latch can refuse it.
        // Without that latch this returns ok:true and starts a full install/update cycle that the
        // imminent process.exit will abort mid-swap — while holding a fresh 120s lease.
        const fresh = await acquirePluginOpLock('online-store');
        assert.strictEqual(fresh.ok, false, 'THE FIX: no new plugin work is accepted while stopping');

        // Idempotent — a second signal must not reset the drain or lose the in-flight list.
        assert.deepStrictEqual(beginPluginOpShutdown(), ['mail-server']);
    });

    it('drainPluginOps reports the operation that is STILL running when the deadline passes', async () => {
        const started = Date.now();
        const stillRunning = await drainPluginOps(80, 10);
        const waited = Date.now() - started;

        assert.deepStrictEqual(stillRunning, ['mail-server'],
            'so the caller can SKIP that lease — releasing it would hand a peer the plugin this process is mid-swap on');
        assert.ok(waited >= 70, `it actually waited for the deadline (waited ${waited}ms)`);
        assert.strictEqual(pluginOpLeaseName('mail-server'), 'wordjs:plugin-op:mail-server',
            'and names the lease the same way acquirePluginOpLock does, so the skip actually matches');
    });

    it('returns as soon as the in-flight operation finishes, well inside the deadline', async () => {
        // The good outcome: the update completes, releases its own lease, and the successor is unblocked
        // with a consistent directory. The shutdown must not sit out the full timeout to notice.
        setTimeout(() => { void inFlightLock.release(); }, 40);

        const started = Date.now();
        const stillRunning = await drainPluginOps(5000, 10);
        const waited = Date.now() - started;

        assert.deepStrictEqual(stillRunning, [], 'nothing is running, so every lease can be handed back');
        assert.ok(waited < 2000, `drained promptly rather than burning the timeout (waited ${waited}ms)`);
    });

    it('index.ts wires the sequence in the right ORDER', () => {
        // HONEST SCOPE: this is a source-level assertion, not an execution of gracefulShutdown. That
        // handler cannot be driven from a unit test — requiring index.ts boots the server, and the
        // function ends in process.exit(0), which would take the runner with it. What it does catch is
        // the failure that actually happened here twice: a helper that is implemented and tested in
        // isolation while the call site that gives it any effect is missing or mis-ordered. The
        // behaviour of each step is covered by the tests above and by dist-lock-lease.test.ts; this
        // covers only that index.ts still calls them, and calls them in the order that makes them safe.
        const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
        const start = src.indexOf('async function gracefulShutdown');
        assert.ok(start > 0, 'gracefulShutdown still exists');
        const end = src.indexOf('\nprocess.on(\'SIGTERM\'', start);
        assert.ok(end > start, 'and is still the handler installed for SIGTERM');
        const body = src.slice(start, end);

        const iBegin = body.indexOf('beginPluginOpShutdown()');
        const iDrain = body.indexOf('drainPluginOps(');
        const iRelease = body.indexOf('releaseAllHeld(');
        const iExit = body.indexOf('process.exit(0)');

        assert.ok(iBegin > 0, 'the shutdown refuses new plugin operations');
        assert.ok(iDrain > iBegin, '…then drains the in-flight ones — draining first could never converge');
        assert.ok(iRelease > iDrain, '…and only then hands the leases back');
        assert.ok(iExit > iRelease, '…before exiting');
        assert.match(body, /releaseAllHeld\(\{\s*skip\s*\}\)/, 'and it passes the skip predicate, so a still-running operation keeps its lease');

        // SIGINT must go through the same handler; a second path would skip the drain entirely.
        const handlers = src.slice(end, end + 400);
        assert.match(handlers, /SIGTERM[\s\S]*gracefulShutdown\('SIGTERM'\)/);
        assert.match(handlers, /SIGINT[\s\S]*gracefulShutdown\('SIGINT'\)/);
    });
});
