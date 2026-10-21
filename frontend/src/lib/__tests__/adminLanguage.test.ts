/**
 * The admin language is decided the same way on the server and in the browser: the stored choice
 * (cookie), else the site's language, else Spanish. The server used to know nothing of the choice, so
 * every sign-in screen rendered in Spanish and switched after hydration — and a fresh browser on an
 * English site started in Spanish.
 */
import { describe, expect, it } from "vitest";
import { ADMIN_LANGUAGE_COOKIE, adminLanguageCookie, adminLanguageFrom, asAdminLanguage } from "@/lib/adminLanguage";

describe("admin language", () => {
    it("the stored choice wins over the site's language", () => {
        expect(adminLanguageFrom("pt", "en-US")).toBe("pt");
        expect(adminLanguageFrom("en", "es_ES")).toBe("en");
    });

    it("with no choice stored, the site's language decides (WPLANG-style and BCP-47 alike)", () => {
        expect(adminLanguageFrom(undefined, "en-US")).toBe("en");
        expect(adminLanguageFrom(null, "pt_BR")).toBe("pt");
        expect(adminLanguageFrom("", "es")).toBe("es");
    });

    it("a language the admin is not translated into falls through, never reaching the provider", () => {
        expect(adminLanguageFrom("fr", "de-DE")).toBe("es");
        expect(adminLanguageFrom("<script>", "en")).toBe("en");
        expect(asAdminLanguage("EN")).toBe("en");
        expect(asAdminLanguage("xx")).toBeNull();
    });

    it("the cookie is site-wide, lasts a year and is never sent cross-site", () => {
        const c = adminLanguageCookie("en");
        expect(c.startsWith(`${ADMIN_LANGUAGE_COOKIE}=en;`)).toBe(true);
        expect(c).toContain("Path=/");
        expect(c).toContain("Max-Age=31536000");
        expect(c).toContain("SameSite=Lax");
    });
});
