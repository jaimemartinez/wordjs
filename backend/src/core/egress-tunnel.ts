/**
 * WordJS - the host side of a plugin's network egress.
 *
 * An isolated plugin has NO direct network at the kernel layer on any platform (Landlock + seccomp on
 * Linux, Seatbelt on macOS, an AppContainer without network capabilities on Windows). A plugin holding
 * the `network` grant reaches the network through this tunnel instead: its worker asks the host, over
 * the IPC channel it already has, to open host:port, and the host decides the exact destination, opens
 * the connection itself and relays the bytes. The rules are the egress guard's, applied here per plugin:
 *
 *   · the plugin holds the network grant, and its egress policy loaded (otherwise nothing opens);
 *   · the port is one the plugin may use (DNS and the web, the ports its manifest declares, the port of
 *     an approved private destination);
 *   · the host is on the plugin's allowlist when it has one;
 *   · loopback, private, link-local (cloud metadata) and other non-public addresses are refused unless
 *     an administrator approved that exact host:port, and the never-exempt ones even then;
 *   · a name is resolved ONCE, here, and the connection goes to the address that was judged (no DNS
 *     rebinding between the check and the connect);
 *   · bounded, so no plugin can starve the host: open streams per plugin AND across all plugins, a
 *     connect timeout, an idle timeout, bytes per stream, credit-based backpressure in both directions,
 *     and name lookups: getaddrinfo runs on libuv's small thread pool, which the host's own file and
 *     crypto work share, so a plugin may have only a couple in flight, the host only a few in total, and
 *     an unanswered one is given up on after a timeout.
 *
 * The plugin side is core/egress-tunnel-client; the wire format is the `{ kind: 'net', op, ... }` frames
 * both files define. Nothing here trusts the plugin: every frame is validated and a frame for a stream
 * the plugin does not own is ignored.
 */
'use strict';

const net = require('net');
const dns = require('dns');
const eg = require('./egress-guard');

/** What one plugin may reach, read from the permission store when a connection opens. */
export type EgressPolicy = {
    network: boolean;
    loaded: boolean;
    allowedHosts: string[];
    privateDestinations: string[];
    ports: number[];
};

const TUNNEL_LIMITS = {
    maxStreams: 64,
    connectTimeoutMs: 20000,
    idleTimeoutMs: 5 * 60 * 1000,
    maxBytesPerStream: 1024 * 1024 * 1024,
    window: 256 * 1024,
    maxChunk: 64 * 1024,
    maxLookups: 2,
    maxLookupsTotal: 4,
    lookupTimeoutMs: 10000,
    maxStreamsTotal: 512,
};

// Across every plugin on this host (each child has its own endpoint, all share these).
let streamsTotal = 0;
let lookupsTotal = 0;

const HOSTNAME_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

/** A refusal in the egress guard's own words, so callers that recognise "is blocked" keep doing so. */
function refusal(code: string, message: string): { code: string; message: string } {
    return { code, message: `[sandbox] network egress is blocked: ${message}` };
}

/** Normalize a host the plugin named: an IP literal (brackets dropped) or a lowercase ASCII hostname. */
function normalizeHost(host: any): { ip: string | null; name: string | null } | null {
    if (typeof host !== 'string' || !host || host.length > 253) return null;
    const raw = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const ip = eg.canonIp(raw);
    if (ip) return { ip: raw, name: null };
    if (!HOSTNAME_RE.test(raw)) return null;
    return { ip: null, name: raw };
}

function approvedPairs(policy: EgressPolicy): Array<{ host: string; ip: string | null; port: number }> {
    const out: Array<{ host: string; ip: string | null; port: number }> = [];
    for (const e of policy.privateDestinations || []) { const d = eg.parsePrivateDestination(e); if (d) out.push(d); }
    return out;
}

/**
 * Judge a destination BEFORE resolving it. Returns the refusal, or how to treat the resolved addresses:
 * `approved` (an administrator approved this exact host:port: only never-exempt addresses are refused)
 * or public-only.
 */
