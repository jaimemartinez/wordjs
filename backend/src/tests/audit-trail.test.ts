/**
 * WordJS — Append-only audit trail (FRENTE C-3) tests
 *
 * Drives the REAL users + auth + posts + audit routers via supertest against a throwaway temp SQLite
 * DB. Proves:
 *   - a role change writes EXACTLY ONE append-only row with the actor id, the from→to detail, and NO
 *     secret material;
 *   - the read endpoint is admin-gated (a non-admin gets 403, an admin gets the page);
 *   - sanitizeDetail drops secret-named keys and nested objects (unit-level, so a caller can never
 *     smuggle a password/token into the log);
 *   - AUTHENTICATION IS RECORDED: a wrong password lands as `auth.login.failure` carrying the attempted
 *     username and no trace of the password; a correct one lands as `auth.login.success`;
 *   - CONTENT IS RECORDED: creating and then trashing a post leaves `post.create` and `post.trash`;
 *   - RETENTION: the daily prune removes rows outside the window and keeps the ones inside it —
 *     including rows written by the REAL producer (`CURRENT_TIMESTAMP`), not only by the fixture, which
 *     is the half that catches a cutoff rendered in the wrong format or the wrong clock frame;
 *   - the action CATALOGUE is complete: every action literal that appears in a recordAudit call
 *     anywhere in the backend source is declared in AUDIT_ACTIONS. Read out of the source, so a new
 *     call site with an invented spelling fails here rather than fragmenting the log.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

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

// A REAL bcrypt hash, because User.authenticate compares against one — a placeholder 'x' would make
// every login fail for the wrong reason and the success case unreachable. Cost 4: this proves the
// route's behaviour, not bcrypt's work factor.
const PASSWORD = 'correct horse battery';
async function seedUser(login: string, role: string, password?: string) {
    const pass = password ? await bcrypt.hash(password, 4) : 'x';
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        [login, pass, `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
    return r.lastID;
}

/** The audit rows for one action, newest first. */
async function rowsFor(action: string): Promise<any[]> {
    return (await dbAsync.all('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC', [action])) || [];
}

