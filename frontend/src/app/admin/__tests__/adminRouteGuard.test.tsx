import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE ADMIN LAYOUT ENFORCES THE ROUTE GUARD (lib/adminAccess.ts).
 *
 * The decision itself is pinned in lib/__tests__/adminAccess.test.ts; these cases pin that the layout
 * actually applies it: a page the user may not open is NEVER rendered (not even for one frame before
 * the redirect), a page they may open is, the editor's fullscreen bypass still renders, and the MFA
 * enrolment screen still wins over everything (the guard runs after the auth/MFA gates).
 *
 * The project has no DOM test environment, so this renders to static markup — which is exactly the
 * question asked: what does the layout produce for this user on this path.
 */

const state = vi.hoisted(() => ({
    pathname: "/admin",
    auth: {} as any,
    menu: { pluginMenus: [] as any[], isLoading: false, refreshMenus: async () => undefined },
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: () => undefined, push: () => undefined }),
    usePathname: () => state.pathname,
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => state.auth, AuthProvider: ({ children }: any) => children }));
vi.mock("@/contexts/MenuContext", () => ({ useMenu: () => state.menu, MenuProvider: ({ children }: any) => children }));
vi.mock("@/contexts/I18nContext", () => ({ useI18n: () => ({ t: (k: string) => k }), I18nProvider: ({ children }: any) => children }));
vi.mock("@/components/Sidebar", () => ({ default: () => null }));
vi.mock("@/components/NotificationCenter", () => ({ default: () => null }));
vi.mock("@/components/MfaSetup", () => ({ default: () => React.createElement("div", null, "MFA-ENROLMENT") }));
vi.mock("@/lib/plugins", () => ({ initPlugins: () => undefined }));

import { DashboardLayoutContent } from "../DashboardLayoutClient";

const CM_ITEM = { href: "/admin/plugin/conference-manager", label: "Conference", icon: "x", cap: "conference_manager_access", plugin: "conference-manager", order: 1 };

function asUser(role: string, capabilities: string[], extra: any = {}) {
    state.auth = {
        user: { id: 1, username: role, email: "", displayName: role, role, capabilities, ...extra },
        isLoading: false, logout: () => undefined, refreshUser: async () => undefined,
        can: (c: string) => role === "administrator" || capabilities.includes("*") || capabilities.includes(c),
    };
}

const render = (pathname: string) => {
    state.pathname = pathname;
    return renderToStaticMarkup(<DashboardLayoutContent><p>PAGE-CONTENT</p></DashboardLayoutContent>);
};

beforeEach(() => {
    state.menu = { pluginMenus: [], isLoading: false, refreshMenus: async () => undefined };
});

describe("the admin layout applies the route guard", () => {
    it("never renders a core screen for a plugin team member", () => {
        asUser("conference_manager_team", ["read", "access_admin_panel", "conference_manager_access"]);
        state.menu.pluginMenus = [CM_ITEM];
        for (const p of ["/admin/users", "/admin/settings", "/admin", "/admin/posts/3"]) {
            expect(render(p), p).not.toContain("PAGE-CONTENT");
        }
    });

    it("renders the plugin's page and the account page for that member", () => {
        asUser("conference_manager_team", ["read", "access_admin_panel", "conference_manager_access"]);
        state.menu.pluginMenus = [CM_ITEM];
        expect(render("/admin/plugin/conference-manager")).toContain("PAGE-CONTENT");
        expect(render("/admin/account")).toContain("PAGE-CONTENT");
    });

    it("holds a plugin page back while the plugin menu is still loading", () => {
        asUser("conference_manager_team", ["read", "access_admin_panel", "conference_manager_access"]);
        state.menu = { pluginMenus: [], isLoading: true, refreshMenus: async () => undefined };
        expect(render("/admin/plugin/conference-manager")).not.toContain("PAGE-CONTENT");
    });

    it("an administrator gets every page, even before the plugin menu has loaded", () => {
        asUser("administrator", ["*"]);
        state.menu = { pluginMenus: [], isLoading: true, refreshMenus: async () => undefined };
        for (const p of ["/admin", "/admin/users/roles", "/admin/plugin/anything", "/admin/settings/site-address"]) {
            expect(render(p), p).toContain("PAGE-CONTENT");
        }
    });

    it("an editor keeps the editor's fullscreen route, and loses an admin-only screen", () => {
        asUser("editor", ["read", "access_admin_panel", "edit_posts", "edit_pages", "upload_files"]);
        expect(render("/admin/posts/12")).toContain("PAGE-CONTENT");
        expect(render("/admin")).toContain("PAGE-CONTENT");
        expect(render("/admin/users")).not.toContain("PAGE-CONTENT");
    });

    it("the MFA enrolment screen still comes first", () => {
        asUser("conference_manager_team", ["read", "access_admin_panel"], { mfa: { enforced: true, enabled: false } });
        const html = render("/admin/users");
        expect(html).toContain("MFA-ENROLMENT");
        expect(html).not.toContain("PAGE-CONTENT");
    });
});
