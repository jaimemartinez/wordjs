/**
 * WordJS - HTML Sanitization Utility
 * Prevents XSS attacks when rendering user-generated content
 *
 * SHARED module (no "use client"): server components call sanitizeHTML during RSC render (the
 * sanitize-html path), client components keep using it through the DOMPurify path — the
 * typeof-window branches inside each function do the splitting. Marking it "use client" made
 * every export a client REFERENCE when imported from a server component, which throws on call.
 */

import DOMPurify from 'dompurify';
// THE hosts a video embed may come from. Declared in a plain-JS module at the frontend root because
// `next.config.ts` has to read the SAME list to build the CSP `frame-src` — see that file, and see
// embed-hosts.js's header for why the list could not stay here.
import { ALLOWED_IFRAME_HOSTS as EMBED_IFRAME_HOSTS, ALLOWED_EMBED_HOSTS as EMBED_ALL_HOSTS } from '../../embed-hosts.js';
// The value criterion for a CSS declaration, shared with the OBJECT style channel (props.css /
// props.look / blockVars). One pattern, two channels — see safeStyle.ts.
// `safeClassAttribute` is the same arrangement for the attribute NEXT DOOR: `class` reaches the page
// through this sanitizer (rich text, HTML embeds, widgets, expanded shortcodes, comments) exactly as
// it reaches it through a block prop, and one criterion answers for both. See safeStyle.ts's
// "THE SAME ATTRIBUTE, THE OTHER SINK" header for why bounding only the prop channel was not enough.
import { UNSAFE_STYLE_VALUE, safeClassAttribute } from '@/components/blocks/safeStyle';
import {
    HTML_SANITIZATION,
    URL_SANITIZATION,
} from '@/generated/visual-contract.generated';

const URL_STRIPPED_CONTROLS = new RegExp(URL_SANITIZATION.stripControlsPattern, 'g');

// Load sanitize-html at SSR RUNTIME. This file is "use client", but sanitizeHTML() also runs during
// SERVER rendering of client components. A plain `require('sanitize-html')` here is rewritten by
// webpack: in the compiled production build the server bundle's require resolved to a broken/absent
// module and THREW, so every SSR call fell into its catch and stripped ALL tags from Puck content —
// bold, font-size and font-family were silently lost on the public site (dev worked, prod did not,
// because `next dev` doesn't bundle the same way). `__non_webpack_require__` is webpack's designated
// "leave this to the runtime require" escape hatch, so the real node module loads and is never bundled
// into the client. Cached after first load. Falls back to eval-require, then the bundler's require.
declare const __non_webpack_require__: ((id: string) => any) | undefined;
let _sanitizeHtmlLib: any = null;
function loadSanitizeHtml(): any {
    // The browser NEVER uses sanitize-html (every caller is inside a `typeof window === 'undefined'`
    // branch; the client path is DOMPurify). This guard states that to the bundler: `typeof window`
    // is a compile-time constant in Next builds, so the client chunk drops this whole body — without
    // it, the bare require below shipped sanitize-html + htmlparser2 (~90 KB gz) to every visitor as
    // dead weight. Server behavior (all three fallbacks, in order) is byte-identical.
    if (typeof window !== 'undefined') return null;
    if (_sanitizeHtmlLib) return _sanitizeHtmlLib;
    try { if (typeof __non_webpack_require__ === 'function') return (_sanitizeHtmlLib = __non_webpack_require__('sanitize-html')); } catch { /* try next */ }
    try { return (_sanitizeHtmlLib = (eval('require') as NodeRequire)('sanitize-html')); } catch { /* try next */ }
    return (_sanitizeHtmlLib = require('sanitize-html'));
}

// Allowlist of iframe embed hosts (generated with the backend's sanitize-meta.ts). Arbitrary iframe src
// is NOT permitted — only these hosts — and every surviving iframe is forced to carry a sandbox
// attribute. The CSP `frame-src` (next.config.ts) is the backstop if anything slips past this list,
// and it is DERIVED from the very same module so the two can no longer drift apart.
export const ALLOWED_IFRAME_HOSTS: readonly string[] = EMBED_IFRAME_HOSTS;
const IFRAME_SANDBOX = HTML_SANITIZATION.iframeSandbox;

