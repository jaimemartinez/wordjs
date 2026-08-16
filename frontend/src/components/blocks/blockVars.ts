import React from "react";

/**
 * PER-BLOCK CSS VARIABLE CONTRACT — the seam that makes blocks themeable.
 *
 * Every block's visual values live in `wordjs-ui.css` as `var(--wjs-<block>-<prop>, <fallback>)`
 * rather than as inline styles on the element. That single change is what lets a theme restyle a
 * block at all: an inline style beats any stylesheet, so while blocks wrote their looks inline the
 * only way a theme could touch them was `!important` on every declaration (the bundled themes
 * carry ~100 each, which is the symptom this contract removes).
 *
 * The cascade then resolves in the order people expect, with no `!important` anywhere:
 *
 *   1. What the AUTHOR set on this one block  → inline `--wjs-hero-title-size` on that element
 *   2. What the THEME wants                   → `.wjs-block-hero { --wjs-hero-title-size: … }`
 *   3. The block's own fallback               → the second argument of `var()`
 *
 * Rule 1 only outranks rule 2 when the author actually chose something — which is exactly why
 * `blockVars` OMITS every empty value instead of emitting `undefined`/`""`. An always-present
 * inline variable would pin the block to its default forever and lock the theme out again.
 */
export function blockVars(
    prefix: string,
    map: Record<string, string | number | undefined | null | false>
): React.CSSProperties {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(map)) {
        if (value === undefined || value === null || value === "" || value === false) continue;
        out[`--wjs-${prefix}-${key}`] = String(value);
    }
    return out as React.CSSProperties;
}

/** Join class names, dropping falsy entries. */
export const cx = (...parts: (string | false | null | undefined)[]): string =>
    parts.filter(Boolean).join(" ");

/**
 * THE SINGLE POINT WHERE A BLOCK CLASS NAME IS BUILT.
 *
 * WordJS emits its OWN identity first and the historical WordPress-compatible class second:
 *
 *     bc('heading')  →  "wjs-block-heading wp-block-heading"
 *
 * Both are on every element, which is the whole reason this is viable as an ADDITION rather than a
 * rename. Three populations depend on it and none of them can be migrated by us:
 *
 *   - THEMES ALREADY INSTALLED (ours and third-party) are written against `.wp-block-*`. Renaming
 *     would silently unstyle every one of them on the next upgrade.
 *   - CONTENT ALREADY SAVED in the databases of live installs — and everything a WXR import brings
 *     over from WordPress — carries `wp-block-*` in raw HTML we never re-render. That content keeps
 *     working because `wordjs-ui.css` lists BOTH classes on every rule (`.wjs-block-x, .wp-block-x`),
 *     with the own class as the source and the historical one as an alias.
 *   - NEW THEMES can finally name the platform they are actually written for.
 *
 * Why a function and not 233 string literals: the classes used to be spelled out inline across eight
 * components, so "emit both, own first" would have been a convention — and a convention is exactly
 * the kind of rule that survives until the next person adds a block and forgets. The policy lives
 * here once, and `frontend/src/components/content/__tests__/blockClassEmission.test.tsx` fails the
 * build if a `wp-block-*` literal reappears in block markup outside this module.
 *
 * The historical class is DEPRECATED, not permanent: it is scheduled for removal in the next major
 * version (see documentation/block-class-identity.md). When it goes, this function stops emitting the
 * second half and every call site is already correct.
 *
 * Accepts BARE block names (`'heading'`, `'card__title'`, `'divider--dashed'`) — no prefix. A name
 * that arrives already prefixed is normalized instead of double-prefixed, so a mistaken
 * `bc('wp-block-heading')` yields the right two classes rather than `wjs-block-wp-block-heading`.
 * Falsy entries drop, so a conditional modifier can be passed inline.
 */
export const BLOCK_CLASS_PREFIX = "wjs-block-";
export const LEGACY_BLOCK_CLASS_PREFIX = "wp-block-";

export const bc = (...names: (string | false | null | undefined)[]): string =>
    names
        .filter(Boolean)
        .map((name) => String(name).replace(/^(?:wjs|wp)-block-/, ""))
        .map((name) => `${BLOCK_CLASS_PREFIX}${name} ${LEGACY_BLOCK_CLASS_PREFIX}${name}`)
        .join(" ");

/**
 * Append `px` to a bare number, pass anything else through untouched.
 * Lets a field accept both `24` and `1.5rem` / `clamp(…)` without the block caring which.
 */
export const unit = (v: string | number | undefined | null): string | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    return typeof v === "number" || /^-?\d*\.?\d+$/.test(String(v)) ? `${v}px` : String(v);
};
