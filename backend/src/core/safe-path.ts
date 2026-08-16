/**
 * WordJS — safe path resolution (the ONE place a user-provided name becomes a path)
 *
 * THE LESSON THIS FILE ENCODES. This codebase has shipped the same class of bug four times: the code
 * sanitizes VALUES and forgets to validate what chooses STRUCTURE — a tag name, a DDL object class, a
 * query inside a literal, a PATH SEGMENT. The corollary, and the rule here: never infer safety from
 * the ABSENCE of a token. Filtering `..` out of a string is not a containment proof; it is a guess
 * about how the OS will read the rest of it (`%2e%2e`, `..\`, `C:foo`, an NTFS `name:stream`, a
 * trailing dot on Win32, a symlink two segments up).
 *
 * So there is exactly one shape of defense here, and every caller gets all three parts of it:
 *   1. ALLOWLIST THE FORM. A segment must be one of the shapes the project already defines
 *      (THEME_SLUG for a theme directory, THEME_ASSET_NAME for a chrome/template file name), or —
 *      for a segment the code itself supplies — a single plain name with no separator, no drive, no
 *      NUL, and not `.` / `..`.
 *   2. RESOLVE CANONICALLY. path.resolve() against the base, so what is checked is the ABSOLUTE,
 *      NORMALIZED path the syscall will actually receive — not the string the caller passed.
 *   3. PROVE CONTAINMENT on that resolved value: it must start with `base + path.sep`. The check is
 *      on the value that is RETURNED, which is the whole point — a helper that validates a private
 *      local and hands back a boolean leaves the caller re-joining the raw input, which is precisely
 *      how the theme routes ended up with seven path-injection findings while "having a slug guard".
 *
 * FAIL CLOSED: anything that does not pass returns null. There is no "sanitized" fallback — a name
 * that cannot be a candidate must never be offered as one.
 *
 * Dependency-free (node:path only) on purpose: core/theme-doctor and core/template-validate are
 * loadable by the CLI without booting any subsystem, and requiring this must not change that.
 */

const path = require('path');

/**
 * A theme directory name. IDENTICAL to the guard core/themes.installThemeFromDir enforces on the way
 * IN (and theme-compile / theme-verify on the way through): a theme can only exist on disk if it
 * matched this, so this is the widest shape a reader ever needs to accept. Leading char is
 * alphanumeric (no `-`/`_` first: no accidental option-looking names), 64 chars max.
 */
const THEME_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * A file name a theme ships under chrome/ or templates/, WITHOUT the .json extension. Same source as
 * core/chrome-validate's TEMPLATE_PART_NAME and core/template-validate's PART_NAME (those two
 * re-declare it so each module loads alone; backend/src/tests/safe-path.test.ts asserts all three are
 * character-for-character identical, exactly like template-parts.test.ts already does for the pair).
 * The name lands in a /themes/<slug>/templates/<name>.json URL, so it is deliberately narrow.
 */
const THEME_ASSET_NAME = /^[a-z0-9-]{1,40}$/;

/** Is `v` a theme directory name the installer could have produced? */
function isThemeSlug(v: unknown): boolean {
    return typeof v === 'string' && THEME_SLUG.test(v);
}

/** Is `v` a chrome/template file name (no extension) the route hierarchy could resolve? */
function isThemeAssetName(v: unknown): boolean {
    return typeof v === 'string' && THEME_ASSET_NAME.test(v);
}

/**
 * Is `seg` a single, literal path segment — one name, naming nothing but itself?
 *
 * This is the FORM gate for segments the code supplies or reads back from a directory listing
 * (`'chrome'`, `'theme.json'`, a readdir entry). It is a closed description of what a segment may
 * BE, not a list of things it may not contain:
 *   · a non-empty string, no NUL (Node throws on it, and a truncating C string is how a check and a
 *     syscall come to disagree about the same path);
 *   · no `/` and no `\` — a segment is ONE level, on every platform (Win32 accepts both);
 *   · not `.` and not `..` — the only two names that mean "somewhere else";
 *   · not absolute, and not `C:`-prefixed — `path.resolve(base, 'C:x')` is drive-relative on Win32
 *     and escapes the base entirely;
 *   · no `:` at all — an NTFS alternate data stream (`file:stream`) reads a different byte range than
 *     the name suggests, and nothing this project stores needs a colon in a file name.
 */
function isPlainSegment(seg: unknown): boolean {
    if (typeof seg !== 'string' || seg.length === 0) return false;
    if (seg.includes('\0')) return false;
    if (seg.includes('/') || seg.includes('\\')) return false;
    if (seg === '.' || seg === '..') return false;
    if (seg.includes(':')) return false;
    if (path.isAbsolute(seg)) return false;
    return true;
}

/**
 * Resolve `segments` under `baseDir` and PROVE the result stays inside it. Returns the absolute,
 * normalized path, or null if any segment is not a plain segment or the result escapes.
 *
 * Containment is strict (a child, never the base itself): every caller here is asking for something
 * INSIDE a directory, and demanding `resolved.startsWith(base + path.sep)` keeps the proof a single
 * unambiguous statement about the value being returned. Use isWithin() when equality is meaningful.
 */
