/**
 * POST /api/v1/plugins/:slug/pack — the admin screen's dev-mode "build & download ZIP".
 *
 * WHAT THIS LOCKS DOWN: the route exists ONLY in development (404 otherwise, and GET /plugins says
 * `packable: false` so the UI hides the button); it demands an admin, refuses traversal-shaped slugs,
 * and hands back exactly what `npm run pack:plugin` produces — or a 422 carrying the packer's refusal
 * reason, so the admin sees why instead of a generic failure.
 *
 * Same sandboxing as plugin-theme-install.test.ts: chdir into a temp root BEFORE anything loads
 * core/plugins (PLUGINS_DIR resolves from the CWD at module load).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-pack-route-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');
const AdmZip = require('adm-zip');

const PLUGINS_DIR = path.join(TMP_ROOT, 'plugins');
const ORIGINAL_ENV = config.nodeEnv;

function writePlugin(slug: string, manifest: object, indexJs: string) {
    const dir = path.join(PLUGINS_DIR, slug);
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'index.js'), indexJs);
    fs.writeFileSync(path.join(dir, 'data', 'secret.key'), 'never shipped');
}

/** supertest: collect a binary body into a Buffer. */
function binary(res: any, cb: (err: Error | null, body: Buffer) => void) {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
}

describe('POST /api/v1/plugins/:slug/pack (dev-mode build & download)', () => {
    let request: any;
    let app: any;
    let adminToken: string;
    let subscriberToken: string;

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        const dbAsync = database.getDbAsync();
        await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`, ['admin', 'x', 'admin@example.com', 'Administrator']);
        await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`, ['subscriber', 'x', 'sub@example.com', 'Subscriber']);
        const admin = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'admin'`);
        const sub = await dbAsync.get(`SELECT id FROM users WHERE user_login = 'subscriber'`);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [admin.id]);
        adminToken = jwt.sign({ userId: admin.id, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
        subscriberToken = jwt.sign({ userId: sub.id, username: 'subscriber' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

        writePlugin('good', { name: 'Good', version: '2.0.1', isolated: true, permissions: [] }, 'module.exports = { init() {} };\n');
        writePlugin('needs-dep', { name: 'Needs Dep', version: '1.0.0', isolated: true }, "require('not-declared-anywhere');\n");

        const express = require('express');
        const { errorHandler } = require('../middleware/errorHandler');
        app = express();
        app.use(express.json());
        app.use('/api/v1/plugins', require('../routes/plugins'));
        app.use(errorHandler);
    });

    after(async () => {
        config.nodeEnv = ORIGINAL_ENV;
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try { process.chdir(os.tmpdir()); fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('does not exist outside development (404), and GET /plugins says packable: false', async () => {
        config.nodeEnv = 'production';
        const res = await request(app).post('/api/v1/plugins/good/pack').set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(res.status, 404);
        const list = await request(app).get('/api/v1/plugins').set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(list.status, 200);
        const good = list.body.find((p: any) => p.slug === 'good');
        assert.strictEqual(good.packable, false);
    });

    it('demands an admin and a well-formed, installed slug', async () => {
        config.nodeEnv = 'development';
        assert.strictEqual((await request(app).post('/api/v1/plugins/good/pack')).status, 401);
        assert.strictEqual((await request(app).post('/api/v1/plugins/good/pack').set('Authorization', `Bearer ${subscriberToken}`)).status, 403);
        assert.strictEqual((await request(app).post('/api/v1/plugins/..%2f..%2fdata/pack').set('Authorization', `Bearer ${adminToken}`)).status, 400);
        assert.strictEqual((await request(app).post('/api/v1/plugins/missing/pack').set('Authorization', `Bearer ${adminToken}`)).status, 404);
    });

    it('in development, GET /plugins advertises packable and the route returns the packed ZIP', async () => {
        config.nodeEnv = 'development';
        const list = await request(app).get('/api/v1/plugins').set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(list.body.find((p: any) => p.slug === 'good').packable, true);

        const res = await request(app).post('/api/v1/plugins/good/pack').set('Authorization', `Bearer ${adminToken}`)
            .buffer(true).parse(binary);
        assert.strictEqual(res.status, 200, String(res.body));
        assert.strictEqual(res.headers['content-type'], 'application/zip');
        assert.match(res.headers['content-disposition'], /filename="good-2\.0\.1\.zip"/);
        const names = new AdmZip(res.body).getEntries().map((e: any) => e.entryName).sort();
        assert.deepStrictEqual(names, ['good/index.js', 'good/manifest.json']);
    });

    it('returns the packer\'s refusal reason as a 422', async () => {
        config.nodeEnv = 'development';
        const res = await request(app).post('/api/v1/plugins/needs-dep/pack').set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(res.status, 422);
        assert.match(res.body.error, /requires 'not-declared-anywhere', which is not declared/);
        assert.ok(typeof res.body.details?.log === 'string' && res.body.details.log.length > 0);
    });
});
