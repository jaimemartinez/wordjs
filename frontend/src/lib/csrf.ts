/**
 * DOUBLE-SUBMIT CSRF TOKEN — the browser half.
 *
 * The backend sets a non-httpOnly `wjs_csrf` cookie alongside every session cookie and, for any
 * MUTATING request that is authenticated by the session cookie, requires the same value back in an
 * `X-CSRF-Token` header (backend/src/middleware/auth.ts, `csrfTokenGate`). A cross-origin page can make
 * the browser SEND our cookies, but the same-origin policy stops it READING them — so echoing the
 * cookie back in a header is proof the request came from our own origin.
 *
 * ONE reader, exported, because the alternative is what every "the fix was applied to one surface and
 * its twin was left behind" defect in this codebase looks like: the app talks to the backend from more
 * than a dozen places (the central `api()` client, AuthContext, the notification centre, the collab
 * transport, the presence heartbeat, the public form and analytics beacons), and a single one that
 * forgets the header is a feature that silently 403s in production. Anything that sends a mutating,
 * cookie-carrying request to /api/v1 must spread `csrfHeaders()` into its headers.
 *
 * Everything here degrades to "no header" rather than throwing: on the server (SSR) there is no
 * `document`, and an SSR request is not cookie-authenticated by a browser anyway.
 */

/** Must match CSRF_COOKIE / CSRF_HEADER in backend/src/middleware/auth.ts. */
export const CSRF_COOKIE = "wjs_csrf";
export const CSRF_HEADER = "X-CSRF-Token";

/**
 * The current CSRF token from `document.cookie`, or null.
 *
 * Read fresh at every call rather than cached at module load: the backend ROTATES this cookie on every
 * session issuance (login, and the 15-minute sliding-window refresh), so a cached copy would go stale
 * mid-session and start producing 403s that look like a server bug.
 */
export function readCsrfToken(): string | null {
    if (typeof document === "undefined") return null;
    for (const part of document.cookie.split(";")) {
        const raw = part.trim();
        // Prefix match on `name=` only — a cookie called `other_wjs_csrf` must not answer here.
        if (!raw.startsWith(`${CSRF_COOKIE}=`)) continue;
        const value = raw.slice(CSRF_COOKIE.length + 1);
        if (!value) return null;
        try {
            // Express encodes cookie values with encodeURIComponent. base64url has nothing to encode,
            // so this is a no-op today — but decoding is what keeps it correct if the encoding changes.
            return decodeURIComponent(value);
        } catch {
            return value; // malformed percent-escape: send it verbatim and let the server reject it
        }
    }
    return null;
}

/**
 * `{ 'X-CSRF-Token': … }` when there is a token to send, `{}` otherwise — spreadable straight into a
 * fetch `headers` object.
 *
 * Sending it on a safe method is harmless (the backend only checks mutating ones), so callers that
 * build one headers object for both do not need to branch.
 */
export function csrfHeaders(): Record<string, string> {
    const token = readCsrfToken();
    return token ? { [CSRF_HEADER]: token } : {};
}

/**
 * The XMLHttpRequest twin of `csrfHeaders()`.
 *
 * The two upload paths in lib/api.ts (theme upload, media upload-with-progress) are XHR and not fetch
 * because only XHR reports upload progress — they cannot spread a headers object, and without this
 * they would be the one pair of mutating, cookie-authenticated requests in the app that never sends
 * the token. Must be called AFTER `xhr.open()`: setRequestHeader throws InvalidStateError before it.
 */
export function applyCsrfHeader(xhr: { setRequestHeader(name: string, value: string): void }): void {
    const token = readCsrfToken();
    if (token) xhr.setRequestHeader(CSRF_HEADER, token);
}
