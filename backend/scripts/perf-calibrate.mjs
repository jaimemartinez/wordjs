#!/usr/bin/env node
/**
 * Run the F6 in-process performance harness on THIS host, print every observation next to the ceiling
 * it is judged by, and — on demand — mint a calibration for one platform in the exact shape of
 * `backend/f0-baseline.json#performanceBudget.calibrations.<platform>`.
 *
 *   node backend/scripts/perf-calibrate.mjs --enforce            # one round, fail if anything exceeds
 *   node backend/scripts/perf-calibrate.mjs --calibrate          # eight rounds, emit a paste-ready block
 *   node backend/scripts/perf-calibrate.mjs --rounds 3 --out x.json
 *   node backend/scripts/perf-calibrate.mjs --calibrate --platform linux --from <artifacts dir>
 *                                                                # mint from rounds CI already recorded
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
 * WHY THERE IS ONE CALIBRATION PER PLATFORM. The denominator is ten AUTOCOMMIT inserts, so it moves
 * with what a per-statement durability flush costs on the host filesystem, while the four numerators do
 * not all move with it: creation and update are transactions, query and render are mostly CPU. A ratio
 * is therefore stable across runs on ONE host and not across hosts. Measured, not argued: the Linux
 * runners record a reference of ~0.22 ms against the Windows calibration host's ~0.37 ms, so on Linux
 * the write ratios come out at ~0.55x their Windows value and the CPU ratios at ~1.2x-2.5x — contentRender
 * at a worst of 0.216x over 104 recorded CI rounds against a Windows-derived 0.18x ceiling. One budget
 * judged on both platforms is too loose on one of them and flaps on the other, and that is the exact
 * failure the Backend job kept reporting (contentRender 0.183x and 0.187x on code that had not changed).
 * So each platform the harness is enforced on carries its own observation and its own ceiling, and a
 * platform with no calibration is reported as uncalibrated instead of borrowing another host's numbers.
 *
 * `--calibrate` mints ceilings at 1.5x the worst round — the noise factor alone, because a calibration
 * measured on the platform it is enforced on owes no cross-platform allowance.
 *
 * `--from` reduces rounds that were ALREADY measured instead of spawning new ones: every CI run uploads
 * a one-round `perf-calibration.json` from this script's measure mode, so the history of real runner
 * rounds is a far larger sample than eight back-to-back rounds on one runner, and its worst round is a
 * truer tail. Only rounds measured with the committed methodology and the committed operation set are
 * accepted; everything else is named and refused.
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

/** Ceilings are this many times the WORST round. 1.5x is the noise factor alone, and it stays inside
 *  `methodology.ceilingMarginRange` (1.2–3.0), which both the F6 suite and verify-f0-baseline.ts check. */
const CEILING_FACTOR = 1.5;

/** The methodology fields a recorded round has to share with the committed budget to be comparable. */
const METHODOLOGY_KEYS = ['warmupIterations', 'operationSamples', 'referenceSamples', 'trimFraction'];

function parseArgs(argv) {
    const args = argv.slice(2);
    const calibrate = args.includes('--calibrate');
    const enforce = args.includes('--enforce');
    const roundsFlag = args.indexOf('--rounds');
    const outFlag = args.indexOf('--out');
    const platformFlag = args.indexOf('--platform');
    const fromFlag = args.indexOf('--from');
    const rounds = roundsFlag >= 0 ? Number(args[roundsFlag + 1]) : (calibrate ? 8 : 1);
    const out = outFlag >= 0 ? args[outFlag + 1] : path.join(REPO_ROOT, 'perf-calibration.json');
    const platform = platformFlag >= 0 ? args[platformFlag + 1] : process.platform;
    // Every argument after --from that is not itself a flag is a source (a file or a directory).
    const from = [];
    if (fromFlag >= 0) {
        for (let i = fromFlag + 1; i < args.length && !args[i].startsWith('--'); i++) from.push(path.resolve(args[i]));
    }
    return { calibrate, enforce, rounds, out: path.resolve(REPO_ROOT, out), platform, from: fromFlag >= 0 ? from : null };
}

