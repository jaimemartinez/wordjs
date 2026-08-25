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
    *   `MfaComplianceGate`: Mounted on the API prefix (`backend/src/index.ts`); blocks a user who is required to enrol under the admin MFA-by-role policy (once past their grace period) until they complete MFA enrollment.
4.  **Security Layers:**
    *   `AST Scanner`: Static analysis (acorn, fail-closed) of plugin code at install time.
    *   `Process Isolation`: Every plugin marked `"isolated": true` runs in a **separate OS process** (`child_process.fork` of `backend/src/core/plugin-worker.js`, IPC via v8 structured clone) and reaches the host only through the permission-checked `wordjs` capability bridge — a crash/OOM is contained to the child, never the host. There is **no "trusted" tier**: every plugin is sandboxed and the admin grants each capability per-plugin (Android-style, default-deny). Activation is the grant step — for **any** plugin, not just first-party ones: an admin activating a plugin that holds no grant record grants exactly its *declared* capabilities (see §6.3). No plugin is privileged. A `network`-granted plugin's outbound connections are confined to **public IPs only** by `backend/src/core/egress-guard.ts` (loopback / link-local incl. cloud-metadata `169.254.169.254` / RFC1918 / CGNAT / IPv6 ULA are blocked, validated at connect time). Plugin DB tables are scoped to a `wjp_<slug>_` prefix. See `documentation/plugins.md` / `documentation/security.md`.
5.  **Routing:** `backend/src/routes/index.ts` dispatches to controllers.
6.  **Controller/Handler:** Executes business logic, interacts with Models/DB.
7.  **Response:** JSON response sent back.

> **Static uploads & image negotiation:** `GET /uploads/*.{jpg,jpeg,png}` passes through the `imageNegotiation` middleware (`backend/src/middleware/image-negotiation.ts`, mounted on `/uploads` ahead of `express.static`) before the static file is served. When the client's `Accept` header advertises AVIF/WebP, it transparently serves an on-demand AVIF/WebP derivative at the **same URL** (cached under `<uploads>/.derivatives`, `Vary: Accept`), failing safe to the original bytes on any error. It also **declines** to transcode — serving the original — when the source's decoded size would exceed `MAX_DECODED_BYTES` (24MB, ~8MP RGB) or when `MAX_CONCURRENT_TRANSCODES` (**2**) transcodes are already in flight. The cache key is derived from the **canonicalized** request path, so `/a/b.jpg` and `/a//b.jpg` map to one derivative instead of growing `.derivatives` without bound.

### 1.2 Database Abstraction
WordJS loads a database **driver** behind a common interface (`backend/src/drivers/interface.ts`: `connect/get/all/run/exec/transaction/close`). Drivers are selected by the top-level `dbDriver` key (in `wordjs-config.json`) via the DB manager in `backend/src/config/database.ts`.
*   **Default:** `sqlite-native` (file-based SQLite via `better-sqlite3`), ideal for "Zero Config". File: `backend/data/wordjs-native.db`.
*   **Automatic fallback:** `sqlite-legacy` (pure-JS WASM `sql.js`, file `backend/data/wordjs.db`) — used only when a SQLite driver fails to load (e.g. the native binary is missing). It reads the same SQLite file format.
*   **PostgreSQL:** `postgres` driver (the `pg` client), connecting to an external Postgres server (`db: { host, port, user, password, name, ssl }`).
*   **MySQL / MariaDB:** `mysql` driver (the `mysql2` client, MySQL 8.0+/MariaDB; `dbDriver: "mariadb"` is accepted as an alias). It ships a **SQLite→MySQL dialect-translation layer** so the same schema/queries the SQLite path uses run unchanged: `TEXT` becomes `LONGTEXT` (or `VARCHAR(255)` when the DDL makes the column part of a key) with expression-default handling, `AUTOINCREMENT`→`AUTO_INCREMENT`, `INSERT OR IGNORE`/`ON CONFLICT`→`INSERT IGNORE`/`ON DUPLICATE KEY UPDATE`, `RETURNING`→`insertId`, and a session `sql_mode` of `ANSI_QUOTES,STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION` (identifier quoting; an overlong value errors rather than truncating). Connect with `db: { host, port (default 3306), user, password, name }`.
*   **Adding a driver:** implement `DatabaseDriverInterface` and add a block to the conformance suite (`backend/src/tests/driver-conformance.test.ts`).
*   **Engine detection:** `getDbType()` (`backend/src/config/database.ts`) reports the active engine via `isPostgres`/`isMySQL`/`isSQLite` for the code paths that must branch on dialect.
*   **Querying:** Uses `better-sqlite3`-style prepared statements (`db.prepare(...)`) on the sync path (SQLite only); Postgres and MySQL are **async-only** drivers (the sync `db.get()` throws — use `dbAsync`).

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
4.  **Scoped API tokens (headless / machine clients):** In addition to the browser cookie, long-lived personal access tokens authenticate non-browser callers via `Authorization: Bearer wjt_<secret>` (`backend/src/models/ApiToken.ts`). Each token carries **scopes** — a global `read`/`write`/`*` and/or per-resource grants like `posts:write`, `media:read` (`write` implies `read`). A request's effective permission is the token owner's capabilities **∩** the token's scope, so a token is always *narrower* than its owner. Tokens are managed at `/auth/tokens` (see §6.2.1); the raw secret is shown **once** at creation and stored only as a SHA-256 hash. A genuine `Authorization: Bearer` request is CSRF-exempt (§2.4).
5.  **Two-factor authentication (TOTP):** Accounts can enrol a TOTP second factor with backup codes. When enabled, `POST /auth/login` returns a short-lived challenge instead of a session, and the caller completes login via `POST /auth/mfa`. An admin-enforced MFA-by-role policy (`/auth/mfa/policy`) plus the global `MfaComplianceGate` (§1.1) can require MFA for chosen roles. See §6.2.1.

### 2.2 Permissions Middleware (RBAC)
Located in `backend/src/middleware/permissions.ts` (and `auth.ts`).

| Middleware        | Description                            | Usage Example                                                            |
| :---------------- | :------------------------------------- | :----------------------------------------------------------------------- |
| `authenticate`    | Verifies JWT and attaches `req.user`.  | `router.get('/', authenticate, ...)`                                     |
| `can(cap)`        | Requires a specific capability.        | `router.post('/', authenticate, can('edit_posts'), ...)`                 |
| `isAdmin`         | Strict check for 'administrator' role. | `router.delete('/', authenticate, isAdmin, ...)`                         |
| `ownerOrCan(cap, getOwnerId)` | resource owner OR capability. `getOwnerId(req)` resolves the record's owner. Exported for extensions; core content routes gate on `canEditPostRecord` instead (§6.2). | `router.put('/:id', authenticate, ownerOrCan('edit_others_posts', getOwnerId), ...)` |
| `canAny(caps)` / `canAll(caps)` | Any one of / all of a capability list. | `router.get('/', authenticate, canAny(['edit_posts','list_users']), ...)` |

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
*   Exactly two paths are exempt — `/setup/install` and `/setup/test-db` — because they run before an origin (or any user) exists. The exemption is an **enumerated set** (`CSRF_EXEMPT_PATHS` in `backend/src/middleware/auth.ts`), not the `/setup` subtree: `POST /setup/migrate` survives installation and authenticates raw credentials from the body, so it needs no ambient cookie and stays subject to the same-origin check. The match is made on the sub-path derived from `req.originalUrl`, **not** on `req.path`: `csrfProtection` is mounted *with* the API prefix, and Express strips a mount path from `req.url` before the middleware runs, so a comparison against the full `/api/v1/setup/install` could never be true. Until that was corrected the documented exemption was dead code and a headless installer following this page got a misleading `403 rest_csrf_invalid` on a site with no users.

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
*   `rest_internal_error` (500) — what an error that merely *escaped* renders as. `errorHandler` only echoes a thrower's own `code`/`message` when the error carries an integer `status`, i.e. when this codebase meant a client to read it; anything else (a driver error, most often) gets this generic body plus a `data.errorId` that ties the response to the full server-side log line. Before that, an anonymous request whose `:id` parsed to `NaN` was answered with the raw SQLSTATE and the engine's own wording.

