import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * components/PluginScriptNotGranted — what /admin/plugin/<slug> shows when the plugin's interface is withheld
 * (the administrator has not granted it `browser:script`).
 *
 * Plugin pages are reachable by non-administrators: a plugin-declared role (conference-manager's team role)
 * opens its plugin's page and nothing else. The grant instructions and the link to the plugins screen are
 * for whoever can open that screen; anyone else is told the screen is unavailable and to ask an
 * administrator — the admin route guard sends them back from /admin/plugins to the very page that showed
 * the notice, so a link would be a dead end. The text follows the admin's language.
 *
 * The viewer and the language come from the admin shell's contexts (useOptionalAuth / useOptionalI18n),
 * mocked here so the component renders with the REAL i18n table without the providers' network and router.
 */

const ctx = vi.hoisted(() => ({
    user: null as { role: string; capabilities: string[] } | null,
    lang: null as "es" | "en" | "pt" | null,
}));
vi.mock("@/contexts/AuthContext", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/contexts/AuthContext")>()),
    useOptionalAuth: () => (ctx.user ? { user: ctx.user } : null),
}));
vi.mock("@/contexts/I18nContext", async (importOriginal) => {
    const { t } = await import("@/lib/i18n");
    return {
        ...(await importOriginal<typeof import("@/contexts/I18nContext")>()),
        useOptionalI18n: () => (ctx.lang ? { language: ctx.lang, setLanguage: () => undefined, t: (k: string) => t(k, ctx.lang!) } : null),
    };
});

import PluginScriptNotGranted from "../PluginScriptNotGranted";
import { decideAdminRoute } from "@/lib/adminAccess";

const ADMIN = { role: "administrator", capabilities: ["*"] };
const PLUGIN_MANAGER = { role: "pluginmanager", capabilities: ["read", "access_admin_panel", "activate_plugins"] };
const TEAM = { role: "conference_manager_team", capabilities: ["read", "access_admin_panel", "conference_manager_access"] };
const TEAM_MENUS = [{ href: "/admin/plugin/conference-manager", label: "Conferencias", icon: "fa-x", cap: "conference_manager_access", plugin: "conference-manager" }];

const render = () => renderToStaticMarkup(React.createElement(PluginScriptNotGranted, { pluginId: "conference-manager" }));
/** The text a reader sees: a block (heading, paragraph, link) ends with a space, inline markup does not. */
const stripTags = (html: string): string => {
    // Repeat until nothing changes, so a tag split around another tag cannot survive one pass.
    let out = html;
    for (let prev = ""; prev !== out;) { prev = out; out = out.replace(/<[^>]*>/g, ""); }
    return out;
};
const textOf = (html: string) => stripTags(html.replace(/<\/(h1|p|a)>/g, " "))
    .replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const hrefOf = (html: string) => (/href="([^"]+)"/.exec(html) || [])[1] ?? null;

beforeEach(() => { ctx.user = null; ctx.lang = "en"; });

describe("PluginScriptNotGranted", () => {
    it("a plugin team member is told the screen is unavailable — no grant instructions, no link that bounces back", () => {
        // Precondition the notice answers to: the guard sends this viewer away from the plugins screen.
        expect(decideAdminRoute({ pathname: "/admin/plugins", user: TEAM, pluginMenus: TEAM_MENUS, menusLoaded: true }))
            .toEqual({ kind: "redirect", to: "/admin/plugin/conference-manager" });
        ctx.user = TEAM;
        const html = render();
        expect(textOf(html)).toBe("This screen is not available An administrator has not enabled this plugin's interface yet. Ask an administrator to enable it.");
        expect(hrefOf(html)).toBeNull();
        expect(html).not.toContain("browser:script");
        expect(html).toContain('data-wjs-plugin-script-not-granted="conference-manager"');
    });

    it("an administrator gets the grant instructions and a link the guard lets them open", () => {
        ctx.user = ADMIN;
        const html = render();
        expect(textOf(html)).toContain("This plugin's interface is not served until you grant 'Run code in your browser' (browser:script) in Admin → Plugins → Permissions.");
        expect(textOf(html)).toContain("Grant it only if you trust conference-manager as much as an administrator account.");
        expect(textOf(html)).toContain("Open the permissions of conference-manager");
        const href = hrefOf(html)!;
        expect(href).toBe("/admin/plugins?permissions=conference-manager");
        expect(decideAdminRoute({ pathname: href.split("?")[0], user: ADMIN, pluginMenus: [], menusLoaded: true })).toEqual({ kind: "allow" });
    });

    it("so does a non-administrator who may open the plugins screen (activate_plugins)", () => {
        ctx.user = PLUGIN_MANAGER;
        const html = render();
        expect(hrefOf(html)).toBe("/admin/plugins?permissions=conference-manager");
        expect(decideAdminRoute({ pathname: "/admin/plugins", user: PLUGIN_MANAGER, pluginMenus: [], menusLoaded: true })).toEqual({ kind: "allow" });
    });

    it("speaks the admin's language (es / pt), both notices", () => {
        ctx.lang = "es";
        ctx.user = TEAM;
        expect(textOf(render())).toBe("Esta pantalla no está disponible Un administrador todavía no ha habilitado la interfaz de este plugin. Pide a un administrador que la habilite.");
        ctx.user = ADMIN;
        expect(textOf(render())).toContain("no se sirve hasta que concedas «Ejecutar código en tu navegador» (browser:script) en Plugins → Permisos.");
        expect(textOf(render())).toContain("Abrir los permisos de conference-manager");
        ctx.lang = "pt";
        expect(textOf(render())).toContain("Abrir as permissões de conference-manager");
        ctx.user = TEAM;
        expect(textOf(render())).toContain("Esta tela não está disponível");
    });

    it("outside the providers the viewer is unknown: the unavailable notice, never the link", () => {
        ctx.lang = null;
        const html = render();
        expect(hrefOf(html)).toBeNull();
        expect(textOf(html)).toContain("Esta pantalla no está disponible");
    });
});