/**
 * The calibration a platform is judged by, or null when nobody has calibrated it.
 *
 * Exact key only. A platform with no calibration must NOT fall back to another one — that is the
 * defect this lookup replaced: one Windows calibration judging Linux runs it was never measured on.
 */
export function calibrationFor(budget, platform) {
    const calibrations = budget && budget.calibrations;
    if (!calibrations || typeof calibrations !== 'object') return null;
    if (!Object.prototype.hasOwnProperty.call(calibrations, platform)) return null;
    return calibrations[platform] || null;
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
        // 'close', not 'exit': 'exit' can fire before the stdout pipe has drained, and the measurement
        // is the LAST thing the harness prints that matters here.
        child.on('close', (code) => resolve({ run: extractRun(stdout), harnessOk: code === 0, stdout, stderr }));
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
 *
 * The ratio ceilings come from `calibrations[platform]`. A platform with no calibration is a failure
 * here, not a skip: this function is what `--enforce` reports, and "nothing to compare against" is not
 * a verdict anyone can rely on.
 */
export function evaluate(run, budget, platform = process.platform) {
    const rows = [];
    const failures = [];
    const reference = run.reference.trimmedMeanMilliseconds;
    const calibration = calibrationFor(budget, platform);
    if (!calibration) {
        failures.push(`${platform}: no calibration in performanceBudget.calibrations — the ratios below have no ceiling on this platform. Mint one with --calibrate.`);
    }

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
        const calibrated = calibration && calibration.operations ? calibration.operations[id] : undefined;
        if (calibration && !calibrated) {
            failures.push(`${id}: budgeted, but the ${platform} calibration records no ratio for it — re-mint the calibration`);
        }
        const ratioOver = Boolean(calibrated) && measured.ratioToReference > Number(calibrated.maximumRatioToReference);
        const p95Over = measured.p95Milliseconds > Number(spec.maximumMillisecondsP95);
        rows.push({
            operation: id,
            observedRatio: measured.ratioToReference,
            committedObservedRatio: calibrated ? calibrated.observedRatioToReference : 'uncalibrated',
            ceilingRatio: calibrated ? calibrated.maximumRatioToReference : 'uncalibrated',
            observedP95Ms: measured.p95Milliseconds,
            committedObservedP95Ms: calibrated ? calibrated.observedMillisecondsP95 : 'uncalibrated',
            ceilingP95Ms: spec.maximumMillisecondsP95,
            verdict: ratioOver || p95Over ? 'OVER' : (calibrated ? 'ok' : 'UNCALIBRATED'),
        });
        if (ratioOver) failures.push(`${id}: ratio ${measured.ratioToReference}x > ${calibrated.maximumRatioToReference}x committed ${platform} ceiling (committed ${platform} observation ${calibrated.observedRatioToReference}x)`);
        if (p95Over) failures.push(`${id}: p95 ${measured.p95Milliseconds}ms > ${spec.maximumMillisecondsP95}ms absolute ceiling`);
    }
    for (const id of Object.keys(budget.operations)) {
        if (!run.operations[id]) failures.push(`${id}: has a committed budget but was not measured — the harness stopped exercising it`);
    }
    return { rows, failures };
}

/**
 * Collect recorded rounds from perf-calibration.json artifacts (files, or directories searched
 * recursively), keeping only those that are comparable with the committed budget.
 *
 * A round is refused — and every refusal is reported, never dropped quietly — when its host is another
 * platform, when it was measured with a different methodology (sample counts, warmups, trim), or when
 * its operation set is not exactly the committed one. Mixing any of those into a calibration would mint
 * a ceiling from a measurement the enforcing harness no longer makes.
 */
