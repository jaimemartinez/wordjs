/**
 * The mid-action second factor (components/MfaStepUp.tsx): what the backend asks for while minting an API
 * token or an AI agent connection, granting one, or managing 2FA past the account's invalid-code ceiling.
 *
 *   • the two "ask for more" answers are recognised, and nothing else is (a real failure stays an error);
 *   • a request carries ONLY what was asked for, never an empty field;
 *   • the fields render only once asked, the password one as type=password;
 *   • the three screens are wired to it, and every string it uses exists in all three catalogues.
 *
 * No DOM environment in this project: the logic is pure functions and the markup is rendered statically.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/contexts/I18nContext", () => { const i18n = ({ t: (k: string) => k, language: "en", setLanguage: () => undefined }); return { useI18n: () => i18n, useOptionalI18n: () => i18n }; });

import { stepUpAsk, stepUpPayload, MfaStepUpFields, type MfaStepUp } from "../MfaStepUp";
import { translations } from "@/lib/i18n";

const fake = (over: Partial<MfaStepUp>): MfaStepUp => ({
    needsCode: false, needsPassword: false, sudo: false, code: "", password: "",
    setCode: () => undefined, setPassword: () => undefined,
    absorb: () => false, payload: () => ({}), reset: () => undefined,
    ...over,
});

describe("stepUpAsk", () => {
    it("recognises the answers that ask for more input", () => {
        expect(stepUpAsk("rest_mfa_step_up_required")).toBe("code");
        expect(stepUpAsk("rest_mfa_password_required")).toBe("password");
        // A sensitive action confirmed with the caller's own password (and then a code with 2FA).
        expect(stepUpAsk("rest_sudo_required")).toBe("password");
    });
    it("treats every other answer as a real failure", () => {
        for (const c of ["rest_mfa_invalid", "rest_bad_current_password", "rest_mfa_required_for_tokens", "rest_forbidden", undefined, null, 403]) {
            expect(stepUpAsk(c), String(c)).toBeNull();
        }
    });
});

describe("stepUpPayload", () => {
    it("sends nothing until something was asked for", () => {
        expect(stepUpPayload({ needsCode: false, needsPassword: false, code: "123456", password: "pw" })).toEqual({});
    });
    it("sends the trimmed code once asked, and never an empty one", () => {
        expect(stepUpPayload({ needsCode: true, needsPassword: false, code: " 123456 ", password: "pw" })).toEqual({ mfaCode: "123456" });
        expect(stepUpPayload({ needsCode: true, needsPassword: false, code: "   ", password: "" })).toEqual({});
    });
    it("adds the password (verbatim) only once the ceiling asked for it", () => {
        expect(stepUpPayload({ needsCode: true, needsPassword: true, code: "123456", password: " pw " }))
            .toEqual({ mfaCode: "123456", currentPassword: " pw " });
        expect(stepUpPayload({ needsCode: false, needsPassword: true, code: "", password: "" })).toEqual({});
    });
});

describe("MfaStepUpFields", () => {
    it("renders nothing until the server asked", () => {
        expect(renderToStaticMarkup(<MfaStepUpFields stepUp={fake({})} codeHelp="help" />)).toBe("");
    });
    it("renders the code field with its help once a step-up is required", () => {
        const html = renderToStaticMarkup(<MfaStepUpFields stepUp={fake({ needsCode: true })} codeHelp="the help" />);
        expect(html).toContain('"one-time-code"');
        expect(html).toContain("the help");
        expect(html).toContain("tokens.stepUpLabel");
        expect(html).not.toContain('type="password"');
    });
    it("adds a password field once the ceiling is reached", () => {
        const html = renderToStaticMarkup(<MfaStepUpFields stepUp={fake({ needsCode: true, needsPassword: true })} codeHelp="h" />);
        expect(html).toContain('type="password"');
        expect(html).toContain("stepUp.passwordLabel");
        expect(html).toContain("stepUp.passwordHelp");
    });
    it("a sudo confirmation explains itself as one, not as the invalid-code ceiling", () => {
        const html = renderToStaticMarkup(<MfaStepUpFields stepUp={fake({ needsPassword: true, sudo: true })} />);
        expect(html).toContain('type="password"');
        expect(html).toContain("stepUp.sudoHelp");
        expect(html).not.toContain("stepUp.passwordHelp");
        // ...and the code it may ask for next carries its own help when the screen gave none.
        expect(renderToStaticMarkup(<MfaStepUpFields stepUp={fake({ needsPassword: true, needsCode: true, sudo: true })} />)).toContain("stepUp.codeHelp");
    });
    it("withCode={false} shows only the password (the 2FA screen has its own code field)", () => {
        const html = renderToStaticMarkup(<MfaStepUpFields stepUp={fake({ needsCode: true, needsPassword: true })} withCode={false} />);
        expect(html).toContain('type="password"');
        expect(html).not.toContain("tokens.stepUpLabel");
        expect(renderToStaticMarkup(<MfaStepUpFields stepUp={fake({ needsCode: true })} withCode={false} />)).toBe("");
    });
});

describe("wiring", () => {
    const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, "../..", rel), "utf8");

    it("the token, agent and 2FA screens all use the shared step-up", () => {
        for (const rel of ["app/admin/tokens/page.tsx", "app/admin/agents/page.tsx", "components/MfaSetup.tsx"]) {
            const s = src(rel);
            expect(s, rel).toMatch(/useMfaStepUp\(\)/);
            expect(s, rel).toMatch(/<MfaStepUpFields\b/);
            expect(s, rel).toMatch(/\.absorb\(e\)/);
        }
        // Both agent actions — create AND grant — carry their own step-up payload.
        const agents = src("app/admin/agents/page.tsx");
        expect(agents).toMatch(/\.\.\.createStepUp\.payload\(\)/);
        expect(agents).toMatch(/agentsApi\.grant\([^;]*grantStepUp\.payload\(\)\)/);
        // Turning publish confirmation off carries one too.
        expect(agents).toMatch(/agentsApi\.setPublishConfirmation\([^;]*confirmationStepUp\.payload\(\)/);
    });

    it("authority over privileged accounts goes through the shared step-up on every screen that exercises it", () => {
        for (const rel of ["app/admin/users/UserFormModal.tsx", "app/admin/users/[id]/page.tsx", "app/admin/users/UserMfaReset.tsx", "app/admin/users/page.tsx", "app/admin/settings/media-storage/page.tsx"]) {
            const s = src(rel);
            expect(s, rel).toMatch(/useMfaStepUp\(\)/);
            expect(s, rel).toMatch(/<MfaStepUpFields\b/);
            expect(s, rel).toMatch(/\.absorb\(e(rror)?\)/);
            expect(s, rel).toMatch(/\.payload\(\)/);
        }
        // The Redis screen reuses its own current-password field.
        expect(src("app/admin/settings/RedisServerPanel.tsx")).toMatch(/rest_sudo_required/);
    });

    it("every string the step-up uses exists in every catalogue", () => {
        const keys = ["tokens.stepUpLabel", "tokens.stepUpPlaceholder", "tokens.stepUpHelp", "stepUp.passwordLabel", "stepUp.passwordHelp", "agents.stepUpHelp",
            "stepUp.sudoHelp", "stepUp.codeHelp", "apiError.rest_sudo_required", "agents.confirmationTurnOff", "settings.redisServer.testNeedsPassword"];
        for (const [lang, table] of Object.entries(translations)) {
            for (const k of keys) expect(table[k], `${lang}:${k}`).toBeTruthy();
        }
    });
});
