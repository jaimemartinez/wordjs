/**
 * WordJS - Linux ZERO-CONFIGURATION kernel confinement for the isolated plugin child (Landlock + seccomp)
 *
 * THE GAP THIS CLOSES, AND WHY LINUX OF ALL PLATFORMS HAD ONE.
 * macOS confines a plugin with Seatbelt (core/sandbox-macos.ts) and Windows with a zero-capability
 * AppContainer (core/sandbox-windows.ts). On both, a plugin child is confined by the KERNEL with NOTHING
 * configured on the host. Linux - the platform with by far the richest sandboxing toolbox - was the
 * outlier, because its former kernel floor depended on a separately installed namespace launcher and
 * unprivileged user namespaces.
 * Stock hardened distributions may refuse those namespaces, and requiring a package plus a sysctl is
 * not zero-configuration. This module is now the Linux implementation, not a fallback beneath another
 * launcher.
 *
 * WHAT DOES THE CONFINING. Two kernel features need neither privileges nor namespaces:
 *   . Landlock - an LSM designed for unprivileged self-sandboxing. Confines the FILESYSTEM: writes are
 *     scoped to exactly io-guard's per-plugin zones, while reads cover only the plugin, its private
 *     storage, dependencies and the small set of runtime/CA/locale paths Node actually needs. As a bonus its
 *     ptrace hook stops the plugin reading /proc/<host pid>/environ, i.e. the host's own secrets - the
 *     hole an absent pid namespace would otherwise leave wide open to any same-uid process.
 *   . seccomp-bpf - always refuses kernel-control, cross-process, System V IPC, mount, keyring,
 *     io_uring and host-signalling syscalls. Without the network grant it refuses every new socket;
 *     with the grant it permits only AF_INET/AF_INET6 client sockets. The already-open IPC channel does
 *     not need socket() or socketpair() and remains usable in either policy.
 * Both are inherited across execve and by threads created afterwards, so restricting a single-threaded
 * Perl process and then exec'ing Node confines the whole Node process, libuv's threadpool included.
 *
 * WHY THE MECHANISM IS A PERL SCRIPT. Node cannot make a raw syscall (no node:ffi, internalBinding is
 * not exposed), and shipping a compiled helper would put a per-architecture binary inside the very
 * mechanism that confines untrusted code. `perl-base` is `Essential: yes` on Debian and Ubuntu, and
 * perl's syscall() is a core builtin, so the vehicle is auditable TEXT with no build step and no
 * artefact to trust: backend/scripts/landlock-seccomp-shim.pl. The PID the caller spawned IS Node's -
 * perl exec()s it, there is no intermediate process, so the resident-memory poll watches Node directly.
 *
 * CERTIFIED BY CI ON REAL LINUX, NOT BY THIS FILE'S TESTS. The kernel behaviour was measured on GitHub
 * runners, control vs confined, same binary and same script, unprivileged uid 1001:
 *   ubuntu-latest  Ubuntu 24.04.4, kernel 6.17, landlock ABI 7, apparmor_restrict_unprivileged_userns=1
 *     control  {"writeInZone":"OK","writeOutside":"OK",    "readSystem":"OK","tcp":"CONNECTED"}
 *     confined {"writeInZone":"OK","writeOutside":"EACCES","readSystem":"OK","tcp":"EACCES"}
 *     NoNewPrivs: 1   Seccomp: 2
 *   ubuntu-22.04   kernel 6.8, landlock ABI 4 - identical result.
 * backend/src/tests/sandbox-linux-shim.test.ts pins the parts that are testable ANYWHERE - argv
 * construction, path rejection, the exit-code contract, the arch table - and says so explicitly. It
 * cannot and does not certify the kernel.
 *
 * PROBE-GATED, exactly like its two peers and for the reason written down in plugin-isolate.ts:
 * probeLinuxZeroConf() spawns a REAL child under the REAL shim and reports 'active' ONLY when that child
 * was ACTUALLY refused what it must be refused, each refusal checked against an UNCONFINED CONTROL that
 * was NOT refused, with a positive control that must succeed and a full fork-IPC round-trip that must
 * complete. Reporting confinement that is not there is the state this whole design exists to avoid.
 */

const fsl = require('fs');
const pathl = require('path');
const osl = require('os');
const { spawn: spawnl } = require('child_process');

/**
 * The Perl interpreter, an absolute literal and never resolved through PATH.
 *
 * Same reasoning as SEATBELT_BIN in the macOS module: this argv IS a security boundary, and a
 * PATH-resolved `perl` is one PATH entry away from being a no-op wrapper that execs the child
 * unconfined. `perl-base` is Essential on Debian/Ubuntu and installs exactly here; a host where this
 * file is absent reports 'unsupported' rather than searching for a substitute.
 */
const PERL_BIN = '/usr/bin/perl';

/**
 * The shim itself, resolved relative to THIS module so it works from src/ under ts-node and from dist/
 * after a build (both are two levels below backend/, so both resolve to backend/scripts/).
 */
