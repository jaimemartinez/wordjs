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

// ── settings that now have a control and a reader (M2-06 / M2-07) ─────────────────────────────────

const putSettings = (body: any) => request(app).put(`${B}/settings`).set(bearer('admin')).send(body);

test('the reading/writing/discussion settings are validated, and the dead keys are gone from the API', async () => {
    assert.strictEqual((await putSettings({ date_format: 'Y-m-d', time_format: 'H:i', posts_per_rss: '15', comment_max_links: '3', blog_public: '1' })).status, 200);
    assert.strictEqual((await putSettings({ date_format: 'l, jS' })).status, 400, 'only the offered formats');
    assert.strictEqual((await putSettings({ posts_per_rss: '0' })).status, 400);
    assert.strictEqual((await putSettings({ default_comment_status: 'maybe' })).status, 400);
    assert.strictEqual((await putSettings({ thumbnail_size_w: '-5' })).status, 400);
    assert.strictEqual((await putSettings({ default_category: '987654' })).status, 400, 'an existing category');
    const all = await request(app).get(`${B}/settings/all`).set(bearer('admin'));
    for (const dead of ['default_post_format', 'default_pingback_flag', 'default_ping_status', 'permalink_structure', 'start_of_week']) {
        assert.ok(!(dead in all.body), `${dead} is no longer a setting`);
    }
});

test('the posts page must be a published page other than the front page', async () => {
    const home = await request(app).post(`${B}/posts`).set(bearer('admin')).send({ type: 'page', title: 'Front', status: 'publish' });
    const blog = await request(app).post(`${B}/posts`).set(bearer('admin')).send({ type: 'page', title: 'Blog', status: 'publish' });
    assert.strictEqual((await putSettings({ homepage_id: String(home.body.id) })).status, 200);
    assert.strictEqual((await putSettings({ page_for_posts: String(home.body.id) })).status, 400, 'not the front page itself');
    assert.strictEqual((await putSettings({ page_for_posts: '987654' })).status, 400);
    assert.strictEqual((await putSettings({ page_for_posts: String(blog.body.id) })).status, 200);
    assert.strictEqual(String((await request(app).get(`${B}/settings`)).body.page_for_posts), String(blog.body.id), 'public: the SSR reads it');
    await putSettings({ page_for_posts: '', homepage_id: '' });
});

test('«Discourage search engines» closes robots.txt; new entries take the default comment status', async () => {
    await putSettings({ blog_public: '0' });
    const robots = await request(app).get(`${B}/seo/robots.txt`);
    assert.match(robots.text, /Disallow: \/\s*$/);
    assert.strictEqual((await request(app).get(`${B}/settings`)).body.blog_public, 0, 'public, so the layout can say noindex');
    await putSettings({ blog_public: '1' });
    assert.doesNotMatch((await request(app).get(`${B}/seo/robots.txt`)).text, /Disallow: \/\s*$/);

    await putSettings({ default_comment_status: 'closed' });
    const closed = await request(app).post(`${B}/posts`).set(bearer('admin')).send({ title: 'Quiet', status: 'publish' });
    assert.strictEqual(closed.body.commentStatus, 'closed');
    const explicit = await request(app).post(`${B}/posts`).set(bearer('admin')).send({ title: 'Talk', status: 'publish', comment_status: 'open' });
    assert.strictEqual(explicit.body.commentStatus, 'open');
    await putSettings({ default_comment_status: 'open' });
});

