/**
 * THE DIAGNOSTIC SCRIPTS IN backend/cli RUN AGAINST THE CURRENT DATABASE API.
 *
 * inspect-roles, inspect-user, verify-roles and force-sync-roles called an `initSqlJsDb()` that
 * config/database stopped exporting long ago, so each one died with "initSqlJsDb is not a function";
 * force-sync-roles also wrote `config.roles` (an empty placeholder) over the stored role map instead of
 * the real defaults (core/roles DEFAULT_ROLES). check_plugins looked for a `database.path` key in a
 * config two directories up instead of backend/wordjs-config.json's `dbPath`. This loads each script
 * (no side effect at import) and runs its main() against a throwaway database built with the backend's
 * own schema initialization.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.resolve(__dirname, '..', '..', 'cli');
const ORIGINAL_CWD = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-cli-${process.pid}-`));
fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
process.chdir(TMP);

const config = require('../config/app');
config.dbDriver = 'sqlite-native';
config.dbPath = path.join(TMP, 'data', 'wordjs-native.db');
const database = require('../config/database');

/** Run `fn` and return what it printed with console.log / console.error. */
async function capture(fn: () => Promise<any>): Promise<{ result: any; out: string }> {
    const lines: string[] = [];
    const { log, error } = console;
    console.log = (...a: any[]) => { lines.push(a.join(' ')); };
    console.error = (...a: any[]) => { lines.push(a.join(' ')); };
    try {
        const result = await fn();
        return { result, out: lines.join('\n') };
    } finally {
        console.log = log;
        console.error = error;
    }
}

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    await require('../core/options').initDefaultOptions(config);
    await require('../core/roles').loadRoles();
    const db = database.getDbAsync();
    const r = await db.run(`INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('alice', 'not-a-real-hash', 'alice@example.com', 'Alice')`);
    await db.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'editor')`, [r.lastID]);
    // The damage force-sync-roles exists to repair, plus a custom role it must keep.
    await db.run(`UPDATE options SET option_value = ? WHERE option_name = 'wordjs_user_roles'`, [JSON.stringify({
        subscriber: { name: 'Subscriber', capabilities: ['read'] },
        custom_role: { name: 'Custom', capabilities: ['read'] },
    })]);
    await database.closeDatabase();
});

after(async () => {
    try { await database.closeDatabase(); } catch { /* already closed */ }
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* files still open on Windows */ }
});

test('every diagnostic script loads without running and exports main()', () => {
    for (const name of ['inspect-roles', 'inspect-user', 'verify-roles', 'force-sync-roles', 'check_plugins']) {
        const mod = require(path.join(CLI, `${name}.js`));
        assert.strictEqual(typeof mod.main, 'function', `${name} exports main()`);
    }
});

test('inspect-roles, verify-roles and inspect-user read the database the backend opens', async () => {
    const roles = await capture(() => require(path.join(CLI, 'inspect-roles.js')).main([]));
    assert.strictEqual(roles.result, 0);
    assert.match(roles.out, /ROLES_DB: \{"subscriber"/);

    const verify = await capture(() => require(path.join(CLI, 'verify-roles.js')).main(['subscriber']));
    assert.strictEqual(verify.result, 0);
    assert.match(verify.out, /SUBSCRIBER_CAPS: \["read"\]/);

    const user = await capture(() => require(path.join(CLI, 'inspect-user.js')).main(['alice']));
    assert.strictEqual(user.result, 0);
    assert.match(user.out, /"role": "editor"/);
    assert.ok(!/user_pass|not-a-real-hash/.test(user.out), 'the password hash is never printed');

    const missing = await capture(() => require(path.join(CLI, 'inspect-user.js')).main(['nobody']));
    assert.strictEqual(missing.result, 1);
});

test('force-sync-roles resets the built-in roles to DEFAULT_ROLES and keeps the others', async () => {
    const { defaultRoles } = require('../core/roles');
    const sync = await capture(() => require(path.join(CLI, 'force-sync-roles.js')).main([]));
    assert.strictEqual(sync.result, 0, sync.out);
    const { withDatabase, readStoredRoles } = require(path.join(CLI, 'lib', 'diagnostic-db.js'));
    const stored = await withDatabase(readStoredRoles);
    const defaults = defaultRoles();
    for (const slug of Object.keys(defaults)) assert.deepStrictEqual(stored[slug], defaults[slug], slug);
    assert.ok(stored.subscriber.capabilities.includes('access_admin_panel'));
    assert.deepStrictEqual(stored.custom_role, { name: 'Custom', capabilities: ['read'] });
});

test('check_plugins reads dbPath from backend/wordjs-config.json, else the driver default', () => {
    const { candidateDatabases } = require(path.join(CLI, 'check_plugins.js'));
    const file = config.dbPath; // exists: created by before()
    assert.deepStrictEqual(candidateDatabases({ dbPath: file }).slice(0, 1), [file]);
    // A configured path that does not exist is skipped, never reported.
    assert.ok(!candidateDatabases({ dbPath: path.join(TMP, 'nope.db') }).includes(path.join(TMP, 'nope.db')));
});
