/**
 * F3 failure injection for the transactional content boundary introduced from the F0 characterization.
 *
 * Every injected failure must leave the pre-request state and no outbox event. Successful mutations
 * persist the content event in the same transaction and dispatch it only after commit.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const STAMP = `${process.pid}-${Date.now()}`;
const TMP_DB = path.join(os.tmpdir(), `wjs-f0-faults-${STAMP}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

// Install a controllable revision failure before routes/posts destructures saveRevision.
const revisions = require('../core/revisions');
const realSaveRevision = revisions.saveRevision;
let failRevision = false;
let revisionAttempts = 0;
revisions.saveRevision = async (...args: any[]) => {
    revisionAttempts++;
    if (failRevision) throw Object.assign(new Error('F0_FAIL_REVISION'), { code: 'f0_injected' });
    return await realSaveRevision(...args);
};

const database = require('../config/database');
const roles = require('../core/roles');
const postTypes = require('../core/post-types');
const Post = require('../models/Post');
const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../middleware/errorHandler');

const app = express();
app.use(express.json());
app.use('/api/v1', require('../routes'));
app.use(errorHandler);

let dbAsync: any;
let adminId: number;
let sequence = 0;
const token = () => jwt.sign({ userId: adminId, username: 'f0admin' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
const create = (body: any) => request(app).post('/api/v1/posts').set('Authorization', `Bearer ${token()}`).send(body);
const update = (id: number, body: any) => request(app).put(`/api/v1/posts/${id}`).set('Authorization', `Bearer ${token()}`).send(body);
const unique = (prefix: string) => `${prefix}-${process.pid}-${++sequence}`;

async function rowByTitle(title: string): Promise<any> {
    return await dbAsync.get('SELECT * FROM posts WHERE post_title = ? AND post_type <> ?', [title, 'revision']);
}

async function count(sql: string, params: any[]): Promise<number> {
    const row = await dbAsync.get(sql, params);
    return Number(row.c);
}

async function outboxCount(): Promise<number> {
    return await count('SELECT COUNT(*) AS c FROM content_outbox', []);
}

async function silenceExpectedError<T>(fn: () => Promise<T>): Promise<T> {
    const original = console.error;
    console.error = () => {};
    try { return await fn(); } finally { console.error = original; }
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await postTypes.initPostTypes();
    await roles.loadRoles();
    const inserted = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        ['f0admin', 'f0admin@example.com', 'F0 Admin'],
    );
    adminId = inserted.lastID;
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [adminId]);
});

after(async () => {
    revisions.saveRevision = realSaveRevision;
    try { await database.closeDatabase(); } catch { /* best effort */ }
    for (const file of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { if (fs.existsSync(file)) fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    }
});

describe('F3 create atomic boundary', () => {
    test('a term-stage failure rolls back the post and its outbox event', async () => {
        const title = unique('F0 term fault');
        const beforeOutbox = await outboxCount();
        const realSetTerms = Post.setTerms;
        Post.setTerms = async () => { throw Object.assign(new Error('F0_FAIL_TERMS'), { code: 'f0_injected' }); };
        try {
            const response: any = await silenceExpectedError(() => create({ title, content: 'body', categories: [] }));
            assert.strictEqual(response.status, 500);
        } finally {
            Post.setTerms = realSetTerms;
        }
        const post = await rowByTitle(title);
        assert.strictEqual(post, undefined);
        assert.strictEqual(await outboxCount(), beforeOutbox);
    });

    test('a second meta-stage failure rolls back the post and every prior meta write', async () => {
        const title = unique('F0 meta fault');
        const beforeOutbox = await outboxCount();
        const realUpdateMeta = Post.updateMeta;
        let calls = 0;
        Post.updateMeta = async (...args: any[]) => {
            calls++;
            if (calls === 2) throw Object.assign(new Error('F0_FAIL_META_2'), { code: 'f0_injected' });
            return await realUpdateMeta.apply(Post, args);
        };
        try {
            const response: any = await silenceExpectedError(() => create({
                title,
                content: 'body',
                meta: { f0_first: 'committed', f0_second: 'rejected' },
            }));
            assert.strictEqual(response.status, 500);
        } finally {
            Post.updateMeta = realUpdateMeta;
        }
        const post = await rowByTitle(title);
        assert.strictEqual(post, undefined);
        assert.strictEqual(await count(`SELECT COUNT(*) AS c FROM post_meta WHERE meta_key LIKE 'f0_%'`, []), 0);
        assert.strictEqual(await outboxCount(), beforeOutbox);
    });

    test('an initial-revision failure returns 500 and rolls back the whole creation', async () => {
        const title = unique('F0 revision fault');
        const beforeAttempts = revisionAttempts;
        const beforeOutbox = await outboxCount();
        failRevision = true;
        let response: any;
        try {
            response = await silenceExpectedError(() => create({ title, content: 'body' }));
        } finally {
            failRevision = false;
        }
        assert.strictEqual(response.status, 500);
        assert.strictEqual(revisionAttempts, beforeAttempts + 1);
        const post = await rowByTitle(title);
        assert.strictEqual(post, undefined);
        assert.strictEqual(await outboxCount(), beforeOutbox);
    });
});

describe('F3 update atomic boundary', () => {
    test('a term-stage failure rolls back the row update, recovery snapshot and outbox event', async () => {
        const originalTitle = unique('F0 update original');
        const changedTitle = unique('F0 update changed');
        const post = await Post.create({ authorId: adminId, title: originalTitle, content: 'old', status: 'draft' });
        const beforeOutbox = await outboxCount();
        const realSetTerms = Post.setTerms;
        Post.setTerms = async () => { throw Object.assign(new Error('F0_FAIL_UPDATE_TERMS'), { code: 'f0_injected' }); };
        try {
            const response: any = await silenceExpectedError(() => update(post.id, { title: changedTitle, categories: [] }));
            assert.strictEqual(response.status, 500);
        } finally {
            Post.setTerms = realSetTerms;
        }
        const current = await dbAsync.get('SELECT post_title FROM posts WHERE id = ?', [post.id]);
        assert.strictEqual(current.post_title, originalTitle);
        assert.strictEqual(await count(`SELECT COUNT(*) AS c FROM posts WHERE post_parent = ? AND post_type = 'revision'`, [post.id]), 0);
        assert.strictEqual(await outboxCount(), beforeOutbox);
    });
});
