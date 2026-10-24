/**
 * «Condiciones de salud» (2.32.0) — pure helpers shared by the admin's inscription form and the coordinators'
 * portal (mirror of server/health.js). No React, no fetch: unit-tested on its own.
 *
 * The answer: { conditions: string[], other: string, answer: 'list' | 'none' | 'declined' }, or null (not
 * answered). «Otros» is always offered and needs its text; «Ninguna» and «Prefiero no responder» clear the list.
 * The answers are special-category data: the server keeps them apart and only health:view reads them.
 *
 * 2.36.9: «Tipo de sangre» (one of BLOOD_TYPES) and «EPS» (the health insurer, free text) ride on the same answer
 * as `blood_type` / `eps` — present only when given, so they follow every rule of the health data (consent,
 * opt-out, the health:view permission) with no path of their own. They are optional and independent of the
 * conditions: «Ninguna» or «Prefiero no responder» keep them; an answer with only them is not a conditions answer.
 */

export const HEALTH_FIELD = 'health_conditions';
export const HEALTH_TYPE = 'health';
export const HEALTH_OTHER = 'Otros';
export const HEALTH_OTHER_MAX = 200;

export type HealthAnswer = { conditions: string[]; other: string; answer: 'list' | 'none' | 'declined'; blood_type?: string; eps?: string };

/** «Tipo de sangre»: the eight groups and «No sabe» (the same list and order as server/health.js). */
export const BLOOD_TYPES = ['A+', 'A−', 'B+', 'B−', 'AB+', 'AB−', 'O+', 'O−', 'No sabe'] as const;
export const EPS_MAX = 120;
/** A typed «A-» is the list's «A−» (the minus sign); anything not in the list is no answer. */
export const bloodTypeOf = (v: unknown): string => {
    const raw = String(v ?? '').trim();
    if (raw.toLowerCase() === 'no sabe') return 'No sabe';
    const s = raw.replace(/-/g, '−').toUpperCase();
    return (BLOOD_TYPES as readonly string[]).includes(s) ? s : '';
};
/** The parts that are not the conditions (blood type, EPS), only when given. */
const extrasOf = (a: Partial<HealthAnswer> | null | undefined): { blood_type?: string; eps?: string } => {
    const out: { blood_type?: string; eps?: string } = {};
    const b = bloodTypeOf(a && a.blood_type);
    const e = String((a && a.eps) || '').slice(0, EPS_MAX);
    if (b) out.blood_type = b;
    if (e.trim()) out.eps = e;
    return out;
};
const hasExtras = (a: Partial<HealthAnswer> | null | undefined): boolean => Object.keys(extrasOf(a)).length > 0;
/** Did the person answer the conditions part (a condition ticked, «Ninguna» or «Prefiero no responder»)? */
export const conditionsAnswered = (a: HealthAnswer | null | undefined): boolean => !!a && (a.answer !== 'list' || a.conditions.length > 0);

export const isHealthField = (f: { name?: unknown; type?: unknown } | null | undefined): boolean =>
    !!f && (f.type === HEALTH_TYPE || f.name === HEALTH_FIELD);

/** The field's conditions (without «Otros», which is always offered last). */
export const healthOptions = (field: { options?: string | null } | null | undefined): string[] =>
    String((field && field.options) || '').split(',').map(s => s.trim()).filter(s => s && s !== HEALTH_OTHER);

const empty = (): HealthAnswer => ({ conditions: [], other: '', answer: 'list' });
/** The answer, or null when nothing at all is left (no condition, no blood type, no EPS). */
const orNull = (a: HealthAnswer): HealthAnswer | null => (conditionsAnswered(a) || a.other || hasExtras(a) ? a : null);

