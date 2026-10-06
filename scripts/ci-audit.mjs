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
 *
 * EXCEPTIONS (scripts/audit-exceptions.json). Sometimes an advisory has NO fixed release anywhere, and
 * blocking on it makes every pull request un-mergeable for as long as upstream takes. An exception is
 * the narrowest possible way through: it names ONE advisory id of ONE package, carries the reasoning for
 * why our code cannot reach the vulnerable function, and EXPIRES (at most 60 days after it was added).
 * A package is let through only when every high/critical advisory behind it is excepted, directly or via
 * the packages it depends on — any other advisory on the same package still blocks. An expired exception
 * blocks again, an unreadable or malformed file blocks everything, and an exception that no longer
 * matches anything is reported so it gets removed.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LEVEL = 'high';               // block at high and above (high + critical)
const RETRIES = 1;                  // 2 attempts total — see PER_ATTEMPT_MS for why this is bounded
const BACKOFF_MS = [8000];
const PER_ATTEMPT_MS = 75000;       // kill a single npm audit that hangs on a down endpoint

// WHY A PER-ATTEMPT TIMEOUT EXISTS. The first version of this wrapper retried up to four times with no
// per-attempt cap. On a persistently-down advisory endpoint each `npm audit` hangs while npm does its
// OWN internal retries — ~2 min apiece — so four of them plus backoff took ~8 min and blew the job's
// 10-min budget. That made the resilient audit SLOWER than the hard-fail it replaced. Now each attempt
// is killed at 75s and counted as a service failure, so the whole gate is bounded to roughly
// 75s + 8s + 75s ≈ 2.5 min even when npm is completely down.
function runAudit() {
    return new Promise((resolve) => {
        const child = spawn('npm', ['audit', '--omit=dev', `--audit-level=${LEVEL}`, '--json'],
            { cwd: process.cwd(), shell: process.platform === 'win32' });
        let out = '', err = '', timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, PER_ATTEMPT_MS);
        child.stdout.on('data', (b) => { out += b; });
        child.stderr.on('data', (b) => { err += b; });
        child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e && e.message || e) }); });
        child.on('exit', (code) => {
            clearTimeout(timer);
            if (timedOut) resolve({ code: -1, out, err: `npm audit did not return within ${PER_ATTEMPT_MS / 1000}s — treating as service unavailable` });
            else resolve({ code, out, err });
        });
    });
}

export const EXCEPTIONS_FILE = fileURLToPath(new URL('./audit-exceptions.json', import.meta.url));
export const MAX_EXCEPTION_DAYS = 60;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (s) => typeof s === 'string' && DATE_RE.test(s)
    && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const isBlocking = (severity) => severity === 'high' || severity === 'critical';

/**
 * Parse and validate audit-exceptions.json. Throws on anything malformed: a broken file must never widen
 * the gate, so the caller turns a throw into a failed audit.
 */
export function loadExceptions(text) {
    const doc = JSON.parse(text);
    if (!doc || !Array.isArray(doc.exceptions)) throw new Error('audit-exceptions.json: expected { "exceptions": [ ... ] }');
    return doc.exceptions.map((e, i) => {
        const where = `audit-exceptions.json exceptions[${i}]`;
        if (!e || typeof e !== 'object') throw new Error(`${where}: not an object`);
        if (typeof e.package !== 'string' || !e.package) throw new Error(`${where}: "package" is required`);
        if (!Number.isInteger(e.advisory) || e.advisory <= 0) throw new Error(`${where}: "advisory" must be the npm advisory id (the "source" number in npm audit --json)`);
        for (const k of ['added', 'expires']) if (!isRealDate(e[k])) throw new Error(`${where}: "${k}" must be a YYYY-MM-DD date`);
        const days = (Date.parse(`${e.expires}T00:00:00Z`) - Date.parse(`${e.added}T00:00:00Z`)) / 86400000;
        if (days < 0 || days > MAX_EXCEPTION_DAYS) throw new Error(`${where}: "expires" must fall within ${MAX_EXCEPTION_DAYS} days of "added"`);
        if (typeof e.reason !== 'string' || e.reason.trim().length < 40) throw new Error(`${where}: "reason" must explain why the advisory cannot be reached`);
        return { package: e.package, advisory: e.advisory, added: e.added, expires: e.expires, url: typeof e.url === 'string' ? e.url : '', reason: e.reason.trim() };
    });
}

/**
 * Split the report's high/critical packages into the ones that still block and the ones whose every
 * high/critical cause is an active exception (on that package) or another package cleared the same way.
 * Conservative throughout: a cycle, a cause of an unknown shape, or a blocking package whose blocking
 * cause cannot be seen all count as blocking.
 */
