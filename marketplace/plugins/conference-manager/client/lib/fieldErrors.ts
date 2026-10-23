/**
 * In-app form validation (conference-manager 2.31.1): every form of the plugin is `noValidate`, so the browser
 * never shows its own validation bubble («Completa este campo»), which ignores the app's language and theme.
 * On submit, the fields are checked with the browser's own constraint API (required, min / max, step, type)
 * and each invalid one gets its message UNDER the field, in the admin's language; the first one takes the
 * focus. This file is the pure part (no React): what a field's problem is, and its message.
 */
import { t } from './i18n';

/** The element types a form validates (what `form.elements` yields that has a ValidityState). */
export type Validatable = {
    willValidate?: boolean;
    validity?: ValidityState;
    checkValidity?: () => boolean;
    getAttribute: (name: string) => string | null;
    name?: string;
    id?: string;
    type?: string;
    focus?: () => void;
};

/** The key a field's error is stored under: its `data-field`, else its name, else its id ('' = none). */
export function fieldKeyOf(el: Pick<Validatable, 'getAttribute' | 'name' | 'id'>): string {
    return el.getAttribute('data-field') || el.name || el.id || '';
}

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/** The message for a field that failed the constraint check, in `lang` (es / en / pt). */
export function fieldMessage(el: Pick<Validatable, 'validity' | 'getAttribute' | 'type'>, lang = 'es'): string {
    const v = el.validity;
    const tr = (key: string, vars: Record<string, string | number> = {}) => fill(t(key, lang), vars);
    if (!v || v.valueMissing) return tr('form.error.required');
    if (v.badInput) return tr(el.type === 'number' ? 'form.error.number' : 'form.error.invalid');
    if (v.rangeUnderflow) return tr('form.error.min', { min: el.getAttribute('min') || '' });
    if (v.rangeOverflow) return tr('form.error.max', { max: el.getAttribute('max') || '' });
    if (v.typeMismatch) return tr(el.type === 'email' ? 'form.error.email' : 'form.error.invalid');
    if (v.tooShort) return tr('form.error.minLength', { n: el.getAttribute('minlength') || '' });
    return tr('form.error.invalid');
}

/**
 * Every invalid field of a form, in document order: [key, message, element]. Fields without a key still count
 * (the first one takes the focus) but have nowhere to show a message.
 */
export function invalidFields(elements: ArrayLike<Validatable>, lang = 'es'): { key: string; message: string; el: Validatable }[] {
    const out: { key: string; message: string; el: Validatable }[] = [];
    for (const el of Array.from(elements)) {
        if (!el || !el.willValidate || typeof el.checkValidity !== 'function' || el.checkValidity()) continue;
        out.push({ key: fieldKeyOf(el), message: fieldMessage(el, lang), el });
    }
    return out;
}