const SHIM_PATH = pathl.resolve(__dirname, '..', '..', 'scripts', 'landlock-seccomp-shim.pl');

/**
 * The shim's exit-code contract, mirrored here so the two cannot drift silently and so the probe can
 * tell "this kernel CANNOT" apart from "this kernel could and something failed" - which demand opposite
 * reports ('unsupported' vs 'degraded') and opposite operator actions.
 *
 * The shim NEVER exec's the target unless every confinement step took effect, so any of these codes
 * means nothing ran. That property is not assumed: it was demonstrated by bending the shim's landlock
 * syscall numbers to nonexistent ones and confirming the target never printed its marker (exit 78), and
 * the same for an unknown architecture. The version of the shim committed BEFORE this module failed
 * OPEN on exactly that path - it printed `landlock=off`, exec'd the child bare, wrote a file outside the
 * zone and exited 0.
 */
const SHIM_EXIT = {
    /** No Landlock on this kernel, or an architecture with no verified syscall table. Nothing exec'd. */
    UNSUPPORTED: 78,
    /** The floor could have applied here and a step failed (bad argv, a zone that would not grant, seccomp refused). Nothing exec'd. */
    FAIL: 79,
    /** Confinement applied; the target could not be exec'd. */
    EXEC: 127,
} as const;

/** Strip line breaks before a value reaches a log line - the same shape as plugin-isolate's logSafe(). */
function logSafe(v: any): string {
    return String(v == null ? '' : v).replace(/\n/g, '').replace(/\r/g, '');
}

/**
 * Validate one path destined for the shim's argv, or return null when it cannot be passed SAFELY.
 *
 * REJECT, never repair - the same discipline as sbplPath() in the macOS module, and the failure
 * direction is the same: a dropped zone surfaces as a plugin write failing loudly, while a mangled one
 * would surface as nothing at all. What is rejected and why:
 *   . a non-absolute path. Landlock matches a path it can OPEN, and a relative one would resolve against
 *     whatever cwd the shim happens to inherit - not something a confinement boundary may depend on.
 *     This ALSO makes the option-injection case impossible: the shim reads `--read-root=` prefixed
 *     tokens as options, and nothing that must start with `/` can ever be mistaken for one.
 *   . `/` itself. A write zone of `/` makes the whole filesystem writable - a typo becoming a total loss
 *     of confinement.
 *   . control characters, including NUL and newline. NUL cannot cross execve at all (Node throws), a
 *     newline would break the single-line `SHIM:` diagnostic the caller greps, and neither is ever
 *     legitimate in one of io-guard's zones. Reject rather than reason about them.
 * There is no quoting/escaping hazard here the way there is in SBPL: argv is an ARRAY across
 * posix_spawn, never a string a shell re-parses. The rejections above are about MEANING, not quoting.
 */
function shimPath(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    // Strip a single trailing separator: Landlock wants the directory itself, and a caller that built
    // "…/uploads/" means the same zone as "…/uploads".
    const p = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (p.length === 0) return null;
    if (p === '/') return null;
    if (!p.startsWith('/')) return null;
    if (hasControlChar(p)) return null;
    return p;
}

/**
 * Written as a code-point scan rather than a regex, for the same reason sandbox-windows.ts scans instead
 * of matching: a character class covering NUL/newline/DEL is a literal control character in SOURCE, which
 * the lint bans (no-control-regex) for reasons of its own - and which a text editor silently mangles.
 */
function hasControlChar(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
}

/** De-duplicate while preserving order: a repeated zone is harmless but makes the argv lie about its size. */
function uniq(list: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of list) { if (!seen.has(v)) { seen.add(v); out.push(v); } }
    return out;
}

export type ShimArgsOptions = {
    /**
     * The zones the child may WRITE. These ARE io-guard's write zones - the caller passes the SAME array
     * plugin-isolate.ts already builds for Node's `--allow-fs-write` and
     * for the Seatbelt/AppContainer profiles (the plugin's own dir plus its private data/log/tmp). They are
     * deliberately NOT restated in this module: four independent lists of "what a plugin may write"
     * drift, and the drift is silent, and it is always the loosest one that decides. One declaration,
     * four consumers.
     */
    zone: string | string[];
    /**
     * True for a plugin WITHOUT the admin `network` grant - the native no-egress policy. False for a
     * network-granted plugin, whose egress stays bounded by the in-process egress guard.
     */
    denyNetwork?: boolean;
    /**
     * Trees the child may READ beyond the OS ones the shim grants itself. These are the narrow core,
     * dependency, plugin and private-storage roots, plus the Node runtime when it lives elsewhere -
     * an nvm or asdf install under $HOME is the common case, and it matters because the shim
     * deliberately does NOT grant /home (see its header: the read list is "the OS", not "the operator's
     * data"). A read root that will not grant is FATAL in the shim rather than skipped: a required core,
     * dependency, plugin or runtime root that cannot be read means the child cannot load.
     */
    readRoot?: string | string[];
    /** Literal executable(s) needed for the initial launch. Read roots never imply FS_EXECUTE. */
    execRoot?: string | string[];
    /** The command to run once confined - normally [nodePath, ...execArgv, worker, cfg]. */
    nodeArgs?: string[];
};

