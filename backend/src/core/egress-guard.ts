/**
 * WordJS — Sandbox network egress guard.
 *
 * When an admin grants a plugin the `network` permission, the raw socket modules (net/tls/http/https/
 * http2/dgram) and the binding-backed globals (fetch/WebSocket) open up. WITHOUT a destination filter
 * that lets a plugin reach the cloud metadata endpoint (169.254.169.254 → IAM creds), loopback, and
 * RFC1918 internal services — a full SSRF + exfiltration surface. This module confines outbound
 * connections to PUBLIC destinations: it blocks loopback / link-local / private / CGNAT / ULA /
 * unspecified / multicast ranges, fails CLOSED on resolution error, and validates the ACTUAL resolved
 * IP at connect time (anti-DNS-rebinding) by injecting a validating `lookup` into every connect path.
 *
 * Loaded during the sandbox bootstrap (before a plugin slug is on the stack), so its own
 * net/tls/dns/... requires resolve to the REAL modules, not the secure-require proxies. secure-require
 * hands a plugin the GUARDED module instead of the real one when network is granted; the worker wraps
 * the global fetch/WebSocket with the same policy.
 */
'use strict';

import * as net from 'net';
import * as dns from 'dns';

// Capture the real modules at load time (bootstrap = no plugin context, so these are unproxied).
const realNet: any = net;
const realDns: any = dns;
let realTls: any, realHttp: any, realHttps: any, realHttp2: any, realDgram: any;
try { realTls = require('tls'); } catch { /* */ }
try { realHttp = require('http'); } catch { /* */ }
try { realHttps = require('https'); } catch { /* */ }
try { realHttp2 = require('http2'); } catch { /* */ }
try { realDgram = require('dgram'); } catch { /* */ }

function isBlockedV4(a: string): boolean {
    const p = a.split('.').map((n) => parseInt(n, 10));
    if (p.length !== 4 || p.some((n) => isNaN(n) || n < 0 || n > 255)) return true;
    const [x, y] = p;
    if (x === 0) return true;                          // 0.0.0.0/8 "this host"
    if (x === 10) return true;                         // 10.0.0.0/8 private
    if (x === 127) return true;                        // 127.0.0.0/8 loopback
    if (x === 169 && y === 254) return true;           // 169.254.0.0/16 link-local (incl. 169.254.169.254 cloud metadata)
    if (x === 172 && y >= 16 && y <= 31) return true;  // 172.16.0.0/12 private
    if (x === 192 && y === 168) return true;           // 192.168.0.0/16 private
    if (x === 100 && y >= 64 && y <= 127) return true; // 100.64.0.0/10 CGNAT
    if (x === 192 && y === 0 && p[2] === 0) return true; // 192.0.0.0/24 IETF protocol assignments
    if (x >= 224) return true;                         // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
    return false;
}

/**
 * True if an IP (literal) must NOT be reached by plugin egress. Callers pass RESOLVED IPs (the
 * validating lookup) or IP literals from connect args. Anything that isn't a parseable public IP is
 * blocked (fail closed).
 */
export function isBlockedIp(ip: string): boolean {
    if (!ip || typeof ip !== 'string') return true;
    let a = ip.replace(/^\[|\]$/g, '');                // strip [..] brackets
    const z = a.indexOf('%'); if (z >= 0) a = a.slice(0, z); // strip IPv6 zone id
    const fam = realNet.isIP(a);
    if (fam === 4) return isBlockedV4(a);
    if (fam === 6) {
        const lower = a.toLowerCase();
        if (lower === '::1' || lower === '::') return true;     // loopback / unspecified
        if (lower.startsWith('fe80')) return true;             // fe80::/10 link-local
        if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;     // fc00::/7 unique-local
        if (/^ff[0-9a-f]{2}:/.test(lower)) return true;        // ff00::/8 multicast
        const m = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // IPv4-mapped (dotted)
        if (m) return isBlockedV4(m[1]);
        const h = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);       // IPv4-mapped (hex)
        if (h) {
            const hi = parseInt(h[1], 16), lo = parseInt(h[2], 16);
            return isBlockedV4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
        }
        return false; // a public-looking IPv6
    }
    return true; // not a valid IP literal → block
}

function blockErr(target: string, host?: string): Error {
    return new Error(`[sandbox] network egress to ${target}${host && host !== target ? ` (${host})` : ''} is blocked — only public destinations are allowed for plugins`);
}

/** dns.lookup-compatible function that rejects any hostname resolving to a blocked IP. */
export function validatingLookup(hostname: string, options: any, callback?: any): void {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};
    realDns.lookup(hostname, { ...options, all: true, verbatim: true }, (err: any, addresses: any) => {
        if (err) return callback(err);
        const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
        for (const a of list) {
            if (isBlockedIp(a.address)) return callback(blockErr(a.address, hostname));
        }
        if (options.all) return callback(null, list);
        return callback(null, list[0].address, list[0].family);
    });
}

