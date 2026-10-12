import { describe, it, expect } from "vitest";
import { buildRoleOptions, roleDisplayName, roleNameFrom } from "../roleOptions";
import { translations } from "../i18n";
import type { Role } from "../api";

/**
 * THE ROLE DROPDOWNS OF THE USER FORMS list every role the site has.
 *
 * They were hardcoded to subscriber/author/editor/administrator, so neither a role an administrator
 * created in Users → Roles nor a role a plugin declared (conference-manager's team role) could be given
 * to anyone from the admin — the backend accepted them, the form never offered them.
 */

const t = (key: string) => translations.en[key] ?? key;

const ROLES: Record<string, Role> = {
    administrator: { name: "Administrator", capabilities: ["*"] },
    editor: { name: "Editor", capabilities: [] },
    author: { name: "Author", capabilities: [] },
    contributor: { name: "Contributor", capabilities: [] },
    subscriber: { name: "Subscriber", capabilities: [] },
    shop_manager: { name: "Shop manager", capabilities: ["read"] },
    conference_manager_team: {
        name: "Equipo de conferencia", capabilities: ["read", "access_admin_panel", "conference_manager_access"],
        source: "plugin", plugin: "conference-manager", pluginInstalled: true,
    },
    old_plugin_team: { name: "Old team", capabilities: ["read"], source: "plugin", plugin: "old-plugin", orphaned: true },
};

describe("buildRoleOptions", () => {
    it("lists core, administrator-made and plugin roles, grouped and labelled", () => {
        const options = buildRoleOptions(ROLES, t);
        expect(options.map((o) => o.value)).toEqual([
            "subscriber", "contributor", "author", "editor", "administrator",
            "shop_manager",
            "conference_manager_team", "old_plugin_team",
        ]);
        const byValue = Object.fromEntries(options.map((o) => [o.value, o]));
        expect(byValue.subscriber.group).toBe("Core roles");
        expect(byValue.contributor.label).toBe("Contributor");
        expect(byValue.shop_manager).toEqual({ value: "shop_manager", label: "Shop manager", group: "Custom roles" });
        expect(byValue.conference_manager_team).toEqual({
            value: "conference_manager_team", label: "Equipo de conferencia · plugin conference-manager", group: "Plugin roles",
        });
        expect(byValue.old_plugin_team.label).toBe("Old team · plugin old-plugin deleted");
    });

    it("translates the labels (Spanish)", () => {
        const es = (key: string) => translations.es[key] ?? key;
        const options = buildRoleOptions(ROLES, es);
        expect(options.find((o) => o.value === "subscriber")!.label).toBe("Suscriptor");
        expect(options.find((o) => o.value === "conference_manager_team")!.group).toBe("Roles de plugins");
    });

    it("falls back to the four roles the form always offered when the roles list cannot be read", () => {
        expect(buildRoleOptions(null, t).map((o) => o.value)).toEqual(["subscriber", "author", "editor", "administrator"]);
        // ...and keeps the edited user's current role selectable.
        expect(buildRoleOptions(null, t, "conference_manager_team").map((o) => o.value)).toContain("conference_manager_team");
    });

    it("keeps a current role that is no longer in the map selectable", () => {
        expect(buildRoleOptions(ROLES, t, "ghost_role").map((o) => o.value)).toContain("ghost_role");
    });
});

describe("roleDisplayName — the admin's user chip (Sidebar)", () => {
    // Live review: the chip showed the raw slug, «CONFERENCE_MANAGER_TEAM» for a plugin team member and
    // «ADMINISTRATOR» in the Spanish admin.
    const t = (key: string) => ({ "user.edit.roleAdministrator": "Administrador", "user.edit.roleEditor": "Editor" } as Record<string, string>)[key] ?? key;

    it("a core role in the admin's language", () => {
        expect(roleDisplayName({ role: "administrator", roleName: "Administrator" }, t)).toBe("Administrador");
    });
    it("a plugin or custom role by its own name (GET /auth/me roleName)", () => {
        expect(roleDisplayName({ role: "conference_manager_team", roleName: "Equipo de conferencia" }, t)).toBe("Equipo de conferencia");
    });
    it("the slug only when the name is unknown", () => {
        expect(roleDisplayName({ role: "conference_manager_team", roleName: null }, t)).toBe("conference_manager_team");
        expect(roleDisplayName({ role: "conference_manager_team", roleName: "   " }, t)).toBe("conference_manager_team");
        expect(roleDisplayName(null, t)).toBe("");
    });
    it("the account page's identity chip uses it (round 2: it showed «CONFERENCE_MANAGER_TEAM» while the sidebar said «EQUIPO DE CONFERENCIA»)", async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const src = fs.readFileSync(path.resolve(__dirname, "../../app/admin/account/page.tsx"), "utf8");
        expect(src).toMatch(/data-account-role="">\s*\{roleDisplayName\(user, t\)\}/);
        expect(src).not.toMatch(/\{user\?\.role\}/);
    });
    it("the Users list's Role column uses it, with the names GET /roles gives", async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const src = fs.readFileSync(path.resolve(__dirname, "../../app/admin/users/page.tsx"), "utf8");
        expect(src).toContain("label={roleDisplayName({ role: user.role, roleName: roleNameFrom(roles, user.role) }, t)}");
        expect(src).toContain("const roles = useRolesMap();");
        expect(src).not.toMatch(/label=\{user\.role\}/);
        expect(roleDisplayName({ role: "conference_manager_team", roleName: roleNameFrom(ROLES, "conference_manager_team") }, t)).toBe("Equipo de conferencia");
    });
    it("roleNameFrom: own keys only, trimmed, null when unknown", () => {
        expect(roleNameFrom(ROLES, "shop_manager")).toBe("Shop manager");
        expect(roleNameFrom(ROLES, "constructor")).toBeNull();
        expect(roleNameFrom(ROLES, "ghost")).toBeNull();
        expect(roleNameFrom(null, "shop_manager")).toBeNull();
        expect(roleNameFrom({ x: { name: "  ", capabilities: [] } }, "x")).toBeNull();
    });
    it("the sidebar chip uses it", async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const src = fs.readFileSync(path.resolve(__dirname, "../../components/Sidebar.tsx"), "utf8");
        expect(src).toContain("{roleDisplayName(user, t) || 'Member'}");
        expect(src).not.toMatch(/typeof user\?\.role === 'string' \? user\.role/);
    });
});
