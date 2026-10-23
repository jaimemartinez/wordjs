/**
 * The registration form's base fields (2.16.0) — pure helpers shared by «Campos», «Precios», «Asignación»
 * and the lodging explorer. No React, no fetch: unit-tested on its own.
 *
 * A new conference starts with NO field. «Añadir campo» offers the base fields below as TEMPLATES; the
 * server (POST /fields { template }) creates each one with the exact column name / type / options / role the
 * plugin's features look it up by, and refuses a second copy (409). Every field — templated or not — can be
 * edited and deleted while the form is unpublished, so each feature must cope with a base field that is not
 * there: these helpers say which ones are there, what a deletion would switch off, and which rules point at
 * a field the form no longer has.
 */

/** The slice of a form field these helpers read. */
export type FormFieldLike = {
    id?: number;
    name: string;
    label?: string | null;
    role?: string | null;
    type?: string | null;
    is_group?: number | boolean | null;
    is_unique?: number | boolean | null;
};

/**
 * May this field stand in for a person's NAME when the form has no Nombre / Apellido? Never a unique
 * identifier (an ID document), a contact (email, phone) or free text (notes): the meals screens show the
 * name to a kitchen role that may not read the roster. Every screen names people the same way. Mirror of
 * index.js isNameFallbackField.
 */
export function isNameFallbackField(f: Partial<FormFieldLike> | null | undefined): boolean {
    if (!f || !f.name || f.name === 'first_name' || f.name === 'last_name') return false;
    if (Number(f.is_unique)) return false;
    const role = String(f.role || '');
    if (role === 'email' || role === 'phone' || f.name === 'email' || f.name === 'phone') return false;
    return !['textarea', 'notes', 'email', 'tel'].includes(String(f.type || ''));
}

/** A template as the «Añadir campo» dialog lists it. `key` is what POST /fields { template } takes. */
export type FieldTemplate = {
    key: 'first_name' | 'last_name' | 'email' | 'phone' | 'gender' | 'family_group' | 'lodging' | 'age' | 'health';
    /** The column the field gets (= its `name`); the server fixes it, the dialog only shows it. */
    name: string;
    labelKey: string;
    fallback: string;
    icon: string;
    /** Translation key + Spanish fallback of the one-line «what it is for». */
    hintKey: string;
    hint: string;
};

/** The base fields, in the order the old default form had them (mirror of FIELD_TEMPLATES in index.js). */
export const FIELD_TEMPLATES: readonly FieldTemplate[] = [
    { key: 'first_name', name: 'first_name', labelKey: 'fields.template.first_name', fallback: 'Nombre', icon: 'fa-user', hintKey: 'fields.template.first_name.hint', hint: 'Forma el nombre que se muestra de cada inscrito.' },
    { key: 'last_name', name: 'last_name', labelKey: 'fields.template.last_name', fallback: 'Apellido', icon: 'fa-user', hintKey: 'fields.template.last_name.hint', hint: 'Forma el nombre que se muestra de cada inscrito.' },
    { key: 'email', name: 'email', labelKey: 'fields.template.email', fallback: 'Email', icon: 'fa-envelope', hintKey: 'fields.template.email.hint', hint: 'Correo de contacto.' },
    { key: 'phone', name: 'phone', labelKey: 'fields.template.phone', fallback: 'Teléfono', icon: 'fa-phone', hintKey: 'fields.template.phone.hint', hint: 'Teléfono de contacto.' },
    { key: 'gender', name: 'gender', labelKey: 'fields.template.gender', fallback: 'Género', icon: 'fa-venus-mars', hintKey: 'fields.template.gender.hint', hint: 'Avisos de género al asignar habitaciones y el gráfico por género.' },
    { key: 'family_group', name: 'family_group', labelKey: 'fields.template.family_group', fallback: 'Grupo familiar', icon: 'fa-people-group', hintKey: 'fields.template.family_group.hint', hint: 'Agrupa a las familias en el portal de los encargados.' },
    { key: 'lodging', name: 'needs_lodging', labelKey: 'fields.template.lodging', fallback: 'Requiere hospedaje', icon: 'fa-bed', hintKey: 'fields.template.lodging.hint', hint: 'Interruptor Sí / No. Quien marque «No» no entra en la asignación automática ni se le puede asignar habitación a mano.' },
    // 2.32.0 — the meal groups read both («Turnos de comida»).
    { key: 'age', name: 'age', labelKey: 'fields.template.age', fallback: 'Edad', icon: 'fa-cake-candles', hintKey: 'fields.template.age.hint', hint: 'Edad en años (0 a 120). Los turnos de comida dan prioridad a niños pequeños y adultos mayores.' },
    { key: 'health', name: 'health_conditions', labelKey: 'fields.template.health', fallback: 'Condiciones de salud', icon: 'fa-notes-medical', hintKey: 'fields.template.health.hint', hint: 'Selección múltiple con «Otros». Datos sensibles: solo los ve quien tiene el permiso «Datos de salud». Da prioridad en los turnos de comida.' },
];

