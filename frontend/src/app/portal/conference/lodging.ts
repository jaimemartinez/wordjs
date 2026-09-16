/**
 * Pure helpers for the coordinator portal's Hospedajes (lodging) tab — no React, no fetch.
 *
 * THE CONTRACT WITH THE PLUGIN (conference-manager ≥ 2.5.0). `GET /portal/lodging` carries everything the
 * tab shows in ONE payload (rooms allotted to the coordinator's location with their occupants, the
 * unassigned attendees, the admin's rules, the location's own rules, the form fields, the audit) so the
 * UI never fans out — the portal's login throttle counts in-flight verifications per location, so the
 * tab must never hold more than two portal requests at once. Rules are stored with `params` as JSON:
 * `keep_together` reads `params.min_size`, `require_companion` reads `params.subject[]`, `params.needs[]`
 * (ARRAYS of `{ field, op, value }` predicates, AND-ed) and `params.min`. The portal edits ONE subject
 * predicate and ONE needs predicate, so `formToRuleParams` serialises them as one-element arrays and
 * `ruleParamsToForm` reads the first element back (a legacy single predicate OBJECT is accepted too —
 * the server wraps it the same way). Numbers travel as integers; a blank number is omitted (the server
 * defaults `min`/`min_size` to 1).
 */

export type LodgingStatus = 'draft' | 'submitted' | 'validated';

export const RULE_TYPE_VALUES = ['keep_together', 'separate_by', 'split_by', 'require_companion'] as const;
export type RuleType = typeof RULE_TYPE_VALUES[number];

/** A rule predicate as the engine reads it (`attrMatches`): `op` defaults to `eq` server-side. */
export type RulePredicate = { field: string; op: string; value: string };

export type LodgingAttendee = {
    id: number;
    first_name?: string | null;
    last_name?: string | null;
    gender?: string | null;
    family_group?: string | null;
    /** The conference's dynamic field columns travel flat on the row (same projection as /portal/inscriptions). */
    [column: string]: unknown;
};

export type LodgingRoom = {
    id: number;
    hotel_name?: string | null;
    room_number?: string | number | null;
    capacity?: number | null;
    is_family?: number | null;
    family_name?: string | null;
    /** Beds taken as counted by the server (status-agnostic; a foreign stray counts but is never listed). */
    occupied?: number | null;
    occupants?: LodgingAttendee[];
};

export type PlacedElsewhere = {
    id: number;
    first_name?: string | null;
    last_name?: string | null;
    hotel_name?: string | null;
    room_number?: string | number | null;
};

export type LodgingRule = {
    id: number;
    name: string;
    type: RuleType | string;
    config?: string | null;
    params?: Record<string, unknown> | null;
    hard?: number | boolean | null;
    priority?: number | null;
    enabled?: number | boolean | null;
};

export type LodgingViolation = { rule: string; detail: string; hard: boolean };

export type LodgingCounts = {
    placed?: number | null;
    unassigned?: number | null;
    hard_violations?: number | null;
    soft_violations?: number | null;
    placed_elsewhere?: number | null;
};

export type LodgingField = { name: string; label: string; type?: string };

/** The payload of `GET /portal/lodging`. Every collection is optional so an older plugin never crashes the tab. */
export type LodgingData = {
    status?: string | null;
    note?: string | null;
    submitted_at?: string | null;
    reviewed_at?: string | null;
    can_edit?: boolean | null;
    rooms?: LodgingRoom[];
    unassigned?: LodgingAttendee[];
    placed_elsewhere?: PlacedElsewhere[];
    rules?: { conference?: LodgingRule[]; location?: LodgingRule[] } | null;
    fields?: LodgingField[];
    violations?: LodgingViolation[];
    counts?: LodgingCounts | null;
};

/** The engine's result for `POST /portal/lodging/run`. */
export type AssignmentRunResult = { assignedCount?: number; remaining?: number; violations?: unknown[] };

// ---------------------------------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------------------------------