function assertHostLiteral(host: string | undefined): void {
    if (host && realNet.isIP(host) && isBlockedIp(host)) throw blockErr(host);
}

// ---- connect-arg normalization (net/tls) -------------------------------------------------------
// Find the LIVE options object Node's connect will use, WITHOUT copying it, and preserve the exact arg
// SHAPE the underlying connect expects. CRITICAL: net.connect/net.createConnection (and http/https via
// createConnection) pre-normalize their args into a single `[options, cb]` array (tagged) BEFORE calling
// Socket.prototype.connect — so the patched prototype receives args === `[ [options, cb] ]`. We must NOT
// treat that array as an options object (that loses host/port → ERR_MISSING_ARGS); we unwrap to the inner
// options and mutate it in place, leaving the tagged array intact for the real connect.
function extractConnectOptions(args: any[]): { options: any | null; rewrite?: any[] } {
    const a0 = args[0];
    if (Array.isArray(a0)) return { options: (a0[0] && typeof a0[0] === 'object') ? a0[0] : null }; // [options, cb]
    if (a0 && typeof a0 === 'object') return { options: a0 };                                        // connect(options[, cb])
    if (typeof a0 === 'number' || (typeof a0 === 'string' && /^\d+$/.test(a0))) {                    // connect(port[, host][, cb])
        const options: any = { port: Number(a0) };
        let cb: any;
        if (typeof args[1] === 'string') { options.host = args[1]; if (typeof args[2] === 'function') cb = args[2]; }
        else if (typeof args[1] === 'function') cb = args[1];
        return { options, rewrite: cb ? [options, cb] : [options] };
    }
    if (typeof a0 === 'string') return { options: { path: a0 } };                                    // IPC/unix-socket path
    return { options: null };
}

function secureConnect(orig: any, thisArg: any, args: any[]): any {
    const { options, rewrite } = extractConnectOptions(args);
    if (options && typeof options === 'object') {
        // TOCTOU DEFENSE (EG-TOCTOU): a plugin can pass an options object whose host/hostname/path is a
        // GETTER returning a benign value to US and a forbidden one to Node's LATER re-read (Node re-reads
        // options.host/path in lookupAndConnect; an IP-literal host skips the injected lookup entirely). So
        // read each security field EXACTLY ONCE into a primitive, validate that, then OVERWRITE the field
        // as a plain own data-property so Node connects to EXACTLY what we validated — no second read of a
        // getter is possible.
        const hostVal = options.host;
        const hostnameVal = options.hostname;
        const pathVal = options.path;
        // IPC / unix-socket / named-pipe targets are NOT public-internet egress (e.g. /var/run/docker.sock
        // = container/host RCE, a postgres/redis socket). Deny outright. (EG-2)
        if (pathVal !== undefined && pathVal !== null && pathVal !== '') throw blockErr('local IPC/unix-socket path');
        assertHostLiteral(hostVal || hostnameVal); // blocks an explicit private/loopback IP literal up-front
        // Freeze the snapshots back as own data-properties (replacing any getter). ALWAYS (even undefined)
        // so no getter survives for host/hostname/path.
        for (const [k, val] of [['host', hostVal], ['hostname', hostnameVal], ['path', pathVal]] as const) {
            try { Object.defineProperty(options, k, { value: val, writable: true, configurable: true, enumerable: true }); } catch { /* non-configurable: best-effort */ }
        }
        // Route resolution through the validating lookup (covers the NO-HOST default-localhost case and
        // hostnames — validated + IP-checked at connect, anti-rebinding).
        options.lookup = validatingLookup;
    }
    return orig.apply(thisArg, rewrite || args);
}

// Return a Proxy over a builtin that swaps in our guarded functions and forwards everything else to
// the REAL module. (We can't Object.create(mod)+assign: builtins expose connect/request/... as
// getter-only accessors, so assignment throws "has only a getter".) Module getters run against the
// real target (receiver=target) so their internal `this` stays correct.
function wrapModule(mod: any, overrides: Record<string, any>): any {
    return new Proxy(mod, {
        get(target, prop) {
            if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
            return Reflect.get(target, prop);
        },
    });
}

function guardNet(mod: any): any {
    // Cover `new net.Socket().connect(...)` too.
    class GuardedSocket extends mod.Socket {
        connect(...args: any[]) { return secureConnect(mod.Socket.prototype.connect, this, args); }
    }
    return wrapModule(mod, {
        connect: (...args: any[]) => secureConnect(mod.connect, mod, args),
        createConnection: (...args: any[]) => secureConnect(mod.createConnection, mod, args),
        Socket: GuardedSocket,
        Stream: GuardedSocket, // `net.Stream` is a legacy alias of the real Socket — guard it identically
    });
}

