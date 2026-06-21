"use client";
/**
 * WordJS - HTML Sanitization Utility
 * Prevents XSS attacks when rendering user-generated content
 */

import DOMPurify from 'dompurify';

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
        // NOTE: the `style` attribute is intentionally NOT allowed on user content (inline-CSS
        // injection vector); legitimate styling comes from class names / React components.
        'id', 'class', 'title', 'lang', 'dir',
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
            return require('sanitize-html')(dirty, SERVER_SANITIZE_OPTIONS);
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
            return require('sanitize-html')(dirty, SERVER_SANITIZE_OPTIONS);
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
            return require('sanitize-html')(dirty, { allowedTags: [], allowedAttributes: {} });
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
