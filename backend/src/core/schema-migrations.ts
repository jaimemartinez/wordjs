/**
 * WordJS — Schema migration runner (versioned, cross-driver).
 *
 * The base schema is created idempotently by `initializeSchema` (CREATE TABLE/INDEX IF NOT EXISTS).
 * That cannot EVOLVE a live schema (add/alter columns, backfill data) without dropping data. This
 * runner layers ordered, recorded migrations on top: each runs once, in order, and is recorded in a
 * `schema_migrations` table, so upgrades to an existing install apply only the pending changes.
 *
 * Works across all drivers (sqlite-native / sqlite-legacy / postgres): migrations receive a ctx with
 * `exec/run/get/all` (the driver methods — `?` placeholders are normalized by the Postgres driver) and
 * an `isPostgres` flag for the few dialect-specific cases. A failing migration aborts boot (we never
 * run on a half-migrated schema).
 *
 * To add a migration: append `{ id, up }` to MIGRATIONS below. `id` must be unique and stable (it is
 * the recorded key); prefix with a zero-padded ordinal, e.g. '0001_add_posts_author_index'.
 */

type MigrationCtx = {
    exec: (sql: string) => Promise<any>;
    run: (sql: string, params?: any[]) => Promise<any>;
    get: (sql: string, params?: any[]) => Promise<any>;
    all: (sql: string, params?: any[]) => Promise<any>;
    isPostgres: boolean;
};

type Migration = { id: string; up: (ctx: MigrationCtx) => Promise<void> };

