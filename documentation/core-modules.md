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

The database layer is a driver-abstraction over SQLite, PostgreSQL, and MySQL/MariaDB. Plugins and models always write **SQLite-flavoured SQL with `?` placeholders**; each non-SQLite driver translates that dialect at its own boundary (placeholder rewriting lives in the Postgres driver's `normalizeSql`; the MySQL driver has a fuller SQLite→MySQL translation layer). `getDbType()` exposes `{ isPostgres, isMySQL, isSQLite, driver }` — note `isSQLite` stays **true** for MySQL so the many binary `isPostgres ? … : sqlite` branches keep taking the SQLite path the MySQL driver translates.

### Driver selection
*   **`sqlite-native`** (better-sqlite3) — the canonical SQLite driver and the manager **default** (`config.dbDriver`).
*   **`sqlite-legacy`** (sql.js / pure-JS WASM) — the **automatic fallback** used only when the native binary fails to load. It reads the same database file. The manager falls back to it on any SQLite failure or default path; a failed *non-SQLite* override (e.g. an explicit `postgres`/`mysql`) is **not** silently downgraded.
*   **`postgres`** (the `pg` client) — connects to an **external** PostgreSQL by default.
*   **`mysql`** (or `mariadb`, the `mysql2` client) — connects to an **external** MySQL 8.0+ / MariaDB. The driver rewrites SQLite-dialect DDL/DML to MySQL (`TEXT`→`LONGTEXT`, or `VARCHAR(255)` only when the DDL makes the column part of a key — `drivers/mysql-text-rule.ts`; `AUTOINCREMENT`→`AUTO_INCREMENT`, `INSERT OR IGNORE`/`ON CONFLICT`→`INSERT IGNORE`/`ON DUPLICATE KEY UPDATE`, `RETURNING`→`insertId`). Both the main pool and the per-plugin isolated pool install **one** shared session `sql_mode` — `ANSI_QUOTES,STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION` — declared once so the two cannot diverge: the plugin pool used to re-enable `NO_BACKSLASH_ESCAPES`, which breaks the assumption mysql2's escaping is built on and made an honest parameterised plugin query injectable by an anonymous visitor. Like Postgres it is async-only (the sync handle throws).

### Driver interface & conformance
*   All drivers implement a common interface — `connect / get / all / run / exec / transaction / close` — defined in `backend/src/drivers/interface.ts`.
*   A conformance test (`backend/src/tests/driver-conformance.test.ts`) exercises the **async-interface** drivers it has descriptor blocks for (`sqlite-native` + `postgres` + `mysql`) against the same contract, each skipping gracefully when its backend isn't reachable (in CI with `WORDJS_CI_DB=1` an unreachable driver is a hard failure instead); the sync `sqlite-legacy` (sql.js) fallback is intentionally out of scope. **Adding a new database = implement the interface + add a conformance block.**

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

> **There is NO "trusted" tier.** The old trust tier was removed (PR#62; `plugin-trust.ts` is deleted). Every plugin runs in the `child_process` sandbox and gets **only** what an admin granted — no plugin bypasses DB scoping, `io-guard`, or these grants. Activation grants a plugin exactly its **declared** capabilities — that applies to **every** plugin, not just first-party ones, and only while it holds no grant record — but no plugin is **privileged**.

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

## 4c. Isolated Plugin Host 🧬

**Location:** `backend/src/core/plugin-isolate.ts` (+ `backend/src/core/plugin-worker.js`)

Loads any plugin marked `"isolated": true` in its manifest into a **separate OS process** via `child_process.fork` (real OS-level isolation, no native deps) rather than a worker thread — an untrusted plugin can't touch the host heap, and an off-heap OOM in one plugin can't take down the CMS.

*   **Host-side shims:** the host registers hooks/routes/menus on behalf of the child and RPCs each call into the child process (`serialization: 'advanced'` to preserve fidelity across the channel); the real callbacks live in the child.
*   **Reload:** `reloadIsolatedPlugin(slug)` tears down and re-forks a plugin; it **must** call `require('./plugins').fixMiddlewareOrder()` afterwards so recovered routes are re-mounted before the catch-all 404 (otherwise every reloaded route returns `rest_no_route`).
*   **Teardown by HANDLER identity:** unmounting splices the plugin's Express layers out by matching the exact handler function it mounted, never the registration verb — `app.all()` is implemented by looping the HTTP method list, so `route.methods` ends up with every concrete verb and **never** a key named `all`, and verb-keyed unmounting silently left every `all` route mounted after the child died. `rpcSend` also fails **fast** when `postMessage` reports the child is gone, instead of letting the request hang for the full `RPC_TIMEOUT_MS` (30 s) waiting for a reply that can never arrive.
*   **Least privilege:** the child's network gates (`net`/`tls`/`dns`/`http`/…/`fetch`/`WebSocket`) are opened **only** when `network` is granted — `child_process`/`fs`/`vm` are never handed through. `secure-require`, `io-guard` and `egress-guard` all run **inside** this child.
*   **Themes ride the same isolate:** a theme's `functions.js` is **no longer** required in the host process. `theme-engine.ts` loads it through this same layer under the pseudo-slug **`theme:<slug>`** (`loadIsolatedPlugin('theme:<slug>')`), so any hooks/shortcodes/mail the theme registers flow through the identical RPC bridge and run under `secure-require` + `io-guard`. This closed the in-process-theme RCE cluster — a theme now gets **no** more host access than an isolated plugin.

---

## 4d. Module Confinement 🚪

**Location:** `backend/src/core/secure-require.ts`

`installSecureRequire()` locks down what plugin code can pull in at runtime (loaded eagerly inside the isolated child, before any plugin is on the stack).

*   **Require confinement:** patches `require`/`Module._load`; `guardPluginRequirePath()` blocks `require()` of paths under **writable data dirs** (a load-your-own-dropped-code primitive) and non-requirable dirs, and the ESM `import()` path is guarded too.
*   **Raw-binding block:** `process.binding` is blocked for plugins, and `process.dlopen` is blocked for **all** plugins (a native `.node` addon would run outside every JS-level guard).
*   **Scoped DB:** `guardPluginSql()` refuses queries that touch core credential/secret tables, so a plugin's DB handle can't read the host's users/options secrets.

---

## 4e. Filesystem Guard 📁

**Location:** `backend/src/core/io-guard.ts`

Monkey-patches `fs` inside the isolated child so plugin code is confined to its own dir plus a few safe zones. A plugin **cannot**:

*   rewrite its own `manifest.json` (a permission-escalation primitive), read the raw DB files or secret-named files;
*   **create/rename/copy a file into an executable code extension** — `EXECUTABLE_CODE_EXT` covers `.js/.cjs/.mjs/.jsx/.ts/.cts/.mts/.tsx/.node/.wasm` **and `.html`/`.htm`/`.xhtml`** (kills write-`.txt`-then-rename-`.js` scanner evasion). "Executable" here means executable *by the server* **or** by the browser: a `.html` file is a document in this origin, where the global CSP allows `'unsafe-inline'` and the frontend shares the origin in both shipped modes — so a plugin that wrote `pwn.html` had a stored-XSS primitive with zero permissions. Other data files (`.json`/`.txt`/images) stay writable.
*   **write anywhere on the publicly-served surface** — `isPluginPublishedPath` denies the whole `plugins/<slug>/public/` subtree (case-folded off Linux) plus the three fixed host-known files. This module is the **single source of truth** for that surface: `isPluginServedRelPath` answers "may `backend/src/index.ts` serve this over HTTP?" and `isPluginPublishedPath` answers "may the plugin write it?", derived from one declaration so the two can never disagree. Serving an allowlist while leaving it writable would simply reopen the write→HTTP-read exfiltration channel next door. See `documentation/security.md` §1.3a.
*   **Copy/link ends are both checked:** `copyFile`/`copyFileSync`/`cp`/`link`/`linkSync`/`symlink` validate **source-read AND dest-write**, closing the copy-the-DB / hard-link-a-secret exfiltration hole.
*   **Per-plugin disk-write quota:** raw `writeFile`/`appendFile`/`createWriteStream` growth is capped (a single-write byte cap plus `PLUGIN_GROW_QUOTA` = 512 MB of append/stream growth per rolling window per plugin), surfaced as a normal stream error rather than silently filling the disk.

---

## 4f. ZIP Extraction Guard 🗜️

**Location:** `backend/src/core/zip-guard.ts`

`assertZipWithinBudget(entries, opts)` is the decompression-bomb / resource-DoS defense on the plugin-install path (`routes/plugins.ts` — both manual uploads and marketplace installs, which reuse the same pipeline). It throws an `Error` (`.code = 'ZIP_BUDGET_EXCEEDED'`) **before** extraction if an archive's declared uncompressed size exceeds `maxTotalBytes` (default **200 MB**) or its entry count exceeds `maxEntries` (default **5000**).

---

## 4g. Plugin & Theme Marketplace 🛒

**Location:** `backend/src/routes/marketplace.ts` (route) + `backend/scripts/build-marketplace.js` (catalog builder)

One-click install of first-party plugins **and themes** distributed **outside** the core build. The builder (`npm run build:marketplace` from the repo root) packs every plugin under `marketplace/plugins/<slug>/` into `marketplace/dist/<slug>-<version>.zip` and emits `marketplace/dist/marketplace-index.json` (id/name/version/category/permissions/size + **sha256** per zip). The `dist/` output is a **build artifact — NOT committed** (it is gitignored by `**/dist/`); `release.yml` builds it on a `v*` tag and publishes it as **GitHub Release assets**, so plugin releases are decoupled from the core-code bundle.

### Logic
*   **Source resolution** (`resolveSources()` — plural, **admin-configurable**): the ordered source list is resolved by precedence: (1) the admin-managed `marketplace_sources` option (a JSON **array** of `https` catalogs set from the Marketplace UI — official + private), else (2) the legacy single `marketplace_source` option (back-compat), else (3) the repo-local `marketplace/dist/` when present (dev), else (4) the built-in default `https://github.com/jaimemartinez/wordjs/releases/latest/download` (release assets — **not** a `raw.githubusercontent.com/.../marketplace/dist` URL, which 404s because `dist` isn't committed). Multiple sources are **merged** (dedup by `id`, earlier sources win) with **per-source error isolation** — one bad URL is reported but never hides the rest. Remote sources must be **https** (or `http://localhost` in dev).
*   **Endpoints** (all `authenticate` + `isAdmin`): `GET /api/v1/marketplace/catalog` returns the merged catalog annotated with installed/active/`updateAvailable` state + a per-source status array (5-minute in-memory cache keyed by the source set, `?refresh=1` busts it; `sourcesCacheKey()` additionally stamps a **local** source with its index file's `mtime`+`size`, so re-running `npm run build:marketplace` invalidates the cache instead of serving the pre-build catalog for up to 5 minutes); `POST /api/v1/marketplace/install` takes a catalog `id` and installs from the exact source that entry was listed under; `GET`/`PUT /api/v1/marketplace/sources` read/replace the admin source list (each URL must pass the same https/localhost check; capped at 12).
*   **Install hardening:** the catalog `file` name must match a strict `SAFE_FILE_RE` (no path smuggling from a hostile catalog; local reads are additionally resolved-path-confined to the dist dir), the download is size-capped (**10 MB**, mirroring the upload route's multer cap), and the bytes are **sha256-verified** against the catalog entry before install.
*   **Shared pipeline:** the verified zip is written to a temp file and handed to `installPluginFromZip()` from `routes/plugins.ts` — the exact pipeline manual uploads use (zip-bomb budget via `zip-guard`, Zip Slip/slug validation, squat refusal, manifest + AST scan) — so the marketplace adds no new install surface beyond the catalog fetch. Installed plugins land inactive with **default-deny** grants (§4a).
*   **Themes ride the same mechanism:** the builder also packs `marketplace/themes/<slug>/` → `marketplace/dist/theme-<slug>-<version>.zip` + `marketplace/dist/marketplace-themes-index.json` (64 first-party themes ship today). A parallel set of admin endpoints serves a theme catalog — `GET /api/v1/marketplace/themes/catalog`, `POST /api/v1/marketplace/themes/install`, and `GET`/`PUT /api/v1/marketplace/themes/sources` — resolved by `resolveThemeSources()` against an **independent** `marketplace_theme_sources` option (`THEMES_INDEX_FILE = marketplace-themes-index.json`), so themes can point at a different origin than plugins. Verified theme zips install through `installThemeFromZip()` (`core/themes.ts`), the same hardened zip-guard/slug-validation pipeline.

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
*   **Performance:** Uses `dbAsync` (SQLite WAL mode, Postgres, or MySQL) for non-blocking writes.
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
*   `getOption / updateOption / addOption / deleteOption / getAutoloadedOptions / preloadAutoloadedOptions` — the `options` table is the canonical config store (mirrors `wp_options`).
*   **Cache-backed:** reads check the cache first (key `option:<name>`); values are wrapped as `{ v: value }` so a real cached `null/false/0/''` is distinguishable from a miss. Writes invalidate the key, publish `wordjs:option-changed`, and fire the `updated_option` action. `preloadAutoloadedOptions()` runs once at boot and primes every autoload row into the cache in **one** query, so `/settings` and the other hot readers serve from memory instead of one SELECT per option per request.
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
*   **Multi-node safe:** `runCron()` executes inside `distLock.runAsLeader('wordjs:cron', …)` (see Distributed Lock) so only one node in a cluster fires due events per tick.

### Object Cache (`backend/src/core/cache.ts`)

The cache the Options accessors (and other hot readers) sit on. **Two tiers:**

*   **L1 — in-process, always on.** A `Map` of at most `L1_MAX_ENTRIES` (**2000**) LRU entries holding **serialized** values, so a caller can never mutate a cached object in place. A default install (SQLite, no Redis) therefore caches too — before L1, every `getOption()` was a SELECT.
*   **L2 — Redis.** Gated by config **and** the admin's cache master switch (`setEnabled()`, driven by the `initCacheSetting()` option read at boot). `isAvailable()` means "the Redis tier is operational", not "caching is on".

Coherence: `del()` drops the local L1 entry **and** publishes on `wordjs:cache-del` so peer nodes drop theirs (`flush()` publishes `'*'`). When Redis is *configured* (multi-node possible) L1 entries also self-expire within `L1_REDIS_TTL_CAP_S` (**30 s**) as the bound on any missed broadcast; single-node keeps the caller's full TTL (default **3600 s**), because every write path calls `del()` and in-process invalidation is complete.

*   **Reserved namespace:** writing an `option:` key from plugin/theme context is refused (`getOption` serves that namespace before the DB, so forging one would let a plugin redefine a security-critical option such as `wordjs_user_roles`). Core's own option caching runs in a null plugin context, so it is unaffected.
*   **Multi-node primitives:** `publish / subscribe / pubsubAvailable` (a **dedicated** subscriber connection — a subscribed ioredis client cannot run normal commands), plus `getClient()`, a **separate** self-healing client used as the shared rate-limit store (the object-cache client gives up after 3 retries, which would permanently brick a limiter).

### On-demand Frontend Purge (`backend/src/core/frontend-purge.ts`)

Makes public-site changes instant instead of eventually-consistent. The Next.js frontend serves HTML from its Full-Route Cache and JSON from its Data Cache, both tagged (`settings`, `posts`, `post:<slug>`, `menus`, …); this module POSTs the affected tags/paths to the frontend's `POST /api/revalidate`.

*   **Wiring:** `initFrontendPurge()` is called **once, first and unconditionally** from `initialize()` — a fresh boot installs in-process, so registering it inside the "installed" branch meant the very first install purged nothing.
*   **Hooks:** `wp_insert_post` / `post_updated` purge `posts`, `post:<slug>`, `post:<id>`, `posts:<postType>` and `/`, `/<slug>`; `deleted_post` falls back to the broad `posts` tag (the row is gone, so the slug is unknown); `updated_option` purges `settings` only for an allowlist of chrome-affecting options (`blogname`, `siteurl`, `template`, `stylesheet`, `site_chrome_header`, …) so background jobs can't evict the cache constantly.
*   **Debounced + fire-and-forget:** queued for `FLUSH_DELAY_MS` (**1.5 s**), so a WXR import touching 500 posts produces **one** coalesced purge; a frontend that is down just means TTL freshness, never an error in the write path.
*   **Two transports (`purgeTransport()`):** **DIRECT** for a monolith (its own `PORT`) or a single-host split (`frontendUrl`) — shortest path, unchanged. **VIA THE GATEWAY** for a cluster-enrolled node (`advertiseHost` + an mTLS identity on disk): it POSTs `{ tags, paths }` to the gateway's internal `POST /purge` over the same mTLS channel it registers on, and the gateway fans the purge out to every frontend in its registry. A separate-mode backend cannot deliver it itself — its `frontendUrl` is the gateway's public origin, whose `/api` prefix routes straight back to the backend, and a cluster may run N frontend replicas. See **[separate-mode.md](separate-mode.md)**.
*   **Auth:** a shared `revalidateSecret` in `wordjs-config.json`, sent as the `x-revalidate-secret` header. On a single host this module generates it on first use through `saveConfig()`; in a cluster the **gateway** owns it and enrollment writes the same value into every node's config, so a frontend on its own machine can verify a purge without reading a backend config file it has no access to. On the gateway leg no secret travels at all — the node's `CN=backend` certificate is the authorization. The endpoint can only **invalidate**, never inject — the blast radius of a leaked secret is extra renders, not integrity loss. An HTTPS frontend is verified against `certs/cluster-ca.crt` with a `['frontend','gateway']` CN allowlist (no `rejectUnauthorized: false` anywhere).
*   **Fails towards TTL, out loud:** any undeliverable purge (gateway unreachable, frontend down, secret refused, no frontend registered) leaves the content fresh-by-TTL exactly as before the feature existed, never touches the write path, and is logged once an hour as `[Purge] …`. A `200` from the gateway is not assumed to be delivery: its `{ targets, delivered, failed }` report is inspected, so "accepted but reached 0 nodes" is reported rather than silently counted as success.

### Distributed Lock (`backend/src/core/dist-lock.ts`)
*   A DB-backed leader lease (a `wordjs_locks` table + atomic compare-and-set, used to coordinate N backend replicas that share ONE network database) so cluster-wide singleton work runs on exactly one node. `runAsLeader(name, { ttlMs, renewMs }, fn)` acquires `name`, heartbeats to renew the lease while `fn` runs, and releases on completion; if the holder dies, the lease expires within `ttlMs` and another node can take over. Also exposes `tryAcquire / renew / release / acquireBlocking`.
*   **Three engine answers, not two** (`lockMode()`): **`postgres` / `mysql`** get a real lease — the same CAS, differing only in the server-side "now" expression (`EXTRACT(EPOCH …)` vs `CAST(UNIX_TIMESTAMP(NOW(3))*1000 AS SIGNED)`); the DDL is written once in the SQLite dialect and `drivers/mysql.ts` translates it. **`sqlite`** is single-host, so every operation stays a **no-op that "succeeds"** and single-node behavior is unchanged. **Anything else fails CLOSED** — `acquireBlocking` returns `{ held:false }`, `runAsLeader` skips, each with a warning. The gate used to be `isPg()` alone, which answered "granted" on MySQL: that read "not Postgres" as "no lock needed" when the truth was "not implemented here", so two MySQL replicas seeded the same database at once and cron ran on every node. The family is read from the **driver name**, deliberately not `getDbType().isSQLite` — that flag is `!isPostgres` and is therefore true for MySQL, which is precisely how the original confusion arose.

### Notifications

The notification service is a core module too — see **[notifications.md](./notifications.md)** for the transport model.

---

## 8. Shared Meta Sanitizer 🧼

**Location:** `backend/src/core/sanitize-meta.ts`

The visual editor's page tree (`_puck_data`) is stored verbatim in `post_meta` and rendered as HTML on many public sites, so it **must** be sanitized on every write path. This logic was extracted from `routes/posts.ts` so non-route write paths (the WXR importer) sanitize through the **exact same code** rather than bypassing it. Shared by `posts.ts` + `wxr-import.ts`.

> **Naming.** The editor is now Verso, but the meta key `_puck_data` and this module's identifiers (`sanitizePuckTree`, `PUCK_HTML_FIELDS`, `safePuckUrl`) keep their historical names on purpose. The key is a value already written into every existing install, so renaming it would mean migrating everyone's content; the identifiers are named after the key they operate on and are quoted here verbatim so a grep for them finds the code.

### Logic
*   `sanitizeMetaValue(key, value)` targets `_puck_data`. It sanitizes an object tree, and **(XSS-02)** also parses a `_puck_data` sent as a **JSON string** → sanitizes → re-stringifies (it was previously object-only).
*   `assertMetaValueWithinLimits(value)` bounds every structured post-meta value before recursive sanitization/`JSON.stringify` (128 levels, 100,000 values, no cycles). The three REST write surfaces validate before mutating anything and return `413 rest_meta_value_too_complex` on refusal.
*   Core metadata names are compared through `protected-meta.canonicalMetaKey`, matching MySQL/MariaDB's case/accent-insensitive, PAD-SPACE collation. A spelling such as `_PUCK_DATA` therefore cannot bypass `_puck_data` sanitization/revisioning or create driver-dependent rows.
*   `sanitizePuckTree` walks the structure and sanitizes only **string leaves** (preserving JSON shape):
    *   **HTML-bearing fields** (`PUCK_HTML_FIELDS`: `content`/`html`/`text`/`title`/`heading`/`description`/`caption`/`body`) run through the `sanitize-html` body sanitizer.
    *   **Every other** string leaf runs **value-based** through `safePuckUrl`, which strips control-char obfuscation then blanks values starting with `javascript:`/`data:`/`vbscript:`/`file:` while preserving relative paths, fragments, labels, and classes. So a URL prop **not** in any key-name allowlist (CTABanner/PricingTable `buttonLink`, menu targets) cannot carry a script URL **(XSS-01)**.
*   `icon` is intentionally **excluded** — it is a FontAwesome class token, not a URL.

---

## 9. One-Time Install Token 🔑

**Location:** `backend/src/core/install-token.ts`

`POST /setup/install` and `POST /setup/test-db` run **before** the instance is configured, so they are necessarily unauthenticated and CSRF-exempt. Without a gate, anyone reaching a not-yet-installed instance could complete the install themselves (pre-install takeover). This module is that gate.

> **The CSRF exemption is real at runtime now.** `csrfProtection` is mounted **with** the API prefix (`app.use(config.api.prefix, csrfProtection)`), and Express strips a mount path from `req.url` before the middleware runs — so the old comparison of `req.path` against the full `/api/v1/setup` could never be true, and the declared exemption was dead code. It is now derived from `req.originalUrl` (like `pathAfterApiPrefix`, so it holds at any mount point) and matches the `/setup` **segment**, not a `startsWith` prefix. Before the correction, a headless installer following this documentation received a misleading `403 rest_csrf_invalid` from a site that had no users at all; real callers only worked because they happened to send an `Origin` header. The install guard in `index.ts` uses the same idiom **correctly** only because it is mounted at the root — the two were copied without noticing the mounts differ.

### Logic
*   `generateInstallToken()` mints a random token at boot (`crypto.randomBytes(24)` hex), prints it to the console, and mirrors it to a **0600 file** in the data dir (`TOKEN_FILE`) for headless/Docker installs. Idempotent for the life of the process.
*   **Operator override:** a `WORDJS_INSTALL_TOKEN` env value is honored **only if ≥ 16 chars** (else ignored with a warning, falling back to the random token).
*   **Enforcement:** `routes/setup.ts` rejects any `/install` or `/test-db` request whose `x-install-token` header or `installToken` body field fails `verifyInstallToken()` (constant-time, **fail-closed** when no token was generated).
*   **Lifecycle:** the token is held **in memory** (lost on restart, re-minted while uninstalled); `clearInstallTokenFile()` removes the on-disk mirror once the instance is installed.

---

## 9a. Scoped API Tokens 🎟️

**Location:** `backend/src/models/ApiToken.ts` + `backend/src/routes/auth.ts`

Personal access tokens for headless/machine callers, presented as `Authorization: Bearer wjt_<secret>`. The raw `wjt_…` is shown **once** at creation and stored **sha256-at-rest**. Each token carries per-token global scopes (`read`/`write`) plus per-resource scopes (e.g. `posts:write`, `media:read`); the **effective permission is the caller's capabilities ∩ the token's scope**, so a token can never exceed its owner. Managed via `GET`/`POST`/`DELETE /api/v1/auth/tokens` (session-only) with a self-service admin UI at `/admin/tokens`. The Bearer path is **CSRF-exempt** (no cookie, no CSRF surface).

---

## 9b. Two-Factor Auth (TOTP) 🔐

**Location:** `backend/src/core/mfa.ts` + `backend/src/core/totp.ts`

TOTP second factor. Enrolment and lifecycle live under `/api/v1/auth/mfa*`: `POST /auth/mfa` completes a login by verifying a TOTP or backup code for a pending challenge, and `/auth/mfa/setup`, `/enable`, `/disable`, `/status`, `/backup-codes` manage the factor (self-service admin UI at `/admin/account`). An **admin-enforced MFA-by-role policy** (`GET`/`PUT /auth/mfa/policy`, edited in the Security Center) is applied globally by the `mfaComplianceGate` middleware, which blocks a user who must enrol under the policy until they do.

**Enrolment demands the password (sudo re-auth).** `POST /auth/mfa/setup` **and** `POST /auth/mfa/enable` both require `currentPassword` in the body (`403 rest_bad_current_password`), via the shared `requireSudoPassword` helper in `backend/src/routes/users.ts` — the same per-account lockout bucket and in-flight cap as `/auth/login`, so this cannot become an unthrottled password oracle. It closes an asymmetry: switching 2FA **off** already needed a current code, but switching it **on** needed only the ambient cookie, so a momentarily hijacked session could bind the attacker's authenticator permanently (password reset clears no `mfa_*` key). `/setup` is gated as well as `/enable` because `/setup` is the call that discloses the secret.

**`POST /api/v1/users/:id/mfa/reset`** (`backend/src/routes/users.ts`) is the corresponding way *out* of a lockout: `authenticate` + `sessionOnly` + `edit_users`, plus the `isPrivilegedTarget` rule of `PUT /users/:id`, and **never self** (`400 rest_cannot_reset_own_mfa` — self-disable must still prove a current code). It calls `mfa.disable(userId)`, which deletes every `mfa_*` key (secret, pending secret, backup-code hashes, enabled flag, anti-replay counter), leaving the account exactly as if it had never enrolled. Audited as `user.mfa_reset`.

---

## 9c. Outgoing Webhooks 🔔

**Location:** `backend/src/core/webhooks.ts` + `backend/src/models/Webhook.ts`

HMAC-signed outbound webhooks fired on content events. Subscriptions are managed via `/api/v1/webhooks` (admin UI at `/admin/webhooks`); each delivery is signed with the subscription's HMAC secret and is **SSRF-safe** — the destination IP is re-validated **at delivery time** (loopback/metadata/RFC1918 rejected), mirroring the egress posture in §4b. A delivery log and manual redeliver are exposed per subscription.

---

## 10. Cluster Certificate Authority 🪪

**Location:** `gateway/src/cluster-ca.js`

The cluster CA is the trust root for **separate mode** — the three services running on **different machines**, joined into one cluster over mutual TLS (see **[separate-mode.md](./separate-mode.md)** for the operator guide). It lives in the **gateway** because the gateway is the cluster's CA: it mints and signs every node's identity, and the CA **private key never leaves the gateway box** (kept `0600`).

### Responsibilities
*   **`ensureClusterCA()`** creates the cluster CA (self-signed root) on first use and returns its key/cert; it is idempotent, so re-running `cluster init` reuses the existing CA.
*   **`issueIdentity({ cn, sans, … })`** mints the gateway's own identity/service certs (server+client, CN = role) directly from the CA — used at `init` for the gateway and, historically, the local split-mode certs.
*   **`signCsr({ csrPem, cn, … })`** signs a **CSR** a joining node generated, **forcing `CN = role`** from the validated join token (the CSR's own subject is ignored) — this is the enrollment path.
*   **`caFingerprint()`** exposes the CA's SHA-256 fingerprint, which `node-join` verifies against `--ca-hash` as a MITM guard before trusting the returned CA.
*   **`tokenStore(file)`** persists the **single-use, role-bound, TTL** join tokens (`cluster token <role>` mints, `node-join` burns on first use; `revoke-tokens` burns all).

> The gateway runs a **separate** token-enrollment HTTPS listener on `gatewayEnrollPort` (default **3101**) that does **not** request a client cert (a brand-new node has none yet); it accepts `POST /enroll {role, token, csr}`, validates the token, signs via `signCsr`, and returns `{cert, cluster-ca, bootstrap config}`. The strict mTLS `/register` control plane on `gatewayInternalPort` (3100) is unchanged. See `scripts/cluster.js` / `scripts/node-join.js` (documented in **[cli.md](./cli.md)**).
