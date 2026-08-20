/**
 * WordJS - macOS kernel confinement for the isolated plugin child (Seatbelt / `sandbox-exec`)
 *
 * This is the macOS implementation of WordJS's common native-sandbox contract. Seatbelt is applied below
 * the Node permission model and JavaScript guards and remains present for both network-policy shapes.
 *
 * Seatbelt is the macOS peer of that Linux layer. It ships with every macOS (`/usr/bin/sandbox-exec`,
 * kernel-enforced by the Sandbox kext through the MAC framework) and it is the same mechanism Chrome and
 * Firefox use to confine their own renderer processes. It is applied to the process BEFORE `execve`, so
 * it needs no privilege, no native dependency and no cooperation from the confined code.
 *
 * COMMON CONTRACT MAPPING
 *   scoped read/write authority              →  `(deny default)` + a JUSTIFIED read allowlist +
 *                                               `(allow file-write* (subpath <zone>))` for the io-guard zones only
 *   kernel network denial                    →  `(deny network*)`
 *   seccomp denylist (mount/ptrace/kexec/…)   →  `(deny default)` covers every Seatbelt-mediated operation
 *                                               class by construction (allowlist, not denylist — strictly
 *                                               stronger in kind, though it mediates fewer syscalls)
 *   seccomp's process/anonymous-exec denial   →  `(deny process-fork)` + `(deny process-exec*)` with an
 *                                               ephemeral literal Node image unlinked before plugin code
 *                                               is released (see "PROCESS" below)
 *   Landlock's PTRACE_MODE_READ domain rule   →  `(deny process-info*)` / `(deny mach-priv-task-port)` +
 *                                               a `kern.procargs` sysctl denial (see "HOST MEMORY" below)
 *   Linux uid/capability identity changes     →  Darwin has no Linux capability sets; `(deny default)`
 *                                               keeps the file/process/network boundary independent of
 *                                               the service account's ambient filesystem authority.
 *
 * ── PARITY ROWS THIS FILE OWNS, AND WHAT IS HONESTLY OPEN ────────────────────────────────────────────
 *
 * READS (closed for CONTENT, open for SHAPE). This profile is deny-by-default for file CONTENT: every
 * `(allow file-read* …)` below names a specific tree and carries the reason it is required. A confined
 * plugin cannot open anything in the operator's home directory, /etc, /Library, another user's files or
 * a sibling install. What it CAN still do is `stat()`: `(allow file-read-metadata)` is granted globally
 * because Node resolves its main module's realpath by lstat'ing every ancestor up to `/`, and require()'s
 * resolver lstats every candidate it probes — denying that kills the child before JavaScript runs. So the
 * honest row is "no read of file CONTENT outside the allowlist", and filesystem SHAPE (names, sizes,
 * mtimes) stays enumerable. Windows' AppContainer hides shape too, because an AppContainer reaches only
 * objects whose ACL names its SID; that is a real asymmetry and it is stated rather than papered over.
 *
 * CHILD PROCESSES (closed). `(deny process-fork)` + `(deny process-exec*)`. macOS `posix_spawn` — the
 * primitive behind every `child_process` call — is gated by `process-fork`, so a confined plugin cannot
 * create a process at all. sandbox-exec still needs one initial exec allowance, so production starts a
 * private Node copy whose preload blocks while the host unlinks it. When plugin code begins, the sole
 * allowed executable pathname no longer names a file and its directory was never writable by the child.
 *
 * HOST MEMORY (closed as far as SBPL can express it; one measured residual). macOS has no /proc, so the
 * Linux `/proc/<pid>/environ` read has two analogues: `task_for_pid()` (gated by `mach-priv-task-port`,
 * which `(deny default)` already refuses and which is restated explicitly below) and
 * `sysctl {CTL_KERN, KERN_PROCARGS2, pid}`, which returns another same-uid process's FULL argv AND
 * environment — the host backend's JWT_SECRET and DB credentials. The previous version of this profile
 * granted blanket `(allow sysctl-read)` and therefore left that wide open. There is now no blanket rule:
 * only a short exact-name list of non-secret boot/runtime facts is allowed, so kern.procargs is absent by
 * construction. The real macOS probe still measures the host-memory denial.
 *
 * MEMORY CAP (NOT closed, and it cannot be from here). See probeMacosMemoryCapEnforcement() at the bottom:
 * Darwin defines RLIMIT_AS as an alias of RLIMIT_RSS and enforces NEITHER, so the `ulimit -v` wrapper the
 * Linux/macOS launch path shares is very likely INERT on macOS while still logging "kernel memory cap
 * active". SBPL has no memory operation, so this profile cannot help. The probe added here MEASURES the
 * question instead of guessing at it, and the residual is stated in full at its definition.
 *
 * THE DISCIPLINE OF plugin-isolate.ts APPLIES UNCHANGED: nothing here is assumed from `process.platform`
 * or from `sandbox-exec` merely existing. probeSeatbelt() spawns a REAL child under the REAL profile AND
 * an UNCONFINED CONTROL child running the identical program, and reports 'active' ONLY when the confined
 * child was ACTUALLY refused each thing it must be refused WHILE the control was NOT — plus a POSITIVE
 * CONTROL (a granted write that must SUCCEED) so a profile so broken that everything fails can never be
 * mistaken for confinement. Anything short of that degrades to today's behaviour. Reporting confinement
 * that is not there is the "looks secure but isn't" state, which is worse than reporting none.
 *
 * STATUS — DEFAULT-ON, PROBE-GATED AND FAIL-CLOSED. An unrepresentable path is dropped rather than
 * escaped and an over-broad runtime prefix is refused. Both the network-denied and network-granted
 * profiles must pass a real control-versus-confined probe. Compiled production refuses plugin launch if
 * Seatbelt cannot be certified or if a per-plugin profile cannot be constructed.
 *
 * This module is PURE where it can be: buildSeatbeltProfile(), seatbeltArgs() and auditProfile() touch
 * nothing but their arguments (the exceptions — a realpath of caller paths and a homedir read, both
 * documented at their call sites — exist because Seatbelt matches RESOLVED paths and a profile written
 * against a symlink grants nothing), so the parts that can be tested off-macOS are tested off-macOS.
 * See backend/src/tests/sandbox-macos-profile.test.ts.
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
const SEATBELT_BOOTSTRAP_FILE = pathm.join(__dirname, 'sandbox-bootstrap.js');

type SeatbeltRuntime = { dir: string; exe: string; runtimeRoots: string[] };

/** Create a private executable identity for one launch; the host unlinks it before plugin code starts. */
function prepareSeatbeltRuntime(nodePath: string = process.execPath): SeatbeltRuntime {
    if (process.platform !== 'darwin') throw new Error('Seatbelt runtime preparation is macOS-only');
    const os = require('os');
    const dir = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'wjs-seatbelt-node-'));
    const exe = pathm.join(dir, 'node');
    try {
        fsm.copyFileSync(nodePath, exe);
        fsm.chmodSync(exe, 0o500);
        const originals = spellings(nodePath);
        return { dir, exe, runtimeRoots: uniq(originals.map((p) => ppath.dirname(ppath.dirname(p)))) };
    } catch (error) {
        try { fsm.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
        throw error;
    }
}

function disposeSeatbeltRuntime(runtime: SeatbeltRuntime | null | undefined): void {
    if (!runtime) return;
    try { fsm.rmSync(runtime.exe, { force: true }); } catch { /* */ }
    try { fsm.rmSync(runtime.dir, { recursive: true, force: true }); } catch { /* */ }
}

/**
 * Release the preload only after the literal executable allowed by SBPL no longer exists. The plugin
 * worker cannot run before the synchronous preload returns, so there is no race window for self-exec.
 */
