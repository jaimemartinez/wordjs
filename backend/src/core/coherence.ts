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
 */

const cache = require('./cache');

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
        }
    } catch (e: any) {
        console.warn('[coherence] plugin-changed handler error:', e && e.message);
    }
}

function initCoherence(): void {
    cache.subscribe('wordjs:option-changed', async (name: string) => {
        try {
            if (name === 'wordjs_user_roles') {
                await require('./roles').loadRoles();
                console.log('[coherence] roles cache reloaded (cross-node update)');
            } else if (name === 'redis_cache_enabled') {
                const { getOption } = require('./options');
                cache.setEnabled(await getOption('redis_cache_enabled', 0));
            }
        } catch (e: any) {
            console.warn('[coherence] handler error:', e && e.message);
        }
    });
    cache.subscribe('wordjs:plugin-changed', handlePluginChange);
}

module.exports = { initCoherence, handlePluginChange };
