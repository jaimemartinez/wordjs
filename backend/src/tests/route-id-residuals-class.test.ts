/**
 * WordJS — THE ROUTE-ID CONTRACT, RESIDUAL MEMBERS (class suite, second pass).
 *
 * The first pass (tests/route-id-params-class.test.ts) closed the NaN spelling on FIVE routers —
 * categories, comments, menus, tags, users — and its own header says, in as many words, that the rest
 * of the class was left open. This suite is the rest of the class. It exists as a SECOND file rather
 * than as extra rows in the first because the two passes assert different things about the same
 * contract: pass one asserts "a non-numeric id is a 404", pass two asserts the two spellings that
 * survive a `Number.isInteger`/`isNaN` guard and therefore survived pass one everywhere.
 *
 * ─── RESIDUAL 1: THE RANGE REACHES THE DRIVER ────────────────────────────────────────────────────
 * `9999999999` is a perfectly good decimal integer. It passes `!Number.isNaN(n)`, it passes
 * `Number.isInteger(n) && n > 0`, it passes `Number.isFinite(n) && n > 0`, and it passes
 * `Post.findById`'s `if (!id)` short-circuit — every guard this repo had. It cannot name a row on any
 * engine, because every id column here is a 32-bit signed integer, but only ONE engine says so:
 *
 *   • SQLite   — binds the double, matches nothing, answers a correct 404;
 *   • MySQL    — coerces/clamps, matches nothing, answers a correct 404;
 *   • Postgres — refuses the bind: `22003 value "9999999999" is out of range for type integer` → 500.
 *
 * So the SQLite suite was green and `GET /api/v1/posts/9999999999` — reachable ANONYMOUSLY, since that
 * route is `optionalAuth` — was a 500 with a driver error in it on the engine most deployments run.
 * That is why the Postgres block below is the load-bearing one and why an unreachable Postgres is a
 * hard failure under WORDJS_CI_DB=1 rather than a silent skip.
 *
 * ─── RESIDUAL 2: THE SHAPE IS NOT ENFORCED ───────────────────────────────────────────────────────
 * `parseInt` stops at the first character it cannot use and returns what it has: `parseInt('12abc',10)`
 * is 12. Nothing downstream ever sees the 'abc'. So `/api/v1/posts/12abc` SERVED POST 12 with a 200 —
 * on every engine, with no error anywhere — and every id had an infinite family of spellings. That is
 * not cosmetic: a spelling is a distinct cache key, a distinct rate-limit bucket and a distinct
 * audit-log line for one and the same row, and `12abc`/`12%20`/`12.9` all resolve to 12 while looking
 * to any log reader like three different resources. A route id is the id or it is nothing.
 *
 * The bad ids below are therefore DERIVED FROM THE REAL FIXTURE ID (`${realId}abc`), not hardcoded:
 * that is what makes the assertion "must not serve the row it is a prefix of" rather than the much
 * weaker "must not 500".
 *
 * ─── WHAT EACH ROUTER MUST ANSWER ────────────────────────────────────────────────────────────────
 * Not one status for everybody. A router that ALREADY refused a malformed id keeps the status it
 * already sent, because flipping an established API answer is a breaking change that this defect does
 * not justify; what changes is the PREDICATE behind it, which becomes the single shared one:
 *
 *   404 (router-level `requireRouteId` contract, byte-identical to that router's own not-found body):
 *        posts.ts, media.ts, seo.ts, revisions.ts  — these had NO guard at all.
 *   400 (the router's own existing refusal, now driven by the shared `routeIdOrNull`):
 *        webhooks.ts, collab.ts, presence.ts, auth.ts, forms.ts — these already answered 400.
 *
 * ─── THE POSITIVE CONTROL ────────────────────────────────────────────────────────────────────────
 * Every refusal assertion below can be passed by a router that is simply broken — one that never
 * mounted, or whose gate refuses the token. `assertRealIdsStillWork` sends a REAL id to every router
 * in the table first, so a refusal can only mean the contract fired.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST so incidental writes stay out of the repo.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-route-id-res-'));
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer / routers load.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

/**
 * RESIDUAL 1. Wider than a 32-bit signed integer, so it cannot name a row — and Postgres says so with
 * `22003 value out of range for type integer`, i.e. a 500, unless the request is refused first.
 */
const OUT_OF_RANGE = '9999999999';