function armSeatbeltBootstrap(child: any, runtime: SeatbeltRuntime): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let done = false;
        let timer: any = null;
        const finish = (error?: Error) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            if (error) { disposeSeatbeltRuntime(runtime); reject(error); } else resolve();
        };
        const ready = child && child.stdio && child.stdio[4];
        const release = child && child.stdio && child.stdio[5];
        if (!ready || !release) { finish(new Error('Seatbelt bootstrap pipes are unavailable')); return; }
        timer = setTimeout(() => finish(new Error('Seatbelt bootstrap timed out')), 15000);
        if ((timer as any).unref) (timer as any).unref();
        ready.once('data', (data: any) => {
            if (!data || !Buffer.from(data).includes(0x52)) { finish(new Error('Seatbelt bootstrap sent an invalid marker')); return; }
            disposeSeatbeltRuntime(runtime);
            if (fsm.existsSync(runtime.exe)) { finish(new Error('ephemeral Seatbelt executable survived unlink')); return; }
            try {
                release.write(Buffer.from('G'), (error: any) => error ? finish(error) : finish());
            } catch (error: any) { finish(error); }
        });
        child.once('error', (error: any) => finish(error instanceof Error ? error : new Error(String(error))));
        child.once('exit', () => { if (!done) finish(new Error('Seatbelt child exited before bootstrap completed')); });
    });
}

/**
 * All profile path arithmetic uses the POSIX flavour of `path` EXPLICITLY. On a Windows dev/CI host
 * `path.join` would splice backslashes into a macOS path and `path.dirname` would disagree with itself
 * across hosts; the profile text must be byte-identical no matter where it is generated, because the unit
 * tests that pin it run on every platform.
 */
const ppath = pathm.posix;

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
    const p = normalizePath(raw);
    if (p === null) return null;
    if (p.includes('"')) return null;                  // the string terminator itself — REJECTED, never escaped (see above)
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(p)) return null;  // control characters: reject, never escape-and-hope
    return `"${p.replace(/\\/g, '\\\\')}"`;            // legal in a macOS filename, and it can never terminate a literal
}

/**
 * The path half of sbplPath: the same acceptance rules, but returning the PATH rather than the quoted
 * literal, because the overlap arithmetic below (W^X, prefix containment) has to reason about paths and
 * must apply to exactly the set of values that can reach the profile. Two predicates would drift, and the
 * looser one would decide.
 */
function normalizePath(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    // Strip a single trailing separator: Seatbelt's `subpath` wants the directory without it, and
    // "/srv/app/uploads/" would not match "/srv/app/uploads/x".
    const p = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (p.length === 0) return null;
    if (p === '/') return null;                        // never the whole filesystem (see the reject list above)
    if (!p.startsWith('/')) return null;               // Seatbelt matches absolute, already-resolved paths
    return p;
}

/**
 * Both spellings of a path: as given, and as the filesystem resolves it.
 *
 * THIS IS LOAD-BEARING ON macOS AND IT IS WHERE THE PREVIOUS VERSION OF THIS MODULE WOULD HAVE FAILED.
 * Seatbelt matches the REAL path. On macOS `/tmp`, `/var` and `/etc` are symlinks into `/private`, and
 * `os.tmpdir()` — which plugin-isolate.ts passes in as the "os-tmp" write zone, and which the probe below
 * uses for its own positive control — returns `/var/folders/xx/…`. A profile granting `(subpath
 * "/var/folders/…")` grants NOTHING, because the kernel checks `/private/var/folders/…`. The symptom
 * would not be an error message; it would be every plugin's temp writes failing and this layer never
 * certifying on any Mac, forever.
 *
 * Emitting BOTH is deliberate rather than emitting only the resolved one: the resolved path is what
 * today's kernel checks, and the original is kept in case a path is resolvable at profile-build time but
 * not later, or a future macOS checks the pre-resolution spelling. Both are inside the same trust
 * boundary — they name the same object — so this widens nothing.
 *
 * A realpath that THROWS (the path does not exist yet, or is a synthetic value from a unit test) yields
 * just the original spelling. That keeps the builder total: a profile builder must never throw.
 */
function spellings(raw: unknown): string[] {
    const p = normalizePath(raw);
    if (p === null) return [];
    let real: string | null;
    try { real = normalizePath(fsm.realpathSync(p)); } catch { real = null; }
    return uniq(real && real !== p ? [p, real] : [p]);
}

/** De-duplicate while preserving order — a repeated `(subpath …)` is harmless but makes the profile lie about its own size. */
function uniq(list: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of list) { if (!seen.has(v)) { seen.add(v); out.push(v); } }
    return out;
}

/** True when `child` is `parent` or lives beneath it. Component-aware: "/usr/libexec" is NOT inside "/usr/lib". */
function isWithin(child: string, parent: string): boolean {
    return child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');
}
/** True when the two trees intersect in EITHER direction — which is what a containment check has to mean here. */
function overlaps(a: string, b: string): boolean { return isWithin(a, b) || isWithin(b, a); }

/**
 * OS trees the child must be able to READ and MAP EXECUTABLE for dyld to bring it up at all.
 *
 * Each is read-only OS content, world-readable on every macOS install, and carries no user or application
 * data — denying them buys nothing and costs the runtime. `file-map-executable` is a SEPARATE operation
 * from `file-read*` on modern macOS: without it dyld cannot map libSystem and the child dies before
 * main(), a failure that would read as "Seatbelt is broken here" rather than "one operation is missing".
 */
const OS_EXEC_ROOTS: Array<[string, string]> = [
    ['/usr/lib', 'libSystem and the dyld stub libraries; dyld needs them pre-main()'],
    ['/System/Library', 'CoreFoundation, ICU and the frameworks they pull in'],
    // macOS 13+ moves the dyld shared cache and several system dylibs into cryptexes. A profile that
    // knows only /System/Library boots on Monterey and dies on Sonoma -- which is the CI runner (macos-14).
    ['/System/Cryptexes', 'macOS 13+ hosts the dyld shared cache and system dylibs in cryptexes'],
    ['/System/Volumes/Preboot/Cryptexes', 'the on-disk backing store for the same cryptexes'],
    ['/private/var/db/dyld', 'the dyld shared cache on releases that keep it here'],
];

/**
 * OS trees the child must READ but must never MAP EXECUTABLE. Data, not code.
 *
 * These are deliberately NARROW subpaths rather than the whole of /usr/share: an allowance nobody can
 * justify is the hole the next audit finds, and "/usr/share" is a large tree of documentation, man pages
 * and third-party payloads that a plugin has no reason to read.
 */
const OS_DATA_ROOTS: Array<[string, string]> = [
    ['/usr/share/zoneinfo', 'TZ database, read when the process resolves its local time zone'],
    ['/usr/share/icu', 'ICU data file (icudt*.dat) backing Intl, read by libicucore at startup'],
    ['/usr/share/locale', 'locale tables read through setlocale() during CoreFoundation init'],
    ['/private/var/db/timezone', 'the target of /etc/localtime on current releases'],
];

/**
 * A derived Node runtime prefix is REFUSED when it is this shallow or shallower.
 *
 * `dirname(dirname(node))` is the right root for an nvm/asdf/fnm/Homebrew install, where the runtime's
 * own dylibs live beside the binary. It is the WRONG root for `/usr/bin/node`, where it degenerates to
 * `/usr` — a grant that is not "the Node runtime" but a chunk of the filesystem, and one that would drag
 * in `/usr/local` (operator-writable on Intel Homebrew hosts, and a place people keep configuration).
 * A system Node needs nothing beyond the OS roots above, which are granted anyway, so refusing here costs
 * that install nothing and costs an over-broad grant everything.
 */
const MIN_RUNTIME_PREFIX_COMPONENTS = 2;

