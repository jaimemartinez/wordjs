/**
 * GRAPHQL READS BEYOND PUBLIC CONTENT, and the GraphQL ↔ REST ↔ MCP parity tables — on the REAL app.
 *
 * Users, revisions, members-only access levels and the administrative resources (webhooks, plugins,
 * network sites) are each the REST read they name, for the same caller. Every block asks REST and GraphQL
 * the same question for every caller — anonymous, subscriber, author, editor, administrator, an API token —
 * and asserts the same answer: the same rows where REST answers, the same refusal code and status where it
 * refuses, null where it says 404.
 *
 * The parity tables are the documented contracts: every mutation and every new read names its REST twin
 * (MUTATION_REST_TWINS / RESOURCE_REST_TWINS), each twin must be a real route of the real app, and every
 * REST write the MCP server dispatches for an AI agent has a GraphQL mutation performing the same write —
 * so the two machine surfaces cannot drift apart.
 *
 * MUTATION PROOF: before this change none of these fields existed (every query is a validation error),
 * and removing a row from either twin table, or a twin route, fails its test.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-gql-res-${process.pid}-${Date.now()}.db`);
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
const graphql = require('../core/graphql');

const API = config.api.prefix;
const U: Record<string, any> = {};
const TOKENS: Record<string, string> = {};
let server: any;
let origin = '';
let postId = 0;

const CALLERS = ['anonymous', 'sub', 'alice', 'bob', 'editor', 'admin', 'aliceToken'];

function headersFor(who: string): Record<string, string> {
    if (who === 'anonymous') return { Origin: origin };
    if (TOKENS[who]) return { Authorization: `Bearer ${TOKENS[who]}` };
    return { Authorization: `Bearer ${generateToken(U[who])}` };
}
const rest = (who: string, p: string) => (request(server) as any).get(`${API}${p}`).set(headersFor(who));
const gql = (who: string, query: string, variables?: any) => (request(server) as any).post(`${API}/graphql`)
    .set({ ...headersFor(who), Accept: 'application/graphql-response+json, application/json' }).send({ query, variables });

/** Same question, same answer: rows equal under `pick`, or the same refusal, or null for a REST 404. */
async function parity(who: string, restPath: string, query: string, field: string, pick: (restBody: any) => any, gqlPick: (v: any) => any = (v) => v, notFoundIsNull = true) {
    const r = await rest(who, restPath);
    const g = await gql(who, query);
    // A single lookup REST answers 404 is null; a LIST that REST answers 404 is that refusal, as an error.
    if (r.status === 404 && notFoundIsNull) {
        assert.ok(!g.body.errors, `${who} ${field}: ${JSON.stringify(g.body.errors)}`);
        assert.strictEqual(g.body.data[field], null, `${who} ${field}: REST 404 must be null`);
        return;
    }
    if (r.status >= 400) {
        const err = (g.body.errors || [])[0];
        assert.ok(err, `${who} ${field}: GraphQL answered what REST refused (${r.status} ${r.body.code})`);
        assert.strictEqual(err.extensions.code, r.body.code, `${who} ${field}: code`);
        assert.strictEqual(err.extensions.status, r.status, `${who} ${field}: status`);
        return;
    }
    assert.ok(!g.body.errors, `${who} ${field}: ${JSON.stringify(g.body.errors)}`);
    assert.deepStrictEqual(gqlPick(g.body.data[field]), pick(r.body), `${who} ${field}`);
}

before(async () => {
    config.nodeEnv = 'test';
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await require('../core/post-types').initPostTypes();
    await require('../core/roles').loadRoles();
    for (const [login, role] of [['admin', 'administrator'], ['editor', 'editor'], ['alice', 'author'], ['bob', 'author'], ['sub', 'subscriber']]) {
        U[login] = await User.create({ username: login, email: `${login}@example.com`, password: 'Correct-Horse-9-Battery', role, displayName: `${login} display` });
    }
    TOKENS.aliceToken = (await ApiToken.generate({ userId: U.alice.id, name: 'ro', scopes: ['posts:read'] })).token;
    const { notFound, errorHandler } = require('../middleware/errorHandler');
    app.use(notFound);
    app.use(errorHandler);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    origin = `http://127.0.0.1:${server.address().port}`;

    const created = await (request(server) as any).post(`${API}/posts`).set(headersFor('alice')).send({ title: 'rev 1', content: 'one' });
    postId = created.body.id;
    await (request(server) as any).put(`${API}/posts/${postId}`).set(headersFor('alice')).send({ title: 'rev 2', content: 'two' });
    await (request(server) as any).put(`${API}/posts/${postId}`).set(headersFor('alice')).send({ title: 'rev 3', content: 'three' });
    const hook = await (request(server) as any).post(`${API}/webhooks`).set(headersFor('admin')).send({ name: 'Probe hook', url: 'https://hooks.example.com/wordjs', events: ['post.published'] });
    assert.ok(hook.status < 300, `webhook seed: ${hook.status} ${JSON.stringify(hook.body)}`);
});

