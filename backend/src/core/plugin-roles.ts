/**
 * WordJS - Plugin-declared roles: the namespace rules (pure functions, no state).
 *
 * A plugin may ship roles of its own — e.g. conference-manager's "conference team" role, so a WordJS
 * user can be given access to the conference screens and nothing else. The rule that makes this safe:
 *
 *     A ROLE A PLUGIN DECLARES CAN ONLY EVER AFFECT THAT PLUGIN — NEVER THE CORE, NEVER ANOTHER PLUGIN.
 *
 * It is enforced by a NAMESPACE derived from the plugin id, not by trusting what the manifest says:
 *
 *   PREFIX = plugin id with every character outside [a-z0-9] replaced by "_", plus "_"
 *            (conference-manager → "conference_manager_")
 *
 *   · every role slug a plugin declares MUST start with its PREFIX (so it can never name, shadow or
 *     replace a core role such as `administrator`, which carries no underscore at all);
 *   · every capability such a role declares MUST start with that PREFIX (so it can never carry
 *     `manage_options`, `*`, or `other_plugin_access`) AND must not be a name from the core's own
 *     capability vocabulary (CORE_CAPABILITY_VERBS below — plugin `manage` has the prefix `manage_`,
 *     yet `manage_options` is never its capability);
 *   · the ONLY non-namespaced capabilities a plugin role ever holds are the two the core adds itself:
 *     `read` and `access_admin_panel` — enough to enter the admin shell and reach the user's own
 *     account page, which is exactly what a subscriber already has.
 *
 * Anything else is refused as a whole: a manifest whose roles block has one bad entry registers NO role
 * (an activation must never half-apply).
 *
 * The stateful half (registration, lifecycle, the effective-capability gate every `can()` goes
 * through) lives in core/roles.ts, which plugins cannot require (core/secure-require.ts BLOCKED_CORE).
 */

/** The capabilities the core adds to every plugin role. Nothing else outside the plugin's namespace. */
const IMPLICIT_PLUGIN_ROLE_CAPABILITIES: readonly string[] = Object.freeze(['read', 'access_admin_panel']);

/** The permission a manifest must request (and an administrator grant) for its roles to be registered. */
const ROLES_PERMISSION = Object.freeze({ scope: 'roles', access: 'declare' });

/** Bounds: a roles block is a handful of entries, never a payload. */
const MAX_PLUGIN_ROLES = 10;
const MAX_ROLE_CAPABILITIES = 50;
const MAX_SLUG_LENGTH = 64;
const MAX_CAPABILITY_LENGTH = 100;
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

/** A role slug / capability: lowercase letters, digits and underscores — the core's own vocabulary. */
const IDENTIFIER_RE = /^[a-z0-9_]+$/;

/** The keys a declared role may carry. Provenance (`source`, `plugin`, `orphaned`) is the core's to write. */
const ALLOWED_ROLE_KEYS = new Set(['slug', 'name', 'description', 'capabilities']);

/** The five built-in roles. A plugin role can never take one of these names (the prefix already forbids it). */
const CORE_ROLE_SLUGS: readonly string[] = Object.freeze(['administrator', 'editor', 'author', 'contributor', 'subscriber']);

/**
 * THE CORE'S CAPABILITY VOCABULARY. Every capability the core defines or checks is `<verb>_<object>`
 * with one of these verbs: the built-in roles (edit_posts, publish_pages, moderate_comments …), the
 * screens' gates (manage_options, list_users, promote_users, switch_themes, activate_plugins …) and the
 * families every content type derives from its capability type (core/content-schema.ts: edit_<type>s,
 * edit_others_<type>s, publish_<type>s, delete_published_<type>s, read_private_<type>s).
 *
 * The prefix alone cannot keep a plugin out of them: plugin `manage` has the prefix `manage_`, so
 * `manage_options` "starts with its prefix", and plugin `edit-flow` would own `edit_flow_items`, the
 * capability of a content type called `flow_item`. So a capability that begins with one of these verbs
 * is NEVER in any plugin's namespace — a plugin whose id begins with one (`manage`, `edit-flow`,
 * `list-builder`) cannot declare capabilities at all. plugin-declared-roles.test.ts scans the backend for
 * every capability it checks and fails when one uses a verb missing here. The WordPress verbs the core
 * does not use yet (create, remove, install, update, unfiltered) are reserved too, so adopting one later
 * can never hand it to a plugin that got there first.
 */