// A missing engine is a graceful skip locally; under WORDJS_CI_DB=1 the service containers are wired
// precisely so these run, and an unreachable engine there is a hard FAILURE, never a silent green.
function skipOrFail(t: any, reason: string): void {
    if (process.env.WORDJS_CI_DB === '1') assert.fail(reason);
    return t.skip(reason);
}

type Method = 'get' | 'put' | 'post' | 'patch' | 'delete';

interface Fixtures {
    token: string;
    adminId: number;
    postId: number;
    mediaId: number;
    revisionId: number;
    webhookId: number;
    deliveryProbeId: number;
    submissionId: number;
    apiTokenId: number;
}

interface Site {
    /** Route file the site lives in. The table spans the NINE routers the first pass did not own. */
    file: string;
    method: Method;
    /** Built from an id STRING so one row drives the real id and both bad spellings alike. */
    url: (id: string) => string;
    /** The fixture id that really names a row for this site — the base of the `${real}abc` spelling. */
    real: (f: Fixtures) => number;
    /** The status this router must answer for an id that cannot name a row (404 contract / 400 guard). */
    refuse: number;
    /** The `code` in that refusal, where the router sends one. Bodies without a `code` set this null. */
    refuseCode: string | null;
    body?: Record<string, unknown>;
}

/**
 * THE DERIVED LIST: every route parameter in backend/src/routes that denotes a NUMERIC ROW ID and was
 * not already covered by the first pass. Derived mechanically (every `router.<verb>('…:name…')` in
 * every router, then each parameter read one by one to see what it is), not from a bug report.
 *
 * The parameters deliberately left out are the ones that are not ids at all, and they are listed in
 * NOT_IDS below so the exclusion is evidence rather than memory.
 */
