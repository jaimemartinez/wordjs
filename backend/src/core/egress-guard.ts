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

// Capture the RAW dgram prototype methods NOW — at module load, i.e. BEFORE installChildDgramGuard()
// replaces them on the prototype. Both the in-place prototype patch AND the module-wrapper (guardDgram)
// then delegate to this SAME unguarded impl, so a socket never gets double-validated (its instance/
// subclass override shadows the patched prototype but still bottoms out here).
const realDgramSend: any = realDgram && realDgram.Socket && realDgram.Socket.prototype.send;
const realDgramConnect: any = realDgram && realDgram.Socket && realDgram.Socket.prototype.connect;
// #19: also capture the raw disconnect() — it resets Node's internal connectState to "unconnected", so it
// must drop the socket from the connected-state WeakSet (below) or a later no-address send() would default
// to loopback while the guard still believed the socket was "connected to a validated destination".
const realDgramDisconnect: any = realDgram && realDgram.Socket && realDgram.Socket.prototype.disconnect;

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
 * Parse an IPv6 literal to its canonical 16 bytes, or null if unparseable. Handles '::' compression
 * and an embedded trailing IPv4 (e.g. ::ffff:1.2.3.4). Input is assumed already validated by
 * net.isIP()===6. CRITICAL: we must classify by NUMERIC bytes, not textual shape — the loopback string
 * '::1' has infinitely many spellings ('0:0:0:0:0:0:0:1', '0::1', '::01', …) and IPv4-mapped metadata
 * '::ffff:169.254.169.254' likewise ('0:0:0:0:0:ffff:a9fe:a9fe'), all of which a string match misses.
 */
function ipv6ToBytes(input: string): number[] | null {
    let s = input.toLowerCase();
    // Split an embedded trailing dotted-IPv4 into two hextets so the rest parses as pure hex groups.
    const v4m = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4m) {
        const oct = v4m[1].split('.').map((n) => parseInt(n, 10));
        if (oct.length !== 4 || oct.some((n) => isNaN(n) || n < 0 || n > 255)) return null;
        const tail = (((oct[0] << 8) | oct[1]).toString(16)) + ':' + (((oct[2] << 8) | oct[3]).toString(16));
        s = s.slice(0, s.length - v4m[1].length) + tail;
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;                 // more than one '::' is illegal
    const head = halves[0] ? halves[0].split(':') : [];
    let groups: string[];
    if (halves.length === 2) {
        const tail = halves[1] ? halves[1].split(':') : [];
        const fill = 8 - head.length - tail.length;
        if (fill < 0) return null;
        groups = [...head, ...new Array(fill).fill('0'), ...tail];
    } else {
        groups = head;
    }
    if (groups.length !== 8) return null;
    const bytes: number[] = [];
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        const v = parseInt(g, 16);
        bytes.push((v >> 8) & 255, v & 255);
    }
    return bytes.length === 16 ? bytes : null;
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
        const b = ipv6ToBytes(a);
        if (!b) return true;                                       // unparseable → fail closed
        const first10Zero = b.slice(0, 10).every((x) => x === 0);
        // ::/96 (IPv4-compatible + ::/::1) and ::ffff:0:0/96 (IPv4-mapped) — apply the IPv4 rules to the
        // embedded address. This catches EVERY spelling of ::1 (→0.0.0.1, blocked by 0/8) and of
        // ::ffff:169.254.169.254 (→link-local), plus :: (→0.0.0.0), regardless of textual form.
        if (first10Zero && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) {
            return isBlockedV4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
        }
        // NAT64 well-known prefix 64:ff9b::/96 embeds an IPv4 address a translator routes to — on an
        // IPv6-only cloud VPC this reaches v4 metadata/loopback (64:ff9b::a9fe:a9fe = 169.254.169.254).
        // Block only when the embedded v4 is itself private (public NAT64 targets stay allowed).
        if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0 && b[5] === 0 && b[6] === 0 && b[7] === 0) {
            return isBlockedV4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
        }
        if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;  // fe80::/10 link-local
        if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true;  // fec0::/10 deprecated site-local (RFC 3879)
        if ((b[0] & 0xfe) === 0xfc) return true;                  // fc00::/7 unique-local (ULA)
        if (b[0] === 0xff) return true;                           // ff00::/8 multicast
        return false;                                             // a public-looking IPv6
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

