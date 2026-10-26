/**
 * LONG-LIVED RESPONSES AND PUBLIC PROBES — what a caller can hold open or make the server repeat, on the
 * REAL app over a real socket.
 *
 *  · GraphQL subscription streams: the per-caller cap holds when many streams open at once (the slot is
 *    taken before subscribe() is awaited); a caller who hangs up while the stream is being set up does not
 *    keep its slot; an anonymous caller is its address, whatever cookie it sends.
 *  · Opening a stream is charged to the API limiter for the reads it makes (the entries named in `ids:`,
 *    the events replayed), not for the live events after; an anonymous resume replays a bounded number.
 *  · The hook inspector stream is an administrator's interactive session only, capped per user.
 *  · /health answers from a cached probe with a deadline: its database check runs once per TTL, whatever
 *    the request rate, and a database that never answers is reported, not waited on.
 *
 * MUTATION PROOF: with the stream counter taken after `await subscribe` the concurrent burst passes the
 * cap and the hung-up stream leaks its slot; keyed by the raw cookie, rotating junk cookies passes it; with
 * no open-phase charge the `ids:` reads leave the limiter untouched; without sessionOnly the API token
 * opens the inspector; with the uncached /health handler every request runs the check.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-stream-exh-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
config.api.rateLimit.max = 100_000;
// The /health and /readyz database deadline, read when index.ts builds the probes.
process.env.WORDJS_READINESS_TIMEOUT_MS = '300';

const request = require('supertest');
const database = require('../config/database');
const app = require('../index');

const configManager = require('../core/configManager');
const realIsInstalled = configManager.isInstalled;
const realGetConfig = configManager.getConfig;
configManager.isInstalled = () => true;
configManager.getConfig = () => ({ installedAt: '2020-01-01T00:00:00.000Z', dbDriver: config.dbDriver });

const { generateToken } = require('../middleware/auth');
const User = require('../models/User');
const ApiToken = require('../models/ApiToken');
const subscriptions = require('../core/graphql/subscriptions');
const graphqlRoute = require('../routes/graphql');
const hooksRoute = require('../routes/hooks');
const { registerLimiterCharge } = require('../core/limiter-charge');

const API = config.api.prefix;
const U: Record<string, any> = {};
const P: number[] = [];
let server: any;
let port = 0;
let origin = '';
let db: any;

const bearer = (who: string) => ({ Authorization: `Bearer ${generateToken(U[who])}` });
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
let outboxSeq = 0;
/** A committed post.updated row, as a write would leave it in the outbox the feed polls. */
const outbox = (postId: number) => db.run("INSERT INTO content_outbox (event_id, event_type, aggregate_id, payload) VALUES (?, 'post.updated', ?, '{}')", [`stream-exh-${process.pid}-${++outboxSeq}`, postId]);

interface Stream { status: number; body: () => string; close: () => void; ended: Promise<void> }

/** Open an SSE response at `p` and resolve once its status line arrived. */
function open(p: string, headers: Record<string, string> = {}): Promise<Stream> {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: p, headers: { Accept: 'text/event-stream', ...headers } }, (res: any) => {
            let body = '';
            let endResolve: () => void;
            const ended = new Promise<void>((r) => { endResolve = r; });
            res.setEncoding('utf8');
            res.on('data', (c: string) => { body += c; });
            res.on('end', () => endResolve());
            res.on('close', () => endResolve());
            resolve({ status: res.statusCode, body: () => body, close: () => req.destroy(), ended });
        });
        req.on('error', reject);
    });
}

const streamPath = (query: string, variables?: any) =>
    `${API}/graphql/stream?${new URLSearchParams({ query, ...(variables ? { variables: JSON.stringify(variables) } : {}) })}`;
const CONTENT = 'subscription($ids: [Int!]) { contentChanged(ids: $ids) { kind id } }';

/**
 * Run fn with every API-limiter charge taking a real macrotask. SQLite answers the reads a subscription makes
 * synchronously, so without this subscribe() never yields and two opens never overlap; on Postgres or MySQL
 * every read is a round trip and they do.
 */
async function withSlowReads<T>(fn: () => Promise<T>): Promise<T> {
    const previous = registerLimiterCharge('api', async () => { await settle(15); return true; });
    try { return await fn(); } finally { registerLimiterCharge('api', previous); }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('condition not met in time');
        await settle(20);
    }
}

before(async () => {
    config.nodeEnv = 'test';
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    db = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await require('../core/roles').loadRoles();
    for (const [login, role] of [['admin', 'administrator'], ['alice', 'author'], ['bob', 'author']]) {
        U[login] = await User.create({ username: login, email: `${login}@example.com`, password: 'Correct-Horse-9-Battery', role });
    }
    for (let i = 0; i < 100; i++) {
        const r = await db.run(
            `INSERT INTO posts (author_id, post_title, post_content, post_status, post_type, post_name, comment_status, post_date, post_date_gmt)
             VALUES (?, ?, 'body', 'publish', 'post', ?, 'open', '2026-01-10 10:00:00', '2026-01-10 10:00:00')`,
            [U.alice.id, `Stream post ${i}`, `stream-${i}`]);
        P.push(r.lastID);
    }
    subscriptions.setFeedTuning({ pollMs: 50, recheckMs: 60_000 });
    const { notFound, errorHandler } = require('../middleware/errorHandler');
    app.use(notFound);
    app.use(errorHandler);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    port = server.address().port;
    origin = `http://127.0.0.1:${port}`;
});

