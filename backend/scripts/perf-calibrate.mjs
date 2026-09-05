#!/usr/bin/env node
/**
 * Run the F6 in-process performance harness on THIS host, print every observation next to the ceiling
 * it is judged by, and — on demand — mint a calibration in the exact shape of
 * `backend/f0-baseline.json#performanceBudget` so the committed budget can stop being a property of one
 * Windows laptop.
 *
 *   node backend/scripts/perf-calibrate.mjs --enforce            # one round, fail if anything exceeds
 *   node backend/scripts/perf-calibrate.mjs --calibrate          # eight rounds, emit a paste-ready block
 *   node backend/scripts/perf-calibrate.mjs --rounds 3 --out x.json
 *
 * WHY THIS SCRIPT DOES NOT MEASURE ANYTHING ITSELF.
 *
 * The measurement already exists, in `backend/src/tests/f6-performance-budget.test.ts`: ten warmups, 60
 * operation samples, 150 reference samples, a 10% trimmed mean, and the four call sites the F6 plan
 * names, all wired to `performanceBudget.methodology` so the harness and the budget cannot drift apart.
 * Re-implementing that loop here would produce a second, subtly different definition of "the same
 * methodology" and a calibration minted from a harness that is NOT the one CI enforces with — the
 * fixture-vs-producer trap this repository has been bitten by before. So this script SPAWNS that
 * harness (WORDJS_F6_PERF_PRINT=1 makes it emit its run as one JSON line) and does only the two things
 * the harness deliberately does not do: repeat it, and reduce many rounds into a budget.
 *
 * WHY THE COMMITTED BUDGET NEEDS THIS. `measuredOn.platform` is `win32`. Every ratio in the file was
 * observed on one Windows host, and the file says so in `provisionalMargin`: the denominator is ten
 * AUTOCOMMIT inserts while the numerators are transactions, per-statement durability costs more on that
 * filesystem than on a Linux runner's ext4, and the 2.0x margin is 1.5x for noise TIMES an allowance for
 * never having run anywhere else. Once the harness has run on the CI host that allowance is no longer
 * owed, which is why `--calibrate` mints ceilings at 1.5x the worst round instead of 2.0x.
 *
 * WHAT --calibrate REFUSES TO DO. It never raises `maximumMillisecondsP95`. Those are the absolute
 * catastrophe ceilings that descend from `backend/f0-performance-budgets.json`, and
 * `scripts/verify-f0-baseline.ts` enforces that F6 may not loosen an F0 ceiling it inherits. If a Linux
 * round measures a p95 at or above one of them, that is a finding about the code or the runner, not a
 * number to edit: the script says so and exits non-zero rather than emitting a budget that would be
 * rejected (or, worse, accepted) downstream.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const BASELINE_PATH = path.join(BACKEND_ROOT, 'f0-baseline.json');
const HARNESS = 'src/tests/f6-performance-budget.test.ts';

/** Ceilings are this many times the WORST round. 2.0x in the committed file bought a single-platform
 *  allowance that a run on the target platform no longer needs; 1.5x is the noise factor alone, and it
 *  stays inside `methodology.ceilingMarginRange` (1.2–3.0), which both the F6 suite and
 *  verify-f0-baseline.ts check. */
const CEILING_FACTOR = 1.5;

function parseArgs(argv) {
    const args = argv.slice(2);
    const calibrate = args.includes('--calibrate');
    const enforce = args.includes('--enforce');
    const roundsFlag = args.indexOf('--rounds');
    const outFlag = args.indexOf('--out');
    const rounds = roundsFlag >= 0 ? Number(args[roundsFlag + 1]) : (calibrate ? 8 : 1);
    const out = outFlag >= 0 ? args[outFlag + 1] : path.join(REPO_ROOT, 'perf-calibration.json');
    return { calibrate, enforce, rounds, out: path.resolve(REPO_ROOT, out) };
}

/**
 * Run the harness once and return its measured run plus the harness's own verdict.
 *
 * The run JSON is printed from the suite's `before` hook, so it exists even when the suite then goes
 * RED on a ceiling — which is exactly the case `--calibrate` has to survive, since a host whose numbers
 * exceed a Windows-calibrated budget is the reason to calibrate in the first place.
 *
 * The spawn goes through scripts/test-with-flake-retry.mjs for the same reason every other
 * `--test-force-exit` call in this repository does: node:test intermittently fails to deserialize a
 * force-exited child's last IPC message and reports the FILE as failed with `# fail 0` inside. The
 * wrapper retries that and only that, so `harnessOk` below means "the assertions passed", not "the
 * runner happened to settle".
 */
