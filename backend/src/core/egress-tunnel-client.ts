/**
 * WordJS - the plugin side of network egress (runs in the isolated child, never on the host).
 *
 * The child has no direct network at the kernel layer, so every outbound TCP connection a network-
 * granted plugin opens is carried by a TunnelSocket: a Duplex stream whose bytes travel over the IPC
 * channel to core/egress-tunnel on the host, which decides the destination and holds the real socket.
 *
 *   · Every TCP connect reaches net.Socket.prototype.connect (net.connect, net.createConnection,
 *     http.Agent, a bare `new net.Socket().connect()`); egress-guard's locked chokepoint there hands the
 *     socket to connectViaTunnel, which makes THAT socket carry the tunnel through its stream methods
 *     (_write, _final, _read, _destroy). The plugin keeps a genuine net.Socket with no native handle.
 *   · tls.connect without a `socket` opens such a socket and runs TLS over it here, so certificate
 *     checks stay in the plugin; with a `socket` (STARTTLS) Node already wraps a handle-less socket as a
 *     JS stream. A TLS socket never connects natively (that would put a native TCP handle under TLS).
 *   · undici (global fetch / WebSocket), https and ws use these paths, so they follow unchanged.
 *   · dns.lookup is answered by the host under the same policy.
 *
 * UDP (dgram) has no tunnel: a plugin cannot send datagrams.
 */
'use strict';

const realNet = require('net');
const realTls = require('tls');
const realDns = require('dns');
const { Duplex } = require('stream');

const WINDOW = 256 * 1024;
const CHUNK = 64 * 1024;

let post: ((m: any) => void) | null = null;
let nextSid = 1;
let nextRid = 1;
const sockets = new Map<number, any>();
const lookups = new Map<number, (err: any, addrs?: any[]) => void>();

function frame(m: any): void { if (post) post({ kind: 'net', ...m }); }

class TunnelSocket extends Duplex {
    connecting = true;
    pending = true;
    remoteAddress: string | undefined;
    remotePort: number | undefined;
    remoteFamily: string | undefined;
    localAddress: string | undefined;
    localPort: number | undefined;
    bytesRead = 0;
    bytesWritten = 0;
    private _sid: number;
    private _unacked = 0;
    private _blockedWrite: (() => void) | null = null;
    private _queued: Array<{ chunk: Buffer; cb: (e?: any) => void }> = [];
    private _deferredAck = 0;
    private _hostClosed = false;
    private _idleMs = 0;
    private _idleTimer: any = null;

    constructor(host: string, port: number, options: any = {}) {
        super({ allowHalfOpen: !!options.allowHalfOpen, emitClose: true });
        this._sid = nextSid++;
        sockets.set(this._sid, this);
        if (options.timeout) this.setTimeout(Number(options.timeout));
        // Asynchronous, like a real connect: callers attach their listeners first.
        process.nextTick(() => frame({ op: 'open', sid: this._sid, host, port }));
    }

    get readyState(): string { return this.connecting ? 'opening' : (this.readable && this.writable ? 'open' : this.readable ? 'readOnly' : this.writable ? 'writeOnly' : 'closed'); }

    _write(chunk: Buffer, _enc: string, cb: (e?: any) => void): void {
        if (this.connecting) { this._queued.push({ chunk, cb }); return; }
        this._send(chunk, cb);
    }
    private _send(chunk: Buffer, cb: (e?: any) => void): void {
        this._activity();
        for (let i = 0; i < chunk.length; i += CHUNK) frame({ op: 'data', sid: this._sid, chunk: chunk.subarray(i, i + CHUNK) });
        this.bytesWritten += chunk.length;
        this._unacked += chunk.length;
        if (this._unacked > WINDOW) this._blockedWrite = () => cb();
        else cb();
    }
    _final(cb: (e?: any) => void): void { if (!this._hostClosed) frame({ op: 'end', sid: this._sid }); cb(); }
    _read(): void {
        if (this._deferredAck) { frame({ op: 'ack', sid: this._sid, bytes: this._deferredAck }); this._deferredAck = 0; }
    }
    _destroy(err: any, cb: (e?: any) => void): void {
        if (this._idleTimer) clearTimeout(this._idleTimer);
        if (sockets.delete(this._sid) && !this._hostClosed) frame({ op: 'destroy', sid: this._sid });
        for (const q of this._queued.splice(0)) q.cb(err || new Error('socket destroyed'));
        cb(err);
    }