/**
 * Build the argv for the shim, WITHOUT the interpreter itself - prepend PERL_BIN, exactly as the macOS
 * path prepends SEATBELT_BIN to seatbeltArgs(). The caller therefore decides where this sits, which lets it compose in front
 * of the `sh -c 'ulimit …; exec "$@"'` memory-cap wrapper the same way the other two do.
 *
 * Shape: [SHIM_PATH, --read-root=…, …, <zone>, …, <0|1>, '--', …nodeArgs]
 * The network flag is the LAST token before `--` and must be exactly 0 or 1, which is what makes the
 * variable-length zone list unambiguous - and what keeps the single-zone spelling the committed CI
 * measurement used valid byte for byte.
 *
 * THE ASSUMPTION THIS RESTS ON, STATED SO THE PROBE CAN CHECK IT: perl applies the confinement to its
 * OWN process and then execve()s the target. It does not fork, does not interpose, and does not touch
 * the descriptor table - so fd 3, the AF_UNIX socketpair Node passes as NODE_CHANNEL_FD, survives into
 * the exec'd node, which attaches its IPC channel exactly as a forked child would. That is the same
 * property the memory-cap wrapper already depends on. It is not assumed here: the
 * probe requires a full process.send() round-trip through this exact argv shape before this layer is
 * allowed to report 'active'.
 *
 * A zone or read root this function REJECTS is dropped from the argv, never repaired. If every zone is
 * rejected the result carries none, and the shim then fails closed with exit 79 rather than launching a
 * child with a confinement nobody can describe.
 */
function shimArgs(opts: ShimArgsOptions): string[] {
    const zones = uniq((Array.isArray(opts && opts.zone) ? (opts.zone as string[]) : [(opts && opts.zone) as string])
        .map((z) => shimPath(z))
        .filter((z): z is string => z !== null));
    const roots = uniq((Array.isArray(opts && opts.readRoot) ? (opts.readRoot as string[]) : [(opts && opts.readRoot) as string])
        .map((r) => shimPath(r))
        .filter((r): r is string => r !== null));
    const execRoots = uniq((Array.isArray(opts && opts.execRoot) ? (opts.execRoot as string[]) : [(opts && opts.execRoot) as string])
        .map((r) => shimPath(r))
        .filter((r): r is string => r !== null));
    const nodeArgs = Array.isArray(opts && opts.nodeArgs) ? (opts.nodeArgs as string[]) : [];
    return [
        SHIM_PATH,
        ...roots.map((r) => `--read-root=${r}`),
        ...execRoots.map((r) => `--exec-root=${r}`),
        ...zones,
        opts && opts.denyNetwork ? '1' : '0',
        '--',
        ...nodeArgs,
    ];
}

/**
 * Cached per-process outcome, in the SAME vocabulary the other two platform modules and
 * sandboxPlatformState use:
 *   'unsupported' = not Linux, or perl/the shim/Landlock is absent - a host that CANNOT have this floor
 *   'disabled'    = the operator turned the kernel floor off (sandbox.useKernelHardening=false)
 *   'active'      = a real child was really refused, against an unconfined control, with the positive
 *                   control passing and the IPC round-trip completing
 *   'degraded'    = enabled and possible here, but the probe could not certify it. The dangerous
 *                   "looks secure but isn't" state, so it is a distinct value and never folded into
 *                   'unsupported'.
 */
type ZeroConfState = 'unknown' | 'unsupported' | 'disabled' | 'active' | 'degraded';
let zeroConfState: ZeroConfState = 'unknown';
function getLinuxZeroConfState(): ZeroConfState { return zeroConfState; }
/** One human-readable sentence for admin GET /health/details, written where the verdict is decided. */
let zeroConfNote = 'the Linux zero-config confinement probe has not run yet (it fires on the first isolated plugin load)';
function getLinuxZeroConfNote(): string { return zeroConfNote; }

