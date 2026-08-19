/**
 * WordJS - macOS kernel confinement for the isolated plugin child (Seatbelt / `sandbox-exec`)
 *
 * THE GAP THIS CLOSES. Everything in core/plugin-isolate.ts that confines a plugin at the KERNEL level is
 * Linux-only: bubblewrap, seccomp-bpf, user/pid/ipc/uts namespaces, `--unshare-net`, uid drop, cgroup v2
 * caps. On macOS an isolated plugin got OS process separation, Node's own C++-enforced permission model
 * and the JS guard layer (io-guard / secure-require / egress-guard) — and NOTHING below JavaScript from
 * the OS itself. Any bypass of a JS guard was therefore the whole user account, and outbound traffic was
 * governed by the in-process egress guard alone.
 *
 * Seatbelt is the macOS peer of that Linux layer. It ships with every macOS (`/usr/bin/sandbox-exec`,
 * kernel-enforced by the Sandbox kext through the MAC framework) and it is the same mechanism Chrome and
 * Firefox use to confine their own renderer processes. It is applied to the process BEFORE `execve`, so
 * like bwrap it needs no privilege, no native dependency and no cooperation from the confined code.
 *
 * WHAT MAPS ONTO WHAT
 *   bwrap `--ro-bind / /` + writable binds   →  `(deny default)` + `(allow file-read* …)` +
 *                                               `(allow file-write* (subpath <zone>))` for the io-guard zones only
 *   bwrap `--unshare-net` (non-network plugin) →  `(deny network*)`
 *   seccomp denylist (mount/ptrace/kexec/…)   →  `(deny default)` covers every Seatbelt-mediated operation
 *                                               class by construction (allowlist, not denylist — strictly
 *                                               stronger in kind, though it mediates fewer syscalls)
 *   bwrap `--uid 65534` / dropped caps        →  no analogue; Seatbelt confines the process, it does not
 *                                               change its uid. Stated here so nobody reads this module as
 *                                               claiming parity it does not have.
 *
 * THE DISCIPLINE OF plugin-isolate.ts APPLIES UNCHANGED: nothing here is assumed from `process.platform`
 * or from `sandbox-exec` merely existing. probeSeatbelt() spawns a REAL child under the REAL profile and
 * reports 'active' ONLY when that child is ACTUALLY refused something it must be refused — with a POSITIVE
 * CONTROL (a granted write that must SUCCEED) so a profile so broken that everything fails can never be
 * mistaken for confinement. Anything short of that degrades to today's behaviour. Reporting confinement
 * that is not there is the "looks secure but isn't" state, which is worse than reporting none.
 *
 * STATUS — UNCERTIFIED. This module was written on a Windows host. The SBPL text below has never been
 * parsed by a real Sandbox kext, and no child has ever been launched through it. That is exactly why it is
 * OPT-IN (`config.sandbox.useSeatbelt`, default OFF, mirroring `useCgroupMemoryCap`, which is opt-in for
 * the same reason: the layer's behaviour varies by host and a wrong guess must never break plugin loading)
 * and why the probe is written to fail closed on every uncertainty. Once probeSeatbelt() reports 'active'
 * on real macOS hardware AND real plugins load under it, flipping the default to ON is a one-line change —
 * but that flip must follow a MEASUREMENT, not this comment.
 *
 * This module is PURE where it can be: buildSeatbeltProfile() and seatbeltArgs() touch nothing but their
 * arguments (the single exception, a realpath of the Node binary, is documented at its call site), so the
 * parts that can be tested off-macOS are tested off-macOS — see backend/src/tests/sandbox-macos-profile.test.ts.
 */

const fsm = require('fs');
const pathm = require('path');
const { spawn } = require('child_process');

/**
 * The Seatbelt front-end. An absolute literal, never resolved through PATH: this argv is a security
 * boundary, and a PATH-resolved `sandbox-exec` is a PATH-hijack away from being a no-op wrapper that
 * silently execs the child unconfined. The probe additionally requires the file to EXIST before it will
 * report anything other than 'unsupported'.
 */
const SEATBELT_BIN = '/usr/bin/sandbox-exec';