const SITES: Site[] = [
    // ── routes/posts.ts — 9 sites, NO guard of any kind. `parseInt(req.params.id, 10)` straight into
    //    Post.findById. GET /:id is `optionalAuth`, so the 500 was anonymous.
    { file: 'posts.ts', method: 'get', url: (i) => `/api/v1/posts/${i}`, real: (f) => f.postId, refuse: 404, refuseCode: 'rest_post_invalid_id' },
    { file: 'posts.ts', method: 'put', url: (i) => `/api/v1/posts/${i}`, real: (f) => f.postId, refuse: 404, refuseCode: 'rest_post_invalid_id', body: { title: 'x' } },
    { file: 'posts.ts', method: 'delete', url: (i) => `/api/v1/posts/${i}`, real: (f) => f.postId, refuse: 404, refuseCode: 'rest_post_invalid_id' },
    { file: 'posts.ts', method: 'get', url: (i) => `/api/v1/posts/${i}/meta`, real: (f) => f.postId, refuse: 404, refuseCode: 'rest_post_invalid_id' },
    { file: 'posts.ts', method: 'post', url: (i) => `/api/v1/posts/${i}/meta`, real: (f) => f.postId, refuse: 404, refuseCode: 'rest_post_invalid_id', body: { key: 'probe', value: 'v' } },
    { file: 'posts.ts', method: 'put', url: (i) => `/api/v1/posts/${i}/language`, real: (f) => f.postId, refuse: 404, refuseCode: 'rest_post_invalid_id', body: { language: 'en' } },
    { file: 'posts.ts', method: 'get', url: (i) => `/api/v1/posts/${i}/translations`, real: (f) => f.postId, refuse: 404, refuseCode: 'rest_post_invalid_id' },
    { file: 'posts.ts', method: 'post', url: (i) => `/api/v1/posts/${i}/translations`, real: (f) => f.postId, refuse: 404, refuseCode: 'rest_post_invalid_id', body: { translationId: 1, language: 'es' } },
    { file: 'posts.ts', method: 'delete', url: (i) => `/api/v1/posts/${i}/translations`, real: (f) => f.postId, refuse: 404, refuseCode: 'rest_post_invalid_id' },

    // ── routes/media.ts — 3 sites, NO guard. Media.findById delegates to Post.findById, same sink.
    { file: 'media.ts', method: 'get', url: (i) => `/api/v1/media/${i}`, real: (f) => f.mediaId, refuse: 404, refuseCode: 'rest_post_invalid_id' },
    { file: 'media.ts', method: 'put', url: (i) => `/api/v1/media/${i}`, real: (f) => f.mediaId, refuse: 404, refuseCode: 'rest_post_invalid_id', body: { title: 'x' } },
    { file: 'media.ts', method: 'delete', url: (i) => `/api/v1/media/${i}`, real: (f) => f.mediaId, refuse: 404, refuseCode: 'rest_post_invalid_id' },

    // ── routes/seo.ts — 1 site. `if (!postId)` catches NaN and 0 and nothing else; its not-found body
    //    is `{ error: 'Post not found' }`, with no `code` at all.
    { file: 'seo.ts', method: 'get', url: (i) => `/api/v1/seo/meta/${i}`, real: (f) => f.postId, refuse: 404, refuseCode: null },

    // ── routes/revisions.ts — `revisionIdOrNull` rejected ONLY NaN (`Number.isNaN(id) ? null : id`),
    //    so every out-of-range and every '12abc' spelling walked straight through it.
    { file: 'revisions.ts', method: 'get', url: (i) => `/api/v1/revisions/${i}`, real: (f) => f.revisionId, refuse: 404, refuseCode: null },
    { file: 'revisions.ts', method: 'post', url: (i) => `/api/v1/revisions/${i}/restore`, real: (f) => f.revisionId, refuse: 404, refuseCode: null },
    { file: 'revisions.ts', method: 'delete', url: (i) => `/api/v1/revisions/${i}`, real: (f) => f.revisionId, refuse: 404, refuseCode: null },
    { file: 'revisions.ts', method: 'get', url: (i) => `/api/v1/revisions/compare/${i}/${i}`, real: (f) => f.revisionId, refuse: 404, refuseCode: null },
    // `:postId` here had NO guard at all — a bare `parseInt(String(req.params.postId), 10)` handed to
    // authorizeForPost → Post.findById. Its not-found body is the `rest_post_invalid_id` one.
    { file: 'revisions.ts', method: 'get', url: (i) => `/api/v1/revisions/post/${i}`, real: (f) => f.postId, refuse: 404, refuseCode: 'rest_post_invalid_id' },

    // ── routes/webhooks.ts — 6 sites behind `parseId` (`Number.isInteger(n) && n > 0`): integrality and
    //    positivity, no upper bound and no shape check. Keeps its 400.
    { file: 'webhooks.ts', method: 'get', url: (i) => `/api/v1/webhooks/${i}`, real: (f) => f.webhookId, refuse: 400, refuseCode: 'rest_invalid_param' },
    { file: 'webhooks.ts', method: 'get', url: (i) => `/api/v1/webhooks/${i}/deliveries`, real: (f) => f.webhookId, refuse: 400, refuseCode: 'rest_invalid_param' },
    { file: 'webhooks.ts', method: 'post', url: (i) => `/api/v1/webhooks/${i}/rotate-secret`, real: (f) => f.webhookId, refuse: 400, refuseCode: 'rest_invalid_param' },
    { file: 'webhooks.ts', method: 'patch', url: (i) => `/api/v1/webhooks/${i}`, real: (f) => f.webhookId, refuse: 400, refuseCode: 'rest_invalid_param', body: { active: false } },
    { file: 'webhooks.ts', method: 'delete', url: (i) => `/api/v1/webhooks/${i}`, real: (f) => f.webhookId, refuse: 400, refuseCode: 'rest_invalid_param' },
    { file: 'webhooks.ts', method: 'post', url: (i) => `/api/v1/webhooks/deliveries/${i}/redeliver`, real: (f) => f.deliveryProbeId, refuse: 400, refuseCode: 'rest_invalid_param' },

    // ── routes/collab.ts — 5 sites behind `parsePostId` (`Number.isFinite(n) && n > 0`). Even weaker:
    //    isFinite accepts 1.5, so `/collab/1.5/ops` was "post 1". Keeps its 400.
    { file: 'collab.ts', method: 'get', url: (i) => `/api/v1/collab/${i}/stream`, real: (f) => f.postId, refuse: 400, refuseCode: 'rest_invalid_param' },
    { file: 'collab.ts', method: 'post', url: (i) => `/api/v1/collab/${i}/ops`, real: (f) => f.postId, refuse: 400, refuseCode: 'rest_invalid_param', body: { siteId: 'probe', ops: [] } },
    { file: 'collab.ts', method: 'post', url: (i) => `/api/v1/collab/${i}/presence`, real: (f) => f.postId, refuse: 400, refuseCode: 'rest_invalid_param', body: { siteId: 'probe' } },
    { file: 'collab.ts', method: 'post', url: (i) => `/api/v1/collab/${i}/resync`, real: (f) => f.postId, refuse: 400, refuseCode: 'rest_invalid_param', body: { siteId: 'probe' } },
    { file: 'collab.ts', method: 'post', url: (i) => `/api/v1/collab/${i}/leave`, real: (f) => f.postId, refuse: 400, refuseCode: 'rest_invalid_param', body: { siteId: 'probe' } },

    // ── routes/presence.ts — 1 site, `Number.isFinite(n) && n > 0`. Body carries no `code`. Keeps 400.
    { file: 'presence.ts', method: 'post', url: (i) => `/api/v1/presence/${i}`, real: (f) => f.postId, refuse: 400, refuseCode: null, body: {} },

    // ── routes/auth.ts — 1 site, `Number.isInteger(id) && id > 0`. Keeps 400.
    { file: 'auth.ts', method: 'delete', url: (i) => `/api/v1/auth/tokens/${i}`, real: (f) => f.apiTokenId, refuse: 400, refuseCode: 'rest_invalid_param' },

    // ── routes/forms.ts — 1 site, `Number.isInteger(id) && id > 0`. Keeps 400.
    { file: 'forms.ts', method: 'delete', url: (i) => `/api/v1/forms/submissions/${i}`, real: (f) => f.submissionId, refuse: 400, refuseCode: 'rest_invalid_param' },
];