    setTimeout(ms: number, cb?: () => void): this {
        this._idleMs = Number(ms) || 0;
        if (cb) { if (this._idleMs) this.once('timeout', cb); else this.removeListener('timeout', cb); }
        this._activity();
        return this;
    }
    private _activity(): void {
        if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
        if (this._idleMs > 0 && !this.destroyed) {
            this._idleTimer = setTimeout(() => this.emit('timeout'), this._idleMs);
            if (this._idleTimer.unref) this._idleTimer.unref();
        }
    }
    setNoDelay(): this { return this; }
    setKeepAlive(): this { return this; }
    ref(): this { return this; }
    unref(): this { return this; }
    address(): any { return this.localAddress ? { address: this.localAddress, port: this.localPort, family: this.remoteFamily } : {}; }
    resetAndDestroy(): this { return this.destroy() as any; }
    destroySoon(): void { if (this.writable) this.end(); if (this.writableFinished) this.destroy(); else this.once('finish', () => this.destroy()); }

    /** Frames from the host for this stream. */
    _fromHost(m: any): void {
        switch (m.op) {
            case 'opened': {
                this.connecting = false;
                this.pending = false;
                this.remoteAddress = m.remoteAddress;
                this.remotePort = m.remotePort;
                this.remoteFamily = m.remoteFamily;
                this._activity();
                for (const q of this._queued.splice(0)) this._send(q.chunk, q.cb);
                this.emit('connect');
                this.emit('ready');
                return;
            }
            case 'data': {
                const c = m.chunk;
                if (!(c instanceof Uint8Array)) return;
                const buf = Buffer.from(c.buffer, c.byteOffset, c.length);
                this.bytesRead += buf.length;
                this._activity();
                if (this.push(buf)) frame({ op: 'ack', sid: this._sid, bytes: buf.length });
                else this._deferredAck += buf.length;
                return;
            }
            case 'ack': {
                this._unacked = Math.max(0, this._unacked - (Number(m.bytes) || 0));
                if (this._blockedWrite && this._unacked <= WINDOW) { const go = this._blockedWrite; this._blockedWrite = null; go(); }
                return;
            }
            case 'end': this.push(null); return;
            case 'error': {
                this._hostClosed = true;
                sockets.delete(this._sid);
                this.destroy(Object.assign(new Error(String(m.message || 'connection refused')), { code: String(m.code || 'ECONNREFUSED') }));
                return;
            }
            case 'close': {
                this._hostClosed = true;
                sockets.delete(this._sid);
                this.push(null);
                this.destroy();
                return;
            }
        }
    }
}

/** net.connect's argument shapes -> { host, port, options, cb }; a path (IPC/unix socket) is refused. */
function normalizeConnectArgs(args: any[]): { host: string; port: number; options: any; cb?: () => void } {
    let options: any;
    let cb: any;
    if (Array.isArray(args[0])) { options = args[0][0] || {}; cb = args[0][1]; }
    else if (args[0] && typeof args[0] === 'object') { options = args[0]; cb = args[1]; }
    else if (typeof args[0] === 'number' || (typeof args[0] === 'string' && /^\d+$/.test(args[0]))) {
        options = { port: Number(args[0]) };
        if (typeof args[1] === 'string') { options.host = args[1]; cb = args[2]; } else cb = args[1];
    } else if (typeof args[0] === 'string') {
        throw Object.assign(new Error('[sandbox] plugins cannot connect to a local socket path'), { code: 'EACCES' });
    } else options = {};
    if (options.path) throw Object.assign(new Error('[sandbox] plugins cannot connect to a local socket path'), { code: 'EACCES' });
    const host = String(options.host || options.hostname || 'localhost');
    return { host, port: Number(options.port), options, cb: typeof cb === 'function' ? cb : undefined };
}

