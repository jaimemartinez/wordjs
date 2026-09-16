/**
 * The coordinator portal's lodging helpers. What is pinned here is the CONTRACT with conference-manager:
 * `require_companion` predicates are stored as ARRAYS (`params.subject = [pred]`) even though the portal
 * edits a single predicate, numbers travel as integers and blanks are omitted, the status is read like
 * the server's `COALESCE(lodging_status, 'draft')`, and a partial payload (older plugin, missing counts)
 * still yields honest numbers instead of NaN.
 */
import { describe, it, expect } from "vitest";
import {
    attendeeName,
    BASE_RULE_FIELDS,
    canEditLodging,
    deadlineMessage,
    deadlineState,
    fmtDeadline,
    emptyRuleForm,
    fieldLabelOf,
    fmtTimestamp,
    formToRuleParams,
    freeBeds,
    isLodgingFrozen,
    lodgingSummary,
    normalizeLodgingStatus,
    parseRuleParams,
    portalErrorMessage,
    roomLabel,
    roomsWithSpace,
    ruleFieldOptions,
    ruleFormToBody,
    ruleParamsToForm,
    ruleSummary,
    ruleToForm,
    ruleTypeLabel,
    SESSION_EXPIRED_MSG,
    statusLabel,
    unassignedHint,
    unassignedLabel,
    type LodgingData,
    type LodgingRoom,
    type LodgingRule,
} from "../lodging";

const room = (partial: Partial<LodgingRoom> & { id: number }): LodgingRoom => ({ hotel_name: 'Hotel Sol', room_number: String(partial.id), capacity: 4, occupied: 0, occupants: [], ...partial });

describe("freeBeds / roomsWithSpace", () => {
    it("is capacity minus the server's occupied count", () => {
        expect(freeBeds(room({ id: 1, capacity: 4, occupied: 1 }))).toBe(3);
        expect(freeBeds(room({ id: 1, capacity: 4, occupied: 4 }))).toBe(0);
    });

    it("never goes negative (a room over capacity reports 0 free beds)", () => {
        expect(freeBeds(room({ id: 1, capacity: 2, occupied: 5 }))).toBe(0);
    });

    it("falls back to the listed occupants when `occupied` is missing, and to 0 when everything is", () => {
        expect(freeBeds({ id: 1, capacity: 3, occupants: [{ id: 9 }] })).toBe(2);
        expect(freeBeds({ id: 1, capacity: 3 })).toBe(3);
        expect(freeBeds({ id: 1 })).toBe(0);
        expect(freeBeds(null)).toBe(0);
    });

    it("reads garbage counts as 0 / missing (never NaN)", () => {
        expect(freeBeds({ id: 1, capacity: 'x' as unknown as number, occupied: 1 })).toBe(0);
        expect(freeBeds({ id: 1, capacity: 2, occupied: -3 })).toBe(2);
        expect(freeBeds({ id: 1, capacity: 2.9, occupied: 0.4 })).toBe(2);
    });

    it("roomsWithSpace keeps only rooms with a free bed, in order, and survives a missing list", () => {
        const rooms = [room({ id: 1, occupied: 4 }), room({ id: 2, occupied: 3 }), room({ id: 3, occupied: 0 })];
        expect(roomsWithSpace(rooms).map((r) => r.id)).toEqual([2, 3]);
        expect(roomsWithSpace(undefined)).toEqual([]);
        expect(roomsWithSpace(null)).toEqual([]);
    });
});

describe("lodgingSummary", () => {
    const data: LodgingData = {
        status: 'draft',
        rooms: [room({ id: 1, capacity: 4, occupied: 2, occupants: [{ id: 1 }, { id: 2 }] }), room({ id: 2, capacity: 2, occupied: 2, occupants: [{ id: 3 }, { id: 4 }] })],
        unassigned: [{ id: 5 }],
        placed_elsewhere: [{ id: 6 }],
        violations: [{ rule: 'a', detail: 'x', hard: true }, { rule: 'b', detail: 'y', hard: false }],
        counts: { placed: 4, unassigned: 1, hard_violations: 1, soft_violations: 1, placed_elsewhere: 1 },
    };

    it("sums rooms, beds and free beds from the rooms and takes the audit counts from `counts`", () => {
        expect(lodgingSummary(data)).toEqual({ rooms: 2, beds: 6, free: 2, placed: 4, unplaced: 1, placedElsewhere: 1, hardViolations: 1, softViolations: 1 });
    });

    it("falls back to counting the collections when `counts` is missing (older plugin)", () => {
        expect(lodgingSummary({ ...data, counts: undefined })).toEqual({ rooms: 2, beds: 6, free: 2, placed: 4, unplaced: 1, placedElsewhere: 1, hardViolations: 1, softViolations: 1 });
    });

    it("is all zeros for an empty or missing payload", () => {
        const zero = { rooms: 0, beds: 0, free: 0, placed: 0, unplaced: 0, placedElsewhere: 0, hardViolations: 0, softViolations: 0 };
        expect(lodgingSummary({})).toEqual(zero);
        expect(lodgingSummary(null)).toEqual(zero);
        expect(lodgingSummary({ rooms: [], counts: { placed: null, unassigned: 'nope' as unknown as number } })).toEqual(zero);
    });
});

