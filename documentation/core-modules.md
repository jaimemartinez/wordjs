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
*   All drivers implement a common interface — `connect / get / all / run / exec / transaction / close` — defined in `backend/src/drivers/interface.ts`.
*   A conformance test (`backend/src/tests/driver-conformance.test.ts`) exercises every **async-interface** driver (`sqlite-native` + `postgres`) against the same contract; the sync `sqlite-legacy` (sql.js) fallback is intentionally out of scope. **Adding a new database = implement the interface + add a conformance block.**

---

## 2b. Database Administration (core) 🛠️

**Location:** `backend/src/core/db-admin/`

Formerly the `db-migration` *plugin*, this is now **core infrastructure** (it runs schema migrations around the DB lifecycle, which cannot happen inside an isolated child process). It is wired in at boot via `register(app)`, mounts the API at `/api/v1/db-migration` (guarded by `authenticate` + `can('manage_options')`), and its admin menu item is a native Sidebar route — always available, never tied to plugin activation.

---

## 3. Certificate Manager 🔒

**Location:** `backend/src/core/cert-manager.ts`

Manages SSL/TLS certificates via Let's Encrypt (ACME) or manual uploads.

### Capabilities
*   **ACME Client:** Built-in client to request standard `HTTP-01` and `DNS-01` challenges.
*   **DNS-01 Support:** Provides TXT record values for verifying wildcards or local domains.
*   **Auto-Renewal:** A `wordjs_cert_renewal` cron job (twicedaily) calls `renewIfDue()`, which re-runs HTTP-01 provisioning only when the live cert is within its renewal window (DNS-01 still needs manual TXT publishing). See the Cron section below.
*   **Custom Certs:** Supports uploading existing `.pem` files via the Admin UI.
*   **Configuration:** Updates `wordjs-config.json` with paths to the active keys and certs.

---

## 4. Plugin Test Runner 🧪

**Location:** `backend/src/core/plugin-test-runner.ts`

### Logic
*   **Trigger:** `verifyPluginTests(slug)` is still called automatically when an admin attempts to **Activate** a plugin (in `plugins.ts`).
*   **Plugin tests are NO LONGER executed.** A plugin's test files are arbitrary code, and running them with `node --test` would execute them on the **host**, OUTSIDE the sandbox — a host-RCE vector at activation time. Since there is no "trusted" tier anymore (every plugin is sandboxed at load time), `runPluginTests()` is now a deliberate **no-op**: it always returns `{ success: true, skipped: true }`, so activation is **never** blocked by plugin tests. The `verifyPluginTests` wiring remains as a vestigial seam (it only throws if a result is both `!success` and `!skipped`, which the current no-op never produces).
*   **Core tests:** `runCoreTests()` is the one path that still spawns a child process with `node --test` (`NODE_ENV=test`, secret-free env allowlist). It runs the CMS's own `src/tests/` suite — it scans that directory for files ending in `.test.js`. **No matching files = pass** (returns `{ success: true, tests: 0, ... }`). It is invoked by the installer flow (`routes/setup.ts`), not by plugin activation.

---

## 4a. Plugin Permission Grants 🔐

**Location:** `backend/src/core/plugin-permissions.ts`

An Android-style, admin-controlled, **default-deny** grant registry. The plugin's manifest only **REQUESTS** permissions; this registry records what an operator has actually **GRANTED** per plugin in **/admin/plugins**. A bridge capability is allowed only if the manifest declares it **AND** the admin granted it (`plugin-context.hasPermission` → `isGranted`), so a plugin gets nothing until an admin approves it.

