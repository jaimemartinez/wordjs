#!/usr/bin/env node
/**
 * `npm audit` as a GATE, not as a hostage to npm's uptime.
 *
 * `npm audit --omit=dev --audit-level=high` exits non-zero for TWO very different reasons, and the
 * plain command cannot tell them apart:
 *
 *   1. Our production dependencies contain a HIGH/critical advisory. THIS MUST BLOCK — it is the whole
 *      point of the gate, and it is what caught fast-uri.
 *   2. npm's advisory ENDPOINT is unreachable — `{ "error": "Service Unavailable" }`, a 503, a network
 *      timeout. This has nothing to do with our code, and on the day this was written it happened for
 *      hours, turning every audit step across every job red and making the whole repository
 *      un-mergeable while npm's servers were down.
 *
 * Blocking on (2) is not security, it is an outage amplifier. This wrapper separates them: it reads the
 * JSON report, BLOCKS on a real HIGH/critical count, and treats a confirmed service/network failure as
 * "audit unavailable" — retried a few times, then WARNED loudly and allowed to pass. A real advisory
 * produces a real report with vulnerability data, so it can never be mistaken for an outage; the
 * green-while-broken direction stays closed.
 *
 * Runs `npm audit` in process.cwd(), so each workflow step keeps using its own working-directory.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LEVEL = 'high';               // block at high and above (high + critical)
const RETRIES = 3;
const BACKOFF_MS = [4000, 10000, 20000];

function runAudit() {
    return new Promise((resolve) => {
        const child = spawn('npm', ['audit', '--omit=dev', `--audit-level=${LEVEL}`, '--json'],
            { cwd: process.cwd(), shell: process.platform === 'win32' });
        let out = '', err = '';
        child.stdout.on('data', (b) => { out += b; });
        child.stderr.on('data', (b) => { err += b; });
        child.on('error', (e) => resolve({ code: -1, out, err: String(e && e.message || e) }));
        child.on('exit', (code) => resolve({ code, out, err }));
    });
}

/** Classify one audit run: 'clean' | 'vulnerable' | 'service-error', plus detail. */
export function classify(res) {
    let report = null;
    try { report = JSON.parse(res.out); } catch { /* not JSON — treat as service/other below */ }

    // A real report carries vulnerability metadata. That is the ONLY thing that can block.
    const meta = report && report.metadata && report.metadata.vulnerabilities;
    if (meta && typeof meta.high === 'number') {
        const blocking = (meta.high || 0) + (meta.critical || 0);
        if (blocking > 0) {
            const names = report.vulnerabilities
                ? Object.values(report.vulnerabilities)
                    .filter((v) => v.severity === 'high' || v.severity === 'critical')
                    .map((v) => `${v.name} (${v.severity})`)
                : [];
            return { kind: 'vulnerable', detail: `${blocking} high/critical: ${names.join(', ') || '(see report)'}` };
        }
        return { kind: 'clean', detail: `moderate/low only (high=0, critical=0)` };
    }

    // No vulnerability data. Is npm telling us its service failed?
    const blob = (res.out + '\n' + res.err).toLowerCase();
    const serviceDown = /audit endpoint returned an error|service unavailable|503|etimedout|econnreset|enotfound|socket hang up|network|registry/.test(blob)
        || (report && report.error);
    if (serviceDown) return { kind: 'service-error', detail: (res.err || res.out).trim().slice(0, 200) };

    // Unknown shape and non-zero: be conservative and treat as a failure to investigate, not a pass.
    if (res.code !== 0) return { kind: 'unknown', detail: (res.err || res.out).trim().slice(0, 200) };
    return { kind: 'clean', detail: 'no vulnerabilities reported' };
}

// Only run the gate when invoked directly (`node scripts/ci-audit.mjs`); importing the module for a
// test gets `classify` without triggering a real `npm audit`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

async function main() {
let last = null;
for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const res = await runAudit();
    const c = classify(res);
    last = c;

    if (c.kind === 'clean') {
        console.log(`[audit] OK in ${process.cwd()} — ${c.detail}`);
        process.exit(0);
    }
    if (c.kind === 'vulnerable') {
        console.error(`[audit] BLOCKED in ${process.cwd()} — ${c.detail}`);
        console.error('[audit] This is a real advisory in a production dependency. Fix it (npm audit for details); do not bypass.');
        process.exit(1);
    }
    if (c.kind === 'unknown') {
        // An unrecognised non-zero that is NOT a known service error: fail, because we cannot prove it safe.
        console.error(`[audit] FAILED in ${process.cwd()} — unrecognised audit failure:\n${c.detail}`);
        process.exit(1);
    }
    // service-error: retry
    if (attempt < RETRIES) {
        const wait = BACKOFF_MS[attempt] || 20000;
        console.warn(`[audit] npm advisory service unavailable (attempt ${attempt + 1}/${RETRIES + 1}): ${c.detail}`);
        console.warn(`[audit] retrying in ${wait / 1000}s…`);
        await new Promise((r) => setTimeout(r, wait));
    }
}

// Every attempt hit a service-level failure. Do NOT block the whole repo on npm's outage — but say so
// as loudly as a workflow can, so a persistent outage is visible and not silently tolerated.
console.warn('::warning::[audit] npm advisory endpoint was unreachable across all retries — audit could NOT run.');
console.warn(`::warning::[audit] Skipping the audit GATE for ${process.cwd()} on this run (npm outage, not a clean bill of health). Re-run when npm recovers.`);
console.warn(`[audit] last error: ${last && last.detail}`);
process.exit(0);
}
