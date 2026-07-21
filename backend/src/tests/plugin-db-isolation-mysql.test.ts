/**
 * PER-PLUGIN DB USER ISOLATION (MySQL / MariaDB) — the DATABASE denies cross-plugin/core access.
 *
 * The MySQL counterpart to plugin-db-isolation.test.ts (Postgres). MySQL has no usable SET ROLE for this
 * (SET ROLE can't strip the admin user's DIRECT privileges), so each plugin gets its OWN low-privilege
 * LOGIN user, GRANTed only its wjp_<slug>_ tables; its DML/SELECT run on a pool authenticated AS that user
 * (driver.runAsUser). This test calls runAsUser DIRECTLY — no assertSqlAllowed — so a pass proves the
 * DATABASE itself returns "command denied" on another plugin's table or a core table, text-guard or not.
 *
 * Skips locally when no MySQL is reachable or the pool user lacks CREATE USER / GRANT OPTION; hard-fails in
 * CI (WORDJS_CI_DB=1), where the mysql:8 service runs as root, if MySQL is up but the contract breaks.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

function withTimeout<T>(p: Promise<T>, ms: number, label = 'op'): Promise<T> {
    let timer: any;
    const t = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); });
    return Promise.race([p.finally(() => clearTimeout(timer)), t]) as Promise<T>;
}
function skipOrFail(t: any, reason: string): void {
    if (process.env.WORDJS_CI_DB === '1') assert.fail(reason);
    return t.skip(reason);
}

const USER = 'wjp_isotest_a';           // plugin A's low-privilege DB user
const PW = crypto.randomBytes(16).toString('hex');
const OWN = 'wjp_isotest_a_data';       // plugin A's own table
const OTHER = 'wjp_isotest_b_secrets';  // plugin B's table (cross-plugin)
const CORE = 'iso_core_secrets';        // stands in for a core table (users/options)
const DENIED = /command denied|not allowed|access denied/i;

test('per-plugin DB user (MySQL): own tables allowed, cross-plugin + core DENIED by the database', async (t: any) => {
    let driver: any;
    try { driver = require('../drivers/mysql'); } catch (e: any) { return skipOrFail(t, `mysql2 driver not loadable: ${e && e.message}`); }
    // config.db's default port is 5432 (Postgres), so MySQL must be pointed EXPLICITLY. Coordinates come
    // from env with defaults matching the CI mysql:8 service (127.0.0.1:3306, root/password, db 'wordjs').
    driver.config = {
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT) || 3306,
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD ?? 'password',
        name: process.env.MYSQL_DB || 'wordjs',
    };
    try { await withTimeout(driver.connect(), 5000, 'mysql connect'); } catch (e: any) { return skipOrFail(t, `no reachable MySQL: ${e && e.message}`); }

    // Seed: two plugins' tables + a "core" table, each with a secret row (as the admin/root pool user).
    for (const tbl of [OWN, OTHER, CORE]) {
        await driver.exec(`DROP TABLE IF EXISTS "${tbl}"`);
        await driver.exec(`CREATE TABLE "${tbl}" (id INTEGER PRIMARY KEY AUTOINCREMENT, secret TEXT)`);
        await driver.run(`INSERT INTO "${tbl}" (secret) VALUES (?)`, [`secret-of-${tbl}`]);
    }
    try { await driver.dropPluginUser(USER); } catch { /* fresh */ }

    // Provision plugin A's user (needs CREATE USER + GRANT OPTION — skip if the pool user can't).
    try {
        await driver.ensurePluginUser(USER, PW);
        await driver.grantPluginPrefixToUser(USER, 'wjp_isotest_a_');
    } catch (e: any) {
        // Lacking CREATE USER / GRANT OPTION is a legitimate environment limitation — the feature degrades
        // to the text-guard by design — so SKIP (not fail) even in CI. CI's mysql runs as root, so no hit.
        await cleanup(driver);
        return t.skip(`user provisioning needs CREATE USER + GRANT OPTION (graceful fallback to text-guard): ${e && e.message}`);
    }

    try {
        // (1) Own table: SELECT + INSERT as the user SUCCEED.
        const own = await driver.runAsUser(USER, PW, 'all', `SELECT secret FROM "${OWN}"`, []);
        assert.strictEqual(own[0].secret, `secret-of-${OWN}`, 'user can read its own table');
        const ins = await driver.runAsUser(USER, PW, 'run', `INSERT INTO "${OWN}" (secret) VALUES (?)`, ['x']);
        assert.ok(ins.changes >= 1, 'user can write its own table');

        // (2) Another plugin's table: DENIED by MySQL (command denied), NOT an empty result.
        await assert.rejects(
            () => driver.runAsUser(USER, PW, 'all', `SELECT secret FROM "${OTHER}"`, []),
            DENIED,
            'the DATABASE must deny reading another plugin table — even bypassing the text-guard');

        // (3) A core table: same DB-level denial.
        await assert.rejects(
            () => driver.runAsUser(USER, PW, 'all', `SELECT secret FROM "${CORE}"`, []),
            DENIED,
            'the DATABASE must deny reading a core table under the plugin user');

        // (4) Cross-plugin WRITE is denied too.
        await assert.rejects(
            () => driver.runAsUser(USER, PW, 'run', `UPDATE "${OTHER}" SET secret='pwned'`, []),
            DENIED,
            'the DATABASE must deny writing another plugin table under the plugin user');
    } finally {
        try { await driver.dropPluginUser(USER); } catch { /* */ }
        await cleanup(driver);
    }
});

async function cleanup(driver: any) {
    for (const tbl of [OWN, OTHER, CORE]) { try { await driver.exec(`DROP TABLE IF EXISTS "${tbl}"`); } catch { /* */ } }
    try { await driver.close(); } catch { /* */ }
}
