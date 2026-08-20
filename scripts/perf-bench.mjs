/**
 * WordJS perf harness — reproducible before/after numbers for the performance program.
 *
 *   node scripts/perf-bench.mjs [baseUrl] [--slug <post-slug>] [--duration 10] [--connections 25]
 *
 * MUST run against a PRODUCTION build (monolith prod or split prod): Next's Data/Route caches do
 * not persist in dev, so dev numbers are meaningless. Warm each target once, then measure.
 * Pair with WORDJS_QUERY_STATS=1 on a dev backend for per-endpoint query counts.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const autocannon = require("autocannon");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const budgets = JSON.parse(fs.readFileSync(path.join(repoRoot, "backend", "f0-performance-budgets.json"), "utf8"));

const args = process.argv.slice(2);
const opt = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const optionNames = new Set(["--slug", "--duration", "--connections"]);
const optionValues = new Set(args.flatMap((arg, i) => optionNames.has(arg) && args[i + 1] ? [i + 1] : []));
const base = (args.find((a, i) => !a.startsWith("--") && !optionValues.has(i)) || "http://localhost:3000").replace(/\/$/, "");
const slug = opt("slug", null);
const duration = Number(opt("duration", 10));
const connections = Number(opt("connections", 25));
const enforce = args.includes("--enforce");
const json = args.includes("--json");

const targets = [
    { name: "HTML home", path: "/" },
    ...(slug ? [{ name: `HTML /${slug}`, path: `/${slug}` }] : []),
    { name: "API settings", path: "/api/v1/settings" },
    { name: "API posts", path: "/api/v1/posts?per_page=10" },
];

const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));

console.log(`WordJS perf-bench → ${base}  (${duration}s × ${connections} conexiones por objetivo)`);
console.log("AVISO: solo sirve sobre build de PRODUCCION.\n");

const results = [];
for (const t of targets) {
    const url = base + t.path;
    // warm the caches once so we measure steady-state, not the first-hit compile/encode
    try { await fetch(url, { headers: { accept: "text/html,*/*" } }); } catch { /* measured below anyway */ }
    const r = await autocannon({ url, duration, connections, headers: { accept: "text/html,*/*" } });
    results.push({
        target: t.name,
        path: t.path,
        requestsPerSecond: Number(r.requests.average),
        p50Milliseconds: Number(r.latency.p50),
        p95Milliseconds: Number(r.latency.p95 ?? r.latency.p97_5),
        p99Milliseconds: Number(r.latency.p99),
        errors: Number(r.errors + r.timeouts),
        non2xx: Number(r.non2xx),
    });
}
console.table(results.map((r) => ({
    objetivo: r.target,
    "req/s": fmt(r.requestsPerSecond),
    "p50 ms": r.p50Milliseconds,
    "p95 ms": r.p95Milliseconds,
    "p99 ms": r.p99Milliseconds,
    errores: r.errors,
    no2xx: r.non2xx,
})));
if (results.some((r) => r.no2xx > 0)) {
    console.log("AVISO: no2xx>0 en objetivos /api = el rate limiter (1000 req/15min) respondiendo 429 —");
    console.log("esas filas miden el limiter, no la ruta. Para medir el API real: menos conexiones/duración,");
    console.log("o sube el límite temporalmente en el entorno de bench.");
}
const report = {
    schemaVersion: 1,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    parameters: { base, durationSeconds: duration, connections },
    budgets: budgets.httpSteadyState,
    results,
};
if (json) console.log(JSON.stringify(report, null, 2));

if (enforce) {
    const failures = [];
    for (const r of results) {
        if (r.p95Milliseconds > budgets.httpSteadyState.p95Milliseconds) failures.push(`${r.target}: p95 ${r.p95Milliseconds}ms > ${budgets.httpSteadyState.p95Milliseconds}ms`);
        if (r.requestsPerSecond < budgets.httpSteadyState.minimumRequestsPerSecond) failures.push(`${r.target}: ${r.requestsPerSecond.toFixed(1)} req/s < ${budgets.httpSteadyState.minimumRequestsPerSecond} req/s`);
        if (r.errors > budgets.httpSteadyState.maximumErrorCount) failures.push(`${r.target}: ${r.errors} errors > ${budgets.httpSteadyState.maximumErrorCount}`);
        if (r.non2xx > 0) failures.push(`${r.target}: ${r.non2xx} non-2xx responses`);
    }
    if (failures.length) {
        console.error(`F0 HTTP performance budget exceeded:\n${failures.join("\n")}`);
        process.exitCode = 1;
    }
}
console.log("Guarda el reporte junto al commit medido — es la línea base del antes/después.");
