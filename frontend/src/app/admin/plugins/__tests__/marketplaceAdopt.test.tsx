import { describe, it, expect } from "vitest";
import React from "react";
import fs from "fs";
import path from "path";
import { renderToStaticMarkup } from "react-dom/server";
import type { MarketplaceEntry } from "@/lib/api";
import { AdoptDialogContent, adoptRequest } from "../MarketplaceTab";
import { t as translate, translations } from "@/lib/i18n";

/**
 * "WHY DO I HAVE TO UNINSTALL A PLUGIN TO UPDATE IT?" — IT NO LONGER DOES.
 *
 * A plugin installed by upload, or from another catalog, used to show "uninstall it and reinstall it from
 * the catalog". Now it gets one button. What these cases pin is what that button must not do silently:
 * carry over the old permissions (the dialog's ticks ARE the grants), move the plugin to another source
 * without saying so (both sources are named, and the request carries the confirmation), or hand the data
 * to code from elsewhere without asking (an explicit keep-data box, with a warning for a plugin that asks
 * for a high-risk permission).
 */

const en = (key: string) => translate(key, "en");
const entry = (over: Partial<MarketplaceEntry> = {}): MarketplaceEntry => ({
    id: "mail-server", name: "Mail server", version: "3.3.0", description: "", author: "", category: "Email",
    permissions: [{ scope: "database", access: "write" }, { scope: "network" }],
    hasAdminPage: true, blockName: null, adminMenu: null, file: "mail-server-3.3.0.zip", size: 2048, sha256: "x",
    source: "https://catalog.two/download", installed: true, active: true, installedVersion: "3.2.0",
    updateAvailable: true, updatable: false, installedFrom: "https://catalog.one/download", applyMode: "reinstall",
    ...over,
});
const html = (e: MarketplaceEntry, ticked: Record<string, boolean>, keepData = true) => renderToStaticMarkup(
    <AdoptDialogContent entry={e} ticked={ticked} keepData={keepData} onTick={() => {}} onKeepData={() => {}} onCancel={() => {}} onConfirm={() => {}} t={en} />
);

describe("adopt / reinstall from the Marketplace", () => {
    it("the request carries only the ticked permissions, never the previous ones", () => {
        expect(adoptRequest({ applyMode: "adopt" }, { "database:write": true, network: false }, true))
            .toEqual({ mode: "adopt", grants: ["database:write"] });
        expect(adoptRequest({ applyMode: "reinstall" }, { "database:write": false, network: false }, false))
            .toEqual({ mode: "reinstall", grants: [], keepData: false, confirmSourceChange: true });
    });

    it("a source change names both sources, asks about the data and warns for a high-risk plugin", () => {
        const out = html(entry(), { "database:write": true, network: true });
        expect(out).toContain("data-source-change");
        expect(out).toContain("https://catalog.one/download");
        expect(out).toContain("https://catalog.two/download");
        expect(out).toContain(`name="keep-data"`);
        expect(out).toContain("data-keep-data-warning");
        expect(out).toContain(en("plugins.marketplace.reinstall"));
        // Unticked: no warning (the data is not handed over).
        expect(html(entry(), {}, false)).not.toContain("data-keep-data-warning");
        // A copy with no recorded source says so instead of an empty "From".
        expect(html(entry({ installedFrom: null }), {})).toContain(en("plugins.marketplace.sourceUpload"));
    });

    it("adopting from the official catalog keeps the data without asking, and still asks for every permission", () => {
        const out = html(entry({ applyMode: "adopt", installedFrom: null, source: "https://github.com/jaimemartinez/wordjs/releases/latest/download" }), { "database:write": true, network: false });
        expect(out).not.toContain("data-source-change");
        expect(out).not.toContain(`name="keep-data"`);
        expect(out).toContain(en("plugins.marketplace.adoptNote"));
        expect((out.match(/type="checkbox"/g) || []).length).toBe(2);
        expect(out).toMatch(/name="grant-database:write"[^>]*checked=""|checked=""[^>]*name="grant-database:write"/);
        expect(out).not.toMatch(/name="grant-network"[^>]*checked=""|checked=""[^>]*name="grant-network"/);
    });

    it("every new string exists in es, en and pt, and the tab no longer tells anyone to uninstall", () => {
        for (const key of ["reinstallFromSource", "adoptHint", "reinstallHint", "confirmAdopt", "adoptNote", "confirmReinstall",
            "sourceChange", "sourceFrom", "sourceTo", "sourceUpload", "reinstallNote", "approvePermissions", "noPermissions",
            "keepData", "keepDataHelp", "keepDataSensitive", "reinstall", "adopted", "reinstalled", "reinstallFailed", "updateAvailable"]) {
            for (const lang of ["es", "en", "pt"] as const) expect(translations[lang][`plugins.marketplace.${key}`], `${lang} ${key}`).toBeTruthy();
        }
        const src = fs.readFileSync(path.resolve(__dirname, "../MarketplaceTab.tsx"), "utf8");
        expect(src).not.toContain("reinstallToUpdate");
    });
});
