/**
 * F6 — the performance budget that "no regression beyond the budget defined in F0" is measured against.
 *
 * WHAT WAS MISSING. F0 shipped `backend/f0-performance-budgets.json` with five ABSOLUTE p95 ceilings in
 * milliseconds, and `scripts/f0-content-bench.ts --enforce` compares against them. Two defects made that
 * unusable as an F6 certification leg:
 *
 *   1. A millisecond is a property of the MACHINE, not of the code. `postCreateP95: 20` is roughly 3x the
 *      p95 this laptop measures (7 ms), so a change that made content creation two and a half times
 *      slower would still pass here — while the same 20 ms ceiling is a couple of bad neighbours away
 *      from flapping on a shared CI runner. A ceiling that is simultaneously too loose to catch a real
 *      regression and too tight to survive a noisy host is what gets a gate disabled in its first bad week.
 *   2. `f0-content-bench.ts --enforce` iterates the BUDGET table (`Object.entries(budgets.contentMilliseconds)`)
 *      and looks each name up in the measurements. That direction catches a deleted measurement. It does
 *      NOT catch an ADDED one: a new content operation that nobody wrote a ceiling for is measured,
 *      printed, and silently unenforced. The rendering operation the F6 plan names is exactly that case —
 *      it has no entry in `contentMilliseconds` at all, so today it is unbudgeted.
 *
 * WHAT THIS FILE ENFORCES. The four operations the F6 plan names — creation, update, query, render — are
 * measured against a REFERENCE workload executed in the SAME process, on the SAME driver, in the same
 * run: ten single-row inserts through the active driver. The budget is the RATIO. A slower host inflates
 * numerator and denominator together, so the ratio survives being moved between machines; a regression in
 * the content path moves the numerator alone, so the ratio rises. Absolute ceilings are kept as a
 * secondary catastrophe check only, and are deliberately generous — see `maximumMillisecondsP95`.
 *
 * The budget lives in `backend/f0-baseline.json` under `performanceBudget`, next to the structural F0
 * snapshot, and is gated structurally by `backend/scripts/verify-f0-baseline.ts`. The evidence that the
 * gate is not inert lives here: every check below has a negative control that proves the evaluator turns
 * RED, so "the budget passed" cannot mean "the budget was never evaluated".
 *
 * CALIBRATION — ONE PER PLATFORM. A ratio survives moving between runs on one host; it does not survive
 * moving between hosts, because the denominator is ten AUTOCOMMIT inserts (it moves with what a
 * durability flush costs on the host filesystem) while two of the numerators are mostly CPU. The first
 * budget was minted on one Windows laptop and judged on the Linux runners too, and it flapped exactly
 * there: the Linux reference is ~0.22 ms against Windows' ~0.37 ms, so contentRender — ~0.03 ms a call,
 * the noisiest operation — read 0.183x on main and 0.187x on a pull request against a 0.18x ceiling, on
 * code that had not changed, and reached 0.216x across 104 rounds the CI perf job had recorded.
 *
 * So the observations and ratio ceilings live in `performanceBudget.calibrations.<process.platform>`,
 * each with its own `measuredOn` (how many rounds, which factor). `observedRatioToReference` is the WORST
 * round of that calibration and the ceiling sits at `ceilingFactor` times it, so on a platform the gate
 * trips somewhere between a ceilingFactor regression (measured on a bad run) and ceilingFactor times the
 * recorded run-to-run spread (measured on a good run). That is the class it exists to catch — an N+1
 * query, a lost index, a second sanitisation pass, a synchronous flush. It does not catch 20%, and
 * pretending otherwise on a shared runner buys false failures rather than information.
 *
 * A platform with NO calibration does not borrow another platform's ceilings — that was the defect. Its
 * ratio comparison is reported as SKIPPED with the reason, while everything that is not host-relative
 * (the absolute catastrophe ceilings, the denominator bounds, the operation sets) is still enforced.
 * verify-f0-baseline.ts requires a linux calibration, because every CI job that runs this file runs there.
 *
 * The choice of denominator was measured, not assumed: three candidates (one INSERT+SELECT round trip,
 * fifty SELECT 1 round trips, ten batched INSERTs) were timed side by side in the same runs, and the
 * ten-insert batch gave the tightest run-to-run ratios. See performanceBudget.reference.why.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { pathToFileURL } = require('url');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const baseline = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, 'f0-baseline.json'), 'utf8'));
const budget = baseline.performanceBudget;

/** The calibration a platform is judged by — exact key, never another platform's as a fallback. */
function calibrationFor(spec: any, platform: string): any {
    const calibrations = spec && spec.calibrations;
    if (!calibrations || typeof calibrations !== 'object') return null;
    if (!Object.prototype.hasOwnProperty.call(calibrations, platform)) return null;
    return calibrations[platform] || null;
}
const PLATFORM = process.platform;
const calibration = calibrationFor(budget, PLATFORM);

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_DB = path.join(os.tmpdir(), `wjs-f6-perf-${STAMP}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const postTypes = require('../core/post-types');
const Post = require('../models/Post');

/**
 * The four operations the F6 plan names, and the call each one actually exercises.
 *
 * THIS MAP IS THE MEMBER LIST THE GATE IS BUILT AROUND. Adding an entry here without adding the matching
 * entry to `performanceBudget.operations` in f0-baseline.json turns this file RED — that is the property
 * the F0 bench lacked, and `unbudgeted measurements are a failure, not a silent pass` below is the proof.
 */
type BenchContext = {
    db: any;
    created: any[];
    hydrated: any[];
    makePost: () => Promise<any>;
};

const OPERATIONS: Record<string, { planOperation: string; callSite: string; run: (ctx: BenchContext, index: number) => Promise<void> }> = {
    contentCreate: {
        planOperation: 'creation',
        callSite: 'Post.create',
        run: async (ctx) => { ctx.created.push(await ctx.makePost()); },
    },
    contentUpdate: {
        planOperation: 'update',
        callSite: 'Post.update',
        run: async (ctx, i) => { await Post.update(ctx.created[i % ctx.created.length].id, { excerpt: `f6 update ${i}` }); },
    },
    contentQuery: {
        planOperation: 'query',
        callSite: 'Post.findAllWithRelations',
        run: async () => { await Post.findAllWithRelations({ limit: 10, status: 'draft' }); },
    },
    contentRender: {
        // The backend's render step: a hydrated post turned into its public representation — shortcode
        // expansion, excerpt generation, permalink, translations, featured media. It is measured over
        // ALREADY hydrated instances on purpose, so this number is the rendering work and not a second
        // copy of contentQuery's database time.
        planOperation: 'render',
        callSite: 'Post#toJSON',
        run: async (ctx, i) => { await ctx.hydrated[i % ctx.hydrated.length].toJSON(); },
    },
};

/** The reference workload: the denominator every ratio is expressed in. */
async function referenceWorkload(ctx: BenchContext): Promise<void> {
    for (let i = 0; i < 10; i++) await ctx.db.run('INSERT INTO f6_perf_reference (v) VALUES (?)', ['r']);
}

const OP_SAMPLES = Number(budget.methodology.operationSamples);
const REFERENCE_SAMPLES = Number(budget.methodology.referenceSamples);
const WARMUPS = Number(budget.methodology.warmupIterations);
const TRIM = Number(budget.methodology.trimFraction);

function trimmedMean(values: number[], trim: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const drop = Math.floor(sorted.length * trim);
    const kept = sorted.slice(drop, sorted.length - drop);
    return kept.reduce((a, b) => a + b, 0) / kept.length;
}

function percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function sample(iterations: number, fn: (index: number) => Promise<void>): Promise<number[]> {
    const values: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await fn(i);
        values.push(performance.now() - start);
    }
    return values;
}

type Measurement = { trimmedMeanMilliseconds: number; p95Milliseconds: number; ratioToReference: number };
type Run = { reference: { trimmedMeanMilliseconds: number }; operations: Record<string, Measurement> };

/**
 * THE EVALUATOR — pure, so the negative controls below can drive it with synthetic numbers instead of
 * hoping a real regression shows up during a test run.
 *
 * It walks the MEASURED set and the BUDGET set in both directions. A measurement with no ceiling is a
 * failure ("unbudgeted"); a ceiling with no measurement is a failure ("unmeasured"). Neither is a skip.
 *
 * `platformCalibration` is the ratio half. Passed as null it means "this platform is uncalibrated": the
 * ratios are then not compared at all (the caller reports that as a SKIP with its reason), while the
 * absolute ceilings, the denominator bounds and both set directions are still evaluated. Passed as an
 * object, an operation it has no ratio for is a failure — a calibration that forgot an operation must
 * not read as "inside the budget".
 */
function evaluateRun(run: Run, spec: any, platformCalibration: any, platform: string = PLATFORM): string[] {
    const failures: string[] = [];
    const reference = run.reference.trimmedMeanMilliseconds;

    if (!Number.isFinite(reference) || reference <= 0) {
        failures.push(`reference workload produced no usable timing (${reference}ms)`);
        return failures;
    }
    // The denominator is load-bearing: if the reference itself becomes cheap (a driver that stopped
    // durably writing) every ratio collapses and the gate would pass everything. If it becomes absurdly
    // expensive, every ratio deflates and the gate would pass everything again. Both directions are
    // failures with their own message rather than four confusing operation failures.
    if (reference < Number(spec.reference.minimumMillisecondsTrimmedMean)) {
        failures.push(`reference workload ${reference.toFixed(4)}ms is below the ${spec.reference.minimumMillisecondsTrimmedMean}ms floor — the denominator stopped doing work, so every ratio below is meaningless`);
    }
    if (reference > Number(spec.reference.maximumMillisecondsTrimmedMean)) {
        failures.push(`reference workload ${reference.toFixed(4)}ms exceeds the ${spec.reference.maximumMillisecondsTrimmedMean}ms ceiling — the driver write path itself regressed, which would deflate every ratio below`);
    }

    for (const [id, measured] of Object.entries(run.operations)) {
        const ceiling = spec.operations[id];
        if (!ceiling) {
            failures.push(`${id}: measured but has no committed budget — add it to performanceBudget.operations in backend/f0-baseline.json`);
            continue;
        }
        if (platformCalibration) {
            const calibrated = platformCalibration.operations ? platformCalibration.operations[id] : undefined;
            if (!calibrated) {
                failures.push(`${id}: budgeted, but the ${platform} calibration has no ratio ceiling for it`);
            } else if (!(measured.ratioToReference <= Number(calibrated.maximumRatioToReference))) {
                // `!(x <= ceiling)` rather than `x > ceiling`: a NaN ratio or a non-numeric ceiling is a
                // failure, not a comparison that quietly comes out false.
                failures.push(`${id}: ratio ${measured.ratioToReference.toFixed(3)}x reference > ${calibrated.maximumRatioToReference}x ${platform} budget (recorded ${platform} observation ${calibrated.observedRatioToReference}x)`);
            }
        }
        if (measured.p95Milliseconds > Number(ceiling.maximumMillisecondsP95)) {
            failures.push(`${id}: p95 ${measured.p95Milliseconds.toFixed(3)}ms > ${ceiling.maximumMillisecondsP95}ms absolute ceiling`);
        }
    }
    for (const id of Object.keys(spec.operations)) {
        if (!run.operations[id]) failures.push(`${id}: has a committed budget but was not measured — the harness stopped exercising it`);
    }
    return failures;
}

/** Why the ratio comparison does not run on this platform, or false when it does. */
const UNCALIBRATED_SKIP: string | false = calibration
    ? false
    : `no ${PLATFORM} calibration in performanceBudget.calibrations (has ${JSON.stringify(Object.keys((budget && budget.calibrations) || {}))}) — ratios measured here have no ceiling of their own, and borrowing another platform's is the defect this replaced. Mint one with: node backend/scripts/perf-calibrate.mjs --calibrate`;

/**
 * THE REGRESSION. Two Backend-job runs on ubuntu-latest, both on code whose content path had not
 * changed, went red against the Windows-minted ceilings: main at CI run 37563029800 (contentQuery
 * 1.768x > 1.72x, contentRender 0.183x > 0.18x) and pull request #402 at CI run 37649391605
 * (contentRender 0.187x > 0.18x). These are their `measured:` lines, verbatim. Judged by the
 * platform they were measured on they are ordinary runs; judged by the other one they are not.
 */
const RED_ON_NOISE_LINUX: Run[] = [
    { reference: { trimmedMeanMilliseconds: 0.242 }, operations: { contentCreate: { trimmedMeanMilliseconds: 1.5328, p95Milliseconds: 2.2121, ratioToReference: 6.333 }, contentUpdate: { trimmedMeanMilliseconds: 1.3422, p95Milliseconds: 1.9655, ratioToReference: 5.546 }, contentQuery: { trimmedMeanMilliseconds: 0.4279, p95Milliseconds: 0.5486, ratioToReference: 1.768 }, contentRender: { trimmedMeanMilliseconds: 0.0443, p95Milliseconds: 0.0747, ratioToReference: 0.183 } } },
    { reference: { trimmedMeanMilliseconds: 0.2236 }, operations: { contentCreate: { trimmedMeanMilliseconds: 1.4397, p95Milliseconds: 2.0544, ratioToReference: 6.438 }, contentUpdate: { trimmedMeanMilliseconds: 1.2036, p95Milliseconds: 1.3478, ratioToReference: 5.382 }, contentQuery: { trimmedMeanMilliseconds: 0.2959, p95Milliseconds: 0.5318, ratioToReference: 1.323 }, contentRender: { trimmedMeanMilliseconds: 0.0419, p95Milliseconds: 0.0746, ratioToReference: 0.187 } } },
];

/** One recorded red-on-noise Linux run with every ratio scaled — a synthetic round of the producer's shape. */
function RED_ON_NOISE_LINUX_FIXTURE(scale: number): Run {
    const scaled: Run = JSON.parse(JSON.stringify(RED_ON_NOISE_LINUX[1]));
    for (const measured of Object.values(scaled.operations)) {
        measured.ratioToReference = Number((measured.ratioToReference * scale).toFixed(3));
        measured.trimmedMeanMilliseconds = Number((measured.trimmedMeanMilliseconds * scale).toFixed(4));
    }
    return scaled;
}

let run: Run;
let measurementError: Error | null = null;

describe('F6 performance budget — the four plan operations, measured as a ratio to a same-run reference', () => {
    before(async () => {
        try {
            await database.init({ driver: 'sqlite-native' });
            await database.initializeDatabase();
            await postTypes.initPostTypes();
            const db = database.getDbAsync();
            await db.run('CREATE TABLE IF NOT EXISTS f6_perf_reference (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');

            let sequence = 0;
            const ctx: BenchContext = {
                db,
                created: [],
                hydrated: [],
                makePost: async () => await Post.create({
                    authorId: 0,
                    title: `f6 perf ${STAMP} ${++sequence}`,
                    content: '<p>F6 budget body</p>[column width="50%"]inner[/column]',
                    status: 'draft',
                }),
            };

            // Warm every path once so the measurement is steady state: prepared statements, the schema
            // cache, the post-type registry and V8's inline caches all pay a one-off cost that would
            // otherwise land in the first samples and dominate the trimmed mean.
            for (let i = 0; i < WARMUPS; i++) {
                const post = await ctx.makePost();
                await Post.update(post.id, { excerpt: `warm ${i}` });
                await Post.findAllWithRelations({ limit: 10, status: 'draft' });
                await referenceWorkload(ctx);
            }
            ctx.created.push(...(await Post.findAllWithRelations({ limit: 10, status: 'draft' })));
            ctx.hydrated.push(...ctx.created);
            for (const post of ctx.hydrated) await post.toJSON();

            const referenceSamples = await sample(REFERENCE_SAMPLES, async () => { await referenceWorkload(ctx); });
            const reference = trimmedMean(referenceSamples, TRIM);

            const operations: Record<string, Measurement> = {};
            for (const [id, operation] of Object.entries(OPERATIONS)) {
                const values = await sample(OP_SAMPLES, (i) => operation.run(ctx, i));
                operations[id] = {
                    trimmedMeanMilliseconds: Number(trimmedMean(values, TRIM).toFixed(4)),
                    p95Milliseconds: Number(percentile(values, 95).toFixed(4)),
                    ratioToReference: Number((trimmedMean(values, TRIM) / reference).toFixed(3)),
                };
            }
            run = { reference: { trimmedMeanMilliseconds: Number(reference.toFixed(4)) }, operations };
            if (process.env.WORDJS_F6_PERF_PRINT) process.stdout.write(`${JSON.stringify(run)}\n`);
        } catch (error: any) {
            // A measurement that could not run is NOT a pass. Recorded here and re-thrown by the first
            // test, because a `before` hook that throws in node:test reports as an unrelated hook error
            // and has, in this repository's history, been read as "the suite is fine".
            measurementError = error;
        }
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* best effort */ }
        for (const file of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try { if (fs.existsSync(file)) fs.rmSync(file, { force: true }); } catch { /* best effort */ }
        }
    });

    test('the measurement itself ran', () => {
        if (measurementError) throw measurementError;
        assert.ok(run, 'no measurement was produced');
        assert.ok(run.reference.trimmedMeanMilliseconds > 0, 'reference workload produced no timing');
    });

    test('every measured operation has a committed budget and every budget names a measured operation', () => {
        const measured = Object.keys(OPERATIONS).sort();
        const budgeted = Object.keys(budget.operations).sort();
        assert.deepStrictEqual(measured, budgeted,
            'the operation map and performanceBudget.operations drifted apart — an operation measured without a ceiling is unenforced, and a ceiling with no measurement is dead');
    });

    test('the four operations the F6 plan names are each covered exactly once', () => {
        const plan = budget.methodology.planOperations.slice().sort();
        const covered = Object.values(OPERATIONS).map((operation) => operation.planOperation).sort();
        assert.deepStrictEqual(covered, plan, 'the plan operations (creation, update, query, render) are not covered one-for-one');
        for (const [id, operation] of Object.entries(OPERATIONS)) {
            assert.strictEqual(budget.operations[id].planOperation, operation.planOperation, `${id}: the recorded plan operation disagrees with the harness`);
            assert.strictEqual(budget.operations[id].callSite, operation.callSite, `${id}: the recorded call site disagrees with the harness`);
        }
    });

    test('no ceiling is vacuous, and none is pinned to the observation it was calibrated from — on every platform', () => {
        // The two ways to make a budget useless: set it so high nothing can fail, or set it at the
        // measured value so the first noisy run turns it red and someone deletes the gate. Both are
        // mechanised here, so loosening a ceiling requires re-recording the observation next to it —
        // which is a visible act in review rather than a one-character edit. Every calibration obeys
        // it, not only the one this host happens to be judged by.
        const [floor, cap] = budget.methodology.ceilingMarginRange;
        const platforms = Object.keys(budget.calibrations || {});
        assert.ok(platforms.length > 0, 'performanceBudget.calibrations is empty — no platform has a ratio ceiling at all');
        for (const [id, spec] of Object.entries<any>(budget.operations)) {
            assert.ok(Number.isFinite(spec.maximumMillisecondsP95) && spec.maximumMillisecondsP95 > 0, `${id}: absolute catastrophe ceiling missing`);
        }
        for (const platform of platforms) {
            const calibrated = budget.calibrations[platform].operations || {};
            assert.deepStrictEqual(Object.keys(calibrated).sort(), Object.keys(budget.operations).sort(),
                `${platform}: the calibrated operations are not the budgeted ones — an operation it omits has no ratio ceiling on ${platform}`);
            for (const [id, spec] of Object.entries<any>(calibrated)) {
                // Number.isFinite on the RAW value, never on Number(value): `Number(null)` is 0 and passes a
                // coercing finiteness check, which is how an uncalibrated ceiling can read as a valid one.
                const observed = spec.observedRatioToReference;
                const ceiling = spec.maximumRatioToReference;
                assert.ok(Number.isFinite(observed) && observed > 0, `${platform}/${id}: no recorded observation to justify the ceiling`);
                assert.ok(Number.isFinite(ceiling) && ceiling > 0, `${platform}/${id}: ratio ceiling is not a finite positive number`);
                assert.ok(ceiling >= observed * floor, `${platform}/${id}: ceiling ${ceiling}x is under ${floor}x the recorded ${observed}x observation and will flap on a loaded host`);
                assert.ok(ceiling <= observed * cap, `${platform}/${id}: ceiling ${ceiling}x is over ${cap}x the recorded ${observed}x observation — that is a budget nothing can fail`);
                assert.ok(Number.isFinite(spec.observedMillisecondsP95) && spec.observedMillisecondsP95 > 0, `${platform}/${id}: no recorded absolute observation`);
                assert.ok(spec.observedMillisecondsP95 < budget.operations[id].maximumMillisecondsP95,
                    `${platform}/${id}: the absolute ceiling ${budget.operations[id].maximumMillisecondsP95}ms is not above the ${spec.observedMillisecondsP95}ms already measured there`);
            }
        }
    });

    // Under c8 — the CI "Coverage ratchet" step re-runs this whole suite with NODE_V8_COVERAGE set — V8
    // block coverage instruments every function, and its cost is not proportional across the measured
    // operations: contentRender (~0.03 ms a call) went from its recorded 0.088x to 0.189x on a run whose
    // UNinstrumented Test step, same commit and same runner, passed. The ratio then measures the
    // instrumentation, not the code. The budget is enforced by the uninstrumented run; under coverage only
    // this comparison is skipped — the structural checks and the negative controls around it still run.
    //
    // On a platform with no calibration the comparison is skipped too, and says why; the test below this
    // one keeps the absolute ceilings and the denominator bounds enforced there.
    test('measured ratios stay inside the committed budget', {
        skip: process.env.NODE_V8_COVERAGE ? 'NODE_V8_COVERAGE is set: ratios measure the coverage instrumentation; enforced by the uninstrumented run' : UNCALIBRATED_SKIP,
    }, () => {
        if (measurementError) throw measurementError;
        const failures = evaluateRun(run, budget, calibration);
        assert.deepStrictEqual(failures, [], `F6 performance budget exceeded on ${PLATFORM}:\n${failures.join('\n')}\nmeasured: ${JSON.stringify(run)}`);
    });

    test('the absolute catastrophe ceilings and the denominator bounds hold, calibrated platform or not', {
        skip: process.env.NODE_V8_COVERAGE ? 'NODE_V8_COVERAGE is set: timings measure the coverage instrumentation; enforced by the uninstrumented run' : false,
    }, () => {
        if (measurementError) throw measurementError;
        const failures = evaluateRun(run, budget, null);
        assert.deepStrictEqual(failures, [], `F6 absolute budget exceeded on ${PLATFORM}:\n${failures.join('\n')}\nmeasured: ${JSON.stringify(run)}`);
    });

    test('the Linux runs that went red on noise are inside the linux calibration — and were outside the win32 one', () => {
        const linux = calibrationFor(budget, 'linux');
        const win32 = calibrationFor(budget, 'win32');
        assert.ok(linux, 'no linux calibration: every CI job that runs this harness runs on Linux, so its ratios would be judged by nothing');
        for (const measured of RED_ON_NOISE_LINUX) {
            assert.deepStrictEqual(evaluateRun(measured, budget, linux, 'linux'), [],
                `a Linux run that was red only because it was judged by Windows numbers is still red against the linux calibration: ${JSON.stringify(measured)}`);
            // The control: the same run against the calibration it used to be judged by still fails, so
            // the green above is the platform lookup doing its job and not a ceiling that accepts anything.
            if (win32) {
                assert.ok(evaluateRun(measured, budget, win32, 'win32').some((f) => f.includes('ratio')),
                    'the win32 calibration accepts the Linux runs that failed CI — the fixture no longer demonstrates the cross-platform defect');
            }
        }
    });

    test('a platform with no calibration borrows nobody else\'s ceilings', () => {
        assert.strictEqual(calibrationFor(budget, 'aix'), null, 'an uncalibrated platform resolved to some other platform\'s ceilings');
        assert.strictEqual(calibrationFor({ ...budget, calibrations: undefined }, 'linux'), null);
        assert.strictEqual(calibrationFor({ ...budget, calibrations: { constructor: {} } }, 'toString'), null, 'a prototype key resolved as a calibration');
        // Uncalibrated means "no ratio verdict", never "every ratio passes": an absurd ratio produces no
        // ratio failure (the ratio test is skipped and says so), while an absolute breach still fails.
        const absurd: Run = JSON.parse(JSON.stringify(RED_ON_NOISE_LINUX[0]));
        absurd.operations.contentRender.ratioToReference = 1e6;
        assert.ok(!evaluateRun(absurd, budget, null, 'aix').some((f) => f.includes('ratio')));
        absurd.operations.contentRender.p95Milliseconds = Number(budget.operations.contentRender.maximumMillisecondsP95) * 2;
        assert.ok(evaluateRun(absurd, budget, null, 'aix').some((f) => f.startsWith('contentRender: p95')),
            'an uncalibrated platform also stopped enforcing the absolute catastrophe ceiling');
    });

    // ── negative controls: the evaluator must turn RED, or "passed" means nothing ────────────────────
    test('an injected slowdown is reported on every calibrated platform, so a green run is evidence and not silence', () => {
        if (measurementError) throw measurementError;
        for (const [platform, platformCalibration] of Object.entries<any>(budget.calibrations)) {
            for (const id of Object.keys(budget.operations)) {
                const ceiling = Number(platformCalibration.operations[id].maximumRatioToReference);
                const slowed: Run = {
                    reference: run.reference,
                    operations: { ...run.operations, [id]: { ...run.operations[id], ratioToReference: ceiling * 1.01 + 0.001 } },
                };
                const failures = evaluateRun(slowed, budget, platformCalibration, platform);
                assert.ok(failures.some((f) => f.startsWith(`${id}: ratio`)), `${platform}/${id}: a ratio past its ceiling was not reported`);
            }
            // A calibration that forgot an operation must not read as "inside the budget".
            const partial = { ...platformCalibration, operations: { ...platformCalibration.operations } };
            delete partial.operations.contentQuery;
            assert.ok(evaluateRun(run, budget, partial, platform).some((f) => f.startsWith('contentQuery: budgeted, but the')),
                `${platform}: a calibration with no ratio for an operation passed it`);
            // A NaN ratio is not "under the ceiling".
            const nan: Run = { reference: run.reference, operations: { ...run.operations, contentRender: { ...run.operations.contentRender, ratioToReference: Number.NaN } } };
            assert.ok(evaluateRun(nan, budget, platformCalibration, platform).some((f) => f.startsWith('contentRender: ratio')),
                `${platform}: a NaN ratio passed the comparison`);
        }
    });

    test('unbudgeted measurements are a failure, not a silent pass', () => {
        if (measurementError) throw measurementError;
        const withExtra: Run = {
            reference: run.reference,
            operations: { ...run.operations, contentDelete: { trimmedMeanMilliseconds: 1, p95Milliseconds: 1, ratioToReference: 1 } },
        };
        const failures = evaluateRun(withExtra, budget, calibration);
        assert.ok(failures.some((f) => f.startsWith('contentDelete: measured but has no committed budget')),
            'a newly measured operation with no ceiling passed — that is the exact hole in f0-content-bench.ts, which iterates the budget table instead of the measurements');
    });

    test('a budgeted operation that stopped being measured is a failure', () => {
        if (measurementError) throw measurementError;
        const operations = { ...run.operations };
        delete operations.contentRender;
        const failures = evaluateRun({ reference: run.reference, operations }, budget, calibration);
        assert.ok(failures.some((f) => f.startsWith('contentRender: has a committed budget but was not measured')),
            'deleting a measurement passed the gate');
    });

    test('a collapsed or inflated reference denominator fails instead of deflating every ratio', () => {
        if (measurementError) throw measurementError;
        const floor = Number(budget.reference.minimumMillisecondsTrimmedMean);
        const cap = Number(budget.reference.maximumMillisecondsTrimmedMean);
        const collapsed = evaluateRun({ reference: { trimmedMeanMilliseconds: floor / 10 }, operations: run.operations }, budget, calibration);
        assert.ok(collapsed.some((f) => f.includes('below the')), 'a reference that stopped doing work was accepted');
        const inflated = evaluateRun({ reference: { trimmedMeanMilliseconds: cap * 10 }, operations: run.operations }, budget, calibration);
        assert.ok(inflated.some((f) => f.includes('exceeds the')), 'a reference slow enough to mask every regression was accepted');
    });

    test('the absolute ceilings never contradict the F0 budgets file they descend from', () => {
        // F0 already committed absolute p95 ceilings. F6 does not get to quietly raise one: where an
        // operation maps onto an F0 key, the F6 catastrophe ceiling must be at least as strict.
        const f0 = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, 'f0-performance-budgets.json'), 'utf8'));
        for (const [id, spec] of Object.entries<any>(budget.operations)) {
            // Absent is not the same as "there is no F0 ancestor". `if (!spec.f0BudgetKey) continue`
            // skipped both, so deleting one line from f0-baseline.json switched this rule off for that
            // operation — here, in verify-f0-baseline.ts and in verify-f6-migration.ts at once, all
            // three still green. The key must be DECLARED; null is a decision and costs a note.
            assert.ok(Object.prototype.hasOwnProperty.call(spec, 'f0BudgetKey'),
                `${id}: no f0BudgetKey declared. Name the F0 ceiling this inherits, or null with a note — an absent key silently disables this check`);
            if (spec.f0BudgetKey === null) {
                assert.ok(typeof spec.note === 'string' && spec.note.trim(),
                    `${id}: f0BudgetKey is null with no note explaining why no F0 ceiling exists to inherit`);
                continue;
            }
            const inherited = Number(f0.contentMilliseconds[spec.f0BudgetKey]);
            assert.ok(Number.isFinite(inherited), `${id}: f0BudgetKey ${spec.f0BudgetKey} does not exist in f0-performance-budgets.json`);
            assert.ok(Number(spec.maximumMillisecondsP95) <= inherited,
                `${id}: F6 ceiling ${spec.maximumMillisecondsP95}ms is looser than the F0 ceiling ${inherited}ms it inherits`);
        }
    });
});