/**
 * Render a path as an SBPL string literal, or return null when the path cannot be rendered SAFELY.
 *
 * SBPL is a Lisp-like TEXT format evaluated by the Sandbox framework's TinyScheme interpreter, and this
 * profile is assembled by STRING CONCATENATION around caller-supplied paths. That makes an unescaped path
 * an INJECTION VECTOR with the same shape as SQL injection, and a worse payoff: a directory literally
 * named
 *      /srv/app/x") (allow default) (subpath "/
 * closes our string, appends `(allow default)` — which, because SBPL resolves each operation to its LAST
 * matching rule, overrides the `(deny default)` at the top — and reopens a string so the rest still parses.
 * The result is a profile that LOOKS like confinement, is accepted by the kernel, and confines nothing.
 * Directory names are attacker-influenced in this codebase (a plugin slug becomes `plugins/<slug>`), so
 * this is not hypothetical.
 *
 * REJECT, not escape, for everything whose escape semantics this module cannot VERIFY:
 *   · a double quote. Escaping it as `\"` is the textbook answer and it is almost certainly what the
 *     Sandbox framework's TinyScheme reader does — but "almost certainly" is a claim about a parser this
 *     module has never run (see the UNCERTIFIED note in the file header), and if that guess is wrong the
 *     escape does not neutralise the payload above, it merely disguises it. A quote is never legitimate
 *     in one of io-guard's write zones, so the uncertainty is simply deleted instead of reasoned about.
 *   · control characters (NUL, newline, CR, tab, DEL). A newline inside an SBPL literal has no documented
 *     behaviour, and `;` starts a comment that a newline ENDS — so a value carrying one could change the
 *     meaning of the text that FOLLOWS it even if the literal itself held.
 *   · relative paths. Seatbelt matches RESOLVED absolute paths; a relative one would silently never
 *     match, i.e. it would quietly grant nothing while reading as if it granted something.
 *   · `/` itself. `(subpath "/")` is the whole filesystem — a write zone of `/` is never legitimate and
 *     would turn a typo into a total loss of confinement.
 *
 * A backslash IS escaped (doubled) rather than rejected, and the asymmetry is deliberate: a backslash is a
 * legal, occasionally legitimate character in a macOS filename, and — unlike a quote — it cannot terminate
 * a string literal in ANY Lisp reader. The worst case if the doubling is wrong is that the reader folds it
 * into some other character and the resulting path matches nothing, i.e. the grant is LOST. That failure
 * is more restrictive, which is the only direction this function is allowed to be wrong in.
 *
 * REJECT means the caller's zone is DROPPED from the profile — the failure direction is MORE restrictive,
 * never less. A dropped zone surfaces as a plugin write failing loudly; an injected zone surfaces as
 * nothing at all, which is the outcome this function exists to make impossible.
 */
function sbplPath(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    // Strip a single trailing separator: Seatbelt's `subpath` wants the directory without it, and
    // "/srv/app/uploads/" would not match "/srv/app/uploads/x".
    let p = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (p.length === 0) return null;
    if (p === '/') return null;                        // never the whole filesystem (see the reject list above)
    if (!p.startsWith('/')) return null;               // Seatbelt matches absolute, already-resolved paths
    if (p.includes('"')) return null;                  // the string terminator itself — REJECTED, never escaped (see above)
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(p)) return null;  // control characters: reject, never escape-and-hope
    p = p.replace(/\\/g, '\\\\');                      // legal in a macOS filename, and it can never terminate a literal
    return `"${p}"`;
}

/** De-duplicate while preserving order — a repeated `(subpath …)` is harmless but makes the profile lie about its own size. */
function uniq(list: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of list) { if (!seen.has(v)) { seen.add(v); out.push(v); } }
    return out;
}

export type SeatbeltProfileOptions = {
    /**
     * The zones the child may WRITE. These are io-guard's write zones — the caller passes the SAME array
     * plugin-isolate.ts already builds for bwrap's writable binds and for `--allow-fs-write` (the plugin's
     * own dir + uploads/data/logs/os-tmp/themes). They are deliberately NOT restated here: two independent
     * lists of "what a plugin may write" drift, and the drift is silent. One declaration, three consumers.
     */
    writableDirs?: string[];
    /**
     * True for a plugin WITHOUT the admin `network` grant — the `--unshare-net` analogue. False for a
     * network-granted plugin, whose egress stays bounded by the in-process egress guard exactly as today.
     */
    denyNetwork?: boolean;
    /** The application root. Read-only to the child except for the writable zones above. */
    appRoot: string;
    /**
     * The Node binary the child will exec. Defaults to this process's. Seatbelt matches the RESOLVED path,
     * so a symlinked install (Homebrew's /usr/local/bin/node → …/Cellar/node/…/bin/node) needs the target,
     * not the link — resolved below.
     */
    nodePath?: string;
};

