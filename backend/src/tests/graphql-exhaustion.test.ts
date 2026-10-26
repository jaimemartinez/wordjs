/**
 * GRAPHQL — what one request may make the server do, on the REAL app.
 *
 *  · A scalar leaf has a cost and a page multiplies it: a page of aliased leaves is refused at validation.
 *  · The fields an operation selects (fragments expanded) and the aliased fields of one selection set
 *    (fragments spread into it included) are capped.
 *  · A result is measured before it is serialized: one larger than the response cap is an error, not a
 *    response.
 *  · Every REST sub-request after the first is charged to the API limiter; past the limit the field gets
 *    the REST 429.
 *  · A multipart request is authorized (signed in, upload_files) before a byte is buffered, each file is
 *    held to the site's upload limit (Settings → Media) and all of them together to that same limit, and
 *    every file after the first is one more hit on the upload limiter.
 * And the queries a client really sends (the documented ones, the admin-sized pages) stay under every cap.
 *
 * MUTATION PROOF: with a leaf costed at 0 the aliased page validates; without the field/alias walk the
 * fragment documents validate; without the response measure the oversized answer is sent; without the
 * dispatch charge RateLimit-Remaining drops by one per GraphQL request; without the multipart gate the
 * anonymous upload reaches multer (400, not 401) and the second file is never charged.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_DB = path.join(os.tmpdir(), `wjs-gql-exh-${STAMP}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
config.uploads.dir = path.join(os.tmpdir(), `wjs-gql-exh-up-${STAMP}`);
config.uploads.privateDir = path.join(os.tmpdir(), `wjs-gql-exh-priv-${STAMP}`);
// Read once when index.ts builds its limiters: this suite sends many requests from one address.
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
const { registerLimiterCharge } = require('../core/limiter-charge');

const API = config.api.prefix;
const U: Record<string, any> = {};
const P: number[] = [];
let server: any;
let origin = '';
let db: any;

const bearer = (who: string) => ({ Authorization: `Bearer ${generateToken(U[who])}`, Origin: origin });
function gql(who: string | null, query: string, variables?: any) {
    return (request(server) as any).post(`${API}/graphql`)
        .set({ ...(who ? bearer(who) : { Origin: origin }), Accept: 'application/graphql-response+json, application/json' })
        .send({ query, variables });
}
const codes = (r: any): string[] => ((r.body && r.body.errors) || []).map((e: any) => e.extensions && e.extensions.code);

before(async () => {
    config.nodeEnv = 'test';
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    db = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await require('../core/roles').loadRoles();
    for (const [login, role] of [['admin', 'administrator'], ['alice', 'author'], ['sub', 'subscriber']]) {
        U[login] = await User.create({ username: login, email: `${login}@example.com`, password: 'Correct-Horse-9-Battery', role });
    }
    for (let i = 0; i < 5; i++) {
        const r = await db.run(
            `INSERT INTO posts (author_id, post_title, post_content, post_status, post_type, post_name, comment_status, post_date, post_date_gmt)
             VALUES (?, ?, ?, 'publish', 'post', ?, 'open', '2026-01-10 10:00:00', '2026-01-10 10:00:00')`,
            [U.alice.id, `Post ${i}`, `body ${i}`, `exh-${i}`]);
        P.push(r.lastID);
    }
    const { notFound, errorHandler } = require('../middleware/errorHandler');
    app.use(notFound);
    app.use(errorHandler);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    configManager.isInstalled = realIsInstalled;
    configManager.getConfig = realGetConfig;
    try { if (server.closeAllConnections) server.closeAllConnections(); } catch { /* */ }
    try { await new Promise((r) => server.close(r)); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
    for (const d of [config.uploads.dir, config.uploads.privateDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
});

/** Measure a document against the core schema with the default limits. */
function measure(src: string) {
    const { measureOperation } = require('../core/graphql/limits');
    const { parse, TypeInfo, ValidationContext } = require('graphql');
    const { buildCoreSchema } = require('../core/graphql/schema');
    const schema = buildCoreSchema();
    const doc = parse(src);
    const ctx = new ValidationContext(schema, doc, new TypeInfo(schema), () => {});
    const op = doc.definitions.find((d: any) => d.kind === 'OperationDefinition');
    return measureOperation(ctx, op.selectionSet, schema.getQueryType(), { maxDepth: 99, maxCost: 1e9, maxPageSize: 100, maxFields: 1e9, maxAliases: 1e9 });
}

const aliases = (n: number, field: string) => Array.from({ length: n }, (_, i) => `a${i}: ${field}`).join(' ');

describe('cost, fields and aliases', () => {
    test('a scalar leaf costs a tenth, and a page multiplies it', () => {
        const one = measure('{ posts(first: 100) { nodes { id } } }');
        const two = measure('{ posts(first: 100) { nodes { id title } } }');
        assert.strictEqual(two.cost - one.cost, 10, 'one more leaf on a page of 100 costs 100 × 0.1');
    });

    test('pages of aliased leaves are refused before anything runs', async () => {
        // 45 aliases stay under the alias cap; on three pages of 100 they are 13 500 leaves (cost ~1 365).
        const page = `{ nodes { ${aliases(45, 'content')} } }`;
        const r = await gql(null, `{ a: posts(first: 100) ${page} b: posts(first: 100) ${page} c: posts(first: 100) ${page} }`);
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.body.data, undefined, 'nothing executed');
        assert.deepStrictEqual(codes(r), ['GRAPHQL_COST_LIMIT']);
    });

    test('the fields of an operation are counted with every fragment expanded', async () => {
        // 30 leaves in a fragment, spread under 40 aliased entries: 40 × 31 selected fields, 40 × 4 in cost.
        const frag = `fragment F on ContentNode { ${aliases(30, 'id')} }`;
        const posts = P.slice(0, 5);
        const roots = Array.from({ length: 40 }, (_, i) => `p${i}: post(id: ${posts[i % posts.length]}) { ...F }`).join(' ');
        const r = await gql(null, `${frag}\n{ ${roots} }`);
        assert.strictEqual(r.status, 400);
        assert.ok(codes(r).includes('GRAPHQL_FIELD_LIMIT'), JSON.stringify(r.body.errors));
    });

    test('the aliases spread into one selection set are counted together', async () => {
        const r = await gql(null, `fragment A on ContentNode { ${aliases(30, 'title')} }
            fragment B on ContentNode { ${aliases(30, 'slug').replace(/a(\d+):/g, 'b$1:')} }
            { post(id: ${P[0]}) { ...A ...B } }`);
        assert.strictEqual(r.status, 400);
        assert.deepStrictEqual(codes(r), ['GRAPHQL_ALIAS_LIMIT']);
        const half = await gql(null, `fragment A on ContentNode { ${aliases(30, 'title')} } { post(id: ${P[0]}) { ...A } }`);
        assert.ok(!half.body.errors, JSON.stringify(half.body.errors));
    });

    test('the queries a client sends stay under every limit', async () => {
        const realistic = [
            // The documented page, an admin-sized list with relations, a dashboard of several roots.
            '{ posts(first: 10) { nodes { id title slug excerpt date link author { id name } } pageInfo { hasNextPage endCursor } } }',
            '{ posts(first: 100, status: "any") { nodes { id type slug status title excerpt content protected link menuOrder authorId parentId meta author { id name slug } categories { id name slug } tags { id } featuredMedia { id } } pageInfo { hasNextPage endCursor } } }',
            `{ recent: posts(first: 20) { nodes { id title date } } pages(first: 20) { nodes { id title parentId } }
               one: post(id: ${P[0]}) { id title content comments(first: 20) { nodes { id content authorName date } } } categories(first: 50) { nodes { id name } } viewer { id name } }`,
        ];
        for (const q of realistic) {
            const r = await gql('admin', q);
            assert.ok(!r.body.errors, `${q.slice(0, 60)}…: ${JSON.stringify(r.body.errors)}`);
        }
    });
});