/**
 * NOT MEMBERS OF THE CLASS, and asserted as such so "we left it alone" is evidence and not a claim.
 * Every one of these route parameters is a STRING key — a slug, a filename, a uuid, an option key, a
 * taxonomy or post-type name, a sidebar/widget/instance key. Feeding them `9999999999` or `12abc` is
 * feeding them a perfectly ordinary string that names nothing, which is a 404/400 by their own logic
 * and never reaches an integer column. Applying the id contract to them would BREAK them.
 */
const NOT_IDS: Array<{ file: string; param: string; why: string }> = [
    { file: 'backups.ts', param: 'filename', why: 'a backup filename' },
    { file: 'chrome.ts', param: 'part', why: 'a named chrome part' },
    { file: 'fonts.ts', param: 'filename', why: 'a font filename' },
    { file: 'menus.ts', param: 'location', why: 'a theme menu-location name' },
    { file: 'notices.ts', param: 'id', why: 'a STRING notice id inside the admin_notices option array — never a row id' },
    { file: 'notifications.ts', param: 'uuid', why: 'a uuid' },
    { file: 'plugin-bundles.ts', param: 'slug', why: 'a plugin slug' },
    { file: 'plugins.ts', param: 'slug', why: 'a plugin slug' },
    { file: 'post-types.ts', param: 'name', why: 'a post-type name' },
    { file: 'posts.ts', param: 'slug', why: 'a post slug' },
    { file: 'roles.ts', param: 'slug', why: 'a role slug' },
    { file: 'settings.ts', param: 'key', why: 'an option key' },
    { file: 'taxonomies.ts', param: 'name', why: 'a taxonomy name' },
    { file: 'themes.ts', param: 'slug', why: 'a theme slug' },
    { file: 'widgets.ts', param: 'id', why: 'a sidebar slug (core/widgets.ts: renderSidebar(sidebarId: string))' },
    { file: 'widgets.ts', param: 'sidebarId', why: 'a sidebar slug' },
    { file: 'widgets.ts', param: 'widgetId', why: 'a widget slug' },
    { file: 'widgets.ts', param: 'instanceId', why: 'a widget instance key' },
    { file: 'widgets.ts', param: 'instanceKey', why: 'a widget instance key' },
];

/**
 * The routers whose real ids must still work, and the answer a real id gets. One row per router in the
 * table above, so no refusal below can be a false pass from a router that never mounted.
 */