/** A non-negative integer from whatever the server sent; garbage/missing → `fallback`. */
const count = (v: unknown, fallback = 0): number => {
    if (v == null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

/**
 * Beds still free in a room: `capacity − occupied`, never negative. A missing `occupied` falls back to
 * the listed occupants (a foreign stray would then be invisible — the server always sends the count).
 */
export const freeBeds = (room: LodgingRoom | null | undefined): number => {
    if (!room) return 0;
    const cap = count(room.capacity);
    const occ = count(room.occupied, Array.isArray(room.occupants) ? room.occupants.length : 0);
    return Math.max(0, cap - occ);
};

/** The rooms an attendee can still be placed into (at least one free bed), in the server's order. */
export const roomsWithSpace = (rooms: LodgingRoom[] | null | undefined): LodgingRoom[] =>
    (Array.isArray(rooms) ? rooms : []).filter((r) => freeBeds(r) > 0);

export type LodgingSummary = {
    rooms: number;
    beds: number;
    free: number;
    placed: number;
    unplaced: number;
    placedElsewhere: number;
    hardViolations: number;
    softViolations: number;
};

/**
 * The numbers on top of the tab. `counts` (the server's audit) wins when present; otherwise the
 * collections are counted client-side so a partial payload still renders something honest.
 */
export const lodgingSummary = (data: LodgingData | null | undefined): LodgingSummary => {
    const rooms = Array.isArray(data?.rooms) ? data.rooms : [];
    const counts = data?.counts || {};
    const listedOccupants = rooms.reduce((n, r) => n + (Array.isArray(r.occupants) ? r.occupants.length : 0), 0);
    return {
        rooms: rooms.length,
        beds: rooms.reduce((n, r) => n + count(r.capacity), 0),
        free: rooms.reduce((n, r) => n + freeBeds(r), 0),
        placed: count(counts.placed, listedOccupants),
        unplaced: count(counts.unassigned, Array.isArray(data?.unassigned) ? data.unassigned.length : 0),
        placedElsewhere: count(counts.placed_elsewhere, Array.isArray(data?.placed_elsewhere) ? data.placed_elsewhere.length : 0),
        hardViolations: count(counts.hard_violations, (data?.violations || []).filter((v) => v && v.hard).length),
        softViolations: count(counts.soft_violations, (data?.violations || []).filter((v) => v && !v.hard).length),
    };
};

// ---------------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------------

/** Mirrors the server's `COALESCE(lodging_status, 'draft')`: anything but the two frozen states is a draft. */
export const normalizeLodgingStatus = (status: unknown): LodgingStatus => {
    const s = String(status == null ? '' : status).trim().toLowerCase();
    return s === 'submitted' || s === 'validated' ? s : 'draft';
};

/** The coordinator may touch the arrangement only while it is a draft (submitted/validated are frozen). */
export const canEditLodging = (status: unknown): boolean => normalizeLodgingStatus(status) === 'draft';

/** True while the arrangement sits with the admin (submitted or validated). */
export const isLodgingFrozen = (status: unknown): boolean => !canEditLodging(status);

const STATUS_LABELS: Record<LodgingStatus, string> = {
    draft: 'Borrador',
    submitted: 'Enviado — esperando validación',
    validated: 'Validado por el administrador',
};

export const statusLabel = (status: unknown): string => STATUS_LABELS[normalizeLodgingStatus(status)];

/** The hint shown under "N participantes sin habitación" while the arrangement is frozen; '' for a draft. */
export const unassignedHint = (status: unknown): string => {
    const s = normalizeLodgingStatus(status);
    if (s === 'submitted') return 'Retira el envío para acomodarlos.';
    if (s === 'validated') return 'Pide al administrador reabrir el hospedaje para acomodarlos.';
    return '';
};

/** `3 participantes sin habitación` / `1 participante sin habitación`. */
export const unassignedLabel = (n: number): string =>
    `${count(n)} ${count(n) === 1 ? 'participante' : 'participantes'} sin habitación`;

/** The portal's message for a 401 (an expired/rotated token, or the login throttle's in-flight cap). */
export const SESSION_EXPIRED_MSG = 'Tu sesión del portal caducó; vuelve a entrar.';

/**
 * The Spanish message for a failed portal response: a 401 is never the server's English 'No token';
 * otherwise the server's `error` string, or `fallback`.
 */
export const portalErrorMessage = (status: number, body: unknown, fallback: string): string => {
    if (status === 401) return SESSION_EXPIRED_MSG;
    const err = body && typeof body === 'object' ? (body as { error?: unknown }).error : null;
    return typeof err === 'string' && err.trim() ? err : fallback;
};

/**
 * A server timestamp for display. The plugin stamps `CURRENT_TIMESTAMP`, which SQLite returns as
 * `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker — `new Date()` would read that as LOCAL time in
 * Chrome and as an invalid date in Safari — so the SQL form is parsed as UTC explicitly. ISO strings
 * (other drivers) parse as they are; anything unparseable is shown verbatim.
 */
export const fmtTimestamp = (v: unknown, locale = 'es'): string => {
    if (v == null || v === '') return '';
    const s = String(v).trim();
    const sql = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/.exec(s);
    const d = new Date(sql ? `${sql[1]}T${sql[2]}Z` : s);
    return isNaN(d.getTime()) ? s : d.toLocaleString(locale);
};

// ---------------------------------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------------------------------

/** `Nombre Apellido`, or `#id` when the projection carries neither. */
export const attendeeName = (a: { id?: number; first_name?: unknown; last_name?: unknown } | null | undefined): string => {
    const name = [a?.first_name, a?.last_name].map((v) => (v == null ? '' : String(v).trim())).filter(Boolean).join(' ');
    return name || `#${a?.id ?? ''}`;
};

/** `Hotel Sol · 101`, or just the room number when the hotel is unknown. */
export const roomLabel = (room: { hotel_name?: unknown; room_number?: unknown } | null | undefined): string => {
    const hotel = room?.hotel_name == null ? '' : String(room.hotel_name).trim();
    const num = room?.room_number == null ? '' : String(room.room_number).trim();
    return [hotel, num].filter(Boolean).join(' · ') || '—';
};

// ---------------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------------

export const RULE_TYPE_OPTIONS: ReadonlyArray<{ v: RuleType; label: string; desc: string }> = [
    { v: 'keep_together', label: 'Mantener juntos', desc: 'Los participantes con el mismo valor del campo van a la misma habitación (con tamaño mínimo).' },
    { v: 'separate_by', label: 'Separar por', desc: 'Una habitación admite un solo valor de este campo (p. ej. género).' },
    { v: 'split_by', label: 'Al dividir, agrupar por', desc: 'Cuando un grupo no cabe entero, se divide siguiendo este campo.' },
    { v: 'require_companion', label: 'Requiere acompañante', desc: 'Una habitación con alguien que cumple una condición exige N que cumplen otra (p. ej. un niño necesita un adulto).' },
];

export const isRuleType = (v: unknown): v is RuleType => (RULE_TYPE_VALUES as readonly string[]).includes(String(v));

export const ruleTypeLabel = (type: unknown): string =>
    RULE_TYPE_OPTIONS.find((o) => o.v === type)?.label || String(type ?? '');

/** Predicate operators the engine understands (`any` is the server's "no condition" and is not offered). */
export const PRED_OPS: ReadonlyArray<{ v: string; label: string }> = [
    { v: 'eq', label: '=' }, { v: 'neq', label: '≠' }, { v: 'gt', label: '>' }, { v: 'gte', label: '≥' },
    { v: 'lt', label: '<' }, { v: 'lte', label: '≤' }, { v: 'contains', label: 'contiene' },
    { v: 'filled', label: 'tiene valor' }, { v: 'empty', label: 'vacío' },
];

export const opNeedsNoValue = (op: string): boolean => op === 'filled' || op === 'empty' || op === 'any';

/** The attendee columns every rule may reference besides the conference's own fields (server: BASE_RULE_FIELDS). */
export const BASE_RULE_FIELDS: ReadonlyArray<LodgingField> = [
    { name: 'first_name', label: 'Nombre' },
    { name: 'last_name', label: 'Apellido' },
    { name: 'gender', label: 'Género' },
    { name: 'email', label: 'Correo' },
    { name: 'phone', label: 'Teléfono' },
    { name: 'document_number', label: 'Documento' },
    { name: 'family_group', label: 'Grupo familiar' },
    { name: 'location', label: 'Localidad' },
];

/** The conference's fields first, then the base columns the form does not already define. */
export const ruleFieldOptions = (fields: LodgingField[] | null | undefined): LodgingField[] => {
    const own = (Array.isArray(fields) ? fields : []).filter((f) => f && typeof f.name === 'string' && f.name.trim() !== '');
    const seen = new Set(own.map((f) => f.name));
    return [...own.map((f) => ({ name: f.name, label: f.label || f.name })), ...BASE_RULE_FIELDS.filter((b) => !seen.has(b.name))];
};

/** The label of a field name, for read-only rule summaries. */
export const fieldLabelOf = (name: unknown, fields: LodgingField[] | null | undefined): string => {
    const n = name == null ? '' : String(name);
    if (!n) return '';
    return ruleFieldOptions(fields).find((f) => f.name === n)?.label || n;
};

export type RuleForm = {
    name: string;
    type: RuleType;
    /** The field the rule groups/separates by ('' = none, only meaningful for require_companion). */
    config: string;
    hard: boolean;
    enabled: boolean;
    /** Kept as the input string; `ruleFormToBody` parses it (blank → 0). */
    priority: string;
    /** keep_together: minimum group size (input string; blank → omitted). */
    min_size: string;
    /** require_companion: the ONE subject predicate (who triggers the rule). */
    subject: RulePredicate;
    /** require_companion: the ONE needs predicate (who must accompany). */
    needs: RulePredicate;
    /** require_companion: how many `needs` matches a room with a subject requires (blank → omitted). */
    min: string;
};

export type RuleParamsForm = Pick<RuleForm, 'min_size' | 'subject' | 'needs' | 'min'>;

export const emptyPredicate = (): RulePredicate => ({ field: '', op: 'eq', value: '' });

export const emptyRuleForm = (type: RuleType = 'keep_together'): RuleForm => ({
    name: '',
    type,
    config: '',
    hard: false,
    enabled: true,
    priority: '0',
    min_size: '',
    subject: emptyPredicate(),
    needs: emptyPredicate(),
    min: '',
});

/** A positive integer from an input string, or null when blank/garbage/< 1 (the server then defaults to 1). */
const positiveInt = (v: unknown): number | null => {
    if (v == null || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
};

const normalizePredicate = (p: unknown): RulePredicate => {
    const src = (p && typeof p === 'object') ? p as Record<string, unknown> : {};
    const op = src.op == null || String(src.op).trim() === '' ? 'eq' : String(src.op).trim();
    return {
        field: src.field == null ? '' : String(src.field).trim(),
        op,
        value: opNeedsNoValue(op) || src.value == null ? '' : String(src.value).trim(),
    };
};

/** The first predicate of `params.subject`/`params.needs`: an array (the contract) or a legacy single object. */
const firstPredicate = (v: unknown): RulePredicate => {
    if (Array.isArray(v)) return v.length ? normalizePredicate(v[0]) : emptyPredicate();
    if (v && typeof v === 'object') return normalizePredicate(v);
    return emptyPredicate();
};

/** A predicate the server would accept: a field is required; a value-less op drops its value. */
const serializePredicate = (p: RulePredicate): RulePredicate | null => {
    const n = normalizePredicate(p);
    if (!n.field) return null;
    return opNeedsNoValue(n.op) ? { field: n.field, op: n.op, value: '' } : n;
};

/**
 * The stored `params` JSON for a rule form. Only the keys the rule's type reads are written (the server
 * caps `params` at 4 KB and validates every predicate): keep_together → `{ min_size }`; require_companion
 * → `{ subject: [pred], needs: [pred], min }` — ARRAYS even though the portal edits one predicate, because
 * that is what the engine's `cond()` iterates. A blank number or a predicate without a field is omitted.
 */
export const formToRuleParams = (form: Pick<RuleForm, 'type'> & Partial<RuleParamsForm>): Record<string, unknown> => {
    const params: Record<string, unknown> = {};
    if (form.type === 'keep_together') {
        const minSize = positiveInt(form.min_size);
        if (minSize != null) params.min_size = minSize;
    } else if (form.type === 'require_companion') {
        const subject = form.subject ? serializePredicate(form.subject) : null;
        const needs = form.needs ? serializePredicate(form.needs) : null;
        if (subject) params.subject = [subject];
        if (needs) params.needs = [needs];
        const min = positiveInt(form.min);
        if (min != null) params.min = min;
    }
    return params;
};

/** The editable form fields for a stored rule's `params` (inverse of `formToRuleParams`, tolerant of legacy shapes). */
export const ruleParamsToForm = (params: unknown): RuleParamsForm => {
    const src = (params && typeof params === 'object' && !Array.isArray(params)) ? params as Record<string, unknown> : {};
    const minSize = positiveInt(src.min_size);
    const min = positiveInt(src.min);
    return {
        min_size: minSize == null ? '' : String(minSize),
        subject: firstPredicate(src.subject),
        needs: firstPredicate(src.needs),
        min: min == null ? '' : String(min),
    };
};

/** `params` as the server stores them: an object, or a JSON string on older rows; anything else → `{}`. */
export const parseRuleParams = (raw: unknown): Record<string, unknown> => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed: unknown = JSON.parse(raw);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        } catch { return {}; }
    }
    return {};
};

