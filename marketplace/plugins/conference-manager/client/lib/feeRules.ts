/**
 * The price-rule builder's logic (2.36.4), pure so it is tested apart from the screen. A condition's value input
 * follows its field: people are picked from the roster, a locality or a list field from the values this
 * conference's people really have, a number or a date with a range or a bound, a Yes / No switch with a switch.
 * Rules saved before keep their shape: one free-text value (eq, neq, contains, gt…); a list or a range is JSON
 * text in `value` (server: index.js feeRuleMatches).
 */

/** The pseudo field «Personas» (the inscription itself) and the locality, which every person has. */
export const FEE_PERSON = '__person';
export const FEE_LOCATION = 'location';

export type FeeKind = 'always' | 'person' | 'enum' | 'number' | 'date' | 'switch' | 'text';
export type FeeOp = 'any' | 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'filled' | 'empty' | 'in' | 'not_in' | 'between' | 'before' | 'after';
type FieldLike = { name: string; label?: string; type?: string; options?: string | null };

/** What a field's values are: the kind of input its condition gets. */
export function kindOf(fieldName: string, fields: readonly FieldLike[]): FeeKind {
    if (!fieldName) return 'always';
    if (fieldName === FEE_PERSON) return 'person';
    if (fieldName === FEE_LOCATION) return 'enum';
    const f = (fields || []).find((x) => x.name === fieldName);
    const t = f ? String(f.type || 'text') : 'text';
    if (t === 'number') return 'number';
    if (t === 'date') return 'date';
    if (t === 'switch') return 'switch';
    if (t === 'select') return 'enum';
    // A short text (a church, a role, a city…): the values people typed, to pick from; notes stay free text.
    if (t === 'textarea' || t === 'notes') return 'text';
    return 'enum';
}

/** The conditions offered for a kind, the first one the default. */
export const OPS_BY_KIND: Record<FeeKind, FeeOp[]> = {
    always: ['any'],
    person: ['in', 'not_in'],
    enum: ['in', 'not_in', 'contains', 'filled', 'empty'],
    number: ['between', 'gte', 'lte', 'eq', 'gt', 'lt', 'filled', 'empty'],
    date: ['between', 'after', 'before', 'eq', 'filled', 'empty'],
    switch: ['eq'],
    text: ['contains', 'eq', 'neq', 'filled', 'empty'],
};
/** The conditions a rule can show: its kind's, plus the one it already has (an older rule keeps its own). */
export function opsFor(kind: FeeKind, current?: string | null): FeeOp[] {
    const base = OPS_BY_KIND[kind] || OPS_BY_KIND.text;
    return current && !base.includes(current as FeeOp) && current !== 'any' && kind !== 'always' ? [...base, current as FeeOp] : base;
}
export const needsValue = (op: string) => !['any', 'filled', 'empty'].includes(op);
export const isListOp = (op: string) => op === 'in' || op === 'not_in';

const parseList = (v: unknown): string[] | null => {
    if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim());
    try { const a = JSON.parse(String(v ?? '')); return Array.isArray(a) ? a.map((x) => String(x ?? '').trim()) : null; } catch { return null; }
};

/**
 * A stored rule as the builder edits it: `list` for in / not_in, `range` [from, to] for between, `value` for the
 * rest. An older rule on a list field written as «es igual a X» / «no es igual a X» opens as «es uno de [X]» /
 * «no es ninguno de [X]» — the same people, now with the picker.
 */
export function toDraft(rule: { field_name?: string | null; operator?: string | null; value?: unknown }, fields: readonly FieldLike[]) {
    const field = rule.field_name || '';
    const kind = kindOf(field, fields);
    let op = (rule.operator || (field ? OPS_BY_KIND[kind][0] : 'any')) as FeeOp;
    let list: string[] = [], range: [string, string] = ['', ''], value = rule.value == null ? '' : String(rule.value);
    if ((kind === 'enum' || kind === 'person') && (op === 'eq' || op === 'neq') && value.trim()) { list = [value.trim()]; op = op === 'eq' ? 'in' : 'not_in'; value = ''; }
    else if (isListOp(op)) { list = parseList(rule.value) || (value ? [value] : []); value = ''; }
    else if (op === 'between') { const p = parseList(rule.value) || ['', '']; range = [p[0] || '', p[1] || '']; value = ''; }
    if (kind === 'switch' && !value) value = 'Sí';
    return { field, kind, op, list, range, value };
}
export type FeeDraft = ReturnType<typeof toDraft>;

