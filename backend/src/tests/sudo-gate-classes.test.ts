/**
 * THE SUDO GATE — THREE CLASSES, DRIVEN THROUGH THE REAL ROUTERS
 *
 * Round 2 of the adversarial review found the same meta-defect for the third time: a fix written against
 * the EXAMPLE in the report instead of against the CLASS. These tests are written against the classes.
 *
 *  CLASS 1 — a throttle bucket must not be addressable by a string an attacker can supply.
 *      Every lockout bucket used to be `'<purpose>:' + identifier` inside ONE key space, and
 *      `resolveLockIdentifier` hands back the SUBMITTED identifier raw when no account matches. So an
 *      anonymous POST /auth/login could write into `sudo:<victim>` and freeze every recovery action on
 *      that account. The test therefore iterates a TABLE of spellings an outsider can reach — not just
 *      the one from the report — and asserts none of them can touch the owner's sudo door.
 *
 *  CLASS 2 — a re-authentication gate must never refuse a CORRECT password.
 *      A lock the owner cannot clear is a denial of service wearing a security badge. The test floods
 *      past the old lockout threshold and then asserts the owner still gets in, and it iterates EVERY
 *      sudo-gated door rather than the one the report happened to name.
 *
 *  CLASS 3 — a doctrine applied route by route covers the routes somebody remembered.
 *      `sessionOnly` was pinned to 2 of the users router's 8 routes. The test iterates the FULL matrix
 *      "administrator API token × every write in that router", and asserts the side effect did not
 *      happen — not merely that a status code came back.
 *
 * Everything drives the REAL routers through supertest against a throwaway temp DB, with csrfProtection
 * mounted AT THE API PREFIX exactly as index.ts mounts it. Same pattern as auth-headless-session.test.ts.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-sudo-classes-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');
const User = require('../models/User');
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
        .set('Authorization', asUser(persona)).send({ name: `t-${persona}-${scopes}-${Date.now()}`, scopes });
    assert.strictEqual(res.status, 201, `mint failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.token as string;
}

const metaOf = (userId: number, key: string) => dbAsync.get(
    'SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ?', [userId, key]);

/** Every persona that a per-door test needs its OWN copy of, so one door's failures never fund another's. */
const DOOR_PERSONAS = ['doorMe', 'doorTwin', 'doorMfa', 'doorMfaEnable', 'doorSessions', 'doorPassword'];
/** …and the doors that need a privileged caller to be reachable at all (DELETE /plugins/:slug is isAdmin). */
const ADMIN_DOOR_PERSONAS = ['doorPluginAdmin'];

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();

    await seedUser('admin', 'administrator');
    await seedUser('nsvictim', 'author');   // CLASS 1 — the account an outsider tries to freeze
    await seedUser('hostage', 'author');    // CLASS 2 — the account a hijacked session tries to hold
    await seedUser('target', 'author');     // CLASS 3 — the account an admin token tries to seize
    await seedUser('blankVictim', 'author');// CLASS 3 — its own account, so the blank/null matrix starts clean
    for (const p of DOOR_PERSONAS) await seedUser(p, 'author');
    for (const p of ADMIN_DOOR_PERSONAS) await seedUser(p, 'administrator');
});

after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    try { fs.rmSync(TMP_DB, { force: true }); } catch { /* */ }
    try { fs.rmSync(TMP_DB + '-wal', { force: true }); fs.rmSync(TMP_DB + '-shm', { force: true }); } catch { /* */ }
});

// ─── CLASS 1 · no string an outsider can supply may reach the sudo bucket ─────────────────────────

/**
 * THE SPELLINGS ARE DERIVED FROM THE KEY SPACE, NOT WRITTEN OUT.
 *
 * ROUND-3 FINDING (verify3 #25a): this used to be an array literal of eight strings. A purpose prefix
 * added anywhere in the repo added no row, so the table described the two siblings somebody remembered
 * and nothing else — the same "recognise a form, do not enumerate the population" defect this wave is
 * about, inside the test that exists to close it.
 *
 * The purpose set now comes from routes/auth.ts's own exported LOCK_PURPOSES (the closed set lockBucket
 * accepts), unioned with the prefixes this class was BORN from. The historical ones stay even after they
 * leave the source, because a running install's store still holds rows keyed the old way: "we stopped
 * writing that prefix" is not "that prefix is not armed". A purpose added to LOCK_PURPOSES tomorrow is
 * armed against every recovery door by this test, with nothing to remember.
 */
const HISTORICAL_LOCK_PREFIXES = ['sudo', 'mfa', 'migrate'];

function lockPurposes(): string[] {
    const declared = require('../routes/auth').LOCK_PURPOSES;
    assert.ok(Array.isArray(declared) && declared.length > 0,
        'routes/auth.ts must export LOCK_PURPOSES: this gate DERIVES the shared key space from it rather ' +
        'than restating it, and a gate whose population is hand-written is not a gate');
    return [...new Set([...declared.map(String), ...HISTORICAL_LOCK_PREFIXES])];
}

/** Every spelling an ANONYMOUS caller can push into the shared login store, for every known purpose. */
function collisionSpellings(login: string, id: number): string[] {
    // /auth/login keys its counter on `resolveLockIdentifier(req.body.username)`, which returns the
    // SUBMITTED string verbatim whenever it matches no account. So for each purpose these are the
    // squattable spellings, including the case/whitespace variants that collapse onto one normalized key.
    const out: string[] = [];
    for (const purpose of lockPurposes()) {
        out.push(
            `${purpose}:${login}`,
            `${purpose.toUpperCase()}:${login.toUpperCase()}`,
            `  ${purpose}:${login}  `,
            `${purpose}:${id}`,
            `${purpose}:${login}@example.com`,
        );
    }
    out.push(login);     // the plain interactive-login bucket, which an outsider CAN arm
    return out;
}

