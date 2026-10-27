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

A **conformance test** (`backend/src/tests/driver-conformance.test.ts`) runs the *same* contract (create → insert → get → all → update → delete → drop) against the drivers it carries a dialect descriptor block for, asserting `run()` returns a truthy `lastID` and correct `changes`, that params bind, and that mutations persist. Today that is **`sqlite-native`, `postgres`, and `mysql`** (adding a driver = add a descriptor block). Drivers whose backend isn't reachable **skip gracefully locally**: if `better-sqlite3` can't load it's treated as the sql.js-fallback case, and if no Postgres/MySQL is reachable that block is skipped (connect timeout: 3 s for Postgres, 5 s for MySQL; the MySQL block is pointed explicitly at `MYSQL_HOST`/`MYSQL_PORT`/`MYSQL_USER`/`MYSQL_PASSWORD`/`MYSQL_DB`, defaulting to `127.0.0.1:3306`, `root`/`password`, db `wordjs`, because `config.db`'s port default is the Postgres 5432). **In CI this inverts.** When `WORDJS_CI_DB=1` the service containers are wired precisely so the driver *is* exercised, so `skipOrFail()` turns an unreachable or unloadable Postgres/MySQL into a hard **failure** rather than a silent green — the conformance blocks cannot quietly no-op. The legacy sync `sqlite-legacy` driver is intentionally out of scope (the suite validates the async interface implementers).

#### 1.2.1 Atomic `transaction(fn)`

`transaction(fn)` is part of the driver contract and is genuinely **atomic** on every async driver. The callback receives a `tx` exposing `get`/`all`/`run`/`exec` with the **same SQLite-style SQL shape** (placeholders, `RETURNING` auto-injection, `{ lastID, changes }`) inside the transaction as outside it, so callers write identical SQL either way.

*   **PostgreSQL** (`postgres.ts`) pins **one** pooled client for the whole unit of work — `BEGIN` → `fn(tx)` → `COMMIT`, `ROLLBACK` on throw, and the client is **always** released in a `finally`. This matters because the per-statement methods each grab a *different* pooled connection, so a multi-statement unit would otherwise not share a transaction.
*   **MySQL / MariaDB** (`mysql.ts`) pins **one** pooled `mysql2` connection for the unit of work — `BEGIN` → `fn(tx)` → `COMMIT`, `ROLLBACK` on throw, connection released in a `finally` — for the same reason as Postgres (the per-statement methods each grab a different pooled connection).
*   **SQLite (Native)** (`sqlite-native-async.ts`) wraps `BEGIN`/`COMMIT`/`ROLLBACK` on its single shared `better-sqlite3` handle.
*   **SQLite (Legacy)** (`sqlite-legacy.ts`) suppresses its per-write disk flush while a transaction is open and saves to disk **once** after `COMMIT`. There is no pre-`BEGIN` snapshot: sql.js *is* SQLite, so its own `ROLLBACK` restores the in-memory image, and because the per-write `save()` stayed suppressed the file on disk still holds the last committed image throughout. Only when `ROLLBACK` itself throws does the driver read that file back into a fresh handle. Either way a failed tx leaves both memory and disk at the prior committed state, without paying a full database copy per transaction.

**SQLite transaction serialization & re-entrancy.** Both SQLite drivers serialize `transaction()` through a per-driver promise-chain mutex (`_txChain` / module-level `txChain`): because the callback is async and may `await` between `BEGIN` and `COMMIT`, two overlapping callers could otherwise interleave their `BEGIN`/`COMMIT` on the single shared connection (SQLite has no nested `BEGIN`). Each call waits for the previous to fully settle before its own `BEGIN` runs. A **re-entrant** `transaction()` — one invoked from inside another's callback — fails fast by throwing `nested transaction() is not supported` rather than deadlocking the queue, and `_inTransaction` is reset in a `finally` on **both** commit and rollback.

**Clean unique-constraint errors.** `User.create` and `User.update` translate a cross-driver UNIQUE-constraint violation (on `idx_users_login` / `idx_users_email`) into a clean application error — `Username or email already exists` on create, `Email already in use` on update — instead of surfacing a raw driver constraint error / 500. The detector `isUniqueViolation` (`core/db-errors.ts`) handles SQLite `SQLITE_CONSTRAINT_UNIQUE` / `SQLITE_CONSTRAINT_PRIMARYKEY`, Postgres SQLSTATE `23505` and MySQL `ER_DUP_ENTRY` (errno 1062), with a `UNIQUE constraint` / `duplicate key` / `Duplicate entry` message match as the last resort. Emails are canonicalized (full-Unicode lowercase + NFC via `normalizeEmail`) before store/lookup, so the ASCII-only SQLite `LOWER()` backstop holds.