function runHarness() {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [
            path.join(REPO_ROOT, 'scripts', 'test-with-flake-retry.mjs'),
            '--test-force-exit',
            '-r', 'ts-node/register/transpile-only',
            HARNESS,
        ], {
            cwd: BACKEND_ROOT,
            env: { ...process.env, WORDJS_F6_PERF_PRINT: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (b) => { stdout += b.toString(); });
        child.stderr.on('data', (b) => { stderr += b.toString(); });
        child.on('error', (e) => resolve({ run: null, harnessOk: false, stdout, stderr: `${stderr}\n${e && e.message}` }));
        child.on('exit', (code) => resolve({ run: extractRun(stdout), harnessOk: code === 0, stdout, stderr }));
    });
}

/**
 * Pull the measurement out of the TAP stream.
 *
 * node:test forwards a child file's stray stdout into the report, so the JSON line arrives wrapped in
 * whatever prefix the active reporter uses. Scan every line for the first `{` and try to parse from
 * there; take the LAST match, because a flake retry runs the harness again and the final attempt is the
 * one whose exit code we report.
 */
export function extractRun(stdout) {
    let found = null;
    for (const line of String(stdout).split('\n')) {
        const start = line.indexOf('{');
        if (start < 0) continue;
        let parsed;
        try { parsed = JSON.parse(line.slice(start)); } catch { continue; }
        if (parsed && parsed.reference && parsed.operations) found = parsed;
    }
    return found;
}

const round4 = (n) => Number(Number(n).toFixed(4));
const round3 = (n) => Number(Number(n).toFixed(3));

/**
 * Compare ONE round against the committed ceilings.
 *
 * Deliberately the same two questions `evaluateRun` asks inside the F6 suite — ratio against
 * `maximumRatioToReference`, p95 against `maximumMillisecondsP95`, plus the denominator's own bounds —
 * because this job's verdict has to be readable in the log without opening the suite's output. The
 * suite remains the authority: `--enforce` fails if EITHER this table finds a breach OR the harness
 * itself went red, so this table can only ever make the gate stricter, never pass something the suite
 * failed.
 */
export function evaluate(run, budget) {
    const rows = [];
    const failures = [];
    const reference = run.reference.trimmedMeanMilliseconds;

    if (!Number.isFinite(reference) || reference <= 0) {
        failures.push(`reference workload produced no usable timing (${reference}ms) — every ratio below would be unanchored`);
        return { rows, failures };
    }
    if (reference < Number(budget.reference.minimumMillisecondsTrimmedMean)) {
        failures.push(`reference ${reference}ms is below the ${budget.reference.minimumMillisecondsTrimmedMean}ms floor — the denominator stopped doing work, so every ratio is meaningless`);
    }
    if (reference > Number(budget.reference.maximumMillisecondsTrimmedMean)) {
        failures.push(`reference ${reference}ms exceeds the ${budget.reference.maximumMillisecondsTrimmedMean}ms ceiling — the driver write path itself regressed, which deflates every ratio`);
    }

    for (const [id, measured] of Object.entries(run.operations)) {
        const spec = budget.operations[id];
        if (!spec) {
            failures.push(`${id}: measured but has no committed budget — add it to performanceBudget.operations in backend/f0-baseline.json`);
            continue;
        }
        const ratioOver = measured.ratioToReference > Number(spec.maximumRatioToReference);
        const p95Over = measured.p95Milliseconds > Number(spec.maximumMillisecondsP95);
        rows.push({
            operation: id,
            observedRatio: measured.ratioToReference,
            committedObservedRatio: spec.observedRatioToReference,
            ceilingRatio: spec.maximumRatioToReference,
            observedP95Ms: measured.p95Milliseconds,
            committedObservedP95Ms: spec.observedMillisecondsP95,
            ceilingP95Ms: spec.maximumMillisecondsP95,
            verdict: ratioOver || p95Over ? 'OVER' : 'ok',
        });
        if (ratioOver) failures.push(`${id}: ratio ${measured.ratioToReference}x > ${spec.maximumRatioToReference}x committed ceiling (committed observation ${spec.observedRatioToReference}x)`);
        if (p95Over) failures.push(`${id}: p95 ${measured.p95Milliseconds}ms > ${spec.maximumMillisecondsP95}ms absolute ceiling`);
    }
    for (const id of Object.keys(budget.operations)) {
        if (!run.operations[id]) failures.push(`${id}: has a committed budget but was not measured — the harness stopped exercising it`);
    }
    return { rows, failures };
}