describe("status", () => {
    it("normalises like the server's COALESCE: null/unknown → draft, the frozen states pass through", () => {
        expect(normalizeLodgingStatus(null)).toBe('draft');
        expect(normalizeLodgingStatus(undefined)).toBe('draft');
        expect(normalizeLodgingStatus('')).toBe('draft');
        expect(normalizeLodgingStatus('weird')).toBe('draft');
        expect(normalizeLodgingStatus('submitted')).toBe('submitted');
        expect(normalizeLodgingStatus(' Validated ')).toBe('validated');
    });

    it("canEditLodging is true only for a draft; isLodgingFrozen is its complement", () => {
        expect(canEditLodging('draft')).toBe(true);
        expect(canEditLodging(null)).toBe(true);
        expect(canEditLodging('submitted')).toBe(false);
        expect(canEditLodging('validated')).toBe(false);
        expect(isLodgingFrozen('submitted')).toBe(true);
        expect(isLodgingFrozen('draft')).toBe(false);
    });

    it("labels every status in Spanish", () => {
        expect(statusLabel('draft')).toBe('Borrador');
        expect(statusLabel('submitted')).toBe('Enviado — esperando validación');
        expect(statusLabel('validated')).toBe('Validado por el administrador');
        expect(statusLabel(undefined)).toBe('Borrador');
    });

    it("hints how to fix unassigned attendees only while frozen", () => {
        expect(unassignedHint('draft')).toBe('');
        expect(unassignedHint('submitted')).toMatch(/Retira el envío/);
        expect(unassignedHint('validated')).toMatch(/reabrir/);
        expect(unassignedLabel(1)).toBe('1 participante sin habitación');
        expect(unassignedLabel(3)).toBe('3 participantes sin habitación');
    });
});

describe("display helpers", () => {
    it("attendeeName joins the names and falls back to #id", () => {
        expect(attendeeName({ id: 1, first_name: ' Ana ', last_name: 'Pérez' })).toBe('Ana Pérez');
        expect(attendeeName({ id: 1, first_name: 'Ana', last_name: null })).toBe('Ana');
        expect(attendeeName({ id: 7 })).toBe('#7');
        expect(attendeeName(null)).toBe('#');
    });

    it("roomLabel joins hotel and number", () => {
        expect(roomLabel({ hotel_name: 'Hotel Sol', room_number: 101 })).toBe('Hotel Sol · 101');
        expect(roomLabel({ hotel_name: null, room_number: '12B' })).toBe('12B');
        expect(roomLabel({})).toBe('—');
    });
});

describe("rule fields", () => {
    it("lists the conference's fields first, then the base columns the form does not define", () => {
        const opts = ruleFieldOptions([{ name: 'edad', label: 'Edad' }, { name: 'gender', label: 'Sexo' }, { name: '', label: 'x' }]);
        expect(opts.slice(0, 2)).toEqual([{ name: 'edad', label: 'Edad' }, { name: 'gender', label: 'Sexo' }]);
        expect(opts.filter((o) => o.name === 'gender')).toHaveLength(1);
        expect(opts.map((o) => o.name)).toEqual(['edad', 'gender', ...BASE_RULE_FIELDS.filter((b) => b.name !== 'gender').map((b) => b.name)]);
    });

    it("works with no fields at all and resolves labels", () => {
        expect(ruleFieldOptions(undefined).map((o) => o.name)).toEqual(BASE_RULE_FIELDS.map((b) => b.name));
        expect(fieldLabelOf('family_group', [])).toBe('Grupo familiar');
        expect(fieldLabelOf('edad', [{ name: 'edad', label: 'Edad' }])).toBe('Edad');
        expect(fieldLabelOf('desconocido', [])).toBe('desconocido');
        expect(fieldLabelOf(null, [])).toBe('');
    });

    it("labels the four rule types in Spanish", () => {
        expect(ruleTypeLabel('keep_together')).toBe('Mantener juntos');
        expect(ruleTypeLabel('separate_by')).toBe('Separar por');
        expect(ruleTypeLabel('split_by')).toBe('Al dividir, agrupar por');
        expect(ruleTypeLabel('require_companion')).toBe('Requiere acompañante');
        expect(ruleTypeLabel('other')).toBe('other');
    });
});