### 5.3 Request Parameter Contracts
Two rules in `backend/src/core/query-params.ts` decide what a malformed parameter is answered with, before any handler reads its value. Both are stated once and consumed everywhere, so the answer cannot differ per call site.

*   **A scalar query parameter must arrive exactly once, as a string.** Express parses the query with `qs`, so `?force=true&force=true` is the *array* `['true','true']` and `?force[x]=true` is an object — and every guard in this codebase compares a query value to a string. Rather than resolve the repeat to the first or the last (either choice is an HTTP-parameter-pollution primitive: on `DELETE /posts/:id?force=true&force=true` it was the difference between a trash and a permanent delete, answered `200`), the request is refused with **`400 rest_invalid_param`**, with the offending field named in `data.params`. Only the *shape* is refused: `?force=banana` is still simply "not true", and `?page=abc` still falls through to the default. The call sites are, exhaustively: `requireScalarQuery` at the top of `GET /categories`, `GET /tags`, `GET /comments`, `GET /media`, `GET /users`, `GET /types`, `GET /types/schemas`, `GET /taxonomies`, `GET /analytics/stats`, `GET /forms/submissions`, `GET /marketplace/catalog`, `GET /marketplace/themes/catalog`, `GET /export`, `GET /plugins/:slug/bundle` and `GET /plugins/:slug/bundle/css`; `scalarQueryParam` at the read of `?force` on `DELETE /posts/:id` and `DELETE /comments/:id`; and `GET /posts`, which predates the shared helper and still declares its own `LIST_QUERY_STRING_FIELDS` + `firstNonStringField()`/`invalidParamType()` in `routes/posts.ts` — a second implementation of the same refusal, writing the same body, which is why `errorHandler` renders `invalidParams` into `data.params` rather than letting the thrown form differ from the inline one. That list is not maintained by hand and should not be treated as the contract: `backend/src/tests/request-field-types.test.ts` (a CI gate) walks **every** `.ts` file in `routes/` and `middleware/` and fails the build if any value out of `req.query` reaches a string comparison whose shape was not settled first — so a list route added tomorrow either adopts the rule or turns the build red.
*   **A route parameter that denotes a row id must be a base-10 positive integer the id columns can hold** (1 … 2147483647, at most 10 digits), or the router answers **404 with its own not-found body** — byte for byte what it answers for an id that does not exist, so a malformed id is indistinguishable from an absent one and the pair is not a probe for which ids are well-formed. It is registered with `router.param()` — once per router per parameter name, which today is thirteen registrations across nine routers (`categories`, `comments`, `media`, `posts`, `tags`, `users` on `:id`; `menus` on `:id` and `:itemId`; `revisions` on `:id`, `:id1`, `:id2` and `:postId`; `seo` on `:postId`) — so it runs *before* the route's own middleware — including `authenticate`, which is the order WordPress uses (`(?P<id>[\d]+)` fails to match and the request is a 404 before any permission callback). Two consequences worth stating: `parseInt` used to be lenient, so `/comments/12abc` was an alias for `/comments/12` — every row had a family of spellings, each its own cache key, rate-limit bucket and audit-log line; and an out-of-range but perfectly ordinary integer such as `/categories/9999999999` reached the driver, where Postgres answers `22003 value out of range for type integer` and the caller got a 500. A few routes (`/webhooks/*`, `/collab/:postId/*`, `/presence/:postId`, `DELETE /forms/submissions/:id`, `DELETE /auth/tokens/:id`) keep their own established `400` for an unusable id — that status is part of their published contract — but they now ask the *same* predicate rather than each hand-rolling a weaker one.

---

## 6. API Endpoint Reference 📋

> [!IMPORTANT]
> **Live Documentation Available**
> The most up-to-date, interactive reference is the **Swagger UI** available at:
> `http://localhost:4000/api/v1/docs` (Requires Admin Login)

### 6.1 Core Modules
- **Authentication**: `/auth` - Login, Register, Session management.
- **Content**: `/posts`, `/pages` (alias for `?type=page`), `/media`, `/categories`, `/tags`, `/comments`.
- **Users**: `/users`, `/roles` (see §6.11) - Role-Based Access Control.
- **System**: `/settings`, `/plugins`, `/marketplace` (plugin **and theme** catalogs — see §6.3.1), `/themes`, `/menus` (§6.12), `/fonts` (§6.15), `/health` (§6.17), `/seo` (§6.16), `/hooks` (§6.18), `/notifications` (§6.19), `/webhooks` (outgoing HMAC-signed webhooks — see §6.10), `/system/certs`.
- **Observability**: `/metrics` (Prometheus, root-path, scrape-token-gated — see §6.8), `/analytics` (see §6.4).
- **Extensions**: `/widgets` (§6.13), `/types` (Post Types, §6.14), `/revisions`.
- **Site & editor**: `/chrome` (site-level chrome compositions — `PUT`/`DELETE /chrome/:part` where `part` is `header`, `footer` or `announcement`, admin-only; anything else answers `400`; reads travel through the public `/settings` payload), `/forms` and `/presence` (§6.20).
- **Internal**: `/api/internal/gateway-update` — gateway-to-backend only, outside the `/api/v1` prefix (§6.21).
- **Data**: `/export`, `/export/wxr`, `/import`, `/import/wordpress` (WordPress WXR migration — see §6.9), `/backups`, `/db-migration` (engine migration).

### 6.2.1 Authentication Flow (JWT)
1. **Login**: `POST /auth/login` -> sets the `wordjs_token` HttpOnly cookie and returns `{ user }`.
2. **Authorize**: the cookie is sent automatically; an `Authorization: Bearer <token>` header is also accepted.
3. **Session**: The JWT expires in **2 hours** (hardcoded, not `.env`-configurable); the `wordjs_token` cookie has a 7-day `maxAge`. Refresh via `POST /auth/refresh`; `POST /auth/logout` clears the cookie and revokes the token (`token_valid_after`).

**Auth endpoints** (`backend/src/routes/auth.ts`, base path `/api/v1/auth`):