export function collectRecordedRounds(sources, budget, platform) {
    const files = [];
    const walk = (entry) => {
        let stat;
        try { stat = fs.statSync(entry); } catch { return; }
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(entry).sort()) walk(path.join(entry, name));
        } else if (path.basename(entry) === 'perf-calibration.json' || entry.endsWith('.json')) {
            files.push(entry);
        }
    };
    for (const source of sources) walk(source);

    const committedIds = Object.keys(budget.operations).sort();
    const runs = [];
    const hosts = [];
    const refused = [];
    for (const file of files) {
        let artifact;
        try { artifact = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
            refused.push(`${file}: not JSON (${error.message})`);
            continue;
        }
        if (!artifact || artifact.generatedBy !== 'backend/scripts/perf-calibrate.mjs' || !Array.isArray(artifact.rounds)) {
            refused.push(`${file}: not a perf-calibrate.mjs artifact`);
            continue;
        }
        const host = artifact.host || {};
        if (host.platform !== platform) {
            refused.push(`${file}: measured on ${host.platform}, not ${platform}`);
            continue;
        }
        const method = (artifact.comparedAgainst && artifact.comparedAgainst.methodology) || {};
        const drift = METHODOLOGY_KEYS.filter((key) => method[key] !== budget.methodology[key]);
        if (drift.length) {
            refused.push(`${file}: measured with a different methodology (${drift.map((key) => `${key} ${method[key]} vs ${budget.methodology[key]}`).join(', ')})`);
            continue;
        }
        for (const [index, run] of artifact.rounds.entries()) {
            const ids = Object.keys((run && run.operations) || {}).sort();
            if (!run || !run.reference || JSON.stringify(ids) !== JSON.stringify(committedIds)) {
                refused.push(`${file} round ${index + 1}: operations ${JSON.stringify(ids)} are not the committed ${JSON.stringify(committedIds)}`);
                continue;
            }
            runs.push(run);
            hosts.push(host);
        }
    }
    return { runs, hosts, files, refused };
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
 * Reduce the rounds into ONE platform's calibration — the block that lives at
 * `performanceBudget.calibrations.<platform>`.
 *
 * Every recorded observation is the WORST round, which is the convention the committed file already
 * documents ("observedRatioToReference records the WORST of the calibration runs"): calibrating off a
 * lucky round produces a ceiling the next ordinary run trips over, and the gate gets deleted in its
 * first bad week. Everything that is NOT an observation — the methodology, the reference bounds, the
 * call sites, the f0BudgetKey descent, the absolute catastrophe ceilings, every OTHER platform's
 * calibration and the whole httpSteadyState section — stays exactly as committed. `performanceBudget`
 * in the result is the committed budget with only this platform's calibration replaced, so pasting it
 * cannot disturb a calibration measured somewhere else.
 */