function judgeDestination(policy: EgressPolicy, host: any, port: any, resolvedApproved: Set<string> = new Set()): { refuse?: { code: string; message: string }; target?: { ip: string | null; name: string | null }; approved?: boolean; port?: number } {
    if (!policy.network) return { refuse: refusal('EACCES', 'this plugin does not hold the network grant') };
    if (!policy.loaded) return { refuse: refusal('EACCES', 'the network policy of this plugin is not available; no connection is opened until it is') };
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return { refuse: refusal('EINVAL', 'invalid port') };
    const target = normalizeHost(host);
    if (!target) return { refuse: refusal('EINVAL', 'invalid host') };
    const pairs = approvedPairs(policy);
    // An address counts as approved when it is the approved literal, or when the plugin got it by resolving
    // an approved hostname through this tunnel (how nodemailer connects: it resolves, then dials the address).
    const approved = pairs.some((d) => d.port === p && (target.ip ? d.ip === eg.canonIp(target.ip) : (!d.ip && d.host === target.name)))
        || (!!target.ip && resolvedApproved.has(`${eg.canonIp(target.ip)}|${p}`));
    if (!approved && !(policy.ports || []).includes(p)) {
        return { refuse: refusal('EACCES', `port ${p} is not one this plugin may connect to (declare it on its network permission)`) };
    }
    if (!approved && policy.allowedHosts && policy.allowedHosts.length && !eg.hostMatchesAllowlist(target.ip || target.name, policy.allowedHosts)) {
        return { refuse: refusal('EACCES', `${target.ip || target.name} is not on this plugin's list of allowed hosts`) };
    }
    if (target.ip) {
        if (approved && eg.isNeverExemptIp(target.ip)) return { refuse: refusal('EACCES', `${target.ip} cannot be reached by plugins`) };
        if (!approved && eg.isBlockedIp(target.ip)) return { refuse: refusal('EACCES', `${target.ip} is not a public address (an administrator can approve a private destination)`) };
    }
    return { target, approved, port: p };
}

/**
 * Resolve once and judge every address: one refused address refuses the name (no mixed answers).
 * getaddrinfo occupies a libuv pool thread, so the host-wide count is bounded and a slow answer is given
 * up on (the thread is freed when the system resolver returns; the plugin is not kept waiting).
 */
function resolveJudged(name: string, approved: boolean, cb: (err: any, addrs?: Array<{ address: string; family: number }>) => void): void {
    if (lookupsTotal >= TUNNEL_LIMITS.maxLookupsTotal) {
        return cb(Object.assign(new Error('[sandbox] network egress is blocked: too many name lookups in progress on this server; try again shortly'), { code: 'EAGAIN' }));
    }
    lookupsTotal++;
    let answered = false;
    const timer = setTimeout(() => {
        if (answered) return;
        answered = true;
        cb(Object.assign(new Error(`[sandbox] ${name} could not be resolved in time`), { code: 'ETIMEOUT' }));
    }, TUNNEL_LIMITS.lookupTimeoutMs);
    if (timer.unref) timer.unref();
    dns.lookup(name, { all: true, verbatim: true }, (err: any, list: any) => {
        lookupsTotal--;
        clearTimeout(timer);
        if (answered) return;
        answered = true;
        if (err) return cb(Object.assign(new Error(`[sandbox] ${name} could not be resolved`), { code: err.code || 'ENOTFOUND' }));
        const addrs: Array<{ address: string; family: number }> = Array.isArray(list) ? list : [];
        if (!addrs.length) return cb(Object.assign(new Error(`[sandbox] ${name} has no address`), { code: 'ENOTFOUND' }));
        for (const a of addrs) {
            const bad = approved ? eg.isNeverExemptIp(a.address) : eg.isBlockedIp(a.address);
            if (bad) return cb(Object.assign(new Error(`[sandbox] ${name} resolves to ${a.address}, which plugins cannot reach`), { code: 'EACCES' }));
        }
        cb(null, addrs);
    });
}

