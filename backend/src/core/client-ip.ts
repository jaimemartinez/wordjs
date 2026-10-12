/**
 * WordJS — one honest client-IP helper for rate limiting and account lockout.
 *
 * WHY THIS EXISTS (audit 2026-08-08, P1): every per-IP control — the global/auth/login/upload/forms
 * limiters (index.ts) and the per-(IP+account) escalating login throttle (routes/auth.ts) — keyed on
 * `req.ip`. Express derives `req.ip` from the LAST `X-Forwarded-For` hop it is told to trust via
 * `app.set('trust proxy', …)`, and that setting was HARD-CODED to `1`. In the single-process monolith
 * there is NO fronting proxy: the client's TCP connection lands straight on our listener, so trusting
 * one XFF hop means trusting a header the CLIENT wrote. An attacker rotated `X-Forwarded-For` to mint a
 * fresh bucket per request and walked straight past the rate limits AND the per-(IP+account) lockout.
 *
 * THE FIX — key on the one address a client cannot forge (the TCP peer) UNLESS a proxy is genuinely
 * trusted:
 *   - Direct monolith (WORDJS_EMBEDDED=1): trust NOTHING. `req.socket.remoteAddress` is the real peer;
 *     X-Forwarded-For is attacker-controlled noise and is ignored entirely.
 *   - Behind the gateway (split / separate mode): the gateway PINS X-Forwarded-For and mTLS bars any
 *     other peer from reaching the backend, so exactly ONE hop is trustworthy — the historical `1`.
 *   - Operator override: `trustProxy` in wordjs-config.json (or WORDJS_TRUST_PROXY) sets an explicit
 *     Express `trust proxy` value (hop count, subnet list, or boolean) for anyone fronting the app with
 *     their own reverse proxy. An explicit setting always wins over the mode default.
 *
 * `resolveTrustProxy()` is the SINGLE source of truth: index.ts feeds it to `app.set('trust proxy', …)`
 * so Express's own `req.ip` is honest too, and `clientIp()` consults the SAME resolution so the limiter
 * key never diverges from what Express computed — even if some middleware later rewrites `req.ip`.
 */

const config = require('../config/app');

/**
 * Normalize a raw config/env value into an Express `trust proxy` setting. Strings arrive from
 * WORDJS_TRUST_PROXY (always a string) and from JSON that used a string; everything else passes
 * through (boolean | number | string[] are already valid Express values).
 */
function normalizeTrustProxy(v: any): any {
    if (typeof v === 'string') {
        const s = v.trim();
        const lower = s.toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false' || s === '') return false;
        if (/^\d+$/.test(s)) return Number(s);
        if (s.includes(',')) return s.split(',').map((x) => x.trim()).filter(Boolean);
        return s; // a single subnet or preset, e.g. '10.0.0.0/8' or 'loopback'
    }
    return v;
}

/**
 * The Express `trust proxy` value to use. Explicit operator config wins; otherwise the safe default
 * for the deployment mode. Exported so index.ts sets Express from the identical decision.
 */
function resolveTrustProxy(): any {
    let raw: any = config && config.trustProxy;
    if (raw === undefined || raw === null || raw === '') raw = process.env.WORDJS_TRUST_PROXY;
    if (raw !== undefined && raw !== null && raw !== '') return normalizeTrustProxy(raw);
    // No explicit setting → decide by mode. The monolith owns the single listener and sets
    // WORDJS_EMBEDDED=1 (monolith.js) before this module loads.
    const embedded = process.env.WORDJS_EMBEDDED === '1';
    return embedded ? false : 1;
}

/** Is ANY proxy hop trusted? `false`/`0` mean "trust nothing → key on the socket peer". */
function trustProxyConfigured(): boolean {
    const tp = resolveTrustProxy();
    return !(tp === false || tp === 0);
}

/**
 * The honest client IP for keying rate limits and the login lockout.
 * When a proxy is trusted, Express has already resolved the left-most untrusted address from
 * X-Forwarded-For per `trust proxy` — use `req.ip`. When nothing is trusted, ignore X-Forwarded-For
 * completely and key on the TCP peer, the one value a remote client cannot forge.
 */
function clientIp(req: any): string {
    if (trustProxyConfigured()) {
        const ip = req && req.ip;
        if (ip) return String(ip);
    }
    const sock = (req && (req.socket || req.connection)) || {};
    return String(sock.remoteAddress || '');
}