export type SeatbeltProfileOptions = {
    /**
     * The zones the child may WRITE. These are io-guard's write zones — the caller passes the SAME array
     * plugin-isolate.ts already builds for Landlock and for `--allow-fs-write` (the plugin's
     * own dir + hashed per-plugin data/log/os-tmp directories). They are deliberately NOT restated here: two independent
     * lists of "what a plugin may write" drift, and the drift is silent. One declaration, three consumers.
     */
    writableDirs?: string[];
    /**
     * True for a plugin WITHOUT the admin `network` grant. False for a
     * network-granted plugin, whose egress stays bounded by the in-process egress guard exactly as today.
     */
    denyNetwork?: boolean;
    /** The application root. Read-only to the child except for the writable zones above. */
    appRoot: string;
    /** Narrow code/dependency roots. When present these replace the legacy whole-appRoot read grant. */
    readOnlyDirs?: string[];
    /**
     * The Node binary the child will exec. Defaults to this process's. Seatbelt matches the RESOLVED path,
     * so a symlinked install (Homebrew's /opt/homebrew/bin/node → …/Cellar/node/…/bin/node) needs the
     * target as well as the link — both are emitted, and both contribute a runtime prefix, which is how a
     * Homebrew node reaches its `…/opt/icu4c/lib` dylibs that live outside its Cellar directory.
     */
    nodePath?: string;
    /** Original runtime prefixes when nodePath is an ephemeral executable copy. */
    runtimeRoots?: string[];
};

/**
 * Build the SBPL profile for one isolated plugin child.
 *
 * EVERY allowance below carries the reason it exists. That is not documentation etiquette: an allowance
 * nobody can justify is precisely the hole the next audit finds, and in an allowlist sandbox the only
 * thing standing between "confined" and "theatre" is whether each `(allow …)` was earned.
 *
 * SBPL EVALUATION ORDER — the LAST matching rule wins. `(deny default)` therefore has to come first; a
 * narrowing `(deny …)` has to come BEFORE the `(allow …)` that carves an exception out of it; and a
 * `(deny …)` that CLAWS BACK part of a broad allow (the sysctl case below) has to come AFTER it. Getting
 * either backwards produces a profile that reads correctly and enforces the opposite.
 */