| Method | Endpoint                    | Auth | Description                                                        |
| :----- | :-------------------------- | :--- | :----------------------------------------------------------------- |
| `POST` | `/login`                    | No   | Log in (`username`/`email` + `password`); sets the HttpOnly cookie |
| `POST` | `/register`                 | No   | Self-registration; `403 rest_cannot_register` unless the `users_can_register` option is enabled. When email verification is required the account is created **unverified** and **no** session cookie is issued (`201 { user, verificationRequired: true }`); `POST /auth/login` then answers `403 rest_email_unverified` until `/verify-email` is consumed |
| `GET`  | `/me`                       | Yes  | Current authenticated user                                         |
| `POST` | `/validate`                 | Yes  | Validate the current token                                         |
| `POST` | `/refresh`                  | Session | Re-issue the JWT/cookie. A `Bearer wjt_…` caller is refused (`403 rest_session_from_token_forbidden`) — a headless token can never be exchanged for a session cookie |
| `POST` | `/logout`                   | No   | Clear the cookie and bump `token_valid_after` (revokes all tokens) |
| `GET`  | `/password-reset-available` | No   | Public probe: whether self-service password reset can work (mail configured + reachable recovery address model) |
| `POST` | `/forgot-password`          | No   | Body `{ login }` (username or email). **Always returns 200** (anti-enumeration); emails a single-use reset link (30-min TTL; only the SHA-256 of the token is stored). Rate-limited by the auth limiter |
| `POST` | `/reset-password`           | No   | Body `{ uid, token, password }`. Consumes the single-use token (constant-time hash compare) and revokes all existing sessions; `400 rest_invalid_reset` / `rest_weak_password` on failure |
| `POST` | `/verify-email`             | No   | Body `{ uid, token }`. Consumes the single-use email-verification token minted at registration (24h TTL) and clears `email_verification_pending`, after which login works. One uniform `400 rest_invalid_verification` for a bad, expired or already-consumed token. Rate-limited by the auth limiter |
| `GET`  | `/tokens`                   | Session + `manage_api_tokens` | List the caller's scoped API tokens (metadata only; secrets are never re-shown) |
| `POST` | `/tokens`                   | Session + `manage_api_tokens` | Mint a scoped API token. Body `{ name?, scopes?, expiresInDays? }`; the raw `wjt_…` secret is returned **once** (`201`). Unknown scopes → `400 rest_invalid_scope`; over the active-token cap → `400 rest_token_limit` |
| `DELETE` | `/tokens/:id`             | Session + `manage_api_tokens` | Revoke one of the caller's tokens (`404` if not the caller's or already gone) |
| `POST` | `/mfa`                      | No   | Complete a login that requires a second factor. Body `{ mfaToken, code }` (TOTP or backup code); issues the session cookie on success (own `mfa:` lockout bucket) |
| `GET`  | `/mfa/status`               | Yes  | Whether MFA is enabled for the caller + remaining backup-code count |
| `POST` | `/mfa/setup`                | Session | Begin TOTP enrollment: returns a new `secret` + `otpauthUri` (for the QR). Body **must** carry `currentPassword` (`403 rest_bad_current_password`) |
| `POST` | `/mfa/enable`               | Session | Verify a code against the pending secret, activate MFA, and return backup codes **once**. Body **must** carry `currentPassword` (`403 rest_bad_current_password`) |
| `POST` | `/mfa/disable`              | Session | Disable MFA (requires a current TOTP/backup code) |
| `POST` | `/mfa/backup-codes`         | Session | Regenerate backup codes (requires a current code); returned **once** |
| `GET`  | `/mfa/policy`               | Admin (session) | Read the admin-enforced MFA-by-role policy |
| `PUT`  | `/mfa/policy`               | Admin (session) | Set which roles require MFA + the grace period. Body `{ requiredRoles, graceDays }` |

> **Session-only management:** rows marked **Session** require an *interactive* session — an `Authorization: Bearer wjt_…` API token is rejected (`403 rest_token_management_forbidden`), so a leaked token can never mint further tokens, enrol/disable MFA, regenerate backup codes, or change the MFA policy. `POST /mfa` itself is public: it is the second half of login, gated by the short-lived challenge token `POST /auth/login` issues after the password check.

> **Enrolment needs the password, not just the cookie.** `POST /mfa/setup` and `POST /mfa/enable` each re-check `currentPassword` through the same sudo helper as the self-service password doors (per-account lockout bucket + in-flight cap, so it is not an unthrottled password oracle). Enrolment used to be reachable on the ambient session cookie alone, which made it a one-way door: whoever held a session for a moment could bind **their** authenticator and the owner could never get back in — `forgot-password`/`reset-password` change the password but clear no `mfa_*` key. Turning 2FA **off** already demanded a current code; turning it **on** now demands the password. Admin escape hatch: `POST /users/:id/mfa/reset` (§6.2.2).

### 6.2 Content & Taxonomy
| Method   | Endpoint            | Auth  | Description                                      |
| :------- | :------------------ | :---- | :----------------------------------------------- |
| `GET`    | `/posts`            | Opt.  | List posts (filters: `type`, `status`, `author`) |
| `GET`    | `/posts/:id`        | Opt.  | Get post details by ID                           |
| `GET`    | `/posts/slug/:slug` | Opt.  | Get post details by URL slug                     |
| `POST`   | `/posts`            | `edit_posts`       | Create a new post/page                          |
| `PUT`    | `/posts/:id`        | `edit_posts`†      | Update a post (own, or `edit_others_posts`)     |
| `DELETE` | `/posts/:id`        | `edit_posts`†      | Trash/delete a post (own, or `delete_others_posts`) |
| `GET`/`POST` | `/posts/:id/meta` | Opt. / Auth | Read / set post meta (per-post access checks in the handler). **Server-owned keys are refused** — see the note below |
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

> **One edit gate, four surfaces.** `canEditPostRecord(user, post)` (`backend/src/core/post-capabilities.ts`) is the single implementation of "may this user edit this record": type-aware capability family → ownership (`edit_<type>s` vs `edit_others_<type>s`) → **plus `edit_published_<type>s` when the post is already published**, because a bare edit capability is not permission to rewrite what the site is currently serving. `PUT /posts/:id`, `POST /posts/:id/meta`, `POST /revisions/:id/restore` and the collaboration/presence gates all call it. Three of those four applied the published check and the meta route did not, which let a **contributor** replace the body of their own already-published post — `_puck_data` *is* the public body — through `POST /posts/<id>/meta` after `PUT /posts/:id` had answered `403`. A gate that is copied is a gate that drifts; this one is shared. `POST /posts/:id/meta` also **snapshots a revision before the write** when the key is revisionable (`core/revisions.REVISIONABLE_POST_META`), so a content write through this route leaves the same recovery point the identical bytes would leave through `PUT`.

> **Metadata is one bounded, observable write.** Every structured metadata value is validated before the route creates/updates the post or snapshots a revision: more than 128 nested levels, more than 100,000 values, or a cyclic in-process graph is rejected with `413 rest_meta_value_too_complex`, leaving the row, metadata and revision history untouched. Core/versioned keys are canonicalized with the same case/accent/PAD-SPACE rules as the weakest supported SQL collation, so `_PUCK_DATA` cannot mean “a second key” on SQLite and “overwrite `_puck_data`” on MySQL; it is stored as `_puck_data`, sanitized and revisioned everywhere. After `POST /posts/:id/meta` commits public/content metadata it fires `post_updated`, so ISR purge, webhooks and hooks observe the new value immediately. `_wjs_review_comments` is the explicit non-public exception and does not evict the public cache.

> **Pagination:** `GET /posts` returns `X-WP-Total` and `X-WP-TotalPages` response headers. These now reflect the **filtered** list: `Post.count()` shares a `buildWhere()` with `findAll` (and defaults `status` to `publish`), so the totals match the rows actually returned.

> **Status filtering (access control, no BOLA):** listing non-published statuses is authorization-scoped (`backend/src/routes/posts.ts`). Anonymous callers always see **only `publish`** regardless of the requested `status`. A logged-in **non-privileged** user requesting `status=any` or a specific non-publish status (`draft`/`pending`/`private`/`future`) only sees **their own** such posts (the author filter is forced to their id). `status=any` resolves to `publish`, `draft`, `pending`, `private` and `future` — `future` is part of the author-facing set, or a scheduled post would vanish from the admin list until its publish moment. Only users with the type's `edit_others_posts` / `read_private_posts` equivalents see other authors' unpublished content; for a post type that is not `publiclyReadable` the author filter is forced even for `status=publish`. This mirrors the per-post `GET /posts/:id` gate and closes the list-path BOLA.

