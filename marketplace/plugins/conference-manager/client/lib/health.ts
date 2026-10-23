/**
 * «Condiciones de salud» (2.32.0) — pure helpers shared by the admin's inscription form and the coordinators'
 * portal (mirror of server/health.js). No React, no fetch: unit-tested on its own.
 *
 * The answer: { conditions: string[], other: string, answer: 'list' | 'none' | 'declined' }, or null (not
 * answered). «Otros» is always offered and needs its text; «Ninguna» and «Prefiero no responder» clear the list.
 * The answers are special-category data: the server keeps them apart and only health:view reads them.
 */

export const HEALTH_FIELD = 'health_conditions';
export const HEALTH_TYPE = 'health';
export const HEALTH_OTHER = 'Otros';
export const HEALTH_OTHER_MAX = 200;

export type HealthAnswer = { conditions: string[]; other: string; answer: 'list' | 'none' | 'declined' };

export const isHealthField = (f: { name?: unknown; type?: unknown } | null | undefined): boolean =>
    !!f && (f.type === HEALTH_TYPE || f.name === HEALTH_FIELD);

/** The field's conditions (without «Otros», which is always offered last). */
export const healthOptions = (field: { options?: string | null } | null | undefined): string[] =>
    String((field && field.options) || '').split(',').map(s => s.trim()).filter(s => s && s !== HEALTH_OTHER);

const empty = (): HealthAnswer => ({ conditions: [], other: '', answer: 'list' });

/** Tick / untick one condition («Otros» included). Ticking one leaves «Ninguna» / «Prefiero no responder». */
export function toggleCondition(a: HealthAnswer | null, condition: string): HealthAnswer | null {
    const cur = a && a.answer === 'list' ? a : empty();
    const has = cur.conditions.includes(condition);
    const conditions = has ? cur.conditions.filter(c => c !== condition) : [...cur.conditions, condition];
    const other = condition === HEALTH_OTHER && has ? '' : cur.other;
    return conditions.length || other ? { conditions, other, answer: 'list' } : null;
}
/** «Ninguna» / «Prefiero no responder»: choosing it again clears the answer. */
export const chooseSpecial = (a: HealthAnswer | null, which: 'none' | 'declined'): HealthAnswer | null =>
    a && a.answer === which ? null : { conditions: [], other: '', answer: which };
/** The «Otros» text (ticks «Otros» when typed into). */
export function setOtherText(a: HealthAnswer | null, text: string): HealthAnswer | null {
    const cur = a && a.answer === 'list' ? a : empty();
    const conditions = cur.conditions.includes(HEALTH_OTHER) || !text ? cur.conditions : [...cur.conditions, HEALTH_OTHER];
    return { conditions, other: text.slice(0, HEALTH_OTHER_MAX), answer: 'list' };
}

/** Why the answer cannot be sent, or null: 'required' (nothing chosen) or 'other' («Otros» without text). */
export function healthAnswerError(field: { is_required?: unknown } | null | undefined, a: HealthAnswer | null): 'required' | 'other' | null {
    if (a && a.answer === 'list' && a.conditions.includes(HEALTH_OTHER) && !a.other.trim()) return 'other';
    const answered = !!a && (a.answer !== 'list' || a.conditions.length > 0);
    if (!answered && field && Number(field.is_required)) return 'required';
    return null;
}

/** The answer as the server wants it: the options in the field's order, «Otros» last, text trimmed; null when empty. */
export function healthPayload(field: { options?: string | null }, a: HealthAnswer | null): HealthAnswer | null {
    if (!a) return null;
    if (a.answer !== 'list') return { conditions: [], other: '', answer: a.answer };
    const opts = healthOptions(field);
    const conditions = opts.filter(o => a.conditions.includes(o));
    if (a.conditions.includes(HEALTH_OTHER)) conditions.push(HEALTH_OTHER);
    if (!conditions.length) return null;
    return { conditions, other: conditions.includes(HEALTH_OTHER) ? a.other.trim() : '', answer: 'list' };
}

/** One line of text («Diabetes, Otros: migraña», «Ninguna», «Prefiere no responder»). */
export function healthAnswerText(a: HealthAnswer | null | undefined): string {
    if (!a) return '';
    if (a.answer === 'none') return 'Ninguna';
    if (a.answer === 'declined') return 'Prefiere no responder';
    return (a.conditions || []).map(c => (c === HEALTH_OTHER && a.other ? `${HEALTH_OTHER}: ${a.other}` : c)).join(', ');
}

export const sameHealthAnswer = (a: HealthAnswer | null, b: HealthAnswer | null): boolean =>
    JSON.stringify(a || null) === JSON.stringify(b || null);
