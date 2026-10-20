/**
 * WordJS — the plugin and theme workers of the sites of a network other than the main one: started on
 * first need, stopped again when the site has been idle (multisite).
 *
 * A site is prepared once per process (core/network-sites prepareSite: its database, roles, content
 * types, plugin grants); its WORKERS — one per active plugin (`s<id>:<slug>`) and its theme's
 * `functions.js` (`s<id>:theme:<slug>`) — are a separate state with four phases:
 *
 *   asleep    no worker runs (after preparation, after an idle stop, while suspended)
 *   waking    loadSitePlugins + the theme engine are starting them; whoever needs them awaits this
 *   awake     they run; every use of the site moves its `lastActive` forward
 *   stopping  the idle reaper (or a suspension) is stopping them; a need that arrives meanwhile waits
 *             for the stop to finish and then starts them again
 *
 * Needs (wake): every HTTP request that enters the site (core/site-resolver — awaited before the request
 * goes on, so the first request after an idle stop reaches a running worker), a due cron event, a due
 * content-outbox event. Activity that does not need a worker by itself keeps an awake site awake (touch):
 * a bus message for the site. A request in flight keeps its site awake however long it lasts.
 *
 * The reaper (started at boot) stops the workers of a site idle for `multisite.workerIdleMinutes`
 * (wordjs-config.json, default 15; 0 turns reaping off). The main site and single-site installs are never touched: their
 * workers start with the process and stay up, as they always did. Each node reaps its own workers.
 */
const config = require('../config/app');
const siteContext = require('./site-context');
const log = require('./module-logger').moduleLogger('core/site-workers');

type Phase = 'asleep' | 'waking' | 'awake' | 'stopping';
type SiteWorkerState = { phase: Phase; lastActive: number; inflight: number; pending: Promise<void> | null };

const DEFAULT_IDLE_MINUTES = 15;
const RESOLVED: Promise<void> = Promise.resolve();
const states = new Map<number, SiteWorkerState>();
let reaper: NodeJS.Timeout | null = null;

/** The idle period after which a site's workers stop, in ms (Infinity: never). */
function idleMs(): number {
    const m = (config as any).multisite;
    const raw = m && m.workerIdleMinutes !== undefined && m.workerIdleMinutes !== null ? Number(m.workerIdleMinutes) : DEFAULT_IDLE_MINUTES;
    if (!Number.isFinite(raw) || raw < 0) return DEFAULT_IDLE_MINUTES * 60000;
    return raw === 0 ? Infinity : raw * 60000;
}

/** Does `siteId` have workers this module manages (a site other than the main one, on a network)? */
function managed(siteId: number | null | undefined): siteId is number {
    return typeof siteId === 'number' && siteId !== siteContext.PRIMARY_SITE_ID && siteContext.multisiteEnabled();
}

function stateOf(siteId: number): SiteWorkerState {
    let s = states.get(siteId);
    if (!s) {
        s = { phase: 'asleep', lastActive: Date.now(), inflight: 0, pending: null };
        states.set(siteId, s);
    }
    return s;
}

/** Start the site's plugin workers and theme worker. Runs inside the site's context; never throws. */
async function startWorkers(siteId: number): Promise<void> {
    await require('./plugins').loadSitePlugins();
    try { await require('./theme-engine').init(); }
    catch (e: any) { log.warn(`[multisite] site ${siteId}: theme engine not started: ${e && e.message}`); }
}

/** Stop every worker THIS process runs for the site, and wait (bounded) for their processes to exit. */
async function stopWorkers(siteId: number): Promise<void> {
    let iso: any;
    try { iso = require('./plugin-isolate'); } catch { return; }
    const keys = iso.listIsolateKeys().filter((k: string) => iso.splitIsolateKey(k).siteId === siteId);
    for (const key of keys) {
        try { await iso.unloadIsolateKey(key); } catch { /* already gone */ }
    }
    await siteContext.runWithSite(siteId, async () => {
        for (const key of keys) {
            try { await iso.awaitIsolateStopped(iso.splitIsolateKey(key).slug); } catch { /* bounded wait only */ }
        }
    });
}

/** Does this process run (or is it starting) any worker of `siteId`? */
function hasWorkers(siteId: number): boolean {
    try {
        const iso = require('./plugin-isolate');
        return iso.listIsolateKeys().some((k: string) => iso.splitIsolateKey(k).siteId === siteId);
    } catch { return false; }
}

/**
 * The site's workers are needed now: start them if they are not running (awaited — resolves once they
 * are up, or once their start has failed and been logged), and count this as activity. A no-op for the
 * main site and on a single site.
 */
function wake(siteId: number): Promise<void> {
    if (!managed(siteId)) return RESOLVED;
    const s = stateOf(siteId);
    s.lastActive = Date.now();
    if (s.phase === 'awake') return RESOLVED;
    if (s.phase === 'waking') return s.pending || RESOLVED;
    // Asleep, or stopping: a stop in progress finishes first, so no two workers of one key overlap.
    const prior = s.pending || RESOLVED;
    s.phase = 'waking';
    const mine: Promise<void> = prior.catch(() => { /* the stop's own business */ })
        .then(() => siteContext.runWithSite(siteId, () => startWorkers(siteId)))
        .catch((e: any) => log.warn(`[multisite] site ${siteId}: workers not started: ${e && e.message}`))
        .then(() => {
            if (s.pending !== mine) return;
            s.phase = 'awake';
            s.pending = null;
            s.lastActive = Date.now();
        });
    s.pending = mine;
    return mine;
}

