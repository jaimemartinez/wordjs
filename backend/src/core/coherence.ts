/**
 * WordJS — Cross-node cache coherence (multi-node).
 *
 * When an option changes on one node, options.updateOption() publishes 'wordjs:option-changed' over
 * Redis. Each node subscribes here and refreshes the IN-PROCESS state that is NOT read through the
 * (shared, already-invalidated) option cache — most importantly the roles cache, which authorization
 * decisions depend on. Without this, a role/capability edit on node A leaves node B serving stale
 * (e.g. not-yet-revoked) capabilities until it restarts.
 *
 * No-op when Redis isn't configured: cache.subscribe() does nothing, so single-node behavior is
 * unchanged.
 *
 * Plugin activate/deactivate is ALSO propagated live across nodes: activatePlugin/deactivatePlugin
 * publish 'wordjs:plugin-changed', and each node loads/unloads that one plugin locally (worker start/
 * stop + route/hook/menu (de)registration) — no rolling restart needed. The shared `active_plugins`
 * option is written once by the originating node (under the dist-lock); other nodes only sync their
 * in-process load state. See documentation/multi-node.md.
 *
 * PLUGIN GRANT / EGRESS-ALLOWLIST edits. setGrants()/setEgressAllowlist() write the `plugin_grants` /
 * `plugin_egress_hosts` options, so updateOption() publishes 'wordjs:option-changed' for both, and the
 * permission/egress routes also publish 'wordjs:plugin-changed' {action:'reload'}. Either message makes a
 * node re-read both policies from the database (into the maps the host gates read synchronously:
 * isGranted / isNetworkGranted, the wordjs.dns name check via getEgressAllowlist) and then RECONCILE its
 * running isolates: a child whose spawn-time policy (plugin-isolate's spawnPolicyFingerprint — grants,
 * allowlist, deny-all) differs from the current one is respawned, since its network/allowlist cfg is
 * baked in at spawn. Without this a revoke on node A left every OTHER node running the plugin with the
 * OLD grants and the OLD allowlist — including the dns bridge, the exfiltration path the allowlist
 * exists to stop — until it restarted.
 *
 * Pub/sub delivery is NOT guaranteed (a Redis blip, a subscriber reconnect, the boot window before this
 * node subscribes all drop messages silently), so the bus is only the fast path. The bound is a periodic
 * re-sync — the same read + reconcile every POLICY_RESYNC_MS (10 s, the roles cache's TTL) — plus one on
 * every bus (re)connect and one as soon as this node has subscribed. A tick only DETECTS and starts the
 * respawns of stale children (side by side, at most MAX_CONCURRENT_RESPAWNS at a time); it does not wait
 * for them, so a child slow to come back delays its own respawn, not the next tick or any other child's.
 * The same tick stops a plugin this node still runs although the shared active set no longer lists it (a
 * lost 'deactivate'; second consecutive observation). It runs whether or not Redis is configured: three
 * reads per tick, and on a single node it is also what lifts the boot-time deny-all (F-06) once the egress
 * policy can be read. A lost 'activate' is NOT replayed by a timer (see plugins.reconcileDeactivatedPlugins).
 */

const cache = require('./cache');

/** How stale a node's plugin grant/egress policy may get when a broadcast is lost (= ROLES_CACHE_TTL_MS). */
const POLICY_RESYNC_MS = 10_000;

/**
 * How many stale children this node respawns AT ONCE. Each respawn forks a process and waits for it to
 * report ready (up to plugin-isolate's READY_TIMEOUT_MS, 60 s by default), so they run side by side — one
 * slow child must not hold back every other child's revoke — but not unbounded: a policy change that
 * touches every plugin should not fork all of them in the same instant.
 */
const MAX_CONCURRENT_RESPAWNS = 4;

let respawnsRunning = 0;
const respawnWaiters: Array<() => void> = [];
async function withRespawnSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (respawnsRunning < MAX_CONCURRENT_RESPAWNS) respawnsRunning += 1;
    else await new Promise<void>((resolve) => respawnWaiters.push(resolve)); // a finishing respawn hands over its slot
    try {
        return await fn();
    } finally {
        const next = respawnWaiters.shift();
        if (next) next(); else respawnsRunning -= 1;
    }
}

/** Is `slug`'s running child spawned with a policy that is no longer the current one? */
function isolateIsStale(slug: string): boolean {
    const iso = require('./plugin-isolate');
    if (!iso.isIsolated(slug)) return false;
    const spawned = iso.spawnPolicyFingerprint(slug);
    return spawned !== undefined && spawned !== require('./plugin-permissions').policyFingerprint(slug);
}

