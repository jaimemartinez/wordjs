import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Drawer URL parity — the mobile half of NavMenu's security contract.
 *
 * The block's default mobileBehavior="drawer" hands the menu tree to ChromeNavMobile, which used to
 * render `item.url` RAW (no safeNavHref, no target whitelist): the same stored `javascript:` url that
 * desktop collapsed to '#' went LIVE in the drawer, and a `_blank` item opened `_self`. The fix is
 * layered, and so are these tests:
 *
 *  (a) the SEAM — NavMenuBlock sanitizes the tree it hands to the drawer. Pinned by stubbing
 *      ChromeNavMobile with a probe that renders whatever urls it receives, raw.
 *  (b) DEFENCE IN DEPTH — ChromeNavMobile re-validates at render itself (it is shared with the
 *      composed header chrome, which does NOT pass through NavMenuBlock). Pinned by rendering the
 *      real MobileNavItems (vi.importActual — the drawer panel itself mounts behind a portal, so the
 *      exported items renderer is the static-renderable surface).
 *
 * next/link is stubbed to a plain <a>: renderToStaticMarkup runs outside the Next runtime, and the
 * assertions are about the href/target/rel values, not Link behavior.
 */

vi.mock("next/link", () => ({
    // Handlers (onClick) pass through harmlessly — renderToStaticMarkup never serializes them.
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
        <a href={href} {...rest}>{children}</a>
    ),
}));

// Probe stub: renders EXACTLY what it is given — if a hostile url survives the seam, it shows up.
vi.mock("@/components/chrome/ChromeNavMobile", () => ({
    default: ({ items }: { items: Array<{ id: string | number; title: string; url: string; children?: unknown[] }> }) => (
        <ul data-testid="drawer-probe">
            {items.map((it) => (
                <li key={it.id}>
                    <a href={it.url}>{it.title}</a>
                    {Array.isArray(it.children) && it.children.length > 0 && (
                        <ul>
                            {(it.children as Array<{ id: string | number; title: string; url: string }>).map((c) => (
                                <li key={c.id}><a href={c.url}>{c.title}</a></li>
                            ))}
                        </ul>
                    )}
                </li>
            ))}
        </ul>
    ),
}));

import { NavMenuBlock } from "../blocks";
import type { ChromeMenuItem } from "@/lib/chromeData";

const HOSTILE_FLAT = [
    { id: 1, title: "Home", url: "/", target: "_self", parent: 0, order: 0 },
    { id: 2, title: "Evil", url: "javascript:alert(1)", target: "sneaky", parent: 0, order: 1 },
    // hostile CHILD too — the seam must sanitize recursively
    { id: 3, title: "EvilChild", url: "data:text/html,<script>1</script>", target: "_self", parent: 1, order: 0 },
    { id: 4, title: "Docs", url: "https://example.com/docs", target: "_blank", parent: 0, order: 2 },
];

describe("NavMenuBlock — (a) the tree handed to the drawer is sanitized at the seam", () => {
    // Default mobileBehavior="drawer" → the probe receives the exact tree the block hands over.
    const html = renderToStaticMarkup(<NavMenuBlock menu={HOSTILE_FLAT} />);
    const probe = html.match(/<ul data-testid="drawer-probe">[\s\S]*<\/ul>/)?.[0] ?? "";

    it("a stored javascript:/data: url reaches the drawer as '#' — same as the desktop <a>", () => {
        expect(probe).not.toBe("");
        expect(probe).not.toContain("javascript:alert");
        expect(probe).not.toContain("data:text/html");
        // Evil (top level) and EvilChild (nested) both collapsed
        expect(probe.match(/href="#"/g)).toHaveLength(2);
    });

    it("legitimate urls survive untouched, at both depths", () => {
        expect(probe).toContain('href="/"');
        expect(probe).toContain('href="https://example.com/docs"');
    });
});

describe("ChromeNavMobile — (b) the drawer re-validates at render (defence in depth)", () => {
    it("MobileNavItems collapses hostile urls to '#' and whitelists target/_blank rel on its own", async () => {
        // The REAL module (bypassing the probe stub above); its next/link import stays stubbed.
        const { MobileNavItems } = await vi.importActual<typeof import("@/components/chrome/ChromeNavMobile")>(
            "@/components/chrome/ChromeNavMobile",
        );
        const items: ChromeMenuItem[] = [
            { id: 1, title: "Evil", url: "javascript:alert(1)", target: "sneaky", children: [
                { id: 2, title: "EvilChild", url: "vbscript:msgbox(1)", children: [] },
            ] },
            { id: 3, title: "Docs", url: "https://example.com/docs", target: "_blank", children: [] },
        ];
        const html = renderToStaticMarkup(<MobileNavItems items={items} onNavigate={() => {}} depth={0} />);

        expect(html).not.toContain("javascript:alert");
        expect(html).not.toContain("vbscript:");
        expect(html.match(/href="#"/g)).toHaveLength(2);

        const evil = html.match(/<a\b[^>]*>Evil<\/a>/)?.[0] ?? "";
        expect(evil).toContain('target="_self"');
        expect(evil).not.toContain("rel=");

        const docs = html.match(/<a\b[^>]*>Docs<\/a>/)?.[0] ?? "";
        expect(docs).toContain('href="https://example.com/docs"');
        expect(docs).toContain('target="_blank"');
        expect(docs).toContain('rel="noopener noreferrer"');
    });
});
