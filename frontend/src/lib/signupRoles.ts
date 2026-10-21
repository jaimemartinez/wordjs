/**
 * Roles a self-registered account may receive — mirrors backend core/registration-settings
 * (PRIVILEGED_SIGNUP_CAPABILITIES), which refuses the rest on save and at sign-up. The settings screen
 * offered Administrator first; a registration with it created an administrator.
 */
export const PRIVILEGED_SIGNUP_CAPABILITIES: readonly string[] = [
    "*", "manage_options", "edit_users", "create_users", "delete_users", "promote_users", "list_users",
    "install_plugins", "activate_plugins", "edit_plugins", "delete_plugins", "edit_theme_options",
    "switch_themes", "edit_others_posts", "publish_pages", "moderate_comments", "manage_categories",
];

export function isSignupSafeRole(slug: string, role: { capabilities?: unknown } | null | undefined): boolean {
    if (slug === "administrator") return false;
    const caps = Array.isArray(role?.capabilities) ? (role!.capabilities as unknown[]) : [];
    return !caps.some((c) => typeof c === "string" && PRIVILEGED_SIGNUP_CAPABILITIES.includes(c));
}
