/**
 * WordJS - Cron System
 * Equivalent to wp-cron.php
 */

const { getOption, updateOption } = require('./options');
const { doAction, doActionForPlugin, addAction } = require('./hooks');
const { getCurrentPlugin } = require('./plugin-context');

// Registered cron jobs
const cronJobs = new Map();

// Cron schedules
const schedules: Record<string, { interval: number; display: string }> = {
    hourly: { interval: 3600000, display: 'Once Hourly' },
    twicedaily: { interval: 43200000, display: 'Twice Daily' },
    daily: { interval: 86400000, display: 'Once Daily' },
    weekly: { interval: 604800000, display: 'Once Weekly' },
    off: { interval: 0, display: 'Disabled' }
};

// Cron timer
let cronTimer: NodeJS.Timeout | null = null;

/**
 * Register a cron schedule
 */
function addSchedule(name: string, interval: number, display: string) {
    schedules[name] = { interval, display };
}

/**
 * Get all schedules
 */
function getSchedules() {
    return { ...schedules };
}

// Bound the persistent 'cron' option blob so an untrusted plugin can't amplify storage/serialization
// by scheduling unbounded events (or events with huge args). Per-plugin + global caps + args-size cap.
const MAX_CRON_EVENTS_PER_PLUGIN = 200;
const MAX_CRON_EVENTS_TOTAL = 5000;
const MAX_CRON_ARGS_BYTES = 4096;
function assertCronCapacity(events: any, pluginSlug: any, args: any) {
    if (JSON.stringify(args || []).length > MAX_CRON_ARGS_BYTES) {
        throw new Error('🛡️ Cron schedule denied: event args are too large.');
    }
    let total = 0, mine = 0;
    for (const ts of Object.keys(events || {})) {
        for (const k of Object.keys(events[ts] || {})) {
            total++;
            if (pluginSlug && events[ts][k] && events[ts][k].pluginSlug === pluginSlug) mine++;
        }
    }
    if (total >= MAX_CRON_EVENTS_TOTAL) {
        throw new Error('🛡️ Cron schedule denied: too many scheduled events on this site.');
    }
    if (pluginSlug && mine >= MAX_CRON_EVENTS_PER_PLUGIN) {
        throw new Error(`🛡️ Cron schedule denied: plugin '${pluginSlug}' exceeded its scheduled-event cap (${MAX_CRON_EVENTS_PER_PLUGIN}).`);
    }
}

/**
 * Schedule an event (Async)
 * Equivalent to wp_schedule_event()
 */
async function scheduleEvent(timestamp: any, recurrence: any, hook: any, args = []) {
    const events = await getOption('cron', {});
    const pluginSlug = getCurrentPlugin();
    assertCronCapacity(events, pluginSlug, args);

    if (!events[timestamp]) {
        events[timestamp] = {};
    }

    const key = `${hook}_${JSON.stringify(args)}`;
    events[timestamp][key] = {
        hook,
        args,
        schedule: recurrence,
        interval: schedules[recurrence]?.interval || 0,
        // Record the scheduling plugin so the fired event only runs ITS callbacks (not core hooks).
        pluginSlug
    };

    await updateOption('cron', events);
    return true;
}

/**
 * Schedule a single event (Async)
 * Equivalent to wp_schedule_single_event()
 */
async function scheduleSingleEvent(timestamp: any, hook: any, args = []) {
    const events = await getOption('cron', {});
    const pluginSlug = getCurrentPlugin();
    assertCronCapacity(events, pluginSlug, args);

    if (!events[timestamp]) {
        events[timestamp] = {};
    }

    const key = `${hook}_${JSON.stringify(args)}`;
    events[timestamp][key] = {
        hook,
        args,
        schedule: false,
        pluginSlug
    };

    await updateOption('cron', events);
    return true;
}

/**
 * Unschedule an event (Async)
 * Equivalent to wp_unschedule_event()
 */
async function unscheduleEvent(timestamp: any, hook: any, args = []) {
    const events = await getOption('cron', {});
    const key = `${hook}_${JSON.stringify(args)}`;

    if (events[timestamp] && events[timestamp][key]) {
        delete events[timestamp][key];

        if (Object.keys(events[timestamp]).length === 0) {
            delete events[timestamp];
        }

        await updateOption('cron', events);
        return true;
    }

    return false;
}

/**
 * Clear all scheduled hooks (Async)
 * Equivalent to wp_clear_scheduled_hook()
 */
