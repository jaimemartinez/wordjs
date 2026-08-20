/**
 * WordJS - Isolated Plugin Host (child_process, OS-level isolation, no native deps)
 *
 * Loads a plugin marked `"isolated": true` in a SEPARATE OS PROCESS (child_process.fork) — its own
 * heap, event loop, and OS memory cap, so a crash, OOM, or heap escape is contained to the child and
 * never reaches the host (a worker_thread, by contrast, shared the host heap/rss). The plugin reaches
 * core ONLY via the `wordjs` bridge, whose calls are RPC'd here (over the IPC channel) and run through
 * createPluginApi() (permission-checked, in the plugin's context). Hooks/filters the plugin registers
 * become shims in the real hook system that call back into the isolate. The host's heap (secrets, DB
 * handle, other plugins) is unreachable from the child. See documentation/plugin-isolation-proposal.md.
 */

const { fork, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { sandboxPaths } = require('./sandbox-paths');
const { createPluginApi } = require('./plugin-api');
const { runWithContext } = require('./plugin-context');
// The ACTIVE CORPORATE MAILBOX grant, read the one way (core/mailbox.ts) — never re-derived.
const { hasProfessionalMailbox } = require('./mailbox');
const hooks = require('./hooks');
const { addShortcode, removeShortcode } = require('./shortcodes');

const WORKER_FILE = path.join(__dirname, 'plugin-worker.js');
const isolates = new Map<string, any>();

// Reaper for plugin multipart temp uploads. The per-request cleanup in finalHandler unlinks the file on
// the happy path; this sweeps files ORPHANED by a host crash/restart (or a handler that never responded)
// so os-tmp/wordjs-uploads can't accumulate unbounded. Started lazily when the first multipart route is
// registered; the interval is unref'd so it never keeps the process alive.
let _uploadReaperStarted = false;
function startUploadReaper(): void {
    if (_uploadReaperStarted) return;
    _uploadReaperStarted = true;
    const os = require('os');
    const fsm = require('fs');
    const dir = path.join(os.tmpdir(), 'wordjs-uploads');
    const MAX_AGE_MS = 60 * 60 * 1000; // reap temp uploads older than 1h (well past any 10MB in-flight upload)
    const sweep = () => {
        fsm.readdir(dir, (err: any, files: string[]) => {
            if (err) return; // dir may not exist yet
            const cutoff = Date.now() - MAX_AGE_MS;
            for (const f of files) {
                const fp = path.join(dir, f);
                fsm.stat(fp, (e: any, st: any) => { if (!e && st.isFile() && st.mtimeMs < cutoff) fsm.unlink(fp, () => { /* best effort */ }); });
            }
        });
    };
    sweep(); // catch orphans left by a previous run immediately
    const t = setInterval(sweep, 30 * 60 * 1000);
    if (t.unref) t.unref();
}

// Forward a child's piped stdout/stderr to the host, slug-TAGGED and RATE-LIMITED, so a plugin
// console.log flood can't fill the operator's log sink (the IPC guards sit on a separate fd and don't
// cover the inherited stdio). Line-buffered; beyond the per-window byte budget, output is dropped with a
// single notice until the window rolls. Best-effort — never throws into the spawn path.
function attachLogLimiter(slug: string, child: any): void {
    const TAG = `[plugin ${slug}] `;
    const MAX_BYTES_PER_WINDOW = 512 * 1024; // 512KB per 10s per stream
    const WINDOW_MS = 10000;
    const makeSink = (out: NodeJS.WritableStream) => {
        let buf = '';
        let windowStart = Date.now();
        let windowBytes = 0, dropped = 0, notified = false;
        return (chunk: Buffer) => {
            try {
                const now = Date.now();
                if (now - windowStart > WINDOW_MS) {
                    windowStart = now; windowBytes = 0; notified = false;
                    if (dropped) { out.write(`${TAG}(rate limit: dropped ${dropped} bytes)\n`); dropped = 0; }
                }
                buf += chunk.toString('utf8');
                let nl: number;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl + 1);
                    buf = buf.slice(nl + 1);
                    const bytes = Buffer.byteLength(line); // real bytes, not UTF-16 code units
                    if (windowBytes >= MAX_BYTES_PER_WINDOW) {
                        dropped += bytes;
                        if (!notified) { out.write(`${TAG}output rate-limited\n`); notified = true; }
                        continue;
                    }
                    windowBytes += bytes;
                    out.write(TAG + line);
                }
                if (buf.length > 65536) { // flush an over-long partial line so we don't buffer unbounded
                    const bytes = Buffer.byteLength(buf);
                    if (windowBytes < MAX_BYTES_PER_WINDOW) { out.write(TAG + buf + '\n'); windowBytes += bytes; }
                    else dropped += bytes;
                    buf = '';
                }
            } catch { /* logging must never destabilize the host */ }
        };
    };
    try { if (child.stdout) child.stdout.on('data', makeSink(process.stdout)); } catch { /* */ }
    try { if (child.stderr) child.stderr.on('data', makeSink(process.stderr)); } catch { /* */ }
}

// ── Runtime supervisor + per-isolate health ──────────────────────────────────────────────────
// The sandbox already CONTAINS a crash (the child dies alone). But a mid-run crash used to silently
// delete the isolate, 404 its routes, and vanish its admin menu while the plugin still read as green
// 'active' — invisible and unrecoverable without a manual reload. This makes isolation VISIBLE and
// SELF-HEALING: we track per-plugin state/pid/rss/restarts + the death reason, auto-restart a crashed
// child with bounded exponential backoff, and give up (crash-looping) after too many failures.
//
// Health is keyed by SLUG (survives reload, which recreates the ephemeral handle), telemetry that is
// per-child (pid/startedAt/rss) is refreshed on each (re)load.
type IsolateHealth = {
    state: 'running' | 'restarting' | 'crashed' | 'crash-looping' | 'stopped';
    pid: number | null; startedAt: number; restarts: number;
    lastExitCode: number | null; lastError: string | null; rssBytes: number | null;
    crashWindow: number[]; // timestamps of recent auto-restarts (crash-loop detection)
};
const isolateHealth = new Map<string, IsolateHealth>();
const restartTimers = new Map<string, NodeJS.Timeout>();
const stopping = new Set<string>(); // slugs whose exit is an INTENTIONAL unload (skip supervision)

/**
 * Loads currently IN FLIGHT, per slug — registered synchronously by loadIsolatedPlugin BEFORE it awaits
 * anything, and removed when the load settles.
 *
 * It buys two things the other registries cannot:
 *
 *  1. SAME-SLUG SAFETY. `isolates` holds ONE handle per slug, so a second concurrent load of the same slug
 *     used to overwrite the first — and the overwritten child was then absent from `isolates`, from
 *     `restartTimers` and from every enumeration built on them, while still running, still holding the
 *     hooks/filters/shortcodes it had registered, and unreachable by unloadIsolatedPlugin or any sweep.
 *     An admin double-clicking "activate", or two admins acting at once, was enough. A second load for a
 *     slug whose load is already running now JOINS it instead of forking a rival child.
 *
 *  2. IN-FLIGHT VISIBILITY. `isolates.set` runs at the END of the load executor, so between the call and
 *     that line a slug is in NEITHER registry. superviseRestart walks straight through that window (it
 *     deletes its restartTimers entry and calls right in here), so an enumeration taken there missed the
 *     slug entirely and a sweep based on it skipped a child that was about to exist. listIsolates() unions
 *     this map for exactly that reason, and awaitIsolateSettled lets a sweeper wait the load out instead
 *     of racing it.
 *
 * Keyed by slug, valued with the entry file so a load for a DIFFERENT entry file never silently joins the
 * wrong child (it waits for the in-flight one to settle and then starts its own).
 */
const loading = new Map<string, { promise: Promise<any>; entryFile: string }>();

/**
 * Strip line breaks from a value before it goes into a log line. Nearly every message in this module
 * carries the plugin SLUG, plus a plugin-supplied hook name, route method or error text — all
 * request-derived, so an unescaped one can forge or split entries in the operator's log. Passing such a
 * template literal FOLLOWED by more arguments additionally makes it a console format string, so `%s`
 * in a crafted value consumes what comes after it: every console call here builds ONE sanitized string.
 *
 * TWO single-constant replacements with an empty replacement is deliberate — the log-injection analysis
 * recognises a sanitizer SYNTACTICALLY, and an alternation (`/\n|\r/g`) has no constant value, so it is
 * not matched. Match the documented remediation shape, not an equivalent of it.
 */
function logSafe(v: any): string {
    return String(v == null ? '' : v).replace(/\n/g, '').replace(/\r/g, '');
}

/**
 * Child pids this process spawned for a slug and has NOT yet seen exit, per slug.
 *
 * The isolate REGISTRY is not proof of liveness in either direction, and both directions matter:
 * unloadIsolatedPlugin drops the registry entry synchronously but `kill(SIGKILL)` is asynchronous, so
 * a slug can be absent from `isolates` while its process is still running — which is all the DELETE
 * route could check before it rmSync'd the plugin directory. A pid is added at spawn and removed in
 * the child's own 'exit' handler, so membership means "we spawned it and have not observed its death";
 * that is exact and immune to pid reuse (a recycled pid belongs to a process we never added).
 * A reload can transiently have two (the outgoing child and the new one), hence a Set per slug.
 */
const livePids = new Map<string, Set<number>>();
function addLivePid(slug: string, pid: number) {
    let s = livePids.get(slug);
    if (!s) { s = new Set<number>(); livePids.set(slug, s); }
    if (!s.has(pid)) { s.add(pid); retainIpcFrameGuard(); }
}
function dropLivePid(slug: string, pid: number | undefined) {
    const s = livePids.get(slug);
    if (!s || !pid) return;
    if (s.delete(pid)) releaseIpcFrameGuard();
    if (s.size === 0) livePids.delete(slug);
}
/** Pids we spawned for this slug and have not observed exiting. Empty ⇒ nothing of ours is running. */
function getLivePids(slug: string): number[] { return Array.from(livePids.get(slug) || []); }

// --- IPC-frame containment guard (backend/src/tests flake + a plugin→host DoS) -------------------
// The bridge reads each isolated child over a child_process IPC channel in `serialization:'advanced'`
// mode (V8 structured clone, length-prefixed frames). If a frame arrives MISALIGNED — a truncated write
// from a force-killed child, two interleaved writers under saturation, or a plugin that writes RAW BYTES
// straight to its own IPC fd (fd 3) instead of via process.send — Node's INTERNAL channel reader throws
//     Error: Unable to deserialize cloned data due to invalid or unsupported version.
// from `parseChannelMessages` inside `channel.onread` (node:internal/child_process/serialization). That
// throw happens BEFORE the 'message' event, so the `try/catch` around worker.on('message') below cannot
// see it: it escapes as an uncaughtException and KILLS the reading process. On CI that reading process is
// a `node --test` file-subprocess, so a random UNRELATED test file dies with this exact error and its
// results never arrive (the flake). The fix is not to catch it at the message layer (impossible) nor to
// wrap the channel handle (Node hides `onread` behind an internal closure — `child.channel` only exposes
// `.fd`), but to CONTAIN this one specific framing error: log-and-drop it, never let it crash the host.
//
// SCOPE — this is deliberately NOT a global uncaughtException swallow:
//   • It only recognizes the child_process advanced-deserializer error (message + a stack frame in
//     `child_process/serialization`); EVERY other uncaughtException is passed through with Node's default
//     fatal semantics preserved (print the stack, exit 1) so real bugs still crash exactly as before.
//   • The listener is installed only WHILE an isolated child is alive (ref-counted to livePids) and
//     removed the instant the last one exits — outside sandbox activity, uncaughtException is untouched.
// CONTAINMENT — this strengthens isolation, it does not weaken it: a malformed frame carries no valid
// bridge command (it never deserializes into a 'message', so callApi/the allowlist are never reached), and
// a plugin can no longer crash the host by emitting garbage on its channel. Nothing about the native OS
// policy/the re-exec/the default-deny bridge allowlist changes; the child runs byte-identically.
let ipcGuardRefs = 0;
let ipcGuardInstalled = false;
let ipcGuardLastWarn = 0;
function isIpcFrameDeserializeError(err: any): boolean {
    return err instanceof Error
        && typeof err.message === 'string'
        && err.message.includes('Unable to deserialize cloned data')
        && typeof err.stack === 'string'
        && /child_process[\\/]serialization/.test(err.stack);
}
function onHostUncaughtException(err: any): void {
    if (isIpcFrameDeserializeError(err)) {
        const now = Date.now();
        if (now - ipcGuardLastWarn > 1000) { // rate-limit: a wedged channel can re-throw every read
            ipcGuardLastWarn = now;
            try { console.error(`[Isolate] dropped a malformed IPC frame on a plugin channel (contained — the affected isolate is recycled by the RPC timeout / liveness checks). ${logSafe(err.message)}`); } catch { /* */ }
        }
        return; // swallow ONLY the IPC framing error; the host stays up
    }
    // Not ours: reproduce Node's default fatal behavior so real bugs are never masked. If the app has its
    // OWN uncaughtException listener too, defer to it (it also runs) rather than exiting out from under it.
    if (process.listenerCount('uncaughtException') > 1) return;
    try { console.error(err && err.stack ? err.stack : String(err)); } catch { /* */ }
    process.exit(1);
}
function retainIpcFrameGuard(): void {
    ipcGuardRefs++;
    if (!ipcGuardInstalled) { process.on('uncaughtException', onHostUncaughtException); ipcGuardInstalled = true; }
}
function releaseIpcFrameGuard(): void {
    if (ipcGuardRefs > 0) ipcGuardRefs--;
    if (ipcGuardRefs === 0 && ipcGuardInstalled) { process.removeListener('uncaughtException', onHostUncaughtException); ipcGuardInstalled = false; }
}

/**
 * Wait (bounded) until this slug has NO registered isolate AND no child we spawned is still alive.
 *
 * The only honest precondition for deleting a plugin's files: `isIsolated(slug) === false` alone says
 * the registry is clean, not that the process is gone. Returns false on timeout so the caller can
 * refuse rather than pull the directory out from under a process that is still dying.
 */
async function awaitIsolateStopped(slug: string, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
        if (!isolates.has(slug) && getLivePids(slug).length === 0) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 25));
    }
}

/**
 * How long a child gets to report 'ready' before the LOAD is failed. 0 restores the old unbounded wait.
 *
 * Without it loadIsolatedPlugin has no upper bound at all: the Promise settles only on 'ready',
 * 'init-error', 'fatal', a spawn 'error' or an early 'exit', and plugin-worker.js sends none of those
 * for an init() that simply never returns — `while (true) {}`, an await on a promise nobody resolves, a
 * blocking connect to an unreachable host. Such a plugin left the load UNSETTLED FOREVER: the activate
 * request never answered, and at boot loadActivePlugins (which awaits each plugin in turn) never got
 * past it, so no later plugin loaded and "🔌 Loading plugins..." was the last line the operator saw.
 *
 * Routed through failLoad, so a hung init is an ORDINARY failed load — the child is killed, everything
 * it registered before hanging comes back out, and the slug is immediately reusable. Deliberately
 * generous: a legitimate init() may run schema migrations against a cold database. This is a DEADLINE
 * on startup, not a budget for the plugin's life — it is armed at spawn and cleared the moment the
 * child says anything that settles the load, so a slow-but-honest plugin pays nothing afterwards.
 *
 * `opts.readyTimeoutMs` overrides it for ONE load — how the test asserts the deadline without either
 * waiting a minute or shortening the deadline every healthy fixture in the file also depends on.
 */
