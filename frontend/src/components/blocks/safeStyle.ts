import { STYLE_SECURITY, TEMPLATE_CONTRACT, THEME_CONTRACT, URL_SANITIZATION } from "@/generated/visual-contract.generated";

const URL_STRIPPED_CONTROLS = new RegExp(URL_SANITIZATION.stripControlsPattern, "g");
const NAVIGATION_PROTOCOLS = new Set(URL_SANITIZATION.navigationSchemes.map((scheme) => `${scheme}:`));

/**
 * THE ONE CRITERION FOR "IS THIS A CSS DECLARATION THE AUTHOR IS ALLOWED TO EMIT".
 *
 * Style does NOT only travel as HTML. It also travels as a JSON OBJECT — `props.css` (the CSSData
 * control), `props.look` (Appearance) and every value handed to `blockVars` — which React turns into
 * a `style` attribute. React escapes `<`/`&` in a style VALUE but it does NOT escape `;`, so a single
 * saved prop such as
 *
 *     css.color = "red;position:fixed;inset:0;z-index:2147483647;background:#fff url(https://x/y.png)"
 *
 * emitted a full-screen, attacker-controlled overlay served from the site's own origin, plus an
 * IP/User-Agent beacon through the background `url()`. Not XSS — no script runs and no cookie leaves —
 * but phishing hosted on the victim's domain, reachable by any account that can publish.
 *
 * The criterion below is NOT new: `lib/sanitize.ts` has applied exactly this idea (an allowlist of
 * property names + a value pattern that rejects `url(`, `expression`, `@import` and the
 * position/overlay tricks) to the `style` attribute of the INNER html of the very same `<div>` since
 * the rich-text editor shipped. What was missing is that the OBJECT channel feeding that same div's
 * container style went through nothing at all. This module is that guard, extracted so there is ONE
 * implementation and every channel passes through it:
 *
 *   · write boundary  — `backend/src/core/sanitize-meta.ts` (mirror, see its header) cleans the tree
 *                       BEFORE it is stored, so `_puck_data` on disk is already safe;
 *   · emission        — `appearanceToStyle` (blockShell.ts) and `blockVars` (blockVars.ts) filter
 *                       again on the way out, the same way `safeNavHref` is applied twice.
 *
 * PURE AND DEPENDENCY-FREE ON PURPOSE. `blockShell.ts` is imported by the PUBLIC server renderer and
 * declares "no hooks, no React runtime"; pulling `lib/sanitize.ts` (DOMPurify + sanitize-html) in
 * through it would break that. `lib/sanitize.ts` imports the value criterion FROM here instead, which
 * is the only direction that cannot create a cycle.
 *
 * WHAT THIS MODULE DELIBERATELY DOES **NOT** STOP — a remote `url()`.
 * `safeCssUrl` accepts any `http(s)` origin, so a background image may point at another host, and the
 * public page will fetch it on every visit (the CSP allows it: `img-src 'self' data: blob: https:`,
 * next.config.ts). That request carries the visitor's IP and User-Agent to that host. This is ACCEPTED
 * FUNCTIONALITY, not an oversight: a remote background/hero image (a CDN, a stock host, an image the
 * author does not want to re-upload) is a normal thing for an author to want, the media library itself
 * stores absolute URLs for externally hosted items, and the write boundary
 * (backend/src/core/sanitize-meta.ts) makes the same call. What is refused is everything that turns
 * that fetch into something else: a non-http(s) scheme, an authority-relative spelling, and any
 * character that could close the `url()` token or the declaration around it. If an install wants
 * first-party-only assets, that is a SETTING to add here (and in the write boundary at the same time),
 * not a silent difference between the two executable consumers of this generated policy.
 */

/**
 * Property names an AUTHOR may choose. Closed list, and deliberately the exact key set of the
 * `CSSData` interface (components/blocks/CSSControls.tsx) — i.e. what the editor's CSS control can
 * actually produce. `position`, `inset`, `zIndex` and friends are absent BECAUSE they are absent
 * there: no control emits them, so a saved page that carries one was not written by the editor.
 */
export const AUTHOR_CSS_PROPS: ReadonlySet<string> = new Set(STYLE_SECURITY.authorProperties);

/**
 * What the SHELL itself builds (`appearanceToStyle` + its overlay). A superset of the author list:
 * these declarations are written by our own code from an Appearance spec, so the property NAME is
 * ours and only the interpolated VALUE is hostile. Kept separate from AUTHOR_CSS_PROPS precisely so
 * that `position`/`inset`/`pointerEvents` stay unreachable from `props.css`.
 */
export const SHELL_CSS_PROPS: ReadonlySet<string> = new Set([
    ...AUTHOR_CSS_PROPS,
    "background", "backgroundRepeat", "backgroundAttachment",
    "marginInline", "maxWidth",
    "position", "inset", "pointerEvents",
]);

/** `--wjs-*` custom properties: the per-block variable contract (see blockVars.ts). */
const CUSTOM_PROP = new RegExp(THEME_CONTRACT.tokens.namePattern);

