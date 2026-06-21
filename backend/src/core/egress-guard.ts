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
function parseConnectArgs(args: any[]): { options: any; cb?: any } {
    const a = [...args];
    let cb: any;
    if (typeof a[a.length - 1] === 'function') cb = a.pop();
    let options: any = {};
    if (a[0] && typeof a[0] === 'object') options = { ...a[0] };
    else if (typeof a[0] === 'number' || (typeof a[0] === 'string' && /^\d+$/.test(a[0]))) {
        options = { port: Number(a[0]) };
        if (typeof a[1] === 'string') options.host = a[1];
    } else if (typeof a[0] === 'string') {
        options = { path: a[0] }; // IPC/unix-socket path (not a network destination)
    }
    return { options, cb };
}

function secureConnect(orig: any, thisArg: any, args: any[]): any {
    const { options, cb } = parseConnectArgs(args);
    const host = options.host || options.hostname;
    assertHostLiteral(host); // blocks an explicit private/loopback IP literal up-front
    // ALWAYS route name resolution through the validating lookup (unless it's a unix-socket/IPC path,
    // which isn't network egress). This covers the NO-HOST case too: net/tls default the host to
    // 'localhost' when none is given, and validatingLookup blocks 'localhost' → no silent loopback
    // connect. For an IP-literal host Node skips lookup, so assertHostLiteral above is the guard.
    if (!options.path) options.lookup = validatingLookup;
    return cb ? orig.call(thisArg, options, cb) : orig.call(thisArg, options);
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
    });
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