/** Tick / untick one condition («Otros» included). Ticking one leaves «Ninguna» / «Prefiero no responder». */
export function toggleCondition(a: HealthAnswer | null, condition: string): HealthAnswer | null {
    const cur = a && a.answer === 'list' ? a : empty();
    const has = cur.conditions.includes(condition);
    const conditions = has ? cur.conditions.filter(c => c !== condition) : [...cur.conditions, condition];
    const other = condition === HEALTH_OTHER && has ? '' : cur.other;
    return orNull({ conditions, other, answer: 'list', ...extrasOf(a) });
}
/** «Ninguna» / «Prefiero no responder»: choosing it again clears the answer. */
export const chooseSpecial = (a: HealthAnswer | null, which: 'none' | 'declined'): HealthAnswer | null =>
    a && a.answer === which ? orNull({ ...empty(), ...extrasOf(a) }) : { conditions: [], other: '', answer: which, ...extrasOf(a) };
/** The «Otros» text (ticks «Otros» when typed into). */
export function setOtherText(a: HealthAnswer | null, text: string): HealthAnswer | null {
    const cur = a && a.answer === 'list' ? a : empty();
    const conditions = cur.conditions.includes(HEALTH_OTHER) || !text ? cur.conditions : [...cur.conditions, HEALTH_OTHER];
    return { conditions, other: text.slice(0, HEALTH_OTHER_MAX), answer: 'list', ...extrasOf(a) };
}
/** «Tipo de sangre» chosen ('' clears it); the rest of the answer stays. */
export function setBloodType(a: HealthAnswer | null, blood: string): HealthAnswer | null {
    const { blood_type: _b, ...rest } = a || empty();
    const b = bloodTypeOf(blood);
    return orNull({ ...empty(), ...rest, ...(b ? { blood_type: b } : {}) });
}
/** «EPS» typed ('' clears it); the rest of the answer stays. */
export function setEps(a: HealthAnswer | null, eps: string): HealthAnswer | null {
    const { eps: _e, ...rest } = a || empty();
    const e = String(eps || '').slice(0, EPS_MAX);
    return orNull({ ...empty(), ...rest, ...(e ? { eps: e } : {}) });
}

/** Why the answer cannot be sent, or null: 'required' (nothing chosen) or 'other' («Otros» without text). */
export function healthAnswerError(field: { is_required?: unknown } | null | undefined, a: HealthAnswer | null): 'required' | 'other' | null {
    if (a && a.answer === 'list' && a.conditions.includes(HEALTH_OTHER) && !a.other.trim()) return 'other';
    // A required field asks for the conditions part; a blood type or an EPS alone does not answer it.
    if (!conditionsAnswered(a) && field && Number(field.is_required)) return 'required';
    return null;
}

/** The answer as the server wants it: the options in the field's order, «Otros» last, text trimmed; null when empty. */
export function healthPayload(field: { options?: string | null }, a: HealthAnswer | null): HealthAnswer | null {
    if (!a) return null;
    const extras = extrasOf(a);
    if (extras.eps) extras.eps = extras.eps.trim();
    if (a.answer !== 'list') return { conditions: [], other: '', answer: a.answer, ...extras };
    const opts = healthOptions(field);
    const conditions = opts.filter(o => a.conditions.includes(o));
    if (a.conditions.includes(HEALTH_OTHER)) conditions.push(HEALTH_OTHER);
    if (!conditions.length) return Object.keys(extras).length ? { conditions: [], other: '', answer: 'list', ...extras } : null;
    return { conditions, other: conditions.includes(HEALTH_OTHER) ? a.other.trim() : '', answer: 'list', ...extras };
}

/** One line of text («Diabetes, Otros: migraña», «Ninguna», «Prefiere no responder»). */
export function healthAnswerText(a: HealthAnswer | null | undefined): string {
    if (!a) return '';
    const parts: string[] = [];
    if (a.answer === 'none') parts.push('Ninguna');
    else if (a.answer === 'declined') parts.push('Prefiere no responder');
    else { const c = (a.conditions || []).map(c => (c === HEALTH_OTHER && a.other ? `${HEALTH_OTHER}: ${a.other}` : c)).join(', '); if (c) parts.push(c); }
    const x = extrasOf(a);
    if (x.blood_type) parts.push(`Tipo de sangre: ${x.blood_type}`);
    if (x.eps) parts.push(`EPS: ${x.eps.trim()}`);
    return parts.join(' · ');
}

export const sameHealthAnswer = (a: HealthAnswer | null, b: HealthAnswer | null): boolean =>
    JSON.stringify(a || null) === JSON.stringify(b || null);