export function mintCalibration(runs, budget, { factor = CEILING_FACTOR, platform = process.platform, hosts = [], source = 'spawned' } = {}) {
    const warnings = [];
    const ids = Object.keys(budget.operations);
    const committed = calibrationFor(budget, platform);

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

        const shared = budget.operations[id];
        // The absolute ceiling is INHERITED, never minted: verify-f0-baseline.ts refuses an F6 ceiling
        // looser than the F0 one it descends from, and refuses a ceiling at or below a value already
        // measured. Both of those are protections, so a p95 that has grown past its ceiling is reported
        // as a finding here instead of being legislated away.
        if (worstP95 >= Number(shared.maximumMillisecondsP95)) {
            warnings.push(`${id}: worst observed p95 ${worstP95}ms is at or above the inherited absolute ceiling ${shared.maximumMillisecondsP95}ms (F0 key ${JSON.stringify(shared.f0BudgetKey)}). This calibration does NOT raise it — that ceiling descends from backend/f0-performance-budgets.json and F6 may not loosen what it inherits. Fix the regression, or take the F0 ceiling up deliberately and in its own review.`);
        }
        const maximumRatioToReference = round3(worstRatio * factor);
        // A RE-mint that comes out looser than what this platform already commits is a regression being
        // written into the budget. It may be the right call (a deliberate, reviewed slowdown), so it is
        // emitted — but as a finding with a non-zero exit, never as a quiet number change.
        const before = committed && committed.operations ? committed.operations[id] : undefined;
        if (before && Number.isFinite(before.maximumRatioToReference) && maximumRatioToReference > before.maximumRatioToReference) {
            warnings.push(`${id}: minted ${platform} ratio ceiling ${maximumRatioToReference}x is LOOSER than the committed ${before.maximumRatioToReference}x (worst round ${worstRatio}x against a committed observation of ${before.observedRatioToReference}x). Either the code got slower — find out why — or this host was noisier than the one that minted the committed number. Do not paste it without saying which.`);
        }
        operations[id] = {
            observedRatioToReference: worstRatio,
            maximumRatioToReference,
            observedMillisecondsP95: worstP95,
        };
    }

    const spread = round3(worstSpread);
    const nodes = [...new Set((hosts.length ? hosts.map((h) => h.node) : [process.version]).filter(Boolean).map((v) => `${String(v).replace(/^v/, '').split('.')[0]}.x`))];
    const arches = [...new Set((hosts.length ? hosts.map((h) => h.arch) : [process.arch]).filter(Boolean))];
    const calibration = {
        measuredOn: {
            platform,
            arch: arches.join(', '),
            node: nodes.join(', '),
            driver: 'sqlite-native',
            date: new Date().toISOString().slice(0, 10),
            runs: runs.length,
            source: source === 'recorded'
                ? `${runs.length} one-round perf-calibration.json artifacts recorded by CI in measure mode, reduced with perf-calibrate.mjs --calibrate --from`
                : `${runs.length} rounds spawned back to back by perf-calibrate.mjs --calibrate`,
            ceilingFactor: factor,
            worstObservedRunToRunRatioSpread: spread,
            sensitivityNote: `Ceilings are ${factor}x the worst of the ${runs.length} calibration rounds, and the worst run-to-run ratio spread across those rounds was ${spread}x. The gate therefore trips somewhere between a ${factor}x regression (measured on a bad run) and a ${round3(factor * spread)}x one (measured on a good run). That is the honest sensitivity: it catches the N+1 query, the lost index, the second sanitisation pass and the synchronous flush. It does not catch a 20% slowdown, and chasing 20% on a shared runner buys false failures rather than information.`,
        },
        reference: { observedMillisecondsTrimmedMean: worstReference },
        operations,
    };

    // The structural rules verify-f0-baseline.ts and the F6 suite both enforce. Checking them HERE
    // means a bad calibration is caught by the machine that minted it, not three steps later by a gate
    // whose message is about the file rather than about the run.
    const [marginFloor, marginCap] = budget.methodology.ceilingMarginRange;
    if (factor < marginFloor || factor > marginCap) {
        warnings.push(`ceiling factor ${factor}x is outside methodology.ceilingMarginRange [${marginFloor}, ${marginCap}] — verify-f0-baseline.ts would reject this budget`);
    }
    if (worstReference <= Number(budget.reference.minimumMillisecondsTrimmedMean) || worstReference >= Number(budget.reference.maximumMillisecondsTrimmedMean)) {
        warnings.push(`reference observation ${worstReference}ms does not sit strictly inside its committed bounds [${budget.reference.minimumMillisecondsTrimmedMean}, ${budget.reference.maximumMillisecondsTrimmedMean}] — the denominator gate would be red or vacuous from the first run`);
    }
    const performanceBudget = {
        ...budget,
        calibrations: { ...(budget.calibrations || {}), [platform]: calibration },
    };
    return { calibration, performanceBudget, warnings };
}

