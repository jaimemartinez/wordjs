/**
 * WordJS - Cron System
 * Equivalent to wp-cron.php
 */

const { getOption, updateOption } = require('./options');
const { doAction, addAction } = require('./hooks');

// Registered cron jobs
const cronJobs = new Map();

// Cron schedules
const schedules = {
    hourly: { interval: 3600000, display: 'Once Hourly' },
    twicedaily: { interval: 43200000, display: 'Twice Daily' },
    daily: { interval: 86400000, display: 'Once Daily' },
    weekly: { interval: 604800000, display: 'Once Weekly' },
    off: { interval: 0, display: 'Disabled' }
};

// Cron timer
let cronTimer = null;

/**
 * Register a cron schedule
 */
function addSchedule(name, interval, display) {
    schedules[name] = { interval, display };
}

/**
 * Get all schedules
 */
function getSchedules() {
    return { ...schedules };
}

/**
 * Schedule an event (Async)
 * Equivalent to wp_schedule_event()
 */
async function scheduleEvent(timestamp, recurrence, hook, args = []) {
    const events = await getOption('cron', {});

    if (!events[timestamp]) {
        events[timestamp] = {};
    }

    const key = `${hook}_${JSON.stringify(args)}`;
    events[timestamp][key] = {
        hook,
        args,
        schedule: recurrence,
        interval: schedules[recurrence]?.interval || 0
    };

    await updateOption('cron', events);
    return true;
}

/**
 * Schedule a single event (Async)
 * Equivalent to wp_schedule_single_event()
 */
async function scheduleSingleEvent(timestamp, hook, args = []) {
    const events = await getOption('cron', {});

    if (!events[timestamp]) {
        events[timestamp] = {};
    }

    const key = `${hook}_${JSON.stringify(args)}`;
    events[timestamp][key] = {
        hook,
        args,
        schedule: false
    };

    await updateOption('cron', events);
    return true;
}

/**
 * Unschedule an event (Async)
 * Equivalent to wp_unschedule_event()
 */
async function unscheduleEvent(timestamp, hook, args = []) {
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
async function clearScheduledHook(hook, args = null) {
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
async function nextScheduled(hook, args = []) {
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
 * Run cron jobs due
 */
async function runCron() {
    const now = Date.now();
    const events = await getOption('cron', {});
    let updated = false;

    for (const timestamp of Object.keys(events)) {
        if (parseInt(timestamp) > now) continue;

        for (const key of Object.keys(events[timestamp])) {
            const event = events[timestamp][key];

            try {
                // Run the hook
                // Note: We use execute the action but don't await fully if we want parallel?
                // Standard WP Cron is sequential per request usually. Let's await for safety.
                await doAction(event.hook, ...event.args);
                console.log(`Cron: Executed ${event.hook}`);
            } catch (error) {
                console.error(`Cron error for ${event.hook}:`, error);
            }

            // Reschedule if recurring
            if (event.schedule && event.interval) {
                const nextTime = now + event.interval;

                if (!events[nextTime]) {
                    events[nextTime] = {};
                }

                events[nextTime][key] = event;
            }

            // Remove executed event (or moved event)
            delete events[timestamp][key];
            updated = true;
        }

        if (Object.keys(events[timestamp]).length === 0) {
            delete events[timestamp];
        }
    }

    if (updated) {
        await updateOption('cron', events);
    }
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
function registerCronJob(name, callback) {
    cronJobs.set(name, callback);
}

/**
 * Reschedule backup job based on frequency
 * ('hourly', 'daily', 'weekly', 'off')
 */
async function rescheduleBackup(frequency) {
    console.log(`⏰ Cron: Rescheduling backup to '${frequency}'`);

    // 1. Clear existing generic backup hook
    await clearScheduledHook('wordjs_scheduled_backup');
    // Also clear legacy name if exists (backward compat)
    await clearScheduledHook('wordjs_daily_backup');

    if (frequency === 'off' || !schedules[frequency]) {
        console.log('   Create backup schedule disabled.');
        return;
    }

    // 2. Schedule new
    await scheduleEvent(Date.now(), frequency, 'wordjs_scheduled_backup');
    console.log(`   Next backup scheduled: Now + ${frequency}`);
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

    // 2. React to Option Updates
    addAction('updated_option', async (name, value) => {
        if (name === 'backup_schedule') {
            await rescheduleBackup(value);
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
    initDefaultCronEvents
};
