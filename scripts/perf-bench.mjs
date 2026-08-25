/**
 * WordJS HTTP perf harness — reproducible before/after numbers, and the enforcing side of the F6
 * performance budget for everything that only exists over HTTP.
 *
 *   node scripts/perf-bench.mjs [baseUrl] [--slug <post-slug>] [--duration 10] [--connections 25]
 *                               [--reference <path-or-url>] [--enforce] [--calibrate] [--json]
 *
 * MUST run against a PRODUCTION build (monolith prod or split prod): Next's Data/Route caches do not
 * persist in dev, so dev numbers are meaningless. Each target is warmed once, then measured.
 * Pair with WORDJS_QUERY_STATS=1 on a dev backend for per-endpoint query counts.
 *
 * WHY THERE IS A REFERENCE TARGET. The budget this enforces is a RATIO, not a millisecond count. A
 * millisecond is a property of the machine: the same 750 ms ceiling is unreachable on a laptop and one
 * bad neighbour away from flapping on a shared runner, so it fails in both directions. `/healthz` is the
 * whole HTTP stack — listener, middleware chain, event loop, JSON encode — doing no application work, so
 * `reqPerSec(/healthz) / reqPerSec(target)` says how much heavier a route is than an empty one, and that number
 * moves with the code instead of with the host. The absolute ceilings in
 * backend/f0-performance-budgets.json are kept as a secondary catastrophe check.
 *
 * THROUGHPUT, NOT LATENCY, AND THE CHOICE WAS MEASURED. autocannon reports latency in WHOLE
 * milliseconds and `/healthz` answers in tens of microseconds, so the original p95(target)/p95(/healthz)
 * had a denominator quantised to 1 and the "ratio" was simply the absolute latency — normalising
 * nothing, which is the entire reason the budget is a ratio. `latency.mean` does not rescue it either:
 * the mean is taken over that same quantised histogram, so across five clean runs on one idle host the
 * reference mean wandered 0.04ms -> 0.15ms (3.75x) and every role's ratio inherited 3.4x-3.9x of noise.
 *
 * Requests per second is a COUNT over the run window, so it has resolution. The same five runs gave a
 * reference spread of 1.20x and role-ratio spreads of 1.14x-1.30x — roughly three times tighter. The
 * meaning is unchanged: `reqPerSec(/healthz) / reqPerSec(target)` is how many empty responses fit in the
 * time this route takes, which is what "how much heavier is this route" always meant.
 *
 * LATENCY IS STILL REPORTED, as p97.5 under its real name — autocannon 8 exposes p90 and p97_5 and has
 * no `latency.p95`, so the field this harness used to call `p95Milliseconds` never once held a p95. It
 * feeds the absolute catastrophe ceiling, not the ratio.
 *
 * The evaluator is exported rather than inlined into the run so that
 * backend/src/tests/f6-performance-budget.test.ts can prove THIS gate turns red — a gate whose failure
 * path nothing ever executes is indistinguishable from a gate that cannot fail.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(repoRoot, relative), "utf8"));

/**
 * The F6 HTTP gate.
 *
 * Walks the MEASURED roles and the BUDGETED roles in both directions. A measured role with no budget is
 * a failure ("no budget"), a required budgeted role that was never exercised is a failure ("never
 * exercised"), and a ratio with no recorded observation is a failure ("uncalibrated"). None of the three
 * is a skip: this repository has twice shipped a gate that reported green because the thing it was
 * supposed to check was absent, and the shape of that bug is always a missing member counting as a pass.
 *
 * @param {{reference: {requestsPerSecond: number, non2xx: number, errors: number}|null, results: Array<{role: string, requestsPerSecond: number, meanMilliseconds: number, p97_5Milliseconds: number, errors: number, non2xx: number}>}} report
 * @param {{reference: {path: string}, roles: Record<string, {required: boolean, observedRatioToReference: number|null, maximumRatioToReference: number|null}>}} spec
 * @returns {string[]} failures; empty means the run is inside budget
 */