export function isSafeCustomPropertyName(value: unknown): value is string {
    return typeof value === "string" && CUSTOM_PROP.test(value);
}

/**
 * CUSTOM PROPERTIES AN **AUTHOR** MAY NAME. Closed LIST, not a pattern — and that difference is the
 * whole point.
 *
 * A custom property is not a declaration, it is a value that a STYLESHEET later expands into one, and
 * `wordjs-ui.css` expands `--wjs-*` tokens inside declarations this file deliberately keeps out of
 * `AUTHOR_CSS_PROPS`. The clearest one is `transform`:
 *
 *     .wjs-block-button__link:hover { transform: var(--wjs-button-hover-transform, scale(1.03)) }
 *
 * and `ButtonBlock` spreads `safeCss(css)` onto that very `<a>`. So while any `--wjs-*` name was
 * accepted here, `props.css = { "--wjs-button-hover-transform": "scale(200)" }` passed every check —
 * no `;{}<>\@`, no `url(` — and on hover blew the anchor up to cover the viewport: the same
 * "whole surface clickable to the attacker's destination" the audit described, rebuilt out of a value
 * instead of a declaration. Guarding the property NAME while the payload travels in a variable the
 * stylesheet expands is exactly the check-one-thing-use-another shape this criterion exists to close.
 *
 * The editor's CSS control cannot produce a custom property AT ALL (`CSSData`, CSSControls.tsx,
 * declares none), so the author channel needs no pattern. What stays is this list, and every name on
 * it satisfies one testable invariant: **wordjs-ui.css consumes it only inside declarations whose
 * property is in `AUTHOR_CSS_PROPS`** — i.e. re-setting it can never reach a declaration the author
 * could not have written directly. `__tests__/authorCssVars.test.tsx` scans the real stylesheet and
 * fails if a name here stops satisfying it, so adding one is a decision the test has to agree with.
 *
 * The SHELL channel is not affected: `appearanceToStyle` builds `--wjs-hover-amt`, `--wjs-r-padY`, …
 * from literals in our own code, so there the NAME is ours and any `--wjs-*` is admitted (see the
 * `customProps` parameter of `safeStyleObject`).
 */
export const AUTHOR_CSS_VARS: ReadonlySet<string> = new Set(STYLE_SECURITY.authorCustomProperties);

/**
 * ══ THE CLASS ═════════════════════════════════════════════════════════════════════════════════
 * A CUSTOM PROPERTY IS A DECLARATION SOMEBODY ELSE WRITES. Any block prop whose value ends up in a
 * `--wjs-*` variable is free text landing inside whatever declaration `wordjs-ui.css` expands that
 * variable into — and the value criterion above only rejects PUNCTUATION (`;{}<>\@`, `url(`), so
 * every well-formed CSS token for that declaration passes. `AUTHOR_CSS_VARS` closes the channel
 * where the author picks the NAME (`props.css`); it does nothing for the channel where the name is
 * a literal at the call site and only the VALUE is the author's — which is `blockVars`, i.e. ~174
 * variable names across every block.
 *
 * The first member found was the button (`--wjs-button-hover-transform`, reachable through
 * `props.css`). Closing that one by name left its sibling wide open: `PricingTableBlock` passes the
 * FREE-TEXT field `highlightScale` into `--wjs-pricing-highlight-scale`, and the stylesheet does
 *
 *     .wjs-block-pricing__plan--highlighted { transform: scale(var(--wjs-pricing-highlight-scale, 1.02)) }
 *
 * so `highlightScale = "200"` blows an OPAQUE plan — containing an author-controlled `<a href>` —
 * over the whole viewport, and `"2) rotate(45deg"` closes the `scale()` token and appends a second
 * function. Same damage as the audit's overlay, no `;` anywhere, reachable from the editor panel
 * with an author account.
 *
 * WHY THESE TWO TABLES AND NOT N GUARDS AT N CALL SITES. Clamping `highlightScale` in blocks.tsx
 * would fix the example; the next block that feeds a variable into a geometry declaration reopens
 * it in silence. So the rule is stated against the SINK:
 *
 *   · `REVIEWED_VAR_DECLARATIONS` — declarations outside `AUTHOR_CSS_PROPS` that a variable may
 *     reach with only the value criterion, because their value cannot move or resize anything
 *     beyond the block's own box (a colour, a track list, a fit keyword…).
 *   · `NARROWED_VAR_VALUE` — variables that reach a declaration which CAN (today: `transform`, and
 *     the bare numbers the stylesheet drops inside `scale()`/`calc()` of one). Their value is not
 *     filtered, it is PARSED and clamped into a shape with bounded magnitude.
 *
 * `blockStyleInjection.test.tsx` derives, from the real call sites and every stylesheet in the
 * tree, which declaration each author-emittable variable actually reaches, and fails when one lands
 * somewhere that is neither reviewed nor narrowed. A NEW block, a NEW variable or a NEW rule in the
 * stylesheet therefore has to pass through this decision instead of quietly extending the surface.
 */
