/**
 * WordJS - the Linux privilege the BACKEND PROCESS ITSELF holds, and what to do about it.
 *
 * WHY THIS EXISTS. A production site ran WordJS as an unprivileged user and gave it
 * `AmbientCapabilities=CAP_NET_BIND_SERVICE` in its systemd unit so Node could listen on 443. Nothing
 * said a word about it, and it is the reason every plugin on that host was refused: the Landlock/seccomp
 * shim took any capability for root, tried to run root's privilege drop without the privilege to do it
 * (`SHIM-FAIL: setgroups(clear): Operation not permitted`), and the fail-closed sandbox policy refused
 * all launches. The shim now sheds a non-root service's capabilities correctly, so that failure is gone
 * - but the condition behind it is still worth an operator's attention, for two reasons:
 *   . the core process runs with more privilege than it needs. CAP_NET_BIND_SERVICE is narrow, but the
 *     same mechanism carries any capability, and nothing in WordJS needs one;
 *   . the sandbox is the only thing that keeps it from plugins. When the kernel sandbox is NOT active and
 *     `sandbox.requireHardening` is off, an isolated plugin is a plain child of this process: ambient
 *     capabilities survive its exec, and file capabilities on the node binary are granted to it afresh.
 *
 * WHAT IS READ. /proc/self/status, the kernel's own account: CapInh/CapPrm/CapEff/CapBnd/CapAmb and the
 * Uid line. Nothing on other operating systems - capabilities are a Linux concept, and an answer
 * invented for Windows or macOS would be a claim nobody measured.
 *
 * WHAT IS SAID ABOUT THE SANDBOX IS ONLY WHAT WAS MEASURED. "The sandbox drops these for plugins" is
 * stated only when the probe is 'active' - its confined child had to see empty capability sets before it
 * could report that. A degraded sandbox is blamed on the capability only when the probe's own shim line
 * names a privilege-drop step; otherwise the diagnosis says it is NOT the identified cause, because a
 * health surface that guesses is worse than one that says nothing - it is believed.
 *
 * Pure core (diagnoseHostPrivilege over a status TEXT) so every row is testable on any host; the only
 * impure part is readHostPrivilege(), which gathers the inputs.
 */

const fsh = require('fs');

/** Bit index → name, from linux/capability.h (0 … CAP_LAST_CAP = 40 on current kernels). */
const CAPABILITY_NAMES: readonly string[] = [
    'CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_DAC_READ_SEARCH', 'CAP_FOWNER', 'CAP_FSETID', 'CAP_KILL',
    'CAP_SETGID', 'CAP_SETUID', 'CAP_SETPCAP', 'CAP_LINUX_IMMUTABLE', 'CAP_NET_BIND_SERVICE',
    'CAP_NET_BROADCAST', 'CAP_NET_ADMIN', 'CAP_NET_RAW', 'CAP_IPC_LOCK', 'CAP_IPC_OWNER', 'CAP_SYS_MODULE',
    'CAP_SYS_RAWIO', 'CAP_SYS_CHROOT', 'CAP_SYS_PTRACE', 'CAP_SYS_PACCT', 'CAP_SYS_ADMIN', 'CAP_SYS_BOOT',
    'CAP_SYS_NICE', 'CAP_SYS_RESOURCE', 'CAP_SYS_TIME', 'CAP_SYS_TTY_CONFIG', 'CAP_MKNOD', 'CAP_LEASE',
    'CAP_AUDIT_WRITE', 'CAP_AUDIT_CONTROL', 'CAP_SETFCAP', 'CAP_MAC_OVERRIDE', 'CAP_MAC_ADMIN', 'CAP_SYSLOG',
    'CAP_WAKE_ALARM', 'CAP_BLOCK_SUSPEND', 'CAP_AUDIT_READ', 'CAP_PERFMON', 'CAP_BPF', 'CAP_CHECKPOINT_RESTORE',
];

type CapabilitySets = {
    inheritable: bigint;
    permitted: bigint;
    effective: bigint;
    /** Absent only on kernels too old to report it. */
    bounding: bigint | null;
    /** Absent on kernels without ambient capabilities (before 4.3). */
    ambient: bigint | null;
    /** real, effective, saved, filesystem — or null when the line is missing. */
    uids: number[] | null;
};

