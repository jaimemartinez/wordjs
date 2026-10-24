/**
 * «Turnos de comida» (2.32.0) — pure helpers of the «Turnos» tab and the scanner chip. No React, no fetch.
 * The model itself is the server's (server/meal-priority.js); these only present what it answers.
 */

export const MEAL_GROUPS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export type MealGroup = typeof MEAL_GROUPS[number];

/** One background per letter (white text on each, ≥ 4.5:1). */
export const GROUP_TONES: Record<string, string> = {
    A: 'bg-rose-700', B: 'bg-orange-700', C: 'bg-amber-700', D: 'bg-emerald-700', E: 'bg-sky-700', F: 'bg-indigo-700',
};

/** Largest minus smallest group (0 = all equal). */
export function groupSizeSpread(counts: Record<string, number> | null | undefined): number {
    const ns = MEAL_GROUPS.map(g => Number((counts || {})[g]) || 0);
    return Math.max(...ns) - Math.min(...ns);
}

type PersonRow = { name?: string | null; location?: string | null; family_group?: string | null; group?: string | null };
const fold = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** People matching the search (name, location or family, accents ignored) and, when given, one group. */
export function peopleFilter<T extends PersonRow>(rows: readonly T[], q: string, group: string): T[] {
    const words = fold(q).split(/\s+/).filter(Boolean);
    return rows.filter(p => (!group || p.group === group)
        && words.every(w => fold(`${p.name || ''} ${p.location || ''} ${p.family_group || ''}`).includes(w)));
}

/** «12:15» or «12:15–12:23» for a slot (one time when the group takes under a minute). */
export const turnLine = (s: { start?: string | null; end?: string | null } | null | undefined): string =>
    !s || !s.start ? '' : s.end && s.end !== s.start ? `${s.start}–${s.end}` : s.start;

/** «Llamar grupos» (2.36.5): the next group to call — the first of the service's order not called yet (null: all called). */
export function nextToCall(order: readonly string[] | null | undefined, called: readonly string[] | null | undefined): string | null {
    const done = new Set(called || []);
    return (order || []).find((g) => !done.has(g)) || null;
}
