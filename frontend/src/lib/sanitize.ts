"use client";
/**
 * WordJS - HTML Sanitization Utility
 * Prevents XSS attacks when rendering user-generated content
 */

import DOMPurify from 'dompurify';

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
        'blockquote', 'pre', 'code', 'hr', 'details', 'summary', 'style'
    ],
    ALLOWED_ATTR: [
        // Common
        'id', 'class', 'style', 'title', 'lang', 'dir',
        // Links
        'href', 'target', 'rel',
        // Media
        'src', 'alt', 'width', 'height', 'loading', 'controls', 'autoplay', 'muted', 'loop', 'poster',
        // Tables
        'colspan', 'rowspan',
        // Forms
        'type', 'name', 'value', 'placeholder', 'disabled', 'readonly', 'checked',
        // Iframes (for video embeds)
        'frameborder', 'allow', 'allowfullscreen', 'referrerpolicy',
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
    allowVulnerableTags: true // we intentionally keep <style>/<iframe> (matches the client allowlist)
};

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