interface Control { file: string; method: Method; url: (f: Fixtures) => string; ok: number[]; body?: any; why?: string }
const CONTROLS: Control[] = [
    { file: 'posts.ts', method: 'get', url: (f) => `/api/v1/posts/${f.postId}`, ok: [200] },
    { file: 'media.ts', method: 'get', url: (f) => `/api/v1/media/${f.mediaId}`, ok: [200] },
    { file: 'seo.ts', method: 'get', url: (f) => `/api/v1/seo/meta/${f.postId}`, ok: [200] },
    { file: 'revisions.ts', method: 'get', url: (f) => `/api/v1/revisions/${f.revisionId}`, ok: [200] },
    { file: 'revisions.ts', method: 'get', url: (f) => `/api/v1/revisions/post/${f.postId}`, ok: [200] },
    { file: 'webhooks.ts', method: 'get', url: (f) => `/api/v1/webhooks/${f.webhookId}`, ok: [200] },
    { file: 'presence.ts', method: 'post', url: (f) => `/api/v1/presence/${f.postId}`, ok: [200], body: {} },
    // collab needs a LIVE SSE connection to answer 200, which supertest cannot hold open. 409
    // `collab_no_session` is the answer that proves what this control has to prove: the id was
    // accepted, the post was found, and the capability gate passed — the request died one step later,
    // for the documented want of an open room.
    {
        file: 'collab.ts', method: 'post', url: (f) => `/api/v1/collab/${f.postId}/ops`, ok: [409],
        body: { siteId: 'probe', ops: [] },
        why: '409 collab_no_session = id accepted, post found, gate passed, no open SSE room',
    },
    // These two CONSUME their fixture, so they run last within the control pass.
    { file: 'forms.ts', method: 'delete', url: (f) => `/api/v1/forms/submissions/${f.submissionId}`, ok: [200] },
    { file: 'auth.ts', method: 'delete', url: (f) => `/api/v1/auth/tokens/${f.apiTokenId}`, ok: [200] },
];

/** The real router tree, exactly as index.ts mounts it — a status here can only have come from a route. */
function mountApp() {
    const express = require('express');
    const cookieParser = require('cookie-parser');
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use(cookieParser());
    app.use('/api/v1', require('../routes'));
    return app;
}

const sign = (userId: number) =>
    jwt.sign({ userId, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

/**
 * Seed through the REAL producers (the models and services the routes read back), not hand-written
 * rows, so a positive control cannot pass against a fixture the routes would never have created.
 */
async function seedFixtures(dbAsync: any): Promise<Fixtures> {
    await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        ['admin', 'x', 'admin@example.com', 'admin']);
    const adminRow = await dbAsync.get(`SELECT id FROM users WHERE user_login = ?`, ['admin']);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`,
        [adminRow.id, 'administrator']);

    await require('../core/post-types').initPostTypes();
    await require('../core/roles').loadRoles();

    const Post = require('../models/Post');
    const Media = require('../models/Media');
    const Webhook = require('../models/Webhook');
    const FormSubmission = require('../models/FormSubmission');
    const ApiToken = require('../models/ApiToken');
    const { saveRevision } = require('../core/revisions');

    const post = await Post.create({
        authorId: adminRow.id, title: 'Residual host post', content: '<p>body</p>',
        status: 'publish', type: 'post', slug: 'route-id-residual-host',
    });

    const media = await Media.create({
        authorId: adminRow.id, title: 'Residual media', filename: 'probe.png',
        mimeType: 'image/png', filePath: 'probe.png', fileSize: 10, width: 1, height: 1,
    });

    // saveRevision snapshots the CURRENT parent row and returns the new revision's id (a number, not a
    // record), so this is the id itself.
    const revisionId: number = await saveRevision(post.id);

    const webhook = await Webhook.create({
        userId: adminRow.id, name: 'probe', url: 'https://example.com/hook', events: ['post.published'],
    });

    const submission = await FormSubmission.create({
        formName: 'probe', fields: { email: 'a@example.com' },
    });

    const apiToken = await ApiToken.generate({ userId: adminRow.id, name: 'probe' });

    return {
        token: sign(adminRow.id),
        adminId: adminRow.id,
        postId: post.id,
        mediaId: media.id ?? media.attachmentId,
        revisionId,
        webhookId: webhook.id ?? webhook.webhookId,
        // No delivery row is seeded: `POST /deliveries/:id/redeliver` refuses a bad id before it looks
        // anything up, which is the only thing this table asserts about it. A real id there answers a
        // legitimate 404 and is covered by the webhooks control on the sibling route.
        deliveryProbeId: 1,
        submissionId: submission.id ?? submission.submissionId,
        apiTokenId: apiToken.id ?? apiToken.tokenId ?? apiToken.record?.id,
    };
}

const describeSite = (s: Site, id: string) => `${s.method.toUpperCase()} ${s.url(id)} [${s.file}]`;

function send(request: any, app: any, s: Site, id: string, token: string) {
    const r = (request(app) as any)[s.method](s.url(id)).set('Authorization', `Bearer ${token}`);
    return s.body ? r.send(s.body) : r;
}

/** POSITIVE CONTROL — every router in the table still serves an id that really names a row. */
async function assertRealIdsStillWork(request: any, app: any, f: Fixtures, engine: string) {
    for (const c of CONTROLS) {
        const url = c.url(f);
        const r = (request(app) as any)[c.method](url).set('Authorization', `Bearer ${f.token}`);
        const res = c.body ? await r.send(c.body) : await r;
        assert.ok(c.ok.includes(res.status),
            `${engine}: positive control ${c.method.toUpperCase()} ${url} [${c.file}] must answer one of ` +
            `${JSON.stringify(c.ok)}${c.why ? ` (${c.why})` : ''}, got ${res.status} ${JSON.stringify(res.body)}`);
    }
}

/**
 * RESIDUAL 1 — an id wider than the 32-bit id columns is refused before the driver sees it.
 * On Postgres the unfixed code answers 500 here with `22003 value out of range for type integer`.
 */
async function assertOutOfRangeIsRefused(request: any, app: any, f: Fixtures, engine: string) {
    for (const s of SITES) {
        const res = await send(request, app, s, OUT_OF_RANGE, f.token);
        assert.strictEqual(res.status, s.refuse,
            `${engine}: ${describeSite(s, OUT_OF_RANGE)} must answer ${s.refuse}, got ${res.status} — ` +
            `${JSON.stringify(res.body)}. An id wider than the id columns cannot name a row and must ` +
            `never be bound into a query.`);
        if (s.refuseCode !== null) {
            assert.strictEqual(res.body && res.body.code, s.refuseCode,
                `${engine}: ${describeSite(s, OUT_OF_RANGE)} must answer this router's own code ` +
                `'${s.refuseCode}', got ${JSON.stringify(res.body)}`);
        }
    }
}

