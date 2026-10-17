/**
 * WordJS - Roles Manager
 * Handles dynamic role creation and capability management
 * Persists roles in the options table
 */

const { getOption } = require('./options');
const config = require('../config/app');
const log = require('./module-logger').moduleLogger('core/roles');

const ROLES_OPTION_NAME = 'wordjs_user_roles';

// Built-in WordPress-style roles. These are the source of truth when the stored wordjs_user_roles
// option is empty/missing — which it was on every install, because options seeded it from the
// hardcoded-empty config.roles, leaving every role (administrator included) with NO capabilities
// and the admin Roles page showing nothing. config.roles is merged over them, but it is always empty
// (config/app explains: there is no operator setting behind it), so in practice these ARE the seed.
const DEFAULT_ROLES: Record<string, { name: string; capabilities: string[] }> = {
    administrator: {
        name: 'Administrator',
        // '*' is the all-capabilities wildcard understood by User.can() / the frontend can() helper.
        capabilities: ['*']
    },
    editor: {
        name: 'Editor',
        capabilities: [
            'read', 'access_admin_panel', 'upload_files',
            'edit_posts', 'edit_others_posts', 'edit_published_posts', 'publish_posts',
            'delete_posts', 'delete_others_posts', 'delete_published_posts',
            'edit_pages', 'edit_others_pages', 'edit_published_pages', 'publish_pages',
            'delete_pages', 'delete_others_pages', 'delete_published_pages',
            'manage_categories', 'moderate_comments'
        ]
    },
    author: {
        name: 'Author',
        capabilities: [
            'read', 'access_admin_panel', 'upload_files',
            'edit_posts', 'edit_published_posts', 'publish_posts',
            'delete_posts', 'delete_published_posts'
        ]
    },
    contributor: {
        name: 'Contributor',
        capabilities: ['read', 'access_admin_panel', 'edit_posts', 'delete_posts']
    },
    subscriber: {
        name: 'Subscriber',
        capabilities: ['read', 'access_admin_panel']
    }
};

// Deep clone so callers/mutations (updateRoleCapabilities, syncRoles) never alter the constant.
const defaultRoles = (): Record<string, any> => JSON.parse(JSON.stringify(DEFAULT_ROLES));

// Cache roles in memory for synchronous access (required by User.toJSON)
// One cache per site in a multisite network (each site has its own roles option). Site 1's state is
// the one a single-site install has always had. Every field below is read through rolesState().
const rolesStateBySite = require('./site-context').perSite(() => ({
    cache: null as Record<string, any> | null,
    loadedAt: 0,
    refreshInFlight: false,
    localWriteEpoch: 0,
}));
const rolesState = (): { cache: Record<string, any> | null; loadedAt: number; refreshInFlight: boolean; localWriteEpoch: number } => rolesStateBySite.get();

// Freshness fallback (multi-node safety net): the primary invalidation path is the Redis pub/sub
// signal handled in coherence.ts. But if Redis is down (or a publish is missed), a role/capability
// REVOCATION on another node would never reach this in-process cache, leaving stale (over-broad)
// capabilities until restart. So we stamp when the cache was loaded and, on synchronous access,
// trigger a background re-read once the cache is older than ROLES_CACHE_TTL_MS. This bounds staleness
// to the TTL (+ one request) and self-heals a missed invalidation, WITHOUT slowing the sync fast path
// (we never block getRoles(); the refresh applies to subsequent calls). The pub/sub fast path still
// invalidates instantly when available.
// Kept short so a missed cross-node revocation (the unsafe, fail-OPEN direction for authorization)
// is corrected quickly. The dedupe is handled by the in-flight flag, not by pre-bumping the stamp,
// so a FAILED background reload does NOT extend staleness for another full TTL.
const ROLES_CACHE_TTL_MS = 10_000; // 10s

// Monotonic local-write epoch (DATA-05). Bumped whenever a LOCAL setRole/updateRoleCapabilities/
// syncRoles mutates the roles cache. The background TTL refresh captures this epoch before its DB read and
// applies the result ONLY if the epoch is unchanged when the read returns — so a stale read (e.g. from
// a lagging replica, or one that started before a local roles write committed) can never clobber a
// just-applied local edit (the fail-OPEN direction for a capability revocation). The genuine self-heal
// for cross-node changes is preserved: when NO local write raced the refresh, the fresh DB value is
// applied exactly as before.

/**
 * Initialize roles from DB (Async)
 * Must be called on app startup
 */
async function loadRoles() {
    const stored = await getOption(ROLES_OPTION_NAME);
    if (stored && Object.keys(stored).length > 0) {
        rolesState().cache = stored;
    } else {
        // Empty/missing option: fall back to the built-in defaults (config.roles, always empty, merged over)
        // and backfill the option so the roles are durable and visible to anything reading the DB. The
        // backfill is a roles write like any other (writeRoles): it saves the defaults only while the
        // stored map is still empty, so a map another node saved after this (cached) read is adopted,
        // never overwritten.
        rolesState().cache = { ...defaultRoles(), ...(config.roles || {}) };
        try {
            await withRolesWriteLock(() => writeRoles(async (current) => ({ next: current, result: undefined })));
        } catch (e: any) {
            log.warn({ err: e }, 'Could not persist default roles');
        }
    }
    rolesState().loadedAt = Date.now(); // stamp freshness on every (re)load
    return rolesState().cache;
}

