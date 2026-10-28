/**
 * THE CONTENT-SECURITY-POLICY of every document the frontend serves, built per request by src/proxy.ts.
 *
 * Two shapes, one per kind of document:
 *
 *  · The DYNAMIC documents — the admin, the sign-in screens, the install wizard, the migration screen and
 *    plugin portals (DYNAMIC_DOCUMENT) — render per request anyway, so they get a fresh nonce:
 *    `script-src 'nonce-…' 'strict-dynamic'`. Next stamps the nonce on every script it emits (it reads it
 *    from the request's Content-Security-Policy header), and a script those load may load others
 *    (`'strict-dynamic'`): the plugin admin bundles that lib/pluginBundleLoader.ts imports from a blob: URL
 *    included. No inline script without the nonce runs there, and no host is trusted by name.
 *
 *  · The PUBLIC pages are served from Next's cache (ISR): one rendered copy is shared by every visitor, so
 *    there is no per-request nonce to put in it. They keep `'unsafe-inline'` for the Next bootstrap, but no
 *    longer allow every https host: only the site itself, blob:, and the origins the active plugins'
 *    public scripts DECLARE they load from (an analytics tag's provider — `origins` on
 *    wordjs.assets.enqueueScript; the backend lists them in GET /plugins/assets).
 *
 * Both: no inline event-handler attribute (`script-src-attr 'none'`), forms submit to this origin only
 * (`form-action 'self'`), frames only from the site and the embed providers the VideoEmbed block resolves
 * (embed-hosts.js), framed only by the site itself, no plugins (`object-src`), no <base> elsewhere.
 * 'unsafe-eval' is DEVELOPMENT-ONLY: React's development build needs eval() for its debugging features
 * and never uses it in production (the shipped chunks contain none).
 */
import { ALLOWED_EMBED_HOSTS } from '../../embed-hosts.js';

/** The documents that render per request and therefore carry a nonce (matched on the request path). */
export const DYNAMIC_DOCUMENT = /^\/(?:admin|login|register|reset-password|verify-email|install|migration|portal)(?:\/|$)/;

/** A bare https origin — the only shape a declared script origin may take in this header. */
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::[0-9]{1,5})?$/;
const MAX_SCRIPT_ORIGINS = 16;

/** The declared origins that may go into the header: bare https origins only, deduplicated, bounded. */
export function sanitizeScriptOrigins(list: unknown): string[] {
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const raw of list) {
        if (typeof raw !== 'string') continue;
        const o = raw.trim().toLowerCase();
        if (HTTPS_ORIGIN.test(o) && !out.includes(o)) out.push(o);
        if (out.length >= MAX_SCRIPT_ORIGINS) break;
    }
    return out;
}

/** A fresh nonce: 128 random bits, base64. */
export function createNonce(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

export interface PolicyOptions {
    /** Set for a DYNAMIC document: the nonce Next stamps on its scripts. */
    nonce?: string | null;
    /** For a public page: the origins the active plugins' public scripts declare. */
    scriptOrigins?: string[];
    /** NODE_ENV === 'development'. */
    dev?: boolean;
}

export function contentSecurityPolicy({ nonce, scriptOrigins = [], dev = false }: PolicyOptions): string {
    const evalInDev = dev ? ["'unsafe-eval'"] : [];
    const scriptSrc = nonce
        // 'self' and blob: are ignored by browsers that understand 'strict-dynamic', and kept for the
        // ones that do not (they ignore the nonce-less 'strict-dynamic' instead).
        ? ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", 'blob:', ...evalInDev]
        : ["'self'", "'unsafe-inline'", 'blob:', ...sanitizeScriptOrigins(scriptOrigins), ...evalInDev];
    return [
        "default-src 'self'",
        `script-src ${scriptSrc.join(' ')}`,
        "script-src-attr 'none'",
        "worker-src 'self' blob:",
        "style-src 'self' 'unsafe-inline' https:",
        "img-src 'self' data: blob: https:",
        // A page that fetches media through its own authenticated API can only play it from a blob: URL.
        "media-src 'self' blob:",
        "font-src 'self' data: https:",
        "connect-src 'self' https: http: ws: wss:",
        ["frame-src 'self'", ...ALLOWED_EMBED_HOSTS.map((h: string) => `https://${h}`)].join(' '),
        "frame-ancestors 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
    ].join('; ');
}