> **`/posts/*` only reaches REST-exposed types.** Every route in `backend/src/routes/posts.ts` now checks `showInRest` on the post type: a load by id or slug answers **`404 rest_post_invalid_id`** for an internal type — the same answer as a post that does not exist, because an internal type is not "a post you lack permission for", it is not addressable here at all — and `GET /posts?type=…`, `POST /posts` and the slug lookup's `?type=` answer **`400 rest_invalid_post_type`**. `nav_menu_item`, `revision` and `attachment` are therefore reachable only through their own APIs (`/menus/*`, `/revisions/*`, `/media/*`), which carry the correct gate. Previously they fell through to the plain `post` capability family, so `edit_others_posts` alone let an **editor** rewrite `_menu_item_url` on every menu item (persistent phishing from the site's own origin), and `edit_posts` alone let a **contributor** mint `revision` rows against someone else's page — ten of which make the next ordinary save prune the entire genuine history, since `limitRevisions` deletes oldest-first and fabricated rows carry `now` as `post_modified` while real ones copy the parent's. The **list** is gated for the same reason as the item routes: leaving it open let a caller enumerate every `nav_menu_item` id and then write its meta without ever touching the menus API.

> **Server-owned post meta (protected keys).** Post meta is *not* a free-form key/value store on the write surfaces. `backend/src/core/protected-meta.ts` declares the keys only backend code may write — `_wp_attached_file`, `_wp_attachment_metadata`, `_wp_trash_meta_status`, `_wp_trash_meta_time`, `_edit_lock`, `_edit_last`, and `_wjs_revision_snapshot` (the F4 snapshot envelope, whose manifest is an executable restore instruction: a forged one would turn a later restore into an arbitrary core-column/meta write) — and **both** generic writers consult it: `POST /posts/:id/meta` answers `403 rest_protected_meta` (a single-key write is an explicit statement of intent, so answering `200` after writing nothing would be a lie), while the `meta` bag of `POST /posts` and `PUT /posts/:id` **skips** those keys and applies the rest. The reason is `_wp_attached_file`: it is the server's record of where an upload sits on disk and is exactly what `Media.delete()` turns into an `unlink()` target, so an author who could rewrite it on their own attachment held an arbitrary-file-delete primitive. Author-written keys that merely *look* internal — `_puck_data`, `_wjs_template`, `_thumbnail_id`, the SEO keys — are deliberately **not** on the list (the editor writes them through this same bag on every save); they are protected by the capability gate and `sanitize-meta.ts`, not by a key ban.

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
| `POST`   | `/me/sessions/revoke` | Session | "Sign me out everywhere": stamps the caller's security epoch, killing every JWT/cookie session **including the calling one**, and leaves their API tokens alone. Requires `currentPassword` through the same sudo helper as `PUT /me`. Audited as `user.sessions_revoked`. Declared before `/:id` |
| `GET`    | `/:id`      | Yes          | Get a user (self, or `list_users` for others)                     |
| `POST`   | `/`         | Admin        | Create a user (`username`, `email`, `password`, optional `role`)  |
| `PUT`    | `/:id`      | Yes†         | Update a user — layered authorization, see the note above         |
| `POST`   | `/:id/mfa/reset` | Session + `edit_users` | Clear another user's two-factor enrolment (every `mfa_*` key), so a locked-out account can log in with its password and re-enrol. Audited as `user.mfa_reset` |
| `DELETE` | `/:id`      | Admin        | Delete a user                                                     |

