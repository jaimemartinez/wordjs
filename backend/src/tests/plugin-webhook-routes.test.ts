/**
 * PLUGIN WEBHOOK ROUTES (core/plugin-webhooks) and the HMAC bridge (wordjs.crypto.hmac / timingSafeEqual).
 *
 * A signed server-to-server webhook used to be impossible for a sandboxed plugin: the CSRF gate refused
 * a POST with no Origin/Referer, express.json had already consumed the bytes the sender signed, and the
 * isolate had no keyed hash. A `{ webhook: true }` route now gets the raw body and the signature headers,
 * passes the CSRF gate — and, so that exemption grants nothing, never carries an identity: no user, no
 * cookies, and it cannot be combined with `auth`/`admin`.
 *
 * Boots a REAL isolate whose handler verifies an HMAC-SHA256 signature through the bridge, behind the
 * same middleware order index.ts uses (CSRF gate → express.json with the raw-body hook).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-webhook-routes-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { loadIsolatedPlugin, unloadIsolatedPlugin } = require('../core/plugin-isolate');
const { setApp } = require('../core/appRegistry');
const { csrfProtection } = require('../middleware/auth');
const webhooks = require('../core/plugin-webhooks');
const { createPluginApi } = require('../core/plugin-api');

const PLUGINS_ROOT = path.resolve(__dirname, '../../plugins');
const SLUG = 'wjs-webhook-probe';
const SECRET = 'whsec_probe';
const app = express();
app.use(cookieParser());
app.use('/api/v1', csrfProtection);
app.use(express.json({ limit: '10mb', verify: webhooks.captureWebhookRawBody }));

const INIT = String.raw`
  wordjs.http.route('post', '/hook', { webhook: true }, async (req, res) => {
    const sig = req.headers['x-probe-signature'] || '';
    const expected = await wordjs.crypto.hmac('sha256', '${SECRET}', req.rawBody || '');
    const valid = await wordjs.crypto.timingSafeEqual(sig, expected);
    res.status(valid ? 200 : 400).json({ valid, rawBody: req.rawBody, user: req.user, cookies: req.cookies, headers: req.headers, parsed: req.body });
  });
  // Refused by the host: a webhook never authenticates, and is POST only.
  wordjs.http.route('post', '/hook-auth', { webhook: true, auth: true }, (req, res) => res.json({ reached: true }));
  wordjs.http.route('get', '/hook-get', { webhook: true }, (req, res) => res.json({ reached: true }));
  // An ordinary POST keeps the CSRF gate.
  wordjs.http.route('post', '/plain', (req, res) => res.json({ reached: true }));
`;

let dir = '';
before(async () => {
    setApp(app);
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dir = path.join(PLUGINS_ROOT, SLUG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: SLUG, isolated: true, permissions: [{ scope: 'express', access: 'register_route' }] }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'exports.init = function (wordjs) {\n' + INIT + '\n};\n');
    require('../core/plugin-permissions')._setGrantsInMemory(SLUG, ['express:register_route']);
    await loadIsolatedPlugin(SLUG, path.join(dir, 'index.js'));
    await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
    try { await unloadIsolatedPlugin(SLUG); } catch { /* */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    try { await database.closeDatabase(); } catch { /* */ }
    try { fs.rmSync(TMP_DB, { force: true }); } catch { /* */ }
});

const hookUrl = `/api/v1/plugin/${SLUG}/hook`;
const sign = (body: string) => crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');

