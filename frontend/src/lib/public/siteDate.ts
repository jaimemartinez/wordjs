/**
 * A post or comment date as the public site prints it: in the SITE's language (`WPLANG`, the value
 * that drives `<html lang>` — lib/documentLanguage), never the visitor's browser or the server host.
 *
 * `toLocaleDateString()` with no locale formatted with whatever the runtime happened to be: an
 * English site read by a Spanish browser showed `2/3/2024` (day/month), and the same call on the
 * server bakes the HOST's locale into cached HTML. The day is read off the date STRING — `post_date`
 * and `comment_date` are site-local wall time — and formatted in UTC, so no zone can move it to the
 * previous day (the same reasoning as lib/public/archives `postDateLabel`). Deterministic, so the
 * server and the client render the same text and there is nothing to hydrate.
 */
import { resolveDocumentLanguage } from "@/lib/documentLanguage";

const LONG_DATE: Intl.DateTimeFormatOptions = { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" };

/** "March 2, 2024" / "2 de marzo de 2024" for a `YYYY-MM-DD…` date; "" for anything unreadable. */
export function formatSiteDate(date: unknown, lang: string | null | undefined): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date ?? ""));
    if (!m) return "";
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return "";
    const at = new Date(Date.UTC(parseInt(m[1], 10), month - 1, day));
    try {
        return new Intl.DateTimeFormat(lang || "en", LONG_DATE).format(at);
    } catch {
        // resolveDocumentLanguage only yields well-formed tags, but a runtime without that locale's
        // data must still print a date rather than throw out of a page render.
        return new Intl.DateTimeFormat("en", LONG_DATE).format(at);
    }
}

/** The language tag dates are formatted in, from the site's settings (nothing configured → `en`). */
export function siteDateLanguage(settings: Record<string, unknown> | null | undefined): string {
    return resolveDocumentLanguage(settings).lang;
}
