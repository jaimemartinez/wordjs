/**
 * WordJS — numeric route/query params on the revisions router (regression suite).
 *
 * Typing the HTTP boundary (f95f139f) made every `req.params.x` / `req.query.x` a string that has to be
 * pushed through `String()` before `parseInt()`. That surfaced two real defects the untyped code hid:
 *
 *  1. RADIX. `/revisions/post/:postId` parsed `limit`/`offset` with NO radix while every other parseInt
 *     in the router passes 10. `parseInt('0x3')` is 3, so `?limit=0x3` was silently honoured as 3 and
 *     `?offset=0x3` as 3 — a hexadecimal spelling of a parameter Swagger declares `type: integer`, and
 *     one that disagrees with the decimal reading any client (or its pagination arithmetic) applies.
 *     Pinned on SQLite: it is pure parsing, identical on every engine.
 *
 *  2. NaN REACHING THE DRIVER. A non-numeric `:id` yields NaN from parseInt, and the routes that take a
 *     REVISION id hand that NaN straight to `getRevision()` → `SELECT ... WHERE id = ?`. The
 *     `authorizeForPost` null-guard cannot catch it (it runs AFTER the lookup, and `NaN == null` is
 *     false anyway). SQLite silently matches no row, so the whole SQLite suite sees a correct 404 —
 *     but Postgres rejects the bind with `22P02 invalid input syntax for type integer: "NaN"` and
 *     MySQL with `Unknown column 'NaN' in 'where clause'`, both surfacing as a 500 that echoes the raw
 *     driver error. Only a real Postgres/MySQL can show this, so those blocks run against the live CI
 *     engines (skipped locally when unreachable, hard-failed under WORDJS_CI_DB=1).
 *
 *     `/revisions/post/:postId` is deliberately asserted here too, as a CHARACTERIZATION: it was NOT
 *     defective. Its NaN never reaches the driver because `Post.findById` short-circuits on `if (!id)`
 *     — and `!NaN` is true — so the route already answered a correct 404 `rest_post_invalid_id` on all
 *     three engines. That assertion is green before and after the fix on purpose: it is the evidence
 *     that nothing needed changing there.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST (incidental writes stay out of the repo).
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-rev-numeric-'));
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer / routers load.
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const jwt = require('jsonwebtoken');

// A missing engine is a graceful skip locally, but CI (WORDJS_CI_DB=1) wires the service containers
// precisely so these run — there an unreachable engine is a hard FAILURE, never a silent green.
function skipOrFail(t: any, reason: string): void {
    if (process.env.WORDJS_CI_DB === '1') assert.fail(reason);
    return t.skip(reason);
}

/** Mount ONLY the revisions router, so a status code can only have come from it. */
function mountRevisionsApp() {
    const express = require('express');
    const { errorHandler } = require('../middleware/errorHandler');
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/v1/revisions', require('../routes/revisions'));
    app.use(errorHandler);
    return app;
}