const READY_TIMEOUT_MS = (() => {
    const raw = Number(process.env.WORDJS_PLUGIN_READY_TIMEOUT_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 60000;
})();

const SUPERVISOR = { backoff: [1000, 5000, 15000, 60000], maxRestarts: 5, windowMs: 5 * 60 * 1000 };

function getHealth(slug: string): IsolateHealth {
    let h = isolateHealth.get(slug);
    if (!h) { h = { state: 'stopped', pid: null, startedAt: 0, restarts: 0, lastExitCode: null, lastError: null, rssBytes: null, crashWindow: [] }; isolateHealth.set(slug, h); }
    return h;
}

// Bounded exponential-backoff restart of a crashed child; gives up as 'crash-looping' after maxRestarts
// within the window so a wedged plugin can't thrash the host forever.
function superviseRestart(slug: string, entryFile: string) {
    const h = getHealth(slug);
    const now = Date.now();
    h.crashWindow = h.crashWindow.filter((t) => now - t < SUPERVISOR.windowMs);
    if (h.crashWindow.length >= SUPERVISOR.maxRestarts) {
        h.state = 'crash-looping';
        console.error(`[Isolate ${logSafe(slug)}] crash-looping: ${logSafe(h.crashWindow.length)} restarts within ${logSafe(SUPERVISOR.windowMs / 1000)}s — giving up. Fix the plugin and reload it manually.`);
        try {
            const { addAdminNotice } = require('./plugins');
            if (typeof addAdminNotice === 'function') addAdminNotice(`Plugin "${slug}" keeps crashing and was stopped. Last error: ${h.lastError || 'unknown'}.`, 'error');
        } catch { /* notice is best-effort */ }
        return;
    }
    const delay = SUPERVISOR.backoff[Math.min(h.crashWindow.length, SUPERVISOR.backoff.length - 1)];
    h.state = 'restarting';
    console.warn(`[Isolate ${logSafe(slug)}] scheduling auto-restart in ${logSafe(delay)}ms (attempt ${logSafe(h.crashWindow.length + 1)}/${logSafe(SUPERVISOR.maxRestarts)}).`);
    const t = setTimeout(async () => {
        restartTimers.delete(slug);
        if (isolates.has(slug)) return; // already back up (e.g. a manual reload beat us to it)
        h.crashWindow.push(Date.now());
        h.restarts++;
        try {
            await loadIsolatedPlugin(slug, entryFile, { supervised: true });
            // The restarted child re-registers its routes at the END of the app stack — after the
            // notFound/errorHandler layers boot appended — so without this they'd all 404 (same reason
            // reloadIsolatedPlugin calls it). Restore the ordering so recovered routes actually serve.
            try { require('./plugins').fixMiddlewareOrder(); } catch { /* best-effort */ }
        }
        catch (e: any) { h.state = 'crashed'; h.lastError = e && e.message; superviseRestart(slug, entryFile); }
    }, delay);
    if (t.unref) t.unref();
    restartTimers.set(slug, t);
}

function getIsolateStatus(slug: string) {
    const h = isolateHealth.get(slug);
    if (!h) return isolates.has(slug) ? { state: 'running' } : null;
    return { state: h.state, pid: h.pid, startedAt: h.startedAt, uptimeMs: h.startedAt ? Date.now() - h.startedAt : 0, restarts: h.restarts, lastExitCode: h.lastExitCode, lastError: h.lastError, rssBytes: h.rssBytes };
}
function getAllIsolateStatuses() {
    const out: Record<string, any> = {};
    for (const slug of isolateHealth.keys()) out[slug] = getIsolateStatus(slug);
    return out;
}

/**
 * Snapshot of every slug this module is currently MANAGING — the supported way to ask "what is loaded?".
 *
 * THREE sources, because each alone under-reports:
 *  - `isolates` — slugs with a live, registered child.
 *  - `restartTimers` — slugs whose child CRASHED and already has a supervised restart armed. Those are
 *    absent from `isolates` (the exit handler deleted the entry), yet the timer will re-fork the SAME
 *    entry file, so a caller that swept only the registry would watch an isolate it just retired come
 *    back to life a second later. unloadIsolatedPlugin cancels the timer, so including them is the fix.
 *  - `loading` — slugs whose load is IN FLIGHT. `isolates.set` is the last line of the load executor, and
 *    superviseRestart deletes its restartTimers entry BEFORE calling loadIsolatedPlugin, so a crashed
 *    slug being restarted is in neither of the two maps above for the whole span of its restart. An
 *    enumeration taken in that window under-reported, and a theme sweep driven by it skipped the very
 *    child it exists to retire — reintroducing the leak listIsolates() was added to close.
 *
 * A slug reported from `loading` alone is NOT yet unloadable: unloadIsolatedPlugin only knows how to stop
 * a REGISTERED child. Callers that intend to retire what they enumerate must awaitIsolateSettled(slug)
 * first (see the theme sweep in core/theme-engine.ts) — waiting the load out and then unloading is both
 * leak-free and free of the mid-registration kill that yanking a half-loaded child would cause.
 *
 * `getAllIsolateStatuses()` is NOT a substitute: it is keyed on `isolateHealth`, which keeps an entry for
 * every slug ever loaded (including long-'stopped' ones) — that is a status history, not the live set.
 *
 * This exists because these registries are module-private on purpose: theme-engine must retire every stale
 * `theme:` isolate before loading the incoming theme's child, and it must not reach into our internals.
 */
function listIsolates(): string[] {
    const slugs = new Set<string>(isolates.keys());
    for (const slug of restartTimers.keys()) slugs.add(slug);
    for (const slug of loading.keys()) slugs.add(slug);
    return Array.from(slugs);
}

/**
 * Wait (bounded) until NO load for this slug is in flight — the companion to listIsolates() for anyone
 * who intends to RETIRE what it enumerates.
 *
 * A slug can be reported purely because a load is running (see `loading`), and such a slug cannot be
 * unloaded: unloadIsolatedPlugin stops a registered child, and this one is not registered yet. Two wrong
 * answers were available and both reintroduce the bug — skip it (the child registers a moment later and
 * survives the sweep, which is the leak) or kill it mid-load (the child is SIGKILLed while its
 * registrations are still arriving over IPC, and anything that lands after the teardown stays wired to a
 * dead process forever, because the exit handler skips teardown once the registry entry is gone).
 *
 * So: wait for the load to settle, THEN unload it normally. The loop re-checks rather than awaiting once,
 * because a load that settles may be immediately followed by another for the same slug. Returns false on
 * timeout so the caller can act (and say so) instead of blocking a theme switch forever.
 *
 * Both racers are always cleaned up: the timer is cleared on every iteration whether it won or lost — an
 * uncleared Promise.race timer is precisely what once kept a test subprocess alive past its IPC teardown.
 */
async function awaitIsolateSettled(slug: string, timeoutMs = 30000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
        const rec = loading.get(slug);
        if (!rec) return true;
        const left = deadline - Date.now();
        if (left <= 0) return false;
        let timer: any = null;
        const expiry = new Promise<'timeout'>((r) => {
            timer = setTimeout(() => r('timeout'), Math.min(left, 250));
            if (timer.unref) timer.unref();
        });
        // A rejected load is still a SETTLED load — its failure belongs to whoever asked for it.
        await Promise.race([rec.promise.then(() => 'settled', () => 'settled'), expiry]);
        if (timer) clearTimeout(timer);
    }
}

// (The former host-side memory watchdog is gone: with child_process each untrusted plugin runs in its
// OWN OS process, so off-heap growth is the CHILD's rss — bounded per-child in loadIsolatedPlugin —
// not the host's. A worker_thread shared the host rss and could OOM-crash it; a child cannot.)

// --- KERNEL-ENFORCED memory cap (RLIMIT_AS via `ulimit -v`) ---------------------------------------
// We prefer a KERNEL cap on the child's address space over a pure userspace poll: it holds even if the
// host event loop is wedged, and it bounds
// off-heap (Buffer/ArrayBuffer) growth the V8 heap flag can't. The wrapper `sh -c 'ulimit -v N; exec
// node …'` preserves the fork-style IPC channel — the inherited NODE_CHANNEL_FD + its fd survive the
// shell's `exec`, so the exec'd node attaches IPC exactly as a forked child would. V8's pointer-
// compression cage reserves a large VIRTUAL range (~4 GB) that RLIMIT_AS counts, so the cap must be
// GENEROUS — it is a coarse virtual *backstop* (bounds pathological allocation; kernel-enforced even if
// the host loop is wedged), NOT a tight RSS cap. The precise
// resident cap stays the /proc poll below. We use a GENEROUS fixed ceiling (virtual space is cheap to
// reserve) validated by a probe that boots node with the REAL execArgv (so the cap reflects the actual
// child's footprint — cage + ts-node — not a bare `node` that under-counts it and false-kills loads).
// Result (cached Promise): null = unavailable (→ plain fork + /proc poll), number = RLIMIT_AS in KiB.
let osCapProbe: Promise<number | null> | undefined;
function probeOsMemoryCap(): Promise<number | null> {
    if (osCapProbe) return osCapProbe;
    osCapProbe = (async () => {
        if (process.platform === 'win32') return null; // no POSIX ulimit / RLIMIT_AS
        if (process.platform === 'darwin') {
            // Darwin accepts `ulimit -v` but aliases RLIMIT_AS to an unenforced RLIMIT_RSS. A successful
            // shell command is therefore not evidence of a cap. Measure the bite first and never print
            // "kernel memory cap active" unless the impossible-limit control proves enforcement.
            let enforcement = 'unknown';
            try { enforcement = await require('./sandbox-macos').probeMacosMemoryCapEnforcement(); } catch { /* no claim */ }
            if (enforcement !== 'enforced') {
                console.warn(`[Sandbox] preventive RLIMIT memory cap is ${logSafe(enforcement)} on macOS; using the 256 MB V8 heap ceiling plus the host RSS watchdog without claiming a kernel resident cap.`);
                return null;
            }
        }
        // RLIMIT_AS can only be a LOOSE virtual backstop, not a box-tight cap: V8 reserves a ~4 GB
        // pointer-compression cage, and the legit child footprint (in dev, ts-node's compiler + the full
        // core .ts compile) needs many GB of virtual space — a tighter ceiling crashes real plugin loads
        // (verified: a 6 GB cap killed ts-node children mid-load). So this bounds only PATHOLOGICAL
        // allocation; the PRECISE resident cap is the /proc RSS poll below (768 MB, 250 ms), and the
// decisive PREVENTIVE resident cap for small-RAM boxes + Windows is a kernel cgroup MemoryMax /
// Job Object. Operators on a compiled (non-ts-node) prod build with
        // ample RAM headroom may tighten it via sandbox.addressSpaceCapMb.
        let capMb = 16384;
        try { const s = require('../config/app').sandbox; if (s && s.addressSpaceCapMb) capMb = Math.max(6144, s.addressSpaceCapMb); } catch { /* default */ }
        const candidatesMb = [capMb, Math.round(capMb * 1.5), capMb * 2]; // escalate if the floor won't boot here
        // Probe with the SAME execArgv the real child uses (ts-node in dev) so the validated cap reflects
        // the real startup footprint (cage + ts-node compiler), not a bare `node` that under-counts it.
        const execArgv = __filename.endsWith('.ts') ? ['-r', 'ts-node/register'] : [];
        // The probe child boots node UNDER the candidate RLIMIT_AS through the SAME shell wrapper the real
        // load uses, and sends ONE IPC message. We accept a cap only if node both starts AND its IPC
        // channel survives the shell `exec` (process.send works) — this self-validates the kernel cap +
        // IPC-preservation on the ACTUAL host, so the path needs no per-platform assumptions and falls
        // back cleanly to plain fork wherever it doesn't hold.
        // Exit only AFTER the IPC write flushes (send callback) — exiting synchronously after send would
        // drop the message and falsely fail the probe even where the cap works. Backstop self-exit so a
        // stuck candidate fails fast rather than waiting out the outer spawn timeout.
        const probeSrc = 'if(!process.send){process.exit(3)}process.send("ok",function(){process.exit(0)});setTimeout(function(){process.exit(4)},8000)';
        for (const mb of candidatesMb) {
            const kb = mb * 1024; // `ulimit -v` unit is KiB
            const ok = await new Promise<boolean>((res) => {
                let c: any, got = false, done = false;
                const finish = (v: boolean) => { if (!done) { done = true; try { if (c) c.kill(); } catch { /* */ } res(v); } };
                try {
                    // Same `exec "$@"` wrapper the real load uses; $0 = label, $@ = [node, …execArgv, -e, src].
                    c = spawn('sh', ['-c', `ulimit -v ${kb} 2>/dev/null; exec "$@"`, 'wjs-probe', process.execPath, ...execArgv, '-e', probeSrc],
                        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', timeout: 20000 });
                } catch { return res(false); }
                c.on('message', (m: any) => { if (m === 'ok') got = true; });
                c.on('error', () => finish(false));
                c.on('exit', (code: number) => finish(got && code === 0));
            });
            if (ok) { console.log(`[Sandbox] kernel memory cap active: RLIMIT_AS ${logSafe(mb)} MB per isolated child.`); return kb; }
        }
        console.log('[Sandbox] kernel rlimit cap unavailable here; relying on /proc RSS poll + process separation.');
        return null;
    })();
    return osCapProbe;
}

// --- PREVENTIVE kernel RSS cap via cgroup v2 (systemd-run --user --scope -p MemoryMax) -----------
// rlimit can only bound VIRTUAL space (and V8's ~4 GB pointer-compression cage forces it loose — it
// can't be set near a real working set), and the /proc RSS poll is REACTIVE (a fast off-heap loop can
// spike the box within a poll window). A cgroup v2 `memory.max` is the only PREVENTIVE resident cap:
// the kernel OOM-kills ONLY the offending child the instant its RESIDENT set exceeds budget, blast
// radius contained to the child. `systemd-run --user --scope` applies it with NO root (man page: with
// --scope the command runs as a DIRECT CHILD of systemd-run, inheriting the caller's fds + env, so the
// IPC fd survives — confirmed by the probe's round-trip). Where systemd-run/user-cgroups aren't
// available (Windows, macOS, non-systemd / no user manager, e.g. CI) this stays OFF and we fall back to
// the fork + RLIMIT_AS + cross-platform RSS poll path — zero regression.
let cgroupSeq = 0;
let cgroupProbe: Promise<boolean> | undefined;
// Resident-memory budget for an isolated plugin child — the cgroup memory.max AND the /proc-poll ceiling
// AND the Windows Job-Object cap, kept as ONE source of truth (they must agree). 768 MB fits a compiled
// prod worker with headroom; a ts-node dev/test worker overshoots it (why the cgroup mem cap is opt-in).
const RSS_BUDGET_BYTES = 768 * 1024 * 1024;
// Anti-exhaustion caps so a plugin can't drain host kernel tables: FD_CAP bounds per-plugin file
// descriptors via RLIMIT_NOFILE on the rlimit launch path (per-PROCESS, safe to default — RLIMIT_NPROC is
// deliberately NOT used because it is per-UID and would count the host's own processes); PIDS_MAX bounds
// tasks/threads via cgroup TasksMax on the systemd-scope path (per-CGROUP, so it caps a fork/thread-bomb
// to the plugin without touching the host). Both are generous — no legitimate plugin approaches them.
const FD_CAP = 4096;
const PIDS_MAX = 512;
// The cgroup-scope resource caps, built ONCE so probeCgroupCap and the real launch apply the IDENTICAL
// set. A mismatch is exactly what broke the first CPU-quota attempt (#192): the probe validated a
// memory-only scope while the launch ALSO passed CPUQuota, so it green-lit a config that then failed to
// start where the cpu controller wasn't delegated to the user cgroup. Returns [] unless the memory cap is
// enabled — cgroup mode REQUIRES MemoryMax: under a --scope, child.pid is systemd-run (not the node
// child), so the /proc RSS poll can't read the child and memory.max is the only working resident cap
// there. CPUQuota (cpuQuotaPercent, anti-DoS) layers into the SAME scope on top.
function cgroupResourceProps(): string[] {
    let mem = false, cpu = 0;
    try { const s = require('../config/app').sandbox; mem = !!(s && s.useCgroupMemoryCap); cpu = (s && Number(s.cpuQuotaPercent)) || 0; } catch { /* config unavailable ⇒ no caps */ }
    if (!mem) return [];
    // TasksMax is a cgroup resource-control property (valid on a --scope, unlike exec-context rlimits) → it
    // caps the pids controller for THIS plugin's cgroup, so a fork/thread-bomb hits its own PIDS_MAX, not
    // the host task table. Bundled with the memory cap in the same scope (probe validates the exact set).
    const props = ['-p', `MemoryMax=${RSS_BUDGET_BYTES}`, '-p', 'MemorySwapMax=0', '-p', `TasksMax=${PIDS_MAX}`];
    if (cpu > 0) props.push('-p', `CPUQuota=${cpu}%`);
    return props;
}
// The `systemd-run --user` CLIENT needs the session-bus vars (XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS) to
// reach the per-user systemd manager — but workerEnv (the secret-free allowlist the plugin runs under)
// deliberately omits them. Before this fix the PROBE (which inherits the FULL env) passed while the REAL
// launch, spawned with env:workerEnv, died with "Failed to connect to bus: No medium found" (audit F-04).
// Fix: give the CLIENT the bus vars, then strip them back off INSIDE the scope with `env -u …` so the
// plugin process's env stays EXACTLY workerEnv. Shared by the probe and the real launch so both exercise
// the identical command shape (the #192 probe/launch-parity lesson: a probe that doesn't mirror the launch
// green-lights a config that then fails to start).
const CGROUP_CLIENT_BUS_VARS = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];
const SCOPE_ENV_STRIP = ['env', ...CGROUP_CLIENT_BUS_VARS.flatMap((v) => ['-u', v])];
function cgroupClientEnv(base: Record<string, string>): Record<string, string> {
    const e: Record<string, string> = { ...base };
    for (const k of CGROUP_CLIENT_BUS_VARS) { const v = process.env[k]; if (v !== undefined) e[k] = v; }
    return e;
}
function probeCgroupCap(): Promise<boolean> {
    if (cgroupProbe) return cgroupProbe;
    cgroupProbe = (async () => {
        if (process.platform !== 'linux') return false;
        // OPT-IN + PROBE-GATED: cgroup/systemd support varies across environments — a host or CI runner can
        // have `systemd-run` yet no usable `--user` bus ("Failed to connect to bus"), or have memory
        // delegated to the user cgroup but not cpu, so auto-enabling breaks those hosts. The operator turns
        // it on explicitly (useCgroupMemoryCap [+ cpuQuotaPercent]) and the probe below STILL validates the
        // EXACT scope works before activating; any failure falls back to the fork + RLIMIT_AS + RSS-poll
        // path. props is empty when nothing is enabled ⇒ cgroup mode stays off.
        const props = cgroupResourceProps();
        if (props.length === 0) return false;
        const unit = `wjp-probe-${process.pid}.scope`;
        // The probe child boots, confirms IPC works through --scope's fd inheritance (sends "ok" and
        // stays alive), then we tear it down via the SAME path real teardown uses and require an exit —
        // so cgroup mode activates ONLY if spawn + IPC + clean kill all work on THIS host.
        const src = 'if(!process.send){process.exit(3)}process.send("ok");setInterval(function(){},1e9)';
        const ok = await new Promise<boolean>((res) => {
            let proc: any, gotOk = false, done = false;
            const finish = (v: boolean) => { if (!done) { done = true; res(v); } };
            const overall = setTimeout(() => finish(false), 20000);
            if ((overall as any).unref) (overall as any).unref();
            try {
                // Mirror the real launch's command shape: the SCOPE_ENV_STRIP prefix strips the bus vars for
                // the grandchild (so the probe also validates that `env` exec layer works on this host), while
                // the probe's inherited full env still lets the systemd-run CLIENT reach the user bus.
                proc = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--unit', unit,
                    ...props, '--', ...SCOPE_ENV_STRIP, process.execPath, '-e', src],
                    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', timeout: 18000 });
            } catch { clearTimeout(overall); return res(false); }
            proc.on('message', (m: any) => {
                if (m === 'ok' && !gotOk) {
                    gotOk = true;
                    try { proc.kill('SIGKILL'); } catch { /* */ }
                    try { spawn('systemctl', ['--user', 'kill', '--signal=SIGKILL', unit], { stdio: 'ignore' }); } catch { /* */ }
                }
            });
            proc.on('error', () => { clearTimeout(overall); finish(false); });
            proc.on('exit', () => { clearTimeout(overall); finish(gotOk); }); // exit AFTER ok ⇒ kill worked
        });
        if (ok) console.log(`[Sandbox] preventive cgroup caps ACTIVE (systemd-run --user --scope ${logSafe(props.join(' '))} per isolated child).`);
        else console.warn('[Sandbox] cgroup caps requested (useCgroupMemoryCap/cpuQuotaPercent) but the probe failed (no usable --user scope, or cpu/memory not delegated to the user cgroup) — falling back to RLIMIT_AS + the RSS poll.');
        return ok;
    })();
    return cgroupProbe;
}