/**
 * Build the SBPL profile for one isolated plugin child.
 *
 * EVERY allowance below carries the reason it exists. That is not documentation etiquette: an allowance
 * nobody can justify is precisely the hole the next audit finds, and in an allowlist sandbox the only
 * thing standing between "confined" and "theatre" is whether each `(allow …)` was earned.
 *
 * SBPL EVALUATION ORDER — the LAST matching rule wins. `(deny default)` therefore has to come first, and a
 * narrowing `(deny …)` has to come BEFORE the `(allow …)` that carves an exception out of it, not after.
 * Getting this backwards produces a profile that reads correctly and enforces the opposite.
 */
function buildSeatbeltProfile(opts: SeatbeltProfileOptions): string {
    const appRoot = sbplPath(opts && opts.appRoot);
    const denyNetwork = !!(opts && opts.denyNetwork);
    const rawNode = (opts && opts.nodePath) || process.execPath;
    // The one impurity in this function, and it is a READ of a path the caller already trusts enough to
    // execute. Seatbelt matches resolved paths, so a symlinked node would otherwise fail `process-exec`
    // and the child would never boot. Both spellings are emitted: the realpath is what the kernel checks,
    // the original is kept because a future macOS that checks the pre-resolution path must not break us.
    // try/catch because a non-existent path (unit tests pass a synthetic one) must not throw out of a
    // profile builder — it just means there is no second spelling to add.
    let realNode: string | null;
    try { realNode = fsm.realpathSync(rawNode); } catch { realNode = null; }
    const nodeLiterals = uniq([rawNode, realNode || ''].filter(Boolean).map((p: string) => sbplPath(p)).filter(Boolean) as string[]);

    const writable = uniq((Array.isArray(opts && opts.writableDirs) ? (opts.writableDirs as string[]) : [])
        .map((d) => sbplPath(d))
        .filter((s): s is string => s !== null));
    const droppedWritable = (Array.isArray(opts && opts.writableDirs) ? (opts.writableDirs as string[]).length : 0) - writable.length;

    const L: string[] = [];
    L.push('(version 1)');
    L.push(';; WordJS isolated plugin child. Generated by backend/src/core/sandbox-macos.ts -- do not hand-edit.');
    L.push(';; Evaluation order: the LAST matching rule wins, so (deny default) must stay first.');
    L.push('(deny default)');
    L.push('');

    // ── Metadata reads, unrestricted ────────────────────────────────────────────────────────────────
    // WHY: Node resolves the main module's REALPATH at startup, which lstat()s every ancestor directory up
    // to `/`, and require()'s stat cache lstat()s each candidate path it probes. Under a bare (deny default)
    // those lstats are refused and the child dies before it reaches JavaScript — the exact failure the
    // Windows AppContainer work measured as `EPERM: operation not permitted, lstat 'C:\'`. Granting
    // metadata (existence, size, mode, mtime) and NOT content is the same trade Chrome's own macOS profiles
    // make; it discloses filesystem SHAPE, never file CONTENT, and content stays governed by the
    // file-read* rules below.
    L.push(';; --- metadata-only reads (existence/stat), everywhere ---');
    L.push(';; Node lstats every ancestor of its main module (realpath resolution) and every require()');
    L.push(';; candidate. Denying this kills the child before JS runs. Discloses shape, never content.');
    L.push('(allow file-read-metadata)');
    L.push('');

    // ── Runtime + dynamic linker ────────────────────────────────────────────────────────────────────
    // WHY: dyld maps libSystem/CoreFoundation out of the shared cache before main() runs; without these the
    // process never starts and the probe could only ever report 'degraded'. These trees are read-only OS
    // content, world-readable on every macOS install, and carry no user or application data — denying them
    // buys nothing and costs the runtime.
    L.push(';; --- boot: dynamic linker + OS runtime (read-only, world-readable OS content) ---');
    L.push('(allow file-read* (subpath "/usr/lib"))          ;; libSystem and friends: dyld needs them pre-main()');
    L.push('(allow file-read* (subpath "/usr/share"))        ;; zoneinfo (TZ), locale tables read at boot');
    L.push('(allow file-read* (subpath "/System/Library"))   ;; CoreFoundation + the frameworks it pulls in');
    L.push('(allow file-read* (subpath "/private/var/db/dyld")) ;; the dyld shared cache itself');
    L.push('(allow file-read* (subpath "/private/var/db/timezone")) ;; TZ resolution (/etc/localtime target)');
    // WHY a SEPARATE operation: on modern macOS, mapping a page as executable is gated by
    // `file-map-executable`, NOT by `file-read*`. Without it dyld cannot map libSystem and the child dies
    // before main() — a failure that would look like "Seatbelt is broken here" rather than "one operation
    // is missing". Granted for the OS runtime and the Node binary ONLY.
    //
    // NOT granted for the writable zones, and that omission is the point: a plugin's own directory is
    // writable, so granting file-map-executable there would let it write a dylib and then map it — a
    // straight W^X escape that hands the plugin arbitrary native code inside the sandbox, defeating both
    // the AST scanner and secure-require's ban on planted code. Read the zone, never map it executable.
    L.push(';; Mapping executable pages is a SEPARATE operation from reading. Required for dyld; granted for');
    L.push(';; the OS runtime and the Node binary only -- NEVER for a writable zone (that would be W^X).');
    L.push('(allow file-map-executable (subpath "/usr/lib") (subpath "/System/Library") (subpath "/private/var/db/dyld"))');
    L.push('');

    // ── Device nodes ────────────────────────────────────────────────────────────────────────────────
    // WHY: /dev/urandom + /dev/random back crypto.randomBytes and V8's PRNG seeding; /dev/null is where a
    // closed stdio stream is pointed; /dev/dtracehelper is opened and ioctl'd by dyld during image loading
    // on several macOS builds and a denial there aborts the launch. Nothing else in /dev is granted — no
    // tty, no disks, no /dev/mem.
    L.push(';; --- device nodes actually required to boot ---');
    L.push('(allow file-read* (literal "/dev/urandom") (literal "/dev/random")) ;; crypto.randomBytes + V8 seeding');
    L.push('(allow file-read* file-write* (literal "/dev/null"))                ;; the sink for closed stdio');
    L.push('(allow file-read* file-write* file-ioctl (literal "/dev/dtracehelper")) ;; dyld opens+ioctls it while loading images');
    L.push('');

    // ── The application ─────────────────────────────────────────────────────────────────────────────
    // WHY read: the child must load plugin-worker.js, core/, node_modules and the plugin's own code.
    // WHY read-only: core src/, node_modules and SIBLING plugins stay unwritable at the KERNEL level, so a
    // plugin that defeats the JS io-guard still cannot persist a payload into core source, a shared
    // dependency, or another plugin — the same property the Linux --ro-bind gives.
    if (appRoot) {
        L.push(';; --- application root: READ-ONLY (worker, core, node_modules, the plugin\'s own code) ---');
        L.push(`(allow file-read* (subpath ${appRoot}))`);
        L.push('');
    } else {
        // No usable app root ⇒ the child cannot load its worker at all. Emitting nothing (rather than
        // widening) keeps the profile honest: the probe will fail its positive control and report
        // 'degraded', which is the correct, safe outcome for a caller that passed us garbage.
        L.push(';; --- application root REJECTED as unrepresentable in SBPL; no read grant emitted ---');
        L.push('');
    }

    // ── Writable zones ──────────────────────────────────────────────────────────────────────────────
    // WHY: exactly io-guard's write zones, passed in by the caller (see SeatbeltProfileOptions.writableDirs).
    // Each is granted read as well as write — a zone the child may write but not read is not a usable zone,
    // and the probe's temp zone lives outside appRoot, so it would otherwise be write-only.
    L.push(';; --- the ONLY writable zones: io-guard\'s write zones, as passed by the caller ---');
    if (writable.length === 0) {
        L.push(';; (none granted)');
    } else {
        for (const w of writable) L.push(`(allow file-read* file-write* (subpath ${w}))`);
    }
    if (droppedWritable > 0) {
        // Deliberately WITHOUT the offending path: a rejected path is exactly the kind of value that must
        // not be pasted back into the profile text, not even inside a `;;` comment that a newline would end.
        L.push(`;; NOTE: ${droppedWritable} requested zone(s) were REJECTED as unrepresentable in SBPL and are NOT granted.`);
    }
    L.push('');

    // ── Process operations ──────────────────────────────────────────────────────────────────────────
    // WHY the deny-then-allow order: `(deny process-exec*)` states the policy explicitly (so a later edit
    // that loosens `default` cannot silently reopen exec), and the narrow `(allow process-exec …)` after it
    // wins for the Node binary only, because the last matching rule wins. sandbox-exec applies the profile
    // and then exec()s its target IN THIS PROCESS, so without that allowance the child never starts.
    // Everything else — /bin/sh, /usr/bin/env, a payload the plugin dropped in its own writable dir — is
    // refused by the kernel, on top of the JS child_process block and Node's permission model.
    L.push(';; --- process: exec ONLY the Node binary (last matching rule wins, hence deny-then-allow) ---');
    L.push('(deny process-exec*)');
    for (const n of nodeLiterals) L.push(`(allow process-exec (literal ${n}))`);
    for (const n of nodeLiterals) L.push(`(allow file-read* file-map-executable (literal ${n})) ;; the loader reads AND maps the image it is about to exec`);
    L.push('(allow signal (target self))       ;; Node signals itself (e.g. its own SIGTERM/SIGINT plumbing)');
    L.push('(allow process-info* (target self)) ;; process.memoryUsage()/resourceUsage() read this process only');
    L.push('');

    // ── sysctl ──────────────────────────────────────────────────────────────────────────────────────
    // WHY unrestricted: libuv reads hw.ncpu / hw.memsize / hw.cputype / kern.* / kern.boottime during
    // initialization, and the set differs across macOS releases and across libuv versions. Enumerating them
    // means a single missing name is an unbootable child, and the failure would look like "Seatbelt does not
    // work here" rather than "one name is missing". These are read-only host facts (core count, RAM size,
    // kernel version) already exposed to the plugin through os.cpus()/os.totalmem() by the bridge; the
    // WRITE direction (sysctl-write) stays denied by (deny default), which is the direction that matters.
    L.push(';; --- sysctl: READ only. libuv reads hw.*/kern.* at init; the set varies by macOS/libuv version,');
    L.push(';; so enumerating it makes one missing name an unbootable child. sysctl-write stays denied.');
    L.push('(allow sysctl-read)');
    L.push('');

    // ── Mach services ───────────────────────────────────────────────────────────────────────────────
    // WHY an ALLOWLIST and never a blanket `(allow mach-lookup)`: the Mach bootstrap namespace is the
    // classic macOS sandbox-escape surface — reaching com.apple.xpc.launchd lets a confined process submit
    // jobs that run OUTSIDE the sandbox, and WindowServer has its own history. Each name below is one CF
    // initializes or that a Node runtime touches on startup; nothing here can start a process.
    L.push(';; --- Mach services: a narrow ALLOWLIST. Never blanket mach-lookup -- the bootstrap namespace');
    L.push(';; reaches launchd (job submission = escape) and WindowServer.');
    L.push('(allow mach-lookup');
    L.push('    (global-name "com.apple.system.notification_center")   ;; CFNotificationCenter, initialized by CoreFoundation');
    L.push('    (global-name "com.apple.system.opendirectoryd.libinfo") ;; getpwuid() behind os.userInfo()/os.homedir()');
    L.push('    (global-name "com.apple.logd")                          ;; os_log during dyld/CF startup');
    L.push('    (global-name "com.apple.diagnosticd"))                  ;; same, on older releases');
    L.push('');

    // ── Network ─────────────────────────────────────────────────────────────────────────────────────
    L.push(';; --- network ---');
    if (denyNetwork) {
        // The `--unshare-net` analogue for a plugin WITHOUT the admin network grant. Redundant under
        // (deny default) and stated anyway: this line is the policy, and an explicit deny cannot be
        // undone by a later edit that loosens the default.
        //
        // THE IPC ASSUMPTION, STATED PLAINLY (see seatbeltArgs): the fork-style bridge is an AF_UNIX
        // socketpair inherited as a file descriptor and ALREADY CONNECTED before the profile applies.
        // Seatbelt's network filters are evaluated at connect/bind, not on read/write of an established
        // descriptor, so this denial should leave the bridge intact — which is exactly how a Chrome
        // renderer keeps talking to the browser process under its own `(deny network*)`. "Should" is not
        // "does": probeSeatbelt() performs a full IPC round-trip UNDER THIS PROFILE and reports 'degraded'
        // if it does not complete. It does NOT retry with a looser profile — quietly widening a sandbox
        // until the probe passes is how a probe stops meaning anything.
        L.push(';; No `network` grant for this plugin: the --unshare-net analogue.');
        L.push(';; The fork IPC bridge is an already-connected AF_UNIX socketpair fd; Seatbelt evaluates');
        L.push(';; network rules at connect/bind, not on an established fd (same reason a Chrome renderer');
        L.push(';; keeps its IPC under (deny network*)). probeSeatbelt() validates that round-trip for real.');
        L.push('(deny network*)');
    } else {
        // A network-GRANTED plugin. Outbound is opened at the kernel level and stays bounded by the
        // in-process egress guard, which remains the authority on WHERE traffic may go — exactly the
        // arrangement on Linux, where a network-granted plugin keeps the shared netns. network-BIND is
        // NOT granted: a plugin has no business accepting inbound connections, and denying it removes a
        // whole class of "plugin opens a listener on the operator's machine" surprises.
        L.push(';; This plugin holds the admin `network` grant: outbound is opened at the kernel level and');
        L.push(';; the in-process egress guard remains the authority on WHERE it may go. Inbound (bind/listen)');
        L.push(';; is NOT granted -- a plugin has no business accepting connections.');
        L.push('(allow network-outbound)');
        L.push('(allow file-read* (literal "/private/etc/resolv.conf") (literal "/etc/resolv.conf") (subpath "/private/var/run/resolv.conf")) ;; DNS configuration');
        L.push('(allow mach-lookup');
        L.push('    (global-name "com.apple.SystemConfiguration.configd") ;; interface/DNS configuration');
        L.push('    (global-name "com.apple.dnssd.service")               ;; getaddrinfo() via mDNSResponder');
        L.push('    (global-name "com.apple.mDNSResponder"))              ;; same, on older releases');
    }
    L.push('');
    return L.join('\n');
}