async function clearScheduledHook(hook: any, args = null) {
    const events = await getOption('cron', {});
    let cleared = false;

    // Iterate efficiently
    for (const timestamp of Object.keys(events)) {
        for (const key of Object.keys(events[timestamp])) {
            const event = events[timestamp][key];

            if (event.hook === hook) {
                if (args === null || JSON.stringify(event.args) === JSON.stringify(args)) {
                    delete events[timestamp][key];
                    cleared = true;
                }
            }
        }

        if (Object.keys(events[timestamp]).length === 0) {
            delete events[timestamp];
        }
    }

    if (cleared) {
        await updateOption('cron', events);
    }

    return cleared;
}

/**
 * Get next scheduled time for a hook (Async)
 * Equivalent to wp_next_scheduled()
 */
async function nextScheduled(hook: any, args = []) {
    const events = await getOption('cron', {});
    const key = `${hook}_${JSON.stringify(args)}`;

    for (const timestamp of Object.keys(events).sort()) {
        if (events[timestamp][key]) {
            return parseInt(timestamp);
        }
    }

    return false;
}

/**
 * Run cron jobs due. Wrapped in a distributed leader lock so that with N backend nodes a given due
 * event fires on exactly ONE node per tick — otherwise every node would run the same backup / ACME
 * renewal / plugin job (duplicate backups, duplicate Let's Encrypt orders). On SQLite (single host)
 * the lock is a no-op, so single-node behavior is unchanged.
 */
async function runCron() {
    const distLock = require('./dist-lock');
    // Single-runner across nodes. The lease is HEARTBEAT-renewed for the whole run, so a long job
    // (full backup, ACME renewal) is never preempted and can't double-run on another node.
    await distLock.runAsLeader('wordjs:cron', { ttlMs: 90000, renewMs: 30000 }, () => runCronInner());
}

async function runCronInner() {
    const now = Date.now();
    const events = await getOption('cron', {});

    // Defense-in-depth for the 'cron' option (writes are already blocked through the options bridge):
    // if the stored blob is ever poisoned, an event may carry a pluginSlug pointing at another plugin.
    // Resolve the currently-active plugins once; an event whose pluginSlug is set but NOT active is
    // skipped (its code isn't even loaded — running its hooks in a foreign context would be the exploit).
    let activeSet: Set<string> | null;
    try { activeSet = new Set(await require('./plugins').getActivePlugins()); } catch { activeSet = null; }

    // Snapshot timestamps once so we don't iterate over reschedules created in this pass.
    const timestamps = Object.keys(events);
    // Track the (timestamp,key) pairs we executed so we can delete them from the FRESH copy below,
    // and collect reschedules to merge after the loop. We deliberately do NOT write back our stale
    // in-memory `events`: a concurrent scheduleEvent() could land between our read and write and be
    // lost. Instead we re-read fresh at the end and apply only our own deltas.
    const executed: Array<{ timestamp: string; key: string }> = [];
    const reschedules: any[] = [];

    for (const timestamp of timestamps) {
        if (parseInt(timestamp) > now) continue;

        for (const key of Object.keys(events[timestamp])) {
            const event = events[timestamp][key];

            try {
                // SECURITY: a plugin-scheduled event runs ONLY that plugin's own callbacks, in its
                // context — so a plugin cannot schedule a CORE hook with attacker args to trigger core
                // code. Core-scheduled events (no pluginSlug) dispatch normally.
                if (event.pluginSlug) {
                    if (activeSet && !activeSet.has(String(event.pluginSlug))) {
                        // Don't run it (its code isn't loaded) AND remove it from the store — leaving it
                        // would warn + re-skip every tick forever and hold a slot toward MAX_CRON_EVENTS_TOTAL.
                        console.warn(`Cron: removing event '${event.hook}' for unknown/inactive plugin '${event.pluginSlug}'.`);
                        executed.push({ timestamp, key });
                        continue;
                    }
                    await doActionForPlugin(event.hook, event.pluginSlug, ...(event.args || []));
                } else {
                    await doAction(event.hook, ...(event.args || []));
                }
                console.log(`Cron: Executed ${event.hook}`);
            } catch (error) {
                console.error(`Cron error for ${event.hook}:`, error);
            }

            executed.push({ timestamp, key });

            // Reschedule if recurring. Resolve the interval at RUN time from the live schedules map so
            // custom schedules (registered via addSchedule after the event was stored) recur correctly.
            if (event.schedule) {
                const interval = schedules[event.schedule]?.interval;
                if (interval) {
                    const nextTime = now + interval;
                    // Persist the resolved interval so downstream code relying on event.interval stays valid.
                    reschedules.push({ nextTime: String(nextTime), key, event: { ...event, interval } });
                } else if (event.schedule !== 'off') {
                    // 'off' (interval 0) is intentionally non-recurring; anything else with an
                    // unresolvable interval is a misconfiguration worth flagging.
                    console.warn(`Cron: recurring event '${event.hook}' has schedule '${event.schedule}' but no resolvable interval — not rescheduled.`);
                }
            }
        }
    }

    if (executed.length === 0 && reschedules.length === 0) {
        return;
    }

    // Re-read a FRESH copy so concurrent scheduleEvent()/unscheduleEvent() writes aren't clobbered.
    const fresh = await getOption('cron', {});

    // Delete exactly the events we just executed.
    for (const { timestamp, key } of executed) {
        if (fresh[timestamp]) {
            delete fresh[timestamp][key];
            if (Object.keys(fresh[timestamp]).length === 0) {
                delete fresh[timestamp];
            }
        }
    }

    // Merge our reschedules into the fresh copy.
    for (const { nextTime, key, event } of reschedules) {
        if (!fresh[nextTime]) {
            fresh[nextTime] = {};
        }
        fresh[nextTime][key] = event;
    }

    await updateOption('cron', fresh);
}

