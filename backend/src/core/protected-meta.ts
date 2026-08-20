/**
 * WordJS — post meta keys the GENERIC write surfaces must never accept.
 *
 * WHY THIS EXISTS. `_wp_attached_file` and `_wp_attachment_metadata` are not author content: they are
 * the SERVER's record of where an upload physically lives on disk, written once by Media.create() and
 * read back by Media.delete() to build the path it unlinks. Both were reachable through the two generic
 * meta writers — POST /posts/:id/meta and the `meta` bag of POST/PUT /posts — which gate on "may this
 * user edit this post" and nothing else. An attachment row IS a post whose author is the uploader, so
 * an `author` could rewrite `_wp_attached_file` on their OWN upload to `../data/wordjs.db` and then
 * DELETE /media/:id to unlink an arbitrary existing file (the audit's CRITICAL). core/safe-path now
 * contains the sink, but a value that can never be written is a stronger statement than a value that is
 * merely contained on the way out, so the source is closed here as well.
 *
 * This mirrors the PROTECTED_META set models/User.ts already keeps for user_meta ('role',
 * 'token_valid_after', the mailbox grant): the SAME class of defect — a route forwarding req.body.meta
 * into a generic per-key writer — and therefore the same shape of defense, one module up so both write
 * surfaces of posts consume ONE list instead of each keeping its own.
 *
 * WHAT IS DELIBERATELY *NOT* HERE, and must stay out. `_puck_data`, `_wjs_template`, `_thumbnail_id`
 * and the SEO keys look internal (leading underscore, backend-shaped names) but they are AUTHOR
 * CONTENT: the editor writes every one of them through exactly this `meta` bag on every save
 * (frontend/src/app/admin/posts/[id]/page.tsx). Adding them here would not harden anything — it would
 * silently break the page builder, the theme-template picker and the featured image. Their protection
 * is the CAPABILITY gate (canEditPostRecord, which now covers the meta route too) plus sanitizeMetaValue,
 * not a key ban. Only keys that NO client is supposed to author belong in this file.
 *
 * WHAT "PROTECTED" DESCRIBES: THE SURFACE, NOT THE KEY. This list is the policy for an UNTRUSTED
 * REQUEST — a caller naming a key on a route. It is NOT "these bytes may never appear in this
 * column": Media.create() writes `_wp_attached_file` on every upload, and the WXR importer has to
 * write it too or a migrated attachment has no file at all (that regression shipped when the importer
 * swapped its own two-key list for this one and answered "created: 1" for attachments with no path).
 * A CORE-OWNED WRITE therefore does not consult this list — it validates the VALUE's shape at the
 * point where the value becomes a path, which is where core/safe-path already lives. Keep the two
 * apart explicitly; collapsing them in either direction has now broken something in both directions.
 */

/**
 * Meta keys that only backend code may write.
 *
 *  · `_wp_attached_file` / `_wp_attachment_metadata` — the attachment's on-disk location and its
 *    per-size file names. Media.delete() turns these into unlink() targets.
 *  · `_wp_trash_meta_status` / `_wp_trash_meta_time` — the status a trashed post must return to.
 *    Post.untrash() reads the first one and falls back to the literal 'draft' when it is missing or
 *    forged, so a writable value is a way to quietly demote a published post on restore.
 *  · `_edit_lock` / `_edit_last` — editing-session bookkeeping. Nothing live writes them today (the
 *    importers explicitly SKIP them as non-portable), so listing them costs nothing and stops the
 *    generic bag from becoming their first writer.
 */
const PROTECTED_POST_META: Set<string> = new Set([
    '_wp_attached_file',
    '_wp_attachment_metadata',
    '_wp_trash_meta_status',
    '_wp_trash_meta_time',
    '_edit_lock',
    '_edit_last',
]);

/**
 * Drop the combining diacritical marks (U+0300..U+036F) that NFKD splits an accented letter into.
 *
 * Written as an explicit code-point range rather than a regex escape so the source stays pure ASCII:
 * a literal combining mark in a source file is invisible in review and does not survive a careless
 * re-encode, and this comparison is a security boundary.
 */
function stripCombiningMarks(value: string): string {
    let out = '';
    for (const ch of value) {
        const cp = ch.codePointAt(0) as number;
        if (cp >= 0x0300 && cp <= 0x036f) continue;
        out += ch;
    }
    return out;
}

