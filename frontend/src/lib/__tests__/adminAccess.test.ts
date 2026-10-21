import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
    ACCOUNT_PATH,
    ADMIN_ROUTE_RULES,
    CORE_MENU_ITEMS,
    canOpenAdminPath,
    decideAdminRoute,
    firstAllowedAdminPath,
    ruleFor,
    sidebarSections,
    visibleSidebarSections,
    type AdminAccessUser,
    type AdminMenuItem,
} from "../adminAccess";

/**
 * THE ADMIN ROUTE GUARD — "a page you cannot see in the menu is a page you cannot open".
 *
 * The admin layout used to check `access_admin_panel` only, so anyone signed in to the admin could type
 * the URL of any screen. A plugin-declared role (conference-manager's team role) is meant to open the
 * plugin's page and the user's own account and NOTHING else; these cases pin that, and pin just as hard
 * that every existing role keeps exactly the pages it had (administrators everything, editors the
 * editorial screens, subscribers their account), with no redirect loop anywhere.
 */

const CM_ITEM: AdminMenuItem = {
    href: "/admin/plugin/conference-manager", label: "Conference", icon: "fa-calendar",
    cap: "conference_manager_access", plugin: "conference-manager", section: "core",
};

const admin: AdminAccessUser = { role: "administrator", capabilities: ["*"] };
const editor: AdminAccessUser = {
    role: "editor",
    capabilities: ["read", "access_admin_panel", "upload_files", "edit_posts", "edit_others_posts", "edit_published_posts",
        "publish_posts", "delete_posts", "edit_pages", "edit_others_pages", "publish_pages", "delete_pages",
        "manage_categories", "moderate_comments"],
};
const author: AdminAccessUser = { role: "author", capabilities: ["read", "access_admin_panel", "upload_files", "edit_posts", "publish_posts", "delete_posts"] };
const subscriber: AdminAccessUser = { role: "subscriber", capabilities: ["read", "access_admin_panel"] };
const teamMember: AdminAccessUser = { role: "conference_manager_team", capabilities: ["read", "access_admin_panel", "conference_manager_access"] };

const decide = (pathname: string, user: AdminAccessUser, pluginMenus: AdminMenuItem[] = [CM_ITEM], menusLoaded = true) =>
    decideAdminRoute({ pathname, user, pluginMenus, menusLoaded });

describe("a plugin team member (read, access_admin_panel, conference_manager_access)", () => {
    // The server sends a plugin menu item only to holders of its capability (GET /plugins/menus).
    const menus = [CM_ITEM];

    it("lands on the plugin's page when opening /admin — after the menu has loaded", () => {
        expect(decide("/admin", teamMember, menus, false)).toEqual({ kind: "wait" });
        expect(decide("/admin", teamMember, menus)).toEqual({ kind: "redirect", to: "/admin/plugin/conference-manager" });
    });

    it("opens the plugin's page and their own account", () => {
        expect(decide("/admin/plugin/conference-manager", teamMember, menus)).toEqual({ kind: "allow" });
        expect(decide(ACCOUNT_PATH, teamMember, menus, false)).toEqual({ kind: "allow" });
    });

    it("cannot open any core screen, nor another plugin's page", () => {
        for (const p of ["/admin/users", "/admin/users/7", "/admin/users/roles", "/admin/settings", "/admin/settings/site-address",
            "/admin/plugins", "/admin/posts", "/admin/posts/12", "/admin/pages/3", "/admin/media", "/admin/tokens",
            "/admin/notices", "/admin/plugin/mail-server", "/admin/does-not-exist"]) {
            expect(decide(p, teamMember, menus), p).toEqual({ kind: "redirect", to: "/admin/plugin/conference-manager" });
        }
    });

    it("sees only the plugin entry and the account entry in the sidebar", () => {
        const { core, management } = sidebarSections(teamMember, menus);
        expect([...core, ...management].map((i) => i.href)).toEqual(["/admin/plugin/conference-manager", ACCOUNT_PATH]);
    });

    it("a plugin menu item can never open a CORE page, whatever capability it names", () => {
        const sneaky: AdminMenuItem = { href: "/admin/users?type=team", label: "Team", icon: "x", cap: "conference_manager_access", plugin: "conference-manager" };
        expect(canOpenAdminPath("/admin/users", teamMember, [CM_ITEM, sneaky])).toBe(false);
        const { core, management } = sidebarSections(teamMember, [CM_ITEM, sneaky]);
        expect([...core, ...management].map((i) => i.href)).not.toContain("/admin/users?type=team");
    });

    it("without the plugin's menu item (plugin inactive, or the role revoked) lands on the account page", () => {
        expect(decide("/admin", teamMember, [])).toEqual({ kind: "redirect", to: ACCOUNT_PATH });
        expect(decide("/admin/plugin/conference-manager", teamMember, [])).toEqual({ kind: "redirect", to: ACCOUNT_PATH });
    });
});