export const REVIEWED_VAR_DECLARATIONS: ReadonlySet<string> = new Set(STYLE_SECURITY.reviewedVariableDeclarations);

/**
 * ══ THE SECOND SINK ═══════════════════════════════════════════════════════════════════════════
 * A CLASS NAME IS ALSO A WAY TO WRITE A DECLARATION, and it reaches the same element.
 *
 * Everything above bounds the `style` attribute. It says nothing about `class`, and the two are the
 * same sink: `frontend/src/app/globals.css` (imported by app/layout.tsx, i.e. EVERY public route)
 * compiles a Tailwind utility bundle that contains `.fixed{position:fixed}`, `.inset-0`, `.z-50`,
 * `.w-full`, `.h-full`, `.bg-white`. So a block that writes
 *
 *     className={`button-variant-${variant}`}
 *
 * with `variant = "x fixed inset-0 z-50 w-full h-full bg-white"` emits SIX extra classes — React
 * does not escape a space in an attribute value — and turns an `<a href>` whose destination the same
 * author controls into a full-screen overlay. Zero CSS, no `props.css`, no custom property: exactly
 * the damage the style channel was closed against, rebuilt out of the attribute next door.
 *
 * THE BOUND IS STRUCTURAL, not a denylist of utility names:
 *  · A CLASS IS A SINGLE TOKEN. The tail grammar admits no whitespace, so author text can never
 *    become a SECOND class — which is the only way to reach a rule we did not name.
 *  · THE PREFIX IS ALWAYS OURS. `prefix` is a literal in our source (`"button-variant-"`, `"fa-"`,
 *    `"wjs-hover-"`), and the return value always starts with it. A bare author token can therefore
 *    never BE a utility: `fixed` becomes `fa-fixed`, which no stylesheet defines. This is what a
 *    grammar alone would miss — a whole-token channel like `<i className={`fa-solid ${icon}`}/>`
 *    passes any tidy `[a-z-]+` check and `icon="fixed"` still lands `position:fixed` on the element.
 *
 * A value that already carries the prefix is normalised rather than double-prefixed (`fa-check` →
 * `fa-check`), the same way `bc()` normalises an already-prefixed block name. A rejected value
 * returns null, which `cx()` drops — so the element keeps its own classes and falls back to the
 * stylesheet, exactly like a rejected declaration does.
 */
const CLASS_TOKEN_PREFIX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-$/;
const CLASS_TOKEN_TAIL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_CLASS_TOKEN_TAIL = STYLE_SECURITY.maxClassTokenTail;

export function safeClassToken(prefix: string, raw: unknown): string | null {
    // The prefix comes from our own source at every call site. Verified anyway: a prefix that is not
    // a well-formed, hyphen-terminated token stops guaranteeing the "never a bare utility" half.
    if (!CLASS_TOKEN_PREFIX.test(prefix)) return null;
    if (typeof raw !== "string" && typeof raw !== "number") return null;
    let tail = String(raw).trim().toLowerCase();
    if (tail.startsWith(prefix)) tail = tail.slice(prefix.length);
    if (tail.length > MAX_CLASS_TOKEN_TAIL || !CLASS_TOKEN_TAIL.test(tail)) return null;
    return prefix + tail;
}

/**
 * THE THEME'S OWN HOOK ON A CONTAINER — the one class channel where the prefix cannot be ours.
 *
 * `SectionBlock`/`GridBlock`/`FlexRowBlock`/`ColumnsBlock` accept a `className` so a theme template
 * can hang its own rule on a container (`hero-scanline`, `franja-estado`, `celda-ancha`, `glow-panel`
 * ship today). Those names belong to the THEME's stylesheet, so `safeClassToken` does not apply: there
 * is no prefix of ours to demand. The write boundary
 * (`backend/src/core/template-validate.ts` and `lib/templateData.ts`, generated from one source) bounds the
 * SHAPE — at most 3 tokens of `[a-z][a-z0-9-]{0,39}` — and that shape is kept here unchanged.
 *
 * SHAPE IS NOT ENOUGH, and this was live: `className = "fixed inset-0 z-50"` is three perfectly
 * well-formed tokens, the Tailwind bundle on every public route defines all three, and the rendered
 * `<section class="wjs-block-section wp-block-section fixed inset-0 z-50">` is a viewport-covering
 * overlay wrapping whatever links the same author put inside it. Verified by rendering the real
 * block. `className` has no editor control, but `_puck_data` is writable through the REST API, and a
 * STRUCTURAL prop passes the write-side sanitizer untouched by design.
 *
 * WHAT IS REFUSED IS A CLOSED CSS VOCABULARY, NOT A LIST OF PAYLOADS. Covering the page requires
 * leaving normal flow, and the complete set of values of the CSS `position` property is
 * static/relative/absolute/fixed/sticky — Tailwind spells each of them as the bare word. All five are
 * refused (the two in-flow ones cost a theme nothing: it can write `position` in its own rule, under
 * its own class, where it is the theme's decision and not saved content's). With the element pinned
 * in flow, `inset-*`/`z-*`/`w-full` are inert, so no size or offset family has to be guessed at.
 *
 * NOT DERIVED, AND SAID OUT LOUD: nothing here enumerates the utility bundle. A future utility that
 * escapes flow WITHOUT the `position` property — Tailwind has none today — would not be caught by
 * this predicate, and no test in the tree can derive that set (Tailwind v4 emits on demand at build
 * time and the compiled bundle is not in the repo). What the gate does cover is that no NEW class
 * channel appears without a decision: see `blockStyleInjection.test.tsx`.
 */
