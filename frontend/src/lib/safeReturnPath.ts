/**
 * `?redirect=` on the sign-in and sign-up pages: where to send the visitor once they have a session —
 * e.g. back to the members-only post they were reading (components/public/MembersOnlyGate).
 *
 * Only a SAME-ORIGIN PATH is honoured: it must start with a single `/`, and nothing that a browser would
 * read as another origin (`//host`, `/\host`), a scheme, or a control character gets through. Anything
 * else answers null and the caller keeps its default destination — an open redirect on the login page
 * is a phishing primitive.
 */
export function safeReturnPath(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const value = raw.trim();
    if (!value || value.length > 2000) return null;
    if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
    if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
    // Resolve against a dummy origin: if the result leaves it, the path was not a path.
    try {
        const url = new URL(value, "http://same.invalid");
        if (url.origin !== "http://same.invalid") return null;
        return url.pathname + url.search + url.hash;
    } catch {
        return null;
    }
}

/** The `redirect` query parameter of the current page, validated (client only; null on the server). */
export function currentReturnPath(): string | null {
    if (typeof window === "undefined") return null;
    try {
        return safeReturnPath(new URLSearchParams(window.location.search).get("redirect"));
    } catch {
        return null;
    }
}
