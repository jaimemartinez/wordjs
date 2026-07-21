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

// slug -> list of egress hosts a NETWORK-granted plugin may reach (bare hostname or IP literal). EMPTY /
// absent = allow-all-public (today's behavior, so a granted plugin with no list does NOT regress); a
// non-empty list flips that plugin to default-DENY at the egress-guard (only listed hosts + subdomains).
// Manifest-independent, admin-set, stored SERVER-SIDE in the `plugin_egress_hosts` option.
const egressHosts = new Map<string, string[]>();

// A valid egress-host entry: a bare hostname (optionally a leading '*.'/'.'), or an IP literal. NEVER a
// scheme, path, port, query, or whitespace — those are rejected so a poisoned option can't smuggle a URL.
const VALID_EGRESS_HOST = /^(?:\*\.)?(?:[a-z0-9_-]+\.)*[a-z0-9_-]+$/i;
function isValidEgressHost(h: string): boolean {
    if (!h || h.length > 253) return false;
    if (require('net').isIP(h)) return true;
    return VALID_EGRESS_HOST.test(h);
}

/** The literal token used for the network grant (no access level). */
const NETWORK_TOKEN = 'network';

// A grant token is either the literal 'network' or a "<scope>:<access>" pair. Validating the SHAPE at
// load time is defense-in-depth: even if the plugin_grants option is ever poisoned by some path other
// than the admin setGrants API (which sanitizes), a blob can't smuggle in a structurally-bogus token
// (SQL, path, whitespace, object). We match the general scope:access shape rather than a hardcoded list
// of access verbs — the real verbs vary by scope (read/write/admin/provider/send/register_route/register,
// per KNOWN_PERMISSIONS) and a narrow list silently DROPS legitimate grants (e.g. notifications:send) on
// reload. The write is already blocked at the options bridge; this only rejects malformed entries.
const VALID_GRANT_TOKEN = /^[a-z][a-z0-9_.-]*:[a-z][a-z0-9_-]*$/;
function isValidGrantToken(t: string): boolean {
    return t === NETWORK_TOKEN || VALID_GRANT_TOKEN.test(t);
}

/** Load the persisted grants into memory. Call once at boot, after the DB is up. */
async function loadGrants(): Promise<void> {
    try {
        const { getOption } = require('./options');
        const stored = await getOption('plugin_grants', {});
        grants.clear();
        if (stored && typeof stored === 'object') {
            for (const [slug, list] of Object.entries(stored)) {
                if (!Array.isArray(list)) continue;
                const clean: string[] = [];
                for (const raw of list) {
                    const t = String(raw).toLowerCase().trim();
                    if (isValidGrantToken(t)) clean.push(t);
                    else console.warn(`[PluginPermissions] Dropping malformed grant token '${raw}' for plugin '${slug}' from plugin_grants.`);
                }
                grants.set(String(slug), new Set(clean));
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
    if (s.has(`${scope}:${access}`)) return true;
    // `admin` implies ONLY the ordinary read+write verbs — NOT the high-power special verbs (provider =
    // become the system mail sender; register / register_route = own host routes). Those confer far more
    // than admin-on-this-scope and MUST be granted explicitly (audit HIGH: email:admin silently subsumed
    // email:provider, letting a send-mail plugin hijack ALL outbound mail).
    return (access === 'read' || access === 'write') && s.has(`${scope}:admin`);
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
    // NO plugin/theme may grant permissions: setGrants IS the permission store, so an in-process theme
    // calling require('core/plugin-permissions').setGrants('confederate', ['*']) would self-escalate past
    // the admin-approval default-deny model (#9). Only host/admin code (no plugin context) may call it —
    // grant-on-activate and boot backfill both run in host context (getEffectivePlugin() === null).
    if (require('./plugin-context').getEffectivePlugin()) {
        throw new Error('🛡️ setGrants is not permitted from plugin/theme context.');
    }
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
    egressHosts.delete(slug);
    const { getOption, updateOption } = require('./options');
    const stored = (await getOption('plugin_grants', {})) || {};
    if (Object.prototype.hasOwnProperty.call(stored, slug)) {
        delete stored[slug];
        await updateOption('plugin_grants', stored);
    }
    // Also clear the egress allowlist so re-uploading the same slug can't silently inherit an old policy.
    const eStored = (await getOption('plugin_egress_hosts', {})) || {};
    if (Object.prototype.hasOwnProperty.call(eStored, slug)) {
        delete eStored[slug];
        await updateOption('plugin_egress_hosts', eStored);
    }
}

/** Load the persisted per-plugin egress allowlists into memory. Call once at boot, after the DB is up. */
async function loadEgressHosts(): Promise<void> {
    try {
        const { getOption } = require('./options');
        const stored = await getOption('plugin_egress_hosts', {});
        egressHosts.clear();
        if (stored && typeof stored === 'object') {
            for (const [slug, list] of Object.entries(stored)) {
                if (!Array.isArray(list)) continue;
                const clean: string[] = [];
                for (const raw of list) {
                    const h = String(raw).toLowerCase().trim();
                    if (isValidEgressHost(h)) clean.push(h);
                    else console.warn(`[PluginPermissions] Dropping malformed egress host '${raw}' for plugin '${slug}' from plugin_egress_hosts.`);
                }
                egressHosts.set(String(slug), clean);
            }
        }
    } catch (e: any) {
        console.warn('[PluginPermissions] Failed to load plugin_egress_hosts option:', e && e.message);
    }
}

/** The egress allowlist for a plugin (for the admin API and the spawn-time childCfg). Empty = allow-all. */
function getEgressAllowlist(slug: string): string[] {
    return Array.from(egressHosts.get(slug) || []);
}

/**
 * Replace a plugin's egress allowlist (admin action). Persists to `plugin_egress_hosts` + mirrors in
 * memory. Same no-self-grant guard as setGrants: a plugin/theme context may NEVER widen its own egress.
 */
async function setEgressAllowlist(slug: string, hosts: string[]): Promise<void> {
    if (require('./plugin-context').getEffectivePlugin()) {
        throw new Error('🛡️ setEgressAllowlist is not permitted from plugin/theme context.');
    }
    const clean = Array.from(new Set((hosts || []).map(h => String(h).toLowerCase().trim()).filter(isValidEgressHost)));
    egressHosts.set(slug, clean);
    const { getOption, updateOption } = require('./options');
    const stored = (await getOption('plugin_egress_hosts', {})) || {};
    stored[slug] = clean;
    await updateOption('plugin_egress_hosts', stored);
}

// Test-only: set a plugin's grants in memory WITHOUT persisting, so unit tests can grant the
// permissions a default-deny bridge now requires, with no DB dependency.
function _setGrantsInMemory(slug: string, tokens: string[]): void {
    // Same escalation vector as setGrants: ungated in-memory grant. Never callable from plugin/theme
    // context (test/host only) — an in-process theme could otherwise silently grant itself any cap (#9).
    if (require('./plugin-context').getEffectivePlugin()) {
        throw new Error('🛡️ _setGrantsInMemory is not permitted from plugin/theme context.');
    }
    grants.set(slug, new Set((tokens || []).map(t => String(t).toLowerCase().trim()).filter(Boolean)));
}

module.exports = { loadGrants, isGranted, isNetworkGranted, getGrants, setGrants, removeGrants, backfillActive, NETWORK_TOKEN, _setGrantsInMemory, loadEgressHosts, getEgressAllowlist, setEgressAllowlist };