/**
 * The probe child, as one `node -e` program. ASCII only, no regular expressions and no backslashes, so
 * it survives every quoting layer between here and the kernel unchanged - the same constraint the macOS
 * probe child is written under.
 *
 * argv[1] = a path INSIDE a granted write zone      (the POSITIVE control)
 * argv[2] = a path OUTSIDE every granted write zone (the refusal under test)
 * argv[3] = '1' when the network must be denied
 *
 * It reports the following facts over the IPC channel and exits 0:
 *   wrote      - a write+read back inside the granted zone SUCCEEDED. THE POSITIVE CONTROL. Without it a
 *                confinement so broken that everything fails would satisfy every "was it refused?" check
 *                and be reported as a working sandbox.
 *   readSystem - /etc/hostname was readable. The SECOND positive control, for the read direction: the
 *                shim grants the OS trees, and a child that cannot read /etc is a child that cannot
 *                resolve anything, i.e. a confinement no plugin could run under.
 *   exactRead  - one literal caller-granted file was readable. This is the source-worker tsconfig shape.
 *   siblingCode- a sibling of that literal file stayed unreadable, proving the file grant did not widen
 *                into authority over its containing directory.
 *   readCode   - the error code from reading OUTSIDE every granted tree. Must be a kernel refusal.
 *   outCode    - the error code from writing OUTSIDE every zone. Must be a kernel refusal.
 *   signalCode - process.kill(self, 0). This harmless syscall succeeds in the control and must be
 *                refused by the always-on dangerous-syscall filter in both confined launch shapes.
 *   processCode- starting a second Node process succeeds in the control and must be refused. The
 *                worker still starts V8/libuv threads, so this distinguishes process clones from threads.
 *   netCode    - the error code from connecting to a RAW IP (1.1.1.1:443 - no DNS, so a denied name
 *                lookup can never be mistaken for a denied connect).
 *   sent       - implicit: that the message arrived AT ALL is the fork-IPC round-trip.
 */
const PROBE_SRC = [
    'var fs=require("fs");var net=require("net");var cp=require("child_process");',
    'var out={wrote:false,readSystem:false,exactRead:false,siblingCode:"NONE",readCode:"NONE",outCode:"NONE",signalCode:"NONE",processCode:"NONE",execCode:"NONE",capsCode:"NONE",netCode:"SKIP",unixCode:"SKIP"};',
    'var inside=process.argv[1];var outside=process.argv[2];var denyNet=process.argv[3]==="1";var unixPath=process.argv[4];var exactFile=process.argv[5];var siblingFile=process.argv[6];',
    'try{fs.writeFileSync(inside,"wjs");out.wrote=fs.readFileSync(inside,"utf8")==="wjs";}catch(e){out.wrote=false;out.writeCode=(e&&e.code)||"THROW";}',
    'try{fs.readFileSync(process.execPath);out.readSystem=true;}catch(e){out.readSystem=false;}',
    'try{out.exactRead=fs.readFileSync(exactFile,"utf8")==="exact";}catch(e){out.exactRead=false;}',
    'try{fs.readFileSync(siblingFile);out.siblingCode="OPEN";}catch(e){out.siblingCode=(e&&e.code)||"THROW";}',
    'try{fs.readFileSync(outside);out.readCode="OPEN";}catch(e){out.readCode=(e&&e.code)||"THROW";}',
    'try{fs.writeFileSync(outside,"wjs");out.outCode="OPEN";}catch(e){out.outCode=(e&&e.code)||"THROW";}',
    'try{process.kill(process.ppid,0);out.signalCode="OPEN";}catch(e){out.signalCode=(e&&e.code)||"THROW";}',
    'try{var q=cp.spawnSync(process.execPath,["-e","process.exit(0)"]);out.processCode=q.error?((q.error&&q.error.code)||"THROW"):(q.status===0?"OPEN":"FAIL");}catch(e){out.processCode=(e&&e.code)||"THROW";}',
    'try{var payload=inside+".sh";fs.writeFileSync(payload,"#!/bin/sh\\nexit 0\\n");fs.chmodSync(payload,448);var x=cp.spawnSync(payload,[],{encoding:"utf8"});out.execCode=x.error?((x.error&&x.error.code)||"THROW"):(x.status===0?"OPEN":"FAIL");}catch(e){out.execCode=(e&&e.code)||"THROW";}',
    'try{var st=fs.readFileSync("/proc/self/status","utf8");var bad=[];for(var k of ["CapInh","CapPrm","CapEff","CapAmb"]){var m=st.match(new RegExp("^"+k+":\\\\s*([0-9a-f]+)","mi"));if(!m||!/^0+$/.test(m[1]))bad.push(k);}if(process.geteuid&&process.geteuid()===0){var b=st.match(/^CapBnd:\\s*([0-9a-f]+)/mi);if(!b||!/^0+$/.test(b[1]))bad.push("CapBnd");}out.capsCode=bad.length?"OPEN:"+bad.join(","):"ZERO";}catch(e){out.capsCode=(e&&e.code)||"THROW";}',
    'function finish(){try{process.send(out,function(){process.exit(0);});}catch(e){process.exit(5);}}',
    'setTimeout(function(){process.exit(4);},12000);',
    'if(!process.send){process.exit(3);}',
    '{',
    'var pending=2;var done={};var settle=function(k,c,s){if(done[k])return;done[k]=true;out[k]=c;try{if(s)s.destroy();}catch(e){}if(--pending===0)finish();};',
    'try{var s=net.connect(443,"1.1.1.1");s.on("error",function(e){settle("netCode",(e&&e.code)||"THROW",s);});s.on("connect",function(){settle("netCode","CONNECTED",s);});setTimeout(function(){settle("netCode","TIMEOUT",s);},4000);}catch(e){settle("netCode",(e&&e.code)||"THROW",null);}',
    'try{var u=net.connect(unixPath);u.on("error",function(e){settle("unixCode",(e&&e.code)||"THROW",u);});u.on("connect",function(){settle("unixCode","CONNECTED",u);});setTimeout(function(){settle("unixCode","TIMEOUT",u);},4000);}catch(e){settle("unixCode",(e&&e.code)||"THROW",null);}',
    '}',
].join('');

