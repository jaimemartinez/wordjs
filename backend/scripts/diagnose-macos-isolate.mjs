/**
 * WHICH LAYER STOPS AN ISOLATED PLUGIN FROM STARTING ON macOS?
 *
 * The parity matrix records that the JS-guard suite fails on macOS in its `before` hook —
 * "Isolated plugin 'wjs-escape-ungranted' exited during startup (code 1)" — with no stderr from the
 * child, while every Seatbelt profile variant boots cleanly on its own. Two facts that cannot both be
 * the whole story, and no evidence in between.
 *
 * A real launch stacks several things on top of `fork(plugin-worker.js)`:
 *
 *     sandbox-exec -p <profile>   sh -c 'ulimit -v N; exec "$@"'   node -r ts-node/register   worker
 *     └── Seatbelt                └── memory cap                   └── source-mode preload
 *
 * Any one of them can produce "exit 1, nothing on stderr". This boots the SAME worker with those layers
 * added one at a time and reports, for each, the exit code, both output streams, and whether the child
 * ever got far enough to send `{kind:'ready'}` over IPC. The last case runs the real
 * `loadIsolatedPlugin` as the control, so a discrepancy between the reconstruction and the product is
 * itself visible rather than assumed away.
 *
 * The profile and its arguments come from `sandbox-macos`'s own exports — the functions the launch
 * calls — because a diagnostic that rebuilds the thing it is diagnosing tests its own copy.
 *
 * Non-gating. It prints evidence; it decides nothing.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const SRC_CORE = path.join(BACKEND, 'src', 'core');
const WORKER = path.join(SRC_CORE, 'plugin-worker.js');

const READY_MS = 25000;
const BOOT_CWD = { value: null };   // set to BACKEND below; C1 overrides it

function say(s = '') { process.stdout.write(s + '\n'); }

// EVERYTHING BELOW RESOLVES FROM `backend/`, NOT FROM THE CALLER'S CWD.
//
// The first run of this script measured nothing but its own launch directory. Invoked as
// `node backend/scripts/diagnose-macos-isolate.mjs` from the repository root, every layer "DIED" with
// `Cannot find module 'ts-node/register'` — it lives in backend/node_modules — the Seatbelt profile
// could not be built for the same reason, and the real-loader control failed compiling app.ts because
// ts-node never found backend/tsconfig.json. Four red results, none of them about macOS.
//
// So the preload is resolved to an ABSOLUTE path and every child is spawned with cwd=backend. A
// diagnostic that can be broken by where it was started is not evidence.
BOOT_CWD.value = BACKEND;
let seatbeltProfileText = '';
const backendRequire = createRequire(path.join(BACKEND, 'package.json'));
let TSNODE = [];
let tsNodeNote = '';
try {
    TSNODE = ['-r', backendRequire.resolve('ts-node/register')];
    tsNodeNote = TSNODE[1];
} catch (e) {
    tsNodeNote = `NOT RESOLVABLE from ${BACKEND}: ${String(e && e.message || e)}`;
}

// ── a trivial, honest plugin: it registers nothing and does nothing ────────────────────────────────
const SLUG = 'wjs-macos-diag';
const PLUG_DIR = path.join(BACKEND, 'plugins', SLUG);
fs.rmSync(PLUG_DIR, { recursive: true, force: true });
fs.mkdirSync(PLUG_DIR, { recursive: true });
fs.writeFileSync(path.join(PLUG_DIR, 'manifest.json'),
    JSON.stringify({ name: SLUG, isolated: true, permissions: [] }));
fs.writeFileSync(path.join(PLUG_DIR, 'index.js'), 'exports.init = function () {};\n');
const ENTRY = path.join(PLUG_DIR, 'index.js');

const cfg = JSON.stringify({
    slug: SLUG, entryFile: ENTRY, coreDir: SRC_CORE,
    network: false, allowedHosts: [], egressDenyAll: false,
    fsRead: [], fsWrite: [], storage: null,
    envAllow: ['PATH', 'HOME', 'TMPDIR', 'NODE_ENV', 'LANG'],
});

const SAFE_ENV = {};
for (const k of ['PATH', 'HOME', 'TMPDIR', 'NODE_ENV', 'LANG']) {
    if (process.env[k] !== undefined) SAFE_ENV[k] = process.env[k];
}

/** Boot one variant and report what happened, without deciding what it means. */
function boot(label, cmd, args) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(cmd, args, { cwd: BOOT_CWD.value, env: SAFE_ENV, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        } catch (e) {
            resolve({ label, spawnError: String(e && e.message || e) });
            return;
        }
        let out = '', err = '', ready = false, settled = false;
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('message', (m) => { if (m && m.kind === 'ready') { ready = true; finish({ exit: 'alive' }); } });

        const timer = setTimeout(() => finish({ exit: 'timeout' }), READY_MS);
        child.on('error', (e) => finish({ exit: 'spawn-error', why: String(e && e.message || e) }));

        // WAIT FOR THE STREAMS, NOT THE PROCESS. 'exit' fires when the child is gone, which can be
        // BEFORE its stdout/stderr have been drained — so a child that printed its error and died fast
        // is reported as "said nothing at all". C1 came back with both streams empty and that is very
        // likely why: the diagnosis was thrown away by the diagnostic. 'close' fires only once every
        // stdio stream has ended, so the output is complete by then.
        let closed = 0;
        let exitInfo = null;
        const maybeFinish = () => { if (exitInfo && closed >= 2) finish(exitInfo); };
        child.stdout.on('close', () => { closed++; maybeFinish(); });
        child.stderr.on('close', () => { closed++; maybeFinish(); });
        child.on('exit', (code, signal) => {
            exitInfo = { exit: code, signal };
            // A hard ceiling so a child that leaves a stream open cannot hang the whole bisect.
            setTimeout(() => finish(exitInfo), 1500);
            maybeFinish();
        });

        function finish(o) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
            resolve({ label, ready, out: out.trim().slice(0, 900), err: err.trim().slice(0, 900), ...o });
        }
    });
}

