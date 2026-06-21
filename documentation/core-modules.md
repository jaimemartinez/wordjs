# Core Modules Reference 🧩

This document details the internal core modules of WordJS that handle critical system functions like stability, security, and database management.

## 1. CrashGuard 🛡️

**Location:** `backend/src/core/crash-guard.ts`

CrashGuard is a stability mechanism designed to prevent "Boot Loops" caused by faulty plugins. It is **CrashGuard v2.0**, combining boot-time detection with a runtime blame system.

### Boot-time detection (3-Strike Rule)
1.  **Pre-Load:** Before a plugin is activated, `startLoading(slug)` synchronously writes a lock file to `backend/data/plugin_boot.lock` (sync so it hits disk before a potential crash).
2.  **Post-Load:** If the plugin loads successfully, `finishLoading(slug)` deletes the lock **and clears the plugin's strike counter**.
3.  **Crash Detection:** On next boot, `checkPreviousCrash()` checks for a leftover lock file.
4.  **Recovery (3 strikes):** A crash adds a strike (persisted in `backend/data/plugin_strikes.json`). The guilty plugin is **not** disabled on the first or second strike — it is retried, on the assumption the crash might have been a power outage or transient fault. Only after `MAX_STRIKES` (3) does it return `shouldDisable: true` and the plugin is disabled.