export const CSS_POSITION_KEYWORDS: ReadonlySet<string> = new Set(STYLE_SECURITY.forbiddenPositionKeywords);
const EXTRA_CLASS_TOKEN = new RegExp(TEMPLATE_CONTRACT.classList.tokenPattern);
export const MAX_EXTRA_CLASS_TOKENS = TEMPLATE_CONTRACT.classList.maxTokens;

export function safeExtraClassList(value: unknown): string | undefined {
    if (typeof value !== "string" || value === "" || value !== value.trim()) return undefined;
    // A single space, so a tab/newline/double space fails the token pattern instead of splitting away.
    const tokens = value.split(" ");
    if (tokens.length > MAX_EXTRA_CLASS_TOKENS) return undefined;
    // The SHAPE bound (3 tokens of EXTRA_CLASS_TOKEN) is this channel's own — it is the shape the
    // write boundary already declares for a template `className`. The SAFETY bound is not this
    // channel's: it is `isSafeClassToken`, the one criterion every class channel shares.
    if (!tokens.every((t) => EXTRA_CLASS_TOKEN.test(t) && isSafeClassToken(t))) return undefined;
    return value;
}

/* ── THE SAME ATTRIBUTE, THE OTHER SINK: `class` INSIDE RICH HTML ─────────────────────────────────
 * `safeExtraClassList` above bounds `class` where it arrives as a structural PROP. It is not the only
 * way author text becomes a class attribute, and bounding only that one left the identical overlay
 * reachable through the sibling channel — rich HTML painted with `dangerouslySetInnerHTML`:
 *
 *     <div class="fixed inset-0 z-50 w-full h-full bg-white"><a href="https://evil/login">…</a></div>
 *
 * saved in a post body, a Puck HTML field, a widget, an expanded shortcode — or in an ANONYMOUS
 * COMMENT, which `backend/src/core/formatting.ts` sanitizes and `admin/comments/page.tsx` then paints
 * inside the moderation queue. That last one is the worst blast radius in the tree: the reader is the
 * account with the capabilities worth phishing, and the writer needs no account at all.
 *
 * ONE CRITERION, FOUR COPIES. `isSafeClassToken` is the whole safety rule and every channel calls it:
 *   · this module                        — the block/prop channel (safeExtraClassList, above);
 *   · frontend/src/lib/sanitize.ts       — the READ boundary, both paths (DOMPurify hook + the SSR
 *                                          sanitize-html config), i.e. every dangerouslySetInnerHTML;
 *   · backend/src/core/sanitize-meta.ts  — the WRITE boundary for `_puck_data` (mirror, see header);
 *   · backend/src/core/formatting.ts     — the WRITE boundary for post_content AND comments.
 * Read boundary AND write boundary, because the readers are not all ours: a theme's Handlebars
 * template renders `{{{content}}}` straight out of the column without passing through lib/sanitize.ts,
 * and an exporter/plugin renderer reads the stored value directly. A value that is clean on disk and
 * a render that refuses to paint a bad one are two different guarantees and both are needed.
 *
 * WHAT IS REFUSED IS THE SAME CLOSED CSS VOCABULARY as above — the five values of the `position`
 * property — and NOT a shape. Rich text is not a structural prop: it legitimately carries whatever
 * classes an imported WordPress body, a theme, a widget or a pasted embed brought with it
 * (`wp-block-image`, `alignwide`, `size-large`, `wp-image-42`, `md:flex`, `w-1/2`). Demanding a tidy
 * grammar here would silently delete those, so the only thing demanded is that a token is not
 * whitespace-bearing, not absurdly long, and not one of the five keywords. With the element pinned in
 * normal flow, `inset-*`/`z-*`/`w-full` are inert — the same argument, unchanged.
 *
 * PER TOKEN, NOT PER ATTRIBUTE. A rejected token is dropped and its siblings survive; a rejected
 * `className` PROP is dropped whole. The difference is deliberate: a prop is one authored decision,
 * a document body is thousands, and nuking a whole page's formatting over one bad token would be a
 * worse outcome than the thing being prevented. The guarantee is identical either way — no surviving
 * token can be a `position` keyword.
 *
 * THE SAME LIMITATION, SAID AGAIN: nothing here enumerates the utility bundle. A future utility that
 * escapes flow WITHOUT the `position` property would not be caught. What the gate covers is that no
 * new emitter of a class attribute appears without a decision — see
 * `frontend/src/components/blocks/__tests__/classAttributeChannel.test.tsx`, which DERIVES the emitter
 * population by scanning every sanitizer configuration in both packages rather than listing them.
 */