/**
 * Make an unconnected net.Socket carry a tunnel stream: its own stream methods write to and read from
 * the tunnel, and it reports the connection the host opened. Called by egress-guard's connect chokepoint.
 */
function connectViaTunnel(sock: any, args: any[]): any {
    if (realTls.TLSSocket && sock instanceof realTls.TLSSocket) {
        // tls.connect is redirected before it gets here; a TLS socket that still connects natively would
        // put a native TCP handle under TLS. Refused rather than risk sending plaintext.
        return refuseDirectConnect(sock);
    }
    const { host, port, options, cb } = normalizeConnectArgs(args);
    const t = new TunnelSocket(host, port, {});
    sock.connecting = true;
    if (cb) sock.once('connect', cb);
    if (options && options.timeout) sock.setTimeout(Number(options.timeout));
    const touch = () => { try { if (typeof sock._unrefTimer === 'function') sock._unrefTimer(); } catch { /* */ } };
    sock._writev = undefined;
    sock._write = (chunk: any, enc: any, done: any) => { touch(); t.write(chunk, enc, done); };
    sock._final = (done: any) => { t.end(); done(); };
    sock._read = () => { t.resume(); };
    sock._destroy = (err: any, done: any) => { try { t.destroy(); } catch { /* */ } done(err); };
    const onData = (c: Buffer) => { touch(); if (!sock.push(c)) t.pause(); };
    const onEnd = () => sock.push(null);
    const onError = (e: any) => sock.destroy(e);
    const onClose = () => { if (!sock.destroyed && sock.readableEnded) sock.destroy(); };
    t.on('data', onData);
    t.on('end', onEnd);
    t.on('error', onError);
    t.on('close', onClose);
    // STARTTLS (tlsOverTunnel): TLS takes the stream over, as a real upgrade takes over the connection.
    // Destroying the plain socket afterwards still ends the connection, exactly as it would natively.
    sock[TUNNEL] = {
        stream: t,
        detach(): Buffer | null {
            t.removeListener('data', onData);
            t.removeListener('end', onEnd);
            t.removeListener('error', onError);
            t.removeListener('close', onClose);
            sock._read = () => { /* the TLS layer reads the stream now */ };
            const unread = sock.readableLength ? sock.read() : null;
            return Buffer.isBuffer(unread) ? unread : null;
        },
    };
    t.once('connect', () => {
        sock.connecting = false;
        sock._peername = { address: t.remoteAddress, port: t.remotePort, family: t.remoteFamily };
        touch();
        sock.emit('connect');
        sock.emit('ready');
    });
    return sock;
}

const TUNNEL = Symbol('wordjs.egressTunnel');

function tunnelTlsConnect(...args: any[]): any {
    // tls.connect(options[, cb]) | (port[, host][, options][, cb])
    let options: any = {};
    let cb: any;
    if (args[0] && typeof args[0] === 'object') { options = { ...args[0] }; cb = args[1]; }
    else {
        options.port = Number(args[0]);
        let i = 1;
        if (typeof args[i] === 'string') { options.host = args[i]; i++; }
        if (args[i] && typeof args[i] === 'object') { options = { ...args[i], ...options }; i++; }
        cb = args[i];
    }
    // TLS always runs over the tunnel stream itself: Node's TLS handshake does not progress over an
    // already-connected net.Socket that has no native handle, while it does over a plain Duplex.
    if (options.socket) {
        const link = options.socket[TUNNEL];
        if (!link) return realTlsConnect(options, cb);
        const unread = link.detach();
        if (unread) link.stream.unshift(unread);
        return realTlsConnect({ ...options, socket: link.stream }, cb);
    }
    const host = String(options.host || options.hostname || 'localhost');
    const stream = new TunnelSocket(host, Number(options.port), { timeout: options.timeout });
    if (!options.servername && !realNet.isIP(host)) options.servername = host;
    return realTlsConnect({ ...options, host, socket: stream }, cb);
}

let realTlsConnect: any = null;

