/**
 * OUTGOING WEBHOOK EVENT CATALOGUE SUITE
 *
 * webhooks.test.ts covers the delivery machinery (signing, retries, SSRF, CRUD). This suite covers WHAT
 * is delivered: one end-to-end delivery test per entity family of the catalogue in models/Webhook.ts —
 * posts, comments, users, media, terms, menus, plugins/themes, settings — each driven through the REAL
 * seam that announces it in production (the content hooks, or the route whose recordAudit call the
 * dispatcher observes), then pumped to a local receiver and checked for a valid signature. Plus the
 * opt-in rule for user.login, the admin's ping, and the payload-redaction contract: no password hash,
 * MFA secret, token, email address, private option or private-media URL ever leaves in a body.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

process.env.WORDJS_WEBHOOK_ALLOW_PRIVATE_TARGETS_UNSAFE = '1'; // deliver to the local receiver (see webhooks.test.ts)

const config = require('../config/app');
config.nodeEnv = 'test';
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_DB = path.join(os.tmpdir(), `wjs-webhook-events-${STAMP}.db`);
const TMP_UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-webhook-events-${STAMP}-`));
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
config.uploads.dir = TMP_UPLOADS;

const database = require('../config/database');
const roles = require('../core/roles');
const webhooks = require('../core/webhooks');
const payloads = require('../core/webhook-payloads');
const { doAction } = require('../core/hooks');
const { recordAudit } = require('../core/audit');
const Webhook = require('../models/Webhook');
const Comment = require('../models/Comment');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));

const U: Record<string, number> = {};
const tok = (login: string) => jwt.sign({ userId: U[login], username: login }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
const as = (login: string, m: string, p: string) =>
    (request(app) as any)[m](`/api/v1${p}`).set('Authorization', `Bearer ${tok(login)}`);

let dbAsync: any;
let server: any;
let port = 0;
let received: any[] = [];

const SECRET = 'whsec_' + 'e'.repeat(43);
const MFA_SEED = 'JBSWY3DPEHPK3PXPMFASEEDVALUE';
const PASS_HASH = '$2b$10$abcdefghijklmnopqrstuvHASHVALUEHASHVALUEHASHVALUE12';

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name, user_nicename) VALUES (?, ?, ?, ?, ?)`,
        [login, PASS_HASH, `${login}@private-mail.example`, login, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
    return r.lastID;
}

/** Make `events` the ONLY active subscription (pointing at the receiver) and clear the queue. */
async function subscribe(events: string): Promise<number> {
    await dbAsync.run('DELETE FROM webhook_deliveries');
    await dbAsync.run('UPDATE webhooks SET active = 0');
    const r = await dbAsync.run(
        `INSERT INTO webhooks (user_id, name, url, events, secret, secret_prefix, active, failure_count)
         VALUES (?, 'events', ?, ?, ?, ?, 1, 0) RETURNING id`,
        [U.admin, `http://127.0.0.1:${port}/hook`, events, SECRET, SECRET.slice(0, 14)]);
    received = [];
    return r.lastID;
}