export const MAX_CLASS_ATTR_TOKEN = STYLE_SECURITY.maxClassAttributeToken;

/**
 * A UTILITY IS NOT ALWAYS SPELLED AS THE BARE WORD, and refusing only the bare word was not enough.
 * Tailwind emits ON DEMAND, so the bundle contains exactly the spellings THIS repo's own source uses —
 * and it uses variant-prefixed ones. `focus:absolute` ships (the skip link in PublicLayoutShell.tsx),
 * as do `lg:sticky`, `md:static`, `lg:static`, `md:relative`. `<a href="…" class="focus:absolute
 * focus:top-4 focus:z-[100] w-full h-full bg-white">` is the same overlay, armed by a tab press, and a
 * predicate comparing the WHOLE token to five words waves every one of them through.
 *
 * So the token is NORMALISED to the utility a stylesheet would act on before it is judged: variants
 * (`focus:`, `lg:`, `group-hover:`, and any chain of them) and both spellings of the importance marker
 * (`!fixed`, `fixed!`) are stripped, and the ARBITRARY-PROPERTY form `[position:fixed]` — which sets
 * the property without naming a utility at all — is refused outright.
 *
 * This is still the closed CSS vocabulary and still not a list of utilities: what grew is the set of
 * SPELLINGS of the same five values, not the set of names. Nothing legitimate is lost — a class whose
 * final segment is exactly `fixed`/`absolute`/`sticky`/`relative`/`static` is a position utility in
 * every framework that has one, and `bg-fixed`, `is-fixed`, `wp-block-fixed` all keep working because
 * the comparison is to the whole segment, not a suffix.
 */
const ARBITRARY_POSITION = /\[\s*position\s*:/;

/**
 * THE OTHER HALF, AND IT IS THE HALF A KEYWORD LIST CANNOT SEE: Tailwind is not the only stylesheet
 * on the page. `backend/public/css/wordjs-ui.css` — the framework sheet EVERY install serves — binds
 * `position` to ordinary class NAMES, and three of them are the utility spelled out longhand:
 *
 *     .position-fixed  { position: fixed }      .position-absolute { position: absolute }
 *     .position-sticky { position: sticky }     .modal { position: fixed }   .dropdown-menu { … }
 *
 * so `class="position-fixed inset-0 z-50 w-full h-full bg-white"` rebuilt the overlay verbatim, with
 * a token that is not a `position` keyword by any normalisation. Refusing five words was refusing the
 * TAILWIND spelling of the vocabulary and nothing else.
 *
 * THE POPULATION IS THE CONSUMERS, NOT THE PRODUCERS. Every name below was DERIVED by parsing every
 * stylesheet that ships in this repository and taking every class named in any rule whose body sets
 * `position: fixed|absolute|sticky` — including the classes of a compound or descendant selector,
 * because the author writes the whole attribute and can supply both halves (`class="modal show"`),
 * and on both elements of a descendant pair. The gate re-derives this set from those same stylesheets
 * and fails if it grows, so a new CSS rule cannot quietly open the channel again.
 *
 * THE LIMIT, STATED: a theme INSTALLED LATER can bind `position` to any name it likes, and no test in
 * this repo can enumerate a stylesheet that is not in it. What that costs is bounded by who does it —
 * installing a theme is an administrator action, while writing a comment is not — and it is the same
 * limitation the Tailwind half already carries. It is not closed here; it is stated.
 */
const POSITION_BINDING_BASE: readonly string[] = STYLE_SECURITY.positionBindingClasses;

/**
 * The historical alias of every block name is DERIVED, not typed: the framework sheet matches either
 * prefix, so refusing the own identity while admitting its twin would refuse nothing at all. Written
 * this way for a second reason — `blockClassEmission.test.tsx` fails any `wp-block-…` LITERAL in this
 * directory, and it is right to: pairing the two prefixes is `bc()`'s rule and there must be exactly
 * one copy of it. The prefixes cannot be imported from blockVars.ts (it re-exports from here, so the
 * import would be a cycle), which is why they appear as bare strings.
 */
const OWN_BLOCK_PREFIX = STYLE_SECURITY.ownBlockPrefix;
const LEGACY_BLOCK_PREFIX = STYLE_SECURITY.legacyBlockPrefix;
export const POSITION_BINDING_CLASSES: ReadonlySet<string> = new Set(
    POSITION_BINDING_BASE.flatMap((name) => (
        name.startsWith(OWN_BLOCK_PREFIX)
            ? [name, LEGACY_BLOCK_PREFIX + name.slice(OWN_BLOCK_PREFIX.length)]
            : [name]
    )),
);

/** THE ONE CRITERION. Every class channel in either package answers this question and no other. */
export function isSafeClassToken(token: unknown): boolean {
    if (typeof token !== "string") return false;
    if (token === "" || token.length > MAX_CLASS_ATTR_TOKEN) return false;
    // A token cannot contain whitespace by construction (the callers split on it); checked anyway so
    // the predicate is true on its own terms and cannot be handed a whole attribute value by mistake.
    if (/\s/.test(token)) return false;
    // Case-insensitively throughout: `.fixed` matches `class="FIXED"` in quirks mode, and no
    // legitimate token is lost by refusing both spellings.
    const lower = token.toLowerCase();
    if (ARBITRARY_POSITION.test(lower)) return false;
    if (POSITION_BINDING_CLASSES.has(lower)) return false;
    const utility = lower.slice(lower.lastIndexOf(":") + 1).replace(/^!+/, "").replace(/!+$/, "");
    return !CSS_POSITION_KEYWORDS.has(utility);
}

/**
 * A whole `class` ATTRIBUTE value, filtered token by token. Returns "" when nothing survives, which
 * every caller turns into "remove the attribute" — an empty `class=""` is not wrong, but an attribute
 * that is not there is what the element would have had if the author had never written it.
 */
export function safeClassAttribute(value: unknown): string {
    if (typeof value !== "string" || value === "") return "";
    return value.split(/\s+/).filter((t) => isSafeClassToken(t)).join(" ");
}

/** Bare number, clamped: the shape of a variable the stylesheet drops INSIDE a function call. */
const clampedNumber = (min: number, max: number) => (raw: string): string | null => {
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) return null;
    return String(Math.min(max, Math.max(min, n)));
};

