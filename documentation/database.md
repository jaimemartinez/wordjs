# WordJS Database Documentation 🗄️

WordJS uses a **Multi-Driver** architecture, allowing you to run on anything from a cheap VPS with a file-based DB to a scalable cloud cluster with PostgreSQL.

Every backend implements a single async **driver interface** (`backend/src/drivers/interface.ts`), so the rest of the codebase never branches on which database is active. A small **DB Manager** (`backend/src/config/database.ts`) loads the configured driver, exposes the abstraction proxies (`dbAsync`, `db`), and creates the core schema.

## 1. Supported Drivers

| Driver              | Library          | Config Value    | Role                                                                       |
| :------------------ | :--------------- | :-------------- | :------------------------------------------------------------------------- |
| **SQLite (Native)** | `better-sqlite3` | `sqlite-native` | **Default & recommended.** High performance (WAL mode), single-server.     |
| **PostgreSQL**      | `pg`             | `postgres`      | **Scalable.** Best for clusters and high-concurrency environments.         |
| **MySQL / MariaDB** | `mysql2`         | `mysql`         | External MySQL 8.0+ / MariaDB; the driver translates SQLite-dialect SQL.    |
| **SQLite (Legacy)** | `sql.js` (WASM)  | `sqlite-legacy` | **Automatic fallback only.** Pure JS, used when the native binary fails.    |