async function seedAdmin(dbAsync: any): Promise<number> {
    await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        ['admin', 'x', 'admin@example.com', 'admin']
    );
    const row = await dbAsync.get(`SELECT id FROM users WHERE user_login = ?`, ['admin']);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`,
        [row.id, 'administrator']);
    return row.id;
}

const sign = (userId: number) =>
    jwt.sign({ userId, username: 'admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });

/**
 * Every route that takes a REVISION id, i.e. every place a non-numeric param became NaN and was sent to
 * the driver. `/revisions/post/:postId` is NOT here — see the characterization test.
 */
const REVISION_ID_ROUTES: Array<[string, string]> = [
    ['get', '/api/v1/revisions/abc'],
    ['delete', '/api/v1/revisions/abc'],
    ['post', '/api/v1/revisions/abc/restore'],
    ['get', '/api/v1/revisions/compare/abc/def'],
];

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1. RADIX — pure parsing, engine-independent, so SQLite is enough.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('revisions router: limit/offset must be parsed base 10', () => {
    let request: any, app: any, dbAsync: any, token: string, postId: number;
    const REVISION_COUNT = 5;

    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        await require('../core/post-types').initPostTypes();

        const adminId = await seedAdmin(dbAsync);
        token = sign(adminId);

        // Seed through the REAL producer (saveRevision), not hand-written rows, so the fixture cannot
        // drift from what the reader expects. Its own cap is 10, hence 5 revisions and a hex "3".
        const Post = require('../models/Post');
        const { saveRevision } = require('../core/revisions');
        const post = await Post.create({
            authorId: adminId, title: 'Radix host', content: '<p>v0</p>',
            status: 'publish', type: 'post', slug: 'radix-host'
        });
        postId = post.id;
        for (let i = 0; i < REVISION_COUNT; i++) {
            assert.ok(await saveRevision(postId), `revision ${i} must persist`);
        }
        app = mountRevisionsApp();
        const total = (await request(app)
            .get(`/api/v1/revisions/post/${postId}`)
            .set('Authorization', `Bearer ${token}`)).body.total;
        assert.strictEqual(total, REVISION_COUNT, 'fixture must hold exactly 5 revisions');
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
    });

    const list = (qs: string) => request(app)
        .get(`/api/v1/revisions/post/${postId}${qs}`)
        .set('Authorization', `Bearer ${token}`);

    it('a decimal limit still works exactly as before', async () => {
        const res = await list('?limit=3');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.revisions.length, 3, 'decimal limit must be honoured unchanged');
    });

    it('a decimal offset still works exactly as before', async () => {
        const res = await list('?offset=3');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.revisions.length, REVISION_COUNT - 3, 'decimal offset must be honoured unchanged');
    });

    it('?limit=0x3 is NOT honoured as 3 — a hex literal is not a base-10 integer', async () => {
        const res = await list('?limit=0x3');
        assert.strictEqual(res.status, 200);
        // parseInt('0x3', 10) === 0, which the `|| 10` default turns into the documented default of 10,
        // so all 5 revisions come back. Without the radix, parseInt('0x3') === 3 and only 3 did.
        assert.strictEqual(res.body.revisions.length, REVISION_COUNT,
            'a hex limit must fall back to the default, not be honoured as its hex value');
    });

    it('?offset=0x3 is NOT honoured as 3 — a hex literal is not a base-10 integer', async () => {
        const res = await list('?offset=0x3');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.revisions.length, REVISION_COUNT,
            'a hex offset must fall back to the default 0, not be honoured as its hex value');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2. NaN — only a real Postgres/MySQL rejects the bind, so only they can prove the defect.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Body of the cross-engine block, shared verbatim by the Postgres and MySQL suites. */
async function assertNonNumericIdsNeverReachTheDriver(request: any, app: any, token: string, engine: string) {
    for (const [method, url] of REVISION_ID_ROUTES) {
        const res = await (request(app) as any)[method](url).set('Authorization', `Bearer ${token}`);
        assert.strictEqual(res.status, 404,
            `${engine}: ${method.toUpperCase()} ${url} must be a 404, not ${res.status} ` +
            `(${JSON.stringify(res.body)}) — NaN must never be bound into the query`);
    }
}

/** Characterization: /post/:postId was already correct — Post.findById's `if (!id)` catches NaN. */
async function assertPostIdRouteAlreadyReturns404(request: any, app: any, token: string, engine: string) {
    const res = await request(app).get('/api/v1/revisions/post/abc').set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 404, `${engine}: /revisions/post/abc must 404`);
    assert.strictEqual(res.body.code, 'rest_post_invalid_id',
        `${engine}: the existing guard chain already produces the right 404 here — nothing was changed`);
}

describe('revisions router: a non-numeric revision id must 404, not reach Postgres as NaN', () => {
    const DBNAME = `wordjs_revnum_pg_${process.pid}`;
    let request: any, app: any, token: string, reachable = false;

    before(async () => {
        request = require('supertest');
        const { Client } = require('pg');
        const adminCfg = {
            host: process.env.PGHOST || '127.0.0.1',
            port: Number(process.env.PGPORT || 5432),
            user: process.env.PGUSER || 'postgres',
            password: process.env.PGPASSWORD || 'password',
            database: 'postgres',
        };
        try {
            // A THROWAWAY database per run: a certification that reuses a database makes its verdict
            // depend on history rather than on the code under test.
            const admin = new Client(adminCfg);
            await admin.connect();
            await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
            await admin.query(`CREATE DATABASE ${DBNAME}`);
            await admin.end();
        } catch {
            return; // reachable stays false; every test skipOrFails
        }
        config.dbDriver = 'postgres';
        config.db = { ...adminCfg, name: DBNAME };
        await database.init({ driver: 'postgres' });
        await database.initializeDatabase();
        const dbAsync = database.getDbAsync();
        await require('../core/post-types').initPostTypes();
        token = sign(await seedAdmin(dbAsync));
        app = mountRevisionsApp();
        reachable = true;
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        try {
            const { Client } = require('pg');
            const admin = new Client({
                host: process.env.PGHOST || '127.0.0.1',
                port: Number(process.env.PGPORT || 5432),
                user: process.env.PGUSER || 'postgres',
                password: process.env.PGPASSWORD || 'password',
                database: 'postgres',
            });
            await admin.connect();
            await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
            await admin.end();
        } catch { /* ignore */ }
    });

    it('every revision-id route answers 404 for a non-numeric id', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'Postgres unreachable');
        await assertNonNumericIdsNeverReachTheDriver(request, app, token, 'postgres');
    });

    it('/revisions/post/:postId was already correct (characterization, green before and after)', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'Postgres unreachable');
        await assertPostIdRouteAlreadyReturns404(request, app, token, 'postgres');
    });
});

describe('revisions router: a non-numeric revision id must 404, not reach MySQL as NaN', () => {
    const DBNAME = `wordjs_revnum_my_${process.pid}`;
    let request: any, app: any, token: string, reachable = false;

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
        const dbAsync = database.getDbAsync();
        await require('../core/post-types').initPostTypes();
        token = sign(await seedAdmin(dbAsync));
        app = mountRevisionsApp();
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

    it('every revision-id route answers 404 for a non-numeric id', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'MySQL unreachable');
        await assertNonNumericIdsNeverReachTheDriver(request, app, token, 'mysql');
    });

    it('/revisions/post/:postId was already correct (characterization, green before and after)', async (t: any) => {
        if (!reachable) return skipOrFail(t, 'MySQL unreachable');
        await assertPostIdRouteAlreadyReturns404(request, app, token, 'mysql');
    });
});