function buildSeatbeltProfile(opts: SeatbeltProfileOptions): string {
    const denyNetwork = !!(opts && opts.denyNetwork);
    const rawNode = (opts && opts.nodePath) || process.execPath;

    // ── Resolve every caller-supplied path to the spellings the kernel will actually check ──────────
    const requestedReadRoots = Array.isArray(opts && opts.readOnlyDirs)
        ? (opts.readOnlyDirs as string[])
        : [opts && opts.appRoot];
    const appRoots = uniq(requestedReadRoots.flatMap((p) => spellings(p).filter((v) => sbplPath(v) !== null)));
    const requestedZones = Array.isArray(opts && opts.writableDirs) ? (opts.writableDirs as string[]) : [];
    // `spellings()` validates the filesystem shape; `sbplPath()` validates the parser boundary. Keep the
    // result of BOTH checks as the single source of truth for emission, W^X overlap arithmetic and the
    // rejection count. Previously a quote/control-bearing path survived `spellings()`, influenced W^X,
    // and was only dropped while emitting the literal, so the profile failed to report the rejection.
    const zoneSpellings = requestedZones.map((d) => spellings(d).filter((p) => sbplPath(p) !== null));
    const zones = uniq(zoneSpellings.flat());
    // Count requested zones, not spellings: a symlink legitimately produces two spellings but remains
    // one caller grant, while a zone with no parser-safe spelling is one rejected grant.
    const droppedZones = zoneSpellings.filter((paths) => paths.length === 0).length;
    const nodePaths = spellings(rawNode);

    // ── The Node runtime prefix ─────────────────────────────────────────────────────────────────────
    // REQUIRED, not a nicety, and the Linux shim learned it first (`readRoot: [APP_ROOT,
    // dirname(dirname(execPath))]`). A Homebrew node links against /opt/homebrew/opt/icu4c/lib/*.dylib,
    // an nvm node lives entirely under ~/.nvm/versions/node/vX; neither is reachable from the OS roots,
    // so without this the child cannot even map its own runtime and would never boot. Derived from BOTH
    // spellings of the binary: for Homebrew, the symlink gives /opt/homebrew (which holds the dylibs) and
    // the realpath gives the Cellar directory (which does not).
    let homeDir = '';
    try { homeDir = normalizePath(require('os').homedir()) || ''; } catch { homeDir = ''; }
    const explicitRuntimeRoots = Array.isArray(opts && opts.runtimeRoots)
        ? (opts.runtimeRoots as string[]).flatMap((p) => spellings(p))
        : [];
    const derivedRuntimeRoots = explicitRuntimeRoots.length ? [] : nodePaths.map((n) => ppath.dirname(ppath.dirname(n)));
    const runtimePrefixes = uniq([...derivedRuntimeRoots, ...explicitRuntimeRoots])
        .filter((p) => normalizePath(p) !== null)
        // Too shallow to be "the runtime" -- see MIN_RUNTIME_PREFIX_COMPONENTS.
        .filter((p) => p.split('/').filter(Boolean).length >= MIN_RUNTIME_PREFIX_COMPONENTS)
        // …and never the home directory or an ancestor of it. `/Users/<name>/bin/node` would otherwise
        // derive the whole home directory as a "runtime prefix" and hand back exactly the read row this
        // profile exists to close. A runtime INSIDE the home directory (nvm) is fine and still granted.
        .filter((p) => !(homeDir && isWithin(homeDir, p)));

    // ── W^X: a tree that is WRITABLE is never MAPPED EXECUTABLE ─────────────────────────────────────
    // The plugin's own directory is writable. Granting file-map-executable anywhere that overlaps a
    // writable zone would let a plugin write a dylib and then map it — arbitrary native code inside the
    // sandbox, which defeats the AST scanner, secure-require's ban on planted code and this profile at
    // once. So the map-executable set is FILTERED against the write set here rather than merely being
    // written carefully: a future caller that passes a zone overlapping a system tree loses the mapping
    // (child fails to boot, probe degrades, fail closed) instead of gaining a W^X escape.
    const execRootPairs: Array<[string, string]> = [
        ...OS_EXEC_ROOTS,
        ...runtimePrefixes.map((p) => [p, 'the Node runtime prefix: its own dylibs live beside the binary'] as [string, string]),
    ];
    const execRoots = execRootPairs.filter(([p]) => !zones.some((z) => overlaps(p, z)));
    const droppedExecRoots = execRootPairs.length - execRoots.length;

    const L: string[] = [];
    const lit = (p: string) => sbplPath(p) as string; // every p here already passed normalizePath

    L.push('(version 1)');
    L.push(';; WordJS isolated plugin child. Generated by backend/src/core/sandbox-macos.ts -- do not hand-edit.');
    L.push(';; Evaluation order: the LAST matching rule wins, so (deny default) must stay first, a narrowing');
    L.push(';; deny must precede the allow it carves an exception out of, and a claw-back deny must follow');
    L.push(';; the broad allow it narrows.');
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
    //
    // THIS IS THE ONE PLACE THIS PROFILE IS WEAKER THAN THE WINDOWS APPCONTAINER, and it is stated rather
    // than hidden: an AppContainer cannot even enumerate objects whose ACL omits its SID.
    L.push(';; --- metadata-only reads (existence/stat), everywhere ---');
    L.push(';; Node lstats every ancestor of its main module (realpath resolution) and every require()');
    L.push(';; candidate. Denying this kills the child before JS runs. Discloses SHAPE, never CONTENT --');
    L.push(';; the one row where this profile is weaker than the Windows AppContainer.');
    L.push('(allow file-read-metadata)');
    L.push('');

    // ── Runtime + dynamic linker ────────────────────────────────────────────────────────────────────
    L.push(';; --- boot: dynamic linker + OS runtime (read-only, world-readable OS content) ---');
    L.push(';; Nothing here holds user or application data, and without it dyld cannot bring the process up.');
    for (const [p, why] of OS_EXEC_ROOTS) L.push(`(allow file-read* (subpath ${lit(p)}))${pad(p)} ;; ${why}`);
    for (const [p, why] of OS_DATA_ROOTS) L.push(`(allow file-read* (subpath ${lit(p)}))${pad(p)} ;; ${why}`);
    L.push('(allow file-read* (literal "/private/etc/localtime") (literal "/etc/localtime")) ;; TZ symlink/target, both spellings');
    L.push('');
    for (const p of runtimePrefixes) {
        L.push(`(allow file-read* (subpath ${lit(p)})) ;; the Node runtime prefix (nvm/asdf/Homebrew keep the runtime dylibs here)`);
    }
    if (runtimePrefixes.length) L.push('');
    L.push(';; Mapping executable pages is a SEPARATE operation from reading. Required for dyld; granted for');
    L.push(';; the OS runtime and the Node image ONLY -- never for anything that is also writable (W^X).');
    if (execRoots.length) {
        L.push('(allow file-map-executable');
        for (const [p] of execRoots) L.push(`    (subpath ${lit(p)})`);
        L[L.length - 1] += ')';
    } else {
        L.push(';; (no executable-mapping roots survived the W^X filter -- the child will NOT boot, by design)');
    }
    if (droppedExecRoots > 0) {
        L.push(`;; NOTE: ${droppedExecRoots} executable-mapping root(s) were DROPPED because they overlap a writable zone (W^X).`);
    }
    L.push('');

    // ── Device nodes ────────────────────────────────────────────────────────────────────────────────
    // WHY: /dev/urandom + /dev/random back crypto.randomBytes and V8's PRNG seeding; /dev/zero backs
    // anonymous mappings on some allocator paths; /dev/null is where a closed stdio stream is pointed;
    // /dev/dtracehelper and /dev/autofs_nowait are opened (and ioctl'd) by dyld while loading images on
    // several macOS builds, and a denial there aborts the launch before main(). Nothing else in /dev is
    // granted — no tty, no disks, no /dev/mem.
    L.push(';; --- device nodes actually required to boot ---');
    L.push('(allow file-read* (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/zero")) ;; crypto.randomBytes + V8 seeding + anon mappings');
    L.push('(allow file-read* file-write* (literal "/dev/null"))                ;; the sink for closed stdio');
    L.push('(allow file-read* file-write* file-ioctl (literal "/dev/dtracehelper")) ;; dyld opens+ioctls it while loading images');
    L.push('(allow file-read* file-write* (literal "/dev/autofs_nowait"))       ;; dyld touches it to keep autofs from blocking path resolution');
    L.push('');

    // ── The application ─────────────────────────────────────────────────────────────────────────────
    // WHY read: the child must load plugin-worker.js, core/, node_modules and the plugin's own code.
    // WHY read-only: core src/, node_modules and SIBLING plugins stay unwritable at the KERNEL level, so a
    // plugin that defeats the JS io-guard still cannot persist a payload into core source, a shared
    // dependency, or another plugin — the same property the Linux Landlock rules give.
    // WHY no file-map-executable: see the W^X note above. No writable zone may become executable.
    if (appRoots.length) {
        L.push(';; --- application code roots: READ-ONLY, never the whole install root ---');
        for (const p of appRoots) L.push(`(allow file-read* (subpath ${lit(p)}))`);
        L.push('');
    } else {
        // No usable application-code root ⇒ the child cannot load its worker at all. Emitting nothing (rather than
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
    if (zones.length === 0) {
        L.push(';; (none granted)');
    } else {
        for (const z of zones) L.push(`(allow file-read* file-write* (subpath ${lit(z)}))`);
    }
    if (droppedZones > 0) {
        // Deliberately WITHOUT the offending path: a rejected path is exactly the kind of value that must
        // not be pasted back into the profile text, not even inside a `;;` comment that a newline would end.
        L.push(`;; NOTE: ${droppedZones} requested zone(s) were REJECTED as unrepresentable in SBPL and are NOT granted.`);
    }
    L.push('');

    // ── Process operations ──────────────────────────────────────────────────────────────────────────
    // THE CHILD-PROCESS PARITY ROW. Linux seccomp refuses process-control syscalls; the
    // Seatbelt equivalent is these two lines, and `process-fork` is the load-bearing one. Every macOS
    // process creation — posix_spawn (which is what libuv uses for child_process), fork, vfork, system()
    // — is gated by it, so a confined plugin cannot create a process AT ALL. That is strictly stronger
    // than denying exec alone, which would still allow a fork bomb.
    //
    // Both denials are already implied by (deny default) and are stated anyway: an explicit deny is the
    // POLICY, and it cannot be silently undone by a later edit that loosens the default.
    //
    // THE ONE CARVE-OUT. sandbox-exec applies the profile and then exec()s its target IN THIS PROCESS, so
    // without `(allow process-exec (literal <node>))` the child never starts. It is a `literal`, not a
    // subpath; it is `process-exec`, NOT `process-exec*` — so `process-exec-interpreter` (a shebang script
    // that would run through an interpreter) stays denied even for Node. Production also uses an ephemeral
    // pathname and unlinks it before plugin code is released, so this rule names no existing file then.
    // A payload the plugin dropped in its own writable dir is refused by the kernel, on top of the JS
    // child_process block and Node's permission model.
    L.push(';; --- process: no fork at all, exec ONLY the Node image (last matching rule wins) ---');
    L.push(';; posix_spawn/fork/vfork/system() are all gated by process-fork, so a confined plugin cannot');
    L.push(';; create a process. The exec carve-out exists only because sandbox-exec execs its own target.');
    L.push('(deny process-fork)');
    L.push('(deny process-exec*)');
    for (const n of nodePaths) L.push(`(allow process-exec (literal ${lit(n)}))`);
    for (const n of nodePaths) L.push(`(allow file-read* file-map-executable (literal ${lit(n)})) ;; the loader reads AND maps the image it is about to exec`);
    L.push('(allow signal (target self))        ;; Node signals itself (e.g. its own SIGTERM/SIGINT plumbing)');
    L.push('');

    // ── Reading another process ─────────────────────────────────────────────────────────────────────
    // THE HOST-MEMORY PARITY ROW. Landlock gives Linux this for free: a confined task cannot
    // PTRACE_MODE_READ one outside its domain, so /proc/<pid>/environ of the host backend — where
    // JWT_SECRET and the DB credentials live — is closed. macOS has no /proc; the equivalents are
    // task_for_pid() (gated by mach-priv-task-port), task_name_for_pid() (mach-task-name), proc_pidinfo()
    // (process-info*) and the sysctl below. All are already refused by (deny default); each is restated
    // because a deny that is written down survives an edit that a deny-by-omission does not.
    //
    // process-info* is the one that NEEDS the explicit deny rather than merely benefiting from it: an
    // allow follows it, and without the deny first a reader cannot tell whether `(target self)` is a
    // narrowing of something broad or the whole story.
    L.push(';; --- reading another process: the Landlock PTRACE_MODE_READ analogue ---');
    L.push(';; task_for_pid / task_name_for_pid / proc_pidinfo against the HOST BACKEND would hand a plugin');
    L.push(';; the process that holds JWT_SECRET and the DB credentials. All denied; self is carved out.');
    L.push('(deny mach-priv-task-port)          ;; task_for_pid() on another process');
    L.push('(deny mach-priv-host-port)          ;; host_priv: kernel-wide task enumeration');
    L.push('(deny mach-task-name)               ;; task_name_for_pid(), the read-only cousin');
    L.push('(deny process-info*)');
    L.push('(allow process-info* (target self)) ;; process.memoryUsage()/resourceUsage() read THIS process only');
    L.push('');

    // ── sysctl ──────────────────────────────────────────────────────────────────────────────────────
    // Exact-name allowlist: a blanket sysctl-read cannot be safely clawed back for the numeric
    // KERN_PROCARGS2 MIB on every Darwin release. These are the read-only host facts libuv/Node query.
    L.push(';; --- sysctl: exact boot/runtime facts only; kern.procargs* is absent by construction ---');
    L.push('(allow sysctl-read');
    for (const name of [
        'hw.activecpu', 'hw.cachelinesize', 'hw.logicalcpu', 'hw.machine', 'hw.memsize', 'hw.model',
        'hw.ncpu', 'hw.pagesize', 'hw.physicalcpu',
        'kern.argmax', 'kern.boottime', 'kern.hostname', 'kern.osrelease', 'kern.ostype',
        'kern.osversion', 'kern.secure_kernel', 'kern.version',
    ]) L.push(`    (sysctl-name ${JSON.stringify(name)})`);
    L[L.length - 1] += ')';
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
        // Native no-egress policy for a plugin WITHOUT the admin network grant. Redundant under
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
        L.push(';; No `network` grant for this plugin: deny all new network operations.');
        L.push(';; The fork IPC bridge is an already-connected AF_UNIX socketpair fd; Seatbelt evaluates');
        L.push(';; network rules at connect/bind, not on an established fd (same reason a Chrome renderer');
        L.push(';; keeps its IPC under (deny network*)). probeSeatbelt() validates that round-trip for real.');
        L.push('(deny network*)');
    } else {
        // A network-GRANTED plugin. Outbound is opened at the kernel level and stays bounded by the
        // in-process egress guard, which remains the authority on WHERE traffic may go — exactly the
        // arrangement on Linux, where the socket rule alone changes. Inbound is
        // NOT granted: a plugin has no business accepting inbound connections, and denying it removes a
        // whole class of "plugin opens a listener on the operator's machine" surprises.
        L.push(';; This plugin holds the admin `network` grant: outbound is opened at the kernel level and');
        L.push(';; the in-process egress guard remains the authority on WHERE it may go. Inbound (network-BIND');
        L.push(';; / listen) is NOT granted -- a plugin has no business accepting connections.');
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

/** Column padding so the generated comments line up. Cosmetic only; never affects a rule. */
function pad(p: string): string {
    const width = 34;
    return p.length >= width ? '' : ' '.repeat(width - p.length);
}

/**
 * THE GATE. Re-read the generated profile as TEXT and return every invariant it violates.
 *
 * This exists because the builder's own correctness is exactly what cannot be taken on trust: the file
 * header says plainly that no Sandbox kext has ever parsed this text, so the last line of defence off
 * Apple hardware is an independent reader that does not share the builder's assumptions. It parses the
 * emitted rules rather than inspecting the builder's variables, which is the point — a refactor that
 * quietly widens a grant changes the TEXT, and the text is what the kernel sees.
 *
 * The invariants:
 *   1. no `(allow default)` — SBPL is last-match-wins, so one of these anywhere annihilates the profile.
 *   2. no UNFILTERED `(allow file-read*)` — the read row is only closed if every read grant names a tree.
 *   3. no `(allow process-exec*)` and no blanket `(allow mach-lookup)`.
 *   4. no inbound network grant.
 *   5. W^X: no path granted `file-write*` may also be granted `file-map-executable`, in either
 *      containment direction. This is the invariant that turns "a plugin can write its own directory"
 *      from a storage feature into an arbitrary-native-code escape if it is ever broken.
 *
 * Returns [] for a clean profile. The test suite asserts BOTH directions: the real profile is clean, and
 * a profile with one extra map-executable member covering a writable zone is REPORTED — a gate nobody has
 * ever seen go red is not a gate.
 */
function auditProfile(profile: string): string[] {
    const problems: string[] = [];
    const text = typeof profile === 'string' ? profile : '';
    // Strip `;;` comments before matching rules: the profile documents the very patterns it forbids, and
    // an auditor that reads its own warning labels as violations is noise, not a gate.
    const rules = text.split('\n').map((l) => {
        const i = l.indexOf(';;');
        return i === -1 ? l : l.slice(0, i);
    });
    const body = rules.join('\n');

    if (/\(allow\s+default\)/.test(body)) problems.push('(allow default) present: SBPL is last-match-wins, this annihilates (deny default)');
    if (/\(allow\s+process-exec\*\)/.test(body)) problems.push('(allow process-exec*) present: exec must never be granted unrestricted');
    if (/\(allow\s+sysctl-read\s*\)/.test(body)) problems.push('blanket (allow sysctl-read) present: kern.procargs2 exposes another process environment');
    if (/\(allow\s+mach-lookup\s*\)/.test(body)) problems.push('blanket (allow mach-lookup) present: the bootstrap namespace reaches launchd');
    if (/network-bind|network-inbound/.test(body)) problems.push('an inbound network grant is present: a plugin must never listen');
    if (!/\(deny\s+default\)/.test(body)) problems.push('(deny default) missing: the profile is not deny-by-default');

    // An `(allow …file-read*…)` line that names no (subpath …) / (literal …) filter is a blanket read.
    for (const line of rules) {
        if (!/\(allow\b/.test(line)) continue;
        if (!/\bfile-read\*/.test(line)) continue;
        if (/\((?:subpath|literal|regex)\b/.test(line)) continue;
        problems.push(`unfiltered read grant: ${line.trim()}`);
    }

    const writePaths = collectPaths(rules, /\bfile-write\*/);
    const execPaths = collectPaths(rules, /\bfile-map-executable\b/);
    for (const w of writePaths) {
        for (const x of execPaths) {
            if (overlaps(w, x)) problems.push(`W^X violated: "${w}" is writable and "${x}" is mappable executable`);
        }
    }
    return problems;
}

/**
 * Pull every `(subpath "…")` / `(literal "…")` argument out of the ALLOW lines that match `op`, undoing
 * the backslash doubling sbplPath() applied. Multi-line `(allow file-map-executable` blocks are handled by
 * carrying the operation forward until the block's closing parenthesis, because that is how the profile
 * actually writes them.
 */
function collectPaths(rules: string[], op: RegExp): string[] {
    const out: string[] = [];
    let inBlock = false;
    for (const line of rules) {
        const opens = /\(allow\b/.test(line);
        if (opens) inBlock = op.test(line);
        if (!inBlock) continue;
        const re = /\((?:subpath|literal)\s+"((?:[^"\\]|\\.)*)"\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) out.push(m[1].replace(/\\\\/g, '\\'));
        // A line whose parentheses balance out ends the block. Counting is enough here because the only
        // multi-line forms this builder emits are `(allow <op>` followed by indented filters.
        const depth = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
        if (opens && depth <= 0) inBlock = false;
        else if (!opens && depth < 0) inBlock = false;
    }
    return uniq(out);
}

/**
 * Build the argv for `sandbox-exec` (WITHOUT the binary itself — the caller prepends SEATBELT_BIN).
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
 *   NOTE that this is also why `(deny process-fork)` above does not break the launch: sandbox-exec EXECS,
 *   it never forks, and the profile is applied before that exec.
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
 *   'disabled'    = config.sandbox.useSeatbelt was explicitly set to false
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
 * THE SAME PROGRAM RUNS TWICE: once under the profile, once UNCONFINED as the control. That is what makes
 * the result a MEASUREMENT rather than an assertion — "the read failed" only means confinement if the same
 * read succeeded without it. An offline Mac, a missing /etc/passwd or a broken Node all make the confined
 * run fail too, and every one of them would otherwise certify a sandbox that is not there.
 *
 * argv[1] = a file path INSIDE the granted writable zone (positive control)
 * argv[2] = '1' when the profile denies network, '0' otherwise
 *
 * Reported facts:
 *   wrote      — a write+read inside the granted zone SUCCEEDED. THE POSITIVE CONTROL. Without it, a
 *                profile that refuses literally everything (a syntax error, missing application roots) would
 *                satisfy every "was it refused?" check and be reported as confinement.
 *   readCode   — reading /etc/passwd, which is OUTSIDE every zone this profile grants.
 *   homeCode   — reading the HOME DIRECTORY, which is the parity row Windows already closes. A directory
 *                read is used rather than a named file so the probe never depends on a file existing.
 *   execCode   — asynchronous spawn of a real binary. The child first reports ATTEMPTED because Darwin
 *                may deliver SIGABRT instead of a recoverable error for a Seatbelt process-fork denial.
 *                The unconfined control must run the same child successfully before that signal counts.
 *   netCode    — an outbound connect to a RAW IP (1.1.1.1:443 — no DNS, so a denied DNS lookup cannot be
 *                mistaken for a denied connect).
 *   sent       — implicit: the message arrived at all, which is the IPC round-trip.
 */
const PROBE_SRC = [
    'var fs=require("fs");var net=require("net");var os=require("os");var cp=require("child_process");',
    'var out={wrote:false,readCode:"NONE",homeCode:"NONE",execCode:"NONE",selfExecCode:"SKIP",netCode:"SKIP"};',
    'var target=process.argv[1];var denyNet=process.argv[2]==="1";',
    'try{fs.writeFileSync(target,"wjs");out.wrote=fs.readFileSync(target,"utf8")==="wjs";}catch(e){out.wrote=false;out.writeCode=(e&&e.code)||"THROW";}',
    'try{fs.readFileSync("/etc/passwd");out.readCode="OPEN";}catch(e){out.readCode=(e&&e.code)||"THROW";}',
    'try{fs.readdirSync(os.homedir());out.homeCode="OPEN";}catch(e){out.homeCode=(e&&e.code)||"THROW";}',
    'out.selfExecCode=fs.existsSync(process.execPath)?"OPEN":"ENOENT";',
    'function reportFinal(){try{process.send(out,function(){process.exit(0);});}catch(e){process.exit(5);}}',
    'function attemptSpawn(){out.execCode="ATTEMPTED";try{process.once("message",function(m){if(!m||m.wordjsProbeSpawn!==true){process.exit(6);return;}var settled=false;var child=null;var done=function(v){if(settled){return;}settled=true;out.execCode=v;try{if(child){child.kill();}}catch(e){}reportFinal();};try{child=cp.spawn("/bin/echo",["wjs"]);child.on("error",function(e){done((e&&e.code)||"THROW");});child.on("exit",function(code){done(code===0?"OK":"FAIL");});}catch(e){done((e&&e.code)||"THROW");}});process.send(out);}catch(e){process.exit(5);}}',
    'setTimeout(function(){process.exit(4);},12000);',
    'if(!process.send){process.exit(3);}',
    'function tryNetwork(){var done=false;var s=null;var settle=function(c){if(done){return;}done=true;out.netCode=c;try{if(s){s.destroy();}}catch(e){}attemptSpawn();};try{s=net.connect(443,"1.1.1.1");s.on("error",function(e){settle((e&&e.code)||"THROW");});s.on("connect",function(){settle("CONNECTED");});}catch(e){settle((e&&e.code)||"THROW");}setTimeout(function(){settle("TIMEOUT");},4000);}',
    'tryNetwork();',
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

type ProbeMsg = { wrote?: boolean; readCode?: string; homeCode?: string; execCode?: string; selfExecCode?: string; netCode?: string };

/**
 * Run PROBE_SRC once. `pre` is the wrapper argv (`[sandbox-exec, -p, <profile>]`) or [] for the UNCONFINED
 * control. Resolves null when the child did not complete an IPC round-trip and exit cleanly — which for
 * the control is itself a reason to report 'degraded', because an unmeasurable control certifies nothing.
 */
function runProbeChild(pre: string[], target: string, denyNet: boolean, runtime?: SeatbeltRuntime): Promise<ProbeMsg | null> {
    return new Promise<ProbeMsg | null>((res) => {
        let proc: any = null, msg: ProbeMsg | null = null, done = false, stderr = '', overall: any = null;
        let bootstrapFailure = '', spawnFailure = '';
        const finish = (v: ProbeMsg | null) => {
            if (done) return;
            done = true;
            if (overall) clearTimeout(overall);
            try { if (proc) proc.kill('SIGKILL'); } catch { /* already gone */ }
            res(v);
        };
        // Both racers are always cleaned up — an uncleared timer is what once kept a test subprocess
        // alive past its own IPC teardown.
        overall = setTimeout(() => finish(null), 25000);
        if ((overall as any).unref) (overall as any).unref();
        const node = runtime ? runtime.exe : process.execPath;
        const argv = [...pre, node, ...(runtime ? ['-r', SEATBELT_BOOTSTRAP_FILE] : []), '-e', PROBE_SRC, target, denyNet ? '1' : '0'];
        try {
            proc = spawn(argv[0], argv.slice(1),
                {
                    // Keep fd 3 as IPC and fds 4/5 as the one-shot executable handshake. Confined stderr
                    // is captured only for a bounded failure diagnostic; without it a rejected SBPL rule
                    // and an unreadable preload are indistinguishable from a generic timeout in CI.
                    stdio: runtime ? ['ignore', 'ignore', 'pipe', 'ipc', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore', 'ipc'],
                    serialization: 'advanced', timeout: 22000,
                    env: runtime ? {
                        ...process.env,
                        WORDJS_SEATBELT_BOOTSTRAP: '1', WORDJS_SEATBELT_READY_FD: '4', WORDJS_SEATBELT_RELEASE_FD: '5',
                    } : process.env,
                });
        } catch { clearTimeout(overall); finish(null); return; }
        if (runtime && proc.stderr) {
            proc.stderr.on('data', (chunk: any) => {
                stderr = (stderr + String(chunk)).slice(-1024);
            });
        }
        if (runtime) armSeatbeltBootstrap(proc, runtime).catch((error: any) => {
            bootstrapFailure = String((error && error.message) || error || 'unknown');
            // An early child exit reaches `close` after stderr has drained. Wait for it so CI records the
            // actual sandbox-exec/dyld error. A live child means the handshake itself timed out: kill it now.
            if (proc && proc.exitCode === null && proc.signalCode === null) finish(null);
        });
        proc.on('message', (m: any) => {
            if (!m || typeof m !== 'object') return;
            msg = m as ProbeMsg;
            // The ACK makes the process-denial observation causal: the child cannot attempt spawn until
            // this parent has durably observed ATTEMPTED. A later SIGABRT is therefore not a lost-message
            // race, and the same round trip also certifies production's inherited IPC channel.
            if (msg.execCode === 'ATTEMPTED') {
                try { proc.send({ wordjsProbeSpawn: true }); } catch { /* close will fail the probe */ }
            }
        });
        proc.on('error', (error: any) => { spawnFailure = String((error && error.message) || error || 'spawn error'); });
        // `close`, unlike `exit`, fires only after stdio closes. Logging at `exit` raced stderr and erased the
        // only actionable detail on the real macOS runner.
        proc.on('close', (code: number, signal: string) => {
            clearTimeout(overall);
            // On macOS, denying process-fork can make Node abort instead of emitting a recoverable spawn
            // error. The child flushes ATTEMPTED before making that sole call; the identical unconfined
            // control must subsequently report OK. Preserve the signal as evidence instead of pretending
            // it was EPERM.
            const deniedSpawnAbort = signal === 'SIGABRT' && !!msg && msg.execCode === 'ATTEMPTED';
            if (deniedSpawnAbort && msg) msg.execCode = 'SIGABRT';
            if (runtime && (code !== 0 || signal || bootstrapFailure || spawnFailure)) {
                console.warn('[Sandbox] Seatbelt probe child failed: ' + logSafe(JSON.stringify({
                    code, signal: signal || '', bootstrap: bootstrapFailure, spawn: spawnFailure, stderr,
                })));
            }
            finish(code === 0 || deniedSpawnAbort ? msg : null);
        });
    });
}

let seatbeltProbe: Promise<'active' | 'degraded' | 'unsupported' | 'disabled'> | undefined;
/**
 * Spawn a REAL child under the REAL profile, AND an unconfined control running the identical program, and
 * decide what this host actually gets.
 *
 * Memoized like every other probe in this sandbox: it costs two process spawns, its answer cannot change
 * within a process lifetime, and the launch path reads it synchronously.
 *
 * It reports 'active' ONLY when ALL of the following held at once:
 *   · sandbox-exec exists and the confined child launched through it,
 *   · the IPC round-trip completed (so the bridge survives the profile — see seatbeltArgs),
 *   · the POSITIVE CONTROL passed (a granted write really worked, so the profile is not simply broken),
 *   · the UNCONFINED CONTROL was NOT refused any of the four operations (so "refused" means the sandbox,
 *     not an offline box, a missing binary or a broken Node), and
 *   · the confined child was REFUSED BY THE KERNEL on every one of: a read outside every granted zone, a
 *     read of the home directory, a real process spawn, and an outbound connect to a raw IP.
 * Any other outcome is 'degraded' — enabled but uncertified — and the caller must fall back to the
 * existing launch. There is no path through this function that reports 'active' on a claim.
 */
function probeSeatbelt(): Promise<'active' | 'degraded' | 'unsupported' | 'disabled'> {
    if (seatbeltProbe) return seatbeltProbe;
    seatbeltProbe = (async () => {
        if (process.platform !== 'darwin') { seatbeltState = 'unsupported'; return 'unsupported'; }
        // Default-on and zero-configuration; an explicit false remains the administrative opt-out.
        let enabled = true;
        try { const s = require('../config/app').sandbox; enabled = !(s && s.useSeatbelt === false); } catch { /* config unavailable ⇒ keep default-on */ }
        if (!enabled) { seatbeltState = 'disabled'; return 'disabled'; }
        if (!fsm.existsSync(SEATBELT_BIN)) {
            seatbeltState = 'unsupported';
            console.warn('[Sandbox] Seatbelt requested but /usr/bin/sandbox-exec is absent — isolated plugins keep the existing (process separation + Node permission model + JS guards) confinement.');
            return 'unsupported';
        }

        // The probe's writable zone is a kernel-exclusive 0700 mkdtemp directory: the profile it validates
        // must be the profile shape the real launch uses, and the real launch's zones are real directories.
        // A probe that does not mirror the launch green-lights a
        // configuration that then fails to start (the #192 lesson). NOTE that on macOS this path is under
        // /var/folders/… (a symlink into /private), which is exactly why spellings() emits both forms.
        const osm = require('os');
        let dir: string;
        try { dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'wjs-seatbelt-probe-')); } catch { seatbeltState = 'degraded'; return 'degraded'; }
        const appRoot = pathm.resolve(__dirname, '..', '..');
        const target = pathm.join(dir, 'control.txt');
        const allowedTarget = pathm.join(dir, 'control-network.txt');
        const controlTarget = pathm.join(dir, 'control-unconfined.txt');
        let deniedRuntime: SeatbeltRuntime | null = null;
        let allowedRuntime: SeatbeltRuntime | null = null;
        let controlRuntime: SeatbeltRuntime | null = null;
        try {
            deniedRuntime = prepareSeatbeltRuntime(process.execPath);
            allowedRuntime = prepareSeatbeltRuntime(process.execPath);
            // The negative control must validate the complete launch apparatus too (copied executable,
            // preload and unlink handshake), not only the probe program under the original Node binary.
            controlRuntime = prepareSeatbeltRuntime(process.execPath);
        } catch {
            try { disposeSeatbeltRuntime(deniedRuntime); } catch { /* */ }
            try { disposeSeatbeltRuntime(allowedRuntime); } catch { /* */ }
            try { disposeSeatbeltRuntime(controlRuntime); } catch { /* */ }
            try { fsm.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
            seatbeltState = 'degraded';
            return 'degraded';
        }
        // The confined probe uses the same preload as production. Its directory therefore has to be one of
        // the narrow read-only code roots; an empty list prevents Node from loading the preload and measures
        // a broken launcher instead of Seatbelt. Do not grant appRoot: the probe must retain the production
        // property that only the required core code is readable.
        const probeCodeRoots = [pathm.dirname(SEATBELT_BOOTSTRAP_FILE)];
        const profile = buildSeatbeltProfile({ writableDirs: [dir], readOnlyDirs: probeCodeRoots, denyNetwork: true, appRoot, nodePath: deniedRuntime.exe, runtimeRoots: deniedRuntime.runtimeRoots });
        const allowedProfile = buildSeatbeltProfile({ writableDirs: [dir], readOnlyDirs: probeCodeRoots, denyNetwork: false, appRoot, nodePath: allowedRuntime.exe, runtimeRoots: allowedRuntime.runtimeRoots });

        // A profile that fails its own text invariants is never launched. This costs microseconds and it
        // is the only check in this file that runs on the SHIPPED profile on the SHIPPED host.
        const selfAudit = auditProfile(profile);

        let confined: ProbeMsg | null = null;
        let control: ProbeMsg | null = null;
        let allowed: ProbeMsg | null = null;
        if (selfAudit.length === 0) {
            confined = await runProbeChild([SEATBELT_BIN, ...seatbeltArgs(profile, [])], target, true, deniedRuntime);
            // The control runs UNCONFINED but through the same one-shot runtime and preload handshake. This
            // separates a broken executable-copy/bootstrap mechanism from a Seatbelt profile denial.
            control = await runProbeChild([], controlTarget, true, controlRuntime);
            // The network-granted shape must retain every non-network denial and actually permit egress.
            allowed = await runProbeChild([SEATBELT_BIN, ...seatbeltArgs(allowedProfile, [])], allowedTarget, false, allowedRuntime);
        }
        disposeSeatbeltRuntime(deniedRuntime);
        disposeSeatbeltRuntime(allowedRuntime);
        disposeSeatbeltRuntime(controlRuntime);
        // Always removed, on every exit path — a probe that leaks one temp dir per failed boot is exactly
        // the class of probe-temp leak this module must avoid.
        try { fsm.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }

        // Every clause below must hold. Written as separate named checks rather than one boolean so a
        // failure says WHICH property was not proven — a probe that only says "no" teaches nobody anything.
        const refused = (v: any) => REFUSAL_CODES.has(String(v));
        const processRefused = (v: any) => refused(v) || v === 'SIGABRT';
        const ipcOk = !!confined;                                   // the round-trip completed
        const controlRan = !!control;                               // the reference measurement exists
        // The control must NOT have been refused anything: if the box is offline, or /bin/echo is missing,
        // or /etc/passwd is unreadable for an ordinary reason, the confined run's failure proves nothing.
        const controlClean = !!control
            && control.wrote === true
            && control.readCode === 'OPEN'
            && control.homeCode === 'OPEN'
            && control.execCode === 'OK'
            // The unconfined control traverses the same preload handshake, so ENOENT proves the sole
            // executable identity was really unlinked before the probe program was released.
            && control.selfExecCode === 'ENOENT'
            && !refused(control.netCode);
        const controlOk = !!(confined && confined.wrote === true);  // granted write really worked
        const readRefused = !!(confined && refused(confined.readCode));
        const homeRefused = !!(confined && refused(confined.homeCode));
        const execRefused = !!(confined && processRefused(confined.execCode));
        const selfExecRefused = !!(confined && confined.selfExecCode === 'ENOENT');
        const netRefused = !!(confined && refused(confined.netCode));
        const allowedShape = !!allowed && allowed.wrote === true
            && refused(allowed.readCode) && refused(allowed.homeCode) && processRefused(allowed.execCode)
            && allowed.selfExecCode === 'ENOENT'
            && allowed.netCode === 'CONNECTED';
        if (selfAudit.length === 0 && ipcOk && controlRan && controlClean && controlOk
            && readRefused && homeRefused && execRefused && selfExecRefused && netRefused && allowedShape) {
            seatbeltState = 'active';
            console.log('[Sandbox] macOS Seatbelt confinement ACTIVE for both network policies: deny-by-default reads, scoped writes, no process creation or cross-process reads; only outbound network changes with the grant.');
            return 'active';
        }
        seatbeltState = 'degraded';
        console.warn('[Sandbox] macOS Seatbelt probe did NOT certify confinement on this host — isolated plugins keep the existing (process separation + Node permission model + JS guards) floor. '
            + `selfAudit=${selfAudit.length === 0 ? 'clean' : logSafe(selfAudit.length) + ' violation(s)'} `
            + `control=${controlClean ? 'clean' : controlRan ? 'UNUSABLE' : 'FAILED'} `
            + `ipc=${ipcOk ? 'ok' : 'FAILED'} writeControl=${controlOk ? 'ok' : 'FAILED'} `
            + `outOfZoneRead=${readRefused ? 'refused' : logSafe((confined && confined.readCode) || 'unknown')} `
            + `homeRead=${homeRefused ? 'refused' : logSafe((confined && confined.homeCode) || 'unknown')} `
            + `spawn=${execRefused ? 'refused' : logSafe((confined && confined.execCode) || 'unknown')} `
            + `selfExec=${selfExecRefused ? 'refused' : logSafe((confined && confined.selfExecCode) || 'unknown')} `
            + `rawIpConnect=${netRefused ? 'refused' : logSafe((confined && confined.netCode) || 'unknown')} `
            + `networkGrantedShape=${allowedShape ? 'ok' : 'FAILED'}`);
        return 'degraded';
    })();
    return seatbeltProbe;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// MEMORY CAP — what macOS can actually enforce PREVENTIVELY, measured rather than assumed.
//
// THE HONEST ANSWER FIRST: nothing, without privilege or a native helper. Windows has a Job Object with
// JOB_OBJECT_LIMIT_PROCESS_MEMORY, so the kernel FAILS the commit that would cross the budget. Linux has
// cgroup v2 `memory.max`, so the kernel OOM-kills only the offending child at the instant it crosses.
// macOS has neither reachable from an unprivileged parent:
//   · RLIMIT_AS — Darwin defines RLIMIT_AS as an ALIAS of RLIMIT_RSS, and enforces NEITHER. `ulimit -v`
//     is accepted by the shell and then bounds nothing. This is the dangerous one, because
//     plugin-isolate.ts's probeOsMemoryCap() only checks that Node still BOOTS under the cap — which an
//     unenforced cap trivially satisfies — and then logs "kernel memory cap active: RLIMIT_AS N MB". A
//     cap that is announced and not enforced is precisely the "looks secure but isn't" state this whole
//     sandbox is built to avoid, so this probe exists to catch it.
//   · RLIMIT_DATA (`ulimit -d`) — bounds the legacy brk heap only; V8 and malloc use mmap, so it does not
//     bind either.
//   · memorystatus_control() / jetsam per-process limits — the REAL preventive primitive on Darwin, and
//     the one iOS uses. It is private API and requires root or the com.apple.private.memorystatus
//     entitlement, so it is unreachable from a Node parent and would require a native helper.
//   · launchd HardResourceLimits — needs a plist plus launchctl (a helper by any definition) and sets the
//     same Darwin rlimits that are not enforced.
//   · SBPL has no memory operation at all, so the profile above cannot help.
//
// RESIDUAL EXPOSURE, STATED PLAINLY: on macOS the resident cap for an isolated plugin child is the
// REACTIVE `ps -o rss=` poll in plugin-isolate.ts (250 ms). A plugin that balloons off-heap faster than
// one poll window can spike host memory before the kill lands. That is a real asymmetry against Windows
// and Linux, and it stays open. It is not closable from this file.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The address-space limit the enforcement probe applies, in KiB.
 *
 * 256 MiB is chosen to be IMPOSSIBLE, not tight: a modern Node reserves a ~4 GiB pointer-compression cage
 * before it runs a line of JavaScript, so on any kernel that actually enforces RLIMIT_AS the runtime
 * cannot start at all under this limit. That inverts the usual difficulty — instead of trying to prove a
 * cap binds (which needs an allocation race), the probe asks a question with only one confounder-free
 * answer: if Node BOOTS under a limit it cannot possibly fit inside, the limit was never enforced.
 */
const RLIMIT_PROBE_KB = 256 * 1024;

/**
 * 'enforced' — `ulimit -v` really bounds address space here (Linux).
 * 'inert'    — the shell accepted it and the kernel ignored it (expected on Darwin). Any "kernel memory
 *              cap active" message on such a host is FALSE and must not be printed.
 * 'unknown'  — could not be measured (no POSIX shell, or the unconstrained control itself failed, which
 *              means the measurement apparatus is broken and its answer would be meaningless).
 */
type MemCapEnforcement = 'enforced' | 'inert' | 'unknown';
let memCapState: MemCapEnforcement | 'unmeasured' = 'unmeasured';
function getMacosMemoryCapState(): MemCapEnforcement | 'unmeasured' { return memCapState; }

/** Run one `sh -c` wrapper around a trivial Node program; resolve true when Node exited 0. */
function bootsUnder(ulimitPrefix: string): Promise<boolean> {
    return new Promise<boolean>((res) => {
        let c: any = null, done = false;
        const finish = (v: boolean) => { if (done) return; done = true; try { if (c) c.kill('SIGKILL'); } catch { /* gone */ } res(v); };
        const t = setTimeout(() => finish(false), 30000);
        if ((t as any).unref) (t as any).unref();
        try {
            // `$0` is a label and `$@` is the real argv, exactly as plugin-isolate.ts's cap wrapper builds
            // it — the measurement has to run through the SAME shape it is measuring, or it measures
            // something else.
            c = spawn('sh', ['-c', `${ulimitPrefix}exec "$@"`, 'wjs-memcap-probe', process.execPath, '-e', 'process.exit(0)'],
                { stdio: 'ignore', timeout: 28000 });
        } catch { clearTimeout(t); finish(false); return; }
        c.on('error', () => { clearTimeout(t); finish(false); });
        c.on('exit', (code: number) => { clearTimeout(t); finish(code === 0); });
    });
}

let memCapProbe: Promise<MemCapEnforcement> | undefined;
/**
 * MEASURE whether the `ulimit -v` memory cap the launch path applies is enforced on this host.
 *
 * PROBE-GATED AND CONTROL-NEGATIVE, like every other probe here: the UNCONSTRAINED run must succeed first.
 * Without that control, "Node failed to start under the cap" could equally mean the shell is missing, the
 * Node binary is unreadable, or the box is out of memory — and each of those would be reported as a
 * working cap, which is the failure mode this file exists to refuse.
 *
 * Memoized: it costs two spawns and cannot change within a process lifetime.
 *
 * IT DOES NOT CHANGE BEHAVIOUR ON ITS OWN. plugin-isolate.ts owns the launch and owns the log line; this
 * function only makes the truth available to it. See the handoff note for the exact change required there.
 */
function probeMacosMemoryCapEnforcement(): Promise<MemCapEnforcement> {
    if (memCapProbe) return memCapProbe;
    memCapProbe = (async () => {
        if (process.platform === 'win32') { memCapState = 'unknown'; return 'unknown'; }   // no POSIX sh / rlimit
        const controlBooted = await bootsUnder('');
        if (!controlBooted) { memCapState = 'unknown'; return 'unknown'; }                  // apparatus broken ⇒ no claim
        const cappedBooted = await bootsUnder(`ulimit -v ${RLIMIT_PROBE_KB} 2>/dev/null; `);
        // Booting under an impossible limit can only mean the limit was not applied.
        const verdict: MemCapEnforcement = cappedBooted ? 'inert' : 'enforced';
        memCapState = verdict;
        if (verdict === 'inert') {
            console.warn('[Sandbox] RLIMIT_AS (`ulimit -v`) is NOT enforced on this host — Darwin aliases it to RLIMIT_RSS and enforces neither. '
                + 'The isolated-plugin address-space cap is therefore decorative here; the resident cap is the reactive RSS poll alone, '
                + 'and there is no preventive per-child memory cap on macOS without a privileged native helper.');
        }
        return verdict;
    })();
    return memCapProbe;
}

module.exports = {
    SEATBELT_BIN,
    SEATBELT_BOOTSTRAP_FILE,
    buildSeatbeltProfile,
    seatbeltArgs,
    probeSeatbelt,
    getSeatbeltState,
    // The macOS memory-cap MEASUREMENT (see the block comment above). Exported so plugin-isolate.ts can
    // stop announcing a cap that Darwin does not enforce; it changes nothing by itself.
    probeMacosMemoryCapEnforcement,
    getMacosMemoryCapState,
    RLIMIT_PROBE_KB,
    // Exported for the unit test only: the SBPL escaper is the injection boundary of this module, and
    // auditProfile is the gate that reads the emitted TEXT back rather than trusting the builder.
    sbplPath,
    auditProfile,
    prepareSeatbeltRuntime,
    disposeSeatbeltRuntime,
    armSeatbeltBootstrap,
    __probeSrc: PROBE_SRC,
};