// --- PREVENTIVE memory cap on WINDOWS via a Job Object (the Win32 analog of cgroup memory.max) ------
// On Linux a cgroup `memory.max` (or, looser, RLIMIT_AS) lets the KERNEL fail/kill the child the moment
// it crosses the resident budget. Windows has neither, so the child previously had only the REACTIVE
// RSS poll (kills AFTER a tick observes the overage — a fast off-heap balloon can spike the host within
// the poll window). A Windows Job Object with JOB_OBJECT_LIMIT_PROCESS_MEMORY is the preventive
// equivalent: the kernel FAILS any commit past ProcessMemoryLimit, so the host is never at risk.
//
// We assign the ALREADY-FORKED child to the job by PID (so the fork-style IPC channel is untouched),
// using a one-shot PowerShell helper that P/Invokes the Win32 APIs — NO native npm dependency, in
// keeping with this sandbox's design. The helper creates the job, sets the limit, assigns the child,
// then EXITS: the job and its limit persist for the child's lifetime because a job is destroyed only
// once its last handle is closed AND all assigned processes have exited (a running assigned process
// keeps it alive after handle-close — verified empirically), so no babysitter process is needed.
// DIE_ON_UNHANDLED_EXCEPTION is also set so an over-budget child dies cleanly instead of popping a WER
// dialog. Default-ON on Windows, PROBE-VALIDATED on the host, opt-out via config.sandbox
// .useJobObjectMemoryCap=false; any failure (no PowerShell, locked-down host, 32-bit PS layout) just
// leaves the RSS poll as the cap, exactly as before ⇒ zero regression. The brief post-fork assign
// latency (~1–2 s, powershell JIT) is covered by that same poll, so the only window matches today's
// behavior; the kernel cap binds preventively thereafter.
function buildJobCapScript(pid: number, limitBytes: number): string {
    // pid + limitBytes are integers WE control (never plugin/user input) → safe to inline. The C# is a
    // PowerShell here-string (@'…'@ — delimiters MUST sit at column 0); JS double-quoted lines keep the
    // literal `$`/single-quotes intact (no template interpolation).
    return [
        "$ErrorActionPreference='Stop'",
        "try {",
        "$sig=@'",
        "using System; using System.Runtime.InteropServices;",
        "public static class WJSJob {",
        "[StructLayout(LayoutKind.Sequential)] public struct BLI { public Int64 a; public Int64 b; public UInt32 LimitFlags; public UIntPtr c; public UIntPtr d; public UInt32 e; public UIntPtr f; public UInt32 g; public UInt32 h; }",
        "[StructLayout(LayoutKind.Sequential)] public struct IOC { public UInt64 a; public UInt64 b; public UInt64 c; public UInt64 d; public UInt64 e; public UInt64 f; }",
        "[StructLayout(LayoutKind.Sequential)] public struct ELI { public BLI Basic; public IOC Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProc; public UIntPtr PeakJob; }",
        "[DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr a, string n);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j, int c, IntPtr p, uint l);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, uint p);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);",
        "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);",
        "}",
        "'@",
        "Add-Type -TypeDefinition $sig",
        "$j=[WJSJob]::CreateJobObject([IntPtr]::Zero,$null)",
        "if($j -eq [IntPtr]::Zero){ Write-Output 'JOBCAP_FAIL create'; exit 1 }",
        "$i=New-Object WJSJob+ELI",
        "$bl=$i.Basic; $bl.LimitFlags=0x00000100 -bor 0x00000400; $i.Basic=$bl", // PROCESS_MEMORY | DIE_ON_UNHANDLED_EXCEPTION
        "$i.ProcessMemoryLimit=[uintptr]::new([uint64]" + Math.floor(limitBytes) + ")",
        "$cb=[Runtime.InteropServices.Marshal]::SizeOf($i)",
        "$p=[Runtime.InteropServices.Marshal]::AllocHGlobal($cb)",
        "[Runtime.InteropServices.Marshal]::StructureToPtr($i,$p,$false)",
        "$ok=[WJSJob]::SetInformationJobObject($j,9,$p,[uint32]$cb)", // 9 = JobObjectExtendedLimitInformation
        "[Runtime.InteropServices.Marshal]::FreeHGlobal($p)",
        "if(-not $ok){ Write-Output 'JOBCAP_FAIL setinfo'; exit 1 }",
        "$h=[WJSJob]::OpenProcess(0x0100 -bor 0x0001 -bor 0x0400,$false,[uint32]" + Math.floor(pid) + ")", // SET_QUOTA|TERMINATE|QUERY_INFORMATION
        "if($h -eq [IntPtr]::Zero){ Write-Output 'JOBCAP_FAIL open'; exit 1 }",
        "$asn=[WJSJob]::AssignProcessToJobObject($j,$h)",
        "[WJSJob]::CloseHandle($h) | Out-Null",
        "[WJSJob]::CloseHandle($j) | Out-Null", // close BOTH: the running child keeps the job (and its cap) alive
        "if(-not $asn){ Write-Output 'JOBCAP_FAIL assign'; exit 1 }",
        "Write-Output 'JOBCAP_OK'; exit 0",
        "} catch { Write-Output ('JOBCAP_FAIL ex:'+$_.Exception.Message); exit 1 }",
    ].join("\n");
}

// Run the one-shot helper for one child PID. Resolves true only if it reported JOBCAP_OK (job created,
// limit set, process assigned). Never throws — a missing powershell / failed P/Invoke resolves false.
function assignProcessToJobObject(pid: number, limitBytes: number): Promise<boolean> {
    return new Promise((resolve) => {
        let ps: any;
        try {
            const b64 = Buffer.from(buildJobCapScript(pid, limitBytes), 'utf16le').toString('base64'); // -EncodedCommand = UTF-16LE b64 (no quoting pitfalls)
            ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch { return resolve(false); }
        let out = '';
        try { ps.stdout.on('data', (d: any) => { out += String(d); }); } catch { /* */ }
        ps.on('error', () => resolve(false));
        ps.on('exit', (code: number) => resolve(code === 0 && /JOBCAP_OK/.test(out)));
    });
}

let jobCapProbe: Promise<boolean> | undefined;
function probeJobObjectCap(): Promise<boolean> {
    if (jobCapProbe) return jobCapProbe;
    jobCapProbe = (async () => {
        if (process.platform !== 'win32') return false; // Win32-only feature
        // Default ON; opt OUT via config.sandbox.useJobObjectMemoryCap === false (config is loaded by the
        // time the first plugin loads, so the opt-out is honored).
        try { const s = require('../config/app').sandbox; if (s && s.useJobObjectMemoryCap === false) return false; } catch { /* config unavailable → default on */ }
        // Validate the WHOLE chain on THIS host (powershell present, P/Invoke + AssignProcessToJobObject
        // succeed): assign a throwaway child to a small-capped job and require JOBCAP_OK. The cap's BITE is
        // deterministic kernel behavior (verified separately), so the probe only confirms the API path works.
        return await new Promise<boolean>((resolve) => {
            let probe: any;
            // Keep the probe child alive long enough to OUTLAST a COLD powershell Add-Type JIT (2–5 s, more
            // on a loaded/CI box) — else OpenProcess(pid) could hit a dead PID and the probe would falsely
            // report the cap unavailable for the whole process. finish() kills it the moment assign resolves,
            // so this ceiling (under the 20 s backstop) is only a safety net, not the real lifetime.
            try { probe = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 18000)'], { windowsHide: true, stdio: 'ignore' }); }
            catch { return resolve(false); }
            if (!probe || !probe.pid) return resolve(false);
            let done = false;
            const finish = (ok: boolean) => { if (done) return; done = true; try { probe.kill(); } catch { /* */ } resolve(ok); };
            const to = setTimeout(() => finish(false), 20000); // first powershell Add-Type JIT can be slow
            if (to.unref) to.unref();
            assignProcessToJobObject(probe.pid, 256 * 1024 * 1024)
                .then((ok) => {
                    if (ok) console.log('[Sandbox] preventive Job Object memory cap ACTIVE (Windows; per-plugin-child ProcessMemoryLimit).');
                    else console.warn('[Sandbox] Job Object memory cap unavailable here (PowerShell/Win32 probe failed) — relying on the RSS poll.');
                    finish(ok);
                })
                .catch(() => finish(false));
        });
    })();
    return jobCapProbe;
}

// Common state vocabulary for the native sandbox selected by each operating system.
type ConfinementState = 'unknown' | 'unsupported' | 'disabled' | 'active' | 'degraded';
let sandboxHardeningState: ConfinementState = 'unknown';
function getSandboxHardeningState() { return sandboxHardeningState; }
// --- CROSS-PLATFORM capability confinement (Node's own permission model) -------------------------
// Node's permission model is the common capability layer beneath the platform-native sandbox.
//
// Node's permission model is enforced in C++, BELOW JavaScript, with the same flags on every platform.
// It is not a monkey-patch: there is no API to re-grant from inside the process, so a plugin that
// defeats a JS guard still meets it. Measured against the escapes this codebase has actually shipped,
// it independently denies `node:wasi` preopens, `process.loadEnvFile`, `process.binding`, addon
// loading and child_process — none of which it knows by name, which is the property the by-name
// denylists cannot have.
//
// It is a SECOND FLOOR, not a replacement, and the gaps are specific and measured on this Node:
//   · node:sqlite still opens files through it (its C++ fs access is not gated — verified: fs.write
//     is DENIED while DatabaseSync creates the file). Stays blocked by BLOCKED_PLUGIN_MODULES.
//   · diagnostics_channel is not an fs/net/process capability at all. Same — blocked by name.
//   · --allow-net is not enforced in every build that accepts it, so the JS egress guard remains the
//     authority on outbound traffic.
// Which is exactly why the JS layer stays: each floor covers what the other misses.
let permissionModelState: 'unknown' | 'unsupported' | 'disabled' | 'active' | 'degraded' = 'unknown';
function getPermissionModelState() { return permissionModelState; }
let permissionProbe: Promise<string | null> | undefined;
/**
 * Resolve the flag this Node accepts for its permission model, or null when unavailable.
 *
 * PROBED, never assumed: the flag was `--experimental-permission` (Node 20/22) before it became
 * `--permission` (23.5+), and a build can accept a flag without enforcing it. So the probe spawns a
 * real child and only reports success when a read OUTSIDE the granted path is actually refused —
 * anything less would report confinement that is not there, the "looks secure but isn't" state.
 */
function probePermissionModel(): Promise<string | null> {
    if (permissionProbe) return permissionProbe;
    permissionProbe = (async () => {
        let enabled = true;
        try { const s = require('../config/app').sandbox; if (s && s.usePermissionModel === false) enabled = false; } catch { /* config unavailable → keep default-on */ }
        if (!enabled) { permissionModelState = 'disabled'; return null; }
        // Deny a read of a path we do NOT grant, and require the child to report it as refused.
        const probeSrc = 'try{require("fs").readFileSync(process.execPath);console.log("OPEN")}' +
            'catch(e){console.log(e&&e.code==="ERR_ACCESS_DENIED"?"DENIED":"OTHER")}';
        for (const flag of ['--permission', '--experimental-permission']) {
            const verdict = await new Promise<string>((resolve) => {
                try {
                    const p = spawn(process.execPath, [flag, `--allow-fs-read=${__dirname}`, '-e', probeSrc],
                        { stdio: ['ignore', 'pipe', 'ignore'] });
                    let out = '';
                    p.stdout.on('data', (d: any) => { out += String(d); });
                    p.on('error', () => resolve('ERROR'));
                    p.on('close', () => resolve(out.trim()));
                    setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } resolve('TIMEOUT'); }, 8000).unref?.();
                } catch { resolve('ERROR'); }
            });
            if (verdict === 'DENIED') {
                permissionModelState = 'active';
                console.log(`[Sandbox] capability confinement ACTIVE on ${process.platform} (Node permission model via ${flag}: filesystem scoped to the plugin's own zones, child_process/worker_threads/native addons/WASI denied below JS).`);
                return flag;
            }
        }
        permissionModelState = 'unsupported';
        return null;
    })();
    return permissionProbe;
}

/** Backward-compatible entry point: probe the native mechanism for this platform. */
async function probeKernelHardening(): Promise<boolean> {
    return (await probePlatformConfinement()) === 'active';
}

// ── CROSS-PLATFORM KERNEL CONFINEMENT ────────────────────────────────────────────────────────────
// One native mechanism per OS, one contract: it wraps EVERY isolated production plugin. A network grant
// changes only the egress rule; it never removes that platform's filesystem/process boundary.
type ConfinementMechanism = 'landlock' | 'appcontainer' | 'seatbelt' | 'none';
const KERNEL_MECHANISM_BY_PLATFORM: Record<string, ConfinementMechanism> = {
    linux: 'landlock', win32: 'appcontainer', darwin: 'seatbelt',
};
const NETWORK_MECHANISM_BY_PLATFORM: Record<string, string> = {
    linux: 'seccomp-bpf all-socket denial without a grant; AF_INET/AF_INET6 clients only with a grant, plus Landlock TCP rules where supported',
    win32: 'AppContainer without internetClient unless the plugin holds the network grant',
    darwin: 'Seatbelt deny network* unless the plugin holds the network grant',
};
function platformKernelMechanism(platform: string = process.platform): ConfinementMechanism {
    return KERNEL_MECHANISM_BY_PLATFORM[platform] || 'none';
}

type LinuxFloorLayer = 'landlock' | 'none';
const LINUX_FLOOR_LAYERS: readonly LinuxFloorLayer[] = ['landlock', 'none'] as const;
function linuxFloorDecision(o: { platform: string; hardened?: boolean; zeroConf: ConfinementState; netGranted: boolean }): { layer: LinuxFloorLayer; denyNetwork: boolean; reason: string } {
    if (o.platform !== 'linux') return { layer: 'none', denyNetwork: false, reason: 'Landlock and seccomp-bpf are Linux kernel features' };
    if (o.zeroConf !== 'active') return { layer: 'none', denyNetwork: false, reason: `the Landlock/seccomp probe did not certify this host (state '${o.zeroConf}')` };
    return {
        layer: 'landlock',
        denyNetwork: !o.netGranted,
        reason: o.netGranted
            ? 'Landlock and the dangerous-syscall filter stay active; the network grant removes only the IP-socket denial'
            : 'Landlock, the dangerous-syscall filter and the IP-socket denial were certified on this host',
    };
}

let linuxZeroConfState: ConfinementState = 'unknown';
let linuxZeroConfNote = 'the Linux confinement probe has not run yet';
function getLinuxZeroConfState(): ConfinementState { return linuxZeroConfState; }
let sandboxPlatformState: ConfinementState = 'unknown';
let sandboxPlatformNetworkState: ConfinementState = 'unknown';
let sandboxPlatformNote = 'the platform confinement probe has not run yet';
function getSandboxPlatformState() { return sandboxPlatformState; }
function getSandboxPlatformNetworkState() { return sandboxPlatformNetworkState; }
function linuxFloorInForce(): 'landlock+seccomp' | 'none' {
    return process.platform === 'linux' && linuxZeroConfState === 'active' ? 'landlock+seccomp' : 'none';
}

function getSandboxPlatformConfinement() {
    const mechanism = platformKernelMechanism();
    const out: any = {
        platform: process.platform,
        mechanism,
        state: sandboxPlatformState,
        network: { mechanism: NETWORK_MECHANISM_BY_PLATFORM[process.platform] || 'none', state: sandboxPlatformNetworkState },
        appliesTo: mechanism === 'none' ? 'nothing' : 'every isolated plugin; the network grant changes only egress policy',
        note: sandboxPlatformNote,
    };
    if (process.platform === 'linux') {
        out.floor = { inForce: linuxFloorInForce(), layers: { landlock: { state: linuxZeroConfState, note: linuxZeroConfNote } } };
    }
    return out;
}

function platformLaunchDecision(o: { platform: string; state: ConfinementState; netGranted: boolean; tsNode: boolean }): { mechanism: ConfinementMechanism; use: boolean; reason: string } {
    const mechanism = platformKernelMechanism(o.platform);
    if (mechanism === 'none') return { mechanism, use: false, reason: 'no kernel confinement mechanism exists for this platform' };
    if (o.state !== 'active') return { mechanism, use: false, reason: `the ${mechanism} probe did not certify this host (state '${o.state}')` };
    if (mechanism === 'appcontainer' && o.tsNode) return { mechanism, use: false, reason: 'AppContainer applies to compiled production; recursively provisioning the ts-node development dependency tree exceeds development test deadlines' };
    return { mechanism, use: true, reason: `${mechanism} confinement certified; network=${o.netGranted ? 'granted' : 'denied'} changes only the network rule` };
}

/** Production is fail-closed. The sole exception is the source-only Windows development worker: its
 * TypeScript dependency tree makes first-run recursive ACL provisioning exceed development test deadlines;
 * compiled production has a bounded runtime tree and no exception. */
function nativeSandboxRequired(o: { configured: boolean; platform: string; tsNode: boolean }): boolean {
    return o.configured && !(o.platform === 'win32' && o.tsNode);
}

let platformConfinementProbe: Promise<ConfinementState> | undefined;
function probePlatformConfinement(): Promise<ConfinementState> {
    if (platformConfinementProbe) return platformConfinementProbe;
    platformConfinementProbe = (async () => {
        const mech = platformKernelMechanism();
        if (mech === 'none') {
            sandboxPlatformState = sandboxHardeningState = 'unsupported';
            sandboxPlatformNetworkState = 'unsupported';
            sandboxPlatformNote = `no native confinement mechanism exists for platform '${logSafe(process.platform)}'`;
            return sandboxPlatformState;
        }
        if (mech === 'landlock') {
            try {
                const linux = require('./sandbox-linux');
                linuxZeroConfState = await linux.probeLinuxZeroConf();
                linuxZeroConfNote = String(linux.getLinuxZeroConfNote());
                sandboxPlatformState = linuxZeroConfState;
            } catch (e: any) {
                sandboxPlatformState = linuxZeroConfState = 'degraded';
                linuxZeroConfNote = `the Linux confinement module could not be loaded (${logSafe(e && e.message)})`;
            }
            sandboxHardeningState = sandboxPlatformState;
            sandboxPlatformNetworkState = sandboxPlatformState;
            sandboxPlatformNote = linuxZeroConfNote;
            return sandboxPlatformState;
        }
        if (mech === 'appcontainer' && __filename.endsWith('.ts')) {
            sandboxPlatformState = sandboxHardeningState = 'disabled';
            sandboxPlatformNetworkState = 'disabled';
            sandboxPlatformNote = 'AppContainer applies to compiled production; the source-only ts-node development worker is exempt because first-run recursive ACL provisioning exceeds development test deadlines';
            return sandboxPlatformState;
        }
        try {
            sandboxPlatformState = mech === 'appcontainer'
                ? await require('./sandbox-windows').probeAppContainer()
                : await require('./sandbox-macos').probeSeatbelt();
        } catch (e: any) {
            sandboxPlatformState = 'degraded';
            console.warn(`[Sandbox] ${mech} probe errored (${logSafe(e && e.message)}).`);
        }
        sandboxHardeningState = sandboxPlatformState;
        sandboxPlatformNetworkState = sandboxPlatformState;
        sandboxPlatformNote = sandboxPlatformState === 'active'
            ? `${mech} certified for filesystem/process confinement and both network-policy shapes`
            : `${mech} is '${sandboxPlatformState}'; see the sandbox probe warning for the failed property`;
        return sandboxPlatformState;
    })();
    return platformConfinementProbe;
}

/**
 * Start one isolated plugin child inside the Windows AppContainer, having first granted the io-guard
 * write zones to its SID. THROWS on any failure and never returns a half-confined child. The platform
 * module persistently caches only successful recursive grants and serializes concurrent setup processes,
 * so this remains zero-config without paying for a full tree walk on every restart.
 *
 * The resource caps (memory / active-process / CPU) are deliberately NOT passed: sandbox-windows resolves
 * them from the same `sandbox.*` knobs the Linux cgroup path uses, so an operator sets one number and both
 * operating systems obey it, and there is no second place for the defaults to drift.
 */
