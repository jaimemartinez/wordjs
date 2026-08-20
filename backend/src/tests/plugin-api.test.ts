/**
 * Tests for the plugin capability bridge (src/core/plugin-api.ts).
 * The plugin gets admin on the relevant scopes, so these assert the bridge's OWN constraints
 * (secret-option blocklist, core-table scoping, path confinement) — not the permission gate.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Preload core modules from the (trusted) test context so later in-plugin-context lazy loads
// don't trip the fs sandbox during their first require.
require('../config/app');
require('../core/options');
require('../config/database');
require('../core/hooks');

const { createPluginApi } = require('../core/plugin-api');
const { runWithContext } = require('../core/plugin-context');

const SLUG = 'test-api-plugin';
const dir = path.join(path.resolve(__dirname, '../../plugins'), SLUG);

before(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        name: SLUG,
        permissions: [
            { scope: 'settings', access: 'admin' },
            { scope: 'database', access: 'admin' },
            { scope: 'filesystem', access: 'admin' }
        ]
    }));
    // Bridge permissions are now default-deny — an admin must GRANT what the manifest requests. Grant
    // this (untrusted) test plugin's declared scopes so the bridge runs and we exercise its OWN
    // constraints (secret-option/SQL/path scoping), which apply to untrusted-but-granted plugins.
    require('../core/plugin-permissions')._setGrantsInMemory(SLUG, ['settings:admin', 'database:admin', 'filesystem:admin']);
});
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

test('bridge blocks reading secret-named options', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        await assert.rejects(() => api.options.get('mail_security_dkim_private_key'), /not readable/);
        await assert.rejects(() => api.options.set('jwt_secret', 'x'), /not writable/);
        // Broadened blocklist: keys with key/credential/auth/cert/api_key that the old regex missed.
        await assert.rejects(() => api.options.get('stripe_api_key'), /not readable/);
        await assert.rejects(() => api.options.get('encryption_key'), /not readable/);
        await assert.rejects(() => api.options.get('oauth_credentials'), /not readable/);
    });
});

test('bridge blocks SQL touching core tables (incl. regex-evasion bypasses)', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        await assert.rejects(() => api.db.all('SELECT * FROM users'), /off-limits/);
        await assert.rejects(() => api.db.run("UPDATE user_meta SET meta_value='administrator'"), /off-limits/);
        // Evasions that slipped past the old `FROM <table>` matcher:
        await assert.rejects(() => api.db.all('SELECT * FROM plugin_t, users'), /off-limits|comma join|not owned/i);   // comma join: first table isn't prefix-owned → blocked before `users` can attach
        await assert.rejects(() => api.db.all('SELECT * FROM/**/users'), /off-limits/);            // comment-as-whitespace
        await assert.rejects(() => api.db.all("SELECT option_value FROM options WHERE option_name='jwt_secret'"), /off-limits/); // secret exfil via options table
    });
});