/**
 * Build the argv for `sandbox-exec` (WITHOUT the binary itself — prepend SEATBELT_BIN, exactly as the
 * Linux path prepends 'bwrap' to bwrapProfile()'s output).
 *
 * `profile` is either the profile TEXT or a path to a `.sb` file. They are told apart by the leading
 * `(` that every profile this module builds starts with (`(version 1)`) and that no absolute path can
 * start with. Text goes to `-p`, a path to `-f`.
 *
 * THE ASSUMPTION THIS ARGV RESTS ON, AND IT IS THE ONE MOST LIKELY TO BE WRONG:
 *   sandbox-exec applies the profile to ITS OWN process and then execve()s the target. It does not fork,
 *   does not interpose a supervisor, and does not touch the descriptor table. So every inherited fd —
 *   crucially fd 3, the AF_UNIX socketpair whose number Node passes to the child as NODE_CHANNEL_FD —
 *   survives into the exec'd node, which then attaches its IPC channel exactly as a forked child would.
 *   This is the same property the Linux memory-cap wrapper depends on (`sh -c 'ulimit -v N; exec node …'`)
 *   and the same reason `systemd-run --scope` works there.
 *   If that assumption is false, the bridge is dead and the plugin never reports 'ready'. It is therefore
 *   PRECISELY what probeSeatbelt() validates: the probe child must complete a process.send() round-trip
 *   through this exact argv shape before this layer is allowed to report 'active'.
 *
 * No `--` terminator is emitted. sandbox-exec uses getopt, and callers always pass an ABSOLUTE Node path
 * as nodeArgs[0], so option parsing stops there on its own; adding a terminator that an untested
 * sandbox-exec build might not accept would risk the whole layer for no gain.
 */