test('comment moderation rules: hold everything by default; off, approve unless a rule holds it', async () => {
    await setOption('comment_rate_anon', 1000); // six guest comments in a row: not what the limiter is for here
    const post = await request(app).post(`${B}/posts`).set(bearer('admin')).send({ title: 'Rules', status: 'publish' });
    const comment = (body: any) => request(app).post(`${B}/comments`).set(SAME_ORIGIN).send({ post: post.body.id, ...body });
    const statusOf = async (id: number) => (await request(app).get(`${B}/comments/${id}`).set(bearer('admin'))).body.status;

    const held = await comment({ author_name: 'Ana', author_email: 'ana@example.com', content: 'First!' });
    assert.strictEqual(held.status, 201, JSON.stringify(held.body));
    assert.match(String(await statusOf(held.body.id)), /^(0|pending|hold)$/, 'default: held');

    await putSettings({ comment_moderation: '0', comment_previously_approved: '1', comment_max_links: '2' });
    const stillHeld = await comment({ author_name: 'Ana', author_email: 'ana@example.com', content: 'Second' });
    assert.match(String(await statusOf(stillHeld.body.id)), /^(0|pending|hold)$/, 'no approved comment yet');
    await request(app).post(`${B}/comments/${held.body.id}/approve`).set(bearer('admin'));
    const nowOk = await comment({ author_name: 'Ana', author_email: 'ANA@example.com', content: 'Third' });
    assert.match(String(await statusOf(nowOk.body.id)), /^(1|approved)$/, 'a previously approved author is published');
    const links = await comment({ author_name: 'Ana', author_email: 'ana@example.com', content: 'see https://a.example and https://b.example' });
    assert.match(String(await statusOf(links.body.id)), /^(0|pending|hold)$/, 'two links hold it');

    const rne = await putSettings({ require_name_email: '0' });
    assert.strictEqual(rne.status, 200, JSON.stringify(rne.body));
    const anon = await comment({ content: 'No name given' });
    assert.strictEqual(anon.status, 201, JSON.stringify(anon.body));
    await putSettings({ require_name_email: '1', comment_moderation: '1' });
    assert.strictEqual((await comment({ content: 'No name again' })).status, 400);
});

test('REGRESSION: a category parent sent as a numeric string is accepted', async () => {
    const top = await request(app).post(`${B}/categories`).set(bearer('admin')).send({ name: 'String Parent Top' });
    const child = await request(app).post(`${B}/categories`).set(bearer('admin')).send({ name: 'String Parent Child', parent: String(top.body.id) });
    assert.strictEqual(child.status, 201, JSON.stringify(child.body));
    assert.strictEqual(child.body.parent, top.body.id);
});

// ── menus: submenus and new tabs (S1-14) ──────────────────────────────────────────────────────────

test('a menu item nests under another item of the same menu, opens in a new tab, and cannot loop', async () => {
    const menu = await request(app).post(`${B}/menus`).set(bearer('admin')).send({ name: 'Followup Nav', slug: 'followup-nav' });
    assert.strictEqual(menu.status, 201, JSON.stringify(menu.body));
    const other = await request(app).post(`${B}/menus`).set(bearer('admin')).send({ name: 'Other Nav', slug: 'other-nav' });
    const add = (menuId: number, body: any) => request(app).post(`${B}/menus/${menuId}/items`).set(bearer('admin')).send(body);
    const top = await add(menu.body.id, { title: 'About', url: '/about' });
    const child = await add(menu.body.id, { title: 'Team', url: '/team', parent: top.body.id, target: '_blank' });
    assert.strictEqual(child.status, 201, JSON.stringify(child.body));
    assert.strictEqual(Number(child.body.parent), top.body.id);
    assert.strictEqual(child.body.target, '_blank');

    const foreign = await add(other.body.id, { title: 'X', url: '/x' });
    assert.strictEqual((await add(menu.body.id, { title: 'Bad', url: '/b', parent: foreign.body.id })).status, 400, 'another menu’s item');
    assert.strictEqual((await add(menu.body.id, { title: 'Bad', url: '/b', target: 'evil' })).status, 400);

    const loop = await request(app).put(`${B}/menus/items/${top.body.id}`).set(bearer('admin')).send({ parent: child.body.id });
    assert.strictEqual(loop.status, 400, 'under its own sub-item');
    const self = await request(app).put(`${B}/menus/items/${top.body.id}`).set(bearer('admin')).send({ parent: top.body.id });
    assert.strictEqual(self.status, 400);
    const ok = await request(app).put(`${B}/menus/items/${child.body.id}`).set(bearer('admin')).send({ parent: 0, target: '_self' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(Number(ok.body.parent), 0);
});

// ── media: a fitted size is named by the dimensions it really has (S1-23) ──────────────────────────

test('a fitted (not cropped) size of a 3:2 photo is named by its real dimensions', async () => {
    const sharp = require('sharp');
    const { generateImageDerivatives } = require('../core/media-derivatives');
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'deriv-'));
    const file = path.join(dir, 'landscape.jpg');
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 80, b: 40 } } }).jpeg().toFile(file);
    const out = await generateImageDerivatives(file, 'image/jpeg');
    assert.strictEqual(out.sizes.medium.file, 'landscape-300x200.jpg', JSON.stringify(out.sizes.medium));
    assert.strictEqual(out.sizes.medium.height, 200);
    assert.ok(fs.existsSync(path.join(dir, 'landscape-300x200.jpg')));
    // A cropped size really is w×h.
    assert.strictEqual(out.sizes.thumbnail.file, 'landscape-150x150.jpg', JSON.stringify(out.sizes.thumbnail));
});

