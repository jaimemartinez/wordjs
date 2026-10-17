/**
 * Admin screens that spoke Spanish to an English admin, or gave no feedback at all — found while writing
 * the lab-tested tutorials for 2.6.0.
 *
 *   - Plugins → Marketplace and its install dialog were hard-coded Spanish (loading text, categories,
 *     "Instalar", "Bloque …", the source line, "Permisos que solicitará", "Cancelar").
 *   - The orphaned-plugin card and its cleanup toasts were hard-coded Spanish too.
 *   - The delete-plugin dialog read "…cannot be undone. Reading List?" — the name was glued after the
 *     sentence with a "?".
 *   - The bundled themes' descriptions were not translatable, and Circuito's was Spanish.
 *   - The webhook delivery log read SQL UTC timestamps as local time.
 *   - A restore reloaded the page a second later, throwing away the only feedback it gave.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getStoredLanguage, translations, type Language } from "@/lib/i18n";
import { I18nProvider } from "@/contexts/I18nContext";
import { ReviewPill, categoryLabel } from "@/app/admin/plugins/MarketplaceTab";
import { brokenReasonText } from "@/app/admin/plugins/page";
import { serverTimestampMs, formatServerTimestamp } from "@/lib/serverTimestamp";

const LANGS: Language[] = ["es", "en", "pt"];
const ROOT = path.resolve(__dirname, "../../../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const tIn = (lang: Language) => (key: string) => translations[lang][key] || translations.en[key] || key;

describe("the new admin strings exist in every admin language", () => {
    const prefixes = ["plugins.marketplace.", "plugins.broken.", "backups.restored.", "backups.restoring", "mediaStorage.cspPending", "mediaStorage.test.publicHint"];
    const keysOf = (lang: Language) => Object.keys(translations[lang]).filter((k) => prefixes.some((p) => k.startsWith(p))).sort();

    it("es, en and pt carry the same keys", () => {
        expect(keysOf("en").length).toBeGreaterThan(60);
        expect(keysOf("es")).toEqual(keysOf("en"));
        expect(keysOf("pt")).toEqual(keysOf("en"));
    });

    it("the English copy is English", () => {
        expect(translations.en["plugins.marketplace.loading"]).toBe("Loading the catalog…");
        expect(translations.en["plugins.marketplace.install"]).toBe("Install");
        expect(translations.en["plugins.marketplace.requestedPermissions"]).toBe("Permissions it will request");
        expect(translations.en["plugins.marketplace.cancel"]).toBe("Cancel");
    });
});

describe("Marketplace tab", () => {
    it("has no hard-coded Spanish left in its markup or toasts", () => {
        const src = read("frontend/src/app/admin/plugins/MarketplaceTab.tsx");
        for (const s of ["Cargando el catálogo", "\"Instalar\"", "> Instalar<", "Bloque {", "Permisos que solicitará", ">Cancelar<", "\"Todos\"", "Fuente: ", "Los plugins se instalan", "Sin resultados", "Reintentar"]) {
            expect(src, s).not.toContain(s);
        }
    });

    it("translates the categories the official catalog publishes and passes unknown ones through", () => {
        expect(categoryLabel("Comercio", tIn("en"))).toBe("Commerce");
        expect(categoryLabel("Contenido", tIn("en"))).toBe("Content");
        expect(categoryLabel("Comercio", tIn("es"))).toBe("Comercio");
        expect(categoryLabel("Formularios", tIn("pt"))).toBe("Formulários");
        expect(categoryLabel("Astrology", tIn("en"))).toBe("Astrology");
    });

    it("the review pill speaks the admin's language inside the admin and English on its own", () => {
        const bare = renderToStaticMarkup(<ReviewPill review={{ status: "unreviewed" }} official />);
        expect(bare).toContain("Unreviewed");
        // I18nProvider renders its server default (es) before reading the stored choice.
        const inAdmin = renderToStaticMarkup(<I18nProvider><ReviewPill review={{ status: "unreviewed" }} official /></I18nProvider>);
        expect(inAdmin).toContain(translations.es["plugins.marketplace.review.unreviewed"]);
        expect(inAdmin).toContain(translations.es["plugins.marketplace.review.sandboxNote"]);
    });
});

describe("Plugins page", () => {
    it("the delete confirmation is one sentence with the plugin's name inside it", () => {
        for (const lang of LANGS) {
            const msg = translations[lang]["plugins.delete.message"];
            expect(msg, lang).toContain("{name}");
            expect(msg.trim().endsWith("{name}"), lang).toBe(false);
        }
        expect(read("frontend/src/app/admin/plugins/page.tsx")).not.toContain("{pluginToDelete?.name}</strong>?");
    });

    it("the broken-plugin copy follows the language it is given", () => {
        expect(brokenReasonText({ brokenReason: "missing" }, tIn("en"))).toBe("Incomplete install — the plugin files are missing");
        expect(brokenReasonText({ brokenReason: "unreadable-manifest" }, tIn("en"))).toMatch(/manifest\.json/);
        expect(brokenReasonText({}, tIn("pt"))).toMatch(/Instalação incompleta/);
    });
});

describe("bundled theme metadata", () => {
    const themes = ["default", "circuito", "gaceta", "vergel"];

    it("every bundled theme has an English description and Spanish and Portuguese translations", () => {
        for (const slug of themes) {
            const json = JSON.parse(read(`backend/themes/${slug}/theme.json`));
            expect(json.description, slug).not.toMatch(/[ñáíóú]|Terminal oscuro/);
            expect(json.translations?.es?.description, slug).toBeTruthy();
            expect(json.translations?.pt?.description, slug).toBeTruthy();
        }
    });

    it("the admin theme card picks the translation for its language", () => {
        expect(read("frontend/src/app/admin/themes/page.tsx")).toContain("theme.translations?.[language]?.description");
    });
});

describe("server timestamps", () => {
    it("reads SQL CURRENT_TIMESTAMP text as UTC, not local time", () => {
        expect(serverTimestampMs("2026-10-17 12:14:00")).toBe(Date.UTC(2026, 9, 17, 12, 14, 0));
        expect(serverTimestampMs("2026-10-17T12:14:00")).toBe(Date.UTC(2026, 9, 17, 12, 14, 0));
    });

    it("leaves zoned strings alone and reads numbers as epoch seconds", () => {
        expect(serverTimestampMs("2026-10-17T12:14:00.000Z")).toBe(Date.UTC(2026, 9, 17, 12, 14, 0));
        expect(serverTimestampMs("2026-10-17T12:14:00+02:00")).toBe(Date.UTC(2026, 9, 17, 10, 14, 0));
        expect(serverTimestampMs(1_760_000_000)).toBe(1_760_000_000_000);
    });

    it("shows a dash when there is nothing to show", () => {
        expect(formatServerTimestamp(null)).toBe("—");
        expect(formatServerTimestamp("not a date")).toBe("—");
    });

    it("the webhook log uses it for both the delivery rows and the last delivery", () => {
        expect(read("frontend/src/app/admin/webhooks/page.tsx")).toContain("const fmtDate = formatServerTimestamp;");
    });
});

describe("admin language with no stored choice", () => {
    const withPage = (stored: string | null, htmlLang: string | null, run: () => void) => {
        vi.stubGlobal("window", {});
        vi.stubGlobal("localStorage", { getItem: () => stored });
        vi.stubGlobal("document", { documentElement: { getAttribute: (name: string) => (name === "lang" ? htmlLang : null) } });
        try { run(); } finally { vi.unstubAllGlobals(); }
    };

    it("follows the site's language (<html lang>) instead of always Spanish", () => {
        withPage(null, "en", () => expect(getStoredLanguage()).toBe("en"));
        withPage(null, "pt-BR", () => expect(getStoredLanguage()).toBe("pt"));
        withPage(null, "es", () => expect(getStoredLanguage()).toBe("es"));
    });

    it("the admin's own choice still wins, and an unsupported site language falls back to Spanish", () => {
        withPage("es", "en", () => expect(getStoredLanguage()).toBe("es"));
        withPage(null, "fr", () => expect(getStoredLanguage()).toBe("es"));
        withPage(null, null, () => expect(getStoredLanguage()).toBe("es"));
    });
});

describe("backup restore feedback", () => {
    it("stays on the page with the restart instruction instead of reloading the toast away", () => {
        const src = read("frontend/src/app/admin/settings/backups/page.tsx");
        expect(src).not.toMatch(/setTimeout\(\(\) => \{\s*window\.location\.reload\(\)/);
        expect(src).toContain("t('backups.restored.body')");
        for (const lang of LANGS) {
            expect(translations[lang]["backups.restored.body"], lang).toContain("{filename}");
        }
    });
});
