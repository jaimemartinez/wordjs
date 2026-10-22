/**
 * The sign-in screens render in the language the server chose (I18nProvider's `initialLanguage`, set
 * by the shared shell from the cookie or the site's language). /reset-password was English-only,
 * /register and /verify-email Spanish-only, whatever the visitor's language.
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Language } from "@/lib/i18n";

let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, replace: () => undefined }),
    useSearchParams: () => search,
    usePathname: () => "/",
}));
vi.mock("@/lib/api", () => ({
    authApi: { passwordResetAvailable: () => new Promise(() => undefined), verifyEmail: () => new Promise(() => undefined) },
    settingsApi: { get: () => new Promise(() => undefined) },
}));

const { I18nProvider } = await import("@/contexts/I18nContext");
const { default: ResetPasswordPage } = await import("@/app/reset-password/page");
const { default: RegisterPage } = await import("@/app/register/page");
const { default: VerifyEmailPage } = await import("@/app/verify-email/page");

const render = (lang: Language, el: React.ReactElement) =>
    renderToStaticMarkup(<I18nProvider initialLanguage={lang}>{el}</I18nProvider>);

describe("sign-in screens follow the server's language from the first render", () => {
    it("/reset-password — request a link", () => {
        search = new URLSearchParams();
        expect(render("en", <ResetPasswordPage />)).toContain("Send reset link");
        const es = render("es", <ResetPasswordPage />);
        expect(es).toContain("Enviar el enlace");
        expect(es).not.toMatch(/Password Recovery|Send Reset Link/);
    });

    it("/reset-password — set a new password", () => {
        search = new URLSearchParams("uid=1&token=t");
        const pt = render("pt", <ResetPasswordPage />);
        expect(pt).toContain("Redefinir a senha");
        expect(pt).toContain('for="reset-password"');
    });

    it("/register", () => {
        expect(render("en", <RegisterPage />)).toContain("Create an account");
        expect(render("es", <RegisterPage />)).toContain("Crear una cuenta");
        expect(render("en", <RegisterPage />)).not.toContain("Nombre de usuario");
    });

    it("/verify-email", () => {
        search = new URLSearchParams();
        expect(render("en", <VerifyEmailPage />)).toContain("Incomplete link");
        expect(render("es", <VerifyEmailPage />)).toContain("Enlace incompleto");
    });

    it("without a server language the provider starts from the fallback, never from a guess", () => {
        search = new URLSearchParams();
        const html = renderToStaticMarkup(<I18nProvider><ResetPasswordPage /></I18nProvider>);
        expect(html).toContain("Enviar el enlace");
    });
});
