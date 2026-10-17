/**
 * Milliseconds since the epoch for a timestamp the API sent, or NaN.
 *
 * SQL `CURRENT_TIMESTAMP` columns come back as `YYYY-MM-DD HH:MM:SS` with no zone, and they are UTC.
 * `Date.parse` reads that shape as LOCAL time, so a delivery logged at 12:14 UTC showed as "12:14" on a
 * screen whose other dates (epoch seconds, ISO strings with `Z`) were correctly shown in local time.
 * Numbers are epoch SECONDS (the API's `*_at` integers); strings that already carry a zone are left
 * to `Date.parse`.
 */
export function serverTimestampMs(value: number | string | null | undefined): number {
    if (value == null || value === "") return NaN;
    if (typeof value === "number") return value * 1000;
    const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value);
    return Date.parse(zoneless ? `${value.replace(" ", "T")}Z` : value);
}

/** The timestamp in the viewer's locale and time zone, or an em dash when there is none. */
export function formatServerTimestamp(value: number | string | null | undefined): string {
    const ms = serverTimestampMs(value);
    return Number.isFinite(ms) ? new Date(ms).toLocaleString() : "—";
}
