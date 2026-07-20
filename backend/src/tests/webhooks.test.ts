/**
 * OUTGOING WEBHOOKS SUITE
 *
 * Covers the full vertical: crypto (reversible secret + HMAC), the admin CRUD routes (authz + sessionOnly
 * hardening), the content-hook → delivery wiring, an end-to-end signed delivery to a local receiver, the
 * retry/dead-letter state machine, and — most importantly — that delivery is SSRF-safe (a loopback target
 * is blocked at delivery time when the test seam is off).
 *
 * The env seam WORDJS_WEBHOOK_ALLOW_LOOPBACK=1 lets the delivery path reach the local 127.0.0.1 receiver;
 * it is env-only (never a persisted config), off in production. The SSRF test flips it off to prove the
 * validatingLookup pin actually blocks a private target.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

process.env.WORDJS_WEBHOOK_ALLOW_PRIVATE_TARGETS_UNSAFE = '1'; // allow delivery to the local receiver (see file header)

const config = require('../config/app');
config.nodeEnv = 'test'; // the seam requires a non-production env in addition to the flag
const TMP_DB = path.join(os.tmpdir(), `wjs-webhooks-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const { csrfProtection } = require('../middleware/auth');
const cryptoUtils = require('../core/crypto-utils');
const webhooks = require('../core/webhooks');
const { doAction } = require('../core/hooks');
const Webhook = require('../models/Webhook');
const WebhookDelivery = require('../models/WebhookDelivery');
const ApiToken = require('../models/ApiToken');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const SECRET = config.jwt.secret;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(csrfProtection);
app.use('/api/v1', require('../routes'));

const U: Record<string, number> = {};
const jwtFor = (p: string) => jwt.sign({ userId: U[p], username: p }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });

let dbAsync: any;
let server: any;
let port = 0;
let received: any[] = [];
let nextStatus = 200;

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
    return r.lastID;
}

// Insert a webhook row directly so a test can target the loopback receiver (Webhook.create would reject a
// 127.0.0.1 literal at validation time — which is itself asserted in a dedicated test).
async function insertWebhook(opts: { url: string; events?: string; secret?: string; active?: number }) {
    const secret = opts.secret || 'whsec_' + 'x'.repeat(43);
    const r = await dbAsync.run(
        `INSERT INTO webhooks (user_id, name, url, events, secret_enc, secret_prefix, active, failure_count)
         VALUES (?, 'test', ?, ?, ?, ?, ?, 0) RETURNING id`,
        [U.admin, opts.url, opts.events || '*', cryptoUtils.encryptSecret(secret), secret.slice(0, 14), opts.active == null ? 1 : opts.active]);
    return { id: r.lastID, secret };
}

// Isolate a pump()-based test: drop any deliveries queued by earlier tests and deactivate all existing
// webhooks so only the endpoint THIS test inserts (active) can be delivered to.
async function resetDeliveries() {
    await dbAsync.run('DELETE FROM webhook_deliveries');
    await dbAsync.run('UPDATE webhooks SET active = 0');
}

async function seedPost(status: string, type = 'post') {
    const r = await dbAsync.run(
        `INSERT INTO posts (author_id, post_title, post_status, post_type, post_name) VALUES (?, 'Hello', ?, ?, ?)`,
        [U.admin, status, type, 'wh-post-' + Math.floor(Math.random() * 1e9)]);
    return r.lastID;
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    await seedUser('admin', 'administrator');
    await seedUser('subscriber', 'subscriber');

    webhooks.registerListeners(); // wire the dispatcher; poller stays OFF (we drive pump() explicitly)

    received = [];
    server = http.createServer((req: any, res: any) => {
        let body = '';
        req.on('data', (c: any) => { body += c; });
        req.on('end', () => {
            received.push({ method: req.method, url: req.url, headers: req.headers, body });
            res.statusCode = nextStatus;
            res.end('ok');
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = server.address().port;
});

after(async () => {
    webhooks.unregisterListeners();
    try { await new Promise<void>((r) => server.close(() => r())); } catch { /* */ }
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    try { fs.rmSync(TMP_DB, { force: true }); fs.rmSync(TMP_DB + '-wal', { force: true }); fs.rmSync(TMP_DB + '-shm', { force: true }); } catch { /* */ }
    delete process.env.WORDJS_WEBHOOK_ALLOW_PRIVATE_TARGETS_UNSAFE;
});

