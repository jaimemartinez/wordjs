/**
 * WordJS — shared meta sanitizer.
 *
 * The Puck page tree (_puck_data) is stored verbatim in post_meta and rendered as HTML at many
 * independent public sites, so it MUST be sanitized on every write path. This logic originally lived
 * in routes/posts.ts; it is extracted here so non-route write paths (e.g. the WXR importer) sanitize
 * meta through the EXACT same code instead of bypassing it. Behavior is intentionally identical to the
 * former posts.ts implementation.
 */

import { canonicalMetaKey } from './protected-meta';

const sanitizeHtml = require('sanitize-html');
import {
    PROPERTY_SANITIZERS,
    HTML_SANITIZATION,
    STYLE_SECURITY,
    TEMPLATE_CONTRACT,
    URL_SANITIZATION,
} from '../generated/visual-contract.generated';
const URL_STRIPPED_CONTROLS = new RegExp(URL_SANITIZATION.stripControlsPattern, 'g');
const NAVIGATION_PROTOCOLS = new Set<string>(
    URL_SANITIZATION.navigationSchemes.map((scheme: string) => `${scheme}:`),
);
const BLOCKED_PUCK_SCHEME = new RegExp(`^(?:${URL_SANITIZATION.blockedPuckSchemes.join('|')}):`, 'i');

/* ── STRUCTURAL BOUNDS ───────────────────────────────────────────────────────────────────────────
 * express.json accepts up to 10 MB because a large page tree is a legitimate document. Byte size,
 * however, says nothing about SHAPE: a tiny JSON value can nest thousands of objects. The Puck
 * sanitizer and Post.updateMeta's JSON.stringify are recursive, so ANY structured metadata key could
 * previously turn a valid request into `RangeError: Maximum call stack size exceeded`.
 *
 * Validate with an EXPLICIT stack before any recursive consumer sees the tree. The node ceiling also
 * bounds sanitizer work independently of how compactly the JSON was written. Both limits are far above
 * a realistic Verso/plugin document (ordinary trees stay below depth 20), but finite by construction.
 */
const MAX_META_VALUE_DEPTH = 128;
const MAX_META_VALUE_NODES = 100_000;

class MetaValueComplexityError extends Error {
    code: string;
    reason: 'depth' | 'nodes' | 'cycle';

    constructor(reason: 'depth' | 'nodes' | 'cycle') {
        const detail = reason === 'depth'
            ? `more than ${MAX_META_VALUE_DEPTH} nested levels`
            : reason === 'nodes'
                ? `more than ${MAX_META_VALUE_NODES} values`
                : 'a cyclic object graph';
        super(`Metadata value is too complex: ${detail}.`);
        this.name = 'MetaValueComplexityError';
        this.code = 'META_VALUE_TOO_COMPLEX';
        this.reason = reason;
    }
}

/**
 * Bound an untrusted structured metadata value without recursion. Cycles cannot arrive through JSON, but rejecting
 * them here keeps direct/internal callers from handing JSON.stringify a graph it cannot serialize.
 */
function assertMetaValueWithinLimits(root: any): void {
    let nodes = 1;
    const activePath = new WeakSet<object>();
    const stack: Array<{ value: any; depth: number; leaving?: boolean }> = [{ value: root, depth: 0 }];

    while (stack.length > 0) {
        const { value, depth, leaving } = stack.pop()!;
        if (!value || typeof value !== 'object') continue;
        if (leaving) {
            activePath.delete(value);
            continue;
        }
        if (activePath.has(value)) throw new MetaValueComplexityError('cycle');
        activePath.add(value);
        stack.push({ value, depth, leaving: true });

        for (const child of Object.values(value)) {
            nodes++;
            if (nodes > MAX_META_VALUE_NODES) throw new MetaValueComplexityError('nodes');
            if (child && typeof child === 'object') {
                const childDepth = depth + 1;
                if (childDepth > MAX_META_VALUE_DEPTH) throw new MetaValueComplexityError('depth');
                stack.push({ value: child, depth: childDepth });
            }
        }
    }
}

function isMetaValueComplexityError(error: any): boolean {
    return Boolean(error && error.code === 'META_VALUE_TOO_COMPLEX');
}

