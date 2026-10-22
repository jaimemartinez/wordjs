/**
 * Content, comments and account behaviour found by the three-mode QA pass — through the REAL routers.
 *
 *   • Sign out ends THIS session only; «sign out of all sessions» (POST /users/me/sessions/revoke) ends
 *     every one. Logout used to stamp the account's security epoch, so signing out of one browser signed
 *     the user out of all of them.
 *   • Comment settings take effect on the server: «Enable comments» off refuses POST /comments, and
 *     «registered users only» refuses an anonymous comment even when the option comes back from storage
 *     as the NUMBER 1 (the old `=== '1'` never matched).
 *   • POST /comments/:id/unapprove is a moderate_comments route (Unapprove / Not spam / Restore), so an
 *     editor — who has no edit_comments — can take an approval back.
 *   • GET /users pages the Team and Subscribers lists on the server (exclude_role / role=subscriber, a
 *     user with no stored role being a subscriber).
 *   • DELETE /users/:id?reassign= attributes the account's entries to another user first.
 *   • Every password the users router writes needs 8 characters (the admin create path took «abc»).
 *   • A custom role still held by users cannot be deleted (409), not only a plugin's leftover role.
 *   • default_role refuses a role that runs the site; a stored privileged value falls back to
 *     subscriber at sign-up. posts_per_page and admin_email are validated.
 *   • A post created without categories lands in the default category.
 *   • An upload's UTF-8 file name survives (it was decoded as latin1) and folds accents in the stored name.
 *   • The notification stream past its per-user cap is refused with 429 + Retry-After, before any stream.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-qa-content-'));
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

// ── sessions ──────────────────────────────────────────────────────────────────────────────────────

test('REGRESSION: signing out of one browser leaves the user\'s other sessions signed in', async () => {
    const laptop = await login('author1');
    const phone = await login('author1');
    assert.strictEqual((await meWith(laptop)).status, 200);
    assert.strictEqual((await meWith(phone)).status, 200);

    const out = await postWith(laptop, '/auth/logout');
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));

    const dead = await meWith(laptop);
    assert.strictEqual(dead.status, 401, 'the signed-out session (and any copy of its cookie) must be dead');
    assert.strictEqual(dead.body.code, 'rest_token_revoked');
    assert.strictEqual((await meWith(phone)).status, 200, 'the other session must survive a logout elsewhere');
});

test('sign out of ALL sessions ends every one of them, the caller\'s included', async () => {
    const a = await login('editor1');
    const b = await login('editor1');
    const res = await postWith(a, '/users/me/sessions/revoke', { currentPassword: PASSWORD });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    // The epoch is whole seconds and inclusive: a session minted in the same second is gone too.
    assert.strictEqual((await meWith(a)).status, 401);
    assert.strictEqual((await meWith(b)).status, 401);
    // A new sign-in afterwards works (its iat is after the epoch, or equal and then — wait a second).
    await new Promise((r) => setTimeout(r, 1100));
    assert.strictEqual((await meWith(await login('editor1'))).status, 200);
});

test('a refreshed session keeps its id, so signing it out still ends only that browser', async () => {
    const a = await login('sub1');
    const other = await login('sub1');
    const refreshed = await postWith(a, '/auth/refresh');
    assert.strictEqual(refreshed.status, 200, JSON.stringify(refreshed.body));
    const next = { session: setCookieValue(refreshed, SESSION_COOKIE) || a.session, csrf: setCookieValue(refreshed, CSRF_COOKIE) || a.csrf };
    const ses = (t: string) => (jwt.decode(t) as any).ses;
    assert.ok(ses(a.session), 'a session token carries a session id');
    assert.strictEqual(ses(next.session), ses(a.session), 'refresh must keep the session id');
    await postWith(next, '/auth/logout');
    assert.strictEqual((await meWith(next)).status, 401);
    assert.strictEqual((await meWith(a)).status, 401, 'the pre-refresh copy of the same session dies with it');
    assert.strictEqual((await meWith(other)).status, 200);
});

test('session-revocation helpers: the list prunes expired entries and stays bounded', () => {
    const rev = require('../core/session-revocation');
    const now = 1_000_000;
    let list: Record<string, number> = { old: now - 10, live: now + 100 };
    list = rev.withRevokedSession(list, 'new', now + 50, now);
    assert.deepStrictEqual(Object.keys(list).sort(), ['live', 'new']);
    for (let i = 0; i < 300; i++) list = rev.withRevokedSession(list, `s${i}`, now + 1000 + i, now);
    assert.ok(Object.keys(list).length <= 200);
    const user = { meta: { revoked_session_tokens: JSON.stringify({ abc: now + 10 }) } };
    assert.strictEqual(rev.isSessionRevoked(user, { ses: 'abc', iat: 1 }), true);
    assert.strictEqual(rev.isSessionRevoked(user, { ses: 'xyz', iat: 1 }), false);
    assert.strictEqual(rev.isSessionRevoked({ meta: { token_valid_after: '50' } }, { ses: 'xyz', iat: 50 }), true, 'the epoch still ends everything');
});

test('the per-session list is protected meta: a profile write cannot clear it', async () => {
    const User = require('../models/User');
    await User.updateMeta(ids.author1, 'revoked_session_tokens', JSON.stringify({ keep: 9999999999 }));
    await User.update(ids.author1, { meta: { revoked_session_tokens: '{}' } });
    const fresh = await User.findById(ids.author1);
    assert.match(String(fresh.meta.revoked_session_tokens), /keep/);
    assert.ok(!('revoked_session_tokens' in (fresh.toJSON().meta || {})), 'never serialized');
});

// ── comments ──────────────────────────────────────────────────────────────────────────────────────

let postId = 0;
async function anonComment(extra: any = {}) {
    return request(app).post(`${B}/comments`).set(SAME_ORIGIN)
        .send({ post: postId, author_name: 'Anon', author_email: `anon${Math.random()}@example.com`, content: `hello ${Math.random()}`, ...extra });
}

test('setup: a published post', async () => {
    // editor1 signed out of every session above (an epoch at that second): mint its bearer anew.
    tokens.editor1 = jwt.sign({ userId: ids.editor1, username: 'editor1' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
    const res = await request(app).post(`${B}/posts`).set(bearer('admin')).send({ title: 'Commented', status: 'publish', content: 'x' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    postId = res.body.id;
});

test('REGRESSION: «registered users only» refuses anonymous comments when stored as the number 1', async () => {
    await setOption('comment_registration', 1);
    const res = await anonComment();
    assert.strictEqual(res.status, 401, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_comment_login_required');
    await setOption('comment_registration', 0);
    assert.strictEqual((await anonComment()).status, 201);
});

test('REGRESSION: «Enable comments» off refuses every comment on the server', async () => {
    await setOption('comments_enabled', 0);
    const res = await anonComment();
    assert.strictEqual(res.status, 403, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_comment_closed');
    await setOption('comments_enabled', '1');
    assert.strictEqual((await anonComment()).status, 201);
});

test('an editor (no edit_comments) can approve AND unapprove, and restore a spam comment to pending', async () => {
    const created = await anonComment();
    const id = created.body.id;
    const approve = await request(app).post(`${B}/comments/${id}/approve`).set(bearer('editor1')).send({});
    assert.strictEqual(approve.status, 200);
    assert.strictEqual(approve.body.status, 'approved');
    const unapprove = await request(app).post(`${B}/comments/${id}/unapprove`).set(bearer('editor1')).send({});
    assert.strictEqual(unapprove.status, 200, JSON.stringify(unapprove.body));
    assert.strictEqual(unapprove.body.status, 'pending');
    await request(app).post(`${B}/comments/${id}/spam`).set(bearer('editor1')).send({});
    const notSpam = await request(app).post(`${B}/comments/${id}/unapprove`).set(bearer('editor1')).send({});
    assert.strictEqual(notSpam.body.status, 'pending');
    const forbidden = await request(app).post(`${B}/comments/${id}/unapprove`).set(bearer('author1')).send({});
    assert.strictEqual(forbidden.status, 403, 'an author does not moderate');
    assert.strictEqual((await request(app).post(`${B}/comments/999999/unapprove`).set(bearer('editor1')).send({})).status, 404);
});

test('comment settings are validated and stored as canonical "1"/"0"', async () => {
    const bad = await request(app).put(`${B}/settings`).set(bearer('admin')).send({ comments_enabled: 'maybe' });
    assert.strictEqual(bad.status, 400);
    const ok = await request(app).put(`${B}/settings`).set(bearer('admin')).send({ comments_enabled: true, comment_registration: 0 });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.comments_enabled, '1');
    assert.strictEqual(ok.body.comment_registration, '0');
});

// ── users ─────────────────────────────────────────────────────────────────────────────────────────

test('GET /users pages Team and Subscribers on the server; a user with no role is a subscriber', async () => {
    const team = await request(app).get(`${B}/users`).set(bearer('admin')).query({ exclude_role: 'subscriber', per_page: 100 });
    assert.strictEqual(team.status, 200, JSON.stringify(team.body));
    const teamLogins = team.body.map((u: any) => u.username);
    assert.ok(teamLogins.includes('admin') && teamLogins.includes('editor1') && teamLogins.includes('author1'));
    assert.ok(!teamLogins.includes('sub1') && !teamLogins.includes('norole'));
    assert.strictEqual(Number(team.headers['x-wp-total']), teamLogins.length);

    const subs = await request(app).get(`${B}/users`).set(bearer('admin')).query({ role: 'subscriber', per_page: 100 });
    const subLogins = subs.body.map((u: any) => u.username);
    assert.ok(subLogins.includes('sub1') && subLogins.includes('norole'), `got ${subLogins}`);
    assert.ok(!subLogins.includes('admin'));

    const paged = await request(app).get(`${B}/users`).set(bearer('admin')).query({ per_page: 2, page: 1 });
    assert.strictEqual(paged.body.length, 2);
    assert.ok(Number(paged.headers['x-wp-total']) >= 5);
});

test('every password the users router writes needs 8 characters (admin create and admin edit too)', async () => {
    const create = await request(app).post(`${B}/users`).set(bearer('admin')).send({ username: 'weakling', email: 'weak@example.com', password: 'abc', role: 'author' });
    assert.strictEqual(create.status, 400, JSON.stringify(create.body));
    assert.strictEqual(create.body.code, 'rest_weak_password');
    const edit = await request(app).put(`${B}/users/${ids.author1}`).set(bearer('admin')).send({ password: 'abc' });
    assert.strictEqual(edit.status, 400);
    assert.strictEqual(edit.body.code, 'rest_weak_password');
});

test('DELETE /users/:id?reassign= attributes the account\'s entries to another user first', async () => {
    const goneId = await seedUser('leaving', 'author');
    const p1 = await request(app).post(`${B}/posts`).set(bearer('leaving')).send({ title: 'Mine 1', status: 'publish', content: 'a' });
    const p2 = await request(app).post(`${B}/posts`).set(bearer('leaving')).send({ title: 'Mine 2', status: 'draft', content: 'b' });
    assert.strictEqual(p1.status, 201);

    const badTarget = await request(app).delete(`${B}/users/${goneId}`).set(bearer('admin')).query({ reassign: goneId });
    assert.strictEqual(badTarget.status, 400, 'reassigning to the account being deleted is refused');
    const missing = await request(app).delete(`${B}/users/${goneId}`).set(bearer('admin')).query({ reassign: 987654 });
    assert.strictEqual(missing.status, 400);

    const del = await request(app).delete(`${B}/users/${goneId}`).set(bearer('admin')).query({ reassign: ids.editor1 });
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    assert.strictEqual(del.body.reassigned, 2);
    for (const id of [p1.body.id, p2.body.id]) {
        const row = await dbAsync.get('SELECT author_id FROM posts WHERE id = ?', [id]);
        assert.strictEqual(Number(row.author_id), ids.editor1);
    }
});

test('a custom role that users still hold cannot be deleted (409 rest_role_in_use)', async () => {
    const made = await request(app).post(`${B}/roles`).set(bearer('admin')).send({ name: 'QA Moderator', slug: 'qa_moderator', capabilities: ['read', 'moderate_comments'] });
    assert.ok([200, 201].includes(made.status), JSON.stringify(made.body));
    const slug = made.body.slug || 'qa_moderator';
    await seedUser('moderator1', slug);
    const refused = await request(app).delete(`${B}/roles/${slug}`).set(bearer('admin'));
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.code, 'rest_role_in_use');
    await dbAsync.run(`UPDATE user_meta SET meta_value = 'subscriber' WHERE user_id = ? AND meta_key = 'role'`, [ids.moderator1]);
    await require('../core/cache').del(`user:${ids.moderator1}`);
    assert.strictEqual((await request(app).delete(`${B}/roles/${slug}`).set(bearer('admin'))).status, 200);
});

// ── registration / settings ───────────────────────────────────────────────────────────────────────

test('default_role refuses a role that runs the site; a stored privileged value signs up as subscriber', async () => {
    for (const role of ['administrator', 'editor', 'no_such_role']) {
        const res = await request(app).put(`${B}/settings`).set(bearer('admin')).send({ default_role: role });
        assert.strictEqual(res.status, 400, `${role}: ${JSON.stringify(res.body)}`);
    }
    assert.strictEqual((await request(app).put(`${B}/settings`).set(bearer('admin')).send({ default_role: 'author' })).status, 200);

    const reg = require('../core/registration-settings');
    await setOption('default_role', 'administrator'); // written before the screen refused it
    assert.strictEqual(await reg.signupRole(), 'subscriber');
    await setOption('default_role', 'author');
    assert.strictEqual(await reg.signupRole(), 'author');
    await setOption('default_role', 'subscriber');
});

test('posts_per_page and admin_email are validated', async () => {
    for (const body of [{ posts_per_page: -5 }, { posts_per_page: 'abc' }, { admin_email: 'not-an-email' }]) {
        const res = await request(app).put(`${B}/settings`).set(bearer('admin')).send(body);
        assert.strictEqual(res.status, 400, `${JSON.stringify(body)} → ${res.status}`);
    }
    const ok = await request(app).put(`${B}/settings`).set(bearer('admin')).send({ posts_per_page: '12', admin_email: ' owner@example.com ' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.posts_per_page, '12');
    assert.strictEqual(ok.body.admin_email, 'owner@example.com');
});

// ── content ───────────────────────────────────────────────────────────────────────────────────────

test('REGRESSION: a post created (or saved) with no category lands in the default category', async () => {
    const made = await request(app).post(`${B}/categories`).set(bearer('admin')).send({ name: 'Uncategorized QA' });
    assert.ok([200, 201].includes(made.status), JSON.stringify(made.body));
    const term = { term_id: made.body.id };
    await setOption('default_category', term.term_id);

    const created = await request(app).post(`${B}/posts`).set(bearer('admin')).send({ title: 'No category given', status: 'draft', content: 'x' });
    assert.strictEqual(created.status, 201);
    assert.deepStrictEqual(created.body.categories.map((c: any) => c.id), [term.term_id]);

    const cleared = await request(app).put(`${B}/posts/${created.body.id}`).set(bearer('admin')).send({ categories: [] });
    assert.strictEqual(cleared.status, 200);
    assert.deepStrictEqual(cleared.body.categories.map((c: any) => c.id), [term.term_id], 'an explicitly emptied list falls back too');

    const untouched = await request(app).put(`${B}/posts/${created.body.id}`).set(bearer('admin')).send({ title: 'Renamed' });
    assert.deepStrictEqual(untouched.body.categories.map((c: any) => c.id), [term.term_id]);

    const page = await request(app).post(`${B}/posts`).set(bearer('admin')).send({ type: 'page', title: 'A page', status: 'draft', content: 'x' });
    assert.deepStrictEqual(page.body.categories || [], [], 'pages have no categories');
});

test('an upload keeps its UTF-8 file name as the title and folds accents in the stored file name', async () => {
    // 1×1 transparent PNG.
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
        '1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
    const res = await request(app).post(`${B}/media`).set(bearer('admin')).attach('file', png, { filename: 'ñandú.png', contentType: 'image/png' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.title, 'ñandú.png');
    assert.match(String(res.body.url || res.body.guid || res.body.sourceUrl || ''), /nandu-[0-9a-f]{8}\.png/);
});

// ── notifications stream cap ──────────────────────────────────────────────────────────────────────

test('past the per-user cap the stream is refused with 429 + Retry-After, before any event-stream', async () => {
    const svc = require('../core/notifications');
    const service = svc.notificationService || svc.default || svc;
    const Cls = service.constructor;
    const fakes: any[] = [];
    const siteId = require('../core/site-context').currentSiteIdOrNull();
    for (let i = 0; i < Cls.MAX_CLIENTS_PER_USER; i++) {
        const fake: any = { _wordjs_user_id: ids.admin, _wordjs_site_id: siteId };
        service.clients.add(fake);
        fakes.push(fake);
    }
    try {
        const res = await request(app).get(`${B}/notifications/stream`).set(bearer('admin'));
        assert.strictEqual(res.status, 429, `got ${res.status} ${res.headers['content-type']}`);
        assert.strictEqual(res.body.code, 'rest_too_many_streams');
        assert.strictEqual(res.headers['retry-after'], '30');
    } finally {
        for (const f of fakes) service.clients.delete(f);
    }
});

test('the comment switches purge the cached public pages when they change', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'frontend-purge.ts'), 'utf8');
    const set = src.slice(src.indexOf('const SETTINGS_OPTIONS'), src.indexOf('])', src.indexOf('const SETTINGS_OPTIONS')));
    assert.ok(set.includes("'comments_enabled'") && set.includes("'comment_registration'"));
});

test('a 2FA challenge completes ONE sign-in: replaying it with the next code is refused', async () => {
    const totp = require('../core/totp');
    const mfa = require('../core/mfa');
    const User = require('../models/User');
    await seedUser('twofa', 'author');
    const secret = totp.generateSecret();
    await User.updateMeta(ids.twofa, mfa.META.lastStep, '-1');
    await User.updateMeta(ids.twofa, mfa.META.secret, secret);
    await User.updateMeta(ids.twofa, mfa.META.backup, JSON.stringify([]));
    await User.updateMeta(ids.twofa, mfa.META.enabled, '1');

    const first = await request(app).post(`${B}/auth/login`).set(SAME_ORIGIN).send({ username: 'twofa', password: PASSWORD });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const mfaToken = first.body.mfaToken;
    assert.ok(mfaToken, 'a challenge is issued');

    const ok = await request(app).post(`${B}/auth/mfa`).set(SAME_ORIGIN).send({ mfaToken, code: totp.totp(secret) });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));

    // The code of the NEXT 30-second step, wherever in the current step the clock is. `now + 31` lands two
    // steps ahead when the clock is near the end of a step — outside the accepted window, a different answer.
    const nextStepCode = () => totp.totp(secret, { time: (Math.floor(Date.now() / 1000 / 30) + 1) * 30 });
    const replay = await request(app).post(`${B}/auth/mfa`).set(SAME_ORIGIN)
        .send({ mfaToken, code: nextStepCode() });
    assert.strictEqual(replay.status, 401, JSON.stringify(replay.body));
    assert.strictEqual(replay.body.code, 'rest_mfa_challenge_invalid');

    // A wrong code does NOT use the challenge up: the person can type it again.
    const second = await request(app).post(`${B}/auth/login`).set(SAME_ORIGIN).send({ username: 'twofa', password: PASSWORD });
    const wrong = await request(app).post(`${B}/auth/mfa`).set(SAME_ORIGIN).send({ mfaToken: second.body.mfaToken, code: '000000' });
    assert.strictEqual(wrong.status, 401);
    assert.strictEqual(wrong.body.code, 'rest_mfa_invalid');
    const retry = await request(app).post(`${B}/auth/mfa`).set(SAME_ORIGIN)
        .send({ mfaToken: second.body.mfaToken, code: nextStepCode() });
    assert.strictEqual(retry.status, 200, JSON.stringify(retry.body));
});

test('the upload size limit is set from the panel and applies at once; a refusal names the limit', async () => {
    const bad = await request(app).put(`${B}/settings`).set(bearer('admin')).send({ upload_max_size_mb: '0' });
    assert.strictEqual(bad.status, 400);
    const ok = await request(app).put(`${B}/settings`).set(bearer('admin')).send({ upload_max_size_mb: ' 1 ' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.upload_max_size_mb, '1');
    const pub = await request(app).get(`${B}/settings`);
    assert.strictEqual(pub.body.upload_max_bytes, 1024 * 1024);

    const big = Buffer.alloc(1024 * 1024 + 10, 0);
    const res = await request(app).post(`${B}/media`).set(bearer('admin')).attach('file', big, { filename: 'big.png', contentType: 'image/png' });
    assert.strictEqual(res.status, 413, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'rest_upload_too_large');
    assert.match(res.body.message, /maximum upload size is 1 MB/);

    const reset = await request(app).put(`${B}/settings`).set(bearer('admin')).send({ upload_max_size_mb: '' });
    assert.strictEqual(reset.body.upload_max_size_mb, '');
    assert.strictEqual((await request(app).get(`${B}/settings`)).body.upload_max_bytes, config.uploads.maxFileSize || 10 * 1024 * 1024);
});

test('a missing optional theme template is logged as information, other 4xx as warnings', () => {
    const { levelForStatus } = require('../middleware/request-context');
    assert.strictEqual(levelForStatus(404, 'GET', '/themes/default/templates/single.json'), 'info');
    assert.strictEqual(levelForStatus(404, 'GET', '/api/v1/posts/9'), 'warn');
    assert.strictEqual(levelForStatus(404, 'POST', '/themes/x'), 'warn');
    assert.strictEqual(levelForStatus(500, 'GET', '/themes/x'), 'error');
    assert.strictEqual(levelForStatus(200), 'info');
});

// ── public API (REST / GraphQL / OpenAPI) ─────────────────────────────────────────────────────────

test('an Authorization: Bearer that resolves to nobody is 401 on public reads; a dead cookie still reads as a visitor', async () => {
    for (const value of ['Bearer garbage', 'Bearer wjt_bogus0000000000000000', `Bearer ${jwt.sign({ userId: 999999, username: 'ghost' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}`]) {
        const res = await request(app).get(`${B}/posts`).set('Authorization', value);
        assert.strictEqual(res.status, 401, `${value}: ${res.status} ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.code, 'rest_token_invalid');
        assert.match(String(res.headers['www-authenticate']), /error="invalid_token"/);
    }
    const expired = jwt.sign({ userId: ids.admin, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: -10 });
    assert.strictEqual((await request(app).get(`${B}/posts`).set('Authorization', `Bearer ${expired}`)).status, 401);
    // The browser's ambient cookie is not a claim the caller made: still a visitor.
    const cookie = await request(app).get(`${B}/posts`).set('Cookie', `${SESSION_COOKIE}=not-a-session`);
    assert.strictEqual(cookie.status, 200, JSON.stringify(cookie.body));
    // A valid bearer and no credential at all are unchanged.
    assert.strictEqual((await request(app).get(`${B}/posts?status=draft`).set(bearer('admin'))).status, 200);
    assert.strictEqual((await request(app).get(`${B}/posts`)).status, 200);
});

test('GraphQL refuses a dead Bearer the same way instead of answering viewer: null', async () => {
    const bad = await request(app).get(`${B}/graphql`).query({ query: '{ viewer { id } }' }).set('Authorization', 'Bearer garbage');
    assert.strictEqual(bad.status, 401, JSON.stringify(bad.body));
    assert.strictEqual(bad.body.code, 'rest_token_invalid');
    const anon = await request(app).get(`${B}/graphql`).query({ query: '{ viewer { id } }' });
    assert.strictEqual(anon.status, 200, JSON.stringify(anon.body));
    assert.strictEqual(anon.body.data.viewer, null);
    const me = await request(app).get(`${B}/graphql`).query({ query: '{ viewer { id } }' }).set(bearer('admin'));
    assert.strictEqual(me.status, 200, JSON.stringify(me.body));
    assert.strictEqual(Number(me.body.data.viewer.id), ids.admin);
});

test('GET /comments takes the WordPress status spellings (all, approved, hold)', async () => {
    const { normalizeCommentStatusQuery } = require('../routes/comments');
    assert.strictEqual(normalizeCommentStatusQuery('all'), 'any');
    assert.strictEqual(normalizeCommentStatusQuery('approved'), '1');
    assert.strictEqual(normalizeCommentStatusQuery('hold'), '0');
    assert.strictEqual(normalizeCommentStatusQuery('spam'), 'spam');
    const any = await request(app).get(`${B}/comments?status=any&per_page=100`).set(bearer('admin'));
    const all = await request(app).get(`${B}/comments?status=all&per_page=100`).set(bearer('admin'));
    assert.strictEqual(all.status, 200);
    assert.ok(any.body.length > 0, 'the comments above exist');
    assert.deepStrictEqual(all.body.map((c: any) => c.id), any.body.map((c: any) => c.id));
});

test('a category parent must exist and can never be the category itself or one of its subcategories', async () => {
    const mk = async (name: string, parent?: number) => request(app).post(`${B}/categories`).set(bearer('admin')).send({ name, ...(parent !== undefined ? { parent } : {}) });
    const top = await mk('QA Top');
    assert.strictEqual(top.status, 201, JSON.stringify(top.body));
    const child = await mk('QA Child', top.body.id);
    assert.strictEqual(child.status, 201, JSON.stringify(child.body));
    assert.strictEqual(child.body.parent, top.body.id);
    const dangling = await mk('QA Dangling', 987654);
    assert.strictEqual(dangling.status, 400);
    assert.strictEqual(dangling.body.code, 'rest_term_invalid_parent');

    const self = await request(app).put(`${B}/categories/${top.body.id}`).set(bearer('admin')).send({ parent: top.body.id });
    assert.strictEqual(self.status, 400);
    const loop = await request(app).put(`${B}/categories/${top.body.id}`).set(bearer('admin')).send({ parent: child.body.id });
    assert.strictEqual(loop.status, 400, 'moving a category under its own child would make a loop');
    assert.strictEqual(loop.body.code, 'rest_term_invalid_parent');

    const edit = await request(app).put(`${B}/categories/${child.body.id}`).set(bearer('admin')).send({ name: 'QA Child Renamed', description: 'd', parent: 0 });
    assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));
    assert.strictEqual(edit.body.parent, 0);
    assert.strictEqual(edit.body.description, 'd');
});

test('the OpenAPI document matches the API: Post strings, list headers and page size, removed and multisite-only routes', () => {
    const spec = require('../config/swagger');
    const post = spec.components.schemas.Post.properties;
    assert.strictEqual(post.title.type, 'string');
    assert.strictEqual(post.content.type, 'string');
    const list = spec.paths['/posts'].get;
    assert.ok(list.responses['200'].headers['X-WP-Total']);
    assert.ok(list.responses['200'].headers['X-WP-TotalPages']);
    const perPage = list.parameters.find((p: any) => p.name === 'per_page');
    assert.strictEqual(perPage.schema.maximum, 100);
    assert.strictEqual(spec.paths['/setup/migrate'].post.deprecated, true);
    assert.match(spec.paths['/network/audit'].get.responses['404'].description, /multisite/);
    assert.ok(!spec.paths['/network/status'].get.responses['404'], 'the switch routes answer on a single site');
    for (const p of ['/healthz', '/readyz', '/metrics', '/api']) assert.strictEqual(spec.paths[p].get.servers[0].url, '/');
});

test('WPLANG must be a known language and homepage_id a published page', async () => {
    const put = (body: any) => request(app).put(`${B}/settings`).set(bearer('admin')).send(body);
    assert.strictEqual((await put({ WPLANG: 'xx_YY' })).status, 400, 'xx_YY reached <html lang>');
    assert.strictEqual((await put({ WPLANG: 'es_YY' })).status, 400, 'an unknown region');
    for (const ok of ['es_ES', 'pt-BR', 'es-419', 'pa_Arab_PK', '']) assert.strictEqual((await put({ WPLANG: ok })).status, 200, ok);

    const missing = await put({ homepage_id: '987654' });
    assert.strictEqual(missing.status, 400, JSON.stringify(missing.body));
    const draft = await request(app).post(`${B}/posts`).set(bearer('admin')).send({ type: 'page', title: 'Draft home', status: 'draft' });
    assert.strictEqual((await put({ homepage_id: String(draft.body.id) })).status, 400, 'a draft cannot be the front page');
    const page = await request(app).post(`${B}/posts`).set(bearer('admin')).send({ type: 'page', title: 'Home', status: 'publish' });
    assert.strictEqual((await put({ homepage_id: String(page.body.id) })).status, 200);
    assert.strictEqual((await put({ homepage_id: '' })).status, 200, 'empty = latest posts');
});

test('a media item in use as a featured image is reported before delete, and deleting it clears the reference', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const up = await request(app).post(`${B}/media`).set(bearer('admin')).attach('file', png, { filename: 'feat.png', contentType: 'image/png' });
    assert.strictEqual(up.status, 201, JSON.stringify(up.body));
    const post = await request(app).post(`${B}/posts`).set(bearer('admin')).send({ title: 'With image', status: 'publish', meta: { _thumbnail_id: up.body.id } });
    assert.strictEqual(post.status, 201, JSON.stringify(post.body));

    const usage = await request(app).get(`${B}/media/${up.body.id}/usage`).set(bearer('admin'));
    assert.strictEqual(usage.status, 200, JSON.stringify(usage.body));
    assert.strictEqual(usage.body.featuredIn, 1);
    assert.strictEqual(usage.body.entries[0].title, 'With image');
    assert.strictEqual((await request(app).get(`${B}/media/${up.body.id}/usage`).set(bearer('sub1'))).status, 403);

    assert.strictEqual((await request(app).delete(`${B}/media/${up.body.id}`).set(bearer('admin'))).status, 200);
    const after = await request(app).get(`${B}/posts/${post.body.id}`).set(bearer('admin'));
    assert.ok(!after.body.meta || after.body.meta._thumbnail_id === undefined, `dangling _thumbnail_id: ${JSON.stringify(after.body.meta)}`);
    assert.ok(!after.body.featuredMedia);
});

test('the single-file sitemap submits the category, tag and author archives too', async () => {
    const cat = await request(app).post(`${B}/categories`).set(bearer('admin')).send({ name: 'Sitemap Cat' });
    await request(app).post(`${B}/posts`).set(bearer('admin')).send({ title: 'In sitemap', status: 'publish', categories: [cat.body.id] });
    const res = await request(app).get(`${B}/seo/sitemap.xml`);
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /<urlset/);
    assert.match(res.text, new RegExp(`/category/${cat.body.slug}</loc>`));
    assert.match(res.text, /\/author\/[^<]+<\/loc>/);
    assert.doesNotMatch(res.text, /\/author\/admin<\/loc>/, 'the author slug is never the login');
});