// THE definitive egress enforcement for the isolated child: patch the REAL net.Socket.prototype.connect
// so EVERY outbound TCP connection is validated, no matter how the socket was obtained — net.connect,
// net.createConnection, `new net.Socket()`, the `net.Stream` alias, `Object.getPrototypeOf(Socket.
// prototype).connect`, an http(s) custom agent/createConnection, AND the connect that undici (global
// fetch / WebSocket) performs under the hood. Module-name overrides alone are bypassable; the prototype
// is the single chokepoint. SAFE ONLY in the child: the whole child process is ONE plugin (its core
// bootstrap + IPC bridge never use net), so constraining the shared prototype here cannot affect host
// code. NEVER call this on the host (it would wrongly constrain core). Idempotent.
let childNetGuardInstalled = false;
export function installChildNetGuard(): void {
    if (childNetGuardInstalled) return;
    childNetGuardInstalled = true;
    try {
        const proto = realNet.Socket && realNet.Socket.prototype;
        if (proto && typeof proto.connect === 'function' && !(proto.connect as any).__wjGuarded) {
            const origConnect = proto.connect;
            const desc = Object.getOwnPropertyDescriptor(proto, 'connect');
            const patched = function (this: any, ...args: any[]) { return secureConnect(origConnect, this, args); };
            (patched as any).__wjGuarded = true;
            // LOCK it: a network-granted plugin must NOT be able to reassign net.Socket.prototype.connect
            // (e.g. `Object.getPrototypeOf(require('net').Socket.prototype).connect = raw`) back to the raw
            // one — that would un-patch the chokepoint and restore SSRF (metadata/loopback/private) via
            // fetch redirects + DNS-rebinding. non-writable + non-configurable makes the override permanent
            // for the life of the child. origConnect lives only in this closure, unreachable from plugin
            // code. (EG-1)
            Object.defineProperty(proto, 'connect', { value: patched, writable: false, configurable: false, enumerable: desc ? !!desc.enumerable : false });
        }
    } catch { /* best-effort; module-level wrappers remain as defense */ }
}

function guardTls(mod: any): any {
    return wrapModule(mod, { connect: (...args: any[]) => secureConnect(mod.connect, mod, args) });
}

// ---- http/https/http2 --------------------------------------------------------------------------
function normalizeHttpArgs(args: any[]): { url?: any; options: any; cb?: any } {
    const a = [...args];
    let cb: any;
    if (typeof a[a.length - 1] === 'function') cb = a.pop();
    let url: any, options: any = {};
    if (typeof a[0] === 'string' || a[0] instanceof URL) { url = a[0]; options = (a[1] && typeof a[1] === 'object') ? { ...a[1] } : {}; }
    else if (a[0] && typeof a[0] === 'object') options = { ...a[0] };
    return { url, options, cb };
}

function guardHttp(mod: any): any {
    const wrap = (orig: any) => function (...args: any[]) {
        const { url, options, cb } = normalizeHttpArgs(args);
        let host = options.host || options.hostname;
        if (!host && url) { try { host = new URL(String(url)).hostname; } catch { /* */ } }
        assertHostLiteral(host);
        // Always inject the validating lookup (unless a unix-socket), so http(s).request({port}) with no
        // host — which defaults to 'localhost' — is validated (and blocked) instead of silently hitting
        // loopback. IP-literal hosts skip lookup and are covered by assertHostLiteral above.
        if (!options.socketPath) options.lookup = validatingLookup;
        const rebuilt = url !== undefined ? [url, options] : [options];
        if (cb) rebuilt.push(cb);
        return orig.apply(mod, rebuilt);
    };
    const overrides: Record<string, any> = {};
    if (typeof mod.request === 'function') overrides.request = wrap(mod.request);
    if (typeof mod.get === 'function') overrides.get = wrap(mod.get);
    return wrapModule(mod, overrides);
}

function guardHttp2(mod: any): any {
    const overrides: Record<string, any> = {};
    if (typeof mod.connect === 'function') {
        overrides.connect = function (authority: any, options: any, listener: any) {
            let host: string | undefined;
            try { host = new URL(String(authority)).hostname; } catch { /* */ }
            assertHostLiteral(host);
            options = options && typeof options === 'object' ? { ...options } : {};
            if (host && !realNet.isIP(host)) options.lookup = validatingLookup;
            return mod.connect(authority, options, listener);
        };
    }
    return wrapModule(mod, overrides);
}

