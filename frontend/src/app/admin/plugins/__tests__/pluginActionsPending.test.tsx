/**
 * Admin → Plugins: a lifecycle action that is still waiting for the server says so and cannot be
 * clicked again. Activating a plugin takes seconds (it starts a sandboxed process) and the button used
 * to stay enabled with no sign of progress, which invited a second activation.
 */
import { describe, expect, it } from "vitest";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { t, type Language } from "@/lib/i18n";
import { PENDING_LABEL_KEY, PendingLabel, PluginToggleButton, type PluginPendingAction } from "../PluginActionButtons";

const tr = (lang: Language) => (key: string) => t(key, lang);
const toggle = (props: { active: boolean; pending?: PluginPendingAction }, lang: Language = "en") =>
    renderToStaticMarkup(<PluginToggleButton {...props} onClick={() => undefined} t={tr(lang)} />);

describe("plugin lifecycle buttons while an action is pending", () => {
    it("idle: Activate / Deactivate, enabled", () => {
        const off = toggle({ active: false });
        expect(off).toContain("Activate");
        expect(off).not.toMatch(/\sdisabled=""/);
        expect(toggle({ active: true })).toContain("Deactivate");
    });

    it("activating: disabled, busy, a spinner and «Activating…» in the admin's language", () => {
        const en = toggle({ active: false, pending: "activating" });
        expect(en).toMatch(/\sdisabled=""/);
        expect(en).toContain('aria-busy="true"');
        expect(en).toContain("animate-spin");
        expect(en).toContain("Activating…");
        expect(toggle({ active: false, pending: "activating" }, "es")).toContain("Activando…");
        expect(toggle({ active: false, pending: "activating" }, "pt")).toContain("Ativando…");
    });

    it("deactivating and deleting disable the toggle too and name what is running", () => {
        expect(toggle({ active: true, pending: "deactivating" }, "es")).toContain("Desactivando…");
        const deleting = toggle({ active: true, pending: "deleting" });
        expect(deleting).toMatch(/\sdisabled=""/);
        expect(deleting).toContain("Deleting…");
    });

    it("a dialog's confirm label turns into the pending label", () => {
        expect(renderToStaticMarkup(<PendingLabel label="Activate" t={tr("en")} />)).toBe("Activate");
        expect(renderToStaticMarkup(<PendingLabel pending="deleting" label="Delete" t={tr("pt")} />)).toContain("Excluindo…");
    });

    it("every pending label exists in Spanish, English and Portuguese", () => {
        for (const key of Object.values(PENDING_LABEL_KEY)) {
            for (const lang of ["es", "en", "pt"] as Language[]) expect(t(key, lang), `${lang} ${key}`).not.toBe(key);
        }
    });

    it("the page runs every lifecycle action through the pending state and refuses a second click", () => {
        const page = readFileSync(resolve(__dirname, "../page.tsx"), "utf8");
        // Each action marks itself pending before calling the server and clears it in a finally.
        expect(page).toMatch(/startPending\(plugin\.slug, 'deactivating'\);\s+await pluginsApi\.deactivate/);
        expect(page).toMatch(/startPending\(plugin\.slug, 'activating'\);\s+try \{/);
        expect(page).toMatch(/startPending\(slug, 'deleting'\);\s+try \{/);
        expect((page.match(/finally \{\s+(?:if \(plugin\.active\) )?endPending\(/g) || []).length).toBe(3);
        // A click while the same plugin's action runs is ignored, not queued.
        expect(page).toMatch(/const togglePlugin = async \(plugin: Plugin\) => \{\s+if \(pendingAction\[plugin\.slug\]\) return;/);
        expect(page).toMatch(/if \(!pluginToActivate \|\| pendingAction\[pluginToActivate\.slug\]\) return;/);
        expect(page).toMatch(/if \(!pluginToDelete \|\| !password \|\| pendingAction\[pluginToDelete\.slug\]\) return;/);
        // The buttons read it: the card toggle, both dialogs' confirm (and cancel) buttons, the card's delete.
        expect(page).toContain("pending={pendingAction[plugin.slug]}");
        expect(page).toContain("disabled={!!activatePending}");
        expect(page).toContain("disabled={!password || !!deletePending}");
        expect(page).toContain("disabled={!!pendingAction[plugin.slug]}");
    });
});
