/**
 * WordJS — a sandboxed plugin extends the GraphQL schema declaratively (wordjs.graphql.extend).
 *
 * The registration hook is host-only (its product is executable resolvers), so a sandboxed plugin could
 * not add a single field. It now declares SDL plus, for each new Query field, which of its OWN GET routes
 * answers it; the host builds the resolver and calls that route AS THE GRAPHQL CALLER, so the route's own
 * middleware authorizes it. Pinned with a real plugin child and the real /api/v1/graphql endpoint: data
 * flows from the plugin's route, path arguments and query arguments map, a route that needs a login
 * refuses an anonymous caller and serves a signed-in one, a declaration that tries to route an existing
 * or a non-Query field is refused, and unloading the plugin removes its fields.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '../..');
process.chdir(BACKEND_ROOT);

const config = require('../config/app');
config.dbPath = path.join(os.tmpdir(), `wordjs-graphql-bridge-${process.pid}-${Date.now()}.db`);
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const { setApp } = require('../core/appRegistry');
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');
const perms = require('../core/plugin-permissions');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const PLUGINS_DIR = path.join(BACKEND_ROOT, 'plugins');
const SLUG = 'zz-test-graphql-plugin';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));

let adminId = 0;
const bearer = () => ({ Authorization: `Bearer ${jwt.sign({ userId: adminId, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}` });
const gql = (query: string, headers: Record<string, string> = {}) =>
    request(app).get('/api/v1/graphql').query({ query }).set(headers);

before(async () => {
    setApp(app);
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await roles.loadRoles();
    const db = database.getDbAsync();
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('admin', 'x', 'admin@example.com', 'admin')`);
    adminId = r.lastID;
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [adminId]);
    perms._setGrantsInMemory(SLUG, ['express:register_route']);

    const dir = path.join(PLUGINS_DIR, SLUG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, isolated: true, permissions: [{ scope: 'express', access: 'register_route' }] }));
    fs.writeFileSync(path.join(dir, 'index.js'),
        "const BOOKS = [{ id: 1, title: 'Dune' }, { id: 2, title: 'Solaris' }, { id: 3, title: 'Ubik' }];\n" +
        "exports.init = function (wordjs) {\n" +
        "  wordjs.http.route('get', '/books', (req, res) => res.json(BOOKS.slice(0, Number(req.query.first) || BOOKS.length)));\n" +
        "  wordjs.http.route('get', '/books/:id', (req, res) => { const b = BOOKS.find((x) => x.id === Number(req.params.id)); if (!b) return res.status(404).json({}); res.json(b); });\n" +
        "  wordjs.http.route('get', '/shelf', { auth: true }, (req, res) => res.json({ owner: req.user.id, count: BOOKS.length }));\n" +
        "  wordjs.graphql.extend({\n" +
        "    typeDefs: 'type ZzBook { id: Int! title: String } type ZzShelf { owner: Int count: Int } extend type Query { zzBooks(first: Int): [ZzBook!]! zzBook(id: Int!): ZzBook zzShelf: ZzShelf }',\n" +
        "    fields: { 'Query.zzBooks': { path: '/books', list: true }, 'Query.zzBook': { path: '/books/:id' }, 'Query.zzShelf': { path: '/shelf' } },\n" +
        "  });\n" +
        "  // Refused: a route for a field that is not a Query entry point.\n" +
        "  wordjs.graphql.extend({ typeDefs: 'type ZzOther { x: Int } extend type Query { zzOther: ZzOther }', fields: { 'ZzOther.x': { path: '/books' } } });\n" +
        "  // Refused by the extension rules: an existing core field cannot be rerouted.\n" +
        "  wordjs.graphql.extend({ typeDefs: 'extend type Query { zzNothing: Int }', fields: { 'Query.posts': { path: '/books' } } });\n" +
        "};\n");
    await loadIsolatedPlugin(SLUG, path.join(dir, 'index.js'));
    for (let i = 0; i < 100; i++) {
        const r2 = await gql('{ zzBooks { id } }');
        if (r2.body && r2.body.data && r2.body.data.zzBooks) break;
        await new Promise((res) => setTimeout(res, 50));
    }
});

after(async () => {
    try { await unloadIsolatedPlugin(SLUG); } catch { /* */ }
    try { fs.rmSync(path.join(PLUGINS_DIR, SLUG), { recursive: true, force: true }); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    try { fs.rmSync(config.dbPath, { force: true }); } catch { /* */ }
});

test('a declared field resolves through the plugin route, with query and path arguments', async () => {
    const r = await gql('{ zzBooks(first: 2) { id title } zzBook(id: 3) { title } missing: zzBook(id: 99) { title } }');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.data.zzBooks, [{ id: 1, title: 'Dune' }, { id: 2, title: 'Solaris' }]);
    assert.deepStrictEqual(r.body.data.zzBook, { title: 'Ubik' });
    assert.strictEqual(r.body.data.missing, null, 'a 404 from the route is null');
});

test('the plugin route authorizes the GraphQL caller: anonymous is refused, a signed-in caller is served', async () => {
    const anon = await gql('{ zzShelf { owner count } }');
    assert.strictEqual(anon.body.data.zzShelf, null);
    assert.strictEqual(anon.body.errors[0].extensions.code, 'UNAUTHENTICATED');
    const signed = await gql('{ zzShelf { owner count } }', bearer());
    assert.deepStrictEqual(signed.body.data.zzShelf, { owner: adminId, count: 3 });
});

test('a non-Query routed field and a rerouted core field are refused; core fields are untouched', async () => {
    const other = await gql('{ zzOther { x } }');
    assert.ok(other.body.errors, 'the extension routing ZzOther.x was refused as a whole');
    const nothing = await gql('{ zzNothing }');
    assert.ok(nothing.body.errors, 'the extension rerouting Query.posts was refused as a whole');
    const posts = await gql('{ posts { nodes { id } } }');
    assert.ok(posts.body.data && posts.body.data.posts, JSON.stringify(posts.body));
});

test('unloading the plugin removes its fields', async () => {
    await unloadIsolatedPlugin(SLUG);
    const r = await gql('{ zzBooks { id } }');
    assert.ok(r.body.errors && /zzBooks/.test(JSON.stringify(r.body.errors)), JSON.stringify(r.body));
});
