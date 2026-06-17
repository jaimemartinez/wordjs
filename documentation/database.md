# WordJS Database Documentation 🗄️

WordJS uses a **Multi-Driver** architecture, allowing you to run on anything from a cheap VPS with a file-based DB to a scalable cloud cluster with PostgreSQL.

Every backend implements a single async **driver interface** (`backend/src/drivers/interface.ts`), so the rest of the codebase never branches on which database is active. A small **DB Manager** (`backend/src/config/database.ts`) loads the configured driver, exposes the abstraction proxies (`dbAsync`, `db`), and creates the core schema.

## 1. Supported Drivers

| Driver              | Library          | Config Value    | Role                                                                       |
| :------------------ | :--------------- | :-------------- | :------------------------------------------------------------------------- |
| **SQLite (Native)** | `better-sqlite3` | `sqlite-native` | **Default & recommended.** High performance (WAL mode), single-server.     |
| **PostgreSQL**      | `pg`             | `postgres`      | **Scalable.** Best for clusters and high-concurrency environments.         |
| **SQLite (Legacy)** | `sql.js` (WASM)  | `sqlite-legacy` | **Automatic fallback only.** Pure JS, used when the native binary fails.    |

`sqlite-native` is the DB Manager default (`config.dbDriver || 'sqlite-native'`). You do not normally select `sqlite-legacy` yourself — see [Automatic Fallback](#13-automatic-fallback-mechanics) below.

### 1.1 Driver Deep Dive 🏎️

#### **SQLite (Native - Default)**
Uses the `better-sqlite3` library, the fastest SQLite driver for Node.js. This is the **canonical SQLite engine** and the DB-manager default.
*   **Performance:** Enabled with **WAL (Write-Ahead Logging)** mode by default, allowing simultaneous reads and writes.
*   **Safety:** Atomic writes prevent database corruption during power outages.
*   **Requirement:** Requires a native binary (prebuilt for most platforms; building from source needs C++ tools like `python`, `make`, `g++`).
*   **Driver file:** `backend/src/drivers/sqlite-native-async.ts` (async, implements the interface). The older sync `sqlite-native.ts` wrapper still exists for compatibility.

#### **PostgreSQL**
Uses the `pg` client (connection **Pool**) via `backend/src/drivers/postgres.ts`.
*   **External by default:** the `postgres` driver connects to an **external** Postgres server using the `db` connection object (host/port/user/password/name/ssl). It does **not** bundle or start a server on its own.
*   **SQLite-compatible SQL:** the driver's `normalizeSql()` rewrites SQLite-style `?` placeholders to `$1, $2, …`, and `run()` auto-injects `RETURNING *` on `INSERT`s so it can report `lastID`. Plugins and models keep writing SQLite-style SQL (see [plugin-database.md](./plugin-database.md)).
*   **Embedded Postgres is opt-in** — see [§1.4](#14-embedded-postgresql-opt-in).

#### **SQLite (Legacy - WASM Fallback)**
Uses a pure JavaScript WASM build of SQLite (`sql.js`) via `backend/src/drivers/sqlite-legacy.ts`.
*   **Use Case:** Restricted hosting environments (some shared hosting, strictly locked-down containers) where the native binary cannot load.
*   **Trade-off:** Slower than Native for heavy writes, and it uses the older **synchronous** driver shape (the DB Manager adapts it). It reads/writes the **same SQLite file format**, so the fallback is transparent — the same `.db` file works under either SQLite driver.

### 1.2 The Driver Interface & Conformance Suite

All async drivers extend `DatabaseDriverInterface` (`backend/src/drivers/interface.ts`), a six-method contract:

| Method                 | Purpose                                              |
| :--------------------- | :--------------------------------------------------- |
| `connect()`            | Open the connection / pool.                          |
| `get(sql, params)`     | Run a query, return a single row.                    |
| `all(sql, params)`     | Run a query, return all rows.                        |
| `run(sql, params)`     | Run INSERT/UPDATE/DELETE, return `{ lastID, changes }`. |
| `exec(sql)`            | Run a raw SQL script (e.g. DDL / migrations).        |
| `close()`              | Close the connection / pool.                         |

A **conformance test** (`backend/src/tests/driver-conformance.test.ts`) runs the *same* contract (create → insert → get → all → update → delete → drop) against every async driver, asserting `run()` returns a truthy `lastID` and correct `changes`, that params bind, and that mutations persist. Drivers whose backend isn't reachable **skip gracefully**: if `better-sqlite3` can't load it's treated as the sql.js-fallback case, and if no Postgres is reachable that block is skipped (3s connect timeout). The legacy sync `sqlite-legacy` driver is intentionally out of scope (the suite validates the async interface implementers).

### 1.3 Automatic Fallback Mechanics

The DB Manager (`loadDriver` in `config/database.ts`) falls back to `sqlite-legacy` **only** when loading any SQLite driver fails *and* the failed name isn't already `sqlite-legacy`:

*   A failed **SQLite** driver (default path, or any `sqlite*` name) → silently falls back to pure-JS `sqlite-legacy` (same file format).
*   A failed **non-SQLite** override (e.g. an explicit `postgres`) is **not** silently downgraded to SQLite — the error propagates so a misconfigured Postgres deployment fails loudly instead of quietly running on a local file.

### 1.4 Embedded PostgreSQL (Opt-In)

For a zero-install dev/managed convenience, WordJS can spawn an **embedded** Postgres process (via the **optional** `embedded-postgres` dependency, bound to port `5433`). This is **opt-in** and only relevant when `dbDriver` is `postgres`:

*   Set `"db": { "embedded": true }` in `wordjs-config.json` to start the embedded server at boot.
*   The old heuristic — auto-starting embedded PG when `db.port == 5433` — is **deprecated** but still honored (it logs a warning telling you to set `db.embedded: true` explicitly).
*   `embedded-postgres` lives in **optionalDependencies**, so installs that never use embedded PG don't pay for it. Code: `backend/src/core/embedded-db.ts` (start/stop, stale-PID cleanup, password synchronization).

When `embedded: true` is not set, the `postgres` driver simply connects to whatever external Postgres your `db` config points at.

### 1.5 Live Data Migration

WordJS includes a **Zero Data Loss** migration tool for switching drivers without losing users or posts.

> **This is core infrastructure, not a plugin.** Database migration manages the DB lifecycle and (for embedded PG) spawns server processes via `child_process` — work that must happen in the host process and cannot run in an isolated plugin worker. It was formerly the `db-migration` *plugin*; it now lives in core at `backend/src/core/db-admin/` and is wired in at boot.

1. Go to the **DB Migration** entry in the admin sidebar (route `/admin/db-migration`). It is a native admin route, always available — it is not tied to plugin activation.
2. Select your target engine (e.g., switch from SQLite to Postgres).
3. The system will:
    - **Verify** source data integrity.
    - **Stream** data in chunks to the new driver (preventing RAM spikes).
    - **Swap** configuration atomically.
    - **Restart** the backend automatically to apply changes.

> **Note:** For SQLite-to-SQLite migrations (e.g. Legacy -> Native), the system uses an atomic file swap mechanism to ensure no corruption.

The backing API is mounted at `/api/v1/db-migration` (guarded by `authenticate` + the `manage_options` permission) and also exposes embedded-PG management endpoints (`/embedded/install`, `/embedded/start`, `/embedded/stop`, `/embedded/status`).

### 1.6 Configuration

To change the driver, edit `backend/wordjs-config.json`. The flat `db*` keys (`dbDriver`, `dbHost`, `dbUser`, `dbPassword`, `dbName`, `dbPort`, `dbSsl`, `dbPath`) and a nested `db: { … }` object are both accepted; the config layer normalizes them into a single `db` connection object (`backend/src/config/app.ts`).

**Example — external Postgres:**
```json
{
  "dbDriver": "postgres",
  "dbHost": "localhost",
  "dbPort": 5432,
  "dbUser": "postgres",
  "dbPassword": "change-me",
  "dbName": "wordjs"
}
```

**Example — embedded Postgres (opt-in, dev/managed):**
```json
{
  "dbDriver": "postgres",
  "db": { "embedded": true }
}
```

**Example — SQLite (default):**
```json
{
  "dbDriver": "sqlite-native",
  "dbPath": "./data/wordjs.db"
}
```

> **Secrets:** on boot the config layer auto-generates and persists a secure `jwtSecret` and `dbPassword` if the existing config still holds the insecure defaults. Operators should still review these.

## 2. Schema Overview

The database uses a WordPress-like schema to ensure familiarity and flexibility. The schema is automatically adapted for the active driver (e.g., using `SERIAL` for Postgres vs `AUTOINCREMENT` for SQLite).

```mermaid
erDiagram
    users ||--o{ posts : writes
    users ||--o{ comments : writes
    posts ||--o{ comments : has
    posts ||--o{ postmeta : has
    users ||--o{ usermeta : has
    posts }|--|{ term_relationships : belongs_to
    term_relationships }|--|| term_taxonomy : links
    term_taxonomy ||--|| terms : defines
```

---

## 2. Core Tables

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

### 2.2 `usermeta`
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
| `post_content`   | LONGTEXT   | The main HTML/Puck content      |
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

### 2.4 `postmeta`
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
| `count`            | INTEGER    | usage count              |

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
High-volume event logging table for the internal analytics engine. Unlike the tables above, this one is **not** part of the core schema in `config/database.ts` — it is created lazily by the `Analytics` model (`backend/src/models/Analytics.ts`) on first use, with an index on `created_at`.

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
| `idx_user_meta_user_id`        | `user_meta (user_id)`                      |
| `idx_user_meta_user_id_key`    | `user_meta (user_id, meta_key)`            |
| `idx_term_rel_object_id`       | `term_relationships (object_id)`           |
| `idx_term_rel_tt_id`           | `term_relationships (term_taxonomy_id)`    |
| `idx_term_taxonomy_taxonomy`   | `term_taxonomy (taxonomy)`                 |
| `idx_posts_status_type`        | `posts (post_status, post_type)`           |
| `idx_posts_name`               | `posts (post_name)`                        |
| `idx_posts_parent`             | `posts (post_parent)`                      |
| `idx_comments_post_approved`   | `comments (comment_post_id, comment_approved)` |
| `idx_options_autoload`         | `options (autoload)`                       |

> `options.option_name` is additionally enforced as **unique** at the column level.

### Batched Meta Loading (N+1 avoidance)

Post listing (`Post.findAllWithRelations`) **batch-loads** post meta for the whole result set in a single query rather than issuing one query per post, eliminating the previous N+1 pattern on listing pages.

---

## 3. Extending the Schema (Plugins)

Plugins should generally stick to `post_meta` or `user_meta` for storing extra data. For high-performance needs they can create their **own** tables.

Plugins do this through the permission-checked `wordjs` capability bridge (`wordjs.db.createTable(...)` / `wordjs.db.run(...)`), **not** by reaching into the raw driver. Sandboxed (untrusted) plugins are **table-scoped**: any SQL referencing a core table (`users`, `user_meta`, `options`, `roles`, `sessions`, …) is rejected, and they cannot create a table whose name collides with a core table. The full rules, the driver-agnostic type aliases (`INT_PK`, `DATETIME`, …), and examples live in **[plugin-database.md](./plugin-database.md)**.

## 4. Adding a New Database Driver

Multi-DB support is designed to be a contained, **verifiable** unit. To add a backend (e.g. MySQL):

1. **Implement the interface.** Create `backend/src/drivers/<name>.ts` exporting a singleton that extends `DatabaseDriverInterface` (`interface.ts`) and implements all six methods. `run()` must return `{ lastID, changes }`; `get`/`all` must return a row / array of rows. If the engine uses non-`?` placeholders, normalize SQLite-style `?` internally (see `postgres.ts`'s `normalizeSql`) so callers keep writing SQLite-style SQL.
2. **Register it in the DB Manager.** Add the `<name>` branch in `loadDriver` (`config/database.ts`) so it's loaded as the async driver, and extend the dialect handling (`isPostgres` checks, `createPluginTable` type map, `clearDatabase` truncate syntax) if the new engine needs different DDL.
3. **Add a conformance block.** Add a `test(...)` block in `backend/src/tests/driver-conformance.test.ts` with the engine's dialect descriptor (placeholder style, auto-increment PK, INSERT-returns-id mechanism). The shared `runContract` then validates the whole contract — and skips gracefully if the backend isn't reachable in CI.

### Dialect Handling Today

Dialect differences are confined to a few spots:

*   **Auto-increment PK:** `SERIAL PRIMARY KEY` (Postgres) vs `INTEGER PRIMARY KEY AUTOINCREMENT` (SQLite), chosen in `initializeSchema` and `createPluginTable`.
*   **Placeholders:** SQLite-style `?` everywhere; the Postgres driver rewrites to `$1, $2` (single source of truth — the proxy passes SQL through untouched, so there's no double-normalization).
*   **`RETURNING`:** auto-injected by the Postgres driver on `INSERT`; stripped by the legacy WASM driver.
*   **Clearing tables:** `TRUNCATE … RESTART IDENTITY CASCADE` (Postgres) vs `DELETE FROM …` plus a `sqlite_sequence` reset (SQLite), in `clearDatabase`.
