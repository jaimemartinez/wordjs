/**
 * Site Health's plugin-sandbox checks speak every admin language, and their one-click fixes are wired.
 *
 * The backend (core/site-health pluginSandboxChecks) sends checks with an `action` the panel runs for the
 * administrator: on Windows, applying the private network ranges for apps (Windows then asks for an
 * administrator on the server); everywhere, accepting a plugin's changed files. The panel shows the action
 * as a button, POSTs it, and runs the checks again.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { translations, type Language } from "@/lib/i18n";
import "@/app/admin/site-health/page";

const LANGS: Language[] = ["es", "en", "pt"];
const KEYS = [
    "siteHealth.check.security.pluginNetwork.title",
    "siteHealth.check.security.pluginNetwork.ok",
    "siteHealth.check.security.pluginNetwork.missing",
    "siteHealth.check.security.pluginSecrets.title",
    "siteHealth.check.security.pluginSecrets.exposed",
    "siteHealth.check.background.pluginFiles.title",
    "siteHealth.check.background.pluginFiles.changed",
    "siteHealth.check.security.pluginPorts.title",
    "siteHealth.check.security.pluginPorts.unavailable",
    "siteHealth.action.applyWindowsNetwork",
    "siteHealth.action.acceptPluginFiles",
];

describe("Site Health — plugin sandbox checks", () => {
    it("every new check and action label exists in es, en and pt", () => {
        for (const lang of LANGS) {
            for (const key of KEYS) expect(translations[lang][key], `${lang}: ${key}`).toBeTruthy();
        }
        expect(translations.es["siteHealth.action.applyWindowsNetwork"]).not.toBe(translations.en["siteHealth.action.applyWindowsNetwork"]);
    });

    it("keeps the placeholders the backend fills", () => {
        for (const lang of LANGS) {
            expect(translations[lang]["siteHealth.check.background.pluginFiles.changed"]).toContain("{slug}");
            expect(translations[lang]["siteHealth.check.security.pluginSecrets.exposed"]).toContain("{count}");
        }
    });

    it("renders an action as a button that POSTs its endpoint and runs the checks again", () => {
        const src = fs.readFileSync(path.resolve(__dirname, "../site-health/page.tsx"), "utf8");
        expect(src).toMatch(/action\?: \{ endpoint: string; label: string; labelKey\?: string; body\?: Record<string, string> \}/);
        expect(src).toMatch(/await apiPost\(c\.action\.endpoint, c\.action\.body \|\| \{\}\);[\s\S]{0,200}await run\(\);/);
        expect(src).toMatch(/\{c\.action && c\.status !== "ok" && \(/);
        expect(src).toMatch(/data-testid=\{`site-health-action-\$\{c\.id\}`\}/);
    });
});