/** Parse the capability and uid lines of a /proc/<pid>/status text. Null when the three mandatory sets are not all there. */
function parseProcStatus(text: unknown): CapabilitySets | null {
    const src = typeof text === 'string' ? text : '';
    const mask = (name: string): bigint | null => {
        const m = new RegExp(`^${name}:\\s*([0-9a-fA-F]{1,16})\\s*$`, 'm').exec(src);
        return m ? BigInt(`0x${m[1]}`) : null;
    };
    const inheritable = mask('CapInh');
    const permitted = mask('CapPrm');
    const effective = mask('CapEff');
    if (inheritable === null || permitted === null || effective === null) return null;
    const u = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(src);
    return {
        inheritable, permitted, effective,
        bounding: mask('CapBnd'),
        ambient: mask('CapAmb'),
        uids: u ? [Number(u[1]), Number(u[2]), Number(u[3]), Number(u[4])] : null,
    };
}

/** The names of the bits set in `mask`, in bit order; a bit newer than this table is named by number. */
function capabilityNames(mask: bigint | null): string[] {
    const out: string[] = [];
    if (mask === null || mask === BigInt(0)) return out;
    for (let bit = 0; bit < 64; bit++) {
        if ((mask >> BigInt(bit)) & BigInt(1)) out.push(CAPABILITY_NAMES[bit] || `CAP_${bit}`);
    }
    return out;
}

export type HostPrivilege = {
    /** OK = nothing held; EXCESS = the core runs with privilege it does not need; UNKNOWN = could not read; NOT_APPLICABLE = not Linux. */
    status: 'OK' | 'EXCESS' | 'UNKNOWN' | 'NOT_APPLICABLE';
    root?: boolean;
    uid?: number;
    /** Effective ∪ permitted ∪ ambient — what the process can use or hands to a child. */
    capabilities?: string[];
    ambient?: string[];
    inheritable?: string[];
    /**
     * Where it most likely came from. 'real-uid-root': the effective uid is unprivileged but the real,
     * saved or filesystem uid is still 0 (a setuid-root wrapper, or seteuid() from a root start).
     */
    source?: 'root' | 'real-uid-root' | 'ambient' | 'file-capabilities' | 'inheritable-only';
    cause?: string;
    /** What the plugin sandbox does about it RIGHT NOW, from its measured state. */
    sandbox?: string;
    fix?: string;
    /** cause + sandbox + fix, as one paragraph for a log line or a panel. */
    message?: string;
};

const PORTS_SENTENCE = 'If it is there so Node can listen on 80/443, let unprivileged processes bind those ports instead '
    + '(net.ipv4.ip_unprivileged_port_start=80 in a file under /etc/sysctl.d/, then `sysctl --system`) or put a reverse proxy '
    + 'in front of WordJS on a high port. See documentation/deployment.md.';

/**
 * Diagnose from the inputs alone. `sandboxState` is the native sandbox's probe state
 * ('active' | 'degraded' | 'unsupported' | 'disabled' | 'unknown'); `shimFailure` is the probe's own
 * shim refusal line when there was one; `requireHardening` is the fail-closed policy.
 */