const CORE_CAPABILITY_VERBS: readonly string[] = Object.freeze([
    'access', 'activate', 'create', 'delete', 'edit', 'install', 'list', 'manage', 'moderate',
    'promote', 'publish', 'read', 'remove', 'switch', 'unfiltered', 'update', 'upload',
]);

/** Is `capability` a name from the core's own vocabulary (`manage_options`, `edit_flow_items`, `read`)? */
function isCoreCapabilityName(capability: unknown): boolean {
    if (typeof capability !== 'string') return false;
    return CORE_CAPABILITY_VERBS.some((verb) => capability === verb || capability.startsWith(`${verb}_`));
}

/** The namespace PREFIX of a plugin: `conference-manager` → `conference_manager_`. */
function pluginNamespacePrefix(pluginId: string): string {
    return String(pluginId || '').replace(/[^a-z0-9]/g, '_') + '_';
}

/**
 * Does `capability` belong to `pluginId`'s namespace: it carries the plugin's PREFIX (and something
 * after it) AND it is not a name from the core's vocabulary (CORE_CAPABILITY_VERBS). Every read and write
 * of a plugin role goes through this, so a capability such as `manage_options` can never be conferred,
 * stored or forwarded as a plugin capability, whatever the plugin is called.
 */
function isInPluginNamespace(capability: unknown, pluginId: string): boolean {
    if (typeof capability !== 'string') return false;
    const prefix = pluginNamespacePrefix(pluginId);
    return capability.length > prefix.length && capability.startsWith(prefix) && !isCoreCapabilityName(capability);
}

/**
 * The plugin, among `pluginIds`, with the LONGEST prefix for which `matches(name, id)` holds — or null when
 * none matches, or when two different plugins tie for the longest one (`a-b` and `a_b` both map to `a_b_`:
 * a namespace two plugins share is owned by neither, so neither can confer what is in it).
 */
function longestPrefixOwner(name: string, pluginIds: readonly string[], matches: (name: string, id: string) => boolean): string | null {
    let owner: string | null = null;
    let ownerLength = -1;
    let tied = false;
    for (const id of new Set(pluginIds || [])) {
        if (typeof id !== 'string' || !matches(name, id)) continue;
        const len = pluginNamespacePrefix(id).length;
        if (len > ownerLength) { owner = id; ownerLength = len; tied = false; }
        else if (len === ownerLength) tied = true;
    }
    return tied ? null : owner;
}

/**
 * Which plugin OWNS a namespaced capability, among `pluginIds`: the one with the LONGEST prefix the
 * capability starts with. Prefixes nest — `foo` owns `foo_*`, but `foo_bar_*` belongs to `foo-bar` when
 * that plugin is installed — so "starts with my prefix" alone would let plugin `foo` declare a
 * capability that gates plugin `foo-bar`. Returns null when no listed plugin's namespace contains it, or
 * when two listed plugins share the longest matching namespace.
 */
function capabilityOwner(capability: unknown, pluginIds: readonly string[]): string | null {
    if (typeof capability !== 'string') return null;
    return longestPrefixOwner(capability, pluginIds, (c, id) => isInPluginNamespace(c, id));
}

/**
 * Which plugin OWNS a role SLUG, among `pluginIds` — the same longest-prefix rule as capabilities (a slug
 * is never a capability, so the core-verb exclusion does not apply). Plugin `conference` may not register
 * `conference_manager_team` while `conference-manager` is installed: that slug is in the longer namespace.
 */
