/**
 * Public post/comment dates follow the SITE language, not the visitor's browser or the server host.
 *
 * The regression: an English site rendered `2/3/2024` for 2 March 2024 to a Spanish browser, because
 * the date was localized with `toLocaleDateString()` and no locale.
 */
import { describe, it, expect } from "vitest";
import { formatSiteDate, siteDateLanguage } from "../public/siteDate";

describe("formatSiteDate", () => {
    it("formats in the site language, whatever the runtime's default locale is", () => {
        expect(formatSiteDate("2024-03-02 10:00:00", "en-US")).toBe("March 2, 2024");
        expect(formatSiteDate("2024-03-02 10:00:00", "es-ES")).toBe("2 de marzo de 2024");
    });

    it("reads the day off the wall-clock string, so no time zone moves it", () => {
        expect(formatSiteDate("2024-03-02 23:59:59", "en")).toBe("March 2, 2024");
        expect(formatSiteDate("2024-03-02T00:00:00.000Z", "en")).toBe("March 2, 2024");
    });

    it("prints nothing for an unreadable date and falls back to English without a language", () => {
        expect(formatSiteDate("not a date", "en")).toBe("");
        expect(formatSiteDate(null, "en")).toBe("");
        expect(formatSiteDate("2024-13-02", "en")).toBe("");
        expect(formatSiteDate("2024-03-02", null)).toBe("March 2, 2024");
    });
});

describe("siteDateLanguage", () => {
    it("is the site's WPLANG, as <html lang> resolves it", () => {
        expect(siteDateLanguage({ WPLANG: "en_US" })).toBe("en-US");
        expect(siteDateLanguage({ WPLANG: "es_ES" })).toBe("es-ES");
        expect(siteDateLanguage({})).toBe("en");
    });
});

describe('formatSiteDate in the site time zone (M3-16)', () => {
    it('dates a UTC moment on the day it falls in the site zone', async () => {
        const { formatSiteDate, siteTimeZone } = await import('@/lib/public/siteDate');
        // 2024-03-02 23:30 in Madrid is 22:30 UTC the same day; 2024-03-03 01:30 in Madrid is 00:30 UTC.
        expect(formatSiteDate('2024-03-03 00:30:00', 'en', { gmt: '2024-03-03 00:30:00', timeZone: 'America/Mexico_City' })).toBe('March 2, 2024');
        expect(formatSiteDate('2024-03-02 22:30:00', 'en', { gmt: '2024-03-02 22:30:00', timeZone: 'Asia/Tokyo' })).toBe('March 3, 2024');
        expect(formatSiteDate('2024-03-02 22:30:00', 'en', { gmt: '2024-03-02 22:30:00', timeZone: 'UTC' })).toBe('March 2, 2024');
        expect(formatSiteDate('2024-03-02 22:30:00', 'en', { gmt: '2024-03-02 22:30:00', timeZone: 'Not/AZone' })).toBe('March 2, 2024');
        expect(siteTimeZone({ timezone_string: 'Europe/Madrid' })).toBe('Europe/Madrid');
        expect(siteTimeZone({})).toBe('UTC');
    });
});

describe("a site on UTC still reads the UTC moment (FALLOS 135)", () => {
    it("dates a comment by dateGmt, not by a local date written with the server's clock", () => {
        // Written at 03:42 UTC on the 23rd by a host at UTC-5, before the backend stored site-local dates.
        const stale = { date: "2026-10-22 22:42:54", gmt: "2026-10-23 03:42:54" };
        expect(formatSiteDate(stale.date, "en", { gmt: stale.gmt, timeZone: "UTC" })).toBe("October 23, 2026");
        expect(formatSiteDate(stale.date, "en", { gmt: stale.gmt, timeZone: "UTC", format: "Y-m-d", timeFormat: "H:i" })).toBe("2026-10-23 03:42");
        // Without a zone the stored day is all there is.
        expect(formatSiteDate(stale.date, "en")).toBe("October 22, 2026");
    });
});