/**
 * Background, non-blocking refresh when the cache has gone stale. Single-flight guarded so a burst of
 * stale reads triggers at most one DB re-read. Errors are swallowed (the current cache stays usable).
 *
 * DATA-05: unlike the startup loadRoles() (which always applies), this background path is a
 * compare-and-set on the local-write epoch — it reads the DB and applies the result ONLY if no LOCAL write
 * (setRole/updateRoleCapabilities/syncRoles) landed while the read was in flight. That closes the
 * lost-update window where a stale DB read could overwrite a just-applied local revocation. When no
 * local write raced it, the fresh value is applied exactly as the old loadRoles()-based path did.
 */
function maybeRefreshStaleRoles() {
    if (rolesState().refreshInFlight) return;
    if (Date.now() - rolesState().loadedAt < ROLES_CACHE_TTL_MS) return;
    // The in-flight flag alone dedupes concurrent refreshes — do NOT pre-bump the load stamp.
    // The stamp is advanced ONLY on a successful, applied read below. If this background reload FAILS
    // (or is superseded by a local write), the stamp stays old so the very next sync access re-attempts
    // the refresh immediately, instead of believing the cache is fresh and extending stale (over-broad)
    // capabilities for another full TTL (a fail-open authorization window).
    rolesState().refreshInFlight = true;
    const epochAtStart = rolesState().localWriteEpoch;
    Promise.resolve()
        .then(() => getOption(ROLES_OPTION_NAME))
        .then((stored: any) => {
            // A local write landed while we were reading — it is strictly fresher than this DB snapshot
            // (which may even predate the local write's commit), so DROP the read and keep the local
            // value. The local write already stamped the load stamp, so the cache is fresh.
            if (rolesState().localWriteEpoch !== epochAtStart) return;
            if (stored && Object.keys(stored).length > 0) {
                rolesState().cache = stored;
                rolesState().loadedAt = Date.now();
            }
            // Empty/missing option: leave the current in-memory cache (which already holds the seeded
            // defaults) untouched — matching loadRoles()'s "never return an empty map" guarantee. We do
            // NOT re-seed/backfill the option here; the startup loadRoles() owns that.
        })
        .catch((e: any) => log.warn({ err: e }, '[roles] background TTL refresh failed'))
        .finally(() => { rolesState().refreshInFlight = false; });
}

/**
 * Get all available roles (Synchronous from cache)
 */
function getRoles() {
    // If not loaded yet, fall back to the built-in defaults merged with operator config (safe for
    // startup/tests). Never return an empty map — that strips every user of their capabilities.
    if (!rolesState().cache) {
        return { ...defaultRoles(), ...(config.roles || {}) };
    }
    // Bound staleness: kick a background re-read if the cache aged past the TTL (self-heals a missed
    // cross-node invalidation). Non-blocking — returns the current cache immediately.
    maybeRefreshStaleRoles();
    return rolesState().cache;
}

// ── Plugin-declared roles ────────────────────────────────────────────────────────────────────────────
//
// A plugin may declare roles in its manifest (core/plugin-roles.ts holds the namespace rules). They are
// stored in this same map, with provenance: { name, description, capabilities, source: 'plugin',
// plugin: '<plugin id>' [, orphaned: true] }. Three rules keep such a role from ever reaching past its
// plugin, and every one of them is enforced HERE, on every path that reads or writes the map:
//
//   1. THE EFFECTIVE CAPABILITIES of a plugin role (getRoleCapabilities — what User.can() and the
//      frontend see) are its `read`/`access_admin_panel` plus the capabilities in ITS plugin's namespace,
//      and the latter only while the plugin holds the `roles:declare` grant and the role is not
//      orphaned. Whatever else the stored record says — a hand-edited option, a stale blob — is ignored
//      at read time.
//   2. WRITES refuse anything else: registration (registerPluginRoles), the admin API (setRole), and the
//      boot-time sync (syncRoles) all refuse or drop a capability outside the namespace.
//   3. A plugin role never REPLACES another role: registration refuses a slug held by a core role, an
//      administrator-created role or another plugin's role.

const pluginRoles = require('./plugin-roles');

/** Property names that must never be used as a role slug (they select structure, not a role). */
const FORBIDDEN_ROLE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Is `slug` usable as a key of the roles map? */
function isSafeRoleSlug(slug: unknown): slug is string {
    return typeof slug === 'string' && slug.length > 0 && slug.length <= 191 && !FORBIDDEN_ROLE_KEYS.has(slug);
}

/** An OWN entry of the roles map (never an inherited name such as `constructor`). */
function ownRole(roles: Record<string, any> | null | undefined, slug: unknown): any {
    if (!roles || !isSafeRoleSlug(slug)) return null;
    return Object.prototype.hasOwnProperty.call(roles, slug) ? roles[slug] : null;
}

/** Was this role declared by a plugin (as opposed to a core or administrator-created role)? */
function isPluginRole(role: any): boolean {
    return !!(role && typeof role === 'object' && role.source === 'plugin' && typeof role.plugin === 'string' && role.plugin);
}

