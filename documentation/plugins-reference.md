# Plugins Reference 🔌

This document lists the official plugins available in the WordJS ecosystem and their capabilities.

> **Every plugin runs isolated.** All feature plugins below run in a **separate OS process**
> (`child_process.fork` of `plugin-worker.js`) and reach
> core only through the `wordjs` capability bridge — RPC'd to the host over IPC (v8 structured
> clone) and permission-checked **on the host** in the plugin's context. A crash, OOM, or heap
> escape is contained to the child; the host process (secrets, DB handle, other plugins)
> survives and is unreachable from the child. See **[Plugin Isolation](plugin-isolation-proposal.md)**
> and the **[wordjs Bridge API Reference](#0-the-wordjs-bridge--api-reference-)** below.
> **There is one plugin model and no trust tier.** Every plugin is sandboxed; capabilities are
> **admin-granted per plugin, Android-style** (the manifest *requests*, an admin *grants* each one in
> `/admin/plugins`, default-deny — persisted in the `plugin_grants` option). A bridge call works only if
> the capability is BOTH declared AND granted. Every plugin is confined to its own `wjp_<slug>_` DB
> tables, non-secret options, and namespaced routes; outbound network requires the granted `network`
> capability. A `network`-granted plugin is confined to **public IPs only** — the egress guard validates
> each outbound connection **at connect time** (anti DNS-rebinding) and blocks loopback, link-local
> (incl. `169.254.169.254` cloud metadata), RFC1918, CGNAT (`100.64/10`), IPv6 ULA/loopback/mapped, and
> unresolvable hosts (fail-closed). An admin can narrow that further with a **per-plugin egress host
> allowlist** (`GET`/`POST /api/v1/plugins/:slug/egress-hosts`, stored server-side in the
> `plugin_egress_hosts` option): empty/absent = allow-all-public, a non-empty list flips that plugin to
> default-deny (only the listed hosts + their subdomains). Bundled (first-party) plugins are **not privileged** — no plugin
> bypasses the sandbox. Nothing is granted out of the box: **activation** grants a plugin exactly the
> capabilities its manifest *declares* (the admin approves them in the activation dialog, only if the
> plugin has no prior grant record), and the admin can refine or revoke every grant afterward in
> `/admin/plugins`. (A one-time boot backfill only grandfathers plugins that were *already active* before
> the default-deny model landed; fresh activations get their declared set and nothing more.) (The old
> trusted tier and its bypass machinery were removed.) **Every plugin — bundled ones included — is AST-scanned on activation,
> fail-closed:** a file that is loaded but parses as dangerous (or cannot be parsed) blocks activation,
> and there is no scan-skip for any plugin. The scan also walks the plugin's **shipped dependency tree** (`node_modules`), bounded to 4,000 files, 1 MB per file and 32 levels deep, with any symlink resolving outside the plugin directory refused and counted — a tree that cannot be read in full is itself reported as a finding, not a pass. The runtime `eval`/`Function` block is **default-on** (opt
> OUT with `config.sandbox.blockCodeGen: false`; skipped under `ts-node`).

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
    flow through their OWN IPC kinds (NOT through `call`), each with its own host-side gate: an explicit,
    admin-granted capability check for routes (`express:register_route`), the mail provider
    (`email:provider`) and the notification transport (`notifications:provider`), plus caps/denylists and
    path-/verb-allowlists for hooks, routes and shortcodes (hooks and shortcodes have no capability of
    their own — they are policed by caps and denylists only). They are deliberately absent from
    `ALLOWED_BRIDGE_METHODS`.

### Data / call methods (`kind:'call'`, gated by `ALLOWED_BRIDGE_METHODS`)

