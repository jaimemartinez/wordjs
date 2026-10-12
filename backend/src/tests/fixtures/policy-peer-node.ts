/**
 * "Node B" for plugin-policy-multinode.test.ts: a SECOND backend core in its own OS process, sharing only
 * the database file with the test process ("node A") — exactly what a second backend node shares with the
 * first, minus Redis. Node A's publishes reach this process over IPC instead of over Redis: the test
 * process forwards each one (or drops it, to model a lost broadcast), and this script hands it to the
 * handlers the REAL core/coherence.ts subscribed, in arrival order, the way ioredis's 'message' event does.
 *
 * At start it does what a booting node does for an already-active plugin: load the grant and egress
 * policy from the database, spawn the plugin's isolate, and join the bus (initCoherence). The plugin's
 * own child then answers a probe filter with what it can ACTUALLY do — whether it holds the network, and
 * which of two hosts its egress guard lets it resolve — plus its pid, so the test can see a respawn.
 *
 * Messages (parent → here): {type:'bus', channel, payload} · {type:'bus-ready'} (the bus reconnected) ·
 * {type:'probe', id, slug} · {type:'shutdown'}. Replies: {type:'ready'} · {type:'probe', id, result}.
 */

const config = require('../../config/app');
config.dbPath = process.env.WJS_PEER_DB;
config.dbDriver = 'sqlite-native';

const database = require('../../config/database');
const cache = require('../../core/cache');

// The bus, as this node's coherence code sees it. Everything it subscribes is captured here and fed by
// the parent; nothing this node publishes goes anywhere (node A does not need it for these tests).
const handlers = new Map<string, Array<(m: string) => unknown>>();
const busReady: Array<() => void> = [];
cache.subscribe = (channel: string, h: (m: string) => unknown) => {
    if (!handlers.has(channel)) handlers.set(channel, []);
    handlers.get(channel)!.push(h);
};
cache.onBusReady = (h: () => void) => { busReady.push(h); };
cache.publish = async () => true;

const send = (m: any) => { try { if (process.send) process.send(m); } catch { /* parent gone */ } };

async function main() {
    await database.init({ driver: 'sqlite-native' });
    require('../../core/appRegistry').setApp(require('express')());
    const perms = require('../../core/plugin-permissions');
    await perms.loadGrants();
    await perms.loadEgressHosts();
    const iso = require('../../core/plugin-isolate');
    for (const spec of String(process.env.WJS_PEER_PLUGINS || '').split(',').filter(Boolean)) {
        const [slug, entry] = spec.split('=');
        await iso.loadIsolatedPlugin(slug, entry);
    }
    require('../../core/coherence').initCoherence({ policyResyncMs: Number(process.env.WJS_PEER_RESYNC_MS) || undefined });
    send({ type: 'ready' });
}

process.on('message', async (m: any) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'bus') {
        // A peer's cache.del() broadcast: drop this node's L1 the way cache.ts's own subscriber does.
        if (m.channel === 'wordjs:cache-del') { cache._l1.clear(); return; }
        for (const h of handlers.get(m.channel) || []) {
            try { const r: any = h(m.payload); if (r && typeof r.catch === 'function') r.catch(() => { /* */ }); } catch { /* */ }
        }
    } else if (m.type === 'bus-ready') {
        for (const h of busReady) { try { h(); } catch { /* */ } }
    } else if (m.type === 'probe') {
        let result: any;
        try {
            const out = await require('../../core/hooks').applyFilters(`wjs_policy_probe_${String(m.slug).replace(/[^a-z0-9]/gi, '_')}`, '');
            result = out ? JSON.parse(out) : null;
        } catch (e: any) { result = { error: String(e && e.message) }; }
        send({ type: 'probe', id: m.id, result });
    } else if (m.type === 'shutdown') {
        try { require('../../core/coherence').stopCoherence(); } catch { /* */ }
        try {
            const iso = require('../../core/plugin-isolate');
            for (const slug of iso.listIsolates()) { try { iso.unloadIsolatedPlugin(slug); } catch { /* */ } }
        } catch { /* */ }
        setTimeout(() => process.exit(0), 200);
    }
});

main().catch((e: any) => { send({ type: 'fatal', error: String(e && e.stack || e) }); process.exit(1); });