// ── media: image editing (S1-15) ────────────────────────────────────────────────────────────────────

test('an image is rotated, cropped and scaled into a new file; the earlier files stay, move and go with it', async () => {
    const sharp = require('sharp');
    const png = await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
    const up = await request(app).post(`${B}/media`).set(bearer('author1')).attach('file', png, { filename: 'edit-me.png', contentType: 'image/png' });
    assert.strictEqual(up.status, 201, JSON.stringify(up.body));
    const id = up.body.id;
    const publicRoot = require('../core/private-media').uploadsRootFor(false);
    const privateRoot = require('../core/private-media').uploadsRootFor(true);
    const originalFile = path.join(publicRoot, up.body.mediaDetails.file);
    assert.strictEqual(up.body.edited, false);

    const edit = (who: string, body: any) => request(app).post(`${B}/media/${id}/edit`).set(bearer(who)).send(body);
    assert.strictEqual((await edit('author1', { rotate: 45 })).status, 400);
    assert.strictEqual((await edit('author1', {})).status, 400, 'nothing to change');
    assert.strictEqual((await edit('author1', { crop: { x: 0.5, y: 0, width: 0.8, height: 1 } })).status, 400, 'outside the image');
    assert.strictEqual((await edit('sub1', { rotate: 90 })).status, 403);
    assert.strictEqual((await edit('editor1', { rotate: 90 })).status, 200, 'an editor may edit others’ media');

    // 90° turn of the (now 200×400) image → 400×200; keep the left half → 200×200; scale to 100 wide.
    const res = await edit('author1', { rotate: 90, crop: { x: 0, y: 0, width: 0.5, height: 1 }, width: 100 });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.edited, true);
    assert.strictEqual(res.body.mediaDetails.width, 100);
    assert.strictEqual(res.body.mediaDetails.height, 100);
    assert.match(res.body.mediaDetails.file, /edit-me[^/]*-e\d+\.png$/);
    assert.notStrictEqual(res.body.sourceUrl, up.body.sourceUrl, 'a new URL — the old one is cached immutable');
    const editedFile = path.join(publicRoot, res.body.mediaDetails.file);
    assert.ok(fs.existsSync(editedFile));
    assert.ok(fs.existsSync(originalFile), 'pages that show the uploaded file keep working');
    const meta = await sharp(editedFile).metadata();
    assert.deepStrictEqual([meta.width, meta.height], [100, 100]);

    // The versions are server-owned: the generic meta surface cannot point them elsewhere.
    assert.ok(require('../core/protected-meta').isProtectedPostMeta('_wjs_image_versions'));

    const restored = await request(app).post(`${B}/media/${id}/restore-original`).set(bearer('author1'));
    assert.strictEqual(restored.status, 200, JSON.stringify(restored.body));
    assert.strictEqual(restored.body.edited, false);
    assert.strictEqual(restored.body.mediaDetails.file, up.body.mediaDetails.file);
    assert.strictEqual(restored.body.mediaDetails.width, 400);
    assert.ok(fs.existsSync(editedFile), 'the edited file stays too');
    assert.strictEqual((await request(app).post(`${B}/media/${id}/restore-original`).set(bearer('author1'))).status, 409, 'not edited now');

    // Private: every version leaves the public tree.
    const priv = await request(app).put(`${B}/media/${id}`).set(bearer('author1')).send({ visibility: 'private' });
    assert.strictEqual(priv.status, 200, JSON.stringify(priv.body));
    assert.ok(!fs.existsSync(originalFile) && !fs.existsSync(editedFile), 'nothing left in the public uploads');
    assert.ok(fs.existsSync(path.join(privateRoot, res.body.mediaDetails.file)));

    const del = await request(app).delete(`${B}/media/${id}`).set(bearer('author1'));
    assert.ok([200, 204].includes(del.status), JSON.stringify(del.body));
    assert.ok(!fs.existsSync(path.join(privateRoot, res.body.mediaDetails.file)), 'every version goes with the item');
    assert.ok(!fs.existsSync(path.join(privateRoot, up.body.mediaDetails.file)));
});

