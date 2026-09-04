/**
 * DOUBLE-SUBMIT CSRF TOKEN
 *
 * The origin check that used to be the whole CSRF story is a NEGATIVE signal: it rejects a request
 * whose Origin/Referer names somewhere else. It therefore rests entirely on the attacker's browser
 * being honest about provenance, and on our enumerating our own origins correctly. The token added
 * here is a POSITIVE signal instead — the request must echo back a cookie value that only a
 * same-origin script can read, which the same-origin policy enforces rather than a header's honesty.
 *
 * The two are AND-ed, never alternatives, and this file asserts BOTH halves of that: a request with a
 * perfect token but a hostile Origin is still refused (`the token does not disable the origin check`),
 * and a same-origin request without the token is refused too.
 *
 * Everything drives the REAL routers through supertest against a throwaway temp DB, with
 * csrfProtection mounted AT THE API PREFIX exactly as index.ts mounts it — same shape as
 * auth-headless-session.test.ts. Cookies come from a REAL POST /auth/login, never hand-assembled, so
 * the test cannot pass against an issuance path that never runs in production.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-csrf-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const { csrfProtection, sanitizeCookies, CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } = require('../middleware/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const B = config.api.prefix;
const SECRET = config.jwt.secret;
const PASSWORD = 'Correct-Horse-9!';

// The browser shape: the gateway pins X-Forwarded-Host to the real client Host, and the page's Origin
// must match it. Every cookie-driven request below carries this pair, because a cookie request that
// ALSO omits Origin is refused by the older half of the gate and would prove nothing about the new one.
const SAME_ORIGIN = { 'X-Forwarded-Host': 'wjs.test', Origin: 'http://wjs.test' };

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(sanitizeCookies); // index.ts mounts this right after cookieParser
app.use(B, csrfProtection); // mounted WITH the prefix, exactly like index.ts
app.use(B, require('../routes'));

let dbAsync: any;
let adminId = 0;

/** The value of one Set-Cookie on a response, or null when the response did not set it. */
function setCookieValue(res: any, name: string): string | null {
    const line = setCookieLine(res, name);
    if (line === null) return null;
    const m = new RegExp(`^${name}=([^;]*)`).exec(line);
    return m ? decodeURIComponent(m[1]) : null;
}

/** The whole Set-Cookie line for `name` (attributes included), or null. */
function setCookieLine(res: any, name: string): string | null {
    const raw = res.headers['set-cookie'];
    const lines: string[] = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    for (const line of lines) {
        if (line.startsWith(`${name}=`)) return line;
    }
    return null;
}

/** A real browser sign-in: returns both cookies exactly as the server minted them. */
async function login(): Promise<{ session: string; csrf: string; res: any }> {
    const res = await request(app).post(`${B}/auth/login`).set(SAME_ORIGIN)
        .send({ username: 'admin', password: PASSWORD });
    assert.strictEqual(res.status, 200, `login failed: ${res.status} ${JSON.stringify(res.body)}`);
    const session = setCookieValue(res, SESSION_COOKIE);
    const csrf = setCookieValue(res, CSRF_COOKIE);
    assert.ok(session, 'login must set the session cookie');
    assert.ok(csrf, 'login must set the CSRF cookie');
    return { session: session as string, csrf: csrf as string, res };
}