describe('response size', () => {
    test('a result larger than the cap is an error, measured before it is serialized', async () => {
        const big = 'x'.repeat(40 * 1024);
        await db.run('UPDATE posts SET post_content = ? WHERE id = ?', [big, P[1]]);
        const saved = config.api.graphql.maxResponseBytes;
        config.api.graphql.maxResponseBytes = 64 * 1024;
        try {
            const fits = await gql(null, `{ post(id: ${P[1]}) { content } }`);
            assert.ok(!fits.body.errors, JSON.stringify(fits.body.errors));
            const tooBig = await gql(null, `{ post(id: ${P[1]}) { a: content b: content } }`);
            assert.deepStrictEqual(codes(tooBig), ['GRAPHQL_RESPONSE_TOO_LARGE']);
            assert.ok(!tooBig.body.data, 'no partial data');
            assert.ok(JSON.stringify(tooBig.body).length < 4096);
        } finally {
            config.api.graphql.maxResponseBytes = saved;
        }
    });

    test('exceedsResponseBytes counts what JSON would write, stopping at the limit', () => {
        const { exceedsResponseBytes } = require('../core/graphql/limits');
        const value = { data: { a: 'ñ'.repeat(10), list: [1, true, null, { k: 'v' }] } };
        const exact = Buffer.byteLength(JSON.stringify(value));
        assert.strictEqual(exceedsResponseBytes(value, exact + 64), false);
        assert.strictEqual(exceedsResponseBytes(value, Math.floor(exact / 2)), true);
        const shared = 'y'.repeat(1000);
        const many = { data: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, shared])) };
        assert.strictEqual(exceedsResponseBytes(many, 1024 * 1024), true, 'shared references are counted once per use');
    });
});

