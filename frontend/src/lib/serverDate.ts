/**
 * Dates as the API sends them: `"2026-10-21 11:45:03"`, with no zone.
 *
 * `new Date("2026-10-21 11:45:03")` reads that as the BROWSER's local time, so every timestamp in the
 * admin was off by the viewer's UTC offset ("in 5 hours" on a revision saved a second ago). Records
 * carry a `…Gmt` twin (post_date_gmt, comment_date_gmt, post_modified_gmt), which is an exact instant:
 * that one is read as UTC. Only when it is missing does the server-local value stand in, read as
 * browser-local — right whenever both clocks share a zone, which is the best that string allows.
 * A value that already names its zone (ISO with `Z` or an offset) is parsed as written.
 */
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function parseOne(value: string, asUtc: boolean): Date | null {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("0000-00-00")) return null;
    const iso = trimmed.replace(" ", "T");
    const d = new Date(HAS_ZONE.test(iso) || !asUtc ? iso : `${iso}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function parseServerDate(gmt?: string | null, local?: string | null): Date | null {
    if (typeof gmt === "string") {
        const d = parseOne(gmt, true);
        if (d) return d;
    }
    if (typeof local === "string") return parseOne(local, false);
    return null;
}

/** Locale date-time text for a server date, or `fallback` when there is nothing parseable. */
export function formatServerDateTime(gmt?: string | null, local?: string | null, fallback = ""): string {
    const d = parseServerDate(gmt, local);
    return d ? d.toLocaleString() : fallback;
}