test('CLASS 1 — the sudo door is unreachable from ANY identifier an anonymous caller can submit', async () => {
    const auth = require('../routes/auth');
    const login = 'nsvictim';
    const spellings = collisionSpellings(login, U[login]);

    // PRECONDITION, proved against the real module: the attacker chooses the key. This is the fail-open
    // that makes the whole class possible, and it is still true — which is why the fix had to be to stop
    // READING an attacker-writable key space, not to pick a cleverer prefix.
    for (const s of spellings.filter((x) => !x.trim().toLowerCase().startsWith(login))) {
        assert.strictEqual(await auth.resolveLockIdentifier(s), s,
            `resolveLockIdentifier must be shown to hand back ${JSON.stringify(s)} raw`);
    }

    // …and the path is live: /auth/login really does accept such a username and process it.
    const anon = await request(app).post(`${B}/auth/login`).set('Authorization', asUser('admin'))
        .send({ username: `sudo:${login}`, password: 'whatever' });
    assert.ok(anon.status !== 200, `an anonymous probe must not succeed, got ${anon.status}`);

    // Arm EVERY spelling, exactly as routes/auth.ts:recordLoginFail(lockId) would after 10 failures.
    //
    // THE PRECONDITION IS NOW TWO-SIDED, because the store grew a second kind of purpose while this file
    // was not looking. `recordLoginFail` ARMS a lock only for a purpose in LOCKING_PURPOSES; on every
    // other purpose it counts the failure and arms nothing (that is what makes a count-only door unable to
    // take a hostage). A blanket `must be armed` assertion therefore stopped describing the module — and,
    // worse, it would go green on a purpose that silently stopped counting at all. So each spelling is
    // held to the half that applies to it: a LOCKING purpose must really be armed; a count-only purpose
    // must NOT be armed AND must be shown to have recorded the failures anyway. The normalisation mirrors
    // routes/auth.ts's `_loginKey` (trim + lowercase) — restated here, and the `armed` expectation is
    // checked against the module's own exported LOCKING_PURPOSES rather than a list in this file.
    const lockingPurposes: string[] = [...(auth.LOCKING_PURPOSES || [])];
    assert.ok(lockingPurposes.length >= 1, 'routes/auth.ts must export LOCKING_PURPOSES for this precondition to be derivable');
    const armsALock = (key: string) => {
        const norm = String(key).trim().toLowerCase();
        const i = norm.indexOf(':');
        return i >= 0 && lockingPurposes.includes(norm.slice(0, i));
    };
    for (const s of spellings) {
        for (let i = 0; i < 12; i++) await auth.recordLoginFail(s);
        if (armsALock(s)) {
            assert.strictEqual(await auth.isLoginLocked(s), true,
                `precondition: the shared login store must really be armed for ${JSON.stringify(s)}`);
        } else {
            assert.strictEqual(await auth.isLoginLocked(s), false,
                `${JSON.stringify(s)} is not a locking purpose, so nothing may arm a lock on it`);
            assert.ok(await auth.loginFailCount(s) >= 12,
                `precondition: the failures on the count-only bucket ${JSON.stringify(s)} must still be RECORDED — `
                + 'otherwise this loop proves nothing about a store that stopped storing');
        }
    }

    // The owner, with the CORRECT password, must be able to do every recovery action anyway.
    const sess = asUser(login);
    const setRecovery = await request(app).put(`${B}/users/me`).set('Authorization', sess)
        .send({ personalEmail: 'owner@personal.test', currentPassword: PASSWORD });
    assert.strictEqual(setRecovery.status, 200, JSON.stringify(setRecovery.body));
    assert.strictEqual((await metaOf(U[login], 'personal_email')).meta_value, 'owner@personal.test');

    const enroll = await request(app).post(`${B}/auth/mfa/setup`).set('Authorization', sess)
        .send({ currentPassword: PASSWORD });
    assert.strictEqual(enroll.status, 200, JSON.stringify(enroll.body));

    const cut = await request(app).post(`${B}/users/me/sessions/revoke`).set('Authorization', sess)
        .send({ currentPassword: PASSWORD });
    assert.strictEqual(cut.status, 200, JSON.stringify(cut.body));

    // Clean up the shared store so a later test in this file cannot inherit an armed bucket.
    for (const s of spellings) await auth.clearLoginFails(s);
});

// ─── CLASS 2 · no failure count may refuse a correct password ─────────────────────────────────────

test('CLASS 2 — the delay policy is total and bounded for EVERY failure count (never "refused")', () => {
    const { sudoDelayMs } = require('../routes/users');

    // The CONTRACT this asserts, deliberately looser than the constants in the implementation so it is a
    // gate and not a mirror: whatever the counter says, the caller waits a finite, non-negative number of
    // milliseconds, no single attempt may be made to wait longer than half a minute, and more failures
    // never make the wait shorter. There is no value in the domain that can mean "come back later".
    const CONTRACT_MAX_MS = 30_000;
    const domain: any[] = [
        ...Array.from({ length: 200 }, (_, i) => i - 5),
        1e3, 1e6, Number.MAX_SAFE_INTEGER,
        -1, -1e9, 0.5, '7', '', null, undefined, NaN, Infinity, -Infinity, {}, [], true, false,
    ];
    for (const input of domain) {
        const ms = sudoDelayMs(input);
        assert.strictEqual(typeof ms, 'number', `sudoDelayMs(${String(input)}) must return a number`);
        assert.ok(Number.isFinite(ms), `sudoDelayMs(${String(input)}) must be finite, got ${ms}`);
        assert.ok(ms >= 0, `sudoDelayMs(${String(input)}) must not be negative, got ${ms}`);
        assert.ok(ms <= CONTRACT_MAX_MS, `sudoDelayMs(${String(input)}) = ${ms} exceeds the ${CONTRACT_MAX_MS}ms contract`);
    }
    for (let n = 0; n < 200; n++) {
        assert.ok(sudoDelayMs(n + 1) >= sudoDelayMs(n), `the wait must never shrink as failures grow (at ${n})`);
    }
});

