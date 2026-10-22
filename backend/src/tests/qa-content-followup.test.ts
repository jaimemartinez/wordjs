/**
 * Follow-up of the three-mode QA pass (content, accounts, settings): «Remember me», the installer token at
 * step 1, bulk user actions, the account self-service (avatar, export, delete), the posts page with a static
 * front page, the reading/writing/permalink/privacy settings, menus, image editing and the Redis panel —
 * through the REAL routers.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-qa-followup-'));
process.chdir(TMP_ROOT);

const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const { csrfProtection, sanitizeCookies, CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } = require('../middleware/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const B = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';
const SAME_ORIGIN = { 'X-Forwarded-Host': 'wjs.test', Origin: 'http://wjs.test' };

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(sanitizeCookies);
app.use(B, csrfProtection);
app.use(B, require('../routes'));
app.use(require('../middleware/errorHandler').errorHandler);

let dbAsync: any;
const ids: Record<string, number> = {};
const tokens: Record<string, string> = {};

const bearer = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

function setCookieValue(res: any, name: string): string | null {
    const raw = res.headers['set-cookie'];
    const lines: string[] = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    for (const line of lines) {
        const m = new RegExp(`^${name}=([^;]*)`).exec(line);
        if (m) return decodeURIComponent(m[1]);
    }
    return null;
}

async function login(username: string): Promise<{ session: string; csrf: string }> {
    const res = await request(app).post(`${B}/auth/login`).set(SAME_ORIGIN).send({ username, password: PASSWORD });
    assert.strictEqual(res.status, 200, `login failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { session: setCookieValue(res, SESSION_COOKIE) as string, csrf: setCookieValue(res, CSRF_COOKIE) as string };
}

const cookieOf = (s: { session: string; csrf: string }) => `${SESSION_COOKIE}=${s.session}; ${CSRF_COOKIE}=${s.csrf}`;
const meWith = (s: { session: string; csrf: string }) => request(app).get(`${B}/auth/me`).set(SAME_ORIGIN).set('Cookie', cookieOf(s));
const postWith = (s: { session: string; csrf: string }, url: string, body: any = {}) =>
    request(app).post(`${B}${url}`).set(SAME_ORIGIN).set('Cookie', cookieOf(s)).set(CSRF_HEADER, s.csrf).send(body);

async function seedUser(login: string, role: string | null): Promise<number> {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        [login, bcrypt.hashSync(PASSWORD, 4), `${login}@example.com`, login]);
    if (role) await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    ids[login] = r.lastID;
    tokens[login] = jwt.sign({ userId: r.lastID, username: login }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
    return r.lastID;
}

async function setOption(name: string, value: any) {
    await require('../core/options').updateOption(name, value);
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    await seedUser('admin', 'administrator');
    await seedUser('editor1', 'editor');
    await seedUser('author1', 'author');
    await seedUser('sub1', 'subscriber');
    await seedUser('norole', null); // no role meta at all: a subscriber
});

after(async () => {
    try { await database.close?.(); } catch { /* */ }
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

// ── «Remember me» ─────────────────────────────────────────────────────────────────────────────────

const sessionCookieLine = (res: any): string => {
    const raw = res.headers['set-cookie'];
    const lines: string[] = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    return lines.find((l) => l.startsWith(`${SESSION_COOKIE}=`)) || '';
};

