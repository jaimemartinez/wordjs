/**
 * WordJS — restarting the backend from the admin panel (zero config).
 *
 * A few settings are read once, at boot: the database driver and its connection, and whether this install
 * is a network of sites (`multisite.enabled`). Changing them from the panel used to end with "now restart
 * the backend", which a non-technical administrator cannot do. This module restarts the process itself,
 * safely, in every way WordJS is run:
 *
 *   supervisor   backend/server.js (split mode, `npm start`) and monolith.js (`npm run start:mono`, the
 *                Docker image) run the app as a child and start it again when it exits with
 *                RESTART_EXIT_CODE. They set WORDJS_SUPERVISED=1 for the child.
 *   watch        `npm run dev` runs `node --watch-path=./src`: touching the entry file restarts it.
 *   service      a container or service manager that starts the process again when it ends (Docker's
 *                restart policy, Kubernetes, systemd, pm2): the process exits with RESTART_EXIT_CODE.
 *   manual       none of the above can be seen (for example `node dist/index.js` typed in a terminal):
 *                nothing restarts it, so the screen tells the administrator, instead of exiting into
 *                a site that stays down.
 *
 * Several backend nodes: the node that applied the change announces it on the cluster bus
 * (RESTART_CHANNEL); every other node applies the same setting to its own wordjs-config.json and restarts
 * itself the same way (see followClusterRestarts).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./module-logger').moduleLogger('core/restart');

/** The exit code that asks a supervisor for a restart (EX_TEMPFAIL): not a crash, and never counted as one. */
const RESTART_EXIT_CODE = 75;

/** The cluster bus channel on which a node tells the others to apply a boot-time setting and restart. */
const RESTART_CHANNEL = 'wordjs:node-restart';

/** This process's identity: changes on every boot, so the panel can tell when a restart has happened. */
const BOOT_ID = crypto.randomBytes(8).toString('hex');
const BOOTED_AT = new Date().toISOString();

export type RestartMode = 'supervisor' | 'watch' | 'service' | 'manual';

let pending: { reason: string; at: string } | null = null;
// How the process ends for a restart. Tests replace it (setExitHandlerForTests) to see the code asked for.
let exitHandler: ((code: number) => void) | null = null;

function inWatchMode(): boolean {
    return process.execArgv.some((a: string) => a === '--watch' || a.startsWith('--watch-path') || a.startsWith('--watch='));
}

/** Is a container or service manager going to start this process again when it exits? */
function underServiceManager(env: NodeJS.ProcessEnv = process.env): boolean {
    if (env.KUBERNETES_SERVICE_HOST) return true;
    if (env.INVOCATION_ID) return true; // systemd
    if (env.pm_id !== undefined || env.PM2_HOME) return true;
    if (env.WORDJS_RESTART_ON_EXIT === '1') return true; // an operator's own manager says so
    try { if (fs.existsSync('/.dockerenv')) return true; } catch { /* not a container */ }
    return false;
}

/** How this process would be restarted, judged from how it was started. */
function restartMode(env: NodeJS.ProcessEnv = process.env, watch: boolean = inWatchMode()): RestartMode {
    if (env.WORDJS_SUPERVISED === '1') return 'supervisor';
    if (watch) return 'watch';
    if (underServiceManager(env)) return 'service';
    return 'manual';
}

/** What the panel shows: can WordJS restart itself here, and is a restart already on its way. */
function restartInfo() {
    const mode = restartMode();
    return { mode, automatic: mode !== 'manual', bootId: BOOT_ID, bootedAt: BOOTED_AT, pending };
}

/** Persist what an in-memory driver holds (sqlite-legacy keeps the database in memory) before exiting. */
function flushDatabase(): void {
    try {
        const db = require('../config/database');
        if (typeof db.saveDatabase === 'function') db.saveDatabase();
    } catch (e: any) {
        // After a migration the source driver may already be closed: nothing of it is needed any more.
        log.warn(`could not flush the database before the restart: ${(e && e.message) || String(e)}`);
    }
}

/** Touch the entry file node --watch follows, so the watcher reruns it. */
function touchWatchedEntry(): boolean {
    const candidates = [process.argv[1], path.resolve(__dirname, '../index.ts'), path.resolve(__dirname, '../index.js')].filter(Boolean);
    for (const f of candidates) {
        try {
            const t = new Date();
            fs.utimesSync(f, t, t);
            return true;
        } catch { /* the next candidate */ }
    }
    return false;
}

