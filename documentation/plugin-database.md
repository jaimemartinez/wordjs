# Plugin Database Compatibility Guide

**WordJS plugins use ONE syntax (SQLite-style) for ALL database interaction.** The core handles
driver compatibility automatically (see [database.md](./database.md) for the driver model).

## Database access: the `wordjs` bridge (isolated plugins)

Plugins marked `"isolated": true` run **isolated** in a **separate OS process** (`child_process.fork`
of `backend/src/core/plugin-worker.js`, orchestrated by `backend/src/core/plugin-isolate.ts`) — their
own heap, event loop and memory cap, so a crash, an OOM or a heap escape is contained in the child and
never reaches the host. They do NOT `require()` core modules. They reach the database through the
`wordjs` **capability bridge**, which the host hands them in `init(wordjs)` over RPC on the IPC
channel, and which verifies permissions and constrains arguments **on the host**
(`backend/src/core/plugin-api.ts`), inside the plugin's context (`plugin-context.ts`):

```javascript
module.exports = {
  async init(wordjs) {
    // Every table MUST live under your wjp_<slug>_ prefix: createTable throws on any other name,
    // and all/get/run deny SQL that touches a table outside the prefix.
    const T = wordjs.db.tablePrefix + 'data'; // e.g. 'wjp_my_plugin_data'

    // Create your own table (driver-agnostic)
    await wordjs.db.createTable(T, [
      'id INT_PK',
      'name TEXT NOT NULL',
      'value REAL DEFAULT 0',
      'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
    ]);

    // Queries (standard SQLite syntax on any driver)
    const rows = await wordjs.db.all(`SELECT * FROM ${T} WHERE value > ?`, [0]);
    const one  = await wordjs.db.get(`SELECT * FROM ${T} WHERE id = ?`, [1]);
    const res  = await wordjs.db.run(`INSERT INTO ${T} (name, value) VALUES (?, ?)`, ['a', 1]);

    // Which dialect is active? (rarely needed — an RPC to the host like every other db method, so await it)
    const { isPostgres } = await wordjs.db.getType();
  }
};
```

Bridge methods: `wordjs.db.all/get/run`, `wordjs.db.batch(statements)`,
`wordjs.db.createTable(name, columns)`, `wordjs.db.getType()`, plus the `wordjs.db.tablePrefix`
property (your tables' `wjp_<slug>_` prefix). Each **method** requires the corresponding manifest
permission (`database:read` / `database:write`); `tablePrefix` is a static property and needs no grant
to read.

`db.batch(statements)` runs **several statements in a single round-trip** to the host: a **non-empty**
array of `[sql, params]` pairs, **at most 200**. It is purely a transport optimisation — every
statement goes through the **same** `verifyPermission` and the **same** `assertSqlAllowed` as its
standalone equivalent (`select`/`with` as a read, `insert`/`update`/`delete`/`replace` as a write), and
**the whole batch is validated before** anything runs, so an illegal statement in the middle does not
leave the legal ones before it applied. It **does not accept DDL** (`CREATE`/`ALTER`/`DROP` → use
`db.run` or `db.createTable`, which are what record table ownership). It is **not atomic**: if a
statement fails, the ones before it have already been applied.

### Table isolation: a per-plugin prefix, with the core out of bounds

Every plugin has its **own table namespace** — the `wjp_<slug>_` prefix (like `$wpdb->prefix` in
WordPress), exposed as `wordjs.db.tablePrefix` and derived in `createPluginApi()`
(`'wjp_' + slug + '_'`, normalised to lowercase `[A-Za-z0-9]`).

**Every** plugin is **table-scoped by default-deny** — there is no "trusted" counterpart (the *trusted*
tier was removed; `plugin-trust.ts` no longer exists). The host (`assertSqlAllowed` in
`plugin-api.ts`) requires that **every** table a query touches belongs to the plugin (sits under its
prefix), and `assertSqlAllowed(tablePrefix)` is invoked **always** in `db.all/get/run` (and per
statement in `db.batch`), with no code path that lifts the scoping. `createTable` does not go through
`assertSqlAllowed`, but it imposes the same prefix confinement with a direct check of the table name
(it must start with `tablePrefix`) and delegates to `createPluginTable`, which validates the identifier
and rejects stacked statements. A token that cannot be attributed, or that carries no prefix, is
**rejected** (fail-closed), not ignored — so a plugin cannot read another plugin's tables (mail-server's
`received_emails`, say) or the core's, not even one absent from the explicit denylist.