export function isAllowedIframeSrc(src: string | null | undefined): boolean {
    if (!src) return false;
    try {
        const u = new URL(src, 'https://invalid.invalid');
        return (u.protocol === 'https:' || u.protocol === 'http:') &&
            ALLOWED_IFRAME_HOSTS.includes(u.hostname.toLowerCase());
    } catch {
        return false;
    }
}

/* ── Video embeds: ONE provider table, shared with the video-embed block ──────────────────────────
 * The block used to classify a URL by substring (`url.includes("youtube.com/watch")`,
 * `url.includes("vimeo.com/")`), which `https://youtube.com.evil.test/watch?v=…` and
 * `https://vimeo.com.evil.test/1` both satisfy: the attacker chose the provider AND the id that got
 * pasted into the embed URL. Here the URL is PARSED and the host compared whole (an exact hostname,
 * never a prefix/suffix/`includes`), the id must match its provider's shape, and the result is
 * rebuilt from our own constants — an attacker-supplied string never survives into the src.
 * `ALLOWED_EMBED_HOSTS` is ALLOWED_IFRAME_HOSTS plus youtube's cookie-less mirror of the same
 * player, which the block has always honored when the author pasted one. */
const VIDEO_PROVIDERS = HTML_SANITIZATION.videoProviders;
const YOUTUBE_PROVIDER = VIDEO_PROVIDERS.youtube;
const VIMEO_PROVIDER = VIDEO_PROVIDERS.vimeo;
const YT_STANDARD_HOSTS = new Set<string>(YOUTUBE_PROVIDER.standardHosts);
const YT_NOCOOKIE_HOSTS = new Set<string>(YOUTUBE_PROVIDER.noCookieHosts);
const YT_SHORT_HOSTS = new Set<string>(YOUTUBE_PROVIDER.shortHosts);
const VIMEO_PAGE_HOSTS = new Set<string>(VIMEO_PROVIDER.pageHosts);
const VIMEO_PLAYER_HOST = VIMEO_PROVIDER.outputHost;
export const ALLOWED_EMBED_HOSTS: readonly string[] = EMBED_ALL_HOSTS;
// Path shapes that carry the id, and the id shapes themselves. Anything else → no embed.
const YT_ID_PATH = new Set<string>(YOUTUBE_PROVIDER.idPathSegments);
const YT_VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VIMEO_ID = /^\d{1,20}$/;
const VIMEO_HASH = /^[A-Za-z0-9]{1,40}$/;

/**
 * A root-relative path served by THIS site — or null. Use it wherever a value decides "is this ours",
 * because same-origin-by-construction is what makes it safe to evaluate during SSR, where there is no
 * window.location to compare against.
 *
 * Two spellings have to be rejected, and only one of them is obvious:
 *   · `//host/x`  — protocol-relative, i.e. remote. The old check caught this one.
 *   · `/\host/x`  — the parser treats `\` exactly like `/` for a special scheme, so this is ALSO
 *                   authority-relative and ALSO remote. The old check waved it through.
 * Tab, LF and CR are stripped first because the URL parser strips them before parsing: `/\t/host/x`
 * reaches the network as `//host/x`. Validating a string the browser will never see is not a guard.
 */
export function sameOriginPath(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const clean = raw.replace(URL_STRIPPED_CONTROLS, '');
    if (!clean.startsWith('/')) return null;
    if (/^\/[/\\]/.test(clean)) return null;
    return clean;
}

/**
 * Canonical, allowlisted embed URL for a pasted video URL — or null when the URL is not a video from
 * a provider we embed (the caller renders a placeholder, never an iframe).
 */