const cookieHeader = (pairs: Record<string, string>) =>
    Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('; ');

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();

    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        ['admin', bcrypt.hashSync(PASSWORD, 10), 'admin@example.com', 'admin']);
    adminId = r.lastID;
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`,
        [adminId, 'administrator']);
});

after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    try { fs.rmSync(TMP_DB, { force: true }); } catch { /* */ }
    try { fs.rmSync(TMP_DB + '-wal', { force: true }); fs.rmSync(TMP_DB + '-shm', { force: true }); } catch { /* */ }
});

// ── the cookie itself ─────────────────────────────────────────────────────────────────────────────

test('login mints wjs_csrf: readable by JS, and otherwise identical transport to the session cookie', async () => {
    const { csrf, res } = await login();

    // 32 random bytes as base64url = 43 chars, no padding, no character that needs escaping.
    assert.match(csrf, /^[A-Za-z0-9_-]{43}$/, `unexpected token shape: ${csrf}`);

    const csrfLine = setCookieLine(res, CSRF_COOKIE) as string;
    const sessionLine = setCookieLine(res, SESSION_COOKIE) as string;

    // The ONE deliberate difference: same-origin JS must be able to read this one back out.
    assert.ok(!/HttpOnly/i.test(csrfLine), `wjs_csrf must NOT be HttpOnly: ${csrfLine}`);
    assert.ok(/HttpOnly/i.test(sessionLine), 'the session cookie must stay HttpOnly (control)');

    // Everything else is DERIVED from the session cookie's options, so it cannot drift: same SameSite,
    // same Path, and Secure exactly when the session cookie is Secure.
    assert.match(csrfLine, /SameSite=Lax/i, csrfLine);
    assert.match(csrfLine, /Path=\//i, csrfLine);
    assert.strictEqual(/;\s*Secure/i.test(csrfLine), /;\s*Secure/i.test(sessionLine),
        `Secure must match the session cookie exactly: ${csrfLine} vs ${sessionLine}`);
});

test('every login ROTATES the token — a session never inherits a previous authentication\'s token', async () => {
    const a = await login();
    const b = await login();
    assert.notStrictEqual(a.csrf, b.csrf, 'a fresh sign-in must mint a fresh CSRF token');
});

// ── the gate ──────────────────────────────────────────────────────────────────────────────────────

test('cookie-authenticated POST WITHOUT X-CSRF-Token is refused with rest_csrf_token', async () => {
    const { session, csrf } = await login();
    const res = await request(app).post(`${B}/auth/validate`).set(SAME_ORIGIN)
        .set('Cookie', cookieHeader({ [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf }));
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_csrf_token');
});

test('cookie-authenticated POST WITH the matching token passes', async () => {
    const { session, csrf } = await login();
    const res = await request(app).post(`${B}/auth/validate`).set(SAME_ORIGIN)
        .set('Cookie', cookieHeader({ [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf }))
        .set(CSRF_HEADER, csrf);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.valid, true);
});

test('a MISMATCHED token is refused (this is the forged-request case)', async () => {
    const { session, csrf } = await login();
    const other = await login(); // a different, perfectly well-formed token
    const res = await request(app).post(`${B}/auth/validate`).set(SAME_ORIGIN)
        .set('Cookie', cookieHeader({ [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf }))
        .set(CSRF_HEADER, other.csrf);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_csrf_token');
});

test('a token of the WRONG LENGTH is refused, not thrown on', async () => {
    // crypto.timingSafeEqual THROWS a RangeError on differing lengths — it does not return false. In an
    // async Express 4 middleware that throw never reaches the error handler: the socket just hangs
    // (the exact failure mode documented above sanitizeCookies). A truncated header must 403, and the
    // response must arrive at all, which is what this test really proves.
    const { session, csrf } = await login();
    const res = await request(app).post(`${B}/auth/validate`).set(SAME_ORIGIN)
        .set('Cookie', cookieHeader({ [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf }))
        .set(CSRF_HEADER, csrf.slice(0, 10));
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_csrf_token');
});

test('a session cookie with NO wjs_csrf cookie at all is refused (fail-closed)', async () => {
    const { session, csrf } = await login();
    const res = await request(app).post(`${B}/auth/validate`).set(SAME_ORIGIN)
        .set('Cookie', cookieHeader({ [SESSION_COOKIE]: session }))
        .set(CSRF_HEADER, csrf); // a header alone proves nothing without the cookie to match it
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_csrf_token');
});

test('BEARER POST without the header passes — a headless caller has no ambient cookie to ride', async () => {
    const bearer = jwt.sign({ userId: adminId, username: 'admin' }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    const res = await request(app).post(`${B}/auth/validate`).set('Authorization', `Bearer ${bearer}`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.valid, true);
});

test('GET with the session cookie and no header passes — safe methods are never gated', async () => {
    const { session, csrf } = await login();
    const res = await request(app).get(`${B}/auth/me`).set(SAME_ORIGIN)
        .set('Cookie', cookieHeader({ [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.user_login ?? res.body.userLogin, 'admin');
});

test('an ANONYMOUS mutating request is not gated — there is no ambient authority to protect', async () => {
    // POST /auth/login itself, from a browser that holds no cookies at all. If the gate keyed on the
    // METHOD rather than on the session cookie, nobody could ever sign in.
    const res = await request(app).post(`${B}/auth/login`).set(SAME_ORIGIN)
        .send({ username: 'admin', password: 'wrong-password' });
    assert.strictEqual(res.status, 401, `expected a credential failure, not a CSRF one: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'rest_invalid_credentials');
});

// ── the two halves are AND-ed ─────────────────────────────────────────────────────────────────────

test('a PERFECT token does not disable the origin check', async () => {
    const { session, csrf } = await login();
    const res = await request(app).post(`${B}/auth/validate`)
        .set('X-Forwarded-Host', 'wjs.test').set('Origin', 'https://evil.example')
        .set('Cookie', cookieHeader({ [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf }))
        .set(CSRF_HEADER, csrf);
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_csrf_invalid',
        'the origin check must still be the one that refuses a hostile origin');
});

// ── coverage: every mutating surface under the API prefix ─────────────────────────────────────────

