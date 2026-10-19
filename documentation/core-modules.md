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

> **Not to be confused with `backend/src/core/certManager.ts`.** That module (camel-case, `node-forge`) generates the **internal** mTLS material, not public certificates: `generateClusterCA()` mints a self-signed cluster root CA and `generateServiceCert(name, caKey, caCert, altNames)` issues a service identity signed by it, writing private keys `0600` into `backend/certs/` (`0700`). Its caller is the install wizard (`issueLocalClusterIdentity()` in `routes/setup.ts`), which issues the single-host internal identities (`localhost` and `127.0.0.1` are always in their SANs). Separate-mode clusters use the gateway's own CA instead (§10).

---

## 4. Plugin Test Runner 🧪

**Location:** `backend/src/core/plugin-test-runner.ts`

### Logic
*   **Trigger:** `verifyPluginTests(slug)` is still called automatically when an admin attempts to **Activate** a plugin (in `plugins.ts`).
*   **Plugin tests are NO LONGER executed.** A plugin's test files are arbitrary code, and running them with `node --test` would execute them on the **host**, OUTSIDE the sandbox — a host-RCE vector at activation time. Since there is no "trusted" tier anymore (every plugin is sandboxed at load time), `runPluginTests()` is now a deliberate **no-op**: it always returns `{ success: true, skipped: true }`, so activation is **never** blocked by plugin tests. The `verifyPluginTests` wiring remains as a vestigial seam (it only throws if a result is both `!success` and `!skipped`, which the current no-op never produces).
*   **Core tests:** `runCoreTests()` is the one path that still spawns a child process with `node --test` (`NODE_ENV=test`, secret-free env allowlist). It runs the CMS's own `src/tests/` suite — every `*.test.ts` (through ts-node, a dev dependency) or `*.test.js` file, one child per file — and adds up the counts. **No suite, or no ts-node, is `skipped: true` with a `reason`**, never a pass of 0 tests. Nothing calls it automatically: the installer used to, with a `.test.js`-only filter that matched no file of the TypeScript suite, so every install reported "0 tests, OK"; it now reports `tests.skipped: true` (run `npm test` in `backend/` to test a checkout). Plugin activation never runs tests.

---

## 4a. Plugin Permission Grants 🔐

**Location:** `backend/src/core/plugin-permissions.ts`

An Android-style, admin-controlled, **default-deny** grant registry. The plugin's manifest only **REQUESTS** permissions; this registry records what an operator has actually **GRANTED** per plugin in **/admin/plugins**. A bridge capability is allowed only if the manifest declares it **AND** the admin granted it (`plugin-context.hasPermission` → `isGranted`), so a plugin gets nothing until an admin approves it.

