/**
 * Port-conflict detection + CONSENSUAL liberation for plugin-claimed ports.
 *
 * Zero-config story: a plugin can declare `claimPorts: [25]` in its manifest. When the port it needs
 * is squatted by the distro's preinstalled MTA (Debian/Proxmox LXC templates ship Postfix/Exim bound
 * to loopback:25 — useless for internet mail, but enough to force our SMTP listener into a degraded
 * fallback port), the admin UI shows WHAT is squatting and offers a one-click, explicitly-confirmed
 * fix: permanently disable that service (`systemctl disable --now`, so it does not come back at boot)
 * and reload the plugin so it can bind the freed port.
 *
 * SECURITY MODEL — this is HOST-side code, deliberately out of any plugin's reach:
 *  - Exposed ONLY through admin-authenticated HTTP routes (routes/plugins.ts). There is NO bridge
 *    surface, so a sandboxed plugin can never trigger it; the modal consent lives in the admin UI.
 *  - We only ever disable services from the KNOWN_MTAS allowlist below. An unknown occupant is
 *    REPORTED (name/pid) but never touched — `canFree` stays false and the UI shows manual guidance.
 *  - The systemctl unit name comes from OUR map, never from request input; the port must be declared
 *    in the target plugin's manifest, so this can't be used as a generic "kill any service" endpoint.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsyncReal = promisify(execFile);

// Known distro MTAs we are willing to disable after explicit admin confirmation. Keyed by the
// LISTENING process name as reported by `ss -p` (postfix's listener is its "master" process).
const KNOWN_MTAS: Record<string, { service: string; label: string }> = {
    master: { service: 'postfix', label: 'Postfix' },
    exim4: { service: 'exim4', label: 'Exim' },
    exim: { service: 'exim4', label: 'Exim' },
    sendmail: { service: 'sendmail', label: 'Sendmail' },
};

interface PortListener {
    addr: string;
    port: number;
    proc: string | null;
    pids: number[];
}

interface PortConflict {
    port: number;
    inUse: boolean;
    canFree: boolean;
    // true when we could not actually look at the sockets (non-Linux, ss missing). Distinct from a
    // genuinely-free port: callers must NOT treat "couldn't inspect" as "free" (a false alreadyFree).
    uninspectable?: boolean;
    occupant?: {
        process: string;
        pids: number[];
        loopbackOnly: boolean;
        service?: string;
        label?: string;
    };
    reason?: string;
}

// Injectable deps so tests can exercise every gate without a Linux root box.
interface Deps {
    platform?: string;
    getuid?: (() => number) | null;
    execFileAsync?: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
    sleepMs?: number;
    selfPids?: number[];
    // Explicit admin consent to PERMANENTLY disable the squatting service. freeClaimedPort refuses to
    // disable anything without it — so a client that skipped the confirm modal (e.g. its GET snapshot
    // said the port was free, then the squatter reappeared: TOCTOU) gets a CONSENT_REQUIRED error with
    // the fresh conflict instead of a silent, unconsented systemctl disable.
    allowDisable?: boolean;
}

// Every pid that IS WordJS: the host plus its isolated plugin children. The mail listener binds inside
// a child_process.fork isolate, so checking only process.pid would misreport WordJS's own listener as
// a foreign "node" squatter (with "free the port manually" guidance against ourselves).
function getSelfPids(): number[] {
    const pids = [process.pid];
    try {
        const statuses = require('./plugin-isolate').getAllIsolateStatuses();
        for (const s of Object.values(statuses) as any[]) {
            if (s && typeof s.pid === 'number') pids.push(s.pid);
        }
    } catch { /* isolate runtime not loaded (tests, early boot) */ }
    return pids;
}

/**
 * Parse `ss -H -tlnp` output into the listeners bound on `port`.
 * Line shape: `LISTEN 0 100 127.0.0.1:25 0.0.0.0:* users:(("master",pid=435,fd=13))`
 * (the process column is absent when ss lacks permission to resolve it).
 */
function parseSsListeners(output: string, port: number): PortListener[] {
    const listeners: PortListener[] = [];
    for (const line of String(output || '').split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4) continue;
        // With -H the columns are: State Recv-Q Send-Q Local:Port Peer:Port [Process]
        const local = cols[3] === 'LISTEN' ? cols[4] : cols[3]; // tolerate missing/present State column
        if (!local || !local.includes(':')) continue;
        const idx = local.lastIndexOf(':');
        const p = parseInt(local.slice(idx + 1), 10);
        if (p !== port) continue;
        const addr = local.slice(0, idx).replace(/^\[|\]$/g, '');
        const procMatch = /users:\(\("([^"]+)"/.exec(line);
        const pids: number[] = [];
        for (const m of line.matchAll(/pid=(\d+)/g)) pids.push(parseInt(m[1], 10));
        listeners.push({ addr, port: p, proc: procMatch ? procMatch[1] : null, pids });
    }
    return listeners;
}

function isLoopbackAddr(addr: string): boolean {
    return addr === '::1' || addr === 'localhost' || addr.startsWith('127.');
}

