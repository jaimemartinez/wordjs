/**
 * WordJS Gateway — the two operator settings the gateway used to ignore: its log level and which
 * fronting proxy it trusts for the client address.
 *
 * LOG LEVEL. The Winston logger was created with `level: 'info'` and nothing else, so LOG_LEVEL (which
 * the backend honours) and `logging.level` in gateway-config.json did nothing: no `debug` line — the
 * per-request "Proxying …" trace included — could ever be turned on. The order is the backend's
 * (backend/src/core/logger.ts resolveLevel): LOG_LEVEL, then the config, then `info`; an unknown value is
 * skipped, never fatal. pino's names are accepted too, so one LOG_LEVEL serves both processes.
 *
 * TRUST PROXY. The public listener keyed its rate limit on the TCP peer and never set Express's
 * `trust proxy`, so behind nginx on the same box every visitor was 127.0.0.1 and the whole site shared one
 * bucket — and the backend, which trusts the gateway's X-Forwarded-For hop, saw nginx's address for
 * everyone too. `trustProxy` in gateway-config.json or WORDJS_TRUST_PROXY (the backend's variable, same
 * value syntax: true | false | hop count | 'loopback' | subnet list) now sets it. Unset trusts nothing,
 * exactly as before: the gateway is the edge and a client must not be able to forge its own address.
 */
'use strict';

