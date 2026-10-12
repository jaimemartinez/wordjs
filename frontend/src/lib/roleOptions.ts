/**
 * The role choices of the user create/edit forms — EVERY role the site has, not a hardcoded four.
 *
 * The forms used to offer subscriber/author/editor/administrator only, so a custom role (Users → Roles)
 * or a role a plugin declared (e.g. conference-manager's team role) could not be given to anyone from the
 * admin. The backend already accepted any role in the live map (routes/users.ts); the list now comes from
 * GET /roles, grouped: core roles, roles an administrator created, roles provided by plugins.
 *
 * GET /roles is administrator-only. For anyone else (a delegate holding promote_users) the form falls
 * back to the four core roles it always offered — plus the user's current role, so the select can show it.
 */

import type { Role } from "@/lib/api";

export interface RoleOption {
    value: string;
    label: string;
    /** The heading the option is listed under. */
    group?: string;
}

/** Core roles, least to most privileged (the order the forms list them in). */
export const CORE_ROLE_ORDER = ["subscriber", "contributor", "author", "editor", "administrator"] as const;

/** What the forms offered before the roles list existed — the fallback when GET /roles is refused. */
const FALLBACK_ROLES = ["subscriber", "author", "editor", "administrator"];

const CORE_LABEL_KEYS: Record<string, string> = {
    subscriber: "user.edit.roleSubscriber",
    contributor: "user.edit.roleContributor",
    author: "user.edit.roleAuthor",
    editor: "user.edit.roleEditor",
    administrator: "user.edit.roleAdministrator",
};

const fill = (template: string, values: Record<string, string>) =>
    template.replace(/\{(\w+)\}/g, (_, k: string) => (k in values ? values[k] : `{${k}}`));

/**
 * Build the grouped options. `roles` is GET /roles (null when it could not be read); `t` the i18n
 * lookup; `currentRole` the role the edited user holds (always kept selectable).
 */
export function buildRoleOptions(
    roles: Record<string, Role> | null | undefined,
    t: (key: string) => string,
    currentRole?: string,
): RoleOption[] {
    const coreGroup = t("user.edit.roleGroupCore");
    const coreLabel = (slug: string) => (CORE_LABEL_KEYS[slug] ? t(CORE_LABEL_KEYS[slug]) : slug);

    if (!roles || typeof roles !== "object") {
        const options: RoleOption[] = FALLBACK_ROLES.map((slug) => ({ value: slug, label: coreLabel(slug), group: coreGroup }));
        if (currentRole && !FALLBACK_ROLES.includes(currentRole)) {
            options.push({ value: currentRole, label: coreLabel(currentRole), group: coreGroup });
        }
        return options;
    }

    const own = (slug: string) => Object.prototype.hasOwnProperty.call(roles, slug);
    const core: RoleOption[] = CORE_ROLE_ORDER.filter(own).map((slug) => ({ value: slug, label: coreLabel(slug), group: coreGroup }));

    const custom: RoleOption[] = [];
    const plugin: RoleOption[] = [];
    const customGroup = t("user.edit.roleGroupCustom");
    const pluginGroup = t("user.edit.roleGroupPlugin");
    for (const slug of Object.keys(roles)) {
        if ((CORE_ROLE_ORDER as readonly string[]).includes(slug)) continue;
        const role = roles[slug];
        const name = (role && typeof role.name === "string" && role.name.trim()) || slug;
        if (role && role.source === "plugin" && role.plugin) {
            const key = role.orphaned ? "user.edit.roleOrphaned" : "user.edit.rolePluginLabel";
            plugin.push({ value: slug, label: fill(t(key), { name, plugin: role.plugin }), group: pluginGroup });
        } else {
            custom.push({ value: slug, label: name, group: customGroup });
        }
    }
    const byLabel = (a: RoleOption, b: RoleOption) => a.label.localeCompare(b.label);
    const options = [...core, ...custom.sort(byLabel), ...plugin.sort(byLabel)];
    if (currentRole && !options.some((o) => o.value === currentRole)) {
        options.push({ value: currentRole, label: currentRole, group: customGroup });
    }
    return options;
}

/**
 * The name of a user's role wherever the admin shows it — the sidebar's user chip, the account page's
 * identity card, the Users list: a core role in the admin's language, any other role by its own name
 * (`roleName`: GET /auth/me for the signed-in user, roleNameFrom(GET /roles) for a list), the slug only
 * when neither is known. They showed the raw slug — «ADMINISTRATOR» in a Spanish admin,
 * «CONFERENCE_MANAGER_TEAM» to a plugin team member on their own account page.
 */
export function roleDisplayName(user: { role?: unknown; roleName?: unknown } | null | undefined, t: (key: string) => string): string {
    const slug = typeof user?.role === "string" ? user.role : "";
    if (CORE_LABEL_KEYS[slug]) return t(CORE_LABEL_KEYS[slug]);
    if (typeof user?.roleName === "string" && user.roleName.trim()) return user.roleName.trim();
    return slug;
}

/**
 * The display name GET /roles gives `slug` (own keys only: a slug such as "constructor" never reads the
 * prototype), or null. For a list of OTHER users (Users), whose role names /auth/me does not carry.
 */
export function roleNameFrom(roles: Record<string, Role> | null | undefined, slug: unknown): string | null {
    if (!roles || typeof roles !== "object" || typeof slug !== "string") return null;
    if (!Object.prototype.hasOwnProperty.call(roles, slug)) return null;
    const name = roles[slug]?.name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
}
