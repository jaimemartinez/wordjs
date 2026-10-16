/**
 * WordJS — host-mediated inbound SMTP listener (the `smtp:inbound` capability).
 *
 * WHY THE HOST LISTENS. Every platform's plugin sandbox refuses an isolated plugin an inbound socket — the
 * Linux shim's seccomp filter (EPERM on any port), macOS Seatbelt (no network-bind), and Windows
 * AppContainer (internetClient only, never internetClientServer). That is the right default: a plugin
 * must not open arbitrary listeners. But a mail server has to receive the internet's mail on port 25.
 * So the HOST opens the port on behalf of the ONE plugin an administrator granted `smtp:inbound`
 * (an EXCLUSIVE grant — core/plugin-permissions EXCLUSIVE_GRANTS), runs the SMTP protocol itself
 * (smtp-server), and asks the plugin, over its isolate's IPC channel, what to do at each step:
 *
 *   connect(session)            → accept, or { code, message } to refuse (DNSBL, …)
 *   mailFrom(address, session)  → accept or refuse (SPF, …)
 *   rcptTo(address, session)    → accept or refuse (blocklists, unknown recipients, …)
 *   data(rawBase64, session)    → accept (stored) or refuse (452 mailbox full, …)
 *   close(session)              → fire-and-forget, lets the plugin drop per-session state
 *
 * The plugin never touches a socket. What crosses to it is the transaction's data: the envelope, the
 * client's IP/HELO, and the raw message (capped at `maxSize`). It answers with a verdict; a plugin that
 * throws or times out gets a TEMPORARY 451 for the sender (retry later) — never a silent accept.
 *
 * ONE LISTENER, ONE OWNER. A second plugin asking while another owns it is refused even if the grant
 * store were edited by hand, and the owner's teardown (unload, crash, revoke → reload) closes it.
 *
 * PORT. The plugin asks for a port its manifest declares in `claimPorts` (25 by default). If the host
 * cannot bind it (EACCES below ip_unprivileged_port_start without the privilege, EADDRINUSE when another
 * MTA holds it) it falls back to 2525 and reports WHY, so the admin UI shows the real state.
 */
'use strict';

const net = require('net');
const log = require('./module-logger').moduleLogger('core/inbound-smtp');

type Verdict = null | undefined | { code?: number; message?: string };
type Invoke = (phase: string, args: any[]) => Promise<Verdict>;

interface ListenOptions {
    port?: number;
    fallbackPort?: number;
    maxSize?: number;
    maxClients?: number;
    proxyIps?: string[];
    banner?: string;
}

interface Status {
    owner: string | null;
    requestedPort: number | null;
    boundPort: number | null;
    degraded: boolean;
    reason: string | null;
    proxyIps: string[];
}

const DEFAULT_PORT = 25;
const DEFAULT_FALLBACK = 2525;
const HARD_MAX_SIZE = 50 * 1024 * 1024;
const PHASE_TIMEOUT_MS = 25000; // under the isolate's 30 s RPC timeout, so a slow plugin is not recycled

let server: any = null;
let owner: string | null = null;
let status: Status = { owner: null, requestedPort: null, boundPort: null, degraded: false, reason: null, proxyIps: [] };
let sessionSeq = 0;

function smtpError(code: number, message: string) {
    const err: any = new Error(message);
    err.responseCode = code;
    return err;
}

function bindReason(code: string | undefined, port: number): string {
    if (code === 'EACCES') {
        return `binding port ${port} was denied (EACCES): on Linux a process without privilege may not bind below ` +
            'net.ipv4.ip_unprivileged_port_start (1024 by default). Redirect 25 to the fallback port in the firewall ' +
            '(nftables/iptables REDIRECT), or lower that sysctl to 25 (which lets every unprivileged process bind 25-1023).';
    }
    if (code === 'EADDRINUSE') return `port ${port} is already in use by another mail server — stop it, or map ${port} to the fallback port`;
    return `could not bind port ${port} (${code || 'unknown error'})`;
}