/**
 * Restart this process after `delayMs` (so the answer that announced it reaches the browser). Returns the
 * mode used, or 'manual' when nothing would bring the process back — then it does NOT exit, and the caller
 * tells the administrator. `exit` is injectable for tests.
 */
function scheduleRestart(reason: string, opts: { delayMs?: number; exit?: (code: number) => void } = {}): RestartMode {
    const mode = restartMode();
    if (mode === 'manual') {
        log.warn(`[restart] ${reason}: a restart is needed, but nothing here would start WordJS again; restart it by hand.`);
        return mode;
    }
    if (pending) return mode;
    pending = { reason, at: new Date().toISOString() };
    // Under `node --test` (NODE_TEST_CONTEXT) a route that restarts must not end the test process: a test
    // that wants to see the exit code installs a handler (setExitHandlerForTests); otherwise nothing exits.
    const underTestRunner = !!process.env.NODE_TEST_CONTEXT;
    const exit = opts.exit || exitHandler || (underTestRunner ? (() => { pending = null; }) : ((code: number) => process.exit(code)));
    const delay = typeof opts.delayMs === 'number' ? opts.delayMs : 750;
    log.info(`[restart] ${reason}: restarting (${mode}) in ${delay} ms.`);
    const t = setTimeout(() => {
        flushDatabase();
        if (mode === 'watch') {
            if (touchWatchedEntry()) return; // the watcher stops and reruns the process
            exit(0);
            return;
        }
        exit(RESTART_EXIT_CODE);
    }, delay);
    if (t && typeof t.unref === 'function' && (opts.exit || exitHandler || underTestRunner)) t.unref();
    return mode;
}

/** Forget a scheduled restart (tests only). */
function resetForTests(): void { pending = null; }

/** Tests: see the exit code a restart asks for instead of ending the test process (null restores it). */
function setExitHandlerForTests(fn: ((code: number) => void) | null): void { exitHandler = fn; }

/**
 * Tell the other backend nodes to apply `change` to their own config and restart. `change` is a closed
 * vocabulary: only the boot-time settings this module knows how to apply. No-op on a single node.
 */
async function announceClusterRestart(change: { multisiteEnabled: boolean }, reason: string): Promise<boolean> {
    const payload = JSON.stringify({ from: BOOT_ID, reason, multisiteEnabled: change.multisiteEnabled === true });
    try {
        const siteContext = require('./site-context');
        return await siteContext.runWithSite(siteContext.PRIMARY_SITE_ID, () => require('./cache').publish(RESTART_CHANNEL, payload));
    } catch (e: any) {
        log.warn(`[restart] could not tell the other nodes (${e && e.message}); restart them to apply "${reason}".`);
        return false;
    }
}

/** Apply a peer's announced change to this node's wordjs-config.json. Exported for tests. */
function applyClusterChange(raw: string): { applied: boolean; reason?: string } {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return { applied: false }; }
    if (!msg || typeof msg !== 'object' || msg.from === BOOT_ID || typeof msg.multisiteEnabled !== 'boolean') return { applied: false };
    const configManager = require('./configManager');
    const current = configManager.getConfig() || {};
    const now = !!(current.multisite && current.multisite.enabled === true);
    const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 120) : 'a change on another node';
    if (now !== msg.multisiteEnabled) {
        const r = configManager.updateConfig((c: any) => ({ ...c, multisite: { ...(c.multisite || {}), enabled: msg.multisiteEnabled } }), { reload: false });
        if (!r.ok) {
            log.error(`[restart] another node asked for "${reason}", but wordjs-config.json could not be written (${r.reason}).`);
            return { applied: false };
        }
    }
    return { applied: true, reason };
}

/** Subscribe this node to the other nodes' restart announcements. Called once at boot. */
function followClusterRestarts(): void {
    try {
        require('./cache').subscribe(RESTART_CHANNEL, (raw: string) => {
            const r = applyClusterChange(raw);
            if (r.applied) scheduleRestart(`${r.reason} (announced by another node)`, { delayMs: 250 + Math.floor(Math.random() * 1500) });
        });
    } catch (e: any) {
        log.warn(`[restart] not following the other nodes' restarts: ${e && e.message}`);
    }
}

module.exports = {
    RESTART_EXIT_CODE,
    RESTART_CHANNEL,
    BOOT_ID,
    restartMode,
    restartInfo,
    scheduleRestart,
    announceClusterRestart,
    applyClusterChange,
    followClusterRestarts,
    underServiceManager,
    resetForTests,
    setExitHandlerForTests,
};
