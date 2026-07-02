/**
 * WordJS - Plugin Permission Grants (Android-style, admin-controlled, DEFAULT-DENY)
 *
 * The plugin's manifest declares the permissions it REQUESTS; this registry records what an operator
 * has actually GRANTED per plugin. A bridge capability is allowed only if the manifest declares it AND
 * the admin granted it (see plugin-context.hasPermission) — so a plugin gets NOTHING until an admin
 * approves it in the UI (`/admin/plugins`). Network is a separate, manifest-independent grant (an
 * untrusted plugin has no network unless an admin explicitly grants it, with a warning).
 *
 * Grants are stored SERVER-SIDE (the `plugin_grants` option) — never self-declarable — and mirrored in
 * memory so the host security gates read them synchronously. loadGrants() runs once at boot after the
 * DB is up. The child can't read the DB, so the NETWORK grant is pushed into each isolate's cfg at
 * spawn (→ global.__WORDJS_PLUGIN_NETWORK__); bridge-scope grants are enforced host-side per call.
 *
 * There is NO trust tier: every plugin runs in the child_process sandbox and gets ONLY what an admin
 * has granted (default-deny). No plugin bypasses DB scoping, io-guard, or these grants.
 */

// slug -> set of granted tokens: "scope:access" (e.g. "database:write") and/or the literal "network".
const grants = new Map<string, Set<string>>();
let loaded = false;

/** The literal token used for the network grant (no access level). */
const NETWORK_TOKEN = 'network';

/** Load the persisted grants into memory. Call once at boot, after the DB is up. */
async function loadGrants(): Promise<void> {
    try {
        const { getOption } = require('./options');
        const stored = await getOption('plugin_grants', {});
        grants.clear();
        if (stored && typeof stored === 'object') {
            for (const [slug, list] of Object.entries(stored)) {
                if (Array.isArray(list)) grants.set(String(slug), new Set(list.map(String)));
            }
        }
        loaded = true;
    } catch (e: any) {
        console.warn('[PluginPermissions] Failed to load plugin_grants option:', e && e.message);
    }
}

/** Synchronous grant check used by the host security gates (default-deny). */
function isGranted(slug: string, scope: string, access = 'read'): boolean {
    if (!slug) return false;
    const s = grants.get(slug);
    if (!s) return false;
    // `admin` access implies read+write for that scope.
    return s.has(`${scope}:${access}`) || s.has(`${scope}:admin`);
}

/** Whether the operator granted this (untrusted) plugin outbound network access. */
function isNetworkGranted(slug: string): boolean {
    const s = grants.get(slug);
    return !!(s && s.has(NETWORK_TOKEN));
}

/** The raw granted-token list for a plugin (for the admin UI / API). */
function getGrants(slug: string): string[] {
    return Array.from(grants.get(slug) || []);
}

/**
 * Replace a plugin's grants (admin action). `tokens` is the full new set of granted "scope:access"
 * strings (+ optional "network"). Persists to the `plugin_grants` option and mirrors in memory.
 */
async function setGrants(slug: string, tokens: string[]): Promise<void> {
    const clean = Array.from(new Set((tokens || []).map(t => String(t).toLowerCase().trim()).filter(Boolean)));
    grants.set(slug, new Set(clean));
    const { getOption, updateOption } = require('./options');
    const stored = (await getOption('plugin_grants', {})) || {};
    stored[slug] = clean;
    await updateOption('plugin_grants', stored);
}

/**
 * One-time, non-breaking migration: grant the manifest-declared permissions to plugins that are
 * ALREADY ACTIVE at upgrade time and have NO grants recorded yet — so flipping the model to
 * default-deny doesn't silently break a running site. New activations stay default-deny. `entries` is
 * [{ slug, requested: string[] }] for currently-active plugins. Returns the slugs backfilled.
 */
async function backfillActive(entries: Array<{ slug: string; requested: string[] }>): Promise<string[]> {
    if (!loaded) await loadGrants();
    const done: string[] = [];
    for (const { slug, requested } of entries || []) {
        if (grants.has(slug)) continue; // already has an explicit grant record — respect the admin
        if (!requested || !requested.length) { grants.set(slug, new Set()); done.push(slug); continue; }
        await setGrants(slug, requested); // grandfather what the manifest declared (admin can revoke)
        done.push(slug);
    }
    if (done.length) console.log(`[PluginPermissions] Backfilled manifest grants for already-active plugins: ${done.join(', ')} (default-deny applies to new activations).`);
    return done;
}

/**
 * Remove a plugin's grants entirely (on uninstall). Without this, DELETE left stored[slug] in the
 * plugin_grants option, so re-uploading the same slug silently INHERITED the old (possibly revoked)
 * grants — a real security surprise. Clears both the in-memory mirror and the persisted option.
 */
async function removeGrants(slug: string): Promise<void> {
    grants.delete(slug);
    const { getOption, updateOption } = require('./options');
    const stored = (await getOption('plugin_grants', {})) || {};
    if (Object.prototype.hasOwnProperty.call(stored, slug)) {
        delete stored[slug];
        await updateOption('plugin_grants', stored);
    }
}

// Test-only: set a plugin's grants in memory WITHOUT persisting, so unit tests can grant the
// permissions a default-deny bridge now requires, with no DB dependency.
function _setGrantsInMemory(slug: string, tokens: string[]): void {
    grants.set(slug, new Set((tokens || []).map(t => String(t).toLowerCase().trim()).filter(Boolean)));
}

module.exports = { loadGrants, isGranted, isNetworkGranted, getGrants, setGrants, removeGrants, backfillActive, NETWORK_TOKEN, _setGrantsInMemory };
