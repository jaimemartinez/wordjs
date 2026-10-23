import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { needsNewerCore } from "../MarketplaceTab";
import PluginNeedsNewerWordjs from "@/components/PluginNeedsNewerWordjs";
import { missingHostModule, remotePluginFailureComponent, PluginBundleError } from "@/lib/pluginBundleLoader";
import { translations, t as translate } from "@/lib/i18n";

/**
 * A PLUGIN BUILT FOR A NEWER WORDJS IS NEITHER OFFERED NOR SHOWN AS A BLANK SCREEN (FALLOS 150).
 *
 * The Marketplace card of a version this install cannot run (backend `compatible: false`) offers no install
 * or update button, only "Requires WordJS ≥ X — update WordJS first" and a link to Updates. And when a
 * plugin's admin bundle does reach this core anyway (uploaded before the check, or the core was rolled
 * back), the shim's "WordJS host did not provide …" error becomes a notice naming the WordJS it needs,
 * instead of a blank page or "temporarily unavailable".
 */
const SHIM_ERROR = new Error('WordJS host did not provide globalThis.WordJS.host && globalThis.WordJS.host["components/ui/DatePicker"] — plugin bundle cannot run');

describe("Marketplace card", () => {
    it("withholds install and update for an incompatible version, keeps the Installed badge when nothing newer applies", () => {
        expect(needsNewerCore({ compatible: false, installed: false, updateAvailable: false })).toBe(true);
        expect(needsNewerCore({ compatible: false, installed: true, updateAvailable: true })).toBe(true);
        expect(needsNewerCore({ compatible: false, installed: true, updateAvailable: false })).toBe(false);
        expect(needsNewerCore({ compatible: true, installed: false, updateAvailable: false })).toBe(false);
        expect(needsNewerCore({ installed: false, updateAvailable: false }), "an older backend sends no flag: nothing is blocked").toBe(false);
    });

    it("its text exists in es, en and pt and names the version", () => {
        for (const lang of ["es", "en", "pt"] as const) {
            expect(translations[lang]["plugins.marketplace.needsNewerCore"]).toContain("{version}");
            expect(translations[lang]["plugins.marketplace.goToUpdates"]).toBeTruthy();
            for (const k of ["title", "titleUnknown", "body", "bodyAskAdmin", "link"]) expect(translations[lang][`plugins.needsNewerCore.${k}`], `${lang} ${k}`).toBeTruthy();
        }
        expect(translations.es["plugins.marketplace.needsNewerCore"]).toBe("Requiere WordJS ≥ {version} — actualiza WordJS primero");
    });
});

describe("plugin loader: a bundle that needs a newer WordJS", () => {
    it("recognises the shim's error and the module it names, and nothing else", () => {
        expect(missingHostModule(SHIM_ERROR)).toBe("components/ui/DatePicker");
        expect(missingHostModule(new Error("Unexpected token <"))).toBeNull();
        expect(missingHostModule(null)).toBeNull();
    });

    it("renders the 'needs WordJS ≥ X' notice, not the generic fallback", () => {
        const err = new PluginBundleError({ slug: "conference-manager", bundleType: "admin", reason: "core-too-old", status: 200, pluginId: "conference-manager", minWordjs: "2.10.0", message: "x" });
        const Fallback = () => null;
        const Component = remotePluginFailureComponent(err, Fallback);
        expect(Component).not.toBe(Fallback);
        const html = renderToStaticMarkup(React.createElement(Component));
        expect(html).toContain('data-wjs-plugin-needs-newer-core="conference-manager"');
        expect(html).toContain("2.10.0");
    });

    it("without a declared minimum, it still says a newer WordJS is needed", () => {
        const html = renderToStaticMarkup(<PluginNeedsNewerWordjs pluginId="x" minWordjs={null} />);
        expect(html).toContain(translate("plugins.needsNewerCore.titleUnknown"));
    });
});