// ── crypto ───────────────────────────────────────────────────────────────────────────────────────
test('crypto-utils: secret encrypts reversibly and a tampered envelope fails', () => {
    const secret = 'whsec_topsecret';
    const env = cryptoUtils.encryptSecret(secret);
    assert.ok(env.startsWith('enc:v1:'));
    assert.ok(!env.includes(secret), 'ciphertext must not contain the plaintext');
    assert.strictEqual(cryptoUtils.decryptSecret(env), secret);
    // flip a byte in the ciphertext → GCM auth tag rejects it
    const parts = env.split(':');
    parts[4] = Buffer.from('different-ciphertext').toString('base64');
    assert.throws(() => cryptoUtils.decryptSecret(parts.join(':')));
});

test('signPayload = sha256=<HMAC of `timestamp.body`>', () => {
    const crypto = require('crypto');
    const secret = 'whsec_abc';
    const sig = webhooks.signPayload(secret, 1700000000, '{"a":1}');
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update('1700000000.{"a":1}').digest('hex');
    assert.strictEqual(sig, expected);
});

// ── CRUD routes + authz ────────────────────────────────────────────────────────────────────────────
test('admin can create a webhook; the signing secret is returned once and never listed', async () => {
    const res = await request(app).post('/api/v1/webhooks').set('Authorization', `Bearer ${jwtFor('admin')}`)
        .send({ name: 'CI rebuild', url: 'https://example.com/hook', events: 'post.published' });
    assert.strictEqual(res.status, 201);
    assert.match(res.body.secret, /^whsec_/);
    assert.strictEqual(res.body.secretPrefix, res.body.secret.slice(0, 14));
    assert.deepStrictEqual(res.body.events, ['post.published']);
    // list never exposes the secret or its ciphertext
    const list = await request(app).get('/api/v1/webhooks').set('Authorization', `Bearer ${jwtFor('admin')}`);
    assert.strictEqual(list.status, 200);
    for (const w of list.body.webhooks) {
        assert.ok(!('secret' in w) && !('secret_enc' in w) && !('secretEnc' in w));
        assert.ok(typeof w.secretPrefix === 'string');
    }
});

test('create rejects non-http(s) schemes and internal IP-literal targets', async () => {
    for (const url of ['ftp://example.com/x', 'http://127.0.0.1/x', 'http://169.254.169.254/latest', 'https://[::1]/x']) {
        const res = await request(app).post('/api/v1/webhooks').set('Authorization', `Bearer ${jwtFor('admin')}`)
            .send({ url });
        assert.strictEqual(res.status, 400, `expected 400 for ${url}, got ${res.status}`);
    }
});

test('events fail CLOSED: a non-empty but unrecognized events list is rejected (not silently broadened to *)', async () => {
    const res = await request(app).post('/api/v1/webhooks').set('Authorization', `Bearer ${jwtFor('admin')}`)
        .send({ url: 'https://example.com/typo', events: ['post.publised'] }); // typo
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'rest_invalid_webhook');
});

test('update, rotate-secret, and delete work; rotate returns a NEW secret', async () => {
    const create = await request(app).post('/api/v1/webhooks').set('Authorization', `Bearer ${jwtFor('admin')}`)
        .send({ url: 'https://example.com/a', events: '*' });
    const id = create.body.id;
    const firstSecret = create.body.secret;

    const upd = await request(app).patch(`/api/v1/webhooks/${id}`).set('Authorization', `Bearer ${jwtFor('admin')}`)
        .send({ name: 'renamed', active: false, events: 'comment.created' });
    assert.strictEqual(upd.status, 200);
    assert.strictEqual(upd.body.name, 'renamed');
    assert.strictEqual(upd.body.active, false);
    assert.deepStrictEqual(upd.body.events, ['comment.created']);

    const rot = await request(app).post(`/api/v1/webhooks/${id}/rotate-secret`).set('Authorization', `Bearer ${jwtFor('admin')}`);
    assert.strictEqual(rot.status, 200);
    assert.match(rot.body.secret, /^whsec_/);
    assert.notStrictEqual(rot.body.secret, firstSecret);

    const del = await request(app).delete(`/api/v1/webhooks/${id}`).set('Authorization', `Bearer ${jwtFor('admin')}`);
    assert.strictEqual(del.status, 200);
    const gone = await request(app).get(`/api/v1/webhooks/${id}`).set('Authorization', `Bearer ${jwtFor('admin')}`);
    assert.strictEqual(gone.status, 404);
});

test('webhooks are administrator-only (subscriber 403, anon 401)', async () => {
    const anon = await request(app).get('/api/v1/webhooks');
    assert.strictEqual(anon.status, 401);
    const sub = await request(app).get('/api/v1/webhooks').set('Authorization', `Bearer ${jwtFor('subscriber')}`);
    assert.strictEqual(sub.status, 403);
});

