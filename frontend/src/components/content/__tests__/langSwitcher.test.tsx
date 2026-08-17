import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LangSwitcherBlock } from "../blocks";

/**
 * LangSwitcher — binds to the PUBLIC content translation model (post.language + post.translations),
 * resolved per-post as `resolvedTranslations = { language, currentHref, items:[{language, href}] }`.
 * Pins: links to the sibling translations land in the SSR HTML, hrefs are re-validated, labels carry
 * lang/hreflang, the dropdown style is a JS-free <details>, and a monolingual page renders nothing.
 */
const resolved = {
    language: "es",
    currentHref: "/hola",
    items: [
        { language: "en", href: "/hello" },
        { language: "fr", href: "/bonjour" },
    ],
};

describe("LangSwitcherBlock — SSR contract", () => {
    it("inline: links to each translation with lang + hreflang, current shown", () => {
        const html = renderToStaticMarkup(<LangSwitcherBlock resolvedTranslations={resolved} />);
        expect(html).toContain('href="/hello"');
        // React renders the hrefLang prop verbatim; HTML attributes are case-insensitive, so match either.
        expect(html.toLowerCase()).toContain('hreflang="en"');
        expect(html).toContain('href="/bonjour"');
        expect(html).toContain('lang="fr"');
        expect(html).toContain("wjs-lang-switcher__current"); // showCurrent default true
        expect(html).toContain("wjs-block-lang-switcher wp-block-lang-switcher");
    });

    it("re-validates hrefs (a javascript: translation collapses to #)", () => {
        const html = renderToStaticMarkup(
            <LangSwitcherBlock resolvedTranslations={{ language: "es", currentHref: "/x", items: [{ language: "en", href: "javascript:alert(1)" }] }} />,
        );
        expect(html).not.toContain("javascript:");
    });

    it("dropdown style is a JS-free <details> disclosure", () => {
        const html = renderToStaticMarkup(<LangSwitcherBlock resolvedTranslations={resolved} style="dropdown" />);
        expect(html).toContain("<details");
        expect(html).toContain("<summary");
        expect(html).not.toContain("<script");
    });

    it("renders nothing on public when there are no translations (monolingual)", () => {
        expect(renderToStaticMarkup(<LangSwitcherBlock resolvedTranslations={{ language: "es", currentHref: "/x", items: [] }} />)).toBe("");
        const editing = renderToStaticMarkup(<LangSwitcherBlock resolvedTranslations={{ language: "es", currentHref: "/x", items: [] }} isEditing />);
        expect(editing).toContain("wjs-lang-switcher");
    });
});