/**
 * Codes that prove the KERNEL refused the operation, as opposed to it failing for an ordinary reason.
 *
 * This distinction is the whole probe. A connect to 1.1.1.1 from an air-gapped host fails too - with
 * ENETUNREACH/EHOSTUNREACH/ETIMEDOUT, after a delay - and a write outside the zone fails on a read-only
 * mount with EROFS. Accepting "it failed" would let an unplugged network cable certify a sandbox that is
 * not there. A seccomp ERRNO return and a Landlock denial both surface as EACCES (EPERM on some paths),
 * so ONLY those two are accepted, and an offline host reports 'degraded' - an under-claim, which is the
 * only direction this may be wrong in. The unconfined control below closes the other half of the same
 * hole: it must NOT be refused, or the refusal proves nothing.
 */
const REFUSAL_CODES = new Set(['EPERM', 'EACCES']);

type ProbeMsg = { wrote?: boolean; readSystem?: boolean; exactRead?: boolean; siblingCode?: string; readCode?: string; outCode?: string; signalCode?: string; processCode?: string; execCode?: string; capsCode?: string; netCode?: string; unixCode?: string };
type ProbeRun = { msg: ProbeMsg | null; code: number | null; stderr: string };

/**
 * Run the probe child once and collect its message, its exit code and its stderr.
 *
 * `pre` is prepended to the argv, so the SAME function runs the control (pre = []) and the confined leg
 * (pre = [PERL_BIN, ...shimArgs(...)]). One function, because a control that does not mirror the
 * confined run is not a control - it is a second experiment whose difference from the first is exactly
 * the thing nobody measured.
 */
function runProbeChild(pre: string[], inside: string, outside: string, denyNet: boolean, unixPath: string, exactFile: string, siblingFile: string, timeoutMs: number): Promise<ProbeRun> {
    return new Promise<ProbeRun>((res) => {
        // ONE argv, built once, with `pre` in front. The control leg passes pre = [] and therefore runs
        // the byte-identical tail; that is what makes it a control rather than a second experiment.
        const full = [...pre, process.execPath, '-e', PROBE_SRC, inside, outside, denyNet ? '1' : '0', unixPath, exactFile, siblingFile];
        const exe = full[0];
        const args = full.slice(1);
        let proc: any = null, msg: ProbeMsg | null = null, stderr = '', done = false;
        const finish = (code: number | null) => {
            if (done) return;
            done = true;
            try { if (proc) proc.kill('SIGKILL'); } catch { /* already gone */ }
            res({ msg, code, stderr });
        };
        // Both racers are always cleaned up - an uncleared timer is what once kept a test subprocess
        // alive past its own IPC teardown.
        const overall = setTimeout(() => finish(null), timeoutMs);
        if ((overall as any).unref) (overall as any).unref();
        try {
            proc = spawnl(exe, args, {
                stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
                serialization: 'advanced',
                timeout: Math.max(1000, timeoutMs - 3000),
            });
        } catch { clearTimeout(overall); finish(null); return; }
        try { proc.stderr.on('data', (d: any) => { if (stderr.length < 4096) stderr += String(d); }); } catch { /* */ }
        proc.on('message', (m: any) => { if (m && typeof m === 'object') msg = m as ProbeMsg; });
        proc.on('error', () => { clearTimeout(overall); finish(null); });   // ENOENT / not executable
        proc.on('exit', (code: number | null) => { clearTimeout(overall); finish(code); });
    });
}

/** Read the sandbox config block without ever letting a missing or broken config throw into a launch path. */
function sandboxConfig(): any {
    try { return require('../config/app').sandbox || {}; } catch { return {}; }
}

let zeroConfProbe: Promise<'active' | 'degraded' | 'unsupported' | 'disabled'> | undefined;
/**
 * Spawn a REAL child under the REAL shim and decide what this host actually gets.
 *
 * Memoized like every other probe in this sandbox: it costs two process spawns, its answer cannot change
 * within a process lifetime, and the launch path reads the resolved state synchronously.
 *
 * IT REPORTS 'active' ONLY WHEN ALL OF THE FOLLOWING HELD AT ONCE:
 *   . perl and the shim script exist,
 *   . the UNCONFINED CONTROL was NOT refused - it wrote outside the zone AND (when denying the network)
 *     really connected to 1.1.1.1. Checked FIRST, because if the control is already refused then every
 *     "refused" verdict below proves nothing and the whole run is uninterpretable. This is the
 *     control-negative discipline the sandbox-escape harness had to grow, in the same shape,
 *   . the confined child's IPC round-trip completed - a confinement the host cannot talk to is not
 *     shippable, and this is also the only thing that proves fd 3 survives perl's execve,
 *   . the POSITIVE CONTROLS passed: a granted write really worked AND /etc was really readable, so a
 *     confinement that is simply broken cannot masquerade as a working one,
 *   . a write OUTSIDE every zone was refused by the kernel, and
 *   . with denyNetwork, a connect to a raw IP was refused by the kernel.
 * Anything else is 'degraded' (or 'unsupported' when the shim says this kernel cannot), and the caller
 * takes the launch it took before this layer existed. There is no path through this function that
 * reports 'active' on a claim, and none that retries with a looser confinement until the probe passes -
 * quietly widening a sandbox until its probe goes green is how a probe stops meaning anything.
 */