### Runtime blame system
*   `installRuntimeBlameHandlers()` installs `uncaughtException` / `unhandledRejection` handlers early in startup.
*   On an async error, `extractPluginFromStack()` walks the stack for a `/plugins/<slug>/` (or `/themes/<slug>/`) frame and `blamePlugin()` writes `backend/data/runtime_crash.lock`.
*   A runtime crash is treated as an **immediate disable** on the next restart (we're already past boot).
*   **Attribution caveat:** a rejection thrown as a non-Error (string/number/plain object) carries no original stack, so blame cannot be assigned — absence of blame does not imply core was at fault. Plugins should reject with real `Error` objects.

---

## 2. Database Manager & Driver Abstraction 🗄️

**Location:** `backend/src/config/database.ts` (manager) + `backend/src/drivers/*` (drivers)

The database layer is a driver-abstraction over SQLite and PostgreSQL. Plugins and models always write **SQLite-flavoured SQL with `?` placeholders**; the core normalizes for PostgreSQL when needed (placeholder rewriting lives in the Postgres driver's `normalizeSql`, the single source of truth).

### Driver selection
*   **`sqlite-native`** (better-sqlite3) — the canonical SQLite driver and the manager **default** (`config.dbDriver`).
*   **`sqlite-legacy`** (sql.js / pure-JS WASM) — the **automatic fallback** used only when the native binary fails to load. It reads the same database file. The manager falls back to it on any SQLite failure or default path; a failed *non-SQLite* override (e.g. an explicit `postgres`) is **not** silently downgraded.
*   **`postgres`** (the `pg` client) — connects to an **external** PostgreSQL by default.

### Driver interface & conformance
*   All drivers implement a common interface — `connect / get / all / run / exec / close` — defined in `backend/src/drivers/interface.ts`.
*   A conformance test (`backend/src/tests/driver-conformance.test.ts`) exercises every driver against the same contract. **Adding a new database = implement the interface + add a conformance block.**

### Embedded PostgreSQL (opt-in)
*   **Location:** `backend/src/core/embedded-db.ts`. Spawns a local PG process via the **optional** `embedded-postgres` dependency.
*   **Opt-in:** disabled unless `config.db.embedded === true`. (The old `db.port == 5433` heuristic still triggers it but is **deprecated** and logs a warning — prefer the explicit flag.)
*   **Port / persistence:** runs on `5433`; data stored under `backend/data/postgres-embed/data`.
*   **Security:** synchronizes the `postgres` password with `config.db.password` on boot (with a trust-update-revert self-heal path that always restores `pg_hba.conf`). The password is escaped before `ALTER USER` and control characters are rejected.

> Embedded PostgreSQL is dev/managed convenience. The standard production path is `sqlite-native` or an external Postgres.

---

## 2b. Database Administration (core) 🛠️

**Location:** `backend/src/core/db-admin/`

Formerly the `db-migration` *plugin*, this is now **core infrastructure** (it manages the embedded PG process and runs schema migrations around the DB lifecycle, which cannot happen inside an isolated child process). It is wired in at boot via `register(app)`, mounts the API at `/api/v1/db-migration` (guarded by `authenticate` + `can('manage_options')`), and its admin menu item is a native Sidebar route — always available, never tied to plugin activation.

---

## 3. Certificate Manager 🔒

**Location:** `backend/src/core/cert-manager.ts`

Manages SSL/TLS certificates via Let's Encrypt (ACME) or manual uploads.

### Capabilities
*   **ACME Client:** Built-in client to request standard `HTTP-01` and `DNS-01` challenges.
*   **DNS-01 Support:** Provides TXT record values for verifying wildcards or local domains.
*   **Auto-Renewal:** (Roadmap) Intended to automate renewal flows.
*   **Custom Certs:** Supports uploading existing `.pem` files via the Admin UI.
*   **Configuration:** Updates `wordjs-config.json` with paths to the active keys and certs.

---

## 4. Plugin Test Runner 🧪

**Location:** `backend/src/core/plugin-test-runner.ts`

Enforces quality control by running unit tests before enabling a plugin.

### Logic
*   **Trigger:** Called automatically (via `verifyPluginTests(slug)`) when an admin attempts to **Activate** a plugin.
*   **Runner:** Spawns a child process with `node --test` (`NODE_ENV=test`).
*   **Enforcement:** If tests fail, the activation throws and is **blocked**, preventing broken code from running.
*   **Scope:** Looks for `*.test.js` files in the plugin's `tests/` directory. **No tests = pass** (tests are optional; a missing `tests/` dir is treated as a skip).
*   **Core tests:** `runCoreTests()` runs the CMS's own `src/tests/*.test.js` suite the same way.

### Example Output
```text
🧪 Running tests for plugin 'my-plugin'...
   ✅ All tests passed (5/5)
```

---

## 5. Hook System & Live Registry 🪝

**Location:** `backend/src/core/hooks.ts`

The central event bus that allows Core and Plugins to communicate through Actions and Filters.

### Features
*   **Global Registry:** A unified dictionary of all active hooks in the system.
*   **Admin UI:** Accessible via **Settings -> Hooks Registry** (`/admin/hooks`).
*   **Live Monitoring:** A real-time timeline (using Server-Sent Events) to watch hooks fire as they happen.
*   **Empty State Handling:** Gracefully handles cases where no hooks are currently registered by showing clear "No Actions/Filters found" states.

### Key Components
*   `addAction(hook, callback, priority)`: Register a function to run at a specific event.
*   `addFilter(hook, callback, priority)`: Register a function to modify data.
*   `doAction(hook, ...args)`: Trigger an event (async; awaits each handler).
*   `applyFilters(hook, value, ...args)`: Pass data through registered filters (async).
*   `doActionSync` / `applyFiltersSync`: Synchronous variants.

### Plugin-context scoping (isolation-aware)
Each registered callback records the **plugin slug** that registered it (via `plugin-context.getCurrentPlugin()`). When a hook fires, a plugin's callback is re-entered **in that plugin's context** (`runWithContext`). For an **isolated** plugin the hook is a host-side *shim* installed by `plugin-isolate.ts`: it RPCs the call into the plugin's separate OS process (the real callback lives in the child), rather than running detached as trusted core code.

*   `doActionForPlugin(hook, slug, ...args)`: fires a hook but invokes **only** the callbacks registered by `slug`. Used by Cron so a plugin-scheduled event can only trigger that plugin's own callbacks — a plugin cannot schedule a **core** hook with attacker-controlled args.
*   **Sync paths skip isolate callbacks:** `doActionSync` / `applyFiltersSync` cannot `await` the cross-process RPC shim a plugin callback resolves to, so they skip plugin callbacks with a warning. Callers needing plugin participation must use the async `doAction` / `applyFilters`.

---

## 6. Analytics System 📊

**Location:** `backend/src/models/Analytics.ts` + `backend/src/routes/analytics.ts`

A native, privacy-focused analytics engine built directly into WordJS to track traffic and engagement without external dependencies (like Google Analytics).

### Architecture
*   **Database:** Uses a dedicated table `wordjs_analytics` (indexed on `created_at`) for high-volume writes.
*   **Performance:** Uses `dbAsync` (SQLite WAL mode or Postgres) for non-blocking writes.
*   **Privacy:** Tracks anonymized sessions using **SHA-256 hashing** with daily rotation (the day is mixed in as salt). Raw IP addresses are **never** stored.

### Key Features
1.  **Event Tracking:** Logs `page_view`, `api_call`, and custom `engagement` events.
2.  **Aggregation:** `getStats(period)` aggregates raw logs into daily metrics for the Dashboard chart. The period cutoff is computed in JS as an **ISO timestamp and bound as a parameter** (`created_at > ?`) — driver-agnostic, rather than SQLite-only `datetime('now', ...)` — and grouping is done in JS so the shape matches the chart regardless of database.
3.  **Frontend Integration:** A `<AnalyticsTracker />` component pings the server on route changes, handling Strict Mode debouncing and client-side navigation.

### API Endpoints
*   `POST /api/v1/analytics/track`: Public endpoint for reporting events (Beacon/Pixel).
*   `GET /api/v1/analytics/stats`: Protected admin endpoint for retrieving aggregated chart data.

---

## 7. Options, Roles & Cron ⚙️

These WordPress-style core services back most CMS configuration.

### Options (`backend/src/core/options.ts`)
*   `getOption / updateOption / addOption / deleteOption / getAutoloadedOptions` — the `options` table is the canonical config store (mirrors `wp_options`).
*   **Cache-backed:** reads check the cache first; values are wrapped as `{ v: value }` so a real cached `null/false/0/''` is distinguishable from a miss. Writes invalidate the key and fire the `updated_option` action.
*   **Permission-checked:** every accessor runs `verifyPermission('settings', ...)`, so an isolated untrusted plugin only sees non-secret options.

### Roles (`backend/src/core/roles.ts`)
*   Roles + capabilities are **persisted in the `options` table** under `wordjs_user_roles` and cached in memory for synchronous access (`getRoles()` is used by `User.toJSON`).
*   `loadRoles()` (boot) hydrates the cache; `setRole / removeRole / updateRoleCapabilities` persist changes; `syncRoles(configRoles)` reconciles missing roles/capabilities from config on startup.
*   `getAllAvailableCapabilities()` unions role caps + core caps + capabilities registered by plugin admin menus.

### Cron (`backend/src/core/cron.ts`)
*   A wp-cron-style scheduler: `scheduleEvent / scheduleSingleEvent / unscheduleEvent / clearScheduledHook / nextScheduled`. Events are stored in the `cron` option keyed by timestamp; `startCron()` polls (default every 60s) and `runCron()` dispatches due events.
*   **Concurrency-safe writes:** `runCron()` snapshots due events, then re-reads a **fresh** copy of the `cron` option before writing back, applying only its own deletes/reschedules — so a concurrent `scheduleEvent()` between read and write isn't clobbered.
*   **Isolation-aware:** a plugin-scheduled event records its `pluginSlug` and is dispatched via `doActionForPlugin` (only that plugin's callbacks). Core-scheduled events (no slug) dispatch normally. Recurrence intervals are resolved at run time from the live `schedules` map, so custom schedules registered later still recur.
*   Built-in jobs include `wordjs_version_check` (daily), `wordjs_db_maintenance` (weekly), `wordjs_scheduled_backup` (driven by the `backup_schedule` / `backup_time` / `backup_day` options) and `wordjs_cert_renewal` (twicedaily — the ACME/Let's Encrypt renewal check, which only renews when the cert is within its renewal window).

### Notifications

The notification service is a core module too — see **[notifications.md](./notifications.md)** for the transport model.