function seatbeltArgs(profile: string, nodeArgs: string[]): string[] {
    const isText = typeof profile === 'string' && profile.trimStart().startsWith('(');
    return [isText ? '-p' : '-f', profile, ...(Array.isArray(nodeArgs) ? nodeArgs : [])];
}

/**
 * Cached per-process outcome, so operators and /health/details can see whether isolated plugins on this
 * Mac actually get the OS backstop — instead of the silent JS-guards-only fallback:
 *   'unsupported' = not macOS, or /usr/bin/sandbox-exec absent
 *   'disabled'    = config.sandbox.useSeatbelt is not enabled (the current DEFAULT — see the file header)
 *   'active'      = a real child was really refused, with the positive control passing
 *   'degraded'    = enabled, but the probe could not certify it. This is the dangerous
 *                   "looks secure but isn't" state, so it is a distinct value and never folded into
 *                   'unsupported'.
 */
let seatbeltState: 'unknown' | 'unsupported' | 'disabled' | 'active' | 'degraded' = 'unknown';
function getSeatbeltState() { return seatbeltState; }

/**
 * The probe child, as a single `node -e` program. ASCII only, no regular expressions and no backslashes,
 * so it survives every quoting layer between here and the kernel unchanged.
 *
 * argv[1] = a file path INSIDE the granted writable zone (positive control)
 * argv[2] = '1' when the profile denies network, '0' otherwise
 *
 * It reports FOUR facts over the IPC channel and then exits 0:
 *   wrote      — a write+read inside the granted zone SUCCEEDED. THE POSITIVE CONTROL. Without it, a
 *                profile that refuses literally everything (a syntax error, a missing app root) would
 *                satisfy every "was it refused?" check and be reported as confinement. This is the
 *                control-negative lesson from the sandbox-escape harness, applied in reverse.
 *   readCode   — the error code from reading /etc/passwd, which is OUTSIDE every zone this profile grants.
 *                Must be a sandbox refusal.
 *   netCode    — the error code from an outbound connect to a RAW IP (1.1.1.1:443 — no DNS, so a denied
 *                DNS lookup cannot be mistaken for a denied connect).
 *   sent       — implicit: the message arrived at all, which is the IPC round-trip.
 */