const WINSTON_LEVELS = new Set(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']);
// pino → winston, so the LOG_LEVEL the backend accepts means the same here.
const PINO_ALIASES = { fatal: 'error', trace: 'silly' };

function normalizeLevel(v) {
    const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
    if (!s) return null;
    if (s === 'silent') return 'silent';
    if (WINSTON_LEVELS.has(s)) return s;
    return PINO_ALIASES[s] || null;
}

/**
 * @returns {{ level: string, silent: boolean }} the Winston level to run at; `silent` for LOG_LEVEL=silent
 */
function resolveLogLevel(env, config) {
    const candidates = [env && env.LOG_LEVEL, config && config.logging && config.logging.level];
    for (const c of candidates) {
        const level = normalizeLevel(c);
        if (level === 'silent') return { level: 'error', silent: true };
        if (level) return { level, silent: false };
    }
    return { level: 'info', silent: false };
}

/** The backend's normalizeTrustProxy (backend/src/core/client-ip.ts), for the same input syntax. */
function normalizeTrustProxy(v) {
    if (typeof v === 'string') {
        const s = v.trim();
        const lower = s.toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false' || s === '') return false;
        if (/^\d+$/.test(s)) return Number(s);
        if (s.includes(',')) return s.split(',').map((x) => x.trim()).filter(Boolean);
        return s;
    }
    if (typeof v === 'boolean' || typeof v === 'number') return v;
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    return false;
}

/**
 * The Express `trust proxy` value for the public listener: the config's `trustProxy`, else
 * WORDJS_TRUST_PROXY, else false (trust nothing — the socket peer is the client).
 */
function resolveTrustProxy(env, config) {
    let raw = config ? config.trustProxy : undefined;
    if (raw === undefined || raw === null || raw === '') raw = env ? env.WORDJS_TRUST_PROXY : undefined;
    if (raw === undefined || raw === null || raw === '') return false;
    return normalizeTrustProxy(raw);
}

/** Does the value trust any hop at all? */
function trustsAnyProxy(tp) {
    return !(tp === false || tp === 0 || (Array.isArray(tp) && tp.length === 0));
}

const LOOPBACK_PEER = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

function isLoopbackAddress(addr) {
    return LOOPBACK_PEER.test(String(addr || '').trim());
}

/** The left-most entry of an X-Forwarded-For value (the client a proxy recorded), or ''. */
function firstForwardedFor(xff) {
    const value = Array.isArray(xff) ? xff.join(',') : String(xff || '');
    return value.split(',')[0].trim();
}

/**
 * Warn ONCE when a request arrives from a proxy on this machine (loopback peer carrying an
 * X-Forwarded-For that names a non-loopback client) while the gateway trusts no proxy: every visitor then
 * shares the proxy's address — one rate-limit bucket for the whole site, and the backend sees the proxy too.
 * Returns a function `(req) => void`; cheap after the first warning.
 */
function createUntrustedProxyWarning(trustProxy, logger) {
    if (trustsAnyProxy(trustProxy)) return () => {};
    let warned = false;
    return (req) => {
        if (warned) return;
        const peer = req && req.socket && req.socket.remoteAddress;
        if (!isLoopbackAddress(peer)) return;
        const client = firstForwardedFor(req.headers && req.headers['x-forwarded-for']);
        if (!client || isLoopbackAddress(client)) return;
        warned = true;
        logger.warn(
            '[Gateway] ⚠️ Requests are reaching the gateway through a proxy on this machine (X-Forwarded-For from 127.0.0.1), ' +
            'but no proxy is trusted — every visitor is counted as 127.0.0.1: one rate-limit bucket for the whole site, ' +
            'and the backend sees the proxy\'s address for everyone. Set "trustProxy": "loopback" in gateway-config.json ' +
            '(or WORDJS_TRUST_PROXY=loopback) and restart the gateway.'
        );
    };
}

/**
 * With a trusted fronting proxy, the X-Forwarded-* headers http-proxy's xfwd would write — except that
 * X-Forwarded-For is the client Express resolved through the trusted hops (`client`), not the proxy's
 * socket address appended to the chain. The backend trusts exactly one hop (the gateway's), so with xfwd's
 * append it read the proxy's 127.0.0.1 for every visitor. Called right before proxy.web / proxy.ws, which
 * then run with `xfwd: false`; Port, Proto and Host are written exactly as xfwd writes them (append to
 * what host-edge pinForwardedHeaders / pinUpgradeHeaders left), so nothing else changes.
 */
function stateForwardedHeaders(req, client, { upgrade = false } = {}) {
    const conn = req.connection || req.socket || {};
    const encrypted = Boolean(conn.encrypted || conn.pair);
    const m = req.headers.host ? String(req.headers.host).match(/:(\d+)/) : null;
    const values = {
        port: m ? m[1] : (encrypted ? '443' : '80'),
        proto: upgrade ? (encrypted ? 'wss' : 'ws') : (encrypted ? 'https' : 'http'),
    };
    req.headers['x-forwarded-for'] = String(client || conn.remoteAddress || '');
    for (const name of ['port', 'proto']) {
        const header = `x-forwarded-${name}`;
        const cur = req.headers[header];
        req.headers[header] = cur ? `${cur},${values[name]}` : values[name];
    }
    if (!upgrade) req.headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host || '';
}

const DEFAULT_PROXY_TIMEOUT_MS = 60000;
// The backend's AI provider waits up to 300 s for a loopback provider (a local model on CPU) by default;
// WORDJS_AI_TIMEOUT_MS overrides it there, and the gateway reads the same variable.
const DEFAULT_AI_TIMEOUT_MS = 300000;
const AI_TIMEOUT_MARGIN_MS = 30000;

/**
 * How long the proxy waits for an upstream answer on this path. 60 s, except the AI routes
 * (`/api/v1/ai/…`): the backend may legitimately wait longer than that for the provider, and the gateway
 * used to cut every such request at 60 s in split mode. They get the AI timeout plus a margin, so the
 * backend's own timeout — with its own error message — always fires first.
 */
function proxyTimeoutFor(url, env) {
    const p = String(url || '/').split('?')[0];
    if (!p.startsWith('/api/v1/ai/')) return DEFAULT_PROXY_TIMEOUT_MS;
    const n = Number(String((env && env.WORDJS_AI_TIMEOUT_MS) || '').trim());
    const ai = Number.isFinite(n) && n > 0 ? n : DEFAULT_AI_TIMEOUT_MS;
    return Math.max(DEFAULT_PROXY_TIMEOUT_MS, ai + AI_TIMEOUT_MARGIN_MS);
}

module.exports = {
    proxyTimeoutFor,
    resolveLogLevel,
    stateForwardedHeaders,
    resolveTrustProxy,
    normalizeTrustProxy,
    trustsAnyProxy,
    isLoopbackAddress,
    firstForwardedFor,
    createUntrustedProxyWarning,
};
