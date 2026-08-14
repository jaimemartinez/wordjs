/**
 * WordJS — the site locale, rendered as a LANGUAGE TAG.
 *
 * WHY THIS EXISTS. `WPLANG` stores a WordPress-style LOCALE (`en_US`, `pt_BR`, `pa_Arab_PK`) and it
 * has to keep storing one: `core/i18n` keys the translation files by it (`languages/default-es_ES.json`)
 * and `getAvailableLocales()` matches that underscore shape on disk. A locale is not a language tag.
 * RFC 7231/BCP 47 — and therefore RSS `<language>` and HTML `lang` — separate subtags with a HYPHEN,
 * so `en_US` is not a valid value for either. Seeding `WPLANG: 'en_US'` at install (core/options) is
 * right for the translation loader and wrong for anything that renders the locale, and the RSS feed
 * rendered it verbatim: a fresh install started emitting `<language>en_US</language>`, which no feed
 * validator accepts, where the previous default (`'en'`) had been valid by accident.
 *
 * So the conversion lives HERE, at the one point where a stored locale becomes a tag, and every
 * renderer goes through it instead of re-deriving it (or, as before, not deriving it at all).
 *
 * THE TAG IS STRUCTURE, NOT DATA. `WPLANG` is an option an admin can write, and the result lands in
 * an XML element and (through the frontend resolver) in an HTML attribute. So this is fail-closed the
 * same way every other gate in the tree is: the output is REBUILT from the matched subtags — the
 * caller's string never reaches it — and anything that is not a recognisable locale becomes `en`
 * rather than being passed through and escaped.
 *
 * MIRROR OF `frontend/src/lib/documentLanguage.ts` (`parseLocale`), deliberately: the two packages
 * build separately and the frontend resolver cannot import backend code. Same accepted subset, same
 * canonical casing, same fallback — so `<language>` in the feed and `<html lang>` on the page always
 * agree. The agreement is pinned by tests on both sides (backend/src/tests/feed-language.test.ts and
 * frontend/src/lib/__tests__/documentLanguage.test.ts share one locale→tag corpus); change one copy
 * and you must change the other.
 */

/** What a site whose locale cannot be parsed announces. Valid, honest, and the pre-seed default. */
const DEFAULT_LANGUAGE_TAG = 'en';

/** Practical cap. Real tags are far shorter; this stops an option row being a payload. */
const MAX_TAG_LENGTH = 35;

/**
 * language [ "-" script ] [ "-" region ] — the same deliberately narrow subset of BCP 47 the write
 * validator (routes/settings.ts) and the frontend resolver accept. Extensions, variants and
 * private-use subtags are refused rather than passed through: nothing in WordJS consumes them, and
 * every character admitted here ends up in markup.
 */
const TAG_RE = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?$/;

/**
 * Convert a stored locale (`en_US`, `ar-SA`, `pa_Arab_PK`) into a canonical BCP 47 language tag
 * (`en-US`, `ar-SA`, `pa-Arab-PK`), or `fallback` when it is not a locale at all.
 *
 * NOT trimmed, deliberately — the write validator is anchored and rejects surrounding whitespace, so
 * accepting it here would make the read side more permissive than the write side, which is how two
 * gates drift apart until only one of them is really enforcing anything.
 */
function toLanguageTag(raw: any, fallback: string = DEFAULT_LANGUAGE_TAG): string {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_TAG_LENGTH) return fallback;
    const m = TAG_RE.exec(raw.replace(/_/g, '-').toLowerCase());
    if (!m) return fallback;
    const [, language, script, region] = m;
    return [
        language,
        script ? script[0].toUpperCase() + script.slice(1) : null,
        region ? region.toUpperCase() : null,
    ].filter(Boolean).join('-');
}

module.exports = {
    toLanguageTag,
    DEFAULT_LANGUAGE_TAG,
    MAX_LANGUAGE_TAG_LENGTH: MAX_TAG_LENGTH,
};