describe('F6 performance budget — per-platform calibration in backend/scripts/perf-calibrate.mjs', () => {
    let calibrate: any;
    let scratch = '';
    const linuxRound = (scale: number) => JSON.parse(JSON.stringify(RED_ON_NOISE_LINUX_FIXTURE(scale)));
    // The shape perf-calibrate.mjs writes in measure mode, which is what CI uploads on every run.
    const artifact = (platform: string, rounds: any[], methodology: any = budget.methodology) => ({
        schemaVersion: 1,
        generatedBy: 'backend/scripts/perf-calibrate.mjs',
        mode: 'measure',
        host: { platform, arch: 'x64', node: 'v22.23.3', cpus: 4, ci: true },
        comparedAgainst: { file: 'backend/f0-baseline.json#performanceBudget', methodology },
        rounds,
    });

    before(async () => {
        const dynamicImport = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<any>;
        calibrate = await dynamicImport(pathToFileURL(path.join(BACKEND_ROOT, 'scripts', 'perf-calibrate.mjs')).href);
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-f6-calibrate-'));
    });
    after(() => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });

    test('recorded rounds from another platform, another methodology or another operation set are refused by name', () => {
        const write = (name: string, value: any) => {
            fs.mkdirSync(path.join(scratch, name), { recursive: true });
            fs.writeFileSync(path.join(scratch, name, 'perf-calibration.json'), JSON.stringify(value));
        };
        write('a', artifact('linux', [linuxRound(1)]));
        write('b', artifact('linux', [linuxRound(1.1), linuxRound(0.9)]));
        write('c', artifact('win32', [linuxRound(1)]));
        write('d', artifact('linux', [linuxRound(1)], { ...budget.methodology, operationSamples: 30 }));
        const extra = linuxRound(1);
        extra.operations.contentDelete = { trimmedMeanMilliseconds: 1, p95Milliseconds: 1, ratioToReference: 1 };
        write('e', artifact('linux', [extra]));
        write('f', { generatedBy: 'something else', rounds: [linuxRound(1)], host: { platform: 'linux' } });

        const recorded = calibrate.collectRecordedRounds([scratch], budget, 'linux');
        assert.strictEqual(recorded.runs.length, 3, 'only the three comparable linux rounds (a + two in b) may be kept');
        const refused = recorded.refused.join('\n');
        assert.match(refused, /measured on win32, not linux/);
        assert.match(refused, /different methodology \(operationSamples 30 vs 60\)/);
        assert.match(refused, /contentDelete/);
        assert.match(refused, /not a perf-calibrate\.mjs artifact/);
    });

    test('a minted calibration records the worst round, sits at 1.5x it, and replaces only its own platform', () => {
        const runs = [linuxRound(1), linuxRound(1.25), linuxRound(0.8)];
        const { calibration, performanceBudget, warnings } = calibrate.mintCalibration(runs, budget, { platform: 'linux', source: 'recorded' });
        for (const id of Object.keys(budget.operations)) {
            const worst = Math.max(...runs.map((r: any) => r.operations[id].ratioToReference));
            assert.strictEqual(calibration.operations[id].observedRatioToReference, Number(worst.toFixed(3)), `${id}: not the worst round`);
            assert.strictEqual(calibration.operations[id].maximumRatioToReference, Number((Number(worst.toFixed(3)) * 1.5).toFixed(3)), `${id}: not 1.5x the worst round`);
        }
        assert.strictEqual(calibration.measuredOn.platform, 'linux');
        assert.strictEqual(calibration.measuredOn.ceilingFactor, 1.5);
        assert.strictEqual(calibration.measuredOn.runs, 3);
        // Every other platform's calibration and every shared field survive untouched.
        for (const platform of Object.keys(budget.calibrations).filter((p) => p !== 'linux')) {
            assert.deepStrictEqual(performanceBudget.calibrations[platform], budget.calibrations[platform], `${platform}: a linux mint disturbed another platform`);
        }
        assert.deepStrictEqual(performanceBudget.operations, budget.operations);
        assert.deepStrictEqual(performanceBudget.reference, budget.reference);
        // A 1.25x-slower round set mints ceilings looser than the committed linux ones, and that is a
        // finding the script reports — never a quiet number change.
        assert.ok(warnings.some((w: string) => /LOOSER than the committed/.test(w)), `a looser re-mint was not reported: ${warnings.join(' | ')}`);
    });

    test('--enforce on an uncalibrated platform is a failure, not a pass', () => {
        const { failures } = calibrate.evaluate(linuxRound(1), budget, 'aix');
        assert.ok(failures.some((f: string) => /aix: no calibration/.test(f)), `an uncalibrated platform passed --enforce: ${failures.join(' | ')}`);
        assert.deepStrictEqual(calibrate.evaluate(linuxRound(1), budget, 'linux').failures, [], 'the recorded red-on-noise Linux run fails the linux calibration in perf-calibrate.mjs');
        assert.strictEqual(calibrate.calibrationFor(budget, 'aix'), null);
    });
});