/**
 * Start cron system
 */
function startCron(intervalMs = 60000) {
    if (cronTimer) {
        clearInterval(cronTimer);
    }

    cronTimer = setInterval(runCron, intervalMs);
    console.log(`   ⏰ Cron started (checking every ${intervalMs / 1000}s)`);

    // Run immediately
    runCron(); // Async call, but we don't await it here to not block startup
}

/**
 * Stop cron system
 */
function stopCron() {
    if (cronTimer) {
        clearInterval(cronTimer);
        cronTimer = null;
    }
}

/**
 * Register a cron job handler
 */
function registerCronJob(name: any, callback: any) {
    cronJobs.set(name, callback);
}

/**
 * When the next backup should run. PURE (takes `now`, touches no DB/clock) so the branch that once
 * shipped a bug is unit-testable. The bug: for `weekly` when today is the target day but the time has
 * already passed, the old code set daysUntilTarget = 7 in a branch whose sibling was the ONLY one that
 * called setDate — so the 7 was never applied and the backup silently stayed on today.
 */
function computeNextBackupRun(frequency: any, time: any, day: any, now: Date): Date {
    const nextRun = new Date(now.getTime());
    let [hours, minutes] = String(time).split(':').map(Number);
    // Guard against malformed/empty backup_time producing NaN -> Invalid Date.
    if (Number.isNaN(hours) || Number.isNaN(minutes)) { hours = 3; minutes = 0; }
    nextRun.setHours(hours, minutes, 0, 0);

    if (frequency === 'weekly') {
        const currentDay = nextRun.getDay(); // 0 = Sunday
        let daysUntilTarget = day - currentDay;
        if (daysUntilTarget < 0) daysUntilTarget += 7;
        // Today is the target day but the time has passed → next week. (=== 0 with time still ahead
        // means keep today.)
        if (daysUntilTarget === 0 && nextRun.getTime() <= now.getTime()) daysUntilTarget = 7;
        // Apply the shift — MUST run for the 7-day case too (that was the bug).
        if (daysUntilTarget > 0) nextRun.setDate(nextRun.getDate() + daysUntilTarget);
    } else if (nextRun.getTime() <= now.getTime()) {
        // Time has passed for today (daily/hourly fallback).
        if (frequency === 'hourly') nextRun.setHours(nextRun.getHours() + 1);
        else nextRun.setDate(nextRun.getDate() + 1); // daily / twicedaily / etc → tomorrow
    }
    return nextRun;
}

/**
 * Reschedule backup job based on frequency
 * ('hourly', 'daily', 'weekly', 'off')
 */
async function rescheduleBackup(frequency?: any) {
    if (!frequency) frequency = await getOption('backup_schedule', 'daily');
    const time = await getOption('backup_time', '00:00'); // Default midnight
    const day = parseInt(await getOption('backup_day', '1')); // Default Monday (1)

    console.log(`⏰ Cron: Rescheduling backup to '${frequency}' at '${time}' (Day: ${day})`);

    // 1. Clear existing generic backup hook
    await clearScheduledHook('wordjs_scheduled_backup');
    // Also clear legacy name if exists (backward compat)
    await clearScheduledHook('wordjs_daily_backup');

    if (frequency === 'off' || !schedules[frequency]) {
        console.log('   Create backup schedule disabled.');
        return;
    }

    // 2. Calculate Start Time — the date math is a PURE helper (computeNextBackupRun) so the
    // reschedule logic can be tested without a DB or a live clock. It had a real bug once (see below).
    const nextRun = computeNextBackupRun(frequency, time, day, new Date());

    await scheduleEvent(nextRun.getTime(), frequency, 'wordjs_scheduled_backup');
    console.log(`   Next backup scheduled: ${nextRun.toISOString()}`);
}