function applyExceptions(vulns, exceptions, today) {
    const active = exceptions.filter((e) => today <= e.expires);
    const used = new Set();
    const expiredHits = new Set();
    const memo = new Map();
    const cleared = (name, stack) => {
        const v = vulns[name];
        if (!v || !isBlocking(v.severity)) return true;
        if (memo.has(name)) return memo.get(name);
        if (stack.has(name)) return false;
        stack.add(name);
        let ok = true;
        let sawCause = false;
        for (const cause of Array.isArray(v.via) ? v.via : []) {
            if (typeof cause === 'string') {
                const dep = vulns[cause];
                if (!dep || !isBlocking(dep.severity)) continue;
                sawCause = true;
                if (!cleared(cause, stack)) ok = false;
            } else if (cause && typeof cause === 'object') {
                if (!isBlocking(cause.severity)) continue;
                sawCause = true;
                const hit = active.find((e) => e.package === name && (cause.name === undefined || cause.name === name) && e.advisory === cause.source);
                if (hit) used.add(hit);
                else {
                    ok = false;
                    for (const e of exceptions) if (e.package === name && e.advisory === cause.source && today > e.expires) expiredHits.add(e);
                }
            } else {
                sawCause = true;
                ok = false;
            }
        }
        stack.delete(name);
        const result = ok && sawCause;
        memo.set(name, result);
        return result;
    };
    const blocked = [];
    const excepted = [];
    for (const v of Object.values(vulns)) {
        if (!isBlocking(v.severity)) continue;
        (cleared(v.name, new Set()) ? excepted : blocked).push(v);
    }
    return { blocked, excepted, used: [...used], expired: [...expiredHits] };
}

/**
 * Classify one audit run: 'clean' | 'vulnerable' | 'service-error' | 'unknown', plus detail. With
 * `exceptions` (from loadExceptions), a report whose only high/critical advisories are excepted is
 * 'clean' and lists them in `excepted`.
 */
export function classify(res, { exceptions = [], today = new Date().toISOString().slice(0, 10) } = {}) {
    let report = null;
    try { report = JSON.parse(res.out); } catch { /* not JSON — treat as service/other below */ }

    // A real report carries vulnerability metadata. That is the ONLY thing that can block.
    const meta = report && report.metadata && report.metadata.vulnerabilities;
    if (meta && typeof meta.high === 'number') {
        const blocking = (meta.high || 0) + (meta.critical || 0);
        if (blocking > 0) {
            if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
                return { kind: 'vulnerable', detail: `${blocking} high/critical: (see report)` };
            }
            const r = applyExceptions(report.vulnerabilities, exceptions, today);
            if (r.blocked.length || !r.excepted.length) {
                const names = r.blocked.map((v) => `${v.name} (${v.severity})`);
                const expired = r.expired.map((e) => `${e.package} advisory ${e.advisory} expired ${e.expires}`);
                return {
                    kind: 'vulnerable',
                    detail: `${names.length || blocking} high/critical: ${names.join(', ') || '(see report)'}${expired.length ? ` — exception expired: ${expired.join('; ')}` : ''}`,
                    expired: r.expired,
                };
            }
            return {
                kind: 'clean',
                detail: `high/critical only through excepted advisories: ${r.excepted.map((v) => `${v.name} (${v.severity})`).join(', ')}`,
                excepted: r.used,
            };
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
let exceptions = [];
try {
    exceptions = loadExceptions(readFileSync(EXCEPTIONS_FILE, 'utf8'));
} catch (e) {
    if (!(e && e.code === 'ENOENT')) {
        console.error(`[audit] FAILED in ${process.cwd()} — ${e && e.message}`);
        process.exit(1);
    }
}
let last = null;
for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const res = await runAudit();
    const c = classify(res, { exceptions });
    last = c;

    if (c.kind === 'clean') {
        console.log(`[audit] OK in ${process.cwd()} — ${c.detail}`);
        // Visible on every run, as a workflow annotation, until the exception is removed or expires.
        for (const e of c.excepted || []) {
            console.warn(`::warning::[audit] EXCEPTED ${e.package} advisory ${e.advisory} until ${e.expires} (${e.url || 'see scripts/audit-exceptions.json'}): ${e.reason}`);
        }
        process.exit(0);
    }
    if (c.kind === 'vulnerable') {
        console.error(`[audit] BLOCKED in ${process.cwd()} — ${c.detail}`);
        console.error('[audit] This is a real advisory in a production dependency. Fix it (npm audit for details); do not bypass.');
        console.error('[audit] Only when NO fixed release exists anywhere: a dated, per-advisory exception in scripts/audit-exceptions.json, with the reachability analysis.');
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
