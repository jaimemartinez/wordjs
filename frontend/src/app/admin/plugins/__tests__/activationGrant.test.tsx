import { describe, it, expect } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/contexts/I18nContext";
import { translations } from "@/lib/i18n";
import { activationGrant, activationLeavesSomeOff, rolesHeldState } from "../grantState";
import { PermissionRow, STAYS_OFF_CLASSES, TOKEN_CLASS, REASON_LABEL_CLASS, RISK_CLASSES } from "../PermissionRow";
import DeclaredRolesList, { ROLES_TOKEN } from "../DeclaredRolesList";
import { AA, contrastOf, textClassOf } from "@/lib/__tests__/helpers/tailwindContrast";

/**
 * THE ACTIVATION DIALOG SAYS WHAT CONFIRMING GRANTS.
 *
 * Live finding: revoke `roles:declare` in Permissions, deactivate, Activar. The activation dialog listed
 * `roles:declare` like every other permission, under "By activating this plugin, you are granting it strict
 * access to these system capabilities", and under the plugin's role the amber note said its holders "get
 * its permissions back when you grant this". Confirming answered POST /activate 200 WITHOUT roles:declare
 * (backend routes/plugins.ts grants the manifest only to a plugin whose grants no administrator decided,
 * so a revoke survives re-activation — by design), and the team member still landed on their account page.
 *
 * Now the dialog mirrors the server: a permission activation leaves off is drawn neutral and says it stays
 * off and where to grant it; the note under an already-held role says activating does not give it back;
 * the footer no longer says activating grants everything listed. That includes a plugin whose EVERY grant
 * an administrator revoked: its grant list is empty like a never-activated plugin's, so GET /plugins says
 * which of the two it is (`activationSeedsGrants`).
 */

const ES = translations.es;
const render = (node: React.ReactElement) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
const ROLES = [{ slug: "conference_manager_team", name: "Equipo de conferencia", capabilities: ["conference_manager_access"], holders: 1 }];

describe("activationGrant mirrors POST /plugins/:slug/activate", () => {
    it("no grant on record: activation grants every requested permission", () => {
        expect(activationGrant({ grantedPermissions: [] }, ROLES_TOKEN)).toBe("grants");
        expect(activationGrant({}, "database:read")).toBe("grants");
        expect(activationGrant(null, "database:read")).toBe("grants");
    });
    it("grants on record: what is granted stays granted, what is not stays OFF", () => {
        const plugin = { grantedPermissions: ["database:read", "admin_menu:register"] };
        expect(activationGrant(plugin, "database:read")).toBe("kept");
        expect(activationGrant(plugin, ROLES_TOKEN)).toBe("stays-off");
        expect(activationLeavesSomeOff(plugin, ["database:read", ROLES_TOKEN])).toBe(true);
        expect(activationLeavesSomeOff(plugin, ["database:read"])).toBe(false);
        expect(activationLeavesSomeOff({ grantedPermissions: [] }, ["database:read", ROLES_TOKEN])).toBe(false);
    });
    it("every grant revoked by an administrator (activationSeedsGrants false): activation grants nothing", () => {
        // An empty record an administrator decided: the server seeds nothing, so nothing is "granted" here.
        const revokedAll = { grantedPermissions: [], activationSeedsGrants: false };
        expect(activationGrant(revokedAll, ROLES_TOKEN)).toBe("stays-off");
        expect(activationGrant(revokedAll, "database:read")).toBe("stays-off");
        expect(activationLeavesSomeOff(revokedAll, ["database:read"])).toBe(true);
        // An empty record nobody decided (or none at all) is still seeded.
        expect(activationGrant({ grantedPermissions: [], activationSeedsGrants: true }, ROLES_TOKEN)).toBe("grants");
        // The flag never turns a held grant into a fresh one.
        expect(activationGrant({ grantedPermissions: ["database:read"], activationSeedsGrants: false }, "database:read")).toBe("kept");
    });
    it("the backend seeds only an undecided plugin, and GET /plugins says so (the rule mirrored here)", () => {
        const backend = path.resolve(__dirname, "../../../../../../backend/src");
        const route = fs.readFileSync(path.join(backend, "routes/plugins.ts"), "utf8");
        const perms = fs.readFileSync(path.join(backend, "core/plugin-permissions.ts"), "utf8");
        // POST /activate stores the declared grants through seedGrants, which asks shouldSeedDeclaredGrants…
        expect(route).toMatch(/await seedGrants\(slug, declared, \{ adminDecision: true \}\)/);
        expect(perms).toMatch(/seeded = shouldSeedDeclaredGrants\(slug, existing, hasAdminDecisionIn\(stored, slug\)\);/);
        // …no record, or an empty one no administrator decided.
        expect(perms).toMatch(/if \(!stored\) return true;\s*return stored\.length === 0 && !adminDecided;/);
        // GET /plugins hands the dialog the same answer.
        expect(route).toMatch(/activationSeedsGrants: seedsOnActivation\[p\.slug\]/);
        expect(perms).toMatch(/out\[slug\] = shouldSeedDeclaredGrants\(slug, grantRecordIn\(stored, slug\), hasAdminDecisionIn\(stored, slug\)\);/);
    });
});

