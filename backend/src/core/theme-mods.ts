/**
 * WordJS — Theme customizer mods contract (the WRITE authority for active_theme_mods).
 *
 * The customizer stores its live token overrides in the `active_theme_mods` option as a JSON object of
 * `--wjs-*` custom properties → CSS values. That option is SSR-injected verbatim into an inline
 * `:root{…}` block by the public renderer (frontend/src/components/public/ThemeTokenOverlay.tsx), so its
 * contract is a SECURITY boundary: an entry that survives here becomes CSS on every public page.
 *
 * This module is the backend authority for that contract. Until OLA 5 there was no server-side gate at all —
 * the customizer saved through the generic settings PUT and the overlay sanitized at render. That is fine
 * for the customizer's own writes (the browser already sanitized, and the render-time filter is the real
 * backstop). It is NOT fine for the mods IMPORT path, which ingests an admin-uploaded file: an import must
 * never trust the uploaded JSON, so it validates every key and value here BEFORE the option is written.
 *
 * Constants are generated from contracts/visual-contract.v1.json. The frontend consumes a separate
 * generated projection and a shared pure helper, so no backend module crosses the Next.js boundary.
 */

const { THEME_CONTRACT } = require('../generated/visual-contract.generated');
const TOKEN_POLICY = THEME_CONTRACT.tokens;

// A custom property the overlay will emit: `--wjs-` then lowercase alphanumerics and hyphens only.
const KEY_RE = new RegExp(TOKEN_POLICY.modNamePattern);
// The safe CSS-value charset. Deliberately excludes `;{}:<>` (declaration-block break-out) — which also
// makes the customizer's extra `/[;{}:<>]/` guard redundant, so it is not repeated here.
const VALUE_RE = new RegExp(TOKEN_POLICY.valuePattern);
// The upper bound on a value's length the overlay enforces before emitting it.
const MAX_VALUE_LEN: number = TOKEN_POLICY.maxValueLength;
// A whole mods object cannot be larger than this once serialized — a defensive cap so a hostile import
// cannot make the stored option (and thus every public page's inline <style>) unbounded.
const MAX_MODS_BYTES: number = TOKEN_POLICY.maxModsBytes;
const FORBIDDEN_FUNCTION = new RegExp(TOKEN_POLICY.forbiddenFunctionPattern, 'i');

/**
 * Protocol-relative URLs (`//attacker.example/x`) need no `:` and fit entirely inside VALUE_RE, so a token
 * value could become an exfiltration beacon the moment a browser resolved it. On top of the charset, reject
 * any value containing `//`, matching `url(` (any spacing/case), or containing a backslash (CSS escapes
 * could smuggle either form past the charset filter). Both packages derive these values from the
 * generated token policy; only the small executable predicate remains package-local.
 */
function isForbiddenTokenValue(value: string): boolean {
    return FORBIDDEN_FUNCTION.test(value)
        || TOKEN_POLICY.forbiddenSubstrings.some((substring: string) => value.includes(substring));
}

/** True when [key, value] is a mod the overlay would render. The single source of the accept decision. */
function isValidMod(key: unknown, value: unknown): value is string {
    return (
        typeof key === 'string' &&
        KEY_RE.test(key) &&
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_VALUE_LEN &&
        VALUE_RE.test(value) &&
        !isForbiddenTokenValue(value)
    );
}

interface ModsValidationError {
    key: string;
    /** Machine-readable reason, for the API response and for a field-level UI. */
    code: 'MODS_UNKNOWN_KEY' | 'MODS_INVALID_VALUE';
    message: string;
}

interface ModsValidationResult {
    ok: boolean;
    /** The clean object to store — present only when ok. */
    mods: Record<string, string>;
    /** Every offending entry, one per bad key. Empty when ok. */
    errors: ModsValidationError[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Extract the mods object from an uploaded import payload. Accepts either a BARE mods object
 * (`{ "--wjs-…": "…" }`) or the export WRAPPER (`{ theme, mods: { … } }`). Returns null when neither
 * shape is present — the caller turns that into a 400, never a silent empty import.
 */
function extractImportMods(payload: unknown): Record<string, unknown> | null {
    if (!isPlainObject(payload)) return null;
    if (isPlainObject(payload.mods)) return payload.mods;
    // A bare object with no `mods` wrapper is treated as the mods map itself. An empty object is a
    // legitimate "clear all overrides" import, so it is allowed through here and validated below.
    if (!('mods' in payload)) return payload;
    return null;
}

/**
 * STRICT validation for the import path: any key that is not a `--wjs-*` custom property, or any value the
 * overlay would drop, FAILS the whole import (reject, never silently strip) so the admin learns the file is
 * bad instead of importing a subset of it. Fail-closed as a whole.
 */
function validateThemeMods(input: unknown): ModsValidationResult {
    const errors: ModsValidationError[] = [];
    if (!isPlainObject(input)) {
        return { ok: false, mods: {}, errors: [{ key: '', code: 'MODS_INVALID_VALUE', message: 'mods must be a JSON object' }] };
    }
    const mods: Record<string, string> = {};
    // Own enumerable keys only — a payload carrying `__proto__`/`constructor` as data must be examined as
    // data, and Object.entries never walks the prototype, so a polluting key is simply an unknown key here.
    for (const [key, value] of Object.entries(input)) {
        if (typeof key !== 'string' || !KEY_RE.test(key)) {
            errors.push({ key: String(key), code: 'MODS_UNKNOWN_KEY', message: `"${String(key)}" is not a --wjs-* token` });
            continue;
        }
        if (!isValidMod(key, value)) {
            errors.push({ key, code: 'MODS_INVALID_VALUE', message: `"${key}" has a value the customizer would reject` });
            continue;
        }
        mods[key] = value as string;
    }
    if (errors.length) return { ok: false, mods: {}, errors };
    const serialized = JSON.stringify(mods);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MODS_BYTES) {
        return { ok: false, mods: {}, errors: [{ key: '', code: 'MODS_INVALID_VALUE', message: `mods exceed the ${MAX_MODS_BYTES}-byte cap` }] };
    }
    return { ok: true, mods, errors: [] };
}

/**
 * LENIENT sanitizer for the export/read path: drop anything invalid and return only the mods the overlay
 * would actually render. This is what an export serializes, so a stored option that somehow holds junk (a
 * pre-contract write, a hand-edited row) still exports a clean, re-importable file. Mirror of the
 * customizer's sanitizeMods.
 */
function sanitizeThemeMods(input: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!isPlainObject(input)) return out;
    for (const [key, value] of Object.entries(input)) {
        if (isValidMod(key, value)) out[key] = value as string;
    }
    return out;
}

/**
 * Parse the raw `active_theme_mods` option (stored as a JSON string, or already an object when the option
 * layer deserialized it) into a clean mods map. Never throws — a malformed row yields {}.
 */
function parseStoredMods(raw: unknown): Record<string, string> {
    let obj: unknown = null;
    if (typeof raw === 'string' && raw.trim()) {
        try { obj = JSON.parse(raw); } catch { obj = null; }
    } else if (isPlainObject(raw)) {
        obj = raw;
    }
    return sanitizeThemeMods(obj);
}

module.exports = {
    validateThemeMods,
    sanitizeThemeMods,
    parseStoredMods,
    extractImportMods,
    isForbiddenTokenValue,
    KEY_RE,
    VALUE_RE,
    MAX_VALUE_LEN,
    MAX_MODS_BYTES,
};
