// Presentational chrome block (composable-chrome contract v1). Server-compatible: no hooks, no
// "use client". Formatted text — links, bold, line breaks — the form the legacy footer text and
// copyright were written in, so they convert without losing anything.
//
// SECURITY: the stored HTML is NEVER trusted. It goes through the same sanitizeHTML every other
// rich-text surface uses (sanitize-html on the server, DOMPurify in the browser) on EVERY render, so
// whatever reached the option — the legacy page, an import, a hand-edited theme file — cannot put a
// script, an event handler or a javascript: link on the public page.
import { sanitizeHTML } from "@/lib/sanitize";
import { applyChromeTokens, escapeChromeText } from "@/lib/chromeTokens";

export interface ChromeRichTextViewProps {
    html: string;
    // Resolved bindings for the {site} token.
    siteTitle?: string;
}

export default function ChromeRichText({ html, siteTitle }: ChromeRichTextViewProps) {
    // Tokens are expanded BEFORE sanitizing, with the site title HTML-escaped: the expansion can then
    // only ever add text, and the sanitizer still sees the final markup.
    const expanded = applyChromeTokens(html || "", { site: escapeChromeText(siteTitle || "") });
    const safe = sanitizeHTML(expanded);
    if (!safe.trim()) return null;
    return (
        <div
            className="wjs-chrome-richtext text-sm whitespace-pre-line break-words [&_a]:text-[var(--wjs-color-primary,#2F6D86)] [&_a:hover]:underline"
            suppressHydrationWarning
            dangerouslySetInnerHTML={{ __html: safe }}
        />
    );
}
