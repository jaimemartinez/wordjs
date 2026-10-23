/**
 * WordJS — WHICH WORDJS A PLUGIN NEEDS (`requires.wordjs` in manifest.json).
 *
 * A plugin's admin bundle imports host modules the core injects at runtime (globalThis.WordJS.host[...]),
 * and a module added in one release does not exist in an older one. The catalog at releases/latest is
 * built from the newest core, so a site that had not updated its core could install or update a plugin
 * into a blank admin screen ("WordJS host did not provide …components/ui/DatePicker"), and nothing said why.
 *
 * A plugin declares the core it needs as a semver range:
 *     "requires": { "wordjs": ">=2.10.0" }
 * build-marketplace copies it into each catalog entry; the catalog marks every entry `compatible` against
 * THIS install's version; and install, update, adopt and upload refuse an incompatible package with 409
 * `core_version_too_old`, before anything is extracted or replaced. No `requires` = no constraint (every
 * plugin published before this field). Cores released before this check ignore the field — the guard
 * protects from the release that ships it on.
 *
 * The version is the product version (config/product-version). When it cannot be read it is 0.0.0, and
 * then nothing is refused: an install that does not know its own version must not lock every plugin out.
 */
const semver = require('semver');

/** The range a manifest or catalog entry declares in `requires.wordjs`, or null when it declares none. */
function requiredCoreRange(source: any): string | null {
    const req = source && typeof source === 'object' ? source.requires : null;
    if (!req || typeof req !== 'object' || Array.isArray(req)) return null;
    const range = req.wordjs;
    return typeof range === 'string' && range.trim() ? range.trim() : null;
}

/**
 * Manifest validation: `requires`, when present, is `{ wordjs: "<semver range>" }` with a range that
 * names a minimum (">=2.10.0", "^2.10.0", ">=2.10.0 <3"). Returns the problems (empty = valid).
 */
function validateManifestRequires(requires: any): string[] {
    if (requires === undefined || requires === null) return [];
    if (typeof requires !== 'object' || Array.isArray(requires)) return ['`requires` must be an object, e.g. { "wordjs": ">=2.10.0" }.'];
    const problems: string[] = [];
    for (const key of Object.keys(requires)) {
        if (key !== 'wordjs') problems.push(`\`requires.${key}\` is not supported (only \`requires.wordjs\`).`);
    }
    if (requires.wordjs !== undefined) {
        const r = requires.wordjs;
        if (typeof r !== 'string' || !r.trim() || !semver.validRange(r.trim())) {
            problems.push('`requires.wordjs` must be a semver range such as ">=2.10.0".');
        }
    }
    return problems;
}

/** This install's WordJS version (0.0.0 when it cannot be read). */
function currentCoreVersion(): string {
    try { return require('../config/product-version').resolveProductVersion(); } catch { return '0.0.0'; }
}

export type CoreCompatibility = {
    compatible: boolean;
    /** The declared range, or null. */
    requires: string | null;
    /** The lowest version the range admits ("2.10.0"), for "Requires WordJS ≥ X". Null when no range. */
    minimum: string | null;
    current: string;
};

/** Does this install (or `current`) satisfy what `source` (a manifest or catalog entry) requires? */
function coreCompatibility(source: any, current: string = currentCoreVersion()): CoreCompatibility {
    const range = requiredCoreRange(source);
    if (!range || !semver.validRange(range)) {
        // No requirement — or one this core cannot read: manifest validation refuses a malformed range at
        // install, and a catalog entry carrying one is not ours to block on a guess.
        return { compatible: true, requires: range, minimum: null, current };
    }
    let minimum: string | null;
    try { const m = semver.minVersion(range); minimum = m ? m.version : null; } catch { minimum = null; }
    const known = semver.valid(semver.coerce(current)) && current !== '0.0.0';
    const compatible = !known || semver.satisfies(semver.coerce(current).version, range, { includePrerelease: true });
    return { compatible, requires: range, minimum, current };
}

/**
 * Throw the refusal an incompatible install/update gets: 409 `core_version_too_old`, with the required
 * range, the minimum and this install's version, in an Error carrying `.status` and `.body` (the shape
 * the plugin routes already relay).
 */
function assertCoreCompatible(source: any, slug: string, current?: string): void {
    const c = coreCompatibility(source, current);
    if (c.compatible) return;
    const need = c.minimum ? `WordJS ${c.minimum} or later` : `WordJS ${c.requires}`;
    const e: any = new Error(`'${slug}' needs ${need}; this site runs WordJS ${c.current}. Update WordJS first (Admin → Updates), then install or update the plugin.`);
    e.status = 409;
    e.body = { error: e.message, code: 'core_version_too_old', requires: c.requires, minimum: c.minimum, current: c.current };
    throw e;
}

module.exports = { requiredCoreRange, validateManifestRequires, currentCoreVersion, coreCompatibility, assertCoreCompatible };
