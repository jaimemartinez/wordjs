import React from "react";
import { safeCustomPropValue, safeStyleObject, AUTHOR_CSS_PROPS } from "./safeStyle";

/**
 * THE OTHER SINK ON THE SAME ELEMENT. Re-exported from here so a block still imports ONE module to
 * build its markup: `style` goes through `blockVars`/`safeCss`, `class` through `bc`/`cx` and — when
 * a modifier carries author text — `safeClassToken`. The criterion itself lives in safeStyle.ts
 * next to the value criterion, because a class name and a custom property are the same thing seen
 * twice: a token whose meaning some stylesheet decides. See its header for why the prefix, not the
 * token grammar, is the load-bearing half.
 */
export { safeClassToken, safeExtraClassList } from "./safeStyle";

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
 *
 * EVERY VALUE IS AUTHOR TEXT, so every value goes through `safeCustomPropValue`. This used to be a
 * bare `String(value)`: a free-text prop that feeds a variable (Heading/Text `color`, Section `bg`,
 * Table `stripeBg`, …) therefore landed in the style attribute verbatim, and React does not escape
 * `;` inside a style value — so one colour field could append `position:fixed;inset:0;…` and paint a
 * full-screen overlay over the page. A rejected value is DROPPED, exactly like an empty one, so the
 * block falls back to the theme's value instead of to a broken declaration.
 *
 * THE NAME BEING OURS IS NOT ENOUGH, and that is the whole point of `safeCustomPropValue` rather
 * than the bare value criterion: the name decides WHICH DECLARATION the stylesheet drops this value
 * into. `--wjs-pricing-highlight-scale` is a literal here and still ends up inside
 * `transform: scale( … )`, so the free-text `highlightScale` field of PricingTable could scale an
 * opaque plan — with its own `<a href>` — over the entire viewport. Which names are narrowed, and to
 * what, is decided ONCE in safeStyle.ts (`NARROWED_VAR_VALUE`) against the stylesheet, never per
 * call site: a clamp added next to one `blockVars(...)` call is a guard the next block will not have.
 */
export function blockVars(
    prefix: string,
    map: Record<string, string | number | undefined | null | false>
): React.CSSProperties {
    const out: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(map)) {
        if (value === undefined || value === null || value === "" || value === false) continue;
        // The NAME is ours (a literal at every call site); only the value is untrusted. Still checked,
        // because a name outside the contract is not a variable any stylesheet reads anyway.
        const name = `--wjs-${prefix}-${key}`;
        if (!/^--wjs-[A-Za-z0-9_-]+$/.test(name)) continue;
        const safe = safeCustomPropValue(name, String(value));
        if (safe === null) continue;
        out[name] = safe;
    }
    return out as React.CSSProperties;
}

/**
 * The `props.css` channel (the CSSData control), filtered to declarations the author is allowed to
 * make. Blocks spread it straight into their style attribute (`style={{ ...blockVars(…), ...css }}`),
 * which is the widest of the object-style channels: an arbitrary property name with an arbitrary
 * value. Re-exported from here so a block only ever has to import ONE module to build its style.
 *
 * NOTE THE ASYMMETRY WITH `blockVars` ABOVE, and why it is not an inconsistency: there the variable
 * NAME is a literal at the call site and only the value is author text, so any `--wjs-*` is fine;
 * here the author picks the name too, and a name is a way to reach a declaration — `wordjs-ui.css`
 * expands `--wjs-button-hover-transform` into `transform:`, which `AUTHOR_CSS_PROPS` excludes on
 * purpose. `safeStyleObject` therefore admits only the closed `AUTHOR_CSS_VARS` list on this channel
 * (see safeStyle.ts).
 */
export const safeCss = (css: unknown): React.CSSProperties =>
    safeStyleObject(css, AUTHOR_CSS_PROPS) as React.CSSProperties;

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