/** The editor's state for an existing rule (edit) — every stored value mapped back to inputs. */
export const ruleToForm = (rule: LodgingRule): RuleForm => {
    const type: RuleType = isRuleType(rule.type) ? rule.type : 'keep_together';
    const priority = Number(rule.priority);
    return {
        name: rule.name == null ? '' : String(rule.name),
        type,
        config: rule.config == null ? '' : String(rule.config),
        hard: !!Number(rule.hard),
        enabled: rule.enabled == null ? true : !!Number(rule.enabled),
        priority: Number.isFinite(priority) ? String(Math.trunc(priority)) : '0',
        ...ruleParamsToForm(parseRuleParams(rule.params)),
    };
};

export type RuleBody = {
    id?: number;
    name: string;
    type: RuleType;
    config: string;
    hard: 0 | 1;
    enabled: 0 | 1;
    priority: number;
    params: Record<string, unknown>;
};

/**
 * The body for `POST /portal/lodging/rules` (`id` present = update). Returns a Spanish error instead
 * when the form cannot be sent: a blank name, or a field-based type without a field.
 */
export const ruleFormToBody = (form: RuleForm, id?: number | null): { body: RuleBody } | { error: string } => {
    const name = String(form.name ?? '').trim();
    if (!name) return { error: 'Indica un nombre para la regla.' };
    const config = String(form.config ?? '').trim();
    if (form.type !== 'require_companion' && !config) return { error: 'Elige el campo de la regla.' };
    const params = formToRuleParams(form);
    if (form.type === 'require_companion' && (!params.subject || !params.needs)) {
        return { error: 'Indica la condición del participante y la del acompañante.' };
    }
    const pr = Number(form.priority);
    const priority = Number.isFinite(pr) ? Math.max(-1000000, Math.min(1000000, Math.trunc(pr))) : 0;
    const body: RuleBody = {
        name,
        type: form.type,
        config,
        hard: form.hard ? 1 : 0,
        enabled: form.enabled ? 1 : 0,
        priority,
        params,
    };
    if (id != null) body.id = id;
    return { body };
};