describe("rolesHeldState: the note under a role users already hold, per screen", () => {
    it("granted → a count on both screens", () => {
        const plugin = { grantedPermissions: [ROLES_TOKEN] };
        expect(rolesHeldState(plugin, "activation")).toBe("granted");
        expect(rolesHeldState(plugin, "permissions")).toBe("granted");
    });
    it("revoked, other grants on record → activating does NOT give it back; Permissions does", () => {
        const plugin = { grantedPermissions: ["database:read"] };
        expect(rolesHeldState(plugin, "activation")).toBe("stays-off");
        expect(rolesHeldState(plugin, "permissions")).toBe("returns-on-grant");
    });
    it("no grant on record → activating grants it, so it comes back", () => {
        expect(rolesHeldState({ grantedPermissions: [] }, "activation")).toBe("returns-on-grant");
        expect(rolesHeldState({ grantedPermissions: [], activationSeedsGrants: true }, "activation")).toBe("returns-on-grant");
    });
    it("every grant revoked → activating does NOT give it back; Permissions does", () => {
        const revokedAll = { grantedPermissions: [], activationSeedsGrants: false };
        expect(rolesHeldState(revokedAll, "activation")).toBe("stays-off");
        expect(rolesHeldState(revokedAll, "permissions")).toBe("returns-on-grant");
    });
});

describe("PermissionRow (the activation dialog's row)", () => {
    it("a permission activation leaves off is neutral and says it stays off and where to grant it", () => {
        const html = render(<PermissionRow token="database:write" rolesHeld="granted" activation="stays-off" />);
        expect(html).toContain('data-activation-grant="stays-off"');
        const rowClass = /<div class="([^"]*)" data-permission-row=/.exec(html)?.[1] || "";
        expect(rowClass).toContain(STAYS_OFF_CLASSES);
        expect(rowClass).not.toContain(RISK_CLASSES.high.split(" ")[0]);
        expect(html).toContain("data-activation-stays-off");
        expect(html).toContain(ES["plugins.activation.staysOff"]);
    });
    it("a permission activation grants keeps its risk tint and no stays-off notice", () => {
        const html = render(<PermissionRow token="database:write" rolesHeld="granted" activation="grants" />);
        expect(html).toContain('data-activation-grant="grants"');
        const rowClass = /<div class="([^"]*)" data-permission-row=/.exec(html)?.[1] || "";
        expect(rowClass).toContain(RISK_CLASSES.high.split(" ")[0]);
        expect(html).not.toContain("data-activation-stays-off");
    });
    it("revoked roles:declare: the held note says activating does not give the permissions back", () => {
        const html = render(<PermissionRow token={ROLES_TOKEN} roles={ROLES} rolesHeld="stays-off" activation="stays-off" />);
        expect(html).toContain('data-declared-role-held-state="stays-off"');
        expect(html).toContain(ES["plugins.declaredRoles.heldStaysOff"].replace("{n}", "1"));
        // The sentence that promised the activation gives it back is gone.
        expect(html).not.toContain("recuperan sus permisos al conceder este");
    });
    it("is in the admin's language: risk badge and the reason label", () => {
        const html = render(<PermissionRow token="database:write" reason="why" rolesHeld="granted" />);
        expect(html).toContain(ES["plugins.risk.high"]);
        expect(html).toContain(ES["plugins.permission.pluginSays"]);
        expect(html).not.toMatch(/high risk|Plugin says/);
    });
});