`sqlite-native` is the DB Manager default (`config.dbDriver || 'sqlite-native'`). You do not normally select `sqlite-legacy` yourself — see [Automatic Fallback](#13-automatic-fallback-mechanics) below.

### 1.1 Driver Deep Dive 🏎️

#### **SQLite (Native - Default)**
Uses the `better-sqlite3` library, the fastest SQLite driver for Node.js. This is the **canonical SQLite engine** and the DB-manager default.
*   **Performance:** Enabled with **WAL (Write-Ahead Logging)** mode by default, allowing simultaneous reads and writes.
*   **Safety:** Atomic writes prevent database corruption during power outages.
*   **Requirement:** Requires a native binary (prebuilt for most platforms; building from source needs C++ tools like `python`, `make`, `g++`).
*   **Driver file:** `backend/src/drivers/sqlite-native-async.ts` (async, implements the interface). The older sync `sqlite-native.ts` wrapper still exists for compatibility.
*   **Data file:** stores its database at `backend/data/wordjs-native.db` (default). This is a **different file** from the legacy driver — see [§1.7 SQLite Drivers Use Different Files](#17-sqlite-drivers-use-different-files).

#### **PostgreSQL**
Uses the `pg` client (connection **Pool**) via `backend/src/drivers/postgres.ts`.
*   **External by default:** the `postgres` driver connects to an **external** Postgres server using the `db` connection object (host/port/user/password/name/ssl). It does **not** bundle or start a server on its own.
*   **SQLite-compatible SQL:** the driver's `normalizeSql()` rewrites SQLite-style `?` placeholders to `$1, $2, …`, and `run()` auto-injects `RETURNING *` on `INSERT`s so it can report `lastID`. Plugins and models keep writing SQLite-style SQL (see [plugin-database.md](./plugin-database.md)).

#### **MySQL / MariaDB**
Uses the `mysql2` client (connection **Pool**) via `backend/src/drivers/mysql.ts`, connecting to an **external** MySQL 8.0+ / MariaDB server (same `db` connection object — set `dbPort: 3306`). It does **not** bundle or start a server.
*   **Dialect translation:** models and plugins keep writing ONE dialect (SQLite); the driver rewrites it to MySQL at the boundary — `?` placeholders are native; **`TEXT`→`LONGTEXT`, except a column that takes part in a key, which becomes `VARCHAR(255)`** (see below) with parenthesised **expression defaults** (MySQL ≥ 8.0.13); `INTEGER PRIMARY KEY AUTOINCREMENT`→`AUTO_INCREMENT`; `INSERT OR IGNORE` / `ON CONFLICT`→`INSERT IGNORE` / `ON DUPLICATE KEY UPDATE`; `RETURNING`→`insertId`; functional-index parens; and the session runs a single `sql_mode` — `ANSI_QUOTES` (so `"col"` is an identifier like SQLite/Postgres), `STRICT_TRANS_TABLES` and `NO_ENGINE_SUBSTITUTION`.

> **The `TEXT` rule, and why it is not a list of column names** (`backend/src/drivers/mysql-text-rule.ts`). The default used to be the other way round: `VARCHAR(255)` unless the column **name** appeared in a hard-coded set of ~20 core columns. A literal list can never know a plugin's columns or those of an imported bundle, so every plugin `TEXT` column — a mail body, an auction description, a submitted form payload — was created 255 chars wide; and because the session also dropped `STRICT_TRANS_TABLES`, an overlong value was **truncated with a warning instead of rejected**. `POST /api/v1/import` → `createPluginTable` therefore mutilated content while reporting `custom_tables.rows++` and an empty `errors` array. The rule is now derived from the DDL itself — a column is bounded only when the `CREATE TABLE` declares it part of a key (inline `PRIMARY KEY`/`UNIQUE`, or a table-level `PRIMARY KEY (…)`/`UNIQUE (…)`/`KEY (…)`/`INDEX (…)`/`FOREIGN KEY (…)` naming it), because MySQL cannot index a `TEXT` key part without a prefix length and being declared a key is itself the evidence the column is short by design. `STRICT_TRANS_TABLES` is back on: a value that does not fit is an **error**, not a silent truncation.
*   **Known limitation:** MySQL has no **partial indexes**, so the `posts(post_name) WHERE post_name<>''` unique index is skipped (the app-layer `generateUniqueSlug` enforces slug uniqueness instead).

#### **SQLite (Legacy - WASM Fallback)**
Uses a pure JavaScript WASM build of SQLite (`sql.js`) via `backend/src/drivers/sqlite-legacy.ts`.
*   **Use Case:** Restricted hosting environments (some shared hosting, strictly locked-down containers) where the native binary cannot load.
*   **Trade-off:** Slower than Native for heavy writes, and it uses the older **synchronous** driver shape (the DB Manager adapts it). It reads/writes the **same SQLite file format**.
*   **Data file:** stores its database at `backend/data/wordjs.db` (the config layer defaults `dbPath` **per driver** — `./data/wordjs.db` only when `sqlite-legacy` is configured, `./data/wordjs-native.db` otherwise; `backend/src/config/app.ts`). Although the file *format* is identical to Native, the two SQLite drivers use **different files by default** — see [§1.7 SQLite Drivers Use Different Files](#17-sqlite-drivers-use-different-files).

### 1.2 The Driver Interface & Conformance Suite

All async drivers extend `DatabaseDriverInterface` (`backend/src/drivers/interface.ts`), a seven-method contract:

| Method                 | Purpose                                              |
| :--------------------- | :--------------------------------------------------- |
| `connect()`            | Open the connection / pool.                          |
| `get(sql, params)`     | Run a query, return a single row.                    |
| `all(sql, params)`     | Run a query, return all rows.                        |
| `run(sql, params)`     | Run INSERT/UPDATE/DELETE, return `{ lastID, changes }`. |
| `exec(sql)`            | Run a raw SQL script (e.g. DDL / migrations).        |
| `transaction(fn)`      | Run `fn(tx)` atomically (BEGIN → COMMIT, ROLLBACK on throw). |
| `close()`              | Close the connection / pool.                         |

The base `interface.ts` default `transaction()` throws `transaction() not implemented`; every async driver (`sqlite-native-async`, `postgres`, `mysql`, `sqlite-legacy`) overrides it with a real atomic implementation — see [§1.2.1](#121-atomic-transactionfn) below.

A **conformance test** (`backend/src/tests/driver-conformance.test.ts`) runs the *same* contract (create → insert → get → all → update → delete → drop) against the drivers it carries a dialect descriptor block for, asserting `run()` returns a truthy `lastID` and correct `changes`, that params bind, and that mutations persist. Today that is **`sqlite-native`, `postgres`, and `mysql`** (adding a driver = add a descriptor block). Drivers whose backend isn't reachable **skip gracefully locally**: if `better-sqlite3` can't load it's treated as the sql.js-fallback case, and if no Postgres/MySQL is reachable that block is skipped (3s connect timeout). **In CI this inverts.** When `WORDJS_CI_DB=1` the service containers are wired precisely so the driver *is* exercised, so `skipOrFail()` turns an unreachable or unloadable Postgres/MySQL into a hard **failure** rather than a silent green — the conformance blocks cannot quietly no-op. The legacy sync `sqlite-legacy` driver is intentionally out of scope (the suite validates the async interface implementers).

#### 1.2.1 Atomic `transaction(fn)`

`transaction(fn)` is part of the driver contract and is genuinely **atomic** on every async driver. The callback receives a `tx` exposing `get`/`all`/`run`/`exec` with the **same SQLite-style SQL shape** (placeholders, `RETURNING` auto-injection, `{ lastID, changes }`) inside the transaction as outside it, so callers write identical SQL either way.

*   **PostgreSQL** (`postgres.ts`) pins **one** pooled client for the whole unit of work — `BEGIN` → `fn(tx)` → `COMMIT`, `ROLLBACK` on throw, and the client is **always** released in a `finally`. This matters because the per-statement methods each grab a *different* pooled connection, so a multi-statement unit would otherwise not share a transaction.
*   **MySQL / MariaDB** (`mysql.ts`) pins **one** pooled `mysql2` connection for the unit of work — `BEGIN` → `fn(tx)` → `COMMIT`, `ROLLBACK` on throw, connection released in a `finally` — for the same reason as Postgres (the per-statement methods each grab a different pooled connection).
*   **SQLite (Native)** (`sqlite-native-async.ts`) wraps `BEGIN`/`COMMIT`/`ROLLBACK` on its single shared `better-sqlite3` handle.
*   **SQLite (Legacy)** (`sqlite-legacy.ts`) suppresses its per-write disk flush while a transaction is open and saves to disk **once** after `COMMIT`. There is no pre-`BEGIN` snapshot: sql.js *is* SQLite, so its own `ROLLBACK` restores the in-memory image, and because the per-write `save()` stayed suppressed the file on disk still holds the last committed image throughout. Only when `ROLLBACK` itself throws does the driver read that file back into a fresh handle. Either way a failed tx leaves both memory and disk at the prior committed state, without paying a full database copy per transaction.

**SQLite transaction serialization & re-entrancy.** Both SQLite drivers serialize `transaction()` through a per-driver promise-chain mutex (`_txChain` / module-level `txChain`): because the callback is async and may `await` between `BEGIN` and `COMMIT`, two overlapping callers could otherwise interleave their `BEGIN`/`COMMIT` on the single shared connection (SQLite has no nested `BEGIN`). Each call waits for the previous to fully settle before its own `BEGIN` runs. A **re-entrant** `transaction()` — one invoked from inside another's callback — fails fast by throwing `nested transaction() is not supported` rather than deadlocking the queue, and `_inTransaction` is reset in a `finally` on **both** commit and rollback.

**Clean unique-constraint errors.** `User.create` and `User.update` translate a cross-driver UNIQUE-constraint violation (on `idx_users_login` / `idx_users_email`) into a clean application error — `Username or email already exists` on create, `Email already in use` on update — instead of surfacing a raw driver constraint error / 500. The detector `isUniqueViolation` handles Postgres SQLSTATE `23505` and SQLite `SQLITE_CONSTRAINT*` / `UNIQUE constraint failed`. Emails are canonicalized (full-Unicode lowercase + NFC via `normalizeEmail`) before store/lookup, so the ASCII-only SQLite `LOWER()` backstop holds.

> **Roles cache (DATA-05).** `getRoles()` serves from an in-memory cache that, once older than `ROLES_CACHE_TTL_MS` (**10s** in code), kicks a non-blocking, single-flight background re-read to bound staleness and self-heal a missed pub/sub invalidation. A monotonic `_localWriteEpoch` is captured before the background DB read and the result is applied **only** if the epoch is unchanged, so a stale read cannot clobber a just-written local change. Cross-node coherence (DATA-COH-01) is **deferred**.

### 1.3 Automatic Fallback Mechanics

The DB Manager (`loadDriver` in `config/database.ts`) falls back to `sqlite-legacy` when loading a driver fails, provided the failed name isn't already `sqlite-legacy` **and** either the name starts with `sqlite` or it came from the config file rather than an explicit override:

*   A failed **SQLite** driver (default path, or any `sqlite*` name) → silently falls back to pure-JS `sqlite-legacy` (same file format).
*   A failed **non-SQLite** name passed as an explicit **override** — `loadDriver('postgres')`, the path re-init, tests and the migration tool take — is **not** downgraded to SQLite; the error propagates. The guard keys on that override, and the boot path passes none, so a `postgres`/`mysql` named only in `wordjs-config.json` whose module fails to load (a missing `pg`/`mysql2`, say) *does* fall back and comes up on an empty local SQLite file.

### 1.4 Live Data Migration

WordJS includes a **Zero Data Loss** migration tool for switching drivers without losing users or posts.

> **This is core infrastructure, not a plugin.** Database migration manages the DB lifecycle — work that must happen in the host process and cannot run in an isolated plugin. (Isolated plugins run in a separate OS process via `child_process.fork` with no host-heap access and a scoped bridge, so they have neither the DB handle nor the privileges this needs.) It was formerly the `db-migration` *plugin*; it now lives in core at `backend/src/core/db-admin/` and is wired in at boot.

1. Go to the **DB Migration** entry in the admin sidebar (route `/admin/db-migration`). It is a native admin route, always available — it is not tied to plugin activation.
2. Select your target engine (e.g., switch from SQLite to Postgres).
3. The system will:
    - **Stream** data per table to the new driver (preventing RAM spikes).
    - **Reconcile** each table's row count against the source immediately after copying it. A mismatch **throws on the first offending table** and aborts the migration — the original database is left untouched. (This is a fail-closed check *after* each copy, not a pre-flight scan; it used to be a mere warning that still switched the live DB.)
    - **Swap** the data file into place and update the configuration.
    - **Restart** the backend automatically to apply changes.

> **Note:** For a file-based SQLite target (e.g. Legacy -> Native) the copy goes to a temporary file which is then moved onto the real filename (`fs.renameSync`) — so a half-written database never becomes the live one. If that move fails because the target file is locked, the migration does **not** fail: it keeps the temporary file as the new active database and points the config at it, so no data is lost even though the filename ends up non-standard.

> **MySQL/MariaDB is now a supported migration target.** The DB-Admin migration tool's `availableDrivers` are `sqlite-legacy`, `sqlite-native`, `postgres`, and `mysql` — you can migrate existing data *into* MySQL/MariaDB from the admin UI just like Postgres (it is also a first-class **runtime** driver, §1.1). The tool recreates the non-core schema on the target, then performs an atomic, fail-closed row copy (`SET FOREIGN_KEY_CHECKS` off during the copy, `TEXT`→`LONGTEXT` for long-content columns via the target CREATE).

The backing API is mounted at `/api/v1/db-migration` (guarded by `authenticate` + the `manage_options` permission).

### 1.5 Backups & Retention

Full-site backups (logical DB export + a physical DB snapshot for SQLite + the `uploads/`, `plugins/`, `themes/` content roots) are produced by `backend/src/core/backup.ts` (`createBackup()`) and stored **on-host** under `backend/backups/`. An **optional off-host S3 offload** (`backend/src/core/s3-offload.ts`) runs right after: it is config-gated on an `s3` block in `wordjs-config.json` or the `WORDJS_S3_*` / `AWS_*` env vars, and a partial config (a bucket with no keys) counts as *not configured* rather than a half-attempt. The upload is a single SigV4-signed `PUT` over Node's built-in `https` — the AWS SDK is not a dependency — so an S3-compatible endpoint such as MinIO works by setting `s3.endpoint`. A failed upload never fails the backup: the local copy is kept and the outcome is reported in the result's `s3` field.

After every backup, retention pruning runs automatically (`pruneBackups()` in `backend/src/core/backup.ts`): only the newest **N** backups are kept and older ones are deleted, so scheduled/auto backups can no longer fill the disk unbounded. **N** comes from the `backup_retention` option (**default 7**); set it to `0` (or a negative value) to keep all backups and disable pruning.

### 1.6 Configuration

To change the driver, edit `backend/wordjs-config.json`. The flat `db*` keys (`dbDriver`, `dbHost`, `dbUser`, `dbPassword`, `dbName`, `dbPort`, `dbSsl`, `dbPath`) and a nested `db: { … }` object are both accepted; the config layer normalizes them into a single `db` connection object (`backend/src/config/app.ts`).

**Example — external Postgres:**
```json
{
  "dbDriver": "postgres",
  "dbHost": "localhost",
  "dbPort": 5432,
  "dbUser": "wordjs",
  "dbPassword": "change-me",
  "dbName": "wordjs"
}
```

> ⚠️ **Do NOT point `dbUser` at the `postgres` superuser.** Create a dedicated role that owns only the
> WordJS database (`CREATE ROLE wordjs LOGIN PASSWORD '…'; CREATE DATABASE wordjs OWNER wordjs;`). The
> app issues DDL of its own (`initializeSchema`, schema migrations, `createPluginTable`), so the role
> needs ownership of its database — but nothing beyond it. Note the config layer's fallback when
> `dbUser`/`db.user` is **absent** is the literal `'postgres'` (`backend/src/config/app.ts`), so an
> incomplete config silently reaches for the superuser: set the key explicitly.
>
> One trade-off to know about: the per-plugin Postgres **role** isolation (`core/plugin-db-isolation.ts`)
> provisions a NOLOGIN role per plugin and needs `CREATEROLE` to do it. Without that privilege it
> **fails gracefully** — plugin SQL is still confined to the plugin's `wjp_<slug>_` tables by the
> text-guard (`assertSqlAllowed`), it just loses the second, database-enforced layer. Grant `CREATEROLE`
> to the WordJS role if you want that layer; do **not** reach for the superuser to get it.

**Example — SQLite (default):**
```json
{
  "dbDriver": "sqlite-native",
  "dbPath": "./data/wordjs-native.db"
}
```
> Each SQLite driver defaults to its **own** file (`sqlite-native` → `data/wordjs-native.db`, `sqlite-legacy` → `data/wordjs.db`). If you set `dbPath` explicitly, point it at the file for the driver you selected. See [§1.7](#17-sqlite-drivers-use-different-files).

> **Secrets:** on boot the config layer auto-generates and persists a secure `jwtSecret` and `dbPassword` if `wordjs-config.json` already exists and the value is **missing** or is the known-insecure literal (`wordjs-default-secret-change-me` / `password`). The new value is written back into the file. Operators should still review these.

> ⚠️ **`dbPassword` (flat) outranks `db.password` (nested), and the auto-generation only looks at the flat key.** The normalizer resolves the password as `dbPassword || db.password || 'password'` (`backend/src/config/app.ts`). So if you configure an external Postgres/MySQL password **only** in the nested form, boot sees no flat `dbPassword`, generates a random one, persists it — and that generated value then **shadows** your nested `db.password`, leaving the app unable to authenticate. When you set a real database password, set the flat **`dbPassword`** key (or set both to the same value). The same precedence applies to `dbHost`/`dbPort`/`dbUser`/`dbName`/`dbSsl` over their nested twins, but only the password is auto-generated.

### 1.7 SQLite Drivers Use Different Files

The two SQLite drivers do **not** share a data file by default — each maps to a distinct file under `backend/data/`:

| `dbDriver`        | Library                | Default data file            |
| :---------------- | :--------------------- | :--------------------------- |
| `sqlite-native`   | `better-sqlite3`       | `backend/data/wordjs-native.db` |
| `sqlite-legacy`   | `sql.js` (WASM)        | `backend/data/wordjs.db`     |

PostgreSQL (via `pg`) is a **separate engine** entirely, not a file under `data/`.

> ⚠️ **Switching `dbDriver` points the app at a different file/engine.** Data written under one driver is **not** visible under another until it is migrated. Flipping `dbDriver` in `backend/wordjs-config.json` alone makes your existing data look **"missing"** — nothing is lost, the app is just reading a different file (or engine). The same applies when switching between SQLite and PostgreSQL.

To actually **move your data between drivers/engines** (e.g. `sqlite-legacy` → `sqlite-native`, or SQLite → Postgres), use the admin **DB Migration** route described in [§1.4](#14-live-data-migration) — it streams the data into the target driver and, for a file-based SQLite target, moves a fully-written temporary file onto the new driver's filename (see the note in [§1.4](#14-live-data-migration)). Do **not** edit `dbDriver` by hand for this.

> **`npm run migrate` is a different thing — it does *not* switch drivers.** The root `npm run migrate` (`node setup/index.js --migrate` → `backend/scripts/migrate.js`) applies any pending **schema** migrations to the *currently configured* database and exits, without copying data between drivers or starting the server. It is idempotent and useful in deploy pipelines (apply migrations before rolling out new code); the same schema migrations also run automatically at boot.

> **Run modes:** both run modes (split services and the single-process monolith) use the **same configured database** — the run mode does not change which driver or file is used; only `dbDriver` (and `dbPath`) in `wordjs-config.json` does.

## 2. Schema Overview

The database uses a WordPress-like schema to ensure familiarity and flexibility. The schema is automatically adapted for the active driver (e.g., using `SERIAL` for Postgres vs `AUTOINCREMENT` for SQLite).

```mermaid
erDiagram
    users ||--o{ posts : writes
    users ||--o{ comments : writes
    posts ||--o{ comments : has
    posts ||--o{ post_meta : has
    users ||--o{ user_meta : has
    posts }|--|{ term_relationships : belongs_to
    term_relationships }|--|| term_taxonomy : links
    term_taxonomy ||--|| terms : defines
```

---

## 2. Core Tables

> **Naming note:** the tables below follow WordPress conventions, but the **actual** schema (`initializeSchema` in `backend/src/config/database.ts`) uses lowercase, snake_case identifiers: the primary keys are `id` (not `ID`), meta/relationship tables are `post_meta` / `user_meta` / `comment_meta` / `term_relationships` (with underscores), the comment columns are `comment_id` / `comment_post_id`, and the post author column is **`author_id`** (not `post_author`) — which is why the index in §2.9 reads `posts (author_id)`. Column names in the tables below are illustrative of the WordPress mapping.

### 2.1 `users`
Stores user authentication and profile data.

| Column                | Type       | Description         |
| :-------------------- | :--------- | :------------------ |
| `ID`                  | INTEGER PK | Unique User ID      |
| `user_login`          | VARCHAR    | Username (unique)   |
| `user_pass`           | VARCHAR    | Bcrypt hash         |
| `user_nicename`       | VARCHAR    | URL-friendly name   |
| `user_email`          | VARCHAR    | Email address       |
| `user_registered`     | DATETIME   | Registration date   |
| `user_activation_key` | VARCHAR    | For password resets |
| `display_name`        | VARCHAR    | Public display name |

### 2.2 `user_meta`
Key-value store for user preferences and extra fields.

| Column       | Type       | Description |
| :----------- | :--------- | :---------- |
| `umeta_id`   | INTEGER PK |             |
| `user_id`    | INTEGER FK |             |
| `meta_key`   | VARCHAR    |             |
| `meta_value` | LONGTEXT   |             |

### 2.3 `posts`
The central content table. Used for posts, pages, attachments, revisions, and menu items.

| Column           | Type       | Description                     |
| :--------------- | :--------- | :------------------------------ |
| `ID`             | INTEGER PK |                                 |
| `post_author`    | INTEGER FK |                                 |
| `post_date`      | DATETIME   | Published date                  |
| `post_content`   | LONGTEXT   | The main HTML body (classic content; a block-built page's tree lives in the `_puck_data` post meta) |
| `post_title`     | TEXT       |                                 |
| `post_status`    | VARCHAR    | `publish`, `draft`, `trash`     |
| `comment_status` | VARCHAR    | `open`, `closed`                |
| `post_name`      | VARCHAR    | URL Slug (unique per type)      |
| `post_modified`  | DATETIME   | Last edit                       |
| `post_parent`    | INTEGER    | For hierarchy (pages)           |
| `guid`           | VARCHAR    | Global Unique Identifier        |
| `menu_order`     | INTEGER    | Sorting order                   |
| `post_type`      | VARCHAR    | `post`, `page`, `attachment`... |
| `post_mime_type` | VARCHAR    | For attachments                 |

### 2.4 `post_meta`
Extensible fields for posts (e.g. template settings, SEO data).

| Column       | Type       | Description |
| :----------- | :--------- | :---------- |
| `meta_id`    | INTEGER PK |             |
| `post_id`    | INTEGER FK |             |
| `meta_key`   | VARCHAR    |             |
| `meta_value` | LONGTEXT   |             |

### 2.5 `options`
Global system settings.

| Column         | Type       | Description                 |
| :------------- | :--------- | :-------------------------- |
| `option_id`    | INTEGER PK |                             |
| `option_name`  | VARCHAR    | Unique key (e.g. `siteurl`) |
| `option_value` | LONGTEXT   | Auto-serialized JSON        |
| `autoload`     | VARCHAR    | `yes`/`no` to load on boot  |

> Option writes are an **atomic** `INSERT … ON CONFLICT (option_name) DO UPDATE` upsert (`updateOption`), and `DO NOTHING` for insert-if-absent (`addOption`) — replacing the old SELECT-then-INSERT/UPDATE that raced the `idx_options_name` UNIQUE index (two concurrent first-writes both INSERTed, and the loser hit a raw violation). Supported by SQLite ≥3.24 and Postgres natively; the legacy sql.js driver strips `RETURNING` but honors `ON CONFLICT`; and the MySQL driver rewrites `ON CONFLICT … DO UPDATE` to `INSERT … ON DUPLICATE KEY UPDATE`.

### 2.6 `terms` & `term_taxonomy`
Manages Categories and Tags.

**`terms`**
| Column    | Type       | Description   |
| :-------- | :--------- | :------------ |
| `term_id` | INTEGER PK |               |
| `name`    | VARCHAR    | Display name  |
| `slug`    | VARCHAR    | URL safe slug |

**`term_taxonomy`**
| Column             | Type       | Description              |
| :----------------- | :--------- | :----------------------- |
| `term_taxonomy_id` | INTEGER PK |                          |
| `term_id`          | INTEGER FK |                          |
| `taxonomy`         | VARCHAR    | `category` or `post_tag` |
| `description`      | LONGTEXT   |                          |
| `parent`           | INTEGER    | For hierarchy            |
| `count`            | INTEGER    | Number of **published** posts in this term — see below |

> **`count` is maintained by every transition, not just by `setTerms`.** It is a materialised counter that two public surfaces read as truth: `Term.findAll`/`Term.count` filter on `tt.count > 0` when `hide_empty` is set, and `Term.toJSON` publishes it. Its only writer used to be `Post.setTerms`, so the operations that change it most never recomputed it — a single click on *Move to Trash* left the counter inflated (`Post.update({status:'trash'})` carries no `categories` key), a `?force=true` delete removed the `term_relationships` rows with raw SQL and left `count = 1` against **zero** rows, and the drift ran the other way too: publishing a draft that already had a category never moved the counter off `0`, so `hide_empty` **hid a category that had content**. The deviation was permanent — no repair pass, no `deleted_post` listener. Counts are now recomputed as a consequence of the transition: the affected `term_taxonomy_id`s are read **before** the relationship rows are deleted and recounted after, inside the same transaction, and a `post_status` crossing the publish boundary triggers a scoped recount (`Post._recountTermsForPost` → `updateTermCounts(taxonomy, ids)`, scoped to the rows the write touched rather than rescanning the whole taxonomy).

### 2.7 `comments`
User feedback on content.

| Column                 | Type       | Description      |
| :--------------------- | :--------- | :--------------- |
| `comment_ID`           | INTEGER PK |                  |
| `comment_post_ID`      | INTEGER FK |                  |
| `comment_author`       | TINYTEXT   | Name             |
| `comment_author_email` | VARCHAR    |                  |
| `comment_content`      | TEXT       |                  |
| `comment_approved`     | VARCHAR    | `1`, `0`, `spam` |
| `comment_type`         | VARCHAR    | `comment`        |
| `user_id`              | INTEGER    | If registered    |

### 2.8 `wordjs_analytics`
High-volume event logging table for the internal analytics engine. Its schema lives on the `Analytics` model (`backend/src/models/Analytics.ts`, `Analytics.init()`) rather than inline in `initializeSchema`, deliberately kept out of the core schema to avoid a boot race. It is, however, created during **`initializeDatabase()`** (`config/database.ts`) — right after the core schema and migrations run, `initializeDatabase()` calls `Analytics.init()` (`CREATE TABLE IF NOT EXISTS`, with an index on `created_at`). This guarantees the table exists after a **fresh install**: the install wizard's setup flow calls `initializeDatabase()` but never the app's `initialize()`, so without this a fresh deploy would hit `no such table: wordjs_analytics` on every request.

| Column       | Type        | Description                                          |
| :----------- | :---------- | :--------------------------------------------------- |
| `id`         | UUID PK     | Unique Event ID                                      |
| `type`       | VARCHAR     | `page_view`, `api_call`, `engagement`                |
| `resource`   | VARCHAR     | The URL or resource accessed                         |
| `visitor_ip` | VARCHAR     | Privacy-preserving: daily-salted SHA-256 hash of the IP (or `0.0.0.0`), never the raw IP |
| `user_id`    | VARCHAR     | User uuid (if logged in) or NULL                     |
| `metadata`   | TEXT (JSON) | Extra payload                                        |
| `created_at` | DATETIME    | Timestamp                                            |

> Other core tables created by `initializeSchema` but not detailed above include `comment_meta`, `links`, and `notifications`.

---

---

## 2.9 Indexes

On boot, the schema (`backend/src/config/database.ts`) creates a set of indexes with `CREATE INDEX IF NOT EXISTS` (supported by both SQLite and Postgres) on hot columns. These speed up meta lookups, listing queries, slug resolution, and comment/option access:

| Index                          | Table / Columns                            |
| :----------------------------- | :----------------------------------------- |
| `idx_post_meta_post_id`        | `post_meta (post_id)`                      |
| `idx_post_meta_post_id_key`    | `post_meta (post_id, meta_key)`            |
| `idx_post_meta_key_post`       | `post_meta (meta_key, post_id)` — key-first, for meta lookups BY KEY across posts |
| `idx_user_meta_user_id`        | `user_meta (user_id)`                      |
| `idx_user_meta_user_id_key`    | `user_meta (user_id, meta_key)`            |
| `idx_term_rel_object_id`       | `term_relationships (object_id)`           |
| `idx_term_rel_tt_id`           | `term_relationships (term_taxonomy_id)`    |
| `idx_term_taxonomy_taxonomy`   | `term_taxonomy (taxonomy)`                 |
| `idx_term_taxonomy_term_tax`   | `term_taxonomy (term_id, taxonomy)`        |
| `idx_terms_slug`               | `terms (slug)` — category/tag archive lookups |
| `idx_posts_status_type`        | `posts (post_status, post_type)`           |
| `idx_posts_type_status_date`   | `posts (post_type, post_status, post_date)` — the hottest public listing, incl. the `ORDER BY post_date` |
| `idx_posts_name`               | `posts (post_name)`                        |
| `idx_posts_parent`             | `posts (post_parent)`                      |
| `idx_posts_author`             | `posts (author_id)`                        |
| `idx_comments_post_approved`   | `comments (comment_post_id, comment_approved)` |
| `idx_options_name` (UNIQUE)    | `options (option_name)`                    |
| `idx_options_autoload`         | `options (autoload)`                       |
| `idx_notifications_user_read_created` | `notifications (user_id, is_read, created_at)` |
| `idx_users_login` (UNIQUE)     | `users (user_login)`                       |
| `idx_users_email` (UNIQUE)     | `users (LOWER(user_email))` — case-insensitive backstop |
| `idx_posts_name_type` (UNIQUE) | `posts (post_name, post_type)` — partial: `WHERE post_name <> ''` |

> `options.option_name` uniqueness is enforced by the **`idx_options_name` UNIQUE index** (created alongside the others), not by an inline column constraint.

> **UNIQUE constraints (TOCTOU-closing).** `users (user_login)`, `users (LOWER(user_email))`, and `posts (post_name, post_type)` [partial, `WHERE post_name <> ''` — real slugs only] now carry UNIQUE indexes that close the check-then-insert race for duplicate logins/emails/slugs. The non-unique `idx_posts_name` (above) coexists with the new partial-unique `idx_posts_name_type` — both are real. **Fresh installs** create all three in `initializeSchema`. **Existing installs** get them via schema migration `0001_unique_constraints_users_posts`, which is **defensive**: it first detects and logs any duplicate groups, then attempts each `CREATE UNIQUE INDEX` in its own `try/catch`, and **never throws** — a residual duplicate logs a warning and boot continues (the migration is still recorded as applied so it doesn't retry every boot). This is a deliberate exception: the schema-migration runner is otherwise **fail-closed** (a failing migration aborts boot to avoid a half-migrated schema).

> **Platform tables (migrations `0002`–`0005`).** Later schema migrations create the tables backing the scoped API tokens and outgoing HMAC-signed webhooks: `0002_create_api_tokens` (`api_tokens` + UNIQUE `idx_api_tokens_hash` and `idx_api_tokens_user`), `0003_create_webhooks` (`webhooks` + `idx_webhooks_active` and `idx_webhooks_user`), and `0004_create_webhook_deliveries` (`webhook_deliveries` + `idx_wh_deliveries_due` and `idx_wh_deliveries_webhook`), with `0005_webhook_secret_plaintext` renaming `webhooks.secret_enc` → `secret` (the signing secret is now stored in plaintext — encrypting it under the rotatable app secret dead-lettered every delivery on rotation). Unlike the defensive `0001`, `0002`–`0004` run under the normal **fail-closed** migration policy; `0005` swallows a failed `RENAME COLUMN` as a non-fatal no-op.

> **Migrations `0006`–`0008`.** `0006_professional_mailbox_flag` converts the corporate-mailbox grant from "derived from the account's email domain" into an explicit `user_meta.professional_mailbox` flag, auto-granting it **only** to accounts that could already set it themselves (administrators and holders of `edit_users`) and recording every other on-domain account in the `professional_mailbox_migration_pending` option for the operator to re-enable by hand. Like `0001` it **never throws** (the un-granted state is the deny direction). `0007_create_form_submissions` creates `form_submissions` + `idx_form_submissions_name` for the public form block. `0008_posts_fts5` builds the SQLite full-text index — see [§2.10](#210-full-text-search).

> **Migrations `0009`–`0014`.** `0009_create_audit_log` creates the append-only `audit_log` (+ `idx_audit_log_actor`) that `core/audit.recordAudit` writes and the admin `GET /audit` reads. `0010_posts_fts_pg_mysql` gives Postgres and MySQL their own inverted index — see [§2.10](#210-full-text-search). `0011_posts_multilingual` adds the two NULLABLE columns `posts.post_language` / `posts.translation_group` (+ `idx_posts_translation_group`); a monolingual site keeps NULL/NULL and is unchanged. `0012_create_collab` creates `collab_docs` + `collab_ops` for real-time editing **session** state (the canonical content stays in `_puck_data`), and `0013_collab_epoch_and_liveness` adds `collab_docs.truncated` / `base_hash` / `updated_ms`, the `collab_members` liveness table, and an epoch-bearing replacement for the dot UNIQUE index. `0014_create_content_outbox` creates the durable `content_outbox` the transactional content path writes its events into, plus `webhook_deliveries.source_event_id` and a UNIQUE index on `(webhook_id, source_event_id, event)` so a retried event is not fanned out twice.

### Batched Meta Loading (N+1 avoidance)

Post listing (`Post.findAllWithRelations`) **batch-loads** post meta for the whole result set in a single query rather than issuing one query per post, eliminating the previous N+1 pattern on listing pages.

## 2.10 Full-Text Search

Post search used to be `post_title LIKE '%q%' OR post_content LIKE '%q%'` — a full table scan reading every post body, run twice per request (rows + `COUNT`). Two migrations replace that with a real inverted index on each supported engine: **`0008_posts_fts5`** for SQLite and **`0010_posts_fts_pg_mysql`** for Postgres and MySQL.

`Post` resolves which engine backs *this* install once per process (`_resolveSearchEngine`) and `_searchClauses` returns a filter plus a relevance order for it, so callers never branch on the driver and the more-relevant document comes first everywhere.

### SQLite — FTS5 (`0008_posts_fts5`)

*   **`posts_fts`** is a **virtual table**, created `USING fts5(post_title, post_content, content='posts', content_rowid='id', tokenize='unicode61')`. Because it is an **external-content** table it stores only the inverted terms and reads the columns back from `posts` — post bodies are **not** duplicated on disk.
*   Three triggers keep it in sync: `posts_fts_ai` (AFTER INSERT), `posts_fts_ad` (AFTER DELETE) and `posts_fts_au` (AFTER UPDATE); the delete/update triggers write the `'delete'` command row carrying the OLD values, which is how an external-content index retracts a document. Existing rows are backfilled once with `INSERT INTO posts_fts(posts_fts) VALUES('rebuild')`.
*   **Engine-scoped.** The migration returns early on Postgres (`ctx.isPostgres`) and on MySQL (`ctx.driverName === 'mysql'`), which get their own index from `0010`. This is what the `driverName` field on the migration context exists for.
*   **Degrades, never fails.** The `CREATE VIRTUAL TABLE` is wrapped in a `try/catch`, so a SQLite build with FTS5 compiled out logs a warning and leaves the database untouched. At query time `Post` probes `sqlite_master` for `posts_fts`: present → `id IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)` ordered by `bm25()` ascending; absent → the original `LIKE` scan, byte-identical to before. User text is never passed to FTS5 raw — each token is stripped of FTS5 syntax and re-quoted as a literal phrase (the last one gets a `*` for type-ahead), and if nothing usable survives the caller falls back to `LIKE`.

### Postgres and MySQL (`0010_posts_fts_pg_mysql`)

Both index the same `post_title` + `post_content` that FTS5 covers, **plus `post_excerpt`**, and both are idempotent on a fresh or an existing database.

*   **Postgres** gets a `STORED` generated column `posts.search_vector` (`to_tsvector('english', title || content || excerpt)`, with the regconfig as a literal so the expression is `IMMUTABLE`) and a **GIN** index `idx_posts_search_vector`. Postgres recomputes the vector on every write, so there is no trigger to maintain. Queries filter on `search_vector @@ plainto_tsquery('english', ?)` and order by `ts_rank(...)` — `plainto_tsquery` parses the input as plain text, so a stray operator is text rather than a syntax error thrown at the visitor.
*   **MySQL/InnoDB** gets a `FULLTEXT` index `ftidx_posts_search` over the same three columns. There is no `ADD FULLTEXT … IF NOT EXISTS`, so the migration probes `information_schema.statistics` first and skips when the index is already there. Queries use `MATCH(…) AGAINST(? IN NATURAL LANGUAGE MODE)` for both the filter and the order.
*   **The `LIKE` scan is still the floor**, and it is reached for: `sqlite-legacy` (sql.js has no FTS5), a SQLite build without FTS5, an install whose migration has not run, and — on MySQL only — a query with no token as long as `innodb_ft_min_token_size` (default 3), which `NATURAL LANGUAGE MODE` would match nothing for.

---

## 3. Extending the Schema (Plugins)

Plugins should generally stick to `post_meta` or `user_meta` for storing extra data. For high-performance needs they can create their **own** tables.

Plugins do this through the permission-checked `wordjs` capability bridge (`wordjs.db.createTable(...)` / `wordjs.db.run(...)`), **not** by reaching into the raw driver. Plugin SQL is **table-scoped by prefix (default-deny)**: every table a query touches must be one the plugin owns under its `wjp_<slug>_` prefix (`wordjs.db.tablePrefix`), so core tables (`users`, `user_meta`, `options`, `roles`, `sessions`, …) and other plugins' tables are unreachable, and `createTable` refuses non-prefixed names. DDL is additionally bounded by a positive **object-class allowlist**: a plugin may only create/alter/drop its own **TABLE, INDEX, VIEW or TRIGGER** — those are exactly the four classes the prefix scoping can actually check, so every other class (`SCHEMA`, `DATABASE`, `ROLE`, `FUNCTION`, `EXTENSION`, …) is denied outright rather than passing vacuously for naming no table. `ALTER … RENAME TO` has its **destination** prefix-checked too, so an owned table can't be renamed on top of a core one.

Two rules exist specifically because a statement can reach data while presenting **no table token** for the prefix allowlist to check — a check that passes vacuously is the failure mode this guard has to design against:

- **Postgres' xml-export family is denied textually** (`query_to_xml`, `table_to_xml`, `schema_to_xml`, `database_to_xml`, `cursor_to_xml`, and their `…_xmlschema` / `…_xml_and_xmlschema` variants). They take a **SQL query as a string argument** and execute it, which breaks the guard's load-bearing assumption that a blanked string literal can never be SQL structure — `SELECT query_to_xml('select user_pass from users', …)` names no table at all, so both the prefix allowlist and the core-table denylist would pass it.
- **A data-modifying CTE is classified as a write.** `with` is on the *read* verb list, so `WITH t AS (INSERT INTO …) SELECT 1` used to demand only `database:read` — and on Postgres the CTE executes whether or not the outer query reads its output, so a plugin whose write grant an admin had **revoked** could still mutate. It now requires `database:write`, decided on the lexed token stream rather than a second raw-string regex.

Two practical consequences of the guard: **`RETURNING` is rejected** in plugin SQL (use a separate `SELECT` — the guard blocks `RETURNING` as a scalar-exfil channel), and the bridge exposes only `get`/`all`/`run`/`batch`/`createTable`/`getType` (plus the `tablePrefix` string) — **no `transaction()`**, so multi-statement plugin writes are not atomic.

`db.batch([[sql, params], …])` runs several statements in **one** host round-trip. It is purely a transport optimisation: every statement goes through the same permission check and the same SQL guard as its single-statement counterpart, and the whole array is validated **before** any of it runs, so an illegal statement in the middle cannot half-apply the legal ones ahead of it. It is capped at **200 statements**, rejects DDL (`CREATE`/`ALTER`/`DROP` must stay on `db.run`/`db.createTable`, which record table ownership and issue the `GRANT`), and is explicitly **not atomic** — on Postgres/MySQL each statement runs on the plugin's own role connection, so a failure leaves the preceding statements applied, exactly as a sequential loop would.

The full rules, the driver-agnostic type aliases (`INT_PK`, `DATETIME`, …), and examples live in **[plugin-database.md](./plugin-database.md)**.

## 4. Adding a New Database Driver

Multi-DB support is designed to be a contained, **verifiable** unit. The `mysql` driver (`backend/src/drivers/mysql.ts`) is the most recent worked example — a full SQLite→MySQL dialect translator; use it as a reference. To add a backend (e.g. Microsoft SQL Server):

1. **Implement the interface.** Create `backend/src/drivers/<name>.ts` exporting a singleton that extends `DatabaseDriverInterface` (`interface.ts`) and implements all seven methods. `run()` must return `{ lastID, changes }`; `get`/`all` must return a row / array of rows. If the engine uses non-`?` placeholders, normalize SQLite-style `?` internally (see `postgres.ts`'s `normalizeSql`, or `mysql.ts`'s fuller `translateSql`) so callers keep writing SQLite-style SQL.
2. **Register it in the DB Manager.** Add the `<name>` branch in `loadDriver` (`config/database.ts`) so it's loaded as the async driver (see the `mysql`/`mariadb` branch), extend `getDbType()` (the `isPostgres`/`isMySQL`/`isSQLite` flags), and extend the dialect handling (`createPluginTable` type map, `clearDatabase` truncate syntax) if the new engine needs different DDL.
3. **Add a conformance block.** Add a `test(...)` block in `backend/src/tests/driver-conformance.test.ts` with the engine's dialect descriptor (placeholder style, auto-increment PK, INSERT-returns-id mechanism). The shared `runContract` then validates the whole contract — skipping gracefully when the backend isn't reachable locally, but **failing hard** under `WORDJS_CI_DB=1` so CI can't go green on an un-exercised driver.

### Dialect Handling Today

Dialect differences are confined to a few spots:

*   **Auto-increment PK:** `SERIAL PRIMARY KEY` (Postgres) vs `INTEGER PRIMARY KEY AUTOINCREMENT` (SQLite, rewritten to `AUTO_INCREMENT` by the MySQL driver), chosen in `initializeSchema` and `createPluginTable`.
*   **Placeholders:** SQLite-style `?` everywhere; the Postgres driver rewrites to `$1, $2` (single source of truth — the proxy passes SQL through untouched, so there's no double-normalization). MySQL uses `?` natively.
*   **`RETURNING`:** auto-injected by the Postgres driver on `INSERT`; the MySQL driver reports `insertId` instead; stripped by the legacy WASM driver.
*   **`TEXT` / defaults / upserts (MySQL):** the MySQL driver maps `TEXT`→`LONGTEXT` (→`VARCHAR(255)` only for a column the DDL makes part of a key) with parenthesised expression defaults, `INSERT OR IGNORE`/`ON CONFLICT`→`INSERT IGNORE`/`ON DUPLICATE KEY UPDATE`, and runs `sql_mode=ANSI_QUOTES,STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION` — so `"col"` is an identifier and an overlong value errors instead of truncating.
*   **Clearing tables:** `TRUNCATE … RESTART IDENTITY CASCADE` (Postgres) vs `DELETE FROM …` plus a `sqlite_sequence` reset (SQLite), in `clearDatabase`.