**Below the text guard there is a second layer: the database itself**
(`backend/src/core/plugin-db-isolation.ts`). Each plugin's reads and DML run under its **own database
principal**, with permissions only over its prefix — a `NOLOGIN` `ROLE` per plugin on PostgreSQL (via
`SET ROLE` on a pinned client) and a per-plugin login user on MySQL/MariaDB (password generated on each
boot and held only in memory) — so the engine denies cross access **even if `assertSqlAllowed` were
bypassed**. It degrades gracefully: under SQLite, or if the pool user cannot provision the principal,
nothing is provisioned and only the text guard remains. **DDL** always runs as the admin user (a
restricted principal has no `CREATE`), scoped to the prefix by the text guard, and each new table is
granted to the principal afterwards.

| Plugin type                       | Database access                                                             |
| :-------------------------------- | :-------------------------------------------------------------------------- |
| **Any plugin** (sandboxed)        | Only its own `wjp_<slug>_*` tables. SQL touching any other table (the core's `users`, `user_meta`, `options`, `roles`, `sessions` included) is **denied**. There is no privileged tier that lifts this scoping. |

#### Users: through the `wordjs.users` bridge, never the core table

A plugin **cannot** (and should not) query the core `users` table directly — `assertSqlAllowed` rejects
it. For user lookups, use the safe `wordjs.users` bridge (`findByEmail` / `findByLogin` / `findById` /
`search`), which returns **only a projection** (`id`, `userLogin`/`username`, `userEmail`,
`displayName`, `role`, plus the `hasProfessionalMailbox` boolean, derived from the
`user_meta.professional_mailbox` grant and fail-closed to `false`) and **never** `user_pass`, tokens or
the rest of the meta. It requires the `users:read` grant. This is the sanctioned path that replaced a
plugin running `SELECT * FROM users` (which leaked password hashes).

Beyond the prefix default-deny, `assertSqlAllowed` rejects the following (defence in depth):

- **SQL that is too long**: the **raw** string is cut off at **20,000 characters** — the check runs
  **before** anything else (the lexer does not even run over an unbounded string), because the guard
  runs in the **host** process and uncapped input is an event-loop DoS.
- **Characters that make lexing diverge between engines** — denied on the raw string, structurally,
  rather than trying to reconcile per-driver semantics:
  - **`/*! … */`** (MySQL/MariaDB executable comments, versioned or not: `/*!50000 … */`).
  - **`\` (backslash)**: MySQL treats it as a quote escape and SQLite/PostgreSQL do not, so a `'\''`
    pairs quotes differently in the guard than in the engine. Literal data always travels as bound
    parameters (`?`).
  - **`$`**: closes the whole class of PostgreSQL dollar-quoting (`$$ … $$`, `$tag$ … $tag$`,
    non-ASCII tags included). The guard runs over SQL with `?`, before translation to `$N`, so a `$` is
    never legitimate.
  - **`[` / `]`**: in PostgreSQL these are array subscripts whose index is a **full expression** (a
    scalar subquery, for instance), not a quoted identifier. To quote an identifier, use `"…"`.
- **`ATTACH` / `DETACH` / `PRAGMA` / `VACUUM`**: mounting host files as a database, reading
  settings/metadata, or (`VACUUM INTO '<file>'`) writing an entire copy of the database to a path the
  plugin chooses.
- **Schema catalogues**:
  `sqlite_master`/`sqlite_schema`/`sqlite_temp_master`/`sqlite_temp_schema`/`information_schema`/`pg_catalog`
  (enumerating or reading the core schema).
- **File/extension/program SQL functions**:
  `readfile`/`writefile`/`load_extension`/`fsdir`/`zipfile`/`sqlite3_*`/`lo_import`/`lo_export`/`pg_read_file`/`pg_read_binary_file`/`pg_ls_dir`/`pg_stat_file`/`dblink`/`dblink_exec`
  — denied textually: they carry no `FROM` (so they dodge prefix attribution) and would open a
  file read/write channel or RCE if the driver changed or an extension were enabled.
- **PostgreSQL's `*_to_xml` family** (`query_to_xml`, `query_to_xmlschema`,
  `query_to_xml_and_xmlschema`, and the `table_`/`schema_`/`database_`/`cursor_` variants): they take a
  **query as a string argument** and execute it. That breaks the premise the whole guard rests on — the
  lexer blanks literals precisely so their contents are never read as structure — so
  `SELECT query_to_xml('select user_pass from users', …)` produces **no** table token at all, and both
  the prefix allowlist and the core denylist would pass **vacuously**. Denied textually on every driver.
- **Stacked statements** (`SELECT 1; DROP TABLE x`) — one statement per call (a single trailing `;` is
  tolerated).
- **A verb that is not permitted**: the statement must start with a verb from the allowlist for that
  method — `all/get` only `SELECT`/`WITH`; `run` only `INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/REPLACE`;
  `batch` classifies each statement and uses `SELECT`/`WITH` for reads and
  `INSERT/UPDATE/DELETE/REPLACE` for writes (no DDL).
- **A data-modifying CTE**: `WITH t AS (INSERT INTO … ) SELECT 1` starts with `with`, which is on the
  **read** verb list — but in PostgreSQL the CTE executes in full whether or not the outer query reads
  its output. A `WITH` containing `insert`/`update`/`delete`/`replace`/`merge` on the read path is
  rejected: **it is a write and requires `database:write`**.
- **Comma joins** (`FROM a, b`, including ones hidden behind a subquery, a `JOIN … ON`, or inside
  parentheses) — these are **not** denied as a construct: the token walker recognises them and
  **attributes every table in the list**, so both (or all N) must carry your `wjp_<slug>_` prefix. Any
  that does not is rejected as "not owned".
- **`USING`** (PostgreSQL's `DELETE ... USING <table>`) and MySQL's `STRAIGHT_JOIN`: included in prefix
  attribution so a table referenced there cannot escape the scoping.
- **`RETURNING`**: a scalar exfiltration channel — denied; use a separate `SELECT` (an insert's
  `lastID` is already available).
- **`ON CONFLICT ... DO UPDATE SET` (upsert) — permitted, not denied**: the token walker treats `SET`
  as a clause boundary (it is in the `ENDERS` set), so the `SET` target is not read as a table. Both
  `DO NOTHING` and `DO UPDATE` pass, provided **every** table the statement references (subquery tables
  included) uses the plugin's `wjp_<slug>_` prefix. (`RETURNING` remains denied; the
  **UPDATE-then-INSERT** pattern is still a valid alternative but is no longer necessary.)
- **Core tables as an explicit denylist** (`PROTECTED_TABLES`: `users`, `user_meta`, `usermeta`,
  `options`, `user_roles`, `roles`, `sessions`) — redundant with the prefix, as a second barrier. The
  match is anchored to a keyword that **introduces** a table (`from`/`join`/`into`/`update`/`using`/`table`),
  so one of your own **columns** named `options` or `status` is not a false positive.
- **Object class in DDL (positive allowlist)**: if the statement starts with `CREATE`/`ALTER`/`DROP`,
  its object may only be **`TABLE`, `INDEX`, `VIEW` or `TRIGGER`** (allowing `OR REPLACE`,
  `TEMP`/`TEMPORARY` and `UNIQUE`). Any other class — `SCHEMA`, `DATABASE`, `ROLE`, `FUNCTION`,
  `EXTENSION`, `SYSTEM`… — is denied: those statements **name no table**, so the walker emitted no
  token and the prefix rule passed **vacuously** (`DROP SCHEMA public CASCADE`,
  `CREATE ROLE … SUPERUSER`, or a `SECURITY DEFINER` function whose body is a literal — invisible to
  the guard by design — were all permitted). Safety is never inferred from the **absence** of tokens:
  only the classes the guard knows how to scope are admitted.
- **`ALTER … RENAME TO <target>`**: the target must carry your prefix too. The token **before** the
  rename does carry it (the walker accepts it) and says nothing about where it lands:
  `ALTER TABLE wjp_x_notes RENAME TO users` would shadow a core table.
- **Another plugin's table even when the prefix matches**: beyond `startsWith(tablePrefix)`, the guard
  consults the **authoritative creator registry** (`TABLE_CREATORS`, persisted in
  `data/wjp-prefix-registry.json`) — if the table has a recorded creator, only that slug may touch it —
  and the **longest claimed-prefix match** across all claimed prefixes: if a sibling plugin with a
  longer prefix owns it, access is denied even though yours also matches (defence against prefix-extension
  squatting, e.g. the slug `events-ticket` over `events`'s tables).
- **Index DDL** (`CREATE [UNIQUE] INDEX … ON <table>` / `DROP INDEX <name>`): both the `ON` target
  table **and the index name** must start with the plugin's `wjp_<slug>_` prefix; otherwise the query is
  denied (the generic table matcher sees neither the `ON` target nor the index name, so they are scoped
  separately).
- **View/trigger DDL** (`CREATE [TEMP] VIEW/TRIGGER <name>` / `DROP VIEW/TRIGGER <name>`): the
  **object name** must start with the plugin's `wjp_<slug>_` prefix too (the generic table matcher does
  not see it), or the statement is denied — the same rule as for indexes, so a plugin cannot squat or
  shadow an object in the shared namespace.

All of this is decided over the output of **a single lexer** (`lexSql`), which walks the string **once**
recognising comments, string literals and quoted identifiers **in context** — a `/*` inside a literal is
text, a `'` inside a comment is a comment — so that the contents of neither can ever be read as
structure. SQL comments (`/* */` and `--`) are blanked **before** evaluation so they cannot serve as
whitespace that evades the checks (`--` opens a comment only when followed by whitespace or end of line,
the stricter rule — MySQL's — and closes on both `\n` and a lone `\r`, PostgreSQL's: so text any engine
would execute stays visible to the guard). Quoted identifiers (`"quotes"`, `` `backticks` ``) are
emitted as **a single opaque token marked as a name**, so an alias like `AS "order"` is not confused
with the `ORDER` keyword and does not inject a phantom parenthesis; `[brackets]` are not normalised —
they are **denied** (see above). `createTable` applies the same principle: a plugin can only create
tables under its own prefix (it cannot create or shadow core or other plugins' tables).

#### Lifecycle: uninstalling and `dropData`

When a plugin is uninstalled, `uninstallPluginData(slug, { dropTables })`
(`backend/src/core/plugins.ts`) **always** clears its grants (`removeGrants`), crash strikes and queued
assets — so a re-uploaded slug does not inherit old permissions. The plugin's `wjp_<slug>_*` tables are
**kept by default** (parity with WordPress) and are only **dropped** when the admin ticks the
`dropData` box on deletion (`DELETE`, `routes/plugins.ts` → `dropTables: !!dropData`). The drop is
limited to tables under the plugin's `wjp_<slug>_` prefix: it never touches core or other plugins'
tables.

The scoping is **unconditional**: there is no way for a plugin to lift it.
`verifyPermission('database', …)` only decides whether the plugin **may** reach the database;
`assertSqlAllowed(tablePrefix)` always imposes the prefix confinement. There is no elevated database
access token: the `database` scope's vocabulary is exactly `read` and `write` (`KNOWN_PERMISSIONS`,
`core/plugins.ts`), so an uploaded or marketplace-installed manifest that asks for `database:admin` is
rejected at install time by `validateManifestPermissions` (400, extracted files removed). Even a plugin
dropped straight into `backend/plugins/` (dev flow, which skips that manifest check) gains nothing from
such a token — no code path reads the `access` value to skip `assertSqlAllowed`, so it stays
table-scoped to its prefix regardless.

Because plugins can no longer read core tables, the site's **non-secret** information
(`url`/`domain`/`adminEmail`) is obtained through the `wordjs.site` bridge (`settings:read` grant).
Secret or security-critical options (those matching `secret`/`passw…`/`…key…`/`token`/`credential`/`encryption`
patterns, plus names like `wordjs_user_roles`, `active_plugins`, `siteurl`) are blocked for **every**
plugin through `wordjs.options` — with no trust bypass.

> **Defence in depth (inside the child):** the isolated process also runs `secure-require.ts` (which
> blocks `worker_threads`/`vm`/`child_process`/network modules, `process.binding` and native addons). If
> any plugin or theme code were to `require('../config/database')`, `secure-require` does not hand back
> the real `dbAsync` but a **scoped** one (a `guardedDb` Proxy): on `run/get/all/exec/each` it runs
> `guardPluginSql`, which **delegates to the same `assertSqlAllowed`** the bridge uses (with
> `allowedVerbs=[]`, leaving the verb mix to the calling method, and deriving the active plugin's
> `wjp_<slug>_` prefix with `getEffectivePlugin()`). It is deliberately the **same** implementation and
> not a copy: the regex check that used to live here diverged from the bridge and was evaded with
> `FROM/**/users` or `FROM"users"`, and on top of that it had no prefix restriction, so a theme or an
> in-process plugin could read anyone's tables. Now both database surfaces share the structural denials,
> the catalogue/file-function denylist, the single-statement rule, the core-table denylist **and** the
> positive prefix allowlist. It also runs `io-guard.ts`, which confines `fs` to the plugin's **own**
> directory: it blocks writes to its code and reads of `.env`/secrets. The block on the **database
> files** (`data/wordjs.db` + sidecars) acts inside the isolated child (`__WORDJS_ISOLATED__`), not on
> the host (where the bridge's driver legitimately opens `data/wordjs.db`), so a plugin cannot read the
> database around the bridge by touching the file directly. `io-guard` also **denies reading a sibling
> plugin's directory** — its `package.json`, its `node_modules` or any file (it resolves only the
> plugin's own tree plus shared ancestors), so a plugin cannot exfiltrate another plugin's files or
> secrets even outside the database (IO-1).

> **Historical note:** `db-migration` is **no longer** a plugin (it migrated and touched core tables and
> managed server processes). It is now core infrastructure in `backend/src/core/db-admin/`. See
> [database.md §1.4](./database.md).

## Principle: one syntax everywhere

**Every plugin writes SQL in SQLite syntax, and the core normalises it automatically for PostgreSQL.**

This applies to:
- ✅ CREATE TABLE
- ✅ SELECT queries
- ✅ INSERT statements
- ✅ UPDATE statements
- ✅ DELETE statements
- ✅ JOINs, subqueries, and so on

### Unified syntax

Plugins use standard SQLite syntax, and the core translates it automatically:

| Plugin type | SQLite                              | PostgreSQL           | MySQL / MariaDB                        |
| ----------- | ----------------------------------- | -------------------- | -------------------------------------- |
| `INT_PK`    | `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL PRIMARY KEY` | `INTEGER AUTO_INCREMENT PRIMARY KEY`   |
| `INT`       | `INTEGER`                           | `INTEGER`            | `INTEGER`                              |
| `TEXT`      | `TEXT`                              | `TEXT`               | `LONGTEXT` (or `VARCHAR(255)` **only** if the DDL makes the column part of a key) |
| `REAL`      | `REAL`                              | `REAL`               | `REAL`                                 |
| `DATETIME`  | `DATETIME`                          | `TIMESTAMP`          | `DATETIME`                             |
| `TIMESTAMP` | `DATETIME`                          | `TIMESTAMP`          | `DATETIME`                             |

> The **MySQL** driver (`backend/src/drivers/mysql.ts`, `mysql2`, MySQL 8.0+/MariaDB) translates the
> SQLite dialect at the driver edge (`translateSql`): `INTEGER PRIMARY KEY AUTOINCREMENT`/`SERIAL` →
> `INTEGER AUTO_INCREMENT PRIMARY KEY`, `TEXT` → `LONGTEXT`, `INSERT OR IGNORE`/`ON CONFLICT` →
> `INSERT IGNORE`/`ON DUPLICATE KEY UPDATE`, and `RETURNING` → `insertId`. The plugin writes nothing
> different: it keeps using SQLite syntax.

> **A `TEXT` column's type no longer depends on its NAME**
> (`backend/src/drivers/mysql-text-rule.ts`). The default used to be `VARCHAR(255)` unless the column
> name appeared in a fixed list of ~20 core columns. That list cannot know a plugin's columns, nor an
> imported bundle's, so **every** plugin `TEXT` column (an email body, an auction description, a form
> payload) was created 255 characters wide; and because the session also gave up
> `STRICT_TRANS_TABLES`, an over-long value was **truncated with a warning instead of rejected** —
> `POST /api/v1/import` mutilated content while counting the rows as imported. The rule is now derived
> from the `CREATE TABLE` itself: `TEXT` → `LONGTEXT` unless the column is part of a key (an inline
> `PRIMARY KEY`/`UNIQUE`, or a `PRIMARY KEY (…)`/`UNIQUE (…)`/`KEY (…)`/`INDEX (…)`/`FOREIGN KEY (…)`
> naming it), in which case it is `VARCHAR(255)` because MySQL cannot index a `TEXT` without a prefix
> length. `STRICT_TRANS_TABLES` is active again: what does not fit is an **error**, not a silent loss.

### Example

Through the bridge (the canonical path for isolated plugins):

```javascript
async function initSchema(wordjs) {
    const T = wordjs.db.tablePrefix + 'accounts'; // unprefixed names are rejected by createTable
    await wordjs.db.createTable(T, [
        'id INT_PK',
        'name TEXT NOT NULL',
        'email TEXT UNIQUE',
        'created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
        'balance REAL DEFAULT 0',
        'status INT DEFAULT 0'
    ]);
}
```

> A `FOREIGN KEY (...) REFERENCES users(id)` points at a core table (`users`) — out of bounds for any
> plugin. Reference only your own tables; for user data, use the `wordjs.users` bridge (a projection).

### Why this way

1. **One syntax everywhere**: plugins write SQLite-style for EVERYTHING.
2. **Automatic normalisation**: the PostgreSQL driver converts `?` to `$1, $2` (and injects `RETURNING`
   into INSERTs); the legacy WASM driver strips `RETURNING`; the MySQL driver rewrites the dialect
   (`translateSql`) and maps `RETURNING` to `insertId`. The plugin notices none of it.
3. **Full compatibility**: works with SQLite Native (default), SQLite Legacy (WASM), PostgreSQL and
   MySQL/MariaDB.
4. **No changes when migrating**: change driver and the plugin keeps working unmodified.
5. **Cleaner code**: no need to detect the driver by hand.
6. **Transparent**: plugins do not know which driver they are on.

## Detecting the dialect: `wordjs.db.getType()`

If you need information about the active driver (for conditional logic, rarely necessary). Like every
other `wordjs.db` method, `getType()` is an RPC to the host and **returns a Promise** — always `await`
it (destructuring the bare call yields `undefined` for every flag, so each dialect branch would silently
take the non-Postgres path):

```javascript
const { isPostgres, isMySQL, isSQLite, driver } = await wordjs.db.getType();

if (isPostgres) {
    // PostgreSQL-specific logic (rare, but possible)
}
```

> `getType()` resolves to `{ isPostgres, isMySQL, isSQLite, driver }` (it needs `database:read`;
> `driver` being the full name of the configured driver: `'sqlite-native'`, `'sqlite-legacy'`, `'postgres'`, `'mysql'` or `'mariadb'`).
> Careful: `isSQLite` is `true` for **everything that is not PostgreSQL**, MySQL included (so that
> binary branches like `isPostgres ? pg : sqlite` keep taking the SQLite path, which the MySQL driver
> translates) — so `isSQLite && isMySQL` is a normal state, and the condition for "really SQLite" is
> `isSQLite && !isMySQL`.

## Migrations

**A plugin cannot introspect the schema.** `PRAGMA` and `information_schema` (like
`sqlite_master`/`pg_catalog`) are **denied by `assertSqlAllowed` for every plugin**, and the read verbs
are only `select`/`with`, so a `PRAGMA table_info(...)` does not even clear the verb allowlist. There is
no way to ask "does this column exist?" from the bridge.

The pattern is to make migrations **idempotent** rather than conditional:

- **Tables**: `db.createTable()` emits `CREATE TABLE IF NOT EXISTS`, so calling it again on every
  `init()` with the full column set is safe.
- **New columns**: `ALTER TABLE <your own table> ADD COLUMN …` is permitted (`alter` is among
  `db.run`'s verbs, `TABLE` is an admitted DDL object class, and the table is attributed by your
  prefix). SQLite has no `ADD COLUMN IF NOT EXISTS`, so the idempotent form is to **swallow the
  duplicate-column error**:

```javascript
async function addColumnIfMissing(wordjs, table, col, type) {
    // Only a safe SQL identifier may be concatenated into the DDL.
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(col)) return false;
    try { await wordjs.db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); return true; }
    catch (e) { return false; /* it already existed (or the type was invalid) — ignoring is safe */ }
}