function roleSlugOwner(slug: unknown, pluginIds: readonly string[]): string | null {
    if (typeof slug !== 'string') return null;
    return longestPrefixOwner(slug, pluginIds, (s, id) => {
        const prefix = pluginNamespacePrefix(id);
        return s.length > prefix.length && s.startsWith(prefix);
    });
}

/**
 * Does `pluginId` own `capability`, given the other installed plugins? In its namespace AND not inside
 * the longer namespace of another plugin in `otherPluginIds`.
 */
function pluginOwnsCapability(pluginId: string, capability: unknown, otherPluginIds: readonly string[] = []): boolean {
    if (!isInPluginNamespace(capability, pluginId)) return false;
    const ids = Array.from(new Set([pluginId, ...(otherPluginIds || [])]));
    return capabilityOwner(capability, ids) === pluginId;
}

/**
 * Installed plugins whose PREFIX is identical to `pluginId`'s (`a-b` and `a_b` both map to `a_b_`).
 * Two plugins sharing a namespace cannot both be given roles: neither could prove a capability is its own.
 */
function namespaceCollisions(pluginId: string, installedPluginIds: readonly string[]): string[] {
    const prefix = pluginNamespacePrefix(pluginId);
    return (installedPluginIds || []).filter((id) => id !== pluginId && pluginNamespacePrefix(id) === prefix);
}

/** Does this manifest declare a (non-empty) roles block? */
function declaresRoles(manifest: any): boolean {
    return !!(manifest && Array.isArray(manifest.roles) && manifest.roles.length > 0);
}

/** Does this manifest request the `roles:declare` permission? */
function requestsRolesPermission(manifest: any): boolean {
    const perms = manifest && Array.isArray(manifest.permissions) ? manifest.permissions : [];
    return perms.some((p: any) => p && p.scope === ROLES_PERMISSION.scope && p.access === ROLES_PERMISSION.access);
}

/** One declared role, normalised to exactly the fields the core stores. */
interface DeclaredPluginRole {
    slug: string;
    name: string;
    description: string;
    capabilities: string[];
}

/**
 * Validate a manifest's `roles` block for plugin `pluginId`. Returns human-readable problems (empty =
 * valid). STATIC: it needs only the manifest, so the upload gate, the marketplace submission gate
 * (scripts/scan-plugin.mjs) and activation all run the same function. The checks that need the live
 * state — a slug already taken by a core/custom/other-plugin role, another installed plugin sharing or
 * nesting inside the namespace — run at registration (core/roles.ts registerPluginRoles).
 */