// ---- dgram (UDP) egress -------------------------------------------------------------------------
// dgram send()/connect() take the destination as a POSITIONAL arg (not a `lookup`-bearing options object
// like net/http), so we resolve hostnames ourselves AND — critically — hand the underlying send/connect the
// VALIDATED LITERAL IP, never the original hostname. If we re-passed the hostname, Node's own internal
// dns.lookup would resolve it a SECOND time; a TTL-0 rebind can flip the answer to an internal IP between
// our check and Node's (DNS-rebinding). Pinning the IP we validated makes Node's re-resolution a no-op
// (isIP() short-circuits DNS). CORRECTION (#27): dgram.createSocket()/new Socket() DO accept a per-socket
// `lookup` option, and Node runs it for EVERY resolution — even the literal IPs we pin (via lookup4/lookup6,
// which call the socket lookup with the address unconditionally). A plugin lookup could therefore re-map a
// pinned literal to an internal IP, so guardDgram STRIPS any plugin-supplied lookup at construction (falling
// back to Node's default dns.lookup, a no-op on the pinned literals). We delete it rather than inject
// validatingLookup because dgram reuses the socket lookup for bind() too, whose wildcard 0.0.0.0 / :: default
// validatingLookup would wrongly reject. (EG-DGRAM-REBIND, #27)
//
// Per-socket "connected to a validated destination" state, tracked in a WeakSet so PLUGIN code cannot
// forge it (a plain instance flag like `sock.__connected = true` could be set by the plugin to sneak a
// no-address send() through to the default 127.0.0.1). Membership is added only by secureDgramConnect
// after the destination passed validation.
const dgramConnectedSockets = new WeakSet<object>();

// Mirror Node's dgram.Socket.prototype.send arg-shifting to locate the destination `address` index:
//   send(msg[, offset, length][, port][, address][, callback])
// Long form (msg, offset, length, port, address[, cb]) is in play when a 5th positional (address) exists
// OR the 4th (port) is a real port (not the callback); address then sits at index 4. Otherwise it is the
// short form (msg, port, address[, cb]) and address sits at index 2. (Positional — unlike a "last string
// arg" scan, this never mistakes a STRING msg for the address.)
function dgramSendAddressIndex(args: any[]): number {
    const port = args[3], address = args[4];
    if (address !== undefined || (port !== undefined && typeof port !== 'function')) return 4;
    return 2;
}

// Choose which validated IP to PIN back into the args. Prefer one whose family matches the socket type
// (udp4→IPv4, udp6→IPv6) so we never hand a udp4 socket an AAAA literal (which Node would reject); every
// address in `list` was already IP-validated as public, so any is safe security-wise.
function pinDgramAddress(sock: any, list: any[]): string {
    const want = sock && sock.type === 'udp6' ? 6 : sock && sock.type === 'udp4' ? 4 : 0;
    if (want) { const m = list.find((a) => realNet.isIP(a.address) === want); if (m) return m.address; }
    return list[0].address;
}

