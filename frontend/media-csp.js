/**
 * The page CSP's media origin, added at RESPONSE time.
 *
 * src/proxy.ts writes the Content-Security-Policy (lib/contentSecurityPolicy.ts) without knowing the site's
 * media storage, and a pre-compiled release is built without knowing any site's configuration. Where a site's media is
 * served from is RUNTIME configuration (Settings → Media storage: an S3-compatible bucket or a CDN in
 * front of it, backend/src/core/media-storage.ts), so the custom servers (server.js, ../monolith.js)
 * amend the header on its way out instead: exactly ONE origin — the configured media origin — is added
 * to `img-src` and to `media-src` (created as `'self' <origin>` when the build set none), and nothing
 * else changes. With no media origin the header is passed through byte-for-byte.
 *
 * Where the origin comes from, first match wins:
 *   1. WORDJS_MEDIA_CDN_ORIGIN — an operator override (a frontend replica that cannot see the backend's
 *      config file and renders nothing before its first response);
 *   2. the value the public SSR last read from the backend's settings (`media_cdn_origin`), published
 *      process-wide by src/lib/server-api.ts — the live answer. A media storage save purges the
 *      `settings` tag, and /api/revalidate then re-reads it at once (refreshMediaCdnOrigin), so an
 *      admin change reaches this header within the purge's debounce, not the settings cache's 60 s;
 *   3. the `mediaStorage` block of the nearest wordjs-config.json (driver s3 + publicUrl), so the very
 *      first response after a restart already carries it on a same-machine install.
 */
const fs = require('fs');
const path = require('path');

const GLOBAL_KEY = '__WORDJS_MEDIA_CDN_ORIGIN__';
const CSP = 'content-security-policy';

/** scheme://host[:port] of an http(s) URL, or null. Never anything that could add a CSP token. */
function toOrigin(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    let u;
    try { u = new URL(value.trim()); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.origin;
}

let fileCache = { at: 0, origin: null };
function originFromConfigFile() {
    const now = Date.now();
    if (now - fileCache.at < 5000) return fileCache.origin;
    let origin = null;
    const candidates = [
        path.resolve(process.cwd(), 'wordjs-config.json'),
        path.resolve(__dirname, 'wordjs-config.json'),
        path.resolve(__dirname, '..', 'backend', 'wordjs-config.json'),
    ];
    for (const file of candidates) {
        try {
            const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
            const ms = cfg && cfg.mediaStorage;
            if (ms && typeof ms === 'object') {
                origin = String(ms.driver || '').toLowerCase() === 's3' ? toOrigin(ms.publicUrl) : null;
                break;
            }
        } catch { /* not there / unreadable — try the next */ }
    }
    fileCache = { at: now, origin };
    return origin;
}

function currentMediaOrigin(env = process.env) {
    const fromEnv = toOrigin(env.WORDJS_MEDIA_CDN_ORIGIN);
    if (fromEnv) return fromEnv;
    const published = globalThis[GLOBAL_KEY];
    if (typeof published === 'string') return toOrigin(published);
    return originFromConfigFile();
}

/**
 * The CSP with `origin` added to img-src and media-src. Pure. Returns the input unchanged when there is
 * no origin, no CSP, or the origin is already listed.
 */
function withMediaOrigin(csp, origin) {
    const o = toOrigin(origin);
    if (!o || typeof csp !== 'string' || !csp) return csp;
    const directives = csp.split(';').map((d) => d.trim()).filter(Boolean);
    let sawMedia = false;
    const out = directives.map((d) => {
        const [name, ...values] = d.split(/\s+/);
        const lower = name.toLowerCase();
        if (lower !== 'img-src' && lower !== 'media-src') return d;
        if (lower === 'media-src') sawMedia = true;
        return values.includes(o) ? d : [name, ...values, o].join(' ');
    });
    if (!sawMedia) out.push(`media-src 'self' ${o}`);
    return out.join('; ');
}

/**
 * Amend the CSP of one response just before its head is written. Covers both ways a Node handler sets
 * it: res.setHeader(...) before writeHead (what Next does), and a headers object passed to writeHead.
 */
function installMediaCsp(res, getOrigin = currentMediaOrigin) {
    const originalWriteHead = res.writeHead;
    if (typeof originalWriteHead !== 'function' || originalWriteHead.__wordjsMediaCsp) return res;
    const patched = function writeHead(statusCode, ...rest) {
        let origin = null;
        try { origin = getOrigin(); } catch { origin = null; }
        if (origin) {
            try {
                const current = res.getHeader(CSP);
                if (typeof current === 'string') res.setHeader(CSP, withMediaOrigin(current, origin));
                const headers = rest.find((a) => a && typeof a === 'object' && !Array.isArray(a));
                if (headers) {
                    for (const k of Object.keys(headers)) {
                        if (k.toLowerCase() === CSP && typeof headers[k] === 'string') headers[k] = withMediaOrigin(headers[k], origin);
                    }
                }
            } catch { /* never break a response over its CSP */ }
        }
        return originalWriteHead.call(this, statusCode, ...rest);
    };
    patched.__wordjsMediaCsp = true;
    res.writeHead = patched;
    return res;
}

module.exports = { withMediaOrigin, installMediaCsp, currentMediaOrigin, toOrigin, GLOBAL_KEY };