/** Does `pluginId` currently hold the administrator's `roles:declare` grant? Read live, fail closed. */
function pluginRolesGranted(pluginId: string): boolean {
    try {
        return require('./plugin-permissions').isGranted(pluginId, pluginRoles.ROLES_PERMISSION.scope, pluginRoles.ROLES_PERMISSION.access);
    } catch {
        return false;
    }
}

const isImplicitCapability = (cap: unknown): boolean =>
    typeof cap === 'string' && pluginRoles.IMPLICIT_PLUGIN_ROLE_CAPABILITIES.includes(cap);

/**
 * Does `cap` gate a registered CONTENT TYPE (core/post-types: a schema's permissions.operations)? An
 * administrator names those freely when creating a type — `events_edit`, `events_publish` — so such a
 * name can carry a plugin's prefix without being the plugin's: plugin `events` declaring
 * `events_publish` would let its role's holders create and publish core posts of a type `event`. Such
 * a capability is the core's, never a plugin role's. Read live, so a type created later takes the
 * capability away at once; fails CLOSED (an unreadable registry confers nothing namespaced).
 */
function isContentTypeCapability(cap: unknown): boolean {
    if (typeof cap !== 'string') return false;
    try {
        return require('./post-types').getContentTypeCapabilities().has(cap);
    } catch {
        return true;
    }
}

/**
 * Is `cap` one of `pluginId`'s OWN capabilities — in its namespace (core/plugin-roles.ts: its prefix, no
 * core verb), not inside another installed plugin's longer namespace (when `installedPluginIds` is given)
 * and not a content type's capability? The one test every read and write of a plugin role goes through.
 */
function isOwnPluginCapability(pluginId: string, cap: unknown, installedPluginIds?: string[]): boolean {
    if (isContentTypeCapability(cap)) return false;
    return installedPluginIds
        ? pluginRoles.pluginOwnsCapability(pluginId, cap, installedPluginIds)
        : pluginRoles.isInPluginNamespace(cap, pluginId);
}

/**
 * The capabilities a role ACTUALLY confers (rule 1 above). A core or custom role confers what it
 * stores. A plugin role confers its implicit `read`/`access_admin_panel`, plus its plugin's own
 * capabilities (isOwnPluginCapability) only while the plugin's `roles:declare` grant stands and the role
 * is not orphaned.
 */
function effectiveCapabilitiesOf(role: any): string[] {
    if (!role || typeof role !== 'object') return [];
    const caps: string[] = Array.isArray(role.capabilities) ? role.capabilities.filter((c: unknown) => typeof c === 'string') : [];
    if (!isPluginRole(role)) return caps;
    if (role.orphaned || !pluginRolesGranted(role.plugin)) return caps.filter(isImplicitCapability);
    return caps.filter((c) => isImplicitCapability(c) || isOwnPluginCapability(role.plugin, c));
}

/** The effective capabilities of the role `slug` ([] for an unknown role). */
function getRoleCapabilities(slug: string): string[] {
    return effectiveCapabilitiesOf(ownRole(getRoles(), slug));
}

/** Error thrown by a refused role write; `code` is the REST error code the routes answer with. */
function roleWriteError(code: string, message: string, extra: Record<string, any> = {}) {
    const err: any = new Error(message);
    err.code = code;
    Object.assign(err, extra);
    return err;
}

// ── ONE WAY TO WRITE THE ROLES MAP ────────────────────────────────────────────────────────────────────
//
// Every writer (setRole, removeRole, syncRoles and the plugin-role writers below) saves the WHOLE map, so
// each one must compute it on what the database holds NOW. This node's cache can be one broadcast behind
// another node's edit (the signal is in flight, or was lost), and a map computed on it and saved put back a
// capability the other node had just revoked — in the database, and so on every node once they reloaded
// it. A write (writeRoles) therefore:
//   1. runs one writer at a time in this process (withRolesWriteLock: the plugin-role writers await a
//      holder count per role between their read and their save) AND across nodes (the `wordjs:roles`
//      dist-lock; a no-op on a single host);
//   2. reads the stored map fresh (options.readStoredOption: no option cache tier is consulted) and
//      computes the next one on a copy of it;
//   3. saves it GUARDED on the text it read (persistOption's `expectedRaw`), reading and computing again
//      when the row changed in between — the lease orders this code's writers; the guard also covers a
//      write made outside it (an older node, a restore, a hand edit);
//   4. only then swaps this node's cache, and runs the `updated_option` fan-out once the lease is released.
// Writers inside the chain never call another locked writer (updateRoleCapabilities, which calls setRole,
// takes no lock itself).
let _rolesWriteChain: Promise<unknown> = Promise.resolve();
function withRolesWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = _rolesWriteChain.then(fn, fn);
    _rolesWriteChain = run.then(() => undefined, () => undefined);
    return run;
}

/** The cluster lease every roles write holds (core/dist-lock). */
const ROLES_WRITE_LOCK = 'wordjs:roles';
/** How many times a roles write reads and computes again when another write keeps landing first. */
const ROLES_WRITE_ATTEMPTS = 5;

/**
 * The roles map as STORED, read straight from the database: its exact text (`raw`, null when there is no
 * row — the guard of the write computed on this read) and the map. An absent or empty map reads as the
 * built-in defaults merged with the operator's config.roles, exactly as loadRoles() seeds it (`seeded`).
 * Throws on a database error — a write is never computed on a default it could not confirm.
 */