const PROBE_SRC = [
    'var fs=require("fs");var net=require("net");',
    'var out={wrote:false,readCode:"NONE",netCode:"SKIP"};',
    'var target=process.argv[1];var denyNet=process.argv[2]==="1";',
    'try{fs.writeFileSync(target,"wjs");out.wrote=fs.readFileSync(target,"utf8")==="wjs";}catch(e){out.wrote=false;out.writeCode=(e&&e.code)||"THROW";}',
    'try{fs.readFileSync("/etc/passwd");out.readCode="OPEN";}catch(e){out.readCode=(e&&e.code)||"THROW";}',
    'function finish(){try{process.send(out,function(){process.exit(0);});}catch(e){process.exit(5);}}',
    'setTimeout(function(){process.exit(4);},12000);',
    'if(!process.send){process.exit(3);}',
    'if(!denyNet){finish();}else{',
    'var done=false;var s=null;',
    'var settle=function(c){if(done){return;}done=true;out.netCode=c;try{if(s){s.destroy();}}catch(e){}finish();};',
    'try{s=net.connect(443,"1.1.1.1");s.on("error",function(e){settle((e&&e.code)||"THROW");});',
    's.on("connect",function(){settle("CONNECTED");});}catch(e){settle((e&&e.code)||"THROW");}',
    'setTimeout(function(){settle("TIMEOUT");},4000);',
    '}',
].join('');

