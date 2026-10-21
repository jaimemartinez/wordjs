'use strict';
/**
 * WordJS gateway — TCP ports the gateway forwards to the backend node (Admin → Servers).
 *
 * In separate mode the gateway is the cluster's only public address, but some services run on the
 * backend node and speak their own protocol on their own port: the mail server's SMTP listener is the
 * case that made this necessary (QA X4-01) — internet mail aimed at the site's public address never
 * reached it, and the only way in was a NAT rule on another machine. The administrator can now ask the
 * gateway to listen on a port and pipe every connection to a port of the backend node, from the panel.
 *
 * Nothing here knows what the protocol is. Each forward is `{ port, targetPort, proxyProtocol }`:
 *   · port          the gateway's listen port (every interface), never one of its own listeners;
 *   · targetPort    the port on the backend node;
 *   · proxyProtocol prepend a PROXY protocol v1 line, so a receiver that trusts the gateway's address
 *                   (the mail server's "trusted proxies") still sees the real client address. On by default.
 * The backend host is the one the registry names for `/api` (the registered backend node), so a forward
 * never reaches an address an administrator typed.
 */

const net = require('net');

const MAX_FORWARDS = 10;

function portOrNull(v) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^[0-9]{1,5}$/.test(v) ? Number(v) : NaN);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * The forwards a push may set, or `{ error }`. `reserved` are the gateway's own ports (public, internal,
 * enrollment, ACME), which a forward may never take.
 */
function sanitizeForwards(list, reserved = []) {
    if (!Array.isArray(list)) return { error: 'forwards must be a list' };
    if (list.length > MAX_FORWARDS) return { error: `at most ${MAX_FORWARDS} forwards` };
    const out = [];
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (!f || typeof f !== 'object' || Array.isArray(f)) return { error: `forwards[${i}] must be an object` };
        const port = portOrNull(f.port);
        const targetPort = portOrNull(f.targetPort);
        if (port === null) return { error: `forwards[${i}].port must be a port number` };
        if (targetPort === null) return { error: `forwards[${i}].targetPort must be a port number` };
        if (reserved.includes(port)) return { error: `port ${port} is one of the gateway's own ports` };
        if (seen.has(port)) return { error: `port ${port} is listed twice` };
        seen.add(port);
        out.push({ port, targetPort, proxyProtocol: f.proxyProtocol !== false });
    }
    return { value: out };
}

/** The PROXY protocol v1 line for a client socket (RFC: haproxy proxy-protocol.txt, version 1). */
function proxyV1Line(socket) {
    const strip = (a) => String(a || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
    const src = strip(socket.remoteAddress);
    const dst = strip(socket.localAddress);
    const family = net.isIPv4(src) && net.isIPv4(dst) ? 'TCP4' : (net.isIPv6(src) && net.isIPv6(dst) ? 'TCP6' : null);
    if (!family) return 'PROXY UNKNOWN\r\n';
    return `PROXY ${family} ${src} ${dst} ${socket.remotePort} ${socket.localPort}\r\n`;
}

/**
 * The listeners. `backendHosts()` answers the hosts of the registered backend nodes (healthy first); a
 * connection goes to them in turn. `apply(forwards)` binds what is new, closes what is gone, and keeps
 * what did not change; `status()` says, per forward, whether it is listening or why not.
 */
function createForwarder({ backendHosts, logger, connectTimeoutMs = 10000 }) {
    const listeners = new Map(); // port -> { forward, server, bound, error }
    let rr = 0;

    const pickHost = () => {
        const hosts = backendHosts();
        if (!hosts.length) return null;
        rr = (rr + 1) % hosts.length;
        return hosts[rr];
    };

    const handle = (forward) => (client) => {
        client.on('error', () => { /* the client went away */ });
        const host = pickHost();
        if (!host) { client.destroy(); return; }
        const upstream = net.connect({ host, port: forward.targetPort });
        upstream.setTimeout(connectTimeoutMs, () => upstream.destroy());
        upstream.once('connect', () => {
            upstream.setTimeout(0);
            if (forward.proxyProtocol) upstream.write(proxyV1Line(client));
            client.pipe(upstream);
            upstream.pipe(client);
        });
        upstream.on('error', (e) => {
            logger.warn(`[Gateway] [Forward] :${forward.port} → backend:${forward.targetPort} failed: ${e.message}`);
            client.destroy();
        });
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
    };

    const close = (port) => {
        const l = listeners.get(port);
        if (!l) return;
        try { l.server.close(); } catch { /* already closed */ }
        listeners.delete(port);
    };

    const open = (forward) => {
        const server = net.createServer(handle(forward));
        const entry = { forward, server, bound: false, error: null };
        listeners.set(forward.port, entry);
        server.on('error', (e) => {
            entry.bound = false;
            entry.error = e.code === 'EACCES'
                ? `the gateway may not listen on port ${forward.port} (ports below 1024 need the privilege to bind them)`
                : e.code === 'EADDRINUSE' ? `port ${forward.port} is already in use on the gateway machine` : e.message;
            logger.warn(`[Gateway] [Forward] could not listen on :${forward.port}: ${entry.error}`);
        });
        server.listen(forward.port, () => {
            entry.bound = true;
            entry.error = null;
            logger.info(`[Gateway] [Forward] :${forward.port} → backend:${forward.targetPort}${forward.proxyProtocol ? ' (PROXY v1)' : ''}`);
        });
    };

    return {
        apply(forwards) {
            const wanted = new Map(forwards.map((f) => [f.port, f]));
            for (const port of [...listeners.keys()]) {
                const cur = listeners.get(port);
                const next = wanted.get(port);
                if (!next || next.targetPort !== cur.forward.targetPort || next.proxyProtocol !== cur.forward.proxyProtocol) close(port);
            }
            for (const f of forwards) if (!listeners.has(f.port)) open(f);
        },
        status() {
            return [...listeners.values()].map((l) => ({ ...l.forward, listening: l.bound, error: l.error }));
        },
        closeAll() { for (const port of [...listeners.keys()]) close(port); },
    };
}

module.exports = { sanitizeForwards, proxyV1Line, createForwarder, MAX_FORWARDS };