/** The session as the plugin sees it: data only, no socket. `id` is stable for the connection. */
function sessionView(session: any) {
    const env = (session && session.envelope) || {};
    return {
        id: session && session.__wjsId,
        remoteAddress: session && session.remoteAddress,
        remotePort: session && session.remotePort,
        clientHostname: session && session.clientHostname,
        hostNameAppearsAs: session && session.hostNameAppearsAs,
        secure: !!(session && session.secure),
        transmissionType: session && session.transmissionType,
        envelope: {
            mailFrom: env.mailFrom ? { address: String(env.mailFrom.address || '') } : false,
            rcptTo: Array.isArray(env.rcptTo) ? env.rcptTo.map((r: any) => ({ address: String((r && r.address) || '') })) : [],
        },
    };
}

/** Run a plugin phase with a deadline. A throw or timeout becomes a TEMPORARY failure for the sender. */
async function ask(invoke: Invoke, phase: string, args: any[]): Promise<Verdict | Error> {
    let timer: any;
    try {
        const deadline = new Promise<Error>((resolve) => {
            timer = setTimeout(() => resolve(smtpError(451, '4.3.0 Temporary local problem, try again later')), PHASE_TIMEOUT_MS);
            if (timer && timer.unref) timer.unref();
        });
        return await Promise.race([invoke(phase, args), deadline]);
    } catch (e: any) {
        log.warn(`[InboundSMTP] plugin '${owner}' failed in ${phase}: ${e && e.message}`);
        return smtpError(451, '4.3.0 Temporary local problem, try again later');
    } finally {
        clearTimeout(timer);
    }
}

function settle(callback: (err?: any) => void, verdict: Verdict | Error) {
    if (verdict instanceof Error) return callback(verdict);
    if (verdict && typeof verdict === 'object' && (verdict.code || verdict.message)) {
        const code = Number(verdict.code) || 550;
        // Only real SMTP failure classes; anything else is a plugin bug — answer a temporary failure.
        const safe = code >= 400 && code < 600 ? code : 451;
        return callback(smtpError(safe, String(verdict.message || 'Rejected').replace(/[\r\n]+/g, ' ').slice(0, 300)));
    }
    callback();
}

function validIps(list: unknown): string[] {
    const out = new Set<string>();
    for (const raw of Array.isArray(list) ? list : []) {
        const ip = String(raw || '').trim();
        const v = net.isIP(ip);
        if (!v) continue;
        out.add(ip);
        if (v === 4) out.add('::ffff:' + ip); // the dual-stack listener reports IPv4 peers in mapped form
    }
    return [...out];
}

function probe(port: number): Promise<{ ok: boolean; code?: string }> {
    return new Promise((resolve) => {
        const tester = net.createServer();
        tester.once('error', (e: any) => resolve({ ok: false, code: e && e.code }));
        tester.once('listening', () => tester.close(() => resolve({ ok: true })));
        try { tester.listen(port, '0.0.0.0'); } catch (e: any) { resolve({ ok: false, code: e && e.code }); }
    });
}

/**
 * Open (or re-open with new options) the listener for `slug`. The caller (plugin-isolate) has already
 * checked the `smtp:inbound` grant and passes the ports the manifest declares.
 */