test('CLASS 2 — a flood past the OLD lockout threshold still lets the owner in with the right password', async () => {
    const login = 'hostage';
    const hijacked = asUser(login);

    // 12 > LOGIN_MAX_FAILS (10): under the previous shape the account-wide bucket armed at 10 and every
    // subsequent attempt — right password included — was answered 429 for fifteen minutes, renewably.
    // (This test is the slow one in the file on purpose: it pays the real escalating delay.)
    for (let i = 0; i < 12; i++) {
        const r = await request(app).put(`${B}/users/me`).set('Authorization', hijacked)
            .send({ personalEmail: `probe${i}@evil.test`, currentPassword: 'not-the-password' });
        assert.strictEqual(r.status, 403, `attempt ${i} must be answered on its merits, got ${r.status}`);
        assert.strictEqual(r.body.code, 'rest_bad_current_password');
        assert.notStrictEqual(r.body.code, 'rest_account_locked',
            'no failure count may ever produce an account lockout on this door');
    }
    assert.strictEqual(await metaOf(U[login], 'personal_email'), undefined,
        'not one of the attacker probes may have landed');

    // The owner's ONE way out — change the password, which stamps token_valid_after and revokes
    // everything the attacker holds — must work with the correct password, immediately.
    const rescue = await request(app).put(`${B}/users/me`).set('Authorization', hijacked)
        .send({ password: 'OwnerRescue-1!', currentPassword: PASSWORD });
    assert.strictEqual(rescue.status, 200, `the owner must never be locked out of their own rescue: ${JSON.stringify(rescue.body)}`);
    await User.authenticate(login, 'OwnerRescue-1!'); // throws if the password did not actually change

    // …and the interactive-login bucket is still untouched: a re-authentication failure throttles
    // re-authentication and nothing else.
    const auth = require('../routes/auth');
    assert.strictEqual(await auth.isLoginLocked(await auth.resolveLockIdentifier(login)), false);
});

test('CLASS 1 — THE DERIVATION IS FALSIFIABLE: a purpose added to the key space adds spellings by itself', () => {
    // A GATE IS ONLY REAL IF ADDING A MEMBER TURNS IT RED. The member here is a new lock purpose; the
    // proof is that the spelling table grows without anyone editing it, so the CLASS 1 test above arms
    // the new bucket against the owner's recovery doors on its own.
    const auth = require('../routes/auth');
    const original = auth.LOCK_PURPOSES;
    const before = collisionSpellings('victim', 7);
    try {
        auth.LOCK_PURPOSES = [...original, 'billing'];
        const after = collisionSpellings('victim', 7);
        assert.ok(after.length > before.length, 'a new purpose produced no new spelling — the table is not derived');
        for (const expected of ['billing:victim', 'BILLING:VICTIM', '  billing:victim  ', 'billing:7']) {
            assert.ok(after.includes(expected), `the derivation missed ${JSON.stringify(expected)}`);
        }
    } finally {
        auth.LOCK_PURPOSES = original;
    }
    // …and a purpose REMOVED from the source keeps its spellings: a store in a running install still
    // holds rows keyed the old way, so "we stopped writing it" is not "it cannot be armed".
    for (const gone of HISTORICAL_LOCK_PREFIXES) {
        assert.ok(collisionSpellings('victim', 7).includes(`${gone}:victim`),
            `${gone}: a prefix this class was born from must stay in the table after it leaves the source`);
    }
});

// ─── THE DOOR TABLE IS DERIVED FROM THE CALL SITES ────────────────────────────────────────────────
//
// ROUND-3 FINDING (verify3 #25b): the table below used to be five rows written by hand. It named
// PUT /users/me twice and OMITTED /auth/mfa/enable — which at the time was the door that failed. Six
// green tests, one broken door, no contradiction: nothing connected the rows to the call sites.
//
/// The population is now read out of the routers themselves. Every CallExpression of
// `requireSudoPassword` in backend/src/routes/*.ts is located in the syntax tree and attributed to the
// route registration that encloses it; the mount prefix comes from routes/index.ts. The match is a
// BIJECTION: a door with no row fails (a new gate nobody held to the property), and a row naming a door
// that no longer exists fails too (a stale row is a claim of coverage that is not there).
//
// ROUND-4 FINDING (verify4 #11): the first version of that attribution returned `null` for anything it
// could not read and the caller treated `null` as "not a door", so FOUR ordinary Express spellings were
// DISCARDED IN SILENCE — `router.route('/me').put(…)`, a router variable not literally named `router`,
// a middleware precomputed into a const, and an ALIASED import of the gate. Silent discard is the worst
// failure mode a derived population can have: the floor below (`>= 4`) is still met while the door that
// matters is missing, which is precisely how round 3 found PUT /users/me named twice and
// POST /auth/mfa/enable named not at all. So the derivation now:
//   · recognises those spellings (any identifier bound to `express.Router()`, `.route(path).<verb>()`,
//     a gate call assigned to a const and later used as middleware, and local aliases of the gate);
//   · and, for anything still unreadable, produces an UNATTRIBUTED row that fails the gate out loud,
//     the way the anonymous-entry-channels walk already fails on a mount form it cannot decode.
// `deriveSudoDoors` is run over synthetic sources by its own test below, so those spellings are executable
// cases rather than a promise in a comment.
const ts = require('typescript');
const ROUTES_DIR = path.join(__dirname, '..', 'routes');
const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'];
const SUDO_GATE = 'requireSudoPassword';

/** '<file>.ts' → the prefix routes/index.ts mounts that router at. */
function routerMounts(): Record<string, string> {
    const src = fs.readFileSync(path.join(ROUTES_DIR, 'index.ts'), 'utf8');
    const alias: Record<string, string> = {};
    for (const m of src.matchAll(/const\s+(\w+)\s*=\s*require\('\.\/([\w-]+)'\)/g)) alias[m[1]] = m[2];
    const out: Record<string, string> = {};
    for (const m of src.matchAll(/router\.use\(\s*'([^']+)'\s*,\s*(?:(\w+)|require\('\.\/([\w-]+)'\))\s*\)/g)) {
        const file = m[3] || alias[m[2] as string];
        if (file) out[`${file}.ts`] = m[1];
    }
    assert.ok(Object.keys(out).length > 5, 'routes/index.ts mount table could not be read — this gate is blind');
    return out;
}