> **`POST /:id/mfa/reset` — why it is shaped like this.** It is the way **out** of a 2FA lockout: before it existed, an account someone else had enrolled could only be recovered by deleting and recreating it. Its gates mirror the sibling MFA routes: `sessionOnly` (a leaked `wjt_` token must never strip a second factor), the same `targetIsPrivileged` rule as `PUT /:id` (an `edit_users` delegate cannot disarm an administrator's 2FA and then attack their password), and **never self** — `400 rest_cannot_reset_own_mfa`, because an admin turning off their **own** 2FA must still go through `POST /auth/mfa/disable` with a current code. A sole administrator who loses their authenticator therefore still needs a second admin.

### 6.3 System & Extensions
| Method | Endpoint                  | Auth  | Description                           |
| :----- | :------------------------ | :---- | :------------------------------------ |
| `GET`  | `/settings`               | No    | Get public site settings (name, desc) |
| `GET`  | `/settings/all`           | Admin | Get all settings (admin view)         |
| `GET`  | `/settings/:key`          | No    | Get a single (public) setting         |
| `PUT`  | `/settings`               | Admin | Update site settings                  |
| `PUT`  | `/settings/:key`          | Admin | Update a single setting               |
| `GET`  | `/notices`                | Admin | List persistent admin notices (e.g. a plugin CrashGuard auto-disabled). Rendered at `/admin/notices` |
| `DELETE` | `/notices/:id`          | Admin | Dismiss one notice                    |
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
| `GET`/`POST` | `/plugins/:slug/egress-hosts` | Admin | Read / set a plugin's outbound host allowlist (only meaningful once `network` is granted). Body `{ hosts: [...] }`; **empty** = every public host allowed, **non-empty** = default-deny except those hosts and their subdomains. Setting it re-spawns the isolate so the child re-installs the list |
| `POST` | `/plugins/:slug/install-theme` | Admin | Install the companion theme a plugin bundles in its own `theme/` folder (optionally activating it); `404` if the plugin bundles none, `409` if the theme is already installed |
| `DELETE` | `/plugins/:slug`          | Admin | Uninstall a plugin. Body `{ password, dropData }`: password-confirmed, refuses an **active** plugin, always clears grants + crash strikes, and drops the plugin's `wjp_<slug>_` tables only when `dropData` is set |
| `GET`  | `/plugins/:slug/download`   | Admin | Download an installed plugin as a ZIP (`authenticateAllowQuery`: cookie/Bearer **or** a `?token=` query param) |
| `GET`  | `/plugins/:slug/port-conflicts` | Admin | Which process holds the ports the plugin's manifest claims, and whether WordJS can free them |
| `POST` | `/plugins/:slug/free-port`  | Admin | Body `{ port, allowDisable }`: disable the known system MTA squatting a **manifest-claimed** port (explicit consent required, else `409 CONSENT_REQUIRED`), then reload the plugin |
| `POST` | `/plugins/sample`           | Admin | Generate the `hello-world` sample plugin            |
| `GET`  | `/plugins/menus`            | Auth  | Admin-menu items contributed by active plugins. Any logged-in user; visibility is filtered **per capability** (`item.cap`, default `manage_options`), so non-admin roles only see items whose capability they hold |
| `GET`  | `/themes`                   | No    | List available themes (public)                      |
| `POST` | `/themes/upload`            | Admin | Install a theme from ZIP                            |
| `POST` | `/themes`                   | Admin | Create a theme from a declarative token contract (body carries `slug`, `tokens`, `styles`, …). `201 { slug, diagnostics }`; `400` with diagnostics on a compile error; `409` if the slug already exists |
| `PUT`  | `/themes/:slug`             | Admin | Rebuild an existing theme from its token contract. `200 { slug, version, diagnostics }`; `404` if unknown; `409` if the theme was not created by the WordJS writer |
| `POST` | `/themes/:slug/activate`    | Admin | Change active theme                                 |
| `POST` | `/themes/default`           | Admin | Restore (force-overwrite) the default theme         |
| `DELETE` | `/themes/:slug`           | Admin | Delete a theme                                      |
| `GET`  | `/themes/:slug/download`    | Admin | Download a theme as a ZIP                           |
| `GET`  | `/themes/:slug/doctor`      | Admin | Token-contract diagnostics for a theme; returns `{ available: false }` (fail-open) when the token manifest is absent |
| `GET`  | `/setup/status`             | No    | Check if site is installed (not token-gated)        |
| `POST` | `/setup/test-db`            | Token | Validate a DB connection before install (install-token gated) |
| `POST` | `/setup/install`            | Token | Run the installation wizard (install-token gated)   |
| `GET`  | `/export`                   | Admin | Download a logical site export (JSON)               |
| `GET`  | `/export/wxr`               | Admin | Export as WordPress WXR (XML)                       |
| `POST` | `/import`                   | Admin | Import a site from JSON (file upload or `data`)     |

> **Notices moved out of `/settings` (and why).** `/api/v1/notices` is the canonical path; `/api/v1/settings/notices` still resolves because the settings router **delegates to the same module** (one implementation, no drift). It had to move: `GET /settings/:key` is a wildcard registered before the old handler, Express matches in registration order, and the wildcard never consults the session — so every `GET /settings/notices` was answered as `key='notices'`, which is not in `PUBLIC_SETTINGS`, and returned `403 rest_forbidden` **to administrators**. The list was unfetchable, therefore the ids for `DELETE` were unknowable, therefore the autoloaded `admin_notices` option grew forever. A literal prefix must be mounted **before** a `/:param` sibling — the same remedy `routes/webhooks.ts` already applies.

> **Note:** A full **system-state backup** (code + assets + DB dump as a ZIP) is a separate engine under `/api/v1/backups/*` and `backend/src/core/backup.ts`, distinct from the logical `/export` above. All backup routes are admin-only (`backend/src/routes/backups.ts`): `GET /backups` (list), `POST /backups` (create), `GET /backups/:filename/download`, `POST /backups/:filename/restore`, `DELETE /backups/:filename`.

> **Install token (pre-install setup):** `POST /setup/install` and `POST /setup/test-db` run before the instance is configured (unauthenticated, CSRF-exempt), so they are gated by a **one-time install token** (`backend/src/core/install-token.ts`) — supply it via the `x-install-token` header or an `installToken` body field (constant-time compared; `403` on mismatch). The token is printed to the server console at boot, mirrored to a `0600` file in the data dir, and overridable via the `WORDJS_INSTALL_TOKEN` env var (≥ 16 chars). Both endpoints also early-return `400` once the site is installed, and the on-disk token mirror is cleared after a successful install. `GET /setup/status` is **not** token-gated; `POST /setup/migrate` instead requires admin username/password.

> **Plugin permissions (default-deny):** `POST /plugins/:slug/permissions` is the admin's source of truth for grants. An undeclared scope has no effect — `hasPermission` requires **both** the manifest declaration **and** the grant. Activating a plugin with no prior grant record pre-grants exactly its manifest-**declared** permissions, persisted only **after** activation + AST-scan succeed (a plugin that fails its scan leaves behind no grant record).

### 6.3.1 Plugin Marketplace 🛒
Base path: `/api/v1/marketplace` (`backend/src/routes/marketplace.ts`). Plugins are distributed **outside** the core build: the catalog is a `marketplace-index.json` (+ one sha256'd ZIP per plugin) built by `backend/scripts/build-marketplace.js` from `marketplace/plugins/` and published as **GitHub Release assets** (uploaded by `.github/workflows/release.yml`). The built-in default source is `https://github.com/jaimemartinez/wordjs/releases/latest/download` — **not** a `raw.githubusercontent.com/.../marketplace/dist` URL, which 404s (`marketplace/dist/` is a gitignored build output, present only in dev checkouts). All routes are admin-only (`authenticate` + `isAdmin`).

| Method | Endpoint   | Auth  | Description                                                                 |
| :----- | :--------- | :---- | :-------------------------------------------------------------------------- |
| `GET`  | `/catalog` | Admin | Merged catalog (all configured sources) annotated with local state (`installed`, `active`, `installedVersion`, `updateAvailable`, `updatable`, `installedFrom`). Also returns a `sources[]` array with per-source `ok`/`count`/`added`/`error` status. `?refresh=1` bypasses the in-memory cache. `502` if the catalog can't be fetched |
| `POST` | `/install` | Admin | Body `{ id }`: downloads the catalog entry's ZIP (from the source that entry was listed under), **sha256-verifies** it against the catalog, and installs it through the **same pipeline as `POST /plugins/upload`** (`installPluginFromZip`: zip-bomb budget, Zip Slip, slug validation, manifest + AST scan). `404` if the id isn't in the catalog; `400` on filename/sha256 failure; `502` on download failure |
| `POST` | `/update`  | Admin | **Same handler as `/install`** (mounted on both paths so any client works). When the plugin is already installed, either path performs an **in-place update** via `runPluginUpdate` — preserving `data/`, the plugin's tables and its grants — and refuses an update whose catalog entry comes from a different source than the one the plugin was installed from |
| `GET`  | `/sources` | Admin | The admin-configured source URLs (`{ configured, default, usingDefault }`) |
| `PUT`  | `/sources` | Admin | Body `{ sources: string[] }`: replace the source list. Each entry must be `https` (or `http://localhost` for dev), deduped, capped at 12; clears the catalog cache. Body `{ reset: true }` instead **forgets** the configured list entirely (back to the fallback chain) — distinct from saving an **empty** list, which is honored as "no sources at all" |
| `GET`  | `/themes/catalog` | Admin | The **theme** catalog, annotated with `installed`/`active`/`installedVersion`/`updateAvailable`. `?refresh=1`, `502` on failure |
| `POST` | `/themes/install` | Admin | Body `{ id }`: download + **sha256-verify** the catalog theme ZIP and install it through the hardened theme pipeline (`installThemeFromZip`) |
| `GET`/`PUT` | `/themes/sources` | Admin | Read / replace the **theme** source list (option `marketplace_theme_sources`) — independent from the plugin list, same `{ configured, default, usingDefault }` shape and same `reset` / empty-list semantics |

> **Catalog source resolution (admin-configurable, multi-source):** sources are resolved in order — (1) the `marketplace_sources` option, a JSON array of `https` catalogs managed from the Marketplace UI via `GET`/`PUT /marketplace/sources`; (2) the legacy single `marketplace_source` option (back-compat; may also be a local directory for dev / air-gapped installs); (3) the repo-local `marketplace/dist/` if present; (4) the built-in GitHub release default. Every configured source is fetched and **merged** (dedup by plugin `id`, earlier sources win) with **per-source error isolation** — one unreachable URL is reported as `ok:false` but never hides the rest. Remote fetches are `https` only (`http` allowed for localhost), downloaded ZIPs are capped at 10MB, and catalog filenames are validated against a strict `<slug>-<version>.zip` shape. Themes use the **same** chain against `marketplace-themes-index.json`, minus the legacy single-option step.

> **Catalog caching:** the merged catalog is cached in memory, keyed by the ordered source set. A **remote** source is keyed by its URL alone and keeps the **5-minute TTL** (the TTL is what protects the network). A **local** source is additionally stamped with its index file's **mtime + size**, so a `npm run build:marketplace` changes the key and the next browse reads fresh — without that, a stale index advertised a ZIP filename that no longer existed and the failure surfaced three steps later, at theme activation.

### 6.4 Analytics System 📊
| Method | Endpoint           | Auth  | Description                        |
| :----- | :----------------- | :---- | :--------------------------------- |
| `POST` | `/analytics/track` | No    | Log a page view or event. Own per-IP limiter (**60/min**), hard input bounds, and a retention prune — see below |
| `GET`  | `/analytics/stats` | Admin | Get aggregated stats for dashboard (`?period=weekly` \| `monthly`, default `weekly`) |

> **`POST /analytics/track` writes a permanent row for an anonymous caller**, so it carries the same three-part posture as every other public write surface, not just the generic ceilings:
> *   **Its own per-IP bucket** (60/min, mounted on the exact route in `backend/src/index.ts`). Previously its only limits were `express.json`'s 10 MB body cap and the global `apiLimiter` (1000/15 min), which bound *traffic*, not stored bytes — roughly 40 GB/hour of undeletable rows from a single IP, and in monolith mode a full disk takes down backend, frontend and database together.
> *   **Hard input bounds checked before any DB work** (`backend/src/routes/analytics.ts`): the event type is an **allowlist** rather than a length check; `metadata` must be a flat object of ≤ 20 string/number/boolean values, key ≤ 60 chars, value ≤ 200 chars, ≤ 2 KB serialized. Violations answer a real `400 rest_invalid_param`. `resource` is the exception: a non-string is refused, but an over-long one is **truncated** to 255 chars rather than rejected — it does not choose the row's meaning and it is not the volume lever, while one ordinary campaign URL (UTM parameters plus an `fbclid`/`gclid`) sails past 255, and the beacon ignores the response, so refusing it silently deleted exactly the paid traffic.
> *   **Retention** (`backend/src/core/analytics-retention.ts`): a daily cron prunes rows older than the `analytics_retention_days` option (**default 90**; `0` disables pruning). The delete is driven by `created_at`, which `idx_analytics_date` already indexes, and runs in 5000-row batches so a long-neglected table drains across several passes instead of one write transaction that blocks every writer. A run stops at whichever cap it reaches first: **691,200 rows** — derived from the write side (the analytics limiter's 60 events/min/IP × 24 h × 8 concurrent abusive sources) so the prune can outrun the ingest — or **60 seconds** of wall clock. Stopping at a cap with rows still outside the window is recorded as `behind` in the module's `retentionState()` and warned about in the cron log, rather than passing for a healthy run.


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

> **A restore is a post write, and now says so.** `core/revisions.restoreRevision` used to write raw SQL inside a transaction and stop — no cache invalidation, no `post_updated`. That was not mere staleness but **incoherence**: `Post.toJSON()` reads the row from cache and the meta from the database, so the response to the restore itself mixed the pre-restore `title`/`content` with the post-restore `_puck_data`, and the request had just seeded that cache entry one call earlier even if it was cold. The public page never revalidated (`core/frontend-purge` hangs off `post_updated`) and the `post.updated` webhook never fired. Worst case was real data loss: the author reopened the editor, was served the **old** cached body, fixed a typo and saved the restore away. After the commit it now runs the same invalidation helpers as `Post.update` and dispatches `post_updated`, so a restore is indistinguishable from any other write to every downstream listener.

> **A restore only moves fields frozen into that snapshot.** F4 stores a protected, versioned manifest with the content schema version/fingerprint, codec and each declared field/storage target. Plugin fields with `revisioned: true` therefore need no core edit, and disabling or upgrading the plugin cannot reinterpret old history. Declared metadata absent from the snapshot is cleared; fields outside the frozen list remain untouched. Values are stored and re-inserted as raw `meta_value` bytes rather than round-tripped through `JSON.parse`/`String`. Revisions created before F4 have no manifest and always use the immutable compatibility set: title, content, excerpt, `_puck_data`, `_wjs_template`, `_thumbnail_id`, `seo_title`, `seo_description`, `og_image`, `noindex`.

> **Revision responses describe their restore boundary.** `GET /revisions/post/:postId` and `GET /revisions/:id` add `restore.compatible`, `legacy`, schema/codec versions, schema fingerprint and generated field descriptions. The editor uses this data for the destructive confirmation, including plugin fields and absent fields that will be cleared. An invalid or unavailable codec is listable but not restorable; restore returns `409` before writing.

### 6.8 Prometheus Metrics 📈
A Prometheus scrape endpoint is served at the **root path** `GET /metrics` (`backend/src/core/metrics.ts`). It exposes the default Node/process metrics (`wordjs_`-prefixed: CPU, RSS/heap, event-loop lag, GC, handles) plus a `wordjs_sse_clients` gauge (active SSE clients on this node) and a `wordjs_ready` gauge.

| Method | Endpoint   | Auth         | Description                                  |
| :----- | :--------- | :----------- | :------------------------------------------- |
| `GET`  | `/metrics` | Scrape token | Prometheus text-format metrics for this node |

*   **Disabled by default:** the endpoint returns **`404`** unless a scrape token is configured at `config.metrics.token` (in `wordjs-config.json`) or via the `METRICS_TOKEN` env var. With no token, metrics are never exposed.
*   **Auth:** scrape with `Authorization: Bearer <token>` (**header-only** — a `?token=` query param is **not** accepted, to keep the long-lived secret out of access logs / history); a missing/incorrect token returns `401` (constant-time compare). It is mounted at root level — CSRF-free and not rate-limited.
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

### 6.10 Outgoing Webhooks 🪝
Base path: `/api/v1/webhooks` (`backend/src/routes/webhooks.ts`; core `backend/src/core/webhooks.ts`, models `Webhook.ts`/`WebhookDelivery.ts`). WordJS fans **content events** (e.g. `post.published`) out to admin-registered HTTP endpoints. Every delivery is **HMAC-signed** with the webhook's per-endpoint secret and **SSRF-safe** — the destination host is IP-validated **at delivery time**, so loopback / link-local (incl. the cloud-metadata address) / RFC1918 targets are rejected. The whole resource is **admin-only** (`authenticate` + `isAdmin`); all **mutations** are additionally **session-only** (an `Authorization: Bearer wjt_…` API token is rejected, so a leaked token can't plant an exfiltration endpoint or rotate a secret). Delivery is subscribed to content hooks and polled by `initWebhooks()` at boot.

| Method   | Endpoint                            | Auth  | Description                                                        |
| :------- | :---------------------------------- | :---- | :---------------------------------------------------------------- |
| `GET`    | `/events`                           | Admin | The subscribable content-event catalog (`Webhook.EVENTS`)          |
| `GET`    | `/`                                 | Admin | List all webhooks                                                  |
| `POST`   | `/`                                 | Admin (session) | Create a webhook. Body `{ name?, url, events?, active? }`; the signing **secret is returned once** (`201`). Capped at 100 webhooks |
| `GET`    | `/:id`                              | Admin | Get one webhook                                                    |
| `PATCH`  | `/:id`                              | Admin (session) | Update `name`/`url`/`events`/`active`                    |
| `DELETE` | `/:id`                              | Admin (session) | Delete a webhook                                          |
| `POST`   | `/:id/rotate-secret`                | Admin (session) | Rotate the signing secret (returned **once**)            |
| `GET`    | `/:id/deliveries`                   | Admin | Recent delivery attempts for a webhook (audit log)                 |
| `POST`   | `/deliveries/:deliveryId/redeliver` | Admin (session) | Re-queue a specific delivery for another attempt         |

### 6.11 Roles & Capabilities 🛡️
Base path: `/api/v1/roles` (`backend/src/routes/roles.ts`). Every route is `authenticate` + `isAdmin`. Roles live in the `wordjs_user_roles` option (§2.3).

| Method   | Endpoint        | Auth  | Description                                                                 |
| :------- | :-------------- | :---- | :-------------------------------------------------------------------------- |
| `GET`    | `/`             | Admin | All roles with their capability sets                                        |
| `GET`    | `/capabilities` | Admin | Every capability identifier known to the system (core + plugin-contributed) — the checklist the Roles UI renders |
| `GET`    | `/:slug`        | Admin | One role; `404 rest_role_invalid_id` if unknown                             |
| `POST`   | `/`             | Admin | Create **or overwrite** a role. Body `{ slug, name, capabilities }`; `400 rest_missing_param` without `slug`+`name`; returns `201` with the stored role |
| `DELETE` | `/:slug`        | Admin | Delete a role. The five core roles (`administrator`, `editor`, `author`, `contributor`, `subscriber`) are refused with `400 rest_role_protected` |

### 6.12 Menus 🧭
Base path: `/api/v1/menus` (`backend/src/routes/menus.ts`). Reads are public (`optionalAuth`); every mutation is `authenticate` + `isAdmin`. Item URLs are scheme-validated on create **and** update (see the note in §6.2).

| Method   | Endpoint               | Auth   | Description                                                        |
| :------- | :--------------------- | :----- | :----------------------------------------------------------------- |
| `GET`    | `/`                    | Opt.   | List menus                                                         |
| `GET`    | `/locations`           | No     | The registered theme menu locations                                |
| `GET`    | `/:id`                 | Opt.   | One menu with its items                                            |
| `GET`    | `/location/:location`  | Opt.   | The menu assigned to a location (what the public shell reads)      |
| `POST`   | `/`                    | Admin  | Create a menu. Body `{ name, slug?, description? }`                |
| `PUT`    | `/:id`                 | Admin  | Rename / re-slug a menu                                            |
| `DELETE` | `/:id`                 | Admin  | Delete a menu                                                      |
| `POST`   | `/:id/location`        | Admin  | Assign the menu to a location. Body `{ location }`                 |
| `POST`   | `/:id/items`           | Admin  | Add an item. Body `{ title, url, target, type, objectId, parent, order, classes }` |
| `PUT`    | `/items/:itemId`       | Admin  | Update one item (note: **not** nested under the menu id)           |
| `DELETE` | `/items/:itemId`       | Admin  | Delete one item                                                    |

### 6.13 Widgets & Sidebars 🧱
Base path: `/api/v1/widgets` (`backend/src/routes/widgets.ts`; core `backend/src/core/widgets.ts`, see §12). Reads are public; every mutation is `authenticate` + `isAdmin`.

| Method   | Endpoint                            | Auth  | Description                                                     |
| :------- | :---------------------------------- | :---- | :--------------------------------------------------------------- |
| `GET`    | `/`                                 | No    | Registered widget types (`id`, `name`, `description`)            |
| `GET`    | `/sidebars`                         | No    | Registered sidebars, each with its resolved widget instances     |
| `GET`    | `/sidebars/:id/render`              | No    | Server-rendered **HTML** of a sidebar (`text/html`, not JSON)    |
| `POST`   | `/sidebars/:id`                     | Admin | Add a widget instance to a sidebar. Body `{ widgetId, settings }` |
| `POST`   | `/sidebars/:id/reorder`             | Admin | Reorder a sidebar. Body `{ widgets: [instanceKey, …] }`          |
| `DELETE` | `/sidebars/:sidebarId/:instanceKey` | Admin | Remove one instance from a sidebar                              |
| `PUT`    | `/:widgetId/instances/:instanceId`  | Admin | Update one instance's settings. Body `{ settings }`              |

### 6.14 Post Types 🗂️
Base path: `/api/v1/types` (`backend/src/routes/post-types.ts`). Reads are public; mutations are `authenticate` + `isAdmin`.

| Method   | Endpoint  | Auth  | Description                                                                    |
| :------- | :-------- | :---- | :----------------------------------------------------------------------------- |
| `GET`    | `/`       | No    | Registered post types. Returns only types with `showInRest: true`; `?rest=false` inverts the filter and returns only the types **not** exposed in the REST API |
| `GET`    | `/schemas` | No   | The declarative F1 content schemas, filtered by the same `?rest=` rule as `GET /` |
| `GET`    | `/:name/schema` | No | The F1 content schema for one type; `404` when the type has none. Declared **before** `/:name` |
| `GET`    | `/:name`  | No    | One post type                                                                  |
| `POST`   | `/`       | Admin | Register a **custom** post type. Body `{ name, label?, labels?, supports?, taxonomies?, … }`; `400` without `name`, `409` if it already exists (`supports` defaults to `['title','editor']`) |
| `DELETE` | `/:name`  | Admin | Delete a custom post type; `400` for one that cannot be deleted (e.g. a built-in) |

### 6.15 Fonts 🔤
Base path: `/api/v1/fonts` (`backend/src/routes/fonts.ts`). Files live under `<uploads>/fonts/` and are served from `/uploads/fonts/<file>`.

| Method   | Endpoint      | Auth             | Description                                                                |
| :------- | :------------ | :--------------- | :-------------------------------------------------------------------------- |
| `GET`    | `/`           | Opt.             | Flat array of the installed fonts (`.ttf`/`.otf`/`.woff`/`.woff2`/`.eot`), each `{ filename, family, variant, url, size, modified, protected }` with family/variant parsed from the filename, sorted protected-first then family then variant. `url` is **origin-relative** (`/uploads/fonts/…`) on purpose — an absolute URL embeds the upload-era host and breaks `@font-face` on any other origin. This is the read the SSR `@font-face` injection and the editor font pickers use |
| `POST`   | `/`           | `manage_options` | Upload a font (`multipart`, single file); `201 { file, url }`, `400` without a file |
| `DELETE` | `/:filename`  | `manage_options` | Delete a font (basename-only, so no traversal); bundled system fonts are refused with `403` |

### 6.16 SEO Endpoints 🔎
Base path: `/api/v1/seo` (`backend/src/routes/seo.ts`). The three public documents are what the gateway (and the monolith's local middleware) rewrite the pretty root paths onto — `/sitemap.xml`, `/robots.txt` and `/feed` \| `/feed.xml` \| `/rss.xml`.

| Method | Endpoint         | Auth         | Description                                            |
| :----- | :--------------- | :----------- | :------------------------------------------------------ |
| `GET`  | `/sitemap.xml`   | No           | XML sitemap of published content                       |
| `GET`  | `/robots.txt`    | No           | `robots.txt` (points at the sitemap)                   |
| `GET`  | `/feed.xml`      | No           | RSS feed                                               |
| `GET`  | `/meta/:postId`  | `edit_posts` | The SEO meta an editor sees for one post               |

### 6.17 Health Probes ❤️
Two different things share the word "health". The **root** probes are for orchestrators and the gateway; the `/api/v1/health` pair is the app-level report.

| Method | Endpoint                | Auth  | Description                                                                 |
| :----- | :---------------------- | :---- | :-------------------------------------------------------------------------- |
| `GET`  | `/healthz`              | No    | Liveness (root path). Never touches the DB                                  |
| `GET`  | `/readyz`               | No    | Readiness (root path). `503` `setup_required` / `starting` / `not_ready` until the instance is installed, `appReady` is set, and the DB answers |
| `GET`  | `/health`               | No    | Root-path health summary                                                    |
| `GET`  | `/api/v1/health`        | No    | Database reachability (`{ status: 'ok' \| 'error' }`)                        |
| `GET`  | `/api/v1/health/details`| Admin | Full system status: `{ database, mtls, filesystem, sandbox, purge, contentOutbox, timestamp }`. `sandbox.kernel` reports the native Landlock/AppContainer/Seatbelt state, `sandbox.network` the certified network-policy state, and `sandbox.permission` the Node capability floor. `purge.broken` lists the permanent failures that have killed on-demand cache invalidation in this process. `contentOutbox` reports the F3 durable event queue (`pending`, `processing`, `dead`, `oldestDue`, `delayedSeconds`) — `ERROR` on any dead row, `DEGRADED` past 300s of delay. See `documentation/deployment.md` |

### 6.18 Hooks Introspection 🪝
Base path: `/api/v1/hooks` (`backend/src/routes/hooks.ts`). Both routes are `authenticate` + `isAdmin`. This is the **introspection** surface for the action/filter system of §3 — not to be confused with the outgoing `/webhooks` resource of §6.10.

| Method | Endpoint   | Auth  | Description                                              |
| :----- | :--------- | :---- | :-------------------------------------------------------- |
| `GET`  | `/`        | Admin | Every registered action/filter with its callbacks         |
| `GET`  | `/stream`  | Admin | SSE stream of hook activity (`text/event-stream`)         |

### 6.19 Notifications 🔔
Base path: `/api/v1/notifications` (`backend/src/routes/notifications.ts`). All routes require a session; the single-item mutators are **owner-scoped** (a uuid is not a capability), so a caller can only touch their own rows — plus broadcasts (`user_id = 0`), which any user may dismiss.

| Method   | Endpoint        | Auth                     | Description                                                        |
| :------- | :-------------- | :----------------------- | :----------------------------------------------------------------- |
| `GET`    | `/stream`       | `authenticateAllowQuery` | SSE push stream — accepts the cookie/Bearer **or** a `?token=` query param, because `EventSource` cannot set headers |
| `GET`    | `/`             | Yes                      | Bounded list: unread first, plus the 5 most recent read            |
| `POST`   | `/:uuid/read`   | Yes                      | Mark one read; `404` if it isn't the caller's                      |
| `POST`   | `/read-all`     | Yes                      | Mark every one of the caller's notifications read                  |
| `DELETE` | `/:uuid`        | Yes                      | Delete one; `404` if it isn't the caller's                         |

The transports, cluster bus and plugin-facing `wordjs.notify(...)` bridge are documented in `documentation/notifications.md`.

### 6.20 Forms & Editing Presence 📝
Base paths `/api/v1/forms` (`backend/src/routes/forms.ts`) and `/api/v1/presence` (`backend/src/routes/presence.ts`).

| Method   | Endpoint              | Auth             | Description                                                            |
| :------- | :-------------------- | :--------------- | :---------------------------------------------------------------------- |
| `POST`   | `/forms/submit`       | No               | The **public** endpoint a page's form block posts to. Body `{ formName, pageId?, fields }` |
| `GET`    | `/forms/submissions`  | `manage_options` | Paginated submissions (`formName`, `page`, `per_page` — capped at 100)  |
| `DELETE` | `/forms/submissions/:id` | `manage_options` | Delete one submission                                               |
| `GET`    | `/forms/names`        | `manage_options` | The distinct form names seen so far (the viewer's filter picker)       |
| `POST`   | `/presence/:postId`   | Per-post edit gate | Editing-presence heartbeat (or `{ action: "leave" }`); answers with the **other** active editors. In-memory, 25s TTL. `400` for a malformed `postId`, `403 rest_forbidden` otherwise — see the note below |

> **Public-endpoint posture (`POST /forms/submit`), in order:** a per-IP rate limit (10/min, mounted in `backend/src/index.ts`); hard input bounds (≤30 fields, keys ≤60, values ≤5000 chars, ≤64KB total) checked **before** the honeypot so a bot sees byte-identical behavior either way; the `_hp` honeypot field, which returns the **exact** success payload while storing nothing; and tag-stripping of stored values so a submission can never carry markup into the admin viewer. Submissions can contain visitor PII, which is why the viewer is `manage_options` rather than an editor-level read.

> **Presence is a soft-lock signal, not co-editing.** State is per-process and in-memory on purpose, so on a multi-node backend each node only sees its own editors — the warning can *miss*, it can never false-positive.

> **Presence authorizes by the post, not by the capability family.** The heartbeat is gated on `authenticate` plus `isRestExposedPostType` + `canEditPostRecord(req.user, post)` (§6.2) — the same per-row gate `PUT /posts/:id` uses — not on the global `edit_posts` capability. A contributor holding `edit_posts` could otherwise sweep post ids to learn who had which private draft open, and inject their own display name into a post they cannot read. "No such post" and "you may not edit it" answer the **same** `403 rest_forbidden`, so the endpoint is not an existence oracle over other authors' drafts. `{ action: "leave" }` is handled **before** the gate: it can only remove the caller's own entry and always answers `{ ok: true, editors: [] }`, so refusing a withdrawal would only strand a stale name in everyone else's chip.

### 6.21 Internal (gateway-only) 🔒
Base path `/api/internal` — note this is **outside** the `/api/v1` prefix, so it carries none of the API middleware chain (`backend/src/routes/internal.ts`).

| Method | Endpoint           | Auth               | Description                                                        |
| :----- | :----------------- | :----------------- | :----------------------------------------------------------------- |
| `POST` | `/gateway-update`  | `x-gateway-secret` | The gateway telling the backend its public port changed. Body `{ gatewayPort }` |

The secret is compared in **constant time** and a request is refused when no secret is configured (rather than matching an empty default); `401` on mismatch, `400` on a missing/out-of-range port. A port identical to the current one is acknowledged **without** restarting, so a flood of repeats can't force a restart loop; a real change is persisted and the process exits so the supervisor respawns it.

> **Not an endpoint:** `backend/src/routes/frontend.ts` (the legacy Handlebars public renderer) is **deliberately not mounted** — the public site is rendered by Next.js in both split and monolith mode. It stays on disk only as a legacy/monolith-render fallback (`backend/src/index.ts`).

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


## 13. Developing Extensions

### 13.1 Creating Endpoints
Use the `asyncHandler` wrapper to automatically catch Promise rejections.

```javascript
const express = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');

router.get('/my-endpoint', asyncHandler(async (req, res) => {
    const data = await complexDbOp();
    res.json(data);
}));
```

### 13.2 Security Best Practices
*   **Sanitize:** Use `sanitize-html` for any HTML input.
*   **Validate:** Check all `req.body` params.
*   **Zip Slip:** Use the provided validation middleware for file uploads.
*   **Rate Limit:** Apply `uploadLimiter` for any file handling routes.

---

## 14. Developer Cheatsheet (Cookbook) 🧑‍🍳

Quick copy-paste snippets for common tasks.

### 14.1 How to... Add a New API Endpoint
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

### 14.2 How to... Save/Load Settings
Use the global Options API.
```javascript
const { getOption, updateOption } = require('../../src/core/options');

// Save
updateOption('my_plugin_color', '#ff0000');

// Load (with default)
const color = getOption('my_plugin_color', '#000000');
```

### 14.3 How to... Hook into Events
Run code when something happens (e.g., a post is saved).
```javascript
const { addAction } = require('../../src/core/hooks');

addAction('wp_insert_post', (postId, data) => {
    console.log(`Post saved: ${data.post_title}`);
    // Do custom logic here (e.g. send email)
});
```

### 14.4 How to... Fetch Data in React (Admin)
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
