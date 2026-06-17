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
    *   `Worker Isolation`: Every plugin runs in a `worker_threads` isolate and reaches the host only through the permission-checked `wordjs` capability bridge. Two server-side trust tiers (untrusted/sandboxed vs operator-trusted) gate DB scope, secret options, route mounting, and outbound network. See `documentation/plugins.md` / `documentation/security.md`.
5.  **Routing:** `backend/src/routes/index.ts` dispatches to controllers.
6.  **Controller/Handler:** Executes business logic, interacts with Models/DB.
7.  **Response:** JSON response sent back.

### 1.2 Database Abstraction
WordJS loads a database **driver** behind a common interface (`backend/src/drivers/interface.ts`: `connect/get/all/run/exec/close`). Drivers are selected by `db.driver` (in `wordjs-config.json`) via the DB manager in `backend/src/config/database.ts`.
*   **Default:** `sqlite-native` (file-based SQLite via `better-sqlite3`), ideal for "Zero Config". File: `backend/data/wordjs-native.db`.
*   **Automatic fallback:** `sqlite-legacy` (pure-JS WASM `sql.js`, file `backend/data/wordjs.db`) — used only when a SQLite driver fails to load (e.g. the native binary is missing). It reads the same SQLite file format.
*   **PostgreSQL:** `postgres` driver (the `pg` client). Embedded Postgres is **opt-in** via `db.embedded: true` (the old `db.port == 5433` heuristic is deprecated); `embedded-postgres` is an optional dependency.
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
    *   Lifecycle: Expiration defaults to 7 days (configurable in `.env`). Refresh via `POST /auth/refresh` (re-issues the cookie).
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

*   **Logic:** `backend/src/core/roles.js` manages the abstraction.
*   **Discovery:** The system automatically aggregates all unique `cap` identifiers registered by plugins via `adminMenu.js`. These are then presented as toggleable options in the Roles Management UI.
*   **Initialization:** Default roles are seeded during installation but can be modified via the Roles UI.
*   **Capabilities:** Users' capabilities are resolved at runtime based on their assigned role in the `roles` manager.

Default roles include:
*   **Administrator:** `*` (All capabilities).
*   **Editor:** `publish_posts`, `edit_others_posts`, etc.
*   **Author:** `publish_posts`, `edit_posts`.
*   **Contributor:** `edit_posts` (cannot publish).
*   **Subscriber:** `read` only.

---

## 3. The Hook System (Actions & Filters)

WordJS implements a WordPress-style Event-Driven Architecture via `backend/src/core/hooks.js`.

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
*   `rest_api_init`: Fired when registering routes (ideal for plugins).
*   `save_post`: Fired after a post is created/updated.

---

## 4. Models & Data Access

Models wrap database operations. Located in `backend/src/models/`.

### 4.1 User Model (`User.js`)
*   **Meta Data:** Supports arbitrary key-value storage via `user_meta` table.
*   **Methods:** `User.create()`, `User.authenticate()`, `user.can()`.

### 4.2 Options API (`core/options.js`)
Global key-value store for system settings.
*   `getOption(key, default)`
*   `updateOption(key, value)` - Auto-serializes JSON.

---

## 5. Standardized Error Handling

All errors should follow the structure defined in `backend/src/middleware/errorHandler.js`.

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
- **System**: `/settings`, `/plugins`, `/themes`, `/menus`, `/fonts`, `/health`, `/seo`, `/hooks`, `/notifications`, `/system/certs`.
- **Observability**: `/metrics` (Prometheus, root-path, scrape-token-gated — see §6.8).
- **Extensions**: `/widgets`, `/types` (Post Types), `/revisions`.
- **Data**: `/export`, `/export/wxr`, `/import`, `/backups`, `/db-migration` (engine migration & embedded Postgres).

### 6.2.1 Authentication Flow (JWT)
1. **Login**: `POST /auth/login` -> sets the `wordjs_token` HttpOnly cookie and returns `{ user }`.
2. **Authorize**: the cookie is sent automatically; an `Authorization: Bearer <token>` header is also accepted.
3. **Session**: Token expires in 7 days (default). Refresh via `POST /auth/refresh`; `POST /auth/logout` clears the cookie and revokes the token (`token_valid_after`).