// ── Redis server from the panel (M2-09) ─────────────────────────────────────────────────────────────

test('the Redis server is set from the panel: tested, saved without echoing the password, then a restart', async () => {
    const restart = require('../core/restart');
    const exits: number[] = [];
    // Run as under the service supervisor, which restarts the backend when it exits with 75.
    const supervised = process.env.WORDJS_SUPERVISED;
    process.env.WORDJS_SUPERVISED = "1";
    restart.resetForTests();
    restart.setExitHandlerForTests((code: number) => { exits.push(code); });
    try {
        const get = await request(app).get(`${B}/system/redis`).set(bearer('admin'));
        assert.strictEqual(get.status, 200, JSON.stringify(get.body));
        assert.strictEqual(get.body.inForce.configured, false, 'no Redis in this process');
        assert.strictEqual(get.body.inForce.connected, false, '«connected» only when a server answers');
        assert.strictEqual((await request(app).get(`${B}/system/redis`).set(bearer('editor1'))).status, 403);

        const bad = await request(app).put(`${B}/system/redis`).set(bearer('admin')).send({ enabled: true, host: 'not a host!', currentPassword: PASSWORD });
        assert.strictEqual(bad.status, 400);
        assert.deepStrictEqual(bad.body.data.params, ['host']);
        assert.strictEqual((await request(app).put(`${B}/system/redis`).set(bearer('admin')).send({ enabled: true, host: 'redis.internal', port: 70000, currentPassword: PASSWORD })).status, 400);
        assert.strictEqual((await request(app).put(`${B}/system/redis`).set(bearer('admin')).send({ enabled: true, host: 'redis.internal', currentPassword: 'wrong' })).status, 403);

        // A port nothing listens on: refused, in a word — never the server's own error text.
        const net = require('net');
        const srv = net.createServer();
        await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
        const closedPort = srv.address().port;
        await new Promise<void>((r) => srv.close(() => r()));
        const probe = await request(app).post(`${B}/system/redis/test`).set(bearer('admin')).send({ host: '127.0.0.1', port: closedPort });
        assert.strictEqual(probe.status, 200, JSON.stringify(probe.body));
        assert.deepStrictEqual(probe.body, { ok: false, reason: 'refused' });

        const save = await request(app).put(`${B}/system/redis`).set(bearer('admin'))
            .send({ enabled: true, host: 'redis.internal', port: 6380, db: 2, password: 's3cret-redis', currentPassword: PASSWORD });
        assert.strictEqual(save.status, 200, JSON.stringify(save.body));
        assert.strictEqual(save.body.restart, 'supervisor');
        assert.strictEqual(save.body.passwordSet, true);
        assert.ok(!JSON.stringify(save.body).includes('s3cret-redis'), 'the password is never sent back');
        const file = JSON.parse(fs.readFileSync(path.join(TMP_ROOT, 'wordjs-config.json'), 'utf8'));
        assert.deepStrictEqual(file.redis, { enabled: true, host: 'redis.internal', port: 6380, db: 2, password: 's3cret-redis' });
        for (let i = 0; i < 60 && !exits.length; i++) await new Promise((r) => setTimeout(r, 50));
        assert.strictEqual(exits[0], restart.RESTART_EXIT_CODE, 'the backend restarts itself to connect');
        restart.resetForTests();
        exits.length = 0;

        // Saving the same again (password left empty = kept) changes nothing and restarts nothing.
        const again = await request(app).put(`${B}/system/redis`).set(bearer('admin'))
            .send({ enabled: true, host: 'redis.internal', port: 6380, db: 2, currentPassword: PASSWORD });
        assert.strictEqual(again.status, 200);
        assert.strictEqual(again.body.restart, null);
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(TMP_ROOT, 'wordjs-config.json'), 'utf8')).redis.password, 's3cret-redis');
    } finally {
        restart.setExitHandlerForTests(null);
        restart.resetForTests();
        if (supervised === undefined) delete process.env.WORDJS_SUPERVISED; else process.env.WORDJS_SUPERVISED = supervised;
    }
});