/** The 8 hextets of an IPv6 literal net.isIPv6 accepted (zone id already removed), or null. */
function ipv6Hextets(addr: string): number[] | null {
    const net = require('net');
    let s = addr.toLowerCase();
    // An embedded IPv4 tail (::ffff:192.0.2.1) becomes its two hextets.
    const lastColon = s.lastIndexOf(':');
    const tail = s.slice(lastColon + 1);
    if (tail.includes('.')) {
        if (!net.isIPv4(tail)) return null;
        const o = tail.split('.').map(Number);
        s = `${s.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
    if (fill < 0) return null;
    const groups = [...head, ...new Array(fill).fill('0'), ...rest];
    if (groups.length !== 8) return null;
    const out: number[] = [];
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
    }
    return out;
}

/**
 * THE RATE-LIMIT IDENTITY OF AN ADDRESS — what every per-client limit keys on.
 *
 * An IPv4 address is one client (or one NAT, which is the best anyone can do). An IPv6 address is not:
 * a subscriber, a VPS or a cloud instance is routinely handed a whole /64 (2^64 addresses), and every
 * address in it reaches the server. Keyed per /128, a limit is no limit for such a client — rotating the
 * low 64 bits mints a fresh bucket per request for the login throttle, the API and auth limiters, the
 * comment limiter and the per-client key plugins rate-limit on. So an IPv6 address is keyed by its /64
 * (rendered `2001:db8:1:2::/64`), the smallest prefix a single subscriber is normally given.
 *
 * An IPv4-MAPPED address (`::ffff:192.0.2.1`, how a dual-stack listener reports an IPv4 peer) stays per
 * address, in its plain IPv4 spelling: grouped by /64 it would put EVERY IPv4 client in ONE bucket
 * (`::ffff:0:0` is all one /64), and both spellings of the same client must share a bucket. Anything that
 * is not an address (an empty peer) is returned unchanged.
 */
function ipBucket(raw: unknown): string {
    const net = require('net');
    const original = raw === undefined || raw === null ? '' : String(raw);
    let ip = original.trim();
    if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
    const zone = ip.indexOf('%');
    if (zone !== -1) ip = ip.slice(0, zone);
    if (net.isIPv4(ip)) return ip;
    if (!net.isIPv6(ip)) return original;
    const h = ipv6Hextets(ip);
    if (!h) return ip.toLowerCase();
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
        return `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
    }
    return `${h.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/** clientIp() as a rate-limit identity (ipBucket). Audit lines keep the full clientIp(). */
function clientIpBucket(req: any): string {
    return ipBucket(clientIp(req));
}

/**
 * The privacy-preserving per-client key a plugin route receives (`req.clientKey`), so a plugin can
 * rate-limit or deduplicate by caller WITHOUT ever seeing the raw IP.
 *
 * An HMAC keyed with a per-install secret plugins never see: a plain sha256 over the 32-bit IPv4 space is
 * rainbow-tabled back to the address, and the table is reusable across installs when the prefix is a
 * global constant (#28/#30). The input is the rate-limit identity (ipBucket), so a client holding an IPv6
 * /64 is ONE caller to the plugin, as it is to every core limit.
 *
 * The key is the site's JWT signing secret (`config.jwt.secret`): persisted with the install and the same
 * on every node, so a plugin's per-client counters survive a restart and agree across nodes. It used to
 * read `config.jwtSecret`, a property the loaded config does not have, so every process silently fell back
 * to a random per-process key. The published placeholder is still treated as absent.
 */
function pluginClientKey(req: any): string {
    try {
        const bucket = clientIpBucket(req);
        if (!bucket) return '';
        const crypto = require('crypto');
        let secret: string | undefined = config && config.jwt && typeof config.jwt.secret === 'string' ? config.jwt.secret : undefined;
        if (!secret || secret === 'wordjs-default-secret-change-me') {
            const g: any = globalThis as any;
            secret = g.__wjClientKeySecret || (g.__wjClientKeySecret = crypto.randomBytes(32).toString('hex'));
        }
        return crypto.createHmac('sha256', 'wjck-hmac:' + secret).update(bucket).digest('hex').slice(0, 24);
    } catch {
        return '';
    }
}

module.exports = { clientIp, clientIpBucket, ipBucket, pluginClientKey, resolveTrustProxy, trustProxyConfigured, normalizeTrustProxy };