async function readStoredRoles(): Promise<{ raw: string | null; roles: Record<string, any>; seeded: boolean }> {
    const { raw, value } = await require('./options').readStoredOption(ROLES_OPTION_NAME);
    const stored = !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
    return { raw, roles: stored ? value : { ...defaultRoles(), ...(config.roles || {}) }, seeded: !stored };
}

/** Make `roles` this node's cache: a local write is fresh (TTL clock reset) and wins over an in-flight refresh. */
function adoptRoles(roles: Record<string, any>): void {
    rolesState().cache = roles;
    rolesState().loadedAt = Date.now(); // local write is fresh — reset the TTL clock
    rolesState().localWriteEpoch++;               // DATA-05: an in-flight background refresh must not clobber this
}

interface RolesDecision<T> {
    /** The whole map to save; null — or, over a stored map, a map equal to it — saves nothing. */
    next: Record<string, any> | null;
    /** What the writer answers. */
    result: T;
}

/**
 * THE roles write (see "ONE WAY TO WRITE THE ROLES MAP"). `decide` receives a private deep copy of the
 * stored map and answers the map to save and the writer's result; it may run more than once (when the row
 * changed under it), and only its last answer counts. Call it inside withRolesWriteLock. Throws — nothing
 * saved, the cache untouched — when the lease cannot be taken, the database cannot be read or written, the
 * row keeps changing, or `decide` throws (a refused write).
 */
async function writeRoles<T>(decide: (current: Record<string, any>) => Promise<RolesDecision<T>>): Promise<T> {
    const { acquireBlocking } = require('./dist-lock');
    const lock = await acquireBlocking(ROLES_WRITE_LOCK, { ttlMs: 15000, timeoutMs: 15000 });
    if (!lock.held) throw new Error('Could not acquire the roles lock (another node holds it); the roles were not changed.');
    let announce: (() => Promise<void>) | null = null;
    let outcome: { result: T } | null = null;
    try {
        for (let attempt = 0; !outcome; attempt++) {
            if (attempt >= ROLES_WRITE_ATTEMPTS) {
                throw new Error(`The stored roles changed ${ROLES_WRITE_ATTEMPTS} times while this write was computed; the roles were not changed.`);
            }
            const { raw, roles, seeded } = await readStoredRoles();
            const text = JSON.stringify(roles);
            const { next, result } = await decide(JSON.parse(text));
            // A map equal to the stored one saves nothing — unless nothing is stored yet (the defaults).
            if (!next || (!seeded && JSON.stringify(next) === text)) {
                adoptRoles(JSON.parse(text)); // nothing to save; what was just read is the freshest map there is
                outcome = { result };
                break;
            }
            const res = await require('./options').persistOption(ROLES_OPTION_NAME, next, 'yes', { expectedRaw: raw });
            if (res.written === false) continue; // the row changed since it was read: read and compute again
            adoptRoles(next);
            announce = res.announce;
            outcome = { result };
        }
    } finally {
        await lock.release();
    }
    if (announce) await announce();
    return outcome!.result;
}

/** How many users hold the role `slug` (the role lives in user_meta, meta_key 'role'). */
async function countRoleHolders(slug: string): Promise<number> {
    const { dbAsync } = require('../config/database');
    const row = await dbAsync.get(
        "SELECT COUNT(DISTINCT user_id) AS holders FROM user_meta WHERE meta_key = 'role' AND meta_value = ?", [slug]);
    return Number(row && (row.holders ?? row.HOLDERS)) || 0;
}

interface PluginRoleOptions {
    /** Every installed plugin id — used to refuse a capability inside ANOTHER plugin's (nested) namespace. */
    installedPluginIds?: string[];
    /** Injectable for tests; defaults to a user_meta count. */
    countHolders?: (slug: string) => Promise<number>;
    /** registerPluginRoles only: run every check and throw on a refusal, but write nothing. */
    dryRun?: boolean;
}

// ── An administrator's edits to a plugin role ─────────────────────────────────────────────────────────
// POST /roles may change a plugin role's capabilities (inside the plugin's namespace — setRole refuses
// anything else). Those edits are kept as `adminChanges: { added, removed }` relative to what the plugin
// declares, so every later refresh of the role from the manifest (each boot, each activation, each change
// of the plugin's permission switches) re-applies them instead of silently undoing them: a capability the
// administrator took away to close the plugin's screens to a role stays away.

const uniqueStrings = (list: unknown): string[] =>
    Array.isArray(list) ? Array.from(new Set(list.filter((c): c is string => typeof c === 'string'))) : [];

/** A stored role's `adminChanges`, normalised (arrays of strings; null when there is none). */
function adminChangesOf(role: any): { added: string[]; removed: string[] } | null {
    const ch = role && typeof role === 'object' ? role.adminChanges : null;
    if (!ch || typeof ch !== 'object') return null;
    const added = uniqueStrings(ch.added);
    const removed = uniqueStrings(ch.removed);
    return added.length || removed.length ? { added, removed } : null;
}

/** The capabilities the plugin declared for a stored role, before the administrator's edits. */
function declaredCapabilitiesOf(role: any): string[] {
    const changes = adminChangesOf(role);
    const caps = uniqueStrings(role && role.capabilities);
    if (!changes) return caps;
    return Array.from(new Set([...caps.filter((c) => !changes.added.includes(c)), ...changes.removed]));
}

