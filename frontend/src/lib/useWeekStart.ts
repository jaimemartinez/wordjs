"use client";

/**
 * The site's first day of the week (the `start_of_week` option, Settings → General), for every calendar
 * the admin draws. Read once per page load from the public settings and shared by all pickers; Monday
 * until it arrives, or if it cannot be read.
 */
import { useEffect, useState } from "react";
import { settingsApi } from "./api";
import { normalizeWeekStart } from "./datePicker";

let cached: number | null = null;
let pending: Promise<number> | null = null;

function loadWeekStart(): Promise<number> {
    if (cached !== null) return Promise.resolve(cached);
    pending ??= settingsApi.get()
        .then((s) => (cached = normalizeWeekStart((s as Record<string, unknown>)?.start_of_week)))
        .catch(() => (cached = 1));
    return pending;
}

/** Forget the cached value (Settings → General calls it after saving a new start_of_week). */
export function resetWeekStart(value?: unknown): void {
    cached = value === undefined ? null : normalizeWeekStart(value);
    pending = null;
}

export function useWeekStart(override?: number): number {
    const [weekStart, setWeekStart] = useState<number>(override ?? cached ?? 1);
    useEffect(() => {
        if (override !== undefined) return;
        let active = true;
        loadWeekStart().then((v) => { if (active) setWeekStart(v); });
        return () => { active = false; };
    }, [override]);
    return override ?? weekStart;
}