/**
 * Codes that prove the KERNEL refused the operation, as opposed to it failing for an ordinary reason.
 *
 * This distinction is the whole probe. A connect to 1.1.1.1 from an offline Mac fails too — with
 * ENETUNREACH/EHOSTUNREACH/ETIMEDOUT, after a delay. Accepting "it failed" would let an unplugged network
 * cable certify a sandbox that is not there. A Seatbelt denial is immediate and surfaces as EPERM (EACCES
 * on some paths), so ONLY those two are accepted, and an offline Mac reports 'degraded' — an
 * under-claim, which is the correct direction to be wrong in.
 */
const REFUSAL_CODES = new Set(['EPERM', 'EACCES']);

/**
 * Strip line breaks before a value goes into a log line — the same sanitizer, in the same shape, as
 * plugin-isolate.ts's logSafe(). The values it wraps here are Node error codes from a child WE wrote, not
 * plugin input, so this is belt-and-braces; it stays because the house rule in this sandbox is that every
 * console call builds ONE already-sanitized string, and a rule with exceptions is not a rule. TWO
 * single-constant replacements (not an alternation) so the log-injection analysis recognises it
 * syntactically — match the documented remediation shape, not an equivalent of it.
 */
function logSafe(v: any): string {
    return String(v == null ? '' : v).replace(/\n/g, '').replace(/\r/g, '');
}

let seatbeltProbe: Promise<'active' | 'degraded' | 'unsupported' | 'disabled'> | undefined;
/**
 * Spawn a REAL child under the REAL profile and decide what this host actually gets.
 *
 * Memoized like every other probe in this sandbox: it costs a process spawn, its answer cannot change
 * within a process lifetime, and the launch path reads it synchronously.
 *
 * It reports 'active' ONLY when ALL of the following held at once:
 *   · sandbox-exec exists and the child launched through it,
 *   · the IPC round-trip completed (so the bridge survives the profile — see seatbeltArgs),
 *   · the POSITIVE CONTROL passed (a granted write really worked, so the profile is not simply broken),
 *   · a read OUTSIDE every granted zone was REFUSED by the kernel, and
 *   · with denyNetwork set, an outbound connect to a raw IP was REFUSED by the kernel.
 * Any other outcome is 'degraded' — enabled but uncertified — and the caller must fall back to the
 * existing launch. There is no path through this function that reports 'active' on a claim.
 */
