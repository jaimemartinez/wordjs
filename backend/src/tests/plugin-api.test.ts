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
        await assert.rejects(() => api.db.all('SELECT * FROM plugin_t, users'), /off-limits/);   // comma join
        await assert.rejects(() => api.db.all('SELECT * FROM/**/users'), /off-limits/);            // comment-as-whitespace
        await assert.rejects(() => api.db.all("SELECT option_value FROM options WHERE option_name='jwt_secret'"), /off-limits/); // secret exfil via options table
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
test('io-guard blocks plugin reads of the database file under data/', async () => {
    const { isPathSafe } = require('../core/io-guard');
    const root = path.resolve(__dirname, '../../');
    await runWithContext(SLUG, async () => {
        assert.equal(isPathSafe(path.join(root, 'data', 'wordjs.db'), false), false);          // primary DB
        assert.equal(isPathSafe(path.join(root, 'data', 'wordjs-native.db'), false), false);   // native-driver DB
        assert.equal(isPathSafe(path.join(root, 'data', 'wordjs.db-wal'), false), false);      // WAL sidecar
        assert.equal(isPathSafe(path.join(root, 'data', 'x.sqlite3'), false), false);          // any sqlite file
        // but a non-DB file under data/ stays readable — we blocked the DB, not the whole zone
        assert.equal(isPathSafe(path.join(root, 'data', 'plugin-notes.txt'), false), true);
    });
});

// Regression: operator-trusted plugins are full-Node by design, so io-guard must EXEMPT them from the
// DB-file/secret blocks (otherwise trusted first-party plugins like mail-server can't open the DB and
// fail to activate). Untrusted plugins (above) stay confined.
test('io-guard exempts operator-trusted plugins (DB + secret files allowed)', async () => {
    const { isPathSafe } = require('../core/io-guard');
    const { isTrusted } = require('../core/plugin-trust');
    const root = path.resolve(__dirname, '../../');
    assert.ok(isTrusted('mail-server'), 'mail-server is shipped-trusted in config.trustedSystemPlugins');
    await runWithContext('mail-server', async () => {
        assert.equal(isPathSafe(path.join(root, 'data', 'wordjs.db'), false), true); // trusted → DB allowed
        assert.equal(isPathSafe(path.join(root, '.env'), false), true);              // trusted → not confined
    });
});

// Round-8 regression: becoming the host-wide mail sender must require operator trust. An untrusted
// plugin could reach wordjs.provideMail directly via a kind:'call' bridge message, bypassing the
// trust gate on the register-mail-provider IPC handler — provideMail now re-checks trust itself.
test('bridge provideMail is denied for untrusted plugins (trust gate at the method)', async () => {
    await runWithContext(SLUG, async () => {
        const api = createPluginApi(SLUG);
        assert.throws(() => api.provideMail(() => ({})), /operator-trusted/);
    });
});