after(async () => {
    configManager.isInstalled = realIsInstalled;
    configManager.getConfig = realGetConfig;
    try { if (server.closeAllConnections) server.closeAllConnections(); } catch { /* */ }
    try { await new Promise((r) => server.close(r)); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

describe('GraphQL subscription streams', () => {
    test('streams opened all at once cannot pass the per-caller cap together', async () => {
        const max = config.api.graphql.maxStreamsPerClient;
        // Each one reads 30 named entries while it subscribes: a wide window for the opens to overlap.
        const burst = await withSlowReads(() => Promise.all(Array.from({ length: max + 4 }, () => open(streamPath(CONTENT, { ids: P.slice(0, 30) }), bearer('bob')))));
        const accepted = burst.filter((s) => s.status === 200);
        assert.strictEqual(accepted.length, max, `statuses: ${burst.map((s) => s.status).join(',')}`);
        assert.ok(burst.filter((s) => s.status !== 200).every((s) => s.status === 429));
        for (const s of burst) s.close();
        await waitFor(() => graphqlRoute.openStreamCount() === 0);
    });

    test('a caller who hangs up while the stream is being set up does not keep its slot', async () => {
        const max = config.api.graphql.maxStreamsPerClient;
        await withSlowReads(async () => {
            for (let i = 0; i < max + 2; i++) {
                const req = http.get({ host: '127.0.0.1', port, path: streamPath(CONTENT, { ids: P.slice(0, 30) }), headers: { ...bearer('bob'), Accept: 'text/event-stream' } });
                req.on('error', () => { /* destroyed on purpose */ });
                setTimeout(() => req.destroy(), 60);
            }
            await settle(800);
        });
        await waitFor(() => graphqlRoute.openStreamCount() === 0);
        const after = await Promise.all(Array.from({ length: max }, () => open(streamPath(CONTENT), bearer('bob'))));
        assert.deepStrictEqual(after.map((s) => s.status), Array(max).fill(200), 'every slot came back');
        for (const s of after) s.close();
        await waitFor(() => graphqlRoute.openStreamCount() === 0);
    });

    test('a stream opened by POST (its JSON body already read) stays open and delivers', async () => {
        const body = JSON.stringify({ query: CONTENT, variables: { ids: P.slice(0, 3) } });
        const s = await new Promise<Stream>((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, method: 'POST', path: `${API}/graphql/stream`,
                headers: { ...bearer('alice'), Origin: origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Accept: 'text/event-stream' },
            }, (res: any) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (c: string) => { text += c; });
                resolve({ status: res.statusCode, body: () => text, close: () => req.destroy(), ended: new Promise<void>((r) => res.on('close', () => r())) });
            });
            req.on('error', reject);
            req.end(body);
        });
        assert.strictEqual(s.status, 200);
        await settle();
        assert.strictEqual(graphqlRoute.openStreamCount(), 1, 'the slot is held while the stream is open');
        await outbox(P[1]);
        await waitFor(() => s.body().includes(`"id":${P[1]}`));
        s.close();
        await waitFor(() => graphqlRoute.openStreamCount() === 0);
    });

    test('an anonymous caller is its address, whatever cookie it sends', async () => {
        const max = config.api.graphql.maxStreamsPerClient;
        const opened: Stream[] = [];
        for (let i = 0; i < max; i++) opened.push(await open(streamPath(CONTENT), { Cookie: `wordjs_token=junk-${i}`, Origin: origin }));
        assert.deepStrictEqual(opened.map((s) => s.status), Array(max).fill(200));
        const over = await open(streamPath(CONTENT), { Cookie: 'wordjs_token=junk-other', Origin: origin });
        assert.strictEqual(over.status, 429);
        over.close();
        for (const s of opened) s.close();
        await waitFor(() => graphqlRoute.openStreamCount() === 0);
    });

    test('opening a stream is charged for the entries it names; live events are not', async () => {
        const hits: number[] = [];
        const previous = registerLimiterCharge('api', async (_req: any, n: number) => { hits.push(n); return true; });
        try {
            const s = await open(streamPath(CONTENT, { ids: P.slice(0, 3) }));
            assert.strictEqual(s.status, 200);
            await settle();
            assert.strictEqual(hits.length, 2, 'three reads, the first rides on the request the limiter counted');
            await db.run("UPDATE posts SET post_title = 'retitled' WHERE id = ?", [P[0]]);
            await outbox(P[0]);
            await waitFor(() => s.body().includes(`"id":${P[0]}`));
            assert.strictEqual(hits.length, 2, 'a live event is not charged');
            s.close();
        } finally {
            registerLimiterCharge('api', previous);
        }
        await waitFor(() => graphqlRoute.openStreamCount() === 0);
    });

    test('an anonymous resume replays a bounded number of events; a signed-in one more', async () => {
        const watcher = await open(streamPath(CONTENT));
        await settle();
        await outbox(P[0]);
        await waitFor(() => /id: \d+\.\d+/.test(watcher.body()));
        const cursor = /id: (\d+\.\d+)/.exec(watcher.body())![1];
        for (let i = 1; i <= 6; i++) {
            await outbox(P[i]);
        }
        await waitFor(() => (watcher.body().match(/event: next/g) || []).length >= 7);
        watcher.close();
        subscriptions.setFeedTuning({ maxAnonymousReplay: 2 });
        const keepFeed = await open(streamPath(CONTENT), bearer('admin'));
        try {
            const anon = await open(streamPath(CONTENT), { 'Last-Event-ID': cursor });
            const signedIn = await open(streamPath(CONTENT), { ...bearer('alice'), 'Last-Event-ID': cursor });
            await settle(600);
            assert.strictEqual((anon.body().match(/event: next/g) || []).length, 2);
            assert.strictEqual((signedIn.body().match(/event: next/g) || []).length, 6);
            anon.close();
            signedIn.close();
        } finally {
            subscriptions.setFeedTuning({ maxAnonymousReplay: 50 });
            keepFeed.close();
        }
        await waitFor(() => graphqlRoute.openStreamCount() === 0);
    });
});

