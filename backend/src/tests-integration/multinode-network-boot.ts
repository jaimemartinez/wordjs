/**
 * Boot ONE node of a multisite network over Postgres + Redis, for the multi-node network test
 * (multinode-network.integration.ts is node A; multinode-network-peer.ts, forked, is node B). Not a test
 * file. Each node gets its own install directory (its own uploads, its own process memory), and the SAME
 * wordjs-config.json content — same database, same Redis, same signing secret — which is what makes the
 * two processes nodes of one network. Must be called before any other application module loads.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

export const NET_DB = 'wordjs_msnodes';
export const MAIN_URL = 'http://main.example.com';
export const PASSWORD = 'Correct-Horse-9!';

export function pgSettings() {
    return {
        host: process.env.PGHOST || '127.0.0.1',
        port: Number(process.env.PGPORT) || 5432,
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD ?? 'password',
    };
}

/** Configure this process as a node of the test network and load the app. Returns the modules it needs. */
export async function bootNode(name: string, jwtSecret: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-msnode-${name}-${process.pid}-`));
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'wordjs-config.json'), JSON.stringify({
        installedAt: '2026-01-01T00:00:00.000Z',
        dbDriver: 'postgres',
        siteUrl: MAIN_URL,
        hostPolicy: { ipLiterals: 'any' },
        multisite: { enabled: true },
        jwtSecret,
    }, null, 2));
    process.chdir(dir);
    for (const key of ['WORDJS_ALLOWED_HOSTS', 'WORDJS_IP_HOSTS', 'WORDJS_DEV_ORIGINS', 'WORDJS_TRUST_PROXY']) delete process.env[key];
    process.env.REDIS_ENABLED = 'true';
    const config = require('../config/app');
    config.dbDriver = 'postgres';
    config.db = { ...config.db, ...pgSettings(), name: NET_DB };
    config.dbPath = path.join(dir, 'data', 'wordjs-native.db');
    config.siteUrl = MAIN_URL;
    config.site.url = MAIN_URL;
    config.frontendUrl = MAIN_URL;
    config.uploads.dir = path.join(dir, 'uploads');
    config.uploads.privateDir = path.join(dir, 'data', 'private-uploads');
    config.nodeEnv = 'production';
    config.multisite = { enabled: true };
    config.redis.enabled = true;
    if (config.jwt) config.jwt.secret = jwtSecret;
    // The app builds its Redis-backed rate limiters when it loads, and they need a connected client (as at
    // a real boot, where the cache connects long before the first request): wait for it, briefly.
    const cache = require('../core/cache');
    for (let i = 0; i < 50; i++) {
        const c = cache.getClient();
        if (c && c.status === 'ready') break;
        await new Promise((r) => setTimeout(r, 100));
    }
    const app = require('../index');
    return {
        dir,
        config,
        app,
        database: require('../config/database'),
        siteContext: require('../core/site-context'),
        network: require('../core/network'),
        cache: require('../core/cache'),
    };
}

/** What every node does at boot (index.ts initialize, the parts a network needs). */
export async function startNode(m: any): Promise<void> {
    await m.siteContext.runWithSite(1, async () => {
        await m.database.init({ driver: 'postgres' });
        await m.database.initializeDatabase();
        await require('../core/options').initDefaultOptions(m.config);
        await require('../core/roles').loadRoles();
        await require('../core/post-types').initPostTypes();
        await require('../core/post-types').initTaxonomies();
        require('../core/adminMenu').initCoreMenus();
        await m.network.ready({ watch: true });
        require('../core/network-sites').followRegistryChanges();
        require('../core/coherence').initCoherence();
        require('../core/collab-rooms').initClusterBus();
    });
    require('../core/plugins-ready').markPluginsReady();
}

/** Listen on a loopback port, outside any site (each request enters its own). */
export function listen(m: any): Promise<{ server: any; port: number }> {
    const http = require('http');
    const server = http.createServer(m.app);
    return new Promise((resolve) => m.siteContext.runWithSite(null, () => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))));
}

module.exports = { NET_DB, MAIN_URL, PASSWORD, pgSettings, bootNode, startNode, listen };
