/**
 * Shared test fixture: a minimal `wordjs.db` bridge for the mail-server plugin, backed by an
 * in-memory better-sqlite3 database.
 *
 * Used by every suite that needs the REAL plugin store (marketplace/plugins/mail-server/lib/
 * email-store.js) — the store regression suite and the corporate-mailbox route-gate suite. It lives
 * here rather than being copy-pasted per suite so the GUARD TRIPWIRE below has exactly one
 * definition: a second copy would inevitably drift from the host's real rules and start passing SQL
 * that the sandbox denies at runtime.
 */
import assert from 'node:assert';

const Database = require('better-sqlite3');

export const PREFIX = 'wjp_mail_server_';

/**
 * Structural subset of the host's `assertSqlAllowed` text guard (backend/src/core/plugin-api.ts).
 * Every SQL string the plugin store emits is checked here, so a query that would be REJECTED by the
 * sandbox at runtime fails in CI instead — this class of bug once broke 14 plugins at once (the
 * `CREATE TABLE IF NOT EXISTS` tokenizer incident) and once left mail-server with zero indexes.
 */
export function assertGuardSafe(sql: string) {
    const raw = String(sql || '');
    assert.ok(raw.length <= 20000, `SQL too long for the plugin guard (${raw.length} chars)`);
    assert.ok(!raw.includes('/*!'), `MySQL executable comment in plugin SQL: ${raw}`);
    assert.ok(!raw.includes('\\'), `Backslash in plugin SQL (guard denies): ${raw}`);
    assert.ok(!raw.includes('$'), `'$' in plugin SQL (guard denies dollar-quoting): ${raw}`);
    assert.ok(!raw.includes('[') && !raw.includes(']'), `Square bracket in plugin SQL (guard denies): ${raw}`);
    const lower = raw.toLowerCase();
    assert.ok(!/\breturning\b/.test(lower), `RETURNING in plugin SQL (guard denies): ${raw}`);
    assert.ok(!lower.replace(/;\s*$/, '').includes(';'), `Multiple statements in plugin SQL: ${raw}`);
    // Every table reference must be under the plugin's own prefix. This walker is a simplification
    // of the host's lexer, but our SQL contains no string literals (data goes via bound params),
    // so keyword-anchored capture is accurate here.
    const re = /\b(?:from|join|into|update)\s+([a-z_][a-z0-9_]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
        const tok = m[1];
        // `DELETE FROM x` / `SELECT ... FROM (subquery) alias` — '(' isn't captured by the regex, so
        // every captured token IS a table name and must carry the prefix.
        assert.ok(tok.startsWith(PREFIX), `Table '${tok}' outside plugin prefix in SQL: ${raw}`);
    }
    // CREATE TABLE/INDEX & ALTER TABLE target checks.
    const ddl = lower.match(/^\s*(?:create\s+table(?:\s+if\s+not\s+exists)?|alter\s+table)\s+([a-z_][a-z0-9_]*)/);
    if (ddl) assert.ok(ddl[1].startsWith(PREFIX), `DDL target '${ddl[1]}' outside plugin prefix: ${raw}`);
    const idx = lower.match(/^\s*create\s+index(?:\s+if\s+not\s+exists)?\s+([a-z0-9_]+)\s+on\s+([a-z_][a-z0-9_]*)/);
    if (idx) {
        // The host guard requires BOTH the index NAME and its target table to carry the plugin prefix.
        // The name check is the one that silently ate every mail-server index (named idx_wjp_… not
        // wjp_…) before it was caught on a live DB — enforce it here so a regression fails in CI.
        assert.ok(idx[1].startsWith(PREFIX), `Index NAME '${idx[1]}' must start with '${PREFIX}': ${raw}`);
        assert.ok(idx[2].startsWith(PREFIX), `Index target '${idx[2]}' outside plugin prefix: ${raw}`);
    }
}

/** The `wordjs.db` shape the plugin store is constructed with, over a fresh in-memory database. */
export function makeDb() {
    const raw = new Database(':memory:');
    const prep = (sql: string) => raw.prepare(sql);
    const db = {
        tablePrefix: PREFIX,
        async createTable(name: string, cols: string[]) {
            assert.ok(name.startsWith(PREFIX), `createTable outside prefix: ${name}`);
            const translated = cols.map(c => c.replace(/\bINT_PK\b/, 'INTEGER PRIMARY KEY AUTOINCREMENT'));
            raw.exec(`CREATE TABLE IF NOT EXISTS ${name} (${translated.join(', ')})`);
        },
        async run(sql: string, params: any[] = []) {
            assertGuardSafe(sql);
            const info = prep(sql).run(...params);
            return { lastID: Number(info.lastInsertRowid), changes: info.changes };
        },
        async get(sql: string, params: any[] = []) {
            assertGuardSafe(sql);
            return prep(sql).get(...params);
        },
        async all(sql: string, params: any[] = []) {
            assertGuardSafe(sql);
            return prep(sql).all(...params);
        },
        _raw: raw
    };
    return db;
}