function validateManifestRoles(pluginId: string, manifest: any): string[] {
    const problems: string[] = [];
    const roles = manifest ? manifest.roles : undefined;
    if (roles === undefined || roles === null) return problems;
    const prefix = pluginNamespacePrefix(pluginId);
    if (!Array.isArray(roles)) return ['`roles` must be an array of role objects.'];
    if (roles.length === 0) return problems;
    if (roles.length > MAX_PLUGIN_ROLES) problems.push(`\`roles\` declares ${roles.length} roles; at most ${MAX_PLUGIN_ROLES} are allowed.`);
    if (!requestsRolesPermission(manifest)) {
        problems.push('`roles` requires the "roles:declare" permission — add {"scope": "roles", "access": "declare", "reason": "…"} to `permissions`.');
    }
    const seen = new Set<string>();
    roles.slice(0, MAX_PLUGIN_ROLES).forEach((role: any, i: number) => {
        const at = `roles[${i}]`;
        if (!role || typeof role !== 'object' || Array.isArray(role)) { problems.push(`${at} must be an object like {slug, name, capabilities}.`); return; }
        for (const key of Object.keys(role)) {
            if (!ALLOWED_ROLE_KEYS.has(key)) problems.push(`${at} has an unknown key "${key}" (allowed: ${Array.from(ALLOWED_ROLE_KEYS).join(', ')}).`);
        }
        const slug = role.slug;
        if (typeof slug !== 'string' || !IDENTIFIER_RE.test(slug) || slug.length > MAX_SLUG_LENGTH) {
            problems.push(`${at}.slug must be lowercase letters, digits and underscores (at most ${MAX_SLUG_LENGTH} characters).`);
        } else if (!slug.startsWith(prefix) || slug.length === prefix.length) {
            problems.push(`${at}.slug "${slug}" must start with "${prefix}" — a plugin's roles live in its own namespace.`);
        } else if (CORE_ROLE_SLUGS.includes(slug)) {
            problems.push(`${at}.slug "${slug}" is a core role.`);
        } else if (seen.has(slug)) {
            problems.push(`${at}.slug "${slug}" is declared twice.`);
        } else {
            seen.add(slug);
        }
        if (typeof role.name !== 'string' || !role.name.trim() || role.name.length > MAX_NAME_LENGTH) {
            problems.push(`${at}.name must be a non-empty string (at most ${MAX_NAME_LENGTH} characters).`);
        }
        if (role.description !== undefined && (typeof role.description !== 'string' || role.description.length > MAX_DESCRIPTION_LENGTH)) {
            problems.push(`${at}.description must be a string (at most ${MAX_DESCRIPTION_LENGTH} characters).`);
        }
        const caps = role.capabilities;
        if (!Array.isArray(caps) || caps.length === 0) {
            problems.push(`${at}.capabilities must be a non-empty array of capabilities starting with "${prefix}".`);
            return;
        }
        if (caps.length > MAX_ROLE_CAPABILITIES) problems.push(`${at}.capabilities lists ${caps.length} entries; at most ${MAX_ROLE_CAPABILITIES} are allowed.`);
        for (const cap of caps.slice(0, MAX_ROLE_CAPABILITIES)) {
            if (typeof cap !== 'string' || !IDENTIFIER_RE.test(cap) || cap.length > MAX_CAPABILITY_LENGTH) {
                problems.push(`${at}.capabilities: ${JSON.stringify(cap)} is not a capability name (lowercase letters, digits and underscores).`);
            } else if (!cap.startsWith(prefix) || cap.length === prefix.length) {
                problems.push(`${at}.capabilities: "${cap}" must start with "${prefix}" — a plugin role may only hold the plugin's own capabilities (the core adds ${IMPLICIT_PLUGIN_ROLE_CAPABILITIES.join(' and ')} itself).`);
            } else if (!isInPluginNamespace(cap, pluginId)) {
                problems.push(`${at}.capabilities: "${cap}" is a name from the core's own capability vocabulary (it begins with "${cap.split('_')[0]}_", like manage_options or edit_posts) — a plugin role can never hold a core capability, so a plugin whose id begins with a core capability verb (${CORE_CAPABILITY_VERBS.join(', ')}) cannot declare capabilities.`);
            }
        }
    });
    return problems;
}

/**
 * The declared roles, normalised. Call only after validateManifestRoles returned no problems.
 * Each role's capabilities become `read` + `access_admin_panel` + the declared (namespaced) ones.
 */
function normaliseDeclaredRoles(manifest: any): DeclaredPluginRole[] {
    if (!declaresRoles(manifest)) return [];
    return manifest.roles.map((role: any) => ({
        slug: role.slug,
        name: role.name.trim(),
        description: typeof role.description === 'string' ? role.description : '',
        capabilities: Array.from(new Set<string>([...IMPLICIT_PLUGIN_ROLE_CAPABILITIES, ...role.capabilities])),
    }));
}

module.exports = {
    IMPLICIT_PLUGIN_ROLE_CAPABILITIES,
    ROLES_PERMISSION,
    CORE_ROLE_SLUGS,
    CORE_CAPABILITY_VERBS,
    MAX_PLUGIN_ROLES,
    isCoreCapabilityName,
    pluginNamespacePrefix,
    isInPluginNamespace,
    capabilityOwner,
    roleSlugOwner,
    pluginOwnsCapability,
    namespaceCollisions,
    declaresRoles,
    requestsRolesPermission,
    validateManifestRoles,
    normaliseDeclaredRoles,
};
