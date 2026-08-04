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

const require = createRequire(import.meta.url);
const autocannon = require("autocannon");

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) || "http://localhost:3000").replace(/\/$/, "");
const opt = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const slug = opt("slug", null);
const duration = Number(opt("duration", 10));
const connections = Number(opt("connections", 25));

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
        objetivo: t.name,
        "req/s": fmt(r.requests.average),
        "p50 ms": r.latency.p50,
        "p97_5 ms": r.latency.p97_5,
        "p99 ms": r.latency.p99,
        "errores": r.errors + r.timeouts,
        "no2xx": r.non2xx,
    });
}
console.table(results);
console.log("Guarda esta tabla junto al commit medido — es la línea base del antes/después.");