async function main() {
    const { calibrate, enforce, rounds, out, platform, from } = parseArgs(process.argv);
    if (!Number.isInteger(rounds) || rounds < 1) {
        console.error('--rounds expects a positive integer');
        process.exit(2);
    }
    if (from === null && platform !== process.platform) {
        // A spawned round measures THIS host. Labelling it as another platform would mint that platform's
        // calibration from the wrong machine — the single-platform defect again, with a false label on it.
        console.error(`--platform ${platform} only applies to --from: this host is ${process.platform}, and a round spawned here measures ${process.platform}.`);
        process.exit(2);
    }
    if (from !== null && !from.length) {
        console.error('--from expects at least one perf-calibration.json file or directory');
        process.exit(2);
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const budget = baseline.performanceBudget;
    const committed = calibrationFor(budget, platform);

    if (committed) {
        const m = committed.measuredOn || {};
        console.log(`committed ${platform} calibration: ${m.runs} rounds on ${m.platform}/${m.arch}, node ${m.node} (${m.date}), ceilings at ${m.ceilingFactor}x the worst round`);
    } else {
        console.log(`no committed ${platform} calibration — performanceBudget.calibrations has ${JSON.stringify(Object.keys(budget.calibrations || {}))}`);
    }

    const runs = [];
    let hosts = [];
    let harnessFailedOnce = false;
    let recordedFrom = null;
    if (from !== null) {
        const recorded = collectRecordedRounds(from, budget, platform);
        console.log(`perf-calibrate: ${recorded.runs.length} recorded ${platform} round(s) from ${recorded.files.length} file(s)`);
        for (const reason of recorded.refused) console.log(`  refused: ${reason}`);
        if (!recorded.runs.length) {
            console.error(`no comparable ${platform} round in ${from.join(', ')} — nothing to calibrate or evaluate`);
            process.exit(1);
        }
        runs.push(...recorded.runs);
        hosts = recorded.hosts;
        recordedFrom = { files: recorded.files.length, refused: recorded.refused };
    } else {
        console.log(`perf-calibrate: ${rounds} round(s) of ${HARNESS} on ${process.platform}/${process.arch}, node ${process.version}`);
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
    }

    const evaluations = runs.map((run) => evaluate(run, budget, platform));
    printTable(`observed on ${platform} vs the committed ${platform} ceilings — worst round`, mergeWorst(evaluations));

    const failures = [...new Set(evaluations.flatMap((e) => e.failures))];
    const artifact = {
        schemaVersion: 1,
        generatedBy: 'backend/scripts/perf-calibrate.mjs',
        mode: calibrate ? 'calibrate' : (enforce ? 'enforce' : 'measure'),
        // A --from reduction did not measure anything on THIS machine, so it must not describe itself
        // as a round from this host — otherwise the next --from would take it for one.
        host: recordedFrom ? { platform, recorded: true } : {
            platform: process.platform,
            arch: process.arch,
            node: process.version,
            cpus: os.cpus().length,
            totalMemoryBytes: os.totalmem(),
            ci: Boolean(process.env.CI),
        },
        comparedAgainst: {
            file: `backend/f0-baseline.json#performanceBudget.calibrations.${platform}`,
            measuredOn: committed ? committed.measuredOn : null,
            methodology: budget.methodology,
        },
        ...(recordedFrom ? { recordedFrom } : {}),
        rounds: recordedFrom ? [] : runs,
        evaluation: evaluations.map((e, i) => ({ round: i + 1, rows: e.rows, failures: e.failures })),
        failures,
        harnessWentRed: harnessFailedOnce,
    };

    let exitCode = 0;
    if (calibrate) {
        const { calibration, performanceBudget, warnings } = mintCalibration(runs, budget, {
            platform,
            hosts,
            source: recordedFrom ? 'recorded' : 'spawned',
        });
        artifact.calibration = calibration;
        artifact.performanceBudget = performanceBudget;
        artifact.calibrationWarnings = warnings;
        console.log(`\n${platform} calibration minted from ${runs.length} rounds — ceilings at ${CEILING_FACTOR}x the worst round:`);
        for (const [id, spec] of Object.entries(calibration.operations)) {
            const before = committed && committed.operations ? committed.operations[id] : null;
            const was = before ? `(was ${before.observedRatioToReference}x -> ${before.maximumRatioToReference}x)` : '(no committed ceiling on this platform)';
            console.log(`  ${id.padEnd(16)} ratio ${String(spec.observedRatioToReference).padStart(8)}x -> ceiling ${String(spec.maximumRatioToReference).padStart(8)}x   ${was}`);
        }
        console.log(`paste the artifact's .calibration over performanceBudget.calibrations.${platform} in backend/f0-baseline.json`);
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
            console.error(`\n${failures.length} observation(s) exceeded the committed ceiling on ${platform}, or ${platform} is not calibrated.`);
            exitCode = 1;
        } else if (harnessFailedOnce) {
            console.error('\nevery observation is inside its ceiling, but the F6 suite itself went red — see its output above; a structural assertion failed.');
            exitCode = 1;
        } else {
            console.log(`\nevery observation is inside the committed ceiling on ${platform}.`);
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
