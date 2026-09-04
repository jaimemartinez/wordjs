#!/usr/bin/env node
/**
 * Install every workspace's dependencies with `npm ci`, IN PARALLEL, for CI.
 *
 * The five workspaces (root, backend, frontend, gateway, setup) are independent projects with their
 * own lockfiles — not npm workspaces — so `install:all` installed them one after another:
 *
 *     npm ci && cd backend && npm ci && cd ../frontend && npm ci && cd ../gateway && npm ci && ...
 *
 * That is the sum of five installs in series (~9 min observed, frontend and root ~3 min each), and it
 * ate most of the compiled-bundle job's 15-minute budget before the build even started. They do not
 * depend on each other, so they run concurrently here — wall time becomes the LONGEST single install,
 * not the sum.
 *
 * Two things this does that a `& … & wait` one-liner does not, and both matter:
 *   · FAILURE PROPAGATES. A bare `wait` returns 0 regardless of what the backgrounded jobs did, so a
 *     failed install would report success — the exact green-while-broken shape the CI gates exist to
 *     prevent. Every child's exit code is collected and any non-zero fails the whole run.
 *   · A HANG FAILS FAST. `npm ci` on a slow or wedged registry can sit silent for a long time; a
 *     per-install ceiling turns "stays there doing nothing" into a named failure well inside the job
 *     timeout, instead of letting one install consume the entire budget and cancel the job.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Each workspace, relative to the repo root. Kept explicit so a new one is a deliberate addition.
const WORKSPACES = ['.', 'backend', 'frontend', 'gateway', 'setup'];

const PER_INSTALL_MS = 10 * 60 * 1000;  // a single npm ci must not exceed this; the whole run is capped by the job timeout

function install(ws) {
    return new Promise((resolve) => {
        const cwd = path.join(ROOT, ws);
        const label = ws === '.' ? 'root' : ws;
        const started = Date.now();
        const child = spawn('npm', ['ci'], { cwd, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });

        const prefix = (buf) => buf.toString().split('\n').filter(Boolean).map((l) => `[${label}] ${l}`).join('\n');
        child.stdout.on('data', (b) => process.stdout.write(prefix(b) + '\n'));
        child.stderr.on('data', (b) => process.stderr.write(prefix(b) + '\n'));

        const timer = setTimeout(() => {
            process.stderr.write(`[${label}] TIMEOUT after ${(PER_INSTALL_MS / 60000)} min — killing npm ci\n`);
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, PER_INSTALL_MS);

        child.on('error', (e) => { clearTimeout(timer); resolve({ label, ok: false, why: String(e && e.message || e) }); });
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            const secs = ((Date.now() - started) / 1000).toFixed(0);
            const ok = code === 0 && !signal;
            process.stdout.write(`[${label}] ${ok ? 'done' : 'FAILED'} in ${secs}s${signal ? ' (killed: ' + signal + ')' : code ? ' (exit ' + code + ')' : ''}\n`);
            resolve({ label, ok, why: signal ? 'killed ' + signal : code ? 'exit ' + code : '' });
        });
    });
}

const results = await Promise.all(WORKSPACES.map(install));
const failed = results.filter((r) => !r.ok);

if (failed.length) {
    console.error(`\nci:all FAILED: ${failed.map((r) => r.label + ' (' + r.why + ')').join(', ')}`);
    process.exit(1);
}
console.log(`\nci:all OK — ${results.length} workspaces installed in parallel`);
