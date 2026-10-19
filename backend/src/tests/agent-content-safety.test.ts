/**
 * AI AGENTS AND THE CONTENT THEY READ — publish confirmation, labelled revisions, and content types that
 * cannot borrow a core capability's name.
 *
 * Through the REAL producers: the official MCP client against routes/mcp.ts on a real listener, the REST
 * routes the tools dispatch into (routes/posts.ts, routes/revisions.ts, routes/agents.ts, routes/post-types.ts)
 * and the real content-type registry. Pins:
 *   1. a content type cannot name a core non-content capability (edit_users, manage_options, read, a
 *      `user` family…): refused by the schema, by the legacy adapter and by POST /types, and nothing is
 *      stored; and the agent mapping hard-denies those names whatever a type registry says;
 *   2. with "a person confirms what agents publish" ON, an editor's agent holding content:others +
 *      content:publish cannot put anything live — publish_content files it as pending and lists it in the
 *      queue, and it cannot edit content that is already published — while a person publishes it from the
 *      queue with their own session; OFF, the same agent publishes directly (nothing else changed);
 *   3. the revision an agent's write leaves names the agent, restoring it undoes the change, and the label
 *      cannot be written through the meta bag;
 *   4. only an administrator changes the setting or reads the queue.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-agent-safety-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const { csrfProtection } = require('../middleware/auth');
const { narrowUser, agentPermitsCapability } = require('../core/agent-capabilities');
const { _resetAgentRateLimits } = require('../core/mcp-server');
const User = require('../models/User');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(csrfProtection);
app.use('/api/v1', require('../routes'));

const U: Record<string, number> = {};
let dbAsync: any;
let server: any;
let baseUrl = '';
const as = (persona: string) => ({ Authorization: `Bearer ${jwt.sign({ userId: U[persona], username: persona }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}` });
const parse = (result: any) => JSON.parse(result.content[0].text);
const statusOf = async (id: number) => (await dbAsync.get('SELECT post_status FROM posts WHERE id = ?', [id])).post_status;

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`, [login, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

async function agentFor(persona: string, caps: string[]) {
    const res = await request(app).post('/api/v1/agents').set(as(persona)).send({ name: `${persona}-bot`, requested: caps });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const g = await request(app).put(`/api/v1/agents/${res.body.connection.id}/grant`).set(as('admin')).send({ granted: caps });
    assert.strictEqual(g.status, 200, JSON.stringify(g.body));
    return res.body as { token: string; connection: any };
}

async function mcp(token: string) {
    const client = new Client({ name: 'wordjs-safety-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/v1/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    return client;
}

const setConfirmation = (on: boolean, persona = 'admin') =>
    request(app).put('/api/v1/agents/settings').set(as(persona)).send({ publishConfirmation: on });

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    await seedUser('admin', 'administrator');
    await seedUser('editor', 'editor');
    await seedUser('writer', 'author');
    const caps = roles.getRoles();
    await roles.updateRoleCapabilities('editor', [...(caps.editor.capabilities || []), 'manage_api_tokens']);
    await roles.loadRoles();
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    try { if (server) server.close(); } catch { /* */ }
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(TMP_DB + s, { force: true }); } catch { /* */ } }
});

// ── 1. Content types cannot name core capabilities ─────────────────────────────────────────────────

test('a content type cannot name a core non-content capability — schema, legacy adapter and POST /types', async () => {
    const { normalizeContentTypeSchema, legacyPostTypeToContentSchema, adaptLegacyPostType } = require('../core/content-schema');
    const base = () => legacyPostTypeToContentSchema('vault', { label: 'Vault', supports: ['title', 'editor'], capability_type: 'vault' });
    for (const [op, cap] of [['edit', 'edit_users'], ['create', 'manage_options'], ['publish', 'activate_plugins'], ['editOthers', 'read'], ['edit', 'manage_anything']]) {
        const schema = base();
        schema.permissions.operations[op] = cap;
        assert.throws(() => normalizeContentTypeSchema(schema), /core capability/, `${op}: ${cap} must be refused`);
    }
    // A family that DERIVES a core name: `user` → edit_users / delete_users.
    assert.throws(() => adaptLegacyPostType('vault', { capability_type: 'user' }), /core capability/);
    assert.throws(() => adaptLegacyPostType('vault', { capability_type: 'theme' }), /core capability/);
    // Content capabilities of the core types stay shareable on purpose.
    assert.doesNotThrow(() => adaptLegacyPostType('vault', { capability_type: 'post' }));

    const viaRest = await request(app).post('/api/v1/types').set(as('admin')).send({ name: 'vault', label: 'Vault', capability_type: 'user' });
    assert.strictEqual(viaRest.status, 400, JSON.stringify(viaRest.body));
    assert.strictEqual(require('../core/post-types').postTypeExists('vault'), false, 'nothing is registered');
    const stored = await require('../core/options').getOption('custom_post_types', {});
    assert.ok(!stored || !Object.prototype.hasOwnProperty.call(stored, 'vault'), 'nothing is persisted');
});