// Ordered list of schema migrations. Empty = base schema only (the framework is wired and will apply
// the first real migration the moment one is added here). KEEP IN ORDER; never edit an applied id.
const MIGRATIONS: Migration[] = [
    {
        // Add UNIQUE constraints that were missing (TOCTOU: concurrent check-then-insert could create
        // duplicate logins/emails/slugs). Fresh installs get these in initializeSchema; this brings
        // EXISTING databases up to the same shape.
        //
        // DEFENSIVE: existing data may already contain duplicates, which would make CREATE UNIQUE
        // INDEX fail. We (1) detect & LOG duplicates first, then (2) attempt each index in its own
        // try/catch. A failure here must NEVER abort boot — so this migration NEVER throws; it logs a
        // clear warning and continues, and is recorded as applied so it doesn't retry every boot.
        // (If duplicates are cleaned up later, the index can be created via a follow-up migration.)
        id: '0001_unique_constraints_users_posts',
        up: async (ctx: MigrationCtx) => {
            // Each entry: a human label, a query that returns the duplicate groups (so we can log
            // them), and the CREATE UNIQUE INDEX to attempt. Queries use ? placeholders only where
            // needed; the Postgres driver normalizes them. LOWER() and partial-index WHERE clauses
            // are valid on both SQLite (≥3.9) and Postgres.
            const checks = [
                {
                    label: 'users.user_login',
                    dupSql: 'SELECT user_login AS k, COUNT(*) AS c FROM users GROUP BY user_login HAVING COUNT(*) > 1',
                    indexSql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login ON users (user_login)'
                },
                {
                    // Case-insensitive email uniqueness. The authoritative fold is app-layer
                    // (User.normalizeEmail: full-Unicode lowercase + NFC, applied on store/lookup);
                    // this LOWER()-expression index is the DB backstop. SQLite LOWER() is ASCII-only,
                    // so non-ASCII confusables ('Ä@x'/'ä@x') are caught by the app-layer fold, not here.
                    label: 'users.user_email (case-insensitive)',
                    dupSql: 'SELECT LOWER(user_email) AS k, COUNT(*) AS c FROM users GROUP BY LOWER(user_email) HAVING COUNT(*) > 1',
                    indexSql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(user_email))'
                },
                {
                    label: 'posts(post_name, post_type) [non-empty slugs]',
                    dupSql: "SELECT post_name AS k, post_type AS t, COUNT(*) AS c FROM posts WHERE post_name <> '' GROUP BY post_name, post_type HAVING COUNT(*) > 1",
                    indexSql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_name_type ON posts (post_name, post_type) WHERE post_name <> ''"
                }
            ];

            for (const chk of checks) {
                // 1. Detect & log duplicates (best-effort — never fatal).
                try {
                    const dups = (await ctx.all(chk.dupSql)) || [];
                    if (dups.length > 0) {
                        console.warn(`⚠️  [migration 0001] ${dups.length} duplicate group(s) found for ${chk.label}; the unique index may not be created until these are resolved:`);
                        for (const d of dups.slice(0, 20)) {
                            const key = d.t !== undefined ? `${d.k} / ${d.t}` : d.k;
                            console.warn(`      - "${key}" appears ${d.c} times`);
                        }
                        if (dups.length > 20) console.warn(`      ...and ${dups.length - 20} more`);
                    }
                } catch (e: any) {
                    console.warn(`⚠️  [migration 0001] duplicate scan for ${chk.label} skipped: ${e && e.message}`);
                }

                // 2. Attempt the unique index. Failure (e.g. residual duplicates) is logged, not fatal.
                try {
                    await ctx.exec(chk.indexSql);
                    console.log(`   ✓ [migration 0001] unique index ensured for ${chk.label}`);
                } catch (e: any) {
                    console.warn(`⚠️  [migration 0001] could NOT create unique index for ${chk.label} (continuing, data integrity not enforced for this column): ${e && e.message}`);
                }
            }
            // Intentionally no throw: recorded-as-applied even if some indexes were skipped.
        }
    },
    {
        // Scoped, revocable API tokens for headless/machine clients (roadmap: open the platform).
        // A token authenticates AS a user via `Authorization: Bearer wjt_...` (the CSRF-exempt Bearer
        // path) and is bounded by BOTH the user's role capabilities AND the token's read/write scope.
        // We store only a sha256 of the token — the plaintext is shown once at creation and never again.
        // Timestamps that drive logic (expiry, last-used) are epoch SECONDS (INTEGER) to sidestep the
        // SQLite CURRENT_TIMESTAMP-is-UTC-text-vs-JS-local-parse ambiguity; created_at is display-only.
        id: '0002_create_api_tokens',
        up: async (ctx: MigrationCtx) => {
            const INT_PK = ctx.isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
            const TS = ctx.isPostgres ? 'TIMESTAMP' : 'DATETIME';
            await ctx.exec(
                `CREATE TABLE IF NOT EXISTS api_tokens (` +
                `id ${INT_PK}, ` +
                `user_id INTEGER NOT NULL, ` +
                `name TEXT NOT NULL DEFAULT '', ` +
                `token_hash TEXT NOT NULL, ` +
                `token_prefix TEXT NOT NULL DEFAULT '', ` +
                `scopes TEXT NOT NULL DEFAULT 'read', ` +
                `last_used_at INTEGER, ` +
                `expires_at INTEGER, ` +
                `revoked INTEGER NOT NULL DEFAULT 0, ` +
                `created_at ${TS} DEFAULT CURRENT_TIMESTAMP)`
            );
            // The hash is the lookup key on every authenticated API request — unique + indexed.
            await ctx.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens (token_hash)');
            await ctx.exec('CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens (user_id)');
        }
    },
    {
        // Outgoing webhook SUBSCRIPTIONS (roadmap: open the platform — the other half of headless).
        // Each row is an endpoint the operator registers; when a content event fires, a signed POST is
        // delivered to `url`. The HMAC signing secret is stored ENCRYPTED (secret_enc, AES-256-GCM keyed
        // off the app secret) because — unlike an API token — it must be re-read as plaintext to sign
        // every delivery, so a one-way hash won't do. `events` is a comma list of subscribed event names
        // or '*'. `failure_count` auto-pauses a chronically-failing endpoint.
        id: '0003_create_webhooks',
        up: async (ctx: MigrationCtx) => {
            const INT_PK = ctx.isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
            const TS = ctx.isPostgres ? 'TIMESTAMP' : 'DATETIME';
            await ctx.exec(
                `CREATE TABLE IF NOT EXISTS webhooks (` +
                `id ${INT_PK}, ` +
                `user_id INTEGER NOT NULL, ` +
                `name TEXT NOT NULL DEFAULT '', ` +
                `url TEXT NOT NULL, ` +
                `events TEXT NOT NULL DEFAULT '*', ` +
                `secret_enc TEXT NOT NULL, ` +
                `secret_prefix TEXT NOT NULL DEFAULT '', ` +
                `active INTEGER NOT NULL DEFAULT 1, ` +
                `failure_count INTEGER NOT NULL DEFAULT 0, ` +
                `last_delivery_at INTEGER, ` +
                `created_at ${TS} DEFAULT CURRENT_TIMESTAMP)`
            );
            await ctx.exec('CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks (active)');
            await ctx.exec('CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks (user_id)');
        }
    },
    {
        // Outgoing webhook DELIVERY queue + audit log. This table IS the durable retry queue (survives a
        // restart): one row per (webhook, event) delivery attempt-set. A single-statement atomic CLAIM
        // (see WebhookDelivery.claim) makes dispatch safe across nodes WITHOUT a distributed lock — the
        // claiming UPDATE moves next_attempt_at into the future so a racing node's guarded UPDATE matches
        // 0 rows. next_attempt_at/delivered_at are epoch SECONDS (INTEGER) so backoff math never hits the
        // SQLite UTC-text-vs-JS-local ambiguity.
        id: '0004_create_webhook_deliveries',
        up: async (ctx: MigrationCtx) => {
            const INT_PK = ctx.isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
            const TS = ctx.isPostgres ? 'TIMESTAMP' : 'DATETIME';
            await ctx.exec(
                `CREATE TABLE IF NOT EXISTS webhook_deliveries (` +
                `id ${INT_PK}, ` +
                `webhook_id INTEGER NOT NULL, ` +
                `event TEXT NOT NULL, ` +
                `payload TEXT NOT NULL, ` +
                `status TEXT NOT NULL DEFAULT 'pending', ` +
                `attempts INTEGER NOT NULL DEFAULT 0, ` +
                `next_attempt_at INTEGER NOT NULL DEFAULT 0, ` +
                `response_status INTEGER, ` +
                `error TEXT, ` +
                `delivered_at INTEGER, ` +
                `created_at ${TS} DEFAULT CURRENT_TIMESTAMP)`
            );
            // The dispatcher scans by (status, next_attempt_at); the admin log lists by webhook.
            await ctx.exec('CREATE INDEX IF NOT EXISTS idx_wh_deliveries_due ON webhook_deliveries (status, next_attempt_at)');
            await ctx.exec('CREATE INDEX IF NOT EXISTS idx_wh_deliveries_webhook ON webhook_deliveries (webhook_id, id)');
        }
    },
    {
        // The webhook signing secret is now stored in PLAINTEXT (see models/Webhook.ts + core/crypto-utils.ts):
        // encrypting it with a key derived from a rotatable app secret (jwt.secret) silently dead-lettered
        // EVERY delivery whenever that secret changed (rotation / a boot-time config regeneration), across
        // all deploy modes. Rename the column from the misleading `secret_enc` to `secret`. Tolerant: on a
        // DB that already has `secret` (or where RENAME is unsupported) it is a non-fatal no-op. Any secret
        // value that was previously AES-encrypted is now treated as the literal secret — operators must
        // rotate those endpoints' secrets (the feature is unreleased, so no production endpoints exist).
        id: '0005_webhook_secret_plaintext',
        up: async (ctx: MigrationCtx) => {
            try {
                await ctx.exec('ALTER TABLE webhooks RENAME COLUMN secret_enc TO secret');
            } catch (e: any) {
                console.warn(`   [migration 0005] webhooks.secret_enc→secret rename skipped (non-fatal): ${e && e.message}`);
            }
        }
    },
    {
        // ACTIVE CORPORATE MAILBOX becomes an EXPLICIT, ADMIN-OWNED grant (user_meta.professional_mailbox)
        // instead of being derived from the account's own email domain. See core/mailbox.ts for why the
        // derivation was not an authorization fact (PUT /users/me and POST /auth/register both write
        // user_email, so the grant was self-issuable, anonymously in the registration case).
        //
        // THE UPGRADE TRADE-OFF, stated plainly. On an existing install every account whose email is on
        // the mail domain has a working mailbox today, and we cannot tell from the data whether that
        // address was PROVISIONED BY AN ADMIN or SELF-ASSIGNED through the hole. Two bad options:
        //   (a) grant to everyone on-domain — preserves every working mailbox, but also PERSISTS the
        //       grant for anyone who exploited the hole, converting a live bug into stored permission;
        //   (b) grant to nobody — closes it completely, and revokes every legitimate employee mailbox.
        // We take the SAFE MIDDLE: grant only to accounts for which the hole conferred nothing, i.e.
        // accounts that could already set the flag themselves — administrators and holders of
        // `edit_users`. Every OTHER on-domain account is left DISABLED and reported.
        //
        // CONSEQUENCE FOR A LEGITIMATE USER (deliberate, not a bug): an editor at alice@acme.com loses
        // webmail access at upgrade and must be re-enabled by an admin in Users → edit user →
        // Professional Mail Account. Until then her inbound mail is NOT lost, but it is NOT hers either:
        // it falls to the catch-all admin inbox when catch-all is enabled, and is rejected at SMTP
        // (a normal 5xx to the sender, so nothing disappears silently) when it is not. The migration
        // therefore names every affected account in the boot log AND stores the list in the
        // `professional_mailbox_migration_pending` option, so the operator has the exact worklist.
        //
        // NEVER THROWS: the un-granted state is the DENY direction, so a partial run is safe; aborting
        // boot over a data derivation would be worse. Recorded as applied either way (like 0001).
        id: '0006_professional_mailbox_flag',
        up: async (ctx: MigrationCtx) => {
            const { domainOfAddress } = require('./mailbox');
            const MAILBOX_META_KEY = 'professional_mailbox';
            try {
                // 1. The mail domain, read straight from the options table (the option store's own
                //    accessor is not guaranteed to be wired this early in boot). SAME precedence as
                //    core/mailbox.getMailDomain: the DKIM domain override wins over the site hostname.
                const optionOf = async (name: string): Promise<string> => {
                    const row = await ctx.get('SELECT option_value FROM options WHERE option_name = ?', [name]);
                    return row ? String(row.option_value ?? '') : '';
                };
                let mailDomain = String(await optionOf('mail_security_dkim_domain')).trim().toLowerCase().replace(/\.$/, '');
                if (!mailDomain) {
                    const siteUrl = (await optionOf('siteurl')) || (await optionOf('home'));
                    try { mailDomain = new URL(siteUrl).hostname.toLowerCase(); } catch { mailDomain = ''; }
                }
                if (!mailDomain) {
                    console.log('   [migration 0006] no site/mail domain configured — no professional mailboxes to derive.');
                    return;
                }

                // 2. Which roles could ALREADY set this flag for themselves, i.e. gain nothing from the
                //    old hole? Administrators always; plus any custom role carrying '*' or `edit_users`.
                const privilegedRoles = new Set<string>(['administrator']);
                try {
                    const raw = await optionOf('wordjs_user_roles');
                    const roles = raw ? JSON.parse(raw) : {};
                    for (const [name, def] of Object.entries<any>(roles || {})) {
                        const caps: string[] = (def && def.capabilities) || [];
                        if (caps.includes('*') || caps.includes('edit_users')) privilegedRoles.add(name);
                    }
                } catch (e: any) {
                    console.warn(`   [migration 0006] could not read the roles map (${e && e.message}); treating only 'administrator' as privileged.`);
                }

                // 3. Derive. A user with no role meta is a subscriber (User.getRole's default).
                const rows = (await ctx.all(
                    'SELECT u.id AS id, u.user_email AS user_email, m.meta_value AS role ' +
                    'FROM users u LEFT JOIN user_meta m ON m.user_id = u.id AND m.meta_key = ?', ['role']
                )) || [];
                const granted: string[] = [];
                const pending: string[] = [];
                for (const r of rows) {
                    if (domainOfAddress(r.user_email) !== mailDomain) continue;
                    const role = String(r.role || 'subscriber');
                    const existing = await ctx.get(
                        'SELECT meta_value FROM user_meta WHERE user_id = ? AND meta_key = ?', [r.id, MAILBOX_META_KEY]);
                    if (existing) continue; // already decided (re-run / restored backup) — never overwrite
                    if (privilegedRoles.has(role)) {
                        await ctx.run('INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, ?, ?)',
                            [r.id, MAILBOX_META_KEY, '1']);
                        granted.push(String(r.user_email));
                    } else {
                        pending.push(`${r.user_email} (${role})`);
                    }
                }

                if (granted.length) {
                    console.log(`   ✓ [migration 0006] professional mailbox kept for ${granted.length} privileged account(s): ${granted.join(', ')}`);
                }
                if (pending.length) {
                    console.warn(`⚠️  [migration 0006] ${pending.length} account(s) hold an address on the mail domain '${mailDomain}' but are NOT administrators/user managers, so their professional mailbox was NOT auto-enabled (it could have been self-assigned before this release). Re-enable the legitimate ones in Users → edit user → Professional Mail Account:`);
                    for (const p of pending.slice(0, 50)) console.warn(`      - ${p}`);
                    if (pending.length > 50) console.warn(`      ...and ${pending.length - 50} more`);
                    try {
                        await ctx.run('DELETE FROM options WHERE option_name = ?', ['professional_mailbox_migration_pending']);
                        await ctx.run("INSERT INTO options (option_name, option_value, autoload) VALUES (?, ?, 'no')",
                            ['professional_mailbox_migration_pending', JSON.stringify(pending)]);
                    } catch (e: any) {
                        console.warn(`   [migration 0006] could not record the pending list as an option (the log above is the worklist): ${e && e.message}`);
                    }
                }
            } catch (e: any) {
                console.warn(`⚠️  [migration 0006] professional-mailbox derivation skipped (non-fatal — accounts stay DISABLED until an admin enables them): ${e && e.message}`);
            }
        }
    }
];