/**
 * RESIDUAL 2 — `${realId}abc` is NOT an alias for `realId`.
 *
 * The id is built from the fixture, so this asserts the strong form: the request must not serve the
 * very row it is a prefix of. `parseInt` made it serve exactly that row, with a 200.
 */
async function assertShapeIsRefused(request: any, app: any, f: Fixtures, engine: string) {
    for (const s of SITES) {
        const bad = `${s.real(f)}abc`;
        const res = await send(request, app, s, bad, f.token);
        assert.strictEqual(res.status, s.refuse,
            `${engine}: ${describeSite(s, bad)} must answer ${s.refuse}, got ${res.status} — ` +
            `${JSON.stringify(res.body)}. parseInt('${bad}', 10) is ${parseInt(bad, 10)}, so this URL was ` +
            `an alias for the real row; a route id must be the id or nothing.`);
    }
}

/** The trailing-garbage spelling must not have SERVED the row — status alone could hide a 200 body. */
async function assertShapeDidNotServeTheRow(request: any, app: any, f: Fixtures, engine: string) {
    const res = await request(app).get(`/api/v1/posts/${f.postId}abc`);
    assert.notStrictEqual(res.status, 200,
        `${engine}: anonymous GET /api/v1/posts/${f.postId}abc must not serve post ${f.postId}, ` +
        `got ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    assert.notStrictEqual(res.body && res.body.id, f.postId,
        `${engine}: GET /api/v1/posts/${f.postId}abc returned post ${f.postId} itself`);
}

/**
 * The anonymous leg. `GET /posts/:id` is `optionalAuth`, so the out-of-range 500 needed no credentials
 * at all — this is the reachability half of residual 1 and the reason it is not a cosmetic bug.
 */
async function assertAnonymousOutOfRangeIsRefused(request: any, app: any, engine: string) {
    for (const url of [`/api/v1/posts/${OUT_OF_RANGE}`, `/api/v1/media/${OUT_OF_RANGE}`, `/api/v1/posts/${OUT_OF_RANGE}/meta`]) {
        const res = await request(app).get(url);
        assert.strictEqual(res.status, 404,
            `${engine}: anonymous GET ${url} must be 404 (the id can name no row), got ${res.status} ` +
            `${JSON.stringify(res.body)}`);
    }
}

/**
 * The non-ids stay non-ids. A string parameter must keep answering its own way for a value that merely
 * LOOKS like an out-of-range id — proof that the contract was not sprayed over the whole route table.
 */
async function assertNonIdParamsUntouched(request: any, app: any, f: Fixtures, engine: string) {
    const probes: Array<[string, string, number[]]> = [
        ['posts.ts:slug', `/api/v1/posts/slug/${OUT_OF_RANGE}`, [404]],
        // 403 is this router's own answer for a key that is not on the public allowlist — reached by
        // the key LOOKUP, which is exactly the point: a numeric-looking option key is still just a key.
        ['settings.ts:key', `/api/v1/settings/${OUT_OF_RANGE}`, [200, 403, 404]],
        ['taxonomies.ts:name', `/api/v1/taxonomies/${OUT_OF_RANGE}`, [404]],
        ['post-types.ts:name', `/api/v1/post-types/${OUT_OF_RANGE}`, [404]],
        ['themes.ts:slug', `/api/v1/themes/${OUT_OF_RANGE}`, [404, 405]],
    ];
    for (const [what, url, ok] of probes) {
        const res = await request(app).get(url).set('Authorization', `Bearer ${f.token}`);
        assert.ok(ok.includes(res.status),
            `${engine}: ${what} is NOT a row id and must be unaffected by the id contract — ` +
            `GET ${url} answered ${res.status} ${JSON.stringify(res.body)}, expected one of ${JSON.stringify(ok)}`);
    }
}

/** The exclusion list is a claim about the code; assert it is still true of the code. */
function assertNotIdsAreStillNotIds() {
    const routesDir = path.join(__dirname, '..', 'routes');
    for (const n of NOT_IDS) {
        const src = fs.readFileSync(path.join(routesDir, n.file), 'utf8');
        const declared = new RegExp(`router\\.param\\(\\s*['"\`]${n.param}['"\`]`).test(src);
        assert.strictEqual(declared, false,
            `${n.file} declares the route-id contract for ':${n.param}', but that parameter is ${n.why}. ` +
            `Enforcing an integer shape on it would refuse every legitimate request.`);
    }
}

/** One definition of "a route id" in the tree: the local guards must call the shared predicate. */
function assertOnePredicate() {
    const routesDir = path.join(__dirname, '..', 'routes');
    const mustUseShared: Array<[string, string]> = [
        ['webhooks.ts', 'parseId'],
        ['collab.ts', 'parsePostId'],
        ['revisions.ts', 'revisionIdOrNull'],
        ['presence.ts', 'POST /:postId'],
        ['auth.ts', 'DELETE /tokens/:id'],
        ['forms.ts', 'DELETE /submissions/:id'],
    ];
    for (const [file, what] of mustUseShared) {
        const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
        assert.ok(/routeIdOrNull/.test(src),
            `${file} (${what}) must resolve its route id with the shared routeIdOrNull() from ` +
            `core/query-params, not with a local predicate. A second definition of "a route id" is how ` +
            `this class stayed open: each copy checked a different subset of the shape.`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// SQLite — hides residual 1 entirely (it binds the wide double and matches nothing) but shows
// residual 2 in full, because parseInt runs before any engine is involved.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('route-id residuals — SQLite', () => {
    let request: any, app: any, f: Fixtures;

    before(async () => {
        request = require('supertest');
        config.dbDriver = 'sqlite-native';
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        f = await seedFixtures(database.getDbAsync());
        app = mountApp();
    });

    after(async () => { try { await database.closeDatabase(); } catch { /* ignore */ } });

    it('an id with trailing garbage is refused at every residual site', async () => {
        await assertShapeIsRefused(request, app, f, 'sqlite');
    });
    it('an id with trailing garbage never serves the row it is a prefix of', async () => {
        await assertShapeDidNotServeTheRow(request, app, f, 'sqlite');
    });
    it('an id wider than the id columns is refused at every residual site', async () => {
        await assertOutOfRangeIsRefused(request, app, f, 'sqlite');
    });
    it('the anonymous routes refuse an out-of-range id too', async () => {
        await assertAnonymousOutOfRangeIsRefused(request, app, 'sqlite');
    });
    it('route parameters that are not ids are untouched', async () => {
        await assertNonIdParamsUntouched(request, app, f, 'sqlite');
    });
    it('every residual router still serves a real id (positive control)', async () => {
        await assertRealIdsStillWork(request, app, f, 'sqlite');
    });
    it('there is exactly one definition of "a route id" in the route tree', () => {
        assertOnePredicate();
    });
    it('the contract was not applied to parameters that are not row ids', () => {
        assertNotIdsAreStillNotIds();
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Postgres — THE load-bearing block. It is the engine that turns residual 1 into a 500, and the only
// engine that does. An unreachable Postgres under WORDJS_CI_DB=1 fails rather than skips.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('route-id residuals — PostgreSQL', () => {
    const DBNAME = `wordjs_routeid_res_pg_${process.pid}`;
    let request: any, app: any, f: Fixtures, reachable = false;

    const adminCfg = () => ({
        host: process.env.PGHOST || '127.0.0.1',
        port: Number(process.env.PGPORT || 5432),
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || 'password',
        database: 'postgres',
    });

    before(async () => {
        request = require('supertest');
        try {
            // A THROWAWAY database per run: a suite that reuses one makes its verdict depend on history.
            const { Client } = require('pg');
            const admin = new Client(adminCfg());
            await admin.connect();
            await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
            await admin.query(`CREATE DATABASE ${DBNAME}`);
            await admin.end();
        } catch {
            return; // reachable stays false; every test skipOrFails
        }
        config.dbDriver = 'postgres';
        config.db = { ...adminCfg(), name: DBNAME };
        await database.init({ driver: 'postgres' });
        await database.initializeDatabase();
        f = await seedFixtures(database.getDbAsync());
        app = mountApp();
        reachable = true;
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try {
            const { Client } = require('pg');
            const admin = new Client(adminCfg());
            await admin.connect();
            await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
            await admin.end();
        } catch { /* ignore */ }
    });

    it('an id wider than the id columns is refused at every residual site', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'Postgres unreachable');
        await assertOutOfRangeIsRefused(request, app, f, 'postgres');
    });
    it('the anonymous routes refuse an out-of-range id too', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'Postgres unreachable');
        await assertAnonymousOutOfRangeIsRefused(request, app, 'postgres');
    });
    it('an id with trailing garbage is refused at every residual site', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'Postgres unreachable');
        await assertShapeIsRefused(request, app, f, 'postgres');
    });
    it('an id with trailing garbage never serves the row it is a prefix of', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'Postgres unreachable');
        await assertShapeDidNotServeTheRow(request, app, f, 'postgres');
    });
    it('route parameters that are not ids are untouched', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'Postgres unreachable');
        await assertNonIdParamsUntouched(request, app, f, 'postgres');
    });
    it('every residual router still serves a real id (positive control)', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'Postgres unreachable');
        await assertRealIdsStillWork(request, app, f, 'postgres');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// MySQL — clamps the wide value rather than refusing it, so residual 1 was a silent wrong-answer here