describe("the activation dialog in plugins/page.tsx", () => {
    const page = fs.readFileSync(path.resolve(__dirname, "../page.tsx"), "utf8");
    it("passes each row what confirming does to it", () => {
        expect(page).toMatch(/activation=\{activationGrant\(pluginToActivate, token\)\}/);
    });
    it("the browser:script banner is not shown when browser:script stays off (twin: it said the plugin runs code in your browser)", () => {
        expect(page).toMatch(/declaredTokens\(pluginToActivate\)\.includes\(BROWSER_SCRIPT_TOKEN\) && activationGrant\(pluginToActivate, BROWSER_SCRIPT_TOKEN\) !== 'stays-off' && \(/);
        expect(activationGrant({ grantedPermissions: ["database:read"] }, "browser:script")).toBe("stays-off");
    });
    it("the footer says activating grants everything only when it does", () => {
        expect(page).toMatch(/activationLeavesSomeOff\(pluginToActivate, declaredTokens\(pluginToActivate\)\) \? t\('plugins\.activation\.footer\.partial'\) : t\('plugins\.activation\.footer'\)/);
        expect(page).not.toContain("you are granting it strict access");
    });
    it("es/en/pt carry every new string", () => {
        for (const lang of ["es", "en", "pt"] as const) {
            for (const key of ["plugins.activation.staysOff", "plugins.activation.footer", "plugins.activation.footer.partial",
                "plugins.permission.pluginSays", "plugins.permission.wordjsNote", "plugins.risk.low", "plugins.risk.med", "plugins.risk.high",
                "plugins.permissions.manage", "plugins.permissions.intro", "plugins.permissions.none", "plugins.permissions.save",
                "plugins.permissions.saving", "plugins.permission.granted", "plugins.permission.denied"]) {
                expect(translations[lang][key], `${lang} ${key}`).toBeTruthy();
            }
        }
    });
    it("the Permissions dialog and the plugin card are in the admin's language", () => {
        for (const english of [">Permissions</h3>", "Save permissions'", "'Plugin says: '", "'WordJS note: '", "> Permissions\n", ">Cancel</button>", "{granted ? 'granted' : 'denied'}"]) {
            expect(page, english).not.toContain(english);
        }
    });
});

describe("WCAG AA on the grant screens (computed from Tailwind's palette)", () => {
    // The permission rows are a 60 % tint of each risk colour, or the neutral stays-off row, over the white card.
    const ROW_BACKGROUNDS = [["white"], ["white", "bg-emerald-50/60"], ["white", "bg-amber-50/60"], ["white", "bg-rose-50/60"], ["white", "bg-slate-50"]];
    const worst = (text: string) => Math.min(...ROW_BACKGROUNDS.map((bg) => contrastOf(text, ...bg)));

    it("a declared role's slug and its permissions line (were slate-400, 2.5:1)", () => {
        const html = renderToStaticMarkup(<DeclaredRolesList heading="h" state="granted" capabilitiesLabel="Role permissions:" roles={ROLES} />);
        for (const attr of ["data-declared-role-slug", "data-declared-role-capabilities"]) {
            const cls = new RegExp(`class="([^"]*)" ${attr}`).exec(html)?.[1];
            expect(cls, attr).toBeTruthy();
            expect(worst(textClassOf(cls!)), attr).toBeGreaterThanOrEqual(AA);
        }
    });
    it("the permissions line is labelled", () => {
        const html = renderToStaticMarkup(<DeclaredRolesList heading="h" state="granted" capabilitiesLabel="Role permissions:" roles={ROLES} />);
        expect(html).toMatch(/data-declared-role-capabilities=""><span class="font-bold">Role permissions: <\/span>/);
    });
    it("the token next to a permission's label and the reason label (were 2.1:1 and 2.6:1)", () => {
        expect(worst(textClassOf(TOKEN_CLASS))).toBeGreaterThanOrEqual(AA);
        expect(worst(textClassOf(REASON_LABEL_CLASS))).toBeGreaterThanOrEqual(AA);
    });
    it("the activation footer (was slate-400/90, 2.2:1)", () => {
        const page = fs.readFileSync(path.resolve(__dirname, "../page.tsx"), "utf8");
        const cls = /<p className="([^"]*)" data-activation-footer=/.exec(page)?.[1];
        expect(cls).toBeTruthy();
        expect(contrastOf(textClassOf(cls!), "white", "bg-blue-50/45")).toBeGreaterThanOrEqual(AA);
    });
});

