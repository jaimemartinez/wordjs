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

// Allowlist of iframe embed hosts (mirrors the backend posts.ts sanitize()). Arbitrary iframe src is
// NOT permitted — only these hosts — and every surviving iframe is forced to carry a sandbox attribute.
// CSP `frame-src 'self'` (next.config.ts) is the backstop if anything slips past this list.
const ALLOWED_IFRAME_HOSTS = ['www.youtube.com', 'player.vimeo.com'];
const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-presentation';

function isAllowedIframeSrc(src: string | null | undefined): boolean {
    if (!src) return false;
    try {
        const u = new URL(src, 'https://invalid.invalid');
        return (u.protocol === 'https:' || u.protocol === 'http:') &&
            ALLOWED_IFRAME_HOSTS.includes(u.hostname.toLowerCase());
    } catch {
        return false;
    }
}

// Inline styles: the visual editor's rich text (Tiptap TextStyle / FontSize / Color / BackgroundColor
// / FontFamily / TextAlign) emits an inline `style` attribute for font size, text color, highlight,
// font family and alignment. Allowing the RAW `style` attribute is an injection vector (url() beacons
// for exfiltration/tracking, expression(), position/overlay tricks), so instead we permit ONLY a
// small allowlist of typographic properties, and only with injection-free values.
const ALLOWED_STYLE_PROPS = new Set([
    'color', 'background-color', 'font-size', 'font-family', 'font-weight',
    'font-style', 'text-decoration', 'text-align', 'line-height', 'text-transform',
]);
// Reject any declaration whose value could smuggle a fetch/script/CSS-injection.
const UNSAFE_STYLE_VALUE = /url\(|expression|javascript:|@import|[<>{}\\]/i;
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
    ALLOWED_TAGS: [
        // Text formatting
        'p', 'br', 'b', 'i', 'u', 'strong', 'em', 'mark', 's', 'del', 'ins', 'sub', 'sup',
        // Headers
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        // Lists
        'ul', 'ol', 'li',
        // Links and media
        'a', 'img', 'figure', 'figcaption', 'video', 'audio', 'source', 'iframe',
        // Structure
        'div', 'span', 'section', 'article', 'header', 'footer', 'nav', 'aside',
        // Tables
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
        // Forms (read-only rendering)
        'form', 'input', 'button', 'select', 'option', 'textarea', 'label',
        // Other
        // NOTE: <style> is intentionally NOT allowed — it enables CSS injection/exfiltration
        // (e.g. @import / url() beacons, attribute-selector value exfil) with no script needed.
        'blockquote', 'pre', 'code', 'hr', 'details', 'summary'
    ],
    ALLOWED_ATTR: [
        // Common
        // `style` is allowed but scrubbed to a safe typographic allowlist (ALLOWED_STYLE_PROPS) by the
        // afterSanitizeAttributes hook below — required for the rich-text editor's font-size/color/
        // highlight/font-family/align, which are inline styles. Raw arbitrary CSS is NOT permitted.
        'id', 'class', 'title', 'lang', 'dir', 'style',
        // Links
        'href', 'target', 'rel',
        // Media
        'src', 'alt', 'width', 'height', 'loading', 'controls', 'autoplay', 'muted', 'loop', 'poster',
        // Tables
        'colspan', 'rowspan',
        // Forms
        'type', 'name', 'value', 'placeholder', 'disabled', 'readonly', 'checked',
        // Iframes (for video embeds) — src is validated against ALLOWED_IFRAME_HOSTS by a hook below,
        // and `sandbox` is force-applied so a surviving embed runs with reduced privileges.
        'frameborder', 'allow', 'allowfullscreen', 'referrerpolicy', 'sandbox',
        // Data attributes
        'data-*'
    ],
    ALLOW_DATA_ATTR: true,
    // Allow YouTube, Vimeo embeds
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'scrolling'],
    // Forbid potentially dangerous elements
    FORBID_TAGS: ['script', 'object', 'embed', 'base', 'meta', 'link'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur']
};

// Server-side (SSR) equivalent for sanitize-html (pure JS — DOMPurify needs a DOM). Mirrors the
// DOMPurify allowlist so the initial server-rendered HTML is sanitized too. on* handlers and
// <script>/<object>/etc. are absent from the allowlists → dropped. React does not re-diff
// dangerouslySetInnerHTML on hydration, so a slight server/client sanitizer difference is harmless.
const SERVER_SANITIZE_OPTIONS = {
    allowedTags: SANITIZE_OPTIONS.ALLOWED_TAGS.filter(t => !SANITIZE_OPTIONS.FORBID_TAGS.includes(t)),
    allowedAttributes: { '*': SANITIZE_OPTIONS.ALLOWED_ATTR },
    // Mirror the client's inline-style allowlist (ALLOWED_STYLE_PROPS): only these typographic
    // properties survive, and only with values matching these patterns — url()/expression()/@import
    // never match, so they're dropped. Keeps SSR output identical in spirit to the client hook.
    allowedStyles: {
        '*': {
            'color': [/^#(?:[0-9a-fA-F]{3,8})$/, /^rgb\(/, /^rgba\(/, /^hsl\(/, /^hsla\(/, /^[a-zA-Z]+$/],
            'background-color': [/^#(?:[0-9a-fA-F]{3,8})$/, /^rgb\(/, /^rgba\(/, /^hsl\(/, /^hsla\(/, /^[a-zA-Z]+$/],
            'font-size': [/^\d+(?:\.\d+)?(?:px|em|rem|%|pt)$/],
            'font-family': [/^[\w\s,'"()-]+$/],
            'font-weight': [/^(?:normal|bold|bolder|lighter|[1-9]00)$/],
            'font-style': [/^(?:normal|italic|oblique)$/],
            'text-decoration': [/^(?:none|underline|line-through|overline)(?:\s+\w+)*$/],
            'text-align': [/^(?:left|right|center|justify)$/],
            'line-height': [/^[\d.]+(?:px|em|rem|%)?$/],
            'text-transform': [/^(?:none|uppercase|lowercase|capitalize)$/],
        },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'], source: ['http', 'https', 'data'] },
    // Restrict <iframe> to the embed-host allowlist (arbitrary src is dropped). <style> is no longer
    // allowed, so allowVulnerableTags is gone — sanitize-html no longer needs the unsafe-tag opt-in.
    allowedIframeHostnames: ALLOWED_IFRAME_HOSTS,
    transformTags: {
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
