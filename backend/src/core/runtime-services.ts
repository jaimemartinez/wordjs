/**
 * WordJS - Per-process runtime services of an INSTALLED site
 *
 * The background machinery a site needs once it exists: cron (scheduled publishing, the daily prunes),
 * the multi-node coherence and cluster buses, the outgoing-webhook dispatcher and the content outbox
 * that feeds it.
 *
 * Two moments start them, once per process:
 *   · the boot of an INSTALLED site — index.ts initialize();
 *   · a fresh install — POST /setup/install, in a process that booted UNINSTALLED (setup mode). That
 *     boot has no database to run them against. When only the boot started them, a freshly installed
 *     site ran with none of them until its first restart: no webhook was ever enqueued for a post,
 *     comment or settings change (only the manual ping delivered), and a scheduled post never
 *     published.
 *
 * A module of its own, not a block in index.ts, because routes/setup.ts has to reach it and index.ts is
 * what requires the routers (same reason as core/plugins-ready).
 */

const log = require('./module-logger').moduleLogger('runtime-services');

let started = false;

/** Whether this process has started the runtime services. */
function areRuntimeServicesStarted(): boolean {
    return started;
}

/**
 * Start the runtime services. Idempotent: the second call (boot, then an install that cannot happen on
 * an installed site, or a retried install) does nothing, so no bus is subscribed twice and no listener
 * is registered twice. Needs the database to be open.
 */
async function startRuntimeServices(): Promise<void> {
    if (started) return;
    started = true;

    // Start cron system
    const { startCron, initDefaultCronEvents, scheduleEvent, scheduleSingleEvent, unscheduleEvent, nextScheduled } = require('./cron');
    await initDefaultCronEvents();
    // (#21) Daily analytics prune. Armed here rather than inside initDefaultCronEvents so the
    // retention policy stays in one module with its handler; the guard is the same "only if not
    // already scheduled" shape every default event uses, so a restart never duplicates it.
    try {
        const { HOOK: ANALYTICS_PRUNE_HOOK } = require('./analytics-retention');
        if (!(await nextScheduled(ANALYTICS_PRUNE_HOOK))) {
            await scheduleEvent(Date.now(), 'daily', ANALYTICS_PRUNE_HOOK);
        }
    } catch (e: any) {
        log.error({ err: e }, 'Failed to schedule the analytics retention prune');
    }
    startCron();

    // Multi-node coherence: refresh in-process caches (roles) on cross-node option changes, and
    // join the cluster notification bus so SSE pushes reach clients on any node. No-op w/o Redis.
    require('./coherence').initCoherence();
    require('./notifications').initClusterBus();
    // Salas de edición colaborativa (Verso F8): el gateway hace round-robin en cada petición, así
    // que dos editores de la misma página caen en nodos distintos por construcción. El bus reparte
    // sus ops entre nodos; sin Redis (mononodo) es un no-op y el fan-out se queda en memoria.
    require('./collab-rooms').initClusterBus();

    // Outgoing webhooks: subscribe the dispatcher to content hooks and start the delivery poller.
    require('./webhooks').initWebhooks();
    // F3 content outbox: pending events from this or a crashed peer are leased and delivered only
    // after their content transaction committed. Start it after hook consumers are registered.
    require('./content-outbox').initContentOutbox();

    // Expose Cron API to Plugins via global.wordjs
    global.wordjs = global.wordjs || {};
    global.wordjs.scheduleEvent = scheduleEvent;
    global.wordjs.scheduleSingleEvent = scheduleSingleEvent;
    global.wordjs.unscheduleEvent = unscheduleEvent;
    global.wordjs.nextScheduled = nextScheduled;
}

module.exports = { startRuntimeServices, areRuntimeServicesStarted };
