/**
 * WordJS — Append-only audit trail (FRENTE C-3) tests
 *
 * Drives the REAL users + audit routers via supertest against a throwaway temp SQLite DB. Proves:
 *   - a role change writes EXACTLY ONE append-only row with the actor id, the from→to detail, and NO
 *     secret material;
 *   - the read endpoint is admin-gated (a non-admin gets 403, an admin gets the page);
 *   - sanitizeDetail drops secret-named keys and nested objects (unit-level, so a caller can never
 *     smuggle a password/token into the log).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wordjs-audit-test-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');

let request: any;
let app: any;
let dbAsync: any;
const SECRET = config.jwt.secret;
const U: Record<string, number> = {};

const tok = (id: number, login: string) => jwt.sign({ userId: id, username: login }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const as = (persona: string, m: string, p: string) =>
    (request(app) as any)[m](`/api/v1${p}`).set('Authorization', `Bearer ${tok(U[persona], persona)}`);

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, 'x', ?, ?)`,
        [login, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
    return r.lastID;
}

describe('Audit trail', () => {
    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        await require('../core/roles').loadRoles();

        await seedUser('admin', 'administrator');
        await seedUser('victim', 'subscriber');
        await seedUser('nobody', 'subscriber');

        const express = require('express');
        const cookieParser = require('cookie-parser');
        app = express();
        app.use(express.json());
        app.use(cookieParser());
        // Mount only the routers under test — self-contained (avoids the full route barrel).
        app.use('/api/v1/users', require('../routes/users'));
        app.use('/api/v1/audit', require('../routes/audit'));
    });

    after(async () => {
        try { await database.closeDatabase(); } catch { /* ignore */ }
        for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
            try { if (fs.existsSync(f)) fs.rmSync(f, { force: true }); } catch { /* ignore */ }
        }
    });

    it('a role change writes exactly one append-only row with the actor and no secret material', async () => {
        const before = await dbAsync.get('SELECT COUNT(*) AS c FROM audit_log');
        assert.strictEqual(Number(before.c), 0, 'audit log starts empty');

        // Admin changes victim: subscriber → editor.
        const res = await as('admin', 'put', `/users/${U.victim}`).send({ role: 'editor' });
        assert.strictEqual(res.status, 200, 'the role change must succeed');

        // Exactly one row.
        const after = await dbAsync.get('SELECT COUNT(*) AS c FROM audit_log');
        assert.strictEqual(Number(after.c), 1, 'exactly one audit row per role change');

        const row = await dbAsync.get('SELECT * FROM audit_log ORDER BY id DESC LIMIT 1');
        assert.strictEqual(row.action, 'user.role_change', 'action recorded');
        assert.strictEqual(Number(row.actor_id), U.admin, 'the actor is the admin who made the change');
        assert.strictEqual(String(row.target_id), String(U.victim), 'the target is the changed user');
        const detail = JSON.parse(row.detail);
        assert.strictEqual(detail.from, 'subscriber', 'from-role recorded');
        assert.strictEqual(detail.to, 'editor', 'to-role recorded');
        // No secret material anywhere in the stored row.
        assert.ok(!/pass|token|secret|hash|user_pass/i.test(row.detail), 'detail carries no secret material');
    });

    it('the read endpoint is admin-gated', async () => {
        const forbidden = await as('nobody', 'get', '/audit');
        assert.strictEqual(forbidden.status, 403, 'a non-admin must be refused the audit log');

        const ok = await as('admin', 'get', '/audit');
        assert.strictEqual(ok.status, 200, 'an admin may read the audit log');
        assert.ok(Array.isArray(ok.body.entries), 'entries is an array');
        assert.ok(ok.body.entries.length >= 1, 'the role-change entry is visible');
        const entry = ok.body.entries.find((e: any) => e.action === 'user.role_change');
        assert.ok(entry, 'the role change is in the read view');
        assert.strictEqual(entry.actorId, U.admin, 'the read view reports the actor');
    });

    it('sanitizeDetail drops secret-named keys and nested objects', () => {
        const { sanitizeDetail } = require('../core/audit');
        const clean = sanitizeDetail({
            from: 'subscriber', to: 'editor',
            password: 'hunter2', token: 'abc', api_key: 'zzz', user_pass_hash: 'deadbeef',
            nested: { secret: 'x' },
            list: ['a', 'b', { secret: 'y' }]
        });
        assert.deepStrictEqual(Object.keys(clean).sort(), ['from', 'list', 'to'], 'only non-secret scalars/arrays survive');
        assert.deepStrictEqual(clean.list, ['a', 'b'], 'array keeps only scalar elements');
        assert.ok(!('password' in clean) && !('token' in clean) && !('nested' in clean), 'secret + nested keys dropped');
    });
});