/** boot(), with the working directory chosen — C1 needs it. */
function bootAt(label, cwd, cmd, args) {
    const saved = BOOT_CWD.value;
    BOOT_CWD.value = cwd;
    return boot(label, cmd, args).finally(() => { BOOT_CWD.value = saved; });
}

const NODE = process.execPath;

const results = [];

say('=== macOS isolate bisect ===');
say(`node        : ${process.version}`);
say(`platform    : ${process.platform} ${os.release()}`);
say(`worker      : ${WORKER}`);
say(`cwd (spawns): ${BACKEND}`);
say(`ts-node     : ${tsNodeNote}`);
say('');

// L0 — no confinement at all. If this fails, nothing above it is the cause.
results.push(await boot('L0  bare fork (ts-node preload only)', NODE, [...TSNODE, WORKER, cfg]));

// L1 — the memory-cap shell wrapper on its own.
//
// POSIX only. On Windows this leg reports a false DIED: there is no real argv array, Node builds a
// command-line STRING, and the backslashes in a Windows path inside the cfg JSON come back out of `sh`
// as invalid escapes — `SyntaxError: Bad escaped character in JSON`. That is the harness meeting
// Windows quoting, not the wrapper failing, and a diagnostic that reports it as a layer death is
// worse than one that skips it. macOS and Linux pass a genuine argv array and are unaffected.
const POSIX = process.platform !== 'win32';
if (POSIX) {
    results.push(await boot("L1  + sh -c 'ulimit -v; exec' wrapper", 'sh',
        ['-c', 'ulimit -v 1048576 2>/dev/null; exec "$@"', 'wjs-diag', NODE, ...TSNODE, WORKER, cfg]));
} else {
    say('L1 skipped: the shell wrapper leg is POSIX-only (Windows argv quoting mangles the cfg JSON).');
}

