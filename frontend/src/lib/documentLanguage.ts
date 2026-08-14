/**
 * WordJS — the document's language and writing direction.
 *
 * WHY THIS EXISTS. `frontend/src/app/layout.tsx` used to hardcode `<html lang="en">` with no `dir`
 * at all, so every WordJS site announced itself as English and laid out left-to-right regardless of
 * what it published. That is not a cosmetic gap: `lang` and `dir` are what drive the browser's own
 * bidi algorithm, hyphenation, quotation marks, `text-align: start`, every CSS logical property, and
 * what a screen reader pronounces. A theme cannot patch it from CSS — it gets one stylesheet and no
 * head input, and `body { direction: rtl }` still leaves the document claiming to be English, so
 * bidi reordering of mixed Arabic/Latin runs stays wrong. RTL was not hard here, it was impossible.
 *
 * THE ATTRIBUTE IS STRUCTURE, NOT DATA. Both values come from site options an admin can write
 * (`WPLANG`, `site_text_direction`), so neither may reach the attribute as an arbitrary string.
 * `dir` is a closed enum of three literals; `lang` must match a conservative BCP-47 shape and is
 * re-serialized from the parsed subtags, so nothing but `[A-Za-z0-9-]` can survive. Anything else
 * falls back to `en` / `ltr` — fail-closed, exactly like every other validator in the tree.
 *
 * Pure and dependency-free on purpose: the root layout is a server component, but this is also the
 * one place the RTL language list lives, and it is unit-testable without a DOM.
 */

/** The only values that may ever be written to the `dir` attribute. */
export type TextDirection = "ltr" | "rtl" | "auto";

export const TEXT_DIRECTIONS: readonly TextDirection[] = ["ltr", "rtl", "auto"];

/**
 * Right-to-left LANGUAGE subtags (primary subtag only, lowercase).
 *
 * A closed list, not a heuristic. It covers the scripts a CMS realistically publishes in, plus the
 * deprecated ISO-639-1 aliases (`iw` for Hebrew, `ji` for Yiddish) that still show up in stored
 * locale strings. Extending it is a one-line change with a test; guessing from the region or from
 * the content is not something a static resolver can do correctly, which is what `dir="auto"` (the
 * browser's own first-strong heuristic) is for.
 */
const RTL_LANGUAGES: ReadonlySet<string> = new Set([
    "ar",   // Arabic
    "arc",  // Aramaic
    "ckb",  // Central Kurdish (Sorani)
    "dv",   // Divehi / Maldivian
    "fa",   // Persian
    "he",   // Hebrew
    "iw",   // Hebrew (deprecated code, still stored by older tooling)
    "ji",   // Yiddish (deprecated code)
    "khw",  // Khowar
    "ks",   // Kashmiri
    "nqo",  // N'Ko
    "pnb",  // Western Punjabi (Shahmukhi)
    "ps",   // Pashto
    "sd",   // Sindhi
    "syr",  // Syriac
    "ug",   // Uyghur
    "ur",   // Urdu
    "yi",   // Yiddish
]);

/**
 * Right-to-left SCRIPT subtags (lowercase), checked when the tag carries one.
 *
 * This is what makes `pa-Arab` (Punjabi in Shahmukhi) and `az-Arab` come out RTL while plain `pa`
 * and `az` stay LTR — the script, when the author bothered to name it, is more authoritative than
 * the language.
 */
const RTL_SCRIPTS: ReadonlySet<string> = new Set([
    "adlm", "arab", "aran", "hebr", "mand", "nkoo", "rohg", "samr", "syrc", "thaa", "yezi",
]);

/** Practical cap. Real language tags are far shorter; this stops an option row being a payload. */
const MAX_TAG_LENGTH = 35;

/**
 * language [ "-" script ] [ "-" region ] — a deliberately narrow subset of BCP 47.
 * Extensions, variants and private-use subtags are refused rather than passed through: nothing in
 * WordJS consumes them, and every character admitted here ends up in an HTML attribute.
 */
const TAG_RE = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?$/;

export interface ParsedLocale {
    /** Canonically-cased tag, e.g. `es-ES`, `pa-Arab-PK`. */
    tag: string;
    /** Primary language subtag, lowercase. */
    language: string;
    /** Script subtag, lowercase, or null. */
    script: string | null;
}

/**
 * Parse a stored locale into canonical subtags, or null when it is not a locale.
 *
 * Accepts the underscore form WordPress-style options use (`es_ES`, `ar_SA`) as well as the hyphen
 * form. The returned `tag` is REBUILT from the matched subtags — the caller's string never reaches
 * the output — which is what makes it safe to interpolate into `lang`.
 */
export function parseLocale(raw: unknown): ParsedLocale | null {
    if (typeof raw !== "string") return null;
    // NOT trimmed, deliberately. The backend validator (routes/settings.ts) is anchored and rejects
    // surrounding whitespace, so accepting it here would make the read side more permissive than the
    // write side — the classic way two gates drift apart until only one of them is really enforcing.
    if (raw.length === 0 || raw.length > MAX_TAG_LENGTH) return null;
    const m = TAG_RE.exec(raw.replace(/_/g, "-").toLowerCase());
    if (!m) return null;
    const [, language, script, region] = m;
    const tag = [
        language,
        script ? script[0].toUpperCase() + script.slice(1) : null,
        region ? region.toUpperCase() : null,
    ].filter(Boolean).join("-");
    return { tag, language, script: script || null };
}

/** True when the tag's script (preferred) or language is written right-to-left. */
export function isRtlLocale(parsed: ParsedLocale | null): boolean {
    if (!parsed) return false;
    if (parsed.script) return RTL_SCRIPTS.has(parsed.script);
    return RTL_LANGUAGES.has(parsed.language);
}

/**
 * Narrow an arbitrary stored value to the `dir` enum, or null when it is not one of the three.
 * Exact match — no trimming, no case folding — for the same reason as parseLocale: the write-side
 * validator compares against the same three literals, and the two must agree on what is valid.
 */
export function parseTextDirection(raw: unknown): TextDirection | null {
    if (typeof raw !== "string") return null;
    return (TEXT_DIRECTIONS as readonly string[]).includes(raw) ? (raw as TextDirection) : null;
}

export interface DocumentLanguage {
    lang: string;
    dir: TextDirection;
}

/** What a site with nothing configured gets. Same as the old hardcoded attribute pair. */
export const DEFAULT_DOCUMENT_LANGUAGE: DocumentLanguage = { lang: "en", dir: "ltr" };

/**
 * Resolve the `<html lang>` / `<html dir>` pair from the site's settings.
 *
 * `WPLANG` is the site locale (the option `core/i18n.setLocale` already writes and `routes/seo.ts`
 * already reads for the RSS `<language>`); `site_text_direction` is the explicit override, one of
 * `ltr` / `rtl` / `auto`, and an empty/absent value means "derive from the locale".
 *
 * Both are read defensively: `settings` is whatever the /settings endpoint returned, which is `null`
 * on a fresh install and JSON-parsed values otherwise (so a numeric-looking option arrives as a
 * number, not a string) — every branch below funnels through the two parsers above.
 */
export function resolveDocumentLanguage(
    settings: Record<string, unknown> | null | undefined,
): DocumentLanguage {
    const parsed = parseLocale(settings?.WPLANG);
    const override = parseTextDirection(settings?.site_text_direction);
    return {
        lang: parsed ? parsed.tag : DEFAULT_DOCUMENT_LANGUAGE.lang,
        dir: override ?? (isRtlLocale(parsed) ? "rtl" : "ltr"),
    };
}
