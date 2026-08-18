/**
 * Scheduled publishing helpers for the Verso editor hosts (posts & pages).
 *
 * The backend is the authority: the model stores a future-dated 'publish' as 'future' and arms the
 * flip cron (backend/src/core/scheduled-publish.ts). The editor therefore only ever SENDS
 * status 'publish' plus an explicit `date` — never 'future' — so the request rides the SAME
 * publish-capability gate as a normal publish (routes downgrade non-publishers to 'pending';
 * scheduling must not be a side door around review).
 */

/** UI select value for a scheduled post ('future' is the WordPress-parity DB status). */
export const SCHEDULED_STATUS = "future";

const pad = (n: number) => String(n).padStart(2, "0");

/** Format a Date as the value `<input type="datetime-local">` expects (LOCAL time, minute precision). */
export function toLocalInputValue(d: Date): string {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A stored post date → datetime-local input value. Prefers the GMT twin (an exact instant); falls
 * back to the server-local string, parsed as browser-local — right whenever both clocks share a zone.
 */
export function dbDateToLocalInput(dateGmt?: string | null, dateLocal?: string | null): string {
    if (dateGmt) {
        const d = new Date(dateGmt.replace(" ", "T") + "Z");
        if (!Number.isNaN(d.getTime())) return toLocalInputValue(d);
    }
    if (dateLocal) {
        const d = new Date(dateLocal.replace(" ", "T"));
        if (!Number.isNaN(d.getTime())) return toLocalInputValue(d);
    }
    return "";
}

/** Default schedule when the author switches to "Scheduled": one hour from now, on the minute. */
export function defaultScheduleInput(now: Date = new Date()): string {
    const d = new Date(now.getTime() + 60 * 60 * 1000);
    d.setSeconds(0, 0);
    return toLocalInputValue(d);
}

/** datetime-local value → ISO instant, or null when empty/unparseable. */
export function localInputToIso(value: string): string | null {
    if (!value) return null;
    const d = new Date(value); // a datetime-local string parses as LOCAL time
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The status/date part of a save payload.
 *
 *  - 'future' → { status: 'publish', date: <chosen instant> } (the model stores 'future' + arms the
 *    cron); null when no valid date was chosen — the caller must block the save and ask for one.
 *  - 'publish' LEAVING a scheduled post → { status: 'publish', date: now }: without the explicit
 *    date the model re-evaluates the STORED future date and would silently re-schedule instead of
 *    publishing now.
 *  - anything else passes through with NO date (a plain save must never rewrite post_date; and the
 *    backend already cancels the pending event when a post leaves 'future', so "unschedule to
 *    draft" needs nothing extra here).
 */
export function buildStatusPatch(
    uiStatus: string,
    scheduleInput: string,
    lastServerStatus: string,
    now: Date = new Date()
): { status: string; date?: string } | null {
    if (uiStatus === SCHEDULED_STATUS) {
        const iso = localInputToIso(scheduleInput);
        return iso ? { status: "publish", date: iso } : null;
    }
    if (uiStatus === "publish" && lastServerStatus === SCHEDULED_STATUS) {
        return { status: "publish", date: now.toISOString() };
    }
    return { status: uiStatus };
}
