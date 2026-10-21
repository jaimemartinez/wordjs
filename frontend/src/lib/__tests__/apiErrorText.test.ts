/**
 * API errors are shown in the admin's language. The backend answers with a stable `code` and an English
 * `message`; screens used to show the message as it came, so a Spanish panel said «Invalid username or
 * password.». apiErrorText maps the code (or, for the class codes, the exact message) to the catalogue.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { t, translations, type Language } from "@/lib/i18n";
import { apiErrorText, asApiError } from "@/lib/apiErrorText";

const tr = (lang: Language) => (key: string) => t(key, lang);
const err = (code: string | undefined, message?: string, data?: Record<string, unknown>) =>
    Object.assign(new Error(message ?? ""), { code, data });

describe("apiErrorText", () => {
    it("translates a code into the admin's language", () => {
        const e = err("rest_invalid_credentials", "Invalid username or password.");
        expect(apiErrorText(tr("es"), e)).toBe("Usuario o contraseña incorrectos.");
        expect(apiErrorText(tr("pt"), e)).toBe("Usuário ou senha incorretos.");
        expect(apiErrorText(tr("en"), e)).toBe("Invalid username or password.");
    });

    it("fills in the login throttle's remaining minutes, singular and plural", () => {
        const two = err("rest_login_throttled", "Too many failed attempts…", { retryAfterMs: 90_000 });
        expect(apiErrorText(tr("es"), two)).toMatch(/en 2 minutos\.$/);
        const one = err("rest_login_throttled", "Too many failed attempts…", { retryAfterMs: 30_000 });
        expect(apiErrorText(tr("en"), one)).toMatch(/in 1 minute\.$/);
        // Without the number (the "simultaneous attempts" variant) the generic copy applies.
        expect(apiErrorText(tr("es"), err("rest_login_throttled", "Too many simultaneous attempts."))).toBe(
            "Demasiados intentos. Inténtalo de nuevo en un momento.",
        );
    });

    it("class codes (rest_forbidden, rest_invalid_param) are matched on the exact message", () => {
        const e = err("rest_forbidden", "Only an administrator can reset two-factor authentication on a privileged account.");
        expect(apiErrorText(tr("es"), e)).toMatch(/^Solo un administrador puede restablecer/);
        // A class code with an unlisted message keeps the server's words rather than a vague guess.
        expect(apiErrorText(tr("es"), err("rest_forbidden", "Something specific."))).toBe("Something specific.");
    });

    it("an unknown code shows the server's message; nothing at all shows the fallback key", () => {
        expect(apiErrorText(tr("es"), err("rest_brand_new", "Brand new failure."))).toBe("Brand new failure.");
        expect(apiErrorText(tr("es"), new Error(""), "login.invalidCredentials")).toBe(t("login.invalidCredentials", "es"));
        expect(apiErrorText(tr("es"), null, "mfa.invalidCode")).toBe(t("mfa.invalidCode", "es"));
    });

    it("reads a JSON body, an Error and a string alike", () => {
        expect(asApiError({ code: "x", message: "m", data: { a: 1 } })).toEqual({ code: "x", message: "m", data: { a: 1 } });
        expect(asApiError("plain")).toEqual({ message: "plain" });
        expect(asApiError(undefined)).toEqual({});
    });

    it("every apiError key exists in Spanish, English and Portuguese", () => {
        const keys = (lang: Language) => Object.keys(translations[lang]).filter((k) => k.startsWith("apiError.")).sort();
        expect(keys("es").length).toBeGreaterThan(40);
        expect(keys("en")).toEqual(keys("es"));
        expect(keys("pt")).toEqual(keys("es"));
    });

    it("the account screens no longer print a caught error's raw message", () => {
        const SRC = resolve(__dirname, "../..");
        for (const file of [
            "app/login/page.tsx",
            "app/reset-password/page.tsx",
            "app/admin/account/page.tsx",
            "app/admin/tokens/page.tsx",
            "app/admin/users/UserMfaReset.tsx",
            "components/MfaSetup.tsx",
        ]) {
            const src = readFileSync(resolve(SRC, file), "utf8");
            expect(src, file).not.toMatch(/(?:err|e|error|result)\??\.(?:message|error)\s*\|\|/);
        }
    });
});