describe('Audit trail', () => {
    before(async () => {
        request = require('supertest');
        await database.init({ driver: 'sqlite-native' });
        await database.initializeDatabase();
        dbAsync = database.getDbAsync();
        // The posts router refuses an unregistered type, so without the registry POST /posts would 400
        // and the content assertions would pass for the wrong reason.
        await require('../core/post-types').initPostTypes();
        await require('../core/roles').loadRoles();

        await seedUser('admin', 'administrator');
        await seedUser('victim', 'subscriber');
        await seedUser('nobody', 'subscriber');
        await seedUser('pilot', 'administrator', PASSWORD);

        const express = require('express');
        const cookieParser = require('cookie-parser');
        app = express();
        app.use(express.json());
        app.use(cookieParser());
        // Mount only the routers under test — self-contained (avoids the full route barrel).
        app.use('/api/v1/users', require('../routes/users'));
        app.use('/api/v1/auth', require('../routes/auth'));
        app.use('/api/v1/posts', require('../routes/posts'));
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

    it('sanitizeDetail also enforces the SMALL half of its contract: string, array and key bounds', () => {
        const {
            sanitizeDetail, MAX_DETAIL_STRING, MAX_DETAIL_ARRAY, MAX_DETAIL_KEYS
        } = require('../core/audit');

        // 'secret-free' and 'scalar-only' were enforced; 'small' was a promise kept by 33 call sites
        // each remembering to bound its own strings — in the one table whose unbounded growth is the
        // reason the retention prune below had to be written.
        const long = 'x'.repeat(MAX_DETAIL_STRING * 3);
        const many = Array.from({ length: MAX_DETAIL_ARRAY * 2 }, (_: unknown, i: number) => i);
        const wide: any = { long, many };
        for (let i = 0; i < MAX_DETAIL_KEYS * 2; i++) wide[`f${i}`] = i;

        const clean = sanitizeDetail(wide);

        assert.ok(clean.long.length < long.length, 'a long string is cut down');
        assert.ok(clean.long.startsWith('x'.repeat(MAX_DETAIL_STRING)), 'and it keeps the head, not a hash of it');
        // A fragment that does not say it is a fragment reads as the whole value, which in a security
        // log is worse than no value at all.
        assert.match(clean.long, /\[\+\d+ chars\]$/, 'the truncation is marked');

        assert.strictEqual(clean.many.length, MAX_DETAIL_ARRAY + 1, 'the array is capped, plus one marker');
        assert.strictEqual(clean.many[MAX_DETAIL_ARRAY], `[+${many.length - MAX_DETAIL_ARRAY} more]`);

        const keys = Object.keys(clean);
        assert.strictEqual(keys.length, MAX_DETAIL_KEYS + 1, 'the key count is capped, plus the marker');
        assert.match(String(clean._truncated), /^\d+ more key\(s\) dropped$/, 'and the drop is stated, not silent');

        // The whole point, in one number: whatever a caller passes, the stored blob stays small.
        const stored = JSON.stringify(clean);
        assert.ok(stored.length < 8000, `a sanitized detail must stay small; this one is ${stored.length} bytes`);
    });

    // ───────────────────────────────────────────────────────────────────────────────────────────────
    // AUTHENTICATION
    //
    // The gap this closes: an operator could not answer "was this account being guessed, and did anyone
    // get in?" from the product at all. Both halves are asserted through the REAL /auth/login route —
    // a hand-rolled recordAudit call would prove nothing about the handler.
    // ───────────────────────────────────────────────────────────────────────────────────────────────

    it('a failed login is recorded with the attempted username and NO password', async () => {
        const WRONG = 'not-the-password-3f9c';
        const res = await (request(app) as any).post('/api/v1/auth/login')
            .send({ username: 'pilot', password: WRONG });
        assert.strictEqual(res.status, 401, 'a wrong password must still be refused');

        const rows = await rowsFor('auth.login.failure');
        assert.strictEqual(rows.length, 1, 'exactly one failure row');
        const row = rows[0];
        assert.strictEqual(row.actor_id, null, 'a failed login has no authenticated actor');
        assert.strictEqual(String(row.target_id), 'pilot', 'the attempted account is the target');
        const detail = JSON.parse(row.detail);
        assert.strictEqual(detail.username, 'pilot', 'the attempted username is recorded — that is the point');
        // The password must not be in the row in ANY shape: not under its own key, not smuggled into
        // another one. Asserted against the WHOLE serialized row, not just the keys we thought to check.
        assert.ok(!JSON.stringify(row).includes(WRONG), 'the attempted password appears nowhere in the row');
        assert.ok(!('password' in detail) && !('pass' in detail), 'no password field at all');
    });

    it('a failed login for an identifier that names NO account records a digest, never the string', async () => {
        // "Never the password" was true of the `password` FIELD and false of the row: the single most
        // common way a credential reaches a log is a password typed into the username box, and that
        // string used to be stored verbatim in `detail` AND in `target_id`, readable by every
        // administrator through GET /audit for the 365 days retention keeps.
        const TYPED_IN_THE_WRONG_BOX = 'hunter2-correct-horse-9c1f';
        const first = await (request(app) as any).post('/api/v1/auth/login')
            .send({ username: TYPED_IN_THE_WRONG_BOX, password: 'whatever' });
        assert.strictEqual(first.status, 401, 'an unknown account is still refused the same way');

        const row = (await rowsFor('auth.login.failure'))[0];
        assert.ok(!JSON.stringify(row).includes(TYPED_IN_THE_WRONG_BOX),
            'the attempted identifier must appear nowhere in the row — not in detail, not in target_id');
        const detail = JSON.parse(row.detail);
        assert.strictEqual(detail.username, undefined, 'no plaintext identifier field at all');
        assert.strictEqual(detail.unknownAccount, true, 'the row still says the identifier named no account');
        assert.match(String(detail.usernameDigest), /^[0-9a-f]{16}$/, 'it is recorded as a digest');
        assert.strictEqual(String(row.target_id), `hmac:${detail.usernameDigest}`,
            'and the target names the same digest, so the two halves of the row agree');

        // The digest has to be STABLE, or the enumeration signal the row exists for is lost…
        const again = await (request(app) as any).post('/api/v1/auth/login')
            .send({ username: TYPED_IN_THE_WRONG_BOX, password: 'whatever' });
        assert.strictEqual(again.status, 401);
        assert.strictEqual(String((await rowsFor('auth.login.failure'))[0].target_id), String(row.target_id),
            'the same identifier must digest the same way, or nobody can count the attempts');

        // …and DIFFERENT for a different identifier, or every unknown probe looks like one attacker.
        await (request(app) as any).post('/api/v1/auth/login')
            .send({ username: `${TYPED_IN_THE_WRONG_BOX}-other`, password: 'whatever' });
        assert.notStrictEqual(String((await rowsFor('auth.login.failure'))[0].target_id), String(row.target_id));

        // The other half is unchanged and must stay so: an identifier that DOES name an account is
        // recorded in clear, because knowing WHICH account is being guessed is why the row exists.
        const known = await (request(app) as any).post('/api/v1/auth/login')
            .send({ username: 'pilot', password: 'still-not-the-password' });
        assert.strictEqual(known.status, 401);
        const knownRow = (await rowsFor('auth.login.failure'))[0];
        assert.strictEqual(String(knownRow.target_id), 'pilot', 'a real account is still named');
        assert.strictEqual(JSON.parse(knownRow.detail).username, 'pilot');
    });

    it('a successful login is recorded', async () => {
        const res = await (request(app) as any).post('/api/v1/auth/login')
            .send({ username: 'pilot', password: PASSWORD });
        assert.strictEqual(res.status, 200, 'the correct password must log in');

        const rows = await rowsFor('auth.login.success');
        assert.strictEqual(rows.length, 1, 'exactly one success row');
        assert.strictEqual(Number(rows[0].actor_id), U.pilot, 'the actor is the user who logged in');
        const detail = JSON.parse(rows[0].detail);
        assert.strictEqual(detail.method, 'password', 'the factor that completed the login is recorded');
        assert.ok(!JSON.stringify(rows[0]).includes(PASSWORD), 'the password appears nowhere in the row');
    });

    // ───────────────────────────────────────────────────────────────────────────────────────────────
    // CONTENT
    // ───────────────────────────────────────────────────────────────────────────────────────────────

    it('creating and trashing a post records BOTH events', async () => {
        const created = await as('admin', 'post', '/posts').send({ title: 'Audit canary', status: 'draft' });
        assert.strictEqual(created.status, 201, 'the post must be created');
        const id = created.body.id;

        const createRows = await rowsFor('post.create');
        assert.strictEqual(createRows.length, 1, 'exactly one create row');
        assert.strictEqual(String(createRows[0].target_id), String(id), 'the target is the new post');
        assert.strictEqual(Number(createRows[0].actor_id), U.admin, 'the actor is the author');
        assert.strictEqual(JSON.parse(createRows[0].detail).status, 'draft', 'the stored status is recorded');
        // Born as a draft — nothing became public, so there must be no publish row.
        assert.strictEqual((await rowsFor('post.publish')).length, 0, 'a draft creation is not a publish');
        // The title is CONTENT and must not be copied into the security log.
        assert.ok(!JSON.stringify(createRows[0]).includes('Audit canary'), 'no content body in the audit row');

        // A plain DELETE is a trash, not a destruction — and the two are different events.
        const trashed = await as('admin', 'delete', `/posts/${id}`);
        assert.strictEqual(trashed.status, 200, 'the post must be trashed');

        const trashRows = await rowsFor('post.trash');
        assert.strictEqual(trashRows.length, 1, 'exactly one trash row');
        assert.strictEqual(String(trashRows[0].target_id), String(id), 'the target is the trashed post');
        const trashDetail = JSON.parse(trashRows[0].detail);
        assert.strictEqual(trashDetail.from, 'draft', 'the status it came from');
        assert.strictEqual(trashDetail.to, 'trash', 'the status it went to');
        assert.strictEqual((await rowsFor('post.delete')).length, 0, 'a trash is not recorded as a permanent delete');
    });

    // ───────────────────────────────────────────────────────────────────────────────────────────────
    // RETENTION
    // ───────────────────────────────────────────────────────────────────────────────────────────────

    it('the retention prune removes rows outside the window and keeps the ones inside it', async () => {
        const { pruneAuditLog } = require('../core/audit');
        const { dbTimestamp } = require('../core/analytics-retention');
        const now = Date.now();
        const day = 86400000;

        // Everything written so far came from the REAL producer (created_at DEFAULT CURRENT_TIMESTAMP).
        // Those rows are the ones that matter here: a cutoff rendered in the wrong format, or read on
        // the wrong clock, eats them — and a test that only seeds its own fixtures cannot see it,
        // because the fixture and the cutoff would then share a renderer.
        const producerRows = await dbAsync.all('SELECT id FROM audit_log');
        assert.ok(producerRows.length >= 3, 'the earlier tests left real rows behind');

        // Backdated fixtures, written straight to the table (there is no API that back-dates a row).
        const stale = [400, 380, 366];
        for (const days of stale) {
            await dbAsync.run(
                `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, created_at)
                 VALUES (NULL, 'user.role_change', 'user', '0', '{}', ?)`,
                [dbTimestamp(now - days * day)]);
        }
        // …and one just inside the 365-day window, to prove the cutoff is a window and not a truncation.
        await dbAsync.run(
            `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, created_at)
             VALUES (NULL, 'user.role_change', 'user', 'keep-me', '{}', ?)`,
            [dbTimestamp(now - 364 * day)]);

        const removed = await pruneAuditLog(now);
        assert.strictEqual(removed, stale.length, 'exactly the rows past the retention window were removed');

        const kept = await dbAsync.get(`SELECT COUNT(*) AS c FROM audit_log WHERE target_id = 'keep-me'`);
        assert.strictEqual(Number(kept.c), 1, 'a row one day inside the window survives');
        for (const r of producerRows) {
            const still = await dbAsync.get('SELECT id FROM audit_log WHERE id = ?', [r.id]);
            assert.ok(still, `a row written by the real producer (id=${r.id}) must survive the prune`);
        }
    });

    it('audit_retention_days = 0 keeps everything for ever', async () => {
        const { pruneAuditLog } = require('../core/audit');
        const { updateOption, deleteOption } = require('../core/options');
        const { dbTimestamp } = require('../core/analytics-retention');
        const now = Date.now();

        await dbAsync.run(
            `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, created_at)
             VALUES (NULL, 'user.role_change', 'user', 'ancient', '{}', ?)`,
            [dbTimestamp(now - 5000 * 86400000)]);

        await updateOption('audit_retention_days', 0);
        try {
            const removed = await pruneAuditLog(now);
            assert.strictEqual(removed, 0, '0 disables pruning entirely');
            const row = await dbAsync.get(`SELECT id FROM audit_log WHERE target_id = 'ancient'`);
            assert.ok(row, 'a fourteen-year-old row survives when retention is switched off');
        } finally {
            await deleteOption('audit_retention_days');
        }
    });

    // ───────────────────────────────────────────────────────────────────────────────────────────────
    // THE CATALOGUE, DERIVED FROM THE SOURCE
    //
    // AUDIT_ACTIONS only keeps the vocabulary consistent if it is CHECKED against the call sites: the
    // routers reach core/audit through an untyped require(), so a typo in an action literal is invisible
    // to tsc and shows up months later as a query that silently returns nothing.
    // ───────────────────────────────────────────────────────────────────────────────────────────────

    it('every action literal in the backend source is declared in AUDIT_ACTIONS', () => {
        const { AUDIT_ACTIONS } = require('../core/audit');
        const known = new Set(Object.values(AUDIT_ACTIONS));
        const SRC = path.resolve(__dirname, '..');

        const files: string[] = [];
        (function walk(dir: string) {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                // The test tree is excluded: its own fixtures are not product call sites.
                if (e.isDirectory()) { if (!e.name.startsWith('tests')) walk(p); continue; }
                if (e.name.endsWith('.ts')) files.push(p);
            }
        })(SRC);
        assert.ok(files.length > 50, 'the walk actually found the backend source');

        const found = new Map<string, string>();
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8');
            // `recordAudit(<actor>, '<action>'` — the actor expression never contains a comma at any
            // call site, so this reads the action argument without needing to parse TypeScript. A call
            // that passes the action some other way is simply not covered (never falsely failed).
            for (const m of src.matchAll(/recordAudit\s*\(\s*[^,()]*(?:\([^()]*\))?[^,()]*,\s*'([^']+)'/g)) {
                found.set(m[1], path.relative(SRC, f));
            }
        }

        assert.ok(found.size >= 20, `expected the sweep to find the call sites, found ${found.size}`);
        const undeclared = [...found].filter(([action]) => !known.has(action));
        assert.deepStrictEqual(undeclared, [],
            `these action names are used but not declared in AUDIT_ACTIONS: ${JSON.stringify(undeclared)}`);
    });
});
