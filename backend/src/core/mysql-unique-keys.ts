/**
 * The two uniqueness rules SQLite and Postgres hold with an EXPRESSION index and a PARTIAL index —
 *   users:  LOWER(user_email) is unique
 *   posts:  (post_name, post_type) is unique where post_name <> ''
 * — cannot be written that way on MySQL/MariaDB: MariaDB has no functional key parts and neither
 * engine has partial indexes. Both statements failed with a syntax error that was only logged, so a
 * MySQL site had no database-level guard at all, and concurrent sign-ups or posts created the same
 * email or slug several times.
 *
 * The portable MySQL form is a STORED generated column holding the key, with a plain UNIQUE index on
 * it (MySQL ≥ 5.7, MariaDB ≥ 10.2):
 *   users.user_email_key = LOWER(user_email)
 *   posts.post_slug_key  = post_type + '/' + post_name, NULL when post_name is '' (NULLs never collide)
 * Binary collation, so the rule is the exact one the other engines enforce (MySQL's default
 * `utf8mb4_unicode_ci` would also call 'josé' and 'jose' the same).
 *
 * Idempotent (probes information_schema first) and never throws: rows that already break a rule are
 * listed in the log and that one index is left out, exactly as migration 0001 does on the other engines.
 */
const log = require('./module-logger').moduleLogger('core/mysql-unique-keys');

type Ctx = {
    exec: (sql: string) => Promise<any>;
    get: (sql: string, params?: any[]) => Promise<any>;
    all: (sql: string, params?: any[]) => Promise<any>;
};

const KEYS = [
    {
        table: 'users',
        column: 'user_email_key',
        index: 'uq_users_email',
        columnDdl: 'ADD COLUMN user_email_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin GENERATED ALWAYS AS (LEFT(LOWER(user_email), 255)) STORED',
        dupSql: 'SELECT LOWER(user_email) AS k, COUNT(*) AS c FROM users GROUP BY LOWER(user_email) HAVING COUNT(*) > 1',
    },
    {
        table: 'posts',
        column: 'post_slug_key',
        index: 'uq_posts_slug',
        columnDdl: "ADD COLUMN post_slug_key VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin GENERATED ALWAYS AS (IF(post_name IS NULL OR post_name = '', NULL, LEFT(CONCAT(post_type, '/', post_name), 512))) STORED",
        dupSql: "SELECT post_name AS k, post_type AS t, COUNT(*) AS c FROM posts WHERE post_name <> '' GROUP BY post_name, post_type HAVING COUNT(*) > 1",
    },
];

async function ensureMysqlUniqueKeys(ctx: Ctx): Promise<{ created: string[]; skipped: string[] }> {
    const created: string[] = [];
    const skipped: string[] = [];
    for (const k of KEYS) {
        try {
            const col = await ctx.get(
                'SELECT 1 AS ok FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1',
                [k.table, k.column]
            );
            if (!col) await ctx.exec(`ALTER TABLE ${k.table} ${k.columnDdl}`);
            const idx = await ctx.get(
                'SELECT 1 AS ok FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1',
                [k.table, k.index]
            );
            if (idx) continue;
            const dups = (await ctx.all(k.dupSql)) || [];
            if (dups.length) {
                log.warn({ table: k.table, groups: dups.length }, `⚠️  ${dups.length} duplicate group(s) in ${k.table}: the unique index ${k.index} is not created until they are resolved`);
                for (const d of dups.slice(0, 20)) log.warn(`      - "${d.t !== undefined ? `${d.k} / ${d.t}` : d.k}" appears ${d.c} times`);
                skipped.push(k.index);
                continue;
            }
            await ctx.exec(`ALTER TABLE ${k.table} ADD UNIQUE INDEX ${k.index} (${k.column})`);
            created.push(k.index);
        } catch (e: any) {
            log.warn({ err: e, index: k.index }, `⚠️  could NOT create the unique index ${k.index} (continuing; that rule is enforced by the application only)`);
            skipped.push(k.index);
        }
    }
    return { created, skipped };
}

module.exports = { ensureMysqlUniqueKeys, MYSQL_UNIQUE_KEYS: KEYS };