// L2 — Seatbelt on its own, with the profile the product would build.
let seatbelt = null;
let profileNote = '';
try {
    const req = createRequire(path.join(BACKEND, 'package.json'));
    process.chdir(BACKEND);          // ts-node reads tsconfig.json relative to cwd
    req(backendRequire.resolve('ts-node/register'));
    const mac = req(path.join(SRC_CORE, 'sandbox-macos.ts'));
    const paths = req(path.join(SRC_CORE, 'sandbox-paths.ts'));
    const APP_ROOT = path.resolve(BACKEND);
    const np = paths.sandboxPaths ? paths.sandboxPaths(APP_ROOT, SLUG, SRC_CORE) : null;
    // `readOnly`, not `readable`. The first draft used the wrong key; buildSeatbeltProfile then saw
    // `undefined`, quietly fell back to `[appRoot]`, and would have profiled something the product never
    // builds. A diagnostic fed the wrong inputs does not report a weaker truth, it reports a different
    // subject — so the shape is asserted rather than trusted.
    if (!np || !Array.isArray(np.writable) || !Array.isArray(np.readOnly)) {
        throw new Error(`sandboxPaths returned ${JSON.stringify(np)} — expected { writable: [], readOnly: [] }`);
    }
    const profile = mac.buildSeatbeltProfile({
        writableDirs: np.writable,
        readOnlyDirs: np.readOnly,
        readOnlyFiles: [],
        denyNetwork: true,
        appRoot: APP_ROOT,
        nodePath: NODE,
    });
    const problems = mac.auditProfile(profile);
    profileNote = problems.length ? `profile audit problems: ${problems.join(' | ')}` : 'profile audit clean';
    seatbeltProfileText = profile;
    seatbelt = [mac.SEATBELT_BIN, ...mac.seatbeltArgs(profile, [])];
    say(`[profile] ${profileNote}`);
    say(`[profile] ${profile.split('\n').length} lines, writable=${JSON.stringify(np ? np.writable : [PLUG_DIR])}`);
    say('');
} catch (e) {
    say(`[profile] could not build one: ${String(e && e.message || e)}`);
    say('');
}

if (seatbelt) {
    results.push(await boot('L2  + Seatbelt only', seatbelt[0], [...seatbelt.slice(1), NODE, ...TSNODE, WORKER, cfg]));
    if (POSIX) {
        results.push(await boot('L3  + Seatbelt AND the shell wrapper', seatbelt[0],
            [...seatbelt.slice(1), 'sh', '-c', 'ulimit -v 1048576 2>/dev/null; exec "$@"', 'wjs-diag', NODE, ...TSNODE, WORKER, cfg]));
    }
} else {
    say('L2/L3 skipped: no Seatbelt profile');
}

// ── THE QUESTION THE FIRST BISECT RAISED ──────────────────────────────────────────────────────────
//
// L2 died in `loadPreloadModules` — Node calling getcwd() to resolve the `-r ts-node/register`
// preload, and Seatbelt refusing because reading the working directory needs read access to its
// ANCESTOR chain, which sandboxPaths deliberately does not grant (no APP_ROOT: the config, the
// database and every sibling plugin live there).
//
// If that is the whole story then the failure belongs to SOURCE mode only, because compiled production
// passes no `-r` at all. That is the difference between "macOS cannot run plugins" and "macOS cannot
// run plugins from a source checkout", and it is not something to assume in either direction.
//
// L5/L6 boot the COMPILED worker with no preload. If they boot where L2 died, the preload is the
// trigger and production is unaffected; if they die too, getcwd is reached by another path and the
// problem is the ancestor grant itself.
const DIST_CORE = path.join(BACKEND, 'dist', 'core');
const DIST_WORKER = path.join(DIST_CORE, 'plugin-worker.js');
const distCfg = JSON.stringify({ ...JSON.parse(cfg), coreDir: DIST_CORE });
if (fs.existsSync(DIST_WORKER)) {
    results.push(await boot('L5  compiled worker, NO preload, no confinement', NODE, [DIST_WORKER, distCfg]));
    // THE PROFILE MUST BE BUILT FOR THE TREE BEING RUN. The first version of this leg profiled
    // src/core and then executed dist/core, so it died with
    // `EPERM: open .../dist/core/plugin-worker.js` — the sandbox correctly refusing a directory nobody
    // had granted. That said nothing about whether compiled production works; it said the harness
    // pointed the profile at the wrong tree. A separate profile is built here from the SAME
    // sandboxPaths call the product makes, with coreDir set to dist.
    let distSeatbelt = null;
    try {
        const req = createRequire(path.join(BACKEND, 'package.json'));
        const mac = req(path.join(SRC_CORE, 'sandbox-macos.ts'));
        const paths = req(path.join(SRC_CORE, 'sandbox-paths.ts'));
        const dnp = paths.sandboxPaths(BACKEND, SLUG, DIST_CORE);
        const dprofile = mac.buildSeatbeltProfile({
            writableDirs: dnp.writable, readOnlyDirs: dnp.readOnly, readOnlyFiles: [],
            denyNetwork: true, appRoot: BACKEND, nodePath: NODE,
        });
        const dproblems = mac.auditProfile(dprofile);
        say(`[profile:dist] ${dproblems.length ? 'audit problems: ' + dproblems.join(' | ') : 'audit clean'}`);
        distSeatbelt = [mac.SEATBELT_BIN, ...mac.seatbeltArgs(dprofile, [])];
    } catch (e) {
        say(`[profile:dist] could not build one: ${String(e && e.message || e)}`);
    }
    if (distSeatbelt) {
        results.push(await boot('L6  compiled worker, NO preload, + Seatbelt (profile built for dist)',
            distSeatbelt[0], [...distSeatbelt.slice(1), NODE, DIST_WORKER, distCfg]));
    }
} else {
    say(`L5/L6 skipped: ${DIST_WORKER} does not exist (run \`npm run build\` in backend/)`);
}


