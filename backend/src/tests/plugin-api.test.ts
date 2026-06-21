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
        await assert.rejects(() => api.db.all('SELECT * FROM plugin_t, users'), /off-limits|comma join/i);   // comma join (blocked as a comma join; core table never attaches)
        await assert.rejects(() => api.db.all('SELECT * FROM/**/users'), /off-limits/);            // comment-as-whitespace
        await assert.rejects(() => api.db.all("SELECT option_value FROM options WHERE option_name='jwt_secret'"), /off-limits/); // secret exfil via options table
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

test('bridge confines fs to the plugin dir + uploads', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        await assert.rejects(() => api.fs.read('../../package.json'), /outside/);
        await assert.rejects(() => api.fs.write('manifest.json', 'x'), /immutable/);
    });
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
            // but a non-DB file under data/ stays readable — we blocked the DB, not the whole zone
            assert.equal(isPathSafe(path.join(root, 'data', 'plugin-notes.txt'), false), true);
        });
    } finally { if (prev === undefined) delete g.__WORDJS_ISOLATED__; else g.__WORDJS_ISOLATED__ = prev; }
});

// No trust tier: io-guard confines plugin CODE (which runs in the isolated child) from reading the raw
// DB file — but on the HOST the bridge runs callApi in the plugin's context, and the host DB driver
// must still be allowed to open data/wordjs.db for the plugin's scoped queries. So the DB-file block is
// child-only; the host driver is allowed (data/ safe zone). Regression for the activation EACCES bug.
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