/** Deliver everything queued and return the bodies, each signature verified on the way. */
async function delivered(): Promise<any[]> {
    await webhooks.pump();
    return received.map((r) => {
        const ts = r.headers['x-wordjs-timestamp'];
        const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${r.body}`).digest('hex');
        assert.strictEqual(r.headers['x-wordjs-signature-256'], expected, 'every delivery carries a valid signature');
        const body = JSON.parse(r.body);
        assert.strictEqual(r.headers['x-wordjs-event'], body.event, 'the event header names the body event');
        return body;
    });
}
const names = (bodies: any[]) => bodies.map((b) => b.event);

async function seedPost(status: string) {
    const r = await dbAsync.run(
        `INSERT INTO posts (author_id, post_title, post_status, post_type, post_name) VALUES (?, 'Lifecycle', ?, 'post', ?)`,
        [U.admin, status, 'wh-ev-' + Math.floor(Math.random() * 1e9)]);
    return r.lastID;
}
async function setStatus(id: number, status: string) {
    await dbAsync.run('UPDATE posts SET post_status = ? WHERE id = ?', [status, id]);
    await require('../core/cache').del(`post:id:${id}`); // Post.findById caches the row
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    await seedUser('admin', 'administrator');
    await seedUser('victim', 'subscriber');
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'mfa_secret', ?)`, [U.victim, MFA_SEED]);
    webhooks.registerListeners(); // poller stays OFF; pump() is driven explicitly

    server = http.createServer((req: any, res: any) => {
        let body = '';
        req.on('data', (c: any) => { body += c; });
        req.on('end', () => { received.push({ headers: req.headers, body }); res.statusCode = 200; res.end('ok'); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = server.address().port;
});

after(async () => {
    webhooks.unregisterListeners();
    try { await new Promise<void>((r) => server.close(() => r())); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
    try { fs.rmSync(TMP_UPLOADS, { recursive: true, force: true }); } catch { /* */ }
    delete process.env.WORDJS_WEBHOOK_ALLOW_PRIVATE_TARGETS_UNSAFE;
});

// ── The catalogue itself ─────────────────────────────────────────────────────────────────────────────
test('GET /webhooks/events lists every family, grouped, with user.login as opt-in', async () => {
    const res = await as('admin', 'get', '/webhooks/events');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.groups.map((g: any) => g.entity),
        ['post', 'comment', 'user', 'media', 'term', 'menu', 'plugin', 'theme', 'settings']);
    assert.deepStrictEqual(res.body.events, res.body.groups.flatMap((g: any) => g.events), 'flat list = groups in order');
    for (const e of ['post.trashed', 'post.restored', 'post.scheduled', 'post.unpublished', 'comment.approved',
        'comment.updated', 'comment.spam', 'user.created', 'user.updated', 'user.deleted', 'user.login',
        'media.uploaded', 'media.updated', 'media.deleted', 'term.created', 'term.updated', 'term.deleted',
        'menu.updated', 'plugin.activated', 'plugin.deactivated', 'plugin.installed', 'plugin.uninstalled',
        'theme.activated', 'settings.updated']) {
        assert.ok(res.body.events.includes(e), `catalogue includes ${e}`);
    }
    assert.deepStrictEqual(res.body.optIn, ['user.login']);
    assert.ok(!res.body.events.includes('ping'), 'ping is not subscribable');
});

test('wildcards: * and family.* match the family; an opt-in event matches only by exact name', () => {
    assert.ok(Webhook.eventMatches(['*'], 'media.uploaded'));
    assert.ok(Webhook.eventMatches(['post.*'], 'post.trashed'));
    assert.ok(!Webhook.eventMatches(['post.*'], 'comment.created'));
    assert.ok(!Webhook.eventMatches(['*'], 'user.login'), '* must not include an opt-in event');
    assert.ok(!Webhook.eventMatches(['user.*'], 'user.login'), 'user.* must not include an opt-in event');
    assert.ok(Webhook.eventMatches(['user.*', 'user.login'], 'user.login'));
    assert.deepStrictEqual(Webhook.normalizeEvents('settings.*, user.login'), ['settings.*', 'user.login']);
    assert.throws(() => Webhook.normalizeEvents('ping'), /No recognized events/, 'ping cannot be subscribed to');
});

// ── posts ────────────────────────────────────────────────────────────────────────────────────────────
test('posts: scheduled → published → unpublished → trashed → restored, each a signed delivery', async () => {
    await subscribe('post.*');
    const id = await seedPost('future');
    await doAction('wp_insert_post', id, { status: 'future' });
    await setStatus(id, 'publish');
    await doAction('post_updated', id, { status: 'publish' }, 'future');
    await setStatus(id, 'draft');
    await doAction('post_updated', id, { status: 'draft' }, 'publish');
    await setStatus(id, 'trash');
    await doAction('post_updated', id, { status: 'trash' }, 'draft');
    await setStatus(id, 'draft');
    await doAction('post_updated', id, { status: 'draft' }, 'trash');

    const bodies = await delivered();
    assert.deepStrictEqual(names(bodies), [
        'post.created', 'post.scheduled',
        'post.updated', 'post.published',
        'post.updated', 'post.unpublished',
        'post.trashed', 'post.deleted', // post.deleted kept for receivers written before post.trashed existed
        'post.updated', 'post.restored'
    ]);
    const unpublished = bodies.find((b) => b.event === 'post.unpublished');
    assert.strictEqual(unpublished.data.id, id);
    assert.strictEqual(unpublished.data.previousStatus, 'publish');
    assert.strictEqual(bodies.find((b) => b.event === 'post.trashed').data.previousStatus, 'draft');
});

// ── comments ─────────────────────────────────────────────────────────────────────────────────────────
test('comments: created, approved, updated, spam, trashed and deleted reach the endpoint', async () => {
    const postId = await seedPost('publish');
    await subscribe('comment.*');
    const c = await Comment.create({ postId, author: 'Ana', authorEmail: 'ana@private-mail.example', authorIp: '203.0.113.7', content: 'Hola' });
    const cid = c.commentId;
    assert.strictEqual((await as('admin', 'post', `/comments/${cid}/approve`)).status, 200);
    assert.strictEqual((await as('admin', 'put', `/comments/${cid}`).send({ content: 'Hola, editado' })).status, 200);
    assert.strictEqual((await as('admin', 'post', `/comments/${cid}/spam`)).status, 200);
    assert.strictEqual((await as('admin', 'delete', `/comments/${cid}`)).status, 200);
    assert.strictEqual((await as('admin', 'delete', `/comments/${cid}?force=true`)).status, 200);

    const bodies = await delivered();
    assert.deepStrictEqual(names(bodies),
        ['comment.created', 'comment.approved', 'comment.updated', 'comment.spam', 'comment.trashed', 'comment.deleted']);
    const approved = bodies[1];
    assert.strictEqual(approved.data.id, cid);
    assert.strictEqual(approved.data.previousStatus, '0');
    assert.strictEqual(approved.actor, U.admin, 'audit-derived events name the acting user');
    assert.strictEqual(bodies[2].data.content, 'Hola, editado');
});

// ── users ────────────────────────────────────────────────────────────────────────────────────────────
test('users: created, updated (one event per save, role included), deleted', async () => {
    await subscribe('user.*');
    const created = await as('admin', 'post', '/users').send({
        username: 'newbie', email: 'newbie@private-mail.example', password: 'Correct-Horse-Battery-9!', role: 'subscriber'
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const uid = created.body.id;
    assert.strictEqual((await as('admin', 'put', `/users/${uid}`).send({ displayName: 'Newbie Two' })).status, 200);
    assert.strictEqual((await as('admin', 'put', `/users/${uid}`).send({ role: 'editor' })).status, 200);
    assert.strictEqual((await as('admin', 'put', `/users/${uid}`).send({ role: 'author', displayName: 'N3' })).status, 200);
    assert.strictEqual((await as('admin', 'delete', `/users/${uid}`)).status, 200);

    const bodies = await delivered();
    assert.deepStrictEqual(names(bodies), ['user.created', 'user.updated', 'user.updated', 'user.updated', 'user.deleted']);
    assert.strictEqual(bodies[0].data.username, 'newbie');
    assert.deepStrictEqual(bodies[1].data.changed, ['displayName']);
    assert.deepStrictEqual(bodies[2].data.changed, ['role'], 'a role-only change is one user.updated');
    assert.strictEqual(bodies[2].data.role, 'editor');
    assert.deepStrictEqual(bodies[3].data.changed.sort(), ['displayName', 'role'], 'role + profile = still ONE event');
    assert.strictEqual(bodies[4].data.id, uid);
    assert.strictEqual(bodies[4].data.username, 'newbie');
});

test('user.login is opt-in: * and user.* never receive it, an exact subscription does', async () => {
    await subscribe('*,user.*');
    await recordAudit(U.victim, 'auth.login.success', 'user', U.victim, { ip: '203.0.113.9' });
    assert.deepStrictEqual(await delivered(), [], 'a wildcard subscription receives no sign-ins');

    await subscribe('user.login');
    await recordAudit(U.victim, 'auth.login.success', 'user', U.victim, { ip: '203.0.113.9' });
    const bodies = await delivered();
    assert.deepStrictEqual(names(bodies), ['user.login']);
    assert.strictEqual(bodies[0].data.id, U.victim);
    assert.ok(!JSON.stringify(bodies[0]).includes('203.0.113.9'), 'the sign-in IP is not sent');
});

// ── media ────────────────────────────────────────────────────────────────────────────────────────────
test('media: uploaded, updated and deleted through the media routes', async () => {
    const sharp = require('sharp');
    const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer();
    await subscribe('media.*');
    const up = await as('admin', 'post', '/media').attach('file', png, { filename: 'hook.png', contentType: 'image/png' });
    assert.strictEqual(up.status, 201, JSON.stringify(up.body));
    const mid = up.body.id;
    assert.strictEqual((await as('admin', 'put', `/media/${mid}`).send({ title: 'Renamed', alt: 'alt text' })).status, 200);
    assert.strictEqual((await as('admin', 'delete', `/media/${mid}`)).status, 200);

    const bodies = await delivered();
    assert.deepStrictEqual(names(bodies), ['media.uploaded', 'media.updated', 'media.deleted']);
    assert.strictEqual(bodies[0].data.id, mid);
    assert.strictEqual(bodies[0].data.mimeType, 'image/png');
    assert.strictEqual(bodies[0].data.width, 4);
    assert.match(bodies[0].data.url, /\/uploads\//);
    assert.strictEqual(bodies[1].data.title, 'Renamed');
    assert.deepStrictEqual(bodies[1].data.changed.sort(), ['alt', 'title']);
    assert.strictEqual(bodies[2].data.title, 'Renamed');
});

// ── terms ────────────────────────────────────────────────────────────────────────────────────────────
test('terms: created, updated and deleted for categories and tags', async () => {
    await subscribe('term.*');
    const cat = await as('admin', 'post', '/categories').send({ name: 'Noticias' });
    assert.strictEqual(cat.status, 201);
    assert.strictEqual((await as('admin', 'put', `/categories/${cat.body.id}`).send({ name: 'Noticias 2' })).status, 200);
    assert.strictEqual((await as('admin', 'delete', `/categories/${cat.body.id}`)).status, 200);
    const tag = await as('admin', 'post', '/tags').send({ name: 'eventos' });
    assert.strictEqual(tag.status, 201);

    const bodies = await delivered();
    assert.deepStrictEqual(names(bodies), ['term.created', 'term.updated', 'term.deleted', 'term.created']);
    assert.strictEqual(bodies[0].data.taxonomy, 'category');
    assert.strictEqual(bodies[1].data.name, 'Noticias 2');
    assert.strictEqual(bodies[2].data.id, cat.body.id);
    assert.strictEqual(bodies[3].data.taxonomy, 'post_tag');
});

// ── menus ────────────────────────────────────────────────────────────────────────────────────────────
test('menus: every menu change is one menu.updated naming what changed', async () => {
    await subscribe('menu.updated');
    const menu = await as('admin', 'post', '/menus').send({ name: 'Principal' });
    assert.strictEqual(menu.status, 201);
    const item = await as('admin', 'post', `/menus/${menu.body.id}/items`).send({ title: 'Inicio', url: '/' });
    assert.strictEqual(item.status, 201, JSON.stringify(item.body));
    assert.strictEqual((await as('admin', 'delete', `/menus/${menu.body.id}`)).status, 200);

    const bodies = await delivered();
    assert.deepStrictEqual(names(bodies), ['menu.updated', 'menu.updated', 'menu.updated']);
    assert.deepStrictEqual(bodies.map((b) => b.data.change), ['created', 'item_added', 'deleted']);
    assert.strictEqual(bodies[1].data.itemId, item.body.id);
    assert.strictEqual(bodies[2].data.name, 'Principal');
});

// ── plugins & themes ─────────────────────────────────────────────────────────────────────────────────
test('plugins and themes: install, activate, deactivate, uninstall, theme switch', async () => {
    await subscribe('plugin.*,theme.*');
    await recordAudit(U.admin, 'plugin.install', 'plugin', 'demo-plugin', { via: 'upload' });
    await recordAudit(U.admin, 'marketplace.install', 'plugin', 'broken-plugin', { ok: false, status: 400 });
    await recordAudit(U.admin, 'marketplace.install', 'plugin', 'shop', { ok: true, source: 'official', version: '1.2.0' });
    await doAction('activated_plugin', 'demo-plugin');
    await doAction('deactivated_plugin', 'demo-plugin');
    await recordAudit(U.admin, 'plugin.uninstall', 'plugin', 'demo-plugin', { dropData: false });
    await doAction('switch_theme', 'lumen', 'classic');

    const bodies = await delivered();
    assert.deepStrictEqual(names(bodies), ['plugin.installed', 'plugin.installed', 'plugin.activated',
        'plugin.deactivated', 'plugin.uninstalled', 'theme.activated'], 'a FAILED marketplace install announces nothing');
    assert.deepStrictEqual(bodies[0].data, { slug: 'demo-plugin', via: 'upload' });
    assert.deepStrictEqual(bodies[1].data, { slug: 'shop', via: 'marketplace', source: 'official', version: '1.2.0' });
    assert.deepStrictEqual(bodies[5].data, { slug: 'lumen', previous: 'classic' });
});

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────
test('settings: a save announces the key names it wrote, never their values', async () => {
    await subscribe('settings.updated');
    const res = await as('admin', 'put', '/settings').send({ blogname: 'Mi sitio secreto', blogdescription: 'Otra cosa' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const bodies = await delivered();
    assert.deepStrictEqual(names(bodies), ['settings.updated']);
    assert.deepStrictEqual(bodies[0].data.keys.sort(), ['blogdescription', 'blogname']);
    assert.ok(!JSON.stringify(bodies[0]).includes('Mi sitio secreto'), 'values are never sent');
});

// ── ping ─────────────────────────────────────────────────────────────────────────────────────────────
test('ping: the admin test delivery reaches exactly that endpoint, signed, and is logged', async () => {
    const id = await subscribe('comment.created'); // unrelated subscription: a ping ignores it
    const res = await as('admin', 'post', `/webhooks/${id}/ping`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.delivered, true);
    assert.strictEqual(res.body.delivery.event, 'ping');
    const bodies = await delivered(); // verifies the signature of what the receiver got
    assert.deepStrictEqual(names(bodies), ['ping']);
    assert.strictEqual(bodies[0].data.webhookId, id);
    assert.strictEqual(bodies[0].actor, U.admin);

    await dbAsync.run('UPDATE webhooks SET active = 0 WHERE id = ?', [id]);
    const paused = await as('admin', 'post', `/webhooks/${id}/ping`);
    assert.strictEqual(paused.status, 409);
    assert.strictEqual(paused.body.code, 'rest_webhook_inactive');
    assert.strictEqual((await as('admin', 'post', '/webhooks/999999/ping')).status, 404);
});

// ── redaction ────────────────────────────────────────────────────────────────────────────────────────
test('payload redaction: no hash, MFA secret, token, email, IP, private option or private URL in any body', async () => {
    await subscribe('*,user.login');
    const postId = await seedPost('publish');
    await Comment.create({ postId, author: 'Eve', authorEmail: 'eve@private-mail.example', authorIp: '198.51.100.23', agent: 'SecretAgent/1.0', content: 'x' });
    await recordAudit(U.admin, 'user.update', 'user', U.victim, { fields: ['displayName', 'password', 'mfa_secret', 'api_token'] });
    await recordAudit(U.victim, 'auth.login.success', 'user', U.victim, {});
    await recordAudit(U.admin, 'settings.update', 'settings', '', { keys: ['blogname', 'smtp_password', 'jwt_secret', 'stripe_api_key', 'active_plugins'] });
    const bodies = await delivered();
    assert.ok(bodies.length >= 4, `expected the comment, user and settings events, got ${names(bodies)}`);

    const wire = received.map((r) => r.body).join('\n');
    for (const leak of [PASS_HASH, MFA_SEED, 'private-mail.example', '198.51.100.23', 'SecretAgent', 'user_pass',
        'smtp_password', 'jwt_secret', 'stripe_api_key', 'active_plugins', SECRET]) {
        assert.ok(!wire.includes(leak), `a webhook body leaked ${leak}`);
    }
    const upd = bodies.find((b) => b.event === 'user.updated');
    assert.deepStrictEqual(upd.data.changed, ['displayName'], 'secret-looking field names are dropped');
    assert.deepStrictEqual(Object.keys(upd.data).sort(), ['changed', 'displayName', 'id', 'registered', 'role', 'slug', 'username']);
    assert.deepStrictEqual(bodies.find((b) => b.event === 'settings.updated').data.keys, ['blogname']);

    // The serializers are allowlists: an unexpected field on the source object never reaches a body.
    const u = payloads.userPayload({ id: 1, userLogin: 'a', userPass: PASS_HASH, userEmail: 'a@b.c', meta: { mfa_secret: MFA_SEED }, getRole: () => 'editor' });
    assert.deepStrictEqual(Object.keys(u).sort(), ['displayName', 'id', 'registered', 'role', 'slug', 'username']);
    const m = payloads.mediaPayload({ id: 2, visibility: 'private', guid: 'https://site/api/v1/media/2/file', title: 't' });
    assert.strictEqual(m.url, null, 'a private item never carries its URL');
});
