import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE ADMIN SHELL NEVER OFFERS A LINK THE ROUTE GUARD REFUSES (lib/adminAccess.ts).
 *
 * With the layout guard in place, a link to a screen the user may not open does not just land on an
 * empty page any more: it unmounts the current screen behind the full-screen spinner and bounces back.
 * Pinned here: the dashboard's shortcuts and comment links, the sidebar's logo, and the pages screens'
 * own gates (which must ask for the capability the guard asks for, or a role is bounced twice). The
 * layout's decision for a user held at two-factor enrolment is pinned too: nothing is decided for them.
 *
 * No DOM test environment in this project: static markup is exactly the question — what is rendered.
 */

const state = vi.hoisted(() => ({
    auth: {} as any,
    menu: { pluginMenus: [] as any[], isLoading: false, refreshMenus: async () => undefined },
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: () => undefined, push: () => undefined }),
    usePathname: () => "/admin",
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => state.auth, AuthProvider: ({ children }: any) => children }));
vi.mock("@/contexts/MenuContext", () => ({ useMenu: () => state.menu, MenuProvider: ({ children }: any) => children }));
vi.mock("@/contexts/I18nContext", () => ({ useI18n: () => ({ t: (k: string) => k, language: "es", setLanguage: () => undefined }), I18nProvider: ({ children }: any) => children }));
vi.mock("@/lib/api", () => ({
    postsApi: { list: async () => [] }, usersApi: { list: async () => [] }, commentsApi: { list: async () => [] },
    systemApi: { getStatus: async () => null }, api: async () => [], settingsApi: { get: async () => ({}) },
}));
vi.mock("recharts", () => {
    const Box = ({ children }: any) => React.createElement("div", null, children);
    return { AreaChart: Box, Area: Box, XAxis: Box, YAxis: Box, CartesianGrid: Box, Tooltip: Box, ResponsiveContainer: Box };
});
vi.mock("@/components/NotificationCenter", () => ({ default: () => null }));
vi.mock("@/components/SmartLink", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("@/components/ContentTable", () => ({ default: () => React.createElement("div", null, "CONTENT-TABLE") }));

import DashboardPage from "../page";
import Sidebar from "@/components/Sidebar";
import PagesPage from "../pages/page";
import { layoutRouteDecision } from "../DashboardLayoutClient";
import { STAT_GRID_COLS, dashboardMainSpanClass } from "@/lib/dashboardStats";

const CM_ITEM = { href: "/admin/plugin/conference-manager", label: "Conference", icon: "x", cap: "conference_manager_access", plugin: "conference-manager", order: 1 };

function asUser(role: string, capabilities: string[], extra: any = {}) {
    state.auth = {
        user: { id: 1, username: role, email: "", displayName: role, role, capabilities, ...extra },
        isLoading: false, logout: () => undefined, refreshUser: async () => undefined,
        can: (c: string) => role === "administrator" || capabilities.includes("*") || capabilities.includes(c),
    };
}
const hrefs = (html: string) => Array.from(html.matchAll(/href="([^"]+)"/g)).map((m) => m[1]);

const CONTRIBUTOR = ["read", "access_admin_panel", "edit_posts", "delete_posts"];
const AUTHOR = ["read", "access_admin_panel", "upload_files", "edit_posts", "edit_published_posts", "publish_posts", "delete_posts", "delete_published_posts"];
const EDITOR = [...AUTHOR, "edit_others_posts", "delete_others_posts", "edit_pages", "edit_others_pages", "edit_published_pages", "publish_pages",
    "delete_pages", "delete_others_pages", "delete_published_pages", "manage_categories", "moderate_comments"];

describe("the dashboard offers only shortcuts the user may open", () => {
    it("a contributor: new post only — no new page, no media, no users, no comments", () => {
        asUser("contributor", CONTRIBUTOR);
        const links = hrefs(renderToStaticMarkup(<DashboardPage />));
        expect(links).toContain("/admin/posts/new");
        for (const refused of ["/admin/pages/new", "/admin/media", "/admin/users/new", "/admin/comments"]) expect(links).not.toContain(refused);
    });

    it("an author also gets media; an editor also pages and comments (and still no users)", () => {
        asUser("author", AUTHOR);
        expect(hrefs(renderToStaticMarkup(<DashboardPage />))).toEqual(expect.arrayContaining(["/admin/posts/new", "/admin/media"]));
        asUser("editor", EDITOR);
        const links = hrefs(renderToStaticMarkup(<DashboardPage />));
        expect(links).toEqual(expect.arrayContaining(["/admin/posts/new", "/admin/pages/new", "/admin/media", "/admin/comments"]));
        expect(links).not.toContain("/admin/users/new");
    });

    it("an administrator keeps every shortcut", () => {
        asUser("administrator", ["*"]);
        expect(hrefs(renderToStaticMarkup(<DashboardPage />)))
            .toEqual(expect.arrayContaining(["/admin/posts/new", "/admin/pages/new", "/admin/media", "/admin/users/new", "/admin/comments"]));
    });
});

describe("the dashboard shows only the numbers and panels its viewer can read", () => {
    const stats = (html: string) => Array.from(html.matchAll(/data-dashboard-stat="([^"]+)"/g)).map((m) => m[1]);
    // The stat grid's columns follow its own width (lib/dashboardStats.ts), from the classes for N cards.
    const statGrid = (html: string) => /<div class="@container"><div class="grid ([^"]*) gap-6" data-dashboard-stats="">/.exec(html)?.[1];

    it("an editor: no users count (they cannot list users) and no activity chart (administrators only)", () => {
        asUser("editor", EDITOR);
        const html = renderToStaticMarkup(<DashboardPage />);
        expect(stats(html)).toEqual(["posts", "pages", "comments"]);
        expect(html).not.toContain("nav.users");
        expect(html).not.toContain("data-dashboard-activity-chart");
        expect(html).toContain("data-dashboard-recent-comments");
        expect(statGrid(html)).toBe(STAT_GRID_COLS[3]);
    });

    it("a contributor: no comments count and no comments panel either", () => {
        asUser("contributor", CONTRIBUTOR);
        const html = renderToStaticMarkup(<DashboardPage />);
        expect(stats(html)).toEqual(["posts", "pages"]);
        expect(html).not.toContain("data-dashboard-recent-comments");
        expect(html).toContain(dashboardMainSpanClass(false));
        expect(statGrid(html)).toBe(STAT_GRID_COLS[2]);
    });

    it("an administrator keeps all four counts, the chart and the comments panel", () => {
        asUser("administrator", ["*"]);
        const html = renderToStaticMarkup(<DashboardPage />);
        expect(stats(html)).toEqual(["posts", "pages", "comments", "users"]);
        expect(html).toContain("data-dashboard-activity-chart");
        expect(html).toContain("data-dashboard-recent-comments");
        expect(statGrid(html)).toBe(STAT_GRID_COLS[4]);
    });
});

