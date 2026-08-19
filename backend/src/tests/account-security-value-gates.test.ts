/**
 * TWO GATES OVER routes/users.ts AND routes/plugins.ts, BOTH DERIVED FROM THE SOURCE
 *
 * Round 3's ruling was that the repair discipline works but the CLASSES are drawn around the syntactic
 * form the report happened to bring, and the tests then iterate that same form. So neither table here is
 * written by hand.
 *
 *  GATE 1 — "the exemption judges a different value from the one the sink writes."
 *      The population is `ACCOUNT_SECURITY_FIELDS`, read from routes/users.ts itself. For every field ×
 *      every blank-ish spelling, an administrator API token drives the write and the test demands ONE of
 *      two outcomes: the request was refused, or the account is byte-identical afterwards. That assertion
 *      does not depend on which criterion a field declares, so it stays true for a field added later —
 *      and a field whose sink acts on presence while its declared criterion says "blank is not supplied"
 *      is red by construction. FALSIFIABILITY, DEMONSTRATED RATHER THAN CLAIMED: adding the member
 *      `displayName: 'nonblank'` to ACCOUNT_SECURITY_FIELDS — a field whose sink writes on PRESENCE —
 *      turns this file red on `{displayName: '   '}` (200, and the stored display name becomes three
 *      spaces) and on `{displayName: []}` (500). Removing the member turns it green again. A member whose
 *      declared criterion and whose sink agree costs nothing; one that disagrees cannot be added quietly.
 *
 *  GATE 2 — "a cookie-only mutation the owner cannot undo."
 *      The invariant is that no authenticated door may write the bucket that governs /auth/login. The
 *      population is every non-test .ts under backend/src, scanned for the login-store helpers; routes/auth.ts
 *      is the owner of that store and one further exception is declared BY NAME, so the declaration goes
 *      stale loudly. The live half drives the real DELETE /plugins/:slug with wrong passwords and then
 *      asserts the owner can still log in with the correct one.
 *
 * Everything drives the REAL routers through supertest against a throwaway temp DB, with csrfProtection
 * mounted AT THE API PREFIX exactly as index.ts mounts it — same pattern as sudo-gate-classes.test.ts.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-acct-value-gates-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const { csrfProtection } = require('../middleware/auth');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const B = config.api.prefix;
const SECRET = config.jwt.secret;
const PASSWORD = 'Correct-Horse-9!';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(B, csrfProtection);
app.use(B, require('../routes'));

const U: Record<string, number> = {};
let dbAsync: any;

const jwtFor = (persona: string) => jwt.sign({ userId: U[persona], username: persona }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const asUser = (persona: string) => `Bearer ${jwtFor(persona)}`;

async function seedUser(login: string, role: string) {
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        [login, bcrypt.hashSync(PASSWORD, 10), `${login}@example.com`, login]);
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [r.lastID, role]);
    U[login] = r.lastID;
    return r.lastID;
}

async function mintToken(persona: string, scopes: string) {
    const res = await request(app).post(`${B}/auth/tokens`)
        .set('Authorization', asUser(persona)).send({ name: `t-${persona}-${Date.now()}-${Math.random()}`, scopes });
    assert.strictEqual(res.status, 201, `mint failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.token as string;
}

/** Everything about an account that any of these fields can reach, as one comparable string. */
async function accountSnapshot(userId: number): Promise<string> {
    const row = await dbAsync.get(
        'SELECT user_login, user_pass, user_email, display_name, user_url FROM users WHERE id = ?', [userId]);
    const meta = await dbAsync.all(
        'SELECT meta_key, meta_value FROM user_meta WHERE user_id = ? ORDER BY meta_key', [userId]);
    return JSON.stringify({ row, meta });
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();

    await seedUser('vgadmin', 'administrator');
    await seedUser('vgowner', 'administrator');   // GATE 2 — the account a hijacked session tries to jam
    await seedUser('vgvictim', 'author');         // GATE 1 — the account a token tries to quietly edit

    // The victim starts with BOTH presence-criterion fields SET, so a blank-valued write that slipped
    // through would be observable as a deletion rather than as a no-op. Without this the gate could pass
    // for the wrong reason.
    await dbAsync.run(
        `INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'personal_email', ?)`,
        [U.vgvictim, 'rescue@example.org']);
    await dbAsync.run(
        `INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'professional_mailbox', '1')`,
        [U.vgvictim]);
});

after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    try { fs.rmSync(TMP_DB, { force: true }); } catch { /* */ }
    try { fs.rmSync(TMP_DB + '-wal', { force: true }); fs.rmSync(TMP_DB + '-shm', { force: true }); } catch { /* */ }
});

// ─── GATE 1 · the blank-value axis of the headless exemption ──────────────────────────────────────

/**
 * The blank-ish spellings a client can put in a JSON body. `[]` is here because `String([]) === ''`:
 * the old predicate collapsed it to "not supplied" while `!== undefined` at the sink saw a write.
 */