> **There is NO "trusted" tier.** The old trust tier was removed (PR#62; `plugin-trust.ts` is deleted). Every plugin runs in the `child_process` sandbox and gets **only** what an admin granted — no plugin bypasses DB scoping, `io-guard`, or these grants. Activation grants a plugin exactly its **declared** capabilities — that applies to **every** plugin, not just first-party ones, and only while it holds no grants an administrator decided (no record, or an empty one with no administrator decision recorded) — but no plugin is **privileged**.

### Logic
*   **Server-side store:** grants live in the `plugin_grants` option (never self-declarable) and are mirrored in an in-memory `Map<slug, Set<token>>` so host-side security gates read them synchronously. `loadGrants()` runs once at boot **after the DB is up**.
*   **Token shape:** a token is either `scope:access` (e.g. `database:write`) or the literal `network`. `isGranted(slug, scope, access)` treats `scope:admin` as implying read+write for that scope.
*   **Network grant:** `network` is a separate, manifest-independent grant; `isNetworkGranted(slug)` is pushed into each isolate's child config at spawn (the child can't read the DB).
*   **Boot backfill:** `backfillActive(entries)` grandfathers **active** plugins that have no grant record their manifest-declared caps (so flipping to default-deny doesn't break a running site); **new** activations stay default-deny. It skips any plugin that already has a grant record — decided on the row read under the plugin-policy lock — and writes nothing while the grants cannot be read. It runs at **every** boot and reads the manifests on disk, so the in-place update first gives a plugin with no record an empty one (`ensureGrantRecord`: insert-if-absent, no administrator decision); otherwise the next restart would grant an active plugin whatever its new version declares.

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
*   **Scoped DB:** a plugin that `require`s the core database module gets a proxied `dbAsync` whose every call first runs `guardPluginSql()`. It derives the plugin's `wjp_<slug>_` table prefix from the effective plugin context and delegates to the same `plugin-api.assertSqlAllowed()` the `wordjs.db` bridge uses (see [database.md](database.md#3-extending-the-schema-plugins)): every table the statement references must carry that prefix, and the structural denials (core tables, `ATTACH`/`PRAGMA`, schema catalogs, stacked statements, `RETURNING`, …) apply. With no plugin slug in context there is no prefix, and the structural and core-table denials still apply (fail-closed).

---

## 4e. Filesystem Guard 📁

**Location:** `backend/src/core/io-guard.ts`

Monkey-patches `fs` inside the isolated child so plugin code is confined to its own dir plus a few safe zones. A plugin **cannot**:

*   rewrite its own `manifest.json` (a permission-escalation primitive), read the raw DB files or secret-named files;
*   **create/rename/copy a file into an executable code extension** — `EXECUTABLE_CODE_EXT` covers `.js/.cjs/.mjs/.jsx/.ts/.cts/.mts/.tsx/.node/.wasm` **and `.html`/`.htm`/`.xhtml`/`.shtml`/`.xht`** (kills write-`.txt`-then-rename-`.js` scanner evasion). "Executable" here means executable *by the server* **or** by the browser: a `.html` file is a document in this origin, where the global CSP allows `'unsafe-inline'` and the frontend shares the origin in both shipped modes — so a plugin that wrote `pwn.html` had a stored-XSS primitive with zero permissions. Other data files (`.json`/`.txt`/images) stay writable.
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
*   **Themes ride the same mechanism:** the builder also packs `marketplace/themes/<slug>/` → `marketplace/dist/theme-<slug>-<version>.zip` + `marketplace/dist/marketplace-themes-index.json`. That source directory is **optional and absent from this repo** — the first-party theme catalogue was retired, so the builder emits an empty themes index and a checkout without it still builds the plugin catalog. A parallel set of admin endpoints serves a theme catalog — `GET /api/v1/marketplace/themes/catalog`, `POST /api/v1/marketplace/themes/install`, and `GET`/`PUT /api/v1/marketplace/themes/sources` — resolved by `resolveThemeSources()` against an **independent** `marketplace_theme_sources` option (`THEMES_INDEX_FILE = marketplace-themes-index.json`), so themes can point at a different origin than plugins. Verified theme zips install through `installThemeFromZip()` (`core/themes.ts`), the same hardened zip-guard/slug-validation pipeline.

---

## 5. Hook System & Live Registry 🪝

**Location:** `backend/src/core/hooks.ts`

The central event bus that allows Core and Plugins to communicate through Actions and Filters.

### Features
*   **Global Registry:** A unified dictionary of all active hooks in the system.
*   **Admin UI:** a top-level **Hooks Registry** entry in the sidebar's *System* section (`/admin/hooks`, gated on `manage_options`).
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

## 5a. Content Access Levels (members-only content) 🔒

**Location:** `backend/src/core/content-access.ts`

A post may require an access level (`_wjs_access` meta). Whoever does not hold it — and does not manage the
post — receives the post's **teaser** (body, excerpt and Verso tree cut at the access break) on every read
surface: `Post.toJSON` (REST, and GraphQL through it), the feeds (`routes/seo.ts`), search
(`Post.buildWhere`, title-only match) and the post's comments (`routes/comments.ts`, `models/Comment.ts`,
the comments feed). Levels are provided by plugins through the `content_access_levels` and
`content_access_grants` filters (the bundled `memberships` plugin is one); an unknown level fails closed.
Full guide: [memberships.md](memberships.md).

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
*   **Plugin-declared roles** (namespace rules in `backend/src/core/plugin-roles.ts`, see [plugins.md §12a](plugins.md#12a-declaring-user-roles-rolesdeclare)):
    `registerPluginRoles(pluginId, manifest, { installedPluginIds })` registers/refreshes them all-or-nothing
    (code `PLUGIN_ROLES_REFUSED`; `{ dryRun: true }` runs the same checks without writing — activation calls
    it before spawning the plugin), `releasePluginRoles(pluginId)` retires them on plugin deletion (removed
    when unheld, otherwise `orphaned`), `enforcePluginRoleNamespaces(ids)` trims nested- and
    shared-namespace capabilities and orphans a role whose plugin is gone or whose slug another plugin's
    longer namespace holds, `getRoleCapabilities(slug)` is the EFFECTIVE set `User.getCapabilities()` uses
    (a content type's capability — `post-types.getContentTypeCapabilities()` — is never conferred by a
    plugin role), and `pluginCapabilitiesFor(user, pluginId)` is what a plugin route receives as
    `req.user.pluginCapabilities` (and the users bridge adds to each account). `setRole` keeps a plugin
    role's provenance, refuses a capability outside its namespace and records an accepted edit as
    `adminChanges`, which every refresh re-applies; `syncRoles` (boot) cuts what does not belong. Every
    role write runs through one in-process write lock.

### Cron (`backend/src/core/cron.ts`)
*   A wp-cron-style scheduler: `scheduleEvent / scheduleSingleEvent / unscheduleEvent / clearScheduledHook / nextScheduled`. Events are stored in the `cron` option keyed by timestamp; `startCron()` polls (default every 60s) and `runCron()` dispatches due events.
*   **Concurrency-safe writes:** `runCron()` snapshots due events, then re-reads a **fresh** copy of the `cron` option before writing back, applying only its own deletes/reschedules — so a concurrent `scheduleEvent()` between read and write isn't clobbered.
*   **Isolation-aware:** a plugin-scheduled event records its `pluginSlug` and is dispatched via `doActionForPlugin` (only that plugin's callbacks). Core-scheduled events (no slug) dispatch normally. Recurrence intervals are resolved at run time from the live `schedules` map, so custom schedules registered later still recur.
*   Built-in jobs include `wordjs_version_check` (daily), `wordjs_db_maintenance` (weekly), `wordjs_scheduled_backup` (driven by the `backup_schedule` / `backup_time` / `backup_day` options), `wordjs_cert_renewal` (twicedaily — the ACME/Let's Encrypt renewal check, which only renews when the cert is within its renewal window), `wordjs_collab_sweep` (hourly — retires the orphaned real-time collaboration room state a node that died abruptly leaves behind), `wordjs_audit_prune` (daily — `core/audit.ts`, the `audit_retention_days` option) and `wordjs_analytics_prune` (daily, scheduled from `index.ts` — `core/analytics-retention.ts`, the `analytics_retention_days` option, default 90). Scheduled publishing uses one-off events: saving a post as published with a future date stores it as `future` and arms `publish_future_post` with `[postId]` for that timestamp (`core/scheduled-publish.ts`); editing the date re-arms it and moving the post off publish cancels it.
*   **Multi-node safe:** `runCron()` executes inside `distLock.runAsLeader('wordjs:cron', …)` (see Distributed Lock) so only one node in a cluster fires due events per tick.

### Object Cache (`backend/src/core/cache.ts`)

The cache the Options accessors (and other hot readers) sit on. **Two tiers:**

*   **L1 — in-process, always on.** A `Map` of at most `L1_MAX_ENTRIES` (**2000**) LRU entries holding **serialized** values, so a caller can never mutate a cached object in place. A default install (SQLite, no Redis) therefore caches too — before L1, every `getOption()` was a SELECT.
*   **L2 — Redis.** Gated by config **and** the admin's cache master switch (`setEnabled()`, driven by the `initCacheSetting()` option read at boot). `isAvailable()` means "the Redis tier is operational", not "caching is on".

Coherence: `del()` drops the local L1 entry **and** publishes on `wordjs:cache-del` so peer nodes drop theirs (`flush()` publishes `'*'`). When Redis is *configured* (multi-node possible) L1 entries also self-expire within `L1_REDIS_TTL_CAP_S` (**30 s**) as the bound on any missed broadcast; single-node keeps the caller's full TTL (default **3600 s**), because every write path calls `del()` and in-process invalidation is complete.

*   **Reserved namespace:** writing an `option:` key from plugin/theme context is refused (`getOption` serves that namespace before the DB, so forging one would let a plugin redefine a security-critical option such as `wordjs_user_roles`). Core's own option caching runs in a null plugin context, so it is unaffected.
*   **Multi-node primitives:** `publish / subscribe / pubsubAvailable / redisConfigured` (a **dedicated** subscriber connection — a subscribed ioredis client cannot run normal commands), plus `getClient()`, a **separate** self-healing client used as the shared rate-limit store, so the limiter never shares a connection with the cache/bus publisher. Both clients reconnect indefinitely (backoff capped at 3 s, no offline queue, `maxRetriesPerRequest: 1`): the object-cache client's `busRetryStrategy` never returns `null`, because that client is also the cluster-bus **publisher** and a give-up would silently kill cross-node coherence and realtime fan-out until a restart (it warns once, at the 4th attempt). The no-give-up contract is exported as `_busRetryStrategy` and pinned by `cache-cluster-bus.test.ts`.

### On-demand Frontend Purge (`backend/src/core/frontend-purge.ts`)

Makes public-site changes instant instead of eventually-consistent. The Next.js frontend serves HTML from its Full-Route Cache and JSON from its Data Cache, both tagged (`settings`, `posts`, `post:<slug>`, `menus`, …); this module POSTs the affected tags/paths to the frontend's `POST /api/revalidate`.

*   **Wiring:** `initFrontendPurge()` is called **once, first and unconditionally** from `initialize()` — a fresh boot installs in-process, so registering it inside the "installed" branch meant the very first install purged nothing.
*   **Hooks:** `wp_insert_post` / `post_updated` purge `posts`, `post:<slug>`, `post:<id>`, `posts:<postType>` and `/`, `/<slug>`; `deleted_post` falls back to the broad `posts` tag (the row is gone, so the slug is unknown); `updated_option` purges `settings` only for an allowlist of chrome-affecting options (`blogname`, `siteurl`, `template`, `stylesheet`, `site_chrome_header`, …) so background jobs can't evict the cache constantly.
*   **Debounced + fire-and-forget:** queued for `FLUSH_DELAY_MS` (**1.5 s**), so a WXR import touching 500 posts produces **one** coalesced purge; a frontend that is down just means TTL freshness, never an error in the write path.
*   **Two transports (`purgeTransport()`):** **DIRECT** for a monolith (its own `PORT`) or a single-host split — the frontend installed next to the backend, dialled on `127.0.0.1` at its own port (`frontendPort`, else the port of `frontendUrl`, else 3001) with `frontendUrl`'s scheme; `frontendUrl` itself is the site's address for the frontend and is used as the target only when no frontend is installed next to the backend. Right after an install the frontend still listens on the plain-HTTP socket it opened before the certificates existed, so a TLS purge that meets cleartext on that loopback target is retried in the clear (only there: an `https://` origin on another host never downgrades). **VIA THE GATEWAY** for a cluster-enrolled node (`advertiseHost` + an mTLS identity on disk): it POSTs `{ tags, paths }` to the gateway's internal `POST /purge` over the same mTLS channel it registers on, and the gateway fans the purge out to every frontend in its registry. A separate-mode backend cannot deliver it itself — its `frontendUrl` is the gateway's public origin, whose `/api` prefix routes straight back to the backend, and a cluster may run N frontend replicas. See **[separate-mode.md](separate-mode.md)**.
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

The visual editor's page tree (`_puck_data`) is stored verbatim in `post_meta` and rendered as HTML on many public sites, so it **must** be sanitized on every write path. This logic was extracted from `routes/posts.ts` so non-route write paths (the WXR importer) sanitize through the **exact same code** rather than bypassing it. Shared by `posts.ts`, `wxr-import.ts` and `collab-ops.ts` (which reuses `sanitizePuckTree` / `safePuckUrl` on incoming collaboration ops).

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

`POST /setup/install` and `POST /setup/test-db` run **before** the instance is configured, so they are necessarily unauthenticated and exempt from **both halves** of the CSRF defence — the Origin/Host check *and* the `X-CSRF-Token` double-submit gate. They are the only two paths that skip both. Without a gate, anyone reaching a not-yet-installed instance could complete the install themselves (pre-install takeover). This module is that gate.

> **The CSRF exemption is real at runtime now.** `csrfProtection` is mounted **with** the API prefix (`app.use(config.api.prefix, csrfProtection)`), and Express strips a mount path from `req.url` before the middleware runs — so the old comparison of `req.path` against the full `/api/v1/setup` could never be true, and the declared exemption was dead code. It is now derived from `req.originalUrl` (via `pathAfterApiPrefix`, so it holds at any mount point) and matched against an **enumerated set of exact sub-paths** — `/setup/install` and `/setup/test-db` — never a `startsWith('/setup/')` prefix. The subtree spelling was rejected deliberately: it would also have exempted `POST /setup/migrate`, the one route of that subtree that stays alive *after* installation. It used to authenticate raw credentials from the body (an admin-password oracle any visitor's browser could have driven); it now answers `410 rest_migrate_removed` without evaluating anything, and stays non-exempt for one more release. Before the correction, a headless installer following this documentation received a misleading `403 rest_csrf_invalid` from a site that had no users at all; real callers only worked because they happened to send an `Origin` header. The install guard in `index.ts` uses the same idiom **correctly** only because it is mounted at the root — the two were copied without noticing the mounts differ.

### Logic
*   `generateInstallToken()` mints a random token at boot (`crypto.randomBytes(24)` hex) and writes it to a **0600 file** in the data dir (`TOKEN_FILE`) — the reliable source for headless/Docker installs — then prints the boot banner. Idempotent for the life of the process.
*   **The banner prints the token only on a TTY.** `shouldPrintBootstrapSecret(env, stream)` gates the value itself: the banner contains the token, and a ready-to-open `<siteUrl>/install#token=<token>` link, only when `process.stdout.isTTY` or `WORDJS_PRINT_INSTALL_TOKEN=1`. Otherwise it prints `<siteUrl>/install` with **no** fragment and tells the operator to `cat` the 0600 file (or supply `WORDJS_INSTALL_TOKEN`). Reason: the backend's console output is bridged into structured JSON that [observability.md](observability.md) tells operators to ship to Loki/ELK/Datadog, so a printed bootstrap secret stops being a line that scrolls past in a terminal and becomes a durable, indexed credential. `index.ts` gates the generated initial administrator password through the same helper.
*   **Fragment, never a query string.** The token travels in the URL **fragment** (`/install#token=…`), which the browser does not transmit — so it cannot land in server access logs, in a proxy log, or in the `Referer` of a sub-resource, all of which a `?token=` would reach. `frontend/src/lib/installToken.ts` reads the fragment **first** and treats a legacy `?token=` as a compatibility ramp for an older printout or a pasted URL, not a supported transport (if both are present the fragment wins, so the copy that already leaked is never preferred). Either form is scrubbed out of the address bar with `history.replaceState` on mount, preserving unrelated state. `packages/create-wordjs` prints the same `#token=` shape and supplies the token through `WORDJS_INSTALL_TOKEN`.
*   **Operator override:** a `WORDJS_INSTALL_TOKEN` env value is honored **only if ≥ 16 chars** (else ignored with a warning, falling back to the random token).
*   **Enforcement:** `routes/setup.ts` rejects any `/install` or `/test-db` request whose `x-install-token` header or `installToken` body field fails `verifyInstallToken()` (constant-time, **fail-closed** when no token was generated).
*   **Lifecycle:** the token is held **in memory** (lost on restart, re-minted while uninstalled); `clearInstallTokenFile()` removes the on-disk mirror once the instance is installed.

---

## 9a. Scoped API Tokens 🎟️

**Location:** `backend/src/models/ApiToken.ts` + `backend/src/routes/auth.ts`

Personal access tokens for headless/machine callers, presented as `Authorization: Bearer wjt_<secret>`. The raw `wjt_…` is shown **once** at creation and stored **sha256-at-rest**. Each token carries per-token global scopes (`read`/`write`) plus per-resource scopes (e.g. `posts:write`, `media:read`); the **effective permission is the caller's capabilities ∩ the token's scope**, so a token can never exceed its owner. Managed via `GET`/`POST`/`DELETE /api/v1/auth/tokens` (session-only) with a self-service admin UI at `/admin/tokens`. The Bearer path is **CSRF-exempt** (no cookie, no CSRF surface). A token never decides who has an account or with what power (accounts, roles, registration settings, a backup restore — `middleware/auth.ts` `refuseAccountAuthority`), never gives a plugin a permission or a network destination an administrator has not approved (`refusePluginGrantByToken`: it may revoke and narrow, not add — judged against the stored grants, not a node's in-memory copy — and may not perform the first, grant-seeding activation of a plugin), and never receives a copy of the credentials at rest (`refuseCredentialExportByToken`: backup creation and download, the JSON site export); see [security.md](security.md#scoped-api-tokens).

---

## 9b. Two-Factor Auth (TOTP) 🔐

**Location:** `backend/src/core/mfa.ts` + `backend/src/core/totp.ts`

TOTP second factor. Enrolment and lifecycle live under `/api/v1/auth/mfa*`: `POST /auth/mfa` completes a login by verifying a TOTP or backup code for a pending challenge, and `/auth/mfa/setup`, `/enable`, `/disable`, `/status`, `/backup-codes` manage the factor (self-service admin UI at `/admin/account`). An **admin-enforced MFA-by-role policy** (`GET`/`PUT /auth/mfa/policy`, edited in the Security Center) is applied globally by the `mfaComplianceGate` middleware, which blocks a user who must enrol under the policy until they do.

**Enrolment demands the password (sudo re-auth).** `POST /auth/mfa/setup` **and** `POST /auth/mfa/enable` both require `currentPassword` in the body (`403 rest_bad_current_password`), via the shared `requireSudoPassword` helper in `backend/src/routes/users.ts`. That helper deliberately has **no lock**: a re-authentication gate that refuses a *correct* password is a denial of service the owner cannot clear, and the 200-vs-429 split would itself be the oracle. Instead each failure buys a bounded escalating delay (`sudoDelayMs`, capped at 8 s) paid before the check, plus a cap of 3 concurrent verifications per (account, source address) so one source cannot parallelise the delay away. Its failure counter lives in its own `wjsudo:*` key space, **disjoint** from the login store's `wjlock:*`, so a wrong password at this door can never lock the owner out of logging in. It closes an asymmetry: switching 2FA **off** already needed a current code, but switching it **on** needed only the ambient cookie, so a momentarily hijacked session could bind the attacker's authenticator permanently (password reset clears no `mfa_*` key). `/setup` is gated as well as `/enable` because `/setup` is the call that discloses the secret.

**`POST /api/v1/users/:id/mfa/reset`** (`backend/src/routes/users.ts`) is the corresponding way *out* of a lockout: `authenticate` + `sessionOnly` + `edit_users`, plus the `isPrivilegedTarget` rule of `PUT /users/:id`, and **never self** (`400 rest_cannot_reset_own_mfa` — self-disable must still prove a current code). It calls `mfa.disable(userId)`, which deletes every `mfa_*` key (secret, pending secret, backup-code hashes, enabled flag, anti-replay counter), leaving the account exactly as if it had never enrolled. Audited as `user.mfa_reset`.

---

## 9c. Outgoing Webhooks 🔔

**Location:** `backend/src/core/webhooks.ts` + `backend/src/core/webhook-payloads.ts` + `backend/src/models/Webhook.ts`

HMAC-signed outbound webhooks fired across the site's lifecycle — posts and pages, comments, users (sign-ins opt-in), media, taxonomy terms, menus, plugins, themes and settings; the catalogue and every payload are documented in **[webhooks.md](./webhooks.md)**. The dispatcher derives events from two existing seams instead of emit calls of its own: the action hooks core already fires (`post_updated`, `wp_insert_comment`, `activated_plugin`, `switch_theme`, …) and `core/audit`'s in-process `onAuditRecorded()` observer, which sees every `recordAudit()` row after its transaction commits. Each payload is built by an allowlisted per-entity serializer, so no hash, secret, token, email address or option value can reach a body. Subscriptions are managed via `/api/v1/webhooks` (admin UI at `/admin/webhooks`); each delivery is signed with the subscription's HMAC secret and is **SSRF-safe** — the destination IP is re-validated **at delivery time** (loopback/metadata/RFC1918 rejected), mirroring the egress posture in §4b. A delivery log and manual redeliver are exposed per subscription.

---

## 10. Cluster Certificate Authority 🪪

**Location:** `gateway/src/cluster-ca.js`

The cluster CA is the trust root for **separate mode** — the three services running on **different machines**, joined into one cluster over mutual TLS (see **[separate-mode.md](./separate-mode.md)** for the operator guide). It lives in the **gateway** because the gateway is the cluster's CA: it mints and signs every node's identity, and the CA **private key never leaves the gateway box** (kept `0600`).

### Responsibilities
*   **`ensureClusterCA()`** creates the cluster CA (self-signed root) on first use and returns its key/cert; it is idempotent, so re-running `cluster init` reuses the existing CA.
*   **`issueIdentity({ cn, sans, … })`** mints the gateway's own identity/service certs (server+client, CN = role) directly from the CA — used at `init` for the gateway and, historically, the local split-mode certs.
*   **`signCsr({ csrPem, cn, … })`** signs a **CSR** a joining node generated, **forcing `CN = role`** from the validated join token (the CSR's own subject is ignored) — this is the enrollment path.
*   **`caFingerprint()`** exposes the CA's SHA-256 fingerprint, which `node-join` requires as `--ca-hash`: it pins the CA the enroll listener presents in its TLS chain before the join token is sent (MITM guard).
*   **`tokenStore(file)`** persists the **single-use, role-bound, TTL** join tokens (`cluster token <role>` mints, `node-join` burns on first use; `revoke-tokens` burns all).

> The gateway runs a **separate** token-enrollment HTTPS listener on `gatewayEnrollPort` (default **3101**) that does **not** request a client cert (a brand-new node has none yet); it accepts `POST /enroll {role, token, csr}`, validates the token, signs via `signCsr`, and returns `{cert, cluster-ca, bootstrap config}`. The strict mTLS `/register` control plane on `gatewayInternalPort` (3100) is unchanged. See `scripts/cluster.js` / `scripts/node-join.js` (documented in **[cli.md](./cli.md)**).

---

## 11. Host Policy & Site Address 🧭

**Location:** `backend/src/core/host-policy.js` (byte-identical copy in `gateway/src/host-policy.js`) + `backend/src/core/site-address.ts` + `backend/src/routes/site-address.ts` + `backend/scripts/site-address.js` (`npm run site`)

Decides which addresses the site answers and is the one writer of "where does this site live". The operator guide is **[site-address.md](./site-address.md)**.

### Responsibilities
*   **`host-policy.js`** is the one parser and classifier for a request's address, shared by the backend and the gateway so the two can never read a `Host` header differently. It parses `Host` / trusted `X-Forwarded-Host` (`requestAuthority`, `trustedScheme`, `forwardedForValues` — a single linear scan of `Forwarded: for=`), classifies the authority against the policy (`classify`, `buildPolicy`) and mounts the **host gate** (`hostGateFactory`) right after Helmet in `index.ts`: an address the site does not answer gets `421 rest_host_not_allowed`, a malformed or repeated `Host` `400`. `gateway/test/host-policy-parity.test.js` fails if the two copies differ, and both run `contracts/host-policy-vectors.v1.json`.
*   **`site-address.ts`** owns the main address (`siteUrl`), the aliases and the host policy in `wordjs-config.json`. `commit()` is the only write path (compare-and-swap on the revision, atomic file write, mirrors in one DB transaction, gateway push, cache purge, audit, admin notice); the planners (`planCanonical`, `planAliases`, `planPolicy`, `planRepair`) are shared with the CLI. It also reconciles at boot, applies changes made by `npm run site` while running (`checkExternalChange`), keeps the gateway armed (`startGatewaySync`, every 30 s) and answers which sessions an address's retirement ended (`sessionRetired`).
*   Nothing here is derived from a request: no value comes from `Host` or `X-Forwarded-Host`.

---

## 12. Log Sanitiser 🧾

**Location:** `backend/src/core/log-safe.ts`

`logSafe(value)` turns a value that enters a log line — a request path, an `Origin`, a `Host`, a gateway's or a CA's error message — into one inert line: line breaks, other control characters, ANSI escapes, the Unicode line and paragraph separators and the bidirectional controls are removed. `logSafeError(e)` logs a caught value by its message and code, never its stack. Interpolate the result into **one** string and pass no further `console` argument (a template literal followed by more arguments becomes a format string). Used by the CSRF guard, the site-address module and the certificate manager and routes; see [observability.md](./observability.md).

---

## 13. Multisite 🏘️

**Location:** `backend/src/core/network.ts`, `network-sites.ts`, `network-auth.ts`, `site-context.ts`, `site-resolver.ts`, `site-keys.ts`, `multisite-guards.ts`

The modules that let one install serve a network of sites. The operator guide is **[multisite.md](./multisite.md)**; the design, the isolation guarantees and what phases 1 and 2 built are in **[multisite-design.md](./multisite-design.md)**.

*   **`network.ts`** — the network store: a SQLite file of its own (`network.db`, next to the main database) holding the sites, the addresses each one answers, the network administrators, the per-plugin grant ceilings and the network audit log. It is the single writer of that file; reads come from an in-memory snapshot each write replaces.
*   **`network-sites.ts`** — `createSite()` provisions a site all-or-nothing (registry record, data directory, database, default options, first administrator); `prepareSite(id)` opens a site's database and loads its per-site runtime once per process; `setSiteStatus()` suspends and resumes; `forEachSite` walks the sites for background work.
*   **`network-auth.ts`** — a network administrator is an administrator **of the main site** whose user id is listed in the network store; the role alone or the listing alone is not enough.
*   **`site-context.ts`** — which site the current work belongs to, carried through the async call chain by one `AsyncLocalStorage`. In multisite mode, code that reaches site data outside any site context fails (`site_context_missing`) instead of falling back to site 1.
*   **`site-resolver.ts`** — mounted right after the host gate in `index.ts`, before CORS, cookies, rate limiters and every route, so all of them run inside the request's site context.
*   **`site-keys.ts`** — each site's token signing key: site 1 keeps `config.jwt.secret`, every other site signs with a key derived from it (`HMAC-SHA256(secret, "wordjs-site:<id>")`), and its tokens also carry a `sid` claim that must match the site the request was addressed to.
*   **`multisite-guards.ts`** — what only the main site may do (plugin and theme code on disk, backups of the main database, certificates, the main site's addresses, the installer). The guards are no-ops on a single site and on the main site.

Per-site databases are opened by `openSiteDatabase()` in `config/database.ts` and require the `sqlite-native` driver; see [database.md §5](./database.md#5-multisite-storage).

---

## 14. AI Agents & the MCP Server 🤖

**Location:** `backend/src/core/mcp-server.ts` + `backend/src/core/agent-capabilities.ts` + `backend/src/core/rest-dispatch.ts` + `backend/src/models/AgentConnection.ts` (routes: `routes/mcp.ts`, `routes/agents.ts`)

*   **`mcp-server.ts`** builds one stateless MCP server per HTTP request (`POST /api/v1/mcp`) for the agent connection that authenticated it. The tool list is derived from the connection's grant, and every call re-checks the grant.
*   **`agent-capabilities.ts`** is the vocabulary a connection requests and an administrator grants, plus `narrowUser()`: a call runs **as** the bound user, with `can(cap)` answering the user's capability **and** the grant's.
*   **`rest-dispatch.ts`** runs each tool through the same REST router the HTTP API mounts, in-process, so every content rule (capabilities, publish gate, sanitizing, revisions, outbox, webhooks, audit) applies unchanged.
*   **`AgentConnection`** stores connections in `agent_connections` (migration `0016`): the token hash, requested and granted capabilities, status and timestamps.

Full reference: **[ai-agents.md](./ai-agents.md)**.

---

## 15. AI Provider 🧠

**Location:** `backend/src/core/ai-provider.ts` + `backend/src/core/ai-suggest.ts` (route: `routes/ai.ts`; admin screen `/admin/settings/ai`)

`ai-provider.ts` is the one place that holds the site's AI provider credentials and talks to the provider. The editor's suggestions and plugins granted `ai:use` (`wordjs.ai` on the bridge) get text back and never see the key, which is stored as the secret-named option `ai_provider_api_key` and is absent from every settings route. `ai-suggest.ts` turns material the user already has (a draft's title and body, a media item) into a one-line suggestion; it writes nothing, and the material is treated as data, not instructions. Full reference: **[ai-provider.md](./ai-provider.md)**.

---

## 16. GraphQL 🔷

**Location:** `backend/src/core/graphql/` (`index.ts`, `schema.ts`, `dispatch.ts`, `extensions.ts`, `limits.ts`; route `routes/graphql.ts`)

A read-only endpoint at `/api/v1/graphql`. Every data field resolves through `dispatch.ts`, which issues the REST read it mirrors as an internal sub-request, so a GraphQL read is authorized exactly like that REST read. `extensions.ts` is the seam host code extends the schema through (`registerGraphQLExtension()` and the `wordjs_graphql_register_types` hook); `limits.ts` holds the depth and cost validation rules, checked before any resolver runs; `index.ts` adds the parser token cap and the introspection switch (off in production unless the `graphql_introspection` setting turns it on). Full reference: **[graphql.md](./graphql.md)**.

---

## 17. Media Storage & Offload 🪣

**Location:** `backend/src/core/media-storage.ts`, `media-storage-migrate.ts`, `private-media.ts`, `s3-offload.ts`

*   **`media-storage.ts`** — the storage adapters: `local` (the default, unchanged behaviour) and `s3`, which writes public media and every derivative to an S3-compatible bucket served from a public base URL (the bucket or a CDN). Configured by the `mediaStorage` block of `wordjs-config.json` (route `routes/media-storage.ts`, screen `/admin/settings/media-storage`).
*   **`media-storage-migrate.ts`** — moves an existing library into the bucket (offload) and back (restore), idempotently per attachment.
*   **`private-media.ts`** — attachments that must not be public ([security.md §1.5](./security.md#15-private-media-files-that-must-not-be-public)).
*   **`s3-offload.ts`** is a different feature: it copies **backups** off-host after each local backup ([database.md §1.5](./database.md#15-backups--retention)).

Full reference: **[media-storage.md](./media-storage.md)**.

---

## 18. Structured Logging 📜

**Location:** `backend/src/core/logger.ts` + `backend/src/core/module-logger.ts` + `backend/src/middleware/request-context.ts`

`logger.ts` is the one pino logger: every line the backend emits — a route, a cron tick, a plugin isolate's forwarded output — is a JSON object on stdout with a level, a timestamp and, inside a request, the correlation id. A module logs through `moduleLogger('<module path>')` (`module-logger.ts`), which adds `mod` and the `requestId`. `request-context.ts` is the first middleware on the app: it mints or validates `X-Request-Id` and writes the access line. Levels, redaction and the console bridge: **[observability.md](./observability.md)**.

---

## 19. Content Pipeline 📝

**Location:** `backend/src/core/content-schema.ts`, `content-outbox.ts`, `revisions.ts` + `revision-snapshots.ts`, `collab-ops.ts` + `collab-rooms.ts`

*   **`content-schema.ts`** — the declarative content-type contract (F1, [ADR-0002](./adr/0002-f1-declarative-content-schema.md)): a pure validator that projects a serialisable contract onto `registerPostType()`.
*   **`content-outbox.ts`** — the transactional content unit of work (F3, [ADR-0004](./adr/0004-f3-transactional-content-outbox.md)): every relational write of one logical change shares one pinned connection, and semantic events are inserted into `content_outbox` before `COMMIT` and dispatched after it, at least once.
*   **`revisions.ts` / `revision-snapshots.ts`** — post revisions (F4, [ADR-0005](./adr/0005-f4-versioned-extensible-revisions.md)): a snapshot freezes the versioned meta keys and a manifest of the storage decision, so a restore never depends on today's plugin registry.
*   **`collab-ops.ts` / `collab-rooms.ts`** — Verso's real-time collaboration (F8): `collab-ops` is the trust boundary that rebuilds every incoming operation field by field (and sanitizes through `sanitize-meta`, §8), and `collab-rooms` holds the rooms, the SSE + POST transport of `routes/collab.ts` and the fan-out. Session state lives in `collab_docs` / `collab_ops` / `collab_members`; the canonical content stays in `_puck_data`. A write of `_puck_data` that is not the room's own save (a revision restore, another editor, an import) resets a live room so its members reload the saved content; deleting a post closes its streams and removes its session rows; account and post changes that can revoke access (`User` security meta, roles, the MFA policy, `Post.update` status/author) re-check open streams immediately across the cluster. Spec: [verso/crdt-spec.md](./verso/crdt-spec.md).

---

## 20. Native Sandbox Modules 🧱

**Location:** `backend/src/core/sandbox-linux.ts`, `sandbox-windows.ts`, `sandbox-macos.ts`, `sandbox-paths.ts`, `sandbox-refusal.ts`, `host-privilege.ts`

The kernel layer under the isolated plugin host (§4c):

*   **`sandbox-linux.ts`** — Landlock + seccomp-bpf confinement of each child, with nothing to configure on the host.
*   **`sandbox-windows.ts`** — a zero-capability AppContainer with filesystem ACLs and Job Object limits.
*   **`sandbox-macos.ts`** — Seatbelt (`sandbox-exec`).
*   **`sandbox-paths.ts`** — the filesystem authority every layer reads (Node permissions, Landlock, Seatbelt, AppContainer ACLs and `io-guard`), declared once so they cannot disagree.
*   **`sandbox-refusal.ts`** — the typed error a route answers with when `sandbox.requireHardening` (on by default) refuses to start a plugin whose native sandbox is not available.
*   **`host-privilege.ts`** — on Linux, what privilege the backend process itself holds and what to do about it.

Each mechanism is activated only after a probe has run a real confined child. Posture and host requirements: **[security.md §1](./security.md#1-the-pillars-of-defense)**.

---

## 21. Inbound SMTP & Professional Mailboxes 📮

**Location:** `backend/src/core/inbound-smtp.ts` + `backend/src/core/mailbox.ts`

*   **`inbound-smtp.ts`** — the sandbox gives no plugin an inbound socket, so the **host** opens the SMTP listener on behalf of the one plugin an administrator granted `smtp:inbound` (an exclusive grant), runs the protocol itself and asks the plugin over IPC for a verdict at each step (connect, `MAIL FROM`, `RCPT TO`, `DATA`). A plugin that throws or times out gets the sender a temporary `451`. If the declared port cannot be bound, the listener falls back to 2525 and reports why.
*   **`mailbox.ts`** — whether an account has a mailbox on the site's mail domain is an explicit fact (`user_meta.professional_mailbox`, migration `0006`), not something derived from the account's own e-mail address.

Used by the mail-server plugin: **[mail-server.md](./mail-server.md)**.

---

## 22. Theme Tooling 🎨

**Location:** `backend/src/core/theme-compile.ts`, `theme-derive.ts`, `theme-doctor.ts`

*   **`theme-compile.ts`** — compiles a theme's declarative `theme.json` contract (seeds, archetype, tokens, styles) into the marked `@wjs-generated` block of its `style.css`; values are parsed with css-tree and re-serialized from the AST, never concatenated.
*   **`theme-derive.ts`** — the canonical palette derivation and archetype presets, pure and dependency-free.
*   **`theme-doctor.ts`** — a read-only, fail-open lint of an installed theme against the `wordjs-ui.css` token contract (`backend/public/theme-tokens.json`).

Full reference: **[theming.md](./theming.md)** and **[themes.md](./themes.md)**.