/* ── THE CLASS CHANNEL ────────────────────────────────────────────────────────────────────────────
 * MIRROR of `frontend/src/components/blocks/safeStyle.ts` (see the STYLE CHANNEL header below for why
 * this package mirrors rather than imports). Read that module's "THE SAME ATTRIBUTE, THE OTHER SINK"
 * comment for the full argument; the short version is that `class="fixed inset-0 z-50 w-full h-full
 * bg-white"` around an author-chosen `<a href>` is a viewport-covering phishing overlay served from
 * the site's own origin, every one of those utilities ships in the Tailwind bundle on every route,
 * and this config used to store the attribute verbatim.
 *
 * WHAT IS REFUSED is the closed set of `position` values, per TOKEN — not a shape, because rich HTML
 * legitimately carries whatever classes an imported WordPress body or a theme brought with it.
 *
 * BOTH BOUNDARIES, ON PURPOSE. The read boundary (frontend/src/lib/sanitize.ts) filters too, but the
 * readers of this stored value are not all ours: a theme's Handlebars template renders `{{{content}}}`
 * straight out of the column, and the exporter, the REST API and a plugin renderer read the tree
 * directly. The same argument wave 4 made for the `--wjs-*` copy here: two boundaries that disagree
 * are worse than one.
 */
const CSS_POSITION_KEYWORDS: ReadonlySet<string> = new Set(STYLE_SECURITY.forbiddenPositionKeywords);
const MAX_CLASS_ATTR_TOKEN: number = STYLE_SECURITY.maxClassAttributeToken;

/**
 * A utility is not always spelled as the bare word. Tailwind emits ON DEMAND, so the bundle contains
 * exactly the spellings the frontend's own source uses — and `focus:absolute` (the skip link),
 * `lg:sticky`, `md:static` and `md:relative` all ship. The token is therefore normalised to the
 * utility a stylesheet would act on — variants and both importance markers stripped — before it is
 * judged, and the arbitrary-property form `[position:fixed]` is refused outright. Same closed
 * vocabulary; what grew is the set of SPELLINGS of those five values. See safeStyle.ts for the full
 * argument — this is its mirror and the gate drives both copies.
 */