const BLANK_SPELLINGS: Array<{ label: string; value: any }> = [
    { label: "''", value: '' },
    { label: "'   '", value: '   ' },
    { label: 'null', value: null },
    { label: '[]', value: [] },
];

test('GATE 1 — no blank value of an account-security field can pass headlessly AND change the account', async () => {
    // THE POPULATION COMES FROM THE ROUTER, not from this file: adding a field there adds rows here.
    const { ACCOUNT_SECURITY_FIELDS } = require('../routes/users');
    const fields = Object.keys(ACCOUNT_SECURITY_FIELDS);
    assert.ok(fields.length >= 6, `the router must still declare its account-security fields (${fields.length})`);

    const bearer = `Bearer ${await mintToken('vgadmin', '*')}`;

    for (const field of fields) {
        for (const spelling of BLANK_SPELLINGS) {
            const before = await accountSnapshot(U.vgvictim);
            const res = await request(app).put(`${B}/users/${U.vgvictim}`)
                .set('Authorization', bearer)
                .send({ [field]: spelling.value });
            const after = await accountSnapshot(U.vgvictim);

            const refused = res.status === 403 && res.body && res.body.code === 'rest_token_management_forbidden';
            const untouched = before === after;
            assert.ok(refused || untouched,
                `{${field}: ${spelling.label}} was neither refused nor inert — status ${res.status} ` +
                `${JSON.stringify(res.body)}\n  before: ${before}\n  after:  ${after}`);
        }
    }
});

/**
 * The two halves of the class, stated as the class and not as the example: a field declared 'presence'
 * must be REFUSED even blank (its sink writes), and a field declared 'nonblank' must be LET THROUGH blank
 * (every profile form resends its whole object, and refusing those was the availability bug the
 * exemption exists to avoid). Both expectations are read off the SAME declaration the router uses.
 */
test('GATE 1b — the refusal follows each field\'s DECLARED criterion, in both directions', async () => {
    const { ACCOUNT_SECURITY_FIELDS, fieldIsSupplied } = require('../routes/users');
    const bearer = `Bearer ${await mintToken('vgadmin', '*')}`;

    for (const [field, criterion] of Object.entries(ACCOUNT_SECURITY_FIELDS) as Array<[string, string]>) {
        for (const spelling of BLANK_SPELLINGS) {
            const body = { [field]: spelling.value };
            // The predicate first, so a drift between the declaration and the predicate is caught here
            // rather than being masked by whatever the route happens to do.
            assert.strictEqual(fieldIsSupplied(field, body), criterion === 'presence',
                `fieldIsSupplied(${field}, ${spelling.label}) must follow the declared '${criterion}'`);

            const res = await request(app).put(`${B}/users/${U.vgvictim}`)
                .set('Authorization', bearer).send(body);
            if (criterion === 'presence') {
                assert.strictEqual(res.status, 403,
                    `{${field}: ${spelling.label}} is declared 'presence' — its sink writes, so it must be refused ` +
                    `to a token: ${res.status} ${JSON.stringify(res.body)}`);
            } else {
                assert.strictEqual(res.status, 200,
                    `{${field}: ${spelling.label}} is declared 'nonblank' — a resent blank must not 403 a ` +
                    `cosmetic save: ${res.status} ${JSON.stringify(res.body)}`);
            }
        }
    }
});

/**
 * The value half of the same class, one level down: the guard compared `body.personalEmail || ''` while
 * the sink stored `String(body.personalEmail)`, so `null` was "unchanged" to the sudo guard and the
 * four-character string "null" in the database — aimed at by recoveryTarget(). One normalizer now.
 */
test('GATE 1c — a blank recovery address is stored as empty, never as the string "null"', async () => {
    const { personalEmailValue } = require('../routes/users');
    for (const spelling of BLANK_SPELLINGS) {
        assert.strictEqual(personalEmailValue(spelling.value), '',
            `personalEmail ${spelling.label} must normalize to '' before it is judged or stored`);
    }
    assert.strictEqual(personalEmailValue(undefined), '');
    assert.strictEqual(personalEmailValue('  Rescue@Example.ORG '), 'rescue@example.org');

    // Driven through the real route, over an interactive session (the token is refused, see GATE 1b).
    const res = await request(app).put(`${B}/users/${U.vgvictim}`)
        .set('Authorization', asUser('vgadmin')).send({ personalEmail: null });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const stored = await dbAsync.get(
        `SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = 'personal_email'`, [U.vgvictim]);
    assert.strictEqual(String(stored && stored.meta_value), '',
        'a null recovery address must clear the value, not store the word "null"');

    // …and put it back, so the ordering of tests in this file cannot matter.
    await dbAsync.run(
        `UPDATE user_meta SET meta_value = 'rescue@example.org' WHERE user_id = ? AND meta_key = 'personal_email'`,
        [U.vgvictim]);
});

// ─── GATE 2 · no authenticated door may write the bucket that governs /auth/login ─────────────────

/**
 * The login store's helpers. Any call to one of these OUTSIDE routes/auth.ts is a door writing into the
 * key space that /auth/login reads — which is how DELETE /plugins/:slug could jam the owner out of the
 * product with a dozen wrong passwords from a hijacked cookie.
 */