test('without «Remember me» the session cookie ends with the browser, and every refresh keeps it so', async () => {
    const kept = await request(app).post(`${B}/auth/login`).set(SAME_ORIGIN).send({ username: 'admin', password: PASSWORD });
    assert.match(sessionCookieLine(kept), /Max-Age=\d+/i, 'default: the 7-day cookie');

    const res = await request(app).post(`${B}/auth/login`).set(SAME_ORIGIN).send({ username: 'admin', password: PASSWORD, remember: false });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const line = sessionCookieLine(res);
    assert.ok(line, 'a session cookie is issued');
    assert.doesNotMatch(line, /Max-Age|Expires/i, `a browser-session cookie: ${line}`);
    const session = setCookieValue(res, SESSION_COOKIE) as string;
    const csrf = setCookieValue(res, CSRF_COOKIE) as string;
    assert.strictEqual((jwt.decode(session) as { rem?: boolean }).rem, false);

    const refreshed = await request(app).post(`${B}/auth/refresh`).set(SAME_ORIGIN)
        .set('Cookie', `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${csrf}`).set(CSRF_HEADER, csrf).send({});
    assert.strictEqual(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.doesNotMatch(sessionCookieLine(refreshed), /Max-Age|Expires/i, 'the refresh keeps the choice');
    assert.strictEqual((jwt.decode(setCookieValue(refreshed, SESSION_COOKIE) as string) as { rem?: boolean }).rem, false);
});

test('«Remember me» off survives the two-factor step', async () => {
    const totp = require('../core/totp');
    const mfa = require('../core/mfa');
    const User = require('../models/User');
    await seedUser('remember2fa', 'author');
    const secret = totp.generateSecret();
    await User.updateMeta(ids.remember2fa, mfa.META.lastStep, '-1');
    await User.updateMeta(ids.remember2fa, mfa.META.secret, secret);
    await User.updateMeta(ids.remember2fa, mfa.META.backup, JSON.stringify([]));
    await User.updateMeta(ids.remember2fa, mfa.META.enabled, '1');
    const first = await request(app).post(`${B}/auth/login`).set(SAME_ORIGIN).send({ username: 'remember2fa', password: PASSWORD, remember: 'false' });
    assert.ok(first.body.mfaToken, JSON.stringify(first.body));
    const ok = await request(app).post(`${B}/auth/mfa`).set(SAME_ORIGIN).send({ mfaToken: first.body.mfaToken, code: totp.totp(secret) });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.doesNotMatch(sessionCookieLine(ok), /Max-Age|Expires/i);
});

// ── account self-service ──────────────────────────────────────────────────────────────────────────

test('a user uploads a profile picture (re-encoded to WebP), and removes it', async () => {
    await seedUser('pic', 'subscriber');
    const png = await require('sharp')({ create: { width: 600, height: 400, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
    const up = await request(app).put(`${B}/users/me/avatar`).set(bearer('pic')).attach('avatar', png, { filename: 'me.png', contentType: 'image/png' });
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    assert.match(up.body.avatarUrl, /^\/uploads\/avatars\/\d+-[0-9a-f]{12}\.webp$/);
    const stored = require('path').join(require('../core/private-media').uploadsRootFor(false), 'avatars', require('path').basename(up.body.avatarUrl));
    const meta = await require('sharp')(require('fs').readFileSync(stored)).metadata();
    assert.strictEqual(meta.format, 'webp');
    assert.strictEqual(meta.width, 256);

    const notImage = await request(app).put(`${B}/users/me/avatar`).set(bearer('pic')).attach('avatar', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { filename: 'x.svg', contentType: 'image/svg+xml' });
    assert.strictEqual(notImage.status, 400);
    assert.strictEqual(notImage.body.code, 'rest_avatar_invalid');

    // A profile save cannot point avatar_url anywhere else.
    await request(app).put(`${B}/users/me`).set(bearer('pic')).send({ meta: { avatar_url: 'https://tracker.example/p.gif' } });
    assert.strictEqual((await request(app).get(`${B}/users/me`).set(bearer('pic'))).body.avatarUrl, up.body.avatarUrl);

    const removed = await request(app).delete(`${B}/users/me/avatar`).set(bearer('pic'));
    assert.strictEqual(removed.status, 200);
    assert.strictEqual(removed.body.avatarUrl, null);
    assert.strictEqual(require('fs').existsSync(stored), false, 'the file goes too');
});

test('a user downloads their data: profile, entries, comments, media — never the password hash', async () => {
    const post = await request(app).post(`${B}/posts`).set(bearer('author1')).send({ title: 'Mine', status: 'draft' });
    assert.strictEqual(post.status, 201, JSON.stringify(post.body));
    const login = await request(app).post(`${B}/auth/login`).set(SAME_ORIGIN).send({ username: 'author1', password: PASSWORD });
    const session = setCookieValue(login, SESSION_COOKIE);
    const res = await request(app).get(`${B}/users/me/export`).set(SAME_ORIGIN).set('Cookie', `${SESSION_COOKIE}=${session}`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.match(String(res.headers['content-disposition']), /attachment; filename="account-\d+\.json"/);
    assert.strictEqual(res.body.profile.username, 'author1');
    assert.ok(res.body.entries.some((e: any) => e.title === 'Mine'));
    assert.ok(Array.isArray(res.body.comments) && Array.isArray(res.body.media));
    assert.doesNotMatch(JSON.stringify(res.body), /\$2[aby]\$/, 'no bcrypt hash');
});

test('a user deletes their own account with the password; the last administrator cannot', async () => {
    await seedUser('leaver', 'subscriber');
    const login = await request(app).post(`${B}/auth/login`).set(SAME_ORIGIN).send({ username: 'leaver', password: PASSWORD });
    const s = { session: setCookieValue(login, SESSION_COOKIE) as string, csrf: setCookieValue(login, CSRF_COOKIE) as string };
    const del = (body: any) => request(app).delete(`${B}/users/me`).set(SAME_ORIGIN)
        .set('Cookie', `${SESSION_COOKIE}=${s.session}; ${CSRF_COOKIE}=${s.csrf}`).set(CSRF_HEADER, s.csrf).send(body);
    const wrong = await del({ currentPassword: 'not-it' });
    assert.strictEqual(wrong.status, 403, JSON.stringify(wrong.body));
    const ok = await del({ currentPassword: PASSWORD });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(await require('../models/User').findById(ids.leaver), null);

    // admin is the only administrator here.
    const a = await request(app).post(`${B}/auth/login`).set(SAME_ORIGIN).send({ username: 'admin', password: PASSWORD });
    const as = { session: setCookieValue(a, SESSION_COOKIE) as string, csrf: setCookieValue(a, CSRF_COOKIE) as string };
    const last = await request(app).delete(`${B}/users/me`).set(SAME_ORIGIN)
        .set('Cookie', `${SESSION_COOKIE}=${as.session}; ${CSRF_COOKIE}=${as.csrf}`).set(CSRF_HEADER, as.csrf).send({ currentPassword: PASSWORD });
    assert.strictEqual(last.status, 403);
    assert.strictEqual(last.body.code, 'rest_last_administrator');
});