describe('the hook inspector stream', () => {
    test('an administrator session may hold a few; an API token none', async () => {
        const first = await Promise.all([0, 1, 2].map(() => open(`${API}/hooks/stream`, bearer('admin'))));
        assert.deepStrictEqual(first.map((s) => s.status), [200, 200, 200]);
        const over = await open(`${API}/hooks/stream`, bearer('admin'));
        assert.strictEqual(over.status, 429);
        await over.ended;
        assert.match(over.body(), /rest_hook_stream_limit/);
        for (const s of first) s.close();
        await waitFor(() => hooksRoute.openHookStreamCount() === 0);
        const again = await open(`${API}/hooks/stream`, bearer('admin'));
        assert.strictEqual(again.status, 200, 'closed streams give their slot back');
        again.close();
        await waitFor(() => hooksRoute.openHookStreamCount() === 0);

        const minted = await ApiToken.generate({ userId: U.admin.id, name: 'inspector', scopes: ['read'] });
        const viaToken = await (request(server) as any).get(`${API}/hooks/stream`).set('Authorization', `Bearer ${minted.token}`);
        assert.strictEqual(viaToken.status, 403);
        assert.strictEqual(viaToken.body.code, 'rest_token_management_forbidden');
        assert.strictEqual(hooksRoute.openHookStreamCount(), 0);
    });
});

describe('/health', () => {
    test('the database check runs once per TTL whatever the request rate (root and API route), and a hung check is reported', async () => {
        const SystemHealth = require('../core/system-health');
        const real = SystemHealth.checkDatabase;
        let calls = 0;
        let hang = false;
        SystemHealth.checkDatabase = async () => { calls++; return hang ? new Promise(() => { /* never */ }) : { status: 'OK' }; };
        try {
            await settle(1100); // past any verdict cached before the spy
            // The root probe and its API twin answer from the same verdict.
            const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => (request(server) as any).get(i % 2 ? '/health' : `${API}/health`)));
            assert.ok(answers.every((r: any) => r.status === 200 && r.body.status === 'ok'), JSON.stringify(answers.map((r: any) => r.body)));
            assert.strictEqual(calls, 1);
            hang = true;
            await settle(1100);
            const t0 = Date.now();
            const stuck = await (request(server) as any).get('/health');
            assert.strictEqual(stuck.body.status, 'error');
            assert.ok(Date.now() - t0 < 2000, 'answered at the deadline, not when the database does');
        } finally {
            SystemHealth.checkDatabase = real;
        }
    });

    test('createHealthProbe shares one check per TTL and reports a timeout', async () => {
        const { createHealthProbe } = require('../core/readiness');
        let now = 0;
        let calls = 0;
        const probe = createHealthProbe({ checkDatabase: async () => { calls++; return { status: 'OK' }; }, now: () => now, ttlMs: 1000 });
        assert.deepStrictEqual(await Promise.all([probe(), probe(), probe()]), ['ok', 'ok', 'ok']);
        now = 500;
        assert.strictEqual(await probe(), 'ok');
        assert.strictEqual(calls, 1);
        now = 1500;
        await probe();
        assert.strictEqual(calls, 2);
        const stuck = createHealthProbe({ checkDatabase: () => new Promise(() => { /* never */ }), timeoutMs: 50 });
        assert.strictEqual(await stuck(), 'timeout');
        const failing = createHealthProbe({ checkDatabase: async () => ({ status: 'ERROR' }) });
        assert.strictEqual(await failing(), 'error');
    });
});