describe("the Marketplace install confirmation (twin: it promised 'nothing is granted automatically')", () => {
    it("says installing grants nothing and confirming the activation grants what it lists; an update keeps the grants", async () => {
        const { installGrantNoteKey } = await import("../MarketplaceTab");
        expect(installGrantNoteKey({ installed: false, updateAvailable: false })).toBe("plugins.marketplace.grantNote.install");
        expect(installGrantNoteKey({ installed: true, updateAvailable: true })).toBe("plugins.marketplace.grantNote.update");
        for (const lang of ["es", "en", "pt"] as const) {
            expect(translations[lang]["plugins.marketplace.grantNote.install"], lang).toBeTruthy();
            expect(translations[lang]["plugins.marketplace.grantNote.update"], lang).toBeTruthy();
        }
        const src = fs.readFileSync(path.resolve(__dirname, "../MarketplaceTab.tsx"), "utf8");
        expect(src).not.toContain("Nada se otorga automáticamente");
        const cls = /<p className="([^"]*)" data-install-grant-note=""/.exec(src)?.[1];
        expect(cls).toBeTruthy();
        expect(contrastOf(textClassOf(cls!), "white", "bg-blue-50/50")).toBeGreaterThanOrEqual(AA);
    });
});

describe("the platform's permission wording is in the admin's language (permMeta + perm.<token>.*)", () => {
    it("every permission token has a label and a description in es, en and pt", async () => {
        const { PERMISSION_META } = await import("@/lib/permissionMeta");
        for (const token of Object.keys(PERMISSION_META)) {
            for (const lang of ["es", "en", "pt"] as const) {
                expect(translations[lang][`perm.${token}.label`], `${lang} ${token} label`).toBeTruthy();
                expect(translations[lang][`perm.${token}.description`], `${lang} ${token} description`).toBeTruthy();
            }
            // English is the platform's own copy, kept as the fallback.
            expect(translations.en[`perm.${token}.label`]).toBe(PERMISSION_META[token].label);
            expect(translations.en[`perm.${token}.description`]).toBe(PERMISSION_META[token].description);
        }
    });
    it("permMeta(token, t) translates; without t, or for an unknown token, it falls back", async () => {
        const { permMeta } = await import("@/lib/permissionMeta");
        const tEs = (k: string) => ES[k] ?? k;
        expect(permMeta("database:write", tEs).label).toBe(ES["perm.database:write.label"]);
        expect(permMeta("database:write", tEs).risk).toBe("high");
        expect(permMeta("database:write").label).toBe("Write database");
        expect(permMeta("x:y", tEs)).toEqual({ label: "x:y", risk: "med" });
        expect(permMeta("network", (k) => k).label).toBe("Outbound network"); // a missing key falls back
    });
    it("the activation row is in Spanish on a Spanish admin", () => {
        const html = render(<PermissionRow token={ROLES_TOKEN} roles={ROLES} rolesHeld="granted" />);
        expect(html).toContain(ES["perm.roles:declare.label"]);
        expect(html).not.toContain("Register its own user roles");
    });
    it("no grant screen calls permMeta without the translator", () => {
        for (const file of ["../page.tsx", "../MarketplaceTab.tsx", "../PermissionRow.tsx"]) {
            const src = fs.readFileSync(path.resolve(__dirname, file), "utf8");
            expect(src, file).not.toMatch(/permMeta\(token\)/);
            expect(src, file).not.toMatch(/\$\{meta\.risk\} risk/);
        }
    });
    it("no description, in any language, says where already-held roles came from (it shows in every state)", () => {
        for (const lang of ["es", "en", "pt"] as const) {
            expect(translations[lang]["perm.roles:declare.description"], lang).not.toMatch(/earlier installation|instalación anterior|instalação anterior/i);
        }
    });
});
