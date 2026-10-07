/**
 * The Verso E2E job's Playwright install must be able to RETRY.
 *
 * `timeout 5m npx playwright install --with-deps chromium || <same again>` looked like a retry, but
 * `timeout` kills `npx`, not the root `apt-get` Playwright starts through sudo. When the runner's first
 * apt mirror (azure.archive.ubuntu.com) stalled, the first attempt was killed mid-`apt-get update`, the
 * orphan kept /var/lib/apt/lists/lock, and the "retry" failed at once with "Could not get lock … held by
 * process … (apt-get)" — twice on one pull request on 2026-10-07, failing a required check on a runner
 * fault. These assertions keep the two things that make the retry real: apt fails over quickly instead
 * of waiting out its default per-index timeout, and nothing retries while apt still holds the lock.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const CI = path.resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'ci.yml');

/** The verso-e2e job's text and its Playwright install step's `run:` text (line endings normalised). */
function e2eJob(): { job: string; step: string } {
    const source = fs.readFileSync(CI, 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('\n  verso-e2e:\n');
    assert.ok(start >= 0, 'ci.yml has no verso-e2e job');
    const next = source.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
    const job = next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
    const stepStart = job.indexOf('- name: Install Playwright chromium');
    assert.ok(stepStart >= 0, 'the verso-e2e job no longer installs Playwright under the expected step name');
    const rest = job.slice(stepStart + 1);
    const stepEnd = rest.search(/\n {6}- (name|uses):/);
    return { job, step: stepEnd < 0 ? rest : rest.slice(0, stepEnd) };
}

test('a second Playwright install attempt waits for apt to release its lock first', () => {
    const { step } = e2eJob();
    const attempts = [...step.matchAll(/npx playwright install --with-deps chromium/g)].map((m) => m.index as number);
    assert.ok(attempts.length >= 2, 'the step no longer retries the install at all');
    const wait = step.search(/pgrep -x apt-get/);
    assert.ok(wait >= 0, 'nothing waits for an orphaned apt-get before the retry — the retry fails on the apt lock');
    assert.ok(wait > attempts[0] || /apt_idle\(\)/.test(step), 'the apt wait must sit between the attempts');
    const callBeforeRetry = step.lastIndexOf('apt_idle', attempts[attempts.length - 1]);
    assert.ok(callBeforeRetry > attempts[0], 'the last install attempt is not preceded by the bounded wait for apt');
});

test('apt fails over from a stalled mirror in seconds, not by waiting out its default timeout', () => {
    const { step } = e2eJob();
    assert.match(step, /Acquire::http::Timeout "\d+"/);
    assert.match(step, /Acquire::https::Timeout "\d+"/);
    assert.match(step, /Acquire::Retries "\d+"/);
});

test('the job timeout leaves room for both attempts and the bounded wait', () => {
    const { job } = e2eJob();
    const minutes = Number((/\n {4}timeout-minutes: (\d+)/.exec(job) || [])[1]);
    // Two 5-minute attempts plus a 5-minute wait is 15 minutes before the workspaces, the browser and
    // the suite: a ceiling at 15 would cancel exactly the runs the retry exists to save.
    assert.ok(minutes >= 20, `verso-e2e timeout-minutes is ${minutes}; it must cover the install retry path`);
});