/**
 * Initialize default cron events
 * Now handles async nature
 */
async function initDefaultCronEvents() {
    try {
        // Schedule version check (daily)
        if (!(await nextScheduled('wordjs_version_check'))) {
            await scheduleEvent(Date.now(), 'daily', 'wordjs_version_check');
        }

        // Schedule database maintenance (weekly)
        if (!(await nextScheduled('wordjs_db_maintenance'))) {
            await scheduleEvent(Date.now(), 'weekly', 'wordjs_db_maintenance');
        }

        // Check Backup Schedule preference
        const backupFreq = await getOption('backup_schedule', 'daily');
        if (backupFreq !== 'off') {
            const hasScheduled = await nextScheduled('wordjs_scheduled_backup');
            const hasLegacy = await nextScheduled('wordjs_daily_backup');

            // Migration: If legacy exists but new doesn't, or if nothing exists
            if (!hasScheduled) {
                if (hasLegacy) await clearScheduledHook('wordjs_daily_backup');
                await scheduleEvent(Date.now(), backupFreq, 'wordjs_scheduled_backup');
            }
        }

        // Schedule TLS certificate auto-renewal check. Twice daily is the standard ACME cadence
        // (certbot's default); the handler only renews when the cert is within its renewal window,
        // so this cadence never risks Let's Encrypt rate limits.
        if (!(await nextScheduled('wordjs_cert_renewal'))) {
            await scheduleEvent(Date.now(), 'twicedaily', 'wordjs_cert_renewal');
        }

        // Barrido de salas de edición colaborativa huérfanas (Verso F8). Una sala se retira sola
        // cuando se vacía, pero un nodo que muere de golpe (kill -9, corte de luz) deja su estado de
        // sesión sin retirar y nadie más lo observa. Esto lo recoge por ANTIGÜEDAD, que es lo único
        // fiable en multinodo: un contador cooperativo lo deja mentiroso justo el proceso que muere.
        if (!(await nextScheduled('wordjs_collab_sweep'))) {
            await scheduleEvent(Date.now(), 'hourly', 'wordjs_collab_sweep');
        }
    } catch (e) {
        console.error('Failed to init cron events:', e);
    }

    // Register Actions Implementation

    // 1. Backup Action
    addAction('wordjs_scheduled_backup', async () => {
        const autoBackup = await getOption('auto_backup', 'yes'); // redundancy check
        if (autoBackup === 'yes' || autoBackup === true) {
            console.log('⏰ Running scheduled backup...');
            const { createBackup } = require('./backup');
            try {
                await createBackup();
            } catch (e) {
                console.error('Backup failed:', e);
            }
        }
    });

    // 2b. TLS certificate auto-renewal (ACME / Let's Encrypt). Single backend process => runs once.
    addAction('wordjs_cert_renewal', async () => {
        try {
            const certManager = require('./cert-manager');
            const result = await certManager.renewIfDue();
            if (result && result.ok) {
                console.log(`⏰ ACME: certificate renewed for ${result.domain}`);
            } else if (result && !result.skipped) {
                console.warn(`⏰ ACME: renewal not completed: ${result.error || 'unknown error'}`);
            }
        } catch (e) {
            console.error('ACME auto-renewal error:', e);
        }
    });

    // 2c. Salas colaborativas huérfanas: se retira SOLO estado de sesión (`collab_docs`/`collab_ops`),
    // nunca contenido — el `_puck_data` del post lo escribe el editor por su ruta de siempre.
    addAction('wordjs_collab_sweep', async () => {
        try {
            const retired = await require('./collab-rooms').sweepIdleRooms();
            if (retired > 0) console.log(`⏰ colaboración: ${retired} sala(s) inactiva(s) retirada(s)`);
        } catch (e) {
            console.error('Barrido de salas colaborativas fallido:', e);
        }
    });

    // 3. React to Option Updates
    addAction('updated_option', async (name: any, value: any) => {
        if (name === 'backup_schedule') {
            await rescheduleBackup(value);
        }
        if (name === 'backup_time' || name === 'backup_day') {
            await rescheduleBackup();
        }
    });
}

module.exports = {
    addSchedule,
    getSchedules,
    scheduleEvent, // Exposed API
    scheduleSingleEvent, // Exposed API
    unscheduleEvent, // Exposed API
    clearScheduledHook, // Exposed API
    nextScheduled,
    runCron,
    startCron,
    stopCron,
    registerCronJob,
    initDefaultCronEvents,
    computeNextBackupRun, // pure; exported for the reschedule regression test
};