interface SudoDoor { file: string; method: string; routePath: string; url: string; line: number; key: string }
interface DerivedDoor { file: string; method: string; routePath: string; line: number }
interface Derivation { doors: DerivedDoor[]; delegations: string[]; unattributed: string[] }

/** `x` → 'x', `a.x` → 'x', `a['x']` → 'x'; parens/await/casts unwrapped. Anything else → null. */
function refName(node: any): string | null {
    if (!node) return null;
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) {
        return node.argumentExpression.text;
    }
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isAwaitExpression(node)) {
        return refName(node.expression);
    }
    return null;
}

const walkAst = (node: any, fn: (n: any) => void): void => { fn(node); ts.forEachChild(node, (c: any) => walkAst(c, fn)); };

/**
 * Every route registration in one file, as {method, path, node, argNames}. Registrations are recognised
 * on any identifier that the file binds to a Router — not on the literal text `router.` — plus the
 * `.route('<path>').<verb>(…)` form, plus an ARRAY of literal paths (one registration per path).
 *
 * A registration whose path is not legible keeps `routePath: null` instead of throwing here: most routers
 * in this tree have such a route and none of them is a sudo door, so failing at COLLECTION time would
 * make the gate depend on files it has nothing to say about. It becomes loud at ATTRIBUTION time — a sudo
 * call inside an unnamed registration is reported as unattributed, because this gate NAMES every door it
 * covers and a door it cannot name is a door it cannot claim.
 */
function routeRegistrations(sf: any, label: string) {
    const routerIds = new Set<string>();
    walkAst(sf, (n: any) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
            && ts.isCallExpression(n.initializer) && refName(n.initializer.expression) === 'Router') {
            routerIds.add(n.name.text);
        }
    });
    const regs: Array<{ method: string; routePath: string | null; node: any; args: string[] }> = [];
    walkAst(sf, (n: any) => {
        if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
        const verb = n.expression.name.text;
        if (!HTTP_VERBS.includes(verb)) return;
        const target = n.expression.expression;
        let pathNode: any;
        if (ts.isIdentifier(target) && routerIds.has(target.text)) {
            pathNode = n.arguments[0];
        } else if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)
            && target.expression.name.text === 'route' && ts.isIdentifier(target.expression.expression)
            && routerIds.has(target.expression.expression.text)) {
            pathNode = target.arguments[0];
        } else {
            return;
        }
        const args = n.arguments.map((a: any) => refName(a) || '').filter(Boolean);
        const push = (routePath: string | null) => regs.push({ method: verb.toUpperCase(), routePath, node: n, args });
        if (pathNode && ts.isStringLiteral(pathNode)) push(pathNode.text);
        else if (pathNode && ts.isArrayLiteralExpression(pathNode) && pathNode.elements.every((e: any) => ts.isStringLiteral(e))) {
            for (const e of pathNode.elements) push(e.text);   // one registration, several nameable doors
        } else push(null);                                      // unnameable — loud only if a sudo call is inside it
        void label;
    });
    return regs;
}

/**
 * The sudo doors declared by a set of source units. `units` rather than "the routes directory" so the
 * same derivation can be run over synthetic sources by the spelling test below — the population and the
 * proof that the population is complete come from ONE function.
 */
function deriveSudoDoors(units: Array<{ name: string; text: string }>): Derivation {
    const doors: DerivedDoor[] = [];
    const delegations: string[] = [];
    const unattributed: string[] = [];

    for (const unit of units) {
        const sf = ts.createSourceFile(unit.name, unit.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        // Local names for the gate: the export itself plus any alias this file binds it to, in either
        // spelling (`const { requireSudoPassword: sudo } = require('./users')`, `const sudo = u.requireSudoPassword`).
        const gateNames = new Set<string>([SUDO_GATE]);
        for (let pass = 0; pass < 4; pass++) {
            const before = gateNames.size;
            walkAst(sf, (n: any) => {
                if (!ts.isVariableDeclaration(n) || !n.initializer) return;
                if (ts.isIdentifier(n.name)) {
                    const ref = refName(n.initializer);
                    if (ref && gateNames.has(ref)) gateNames.add(n.name.text);
                } else if (ts.isObjectBindingPattern(n.name)) {
                    for (const el of n.name.elements) {
                        const prop = (el.propertyName ? el.propertyName.getText(sf) : el.name.getText(sf)).replace(/['"]/g, '');
                        if (gateNames.has(prop)) gateNames.add(el.name.getText(sf));
                    }
                }
            });
            if (gateNames.size === before) break;
        }

        const regs = routeRegistrations(sf, unit.name);
        walkAst(sf, (node: any) => {
            if (!ts.isCallExpression(node)) return;
            const callee = refName(node.expression);
            if (!callee || !gateNames.has(callee)) return;
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

            // (1) inside a route registration — the ordinary case, the `.route().verb()` chain, and the
            //     array-of-paths form (which registers several doors from one call, so it yields several).
            const enclosing = regs.filter((r) => node.getStart(sf) >= r.node.getStart(sf) && node.getEnd() <= r.node.getEnd());
            if (enclosing.length) {
                const unnamed = enclosing.filter((r) => r.routePath === null);
                if (unnamed.length) {
                    unattributed.push(`${unit.name}:${line} — the sudo gate sits inside a registration with a `
                        + `non-literal path (${unnamed[0].node.getText(sf).slice(0, 80).replace(/\s+/g, ' ')}…), so this gate `
                        + 'cannot name the door it protects');
                    return;
                }
                for (const r of enclosing) doors.push({ file: unit.name, method: r.method, routePath: r.routePath as string, line });
                return;
            }

            // (2) a DELEGATION: a function that merely re-exposes the gate under the same name (routes/auth.ts
            //     wraps the routes/users.ts implementation). Recognised structurally — the enclosing function
            //     is itself one of the gate names — not by being unreadable.
            let fnName: string | null = null;
            for (let p = node.parent; p; p = p.parent) {
                if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p) || ts.isMethodDeclaration(p)) {
                    if (p.name && ts.isIdentifier(p.name)) fnName = p.name.text;
                    else if (p.parent && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) fnName = p.parent.name.text;
                    break;
                }
            }
            if (fnName && gateNames.has(fnName)) { delegations.push(`${unit.name}:${line} — ${fnName}() delegates`); return; }

            // (3) a PRECOMPUTED middleware: `const guard = requireSudoPassword('…')`, later handed to one or
            //     more registrations. Every registration that uses that name is a door.
            let bound: string | null = null;
            for (let p = node.parent; p; p = p.parent) {
                if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) { bound = p.name.text; break; }
                if (ts.isCallExpression(p) && p !== node) break;
            }
            if (bound) {
                const users = regs.filter((r) => r.args.includes(bound as string));
                if (users.length) {
                    for (const r of users) {
                        if (r.routePath === null) {
                            unattributed.push(`${unit.name}:${line} — the precomputed gate '${bound}' is used by a `
                                + 'registration whose path is not a literal, so the door cannot be named');
                        } else doors.push({ file: unit.name, method: r.method, routePath: r.routePath, line });
                    }
                    return;
                }
            }

            // (4) anything else: LOUD. This is the round-4 fix — the population may not shrink in silence.
            unattributed.push(`${unit.name}:${line} — ${node.getText(sf).slice(0, 90).replace(/\s+/g, ' ')}`);
        });
    }
    return { doors, delegations, unattributed };
}

