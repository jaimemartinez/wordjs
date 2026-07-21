/**
 * PER-PLUGIN DB ROLE ISOLATION (Postgres) — the DATABASE denies cross-plugin/core reads.
 *
 * This is the ADVERSARIAL proof for the definitive isolation control from the 2026-07-20 audit: a plugin's
 * queries run under its own NOLOGIN role (SET ROLE on a pinned client), GRANTed only its own wjp_<slug>_
 * tables — so even when a query BYPASSES the SQL text-guard (here we call driver.runAsRole DIRECTLY, without
 * assertSqlAllowed), Postgres itself returns "permission denied" on another plugin's table or a core table.
 *
 * Postgres-only (SQLite has no roles; MySQL isolation is a follow-up). Skips locally when no PG is reachable
 * or the pool user lacks CREATEROLE; hard-fails in CI (WORDJS_CI_DB=1) if PG is up but the contract breaks.
 */
const { test } = require('node:test');
const assert = require('node:assert');

function withTimeout<T>(p: Promise<T>, ms: number, label = 'op'): Promise<T> {
    let timer: any;
    const t = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); });
    return Promise.race([p.finally(() => clearTimeout(timer)), t]) as Promise<T>;
}
function skipOrFail(t: any, reason: string): void {
    if (process.env.WORDJS_CI_DB === '1') assert.fail(reason);
    return t.skip(reason);
}

const ROLE = 'wjp_role_isotest_a';
const OWN = 'wjp_isotest_a_data';       // plugin A's own table
const OTHER = 'wjp_isotest_b_secrets';  // plugin B's table (cross-plugin)
const CORE = 'iso_core_secrets';        // stands in for a core table (users/options)

test('per-plugin DB role: own tables allowed, cross-plugin + core DENIED by the database', async (t: any) => {
    let driver: any;
    try { driver = require('../drivers/postgres'); } catch (e: any) { return skipOrFail(t, `pg driver not loadable: ${e && e.message}`); }
    try { await withTimeout(driver.connect(), 3000, 'pg connect'); } catch (e: any) { return skipOrFail(t, `no reachable Postgres: ${e && e.message}`); }

    // Seed: two plugins' tables + a "core" table, each with a secret row (as the admin pool user).
    for (const tbl of [OWN, OTHER, CORE]) {
        await driver.exec(`DROP TABLE IF EXISTS "${tbl}"`);
        await driver.exec(`CREATE TABLE "${tbl}" (id SERIAL PRIMARY KEY, secret TEXT)`);
        await driver.run(`INSERT INTO "${tbl}" (secret) VALUES (?)`, [`secret-of-${tbl}`]);
    }
    try { await driver.dropPluginRole(ROLE); } catch { /* fresh */ }

    // Provision plugin A's role (needs CREATEROLE — skip if the pool user can't).
    try {
        await driver.ensurePluginRole(ROLE);
        await driver.grantPluginPrefix(ROLE, 'wjp_isotest_a_');
    } catch (e: any) {
        // Lacking CREATEROLE is a legitimate environment limitation — the feature degrades to the text-guard
        // by design — so SKIP (not fail) even in CI. CI's postgres runs as the superuser, so this won't hit.
        await cleanup(driver);
        return t.skip(`role provisioning needs CREATEROLE (graceful fallback to text-guard): ${e && e.message}`);
    }

    try {
        // (1) Own table: SELECT + INSERT under the role SUCCEED.
        const own = await driver.runAsRole(ROLE, 'all', `SELECT secret FROM "${OWN}"`, []);
        assert.strictEqual(own[0].secret, `secret-of-${OWN}`, 'role can read its own table');
        const ins = await driver.runAsRole(ROLE, 'run', `INSERT INTO "${OWN}" (secret) VALUES (?)`, ['x']);
        assert.ok(ins.changes >= 1, 'role can write its own table');

        // (2) Another plugin's table: DENIED by Postgres (permission denied), NOT an empty result.
        await assert.rejects(
            () => driver.runAsRole(ROLE, 'all', `SELECT secret FROM "${OTHER}"`, []),
            /permission denied|not allowed|denied for/i,
            'the DATABASE must deny reading another plugin table — even bypassing the text-guard');

        // (3) A core table: same DB-level denial.
        await assert.rejects(
            () => driver.runAsRole(ROLE, 'all', `SELECT secret FROM "${CORE}"`, []),
            /permission denied|not allowed|denied for/i,
            'the DATABASE must deny reading a core table under the plugin role');

        // (4) Cross-plugin WRITE is denied too.
        await assert.rejects(
            () => driver.runAsRole(ROLE, 'run', `UPDATE "${OTHER}" SET secret='pwned'`, []),
            /permission denied|not allowed|denied for/i,
            'the DATABASE must deny writing another plugin table under the plugin role');
    } finally {
        try { await driver.dropPluginRole(ROLE); } catch { /* */ }
        await cleanup(driver);
    }
});

async function cleanup(driver: any) {
    for (const tbl of [OWN, OTHER, CORE]) { try { await driver.exec(`DROP TABLE IF EXISTS "${tbl}"`); } catch { /* */ } }
}
