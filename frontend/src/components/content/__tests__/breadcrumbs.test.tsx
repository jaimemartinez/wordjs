import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BreadcrumbsBlock } from "../blocks";

/**
 * Breadcrumbs — the ancestor trail is resolved PER-POST (resolveDynamicBlocks' post-context pass) and
 * arrives as `resolvedTrail`. This pins the SSR contract: real links in the initial HTML, the current
 * page marked aria-current with no link, hrefs re-validated, hidden on the front page, and the
 * public empty path rendering nothing.
 */
const trail = [
    { label: "Servicios", href: "/servicios" },
    { label: "Consultoría", href: "/servicios/consultoria" },
    { label: "Esta página" }, // current — no href
];

describe("BreadcrumbsBlock — SSR contract", () => {
    it("renders Home + ancestor links and marks the current page aria-current", () => {
        const html = renderToStaticMarkup(<BreadcrumbsBlock resolvedTrail={trail} />);
        expect(html).toContain('href="/servicios"');
        expect(html).toContain('href="/servicios/consultoria"');
        expect(html).toContain(">Servicios<");
        expect(html).toContain('href="/"'); // Home (showHome default true)
        expect(html).toContain('aria-current="page"');
        // The current page is TEXT, not a link.
        expect(html).toMatch(/<span[^>]*aria-current="page"[^>]*>Esta página<\/span>/);
        expect(html).toContain("wjs-block-breadcrumbs wp-block-breadcrumbs");
        // JSON-LD BreadcrumbList present.
        expect(html).toContain("application/ld+json");
        expect(html).toContain("BreadcrumbList");
    });

    it("escapes `<` in a crumb label so it cannot break out of the JSON-LD script", () => {
        const html = renderToStaticMarkup(
            <BreadcrumbsBlock resolvedTrail={[{ label: "</script><x>", href: "/x" }, { label: "Aquí" }]} />,
        );
        // The hostile `<` lands only as the < escape inside the ld+json, never as a raw tag.
        expect(html).toContain("\\u003c");
        expect(html).not.toContain("</script><x>");
    });

    it("re-validates every href at render (a javascript: crumb collapses to #)", () => {
        const html = renderToStaticMarkup(
            <BreadcrumbsBlock resolvedTrail={[{ label: "Malo", href: "javascript:alert(1)" }, { label: "Aquí" }]} />,
        );
        expect(html).not.toContain("javascript:");
    });

    it("hides on the site front page when asked", () => {
        expect(renderToStaticMarkup(<BreadcrumbsBlock resolvedTrail={trail} resolvedIsFront hideOnHome />)).toBe("");
    });

    it("renders nothing on public with no trail, a preview while editing", () => {
        expect(renderToStaticMarkup(<BreadcrumbsBlock resolvedTrail={[]} />)).toBe("");
        const editing = renderToStaticMarkup(<BreadcrumbsBlock resolvedTrail={[]} isEditing />);
        expect(editing).toContain("Esta página");
        expect(editing).toContain("wjs-breadcrumbs");
    });
});
