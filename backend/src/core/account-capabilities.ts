/**
 * WordJS — PLUGIN-DECLARED ACCOUNT CAPABILITIES: per-account grants an administrator gives, on behalf of
 * a plugin, without the core knowing what they mean.
 *
 * A role describes what a whole class of accounts may do. Some plugin features are instead a per-ACCOUNT
 * decision that has nothing to do with the role: "this editor gets a mailbox", "this author may sell
 * tickets". A plugin declares such a capability in its manifest:
 *
 *     "accountCapabilities": [
 *       { "slug": "<prefix>_<name>", "name": "Shown in the user screen", "description": "…",
 *         "locksEmail": true, "defaultForNewAccounts": true }
 *     ]
 *
 * and the core does the rest, generically:
 *
 *   · THE NAMESPACE. A slug must be in the plugin's own namespace (core/plugin-roles.ts: its id-derived
 *     prefix, no core capability verb, not inside another installed plugin's longer namespace). Declarations
 *     are re-checked every time they are read, so a hand-edited manifest cannot name another plugin's
 *     capability; activation and upload refuse an invalid block outright.
 *   · THE GRANT. Stored per account as user_meta `account_capability:<slug>` = '1' / '0'. Only a caller
 *     holding `edit_users` may change it (routes/users.ts), it is never self-assignable (PUT /users/me does
 *     not read it, and the meta prefix is in User.update's PROTECTED_META, so no generic `meta` bag reaches
 *     it), and it is never derived from anything the account writes — the email address included.
 *     An administrator does NOT hold account capabilities implicitly: the grant is always explicit.
 *   · THE USER SCREEN renders one toggle per capability declared by an ACTIVE plugin, from the declaration
 *     (GET /users/account-capabilities), for `edit_users` holders only.
 *   · THE PROJECTION. A plugin is told which of ITS OWN capabilities an account holds — `accountCapabilities`
 *     on a route's req.user and on every users-bridge result — and never another plugin's.
 *   · THE TWO GENERIC EFFECTS a declaration may ask the core for: `locksEmail` (while granted, the account
 *     cannot move its own address — core/email-address refuseSelfServiceEmailChange) and an admin menu item's
 *     `requiresAccountCapability` (the item is hidden from non-administrators who lack the grant). Both only
 *     ever RESTRICT, which is why declaring a capability needs no permission: by itself it confers nothing.
 *
 * Deactivating a plugin keeps its grants stored (and still enforces `locksEmail`, read from the installed
 * manifest), so reactivating it restores exactly the previous state.
 */

const log = require('./module-logger').moduleLogger('core/account-capabilities');
const pluginRoles = require('./plugin-roles');

/** The user_meta key prefix holding the grants. Protected (models/User.ts PROTECTED_META_PREFIXES). */
const ACCOUNT_CAPABILITY_META_PREFIX = 'account_capability:';

const MAX_ACCOUNT_CAPABILITIES = 10;
const MAX_SLUG_LENGTH = 100;
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const IDENTIFIER_RE = /^[a-z0-9_]+$/;
const ALLOWED_KEYS = new Set(['slug', 'name', 'description', 'locksEmail', 'defaultForNewAccounts']);

export interface AccountCapabilityDeclaration {
    slug: string;
    plugin: string;
    name: string;
    description: string;
    locksEmail: boolean;
    defaultForNewAccounts: boolean;
}

/** The user_meta key for capability `slug`. */
function metaKeyFor(slug: string): string {
    return ACCOUNT_CAPABILITY_META_PREFIX + slug;
}

/** Normalize any truthy/falsy input to the stored representation ('1' / '0'). */
function flagValue(on: any): string {
    // Accept the JSON shapes a form/API client can send: true, 'true', 1, '1', 'on'.
    const s = String(on == null ? '' : on).trim().toLowerCase();
    return (on === true || s === '1' || s === 'true' || s === 'on') ? '1' : '0';
}

/**
 * Validate a manifest's `accountCapabilities` block for plugin `pluginId`. Returns human-readable problems
 * (empty = valid). `installedPluginIds`, when given, also refuses a slug nested in another installed
 * plugin's namespace.
 */