export function resolveVideoEmbedUrl(raw: unknown): string | null {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let u: URL;
    try {
        u = new URL(raw.trim());
    } catch {
        return null; // relative/garbage: not an embeddable third-party video
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null; // javascript:, data:, …
    const host = u.hostname.toLowerCase();
    const seg = u.pathname.split('/').filter(Boolean);

    // ── YouTube (standard + nocookie + youtu.be short links) ──
    const nocookie = YT_NOCOOKIE_HOSTS.has(host);
    if (nocookie || YT_STANDARD_HOSTS.has(host) || YT_SHORT_HOSTS.has(host)) {
        let id = '';
        let fromEmbed = false;
        if (YT_SHORT_HOSTS.has(host)) {
            id = seg[0] ?? '';
        } else if (seg[0] === 'watch') {
            id = u.searchParams.get('v') ?? '';
        } else if (seg[0] && YT_ID_PATH.has(seg[0])) {
            id = seg[1] ?? '';
            fromEmbed = seg[0] === 'embed';
        }
        if (!YT_VIDEO_ID.test(id)) return null;
        const out = new URL(`https://${nocookie ? YOUTUBE_PROVIDER.noCookieOutputHost : YOUTUBE_PROVIDER.outputHost}/embed/${id}`);
        // An already-embed URL keeps its player params (start=, list=…) — re-encoded through the URL
        // API, so they stay params and cannot grow a second path or host.
        if (fromEmbed && u.search) {
            for (const [k, v] of u.searchParams) out.searchParams.set(k, v);
        } else {
            out.searchParams.set('rel', '0');
            out.searchParams.set('modestbranding', '1');
        }
        return out.toString();
    }

    // ── Vimeo (page URL or an already-built player URL) ──
    if (VIMEO_PAGE_HOSTS.has(host) || host === VIMEO_PLAYER_HOST) {
        const rest = host === VIMEO_PLAYER_HOST ? (seg[0] === 'video' ? seg.slice(1) : []) : seg;
        const idx = rest.findIndex((s) => VIMEO_ID.test(s)); // vimeo.com/channels/<name>/<id> too
        if (idx < 0) return null;
        const hash = rest[idx + 1] && VIMEO_HASH.test(rest[idx + 1]) ? `/${rest[idx + 1]}` : '';
        const out = new URL(`https://${VIMEO_PLAYER_HOST}/video/${rest[idx]}${hash}`);
        // An unlisted video does not play without its hash; vimeo spells it either as a trailing
        // path segment or as `?h=` — keep whichever the author pasted (shape-checked, nothing else).
        const h = u.searchParams.get('h');
        if (!hash && h && VIMEO_HASH.test(h)) out.searchParams.set('h', h);
        return out.toString();
    }

    return null;
}

// Inline styles: the visual editor's rich text (Tiptap TextStyle / FontSize / Color / BackgroundColor
// / FontFamily / TextAlign) emits an inline `style` attribute for font size, text color, highlight,
// font family and alignment. Allowing the RAW `style` attribute is an injection vector (url() beacons
// for exfiltration/tracking, expression(), position/overlay tricks), so instead we permit ONLY a
// small allowlist of typographic properties, and only with injection-free values.
const ALLOWED_STYLE_PROPS = new Set<string>(HTML_SANITIZATION.inlineStyleProperties);
// The value criterion itself now lives in components/blocks/safeStyle.ts (imported above): the OBJECT
// style channel — props.css / props.look / blockVars — needs the identical rule, and this file used to
// be the only place that had one. The pattern moved, it did not change shape: it still rejects `url(`,
// `expression`, `javascript:`, `@…` and `<>{}\`, and it now also names `;` explicitly (a no-op on this
// path, which splits declarations on `;` before testing, and the whole point on the object path).
function filterInlineStyle(style: string | null | undefined): string {
    if (!style) return '';
    return style
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((decl) => {
            const idx = decl.indexOf(':');
            if (idx < 0) return null;
            const prop = decl.slice(0, idx).trim().toLowerCase();
            const val = decl.slice(idx + 1).trim();
            if (!ALLOWED_STYLE_PROPS.has(prop) || !val || UNSAFE_STYLE_VALUE.test(val)) return null;
            return `${prop}: ${val}`;
        })
        .filter(Boolean)
        .join('; ');
}

// Configure DOMPurify options
const SANITIZE_OPTIONS = {
    ALLOWED_TAGS: [...HTML_SANITIZATION.allowedTags],
    ALLOWED_ATTR: [...HTML_SANITIZATION.allowedAttributes],
    ALLOW_DATA_ATTR: true,
    // Allow YouTube, Vimeo embeds
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'scrolling'],
    // Forbid potentially dangerous elements
    FORBID_TAGS: [...HTML_SANITIZATION.forbiddenTags],
    FORBID_ATTR: [...HTML_SANITIZATION.forbiddenAttributes]
};