// 2026-07-20 audit HIGH: the lexer treated ANY `--` as a to-EOL comment (SQLite/Postgres semantics), but
// MySQL/MariaDB only comment `-- ` (dash-dash-whitespace) — `--0` is arithmetic there. So a plugin's
// `... WHERE 2=1--0 UNION SELECT user_pass FROM users` was blanked by the guard yet EXECUTED by MySQL,
// dumping password hashes. The lexer now requires whitespace/EOL after `--`, and MySQL executable comments
// `/*! … */` (run on MySQL, blanked by the generic `/* */` lexer) are denied outright.
test('bridge blocks the MySQL comment-divergence SQL-scoping bypass (--0 / /*! */)', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        const PFX = api.db.tablePrefix;
        // `--0` is NOT a comment (no following whitespace) → the UNION + `users` stay visible → denied.
        await assert.rejects(() => api.db.all(`SELECT a FROM ${PFX}t WHERE 2=1--0 UNION SELECT user_pass FROM users`), /off-limits|not owned/i);
        // MySQL executable comment: content runs on MySQL, blanked by the generic lexer → denied by marker.
        await assert.rejects(() => api.db.all(`SELECT a FROM ${PFX}t WHERE 1=1/*! UNION SELECT user_pass FROM users */`), /executable comment|off-limits|not owned/i);
        // Backslash-escape divergence (re-verify): `'\''` desyncs MySQL's string-lexing from the guard's,
        // hiding a UNION inside a "string". Any backslash in plugin SQL is denied outright.
        await assert.rejects(() => api.db.all(`SELECT a FROM ${PFX}t WHERE b='\\'' UNION SELECT user_pass FROM users-- '`), /backslash|off-limits|not owned/i);
        // Postgres dollar-quoting: `$q$'$q$` hides a `'` so a following UNION runs on PG while the guard
        // scans a phantom string. Dollar-quote markers are denied outright.
        await assert.rejects(() => api.db.all(`SELECT a FROM ${PFX}t WHERE b=$q$'$q$ UNION SELECT user_pass FROM users`), /\$|dollar|off-limits|not owned/i);
        // Non-ASCII dollar-quote tag ($café$) — Postgres accepts it; the deny-all-$ structural fix catches it.
        await assert.rejects(() => api.db.all(`SELECT a FROM ${PFX}t WHERE b=$café$'$café$ UNION SELECT user_pass FROM users`), /\$|dollar|off-limits|not owned/i);
        // Postgres ends a `--` comment at a bare CR (\r), not just \n; the tail after it must stay visible.
        await assert.rejects(() => api.db.all(`SELECT a FROM ${PFX}t WHERE b=1 -- x\rUNION SELECT user_pass FROM users`), /off-limits|not owned/i);
        // Postgres `[...]` array-subscript can hold a subquery that reads another plugin's table, laundered
        // past the walker as an opaque token. Square brackets are denied outright.
        await assert.rejects(() => api.db.all(`SELECT v[(SELECT total FROM wjp_other_orders)] FROM ${PFX}t`), /bracket|square|off-limits|not owned/i);
        // MySQL STRAIGHT_JOIN is a single-token join operator — the right-hand table must still be captured
        // + prefix-checked, so a core (users) or another plugin's table can't be read through it.
        await assert.rejects(() => api.db.all(`SELECT * FROM ${PFX}t STRAIGHT_JOIN users`), /off-limits|not owned/i);
        await assert.rejects(() => api.db.all(`SELECT * FROM ${PFX}t STRAIGHT_JOIN wjp_other_orders`), /off-limits|not owned/i);
        // A LEGIT trailing `-- comment` (dash-dash-space) must still be stripped and the query scoped-OK
        // (it may fail on a real "no such table" DB error, but must NOT be a scoping denial).
        let err: any = null;
        try { await api.db.all(`SELECT a FROM ${PFX}t -- fetch the rows`); } catch (e) { err = e; }
        assert.ok(!err || !/off-limits|not owned|executable/i.test(String(err.message)), `a real "-- " comment must still work: ${err && err.message}`);
    });
});

// Regression: a plugin's OWN table may have a COLUMN named like a core table (conference-manager's
// `fields` table has an `options` column). Writing it must NOT trip the core-table denylist — the
// denylist only matches an actual table REFERENCE, not a column in an INSERT list / UPDATE SET.
test('bridge allows a column named like a core table in the plugin OWN table (no denylist false-positive)', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        const PFX = api.db.tablePrefix;
        for (const sql of [
            `INSERT INTO ${PFX}fields (conference_id, name, options, status, type) VALUES (1, 'x', 'a|b', 'on', 'text')`,
            `UPDATE ${PFX}fields SET options = 'a|b', status = 'on', type = 'text' WHERE id = 1`,
        ]) {
            let err: any = null;
            try { await api.db.run(sql); } catch (e) { err = e; }
            // It may fail on a real DB error (e.g. no such table in the test DB), but it must NOT be the
            // scoping denial — that proves the SQL passed the prefix/denylist gate.
            assert.ok(!err || !/off-limits/.test(String(err.message)), `column named like a core table must not trip the denylist: ${err && err.message}`);
        }
    });
});