const predicateText = (p: RulePredicate, fields: LodgingField[] | null | undefined): string => {
    const op = PRED_OPS.find((o) => o.v === p.op)?.label || p.op;
    const field = fieldLabelOf(p.field, fields) || '(cualquiera)';
    return opNeedsNoValue(p.op) ? `${field} ${op}` : `${field} ${op} ${p.value}`;
};

/** A one-line, read-only description of a stored rule, e.g. `Mantener juntos · Grupo familiar · mín. 2 · obligatoria` (the admin's vocabulary: obligatoria / preferente). */
export const ruleSummary = (rule: LodgingRule, fields: LodgingField[] | null | undefined): string => {
    const form = ruleToForm(rule);
    const parts: string[] = [ruleTypeLabel(form.type)];
    if (form.type === 'require_companion') {
        parts.push(`si ${predicateText(form.subject, fields)} → ${form.min || '1'} con ${predicateText(form.needs, fields)}`);
    } else {
        parts.push(fieldLabelOf(form.config, fields) || '(sin campo)');
        if (form.type === 'keep_together' && form.min_size) parts.push(`mín. ${form.min_size}`);
    }
    parts.push(form.hard ? 'obligatoria' : 'preferente');
    if (form.priority !== '0') parts.push(`prioridad ${form.priority}`);
    if (!form.enabled) parts.push('desactivada');
    return parts.join(' · ');
};
