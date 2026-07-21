# Changelog

All notable changes to WordJS are documented here. This project follows
[Semantic Versioning](https://semver.org/). Each release is published as a pre-compiled bundle
on the [Releases](https://github.com/jaimemartinez/wordjs/releases) page.

## [1.11.0] - 2026-07-21

A **sandbox-isolation + internationalization** release. Plugin isolation gains three new layers that move
enforcement from the in-process JS guards down to the operating system and the database, and the whole
interface gains full multilingual support. Drop-in minor upgrade — no schema migration is required, and
every new isolation control is **transparent, probe-gated, or opt-in** with a graceful fallback, so existing
installs behave exactly as before until the environment (or an admin) turns something on.

### Added

- **Per-plugin database isolation.** On PostgreSQL each active plugin's queries run under its own
  low-privilege `NOLOGIN` role (`SET ROLE` on a pinned client); on MySQL/MariaDB under its own low-privilege
  login user — each GRANTed access to **only its own `wjp_<slug>_` tables**. The database itself then denies
  any cross-plugin or core-table read/write even if the SQL text-guard is bypassed. Default-on where the DB
  user can provision roles/users; falls back gracefully to the text-guard on SQLite or where provisioning
  isn't permitted (opt-out: `sandbox.pluginDbRoles=false`).
- **Kernel network-namespace isolation.** On Linux, a plugin **without** the `network` grant is launched
  into its own empty network namespace (bubblewrap `--unshare-net`), so it cannot reach the cloud metadata
  endpoint, host loopback, or the public internet **at the kernel level** — not just via the in-process
  egress guard. Probe-gated (a `--unshare-net` self-test must keep the RPC bridge alive on the host) and
  fail-open everywhere it can't be proven; surfaced on `GET /health/details`. Opt-out: `sandbox.unshareNetwork=false`.
- **Per-plugin egress allowlist.** Admins can restrict a network-granted plugin to a set of egress hosts at
  **`/admin/plugins`**. Empty = allow all public hosts (unchanged); a non-empty list flips the plugin to
  default-deny except the listed hosts and their subdomains (matched at a label boundary). Additive — it
  never loosens the existing private/loopback/metadata IP block.
- **Full UI internationalization (Spanish / English / Portuguese).** ~700 translation strings across the
  admin and public interfaces, so the UI renders in the operator's language throughout.

### Changed

- **`ModernSelect` / `Select`** menus render through a portal so they escape a clipping `overflow-hidden`
  ancestor (e.g. a rounded card), with keyboard highlight and arrow-key navigation. Assorted form and
  component polish across the admin UI.

### Security

- **`plugin_egress_hosts` is a protected option** — a plugin can never widen its own egress via the generic
  options bridge (same self-escalation guard as `plugin_grants`).
- **Raw DNS-resolver egress hole closed.** `import('dns')` no longer hands a network-granted plugin the raw
  c-ares `Resolver` (which egresses over its own sockets, bypassing the connect guard and the egress
  allowlist); the guarded `dns.lookup` remains available.
- **Log-injection (CWE-117) hardened.** Untrusted values (cert CN, request URL, plugin slug, error text) are
  stripped of CR/LF before being logged in the gateway and plugin-DB layers.
- The native UDP handle guard now also enforces the egress allowlist, and IPv6 allowlist entries match
  correctly across URL-based egress paths.

### Fixed

- **Monolith-mode certificate panel.** The admin SSL/certificate view now reports the real port + served
  certificate in monolith deployments (where there is no separate gateway to probe) instead of showing a
  "Gateway Unreachable" error.

## [1.10.0] - 2026-07-20

A **platform + hardening** release: WordJS opens up as a headless backend (scoped API tokens and outgoing
webhooks), gains real account security (TOTP two-factor with an admin-enforced-by-role policy), and serves
images ~50–90% smaller automatically. Drop-in minor upgrade — no schema migration is required by the host
(the token/webhook tables self-migrate on boot) and every new capability is **opt-in or transparent**;
existing installs behave exactly as before until an admin turns something on.

### Added

- **Scoped API tokens (headless).** Personal access tokens (`Authorization: Bearer wjt_…`) for CI, JAMstack,
  and automation. A token authenticates **as** its user on the CSRF-exempt Bearer path and is bounded by
  **both** the user's live capabilities **and** the token's scope — effective permission = user ∩ token
  (least privilege). Scopes are coarse `read`/`write` **or per-resource** (`posts:write`, `media:read`, …),
  so a build token can be confined to exactly the resources it needs and touch nothing else. Only a sha256
  of the token is stored (plaintext shown once, unrecoverable); tokens are revocable with an optional expiry.
  Self-service at **`/admin/tokens`**. An API token can never manage tokens (no self-perpetuation).
- **Outgoing HMAC-signed webhooks.** Registered endpoints receive signed `POST`s on content events
  (`post.created/updated/published/deleted`, `comment.created/deleted`), each carrying an HMAC-SHA256
  signature over the body. Delivery is **SSRF-safe** (connect-time IP validation blocks loopback/metadata/
  RFC1918 and re-checks across redirects), with a durable retry queue and a delivery log + manual redeliver
  at **`/admin/webhooks`**.
- **Two-factor authentication (TOTP).** Opt-in RFC 6238 authenticator-app codes with QR enrollment,
  single-use backup recovery codes, and a two-step login. Self-service on **`/admin/account`**; zero new
  dependencies for the core codec.
- **Admin-enforced MFA-by-role policy.** An admin can **require** chosen roles to have 2FA, with a grace
  period to enrol. A required-role user is nudged during grace, then hard-blocked from the dashboard (except
  the enrolment flow) until 2FA is on — enforced by a global backend gate, not just the UI. Configured in the
  **Security Center** (`/admin/security`).
- **Automatic image optimization.** A transparent `/uploads` layer transcodes JPEG/PNG to **AVIF/WebP** based
  on the request `Accept` header, caches derivatives to disk, and serves the same URL with `Vary: Accept` +
  immutable caching — typically **50–90% smaller** with no frontend change and a safe fallback to the original.
- **Fail-closed sandbox hardening mode + visibility.** `config.sandbox.requireHardening` makes an isolated
  plugin **refuse to launch** unless kernel hardening is actually active (instead of silently degrading), and
  the live hardening state (`unsupported`/`disabled`/`active`/`degraded`) is surfaced on the admin
  `GET /health/details`.
- **Supply-chain CI.** CodeQL static analysis (SAST) on every PR, a per-release **CycloneDX SBOM** attached to
  the GitHub Release, and widened Dependabot coverage.

### Performance

- **Automatic image optimization** (above) cuts image bytes 50–90% on supporting browsers.
- **Postgres connection-pool tuning** — bounded `max`/idle/connection timeouts plus
  `idle_in_transaction_session_timeout` to evict leaked-transaction connections that pin the pool (all
  overridable in the db config; `statement_timeout` deliberately left off so legit long migrations/imports
  aren't killed).

### Security

- **MFA challenge token can no longer authenticate a session.** The short-lived `mfa_challenge` JWT (issued
  after the password step) is rejected by the auth middleware, so the second factor can't be skipped by
  presenting the challenge token as a session credential.
- **The MFA enforcement gate treats a session JWT as a session on every transport.** Only genuine `wjt_` API
  tokens are exempt; a raw session JWT presented as a `Bearer` header is enforced exactly like the cookie, so
  an un-enrolled required-role account can't opt out of enforcement by switching transports.
- **Per-resource token scopes fail closed.** An all-unrecognized scope request (e.g. a typo like `posts:*`) is
  **rejected** rather than silently widened to a global read token.
- **TOTP anti-replay + atomic backup-code consumption**, a dedicated login-lockout bucket for the second
  factor, and per-IP throttling on the MFA endpoints.
- Third-party GitHub Actions are **pinned to immutable commit SHAs** (a moving tag can be repointed).

### Fixed

- **Webhook signing secret is stored in plaintext** (was AES-encrypted with a key derived from the rotatable
  `jwt.secret`, which silently dead-lettered **every** delivery whenever that secret changed). At-rest
  protection is the DB/disk's job.
- **MFA grace-period anchor mis-parsed timestamps.** SQLite's UTC `user_registered` (`YYYY-MM-DD HH:MM:SS`,
  no zone) was read as local time, pushing the grace deadline into the future on positive-offset servers so
  `graceDays: 0` never enforced; timestamps are now UTC-pinned and the anchor clamped to now.
- **CodeQL path-injection findings in the media pipeline** resolved with recognized `..`-containment +
  `startsWith(root)` barriers.
- **High-severity dependency advisories** swept (`brace-expansion` ReDoS, `js-yaml` quadratic-CPU merge keys).

## [1.9.1] - 2026-07-20

Patch release fixing the compiled bundle's **split** (`npm start`) and **separate / multi-node** modes,
which were broken in v1.9.0: two runtime dependencies were misfiled as `devDependencies` and therefore
skipped by `release:install` (`npm install --omit=dev`). The **monolith** (`npm run start:mono`) was
unaffected — this only hit the gateway-based deployment modes, which is why the release smoke-boot (which
boots the monolith) didn't catch it.

### Fixed

- **The gateway could not start in the compiled release (`node-forge` was a devDependency).** The gateway
  loads `gateway/src/cluster-ca.js` (the cluster PKI + join-token engine) on every boot, and that requires
  `node-forge` — but it was under the gateway's `devDependencies`, so `release:install` skipped it and the
  gateway crashed at startup with `MODULE_NOT_FOUND`. This broke **both** the single-host split
  (`npm start`) and separate mode (`npx create-wordjs gateway` / `node scripts/cluster.js init`). Moved
  `node-forge` to the gateway's `dependencies`.
- **`npm start` (the 3-service split launcher) failed with `concurrently: not found`.** `concurrently`,
  which the root `start`/`dev` scripts invoke, was a devDependency and thus absent from the compiled
  release. Moved it to `dependencies`.

Validated end-to-end on a fresh unprivileged LXC (Node 22, real systemd): `cluster init` mints the CA,
`node scripts/node-join.js` enrolls the backend + frontend via the token → CSR → signed-cert flow, both
register with the gateway over mTLS, and `GET https://<gateway>:3000/` returns **200** serving the site
(frontend SSR pulling from the backend, every hop mutually authenticated).

## [1.9.0] - 2026-07-20

A **security-hardening** release centered on the plugin sandbox, plus authorization/data-leak fixes,
a full-fidelity Postgres engine-switch, and an editable legacy-HTML editor block. Drop-in minor
upgrade: no schema or public-API changes, and every new sandbox behavior is **probe-validated with a
safe fallback** or **opt-in** — a host lacking a kernel feature is never broken, and stock installs
need no configuration.

### Added

- **Kernel-level plugin isolation is now ON by default on Linux.** Each isolated plugin (and theme
  `functions.js`) runs through `bubblewrap` — unprivileged `nobody` uid in a rootless user namespace,
  all capabilities dropped, `no-new-privs`, PID/IPC/UTS namespaces, and a compiled seccomp-bpf syscall
  denylist (pure-JS, no native dep) — so a heap escape that defeats the in-process guards still hits an
  OS wall. The launch is validated per host (bwrap + rootless-userns + an IPC round-trip must work) and
  falls back cleanly to the standard isolated launch on any host without the feature
  (`config.sandbox.useKernelHardening`, opt-out). Previously this layer existed but was dead code
  (off, and not even configurable).
- **Read-only core filesystem for plugins.** Under kernel hardening, only the plugin's own dir + the
  IO-Guard write-zones (`uploads`/`data`/`logs`/`os-tmp`/`themes`) are bound writable; the rest of the
  install — core `src/`, `node_modules`, sibling plugins — is read-only **at the kernel level**, so a
  plugin that somehow escaped the JS IO Guard still cannot persist a payload into core source.
- **Per-plugin resource caps (anti-DoS).** A file-descriptor cap (`RLIMIT_NOFILE`) so a plugin can't
  drain the host fd table; and, with the opt-in cgroup layer enabled, a per-plugin **CPU quota**
  (`config.sandbox.cpuQuotaPercent`, cgroup `CPUQuota`) and a **task/pid cap** (`TasksMax`, fork/thread-
  bomb containment) in the same systemd scope. Validated end-to-end on real systemd (bare metal +
  Proxmox LXC).
- **`config.sandbox.blockCodeGen`** — an opt-in engine-level block on runtime code generation
  (`eval` / `new Function(string)`) for compiled production builds, layered under the install-time AST
  scanner.
- **Editable legacy content.** A legacy or WordPress-imported (pre-Puck) post's HTML now opens as an
  editable HTMLEmbed block instead of a blank canvas.
- **Full-fidelity Postgres engine switch.** New DDL translation (`AUTOINCREMENT`→`SERIAL`,
  `DATETIME`→`TIMESTAMP`, `BLOB`→`BYTEA`, full primary-key fidelity) when migrating *to* Postgres.

### Fixed

- **Authorization — revision restore/delete.** Restoring or deleting a post revision was gated only on
  `edit_posts`, so a contributor could restore their own **published** post (and pages-as-posts) past
  the publish gate; it now mirrors the PUT/DELETE capability family (edit/delete + `*_published`) and is
  post-type aware.
- **Authorization — comment moderation bypass.** Changing a comment's status via `PUT /comments/:id`
  now requires `moderate_comments`.
- **Media leak.** `GET /media/:id` is now gated by the parent post's visibility — a draft post's
  attachment could previously be fetched by URL.
- **Sandbox — admin-sidebar phishing.** `adminMenu.add` (reachable without a grant) stored a plugin's
  `href` verbatim; a `javascript:`/off-site href was a UI-spoof primitive. Plugin hrefs are now required
  to be same-origin relative admin paths.
- **Sandbox — arbitrary-read bypass.** The IO Guard now also confines `open`/`openSync`/`opendir`/
  `readlink` (open is flag-aware); a plugin doing `fs.openSync(p,'r') + fs.readSync(fd)` previously read
  any file's content past the `readFile` guard.
- **Sandbox — seccomp + bind hardening.** The seccomp denylist now covers `io_uring` and the new mount
  API; the bwrap writable bind was tightened to the plugin's own write-zones on every launch branch.
- **CI reliability.** Fixed the intermittent *"Unable to deserialize cloned data"* test flake (a leaked
  `Promise.race` timer that `--test-force-exit` then hard-killed mid-IPC); the integration suite now
  hard-fails under `WORDJS_CI_DB` instead of silently skipping; and every PR now smoke-boots the compiled
  bundle.

### Changed

- **Dependencies:** `fast-xml-parser` v4 → v5 (drop-in, byte-identical WXR) and `uuid` v10 → v11, with a
  new WXR-import round-trip test.

### Security

- The sandbox hardening above (default-ON kernel isolation, read-only core, resource caps, wider seccomp,
  IO-Guard read coverage) materially raises the cost of a plugin escape on Linux hosts. See `SECURITY.md`
  for the current model and its documented limitations (notably: network egress is confined by an
  in-process guard, not a kernel network namespace).

## [1.8.0] - 2026-07-19

Two **critical, silent data-loss fixes** plus a **⌘K command palette** for the visual editor.
Recommended upgrade for every site — especially any site with plugins installed or that edits
legacy/imported posts. This is a drop-in minor upgrade: no configuration, schema, or public-API
changes. Internally the editor now bundles an in-tree fork of Puck (`@wordjs/puck`); this is
transparent to the compiled bundle and requires nothing from operators.

### Added

- **⌘K / Ctrl+K command palette in the visual editor.** Open it anywhere in the editor — including
  with focus inside the canvas iframe — and insert any block from a searchable, keyboard-navigable
  list (arrow-nav, type-to-filter, Enter or click to insert) without touching the mouse. A header
  button with a `⌘K` hint makes it discoverable, and a palette insert is a single undo (Ctrl+Z).
  Built entirely on the editor's public API; block metadata is now shared between the palette and the
  sidebar inserter so both present blocks identically.

### Fixed

- **CRITICAL — switching database engine no longer destroys your data.** Any site with plugin,
  analytics, or custom tables that used **Admin → Database** to switch engine (e.g. SQLite →
  Postgres/MySQL) was affected: the old migration copied only a hardcoded 11-table list, so every
  plugin `wjp_*` table plus `wordjs_analytics`, `schema_migrations`, and `notifications` (store
  orders/stock, restaurant reservations, conference inscriptions) was **silently and irrecoverably
  dropped** while the UI reported *"Migration successful."* It was also non-atomic (a cross-connection
  "transaction" plus `TRUNCATE`) and verified by warning only. The migration now enumerates **all**
  user tables dynamically, recreates non-core schema on the target with correct per-dialect types
  (MySQL `TEXT`→`LONGTEXT`, Postgres type mapping, all identifiers quoted), copies inside a **real
  single-connection transaction** using `DELETE` (never `TRUNCATE`), and **fails closed** — a
  per-table row-count mismatch rolls back and keeps the original database live, so a half-copied
  target can never silently become your site.
- **CRITICAL — a blank editor can no longer overwrite a real post.** Anyone editing posts/pages when
  a page-load hiccuped, and anyone editing a WordPress-imported or pre-Puck (legacy HTML) post, was
  affected: two paths let an empty canvas save empty content over the real body, made **unrecoverable**
  because the 8-second autosave skips the revision snapshot. Now (1) a failed content load renders a
  **blocking error card** (Retry / Back) instead of a savable empty editor, and saving an existing
  record is refused until hydration is confirmed — no editor mounts and no `PUT` is issued on a failed
  load; (2) a legacy HTML post preserves its original body — the blank Puck canvas no longer
  regenerates empty content or stamps empty block data over it.
- **Revision pruning and user listing are now portable across database drivers.** On Postgres/MySQL
  (invisible on SQLite): revision pruning used a `DELETE … WHERE id IN (SELECT … LIMIT ?)` that
  **MySQL rejects** (ER 1093 / ER 1235), so pruning threw, revisions grew unbounded, and restoring a
  post with more than 10 revisions returned a 500; it now selects the oldest ids then deletes by
  explicit list (and cleans up the orphaned `post_meta` the old query left behind). Separately, the
  users admin list reported **wrong `X-WP-Total`/`X-WP-TotalPages`** because `count()` ignored the
  active `role`/`search` filter, and the whitelisted sort was a silent no-op for lack of an
  `ORDER BY`; both now share one filter builder and apply a deterministic `ORDER BY` with an `id`
  tiebreak.

### Changed

- **Puck is now an in-tree fork (`@wordjs/puck`), replacing `@measured/puck` and its fragile
  install-time patch.** WordJS's one editor-specific change — a per-block **Edit** action for
  Text/Heading blocks, which Puck's public API can't express — previously required regex-rewriting
  Puck's minified `dist` on every install (silently breaking on any version bump). The fork
  (Puck v0.20.2, MIT, with `NOTICE.md`) puts that change in source; the editor `dist` is built by
  `build:editor` in `predev`/`prebuild` and a dedicated CI step. No behavior change for sites.
- **The release pipeline now smoke-boots the compiled bundle before publishing.** After building the
  ZIP, CI extracts it, installs, boots the monolith over HTTP, and requires `/healthz` to answer — if
  the bundle can't boot, **nothing is published**. Closes the gap that once shipped an unbootable
  bundle.
- **The MySQL driver is now exercised against a real MySQL 8 in CI.** A `mysql:8` service plus a
  conformance case feed the SQLite-dialect SQL the app actually emits through the translation layer;
  `WORDJS_CI_DB=1` promotes the Postgres and MySQL blocks from graceful skips to hard failures so a
  missing service can't slip through green.

### Notes

- **Postgres migration target — documented limitation (not data loss).** When migrating *to* Postgres,
  non-core (plugin) tables are recreated from their column list (Postgres can't translate SQLite DDL),
  so they are **data-complete but may lack their primary key / autoincrement** until the plugin
  re-establishes its schema on activation. SQLite → MySQL and SQLite → SQLite keep full fidelity.

## [1.7.0] - 2026-07-19

### Added

- **Companion themes — a plugin can ship its own theme.** A plugin zip may include a top-level
  `theme/` folder; on the Plugins admin page the admin installs it with one click
  (`POST /plugins/:slug/install-theme` copies `plugins/<slug>/theme/` → `themes/<slug>-theme` with
  upload-parity validation, symlink refusal, and a 409 if it already exists). Complements the theme
  marketplace (remote catalog): companion themes ship *inside* a plugin.
- **`online-store` v2 — a complete e-commerce.** Product variants with atomic per-variant stock,
  multi-image galleries, shipping zones + pickup, taxes, customer order history (a StoreOrders block),
  transactional emails, Stripe refunds, SEO product pages + catalog search/filters, sales reports +
  CSV, and Stripe webhooks re-verified server-side. Install it from the marketplace (plugin `2.0.0`).
- **`restaurant-menu` v2 — a complete restaurant.** Dish modifiers (size/extras with price), opening
  hours + accept-orders window + prep times, table QR (per-table menu + order-from-table + QR
  generator), native reservations, online payment (Stripe) alongside WhatsApp/cash, a live kitchen
  view over SSE, menu i18n (es/en) + allergens, and reports. Marketplace plugin `2.0.0`.

### Notes

- The `online-store` and `restaurant-menu` v2 admin pages currently use the v1 utility styling; the
  premium `admin.css` skin from 1.6.3 is shipped alongside and re-skinning the expanded v2 admins to
  it is a follow-up.

## [1.6.3] - 2026-07-18

### Added

- **Theme marketplace.** Themes are now distributed exactly like plugins: a browsable catalog with
  deterministic, sha256-verified zips installed through a hardened pipeline. The **Themes** admin page
  gains **Instalados | Marketplace** tabs; `GET /api/v1/marketplace/themes/catalog` and
  `POST /api/v1/marketplace/themes/install` (strict containment: every entry under `<slug>/`, a
  `theme.json` is required, zip-bomb + Zip-Slip guards). Themes have their **own** admin-configurable
  source list (`GET`/`PUT /api/v1/marketplace/themes/sources`, option `marketplace_theme_sources`),
  independent from the plugin sources, so you can point themes at a different origin.
- **MySQL is selectable at install AND for driver-switch migration.** The install wizard's driver
  picker now offers MySQL / MariaDB (with a connection form), and Admin → Database can migrate an
  existing site to MySQL (async client-server migration path, `?`-placeholder + `FOREIGN_KEY_CHECKS`
  handling), alongside the existing Postgres path.
- **Premium admin redesign for every marketplace plugin.** Each plugin admin page ships its own
  scoped `admin.css` in a shared modern design system (cool-neutral canvas, single indigo accent,
  soft layered shadows, segmented tabs, glass modals) — logic unchanged, styling isolated per plugin.
- **`youtube-videos`, `conference-manager` and `mail-server` moved to the marketplace** (catalog now
  28 plugins). `mail-server`'s runtime `data/` (its AES key + attachments) is excluded from the zip.

### Changed

- **Marketplace sources v2 — an explicitly empty source list now disables the remote marketplace**
  (instead of silently falling back to the official catalog). "Restablecer al default" (a new
  `reset` on the sources endpoints) is the way back to the official catalog. Applies to plugins and
  themes. Bundled themes were moved out of the release bundle into the theme marketplace, mirroring
  plugins; upgrades preserve any themes already installed on a site.
- **Uninstalling a plugin now preserves its `data/` folder by default** (encryption keys,
  attachments) — the same WordPress-parity rule the DB tables already followed. Reinstalling adopts
  the preserved data; check "delete data" to remove it too.

### Fixed

- **Theme Customizer live preview was blank/broken** (broken-document icon, black swatches, all
  "theme default"). The site-wide `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` blocked ALL
  framing, including the customizer's own same-origin `<iframe src="/">`. Relaxed to `SAMEORIGIN` /
  `frame-ancestors 'self'` in `frontend/next.config.ts` — cross-origin clickjacking stays fully
  blocked; only WordJS framing its own pages is re-allowed (the pattern WordPress's Customizer uses).

## [1.6.2] - 2026-07-18

### Added

- **MySQL / MariaDB database driver.** A new `dbDriver: "mysql"` joins sqlite-native, sqlite-legacy and
  postgres. WordJS models and plugins keep writing ONE dialect (SQLite); the driver
  (`backend/src/drivers/mysql.ts`) translates it to MySQL at the boundary — `TEXT`→`VARCHAR(255)`/
  `LONGTEXT` with expression defaults, `AUTO_INCREMENT`, `INSERT OR IGNORE`/`ON CONFLICT`→`INSERT
  IGNORE`/`ON DUPLICATE KEY UPDATE`, `RETURNING`→`insertId`, functional-index parens, `ANSI_QUOTES`.
  Point it at a server with `dbHost` / `dbPort: 3306` / `dbUser` / `dbPassword` / `dbName`. Verified
  end-to-end on MySQL 8.0 (schema build, migrations, CRUD/JOIN/transactions, and a full backend boot
  serving from MySQL).
- **Configurable marketplace sources from the admin UI.** The Marketplace tab gains a source manager
  (⚙️) where an admin points WordJS at any number of catalogs — official or private `https` URLs —
  instead of a single hard-coded source. Catalogs are merged (dedup by id, list order = priority); a
  failing source is reported per-source but never breaks the rest. New
  `GET` / `PUT /api/v1/marketplace/sources`.

### Fixed

- **The plugin marketplace's default catalog source 404'd on every real install.** `DEFAULT_REMOTE`
  pointed at `raw.githubusercontent.com/.../main/marketplace/dist`, but that path is a build output that
  is not committed — so a release install could not browse or install ANY marketplace plugin. It now
  points at the GitHub **release assets** (`releases/latest/download/`), where the catalog is actually
  published (`marketplace-index.json` + one sha256-verified zip per plugin). Verified `404 → 200`.
- **The analytics table failed to create on PostgreSQL** (`type "datetime" does not exist`): the
  `wordjs_analytics` DDL used a literal `DATETIME`. Changed to `TIMESTAMP` (valid on Postgres, MySQL and
  SQLite affinity) so analytics works on every driver.

## [1.6.1] - 2026-07-18

### Fixed

- **CRITICAL: the v1.6.0 compiled release bundle crashed on boot** with
  `Cannot find module './marketplace'`. The release packager (`scripts/make-release.js`) excluded any
  path *containing* the substring `marketplace` (to keep the separately-distributed `marketplace/`
  plugin catalog out of the core ZIP), which also silently stripped the compiled marketplace **route**
  `backend/dist/routes/marketplace.js`. Every production install from the v1.6.0 ZIP (mono and split)
  therefore failed to start. The packager now matches ignore patterns at **path-segment boundaries**
  instead of as substrings, so `routes/marketplace.js` is kept while the top-level `marketplace/`
  catalog (and all secrets) stay excluded. **Upgrade from v1.6.0 to v1.6.1.**

### Added

- **`npx create-wordjs` now sets up separate mode too — one command per machine.** Two new
  subcommands turn a multi-machine deploy into a single command on each box:
  `npx create-wordjs gateway --host <ip>` installs this machine as the cluster gateway (mints the CA +
  config and prints ready-to-paste join commands with fresh tokens), and
  `npx create-wordjs join <backend|frontend> --gateway <ip> --token <t> --advertise <ip>` downloads the
  bundle, enrolls with the gateway (delegating to the bundled `scripts/node-join.js`), and starts +
  registers the service. Previously separate mode required cloning the repo and running the
  `scripts/*.js` by hand. `join` needs `openssl` on PATH; see
  [separate-mode.md](documentation/separate-mode.md).

## [1.6.0] - 2026-07-18

Two headline themes on top of the plugin Marketplace: **running WordJS across multiple machines** — a
new distributed *separate mode* joined by gateway-issued **join tokens** — and a **deep
security-hardening pass** (a full adversarial audit of core and every bundled plugin, remediated end
to end).

### Added

- **Separate mode — run the gateway, backend, and frontend on three different machines**, joined with
  kubeadm-style **join tokens** instead of hand-copied certificates. The gateway is the cluster CA:
  `node scripts/cluster.js init` mints the cluster CA (keeping the CA private key on the gateway) plus
  the gateway's own identity and public certs; `node scripts/cluster.js token <backend|frontend>`
  prints a **single-use, role-bound, TTL-limited** token; on the new machine
  `node scripts/node-join.js --role … --token … --advertise …` generates a keypair + CSR, calls the
  gateway's **token-enrollment endpoint** (a dedicated listener on `gatewayEnrollPort`, default 3101,
  separate from the strict mTLS `/register` control plane), and receives a signed `CN=<role>` mTLS
  identity + the cluster CA + bootstrap config — then the service starts and **registers with the
  gateway over mTLS**. The token authorizes only the first contact; a `--ca-hash` pin guards against a
  man-in-the-middle. New files: `gateway/src/cluster-ca.js`, `scripts/cluster.js`,
  `scripts/node-join.js`, and the step-by-step [separate-mode guide](documentation/separate-mode.md).
  The frontend now advertises a routable `advertiseHost` to the gateway (instead of a hard-coded
  loopback), and its server-side render base is configurable via `internalApiUrl`.
- **Plugin Marketplace (browse + one-click install from the admin).** Plugins are distributed
  decoupled from core releases: sources live in `marketplace/plugins/`, and
  `backend/scripts/build-marketplace.js` produces a committed catalog (`marketplace/dist/` —
  `marketplace-index.json` + one ZIP per plugin) served by default from
  `raw.githubusercontent.com`, so merging a plugin update to `main` updates every site's catalog
  immediately without a core release (tagged releases also attach a catalog snapshot for pinning).
  A new backend API (`backend/src/routes/marketplace.ts`, admin-only) resolves the catalog source
  (option `marketplace_source`: an http(s) URL, a local dir for dev/air-gapped installs, or the
  default) and installs an entry by downloading its ZIP, **verifying its sha256 against the catalog
  entry**, and handing it to the SAME `installPluginFromZip()` pipeline as manual uploads (zip-bomb
  budget, Zip Slip, slug validation, manifest + AST scan) — the marketplace adds no new install
  surface beyond the catalog fetch. The admin Plugins screen gains a **Marketplace tab**
  (`frontend/src/app/admin/plugins/MarketplaceTab.tsx`) with search, categories, requested-permission
  preview, and installed/update-available state.
- **25 first-party marketplace plugins** at launch: analytics-tag, auctions, bookings, breadcrumbs,
  contact-forms, cookie-consent, digital-downloads, donations, event-tickets, events-calendar, faq,
  image-lightbox, invoices, job-board, newsletter, notification-bar, online-store, polls,
  popup-builder, related-posts, restaurant-menu, social-share, table-of-contents, testimonials, and
  vendor-marketplace — every one sandboxed and permission-gated like any uploaded plugin.
- **New bundled `youtube-videos` plugin.** Pulls a YouTube channel's videos (links, thumbnails,
  titles) and ships a Puck **carousel block** with title filtering and a video-count limit. Works
  **keyless out of the box** via the channel RSS feed (latest 15 videos); add a YouTube Data API v3
  key for the full upload history (stored in the plugin's own `wjp_` tables).

### Security

- **Full adversarial security audit of core and every bundled plugin, remediated end to end.**
  - **Themes now run in the same child-process OS-isolation as plugins.** A theme's `functions.js` is
    no longer `require()`d on the host main thread — it executes in a sandboxed child, closing an
    in-process code-execution class (a malicious or compromised theme could otherwise reach
    `child_process` / `process.env` / the filesystem past the static install-time scanner).
  - **The per-plugin SQL guard was rewritten as a single-pass lexer** backed by an authoritative
    table→creator registry, closing a family of cross-plugin and core-table read bypasses (comma
    cross-joins, quoted identifiers, comment / CTE / `WINDOW` poisoning, and a ReDoS) while keeping
    every plugin scoped to its own `wjp_<slug>_` tables.
  - **The filesystem sandbox was unified across the callback and `fs.promises` APIs** — path
    containment, secret/DB-file and executable-extension write blocks, symlink and file-descriptor
    guards, and a per-plugin write quota — and the `require`/proxy layer was hardened so a plugin can
    no longer recover an unguarded `fs` handle.
  - **A CSPRNG bridge (`wordjs.crypto`)** so plugins stop minting security tokens with `Math.random()`.
  - Additional hardening: `/setup/migrate` is no longer a password-brute-force oracle or a
    config-secret leak; stronger admin-role and forwarded-header guards; privacy-preserving per-client
    keys for rate limiting; and the network egress guard closes blind-UDP and DNS-rebind vectors.
  - **Inter-service traffic is mutual TLS** (a cluster CA with per-node `CN` identities); the new
    join-token enrollment bootstraps a node's identity **without ever shipping the CA private key**.

### Changed

- **Conference Manager overhauled to v2.1.0.** Adds a **Reports** section with CSV export; fixes a
  blocker in inscription creation; hardens payment/assignment integrity (updates guarded against
  the non-transactional plugin DB bridge); revives dead admin buttons; and fixes portal-side issues
  on the public conference page.

## [1.5.4] - 2026-07-12

### Fixed

- **Full responsive pass over every bundled theme, verified in a real browser at mobile (375px),
  tablet (768px), and desktop (#160).** The framework (`wordjs-ui.css`) now contains wide content
  GLOBALLY, not mobile-only — wide tables and `<pre>` become their own horizontal scroll containers,
  unbreakable strings word-wrap, media is capped at 100% width — on BOTH content paths (classic
  `.wjs-content` AND the visual editor's `.puck-content`, which previously had no containment at
  all). A mobile type scale caps each heading at `min(theme token, sensible cap)` under 768px via the
  framework-owned `--wjs-hN-size` aliases, so desktop keeps every theme's own scale. Nine themes got
  targeted mobile fixes (overflowing scaled pricing cards, tall fixed mastheads leaving dead gaps,
  oversized `!important` typography, decorative pseudo-element overhangs) — including a **critical**
  one: two themes hid `.wjs-header-actions` with an unscoped `display:none !important`, and that slot
  holds the chrome's mobile hamburger, so those themes had NO navigation at all on phones.
- **Switching the active theme at runtime no longer accumulates both themes' CSS.** A v1.5.1
  regression: React `precedence` stylesheets are add-only, so activating another theme kept the old
  `<link>` and the wrong theme could win the cascade until a full reload. The previous theme's link
  is now evicted when the slug changes (`ThemeLoader`), and `ASSET_VERSION` is bumped so cached
  browsers pick up the changed CSS.

## [1.5.3] - 2026-07-12

### Added

- **`npx create-wordjs upgrade` — in-place updates for an existing site (#159).** Downloads the
  latest (or `--version <tag>`) release and swaps in the new app code WHILE PRESERVING user state:
  the database (`backend/data`), uploads, config + secrets, and any user-installed plugins (merge
  copy, never deletes files not in the release); pure build outputs (`frontend/.next`,
  `backend/dist`) are clean-replaced so no stale chunks linger, then `release:install` re-syncs
  dependencies (schema migrations apply on next boot). Guardrails: verifies the target is a real
  WordJS install, no-ops when already on the target version (`--force` to re-apply), backs up the
  config files, asks for confirmation on a TTY (or `--yes`), and rolls back via `--version <old-tag>`
  (data untouched). Closes the "how do I upgrade?" gap — previously the only path was a fresh install.

## [1.5.2] - 2026-07-12

### Fixed

- **SSR sanitizer stripped ALL Puck rich-text formatting in production builds (#158).**
  `lib/sanitize.ts` is a `"use client"` module whose `sanitizeHTML()` also runs during SERVER
  rendering of every Puck block; its SSR branch did `require('sanitize-html')`, which webpack
  rewrites — in the COMPILED production build that require resolved to a broken module and threw, so
  the catch-all fallback stripped EVERY tag: font size, font family, bold, links all silently
  vanished from public headings and text. Dev worked (`next dev` doesn't bundle the same way),
  production didn't. The library is now loaded through `__non_webpack_require__` (webpack's
  designated escape hatch, with fallbacks), so the real node module loads at SSR runtime and never
  enters the client bundle. Verified in a local prod build.

## [1.5.1] - 2026-07-12

### Fixed

- **Flash of unstyled content on public pages (#157).** `ThemeLoader` rendered the framework + theme
  `<link rel="stylesheet">` without React 19's `precedence` prop, so they were NON-render-blocking:
  the page painted with fallback token values and restyled once the CSS loaded. With `precedence`,
  React hoists them into `<head>` and blocks paint (framework group first, so the theme's `:root`
  still wins).
- **Puck text/heading styling ignored the active theme.** The block renderer references
  `var(--wjs-h1-size)` / `var(--wjs-font-family)` / `var(--wjs-color-text-heading)`, but the
  framework and every theme define `--wjs-h1` / `--wjs-font-family-base` / `--wjs-color-heading` —
  no theme (0/15) defined the names Puck uses, and with no fallback every Puck heading collapsed to
  16px. The block token names are now `:root` aliases of the canonical tokens in `wordjs-ui.css`, so
  headings/text pick up the theme's scale and font. Framework/theme CSS URLs are also versioned
  (`?v=ASSET_VERSION`) so the fix actually reaches browsers that cached the day-long stable URL.

## [1.5.0] - 2026-07-12

Focus: **account & access management** — every user gets a self-service account surface, and
password recovery works out of the box once any mail provider is active.

### Added

- **Self-service account page + subscriber gating (#156).** Subscribers (no `edit_posts`) are
  blocked from the dashboard and the Puck page editor and land on a new `/admin/account` page
  instead. Password change for ALL users via `PUT /users/me` verifying the current password (also
  fixes `/me` being shadowed by the `/:id` route, which 404'd it).
- **Personal/recovery email that coexists with the professional mailbox (#156).** The mail plugin's
  "Professional Mail Account" toggle overwrites `user.email` with `username@domain`, losing any
  personal address; a new independent personal email (user meta) is wired through create/update/
  toJSON, both admin user forms, and format validation — the deliverable target for password
  recovery, since a professional mailbox living INSIDE WordJS is unreachable when the user is locked
  out.
- **Public "forgot password" (#156), gated generically** — enabled when ANY mail provider is present
  (no plugin slug hardcoded): sha256 single-use token, 30-min expiry, timing-safe compare,
  anti-enumeration, sent to the personal/recovery address. The Email Center menu is likewise hidden
  behind a generic `requiresProfessionalMailbox` admin-menu flag. i18n (es/en/pt) for the account UI
  and reset flow, plus an integration test covering the full reset round-trip.

### Fixed

- **Editor font choices now render on the public page's first paint (#156).** A font picked in Puck
  reached the public DOM, but the `@font-face` rules were injected only client-side in a
  `useEffect` — so the first SSR paint fell back to the theme font (permanently, if client JS was
  slow or the fonts fetch failed). The installed fonts' `@font-face` CSS is now emitted into the
  initial `<head>` at SSR via a shared `buildFontFaceCss()` helper (`frontend/src/lib/fontFaceCss.ts`)
  that the client loader reuses for fonts uploaded after the SSR cache.
- **Mail to a user's PERSONAL address no longer lands in a WordJS inbox (#155).** A recipient was
  treated as local whenever it matched any user's email — so mail to a user's personal gmail.com
  address was captured into WordJS instead of delivered externally. A recipient is now local ONLY
  when its domain is the site domain AND that user's professional mailbox is enabled; applied to
  both the outbound split and the inbound accept path (catch-all is scoped to `@domain`).
- **The mailbox auto-refreshes (#154).** New or just-sent mail appeared only after a manual reload;
  a light silent poll (15s) of the current view plus an immediate refresh on tab focus (paused while
  composing / on settings / when hidden) keeps the folder live without spinner flicker.

## [1.4.3] - 2026-07-12

### Fixed

- **Full responsive pass across all admin/public surfaces + complete i18n coverage (#152).** 66
  class-only Tailwind fixes (desktop pixel-identical): tables wrapped in `overflow-x-auto`,
  fixed-width panels/drawers/modals/toasts capped to the viewport, cramped form grids collapse to
  one column on phones, unbreakable strings (emails, URLs, slugs, DKIM/ACME values) wrap or
  truncate, hover-only row actions made touch-visible, and `wordjs-ui.css` gains a mobile media
  block. i18n: 32 core keys that rendered RAW on screen (categories admin, users, plugin permission
  modal, …) + 18 conference-manager keys fixed across es/en/pt with zero cross-language gaps.
  Verified live at 375px: zero horizontal overflow, zero raw keys.

## [1.4.2] - 2026-07-11

### Fixed

- **Non-admin users can reach their own plugin UIs (#151).** `/plugins/menus` was gated `isAdmin`,
  so editors/authors/subscribers received ZERO plugin menu items — hiding e.g. the mail plugin's
  per-user webmail even though its data routes were already scoped per user. Each menu item is now
  returned only if the caller holds its declared capability; items declaring NO capability keep the
  old admin-only default, so nothing previously hidden is exposed. Every user now sees the Email
  Center with THEIR own scoped inbox; the Server Admin tab stays administrator-only.

## [1.4.1] - 2026-07-11

### Added

- **PROXY protocol (v1) support for inbound SMTP behind a TCP proxy (#150).** When inbound mail
  reaches WordJS through nginx `stream` (`proxy_protocol on;`) or HAProxy (`send-proxy`), every
  connection looked like the proxy — breaking SPF, DNSBL, and logging. A new "Trusted proxy IPs"
  setting (Email Center → Server Admin) makes WordJS read the PROXY header and recover the real
  sender IP, but ONLY from those exact proxy IPs (a client-forged header from any other origin is
  ignored — never a blanket trust). IP-only allowlist validated at save and at bind; IPv4 entries
  also match their `::ffff:` dual-stack form; direct senders unaffected. Verified end-to-end.

## [1.4.0] - 2026-07-11

### Added

- **Zero-config, consent-gated liberation of a squatted port 25 (#149).** Distro LXC templates ship
  Postfix/Exim bound to `:25`, forcing the mail listener onto the degraded fallback port. WordJS now
  detects the squatter (socket scan + known-MTA allowlist) and offers a one-click, explicitly
  confirmed fix: permanently disable the service and rebind. Host-side only (no plugin/bridge
  reach), admin-authenticated, gated on a manifest `claimPorts` declaration, with a server-side
  consent flag closing the client TOCTOU. Includes 16 tests.

### Fixed

- **A saved `siteUrl` takes effect immediately** — `saveConfig` now hot-reloads the in-memory
  config, so CSRF/CORS honor a just-set site URL without a process restart.
- **Updated plugin admin UIs reach cached browsers.** Plugin bundles were served with a 1-year
  immutable `Cache-Control` on an unversioned URL, so an updated plugin's UI stayed invisible for a
  year; they are now served with an ETag + `no-cache` (a tiny 304 when unchanged, fresh bytes the
  moment the bundle changes).
- **Plugin UI hooks register idempotently** — `initPlugins` re-ran on every admin-layout remount and
  stacked duplicate UI elements (e.g. the professional-mail toggle rendering twice); a run-once
  guard + keyed re-registration fix it.
- **A user can save their own profile again.** The user form always resends the current role, so the
  self-role-change guard 403'd EVERY self-save (an admin could never save their own email or display
  name). An unchanged role is now treated as a no-op; a genuine self role change stays blocked.

## [1.3.1] - 2026-07-11

### Fixed

- **Regex `.exec()` false-positive blocked plugin activation (#148).** The plugin AST scanner flags
  any call to a method named `exec`/`eval`/`spawn`/… by NAME only, so a benign
  `/regex/.exec(str)` — `RegExp.prototype.exec` — was rejected as a forbidden command; v1.3.0's
  mail-server DNS verification used one to parse the DKIM key, so activating the mail server failed
  on a fresh install. The scanner now exempts the regex-LITERAL form only (`someVar.exec()` stays
  flagged, since it could be a `child_process` handle it can't resolve statically), and the
  mail-server switched to `String(...).match(...)`.

## [1.3.0] - 2026-07-11

Focus: **a functional, zero-config mail server** — a 6-agent audit plus live bidirectional SMTP
testing on a 2-MTA lab found the mail-server plugin was not functional beyond local injection, and
this release fixes the whole chain (inbound, local delivery, threading, DNS setup) — and
**plugin-sandbox security hardening**: a fresh adversarial red-team of the sandbox surfaced
weaknesses that were almost entirely HOST-SIDE (the admin upload/extraction path, which runs on the
real filesystem outside the child's io-guard, and the options bridge). The child sandbox itself held.
Still self-audited, not independently audited.

### Security

- **Plugin self-code-modification / read-confinement closed in the io-guard (#132).** The io-guard now
  patches `copyFile`/`copyFileSync`/`cp`/`cpSync`/`link`/`linkSync` (previously **unpatched**) —
  source is read-checked and destination write-checked — so a plugin can neither copy a secret /
  out-of-zone file OUT (a bypass that dodged the `readFile` block) nor copy/hard-link a file into an
  executable name. It also **refuses to create, overwrite, or rename/copy a file into an executable
  code extension** (`.js`/`.cjs`/`.mjs`/`.node`/`.wasm` + TS variants) **anywhere a plugin can write,
  including its own dir** — the AST scanner only vets committed code, so a runtime-planted `.js`
  (directly, or "write `.txt` then rename to `.js`") would otherwise run un-scanned; data files
  (`.json`/`.txt`/images) stay writable. `secure-require` additionally denies a plugin/theme module
  `require()`-ing code out of a writable data dir (uploads/data/os-tmp/logs).
- **Host RCE via crafted upload closed (#133, critical).** A ZIP named `…zip` made
  `path.parse().name === '..'`, so a multi-root archive redirected extraction to `backend/` and planted
  a host-`require()`d module. The derived slug is now validated (strict single segment) **before** any
  `path.join`, and only validated content entries are extracted (per-entry, junk-filtered) into a
  guaranteed child of the plugin's own dir.
- **Permission self-escalation closed (#133, critical).** A `settings:write` plugin could
  `options.set('plugin_grants', …)` and self-grant every capability at the next boot. `plugin_grants`,
  `cron`, `plugin_strikes`, and `plugin_health` are now protected option names in the options bridge
  (alongside `roles`/`active_plugins`/`siteurl`/…, `core/plugin-api.ts`), and `loadGrants`
  shape-validates tokens (`core/plugin-permissions.ts`).
- **SSRF numeric-IPv6 bypass closed (#133, critical).** The egress filter matched textual IPv6 shape,
  so full-form `::1` and IPv4-mapped `::ffff:169.254.169.254` slipped through to loopback/metadata. It
  now parses a real 16-byte address (handles `::`, embedded IPv4, NAT64 `64:ff9b::/96`, and deprecated
  `fec0::/10` site-local) before range-checking (`core/egress-guard.ts`).
- **Unauthenticated download/delete traversal closed (#133).** `GET /plugins/:slug/download` and
  `DELETE /plugins/:slug` now validate the slug through a shared `resolveSafePluginDir()`, so a `%2f`
  path could no longer exfiltrate the DB or delete arbitrary directories.
- **Raw-fs disk-fill DoS closed (#133).** The io-guard confined WHERE a plugin writes but not HOW MUCH;
  a **per-plugin write quota** (single-write cap + rolling append/stream window) now applies in the
  io-guard AND the `fs.promises` proxy + `FileHandle` (the promises path bypassed the callback-fs patch).
- **Assorted (#133):** `cron` writes drop events whose `pluginSlug` isn't an active plugin; Multer temp
  uploads are unlinked on response finish plus a startup reaper; child stdout/stderr flow through a
  slug-tagged rate limiter; the AST scanner now flags aliased/indirect `eval` and the `Function`
  constructor; and macOS ZIP junk (`__MACOSX`/`.DS_Store`) is tolerated so valid uploads aren't
  rejected.

### Added

_Mail server — from "receives nothing out of the box" to zero-config internet mail, verified live
on a 2-MTA lab with real MX routing:_

- **Inbound defaults to port 25 with an honest fallback + live status (#144).** Internet mail is
  only ever delivered to port 25, but the listener defaulted to 2525 — so out of the box it
  silently received nothing. It now probe-then-binds 25 (works unconfigured on Windows / privileged
  runs / Linux with `CAP_NET_BIND_SERVICE`, which `create-wordjs` prints the one-time grant for);
  when 25 isn't bindable it falls back to 2525 and the Server Admin screen shows a green "Receiving
  on port 25" or an amber degraded banner with the exact reason, instead of a silent no-inbound.
- **DNS setup that tells you when you got it right (#145, #146).** The DNS card now lists ALL the
  records inbound + outbound need in setup order (MX, A, SPF, DKIM, DMARC, PTR) with a per-provider
  (Cloudflare/Hostinger/GoDaddy/Namecheap) "how to add these" guide — and a **Verify DNS** button
  that resolves the LIVE DNS and shows a per-record status pill (verified / not found yet /
  doesn't match), including an exact-key DKIM comparison so a wrong published key reports
  "mismatch", not a false pass.
- **Real conversation threading (RFC 5322) (#142).** One stable `Message-ID` per send is used for
  both the stored record and the wire header, and inbound replies resolve `In-Reply-To`/`References`
  to inherit the thread — so a cross-user conversation groups into one collapsed row instead of
  splintering.
- **Configurable relay/smarthost (#137)** — host/port/TLS/credentials in settings, with the
  transporter re-created on save; previously the relay path was unreachable and delivery was stuck
  on direct-MX port 25 (blocked by most clouds).

### Fixed

- **Inbound receipt actually works (#137, #139).** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is stripped
  before SPF/DNSBL — the dual-stack listener reported the mapped form, so SPF matched no mechanism
  and essentially EVERY real IPv4 sender was rejected; DNSBL now fails open on lookup error (only a
  positive listing rejects). And mailparser's non-bindable values (`false` for a missing HTML part,
  omitted subject/messageId) are normalized before the SQLite INSERT — a plain-text inbound mail
  previously 450'd the whole message at end-of-DATA.
- **Local delivery works on a default install (#138).** `user@localhost` (every default account) was
  rejected by the address validator, and the validator's `net.isIP()` call threw under
  `secure-require` for a plugin without the `network` grant — breaking ALL sends. Single-label
  domains are accepted (they only resolve to a LOCAL user), and the IP-literal check is pure JS.
- **18 Email Center UI bugs found by driving the plugin live in a browser (#140)** — headline: the
  reading pane was crushed to ~280px on desktop (one word per line) by a fixed-width message list;
  plus a global success/error toast for every mailbox action, forward keeping the HTML body,
  signature no longer double-appended, and more. **Self-sent messages no longer appear twice in a
  thread (#141)** — the inbox copy is skipped when recipient === sender.
- **The admin sidebar showed "Media" twice (#143)** — the `attachment` post type registered its own
  menu item next to the explicit Media Library entry; also dropped leftover DEBUG boot logs.

### Changed

- **Public-page SSR data is cached (ISR) and static assets get real `Cache-Control` (#135).**
  Public reads opt into Next's Data Cache (settings 60s, plugin assets 120s, posts/pages 30s, each
  tagged for future on-demand purging; per-user draft-preview reads stay `no-store`), collapsing ~8
  backend `/settings` calls per render to one. `/uploads` is served
  `max-age=31536000, immutable` (UUID-unique filenames), themes/plugins 1h with ETag revalidation.
  Note: Next's cross-request Data Cache only persists in a production build, not `next dev`.
- **The public Header/Footer chrome is server-rendered (#136).** Both were `"use client"` components
  that re-fetched settings + menus on every visit after the page had already SSR'd — a per-visitor
  double round-trip that shipped an empty header in the initial HTML. They now render from data the
  server already fetched (with the client-fetch fallback kept for the Puck editor preview).
- **Documentation reconciled with the code (#134)** — every canonical doc brought back in line after
  the plugin-system overhaul, the sandbox hardening, and releases 1.2.1–1.2.3.

## [1.2.3] - 2026-07-09

### Fixed

- **Safe inline styles are kept so rich-text formatting renders.** The visual editor emits font size,
  text color, highlight, font family, and alignment as inline `style` (Tiptap TextStyle/FontSize/Color/
  BackgroundColor/FontFamily/TextAlign); the sanitizer had dropped the `style` attribute wholesale (a
  prior XSS hardening), so those formats showed while editing but vanished on the non-editing canvas and
  the public page. `style` is now allowed but scrubbed to a typographic allowlist (`color`,
  `background-color`, `font-size`, `font-family`, `font-weight`, `font-style`, `text-decoration`,
  `text-align`, `line-height`, `text-transform`) with injection-free values — `url()`/`expression()`/
  `@import` and any unknown property are stripped, on both the DOMPurify (client) and `sanitize-html`
  (SSR) paths (`frontend/src/lib/sanitize.ts`).

### Added

- **The default theme is now WordJS's own visual identity** — a signature indigo→violet gradient,
  Space Grotesk display + Inter body + JetBrains Mono, a light canvas and a deep-indigo footer — styling
  the live (Next.js) chrome via the existing `.wjs-header-*`/`.wjs-footer-*` hooks and `--wjs-*` tokens.

### Changed

- **The active theme's stylesheet is server-rendered (no FOUC).** The public site had loaded the theme
  `style.css` via a `"use client"` loader in a `useEffect`, so the first paint carried only the fallback
  `default` stylesheet and swapped the real theme in after hydration — a flash of the wrong theme is gone.

## [1.2.2] - 2026-07-08

### Fixed

- **Zero-config CORS behind a reverse proxy.** Production CORS only allowed the configured origins
  (`siteUrl`/`frontendUrl`/`gatewayUrl`), so a fresh install behind a reverse proxy rejected every
  credentialed API call (and the install wizard's own same-origin calls) until the operator hand-edited
  `siteUrl`. A request is now also allowed when its `Origin` hostname matches the `Host` header it
  arrived on — the monolith serves frontend + API from one origin, so app/wizard calls are always
  same-origin. `Host` is a browser-set forbidden fetch header, so a cross-site attacker can't forge the
  match (no takeover hole); disallowed origins now get no CORS header instead of a thrown error (ending
  the log spam). Needs `proxy_set_header Host $host` (the migration guard already requires it)
  (`backend/src/index.ts`).

## [1.2.1] - 2026-07-08

### Fixed

- **Monolith self-signed HTTPS serves a certificate.** `selfsigned` v5 made `generate()` async, but the
  monolith's `resolveSSL()` called it **without `await`**, so key/cert were `undefined` and
  `https.createServer` served no certificate — every fresh self-signed HTTPS install failed the TLS
  handshake (`sslv3 alert handshake_failure`). `resolveSSL()` is now `async` and awaits the call, matching
  cert-manager and the gateway (`monolith.js`).

## [1.2.0] - 2026-07-08

Focus: **a single sandboxed plugin model — the "trusted" tier is gone.** Every plugin runs in the
OS-process sandbox; capabilities are admin-granted per plugin (Android-style, default-deny). No plugin
bypasses the sandbox anymore. This builds on the move from a worker-thread (heap) boundary to a separate
OS process, and ten adversarial red-team rounds' worth of findings.

This window also folds in three **self-audit remediation cycles** (a whole-project adversarial review
of sandbox egress, auth/access, XSS, data integrity, injection, mail, and deploy/ops, then the fixes
below). WordJS remains pre-production and **self-audited, not independently audited** — these are our
own findings and fixes; see the [README](README.md) for the honest maturity caveats.

### Added

_Visual editor:_

- **Editor overhaul.** Undo/redo with keyboard shortcuts and block cut/copy/paste, autosave (drafts,
  where `autosave: true` skips a revision), a link popover with content search, highlight and
  clear-formatting, several new blocks, per-device (desktop/tablet/mobile) visibility, block entrance
  animations, and Patterns 2.0 (live previews + save-as-pattern).
- **The Puck visual editor is internationalized** — its chrome strings are localized rather than
  English-only.

_Adoption & product — getting from zero to a live, editable site:_

- **`npx create-wordjs` one-command bootstrap.** Fetches the latest pre-compiled release, installs
  runtime deps, starts the single-process server, and prints a clickable install-wizard URL with the
  security token pre-filled — the Strapi/Payload-style funnel developers expect (`packages/create-wordjs`).
- **First-run rescue.** A not-yet-installed instance now redirects visitors straight to `/install`
  (instead of a blank "Service Temporarily Unavailable"); a Node **>= 20.9** preflight fails with a
  plain-English message instead of a cryptic native-binding crash; and the server console prints a
  clickable `…/install?token=…` URL the wizard reads and then scrubs from the address bar.
- **Starter content at install (opt-in, default on).** Seeds a visually-built home page (set as the
  front page), a welcome post, an About page, and a header menu — so a fresh site shows off the visual
  editor and token themes immediately instead of "No posts found".
- **Draft preview on the live site + visual revision diff.** A **Preview** button opens a draft on the
  real (SSR) site via `?preview=1` (author-only, `noindex`, never leaks to anonymous visitors); the
  revisions sidebar gains a word-level **Changes** diff (ins/del) with restore.
- **Content lists that scale.** The Posts/Pages admin lists gained pagination, debounced search,
  status tabs (All/Published/Drafts/Pending), bulk delete, and per-row View + Duplicate — the old lists
  silently showed only the first 10 items.
- **RSS 2.0 feed** at `/feed` (+ `/feed.xml`, `/rss.xml`) with `<link rel="alternate">` auto-discovery.
- **SEO out of the box, corrected.** Live **JSON-LD** (`WebSite`+`SearchAction` on the home, `BlogPosting`/
  `WebPage` on content); the sitemap/RSS/preview canonical URLs now match the pages' own `rel=canonical`
  (`/<slug>` for posts **and** pages — they previously advertised a non-canonical `/blog/<slug>`); and
  `og:image` now uses the post's real featured image.
- **Plugin-author DX pack.** A `wordjs` scaffolder CLI (`create plugin`/`create theme`/`pack`), hand-written
  `wordjs-bridge.d.ts` types for IntelliSense, and dev **hot-reload** (save a file in an active plugin →
  its sandboxed child re-spawns, AST scan and all) plus an admin `POST /plugins/:slug/reload`.

_Plugin system overhaul — the sandbox made visible, self-healing, and complete:_

- **Runtime supervisor + per-isolate health.** Each active plugin now reports live state
  (running / restarting / crashed / crash-looping), pid, RSS, uptime, restart count, and the real death
  reason. A crashed child is **auto-restarted with exponential backoff** (1s→5s→15s→60s) and marked
  crash-looping after too many failures; the admin Plugins screen shows a status dot + a Restart button;
  `GET /plugins/:slug/status` exposes the telemetry. A crashed plugin no longer shows a misleading green "active".
- **True uninstall.** Deleting a plugin now purges its permission **grants** (previously leaked — a
  re-uploaded slug inherited old, possibly-revoked grants) and crash strikes; an opt-in "Also delete this
  plugin's data/tables" checkbox drops its own `wjp_<slug>_*` tables (never core or other plugins').
- **Hardened plugin/theme install.** A decompression-bomb cap (uncompressed size + entry count) on every
  extract path (plugin/theme upload, backup restore); uploads are validated up front (manifest shape,
  `isolated: true`, known permission scopes, AST scan) so a bad ZIP fails immediately and never lingers on
  disk; re-uploading a **currently-active** plugin is refused to avoid corrupting a running one.
- **Frontend asset enqueue** (`wordjs.assets.enqueueScript/enqueueStyle`, `assets` grant). A structured,
  sanitized way for a plugin to load a `<script>`/`<style>` from its own directory onto public pages —
  the raw-HTML head/footer hooks stay hard-denied (stored-XSS), so this unblocks analytics tags, cookie
  banners and web-component blocks without letting a plugin control markup.
- **Admin plugin management UX.** Search + Active/Inactive filter, a per-plugin detail drawer
  (author/homepage/version + requested-vs-granted permission diff + reload), platform-authored permission
  **risk labels** on the grant screen, and a structured activation-reject panel that separates a fixable
  missing-grant from hard-blocked forbidden code.
- **Quieter logs.** The sandbox io-guard's block warnings are now rate-limited/coalesced, so a plugin in a
  tight denied-fs loop can no longer flood the host log.

- **Theme UI framework (Bootstrap-like, token-driven).** Themes now share one stylesheet
  (`backend/public/css/wordjs-ui.css`) that auto-styles **every** standard HTML element and ships
  Bootstrap-compatible **components** (`.btn`/`.card`/`.alert`/`.badge`/`.table`/`.nav`/`.list-group`/
  `.pagination`/`.modal`/grid…) and a **utility** layer (spacing/display/flex/text/colors/borders/
  sizing…). Everything is driven by `--wjs-*` design tokens, so a theme re-skins the entire framework
  just by declaring tokens in its `:root` — colors, typography scale, spacing, radius, shadows. Loaded on
  public pages **and the editor preview** (WYSIWYG), never the admin UI; the theme stylesheet loads after
  the framework so a theme's own rules always win. All 13 bundled themes ship a full canonical token set
  tuned to their palette (light/dark/mono/glass/brutalist). See `documentation/theming.md`.
- **`noImplicitAny` is now enforced (CI-gated).** Every implicit-any site in the backend (~1,276 across
  92 files) is annotated — real types where locally determinable (Express `Request`/`Response`/
  `NextFunction`, primitives, model/array element types), explicit `any` only at genuinely dynamic
  boundaries (plugin payloads, RPC/hook glue, request bodies). The pass was **type-only** (annotations
  and `as` casts erase at compile time, so runtime is unchanged — verified by transpiling every changed
  file before/after and confirming byte-identical JS), so it introduces no behavior change. The strict
  core (`strictNullChecks`, `strictFunctionTypes`, etc.) was already enforced; the only remaining strict
  sub-flag deliberately off is `useUnknownInCatchVariables`.
- **Opt-in kernel hardening of the plugin sandbox (Linux, default-off).** With
  `config.sandbox.useKernelHardening`, each isolated plugin child runs through bubblewrap as an
  unprivileged uid with all Linux capabilities dropped, `no-new-privs`, PID/IPC/UTS namespaces, a
  read-only filesystem (app root writable), **and a seccomp-bpf syscall denylist** (ptrace, mount,
  kexec, `*_module`, bpf, keyctl, userfaultfd, setns, `process_vm_*`, … → EPERM; x86_64 also denies the
  x32 ABI). Probe-validated per host, composes with the memory caps, network preserved — zero regression
  on single-node / Windows / macOS. The Landlock LSM is intentionally not used (the read-only mount
  namespace already provides its filesystem confinement). Validate with `verify-sandbox-hardening.js`.
- **Preventive memory cap on Windows (Job Object, default-on).** Each isolated plugin child is assigned
  to a Windows Job Object with `JOB_OBJECT_LIMIT_PROCESS_MEMORY` (768 MB) — the Win32 analog of the Linux
  cgroup `memory.max` — so the kernel fails any over-budget commit instead of only the reactive RSS poll
  catching it after the fact. Implemented with a one-shot PowerShell P/Invoke (**pure-JS, no native
  dependency**) that assigns the already-forked child by PID (the fork IPC channel is untouched) then
  exits; the job and its limit persist for the child's lifetime via the kernel job refcount. Probe-gated
  with graceful fallback to the RSS poll (the brief post-fork assign window is covered by that poll,
  exactly as before); opt out via `config.sandbox.useJobObjectMemoryCap=false`. No-op (zero regression)
  on Linux/macOS, where the cgroup/RSS-poll caps are unchanged.
- **Live cross-node plugin activate/deactivate propagation (multi-node).** Activating or deactivating a
  plugin on one node now propagates to the others over Redis (`wordjs:plugin-changed`): each node
  loads/unloads that one isolated plugin live (forked child + routes/hooks/menus) — no rolling restart.
  No-op on single-node. (Cross-node role/option coherence and the `active_plugins` distributed lock were
  already in place.)

### Changed

- **One plugin model: every plugin is sandboxed; capabilities are admin-granted per plugin.** The binary
  trusted/untrusted split is replaced by a single Android-style model — a manifest *requests*
  capabilities, an admin *grants* each one per plugin (default-deny), and a bridge call works only if the
  capability is BOTH declared in the manifest AND granted. First-party plugins (`mail-server`,
  `conference-manager`, the galleries, …) are **pre-granted** their declared capabilities for a working
  out-of-box experience, but they are **not privileged** — they run in the same sandbox under the same
  grant checks as anything uploaded. There is no trust bypass.
- **Plugin sandbox is OS-process isolation.** Every (`"isolated": true`) plugin runs in a **separate OS
  process** (`child_process.fork`) instead of a `worker_threads` Worker. A child has its own heap, event
  loop, and memory; a crash, OOM, or heap escape is contained to the child and can no longer take down the
  host. The plugin reaches core only through the permission-checked `wordjs` bridge (over IPC,
  structured-clone). A `worker_threads` transport remains as a fallback.

### Removed

- **The entire "trusted" plugin tier and its bypass machinery.** Removed `plugin-trust.ts`,
  `config.trustedSystemPlugins`, the `__WORDJS_PLUGIN_TRUSTED__` child flag, the `system:admin`
  AST-scan-skip, and the admin **trust toggle** (`POST /plugins/:slug/trust`, the `trusted_plugins`
  option). No plugin can be marked trusted, and nothing exempts a plugin from the sandbox or the AST
  scanner.
- **Raw/unsafe capabilities that no plugin can be granted anymore:** shell / `child_process` exec, native
  addons (`dlopen`), AST-scan skip, raw cookie jar / verbatim `Set-Cookie`/`CSP`/`HSTS`/`Location`,
  raw-HTML hooks (`wordjs_head`/`wordjs_footer`), unscoped / core-table DB access, and secret-named
  options. These are gone for **every** plugin — they are no longer reachable through any grant or tier.

### Added

- **Android-style per-plugin permissions (admin-controlled, default-deny).** A plugin's manifest now
  only *requests* capabilities; an operator GRANTS each one per plugin via toggles in `/admin/plugins`,
  and a bridge capability works only if it is BOTH declared in the manifest AND granted by the admin
  (`core/plugin-permissions.ts`, option `plugin_grants`). New grant tokens: **`users:read`** (a safe user
  projection), **`email:provider`**, **`notifications:provider`**, and **`network`** (outbound access,
  with an exfiltration warning). New endpoint `POST /plugins/:slug/permissions`, and a one-time
  grandfather of already-active plugins on upgrade so the switch to default-deny is non-breaking.
- **New safe bridges (the in-sandbox replacements for the removed privileged surface):**
  - `wordjs.users.{findByEmail,findByLogin,findById,search}` — gated on `users:read`, returns a **safe
    projection** `{id, userLogin, username, userEmail, displayName, role}` only (never `user_pass` or any
    other credential field).
  - `wordjs.site.{url, domain, adminEmail}` — gated on `settings:read`.
  These give plugins the user/site data they legitimately need without ever exposing core tables or
  secrets, so the previously trust-only use cases are met from inside the sandbox.
- **Layered per-child memory caps.** A reactive host-side RSS poll that SIGKILLs a child over budget on
  every platform (Linux `/proc`, Windows `tasklist`, macOS `ps`), a loose `RLIMIT_AS` virtual backstop,
  and an **opt-in preventive cgroup v2 `MemoryMax`** on systemd Linux (`config.sandbox.useCgroupMemoryCap`,
  applied via `systemd-run --user --scope`, probe-gated). New config: `sandbox.useCgroupMemoryCap`,
  `sandbox.addressSpaceCapMb`.

### Security

- **Bridge-call allowlist** — the IPC `call` dispatcher now default-denies any method outside an exact
  allowlist, so a malicious child can't reach registration/privileged methods past their dedicated gates.
- **DB scoping** hardened: per-plugin `wjp_<slug>_` prefix attribution rejects ATTACH/PRAGMA, schema
  catalogs, stacked statements, comma-joins, and the Postgres `USING`/`RETURNING` exfil path; core tables
  off-limits. `io-guard` now blocks plugin reads of the database files.
- **Route hardening** for **all** plugins (there is no privileged exemption): plugin routes are always
  namespaced under `/api/v1/plugin/<slug>`, the host auth JWT cookie (`wordjs_token`) is stripped from
  forwarded requests, and `Set-Cookie`/CSP/HSTS/Location and plugin-set cookies are sanitized/namespaced.
  Raw-HTML hooks (`wordjs_head`/`wordjs_footer`) are denied to every plugin. Mail/notification providing
  is now a grantable bridge capability (`email:provider` / `notifications:provider`), still sandboxed —
  not a trust-tier privilege.
- **DoS containment**: per-child bridge-call rate + global IPC message-rate caps, inbound/outbound
  payload caps, `fs.write` size + per-plugin disk quota, admin-menu caps, wedged-child recycling.
- AST scanner extended (dynamic `import()`, `.constructor`, `process`/`global` aliasing); cross-tenant
  uploads read closed; activation-time host-RCE via plugin test files closed.
- **Network grant is confined to PUBLIC destinations only** (`core/egress-guard.ts`). When a plugin is
  granted `network`, its outbound connections are validated AT CONNECT TIME (anti-DNS-rebinding) across
  `net`/`tls`/`http`/`https`/`http2`/`dgram` and the global `fetch`/`WebSocket`: loopback, link-local
  (incl. `169.254.169.254` cloud metadata), RFC1918, CGNAT (`100.64.0.0/10`), IPv6 ULA/loopback,
  IPv4-mapped-v6, multicast and unspecified ranges are blocked, and an unresolvable/garbage host
  **fails closed**. IPC / unix-socket / named-pipe targets (e.g. the `path` option, `/var/run/docker.sock`)
  are denied outright. Redirects are followed by native `fetch`, and **every hop is IP-validated at
  connect time** by the locked socket chokepoint (next bullet) — so a redirect to a private/metadata
  host is blocked at the socket layer, not by re-parsing the URL.
- **Egress chokepoint locked inside the isolated child (EG-1).** The guard patches
  `net.Socket.prototype.connect` in the child as the single enforcement point and **locks it**
  (non-writable, non-configurable) so a plugin cannot reassign or un-patch it to restore raw SSRF; it
  covers the `net.Stream` alias, the `getPrototypeOf(Socket.prototype).connect` bypass, and the
  pre-normalized `[options, cb]` connect-arg array. The connect `host`/`hostname`/`path` are snapshotted
  once, validated, then frozen as own data-properties (TOCTOU defense). Unix-socket and `dgram` egress
  to a private/blocked target are denied.
- **Account-takeover / privilege-escalation guards on `PUT /users/:id`.** A non-administrator can no
  longer edit an administrator account (AUTH-1) or change their **own** role; a `promote_users` delegate
  cannot assign the `administrator` role, nor any custom role that grants `*` or a capability the caller
  does not already hold (privilege amplification, AUTH-A1); the requested role is validated against the
  roles allow-list.
- **CSRF check fails closed when both `Origin` and `Referer` are absent (AUTH-A2).** A header-less,
  cookie-authenticated state change is now rejected unless it carries a real `Bearer` token
  (server-to-server) — this path previously failed open. The allowed-origin comparison is an exact
  normalized-origin match (never a prefix `startsWith`).
- **Per-account login lockout (AUTH-A3).** Login now throttles by ACCOUNT (in addition to per-IP) after
  repeated failures, backed by the shared rate-limit store with a byte-identical in-memory fallback; a
  Redis error never blocks login.
- **`GET /posts?status=any` BOLA closed.** A non-privileged user can no longer list other users'
  drafts/pending/private posts — unpublished statuses are scoped to the caller's own author id unless
  they hold `edit_others_posts`/`read_private_posts`.
- **Value-based Puck page-tree (`_puck_data`) sanitizer (`core/sanitize-meta.ts`, shared).** Every
  non-HTML string leaf now runs through a URL-scheme filter that blanks `javascript:`/`data:`/
  `vbscript:`/`file:` (incl. control-char obfuscation), so a URL prop outside any key-name allow-list
  (e.g. `buttonLink`) can no longer carry a script URL; `_puck_data` arriving as a JSON STRING is
  parsed → sanitized → re-stringified. The same code is used by `routes/posts.ts` and the WXR importer.
- **Menu item URLs are scheme-validated on create AND update (`routes/menus.ts`, XSS-03).**
  `javascript:`/`data:`/`vbscript:` become `#`, and a protocol-relative `//host` URL is neutralized to
  `#` (open-redirect closed).
- **Frontend sanitizer + CSP hardening.** The server-side sanitizer (`lib/sanitize.ts`) now drops
  `<style>` and any non-allowlisted `<iframe>`, restricts embeds to a YouTube/Vimeo **host** allow-list,
  and forces a `sandbox` attribute on every surviving iframe (FE-XSS-02). The Next.js CSP
  (`next.config.ts`) sets `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, and a
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:`. `blob:` is REQUIRED — the admin loads
  each plugin's frontend bundle via `import(URL.createObjectURL(blob))` (without it: no plugin UIs/icons)
  — and `https:` in `font-src`/`style-src` is needed for theme fonts/CSS inside the Puck `srcdoc` iframe.
- **SQL-injection hardening on `custom_tables` import (`core/import-export.ts`, SQLI-01).** Each table
  and column name is validated against a strict simple-identifier allow-list, and core tables plus
  `sqlite_*` reserved tables are refused before any identifier is interpolated.
- **Comment parent validation (`routes/comments.ts`, VAL-01).** A reply must reference a parent comment
  that exists AND belongs to the same post (thread-spoofing / cross-post linking closed).
- **Mail server hardening.** Inbound SPF/DNSBL checks default ON and fail closed for external senders;
  outbound direct-MX delivery is IP-pinned into nodemailer (anti-rebinding, with the real MX hostname
  kept as `tls.servername`); DKIM/relay secrets are AES-256-GCM at rest (root key
  `plugins/mail-server/data/.mailenc`, `0600`, with a clear operator error on decrypt failure). An
  operator-configured relay/smarthost is EXEMPT from the public-only SSRF pin (internal/LAN smarthost
  works), and `requireTLS` defaults ON but is opt-out via `mail_relay_require_tls` for a TLS-less
  internal relay (REG-2). `/classification/train` is scoped to its owner, attachment filenames are
  Content-Disposition-encoded, and thread access uses an exact-thread match.
- **Deploy/ops hardening.** A one-time **install token** gates the pre-install `/install` and `/test-db`
  endpoints (printed to the console and mirrored to a `0600` file in the data dir; a `WORDJS_INSTALL_TOKEN`
  override must be ≥16 chars; cleared after setup). `scripts/make-release.js` excludes `*.db`/`*.sqlite`,
  `certs/`, `*.pem`/`*.key`, `*.mailenc`, `plugins/<slug>/data/`, and config backups from release ZIPs.
  Prometheus `/metrics` returns `404` unless a scrape token is configured (`config.metrics.token` /
  `METRICS_TOKEN`). Frontend `metadataBase`/canonical URLs now derive from the configured site URL
  instead of the raw `X-Forwarded-Host` header (FE-SSR-01, SEO/OG poisoning).

### Fixed

- **Atomic transactions on every driver (DATA-TX-01).** `transaction(fn)` is atomic across drivers; the
  SQLite drivers serialize transactions through a promise-chain mutex, a re-entrant `transaction()` call
  throws fast instead of deadlocking, and the open-transaction flag is reset on both commit and rollback.
- **UNIQUE indexes for `users` (login / `LOWER(email)`) and `posts` (`post_name`+`post_type`)
  (DATA-USR-01).** A defensive migration logs any pre-existing duplicates and attempts each index in its
  own try/catch, so it NEVER aborts boot; `User.update` maps a unique-email violation to a clean
  "Email already in use" error instead of a raw 500.
- **Notifications IDOR closed while broadcasts stay dismissable (REG-1).** `markAsRead`/`delete` are
  scoped `WHERE uuid = ? AND (user_id = ? OR user_id = 0)`, so a user can only act on their own
  notification while broadcast notifications (`user_id = 0`) remain dismissable by anyone.
- **Roles cache write-coherence.** The roles cache self-heals on a short TTL, and a local-write epoch
  stops a stale TTL refresh from clobbering a just-written change (DATA-05). (Cross-node roles
  coherence, DATA-COH-01, remains DEFERRED.)

## [1.1.0] - 2026-06-20

Focus: a redesigned, WYSIWYG **visual editor** (Puck) that beats a classic block editor on UX
and matches the live site exactly.

### Added

- **In-place rich-text editing** (`InlineTiptap`). Text and heading blocks are edited directly
  on the canvas with a floating toolbar — bold, italic, underline, strikethrough, links, and
  lists — so the editing surface looks identical to the rendered block.
- **Text color picker** with a swatch palette, a visual custom-color picker (no native OS
  dialog), and an **eyedropper** to sample any color from the page/screen.
- **Font controls**: pick from the **fonts installed in WordJS**, set **font size**, and set
  **text alignment** (left / center / right / justify).
- **Accurate responsive preview.** A device switcher (desktop / tablet / mobile) renders the
  canvas in an isolated iframe at the true device width, so Tailwind breakpoints evaluate as on
  the live site. Desktop is full-bleed; tablet/mobile show a scaled device frame.
- **Searchable block inserter** with categories, one-click **section patterns** (intro,
  services, pricing, testimonials, FAQ, CTA), and an empty-canvas onboarding.
- Loading skeleton for the editor routes.

### Changed

- The editor canvas now renders in an **iframe** for true WYSIWYG — the page's own styles,
  fonts, and fixed header / scroll behave exactly as on the live site.
- A thin, subtle scrollbar is used inside the preview instead of the chunky browser default.

## [1.0.0] - 2026-06-18

Initial public release: JavaScript-native CMS with a worker-thread plugin sandbox, real SSR
public site, Puck visual builder, dynamic roles/permissions, WordPress (WXR) importer,
SQLite/PostgreSQL with a migration system, gateway + monolith run modes, ACME TLS, and
downloadable pre-compiled release bundles. See the [README](README.md) for the full feature set.
