# Plugins Reference 🔌

This document lists the official plugins available in the WordJS ecosystem and their capabilities.

> **Every plugin runs isolated.** All feature plugins below run in a **separate OS process**
> (`child_process.fork` of `plugin-worker.js`) and reach
> core only through the `wordjs` capability bridge — RPC'd to the host over IPC (v8 structured
> clone) and permission-checked **on the host** in the plugin's context. A crash, OOM, or heap
> escape is contained to the child; the host process (secrets, DB handle, other plugins)
> survives and is unreachable from the child. See **[Plugin Isolation](archive/plugin-isolation-proposal.md)**
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
> default-deny (only the listed hosts + their subdomains; `dns.lookup`/`lookupService` included; under a
> list only a plain ASCII hostname or an IP literal can match, so a NUL- or IDNA-spelled host is refused).
> An unloaded policy (`egressDenyAll`) denies every public host and every lookup at every chokepoint. Bundled (first-party) plugins are **not privileged** — no plugin
> bypasses the sandbox. Nothing is granted out of the box: **activation** grants a plugin exactly the
> capabilities its manifest *declares* (the admin approves them in the activation dialog, only if the
> plugin holds no grants an administrator decided: no grant record, or an empty one no administrator
> decided, such as the one an in-place update stores for a plugin that had none), and the admin can
> refine or revoke every grant afterward in
> `/admin/plugins`. (A boot backfill, run at every boot, grants an *active* plugin that has no grant record
> what its manifest declares — how plugins already active before the default-deny model landed were
> grandfathered; it never replaces a stored record, and fresh activations get their declared set and
> nothing more.) (The old
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
| `db.createTable(name, cols)` | `db.createTable` | `database:write` grant. Creates the table (`CREATE TABLE IF NOT EXISTS`) and records this plugin as its authoritative creator. It does **not** add the prefix: `name` must already start with `db.tablePrefix`, or the call throws. |
| `db.getType()` | `db.getType` | `database:read` grant. Returns `{ isPostgres, isMySQL, isSQLite, driver }` for dialect branches (`driver` ∈ `sqlite-native`/`sqlite-legacy`/`postgres`/`mysql`/`mariadb`; `isSQLite` stays true under MySQL, so gate `PRAGMA`/`sqlite_master` on `isMySQL` — MariaDB reports `driver: 'mariadb'` but `isMySQL` is true, so branch on `isMySQL` not the raw `driver` string). |
| `users.findByEmail / findByLogin / findById / search` | `users.*` | `users:read` grant. Returns a **safe projection** `{id, userLogin, username, userEmail, displayName, role, pluginCapabilities, accountCapabilities}` — never `user_pass`. (`pluginCapabilities` is the account's capabilities in the plugin's own namespace — [plugins.md §12a](plugins.md#12a-declaring-user-roles-rolesdeclare-); `accountCapabilities` is the account's admin-owned grants among the capabilities the plugin declares — [plugins.md §12b](plugins.md#12b-declaring-per-account-capabilities-accountcapabilities-). Read them, never re-derive a grant from `userEmail`.) |
| `site.url / domain / adminEmail / registrationOpen` | `site.*` | `settings:read` grant. Read-only site identity; `registrationOpen()` says whether visitors may create an account (the `users_can_register` option itself is protected). |
| `media.getPrivate(id)` | `media.getPrivate` | **`media:private_read` grant** (default-deny; not implied by `admin`). Path-free description `{id, title, mimeType, filesize, filename}` of a **private** media item, or `null` for anything that is not one. The bytes are delivered with `res.sendPrivateMedia` (below), never through this call. |
| `dns.resolveMx / resolveTxt / resolve4 / resolve6 / resolve` | `dns.*` | **`network` grant.** Host-mediated record lookups — the raw c-ares surface (`dns.resolve*`) is denied inside the isolate, so an MTA reaches MX (direct delivery) and TXT (SPF/DKIM/DMARC) through here. The host runs the query and STRIPS every A/AAAA answer pointing at a private/internal/special address, so `resolve4`/`resolve6`/`resolve` return public addresses only (a domain resolving solely to internal IPs comes back empty). Every method also checks the NAME being resolved against the plugin's egress allowlist (an empty list allows every public name; an unloaded policy refuses every name), because a lookup is itself egress; a name containing a control character is refused in every state (c-ares stops at a NUL, so the allowlist would judge a different name from the one queried). |
| `db.tablePrefix` | (local) | A string property (`wjp_<slug>_`), not an RPC — the required prefix for the plugin's own tables. |
| `hooks.doAction(hook, ...args)` | `hooks.doAction` | Fire an action — but only the plugin's OWN registered callbacks run (`doActionForPlugin`), never core or another plugin's handlers. |
| `fs.read(path, enc)` | `fs.read` | `filesystem:read` grant. Confined to the plugin's OWN dir (never the shared `uploads/`); `.env`/secret files and the DB files are blocked. |
| `fs.write(path, data)` | `fs.write` | `filesystem:write` grant. Same confinement, plus a 16 MB per-write cap and a 100 MB per-plugin disk quota; `manifest.json` is immutable. |
| `mail(msg)` | `mail` | `email:admin` grant. Send through the host-wide mail sender. A `priority` field is removed: it is the core's mark for its own account mail (password reset, address verification), which a provider that paces its queue sends ahead of the rest. |
| `notify(notification)` | `notify` | `notifications:send` grant. Dispatch a core notification. |
| `ai.complete(request)` | `ai.complete` | `ai:use` grant. Text completion through the site's AI provider (`ai-provider.md` §4). |
| `adminMenu.add(item)` | `adminMenu.add` | `admin_menu:register` grant (an explicit, admin-granted verb — `access: "admin"` does not imply it). Adds a sidebar item; `labels: { en, es, pt, … }` (optional, language tag → text, ≤ 200 chars each) gives its text per admin language — the sidebar uses the admin's language, then its base language, then `label`. Capped at 50 items per plugin, and `href` must be a same-origin relative admin path (single leading `/`, no scheme, no `//`) or the item is dropped with a warning. |
| `cron.schedule(ts, recurring, hook, args)` | `cron.schedule` | Schedule a recurring/one-shot hook fire. |
| `crypto.randomToken(bytes=16)` / `crypto.randomInt(min, max)` | `crypto.randomToken` / `crypto.randomInt` | CSPRNG helpers (no data access, no permission gate) — use instead of `Math.random` for tokens/access codes. **Async** in an isolated plugin (RPC to host), so `await` them. |
| `posts.get(id)` | `posts.get` | **`posts:read`**. A PUBLISHED, public, unprotected entry (`{ id, title, path, url, authorId, excerpt, content, accessLevel, meta }`) or `null`. `content` is the full body and `accessLevel` the level it requires: withhold the gated part yourself from recipients without it. See [memberships.md §4](memberships.md#4-post-editor-fields-and-the-posts-bridge-generic). |
| `crypto.hmac(algorithm, key, data, encoding='hex')` / `crypto.hash(algorithm, data, encoding='hex')` / `crypto.timingSafeEqual(a, b)` | `crypto.hmac` / `crypto.hash` / `crypto.timingSafeEqual` | Keyed hashing for webhook signatures and unkeyed digests for checksums (`sha256`/`sha1`/`sha512`, hex or base64, data ≤ 2 MB), and constant-time string comparison. No data access, no permission gate; **async** in an isolated plugin. See [memberships.md §3](memberships.md#3-plugin-webhook-routes-and-the-hmac-bridge-generic). |
| `assets.enqueueScript(spec)` / `assets.enqueueStyle(spec)` | `assets.enqueueScript` / `assets.enqueueStyle` | `assets:write` grant. Enqueue a `<script>`/`<style>` onto public pages; the host emits a **sanitized** tag. `src` must resolve **inside your plugin's `public/` directory** with a servable extension — that directory is the only part of the plugin tree published at `/plugins/<slug>/` (besides the Verso block stylesheet `dist/component.bundle.css`), it is served **only while the plugin is active** (a script — `.js`/`.mjs`/`.cjs` — additionally only while it is granted **`browser:script`**, like the `dist/` bundles), and it is **read-only to the plugin** (`documentation/plugins.md` §11a). Any other `src` throws. |
| `slug` | (local) | The plugin's slug string (its folder name). |
| `paths.data` / `paths.logs` / `paths.tmp` | (local) | Frozen absolute paths of the plugin's private storage directories (`backend/data/plugins/<key>`, `backend/logs/plugins/<key>`, `backend/os-tmp/plugins/<key>`), created when it holds a `filesystem` grant; raw `fs` use of them still needs `filesystem:read`/`write`. |

### Registration methods (dedicated IPC kinds — NOT in the call allowlist)

| `wordjs` member | IPC kind | Host-side gate (a capability here means manifest-declared AND admin-granted) |
| --- | --- | --- |
| `hooks.addAction(hook, cb, priority)` / `hooks.addFilter(...)` | `register` | Hook access policy (`core/hook-access.ts`): raw-HTML hooks (`wordjs_head`/`wordjs_footer`/`wp_head`/`wp_footer`/`dynamic_sidebar`), host-only hooks and unclassified core-namespace names denied to **every** plugin; data hooks need the matching grant (`comments:read`, `posts:read`, `notifications:read`, `settings:read`) and every delivery is re-checked and minimized (commenter email/IP/agent only with `comments:pii`; no post passwords, notification tokens or protected option values); capped per-plugin (`MAX_HOOKS`) and per-hook-name (`MAX_PER_HOOK`); each shim runs with a 2 s timeout. |
| `http.route(method, routePath, opts, handler)` | `register-route` | **`express:register_route` grant** — checked first (default-deny; not implied by `admin`); without it the registration is logged and dropped (no route is mounted). Then: per-plugin route cap (`MAX_ROUTES`); HTTP verb allowlisted (`get/post/put/patch/delete/options/head/all`); `routePath` restricted to static segments, `:params` and at most two `*` wildcards (≤ 200 chars, no regex metacharacters, `::` or `..`); `opts.auth`/`opts.admin` apply the real `authenticate`/`isAdmin` middleware, and the handler's `req.user` is `{ id, role, userEmail, userLogin, pluginCapabilities, accountCapabilities }` (`pluginCapabilities`: the caller's capabilities in the plugin's own namespace — [plugins.md §12a](plugins.md#12a-declaring-user-roles-rolesdeclare-); `accountCapabilities`: the caller's admin-owned grants among the plugin's declared ones — [plugins.md §12b](plugins.md#12b-declaring-per-account-capabilities-accountcapabilities-)); `opts.multipart` parsed host-side by multer (single file, `fileSize` capped at `config.uploads.maxFileSize` — the site's configured `maxFileSize`, 10 MB by default; staged in the plugin's own private tmp storage `os-tmp/plugins/<key>/uploads/`, which the plugin may READ without a `filesystem` grant, and unlinked when the response finishes — copy it during the request to keep it). Always namespaced under `/api/v1/plugin/<slug>`, auth/session cookies stripped, Set-Cookie/CSP/HSTS/Location dropped, plugin cookies namespaced + path-confined. (No absolute-path mode.) The handler may reply with `res.sendPrivateMedia(mediaId, { filename })`: with the **`media:private_read` grant** the host streams that PRIVATE media item itself (`Content-Disposition: attachment`, nosniff, sandbox CSP, `Cache-Control: private, no-store`; plugin headers ignored; 404 for anything that is not a private attachment), without it the reply is `403`. File bytes never cross the IPC channel. A plugin route sits behind the global CSRF gate like every other API route: a cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE` must carry an `X-CSRF-Token` header equal to the caller's `wjs_csrf` cookie or it is refused with `403 rest_csrf_token`; `Bearer` callers are exempt. **`opts.webhook: true`** (POST only) marks a signed server-to-server webhook: it is exempt from the CSRF gate and the handler gets `req.rawBody` (the exact bytes) plus the provider's signature headers (names containing `signature` or `checksum`, and `x-request-id`, `webhook-id`, `webhook-timestamp`, `content-type`) — and never an identity (`req.user` is `null`, no cookies; combining it with `auth`/`admin`/`multipart` is refused). Verify the sender with `crypto.hmac` (or `crypto.hash` for a checksum) + `crypto.timingSafeEqual` ([memberships.md §3](memberships.md#3-plugin-webhook-routes-and-the-hmac-bridge-generic)). |
| `shortcodes.add(tag, handler)` | `register-shortcode` | Capped per-plugin; handler resolves HTML over RPC (`doShortcodeAsync`). |
| `widgets.register(id, def)` | `register-widget` | Capped at 50 per plugin; the renderer resolves HTML over RPC (2 s cap), sanitized on the host; an id core or another plugin holds is refused. |
| `graphql.extend({ typeDefs, fields })` | `register-graphql` | Declarative only: the host builds each `Query.<field>` resolver (`core/graphql/plugin-bridge`) and resolves it through the plugin's own GET route as the GraphQL caller; at most 5 extensions / 50 fields; the usual extension rules (no rerouting an existing field). |
| `provideMail(handler)` | `register-mail-provider` | `email:provider` grant (administrator-level) — becomes the host-wide mail sender (sandboxed). Account email (reset and verification links) reaches it only when an administrator allows the plugin by name (`core/account-mail`). |
| `notify.registerTransport(name, handler)` | `register-notify-transport` | `notifications:provider` grant (administrator-level) — registers a core notification transport that receives the full content it delivers (sandboxed). |
| `smtp.listen(handlers, opts)` / `smtp.status()` | `register-smtp-listener` / `smtp-status` (host → child `invoke-smtp`) | `smtp:inbound` grant — EXCLUSIVE (one plugin at a time); the host opens the plugin's `claimPorts` SMTP port (core/inbound-smtp.ts) and asks the plugin for a verdict at each step; a plugin error or a 25 s timeout answers the sender a temporary 451. |

All registrations are tracked and torn down on unload/reload (routes are unmounted by matching the HANDLER
the host installed, never the registration verb — `app.all()` expands to every method, so a verb match
missed them). RPCs have a 30 s timeout and a wedged child is recycled; an RPC to a child that is already
gone **fails fast** ("… is not running") instead of waiting the timeout out. Per-child bridge-call and
global IPC message rates are token-bucket capped, with inbound/outbound payload caps.

## 1. Photo Carousel 📸
**ID:** `photo-carousel` | **Version:** 2.1.0

Manages image carousels for Hero sections or content sliders.

*   **Shortcode:** `[carousel id="123"]` (async — expanded via `doShortcodeAsync`). Since 2.1.0 it renders plain markup on the core's `wjs-snap-strip` classes (a swipeable, scroll-snapping row from `wordjs-ui.css`) so it survives the HTML sanitizer and needs no script; autoplay and arrow buttons are only on the Verso block.
*   **Verso block:** `client/verso/PhotoCarouselVerso.tsx` (registry key `PhotoCarousel`; renders the `HeroCarousel` location component internally)
*   **Permissions:** `settings` (read/write), `database` (write), `express` (register_route), `admin_menu` (register).
*   **Sandbox:** isolated (like every plugin). Routes namespaced under `/api/v1/plugin/photo-carousel/*`. Default-deny: an admin grants its declared capabilities in `/admin/plugins`.

---

## 2. Card Gallery 🃏
**ID:** `card-gallery` | **Version:** 1.0.1

Displays event or promo cards as a full-width stack whose content alternates left/right by index (the
"zigzag"). There is no grid mode — the block's only fields are the gallery to show and an optional
anchor id.

*   **Rendering:** via the block itself (no shortcode is registered at runtime — `index.js` calls no `shortcodes.add`). `client/components/PromoCards.tsx` is the separate legacy *location* component declared in `frontend.components[]`; the block does not import it.
*   **Verso block:** `client/verso/CardGalleryVerso.tsx` (registry key `CardGallery`), self-contained — it embeds its own `.promo-card*` CSS.
*   **Permissions:** `settings` (read/write), `database` (write), `express` (register_route), `admin_menu` (register).
*   **Sandbox:** isolated (like every plugin). Routes namespaced under `/api/v1/plugin/card-gallery/*`. Default-deny: an admin grants its declared capabilities in `/admin/plugins`.

---

## 3. Video Gallery 🎬
**ID:** `video-gallery` | **Version:** 1.0.1

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
**ID:** `mail-server` | **Version:** 3.0.1

A complete SMTP server and email manager. Allows sending and receiving emails directly within WordJS.

*   **Features:**
    *   Inbound SMTP through the **host listener**: with the exclusive `smtp:inbound` grant, WordJS itself
        listens on the port the manifest's `claimPorts: [25]` declares (`core/inbound-smtp.ts`; falling back
        to 2525, with the reason, when 25 cannot be bound) and asks the plugin for a verdict at each SMTP
        step. Without that grant the plugin falls back to its own `smtp-server` listener
        (`smtp_listen_port`, default 25, then 2525) — which works only where the platform lets an isolated
        plugin listen: on Linux the plugin sandbox's seccomp filter refuses it on every port.
    *   Direct-MX outbound delivery (connects to remote MTAs on port 25) from the child process
    *   Attachment handling (multipart upload parsed by the host, forwarded to the isolate)
    *   DKIM signing (private key stored in the plugin's own DB/files, not a core secret option)
    *   Registers the host-wide mail sender (`provideMail`) and a notification transport
    *   Ships an admin page (`/admin/plugin/emails`) and a frontend hooks file
        (`client/UserFormExtension.tsx`: the "Professional Mail Account" toggle on the core user form)
*   **Requested capabilities:** `browser:script` (its admin page and hooks bundle), `settings` (read/write — non-secret SMTP/display options + the safe `site` bridge), `database` (read/write — its own `wjp_mail_server_*` tables), `email` (admin + provider), `notifications` (send/provider), `filesystem` (read/write), `users` (read — resolves local recipients via the safe users projection, never password hashes), `network` (outbound MX / relay and the DNS bridge), `smtp:inbound` (the host listener above), `express` (register_route), `admin_menu` (register).
*   **Egress:** because it holds the `network` grant, its outbound connections are validated at connect
    time against the egress guard — direct-MX delivery is **IP-pinned** into nodemailer and only public
    IPs are reachable (loopback/RFC1918/link-local/metadata blocked). An **operator-configured
    relay/smarthost is exempt** from the public-only pin, so an internal/LAN smarthost works; `requireTLS`
    defaults ON but is opt-out via the `mail_relay_require_tls` option for a TLS-less internal relay.
*   **Sandbox:** isolated, like every plugin — no trust bypass. It runs under the same **default-deny**
    grant checks and OS-process isolation as anything uploaded: **activating** it grants exactly the
    capabilities it declares (`network` for outbound sockets, `smtp:inbound`, `email:provider`,
    `notifications:provider`, `filesystem`, etc.), which the admin sees in the activation dialog and can refine or revoke in
    `/admin/plugins`. It is not privileged and can be fully de-fanged by revoking those grants.

---

## 5. Conference Manager 🎟️
**ID:** `conference-manager` | **Version:** 2.33.1

Complex business logic for managing church conferences.

*   **Features:**
    *   Inscription/Registration management: admin CRUD plus a **dynamic registration form** whose fields are
        defined per conference (schema-follows-form — each field is a real column on the inscriptions table,
        with `required`/`unique` flags). Dynamic values are canonicalised server-side (`"0030"` → `"30"`), so the
        admin form and the coordinator portal store the same representation. A new conference starts with
        **no field** (and no assignment rule); the base fields — Nombre, Apellido, Email, Teléfono, Género, Grupo
        familiar, Requiere hospedaje — are **templates** (`POST /fields { conference_id, template, label? }`) created with the
        exact column, type, options and role the other features read (`409 field_exists` for a second copy).
        «Requiere hospedaje» (2.31.0, template `lodging`, column `needs_lodging`) is a `switch` field stored as
        `Sí` / `No`: an attendee who answers «No» is left out of every automatic assignment (admin run, a
        location's run, «Sugerir reparto»), is not counted as «sin habitación», and `POST /inscriptions/:id/assign`
        and `POST /portal/lodging/assign` refuse to place them (400); switching an attendee to «No» frees the bed
        they held. A blank answer, or a form without the field, means the attendee needs lodging.
        «Edad» (2.32.0, template `age`, column `age`) is a `number` field that accepts whole years from 0 to 120.
        «Condiciones de salud» (2.32.0, template `health`, type `health`) is a multiple-choice field: the
        conditions in its options, «Otros» with free text, and «Ninguna» / «Prefiero no responder». Its value is
        `{ conditions: string[], other: string, answer: 'list' | 'none' | 'declined' }`, or `null` to clear it.
        This is special-category health data, so it is handled apart from the other fields. The answers live in
        their own table and never in a column of the inscriptions table. The field's name is reserved, so no
        list, export, badge, meals card, rule or quote reads it. Only the staff section «Datos de salud» opens
        it: `health:view` adds the answer as text to roster rows and to the CSV/Excel export, and reads
        `GET /inscriptions/:id/health`; `health:manage` writes it from the admin (403 otherwise). A coordinator
        answers it while registering in the portal, which never reads an answer back. The form shows a consent
        line, and errors appear under the field. Deleting the field, or the person, deletes the answers. A
        price rule on it is refused.
        Every field can be edited and deleted while the form is unpublished (a published form stays locked),
        and every feature works without the base fields: names fall back to the other form fields fit for a
        name — never a unique field (an ID document), a contact (email, phone) or notes — or the attendee's
        number (everywhere: admin lists, exports, meals, the portal's `display_name`); a price rule or an
        assignment rule on a deleted field is skipped (a new assignment rule on it is refused); the lodging
        gender hints, the portal's gender and the gender report need a «Género» field (column `gender`). The
        location is not a form field (the portal login sets it; the admin picks it from Localidades), and
        rules on it keep applying. A form with no field cannot be published (`400 form_empty`). On a phone
        the field list's actions are visible without hover, with ↑ / ↓ to reorder (drag and drop needs a
        mouse).
    *   **Meal turns** («Alimentación › Turnos», 2.32.0): every participant gets a meal group A–F. The
        priority score is `S = min(100, E(age) + H)`. `E` is 40 for ages 0–2, 30 for 3–5, 15 for 6–11, 20 for
        60–69, 35 for 70–79 and 50 for 80 or more. `H = min(60, w1 + w2/2 + w3/4 …)`, where each condition's
        weight is editable per conference and «Prefiero no responder» counts 0. Sex never counts on its own:
        «Embarazo» and «Lactancia» are conditions the person marks. The six groups have nearly the same size:
        units (a family with at most `companions_max` companions per priority member, default 4; everyone else
        alone) are sorted by score, ties broken by a stable hash, and a unit at position `s` with `z` people out
        of `N` goes to group `⌊6 (s + z/2) / N⌋`. Each service calls the groups in order; the trailing groups
        made only of people with 0 points alternate day by day. A group lasts `n / (0.85 · lines · plates per
        minute)` minutes, where `n` is the people of the group entitled to that service. «Fijar grupos»
        (`POST /meals/priority/freeze`) stores every letter so printed badges stay right; a later registrant
        joins the smallest group whose stored scores span theirs. `PUT /meals/priority/people/:id { group }`
        sets a manual group (kept by every recalculation). `GET /meals/priority` returns letters, counts and
        times to `meals:view`, and scores only to `health:view`. `PUT /meals/priority/config` (`meals:manage`)
        sets `enabled`, the weights, the pace and the companions. While it is off (the default) no letter
        leaves the page. Once on, the badge token `@meal_group` prints the letter, «Mi inscripción» shows the
        group and each meal's turn, and the meal scanner's cards show the letter without ever blocking a
        delivery.
    *   **Fee rules** (`/fee-rules`): the base fee plus ordered `set`/`add` rules matched against form values, in
        integer cents. `POST /public/quote` returns the fee for a set of values (the portal shows it live while
        registering); `POST /reprice` re-applies the current rules to every inscription of a conference.
    *   **Fee payments — «Pagos de cuotas»** (2.18.0; fees only — transport is paid in Transporte). A
        **payment** is one receipt (a bank transfer or a cash handover): a row of `payment_transfers` (the
        header) split into **parts**, one per person, which are rows of `payments` linked by `transfer_id` and
        stamped with the header's allocation generation `alloc_gen`.
        *   **Status lives on the header**: `pending` («Por validar») | `validated` | `returned` («Devuelto»: the
            admin sends it back with a note for the recorder to correct and resend) | `rejected` (the money did
            not arrive, or a validated payment is voided — a reason is required); `draft` is internal and never
            shown. Transitions (`payments:manage`): validate from pending / returned / rejected; return from
            pending, only to someone who can correct it — the administration (its own payments) or the
            portal of an existing location (its own: the location is looked up, and a payment never keeps the id
            of a deleted one — the write clears it if another node deleted the location meanwhile, and the boot
            clears any left over); a pre-2.18 (`legacy`) payment or a portal one whose
            location was deleted answers `409 no_recorder` (edit, validate or reject it instead); reject from
            pending / returned / validated. Editing (a corrected split, people, amounts,
            receipt) is allowed while pending or returned and puts it back to pending; a validated payment is
            never edited or deleted — reject it, then «Duplicar» (`copy_proof_from`) records it again re-using
            its receipt. Only a REJECTED payment's receipt can be copied: a source that still counts or can
            count (pending, validated, returned) answers `409 proof_source_live` (with `source: { id, status }`),
            so one receipt never stands behind two live payments. «Duplicar» also sends `duplicate_of` (the
            voided payment it records again — with or without `copy_proof_from`, cash without a photo too); the
            header stores the FIRST payment of the chain, and that payment plus its copies are one handover: at
            most one of them counts (pending, validated or returned) at a time. A second copy, or validating a
            voided one while a copy counts, answers `409 source_used` (with `used_by: { id, status }`; `null` to
            a portal when it is not its own payment) — re-checked after writing, as `over_cap`, across nodes.
            Admin payments carry `duplicate_of` and `reused_by[{ id, status }]` (the family's other payments that
            count); the portal's own carry `duplicate_of`, `reused` and `reused_by`. Voiding or deleting the copy
            frees the voided payment. `duplicate_of` is set when a payment is recorded and never changed by a
            correction: a `PUT` that names another payment in `duplicate_of` / `copy_proof_from` answers `400
            source_fixed` (naming its own family is accepted and changes nothing). An edit puts the payment back to pending and clears `reviewed_at` /
            `reviewed_by` (it awaits a new review; `events` keep who returned it). Every action sends `expected: { status, alloc_gen }` and is a compare-and-set: `409
            stale` (with `current`) when someone changed the payment meanwhile, so a shared payment is validated
            exactly as the admin saw it, **all or nothing**. A part's own `status` column is only a mirror of its
            header (for a downgrade), written from the header as it is after each write (never from what the
            writer meant to write) and only for the header's live generation.
        *   **The split** adds up to the receipt's amount **to the cent** (`400 sum_mismatch`); the server
            computes «Iguales» itself from `inscription_ids` + `split: 'equal'` (the leftover cents go to the
            first people: 100.00 / 3 = 33.34 + 33.33 + 33.33); «Manual» sends `allocations`. At most 200 people
            per payment. **Nobody is ever paid more than they owe**, for the admin and the portal alike: each part
            ≤ total due − validated − pending of the person's other payments (`409 over_cap` listing `people[{
            inscription_id, amount, max }]`); validating re-checks it against validated money, and a cancelled
            inscription owes nothing: validating a payment that still holds one answers `409 cancelled_people`
            (with `ids`) until the split is corrected, the person reactivated or the payment rejected. Unknown,
            other-conference (for the portal: other-location) or cancelled people refuse the whole request
            (`400 unknown_people | cancelled_people` with `ids`). A payment a location's portal recorded holds
            only that location's people, also when the administration corrects it (`400 unknown_people` for
            anyone added from another location; a person who moved away after it was recorded may stay).
        *   **The receipt** (an image data URL, ≤ 1.4 M characters) is **required for a transfer and optional for
            cash**, for everyone. The size its header declares (PNG, GIF — every frame —, WebP, JPEG) must be at
            most 8192 px on a side and 24 megapixels, and the header must be readable (`400` otherwise): a few
            hundred KB can declare a picture no browser could decode. It is stored **once**, on the header —
            parts carry none — and never travels in a list: items say `has_proof`, and `GET
            /fee-payments/:id/proof` (`payments:view`) or `GET /portal/fee-payments/:id/proof` (the recording
            location only) return `{ id, proof }`. A STORED receipt is held to the same rule: one that fails it
            (written before 2.18, when only the data-URL shape and the size in characters were checked) is
            never served (`422 invalid_proof`), copied by «Duplicar» (`400 proof_source`) or kept by an edit
            (a transfer then needs a new receipt).
        *   Admin payments are **born validated** unless `leave_pending: true` («Dejar por validar») and may span
            several locations (the header's `location_id` is then `NULL`); portal payments are always pending.
            `client_key` (8–64 of `[A-Za-z0-9_-]`) makes a retry idempotent (`replayed: true`, and the replay
            recomputes its people's balances, repairing a first attempt that failed after writing; another
            recorder with the same key → `409 client_key_conflict`). Only the SAME request is a replay: the same
            method, reference, note, amount, split, «Duplicar» source and receipt (and date, when the request
            names one); a request that changed any of them under a used key answers `409 client_key_changed`
            with the payment that key recorded (`id`, also in `details`) — a send whose answer was lost, then
            corrected on screen and sent again, is never answered «registered» for a payment that is not the one
            on screen. A transfer reference already used by another live payment of the conference → `409
            duplicate_reference` (`other: { id }`, also in `details`) unless `allow_duplicate_reference: true` —
            when recording, correcting, and validating ANY payment (pending, returned or rejected: `POST
            /fee-payments/:id/validate` takes the same flag; its own «Duplicar» family is left out). A payment
            recorded with a repeated reference (the portal's «Registrar de todas formas», an older portal's
            `/portal/payments/bulk`) therefore asks the administration again when it is validated, and a
            confirmed one leaves a `reference_confirmed` line in its history (`note`: the other payment's id). On
            several nodes each of those re-checks after writing, so two payments with one reference never both
            stand. `GET /fee-payments/:id` names the other one in `flags.duplicate_reference_of`.
        *   **Admin routes** (each checks the caller's permission FIRST: an account without «Pagos» gets `403`,
            never a `503` nor a migration attempt): `GET /fee-payments?conference_id` (`payments:view`) answers `{ summary, by_location[],
            counts, transfers[], people[], methods, max_people, proof }` in one call — each `people[]` item also
            says who the person is: `name` (the form's name fields, else its name fallback fields), the live
            `location`, `family_group`, the inscription `status` and `reg_code` (`null` without
            `inscriptions:view`), and nothing else of the roster: the section never reads `GET /inscriptions`
            (optional filters `status`
            (comma list), `location_id` (a number or `none`; a payment matches its recorder's location and each
            of its people's, `none` included), `inscription_id`, `recorded_via`, `method`, `from` /
            `to` — summary and counts always cover the whole conference); `GET /fee-payments/:id` adds each
            person's facts (name, due, other money, the position after validation) and the history (`events`);
            `POST /fee-payments`, `PUT /fee-payments/:id`, `POST /fee-payments/:id/validate | return | reject`
            (`{ note?, expected }`), `DELETE /fee-payments/:id` (pending / returned / rejected).
        *   **Per person**: `due` (0 for a cancelled inscription), `validated` (= `amount_paid`), `pending`,
            `returned`, `to_cover` = max(0, due − validated − pending) — the most a new payment may carry — and
            `credit` = max(0, validated − due). **The «Resumen»** (`summary`, `by_location[]`, the portal's
            `summary`): `validated` and `pending` count each person's money only up to their fee (validated
            first), `to_cover` is the rest, so validated + pending + to_cover = due exactly; validated money past
            a fee is `credit` only, and pending money past it (a cancelled person's) counts in no figure. `amount_paid` / `payment_status` still come from **validated**
            money only; `GET /inscriptions` and `GET /inscriptions/:id` add `pending_amount` and `returned_amount`.
        *   **Older data and clients**: every pre-2.18 payment is wrapped at boot as a 1-person payment (old
            group payments become N single ones; amounts, dates, statuses and review stamps are kept, the receipt
            is read through `legacy_payment_id`, never copied; idempotent). The pre-2.18 routes stay as wrappers:
            `POST /inscriptions/:id/payments` records a 1-person payment left pending; `POST
            /payments/:id/validate | reject` and `DELETE /payments/:id` act on a 1-person payment by its part
            id and answer `409 shared` for a shared one (and `409 stale` when the payment changed between their
            check and their action: they act only on the status and generation they inspected); `GET /inscriptions/:id/payments` lists the person's
            parts with their payment's summary and no receipts (`with_proof=1` adds them for `payments:view`);
            to a caller with `inscriptions:view` but without `payments:view` each part is only `{ id,
            inscription_id, amount, date, method, status }` — never the payment it belongs to (its number, size,
            people), its reference, receipt or review.
            After a **downgrade** below 2.18 the mirrored part statuses keep the balances right, but receipts of
            new payments are not visible in the old screens, and reviews made while downgraded are overwritten
            by the header on the next upgrade.
        *   Writes run without transactions (the db bridge has none): under one in-process lock, a create
            inserts the header as an invisible draft, then all its parts in ONE multi-row `INSERT`, then flips
            it; an edit mints a generation of its own (a compare-and-set on the header's `gen_seq`: unique per
            attempt, above every earlier one), inserts the new parts with it and swaps them in with ONE header
            compare-and-set, then deletes the OLDER generations — a failed attempt deletes only its own, and an
            attempt undone by its re-check (below) puts the split it replaced back as a FRESH generation (the old
            one may already be gone: a node booting meanwhile removes every older generation). The boot
            removes crashed drafts (older than a day), orphan parts, older-generation parts, newer-generation
            parts older than a day (a newer one may be an edit in flight on another node), headers without a
            live part, and re-writes the mirrors. **Several nodes** (each runs its own plugin process, so the
            lock serialises only one node): every write that adds money (create, edit, validate) re-reads the
            people's live money after writing and, when someone is now past their fee (another node wrote
            meanwhile), undoes itself and answers `409 over_cap` — of two racing writers at least one sees the
            other, so they never both stand. If the boot migration of the payments fails (a lock timeout, a
            missing column), the plugin keeps running on the parts' mirrored statuses: the roster, the portal and
            the reports work, `/portal/login` and `/portal/me` carry no `features.fee_payments`, and no payment
            can be recorded until the migration completes: the fee routes answer `503 unavailable` after one
            more migration attempt of their own (for a caller with the permission), `POST /portal/payments/bulk`
            included — the portal's with a message for the coordinator («Los pagos no están disponibles en este
            momento; inténtalo más tarde.»), the admin's with the reason. `DELETE /inscriptions/:id` answers `409
            shared` for a person who is part of a payment shared with others — its message says what to do for
            each blocking payment's status (take them out of a pending / returned split, void a validated
            payment and record it again without them, delete a rejected one — or cancel the inscription), and
            the body lists them in `transfers[{ id, status }]` — and deletes their 1-person payments with them,
            each at the split it has: every one is read again before anything is deleted, validated ones go
            last, and one that another node moved to someone else meanwhile is left alone (it is no longer
            theirs). One that became shared answers `409 stale` (`transfer_id`) and the person is left as they
            were — before anything is deleted, or, in the instant between two deletes, naming the payments
            already deleted (`deleted_transfer_ids`, also in the message and the server log). A correction or a
            validation whose payment another node deleted meanwhile answers `409 stale`, never success.
            Across nodes it first marks the person cancelled and checks again, so a payment another node records
            with that person meanwhile either shows up (`409 shared`, the person left as they were) or fails its
            own re-check after writing and backs off (`400 cancelled_people`, or `400 unknown_people` once the
            person is gone). While the payment tables are unavailable a person with payment rows answers `503
            unavailable` (which of them are parts of a shared receipt cannot be told); one without any is deleted. A
            caller without `payments:manage` (or `transport:manage` for transport payments) gets the generic `409`
            «La inscripción tiene pagos registrados…» first, never the payment ids, statuses or sizes; `DELETE /locations/:id` keeps its payments.
    *   **Locations**: each location has a required **maximum number of registrants** (`capacity`; a full
        location refuses new registrations from the portal and the admin with `409`; locations created before
        2.3.0 stay unlimited until one is set) and the **forms of payment** it receives (`payment_methods`:
        cash and/or bank transfer, both by default).
    *   Hotel & Room assignment, including a rule-based auto-assignment engine (`/assignment/rules`,
        `/assignment/run`, `/assignment/reset`) that reports its **violations** (keep-together groups that had
        to be split, capacity) with the rule's name and whether the rule was hard. **Lodging per location**:
        the admin allots rooms to a location (`/hotels/:id/allot`), the coordinator arranges and submits it
        from the portal (`/portal/lodging*`), and the admin validates, returns or reopens it
        (`/locations/:id/lodging/validate|return|reopen`). **Lodging dates** (since 2.21.0): portal lodging
        changes are allowed from a general opening (`lodging_opens`) to a general closing (`lodging_deadline`),
        both whole days in the admin's zone (`lodging_tz`); a location may have its own (`lodging_opens`:
        a date or `now`; `lodging_closes`: a date or `never`; null = the general one) — the former
        per-location permission is such a closing.
        Since 2.20.0 the engine **packs**: the hard `separate_by` rules split people into classes that never share
        a room, and each class takes the fewest rooms, then the fewest spare beds (`server/lodging-pack.js`: an
        exact choice of rooms over their free beds, then Best Fit Decreasing, then an exact search for a few
        groups), filling rooms that already hold people first; a soft rule is kept when that costs nothing and
        gives way when keeping it would cost a room or beds (reported as a preference, never hard). Every run tries
        that packing and the 2.19 placement on copies of the rooms and keeps the best by [hard rules broken, people
        without a bed, rooms used, empty beds, preferences broken], and the conference-wide run chooses the same way
        between that and 2.19's placement in every scope, on copies of the whole conference. The engine reads through an `io` (the
        database, or an in-memory copy of the conference), so `/assignment/simulate` answers exactly what
        `/assignment/run` would do without writing. **«Sugerir reparto»** (`/assignment/plan`,
        `/assignment/plan/apply`) plans which free rooms (or beds of a shared room, or free beds next to people
        already placed) each draft location with people waiting gets, AND who sleeps where; it reports `current`
        (today: the current allotment plus a run) next to `after` (the plan plus a run), and apply writes the
        allotments and the placements, then runs the automatic assignment, only while it is the plan the admin saw (`409 plan_changed`) and never a plan worse than today
        (`409 plan_worse`). A room the plan SHARES keeps the class it gives it (2.21.0): the value its people have for
        each hard `separate_by` field is written on the room (`rooms.share_lock`, JSON `[{ field, value }]`; `lock` on
        the plan's `after`, on `GET /hotels` rooms and on the portal's `shared`) and every bed of it keeps that value —
        the engine's runs, the planner, `POST /portal/lodging/assign` and `POST /inscriptions/:id/assign` (`409`) —
        while the room is shared and a hard `separate_by` on that field is enabled; `PUT /rooms/:id/beds` with
        `release_lock: true` frees it, and a room no longer shared keeps none. With beds enough every plan carries
        `variants` (2.21.0): `keep` (the fewest families divided without anyone losing a bed, then the fewest rooms) and
        `divide` (the fewest rooms, preferred mixed families divided by the hard `separate_by` values, then the fewest
        families divided), each with `rooms` / `empty_beds` (the plan's measure: the rooms holding the people it places
        and their empty beds), and the rooms view — over the rooms the plan may fill (in the hotel chosen, not blocked:
        a pool room, a room of a location with someone waiting, a shared room with pool beds or such a share) plus any
        other room holding the people it places — `used_rooms` / `used_empty_beds` (rooms with someone in them and their
        empty beds) and `free_rooms` / `free_beds` (rooms the plan may fill with nobody in them; all four also on
        `current` and `after`), `unplaced`, `hard` and `families_divided` (families, one per location, whose people
        are in more than one room) and `today` (the answer is today's arrangement), `chosen` and `same`. TODAY competes
        (2.21.0): leaving everything as it is — no room allotted or released, nobody moved, the automatic assignment for
        whoever waits — is scored like any arrangement the plan tries (the variant keys end with the preferences broken)
        and replaces each answer it beats, or ties with when that answer moves someone who has a bed or changes no
        allotment; only when, of the people whose beds the plan decides (whoever waits; with `fresh`, whoever it took
        out of a bed), it beds no more outside their location's rooms (whole or a share; the pool's people outside pool
        rooms) than that answer. `keeps_today: true` when it is the plan: no `changes`, `placements` or `moved_ids`;
        `locations` and `pool` as today has them. `divide_families: true` on
        `/assignment/plan` and `/assignment/plan/apply` plans and applies the divided answer (`variants` is `null` with
        beds short or when no preferred family can divide). HELD BY THE ADMINISTRATION (2.21.0): `PUT /rooms/:id/block`
        `{ blocked }` and `PUT /inscriptions/:id/pin` `{ pinned }` (`lodging:manage`; pinning needs a bed) — the engine
        (runs, plans with or without `fresh`, the overflow, `/locations/:id/beds`, both resets) never places anyone in a
        blocked room, never takes anyone out of it and never moves a pinned person; `POST /portal/lodging/assign`
        answers `409` for any of those, and so does `PUT /inscriptions/:id` that would free such a bed without
        `lodging:manage`; the admin's `POST /inscriptions/:id/assign` still may. `room_locked` stores the room the person
        was fixed in and holds only there: every write that changes `room_id` clears it (and boot clears any left over);
        `DELETE /locations/:id` leaves held people in their rooms. Plans report `held: { rooms, people }`; `GET /portal/lodging` marks `blocked` rooms and `room_locked`
        occupants.
        The admin and the portal share a lodging board / explorer (hotel → room → occupant, drag & drop).
    *   **Administration adjustments** (2.17.0): while a location's arrangement is `submitted` or `validated`
        the coordinator's portal stays read-only (every `/portal/lodging*` write answers `409`), but the admin
        side can change it without reopening it. With `lodging:manage` (administrators and team roles with
        Hospedaje › gestionar), `POST /inscriptions/:id/assign`, `POST /hotels/:id/allot`, `PUT|DELETE
        /rooms/:id` and `DELETE /hotels/:id` work on such a location as on a draft. Attendees follow the
        **bed rule**: an arrangement is who sleeps where, so only an attendee who holds a bed is part of it,
        in either direction. `PUT /inscriptions/:id` that moves such an attendee out of it (the move frees
        the bed, or they take a pool bed along) or into it with the bed they keep (a pool bed, or one of its
        own rooms) also needs `lodging:manage` (`409` otherwise — its text says when the move becomes possible
        without it: once a `validated` location is reopened, or once a `submitted` one is returned to its
        coordinator, since only a validated one can be reopened) and is recorded. Cancelling one, or
        `DELETE /inscriptions/:id`, frees the bed with `inscriptions:manage` alone and is recorded. An attendee
        WITHOUT a bed (none, or one the move itself frees) changes nobody's arrangement: moving them in or
        out, cancelling, deleting or registering them (`POST /inscriptions`, the portal, the public form) takes
        `inscriptions:manage` alone (or the coordinator's own registration) and is never recorded, the same
        going in as coming out. The status does not change and the review stamps stay.
        Every change to who sleeps where, or to which rooms and how many beds the location has (not a room's
        name, gender or notes), is recorded on it: `lodging_admin_changed_at`, `lodging_admin_changed_by` and
        `lodging_admin_changes` (the count since the coordinator's last submission; idempotent `ADD COLUMN`
        on boot). A deleted room or hotel is recorded on the locations it was allotted to and on those whose
        attendees slept in it (a pool room's occupants included). The change and the record are written under
        the lock that every status transition also takes, deciding on the inscription and room rows as they
        are under it, and the record only lands while the location is still `submitted` / `validated`. An
        inscription edit or deletion that touches no bed does not take that lock. Each of those routes answers
        `lodging_adjusted: [{ location_id, name, status }]` with the locations it changed (empty for a draft
        or a write that changed nothing). `GET /locations` (with `lodging_admin_changed_by` only for
        `locations:view`) and `GET /locations/:id/lodging` return the record; `GET /inscriptions` returns
        `room_location_id`, the location each attendee's room is allotted to. `GET /portal/lodging` returns
        `admin_changed_at` and `admin_changes`, without who made the change; `/portal/me` returns none of the
        three. `POST /locations/:id/lodging/validate|return` take `seen: { submitted_at, admin_changes }`, the
        review the admin looked at: if the arrangement changed since (an adjustment or a new submission) they
        answer `409` with `code: 'lodging_changed'`; without `seen` the status alone decides, as before. A
        validation keeps the record and the coordinator's next submission clears it. «Reabrir» still hands the
        arrangement back to the coordinator. The conference-wide `/assignment/run` and `/assignment/reset`
        still skip submitted / validated locations (`skipped_frozen: [{ location_id, name, status }]`): a bulk
        operation does not rewrite a reviewed arrangement. The run's entries also carry `unassigned` (that
        location's attendees still without a bed), summed in `skipped_unassigned`: `remaining +
        skipped_unassigned` is everyone still without a bed once the run is done. The lodging review shows the record and offers
        «Ajustar en Asignación» (the explorer filtered by that location). The explorer, its pickers and the
        inscriptions' room dialog mark such a location instead of locking it, once per location and with its
        actual state. Confirmations and toasts name the arrangements a change affects. The coordinator's
        portal shows «Ajustado por la administración el …», and its submit confirmation says the
        administration may adjust the arrangement.
    *   **Registration codes**: every attendee gets a unique random 10-character `reg_code` (a QR Code since
        2.22.0, the Code 128 barcode before; the scanners read both), visible in the admin panel with `inscriptions:view`. It is never in a portal LIST; a
        person's badge (below) carries it, through the badge endpoints only.
    *   **Badges** («Escarapelas», 2.19.0): one design per conference (`conferences.badge_config`: orientation,
        title, colours, legibility panel, the fields and their labels; policy: on / off, coordinators may share, an
        expiry date) plus a background image and a logo. The designer composites the card's static layer in the
        browser into two JPEG «plates» (`badge_assets`); the server computes each person's badge once as a display
        list (`server/badge-layout.js`: text runs fitted with Helvetica metrics, Code 128 bars, all in mm on a CR80
        85.6 × 54 mm card) that the PDF (`server/badge-pdf.js`, no dependency, one per page or a Letter sheet with
        cut guides), the admin and the portal draw alike. Each inscription has at most one
        link (`badge_links`, a 128-bit token in the URL fragment: `/portal/conference/badge#t=…`); the public view
        answers 404 for any wrong token (throttled per client and globally) and 410 for a cancelled inscription
        (back on reactivation), past the expiry date or with badges off. Files go through a ticket (`badge_tickets`,
        120 s, 3 uses) that the core's portal file route `/portal/conference/file` turns into bytes (PDF only;
        `frontend.portalPage.file`). Staff need
        `badges:view` AND `inscriptions:view` for links and files, `badges:manage` for the design and to regenerate
        or revoke a link; the portal reaches only its own location's people while the conference lets coordinators
        share badges (`features.badges` on /portal/login and /portal/me).
        **The badge designer** (2.29.0): a free-form canvas (`badge_config.design`, version 2, one model shared by
        the server and the browser — `server/badge-design.js`): six templates, texts in 13 typefaces (25 font files) shipped with
        the plugin (SIL OFL, `fonts/`, loaded by literal `require` as base64 modules — no `filesystem` grant),
        the person's data as tokens, images (JPEG / PNG, `badge_assets`), shapes, rotation and opacity; the PDF
        embeds the TrueType fonts (`server/badge-pdf.js`, `badge-font.js`, `badge-png.js`). Exactly one QR
        always. Older designs open converted (`client/lib/badgeEditor.ts` `fromLegacy`).
    *   **«Mi inscripción»** (2.23.0): `/portal/conference/yo#c=<code>`, the registrant's own page behind their
        badge's QR. The code alone is not enough: the person confirms the document type and number they
        registered with (the form fields chosen in «Escarapelas › Uso», detected by label otherwise); a match opens
        a session (a 128-bit token kept by the phone, stored hashed in `self_sessions`, 30 days or the badges'
        expiry). It shows only the person's own badge, answers, meals delivered and to come, hotel, room and map —
        never anyone else. Sign-in follows the portal's rule (2.30.0): only the caller's own budgets refuse; the
        per-code and site-wide budgets only make attempts wait. A shared badge link (2.28.0) leads here instead
        of showing the badge. Routes: `POST /public/me/start | verify | view | ticket | logout`.
    *   **Boarding and transport packages** (2.24.0–2.27.0): hotels are found and pinned on a map (2.24.0);
        «Verificar abordaje» (`POST /transport/check`, transport) scans a badge and says whether the person
        travels on THIS bus (2.25.0); transport is sold as **packages** of buses with one price and their own
        payments (`/transport/packages*`, `/transport/package-sales/:id/payments`; the per-bus sale and ticket
        payment routes answer 410 — earlier tickets became one-bus package sales, payments included) (2.26.0);
        and the transport team tells a bus's passengers that it is BOARDING, that it LEFT, or sends a message
        (`POST /buses/:id/notice`), shown on their «Mi inscripción» and, where the person turned notices on, as a
        real browser notification (Web Push, RFC 8291 encryption and RFC 8292 VAPID, no dependency —
        `server/transport-push.js`; only the browsers' push services are contacted, and only with the
        `network` grant) (2.27.0). A phone's subscription belongs to its «Mi inscripción» session.
    *   **Transport** (`/buses`, tickets and their own payments, sold apart from the participation fee),
        **accounting** (`/accounting`: income/expense ledger plus the validated registration and transport
        payments as read-only income) and **meals** (`/meals*`: services, a location × service plan, per-person
        overrides, and deliveries recorded by scanning the attendee's barcode — on a phone, «Modo escáner» reads
        with `BarcodeDetector` where the browser has it and with the plugin's own reader otherwise (Code 128,
        EAN-13/8, UPC-A, UPC-E number system 0, Code 39), and shows whatever it reads that is not a registration code).
    *   **Delivery confirmation** (2.16.0): by default a scan does not record anything by itself. The phone
        scanner and the «Entrega» tab first call `POST /meals/check` `{ service_id, code? | inscription_id? }`
        (`meals_delivery:manage`, **read-only**), which runs the same lookup and decision as `/meals/deliver`
        and always answers 200 with `result` = `ready` (would deliver) | `not_entitled` (needs an authorised
        override) | `already` (with `delivered_at`, `delivered_by`, `method`) | `cancelled` | `unknown` |
        `other_conference`, plus `service` (`id`, `service_date`, `meal`, `label`, `start_time`, `end_time`) and
        `person` (`id`, `name`, `location`, `location_id`, `family_group`, `reg_code` — masked without
        `inscriptions:view` — and `fields: [{ key, label, value, hidden? }]`); 404 for an unknown service, 400
        without code or inscription. A confirmation card shows the meal, those fields and the status: «Entregar»
        (`/meals/deliver` with the same body) or «Cancelar» for `ready`, «Entregar sin derecho (autorizar)»
        (`force: true`) or «Cancelar» for `not_entitled`, «Cerrar» otherwise. «Cancelar» records nothing — the
        person stays pending and the next scan shows the card again. In «Entrega», Enter on the empty scan
        input = «Entregar» (never the override), Esc = «Cancelar», and a code scanned while a card is open is
        queued behind it; Enter only answers a card on screen for at least 500 ms and ignores a held-down key
        and an Enter within 300 ms of the previous key (a CR+LF scanner suffix); the queue waits while
        «Entregado» shows (1.2 s) and, after any other delivery result, until Enter, Esc or a click; a person
        picked by name replaces the open card. In «Entrega» whatever appears under the scan input
        («Comprobando…», the card, a delivery's result) is scrolled into view (instantly with reduced motion)
        and the card is capped to the visible area, so the meal, the name and the buttons are on screen
        together. Decoding pauses on the phone while a card is open; afterwards
        the badge must leave the camera for 3 s (not after a service change or a failed request; after
        «Cancelar» the badge shown again says so). Card buttons ignore taps for 400 ms after the card appears,
        and the «Entregado» card that follows «Entregar» for 600 ms. The «Confirmar antes de entregar» switch
        (per device, on by default) restores the immediate delivery. `/meals/deliver` keeps its contract and
        adds the same `service` and `person.fields`.
    *   **What the delivery card shows** (2.16.0): `GET /meals/display-fields?conference_id=` (`meals:view` |
        `meals_delivery:manage`) returns `keys` (the effective list, in order), `configured`, `default_keys` and
        `available` (built-ins `@name`, `@location`, `@reg_code`, `@payment_status`, `@room`, then every field of
        the conference's registration form); `PUT /meals/display-fields` `{ conference_id, keys: [...] | null }`
        (`meals:manage`) stores the choice in `conferences.meal_display_fields` (an idempotent `ADD COLUMN`;
        `null` = back to the default, name + location). Keys are validated against the conference's current
        form (400 otherwise); a field deleted later is ignored. `@name` is always the first key: it is added
        when a choice leaves it out and moved up when it is elsewhere (also for a stored list). `person.fields`
        of `/meals/check` and `/meals/deliver` carries the configured values only, so form answers, the payment
        status and the room reach the delivery device only when configured; `person` itself keeps the 2.15
        projection (name, location, family group, masked code), which delivery staff also get from
        `/meals/people` (whose `document_number`, the attendee's ID document, is null without
        `inscriptions:view`, like `reg_code`; without it the search matches a document only when it is typed
        whole). Configured from «Entrega» › «Qué se muestra al entregar», with a live preview of the
        card; «Restablecer» refills the form with the default and «Guardar» stores it (saving the default
        stores `null`).
    *   **Latest deliveries** (2.17.0): `GET /meals/services/:id/deliveries?limit=` (`meals:view` |
        `meals_delivery:manage`; newest first, `limit` ≤ 100, default 20) returns `service` — the same `id`,
        `service_date`, `meal`, `label`, `start_time`, `end_time` as `/meals/check` — next to `deliveries`, whose
        rows carry their `service_id`. «Entrega» › «Últimas entregas» shows on every row the person, the meal
        delivered («Desayuno · Vie 11/12»), the method (scan, manual, authorised override), the time, the
        location and who recorded it, and reloads as soon as the phone scanner records or undoes a delivery.
        In the phone scanner, the verdict card stays inside the camera area and, from 320×460 up, always shows
        its short status, the meal (one line on a short phone, the label giving way; a tap shows it whole), the
        person's name and its buttons (44 px), while the other details give way and scroll, ending on a whole
        line with «Más abajo ↓» under the cut. Its inline «¿Entregar de todas formas?» keeps «Sí, entregar» /
        «Cancelar» side by side. The confirmation card does the same from 320×460 up: the status and the name
        are its own header and give way last, the meal takes one line on a short phone (the label giving way),
        and «Entregar sin derecho (autorizar)» reads «Autorizar» wherever the whole label would take more than
        two lines (every phone width, both cards; measured, its accessible name whole). The reason a not-entitled
        person has no right to the meal is a line under the status that never gives way. In «Entrega», the
        inline confirmations («¿Deshacer…?», «¿Entregar de todas formas?») scroll themselves into view when
        they open — the latter spanning the card, its buttons first when the card is taller than the screen; for
        «¿Deshacer…?» the whole row of «Últimas entregas» (the name included) comes into view below the admin
        header, its buttons on one row, the question short when the row with the full one would not fit. A tap
        on the meal shows it whole on both cards; only when the card cannot hold it without cutting the status,
        the name or the buttons does it keep the whole lines that fit, with «Más abajo ↓», and scroll. «Entrega»
        caps its «Entregado» / «Ya recibió» card to the visible band like its confirmation card (on a phone the
        meal and the person's data take the card's whole width and the name breaks only between words), keeps
        «Cancelar» / «Entregar» side by side inside the card on a 320 px phone, and caps and brings into view the
        result of every delivery with the confirmation off too — a USB-wedge scan, a name picked, «Sí, entregar».
        Its not-entitled card has the short status «Sin derecho» with the meal under it, and its «¿Entregar de
        todas formas?» drops whole sentences when the capped card is short (on a phone «Sí, entregar» /
        «Cancelar» side by side) and brings the whole card into view, the status and the name with it. In the
        phone scanner, the aim hint, the «En pausa» heartbeat and the focus hint hide while a card reaches them.
    *   **Team & per-section permissions** (`/staff/*`, administrators only): roles give each section
        (dashboard, inscriptions, payments, locations, lodging, transport, accounting, meals, meal delivery,
        reports, settings) `none`, `view` or `manage`; members are WordJS users (found via `users:read`).
        Every admin-panel route checks the caller's level on the server; WordJS administrators keep full access.
        Deleting a conference (`DELETE /:id`) takes its attendees, fee payments, transport payments and ledger
        with it, so it needs `settings:manage` plus `manage` on each of inscriptions, payments, transport and
        accounting whose records the conference still holds (`409 conference_has_records`, with `sections`,
        otherwise); an empty conference needs `settings:manage` only.
        «Pagos de cuotas» (2.18.0) needs `payments:view` to look and `payments:manage` to register and review;
        the «Inscripciones» tab no longer opens with the payments section alone, and neither does the roster:
        `GET /inscriptions` and `GET /inscriptions/:id` answer `inscriptions`, `lodging`, `transport`,
        `accounting`, `dashboard` or `reports` (`view`), not `payments` — a payments-only role learns who each
        person is from `GET /fee-payments` (`people[]`: name, location, family group), never their contacts,
        form answers or notes.
    *   **Team WordJS role** (2.17.0): the manifest declares the role «Equipo de conferencia»
        (`conference_manager_team`, through `roles:declare`; see [plugins.md §12a](plugins.md#12a-declaring-user-roles-rolesdeclare-))
        whose only capability is `conference_manager_access` — the capability the «Conference» menu entry
        requires. An account with that role reaches the admin shell, its own account page and this plugin's
        page, and no other admin page. What lets an account work in the panel is the CAPABILITY: the team role
        carries it, and an administrator may also give it to another role in Users › Roles (an editor who
        also runs registrations keeps the editorial screens and gets this one). Only such accounts can join
        the team: `POST /staff/members` answers `400 not_team_role` for any other, and a role change or
        reactivation through `PUT /staff/members/:id` that leaves the member active follows the same rule
        (deactivating, removing, and — without the `users:read` grant — any change never need it). A member
        whose account lacks the capability (added before 2.17.0, or whose role was changed in Users) is kept
        but gets no section, and the team list flags it (`team_role: false`). The plugin reads the
        capability on every request from `req.user.pluginCapabilities`, and for any other account from the
        users bridge's projection, so revoking `roles:declare` closes the panel to the team at once (an older
        host that sends no list is judged on the role alone). `GET /staff/members` reports `roles_ready`:
        `false` when the team role is not registered or confers nothing (an in-place update to 2.17.0 keeps
        the old grants) — the team screen then asks for the `roles:declare` grant. The flow: create the
        account in Users with the role «Equipo de conferencia», then add it to the team in «Equipo y permisos»
        and choose its team role.
    *   **Coordinator portal** (`/portal/login`, `/portal/me`, `/portal/inscriptions`, `/portal/groups`,
        `/portal/fee-payments*`, `/portal/payments/bulk`, `/portal/lodging*`, `/portal/badges/*`) surfaced at `/portal/conference` — the plugin's own portal page (`frontend.portalPage`, `client/portal`; a page of the core before 2.30.0). A per-location 6-digit
        access code is required; there is **no anonymous public registration**. A login opens a 7-day session
        (an opaque id kept on the server) that a new code, deleting the location, unpublishing the form or a
        logout ends; wrong codes are throttled per client, per location and site-wide. Each coordinator's view is
        isolated by the location's **id** (not its name — names are unique per conference and renaming a
        location keeps its attendees), and the portal listing is a projection (no admin notes, room or status;
        2.18.0 adds `pending_amount`, `returned_amount` and `cancelled: true|false` — a cancelled inscription owes
        nothing and cannot be paid — ordered by first name, then id).
        **«Pagos de cuotas» in the portal** (2.18.0): `GET /portal/fee-payments` returns the whole view in ONE
        request (`{ features, location, methods, can_record, proof, max_people, summary, people[], counts,
        transfers[] }`): the location's own payments in full (except the receipt) with `can_edit` /
        `can_delete`, and every other payment that covers some of its people — the administration's, or a
        pre-2.18 one — as a read-only line with `foreign: true` and only those people's parts, without receipt,
        reference or notes. `POST /portal/fee-payments` records a pending payment of the location's own people
        with one of its enabled methods (`400 no_methods` when none is enabled); `PUT /portal/fee-payments/:id`
        corrects and resends one of its own pending or returned payments; `DELETE /portal/fee-payments/:id`
        deletes one; each answers with the refreshed `view`. `/portal/me` and `/portal/login` carry `features:
        { fee_payments: 1 }` (a core portal without it keeps its previous payment flow) and `fees: { pending,
        returned }` (the tab badge). `POST /portal/payments/bulk` stays for older core portals: the same amount
        for each selected person becomes ONE pending payment of N equal parts with the receipt stored once, and
        any person outside the location (or cancelled, or already covered) refuses the whole request. A transfer
        reference already used is accepted there (that portal cannot ask for confirmation, and its
        one-amount-per-person form needs two posts for one transfer when fees differ); the admin's queue flags
        it «Referencia repetida».
    *   **Roster rows** (2.18.0): `GET /inscriptions/:id` returns exactly one row of `GET /inscriptions` (same
        gate, same `reg_code` masking; 404 for a missing or non-integer id), so a page refreshes one person
        after an action; the roster and its CSV export are ordered by last name, first name, then id, so the
        legacy `limit`/`offset` pages never repeat or drop anyone. The CSV export gains «Por validar».
        `/accounting` has ONE read-only income line per validated payment («Pago de cuotas · N personas», or
        «Pago de inscripción» with `inscription_id` for one person) dated by the payment date, with its
        `allocations`, `people`, `transfer_id` and `location_id`. `/reports/summary` follows «Pagos de
        cuotas» › Resumen's per-person model, in total and per location: `due` = Cuotas (a cancelled
        inscription owes 0), `paid` = Validado (each person's validated money up to the fee), `pending` = Por
        validar, `to_cover` = Por cobrar, `credit` = A favor, `returned` = Devuelto (so `due − paid` =
        `pending + to_cover`, never negative); `paid_count` / `partial_count` / `unpaid_count` are the roster
        pills of active people (`people`), `cancelled_count` apart, and `owing_count` the active people with
        something no payment covers yet (the Dashboard's «Con saldo»). `total` still counts every inscription.
    *   Reports (`/reports/summary`, cents-rounded totals), CSV export of inscriptions (`/inscriptions/export`),
        and Excel (`.xlsx`) workbooks built in the browser (custom inscription export with optional barcode
        images, hotel assignment, transport and accounting reports).
*   **Documented caps** (a request over a cap answers `400` instead of running unbounded): 200 people per
    fee payment (and per bulk payment), 20 000 inscriptions per `/reprice`, 5 000 unassigned attendees per `/assignment/run`,
    500 passengers per bus operation, 60 dates per bulk meal-service creation.
*   **Requested capabilities:** `database` (read/write — its own `wjp_conference_manager_` tables), `express` (register_route — namespaced routes), `admin_menu` (register — sidebar item, gated on `conference_manager_access`, which administrators and the team role hold; the page then shows only the sections the user's team role allows), `users` (read — find WordJS users to add to the conference team), `roles` (declare — the team role «Equipo de conferencia»).
*   **Sandbox:** isolated, like every plugin — no trust bypass. Default-deny: activation grants its declared
    capabilities (admin-approved in the activation dialog, refinable/revocable in `/admin/plugins`). It
    stores its data in its own prefixed tables (no unscoped/core-table access — that capability no longer
    exists), building table names from `db.tablePrefix` and creating them idempotently via `db.createTable`
    (`CREATE TABLE IF NOT EXISTS`); it extends its own tables with `ALTER TABLE … ADD COLUMN` (allowed for a
    plugin's own prefixed tables). Routes are namespaced under
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

## 7. Hello World 👋 — example, not shipped
**ID:** `hello-world` | **Version:** 1.1.0 | **Location:** `documentation/examples/plugins/hello-world/`

A reference implementation for developers. Registers a `[hello]` shortcode through the bridge (`[hello]`
or `[hello name="Ada"]` in a post renders a greeting; no permissions), and ships its own `node:test`
file (`tests/hello-world.test.js`) that you run yourself — WordJS never executes a plugin's tests.

It is **not** installed: the core ships `backend/plugins/` empty, so a fresh install lists no plugin. To try
it, copy the folder to `backend/plugins/hello-world/` (or call `POST /api/v1/plugins/sample`, which writes
the same plugin there) and activate it from **Plugins**.

*   **Purpose:** Development / Education.
*   **Sandbox:** isolated (like every plugin).

---

## 8. YouTube Videos 🎥
**ID:** `youtube-videos` | **Version:** 1.0.3

Pulls the videos of a YouTube channel (links, thumbnails, titles) and ships a carousel block
with title filtering and a video-count limit. Works **keyless** out of the box via the channel RSS
feed (latest 15 videos); add a YouTube Data API v3 key for the full upload history.

*   **Distribution:** first-party **marketplace** plugin (installed via the Marketplace catalog in §9) — not bundled with core.
*   **Routes:** `GET /`, `GET /status`, `POST /refresh`, `POST /settings` (namespaced under `/api/v1/plugin/youtube-videos/*`)
*   **Verso block:** `client/verso/YoutubeVideosVerso.tsx` (registry key `YoutubeVideos`) — carousel with title filter + count limit
*   **Admin page:** `/admin/plugin/youtube`
*   **Requested capabilities:** `settings` (read/write — configured channel + cached video list), `database` (read/write — the Data API key lives in the plugin's own `wjp_youtube_videos_*` table, **not** in options, because options are readable by other plugins), `network` (fetch youtube.com RSS / googleapis.com Data API — public egress only, like every `network` grant), `express` (register_route), `admin_menu` (register).
*   **Sandbox:** isolated (like every plugin). Default-deny: activation grants its declared capabilities, refinable in `/admin/plugins`.

---

## 9. Plugin Marketplace 🛒

Beyond the plugins above, WordJS ships a **Marketplace** of first-party plugins distributed
**outside** the core build (the Photo Carousel, Card Gallery, Video Gallery, Mail Server, Conference
Manager, and YouTube Videos sections above are themselves marketplace plugins — only Hello World and
Test Schema are bundled with core):

*   **Sources:** `marketplace/plugins/<slug>/` in the repo (32 plugins, listed below).
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

### Catalog (32 plugins)

| Slug | What it does | Key requested capabilities |
| --- | --- | --- |
| `analytics-tag` | Site-wide analytics tag (GA4, Plausible or Matomo) with optional cookie-consent gating | `settings` r/w, routes, admin menu, `assets:write` |
| `auctions` | Auction listings with bidding (address confirmed by a mailed code, or signed-in accounts only, who bid as their account address), a per-bid jump cap, anti-snipe extension, live polling, winner reporting | `database` r/w, routes, admin menu, `users` read, `email:admin` |
| `bookings` | Appointment booking: services, weekly availability, race-safe slot reservations, email confirmations, admin agenda | `database` r/w, `settings` r/w, routes, admin menu, `email:admin` |
| `breadcrumbs` | Breadcrumbs Verso block with optional BreadcrumbList JSON-LD | `browser:script` only (frontend-only) |
| `card-gallery` | Event/promo cards as an alternating-alignment ("zigzag") stack via the `CardGalleryVerso` block | `settings` r/w, `database` write, routes, admin menu |
| `conference-manager` | Conference inscriptions/registration with per-location capacity and forms of payment, hotel & room auto-assignment plus per-location lodging, registration barcodes, payments, transport, accounting, meals, team roles (own WordJS role), coordinator portal, reports + CSV/Excel export | `database` r/w, routes, admin menu, `users` read, `roles:declare` |
| `contact-forms` | Form builder with a Verso embed block, submissions inbox, CSV export, email notification | `database` r/w, routes, admin menu, `email:admin` |
| `cookie-consent` | GDPR cookie banner, anonymous consent logging, version-based re-consent | `database` r/w, `settings` r/w, routes, admin menu, `assets:write` |
| `digital-downloads` | Sell/give away downloadable products (each file a PRIVATE media item) with expiring, limited-use token-gated downloads streamed by the host — no file URL is ever revealed. 1.1.0 migration: products created earlier keep their public `file_url` working but are flagged in the admin until their file is re-selected as private | `database` r/w, `settings` r/w, routes, admin menu, `email:admin`, `media:private_read` |
| `donations` | Donation campaigns with goal thermometer, manual payment + optional Stripe Checkout, CSV export | `database` r/w, `settings` r/w, routes, admin menu, `email:admin`, `network` |
| `event-tickets` | Ticket types with quantity caps, paid orders confirmed by a mailed code before they hold seats, unique ticket codes, attendee check-in | `database` r/w, `settings` r/w, routes, admin menu, `email:admin` |
| `events-calendar` | Admin-managed events shown as an upcoming list or monthly calendar Verso block | `database` r/w, routes, admin menu |
| `faq` | Database-managed FAQ accordion with categories + Google FAQPage JSON-LD | `database` r/w, routes, admin menu |
| `image-lightbox` | Site-wide click-to-zoom lightbox for content images (captions, keyboard nav) | `settings` r/w, routes, admin menu, `assets:write` |
| `invoices` | Invoices with statuses, dashboard totals, CSV export, public token URL + print view, email to client | `database` r/w, `settings` r/w, routes, admin menu, `email:admin` |
| `job-board` | Job listings with anti-spam public application form, applications inbox, filterable Verso block | `database` r/w, `settings` r/w, routes, admin menu, `email:admin` |
| `mail-server` | Full SMTP server: inbound mail through the host listener (`smtp:inbound`) + direct-MX outbound delivery, DKIM signing, host-wide mail sender + email notification transport | `settings` r/w, `database` r/w, `email:admin`+provider, `notifications`, `filesystem` r/w, `users` read, `network`, `smtp:inbound`, routes, admin menu |
| `memberships` | Members-only content: free and paid tiers, a paywall block that ends a post's free teaser, Stripe Checkout subscriptions (test mode) verified by signed webhooks, tier change / cancel by the member, complimentary memberships, newsletters to members by tier (queued, rate-limited, one-click unsubscribe, teaser for members without access). Provider for core content access levels ([memberships.md](memberships.md)) | `database` r/w, `settings` r/w, `users` read, `posts` read, `email:admin`, routes, admin menu, `network` |
| `newsletter` | Subscriptions (double opt-in; subscribers stay pending until they confirm), subscriber CSV, HTML campaigns with unsubscribe links | `database` r/w, routes, admin menu, `email:admin` |
| `notification-bar` | Slim site-wide announcement bar with CTA, dismissal versioning, schedule window | `settings` r/w, routes, admin menu, `assets:write` |
| `online-store` | Product catalog (variants, galleries, categories) + cart + checkout with server-side price validation, coupons, shipping zones and taxes, orders admin with refunds and transactional emails, sales reports + CSV, optional Stripe Checkout | `database` r/w, `settings` r/w, routes, admin menu, `email:admin`, `network` |
| `photo-carousel` | Image carousels for Hero sections / content sliders via the `PhotoCarouselVerso` block + `[carousel]` shortcode | `settings` r/w, `database` write, routes, admin menu |
| `polls` | WP-Polls-style polls with a voting + animated-results Verso block | `database` r/w, routes, admin menu |
| `popup-builder` | Site-wide popups with triggers (delay/scroll/exit intent), frequency capping, view/click stats | `database` r/w, routes, admin menu, `assets:write` |
| `related-posts` | Automatic per-post related articles via the core public REST API (YARPP parity) | `browser:script` only (frontend-only) |
| `restaurant-menu` | Menu sections/dishes with photos, diet tags and EU-14 allergens; priced modifier groups; opening-hours gating; cart with WhatsApp hand-off, cash, or Stripe Checkout; QR table ordering, table reservations, a live kitchen board and sales reports | `database` r/w, `settings` r/w, routes, admin menu, `email:admin`, `notifications:send`, `network` |
| `social-share` | Share buttons Verso block (Facebook, X, WhatsApp, LinkedIn, Telegram, Email, copy link) — the sharing itself is entirely client-side (share intents via `window.open`, copy via the Clipboard API) | admin menu only (its `init` just registers the sidebar item) |
| `table-of-contents` | Automatic nested TOC from page H2/H3 with anchors, smooth scroll, active highlighting | `browser:script` only (frontend-only) |
| `testimonials` | Database-backed testimonials with moderation and optional public submission form; carousel/grid Verso block | `database` r/w, `settings` r/w, routes, admin menu |
| `vendor-marketplace` | Multi-vendor directory: vendor applications, admin approval, self-service listings, per-product inquiries | `database` r/w, routes, admin menu, `email:admin` |
| `video-gallery` | YouTube video carousels via the `VideoGalleryVerso` block + `[vgallery]` shortcode | `settings` r/w, `database` write, routes, admin menu |
| `youtube-videos` | Pulls a YouTube channel's videos (keyless RSS or Data API v3) into a filterable, count-limited Verso carousel block | `settings` r/w, `database` r/w, `network`, routes, admin menu |

*Every catalog plugin also requests **`browser:script`** — each ships an admin page, a Verso block or
both, i.e. compiled code that runs in the browser with the viewer's session; it is not repeated per row.
The host serves those bundles only while the plugin is active and the capability is granted
(`documentation/security.md` §1.3b).*

*(“routes” = `express:register_route`; “admin menu” = `admin_menu:register`. Every capability is
manifest-requested and admin-granted, default-deny, exactly like the bundled plugins. Both of these are
enforced grants, not just validated vocabulary: the host's `register-route` IPC handler in
`plugin-isolate.ts` refuses to mount a route (logs a warning and drops the message) unless
`express:register_route` is declared in the manifest and granted by the admin — the route-count cap and
the HTTP-verb / path-charset allowlists are applied only after that check — and `wordjs.adminMenu.add`
runs `verifyPermission('admin_menu', 'register')` in `plugin-api.ts`, which throws when the verb is not
both declared and granted. Isolated plugins reach `adminMenu.add` through the same host bridge, so the
gate applies to them identically.)*