const TRANSFORM_POLICY = STYLE_SECURITY.transformPolicy;
const TRANSLATE_MAX: Readonly<Record<string, number>> = TRANSFORM_POLICY.translateMax;
const TRANSLATE_UNIT = new RegExp(`^(-?\\d*\\.?\\d+)(${Object.keys(TRANSLATE_MAX).join("|")})$`);

/**
 * A bare LENGTH, clamped per unit: the shape of a spacing token the stylesheet drops inside a
 * `calc()` that a `transform:` then consumes. `0` with no unit is admitted because that is how a
 * length is spelled when it is zero; everything else must carry a unit we can bound.
 */
const boundedLength = (max: Record<string, number>) => (raw: string): string | null => {
    const v = raw.trim().toLowerCase();
    if (/^-?0+(?:\.0+)?$/.test(v)) return "0";
    const units = Object.keys(max).map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const m = new RegExp(`^(-?\\d*\\.?\\d+)(${units.join("|")})$`).exec(v);
    if (!m) return null;
    const cap = max[m[2]];
    if (cap === undefined) return null;
    return `${Math.min(cap, Math.max(-cap, Number(m[1])))}${m[2]}`;
};
const boundedNonNegativeLength = (max: Record<string, number>) => (raw: string): string | null => {
    const value = boundedLength(max)(raw);
    return value !== null && !value.startsWith("-") ? value : null;
};

/**
 * A `transform` value, PARSED — not pattern-matched. `none`, or up to four of
 * `scale/scaleX/scaleY(n)`, `translateX/translateY(<len>)`, `rotate(<deg>)`, with scale and
 * translate clamped. Everything else (`matrix`, `perspective`, a bare `var(…)`, anything with text
 * outside the function tokens) is DROPPED, so the block falls back to the stylesheet's own value.
 */
const transformValue = (raw: string): string | null => {
    const v = raw.trim().replace(/\s+/g, " ");
    if (/^none$/i.test(v)) return "none";
    const parts = v.match(/[a-zA-Z]+\([^()]*\)/g);
    // Nothing may live OUTSIDE the function tokens — that is how `2) rotate(45deg` gets in.
    if (!parts || parts.join(" ") !== v || parts.length > TRANSFORM_POLICY.maxFunctions) return null;
    const out: string[] = [];
    for (const part of parts) {
        const m = /^([a-zA-Z]+)\(([^()]*)\)$/.exec(part)!;
        const fn = m[1].toLowerCase();
        const arg = m[2].trim();
        if (fn === "scale" || fn === "scalex" || fn === "scaley") {
            const n = clampedNumber(TRANSFORM_POLICY.scale.min, TRANSFORM_POLICY.scale.max)(arg);
            if (n === null) return null;
            out.push(`${fn === "scale" ? "scale" : fn === "scalex" ? "scaleX" : "scaleY"}(${n})`);
        } else if (fn === "translatex" || fn === "translatey") {
            const lm = TRANSLATE_UNIT.exec(arg);
            if (!lm) return null;
            const cap = TRANSLATE_MAX[lm[2]];
            const n = Math.min(cap, Math.max(-cap, Number(lm[1])));
            out.push(`${fn === "translatex" ? "translateX" : "translateY"}(${n}${lm[2]})`);
        } else if (fn === "rotate") {
            const rm = /^(-?\d*\.?\d+)deg$/.exec(arg);
            if (!rm) return null;
            out.push(`rotate(${rm[1]}deg)`);
        } else {
            return null;
        }
    }
    return out.join(" ");
};