/** The «Requiere hospedaje» switch's column (2.31.0; mirror of index.js LODGING_FIELD). */
export const LODGING_FIELD = 'needs_lodging';
/** A Sí / No switch field's two stored values (mirror of index.js SWITCH_ON / SWITCH_OFF). */
export const SWITCH_ON = 'Sí';
export const SWITCH_OFF = 'No';
/** Is a switch value «Sí»? Blank (never answered, or a form without the field) reads as «Sí». */
export const isSwitchOn = (v: unknown): boolean => String(v ?? '').trim().toLowerCase() !== 'no';

const ROLE_OF: Record<string, string> = { first_name: 'first_name', last_name: 'last_name', email: 'email', phone: 'phone', gender: 'gender', lodging: 'lodging', age: 'age', health: 'health' };

/** The form field a template corresponds to (same column, or a field carrying the template's role), if any. */
export function templateField(fields: readonly FormFieldLike[] | null | undefined, tpl: Pick<FieldTemplate, 'key' | 'name'>): FormFieldLike | undefined {
    const role = ROLE_OF[tpl.key] || '';
    return (fields || []).find(f => f.name === tpl.name || (!!role && f.role === role));
}

/** Each template with the field that already covers it (the dialog greys those out: the server would answer 409). */
export function templateStates(fields: readonly FormFieldLike[] | null | undefined): { template: FieldTemplate; existing: FormFieldLike | undefined }[] {
    return FIELD_TEMPLATES.map(template => ({ template, existing: templateField(fields, template) }));
}

/**
 * How a template card looks. Its description was gray-400 (2.6:1) and a template already in the form was
 * the whole card at opacity 50 % — its «Ya está en el formulario como «…»» line, the one place that says
 * WHERE, at ~1.6:1. Now the description is gray-600 on either card (≥ 7:1) and no card is ever faded: a
 * template already in the form is a grey card with a check mark, and while another template is being
 * added the open cards only stop reacting (no hover, `cursor-not-allowed`). The dialog's other small text
 * is gray-500 on white (4.8:1) or gray-600.
 */
export const TEMPLATE_OPEN_CLASS = 'bg-gray-50/30 hover:border-blue-300 hover:bg-blue-50/40 disabled:hover:border-gray-100 disabled:hover:bg-gray-50/30';
export const TEMPLATE_DONE_CLASS = 'bg-gray-50';
export const TEMPLATE_DESC_CLASS = 'text-gray-600';

/**
 * Why «Publicar» is refused, or null when it may go ahead: an unpublished form without a single field.
 * Unpublishing is never refused. «Campos» shows the refusal next to the button, not as a toast — a toast
 * stayed over the «Nuevo campo» dialog opened to fix it.
 */
export function publishRefusal(fieldsCount: number, isPublished: boolean): 'empty' | null {
    return !isPublished && !(Number(fieldsCount) > 0) ? 'empty' : null;
}

/**
 * `list` with the item at `from` moved to `to` (a new array), or `list` itself when the move is out of
 * range or a no-op. The ↑ / ↓ buttons of «Campos» use it: drag and drop needs a mouse, a phone has none.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
    const arr = list as T[];
    if (!Array.isArray(list) || from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return arr;
    const next = list.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
}

/** Does the form collect gender (column `gender`)? Without it there are no gender hints, dots or filters. */
export const hasGenderField = (fields: readonly FormFieldLike[] | null | undefined): boolean =>
    (fields || []).some(f => f.name === 'gender');

/** Base columns an assignment rule may name without them being form fields (index.js BASE_RULE_FIELDS ∖ form). */
const ALWAYS_THERE = new Set(['location']);

/** A rule field the form no longer has: the rule reads an always-empty value, so it no longer does anything. */
export function isMissingField(fieldName: string | null | undefined, fields: readonly FormFieldLike[] | null | undefined): boolean {
    const n = String(fieldName ?? '').trim();
    if (!n || ALWAYS_THERE.has(n)) return false;
    return !(fields || []).some(f => f.name === n);
}

export type FeeRuleLike = { id?: number; label?: string | null; field_name?: string | null; operator?: string | null };
/** A price rule conditioned on a deleted field: the server skips it (it never applies) — the page says so. */
export const isOrphanFeeRule = (rule: FeeRuleLike, fields: readonly FormFieldLike[] | null | undefined): boolean =>
    !!rule && !!rule.field_name && rule.operator !== 'any' && isMissingField(rule.field_name, fields);