/** Inspect who (if anyone) is listening on `port` and whether we can safely free it. */
async function detectPortConflict(port: number, deps: Deps = {}): Promise<PortConflict> {
    const platform = deps.platform || process.platform;
    const getuid = deps.getuid !== undefined ? deps.getuid : (process as any).getuid;
    const run = deps.execFileAsync || execFileAsyncReal;

    if (platform !== 'linux') {
        return { port, inUse: false, canFree: false, uninspectable: true, reason: 'Automatic port-conflict resolution is only available on Linux.' };
    }
    let stdout = '';
    try {
        stdout = (await run('ss', ['-H', '-t', '-l', '-n', '-p'])).stdout;
    } catch {
        return { port, inUse: false, canFree: false, uninspectable: true, reason: 'Could not inspect listening sockets (ss unavailable).' };
    }
    const listeners = parseSsListeners(stdout, port);
    if (listeners.length === 0) {
        return { port, inUse: false, canFree: false };
    }

    const procs = [...new Set(listeners.map(l => l.proc).filter(Boolean))] as string[];
    const pids = [...new Set(listeners.flatMap(l => l.pids))];
    const loopbackOnly = listeners.every(l => isLoopbackAddr(l.addr));
    const occupant: PortConflict['occupant'] = {
        process: procs.join(', ') || 'unknown',
        pids,
        loopbackOnly,
    };

    // Our own process tree already holds it (e.g. the plugin bound it after a fix) → nothing to free.
    // Includes the isolated-plugin CHILD pids: the mail listener binds inside a fork()ed isolate, not
    // in the host process, so process.pid alone would misreport our own listener as a foreign squatter.
    const selfPids = deps.selfPids || getSelfPids();
    if (pids.some(p => selfPids.includes(p))) {
        return { port, inUse: true, canFree: false, occupant, reason: `Port ${port} is already held by WordJS itself.` };
    }

    const known = procs.length === 1 ? KNOWN_MTAS[procs[0]] : undefined;
    if (!known) {
        return {
            port, inUse: true, canFree: false, occupant,
            reason: `Port ${port} is in use by "${occupant.process}", which is not a known system mail service — WordJS will not touch it. Free the port manually, then reload the plugin.`,
        };
    }
    occupant.service = known.service;
    occupant.label = known.label;

    const isRoot = typeof getuid === 'function' && getuid.call(process) === 0;
    if (!isRoot) {
        return {
            port, inUse: true, canFree: false, occupant,
            reason: `${known.label} is holding port ${port}, but WordJS is not running as root, so it cannot disable the service. Run: sudo systemctl disable --now ${known.service}`,
        };
    }
    return { port, inUse: true, canFree: true, occupant };
}

/**
 * Permanently disable the known-MTA squatter on `port` (systemctl disable --now → survives reboots)
 * and wait until the port is actually released. Throws coded errors for the route to map to HTTP.
 */
async function freeClaimedPort(port: number, deps: Deps = {}): Promise<{ freed: boolean; alreadyFree?: boolean; port: number; service?: string; label?: string }> {
    const run = deps.execFileAsync || execFileAsyncReal;
    const detected = await detectPortConflict(port, deps);
    if (detected.uninspectable) {
        // "Couldn't look" is NOT "free" — a fake alreadyFree success here would silently no-op forever.
        const err: any = new Error(detected.reason || `Could not inspect port ${port}.`);
        err.code = 'PORT_NOT_FREEABLE';
        throw err;
    }
    if (!detected.inUse) {
        return { freed: false, alreadyFree: true, port };
    }
    if (!detected.canFree || !detected.occupant?.service) {
        const err: any = new Error(detected.reason || `Port ${port} cannot be freed automatically.`);
        err.code = 'PORT_NOT_FREEABLE';
        throw err;
    }
    if (!deps.allowDisable) {
        // Server-side consent gate (closes the client-side TOCTOU): disabling a service is only allowed
        // when the request explicitly carries the admin's modal confirmation for THIS action.
        const err: any = new Error(`${detected.occupant.label} is holding port ${port} — confirmation required before disabling it.`);
        err.code = 'CONSENT_REQUIRED';
        err.conflict = detected;
        throw err;
    }
    const { service, label } = detected.occupant;
    try {
        // disable --now = stop NOW and never start again at boot (the admin consented to PERMANENT).
        await run('systemctl', ['disable', '--now', service]);
    } catch (e: any) {
        const err: any = new Error(`Failed to disable ${label}: ${e && e.message ? e.message : e}`);
        err.code = 'DISABLE_FAILED';
        throw err;
    }
    console.log(`🔓 [port-conflicts] Disabled ${service} (was holding port ${port}) with admin consent — permanent (systemctl disable --now).`);

    // The unit stops asynchronously; poll until the kernel actually releases the socket.
    const sleepMs = deps.sleepMs !== undefined ? deps.sleepMs : 500;
    for (let i = 0; i < 10; i++) {
        const again = await detectPortConflict(port, deps);
        if (!again.inUse) {
            return { freed: true, port, service, label };
        }
        await new Promise(r => setTimeout(r, sleepMs));
    }
    const err: any = new Error(`Disabled ${label}, but port ${port} is still in use — check the service state manually.`);
    err.code = 'PORT_STILL_IN_USE';
    throw err;
}

module.exports = {
    detectPortConflict,
    freeClaimedPort,
    parseSsListeners,
    isLoopbackAddr,
    KNOWN_MTAS,
};
