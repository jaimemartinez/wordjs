import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DeclaredRolesList, { ROLES_TOKEN, heldNote, rolesGrantInEffect } from "../DeclaredRolesList";
import { permMeta } from "@/lib/permissionMeta";

/**
 * THE GRANT SCREENS SAY WHAT `roles:declare` REGISTERS.
 *
 * Granting `roles:declare` lets a plugin add user roles of its own (backend core/plugin-roles.ts). An
 * administrator weighing that request must see WHICH roles, with which permissions, and the platform's
 * own wording that such a role can only reach the plugin — not a raw token behind a default badge.
 */

describe("DeclaredRolesList", () => {
    it("lists every declared role with its slug and capabilities, as text", () => {
        const html = renderToStaticMarkup(
            <DeclaredRolesList
                heading="Roles it will register"
                state="returns-on-grant"
                roles={[{ slug: "conference_manager_team", name: "<b>Equipo</b> de conferencia", capabilities: ["conference_manager_access"] }]}
            />,
        );
        expect(html).toContain("Roles it will register");
        expect(html).toContain('data-declared-role="conference_manager_team"');
        // The identifiers read whole once the wrap points (<wbr>, BreakableToken) are set aside.
        const text = html.replace(/<wbr\/?>/g, "");
        expect(text).toContain(">conference_manager_team</span>");
        expect(text).toContain("conference_manager_access");
        // Plugin-authored text is rendered as text, never as markup.
        expect(html).toContain("&lt;b&gt;Equipo&lt;/b&gt; de conferencia");
        expect(html).not.toContain("<b>Equipo</b>");
    });

    it("renders nothing when the plugin declares no role", () => {
        expect(renderToStaticMarkup(<DeclaredRolesList heading="x" state="returns-on-grant" roles={[]} />)).toBe("");
        expect(renderToStaticMarkup(<DeclaredRolesList heading="x" state="returns-on-grant" />)).toBe("");
    });

    it("says when users ALREADY hold a declared role while the grant is NOT in effect — granting re-arms them", () => {
        const roles = [
            { slug: "cm_team", name: "Team", capabilities: ["cm_x"], holders: 3 },
            { slug: "cm_other", name: "Other", capabilities: ["cm_y"], holders: 0 },
        ];
        const html = renderToStaticMarkup(
            <DeclaredRolesList heading="h" state="returns-on-grant" heldTemplate="Already held by {n}, back on grant" heldGrantedTemplate="Held by {n}" roles={roles} />,
        );
        expect(html).toContain('data-declared-role-held="3"');
        expect(html).toContain('data-declared-role-held-state="returns-on-grant"');
        expect(html).toContain("Already held by 3, back on grant");
        expect(html).not.toContain("Held by 3");
        expect(html.match(/data-declared-role-held=/g)?.length).toBe(1);
        expect(html).not.toMatch(/<(div|p|ul|li)\b/);
    });

    // Live finding (Permissions dialog, roles:declare switched ON): «Ya lo tienen 1 usuario(s), de una
    // instalación anterior de este plugin: recuperan sus permisos al conceder este» was shown for a team
    // member assigned in THIS installation, whose permissions had never been lost.
    it("while the grant IS in effect, only counts the holders — nothing 'comes back'", () => {
        const roles = [{ slug: "cm_team", name: "Team", capabilities: ["cm_x"], holders: 1 }];
        const html = renderToStaticMarkup(
            <DeclaredRolesList heading="h" state="granted" heldTemplate="Already held by {n}, back on grant" heldGrantedTemplate="Held by {n}" roles={roles} />,
        );
        expect(html).toContain("Held by 1");
        expect(html).toContain('data-declared-role-held-state="granted"');
        expect(html).not.toContain("back on grant");
    });

    it("heldNote: no note without holders; each state has its own wording", () => {
        const tpl = { heldTemplate: "back {n}", heldGrantedTemplate: "count {n}", heldStaysOffTemplate: "not on activation {n}" };
        expect(heldNote(0, "returns-on-grant", tpl)).toBeNull();
        expect(heldNote(undefined, "granted", tpl)).toBeNull();
        expect(heldNote("x", "returns-on-grant", tpl)).toBeNull();
        expect(heldNote(2, "returns-on-grant", tpl)).toBe("back 2");
        expect(heldNote(2, "granted", tpl)).toBe("count 2");
        expect(heldNote(2, "stays-off", tpl)).toBe("not on activation 2");
        // A screen that passes no wording for the state shows nothing rather than the wrong sentence.
        expect(heldNote(2, "granted", { heldTemplate: "back {n}" })).toBeNull();
        expect(heldNote(2, "stays-off", { heldTemplate: "back {n}" })).toBeNull();
    });

    it("rolesGrantInEffect reads the server's grant record", () => {
        expect(rolesGrantInEffect({ grantedPermissions: ["database:read", ROLES_TOKEN] })).toBe(true);
        expect(rolesGrantInEffect({ grantedPermissions: ["database:read"] })).toBe(false);
        expect(rolesGrantInEffect({})).toBe(false);
        expect(rolesGrantInEffect(null)).toBe(false);
    });

    it("both grant screens pass the state of their own screen and every wording; es/en/pt carry them", async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const page = fs.readFileSync(path.resolve(__dirname, "../page.tsx"), "utf8");
        const row = fs.readFileSync(path.resolve(__dirname, "../PermissionRow.tsx"), "utf8");
        // The activation dialog (PermissionRow) and the Permissions dialog.
        expect(page.match(/rolesHeld=\{rolesHeldState\(pluginToActivate, 'activation'\)\}/g)?.length).toBe(1);
        expect(page.match(/state=\{rolesHeldState\(permsModalPlugin, 'permissions'\)\}/g)?.length).toBe(1);
        for (const src of [page, row]) {
            expect(src).toMatch(/t\('plugins\.declaredRoles\.heldGranted'\)/);
            expect(src).toMatch(/t\('plugins\.declaredRoles\.heldStaysOff'\)/);
            expect(src).toMatch(/t\('plugins\.declaredRoles\.capabilities'\)/);
        }
        const { translations } = await import("@/lib/i18n");
        for (const lang of ["es", "en", "pt"] as const) {
            for (const key of ["plugins.declaredRoles.heldGranted", "plugins.declaredRoles.held", "plugins.declaredRoles.heldStaysOff"]) {
                expect(translations[lang][key], `${lang} ${key}`).toMatch(/\{n\}/);
            }
            expect(translations[lang]["plugins.declaredRoles.capabilities"], lang).toBeTruthy();
        }
    });

    it("is built from inline elements only (one grant screen renders it inside a <button>)", () => {
        const html = renderToStaticMarkup(
            <DeclaredRolesList heading="h" state="granted" heldGrantedTemplate="Held by {n}" roles={[{ slug: "a_team", name: "A", capabilities: ["a_x"], holders: 2 }]} />,
        );
        expect(html).toContain("Held by 2");
        expect(html).not.toMatch(/<(div|p|ul|li)\b/);
    });
});

describe("the platform's own wording for roles:declare", () => {
    it("has a label, a medium risk badge and says the role can only reach the plugin", () => {
        const meta = permMeta(ROLES_TOKEN);
        expect(meta.label).not.toBe(ROLES_TOKEN);
        expect(meta.risk).toBe("med");
        expect(meta.description).toMatch(/only ever hold this plugin's own permissions/);
        expect(meta.description).toMatch(/never reach your content, users, settings or another plugin/);
        // It does not claim "nobody holds it until you assign it" (users may already hold it; the screen
        // shows how many). Nor does it explain where those holders came from: it is shown in EVERY state,
        // granted included, and "an earlier installation" was then false. The held note under the role,
        // worded per state and translated, says that.
        expect(meta.description).not.toMatch(/Nobody holds the role/);
        expect(meta.description).not.toMatch(/earlier installation|kept it|get .* back/i);
        expect(meta.description).toMatch(/already hold it, how many is shown next to the role/);
    });
});