/**
 * Code points the UCA gives ZERO WEIGHT — "completely ignorable" — and which therefore do not exist
 * as far as `utf8mb4_unicode_ci` is concerned.
 *
 * THE CLASS (same one stripCombiningMarks belongs to): a guard that compares text in JavaScript while
 * the SINK compares the same text in SQL under a COLLATION. Case and accents were folded; the
 * ignorables were not, so `_wp_attached_file` + U+0000, `_wp_attached` + U+00AD + `file` and
 * `_wp_attached_file` + U+200B all answered "not protected" here and are the SAME ROW to MySQL —
 * the guard inspecting one representation while the UPDATE lands on another, one more time.
 *
 * Ranges, not a regex escape, for the reason above: this file stays pure ASCII. Folding MORE than
 * MySQL does is safe by construction — it can only make a decorated spelling of a protected key
 * refused on an engine where it would have been a distinct row (SQLite/Postgres); no legitimate meta
 * key contains a control character, a soft hyphen, a bidi mark or a variation selector.
 *
 * Extend THIS TABLE when a new zero-weight range turns up. Do not add a second comparison somewhere
 * else — backend/src/tests/request-field-types.test.ts iterates every entry against every protected
 * key, so an addition here is covered automatically.
 */
const IGNORABLE_RANGES: ReadonlyArray<readonly [number, number]> = Object.freeze([
    [0x0000, 0x0008],   // C0 controls before TAB
    [0x000e, 0x001f],   // C0 controls after CR
    [0x007f, 0x009f],   // DEL + C1 controls
    [0x00ad, 0x00ad],   // SOFT HYPHEN
    [0x180e, 0x180e],   // MONGOLIAN VOWEL SEPARATOR
    [0x200b, 0x200f],   // ZWSP, ZWNJ, ZWJ, LRM, RLM
    [0x202a, 0x202e],   // bidi embedding/override
    [0x2060, 0x2064],   // WORD JOINER .. INVISIBLE PLUS
    [0x2066, 0x206f],   // bidi isolates + deprecated format characters
    [0xfe00, 0xfe0f],   // variation selectors
    [0xfeff, 0xfeff],   // ZERO WIDTH NO-BREAK SPACE (BOM)
    [0xfff9, 0xfffb],   // interlinear annotation
    [0x1d173, 0x1d17a], // musical formatting
    [0xe0000, 0xe007f], // language tags
    [0xe0100, 0xe01ef], // variation selectors supplement
]);

/** Drop every zero-weight code point (see IGNORABLE_RANGES). */
function stripIgnorable(value: string): string {
    let out = '';
    for (const ch of value) {
        const cp = ch.codePointAt(0) as number;
        let ignorable = false;
        for (const [lo, hi] of IGNORABLE_RANGES) {
            if (cp >= lo && cp <= hi) { ignorable = true; break; }
        }
        if (ignorable) continue;
        out += ch;
    }
    return out;
}

/**
 * The comparison the SINK will actually perform, made explicit here.
 *
 * WHY THIS IS NOT `Set.has(key)`. The guard compares in JavaScript (binary, case- and
 * accent-SENSITIVE, no padding rules); the sink compares in SQL — `UPDATE post_meta ... WHERE
 * meta_key = ?` — under the COLUMN's collation. On MySQL/MariaDB the pool is opened with
 * `utf8mb4_unicode_ci` (drivers/mysql.ts) and `post_meta.meta_key` carries no explicit COLLATE
 * (config/database.ts), so the engine matches case-insensitively, accent-insensitively and with
 * PAD SPACE semantics. `_WP_ATTACHED_FILE`, `_wp_attached_filé` and `'_wp_attached_file '` are all
 * DIFFERENT strings to the Set and the SAME row to MySQL: the guard would inspect one value and the
 * write would land on another — the exact "checked value ≠ used value" shape this audit is about.
 *
 * So the key is folded down to the weakest comparison any supported engine can apply before it is
 * tested: NFKD + strip combining marks (accent-insensitive), trim (PAD SPACE), lowercase (case
 * insensitive). A key that COLLIDES with a protected key under any engine's rules is refused under
 * all of them, which makes the answer identical on SQLite (BINARY), Postgres and MySQL.
 */
export function canonicalMetaKey(key: string): string {
    return stripIgnorable(stripCombiningMarks(String(key).normalize('NFKD'))).trim().toLowerCase();
}

