/**
 * The backend coverage job must have room for the instrumented suite it runs.
 *
 * Its ceiling was 30 minutes, measured when the instrumented suite took ~15. After the 2.4.0 security
 * round the suite holds about 4,100 tests: on 2026-10-12 successful runs of the job took 20-28 minutes,
 * and nine runs were cancelled at the 30-minute wall while the suite was still passing, so every push to
 * main showed a red CI. This pins a ceiling above the measured worst case.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const CI = path.resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'ci.yml');

function coverageJob(): string {
    const source = fs.readFileSync(CI, 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('\n  backend-coverage:\n');
    assert.ok(start >= 0, 'ci.yml has no backend-coverage job');
    const next = source.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
    return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

test('the coverage job timeout covers the measured instrumented suite with margin', () => {
    const minutes = Number((/\n {4}timeout-minutes: (\d+)/.exec(coverageJob()) || [])[1]);
    assert.ok(Number.isFinite(minutes) && minutes > 0, 'the backend-coverage job carries no timeout-minutes');
    assert.ok(minutes >= 40, `backend-coverage timeout-minutes is ${minutes}; whole runs took up to 28 minutes and were cancelled at 30`);
    assert.ok(minutes <= 60, `backend-coverage timeout-minutes is ${minutes}; a hang must still turn red within the hour`);
});
