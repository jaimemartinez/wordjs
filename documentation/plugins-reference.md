# Plugins Reference 🔌

This document lists the official plugins available in the WordJS ecosystem and their capabilities.

> **Every plugin runs isolated.** All feature plugins below run in a **separate OS process**
> (`child_process.fork` of `plugin-worker.js`, with a `worker_threads` fallback) and reach
> core only through the `wordjs` capability bridge — RPC'd to the host over IPC (v8 structured
> clone) and permission-checked **on the host** in the plugin's context. A crash, OOM, or heap
> escape is contained to the child; the host process (secrets, DB handle, other plugins)
> survives and is unreachable from the child. See **[Plugin Isolation](plugin-isolation-proposal.md)**
> and the **[wordjs Bridge API Reference](#0-the-wordjs-bridge-api-reference)** below.
> A plugin is either **untrusted** (sandboxed — own DB tables, non-secret options, namespaced routes,
> no outbound network) or **operator-trusted** (privileged — unscoped DB, secret options, absolute
> routes, mail provider, raw sockets). Trust is server-side only: it comes from `config.trustedSystemPlugins`
> (shipped defaults: `conference-manager`, `mail-server`) **or** an admin toggle in the Plugins UI
> (persisted in the `trusted_plugins` option). A plugin can never self-declare trust.

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
    flow through their OWN IPC kinds (NOT through `call`), each with its own caps and trust checks. They
    are deliberately absent from `ALLOWED_BRIDGE_METHODS`.

### Data / call methods (`kind:'call'`, gated by `ALLOWED_BRIDGE_METHODS`)

| `wordjs` member | Bridge method | Notes |
| --- | --- | --- |
| `options.get(key, default)` | `options.get` | Secret-named/protected options are scrubbed for untrusted plugins. |
| `options.set(key, value)` | `options.set` | Protected options (incl. `trusted_plugins`) are write-blocked for untrusted. |
| `db.all(sql, params)` | `db.all` | Untrusted: confined to `wjp_<slug>_` tables; ATTACH/PRAGMA/schema-catalog/stacked/comma-join/USING/RETURNING rejected. |
| `db.get(sql, params)` | `db.get` | Same scoping as `db.all`. |
| `db.run(sql, params)` | `db.run` | Same scoping. |
| `db.createTable(name, cols)` | `db.createTable` | Creates a `wjp_<slug>_`-prefixed table. |
| `db.getType()` | `db.getType` | Returns the driver type; used by trusted plugins for dialect branches. |
| `db.tablePrefix` | (local) | A string property (`wjp_<slug>_`), not an RPC — the required prefix for the plugin's own tables. |
| `hooks.doAction(hook, ...args)` | `hooks.doAction` | Fire a core action from the plugin. |
| `fs.read(path, enc)` | `fs.read` | Confined to the plugin dir; `.env`/secret files and the DB files are blocked. |
| `fs.write(path, data)` | `fs.write` | Same confinement, plus per-write size cap + per-plugin disk quota. |
| `mail(msg)` | `mail` | Send through the host-wide mail sender. |
| `notify(notification)` | `notify` | Dispatch a core notification. |
| `adminMenu.add(item)` | `adminMenu.add` | Add a Sidebar item (capped per plugin). |
| `cron.schedule(ts, recurring, hook, args)` | `cron.schedule` | Schedule a recurring/one-shot hook fire. |
| `slug` | (local) | The plugin's slug string. |

### Registration methods (dedicated IPC kinds — NOT in the call allowlist)

| `wordjs` member | IPC kind | Trust / caps |
| --- | --- | --- |
| `hooks.addAction(hook, cb, priority)` / `hooks.addFilter(...)` | `register` | Untrusted denied on raw-HTML hooks (`wordjs_head`/`wordjs_footer`/`wp_head`/`wp_footer`); capped per-plugin (`MAX_HOOKS`) and per-hook-name (`MAX_PER_HOOK`); each shim runs with a 2 s timeout. |
| `http.route(method, routePath, opts, handler)` | `register-route` | HTTP verb allowlisted; `opts.auth`/`opts.admin` apply real middleware; `opts.multipart` parsed host-side (10 MB cap). Untrusted: namespaced under `/api/v1/plugin/<slug>`, auth/session cookies stripped, Set-Cookie/CSP/HSTS/Location dropped, plugin cookies namespaced + path-confined. `opts.absolute` (original path) is trusted-only. |
| `shortcodes.add(tag, handler)` | `register-shortcode` | Capped per-plugin; handler resolves HTML over RPC (`doShortcodeAsync`). |
| `provideMail(handler)` | `register-mail-provider` | **Operator-trusted only** — becomes the host-wide mail sender. |
| `notify.registerTransport(name, handler)` | `register-notify-transport` | **Operator-trusted only** — registers a core notification transport. |

All registrations are tracked and torn down on unload/reload. RPCs have a timeout and a wedged child is
recycled; per-child bridge-call and global IPC message rates are token-bucket capped, with inbound/outbound
payload caps.

## 1. Photo Carousel 📸
**ID:** `photo-carousel` | **Version:** 2.0.0

Manages image carousels for Hero sections or content sliders.

*   **Shortcode:** `[carousel id="123"]` (async — expanded via `doShortcodeAsync`)
*   **Puck Component:** `HeroCarousel`
*   **Permissions:** `settings` (read/write), `database` (write).
*   **Tier:** Untrusted (isolated). Routes namespaced under `/api/v1/plugin/photo-carousel/*`.

---

## 2. Card Gallery 🃏
**ID:** `card-gallery` | **Version:** 1.0.0

Displays event or promo cards in a zigzag or grid layout.

*   **Shortcode:** `[cards]`
*   **Puck Component:** `CardGalleryPuck` (PromoCards)
*   **Permissions:** `settings` (read/write), `database` (write).
*   **Tier:** Untrusted (isolated). Routes namespaced under `/api/v1/plugin/card-gallery/*`.

---

## 3. Video Gallery 🎬
**ID:** `video-gallery` | **Version:** 1.0.0

Manages YouTube video carousels.

*   **Shortcode:** `[vgallery]`
*   **Permissions:** `settings` (read/write), `database` (write).
*   **Tier:** Untrusted (isolated). Routes namespaced under `/api/v1/plugin/video-gallery/*`.

---

## 4. Mail Server 📧
**ID:** `mail-server` | **Version:** 1.0.0

A complete SMTP server and email manager. Allows sending and receiving emails directly within WordJS.

*   **Features:**
    *   SMTP Server on port 25 + direct-MX outbound delivery (runs inside the child process)
    *   Attachment handling (multipart upload parsed by the host, forwarded to the isolate)
    *   DKIM signing (private key read from a secret-named option)
    *   Registers the host-wide mail sender (`provideMail`) and a notification transport
*   **Permissions:** `email` (admin), `filesystem` (read/write), `notifications` (send).
*   **Tier:** Operator-trusted (shipped default in `config.trustedSystemPlugins`). Isolated, but the trusted
    bridge tier grants it raw sockets, secret options, `provideMail`, `notify.registerTransport`, and absolute routes.

---

## 5. Conference Manager 🎟️
**ID:** `conference-manager` | **Version:** 1.0.0

Complex business logic for managing church conferences.

*   **Features:**
    *   Inscription/Registration management
    *   Hotel & Room assignment
    *   Payment tracking
*   **Permissions:** `database` (read/write), `express` (register_route).
*   **Tier:** Operator-trusted (shipped default in `config.trustedSystemPlugins`). Isolated, with the trusted
    bridge tier for unscoped DB access, `db.getType()`, and absolute routes (portal cookies). Listing in
    `trustedSystemPlugins` is what authorizes its `system:admin` AST-scan skip — declaring `system:admin`
    alone is never sufficient for an uploaded plugin.

---

## 6. Database Migration 🚚 — now in core (no longer a plugin)
**Location:** `backend/src/core/db-admin/` | Admin UI: `/admin/db-migration` (permanent core Sidebar item)

Database administration (migrate data between SQLite and PostgreSQL, manage the embedded PostgreSQL
server process, run schema migrations at boot) is **no longer a plugin**. It was de-pluginized because
it is database infrastructure, not a feature plugin: it manages the database server itself (via
`child_process`) and must run at boot. It moved into core (`backend/src/core/db-admin/`, routes still
`/api/v1/db-migration/*`) and its admin UI is a native frontend route reached from a permanent **core**
Sidebar item — not a toggleable plugin. It is gone from `plugins/` and all generated registries, and is
**not** in `config.trustedSystemPlugins`. See **[Database](database.md)**.

---

## 7. Hello World 👋
**ID:** `hello-world` | **Version:** 1.0.0

A reference implementation for developers. Hooks-only (registers an `the_content` filter via the
bridge) and demonstrates the plugin test framework.

*   **Purpose:** Development / Education.
*   **Tier:** Untrusted (isolated).

---

## 8. Test Schema 🧪
**ID:** `test-schema` | **Version:** 1.0.0

Reference plugin for hooks + DB access through the bridge (`wordjs.db.createTable` / `db.run`).

*   **Purpose:** Development / Education.
*   **Tier:** Untrusted (isolated).
