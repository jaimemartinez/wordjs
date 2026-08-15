/**
 * computeNextBackupRun — the pure date math behind the weekly/daily backup reschedule.
 *
 * Pins the bug the audit found: for `weekly`, when today IS the target day but the time has already
 * passed, the reschedule must move a full week out. The old code set daysUntilTarget = 7 in a branch
 * that never called setDate, so the backup silently stayed on today (in the past). A fixed `now` makes
 * this deterministic — no DB, no live clock.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { computeNextBackupRun } = require('../core/cron');

// A Wednesday. getDay() === 3.
const WED_NOON = new Date('2026-08-19T12:00:00');
const dayOf = (d: Date) => d.getDay();
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86400000);

test('weekly, target day is TODAY and the time has passed → next week, not today', () => {
    // now = Wed 12:00; target day = Wed (3); backup_time 09:00 already passed.
    const next = computeNextBackupRun('weekly', '09:00', dayOf(WED_NOON), WED_NOON);
    assert.strictEqual(dayOf(next), dayOf(WED_NOON), 'same weekday');
    assert.strictEqual(daysBetween(WED_NOON, next), 7, 'moved a full week out, not left in the past');
    assert.ok(next.getTime() > WED_NOON.getTime(), 'must be in the FUTURE');
});

test('weekly, target day is TODAY and the time is still ahead → keep today', () => {
    const next = computeNextBackupRun('weekly', '18:00', dayOf(WED_NOON), WED_NOON);
    assert.strictEqual(daysBetween(WED_NOON, next), 0, 'stays today');
    assert.strictEqual(next.getHours(), 18);
});

test('weekly, target day later this week → this week', () => {
    // target Friday (5), now Wed → +2 days.
    const next = computeNextBackupRun('weekly', '09:00', 5, WED_NOON);
    assert.strictEqual(daysBetween(WED_NOON, next), 2);
    assert.strictEqual(dayOf(next), 5);
});

test('weekly, target day earlier this week → wraps to next week', () => {
    // target Monday (1), now Wed (3) → -2 → +7 = +5 days.
    const next = computeNextBackupRun('weekly', '09:00', 1, WED_NOON);
    assert.strictEqual(daysBetween(WED_NOON, next), 5);
    assert.strictEqual(dayOf(next), 1);
});

test('daily, time passed today → tomorrow; time ahead → today', () => {
    assert.strictEqual(daysBetween(WED_NOON, computeNextBackupRun('daily', '09:00', 1, WED_NOON)), 1);
    assert.strictEqual(daysBetween(WED_NOON, computeNextBackupRun('daily', '18:00', 1, WED_NOON)), 0);
});

test('malformed backup_time falls back to 03:00', () => {
    const next = computeNextBackupRun('daily', 'not-a-time', 1, WED_NOON);
    assert.strictEqual(next.getHours(), 3);
    assert.strictEqual(next.getMinutes(), 0);
});