/**
 * Every route handler in backend/src/routes that goes through requireSudoPassword.
 * NOTE the absence of a `src.includes('requireSudoPassword')` pre-filter: it used to skip files, and a
 * file that imports the gate under an alias through a re-export would never contain the literal string.
 * Parsing all ~38 routers costs a fraction of a second and removes the question.
 */
function sudoDoorSites(): SudoDoor[] {
    const mounts = routerMounts();
    const units = fs.readdirSync(ROUTES_DIR)
        .filter((n: string) => n.endsWith('.ts') && n !== 'index.ts')
        .map((n: string) => ({ name: n, text: fs.readFileSync(path.join(ROUTES_DIR, n), 'utf8') }));
    const { doors, unattributed } = deriveSudoDoors(units);

    assert.deepStrictEqual(unattributed, [],
        'a call to the sudo gate could not be attributed to any route registration, so this gate does not know '
        + 'which door it protects and CANNOT claim to cover it. Teach deriveSudoDoors the spelling (or make the '
        + `registration readable) — do not leave it out:\n  ${unattributed.join('\n  ')}`);

    const found: SudoDoor[] = [];
    const seen = new Set<string>();
    for (const d of doors) {
        const mount = mounts[d.file];
        assert.ok(mount, `${d.file} declares a sudo door but routes/index.ts does not mount it — cannot address it`);
        const key = `${d.file} ${d.method} ${d.routePath}`;
        if (seen.has(key)) continue;   // two gate calls on one route are ONE door
        seen.add(key);
        found.push({
            file: d.file, method: d.method, routePath: d.routePath,
            url: `${mount}${d.routePath === '/' ? '' : d.routePath}`,
            line: d.line, key,
        });
    }
    assert.ok(found.length >= 4, `only ${found.length} sudo doors were derived — the walk is not seeing the routers`);
    return found;
}

/**
 * THE DERIVATION IS ITSELF UNDER TEST. Round 4 demonstrated each spelling below against the previous
 * version, which discarded all four without a word. They are executable cases now, run through the SAME
 * function that derives the real population.
 */
test('CLASS 2 — the door derivation reads every ordinary Express spelling, and shouts at the ones it cannot', () => {
    const one = (text: string) => deriveSudoDoors([{ name: 'probe.ts', text }]);
    const keysOf = (d: Derivation) => d.doors.map((x) => `${x.method} ${x.routePath}`).sort();

    // (A) CONTROL — the canonical spelling the old derivation did read.
    assert.deepStrictEqual(keysOf(one("const router = express.Router();\nrouter.put('/me', authenticate, requireSudoPassword('x'), h);")),
        ['PUT /me'], 'the canonical registration must still be read');

    // (B) the .route() chain, (C) a router variable not named `router`, (F) a precomputed middleware,
    // (D) an aliased import of the gate — all four were DISCARDED IN SILENCE before.
    const spellings: Array<[string, string, string[]]> = [
        ['.route() chain', "const router = express.Router();\nrouter.route('/me').put(authenticate, requireSudoPassword('x'), h);", ['PUT /me']],
        ['router bound to another name', "const r = express.Router();\nr.put('/me', authenticate, requireSudoPassword('x'), h);", ['PUT /me']],
        ['precomputed middleware', "const r = express.Router();\nconst GUARD = requireSudoPassword('x');\nr.put('/me', authenticate, GUARD, h);", ['PUT /me']],
        ['aliased gate import', "const r = express.Router();\nconst sudo = require('./users').requireSudoPassword;\nr.put('/me', authenticate, sudo('x'), h);", ['PUT /me']],
        ['destructured alias', "const r = express.Router();\nconst { requireSudoPassword: sudo } = require('./users');\nr.post('/me/x', sudo('x'), h);", ['POST /me/x']],
    ];
    for (const [name, text, expected] of spellings) {
        const d = one(text);
        assert.deepStrictEqual(d.unattributed, [], `${name}: the derivation could not attribute the gate call`);
        assert.deepStrictEqual(keysOf(d), expected, `${name}: wrong door derived`);
    }

    // (E) an array of literal paths is READ (one registration, several nameable doors)…
    assert.deepStrictEqual(keysOf(one("const r = express.Router();\nr.put(['/a','/b'], requireSudoPassword('x'), h);")),
        ['PUT /a', 'PUT /b'], 'an array of literal paths registers several doors, and all of them are named');

    // …while a path this gate cannot name is LOUD rather than dropped.
    const computed = one("const r = express.Router();\nfor (const p of ['/a','/b']) r.put(p, requireSudoPassword('x'), h);");
    assert.deepStrictEqual(computed.doors, [], 'a door on a computed path must not be silently named something');
    assert.match(computed.unattributed.join('\n'), /non-literal path/,
        'a sudo door mounted on a computed path must be reported, not dropped');

    // …and a gate call that reaches no registration at all is reported, not skipped.
    const orphan = one("const helper = () => requireSudoPassword('x');");
    assert.deepStrictEqual(orphan.doors, [], 'an orphan gate call is not a door');
    assert.strictEqual(orphan.unattributed.length, 1, 'an orphan gate call must be reported as unattributed');

    // A DELEGATION (routes/auth.ts's wrapper of the users implementation) is classified, not discarded.
    const deleg = one("function requireSudoPassword(req, res) {\n  return require('./users').requireSudoPassword(req, res, req.body.currentPassword);\n}");
    assert.deepStrictEqual(deleg.unattributed, [], 'the delegation wrapper must be classified');
    assert.strictEqual(deleg.delegations.length, 1, 'the delegation wrapper must be recognised as a delegation');
    assert.deepStrictEqual(deleg.doors, [], 'a delegation is not a door');
});