/** The `adminChanges` of a plugin role whose capabilities an administrator sets to `next`. */
function adminChangesAfterEdit(role: any, next: string[]): { added: string[]; removed: string[] } | null {
    const declared = declaredCapabilitiesOf(role);
    const added = next.filter((c) => !declared.includes(c));
    const removed = declared.filter((c) => !next.includes(c));
    return added.length || removed.length ? { added, removed } : null;
}

interface PluginRoleChanges { registered: string[]; removed: string[]; orphaned: string[] }

/**
 * A role a plugin no longer provides: removed when nobody holds it; otherwise kept, marked orphaned and
 * cut down to `read`/`access_admin_panel`, so its holders keep their account and gain nothing.
 */
async function retirePluginRole(next: Record<string, any>, slug: string, countHolders: (s: string) => Promise<number>,
    out: PluginRoleChanges): Promise<void> {
    const role = next[slug];
    if (await countHolders(slug) > 0) {
        next[slug] = { ...role, capabilities: (role.capabilities || []).filter(isImplicitCapability), orphaned: true };
        out.orphaned.push(slug);
    } else {
        delete next[slug];
        out.removed.push(slug);
    }
}

/**
 * Register (or refresh) the roles plugin `pluginId` declares in `manifest`, all or nothing.
 *
 * Refused — nothing written — when the roles block is invalid (core/plugin-roles.validateManifestRoles),
 * when another installed plugin shares the namespace, when a declared slug or capability falls inside
 * another installed plugin's longer namespace, when a declared capability gates a content type, or when
 * a declared slug is already a core role, an administrator-created role or another plugin's role. The
 * thrown error has code 'PLUGIN_ROLES_REFUSED' and `problems` (strings). `opts.dryRun` runs every check
 * and writes nothing — activation calls it before the plugin's code ever runs.
 *
 * A refresh re-applies the manifest's definition (name, description, capabilities) and, on top of it,
 * the administrator's own edits to the role (`adminChanges`). Roles this plugin registered earlier that
 * the manifest no longer declares are retired (retirePluginRole), so a manifest with no roles block
 * retires all of them.
 */
function registerPluginRoles(pluginId: string, manifest: any, opts: PluginRoleOptions = {}): Promise<PluginRoleChanges> {
    return withRolesWriteLock(() => registerPluginRolesUnlocked(pluginId, manifest, opts));
}

async function registerPluginRolesUnlocked(pluginId: string, manifest: any, opts: PluginRoleOptions): Promise<PluginRoleChanges> {
    const installed = Array.from(new Set([...(opts.installedPluginIds || []), pluginId]));
    const countHolders = opts.countHolders || countRoleHolders;
    const manifestProblems: string[] = pluginRoles.validateManifestRoles(pluginId, manifest);
    const declared = manifestProblems.length ? [] : pluginRoles.normaliseDeclaredRoles(manifest);

    if (declared.length) {
        const shared = pluginRoles.namespaceCollisions(pluginId, installed);
        if (shared.length) {
            manifestProblems.push(`plugin "${pluginId}" shares the namespace "${pluginRoles.pluginNamespacePrefix(pluginId)}" with ${shared.map((s: string) => `"${s}"`).join(', ')} — no plugin can declare roles in a shared namespace.`);
        }
    }
    /** Throws PLUGIN_ROLES_REFUSED when the declared roles cannot be registered over the map `current`. */
    const refuseProblems = (current: Record<string, any>): void => {
        const problems = [...manifestProblems];
        for (const role of declared) {
            const existing = ownRole(current, role.slug);
            if (existing && !(isPluginRole(existing) && existing.plugin === pluginId)) {
                const owner = isPluginRole(existing) ? `a role of plugin "${existing.plugin}"`
                    : (pluginRoles.CORE_ROLE_SLUGS.includes(role.slug) ? 'a core role' : 'a role created by an administrator');
                problems.push(`role "${role.slug}" already exists as ${owner} — a plugin role cannot replace it.`);
            }
            const slugOwner = pluginRoles.roleSlugOwner(role.slug, installed);
            if (slugOwner && slugOwner !== pluginId) {
                problems.push(`role "${role.slug}" is in the namespace of plugin "${slugOwner}" ("${pluginRoles.pluginNamespacePrefix(slugOwner)}") — a plugin may not name a role after another plugin's namespace.`);
            }
            for (const cap of role.capabilities) {
                if (isImplicitCapability(cap)) continue;
                if (isContentTypeCapability(cap)) {
                    problems.push(`role "${role.slug}": capability "${cap}" gates a content type (Content types → permissions) — it is a core capability, never a plugin role's.`);
                } else if (!pluginRoles.pluginOwnsCapability(pluginId, cap, installed)) {
                    const owner = pluginRoles.capabilityOwner(cap, installed);
                    problems.push(owner
                        ? `role "${role.slug}": capability "${cap}" belongs to the namespace of plugin "${owner}".`
                        : `role "${role.slug}": capability "${cap}" is in a namespace this plugin does not own.`);
                }
            }
        }
        if (problems.length) {
            throw roleWriteError('PLUGIN_ROLES_REFUSED',
                `Plugin "${pluginId}" declares roles that cannot be registered:\n- ${problems.join('\n- ')}`, { problems });
        }
    };
    if (opts.dryRun) {
        refuseProblems((await readStoredRoles()).roles);
        return { registered: declared.map((r: any) => r.slug), removed: [], orphaned: [] };
    }

    return writeRoles(async (next) => {
        refuseProblems(next);
        const result: PluginRoleChanges = { registered: [], removed: [], orphaned: [] };
        const declaredSlugs = new Set(declared.map((r: any) => r.slug));
        for (const role of declared) {
            // The administrator's edits to this role (POST /roles) survive the refresh: what they took away
            // stays away, what they added (inside the namespace) stays.
            const previous = ownRole(next, role.slug);
            const changes = isPluginRole(previous) && previous.plugin === pluginId ? adminChangesOf(previous) : null;
            let capabilities: string[] = role.capabilities;
            if (changes) {
                capabilities = Array.from(new Set([
                    ...capabilities.filter((c) => !changes.removed.includes(c)),
                    ...changes.added.filter((c) => isImplicitCapability(c) || isOwnPluginCapability(pluginId, c, installed)),
                ]));
            }
            next[role.slug] = {
                name: role.name,
                description: role.description,
                capabilities,
                source: 'plugin',
                plugin: pluginId,
                ...(changes ? { adminChanges: changes } : {}),
            };
            result.registered.push(role.slug);
        }
        for (const slug of Object.keys(next)) {
            const role = next[slug];
            if (isPluginRole(role) && role.plugin === pluginId && !declaredSlugs.has(slug) && !role.orphaned) {
                await retirePluginRole(next, slug, countHolders, result);
            }
        }
        return { next, result };
    });
}