| `wordjs` member | Bridge method | Notes |
| --- | --- | --- |
| `options.get(key, default)` | `options.get` | `settings:read` grant. Secret-named/protected options are scrubbed for **every** plugin. |
| `options.set(key, value)` | `options.set` | `settings:write` grant. Protected/secret-named options are write-blocked for **every** plugin. |
| `db.all(sql, params)` | `db.all` | `database:read` grant. Always confined to `wjp_<slug>_` tables — EVERY table token the statement references is prefix-checked (comma-joins, `USING`, subqueries and CTEs included, at any depth). ATTACH/DETACH/PRAGMA/VACUUM, schema catalogs, the file/extension SQL functions, the Postgres `*_to_xml` family, stacked statements and `RETURNING` are rejected outright. A data-modifying CTE (a `WITH` containing insert/update/delete/replace/merge) is treated as a write and demands `database:write`. |
| `db.get(sql, params)` | `db.get` | Same scoping as `db.all`. |
| `db.run(sql, params)` | `db.run` | `database:write` grant. Same scoping. DDL is limited by a positive OBJECT-CLASS allowlist — a plugin may only create/alter/drop its own `TABLE`, `INDEX`, `VIEW` or `TRIGGER` (SCHEMA/DATABASE/ROLE/FUNCTION/EXTENSION/… are denied), and an `ALTER … RENAME TO` destination must itself carry the `wjp_<slug>_` prefix. |
| `db.batch(statements)` | `db.batch` | Run up to 200 `[sql, params]` pairs in ONE host round-trip. Purely a transport optimisation: every statement is re-validated with the SAME permission check + SQL guard its single-statement counterpart would use, and DDL (`CREATE`/`ALTER`/`DROP`) is refused — use `db.run`/`db.createTable` so ownership and grants are recorded. The whole batch is validated before any of it runs, but it is **NOT** a transaction: a failure mid-batch leaves the earlier statements applied. |
| `db.createTable(name, cols)` | `db.createTable` | `database:write` grant. Creates a `wjp_<slug>_`-prefixed table and records this plugin as its authoritative creator. |
| `db.getType()` | `db.getType` | `database:read` grant. Returns `{ isPostgres, isMySQL, isSQLite, driver }` for dialect branches (`driver` ∈ `sqlite-native`/`sqlite-legacy`/`postgres`/`mysql`/`mariadb`; `isSQLite` stays true under MySQL, so gate `PRAGMA`/`sqlite_master` on `isMySQL` — MariaDB reports `driver: 'mariadb'` but `isMySQL` is true, so branch on `isMySQL` not the raw `driver` string). |
| `users.findByEmail / findByLogin / findById / search` | `users.*` | `users:read` grant. Returns a **safe projection** `{id, userLogin, username, userEmail, displayName, role, hasProfessionalMailbox}` — never `user_pass`. (`hasProfessionalMailbox` is the admin-owned corporate-mailbox grant, projected as a boolean; read it, never re-derive it from `userEmail`.) |
| `site.url / domain / adminEmail` | `site.*` | `settings:read` grant. Read-only site identity. |
| `dns.resolveMx / resolveTxt / resolve4 / resolve6 / resolve` | `dns.*` | **`network` grant.** Host-mediated record lookups — the raw c-ares surface (`dns.resolve*`) is denied inside the isolate, so an MTA reaches MX (direct delivery) and TXT (SPF/DKIM/DMARC) through here. The host runs the query and STRIPS every A/AAAA answer pointing at a private/internal/special address, so `resolve4`/`resolve6`/`resolve` return public addresses only (a domain resolving solely to internal IPs comes back empty). |
| `db.tablePrefix` | (local) | A string property (`wjp_<slug>_`), not an RPC — the required prefix for the plugin's own tables. |
| `hooks.doAction(hook, ...args)` | `hooks.doAction` | Fire an action — but only the plugin's OWN registered callbacks run (`doActionForPlugin`), never core or another plugin's handlers. |
| `fs.read(path, enc)` | `fs.read` | `filesystem:read` grant. Confined to the plugin's OWN dir (never the shared `uploads/`); `.env`/secret files and the DB files are blocked. |
| `fs.write(path, data)` | `fs.write` | `filesystem:write` grant. Same confinement, plus a 16 MB per-write cap and a 100 MB per-plugin disk quota; `manifest.json` is immutable. |
| `mail(msg)` | `mail` | `email:admin` grant. Send through the host-wide mail sender. |
| `notify(notification)` | `notify` | `notifications:send` grant. Dispatch a core notification. |
| `adminMenu.add(item)` | `adminMenu.add` | `admin_menu:register` grant (an explicit, admin-granted verb — `scope: "admin"` does not imply it). Adds a sidebar item; capped at 50 items per plugin, and `href` must be a same-origin relative admin path (single leading `/`, no scheme, no `//`) or the item is dropped with a warning. |
| `cron.schedule(ts, recurring, hook, args)` | `cron.schedule` | Schedule a recurring/one-shot hook fire. |
| `crypto.randomToken(bytes=16)` / `crypto.randomInt(min, max)` | `crypto.randomToken` / `crypto.randomInt` | CSPRNG helpers (no data access, no permission gate) — use instead of `Math.random` for tokens/access codes. **Async** in an isolated plugin (RPC to host), so `await` them. |
| `assets.enqueueScript(spec)` / `assets.enqueueStyle(spec)` | `assets.enqueueScript` / `assets.enqueueStyle` | `assets:write` grant. Enqueue a `<script>`/`<style>` onto public pages; the host emits a **sanitized** tag. `src` must resolve **inside your plugin's `public/` directory** with a servable extension — that directory is the only part of the plugin tree published at `/plugins/<slug>/`, and it is **read-only to the plugin** (`documentation/plugins.md` §11a). Any other `src` throws. |
| `slug` | (local) | The plugin's slug string. |