// Validate a dgram send() against the egress policy, then delegate to `orig` with the destination pinned
// to a validated IP literal. `orig`/`thisArg`/`args` mirror the prototype call so this is reusable from
// both the in-place prototype patch AND the module-wrapper instance/subclass overrides.
function secureDgramSend(orig: any, thisArg: any, args: any[]): any {
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    const idx = dgramSendAddressIndex(args);
    const address = typeof args[idx] === 'string' ? args[idx] : undefined;
    if (address === undefined) {
        // No explicit destination host. On a CONNECTED socket the remote was validated at connect() →
        // allow. Otherwise dgram DEFAULTS to 127.0.0.1 — a blind loopback datagram — so deny it.
        if (dgramConnectedSockets.has(thisArg)) return orig.apply(thisArg, args);
        const e = blockErr('127.0.0.1', '(dgram default)'); if (cb) { cb(e); return; } throw e;
    }
    if (realNet.isIP(address)) {
        // Already an IP literal → no DNS, no rebind window; validate and pass straight through.
        try { assertHostLiteral(address); } catch (e) { if (cb) { cb(e as Error); return; } throw e; }
        return orig.apply(thisArg, args);
    }
    // Hostname: resolve, validate EVERY resolved IP, then REWRITE the address arg to the validated literal
    // so Node cannot re-resolve to a different (internal) address. (#27)
    realDns.lookup(address, { all: true, verbatim: true }, (err: any, addrs: any) => {
        if (err) { if (cb) cb(err); return; }
        const list = Array.isArray(addrs) ? addrs : [{ address: addrs }];
        for (const a of list) { if (isBlockedIp(a.address)) { const e = blockErr(a.address, address); if (cb) cb(e); return; } }
        const pinned = args.slice(); pinned[idx] = pinDgramAddress(thisArg, list);
        orig.apply(thisArg, pinned);
    });
}

// Validate a dgram connect() — `connect(port[, address][, callback])` — the same way, pinning the IP and
// marking the socket connected-to-a-validated-destination so a later no-address send() is allowed.
function secureDgramConnect(orig: any, thisArg: any, args: any[]): any {
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    const address = typeof args[1] === 'string' ? args[1] : undefined; // arg after port
    if (address === undefined) {
        // connect(port) with no address defaults to 127.0.0.1 / ::1 — a loopback binding. Deny. (EG-3)
        const e = blockErr('127.0.0.1', '(dgram connect default)'); if (cb) { cb(e); return; } throw e;
    }
    if (realNet.isIP(address)) {
        try { assertHostLiteral(address); } catch (e) { if (cb) { cb(e as Error); return; } throw e; }
        dgramConnectedSockets.add(thisArg);
        return orig.apply(thisArg, args);
    }
    realDns.lookup(address, { all: true, verbatim: true }, (err: any, addrs: any) => {
        if (err) { if (cb) cb(err); return; }
        const list = Array.isArray(addrs) ? addrs : [{ address: addrs }];
        for (const a of list) { if (isBlockedIp(a.address)) { const e = blockErr(a.address, address); if (cb) cb(e); return; } }
        const pinned = args.slice(); pinned[1] = pinDgramAddress(thisArg, list);
        dgramConnectedSockets.add(thisArg);
        orig.apply(thisArg, pinned);
    });
}

// Validate a dgram disconnect(). disconnect() resets Node's internal connectState back to "unconnected", so
// a subsequent no-address send() would DEFAULT to 127.0.0.1. secureDgramSend only allows a no-address send
// when the socket is in dgramConnectedSockets, so we MUST drop the socket from that WeakSet here — otherwise
// connect(validated-public) → disconnect() → send() (no address) sneaks a blind loopback datagram past the
// guard (the WeakSet still said "connected"). Remove BEFORE delegating so the state is consistent even if the
// real disconnect throws. (#19)
function secureDgramDisconnect(orig: any, thisArg: any, args: any[]): any {
    dgramConnectedSockets.delete(thisArg);
    if (typeof orig === 'function') return orig.apply(thisArg, args);
}