### 6.2 Content & Taxonomy
| Method   | Endpoint            | Auth  | Description                                      |
| :------- | :------------------ | :---- | :----------------------------------------------- |
| `GET`    | `/posts`            | Opt.  | List posts (filters: `type`, `status`, `author`) |
| `GET`    | `/posts/:id`        | Opt.  | Get post details by ID                           |
| `GET`    | `/posts/slug/:slug` | Opt.  | Get post details by URL slug                     |
| `POST`   | `/posts`            | Admin | Create a new post/page                           |
| `PUT`    | `/posts/:id`        | Admin | Update an existing post                          |
| `DELETE` | `/posts/:id`        | Admin | Move post to trash / Delete                      |
| `GET`    | `/categories`       | No    | List all categories                              |
| `POST`   | `/categories`       | Admin | Create a new category                            |
| `GET`    | `/tags`             | No    | List all tags                                    |
| `GET`    | `/media`            | JWT   | List library items                               |
| `POST`   | `/media`            | Admin | Upload a new media file                          |

> **Pagination:** `GET /posts` returns `X-WP-Total` and `X-WP-TotalPages` response headers. These now reflect the **filtered** list: `Post.count()` shares a `buildWhere()` with `findAll` (and defaults `status` to `publish`), so the totals match the rows actually returned.

### 6.3 System & Extensions
| Method | Endpoint                  | Auth  | Description                           |
| :----- | :------------------------ | :---- | :------------------------------------ |
| `GET`  | `/settings`               | No    | Get public site settings (name, desc) |
| `PUT`  | `/settings`               | Admin | Update site settings                  |
| `GET`  | `/plugins`                  | Admin | List all installed plugins                          |
| `POST` | `/plugins/upload`           | Admin | Install a plugin from ZIP (AST-scanned at install)  |
| `POST` | `/plugins/:slug/activate`   | Admin | Activate a plugin                                   |
| `POST` | `/plugins/:slug/deactivate` | Admin | Deactivate a plugin                                 |
| `POST` | `/plugins/:slug/trust`      | Admin | Toggle the privileged "trusted" tier (`{ trusted }`); hot-reloads the worker. First-party defaults return `409` |
| `DELETE` | `/plugins/:slug`          | Admin | Uninstall a plugin                                  |
| `GET`  | `/themes`                   | Admin | List available themes                               |
| `POST` | `/themes/:slug/activate`    | Admin | Change active theme                                 |
| `GET`  | `/setup/status`             | No    | Check if site is installed                          |
| `POST` | `/setup/install`            | No    | Run the installation wizard                         |
| `GET`  | `/export`                   | Admin | Download a logical site export (JSON)               |
| `GET`  | `/export/wxr`               | Admin | Export as WordPress WXR (XML)                       |
| `POST` | `/import`                   | Admin | Import a site from JSON (file upload or `data`)     |

> **Note:** A full **system-state backup** (code + assets + DB dump as a ZIP) is a separate engine under `/api/v1/backups/*` and `backend/src/core/backup.ts`, distinct from the logical `/export` above.

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
| `POST` | `/auto-provision` | Admin | Request Let's Encrypt HTTP-01 certificate   |
| `POST` | `/dns-start`      | Admin | Start DNS-01 challenge (returns TXT record) |
| `POST` | `/dns-check`      | Admin | Verify DNS TXT record propagation           |
| `POST` | `/dns-finish`     | Admin | Complete DNS-01 challenge and save cert     |
| `POST` | `/upload-custom`  | Admin | Upload custom `.pem` files                  |

### 6.6 Database Admin / Engine Migration 🗄️
Base path: `/api/v1/db-migration`. This is **core infrastructure** (formerly the `db-migration` plugin, now `backend/src/core/db-admin/`) — it manages the DB lifecycle and migrates content between engines (e.g. SQLite ↔ PostgreSQL). All routes require `authenticate` + the `manage_options` capability.

