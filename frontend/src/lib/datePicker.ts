/**
 * The calendar behind components/ui/DatePicker — pure, so the component and its tests share it.
 *
 * VALUES ARE THE NATIVE INPUTS' STRINGS. A date is `YYYY-MM-DD` (what `<input type="date">` gave), a date
 * and time `YYYY-MM-DDTHH:mm` (`datetime-local`). The picker replaces those inputs without changing a
 * byte of what is stored or sent, so no data migrates. Dates are compared as those strings: in that shape
 * the lexical order IS the chronological one, and no time zone is ever involved (a calendar day is not an
 * instant).
 */

export interface DayRef { y: number; m: number; d: number } // m: 1–12

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function formatDay({ y, m, d }: DayRef): string {
    return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

export function daysInMonth(y: number, m: number): number {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** `YYYY-MM-DD` (or the date part of `YYYY-MM-DDTHH:mm`) → a real calendar day, or null. */
export function parseDay(value: string | null | undefined): DayRef | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(value ?? "");
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
    return { y, m: mo, d };
}

/** The `HH:mm` of a datetime value, or null. */
export function parseTime(value: string | null | undefined): { h: number; min: number } | null {
    const m = /T(\d{2}):(\d{2})/.exec(value ?? "");
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]);
    return h <= 23 && min <= 59 ? { h, min } : null;
}

export function formatDateTime(day: DayRef, time: { h: number; min: number }): string {
    return `${formatDay(day)}T${pad(time.h)}:${pad(time.min)}`;
}

/** Day of week, 0 = Sunday … 6 = Saturday. */
export function weekday({ y, m, d }: DayRef): number {
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(day: DayRef, n: number): DayRef {
    const t = new Date(Date.UTC(day.y, day.m - 1, day.d + n));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** The same day n months later, clamped to the target month's length (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(day: DayRef, n: number): DayRef {
    const idx = day.y * 12 + (day.m - 1) + n;
    const y = Math.floor(idx / 12), m = (idx % 12) + 1;
    return { y, m, d: Math.min(day.d, daysInMonth(y, m)) };
}

/** `start_of_week` (WordPress's option: 0 = Sunday … 6 = Saturday) → a valid weekday; Monday otherwise. */
export function normalizeWeekStart(value: unknown): number {
    const n = typeof value === "number" ? value : typeof value === "string" && /^\d$/.test(value.trim()) ? Number(value) : NaN;
    return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 1;
}

/** The first and last day of the week `day` falls in, for a week starting on `weekStart`. */
export function weekBounds(day: DayRef, weekStart: number): { start: DayRef; end: DayRef } {
    const back = (weekday(day) - weekStart + 7) % 7;
    const start = addDays(day, -back);
    return { start, end: addDays(start, 6) };
}

export interface GridCell { day: DayRef; value: string; inMonth: boolean }

/** Six full weeks covering `month` (always 42 cells, so the grid never changes height between months). */
export function monthGrid(y: number, m: number, weekStart: number): GridCell[][] {
    const first: DayRef = { y, m, d: 1 };
    let cursor = weekBounds(first, weekStart).start;
    const weeks: GridCell[][] = [];
    for (let w = 0; w < 6; w++) {
        const row: GridCell[] = [];
        for (let i = 0; i < 7; i++) {
            row.push({ day: cursor, value: formatDay(cursor), inMonth: cursor.m === m && cursor.y === y });
            cursor = addDays(cursor, 1);
        }
        weeks.push(row);
    }
    return weeks;
}

/** Is the day allowed by min/max (each a date or datetime string; only the date part counts)? */
export function dayAllowed(value: string, min?: string | null, max?: string | null): boolean {
    const lo = parseDay(min), hi = parseDay(max);
    if (lo && value < formatDay(lo)) return false;
    if (hi && value > formatDay(hi)) return false;
    return true;
}

/** The nearest allowed day to `day` (min/max), for keyboard moves that would leave the range. */
export function clampDay(day: DayRef, min?: string | null, max?: string | null): DayRef {
    const v = formatDay(day);
    const lo = parseDay(min), hi = parseDay(max);
    if (lo && v < formatDay(lo)) return lo;
    if (hi && v > formatDay(hi)) return hi;
    return day;
}

/**
 * The day a grid key moves focus to (WAI-ARIA date picker dialog pattern): arrows by a day/week,
 * Home/End to the week's edges, PageUp/PageDown by a month (with Shift, a year). null for other keys.
 */
export function keyTarget(key: string, shift: boolean, day: DayRef, weekStart: number): DayRef | null {
    switch (key) {
        case "ArrowLeft": return addDays(day, -1);
        case "ArrowRight": return addDays(day, 1);
        case "ArrowUp": return addDays(day, -7);
        case "ArrowDown": return addDays(day, 7);
        case "Home": return weekBounds(day, weekStart).start;
        case "End": return weekBounds(day, weekStart).end;
        case "PageUp": return addMonths(day, shift ? -12 : -1);
        case "PageDown": return addMonths(day, shift ? 12 : 1);
        default: return null;
    }
}

/** Today in the browser's calendar (the native inputs used the same). */
export function today(now: Date = new Date()): DayRef {
    return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}

/* ── Localised names (es/en/pt via Intl: the admin language, not the browser's) ───────────────────── */

const LOCALE: Record<string, string> = { es: "es-ES", en: "en-US", pt: "pt-BR" };
export const pickerLocale = (lang: string) => LOCALE[lang] ?? "en-US";

export function monthName(lang: string, m: number, y = 2001): string {
    const s = new Intl.DateTimeFormat(pickerLocale(lang), { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
    return s.charAt(0).toLocaleUpperCase(pickerLocale(lang)) + s.slice(1);
}

/** Weekday headers in display order, starting at `weekStart`: short label + full name (for abbr/aria). */
export function weekdayNames(lang: string, weekStart: number): { short: string; long: string }[] {
    const loc = pickerLocale(lang);
    const short = new Intl.DateTimeFormat(loc, { weekday: "short", timeZone: "UTC" });
    const long = new Intl.DateTimeFormat(loc, { weekday: "long", timeZone: "UTC" });
    // 2001-01-07 was a Sunday.
    return Array.from({ length: 7 }, (_, i) => {
        const date = new Date(Date.UTC(2001, 0, 7 + ((weekStart + i) % 7)));
        return { short: short.format(date).replace(/\.$/, ""), long: long.format(date) };
    });
}

/** A day spelled out for a screen reader and for the trigger: "martes, 21 de octubre de 2026". */
export function longDate(lang: string, day: DayRef): string {
    return new Intl.DateTimeFormat(pickerLocale(lang), { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
        .format(new Date(Date.UTC(day.y, day.m - 1, day.d)));
}

/** The trigger's text: the stored value in the admin language's short form (date, or date and time). */
export function displayValue(lang: string, value: string, withTime: boolean): string {
    const day = parseDay(value);
    if (!day) return "";
    const date = new Intl.DateTimeFormat(pickerLocale(lang), { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })
        .format(new Date(Date.UTC(day.y, day.m - 1, day.d)));
    const time = withTime ? parseTime(value) : null;
    return time ? `${date}, ${pad(time.h)}:${pad(time.min)}` : date;
}