/** The draft for a new field: its kind's first condition, an empty value (a switch starts on «Sí»). */
export function draftForField(field: string, fields: readonly FieldLike[]): FeeDraft {
    const kind = kindOf(field, fields);
    return { field, kind, op: OPS_BY_KIND[kind][0], list: [], range: ['', ''], value: kind === 'switch' ? 'Sí' : '' };
}

/** What POST /fee-rules gets for the condition: { field_name, operator, value } (a list or a pair as an array). */
export function fromDraft(d: FeeDraft): { field_name: string; operator: FeeOp; value: string | string[] } {
    if (!d.field || d.kind === 'always') return { field_name: '', operator: 'any', value: '' };
    if (isListOp(d.op)) return { field_name: d.field, operator: d.op, value: d.list };
    if (d.op === 'between') return { field_name: d.field, operator: d.op, value: [d.range[0], d.range[1]] };
    return { field_name: d.field, operator: d.op, value: needsValue(d.op) ? d.value : '' };
}

/** Is the condition complete enough to preview or save? (The server still checks it.) */
export function draftReady(d: FeeDraft): boolean {
    if (!d.field || !needsValue(d.op)) return true;
    if (isListOp(d.op)) return d.list.length > 0;
    if (d.op === 'between') return !!(d.range[0] || d.range[1]);
    return String(d.value).trim() !== '';
}

/** Add or remove one value of a list (no duplicates, the order of picking kept). */
export const toggleIn = (list: readonly string[], v: string, on: boolean): string[] => {
    const s = String(v).trim();
    const rest = list.filter((x) => x !== s);
    return on && s ? [...rest, s] : rest;
};

/** People that match a search: name, document or locality, accents and case aside; optionally one locality. */
const fold = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function searchPeople<T extends { name: string; document?: string; location?: string }>(people: readonly T[], q: string, location = ''): T[] {
    const words = fold(q).split(/\s+/).filter(Boolean);
    return people.filter((p) => (!location || p.location === location) && words.every((w) => fold(`${p.name} ${p.document || ''} ${p.location || ''}`).includes(w)));
}

/** The words of a condition for the rules list («Localidad es una de: Norte, Sur»). */
export function describeCondition(rule: { field_name?: string | null; operator?: string | null; value?: unknown }, labelOf: (name: string) => string,
    tx: (k: string, f: string, v?: Record<string, any>) => string, nameOfPerson?: (id: string) => string): string {
    const field = rule.field_name || '';
    const op = rule.operator || 'any';
    if (!field || op === 'any') return tx('fee.cond.always', 'Siempre');
    const who = field === FEE_PERSON ? tx('fee.field.person', 'Personas') : labelOf(field);
    const list = parseList(rule.value) || [];
    const shown = (vals: string[]) => {
        const named = field === FEE_PERSON && nameOfPerson ? vals.map(nameOfPerson) : vals;
        return named.length > 4 ? `${named.slice(0, 4).join(', ')} ${tx('fee.cond.more', 'y {n} más', { n: named.length - 4 })}` : named.join(', ');
    };
    if (field === FEE_PERSON && (op === 'in' || op === 'not_in')) return op === 'in' ? tx('fee.cond.person.in', 'Para: {values}', { values: shown(list) }) : tx('fee.cond.person.not_in', 'Todos menos: {values}', { values: shown(list) });
    switch (op) {
        case 'in': return tx('fee.cond.in', '{field} es: {values}', { field: who, values: shown(list) });
        case 'not_in': return tx('fee.cond.not_in', '{field} no es: {values}', { field: who, values: shown(list) });
        case 'between': {
            const [lo, hi] = [list[0] || '', list[1] || ''];
            if (lo && hi) return tx('fee.cond.between', '{field} entre {from} y {to}', { field: who, from: lo, to: hi });
            return lo ? tx('fee.cond.from', '{field} desde {from}', { field: who, from: lo }) : tx('fee.cond.to', '{field} hasta {to}', { field: who, to: hi });
        }
        default: return tx(`fee.cond.${op}`, `{field} ${op} {value}`, { field: who, value: String(rule.value ?? '') });
    }
}
