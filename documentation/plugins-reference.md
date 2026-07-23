# Plugins Reference 🔌

This document lists the official plugins available in the WordJS ecosystem and their capabilities.

> **Every plugin runs isolated.** All feature plugins below run in a **separate OS process**
> (`child_process.fork` of `plugin-worker.js`) and reach
> core only through the `wordjs` capability bridge — RPC'd to the host over IPC (v8 structured
> clone) and permission-checked **on the host** in the plugin's context. A crash, OOM, or heap
> escape is contained to the child; the host process (secrets, DB handle, other plugins)
> survives and is unreachable from the child. See **[Plugin Isolation](plugin-isolation-proposal.md)**
> and the **[wordjs Bridge API Reference](#0-the-wordjs-bridge-api-reference)** below.
> **There is one plugin model and no trust tier.** Every plugin is sandboxed; capabilities are
> **admin-granted per plugin, Android-style** (the manifest *requests*, an admin *grants* each one in
> `/admin/plugins`, default-deny — persisted in the `plugin_grants` option). A bridge call works only if
> the capability is BOTH declared AND granted. Every plugin is confined to its own `wjp_<slug>_` DB
> tables, non-secret options, and namespaced routes; outbound network requires the granted `network`
> capability. A `network`-granted plugin is confined to **public IPs only** — the egress guard validates
> each outbound connection **at connect time** (anti DNS-rebinding) and blocks loopback, link-local
> (incl. `169.254.169.254` cloud metadata), RFC1918, CGNAT (`100.64/10`), IPv6 ULA/loopback/mapped, and
> unresolvable hosts (fail-closed). Bundled (first-party) plugins are **not privileged** — no plugin
> bypasses the sandbox. Nothing is granted out of the box: **activation** grants a plugin exactly the
> capabilities its manifest *declares* (the admin approves them in the activation dialog, only if the
> plugin has no prior grant record), and the admin can refine or revoke every grant afterward in
> `/admin/plugins`. (A one-time boot backfill only grandfathers plugins that were *already active* before
> the default-deny model landed; fresh activations get their declared set and nothing more.) (The old
> trusted tier and its bypass machinery were removed.) **Every plugin — bundled ones included — is AST-scanned on activation,
> fail-closed:** a file that is loaded but parses as dangerous (or cannot be parsed) blocks activation,
> and there is no scan-skip for any plugin. The runtime `eval`/`Function` block is opt-in via
> `config.sandbox.blockCodeGen` (skipped under `ts-node`).

## 0. The `wordjs` Bridge — API Reference 🌉

A plugin running in its isolate touches core **only** through the `wordjs` object injected into its
module. Every member either RPCs a request to the host over IPC (kind `'call'`) or sends a dedicated
**registration** IPC kind; both are permission-checked **on the host**. There is no other path out of
the child.

Two enforcement gates live on the host (`backend/src/core/plugin-isolate.ts`):

*   **`ALLOWED_BRIDGE_METHODS`** — the EXACT allowlist of methods reachable via a `kind:'call'` message
    (`callApi` rejects anything not in the set, default-deny). A malicious child can send any method
    string, so this is the gate that keeps it from walking the host `api` object to arbitrary methods.
*   **Dedicated registration kinds** — hook/route/shortcode/mail-provider/notify-transport registration
    flow through their OWN IPC kinds (NOT through `call`), each with its own capability check. They
    are deliberately absent from `ALLOWED_BRIDGE_METHODS`.

### Data / call methods (`kind:'call'`, gated by `ALLOWED_BRIDGE_METHODS`)

| `wordjs` member | Bridge method | Notes |
| --- | --- | --- |
| `options.get(key, default)` | `options.get` | Secret-named/protected options are scrubbed for **every** plugin. |
| `options.set(key, value)` | `options.set` | Protected/secret-named options are write-blocked for **every** plugin. |
| `db.all(sql, params)` | `db.all` | Always confined to `wjp_<slug>_` tables; ATTACH/PRAGMA/schema-catalog/stacked/comma-join/USING/RETURNING rejected. |
| `db.get(sql, params)` | `db.get` | Same scoping as `db.all`. |
| `db.run(sql, params)` | `db.run` | Same scoping. |
| `db.createTable(name, cols)` | `db.createTable` | Creates a `wjp_<slug>_`-prefixed table. |
| `db.getType()` | `db.getType` | Returns `{ isPostgres, isMySQL, isSQLite, driver }` for dialect branches (`driver` ∈ `sqlite-native`/`sqlite-legacy`/`postgres`/`mysql`/`mariadb`; `isSQLite` stays true under MySQL, so gate `PRAGMA`/`sqlite_master` on `isMySQL` — MariaDB reports `driver: 'mariadb'` but `isMySQL` is true, so branch on `isMySQL` not the raw `driver` string). |
| `users.findByEmail / findByLogin / findById / search` | `users.*` | `users:read` grant. Returns a **safe projection** `{id, userLogin, username, userEmail, displayName, role}` — never `user_pass`. |
| `site.url / domain / adminEmail` | `site.*` | `settings:read` grant. Read-only site identity. |
| `db.tablePrefix` | (local) | A string property (`wjp_<slug>_`), not an RPC — the required prefix for the plugin's own tables. |
| `hooks.doAction(hook, ...args)` | `hooks.doAction` | Fire a core action from the plugin. |
| `fs.read(path, enc)` | `fs.read` | Confined to the plugin dir; `.env`/secret files and the DB files are blocked. |
| `fs.write(path, data)` | `fs.write` | Same confinement, plus per-write size cap + per-plugin disk quota. |
| `mail(msg)` | `mail` | Send through the host-wide mail sender. |
| `notify(notification)` | `notify` | Dispatch a core notification. |
| `adminMenu.add(item)` | `adminMenu.add` | Add a Sidebar item (capped per plugin). |
| `cron.schedule(ts, recurring, hook, args)` | `cron.schedule` | Schedule a recurring/one-shot hook fire. |
| `crypto.randomToken(bytes=16)` / `crypto.randomInt(min, max)` | `crypto.randomToken` / `crypto.randomInt` | CSPRNG helpers (no data access, no permission gate) — use instead of `Math.random` for tokens/access codes. **Async** in an isolated plugin (RPC to host), so `await` them. |
| `assets.enqueueScript(spec)` / `assets.enqueueStyle(spec)` | `assets.enqueueScript` / `assets.enqueueStyle` | `assets:write` grant. Enqueue a `<script>`/`<style>` from **inside your own plugin dir** onto public pages; the host emits a **sanitized** tag served from `/plugins/<slug>/`. |
| `slug` | (local) | The plugin's slug string. |

### Registration methods (dedicated IPC kinds — NOT in the call allowlist)

| `wordjs` member | IPC kind | Capability (manifest-declared AND admin-granted) |
| --- | --- | --- |
| `hooks.addAction(hook, cb, priority)` / `hooks.addFilter(...)` | `register` | Raw-HTML hooks (`wordjs_head`/`wordjs_footer`/`wp_head`/`wp_footer`) denied to **every** plugin; capped per-plugin (`MAX_HOOKS`) and per-hook-name (`MAX_PER_HOOK`); each shim runs with a 2 s timeout. |
| `http.route(method, routePath, opts, handler)` | `register-route` | HTTP verb allowlisted; `opts.auth`/`opts.admin` apply real middleware; `opts.multipart` parsed host-side (10 MB cap). Always namespaced under `/api/v1/plugin/<slug>`, auth/session cookies stripped, Set-Cookie/CSP/HSTS/Location dropped, plugin cookies namespaced + path-confined. (No absolute-path mode.) |
| `shortcodes.add(tag, handler)` | `register-shortcode` | Capped per-plugin; handler resolves HTML over RPC (`doShortcodeAsync`). |
| `provideMail(handler)` | `register-mail-provider` | `email:provider` grant — becomes the host-wide mail sender (sandboxed). |
| `notify.registerTransport(name, handler)` | `register-notify-transport` | `notifications:provider` grant — registers a core notification transport (sandboxed). |

All registrations are tracked and torn down on unload/reload. RPCs have a timeout and a wedged child is
recycled; per-child bridge-call and global IPC message rates are token-bucket capped, with inbound/outbound
payload caps.

## 1. Photo Carousel 📸
**ID:** `photo-carousel` | **Version:** 2.0.0

Manages image carousels for Hero sections or content sliders.

*   **Shortcode:** `[carousel id="123"]` (async — expanded via `doShortcodeAsync`)
*   **Puck Component:** `PhotoCarouselPuck` (registry key `PhotoCarousel`; renders the `HeroCarousel` location component internally)
*   **Permissions:** `settings` (read/write), `database` (write).
*   **Sandbox:** isolated (like every plugin). Routes namespaced under `/api/v1/plugin/photo-carousel/*`. Default-deny: an admin grants its declared `settings`/`database` capabilities in `/admin/plugins`.

---

## 2. Card Gallery 🃏
**ID:** `card-gallery` | **Version:** 1.0.0

Displays event or promo cards in a zigzag or grid layout.

*   **Rendering:** via the `PromoCards` / `CardGalleryPuck` frontend component (no shortcode is registered at runtime — `index.js` calls no `shortcodes.add`).
*   **Puck Component:** `CardGalleryPuck` (PromoCards)
*   **Permissions:** `settings` (read/write), `database` (write).
*   **Sandbox:** isolated (like every plugin). Routes namespaced under `/api/v1/plugin/card-gallery/*`. Default-deny: an admin grants its declared `settings`/`database` capabilities in `/admin/plugins`.

---

## 3. Video Gallery 🎬
**ID:** `video-gallery` | **Version:** 1.0.0

Manages YouTube video carousels.

*   **Shortcode:** `[vgallery]`
*   **Permissions:** `settings` (read/write), `database` (write).
*   **Sandbox:** isolated (like every plugin). Routes namespaced under `/api/v1/plugin/video-gallery/*`. Default-deny: an admin grants its declared `settings`/`database` capabilities in `/admin/plugins`.

---

## 4. Mail Server 📧
**ID:** `mail-server` | **Version:** 2.0.0

A complete SMTP server and email manager. Allows sending and receiving emails directly within WordJS.

*   **Features:**
    *   Inbound SMTP server (listens on port 25 by default — operator-configurable via the `smtp_listen_port` option — automatically falling back to the unprivileged port 2525 when 25 cannot be bound) + direct-MX outbound delivery (connects to remote MTAs on port 25) — runs inside the child process
    *   Attachment handling (multipart upload parsed by the host, forwarded to the isolate)
    *   DKIM signing (private key stored in the plugin's own DB/files, not a core secret option)
    *   Registers the host-wide mail sender (`provideMail`) and a notification transport
*   **Requested capabilities:** `settings` (read/write — non-secret SMTP/display options + the safe `site` bridge), `database` (read/write — its own `wjp_mail_server_*` tables), `email` (admin + provider), `notifications` (send/provider), `filesystem` (read/write), `users` (read — resolves local recipients via the safe users projection, never password hashes), `network` (for SMTP / outbound MX).
*   **Egress:** because it holds the `network` grant, its outbound connections are validated at connect
    time against the egress guard — direct-MX delivery is **IP-pinned** into nodemailer and only public
    IPs are reachable (loopback/RFC1918/link-local/metadata blocked). An **operator-configured
    relay/smarthost is exempt** from the public-only pin, so an internal/LAN smarthost works; `requireTLS`
    defaults ON but is opt-out via the `mail_relay_require_tls` option for a TLS-less internal relay.
*   **Sandbox:** isolated, like every plugin — no trust bypass. It runs under the same **default-deny**
    grant checks and OS-process isolation as anything uploaded: **activating** it grants exactly the
    capabilities it declares (`network` for raw sockets, `email:provider`, `notifications:provider`,
    `filesystem`, etc.), which the admin sees in the activation dialog and can refine or revoke in
    `/admin/plugins`. It is not privileged and can be fully de-fanged by revoking those grants.

---

## 5. Conference Manager 🎟️
**ID:** `conference-manager` | **Version:** 2.1.0

Complex business logic for managing church conferences.

*   **Features:**
    *   Inscription/Registration management (admin CRUD + custom form fields + public self-registration endpoints)
    *   Hotel & Room assignment, including a rule-based auto-assignment engine (`/assignment/rules`, `/assignment/run`, `/assignment/reset`)
    *   Payment tracking (per-inscription payments + bulk recording via the attendee portal)
    *   Attendee portal (`/portal/login`, `/portal/me`, `/portal/inscriptions`, `/portal/payments/bulk`) surfaced at `/portal/conference` on the frontend
    *   Reports (`/reports/summary`) and CSV export of inscriptions (`/inscriptions/export`)
*   **Requested capabilities:** `database` (read/write — its own `wjp_conference_manager_` tables), `express` (register_route — namespaced routes), `admin_menu` (register — sidebar item).
*   **Sandbox:** isolated, like every plugin — no trust bypass. Default-deny: activation grants its declared
    capabilities (admin-approved in the activation dialog, refinable/revocable in `/admin/plugins`). It
    stores its data in its own prefixed tables (no unscoped/core-table access — that capability no longer
    exists), building table names from `db.tablePrefix` and creating them idempotently via `db.createTable`
    (`CREATE TABLE IF NOT EXISTS`). Routes are namespaced under
    `/api/v1/plugin/conference-manager/*` (absolute routes were removed). The AST scanner runs on it like
    every plugin; there is no scan-skip.

---

## 6. Database Migration 🚚 — now in core (no longer a plugin)
**Location:** `backend/src/core/db-admin/` | Admin UI: `/admin/db-migration` (permanent core Sidebar item)

Database administration (migrate data between SQLite and PostgreSQL, run schema migrations at boot) is
**no longer a plugin**. It was de-pluginized because it is database infrastructure, not a feature
plugin: it runs around the DB lifecycle at boot and cannot run in an isolated worker. It moved into core (`backend/src/core/db-admin/`, routes still
`/api/v1/db-migration/*`) and its admin UI is a native frontend route reached from a permanent **core**
Sidebar item — not a toggleable plugin. It is gone from `plugins/` and all generated registries. (It
runs as core, never in the plugin sandbox.) See **[Database](database.md)**.

---

## 7. Hello World 👋
**ID:** `hello-world` | **Version:** 1.0.0

A reference implementation for developers. Hooks-only (registers an `the_content` filter via the
bridge) and demonstrates the plugin test framework.

*   **Purpose:** Development / Education.
*   **Sandbox:** isolated (like every plugin).

---

## 8. Test Schema 🧪
**ID:** `test-schema` | **Version:** 1.0.0

Reference plugin for hooks + DB access through the bridge (`wordjs.db.createTable` / `db.run`).

*   **Purpose:** Development / Education.
*   **Sandbox:** isolated (like every plugin).

---

## 9. YouTube Videos 🎥
**ID:** `youtube-videos` | **Version:** 1.0.0

Pulls the videos of a YouTube channel (links, thumbnails, titles) and ships a Puck carousel block
with title filtering and a video-count limit. Works **keyless** out of the box via the channel RSS
feed (latest 15 videos); add a YouTube Data API v3 key for the full upload history.

*   **Distribution:** first-party **marketplace** plugin (installed via the Marketplace catalog in §10) — not bundled with core.
*   **Routes:** `GET /`, `GET /status`, `POST /refresh`, `POST /settings` (namespaced under `/api/v1/plugin/youtube-videos/*`)
*   **Puck Component:** `YoutubeVideosPuck` (carousel with title filter + count limit)
*   **Admin page:** `/admin/plugin/youtube`
*   **Requested capabilities:** `settings` (read/write — configured channel + cached video list), `database` (read/write — the Data API key lives in the plugin's own `wjp_youtube_videos_*` table, **not** in options, because options are readable by other plugins), `network` (fetch youtube.com RSS / googleapis.com Data API — public egress only, like every `network` grant).
*   **Sandbox:** isolated (like every plugin). Default-deny: activation grants its declared capabilities, refinable in `/admin/plugins`.

---

## 10. Plugin Marketplace 🛒

Beyond the plugins above, WordJS ships a **Marketplace** of first-party plugins distributed
**outside** the core build (the Mail Server, Conference Manager, and YouTube Videos sections above are
themselves marketplace plugins — only Photo Carousel, Card Gallery, Video Gallery, Hello World, and
Test Schema are bundled with core):

*   **Sources:** `marketplace/plugins/<slug>/` in the repo (28 plugins, listed below).
*   **Catalog build:** `npm run build:marketplace` (`backend/scripts/build-marketplace.js`) packs each
    plugin into `marketplace/dist/<slug>-<version>.zip` and emits `marketplace/dist/marketplace-index.json`
    (id, version, description, category, file, **sha256**). `marketplace/dist/` is a **build output and is
    NOT committed** (`.gitignore`); the catalog + zips are published as **GitHub release assets** by
    `.github/workflows/release.yml` (build:marketplace runs there), so `releases/latest/download/` always
    resolves to the newest published catalog — decoupled from any local checkout. Pin a fixed catalog by
    pointing a source at a specific release tag.
*   **Backend API:** `backend/src/routes/marketplace.ts` — `GET /api/v1/marketplace/catalog` (annotated
    with installed/active/updateAvailable state), `POST /api/v1/marketplace/install` (admin-only), and
    `GET`/`PUT /api/v1/marketplace/sources` to read/replace the configured source list.
    The catalog **sources are admin-configurable** and stored as a **list** in the `marketplace_sources`
    option (managed from the Marketplace UI; the legacy singular `marketplace_source` is still honored for
    back-compat). Every configured source is fetched and **merged** (dedup by id, earlier sources win) with
    **per-source error isolation** — one bad URL is reported but never hides the rest. Precedence:
    configured list → legacy `marketplace_source` → repo-local `marketplace/dist` (dev / full checkout) →
    the built-in default `https://github.com/jaimemartinez/wordjs/releases/latest/download`. UI-set sources
    must be `https://` (or `http://localhost` in dev); a local dir works only via the option/dev fallback.
*   **Install path:** the zip is downloaded to a temp file, **sha256-verified against the catalog
    entry**, then handed to `installPluginFromZip()` — the **same pipeline as manual uploads**
    (zip-bomb budget, Zip Slip, slug validation, manifest + AST scan). The marketplace adds no new
    install surface beyond the catalog fetch; only `https://` sources are accepted (plus
    `http://localhost` in dev), and catalog filenames are strictly shape-validated. The catalog id is
    passed as `expectedSlug`, so a package whose root folder is a different plugin is refused before
    anything is extracted.
*   **Update path (one click, data-safe):** `POST /api/v1/marketplace/update` — and
    `POST /api/v1/marketplace/install` when the plugin is already installed — runs
    `updatePluginFromZip()` (`routes/plugins.ts`) instead of failing with the
    "already exists / currently active" 409. It remembers the active state, the **permission grants**
    and the **egress allowlist**, deactivates (**without pruning npm dependencies** — the plugin is
    coming right back), stashes the old code aside **keeping `plugins/<slug>/data/`**, runs
    `uninstallPluginData(slug, { dropTables: false })` so the plugin's `wjp_<slug>_*` tables **survive**,
    installs the new version (which adopts the preserved `data/`), restores the grants, and reactivates.
    Any failure — bad package, failed validation, or a new version that installs but cannot activate —
    **rolls back** to the previous version, restores the grants and reactivates it (stopping **and
    unloading** the failed version first, so a package that dies after its sandbox child is already live
    cannot leave an orphaned process holding hooks/routes/providers); the response carries
    `rolledBack: true` with the real error. **Nothing is ever auto-granted**, and the response separates
    the two facts an admin needs: `newPermissions` are the tokens this version declares that the
    **previous manifest did not** (diffed against the old manifest, snapshotted before its code is
    stashed — so a permission the admin deliberately *refused* is not reported as "new" on every
    update), while `ungrantedPermissions` is everything the new version declares and still cannot use
    (the newly declared ones **plus** anything previously refused) — the "approve these" list.
*   **Provenance gate — an update is bound to its SOURCE, not to its slug.** The catalog is merged
    across every configured source, so two sources can both list `mail-server`; since an update replays
    the admin's grants (**`network` + the egress allowlist included** — the host reads those from the
    grant map alone, *not* re-gated by the new manifest) onto the replacement code and hands it the
    preserved `data/` dir, "same id" must never imply "same plugin". Every catalog install records its
    **origin** (source URL + catalog id) in the server-side `plugin_origins` option — bridge-protected
    exactly like `plugin_grants`, and stored in the DB rather than in `plugins/<slug>/` so a package
    cannot ship its own provenance — and `updatePluginFromZip()` refuses (`409`, `originMismatch: true`)
    unless the recorded origin matches. **No recorded origin = refused**: that is the case for manually
    uploaded plugins (deliberately: nothing to bind to) and for anything installed before 1.12.6. Adopt
    an origin by uninstalling (data + tables are kept) and installing from the catalog — which resets
    the grants to **default-deny**. Uninstall clears the recorded origin, like it clears the grants.
*   **Mutual exclusion + crash recovery:** the whole install/update/uninstall cycle is serialized per
    slug (in-process guard + a `wordjs:plugin-op:<slug>` dist-lock lease for multi-node); a second
    request gets `409 busy`. This closes the window in which an update has stashed the old code aside
    and `plugins/<slug>/` holds only `data/` — the exact shape the installer adopts as "residual data",
    so a concurrent install would extract into the same dir and a rollback would delete the other's
    files. The stash lives in `os-tmp/plugin-update-<slug>-<hex>/` (excluded from backups), and boot
    (`recoverInterruptedPluginUpdates()`, called from `index.ts` before `loadActivePlugins()`) restores
    it when the plugin dir has no manifest, or discards it when it has one.
*   **Admin UI:** the **Marketplace** tab in `/admin/plugins`
    (`frontend/src/app/admin/plugins/MarketplaceTab.tsx`) — browse, one-click install, update detection.
*   **Sandbox:** marketplace plugins are ordinary plugins — `"isolated": true`, bridge-only,
    default-deny grants, AST-scanned. Nothing about the marketplace bypasses the sandbox.

### Catalog (28 plugins)

| Slug | What it does | Key requested capabilities |
| --- | --- | --- |
| `analytics-tag` | Site-wide analytics tag (GA4, Plausible or Matomo) with optional cookie-consent gating | `settings` r/w, routes, admin menu, `assets:write` |
| `auctions` | Auction listings with bidding, anti-snipe extension, live polling, winner reporting | `database` r/w, routes, admin menu, `email:admin` |
| `bookings` | Appointment booking: services, weekly availability, race-safe slot reservations, email confirmations, admin agenda | `database` r/w, `settings` r/w, routes, admin menu, `email:admin` |
| `breadcrumbs` | Breadcrumbs Puck block with optional BreadcrumbList JSON-LD | — (frontend-only) |
| `conference-manager` | Conference inscriptions/registration, hotel & room auto-assignment, per-inscription payments, attendee portal, reports + CSV export | `database` r/w, routes, admin menu |
| `contact-forms` | Form builder with Puck embed block, submissions inbox, CSV export, email notification | `database` r/w, routes, admin menu, `email:admin` |
| `cookie-consent` | GDPR cookie banner, anonymous consent logging, version-based re-consent | `database` r/w, `settings` r/w, routes, admin menu, `assets:write` |
| `digital-downloads` | Sell/give away downloadable products with expiring token-gated download links | `database` r/w, `settings` r/w, routes, admin menu, `email:admin` |
| `donations` | Donation campaigns with goal thermometer, manual payment + optional Stripe Checkout, CSV export | `database` r/w, `settings` r/w, routes, admin menu, `email:admin`, `network` |
| `event-tickets` | Ticket types with quantity caps, unique ticket codes, attendee check-in | `database` r/w, `settings` r/w, routes, admin menu, `email:admin` |
| `events-calendar` | Admin-managed events shown as an upcoming list or monthly calendar Puck block | `database` r/w, routes, admin menu |
| `faq` | Database-managed FAQ accordion with categories + Google FAQPage JSON-LD | `database` r/w, routes, admin menu |
| `image-lightbox` | Site-wide click-to-zoom lightbox for content images (captions, keyboard nav) | `settings` r/w, routes, admin menu, `assets:write` |
| `invoices` | Invoices with statuses, dashboard totals, CSV export, public token URL + print view, email to client | `database` r/w, `settings` r/w, routes, admin menu, `email:admin` |
| `job-board` | Job listings with anti-spam public application form, applications inbox, filterable Puck block | `database` r/w, `settings` r/w, routes, admin menu, `email:admin` |
| `mail-server` | Full SMTP server: inbound listener + direct-MX outbound delivery, DKIM signing, host-wide mail sender + email notification transport | `settings` r/w, `database` r/w, `email:admin`+provider, `notifications`, `filesystem` r/w, `users` read, `network` |
| `newsletter` | Subscriptions (double opt-in when mail is configured), subscriber CSV, HTML campaigns with unsubscribe links | `database` r/w, routes, admin menu, `email:admin` |
| `notification-bar` | Slim site-wide announcement bar with CTA, dismissal versioning, schedule window | `settings` r/w, routes, admin menu, `assets:write` |
| `online-store` | Product catalog + cart + checkout with server-side price validation, coupons, orders admin, optional Stripe | `database` r/w, `settings` r/w, routes, admin menu, `email:admin`, `network` |
| `polls` | WP-Polls-style polls with a voting + animated-results Puck block | `database` r/w, routes, admin menu |
| `popup-builder` | Site-wide popups with triggers (delay/scroll/exit intent), frequency capping, view/click stats | `database` r/w, routes, admin menu, `assets:write` |
| `related-posts` | Automatic per-post related articles via the core public REST API (YARPP parity) | — (frontend-only) |
| `restaurant-menu` | Menu sections/dishes with photos and diet tags; optional cart with WhatsApp order hand-off | `database` r/w, `settings` r/w, routes, admin menu, `email:admin` |
| `social-share` | Share buttons Puck block (Facebook, X, WhatsApp, LinkedIn, Telegram, Email, copy link) — fully client-side | — (frontend-only) |
| `table-of-contents` | Automatic nested TOC from page H2/H3 with anchors, smooth scroll, active highlighting | — (frontend-only) |
| `testimonials` | Database-backed testimonials with moderation and optional public submission form; carousel/grid Puck block | `database` r/w, `settings` r/w, routes, admin menu |
| `vendor-marketplace` | Multi-vendor directory: vendor applications, admin approval, self-service listings, per-product inquiries | `database` r/w, routes, admin menu, `email:admin` |
| `youtube-videos` | Pulls a YouTube channel's videos (keyless RSS or Data API v3) into a filterable, count-limited Puck carousel block | `settings` r/w, `database` r/w, `network` |

*(“routes” = `express:register_route`; “admin menu” = `admin_menu:register`. Every capability is
manifest-requested and admin-granted, default-deny, exactly like the bundled plugins.)*