> **There is NO "trusted" tier.** The old trust tier was removed (PR#62; `plugin-trust.ts` is deleted). Every plugin runs in the `child_process` sandbox and gets **only** what an admin granted — no plugin bypasses DB scoping, `io-guard`, or these grants. First-party plugins are pre-granted their **declared** capabilities, but are **not** privileged.

### Logic
*   **Server-side store:** grants live in the `plugin_grants` option (never self-declarable) and are mirrored in an in-memory `Map<slug, Set<token>>` so host-side security gates read them synchronously. `loadGrants()` runs once at boot **after the DB is up**.
*   **Token shape:** a token is either `scope:access` (e.g. `database:write`) or the literal `network`. `isGranted(slug, scope, access)` treats `scope:admin` as implying read+write for that scope.
*   **Network grant:** `network` is a separate, manifest-independent grant; `isNetworkGranted(slug)` is pushed into each isolate's child config at spawn (the child can't read the DB).
*   **One-time backfill:** `backfillActive(entries)` grandfathers **already-active** plugins their manifest-declared caps at upgrade time (so flipping to default-deny doesn't break a running site); **new** activations stay default-deny. It skips any plugin that already has an explicit grant record.

---

## 4b. Sandbox Network Egress Guard 🌐

**Location:** `backend/src/core/egress-guard.ts`

When an admin grants a plugin the `network` permission, the raw socket modules (`net`/`tls`/`http`/`https`/`http2`/`dgram`) and the binding-backed globals (`fetch`/`WebSocket`) open up — a full SSRF + exfiltration surface (cloud metadata at `169.254.169.254`, loopback, RFC1918 internals) without a destination filter. This module confines a network-granted plugin's outbound connections to **public IPs only**.

> Loaded only inside the **isolated child**, never on the host (constraining the shared prototype on the host would wrongly constrain core). Its own `net`/`dns`/… requires resolve to the **real** modules because it loads during the sandbox bootstrap, before any plugin slug is on the stack.

### What gets blocked
*   `isBlockedIp()` blocks loopback (`127.0.0.0/8`, `::1`), link-local incl. `169.254.169.254` cloud metadata, RFC1918 (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), unspecified/`0.0.0.0`, multicast/reserved (`224.0.0.0/4`+), and the IPv6 `fe80::/10` link-local, `fc00::/7` ULA, `ff00::/8` multicast and IPv4-mapped-v6 forms. It **fails CLOSED** on anything that isn't a parseable public IP (garbage/unresolvable).
*   **IPC / unix-socket / named-pipe** targets (the `path` option, e.g. `/var/run/docker.sock`) are **denied** outright.

### How it enforces
*   **Connect-time validation (anti-DNS-rebinding):** an injected `validatingLookup` resolves the hostname and re-checks the **actual** resolved IP across `net`/`tls`/`http`/`https`/`http2`/`dgram`, plus `fetch`/`WebSocket`.
*   **Single chokepoint:** `installChildNetGuard()` patches the **real** `net.Socket.prototype.connect` inside the child (covering the `net.Stream` alias, the `getPrototypeOf(...).connect` bypass, and the pre-normalized `[options, cb]` arg array) and **LOCKS** it via `Object.defineProperty(... writable:false, configurable:false)` so a plugin cannot reassign/un-patch the chokepoint.
*   **TOCTOU-hardened:** `host`/`hostname`/`path` are snapshot **once**, validated, then re-frozen as own data-properties — so a malicious getter can't return a benign value to the guard and a private one to Node's later re-read.

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
*   **Permission-checked:** the plugin-facing accessors run `verifyPermission('settings', ...)` (`getOption` → `settings/read`; `updateOption / addOption / deleteOption` → `settings/write`), so an isolated untrusted plugin only sees non-secret options. (`getAutoloadedOptions` is an internal boot-time autoload reader and skips the check.)

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

---

## 8. Shared Meta Sanitizer 🧼

**Location:** `backend/src/core/sanitize-meta.ts`

The Puck page tree (`_puck_data`) is stored verbatim in `post_meta` and rendered as HTML on many public sites, so it **must** be sanitized on every write path. This logic was extracted from `routes/posts.ts` so non-route write paths (the WXR importer) sanitize through the **exact same code** rather than bypassing it. Shared by `posts.ts` + `wxr-import.ts`.

### Logic
*   `sanitizeMetaValue(key, value)` targets `_puck_data`. It sanitizes an object tree, and **(XSS-02)** also parses a `_puck_data` sent as a **JSON string** → sanitizes → re-stringifies (it was previously object-only).
*   `sanitizePuckTree` walks the structure and sanitizes only **string leaves** (preserving JSON shape):
    *   **HTML-bearing fields** (`PUCK_HTML_FIELDS`: `content`/`html`/`text`/`title`/`heading`/`description`/`caption`/`body`) run through the `sanitize-html` body sanitizer.
    *   **Every other** string leaf runs **value-based** through `safePuckUrl`, which strips control-char obfuscation then blanks values starting with `javascript:`/`data:`/`vbscript:`/`file:` while preserving relative paths, fragments, labels, and classes. So a URL prop **not** in any key-name allowlist (CTABanner/PricingTable `buttonLink`, menu targets) cannot carry a script URL **(XSS-01)**.
*   `icon` is intentionally **excluded** — it is a FontAwesome class token, not a URL.

---

## 9. One-Time Install Token 🔑

**Location:** `backend/src/core/install-token.ts`

`POST /setup/install` and `POST /setup/test-db` run **before** the instance is configured, so they are necessarily unauthenticated and CSRF-exempt. Without a gate, anyone reaching a not-yet-installed instance could complete the install themselves (pre-install takeover). This module is that gate.

### Logic
*   `generateInstallToken()` mints a random token at boot (`crypto.randomBytes(24)` hex), prints it to the console, and mirrors it to a **0600 file** in the data dir (`TOKEN_FILE`) for headless/Docker installs. Idempotent for the life of the process.
*   **Operator override:** a `WORDJS_INSTALL_TOKEN` env value is honored **only if ≥ 16 chars** (else ignored with a warning, falling back to the random token).
*   **Enforcement:** `routes/setup.ts` rejects any `/install` or `/test-db` request whose `x-install-token` header or `installToken` body field fails `verifyInstallToken()` (constant-time, **fail-closed** when no token was generated).
*   **Lifecycle:** the token is held **in memory** (lost on restart, re-minted while uninstalled); `clearInstallTokenFile()` removes the on-disk mirror once the instance is installed.
