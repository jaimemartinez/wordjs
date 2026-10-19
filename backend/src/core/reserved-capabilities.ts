/**
 * WordJS — CORE CAPABILITIES THAT ARE NOT CONTENT CAPABILITIES.
 *
 * A content type names the capabilities its entries are authorized with (permissions.operations, and the
 * `read_private_<family>s` derived from its family), and everything that classifies content capabilities
 * — the post-capability policy, the AI-agent grant mapping (core/agent-capabilities) — trusts that what a
 * type names IS a content capability. A type whose operation were `edit_users` or `manage_options` (or
 * whose family were `user`, which derives `edit_users` / `delete_users`) would turn a content grant into
 * one of these, so:
 *   · core/content-schema refuses such a name at validation (both the declarative schema and the legacy
 *     `capability_type` adapter);
 *   · core/agent-capabilities hard-denies it to every agent, whatever the type registry says.
 * `manage_*` is reserved as a whole. Content capabilities of the core types (`edit_posts`,
 * `publish_pages`, …) are NOT here: a custom type may share them on purpose.
 *
 * No dependencies on purpose: both of those modules load it, and content-schema is pulled in early.
 */

const RESERVED_CORE_CAPABILITIES: ReadonlySet<string> = new Set([
    'read', 'upload_files', 'unfiltered_upload', 'unfiltered_html', 'moderate_comments', 'edit_comments',
    'list_users', 'create_users', 'edit_users', 'promote_users', 'delete_users', 'remove_users', 'add_users',
    'activate_plugins', 'install_plugins', 'edit_plugins', 'delete_plugins', 'update_plugins',
    'switch_themes', 'install_themes', 'edit_themes', 'delete_themes', 'update_themes', 'edit_theme_options',
    'edit_files', 'edit_dashboard', 'customize', 'update_core', 'import', 'export', 'access_admin_panel',
    'create_sites', 'delete_sites', 'upgrade_network', 'setup_network',
]);
const RESERVED_CAPABILITY_PREFIXES: readonly string[] = ['manage_'];

/** Is `cap` a core capability no content type may name? */
function isReservedCoreCapability(cap: unknown): boolean {
    if (typeof cap !== 'string') return false;
    const name = cap.trim().toLowerCase();
    if (name === '*' || RESERVED_CORE_CAPABILITIES.has(name)) return true;
    return RESERVED_CAPABILITY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

module.exports = { isReservedCoreCapability, RESERVED_CORE_CAPABILITIES, RESERVED_CAPABILITY_PREFIXES };