function diagnoseHostPrivilege(o: { platform: string; statusText: string | null; sandboxState?: string; shimFailure?: string | null; requireHardening?: boolean }): HostPrivilege {
    if (o.platform !== 'linux') return { status: 'NOT_APPLICABLE' };
    const sets = parseProcStatus(o.statusText);
    if (!sets) {
        return { status: 'UNKNOWN', message: 'The capability sets of this process could not be read from /proc/self/status.' };
    }
    const zero = BigInt(0);
    const euid = sets.uids ? sets.uids[1] : null;
    const root = euid === 0;
    // A uid 0 the effective uid no longer shows: real, saved or filesystem. Root identity all the same -
    // a process holding it can switch back to root, and the filesystem uid decides file access outright.
    const leftoverRootUid = !root && !!sets.uids && [sets.uids[0], sets.uids[2], sets.uids[3]].includes(0);
    const usable = sets.effective | sets.permitted | (sets.ambient ?? zero);
    const capabilities = capabilityNames(usable);
    const ambient = capabilityNames(sets.ambient);
    const inheritable = capabilityNames(sets.inheritable);
    const base: HostPrivilege = { status: 'OK', root, ...(euid !== null ? { uid: euid } : {}), capabilities, ambient, inheritable };

    if (!root && !leftoverRootUid && usable === zero) {
        if (sets.inheritable === zero) return base;
        // Inheritable alone grants nothing: it only matters together with file capabilities on what is
        // exec'd next, and the sandbox empties it for plugins anyway. Reported, not warned about.
        return {
            ...base,
            source: 'inheritable-only',
            cause: `The inheritable capability set of this process is not empty (${inheritable.join(', ')}). It grants nothing by itself; it is privilege the service was configured with and does not use.`,
        };
    }

    const who = root ? 'root (uid 0)' : `uid ${euid === null ? '?' : euid}`;
    const held = capabilities.length ? `the Linux capabilities ${capabilities.join(', ')}` : 'no Linux capability';
    let source: HostPrivilege['source'];
    let cause: string;
    if (root) {
        source = 'root';
        // "Every capability" only when that is what the kernel reports. A root service whose bounding set
        // was cut (systemd CapabilityBoundingSet=, a container's --cap-drop) holds less - sometimes
        // nothing - and is still root: uid 0 owns the files root owns, whatever its capabilities.
        const all = (BigInt(1) << BigInt(CAPABILITY_NAMES.length)) - BigInt(1);
        cause = (usable & all) === all
            ? 'The WordJS backend runs as root (uid 0), so it holds every capability the system allows.'
            : `The WordJS backend runs as root (uid 0) with a reduced capability set (${capabilities.length ? capabilities.join(', ') : 'none at all'}) `
                + '- a CapabilityBoundingSet= in its unit or a container runtime\'s capability drop. It is still uid 0: it owns, and can read and write, every file root owns.';
    } else if (leftoverRootUid) {
        source = 'real-uid-root';
        const u = sets.uids as number[];
        cause = `The WordJS backend runs with effective uid ${u[1]}, but its real/saved/filesystem uids are ${u[0]}/${u[2]}/${u[3]}: a uid 0 is left `
            + 'behind - what a setuid-root wrapper, or a start as root that lowered only the effective uid (seteuid), leaves. A process '
            + `holding a uid 0 can switch back to root at any time. It holds ${held}.`;
    } else if (sets.ambient !== null && sets.ambient !== zero) {
        source = 'ambient';
        cause = `The WordJS backend runs as ${who} but holds the Linux capabilities ${capabilities.join(', ')} through its AMBIENT set `
            + '- what systemd\'s AmbientCapabilities= (or a launcher such as `setpriv --ambient-caps` or `capsh --addamb`) grants.';
    } else {
        source = 'file-capabilities';
        cause = `The WordJS backend runs as ${who} but holds the Linux capabilities ${capabilities.join(', ')} with an empty ambient set `
            + '- on an unprivileged process that is what FILE capabilities on the node binary grant (`setcap`; check the node executable with `getcap`).';
    }

    const state = String(o.sandboxState || 'unknown');
    const startsWithout = o.requireHardening === false;
    let sandbox: string;
    if (state === 'active' && root) {
        // What the shim does for root is NOT "drops this": it keeps the uid so root-owned application
        // trees stay usable, and removes every capability - every OVERRIDE of file permissions - but not
        // the owner's own access. Saying more would be the overclaim an operator relies on.
        sandbox = 'The plugin sandbox removes every capability from plugins: its probe verified that isolated plugin processes start with empty capability sets. '
            + 'It keeps their uid, though, so plugins still run as uid 0: a root-owned file inside what the sandbox lets them read is readable to them as its owner. '
            + 'The WordJS core process itself runs with more privilege than it needs.';
    } else if (state === 'active' && source === 'real-uid-root') {
        sandbox = 'The plugin sandbox drops this for plugins: its launcher collapses the real, saved and filesystem uids onto the effective one, and its probe verified that isolated plugin processes start with empty capability sets. '
            + 'The WordJS core process itself, however, keeps a root uid.';
    } else if (state === 'active') {
        sandbox = 'The plugin sandbox drops this for plugins: its probe verified that isolated plugin processes start with empty capability sets. '
            + 'The WordJS core process itself, however, runs with more privilege than it needs.';
    } else if (state === 'degraded') {
        const { isPrivilegeDropFailure } = require('./sandbox-refusal');
        const blamed = !!o.shimFailure && isPrivilegeDropFailure(o.shimFailure);
        // Blamed on the STEP, not on "this privilege": the step can fail because the service holds
        // something, or because it lacks the authority to shed it (root without CAP_SETGID, say). What
        // is true either way is that a service holding nothing never runs the step at all.
        sandbox = (blamed
            ? `The plugin sandbox is DEGRADED: its probe failed in the step that sheds the service's own privilege (${o.shimFailure}). A service that runs as an unprivileged user holding no capabilities never runs that step.`
            : 'The plugin sandbox is DEGRADED, but its probe did not fail while shedding privilege, so this is not the identified cause (see sandbox.kernel.note).')
            + (startsWithout
                ? ' Because sandbox.requireHardening is off, isolated plugins start WITHOUT the sandbox and inherit this privilege.'
                : ' Isolated plugins are refused until the sandbox is active again.');
    } else if (state === 'unknown') {
        sandbox = 'The plugin sandbox has not been probed yet (it runs on the first isolated plugin load); when it is active, plugins start with empty capability sets.';
    } else {
        sandbox = `There is no active kernel sandbox on this host (state '${state}'), so nothing drops this privilege for plugins.`
            + (startsWithout
                ? ' Because sandbox.requireHardening is off, isolated plugins start WITHOUT the sandbox and inherit it.'
                : ' Isolated plugins are refused (sandbox.requireHardening).');
    }

    const fix = (root
        ? 'Run WordJS as a dedicated unprivileged user (User= in the systemd unit). '
        : source === 'real-uid-root'
            ? 'Start the service directly as the unprivileged user - User= in the systemd unit, or `setpriv --reuid=<user> --regid=<user> --init-groups` / `runuser -u <user>` in a script - instead of starting it as root and lowering only its effective uid. '
            : source === 'ambient'
                ? 'Drop the capability from the service: remove AmbientCapabilities= (and any CapabilityBoundingSet= that exists only to allow it) from the systemd unit. '
                : 'Drop the capability from the service: remove the file capability from the node binary with `setcap -r` (check it with `getcap`), or whatever launcher raised it. ')
        + PORTS_SENTENCE;

    return { ...base, status: 'EXCESS', source, cause, sandbox, fix, message: `${cause} ${sandbox} ${fix}` };
}

