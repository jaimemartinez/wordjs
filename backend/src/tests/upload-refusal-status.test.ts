/**
 * UPLOAD REFUSALS ARE CLIENT ERRORS — not 500s.
 *
 * Multer passes a fileFilter's error, and its own limit errors, straight to `next(err)`. A plain
 * `new Error(...)` carries no `status`, so the error handler (rightly) treated it as an unexpected
 * failure: an SVG from a non-administrator, a .exe in the media library, a non-zip "plugin" or an
 * oversized file all answered 500 `rest_internal_error` with the reason thrown away. Drives the REAL
 * routers + the REAL error handler and pins the status and stable code of each refusal, plus the
 * control that an administrator's SVG and an ordinary PNG still upload.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-upload-refusal-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const TMP_UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-upload-refusal-'));
config.uploads.dir = TMP_UPLOADS;
// Small enough to trip multer's LIMIT_FILE_SIZE with a test buffer; read when routes/media.ts loads.
config.uploads.maxFileSize = 64 * 1024;
const database = require('../config/database');
const roles = require('../core/roles');
const { errorHandler } = require('../middleware/errorHandler');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));
app.use(errorHandler);

const U: Record<string, number> = {};
let dbAsync: any;
const as = (persona: string) => ({ Authorization: `Bearer ${jwt.sign({ userId: U[persona], username: persona }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}` });

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`, [login, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    await seedUser('admin', 'administrator');
    await seedUser('editor', 'editor');
});

after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    try { fs.rmSync(TMP_DB, { force: true }); fs.rmSync(TMP_DB + '-wal', { force: true }); fs.rmSync(TMP_DB + '-shm', { force: true }); } catch { /* */ }
    try { fs.rmSync(TMP_UPLOADS, { recursive: true, force: true }); } catch { /* */ }
});

const upload = (persona: string, route: string, field: string, buf: Buffer, filename: string, contentType: string) =>
    request(app).post(`/api/v1${route}`).set(as(persona)).attach(field, buf, { filename, contentType });

test('media: an SVG from a non-administrator is a 403 with a stable code, not a 500', async () => {
    const res = await upload('editor', '/media', 'file', SVG, 'logo.svg', 'image/svg+xml');
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_upload_svg_forbidden');
    assert.match(res.body.message, /administrators only/);
});

test('media: a type the library does not take is a 415', async () => {
    const exe = await upload('admin', '/media', 'file', Buffer.from('MZ'), 'setup.exe', 'application/octet-stream');
    assert.strictEqual(exe.status, 415, JSON.stringify(exe.body));
    assert.strictEqual(exe.body.code, 'rest_upload_invalid_type');
    const html = await upload('admin', '/media', 'file', Buffer.from('<p>x</p>'), 'page.png', 'text/html');
    assert.strictEqual(html.status, 415, JSON.stringify(html.body));
});

test('media: a file over the size limit is a 413 from multer, not a 500', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(80 * 1024)]);
    const res = await upload('admin', '/media', 'file', big, 'big.png', 'image/png');
    assert.strictEqual(res.status, 413, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_upload_too_large');
});

test('the controls still upload: an administrator\'s SVG and an ordinary PNG', async () => {
    const svg = await upload('admin', '/media', 'file', SVG, 'logo.svg', 'image/svg+xml');
    assert.strictEqual(svg.status, 201, JSON.stringify(svg.body));
    const png = await upload('editor', '/media', 'file', PNG, 'dot.png', 'image/png');
    assert.strictEqual(png.status, 201, JSON.stringify(png.body));
});

test('twin surfaces: plugin, theme and WXR uploads of the wrong type are 415s', async () => {
    const plugin = await upload('admin', '/plugins/upload', 'plugin', Buffer.from('x'), 'evil.txt', 'text/plain');
    assert.strictEqual(plugin.status, 415, JSON.stringify(plugin.body));
    assert.strictEqual(plugin.body.code, 'rest_upload_invalid_type');
    const theme = await upload('admin', '/themes/upload', 'theme', Buffer.from('x'), 'evil.txt', 'text/plain');
    assert.strictEqual(theme.status, 415, JSON.stringify(theme.body));
    const wxr = await upload('admin', '/import/wordpress/analyze', 'file', Buffer.from('x'), 'export.csv', 'text/csv');
    assert.strictEqual(wxr.status, 415, JSON.stringify(wxr.body));
});