/**
 * Stop the site's workers (idle, or the site was suspended). A start in progress finishes first. The
 * next wake() starts them again.
 */
function sleep(siteId: number, reason = 'idle'): Promise<void> {
    if (!managed(siteId)) return RESOLVED;
    const s = stateOf(siteId);
    if (s.phase === 'stopping') return s.pending || RESOLVED;
    if (s.phase === 'asleep' && !hasWorkers(siteId)) return RESOLVED;
    const prior = s.pending || RESOLVED;
    s.phase = 'stopping';
    const mine: Promise<void> = prior.catch(() => { /* the start's own business */ })
        .then(() => stopWorkers(siteId))
        .catch((e: any) => log.warn(`[multisite] site ${siteId}: workers not stopped cleanly: ${e && e.message}`))
        .then(() => {
            if (s.pending !== mine) return;
            s.phase = 'asleep';
            s.pending = null;
        });
    s.pending = mine;
    if (reason === 'idle') log.info(`[multisite] site ${siteId}: idle — its plugin and theme workers stop until its next use.`);
    return mine;
}

/** Activity on the site that does not need its workers by itself (a bus message): an awake site stays up. */
function touch(siteId: number | null | undefined): void {
    if (!managed(siteId)) return;
    const s = states.get(siteId);
    if (s) s.lastActive = Date.now();
}

/**
 * A request entered the site: wake its workers and keep them up until the response is over, however long
 * it takes. Resolves once the workers are running.
 */
function enterRequest(siteId: number, res: { once: (ev: string, fn: () => void) => any }): Promise<void> {
    if (!managed(siteId)) return RESOLVED;
    const s = stateOf(siteId);
    s.inflight++;
    let done = false;
    const leave = () => {
        if (done) return;
        done = true;
        s.inflight = Math.max(0, s.inflight - 1);
        s.lastActive = Date.now();
    };
    res.once('finish', leave);
    res.once('close', leave);
    return wake(siteId);
}

/**
 * One reaper pass: stop the workers of every site idle for longer than the configured period, with no
 * request in flight. `now` is for the tests. Returns the ids of the sites it put to sleep.
 */
async function reapIdleSites(now: number = Date.now()): Promise<number[]> {
    const limit = idleMs();
    if (!Number.isFinite(limit) || !siteContext.multisiteEnabled()) return [];
    const stopped: number[] = [];
    const waits: Promise<void>[] = [];
    for (const [siteId, s] of states) {
        if (siteId === siteContext.PRIMARY_SITE_ID) continue;
        if (s.inflight > 0 || now - s.lastActive < limit) continue;
        // An awake site, or an asleep one that a worker started outside a wake (nothing should, but
        // nothing it starts may then live forever either).
        if (s.phase === 'awake' || (s.phase === 'asleep' && hasWorkers(siteId))) {
            stopped.push(siteId);
            waits.push(sleep(siteId, 'idle'));
        }
    }
    await Promise.all(waits);
    return stopped;
}

/**
 * Start the periodic reaper (once; only on a network with reaping on). Called at boot (index.ts), as the
 * main site: a timer keeps the async context it was created in, so one started from inside a request would
 * run every pass as that request (its site, its request id in the log).
 */
function startReaper(): void {
    if (reaper || !siteContext.multisiteEnabled()) return;
    const limit = idleMs();
    if (!Number.isFinite(limit)) return;
    const every = Math.max(1000, Math.min(60000, Math.floor(limit / 4)));
    reaper = setInterval(() => {
        reapIdleSites().catch((e: any) => log.warn(`[multisite] idle worker reaper failed: ${e && e.message}`));
    }, every);
    if (typeof reaper.unref === 'function') reaper.unref();
}

/** Stop the reaper (graceful shutdown, tests). */
function stopReaper(): void {
    if (reaper) { clearInterval(reaper); reaper = null; }
}

/** Forget a site (deleted, or its preparation dropped); its workers were stopped by the caller. */
function forget(siteId: number): void {
    states.delete(siteId);
}

/** The phase of a site's workers in this process ('asleep' for one it never prepared). */
function phaseOf(siteId: number): Phase {
    if (!managed(siteId)) return 'awake';
    const s = states.get(siteId);
    return s ? s.phase : 'asleep';
}

/** Is the site's worker set asleep or going to sleep here (nothing may start one of its workers)? */
function isAsleep(siteId: number | null | undefined): boolean {
    if (!managed(siteId)) return false;
    const p = phaseOf(siteId);
    return p === 'asleep' || p === 'stopping';
}

module.exports = {
    wake,
    sleep,
    touch,
    enterRequest,
    reapIdleSites,
    startReaper,
    stopReaper,
    forget,
    phaseOf,
    isAsleep,
    idleMs,
    DEFAULT_IDLE_MINUTES,
};