function resolveWithin(baseDir: string, ...segments: string[]): string | null {
    if (typeof baseDir !== 'string' || baseDir.length === 0) return null;
    if (segments.length === 0) return null;
    for (const seg of segments) {
        if (!isPlainSegment(seg)) return null;
    }
    const base = path.resolve(baseDir);
    const resolved = path.resolve(base, ...segments);
    // THE CONTAINMENT PROOF, on the value handed back. `base` is already normalized and absolute, so
    // this compares canonical prefixes — not user text.
    if (!resolved.startsWith(base + path.sep)) return null;
    return resolved;
}

/**
 * Is `candidate` the directory `baseDir` itself, or something inside it? Both sides are resolved
 * first. For call sites that hold an already-built path and need a yes/no (never as a substitute for
 * resolveWithin, which is what should have built the path in the first place).
 */
function isWithin(baseDir: string, candidate: string): boolean {
    if (typeof baseDir !== 'string' || typeof candidate !== 'string') return false;
    if (baseDir.length === 0 || candidate.length === 0) return false;
    if (baseDir.includes('\0') || candidate.includes('\0')) return false;
    const base = path.resolve(baseDir);
    const resolved = path.resolve(candidate);
    return resolved === base || resolved.startsWith(base + path.sep);
}

/**
 * The theme-specific front door: `<themesDir>/<slug>`, with the slug's FORM checked against
 * THEME_SLUG before it is ever concatenated, and containment proved after. Null means "not a theme
 * this installation could have" — callers turn that into 400 / THEME_NOT_FOUND, never into a read.
 */
function resolveThemeDir(themesDir: string, slug: unknown): string | null {
    if (!isThemeSlug(slug)) return null;
    return resolveWithin(themesDir, slug as string);
}

/**
 * `<themeDir>/<subdir>/<name>.json` for the two directories a theme ships compositions in
 * (`chrome`, `templates`). The name's FORM is THEME_ASSET_NAME — the same shape the validators
 * enforce on the declaration side, so a declared part and the file it resolves to can never disagree.
 */
function resolveThemeAsset(themeDir: string, subdir: string, name: unknown): string | null {
    if (!isThemeAssetName(name)) return null;
    return resolveWithin(themeDir, subdir, `${name as string}.json`);
}

/**
 * ONE DNS label, per RFC 1035 §2.3.1 / RFC 1123: 1–63 chars, alphanumeric at both ends, hyphens
 * only inside. Deliberately anchored and BOUNDED ({0,61} between two single-character classes) so
 * it cannot backtrack super-linearly — this project has already shipped ReDoS in a hostname-shaped
 * regex, and the labels here arrive straight from an admin HTTP body.
 */
const CERT_LABEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/**
 * Is `v` a DNS name an ACME order could legitimately identify — and therefore a name this
 * installation may keep a certificate backup under?
 *
 * The form is checked LABEL BY LABEL rather than with one composite pattern: a dotted name is a
 * list, and validating it as a list is both linear and impossible to get subtly wrong. Everything
 * that makes a path traversal is excluded as a CONSEQUENCE of the form, not by hunting for tokens —
 * a label cannot be empty, so `..`, `.`, a leading `/`, `\`, `C:` or a NUL never survive it.
 *
 * A leading `*.` is accepted because a wildcard order is exactly what the DNS-01 flow exists for
 * (the admin UI advertises it: "For firewalls / wildcards"). `*` is not a path vector — it carries
 * no separator, no drive letter and no colon, and containment is still proved on the resolved value
 * below. On Win32 the OS refuses to mkdir such a name, which is today's behaviour unchanged.
 */
function isCertHostname(v: unknown): boolean {
    if (typeof v !== 'string') return false;
    // 253 is the RFC 1035 presentation-format ceiling; the cap is applied BEFORE any splitting so
    // the work done on a hostile string is bounded.
    if (v.length === 0 || v.length > 253) return false;
    const host = v.startsWith('*.') ? v.slice(2) : v;
    if (host.length === 0) return false;
    for (const label of host.split('.')) {
        if (!CERT_LABEL.test(label)) return false;
    }
    return true;
}

/**
 * `<liveDir>/<hostname>` — the directory a provisioned certificate's privkey.pem / fullchain.pem
 * are written into. Null means "not a name a certificate could be issued for", and the callers turn
 * that into a refusal, never into a write.
 *
 * WHY THIS FACADE EXISTS: POST /api/v1/certs/dns-finish hands `step1Data` back from the browser and
 * cert-manager used `path.join(LIVE_DIR, step1Data.domain)` verbatim — a value that chooses a
 * DIRECTORY, straight off the wire, followed by mkdir(recursive) and two writeFileSync. The private
 * key lands there, so a name that picks the path is an arbitrary-write primitive with the operator's
 * own key material as the payload.
 */
function resolveCertDir(liveDir: string, hostname: unknown): string | null {
    if (!isCertHostname(hostname)) return null;
    return resolveWithin(liveDir, hostname as string);
}

module.exports = {
    THEME_SLUG,
    THEME_ASSET_NAME,
    CERT_LABEL,
    isThemeSlug,
    isThemeAssetName,
    isCertHostname,
    isPlainSegment,
    resolveWithin,
    isWithin,
    resolveThemeDir,
    resolveThemeAsset,
    resolveCertDir,
};