test('CLASS 2 — EVERY sudo-gated door recovers, not just the one the report named', async () => {
    // One row per door that calls requireSudoPassword — and the rows are CHECKED AGAINST THE SOURCE
    // below, so this list cannot quietly fall behind the routers again.
    const doors: Array<{ site: string; name: string; persona: string; send: (p: string, pw: string) => any; alsoExpect?: (res: any) => boolean }> = [
        {
            site: 'users.ts PUT /me', name: 'PUT /users/me {personalEmail}', persona: 'doorMe',
            send: (p, pw) => request(app).put(`${B}/users/me`).set('Authorization', asUser(p))
                .send({ personalEmail: `${p}@recovery.test`, currentPassword: pw }),
            alsoExpect: (r) => r.status === 200,
        },
        {
            site: 'users.ts PUT /:id', name: 'PUT /users/:ownId {personalEmail}', persona: 'doorTwin',
            send: (p, pw) => request(app).put(`${B}/users/${U[p]}`).set('Authorization', asUser(p))
                .send({ personalEmail: `${p}@recovery.test`, currentPassword: pw }),
            alsoExpect: (r) => r.status === 200,
        },
        {
            site: 'auth.ts POST /mfa/setup', name: 'POST /auth/mfa/setup', persona: 'doorMfa',
            send: (p, pw) => request(app).post(`${B}/auth/mfa/setup`).set('Authorization', asUser(p))
                .send({ currentPassword: pw }),
            alsoExpect: (r) => r.status === 200,
        },
        {
            // ADDED BY THE DERIVATION: this door existed and had no row. At the time of the round-3
            // audit it was also BROKEN — it fell into a check-then-refuse against a bucket an anonymous
            // /auth/login could arm — and the suite was 6/6 green throughout.
            site: 'auth.ts POST /mfa/enable', name: 'POST /auth/mfa/enable', persona: 'doorMfaEnable',
            send: (p, pw) => request(app).post(`${B}/auth/mfa/enable`).set('Authorization', asUser(p))
                .send({ currentPassword: pw, code: '000000' }),
            // No pending secret, so the CODE is refused (400) — which is the door OPENING: the sudo gate
            // let the caller through on the strength of a correct password.
            alsoExpect: (r) => r.status === 400 && r.body.code === 'rest_mfa_invalid',
        },
        {
            site: 'users.ts POST /me/sessions/revoke', name: 'POST /users/me/sessions/revoke', persona: 'doorSessions',
            send: (p, pw) => request(app).post(`${B}/users/me/sessions/revoke`).set('Authorization', asUser(p))
                .send({ currentPassword: pw }),
            alsoExpect: (r) => r.status === 200,
        },
        {
            site: 'users.ts PUT /me', name: 'PUT /users/me {password}', persona: 'doorPassword',
            send: (p, pw) => request(app).put(`${B}/users/me`).set('Authorization', asUser(p))
                .send({ password: 'Rotated-Pass-2!', currentPassword: pw }),
            alsoExpect: (r) => r.status === 200,
        },
        {
            // ADDED BY THE DERIVATION: DELETE /plugins/:slug re-uses the shared sudo door. The password
            // check runs BEFORE the existence check, so a slug that does not exist still exercises it.
            site: 'plugins.ts DELETE /:slug', name: 'DELETE /plugins/:slug', persona: 'doorPluginAdmin',
            send: (p, pw) => request(app).delete(`${B}/plugins/zz-door-probe`).set('Authorization', asUser(p))
                .send({ password: pw }),
            alsoExpect: (r) => r.status === 404,   // past the credential, refused on the merits
        },
    ];

    // ── THE BIJECTION: the rows and the call sites are the same set ──────────────────────────────
    const discovered = sudoDoorSites();
    const discoveredKeys = new Set(discovered.map((d) => d.key));
    const rowKeys = new Set(doors.map((d) => d.site));
    const uncovered = [...discoveredKeys].filter((k) => !rowKeys.has(k)).sort();
    assert.deepStrictEqual(uncovered, [],
        'a route calls requireSudoPassword and NO row above holds it to the class property ("a correct ' +
        'credential is never refused"). That is exactly how /auth/mfa/enable stayed broken while this file ' +
        `was 6/6 green. Sites found: ${JSON.stringify(discovered.map((d) => `${d.key} @${d.line}`))}`);
    const stale = [...rowKeys].filter((k) => !discoveredKeys.has(k)).sort();
    assert.deepStrictEqual(stale, [],
        'a row names a door that no longer calls requireSudoPassword — a stale row claims coverage that is not there');

    for (const door of doors) {
        for (let i = 0; i < 4; i++) {
            const bad = await door.send(door.persona, 'wrong-password');
            assert.strictEqual(bad.status, 403, `${door.name}: a wrong password must be a 403, got ${bad.status}`);
            assert.strictEqual(bad.body.code, 'rest_bad_current_password', `${door.name}: ${JSON.stringify(bad.body)}`);
        }
        const good = await door.send(door.persona, PASSWORD);
        // THE CLASS PROPERTY, stated once for every door regardless of what the handler does next: the
        // correct credential is never refused AS A CREDENTIAL, and no failure count may answer 429.
        assert.notStrictEqual(good.body && good.body.code, 'rest_bad_current_password',
            `${door.name}: the RIGHT password was refused after failures — ${JSON.stringify(good.body)}`);
        assert.notStrictEqual(good.status, 429,
            `${door.name}: a failure count answered the correct credential with a lockout — ${JSON.stringify(good.body)}`);
        if (door.alsoExpect) {
            assert.ok(door.alsoExpect(good),
                `${door.name}: the door did not open as declared — ${good.status} ${JSON.stringify(good.body)}`);
        }
    }
});

