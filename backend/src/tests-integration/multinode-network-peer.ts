/**
 * Multi-node NETWORK peer — "node B". Forked as a separate OS process by
 * multinode-network.integration.ts (deliberately not named *.integration.ts, so no glob collects it).
 *
 * It boots the real app as a second node of the same multisite network: the same Postgres (every site's
 * schema and the network store), the same Redis bus, the same signing secret, and nothing else in common
 * with node A — its own memory, its own registry mirror, its own site databases opened on demand, its own
 * collaboration rooms. It listens on a loopback port and tells node A which; node A then drives both nodes
 * over HTTP. Whatever node B answers about a site node A created can only have reached it through the
 * shared store and the bus.
 */
const { bootNode, startNode, listen } = require('./multinode-network-boot');

function send(msg: any): void {
    if (typeof process.send === 'function') process.send(msg);
}

let node: any = null;
async function shutdown(): Promise<void> {
    try { if (node && node.server) node.server.close(); } catch { /* */ }
    try { require('../core/collab-rooms')._resetForTests(); } catch { /* */ }
    try { await require('../config/database').closeSiteDatabases(); } catch { /* */ }
    try { await require('../config/database').closeDatabase(); } catch { /* */ }
    try { require('../core/network').closeNetworkStore(); } catch { /* */ }
    try { await require('../core/cache').closeAll(); } catch { /* */ }
    process.exit(0);
}

async function main(): Promise<void> {
    const m = await bootNode('b', String(process.env.WJ_MN_SECRET || ''));
    await startNode(m);
    for (let i = 0; i < 50 && !m.cache.pubsubAvailable(); i++) await new Promise((r) => setTimeout(r, 100));
    if (!m.cache.pubsubAvailable()) { send({ type: 'error', error: 'peer: no reachable Redis' }); return shutdown(); }
    node = await listen(m);
    await new Promise((r) => setTimeout(r, 600)); // the bus SUBSCRIBEs are acknowledged
    send({ type: 'ready', port: node.port, pid: process.pid });
}

process.on('message', (msg: any) => { if (msg === 'shutdown') void shutdown(); });
process.on('SIGTERM', () => void shutdown());
main().catch((e: any) => { send({ type: 'error', error: String((e && e.stack) || e) }); void shutdown(); });
