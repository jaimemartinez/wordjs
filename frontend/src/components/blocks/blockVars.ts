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
 *   2. What the THEME wants                   → `.wp-block-hero { --wjs-hero-title-size: … }`
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
 * Append `px` to a bare number, pass anything else through untouched.
 * Lets a field accept both `24` and `1.5rem` / `clamp(…)` without the block caring which.
 */
export const unit = (v: string | number | undefined | null): string | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    return typeof v === "number" || /^-?\d*\.?\d+$/.test(String(v)) ? `${v}px` : String(v);
};