/**
 * The plugin was DELETED: retire every role it provided (removed when unheld, otherwise orphaned with
 * only `read`/`access_admin_panel`). Deactivation does NOT call this — a deactivated plugin's roles stay,
 * inert, so reactivating it gives its team back exactly what they had.
 */
function releasePluginRoles(pluginId: string, opts: PluginRoleOptions = {}): Promise<PluginRoleChanges> {
    const countHolders = opts.countHolders || countRoleHolders;
    return withRolesWriteLock(() => writeRoles(async (next) => {
        const result: PluginRoleChanges = { registered: [], removed: [], orphaned: [] };
        for (const slug of Object.keys(next)) {
            const role = next[slug];
            if (isPluginRole(role) && role.plugin === pluginId && !role.orphaned) await retirePluginRole(next, slug, countHolders, result);
        }
        return { next: result.removed.length || result.orphaned.length ? next : null, result };
    }));
}

/**
 * Bring one stored plugin role back inside its namespace (rule 2). Returns the cleaned record, or the
 * very same object when nothing had to change. A record is cut to the implicit capabilities and orphaned
 * when its slug does not carry its plugin's prefix (registerPluginRoles never wrote it) and — when the
 * installed plugin ids are known — when its plugin is no longer installed (its folder was removed by hand,
 * or a backup from another site was restored) or another installed plugin's longer namespace holds its
 * slug. Its capabilities keep only what isOwnPluginCapability allows.
 */
function sanitizePluginRole(slug: string, role: any, installedPluginIds?: string[]): any {
    const caps: unknown[] = Array.isArray(role.capabilities) ? role.capabilities : [];
    const prefixOk = typeof slug === 'string' && slug.startsWith(pluginRoles.pluginNamespacePrefix(role.plugin));
    // roleSlugOwner answers only with a LISTED plugin: a plugin missing from the list owns nothing.
    const installedOk = !installedPluginIds || pluginRoles.roleSlugOwner(slug, installedPluginIds) === role.plugin;
    const orphaned = !!role.orphaned || !prefixOk || !installedOk;
    const keep = caps.filter((c) => isImplicitCapability(c) || (!orphaned && isOwnPluginCapability(role.plugin, c, installedPluginIds)));
    if (keep.length === caps.length && orphaned === !!role.orphaned && Array.isArray(role.capabilities)) return role;
    return { ...role, capabilities: keep, ...(orphaned ? { orphaned: true } : {}) };
}

/**
 * Re-check every stored plugin role against the CURRENTLY installed plugins: a capability that now falls
 * inside another plugin's longer namespace (plugin `foo-bar` installed after plugin `foo` declared
 * `foo_bar_x`), or in a namespace two installed plugins share, is dropped from the role that does not own
 * it; a role whose plugin is gone, or whose slug another plugin's longer namespace now holds, is orphaned.
 * Called on every plugin activation.
 */
function enforcePluginRoleNamespaces(installedPluginIds: string[]): Promise<string[]> {
    return withRolesWriteLock(async () => {
        const changed = await writeRoles(async (next) => {
            const trimmed: string[] = [];
            for (const slug of Object.keys(next)) {
                if (!isPluginRole(next[slug])) continue;
                const clean = sanitizePluginRole(slug, next[slug], installedPluginIds);
                if (clean !== next[slug]) { next[slug] = clean; trimmed.push(slug); }
            }
            return { next: trimmed.length ? next : null, result: trimmed };
        });
        if (changed.length) log.warn(`[roles] plugin roles trimmed back into their own namespace: ${changed.join(', ')}`);
        return changed;
    });
}