// ══ CANDIDATE FIXES ═══════════════════════════════════════════════════════════════════════════════
//
// The mechanic is settled: Node calls getcwd() in loadPreloadModules, and macOS resolves a working
// directory by reading its ancestor chain, which the profile withholds by design. Four ways out, with
// very different costs. They are tested TOGETHER, in one run, because guessing one per run is how the
// last two commits went.
//
//   C1  cwd = "/"            — resolving "/" needs no ancestors. Costs nothing in the profile, but
//                              changes what a relative path inside a plugin means.
//   C2  file-read-metadata   — grants stat/exists everywhere, never contents or listings. If getcwd is
//                              satisfied by metadata this is nearly free; the kernel logged a
//                              file-read-DATA denial, so it probably is not. Worth settling.
//   C3  literal ancestors    — grants LISTING of exactly the directories above the app root, and
//                              nothing below them. Surgical, and the most likely to work. It does hand
//                              a plugin the filenames next to wordjs-config.json, which is precisely
//                              what sandboxPaths says it withholds on purpose.
//   C4  no -r preload        — the worker requires ts-node itself, resolving from its OWN directory
//                              rather than from cwd, so getcwd is never reached. Weakens nothing.
//                              If this boots, it is the answer.
if (seatbelt && POSIX) {
    // C1 — same profile, cwd at the root.
    results.push(await bootAt('C1  cwd="/" (same profile)', '/', seatbelt[0],
        [...seatbelt.slice(1), NODE, ...TSNODE, WORKER, cfg]));

    // C2 / C3 — the same profile with one extra grant appended. Appended AFTER the audit on purpose:
    // this is an experiment, not a proposal, and the audit judges what the product would ship.
    const ancestors = [];
    for (let d = path.dirname(BACKEND); d && d !== path.dirname(d); d = path.dirname(d)) ancestors.push(d);

    const variants = [
        ['C2  + (allow file-read-metadata)', '(allow file-read-metadata)'],
        ['C3  + literal read on each ancestor',
            ancestors.map((d) => `(allow file-read* (literal "${d}"))`).join('\n')],
    ];
    for (const [label, extra] of variants) {
        try {
            const req = createRequire(path.join(BACKEND, 'package.json'));
            const mac = req(path.join(SRC_CORE, 'sandbox-macos.ts'));
            const widened = seatbeltProfileText + '\n' + extra + '\n';
            const args = mac.seatbeltArgs(widened, []);
            results.push(await boot(label, mac.SEATBELT_BIN, [...args, NODE, ...TSNODE, WORKER, cfg]));
        } catch (e) {
            results.push({ label, exit: 'harness-error', err: String(e && e.message || e).slice(0, 300), out: '' });
        }
    }

    // C5 — THE CANONICAL TECHNIQUE, from how other macOS sandboxes solve exactly this.
    //
    // Chromium's Seatbelt design and the SBPL references both describe chdir-ing to "/" before
    // entering the sandbox, precisely so the working directory has no ancestors left to resolve.
    // getcwd() then returns "/" with nothing to check, and NOTHING in the profile has to be widened.
    //
    // C1 tried the cwd half alone and came back with both streams empty — which the harness race fixed
    // above would have hidden. It was also missing the other half: with cwd="/", ts-node searches for
    // tsconfig.json from "/" and never finds it. TS_NODE_PROJECT names the file outright, which the
    // ts-node docs give as the way to skip the search entirely.
    try {
        const shimEnv = { ...SAFE_ENV, TS_NODE_PROJECT: path.join(BACKEND, 'tsconfig.json') };
        const saved = BOOT_CWD.value;
        BOOT_CWD.value = '/';
        const savedEnv = { ...SAFE_ENV };
        Object.assign(SAFE_ENV, shimEnv);
        results.push(await boot('C5  cwd="/" + TS_NODE_PROJECT (no profile change at all)',
            seatbelt[0], [...seatbelt.slice(1), NODE, ...TSNODE, WORKER, cfg]));
        BOOT_CWD.value = saved;
        for (const k of Object.keys(SAFE_ENV)) delete SAFE_ENV[k];
        Object.assign(SAFE_ENV, savedEnv);
    } catch (e) {
        results.push({ label: 'C5  cwd="/" + TS_NODE_PROJECT', exit: 'harness-error', err: String(e && e.message || e).slice(0, 300), out: '' });
    }

    // C4 — no preload at all: a shim that registers ts-node from its own location, then loads the
    // worker. argv[2] (the cfg) is untouched, so the worker sees exactly what it always sees.
    try {
        const shim = path.join(BACKEND, 'plugins', SLUG, '__no-preload-shim.js');
        fs.writeFileSync(shim,
            `require(${JSON.stringify(TSNODE[1] || 'ts-node/register')});\n`
            + `require(${JSON.stringify(WORKER)});\n`);
        results.push(await boot('C4  no -r preload (worker registers ts-node itself)',
            seatbelt[0], [...seatbelt.slice(1), NODE, shim, cfg]));
    } catch (e) {
        results.push({ label: 'C4  no -r preload', exit: 'harness-error', err: String(e && e.message || e).slice(0, 300), out: '' });
    }
}