test('the plugin subtree and the collaboration POSTs go through the same gate', async () => {
    const { session, csrf } = await login();
    const cookie = cookieHeader({ [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf });
    for (const url of [`${B}/plugin/any-slug/anything`, `${B}/collab/rooms/1/ops`, `${B}/presence/1`]) {
        const res = await request(app).post(url).set(SAME_ORIGIN).set('Cookie', cookie).send({});
        assert.strictEqual(res.status, 403, `${url} → ${res.status} ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.code, 'rest_csrf_token', url);
    }
});

test('index.ts mounts the gate BEFORE the plugin subtree and the API routers', () => {
    // The three routes above are gated because csrfProtection is mounted at the API PREFIX, which is a
    // property of index.ts's mount ORDER — not of anything the routers themselves do. A future reorder
    // that mounts /plugin first would silently un-gate the whole plugin surface, and no route-level
    // test would notice, so the ordering is asserted on the source itself.
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    const gate = src.indexOf('app.use(config.api.prefix, csrfProtection)');
    const pluginMount = src.indexOf('app.use(`${config.api.prefix}/plugin`');
    const routers = src.indexOf('app.use(config.api.prefix, routes)');
    assert.ok(gate > 0, 'csrfProtection is no longer mounted at the API prefix in index.ts');
    assert.ok(pluginMount > 0 && routers > 0, 'the plugin/router mounts moved — re-derive this assertion');
    assert.ok(gate < pluginMount, 'csrfProtection must be mounted BEFORE the /plugin subtree');
    assert.ok(gate < routers, 'csrfProtection must be mounted BEFORE the API routers');
});

test('CORS advertises X-CSRF-Token, or a cross-origin admin can never send it', () => {
    // A custom header makes the request PREFLIGHTED. A header absent from Access-Control-Allow-Headers
    // fails that preflight, and the browser then blocks the request before the gate ever runs — so on a
    // deployment where the admin origin differs from the backend's, forgetting this line turns every
    // mutation into a CORS error that looks nothing like a CSRF problem. Asserted on the source because
    // CORS_HEADERS is a module-local const with no seam to import.
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    const m = /const CORS_HEADERS = \[([^\]]*)\]/.exec(src);
    assert.ok(m, 'CORS_HEADERS is no longer declared as a literal array in index.ts');
    assert.match(String(m![1]), /'X-CSRF-Token'/,
        'X-CSRF-Token must be in the CORS allow-list — it is the header the gate demands');
});

// ── bootstrap and teardown of the cookie ──────────────────────────────────────────────────────────

test('a session that predates this feature is HEALED on its first safe request, not bricked', async () => {
    // The upgrade path. Without the backfill, a browser holding a session cookie minted before this
    // shipped could neither mutate (no token) nor log out (also a mutation) nor log in again (the stale
    // cookie makes that a cookie-carrying mutation too) — a lockout escapable only by hand-deleting
    // cookies.
    const { session } = await login();
    const res = await request(app).get(`${B}/auth/me`).set(SAME_ORIGIN)
        .set('Cookie', cookieHeader({ [SESSION_COOKIE]: session }));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const minted = setCookieValue(res, CSRF_COOKIE);
    assert.ok(minted && /^[A-Za-z0-9_-]{43}$/.test(minted), `expected a freshly minted token, got: ${minted}`);
});

test('the heal also happens for an EXPIRED session — otherwise the login POST is unsatisfiable', async () => {
    const res = await request(app).get(`${B}/auth/me`).set(SAME_ORIGIN)
        .set('Cookie', cookieHeader({ [SESSION_COOKIE]: 'not-a-jwt' }));
    assert.strictEqual(res.status, 401, JSON.stringify(res.body));
    const minted = setCookieValue(res, CSRF_COOKIE);
    assert.ok(minted && /^[A-Za-z0-9_-]{43}$/.test(minted),
        'a browser whose session died must still come away with a token it can use to sign in again');
});

test('a request that ALREADY has a token is never re-minted (only issueSessionCookie rotates)', async () => {
    const { session, csrf } = await login();
    const res = await request(app).get(`${B}/auth/me`).set(SAME_ORIGIN)
        .set('Cookie', cookieHeader({ [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf }));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(setCookieLine(res, CSRF_COOKIE), null,
        'rotating on an ordinary read would race every in-flight mutation for no benefit');
});

test('logout clears BOTH cookies', async () => {
    const { session, csrf } = await login();
    const res = await request(app).post(`${B}/auth/logout`).set(SAME_ORIGIN)
        .set('Cookie', cookieHeader({ [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf }))
        .set(CSRF_HEADER, csrf);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    for (const name of [SESSION_COOKIE, CSRF_COOKIE]) {
        const line = setCookieLine(res, name);
        assert.ok(line, `logout must clear ${name}`);
        assert.match(String(line), /=;|Expires=Thu, 01 Jan 1970/i, `${name} was not cleared: ${line}`);
    }
});