function validateManifestAccountCapabilities(pluginId: string, manifest: any, installedPluginIds?: string[]): string[] {
    const problems: string[] = [];
    const block = manifest ? manifest.accountCapabilities : undefined;
    if (block === undefined || block === null) return problems;
    if (!Array.isArray(block)) return ['`accountCapabilities` must be an array of {slug, name} objects.'];
    if (block.length > MAX_ACCOUNT_CAPABILITIES) problems.push(`\`accountCapabilities\` declares ${block.length} entries; at most ${MAX_ACCOUNT_CAPABILITIES} are allowed.`);
    const prefix = pluginRoles.pluginNamespacePrefix(pluginId);
    const others = (installedPluginIds || []).filter((id) => id !== pluginId);
    const seen = new Set<string>();
    block.slice(0, MAX_ACCOUNT_CAPABILITIES).forEach((entry: any, i: number) => {
        const at = `accountCapabilities[${i}]`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { problems.push(`${at} must be an object like {slug, name}.`); return; }
        for (const key of Object.keys(entry)) {
            if (!ALLOWED_KEYS.has(key)) problems.push(`${at} has an unknown key "${key}" (allowed: ${Array.from(ALLOWED_KEYS).join(', ')}).`);
        }
        const slug = entry.slug;
        if (typeof slug !== 'string' || !IDENTIFIER_RE.test(slug) || slug.length > MAX_SLUG_LENGTH) {
            problems.push(`${at}.slug must be lowercase letters, digits and underscores (at most ${MAX_SLUG_LENGTH} characters).`);
        } else if (!pluginRoles.isInPluginNamespace(slug, pluginId)) {
            problems.push(`${at}.slug "${slug}" must start with "${prefix}" and must not be a name from the core's capability vocabulary — a plugin's account capabilities live in its own namespace.`);
        } else if (others.length && !pluginRoles.pluginOwnsCapability(pluginId, slug, others)) {
            problems.push(`${at}.slug "${slug}" is inside the namespace of another installed plugin.`);
        } else if (seen.has(slug)) {
            problems.push(`${at}.slug "${slug}" is declared twice.`);
        } else {
            seen.add(slug);
        }
        if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > MAX_NAME_LENGTH) {
            problems.push(`${at}.name must be a non-empty string (at most ${MAX_NAME_LENGTH} characters).`);
        }
        if (entry.description !== undefined && (typeof entry.description !== 'string' || entry.description.length > MAX_DESCRIPTION_LENGTH)) {
            problems.push(`${at}.description must be a string (at most ${MAX_DESCRIPTION_LENGTH} characters).`);
        }
        for (const flag of ['locksEmail', 'defaultForNewAccounts']) {
            if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') problems.push(`${at}.${flag} must be true or false.`);
        }
    });
    return problems;
}

/**
 * The valid declarations of every INSTALLED plugin (active or not), each tagged with its plugin. An invalid
 * block contributes nothing (fail closed) and is logged once per process. Short TTL cache: the user form,
 * the users routes and every plugin route projection read this, and manifests change only on install.
 */
const DECLARATIONS_TTL_MS = 2000;
let declarationsCache: { at: number; list: AccountCapabilityDeclaration[] } | null = null;
const warnedInvalid = new Set<string>();

function installedDeclarations(): AccountCapabilityDeclaration[] {
    const now = Date.now();
    if (declarationsCache && now - declarationsCache.at < DECLARATIONS_TTL_MS) return declarationsCache.list;
    const list: AccountCapabilityDeclaration[] = [];
    try {
        const plugins: any[] = require('./plugins').scanPlugins();
        const installed = plugins.map((p) => p.slug);
        for (const p of plugins) {
            const block = p.accountCapabilities;
            if (!Array.isArray(block) || !block.length) continue;
            const problems = validateManifestAccountCapabilities(p.slug, { accountCapabilities: block }, installed);
            if (problems.length) {
                if (!warnedInvalid.has(p.slug)) {
                    warnedInvalid.add(p.slug);
                    log.warn({ plugin: p.slug, problems }, `[account-capabilities] '${p.slug}' declares an invalid accountCapabilities block — none of it is used.`);
                }
                continue;
            }
            for (const entry of block) {
                list.push({
                    slug: entry.slug,
                    plugin: p.slug,
                    name: entry.name.trim(),
                    description: typeof entry.description === 'string' ? entry.description : '',
                    locksEmail: entry.locksEmail === true,
                    defaultForNewAccounts: entry.defaultForNewAccounts === true,
                });
            }
        }
    } catch (e: any) {
        log.warn({ err: e }, '[account-capabilities] could not read the installed plugin manifests');
    }
    declarationsCache = { at: now, list };
    return list;
}

/** Drop the declarations cache (plugin install / delete / tests). */
function invalidateDeclarations(): void {
    declarationsCache = null;
}

/** The declarations of the ACTIVE plugins — what the user screen renders and what a write may name. */
async function activeDeclarations(): Promise<AccountCapabilityDeclaration[]> {
    let active: string[] = [];
    try { active = await require('./plugins').getActivePlugins(); } catch { active = []; }
    const on = new Set(Array.isArray(active) ? active : []);
    return installedDeclarations().filter((d) => on.has(d.plugin));
}

/** The user_meta map of a User instance (meta loaded), a projection's meta, or a bare meta map. */
function metaOf(user: any): Record<string, any> {
    if (!user || typeof user !== 'object') return {};
    const meta = (user.meta && typeof user.meta === 'object') ? user.meta : user;
    return meta || {};
}