async function launchAppContainerChild(slug: string, appRoot: string, io: {
    args: string[]; env: Record<string, string>; stdio: any; allowNetwork: boolean;
    zones: { traverse: string[]; readExec: string[]; write: string[] };
}): Promise<{ child: any; containedPid: number | null }> {
    const win = require('./sandbox-windows');
    // A SID is derived from BOTH the install and the slug. Sharing one package SID across plugins makes
    // every recursive ACL ever granted to that SID cumulative, which destroys native cross-plugin
    // separation even though the JavaScript guards still look correct.
    const profile = win.appContainerProfileNameForPlugin(appRoot, slug);
    const sid = await win.ensureAppContainerProfile(profile);
    if (!sid) throw new Error('the AppContainer probe reported ACTIVE but no package SID is available');
    const zones = io.zones;
    const grant = async (dirs: string[], mode: 'traverse' | 'rx' | 'full') => {
        const ok = await win.grantAppContainerAccess(sid, dirs, mode);
        if (!ok) throw new Error(`could not grant AppContainer ${mode} access to ${dirs.join(', ')}`);
    };
    await grant(zones.traverse, 'traverse');
    await grant(zones.readExec, 'rx');
    await grant(zones.write, 'full');
    const runtimeExe = await win.ensureAppContainerRuntime(sid);
    const r = await win.launchInAppContainer({ sid, exe: runtimeExe, args: io.args, cwd: appRoot, env: io.env, stdio: io.stdio, allowNetwork: io.allowNetwork });
    if (!r || !r.child) throw new Error('the AppContainer relay produced no child process');
    return { child: r.child, containedPid: r.containedPid ?? null };
}

// Per-plugin permission grant check (Android-style, default-deny). No plugin bypasses the sandbox:
// host-level capabilities (mail provider, notify transport, raw-HTML hooks are denied to all) are
// gated on an explicit admin grant for the requested scope:access. See core/plugin-permissions.
function isGrantedFor(slug: string, scope: string, access: string): boolean {
    try { return require('./plugin-permissions').isGranted(slug, scope, access); } catch { return false; }
}

// Network is OFF for untrusted plugins unless an admin granted it (plugin-permissions). The child can't
// read the DB, so this host-resolved value is pushed into cfg → global.__WORDJS_PLUGIN_NETWORK__, which
// opens ONLY the network gates (net/tls/dns/http/... + fetch/WebSocket), never child_process/fs/vm.
function isNetworkGrantedFor(slug: string): boolean {
    try { return require('./plugin-permissions').isNetworkGranted(slug); } catch { return false; }
}

// FILESYSTEM CAPABILITY, resolved host-side at spawn for the SAME reason as the network grant, and it is
// the same failure if it is not pushed: the child has no database, never calls loadGrants(), and so its
// plugin-permissions map is permanently EMPTY. io-guard's runtime capability gate asks isGranted() —
// which in the child therefore always answered "no" — and denied the plugin's OWN data directory even
// when the operator had granted filesystem, breaking every isolate plugin that declares the capability
// (mail-server's Bayes classifier, encryption key and attachments among them).
//
// Resolving it HERE, with the same isGranted() the host gate uses, keeps ONE interpreter of what a grant
// token means (including `filesystem:admin` implying read+write): the child receives two booleans, never
// tokens it would have to re-interpret. Reader side: core/io-guard.ts ISOLATE_FS_GRANT.
// Re-resolved on every spawn, and POST /plugins/:slug/permissions respawns after changing grants, so a
// revoke takes effect immediately rather than at the next boot.
function fsGrantsFor(slug: string): { read: boolean; write: boolean } {
    return { read: isGrantedFor(slug, 'filesystem', 'read'), write: isGrantedFor(slug, 'filesystem', 'write') };
}

// The admin-set per-plugin egress allowlist (bare hosts / IP literals), resolved host-side at spawn and
// pushed into the child's cfg (→ egress-guard.setAllowedHosts). Empty ⇒ allow-all-public (unchanged
// behavior). Only meaningful for a network-granted plugin; fail-OPEN (no allowlist) on any error.
function getEgressAllowlistFor(slug: string): string[] {
    try { const l = require('./plugin-permissions').getEgressAllowlist(slug); return Array.isArray(l) ? l : []; } catch { return []; }
}
// Whether the per-plugin egress policy loaded cleanly at boot. When FALSE (DB/options load failed, or the
// permissions module can't be required at all), the spawn path below fails egress CLOSED for a
// network-granted plugin instead of the historic allow-all-public (audit F-06).
function egressPolicyLoaded(): boolean {
    try { return require('./plugin-permissions').isEgressPolicyLoaded() === true; } catch { return false; }
}
// Hooks whose filter return value is emitted as RAW, UNESCAPED HTML into every server-rendered page
// (theme-engine wraps wordjs_head/wordjs_footer in a Handlebars SafeString). A plugin shimming one of
// these is a stored-XSS primitive (incl. the admin UI), so it is denied for EVERY plugin — no plugin
// gets raw-HTML output hooks.
const RAW_HTML_HOOKS = new Set(['wordjs_head', 'wordjs_footer', 'wp_head', 'wp_footer']);

// Host auth/session cookies that must never be forwarded to (or overwritten by) an isolated
// plugin's route handler: `wordjs_token` is the HttpOnly auth JWT, plus defensive csrf/session names.
const HOST_AUTH_COOKIE_RE = /^wordjs_token$|csrf|xsrf|session/i;

// EXACT allowlist of bridge methods reachable via a kind:'call' IPC message. A malicious child sends
// ANY method string and callApi walks it as a dotted path on the api object — so without this gate it
// could reach registration methods (hooks.addAction/addFilter) DIRECTLY, bypassing the dedicated
// register kinds' caps + RAW_HTML_HOOKS denylist + teardown tracking, or `provideMail` past its trust
// gate, or a prototype-chain segment. Registration / mail-provider / notify-transport / route flow
// ONLY through their own IPC kinds, so they are deliberately ABSENT here (default-deny). Keep in sync
// with the callHost('…') calls in plugin-worker.js.
const ALLOWED_BRIDGE_METHODS = new Set([
    'options.get', 'options.set',
    // db.batch is the SAME capability as a loop of db.all/db.run — it re-validates every statement
    // with the identical permission + SQL guard host-side and refuses DDL (see plugin-api.ts).
    'db.all', 'db.get', 'db.run', 'db.batch', 'db.createTable', 'db.getType',
    'hooks.doAction',
    'fs.read', 'fs.write',
    'mail', 'notify',
    'adminMenu.add', 'cron.schedule',
    'crypto.randomToken', 'crypto.randomInt',
    'assets.enqueueScript', 'assets.enqueueStyle',
    'users.findByEmail', 'users.findByLogin', 'users.findById', 'users.search',
    'site.url', 'site.domain', 'site.adminEmail',
    // Host-mediated DNS (network-gated + private-IP-filtered host-side; see api.dns in plugin-api.ts).
    // The raw dns.resolve* surface is denied inside the isolate, so an MTA reaches MX/TXT records here.
    'dns.resolveMx', 'dns.resolveTxt', 'dns.resolve4', 'dns.resolve6', 'dns.resolve',
]);
// Navigate "options.get" / "mail" on the api object and call it with args.
function callApi(api: any, method: string, args: any[]) {
    if (!ALLOWED_BRIDGE_METHODS.has(String(method))) throw new Error(`Bridge method not permitted via call: ${method}`);
    const parts = String(method).split('.');
    let ctx: any = null;
    let fn: any = api;
    for (const p of parts) { ctx = fn; fn = fn ? fn[p] : undefined; }
    if (typeof fn !== 'function') throw new Error(`Unknown bridge method: ${method}`);
    return fn.apply(ctx, args);
}

/**
 * Load a plugin/theme into its own isolate — the ONLY entry point; startIsolate below does the work.
 *
 * SAME-SLUG SAFETY LIVES HERE. `isolates` maps a slug to exactly ONE handle, so two overlapping loads of
 * the same slug used to fork two children and the first was simply overwritten: gone from `isolates`,
 * never in `restartTimers`, invisible to listIsolates(), unreachable by unloadIsolatedPlugin and by the
 * theme sweep — yet alive, and still applying every filter and shortcode it had registered. That is
 * ordinary admin behaviour away, not a theoretical race: POST /themes/:slug/activate and
 * POST /plugins/:slug/activate both reach here, and a double-click or two admins overlap two loads.
 *
 * JOIN, don't fork: a second load for a slug already loading returns the FIRST load's promise, so both
 * callers get the same child and there is no second process to strand. (The alternative — fork and tear
 * the previous child down — spawns a process only to kill it, and leaves the loser's caller holding a
 * rejected activation. It survives here only as the backstop at `isolates.set`, for the paths that do not
 * come through an overlapping call at all.) `loading` is written SYNCHRONOUSLY, before the first await, so
 * there is no window in which a concurrent caller can miss the entry.
 *
 * A load naming a DIFFERENT entry file must not join: it waits for the in-flight one to settle and then
 * runs its own, so "load X from this file" never silently returns a child running a different file.
 */
function loadIsolatedPlugin(slug: string, entryFile: string, opts: { supervised?: boolean; readyTimeoutMs?: number } = {}): Promise<any> {
    const pending = loading.get(slug);
    if (pending && pending.entryFile === entryFile) return pending.promise;
    const rec: { promise: Promise<any>; entryFile: string } = {
        entryFile,
        promise: (async () => {
            // Different entry file for a slug already loading: let that load finish (its failure is its
            // own caller's business) so the two children can never overlap, then start ours.
            if (pending) { try { await pending.promise; } catch { /* not our load, not our error */ } }
            return startIsolate(slug, entryFile, opts);
        })(),
    };
    loading.set(slug, rec);
    // Clear only OUR OWN entry: a later load may already have replaced it (the different-entry-file path
    // above overwrites while the earlier one is still settling).
    const clear = () => { if (loading.get(slug) === rec) loading.delete(slug); };
    rec.promise.then(clear, clear);
    return rec.promise;
}

