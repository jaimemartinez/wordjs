import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Plugin } from "@/lib/api";
import { BrokenPluginCard, PackPluginButton, brokenReasonText, partitionPlugins } from "../page";

/**
 * THE "INSTALACIÓN INCOMPLETA" CARD.
 *
 * `plugins/<slug>/` can be left holding only build output while the `active_plugins` option still
 * names <slug>. The admin screen used to render NOTHING for that state — the backend list only
 * carried loadable plugins — while every install of that slug was refused with "is currently active.
 * Deactivate it before re-uploading". The admin had nothing to click and no way out.
 *
 * So what these cases pin is the way OUT, not the styling: the card exists, it says the installation
 * is incomplete, and it offers exactly the two actions that resolve the state — reinstall from the
 * marketplace, or clear the leftovers.
 *
 * `page.tsx` is a fetch-on-mount client tree, so the card and the two pure helpers are exported for
 * this test (same shape as MarketplaceTab's exported `reviewPill`).
 */

const orphan = (over: Partial<Plugin> = {}): Plugin => ({
    name: "ghost",
    slug: "ghost",
    description: "",
    version: "",
    active: false,
    broken: true,
    brokenReason: "no-manifest",
    wasActive: true,
    removable: true,
    ...over,
});

const healthy = (over: Partial<Plugin> = {}): Plugin => ({
    name: "Real One",
    slug: "real-one",
    description: "A plugin that actually exists",
    version: "1.0.0",
    active: true,
    ...over,
});

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("partitionPlugins", () => {
    it("separates orphaned entries from real plugins", () => {
        const { broken, healthy: ok } = partitionPlugins([healthy(), orphan(), healthy({ slug: "b", active: false })]);
        expect(broken.map((p) => p.slug)).toEqual(["ghost"]);
        expect(ok.map((p) => p.slug)).toEqual(["real-one", "b"]);
    });

    it("a list with no orphan yields no broken cards at all", () => {
        expect(partitionPlugins([healthy(), healthy({ slug: "b" })]).broken).toEqual([]);
    });
});

describe("brokenReasonText", () => {
    it("names the missing files for an incomplete install", () => {
        expect(brokenReasonText({ brokenReason: "no-manifest" })).toMatch(/Instalación incompleta/);
        expect(brokenReasonText({ brokenReason: "missing" })).toMatch(/faltan los archivos/);
    });

    it("distinguishes an unreadable manifest — its files are still there", () => {
        expect(brokenReasonText({ brokenReason: "unreadable-manifest" })).toMatch(/manifest\.json/);
        expect(brokenReasonText({ brokenReason: "unreadable-manifest" })).not.toMatch(/faltan los archivos/);
    });

    it("an unknown reason still reads as broken, never as healthy", () => {
        expect(brokenReasonText({})).toMatch(/Instalación incompleta/);
    });
});

describe("BrokenPluginCard", () => {
    it("renders the slug, the incomplete-install copy and BOTH ways out", () => {
        const html = render(
            <BrokenPluginCard plugin={orphan()} onReinstall={() => {}} onCleanup={() => {}} />,
        );
        expect(html).toContain("ghost");
        expect(html).toMatch(/Instalación incompleta/);
        expect(html).toMatch(/Reinstalar desde el Marketplace/);
        expect(html).toMatch(/Quitar restos/);
    });

    it("says the entry was marked active when it was, and does not when it was not", () => {
        expect(render(<BrokenPluginCard plugin={orphan({ wasActive: true })} onReinstall={() => {}} onCleanup={() => {}} />))
            .toMatch(/marcado como activo/);
        expect(render(<BrokenPluginCard plugin={orphan({ wasActive: false })} onReinstall={() => {}} onCleanup={() => {}} />))
            .toMatch(/Quedan restos/);
    });

    it("disables the cleanup button while that cleanup is in flight (no double submit)", () => {
        const html = render(<BrokenPluginCard plugin={orphan()} busy onReinstall={() => {}} onCleanup={() => {}} />);
        expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Quitar restos/);
    });

    it("hands the plugin itself to each action (the caller needs the slug, not an index)", () => {
        const onReinstall = vi.fn();
        const onCleanup = vi.fn();
        const p = orphan();
        // Drive the handlers the way the buttons do — renderToStaticMarkup drops the listeners, so the
        // wiring is asserted through the props the card was built with.
        const el = <BrokenPluginCard plugin={p} onReinstall={onReinstall} onCleanup={onCleanup} />;
        el.props.onReinstall(el.props.plugin);
        el.props.onCleanup(el.props.plugin);
        expect(onReinstall).toHaveBeenCalledWith(p);
        expect(onCleanup).toHaveBeenCalledWith(p);
    });
});

describe("PackPluginButton (dev-mode build & download ZIP)", () => {
    it("is not rendered unless the backend reports the pack route (development only)", () => {
        expect(render(<PackPluginButton plugin={healthy()} packing={false} onPack={() => {}} />)).toBe("");
        expect(render(<PackPluginButton plugin={healthy({ packable: false })} packing={false} onPack={() => {}} />)).toBe("");
    });

    it("renders for a packable plugin and is disabled while its pack runs", () => {
        const idle = render(<PackPluginButton plugin={healthy({ packable: true })} packing={false} onPack={() => {}} />);
        expect(idle).toContain("Build and download Real One as a ZIP");
        expect(idle).not.toContain("disabled=\"\"");
        expect(render(<PackPluginButton plugin={healthy({ packable: true })} packing={true} onPack={() => {}} />)).toContain("disabled=\"\"");
    });

    it("hands the plugin itself to the action", () => {
        const onPack = vi.fn();
        const el = PackPluginButton({ plugin: healthy({ packable: true }), packing: false, onPack }) as React.ReactElement<{ onClick: () => void }>;
        el.props.onClick();
        expect(onPack).toHaveBeenCalledWith(expect.objectContaining({ slug: "real-one" }));
    });
});
