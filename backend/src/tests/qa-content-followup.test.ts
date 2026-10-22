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