async function startIsolate(slug: string, entryFile: string, opts: { supervised?: boolean; readyTimeoutMs?: number } = {}): Promise<any> {
    // Resolve the memory-cap capabilities ONCE (cached) before building the child, so the spawn path is
    // chosen synchronously inside the executor below. cgroup (preventive) is preferred over rlimit (loose).
    const cgroupOk = await probeCgroupCap();
    const capKb = cgroupOk ? null : await probeOsMemoryCap();
    // Settle this platform's native confinement before argv is built.
    await probePlatformConfinement();
    let requireHardening = true;
    try { requireHardening = require('../config/app').sandbox?.requireHardening !== false; } catch { /* fail closed */ }
    const requireNativeSandbox = nativeSandboxRequired({
        configured: requireHardening,
        platform: process.platform,
        tsNode: __filename.endsWith('.ts'),
    });
    // FAIL-CLOSED: if the operator requires the OS backstop, REFUSE to launch when it isn't actually ACTIVE
    // (no such mechanism here, disabled, or the probe failed) instead of silently degrading to
    // JS-guards-only isolation.
    //
    // The gate asks about the mechanism native to this platform, using the same state vocabulary on all OSes.
    if (sandboxPlatformState !== 'active') {
        if (requireNativeSandbox) {
            const mech = platformKernelMechanism();
            const fix = mech === 'landlock' ? `Use a supported Linux kernel with Landlock and /usr/bin/perl (currently '${logSafe(linuxZeroConfState)}': ${logSafe(linuxZeroConfNote)})`
                : mech === 'appcontainer' ? 'Enable sandbox.useAppContainer on this Windows host (and check the [Sandbox] AppContainer warning in the log for the check that failed)'
                : mech === 'seatbelt' ? 'Enable sandbox.useSeatbelt on this macOS host (and check the [Sandbox] Seatbelt warning in the log for the check that failed)'
                : `No kernel confinement mechanism exists for platform '${logSafe(process.platform)}'`;
            throw new Error(`[Sandbox] refusing to launch isolated plugin '${slug}': sandbox.requireHardening is ON but this host's kernel confinement (${mech}) is '${sandboxPlatformState}' (not ACTIVE). ${fix}, or explicitly set sandbox.requireHardening=false to permit an unsafe compatibility fallback.`);
        }
    }
    const jobCapOk = await probeJobObjectCap();     // preventive memory cap on Windows (Job Object); false elsewhere
    // Cross-platform capability confinement, layered inside Landlock/AppContainer/Seatbelt. null means
    // unavailable on this Node (or explicitly opted out); the native OS boundary remains independently
    // mandatory under the default fail-closed policy.
    const permFlag = await probePermissionModel();
    // -- LAUNCH INPUTS ----------------------------------------------------------------------------
    // Everything from here down to `childStdio` used to be the first half of the Promise executor
    // below, and it is moved out UNCHANGED: it is pure, synchronous argv / env / stdio construction
    // that never referenced `resolve` or `reject`. It was moved for exactly one reason -- one launch
    // path (the Windows AppContainer relay) cannot be started synchronously, and it needs precisely
    // these values. Building them here lets that one path be AWAITED before the executor begins,
    // instead of duplicating the construction or deferring the spawn. No behaviour on any platform
    // changes: the same values are computed in the same order and consumed by the same branches.
    // In dev we run via ts-node and the worker must too (core is .ts); compiled, no flag needed.
    // Pass ONLY the ts-node register flag — forwarding all of process.execArgv trips Worker's
    // execArgv allowlist.
    const execArgv = __filename.endsWith('.ts') ? ['-r', 'ts-node/register'] : [];
    // DEFAULT-ON V8 hard block on runtime code generation (eval / new Function(string)) in the plugin
    // worker. The AST scanner catches eval/Function statically at install, but it does NOT scan the
    // plugin's dist/ (browser-bundle dir) — a plugin that require()s ./dist/x.js (now blocked at the
    // worker require boundary, but belt-and-suspenders) could ship an eval-constructed, un-vetted
    // payload there. Blocking codegen at the ENGINE level closes that class regardless of where the
    // code lives. On by default; an operator can opt OUT with config.sandbox.blockCodeGen === false
    // (e.g. for a trusted plugin whose deps genuinely need Function()). NEVER under ts-node (dev needs
    // codegen to compile TS).
    let blockCodeGen = true;
    try { const s = require('../config/app').sandbox; if (s && s.blockCodeGen === false) blockCodeGen = false; } catch { /* config unavailable → keep default-on */ }
    if (!__filename.endsWith('.ts') && blockCodeGen) execArgv.push('--disallow-code-generation-from-strings');
    // Pass an explicit, secret-free env ALLOWLIST instead of inheriting the full host environment:
    // the worker reaches config/secrets only via the RPC bridge, so app secrets in env
    // (JWT_SECRET, DB creds, STRIPE_KEY, …) must never enter the worker's process.env. This is
    // default-deny, unlike the in-worker name-pattern denylist (getProtectedEnv).
    const SAFE_ENV_KEYS = ['NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOMEDRIVE', 'HOMEPATH', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'OS', 'COMSPEC'];
    const workerEnv: Record<string, string> = {};
    for (const k of SAFE_ENV_KEYS) { if (process.env[k] !== undefined) workerEnv[k] = process.env[k] as string; }
    // OS-ISOLATION: run the untrusted plugin in a SEPARATE OS PROCESS, not a worker_thread. A worker
    // shares the host process's heap+rss, so an off-heap (Buffer) OOM or a hard V8 crash in the worker
    // takes down the HOST; a child has its OWN process + heap, so a crash, OOM, or heap escape is
    // contained to the child and the host always survives. The network grant is resolved HERE at
    // spawn (re-resolved on reload) so the child's network policy matches the current admin grant;
    // config travels in argv[2] (no secrets); env is the same secret-free allowlist.
    const netGranted = isNetworkGrantedFor(slug);
    // allowedHosts only matters for a network-granted plugin (a non-network plugin has no egress at all);
    // pushed into cfg so the child installs it as its egress-guard allowlist. Empty ⇒ allow-all-public.
    // Egress fail-CLOSED (audit F-06): if the egress policy could not be loaded (DB/options failure), a
    // network-granted plugin must NOT fall back to allow-all-public — signal deny-all so the child reaches
    // ZERO public hosts (private/loopback stay blocked) until the policy reloads. A successfully-loaded but
    // empty policy keeps the intended allow-all-public behavior (no regression).
    const egressDenyAll = netGranted && !egressPolicyLoaded();
    // The filesystem grant travels the same way and for the same reason (see fsGrantsFor): the child
    // cannot look it up, so the host answers for it. io-guard reads fsRead/fsWrite out of this blob.
    const fsGrant = fsGrantsFor(slug);
    // The same path declaration feeds every OS sandbox, Node's permission model and io-guard.
    const APP_ROOT = path.resolve(__dirname, '..', '..');
    const nativePaths = sandboxPaths(APP_ROOT, slug, __dirname);
    const storageEnabled = fsGrant.read || fsGrant.write;
    // Private capability storage is created only for a plugin that currently holds that capability.
    // Own-dir private storage remains the compatibility floor for zero-permission plugins.
    if (storageEnabled) for (const dir of nativePaths.storage) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sandboxWritable = [nativePaths.own, ...(fsGrant.write ? nativePaths.storage : [])];
    const sandboxReadable = Array.from(new Set([
        ...nativePaths.readOnly,
        ...(storageEnabled ? nativePaths.storage : []),
        ...sandboxWritable,
    ]));
    const storage = Object.freeze({ data: nativePaths.storage[0], logs: nativePaths.storage[1], tmp: nativePaths.storage[2] });
    const childCfg = JSON.stringify({ slug, entryFile, coreDir: __dirname, network: netGranted, allowedHosts: (netGranted && !egressDenyAll) ? getEgressAllowlistFor(slug) : [], egressDenyAll, fsRead: fsGrant.read, fsWrite: fsGrant.write, storage });
    const HEAP_FLAG = '--max-old-space-size=256'; // caps the JS HEAP; cgroup/rlimit/poll cap TOTAL memory
    // RSS_BUDGET_BYTES (resident budget — cgroup memory.max AND the /proc poll AND the Job-Object cap) is
    // module-scoped now, shared with cgroupResourceProps() so the probe and this launch never disagree.
    // structured-clone IPC (serialization 'advanced') preserves Buffer/Date/Map; the JSON default
    // (and a raw JSON channel) would lose them — match the worker_threads postMessage fidelity.
    // PIPE the child's stdout/stderr (was 'inherit') so a plugin console.log flood can't stream
    // straight to the operator's (possibly unbounded) log sink → disk-fill. attachLogLimiter forwards
    // them slug-tagged through a per-plugin rate/volume cap. stdin is IGNORED (=/dev/null): plugins
    // never read the operator's stdin/tty, so don't hand it to them. fd3 = ipc.
    const IPC_STDIO: any = ['ignore', 'pipe', 'pipe', 'ipc'];
    // Hand the SAME policy to Node's permission model, so reads are scoped to narrow core, dependency,
    // plugin and private-storage roots, and writes are scoped to exactly the zones
    // io-guard already permits — so this is behaviour-neutral for a well-behaved plugin and a hard
    // wall for one that is not. child_process / worker_threads / native addons / WASI are simply not
    // granted, which denies them in C++ rather than through a JS proxy that has to be kept in sync.
    //
    // NOT under ts-node: dev compiles TypeScript in-process and needs broader access than a
    // production child does. Same carve-out as blockCodeGen above, and for the same reason — the
    // production path is the one that has to be tight.
    if (permFlag && !__filename.endsWith('.ts')) {
        execArgv.push(permFlag);
        for (const dir of sandboxReadable) execArgv.push(`--allow-fs-read=${dir}`);
        for (const dir of sandboxWritable) execArgv.push(`--allow-fs-write=${dir}`);
        // NOTE: Node's permission model has NO `--allow-net` flag (never has — the tokens are
        // fs-read/fs-write/child-process/worker/wasi/addons). Passing it aborted the child on startup
        // with `bad option: --allow-net` (exit 9), so a network-GRANTED isolated plugin could not
        // activate in production at all. The JS egress guard remains the authority on where a
        // network-granted plugin may connect; the native sandbox decides only whether IP sockets exist.
    }
    let childStdio: any = IPC_STDIO;
    // -- LINUX ZERO-CONFIGURATION CONFINEMENT (Landlock + seccomp-bpf) -----------------------------
    // This is a PREFIX, like Seatbelt, so it sits in the same argv slot and
    // composes with everything already there:
    //   · the memory-cap wrapper — `sh -c 'ulimit -v N; ulimit -n M; exec "$@"' wjs-sandbox <prefix> node …`.
    //     The shell sets both rlimits and execs perl; perl applies Landlock+seccomp to ITSELF and execs
    //     node. Rlimits survive execve, so the caps still bite the process that matters.
    //   · the cgroup scope — the prefix sits inside `systemd-run
    //     --scope … -- env -u … <prefix> node …`, under the same MemoryMax/CPUQuota.
    //   · the permission-model flags and --disallow-code-generation-from-strings are part of `execArgv`,
    //     which travels in `nodeArgs` after the shim's `--`, so they reach node unchanged.
    //   · the fork-style IPC fd survives, because perl exec()s and never forks or touches the descriptor
    //     table — and that is the ONE property this module refuses to assume: probeLinuxZeroConf()
    //     requires a full process.send() round-trip through this exact prefix shape before it may report
    //     'active', so an fd-3 that did not survive means this branch is never reached at all.
    // A consequence of the exec: child.pid IS node's pid, so the
    // resident-RSS poll below reads /proc/<child.pid>/statm directly, with no subtree walk and no
    // orphan-reparenting window.
    const linuxFloor = linuxFloorDecision({ platform: process.platform, zeroConf: linuxZeroConfState, netGranted });
    let zeroConfPre: string[] = [];
    if (linuxFloor.layer === 'landlock') {
        try {
            const lz = require('./sandbox-linux');
            const fsx = require('fs');
            // MISSING ZONES ARE SKIPPED, and this is not a nicety — it is a divergence between the two
            // launches that would otherwise turn a working plugin into a failing load. `sandboxWritable`
            // names the io-guard zones an install MAY have; a fresh one has no logs/ or os-tmp/ until
            // something writes there, and a plugin isolate is often the first thing that does. The shim has no
            // affordance: Landlock has to OPEN each path to grant it, so a missing zone makes it fail
            // CLOSED with exit 79 and the child never runs at all.
            //   The probe cannot catch this: it grants a mkdtemp zone, which always exists. So it is
            // handled here, at the only place that knows the real zones — and it is a FILTER rather than
            // a create, because this module must not be the thing that decides an io-guard zone exists.
            const zones = sandboxWritable.filter((d: string) => { try { return fsx.statSync(d).isDirectory(); } catch { return false; } });
            // Read roots get the same treatment for the same reason (the shim fails closed on a read root
            // it cannot grant). Both entries below normally exist, so this only bites a broken install —
        // where a missing required runtime root means the child could not have loaded anyway.
            const runtimePrefix = path.dirname(path.dirname(process.execPath));
            const roots = [...sandboxReadable, ...(runtimePrefix.split(path.sep).filter(Boolean).length >= 2 ? [runtimePrefix] : [])]
                .filter((d) => { try { return fsx.statSync(d).isDirectory(); } catch { return false; } });
            if (!zones.length) {
                // Every zone gone is not a tighter sandbox, it is an unlaunchable one: the plugin could
                // not write its own directory. Take the standard launch and say so, rather than emitting
                // an argv whose only possible outcome is a failed load.
                throw new Error('none of the io-guard write zones exist on this install');
            }
            zeroConfPre = [lz.PERL_BIN, ...lz.shimArgs({
                // The io-guard write zones, THE SAME ARRAY --allow-fs-write
                // scopes, minus the ones that are not on disk. Not re-derived: four independent lists of
                // "what a plugin may write" drift, and it is always the loosest one that decides.
                zone: zones,
                denyNetwork: linuxFloor.denyNetwork,
                // The Node runtime prefix is REQUIRED, not a nicety: the shim deliberately does not grant
                // /home, so an nvm/asdf/fnm install (…/versions/node/vX/bin/node) would be unreadable and
                // the child would never boot. For a /usr/bin/node it lands on /usr, which the shim grants
                // anyway — harmless where redundant, load-bearing where it is not.
                readRoot: roots,
                execRoot: [process.execPath],
                nodeArgs: [],
            })];
        } catch (e: any) {
            if (requireNativeSandbox) {
                throw new Error(`[Sandbox] refusing to launch isolated plugin '${slug}': the certified Linux sandbox argv could not be built (${logSafe(e && e.message)}).`, { cause: e });
            }
            zeroConfPre = [];
            console.warn(`[Sandbox] Linux sandbox construction failed for '${logSafe(slug)}' (${logSafe(e && e.message)}); sandbox.requireHardening=false permits the unsafe compatibility fallback.`);
        }
    }
    // -- PLATFORM KERNEL CONFINEMENT (Windows / macOS) --------------------------------------------
    // This is where a Windows or macOS child either goes through its platform's kernel layer, or takes
    // EXACTLY the launch it took before those layers existed.
    //
    // `use === false` is the load-bearing case and it is deliberately the cheap one: nothing is added to
    // argv, nothing extra is spawned, and every branch in the executor below runs byte-identically to
    // today. A layer whose probe did not certify this host must cost the plugin nothing at all.
    const platformLaunch = platformLaunchDecision({
        platform: process.platform,
        state: sandboxPlatformState,
        netGranted,
        tsNode: __filename.endsWith('.ts'),
    });
    // macOS: the profile is built HERE — synchronously, mutating nothing — so that both Seatbelt-aware
    // spawn branches below share ONE profile string. Two builders would be two chances for the kernel's
    // write set and the JS guard's write set to drift, and it is always the looser one that matters.
    let seatbeltPre: string[] = [];
    let seatbeltRuntime: any = null;
    let nativeNodePath = process.execPath;
    const preSeatbeltExecArgvLength = execArgv.length;
    if (platformLaunch.use && platformLaunch.mechanism === 'seatbelt') {
        try {
            const mac = require('./sandbox-macos');
            seatbeltRuntime = mac.prepareSeatbeltRuntime(process.execPath);
            nativeNodePath = seatbeltRuntime.exe;
            workerEnv.WORDJS_SEATBELT_BOOTSTRAP = '1';
            workerEnv.WORDJS_SEATBELT_READY_FD = '4';
            workerEnv.WORDJS_SEATBELT_RELEASE_FD = '5';
            execArgv.push('-r', mac.SEATBELT_BOOTSTRAP_FILE);
            childStdio = [...IPC_STDIO, 'pipe', 'pipe'];
            // The profile always confines filesystem/process operations; the grant changes only network.
            const profile = mac.buildSeatbeltProfile({
                writableDirs: sandboxWritable,
                readOnlyDirs: sandboxReadable,
                denyNetwork: !netGranted,
                appRoot: APP_ROOT,
                nodePath: seatbeltRuntime.exe,
                runtimeRoots: seatbeltRuntime.runtimeRoots,
            });
            // seatbeltArgs() returns ARGUMENTS, not a command line, so the
            // caller decides where they sit. `[sandbox-exec, '-p', <profile>]` composes in front of the
            // node argv, INCLUDING inside the `sh -c 'ulimit …; exec "$@"'`
            // memory-cap wrapper: two execs in a row, and fd 3 (NODE_CHANNEL_FD) survives both, because
            // neither is a fork and neither touches the descriptor table. Each leg is separately
            // probe-verified with its own IPC round-trip — the shell leg by probeOsMemoryCap, the
            // sandbox-exec leg by probeSeatbelt — which is the only reason this composition is asserted
            // rather than assumed.
            seatbeltPre = [mac.SEATBELT_BIN, ...mac.seatbeltArgs(profile, [])];
        } catch (e: any) {
            try { require('./sandbox-macos').disposeSeatbeltRuntime(seatbeltRuntime); } catch { /* */ }
            seatbeltRuntime = null;
            nativeNodePath = process.execPath;
            execArgv.splice(preSeatbeltExecArgvLength);
            delete workerEnv.WORDJS_SEATBELT_BOOTSTRAP;
            delete workerEnv.WORDJS_SEATBELT_READY_FD;
            delete workerEnv.WORDJS_SEATBELT_RELEASE_FD;
            childStdio = IPC_STDIO;
            if (requireNativeSandbox) {
                throw new Error(`[Sandbox] refusing to launch isolated plugin '${slug}': the certified Seatbelt profile could not be built (${logSafe(e && e.message)}).`, { cause: e });
            }
            seatbeltPre = [];
            console.warn(`[Sandbox] Seatbelt profile construction failed for '${logSafe(slug)}' (${logSafe(e && e.message)}); sandbox.requireHardening=false permits the unsafe compatibility fallback.`);
        }
    }
    // Windows: the ONE launch in this module that cannot start synchronously. The contained child is
    // created by a PowerShell relay (CreateProcessW + SECURITY_CAPABILITIES), and its pid only exists once
    // that relay has returned — which is why the argv/env construction above was moved out of the executor.
    // Awaited HERE so the executor below still receives a ready ChildProcess and stays synchronous.
    let acLaunch: { child: any; containedPid: number | null } | null = null;
    if (platformLaunch.use && platformLaunch.mechanism === 'appcontainer') {
        try {
            acLaunch = await launchAppContainerChild(slug, APP_ROOT, {
                args: [...execArgv, HEAP_FLAG, WORKER_FILE, childCfg],
                env: workerEnv,
                stdio: childStdio,
                allowNetwork: netGranted,
                zones: { traverse: nativePaths.traverse, readExec: sandboxReadable, write: sandboxWritable },
            });
        } catch (e: any) {
            if (requireNativeSandbox) {
                throw new Error(`[Sandbox] refusing to launch isolated plugin '${slug}': the certified AppContainer launch failed (${logSafe(e && e.message)}).`, { cause: e });
            }
            acLaunch = null;
            console.warn(`[Sandbox] AppContainer launch failed for '${logSafe(slug)}' (${logSafe(e && e.message)}); sandbox.requireHardening=false permits the unsafe compatibility fallback.`);
        }
        // NOTE ON WHAT IS *NOT* RETRIED. This catch covers a failure to CREATE the contained child at all
        // (no SID, the relay produced nothing). If the relay starts and the contained node then dies —
        // exit 121, a missing grant, a plugin whose dependencies do not survive --preserve-symlinks — that
        // is an ordinary failed load and it fails LOUDLY, through failLoad, with the relay's WJSAC line
        // forwarded to the operator's log by attachLogLimiter. It is deliberately NOT retried unconfined:
        // "widen the sandbox until the plugin starts" is how a confinement layer stops meaning anything,
        // and the probe already proved this exact launch shape works on this host. The cost of that
        // strictness is intentional: the default-on production contract refuses a plugin whose native
        // container cannot be created instead of widening its authority until it starts.
    }
    return new Promise((resolve, reject) => {
        let child: any;
        let cgroupUnit: string | null = null;
        // The pid of the process that is ACTUALLY the plugin, when it is not `child.pid`. On the
        // AppContainer path `child` is the PowerShell RELAY and node runs inside the container — the same
        // shape the cgroup path already has, where `child.pid` is systemd-run. Null everywhere else.
        const containedPid: number | null = acLaunch ? acLaunch.containedPid : null;
        if (acLaunch) {
            // WINDOWS AppContainer: the child was created above (the relay is asynchronous) and it is
            // already wired to a fork-style IPC channel at 'advanced' fidelity — the plugin-worker
            // protocol crosses it UNCHANGED, which is the single measured fact this whole layer rests on.
            // Nothing else in this executor needs to know: `child` behaves like any other ChildProcess.
            //
            // TEARDOWN is by kernel refcount, not by pid: the relay holds the only handle to a Job Object
            // carrying JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so killing the relay kills the contained node —
            // This gives deterministic teardown: the job limit is set before the child's first instruction.
            child = acLaunch.child;
        } else if (cgroupOk) {
            // PREVENTIVE cgroup v2 caps: run the child in a transient --user scope with MemoryMax (the kernel
            // OOM-kills it by construction at the resident budget — no poll race; blast radius = the child)
            // and, when configured, CPUQuota (the anti-DoS core cap). cgroupResourceProps() is the SAME set
            // the probe validated, so activation guarantees these exact caps start. --scope runs node as a
            // direct child of systemd-run, inheriting the IPC fd (probe-verified); child.pid is systemd-run
            // and the kernel is the cap, so the /proc poll is skipped below.
            cgroupUnit = `wjp-${slug.replace('theme:', 'theme-').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${process.pid}-${++cgroupSeq}.scope`;
            // F-04: give the systemd-run CLIENT the session-bus vars (cgroupClientEnv) so `--user` connects
            // to the per-user manager, then SCOPE_ENV_STRIP (`env -u …`) removes them again inside the scope
            // so the plugin process's env is exactly workerEnv (bus vars never leak to the plugin).
            child = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--unit', cgroupUnit,
                ...cgroupResourceProps(), '--',
                ...SCOPE_ENV_STRIP,
                ...zeroConfPre, process.execPath, ...execArgv, HEAP_FLAG, WORKER_FILE, childCfg],
                { stdio: childStdio, serialization: 'advanced', env: cgroupClientEnv(workerEnv) });
        } else if (capKb) {
            // KERNEL-capped path: a shell sets RLIMIT_AS, then `exec`s node KEEPING the inherited IPC fd
            // (NODE_CHANNEL_FD + serialization mode are injected into the child env by the 'ipc' stdio and
            // survive the exec). argv after the shell name = [node, …execArgv, HEAP_FLAG, WORKER, cfg];
            // `exec "$@"` runs it, so cfg lands at process.argv[2] exactly like fork(WORKER,[cfg]).
            // Each platform contributes at most one native prefix. Current macOS does not reach this
            // branch because its enforcement probe correctly rejects Darwin's inert RLIMIT_AS alias.
            // Two prefixes, ONE slot, and at most one is non-empty: Seatbelt on macOS, Landlock on Linux.
            //   sh -c 'ulimit …; exec "$@"' wjs-sandbox /usr/bin/perl <shim> <zones> 1 -- node …
            // i.e. the shell sets the rlimits and execs perl, which confines ITSELF and execs node. Three
            // execs at most, no fork, no change to the descriptor table — so fd 3 (the IPC socketpair)
            // reaches node exactly as it does through the shell alone.
            const nodeArgv = [...seatbeltPre, ...zeroConfPre, nativeNodePath, ...execArgv, HEAP_FLAG, WORKER_FILE, childCfg];
            // Also cap file descriptors (RLIMIT_NOFILE, per-process) alongside the RLIMIT_AS memory backstop,
            // so a plugin can't exhaust the host fd table. Best-effort (2>/dev/null); exec runs regardless.
            child = spawn('sh', ['-c', `ulimit -v ${capKb} 2>/dev/null; ulimit -n ${FD_CAP} 2>/dev/null; exec "$@"`, 'wjs-sandbox', ...nodeArgv], {
                stdio: childStdio,
                serialization: 'advanced',
                env: workerEnv,
            });
        } else if (seatbeltPre.length) {
            // macOS with a CERTIFIED Seatbelt profile but no RLIMIT_AS wrapper on this host: launch node
            // THROUGH sandbox-exec directly.
            // sandbox-exec applies the profile to its own process and then execve()s node, so the
            // fork-style IPC fd survives — the property probeSeatbelt() exists to prove, and refuses to
            // report 'active' without.
            child = spawn(seatbeltPre[0], [...seatbeltPre.slice(1), nativeNodePath, ...execArgv, HEAP_FLAG, WORKER_FILE, childCfg], {
                stdio: childStdio,
                serialization: 'advanced',
                env: workerEnv,
            });
        } else if (zeroConfPre.length) {
            // LINUX with the zero-config floor certified but no RLIMIT_AS wrapper on this host (no usable
            // `sh`, or probeOsMemoryCap failed): launch node THROUGH the shim directly, the same way the
            // Seatbelt branch above does. perl applies Landlock
            // and seccomp to its own process and then execve()s node, so the fork-style IPC fd survives —
            // the property probeLinuxZeroConf() exists to prove and refuses to report 'active' without.
            //
            // child.pid is NODE here, not a wrapper, because the exec replaces perl rather than forking.
            // The reactive RSS poll can therefore read /proc/<child.pid>/statm directly.
            child = spawn(zeroConfPre[0], [...zeroConfPre.slice(1), process.execPath, ...execArgv, HEAP_FLAG, WORKER_FILE, childCfg], {
                stdio: childStdio,
                serialization: 'advanced',
                env: workerEnv,
            });
        } else {
            // No kernel cap available (Windows, or sh/rlimit absent): plain fork. Process separation still
            // protects the host; the /proc RSS poll below caps memory where available.
            child = fork(WORKER_FILE, [childCfg], {
                execArgv: [...execArgv, HEAP_FLAG],
                env: workerEnv,
                stdio: childStdio,
                serialization: 'advanced',
            });
        }
        if (seatbeltRuntime) {
            require('./sandbox-macos').armSeatbeltBootstrap(child, seatbeltRuntime).catch((error: any) => {
                console.error(`[Sandbox] Seatbelt one-shot exec bootstrap failed for '${logSafe(slug)}': ${logSafe(error && error.message)}`);
                try { child.kill('SIGKILL'); } catch { /* */ }
            });
        }
        // Record the pid as OURS-and-alive from the moment it exists (see livePids): the registry entry
        // below is not evidence of a running process, and every teardown path needs an answer that is.
        const spawnedPid: number | undefined = child.pid;
        if (spawnedPid) addLivePid(slug, spawnedPid);
        // WINDOWS preventive memory cap: assign the just-forked child to a Job Object whose per-process
        // commit limit (JOB_OBJECT_LIMIT_PROCESS_MEMORY = RSS_BUDGET_BYTES) makes the KERNEL fail any
        // allocation past the budget — the host stays safe even on a fast off-heap balloon, instead of
        // only the reactive poll below catching it. Assigned AFTER fork (IPC untouched); the job + cap
        // persist for the child's lifetime via the kernel job refcount (see buildJobCapScript). Async +
        // best-effort: the ~1–2 s assign latency is covered by the RSS poll exactly as before, and any
        // failure just leaves that poll as the only cap (zero regression). Only meaningful on win32
        // (jobCapOk is false elsewhere). The poll stays as a backstop for the brief assign window.
        //
        // NOT ON THE AppContainer PATH (`!acLaunch`), and this exclusion is load-bearing in BOTH
        // directions. `child.pid` there is powershell.exe, so capping it would (a) put a 768 MB commit
        // limit on the RELAY, which is not the thing that can balloon, and (b) leave the actual plugin
        // process uncapped while the log said a cap had been applied — a cap that reports success and
        // binds nothing. The contained child already carries the same ProcessMemoryLimit (plus the
        // ActiveProcessLimit fork-bomb cap and the CPU rate cap), applied by the relay BEFORE the child's
        // first instruction runs, which is strictly earlier than this post-spawn assignment could manage.
        let jobCapApplied = false; // set only when the kernel Job Object cap is CONFIRMED on this child
        if (jobCapOk && process.platform === 'win32' && child.pid && !acLaunch) {
            assignProcessToJobObject(child.pid, RSS_BUDGET_BYTES)
                .then((ok) => { jobCapApplied = ok; })
                .catch(() => { /* poll remains the cap */ });
        }
        // Forward + rate-limit the child's piped stdout/stderr (see IPC_STDIO above).
        attachLogLimiter(slug, child);
        // Worker-like adapter so the rest of this module stays transport-agnostic (postMessage/on/terminate).
        const worker: any = {
            // Reports whether the message could be handed to a LIVE child. This used to swallow the
            // failure silently, which meant an RPC to a dead worker settled only on the 30s timeout —
            // so any request that still reached a dead isolate (e.g. via a route the teardown missed)
            // held a socket, a req/res pair and a timer for half a minute instead of failing at once.
            // `connected` is the precise signal: child.send() also returns false under mere backpressure,
            // where the message IS still queued, but the IPC channel goes unconnected only once the
            // child is really gone.
            postMessage: (m: any) => {
                if (!child.connected) return false;
                try { child.send(m); return true; } catch { return false; }
            },
            terminate: () => {
                try { child.kill('SIGKILL'); } catch { /* already gone */ }
                // cgroup mode: child.pid is systemd-run; also kill the SCOPE so the node grandchild can't
                // outlive it (scopes are manager-tracked, not tied to systemd-run's lifetime).
                if (cgroupUnit) { try { spawn('systemctl', ['--user', 'kill', '--signal=SIGKILL', cgroupUnit], { stdio: 'ignore' }); } catch { /* */ } }
            },
            on: child.on.bind(child),
            _child: child,
        };
        let settled = false; // load Promise settled (ready / init-error / early exit / ready timeout)
        let readyTimer: any = null; // startup deadline — see READY_TIMEOUT_MS; cleared by 'ready' and failLoad
        // Reactive per-child RSS poll — the FALLBACK resident cap when the preventive cgroup cap isn't
        // available (Windows, macOS, non-systemd). Runs on the HOST loop reading the child's OWN rss, so
        // it's immune to the child blocking its own loop; covers Linux /proc, Windows tasklist, macOS ps.
        // Skipped in cgroup mode (the kernel memory.max IS the cap, and child.pid there is systemd-run,
        // not the node child). RSS_BUDGET_BYTES is defined above (shared with cgroup memory.max).
        let rssPoll: any = null;
        // WHICH PID THE RESIDENT POLL MUST READ.
        //
        // Everywhere except the AppContainer path this is `child.pid`, unchanged. THERE, `child.pid` is
        // the PowerShell relay: polling it would measure a ~60 MB supervisor that never crosses the
        // budget, so the resident cap would stop biting and NOTHING would say so — a cap that silently
        // stops enforcing is worse than one that was never there, because the health surface still shows
        // green. Read the CONTAINED pid instead.
        //
        // When the relay never reported one, do not poll AT ALL rather than poll the wrong process, and
        // say so out loud. That is not a gap: the relay assigns the contained child a Job Object carrying
        // the same ProcessMemoryLimit before its first instruction runs, so the resident cap there is
        // PREVENTIVE and kernel-enforced — exactly the trade the cgroup path already makes when it skips
        // this poll because `child.pid` is systemd-run.
        const pollPid: number | null = acLaunch ? containedPid : (child.pid || null);
        if (acLaunch && !containedPid) {
            console.warn(`[Isolate ${logSafe(slug)}] the AppContainer relay reported no contained pid — the reactive RSS poll is SKIPPED for this child; its resident cap is the relay's kernel Job Object alone.`);
        }
        const killOverBudget = (rssBytes: number) => {
            getHealth(slug).rssBytes = rssBytes; // single choke point for RSS across all platforms → health surface
            if (rssBytes > RSS_BUDGET_BYTES) {
                console.error(`[Isolate ${logSafe(slug)}] killed: child rss over budget (${logSafe(rssBytes)} bytes).`);
                // `child` is the relay on the AppContainer path, and killing it is still the correct and
                // complete action: KILL_ON_JOB_CLOSE takes the contained node down with it.
                try { child.kill('SIGKILL'); } catch { /* gone */ }
            }
        };
        if (!cgroupOk && process.platform === 'linux' && child.pid) {
            // Cheapest path: synchronous /proc read on the host loop (field 2 of statm = resident pages).
            // The Landlock shim execs Node in place, so child.pid is always the process being measured.
            const fsmod = require('fs');
            const rssBytesOf = (pid: number): number => {
                try { return (parseInt(String(fsmod.readFileSync(`/proc/${pid}/statm`, 'utf8')).split(' ')[1], 10) || 0) * 4096; } catch { return 0; }
            };
            rssPoll = setInterval(() => {
                try { killOverBudget(rssBytesOf(child.pid)); } catch { /* child gone / statm unavailable */ }
            }, 250);
            if (rssPoll.unref) rssPoll.unref();
        } else if ((process.platform === 'win32' || process.platform === 'darwin') && pollPid) {
            // No /proc: ask the OS for the child's rss on the HOST loop (tasklist on Windows, ps on
            // macOS). Heavier (spawns a query), so poll less often and never overlap queries. Best-effort
            // — an unparsed result just skips that tick (falls back to process separation), never throws.
            // `pollPid` is `child.pid` on every path but the AppContainer one, where it is the CONTAINED
            // pid (see its declaration above): a Seatbelt child is exec'd in place, so there is no
            // indirection to unwind there and `pollPid === child.pid`.
            let busy = false;
            let tick = 0;
            rssPoll = setInterval(() => {
                if (busy || !pollPid) return;
                // Once the kernel Job Object cap is confirmed (win32), enforcement is preventive and
                // this poll is telemetry only — spawn the query 1 tick in 10 instead of every tick
                // (with 5 plugins the per-second tasklist spawns cost ~25% of a core at idle). Until
                // that confirmation (and always on macOS) the poll stays the enforcement backstop.
                if (jobCapApplied && (tick++ % 10) !== 0) return;
                busy = true;
                let proc: any;
                try {
                    proc = (process.platform === 'win32')
                        ? spawn('tasklist', ['/FI', `PID eq ${pollPid}`, '/NH', '/FO', 'CSV'], { windowsHide: true })
                        : spawn('ps', ['-o', 'rss=', '-p', String(pollPid)]);
                } catch { busy = false; return; }
                let out = '';
                try { proc.stdout.on('data', (d: any) => { out += d.toString(); }); } catch { /* */ }
                proc.on('error', () => { busy = false; });
                proc.on('close', () => {
                    busy = false;
                    try {
                        let rssBytes = -1;
                        if (process.platform === 'win32') {
                            // CSV row: …,"<mem> KB" — locale-formatted KiB (e.g. "56.724 KB" / "56,724 K").
                            // Take the LAST quoted field, strip ALL non-digits (separators + unit) -> KiB.
                            const fields = out.match(/"[^"]*"/g);
                            if (fields && fields.length) {
                                const digits = fields[fields.length - 1].replace(/\D/g, "");
                                if (digits) rssBytes = parseInt(digits, 10) * 1024;
                            }
                        } else {
                            const kb = parseInt(out.trim(), 10); // ps -o rss= → KiB
                            if (!isNaN(kb)) rssBytes = kb * 1024;
                        }
                        if (rssBytes >= 0) killOverBudget(rssBytes);
                    } catch { /* unparseable → skip this tick */ }
                });
                // macOS has NO preventive kernel cap (cgroup=Linux, Job Object=win32), so this reactive
                // poll is the only resident cap there — tighten its window vs Windows (which has the Job
                // Object preventive cap) so a fast synchronous allocation balloon is caught sooner.
            }, process.platform === 'darwin' ? 400 : 1000);
            if (rssPoll.unref) rssPoll.unref();
        }
        child.on('exit', () => { if (rssPoll) clearInterval(rssPoll); dropLivePid(slug, spawnedPid); });
        const api = createPluginApi(slug);
        let invokeId = 0;
        // Backpressure: bound concurrent worker→host bridge calls so a runaway/malicious plugin can't
        // flood the host with privileged RPCs (each runs a permission-checked bridge call here).
        let inflightCalls = 0;
        let callBackpressureRejections = 0;
        const MAX_INFLIGHT_CALLS = 200;

        // Inbound IPC message-rate guard (#5): a malicious child can spam ANY message kind — including
        // spoofed invoke-reply/route-reply with unknown ids (rpcSettle no-ops) or unrecognized kinds —
        // none of which the call/registration flood guards count, yet each still wakes + runs this host
        // handler. Bound messages per sliding window and recycle a flooding child (host event-loop DoS).
        const MSG_WINDOW_MS = 1000, MAX_MSGS_PER_WINDOW = 20000;
        let msgWindowStart = Date.now(), msgWindowCount = 0;
        // Bridge-call RATE guard (#6): concurrency is capped (MAX_INFLIGHT_CALLS) but a child can still
        // sustain a high call rate within that limit, pinning the host's shared DB handle. Token bucket:
        // burst up to CALL_BUCKET_MAX, refilled CALL_REFILL_PER_SEC; over-budget calls are rejected and
        // counted toward the existing flood-kill. (Per-QUERY cost/timeout is a separate driver-level item.)
        const CALL_BUCKET_MAX = 2000, CALL_REFILL_PER_SEC = 1000;
        let callTokens = CALL_BUCKET_MAX, callBucketTs = Date.now();

        // Registration caps: 'call' is bounded by MAX_INFLIGHT_CALLS, but the fire-and-forget
        // register-* kinds (hooks/routes/shortcodes) were unbounded — a plugin could spam them to
        // exhaust host memory (accumulated shims) and flood the event loop. Cap per kind, and hard-kill
        // a worker that keeps spamming after being capped (event-loop-flood DoS).
        const MAX_HOOKS = 500, MAX_ROUTES = 200, MAX_SHORTCODES = 200;
        const MAX_PER_HOOK = 16; // cap callbacks on a SINGLE hook name (latency-amplification DoS)
        const hookNameCounts = new Map<string, number>();
        let registrationAttempts = 0;
        let registrationCapWarned = false;
        const registrationRejected = (arr: any[], max: number, kind: string): boolean => {
            registrationAttempts++;
            if (registrationAttempts > 10000) {
                console.error(`[Isolate ${logSafe(slug)}] terminated: registration flood (${logSafe(registrationAttempts)} attempts).`);
                try { worker.terminate(); } catch { /* already gone */ }
                return true;
            }
            if (arr.length >= max) {
                if (!registrationCapWarned) {
                    registrationCapWarned = true;
                    console.warn(`[Isolate ${logSafe(slug)}] registration cap reached (${logSafe(kind)} >= ${logSafe(max)}); ignoring further registrations (possible DoS).`);
                }
                return true;
            }
            return false;
        };

        // Every host→worker RPC carries a hard timeout: a plugin that never replies (hang or DoS)
        // must not pin an HTTP request open or leak a pending entry forever. rpcSettle clears it.
        const RPC_TIMEOUT_MS = 30000;
        const rpcSend = (map: Map<number, any>, message: any): Promise<any> => new Promise((res, rej) => {
            const id = ++invokeId;
            const timer = setTimeout(() => {
                if (map.has(id)) {
                    map.delete(id);
                    rej(new Error(`Isolated plugin '${slug}' RPC timed out`));
                    // A handler that blew the timeout is wedged (hang / synchronous spin) — recycle the
                    // worker so it can't keep leaking pending requests or pinning host timers/sockets.
                    console.error(`[Isolate ${logSafe(slug)}] terminated: RPC timeout (wedged handler).`);
                    try { worker.terminate(); } catch { /* already gone */ }
                }
            }, RPC_TIMEOUT_MS);
            if ((timer as any).unref) (timer as any).unref();
            map.set(id, { res, rej, timer });
            // Fail FAST when the child is already gone: waiting out RPC_TIMEOUT_MS for a reply that can
            // never arrive is what turns a stale registration into a socket-exhaustion lever.
            if (worker.postMessage({ id, ...message }) === false) {
                clearTimeout(timer);
                map.delete(id);
                rej(new Error(`Isolated plugin '${slug}' is not running`));
            }
        });
        // Cap a single worker->host reply payload to protect the HOST heap (the worker is also
        // memory-capped on its own side, so this is the second bound). Cheap size check for string/
        // buffer replies; object replies are bounded by the worker's memory watchdog.
        const MAX_REPLY_BYTES = 32 * 1024 * 1024;
        const replySize = (v: any, maxNodes = 5_000_000): number => {
            if (typeof v === 'string') return Buffer.byteLength(v);
            if (Buffer.isBuffer(v) || v instanceof Uint8Array) return (v as any).byteLength || (v as any).length || 0;
            if (v && typeof v === 'object') {
                // Bounded structural estimate so a giant nested object/array reply ALSO trips the cap
                // (it was already structured-cloned onto the host; we reject + recycle to stop repeats).
                let bytes = 0, n = 0;
                const stack: any[] = [v];
                while (stack.length) {
                    const cur = stack.pop();
                    if (++n > maxNodes) return Number.MAX_SAFE_INTEGER; // pathological node count → over budget
                    if (typeof cur === 'string') bytes += cur.length;
                    else if (cur && typeof cur === 'object') { for (const k in cur) stack.push((cur as any)[k]); bytes += 16; }
                    else bytes += 8;
                    if (bytes > MAX_REPLY_BYTES) return bytes;
                }
                return bytes;
            }
            return 0;
        };
        const rpcSettle = (map: Map<number, any>, msg: any, value: any) => {
            const p = map.get(msg.id);
            if (!p) return;
            map.delete(msg.id);
            clearTimeout(p.timer);
            if (!msg.ok) { p.rej(new Error(msg.error)); return; }
            if (replySize(value) > MAX_REPLY_BYTES) {
                console.error(`[Isolate ${logSafe(slug)}] terminated: oversized RPC reply.`);
                try { worker.terminate(); } catch { /* already gone */ }
                p.rej(new Error(`Isolated plugin '${slug}' returned an oversized reply`));
                return;
            }
            p.res(value);
        };

        const pendingInvoke = new Map<number, any>();
        const invokeWorker = (cbId: string, args: any[]) => rpcSend(pendingInvoke, { kind: 'invoke', cbId, args });

        const pendingRoute = new Map<number, any>();
        const invokeRoute = (routeId: string, req: any) => rpcSend(pendingRoute, { kind: 'invoke-route', routeId, req });

        const pendingShortcode = new Map<number, any>();
        // Everything the plugin registers in host-side state, tracked so we can fully tear it
        // down on unload/reload — otherwise a stale route/hook/shortcode would RPC a dead worker.
        const registeredShortcodes: string[] = [];                                  // shortcode tags
        const registeredRoutes: Array<{ m: string; full: string; handler: any }> = []; // mounted Express routes
        const registeredHooks: Array<{ hook: string; type: string; shim: (...args: any[]) => any }> = []; // hook/filter shims
        let providedMail = false;                                                   // did this plugin become the mail sender
        const invokeShortcode = (scId: string, payload: any) => rpcSend(pendingShortcode, { kind: 'invoke-shortcode', scId, ...payload });

        const pendingMail = new Map<number, any>();
        const invokeMail = (mailMsg: any) => rpcSend(pendingMail, { kind: 'invoke-mail', msg: mailMsg });

        const pendingTransport = new Map<number, any>();
        const invokeNotifyTransport = (name: string, notification: any) => rpcSend(pendingTransport, { kind: 'invoke-notify-transport', name, notification });

        worker.on('message', async (msg: any) => {
          // A malicious child can postMessage ANY object. An uncaught throw in a branch below would
          // reject this async handler → unhandledRejection → host process crash (Node >= 15 default).
          // Contain every message: log and drop a poison/malformed one instead of crashing the host.
          try {
            // (#5) Global inbound-message rate cap — counts EVERY message (incl. spoofed replies and
            // unknown kinds the per-kind guards skip) so a child can't saturate the host loop with them.
            const _now = Date.now();
            if (_now - msgWindowStart > MSG_WINDOW_MS) { msgWindowStart = _now; msgWindowCount = 0; }
            if (++msgWindowCount > MAX_MSGS_PER_WINDOW) {
                console.error(`[Isolate ${logSafe(slug)}] terminated: IPC message-rate flood (${logSafe(msgWindowCount)} in ${logSafe(MSG_WINDOW_MS)}ms).`);
                try { worker.terminate(); } catch { /* already gone */ }
                return;
            }
            if (msg.kind === 'ready') {
                settled = true;
                if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; } // the startup deadline is met
                resolve({ worker, slug });
            } else if (msg.kind === 'fatal') {
                // The child hit an unrecoverable condition (guard-install failed, ESM guard unavailable,
                // memory budget exceeded) and is exiting. These messages were previously DROPPED, so the
                // death showed only as a bare 'code 1'. Capture the precise reason for the health surface.
                const reason: string = String(msg.error || 'fatal error in sandbox');
                getHealth(slug).lastError = reason;
                console.error(`[Isolate ${logSafe(slug)}] fatal: ${logSafe(reason)}`);
                // failLoad, not a bare reject: the child is registered and hook-wired by now (see it).
                failLoad(new Error(reason));
            } else if (msg.kind === 'init-error') {
                // The plugin's init() threw. plugin-worker.js does NOT exit after sending this, so the
                // child stays alive with everything it registered before the throw still applying to
                // host content — failLoad is what makes the rejection mean "nothing of it is left".
                failLoad(new Error(msg.error));
            } else if (msg.kind === 'call') {
                // The isolate invoked a wordjs.* method — run it here, in the plugin's context.
                if (inflightCalls >= MAX_INFLIGHT_CALLS) {
                    // Over-limit calls are cheap-rejected, but a worker that floods far faster than the
                    // host can drain (thousands of calls while pinned at the limit) is hammering the
                    // event loop — terminate it as abusive (DoS containment, like registrationRejected).
                    if (++callBackpressureRejections > 50000) {
                        console.error(`[Isolate ${logSafe(slug)}] terminated: bridge-call flood (${logSafe(callBackpressureRejections)} over-limit calls).`);
                        try { worker.terminate(); } catch { /* already gone */ }
                        return;
                    }
                    worker.postMessage({ kind: 'reply', id: msg.id, ok: false, error: `Isolated plugin '${slug}' exceeded concurrent bridge-call limit` });
                    return;
                }
                // (#6) Rate-limit calls (token bucket) ON TOP OF the concurrency cap, so a sustained high
                // call rate can't pin the host's shared DB handle even while under MAX_INFLIGHT_CALLS.
                const _cnow = Date.now();
                callTokens = Math.min(CALL_BUCKET_MAX, callTokens + ((_cnow - callBucketTs) / 1000) * CALL_REFILL_PER_SEC);
                callBucketTs = _cnow;
                if (callTokens < 1) {
                    if (++callBackpressureRejections > 50000) {
                        console.error(`[Isolate ${logSafe(slug)}] terminated: bridge-call flood (sustained rate).`);
                        try { worker.terminate(); } catch { /* already gone */ }
                        return;
                    }
                    worker.postMessage({ kind: 'reply', id: msg.id, ok: false, error: `Isolated plugin '${slug}' exceeded bridge-call rate limit` });
                    return;
                }
                callTokens -= 1;
                // (#3/#2) Bound INBOUND call-arg size — the reply guard covers only the outbound path. Use
                // a LOW node cap (legit bridge args are tiny): a cheap-to-send / expensive-to-walk payload
                // (~5M one-char strings) would otherwise pin the host loop ~440ms inside this very check.
                // 100k nodes bounds the walk to a few ms while still rejecting the flood as over-budget.
                if (replySize(msg.args, 100_000) > MAX_REPLY_BYTES) {
                    worker.postMessage({ kind: 'reply', id: msg.id, ok: false, error: `Isolated plugin '${slug}' sent oversized bridge-call args` });
                    return;
                }
                inflightCalls++;
                try {
                    const value = await runWithContext(slug, () => callApi(api, msg.method, msg.args));
                    worker.postMessage({ kind: 'reply', id: msg.id, ok: true, value });
                } catch (e: any) {
                    worker.postMessage({ kind: 'reply', id: msg.id, ok: false, error: String(e && e.message || e) });
                } finally {
                    inflightCalls--;
                }
            } else if (msg.kind === 'register') {
                if (registrationRejected(registeredHooks, MAX_HOOKS, 'hooks')) return;
                // (#3) No plugin may shim raw-HTML output hooks (stored-XSS into every SSR page, incl.
                // admin). Denied for ALL plugins — no trust tier exists to exempt anyone.
                if (RAW_HTML_HOOKS.has(msg.hook)) {
                    console.warn(`[Isolate ${logSafe(slug)}] denied: plugin may not shim raw-HTML hook '${logSafe(msg.hook)}' (XSS risk).`);
                    return;
                }
                // Cap callbacks PER hook NAME too: many shims on one core hook (e.g. the_content)
                // amplify per-request latency even with the per-shim timeout below.
                const hookCnt = (hookNameCounts.get(msg.hook) || 0) + 1;
                hookNameCounts.set(msg.hook, hookCnt);
                if (hookCnt > MAX_PER_HOOK) {
                    console.warn(`[Isolate ${logSafe(slug)}] too many callbacks on hook '${logSafe(msg.hook)}' (cap ${logSafe(MAX_PER_HOOK)}) — ignoring further.`);
                    return;
                }
                // Install a shim in the real hook system that calls back into the isolate. Cap the
                // latency a plugin shim can inject into a CORE hook: race the worker call against a short
                // timeout that falls back to the unchanged value (filters) / no-op (actions), so a slow
                // or hung plugin can't add up to RPC_TIMEOUT_MS (30s) to every request that fires the
                // hook. The underlying RPC still times out and recycles the wedged worker separately.
                const HOOK_SHIM_TIMEOUT_MS = 2000;
                const shim = (...args: any[]) => {
                    let t: any;
                    const fallback = new Promise((resolve) => {
                        t = setTimeout(() => resolve(args[0]), HOOK_SHIM_TIMEOUT_MS);
                        if (t.unref) t.unref();
                    });
                    return Promise.race([
                        invokeWorker(msg.cbId, args).then((v) => { clearTimeout(t); return v; }, () => { clearTimeout(t); return args[0]; }),
                        fallback,
                    ]);
                };
                registeredHooks.push({ hook: msg.hook, type: msg.hookType, shim });
                runWithContext(slug, () => {
                    if (msg.hookType === 'filter') hooks.addFilter(msg.hook, shim, msg.priority);
                    else hooks.addAction(msg.hook, shim, msg.priority);
                });
            } else if (msg.kind === 'invoke-reply') {
                rpcSettle(pendingInvoke, msg, msg.value);
            } else if (msg.kind === 'register-route') {
                if (registrationRejected(registeredRoutes, MAX_ROUTES, 'routes')) return;
                // msg.method is attacker-controlled (a malicious child sends any message): allowlist HTTP
                // verbs so app[m] below can't invoke an ARBITRARY Express app method (use/set/engine/
                // listen/…) or throw a TypeError on a non-method (which would crash the host handler).
                const routeMethod = String(msg.method).toLowerCase();
                if (!['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'].includes(routeMethod)) {
                    console.warn(`[Isolate ${logSafe(slug)}] rejected route registration with invalid method '${logSafe(routeMethod)}'.`);
                    return;
                }
                // SECURITY (host DoS): `routePath` is attacker-controlled — a malicious child sends any
                // string — and it is concatenated into the Express route pattern below, which Express 4
                // compiles with path-to-regexp 0.1.x. That compiler passes a `:param(<regex>)` custom
                // regex THROUGH into the router's matcher, so a plugin can inject a catastrophic-
                // backtracking pattern (e.g. `/:p((a+)+b)`): one unauthenticated GET to
                // `/api/v1/plugin/<slug>/aaaa…!` then pins the SHARED host event loop for tens of seconds
                // (measured: 32 chars → 22 s), a full-site DoS from an unprivileged sandboxed plugin.
                // Plugins only ever need static segments, `:params` and a `*` wildcard — never a custom
                // regex — so allow exactly that charset and reject everything that could inject regex
                // structure (parens/quantifiers/anchors/classes). This kills the whole ReDoS class at the
                // door rather than trying to detect evil regexes.
                const routePath = String(msg.routePath == null ? '' : msg.routePath);
                if (routePath.length > 200 ||
                    !/^\/[A-Za-z0-9_./:*-]*$/.test(routePath) ||   // static + :param + * only, no regex metachars
                    routePath.includes('::') ||                    // malformed param
                    (routePath.match(/\*/g) || []).length > 2 ||   // cap wildcards (bounds (.*) polynomial blowup)
                    routePath.includes('..')) {                    // no traversal-looking segments
                    console.warn(`[Isolate ${logSafe(slug)}] rejected route registration with unsafe path '${logSafe(routePath.slice(0, 80))}'.`);
                    return;
                }
                // Mount an Express route owned by the host; run the real auth middleware, then forward
                // a serialized request to the isolate and write back its response descriptor.
                const { getApp } = require('./appRegistry');
                const app = getApp();
                if (!app) return;
                const mw: any[] = [];
                if (msg.opts && msg.opts.auth) mw.push(require('../middleware/auth').authenticate);
                if (msg.opts && msg.opts.admin) mw.push(require('../middleware/permissions').isAdmin);
                // Multipart uploads can't be serialized over RPC, so the HOST parses them (multer)
                // and forwards the saved file's metadata to the isolate. opts.multipart = field name.
                if (msg.opts && msg.opts.multipart) {
                    try {
                        const multer = require('multer');
                        const os = require('os');
                        // Cap upload size: this was the ONE multer instance with no fileSize limit, so a
                        // plugin multipart route (e.g. mail attachments) accepted multi-GB bodies → tmp-disk DoS.
                        let maxFileSize = 10 * 1024 * 1024;
                        try { maxFileSize = require('../config/app').uploads.maxFileSize || maxFileSize; } catch { /* default */ }
                        const up = multer({ dest: path.join(os.tmpdir(), 'wordjs-uploads'), limits: { fileSize: maxFileSize, files: 1 } });
                        mw.push(up.single(String(msg.opts.multipart)));
                        startUploadReaper(); // sweep crash-orphaned temp uploads (the per-request unlink handles the happy path)
                    } catch (e: any) { console.warn(`[Isolate ${logSafe(slug)}] multipart unavailable: ${logSafe(e && e.message)}`); }
                }
                const cookieNs = `wjp_${slug.replace('theme:', 'theme-').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}_`;
                const finalHandler = async (req: any, res: any) => {
                    // Delete the multer temp file once the response completes. The isolate only receives the
                    // path (never owns the file), so nothing else would ever unlink it → unbounded os-tmp
                    // disk-fill. Fire on both finish and close (client abort), once.
                    if (req.file && req.file.path) {
                        const tmpPath = req.file.path;
                        let cleaned = false;
                        const cleanup = () => { if (cleaned) return; cleaned = true; require('fs').unlink(tmpPath, () => { /* best effort */ }); };
                        res.on('finish', cleanup);
                        res.on('close', cleanup);
                    }
                    // (#2) Never hand the host's HttpOnly auth JWT (wordjs_token) to a plugin's handler —
                    // the authenticated identity is already provided via reqData.user, so the raw token is
                    // not needed. ALWAYS strip auth/session cookies before forwarding (no trust exemption).
                    const fwdCookies = Object.fromEntries(Object.entries(req.cookies || {}).filter(([k]) => !HOST_AUTH_COOKIE_RE.test(k)));
                    // A STABLE, privacy-preserving per-client key so a plugin can rate-limit / dedup by caller
                    // WITHOUT ever seeing the raw IP. It MUST be an HMAC keyed with a per-install secret that
                    // is never exposed to plugins — a plain sha256('wjck:'+ip) over the 32-bit IPv4 space is
                    // trivially rainbow-tabled back to the raw visitor IP, and the table is reusable across
                    // every install because the prefix is a global constant (#28/#30). Key it with the JWT
                    // secret (per-install, persisted, plugin-invisible); fall back to a stable per-process key.
                    const clientKey = (() => {
                        try {
                            const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || '');
                            if (!ip) return '';
                            const crypto = require('crypto');
                            let secret: string | undefined;
                            try { secret = require('../config/app').jwtSecret; } catch { /* config unavailable */ }
                            // The default placeholder (app.ts) is a GLOBAL constant present on env-var/Docker
                            // deploys with no wordjs-config.json — using it would make clientKey reversible
                            // across every install (#28). Treat it as absent → per-process random key.
                            if (!secret || secret === 'wordjs-default-secret-change-me') {
                                const g: any = globalThis as any;
                                secret = g.__wjClientKeySecret || (g.__wjClientKeySecret = crypto.randomBytes(32).toString('hex'));
                            }
                            return crypto.createHmac('sha256', 'wjck-hmac:' + secret).update(ip).digest('hex').slice(0, 24);
                        } catch { return ''; }
                    })();
                    const reqData = {
                        method: req.method, path: req.path, query: req.query, params: req.params, body: req.body,
                        clientKey,
                        cookies: fwdCookies,
                        headers: { 'x-portal-token': req.headers['x-portal-token'] }, // selected non-sensitive headers
                        // Saved-upload metadata (multer) — the isolate gets the path/name, not the stream.
                        file: req.file ? { path: req.file.path, originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size, filename: req.file.filename } : undefined,
                        // `hasProfessionalMailbox` is the ACTIVE CORPORATE MAILBOX grant
                        // (user_meta.professional_mailbox, admin-owned — see core/mailbox.ts). It is
                        // projected as a boolean so a plugin route gate reads the FACT instead of
                        // re-deriving it from userEmail, which the account itself can write. Rebuilt per
                        // request from req.user, so revoking the grant denies the very next request.
                        user: req.user ? {
                            id: req.user.id, role: req.user.role, userEmail: req.user.userEmail, userLogin: req.user.userLogin,
                            hasProfessionalMailbox: hasProfessionalMailbox(req.user)
                        } : null
                    };
                    try {
                        const r = await invokeRoute(msg.routeId, reqData);
                        if (r.headers) {
                            // (#3) A plugin must not set response headers verbatim: Set-Cookie would
                            // re-inject a host cookie (e.g. wordjs_token), bypassing the clamped r.cookies
                            // path below, and CSP/HSTS/Location let it weaken host security or open-redirect.
                            // ALWAYS drop those (no trust exemption); cookies must flow through the clamped path.
                            // Also drop content-type (a plugin forcing text/html on the JSON body = same-origin
                            // XSS on the API origin, #15), refresh (open redirect, #21) and every access-control-*
                            // header (CORS override, #21). The body is ALWAYS sent via res.json below, so dropping
                            // content-type lets Express set the correct application/json.
                            const UNSAFE = new Set(['set-cookie', 'set-cookie2', 'content-security-policy', 'strict-transport-security', 'location', 'content-type', 'refresh']);
                            const safe: any = {};
                            for (const [k, v] of Object.entries(r.headers)) {
                                const lk = String(k).toLowerCase();
                                if (UNSAFE.has(lk) || lk.startsWith('access-control-')) continue;
                                safe[k] = v;
                            }
                            res.set(safe);
                        }
                        // Replay cookies the isolate set/cleared on the real response.
                        if (Array.isArray(r.cookies)) {
                            for (const c of r.cookies.slice(0, 20)) { // (#5) cap cookies per reply
                                let name = String(c.name || '');
                                let options = c.options || {};
                                // (#5) Plugins may set cookies ONLY in their own namespace and scope: never
                                // overwrite a host cookie (wordjs_token/session), never widen scope via
                                // `domain`, and never escape their route path; clamp lifetime. Applied to ALL
                                // plugins (no trust exemption).
                                if (HOST_AUTH_COOKIE_RE.test(name)) { console.warn(`[Isolate ${logSafe(slug)}] dropped cookie '${logSafe(name)}' (would shadow a host cookie).`); continue; }
                                if (!name.startsWith(cookieNs)) name = cookieNs + name;
                                options = { ...options };
                                delete options.domain;
                                options.path = `/api/v1/plugin/${slug.replace('theme:', 'theme-')}`;
                                const MAX_AGE = 7 * 24 * 3600 * 1000;
                                if (typeof options.maxAge === 'number' && options.maxAge > MAX_AGE) options.maxAge = MAX_AGE;
                                delete options.expires; // prefer clamped maxAge over an arbitrary far-future expiry
                                if (c.clear) res.clearCookie(name, options);
                                else res.cookie(name, c.value, options);
                            }
                        }
                        res.status(r.status || 200);
                        if (r.body === undefined) res.end(); else res.json(r.body);
                    } catch (e: any) {
                        res.status(502).json({ error: 'Isolated plugin error', detail: String(e && e.message || e) });
                    }
                };
                const m = routeMethod; // validated against the HTTP-verb allowlist above
                // ALL plugins are namespaced under /api/v1/plugin/<slug> (no route hijack). No trust tier
                // exists to opt into an absolute path — every plugin's routes are confined to its namespace.
                const full = `/api/v1/plugin/${slug.replace('theme:', 'theme-')}${routePath}`;
                // Register WITHOUT the plugin's ALS context. appRegistry patches the app/Router route
                // methods to wrap EVERY handler registered while a plugin is the effective plugin, so an
                // IN-PROCESS plugin's own handler re-enters its sandbox on each request. But for an
                // ISOLATED plugin the handlers mounted here are ALL trusted HOST code: the auth middleware
                // (authenticate/isAdmin — which read the users DB) and finalHandler (which does the IPC to
                // the child). Wrapping them in the plugin context made authenticate's `User.findById` run
                // "as the plugin", get denied by the sandbox, and every { auth: true } isolated route 401'd
                // with "Invalid token." The real plugin code runs in the child process (OS-isolated) and
                // sets its own context there (plugin-worker.js), so the host middleware MUST run with host
                // privileges. Registering outside runWithContext leaves getEffectivePlugin() null here, so
                // appRegistry does not wrap this trusted host code. (No sandbox weakening: the child is
                // unchanged, and callApi() at bridge time still runs in-context for permission checks.)
                app[m](full, ...mw, finalHandler);
                // Keep the HANDLER, not just the verb: teardown matches on handler identity because
                // the verb is not reliably recoverable from the layer (see the teardown comment).
                registeredRoutes.push({ m, full, handler: finalHandler });
            } else if (msg.kind === 'route-reply') {
                rpcSettle(pendingRoute, msg, msg.response);
            } else if (msg.kind === 'register-shortcode') {
                if (registrationRejected(registeredShortcodes, MAX_SHORTCODES, 'shortcodes')) return;
                // Register a shortcode shim that forwards {attrs,content,tag} to the isolate and
                // resolves its HTML asynchronously (works with doShortcodeAsync).
                // Cap at 2s like hook callbacks: shortcodes run inside PUBLIC post reads, so without
                // this a hung worker held every reader of that post for the full 30s RPC timeout.
                // On timeout the tag renders as empty (same as an unknown shortcode) — never a hang.
                const shim = (attrs: any, content: any, tag: any) => {
                    let timer: any;
                    const capped = new Promise((resolve) => {
                        timer = setTimeout(() => resolve(''), 2000);
                        if (timer && timer.unref) timer.unref();
                    });
                    return Promise.race([invokeShortcode(msg.scId, { attrs, content, tag }), capped])
                        .finally(() => clearTimeout(timer));
                };
                registeredShortcodes.push(msg.tag);
                runWithContext(slug, () => addShortcode(msg.tag, shim));
            } else if (msg.kind === 'shortcode-reply') {
                rpcSettle(pendingShortcode, msg, msg.value);
            } else if (msg.kind === 'register-mail-provider') {
                // Becoming the host-wide mail sender is host-level hijack potential, so it requires an
                // explicit admin grant of the email:provider capability (Android-style, default-deny).
                if (isGrantedFor(slug, 'email', 'provider')) {
                    (global as any).wordjs_send_mail = (mailMsg: any) => invokeMail(mailMsg);
                    providedMail = true;
                } else {
                    console.warn(`[Isolate ${logSafe(slug)}] provideMail denied: the email:provider permission is not granted (grant it in /admin/plugins).`);
                }
            } else if (msg.kind === 'mail-reply') {
                rpcSettle(pendingMail, msg, msg.value);
            } else if (msg.kind === 'register-notify-transport') {
                // Registering a core notification transport can intercept dispatched notifications, so it
                // requires an explicit admin grant of the notifications:provider capability (default-deny).
                if (isGrantedFor(slug, 'notifications', 'provider')) {
                    try {
                        // Register IN the plugin's ALS context (like the shortcode registration above) so
                        // notifications.registerTransport records pluginSlug=<slug>. Without this it stored
                        // pluginSlug=null, so unregisterPluginTransports(slug) never matched it on unload and
                        // every later notify() RPC'd a DEAD worker and hung to the 30s timeout.
                        runWithContext(slug, () => require('./notifications').registerTransport(msg.name, (notification: any) => invokeNotifyTransport(msg.name, notification)));
                    } catch (e: any) { console.warn(`[Isolate ${logSafe(slug)}] notify transport register failed: ${logSafe(e && e.message)}`); }
                } else {
                    console.warn(`[Isolate ${logSafe(slug)}] notify.registerTransport denied: the notifications:provider permission is not granted (grant it in /admin/plugins).`);
                }
            } else if (msg.kind === 'notify-transport-reply') {
                rpcSettle(pendingTransport, msg, msg.value);
            }
          } catch (e: any) {
            console.error(`[Isolate ${logSafe(slug)}] dropped malformed/poison IPC message (kind=${logSafe(msg && msg.kind)}): ${logSafe(e && e.message)}`);
          }
        });

        // Remove every host-side registration this plugin made. Idempotent (safe to call twice)
        // so it can run both from unloadIsolatedPlugin and as a crash safety-net in 'exit'.
        const teardown = () => {
            // Routes: splice the plugin's layers out of the Express stack (Express 4 has no public
            // unmount API), so a request to its path no longer reaches a dead worker.
            try {
                const { getApp } = require('./appRegistry');
                const app = getApp();
                const stack = app && app._router && app._router.stack;
                if (Array.isArray(stack) && registeredRoutes.length) {
                    for (const { full, handler } of registeredRoutes) {
                        for (let i = stack.length - 1; i >= 0; i--) {
                            const r = stack[i] && stack[i].route;
                            // Match the HANDLER we mounted, never the registration verb. `app.all()`
                            // is implemented by looping the HTTP method list, so route.methods ends up
                            // with every concrete verb and NEVER a key named 'all' — keying the unmount
                            // on the verb silently left every `all` route mounted after the worker died.
                            // A request then reached a dead child, whose IPC send fails asynchronously,
                            // so it hung for the full 30s RPC timeout instead of 404ing. Handler identity
                            // is exact and immune to any future method aliasing.
                            if (r && r.path === full && Array.isArray(r.stack)
                                && r.stack.some((l: any) => l && l.handle === handler)) {
                                stack.splice(i, 1);
                            }
                        }
                    }
                }
            } catch { /* */ }
            for (const { hook, type, shim } of registeredHooks) {
                try { if (type === 'filter') hooks.removeFilter(hook, shim); else hooks.removeAction(hook, shim); } catch { /* */ }
            }
            // Unregister IN the plugin's context so the shortcodes owner-guard applies: a tag the plugin
            // tried to squat (refused at add time, but still tracked here) is owned by core/another plugin,
            // so removeShortcode safely skips it instead of deleting a victim's shortcode from host context.
            for (const tag of registeredShortcodes) { try { runWithContext(slug, () => removeShortcode(tag)); } catch { /* */ } }
            if (providedMail && (global as any).wordjs_send_mail) { try { delete (global as any).wordjs_send_mail; } catch { /* */ } }
            try { require('./notifications').unregisterPluginTransports(slug); } catch { /* */ }
            try { require('./adminMenu').unregisterAdminMenu(slug); } catch { /* */ }
        };

        /**
         * THE ONLY WAY THIS LOAD MAY FAIL. Every reject path goes through here.
         *
         * `isolates.set()` runs at the END of this executor — synchronously, before the child has said
         * anything — so by the time the child reports 'init-error'/'fatal', or errors, the isolate is
         * ALREADY registered and the child is ALREADY wiring hooks, routes, shortcodes and providers
         * into the host through the message handler above. Rejecting from those branches without
         * undoing any of it left a live, registered, hook-applying child for a plugin whose activation
         * had just returned 500 with `active_plugins` clean: nothing supervised it, deactivatePlugin
         * early-returned 'Plugin not active', and only DELETE could clear it. The child does not even
         * exit on its own — plugin-worker.js sends 'init-error' and keeps running.
         *
         * Wrapping the caller's `await` would only cover the callers that remembered to; the module that
         * OWNS the child is the one place that can guarantee it, so the guarantee lives here: after a
         * rejected loadIsolatedPlugin there is no registry entry, no host-side registration and no live
         * process for this slug. Idempotent (a second failure signal is a no-op) and never rejects.
         */
        const failLoad = (err: Error, opts: { alreadyExited?: boolean } = {}) => {
            if (settled) return;
            settled = true;
            // Is the slug currently owned by a DIFFERENT child (a reload that already replaced us)? If
            // so, only our own process may be touched: `teardown` splices route layers by path+method
            // and unregisters slug-wide transports/menus, and health is keyed by slug — all of which now
            // describe the new child. Same guard the 'exit' handler uses, for the same reason. Note that
            // "already absent" is NOT "owned by another": the exit handler deregisters before calling
            // in here, and that case must still clean up.
            const cur = isolates.get(slug);
            const ownedByAnother = !!(cur && cur.worker !== worker);
            if (readyTimer) { try { clearTimeout(readyTimer); } catch { /* */ } readyTimer = null; }
            if (rssPoll) { try { clearInterval(rssPoll); } catch { /* */ } rssPoll = null; }
            if (!ownedByAnother) {
                // A supervised restart armed for this slug must not resurrect what we are tearing down.
                const pendingRestart = restartTimers.get(slug);
                if (pendingRestart) { clearTimeout(pendingRestart); restartTimers.delete(slug); }
                if (cur) {
                    isolates.delete(slug);
                    try { teardown(); } catch (e: any) { console.error(`[Isolate ${logSafe(slug)}] teardown after a failed load: ${logSafe(e && e.message)}`); }
                }
            }
            if (!opts.alreadyExited) { try { worker.terminate(); } catch { /* already gone */ } }
            const h = getHealth(slug);
            if (!ownedByAnother) { h.state = 'stopped'; h.pid = null; }
            h.lastError = String((err && err.message) || err);
            reject(err);
        };

        // A child that never says ANYTHING is the one failure the message/exit/error handlers cannot see.
        // Arm the deadline here (the child exists from this point) and let failLoad clear it — .unref()
        // so this timer alone never holds the process open, which is what turned an orphaned timer into
        // a CI kill mid-IPC the last time (see the `--test-force-exit` flake).
        const readyTimeoutMs = Number.isFinite(opts.readyTimeoutMs as number) && (opts.readyTimeoutMs as number) >= 0
            ? (opts.readyTimeoutMs as number)
            : READY_TIMEOUT_MS;
        if (readyTimeoutMs > 0) {
            readyTimer = setTimeout(() => {
                readyTimer = null;
                console.error(`[Isolate ${logSafe(slug)}] load timed out: no 'ready' within ${logSafe(readyTimeoutMs)}ms (init() never returned) — failing the load.`);
                failLoad(new Error(`Isolated plugin '${slug}' did not become ready within ${readyTimeoutMs}ms`));
            }, readyTimeoutMs);
            if (readyTimer.unref) readyTimer.unref();
        }

        worker.on('error', (err: any) => { console.error(`[Isolate ${logSafe(slug)}] child error: ${logSafe(err && err.message)}`); failLoad(err instanceof Error ? err : new Error(String(err))); });
        worker.on('exit', (code: number) => {
            // Only act if WE are still the registered isolate — on reload a fresh child has already
            // replaced us, and tearing down here would rip out the new child's registrations.
            const cur = isolates.get(slug);
            const wasCurrent = cur && cur.worker === worker;
            if (wasCurrent) { isolates.delete(slug); try { teardown(); } catch { /* */ } }
            if (code !== 0) console.warn(`[Isolate ${logSafe(slug)}] child exited with code ${logSafe(code)}`);
            // CONSUME the intentional-stop mark here, BEFORE any early return, and remember the answer.
            //
            // `stopping` is written by unloadIsolatedPlugin and read by exactly one place — this handler —
            // so a mark that is not consumed here is never consumed at all. It used to be read below the
            // `!settled` early return, which is reachable: unloadIsolatedPlugin only needs a REGISTERED
            // isolate, and `isolates.set` runs at the end of this executor while the load stays unsettled
            // until the child sends 'ready'. An unload landing in that window (the DELETE route, the
            // activate backstop, a cross-node deactivate) therefore marked the slug, killed the child,
            // and returned through the failed-load branch — stranding the mark forever. The NEXT child
            // for that slug then had its very first crash classified as an intentional stop: no teardown
            // of the crash path, no supervised restart, no 'crashed' health state, silently.
            const wasIntentional = stopping.delete(slug);
            // child_process: a crash DURING init emits 'exit' (not 'error'); reject the load Promise so it
            // doesn't hang forever if the child died before sending 'ready' / 'init-error'. Routed through
            // failLoad so this path clears the same state as every other failure (alreadyExited: the
            // process is gone, so there is nothing left to terminate).
            if (!settled) {
                failLoad(new Error(`Isolated plugin '${slug}' exited during startup (code ${code})`), { alreadyExited: true });
                return;
            }

            // Settled = the child had been RUNNING, so this is a RUNTIME exit.
            const h = getHealth(slug);
            h.lastExitCode = code;
            if (wasIntentional) { h.state = 'stopped'; return; } // intentional unload/deactivate/reload
            if (!wasCurrent) return; // a newer child already replaced us (reload race) — not our crash to supervise
            h.state = 'crashed';
            console.warn(`[Isolate ${logSafe(slug)}] child crashed at runtime (code ${logSafe(code)}) — supervising.`);
            superviseRestart(slug, entryFile);
        });

        // Register the live handle + refresh per-child health telemetry.
        //
        // INVARIANT: THE MAP NEVER LOSES ITS REFERENCE TO A LIVE CHILD. One slug, one handle — so if a
        // handle is already here it is about to be overwritten, and an overwritten child is an ORPHAN:
        // absent from `isolates` and from `restartTimers`, invisible to listIsolates(), unreachable by
        // unloadIsolatedPlugin and by the theme sweep, yet running and still applying the hooks, filters
        // and shortcodes it registered. Retire it here, at the single line that can lose it, so the
        // invariant holds for every caller — including sequential loads (an activate for a slug that is
        // already loaded), which the join in loadIsolatedPlugin cannot see because they never overlap.
        //
        // Teardown-then-terminate, the same order unloadIsolatedPlugin uses, and NOT via `stopping`: that
        // mark is keyed by slug and consumed by whichever child exits first, so marking here could silence
        // the supervisor for the NEW child's first crash. The displaced child needs no mark — its exit
        // handler already sees a registry entry that is not its own and returns without supervising.
        // Safe against the incoming child's registrations: this executor is synchronous, so at this line
        // the new child has not sent a single message and `teardown()` can only remove the old one's.
        const displaced = isolates.get(slug);
        if (displaced && displaced.worker !== worker) {
            console.warn(`[Isolate ${logSafe(slug)}] a second load replaced a live child for this slug — retiring the displaced one so it cannot be orphaned.`);
            try { if (displaced.teardown) displaced.teardown(); } catch (e: any) { console.error(`[Isolate ${logSafe(slug)}] teardown of the displaced child: ${logSafe(e && e.message)}`); }
            try { displaced.worker.terminate(); } catch { /* already gone */ }
        }
        isolates.set(slug, { worker, teardown, entryFile });
        const h = getHealth(slug);
        // Report the pid of the process that IS the plugin. On the AppContainer path `child.pid` is the
        // PowerShell relay, and an operator reading the admin plugin list would otherwise be shown a pid
        // that Task Manager labels "powershell.exe" — and would find nothing when they went looking for
        // their plugin. This is the same pid the resident poll reads (see `pollPid`), so the health row
        // and the memory telemetry always describe the same process.
        h.state = 'running'; h.pid = containedPid || (child && child.pid) || null; h.startedAt = Date.now();
        // A clean MANUAL (re)start (activate / grants-reload / dev-reload / admin restart) resets the
        // crash accounting; a supervised auto-restart keeps counting toward the crash-loop cap.
        if (!opts.supervised) { h.crashWindow = []; h.restarts = 0; stopping.delete(slug); }
    });
}

