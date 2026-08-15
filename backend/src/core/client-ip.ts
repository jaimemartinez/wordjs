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

module.exports = { clientIp, resolveTrustProxy, trustProxyConfigured, normalizeTrustProxy };