/** dns.lookup answered by the host (same signature and callback shapes as Node's). */
function tunnelLookup(hostname: any, options: any, callback?: any): void {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof options === 'number') options = { family: options };
    options = options || {};
    const rid = nextRid++;
    lookups.set(rid, (err, addrs) => {
        if (err) return callback(err);
        const list = (addrs || []).map((a: any) => ({ address: String(a.address), family: Number(a.family) }));
        if (!list.length) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname }));
        // The in-plugin guard recognises an approved hostname's addresses as approved too (the host
        // judges them the same way): what nodemailer does is resolve, then connect to the address.
        try { require('./egress-guard').notePrivateResolution(String(hostname || ''), list); } catch { /* */ }
        if (options.all) return callback(null, list);
        return callback(null, list[0].address, list[0].family);
    });
    frame({ op: 'lookup', rid, host: String(hostname || ''), family: options.family || 0 });
}

function lock(obj: any, prop: string, value: any): void {
    const desc = Object.getOwnPropertyDescriptor(obj, prop);
    Object.defineProperty(obj, prop, { value, writable: false, configurable: false, enumerable: desc ? !!desc.enumerable : true });
}

let installed = false;
/** Install the tunnel in this child. `send` is the worker's authenticated frame sender. */
function installChildTunnel(send: (m: any) => void): void {
    if (installed) return;
    installed = true;
    post = send;
    realTlsConnect = realTls.connect.bind(realTls);
    // No tunnel for UDP: the guard's datagram paths refuse from now on.
    try { require('./egress-guard').refuseUdp(); } catch { /* */ }
    // net.connect / createConnection / http.Agent all bottom out in net.Socket.prototype.connect, where
    // egress-guard's chokepoint calls connectViaTunnel. Only tls.connect is redirected here. It stays
    // configurable: the plugin's `tls` is a Proxy over this module (egress-guard guardTls), and a Proxy may
    // not answer differently for a locked property. Nothing is lost: TLS cannot open a connection of its
    // own, because a TLSSocket that connects natively reaches the locked chokepoint and is refused there.
    Object.defineProperty(realTls, 'connect', { value: tunnelTlsConnect, writable: false, configurable: true, enumerable: true });
    try {
        const promisified = (host: any, options?: any) => new Promise((resolve, reject) => tunnelLookup(host, options || {}, (err: any, address: any, family: any) => {
            if (err) return reject(err);
            resolve(options && options.all ? address : { address, family });
        }));
        // util.promisify(dns.lookup) resolves { address, family } through Node's custom promisify symbol.
        (tunnelLookup as any)[require('util').promisify.custom] = promisified;
        // Not locked here: egress-guard's resolver gate (installed next) wraps it, judging a name by the
        // plugin's policy before the host is asked, and locks the result.
        Object.defineProperty(realDns, 'lookup', { value: tunnelLookup, writable: true, configurable: true, enumerable: true });
        if (realDns.promises) lock(realDns.promises, 'lookup', promisified);
    } catch { /* */ }
}

/** Every `{ kind: 'net' }` frame from the host. */
function handleHostFrame(m: any): void {
    if (!m || typeof m !== 'object') return;
    if (m.op === 'lookup-reply') {
        const done = lookups.get(Number(m.rid));
        if (!done) return;
        lookups.delete(Number(m.rid));
        if (m.code) return done(Object.assign(new Error(String(m.message || m.code)), { code: String(m.code) }));
        return done(null, Array.isArray(m.addresses) ? m.addresses : []);
    }
    const s = sockets.get(Number(m.sid));
    if (s) s._fromHost(m);
}

/** The direct connect a bare net.Socket would make: refused here, with the way that works. */
function refuseDirectConnect(socket: any): any {
    const err = Object.assign(new Error('[sandbox] a plugin opens connections with net.connect() / tls.connect() (or http, https, fetch); a bare net.Socket cannot reach the network here'), { code: 'EACCES' });
    process.nextTick(() => { try { socket.destroy(err); } catch { /* */ } });
    return socket;
}

module.exports = { installChildTunnel, handleHostFrame, connectViaTunnel, refuseDirectConnect, TunnelSocket, __normalizeConnectArgs: normalizeConnectArgs };
