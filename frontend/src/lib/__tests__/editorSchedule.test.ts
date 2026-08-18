/**
 * Scheduled publishing — the editor host's payload contract (lib/editorSchedule).
 *
 * The backend model resolves 'publish' + future date → 'future' and arms/re-arms/cancels the flip
 * cron; the editor's whole job is to SEND the right {status, date} pair. These pin that contract:
 *
 *   • 'future' becomes { status: 'publish', date: <chosen instant> } — never a literal 'future', so
 *     the request rides the SAME publish-capability gate as a normal publish;
 *   • 'future' without a valid date is null — the host must BLOCK the save (silently scheduling "for
 *     now" or publishing immediately would both betray the author's intent);
 *   • publish-now LEAVING a scheduled post carries date=now — without it the model re-evaluates the
 *     STORED future date and would silently re-schedule instead of publishing;
 *   • every other transition carries NO date — a plain save must never rewrite post_date.
 *
 * Conversions are asserted TZ-agnostically (expectations built through the same local-time APIs).
 */
import { describe, it, expect } from "vitest";
import {
    buildStatusPatch,
    dbDateToLocalInput,
    defaultScheduleInput,
    localInputToIso,
    toLocalInputValue,
} from "../editorSchedule";

describe("editorSchedule — datetime conversions", () => {
    it("toLocalInputValue formats local components with zero-padding, minute precision", () => {
        expect(toLocalInputValue(new Date(2026, 0, 5, 9, 7, 33))).toBe("2026-01-05T09:07");
    });

    it("dbDateToLocalInput prefers the GMT twin and converts the exact instant to local", () => {
        const expected = toLocalInputValue(new Date("2026-08-20T10:00:00Z"));
        expect(dbDateToLocalInput("2026-08-20 10:00:00", "1999-01-01 00:00:00")).toBe(expected);
    });

    it("dbDateToLocalInput falls back to the server-local string, parsed as local", () => {
        expect(dbDateToLocalInput(undefined, "2026-08-20 10:30:00")).toBe("2026-08-20T10:30");
    });

    it("dbDateToLocalInput yields '' for junk/missing dates", () => {
        expect(dbDateToLocalInput("not a date", "also junk")).toBe("");
        expect(dbDateToLocalInput(null, null)).toBe("");
    });

    it("defaultScheduleInput is one hour from now, on the minute", () => {
        const now = new Date(2026, 7, 17, 14, 25, 59);
        expect(defaultScheduleInput(now)).toBe("2026-08-17T15:25");
    });

    it("localInputToIso round-trips through local parsing; empty/junk → null", () => {
        const value = "2026-08-20T10:30";
        expect(localInputToIso(value)).toBe(new Date(value).toISOString());
        expect(localInputToIso("")).toBeNull();
        expect(localInputToIso("junk")).toBeNull();
    });
});

describe("editorSchedule — buildStatusPatch", () => {
    const NOW = new Date("2026-08-17T12:00:00Z");

    it("'future' + chosen date → publish + that instant (the model turns it into 'future')", () => {
        const input = "2026-08-20T10:30";
        expect(buildStatusPatch("future", input, "draft", NOW)).toEqual({
            status: "publish",
            date: new Date(input).toISOString(),
        });
    });

    it("'future' without a valid date → null (the host must block the save)", () => {
        expect(buildStatusPatch("future", "", "draft", NOW)).toBeNull();
        expect(buildStatusPatch("future", "junk", "future", NOW)).toBeNull();
    });

    it("publish-now leaving a scheduled post carries date=now (beats the stored future date)", () => {
        expect(buildStatusPatch("publish", "2099-01-01T00:00", "future", NOW)).toEqual({
            status: "publish",
            date: NOW.toISOString(),
        });
    });

    it("a normal publish carries NO date (a plain save must never rewrite post_date)", () => {
        const patch = buildStatusPatch("publish", "2099-01-01T00:00", "publish", NOW);
        expect(patch).toEqual({ status: "publish" });
        expect(patch && "date" in patch).toBe(false);
    });

    it("unscheduling to draft/pending passes through with no date (backend cancels the event)", () => {
        expect(buildStatusPatch("draft", "2099-01-01T00:00", "future", NOW)).toEqual({ status: "draft" });
        expect(buildStatusPatch("pending", "", "future", NOW)).toEqual({ status: "pending" });
    });
});