// Per-slug chain, so a periodic tick and a message-driven reconcile never respawn the same child twice
// concurrently, and a reconcile requested while one is running still runs (after it) against the newer
// state. At most ONE reconcile per slug waits behind the running one: a request made while one is already
// queued joins it — it has not started, so it will read the newest state anyway. Without that, a child
// slow to respawn gained one queued reconcile per 10 s tick for as long as it took.
const reconcileTail = new Map<string, Promise<boolean>>();
const reconcileQueued = new Map<string, Promise<boolean>>();

/** Respawn `slug`'s running child if the policy it was spawned with is no longer the current one. */
function reconcileIsolate(slug: string): Promise<boolean> {
    const queued = reconcileQueued.get(slug);
    if (queued) return queued;
    const prev = reconcileTail.get(slug) || Promise.resolve(false);
    const run: Promise<boolean> = prev.catch(() => false).then(async () => {
        if (reconcileQueued.get(slug) === run) reconcileQueued.delete(slug);
        const iso = require('./plugin-isolate');
        await iso.awaitIsolateSettled(slug);
        if (!isolateIsStale(slug)) return false;
        return withRespawnSlot(async () => {
            // Waiting for a slot can take a while: another path (the permission route's own reload, a
            // newer re-read) may have brought the child up to date meanwhile.
            await iso.awaitIsolateSettled(slug);
            if (!isolateIsStale(slug)) return false;
            await iso.reloadIsolatedPlugin(slug);
            console.log(`[coherence] '${String(slug).replace(/[\r\n]/g, '')}' respawned: its grant/egress policy changed`);
            return true;
        });
    });
    reconcileQueued.set(slug, run);
    reconcileTail.set(slug, run);
    run.finally(() => { if (reconcileTail.get(slug) === run) reconcileTail.delete(slug); }).catch(() => { /* */ });
    return run;
}

/**
 * Re-read both policies, then START a reconcile of every target child (all running isolates, or only
 * `slugs`) — all of them at once, each on its own (MAX_CONCURRENT_RESPAWNS bounds the forks). Returns
 * the reconciles without waiting for them.
 */
async function refreshPolicyAndReconcile(slugs?: string[]): Promise<Array<{ slug: string; done: Promise<boolean> }>> {
    const perms = require('./plugin-permissions');
    await perms.loadGrants();
    await perms.loadEgressHosts();
    const iso = require('./plugin-isolate');
    const targets: string[] = Array.isArray(slugs) ? slugs : iso.listIsolates();
    return targets.map((slug) => ({ slug, done: reconcileIsolate(slug) }));
}

function respawnFailed(e: any): void {
    console.warn('[coherence] plugin respawn after a policy change failed:', e && e.message);
}

/**
 * Re-read plugin_grants + plugin_egress_hosts from the database and reconcile running isolates (all of
 * them, or only `slugs`); resolves with the slugs respawned once every reconcile has finished. A failed
 * read leaves the last-known-good maps in place, so nothing is respawned on a database error. Exported
 * for the cross-node tests.
 */
async function resyncPluginPolicy(slugs?: string[]): Promise<string[]> {
    const started = await refreshPolicyAndReconcile(slugs);
    const results = await Promise.all(started.map(({ slug, done }) => done.then(
        (respawned) => (respawned ? slug : null),
        (e: any) => { respawnFailed(e); return null; })));
    return results.filter((s): s is string => s !== null);
}

// Single-flight for the periodic / on-reconnect re-sync: a slow tick is not stacked behind another.
// Besides the grant/egress policy it stops plugins this node still runs although the shared active set
// no longer lists them — a lost 'deactivate' (plugins.reconcileDeactivatedPlugins, two observations).
// The single flight covers the READS and the detection only, never the respawns it starts: a child that
// takes its full ready timeout to come back must not keep the next ticks from noticing that some OTHER
// child's policy changed meanwhile — the bound a lost broadcast relies on.
let resyncInFlight: Promise<unknown> | null = null;
function scheduledResync(): Promise<unknown> {
    if (resyncInFlight) return resyncInFlight;
    resyncInFlight = Promise.resolve()
        .then(() => require('./plugins').reconcileDeactivatedPlugins())
        .catch((e: any) => console.warn('[coherence] active-set re-sync failed:', e && e.message))
        .then(() => refreshPolicyAndReconcile())
        .then((started) => { for (const { done } of started) done.catch(respawnFailed); })
        .catch((e: any) => console.warn('[coherence] plugin policy re-sync failed:', e && e.message))
        .finally(() => { resyncInFlight = null; });
    return resyncInFlight;
}