function guardDgram(mod: any): any {
    const overrides: Record<string, any> = {};
    if (typeof mod.createSocket === 'function') {
        overrides.createSocket = function (...args: any[]) {
            const sock = mod.createSocket(...args);
            const origSend = sock.send.bind(sock);
            sock.send = function (...sargs: any[]) {
                // dgram.send(msg, [offset, length,] port, address, cb): the destination host is the last
                // string arg. dgram has no `lookup` option, so resolve+validate hostnames ourselves.
                const cb = typeof sargs[sargs.length - 1] === 'function' ? sargs[sargs.length - 1] : undefined;
                const strs = sargs.filter((x) => typeof x === 'string');
                const address = strs.length ? strs[strs.length - 1] : undefined;
                if (address && realNet.isIP(address)) {
                    try { assertHostLiteral(address); } catch (e) { if (cb) { cb(e); return; } throw e; }
                    return origSend(...sargs);
                }
                if (address) {
                    realDns.lookup(address, { all: true, verbatim: true }, (err: any, addrs: any) => {
                        if (err) { if (cb) cb(err); return; }
                        const list = Array.isArray(addrs) ? addrs : [{ address: addrs }];
                        for (const a of list) { if (isBlockedIp(a.address)) { const e = blockErr(a.address, address); if (cb) cb(e); return; } }
                        origSend(...sargs);
                    });
                    return;
                }
                return origSend(...sargs); // no explicit address (dgram defaults to 127.0.0.1; UDP, no read-back)
            };
            // Connected dgram: `sock.connect(port[, address][, cb])` then send() with no address. Validate
            // the destination host here too, else a connected-send reaches loopback/private unvalidated. (EG-3)
            if (typeof sock.connect === 'function') {
                const origConnect = sock.connect.bind(sock);
                sock.connect = function (...cargs: any[]) {
                    const cb = typeof cargs[cargs.length - 1] === 'function' ? cargs[cargs.length - 1] : undefined;
                    const address = cargs.find((x: any, i: number) => i > 0 && typeof x === 'string'); // arg after port
                    if (!address) { const e = blockErr('127.0.0.1 (dgram connect default)'); if (cb) { cb(e); return; } throw e; }
                    if (realNet.isIP(address)) {
                        try { assertHostLiteral(address); } catch (e) { if (cb) { cb(e as Error); return; } throw e; }
                        return origConnect(...cargs);
                    }
                    realDns.lookup(address, { all: true, verbatim: true }, (err: any, addrs: any) => {
                        if (err) { if (cb) cb(err); return; }
                        const list = Array.isArray(addrs) ? addrs : [{ address: addrs }];
                        for (const a of list) { if (isBlockedIp(a.address)) { const e = blockErr(a.address, address); if (cb) cb(e); return; } }
                        origConnect(...cargs);
                    });
                };
            }
            return sock;
        };
    }
    return wrapModule(mod, overrides);
}

const guardedCache: Record<string, any> = {};

/**
 * Return the egress-guarded version of a network builtin for a plugin, or undefined to let the loader
 * hand back the real module (dns: resolution itself is not the SSRF sink — the connect is).
 */
export function getGuardedModule(base: string): any {
    if (base === 'dns') return undefined;
    if (guardedCache[base]) return guardedCache[base];
    let g: any;
    switch (base) {
        case 'net': g = guardNet(realNet); break;
        case 'tls': g = realTls ? guardTls(realTls) : undefined; break;
        case 'http': g = realHttp ? guardHttp(realHttp) : undefined; break;
        case 'https': g = realHttps ? guardHttp(realHttps) : undefined; break;
        case 'http2': g = realHttp2 ? guardHttp2(realHttp2) : undefined; break;
        case 'dgram': g = realDgram ? guardDgram(realDgram) : undefined; break;
        default: return undefined;
    }
    if (g) guardedCache[base] = g;
    return g;
}

/** Throw synchronously if a URL's host is a blocked IP literal (used for WebSocket). */
export function assertUrlAllowedSync(rawUrl: string): void {
    let host: string | undefined;
    try { host = new URL(String(rawUrl)).hostname; } catch { return; }
    assertHostLiteral(host);
}

/** Resolve + validate a URL's host; rejects (throws) if it resolves to a blocked IP. For fetch. */
export async function assertUrlAllowed(rawUrl: string): Promise<void> {
    let host: string | undefined;
    try { host = new URL(String(rawUrl)).hostname; } catch { return; } // non-URL (e.g. relative) → let fetch handle
    if (!host) return;
    if (realNet.isIP(host)) { assertHostLiteral(host); return; }
    await new Promise<void>((resolve, reject) => {
        realDns.lookup(host as string, { all: true, verbatim: true }, (err: any, addresses: any) => {
            if (err) return reject(err); // fail closed
            const list = Array.isArray(addresses) ? addresses : [{ address: addresses }];
            for (const a of list) { if (isBlockedIp(a.address)) return reject(blockErr(a.address, host)); }
            resolve();
        });
    });
}