// Returns void on the ordinary synchronous path, and a Promise only when it has to wait out an in-flight
// load (see below). The annotation is required: the function references itself in a return expression.
function unloadIsolatedPlugin(slug: string): void | Promise<void> {
    // A load for this slug is IN FLIGHT — its `isolates.set` has not landed yet. The synchronous body below
    // would therefore find no handle, do nothing, and leave a live child behind the moment that load
    // completes: the unload silently lost. awaitIsolateSettled is the documented primitive for "I intend to
    // retire what I enumerate", but only the theme sweep and reloadIsolatedPlugin were calling it — plain
    // deactivate (core/plugins.ts), cross-node deactivate and DELETE all unloaded same-tick. Enforcing it
    // HERE makes the contract hold for every caller instead of asking each one to remember it.
    // Deliberately NOT made async: five call sites invoke this synchronously inside try/catch, and turning
    // it into a promise there would let a rejection escape the catch that is meant to contain it. A promise
    // is returned only on this path, so `await`ing callers get the deferred work and the rest still end up
    // with the child retired.
    // NOT simply `loading.has(slug)`: `isolates.set` runs at the END of the executor while the load stays
    // unsettled until the child reports ready, so there is a window where the slug is REGISTERED and the
    // load is still pending. In THAT window the synchronous body is correct and load-bearing — it marks the
    // stop, kills the child, and the exit handler consumes the mark (see the 'unload that lands MID-LOAD'
    // test). Deferring there would be a regression. Only the no-handle-yet case is the silent no-op.
    if (!isolates.has(slug) && loading.has(slug)) {
        return awaitIsolateSettled(slug).then(() => {
            // Settled ⇒ recursing hits the sync path. If it never settled we would spin, so stop instead:
            // a load stuck past the timeout has bigger problems than a missed unload.
            if (loading.has(slug)) return;
            return unloadIsolatedPlugin(slug);
        });
    }
    // Cancel any pending backoff restart from an earlier crash. Unconditional: the whole point of the
    // no-handle case is that a crashed plugin has NO registered isolate while its restart timer is armed.
    const pending = restartTimers.get(slug);
    if (pending) { clearTimeout(pending); restartTimers.delete(slug); }
    const health = isolateHealth.get(slug);
    if (health) health.state = 'stopped';
    const h = isolates.get(slug);
    // Nothing registered ⇒ nothing to kill, and — crucially — no 'exit' is coming. `stopping` is
    // consumed by a child's exit handler, so marking a slug with no handle leaves an entry that is never
    // read and never removed: it accumulated on EVERY delete and on the activate backstop, and the next
    // child's exit would then be silently classified as an intentional stop instead of a crash to
    // supervise. Only mark the stop when there is actually a child whose exit will consume it.
    if (!h) return;
    // INTENTIONAL stop — so the exit handler doesn't mistake it for a crash and auto-restart it.
    stopping.add(slug);
    try { if (h.teardown) h.teardown(); } catch (e) { /* */ }
    try { h.worker.terminate(); } catch (e) { /* */ }
    isolates.delete(slug);
}