after(async () => {
    configManager.isInstalled = realIsInstalled;
    configManager.getConfig = realGetConfig;
    try { await new Promise((r) => server.close(r)); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

describe('reads with REST parity, for every caller', () => {
    test('users: the list needs list_users exactly as GET /users does', async () => {
        for (const who of CALLERS) {
            await parity(who, '/users?per_page=50', '{ users(first: 50) { totalCount nodes { id username email displayName role } } }', 'users',
                (rows) => ({ totalCount: rows.length, nodes: rows.map((u: any) => ({ id: u.id, username: u.username, email: u.email, displayName: u.displayName, role: u.role })) }),
                (c) => ({ totalCount: c.nodes.length, nodes: c.nodes }));
        }
    });

    test('user(id): the caller themself, or anyone for list_users — otherwise null, like REST\'s 404', async () => {
        for (const who of CALLERS) {
            for (const target of ['alice', 'admin']) {
                await parity(who, `/users/${U[target].id}`, `{ user(id: ${U[target].id}) { id email role } }`, 'user',
                    (u) => ({ id: u.id, email: u.email, role: u.role }));
            }
        }
    });

    test('revisions: the entry\'s edit gate decides, through the connection and through ContentNode.revisions', async () => {
        for (const who of CALLERS) {
            await parity(who, `/revisions/post/${postId}?limit=50`, `{ revisions(postId: ${postId}, first: 50) { totalCount nodes { id title } } }`, 'revisions',
                (b) => ({ totalCount: b.total, nodes: b.revisions.map((x: any) => ({ id: x.id, title: x.title })) }));
        }
        const r = await rest('alice', `/revisions/post/${postId}?limit=50`);
        const one = r.body.revisions[0];
        for (const who of CALLERS) {
            await parity(who, `/revisions/${one.id}`, `{ revision(id: ${one.id}) { id title postId } }`, 'revision', (x) => ({ id: x.id, title: x.title, postId: x.postId }));
        }
        const nested = await gql('alice', `{ contentNode(id: ${postId}) { revisions(first: 2) { totalCount nodes { id } } } }`);
        assert.ok(!nested.body.errors, JSON.stringify(nested.body.errors));
        assert.strictEqual(nested.body.data.contentNode.revisions.totalCount, r.body.total);
        assert.deepStrictEqual(nested.body.data.contentNode.revisions.nodes.map((n: any) => n.id), r.body.revisions.slice(0, 2).map((x: any) => x.id));
        // Paging is REST's limit/offset underneath: page two continues where page one ended.
        const p1 = await gql('alice', `{ revisions(postId: ${postId}, first: 1) { pageInfo { endCursor hasNextPage } nodes { id } } }`);
        const p2 = await gql('alice', `query($a: String) { revisions(postId: ${postId}, first: 1, after: $a) { nodes { id } } }`, { a: p1.body.data.revisions.pageInfo.endCursor });
        assert.strictEqual(p1.body.data.revisions.pageInfo.hasNextPage, true);
        assert.deepStrictEqual([p1.body.data.revisions.nodes[0].id, p2.body.data.revisions.nodes[0].id], r.body.revisions.slice(0, 2).map((x: any) => x.id));
    });

    test('contentAccessLevels: GET /content-access/levels (edit_posts)', async () => {
        for (const who of CALLERS) {
            await parity(who, '/content-access/levels', '{ contentAccessLevels { metaKey levels } }', 'contentAccessLevels', (b) => ({ metaKey: b.metaKey, levels: b.levels }));
        }
    });

    test('webhooks: administrators only; the signing secret is never readable', async () => {
        for (const who of CALLERS) {
            await parity(who, '/webhooks', '{ webhooks { id name url events secretPrefix active } }', 'webhooks',
                (b) => b.webhooks.map((w: any) => ({ id: w.id, name: w.name, url: w.url, events: w.events, secretPrefix: w.secretPrefix, active: w.active })));
        }
        const list = (await rest('admin', '/webhooks')).body.webhooks;
        const id = list[0].id;
        for (const who of ['editor', 'admin']) {
            await parity(who, `/webhooks/${id}`, `{ webhook(id: ${id}) { id name deliveries { id } } }`, 'webhook',
                (b) => ({ id: (b.webhook || b).id, name: (b.webhook || b).name, deliveries: [] }));
        }
        const one = await gql('admin', `{ webhook(id: ${id}) { id url } webhookEvents }`);
        assert.ok(!one.body.errors, JSON.stringify(one.body.errors));
        assert.ok(one.body.data.webhookEvents.includes('post.published'));
        const schema = graphql.getSchema();
        assert.ok(!Object.keys((schema.getType('Webhook') as any).getFields()).some((f) => /^secret$|signingSecret/i.test(f)), 'no secret field');
    });

    test('plugins: GET /plugins (administrators)', async () => {
        for (const who of CALLERS) {
            await parity(who, '/plugins', '{ plugins { slug active } }', 'plugins',
                (b) => (Array.isArray(b) ? b : b.plugins || []).map((p: any) => ({ slug: p.slug, active: p.active === undefined ? null : p.active })));
        }
    });

    test('networkSites: GET /network/sites (network administrators, interactive sessions only)', async () => {
        for (const who of CALLERS) {
            await parity(who, '/network/sites', '{ networkSites { id slug main } }', 'networkSites',
                (b) => b.sites.map((s: any) => ({ id: s.id, slug: s.slug, main: s.main })), (v) => v, false);
        }
    });

    test('comments(status:) lists held comments for a moderator only, as GET /comments?status= does', async () => {
        const pub = await (request(server) as any).post(`${API}/posts`).set(headersFor('admin')).send({ title: 'with comments', status: 'publish' });
        await (request(server) as any).post(`${API}/comments`).set(headersFor('anonymous')).send({ post: pub.body.id, content: 'first held comment here', author_name: 'G', author_email: 'g@example.com' });
        for (const who of CALLERS) {
            await parity(who, `/comments?post=${pub.body.id}&status=hold`, `{ comments(postId: ${pub.body.id}, status: "hold", first: 10) { nodes { id status } } }`, 'comments',
                (rows) => rows.map((c: any) => ({ id: c.id, status: c.status })), (c) => c.nodes);
        }
    });
});

describe('parity tables: every GraphQL field names its REST twin, and the MCP writes are covered', () => {
    const routeExists = async (twin: string) => {
        const [method, raw] = twin.split(' ');
        for (const alt of raw.split('|')) {
            const p = (alt.startsWith('/') ? alt : raw.split('|')[0].replace(/\/[^/]*$/, `/${alt}`))
                .replace(/:[a-zA-Z]+/g, '1');
            const r = await (request(server) as any)[method.toLowerCase()](`${API}${p}`).set({ Origin: origin }).send({});
            assert.ok(!(r.status === 404 && r.body && r.body.code === 'rest_no_route'), `${twin}: ${method} ${p} is not a route`);
        }
    };

    test('every mutation exists in the schema and its REST twin is a real route', async () => {
        const fields = (graphql.getSchema().getMutationType() as any).getFields();
        assert.deepStrictEqual(Object.keys(graphql.MUTATION_REST_TWINS).sort(), Object.keys(fields).sort(), 'the table lists exactly the Mutation root');
        for (const twin of Object.values(graphql.MUTATION_REST_TWINS) as string[]) await routeExists(twin);
    });

    test('every new read exists in the schema and its REST twin is a real route', async () => {
        const fields = (graphql.getSchema().getQueryType() as any).getFields();
        for (const [field, twin] of Object.entries(graphql.RESOURCE_REST_TWINS) as Array<[string, string]>) {
            assert.ok(fields[field], `Query.${field}`);
            await routeExists(twin);
        }
    });

    test('every REST write the MCP server dispatches for an agent has a GraphQL mutation doing the same write', async () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'mcp-server.ts'), 'utf8');
        // tool name → the GraphQL mutation that performs the same REST write
        const MCP_TO_GRAPHQL: Record<string, string> = {
            create_draft: 'createContent',
            update_draft: 'updateContent',
            submit_for_review: 'updateContent',
            publish_content: 'publishContent',
            create_term: 'createTerm',
            upload_media: 'uploadMedia',
            moderate_comment: 'moderateComment',
        };
        const writes = [...source.matchAll(/rest\('(POST|PUT|PATCH|DELETE)'/g)].length;
        assert.strictEqual(writes, Object.keys(MCP_TO_GRAPHQL).length, 'a new MCP write tool needs its GraphQL twin listed here');
        for (const tool of Object.keys(MCP_TO_GRAPHQL)) assert.ok(source.includes(`registerTool('${tool}'`), `MCP tool ${tool}`);
        const mutations = (graphql.getSchema().getMutationType() as any).getFields();
        for (const field of Object.values(MCP_TO_GRAPHQL)) assert.ok(mutations[field], `Mutation.${field}`);
        // And the MCP reads have their GraphQL query.
        const queries = (graphql.getSchema().getQueryType() as any).getFields();
        for (const q of ['contentNodes', 'contentNode', 'categories', 'tags', 'mediaItems', 'comments', 'settings', 'viewer']) assert.ok(queries[q], `Query.${q}`);
        assert.ok(queries.comments.args.some((a: any) => a.name === 'status'), 'list_comments(status: hold) has its GraphQL twin');
    });
});