describe("formToRuleParams", () => {
    it("keep_together writes min_size as an integer and omits a blank one", () => {
        expect(formToRuleParams({ type: 'keep_together', min_size: '3' })).toEqual({ min_size: 3 });
        expect(formToRuleParams({ type: 'keep_together', min_size: '' })).toEqual({});
        expect(formToRuleParams({ type: 'keep_together', min_size: '0' })).toEqual({});
        expect(formToRuleParams({ type: 'keep_together', min_size: 'abc' })).toEqual({});
        expect(formToRuleParams({ type: 'keep_together', min_size: '2.7' })).toEqual({ min_size: 2 });
    });

    it("separate_by / split_by carry no params at all (even if the form has leftovers)", () => {
        expect(formToRuleParams({ type: 'separate_by', min_size: '3', min: '2', subject: { field: 'edad', op: 'lt', value: '12' } })).toEqual({});
        expect(formToRuleParams({ type: 'split_by', min_size: '3' })).toEqual({});
    });

    it("require_companion serialises the single subject/needs predicates as ONE-ELEMENT ARRAYS plus min", () => {
        const params = formToRuleParams({
            type: 'require_companion',
            subject: { field: 'edad', op: 'lt', value: ' 12 ' },
            needs: { field: 'edad', op: 'gte', value: '18' },
            min: '1',
        });
        expect(params).toEqual({ subject: [{ field: 'edad', op: 'lt', value: '12' }], needs: [{ field: 'edad', op: 'gte', value: '18' }], min: 1 });
        expect(Array.isArray(params.subject)).toBe(true);
        expect(Array.isArray(params.needs)).toBe(true);
    });

    it("require_companion drops a predicate without a field, the value of a value-less op, and a blank min", () => {
        expect(formToRuleParams({ type: 'require_companion', subject: { field: '', op: 'eq', value: 'x' }, needs: { field: 'tipo', op: 'filled', value: 'ignored' }, min: '' }))
            .toEqual({ needs: [{ field: 'tipo', op: 'filled', value: '' }] });
        expect(formToRuleParams({ type: 'require_companion' })).toEqual({});
    });
});

describe("ruleParamsToForm", () => {
    it("reads the first predicate of each array and the numbers as input strings", () => {
        expect(ruleParamsToForm({ subject: [{ field: 'edad', op: 'lt', value: 12 }], needs: [{ field: 'edad', op: 'gte', value: '18' }], min: 2, min_size: 4 }))
            .toEqual({ min_size: '4', subject: { field: 'edad', op: 'lt', value: '12' }, needs: { field: 'edad', op: 'gte', value: '18' }, min: '2' });
    });

    it("accepts a legacy single predicate OBJECT (the server wraps it the same way) and defaults op to eq", () => {
        expect(ruleParamsToForm({ subject: { field: 'tipo', value: 'niño' } }).subject).toEqual({ field: 'tipo', op: 'eq', value: 'niño' });
    });

    it("yields empty inputs for missing/garbage params", () => {
        const empty = { min_size: '', subject: { field: '', op: 'eq', value: '' }, needs: { field: '', op: 'eq', value: '' }, min: '' };
        expect(ruleParamsToForm(undefined)).toEqual(empty);
        expect(ruleParamsToForm(null)).toEqual(empty);
        expect(ruleParamsToForm('nope')).toEqual(empty);
        expect(ruleParamsToForm([1, 2])).toEqual(empty);
        expect(ruleParamsToForm({ subject: [], needs: 'x', min: 0, min_size: -1 })).toEqual(empty);
    });

    it("round-trips: params → form → params is the identity for a stored require_companion rule", () => {
        const stored = { subject: [{ field: 'edad', op: 'lt', value: '12' }], needs: [{ field: 'edad', op: 'gte', value: '18' }], min: 1 };
        expect(formToRuleParams({ type: 'require_companion', ...ruleParamsToForm(stored) })).toEqual(stored);
        const kept = { min_size: 3 };
        expect(formToRuleParams({ type: 'keep_together', ...ruleParamsToForm(kept) })).toEqual(kept);
    });

    it("round-trips: form → params → form keeps the edited predicates", () => {
        const form = { ...emptyRuleForm('require_companion'), subject: { field: 'tipo', op: 'eq', value: 'niño' }, needs: { field: 'tipo', op: 'eq', value: 'adulto' }, min: '2' };
        const back = ruleParamsToForm(formToRuleParams(form));
        expect(back.subject).toEqual(form.subject);
        expect(back.needs).toEqual(form.needs);
        expect(back.min).toBe('2');
    });
});