const ARBITRARY_POSITION = /\[\s*position\s*:/;

/**
 * Tailwind is not the only stylesheet on the page. `backend/public/css/wordjs-ui.css` — the framework
 * sheet every install serves — binds `position` to ordinary class NAMES (`.position-fixed`, `.modal`,
 * `.dropdown-menu`, …), so refusing the five keywords was refusing the Tailwind SPELLING of the
 * vocabulary and nothing else. Every name below was DERIVED by parsing every stylesheet that ships in
 * this repository; the gate re-derives it and fails if it grows. Mirror of safeStyle.ts — read that
 * copy for the full argument and for the limitation (a theme installed later can bind any name).
 */
const POSITION_BINDING_BASE: readonly string[] = STYLE_SECURITY.positionBindingClasses;

/** The historical alias of every block name is DERIVED, not typed — see the frontend copy. */
const OWN_BLOCK_PREFIX: string = STYLE_SECURITY.ownBlockPrefix;
const LEGACY_BLOCK_PREFIX: string = STYLE_SECURITY.legacyBlockPrefix;
const POSITION_BINDING_CLASSES: ReadonlySet<string> = new Set(
    POSITION_BINDING_BASE.flatMap((name) => (
        name.startsWith(OWN_BLOCK_PREFIX)
            ? [name, LEGACY_BLOCK_PREFIX + name.slice(OWN_BLOCK_PREFIX.length)]
            : [name]
    )),
);

/** THE ONE CRITERION. Mirror of safeStyle.ts's `isSafeClassToken`; the gate drives both copies. */
function isSafeClassToken(token: unknown): boolean {
    if (typeof token !== 'string') return false;
    if (token === '' || token.length > MAX_CLASS_ATTR_TOKEN) return false;
    if (/\s/.test(token)) return false;
    const lower = token.toLowerCase();
    if (ARBITRARY_POSITION.test(lower)) return false;
    if (POSITION_BINDING_CLASSES.has(lower)) return false;
    const utility = lower.slice(lower.lastIndexOf(':') + 1).replace(/^!+/, '').replace(/!+$/, '');
    return !CSS_POSITION_KEYWORDS.has(utility);
}

/** A whole `class` ATTRIBUTE value, filtered token by token. '' means "remove the attribute". */
function safeClassAttribute(value: unknown): string {
    if (typeof value !== 'string' || value === '') return '';
    return value.split(/\s+/).filter((t) => isSafeClassToken(t)).join(' ');
}

/** The structural `className` PROP of a container block. Mirror of safeStyle.ts's version. */
const EXTRA_CLASS_TOKEN = new RegExp(TEMPLATE_CONTRACT.classList.tokenPattern);
const MAX_EXTRA_CLASS_TOKENS: number = TEMPLATE_CONTRACT.classList.maxTokens;
function safeExtraClassList(value: unknown): string | undefined {
    if (typeof value !== 'string' || value === '' || value !== value.trim()) return undefined;
    const tokens = value.split(' ');
    if (tokens.length > MAX_EXTRA_CLASS_TOKENS) return undefined;
    if (!tokens.every((t) => EXTRA_CLASS_TOKEN.test(t) && isSafeClassToken(t))) return undefined;
    return value;
}

/**
 * The `class`-filtering transform, as sanitize-html wants it. Exported so `core/formatting.ts` — the
 * OTHER write boundary in this package, the one comments go through — applies the identical function
 * instead of growing a second copy of the rule.
 *
 * `'*'` is not "the fallback transform": sanitize-html runs the per-tag transform and THEN this one
 * (index.js — `transformTagsMap[name]`, then `transformTagsAll`), so a config that already transforms
 * `a` or `iframe` keeps doing so and still gets the class bound.
 */
function classAttributeTransform(tagName: string, attribs: Record<string, string>) {
    if (typeof attribs.class === 'string') {
        const kept = safeClassAttribute(attribs.class);
        if (kept) attribs.class = kept;
        else delete attribs.class;
    }
    return { tagName, attribs };
}

/**
 * Add the class bound to ANY sanitize-html configuration, preserving whatever transforms it already
 * declares (an existing `'*'` runs first, then ours). Every sanitizer in this package goes through
 * this function, so a config cannot admit `class` and forget to bound it.
 */
function withClassBound(config: any): any {
    const existing = config && config.transformTags;
    const existingAll = existing && existing['*'];
    return {
        ...config,
        transformTags: {
            ...(existing || {}),
            '*': existingAll
                ? (tagName: string, attribs: Record<string, string>) => {
                    const first = existingAll(tagName, attribs);
                    return classAttributeTransform(first.tagName, first.attribs);
                }
                : classAttributeTransform,
        },
    };
}

const INLINE_STYLE_VALUE_PATTERNS = Object.fromEntries(
    Object.entries(HTML_SANITIZATION.inlineStyleValuePatterns).map(([property, patterns]: [string, any]) => [
        property,
        patterns.map((pattern: string) => new RegExp(pattern)),
    ]),
);

// Authoritative sanitization config. The browser parser consumes its own generated copy.
const sanitize = (html: string) => {
    return sanitizeHtml(html, withClassBound({
        allowedTags: HTML_SANITIZATION.allowedTags.filter(
            (tag: string) => !(HTML_SANITIZATION.forbiddenTags as readonly string[]).includes(tag),
        ),
        allowedAttributes: { '*': [...HTML_SANITIZATION.allowedAttributes] },
        allowedStyles: { '*': INLINE_STYLE_VALUE_PATTERNS },
        allowedSchemes: [...URL_SANITIZATION.contentSchemes],
        allowedSchemesByTag: {
            img: [...URL_SANITIZATION.mediaSchemes],
            source: [...URL_SANITIZATION.mediaSchemes],
        },
        allowedIframeHostnames: [...HTML_SANITIZATION.iframeHosts],
        transformTags: {
            iframe: (tagName: string, attribs: Record<string, string>) => ({
                tagName,
                attribs: { ...attribs, sandbox: attribs.sandbox || HTML_SANITIZATION.iframeSandbox },
            }),
            a: (tagName: string, attribs: Record<string, string>) => {
                if ((attribs.target || '').toLowerCase() === '_blank') attribs.rel = 'noopener noreferrer';
                return { tagName, attribs };
            },
        },
    }));
};

// Field names within a Puck component's `props` that may carry rich HTML and are rendered through a
// dangerouslySetInnerHTML/innerHTML path on the public site → sanitize their HTML.
const PUCK_HTML_FIELDS = new Set<string>(PROPERTY_SANITIZERS.richText);
// Field names that hold a URL and are rendered into src/href → strip ONLY dangerous schemes. NOTE:
// 'icon' is intentionally NOT here — it carries a FontAwesome class token (e.g. 'fa-rocket'), not a URL,
// and must be left untouched. We must also PRESERVE relative paths ('/uploads/x.png'), fragments ('#'),
// and protocol-relative URLs — blanking those (as a strict absolute-http(s)-only escaper does) silently
// corrupts the page builder (broken images/links/icons on every save).
const PUCK_URL_FIELDS = new Set<string>(PROPERTY_SANITIZERS.url);

// Permissive URL sanitizer for Puck URL fields: keep relative/absolute/fragment/mailto/tel URLs, drop
// only script-bearing schemes. (An <img src="javascript:..."> is inert anyway; an <a href> is the real
// sink — both are covered.)
function safePuckUrl(v: string): string {
    const t = String(v).split('').filter((c) => { const n = c.charCodeAt(0); return n > 0x20 && (n < 0x7f || n > 0xa0); }).join('').toLowerCase();
    if (BLOCKED_PUCK_SCHEME.test(t)) return '';
    return v;
}

/* ── THE STYLE CHANNEL ────────────────────────────────────────────────────────────────────────────
 * MIRROR OF `frontend/src/components/blocks/safeStyle.ts`, deliberately: this is a different package
 * and cannot import it (the same arrangement as core/language-tag.ts ↔ lib/documentLanguage.ts).
 * Change one copy and change the other; `frontend/src/components/content/__tests__/blockStyleInjection.test.tsx`
 * drives BOTH implementations over one corpus and fails if they ever disagree.
 *
 * WHY IT IS NEEDED HERE. Style does not only travel as HTML — it travels as a JSON OBJECT. `props.css`
 * (the editor's CSS control) and `props.look` (Appearance) are handed to React, which turns them into
 * a `style` attribute and does NOT escape `;` inside a value. The walk below used to treat those
 * objects like any other: it recursed to the string leaves and ran `safePuckUrl` on them, which only
 * blanks a value that STARTS with javascript:/data:/vbscript:/file:. So
 *     css.color = "red;position:fixed;inset:0;z-index:2147483647;background:#fff url(https://x/y)"
 * was stored verbatim and rendered verbatim: a full-screen attacker-controlled overlay served from the
 * site's own origin, plus an IP/User-Agent beacon through the background url(). Any account that can
 * publish could do it. Not XSS — no script, no cookie — but phishing on the victim's own domain.
 */

/** Property names the editor's CSS control can produce (the `CSSData` interface). CLOSED list. */
const AUTHOR_CSS_PROPS = new Set<string>(STYLE_SECURITY.authorProperties);
/**
 * CUSTOM PROPERTIES AN AUTHOR MAY NAME. Closed LIST, not a pattern — mirror of `AUTHOR_CSS_VARS`
 * (safeStyle.ts), and the difference matters: a custom property is not a declaration, it is a value
 * the stylesheet later expands INTO one, including declarations `AUTHOR_CSS_PROPS` excludes on
 * purpose (`--wjs-button-hover-transform` → `transform:`). This side used to accept any `--wjs-*`
 * by pattern while the renderer accepted only these two, so the write boundary STORED payloads the
 * renderer refuses to paint — the defence held by luck, in one layer, and any future consumer of
 * `_puck_data` that does not go through safeCss (a plugin renderer, an exporter, a theme with its
 * own painter) was being handed them. Two boundaries that disagree are worse than one.
 */
const AUTHOR_CSS_VARS = new Set<string>(STYLE_SECURITY.authorCustomProperties);
const URL_BEARING_PROP = new RegExp(STYLE_SECURITY.urlBearingPropertyPattern);
/** `;` is the one that mattered: React does not escape it inside a style value. */
const UNSAFE_STYLE_VALUE = new RegExp(STYLE_SECURITY.unsafeValuePattern, 'i');
/** Keys of `look` (Appearance) whose value IS a URL and therefore must be one. */
const LOOK_URL_FIELDS = new Set(['bgImage']);

/**
 * Keys that must never be copied onto a rebuilt object with `out[k] = …`.
 *
 * WHY. `JSON.parse('{"__proto__":{"x":1}}')` DOES create `__proto__` as an OWN property, so it survives
 * Object.entries and reaches the rebuild loops below — and there `out['__proto__'] = {…}` is not a plain
 * assignment: it runs the Object.prototype setter and swaps the prototype of the object being built.
 * The blast radius is local (this object, not Object.prototype — `out` is a fresh literal), but the
 * sanitized tree is then persisted and read back by every render site, and a node whose prototype is
 * attacker-shaped is not a node any caller can reason about. A Puck tree never legitimately carries
 * these keys, so DROP them rather than trying to carry them safely.
 */
const FORBIDDEN_KEY = new Set(['__proto__', 'constructor', 'prototype']);

/** A URL that may be interpolated into a url() token — or null. See safeStyle.ts for the reasoning. */
function safeCssUrl(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const clean = raw.replace(URL_STRIPPED_CONTROLS, '').trim();
    if (!clean) return null;
    if (/["'()\\\s<>;{}]/.test(clean)) return null;
    // No scheme → a path on THIS site, except the two authority-relative spellings (`//host`, `/\host`
    // — the URL parser treats `\` like `/`), which are remote.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(clean)) return /^\/[/\\]/.test(clean) ? null : clean;
    try {
        const u = new URL(clean);
        if (!NAVIGATION_PROTOCOLS.has(u.protocol)) return null;
        return u.toString();
    } catch {
        return null;
    }
}

/**
 * THE TRAILING SEMICOLON IS NORMALISED AWAY, NOT PUNISHED — and it has to happen HERE, not only in
 * safeStyle.ts, because THIS side is the one that stores. Several of these fields are free text where
 * the author types CSS by hand (`shadow`, `width`, `radius`, the CSSControls inputs) and ending a
 * declaration with `;` is a universal habit; while only the renderer normalised it, the canvas showed
 * the shadow as it was typed and the reload after saving showed the theme's value instead — "the
 * editor does not save my shadow", with an extra step of confusion. Only a TRAILING run is stripped,
 * so `red;position:fixed;` still keeps an interior `;` and is still refused below.
 */
const stripTrailingSemicolons = (raw: string): string => raw.trim().replace(/[\s;]*;[\s;]*$/, '');

/** One declaration value, normalised — or null when the author may not emit it. */
function safeCssValue(prop: string, raw: unknown): string | number | null {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string') return null;
    const v = stripTrailingSemicolons(raw);
    if (!v) return null;
    const asUrl = /^url\(\s*(.*?)\s*\)$/i.exec(v);
    if (asUrl) {
        if (!URL_BEARING_PROP.test(prop)) return null;
        const safe = safeCssUrl(asUrl[1].replace(/^["']/, '').replace(/["']$/, ''));
        return safe === null ? null : `url("${safe}")`;
    }
    return UNSAFE_STYLE_VALUE.test(v) ? null : v;
}

/* ── THE CLASS: A CUSTOM PROPERTY IS A DECLARATION SOMEBODY ELSE WRITES ───────────────────────────
 * Mirror of `NARROWED_VAR_VALUE` / `safeCustomPropValue` in safeStyle.ts — read that header for the
 * reasoning. Short version: the value criterion only rejects PUNCTUATION, so a variable that
 * wordjs-ui.css expands into `transform:` accepts any well-formed transform ("scale(200)" covers the
 * viewport with a clickable block). Those variables get a PARSED, magnitude-clamped grammar instead
 * of a filter, on both boundaries, so the tree on disk and the tree the renderer paints agree.
 */
const clampedNumber = (min: number, max: number) => (raw: string): string | null => {
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) return null;
    return String(Math.min(max, Math.max(min, n)));
};
const TRANSFORM_POLICY = STYLE_SECURITY.transformPolicy;
const TRANSLATE_MAX: Readonly<Record<string, number>> = TRANSFORM_POLICY.translateMax;
const TRANSLATE_UNIT = new RegExp(`^(-?\\d*\\.?\\d+)(${Object.keys(TRANSLATE_MAX).join('|')})$`);
const transformValue = (raw: string): string | null => {
    const v = raw.trim().replace(/\s+/g, ' ');
    if (/^none$/i.test(v)) return 'none';
    const parts = v.match(/[a-zA-Z]+\([^()]*\)/g);
    if (!parts || parts.join(' ') !== v || parts.length > TRANSFORM_POLICY.maxFunctions) return null;
    const out: string[] = [];
    for (const part of parts) {
        const m = /^([a-zA-Z]+)\(([^()]*)\)$/.exec(part)!;
        const fn = m[1].toLowerCase();
        const arg = m[2].trim();
        if (fn === 'scale' || fn === 'scalex' || fn === 'scaley') {
            const n = clampedNumber(TRANSFORM_POLICY.scale.min, TRANSFORM_POLICY.scale.max)(arg);
            if (n === null) return null;
            out.push(`${fn === 'scale' ? 'scale' : fn === 'scalex' ? 'scaleX' : 'scaleY'}(${n})`);
        } else if (fn === 'translatex' || fn === 'translatey') {
            const lm = TRANSLATE_UNIT.exec(arg);
            if (!lm) return null;
            const cap = TRANSLATE_MAX[lm[2]];
            const n = Math.min(cap, Math.max(-cap, Number(lm[1])));
            out.push(`${fn === 'translatex' ? 'translateX' : 'translateY'}(${n}${lm[2]})`);
        } else if (fn === 'rotate') {
            const rm = /^(-?\d*\.?\d+)deg$/.exec(arg);
            if (!rm) return null;
            out.push(`rotate(${rm[1]}deg)`);
        } else {
            return null;
        }
    }
    return out.join(' ');
};

/**
 * Mirror of `boundedLength`/SPACING_MAX (safeStyle.ts): a bare LENGTH, clamped per unit, for the
 * spacing tokens the stylesheet drops inside a `calc()` that a `transform:` then consumes.
 */
const boundedLength = (max: Record<string, number>) => (raw: string): string | null => {
    const v = raw.trim().toLowerCase();
    if (/^-?0+(?:\.0+)?$/.test(v)) return '0';
    const units = Object.keys(max).map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const m = new RegExp(`^(-?\\d*\\.?\\d+)(${units.join('|')})$`).exec(v);
    if (!m) return null;
    const cap = max[m[2]];
    if (cap === undefined) return null;
    return `${Math.min(cap, Math.max(-cap, Number(m[1])))}${m[2]}`;
};
const boundedNonNegativeLength = (max: Record<string, number>) => (raw: string): string | null => {
    const value = boundedLength(max)(raw);
    return value !== null && !value.startsWith('-') ? value : null;
};

type NarrowSpec =
    | { kind: 'number'; min: number; max: number }
    | { kind: 'transform' }
    | { kind: 'length' | 'non-negative-length'; max: Record<string, number> };

const narrowerFromSpec = (spec: NarrowSpec): ((raw: string) => string | null) => {
    if (spec.kind === 'number') return clampedNumber(spec.min, spec.max);
    if (spec.kind === 'transform') return transformValue;
    return spec.kind === 'length' ? boundedLength(spec.max) : boundedNonNegativeLength(spec.max);
};

/** Generated from the same sink-oriented table as the renderer. */
const NARROWED_VAR_VALUE = new Map<string, (raw: string) => string | null>(
    Object.entries(STYLE_SECURITY.narrowedVariables).map(([name, spec]) => [
        name,
        narrowerFromSpec(spec as NarrowSpec),
    ]),
);

/** THE ONLY WAY a `--*` value is stored: value criterion, then the narrowed grammar for its name. */
function safeCustomPropValue(name: string, raw: unknown): string | number | null {
    const value = safeCssValue(name, raw);
    if (value === null) return null;
    const narrow = NARROWED_VAR_VALUE.get(name);
    return narrow ? narrow(String(value)) : value;
}

/** `props.css`: a style OBJECT. Unknown property names and unsafe values are DROPPED, not blanked. */
function sanitizeStyleObject(style: any): any {
    const out: any = {};
    for (const [prop, raw] of Object.entries(style)) {
        const named = prop.startsWith('--') ? AUTHOR_CSS_VARS.has(prop) : AUTHOR_CSS_PROPS.has(prop);
        if (!named) continue;
        const value = prop.startsWith('--') ? safeCustomPropValue(prop, raw) : safeCssValue(prop, raw);
        if (value !== null) out[prop] = value;
    }
    return out;
}

/**
 * `props.look`: an Appearance SPEC, not a style object — its strings are interpolated INTO CSS values
 * by appearanceToStyle (bgColor, gradFrom/Via/To, glassTint, borderColor, shadowColor, color,
 * fontFamily, transform, hoverColor, overlayColor …). So the rule here is the VALUE rule, and a
 * rejected string is blanked to '' — which `isSet()` on the render side already reads as "not set".
 * Numbers, booleans and the nested tb/mo breakpoint objects keep their shape.
 */
function sanitizeLookSpecUnchecked(look: any): any {
    if (Array.isArray(look)) return look.map((item) => sanitizeLookSpecUnchecked(item));
    if (!look || typeof look !== 'object') return look;
    const out: any = {};
    for (const [k, v] of Object.entries(look)) {
        if (FORBIDDEN_KEY.has(k)) continue; // rebuilt with out[k] = … — see FORBIDDEN_KEY
        if (v && typeof v === 'object') { out[k] = sanitizeLookSpecUnchecked(v); continue; }
        if (typeof v !== 'string') { out[k] = v; continue; }
        if (LOOK_URL_FIELDS.has(k)) { out[k] = safeCssUrl(v) ?? ''; continue; }
        // Same normalisation as the value rule above (see stripTrailingSemicolons): these strings are
        // interpolated INTO declarations by appearanceToStyle, which normalises the habitual trailing
        // `;`. Blanking it here instead was the write boundary erasing a legitimate `shadow`/`bgColor`
        // the editor had just shown the author.
        const norm = stripTrailingSemicolons(v);
        out[k] = UNSAFE_STYLE_VALUE.test(norm) ? '' : norm;
    }
    return out;
}

function sanitizeLookSpec(look: any): any {
    assertMetaValueWithinLimits(look);
    return sanitizeLookSpecUnchecked(look);
}

/**
 * Sanitize untrusted meta on write. The Puck tree (_puck_data) is stored verbatim and trusted at many
 * independent public render sites; a single block that pipes a field into innerHTML without escaping is
 * author-privilege stored XSS. Walk the structure and sanitize ONLY string leaves (preserving the JSON
 * shape): HTML-bearing fields via the post-body sanitizer, URL-bearing fields via an allow-list of
 * schemes. Non-HTML/URL strings are left untouched.
 */
function sanitizePuckNode(node: any, keyHint: string | null = null): any {
    if (Array.isArray(node)) {
        return node.map((item) => sanitizePuckNode(item, keyHint));
    }
    if (node && typeof node === 'object') {
        // THE STYLE CHANNEL, handled BEFORE the generic walk. Recursing into `css`/`look` and running
        // safePuckUrl on their string leaves is what let arbitrary CSS through: that function only
        // blanks a value STARTING with a dangerous scheme, and the payload here is a perfectly
        // ordinary-looking `red;position:fixed;inset:0`. These two objects are not "props with string
        // leaves", they are CSS, and they get the CSS criterion. (Emission filters again — see
        // appearanceToStyle/blockVars — but the stored tree must be clean on its own.)
        if (keyHint === 'css' && !Array.isArray(node)) return sanitizeStyleObject(node);
        if (keyHint === 'look') return sanitizeLookSpecUnchecked(node);
        const out: any = Array.isArray(node) ? [] : {};
        for (const [k, v] of Object.entries(node)) {
            if (FORBIDDEN_KEY.has(k)) continue; // rebuilt with out[k] = … — see FORBIDDEN_KEY
            out[k] = sanitizePuckNode(v, k);
        }
        return out;
    }
    if (typeof node === 'string') {
        const lower = keyHint ? String(keyHint).toLowerCase() : '';
        if (PUCK_HTML_FIELDS.has(lower)) {
            return sanitize(node);
        }
        // THE STRUCTURAL CLASS PROP. `className` is the container affordance of Section/Grid/FlexRow/
        // Columns (core/template-validate.ts names it for exactly those four). It is a plain string
        // leaf, so before this it only met `safePuckUrl` — which blanks a dangerous SCHEME and nothing
        // else — and `className: "fixed inset-0 z-50"` was stored verbatim. The render side already
        // refuses it (`safeExtraClassList` in blocks.tsx), but a stored tree is read by more than that
        // render: the exporter, the REST API, a plugin renderer, a theme with its own painter. Same
        // criterion as the sink, so the two boundaries say the same thing. A rejected value becomes ''
        // — the key keeps its shape, and '' is what "no extra class" is spelled as everywhere else.
        if (lower === 'classname') {
            return safeExtraClassList(node) ?? '';
        }
        // VALUE-BASED (not key-based): run EVERY other string leaf through safePuckUrl. It ONLY blanks a
        // value that STARTS with a script/dangerous scheme (javascript:/data:/vbscript:/file:) and returns
        // everything else untouched — so it closes stored XSS via URL-bearing props whose key we didn't
        // enumerate (e.g. CTABanner/PricingTable `buttonLink`, a menu `to`, etc.) while preserving labels,
        // classes, colors, relative paths, fragments. (XSS-01: the old key-name allowlist missed buttonLink.)
        return safePuckUrl(node);
    }
    return node;
}


function sanitizePuckTree(node: any, keyHint: string | null = null): any {
    assertMetaValueWithinLimits(node);
    return sanitizePuckNode(node, keyHint);
}

/**
 * Sanitize a single meta value before persisting. Currently targets _puck_data (the serialized Puck
 * page tree) which is rendered as HTML on the public site; structured JSON shape is preserved.
 */
function sanitizeMetaValue(key: string, value: any) {
    // Match the database's weakest supported collation, not JavaScript's byte comparison. On
    // MySQL/MariaDB `_PUCK_DATA`, an accent-decorated spelling or trailing spaces can address the
    // SAME row as `_puck_data`; judging one representation while SQL writes another bypasses this
    // sanitizer. canonicalMetaKey is the shared collation contract used by protected-meta too.
    if (canonicalMetaKey(key) === '_puck_data' && value) {
        if (typeof value === 'object') return sanitizePuckTree(value);
        // XSS-02: _puck_data sent as a JSON STRING (some clients/imports do) bypassed the object-only
        // guard entirely. Parse → sanitize → re-stringify; a non-JSON string isn't a Puck tree so leave it.
        if (typeof value === 'string') {
            let parsed: any;
            try { parsed = JSON.parse(value); }
            catch (error) {
                if (error instanceof SyntaxError) return value;
                throw error;
            }
            // Do not catch the structural bound: routes translate that branded refusal to 413. Catching
            // it together with SyntaxError would persist the original hostile JSON string unsanitized.
            return JSON.stringify(sanitizePuckTree(parsed));
        }
    }
    return value;
}

module.exports = {
    sanitize, sanitizePuckTree, sanitizeMetaValue, PUCK_HTML_FIELDS, PUCK_URL_FIELDS, safePuckUrl,
    // Exported for the cross-package mirror test (see the STYLE CHANNEL header). The CONSTANTS are
    // exported too, not just the functions: a mirror test that only drives behaviour over a hand-typed
    // corpus can only catch a divergence the corpus happens to contain — the two lists themselves have
    // to be compared, so that ADDING a name on one side fails immediately instead of waiting for
    // someone to think of it as a test case.
    sanitizeStyleObject, sanitizeLookSpec, safeCssUrl, safeCssValue, safeCustomPropValue,
    AUTHOR_CSS_PROPS, AUTHOR_CSS_VARS, NARROWED_VAR_VALUE, UNSAFE_STYLE_VALUE, URL_BEARING_PROP,
    // THE CLASS CHANNEL. `withClassBound`/`classAttributeTransform` are exported because
    // core/formatting.ts is the OTHER write boundary in this package (post_content and comments) and
    // must apply the SAME function, not a second copy of the rule. The predicate and the constants go
    // with them for the same reason the style ones do: the gate compares the two packages' copies, so
    // that adding a keyword on one side fails immediately instead of waiting for a test case.
    isSafeClassToken, safeClassAttribute, safeExtraClassList, classAttributeTransform, withClassBound,
    CSS_POSITION_KEYWORDS, POSITION_BINDING_CLASSES, MAX_CLASS_ATTR_TOKEN, MAX_EXTRA_CLASS_TOKENS,
    // Structural availability bound. Routes use the branded error to reject the whole write before
    // any post/revision/meta mutation; importers may skip the offending metadata item.
    assertMetaValueWithinLimits, isMetaValueComplexityError, MetaValueComplexityError,
    MAX_META_VALUE_DEPTH, MAX_META_VALUE_NODES,
};