// Server-side (SSR) equivalent for sanitize-html (pure JS — DOMPurify needs a DOM). Mirrors the
// DOMPurify allowlist so the initial server-rendered HTML is sanitized too. on* handlers and
// <script>/<object>/etc. are absent from the allowlists → dropped. React does not re-diff
// dangerouslySetInnerHTML on hydration, so a slight server/client sanitizer difference is harmless.
const INLINE_STYLE_VALUE_PATTERNS = Object.fromEntries(
    Object.entries(HTML_SANITIZATION.inlineStyleValuePatterns).map(([property, patterns]) => [
        property,
        patterns.map((pattern) => new RegExp(pattern)),
    ]),
);
const SERVER_SANITIZE_OPTIONS = {
    allowedTags: SANITIZE_OPTIONS.ALLOWED_TAGS.filter(
        (tag) => !(SANITIZE_OPTIONS.FORBID_TAGS as readonly string[]).includes(tag),
    ),
    allowedAttributes: { '*': SANITIZE_OPTIONS.ALLOWED_ATTR },
    // Mirror the client's inline-style allowlist (ALLOWED_STYLE_PROPS): only these typographic
    // properties survive, and only with values matching these patterns — url()/expression()/@import
    // never match, so they're dropped. Keeps SSR output identical in spirit to the client hook.
    allowedStyles: {
        '*': INLINE_STYLE_VALUE_PATTERNS,
    },
    allowedSchemes: [...URL_SANITIZATION.contentSchemes],
    allowedSchemesByTag: { img: [...URL_SANITIZATION.mediaSchemes], source: [...URL_SANITIZATION.mediaSchemes] },
    // Restrict <iframe> to the embed-host allowlist (arbitrary src is dropped). <style> is no longer
    // allowed, so allowVulnerableTags is gone — sanitize-html no longer needs the unsafe-tag opt-in.
    allowedIframeHostnames: ALLOWED_IFRAME_HOSTS,
    transformTags: {
        // THE CLASS CHANNEL. `'*'` is not "the fallback transform": sanitize-html runs the per-tag
        // transform AND then this one (index.js — `transformTagsMap[name]` then `transformTagsAll`),
        // so `a` and `iframe` below are covered too. Every surviving element's class attribute is
        // filtered token by token by the shared criterion; an attribute with nothing left is removed.
        '*': (tagName: string, attribs: Record<string, string>) => {
            if (typeof attribs.class === 'string') {
                const kept = safeClassAttribute(attribs.class);
                if (kept) attribs.class = kept;
                else delete attribs.class;
            }
            return { tagName, attribs };
        },
        // Force a sandbox on every surviving (allowlisted) iframe — defense in depth.
        iframe: (tagName: string, attribs: Record<string, string>) => ({
            tagName,
            attribs: { ...attribs, sandbox: attribs.sandbox || IFRAME_SANDBOX }
        }),
        // Any link opening a new tab gets rel="noopener noreferrer" (reverse-tabnabbing protection).
        a: (tagName: string, attribs: Record<string, string>) => {
            if ((attribs.target || '').toLowerCase() === '_blank') {
                attribs.rel = 'noopener noreferrer';
            }
            return { tagName, attribs };
        }
    }
};