// Round-10 regression: Postgres `DELETE ... USING <table> ... RETURNING` reached non-denylisted tables
// (other plugins' wjp_* tables) past the per-plugin prefix attribution, exfiltrating scalars via
// RETURNING→lastID. USING is now attributed and RETURNING is rejected for untrusted SQL.
test('bridge blocks the DELETE...USING...RETURNING cross-table bypass', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        const PFX = api.db.tablePrefix;
        await assert.rejects(() => api.db.run(`DELETE FROM ${PFX}t USING wjp_other_secrets v WHERE ${PFX}t.id=v.id`), /not owned|off-limits/); // USING table now attributed
        await assert.rejects(() => api.db.run(`DELETE FROM ${PFX}t WHERE id=1 RETURNING id`), /RETURNING/);                                    // exfil channel denied
        await assert.rejects(() => api.db.run(`DELETE FROM ${PFX}t USING a, b WHERE 1=1`), /comma joins|not owned/);                            // comma list after USING
    });
});

// 2026-07-17 audit CRITICAL: a comma cross-join hidden AFTER a subquery or a JOIN...ON smuggled a core
// table past the FROM attribution (`SELECT users.user_pass FROM (SELECT 1) a, users`) → full read of
// password hashes / the options secrets table / sessions. Now denied (paren-collapse FROM-clause scan).
test('bridge blocks subquery/JOIN-hidden comma cross-joins (critical SQL-guard escape)', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        const PFX = api.db.tablePrefix;
        for (const sql of [
            'SELECT users.user_pass FROM (SELECT 1) a, users',
            'SELECT options.option_value FROM (SELECT 1), options',
            `SELECT x.user_pass FROM ${PFX}t JOIN ${PFX}u ON 1=1, users x`,
        ]) {
            await assert.rejects(() => api.db.all(sql), /comma join|not owned|off-limits/i, `must block: ${sql}`);
        }
        await assert.rejects(() => api.db.run(`INSERT INTO ${PFX}x SELECT user_pass FROM (SELECT 1), users`), /comma join|not owned|off-limits/i);
    });
});

// 2026-07-17 regression: the token-walker attributed the `if` in `CREATE TABLE IF NOT EXISTS <t>` as a
// table named `if`, so EVERY plugin that creates its tables that way was denied at boot (14 failed to
// load isolated). The IF/NOT/EXISTS keywords must be skipped WITHOUT closing the table slot so the REAL
// name is what gets prefix-checked. Owned DDL must pass the guard; a foreign target must still be denied.
test('bridge allows CREATE/DROP TABLE IF [NOT] EXISTS on OWN tables but denies foreign', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        const PFX = api.db.tablePrefix;
        for (const sql of [
            `CREATE TABLE IF NOT EXISTS ${PFX}gizmo (id INTEGER PRIMARY KEY, name TEXT)`,
            `DROP TABLE IF EXISTS ${PFX}gizmo`,
        ]) {
            let err: any = null;
            try { await api.db.run(sql); } catch (e) { err = e; }
            // May fail for a benign reason (test DB state), but NEVER with the scoping denial — that proves
            // the DDL cleared the prefix/ownership gate (the regression made it throw "not owned: table 'if'").
            assert.ok(!err || !/not owned|off-limits/i.test(String(err.message)), `own IF-NOT-EXISTS DDL must not trip the guard: ${err && err.message}`);
        }
        // A foreign table behind IF NOT EXISTS is still attributed and denied.
        await assert.rejects(() => api.db.run('CREATE TABLE IF NOT EXISTS users (id INTEGER)'), /not owned|off-limits/i);
    });
});

// 2026-07-17 audit CRITICAL: ownership was `tok.startsWith(prefix)`, so a plugin whose prefix is a
// startsWith-prefix of another's (wjp_event_ ⊂ wjp_event_tickets_orders) read the sibling's tables.
// Now the LONGEST claimed prefix wins.
test('bridge blocks reading a sibling plugin with a longer prefix', async () => {
    createPluginApi('test-api-plugin-child'); // claims wjp_test_api_plugin_child_
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG); // prefix wjp_test_api_plugin_
        await assert.rejects(() => api.db.all(`SELECT * FROM ${api.db.tablePrefix}child_orders`), /belongs to plugin/);
    });
});

// 2026-07-17 audit LOW: CREATE VIEW / TRIGGER object names were never prefix-scoped (namespace squat).
test('bridge scopes CREATE VIEW / DROP TRIGGER names to the plugin prefix', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        await assert.rejects(() => api.db.run(`CREATE VIEW wjp_victim_orders AS SELECT * FROM ${api.db.tablePrefix}x`), /view\/trigger name/);
        await assert.rejects(() => api.db.run('DROP TRIGGER wjp_victim_trg'), /view\/trigger name/);
    });
});