/**
 * The capabilities of `user` that belong to plugin `pluginId` — what the host forwards to that plugin's
 * isolate as `req.user.pluginCapabilities`. Only capabilities in the plugin's own namespace (never a
 * core capability, never another plugin's), and nothing at all from a role ANOTHER plugin declared.
 * An administrator (or any '*' holder) receives every capability the plugin's own roles confer.
 * `otherPluginIds` (the installed plugins) excludes a capability nested inside another plugin's namespace.
 */
function pluginCapabilitiesFor(user: any, pluginId: string, otherPluginIds: string[] = []): string[] {
    if (!user || !pluginId) return [];
    const roleSlug = typeof user.getRole === 'function' ? user.getRole() : user.role;
    const roles = getRoles();
    const role = ownRole(roles, roleSlug);
    const others = (otherPluginIds || []).filter((id) => id !== pluginId);
    const owned = (c: unknown) => isOwnPluginCapability(pluginId, c, others);
    const all = roleSlug === 'administrator' ? ['*'] : effectiveCapabilitiesOf(role);
    if (all.includes('*')) {
        const caps = new Set<string>();
        for (const slug of Object.keys(roles)) {
            const r = roles[slug];
            if (isPluginRole(r) && r.plugin === pluginId) effectiveCapabilitiesOf(r).filter(owned).forEach((c) => caps.add(c));
        }
        return Array.from(caps).sort();
    }
    if (isPluginRole(role) && role.plugin !== pluginId) return [];
    return Array.from(new Set(all.filter(owned))).sort();
}

/**
 * Add or Update a role
 *
 * A PLUGIN role keeps its provenance (source/plugin/description) and may only ever hold `read`,
 * `access_admin_panel` and its plugin's own capabilities (isOwnPluginCapability): anything else is
 * refused with code 'rest_role_plugin_capability' and nothing is written. Provenance is never taken from
 * `roleData`, so a role created through the admin API is always an administrator's own. An accepted edit
 * of a plugin role is remembered as its `adminChanges`, so the plugin's next refresh keeps it.
 */
function setRole(slug: string, roleData: any, opts: PluginRoleOptions = {}) {
    return withRolesWriteLock(() => setRoleUnlocked(slug, roleData, opts));
}

async function setRoleUnlocked(slug: string, roleData: any, opts: PluginRoleOptions) {
    if (!isSafeRoleSlug(slug)) throw roleWriteError('rest_invalid_param', `Invalid role slug: ${JSON.stringify(slug)}`);

    // Decided on the STORED map (writeRoles): whether `slug` is a plugin's role, and what it holds, is what
    // the database says now, not what this node's cache last heard.
    return writeRoles(async (current) => {
        const existing = ownRole(current, slug);
        let record: any;
        if (isPluginRole(existing)) {
            const caps = roleData.capabilities;
            if (!Array.isArray(caps)) {
                throw roleWriteError('rest_role_plugin_capability', `Role "${slug}" is provided by plugin "${existing.plugin}": capabilities must be a list.`);
            }
            const outside = caps.filter((c: unknown) => !isImplicitCapability(c)
                && (existing.orphaned || !isOwnPluginCapability(existing.plugin, c, opts.installedPluginIds)));
            if (outside.length) {
                throw roleWriteError('rest_role_plugin_capability',
                    `Role "${slug}" is provided by plugin "${existing.plugin}" and may only hold ${pluginRoles.IMPLICIT_PLUGIN_ROLE_CAPABILITIES.join(', ')}`
                    + `${existing.orphaned ? '' : ` and capabilities starting with "${pluginRoles.pluginNamespacePrefix(existing.plugin)}" (never a name from the core's own vocabulary, nor a content type's capability)`} — refused: ${outside.map((c: unknown) => JSON.stringify(c)).join(', ')}.`,
                    { refused: outside });
            }
            const next: string[] = Array.from(new Set(caps));
            const { adminChanges: _previous, ...rest } = existing;
            const changes = adminChangesAfterEdit(existing, next);
            record = { ...rest, name: roleData.name, capabilities: next, ...(changes ? { adminChanges: changes } : {}) };
        } else {
            record = {
                name: roleData.name,
                capabilities: roleData.capabilities || []
            };
        }
        // The next map is rebuilt from entries rather than written through a dynamic key: the slug was
        // checked by isSafeRoleSlug above, and a role is only ever an own entry of the map.
        const next = new Map(Object.entries(current));
        next.set(slug, record);
        return { next: Object.fromEntries(next), result: true };
    });
}

/**
 * Get a single role by slug
 */
function getRole(slug: string) {
    // An OWN entry only: `roles['constructor']` would otherwise answer with Object's constructor.
    return ownRole(getRoles(), slug);
}

/**
 * Remove a role
 */
function removeRole(slug: string) {
    return withRolesWriteLock(() => writeRoles(async (current) => {
        if (!ownRole(current, slug)) return { next: null, result: false };
        const next = new Map(Object.entries(current));
        next.delete(slug);
        return { next: Object.fromEntries(next), result: true };
    }));
}

/**
 * Update capabilities for a specific role
 */
async function updateRoleCapabilities(slug: string, capabilities: any[]) {
    const role = getRole(slug);
    if (role) {
        // Never mutate the cached record before setRole has validated the change (a refused write to a
        // plugin role must leave the cache exactly as it was).
        return await setRole(slug, { ...role, capabilities });
    }
    return false;
}