describe("parseRuleParams / ruleToForm / ruleFormToBody", () => {
    const rule: LodgingRule = { id: 5, name: 'Familias', type: 'keep_together', config: 'family_group', params: { min_size: 2 }, hard: 1, priority: 10, enabled: 1 };

    it("parses params stored as an object or as a JSON string; garbage → {}", () => {
        expect(parseRuleParams({ min: 1 })).toEqual({ min: 1 });
        expect(parseRuleParams('{"min":1}')).toEqual({ min: 1 });
        expect(parseRuleParams('{bad')).toEqual({});
        expect(parseRuleParams('[1]')).toEqual({});
        expect(parseRuleParams(null)).toEqual({});
    });

    it("ruleToForm maps a stored rule to inputs (0/1 flags → booleans, priority → string)", () => {
        expect(ruleToForm(rule)).toEqual({ name: 'Familias', type: 'keep_together', config: 'family_group', hard: true, enabled: true, priority: '10', min_size: '2', subject: { field: '', op: 'eq', value: '' }, needs: { field: '', op: 'eq', value: '' }, min: '' });
        expect(ruleToForm({ id: 1, name: 'x', type: 'bogus', params: '{"min_size":3}' as unknown as Record<string, unknown>, enabled: 0, hard: 0 })).toMatchObject({ type: 'keep_together', enabled: false, hard: false, priority: '0', min_size: '3' });
    });

    it("ruleFormToBody builds the POST body with 0/1 flags, an integer priority and the serialised params", () => {
        const res = ruleFormToBody(ruleToForm(rule), rule.id);
        expect(res).toEqual({ body: { id: 5, name: 'Familias', type: 'keep_together', config: 'family_group', hard: 1, enabled: 1, priority: 10, params: { min_size: 2 } } });
        const created = ruleFormToBody({ ...emptyRuleForm('separate_by'), name: ' Género ', config: 'gender', priority: '2.9' });
        expect(created).toEqual({ body: { name: 'Género', type: 'separate_by', config: 'gender', hard: 0, enabled: 1, priority: 2, params: {} } });
    });

    it("ruleFormToBody clamps priority to the server's range and reads a blank one as 0", () => {
        expect(ruleFormToBody({ ...emptyRuleForm('separate_by'), name: 'a', config: 'gender', priority: '99999999' })).toMatchObject({ body: { priority: 1000000 } });
        expect(ruleFormToBody({ ...emptyRuleForm('separate_by'), name: 'a', config: 'gender', priority: '' })).toMatchObject({ body: { priority: 0 } });
    });

    it("ruleFormToBody refuses a blank name, a field-based type without a field, and a companion rule without both predicates", () => {
        expect(ruleFormToBody({ ...emptyRuleForm('separate_by'), name: '  ', config: 'gender' })).toEqual({ error: 'Indica un nombre para la regla.' });
        expect(ruleFormToBody({ ...emptyRuleForm('keep_together'), name: 'x', config: '' })).toEqual({ error: 'Elige el campo de la regla.' });
        expect(ruleFormToBody({ ...emptyRuleForm('require_companion'), name: 'x' })).toEqual({ error: 'Indica la condición del participante y la del acompañante.' });
        const ok = ruleFormToBody({ ...emptyRuleForm('require_companion'), name: 'Niños', subject: { field: 'edad', op: 'lt', value: '12' }, needs: { field: 'edad', op: 'gte', value: '18' } });
        expect(ok).toEqual({ body: { name: 'Niños', type: 'require_companion', config: '', hard: 0, enabled: 1, priority: 0, params: { subject: [{ field: 'edad', op: 'lt', value: '12' }], needs: [{ field: 'edad', op: 'gte', value: '18' }] } } });
    });
});

