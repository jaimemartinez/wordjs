import { ROLES_TOKEN, rolesGrantInEffect, type HeldState } from "./DeclaredRolesList";

/** What GET /plugins tells the grant screens about a plugin's grants. */
export type GrantStateOf = { grantedPermissions?: string[]; activationSeedsGrants?: boolean } | null | undefined;

/**
 * What confirming the activation dialog does to ONE permission the plugin requests.
 *
 * The server (backend routes/plugins.ts, POST /plugins/:slug/activate) grants the manifest's permissions
 * on activation ONLY when no administrator has decided the plugin's grants: it has no grant record (a
 * first activation, or a reinstall, whose uninstall cleared the record), or an empty one nobody decided
 * (core/plugin-permissions shouldSeedDeclaredGrants). GET /plugins says which as `activationSeedsGrants`.
 * Otherwise activating changes none of them, so a permission the administrator revoked earlier stays
 * revoked — on purpose: deactivating and activating again must not undo a revoke, and that includes a
 * revoke of EVERY grant (an empty record the administrator decided). A permission added by an update is
 * in the same position: it was never granted, and activating does not grant it either.
 *
 *   - "grants":    activation seeds the declared grants — confirming grants this permission;
 *   - "kept":      already granted — it stays granted;
 *   - "stays-off": the administrator decided the plugin's grants and this is not one of them — it stays off
 *                  after activation; only the Permissions dialog grants it.
 *
 * Without `activationSeedsGrants` (a list that could not read the stored grants) an empty grant list is
 * read as "activation seeds", the rule before an administrator's revoke of everything was recorded.
 *
 * The activation dialog used to show every requested permission as granted on confirm (and, under
 * `roles:declare`, that the role's holders "get its permissions back when you grant this") while the
 * server kept a revoked `roles:declare` off: the team member still landed on their account page.
 */
export type ActivationGrant = "grants" | "kept" | "stays-off";

export function activationGrant(plugin: GrantStateOf, token: string): ActivationGrant {
    const granted = Array.isArray(plugin?.grantedPermissions) ? plugin.grantedPermissions : [];
    const seeds = typeof plugin?.activationSeedsGrants === "boolean" ? plugin.activationSeedsGrants : granted.length === 0;
    if (seeds) return "grants";
    return granted.includes(token) ? "kept" : "stays-off";
}

/** Does confirming the activation dialog leave at least one requested permission off? */
export function activationLeavesSomeOff(plugin: GrantStateOf, tokens: string[]): boolean {
    return tokens.some((token) => activationGrant(plugin, token) === "stays-off");
}

/**
 * Which note goes under a declared role that users already hold (DeclaredRolesList), on each grant screen:
 *
 *   - the grant is in effect → "granted" (a plain count, on both screens);
 *   - the Permissions dialog, grant not in effect → "returns-on-grant" (switching it on gives it back);
 *   - the activation dialog, activation grants it → "returns-on-grant" (confirming gives it back);
 *   - the activation dialog, it stays off → "stays-off" (activating does NOT give it back).
 */
export function rolesHeldState(plugin: GrantStateOf, screen: "activation" | "permissions"): HeldState {
    if (rolesGrantInEffect(plugin)) return "granted";
    if (screen === "activation" && activationGrant(plugin, ROLES_TOKEN) === "stays-off") return "stays-off";
    return "returns-on-grant";
}