function probeLinuxZeroConf(): Promise<'active' | 'degraded' | 'unsupported' | 'disabled'> {
    if (zeroConfProbe) return zeroConfProbe;
    zeroConfProbe = (async () => {
        if (process.platform !== 'linux') {
            zeroConfState = 'unsupported';
            zeroConfNote = 'Landlock and seccomp-bpf are Linux kernel features';
            return 'unsupported';
        }
        // The operator's kernel-floor switch. There is no separate default-off flag: this layer costs the
        // host nothing to probe (it spawns two processes and throws them away, mutating nothing - unlike
        // the AppContainer probe, which registers a profile and edits ACLs), so it follows the common
        // kernel-floor switch. An operator who turns that switch off gets no kernel floor.
        const cfg = sandboxConfig();
        if (cfg.useKernelHardening === false) {
            zeroConfState = 'disabled';
            zeroConfNote = 'the Linux kernel floor is switched off in config (sandbox.useKernelHardening=false)';
            return 'disabled';
        }
        if (!fsl.existsSync(PERL_BIN)) {
            zeroConfState = 'unsupported';
            zeroConfNote = `${PERL_BIN} is absent, so the Landlock/seccomp shim cannot run (perl-base is Essential on supported Debian/Ubuntu installs)`;
            console.warn('[Sandbox] Linux zero-config confinement unavailable: /usr/bin/perl is absent. Isolated plugins keep the Node permission model and the JS guards.');
            return 'unsupported';
        }
        if (!fsl.existsSync(SHIM_PATH)) {
            zeroConfState = 'unsupported';
            zeroConfNote = 'backend/scripts/landlock-seccomp-shim.pl is missing from this install';
            console.warn(`[Sandbox] Linux zero-config confinement unavailable: the shim script is missing at ${logSafe(SHIM_PATH)}.`);
            return 'unsupported';
        }

        // The probe's zones are real directories under a kernel-exclusive 0700 mkdtemp name, because the
        // profile a probe validates must be the SHAPE the real launch uses - the #192 lesson in
        // plugin-isolate.ts: a probe that does not mirror the launch green-lights a launch that fails.
        let probeRoot: string | null = null;
        let zone: string;
        let coreRoot: string;
        let unixServer: any = null;
        try {
            probeRoot = fsl.mkdtempSync(pathl.join(osl.tmpdir(), 'wjs-zeroconf-root-'));
            zone = pathl.join(probeRoot, 'plugins', 'probe');
            coreRoot = pathl.join(probeRoot, 'dist', 'core');
            fsl.mkdirSync(zone, { recursive: true });
            fsl.mkdirSync(coreRoot, { recursive: true });
        } catch {
            // Whichever of the two got created is removed: a probe that leaks a temp dir per failed boot
            // would make a network-policy probe report a false degraded result.
            for (const d of [probeRoot]) {
                try { if (d) fsl.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
            }
            zeroConfState = 'degraded';
            zeroConfNote = 'the probe could not create its temporary zones, so the layer could not be certified here';
            return 'degraded';
        }
        const inside = pathl.join(zone as string, 'control.txt');
        const outside = pathl.join(probeRoot as string, 'wordjs-config.json');
        const unixPath = pathl.join(probeRoot as string, 'host.sock');
        const exactDir = pathl.join(probeRoot as string, 'config');
        const exactFile = pathl.join(exactDir, 'tsconfig.json');
        const siblingFile = pathl.join(exactDir, 'host-secret.json');
        fsl.mkdirSync(exactDir, { recursive: true });
        fsl.writeFileSync(outside, 'probe-secret');
        fsl.writeFileSync(exactFile, 'exact');
        fsl.writeFileSync(siblingFile, 'sibling-secret');
        // The Node runtime prefix is a read root in its own right and NOT an optional nicety: the shim
        // deliberately does not grant /home, so an nvm/asdf/fnm install (…/versions/node/vX/bin/node)
        // would be unreadable and the child would never boot. `dirname(dirname(execPath))` is that
        // prefix; for a /usr/bin/node it lands on /usr, which the shim grants anyway, so the entry is
        // harmless where it is redundant and load-bearing where it is not.
        const nodePrefix = pathl.dirname(pathl.dirname(process.execPath));

        try {
            unixServer = require('net').createServer((socket: any) => socket.end());
            await new Promise<void>((resolve, reject) => {
                unixServer.once('error', reject);
                unixServer.listen(unixPath, resolve);
            });
            // ── 1. THE UNCONFINED CONTROL, FIRST ────────────────────────────────────────────────────
            // Identical child, identical argv tail, no shim. If THIS is already refused, nothing the
            // confined leg reports can be attributed to the confinement.
            const control = await runProbeChild([], inside, outside, true, unixPath, exactFile, siblingFile, 25000);
            const controlOk = !!(control.msg && control.msg.wrote === true && control.msg.readSystem === true
                && control.msg.exactRead === true && control.msg.siblingCode === 'OPEN'
                && control.msg.readCode === 'OPEN' && control.msg.outCode === 'OPEN'
                && control.msg.signalCode === 'OPEN' && control.msg.processCode === 'OPEN'
                && control.msg.execCode === 'OPEN' && control.msg.netCode === 'CONNECTED'
                && control.msg.unixCode === 'CONNECTED');
            if (!controlOk) {
                zeroConfState = 'degraded';
                zeroConfNote = 'the probe ABORTED: an UNCONFINED control child was itself refused, so a refusal from the confined child would prove nothing (an offline or read-only host does this)';
                console.warn('[Sandbox] Linux zero-config probe ABORTED: the negative control failed - an UNCONFINED child could not do what the confined child must be refused. '
                    + `write=${control.msg && control.msg.wrote ? 'ok' : 'FAILED'} readSystem=${control.msg && control.msg.readSystem ? 'ok' : 'FAILED'} outOfZoneRead=${logSafe((control.msg && control.msg.readCode) || 'unknown')} outOfZoneWrite=${logSafe((control.msg && control.msg.outCode) || 'unknown')} signal=${logSafe((control.msg && control.msg.signalCode) || 'unknown')} rawIpConnect=${logSafe((control.msg && control.msg.netCode) || 'unknown')}. `
                    + 'Without that control a "refused" verdict is uninterpretable, so the layer stays OFF.');
                return 'degraded';
            }
            // ── 2. THE CONFINED LEG, through the REAL shim ──────────────────────────────────────────
            const pre = [PERL_BIN, ...shimArgs({
                zone: [zone as string],
                denyNetwork: true,
                readRoot: [zone as string, coreRoot as string, exactFile, ...(nodePrefix.split(pathl.sep).filter(Boolean).length >= 2 ? [nodePrefix] : [])],
                execRoot: [process.execPath, PERL_BIN],
                nodeArgs: [],
            })];
            const confined = await runProbeChild(pre, inside, outside, true, unixPath, exactFile, siblingFile, 25000);

            // The shim's own verdict comes FIRST, because 'this kernel cannot' and 'this kernel could and
            // it failed' are different answers that demand different operator actions, and only the exit
            // code can tell them apart.
            if (confined.code === SHIM_EXIT.UNSUPPORTED) {
                zeroConfState = 'unsupported';
                zeroConfNote = 'this kernel has no usable Landlock (or the architecture has no verified syscall table), so the Linux kernel floor cannot be applied';
                console.warn(`[Sandbox] Linux zero-config confinement unsupported on this kernel: ${logSafe(confined.stderr.trim().slice(0, 200))}`);
                return 'unsupported';
            }

            const ipcOk = !!confined.msg;
            const positiveWrite = !!(confined.msg && confined.msg.wrote === true);
            const positiveRead = !!(confined.msg && confined.msg.readSystem === true);
            const exactRead = !!(confined.msg && confined.msg.exactRead === true);
            const siblingRefused = !!(confined.msg && REFUSAL_CODES.has(String(confined.msg.siblingCode)));
            const readRefused = !!(confined.msg && REFUSAL_CODES.has(String(confined.msg.readCode)));
            const outRefused = !!(confined.msg && REFUSAL_CODES.has(String(confined.msg.outCode)));
            const signalRefused = !!(confined.msg && REFUSAL_CODES.has(String(confined.msg.signalCode)));
            const processRefused = !!(confined.msg && REFUSAL_CODES.has(String(confined.msg.processCode)));
            const execRefused = !!(confined.msg && REFUSAL_CODES.has(String(confined.msg.execCode)));
            const capsDropped = !!(confined.msg && confined.msg.capsCode === 'ZERO');
            const netRefused = !!(confined.msg && REFUSAL_CODES.has(String(confined.msg.netCode)));
            const unixRefused = !!(confined.msg && REFUSAL_CODES.has(String(confined.msg.unixCode)));

            // Certify the network-GRANTED shape too. Landlock and the dangerous-syscall filter must stay
            // active; only the IP-socket rule changes. This prevents granting network from accidentally
            // removing the whole OS sandbox.
            const allowPre = [PERL_BIN, ...shimArgs({
                zone: [zone as string], denyNetwork: false,
                readRoot: [zone as string, coreRoot as string, exactFile, ...(nodePrefix.split(pathl.sep).filter(Boolean).length >= 2 ? [nodePrefix] : [])],
                execRoot: [process.execPath, PERL_BIN], nodeArgs: [],
            })];
            const allowed = await runProbeChild(allowPre, inside, outside, false, unixPath, exactFile, siblingFile, 25000);
            const allowedOk = !!(allowed.msg && allowed.msg.wrote === true && allowed.msg.readSystem === true
                && allowed.msg.exactRead === true && REFUSAL_CODES.has(String(allowed.msg.siblingCode))
                && REFUSAL_CODES.has(String(allowed.msg.readCode))
                && REFUSAL_CODES.has(String(allowed.msg.outCode))
                && REFUSAL_CODES.has(String(allowed.msg.signalCode))
                && REFUSAL_CODES.has(String(allowed.msg.processCode))
                && REFUSAL_CODES.has(String(allowed.msg.execCode))
                && allowed.msg.capsCode === 'ZERO'
                && REFUSAL_CODES.has(String(allowed.msg.unixCode))
                && allowed.msg.netCode === 'CONNECTED');
            if (ipcOk && positiveWrite && positiveRead && exactRead && siblingRefused && readRefused && outRefused && signalRefused
                && processRefused && execRefused && capsDropped && netRefused && unixRefused && allowedOk) {
                zeroConfState = 'active';
                zeroConfNote = 'Landlock + seccomp-bpf certified with no host configuration for both network policies: reads/writes are scoped, process creation and dangerous syscalls are refused, all sockets are denied without a grant, and only IP client sockets are admitted with it';
                console.log('[Sandbox] Linux kernel confinement ACTIVE (Landlock scopes reads/writes and cross-process access; seccomp-bpf refuses process creation and dangerous syscalls, denies all new sockets without a grant, and admits only AF_INET/AF_INET6 clients with it while preserving IPC).');
                return 'active';
            }
            zeroConfState = 'degraded';
            zeroConfNote = 'the Landlock/seccomp shim is available but its probe did NOT certify both network-policy launch shapes';
            console.warn('[Sandbox] Linux zero-config probe did NOT certify confinement on this host - isolated plugins keep the Node permission model and JS guards. '
                + `ipc=${ipcOk ? 'ok' : 'FAILED'} zoneWrite=${positiveWrite ? 'ok' : 'FAILED'} systemRead=${positiveRead ? 'ok' : 'FAILED'} `
                + `exactFileRead=${exactRead ? 'ok' : 'FAILED'} siblingFile=${siblingRefused ? 'refused' : logSafe((confined.msg && confined.msg.siblingCode) || 'unknown')} `
                + `outOfZoneRead=${readRefused ? 'refused' : logSafe((confined.msg && confined.msg.readCode) || 'unknown')} `
                + `outOfZoneWrite=${outRefused ? 'refused' : logSafe((confined.msg && confined.msg.outCode) || 'unknown')} `
                + `kill=${signalRefused ? 'refused' : logSafe((confined.msg && confined.msg.signalCode) || 'unknown')} `
                + `processCreate=${processRefused ? 'refused' : logSafe((confined.msg && confined.msg.processCode) || 'unknown')} `
                + `zoneExec=${execRefused ? 'refused' : logSafe((confined.msg && confined.msg.execCode) || 'unknown')} `
                + `capabilities=${capsDropped ? 'zero' : logSafe((confined.msg && confined.msg.capsCode) || 'unknown')} `
                + `rawIpConnect=${netRefused ? 'refused' : logSafe((confined.msg && confined.msg.netCode) || 'unknown')} `
                + `unixConnect=${unixRefused ? 'refused' : logSafe((confined.msg && confined.msg.unixCode) || 'unknown')} `
                + `networkGrantedShape=${allowedOk ? 'ok' : 'FAILED'} `
                + `shimExit=${logSafe(confined.code)} shimSays=${logSafe(confined.stderr.trim().slice(0, 200))}`);
            return 'degraded';
        } catch (e: any) {
            zeroConfState = 'degraded';
            zeroConfNote = 'the Linux zero-config probe errored, so the layer stays OFF';
            console.warn(`[Sandbox] Linux zero-config probe errored: ${logSafe(e && e.message)} - the layer stays OFF.`);
            return 'degraded';
        } finally {
            // Always removed, on every exit path - a probe that leaks one temp dir per failed boot is
            // exactly the class of probe-temp leak this module must avoid.
            try { if (unixServer) unixServer.close(); } catch { /* */ }
            try { if (probeRoot) fsl.rmSync(probeRoot, { recursive: true, force: true }); } catch { /* */ }
        }
    })();
    return zeroConfProbe;
}

module.exports = {
    PERL_BIN,
    SHIM_PATH,
    SHIM_EXIT,
    shimArgs,
    probeLinuxZeroConf,
    getLinuxZeroConfState,
    getLinuxZeroConfNote,
    // Exported for the unit test only: the path filter is the rejection boundary of this module, so it
    // is tested directly rather than inferred from an argv.
    shimPath,
    __probeSrc: PROBE_SRC,
    __refusalCodes: REFUSAL_CODES,
};