async function runSchemaMigrations(db: any, isAsync: boolean, driverName: string, migrations: Migration[] = MIGRATIONS): Promise<void> {
    const isPostgres = driverName === 'postgres';
    // The async drivers return promises; the legacy sync driver returns values that `await` resolves
    // through — so a single awaited path works for both.
    const exec = async (sql: string) => (isAsync ? db.exec(sql) : db.exec(sql));
    const run = async (sql: string, params: any[] = []) => (isAsync ? db.run(sql, params) : db.run(sql, params));
    const get = async (sql: string, params: any[] = []) => (isAsync ? db.get(sql, params) : db.get(sql, params));
    const all = async (sql: string, params: any[] = []) => (isAsync ? db.all(sql, params) : db.all(sql, params));

    await exec(
        `CREATE TABLE IF NOT EXISTS schema_migrations (` +
        `id TEXT PRIMARY KEY, ` +
        `applied_at ${isPostgres ? 'TIMESTAMP' : 'DATETIME'} DEFAULT CURRENT_TIMESTAMP)`
    );

    const appliedRows = (await all('SELECT id FROM schema_migrations')) || [];
    const applied = new Set(appliedRows.map((r: any) => r.id));
    const pending = migrations.filter((m) => !applied.has(m.id));

    if (pending.length === 0) return;

    console.log(`🧬 Schema migrations: applying ${pending.length} pending...`);
    const ctx: MigrationCtx = { exec, run, get, all, isPostgres };
    for (const m of pending) {
        try {
            await m.up(ctx);
            // Idempotent recording: under the multi-node boot lock only one node applies migrations,
            // but make the INSERT conflict-safe too so a duplicate id can never crash a boot.
            await run(
                isPostgres
                    ? 'INSERT INTO schema_migrations (id) VALUES (?) ON CONFLICT (id) DO NOTHING'
                    : 'INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)',
                [m.id]
            );
            console.log(`   ✓ applied schema migration ${m.id}`);
        } catch (e: any) {
            // Fail closed: do NOT continue on a half-migrated schema.
            console.error(`   ✗ schema migration ${m.id} FAILED: ${e && e.message}`);
            throw e;
        }
    }
}

// MIGRATIONS is exported so a suite can drive a SINGLE migration against a throwaway database (and so
// the runner contract test can keep using its own synthetic list). Never mutate it.
module.exports = { runSchemaMigrations, MIGRATIONS };