describe('the API limiter is charged per REST sub-request', () => {
    const remaining = async () => Number((await (request(server) as any).get(`${API}/posts/${P[0]}`)).headers['ratelimit-remaining']);

    test('a query costs the budget what the REST reads behind it would', async () => {
        const before = await remaining();
        const r = await gql(null, `{ a: post(id: ${P[0]}) { id } b: post(id: ${P[2]}) { id } c: post(id: ${P[3]}) { id } }`);
        assert.ok(!r.body.errors, JSON.stringify(r.body.errors));
        const after = await remaining();
        // The GraphQL request (1) + the two reads after the first (2) + the probe itself (1).
        assert.strictEqual(before - after, 4);
    });

    test('past the limit a field gets the REST 429, and the first read is never charged', async () => {
        const hits: number[] = [];
        const previous = registerLimiterCharge('api', async (_req: any, n: number) => { hits.push(n); return false; });
        try {
            const one = await gql(null, `{ post(id: ${P[0]}) { id } }`);
            assert.ok(!one.body.errors, 'a single read is the request the limiter already counted');
            assert.deepStrictEqual(hits, []);
            const two = await gql(null, `{ a: post(id: ${P[0]}) { id } b: post(id: ${P[2]}) { id } }`);
            assert.ok(codes(two).includes('rest_rate_limited'), JSON.stringify(two.body));
            assert.deepStrictEqual(hits, [1]);
        } finally {
            registerLimiterCharge('api', previous);
        }
    });
});

describe('multipart uploads', () => {
    const UPLOAD = 'mutation($a: Upload!, $b: Upload!) { a: uploadMedia(file: $a) { mediaItem { id } } b: uploadMedia(file: $b) { mediaItem { id } } }';
    const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    function twoFiles(who: string | null, a: Buffer, b: Buffer) {
        return (request(server) as any).post(`${API}/graphql`).set({ ...(who ? bearer(who) : { Origin: origin }), Accept: 'application/json' })
            .field('operations', JSON.stringify({ query: UPLOAD, variables: { a: null, b: null } }))
            .field('map', JSON.stringify({ 0: ['variables.a'], 1: ['variables.b'] }))
            .attach('0', a, { filename: 'a.png', contentType: 'image/png' })
            .attach('1', b, { filename: 'b.png', contentType: 'image/png' });
    }

    test('an anonymous caller or one without upload_files is refused before the body is read', async () => {
        const anon = await twoFiles(null, PNG_1PX, PNG_1PX);
        assert.strictEqual(anon.status, 401);
        assert.deepStrictEqual(codes(anon), ['rest_not_logged_in']);
        const sub = await twoFiles('sub', PNG_1PX, PNG_1PX);
        assert.strictEqual(sub.status, 403);
        assert.deepStrictEqual(codes(sub), ['rest_forbidden']);
    });

    test('each file is held to the site upload limit, and the files of a request together to that limit', async () => {
        const options = require('../core/options');
        await options.updateOption('upload_max_size_mb', '1');
        try {
            const oneTooBig = await twoFiles('alice', Buffer.alloc(1536 * 1024, 1), PNG_1PX);
            assert.strictEqual(oneTooBig.status, 413);
            assert.deepStrictEqual(codes(oneTooBig), ['rest_upload_too_large']);
            const together = await twoFiles('alice', Buffer.alloc(600 * 1024, 1), Buffer.alloc(600 * 1024, 1));
            assert.strictEqual(together.status, 413);
            assert.deepStrictEqual(codes(together), ['rest_upload_too_large']);
            assert.match(together.body.errors[0].message, /together/);
        } finally {
            await options.updateOption('upload_max_size_mb', '');
        }
    });

    test('every file after the first is charged to the upload limiter', async () => {
        const hits: number[] = [];
        const previous = registerLimiterCharge('upload', async (_req: any, n: number) => { hits.push(n); return false; });
        try {
            const r = await twoFiles('alice', PNG_1PX, PNG_1PX);
            assert.strictEqual(r.status, 429);
            assert.deepStrictEqual(codes(r), ['rest_upload_rate_limited']);
            assert.deepStrictEqual(hits, [1], 'the first file rode on the request the limiter counted');
        } finally {
            registerLimiterCharge('upload', previous);
        }
        const ok = await twoFiles('alice', PNG_1PX, PNG_1PX);
        assert.ok(!ok.body.errors, JSON.stringify(ok.body));
        assert.ok(ok.body.data.a.mediaItem.id && ok.body.data.b.mediaItem.id);
    });
});