test('bridge confines fs to the plugin dir + uploads', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        await assert.rejects(() => api.fs.read('../../package.json'), /outside/);
        await assert.rejects(() => api.fs.write('manifest.json', 'x'), /immutable/);
    });
});

// 2026-07-17 audit CRITICAL: fs.promises bypassed io-guard's path containment — the proxy only checked
// the filesystem GRANT for out-of-dir paths and then ran on the RAW path (no isPathSafe). So a plugin
// with filesystem:read read data/*.db & .env, and filesystem:write overwrote host/other-plugin code.
test('fs.promises is path-confined like the callback fs (no raw DB/secret read, no host write)', async () => {
    const { createSecureFs } = require('../core/secure-require');
    const secureFs = createSecureFs();
    const rootDir = path.resolve(__dirname, '../../');
    const g: any = global; const prev = g.__WORDJS_ISOLATED__;
    g.__WORDJS_ISOLATED__ = true; // DB-file block is child-only
    try {
        await runWithContext(SLUG, async () => { // test plugin has filesystem:admin, so this exercises isPathSafe, not the grant
            const p = secureFs.promises;
            await assert.rejects(() => p.readFile(path.join(rootDir, 'data', 'wordjs.db')), /SECURITY BLOCK|denied|not permitted/i);
            await assert.rejects(() => p.readFile(path.join(rootDir, 'data', 'wordjs-native.db')), /SECURITY BLOCK|denied|not permitted/i);
            await assert.rejects(() => p.readFile(path.join(rootDir, '.env')), /SECURITY BLOCK|denied|not permitted/i);
            await assert.rejects(() => p.writeFile(path.join(rootDir, 'plugins', 'victim-x', 'index.js'), 'x'), /SECURITY BLOCK|denied|not permitted/i);
        });
    } finally { if (prev === undefined) delete g.__WORDJS_ISOLATED__; else g.__WORDJS_ISOLATED__ = prev; }
});

// Round-8 regression: the credentials SQLite DB sits under the data/ read zone, so a plugin holding
// (self-declared) filesystem:read could read+parse it directly, bypassing the bridge DB scoping. The
// io-guard global-fs backstop now blocks DB files (extension + sidecars) regardless of the zone.
test('io-guard blocks plugin reads of the database file under data/ (in the child)', async () => {
    const { isPathSafe } = require('../core/io-guard');
    const root = path.resolve(__dirname, '../../');
    const g: any = global; const prev = g.__WORDJS_ISOLATED__;
    g.__WORDJS_ISOLATED__ = true; // the DB-file block is child-only (the host driver needs DB access)
    try {
        await runWithContext(SLUG, async () => {
            assert.equal(isPathSafe(path.join(root, 'data', 'wordjs.db'), false), false);          // primary DB
            assert.equal(isPathSafe(path.join(root, 'data', 'wordjs-native.db'), false), false);   // native-driver DB
            assert.equal(isPathSafe(path.join(root, 'data', 'wordjs.db-wal'), false), false);      // WAL sidecar
            assert.equal(isPathSafe(path.join(root, 'data', 'x.sqlite3'), false), false);          // any sqlite file
            // The shared data root itself is no longer readable; plugins receive hashed private storage.
            assert.equal(isPathSafe(path.join(root, 'data', 'plugin-notes.txt'), false), false);
        });
    } finally { if (prev === undefined) delete g.__WORDJS_ISOLATED__; else g.__WORDJS_ISOLATED__ = prev; }
});

// No trust tier: io-guard confines plugin CODE (which runs in the isolated child) from reading the raw
// DB file — but on the HOST the bridge runs callApi in the plugin's context, and the host DB driver
// must still be allowed to open data/wordjs.db for the plugin's scoped queries. So the DB-file block is
// child-only; the host driver is allowed only for the configured DB literal, not data/ broadly.
test('io-guard: DB file blocked in the child, allowed for the host bridge driver', async () => {
    const { isPathSafe } = require('../core/io-guard');
    const root = path.resolve(__dirname, '../../');
    const dbFile = path.join(root, 'data', 'wordjs.db');
    const g: any = global; const prev = g.__WORDJS_ISOLATED__;
    try {
        await runWithContext('mail-server', async () => {
            delete g.__WORDJS_ISOLATED__;                                    // HOST (bridge driver context)
            assert.equal(isPathSafe(dbFile, false), true);                  // host DB driver → allowed
            g.__WORDJS_ISOLATED__ = true;                                   // isolated CHILD (plugin code)
            assert.equal(isPathSafe(dbFile, false), false);                 // plugin reading raw DB → blocked
            assert.equal(isPathSafe(path.join(root, '.env'), false), false); // secret file → blocked
        });
    } finally { if (prev === undefined) delete g.__WORDJS_ISOLATED__; else g.__WORDJS_ISOLATED__ = prev; }
});