// THE definitive UDP egress enforcement for the isolated child: patch the REAL dgram.Socket.prototype
// .send/.connect in place, so EVERY datagram is validated no matter how the socket was obtained —
// dgram.createSocket, `new dgram.Socket()` (#19; the raw Socket ctor the module Proxy would forward),
// AND `await import('dgram')` (#22; the ESM loader bypasses the CJS require proxy, but every dgram
// instance shares this ONE prototype, so patching it here covers the ESM module and the createSocket
// path too). Module-name overrides alone are bypassable; the prototype is the single chokepoint —
// exactly the model installChildNetGuard uses for TCP. SAFE ONLY in the child (one plugin per process;
// its core bootstrap + IPC bridge never use dgram). NEVER call this on the host. Idempotent.
let childDgramGuardInstalled = false;
export function installChildDgramGuard(): void {
    if (childDgramGuardInstalled) return;
    childDgramGuardInstalled = true;
    if (!realDgram || !realDgram.Socket || typeof realDgramSend !== 'function') return;
    try {
        const proto = realDgram.Socket.prototype;
        const specs: Array<[string, any, (o: any, t: any, a: any[]) => any]> = [
            ['send', realDgramSend, secureDgramSend],
            ['connect', realDgramConnect, secureDgramConnect],
            // #19: patch + LOCK disconnect() too, so it clears the connected-state WeakSet (a plugin must not
            // be able to restore the raw disconnect and desync our state to regain a no-address loopback send).
            ['disconnect', realDgramDisconnect, secureDgramDisconnect],
        ];
        for (const [name, orig, secure] of specs) {
            if (typeof orig !== 'function' || (proto[name] as any).__wjGuarded) continue;
            const desc = Object.getOwnPropertyDescriptor(proto, name);
            const patched = function (this: any, ...args: any[]) { return secure(orig, this, args); };
            (patched as any).__wjGuarded = true;
            // LOCK it (non-writable + non-configurable): a network-granted plugin must NOT be able to
            // restore the raw send/connect (e.g. `require('dgram').Socket.prototype.send = raw`) and
            // regain unvalidated UDP to loopback/metadata/private. `orig` lives only in this closure,
            // unreachable from plugin code. (mirrors installChildNetGuard / EG-1)
            Object.defineProperty(proto, name, { value: patched, writable: false, configurable: false, enumerable: desc ? !!desc.enumerable : false });
        }
        // Also guard the NATIVE udp_wrap handle: a plugin can reflect PAST the JS prototype via
        // `sock[Symbol(state symbol)].handle.send(...)` — the handle's own send/send6/connect/connect6 do
        // the real OS egress and sit below the patched prototype (#22). The handle is materialized on
        // bind(), so wrap bind() to validate + lock the handle methods the first time it exists. Best-effort
        // over Node internals; the AUTHORITATIVE UDP containment for a network-granted plugin is the OS
        // sandbox (bwrap/seccomp) the isolated worker runs under on Linux.
        const origBind = proto.bind;
        if (typeof origBind === 'function' && !(origBind as any).__wjGuarded) {
            const guardHandleFn = (ho: any, addrIdx: number) => function (this: any, ...ha: any[]) {
                const addr = ha[addrIdx];
                if (typeof addr === 'string' && !realNet.isIP(addr)) { /* hostname at native layer — deny (no rebind-safe resolve here) */ throw blockErr(addr, addr); }
                if (typeof addr === 'string' && isBlockedIp(addr)) throw blockErr(addr, addr);
                return ho.apply(this, ha);
            };
            const patchedBind = function (this: any, ...bargs: any[]) {
                const r = origBind.apply(this, bargs);
                try {
                    const sock: any = this;
                    const sym = Object.getOwnPropertySymbols(sock).find((s) => String(s) === 'Symbol(state symbol)');
                    const handle = sym ? (sock[sym] && sock[sym].handle) : null;
                    if (handle && !handle.__wjGuarded) {
                        for (const [hm, idx] of [['send', 4], ['send6', 4], ['connect', 0], ['connect6', 0]] as Array<[string, number]>) {
                            const ho = handle[hm];
                            if (typeof ho === 'function') {
                                try { Object.defineProperty(handle, hm, { value: guardHandleFn(ho, idx), writable: false, configurable: false }); } catch { /* */ }
                            }
                        }
                        try { Object.defineProperty(handle, '__wjGuarded', { value: true, enumerable: false }); } catch { /* */ }
                    }
                } catch { /* Node internals shifted — best effort; OS sandbox is the real boundary */ }
                return r;
            };
            (patchedBind as any).__wjGuarded = true;
            try { Object.defineProperty(proto, 'bind', { value: patchedBind, writable: false, configurable: false, enumerable: false }); } catch { /* */ }
        }
    } catch { /* best-effort; the module-wrapper GuardedSocket below remains as defense */ }
}