// Handle a 'wordjs:plugin-changed' message. Exported for unit testing. Skips the message this node
// published itself (origin === our dist-lock HOLDER): the originating node already applied the change.
function handlePluginChange(msg: string): void {
    let data: any;
    try { data = JSON.parse(msg); } catch { return; }
    if (!data || !data.slug || !data.action) return;
    try { if (data.origin && data.origin === require('./dist-lock').HOLDER) return; } catch { /* */ }
    const plugins = require('./plugins');
    try {
        if (data.action === 'activate') {
            Promise.resolve(plugins.loadOnePlugin(data.slug)).catch((e: any) => console.warn('[coherence] cross-node activate failed:', e && e.message));
        } else if (data.action === 'deactivate') {
            plugins.unloadOnePlugin(data.slug);
        } else if (data.action === 'reload') {
            // A grant / egress-allowlist change on another node: re-read both policies, then respawn this
            // slug's child if what it was spawned with is no longer current. (A revoke that CONDEMNS the
            // plugin propagates via 'deactivate' instead.)
            resyncPluginPolicy([String(data.slug)])
                .catch((e: any) => console.warn('[coherence] cross-node plugin reload failed:', e && e.message));
        }
    } catch (e: any) {
        console.warn('[coherence] plugin-changed handler error:', e && e.message);
    }
}

// Handle a 'wordjs:option-changed' message. Exported for unit testing. Refreshes the in-process state a
// node keeps OUTSIDE the (already-invalidated) option cache: the roles cache, the Redis master switch,
// and the plugin grant / egress-allowlist maps the host security gates read synchronously — and, for
// the latter, respawns any running isolate whose spawn-time policy is no longer current.
async function handleOptionChange(name: string): Promise<void> {
    try {
        if (name === 'wordjs_user_roles') {
            await require('./roles').loadRoles();
            console.log('[coherence] roles cache reloaded (cross-node update)');
        } else if (name === 'redis_cache_enabled') {
            const { getOption } = require('./options');
            cache.setEnabled(await getOption('redis_cache_enabled', 0));
        } else if (name === 'plugin_grants' || name === 'plugin_egress_hosts') {
            await resyncPluginPolicy();
            console.log(`[coherence] plugin ${name === 'plugin_grants' ? 'grants' : 'egress allowlist'} reloaded (cross-node update)`);
        }
    } catch (e: any) {
        console.warn('[coherence] handler error:', e && e.message);
    }
}

let resyncTimer: NodeJS.Timeout | null = null;
const resyncOnBusReady = (): void => { void scheduledResync(); };

/**
 * Subscribe this node to the coherence channels and start the plugin-policy re-sync. `policyResyncMs`
 * exists for the tests; production uses POLICY_RESYNC_MS.
 */
function initCoherence(opts: { policyResyncMs?: number } = {}): void {
    cache.subscribe('wordjs:option-changed', handleOptionChange);
    cache.subscribe('wordjs:plugin-changed', handlePluginChange);
    // Catch up on whatever was published while this node was not listening: on every (re)connect of the
    // bus, and once now if it is already up (cache.onBusReady runs a late registration right away, once
    // the two SUBSCRIBEs above are acknowledged). That second case is the BOOT WINDOW — this node read the
    // policy at boot well before it subscribed here, and the bus's first 'ready' has long fired.
    cache.onBusReady(resyncOnBusReady);
    if (resyncTimer) clearInterval(resyncTimer);
    const every = Number(opts.policyResyncMs) > 0 ? Number(opts.policyResyncMs) : POLICY_RESYNC_MS;
    resyncTimer = setInterval(() => { void scheduledResync(); }, every);
    if (typeof resyncTimer.unref === 'function') resyncTimer.unref();
}

/** Stop the periodic re-sync (graceful shutdown / tests). */
function stopCoherence(): void {
    if (resyncTimer) { clearInterval(resyncTimer); resyncTimer = null; }
}

module.exports = { initCoherence, stopCoherence, handlePluginChange, handleOptionChange, resyncPluginPolicy, POLICY_RESYNC_MS, MAX_CONCURRENT_RESPAWNS };
