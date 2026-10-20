# Multisite: design

Status: **phase 1 and phase 2 implemented** — plugins and theme code per site
([Phase 2 as built](#phase-2-as-built-plugins-and-theme-code-per-site)), and Postgres/MySQL networks,
multi-node networks, certificates, backups and real-time collaboration per site
([Engines, nodes, certificates](#phase-2-as-built-engines-nodes-certificates-backups-collaboration)). What
of phase 2 remains open is listed at the end of that section. Phase 3 proposed. This page is the design for running several independent sites from one WordJS install: one network of sites, each with its own domain, content,
options, uploads, users and plugin data. It records how the code was wired before multisite, the tenancy
model it picks and why, what changes, what it guarantees, and the order in which it is built.

The three product decisions are settled (see [Decisions](#decisions)): users per site, plugin code
installed by network administrators only, domains before subdirectories. How to run a network is in
[Multisite](multisite.md); [Phase 1 as built](#phase-1-as-built) and
[Phase 2 as built](#phase-2-as-built-plugins-and-theme-code-per-site) list where the implementation
narrowed or departed from the plan below, and why.

- [Goals and non-goals](#goals-and-non-goals)
- [How the code was wired before multisite](#how-the-code-was-wired-before-multisite)
- [Tenancy model](#tenancy-model)
- [Site registry and the network store](#site-registry-and-the-network-store)
- [Host to site resolution](#host-to-site-resolution)
- [The site context](#the-site-context)
- [Subsystem by subsystem](#subsystem-by-subsystem)
- [Roles: network admin and site admin](#roles-network-admin-and-site-admin)
- [Isolation guarantees](#isolation-guarantees)
- [Single-site installs: zero change](#single-site-installs-zero-change)
- [What breaks, and the risks](#what-breaks-and-the-risks)
- [Phased plan](#phased-plan)
- [Phase 1 as built](#phase-1-as-built)
- [Phase 2 as built (plugins and theme code per site)](#phase-2-as-built-plugins-and-theme-code-per-site)
- [Phase 2 as built (engines, nodes, certificates, backups, collaboration)](#phase-2-as-built-engines-nodes-certificates-backups-collaboration)
- [Decisions](#decisions)
- [Alternatives considered](#alternatives-considered)

## Goals and non-goals

**Goals**

- One install serves N sites. Each site has its own main address (and aliases) and is, to its visitors,
  administrators and plugins, indistinguishable from a single-site install.
- **Tenant isolation is the product.** One site must never read or write another site's content,
  options, users, sessions, uploads, caches or plugin data, including through a plugin and including
  through a bug in a code path that forgot to scope a query. The target market is hosting third-party
  sites and third-party plugin code; isolation that depends on every query remembering a filter is not
  good enough for it.
- Existing single-site installs keep working **unchanged**: same database, same files, same URLs, same
  tokens, same config, no migration to run.
- Works in the three deploy modes (monolith, split, separate) and multi-node.

**Non-goals (for now)**

- Hundreds of thousands of sites per install. The model targets tens to a few hundred sites per
  install; beyond that the operator shards installs (a hoster already runs many).
- Tenants uploading their own plugin code (see [Decisions](#decisions)).
- Sharing content between sites (a post on two sites). Sites are separate.

## How the code was wired before multisite

Nothing in the code knows about a "site". Every connection, table name, cache key, pub/sub channel, lock
name, cron store, upload directory and worker exists once per process. The facts the design rests on:

**Database.** Each driver module exports one instance (`backend/src/drivers/sqlite-native-async.ts:271`,
`postgres.ts:463`, `mysql.ts:1176`) bound to one `config.dbPath` / `config.db`. Every caller reaches it
through two proxies in `backend/src/config/database.ts` (`db`, `dbAsync`, around `:683-750`) that
re-resolve the driver on **every property access**. That proxy is the single seam every query crosses.
Core tables have literal names with no prefix (`posts`, `post_meta`, `users`, `user_meta`, `comments`,
`comment_meta`, `terms`, `term_taxonomy`, `term_relationships`, `options`, `links`, `notifications`, plus
`api_tokens`, `webhooks`, `webhook_deliveries`, `form_submissions`, `posts_fts`, `audit_log`,
`collab_*`, `content_outbox`, `schema_migrations`, `wordjs_locks`, `wordjs_analytics`). About 370 SQL
statements in 35 non-test files name them. A transaction is pinned to one connection through an
AsyncLocalStorage (`transactionScope`, `database.ts:65`).

**Plugin tables.** A plugin may only touch tables under `wjp_<slug>_`, enforced by a lexer-based
validator (`assertSqlAllowed`, `backend/src/core/plugin-api.ts:281`) and, on Postgres and MySQL, by a
database principal per plugin (`backend/src/core/plugin-db-isolation.ts`). Plugin SQL is validated,
never rewritten. The Postgres driver assumes the `public` schema in its introspection and grants
(`postgres.ts:372-404`).

**Options.** One `options` table, cached as `option:<name>` (`backend/src/core/options.ts:53`) with
cross-node invalidation on `wordjs:option-changed`. Much per-site state already lives there:
`active_plugins`, `plugin_grants`, `plugin_egress_hosts`, `template`/`stylesheet`,
`active_theme_mods`, `active_theme_layout`, `wordjs_user_roles`, `cron`, `blogname`, `mfa_policy`.

**Config file.** `backend/wordjs-config.json` holds process-wide settings (secrets, driver, uploads
dir, Redis, ACME, logging) **and** the site's identity: `siteUrl`, `siteAliases`, `hostPolicy`
(`backend/src/core/site-address.ts` is its single writer; options `siteurl`/`home` are mirrors).

**Address gate.** `backend/src/core/host-policy.js` (byte-identical copy in `gateway/src/`) classifies a
request's host against exactly **one** canonical address plus aliases (`classify`, `:498-524`) and
answers 421 to anything else; the policy is pushed to the gateway. Its stated invariant is that an
accepted host grants nothing (`:19-20`). [Site address](site-address.md#why-not-several-main-addresses)
already says that several domains with their own identity is "multisite or domain mapping: a separate
feature". This is that feature.

**Sessions.** Stateless HS256 JWTs (`generateToken`, `backend/src/middleware/auth.ts:1289`) signed with
one `jwtSecret`, carrying `userId` and an optional address binding `mh`. Cookies are host-only (no
`Domain`). The user's role is user meta; the role→capability map is the option `wordjs_user_roles`.
The only super-user is the `administrator` role.

**Plugins and themes.** Code lives once on disk (`./plugins`, `./themes`). There is exactly one worker
process per plugin slug (`isolates` map keyed by slug, `backend/src/core/plugin-isolate.ts:44`; themes
as `theme:<slug>`). Routes mount on the global Express app at `/api/v1/plugin/<slug>`, hooks into one
global registry (`backend/src/core/hooks.ts:263`), and the request forwarded to a worker carries no host
or site. `init()` runs once per worker, so a plugin may keep state in module globals. The default theme
ships a `functions.js`, so theme workers are in play from day one.

**Uploads.** One tree (`config.uploads.dir`, default `./uploads`, layout `YYYY/MM/<name>-<uuid8>.<ext>`)
served by one static handler (`backend/src/index.ts:568-574`); private files under one
`privateDir`. Media references are relative (`/uploads/...`).

**Caches and ISR.** `backend/src/core/cache.ts` keys (`option:*`, `post:id:*`, `post:slug:*`) carry no
host; `flush()` is a Redis `FLUSHDB`. The frontend tags fetches with fixed names (`settings`, `posts`,
`post:<slug>`, `menus`, ...), and public SSR always sends the configured `siteUrl` host as
`x-forwarded-host` (`frontend/src/lib/server-api.ts:316-323`), so its Data Cache and Full Route Cache
are single-site by construction. There is no `middleware.ts` in the frontend and no `basePath`.

**Background work.** Cron (`backend/src/core/cron.ts`) runs from one `cron` option under one leader lock
`wordjs:cron`; the content outbox (`backend/src/core/content-outbox.ts`) is one table polled every 2 s;
lock names are global strings (`wordjs:boot`, `wordjs:active-plugins`, ...).

**Gateway and TLS.** The gateway routes by path only, never by host (`gateway/src/routing.js`). It serves
one certificate with no SNI selection; ACME issues one multi-SAN certificate covering `acme.domains`.

## Tenancy model

**Recommendation: one database per site**, selected per request through the existing `dbAsync` proxy.

| Engine | A site's "database" |
|---|---|
| SQLite (both drivers) | Its own file: `data/sites/<id>/wordjs-native.db` (or `wordjs.db` for the legacy driver). |
| PostgreSQL | Its own **schema** of the configured database (`wordjs_site_<id>`), one small connection pool per open site whose connections start with `search_path` set to it. (The plan said a database per site; see [as built](#phase-2-as-built-engines-nodes-certificates-backups-collaboration) for why a schema.) |
| MySQL / MariaDB | Its own database (MySQL's word for a schema) on the same server (`<db.name>_site_<id>`), one small pool per open site. |

Why this model, against the alternatives in [Alternatives considered](#alternatives-considered):

1. **Isolation is physical, not a convention.** A query that forgot to filter by site cannot see another
   site's rows, because the connection it runs on does not contain them. With a `site_id` column every
   one of ~370 core statements, every unique index and every plugin table must remember the filter; one
   omission is a cross-tenant leak. With a per-site table prefix the same is true of the table name, and
   the omission silently hits the main site's tables (WordPress multisite's recurring bug class).
2. **No SQL changes.** Core models, migrations and plugin SQL keep their literal table names. Every core
   table, and every plugin's `wjp_<slug>_*` table, simply exists once per site database.
3. **Per-site state that already lives in options becomes per-site for free**: active plugins, grants,
   active theme, theme mods, roles map, cron events, MFA policy, site title.
4. **The main site is untouched.** Site 1 *is* today's database. Enabling multisite moves nothing.
5. **Per-site export, backup, restore, deletion and move to another server are file- or database-level
   operations**, which is what a hoster needs.

Costs it accepts:

- Connections scale with open sites. Mitigated with an LRU of open site connections, small per-site
  pools on Postgres/MySQL (default max 4, idle close after 5 minutes) and lazy opening.
- Postgres and MySQL need the right to create a database, or the operator pre-creates one per site (the
  network screen accepts either). A hosting plan that offers one database only cannot run multisite.
- Schema migrations run once per site database (at boot under each site's lock, and on first open of a
  site that is behind).
- Cross-site queries (a network-wide search) are not possible in SQL. They are not a goal.

Subdirectory sites (`example.com/blog2`) are deferred to a later phase; see
[Decisions](#decisions).

## Site registry and the network store

Multisite adds one small **network store**, separate from every site database:

- SQLite: `data/network.db`. Postgres/MySQL: a database named `<db.name>_network` (or one the operator
  names in `multisite.networkDb`).

It holds only network-level data:

| Table | Content |
|---|---|
| `network_sites` | `id` (integer; **1 is the main site**), `slug`, `status` (`active`, `suspended`, `archived`), `main_url`, `created_at`, `updated_at`, storage locator (SQLite path / database name), uploads root. |
| `network_site_hosts` | `host` (unique, normalized by the same strict parser as the address gate), `site_id`, `kind` (`main`, `alias`), `mode` (`serve`, `redirect`), `expires_at`. A host belongs to at most one site. |
| `network_admins` | Network administrators (see [Roles](#roles-network-admin-and-site-admin)). |
| `network_audit_log` | Site created, suspended, host added/removed, network admin changes. |
| `network_meta` | Schema version and network settings. |

The main site's addresses stay where they are: `siteUrl`/`siteAliases` in `wordjs-config.json`, written
only by `site-address.ts`, mirrored into `network_site_hosts` for lookup. Every other site's addresses
live only in the registry and are written only by a new `network-sites.ts` module (the registry's
single writer, under a network lock, audited, with the same strict host parser and the same refusals as
site addresses: no wildcards, no suffixes).

The registry is small and read on every request, so it is cached in memory per node and invalidated by
a `wordjs:network-changed` broadcast plus a periodic re-read, the same pattern as `coherence.ts`.

## Host to site resolution

The address gate becomes the place where a request is assigned to a site:

1. `host-policy.js` (both copies, kept byte-identical; the parity test stays) gains a `sites` map:
   `hostname → { siteId, kind, mode }`, built from the registry. `classify()` returns the site with the
   class. Loopback, IP literals and development origins resolve to **site 1 only**; no other site is
   reachable without its declared name.
2. An unknown host still gets **421**, exactly as today. A suspended site gets a static 503 page from
   the edge (no content, no API).
3. The backend gate stores the resolved site on the request and enters the site context (next section)
   before any other middleware that reads data, including `/uploads`, `/themes` and `/plugins`, which
   today skip the gate. In multisite those paths need the site too (to pick the uploads root), so they
   are resolved, though still not refused for unknown hosts beyond what the edge already does.
4. The policy pushed to the gateway carries the sites map, so the gateway edge refuses unknown hosts
   and serves the per-site redirect aliases. The gateway still routes by path; it never needs to know
   which backend serves which site, because every backend serves every site.

The invariant in `host-policy.js:19-20` is restated, not dropped: **the host selects the data partition
and nothing else.** Inside a site, authorization still comes only from that site's own users, roles and
sessions; a host never grants a capability, and links are never built from the request (see
[links](#links-and-identity)).

## The site context

A new module, `backend/src/core/site-context.ts`, owns one AsyncLocalStorage:

```ts
type SiteContext = { siteId: number; site: SiteRecord };
runWithSite(siteId, fn)        // enter a site for fn and everything it awaits
currentSite(): SiteContext     // throws in multisite when there is none
forEachSite(fn, { status })    // background work: run fn once per site, each in its own context
```

Rules:

- **Fail closed.** In multisite mode a database, cache, upload or option access with no site context
  throws (`site_context_missing`) instead of defaulting to site 1. Defaulting would turn every
  forgotten propagation into a write to the main site. Boot code that legitimately runs before any
  site is entered uses the network store only.
- In single-site mode there is no registry; `currentSite()` returns the implicit site 1 and nothing
  else changes.
- Context crosses async boundaries automatically (ALS), but **not** process boundaries. Every place
  where work re-enters from outside a request must re-enter explicitly: worker IPC callbacks (the
  host knows which site a worker belongs to), timers, cron ticks, outbox dispatch, Redis pub/sub
  messages (which will carry the site id), the gateway purge fan-out.
- A transaction pinned in `transactionScope` records its site; using it from another site's context
  throws.

## Subsystem by subsystem

### Database

- Drivers become factories (`createDriver(kind, locator)`) instead of module singletons; the current
  singletons remain as site 1's instance.
- `getDbAsync()` / `getDb()` return the current site's driver, opening it on first use (schema check
  and pending migrations under that site's boot lock, then cached in an LRU).
- `initializeSchema` + `runSchemaMigrations` run per site database. `schema_migrations` already lives
  inside each database, so each site tracks its own version.
- Postgres/MySQL per-plugin principals are cluster-wide objects, so their names gain the site:
  `wjp_role_s<id>_<slug>` (site 1 keeps today's names). Grants are issued per site database.
- `clearDatabase`, `db-dump`, backups and the SQLite→Postgres migration tool act on the current site.

### Options and settings

Options are per site because the table is. The option cache key is namespaced (below). The
`wordjs-config.json` keys split into two groups:

- **Network-wide** (stay in the file): secrets, driver and server credentials, Redis, ACME account,
  logging, sandbox, uploads base dir, ports, trust proxy, mTLS.
- **Per site**: main address and aliases (site 1: the file as today; others: registry), site name and
  description (options).

The ~137 direct reads of `config.siteUrl` / `config.site.*` go through `site-address.ts` helpers that
take the current site (`linkBase()`, `canonicalOrigin()`), which already exist for site 1.

### Users, sessions, API tokens, MFA

With users per site (recommended, see [Decisions](#decisions)) the `users` table, roles,
MFA secrets, recovery codes, API tokens and revocation markers are already per site. Two additions make
a token unusable on any other site even if a check were forgotten:

- **Per-site signing key.** Sessions on site N are signed with `HMAC(jwtSecret, "wordjs-site:" + N)`.
  Site 1 keeps the raw `jwtSecret`, so existing sessions stay valid. A token from site 2 fails the
  signature check on site 3 before any claim is read.
- **Site claim.** Tokens carry `sid`; verification refuses a mismatch with the request's site. User ids
  collide across sites (user 1 exists on every site), so this matters even without an attacker.
- MFA challenge tokens get the same treatment. API tokens (`wjt_`) are looked up in the site's own
  `api_tokens`, so a token from another site simply does not exist.
- Cookies are already host-only, so per-domain sites have separate cookie jars. CSRF origin checks use
  the site's own hosts.

### Uploads and media

- Site 1: `uploads/` and `data/private-uploads/` unchanged.
- Site N: `<data dir>/sites/<N>/uploads/` and `<data dir>/sites/<N>/private-uploads/`, next to its database (see [Phase 1 as built](#phase-1-as-built)), created on site creation.
- The `/uploads` static handler and image negotiation resolve their root from the request's site.
  Stored references stay relative (`/uploads/2026/10/x.jpg`), so content needs no rewrite, and the
  same relative URL on two domains names two different files.
- Containment checks (`Media.ts`) prove paths against the site's own root. The hardcoded
  `UPLOADS_DIR` in `plugin-api.ts:57` is replaced by the site's root.
- Media derivatives (`.derivatives/`) live under the site's root.

### Caches, pub/sub and frontend purge

- `cache.ts` namespaces every key with `s<id>:` for sites other than 1 (site 1 keeps bare keys, so
  a single-site Redis is untouched). `flush()` stops calling `FLUSHDB` in multisite and deletes the
  site's keyspace instead.
- Broadcasts (`wordjs:option-changed`, `wordjs:cache-del`, `wordjs:plugin-changed`, ...) carry the site
  id, and receivers apply them inside that site's context.
- Every module-level `Map`/`Set` that caches site data (roles cache, plugin grants, admin menu, active
  plugins, admin notices, frontend-purge queues, theme engine state, and the rest of the ~50 files with
  module-level collections) is either keyed by site or recorded as site-agnostic. A guard test lists
  the module-level collections and fails when a new one appears without a classification, the same way
  `verify:f0` pins other architectural surfaces.
- Frontend purge tags are site-qualified for sites other than 1 (`s2:posts`, `s2:post:<slug>`) and the
  purge request carries the site; site 1's tags are unchanged.

### Frontend (Next.js)

This is the largest single change, because the Next.js caches are keyed by path and the public data
helpers pin one host.

- A `middleware.ts` rewrites public page requests internally to a site segment
  (`/<path>` → `/_sites/<siteKey>/<path>`), the standard multi-tenant pattern for the App Router. The
  public route tree moves under `app/_sites/[site]/`. Visitors never see the segment. In single-site
  mode the rewrite always targets site 1, so URLs, pages and caching behave as today.
  **As built:** there is no `middleware.ts` and the public tree did not move. `src/proxy.ts` (Next 16's
  name for the middleware entry) only marks another site's public requests with the internal header
  `x-wordjs-site-route`, a `beforeFiles` rewrite in `next.config.ts` sends them to the
  `app/wjs-site/[siteHost]/` tree, whose pages wrap the `(public)` ones, and the main site and every
  single-site install are never rewritten. The site comes from the edge's `x-wordjs-site-host`, not
  from a registry snapshot fetched by the frontend. See [Phase 1 as built](#phase-1-as-built).
- The site key comes from the host, resolved against a registry snapshot the backend exposes to the
  frontend (an internal, authenticated endpoint; cached briefly). An unknown host never reaches the
  frontend (the edge already answered 421).
- `server-api.ts` helpers take the site: they send that site's **main** host as `x-forwarded-host`
  (never the inbound one, preserving the current reasoning), and tag fetches with the site-qualified
  tags. `generateStaticParams` runs for site 1 only; other sites render on demand and are then cached
  by ISR like any page.
- `/admin` is already dynamic and calls a relative `/api/v1`, so it reaches the right site through the
  host. The admin shell shows which site it is administering.

### Plugins

- Code is installed **once per network**, by a network administrator only (`plugins/`, shared
  `node_modules`). Site administrators cannot upload or install plugin code.
- Activation and permission grants are **per site** (they are options). A network-level **grant
  ceiling** per plugin (what the network admin allows any site to grant) bounds what a site admin can
  grant.
- **One worker per (site, plugin)**, keyed `s<id>:<slug>` (site 1 keeps `<slug>`). A plugin's memory,
  module globals, caches and `init()` state never see two tenants, so plugins written for a single site
  stay correct, and a compromised worker holds one site's capabilities only. Its bridge calls run in its
  site's context, its database principal is its site's, its route invocations come only from its
  site's requests.
- Routes stay at `/api/v1/plugin/<slug>/...`; a host-side dispatcher picks the worker for the
  request's site and answers 404 when the plugin is not active there.
- Hook registrations are recorded with their site; dispatch runs only the current site's callbacks.
  Shortcodes, the mail provider and notification transports become per-site registries the same way.
- Workers start lazily on first use and are reaped when idle, so N sites × M plugins does not mean N×M
  resident processes. Memory caps per worker are unchanged.

### Themes

Themes are installed network-wide; the active theme, its mods and layout are per site (options). Theme
workers (`functions.js`, which the default theme has) are keyed per site like plugins
(`theme:s<id>:<slug>`).

### Cron, scheduled publishing, outbox, webhooks, notifications

- Cron events are already per site (the `cron` option). The cron tick runs `forEachSite` and takes a
  per-site leader lock (`wordjs:cron:s<id>` inside that site's database), so one slow site does not
  delay the rest beyond a bounded concurrency.
- The content outbox table is per site; the poller iterates open sites with bounded concurrency and
  dispatches each row in its site's context. Scheduled publishing, webhooks, audit log, notifications
  and analytics retention follow from the same rule.
- Network-level jobs (certificate renewal, network backups) run once, under network locks in the
  network store.

### Links and identity

Every link built outside a request (password reset, verification email, feeds, sitemap, canonical and
OpenGraph tags, plugin `site.url()`, mail domain) uses **the current site's main address from the
registry**, never the request's host. That keeps the guarantee `site-address.md` explains: whoever
triggers a reset cannot choose where its link points. Site 1 keeps reading `siteUrl`.

### Gateway, TLS and ACME

- The edge receives the sites map in the pushed policy and enforces it (421 for unknown hosts, 308 for
  redirect aliases, 503 for suspended sites).
- Phase 1 TLS: the existing multi-SAN certificate, with the sites' main hosts added to its names (or
  TLS terminated by the operator's proxy). Let's Encrypt caps a certificate at 100 names.
- Phase 2: a per-host certificate store and SNI selection (`SNICallback`) in the gateway and the
  monolith, with one ACME order per site.

### CLI, export/import, backups

- `npm run network -- enable|status|sites|create|suspend|resume` manages the network.
  `npm run site` keeps managing site 1's addresses.
- Export/import (WXR and native), backups and restore act on one site, chosen with `--site <id|host>`
  on the CLI and implied by the request's site in the admin.

## Roles: network admin and site admin

- **Site administrator**: today's `administrator` role, inside one site. It can do everything a single
  site's administrator does today except install or delete plugin and theme code and grant plugin
  permissions beyond the network ceiling. It cannot see that other sites exist.
- **Network administrator**: a separate identity stored in the network store (`network_admins`). It
  signs in on the main site's address at `/admin/network`, with its own session (its own signing key
  and claim, MFA required). It can create, suspend, resume and archive sites, manage their hosts,
  install and remove plugin and theme code, set grant ceilings, and see the network audit log.
- A network administrator does **not** silently get into a site's content. To administer a site it
  uses an explicit, audited, short-lived "open as administrator" handoff into that site (recorded in
  both the network audit log and the site's own audit log) — built in phase 2, see
  [The handoff into a site](#the-handoff-into-a-site-as-built). Phase 1 omitted it: creating a site
  creates its first administrator, who signs in on the site.
- On enabling multisite, the administrators of site 1 who run the command become network
  administrators (the CLI asks which).

## Isolation guarantees

Each guarantee names what enforces it and the test that proves it. "Two sites" below means sites A and
B with the same roles and users with the same ids on each.

| # | Guarantee | Enforced by | Proven by |
|---|---|---|---|
| I1 | A site's content, options, users, comments, terms, menus, revisions and plugin tables are unreachable from another site. | Separate database per site; fail-closed site context. | IDOR suite: an administrator of A reads and writes posts, options, users and comments by id and slug through every core route with B's host and with A's; every cross attempt returns B's own data or 404, never A's. |
| I2 | A session, API token or MFA challenge from one site is worthless on another. | Per-site signing key, `sid` claim, per-site token table, host-only cookies. | A's cookie, bearer JWT and `wjt_` token sent to B → 401; a token re-signed with A's key but claiming B → 401. |
| I3 | A site's uploads, private files and derivatives cannot be fetched or overwritten from another site. | Per-site upload roots resolved from the site context; containment checks against that root. | A's file path requested on B's host → 404; private media id of A on B → 404; upload on B lands under B's root. |
| I4 | Caches and broadcasts never serve one site's value to another. | Site-namespaced keys and tags; site id on every broadcast. | Same option, post id and slug set differently on A and B; reads through cache (with and without Redis) stay distinct; purge on A leaves B cached. |
| I5 | A plugin active on A cannot act on B. | Worker per (site, plugin); site-scoped bridge; per-site dispatch of routes and hooks; per-site DB principal. | A plugin active only on A answers 404 on B; its hook does not fire for B's events; its bridge DB calls see A's database only (`multisite-plugins.test.ts`). |
| I6 | A request cannot steer which site it lands on beyond the hosts the registry declares, and links never follow the request. | Registry-only host map, strict parser, 421 for unknown hosts, links from the registry. | Unknown host → 421; forged `X-Forwarded-Host` from an untrusted hop ignored; password reset on B links to B's main address whatever `Host` says. |
| I7 | Code that forgot to propagate the site fails instead of touching site 1. | `currentSite()` throws in multisite. | A test that calls a model outside any site context in multisite mode gets `site_context_missing`. |
| I8 | A site admin cannot raise their own plugin's privileges beyond the network's decision. | Grant ceiling checked on the host. | Site admin grant beyond the ceiling → 403 (`multisite-plugins.test.ts`). |

What is **not** isolated, by design: CPU, memory and I/O of the backend process are shared (a noisy
site slows its neighbours; a per-site media storage quota exists, other per-site quotas are a later
phase), and the network administrator can reach
every site.

## Single-site installs: zero change

Multisite is off unless `multisite.enabled` is `true` in `wordjs-config.json`, which only
`npm run network -- enable` writes. While it is off:

- No network store is created or opened; `currentSite()` is the implicit site 1.
- Database path, upload paths, cache keys, pub/sub channels, purge tags, lock names, worker keys,
  JWT signing key and claims, cookie names, routes and the frontend's URLs are byte-for-byte what they
  are today. Every "site 1 keeps ..." rule above exists to guarantee this.
- The full existing test suite runs unchanged against single-site mode, and a dedicated test asserts
  that a single-site boot opens no network store and that tokens minted before the upgrade still work.

Enabling multisite on an existing install creates the network store and registers the existing site as
site 1 pointing at its current database, uploads and addresses. Nothing is copied or moved. Disabling is
allowed while site 1 is the only site.

## What breaks, and the risks

- **Module-level state.** About 50 core files keep module-level `Map`/`Set` collections, and some code
  may capture `config.siteUrl` or a database handle at import time. Each one is a potential cross-site
  leak until classified. Mitigation: the inventory and guard test in phase 0, before any second site
  can exist.
- **Context propagation across process and timer boundaries** (worker IPC, cron, outbox, pub/sub,
  `setTimeout`). Mitigation: fail-closed context, so a miss is an error rather than a leak.
- **Plugins that assume one site** keep working because each site gets its own worker. Plugins that
  write files outside their sandbox paths or rely on shared `node_modules` state are already constrained
  by the sandbox; their per-site writable paths need a site segment.
- **Resource growth**: open SQLite handles, Postgres/MySQL connections, and plugin workers grow with
  active sites. Bounded by LRU, small pools and idle reaping; documented limits.
- **Hosting without CREATE DATABASE** cannot add sites on Postgres/MySQL unless the operator pre-creates
  databases.
- **Frontend restructuring** moves the public route tree under a site segment: the largest diff, and
  the one most likely to regress single-site rendering. It needs the public-site regression tests and a
  browser check in the three deploy modes.
- **The address gate's invariant changes wording** (host selects the partition). The security review
  of `host-policy.js` must be redone for the sites map, and both copies must stay identical.
- **Multi-node**: the registry, caches and locks all gain a site dimension; every node must see the
  same registry (shared network store, as the database is already shared).
- **Documentation claims**: `README.md` roadmap lists multi-site; it stays a roadmap item until the
  phase that ships it.

## Phased plan

**Phase 0: groundwork (no behaviour change).** Site context module (single-site implementation),
driver factory with site 1 as today's instance, cache-key and broadcast namespacing hooks (identity in
single-site), `siteUrl` reads routed through `site-address.ts` helpers, module-state inventory and its
guard test. Ships on its own; single-site suite must be green and `verify:f0` updated.

**Phase 1: sites exist (domains, core content).**
- Network store, site registry, `npm run network` CLI, network administrator identity.
- Host→site resolution in `host-policy.js` (both copies), backend gate and gateway push; 421 and 503.
- Per-site database provisioning (SQLite first-class; Postgres/MySQL via CREATE DATABASE or a
  pre-created database), schema and migrations per site.
- Data scoping for core content, options, users, comments, terms, menus, media, revisions, through the
  per-site database; per-site uploads roots; per-site signing key and `sid` claim.
- Cache, broadcast and purge-tag namespacing; frontend site segment and site-aware data helpers.
- Theme workers per site (the default theme needs one). **Plugins are not activatable on sites other
  than 1 in this phase** (the loader skips them), which keeps the plugin isolation work out of the
  first PR.
- Cron, outbox and scheduled publishing per site.
- Network admin screen: list sites, create a site (main host, title, first administrator), suspend,
  resume.
- Tests: the isolation suite (I1–I4, I6, I7) with two sites and same-role users, plus the full
  single-site regression suite. Verified in the three deploy modes before merge.

**Phase 2: plugins and certificates per site.** Worker per (site, plugin), per-site activation and
grants with the network ceiling, per-site hooks/routes/shortcodes/mail/notification dispatch, per-site
DB principals, isolation tests I5 and I8; theme workers per site; real-time collaboration per site;
SNI and per-site ACME; per-site backup, export and restore; the network admin's audited handoff into a
site; Postgres and MySQL site databases (and so multi-node networks); a root layout per site in the
frontend.

**Phase 3: scale and hosting features.** Subdirectory sites (if chosen), per-site quotas (storage,
workers, database size, request rate), site templates and cloning, archival and deletion with
retention, network dashboard and metrics per site, optional Postgres schema-per-site variant.

## Phase 1 as built

Phase 1 follows the plan above with these narrowings and departures, each deliberate:

- **SQLite only** (in phase 1). A network needed the `sqlite-native` driver; the network store, every
  site database and every site's files lived on one host. Postgres and MySQL networks, and multi-node
  networks, came in phase 2 ([as built](#phase-2-as-built-engines-nodes-certificates-backups-collaboration)).
- **Uploads live with the site.** Another site's files are in `<data dir>/sites/<id>/uploads` and
  `…/private-uploads`, next to its database, not under `uploads/sites/<id>`: under the main site's served
  tree, the main site's address would have served them. Each site is one directory. `core/io-guard`
  declares those directories served (plugins cannot write there anyway: no broad `data/` access).
- **Network administrator = a listed administrator of the main site**, not a separate identity. The
  role and the listing are both required, and the network screen exists only on the main site. The
  audited "open as administrator" handoff into another site is phase 2; a new site's first administrator
  is created with it and signs in on the site's own address.
- **Theme code too stays on the main site.** The theme engine (a theme's `functions.js` worker) is one
  process-wide runtime, so another site can switch themes and customise them (options), but its pages
  run no theme server code; its hooks and shortcodes are skipped there, like a plugin's. Theme files
  are network-wide: creating, editing, uploading or deleting them is the main site's.
- **What else stays the main site's in phase 1**: plugins (management, routes, assets, hooks,
  shortcodes, mail provider, notification transports), backups, certificates, the site-address screen,
  the installer, the hooks inspector, the database migration tool, real-time collaboration (its rooms are
  keyed by post id per process) and the cron jobs that act on the main site's files (backups, version
  checks, maintenance). Another site's cron runs scheduled publishing and analytics retention only.
- **The frontend**: another site's public pages are rewritten to an internal `wjs-site/[siteHost]`
  route tree whose pages wrap the `(public)` ones and declare the site before any read, so each site's
  pages have their own Full Route Cache paths and Data Cache tags. The site comes from
  `x-wordjs-site-host`, which only the edge sets (from its own verdict; a client's value is removed, and
  the frontend's replica dispatcher drops it from any peer but the gateway). `src/proxy.ts` only marks
  the request (`x-wordjs-site-route`) and a `beforeFiles` rewrite in `next.config.ts` does the rewrite:
  a rewrite returned by the proxy function is internal only when its origin matches the one Next built
  for the request, which behind the gateway's mTLS hop it does not.
- **Server-side reads reach the right site in every mode.** The frontend fetches a site's data naming
  it in `X-Forwarded-Host`: the backend believes that from a loopback hop (monolith, split), and the
  gateway believes it from a **registered frontend node** (separate mode) when the address the node
  connected to and the address it names are both addresses of the network. With multisite on, every
  backend response names the site that answered (`X-WordJS-Site-Host`), and another site's page refuses
  data from any other site, so a deployment path that loses the site fails closed (not found) instead of
  showing one site's content under another's address.
  The root layout cannot know the site (it takes no params): another site's pages override its metadata
  (title, description, icon, base URL), and the admin sets its own title from the request; the `lang`
  attribute of `<html>`, the server-rendered `@font-face` rules and the title of the sign-in pages still
  come from the main site. A root layout per site is a phase 2 item.
- **Email**: the mail provider is a main-site plugin, so the other sites have none; password recovery
  there fails closed, as on any site without one. (Phase 2: a site's own mail plugin provides its mail.)

## Phase 2 as built (plugins and theme code per site)

The plugin half of phase 2. The rest — engines, nodes, certificates, backups, collaboration — is in the
next section.

- **Worker key.** `core/plugin-isolate` keys every registry (isolates, in-flight loads, health, restart
  timers, live pids, spawn policies) by `siteKeyPrefix(site) + slug`: `<slug>` on site 1 — single-site
  installs keep their keys, process names, cgroup units and AppContainer profiles — and `s<id>:<slug>`
  elsewhere. A theme's worker is `theme:<slug>` on site 1 and `s<id>:theme:<slug>` elsewhere (the prefix
  comes first, so every `theme:` check keeps reading the inner slug). The public functions take a plugin
  slug and act on the current site's worker; `listIsolates()` answers the current site's slugs, and
  `listIsolateKeys()` / `getAllIsolateStatuses()` the network's.
- **Site-scoped bridge and registrations.** Every IPC frame from a worker is handled inside
  `runWithSite(itsSite)`: its bridge calls read and write that site's database and options, its grants are
  checked against that site's, and what it registers lands in that site's tables. `core/hooks` records
  the site with each plugin callback and runs only the callbacks of the site the hook fires for;
  `core/shortcodes`, `core/notifications` (plugin transports) and `core/mail-provider` keep per-site
  registries (site 1 keeps `global.wordjs_send_mail`, so single-site callers are unchanged). Plugin cron
  events run on every site again, answered only by that site's worker.
- **Routes.** Every site's worker mounts the same `/api/v1/plugin/<slug>/…` paths; each mount starts with a
  gate that passes the request on (`next('route')`) unless it was addressed to the mount's site, so a
  request reaches its own site's worker, or — the plugin not being active there — no mount, and a 404.
  The `/plugins/<slug>/…` static files and the frontend bundles were already gated on the current site's
  active set.
- **Activation per site, code per network.** `active_plugins`, `plugin_grants` and `plugin_egress_hosts`
  are options, so they were already per site; `core/plugin-permissions` now keeps its in-memory mirror per
  site too (`perSite`). Another site never installs or prunes dependencies (the shared `node_modules` is
  the network's) and skips the plugin test run (done once, for the network); its plugins load when the
  site is prepared (`initSiteRuntime`), after its own grants. CrashGuard watches the main site's boot only.
  Deleting a plugin deactivates it on every other site first; an in-place update restarts their workers on
  the new code.
- **Grant ceiling (I8).** The network store's `network_plugin_ceilings` table holds, per plugin, the tokens
  any other site may grant. No row = not offered: activation and grants on another site answer 403
  `plugin_not_offered`. A grant beyond the ceiling is refused (403 `plugin_grant_beyond_ceiling`), seeds
  and upgrade grants are clipped to it, and `isGranted` / `isNetworkGranted` also check it on every read,
  so a lowered ceiling stops a capability on every site at once (and the policy fingerprint changes, so
  running workers are respawned). The main site has no ceiling. API: `GET /network/plugins`,
  `PUT|DELETE /network/plugins/:slug/ceiling` (network administrators, re-authenticated); UI: Admin →
  Network → Plugins for the sites.
- **Private storage per site.** `core/sandbox-paths` keys a worker's storage directories by
  `s<id>:<slug>` on another site, and only site 1's worker may write the plugin's own (shared) code
  directory — the native sandboxes, Node's permission model and `core/io-guard` all read that one
  declaration. On Windows each (site, plugin) worker has its own AppContainer profile, named for its worker
  key (`core/sandbox-windows` `appContainerProfileNameForSite`). Deleting a plugin retires that profile on
  every site of the registry, suspended ones included (`core/plugins` `retireOnSecondarySites`, after its
  workers have stopped; an in-place update keeps the other sites' workers and their profiles). Deleting a
  site retires the profile of every installed plugin's and theme's worker of that site and removes their
  private storage (`network-sites` `retireSiteWorkers`). Only names derived for that (site, worker) are
  touched, so no other site's or plugin's profile is. Linux and macOS keep no persistent profile.
- **Database principals.** `core/plugin-db-isolation` names the Postgres role / MySQL user of another site
  `…__s<id>` (a slug can never produce a double underscore), so each site's worker queries under its own
  principal. On Postgres and MySQL networks each site's role / user is granted only that site's plugin
  tables (in the site's schema / database); SQLite has no principals.
- **Theme workers per site.** `core/theme-engine` keeps its active theme and its re-init lock per site;
  each site runs its own `functions.js` worker, started when the site is prepared and on a theme switch.
- **Not yet**: idle reaping of workers (a site's workers start with the site and stay up).
- **Tests**: `backend/src/tests/multisite-plugins.test.ts` (real plugin workers: I5 and I8),
  `backend/src/tests/multisite-appcontainer-retire.test.ts` (profile retirement; a live half on Windows).

## Phase 2 as built (engines, nodes, certificates, backups, collaboration)

The rest of phase 2, as built.

- **Postgres: a schema per site; MySQL: a database per site** (`core/site-storage`). `config/database`
  opens each site's namespace with its own small pool (`multisite.sitePoolMax`, default 4): a
  `PostgresDriver` whose `search_path` is the site's schema (a startup parameter, checked against
  `current_schema()` when the pool opens), or a `MysqlDriver` on the site's database. The main site's
  connection creates the namespace first (`CREATE SCHEMA` / `CREATE DATABASE … utf8mb4`); an operator
  without that right creates it beforehand. Every catalog query that used to name `public` or no schema
  at all — the driver's table listing, column introspection and plugin grants, the schema migrations'
  column probes, the search engine probe, the email model's column probe, the plugin uninstall's table
  scan, the engine migration's table listing — now reads `current_schema()` (MySQL: `DATABASE()`), so on
  a network it sees the site's own tables and nothing else. Two places that bypassed the site
  (`createPluginTable`, `clearDatabase`) now go through the current site's driver. A table prefix was
  rejected for MySQL for the reasons in [Alternatives](#alternatives-considered).
- **The network store on the database server.** `core/network` keeps its tables in the `wordjs_network`
  schema / `<db.name>_network` database on Postgres and MySQL (SQLite keeps `network.db`). Reads stay
  synchronous: each node keeps an in-memory mirror, reloaded after its own writes, when another node
  announces a change (`wordjs:network-changed`) and every 15 s. Writes are async and transactional; two
  nodes creating a site at once compete for the next id and the loser retries. Site ids are never reused
  (a high-water mark in `network_meta`), so a namespace a failed deletion left behind never reaches a new
  site.
- **Multi-node.** Each node follows the registry (`network-sites.followRegistryChanges`): a site suspended
  elsewhere stops its workers here, one deleted is forgotten (workers, connection, preparation). The bus
  delivers a site's message only on a node that has that site open (`cache.siteRouting`): a node that
  never opened a site has nothing to invalidate, and one still opening it gets the message once it is
  ready. Each site's cron runs under its own lease, in its own database (`dist-lock` keeps its table state
  per site, and every site's database gets the lock table when it opens). The plugin-policy re-sync runs
  for every site a node has open.
- **Certificates per site** (`core/site-certs`, `gateway/src/site-certs.js`). One certificate per site
  address, stored in the network store (`network_site_certs`), pushed to the gateway (`POST /site-cert` on
  the control plane) or written for the monolith, and selected by `SNICallback` in both; the main site's
  certificate stays the default. Let's Encrypt over HTTP-01 reuses the main site's ACME account and the
  order flow of `core/cert-manager` (`obtainHttp01Certificate`); challenge answers are shared through
  `network_acme_challenges` and answered by every backend; the gateway's port-80 listener redirects a
  token it does not hold to HTTPS. The renewal pass runs on the main site's cron leader.
- **Backups per site** (`core/backup`). A site's archives are its own (`<data dir>/sites/<id>/backups`),
  hold its database (file copy, `pg_dump -n <schema>`, `mysqldump` of its database), uploads and private
  files and never code; a restore drops and restores the site's namespace whole, then prepares the site
  again (fresh plugin principals). On a Postgres network the main site's dump is limited to its schema.
- **Real-time collaboration per site** (`core/collab-rooms`). Rooms, per-user caps and budgets, log
  sizes and the sweep cursor live in one container per site; replica ids mix in the site (site 1 keeps
  its ids); the bus message signs its site inside the HMAC and a receiver drops one whose signed site is
  not the envelope's. The 404 off the main site is gone, and each site's sweep runs from its own cron.
- **Site deletion** (`network-sites.deleteSite`): suspended first, slug confirmed; media objects,
  principals (installed plugins', this process's, and every role / user with the site's suffix on the
  server), its workers' AppContainer profiles (Windows) and private storage, cache keys, database, files,
  certificate and record are removed.
- **The engine migration moves the network** (`db-admin/migration.js migrateNetwork`): every site into its
  namespace on the target and the network store, fail-closed before the config switches.
- **Tests**: `multisite-engine-{sqlite,postgres,mysql}.test.ts` (the same suite on each engine, in the
  F6 "Phase suites on 3 engines" matrix), `tests-integration/multinode-network.integration.ts` (two
  processes, one network, in the multi-node job), `gateway/test/site-certs.test.js` (SNI on a real TLS
  listener).
- **The network administrator's handoff into a site** (`core/network-handoff`): see
  [The handoff into a site](#the-handoff-into-a-site-as-built) below.
- **Still open in phase 2**: a root layout per site in the frontend, and idle reaping of a site's workers.

### The handoff into a site (as built)

`POST /network/sites/:id/handoff` (main site; network administrator; interactive session;
`currentPassword`) and `POST /auth/handoff` (the target site), in `core/network-handoff`.

- **The token.** A JWT signed with the TARGET site's key (`core/site-keys`, `sid` = the target), carrying
  `purpose: network_handoff`, the network administrator's id and login (`uid`, `by`), the site's main
  hostname (`aud`), the main site's hostname (`from`), a random `jti` and a 60-second `exp`. The `jti` is a
  row of the network store (`network_handoffs`), so redemption is one `DELETE` that changes one row, on
  whichever node receives it: a token works once across the network. The row is deleted before anything
  else is judged, so a token refused for its address or its site cannot be tried again. The URL carries
  the token in its fragment (`/login/handoff#token=…`): it is never sent to a server, logged or put in a
  `Referer`, and the page removes it from the address bar and the history before redeeming it.
- **The checks at redemption.** This site's key and `sid` (a token of another site fails the signature);
  `purpose`; the `jti` still unspent; the request's address equal to `aud`; the site active (a suspended
  site answers 503 at the gate before this); the network administrator still listed (`isNetworkAdmin(uid,
  login)`). The main site and a single site answer 404.
- **The session.** An ordinary site session (`generateToken`) with a `hof` claim `{ uid, by, from, exp }`,
  `exp` 30 minutes ahead. The JWT's own `exp` is capped at `hof.exp`, and a session minted from it
  (`/auth/refresh`) keeps the claim and the cap. Every verifier of a session (`authenticate`,
  `optionalAuth`, the collaboration stream) asks `handoffSessionRefusal`: a `hof` session authenticates only
  the handoff account it names, on a site other than the main one, before its end, while the network
  administrator is still listed — removing them from the network ends their open handoffs on every site.
  `GET /auth/me` reports `handoff` and the admin shows a banner for the whole session.
- **Both audit logs.** Network: `site.handoff.issued`, `site.handoff.redeemed`, `site.handoff.refused`
  (with the reason, whenever the token verified). Site: `auth.network_handoff` (actor = the handoff account;
  detail: the network administrator's login and id, `from`, IP, end of the session).
- **Why a dedicated account, and not none.** The brief was a session that creates no permanent account.
  It does create one, per network administrator per site, because every write a session makes is
  attributed to a row of the site's `users` table — `posts.post_author`, revisions, uploads, comment
  moderation, edit locks, `audit_log.actor_id`, collaboration presence. The network administrator's own
  id is a main-site id; on this site it is whichever site user holds the same number, so acting under it
  would put their writes on that person's name. A synthetic user with no row breaks every model that
  looks the actor up (`User.findById(req.user.id)` is everywhere). An account created per handoff and
  deleted at its end would orphan or reassign whatever it wrote. One durable, clearly labelled account
  keeps every write attributable to the network administrator, on the site's own records, and adds no
  standing access: it is marked (`user_meta.network_handoff_of` = `"<id>:<login>"`, a key no request
  writes), has a random password and an `.invalid` address, is refused by the password sign-in, cannot be
  edited or have its second factor reset by the site's administrators (they may cut its sessions or delete
  it; the next handoff creates it again), and a session for it without a live `hof` claim is no session.
  A handoff session mints nothing that outlives it: no API token, agent connection, second-factor
  enrolment or profile write of its own account (`refuseHandoffSession`). The site's two-factor policy
  does not apply to the account: its person signed in on the main site under the main site's policy, and
  it cannot enrol.
- **Tests**: `backend/src/tests/multisite-handoff.test.ts` (the real app: issue, redeem, replay, another
  site and address, expiry, suspension, removal from the network, the session's end and refresh, the
  account's restrictions, both audit logs); the issue route is a row of `sudo-gate-classes.test.ts`.

## Decisions

These were product decisions, not technical ones. The owner chose the recommended answer to each
(2026-10-15); the text below is kept as the reasoning behind them.

1. **Users per site or shared across the network?** Recommended: **per site**. A tenant's users are
   that tenant's; one site's administrator never sees another site's users; a leak of one site's user
   table exposes one site. WordPress-style shared users (one account, roles on many sites) suit an
   organization running its own sites, but they put every tenant's accounts in one table and make
   "user 5" a network-wide identity, which works against the hosting use case. Shared users could be
   added later as an opt-in network directory.
2. **Who installs plugin code, and who grants?** Recommended: **only the network administrator
   installs plugins and themes; site administrators activate them and grant permissions up to a
   network-wide ceiling; one worker per (site, plugin)**. The alternative of letting tenants upload
   their own plugins is where the kernel sandbox would matter most, but it also needs review,
   quotas and abuse handling; it fits after phase 2. And: is phase 1 without plugins on the new sites
   acceptable, with plugins arriving in phase 2?
3. **Domains only, or subdirectories too?** Recommended: **domains and subdomains in phases 1–2;
   subdirectories (`example.com/site2`) later**, because they share one cookie jar and one origin
   between tenants (weaker isolation for the browser: cookies, storage, service workers), and they need
   path-prefixed routing through the frontend, the gateway and every generated link.

Also confirm the tenancy model itself (one database per site). It is a technical recommendation with a
product consequence: on Postgres/MySQL the hosting account must allow one database per site.

## Alternatives considered

**`site_id` column on every table** (the "shared schema" model). Rejected: every one of ~370 core
statements, every unique index (`options.option_name`, `users.user_login`, `posts(post_name,
post_type)`) and every plugin's own tables need the filter or the key part; plugin authors would have to
write it too, which contradicts the promise that plugins written for one site are safe on a host; and
the failure mode of one missing `WHERE site_id = ?` is a silent cross-tenant leak.

**Per-site table prefix** (WordPress multisite: `wp_2_posts`). Rejected: needs either rewriting every
core table name in ~35 files or rewriting SQL in the drivers, and SQLite has no rewrite layer and the
plugin validator is a lexer, not a parser; the plugin prefix (`wjp_<slug>_`), its registry and the
database principals' `LIKE prefix%` grants would change shape; and the failure mode of a forgotten
prefix is a query against the main site's tables, WordPress's long-running bug class. It has one real
advantage (one connection), which matters less than isolation for this market.

**Postgres schema per site** (one database, `search_path` per connection). Kept for phase 3 in the
first plan, because the driver assumed the `public` schema in introspection and grants and `search_path`
had to be set reliably on every checkout. **Chosen as built**: the driver's introspection and grants now
read `current_schema()`, and `search_path` is a startup parameter of each site's pool (it cannot be lost
by a pooled connection). It needs only `CREATE` on one database where a database per site needs
`CREATEDB`, which managed Postgres plans often withhold, and it keeps one database to back up and one
connection limit to plan. MySQL's "database" is the same thing as a Postgres schema, so both engines
follow the same shape.

**Process or container per site.** What hosters do today without multisite. It gives the strongest
isolation but none of the shared-install benefits (one upgrade, one plugin install, one admin). The
recommended model keeps that door open: a site is a database plus an uploads directory, so moving a
site to its own install later is an export of both.