// ─── CLASS 3 · the sessionOnly doctrine covers the whole router, not two routes ───────────────────

test('CLASS 3 — an administrator API token cannot drive ANY account-security write in /users', async () => {
    const token = await mintToken('admin', '*'); // the strongest token that can be minted
    const bearer = `Bearer ${token}`;
    const victim = U.target;

    // Every write this router exposes, with the field that makes it account security. The refusal is
    // asserted by CODE, and each row also names the side effect that must NOT have happened.
    const attempts: Array<{ name: string; run: () => any; assertUntouched?: () => Promise<void> }> = [
        {
            name: 'POST /users (mint a fresh administrator)',
            run: () => request(app).post(`${B}/users`).set('Authorization', bearer)
                .send({ username: 'tokenmade', email: 'tokenmade@example.com', password: 'Sneaky-Pass-1!', role: 'administrator' }),
            assertUntouched: async () => {
                assert.strictEqual(await User.findByLogin('tokenmade'), null, 'no account may have been created');
            },
        },
        {
            name: 'PUT /users/:id {password} (seize another account)',
            run: () => request(app).put(`${B}/users/${victim}`).set('Authorization', bearer).send({ password: 'TokenOwned-1!' }),
            assertUntouched: async () => {
                await assert.rejects(() => User.authenticate('target', 'TokenOwned-1!'), 'the password must be unchanged');
            },
        },
        {
            name: 'PUT /users/:id {email} (rewrite the recovery fallback)',
            run: () => request(app).put(`${B}/users/${victim}`).set('Authorization', bearer).send({ email: 'attacker@evil.test' }),
            assertUntouched: async () => {
                const u = await User.findById(victim);
                assert.strictEqual(u.userEmail, 'target@example.com');
            },
        },
        {
            name: 'PUT /users/:id {personalEmail} (rewrite the recovery address)',
            run: () => request(app).put(`${B}/users/${victim}`).set('Authorization', bearer).send({ personalEmail: 'attacker@evil.test' }),
            assertUntouched: async () => {
                assert.strictEqual(await metaOf(victim, 'personal_email'), undefined);
            },
        },
        {
            name: 'PUT /users/:id {role} (privilege)',
            run: () => request(app).put(`${B}/users/${victim}`).set('Authorization', bearer).send({ role: 'administrator' }),
            assertUntouched: async () => {
                assert.strictEqual((await metaOf(victim, 'role')).meta_value, 'author');
            },
        },
        {
            name: 'PUT /users/:id {professionalMailbox} (the admin-owned grant)',
            run: () => request(app).put(`${B}/users/${victim}`).set('Authorization', bearer).send({ professionalMailbox: true }),
        },
        {
            name: 'PUT /users/me {password} (the token owner re-credentialing themselves)',
            run: () => request(app).put(`${B}/users/me`).set('Authorization', bearer).send({ password: 'Rotated-3!', currentPassword: PASSWORD }),
        },
        {
            name: 'PUT /users/me {personalEmail}',
            run: () => request(app).put(`${B}/users/me`).set('Authorization', bearer).send({ personalEmail: 'attacker@evil.test', currentPassword: PASSWORD }),
        },
        {
            name: 'POST /users/:id/mfa/reset',
            run: () => request(app).post(`${B}/users/${victim}/mfa/reset`).set('Authorization', bearer).send({}),
        },
        {
            name: 'POST /users/me/sessions/revoke',
            run: () => request(app).post(`${B}/users/me/sessions/revoke`).set('Authorization', bearer).send({ currentPassword: PASSWORD }),
        },
        {
            name: 'DELETE /users/:id',
            run: () => request(app).delete(`${B}/users/${victim}`).set('Authorization', bearer),
            assertUntouched: async () => {
                assert.ok(await User.findById(victim), 'the account must still exist');
            },
        },
    ];

    for (const a of attempts) {
        const res = await a.run();
        assert.strictEqual(res.status, 403, `${a.name} must be refused to a token, got ${res.status} ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.code, 'rest_token_management_forbidden', `${a.name}: ${JSON.stringify(res.body)}`);
        if (a.assertUntouched) await a.assertUntouched();
    }
});

// ─── CLASS 3 · the MATRIX is a product of the module's own table, not eleven remembered rows ──────
//
// ROUND-3 FINDING (verify3 #25c, #9): the matrix above is eleven hand-written rows and every one of
// them carries a NON-EMPTY value, so the whole blank/null axis fell outside it — and the sibling test
// below used to ASSERT the resulting hole as correct behaviour. Meanwhile two of the six fields have
// sinks that condition on mere PRESENCE, so `{personalEmail: ''}` read as "not supplied" to the guard
// and as "clear the recovery address" to the sink: an administrator token could blank ANY account's
// recovery address and revoke mailbox grants.
//
// This test states the property over the PRODUCT of the module's own declarations:
//     every field in routes/users.ts ACCOUNT_SECURITY_FIELDS  ×  {a real value, '', '   ', null}
// with the expectation taken from the field's OWN declared criterion — 'presence' means any present
// value is a write and must be refused; 'nonblank' means a blank one is genuinely not supplied. A field
// added to that map appears here by itself, in every shape, with no row to remember.
//
// The side effect is observed GENERICALLY (a full snapshot of the user's row and every meta key), so a
// new field needs no probe of its own: whatever it would have written shows up as a diff.
test('CLASS 3 — the blank/null axis, over the PRODUCT of the module\'s field table and its criteria', async () => {
    const users = require('../routes/users');
    const FIELDS: Record<string, string> = users.ACCOUNT_SECURITY_FIELDS;
    assert.ok(FIELDS && typeof FIELDS === 'object' && Object.keys(FIELDS).length >= 5,
        'routes/users.ts must export ACCOUNT_SECURITY_FIELDS as field→criterion: this gate derives the ' +
        'population and the expectation from it, and a hand-written copy is what let the blank axis through');

    const bearer = `Bearer ${await mintToken('admin', '*')}`;
    const victim = U.blankVictim;
    const REAL: Record<string, any> = {
        password: 'TokenOwned-9!', currentPassword: PASSWORD, email: 'attacker@evil.test',
        personalEmail: 'attacker@evil.test', role: 'administrator', professionalMailbox: true,
    };
    const BLANKS: Array<[string, any]> = [['empty string', ''], ['whitespace', '   '], ['null', null]];

    // The whole account-security state of the victim, whatever it consists of.
    const snapshot = async () => JSON.stringify({
        row: await dbAsync.get('SELECT * FROM users WHERE id = ?', [victim]),
        meta: await dbAsync.all('SELECT meta_key, meta_value FROM user_meta WHERE user_id = ? ORDER BY meta_key', [victim]),
    });

    for (const [field, criterion] of Object.entries(FIELDS)) {
        assert.ok(['presence', 'nonblank'].includes(criterion),
            `${field} declares criterion ${JSON.stringify(criterion)}, which this gate does not know how to check`);
        assert.ok(field in REAL, `${field} was added to ACCOUNT_SECURITY_FIELDS with no sample value here — add one`);

        const cases: Array<[string, any]> = [[`a real value (${JSON.stringify(REAL[field])})`, REAL[field]], ...BLANKS];
        for (const [label, value] of cases) {
            const before = await snapshot();
            const res = await request(app).put(`${B}/users/${victim}`).set('Authorization', bearer).send({ [field]: value });
            const supplied = users.fieldIsSupplied(field, { [field]: value });

            if (supplied) {
                assert.strictEqual(res.status, 403,
                    `PUT {${field}: ${label}} is SUPPLIED by this field's own criterion (${criterion}) and must be ` +
                    `refused to an API token, got ${res.status} ${JSON.stringify(res.body)}`);
                assert.strictEqual(res.body.code, 'rest_token_management_forbidden', JSON.stringify(res.body));
            } else {
                assert.notStrictEqual(res.status, 403,
                    `PUT {${field}: ${label}} is NOT supplied by this field's criterion (${criterion}), so refusing ` +
                    'it would 403 every form that resends an empty input for no reason');
            }
            // EITHER WAY the account-security state must be untouched. This is the assertion the old
            // matrix could not make: the guard reads a value, the SINK reads presence, and only a
            // before/after comparison catches the two disagreeing.
            assert.strictEqual(await snapshot(), before,
                `PUT {${field}: ${label}} CHANGED the account: an API token drove an account-security write ` +
                'through a value the exemption called "not supplied"');
        }
    }
});

