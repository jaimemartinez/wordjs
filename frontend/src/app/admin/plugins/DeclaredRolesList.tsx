"use client";

import { Fragment } from "react";
import type { DeclaredPluginRole } from "@/lib/api";
import BreakableToken, { TOKEN_WRAP_CLASS } from "./BreakableToken";

/** The token a plugin requests to register the roles of its manifest (backend core/plugin-roles.ts). */
export const ROLES_TOKEN = "roles:declare";

/**
 * Is the plugin's `roles:declare` grant IN EFFECT right now (the server's record, not a dialog's draft)?
 * While it is, the holders of its roles already have the role's permissions (backend core/roles.ts
 * effectiveCapabilitiesOf); while it is not, they hold only read/access_admin_panel.
 */
export function rolesGrantInEffect(plugin: { grantedPermissions?: string[] } | null | undefined): boolean {
    return Array.isArray(plugin?.grantedPermissions) && plugin.grantedPermissions.includes(ROLES_TOKEN);
}

/**
 * The state the note under a declared role that users ALREADY hold describes (grantState.ts
 * rolesHeldState picks it for each grant screen):
 *
 * - "granted": the grant is in effect. The holders already have the role's permissions and nothing
 *   comes back — a plain count (`heldGrantedTemplate`). Saying "they get them back when you grant this"
 *   there was false: it showed on the Permissions dialog of a plugin whose grant stands, for team
 *   members assigned in this very installation.
 * - "returns-on-grant": the grant is not in effect and the screen's action grants it (switching it on in
 *   Permissions, or an activation that grants the manifest). The holders kept the role from before (the
 *   grant was revoked, or the plugin was deleted and reinstalled and its role kept, orphaned): granting
 *   gives them the role's permissions back at once (`heldTemplate`).
 * - "stays-off": the activation dialog of a plugin whose `roles:declare` was revoked. Activating does not
 *   grant it (grantState.ts activationGrant), so the holders get nothing back by confirming; only
 *   granting it in Permissions does (`heldStaysOffTemplate`).
 */
export type HeldState = "granted" | "returns-on-grant" | "stays-off";

export interface HeldTemplates {
    heldTemplate?: string;
    heldGrantedTemplate?: string;
    heldStaysOffTemplate?: string;
}

/** The line under a declared role that users ALREADY hold (`holders`, from GET /plugins), or null. "{n}" = how many. */
export function heldNote(holders: unknown, state: HeldState, templates: HeldTemplates): string | null {
    const n = Number(holders);
    if (!Number.isFinite(n) || n <= 0) return null;
    const template = state === "granted" ? templates.heldGrantedTemplate
        : state === "stays-off" ? templates.heldStaysOffTemplate
            : templates.heldTemplate;
    return template ? template.replace("{n}", String(n)) : null;
}

/**
 * The roles a plugin's manifest declares, listed under its `roles:declare` request so the administrator
 * sees exactly which roles granting it registers. Plugin-authored text, rendered as text. Built from
 * spans only, because one of the two grant screens renders it inside a toggle <button>.
 *
 * A role users ALREADY hold carries a note (heldNote above) worded for `state`, which is required so a
 * grant screen cannot forget to say which. The role's slug and its permissions are slate-600 (they were
 * slate-400: 2.5:1 on the permission row's tint, under WCAG AA), and the permissions line is labelled
 * (`capabilitiesLabel`) so it does not read as a second slug. Each identifier wraps only between its parts
 * (BreakableToken): `break-all` cut them at any letter on a phone, «conference_manage|r_team».
 */
export default function DeclaredRolesList({ roles, heading, state, capabilitiesLabel, heldTemplate, heldGrantedTemplate, heldStaysOffTemplate }: {
    roles?: DeclaredPluginRole[];
    heading: string;
    /** What the note under an already-held role says (grantState.ts rolesHeldState). */
    state: HeldState;
    /** Label in front of a role's permissions, e.g. "Role permissions:". */
    capabilitiesLabel?: string;
} & HeldTemplates) {
    const list = Array.isArray(roles) ? roles.filter((r) => r && typeof r === "object") : [];
    if (list.length === 0) return null;
    return (
        <span className="block mt-2" data-declared-roles="">
            <span className="block text-[11px] font-bold text-slate-600">{heading}</span>
            {list.map((r) => {
                const note = heldNote(r.holders, state, { heldTemplate, heldGrantedTemplate, heldStaysOffTemplate });
                return (
                    <span key={String(r.slug)} className="block mt-1 text-xs text-slate-600" data-declared-role={String(r.slug)}>
                        <span className="font-bold text-slate-800">{String(r.name ?? r.slug)}</span>{" "}
                        <span className={`font-mono text-[10px] text-slate-600 ${TOKEN_WRAP_CLASS}`} data-declared-role-slug=""><BreakableToken text={String(r.slug)} /></span>
                        {Array.isArray(r.capabilities) && r.capabilities.length > 0 && (
                            <span className="block text-[10px] text-slate-600" data-declared-role-capabilities="">
                                {capabilitiesLabel && <span className="font-bold">{capabilitiesLabel} </span>}
                                {r.capabilities.map(String).map((cap, i, all) => (
                                    <Fragment key={`${i}:${cap}`}>
                                        {i > 0 && " "}
                                        <span className={`font-mono ${TOKEN_WRAP_CLASS}`} data-declared-role-capability=""><BreakableToken text={cap} />{i < all.length - 1 ? "," : ""}</span>
                                    </Fragment>
                                ))}
                            </span>
                        )}
                        {note && (
                            <span
                                className={`block text-[11px] font-bold ${state === "granted" ? "text-slate-600" : "text-amber-800"}`}
                                data-declared-role-held={String(Number(r.holders))}
                                data-declared-role-held-state={state}
                            >
                                {note}
                            </span>
                        )}
                    </span>
                );
            })}
        </span>
    );
}
