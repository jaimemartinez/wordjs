import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translations } from "@/lib/i18n";
import type { Role } from "@/lib/api";
import { PluginRoleBadges, PluginRolePanel, canDeleteRole, isPluginRole } from "../PluginRole";

/**
 * THE ROLES SCREEN SHOWS A PLUGIN'S ROLE AS THAT PLUGIN'S — read-only, labelled, and not deletable
 * while the plugin is installed (the backend refuses those writes: 409 rest_role_plugin_managed).
 */

const t = (key: string) => translations.en[key] ?? key;
const team: Role = {
    name: "Equipo de conferencia", description: "Opens the conference screens.",
    capabilities: ["read", "access_admin_panel", "conference_manager_access"],
    source: "plugin", plugin: "conference-manager", pluginInstalled: true,
};

describe("a plugin's role on the Roles screen", () => {
    it("is recognised by its provenance — an administrator's own role is not", () => {
        expect(isPluginRole(team)).toBe(true);
        expect(isPluginRole({ name: "Shop", capabilities: [] })).toBe(false);
    });

    it("cannot be deleted while its plugin is installed; an orphan can, so can any other role", () => {
        expect(canDeleteRole(team)).toBe(false);
        expect(canDeleteRole({ ...team, pluginInstalled: false, orphaned: true })).toBe(true);
        expect(canDeleteRole({ name: "Shop", capabilities: [] })).toBe(true);
    });

    it("is labelled with the plugin that provides it, and an orphan says so", () => {
        expect(renderToStaticMarkup(<PluginRoleBadges role={team} t={t} />)).toContain("From plugin conference-manager");
        expect(renderToStaticMarkup(<PluginRoleBadges role={{ ...team, orphaned: true }} t={t} />)).toContain("Orphaned");
        expect(renderToStaticMarkup(<PluginRoleBadges role={{ name: "Shop", capabilities: [] }} t={t} />)).toBe("");
    });

    it("opens as a read-only panel — no form, no name field, no capability checkbox", () => {
        const html = renderToStaticMarkup(<PluginRolePanel slug="conference_manager_team" role={team} t={t} onClose={() => undefined} />);
        expect(html).toContain("This role is defined by plugin conference-manager");
        expect(html).toContain("conference manager access");
        expect(html).not.toMatch(/<(form|input|textarea|select)\b/);
    });
});