function printTable(label, rows) {
    const header = ['operation', 'ratio', 'committed obs', 'ceiling', 'p95 ms', 'committed p95', 'p95 ceiling', ''];
    const body = rows.map((r) => [
        r.operation,
        String(r.observedRatio),
        String(r.committedObservedRatio),
        String(r.ceilingRatio),
        String(r.observedP95Ms),
        String(r.committedObservedP95Ms),
        String(r.ceilingP95Ms),
        r.verdict,
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
    const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
    console.log(`\n${label}`);
    console.log(line(header));
    console.log(widths.map((w) => '-'.repeat(w)).join('  '));
    for (const row of body) console.log(line(row));
}

/**
 * Reduce the rounds into a `performanceBudget` block.
 *
 * Every recorded observation is the WORST round, which is the convention the committed file already
 * documents ("observedRatioToReference records the WORST of the calibration runs"): calibrating off a
 * lucky round produces a ceiling the next ordinary run trips over, and the gate gets deleted in its
 * first bad week. Everything that is NOT an observation — the methodology, the reference bounds, the
 * call sites, the f0BudgetKey descent, the absolute catastrophe ceilings and the whole httpSteadyState
 * section, which this harness does not measure — is copied through from the committed budget unchanged.
 */
export function mintBudget(runs, budget, { factor = CEILING_FACTOR, platform = process.platform } = {}) {
    const warnings = [];
    const ids = Object.keys(budget.operations);

    const references = runs.map((r) => r.reference.trimmedMeanMilliseconds);
    const worstReference = round4(Math.max(...references));

    let worstSpread = 1;
    const operations = {};
    for (const id of ids) {
        const ratios = runs.map((r) => r.operations[id].ratioToReference);
        const p95s = runs.map((r) => r.operations[id].p95Milliseconds);
        const worstRatio = round3(Math.max(...ratios));
        const worstP95 = round4(Math.max(...p95s));
        const spread = Math.max(...ratios) / Math.min(...ratios);
        if (Number.isFinite(spread)) worstSpread = Math.max(worstSpread, spread);

        const committed = budget.operations[id];
        // The absolute ceiling is INHERITED, never minted: verify-f0-baseline.ts refuses an F6 ceiling
        // looser than the F0 one it descends from, and refuses a ceiling at or below a value already
        // measured. Both of those are protections, so a p95 that has grown past its ceiling is reported
        // as a finding here instead of being legislated away.
        if (worstP95 >= Number(committed.maximumMillisecondsP95)) {
            warnings.push(`${id}: worst observed p95 ${worstP95}ms is at or above the inherited absolute ceiling ${committed.maximumMillisecondsP95}ms (F0 key ${JSON.stringify(committed.f0BudgetKey)}). This calibration does NOT raise it — that ceiling descends from backend/f0-performance-budgets.json and F6 may not loosen what it inherits. Fix the regression, or take the F0 ceiling up deliberately and in its own review.`);
        }
        operations[id] = {
            planOperation: committed.planOperation,
            callSite: committed.callSite,
            observedRatioToReference: worstRatio,
            maximumRatioToReference: round3(worstRatio * factor),
            observedMillisecondsP95: worstP95,
            maximumMillisecondsP95: committed.maximumMillisecondsP95,
            f0BudgetKey: committed.f0BudgetKey,
            ...(committed.note ? { note: committed.note } : {}),
        };
    }

    const spread = round3(worstSpread);
    const nodeMajor = process.version.replace(/^v/, '').split('.')[0];
    const minted = {
        ...budget,
        // methodology is copied through EXCEPT its note, which names the ceiling factor in prose. A
        // minted block whose ceilings are 1.5x while the paragraph beside them still says 2.0x is a
        // budget that lies about itself, and the next person to read it would calibrate off the prose.
        methodology: {
            ...budget.methodology,
            note: `observedRatioToReference records the WORST of the calibration rounds and every ceiling sits at ${factor}x it. ceilingMarginRange is the window a ceiling must stay inside relative to its own recorded observation: below ${budget.methodology.ceilingMarginRange[0]}x it flaps on a loaded host and gets disabled within a week, above ${budget.methodology.ceilingMarginRange[1]}x nothing can fail it, which is the same defect as having no threshold. Loosening a ceiling therefore forces re-recording the observation beside it — a visible act in review rather than a one-character edit.`,
        },
        measuredOn: {
            platform,
            arch: process.arch,
            node: `${nodeMajor}.x`,
            driver: 'sqlite-native',
            date: new Date().toISOString().slice(0, 10),
            runs: runs.length,
            worstObservedRunToRunRatioSpread: spread,
            sensitivityNote: `Ceilings are ${factor}x the worst of the ${runs.length} calibration rounds, and the worst run-to-run ratio spread across those rounds was ${spread}x. The gate therefore trips somewhere between a ${factor}x regression (measured on a bad run) and a ${round3(factor * spread)}x one (measured on a good run). That is the honest sensitivity: it catches the N+1 query, the lost index, the second sanitisation pass and the synchronous flush. It does not catch a 20% slowdown, and chasing 20% on a shared runner buys false failures rather than information.`,
            provisionalMargin: `${factor}x is the measurement-noise factor ALONE. The ${platform} calibration retires the extra allowance the win32 file carried for having never run anywhere but its author's laptop (see the previous provisionalMargin): the denominator is ten autocommit inserts while the numerators are transactions, so the ratio is sensitive to what a per-statement durability flush costs on the host filesystem, and calibrating on the platform the gate actually runs on is what removes the guess. Minted by backend/scripts/perf-calibrate.mjs --calibrate; re-mint rather than hand-editing a ceiling, so the observation beside it moves at the same time.`,
        },
        reference: {
            ...budget.reference,
            observedMillisecondsTrimmedMean: worstReference,
        },
        operations,
    };

    // The two structural rules verify-f0-baseline.ts and the F6 suite both enforce. Checking them HERE
    // means a bad calibration is caught by the machine that minted it, not three steps later by a gate
    // whose message is about the file rather than about the run.
    const [marginFloor, marginCap] = budget.methodology.ceilingMarginRange;
    if (factor < marginFloor || factor > marginCap) {
        warnings.push(`ceiling factor ${factor}x is outside methodology.ceilingMarginRange [${marginFloor}, ${marginCap}] — verify-f0-baseline.ts would reject this budget`);
    }
    if (worstReference <= Number(budget.reference.minimumMillisecondsTrimmedMean) || worstReference >= Number(budget.reference.maximumMillisecondsTrimmedMean)) {
        warnings.push(`reference observation ${worstReference}ms does not sit strictly inside its committed bounds [${budget.reference.minimumMillisecondsTrimmedMean}, ${budget.reference.maximumMillisecondsTrimmedMean}] — the denominator gate would be red or vacuous from the first run`);
    }
    return { performanceBudget: minted, warnings };
}

async function main() {
    const { calibrate, enforce, rounds, out } = parseArgs(process.argv);
    if (!Number.isInteger(rounds) || rounds < 1) {
        console.error('--rounds expects a positive integer');
        process.exit(2);
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const budget = baseline.performanceBudget;

    console.log(`perf-calibrate: ${rounds} round(s) of ${HARNESS} on ${process.platform}/${process.arch}, node ${process.version}`);
    // The committed ceiling factor is not stored as a number anywhere, so derive it from the file
    // rather than reprinting a constant that could drift out of step with what is actually committed.
    const committedFactors = Object.values(budget.operations)
        .map((spec) => Number(spec.maximumRatioToReference) / Number(spec.observedRatioToReference))
        .filter((n) => Number.isFinite(n));
    const committedFactor = committedFactors.length ? round3(Math.max(...committedFactors)) : null;
    console.log(`committed budget was measured on ${budget.measuredOn.platform}/${budget.measuredOn.arch} (${budget.measuredOn.date}), ceilings at ${committedFactor === null ? 'an unreadable factor' : `${committedFactor}x`} the worst of ${budget.measuredOn.runs} runs`);

    const runs = [];
    let harnessFailedOnce = false;
    for (let i = 1; i <= rounds; i++) {
        const started = Date.now();
        const { run, harnessOk, stdout, stderr } = await runHarness();
        if (!run) {
            console.error(`round ${i}/${rounds}: the harness produced no measurement. It is not a pass — a round that could not run certifies nothing.`);
            console.error(stdout.split('\n').slice(-40).join('\n'));
            console.error(stderr.split('\n').slice(-20).join('\n'));
            process.exit(1);
        }
        if (!harnessOk) harnessFailedOnce = true;
        runs.push(run);
        const ratios = Object.entries(run.operations).map(([id, m]) => `${id}=${m.ratioToReference}x`).join(' ');
        console.log(`round ${i}/${rounds} (${((Date.now() - started) / 1000).toFixed(1)}s, harness ${harnessOk ? 'green' : 'RED'}): reference=${run.reference.trimmedMeanMilliseconds}ms ${ratios}`);
        if (!harnessOk) {
            // A round whose measurement parsed but whose suite went red is the interesting case — a
            // ceiling was exceeded, or a structural assertion (operation map vs budget) drifted. Print
            // what the suite said rather than leaving the reader with one word.
            console.error(`--- round ${i}: F6 suite output (last 40 lines) ---`);
            console.error(stdout.split('\n').filter((l) => l.trim()).slice(-40).join('\n'));
            if (stderr.trim()) console.error(stderr.split('\n').slice(-20).join('\n'));
        }
    }

    const evaluations = runs.map((run) => evaluate(run, budget));
    printTable(`observed on ${process.platform} vs the committed (${budget.measuredOn.platform}) ceilings — worst round`, mergeWorst(evaluations));

    const failures = [...new Set(evaluations.flatMap((e) => e.failures))];
    const artifact = {
        schemaVersion: 1,
        generatedBy: 'backend/scripts/perf-calibrate.mjs',
        mode: calibrate ? 'calibrate' : (enforce ? 'enforce' : 'measure'),
        host: {
            platform: process.platform,
            arch: process.arch,
            node: process.version,
            cpus: os.cpus().length,
            totalMemoryBytes: os.totalmem(),
            ci: Boolean(process.env.CI),
        },
        comparedAgainst: {
            file: 'backend/f0-baseline.json#performanceBudget',
            measuredOn: budget.measuredOn,
            methodology: budget.methodology,
        },
        rounds: runs,
        evaluation: evaluations.map((e, i) => ({ round: i + 1, rows: e.rows, failures: e.failures })),
        failures,
        harnessWentRed: harnessFailedOnce,
    };

    let exitCode = 0;
    if (calibrate) {
        const { performanceBudget, warnings } = mintBudget(runs, budget, { platform: process.platform });
        artifact.performanceBudget = performanceBudget;
        artifact.calibrationWarnings = warnings;
        console.log(`\ncalibration minted from ${runs.length} rounds — ceilings at ${CEILING_FACTOR}x the worst round (the committed file uses ${committedFactor === null ? 'an unreadable factor' : `${committedFactor}x`}):`);
        for (const [id, spec] of Object.entries(performanceBudget.operations)) {
            const before = budget.operations[id];
            console.log(`  ${id.padEnd(16)} ratio ${String(spec.observedRatioToReference).padStart(8)}x -> ceiling ${String(spec.maximumRatioToReference).padStart(8)}x   (was ${before.observedRatioToReference}x -> ${before.maximumRatioToReference}x)`);
        }
        for (const warning of warnings) {
            console.error(`::error::${warning}`);
            exitCode = 1;
        }
    }

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`\nraw measurements written to ${path.relative(REPO_ROOT, out)}`);

    if (enforce) {
        for (const failure of failures) console.error(`::error::${failure}`);
        if (failures.length) {
            console.error(`\n${failures.length} observation(s) exceeded the committed ceiling on ${process.platform}.`);
            exitCode = 1;
        } else if (harnessFailedOnce) {
            console.error('\nevery observation is inside its ceiling, but the F6 suite itself went red — see its output above; a structural assertion failed.');
            exitCode = 1;
        } else {
            console.log(`\nevery observation is inside the committed ceiling on ${process.platform}.`);
        }
    }
    process.exit(exitCode);
}

/** The worst round per operation, so the printed table is the one a reviewer has to defend. */
function mergeWorst(evaluations) {
    const worst = new Map();
    for (const evaluation of evaluations) {
        for (const row of evaluation.rows) {
            const current = worst.get(row.operation);
            if (!current || row.observedRatio > current.observedRatio) worst.set(row.operation, row);
        }
    }
    return [...worst.values()];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    await main();
}