describe("the sidebar's logo leads to a page the user may open", () => {
    const logoHref = () => {
        const html = renderToStaticMarkup(<Sidebar isOpen={false} onClose={() => undefined} />);
        return /<a href="([^"]+)"[^>]*data-sidebar-home=""/.exec(html)?.[1];
    };

    it("the dashboard for whoever may open it", () => {
        state.menu = { pluginMenus: [CM_ITEM], isLoading: false, refreshMenus: async () => undefined };
        asUser("administrator", ["*"]);
        expect(logoHref()).toBe("/admin");
        asUser("author", AUTHOR);
        expect(logoHref()).toBe("/admin");
    });

    it("the plugin's screen for its team member, the account page for a subscriber", () => {
        state.menu = { pluginMenus: [CM_ITEM], isLoading: false, refreshMenus: async () => undefined };
        asUser("conference_manager_team", ["read", "access_admin_panel", "conference_manager_access"]);
        expect(logoHref()).toBe("/admin/plugin/conference-manager");
        state.menu = { pluginMenus: [], isLoading: false, refreshMenus: async () => undefined };
        asUser("subscriber", ["read", "access_admin_panel"]);
        expect(logoHref()).toBe("/admin/account");
    });
});

describe("the sidebar (desktop and phone menu) draws no heading over an empty section", () => {
    const render = () => renderToStaticMarkup(<Sidebar isOpen={true} onClose={() => undefined} />);

    it("a team member after roles:declare was revoked: «Usuarios › Cuenta» only, no bare «Contenido»", () => {
        state.menu = { pluginMenus: [], isLoading: false, refreshMenus: async () => undefined };
        asUser("conference_manager_team", ["read", "access_admin_panel"]);
        const html = render();
        expect(html).not.toContain("nav.section.content");
        expect(html).not.toContain('data-sidebar-section="content"');
        expect(html).toContain("nav.section.people");
        expect(hrefs(html)).toContain("/admin/account");
    });

    it("an administrator gets the task groups; an editor only the ones it has entries in", () => {
        state.menu = { pluginMenus: [CM_ITEM], isLoading: false, refreshMenus: async () => undefined };
        asUser("administrator", ["*"]);
        const admin = render();
        for (const g of ["content", "appearance", "people", "plugins", "settings", "advanced"]) expect(admin, g).toContain(`nav.section.${g}`);
        asUser("editor", [...EDITOR]);
        const editor = render();
        expect(editor).toContain("nav.section.content");
        expect(editor).toContain("nav.section.people");
    });
});