/** Gather the live inputs and diagnose. Never throws: it feeds a health page and a boot log line. */
function readHostPrivilege(): HostPrivilege {
    if (process.platform !== 'linux') return { status: 'NOT_APPLICABLE' };
    let statusText: string | null = null;
    try { statusText = fsh.readFileSync('/proc/self/status', 'utf8'); } catch { /* reported as UNKNOWN */ }
    let sandboxState = 'unknown';
    let shimFailure: string | null = null;
    let requireHardening = true;
    try {
        const iso = require('./plugin-isolate');
        sandboxState = iso.getSandboxPlatformState();
        if (typeof iso.getLinuxZeroConfShimFailure === 'function') shimFailure = iso.getLinuxZeroConfShimFailure();
    } catch { /* the sandbox module is not reportable; the diagnosis says 'not probed' */ }
    try { requireHardening = require('../config/app').sandbox?.requireHardening !== false; } catch { /* fail closed */ }
    try {
        return diagnoseHostPrivilege({ platform: process.platform, statusText, sandboxState, shimFailure, requireHardening });
    } catch {
        return { status: 'UNKNOWN' };
    }
}

/** The boot-time twin of `sandbox.hostPrivilege`: one warning block when the core holds privilege it does not need. */
// `read` is the live reading by default; a test passes a diagnosis so the EXCESS block is asserted on
// every host, not only on one that happens to run the suite with privilege.
function warnHostPrivilegeAtBoot(log: { warn: (...a: any[]) => void } = console, read: () => HostPrivilege = readHostPrivilege): HostPrivilege {
    const d = read();
    if (d.status !== 'EXCESS') return d;
    log.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log.warn('⚠️  The WordJS backend process holds Linux privilege it does not need.');
    for (const line of [d.cause, d.sandbox, d.fix]) if (line) log.warn(`   ${line}`);
    log.warn('   Visible to admins on GET /api/v1/health/details (sandbox.hostPrivilege).');
    log.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return d;
}

module.exports = {
    CAPABILITY_NAMES,
    parseProcStatus,
    capabilityNames,
    diagnoseHostPrivilege,
    readHostPrivilege,
    warnHostPrivilegeAtBoot,
};