/**
 * One plugin's tunnel endpoint on the host. `send` delivers a frame to the plugin's worker; `policy`
 * reads the plugin's current egress policy. `handle` takes every `{ kind: 'net' }` frame from it.
 */
function createEgressTunnelHost(opts: { slug: string; send: (m: any) => any; policy: () => EgressPolicy; log?: (msg: string) => void }) {
    const streams = new Map<number, { socket: any; inFlight: number; paused: boolean; bytes: number; idle: any; closed: boolean }>();
    let lookups = 0;
    // `ip|port` pairs an approved hostname resolved to (bounded), see judgeDestination.
    const resolvedApproved = new Set<string>();
    const noteResolved = (name: string, addrs: Array<{ address: string }>) => {
        const ports = approvedPairs(opts.policy()).filter((d) => !d.ip && d.host === name).map((d) => d.port);
        if (!ports.length) return;
        if (resolvedApproved.size > 1024) resolvedApproved.clear();
        for (const a of addrs) { const c = eg.canonIp(a.address); if (c) for (const port of ports) resolvedApproved.add(`${c}|${port}`); }
    };
    const send = (m: any) => { try { opts.send({ kind: 'net', ...m }); } catch { /* the plugin is gone */ } };

    function closeStream(sid: number, how: 'close' | 'error', err?: { code: string; message: string }): void {
        const s = streams.get(sid);
        if (!s || s.closed) return;
        s.closed = true;
        streams.delete(sid);
        streamsTotal--;
        if (s.idle) clearTimeout(s.idle);
        try { s.socket.destroy(); } catch { /* */ }
        if (how === 'error' && err) send({ op: 'error', sid, code: err.code, message: err.message });
        else send({ op: 'close', sid });
    }
    function touch(sid: number): void {
        const s = streams.get(sid);
        if (!s) return;
        if (s.idle) clearTimeout(s.idle);
        s.idle = setTimeout(() => closeStream(sid, 'error', refusal('ETIMEDOUT', 'the connection was idle too long')), TUNNEL_LIMITS.idleTimeoutMs);
        if (s.idle.unref) s.idle.unref();
    }

    function open(sid: number, host: any, port: any): void {
        if (streams.has(sid)) return;
        if (streams.size >= TUNNEL_LIMITS.maxStreams) return void send({ op: 'error', sid, ...refusal('EMFILE', `a plugin may hold ${TUNNEL_LIMITS.maxStreams} connections at once`) });
        if (streamsTotal >= TUNNEL_LIMITS.maxStreamsTotal) return void send({ op: 'error', sid, ...refusal('EMFILE', 'the plugins on this server hold as many connections as it allows; try again shortly') });
        const verdict = judgeDestination(opts.policy(), host, port, resolvedApproved);
        if (verdict.refuse) return void send({ op: 'error', sid, ...verdict.refuse });
        const { target, approved } = verdict;
        // Reserve the slot now, so concurrent opens cannot exceed the cap while a name resolves.
        const s: any = { socket: null, inFlight: 0, paused: false, bytes: 0, idle: null, closed: false };
        streams.set(sid, s);
        streamsTotal++;
        // Every judged address in turn, as Node's own connect does when a name has several (`localhost`
        // is ::1 and 127.0.0.1): the next one is tried when one refuses or is unreachable.
        const connectTo = (addresses: string[]) => {
            if (s.closed) return;
            const address = addresses[0];
            const socket = net.connect({ host: address, port: verdict.port });
            s.socket = socket;
            let opened = false;
            const timer = setTimeout(() => closeStream(sid, 'error', { code: 'ETIMEDOUT', message: `connect ETIMEDOUT ${address}:${verdict.port}` }), TUNNEL_LIMITS.connectTimeoutMs);
            if (timer.unref) timer.unref();
            socket.once('error', (e: any) => {
                if (opened || s.closed || addresses.length < 2) return;
                clearTimeout(timer);
                socket.removeAllListeners();
                try { socket.destroy(); } catch { /* */ }
                connectTo(addresses.slice(1));
            });
            socket.once('connect', () => {
                opened = true;
                clearTimeout(timer);
                if (s.closed) return;
                touch(sid);
                send({ op: 'opened', sid, remoteAddress: socket.remoteAddress, remotePort: socket.remotePort, remoteFamily: socket.remoteFamily });
            });
            socket.on('data', (chunk: Buffer) => {
                if (s.closed) return;
                s.bytes += chunk.length;
                if (s.bytes > TUNNEL_LIMITS.maxBytesPerStream) return closeStream(sid, 'error', refusal('EFBIG', 'the connection carried more data than a plugin may move on one connection'));
                touch(sid);
                for (let i = 0; i < chunk.length; i += TUNNEL_LIMITS.maxChunk) send({ op: 'data', sid, chunk: chunk.subarray(i, i + TUNNEL_LIMITS.maxChunk) });
                s.inFlight += chunk.length;
                if (s.inFlight > TUNNEL_LIMITS.window && !s.paused) { s.paused = true; socket.pause(); }
            });
            socket.on('end', () => { if (!s.closed) send({ op: 'end', sid }); });
            socket.on('error', (e: any) => {
                if (!opened && addresses.length > 1) return; // the next address is tried (above)
                clearTimeout(timer);
                closeStream(sid, 'error', { code: (e && e.code) || 'ECONNRESET', message: String((e && e.message) || e) });
            });
            socket.on('close', () => { if (!opened && addresses.length > 1) return; clearTimeout(timer); closeStream(sid, 'close'); });
        };
        if (target!.ip) return connectTo([target!.ip]);
        if (lookups >= TUNNEL_LIMITS.maxLookups) {
            s.closed = true; streams.delete(sid); streamsTotal--;
            return void send({ op: 'error', sid, ...refusal('EAGAIN', 'too many name lookups at once for this plugin') });
        }
        lookups++;
        resolveJudged(target!.name as string, !!approved, (err, addrs) => {
            lookups--;
            if (err) { if (!s.closed) { s.closed = true; streams.delete(sid); streamsTotal--; } return send({ op: 'error', sid, code: err.code, message: err.message }); }
            if (approved) noteResolved(target!.name as string, addrs!);
            connectTo(addrs!.map((a) => a.address));
        });
    }

    function lookup(rid: number, host: any, family: any): void {
        if (lookups >= TUNNEL_LIMITS.maxLookups) return void send({ op: 'lookup-reply', rid, code: 'EAGAIN', message: '[sandbox] too many name lookups at once' });
        const policy = opts.policy();
        const target = normalizeHost(host);
        if (!policy.network || !policy.loaded) return void send({ op: 'lookup-reply', rid, code: 'EACCES', message: '[sandbox] this plugin may not resolve names' });
        if (!target) return void send({ op: 'lookup-reply', rid, code: 'ENOTFOUND', message: '[sandbox] invalid host name' });
        if (target.ip) return void send({ op: 'lookup-reply', rid, addresses: [{ address: target.ip, family: net.isIP(target.ip) }] });
        const approvedName = approvedPairs(policy).some((d) => !d.ip && d.host === target.name);
        if (!approvedName && policy.allowedHosts && policy.allowedHosts.length && !eg.hostMatchesAllowlist(target.name, policy.allowedHosts)) {
            return void send({ op: 'lookup-reply', rid, code: 'EACCES', message: `[sandbox] ${target.name} is not on this plugin's list of allowed hosts` });
        }
        lookups++;
        resolveJudged(target.name as string, approvedName, (err, addrs) => {
            lookups--;
            if (err) return send({ op: 'lookup-reply', rid, code: err.code, message: err.message });
            if (approvedName) noteResolved(target.name as string, addrs!);
            const fam = Number(family);
            const list = (fam === 4 || fam === 6) ? addrs!.filter((a) => a.family === fam) : addrs!;
            send({ op: 'lookup-reply', rid, addresses: list });
        });
    }

    function handle(msg: any): void {
        if (!msg || typeof msg !== 'object') return;
        const sid = Number(msg.sid);
        switch (msg.op) {
            case 'open': if (Number.isInteger(sid) && sid > 0) open(sid, msg.host, msg.port); return;
            case 'lookup': if (Number.isInteger(Number(msg.rid))) lookup(Number(msg.rid), msg.host, msg.family); return;
        }
        const s = streams.get(sid);
        if (!s || !s.socket) return;
        switch (msg.op) {
            case 'data': {
                const chunk = msg.chunk;
                if (!(chunk instanceof Uint8Array) || chunk.length > TUNNEL_LIMITS.maxChunk) return closeStream(sid, 'error', refusal('EINVAL', 'invalid data frame'));
                const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
                s.bytes += buf.length;
                if (s.bytes > TUNNEL_LIMITS.maxBytesPerStream) return closeStream(sid, 'error', refusal('EFBIG', 'the connection carried more data than a plugin may move on one connection'));
                touch(sid);
                s.socket.write(buf, () => send({ op: 'ack', sid, bytes: buf.length }));
                return;
            }
            case 'ack': {
                s.inFlight = Math.max(0, s.inFlight - (Number(msg.bytes) || 0));
                if (s.paused && s.inFlight <= TUNNEL_LIMITS.window / 2) { s.paused = false; s.socket.resume(); }
                return;
            }
            case 'end': try { s.socket.end(); } catch { /* */ } return;
            case 'destroy': closeStream(sid, 'close'); return;
        }
    }

    function closeAll(): void { for (const sid of Array.from(streams.keys())) closeStream(sid, 'close'); }

    return { handle, closeAll, get openStreams() { return streams.size; } };
}