type Pred = { field?: string | null };
/** An assignment rule; `location_name` set = a location's own rule (the coordinators', GET /assignment/rules?all=1). */
export type AssignmentRuleLike = { id?: number; name?: string | null; config?: string | null; params?: Record<string, unknown> | string | null; location_name?: string | null };

/** Every field name an assignment rule reads: its main field plus the fields of its conditions. */
export function assignmentRuleFields(rule: AssignmentRuleLike): string[] {
    const out = new Set<string>();
    if (rule && rule.config) out.add(String(rule.config));
    let params: unknown = rule ? rule.params : null;
    if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = null; } }
    if (params && typeof params === 'object') {
        for (const k of ['when', 'subject', 'needs']) {
            const list = (params as Record<string, unknown>)[k];
            if (Array.isArray(list)) for (const p of list as Pred[]) if (p && p.field) out.add(String(p.field));
        }
    }
    return [...out];
}

/** The fields an assignment rule reads that the form no longer has. */
export const missingRuleFields = (rule: AssignmentRuleLike, fields: readonly FormFieldLike[] | null | undefined): string[] =>
    assignmentRuleFields(rule).filter(n => isMissingField(n, fields));

/** One line of «what stops working if you delete this field»: a translation key, its Spanish fallback, vars. */
export type FieldDependent = { key: string; fallback: string; vars?: Record<string, string | number> };

/**
 * What deleting `field` switches off — named in the delete confirmation. Empty = nothing else depends on it
 * (the confirmation is then the plain one). `feeRules` / `assignmentRules` are the conference's rules (any
 * list the caller could load; an unreadable one is simply not mentioned).
 */
export function fieldDependents(
    field: FormFieldLike,
    ctx: { feeRules?: readonly FeeRuleLike[] | null; assignmentRules?: readonly AssignmentRuleLike[] | null } = {},
): FieldDependent[] {
    const out: FieldDependent[] = [];
    if (!field) return out;
    const role = String(field.role || '');
    if (role === 'first_name' || role === 'last_name' || field.name === 'first_name' || field.name === 'last_name') {
        out.push({ key: 'fields.dep.name', fallback: 'El nombre de cada inscrito en las listas, el hospedaje, las comidas y el escáner (se mostrarán otros datos del formulario o su número).' });
    }
    if (field.name === 'gender') {
        out.push({ key: 'fields.dep.gender', fallback: 'Los avisos de género al asignar habitaciones y el gráfico por género.' });
    }
    if (field.name === LODGING_FIELD) {
        out.push({ key: 'fields.dep.lodging', fallback: 'Quienes marcaron «No requiere hospedaje» volverán a necesitar habitación (sus respuestas se borran).' });
    }
    if (field.name === 'health_conditions' || field.type === 'health') {
        out.push({ key: 'fields.dep.health', fallback: 'Todas las respuestas de salud se borran, y los turnos de comida dejan de tenerlas en cuenta.' });
    }
    if (field.role === 'age' || field.name === 'age') {
        out.push({ key: 'fields.dep.age', fallback: 'Los turnos de comida dejan de tener en cuenta la edad.' });
    }
    if (Number(field.is_group)) {
        out.push({ key: 'fields.dep.group', fallback: 'Los grupos (familias) que ven y eligen los encargados en su portal.' });
    }
    if (Number(field.is_unique)) {
        out.push({ key: 'fields.dep.unique', fallback: 'El control de duplicados de este dato.' });
    }
    const fee = (ctx.feeRules || []).filter(r => r && r.field_name === field.name && r.operator !== 'any');
    if (fee.length) {
        out.push({
            key: fee.length === 1 ? 'fields.dep.fee.one' : 'fields.dep.fee',
            fallback: fee.length === 1 ? '{n} regla de precio dejará de aplicarse: {names}.' : '{n} reglas de precio dejarán de aplicarse: {names}.',
            vars: { n: fee.length, names: fee.map(r => r.label || `#${r.id ?? ''}`).join(', ') },
        });
    }
    const rules = (ctx.assignmentRules || []).filter(r => r && assignmentRuleFields(r).includes(field.name));
    if (rules.length) {
        out.push({
            key: rules.length === 1 ? 'fields.dep.rules.one' : 'fields.dep.rules',
            fallback: rules.length === 1 ? '{n} regla de asignación de habitaciones dejará de tener efecto: {names}.' : '{n} reglas de asignación de habitaciones dejarán de tener efecto: {names}.',
            // A location's own rule (the coordinators') is named with its location.
            vars: { n: rules.length, names: rules.map(r => `${r.name || `#${r.id ?? ''}`}${r.location_name ? ` (${r.location_name})` : ''}`).join(', ') },
        });
    }
    return out;
}
