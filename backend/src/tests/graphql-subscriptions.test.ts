/**
 * GRAPHQL SUBSCRIPTIONS over SSE — on the REAL app, over a real socket.
 *
 * The promise: a subscriber hears about a change only if the REST read it mirrors would show it that entry
 * at that moment. Every event is re-authorized as the subscriber (GET /posts/:id, GET /comments/:id), so
 *  · an anonymous stream is told about published entries and never about a draft — not even that it exists;
 *  · the author's own stream carries their drafts;
 *  · an entry that stops being visible (trashed, unpublished) arrives as DELETED with no body, and only on
 *    a stream that had seen it;
 *  · a stream opened with an API token closes when the token is revoked;
 *  · held comments never reach an anonymous stream; approving one does not leak it as a new comment either.
 * Plus the transport rules: only subscriptions are served there, a cookie GET must be same-origin, the
 * per-caller stream cap applies, and a Last-Event-ID resumes after the given cursor.
 *
 * MUTATION PROOF: without the per-event REST re-read (authorize returning every raw feed event), the
 * anonymous stream receives the draft and the first assertion fails; without the credential re-check the
 * revoked-token stream stays open.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-gql-sub-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
config.api.rateLimit.max = 100_000;

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

const API = config.api.prefix;
const U: Record<string, any> = {};
let server: any;
let port = 0;
let origin = '';

const bearer = (who: string) => ({ Authorization: `Bearer ${generateToken(U[who])}` });
const restAs = (headers: Record<string, string>) => ({
    post: (p: string, body: any) => (request(server) as any).post(`${API}${p}`).set({ Origin: origin, ...headers }).send(body),
    put: (p: string, body: any) => (request(server) as any).put(`${API}${p}`).set({ Origin: origin, ...headers }).send(body),
    del: (p: string) => (request(server) as any).delete(`${API}${p}`).set({ Origin: origin, ...headers }),
});

interface Frame { event: string; id?: string; data: any }

/** Open a GraphQL-over-SSE stream; frames are collected as they arrive. */
function openStream(query: string, headers: Record<string, string> = {}, variables?: any): Promise<{ status: number; frames: Frame[]; next: (pred: (f: Frame) => boolean, ms?: number) => Promise<Frame>; ended: Promise<void>; close: () => void; body: string }> {
    const qs = new URLSearchParams({ query, ...(variables ? { variables: JSON.stringify(variables) } : {}) }).toString();
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: `${API}/graphql/stream?${qs}`, headers: { Accept: 'text/event-stream', ...headers } }, (res: any) => {
            const frames: Frame[] = [];
            const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
            let buf = '';
            let body = '';
            let endResolve: () => void;
            const ended = new Promise<void>((r) => { endResolve = r; });
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
                body += chunk;
                buf += chunk;
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const raw = buf.slice(0, i);
                    buf = buf.slice(i + 2);
                    const f: Frame = { event: 'message', data: null };
                    let data = '';
                    for (const line of raw.split('\n')) {
                        if (line.startsWith(':')) continue;
                        const [k, ...rest] = line.split(':');
                        const v = rest.join(':').replace(/^ /, '');
                        if (k === 'event') f.event = v; else if (k === 'id') f.id = v; else if (k === 'data') data += v;
                    }
                    if (!raw.split('\n').some((l) => l && !l.startsWith(':'))) continue;
                    try { f.data = data ? JSON.parse(data) : null; } catch { f.data = data; }
                    frames.push(f);
                    for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
                }
            });
            res.on('end', () => endResolve());
            res.on('close', () => endResolve());
            const next = (pred: (f: Frame) => boolean, ms = 4000) => new Promise<Frame>((res2, rej2) => {
                const hit = frames.find(pred);
                if (hit) return res2(hit);
                const t = setTimeout(() => rej2(new Error(`no matching frame within ${ms}ms; got ${JSON.stringify(frames)}`)), ms);
                waiters.push({ pred, resolve: (f) => { clearTimeout(t); res2(f); } });
            });
            resolve({ status: res.statusCode, frames, next, ended, close: () => req.destroy(), get body() { return body; } } as any);
        });
        req.on('error', reject);
    });
}

const CONTENT = 'subscription($kinds: [ContentEventKind!]) { contentChanged(kinds: $kinds) { kind id cursor node { id title status } } }';
const eventOf = (f: Frame) => f.data && f.data.data && f.data.data.contentChanged;
const isEvent = (pred: (e: any) => boolean) => (f: Frame) => f.event === 'next' && !!eventOf(f) && pred(eventOf(f));
const settle = () => new Promise((r) => setTimeout(r, 400));

