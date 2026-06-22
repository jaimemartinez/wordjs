# Plugins Reference 🔌

This document lists the official plugins available in the WordJS ecosystem and their capabilities.

> **Every plugin runs isolated.** All feature plugins below run in a **separate OS process**
> (`child_process.fork` of `plugin-worker.js`, with a `worker_threads` fallback) and reach
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
> unresolvable hosts (fail-closed). First-party plugins are **pre-granted** their declared capabilities
> but are **not privileged** — no plugin bypasses the sandbox. (The old trusted tier and its bypass
> machinery were removed.) **Every plugin — bundled ones included — is AST-scanned on activation,
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
| `db.getType()` | `db.getType` | Returns the driver type for dialect branches. |
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
*   **Puck Component:** `HeroCarousel`
*   **Permissions:** `settings` (read/write), `database` (write).
*   **Sandbox:** isolated (like every plugin). Routes namespaced under `/api/v1/plugin/photo-carousel/*`. Pre-granted its declared `settings`/`database` capabilities.

---

## 2. Card Gallery 🃏
**ID:** `card-gallery` | **Version:** 1.0.0

Displays event or promo cards in a zigzag or grid layout.

*   **Rendering:** via the `PromoCards` / `CardGalleryPuck` frontend component (no shortcode is registered at runtime — `index.js` calls no `shortcodes.add`).
*   **Puck Component:** `CardGalleryPuck` (PromoCards)
*   **Permissions:** `settings` (read/write), `database` (write).
*   **Sandbox:** isolated (like every plugin). Routes namespaced under `/api/v1/plugin/card-gallery/*`. Pre-granted its declared `settings`/`database` capabilities.

---

## 3. Video Gallery 🎬
**ID:** `video-gallery` | **Version:** 1.0.0

Manages YouTube video carousels.

*   **Shortcode:** `[vgallery]`
*   **Permissions:** `settings` (read/write), `database` (write).
*   **Sandbox:** isolated (like every plugin). Routes namespaced under `/api/v1/plugin/video-gallery/*`. Pre-granted its declared `settings`/`database` capabilities.

---

## 4. Mail Server 📧
**ID:** `mail-server` | **Version:** 2.0.0

A complete SMTP server and email manager. Allows sending and receiving emails directly within WordJS.

*   **Features:**
    *   SMTP Server on port 25 + direct-MX outbound delivery (runs inside the child process)
    *   Attachment handling (multipart upload parsed by the host, forwarded to the isolate)
    *   DKIM signing (private key stored in the plugin's own DB/files, not a core secret option)
    *   Registers the host-wide mail sender (`provideMail`) and a notification transport
*   **Requested capabilities:** `settings` (read/write — non-secret SMTP/display options + the safe `site` bridge), `database` (read/write — its own `wjp_mail_server_*` tables), `email` (admin + provider), `notifications` (send/provider), `filesystem` (read/write), `users` (read — resolves local recipients via the safe users projection, never password hashes), `network` (for SMTP / outbound MX).
*   **Egress:** because it holds the `network` grant, its outbound connections are validated at connect
    time against the egress guard — direct-MX delivery is **IP-pinned** into nodemailer and only public
    IPs are reachable (loopback/RFC1918/link-local/metadata blocked). An **operator-configured
    relay/smarthost is exempt** from the public-only pin, so an internal/LAN smarthost works; `requireTLS`
    defaults ON but is opt-out via the `mail_relay_require_tls` option for a TLS-less internal relay.
*   **Sandbox:** isolated, like every plugin — no trust bypass. It is **pre-granted** the capabilities it
    declares (`network` for raw sockets, `email:provider`, `notifications:provider`, `filesystem`, etc.), so it
    works out of the box, but it runs under the same default-deny grant checks and OS-process isolation as
    anything uploaded. An admin can revoke any of its grants in `/admin/plugins`.

---

## 5. Conference Manager 🎟️
**ID:** `conference-manager` | **Version:** 2.0.0

Complex business logic for managing church conferences.

*   **Features:**
    *   Inscription/Registration management
    *   Hotel & Room assignment
    *   Payment tracking
*   **Requested capabilities:** `database` (read/write — its own `wjp_conference_manager_` tables), `express` (register_route — namespaced routes), `admin_menu` (register — sidebar item).
*   **Sandbox:** isolated, like every plugin — no trust bypass. Pre-granted its declared capabilities. It
    stores its data in its own prefixed tables (no unscoped/core-table access — that capability no longer
    exists) and uses `db.getType()` for dialect branches. Routes are namespaced under
    `/api/v1/plugin/conference-manager/*` (absolute routes were removed). The AST scanner runs on it like
    every plugin; there is no scan-skip.

---

## 6. Database Migration 🚚 — now in core (no longer a plugin)
**Location:** `backend/src/core/db-admin/` | Admin UI: `/admin/db-migration` (permanent core Sidebar item)

Database administration (migrate data between SQLite and PostgreSQL, manage the embedded PostgreSQL
server process, run schema migrations at boot) is **no longer a plugin**. It was de-pluginized because
it is database infrastructure, not a feature plugin: it manages the database server itself (via
`child_process`) and must run at boot. It moved into core (`backend/src/core/db-admin/`, routes still
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