describe('F6 performance budget — the HTTP steady-state gate in scripts/perf-bench.mjs', () => {
    let evaluateHttpRun: (report: any, spec: any) => string[];
    const spec = () => JSON.parse(JSON.stringify(budget.httpSteadyState));

    before(async () => {
        // Imported, not re-implemented: the point of the exercise is that the shipped gate turns red,
        // not that a copy of it in a test file does. perf-bench.mjs only starts autocannon when it is
        // the entry point, so importing it here is free.
        // `import()` written literally is downlevelled to `require()` by ts-node's CommonJS target,
        // which cannot load an .mjs. The indirection keeps a real dynamic import in the emitted code.
        const dynamicImport = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<any>;
        const module = await dynamicImport(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'perf-bench.mjs')).href);
        evaluateHttpRun = module.evaluateHttpRun;
    });

    /**
     * The fixture carries `meanMilliseconds` because the PRODUCER does, and `p97_5Milliseconds` because
     * autocannon has no p95 — its percentile keys are p90 and p97_5, so the field the harness used to
     * call `p95Milliseconds` never once held a p95. Ratios are anchored on the mean: percentiles come
     * back as whole milliseconds and the reference measures ~1ms in production, so a
     * percentile-over-percentile ratio is the target's latency divided by one and normalises nothing.
     *
     * A fixture that describes a shape the producer does not emit is the trap this repository calls
     * fixture-vs-producer, and the test below the matrix exists to keep these two in step.
     */
    const green = () => ({
        reference: { role: 'liveness', meanMilliseconds: 2.5, p97_5Milliseconds: 4, requestsPerSecond: 900, errors: 0, non2xx: 0 },
        results: [
            { role: 'home', meanMilliseconds: 28, p97_5Milliseconds: 40, requestsPerSecond: 300, errors: 0, non2xx: 0 },
            { role: 'post', meanMilliseconds: 30, p97_5Milliseconds: 44, requestsPerSecond: 280, errors: 0, non2xx: 0 },
            { role: 'settings', meanMilliseconds: 14, p97_5Milliseconds: 20, requestsPerSecond: 600, errors: 0, non2xx: 0 },
            { role: 'posts', meanMilliseconds: 22, p97_5Milliseconds: 32, requestsPerSecond: 400, errors: 0, non2xx: 0 },
        ],
    });

    test('the shipped evaluator is exported and a conforming run passes', () => {
        assert.strictEqual(typeof evaluateHttpRun, 'function', 'perf-bench.mjs does not export its evaluator, so nothing can prove it turns red');
        const calibrated = spec();
        for (const role of Object.keys(calibrated.roles)) {
            calibrated.roles[role].observedRatioToReference = 12;
            calibrated.roles[role].maximumRatioToReference = 18;
        }
        assert.deepStrictEqual(evaluateHttpRun(green(), calibrated), []);
    });

    test('an uncalibrated ratio fails closed instead of counting as a pass', () => {
        // This used to assert the SHIPPED state — "no host has recorded HTTP ratios yet" — by handing the
        // evaluator the committed spec and expecting it to complain. It passed for as long as the budget
        // stayed uncalibrated and evaporated the moment someone calibrated it, which is the wrong way
        // round: the invariant is about the EVALUATOR's behaviour on a missing observation, and that
        // invariant matters more once real numbers exist, not less.
        //
        // Both spellings of "no observation" are covered, because `Number(null)` is 0 and 0 is finite —
        // the coercion bug this check was originally written for.
        for (const missing of [null, undefined]) {
            const partial = spec();
            partial.roles.home.observedRatioToReference = missing;
            partial.roles.home.maximumRatioToReference = missing;
            const failures = evaluateHttpRun(green(), partial);
            assert.ok(failures.some((f) => f.includes('uncalibrated')),
                `a role with ${String(missing)} ratios passed: ${failures.join(' | ')}`);
        }

        // And the committed budget must still be judgeable end to end: whatever it holds today, feeding a
        // conforming run through it may not produce an "uncalibrated" complaint about a recorded number.
        const shipped = evaluateHttpRun(green(), spec());
        const spurious = shipped.filter((f) => f.includes('uncalibrated'));
        const recorded = Object.entries<any>(spec().roles).filter(([, r]) => Number.isFinite(r.observedRatioToReference));
        if (recorded.length === Object.keys(spec().roles).length) {
            assert.deepStrictEqual(spurious, [],
                `every role is calibrated in f0-baseline.json, yet the evaluator called one uncalibrated: ${spurious.join(' | ')}`);
        }
    });

    test('a target with no budgeted role, a missing required role, non-2xx and a missing reference all fail', () => {
        const calibrated = spec();
        for (const role of Object.keys(calibrated.roles)) {
            calibrated.roles[role].observedRatioToReference = 12;
            calibrated.roles[role].maximumRatioToReference = 18;
        }

        const extra = green();
        extra.results.push({ role: 'admin', meanMilliseconds: 7, p97_5Milliseconds: 10, requestsPerSecond: 100, errors: 0, non2xx: 0 });
        assert.ok(evaluateHttpRun(extra, calibrated).some((f) => f.includes('admin')), 'a measured target with no budget passed');

        const missing = green();
        missing.results = missing.results.filter((r) => r.role !== 'post');
        assert.ok(evaluateHttpRun(missing, calibrated).some((f) => f.includes("required role 'post' was never exercised")),
            'a required target that was never exercised passed — the gate shrank to whatever the run happened to contain');

        const throttled = green();
        throttled.results[3].non2xx = 7;
        assert.ok(evaluateHttpRun(throttled, calibrated).some((f) => f.includes('non-2xx')),
            'a run whose numbers came from the rate limiter passed');

        const headless = green();
        (headless as any).reference = null;
        assert.ok(evaluateHttpRun(headless, calibrated).some((f) => f.includes('reference')), 'a run with no reference denominator passed');

        // A /healthz that 404s is FAST, so it deflates the denominator and would report four unrelated
        // ratio failures. It has to be named once, at the denominator.
        const brokenReference = green();
        brokenReference.reference.non2xx = 25000;
        const referenceFailures = evaluateHttpRun(brokenReference, calibrated);
        assert.ok(referenceFailures.some((f) => f.includes('the denominator measured an error page')),
            'a reference target that answered 404/429 was used as the denominator anyway');
        assert.strictEqual(referenceFailures.length, 1, 'a broken denominator must report once, not once per target');
    });

    test('a slow target trips the ratio even when its absolute latency looks ordinary', () => {
        const calibrated = spec();
        for (const role of Object.keys(calibrated.roles)) {
            calibrated.roles[role].observedRatioToReference = 12;
            calibrated.roles[role].maximumRatioToReference = 18;
        }
        const slow = green();
        // The ratio is reference-throughput over target-throughput, so "slow" means FEWER requests per
        // second. 900/18 = 50 req/s is exactly the ceiling; 45 is over it. Its latency is untouched and
        // still looks unremarkable, which is the point: the absolute ceiling would not catch this.
        slow.results[0].requestsPerSecond = 45;
        const failures = evaluateHttpRun(slow, calibrated);
        assert.ok(failures.some((f) => f.includes('home') && f.includes('ratio')),
            'a target 18x heavier than an empty liveness response passed because 73ms "looks fast"');
    });

    /**
     * FIXTURE-VS-PRODUCER. Every test above drives the real evaluator with a HAND-WRITTEN report, so all
     * of them pass for ever if the harness starts emitting a different shape — the evaluator would be
     * exercised on data no run produces, and the gate would be measuring a fiction.
     *
     * That is not theoretical here. The measurement used to emit `p95Milliseconds` built from
     * `r.latency.p95 ?? r.latency.p97_5`, and autocannon 8 has no `latency.p95` at all: its percentile
     * keys are p90 and p97_5. So the field never held a p95, and no fixture could reveal it because the
     * fixtures were written from the field NAME rather than from the producer.
     *
     * The producer's own keys are read out of scripts/perf-bench.mjs and the fixture is required to be a
     * subset of them, so renaming a field on one side without the other is red.
     */
    test('the fixture describes the shape the harness actually emits', () => {
        const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'perf-bench.mjs'), 'utf8').split('\r\n').join('\n');
        const block = /measured\.push\(\{([\s\S]*?)\n\s*\}\);/.exec(source);
        if (!block || !block[1].trim()) {
            throw new Error('cannot find the measurement literal in perf-bench.mjs — this gate is reading nothing');
        }

        const produced = new Set(
            (block[1].match(/^\s{8,}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm) || [])
                .map((line) => line.trim().replace(/\s*:$/, '')),
        );
        // Positive control: a scan that finds nothing must not pass by finding nothing.
        assert.ok(produced.size >= 6, `only ${produced.size} produced fields parsed out of perf-bench.mjs: ${[...produced].join(', ')}`);

        const sample = green();
        const consumed = new Set([...Object.keys(sample.reference), ...Object.keys(sample.results[0])]);
        const invented = [...consumed].filter((key) => !produced.has(key));
        assert.deepStrictEqual(invented, [],
            `the fixture describes fields the harness never emits (${invented.join(', ')}) — every HTTP test above would then be driving the evaluator with data no run produces. Produced: ${[...produced].sort().join(', ')}`);

        // And the two the evaluator actually reads must be among them, so a producer that drops one is red.
        for (const required of ['meanMilliseconds', 'p97_5Milliseconds']) {
            assert.ok(produced.has(required), `perf-bench.mjs no longer emits ${required}, which the evaluator reads`);
        }
    });

    test('a report with no throughput is rejected rather than falling back to latency', () => {
        const calibrated = spec();
        for (const role of Object.keys(calibrated.roles)) {
            calibrated.roles[role].observedRatioToReference = 12;
            calibrated.roles[role].maximumRatioToReference = 18;
        }
        // Throughput is what gives the ratio its resolution: it is a count over the run window, while
        // autocannon's latency comes back quantised to whole milliseconds and /healthz answers in tens
        // of microseconds. If a future producer stops emitting requestsPerSecond, the gate must say so
        // rather than quietly re-anchoring on a latency figure whose denominator is noise.
        const noThroughput = green();
        delete (noThroughput.reference as any).requestsPerSecond;
        assert.ok(evaluateHttpRun(noThroughput, calibrated).some((f) => f.includes('unanchored')),
            'a run with no reference throughput was judged anyway');

        const roleNoThroughput = green();
        delete (roleNoThroughput.results[0] as any).requestsPerSecond;
        assert.ok(evaluateHttpRun(roleNoThroughput, calibrated).some((f) => f.includes('home') && f.includes('throughput')),
            'a role with no throughput was judged anyway');
    });
});