// ── The platform probes ──────────────────────────────────────────────────────────────────────────
// Each OS's probe certifies, in its confined child, that a direct connect is refused by the kernel AND
// that the tunnel works: a public host opens through it and the cloud metadata address is refused. The
// child speaks the same frames a worker does, and the host side below is this module's real code.

/** JS for a probe child: two opens through the tunnel; calls `cbName(publicVerdict, metadataVerdict)`. */
function probeTunnelSnippet(cbName: string): string {
    return [
        'var __wjt={pub:null,meta:null,done:false};',
        "process.on('message',function(m){if(!m||m.kind!=='net'||__wjt.done)return;",
        "var v=m.op==='opened'?'opened':(m.op==='error'?String(m.code||'ERR'):null);if(v===null)return;",
        // No close from the child: a frame arriving later would reach the probe's own message handlers.
        // The host closes both streams when the probe child exits (attachProbeTunnel).
        "if(m.sid===1&&__wjt.pub===null){__wjt.pub=v;}",
        "if(m.sid===2&&__wjt.meta===null){__wjt.meta=v;}",
        `if(__wjt.pub!==null&&__wjt.meta!==null){__wjt.done=true;${cbName}(__wjt.pub,__wjt.meta);}});`,
        "process.send({kind:'net',op:'open',sid:1,host:'1.1.1.1',port:443});",
        "process.send({kind:'net',op:'open',sid:2,host:'169.254.169.254',port:80});",
    ].join('');
}
const PROBE_POLICY: EgressPolicy = { network: true, loaded: true, allowedHosts: [], privateDestinations: [], ports: [80, 443] };
/** Serve a probe child's tunnel frames with the real host side (public destinations, ports 80/443). */
function attachProbeTunnel(child: { send: (m: any) => any; on: (event: string, cb: (...a: any[]) => void) => any }): void {
    const host = createEgressTunnelHost({ slug: '__probe__', send: (m: any) => { try { child.send(m); } catch { /* gone */ } }, policy: () => PROBE_POLICY });
    child.on('message', (m: any) => { if (m && typeof m === 'object' && m.kind === 'net') host.handle(m); });
    child.on('exit', () => host.closeAll());
}
/** The probe's tunnel verdict: the public host opened and the metadata address was refused. */
function probeTunnelOk(verdict: any): boolean {
    return verdict === 'public=opened;metadata=EACCES';
}

module.exports = { createEgressTunnelHost, judgeDestination, TUNNEL_LIMITS, probeTunnelSnippet, attachProbeTunnel, probeTunnelOk };
