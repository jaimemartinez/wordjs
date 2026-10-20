import { describe, it, expect, vi } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE FRONT PAGE'S [tag] EMBEDS COME FROM THE PLUGINS, NOT FROM A LIST IN THE CORE.
 *
 * HomeContent used to hardcode `[cards]` → card-gallery and `[vgallery]` → video-gallery. The tags now
 * arrive as a prop (GET /plugins/shortcodes: what the active plugins declare in their manifests), so a
 * plugin nobody installed is not named here, and any plugin's declared tag works the same way.
 */

// PluginLoader is a client island; stand in a marker that shows which plugin and props it was given.
vi.mock("@/components/PluginLoader", () => ({
    default: ({ slug, props }: { slug: string; props?: Record<string, string> }) =>
        <i data-plugin={slug} data-props={JSON.stringify(props || {})} />,
}));

import HomeContent, { splitShortcodes } from "../HomeContent";

const DECLARED = [{ tag: "cards", plugin: "card-gallery" }, { tag: "vgallery", plugin: "video-gallery" }];
const page = (content: string) => ({ id: 1, title: "Home", content, meta: {} } as any);

describe("front page shortcodes", () => {
    it("mounts the declaring plugin's component for each declared tag, attributes as props", () => {
        const html = renderToStaticMarkup(<HomeContent post={page('<p>a</p>[cards]<p>b</p>[vgallery id="default"]')} shortcodes={DECLARED} />);
        expect(html).toContain('data-plugin="card-gallery"');
        expect(html).toContain('data-plugin="video-gallery"');
        expect(html).toContain('data-props="{&quot;id&quot;:&quot;default&quot;}"');
        expect(html).not.toContain("[cards]");
    });

    it("leaves a tag no active plugin declares as plain text", () => {
        const html = renderToStaticMarkup(<HomeContent post={page("<p>[cards]</p>")} shortcodes={[]} />);
        expect(html).toContain("[cards]");
        expect(html).not.toContain("data-plugin");
    });

    it("splits on declared tags only, case-insensitively, and ignores malformed declarations", () => {
        expect(splitShortcodes("x [CARDS] y", DECLARED)).toEqual(["x ", { type: "plugin", slug: "card-gallery", props: {} }, " y"]);
        expect(splitShortcodes("[carousel]", DECLARED)).toEqual(["[carousel]"]);
        expect(splitShortcodes("[a.b]", [{ tag: "a.b", plugin: "x" }])).toEqual(["[a.b]"]);
    });

    it("the core no longer names a plugin to render a shortcode", () => {
        const src = fs.readFileSync(path.resolve(__dirname, "../HomeContent.tsx"), "utf8");
        expect(src).not.toMatch(/card-gallery|video-gallery|\[cards\]|\[vgallery\]/);
    });
});
