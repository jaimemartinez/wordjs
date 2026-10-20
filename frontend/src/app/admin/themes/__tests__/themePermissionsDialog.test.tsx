import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/contexts/I18nContext";
import { translations } from "@/lib/i18n";
import type { ThemePermissions } from "@/lib/api";
import ThemePermissionsDialog, { initialThemeGrants } from "../ThemePermissionsDialog";

/**
 * THE THEME PERMISSIONS DIALOG: the theme requests (theme.json `permissions`), the administrator grants.
 *
 * What the activation dialog starts with switched on decides what one click on "Activate theme" grants, so
 * it mirrors the server's model: a theme whose grants an administrator already decided starts from that
 * decision (a revoke survives activating it again); the first time, what the theme may hold starts on. A
 * permission a theme cannot hold is shown, explained and impossible to switch on.
 */

const ES = translations.es;
const render = (node: React.ReactElement) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);

const data = (over: Partial<ThemePermissions> = {}): ThemePermissions => ({
    slug: "lumbre",
    hasLogic: true,
    declared: [
        { token: "settings:read", scope: "settings", access: "read", reason: "Muestra el nombre del sitio", grantable: true, granted: false },
        { token: "posts:read", scope: "posts", access: "read", reason: "", grantable: true, granted: false },
        { token: "database:write", scope: "database", access: "write", reason: "", grantable: false, granted: false, problem: "not_available_to_themes" },
    ],
    granted: [],
    decided: false,
    logic: null,
    ...over,
});

describe("initialThemeGrants", () => {
    it("never decided: every permission the theme may hold starts on, the others never", () => {
        expect(Array.from(initialThemeGrants(data())).sort()).toEqual(["posts:read", "settings:read"]);
    });
    it("decided: the administrator's decision, including a revoke of everything", () => {
        expect(Array.from(initialThemeGrants(data({ decided: true, granted: ["posts:read"] })))).toEqual(["posts:read"]);
        expect(Array.from(initialThemeGrants(data({ decided: true, granted: [] })))).toEqual([]);
    });
    it("a stale grant the theme no longer declares is not offered as on", () => {
        expect(Array.from(initialThemeGrants(data({ decided: true, granted: ["ai:use"] })))).toEqual([]);
    });
});

describe("ThemePermissionsDialog", () => {
    const html = render(<ThemePermissionsDialog themeName="Lumbre" data={data({ logic: { state: "blocked", reason: "needs filesystem:write" } })} mode="activate" busy={false} onCancel={() => {}} onConfirm={() => {}} />);

    it("lists every declared permission with a switch, and the theme's own reason", () => {
        expect(html).toContain('data-theme-permission-toggle="settings:read"');
        expect(html).toContain('data-theme-permission-toggle="posts:read"');
        expect(html).toContain("Muestra el nombre del sitio");
        expect(html).toContain(ES["themes.permissions.themeSays"]);
        expect(html).toContain(ES["themes.permissions.activateIntro"]);
        expect(html).toContain(ES["themes.permissions.activate"]);
    });
    it("a permission a theme cannot hold is disabled and says why", () => {
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-theme-permission-toggle="database:write"/);
        expect(html).toContain('data-theme-permission-problem="database:write"');
        expect(html).toContain(ES["themes.permissions.notAvailable"]);
    });
    it("says when the theme's code is not running, and why", () => {
        expect(html).toContain('data-theme-logic="blocked"');
        expect(html).toContain("needs filesystem:write");
    });
    it("the manage mode saves instead of activating", () => {
        const manage = render(<ThemePermissionsDialog themeName="Lumbre" data={data()} mode="manage" busy={false} onCancel={() => {}} onConfirm={() => {}} />);
        expect(manage).toContain(ES["themes.permissions.manageIntro"]);
        expect(manage).toContain(ES["themes.permissions.save"]);
        expect(manage).not.toContain(ES["themes.permissions.activate"]);
    });
});