function probeSeatbelt(): Promise<'active' | 'degraded' | 'unsupported' | 'disabled'> {
    if (seatbeltProbe) return seatbeltProbe;
    seatbeltProbe = (async () => {
        if (process.platform !== 'darwin') { seatbeltState = 'unsupported'; return 'unsupported'; }
        // OPT-IN while this profile is UNCERTIFIED (see the file header). Once a real Mac reports 'active'
        // AND real plugins load under it, this becomes a default-on/opt-out check like useKernelHardening.
        let enabled = false;
        try { const s = require('../config/app').sandbox; enabled = !!(s && s.useSeatbelt); } catch { /* config unavailable ⇒ treat as off */ }
        if (!enabled) { seatbeltState = 'disabled'; return 'disabled'; }
        if (!fsm.existsSync(SEATBELT_BIN)) {
            seatbeltState = 'unsupported';
            console.warn('[Sandbox] Seatbelt requested but /usr/bin/sandbox-exec is absent — isolated plugins keep the existing (process separation + Node permission model + JS guards) confinement.');
            return 'unsupported';
        }

        // The probe's writable zone is a kernel-exclusive 0700 mkdtemp directory: the profile it validates
        // must be the profile shape the real launch uses, and the real launch's zones are real directories.
        // Same reasoning as the bwrap/netns probes — a probe that does not mirror the launch green-lights a
        // configuration that then fails to start (the #192 lesson).
        const osm = require('os');
        let dir: string;
        try { dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'wjs-seatbelt-probe-')); } catch { seatbeltState = 'degraded'; return 'degraded'; }
        const appRoot = pathm.resolve(__dirname, '..', '..');
        const target = pathm.join(dir, 'control.txt');
        const profile = buildSeatbeltProfile({ writableDirs: [dir], denyNetwork: true, appRoot });

        type ProbeMsg = { wrote?: boolean; readCode?: string; netCode?: string };
        const result = await new Promise<ProbeMsg | null>((res) => {
            let proc: any = null, msg: ProbeMsg | null = null, done = false;
            const finish = (v: ProbeMsg | null) => {
                if (done) return;
                done = true;
                try { if (proc) proc.kill('SIGKILL'); } catch { /* already gone */ }
                res(v);
            };
            // Both racers are always cleaned up — an uncleared timer is what once kept a test subprocess
            // alive past its own IPC teardown.
            const overall = setTimeout(() => finish(null), 25000);
            if ((overall as any).unref) (overall as any).unref();
            try {
                proc = spawn(SEATBELT_BIN,
                    seatbeltArgs(profile, [process.execPath, '-e', PROBE_SRC, target, '1']),
                    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', timeout: 22000 });
            } catch { clearTimeout(overall); finish(null); return; }
            proc.on('message', (m: any) => { if (m && typeof m === 'object') msg = m as ProbeMsg; });
            proc.on('error', () => { clearTimeout(overall); finish(null); });   // ENOENT / not executable
            proc.on('exit', (code: number) => { clearTimeout(overall); finish(code === 0 ? msg : null); });
        });
        // Always removed, on every exit path — a probe that leaks one temp dir per failed boot is exactly
        // the bug the netns probe leg had to grow a `finally` for.
        try { fsm.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }

        // Every clause below must hold. Written as separate named checks rather than one boolean so a
        // failure says WHICH property was not proven — a probe that only says "no" teaches nobody anything.
        const ipcOk = !!result;                                                   // the round-trip completed
        const controlOk = !!(result && result.wrote === true);                    // granted write really worked
        const readRefused = !!(result && REFUSAL_CODES.has(String(result.readCode)));
        const netRefused = !!(result && REFUSAL_CODES.has(String(result.netCode)));
        if (ipcOk && controlOk && readRefused && netRefused) {
            seatbeltState = 'active';
            console.log('[Sandbox] macOS Seatbelt confinement ACTIVE (sandbox-exec: deny-by-default, filesystem writes scoped to the io-guard zones, exec restricted to the Node binary, and an empty network policy for non-network plugins).');
            return 'active';
        }
        seatbeltState = 'degraded';
        console.warn('[Sandbox] macOS Seatbelt probe did NOT certify confinement on this host — isolated plugins keep the existing (process separation + Node permission model + JS guards) floor. '
            + `ipc=${ipcOk ? 'ok' : 'FAILED'} writeControl=${controlOk ? 'ok' : 'FAILED'} outOfZoneRead=${readRefused ? 'refused' : logSafe((result && result.readCode) || 'unknown')} rawIpConnect=${netRefused ? 'refused' : logSafe((result && result.netCode) || 'unknown')}`);
        return 'degraded';
    })();
    return seatbeltProbe;
}

module.exports = {
    SEATBELT_BIN,
    buildSeatbeltProfile,
    seatbeltArgs,
    probeSeatbelt,
    getSeatbeltState,
    // Exported for the unit test only: the SBPL escaper is the injection boundary of this module, so it is
    // tested directly rather than inferred from profile text.
    sbplPath,
};
