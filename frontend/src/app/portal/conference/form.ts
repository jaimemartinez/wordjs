/**
 * Pure helpers for the coordinator portal's dynamic registration form (no React, no fetch).
 *
 * THE CONTRACT WITH THE PLUGIN. Every dynamic-field value travels to conference-manager as a STRING and
 * the SERVER canonicalises it (`"0030"` → `"30"`, `"30.0"` → `"30"`, rejects `"abc"` with a Spanish 400).
 * The portal used to seed number fields with `0` and coerce them with `Number()` before sending: a blank
 * required "Número de cédula" then submitted `0` (which passed the server's required check) and a JS
 * number was bound as a double into a TEXT column, so the same field read `"30"` from the admin form and
 * `"30.0"` from the portal — `is_unique` and `eq` fee rules stopped matching across surfaces. Hence:
 * never `Number()` here, and an empty number field is `''` (the server treats `''` as missing).
 */

export type PortalField = {
    name: string;
    label: string;
    type: string;
    options?: string | null;
    is_required?: number;
    width?: number;
    is_group?: number;
    role?: string;
};

/** The comma-separated `options` of a select field, trimmed and without blanks. */
export const fieldOptions = (f: PortalField): string[] =>
    String(f.options || '').split(',').map((o) => o.trim()).filter(Boolean);

/**
 * Seed values for a fresh form: number → `''` (NOT `0` — the server treats `''` as missing for a
 * required field, `0` is a real value), select → its first option, everything else `''`.
 */
export const initialFormValues = (fields: PortalField[]): Record<string, string> =>
    Object.fromEntries(fields.map((f) => [f.name, f.type === 'select' ? (fieldOptions(f)[0] || '') : '']));

/** Every input value travels as the raw string; the server canonicalises ("30.0" → "30"). Never `Number()`. */
export const inputToFormValue = (_f: PortalField, raw: string): string => raw;

/**
 * Body for `POST /portal/inscriptions` and the `fields` member of `POST /public/quote`. Trims each value
 * and keeps `''` (a blank required field must reach the server so ITS required check fires, not be
 * dropped client-side); a `null`/`undefined` value becomes `''`.
 */
export const formBody = (form: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v == null ? '' : String(v).trim()]));

/** Money for display: rounded to cents, always two decimals, es-CO separators (`100,20`). */
export const fmtMoney = (v: unknown): string =>
    (Math.round((Number(v) || 0) * 100) / 100).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
