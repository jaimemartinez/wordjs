/**
 * WordJS - Cron System
 * Equivalent to wp-cron.php
 */

const { getOption, updateOption } = require('./options');
const { doAction } = require('./hooks');

// Registered cron jobs
const cronJobs = new Map();

// Cron schedules
const schedules = {
    hourly: { interval: 3600000, display: 'Once Hourly' },
    twicedaily: { interval: 43200000, display: 'Twice Daily' },
    daily: { interval: 86400000, display: 'Once Daily' },
    weekly: { interval: 604800000, display: 'Once Weekly' }
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
 * Schedule an event
 * Equivalent to wp_schedule_event()
 */
function scheduleEvent(timestamp, recurrence, hook, args = []) {
    const events = getOption('cron', {});

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

    updateOption('cron', events);
    return true;
}

/**
 * Schedule a single event
 * Equivalent to wp_schedule_single_event()
 */
function scheduleSingleEvent(timestamp, hook, args = []) {
    const events = getOption('cron', {});

    if (!events[timestamp]) {
        events[timestamp] = {};
    }

    const key = `${hook}_${JSON.stringify(args)}`;
    events[timestamp][key] = {
        hook,
        args,
        schedule: false
    };

    updateOption('cron', events);
    return true;
}

/**
 * Unschedule an event
 * Equivalent to wp_unschedule_event()
 */
function unscheduleEvent(timestamp, hook, args = []) {
    const events = getOption('cron', {});
    const key = `${hook}_${JSON.stringify(args)}`;

    if (events[timestamp] && events[timestamp][key]) {
        delete events[timestamp][key];

        if (Object.keys(events[timestamp]).length === 0) {
            delete events[timestamp];
        }

        updateOption('cron', events);
        return true;
    }

    return false;
}

/**
 * Clear all scheduled hooks
 * Equivalent to wp_clear_scheduled_hook()
 */
function clearScheduledHook(hook, args = null) {
    const events = getOption('cron', {});
    let cleared = false;

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
        updateOption('cron', events);
    }

    return cleared;
}

/**
 * Get next scheduled time for a hook
 * Equivalent to wp_next_scheduled()
 */
function nextScheduled(hook, args = []) {
    const events = getOption('cron', {});
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
    const events = getOption('cron', {});
    let updated = false;

    for (const timestamp of Object.keys(events)) {
        if (parseInt(timestamp) > now) continue;

        for (const key of Object.keys(events[timestamp])) {
            const event = events[timestamp][key];

            try {
                // Run the hook
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

            // Remove executed event
            delete events[timestamp][key];
            updated = true;
        }

        if (Object.keys(events[timestamp]).length === 0) {
            delete events[timestamp];
        }
    }

    if (updated) {
        updateOption('cron', events);
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
    runCron();
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
 * Initialize default cron events
 */
function initDefaultCronEvents() {
    // Schedule version check (daily)
    if (!nextScheduled('wordjs_version_check')) {
        scheduleEvent(Date.now(), 'daily', 'wordjs_version_check');
    }

    // Schedule database maintenance (weekly)
    if (!nextScheduled('wordjs_db_maintenance')) {
        scheduleEvent(Date.now(), 'weekly', 'wordjs_db_maintenance');
    }
}

module.exports = {
    addSchedule,
    getSchedules,
    scheduleEvent,
    scheduleSingleEvent,
    unscheduleEvent,
    clearScheduledHook,
    nextScheduled,
    runCron,
    startCron,
    stopCron,
    registerCronJob,
    initDefaultCronEvents
};
