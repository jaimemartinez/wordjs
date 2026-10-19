/**
 * Media delivery URLs for the public SSR.
 *
 * Content and the database only ever hold RELATIVE media paths (`/uploads/2026/10/a.jpg`): that is what
 * the editor persists, and it is what lets a site change domain, bucket or CDN — or roll the offload
 * back — without rewriting a single row. When the backend reports that the whole library is served from
 * an S3-compatible bucket / CDN (the `media_public_base` public setting, backend/src/core/media-storage.ts),
 * the page data is rewritten on its way to the renderer so the browser fetches the CDN directly instead
 * of taking the backend's /uploads → CDN redirect. Nothing here is ever written back.
 *
 * What is rewritten: a `/uploads/` path at the START of a string value (an image block's `src`), and
 * every `/uploads/` that begins a URL inside a string — after whitespace, a comma (srcset candidates),
 * a quote, `(` or `=` — which covers persisted `srcSet`/`srcSetModern` strings and the src/srcset/href
 * attributes of HTML bodies. `/uploads/fonts/` (self-hosted fonts, never offloaded) is left alone, and
 * so is anything already absolute (`https://site/uploads/...` is preceded by a host, not by one of
 * those characters).
 */

const UPLOADS_IN_TEXT = /(^|[\s,"'(=])\/uploads\/(?!fonts\/)/g;

/** A validated base: http(s), no query/fragment/credentials, no trailing slash. '' when unusable. */
export function normalizeMediaBase(raw: unknown): string {
    if (typeof raw !== "string" || !raw.trim()) return "";
    let u: URL;
    try {
        u = new URL(raw.trim());
    } catch {
        return "";
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    if (u.username || u.password || u.search || u.hash) return "";
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** Rewrite the /uploads/ URLs in one string. */
export function rewriteMediaString(value: string, base: string): string {
    if (!base || value.indexOf("/uploads/") === -1) return value;
    return value.replace(UPLOADS_IN_TEXT, (_m, lead: string) => `${lead}${base}/`);
}

/**
 * Deep copy of `value` with every string rewritten. Returns the SAME reference when nothing changed,
 * so callers can skip copying a post that holds no media.
 */
export function rewriteMediaUrls<T>(value: T, base: string): T {
    if (!base) return value;
    const walk = (v: unknown, depth: number): unknown => {
        if (typeof v === "string") return rewriteMediaString(v, base);
        if (!v || typeof v !== "object" || depth > 64) return v;
        if (Array.isArray(v)) {
            let changed = false;
            const out = v.map((item) => {
                const next = walk(item, depth + 1);
                if (next !== item) changed = true;
                return next;
            });
            return changed ? out : v;
        }
        let changed = false;
        const out: Record<string, unknown> = {};
        for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
            const next = walk(item, depth + 1);
            if (next !== item) changed = true;
            out[k] = next;
        }
        return changed ? out : v;
    };
    return walk(value, 0) as T;
}

/** The base to rewrite to, from the public settings payload ('' = keep /uploads). */
export function mediaBaseFromSettings(settings: Record<string, unknown> | null | undefined): string {
    return normalizeMediaBase(settings?.media_public_base);
}
