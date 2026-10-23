/**
 * The sign-in screens on the admin form kit (form-kit batch 1).
 *
 * The kit's buttons default to type="button", so a form whose submit was not made explicit would stop
 * submitting: Enter in a field and a click on «Sign in» would both do nothing. For every form of these
 * screens: exactly one explicit submit inside it, every other button type="button", and every field a
 * kit field (data-wjs-control) whose label is tied to it.
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

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
vi.mock("@/contexts/AuthContext", () => ({
    AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useAuth: () => ({ login: async () => undefined, verifyMfa: async () => undefined, user: null, loading: false }),
}));

const { I18nProvider } = await import("@/contexts/I18nContext");
const { default: ResetPasswordPage } = await import("@/app/reset-password/page");
const { default: RegisterPage } = await import("@/app/register/page");
const { default: LoginPage } = await import("@/app/login/page");

const render = (el: React.ReactElement) => renderToStaticMarkup(<I18nProvider initialLanguage="en">{el}</I18nProvider>);

/** Each <form>…</form> of the page (these screens never nest forms). */
const formsOf = (html: string) => html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
const tagsOf = (html: string, tag: string) => html.match(new RegExp(`<${tag}\\b[^>]*>`, "g")) ?? [];
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

function expectKitForm(html: string, screen: string) {
    const forms = formsOf(html);
    expect(forms.length, `${screen}: a form`).toBeGreaterThan(0);
    for (const form of forms) {
        const buttons = tagsOf(form, "button");
        const submits = buttons.filter((b) => attr(b, "type") === "submit");
        expect(submits, `${screen}: exactly one explicit submit per form`).toHaveLength(1);
        for (const b of buttons) expect(["submit", "button"], `${screen}: ${b}`).toContain(attr(b, "type"));
        for (const input of tagsOf(form, "input").filter((i) => attr(i, "type") !== "hidden")) {
            expect(input, `${screen}: a kit field`).toContain('data-wjs-control=""');
            const id = attr(input, "id");
            expect(id, `${screen}: ${input}`).toBeTruthy();
            expect(form, `${screen}: the label of #${id}`).toContain(`for="${id}"`);
        }
    }
}

describe("the sign-in screens' forms still submit, on the kit", () => {
    it("/login — sign in", () => {
        const html = render(<LoginPage />);
        expectKitForm(html, "login");
        expect(html).toMatch(/<button type="submit"[^>]*>(?:(?!<\/button>)[\s\S])*Login<\/span><\/button>/);
        // The eye is a named, pressed-state toggle, never a submit.
        expect(html).toMatch(/<button type="button" aria-label="Show password"[^>]*aria-pressed="false"/);
    });

    it("/register", () => {
        expectKitForm(render(<RegisterPage />), "register");
    });

    it("/reset-password — request a link, and set a new password", () => {
        search = new URLSearchParams();
        expectKitForm(render(<ResetPasswordPage />), "reset (request)");
        search = new URLSearchParams("uid=1&token=t");
        const html = render(<ResetPasswordPage />);
        expectKitForm(html, "reset (new password)");
        expect(html).toMatch(/id="reset-password"[^>]*required=""|required=""[^>]*id="reset-password"/);
        search = new URLSearchParams();
    });
});