/**
 * Get all unique capabilities currently defined across all roles
 */
function getAllAvailableCapabilities() {
    const roles = getRoles();
    const caps = new Set();
    Object.values(roles).forEach((role: any) => {
        if (role.capabilities) {
            role.capabilities.forEach((cap: any) => caps.add(cap));
        }
    });

    // Add known core capabilities that might not be assigned yet
    const coreCaps = [
        'read', 'edit_posts', 'publish_posts', 'delete_posts',
        'edit_pages', 'publish_pages', 'delete_pages',
        'manage_categories', 'moderate_comments', 'upload_files',
        'list_users', 'edit_users', 'promote_users', 'delete_users',
        'activate_plugins', 'switch_themes', 'manage_options',
        'edit_theme_options',
        // API tokens are no longer self-service for every logged-in user: creating/listing/revoking a
        // personal API token now requires this capability. Administrators hold it via the '*' wildcard;
        // grant it to another role in Users → Roles to let those users mint their own scoped tokens.
        'manage_api_tokens'
    ];
    coreCaps.forEach(cap => caps.add(cap));

    // Add capabilities from registered menus (plugins)
    try {
        const { getAllRegisteredCapabilities } = require('./adminMenu');
        const pluginCaps = getAllRegisteredCapabilities();
        pluginCaps.forEach((cap: any) => caps.add(cap));
    } catch (err) {
        log.warn({ err }, 'Could not load plugin capabilities');
    }

    return Array.from(caps);
}

/**
 * Sync roles with configuration on startup
 * Ensures critical capabilities are present
 */
function syncRoles(configRoles: any, installedPluginIds?: string[]) {
    return withRolesWriteLock(() => syncRolesUnlocked(configRoles, installedPluginIds));
}

async function syncRolesUnlocked(configRoles: any, installedPluginIds?: string[]) {
    // Computed on the STORED map (writeRoles), like every other roles write.
    return writeRoles(async (dbRoles) => {
        const changed = syncRoleMap(dbRoles, configRoles, installedPluginIds);
        return { next: changed ? dbRoles : null, result: changed };
    });
}

/** syncRoles' changes, applied to `dbRoles` in place; true when anything changed. */
function syncRoleMap(dbRoles: Record<string, any>, configRoles: any, installedPluginIds?: string[]): boolean {
    let changed = false;

    // Built-in defaults guarantee the core roles always exist (config.roles, always empty — see
    // config/app — is merged over them).
    const effective = { ...defaultRoles(), ...(configRoles || {}) };

    // Check subscriber specifically for the access_admin_panel capability
    if (dbRoles.subscriber && effective.subscriber) {
        const dbCaps = dbRoles.subscriber.capabilities || [];
        const effCaps = effective.subscriber.capabilities || [];

        // If DB is missing access_admin_panel but the effective definition has it, FORCE update
        if (!dbCaps.includes('access_admin_panel') && effCaps.includes('access_admin_panel')) {
            log.info('🔄 Syncing Subscriber roles: Adding access_admin_panel');
            dbRoles.subscriber.capabilities = effCaps;
            changed = true;
        }
    }

    // General sync for missing roles (seeds the core roles on existing installs whose stored map
    // predates them).
    for (const [slug, role] of Object.entries(effective)) {
        if (!dbRoles[slug]) {
            log.info({ slug }, `➕ Adding missing role: ${slug}`);
            dbRoles[slug] = role;
            changed = true;
        }
    }

    // Plugin-declared roles (rule 2 above): the stored map is the one thing a boot trusts, so it is the
    // one thing a boot re-checks — LAST, so a role the operator's config.roles just seeded is checked
    // too. A core role never carries plugin provenance; a plugin role never carries a capability outside
    // its plugin's namespace (nested namespaces too, when the caller passes the installed plugin ids).
    // Whatever got into the option some other way is cut here.
    for (const slug of Object.keys(dbRoles)) {
        const role = dbRoles[slug];
        if (!role || typeof role !== 'object') continue;
        if (pluginRoles.CORE_ROLE_SLUGS.includes(slug)) {
            if ('source' in role || 'plugin' in role || 'orphaned' in role || 'adminChanges' in role) {
                const { source: _s, plugin: _p, orphaned: _o, adminChanges: _a, ...rest } = role;
                dbRoles[slug] = rest;
                log.warn({ slug }, `[roles] core role '${slug}' carried plugin provenance — removed.`);
                changed = true;
            }
            continue;
        }
        if (!isPluginRole(role)) continue;
        const clean = sanitizePluginRole(slug, role, installedPluginIds);
        if (clean !== role) {
            dbRoles[slug] = clean;
            log.warn({ slug }, `[roles] plugin role '${slug}' held capabilities outside its plugin's namespace — removed.`);
            changed = true;
        }
    }

    return changed;
}

module.exports = {
    loadRoles,
    getRoles,
    getRole,
    setRole,
    removeRole,
    updateRoleCapabilities,
    getAllAvailableCapabilities,
    syncRoles,
    // Plugin-declared roles
    isPluginRole,
    ownRole,
    getRoleCapabilities,
    registerPluginRoles,
    releasePluginRoles,
    enforcePluginRoleNamespaces,
    pluginCapabilitiesFor,
    countRoleHolders,
};