// Tear the plugin down and start it again, reusing the entry file from the original load. Used when a
// plugin's permission grants change so it re-registers its routes and re-evaluates host-capability
// gates (mail/notify providers, network) without a full server restart. No-op if not loaded.
async function reloadIsolatedPlugin(slug: string): Promise<any> {
    // A reload landing WHILE a load for the same slug is in flight would either join that load (and hand
    // back a child started under the OLD grants — the exact thing a grants-change reload exists to
    // replace) or read `isolates` before the load registers and no-op. Let the load settle first, then
    // reload what it produced.
    await awaitIsolateSettled(slug);
    const h = isolates.get(slug);
    if (!h || !h.entryFile) return null;
    const entryFile = h.entryFile;
    unloadIsolatedPlugin(slug);
    const result = await loadIsolatedPlugin(slug, entryFile);
    // The reloaded child re-registers its Express routes at the END of the app stack — AFTER the
    // notFound/errorHandler layers that boot appended — so every one of its routes would answer
    // rest_no_route 404. The activation path already fixes this ordering after loading; do the
    // same here (covers the grants-change reload, the admin reload endpoint, and dev hot-reload).
    try { require('./plugins').fixMiddlewareOrder(); } catch { /* ordering fix is best-effort */ }
    return result;
}

module.exports = {
    loadIsolatedPlugin, unloadIsolatedPlugin, reloadIsolatedPlugin,
    isIsolated: (slug: string) => isolates.has(slug),
    listIsolates,
    getLivePids, awaitIsolateStopped, awaitIsolateSettled,
    getIsolateStatus, getAllIsolateStatuses,
    assignProcessToJobObject, probeJobObjectCap, getSandboxHardeningState,
    getPermissionModelState, probePermissionModel, probeKernelHardening,
    // This platform's native kernel confinement layer (Landlock / AppContainer / Seatbelt / none).
    probePlatformConfinement, getSandboxPlatformState, getSandboxPlatformNetworkState,
    getSandboxPlatformConfinement, platformKernelMechanism,
    // Linux-specific diagnostic aliases.
    getLinuxZeroConfState, linuxFloorInForce,
    // Derived: TRUE only in the dangerous "the operator turned this layer ON and it is not there" state.
    // 'unsupported' (no such mechanism) and 'disabled' (not asked for) are chosen postures, not failures.
    isSandboxPlatformConfinementDegraded: () => sandboxPlatformState === 'degraded',
    // Derived admin-facing flag: TRUE only in the dangerous "looks secure but isn't" state.
    // 'unsupported' (non-Linux) and 'disabled' (opt-out) are known/chosen postures, not degradation.
    isSandboxHardeningDegraded: () => sandboxHardeningState === 'degraded',
    // The FALLBACK is the property most likely to break and the one that would hurt real users, so the
    // decision that produces it is exported as a pure function and pinned by
    // backend/src/tests/sandbox-platform-fallback.test.ts on every host, including the ones where these
    // layers can never be active.
    __platformLaunchDecision: platformLaunchDecision,
    __nativeSandboxRequired: nativeSandboxRequired,
    // The Linux floor choice, exported as a PURE function for the same reason and pinned by
    // backend/src/tests/sandbox-linux-zeroconf-wiring.test.ts on every host — including Windows and
    // macOS boxes, where neither Linux floor can ever exist and the fallback is therefore the ONLY
    // behaviour there is to assert. LINUX_FLOOR_LAYERS is exported WITH it because the test's
    // exhaustiveness gate reads it: a layer added to that list and to nothing else turns the suite RED
    // instead of quietly becoming a floor with no argv.
    __linuxFloorDecision: linuxFloorDecision,
    __linuxFloorLayers: LINUX_FLOOR_LAYERS,
    // Diagnostic: is this slug marked as an INTENTIONAL stop, i.e. is there a pending child exit that
    // must not be supervised as a crash? The mark is consumed by that exit, so a mark with no child
    // behind it is a leak — it never goes away and it silences the supervisor for the NEXT child.
    __stopIntentMarked: (slug: string) => stopping.has(slug),
    // Test seams for the IPC-frame containment guard (see the regression test): the classifier that
    // decides whether an uncaughtException is the child_process advanced-deserializer framing error, and
    // the ref-counted install/uninstall so a test can exercise the lifecycle without a real plugin.
    __isIpcFrameDeserializeError: isIpcFrameDeserializeError,
    __retainIpcFrameGuard: retainIpcFrameGuard,
    __releaseIpcFrameGuard: releaseIpcFrameGuard,
    __ipcFrameGuardActive: () => ipcGuardInstalled,
};