> **Roles cache (DATA-05).** `getRoles()` serves from an in-memory cache that, once older than `ROLES_CACHE_TTL_MS` (**10s** in code), kicks a non-blocking, single-flight background re-read to bound staleness and self-heal a missed pub/sub invalidation. A monotonic `_localWriteEpoch` is captured before the background DB read and the result is applied **only** if the epoch is unchanged, so a stale read cannot clobber a just-written local change. Role edits reach the other nodes live through the Redis `wordjs:option-changed` pub/sub (`core/coherence.ts`). A node that misses a publish picks the change up at its next roles-cache refresh, which reads through the option cache, whose in-process entries live at most **30s** when Redis is configured. Make role and capability changes while the writing node can reach Redis: a change saved while it cannot is published to no one, and with the object cache enabled the shared cache keeps the previous value until its entry expires, so save the change again once Redis is back (see [multi-node.md → Known limitations](multi-node.md#known-limitations)).

### 1.3 Automatic Fallback Mechanics

The DB Manager (`loadDriver` in `config/database.ts`) falls back to `sqlite-legacy` when loading a driver fails, provided the failed name isn't already `sqlite-legacy` **and** either the name starts with `sqlite` or it came from the config file rather than an explicit override:

*   A failed **SQLite** driver (default path, or any `sqlite*` name) → silently falls back to pure-JS `sqlite-legacy` (same file format).
*   A failed **non-SQLite** name passed as an explicit **override** — `loadDriver('postgres')`, the path re-init, tests and the migration tool take — is **not** downgraded to SQLite; the error propagates. The guard keys on that override, and the boot path passes none, so a `postgres`/`mysql` named only in `wordjs-config.json` whose module fails to load (a missing `pg`/`mysql2`, say) *does* fall back and comes up on an empty local SQLite file.

#### Strict driver mode (`dbStrictDriver` / `WORDJS_DB_STRICT`)

The fallback keeps a site up, at the cost of ranked search (`sqlite-legacy` has no FTS5). An operator who would rather not serve at all than serve degraded — a fleet behind a health check, an image built by CI, a host nobody watches the admin panel of — can turn every fallback above into a **boot error**:

```json
{
  "dbDriver": "sqlite-native",
  "dbStrictDriver": true
}
```

or set **`WORDJS_DB_STRICT=1`** in the backend's environment. The environment variable wins over the file in both directions (`1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off`; any other value is reported and ignored), so a container can switch it without editing a config file on a volume. Only a JSON `true` in the file turns it on.

With strict mode on:

*   A SQLite driver that fails to load stops the boot (`init()` throws an error with code `WORDJS_DB_STRICT_DRIVER`) whose message names the driver, the load error, what the fallback would have cost, and the fix: `npm rebuild better-sqlite3` in `backend/` for `sqlite-native` (the usual cause is a Node.js upgrade or an install made with `--ignore-scripts`). Nothing is recorded as a downgrade and no admin notice is written.
*   The same applies to a non-SQLite driver named only in `wordjs-config.json` (the case above that would come up on an empty SQLite file).
*   Migration `0008_posts_fts5` fails instead of skipping when a SQLite build has no FTS5 — see [the FTS5 section](#sqlite--fts5-0008_posts_fts5).
*   An explicitly configured `sqlite-legacy` still boots: having no FTS5 is a property of the driver you chose, not a degradation of it.

Strict mode is **off by default**, including when `dbDriver` names `sqlite-native` explicitly. The install wizard and the Docker entrypoint write `"dbDriver"` into every config they create, so an explicit driver name does not tell an operator's deliberate choice apart from a default install, and failing on it would turn the documented recovery from a Node.js upgrade into a site that does not start. To recover a strict site in a hurry, boot once with `WORDJS_DB_STRICT=0`.

### 1.4 Live Data Migration

WordJS includes a **Zero Data Loss** migration tool for switching drivers without losing users or posts.

> **This is core infrastructure, not a plugin.** Database migration manages the DB lifecycle — work that must happen in the host process and cannot run in an isolated plugin. (Isolated plugins run in a separate OS process via `child_process.fork` with no host-heap access and a scoped bridge, so they have neither the DB handle nor the privileges this needs.) It was formerly the `db-migration` *plugin*; it now lives in core at `backend/src/core/db-admin/` and is wired in at boot.

1. Go to the **DB Migration** entry in the admin sidebar (route `/admin/db-migration`). It is a native admin route, always available — it is not tied to plugin activation.
2. Select your target engine (e.g., switch from SQLite to Postgres).
3. The system will:
    - **Stream** data per table to the new driver (preventing RAM spikes).
    - **Reconcile** each table's row count against the source immediately after copying it. A mismatch **throws on the first offending table** and aborts the migration — the original database is left untouched. (This is a fail-closed check *after* each copy, not a pre-flight scan; it used to be a mere warning that still switched the live DB.)
    - **Build the target's own indexes**: the search index of that engine (FTS5, a tsvector, or a FULLTEXT index) and the unique keys of [§2.10](#210-full-text-search) / migration `0020`, by running the engine-specific schema migrations again on the target. The source's SQLite FTS5 tables are an index, not data, and are not copied; generated columns (Postgres `search_vector`, the MySQL key columns) are recomputed by the target.
    - **Move every Postgres sequence** past the highest id copied, so the first post created afterwards gets a new id.
    - **Swap** the data file into place and update the configuration. For Postgres/MySQL the connection is written where the next boot reads it (the nested `db` block **and** the flat `dbPassword`, which outranks it), and WordJS **opens that exact connection before restarting**: settings that would not connect are put back as they were and the site keeps running on its current database, with the reason on screen.
    - **Restart** the backend automatically to apply changes.

> **Postgres target, ordinary role.** The copy runs as the WordJS role, not a superuser. Switching off foreign-key triggers (`session_replication_role`) is attempted inside a savepoint and simply skipped when the role may not do it; tables are copied after the tables they reference instead.

> **Note:** For a file-based SQLite target (e.g. Legacy -> Native) the copy goes to a temporary file which is then moved onto the real filename (`fs.renameSync`) — so a half-written database never becomes the live one. If that move fails because the target file is locked, the migration does **not** fail: it keeps the temporary file as the new active database and points the config at it, so no data is lost even though the filename ends up non-standard.

> **MySQL/MariaDB is now a supported migration target.** The DB-Admin migration tool's `availableDrivers` are `sqlite-legacy`, `sqlite-native`, `postgres`, and `mysql` — you can migrate existing data *into* MySQL/MariaDB from the admin UI just like Postgres (it is also a first-class **runtime** driver, §1.1). The tool recreates the non-core schema on the target, then performs an atomic, fail-closed row copy (`SET FOREIGN_KEY_CHECKS` off during the copy, `TEXT`→`LONGTEXT` for long-content columns via the target CREATE).

The backing API is mounted at `/api/v1/db-migration` (guarded by `authenticate` + the `manage_options` permission). Starting a migration (`POST /migrate`) additionally needs an interactive session started at the main address: it copies every table, credentials included, to the server you name and then runs the site on it, so an API token and a session from a secondary address are refused. Deleting a leftover database file after a migration (`POST /cleanup`) takes the same gate, and never deletes a file of the database the site is running on: the configured `dbPath` with its `-wal`, `-shm` and `-journal` is refused (`409`) whatever spelling, symlink or junction names it, and so is a migration whose SQLite target file is that database (a `dbPath` pinned to the other driver's default name).

### 1.5 Backups & Retention

Full-site backups (logical DB export + a physical DB snapshot for SQLite + the `uploads/`, `plugins/`, `themes/` content roots) are produced by `backend/src/core/backup.ts` (`createBackup()`) and stored **on-host** under `backend/backups/`. An **optional off-host S3 offload** (`backend/src/core/s3-offload.ts`) runs right after: it is config-gated on an `s3` block in `wordjs-config.json` or the `WORDJS_S3_*` / `AWS_*` env vars, and a partial config (a bucket with no keys) counts as *not configured* rather than a half-attempt. The upload is a single SigV4-signed `PUT` over Node's built-in `https` — the AWS SDK is not a dependency — so an S3-compatible endpoint such as MinIO works by setting `s3.endpoint`. A failed upload never fails the backup: the local copy is kept and the outcome is reported in the result's `s3` field.

> This `s3` block offloads **backups** only. Serving the **media library** from an S3-compatible bucket or CDN is a separate feature with its own configuration (the `mediaStorage` block) — see [media-storage.md](./media-storage.md).

After every backup, retention pruning runs automatically (`pruneBackups()` in `backend/src/core/backup.ts`): only the newest **N** backups are kept and older ones are deleted, so scheduled/auto backups can no longer fill the disk unbounded. **N** comes from the `backup_retention` option (**default 7**); set it to `0` (or a negative value) to keep all backups and disable pruning.

### 1.6 Configuration

To change the driver, edit `backend/wordjs-config.json`. The flat `db*` keys (`dbDriver`, `dbHost`, `dbUser`, `dbPassword`, `dbName`, `dbPort`, `dbSsl`, `dbSslCa`, `dbSslRejectUnauthorized`, `dbPath`) and a nested `db: { … }` object are both accepted; the config layer normalizes them into a single `db` connection object (`backend/src/config/app.ts`).

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
>
> MySQL/MariaDB is the same with a per-plugin **login user**: creating it needs `CREATE USER`, and giving it
> its tables needs `GRANT OPTION`, which managed databases usually withhold (`GRANT ALL PRIVILEGES` alone does
> not include it). When a grant is refused the plugin falls back to the text-guard straight away — at boot
> or the moment it creates a table — and keeps working.

> **The database must be UTF8.** Create it with `CREATE DATABASE wordjs OWNER wordjs ENCODING 'UTF8'
> TEMPLATE template0;`. A `SQL_ASCII` database (what a server initialised under the `C` locale gives by
> default) stores bytes, not text: search drops every non-ASCII word and `lower()`/`upper()` work byte by
> byte. The installer's *Test connection* and the install itself refuse such a database with that
> instruction, the engine switch refuses it as a target, and Site Health warns about an existing one.

> **A dropped connection is not a crash.** When the server closes a pooled connection — a restart or
> failover of the database, pgbouncer or a firewall recycling idle connections, `pg_terminate_backend`,
> `idle_session_timeout` — the pool discards it and opens a new one on the next query; a read that lost
> its connection is retried once on a fresh one. (Before, the unhandled `'error'` event of the pool ended
> the whole process.)

**TLS to the database (`dbSsl`).** With `"dbSsl": true` the Postgres and MySQL connections use TLS and
**verify the server certificate** (chain and host name) — the same as any HTTPS client. A server whose
certificate is signed by a public CA needs nothing else. For a private CA, a managed database's own CA
or a self-signed server, point `dbSslCa` at the CA certificate:

```json
{
  "dbSsl": true,
  "dbSslCa": "./certs/db-ca.pem"
}
```

`dbSslCa` is a path to a PEM file (relative paths resolve against `backend/`) or the PEM text itself.
If verification fails, the backend logs `The database server's TLS certificate could not be verified`
at boot with these instructions and does not start. Only when you knowingly accept an encrypted but
**unauthenticated** connection, set `"dbSslRejectUnauthorized": false`; every connect then logs a
warning. Both keys also exist nested (`db.sslCa`, `db.sslRejectUnauthorized`).

The same two settings are offered everywhere a server database is configured:

- **Install wizard** — tick *Use SSL* under PostgreSQL/MySQL: paste the CA certificate (PEM) or tick
  *Skip certificate verification* (shown with a warning). *Test connection* uses them, and the install
  saves them as `db.sslCa` / `db.sslRejectUnauthorized`.
- **Admin → Database migration** — the same fields in the target-connection dialog; the migration
  connects with them and saves them with the new connection.
- **Docker / Helm** (`WORDJS_PRESEED_CONFIG=1`) — `WORDJS_DB_SSL`, `WORDJS_DB_SSL_CA` (a path inside the
  container, e.g. a mounted secret) and `WORDJS_DB_SSL_REJECT_UNAUTHORIZED` (see
  [docker/README.md](../docker/README.md)).

The wizard and the migration screen take the CA as **PEM text** only; a file path is set in
`wordjs-config.json` (or via `WORDJS_DB_SSL_CA`) on the server itself.

#### Upgrade note: database TLS is verified by default

> ⚠️ **Read this before upgrading a site with `"dbSsl": true`.** Releases up to and including 2.7.0 did
> not verify the database server's certificate. From 2.8.0 on they do, and a backend whose
> database presents a certificate signed by a CA that is **not in Node.js's built-in trust store** stops
> at boot. Most managed databases are in that case: Amazon RDS / Aurora, DigitalOcean Managed Databases,
> and Azure Database for PostgreSQL / MySQL (depending on server generation and region) sign their
> server certificates with their own or a regional CA. The boot log then reads:
>
> `The database server's TLS certificate could not be verified. … See documentation/database.md#upgrade-note-database-tls-is-verified-by-default`
>
> Before you upgrade, download your provider's CA bundle and point `dbSslCa` at it.

| Provider | CA bundle to download | Setting |
|---|---|---|
| **Amazon RDS / Aurora** (PostgreSQL, MySQL, MariaDB) | `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` (every region; region bundles are also published by AWS) | `"dbSslCa": "./certs/rds-global-bundle.pem"` |
| **DigitalOcean Managed Databases** | Control panel → your cluster → **Connection details** → **Download CA certificate** (`ca-certificate.crt`) | `"dbSslCa": "./certs/do-ca-certificate.crt"` |
| **Azure Database for PostgreSQL / MySQL** | The root CA(s) Azure's documentation lists for your server (flexible servers: *DigiCert Global Root G2* and *Microsoft RSA Root Certificate Authority 2017*; concatenate both into one PEM file during Azure's CA rotation) | `"dbSslCa": "./certs/azure-db-ca.pem"` |
| **Any other private / self-signed CA** | The CA certificate that signed the server certificate (PEM) | `"dbSslCa": "./certs/db-ca.pem"` |

Step by step (on every backend node):

```bash
mkdir -p backend/certs
curl -fsSL -o backend/certs/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

```json
{
  "dbSsl": true,
  "dbSslCa": "./certs/rds-global-bundle.pem"
}
```

- Relative paths resolve against `backend/`; the PEM text itself is accepted too. A file with several
  certificates (a bundle) is fine.
- **Docker / Helm:** mount the bundle (a Secret or ConfigMap) and set
  `WORDJS_DB_SSL_CA=/run/secrets/db-ca.pem` (with `WORDJS_DB_SSL=true`).
- **Connect by the host name the certificate names** (the endpoint your provider gives you), not by an IP
  address: the host name is verified as well. A connection through a provider's local proxy (for example
  the Cloud SQL Auth Proxy) does not use `dbSsl` at all.
- `NODE_EXTRA_CA_CERTS=/path/to/bundle.pem` in the backend's environment also works (it extends Node's
  trust store for the whole process) as long as `dbSslCa` is not set.
- **Last resort — encrypted but unauthenticated:** `"dbSslRejectUnauthorized": false` (or
  `WORDJS_DB_SSL_REJECT_UNAUTHORIZED=false`) restores the old behaviour. Every connect logs a warning;
  use it only for a provider that publishes no CA, and only while you obtain one.

**Example — SQLite (default):**
```json
{
  "dbDriver": "sqlite-native",
  "dbPath": "./data/wordjs-native.db"
}
```
> Add `"dbStrictDriver": true` (or set `WORDJS_DB_STRICT=1`) to refuse to boot rather than fall back to `sqlite-legacy` when the native driver cannot load — see [Strict driver mode](#strict-driver-mode-dbstrictdriver--wordjs_db_strict).
> Each SQLite driver defaults to its **own** file (`sqlite-native` → `data/wordjs-native.db`, `sqlite-legacy` → `data/wordjs.db`). If you set `dbPath` explicitly, point it at the file for the driver you selected. See [§1.7](#17-sqlite-drivers-use-different-files).

> **Secrets:** on boot the config layer auto-generates and persists a secure `jwtSecret` and `dbPassword` if `wordjs-config.json` already exists and the value is **missing** or is the known-insecure literal (`wordjs-default-secret-change-me` / `password`). A `jwtSecret` that is not a string is also treated as missing. On a config that has **not been installed yet** (no `installedAt` or `dbDriver`), the boot also replaces a `jwtSecret` shorter than 64 characters or one of the placeholders printed in this repository, because the install wizard keeps the secret the backend booted with. The new value is written back into the file. An installed site's secret is never rotated: if it is one of the published placeholders, the backend **refuses to start** with an error telling you to set a real one (`openssl rand -hex 64`, the same value on every node), because anyone can sign an administrator session with it. Operators should still review these.

> ⚠️ **`dbPassword` (flat) outranks `db.password` (nested).** The normalizer resolves the password as `dbPassword || db.password || 'password'` (`backend/src/config/app.ts`). A flat `dbPassword` is generated at boot only when neither form names a real password, so a password set only in the nested form is kept. The install wizard writes both (and the database under `db.name`). An install made by an earlier wizard may carry a GENERATED flat `dbPassword` that shadows its nested one, and a `db.database` key instead of `db.name` (read as the name since this version): if such a site cannot reach its database after a restart, set the flat `dbPassword` to the real password. The same precedence applies to `dbHost`/`dbPort`/`dbUser`/`dbName`/`dbSsl` over their nested twins.

### 1.7 SQLite Drivers Use Different Files

The two SQLite drivers do **not** share a data file by default — each maps to a distinct file under `backend/data/`:

| `dbDriver`        | Library                | Default data file            |
| :---------------- | :--------------------- | :--------------------------- |
| `sqlite-native`   | `better-sqlite3`       | `backend/data/wordjs-native.db` |
| `sqlite-legacy`   | `sql.js` (WASM)        | `backend/data/wordjs.db`     |

PostgreSQL (via `pg`) and MySQL / MariaDB (via `mysql2`) are **separate engines** entirely, not files under `data/`.

> ⚠️ **Switching `dbDriver` points the app at a different file/engine.** Data written under one driver is **not** visible under another until it is migrated. Flipping `dbDriver` in `backend/wordjs-config.json` alone makes your existing data look **"missing"** — nothing is lost, the app is just reading a different file (or engine). The same applies when switching between SQLite and PostgreSQL or MySQL.

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
| `post_name`      | VARCHAR    | URL slug (see below)            |
| `post_modified`  | DATETIME   | Last edit                       |
| `post_parent`    | INTEGER    | For hierarchy (pages)           |
| `guid`           | VARCHAR    | Global Unique Identifier        |
| `menu_order`     | INTEGER    | Sorting order                   |
| `post_type`      | VARCHAR    | `post`, `page`, `attachment`... |
| `post_mime_type` | VARCHAR    | For attachments                 |

**`post_name` uniqueness.** The public site resolves a bare slug without a type (`/<slug>`,
`/pages/<slug>` and `/<archive>/<slug>` all ask `GET /posts/slug/:slug`), so a slug written through
`POST`/`PUT /posts` is unique across **every publicly routed type at once**: a post cannot take a page's
`contact`, it gets `contact-2` (`Post.generateUniqueSlug`). Attachments and internal types (revisions,
menu items, any type registered `showInRest: false`) keep a namespace of their own. The two importers
keep a source site's slugs unique **per type**, as WordPress does, and re-saving an entry under the slug
it already has keeps it. Where a post and a page share a slug, the bare URL resolves to the page.

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

> Other core tables created by `initializeSchema` but not detailed above include `comment_meta`, `links`, and `notifications`. Created outside it: `schema_migrations` (one row per applied migration id, `core/schema-migrations.ts`), `wordjs_locks` (the distributed-lock leases, created on first use by `core/dist-lock.ts`), the migration-created platform tables listed under §2.9 (`api_tokens`, `webhooks`, `webhook_deliveries`, `form_submissions`, `audit_log`, `collab_*`, `content_outbox`, `agent_connections`), and on SQLite the `posts_fts` full-text index (§2.10).

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

> **Migrations `0009`–`0015`.** `0009_create_audit_log` creates the append-only `audit_log` (+ `idx_audit_log_actor`) that `core/audit.recordAudit` writes and the admin `GET /audit` reads. `0010_posts_fts_pg_mysql` gives Postgres and MySQL their own inverted index — see [§2.10](#210-full-text-search). `0011_posts_multilingual` adds the two NULLABLE columns `posts.post_language` / `posts.translation_group` (+ `idx_posts_translation_group`); a monolingual site keeps NULL/NULL and is unchanged. `0012_create_collab` creates `collab_docs` + `collab_ops` for real-time editing **session** state (the canonical content stays in `_puck_data`), and `0013_collab_epoch_and_liveness` adds `collab_docs.truncated` / `base_hash` / `updated_ms`, the `collab_members` liveness table, and an epoch-bearing replacement for the dot UNIQUE index. `0014_create_content_outbox` creates the durable `content_outbox` the transactional content path writes its events into, plus `webhook_deliveries.source_event_id` and a UNIQUE index on `(webhook_id, source_event_id, event)` so a retried event is not fanned out twice. `0015_backfill_user_nicename` fills the empty `users.user_nicename` of existing accounts with a public author slug derived from the display name (the same rule as `User.create`); it never rewrites an existing value and never throws.

> **Migration `0016`.** `0016_create_agent_connections` creates `agent_connections`, the store of [AI agent connections](./ai-agents.md) (`models/AgentConnection.ts`): the bound `user_id`, a `name`, the sha256 `token_hash` and a display `token_prefix` (the raw `wja_` token is never stored), the `requested_caps` / `granted_caps` comma lists, `status` (`pending` → `active` → `revoked`, which is terminal), who created and granted it, and `granted_at` / `last_used_at` / `expires_at` in epoch seconds. It adds the UNIQUE `idx_agent_connections_hash` on `token_hash` and `idx_agent_connections_user` on `user_id`. The table is on the core table lists, so a site export never dumps its hashes. It runs under the normal fail-closed policy.
>
> **Migration `0018`.** `0018_account_mail_provider_allowance` keeps password recovery working across the upgrade that moved account email (reset and verification links) to the built-in transport (`core/account-mail`): on a site that has no `account_mail_provider_allowed` option yet, the plugins holding the `email:provider` grant at that moment are recorded in it, so they keep carrying those links until an administrator changes it in Settings → Account email. A new site has no grants then and records nothing. Never fatal.

> **Migration `0019`.** `0019_account_capabilities_from_mailbox_flag` moves the per-account mailbox grant out of the core: every `user_meta.professional_mailbox` value is copied unchanged to `account_capability:mail_server_mailbox` (the mail plugin's declared account capability — `core/account-capabilities.ts`). The legacy rows are kept and every later write of the capability is mirrored onto them, and a legacy row that says "not granted" vetoes the copy, so a node still running the previous release (or a rollback) reads the same answer and the two can only disagree in the deny direction (`core/legacy-account-flags.ts`). Idempotent; a failure aborts boot like any other migration.

> **Migrations `0020`–`0022`.** `0020_mysql_unique_email_slug` gives MySQL/MariaDB the two uniqueness rules `0001` expresses with an expression index and a partial index elsewhere (neither exists there): STORED generated columns `users.user_email_key` (`LOWER(user_email)`) and `posts.post_slug_key` (`post_type/post_name`, NULL for an empty slug), each with a UNIQUE index (`uq_users_email`, `uq_posts_slug`), binary collation. Rows that already break a rule keep that index from being built; the migration then waits (see `0024` below); never fatal. `0021_pg_search_unaccent_simple` rebuilds the Postgres search vector with the language-neutral, accent-folding configuration of [§2.10](#210-full-text-search). `0022_pg_text_timestamp_format` (Postgres) sets the TEXT date columns that default to `CURRENT_TIMESTAMP` to a UTC `YYYY-MM-DD HH:MM:SS` default and rewrites the rows stored in Postgres's own text form (`2026-10-21 11:19:18.683525+00`), so every row reads in the same format as on the other engines. The three are engine-specific: an engine switch runs them again on the target (with `0001`, `0008` and `0010`).

> **Migrations `0023`–`0025`.** `0023_terms_unique_slug` makes a term slug unique site-wide (`uq_terms_slug`, partial on a non-empty slug; a generated key column on MySQL). `0001`, `0020` and `0023` build unique indexes, which stored duplicates can block: a migration whose index could not be built answers **deferred** — it is not recorded in `schema_migrations`, the boot goes on, and the next boot tries again — and `0024_unique_rules_recheck` stays pending the same way until every rule is enforced (it also covers installs where an earlier release recorded `0001` without its indexes). The rules, their indexes per engine and the stored duplicates are `core/unique-integrity.ts`; Site Health → *Unique logins, emails and slugs* reports them and **Admin → Duplicate records** (`/api/v1/database-integrity`) resolves them: the administrator picks the row that keeps the value, every other row gets a new unique one (a login `login-<id>`, the same mailbox as `local+dup<id>@domain`, a slug with a number), nothing is deleted, the previous login/email is kept in user meta, the change is audited, and the index is built at once. Until then `User.findByLogin` / `findByEmail` answer *nobody* when two accounts match, so no sign-in or reset ever picks one of them at random. `0025_audit_log_hash_chain` adds `audit_log.chain_seq` (UNIQUE), `prev_hash` and `row_hash` — the audit log's hash chain (`core/audit-chain.ts`, [security.md](./security.md#audit-log)).

### Batched Meta Loading (N+1 avoidance)

Post listing (`Post.findAllWithRelations`) **batch-loads** post meta for the whole result set in a single query rather than issuing one query per post, eliminating the previous N+1 pattern on listing pages.

## 2.10 Full-Text Search

Post search used to be `post_title LIKE '%q%' OR post_content LIKE '%q%'` — a full table scan reading every post body, run twice per request (rows + `COUNT`). Two migrations replace that with a real inverted index on each supported engine: **`0008_posts_fts5`** for SQLite and **`0010_posts_fts_pg_mysql`** for Postgres and MySQL.

`Post` resolves which engine backs *this* install once per process (`_resolveSearchEngine`) and `_searchClauses` returns a filter plus a relevance order for it, so callers never branch on the driver and the more-relevant document comes first everywhere.

### SQLite — FTS5 (`0008_posts_fts5`)

*   **`posts_fts`** is a **virtual table**, created `USING fts5(post_title, post_content, content='posts', content_rowid='id', tokenize='unicode61')`. Because it is an **external-content** table it stores only the inverted terms and reads the columns back from `posts` — post bodies are **not** duplicated on disk.
*   Three triggers keep it in sync: `posts_fts_ai` (AFTER INSERT), `posts_fts_ad` (AFTER DELETE) and `posts_fts_au` (AFTER UPDATE); the delete/update triggers write the `'delete'` command row carrying the OLD values, which is how an external-content index retracts a document. Existing rows are backfilled once with `INSERT INTO posts_fts(posts_fts) VALUES('rebuild')`.
*   **Engine-scoped.** The migration returns early on Postgres (`ctx.isPostgres`) and on MySQL (`ctx.driverName === 'mysql'`), which get their own index from `0010`. This is what the `driverName` field on the migration context exists for.
*   **Degrades, never fails — unless strict driver mode is on.** The `CREATE VIRTUAL TABLE` is wrapped in a `try/catch`, so a SQLite build with FTS5 compiled out logs a warning and leaves the database untouched. With [`dbStrictDriver` / `WORDJS_DB_STRICT`](#strict-driver-mode-dbstrictdriver--wordjs_db_strict) on, the migration fails instead (on any driver but an explicitly configured `sqlite-legacy`), and the failed migration stops the boot. At query time `Post` probes `sqlite_master` for `posts_fts`: present → `id IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)` ordered by `bm25()` ascending; absent → the original `LIKE` scan, byte-identical to before. User text is never passed to FTS5 raw — each token is stripped of FTS5 syntax and re-quoted as a literal phrase (the last one gets a `*` for type-ahead), and if nothing usable survives the caller falls back to `LIKE`.

### Postgres and MySQL (`0010_posts_fts_pg_mysql`)

Both index the same `post_title` + `post_content` that FTS5 covers, **plus `post_excerpt`**, and both are idempotent on a fresh or an existing database.

*   **Postgres** gets a `STORED` generated column `posts.search_vector` and a **GIN** index `idx_posts_search_vector`. Postgres recomputes the vector on every write, so there is no trigger to maintain. Since migration `0021_pg_search_unaccent_simple` the vector uses the text search configuration `wordjs_search`: `simple` (no stemming and no stopword list, whatever the site's language) plus the `unaccent` dictionary, so "cancion" finds "canción" — the behaviour of SQLite's FTS5. `unaccent` is a trusted extension the database owner can enable; without it the configuration is plain `simple`, and without the right to create a configuration the column uses the built-in `simple` (the migration says which in the log). Queries parse the search box with the same configuration — `plainto_tsquery`, which reads it as plain text so a stray operator is never a syntax error — turn its last word into a prefix (`'word':*`, type-ahead as in FTS5), and order by `ts_rank(...)`.
*   **MySQL/InnoDB** gets a `FULLTEXT` index `ftidx_posts_search` over the same three columns. There is no `ADD FULLTEXT … IF NOT EXISTS`, so the migration probes `information_schema.statistics` first and skips when the index is already there. Queries use `MATCH(…) AGAINST(? IN NATURAL LANGUAGE MODE)` for both the filter and the order.
*   **The `LIKE` scan means the same everywhere.** `%` and `_` in the search box are literal characters (they used to match everything on MySQL and `sqlite-legacy`), and both sides are lower-cased, so the user list's search ignores case on Postgres too (`core/sql-like.ts`). On sqlite-native both sides also go through `wjs_fold()` (full Unicode case folding without accents, registered on every better-sqlite3 connection by `core/sqlite-functions.ts`); sqlite-legacy keeps SQLite's ASCII-only folding — one more reason to move it to sqlite-native, which Site Health and the Network screen offer in one step.
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

## 5. Multisite Storage

A [multisite](./multisite.md) network keeps every site's data apart by giving each site **its own database** — a SQLite file, a Postgres schema or a MySQL database — plus a small store for the network itself ([design](./multisite-design.md)). Names come from `core/site-storage.ts`:

    | Engine | Site N | Network store |
    | :---- | :---- | :---- |
    | `sqlite-native` | `<data dir>/sites/<N>/wordjs-native.db` | `<data dir>/network.db` (`config.multisite.networkDbPath` overrides it) |
    | `postgres` | schema `wordjs_site_<N>` of the configured database | schema `wordjs_network` |
    | `mysql` / `mariadb` | database `<db.name>_site_<N>` | database `<db.name>_network` |

*   **Driver requirement.** `sqlite-native`, `postgres` or `mysql`/`mariadb` (`sqlite-legacy` is refused). `openSiteDatabase()` in `config/database.ts` creates the site's schema or database through the main connection (or uses one the operator created) and opens a small pool on it (`multisite.sitePoolMax`, default 4): Postgres connections start with `search_path` set to the site's schema, MySQL connections on the site's database. The driver's catalog queries read `current_schema()` / `DATABASE()`, never `public` or every schema.
*   **The network store.** Written only by `core/network.ts` and never reachable through `dbAsync`, so no site's export, backup or wipe carries it. On Postgres and MySQL every node keeps an in-memory mirror of it, re-read after a change (the `wordjs:network-changed` bus) and every 15 s. Its tables:

    | Table | Holds |
    | :---- | :---- |
    | `network_meta` | Key/value records about the network |
    | `network_sites` | One row per site: `id`, unique `slug`, `main_url`, `status` (`active` by default), `db_path`, timestamps |
    | `network_site_hosts` | Every address a site answers (`host` primary key → `site_id`, `kind`) |
    | `network_admins` | The main-site user ids listed as network administrators |
    | `network_plugin_ceilings` | Per plugin, the grant tokens any other site may grant it (no row = not offered) |
    | `network_site_quotas` | Per site, its own media storage quota |
    | `network_audit_log` | Network-level actions: who, what, which site, when |
    | `network_site_certs` | Per site address, its TLS certificate and key (served by SNI) |
    | `network_acme_challenges` | HTTP-01 answers every node serves while an order is open |

*   **Site 1** is the install that existed before multisite was enabled: its database stays at the configured `dbPath`, unchanged.
*   **Every other site** owns one directory, `<data dir>/sites/<id>/`, holding its public and private uploads, its backups and, on SQLite, its database (`wordjs-native.db`). Each site database has the full core schema and runs the same migrations; models, migrations and plugin queries keep their literal table names and simply run against the current site's database. A site whose database is not open is an error, never a fall-through to site 1's. A deleted site's schema / database / file is dropped (`dropSiteDatabase`), and its id is never reused.