/**
 * Variables whose value the stylesheet expands into `transform:` — the one declaration reachable
 * from a block variable that can move the element out of its own box and over the page.
 *
 * The list is written against the STYLESHEET, not against the call sites that exist today: every
 * `--wjs-*` name any stylesheet in the tree uses inside a `transform` declaration is here, so a
 * block that starts feeding one tomorrow is already narrowed rather than newly exposed. Some of them
 * are not a transform but a bare NUMBER or a LENGTH the stylesheet drops inside `scale()`/`calc()`,
 * and take that grammar instead — which is exactly the distinction a name-shaped rule
 * (`/-transform$/`) would have got wrong in both directions: `--wjs-card-title-transform` and
 * `--wjs-stats-label-transform` land in `text-transform`, which the author may write directly.
 *
 * THAT CLAIM IS NOW A GATE, NOT A COMMENT. It used to be prose, and prose drifts: the sweep that
 * checked it found the table 2 names short of the sheets (`--wjs-audio-marquee-gap` and its
 * fallback `--wjs-xl`, both inside the marquee keyframe's `translateX(calc(…))`). Neither had a
 * producer, so nothing was red — the promise "already narrowed before it has a producer" was simply
 * false where nobody looked. `blockStyleInjection.test.tsx` now DERIVES the `transform:` sink set
 * from every stylesheet in the repo and fails unless it is a subset of the keys below, producer or
 * no producer.
 */
type NarrowSpec =
    | { kind: "number"; min: number; max: number }
    | { kind: "transform" }
    | { kind: "length" | "non-negative-length"; max: Record<string, number> };

const narrowerFromSpec = (spec: NarrowSpec): ((raw: string) => string | null) => {
    if (spec.kind === "number") return clampedNumber(spec.min, spec.max);
    if (spec.kind === "transform") return transformValue;
    return spec.kind === "length" ? boundedLength(spec.max) : boundedNonNegativeLength(spec.max);
};

export const NARROWED_VAR_VALUE: ReadonlyMap<string, (raw: string) => string | null> = new Map(
    Object.entries(STYLE_SECURITY.narrowedVariables).map(([name, spec]) => [
        name,
        narrowerFromSpec(spec as NarrowSpec),
    ]),
);

/**
 * ONE custom-property value. THE ONLY WAY a `--*` value may be emitted, from any channel: the value
 * criterion first (punctuation, `url(`, the trailing `;`), then the narrowed grammar when the name
 * is one the stylesheet expands into a declaration the author could not write. Adding a check beside
 * this one instead of an entry to the table above is how the class reopened last time.
 */
export function safeCustomPropValue(name: string, raw: unknown): string | number | null {
    const value = safeCssValue(name, raw);
    if (value === null) return null;
    const narrow = NARROWED_VAR_VALUE.get(name);
    return narrow ? narrow(String(value)) : value;
}

/**
 * Values whose whole point is a URL: `backgroundImage`, plus any `--wjs-…-image` variable — the two
 * shapes blocks actually use (`--wjs-hero-bg-image`, `--wjs-posts-thumb-image`). Everywhere else a
 * `url(` is rejected outright, which is the same line the theme-token guard
 * (components/public/ThemeTokenOverlay) and the interaction engine already draw.
 */
export const URL_BEARING_PROP = new RegExp(STYLE_SECURITY.urlBearingPropertyPattern);

/**
 * Reject any declaration value that could smuggle a fetch, a script, or a second declaration.
 * `;` is the one that mattered: React does not escape it inside a style value, so ONE prop could
 * append arbitrary declarations. `{`/`}`/`@` close the door on a value that is really a rule block
 * or an `@import`; `<`/`>`/`\` on markup and escape sequences.
 *
 * EXPORTED because `lib/sanitize.ts` scrubs the inline `style` ATTRIBUTE of rich-text HTML with the
 * same criterion — one pattern, two channels. (That path splits on `;` before testing, so including
 * `;` here changes nothing for it.)
 */
export const UNSAFE_STYLE_VALUE = new RegExp(STYLE_SECURITY.unsafeValuePattern, "i");

/**
 * A URL that may be interpolated into a `url()` token — or null.
 *
 * Two independent requirements, both load-bearing:
 *  (a) AN ORIGIN. An absolute URL must be http(s); `data:`, `javascript:`, `file:` and friends have
 *      no origin we serve and are rejected. A value with no scheme at all is a path on THIS site,
 *      except for the two authority-relative spellings — `//host/x` and `/\host/x` (the URL parser
 *      treats `\` exactly like `/` for a special scheme) — which are REMOTE and are rejected. Same
 *      rule as `sameOriginPath()` in lib/sanitize.ts, restated here to keep this module
 *      dependency-free (see the header).
 *  (b) NOTHING THAT CAN CLOSE THE TOKEN. Quotes, parentheses, backslash and whitespace are refused
 *      before anything else, so neither the `url("…")` token nor the declaration around it can be
 *      escaped — the quoting below is then a second lock on an already-closed door, not the lock.
 * TAB/LF/CR are stripped first because the URL parser strips them BEFORE parsing: validating a string
 * the browser will never see is not a guard.
 */