test('the agent mapping hard-denies core names even if a type registry classified them as content', async () => {
    // A registry (old, hand-edited, or a future bug) that says `edit_users` is a draft capability.
    const forged = new Map<string, any>([['edit_users', 'draft'], ['manage_options', 'draft'], ['delete_users', 'publish'], ['edit_books', 'draft']]);
    const g = new Set(['content:read', 'content:draft', 'content:publish', 'content:others']);
    assert.strictEqual(agentPermitsCapability(g, 'edit_users', forged), false);
    assert.strictEqual(agentPermitsCapability(g, 'manage_options', forged), false);
    assert.strictEqual(agentPermitsCapability(g, 'delete_users', forged), false);
    assert.strictEqual(agentPermitsCapability(g, 'edit_books', forged), true, 'a real content capability still maps');
    const admin = await User.findById(U.admin);
    const n = narrowUser(admin, Array.from(g));
    for (const cap of ['edit_users', 'list_users', 'manage_options', 'activate_plugins', 'upload_files']) assert.strictEqual(n.can(cap), false, cap);
});

// ── 2–4. Publish confirmation, the queue, labelled revisions ──────────────────────────────────────

test('only an administrator changes the publish-confirmation setting or reads the queue', async () => {
    assert.strictEqual((await setConfirmation(true, 'editor')).status, 403);
    assert.strictEqual((await request(app).get('/api/v1/agents/publish-queue').set(as('editor'))).status, 403);
    assert.strictEqual((await request(app).delete('/api/v1/agents/publish-queue/1').set(as('editor'))).status, 403);
    const bad = await request(app).put('/api/v1/agents/settings').set(as('admin')).send({ publishConfirmation: 'yes' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(require('../core/plugin-api').isProtectedOption('agent_publish_confirmation'), true, 'no plugin can flip it');
});

test('confirmation ON: a steerable agent cannot put anything live, and a person publishes from the queue', async () => {
    _resetAgentRateLimits();
    assert.strictEqual((await setConfirmation(true)).status, 200);
    const listed = await request(app).get('/api/v1/agents').set(as('admin'));
    assert.strictEqual(listed.body.publishConfirmation, true);

    const { token } = await agentFor('editor', ['content:publish', 'content:others']);
    const client = await mcp(token);
    // The editor can publish, and so could this agent without the setting (see the next test).
    const created = parse(await client.callTool({ name: 'create_draft', arguments: { title: 'Steered', content: '<p>x</p>' } }));
    const id = created.created.id;
    const pub = parse(await client.callTool({ name: 'publish_content', arguments: { id } }));
    assert.strictEqual(pub.published, undefined, JSON.stringify(pub));
    assert.strictEqual(pub.awaitingConfirmation.status, 'pending');
    assert.strictEqual(await statusOf(id), 'pending', 'nothing went live');

    // Someone else's published post — reachable with content:others — cannot be edited while live.
    const live = await request(app).post('/api/v1/posts').set(as('writer')).send({ title: 'Writer live', status: 'publish' });
    assert.strictEqual(live.status, 201);
    const edit = await client.callTool({ name: 'update_draft', arguments: { id: live.body.id, title: 'Rewritten by text it read' } });
    assert.ok(edit.isError, 'editing live content needs a person while confirmation is on');
    assert.strictEqual((await dbAsync.get('SELECT post_title FROM posts WHERE id = ?', [live.body.id])).post_title, 'Writer live');
    await client.close();

    const queue = await request(app).get('/api/v1/agents/publish-queue').set(as('admin'));
    assert.strictEqual(queue.status, 200);
    const entry = queue.body.entries.find((e: any) => e.id === id);
    assert.ok(entry, JSON.stringify(queue.body));
    assert.strictEqual(entry.agentName, 'editor-bot');
    // The request marker is server-owned: the generic meta bag cannot plant or clear one.
    const forge = await request(app).put(`/api/v1/posts/${live.body.id}`).set(as('admin')).send({ meta: { _wjs_agent_publish_request: '{"agentId":1}' } });
    assert.ok(forge.status === 200 || forge.status === 400, `${forge.status}`);
    assert.ok(!(await dbAsync.get("SELECT 1 AS x FROM post_meta WHERE post_id = ? AND meta_key = '_wjs_agent_publish_request'", [live.body.id])));

    // A person publishes it with their own session, then dismisses the request.
    const approve = await request(app).put(`/api/v1/posts/${id}`).set(as('admin')).send({ status: 'publish' });
    assert.strictEqual(approve.status, 200);
    assert.strictEqual(await statusOf(id), 'publish');
    assert.strictEqual((await request(app).delete(`/api/v1/agents/publish-queue/${id}`).set(as('admin'))).body.dismissed, true);
    const after = await request(app).get('/api/v1/agents/publish-queue').set(as('admin'));
    assert.ok(!after.body.entries.some((e: any) => e.id === id));
    const audit = await dbAsync.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'agent.settings'");
    assert.ok(Number(audit.n) >= 1, 'turning the setting on is audited');
});

test('confirmation OFF: the same grant publishes directly — the setting is the only difference', async () => {
    _resetAgentRateLimits();
    assert.strictEqual((await setConfirmation(false)).status, 200);
    const { token } = await agentFor('editor', ['content:publish', 'content:others']);
    const client = await mcp(token);
    const created = parse(await client.callTool({ name: 'create_draft', arguments: { title: 'Direct' } }));
    const pub = parse(await client.callTool({ name: 'publish_content', arguments: { id: created.created.id } }));
    assert.ok(pub.published, JSON.stringify(pub));
    assert.strictEqual(await statusOf(created.created.id), 'publish');
    await client.close();
});

test('the revision an agent write leaves names the agent; restoring it undoes the change; the label is not writable', async () => {
    _resetAgentRateLimits();
    const own = await request(app).post('/api/v1/posts').set(as('editor')).send({ title: 'Before the agent', content: '<p>original</p>', status: 'draft' });
    assert.strictEqual(own.status, 201);
    const id = own.body.id;
    // A person's edit: its revision carries no agent label.
    assert.strictEqual((await request(app).put(`/api/v1/posts/${id}`).set(as('editor')).send({ title: 'Edited by a person' })).status, 200);

    const { token, connection } = await agentFor('editor', ['content:draft']);
    const client = await mcp(token);
    const upd = await client.callTool({ name: 'update_draft', arguments: { id, title: 'Changed by the agent', content: '<p>agent text</p>' } });
    assert.ok(!upd.isError, JSON.stringify(upd));
    await client.close();

    const list = await request(app).get(`/api/v1/revisions/post/${id}`).set(as('editor'));
    assert.strictEqual(list.status, 200);
    const [latest, ...older] = list.body.revisions;
    assert.deepStrictEqual(latest.source, { kind: 'agent', agentId: connection.id, agentName: 'editor-bot' });
    assert.strictEqual(latest.title, 'Edited by a person', 'it is the version from BEFORE the agent changed it');
    for (const r of older) assert.strictEqual(r.source, null, 'a person\'s revisions carry no agent label');

    const restored = await request(app).post(`/api/v1/revisions/${latest.id}/restore`).set(as('editor')).send({});
    assert.strictEqual(restored.status, 200, JSON.stringify(restored.body));
    const row = await dbAsync.get('SELECT post_title FROM posts WHERE id = ?', [id]);
    assert.strictEqual(row.post_title, 'Edited by a person', 'restoring the labelled revision undoes the agent change');
    assert.ok(!(await dbAsync.get("SELECT 1 AS x FROM post_meta WHERE post_id = ? AND meta_key = '_wjs_revision_source'", [id])), 'the label never lands on the entry');

    await request(app).put(`/api/v1/posts/${id}`).set(as('editor')).send({ meta: { _wjs_revision_source: '{"kind":"agent","agentId":9}' } });
    assert.ok(!(await dbAsync.get("SELECT 1 AS x FROM post_meta WHERE post_id = ? AND meta_key = '_wjs_revision_source'", [id])), 'the label is not writable through the meta bag');
});