describe("ruleSummary", () => {
    const fields = [{ name: 'edad', label: 'Edad' }];

    it("describes field-based rules with the field label, min size, strictness and priority", () => {
        expect(ruleSummary({ id: 1, name: 'F', type: 'keep_together', config: 'family_group', params: { min_size: 2 }, hard: 1, priority: 10, enabled: 1 }, fields))
            .toBe('Mantener juntos · Grupo familiar · mín. 2 · obligatoria · prioridad 10');
        expect(ruleSummary({ id: 2, name: 'G', type: 'separate_by', config: 'gender', hard: 0, priority: 0, enabled: 0 }, fields))
            .toBe('Separar por · Género · preferente · desactivada');
    });

    it("describes a companion rule with both predicates", () => {
        expect(ruleSummary({ id: 3, name: 'N', type: 'require_companion', params: { subject: [{ field: 'edad', op: 'lt', value: '12' }], needs: [{ field: 'edad', op: 'gte', value: '18' }], min: 1 }, hard: 1, priority: 0, enabled: 1 }, fields))
            .toBe('Requiere acompañante · si Edad < 12 → 1 con Edad ≥ 18 · obligatoria');
    });
});

describe("portalErrorMessage", () => {
    it("never shows the server's English 'No token' — a 401 is the session message", () => {
        expect(portalErrorMessage(401, { error: 'No token' }, 'x')).toBe(SESSION_EXPIRED_MSG);
    });

    it("uses the server's Spanish error when present, the fallback otherwise", () => {
        expect(portalErrorMessage(400, { error: 'La habitación está llena.' }, 'x')).toBe('La habitación está llena.');
        expect(portalErrorMessage(500, {}, 'No se pudo cargar el hospedaje.')).toBe('No se pudo cargar el hospedaje.');
        expect(portalErrorMessage(502, null, 'f')).toBe('f');
        expect(portalErrorMessage(400, { error: '   ' }, 'f')).toBe('f');
    });
});

describe("fmtTimestamp", () => {
    it("parses the SQL CURRENT_TIMESTAMP form as UTC (not local time)", () => {
        const shown = fmtTimestamp('2026-09-16 10:22:33', 'en-US');
        expect(shown).toBe(new Date('2026-09-16T10:22:33Z').toLocaleString('en-US'));
        expect(shown).not.toBe('2026-09-16 10:22:33');
    });

    it("accepts ISO strings and shows unparseable values verbatim; blank → ''", () => {
        expect(fmtTimestamp('2026-09-16T10:22:33.000Z', 'en-US')).toBe(new Date('2026-09-16T10:22:33.000Z').toLocaleString('en-US'));
        expect(fmtTimestamp('ayer')).toBe('ayer');
        expect(fmtTimestamp(null)).toBe('');
        expect(fmtTimestamp('')).toBe('');
    });
});

describe("lodging deadline — deadlineState / deadlineMessage / fmtDeadline (the /portal/lodging contract)", () => {
    it("has no deadline when the payload carries none (older plugin, null, '')", () => {
        expect(deadlineState(null)).toBe('none');
        expect(deadlineState({})).toBe('none');
        expect(deadlineState({ deadline: null, deadline_passed: true })).toBe('none');
        expect(deadlineState({ deadline: '', deadline_passed: true })).toBe('none');
        expect(deadlineMessage({})).toBeNull();
    });
    it("trusts the server's deadline_passed flag rather than the client clock", () => {
        expect(deadlineState({ deadline: '2000-01-01', deadline_passed: false })).toBe('open');
        expect(deadlineState({ deadline: '2999-01-01', deadline_passed: true })).toBe('passed');
        expect(deadlineState({ deadline: '2026-10-01' })).toBe('open');
    });
    it("formats a bare date as DD/MM/YYYY and keeps the clock of a datetime", () => {
        expect(fmtDeadline('2026-10-01')).toBe('01/10/2026');
        expect(fmtDeadline('2026-10-01T18:30:00.000Z')).toBe('01/10/2026 18:30');
        expect(fmtDeadline('2026-10-01 18:30:00')).toBe('01/10/2026 18:30');
        expect(fmtDeadline('garbage')).toBe('garbage');
        expect(fmtDeadline(null)).toBe('');
    });
    it("phrases the banner for open and passed deadlines", () => {
        expect(deadlineMessage({ deadline: '2026-10-01', deadline_passed: false })).toBe('Puedes acomodar y enviar los hospedajes hasta el 01/10/2026 (inclusive).');
        expect(deadlineMessage({ deadline: '2026-10-01', deadline_passed: true })).toBe('El plazo para acomodar los hospedajes venció el 01/10/2026. Solo el administrador puede modificarlos.');
    });
});