describe("existing roles keep exactly the pages they had", () => {
    it("an administrator opens everything — even a plugin page with no menu item, without waiting for the menu", () => {
        for (const p of ["/admin", "/admin/users/roles", "/admin/settings/site-address", "/admin/plugin/anything", "/admin/notices", "/admin/verso-lab"]) {
            expect(decide(p, admin, [], false), p).toEqual({ kind: "allow" });
        }
    });

    it("a '*' holder that is not the administrator role is treated the same", () => {
        expect(decide("/admin/plugin/x", { role: "superuser", capabilities: ["*"] }, [], false)).toEqual({ kind: "allow" });
    });

    it("an editor opens the dashboard and the editorial screens at once, editor fullscreen routes included", () => {
        for (const p of ["/admin", "/admin/posts", "/admin/posts/12", "/admin/pages/3", "/admin/media", "/admin/comments",
            "/admin/categories", "/admin/tags", "/admin/canvas-frame", "/admin/verso-lab", ACCOUNT_PATH]) {
            expect(decide(p, editor, [], false), p).toEqual({ kind: "allow" });
        }
    });

    it("an editor is sent to the dashboard from an admin-only screen", () => {
        expect(decide("/admin/users", editor, [])).toEqual({ kind: "redirect", to: "/admin" });
        expect(decide("/admin/settings", editor, [])).toEqual({ kind: "redirect", to: "/admin" });
    });

    it("an author keeps posts but not pages", () => {
        expect(decide("/admin/posts/4", author, [], false)).toEqual({ kind: "allow" });
        expect(decide("/admin/pages/4", author, [])).toEqual({ kind: "redirect", to: "/admin" });
    });

    it("a subscriber still lands on their account page (what the dashboard used to do for them)", () => {
        expect(decide("/admin", subscriber, [])).toEqual({ kind: "redirect", to: ACCOUNT_PATH });
        expect(decide(ACCOUNT_PATH, subscriber, [])).toEqual({ kind: "allow" });
    });

    it("the account page is open even to a role without `read` (MFA enrolment links there)", () => {
        const bare: AdminAccessUser = { role: "kiosk", capabilities: ["access_admin_panel"] };
        expect(decide(ACCOUNT_PATH, bare, [], false)).toEqual({ kind: "allow" });
        expect(decide("/admin", bare, [])).toEqual({ kind: "redirect", to: ACCOUNT_PATH });
    });

    it("a page outside /admin is not this guard's business", () => {
        expect(decide("/login", subscriber, [], false)).toEqual({ kind: "allow" });
    });

    it("the sidebar of an editor is what it was: core entries by capability", () => {
        const { core, management } = sidebarSections(editor, []);
        expect(core.map((i) => i.href)).toEqual(["/admin", "/admin/posts", "/admin/pages", "/admin/media"]);
        expect(management.map((i) => i.href)).toEqual(["/admin/comments", "/admin/categories", "/admin/tags", ACCOUNT_PATH]);
    });

    it("plugin entries keep their section and their capability filter", () => {
        const mgmt: AdminMenuItem = { href: "/admin/plugin/mail", label: "Mail", icon: "x", cap: "read", plugin: "mail-server", section: "management" };
        const hidden: AdminMenuItem = { href: "/admin/plugin/store", label: "Store", icon: "x", cap: "manage_options", plugin: "online-store" };
        const { core, management } = sidebarSections(editor, [mgmt, hidden]);
        expect(management[0].href).toBe("/admin/plugin/mail");
        expect([...core, ...management].map((i) => i.href)).not.toContain("/admin/plugin/store");
        expect(firstAllowedAdminPath(editor, [mgmt])).toBe("/admin");
    });
});

describe("no redirect loop, ever", () => {
    const users: AdminAccessUser[] = [admin, editor, author, subscriber, teamMember, { role: "x", capabilities: [] }, { role: "y" }];
    const menuSets: AdminMenuItem[][] = [[], [CM_ITEM], [CM_ITEM, { href: "/admin/plugin/mail", label: "M", icon: "i", cap: "read", plugin: "mail", section: "management" }]];
    const paths = ["/admin", ACCOUNT_PATH, ...ADMIN_ROUTE_RULES.map((r) => r.path), "/admin/plugin/conference-manager", "/admin/plugin/nope", "/admin/zzz"];

    it("every redirect target is a page the same user may open", () => {
        for (const user of users) for (const menus of menuSets) for (const p of paths) {
            const d = decide(p, user, menus);
            if (d.kind === "redirect") {
                expect(decide(d.to.split("?")[0], user, menus), `${user.role} ${p} -> ${d.to}`).toEqual({ kind: "allow" });
                expect(d.to.split("?")[0]).not.toBe(p);
            }
            expect(d.kind).not.toBe("wait"); // menus loaded: always decided
        }
    });

    it("never lands anyone outside the admin, whatever a plugin's menu item links to", () => {
        // The backend accepts any same-origin href for a plugin menu item ("/portal/x", "/"). Such an item
        // stays a sidebar link, but it must never become where signing in or a refused page sends someone.
        const outside: AdminMenuItem[] = [
            { href: "/portal/conference", label: "Portal", icon: "i", cap: "conference_manager_access", plugin: "conference-manager", section: "core", order: 0 },
            { href: "/", label: "Home", icon: "i", cap: "read", plugin: "x", section: "core", order: 0 },
        ];
        for (const user of users) for (const menus of [outside, [...outside, CM_ITEM]]) for (const p of paths) {
            const d = decide(p, user, menus);
            if (d.kind === "redirect") expect(d.to.startsWith("/admin"), `${user.role} ${p} -> ${d.to}`).toBe(true);
        }
        expect(firstAllowedAdminPath(teamMember, [...outside, CM_ITEM])).toBe("/admin/plugin/conference-manager");
        expect(firstAllowedAdminPath(subscriber, outside)).toBe(ACCOUNT_PATH);
        expect(sidebarSections(teamMember, outside).core.map((i) => i.href)).toContain("/portal/conference");
    });
});