test('CLASS 3 — the exemption is exactly "a profile PUT that carries no account-security field"', async () => {
    const bearer = `Bearer ${await mintToken('admin', '*')}`;

    // Reads are unaffected — a token is a legitimate way to LOOK at the user list.
    for (const url of [`${B}/users`, `${B}/users/me`, `${B}/users/${U.target}`]) {
        const res = await request(app).get(url).set('Authorization', bearer);
        assert.strictEqual(res.status, 200, `${url} must remain readable headlessly: ${JSON.stringify(res.body)}`);
    }

    // …and so is a purely cosmetic self-update, which is the one write the doctrine does not claim.
    const cosmetic = await request(app).put(`${B}/users/me`).set('Authorization', bearer).send({ displayName: 'Headless Bot' });
    assert.strictEqual(cosmetic.status, 200, JSON.stringify(cosmetic.body));
    assert.strictEqual(cosmetic.body.displayName, 'Headless Bot');

    // A blank value of a field whose SINK ignores blanks is genuinely "not supplied" and must not flip
    // the gate — a client that resends `{displayName, email: "   "}` would otherwise be refused for no
    // reason. `email`'s sink is `suppliedText()`, so a whitespace-only one never reaches storage.
    //
    // NOTE (this assertion used to bless the hole): `personalEmail: ''` is NOT in this list any more. Its
    // sink conditions on `!== undefined` and a blank one CLEARS the stored recovery address, so a blank
    // value of that field is a write and is refused headlessly like any other. The per-field criterion
    // lives in ACCOUNT_SECURITY_FIELDS (routes/users.ts) and the class gate iterates it; see
    // backend/src/tests/account-security-value-gates.test.ts.
    const blank = await request(app).put(`${B}/users/me`).set('Authorization', bearer)
        .send({ displayName: 'Headless Bot 2', email: '   ' });
    assert.strictEqual(blank.status, 200, JSON.stringify(blank.body));

    // The control: the SAME operations over an interactive session are not refused as token management.
    const session = await request(app).put(`${B}/users/${U.target}`).set('Authorization', asUser('admin'))
        .send({ personalEmail: 'set-by-admin@example.test' });
    assert.strictEqual(session.status, 200, JSON.stringify(session.body));
});
