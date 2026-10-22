/**
 * The admin's own calendar (components/ui/DatePicker) — the pure part: values in the native inputs'
 * format, the grid, the first day of the week from settings, min/max, keyboard moves and localised names.
 */
import { describe, expect, it } from "vitest";
import {
    addMonths, clampDay, dayAllowed, displayValue, formatDateTime, formatDay, keyTarget, longDate, monthGrid,
    monthName, normalizeWeekStart, parseDay, parseTime, weekBounds, weekdayNames,
} from "@/lib/datePicker";

describe("values stay the native inputs' strings (no data migration)", () => {
    it("parses and formats YYYY-MM-DD and YYYY-MM-DDTHH:mm", () => {
        expect(parseDay("2026-10-22")).toEqual({ y: 2026, m: 10, d: 22 });
        expect(parseDay("2026-10-22T09:05")).toEqual({ y: 2026, m: 10, d: 22 });
        expect(parseTime("2026-10-22T09:05")).toEqual({ h: 9, min: 5 });
        expect(formatDay({ y: 2026, m: 3, d: 7 })).toBe("2026-03-07");
        expect(formatDateTime({ y: 2026, m: 3, d: 7 }, { h: 8, min: 0 })).toBe("2026-03-07T08:00");
    });

    it("rejects what is not a real day", () => {
        for (const bad of ["", "2026-02-30", "2026-13-01", "26-10-22", "2026/10/22", "garbage", null, undefined]) {
            expect(parseDay(bad as string), String(bad)).toBeNull();
        }
        expect(parseDay("2024-02-29")).not.toBeNull(); // leap year
        expect(parseTime("2026-10-22T24:00")).toBeNull();
    });
});

describe("the grid and the first day of the week", () => {
    it("start_of_week from settings: 0–6, Monday for anything else", () => {
        expect(normalizeWeekStart(0)).toBe(0);
        expect(normalizeWeekStart("6")).toBe(6);
        for (const bad of [undefined, "", "7", -1, "monday", null]) expect(normalizeWeekStart(bad)).toBe(1);
    });

    it("six full weeks, starting on the configured weekday", () => {
        // October 2026 starts on a Thursday.
        const monday = monthGrid(2026, 10, 1);
        expect(monday).toHaveLength(6);
        expect(monday.every((w) => w.length === 7)).toBe(true);
        expect(monday[0][0].value).toBe("2026-09-28"); // the Monday before
        expect(monday[0][3]).toMatchObject({ value: "2026-10-01", inMonth: true });
        const sunday = monthGrid(2026, 10, 0);
        expect(sunday[0][0].value).toBe("2026-09-27");
        expect(sunday[0][4].value).toBe("2026-10-01");
    });

    it("the week's bounds follow the configured start", () => {
        expect(weekBounds({ y: 2026, m: 10, d: 22 }, 1)).toEqual({ start: { y: 2026, m: 10, d: 19 }, end: { y: 2026, m: 10, d: 25 } });
        expect(weekBounds({ y: 2026, m: 10, d: 22 }, 0).start).toEqual({ y: 2026, m: 10, d: 18 });
    });
});

describe("min / max", () => {
    it("compares days, ignoring a datetime's time part", () => {
        expect(dayAllowed("2026-10-21", "2026-10-22T15:30")).toBe(false);
        expect(dayAllowed("2026-10-22", "2026-10-22T15:30")).toBe(true);
        expect(dayAllowed("2026-12-31", null, "2026-12-30")).toBe(false);
        expect(clampDay({ y: 2026, m: 1, d: 1 }, "2026-02-01")).toEqual({ y: 2026, m: 2, d: 1 });
    });
});

describe("keyboard (WAI-ARIA date picker dialog)", () => {
    const day = { y: 2026, m: 1, d: 31 };
    it("arrows move by a day or a week; Home/End to the week's edges", () => {
        expect(keyTarget("ArrowRight", false, day, 1)).toEqual({ y: 2026, m: 2, d: 1 });
        expect(keyTarget("ArrowUp", false, day, 1)).toEqual({ y: 2026, m: 1, d: 24 });
        expect(keyTarget("Home", false, day, 1)).toEqual({ y: 2026, m: 1, d: 26 });
        expect(keyTarget("End", false, day, 0)).toEqual({ y: 2026, m: 1, d: 31 });
    });
    it("PageUp/PageDown by a month (Shift: a year), clamped to the month's length", () => {
        expect(keyTarget("PageDown", false, day, 1)).toEqual({ y: 2026, m: 2, d: 28 });
        expect(keyTarget("PageUp", true, day, 1)).toEqual({ y: 2025, m: 1, d: 31 });
        expect(addMonths({ y: 2024, m: 1, d: 31 }, 1)).toEqual({ y: 2024, m: 2, d: 29 });
        expect(keyTarget("Enter", false, day, 1)).toBeNull();
    });
});

describe("names follow the admin language (es/en/pt), not the browser", () => {
    it("months and weekdays", () => {
        expect(monthName("es", 10)).toBe("Octubre");
        expect(monthName("en", 10)).toBe("October");
        expect(monthName("pt", 10)).toBe("Outubro");
        const es = weekdayNames("es", 1);
        expect(es[0].long.toLowerCase()).toBe("lunes");
        expect(es[6].long.toLowerCase()).toBe("domingo");
        expect(weekdayNames("en", 0)[0].long).toBe("Sunday");
        expect(weekdayNames("pt", 1)[0].long.toLowerCase()).toContain("segunda");
    });
    it("the trigger text and the spoken date", () => {
        expect(displayValue("en", "2026-10-22T09:05", true)).toMatch(/Oct.*22.*2026, 09:05/);
        expect(displayValue("es", "2026-10-22", false)).toMatch(/22.*oct.*2026/i);
        expect(displayValue("en", "", false)).toBe("");
        expect(longDate("es", { y: 2026, m: 10, d: 22 })).toMatch(/jueves, 22 de octubre de 2026/);
    });
});