describe("the pages screen asks for the capability the route guard asks for (edit_pages)", () => {
    it("a role with edit_pages and without edit_posts gets the screen (no second bounce)", () => {
        asUser("pages_only", ["read", "access_admin_panel", "edit_pages"]);
        expect(renderToStaticMarkup(<PagesPage />)).toContain("CONTENT-TABLE");
    });

    it("a contributor (edit_posts, no edit_pages) does not", () => {
        asUser("contributor", CONTRIBUTOR);
        expect(renderToStaticMarkup(<PagesPage />)).toBe("");
    });
});

describe("phones: the Roles screen's delete button is reachable without a mouse", () => {
    it("is visible by default and hidden only where the screen can hover (a leftover plugin role is deleted there)", async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const src = fs.readFileSync(path.resolve(__dirname, "../users/roles/page.tsx"), "utf8");
        const cls = /<div className="([^"]*)" data-role-actions=\{slug\}>/.exec(src)?.[1] || "";
        const tokens = cls.split(/\s+/);
        expect(tokens).toEqual(expect.arrayContaining(["opacity-100", "[@media(hover:hover)]:opacity-0", "group-hover:opacity-100", "focus-within:opacity-100"]));
        expect(tokens).not.toContain("opacity-0");
    });
});

describe("the layout decides nothing for a user held at two-factor enrolment", () => {
    it("no redirect away from a plugin page while the plugin menu cannot load (the API answers 403 then)", () => {
        const team = { id: 1, role: "conference_manager_team", capabilities: ["read", "access_admin_panel", "conference_manager_access"] };
        const blocked = { ...team, mfa: { enforced: true, enabled: false } };
        expect(layoutRouteDecision({ user: blocked, pathname: "/admin/plugin/conference-manager", pluginMenus: [], menusLoading: false })).toEqual({ kind: "allow" });
        expect(layoutRouteDecision({ user: blocked, pathname: "/admin", pluginMenus: [], menusLoading: false })).toEqual({ kind: "allow" });
        // Once enrolled the guard decides again (positive control).
        const enrolled = { ...team, mfa: { enforced: true, enabled: true } };
        expect(layoutRouteDecision({ user: enrolled, pathname: "/admin/users", pluginMenus: [CM_ITEM], menusLoading: false }))
            .toEqual({ kind: "redirect", to: "/admin/plugin/conference-manager" });
        expect(layoutRouteDecision({ user: enrolled, pathname: "/admin/plugin/conference-manager", pluginMenus: [], menusLoading: true })).toEqual({ kind: "wait" });
    });
});
