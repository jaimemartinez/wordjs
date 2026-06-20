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
const { createPluginApi } = require('./plugin-api');
const { runWithContext } = require('./plugin-context');
const hooks = require('./hooks');
const { addShortcode, removeShortcode } = require('./shortcodes');

const WORKER_FILE = path.join(__dirname, 'plugin-worker.js');
const isolates = new Map<string, any>();

// (The former host-side memory watchdog is gone: with child_process each untrusted plugin runs in its
// OWN OS process, so off-heap growth is the CHILD's rss — bounded per-child in loadIsolatedPlugin —
// not the host's. A worker_thread shared the host rss and could OOM-crash it; a child cannot.)

// --- KERNEL-ENFORCED memory cap (RLIMIT_AS via `ulimit -v`) ---------------------------------------
// We prefer a KERNEL cap on the child's address space over a pure userspace poll: it holds even if the
// host event loop is wedged, it is the only cap on platforms without /proc (e.g. macOS), and it bounds
// off-heap (Buffer/ArrayBuffer) growth the V8 heap flag can't. The wrapper `sh -c 'ulimit -v N; exec
// node …'` preserves the fork-style IPC channel — the inherited NODE_CHANNEL_FD + its fd survive the
// shell's `exec`, so the exec'd node attaches IPC exactly as a forked child would. V8's pointer-
// compression cage reserves a large VIRTUAL range (~4 GB) that RLIMIT_AS counts, so the cap must be
// GENEROUS — it is a coarse virtual *backstop* (bounds pathological allocation; kernel-enforced even if
// the host loop is wedged; the only cap on /proc-less platforms), NOT a tight RSS cap. The precise
// resident cap stays the /proc poll below. We use a GENEROUS fixed ceiling (virtual space is cheap to
// reserve) validated by a probe that boots node with the REAL execArgv (so the cap reflects the actual
// child's footprint — cage + ts-node — not a bare `node` that under-counts it and false-kills loads).
// Result (cached Promise): null = unavailable (→ plain fork + /proc poll), number = RLIMIT_AS in KiB.
let osCapProbe: Promise<number | null> | undefined;
function probeOsMemoryCap(): Promise<number | null> {
    if (osCapProbe) return osCapProbe;
    osCapProbe = (async () => {
        if (process.platform === 'win32') return null; // no POSIX ulimit / RLIMIT_AS
        // RLIMIT_AS can only be a LOOSE virtual backstop, not a box-tight cap: V8 reserves a ~4 GB
        // pointer-compression cage, and the legit child footprint (in dev, ts-node's compiler + the full
        // core .ts compile) needs many GB of virtual space — a tighter ceiling crashes real plugin loads
        // (verified: a 6 GB cap killed ts-node children mid-load). So this bounds only PATHOLOGICAL
        // allocation; the PRECISE resident cap is the /proc RSS poll below (768 MB, 250 ms), and the
        // decisive PREVENTIVE resident cap for small-RAM boxes + Windows is a kernel cgroup MemoryMax /
        // Job Object (roadmap, see POSITIONING.md). Operators on a compiled (non-ts-node) prod build with
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
                const finish = (v: boolean) => { if (!done) { done = true; try { c && c.kill(); } catch { /* */ } res(v); } };
                try {
                    // Same `exec "$@"` wrapper the real load uses; $0 = label, $@ = [node, …execArgv, -e, src].
                    c = spawn('sh', ['-c', `ulimit -v ${kb} 2>/dev/null; exec "$@"`, 'wjs-probe', process.execPath, ...execArgv, '-e', probeSrc],
                        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', timeout: 20000 });
                } catch { return res(false); }
                c.on('message', (m: any) => { if (m === 'ok') got = true; });
                c.on('error', () => finish(false));
                c.on('exit', (code: number) => finish(got && code === 0));
            });
            if (ok) { console.log(`[Sandbox] kernel memory cap active: RLIMIT_AS ${mb} MB per isolated child.`); return kb; }
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
function probeCgroupCap(): Promise<boolean> {
    if (cgroupProbe) return cgroupProbe;
    cgroupProbe = (async () => {
        if (process.platform !== 'linux') return false;
        // OPT-IN: auto-detecting cgroup/systemd support across environments is unreliable — a host or CI
        // runner can have `systemd-run` yet no usable `--user` bus ("Failed to connect to bus"), so
        // auto-enabling it breaks those hosts. Require the operator to turn it on explicitly (on a
        // systemd Linux host they know supports user scopes); the probe below STILL validates it works
        // before activating, and any failure falls back to the fork + RLIMIT_AS + RSS-poll path.
        let enabled = false;
        try { const s = require('../config/app').sandbox; enabled = !!(s && s.useCgroupMemoryCap); } catch { /* default off */ }
        if (!enabled) return false;
        const budget = 768 * 1024 * 1024;
        const unit = `wjp-probe-${process.pid}.scope`;
        // The probe child boots, confirms IPC works through --scope's fd inheritance (sends "ok" and
        // stays alive), then we tear it down via the SAME path real teardown uses and require an exit —
        // so cgroup mode activates ONLY if spawn + IPC + clean kill all work on THIS host.
        const src = 'if(!process.send){process.exit(3)}process.send("ok");setInterval(function(){},1e9)';
        return await new Promise<boolean>((res) => {
            let proc: any, gotOk = false, done = false;
            const finish = (v: boolean) => { if (!done) { done = true; res(v); } };
            const overall = setTimeout(() => finish(false), 20000);
            if ((overall as any).unref) (overall as any).unref();
            try {
                proc = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--unit', unit,
                    '-p', `MemoryMax=${budget}`, '-p', 'MemorySwapMax=0', '--', process.execPath, '-e', src],
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
    })();
    return cgroupProbe;
}

// Trust = shipped default OR operator-toggled (admin UI). See core/plugin-trust.
function isTrustedPlugin(slug: string): boolean {
    try { return require('./plugin-trust').isTrusted(slug); } catch { return false; }
}

// Hooks whose filter return value is emitted as RAW, UNESCAPED HTML into every server-rendered page
// (theme-engine wraps wordjs_head/wordjs_footer in a Handlebars SafeString). An untrusted plugin
// shimming one of these is a stored-XSS primitive (incl. the admin UI), so it is denied for untrusted
// plugins — operator-trusted first-party plugins keep the capability.
const RAW_HTML_HOOKS = new Set(['wordjs_head', 'wordjs_footer', 'wp_head', 'wp_footer']);

// Host auth/session cookies that must never be forwarded to (or overwritten by) an untrusted isolated
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
    'db.all', 'db.get', 'db.run', 'db.createTable', 'db.getType',
    'hooks.doAction',
    'fs.read', 'fs.write',
    'mail', 'notify',
    'adminMenu.add', 'cron.schedule',
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

async function loadIsolatedPlugin(slug: string, entryFile: string): Promise<any> {
    // Resolve the memory-cap capabilities ONCE (cached) before building the child, so the spawn path is
    // chosen synchronously inside the executor below. cgroup (preventive) is preferred over rlimit (loose).
    const cgroupOk = await probeCgroupCap();
    const capKb = cgroupOk ? null : await probeOsMemoryCap();
    return new Promise((resolve, reject) => {
        // In dev we run via ts-node and the worker must too (core is .ts); compiled, no flag needed.
        // Pass ONLY the ts-node register flag — forwarding all of process.execArgv trips Worker's
        // execArgv allowlist.
        const execArgv = __filename.endsWith('.ts') ? ['-r', 'ts-node/register'] : [];
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
        // contained to the child and the host always survives. isTrusted is resolved HERE at spawn
        // (re-resolved on reload via the trust toggle) so the child's network policy matches current
        // trust; config travels in argv[2] (no secrets); env is the same secret-free allowlist.
        const childCfg = JSON.stringify({ slug, entryFile, coreDir: __dirname, isTrusted: isTrustedPlugin(slug) });
        const HEAP_FLAG = '--max-old-space-size=256'; // caps the JS HEAP; cgroup/rlimit/poll cap TOTAL memory
        const RSS_BUDGET_BYTES = 768 * 1024 * 1024;   // resident budget — cgroup memory.max AND the /proc poll
        // structured-clone IPC (serialization 'advanced') preserves Buffer/Date/Map; the JSON default
        // (and a raw JSON channel) would lose them — match the worker_threads postMessage fidelity.
        const IPC_STDIO: any = ['inherit', 'inherit', 'inherit', 'ipc']; // inherit stdio for plugin logs
        let child: any;
        let cgroupUnit: string | null = null;
        if (cgroupOk) {
            // PREVENTIVE cgroup v2 cap: run the child in a transient scope with MemoryMax — the kernel
            // OOM-kills it by construction at the resident budget (no poll race; blast radius = the child).
            // --scope runs node as a direct child of systemd-run, inheriting the IPC fd (probe-verified);
            // child.pid is systemd-run and the kernel is the cap, so the /proc poll is skipped below.
            cgroupUnit = `wjp-${slug.replace('theme:', 'theme-').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${process.pid}-${++cgroupSeq}.scope`;
            child = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--unit', cgroupUnit,
                '-p', `MemoryMax=${RSS_BUDGET_BYTES}`, '-p', 'MemorySwapMax=0', '--',
                process.execPath, ...execArgv, HEAP_FLAG, WORKER_FILE, childCfg],
                { stdio: IPC_STDIO, serialization: 'advanced', env: workerEnv });
        } else if (capKb) {
            // KERNEL-capped path: a shell sets RLIMIT_AS, then `exec`s node KEEPING the inherited IPC fd
            // (NODE_CHANNEL_FD + serialization mode are injected into the child env by the 'ipc' stdio and
            // survive the exec). argv after the shell name = [node, …execArgv, HEAP_FLAG, WORKER, cfg];
            // `exec "$@"` runs it, so cfg lands at process.argv[2] exactly like fork(WORKER,[cfg]).
            const nodeArgv = [process.execPath, ...execArgv, HEAP_FLAG, WORKER_FILE, childCfg];
            child = spawn('sh', ['-c', `ulimit -v ${capKb} 2>/dev/null; exec "$@"`, 'wjs-sandbox', ...nodeArgv], {
                stdio: IPC_STDIO,
                serialization: 'advanced',
                env: workerEnv,
            });
        } else {
            // No kernel cap available (Windows, or sh/rlimit absent): plain fork. Process separation still
            // protects the host; the /proc RSS poll below caps memory where available.
            child = fork(WORKER_FILE, [childCfg], {
                execArgv: [...execArgv, HEAP_FLAG],
                env: workerEnv,
                stdio: IPC_STDIO,
                serialization: 'advanced',
            });
        }
        // Worker-like adapter so the rest of this module stays transport-agnostic (postMessage/on/terminate).
        const worker: any = {
            postMessage: (m: any) => { try { child.send(m); } catch { /* child gone */ } },
            terminate: () => {
                try { child.kill('SIGKILL'); } catch { /* already gone */ }
                // cgroup mode: child.pid is systemd-run; also kill the SCOPE so the node grandchild can't
                // outlive it (scopes are manager-tracked, not tied to systemd-run's lifetime).
                if (cgroupUnit) { try { spawn('systemctl', ['--user', 'kill', '--signal=SIGKILL', cgroupUnit], { stdio: 'ignore' }); } catch { /* */ } }
            },
            on: child.on.bind(child),
            _child: child,
        };
        let settled = false; // load Promise settled (ready / init-error / early exit)
        // Reactive per-child RSS poll — the FALLBACK resident cap when the preventive cgroup cap isn't
        // available (Windows, macOS, non-systemd). Runs on the HOST loop reading the child's OWN rss, so
        // it's immune to the child blocking its own loop; covers Linux /proc, Windows tasklist, macOS ps.
        // Skipped in cgroup mode (the kernel memory.max IS the cap, and child.pid there is systemd-run,
        // not the node child). RSS_BUDGET_BYTES is defined above (shared with cgroup memory.max).
        let rssPoll: any = null;
        const killOverBudget = (rssBytes: number) => {
            if (rssBytes > RSS_BUDGET_BYTES) {
                console.error(`[Isolate ${slug}] killed: child rss over budget (${rssBytes} bytes).`);
                try { child.kill('SIGKILL'); } catch { /* gone */ }
            }
        };
        if (!cgroupOk && process.platform === 'linux' && child.pid) {
            // Cheapest path: synchronous /proc read on the host loop (field 2 = resident pages).
            const fsmod = require('fs');
            const statmPath = `/proc/${child.pid}/statm`;
            rssPoll = setInterval(() => {
                try {
                    const rssPages = parseInt(String(fsmod.readFileSync(statmPath, 'utf8')).split(' ')[1], 10) || 0;
                    killOverBudget(rssPages * 4096);
                } catch { /* child gone / statm unavailable */ }
            }, 250);
            if (rssPoll.unref) rssPoll.unref();
        } else if ((process.platform === 'win32' || process.platform === 'darwin') && child.pid) {
            // No /proc: ask the OS for the child's rss on the HOST loop (tasklist on Windows, ps on
            // macOS). Heavier (spawns a query), so poll less often and never overlap queries. Best-effort
            // — an unparsed result just skips that tick (falls back to process separation), never throws.
            let busy = false;
            rssPoll = setInterval(() => {
                if (busy || !child.pid) return;
                busy = true;
                let proc: any;
                try {
                    proc = (process.platform === 'win32')
                        ? spawn('tasklist', ['/FI', `PID eq ${child.pid}`, '/NH', '/FO', 'CSV'], { windowsHide: true })
                        : spawn('ps', ['-o', 'rss=', '-p', String(child.pid)]);
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
            }, 1000);
            if (rssPoll.unref) rssPoll.unref();
        }
        child.on('exit', () => { if (rssPoll) clearInterval(rssPoll); });
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
                console.error(`[Isolate ${slug}] terminated: registration flood (${registrationAttempts} attempts).`);
                try { worker.terminate(); } catch { /* already gone */ }
                return true;
            }
            if (arr.length >= max) {
                if (!registrationCapWarned) {
                    registrationCapWarned = true;
                    console.warn(`[Isolate ${slug}] registration cap reached (${kind} >= ${max}); ignoring further registrations (possible DoS).`);
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
                    console.error(`[Isolate ${slug}] terminated: RPC timeout (wedged handler).`);
                    try { worker.terminate(); } catch { /* already gone */ }
                }
            }, RPC_TIMEOUT_MS);
            if ((timer as any).unref) (timer as any).unref();
            map.set(id, { res, rej, timer });
            worker.postMessage({ id, ...message });
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
                console.error(`[Isolate ${slug}] terminated: oversized RPC reply.`);
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
        const registeredRoutes: Array<{ m: string; full: string }> = [];            // mounted Express routes
        const registeredHooks: Array<{ hook: string; type: string; shim: Function }> = []; // hook/filter shims
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
                console.error(`[Isolate ${slug}] terminated: IPC message-rate flood (${msgWindowCount} in ${MSG_WINDOW_MS}ms).`);
                try { worker.terminate(); } catch { /* already gone */ }
                return;
            }
            if (msg.kind === 'ready') {
                settled = true;
                resolve({ worker, slug });
            } else if (msg.kind === 'init-error') {
                settled = true;
                reject(new Error(msg.error));
            } else if (msg.kind === 'call') {
                // The isolate invoked a wordjs.* method — run it here, in the plugin's context.
                if (inflightCalls >= MAX_INFLIGHT_CALLS) {
                    // Over-limit calls are cheap-rejected, but a worker that floods far faster than the
                    // host can drain (thousands of calls while pinned at the limit) is hammering the
                    // event loop — terminate it as abusive (DoS containment, like registrationRejected).
                    if (++callBackpressureRejections > 50000) {
                        console.error(`[Isolate ${slug}] terminated: bridge-call flood (${callBackpressureRejections} over-limit calls).`);
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
                        console.error(`[Isolate ${slug}] terminated: bridge-call flood (sustained rate).`);
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
                // (#3) Untrusted plugins may not shim raw-HTML output hooks (stored-XSS into every SSR
                // page, incl. admin). Trusted first-party plugins keep the capability.
                if (!isTrustedPlugin(slug) && RAW_HTML_HOOKS.has(msg.hook)) {
                    console.warn(`[Isolate ${slug}] denied: untrusted plugin may not shim raw-HTML hook '${msg.hook}' (XSS risk).`);
                    return;
                }
                // Cap callbacks PER hook NAME too: many shims on one core hook (e.g. the_content)
                // amplify per-request latency even with the per-shim timeout below.
                const hookCnt = (hookNameCounts.get(msg.hook) || 0) + 1;
                hookNameCounts.set(msg.hook, hookCnt);
                if (hookCnt > MAX_PER_HOOK) {
                    console.warn(`[Isolate ${slug}] too many callbacks on hook '${msg.hook}' (cap ${MAX_PER_HOOK}) — ignoring further.`);
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
                    console.warn(`[Isolate ${slug}] rejected route registration with invalid method '${routeMethod}'.`);
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
                    } catch (e: any) { console.warn(`[Isolate ${slug}] multipart unavailable:`, e && e.message); }
                }
                const cookieNs = `wjp_${slug.replace('theme:', 'theme-').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}_`;
                const finalHandler = async (req: any, res: any) => {
                    // (#2) Never hand the host's HttpOnly auth JWT (wordjs_token) to an UNTRUSTED plugin's
                    // handler — the authenticated identity is already provided via reqData.user, so the raw
                    // token is not needed. Strip auth/session cookies before forwarding; trusted (first-
                    // party) plugins get the full jar.
                    const trusted = isTrustedPlugin(slug);
                    const fwdCookies = trusted
                        ? (req.cookies || {})
                        : Object.fromEntries(Object.entries(req.cookies || {}).filter(([k]) => !HOST_AUTH_COOKIE_RE.test(k)));
                    const reqData = {
                        method: req.method, path: req.path, query: req.query, params: req.params, body: req.body,
                        cookies: fwdCookies,
                        headers: { 'x-portal-token': req.headers['x-portal-token'] }, // selected non-sensitive headers
                        // Saved-upload metadata (multer) — the isolate gets the path/name, not the stream.
                        file: req.file ? { path: req.file.path, originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size, filename: req.file.filename } : undefined,
                        user: req.user ? { id: req.user.id, role: req.user.role, userEmail: req.user.userEmail, userLogin: req.user.userLogin } : null
                    };
                    try {
                        const r = await invokeRoute(msg.routeId, reqData);
                        if (r.headers) {
                            if (trusted) res.set(r.headers);
                            else {
                                // (#3) An untrusted plugin must not set response headers verbatim: Set-Cookie
                                // would re-inject a host cookie (e.g. wordjs_token), bypassing the clamped
                                // r.cookies path below, and CSP/HSTS/Location let it weaken host security or
                                // open-redirect. Drop those; cookies must flow through the clamped path.
                                const UNSAFE = new Set(['set-cookie', 'set-cookie2', 'content-security-policy', 'strict-transport-security', 'location']);
                                const safe: any = {};
                                for (const [k, v] of Object.entries(r.headers)) { if (!UNSAFE.has(String(k).toLowerCase())) safe[k] = v; }
                                res.set(safe);
                            }
                        }
                        // Replay cookies the isolate set/cleared on the real response.
                        if (Array.isArray(r.cookies)) {
                            for (const c of r.cookies.slice(0, 20)) { // (#5) cap cookies per reply
                                let name = String(c.name || '');
                                let options = c.options || {};
                                if (!trusted) {
                                    // (#5) Untrusted plugins may set cookies ONLY in their own namespace and
                                    // scope: never overwrite a host cookie (wordjs_token/session), never widen
                                    // scope via `domain`, and never escape their route path; clamp lifetime.
                                    if (HOST_AUTH_COOKIE_RE.test(name)) { console.warn(`[Isolate ${slug}] dropped cookie '${name}' (would shadow a host cookie).`); continue; }
                                    if (!name.startsWith(cookieNs)) name = cookieNs + name;
                                    options = { ...options };
                                    delete options.domain;
                                    options.path = `/api/v1/plugin/${slug.replace('theme:', 'theme-')}`;
                                    const MAX_AGE = 7 * 24 * 3600 * 1000;
                                    if (typeof options.maxAge === 'number' && options.maxAge > MAX_AGE) options.maxAge = MAX_AGE;
                                    delete options.expires; // prefer clamped maxAge over an arbitrary far-future expiry
                                }
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
                // Untrusted plugins are namespaced under /api/v1/plugin/<slug> (no route hijack).
                // Operator-trusted plugins may opt into their ORIGINAL absolute path (opts.absolute)
                // so a first-party plugin can isolate without rewriting its whole frontend's URLs.
                const full = (msg.opts && msg.opts.absolute && isTrustedPlugin(slug))
                    ? msg.routePath
                    : `/api/v1/plugin/${slug.replace('theme:', 'theme-')}${msg.routePath}`;
                runWithContext(slug, () => app[m](full, ...mw, finalHandler));
                registeredRoutes.push({ m, full });
            } else if (msg.kind === 'route-reply') {
                rpcSettle(pendingRoute, msg, msg.response);
            } else if (msg.kind === 'register-shortcode') {
                if (registrationRejected(registeredShortcodes, MAX_SHORTCODES, 'shortcodes')) return;
                // Register a shortcode shim that forwards {attrs,content,tag} to the isolate and
                // resolves its HTML asynchronously (works with doShortcodeAsync).
                const shim = (attrs: any, content: any, tag: any) =>
                    invokeShortcode(msg.scId, { attrs, content, tag });
                registeredShortcodes.push(msg.tag);
                runWithContext(slug, () => addShortcode(msg.tag, shim));
            } else if (msg.kind === 'shortcode-reply') {
                rpcSettle(pendingShortcode, msg, msg.value);
            } else if (msg.kind === 'register-mail-provider') {
                // Becoming the host-wide mail sender is host-level hijack potential, so it is
                // restricted to operator-trusted plugins (config.trustedSystemPlugins) — an untrusted
                // uploaded plugin cannot intercept everyone's outbound mail.
                if (isTrustedPlugin(slug)) {
                    (global as any).wordjs_send_mail = (mailMsg: any) => invokeMail(mailMsg);
                    providedMail = true;
                } else {
                    console.warn(`[Isolate ${slug}] provideMail denied: only operator-trusted plugins may register the host mail sender.`);
                }
            } else if (msg.kind === 'mail-reply') {
                rpcSettle(pendingMail, msg, msg.value);
            } else if (msg.kind === 'register-notify-transport') {
                // Registering a core notification transport can intercept dispatched notifications,
                // so it is likewise restricted to operator-trusted plugins.
                if (isTrustedPlugin(slug)) {
                    try {
                        require('./notifications').registerTransport(msg.name, (notification: any) => invokeNotifyTransport(msg.name, notification));
                    } catch (e: any) { console.warn(`[Isolate ${slug}] notify transport register failed:`, e && e.message); }
                } else {
                    console.warn(`[Isolate ${slug}] notify.registerTransport denied: only operator-trusted plugins may register a notification transport.`);
                }
            } else if (msg.kind === 'notify-transport-reply') {
                rpcSettle(pendingTransport, msg, msg.value);
            }
          } catch (e: any) {
            console.error(`[Isolate ${slug}] dropped malformed/poison IPC message (kind=${msg && msg.kind}):`, e && e.message);
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
                    for (const { m, full } of registeredRoutes) {
                        for (let i = stack.length - 1; i >= 0; i--) {
                            const r = stack[i] && stack[i].route;
                            if (r && r.path === full && r.methods && r.methods[m]) stack.splice(i, 1);
                        }
                    }
                }
            } catch { /* */ }
            for (const { hook, type, shim } of registeredHooks) {
                try { type === 'filter' ? hooks.removeFilter(hook, shim) : hooks.removeAction(hook, shim); } catch { /* */ }
            }
            for (const tag of registeredShortcodes) { try { removeShortcode(tag); } catch { /* */ } }
            if (providedMail && (global as any).wordjs_send_mail) { try { delete (global as any).wordjs_send_mail; } catch { /* */ } }
            try { require('./notifications').unregisterPluginTransports(slug); } catch { /* */ }
            try { require('./adminMenu').unregisterAdminMenu(slug); } catch { /* */ }
        };

        worker.on('error', (err: any) => { console.error(`[Isolate ${slug}] child error:`, err && err.message); if (!settled) { settled = true; reject(err); } });
        worker.on('exit', (code: number) => {
            // Only act if WE are still the registered isolate — on reload a fresh child has already
            // replaced us, and tearing down here would rip out the new child's registrations.
            const cur = isolates.get(slug);
            if (cur && cur.worker === worker) { isolates.delete(slug); try { teardown(); } catch { /* */ } }
            if (code !== 0) console.warn(`[Isolate ${slug}] child exited with code ${code}`);
            // child_process: a crash DURING init emits 'exit' (not 'error'); reject the load Promise so it
            // doesn't hang forever if the child died before sending 'ready' / 'init-error'.
            if (!settled) { settled = true; reject(new Error(`Isolated plugin '${slug}' exited during startup (code ${code})`)); }
        });

        isolates.set(slug, { worker, teardown, entryFile });
    });
}

function unloadIsolatedPlugin(slug: string) {
    const h = isolates.get(slug);
    if (h) {
        try { h.teardown && h.teardown(); } catch (e) { /* */ }
        try { h.worker.terminate(); } catch (e) { /* */ }
        isolates.delete(slug);
    }
}

// Tear the plugin down and start it again, reusing the entry file from the original load. Used by
// the trust toggle so a now-trusted/untrusted plugin re-registers its routes (namespaced ↔ absolute)
// and re-evaluates host-capability gates without a full server restart. No-op if not loaded.
async function reloadIsolatedPlugin(slug: string): Promise<any> {
    const h = isolates.get(slug);
    if (!h || !h.entryFile) return null;
    const entryFile = h.entryFile;
    unloadIsolatedPlugin(slug);
    return loadIsolatedPlugin(slug, entryFile);
}

module.exports = { loadIsolatedPlugin, unloadIsolatedPlugin, reloadIsolatedPlugin, isIsolated: (slug: string) => isolates.has(slug) };