const PROTECTED_CANONICAL: Set<string> = new Set(
    [...PROTECTED_POST_META].map((k) => canonicalMetaKey(k))
);

/**
 * Is `key` a meta key the generic post-meta writers must refuse?
 *
 * Non-string keys answer false — they can never MATCH a protected key in JS. That is NOT enough on its
 * own: `{"key":["_wp_attached_file"]}` reaches this function as an Array (false) and reaches
 * better-sqlite3/mysql2 as the string `_wp_attached_file`, because both drivers flatten a
 * single-element array parameter. The callers therefore reject a non-string key OUTRIGHT (400) before
 * asking this question; this function only has to answer for the strings that survive that check.
 *
 * The comparison is exact after canonicalization — no prefix matching — because a prefix rule would
 * sweep up author-written keys like `_wjs_template` that must stay writable.
 */
function isProtectedPostMeta(key: unknown): boolean {
    if (typeof key !== 'string') return false;
    return PROTECTED_POST_META.has(key) || PROTECTED_CANONICAL.has(canonicalMetaKey(key));
}

/**
 * The longest meta key any supported engine can store. `post_meta.meta_key` is declared TEXT and
 * NARROWED to VARCHAR(255) by drivers/mysql-text-rule (KEY_TEXT) the moment idx_post_meta_post_id_key
 * is created, which config/database does on every boot — so under STRICT_TRANS_TABLES a longer key is
 * ERROR 1406, i.e. an unmapped 500 on a request the route said was fine.
 */
const MAX_META_KEY_LENGTH = 255;

/**
 * Property names that are NOT data when they are used as an object key.
 *
 * THE CLASS: any map this codebase builds by ASSIGNING an attacker-chosen key into an object literal.
 * `meta[row.meta_key] = value` with `row.meta_key === '__proto__'` creates NO property: it swaps the
 * map's PROTOTYPE for an attacker-chosen object, so every key that has no row of its own becomes
 * readable through the prototype chain (`allMeta['_wp_attached_file']` in models/Media.ts is the live
 * example) while `Object.keys()` and `JSON.stringify()` show nothing — invisible to any review done
 * through the API response. `constructor` and `prototype` are the same shape one name over, which is
 * exactly how this audit's meta-defect keeps recurring.
 *
 * Two halves, both required: this list stops the key from being STORED, and the readers
 * (Post.getAllMeta / getAllMetaForIds) build their map with defineProperty so a row already in the
 * database — written before this rule, or by an importer — cannot pollute anything either.
 */
const RESERVED_META_KEYS: Set<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Is this meta key WRITABLE AT ALL — as a FORM, before anyone asks who is writing it?
 *
 * Returns a machine-readable reason, or null when the key is fine. ONE function so the three writers
 * (POST /posts/:id/meta, the `meta` bag of POST/PUT /posts, and the WXR importer) apply the SAME rule;
 * a fourth writer must call this instead of re-deriving two thirds of it, which is how the array-key
 * bypass survived a whole remediation wave.
 *
 *   · 'type'     — not a string. Every guard downstream compares strings, while better-sqlite3 and
 *                  mysql2 both FLATTEN a one-element array parameter back into the string: guard and
 *                  sink disagreeing about the same bytes.
 *   · 'empty'    — empty, or nothing but whitespace/zero-weight characters (see canonicalMetaKey):
 *                  a key MySQL would compare equal to '' is not a key.
 *   · 'reserved' — see RESERVED_META_KEYS.
 *   · 'too_long' — see MAX_META_KEY_LENGTH.
 */
function metaKeyProblem(key: unknown): 'type' | 'empty' | 'reserved' | 'too_long' | null {
    if (typeof key !== 'string') return 'type';
    const canonical = canonicalMetaKey(key);
    if (key.length === 0 || canonical.length === 0) return 'empty';
    if (RESERVED_META_KEYS.has(canonical)) return 'reserved';
    if (key.length > MAX_META_KEY_LENGTH) return 'too_long';
    return null;
}

/** Convenience twin of metaKeyProblem for callers that only branch on "may I write this key". */
function isWritableMetaKey(key: unknown): boolean {
    return metaKeyProblem(key) === null;
}

module.exports = {
    PROTECTED_POST_META,
    RESERVED_META_KEYS,
    MAX_META_KEY_LENGTH,
    isProtectedPostMeta,
    metaKeyProblem,
    isWritableMetaKey,
    canonicalMetaKey,
    IGNORABLE_RANGES,
};