describe('a { webhook: true } route', () => {
    test('a header-less server POST passes the CSRF gate, gets the EXACT body it was signed over, and verifies', async () => {
        // Key order and whitespace a JSON re-serialisation would not reproduce.
        const body = '{ "b": 1,  "a": [1, 2], "id": "evt_1" }';
        const res = await (request(app) as any).post(hookUrl)
            .set('Content-Type', 'application/json')
            .set('X-Probe-Signature', sign(body))
            .send(body);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.valid, true);
        assert.strictEqual(res.body.rawBody, body, 'byte-exact raw body');
        assert.deepStrictEqual(res.body.parsed, { b: 1, a: [1, 2], id: 'evt_1' }, 'the parsed body is still there');
    });

    test('a wrong signature is the handler\'s to refuse', async () => {
        const res = await (request(app) as any).post(hookUrl).set('Content-Type', 'application/json').set('X-Probe-Signature', sign('{}')).send('{"x":1}');
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.valid, false);
    });

    test('no identity reaches it: no user, no cookies, only signature-ish headers', async () => {
        const body = '{"id":"evt_2"}';
        const res = await (request(app) as any).post(hookUrl)
            .set('Content-Type', 'application/json')
            .set('X-Probe-Signature', sign(body))
            .set('Cookie', 'wordjs_token=forged; wjs_csrf=abc; other=1')
            .set('Authorization', 'Bearer something')
            .set('X-Portal-Token', 'p')
            .send(body);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.user, null);
        assert.deepStrictEqual(res.body.cookies, {});
        assert.deepStrictEqual(Object.keys(res.body.headers).sort(), ['content-type', 'x-probe-signature']);
    });

    test('webhook + auth, and a non-POST webhook, are not mounted; an ordinary POST keeps the CSRF gate', async () => {
        assert.strictEqual((await (request(app) as any).post(`/api/v1/plugin/${SLUG}/hook-auth`).send({})).status, 403,
            'not mounted, so not exempt: the CSRF gate answers first');
        assert.strictEqual((await (request(app) as any).get(`/api/v1/plugin/${SLUG}/hook-get`)).status, 404);
        assert.strictEqual((await (request(app) as any).post(`/api/v1/plugin/${SLUG}/plain`).send({})).status, 403);
        assert.ok(!webhooks.isWebhookRequest({ method: 'POST', originalUrl: `/api/v1/plugin/${SLUG}/hook-auth` }));
        assert.ok(!webhooks.isWebhookRequest({ method: 'GET', originalUrl: hookUrl }), 'only POST is a webhook');
        assert.ok(webhooks.isWebhookRequest({ method: 'POST', originalUrl: `${hookUrl}?x=1` }), 'the query does not matter');
    });

    test('only webhook requests keep a raw body', async () => {
        const req: any = { method: 'POST', originalUrl: `/api/v1/plugin/${SLUG}/plain` };
        webhooks.captureWebhookRawBody(req, null, Buffer.from('{"a":1}'));
        assert.strictEqual(req.rawBody, undefined);
    });

    test('unloading the plugin withdraws the exemption', async () => {
        await unloadIsolatedPlugin(SLUG);
        assert.ok(!webhooks.isWebhookRequest({ method: 'POST', originalUrl: hookUrl }));
        assert.strictEqual((await (request(app) as any).post(hookUrl).send({})).status, 403);
    });
});

describe('wordjs.crypto.hmac / timingSafeEqual', () => {
    const api = createPluginApi('wjs-hmac-probe');

    test('matches node\'s HMAC for every allowed digest and both encodings', () => {
        for (const algo of ['sha256', 'sha1', 'sha512']) {
            assert.strictEqual(api.crypto.hmac(algo, 'k', 'données'), crypto.createHmac(algo, 'k').update('données', 'utf8').digest('hex'));
        }
        assert.strictEqual(api.crypto.hmac('sha256', 'k', 'x', 'base64'), crypto.createHmac('sha256', 'k').update('x').digest('base64'));
    });

    test('refuses other digests, empty keys and oversized input', () => {
        assert.throws(() => api.crypto.hmac('md5', 'k', 'x'), /unsupported algorithm/);
        assert.throws(() => api.crypto.hmac('sha256', '', 'x'), /invalid key/);
        assert.throws(() => api.crypto.hmac('sha256', 'k', 'x'.repeat(2 * 1024 * 1024 + 1)), /invalid data/);
        assert.throws(() => api.crypto.hmac('sha256', 'k', { toString: () => 'x' }), /invalid data/);
    });

    test('timingSafeEqual compares strings of any length without throwing', () => {
        assert.strictEqual(api.crypto.timingSafeEqual('abc', 'abc'), true);
        assert.strictEqual(api.crypto.timingSafeEqual('abc', 'abd'), false);
        assert.strictEqual(api.crypto.timingSafeEqual('abc', 'abcd'), false);
        assert.strictEqual(api.crypto.timingSafeEqual('abc', 42), false);
    });
});