export function evaluateHttpRun(report, spec) {
    const failures = [];
    const results = report && Array.isArray(report.results) ? report.results : [];
    if (!results.length) {
        failures.push("no targets were measured — an empty run is not a passing run");
        return failures;
    }

    // THROUGHPUT, NOT LATENCY, AND THAT WAS MEASURED RATHER THAN ASSUMED.
    //
    // The ratio was p95(target)/p95(/healthz). autocannon reports latency in WHOLE milliseconds and
    // /healthz answers in tens of microseconds, so the denominator was a quantised 1 and the "ratio"
    // was just the absolute latency. Switching to latency.mean did not rescue it: the mean is taken
    // over the same quantised histogram, so across five clean runs on one idle host the reference mean
    // moved 0.04ms -> 0.15ms, a 3.75x spread, and every role's ratio inherited 3.4x-3.9x of noise.
    //
    // Requests per second is a COUNT over six seconds. Same five runs, same host: the reference varied
    // 1.20x and the role ratios 1.14x-1.30x — about three times tighter. It also says the same thing a
    // latency ratio was meant to say ("how much heavier is this route than an empty one"), just read as
    // "how many empty responses fit in the time this route takes".
    const referenceRps = report && report.reference ? Number(report.reference.requestsPerSecond) : NaN;
    if (!Number.isFinite(referenceRps) || referenceRps <= 0) {
        failures.push(`no usable reference measurement for ${spec.reference.path} (requestsPerSecond=${report && report.reference ? report.reference.requestsPerSecond : 'absent'}) — every ratio below would be unanchored, so the run certifies nothing`);
        return failures;
    }
    // A reference that answered 404 or 429 is FAST, which deflates the denominator and turns every ratio
    // red for the wrong reason. Say so once here instead of four times below with a misleading message.
    if (Number(report.reference.non2xx) > 0 || Number(report.reference.errors) > 0) {
        failures.push(`reference ${spec.reference.path} answered ${report.reference.non2xx} non-2xx and ${report.reference.errors} errors — the denominator measured an error page, not the HTTP stack`);
        return failures;
    }

    const seen = new Set();
    for (const result of results) {
        const role = String(result.role);
        if (seen.has(role)) failures.push(`role '${role}' was measured twice — one of the two results is silently discarded`);
        seen.add(role);

        const budget = spec.roles[role];
        if (!budget) {
            failures.push(`role '${role}' was measured with no budget — add it to performanceBudget.httpSteadyState.roles in backend/f0-baseline.json`);
            continue;
        }
        if (Number(result.non2xx) > 0) {
            failures.push(`role '${role}': ${result.non2xx} non-2xx responses — those numbers came from the rate limiter or an error page, not from the route`);
        }
        if (Number(result.errors) > 0) {
            failures.push(`role '${role}': ${result.errors} transport errors or timeouts`);
        }

        const ceiling = budget.maximumRatioToReference;
        const observed = budget.observedRatioToReference;
        // Number.isFinite WITHOUT the Number() coercion, deliberately: `Number(null)` is 0, which is
        // finite, so the coercing spelling accepted an uncalibrated budget and then compared every ratio
        // against a ceiling of zero — a gate that reports the wrong failure for every role and would have
        // been "fixed" by loosening something unrelated.
        if (!Number.isFinite(ceiling) || !Number.isFinite(observed)) {
            failures.push(`role '${role}': uncalibrated ratio budget — run 'node scripts/perf-bench.mjs <baseUrl> --slug <slug> --calibrate' on this host and record observedRatioToReference / maximumRatioToReference in backend/f0-baseline.json`);
            continue;
        }
        const rps = Number(result.requestsPerSecond);
        if (!Number.isFinite(rps) || rps <= 0) {
            failures.push(`role '${role}': no throughput (requestsPerSecond=${result.requestsPerSecond}) — the ratio is anchored on throughput, so a result without one cannot be judged`);
            continue;
        }
        const ratio = referenceRps / rps;
        if (ratio > Number(ceiling)) {
            failures.push(`role '${role}': ratio ${ratio.toFixed(2)}x reference > ${ceiling}x budget (recorded observation ${observed}x, ${rps.toFixed(1)} req/s against the reference's ${referenceRps.toFixed(1)} req/s)`);
        }
    }

    for (const [role, budget] of Object.entries(spec.roles)) {
        if (budget.required && !seen.has(role)) {
            failures.push(`required role '${role}' was never exercised — a target that disappears from the run must fail, not shrink the gate`);
        }
    }
    return failures;
}

/** The absolute F0 ceilings, kept as a catastrophe check beside the machine-independent ratios. */
export function evaluateAbsoluteBudgets(results, httpSteadyState) {
    const failures = [];
    for (const result of results) {
        // p97.5, under its real name. The budget key was renamed with it: a ceiling labelled p95 that is
        // in fact compared against p97.5 is stricter than it says, which is the safe direction to be
        // wrong in and still no way to leave a number nobody can interpret.
        if (Number(result.p97_5Milliseconds) > httpSteadyState.p97_5Milliseconds) {
            failures.push(`${result.target}: p97.5 ${result.p97_5Milliseconds}ms > ${httpSteadyState.p97_5Milliseconds}ms`);
        }
        if (Number(result.requestsPerSecond) < httpSteadyState.minimumRequestsPerSecond) {
            failures.push(`${result.target}: ${Number(result.requestsPerSecond).toFixed(1)} req/s < ${httpSteadyState.minimumRequestsPerSecond} req/s`);
        }
        if (Number(result.errors) > httpSteadyState.maximumErrorCount) {
            failures.push(`${result.target}: ${result.errors} errors > ${httpSteadyState.maximumErrorCount}`);
        }
    }
    return failures;
}