// provideMail (becoming the host-wide mail sender) requires the explicit `email:provider` grant —
// there is no trusted bypass. The test plugin neither declares nor is granted it, so it's denied.
test('bridge provideMail requires the email:provider grant (no bypass)', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        assert.throws(() => api.provideMail(() => ({})), /permission|provider|denied|Security Block/i);
    });
});

// ── db.batch: a transport optimisation, NEVER a wider capability ──────────────────────────────
// It exists to collapse N IPC round-trips into one. These pin that it cannot be used to reach
// anything a loop of db.all/db.run could not, and that it refuses to half-apply an illegal batch.

test('db.batch applies the SAME table scoping as single statements', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        await assert.rejects(() => api.db.batch([['SELECT * FROM users']]), /off-limits|not owned/i);
        await assert.rejects(
            () => api.db.batch([["UPDATE user_meta SET meta_value='administrator'"]]),
            /off-limits|not owned/i
        );
    });
});

test('db.batch refuses DDL (ownership + grants must stay on the explicit path)', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        await assert.rejects(
            () => api.db.batch([[`CREATE TABLE wjp_${SLUG.replace(/[^a-z0-9]+/g, '_')}_x (id INTEGER)`]]),
            /does not accept DDL/i
        );
    });
});

test('db.batch validates EVERY statement before running ANY of them', async () => {
    // Asserting only that an illegal batch REJECTS proves nothing: per-statement validation during
    // execution would reject too — after the legal statements ahead of it had already applied. The
    // invariant is "nothing executed", so observe the execution seam itself: runScoped must not be
    // called at all. (This suite runs without an initialized database by design, so counting the
    // calls is also the only way to assert it here.)
    const iso = require('../core/plugin-db-isolation');
    const realRunScoped = iso.runScoped;
    const calls: string[] = [];
    iso.runScoped = async (_slug: string, _method: string, sql: string) => { calls.push(sql); return []; };
    try {
        await runWithContext(SLUG, async () => {
            const api = createPluginApi(SLUG);
            const own = `wjp_${SLUG.replace(/[^a-z0-9]+/g, '_')}_probe`;
            await assert.rejects(
                () => api.db.batch([
                    [`INSERT INTO ${own} (v) VALUES (?)`, ['a']],
                    ['DELETE FROM users'],
                ]),
                /off-limits|not owned/i
            );
            assert.deepStrictEqual(calls, [], 'no statement may execute when any statement in the batch is illegal');

            // Sanity: a fully legal batch DOES execute every statement, in order — otherwise the
            // assertion above could pass for the wrong reason (e.g. batch silently doing nothing).
            await api.db.batch([
                [`INSERT INTO ${own} (v) VALUES (?)`, ['a']],
                [`SELECT * FROM ${own}`],
            ]);
            assert.strictEqual(calls.length, 2, 'a legal batch must execute each statement once');
            assert.match(calls[0], /^INSERT/);
            assert.match(calls[1], /^SELECT/);
        });
    } finally {
        iso.runScoped = realRunScoped;
    }
});

test('db.batch rejects malformed input instead of guessing', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        await assert.rejects(() => api.db.batch([]), /non-empty array/i);
        await assert.rejects(() => api.db.batch('SELECT 1'), /non-empty array/i);
        await assert.rejects(() => api.db.batch([['SELECT 1', 'not-an-array']]), /params must be an array/i);
        await assert.rejects(() => api.db.batch([[123]]), /non-empty sql string/i);
        await assert.rejects(
            () => api.db.batch(Array.from({ length: 201 }, () => ['SELECT 1'])),
            /at most 200/i
        );
    });
});