/**
 * Every capability slug `user` has been granted ('1'), whatever plugin declared it. Read from the meta
 * loaded with the user (middleware/auth.ts rebuilds req.user from the database on every request, so a
 * revocation denies the very next request). A raw row without meta holds nothing (fail closed).
 */
function grantedAccountCapabilities(user: any): string[] {
    const meta = metaOf(user);
    const out: string[] = [];
    for (const [key, value] of Object.entries(meta)) {
        if (!key.startsWith(ACCOUNT_CAPABILITY_META_PREFIX)) continue;
        if (String(value ?? '') !== '1') continue;
        const slug = key.slice(ACCOUNT_CAPABILITY_META_PREFIX.length);
        if (IDENTIFIER_RE.test(slug)) out.push(slug);
    }
    return require('./legacy-account-flags').applyLegacyVeto(meta, out).sort();
}

/** Does `user` hold capability `slug`? */
function hasAccountCapability(user: any, slug: string): boolean {
    return typeof slug === 'string' && grantedAccountCapabilities(user).includes(slug);
}

/**
 * The capabilities of `user` that belong to plugin `pluginId` — what that plugin is told (and only that
 * plugin). Decided against the INSTALLED plugins, so a nested namespace is never leaked to its parent.
 */
function accountCapabilitiesFor(user: any, pluginId: string): string[] {
    if (!user || !pluginId) return [];
    let installed: string[] = [];
    try { installed = require('./plugins').listInstalledPluginIdsCached(); } catch { installed = []; }
    const others = installed.filter((id) => id !== pluginId);
    return grantedAccountCapabilities(user).filter((slug) => pluginRoles.pluginOwnsCapability(pluginId, slug, others));
}

/** Does any capability `user` holds bind its email address (`locksEmail`, installed plugins)? */
function locksEmail(user: any): boolean {
    const granted = grantedAccountCapabilities(user);
    if (!granted.length) return false;
    const locking = new Set(installedDeclarations().filter((d) => d.locksEmail).map((d) => d.slug));
    for (const slug of require('./legacy-account-flags').legacyLockingCapabilities()) locking.add(slug);
    return granted.some((slug) => locking.has(slug));
}

/**
 * Plan a write of the `accountCapabilities` request field — a map {slug: on/off} — against the account
 * `target` (null for a new account). Returns the CHANGES ONLY (an unchanged resend is not a write: the user
 * form posts every toggle on every save), or an error body for a malformed field or a slug no active plugin
 * declares. The caller proves `edit_users` before applying a non-empty plan.
 */
async function planAccountCapabilityWrite(target: any, input: any): Promise<{ changes: Record<string, string>; error?: any }> {
    if (input === undefined) return { changes: {} };
    const bad = (message: string) => ({ changes: {}, error: { code: 'rest_invalid_param', message, data: { status: 400 } } });
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return bad('accountCapabilities must be an object mapping a capability to true or false.');
    }
    const declared = new Set((await activeDeclarations()).map((d) => d.slug));
    // DEPRECATED — the capability an outdated, active mail plugin still writes (core/legacy-account-flags.ts).
    let active: string[] = [];
    try { active = await require('./plugins').getActivePlugins(); } catch { active = []; }
    for (const slug of require('./legacy-account-flags').legacyWritableCapabilities(active)) declared.add(slug);
    const current = new Set(target ? grantedAccountCapabilities(target) : []);
    const changes: Record<string, string> = {};
    for (const [slug, value] of Object.entries(input)) {
        const next = flagValue(value);
        if ((next === '1') === current.has(slug)) continue;   // unchanged resend — not a write, declared or not
        // A CHANGE must name a capability an active plugin declares: an inactive plugin's grant stays as it
        // is until the plugin is back, and a name nobody declares is never stored.
        if (!declared.has(slug)) return bad(`Unknown account capability "${String(slug).slice(0, 100)}": no active plugin declares it.`);
        changes[slug] = next;
    }
    return { changes };
}

/** Apply a plan from planAccountCapabilityWrite (User.create / User.update call this). */
async function applyAccountCapabilityChanges(userId: number, changes: Record<string, string> | undefined): Promise<void> {
    if (!changes) return;
    const User = require('../models/User');
    for (const [slug, value] of Object.entries(changes)) {
        if (!IDENTIFIER_RE.test(slug)) continue;
        await User.updateMeta(userId, metaKeyFor(slug), value === '1' ? '1' : '0');
        await require('./legacy-account-flags').mirrorLegacyWrite(userId, slug, value === '1' ? '1' : '0');
    }
}

module.exports = {
    ACCOUNT_CAPABILITY_META_PREFIX,
    metaKeyFor,
    flagValue,
    validateManifestAccountCapabilities,
    installedDeclarations,
    activeDeclarations,
    invalidateDeclarations,
    grantedAccountCapabilities,
    hasAccountCapability,
    accountCapabilitiesFor,
    locksEmail,
    planAccountCapabilityWrite,
    applyAccountCapabilityChanges,
};
