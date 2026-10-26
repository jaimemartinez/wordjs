import { describe, it, expect } from "vitest";
import React from "react";
import fs from "fs";
import path from "path";
import { renderToStaticMarkup } from "react-dom/server";
import ExistingDataDialog, { existingDataFrom } from "../ExistingDataDialog";
import { translations, t as translate } from "@/lib/i18n";

/**
 * RE-UPLOADING A PLUGIN OVER DATA A PREVIOUS UNINSTALL KEPT ASKS FIRST.
 *
 * The backend answers 409 `existing_plugin_data` (slug, dataDir, tables) instead of silently adopting
 * plugins/<slug>/data/ and the wjp_<slug>_* tables. The Plugins screen shows this dialog — the project's
 * own DialogLayer, never a native confirm — with "keep and reconnect" and "discard and start clean", and
 * re-sends the same zip with `existingData`.
 */
const REFUSAL = {
    status: 409,
    code: "existing_plugin_data",
    data: { slug: "kept-data", dataDir: true, tables: ["wjp_kept_data_items", "wjp_kept_data_log"] },
};

describe("existingDataFrom", () => {
    it("reads the leftovers of a 409 existing_plugin_data, and nothing else", () => {
        expect(existingDataFrom(REFUSAL)).toEqual({ slug: "kept-data", dataDir: true, tables: ["wjp_kept_data_items", "wjp_kept_data_log"] });
        expect(existingDataFrom({ ...REFUSAL, code: "plugin_exists" })).toBeNull();
        expect(existingDataFrom({ ...REFUSAL, status: 400 })).toBeNull();
        expect(existingDataFrom({ ...REFUSAL, data: {} })).toBeNull();
        expect(existingDataFrom(null)).toBeNull();
        expect(existingDataFrom({ ...REFUSAL, data: { slug: "x", tables: [1, "wjp_x_a"] } })).toEqual({ slug: "x", dataDir: false, tables: ["wjp_x_a"] });
    });
});

describe("ExistingDataDialog", () => {
    const t = (k: string) => translate(k, "en");

    it("names the plugin, lists what was found and offers both choices plus cancel", () => {
        const html = renderToStaticMarkup(
            <ExistingDataDialog prompt={existingDataFrom(REFUSAL)!} pending={null} onChoose={() => undefined} onCancel={() => undefined} t={t} />,
        );
        expect(html).toContain("kept-data");
        expect(html).toContain("wjp_kept_data_items");
        expect(html).toContain("wjp_kept_data_log");
        expect(html).toContain(t("plugins.existingData.dataDir"));
        expect(html).toContain(t("plugins.existingData.adopt"));
        expect(html).toContain(t("plugins.existingData.discard"));
        expect(html).toContain(t("cancel"));
        expect(html).toContain('role="dialog"');
    });

    it("its strings exist in es, en and pt", () => {
        for (const lang of ["es", "en", "pt"] as const) {
            for (const k of ["title", "body", "dataDir", "tables", "warning", "adopt", "discard", "working"]) {
                expect(translations[lang][`plugins.existingData.${k}`], `${lang} ${k}`).toBeTruthy();
            }
            expect(translations[lang]["plugins.existingData.body"]).toContain("{slug}");
            expect(translations[lang]["plugins.existingData.tables"]).toContain("{count}");
        }
    });

    it("the Plugins screen re-sends the zip with the choice and never uses a native dialog for it", () => {
        const page = fs.readFileSync(path.join(__dirname, "..", "page.tsx"), "utf8");
        expect(page).toContain("formData.append('existingData', existingData)");
        expect(page).toContain("<ExistingDataDialog");
        const dialog = fs.readFileSync(path.join(__dirname, "..", "ExistingDataDialog.tsx"), "utf8");
        expect(dialog).not.toMatch(/window\.(alert|confirm|prompt)\(/);
    });
});