// L4 — the product's own path, as the control.
try {
    const req = createRequire(path.join(BACKEND, 'package.json'));
    process.chdir(BACKEND);          // ts-node reads tsconfig.json relative to cwd
    req(backendRequire.resolve('ts-node/register'));
    const cfgApp = req(path.join(BACKEND, 'src', 'config', 'app.ts'));
    cfgApp.dbPath = path.join(os.tmpdir(), `wjs-macos-diag-${process.pid}.db`);
    cfgApp.dbDriver = 'sqlite-native';
    req(path.join(BACKEND, 'src', 'config', 'database.ts'));
    const iso = req(path.join(SRC_CORE, 'plugin-isolate.ts'));
    const started = Date.now();
    try {
        await iso.loadIsolatedPlugin(SLUG, ENTRY);
        results.push({ label: 'L4  real loadIsolatedPlugin', ready: true, exit: 'alive', out: `booted in ${Date.now() - started}ms`, err: '' });
        try { await iso.unloadIsolatedPlugin(SLUG); } catch { /* */ }
    } catch (e) {
        results.push({ label: 'L4  real loadIsolatedPlugin', ready: false, exit: 'threw', err: String(e && e.message || e).slice(0, 900), out: '' });
    }
} catch (e) {
    results.push({ label: 'L4  real loadIsolatedPlugin', exit: 'harness-error', err: String(e && e.message || e).slice(0, 400), out: '' });
}

say('=== results ===');
for (const r of results) {
    const verdict = r.ready ? 'BOOTED' : (r.exit === 'timeout' ? 'HUNG' : `DIED (exit=${r.exit}${r.signal ? ' sig=' + r.signal : ''})`);
    say('');
    say(`${r.label}`);
    say(`   verdict : ${verdict}`);
    if (r.spawnError) say(`   spawn   : ${r.spawnError}`);
    if (r.err) say(`   stderr  : ${r.err.replace(/\n/g, '\n             ')}`);
    if (r.out) say(`   stdout  : ${r.out.replace(/\n/g, '\n             ')}`);
    if (!r.err && !r.out && !r.ready) say('   (both streams empty — the child said nothing at all)');
}

say('');
say('=== reading this ===');
say('The FIRST layer that changes BOOTED to DIED is the one to look at. If L0 already dies, no');
say('confinement layer is involved and the cause is in the worker or its preload. If L4 disagrees with');
say('the reconstruction above it, the difference between them is the finding.');

fs.rmSync(PLUG_DIR, { recursive: true, force: true });
process.exit(0);