export function safeCssUrl(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const clean = raw.replace(URL_STRIPPED_CONTROLS, "").trim();
    if (!clean) return null;
    if (/["'()\\\s<>;{}]/.test(clean)) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(clean)) {
        return /^\/[/\\]/.test(clean) ? null : clean;
    }
    try {
        const u = new URL(clean);
        if (!NAVIGATION_PROTOCOLS.has(u.protocol)) return null;
        return u.toString();
    } catch {
        return null;
    }
}

/**
 * One declaration value, NORMALISED — or null when the author may not emit it.
 *
 * Numbers pass through: they cannot carry a second declaration. A value that IS a `url()` survives
 * only on a URL-bearing property, only after `safeCssUrl`, and is re-emitted QUOTED rather than
 * interpolated bare.
 *
 * THE TRAILING SEMICOLON IS NORMALISED AWAY, NOT PUNISHED. Several of these fields are free text
 * where the author types CSS by hand (`shadow`, `width`, `radius`, the CSSControls inputs), and
 * ending a declaration with `;` is a universal habit. Rejecting `0 2px 8px rgb(0 0 0 / .2);` on
 * account of that `;` dropped the whole declaration and sent the block back to the theme's value with
 * no feedback anywhere — a sanitizer that silently eats legitimate input teaches authors to distrust
 * the editor. Only a TRAILING run of semicolons is stripped, so nothing that could actually append a
 * second declaration survives: `red;position:fixed;` still keeps an interior `;` after the strip and
 * is still rejected below.
 */
export function safeCssValue(prop: string, raw: unknown): string | number | null {
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== "string") return null;
    const v = raw.trim().replace(/[\s;]*;[\s;]*$/, "");
    if (!v) return null;
    const asUrl = /^url\(\s*(.*?)\s*\)$/i.exec(v);
    if (asUrl) {
        if (!URL_BEARING_PROP.test(prop)) return null;
        const inner = asUrl[1].replace(/^["']/, "").replace(/["']$/, "");
        const safe = safeCssUrl(inner);
        return safe === null ? null : `url("${safe}")`;
    }
    return UNSAFE_STYLE_VALUE.test(v) ? null : v;
}

/**
 * Filter a style OBJECT down to declarations the author is allowed to make. Key order is preserved
 * (it is CSS declaration order, and therefore significant); a rejected declaration is DROPPED, never
 * blanked, so the block falls back to the stylesheet instead of to an empty value.
 *
 * TWO NAME CHANNELS, TWO CRITERIA — they used to share one and only one of them needed it:
 *  · a normal property (`color`, `padding`, …) is checked against `allowed`;
 *  · a CUSTOM property (`--…`) is checked against `customProps`, which is a closed LIST for author
 *    data (`AUTHOR_CSS_VARS`) and `"any"` (i.e. any well-formed `--wjs-*`) only where the name comes
 *    from our own code. `allowed` is never consulted for a `--` name — no property set contains one —
 *    so the value that decides and the value that is emitted are the same string, `prop`.
 *
 * `customProps` DEFAULTS OFF THE `allowed` SET on purpose: `appearanceToStyle` (blockShell.ts) calls
 * `safeStyleObject(s, SHELL_CSS_PROPS)` with two arguments and must keep emitting the shell's own
 * variables, while `safeCss` (blockVars.ts) passes author data with `AUTHOR_CSS_PROPS` and must not.
 * A caller that hands over a COPY of SHELL_CSS_PROPS gets the strict author policy — fail closed.
 */
export function safeStyleObject(
    style: unknown,
    allowed: ReadonlySet<string> = AUTHOR_CSS_PROPS,
    customProps: ReadonlySet<string> | "any" = allowed === SHELL_CSS_PROPS ? "any" : AUTHOR_CSS_VARS
): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    if (!style || typeof style !== "object" || Array.isArray(style)) return out;
    for (const [prop, raw] of Object.entries(style as Record<string, unknown>)) {
        const named = prop.startsWith("--")
            ? customProps === "any"
                ? CUSTOM_PROP.test(prop)
                : customProps.has(prop)
            : allowed.has(prop);
        if (!named) continue;
        // A `--` name goes through the custom-property chokepoint (value criterion + the narrowed
        // grammar for the variables the stylesheet expands into `transform:`) — BOTH channels, so the
        // shell cannot emit a shape the author channel refuses either.
        const value = prop.startsWith("--") ? safeCustomPropValue(prop, raw) : safeCssValue(prop, raw);
        if (value !== null) out[prop] = value;
    }
    return out;
}
