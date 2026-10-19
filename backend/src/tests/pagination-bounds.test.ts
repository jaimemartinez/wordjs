/**
 * PAGINATION BOUNDS — a page size is never unbounded.
 *
 * Every list route capped `per_page` from ABOVE only (`Math.min(parseInt(...) || d, 100)`), so a
 * negative value survived and reached `LIMIT ?` — and SQLite reads a negative LIMIT as "no limit".
 * `?per_page=-1` therefore returned every row of the table, past the cap the route meant to enforce.
 * core/pagination.ts is the one rule now: page size in [1, max], page >= 1, offset >= 0. The models
 * clamp too, so a caller that reaches `findAll` without a route in front of it gets the same floor.
 *
 * Each list route and each model below is seeded with MORE rows than one, then asked for -1: the old
 * code answers with all of them, the fixed code with exactly one.
 *
 * MUTATION PROOF: replace `Math.max(..., 1)` in perPageParam / clampLimit with the bare value and the
 * route and model assertions below fail (3 rows instead of 1).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-pagination-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const { perPageParam, pageParam, pageOffset, offsetParam, clampLimit, clampOffset } = require('../core/pagination');

const SECRET = config.jwt.secret;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1', require('../routes'));

let dbAsync: any;
let adminId = 0;
let postId = 0;

const tok = (id: number, login: string) => jwt.sign({ userId: id, username: login }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const anon = (p: string) => request(app).get(`/api/v1${p}`);
const asAdmin = (p: string) => request(app).get(`/api/v1${p}`).set('Authorization', `Bearer ${tok(adminId, 'admin')}`);

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await roles.loadRoles();
    await require('../core/post-types').initPostTypes();

    for (const login of ['admin', 'second', 'third']) {
        const r = await dbAsync.run(
            `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
            [login, `${login}@example.com`, login]);
        await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`,
            [r.lastID, login === 'admin' ? 'administrator' : 'subscriber']);
        if (login === 'admin') adminId = r.lastID;
    }

    const Post = require('../models/Post');
    const Term = require('../models/Term');
    const Comment = require('../models/Comment');
    const FormSubmission = require('../models/FormSubmission');
    for (let i = 0; i < 3; i++) {
        const p = await Post.create({ authorId: adminId, title: `Post ${i}`, content: 'body', type: 'post', status: 'publish' });
        if (i === 0) postId = p.id;
        await Term.create({ name: `Cat ${i}`, taxonomy: 'category' });
        await Term.create({ name: `Tag ${i}`, taxonomy: 'post_tag' });
        await FormSubmission.create({ formName: 'contact', fields: { n: String(i) } });
    }
    for (let i = 0; i < 3; i++) {
        await Comment.create({ postId, author: `c${i}`, authorEmail: `c${i}@example.com`, authorUrl: '', authorIp: '127.0.0.1', content: `hello ${i}`, status: '1' });
        await dbAsync.run(
            `INSERT INTO posts (author_id, post_title, post_content, post_status, post_type, post_parent, post_modified)
             VALUES (?, ?, 'r', 'inherit', 'revision', ?, ?)`,
            [adminId, `rev ${i}`, postId, `2026-01-0${i + 1} 00:00:00`]);
    }
});

after(async () => {
    try { await database.close(); } catch { /* */ }
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
});

describe('core/pagination', () => {
    test('page size: default for absent/zero/junk, floor 1, cap max', () => {
        assert.equal(perPageParam(undefined, 10), 10);
        assert.equal(perPageParam('0', 10), 10);
        assert.equal(perPageParam('abc', 10), 10);
        assert.equal(perPageParam('-1', 10), 1);
        assert.equal(perPageParam('-500', 10), 1);
        assert.equal(perPageParam('7', 10), 7);
        assert.equal(perPageParam('1000', 10), 100);
        assert.equal(perPageParam('1000', 10, 500), 500);
    });
    test('page, offset and model clamps never go below their floor', () => {
        assert.equal(pageParam('-3'), 1);
        assert.equal(pageOffset('3', 20), 40);
        assert.equal(pageOffset('-3', 20), 0);
        assert.equal(offsetParam('-5'), 0);
        assert.equal(clampLimit(-1, 10), 1);
        assert.equal(clampLimit('x', 10), 10);
        assert.equal(clampLimit(5000, 10), 5000, 'models keep large limits; only the floor is enforced');
        assert.equal(clampOffset(-1), 0);
    });
});

describe('list routes: per_page=-1 returns one row, not the whole table', () => {
    const cases: Array<[string, string, (p: string) => any]> = [
        ['posts', '/posts?per_page=-1', anon],
        ['categories', '/categories?per_page=-1&hide_empty=false', anon],
        ['tags', '/tags?per_page=-1&hide_empty=false', anon],
        ['comments', '/comments?per_page=-1', anon],
        ['users', '/users?per_page=-1', asAdmin],
    ];
    for (const [name, url, call] of cases) {
        test(name, async () => {
            const control = await call(url.replace('per_page=-1', 'per_page=100'));
            assert.equal(control.status, 200, `${name}: control request`);
            assert.ok(control.body.length >= 3, `${name}: control sees all seeded rows (${control.body.length})`);
            const res = await call(url);
            assert.equal(res.status, 200);
            assert.equal(res.body.length, 1, `${name}: a negative per_page is clamped to 1`);
        });
    }

    test('forms submissions', async () => {
        const res = await asAdmin('/forms/submissions?per_page=-1');
        assert.equal(res.status, 200);
        const rows = Array.isArray(res.body) ? res.body : (res.body.submissions || res.body.items || res.body.data);
        assert.ok(Array.isArray(rows), `unexpected body shape: ${JSON.stringify(res.body).slice(0, 200)}`);
        assert.equal(rows.length, 1);
    });

    test('revisions limit=-1 and offset=-1', async () => {
        const res = await asAdmin(`/revisions/post/${postId}?limit=-1&offset=-1`);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.revisions.length, 1);
        assert.equal(res.body.total, 3);
    });
});

describe('models clamp a negative limit themselves', () => {
    test('Post / Term / Comment / User / FormSubmission / getRevisions', async () => {
        const Post = require('../models/Post');
        const Term = require('../models/Term');
        const Comment = require('../models/Comment');
        const User = require('../models/User');
        const FormSubmission = require('../models/FormSubmission');
        const { getRevisions } = require('../core/revisions');
        assert.equal((await Post.findAll({ limit: -1, status: 'publish', type: 'post' })).length, 1, 'Post');
        assert.equal((await Term.findAll({ limit: -1, taxonomy: 'category' })).length, 1, 'Term');
        assert.equal((await Comment.findAll({ limit: -1 })).length, 1, 'Comment');
        assert.equal((await User.findAll({ limit: -1 })).length, 1, 'User');
        assert.equal((await FormSubmission.findAll({ limit: -1 })).length, 1, 'FormSubmission');
        assert.equal((await getRevisions(postId, { limit: -1, offset: -1 })).length, 1, 'getRevisions');
    });
});
