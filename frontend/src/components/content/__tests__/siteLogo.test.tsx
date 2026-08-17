import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteLogoBlock } from "../blocks";

/**
 * SiteLogo — the SSR + security contract of the block that BINDS to the site identity.
 *
 * Like NavMenu it stores no copy of the brand: `identity` ({ blogname, siteLogo }) arrives already
 * resolved (server-side via resolveDynamicBlocks, or useEditorIdentity in the canvas), so the real
 * logo/title land in the SSR HTML. What this pins is the mode matrix (logo / title / both), the
 * link-home toggle, the alt override, the empty-binding behaviour and the security floor: a hostile
 * logo url never reaches the DOM as an <img src>, and blogname renders as escaped text.
 */

const IDENTITY = { blogname: "Acme Co", siteLogo: "/media/logo.png" };

describe("SiteLogoBlock — modes", () => {
    it("emits the block identity via bc(): own class first, historical alias second", () => {
        const html = renderToStaticMarkup(<SiteLogoBlock identity={IDENTITY} />);
        expect(html).toContain("wjs-block-site-logo wp-block-site-logo");
    });

    it('mode "both" renders the logo image AND the title', () => {
        const html = renderToStaticMarkup(<SiteLogoBlock identity={IDENTITY} mode="both" />);
        expect(html).toContain('src="/media/logo.png"');
        expect(html).toContain("wjs-site-title");
        expect(html).toContain("Acme Co");
    });

    it('mode "logo" renders the image and no title span', () => {
        const html = renderToStaticMarkup(<SiteLogoBlock identity={IDENTITY} mode="logo" />);
        expect(html).toContain('src="/media/logo.png"');
        expect(html).not.toContain("wjs-site-title");
    });

    it('mode "title" renders the title text and no <img>', () => {
        const html = renderToStaticMarkup(<SiteLogoBlock identity={IDENTITY} mode="title" />);
        expect(html).toContain("wjs-site-title");
        expect(html).toContain("Acme Co");
        expect(html).not.toContain("<img");
    });

    it('mode "logo" with no logo falls back to the title so the brand is never invisible', () => {
        const html = renderToStaticMarkup(<SiteLogoBlock identity={{ blogname: "Acme Co", siteLogo: "" }} mode="logo" />);
        expect(html).not.toContain("<img");
        expect(html).toContain("Acme Co");
    });
});

describe("SiteLogoBlock — link home + alt", () => {
    it("links to / by default", () => {
        const html = renderToStaticMarkup(<SiteLogoBlock identity={IDENTITY} />);
        expect(html).toContain('href="/"');
        expect(html).toMatch(/<a[^>]*class="wjs-header-logo/);
    });

    it("linkToHome=false renders no anchor", () => {
        const html = renderToStaticMarkup(<SiteLogoBlock identity={IDENTITY} linkToHome={false} />);
        expect(html).not.toContain("<a");
        expect(html).toContain("wjs-header-logo"); // still on the wrapper span
    });

    it("altOverride wins over blogname for the image alt", () => {
        const html = renderToStaticMarkup(<SiteLogoBlock identity={IDENTITY} mode="logo" altOverride="Home" />);
        expect(html).toContain('alt="Home"');
    });

    it("alt falls back to blogname when no override", () => {
        const html = renderToStaticMarkup(<SiteLogoBlock identity={IDENTITY} mode="logo" />);
        expect(html).toContain('alt="Acme Co"');
    });
});

describe("SiteLogoBlock — security", () => {
    it("a javascript:/data: logo url never becomes an <img src>", () => {
        const evil = renderToStaticMarkup(<SiteLogoBlock identity={{ blogname: "Acme", siteLogo: "javascript:alert(1)" }} mode="logo" />);
        expect(evil).not.toContain("<img");
        expect(evil).not.toContain("javascript:alert");
        // falls back to the title text instead
        expect(evil).toContain("Acme");
    });

    it("a protocol-relative //host logo url is rejected (treated as external, not same-origin)", () => {
        const html = renderToStaticMarkup(<SiteLogoBlock identity={{ blogname: "Acme", siteLogo: "//evil.example/x.png" }} mode="logo" />);
        expect(html).not.toContain("<img");
    });

    it("an absolute https logo url is allowed", () => {
        const html = renderToStaticMarkup(<SiteLogoBlock identity={{ blogname: "Acme", siteLogo: "https://cdn.example/logo.png" }} mode="logo" />);
        expect(html).toContain('src="https://cdn.example/logo.png"');
    });

    it("blogname renders as escaped text, never as HTML", () => {
        const html = renderToStaticMarkup(<SiteLogoBlock identity={{ blogname: "<img src=x onerror=1>", siteLogo: "" }} mode="title" />);
        expect(html).not.toContain("<img src=x");
        expect(html).toContain("&lt;img");
    });
});

describe("SiteLogoBlock — empty binding", () => {
    it("renders NOTHING on the public path when identity is empty", () => {
        expect(renderToStaticMarkup(<SiteLogoBlock identity={{ blogname: "", siteLogo: "" }} />)).toBe("");
        expect(renderToStaticMarkup(<SiteLogoBlock identity={undefined} />)).toBe("");
    });

    it("shows an authoring-only notice while editing", () => {
        const html = renderToStaticMarkup(<SiteLogoBlock identity={{ blogname: "", siteLogo: "" }} isEditing />);
        expect(html).toContain("wjs-block-site-logo wp-block-site-logo");
        expect(html).toContain("site-logo--empty");
    });
});
