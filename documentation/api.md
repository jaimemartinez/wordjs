# WordJS Backend API Documentation (Comprehensive)

The WordJS Backend is a robust, modular CMS core built with Node.js and Express. This document details its architecture, authentication flows, middleware chains, database interactions, and extensibility points.

## 1. Core Architecture

The backend follows a layered architecture inspired by WordPress but implemented with modern Node.js patterns.

### 1.1 Request Lifecycle
1.  **Gateway:** Request enters port `3000` (Gateway).
2.  **Proxy:** Gateway validates `x-gateway-secret` (if internal) or passes through to port `4000` (Backend).
3.  **Global Middleware:**
    *   `Helmet`: Security headers.
    *   `CORS`: Cross-Origin Resource Sharing.
    *   `RateLimit`: DoS protection (API, Auth, Uploads).
    *   `MigrationGuard`: Validates `Host` header against `siteUrl`.
4.  **Security Layers:**
    *   `AST Scanner`: Static analysis (acorn, fail-closed) of plugin code at install time.
    *   `Process Isolation`: Every plugin marked `"isolated": true` runs in a **separate OS process** (`child_process.fork` of `backend/src/core/plugin-worker.js`, IPC via v8 structured clone) and reaches the host only through the permission-checked `wordjs` capability bridge — a crash/OOM is contained to the child, never the host. There is **no "trusted" tier**: every plugin is sandboxed and the admin grants each capability per-plugin (Android-style, default-deny). First-party plugins are pre-granted their *declared* capabilities on first activation but are **not** privileged. A `network`-granted plugin's outbound connections are confined to **public IPs only** by `backend/src/core/egress-guard.ts` (loopback / link-local incl. cloud-metadata `169.254.169.254` / RFC1918 / CGNAT / IPv6 ULA are blocked, validated at connect time). Plugin DB tables are scoped to a `wjp_<slug>_` prefix. See `documentation/plugins.md` / `documentation/security.md`.
5.  **Routing:** `backend/src/routes/index.ts` dispatches to controllers.
6.  **Controller/Handler:** Executes business logic, interacts with Models/DB.
7.  **Response:** JSON response sent back.

### 1.2 Database Abstraction
WordJS loads a database **driver** behind a common interface (`backend/src/drivers/interface.ts`: `connect/get/all/run/exec/transaction/close`). Drivers are selected by the top-level `dbDriver` key (in `wordjs-config.json`) via the DB manager in `backend/src/config/database.ts`.
*   **Default:** `sqlite-native` (file-based SQLite via `better-sqlite3`), ideal for "Zero Config". File: `backend/data/wordjs-native.db`.
*   **Automatic fallback:** `sqlite-legacy` (pure-JS WASM `sql.js`, file `backend/data/wordjs.db`) — used only when a SQLite driver fails to load (e.g. the native binary is missing). It reads the same SQLite file format.
*   **PostgreSQL:** `postgres` driver (the `pg` client), connecting to an external Postgres server (`db: { host, port, user, password, name, ssl }`).
*   **Adding a driver:** implement `DatabaseDriverInterface` and add a block to the conformance suite (`backend/src/tests/driver-conformance.test.ts`).
*   **Querying:** Uses `better-sqlite3`-style prepared statements (`db.prepare(...)`) on the sync path, with an async driver layer for Postgres/native.

See `documentation/database.md` for the full driver/engine story (and `/api/v1/db-migration/*` below for switching engines at runtime).

---

## 2. Authentication & Authorization

Authentication is handled via **JWT (JSON Web Tokens)**.

### 2.1 Auth Flow
1.  **Login:** `POST /api/v1/auth/login`
    *   Input: `username` (or `email`), `password`.
    *   Validation: `bcrypt` comparison.
    *   Output: `{ user }`. The JWT is set as an **HttpOnly cookie** (`wordjs_token`) — it is **not** returned in the JSON body.
    *   Lockout: too many failed attempts for an account return `429 rest_account_locked` (per-account login lockout).
2.  **Token Usage:**
    *   Primary: the `wordjs_token` HttpOnly cookie is sent automatically by the browser.
    *   Also accepted: `Authorization: Bearer <token>` header.
    *   Lifecycle: The JWT itself expires in **2 hours** (hardcoded `config.jwt.expiresIn`, not `.env`-configurable). The `wordjs_token` cookie carrying it has a 7-day `maxAge`, so the browser keeps sending the cookie after the token inside it has expired. Refresh via `POST /auth/refresh` (re-issues the cookie).
3.  **Revocation:** JWTs are revoked via a per-user `token_valid_after` security epoch. `POST /auth/logout` and a password change bump it, immediately invalidating previously issued tokens.

### 2.2 Permissions Middleware (RBAC)
Located in `backend/src/middleware/permissions.ts` (and `auth.ts`).

| Middleware        | Description                            | Usage Example                                                            |
| :---------------- | :------------------------------------- | :----------------------------------------------------------------------- |
| `authenticate`    | Verifies JWT and attaches `req.user`.  | `router.get('/', authenticate, ...)`                                     |
| `can(cap)`        | Requires a specific capability.        | `router.post('/', authenticate, can('edit_posts'), ...)`                 |
| `isAdmin`         | Strict check for 'administrator' role. | `router.delete('/', authenticate, isAdmin, ...)`                         |
| `ownerOrCan(cap)` | resource owner OR capability.          | `router.put('/:id', authenticate, ownerOrCan('edit_others_posts'), ...)` |