describe("the route map", () => {
    it("covers every admin page of the app (a new screen cannot ship unguarded by accident)", () => {
        const adminDir = path.resolve(__dirname, "../../app/admin");
        const pages: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.isDirectory()) { if (e.name !== "__tests__") walk(path.join(dir, e.name)); }
                // [...missing] is the admin 404 (it only calls notFound()): an address no screen answers.
                // It has no rule on purpose — the guard sends a non-wildcard user to their own home.
                else if (e.name === "page.tsx" && path.basename(dir) !== "[...missing]") pages.push(dir);
            }
        };
        walk(adminDir);
        const routes = pages
            .map((d) => "/admin" + path.relative(adminDir, d).split(path.sep).map((s) => (s.startsWith("[") ? "1" : s)).filter(Boolean).map((s) => "/" + s).join(""))
            .filter((r) => !r.startsWith("/admin/plugin/") && r !== ACCOUNT_PATH);
        expect(routes.length).toBeGreaterThan(30);
        const unguarded = routes.filter((r) => !ruleFor(r));
        expect(unguarded).toEqual([]);
    });

    it("an address no admin screen answers: an administrator sees the panel's 404, anyone else goes home", () => {
        const admin: AdminAccessUser = { role: "administrator", capabilities: ["*"] };
        const editor: AdminAccessUser = { role: "editor", capabilities: ["read", "access_admin_panel", "edit_posts", "edit_others_posts", "edit_pages"] };
        expect(decideAdminRoute({ pathname: "/admin/no-such-page", user: admin, pluginMenus: [], menusLoaded: true })).toEqual({ kind: "allow" });
        expect(decideAdminRoute({ pathname: "/admin/no-such-page", user: editor, pluginMenus: [], menusLoaded: true }).kind).toBe("redirect");
    });

    it("every core sidebar entry is decided by the capability it is shown for", () => {
        for (const item of CORE_MENU_ITEMS) {
            const rule = ruleFor(item.href.split("?")[0]);
            expect(rule, item.href).not.toBeNull();
            expect(rule!.anyOf, item.href).toContain(item.cap);
        }
    });
});

describe("the sidebar never draws a heading over an empty section", () => {
    const teamMember: AdminAccessUser = { role: "conference_manager_team", capabilities: ["read", "access_admin_panel"] };

    it("a plugin team member whose plugin lost roles:declare: only «Sistema › Cuenta», no bare «Principal»", () => {
        // The grant was revoked: the role confers only read/access_admin_panel and the server's plugin
        // menu no longer lists the plugin's entry for them.
        const sections = visibleSidebarSections(teamMember, []);
        expect(sections.map((s) => s.key)).toEqual(["management"]);
        expect(sections[0].labelKey).toBe("nav.sectionSystem");
        expect(sections[0].items.map((i) => i.href)).toEqual([ACCOUNT_PATH]);
    });

    it("with its grant: the plugin entry under «Principal», the account under «Sistema»", () => {
        const sections = visibleSidebarSections({ ...teamMember, capabilities: [...teamMember.capabilities!, "conference_manager_access"] }, [CM_ITEM]);
        expect(sections.map((s) => [s.key, s.items.map((i) => i.href)])).toEqual([
            ["core", ["/admin/plugin/conference-manager"]],
            ["management", [ACCOUNT_PATH]],
        ]);
    });

    it("every existing role keeps both sections exactly as sidebarSections lists them", () => {
        for (const user of [admin, editor, author, subscriber]) {
            const { core, management } = sidebarSections(user, []);
            const sections = visibleSidebarSections(user, []);
            expect(sections.find((s) => s.key === "core")?.items ?? []).toEqual(core);
            expect(sections.find((s) => s.key === "management")?.items ?? []).toEqual(management);
            expect(sections.every((s) => s.items.length > 0)).toBe(true);
        }
        // A subscriber has no core-section entry either.
        expect(visibleSidebarSections(subscriber, []).map((s) => s.key)).toEqual(["management"]);
        expect(visibleSidebarSections(admin, []).map((s) => s.key)).toEqual(["core", "management"]);
    });
});
