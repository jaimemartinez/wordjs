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
 * NOTE: full plugin activate/deactivate propagation (worker (re)start, menu re-registration) is NOT
 * applied live across nodes — that requires a rolling restart. See documentation/multi-node.md.
 */

const cache = require('./cache');

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
}

module.exports = { initCoherence };