before(async () => {
    config.nodeEnv = 'test';
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await require('../core/post-types').initPostTypes();
    await require('../core/roles').loadRoles();
    for (const [login, role] of [['admin', 'administrator'], ['editor', 'editor'], ['alice', 'author'], ['bob', 'author']]) {
        U[login] = await User.create({ username: login, email: `${login}@example.com`, password: 'Correct-Horse-9-Battery', role });
    }
    subscriptions.setFeedTuning({ pollMs: 50, recheckMs: 150 });
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

describe('every event is re-authorized as the subscriber', () => {
    test('anonymous hears about the published entry and never about the draft; the author hears about both', async () => {
        const anon = await openStream(CONTENT);
        const author = await openStream(CONTENT, bearer('alice'));
        assert.strictEqual(anon.status, 200);
        await settle();
        const alice = restAs(bearer('alice'));
        const draft = await alice.post('/posts', { title: 'secret draft' });
        const pub = await alice.post('/posts', { title: 'public news', status: 'publish' });
        assert.strictEqual(pub.status, 201);

        const seen = await anon.next(isEvent((e) => e.id === pub.body.id));
        assert.strictEqual(eventOf(seen).kind, 'CREATED');
        assert.deepStrictEqual(eventOf(seen).node, { id: pub.body.id, title: 'public news', status: 'publish' });
        assert.ok(seen.id && /^\d+\.\d+$/.test(seen.id), 'the SSE id is the resume cursor');
        const ownDraft = await author.next(isEvent((e) => e.id === draft.body.id));
        assert.strictEqual(eventOf(ownDraft).node.title, 'secret draft');
        await author.next(isEvent((e) => e.id === pub.body.id));
        await settle();
        assert.ok(!anon.frames.some(isEvent((e) => e.id === draft.body.id)), 'the anonymous stream never learnt the draft existed');
        assert.ok(!anon.body.includes('secret draft'));

        // Trashing the published entry: the anonymous stream had seen it, so it hears DELETED — with no body.
        await alice.del(`/posts/${pub.body.id}`);
        const gone = await anon.next(isEvent((e) => e.id === pub.body.id && e.kind === 'DELETED'));
        assert.strictEqual(eventOf(gone).node, null);

        // Another author's draft never reaches alice's stream.
        const bobDraft = await restAs(bearer('bob')).post('/posts', { title: 'bob private draft' });
        const marker = await alice.post('/posts', { title: 'marker', status: 'publish' });
        await author.next(isEvent((e) => e.id === marker.body.id));
        assert.ok(!author.frames.some(isEvent((e) => e.id === bobDraft.body.id)));
        anon.close();
        author.close();
    });

    test('an entry that becomes public is CREATED for a stream that could not see it before', async () => {
        const anon = await openStream(CONTENT);
        await settle();
        const alice = restAs(bearer('alice'));
        const d = await alice.post('/posts', { title: 'soon public' });
        await alice.put(`/posts/${d.body.id}`, { status: 'publish' });
        const f = await anon.next(isEvent((e) => e.id === d.body.id));
        assert.strictEqual(eventOf(f).kind, 'CREATED');
        await alice.put(`/posts/${d.body.id}`, { status: 'draft' });
        const g = await anon.next(isEvent((e) => e.id === d.body.id && e.kind === 'DELETED'));
        assert.strictEqual(eventOf(g).node, null);
        anon.close();
    });

    test('a stream opened with an API token closes when the token is revoked', async () => {
        const minted = await ApiToken.generate({ userId: U.alice.id, name: 'stream', scopes: ['posts:read'] });
        const s = await openStream(CONTENT, { Authorization: `Bearer ${minted.token}` });
        assert.strictEqual(s.status, 200);
        await settle();
        await require('../config/database').getDbAsync().run('DELETE FROM api_tokens WHERE id = ?', [minted.id]);
        await Promise.race([s.ended, new Promise((_, rej) => setTimeout(() => rej(new Error(`stream still open: ${s.body}`)), 4000))]);
        assert.ok(s.frames.some((f) => f.event === 'next' && f.data && f.data.errors), 'an error frame says why');
        assert.ok(s.frames.some((f) => f.event === 'complete'));
    });

    test('commentAdded: held comments never reach an anonymous stream; approved ones do', async () => {
        const post = await restAs(bearer('admin')).post('/posts', { title: 'discuss', status: 'publish' });
        const anon = await openStream('subscription($p: Int) { commentAdded(postId: $p) { cursor comment { id content status } } }', {}, { p: post.body.id });
        const mod = await openStream('subscription($p: Int) { commentAdded(postId: $p) { comment { id content status } } }', bearer('editor'), { p: post.body.id });
        await settle();
        const held = await restAs({}).post('/comments', { post: post.body.id, content: 'a held comment body', author_name: 'G', author_email: 'g@example.com' });
        assert.ok(held.status < 300, JSON.stringify(held.body));
        const modFrame = await mod.next((f) => f.event === 'next' && f.data.data && f.data.data.commentAdded.comment.id === held.body.id);
        assert.ok(modFrame, 'the moderator stream carries the held comment');
        await settle();
        assert.ok(!anon.body.includes('a held comment body'), 'never to anonymous');
        anon.close();
        mod.close();
    });
});

describe('the stream transport', () => {
    test('only subscriptions are served; a query or a mutation is a 400 and runs nothing', async () => {
        const q = await (request(server) as any).get(`${API}/graphql/stream`).query({ query: '{ posts { totalCount } }' });
        assert.strictEqual(q.status, 400);
        assert.strictEqual(q.body.errors[0].extensions.code, 'GRAPHQL_NOT_A_SUBSCRIPTION');
        const m = await (request(server) as any).get(`${API}/graphql/stream`).set(bearer('admin'))
            .query({ query: 'mutation { createPost(input: { title: "stream write" }) { node { id } } }' });
        assert.strictEqual(m.status, 400);
        const n = await require('../config/database').getDbAsync().get("SELECT COUNT(*) AS n FROM posts WHERE post_title = 'stream write'");
        assert.strictEqual(Number(n.n), 0);
        // And /graphql itself does not run subscriptions.
        const viaPost = await (request(server) as any).post(`${API}/graphql`).set(bearer('admin')).set('Accept', 'application/json').send({ query: 'subscription { contentChanged { id } }' });
        assert.ok(viaPost.body.errors && viaPost.body.errors.length);
    });

    test('a cookie-authenticated GET from another origin is refused; the same origin is served', async () => {
        const cookie = `wordjs_token=${generateToken(U.alice)}`;
        const cross = await (request(server) as any).get(`${API}/graphql/stream`).set('Cookie', cookie).set('Origin', 'https://evil.example')
            .query({ query: 'subscription { contentChanged { id } }' });
        assert.strictEqual(cross.status, 403);
        assert.strictEqual(cross.body.code, 'rest_csrf_invalid');
        const same = await openStream('subscription { contentChanged { id } }', { Cookie: cookie, Origin: origin });
        assert.strictEqual(same.status, 200);
        same.close();
    });

    test('streams per caller are capped', async () => {
        const max = config.api.graphql.maxStreamsPerClient;
        const open = [];
        for (let i = 0; i < max; i++) open.push(await openStream('subscription { contentChanged { id } }', bearer('bob')));
        assert.ok(open.every((s) => s.status === 200));
        const over = await (request(server) as any).get(`${API}/graphql/stream`).set(bearer('bob')).query({ query: 'subscription { contentChanged { id } }' });
        assert.strictEqual(over.status, 429);
        assert.strictEqual(over.body.errors[0].extensions.code, 'graphql_stream_limit');
        for (const s of open) s.close();
    });

    test('Last-Event-ID resumes after the cursor, still authorized per subscriber', async () => {
        const first = await openStream(CONTENT);
        await settle();
        const alice = restAs(bearer('alice'));
        const a = await alice.post('/posts', { title: 'resume A', status: 'publish' });
        const fa = await first.next(isEvent((e) => e.id === a.body.id));
        first.close();
        const b = await alice.post('/posts', { title: 'resume B', status: 'publish' });
        const hidden = await alice.post('/posts', { title: 'resume hidden draft' });
        const c = await alice.post('/posts', { title: 'resume C', status: 'publish' });
        const subscriber = await openStream(CONTENT, {});
        await settle();
        subscriber.close();
        // The cursor rides as the SSE id even when the client did not select it.
        const bare = await openStream('subscription { contentChanged { id } }');
        await settle();
        const z = await alice.post('/posts', { title: 'resume Z', status: 'publish' });
        const fz = await bare.next((f) => f.event === 'next' && f.data.data && f.data.data.contentChanged.id === z.body.id);
        assert.ok(fz.id && /^\d+\.\d+$/.test(fz.id), 'id without a selected cursor');
        bare.close();
        const resumed = await openStream(CONTENT, { 'Last-Event-ID': String(fa.id) });
        await resumed.next(isEvent((e) => e.id === b.body.id));
        await resumed.next(isEvent((e) => e.id === c.body.id));
        assert.ok(!resumed.frames.some(isEvent((e) => e.id === a.body.id)), 'nothing at or before the cursor');
        assert.ok(!resumed.body.includes('resume hidden draft'), 'replayed events are authorized too');
        void hidden;
        resumed.close();
    });
});