### Registration methods (dedicated IPC kinds — NOT in the call allowlist)

| `wordjs` member | IPC kind | Host-side gate (a capability here means manifest-declared AND admin-granted) |
| --- | --- | --- |
| `hooks.addAction(hook, cb, priority)` / `hooks.addFilter(...)` | `register` | Raw-HTML hooks (`wordjs_head`/`wordjs_footer`/`wp_head`/`wp_footer`) denied to **every** plugin; capped per-plugin (`MAX_HOOKS`) and per-hook-name (`MAX_PER_HOOK`); each shim runs with a 2 s timeout. |
| `http.route(method, routePath, opts, handler)` | `register-route` | **`express:register_route` grant** — checked first (default-deny; not implied by `admin`); without it the registration is logged and dropped (no route is mounted). Then: per-plugin route cap (`MAX_ROUTES`); HTTP verb allowlisted (`get/post/put/patch/delete/options/head/all`); `routePath` restricted to static segments, `:params` and at most two `*` wildcards (≤ 200 chars, no regex metacharacters, `::` or `..`); `opts.auth`/`opts.admin` apply the real `authenticate`/`isAdmin` middleware; `opts.multipart` parsed host-side by multer (single file, `fileSize` capped at `config.uploads.maxFileSize` — the site's configured `maxFileSize`, 10 MB by default; the temp file is unlinked when the response finishes). Always namespaced under `/api/v1/plugin/<slug>`, auth/session cookies stripped, Set-Cookie/CSP/HSTS/Location dropped, plugin cookies namespaced + path-confined. (No absolute-path mode.) A plugin route sits behind the global CSRF gate like every other API route: a cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` must carry an `X-CSRF-Token` header equal to the caller's `wjs_csrf` cookie or it is refused with `403 rest_csrf_token`; `Bearer` callers are exempt. |
| `shortcodes.add(tag, handler)` | `register-shortcode` | Capped per-plugin; handler resolves HTML over RPC (`doShortcodeAsync`). |
| `provideMail(handler)` | `register-mail-provider` | `email:provider` grant — becomes the host-wide mail sender (sandboxed). |
| `notify.registerTransport(name, handler)` | `register-notify-transport` | `notifications:provider` grant — registers a core notification transport (sandboxed). |

All registrations are tracked and torn down on unload/reload (routes are unmounted by matching the HANDLER
the host installed, never the registration verb — `app.all()` expands to every method, so a verb match
missed them). RPCs have a 30 s timeout and a wedged child is recycled; an RPC to a child that is already
gone **fails fast** ("… is not running") instead of waiting the timeout out. Per-child bridge-call and
global IPC message rates are token-bucket capped, with inbound/outbound payload caps.

## 1. Photo Carousel 📸
**ID:** `photo-carousel` | **Version:** 2.0.0

Manages image carousels for Hero sections or content sliders.

*   **Shortcode:** `[carousel id="123"]` (async — expanded via `doShortcodeAsync`)
*   **Verso block:** `client/verso/PhotoCarouselVerso.tsx` (registry key `PhotoCarousel`; renders the `HeroCarousel` location component internally)
*   **Permissions:** `settings` (read/write), `database` (write), `express` (register_route), `admin_menu` (register).
*   **Sandbox:** isolated (like every plugin). Routes namespaced under `/api/v1/plugin/photo-carousel/*`. Default-deny: an admin grants its declared capabilities in `/admin/plugins`.

---

## 2. Card Gallery 🃏
**ID:** `card-gallery` | **Version:** 1.0.0

Displays event or promo cards as a full-width stack whose content alternates left/right by index (the
"zigzag"). There is no grid mode — the block's only fields are the gallery to show and an optional
anchor id.

*   **Rendering:** via the block itself (no shortcode is registered at runtime — `index.js` calls no `shortcodes.add`). `client/components/PromoCards.tsx` is the separate legacy *location* component declared in `frontend.components[]`; the block does not import it.
*   **Verso block:** `client/verso/CardGalleryVerso.tsx` (registry key `CardGallery`), self-contained — it embeds its own `.promo-card*` CSS.
*   **Permissions:** `settings` (read/write), `database` (write), `express` (register_route), `admin_menu` (register).
*   **Sandbox:** isolated (like every plugin). Routes namespaced under `/api/v1/plugin/card-gallery/*`. Default-deny: an admin grants its declared capabilities in `/admin/plugins`.

---

## 3. Video Gallery 🎬
**ID:** `video-gallery` | **Version:** 1.0.0

Manages YouTube video carousels. Galleries and their videos are stored in **options**
(`vgallery_galleries_list`, `vgallery_data_<id>`), not in a `wjp_` table.

*   **Shortcode:** `[vgallery]` — registered, but the handler returns the tag text rather than markup:
    the public frontend (`HomeContent.tsx`) matches the bare `[vgallery]` literal in the home page's
    HTML body and swaps it for the plugin's client component.
*   **Verso Component:** `VideoGalleryVerso` (registry key `VideoGallery`). Note its manifest sets
    `frontend.versoComponents` to `null`; the block is picked up by the generator's **convention
    fallback** on `client/verso/<Pascal>Verso.tsx`.
*   **Permissions:** `settings` (read/write), `database` (write), `express` (register_route), `admin_menu` (register).
*   **Sandbox:** isolated (like every plugin). Routes namespaced under `/api/v1/plugin/video-gallery/*`. Default-deny: an admin grants its declared capabilities in `/admin/plugins`.

---

## 4. Mail Server 📧
**ID:** `mail-server` | **Version:** 2.2.2

A complete SMTP server and email manager. Allows sending and receiving emails directly within WordJS.

*   **Features:**
    *   Inbound SMTP server (listens on port 25 by default — operator-configurable via the `smtp_listen_port` option — automatically falling back to the unprivileged port 2525 when 25 cannot be bound) + direct-MX outbound delivery (connects to remote MTAs on port 25) — runs inside the child process
    *   Attachment handling (multipart upload parsed by the host, forwarded to the isolate)
    *   DKIM signing (private key stored in the plugin's own DB/files, not a core secret option)
    *   Registers the host-wide mail sender (`provideMail`) and a notification transport
*   **Requested capabilities:** `settings` (read/write — non-secret SMTP/display options + the safe `site` bridge), `database` (read/write — its own `wjp_mail_server_*` tables), `email` (admin + provider), `notifications` (send/provider), `filesystem` (read/write), `users` (read — resolves local recipients via the safe users projection, never password hashes), `network` (for SMTP / outbound MX), `express` (register_route), `admin_menu` (register).
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

Pulls the videos of a YouTube channel (links, thumbnails, titles) and ships a carousel block
with title filtering and a video-count limit. Works **keyless** out of the box via the channel RSS
feed (latest 15 videos); add a YouTube Data API v3 key for the full upload history.

*   **Distribution:** first-party **marketplace** plugin (installed via the Marketplace catalog in §10) — not bundled with core.
*   **Routes:** `GET /`, `GET /status`, `POST /refresh`, `POST /settings` (namespaced under `/api/v1/plugin/youtube-videos/*`)
*   **Verso block:** `client/verso/YoutubeVideosVerso.tsx` (registry key `YoutubeVideos`) — carousel with title filter + count limit
*   **Admin page:** `/admin/plugin/youtube`
*   **Requested capabilities:** `settings` (read/write — configured channel + cached video list), `database` (read/write — the Data API key lives in the plugin's own `wjp_youtube_videos_*` table, **not** in options, because options are readable by other plugins), `network` (fetch youtube.com RSS / googleapis.com Data API — public egress only, like every `network` grant), `express` (register_route), `admin_menu` (register).
*   **Sandbox:** isolated (like every plugin). Default-deny: activation grants its declared capabilities, refinable in `/admin/plugins`.

---

## 10. Plugin Marketplace 🛒

Beyond the plugins above, WordJS ships a **Marketplace** of first-party plugins distributed
**outside** the core build (the Photo Carousel, Card Gallery, Video Gallery, Mail Server, Conference
Manager, and YouTube Videos sections above are themselves marketplace plugins — only Hello World and
Test Schema are bundled with core):

*   **Sources:** `marketplace/plugins/<slug>/` in the repo (31 plugins, listed below).
*   **Catalog build:** `npm run build:marketplace` (`backend/scripts/build-marketplace.js`) packs each
    plugin into `marketplace/dist/<slug>-<version>.zip` and emits `marketplace/dist/marketplace-index.json`
    (id, version, description, category, file, **sha256**). `marketplace/dist/` is a **build output and is
    NOT committed** (`.gitignore`); the catalog + zips are published as **GitHub release assets** by
    `.github/workflows/release.yml` (build:marketplace runs there), so `releases/latest/download/` always
    resolves to the newest published catalog — decoupled from any local checkout. Pin a fixed catalog by
    pointing a source at a specific release tag.
*   **Backend API:** `backend/src/routes/marketplace.ts` — `GET /api/v1/marketplace/catalog` (annotated
    with installed/active/updateAvailable state), `POST /api/v1/marketplace/install` and
    `POST /api/v1/marketplace/update` (both admin-only, sharing one apply handler), and
    `GET`/`PUT /api/v1/marketplace/sources` to read/replace the configured source list. (Themes have the
    parallel set: `GET /themes/catalog`, `POST /themes/install`, `GET`/`PUT /themes/sources`.)
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
    `http://localhost` in dev), and catalog filenames are strictly shape-validated.
*   **Admin UI:** the **Marketplace** tab in `/admin/plugins`
    (`frontend/src/app/admin/plugins/MarketplaceTab.tsx`) — browse, one-click install, update detection.
*   **Sandbox:** marketplace plugins are ordinary plugins — `"isolated": true`, bridge-only,
    default-deny grants, AST-scanned. Nothing about the marketplace bypasses the sandbox.

### Catalog (31 plugins)

| Slug | What it does | Key requested capabilities |
| --- | --- | --- |
| `analytics-tag` | Site-wide analytics tag (GA4, Plausible or Matomo) with optional cookie-consent gating | `settings` r/w, routes, admin menu, `assets:write` |
| `auctions` | Auction listings with bidding, anti-snipe extension, live polling, winner reporting | `database` r/w, routes, admin menu, `email:admin` |
| `bookings` | Appointment booking: services, weekly availability, race-safe slot reservations, email confirmations, admin agenda | `database` r/w, `settings` r/w, routes, admin menu, `email:admin` |
| `breadcrumbs` | Breadcrumbs Verso block with optional BreadcrumbList JSON-LD | — (frontend-only) |
| `card-gallery` | Event/promo cards as an alternating-alignment ("zigzag") stack via the `CardGalleryVerso` block | `settings` r/w, `database` write, routes, admin menu |
| `conference-manager` | Conference inscriptions/registration, hotel & room auto-assignment, per-inscription payments, attendee portal, reports + CSV export | `database` r/w, routes, admin menu |
| `contact-forms` | Form builder with a Verso embed block, submissions inbox, CSV export, email notification | `database` r/w, routes, admin menu, `email:admin` |
| `cookie-consent` | GDPR cookie banner, anonymous consent logging, version-based re-consent | `database` r/w, `settings` r/w, routes, admin menu, `assets:write` |
| `digital-downloads` | Sell/give away downloadable products with expiring token-gated download links | `database` r/w, `settings` r/w, routes, admin menu, `email:admin` |
| `donations` | Donation campaigns with goal thermometer, manual payment + optional Stripe Checkout, CSV export | `database` r/w, `settings` r/w, routes, admin menu, `email:admin`, `network` |
| `event-tickets` | Ticket types with quantity caps, unique ticket codes, attendee check-in | `database` r/w, `settings` r/w, routes, admin menu, `email:admin` |
| `events-calendar` | Admin-managed events shown as an upcoming list or monthly calendar Verso block | `database` r/w, routes, admin menu |
| `faq` | Database-managed FAQ accordion with categories + Google FAQPage JSON-LD | `database` r/w, routes, admin menu |
| `image-lightbox` | Site-wide click-to-zoom lightbox for content images (captions, keyboard nav) | `settings` r/w, routes, admin menu, `assets:write` |
| `invoices` | Invoices with statuses, dashboard totals, CSV export, public token URL + print view, email to client | `database` r/w, `settings` r/w, routes, admin menu, `email:admin` |
| `job-board` | Job listings with anti-spam public application form, applications inbox, filterable Verso block | `database` r/w, `settings` r/w, routes, admin menu, `email:admin` |
| `mail-server` | Full SMTP server: inbound listener + direct-MX outbound delivery, DKIM signing, host-wide mail sender + email notification transport | `settings` r/w, `database` r/w, `email:admin`+provider, `notifications`, `filesystem` r/w, `users` read, `network`, routes, admin menu |
| `newsletter` | Subscriptions (double opt-in when mail is configured), subscriber CSV, HTML campaigns with unsubscribe links | `database` r/w, routes, admin menu, `email:admin` |
| `notification-bar` | Slim site-wide announcement bar with CTA, dismissal versioning, schedule window | `settings` r/w, routes, admin menu, `assets:write` |
| `online-store` | Product catalog (variants, galleries, categories) + cart + checkout with server-side price validation, coupons, shipping zones and taxes, orders admin with refunds and transactional emails, sales reports + CSV, optional Stripe Checkout | `database` r/w, `settings` r/w, routes, admin menu, `email:admin`, `network` |
| `photo-carousel` | Image carousels for Hero sections / content sliders via the `PhotoCarouselVerso` block + `[carousel]` shortcode | `settings` r/w, `database` write, routes, admin menu |
| `polls` | WP-Polls-style polls with a voting + animated-results Verso block | `database` r/w, routes, admin menu |
| `popup-builder` | Site-wide popups with triggers (delay/scroll/exit intent), frequency capping, view/click stats | `database` r/w, routes, admin menu, `assets:write` |
| `related-posts` | Automatic per-post related articles via the core public REST API (YARPP parity) | — (frontend-only) |
| `restaurant-menu` | Menu sections/dishes with photos, diet tags and EU-14 allergens; priced modifier groups; opening-hours gating; cart with WhatsApp hand-off, cash, or Stripe Checkout; QR table ordering, table reservations, a live kitchen board and sales reports | `database` r/w, `settings` r/w, routes, admin menu, `email:admin`, `notifications:send`, `network` |
| `social-share` | Share buttons Verso block (Facebook, X, WhatsApp, LinkedIn, Telegram, Email, copy link) — the sharing itself is entirely client-side (share intents via `window.open`, copy via the Clipboard API) | admin menu only (its `init` just registers the sidebar item) |
| `table-of-contents` | Automatic nested TOC from page H2/H3 with anchors, smooth scroll, active highlighting | — (frontend-only) |
| `testimonials` | Database-backed testimonials with moderation and optional public submission form; carousel/grid Verso block | `database` r/w, `settings` r/w, routes, admin menu |
| `vendor-marketplace` | Multi-vendor directory: vendor applications, admin approval, self-service listings, per-product inquiries | `database` r/w, routes, admin menu, `email:admin` |
| `video-gallery` | YouTube video carousels via the `VideoGalleryVerso` block + `[vgallery]` shortcode | `settings` r/w, `database` write, routes, admin menu |
| `youtube-videos` | Pulls a YouTube channel's videos (keyless RSS or Data API v3) into a filterable, count-limited Verso carousel block | `settings` r/w, `database` r/w, `network`, routes, admin menu |

*(“routes” = `express:register_route`; “admin menu” = `admin_menu:register`. Every capability is
manifest-requested and admin-granted, default-deny, exactly like the bundled plugins. Both of these are
enforced grants, not just validated vocabulary: the host's `register-route` IPC handler in
`plugin-isolate.ts` refuses to mount a route (logs a warning and drops the message) unless
`express:register_route` is declared in the manifest and granted by the admin — the route-count cap and
the HTTP-verb / path-charset allowlists are applied only after that check — and `wordjs.adminMenu.add`
runs `verifyPermission('admin_menu', 'register')` in `plugin-api.ts`, which throws when the verb is not
both declared and granted. Isolated plugins reach `adminMenu.add` through the same host bridge, so the
gate applies to them identically.)*