async function start(slug: string, opts: ListenOptions, claimedPorts: number[], invoke: Invoke): Promise<Status & { ok: boolean; error?: string }> {
    if (owner && owner !== slug) {
        return { ok: false, error: `the inbound SMTP listener is owned by plugin '${owner}'`, ...status };
    }
    await stop(slug);

    const allowed = new Set((claimedPorts || []).filter((p) => Number.isInteger(p) && p > 0 && p < 65536));
    let port = Number(opts && opts.port) || DEFAULT_PORT;
    if (!allowed.has(port)) {
        return { ok: false, error: `port ${port} is not declared in the plugin's manifest claimPorts`, ...status };
    }
    const fallback = Number(opts && opts.fallbackPort) || DEFAULT_FALLBACK;
    const proxyIps = validIps(opts && opts.proxyIps);
    const maxSize = Math.min(Math.max(Number(opts && opts.maxSize) || 25 * 1024 * 1024, 1024 * 1024), HARD_MAX_SIZE);
    const maxClients = Math.min(Math.max(Number(opts && opts.maxClients) || 50, 1), 200);

    status = { owner: slug, requestedPort: port, boundPort: null, degraded: false, reason: null, proxyIps };
    const p = await probe(port);
    if (!p.ok) {
        status.degraded = true;
        status.reason = bindReason(p.code, port);
        port = fallback;
    }

    const { SMTPServer } = require('smtp-server');
    server = new SMTPServer({
        ...(proxyIps.length ? { useProxy: proxyIps } : {}),
        authOptional: true,
        disabledCommands: ['AUTH'],
        size: maxSize,
        maxClients,
        socketTimeout: 60 * 1000,
        banner: opts && opts.banner ? String(opts.banner).replace(/[\r\n]+/g, ' ').slice(0, 120) : undefined,
        onConnect(session: any, callback: any) {
            session.__wjsId = `s${++sessionSeq}`;
            ask(invoke, 'connect', [sessionView(session)]).then((v) => settle(callback, v));
        },
        onMailFrom(address: any, session: any, callback: any) {
            ask(invoke, 'mailFrom', [{ address: String((address && address.address) || '') }, sessionView(session)]).then((v) => settle(callback, v));
        },
        onRcptTo(address: any, session: any, callback: any) {
            ask(invoke, 'rcptTo', [{ address: String((address && address.address) || '') }, sessionView(session)]).then((v) => settle(callback, v));
        },
        onData(stream: any, session: any, callback: any) {
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on('data', (c: Buffer) => { size += c.length; if (size <= maxSize) chunks.push(c); });
            stream.on('error', (e: any) => callback(smtpError(451, `4.3.0 ${String(e && e.message || 'stream error')}`)));
            stream.on('end', () => {
                if (stream.sizeExceeded) return callback(smtpError(552, '5.3.4 Message exceeds the maximum size'));
                const raw = Buffer.concat(chunks).toString('base64');
                ask(invoke, 'data', [raw, sessionView(session)]).then((v) => settle(callback, v));
            });
        },
        onClose(session: any) {
            if (session && session.__wjsId) invoke('close', [sessionView(session)]).catch(() => { /* best effort */ });
        },
    });
    server.on('error', (e: any) => log.error(`[InboundSMTP] listener error: ${e && e.message}`));
    owner = slug;

    const bound = await new Promise<boolean>((resolve) => {
        const onErr = (e: any) => {
            status.degraded = true;
            status.reason = (status.reason ? status.reason + ' ' : '') + `The fallback port ${port} could not be bound either: ${bindReason(e && e.code, port)}`;
            resolve(false);
        };
        server.server.once('error', onErr);
        try {
            server.listen(port, () => { server.server.removeListener('error', onErr); resolve(true); });
        } catch (e: any) { onErr(e); }
    });
    if (bound) {
        status.boundPort = port;
        log.info(`[InboundSMTP] listening on port ${port} for plugin '${slug}'${status.degraded ? ` (fallback: ${status.reason})` : ''}`);
    } else {
        try { server.close(); } catch { /* not listening */ }
        server = null;
        log.warn(`[InboundSMTP] could not listen for plugin '${slug}': ${status.reason}`);
    }
    return { ok: bound, ...status };
}

/** Close the listener if `slug` owns it (no-op otherwise). Idempotent. */
async function stop(slug: string): Promise<void> {
    if (!server || owner !== slug) {
        if (owner === slug && !server) { owner = null; status = { ...status, owner: null, boundPort: null }; }
        return;
    }
    const s = server;
    server = null;
    owner = null;
    status = { ...status, owner: null, boundPort: null };
    await new Promise<void>((resolve) => {
        try { s.close(() => resolve()); } catch { resolve(); }
        setTimeout(resolve, 3000).unref?.();
    });
}

function getStatus(): Status {
    return { ...status, proxyIps: [...status.proxyIps] };
}

module.exports = { start, stop, getStatus, _bindReason: bindReason };