function guardDgram(mod: any): any {
    // Cover `new (require('dgram').Socket)()` at the module-wrapper level too — the raw Socket ctor is
    // what the Proxy would otherwise forward unguarded (#19). In the isolated child the prototype patch
    // (installChildDgramGuard) is the authoritative chokepoint AND locked; this subclass + instance
    // override is the protection on the in-process (non-isolated) path where the prototype isn't patched.
    // Both bottom out at the captured RAW send/connect, so a child socket is validated exactly once.
    class GuardedSocket extends mod.Socket {
        constructor(...args: any[]) {
            // #27: STRIP any plugin-supplied `lookup` BEFORE it reaches the real Socket ctor, which bakes it into
            // the udp handle (via newHandle). A baked-in lookup runs for EVERY resolution on the socket, so it can
            // only be neutralized at construction, not at send time. We DELETE it (rather than inject
            // validatingLookup) because dgram reuses the SAME socket lookup for bind() too, and bind() defaults to
            // the wildcard 0.0.0.0 / :: — which validatingLookup would reject, breaking every implicit bind. With
            // the plugin lookup removed Node falls back to its default dns.lookup, which is a NO-OP on the literal
            // IPs secure send/connect always pin (isIP short-circuits DNS → no rebind) and correctly resolves the
            // wildcard bind. A plugin can no longer supply its own lookup.
            if (args[0] && typeof args[0] === 'object') { const o: any = { ...args[0] }; delete o.lookup; args[0] = o; }
            super(...args);
        }
        send(...args: any[]) { return secureDgramSend(realDgramSend, this, args); }
        connect(...args: any[]) { return secureDgramConnect(realDgramConnect, this, args); }
        disconnect(...args: any[]) { return secureDgramDisconnect(realDgramDisconnect, this, args); } // #19
    }
    const overrides: Record<string, any> = { Socket: GuardedSocket };
    if (typeof mod.createSocket === 'function') {
        overrides.createSocket = function (...args: any[]) {
            // #27: dgram DOES honor a per-socket `lookup` option — createSocket({ type, lookup }). Forwarding the
            // plugin's options untouched would let a malicious lookup run for every name Node resolves on this
            // socket, INCLUDING the validated literal IPs the guard pins (Node's lookup4/lookup6 call the socket
            // lookup unconditionally), re-mapping them to an internal address (DNS-rebind). Copy the options and
            // STRIP the lookup (see the GuardedSocket ctor note: injecting validatingLookup would break bind(),
            // which reuses the socket lookup for the wildcard 0.0.0.0 / ::; deleting it falls back to Node's
            // default dns.lookup, a no-op on the pinned literals). A string `type` first-arg carries no lookup, so
            // it is left alone.
            if (args[0] && typeof args[0] === 'object') { args = args.slice(); const o: any = { ...args[0] }; delete o.lookup; args[0] = o; }
            const sock = mod.createSocket(...args);
            // Define OWN instance overrides via defineProperty, NOT `sock.send = …` assignment: in the
            // isolated child installChildDgramGuard has already made the prototype send/connect
            // non-writable, and a non-writable prototype data-property makes plain assignment throw
            // ("Cannot assign to read only property"). defineProperty on the instance sidesteps that (it
            // creates an own property without consulting the prototype's writability). Harmless in the
            // child (shadows the — equivalent — patched prototype) and the real guard on the in-process
            // path where the prototype is untouched.
            Object.defineProperty(sock, 'send', { value: function (...sargs: any[]) { return secureDgramSend(realDgramSend, sock, sargs); }, writable: true, configurable: true });
            if (typeof sock.connect === 'function') {
                Object.defineProperty(sock, 'connect', { value: function (...cargs: any[]) { return secureDgramConnect(realDgramConnect, sock, cargs); }, writable: true, configurable: true });
            }
            if (typeof sock.disconnect === 'function') {
                // #19: instance-level disconnect override for the in-process path (prototype unpatched there) —
                // clears the connected-state WeakSet so a later no-address send() can't default to loopback.
                Object.defineProperty(sock, 'disconnect', { value: function (...dargs: any[]) { return secureDgramDisconnect(realDgramDisconnect, sock, dargs); }, writable: true, configurable: true });
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
