/**
 * The backend coverage ratchet must have room for the instrumented suite it runs, and must stay as
 * strict when the suite is sharded as it was when one job ran it whole.
 *
 * Its ceiling was 30 minutes, measured when the instrumented suite took ~15. After the 2.4.0 security
 * round the suite holds about 4,100 tests: on 2026-10-12 successful runs of the job took 20-28 minutes,
 * and nine runs were cancelled at the 30-minute wall while the suite was still passing, so every push to
 * main showed a red CI. The ceiling went to 45; on 2026-10-15 the suite was split across four
 * `backend-coverage-shard` legs that upload raw V8 profiles, and `backend-coverage` merges them and
 * applies the floor with `c8 report`. That split is only sound while (a) the report applies exactly the
 * options of `test:coverage:check`, (b) the coverage shards cover the same quarters as the unit-suite
 * shards, and (c) each shard still has a ceiling above its share of the measured worst case.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const CI = path.resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'ci.yml');
const PKG = path.resolve(__dirname, '..', '..', 'package.json');

function job(id: string): string {
    const source = fs.readFileSync(CI, 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf(`\n  ${id}:\n`);
    assert.ok(start >= 0, `ci.yml has no ${id} job`);
    const next = source.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
    return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

function timeoutOf(id: string): number {
    const minutes = Number((/\n {4}timeout-minutes: (\d+)/.exec(job(id)) || [])[1]);
    assert.ok(Number.isFinite(minutes) && minutes > 0, `the ${id} job carries no timeout-minutes`);
    return minutes;
}

function shardsOf(id: string): string {
    const shards = (/\n {8}shard: (\[[^\]]*\])/.exec(job(id)) || [])[1];
    assert.ok(shards, `the ${id} job has no shard matrix`);
    return shards;
}

test('each coverage shard timeout covers its share of the measured instrumented suite with margin', () => {
    const minutes = timeoutOf('backend-coverage-shard');
    assert.ok(minutes >= 20, `backend-coverage-shard timeout-minutes is ${minutes}; a cold install is ~9 min and shards split by file count, not time`);
    assert.ok(minutes <= 60, `backend-coverage-shard timeout-minutes is ${minutes}; a hang must still turn red within the hour`);
});

test('the coverage shards run the same quarters as the unit-suite shards', () => {
    assert.strictEqual(shardsOf('backend-coverage-shard'), shardsOf('backend-test'));
    for (const id of ['backend-test', 'backend-coverage-shard']) {
        assert.match(job(id), /run: npm test -- --test-shard=\$\{\{ matrix\.shard \}\}\/4\n/, `${id} does not run its shard of npm test`);
    }
    assert.match(shardsOf('backend-test'), /^\[1, 2, 3, 4\]$/, 'the shard matrix must list 1..4 to match the /4 denominator');
});

test('the merged report applies exactly the ratchet of test:coverage:check', () => {
    const scripts = JSON.parse(fs.readFileSync(PKG, 'utf8')).scripts as Record<string, string>;
    const check = scripts['test:coverage:check'];
    const report = scripts['test:coverage:report'];
    assert.ok(check && report, 'both test:coverage:check and test:coverage:report must exist');
    assert.strictEqual(
        report.replace(/^c8 report /, 'c8 '),
        check.replace(/ npm test$/, ''),
        'test:coverage:report must be `c8 report` with the same thresholds, --all/--src and excludes as test:coverage:check',
    );
    assert.match(job('backend-coverage'), /run: npm run test:coverage:report\n/, 'backend-coverage no longer applies the ratchet');
});

test('the aggregate jobs cannot be skipped into a pass', () => {
    for (const id of ['backend', 'backend-coverage']) {
        assert.match(job(id), /\n {4}if: always\(\)\n/, `${id} must run even when a dependency failed — a skipped required check counts as passing`);
        assert.match(job(id), /!= "success"/, `${id} must fail unless every job it needs succeeded`);
    }
    assert.match(job('backend'), /\n {4}name: Backend \(typecheck \+ test\)\n/, 'branch protection requires this exact check name');
    assert.match(job('backend-coverage'), /\n {4}name: Backend coverage \(c8 ratchet\)\n/);
});