| Method | Endpoint             | Auth          | Description                                            |
| :----- | :------------------- | :------------ | :---------------------------------------------------- |
| `GET`  | `/status`            | manage_options | Migration status + detected legacy DB files          |
| `POST` | `/migrate`           | manage_options | Migrate site content to the target engine            |
| `POST` | `/cleanup`           | manage_options | Remove leftover legacy DB files after a migration    |
| `GET`  | `/embedded/status`   | manage_options | Embedded PostgreSQL server status                    |
| `POST` | `/embedded/install`  | manage_options | Install the embedded PostgreSQL binaries (opt-in)    |
| `POST` | `/embedded/start`    | manage_options | Start the embedded PostgreSQL server                 |
| `POST` | `/embedded/stop`     | manage_options | Stop the embedded PostgreSQL server                  |

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

---

## 8. Cron System ⏰

WordJS includes a robust scheduling system similar to `wp-cron`, located in `backend/src/core/cron.js`.

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

WordJS supports native translation via `backend/src/core/i18n.js`. It uses JSON files located in `backend/languages/`.

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

Shortcodes allow users to inject dynamic content into posts/pages using `[tag]` syntax. Handled by `backend/src/core/shortcodes.js`.

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

WordJS features a powerful **Full System State Backup** engine located in `backend/src/core/backup.ts`. unlike traditional CMS backups that only save the database, WordJS creates a portable, self-contained snapshot of the entire application.

### 11.1 What is included?
 The backup zip file represents the **entire backend directory state**, ensuring a 1:1 restoration.
*   **Source Code:** `src/`, `server.js`, `package.json`.
*   **Content:** `uploads/` (images, videos), `languages/`.
*   **Extensions:** `plugins/`, `themes/`.
*   **Configuration:** `.env` (sensitive vars), `wordjs-config.json`.
*   **Database:** A logical dump (`wordjs-content.json`) is generated and added to ensure data integrity across versions.

**Excluded:**
*   `node_modules/`: Re-generated via `npm install`.
*   `backups/`: Preventing recursive loops.
*   `logs/`, `os-tmp/`, `.git/`.

### 11.2 Key Functions
*   `createBackup()`: Scans the root directory, filters exclusions, and generates a timestamped ZIP.
*   `restoreBackup(filename)`:
    1.  **Physical Restore:** Extracts files, overwriting the current system (code + assets).
    2.  **Logical Restore:** Parses `wordjs-content.json` and rebuilds the SQLite database using `importSite()`.
*   `listBackups()`: Returns available backup files from `backend/backups/` (newest first).
*   `deleteBackup(filename)`: safely removes a backup file.
*   `pruneBackups(keep?)`: **Retention pruning.** Keeps only the newest `keep` backups and deletes the rest. `createBackup()` calls it automatically after every backup so scheduled/auto backups don't fill the disk unbounded. When `keep` is omitted it is read from the `backup_retention` option (**default 7**); set `backup_retention` to `0` (or any value ≤ 0) to disable pruning and keep all backups.

> **Retention:** Backups still live **on-host** in `backend/backups/`; off-host / S3 storage is roadmap. The only automatic cleanup is the retention prune above.

### 11.3 Import/Expert (Logical Data Only)
Located in `backend/src/core/import-export.js`.
*   `exportSite(options)`: Generates the JSON dump used inside full backups. Can also return WXR (WordPress XML).
*   `importSite(data, options)`: The engine that consumes the JSON dump to populate the DB.

---

## 12. Widgets System 🧱

The Widgets API (`backend/src/core/widgets.js`) allows plugins to register dynamic content blocks for Sidebars and Footers.

### 12.1 Registering a Widget
```javascript
const { registerWidget } = require('../../src/core/widgets');

registerWidget('clock_widget', {
    name: 'Analog Clock',
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

addAction('save_post', (post) => {
    console.log(`Post saved: ${post.post_title}`);
    // Do custom logic here (e.g. send email)
});
```

### 7.4 How to... Fetch Data in React (Admin)
**CRITICAL:** Always include the token!
```javascript
const getData = async () => {
    const token = localStorage.getItem("wordjs_token");
    const res = await fetch('/api/v1/my-plugin/hello', {
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    console.log(data);
};
```