const LOGIN_STORE_HELPERS = /\b(recordLoginFail|clearLoginFails|isLoginLocked|resolveLockIdentifier|beginLoginAttempt|endLoginAttempt)\s*\(/;

/**
 * The ONE declared exception, named so it cannot be forgotten: routes/setup.ts drives the database
 * migration door with a `'migrate:' + …` bucket. It is out of this wave's scope to re-key (it
 * authenticates by username+password with no session to key on), and it is REPORTED as residual risk:
 * the prefix lives in the same key space, so an anonymous POST /auth/login {username:'migrate:admin'}
 * can still arm it. This entry is here to keep that debt visible and honest — if the file is fixed (or
 * disappears) the assertion below fails and the exception must be removed with it.
 */
const DECLARED_LOGIN_STORE_EXCEPTIONS = ['routes/setup.ts'];

function sourceFilesUnder(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'tests' || entry.name === 'node_modules') continue;
            sourceFilesUnder(full, out);
        } else if (entry.name.endsWith('.ts')) {
            out.push(full);
        }
    }
    return out;
}

/** Lines with the comment stripped, so the class note in routes/plugins.ts is not read as a call. */
function codeLines(text: string): string[] {
    let inBlock = false;
    return text.split('\n').map((raw) => {
        let line = raw;
        if (inBlock) {
            const end = line.indexOf('*/');
            if (end < 0) return '';
            line = line.slice(end + 2);
            inBlock = false;
        }
        const block = line.indexOf('/*');
        if (block >= 0) {
            const end = line.indexOf('*/', block + 2);
            if (end < 0) { inBlock = true; line = line.slice(0, block); }
            else line = line.slice(0, block) + line.slice(end + 2);
        }
        const lineComment = line.indexOf('//');
        if (lineComment >= 0) line = line.slice(0, lineComment);
        return line;
    });
}

test('GATE 2 — the login-store helpers are called from routes/auth.ts and from nowhere else', async () => {
    const root = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    const seenExceptions = new Set<string>();

    for (const file of sourceFilesUnder(root)) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        if (rel === 'routes/auth.ts') continue;              // the owner of the store
        const lines = codeLines(fs.readFileSync(file, 'utf8'));
        const hits = lines
            .map((line, i) => ({ line, n: i + 1 }))
            .filter((l) => LOGIN_STORE_HELPERS.test(l.line));
        if (!hits.length) continue;
        if (DECLARED_LOGIN_STORE_EXCEPTIONS.includes(rel)) { seenExceptions.add(rel); continue; }
        for (const h of hits) offenders.push(`${rel}:${h.n} ${h.line.trim()}`);
    }

    assert.deepStrictEqual(offenders, [],
        'an authenticated door is writing the /auth/login key space. Give it its OWN purpose-keyed bucket ' +
        '(routes/users.ts requireSudoPassword is the shared implementation):\n  ' + offenders.join('\n  '));

    // The exception list must stay honest: an entry that no longer applies is a stale claim of debt.
    for (const rel of DECLARED_LOGIN_STORE_EXCEPTIONS) {
        assert.ok(seenExceptions.has(rel),
            `${rel} is declared as a login-store exception but no longer calls those helpers — remove the ` +
            'entry from DECLARED_LOGIN_STORE_EXCEPTIONS.');
    }
});

test('GATE 2b — failed plugin deletions cannot lock the owner out of /auth/login', async () => {
    const auth = require('../routes/auth');
    const owner = 'vgowner';
    const cookieSession = asUser(owner); // the hijacked ambient credential

    // A dozen wrong passwords against the plugin-delete door — more than the login throttle's threshold,
    // from one source, against a slug that does not even exist (the password check precedes the
    // existence check, which is what made this reachable without knowing anything about the site).
    for (let i = 0; i < 12; i++) {
        const res = await request(app).delete(`${B}/plugins/no-such-plugin`)
            .set('Authorization', cookieSession).send({ password: `wrong-${i}` });
        assert.ok(res.status === 403 || res.status === 429,
            `a wrong password must be refused, got ${res.status} ${JSON.stringify(res.body)}`);
    }

    // THE INVARIANT: the owner can still get in with the CORRECT password. Asserted on the login store
    // AND through the real /auth/login, because the two could disagree.
    const lockId = await auth.resolveLockIdentifier(owner);
    assert.strictEqual(await auth.isLoginLocked(lockId), false,
        'the plugin-delete door armed the owner\'s /auth/login lockout');

    // Same-origin headers, because csrfProtection is mounted here exactly as index.ts mounts it and
    // /auth/login is not a Bearer call — this is the browser shape, which is the one that matters.
    const login = await request(app).post(`${B}/auth/login`)
        .set('X-Forwarded-Host', 'wjs.test').set('Origin', 'http://wjs.test')
        .send({ username: owner, password: PASSWORD });
    assert.strictEqual(login.status, 200,
        `the owner must still be able to log in: ${login.status} ${JSON.stringify(login.body)}`);
});