async function migrate(wordjs) {
    const T = wordjs.db.tablePrefix + 'data';
    await addColumnIfMissing(wordjs, T, 'new_col', "TEXT DEFAULT ''");
}
```

> This is exactly what `conference-manager` does
> (`marketplace/plugins/conference-manager/index.js`), which documents the same reason in its own code.
>
> Mind an `ADD COLUMN`'s `DEFAULT`: it only fills existing rows on the boot where the column is first
> created. New rows arrive with whatever value your `INSERT` supplies.

## Complete examples

### A full plugin with tables and queries

```javascript
module.exports = {
  async init(wordjs) {
    const T = wordjs.db.tablePrefix + 'data'; // e.g. 'wjp_my_plugin_data'

    // Create a table with the unified syntax
    await wordjs.db.createTable(T, [
      'id INT_PK',
      'name TEXT NOT NULL',
      'value REAL DEFAULT 0',
      'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
    ]);

    // Expose helpers that use the bridge
    this.getData = (id) =>
      wordjs.db.get(`SELECT * FROM ${T} WHERE id = ?`, [id]);

    // A query with LIMIT/OFFSET — identical on every driver
    this.getAllData = (limit = 10, offset = 0) =>
      wordjs.db.all(
        `SELECT * FROM ${T} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [limit, offset]
      );

    // INSERT — run() returns { lastID, changes } on every driver
    this.createData = async (name, value) => {
      const res = await wordjs.db.run(
        `INSERT INTO ${T} (name, value) VALUES (?, ?)`,
        [name, value]
      );
      return res.lastID;
    };

    this.updateData = (id, name, value) =>
      wordjs.db.run(`UPDATE ${T} SET name = ?, value = ? WHERE id = ?`, [name, value, id]);

    this.deleteData = (id) =>
      wordjs.db.run(`DELETE FROM ${T} WHERE id = ?`, [id]);
  }
};
```

> **In-process API (advanced / core):** the bridge rests on helpers in
> `backend/src/config/database.ts` (`dbAsync`, `createPluginTable`, `getDbType`). **Core** code (models,
> `db-admin`) imports them directly; isolated plugins do **not** — they always go through
> `wordjs.db.*`.

## Plugins already on this model

- ✅ `card-gallery` — persists its data through the `wordjs.options` bridge (key/value), not in SQL tables.
- ✅ `video-gallery` — persists its data through the `wordjs.options` bridge (key/value), not in SQL tables.
- ✅ `mail-server` — a **fully untrusted** (sandboxed) plugin: it uses the `database:read` +
  `database:write` grants (among others its manifest requests) and keeps its relational data — DKIM
  keys and relay SMTP secrets included — in its own `wjp_mail_server_*` tables (`_received_emails` /
  `_email_attachments` / `_secrets`), precisely because `assertSqlAllowed` denies any table outside its
  prefix. Attachment **bytes** and the Bayes corpus do not go in the database: they live in the
  plugin's own directory via the `filesystem:read`/`write` grants (the `_email_attachments` table holds
  only the metadata and the `storage_path`).
- ✅ `youtube-videos` — stores the YouTube Data API key in its **own table** `wjp_youtube_videos_*` (not
  in options, which other plugins can read); its settings "upsert" uses the **UPDATE-then-INSERT**
  pattern (the plugin's own choice; today's guard already permits `ON CONFLICT ... DO UPDATE SET` on
  your own tables).
- ✅ `conference-manager` — its own `wjp_conference_manager_*` tables via `db.tablePrefix` +
  `db.createTable`; note that the database bridge **exposes no transactions** (`db.batch` groups the
  **transport**, it is not a transaction), so updates that depend on another row are done with a single
  `UPDATE` carrying a subquery.
- ✅ Every existing plugin (the 31 marketplace ones included) — standard SQLite syntax; all table-scoped
  to their own prefix (no access to core tables).