### 2.3 Dynamic Roles & Capabilities
Roles are no longer hardcoded. They are stored in the database (table `options`) under the key `wordjs_user_roles`.

*   **Logic:** `backend/src/core/roles.ts` manages the abstraction.
*   **Discovery:** The system automatically aggregates all unique `cap` identifiers registered by plugins via `adminMenu.ts`. These are then presented as toggleable options in the Roles Management UI.
*   **Initialization:** Default roles are seeded during installation but can be modified via the Roles UI.
*   **Capabilities:** Users' capabilities are resolved at runtime based on their assigned role in the `roles` manager.

Default roles include:
*   **Administrator:** `*` (All capabilities).
*   **Editor:** `publish_posts`, `edit_others_posts`, etc.
*   **Author:** `publish_posts`, `edit_posts`.
*   **Contributor:** `edit_posts` (cannot publish).
*   **Subscriber:** `read` only.

### 2.4 CSRF Protection
All state-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`) under the API prefix pass through `csrfProtection` (`backend/src/middleware/auth.ts`, mounted globally in `backend/src/index.ts`). It requires a same-origin signal:

*   The `Origin` (or, as a fallback, `Referer`) must match the configured site URL / frontend URL or the request host — an **exact** origin comparison, never a prefix match.
*   Behind the gateway it honors `X-Forwarded-Host` (the gateway pins it to the real client host) when computing the expected origin.
*   When **both** `Origin` and `Referer` are absent the request is **rejected** (`403 rest_csrf_invalid`, fail-closed) **unless** it carries a real `Authorization: Bearer <token>` (a genuine server-to-server caller that can't be CSRF'd via an ambient cookie). Cookie-only header-less requests are blocked.
*   `/api/v1/setup/*` is exempt (it runs before an origin is configured).

---

## 3. The Hook System (Actions & Filters)

WordJS implements a WordPress-style Event-Driven Architecture via `backend/src/core/hooks.ts`.

### 3.1 Concepts
*   **Actions:** Do something at a specific point (fire-and-forget).
*   **Filters:** Modify data passing through (pipes).

### 3.2 Key Methods
*   `addAction(hook, callback, priority)`
*   `doAction(hook, ...args)`
*   `addFilter(hook, callback, priority)`
*   `applyFilters(hook, value, ...args)`

### 3.3 Common Hooks
*   `init`: Fired after system initialization, before server start.
*   `wp_insert_post`: Fired after a post is created.
*   `post_updated`: Fired after a post is updated.
*   `deleted_post`: Fired after a post is deleted.

---

## 4. Models & Data Access

Models wrap database operations. Located in `backend/src/models/`.

### 4.1 User Model (`User.ts`)
*   **Meta Data:** Supports arbitrary key-value storage via `user_meta` table.
*   **Methods:** `User.create()`, `User.authenticate()`, `user.can()`.

### 4.2 Options API (`core/options.ts`)
Global key-value store for system settings.
*   `getOption(key, default)`
*   `updateOption(key, value)` - Auto-serializes JSON.

---

## 5. Standardized Error Handling

All errors should follow the structure defined in `backend/src/middleware/errorHandler.ts`.

### 5.1 Error Response Schema
```json
{
  "code": "rest_error_code",   // Machine-readable string
  "message": "Human readable", // User-facing message
  "data": {
    "status": 400              // HTTP Status code
  }
}
```

### 5.2 Common Error Codes
*   `rest_not_logged_in` (401)
*   `rest_forbidden` (403)
*   `rest_no_route` (404)
*   `rest_invalid_param` (400)

---

## 6. API Endpoint Reference 📋

> [!IMPORTANT]
> **Live Documentation Available**
> The most up-to-date, interactive reference is the **Swagger UI** available at:
> `http://localhost:4000/api/v1/docs` (Requires Admin Login)

### 6.1 Core Modules
- **Authentication**: `/auth` - Login, Register, Session management.
- **Content**: `/posts`, `/pages` (alias for `?type=page`), `/media`, `/categories`, `/tags`, `/comments`.
- **Users**: `/users`, `/roles` - Role-Based Access Control.
- **System**: `/settings`, `/plugins`, `/marketplace` (plugin catalog — see §6.3.1), `/themes`, `/menus`, `/fonts`, `/health`, `/seo`, `/hooks`, `/notifications`, `/system/certs`.
- **Observability**: `/metrics` (Prometheus, root-path, scrape-token-gated — see §6.8).
- **Extensions**: `/widgets`, `/types` (Post Types), `/revisions`.
- **Data**: `/export`, `/export/wxr`, `/import`, `/import/wordpress` (WordPress WXR migration — see §6.9), `/backups`, `/db-migration` (engine migration).

### 6.2.1 Authentication Flow (JWT)
1. **Login**: `POST /auth/login` -> sets the `wordjs_token` HttpOnly cookie and returns `{ user }`.
2. **Authorize**: the cookie is sent automatically; an `Authorization: Bearer <token>` header is also accepted.
3. **Session**: The JWT expires in **2 hours** (hardcoded, not `.env`-configurable); the `wordjs_token` cookie has a 7-day `maxAge`. Refresh via `POST /auth/refresh`; `POST /auth/logout` clears the cookie and revokes the token (`token_valid_after`).

**Auth endpoints** (`backend/src/routes/auth.ts`, base path `/api/v1/auth`):

| Method | Endpoint                    | Auth | Description                                                        |
| :----- | :-------------------------- | :--- | :----------------------------------------------------------------- |
| `POST` | `/login`                    | No   | Log in (`username`/`email` + `password`); sets the HttpOnly cookie |
| `POST` | `/register`                 | No   | Self-registration; `403 rest_cannot_register` unless the `users_can_register` option is enabled |
| `GET`  | `/me`                       | Yes  | Current authenticated user                                         |
| `POST` | `/validate`                 | Yes  | Validate the current token                                         |
| `POST` | `/refresh`                  | Yes  | Re-issue the JWT/cookie                                            |
| `POST` | `/logout`                   | No   | Clear the cookie and bump `token_valid_after` (revokes all tokens) |
| `GET`  | `/password-reset-available` | No   | Public probe: whether self-service password reset can work (mail configured + reachable recovery address model) |
| `POST` | `/forgot-password`          | No   | Body `{ login }` (username or email). **Always returns 200** (anti-enumeration); emails a single-use reset link (30-min TTL; only the SHA-256 of the token is stored). Rate-limited by the auth limiter |
| `POST` | `/reset-password`           | No   | Body `{ uid, token, password }`. Consumes the single-use token (constant-time hash compare) and revokes all existing sessions; `400 rest_invalid_reset` / `rest_weak_password` on failure |

### 6.2 Content & Taxonomy
| Method   | Endpoint            | Auth  | Description                                      |
| :------- | :------------------ | :---- | :----------------------------------------------- |
| `GET`    | `/posts`            | Opt.  | List posts (filters: `type`, `status`, `author`) |
| `GET`    | `/posts/:id`        | Opt.  | Get post details by ID                           |
| `GET`    | `/posts/slug/:slug` | Opt.  | Get post details by URL slug                     |
| `POST`   | `/posts`            | `edit_posts`       | Create a new post/page                          |
| `PUT`    | `/posts/:id`        | `edit_posts`†      | Update a post (own, or `edit_others_posts`)     |
| `DELETE` | `/posts/:id`        | `edit_posts`†      | Trash/delete a post (own, or `delete_others_posts`) |
| `GET`/`POST` | `/posts/:id/meta` | Opt. / Auth | Read / set post meta (per-post access checks in the handler) |
| `GET`    | `/categories`, `/categories/:id` | Opt. | List / get categories                 |
| `POST`/`PUT`/`DELETE` | `/categories(/:id)` | `manage_categories` | Create / update / delete a category |
| `GET`    | `/tags`, `/tags/:id` | Opt. | List / get tags                                   |
| `POST`/`PUT`/`DELETE` | `/tags(/:id)` | `manage_categories` | Create / update / delete a tag   |
| `GET`    | `/comments`, `/comments/:id` | Opt. | List / get comments                       |
| `POST`   | `/comments`         | Opt.  | Create a comment (guests allowed; see note below)  |
| `PUT`    | `/comments/:id`     | `edit_comments` | Edit a comment                           |
| `DELETE` | `/comments/:id`     | `moderate_comments` | Delete a comment                     |
| `POST`   | `/comments/:id/approve`, `/comments/:id/spam` | `moderate_comments` | Moderate a comment |
| `GET`    | `/media`, `/media/:id` | Opt. | List / get library items (optional auth)        |
| `POST`   | `/media`            | `upload_files` | Upload a new media file                 |
| `PUT`/`DELETE` | `/media/:id`  | `upload_files` | Update metadata / delete a media item    |

> † `edit_posts` is held by authors/editors/admins; `PUT`/`DELETE` additionally require **ownership** of the post **or** `edit_others_posts` / `delete_others_posts` (see the access notes below).

> **Pagination:** `GET /posts` returns `X-WP-Total` and `X-WP-TotalPages` response headers. These now reflect the **filtered** list: `Post.count()` shares a `buildWhere()` with `findAll` (and defaults `status` to `publish`), so the totals match the rows actually returned.

> **Status filtering (access control, no BOLA):** listing non-published statuses is authorization-scoped (`backend/src/routes/posts.ts`). Anonymous callers always see **only `publish`** regardless of the requested `status`. A logged-in **non-privileged** user requesting `status=any` or a specific non-publish status (`draft`/`pending`/`private`) only sees **their own** such posts (the author filter is forced to their id). Only users with `edit_others_posts` or `read_private_posts` see other authors' unpublished content. This mirrors the per-post `GET /posts/:id` gate and closes the list-path BOLA.

> **Comments (`POST /comments`):** when a comment supplies a `parent`, the parent must exist **and** belong to the same post, else `400 rest_comment_invalid_parent` (top-level comments are unaffected). A guest's `author_url` (on create and edit) is restricted to `http(s)` only, so `javascript:`/`data:` can't become a clickable author link.

> **Menu item URLs (`POST /menus/:id/items`, `PUT /menus/items/:itemId`):** the item `url` is scheme-validated on both create and update (`backend/src/routes/menus.ts`). Relative paths, fragments (`#`) and queries (`?`) are allowed; absolute URLs are restricted to `http`/`https`/`mailto`/`tel`; protocol-relative `//host` and disallowed schemes (`javascript:`/`data:`/`vbscript:`) are neutralized to `#` (XSS-03).

> **User updates (`PUT /users/:id`):** authorization is layered (`backend/src/routes/users.ts`). Editing **another** user requires `edit_users`; a non-administrator **cannot edit an administrator** account (`403 rest_forbidden`, AUTH-1). On a **role change**: you cannot change your **own** role (`403 rest_cannot_edit_own_role`); changing a role requires `promote_users`; the role is validated against the roles allow-list (`400 rest_invalid_role`); only an administrator may assign the **administrator** role; and a non-administrator `promote_users` delegate cannot assign any role that grants `*` or a capability the caller lacks (privilege-amplification, AUTH-A1).

### 6.2.2 Users & Account 👤
Base path: `/api/v1/users` (`backend/src/routes/users.ts`). `PUT /me` is declared **before** `/:id` so the literal path `me` is never captured by the id route.

| Method   | Endpoint    | Auth         | Description                                                       |
| :------- | :---------- | :----------- | :---------------------------------------------------------------- |
| `GET`    | `/`         | `list_users` | List users                                                        |
| `GET`    | `/me`       | Yes          | Current user's profile                                            |
| `PUT`    | `/me`       | Yes          | Update own profile (`email`, `displayName`, `url`, `personalEmail` recovery address). **Changing your own password requires `currentPassword`** (`403 rest_bad_current_password`; min 8 chars); a successful change revokes all sessions |
| `GET`    | `/:id`      | Yes          | Get a user (self, or `list_users` for others)                     |
| `POST`   | `/`         | Admin        | Create a user (`username`, `email`, `password`, optional `role`)  |
| `PUT`    | `/:id`      | Yes†         | Update a user — layered authorization, see the note above         |
| `DELETE` | `/:id`      | Admin        | Delete a user                                                     |

### 6.3 System & Extensions
| Method | Endpoint                  | Auth  | Description                           |
| :----- | :------------------------ | :---- | :------------------------------------ |
| `GET`  | `/settings`               | No    | Get public site settings (name, desc) |
| `GET`  | `/settings/all`           | Admin | Get all settings (admin view)         |
| `GET`  | `/settings/:key`          | No    | Get a single (public) setting         |
| `PUT`  | `/settings`               | Admin | Update site settings                  |
| `PUT`  | `/settings/:key`          | Admin | Update a single setting               |
| `GET`  | `/plugins`                  | Admin | List all installed plugins (annotated with requested/granted permissions + live isolate runtime state) |
| `GET`  | `/plugins/registry`         | No    | Manifest registry of **active** plugins (feeds the public frontend) |
| `GET`  | `/plugins/active`           | No    | Array of active plugin slugs                        |
| `GET`  | `/plugins/assets`           | No    | Enqueued frontend scripts/styles of active plugins (cached 60s) |
| `GET`  | `/plugins/:slug/bundle` (+`/manifest`, `/css`) | No | Pre-compiled client bundle of a plugin (`routes/plugin-bundles.ts`, mounted under `/plugins`) |
| `POST` | `/plugins/upload`           | Admin | Install a plugin from ZIP (AST-scanned at install)  |
| `POST` | `/plugins/:slug/activate`   | Admin | Activate a plugin                                   |
| `POST` | `/plugins/:slug/deactivate` | Admin | Deactivate a plugin                                 |
| `GET`  | `/plugins/:slug/status`     | Admin | Runtime health of a loaded isolate (state, restarts, last error); `404` if not a loaded isolate |
| `POST` | `/plugins/:slug/reload`     | Admin | Hot-reload an isolated plugin's child process (re-runs the full AST-scan pipeline) |
| `POST` | `/plugins/:slug/permissions` | Admin | Set the per-permission grants (Android-style, default-deny). Body `{ granted: ["scope:access", ...], network: boolean }`; re-spawns the isolate so a `network` grant takes effect |
| `DELETE` | `/plugins/:slug`          | Admin | Uninstall a plugin. Body `{ password, dropData }`: password-confirmed, refuses an **active** plugin, always clears grants + crash strikes, and drops the plugin's `wjp_<slug>_` tables only when `dropData` is set |
| `GET`  | `/plugins/:slug/download`   | Admin | Download an installed plugin as a ZIP (`authenticateAllowQuery`: cookie/Bearer **or** a `?token=` query param) |
| `GET`  | `/plugins/:slug/port-conflicts` | Admin | Which process holds the ports the plugin's manifest claims, and whether WordJS can free them |
| `POST` | `/plugins/:slug/free-port`  | Admin | Body `{ port, allowDisable }`: disable the known system MTA squatting a **manifest-claimed** port (explicit consent required, else `409 CONSENT_REQUIRED`), then reload the plugin |
| `POST` | `/plugins/sample`           | Admin | Generate the `hello-world` sample plugin            |
| `GET`  | `/plugins/menus`            | Auth  | Admin-menu items contributed by active plugins. Any logged-in user; visibility is filtered **per capability** (`item.cap`, default `manage_options`), so non-admin roles only see items whose capability they hold |
| `GET`  | `/themes`                   | No    | List available themes (public)                      |
| `POST` | `/themes/upload`            | Admin | Install a theme from ZIP                            |
| `POST` | `/themes/:slug/activate`    | Admin | Change active theme                                 |
| `POST` | `/themes/default`           | Admin | Restore (force-overwrite) the default theme         |
| `DELETE` | `/themes/:slug`           | Admin | Delete a theme                                      |
| `GET`  | `/themes/:slug/download`    | Admin | Download a theme as a ZIP                           |
| `GET`  | `/setup/status`             | No    | Check if site is installed (not token-gated)        |
| `POST` | `/setup/test-db`            | Token | Validate a DB connection before install (install-token gated) |
| `POST` | `/setup/install`            | Token | Run the installation wizard (install-token gated)   |
| `GET`  | `/export`                   | Admin | Download a logical site export (JSON)               |
| `GET`  | `/export/wxr`               | Admin | Export as WordPress WXR (XML)                       |
| `POST` | `/import`                   | Admin | Import a site from JSON (file upload or `data`)     |

> **Note:** A full **system-state backup** (code + assets + DB dump as a ZIP) is a separate engine under `/api/v1/backups/*` and `backend/src/core/backup.ts`, distinct from the logical `/export` above. All backup routes are admin-only (`backend/src/routes/backups.ts`): `GET /backups` (list), `POST /backups` (create), `GET /backups/:filename/download`, `POST /backups/:filename/restore`, `DELETE /backups/:filename`.

> **Install token (pre-install setup):** `POST /setup/install` and `POST /setup/test-db` run before the instance is configured (unauthenticated, CSRF-exempt), so they are gated by a **one-time install token** (`backend/src/core/install-token.ts`) — supply it via the `x-install-token` header or an `installToken` body field (constant-time compared; `403` on mismatch). The token is printed to the server console at boot, mirrored to a `0600` file in the data dir, and overridable via the `WORDJS_INSTALL_TOKEN` env var (≥ 16 chars). Both endpoints also early-return `400` once the site is installed, and the on-disk token mirror is cleared after a successful install. `GET /setup/status` is **not** token-gated; `POST /setup/migrate` instead requires admin username/password.

> **Plugin permissions (default-deny):** `POST /plugins/:slug/permissions` is the admin's source of truth for grants. An undeclared scope has no effect — `hasPermission` requires **both** the manifest declaration **and** the grant. Activating a plugin with no prior grant record pre-grants exactly its manifest-**declared** permissions, persisted only **after** activation + AST-scan succeed (a plugin that fails its scan leaves behind no grant record).

### 6.3.1 Plugin Marketplace 🛒
Base path: `/api/v1/marketplace` (`backend/src/routes/marketplace.ts`). Plugins are distributed **outside** the core build: the catalog is a `marketplace-index.json` (+ one ZIP per plugin) built by `backend/scripts/build-marketplace.js` from `marketplace/plugins/` and published in the repo (`marketplace/dist/`, served raw from GitHub) and as release assets. Both routes are admin-only (`authenticate` + `isAdmin`).

| Method | Endpoint   | Auth  | Description                                                                 |
| :----- | :--------- | :---- | :-------------------------------------------------------------------------- |
| `GET`  | `/catalog` | Admin | Catalog annotated with local state (`installed`, `active`, `installedVersion`, `updateAvailable`). `?refresh=1` bypasses the 5-minute in-memory cache. `502` if the catalog can't be fetched |
| `POST` | `/install` | Admin | Body `{ id }`: downloads the catalog entry's ZIP, **sha256-verifies** it against the catalog, and installs it through the **same pipeline as `POST /plugins/upload`** (`installPluginFromZip`: zip-bomb budget, Zip Slip, slug validation, manifest + AST scan). `404` if the id isn't in the catalog; `400` on filename/sha256 failure; `502` on download failure |

> **Catalog source resolution:** the `marketplace_source` option may point to an `http(s)` URL (fetched server-side, `https` only — `http` allowed for localhost dev) or a local directory (dev / air-gapped). When unset, the repo-local `marketplace/dist/` is used if present, else the published GitHub catalog. Downloaded ZIPs are capped at 10MB and catalog filenames are validated against a strict `<slug>-<version>.zip` shape.

### 6.4 Analytics System 📊
| Method | Endpoint           | Auth  | Description                        |
| :----- | :----------------- | :---- | :--------------------------------- |
| `POST` | `/analytics/track` | No    | Log a page view or event           |
| `GET`  | `/analytics/stats` | Admin | Get aggregated stats for dashboard |


### 6.5 Certificate Management (SSL) 🔒
Base path: `/api/v1/system/certs`

| Method | Endpoint          | Auth  | Description                                 |
| :----- | :---------------- | :---- | :------------------------------------------ |
| `GET`  | `/config`         | Admin | Get current SSL status and certificate info |
| `POST` | `/config`         | Admin | Update SSL toggle or Gateway port           |
| `POST` | `/check`          | Admin | Ensure a gateway certificate exists (generates self-signed if missing) |
| `POST` | `/auto-provision` | Admin | Request Let's Encrypt HTTP-01 certificate   |
| `POST` | `/dns-start`      | Admin | Start DNS-01 challenge (returns TXT record) |
| `POST` | `/dns-check`      | Admin | Verify DNS TXT record propagation           |
| `POST` | `/dns-finish`     | Admin | Complete DNS-01 challenge and save cert     |
| `POST` | `/upload-custom`  | Admin | Upload custom `.pem` files                  |
| `GET`  | `/acme-config`    | Admin | Auto-renewal settings (no secrets) + last renewal outcome + next scheduled run |
| `POST` | `/acme-config`    | Admin | Persist auto-renewal settings (email/domains/staging/challenge type); enabling kicks a background renewal check |
| `POST` | `/renew-now`      | Admin | Force an immediate renewal attempt (bypasses the not-due/disabled gates) |

### 6.6 Database Admin / Engine Migration 🗄️
Base path: `/api/v1/db-migration`. This is **core infrastructure** (formerly the `db-migration` plugin, now `backend/src/core/db-admin/`) — it manages the DB lifecycle and migrates content between engines (e.g. SQLite ↔ PostgreSQL). All routes require `authenticate` + the `manage_options` capability.

| Method | Endpoint             | Auth          | Description                                            |
| :----- | :------------------- | :------------ | :---------------------------------------------------- |
| `GET`  | `/status`            | manage_options | Migration status + detected legacy DB files          |
| `POST` | `/migrate`           | manage_options | Migrate site content to the target engine            |
| `POST` | `/cleanup`           | manage_options | Remove leftover legacy DB files after a migration    |

### 6.7 Revisions 📝
Base path: `/api/v1/revisions`. All routes require `authenticate`. Access is gated **per parent post**: the post owner (with `edit_posts` for mutating actions) or a user with `edit_others_posts`.

| Method   | Endpoint                    | Auth                | Description                          |
| :------- | :-------------------------- | :------------------ | :----------------------------------- |
| `GET`    | `/post/:postId`             | owner / edit_others | List a post's revisions (paginated)  |
| `GET`    | `/:id`                      | owner / edit_others | Get a single revision                |
| `POST`   | `/:id/restore`              | owner+edit / edit_others | Restore a revision              |
| `DELETE` | `/:id`                      | owner+edit / edit_others | Delete a revision               |
| `GET`    | `/compare/:id1/:id2`        | owner / edit_others | Diff two revisions (both must be readable) |

### 6.8 Prometheus Metrics 📈
A Prometheus scrape endpoint is served at the **root path** `GET /metrics` (`backend/src/core/metrics.ts`). It exposes the default Node/process metrics (`wordjs_`-prefixed: CPU, RSS/heap, event-loop lag, GC, handles) plus a `wordjs_sse_clients` gauge (active SSE clients on this node) and a `wordjs_ready` gauge.

| Method | Endpoint   | Auth         | Description                                  |
| :----- | :--------- | :----------- | :------------------------------------------- |
| `GET`  | `/metrics` | Scrape token | Prometheus text-format metrics for this node |

*   **Disabled by default:** the endpoint returns **`404`** unless a scrape token is configured at `config.metrics.token` (in `wordjs-config.json`) or via the `METRICS_TOKEN` env var. With no token, metrics are never exposed.
*   **Auth:** scrape with `Authorization: Bearer <token>` (or `?token=<token>`); a missing/incorrect token returns `401` (constant-time compare). It is mounted at root level — CSRF-free and not rate-limited.
*   **Routing:** exposed publicly through the gateway (in the backend's advertised route list) and in monolith mode (`BACKEND_PREFIXES`). Never reachable without the token regardless of mode.

### 6.9 WordPress Import (WXR) 📥
Base path: `/api/v1/import`. Migrates an existing WordPress site from its **WXR** export (the `Tools → Export → All content` `.xml` file). Routes are **admin-only** (`authenticate` + `isAdmin`). The export is uploaded as a **`multipart/form-data`** request with the file in the **`file`** field (`.xml` / `.wxr`, max 100MB). Implemented by `backend/src/core/wxr-import.ts` (`analyzeWxr`/`importWxr`) and `backend/src/routes/import.ts`. The admin UI lives at `/admin/import` (sidebar "Import").

| Method | Endpoint                | Auth  | Description                                              |
| :----- | :---------------------- | :---- | :------------------------------------------------------ |
| `POST` | `/import/wordpress/analyze` | Admin | **Dry-run.** Parse the WXR and return entity counts; writes nothing |
| `POST` | `/import/wordpress`         | Admin | **Run the import** (idempotent / re-runnable)           |

**Run-time form options** (multipart fields alongside `file`, only read by `POST /import/wordpress`):

| Field               | Default                          | Description                                                                 |
| :------------------ | :------------------------------- | :-------------------------------------------------------------------------- |
| `defaultAuthorId`   | the importing admin's user id    | Fallback author for items whose WP author can't be imported (positive integer; otherwise falls back to the caller) |
| `importComments`    | enabled (`"0"` to disable)       | Import post comments (threaded; spam/pingbacks skipped)                     |
| `importAttachments` | disabled (`"1"` to enable)       | Create attachment **post records only** — WXR ships URLs, not media binaries, so files are never downloaded |

**What it maps:** `wp:author` → users (created with a random password — imported users must reset to log in — or matched by login/email), categories → `category` terms (with parent hierarchy), tags → `post_tag` terms, and items → posts/pages with post meta, term relationships, and comments. The import is **idempotent**: existing users/terms/posts are matched and reused rather than duplicated, and original publish dates are preserved. **Skipped entirely:** attachments (unless `importAttachments=1`, and even then only the records) and `nav_menu_item` entries.

**`analyze` response** — counts only, nothing is written:
```json
{
  "success": true,
  "analysis": {
    "wxrVersion": "1.2",
    "site": { "title": "My Blog", "link": "https://old.example.com", "...": "..." },
    "counts": {
      "authors": 3,
      "categories": 8,
      "tags": 42,
      "customTerms": 0,
      "posts": 120,
      "pages": 5,
      "attachments": 60,
      "navItems": 4,
      "other": 0,
      "comments": 310
    }
  }
}
```

**`import` response** — a per-entity `created`/`skipped` (plus `matched` for authors) summary:
```json
{
  "success": true,
  "summary": {
    "site": { "title": "My Blog", "link": "https://old.example.com" },
    "authors": { "created": 2, "matched": 1 },
    "terms":   { "categories": 8, "tags": 42, "custom": 0 },
    "posts":   { "created": 118, "skipped": 2 },
    "pages":   { "created": 5, "skipped": 0 },
    "attachments": { "created": 0, "skipped": 60 },
    "comments":    { "created": 305, "skipped": 5 },
    "navItems":    { "skipped": 4 },
    "errors": []
  }
}
```

**Errors:** a missing upload returns `400 no_file`; an unreadable upload `400 read_failed`; a file that doesn't parse as a valid WXR returns `400 invalid_wxr`. Non-fatal per-item problems during a run are collected (capped at 100) in the summary's `errors[]` array rather than aborting the import.

---

## 8. Cron System ⏰

WordJS includes a robust scheduling system similar to `wp-cron`, located in `backend/src/core/cron.ts`.

### 8.1 Scheduling Events
```javascript
const { scheduleEvent } = require('../../src/core/cron');

// Schedule a recurring event
if (!nextScheduled('my_plugin_daily_task')) {
    scheduleEvent(Date.now(), 'daily', 'my_plugin_daily_task');
}

// Hook into it
addAction('my_plugin_daily_task', () => {
    console.log("Running daily maintenance...");
});
```

### 8.2 Available Intervals
*   `hourly`
*   `twicedaily`
*   `daily`
*   `weekly`

---

## 9. Internationalization (i18n) 🌍

WordJS supports native translation via `backend/src/core/i18n.ts`. It uses JSON files located in `backend/languages/`.

### 9.1 Usage
```javascript
const { __, _n } = require('../../src/core/i18n');

// Simple string
const greeting = __('Hello World', 'my-plugin');

// Plurals
const msg = _n('%d User', '%d Users', count, 'my-plugin').replace('%d', count);
```

### 9.2 Translation Files
File format: `domain-locale.json` (e.g., `my-plugin-es_ES.json`).
```json
{
    "Hello World": "Hola Mundo"
}
```

---

## 10. Shortcodes 🧩

Shortcodes allow users to inject dynamic content into posts/pages using `[tag]` syntax. Handled by `backend/src/core/shortcodes.ts`.

### 10.1 Registering a Shortcode
```javascript
const { addShortcode } = require('../../src/core/shortcodes');

addShortcode('youtube', (attrs, content) => {
    const id = attrs.id || '';
    return `<iframe src="https://www.youtube.com/embed/${id}"></iframe>`;
});
```
Usage in Editor: `[youtube id="dQw4w9WgXcQ"]`

---

## 11. Custom Backups & System State 📦

WordJS features a **Backup** engine located in `backend/src/core/backup.ts`. Unlike traditional CMS backups that only save the database, WordJS bundles your content and extensions alongside the database. It deliberately does **not** back up code or config: overwriting `src/`, `package.json`, `.env`, or `wordjs-config.json` from a restored (and potentially crafted) zip would be an RCE / JWT-secret-swap primitive, so restore refuses to extract them.

### 11.1 What is included?
The backup zip file contains an **allowlist of three content roots** plus the database — not the whole backend tree.
*   **Content:** `uploads/` (images, videos).
*   **Extensions:** `plugins/`, `themes/`.
*   **Database (logical):** A logical dump (`wordjs-content.json`) is generated and added to ensure data integrity across versions.
*   **Database (physical):** For SQLite drivers, a consistent physical snapshot of the live `.db` is also added (as `database/wordjs.db`) to cover tables the logical export does not (analytics, notifications, plugin tables, `schema_migrations`). Postgres backups rely on the logical export only (physical `pg_dump` is not bundled).

**Not included:**
*   **Code & config:** `src/`, `server.js`, `package.json`, `.env`, `wordjs-config.json` — intentionally excluded (see above). `languages/` is also not backed up.
*   `node_modules/`: Re-generated via `npm install`.
*   `backups/`: Preventing recursive loops.
*   `logs/`, `os-tmp/`, `.git/`.

### 11.2 Key Functions
*   `createBackup()`: Zips the three content roots (`uploads/`, `plugins/`, `themes/`), adds the logical dump and a physical `.db` snapshot, and generates a timestamped ZIP.
*   `restoreBackup(filename)`:
    1.  **Physical Restore:** Extracts files — but **only** entries under the `uploads/`, `plugins/`, and `themes/` allowlist (each path-contained against traversal); any `src/`, config, or other entry is skipped, never overwriting code or config.
    2.  **Logical Restore:** Parses `wordjs-content.json` and rebuilds the database using `importSite()`. For non-file drivers (e.g. Postgres) the database is wiped first for a clean restore.
*   `listBackups()`: Returns available backup files from `backend/backups/` (newest first).
*   `deleteBackup(filename)`: safely removes a backup file.
*   `pruneBackups(keep?)`: **Retention pruning.** Keeps only the newest `keep` backups and deletes the rest. `createBackup()` calls it automatically after every backup so scheduled/auto backups don't fill the disk unbounded. When `keep` is omitted it is read from the `backup_retention` option (**default 7**); set `backup_retention` to `0` (or any value ≤ 0) to disable pruning and keep all backups.

> **Retention:** Backups still live **on-host** in `backend/backups/`; off-host / S3 storage is roadmap. The only automatic cleanup is the retention prune above.

### 11.3 Import/Expert (Logical Data Only)
Located in `backend/src/core/import-export.ts`.
*   `exportSite(options)`: Generates the JSON dump used inside full backups.
*   `exportToWXR()`: A separate exporter that returns the WordPress WXR (XML) representation.
*   `importSite(data, options)`: The engine that consumes the JSON dump to populate the DB.

---

## 12. Widgets System 🧱

The Widgets API (`backend/src/core/widgets.ts`) allows plugins to register dynamic content blocks for Sidebars and Footers.

### 12.1 Registering a Widget
```javascript
const { registerWidget } = require('../../src/core/widgets');

// Signature: registerWidget(id, name, options)
registerWidget('clock_widget', 'Analog Clock', {
    description: 'Displays the current time',
    render: (options) => `<div class="clock">...</div>`
});
```


## 7. Developing Extensions

### 6.1 Creating Endpoints
Use the `asyncHandler` wrapper to automatically catch Promise rejections.

```javascript
const express = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');

router.get('/my-endpoint', asyncHandler(async (req, res) => {
    const data = await complexDbOp();
    res.json(data);
}));
```

### 6.2 Security Best Practices
*   **Sanitize:** Use `sanitize-html` for any HTML input.
*   **Validate:** Check all `req.body` params.
*   **Zip Slip:** Use the provided validation middleware for file uploads.
*   **Rate Limit:** Apply `uploadLimiter` for any file handling routes.

---

## 7. Developer Cheatsheet (Cookbook) 🧑‍🍳

Quick copy-paste snippets for common tasks.

### 7.1 How to... Add a New API Endpoint
In your plugin's `index.js`:
```javascript
const express = require('express');
const router = express.Router();
const { authenticate, isAdmin } = require('../../src/middleware/auth');

// Public Endpoint
router.get('/hello', (req, res) => {
    res.json({ message: 'Hello World!' });
});

// Protected Admin Endpoint
router.post('/secret', authenticate, isAdmin, (req, res) => {
    res.json({ secret: 'Only admins see this' });
});

// Register it
const { getApp } = require('../../src/core/appRegistry');
getApp().use('/api/v1/my-plugin', router);
```

### 7.2 How to... Save/Load Settings
Use the global Options API.
```javascript
const { getOption, updateOption } = require('../../src/core/options');

// Save
updateOption('my_plugin_color', '#ff0000');

// Load (with default)
const color = getOption('my_plugin_color', '#000000');
```

### 7.3 How to... Hook into Events
Run code when something happens (e.g., a post is saved).
```javascript
const { addAction } = require('../../src/core/hooks');

addAction('wp_insert_post', (postId, data) => {
    console.log(`Post saved: ${data.post_title}`);
    // Do custom logic here (e.g. send email)
});
```

### 7.4 How to... Fetch Data in React (Admin)
**CRITICAL:** The auth token is an **HttpOnly cookie** (`wordjs_token`) — it is **not** in `localStorage` and cannot be read from JS. Send it by passing `credentials: 'include'` so the browser attaches the cookie.
```javascript
const getData = async () => {
    const res = await fetch('/api/v1/my-plugin/hello', {
        credentials: 'include' // sends the HttpOnly wordjs_token cookie
    });
    const data = await res.json();
    console.log(data);
};
```