test('an API token cannot manage webhooks (sessionOnly hardening)', async () => {
    const { token } = await ApiToken.generate({ userId: U.admin, name: 'wh', scopes: 'write' });
    const res = await request(app).post('/api/v1/webhooks').set('Authorization', `Bearer ${token}`)
        .send({ url: 'https://example.com/x' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'rest_token_management_forbidden');
});

// ── dispatcher wiring ──────────────────────────────────────────────────────────────────────────────
test('a content hook enqueues deliveries for matching webhooks (post.created + post.published)', async () => {
    const { id } = await insertWebhook({ url: 'https://example.com/sink', events: 'post.*' });
    const postId = await seedPost('publish');
    await doAction('wp_insert_post', postId, { status: 'publish' });
    const rows = await WebhookDelivery.listForWebhook(id, 50);
    const events = rows.map((r: any) => r.event).sort();
    assert.deepStrictEqual(events, ['post.created', 'post.published']);
});

test('event subscription filters: a comment-only webhook gets no post events', async () => {
    const { id } = await insertWebhook({ url: 'https://example.com/comments', events: 'comment.created' });
    const postId = await seedPost('publish');
    await doAction('wp_insert_post', postId, { status: 'publish' });
    const rows = await WebhookDelivery.listForWebhook(id, 50);
    assert.strictEqual(rows.length, 0, 'comment-only webhook must not receive post events');
});

test('internal post types (revision/attachment) never emit webhooks', async () => {
    const { id } = await insertWebhook({ url: 'https://example.com/x', events: '*' });
    const revId = await seedPost('inherit', 'revision');
    await doAction('wp_insert_post', revId, { status: 'inherit' });
    const rows = await WebhookDelivery.listForWebhook(id, 50);
    assert.strictEqual(rows.length, 0);
});

test('post.published fires only on a real transition (not on re-saving an already-published post)', async () => {
    const { id } = await insertWebhook({ url: 'https://example.com/pub', events: 'post.*' });
    const postId = await seedPost('publish');
    // Re-save of an already-published post (prev=publish, now=publish) → update only, NO re-publish.
    await doAction('post_updated', postId, { status: 'publish', title: 'edit' }, 'publish');
    let events = (await WebhookDelivery.listForWebhook(id, 50)).map((r: any) => r.event);
    assert.deepStrictEqual(events, ['post.updated']);
    // A genuine draft→publish transition (prev=draft) DOES emit post.published.
    const postId2 = await seedPost('publish');
    const { id: id2 } = await insertWebhook({ url: 'https://example.com/pub2', events: 'post.*' });
    await doAction('post_updated', postId2, { status: 'publish' }, 'draft');
    events = (await WebhookDelivery.listForWebhook(id2, 50)).map((r: any) => r.event).sort();
    assert.deepStrictEqual(events, ['post.published', 'post.updated']);
});

test('trash transition emits post.deleted once; re-trash and hard-delete-of-trash do not double it', async () => {
    const { id } = await insertWebhook({ url: 'https://example.com/del', events: 'post.deleted' });
    const postId = await seedPost('trash');
    await doAction('post_updated', postId, { status: 'trash' }, 'publish'); // publish→trash: one post.deleted
    await doAction('post_updated', postId, { status: 'trash' }, 'trash');   // already trash: nothing
    await doAction('deleted_post', postId, 'trash');                        // empty-trash of a trashed post: nothing
    const rows = await WebhookDelivery.listForWebhook(id, 50);
    assert.strictEqual(rows.length, 1, 'exactly one post.deleted across the trash→empty lifecycle');
    assert.strictEqual(rows[0].event, 'post.deleted');
});

// ── end-to-end delivery ────────────────────────────────────────────────────────────────────────────
test('delivers a correctly-signed POST to the receiver and marks the delivery success', async () => {
    received = []; nextStatus = 200;
    await resetDeliveries();
    const { id, secret } = await insertWebhook({ url: `http://127.0.0.1:${port}/hook`, events: 'post.published' });
    await webhooks.fanout('post.published', { id: 42, type: 'post', status: 'publish' });
    await webhooks.pump();

    assert.strictEqual(received.length, 1, 'receiver got exactly one delivery');
    const got = received[0];
    assert.strictEqual(got.method, 'POST');
    assert.strictEqual(got.headers['x-wordjs-event'], 'post.published');
    assert.ok(got.headers['x-wordjs-delivery']);
    // verify the signature exactly the way a receiver would
    const ts = Number(got.headers['x-wordjs-timestamp']);
    const expected = webhooks.signPayload(secret, ts, got.body);
    assert.strictEqual(got.headers['x-wordjs-signature-256'], expected);
    const parsed = JSON.parse(got.body);
    assert.strictEqual(parsed.event, 'post.published');
    assert.strictEqual(parsed.data.id, 42);

    const rows = await WebhookDelivery.listForWebhook(id, 10);
    assert.strictEqual(rows[0].status, 'success');
    assert.strictEqual(rows[0].responseStatus, 200);
});

test('a 5xx response reschedules with backoff; exhausting attempts dead-letters', async () => {
    received = []; nextStatus = 500;
    await resetDeliveries();
    const { id } = await insertWebhook({ url: `http://127.0.0.1:${port}/fail`, events: 'post.created' });
    await webhooks.fanout('post.created', { id: 7 });
    await webhooks.pump();

    let d = (await WebhookDelivery.listForWebhook(id, 5))[0];
    assert.strictEqual(d.status, 'pending', 'a 5xx keeps the delivery pending for retry');
    assert.strictEqual(d.attempts, 1);
    assert.strictEqual(d.responseStatus, 500);
    assert.ok(d.nextAttemptAt > Math.floor(Date.now() / 1000), 'next attempt is in the future (backoff)');

    // Force it to the last attempt and make it due, then pump → dead.
    await dbAsync.run('UPDATE webhook_deliveries SET attempts = ?, next_attempt_at = ? WHERE id = ?',
        [webhooks.MAX_ATTEMPTS - 1, Math.floor(Date.now() / 1000), d.id]);
    await webhooks.pump();
    d = await WebhookDelivery.get(d.id);
    assert.strictEqual(d.status, 'dead');
});

test('a paused webhook does not deliver queued payloads (delivery dead-lettered as inactive)', async () => {
    received = []; nextStatus = 200;
    await resetDeliveries();
    const { id } = await insertWebhook({ url: `http://127.0.0.1:${port}/paused`, events: 'post.created', active: 0 });
    // enqueue directly (activeIdsForEvent skips inactive, so fanout wouldn't; we still must not deliver a
    // delivery that was queued before the pause).
    const did = await WebhookDelivery.enqueue(id, 'post.created', JSON.stringify({ event: 'post.created', data: { id: 1 } }), Math.floor(Date.now() / 1000));
    await webhooks.pump();
    assert.strictEqual(received.length, 0, 'a paused endpoint must not be reached');
    const d = await WebhookDelivery.get(did);
    assert.strictEqual(d.status, 'dead');
    assert.match(d.error || '', /inactive/i);
});

test('redeliver only re-queues TERMINAL deliveries (a pending/in-flight one is not resettable)', async () => {
    received = []; nextStatus = 200;
    await resetDeliveries();
    const { id } = await insertWebhook({ url: `http://127.0.0.1:${port}/rd`, events: 'post.created' });
    const did = await WebhookDelivery.enqueue(id, 'post.created', JSON.stringify({ event: 'post.created', data: {} }), Math.floor(Date.now() / 1000));
    // pending → redeliver is a no-op (404)
    const pend = await request(app).post(`/api/v1/webhooks/deliveries/${did}/redeliver`).set('Authorization', `Bearer ${jwtFor('admin')}`);
    assert.strictEqual(pend.status, 404);
    // deliver it to success, then redeliver succeeds
    await webhooks.pump();
    assert.strictEqual((await WebhookDelivery.get(did)).status, 'success');
    const ok = await request(app).post(`/api/v1/webhooks/deliveries/${did}/redeliver`).set('Authorization', `Bearer ${jwtFor('admin')}`);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await WebhookDelivery.get(did)).status, 'pending');
});

// ── SSRF at delivery time ──────────────────────────────────────────────────────────────────────────
test('with the loopback seam OFF, delivery to a private target is blocked (SSRF pin)', async () => {
    await resetDeliveries();
    const { id } = await insertWebhook({ url: `http://127.0.0.1:${port}/ssrf`, events: 'post.created' });
    await webhooks.fanout('post.created', { id: 99 });
    const saved = process.env.WORDJS_WEBHOOK_ALLOW_PRIVATE_TARGETS_UNSAFE;
    delete process.env.WORDJS_WEBHOOK_ALLOW_PRIVATE_TARGETS_UNSAFE; // enforce the SSRF guard
    try {
        received = [];
        await webhooks.pump();
    } finally {
        process.env.WORDJS_WEBHOOK_ALLOW_PRIVATE_TARGETS_UNSAFE = saved;
    }
    assert.strictEqual(received.length, 0, 'the receiver must NOT have been reached');
    const d = (await WebhookDelivery.listForWebhook(id, 5))[0];
    assert.notStrictEqual(d.status, 'success');
    assert.ok(/block/i.test(d.error || ''), `expected an SSRF block error, got: ${d.error}`);
});
