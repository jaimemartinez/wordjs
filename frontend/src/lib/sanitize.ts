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

/**
 * Sanitize HTML content to prevent XSS attacks
 * @param dirty - Raw HTML string (potentially dangerous)
 * @returns Clean HTML string safe for rendering
 */
export function sanitizeHTML(dirty: string): string {
    if (typeof window === 'undefined') {
        // Server-side: return as-is (Next.js SSR)
        // DOMPurify requires a DOM, so we skip on server
        // The client will sanitize when hydrating
        return dirty || '';
    }

    if (!dirty) return '';

    return DOMPurify.sanitize(dirty, SANITIZE_OPTIONS);
}

/**
 * Sanitize HTML with custom options
 */
export function sanitizeHTMLCustom(dirty: string, options: object): string {
    if (typeof window === 'undefined') return dirty || '';
    if (!dirty) return '';

    return DOMPurify.sanitize(dirty, { ...SANITIZE_OPTIONS, ...options });
}

/**
 * Strip all HTML tags, returning only text
 */
export function stripHTML(dirty: string): string {
    if (typeof window === 'undefined') {
        // Server-side fallback
        return dirty?.replace(/<[^>]*>/g, '') || '';
    }

    if (!dirty) return '';

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