// instead of a 500. Same contract, third engine.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('route-id residuals — MySQL', () => {
    const DBNAME = `wordjs_routeid_res_my_${process.pid}`;
    let request: any, app: any, f: Fixtures, reachable = false;

    const adminCfg = () => ({
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || 'password',
    });

    before(async () => {
        request = require('supertest');
        try {
            const mysql = require('mysql2/promise');
            const admin = await mysql.createConnection(adminCfg());
            await admin.query(`DROP DATABASE IF EXISTS \`${DBNAME}\``);
            await admin.query(`CREATE DATABASE \`${DBNAME}\``);
            await admin.end();
        } catch {
            return; // reachable stays false
        }
        config.dbDriver = 'mysql';
        config.db = { ...adminCfg(), name: DBNAME };
        await database.init({ driver: 'mysql' });
        await database.initializeDatabase();
        f = await seedFixtures(database.getDbAsync());
        app = mountApp();
        reachable = true;
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try {
            const mysql = require('mysql2/promise');
            const admin = await mysql.createConnection(adminCfg());
            await admin.query(`DROP DATABASE IF EXISTS \`${DBNAME}\``);
            await admin.end();
        } catch { /* ignore */ }
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('an id wider than the id columns is refused at every residual site', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'MySQL unreachable');
        await assertOutOfRangeIsRefused(request, app, f, 'mysql');
    });
    it('an id with trailing garbage is refused at every residual site', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'MySQL unreachable');
        await assertShapeIsRefused(request, app, f, 'mysql');
    });
    it('every residual router still serves a real id (positive control)', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'MySQL unreachable');
        await assertRealIdsStillWork(request, app, f, 'mysql');
    });
});