// DOMPurify hooks (client path). Registered once at module load.
// 1) Strip <iframe> whose src is not in the embed-host allowlist; force sandbox on the survivors.
// 2) Force rel="noopener noreferrer" on any <a target="_blank">.
let _hooksRegistered = false;
function ensureDomPurifyHooks(): void {
    if (_hooksRegistered || typeof window === 'undefined') return;
    DOMPurify.addHook('uponSanitizeElement', (node: any, data: any) => {
        if (data.tagName === 'iframe') {
            const src = node.getAttribute && node.getAttribute('src');
            if (!isAllowedIframeSrc(src)) {
                // Not an allowed embed host → drop the element entirely.
                if (node.parentNode) node.parentNode.removeChild(node);
                return;
            }
            node.setAttribute('sandbox', node.getAttribute('sandbox') || IFRAME_SANDBOX);
        }
    });
    DOMPurify.addHook('afterSanitizeAttributes', (node: any) => {
        if (node.tagName === 'A' && node.getAttribute && node.getAttribute('target')) {
            if (node.getAttribute('target').toLowerCase() === '_blank') {
                node.setAttribute('rel', 'noopener noreferrer');
            }
        }
        // Scrub inline styles down to the safe typographic allowlist (see filterInlineStyle). Anything
        // else — url() beacons, position/overlay tricks, unknown props — is dropped.
        if (node.getAttribute && node.getAttribute('style')) {
            const safe = filterInlineStyle(node.getAttribute('style'));
            if (safe) node.setAttribute('style', safe);
            else node.removeAttribute('style');
        }
        // THE CLASS CHANNEL, client path — the exact counterpart of the `'*'` transformTag in
        // SERVER_SANITIZE_OPTIONS, calling the SAME predicate. `style` was bounded here and `class`
        // was not, which is the whole reason a `position` utility could still land on the element.
        if (node.getAttribute && node.getAttribute('class')) {
            const kept = safeClassAttribute(node.getAttribute('class'));
            if (kept) node.setAttribute('class', kept);
            else node.removeAttribute('class');
        }
    });
    _hooksRegistered = true;
}

/**
 * Sanitize HTML content to prevent XSS attacks
 * @param dirty - Raw HTML string (potentially dangerous)
 * @returns Clean HTML string safe for rendering
 */
export function sanitizeHTML(dirty: string): string {
    if (!dirty) return '';
    if (typeof window === 'undefined') {
        // Server-side (SSR): sanitize with sanitize-html so the initial HTML is safe BEFORE hydration.
        // Returning raw here was an XSS window (the payload ran before the client could sanitize).
        try {
            return loadSanitizeHtml()(dirty, SERVER_SANITIZE_OPTIONS);
        } catch {
            return dirty.replace(/<[^>]*>/g, ''); // fail closed
        }
    }
    ensureDomPurifyHooks();
    return DOMPurify.sanitize(dirty, SANITIZE_OPTIONS);
}

/**
 * Sanitize HTML with custom options
 */
export function sanitizeHTMLCustom(dirty: string, options: object): string {
    if (!dirty) return '';
    if (typeof window === 'undefined') {
        // Custom options are DOMPurify-shaped; on the server fall back to the base allowlist (still safe).
        try {
            return loadSanitizeHtml()(dirty, SERVER_SANITIZE_OPTIONS);
        } catch {
            return dirty.replace(/<[^>]*>/g, '');
        }
    }
    ensureDomPurifyHooks();
    return DOMPurify.sanitize(dirty, { ...SANITIZE_OPTIONS, ...options });
}

/**
 * Strip all HTML tags, returning only text
 */
export function stripHTML(dirty: string): string {
    if (!dirty) return '';
    if (typeof window === 'undefined') {
        // Server-side: use sanitize-html (allow nothing) rather than a regex strip, which is bypassable
        // (e.g. `<scr<script>ipt>`). Fail closed to a regex strip only if the lib is unavailable.
        try {
            return loadSanitizeHtml()(dirty, { allowedTags: [], allowedAttributes: {} });
        } catch {
            return dirty.replace(/<[^>]*>/g, '');
        }
    }
    return DOMPurify.sanitize(dirty, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
}

/**
 * Check if content contains potentially dangerous elements
 */
export function hasDangerousContent(html: string): boolean {
    if (!html) return false;

    const dangerous = [
        /<script/i,
        /javascript:/i,
        /on\w+\s*=/i, // onclick, onerror, etc.
        /data:text\/html/i,
        /<object/i,
        /<embed/i,
        /<base/i
    ];

    return dangerous.some(pattern => pattern.test(html));
}

export default sanitizeHTML;