async function main() {
    const { createRequire } = await import("node:module");
    // Required lazily: importing this module must stay free so the F6 test can drive the evaluator
    // above without pulling in a load generator or requiring it to be installed.
    const autocannon = createRequire(import.meta.url)("autocannon");

    const budgets = readJson("backend/f0-performance-budgets.json");
    const spec = readJson("backend/f0-baseline.json").performanceBudget.httpSteadyState;

    const args = process.argv.slice(2);
    const opt = (name, dflt) => {
        const i = args.indexOf(`--${name}`);
        return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
    };
    const optionNames = new Set(["--slug", "--duration", "--connections", "--reference"]);
    const optionValues = new Set(args.flatMap((arg, i) => (optionNames.has(arg) && args[i + 1] ? [i + 1] : [])));
    const base = (args.find((a, i) => !a.startsWith("--") && !optionValues.has(i)) || "http://localhost:3000").replace(/\/$/, "");
    const slug = opt("slug", null);
    const duration = Number(opt("duration", 10));
    const connections = Number(opt("connections", 25));
    const referencePath = opt("reference", spec.reference.path);
    const enforce = args.includes("--enforce");
    const calibrate = args.includes("--calibrate");
    const json = args.includes("--json");

    // An enforcing run without --slug would silently drop the post-render target and shrink the gate to
    // whatever happened to be measured. Refuse instead.
    if ((enforce || calibrate) && !slug) {
        console.error("--enforce and --calibrate require --slug <post-slug>: the post render target is a required role, and a run that omits it certifies less than it claims.");
        process.exitCode = 1;
        return;
    }

    const absolute = (value) => (/^https?:\/\//i.test(value) ? value : base + value);
    const targets = [
        { role: "liveness", name: `reference ${referencePath}`, url: absolute(referencePath), reference: true },
        { role: "home", name: "HTML home", url: absolute("/") },
        ...(slug ? [{ role: "post", name: `HTML /${slug}`, url: absolute(`/${slug}`) }] : []),
        { role: "settings", name: "API settings", url: absolute("/api/v1/settings") },
        { role: "posts", name: "API posts", url: absolute("/api/v1/posts?per_page=10") },
    ];

    const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
    console.log(`WordJS perf-bench -> ${base}  (${duration}s x ${connections} connections per target)`);
    console.log("NOTE: only meaningful against a PRODUCTION build.\n");

    const measured = [];
    for (const target of targets) {
        // Warm the caches once so we measure steady state, not the first-hit compile/encode.
        try { await fetch(target.url, { headers: { accept: "text/html,*/*" } }); } catch { /* measured below anyway */ }
        const r = await autocannon({ url: target.url, duration, connections, headers: { accept: "text/html,*/*" } });
        measured.push({
            role: target.role,
            target: target.name,
            url: target.url,
            reference: Boolean(target.reference),
            requestsPerSecond: Number(r.requests.average),
            // THE RATIO IS BUILT ON THE MEAN, AND THAT IS THE WHOLE POINT.
            //
            // autocannon reports percentiles as WHOLE MILLISECONDS. The reference (/healthz) measures
            // 1ms on a production build, so a ratio of percentile-over-percentile is target-p95 divided
            // by 1: it EQUALS the absolute latency and normalises nothing between machines, which is the
            // only reason this budget is expressed as a ratio at all. Quantising a 1ms denominator
            // carries up to a 2x error before anything else goes wrong. `latency.mean` is a float, so
            // the denominator keeps its resolution — and it matches how the in-process budget already
            // anchors its ratios (trimmed mean over trimmed mean), instead of mixing two statistics.
            meanMilliseconds: Number(r.latency.mean),
            p50Milliseconds: Number(r.latency.p50),
            // NOT p95: autocannon 8 has no `latency.p95`. Its percentile keys are p90 and p97_5, so the
            // old `r.latency.p95 ?? r.latency.p97_5` fell through to p97.5 on EVERY run and the field
            // called "p95Milliseconds" never once held a p95. The value was always stricter than its
            // name claimed, so nothing passed that should have failed — but a budget whose numbers are
            // labelled with a percentile they are not is a budget nobody can reason about.
            p97_5Milliseconds: Number(r.latency.p97_5),
            p99Milliseconds: Number(r.latency.p99),
            errors: Number(r.errors + r.timeouts),
            non2xx: Number(r.non2xx),
        });
    }

    const reference = measured.find((m) => m.reference) || null;
    const results = measured.filter((m) => !m.reference);
    const ratio = (m) => (reference && reference.requestsPerSecond > 0 ? Number((reference.requestsPerSecond / m.requestsPerSecond).toFixed(2)) : null);

    console.table(measured.map((m) => ({
        role: m.role,
        target: m.target,
        "req/s": fmt(m.requestsPerSecond),
        "mean ms": m.meanMilliseconds,
        "p50 ms": m.p50Milliseconds,
        "p97.5 ms": m.p97_5Milliseconds,
        "p99 ms": m.p99Milliseconds,
        "reference / this": m.reference ? "1.00" : ratio(m),
        errors: m.errors,
        non2xx: m.non2xx,
    })));

    // This warning used to read `r.no2xx`, a field that does not exist, so it never fired once: every
    // run where the rate limiter (1000 req/15min) answered 429 printed a clean table of the limiter's
    // latency and said nothing. The enforcing path now fails on non-2xx as well.
    if (measured.some((m) => m.non2xx > 0)) {
        console.log("WARNING: non2xx>0 on /api targets means the rate limiter answered 429 — those rows measure the limiter, not the route.");
        // Naming the lever matters: a six-second run of the two /api targets exceeds the default budget
        // (1000 requests / 15 minutes) on its own, so this is the NORMAL outcome on a default host, not
        // an exotic one. Telling the operator to "raise the limit" without saying how is how a warning
        // becomes noise someone learns to scroll past.
        console.log("Start the site being measured with WORDJS_API_RATELIMIT_MAX=1000000 (config.api.rateLimit; the default 1000/15min is unchanged for real deployments),");
        console.log("or wait out the window and use a shorter --duration. One 6s run of the two /api targets already exceeds the default budget.");
    }

    const report = {
        schemaVersion: 2,
        environment: { node: process.version, platform: process.platform, arch: process.arch },
        parameters: { base, durationSeconds: duration, connections, referencePath, slug },
        budgets: { absolute: budgets.httpSteadyState, ratio: spec.roles },
        reference,
        results,
    };
    if (json) console.log(JSON.stringify(report, null, 2));

    if (calibrate) {
        // A CALIBRATION MINTED FROM A DIRTY RUN IS WORSE THAN NO CALIBRATION.
        //
        // `--calibrate` used to print observations from whatever it had just measured, with no check at
        // all. The enforcing path rejects non-2xx; the calibrating path — the one that WRITES the number
        // every later run is judged against — did not. On this repository's own API rate limit
        // (1000 req / 15 min) the second run of the day answers 429 to roughly twenty thousand requests,
        // and 429s are fast: the settings role "improved" from 230ms to 5ms. Pasting that in would have
        // baked the rate limiter into the budget and made the gate unfailable for the route it names.
        const dirty = measured.filter((m) => Number(m.non2xx) > 0 || Number(m.errors) > 0);
        if (dirty.length) {
            console.error("\nREFUSING TO CALIBRATE: this run did not measure the routes.");
            for (const m of dirty) console.error(`  ${m.role}: ${m.non2xx} non-2xx, ${m.errors} errors — ${m.target}`);
            console.error("429s are FAST, so these numbers would lower the ceiling and make the gate unfailable.");
            console.error("Wait out the rate-limit window (1000 req / 15 min) or raise the limit for the bench host, then re-run.");
            process.exitCode = 1;
        } else {
            const observations = {};
            for (const m of results) observations[m.role] = { observedRatioToReference: ratio(m), maximumRatioToReference: ratio(m) === null ? null : Number((ratio(m) * 1.5).toFixed(2)) };
            console.log("\nCalibration for backend/f0-baseline.json -> performanceBudget.httpSteadyState.roles:");
            console.log(JSON.stringify(observations, null, 2));
            console.log("Ratios are throughput-over-throughput: a count over the run window, which has resolution where sub-millisecond latency does not.");
            console.log("Record the WORST of several runs, not one. The ceilings above are 1.5x this run and must stay inside methodology.ceilingMarginRange.");
        }
    }

    if (enforce) {
        const failures = [
            ...evaluateHttpRun({ reference, results }, spec),
            ...evaluateAbsoluteBudgets(results, budgets.httpSteadyState),
        ];
        if (failures.length) {
            console.error(`F6 HTTP performance budget exceeded:\n${failures.join("\n")}`);
            process.exitCode = 1;
        } else {
            console.log("HTTP steady state within budget: every required role exercised, every ratio inside its ceiling.");
        }
    }
    console.log("Keep the report next to the commit it measured — that is the before/after baseline.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
