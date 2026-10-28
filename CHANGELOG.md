# Changelog

All notable changes to WordJS are documented here. This project follows
[Semantic Versioning](https://semver.org/). Each release is published as a pre-compiled bundle
on the [Releases](https://github.com/jaimemartinez/wordjs/releases) page.

## [Unreleased]

### Fixed
- **Microphone for the site's own pages.** The `Permissions-Policy` header now allows the microphone to the site
  itself (`microphone=(self)`), as it already did for the camera, so a call answered or placed from a plugin's admin
  page or portal has audio on Chrome, Edge and Android. Embedded third-party frames still cannot request it, and the
  browser still asks the user.

## [2.11.20] - 2026-10-28

### Fixed
- **Audit log external copy on a cluster.** The delivery position only moves forward: when another node already
  delivered further, a node finishing an older batch no longer moves it back, so those entries are not sent again.
  A successful «Send now» also resets the retry backoff.

## [2.11.19] - 2026-10-28

### Added
- **conference-manager 2.36.22: cupos at a glance and family groups in the admin's edit form.** «Localidades» opens
  with the conference's totals: assigned places (the sum of every locality's cupo), registered, places still
  available and localities without a limit. Editing a participant, the grouping field («Grupo familiar») now lists
  the groups of the person's locality, with who is in each, as the coordinator's portal does.
- **Home-screen icon for installable plugin portals.** A portal sub-page's `app` may name an `icon`: a PNG in the
  plugin's `public/` folder. "Add to home screen" then shows it, from the web app manifest and the page's
  `apple-touch-icon`. Portals without one are unchanged.

### Fixed
- **Plugin storage keys** (the folder names of a plugin's private storage) are computed in time proportional to the
  slug's length whatever the slug, and are unchanged for every existing plugin and theme.

## [2.11.18] - 2026-10-27

## [2.11.17] - 2026-10-27

### Security
- **Plugin sandbox: tighter confinement of isolated plugins on Linux, macOS and Windows.**
  - **Read-only code.** A plugin's (and a theme's) code folder is read-only at every sandbox layer. Its `data/` folder moves to
    `data/plugin-own/` on its first start (a rename, nothing is copied or lost) and stays reachable at the old path
    through a link (a junction on Windows), so plugins that keep state in `data/` work unchanged. The code and the
    manifest are fingerprinted and checked before every start; an administrator who changed them on purpose accepts
    them in **Site Health**.
  - **Network goes through WordJS, on every platform.** No plugin has a network of its own at the kernel layer any
    more (Landlock and seccomp on Linux, Seatbelt on macOS, an AppContainer without network capabilities on
    Windows), with the network permission or without it. A plugin that holds it reaches the network through WordJS,
    which decides the exact destination, resolves the name once and opens the connection: the plugin's allowed
    hosts, public addresses only unless an administrator approved a private `host:port`, and the TCP ports it may
    use. DNS and the web are always allowed; a plugin names more on its `network` permission
    (`"ports": [25, 587]`), and an approved private destination adds its own. Connections, name lookups, idle time
    and bytes are bounded per plugin and for the whole server. Plugin code does not change: `net`, `tls`, `http`,
    `https`, `fetch`, WebSocket, STARTTLS and `dns.lookup` work as before. UDP is not available to plugins. Nothing
    is configured on any platform.
  - **Linux.** The seccomp filter refuses more calls (on other processes' limits, priority and scheduling; mount
    and quota interfaces; file mode, owner and extended-attribute changes by path; signal-owner commands),
    and below Landlock ABI 3 it also refuses truncating files the plugin may only read. The launcher closes every
    inherited descriptor but stdio and the IPC channel and starts the plugin in `/`. The probe certifies each of these.
  - **macOS.** A plugin may execute only the Node binary, and file metadata is reachable only along the paths to
    what the profile grants.
  - **Windows.** The probe checks the secret folders of the install for the all-application-packages groups, removes
    their access there (or does not certify the sandbox) and certifies with a canary under the install folder. Each
    plugin's profile follows the real install path and a new generation per install; uninstalling revokes every zone
    it may hold and keeps track of a revoke that did not land; a start revokes the zones its policy no longer
    includes; every ACL change is read back, and a timed-out one is stopped with its whole process tree. Writable
    folders carry OWNER RIGHTS.
  - **IPC.** The per-start secret that authenticates the worker's messages travels on the IPC channel, never on the
    command line.
  - **Production entry.** `npm start` (`backend/server.js`) and `node monolith.js prod` refuse to start without
    `backend/dist/` instead of running the TypeScript sources; the source-mode Windows exemption needs a development
    or test run.
  - `npm run sandbox -- status | retire-all` shows what Site Health reports for the sandbox, and removes this
    install's Windows sandbox profiles before an install or a worktree is deleted.
- **mail-server 3.3.7:** declares the SMTP ports it uses (25, 465, 587 and 2525), and a relay on another port is
  explained in the console.

### Fixed
- **robots.txt no longer blocks `/_next/`, and it can be edited.** That folder holds the CSS and JS every public
  page is rendered with; crawlers that may not fetch them render the page unstyled. **Settings → Reading** has a new
  «Your own robots.txt rules» field: the lines are added after the built-in rules (one rule per line — `User-agent`,
  `Allow`, `Disallow`, `Sitemap`, `Crawl-delay`, `Host`, `Clean-param` — or a `# comment`; anything else is refused
  on save). While search engines are discouraged the whole site stays blocked and these rules are not served.

## [2.11.16] - 2026-10-27

### Fixed
- **Audit log external copy.** «Send now» answers only once the entries written while a delivery was already
  running have been sent too. On a multisite network each site keeps its own delivery status and retry timer.

## [2.11.15] - 2026-10-27

### Added
- **Audit log integrity.** Every audit entry is sealed into a hash chain. Admin → Audit and Site Health check it and
  name the first entry that was changed or removed outside WordJS (`GET /api/v1/audit/verify`). Retention keeps the
  chain verifiable.
- **External copy of the audit log.** Admin → Audit can send every entry, with its place in the chain and its hashes,
  to a syslog server (TLS, TCP or UDP) or an HTTPS webhook signed with HMAC-SHA256. Deliveries resume after an outage;
  Site Health reports a copy that is off or failing.
- **Duplicate records.** A new screen (linked from Site Health) lists logins, email addresses, page/post addresses and
  term slugs stored more than once, and resolves each one: the chosen record keeps the value, the others get a new
  unique one, nothing is deleted, and every change is audited. The unique index is then built without a restart.

### Changed
- Shortening the audit log's retention, or changing its external copy, asks for the administrator's password (and a
  2FA code when enabled). The window moved from the generic settings API to `PUT /api/v1/audit/settings`; a stored
  value under 90 days is read as 90.
- The schema migrations that build unique indexes stay pending, and run again at every boot, until their index
  exists. Sign-in, password reset and other lookups by login or email refuse a value two accounts share.

### Fixed
- **mail-server 3.3.6: the server overview counts mail on PostgreSQL and MySQL, and keeps itself current.**
  - **«Received» and «Sent · last 14 days» and the traffic chart read 0 on PostgreSQL and MySQL.** Those databases
    return dates as date values, not text, so every message was left out. They now count.
  - **The overview figures and the queue counter on the tab** update every 20 seconds while the page is open, on
    every tab change, and after «Retry now» or «Stop». Before, they only changed after a reload.
  - **The queue's sending order on PostgreSQL and MySQL** is by due time again, not by message number.

## [2.11.14] - 2026-10-26

### Added
- **mail-server 3.3.5: the relay as a backup, and direct delivery that backs off.** On a server whose provider
  limits outgoing port 25 (Hostinger allows 5 a minute), a failed delivery to Gmail tried every mail server over
  IPv4 and IPv6: up to 10 connections per message, enough to keep the limit engaged.
  - **A delivery stops after two mail servers of the recipient gave no reply at all.** Direct delivery then
    pauses for 5 minutes. Messages that would go out during the pause wait in the queue without spending a retry
    attempt, and *Configuration* shows the pause and when it ends.
  - **«Use the relay»** in the relay settings has two choices:
    - **«Always»** works as before: all outgoing mail goes through the relay.
    - **«Only when direct delivery fails»** delivers straight to the recipients' servers and sends a message
      through the relay when they give no answer or while direct delivery is paused.

## [2.11.13] - 2026-10-26

### Security
- **Plugin boundary hardening.**
  - **Plugin DDL runs under the plugin's own database user.** On PostgreSQL the plugin's role now owns its tables
    and runs its `CREATE`/`ALTER`/`DROP` itself; on MySQL/MariaDB the plugin's user is granted exactly the objects
    the statement names, just before it runs. Views and triggers a plugin creates run with the plugin's rights. When
    the site's database user cannot create per-plugin users, **Site Health** now says which plugins fall back to the
    SQL checks alone and what right to grant.
  - **Stricter plugin SQL checks.** Every name in a target list (`DROP TABLE a, b`, multi-table `UPDATE`/`DELETE`),
    the table a trigger is attached to, and the tables a `CREATE TABLE` copies or extends (`LIKE`, `INHERITS`,
    `PARTITION OF`) must belong to the plugin. `DROP` takes one object and no `CASCADE`; `DEFINER`, `SQL SECURITY`,
    `OWNER TO`, `SET SCHEMA`, tablespaces, data directories, non-InnoDB engines and trigger routines are refused.
    **SQL comments (`--`, `/* */`, `#`) are no longer accepted in plugin SQL.** The MySQL and PostgreSQL drivers'
    own comment scanners now follow their engine (`#` and `-- ` on MySQL, nested block comments on PostgreSQL).
  - **Plugin options are written by allowlist.** With `settings:write` a plugin writes only options named after its
    slug (`photo-carousel` → `photo_carousel_…`); `mail_domain` and `mail_delivery_ready` are written only by a
    plugin holding `email:provider`. The record of options a plugin created can no longer hold a site setting.
    photo-carousel 2.1.3, card-gallery 1.0.4, video-gallery 1.1.2 and mail-server 3.3.4 keep their options under
    their own names and carry over what earlier versions stored.
  - **A theme's tables are claimed under its real prefix** (`wjp_theme_<name>_`) from boot.
  - **Reserved plugin slugs.** `core`, `theme` / `theme-*` (in any spelling that normalizes to it) and anything
    starting with `@` can no longer be installed, uploaded or loaded as a plugin.
  - **Plugin shortcode output is sanitized on the server** with the same allow-list as widget output (plus inert
    `role`, `aria-*`, `tabindex` and image `loading`/`decoding`).
  - **Re-uploading a plugin asks about the data a previous uninstall kept.** When `data/` or the plugin's tables are
    still there, the upload (and a fresh marketplace install) answers 409 `existing_plugin_data` and the admin panel
    asks: keep and reconnect them, or discard them and start clean.
  - **Marketplace installs.** A fresh install must install as the catalog entry's slug; installing an older version
    over a newer one needs `allowDowngrade: true`. Catalogs can be signed with Ed25519 (a detached `<index>.sig`):
    the official catalog is checked against a key embedded in WordJS once it is configured, and an administrator can
    pin a public key per source in the sources editor, which also shows whether each catalog is signed.
  - **Plugin multipart routes bound their text fields** (count, size, name size, parts and header pairs), not only
    the uploaded file.
  - **Theme style values.** CSS escapes are refused; a value that references a token may only use the usual value
    functions; `image-set()` / `cross-fade()` must use `url()`; and a `url()` must resolve under the theme's own
    `/themes/<slug>/` folder, percent-encoded dot segments included.
  - **Plugin yes/no flags are strict booleans.** `DELETE /api/v1/plugins/:slug` accepts `dropData` and
    `POST /api/v1/plugins/:slug/permissions` accepts `network` only as `true` or `false` (absent = the default);
    any other value is answered 400 and changes nothing.

## [2.11.12] - 2026-10-26

### Security
- **Cluster hardening: the gateway, its control plane and the frontend's Content-Security-Policy.**
  - **Each upstream must prove the role it serves.** The gateway now checks that an upstream's cluster certificate
    names the role that owns the route (backend for `/api`, frontend for pages), with one connection pool per role,
    for proxied requests, WebSockets, health checks and cache purges alike.
  - **No loopback fallback after a node has registered.** The pre-install route to the services on the gateway's own
    machine is used only until each role registers once; after that, a node that stops answering gets a 503.
  - **Registered targets are checked in one canonical form.** A target URL is reduced to its origin before any check,
    ownership compares the listener (every loopback spelling, either scheme), a loopback target is accepted only from
    a node on the gateway machine, and a node on another machine must register an HTTPS target.
  - **Multisite relays need proof.** The gateway takes a frontend node's `X-Forwarded-Host` only together with a
    proof derived from the cluster's revalidate secret, which the frontend now sends with its server-side reads.
  - **The gateway secret goes to backend nodes only**, and the unused `/api/internal/gateway-update` hook is removed
    from the backend.
  - **TCP forwards reach mail ports only** (25, 110, 143, 465, 587, 993, 995, 2525, 4190, or the port the backend's
    inbound SMTP listener holds), changing them asks for the two-factor code of an account that has one, and
    `tcpForwardBind` in `gateway-config.json` can narrow them to one address.
  - **CSP.** The frontend writes its Content-Security-Policy per request (`src/proxy.ts`). The admin, the
    sign-in screens, install, migration and portals get a fresh nonce with `'strict-dynamic'` and no
    `'unsafe-inline'`. The public pages stay on ISR and keep `'unsafe-inline'`, but `script-src` no longer allows
    every https host — only the origins active plugins declare (new optional `origins` on
    `wordjs.assets.enqueueScript`; analytics-tag 1.1.0 declares its configured provider). Every document adds
    `form-action 'self'` and `script-src-attr 'none'`; the backend's and the gateway's own policies no longer
    allow inline script (their pages carry none).
  - **Certificate and cluster switches are booleans.** `staging`, `enabled` and `sslEnabled` (Security → SSL and
    automatic renewal), the gateway's own `sslEnabled`, and a TCP forward's `proxyProtocol` accept `true`/`false` or
    nothing, and answer 400 otherwise; `renewBeforeDays` is a whole number from 1 to 60.
  - **Forwarded headers.** The gateway no longer forwards hop-by-hop request headers (the fixed set and every
    header `Connection` names; an upgrade keeps only `Connection: upgrade` and `Upgrade`), the gateway and the
    monolith drop a client's `x-wordjs-site-route`, and the multisite rewrite never matches `/_next/` assets or
    `/favicon.ico`. Proxied calls no longer pass `secure: false`; only the pre-install bootstrap without a cluster
    identity skips verification.

### Fixed
- **mail-server 3.3.3: the queue fits a phone.** A delivery error with an address glued to a colon («name@gmail.com:
  Direct delivery … Connection timeout») could not wrap, and widened *Email Center → Server → Queue* past the screen on a
  phone. Such errors now wrap inside their card, in the queue and on a message in *Sent*, and the queue's buttons wrap
  under the message when there is no room beside it.
- **The inbound mail listener reports the server's IPv6 addresses too.** A mail plugin runs sandboxed and cannot
  list the network interfaces, so it relies on the addresses WordJS reports with the listener status. Those were
  IPv4 only. Now the global IPv6 addresses travel with them, so mail-server's DNS tab lists and checks the IPv6
  address mail also leaves from. Link-local, private (ULA) and documentation addresses are left out.
- **mail-server 3.3.2: direct delivery tries the other IP family when one cannot reach the recipient's server.**
  Some VPS providers filter or rate-limit outgoing port 25 on IPv4 while IPv6 still works, or the reverse. Each
  delivery waited out a connection timeout on every mail server of the recipient and then gave up with
  «Connection timeout».
  - **When an address does not answer**, the message is sent to the same mail server over its other address
    (IPv6 or IPv4).
  - **The family that got through is tried first** for the following messages, so they no longer wait for the
    timeout.
  - **When a server refuses IPv6 senders it cannot verify** (no reverse DNS, as Gmail does), the message is
    tried over IPv4 before it counts as failed.
  - **The DNS tab covers every public address mail leaves from, IPv4 and IPv6.**
    - **Records:** it proposes an AAAA record for the mail host when the server has a public IPv6, and an SPF
      value that names both addresses.
    - **Checks:** for each address, it checks that the mail host points to it, that the SPF authorizes it, and
      that the name the server announces (HELO) resolves back to it.
    - **Reverse DNS (PTR):** WordJS cannot look it up, so it is shown per address, with the exact value to ask
      the hosting provider for.

## [2.11.11] - 2026-10-26

### Fixed
- **mail-server 3.3.1: a slow destination no longer restarts the mail server.** WordJS gives an isolated plugin
  30 seconds to answer, and stops it when it takes longer. Delivering straight to a mail server that does not
  answer can take minutes, so «Retry now» answered «Isolated plugin error» and the mail server was restarted
  in the middle of the delivery. A site message cut off that way (an account e-mail, a plugin's mail, a
  notification) stayed «queued» in *System sent*, did not appear in the queue and was never retried.
  - **«Retry now»** (in *Queue*, *System sent* and a message in *Sent*) answers within 10 seconds. A delivery
    still running then goes on in the background, the message shows as retrying, and its status updates by
    itself. A second click while it runs starts nothing. If that delivery never reports back, the queue
    retries the message 15 minutes later.
  - **Sending from the mailbox** with the undo window off, **the delivery test** and **site mail** answer within
    20 seconds. Site mail is reported as accepted and is delivered in the background. The test says the
    recipient's server has not answered yet, and its result appears on the test message in *Sent*.
  - **Site messages stuck as «queued»**, whose first delivery was cut off between 15 minutes and 3 days ago, go
    back to the queue by themselves.
  - **The queue lists only what is still waiting to go out:** scheduled sends and retries. A permanent failure
    stays in *System sent* (status «Failed») and on its message in *Sent*, and it is retried from there. The
    queue figure on the overview and the tab counter count only scheduled sends and retries.

## [2.11.10] - 2026-10-26

### Security
- **Untrusted input, downloads and the updater, hardened.**
  - **URLs in shortcodes.** `escUrl` percent-encodes quotes, angle brackets and backticks in every scheme, and the
    `[embed]`, `[button]`, `[audio]` and `[video]` shortcodes escape each URL for its attribute. Media sources accept
    `http(s)` only.
  - **SVG uploads and imports.** URL attributes (`href`, `xlink:href`) are scheme-checked explicitly, `style` keeps
    presentation properties with plain values or a same-document `url(#id)`, `<image>` no longer accepts `data:`
    URLs, and camelCase SVG elements (`linearGradient`, `clipPath`, filters) are kept instead of being dropped.
  - **WordPress import, private source.** "Allow downloads from this site's private address" is offered and honoured
    on the primary site only (or anywhere with `WORDJS_IMPORT_ALLOW_PRIVATE_SOURCE=1`; elsewhere `403
    private_source_not_allowed`). Loopback is refused in every numeric spelling, and from a private source only files
    whose content signature confirms their type are stored.
  - **Download deadlines.** WordPress-import attachments (`deadlineMs`, default 5 minutes) and marketplace downloads
    (2 minutes) now have an absolute time limit besides the idle timeout; the update check closes its socket at 10 s.
  - **Inbound SMTP (`smtp:inbound`).** The host listener reserves every in-progress message from one in-flight byte
    budget and answers `452` when it is spent; one client address may hold a limited number of connections (`421`
    beyond it). New listen options: `maxInflightBytes`, `maxClientsPerIp`.
  - **Admin → Updates.** The panel runs the upgrade CLI shipped inside the installed release with the server's own
    Node binary and no shell, instead of fetching `create-wordjs@latest`, and refuses a release that publishes no
    checksum (`409 update_unverified_release`, shown on the screen). The supervisor's rollback does the same.
  - **`create-wordjs`.** A release without a checksum is refused unless `--allow-unverified` is passed. The release
    workflow signs the checksum file (`wordjs-<tag>.zip.sha256.sig`, Ed25519) when its signing key is configured, and
    the CLI verifies a published signature against the public keys embedded in the package.
  - **Site import.** Custom tables are limited to the `wjp_<slug>_` tables of plugins and themes installed on the
    site; the export carries plugin and theme tables only.
  - **Egress guard.** `198.18.0.0/15` and the local-use NAT64 prefix `64:ff9b:1::/48` are treated as internal.
  - **Removed** the unused JSON-LD and meta-tag builders from `core/seo-helper` (the frontend renders structured
    data with its own escaping).
  - **Author ids and names.** Every `id` in post, comment and block HTML is namespaced as `user-content-<id>` (stored
    by the backend, applied again by both frontend sanitizer paths), and `name` survives only on form controls, so
    author markup cannot shadow properties the page relies on. In-page links to the plain fragment (`#intro`) still
    land on the prefixed target.
  - **Embeds.** Every embedded `<iframe>` gets the site's own `sandbox` and `allow` values, replacing the author's.
  - **WordPress import.** Entities in text nodes are decoded (titles and attachment URLs come out as WordPress showed
    them); a file with a `<!DOCTYPE` is refused; a form option sent more than once is refused with `400
    rest_invalid_param`.
  - **Multipart limits.** Every upload route (site import, fonts, WordPress import, plugins, themes, media, GraphQL)
    bounds field count, field and field-name size, parts and header pairs.
  - **Inbound SMTP.** No reverse-DNS lookup per connection (`clientHostname` is the address literal), a 5-second
    shutdown grace and a cap on unauthenticated commands.

### Added
- **conference-manager 2.36.21: rename a locality.** The pencil next to its name on the «Localidades» card edits it in
  place (Enter saves, Escape cancels). An empty name, or one another locality of the conference already has, is
  refused with the reason; the new name also reaches that locality's registrations.

## [2.11.9] - 2026-10-26

### Security
- **Content authorization follows the record it touches.**
  - **A trashed entry is read-only until it is restored.** Editing it in place (content, meta, language,
    translations, a revision restore, live collaboration) answers 409 `rest_post_trashed`, and the post and page
    editors show a «Restore» screen instead of the editor. Deleting a trashed entry for good, or restoring it, is
    judged by the status it had before the trash. GraphQL's `restoreContent` now goes through
    `POST /posts/:id/restore`, like the admin, and applies a requested `status` afterwards with an ordinary update.
  - **Comment moderation is scoped to the entry.** Holding `moderate_comments` / `edit_comments` lets a role
    moderate the comments of the entries it may edit. The moderation list and its totals, the single-comment read
    and every moderation action follow that rule, and a comment edit by a role without `moderate_comments` no
    longer returns the commenter's e-mail and IP.
  - **`GET /media/:id/usage`** follows the item's read rule and counts only the entries the caller may read.
  - **Revision history** is read by the people who work on the entry: its author while they still hold the
    type's edit capability, or whoever edits others' entries of that type.
  - **`/types`** shows the definition of a type whose entries are not public only to callers who may edit them.
- **Request bodies are checked before they are used.**
  - **Ids in a body** (a comment's post and parent, a form's page, a post's parent and menu order, media
    folders and the media moved into them, a category's or menu item's parent) must be ids an id column can hold;
    anything else is a 400/404 instead of a database error. The models' lookups by id answer "not found" for such
    a value.
  - **`POST /roles`** takes a text name and a list of at most 500 capability names; the capabilities list
    ignores a malformed role stored earlier.
  - **`PUT /comments/:id`** normalizes the author and email like a new comment, and answers 400 for an unknown
    status.
  - **`PUT /menus/items/:itemId`** writes only a menu item's own fields, each checked, and a menu location must
    be a name.
  - **A webhook's `active`** must be `true` or `false`, and a new taxonomy's `public`, `showInRest` and
    `showInMenu` are always stored as booleans.
- **Multisite.** `/health/details` and `/health/site` on the main site take a network administrator. A network
  administrator's handoff account on a site can no longer be deleted by the site's administrators or rewritten by a
  site import; the network manages it.

## [2.11.8] - 2026-10-26

### Added
- **conference-manager 2.36.20: «Cierre de inscripciones».**
  - **A general date.** The «Campos» section has a new «Cierre de inscripciones» date and hour. From then on the
    coordinators' portal registers nobody: «Registrar Nuevo» is disabled and the portal says when registration
    closed. The administration can still register people. Without a date, nothing changes.
  - **A date per locality.** Each card in «Localidades» shows the date in force for that locality. «Cambiar» gives
    the locality its own date, earlier or later than the general one, and «Usar la general» drops it again.
- **conference-manager 2.36.19: filters in «Localidades».**
  - **Search:** by the locality or its coordinator (name, phone, e-mail). Accents are ignored, every word must match,
    and a number matches the phone's digits.
  - **Quick filters with counts:** Hospedaje por validar, Hospedaje validado, Sin encargado, Sin correo del
    encargado, Bienvenida pendiente (never sent, or sent to an old address), and Cupo lleno. A filter appears only
    when it would show something.
  - **The result:** «n de total localidades» with «Quitar filtros», and a message when nothing matches.
- **conference-manager 2.36.18: meal groups.**
  - **Companions for minors.** «Turnos» has two new settings: «Edad para contar como menor» (empty = off) and
    «Acompañantes por menor». A priority member younger than that age brings up to that many family members without
    points into their group, instead of «Acompañantes por persona prioritaria» (which still applies to adults).
  - **One approximate time per group.** «Mi inscripción» now says «Grupo C · hacia las 12:15», the start of the
    group's turn rounded to 5 minutes, instead of an exact «Tu turno: 12:10–12:25». The exact range no longer
    reaches the phone.

### Security
- **Sign-in, sessions and two-factor authentication hardened.**
  - **One reading of the `Authorization` header.** The two-factor policy, every authenticator, the AI-agent
    endpoint and its rate-limit bucket now read the Bearer credential through one shared function, and the policy
    for API tokens and agent connections is also checked inside the authenticators that accept them.
  - **Signing out lasts.** A signed-out session stays revoked for a full session lifetime, including copies of it
    refreshed earlier.
  - **The live notification stream is re-checked** while it is open, like the collaboration stream: signing out,
    «sign out everywhere», a password change, a revoked API token, a deleted account or a two-factor requirement
    closes it. Query tickets carry the session they were issued from.
  - **Confirming authority over privileged accounts.** Creating an administrator (or an account with a role that
    manages users, roles or settings), promoting an account into such a role, changing another privileged account's
    password or address, and resetting anyone's two-factor authentication now ask for your password, plus a current
    code when your account has 2FA. The admin shows the fields when they are needed; one confirmation covers a
    bulk role change for a few minutes.
  - **Stored connection secrets stay with their server.** Testing Redis or S3 media storage against another
    server, port, database, endpoint, region or bucket with the saved password or secret asks for your password.
  - **AI agents.** Turning off «require a person to confirm what agents publish» follows the same two-factor rule
    as granting an agent, and granting an agent is refused to the sessions that cannot create one.
  - **Passwords and recovery.** The current-password check always uses your own account. Changing a password (or
    an administrator changing someone's address) cancels a reset link already sent. Password recovery and sign-up
    with email verification answer at a fixed pace. The code used to turn on two-factor authentication is spent.
    Expired pending registrations are all pruned.
  - **Password length is measured the way it is stored.** A new password may be at most 72 bytes (accented
    letters count as 2, emoji as 4) on every screen and endpoint that sets one; the forms say so before sending.
    Signing in with an existing password is unchanged.
  - **Settings and inputs.** «Anyone can register», «require email verification» and the two comment e-mail
    switches are stored as on/off and read the same way everywhere; any other value is refused. API-token and
    agent lifetimes are whole days from 1 to 3650. Display names are plain text, trimmed, at most 250 characters.
  - **Single use means single use.** A password-reset link and a two-factor sign-in challenge are each consumed
    atomically, so concurrent requests cannot both use them.
  - **Rate limits and secrets at rest.** The sign-in, registration/recovery and installer rate limits keep
    counting on each server while Redis is unavailable. The audit digest of unknown sign-in names uses its own
    derived key. Two-factor backup codes are stored salted and slow-hashed; codes created before keep working.

### Fixed
- **GraphQL, streams and health probes: tighter resource bounds.**
  - **Query limits.** A scalar leaf now costs 0.1 in the cost limit, multiplied by the page it sits on like any
    other field. An operation may select at most 1000 fields once its fragments are expanded
    (`WORDJS_GRAPHQL_MAX_FIELDS`) and one selection set at most 50 aliased fields (`WORDJS_GRAPHQL_MAX_ALIASES`).
    A result larger than 16 MiB (`WORDJS_GRAPHQL_MAX_RESPONSE_BYTES`) is answered with a
    `GRAPHQL_RESPONSE_TOO_LARGE` error; it is measured before it is serialized.
  - **Rate limiting.** Each REST read a GraphQL query makes after the first now counts against the API rate
    limiter, so a query costs the budget what the REST calls behind it would.
  - **Uploads.** A multipart GraphQL request passes `POST /media`'s authentication and `upload_files` check before
    its body is read. Each file is held to the site's upload limit from Settings → Media, the files of one request
    together to that same limit, and every file after the first counts once more against the upload limiter.
  - **Subscriptions.** The per-caller stream cap holds when many streams open at once, a stream abandoned while it
    is being set up gives its slot back, and a caller without a signed-in user is counted by address (an IPv6 client
    by its /64). The reads a stream makes while opening (`ids:`, a `Last-Event-ID` resume) count against the API
    limiter; an anonymous resume replays at most 50 events.
  - **Hook inspector.** `GET /api/v1/hooks/stream` takes an administrator's interactive session only (not an API
    token), and at most 3 streams per user and 20 per process (`429 rest_hook_stream_limit`).
  - **Health probes.** `GET /health` and `GET /api/v1/health` answer from one cached database check (1 s) with the
    readiness deadline (`WORDJS_READINESS_TIMEOUT_MS`), like `/readyz`.
- **conference-manager 2.36.20: the cupo editor on a locality card no longer pushes «Cancelar» out of the card.**
- **conference-manager 2.36.17: «Autorizaciones» shows its list on a computer again.** On a site built before 2.36.16,
  the desktop table and the phone cards were both hidden on a wide screen, so a computer showed no list. The plugin's
  `lg:table` lost to the site's `hidden`, and the site's own `lg:hidden` hid the cards. Which of the two is drawn is
  now decided by the screen's width in the page itself, so it no longer depends on which classes the site compiled.
  The status summary wraps without a breakpoint class.
  A search of every CM screen for the same pattern found one more: the keyboard hint in the lodging explorer
  used a breakpoint class only the plugin had, so it never showed on a computer. It now uses one the site compiles.
  The plugin README explains the rule for future screens.

### Added
- **conference-manager 2.36.16: «Autorizaciones», redesigned.**
  - **Three tabs:** «Personas» first, then «Hoja en papel» and «Configuración». The 20-field settings form no
    longer sits on top of the list.
  - **One status per person**, in plain words with a color and an icon: Sin autorización, Autorizado (verbal),
    Vencido (past «Días para confirmar» without the written confirmation), Confirmado (código), Confirmado (papel)
    and Retirado. A line under it says where the request stands: sent, never sent, the e-mail did not arrive, the
    link expired, or no e-mail.
  - **Summary that filters:** the count for each status is a button that filters the list.
  - **Search and filter:** search by name, document or locality, and filter by locality.
  - **No sideways scrolling:** a table from 1024 px and cards below it; long names, localities and e-mails wrap.
  - **Main actions in every row:** «Ver», «Enviar solicitud» and «Copiar mensaje / WhatsApp».
  - **Selection:** «Enviar solicitud» to everyone chosen who can be e-mailed, and «Hoja en papel» for the chosen
    people of one locality. The sheet-create action accepts an optional `inscription_ids`; there is no new route.
  - **Each person in a sheet:**
    - the status explained;
    - what they authorized (data, health, image);
    - the actions that fit — send, copy, paper, withdraw, download the record (WordJS administrators);
    - their timeline (verbal by whom, link sent, confirmed by code or on paper, withdrawn).
  - **Unchanged:** permissions, the consent rules and the evidence. Texts are in es/en/pt, and all dialogs are
    in-app.
- **conference-manager 2.36.15: «Mi escarapela» works without a connection.** When the person chose «Recordar en
  este teléfono», their badge (name, conference, locality, code and the badge itself) is kept on the phone, and the
  page's service worker keeps the page so it opens with no connection.
  - **Offline**: the kept badge shows with a small «Sin conexión» icon and when it was saved. The icon also appears
    when the connection drops while the page is open.
  - **Back online**: the live page loads again.
  - **What is kept**: only the badge part — never the answers, meals, hotel or bus. «Salir» deletes it, and it
    expires with the event.
  - **What is never cached**: the plugin's API and the PDF tickets always go to the network.
  - **Without «Recordar»**: one line under the badge says how to have it offline.

## [2.11.7] - 2026-10-24

### Added
- **conference-manager 2.36.14: «Plantillas de correo», redesigned for a coordinator who knows nothing about markup.**
  - **The list**: one card per e-mail, with its name, when it is sent, «Personalizado» (and in which languages) or
    «Original», the date of the last edit, and «Editar».
  - **The editor**: the form sits beside a live preview, rendered by the server as you type, with a desktop/phone
    switch. On a phone the form and the preview take turns under a sticky «Editar / Vista previa» switch. Each
    field has a plain label, a one-line hint and an example.
  - **Formatting without markup**: a toolbar (Negrita, Lista, Enlace) inserts the formatting at the cursor. A link
    is entered as its visible text plus an address, and the address must start with https:// (or mailto:).
  - **Data placeholders by name**: they read as names («{Nombre de la persona}») and are inserted from chips that
    show an example value. They are still stored as before.
  - **Languages and saving**: languages are tabs, with a dot on the ones that are customised. A sticky footer holds
    «Guardar», «Enviar prueba a mi correo» and «Restaurar original» (with an in-app confirm), and says when there
    are unsaved changes. Leaving with unsaved changes asks first.
  - **Checks in place**: an empty subject, an empty text, and a link without https:// are flagged under their
    field.
  - **Unchanged**: the texts are still plain text with the small format, typed HTML still shows as text, and the
    link, code and authorization record are still drawn by the system. Routes are unchanged.

### Fixed

- **Admin table cards fit a phone even when a summary holds a long URL.** After 2.11.6 the audit cards still scrolled sideways through the detail summary («source: https://…»): its pairs are `break-words` spans, and `overflow-wrap: break-word` does not shrink an element's minimum width. Inside a DataTable card `break-words` now breaks anywhere (`app/globals.css`), and the audit summary pills may shrink.

## [2.11.6] - 2026-10-24

### Fixed

- **Admin tables no longer scroll sideways inside their card on a phone.** Below the breakpoint a DataTable row is a card in a grid with no explicit column, so the track grew to the longest unbreakable word in any card: one long URL in an audit entry made every card wider than the screen. The card grid now has one shrinkable column, cards may shrink, and card cells wrap anywhere (`components/ui/DataTable.tsx`); the audit action chip wraps too.

### Added

- **Admin › Auditoría: choose how long the audit log is kept.** A «Conservar registros» select (90 days, 6 months, 1 year, 2 years, forever) sets `audit_retention_days`, which the daily prune already honoured (default 1 year). The setting is admin-only and validated to those values.

### Added
- **mail-server 3.3.0: «Enviados del sistema».** *Email Center → Server* has a new tab, after *Queue*, with the mail
  the site sent on its own (account, comment and template e-mails, notifications, other plugins' mail), which until
  now could not be seen once it was delivered. A user's own mail is not recorded: it has its Sent folder.
  - **The list** shows the date, recipient, subject, source and a status chip (queued, delivered, retrying, failed)
    that follows the delivery. It has a search by recipient or subject, filters by status, source and dates (the
    admin's calendar), and pages.
  - **A message** opens with its headers, the HTML in a frame that can run nothing (sanitized again on the server)
    with remote images off until asked for, and a «Texto» tab. A failed or retrying message offers «Reintentar» and
    a link to the queue while it is still there.
  - **«Conservar historial de envíos del sistema»**: 7, 30 (the default), 90 or 180 days, or «No guardar», which
    stores nothing. Older messages are deleted every hour; a shorter period deletes them at once, after asking. The
    setting says the copies can hold personal data.
  - **Administrators only**, and bodies are never written to the logs. Two routes are added (48 of the host's 200).
  - The server console's new strings are also in Portuguese; its other strings stay in Spanish for a Portuguese
    admin, as before.
  - The date filters use the admin's calendar, so the plugin now requires WordJS 2.10.0 or later.
- **conference-manager 2.36.13: «Enviar por correo» wherever the admin shares a badge.** It is in a person's badge
  actions (from «Escarapelas › Personas» and from the person sheet), and as «Correo» on each row of the person list.
  - **Only with an e-mail on file**: without one, the action is hidden and the sheet explains why («no tiene correo
    registrado»), as in the portal.
  - **Confirm and result**: it asks first, in place, showing the masked address; the result shows as a toast.
  - **Same e-mail as the portal's «Enviar»**: the editable «Plantillas de correo» template and the badge_mails
    audit (which now records the admin who sent it).
  - **One e-mail per person every 5 minutes**, whoever sends it (admin or portal).
  - **Who can send**: whoever may share the badge («Escarapelas › ver» with the registrations).
  - It shares the route of «Regenerar enlace», so the plugin registers no new route.
- **conference-manager 2.36.12: «Editar encargado».** All of a locality's coordinator data can be changed after
  the locality is created.
  - **Where**: the card's «Editar encargado» opens a dialog (a bottom sheet on a phone) with three fields:
    - the name;
    - the phone, using the same country + number selector as every phone field, stored in E.164 with the
      conference's default country;
    - «Correo del encargado».
  - **Saving and checks**:
    - Only what changed is sent. An old phone typed before E.164 is left as it is unless it is edited.
    - Each error is shown under its field, and the server checks the same rules.
    - Creating a locality applies the same rules, and its form now also asks for the coordinator's e-mail.
  - **Audit**: every change is logged as «Encargado editado», with who, when and which fields (never the values),
    and shown under «Cambios del encargado».
  - **New e-mail after a welcome**: the card says «No enviado al nuevo correo» and offers «Enviar bienvenida». The
    address each welcome went to is now stored; earlier sends take it from the send log.
  - Team members without «Localidades» no longer receive the coordinator's e-mail, the welcome stamps or the change
    log in the locality list, just as they already did not receive the name and phone.

- **conference-manager 2.36.11: «Plantillas de correo» and the welcome to a locality's coordinator.**
  - **Plantillas de correo** (WordJS administrators) covers every e-mail the plugin sends: the consent link, the
    one-time code, the copy of what was authorized, the badge, and the coordinator's welcome. Each can be
    edited in Spanish, English and Portuguese:
    - its subject, the text before and after the part the system draws, and the button's label;
    - placeholders inserted with a tap, and a live preview at desktop or phone width;
    - «Enviar prueba» to your own e-mail and «Restaurar original».
  - **What cannot be edited**: the link (and its single-use token), the code and the record of the authorization
    are drawn by the layout. No template text can drop them, change them or copy them elsewhere.
  - **Texts are never HTML.** They are plain text with a small format (**bold**, «- » lists,
    [text](https://…) links); anything typed as HTML shows as text. Each e-mail goes out as a responsive,
    e-mail-safe HTML message with a plain-text version.
  - **«Correo del encargado»** on each locality, with «Enviar bienvenida» / «Reenviar» and when it was last sent.
    - The welcome explains the portal and links to it, and gives the administration's contact when
      «Autorizaciones» has one.
    - It **never** carries the access code: the coordinator asks the administration for it.
    - It can be sent once a minute and five times an hour per locality, and every send is logged.
  - **Fewer registered routes (204 → 183).** Sibling actions on the same resource now share one route
    (for example, reject / return / validate on a fee payment), so the plugin stays well under the host's limit of
    200 routes. Every URL and every permission check is unchanged.

### Fixed

- **conference-manager 2.36.10: every use of the health answers follows the data authorization.** The person's
  health answer in the edit form and the meal priority now use the same rule as the roster and the export. While a
  conference asks for the data authorization, they count an answer only when the person authorized their health
  data, in writing or verbally to their coordinator. Because the meal groups (shown on the meal scanner, the
  person's page and the badges) come from that priority, they follow the same rule. All these reads go through one
  shared helper. Editing a health answer under a live authorization (written, or the verbal one already recorded)
  no longer asks staff to tick the verbal statement again. Every edit is still logged («health_entered», with
  whether it rests on the written or the verbal authorization, never the answer). Without an authorization the tick
  is still needed, and after a revocation no edit is accepted.
- **conference-manager 2.36.10: registrations made by staff record the person's verbal authorization of their
  personal data.** While a conference asks for the data authorization, the admin's «Nueva inscripción» and the
  coordinators' «Registrar nuevo» have a required box: «La persona me autorizó verbalmente a tratar sus datos
  personales…».
  - **Without it the registration is not saved**: an error under the box on the screen, and a refusal from the
    server.
  - **The health box appears only when health data was entered** (conditions, «Otros», blood type or EPS); then
    both boxes are required.
  - **Recorded like the verbal health one**: who, when, the statement and the policy version, as «verbal».
  - **Shown in the consent list and the portal**: «Datos: autorización verbal, falta confirmarla por escrito».
  - **Confirmed** by the person's written authorization (code or paper); **cleared** when they revoke everything.
  - **Both boxes at the end of the form**, right above «Guardar».
  - **When editing**:
    - an authorization already recorded (written or verbal) shows ticked and locked; only «Revocar» withdraws it,
      and the server refuses to clear it;
    - a person registered before this version, with none recorded, needs the personal-data box to save a change
      to their data, plus the health one when health data is present; the tick is then recorded;
    - a person who revoked everything is not asked again.
- **conference-manager 2.36.10: «Historial» in the person's sheet (admin) and the participant's sheet (portal).**
  - **What it lists**: who registered the person and how (administration or portal), every edit with who, when
    and which fields changed (never their values), withdrawals and restores, and the data-authorization events.
  - **What it hides**: health events and health edits are shown only to «Datos de salud». The portal sees neither
    them nor the internal notes, and it shows «Administración» instead of an administrator's login.
  - **New records**: from now on each registration records who made it and each edit who made it
    (`created_by`, `updated_by`).
  - **Older registrations**: say «Sin registro».

- **Admin › Auditoría fits a phone.** Below lg the log is cards, but the «Objetivo» cell never wrapped, so a long target (a URL, an email, an id) widened the page sideways. It wraps on phones now (no-wrap only in the desktop table), and a raw actor id can break anywhere (`app/admin/audit/page.tsx`).

## [2.11.5] - 2026-10-24

### Added

- **conference-manager 2.36.9: «Tipo de sangre» and «EPS» in the health section.**
  - **Tipo de sangre**: a list with A+, A−, B+, B−, AB+, AB−, O+, O− and «No sabe». **EPS**: plain text (the
    insurer's name), with no list. Both are optional and independent of the conditions: «Ninguna» or «Prefiero no
    responder» keep them, and on a required health field they do not count as an answer.
  - **Health data, with the same rules**:
    - stored only with the health authorization (written, or the coordinator's verbal one);
    - deleted with it (revocation, a signature without health, the purge after the event, deleting the field);
    - shown only with «Datos de salud › ver».
  - **Where they appear**: the admin's inscription form, the coordinators' portal, the person's own consent page
    (es/en/pt), and next to the conditions in the roster, the person's sheet and the Excel/CSV export.
  - **Consent text**: the default health text now names the blood type and the EPS. A conference already signed
    on the default keeps the text it was signed with, under the same version number; to show the new text, the
    admin publishes a new version.
  - **Upgrades**: existing installs get the two new columns automatically (SQLite, PostgreSQL, MySQL), and older
    answers load and export unchanged.

### Changed

- **conference-manager 2.36.7: the signed consent sheet can be uploaded as photos.** (The owner: «para subir la
  autorización firmada puede ser también imagen».)
  - **The button**: «Subir foto o PDF firmado», used by the admin's *Autorizaciones* and the coordinators'
    portal. It takes several files at once (one photo per page) and offers the gallery and files.
  - **«Tomar foto»** opens the camera straight away on a phone, as a second button, so the gallery stays
    available.
  - **Formats**: JPG, PNG, WebP and iPhone HEIC. A photo is reduced in the browser to about 2000 px at JPEG
    quality 0.85, within the 2 MB a sheet file may weigh, so the handwriting stays readable and uploads stay
    fast.
  - **HEIC**: converted to JPEG where the browser can read it. Otherwise it is refused with a clear message (upload
    it from the iPhone, or set the camera to «Más compatible»), on the page and on the server. A PDF or a HEIC
    with no type (Windows) is recognised by its name.
  - **Evidence**: photos show in the sheet's viewer and count exactly like a PDF. Each page's SHA-256 is in the
    audit and in the «granted» record of everyone ticked from the sheet.

### Fixed

- **conference-manager 2.36.8: copying a link works on phones.** (The owner: «en móviles CM no me deja copiar el
  link de inscripciones».)
  - **The cause**: on a site served over http (a LAN address, a site before its certificate) the browser has no
    Clipboard API. The fallback then selected its hidden field with `select()`, which selects nothing on an
    iPhone, so nothing was copied. The link was then shown in a toast that disappears and cannot be selected on a
    phone. Some buttons had no fallback at all and failed silently.
  - **One copy helper** for every «Copiar enlace / mensaje / código» on the admin and the coordinators' portal.
    It writes the clipboard inside the tap, and falls back to a field selected the iPhone way. It says «Copiado»
    only when something was really copied.
  - **When the phone still refuses**, the link or message opens in a field to copy by hand («Mantén presionado el
    texto…»), with «Copiar de nuevo» and, on phones, «Compartir» (WhatsApp, Messages…).
  - **«Compartir»** next to the registration link's «Copiar enlace» on phones.
  - **«Copiar mensaje»** of the data authorization starts the copy in the tap, while the new link is still being
    made.

## [2.11.4] - 2026-10-24

### Fixed

- **Typing on a phone no longer zooms the page.** iOS zooms in whenever a field whose text is under 16px gets focus, and core and plugin fields were 14px. Below the md breakpoint every text field, select and textarea is now at least 16px (`app/globals.css`, unlayered so it also covers plugin fields); deliberately large fields keep their size, desktop is unchanged, and pinch zoom stays available.

## [2.11.3] - 2026-10-24

### Changed

- **conference-manager 2.36.6: a simpler Participantes screen in the coordinators' portal.**
  - **«Consentimiento en papel» is a blue button** next to «Registrar nuevo», with the same style. It shows while
    the conference asks for the data authorization and opens the paper consent above the list. It is no longer
    folded inside «Herramientas de la localidad».
  - **«Escarapelas de tu localidad» is gone**: the copy-all, print and PDF buttons for the whole locality. Each
    person's badge (view, copy link, WhatsApp, PDF) stays in their sheet, section «Escarapela». The admin's
    *Escarapelas* screen is unchanged. Their two portal routes, `POST /portal/badges/links` and
    `POST /portal/badges/ticket`, are removed: nothing else called them.
  - **«Herramientas de la localidad» is removed**: with both of its tools moved or gone, the panel was empty.
  - **A person's «Escarapela» has three actions**: WhatsApp, Copiar enlace and Enviar. «Ver» and «PDF» are gone.
    - *WhatsApp* shows only when the person has a phone on file. It uses the number as the consent message builds
      it, the conference's default calling code included, and the message carries the link plus a few lines on how
      to use it.
    - *Copiar enlace* is always there.
    - *Enviar* shows only when the person has an e-mail on file. After an in-app confirmation naming the (masked)
      address, it e-mails the person their badge link with instructions: open it, keep it on the home screen, turn
      on the notices for meal calls and boarding, and keep it to themselves. The e-mail is in the conference's
      e-mail language (*Autorizaciones › Idioma de los correos*); a toast says how it went.
    - **Limits and errors**: one e-mail per person every 5 minutes. A site without mail, or a plugin without the
      e-mail permission, gets a clear error, never a silent «sent».
    - **Audit**: every attempt is recorded (who, to which address, when, sent or why not).
    - **Missing actions explained**: a short hint says when WhatsApp or Enviar is missing because there is no phone
      or e-mail.
    - **Scope**: the server only acts for the coordinator's own locality.
  - **A section menu instead of the row of tabs.** The admin's fifteen sections no longer scroll sideways in one row,
    even on a wide screen. One button names the section you are in («Sección: Inscripciones ▾») and opens them all,
    grouped (Personas · Dinero · Logística · Configuración) and searchable, on a computer and a phone. A role still
    sees only the sections it may open.
  - **Fixed: «Pagos de cuotas» re-rendered in a loop while loading** («Maximum update depth exceeded» in the
    console).
  - **Coordinators can withdraw registrations, until a deadline the administrator sets.**
    - **The deadline**: in *Localidades*, «Los encargados pueden retirar inscripciones hasta» (date and time, the
      admin's calendar). Empty means coordinators cannot withdraw.
    - **In the portal**: a person's sheet offers «Retirar inscripción» until then, with an in-app confirmation naming
      the person and an optional reason, and the list says «Puedes retirar inscripciones hasta…».
    - **Payments**: a registration with any payment recorded cannot be withdrawn by the coordinator («Tiene pagos
      registrados: pídele al administrador que la retire»).
    - **Server checks**: the deadline, the payments and the coordinator's own locality are all re-checked on the
      server. It also refuses a bed the administration fixed or a bed in a submitted or validated lodging.
    - **Withdrawn is not deleted**: the registration leaves the lists, quotas, lodging, meal groups and the meal
      scanner, badges and stickers, and the consent sheets, but the record stays with who withdrew it, when and why.
      The admin sees it as «Retirada» (filter «Solo retiradas») and can reactivate it; it does not get its old room
      back, and the confirmation says so.
    - **Audit**: every withdrawal and restore is recorded.
  - **«Mi inscripción»: the badge first, and one switch for every notice.**
    - **Order**: «Mi escarapela», then «Avisos», «Mis comidas» and «Mi transporte».
    - **Alerts at the top**: what is happening now — «Tu grupo ya puede pasar a comer», «Embarcando: Bus 1» — sits
      in a strip at the very top, and each line leads down to its section.
    - **One «Activar avisos»** turns on, on this phone, the meal calls and the bus boarding, departure and
      messages. It replaces the separate bus and meal buttons, with one state («Avisos activados en este
      teléfono», and «Desactivar»).
    - **When notices can't be turned on**, the page says so: blocked in the browser, or on an iPhone, add the page to
      the home screen from Safari.
    - **Nothing to re-enable**: a phone already had one subscription for every notice, so existing bus subscriptions
      keep working.
  - **A locality holds only the beds its people use** (the owner: «asignó más camas que los inscritos de la
    localidad»).
    - **«Sugerir reparto»**: a room the plan gives to one locality is that locality's whole only when its people fill
      it. Otherwise the locality holds the beds its people use, and the free beds go to people of other localities in
      the same «Separar por» section (Hombres / Mujeres). With «no compartir habitaciones» the rooms stay exclusive.
    - **The automatic assignment keeps a locality together**: each locality fills its own partly used rooms, then
      empty rooms, and only then the free beds of another locality's room of the same section. A room mixing
      localities now weighs more than one room saved.
    - **Never mixed**: a different section, and rooms reserved by hand stay exclusive.
    - **Lodging explorer**: a room with people of several localities shows each person's locality.
    - **Coordinators' portal**: unchanged — only its own people, and «Compartida · tuyas N de M camas».
  - **Fixed: «Limpiar todas las asignaciones» frees the rooms too.** It used to take the people out but leave every
    room and bed reserved for the locality it had been given to.
    - **What is freed**: the rooms and beds that «Sugerir reparto» gave to localities go back to everyone, so the
      next assignment starts from scratch.
    - **Reservations by hand** stay with their locality unless the admin ticks «También liberar las habitaciones
      reservadas a mano (N)». Reservations made before this version count as made by hand.
    - **The confirmation** lists what will be cleared: people, rooms and beds of the split, and the count of
      reservations by hand.
    - **Untouched**: frozen localities, blocked rooms and people fixed by the administration.
    - **Audit**: each clear is recorded (who, when, what it freed). Every allotment now records whether it came
      from the split or was made by hand.
  - **Fixed: searchable lists scroll again.** Wheel, trackpad and touch work. The list used to jump up and down:
    every row the pointer passed over while scrolling was scrolled back into view. Now a row is brought into view
    only when the list opens (the chosen one) or on a keyboard move. A new search starts at the top. The list keeps
    its scroll to itself.

### Fixed

- **Plugins › Marketplace fits a phone.** The catalog source line printed the whole catalog URL with nothing allowed to wrap it, so the admin page scrolled sideways on a phone. Long source URLs wrap now, and the sources list and the add-a-source field can shrink (`app/admin/plugins/MarketplaceTab.tsx`).

## [2.11.2] - 2026-10-24

### Fixed

- **Searchable selects no longer jump while you scroll the list.** Hovering a row highlighted it and scrolled it into view; as the list moved under a still pointer, each row passing under it did the same, so wheel and touch scrolling bounced back. The highlight is now revealed only on open and with the arrow keys (`components/ui/Select.tsx`).

### Added

- **conference-manager 2.36.5: calling the meal groups, one after another.**
  - **«Alimentación › Llamar grupos»**: the live screen of a meal service. For every group it shows how many people it
    has for that service, how many were served, how many are still to come, and how many were let in before their
    group was called. A big «Llamar grupo B» calls the next group in the service's order; any group can be called.
    A called group stays called. «Deshacer» undoes a mistaken call after an in-app confirmation. The kitchen team
    can call groups too (Entrega de comidas › gestionar).
  - **The scanner follows the calls.** Once a group of a service has been called, a person whose group has not
    is not served on a scan. A red warning says «Tu grupo aún no ha sido llamado», with their letter and the groups
    called so far. «Dejar pasar igual», after its own confirmation, serves them as an exception, recorded with who
    allowed it, when, the person and their group. Priority people get no bypass: priority only decides their group.
    Before the first call of a service, the scanner serves everyone, as before.
  - **The group is told**: a notification on the phones of that group's people (the boarding notices' Web Push, in
    the phone's language: Spanish, English or Portuguese). «Mi inscripción» shows «Tu grupo ya puede pasar a comer»
    on its own, refreshing while a meal is still to come. People without a bus can now turn the notices on in «Mis
    comidas».
  - **The audit**: every call, undo and exception is logged per service, and shown on the screen with the
    exceptions' names.
- **conference-manager 2.36.4: a friendlier price-rule builder.** In *Precios › Nueva regla*, the value of a condition
  now follows the field picked, from what this conference's data really has, instead of free text:
  - **Personas que escojo**: the roster, searched by name, document or locality and filtered by locality; tick one
    person or several.
  - **The locality, a list field or a short text** (church, role, gender…): the values people really have, each with
    how many people have it, ticked as «es uno de» / «no es ninguno de»; another value can be added.
  - **A number**: a range (either end open) or a bound (≥, ≤ …).
  - **A date**: between, before or after, with the admin's calendar.
  - **A Yes / No switch**: Sí or No.
  - **Live preview**: under the condition, «Esta regla aplica a N de M personas» and the first few names. A value the
    server refuses (an empty list, a backwards range) is said in place.
  - **Rules list**: says each condition in words («Localidad es: Norte, Sur», «Edad entre 18 y 65»).
  - **Older rules**: rules saved before work as they did. A rule on a list field written as «es igual a X» opens as
    «es uno de [X]» (the same people) when edited.
- **conference-manager 2.36.4: any signed-sheet PDF shows in place.** The viewer from 2.36.3 showed only scanned PDFs
  and turned away a typed or exported one («not a picture or a scan»). Now every PDF (typed, vector, mixed or scanned)
  is drawn page by page in the sheet's viewer, with zoom, pan and page arrows, on a computer or a phone. It is never a
  download and never the browser's own PDF viewer.
  - **pdf.js 4.10.38** (Apache-2.0, legacy build) is bundled with the plugin, with its licence in
    `server/pdfjs.LICENSE.txt`.
  - **Loaded on demand**: the plugin's bundles stay the same size. The first PDF opened fetches pdf.js once from the
    new `GET /public/pdfjs` (cached).
  - **No new permissions**: it runs on the page, with no Worker and no `eval`, so nothing more is needed under the
    admin's CSP or the sandbox. The plugin now has 176 routes.
  - **Unchanged**: a phone's «scan to PDF» still shows its pictures directly, without pdf.js, and a photo shows as it
    is.

## [2.11.1] - 2026-10-23

### Security

- **body-parser 1.20.9 (gateway, backend) and 2.4.0 (backend, via the MCP SDK)** for [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) (high): a compressed request body followed by trailing bytes could tie up the process. Lockfile-only change.
- **multer 2.5.0 and fast-uri 3.1.9 (backend)** for [GHSA-q7qp-rjg7-q26m](https://github.com/advisories/GHSA-q7qp-rjg7-q26m) (high: a pending async fileFilter after the request is torn down could tie up the process) and the fast-uri percent-encoded scheme advisories ([GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg) and related, moderate/low). Lockfile-only change.

### Added

- **conference-manager 2.36.2: paper consent sheets.**
  - **Delete an unused sheet.** A sheet made by mistake (wrong language, paper or locality) can be deleted, after a
    confirmation in the app's own dialog. Only while it has no signed page uploaded: an uploaded page is evidence and
    is never deleted, and ticks need one, so nobody was ever recorded on a sheet that can go. The consent log keeps
    both the sheet's creation and its deletion.
  - **See the sheet while ticking who signed.** «Marcar quién firmó» shows the sheet itself: the printed rows in the
    paper's order, then the blank rows, with the same «No autorizo» columns. Tapping a row ticks it, and the list
    follows. Rows already settled stay in place, greyed, so the numbers always match the paper. «Hoja subida» shows
    the uploaded photo instead. A wide screen shows the sheet next to the list; a phone switches between «Hoja» and
    «Lista».

### Fixed

- **conference-manager 2.36.3: the admin's PDF buttons open the file again, «Imprimir stickers» asks what to print, the
  paper consent sheet is a real PDF, and «Marcar quién firmó» shows the signed page on the same screen.**
  - **The fix.** Since 2.30.0 every PDF button of the admin opened a page that said «Esta página no existe» instead
    of the file: the sticker buttons, and also the badge PDF of a person, «PDF para imprimir (hoja Carta)» and «PDF
    una por página». The admin still used the conference portal's old file address. It now uses the core's portal
    file route, `/portal/conference/file`, as the portal's own pages already did. A test pins the admin's address to
    that route.
  - **Choose what to print.** «Personas › Imprimir stickers» opens one dialog: everyone, one locality, or the
    people you tick, with a search and «Marcar los que se ven» (one person is one tick). It shows how many stickers
    will print, at what label size, before printing. It starts on what the list shows: the search's people already
    ticked, else the chosen locality, else everyone. Each person's own sticker button is unchanged.
  - **The paper consent sheet is a real PDF.** «Imprimir» did nothing on phones (they ignore printing from a frame)
    and «Descargar» saved an .html file. The server now draws the sheet as a PDF, with the same texts, columns and
    rows, on Letter or A4, and the authorization header and the QR on every page. «Descargar PDF» saves the .pdf
    (computer, Android, iPhone). «Abrir para imprimir» opens it through the portal's file route, the same one as
    the badge and sticker PDFs, in the browser's or the phone's own viewer, which prints and shares it.
  - **The signed page in place.** An uploaded page of a paper consent sheet opens in a viewer inside the screen,
    never as a download: a photo as it is, a scanned PDF page by page, its pages taken out of the file in the
    browser. Zoom with the buttons, the wheel, a pinch or a double tap, and drag to move. A PDF that is not a scan
    (typed, no picture) says so in place.
  - **One screen to tick who signed.** The «Hoja / Lista» toggle is gone. The uploaded page and the sheet's rows,
    with their ticks, are on screen together: side by side on a wide screen; on a phone the page stays on top
    while the rows scroll under it, and a bar sets its height. A minor's representative is entered under their own
    row, and who signed on a blank row is ticked below the sheet.

## [2.11.0] - 2026-10-23

### Added

- **conference-manager 2.36.0: a printable sticker for the physical badge, and the meal group on badges.**
  - **«Sticker para imprimir»** is a second design next to the virtual badge, under *Escarapelas › Diseño*, for a
    label printer. It uses the same designer: texts with the person's data, shapes, images and the QR.
    - Sizes: presets (62 × 100 mm, the default, and 62 × 29 mm for Brother QL; 100 × 50 mm; 4 × 6 in; 2 × 1 in),
      or a custom width × height in mm. «1:1» shows it at real size on screen.
    - Changing the label's shape (tall ↔ wide) offers a layout made for it, or scales the current one.
    - A sticker may drop its QR. The starting points are black on white, since label printers are thermal.
  - **Printing**:
    - for one person (their badge window), the people a search shows, a locality, or everyone;
    - each sticker comes from the registrant's live data;
    - a PDF with one label per page at the label's exact size, so no browser margins or headers;
    - in the print window, choose the sticker printer and the label size, «Márgenes: ninguno» and «Escala: 100 %».
  - **Meal group (A–F)**:
    - The designer's «Texto» tab has a «Grupo de comida (letra)» button that places the person's letter in large
      type. The field was already in «Datos del inscrito», but easy to miss.
    - A person with no group yet shows nothing.
    - The letter appears once «Turnos de comida» is on and groups are assigned.

- **conference-manager 2.35.0: registering without an e-mail.** While a conference asks for «Autorización de
  datos», a person can now be registered without an e-mail, for example a walk-in who signs on paper.
  - An e-mail written in the form must still be a valid one. An e-mail field the administrator marked as required
    stays required.
  - Without an e-mail nothing is sent. The person is marked «Sin correo» in Autorizaciones and in the coordinators'
    portal, and «Reenviar enlace» is hidden for them.
  - «Copiar mensaje» still shares the link, and the consent page asks for the e-mail (from 2.33.3). The paper sheet
    lists them like anyone else.
  - Badges and the CSV export work as before, with the e-mail column empty.
  - Duplicates: with no e-mail, a registration with the same name (accents and case aside) and the same ID document
    number or phone counts as a duplicate. Cancelled registrations do not count. In the portal the check covers the
    coordinator's own locality.

- **conference-manager 2.34.0: paper consent and verbal health authorization.**
  - **Paper consent («Consentimiento en papel»).** People who sign by hand can authorize the processing of their
    data on a printed sheet. This sits alongside the e-mailed code; it does not replace it. Coordinators work in
    the portal, for their own locality only. Administrators work in **Autorizaciones**, for any locality.
    - **Abrir hoja para imprimir o guardar como PDF** makes a sheet for the locality, as a print-ready page that
      opens in the browser's print window, where it can be printed or saved as PDF:
      - It is printed in Spanish, English or Portuguese, by default the consent e-mail language, on Letter
        («carta», the default) or A4, landscape.
      - **Every page** starts with a compact header: the controller and contact, the purpose, the rights, the
        policy in force (address, version and SHA-256), and how to sign. Whoever signs on any page reads what they
        sign.
      - The header holds **one authorization** in a single block, the configured general, image and health
        texts. It says that health and image are voluntary, and one signature covers it all.
      - Under the header, the locality's people without an authorization yet, as many rows as fit the page. Each
        row has the name, the document and a signature, and the legal representative of a minor (name, document,
        signature).
      - Each row also has two narrow opt-out boxes, «No autorizo datos de salud» and «No autorizo uso de imagen».
        An unmarked box means authorized; the registration goes ahead either way.
      - Blank rows follow, for walk-ins.
      - The bottom of every printed page carries the sheet id, «page i of n» and a QR code.
      - The same sheet can be downloaded or printed again at any time.
    - **Subir hoja firmada** keeps the signed pages privately, each with the SHA-256 of its bytes:
      - Photos are compressed in the browser; a PDF goes up as it is, up to 2 MB.
      - A file is checked by its first bytes, and it is never public, replaced or deleted.
    - **Marcar quién firmó** is a checklist of who signed:
      - Health and image start authorized; the coordinator ticks the opt-out a person marked.
      - A minor needs the representative's name.
      - Each person ticked gets a signature in the same append-only, hash-chained log as an e-mailed one, marked
        `method: 'paper'` with its `opt_outs`. It carries the sheet and row, the policy version and its SHA-256,
        the SHA-256 of the sheet's text, every uploaded file's SHA-256, and who uploaded and who ticked, and when.
      - The inscription leaves «Autorización pendiente» exactly as with the code.
      - **Exportar evidencia** includes the sheet and its files' hashes.
    - **Deshacer** undoes a wrong tick, with a reason:
      - It is a new log row, so the log stays append-only.
      - The person goes back to pending, and their health answers are deleted.
    - Every sheet made, file uploaded, tick and undo is logged.
    - The people table marks paper signatures «En papel».
  - **Verbal health authorization.**
    - While the conference asks for «Autorización de datos», a coordinator (portal) or an administrator (with
      *Datos de salud › gestionar*) can enter a person's «Condiciones de salud» at registration. To do so they tick
      «La persona me autorizó verbalmente el tratamiento de sus datos de salud, tras informarle que es voluntario».
      Without the tick the answer is not saved, and the error is shown under the box.
    - The tick is recorded in the person's log as a `verbal_granted` row: method `verbal`, scope health, the staff
      member, the time and the policy version, pending written confirmation.
    - Every entry or change is also logged as `health_entered`, with who made it. The log never holds the answer.
    - The answer is in use at once: «Datos de salud» holders see it, and meal turns and priority groups use it.
    - The person's later written authorization (the code or the paper sheet) confirms it with a `verbal_confirmed`
      row, linked to the signature.
    - Signing without health (the unticked box, or the paper opt-out) deletes the answer at once, logged as
      `health_deleted`. A written «no» cannot be overridden by a later verbal tick.
    - A verbal authorization not confirmed within **Días para confirmar por escrito** (a setting, 15 by default) is
      flagged, not deleted. It shows as «Autorización verbal sin confirmar por escrito» on the person, in the
      portal too.
    - Autorizaciones shows a count and a filter to follow these up.
    - The post-conference health purge still applies.
    - The person's own answer on their consent page still wins.


- **mail-server 3.2.3: a sending rate for the general queue.** *Email Center → Server → Queue* has *Messages per
  minute*: how many messages may leave the server each minute, counting users' mail, scheduled sends, retries, the
  site's mail and other plugins'. Above it, messages wait in the queue and go out in the following minutes, in order;
  none is lost and the sender is not told it failed. Password resets and address verification go out at once. The
  queue screen shows this minute's count, how many messages wait and how long they take to go out. The limit holds for
  the whole install, however many nodes run the plugin. 0 (the default) is no limit, as before.
- **Plugin updates without a core release.** A new *Publish marketplace* workflow rebuilds the marketplace catalog and plugin zips, runs the same integrity gate as a release, and replaces the marketplace assets on the latest release, so a plugin update reaches every site's Marketplace tab without a new WordJS version (see `documentation/deployment.md`).
- **conference-manager 2.33.2: «Copiar mensaje» for the data consent request.** Next to «Enviar / Reenviar
  enlace», in the admin's «Autorizaciones» tab and in the coordinators' person sheet, a button copies the consent
  request as a message to paste into WhatsApp or any chat. The message carries a new personal link and the policy
  version, in the screen's language. A dialog shows the text to copy by hand when the browser does not allow
  copying, and offers «Abrir en WhatsApp». No e-mail is sent, the request is not marked as e-mailed, and the
  evidence log records «link shared manually». The previous link stops working, as with a resend. Signing still
  needs the code sent to the person's e-mail. The consent screens are now also in Portuguese.
- **conference-manager 2.33.2: phone numbers carry their country code.**
  - Phone fields in the admin's inscription form and in the coordinators' portal get a small flag box in the
    same row as the number. It opens a list of every country, with its flag, its name in the screen's language
    and its calling code, which can be searched by name, ISO code or calling code. Flags are bundled images
    (flag-icons, MIT), so they show on Windows too, and only the flags on screen are loaded.
  - Numbers are stored in E.164 (`+573001234567`). The server builds the same form from whatever an API caller
    sends: «+» and «00» keep their code, and a national number takes the conference's default country and loses
    its leading «0». An invalid number is refused next to its field.
  - **Campos › «Indicativo de país por defecto»** (Colombia unless changed) sets the country the selector starts
    on and the one a number without a code belongs to.
  - Existing numbers are never rewritten. WhatsApp links read a stored code, or the default when there is none,
    and send digits only. The badge WhatsApp links follow the new default once it is chosen; any national number
    gets the code now, not only 10-digit Colombian mobiles.
- **conference-manager 2.33.2: every dropdown of the plugin is the same styled select.** The browser's native
  selects across the admin, the coordinators' portal, «Mi inscripción» and the consent page now open a styled
  panel with a scrolling list. Lists of eight or more options also get a search box that ignores accents. The
  panel opens next to its field, above it only when there is no room below, and appears over dialogs. It works
  with the keyboard (arrows, Enter, Escape, typing to jump) and a screen reader.

### Changed

- **conference-manager 2.36.1: a clearer coordinators' portal.**
  - **Sign-in**:
    - With a single published conference, it is already chosen.
    - The device remembers the conference and the locality last used to sign in. It never stores the access
      code, and the code field is emptied after signing in.
    - The code opens a number pad, has a show/hide button, and says where to get it.
    - The card shows the chosen conference.
  - **Header**: the sticky bar names the conference and the locality, so the context stays in view after the
    summary scrolls away.
  - **Summary**: tiles for registered, paid, unpaid and awaiting validation. While the conference asks for it, a
    tile also counts who has not authorized the processing of their data. Each tile opens the list on its filter.
  - **Tools**: «Herramientas de la localidad» folds the badge tools and the paper consent behind one row, so on a
    phone the list comes first. The device remembers whether it was left open.
  - **Fix**: the cards' background glow no longer lets a card slide sideways when a control near its edge is
    focused, which cut off the login form on phones.
- **conference-manager 2.33.4: the consent e-mails, page and copied message in the e-mail language.**
  - A new plugin setting, **«Idioma de los correos de consentimiento»** (Autorizaciones, for all conferences:
    Español, English or Português), starts as the site's language (WPLANG). A conference can choose its own. The
    three consent e-mails (the link, the one-time code and the copy of what was authorized) are sent in it. They
    were always Spanish; no other Conference Manager e-mail exists.
  - The consent page starts in that language. The person can switch it (Español / English / Português), and the
    choice is remembered on their device. The page's error messages follow the chosen language too.
  - The «Copiar mensaje» dialog has a language picker. It starts in the e-mail language or in the last language
    the staff member chose on that device, and a «Copiar» button copies the message again after a switch.
  - What the person signs (the configured authorization texts) is kept exactly as written, whatever the language,
    so changing the language does not create a new policy version.
  - The health questions' justification no longer gives an example: «Usaremos esta información solo para
    atenderte mejor. Solo la ve el equipo autorizado. Puedes no responder.» (and the same in English and
    Portuguese).

- **Updating a plugin never requires uninstalling it.** A plugin uploaded as a ZIP, installed before WordJS
  recorded where plugins come from, or installed from another catalog used to say «uninstall it and reinstall it
  from the catalog». From the official catalog it now offers **Update to vX** like any other plugin: the verified
  version goes in place and keeps its data and tables. From another catalog it offers **Reinstall from this
  source**, which names the old and the new source and asks whether to keep the plugin's data (ticked by default,
  with a warning for a plugin that asks for a high-risk permission). In both cases the permissions are asked for
  again in the dialog instead of being carried over, the new source is recorded so later updates are normal ones,
  and the action is recorded in the audit trail with the old and new source and permissions
  (`POST /api/v1/marketplace/adopt`, see `documentation/deployment.md`).

### Fixed

- **Updating a plugin on Windows takes seconds again, not two minutes.** Every update retired the plugin's
  AppContainer sandbox profile with a recursive pass over each folder it could read — `node_modules`
  included — which timed out at 120 s on large or OneDrive-synced installs, and the next start re-granted
  the same folders recursively. An update now keeps the profile and re-grants only the plugin's own folder; code from another source (adopt,
  reinstall) still gets a fresh start with every earlier grant removed.
  Grants and revokes touch each folder's root and let Windows inheritance cover the rest, and a linked
  `node_modules` is granted on its real folder. Measured on a OneDrive checkout: an update went from over
  two minutes to 3 s, and an uninstall from a failed 120 s timeout to 11 s with every grant removed.
  Linux and macOS are unchanged.
- **`create-wordjs --help` no longer suggests installing an old release.** Its examples of a release tag said
  `v2.1.0` (the README, `v2.9.0`); they now read `vX.Y.Z`, so they cannot go stale.
- **faq 1.0.5: the FAQ keeps running without the *Add admin menu* permission.** With `admin_menu:register` off
  (on the permission screen, or in the consent dialog of an update), the plugin crashed and restarted in a loop,
  taking its pages and its block down with it. It now runs without its sidebar entry and logs why.
- **A plugin that needs a newer WordJS is no longer installed on an older one.** A plugin declares the WordJS it
  needs in its manifest (`"requires": { "wordjs": ">=2.10.0" }`), and the Marketplace catalog carries it. On a
  site that runs an older WordJS, the Marketplace shows that version as *Requires WordJS ≥ X — update WordJS
  first*, with a link to Updates and no install or update button. Installing, updating or uploading it is refused
  with a clear message instead of leaving the plugin's admin screen blank. A plugin screen built for a newer
  WordJS says *This plugin needs WordJS ≥ X* instead of staying blank. WordJS releases before this one ignore
  the field. **conference-manager 2.33.5** declares `>=2.10.0` (its date picker comes from WordJS 2.10.0).
- **A plugin keeps running when its admin menu or public assets are not granted.** Leaving *Add admin menu*
  (`admin_menu:register`) or *Add scripts and styles to public pages* (`assets:write`) off for a plugin, on the permission
  screen or in the consent dialog of an update, made the plugin crash and restart in a loop, taking its pages,
  routes and blocks down with it. The plugin now runs without the menu entry or the assets it was not granted,
  and its log says once which permission to grant. The permission is still refused exactly as before.
- **conference-manager 2.33.3: «Copiar mensaje» works for people with no e-mail on file.** It used to refuse with
  «se requiere un correo válido». The message is now copied anyway, and the consent page asks the person for their
  e-mail. The signing code goes there, and the e-mail is kept as verified in the evidence (noted as typed on the
  page) and fills their empty e-mail field. The e-mail field is also recognized by its label («Correo», «Correo
  electrónico», «E-mail»), not only by the «Email» template.

## [2.10.0] - 2026-10-23

### Added

- **Settings → Emails: every message the site sends is editable, and arrives in a proper HTML layout.**
  - The core's messages (email verification, sign-up with an existing address, password reset, the account
    email test, site address changed, comment awaiting moderation, new comment on your entry) come from one
    registry, with their default text in English, Spanish and Portuguese. Until now they were English only.
  - Each message is edited per language: the subject, the body with the editor's own text editing (paragraphs,
    bold, italic, lists, links; no HTML to write) and the button text. Values such as `{site_name}`,
    `{user_name}` and `{expires}` are inserted from chips. Every value is escaped when the message is built.
  - The button's link (the reset or verification link) is added by the site when it sends the message, outside
    the editable text. An edit cannot remove it, change where it points or copy its token into another field.
    The site-address notice keeps no link at all.
  - Saved bodies keep only paragraphs, emphasis, lists, quotes, headings and http/https/mailto links.
  - One layout for every message: the site logo or title, the message on a card, a button in the theme's
    primary colour (or one the administrator picks), the site address in the footer and an optional footer
    line. It is table-based with inline styles for mail apps, and has dark-mode colours. A plain-text version
    is generated from the same message and sent with it.
  - The screen has a live preview of the unsaved text (desktop or mobile width, light or dark, HTML or plain
    text), **Send a test to me** and **Reset to default**. Account messages follow the language of the person
    who filled the form; the others follow the site language.
  - Administrators only. Editing or resetting a sign-in or site-address message asks for the current password.
    Every change is written to the audit log, with the message and language but never the text.
  - Comment notification excerpts are now read with an HTML parser instead of a pattern.

- **conference-manager 2.33.0: each registrant authorizes the processing of their data, and signs with a code.**
  - A new **«Autorizaciones»** tab asks every registrant of a conference for their own data processing
    consent. It is off until the administrator turns it on, and everything is set there: the policy's address
    and version, the data controller and its e-mail, the three authorization texts, how long the link lasts,
    and when health data are deleted.
  - Registering someone (portal or admin) needs an e-mail, which is a parent's for a minor. The person gets a
    single-use link. Until they authorize, the registration shows «Autorización pendiente» and cannot be
    confirmed.
  - On the link's page the person reads the policy and ticks separate, unticked boxes: general processing
    (required), sensitive health data (optional) and use of image (optional). They answer «Condiciones de
    salud» themselves, so the coordinator never handles health data. For a minor, the page asks for the legal
    representative's name, ID number and relationship.
  - The person signs with a 6-digit code sent to the same e-mail. The code lasts 10 minutes and allows 5 tries.
    A new one can be asked once a minute, 5 an hour. The code is never stored.
  - The evidence is an append-only log, and a revocation is a new entry. It holds the person's identity and
    verified e-mail, the server's UTC time and time zone, the browser's time zone and user agent, and a keyed
    hash of the network address. It also keeps the policy version, the SHA-256 of the exact text shown, each
    box, the code's sent and verified times and the representative of a minor. Each person's entries are
    hash-chained, and deleting the registration keeps them.
  - Each signature also names the policy version in force: its number and the SHA-256 of an append-only
    snapshot of the settings the page was built from. Once a version is signed, its texts can only change under
    a new version number, so every record still shows which version the person accepted. The plugin's README
    explains why the site's secret, which keys the network hash, must stay the same.
  - The person receives a copy of what they authorized, with the policy link.
  - Coordinators see each person's state and can resend the link. Administrators record revocations and export
    one person's evidence as a file.
  - Health answers are deleted a set number of days after the conference ends (30 by default). The evidence
    stays.
  - The plugin now requests the `email` permission to send these messages through the site's mail plugin.
- **One form kit for the admin, and a gate that keeps it that way.** The admin drew its fields and buttons
  in several ways: ~720 raw `<input>`, `<select>`, `<textarea>` and `<button>` across 114 files, each with its
  own borders, focus ring and label wiring, and two different selects. `@/components/ui` is now the single source:
  - **One field contract:** `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`/`RadioGroup`, `Switch`,
    `ColorInput`, `Slider` and the pickers all take `label`, `help`, `error` and `required`; the label is tied to
    the control, and help and error are announced (`aria-describedby`, `aria-invalid`, `aria-required`).
  - **One select:** `Select` is ModernSelect's implementation with a value-based `onChange`, option descriptions,
    disabled options and an optional search box; `ModernSelect` is now a shim over it.
  - **Buttons:** `Button` (a `pending` state with its own label, a `link` variant, `type="button"` unless a submit
    is asked for), `IconButton` (its name is required), `ButtonLink`, `FileButton`, `SegmentedControl`, `Tabs`
    and `UnstyledButton` for bespoke clickables.
  - **The gate:** ESLint refuses a raw form element in the admin, and a test counts every admin file exactly
    against an allowlist that only shrinks, so the screens move to the kit batch by batch and none goes back.
    Public and theme-rendered code is out of scope: a theme never ships admin JavaScript.
- **Folders in the media library.** Admin → Media has a folder tree beside the library (a panel on phones): create, rename and nest folders, browse them (the address keeps the folder), upload straight into the current one, and move files by dragging them onto a folder or with *Move to…* — one file from its details, or many at once. Deleting a folder asks where its files and subfolders go; no file is ever deleted with it or left in a folder that no longer exists. The editor's media picker browses by folder too. Folders are organisation only: moving a file never changes its URL, so content that links to it keeps working. Anyone who uploads can create folders and move the files they may edit; renaming and deleting folders is for editors. (`GET`/`POST /api/v1/media/folders`, `PUT`/`DELETE /api/v1/media/folders/:id`, `POST /api/v1/media/folders/move`, `?folder=` on `GET /api/v1/media` and on uploads.)
- **conference-manager 2.32.0: health conditions and meal turns.**
  - A new **«Condiciones de salud»** field template asks about health conditions: several can be ticked,
    «Otros» opens a text box, and «Ninguna» and «Prefiero no responder» are answers too. A consent line on
    the form says what the answers are for.
  - Health answers are special-category data. They are kept apart from the rest of the registration, and
    only staff with the new **«Datos de salud»** section see them (list, Excel, person sheet) or change them.
  - The coordinators' portal can record an answer when it registers someone, but never shows it back.
  - Deleting the field deletes every answer.
  - A new **«Edad»** template asks for the age in years.
  - **«Alimentación › Turnos»** puts every participant in a meal group A–F, all of nearly the same size. The
    order comes from a priority score: young children and older people first, then health conditions, with
    weights the administrator can change. Sex never counts on its own; «Embarazo» and «Lactancia» are
    conditions the person marks.
  - Families eat together. Each meal gets a call time per group from the number of serving lines and plates
    per minute, and a warning shows when the last group would end after the meal's closing time.
  - A coordinator can move a person to another group. «Fijar grupos» stops letters from changing once badges
    are printed.
  - Turns are off until the administrator turns them on. When on, the badge can print the group letter,
    «Mi inscripción» shows the group and each meal's turn, and the meal scanner shows the letter without
    ever refusing a delivery.

- **The admin's own calendar.** Date fields used the browser's native picker, which looked different in every
  browser and OS, ignored the admin palette and the editor's dark mode, and followed the browser's language.
  The new shared `DatePicker` / `DateTimePicker` replaces it:
  - **Behaviour.** A popover calendar with month and year navigation, Today, Clear and min/max. Keyboard
    navigation and ARIA follow the WAI-ARIA date picker dialog pattern, and on phones it opens as a bottom
    sheet with 44px targets.
  - **Language and look.** Month and day names are in the admin language (es/en/pt). The week starts on the
    site's first day of the week, a new **Settings → General** field (`start_of_week`, 0–6, validated). Inside
    Verso the calendar follows the editor's palette, light or dark.
  - **Where.** It now powers the alias expiry in Settings → Site address and the publish / scheduled date in
    the Verso editor.
  - **No data migration.** Stored values keep the native inputs' format (`YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`).
  - **Plugins.** Plugin admin screens can import it from `@/components/ui/DatePicker` (a new host module of
    the plugin UI kit) without any core change per plugin; see the plugin guide.

### Changed

- **Updates, the network switch and Admin → Servers no longer demand two-factor authentication.** Installing
  an update, turning the network on or off, minting a join token and removing a node asked for a
  two-factor code and refused an account without 2FA ("turn on two-factor authentication first"). They
  now take the password alone from an account without 2FA, and the password and a current code from an
  account with it. The panel shows the code field only then. The password is always checked first, and
  the step-up refuses any request whose password was not verified. The audit log records which proof
  confirmed the action (`reauth`: `password` or `password+2fa`).

### Fixed

- **The admin shell and the editor's side panels use the admin's form kit.** The dashboard, the admin
  shell (banners, the connection screen, the sidebar and its language menu), the notification centre, the
  posts and pages list, Hooks and its live timeline, AI suggestions, and the editor's revisions, review
  comments and accessibility panels now draw their controls from `@/components/ui`:
  - the list and Hooks searches are kit inputs with their icon; the list's bulk actions and the connection
    screen's retry are kit buttons;
  - toggles say their state: the dashboard's weekly/monthly switch and the live timeline's pause are pressed
    or not, and the notification bell and the sidebar's language menu say whether they are open;
  - the shell, the dark sidebar and the editor panels keep their own look through the kit's unstyled button.
  The review comments composer moves with the editor's fields in a later batch. An unused SEO panel
  component is removed. These files leave the form kit's allowlist (509 → 456 raw controls left).
- **The content admin screens use the admin's form kit.** Tags, Categories, Comments, Fonts, Forms, Import
  from WordPress, Notices, API tokens, Webhooks, Widgets and AI agents now use `@/components/ui`:
  - fields have their labels tied to them (the widget settings too), and the tag and font searches are kit
    inputs with their icon; the tag search's clear button is named;
  - the WordPress import's media choice is a radio group with a legend and a hint per option, and its
    options are kit switches with their help announced;
  - icon-only actions (webhook deliveries, pause, rotate and delete; widget settings and remove; deleting a
    font variant) are named buttons, and busy states (send test, dismiss a notice, start an import, save a
    widget) use the kit's pending button;
  - the file choosers behind a drop area are a new kit `HiddenFileInput`, out of the tab order;
  - the AI agents' capability checkboxes and the publish-confirmation switch are the kit's.
  These files leave the form kit's allowlist (551 → 509 raw controls left).
- **The settings sub-pages use the admin's form kit.** Site address, Interactions (the simple editor and
  the preset editor), Media storage, Backups, AI, Network setup, Network, Cluster and Tools now use
  `@/components/ui`:
  - the preset editor's drop-downs are the kit `Select` (it takes an `id`, so each label names its control),
    its colour properties a `ColorInput` (still stored as the 0xRRGGBB integer), its sliders `Slider`s that
    read their value out with the unit, and its track picker a `SegmentedControl`;
  - Media storage's driver and Site address's «old address» choices are radio groups with a legend;
  - every checkbox has its label tied to it, and help text such as Tools' note on exporting users is
    announced with it;
  - dialog actions are kit buttons, and every form's submit is explicit.
  These files leave the form kit's allowlist (619 → 551 raw controls left).
- **Plugins and Security use the admin's form kit.** Admin → Plugins (the cards, the marketplace and every
  plugin dialog) and Admin → Security (gateway, two-factor policy, automatic renewal, certificates, server
  settings) now use `@/components/ui`:
  - the plugin cards' icon actions (details, pack, download, delete, restart) had only a tooltip and no
    accessible name; they are named `IconButton`s;
  - the installed / marketplace tabs, the status filter and the marketplace categories are named
    `SegmentedControl`s (one tab stop, arrow keys);
  - the new catalog-source field had no name at all; it is a named URL field;
  - the delete dialog's password error sits under the field and is announced;
  - the certificate key and certificate files are chosen with a `FileButton`, and «Validation method» no
    longer labels the private-key input;
  - the server panel's proxy and log-level menus are the kit `Select`;
  - every form's submit is explicit.
  A new check holds it: every form in a file fully on the kit must have an explicit submit. These files leave
  the form kit's allowlist (687 → 619 raw controls left).
- **A select's label looks like every other field's label.** The kit's `Select` kept the old select's label
  (normal-case bold) while every other field uses the uppercase micro-label; both now share one label style.
- **Dates follow the site time zone.** A comment, a post, an edit and the starter content stored their local date with the server's clock instead of the site time zone (Settings → General), so on a host in another zone a comment written just after midnight UTC was dated the day before the post it answers. The local date is now built from the site time zone on any host, and the public pages read the UTC moment whenever the site zone is known, so comments stored before this change show the right day too.
- **A new Text block's sample text is replaced when you start typing.** It is selected when editing starts, instead of the caret landing after it and publishing «Write here...» in front of what was typed. Text an author wrote is untouched.
- **Ctrl/⌘+K inside a Text block adds a link.** With text selected while editing, the shortcut opened the command palette instead of the link popover. It now opens the link popover; outside a text being edited it still opens the palette.
- **The comments section speaks the site language.** Its heading, form labels, buttons and notices were always in English. They now follow the site language (Spanish, English or Portuguese), on open entries and on members-only entries alike.
- **A post awaiting review shows a translated badge** in the Posts list, instead of the raw word «pending».
- **Automatic excerpts keep a space between paragraphs.** An excerpt built from the content glued the last word of one block to the first of the next («roasteryOpen»). Headings, paragraphs, list items and line breaks are now separated.
- **The WordPress import summary explains unassigned menus in your language.** It printed an internal English message in the middle of the translated note. It now says, in the admin language, that the export named no theme location, or that the locations it named matched no imported menu.
- **Security → Automatic Certificate Renewal reads correctly.** The HTTP-01 note was glued from fragments,
  so it read "runs in the every deployment mode" and "Port 80 listenerabove" in English, "en el todos los modos"
  and "HTTP-01 ; por eso" in Spanish, and "na todos os modos" in Portuguese. Each language now has the whole
  sentence, with its own word order and punctuation.
- **The sign-in screens use the admin's form kit.** Sign in, register, reset password and verify email, plus
  two-factor setup, the one-time secret dialog, the API access card and the plugin and editor error notices,
  now use `@/components/ui` instead of their own fields and buttons. Every field has its label tied to it; its
  error appears under it and is announced (it was a red line nothing pointed to, and register's errors were
  not announced at all); every form's submit is explicit; and the screens take the admin's field and button
  look. The two-factor password field can show what was typed. These files are off the form kit's allowlist
  (719 → 687 raw controls left).
- **Admin → Updates no longer offers an in-place update inside a Kubernetes pod.** containerd and CRI-O write
  no `/.dockerenv`, and the Helm chart did not say it was a container, so the screen offered the one-click update,
  which rewrites code the next pod restart replaces with the image. A pod is now recognised by
  `KUBERNETES_SERVICE_HOST`, a podman container by `/run/.containerenv`, and the image and the chart set
  `WORDJS_DOCKER=1`. On Kubernetes the screen says to change the release's image tag (`helm upgrade`).

- **conference-manager 2.33.1: the admin speaks its language, and dates use the WordJS calendar.**
  - The field dialog's title and subtitle, a switch field's «Sí» / «No», and the forms of payment
    («Efectivo» / «Transferencia») now follow the admin language (English: *Yes* / *No*, *Cash* / *Bank
    transfer*; Portuguese: *Sim* / *Não*, *Dinheiro* / *Transferência*). The stored values do not change.
  - Every date in Conference Manager uses WordJS's own calendar instead of the browser's: the inscription
    form, conference dates, lodging dates, badge expiry, meal services, fee and transport payments,
    accounting, and the coordinators' portal. A required date is still checked in place, under the field.

- **Plugin screens use the WordJS dialogs instead of the browser's pop-ups.** Every delete, cancel, revoke
  and send confirmation in the marketplace plugins (auctions, bookings, contact forms, digital downloads,
  donations, event tickets, events calendar, FAQ, invoices, job board, mail server, memberships, newsletter,
  online store, polls, popup builder, restaurant menu, testimonials, vendor marketplace) now opens the host
  dialog, in the reader's language. The newsletter's *Send test* address, the mail composer's *Insert link*
  (which keeps the selected text) and the invoice link shown when the clipboard is unavailable use
  `useModal().prompt()`. These plugins are off the native-dialog list; only Conference Manager remains.
- **conference-manager 2.31.1: no browser-native dialog.** The badge designer asked with the browser's own
  `confirm()` before replacing a design with a template: a dialog outside the app's language and theme, and one
  that embedded browsers suppress, answering «no» without showing it, so the template never applied there. It
  now asks through the admin's in-app dialog, like every other confirmation of the plugin. A test sweeps the
  plugin's whole interface (admin and portal) so no `alert()`, `confirm()` or `prompt()` of the browser
  comes back. Nor the browser's validation bubble («Completa este campo»): every form of the plugin now checks
  its fields itself and shows what is missing or out of range under the field, in the admin's language
  (Spanish, English or Portuguese; the coordinator portal's screens, Spanish only, in Spanish), and moves the
  focus to the first field to fix. The same test pins that every form is `noValidate` and every required
  field has an in-app message.

## [2.9.0] - 2026-10-23

### Added

- **Image editing in the media library.** Rotate, flip, crop (free or a fixed ratio, by mouse, touch or keyboard) and scale down an image, then *Restore original* at any time. The edit is saved as a new file with its own sizes; the earlier files stay, so pages that already show them keep working (`POST /api/v1/media/:id/edit`, `POST /api/v1/media/:id/restore-original`).
- **The Redis server from the panel.** Settings → Performance sets the host, port, database and password, tries the connection before saving, and says whether Redis is connected, configured but not answering, or not configured; saving restarts the backend by itself. The cache switch no longer says «Redis is active» when no server answers.
- **My Account:** a profile picture, your own primary email, *Download my data* (JSON) and *Delete my account* (with your password; the only administrator cannot).
- **«Remember me»** on the sign-in page: unticked, the session ends when the browser closes.
- **Bulk actions on Users:** change the role of, or delete, several users at once.
- **Settings with a control for every key:** Reading (posts page with a static front page, feed length, *Discourage search engines*), Writing (default category), Discussion (moderation rules, name and email required, default comment status, link limit), date and time formats, and the image sizes. Each is validated, and the public site follows it (robots.txt and `noindex`, comment moderation, the formats in dates).
- **Menus:** add posts, categories and tags as well as pages; nest items as submenus (indent and outdent, or pick the parent) and open an item in a new tab.
- **Threaded public comments** with a *Reply* button; a comment published at once (no moderation) appears without reloading.
- **Tags you can create from the editor's tag field.**
- **`useModal().prompt()` and a gate against the browser's own dialogs.** WordJS never uses the browser's
  `alert()`, `confirm()` or `prompt()`: they block the page, cannot be translated, and some embedders suppress
  them so the action silently never happens. The host dialog gains `prompt(message, title, { defaultValue,
  placeholder, inputType })`, which resolves to the text, or `null` when cancelled, in the reader's language.
  The frontend's ESLint refuses the native dialogs. A repository test scans the frontend, the backend's
  public assets and themes, the gateway and every marketplace plugin, and tells a `confirm` taken from
  `useModal()` (allowed) from the browser global. The plugin files still being moved over are on a list
  that only shrinks.

### Fixed

- **Editing your own user from the Users list asks for your current password when it is needed.** Turning on a grant that sets your email (such as *Professional email account*), changing your email or setting a new password on your own row was refused with «current password incorrect» and no field to type it in; the dialog now asks for it, as the full-page editor does.
- **A crashed frontend no longer takes the whole service down.** In split mode, the Next server killed by a signal made `start-frontend.js` exit 0 and `concurrently` stopped the gateway and the backend with it (about a minute of total outage). The frontend is now started again after a crash, with the backend supervisor's back-off.
- **Fewer API requests per public visit:** the active plugins and the font faces come with the page (a font upload or delete now refreshes the cached pages), and comments are requested only when the reader gets near them.
- **Installer:** a wrong install token is reported on the first step instead of after the database form.
- **Menu and header/footer changes reach the public site at once** instead of serving the old version on the first visit; deleting a featured image refreshes the pages that used it.
- A fitted image size is named by its real dimensions (`300x200`, not `300x300`).
- The theme customizer warns before leaving with unsaved changes; the restore-revision dialog lists everyday field names; the collaboration notice reads naturally; the media library shows a type icon for files that are not images; the motion usage scan reads every entry.
- Ctrl+K: once you type, Enter inserts the best matching block instead of running the first action («Publish»).
- The public logo link has an accessible name even when the logo image has no alt text.
- A category's parent sent as a numeric string is accepted.
- **No error line on every start for a site without a network (PostgreSQL, MySQL).** At boot WordJS checks
  whether the network was switched on another node, and read the network store to find out; on a site that
  never had a network the store does not exist, and the database driver logged that read as an error on
  every start, although nothing was wrong. It now asks whether the store exists first; a store that exists
  but cannot be read is still logged.

- **A fresh install or upgrade no longer shows "Service Temporarily Unavailable" on the homepage for
  minutes.** The release is built with no backend running, so the homepage was prerendered as the
  outage page and shipped that way; after an install or upgrade, the site served that cached page until
  it revalidated (about five minutes in split mode). A build now drops any page that rendered the
  outage page, so the first request renders it for real, and it fails if one is left. At runtime, a
  page that cannot reach the backend is no longer cached either: the last good version keeps being
  served.
- **Plugins can add columns to their tables on PostgreSQL and MySQL.** A plugin's
  `ALTER TABLE … ADD COLUMN x DATETIME` (or `BLOB`) failed on PostgreSQL with `type "datetime" does not
  exist`, because only `CREATE TABLE` statements had their SQLite column types translated; on MySQL 8 a
  `TEXT DEFAULT '…'` column added the same way was refused. Columns added by `ALTER TABLE … ADD [COLUMN]
  [IF NOT EXISTS]` now get exactly the translation a `CREATE TABLE` column gets. In conference-manager this
  brings back fee payments ("fee payments migration did not complete") and the lodging dates on PostgreSQL.
  A type keyword inside a quoted default (`DEFAULT 'DATETIME'`) is no longer rewritten either.
- **Form fields show their edge before you click them.** The admin's fields rested on decorative greys, about
  1.1–1.5:1 against their card: Settings, Users, Posts, Media, Menus, Security, My account, Verso's inspector,
  and every plugin screen built on the same classes. The sign-in, password-reset, install and migration
  screens and the public site's forms did the same. Fields were invisible until focused. The base styles now
  give every text field, select and textarea a resting border of at least 3:1 (WCAG 1.4.11):
  - **Admin and system screens:** one colour, 3.4–3.8:1 on white and grey cards.
  - **Verso:** the editor's own outline colour, in both light and dark mode.
  - **Public site and plugin UI kit:** the field's own text colour at 60%, so it also reads inside dark
    sections. A theme can still set `--wjs-form-input-border-color`; Circuito's own search field border (1.3:1 on its dark field) is now 3.5:1.
  - **Focus:** a field keeps its own focus border and ring. One with no focus border of its own, such as
    the Verso inspector's fields, now takes the focus colour instead of dropping back to its faint grey.

  A focused field keeps its own colour and ring, and an invalid or deliberately coloured one keeps its colour.
- **A second menu with the same name can be created again.** Since term slugs became unique in the database,
  creating a menu whose name another menu already had answered an error; menus now take their slug the way
  terms do, so the second one gets `-2`, and a slug never starts or ends with a stray dash.
- **File names from non-Latin text.** An upload named `ñandú 漢字 😀 שלום.png` was stored as
  `--and--------…-<id>.png`; accents now fold, every other run of characters becomes one dash, and a name with
  nothing Latin left is stored as `file-<id>` (the original name stays the media title; stored names stay ASCII
  so they remain valid S3 keys).
- **WordPress import: `.mov` videos, and site-editor records.** QuickTime videos (`video/quicktime`) are
  accepted, as WordPress accepts them — from an import and from an upload. WordPress's own site-editor records
  (`wp_navigation`, templates, global styles, fonts, Customizer CSS) are no longer imported as posts whose
  link is a 404; the import leaves them out and the summary says how many.
- **PostgreSQL: a plugin's first insert after activation no longer fails.** When a plugin created a table with
  an auto-numbered id (`SERIAL` or `IDENTITY`) after it was activated — a mail server's first message, for
  instance — its own database role was given the table but not the counter that numbers its rows, so the first
  insert failed with "permission denied for sequence …" until the server was restarted. The counter is now
  granted together with the table. MySQL/MariaDB were not affected.
- **Verso: the text you are editing keeps its real colour.** Editing a text in place dimmed every other block
  to 40% opacity, including the blocks that contain the edited one, such as its Section or column. A
  container's opacity applies to everything inside it, so the text being written faded and was nearly
  invisible on a light background. A text animated by a scroll interaction also stayed frozen at the opacity
  the canvas scroll gave it. While a text is edited, the blocks that contain it are no longer dimmed, and its
  own and its containers' interactions and entrance animations show their resting state. The animation comes
  back when editing ends.
- **`create-wordjs --systemd` lets the site bind every port it will use.** An HTTPS site on 443 got a
  `60-wordjs-ports.conf` that allowed 443 only. Turning on Let's Encrypt HTTP-01 from Admin → Security
  then could not bind 80, and the mail server could not receive on 25, until someone edited
  `/etc/sysctl.d` as root. The drop-in now also covers 80 for an HTTPS site below 1024, and 25 with the
  new `--mail` option (implied on `upgrade` when the mail-server plugin is installed). The file lists each
  port and what it is for, and says how to add 25 when it is left out.
- **The single-name certificate form says what is wrong with the name.** Typing several names
  (`example.com, www.example.com`) into Admin → Security → SSL failed with a generic "Certificate
  provisioning failed" after a round-trip to the CA client. The form now catches a list before sending and
  points to Automatic Certificate Renewal, which takes several names for one certificate. The server refuses the same
  cases up front with a `code`, as it does a name that is not a domain, or a wildcard over HTTP-01; the
  form shows each in the admin's language.
- **mail-server 3.2.1.** Turning *Professional mail account* off in the user form gives the email field back
  (it kept the generated mailbox address, and what was typed was appended to it); an existing account's stored
  address is left as it is. Relay settings saved while the queue runs in another process take effect at the next
  delivery: removing a relay no longer leaves queued mail failing with "Relay unavailable". Opening a message no longer
  makes its body grow for seconds afterwards, sliding *Reply*, *Reply all* and *Forward* slowly down the page.
- **Every marketplace plugin's admin screen follows the admin language.** The screens of analytics-tag, auctions,
  card-gallery, cookie-consent, events-calendar, faq, image-lightbox, job-board, newsletter, notification-bar,
  online-store, photo-carousel, polls, popup-builder, restaurant-menu, social-share, testimonials, vendor-marketplace,
  video-gallery and youtube-videos are in English, Spanish and Portuguese (they were Spanish, some partly English), with
  dates in the admin's locale. Content the plugins store or show to visitors (banner texts, default labels) is unchanged.
  Each of them has a patch release.
- **Admin → Plugins shows that an action is running.** Activating a plugin starts its sandboxed process and can take several seconds, but the button gave no sign of it and stayed clickable, so the click looked lost and invited a second activation. While Activate, Deactivate or Delete waits for the server, its button now shows a spinner and "Activating…", "Deactivating…" or "Deleting…" (in the admin's language), and that plugin's lifecycle buttons stay disabled until the server answers.

## [2.8.0] - 2026-10-22

### Added

- **The gateway can forward a port to the backend node.** Admin → Servers → *Ports the gateway forwards to the
  backend* makes the gateway listen on a port and pipe each connection to a port of the backend machine, with a PROXY
  protocol v1 line so the receiver can still see the client's address. In separate mode the mail server's SMTP listener
  lives on the backend machine, and mail sent to the site's public address never reached it without a NAT rule
  configured by hand.
- **The monolith's port and HTTPS switch from the panel.** In a monolith, Admin → Security used to show the
  public port and HTTPS as read-only (set by environment variables or `gateway-config.json`, then a restart by
  hand). Both are now saved there: the port to `gatewayPort`, the switch to `gateway-config.json`, and WordJS
  restarts itself to listen with them. Turning HTTPS on moves a main address that names this listener to
  https at once; a new port is offered as the main address in Settings → Site address. A value
  the service's environment sets (`PORT`, `WORDJS_HTTP=1`) is shown locked, because the next start takes it again.
  Installing a certificate in a monolith keeps the HTTPS switch as it was.
- **Change a network site's address from the panel.** Admin → Network → *Change address* moves a site to
  another main address and sets its other host names (the `www.` twin, an old domain kept during a move),
  checked as at creation; the site's own address options follow, the certificate of the old address is
  removed and the gateway answers the new names at once (`PUT /api/v1/network/sites/:id/address`). Moving a
  site from staging to production no longer means deleting and recreating it.
- **Admin → Servers says more.** The gateway itself is listed with the protocol it serves and when its
  identity and the cluster CA expire; each node shows when its certificate expires; outstanding join tokens
  show their role, pinned address and expiry; a three-machine cluster is reported as *separate*.
- **Site Health checks the gateway and the servers behind it**: the protocol the gateway serves against its
  HTTPS switch, and any node that stopped answering.
- **Comment notifications by email.** Settings → Reading & Discussion has two switches (on by default, as in
  WordPress): email the administration address when a comment is held for moderation, and email the entry's
  author when a comment is published on it. They go through the site's mail plugin; spam, the author's own
  comments and a site without a mail plugin send nothing. The message carries the commenter's name and a
  plain-text excerpt, never their email or IP.
- **Turning the system mail service back on.** When a plugin's *Free port 25* disabled the machine's own MTA
  (Postfix, Exim, Sendmail) and that plugin is later deactivated or deleted, the Plugins screen says nothing is
  receiving mail on that port and offers to turn the service back on, after a confirmation.

- **Header & footer editor, out of beta.** Admin → *Header & footer* (`/admin/chrome`) now covers
  everything the built-in header and footer did, and more: a mobile hamburger that can collapse on
  phones, phones and tablets, or always; a sticky header and a header that is **transparent over the
  hero** and turns solid on scroll; multi-row headers (a toned top bar) and multi-column footers
  (`ChromeColumns`); per-breakpoint visibility on every block (hide on phones / tablets / desktop);
  and new blocks — heading, formatted text (sanitized on every render), copyright with `{year}` and
  `{site}` tokens, a language switcher that links the current page's translations and stays hidden on a
  monolingual site, and widget areas. The editor previews at desktop, tablet and phone widths, offers a
  gallery of starter templates, shows where the current design comes from (this site, the theme, or
  the built-in chrome) with a one-click restore, has undo/redo buttons, explains validation problems in
  plain language, edits the site's social profiles, and is translated into English, Spanish and
  Portuguese. Chrome is per site in a network. The contract additions are optional (`root.props`
  `sticky` / `transparent` / `width`, the `hide*` flags, the new blocks and props), so every theme's
  `chrome/*.json` and every stored composition keep validating and rendering as before. See
  [themes.md](documentation/themes.md#composable-chrome-chromejson) and
  [tutorial 17](documentation/tutorials/17-design-your-header-and-footer.md).
- **GraphQL is complete: mutations, uploads, the admin reads and subscriptions.** Every mutation is the REST
  write it names, dispatched in process as the same caller (content of any type — create, update, publish,
  schedule, unpublish, trash, restore, delete, meta; revisions; categories and tags; media upload, update and
  delete; comments and moderation; menus and their items; settings; the caller's own profile), with typed
  payloads and the REST error `code`/`status` in `extensions`. Mutations are `POST` only (a `GET` mutation is
  `405`), cost 20 more than the same read and are capped at 10 per document (`WORDJS_GRAPHQL_MAX_MUTATIONS`).
  Uploads use the GraphQL multipart request spec and are re-streamed to `POST /media` behind the upload rate
  limiter. New reads with REST parity: `users`, `user`, `revisions`, `revision`, `ContentNode.revisions`,
  `contentAccessLevels`, `webhooks`, `webhook`, `webhookEvents`, `plugins`, `networkSites`, and
  `comments(status:)` for moderators. Subscriptions (`contentChanged`, `commentAdded`) are served as GraphQL
  over Server-Sent Events at `/api/v1/graphql/stream`, fed by the content outbox and the comments table and
  re-authorized per event as the subscriber, with `Last-Event-ID` resume. See
  [graphql.md](documentation/graphql.md).
- **Plugins can declare per-account capabilities.** A manifest's new `accountCapabilities` block names
  capabilities in the plugin's own namespace that an administrator grants per account on the user screen
  (one toggle each, rendered from the declaration, for `edit_users` holders only — `GET
  /api/v1/users/account-capabilities`). Only `edit_users` can change a grant, it is never self-assignable
  and never derived from the email address, no role implies it, and only the declaring plugin is told
  (`req.user.accountCapabilities` and `accountCapabilities` on `wordjs.users.*`). A declaration may ask for
  two generic effects: `locksEmail` (the account cannot move its own address while it holds the grant) and,
  on a menu item, `requiresAccountCapability` (hidden from non-administrators without it). See
  [plugins.md §12b](documentation/plugins.md#12b-declaring-per-account-capabilities-accountcapabilities-).
- **Multisite: an idle site's plugin and theme workers stop, and start again on its next need.** On a network,
  the workers of a site other than the main one now start on the site's first request, due scheduled event
  or content event (not when a background pass opens the site) and stop once the site has been idle for
  `multisite.workerIdleMinutes` (default 15; `0` keeps them running), so many quiet sites no longer keep one
  process per site and plugin. The next request waits for them to start and is answered as usual; the site's
  activations, grants, egress allowlist and the network's ceiling are kept. Each node stops its own. The main
  site and single-site installs are unchanged. See
  [multisite.md](documentation/multisite.md#idle-sites-stop-their-workers).
- **Multisite: a network administrator can open any other site's admin as administrator.** Admin → Network →
  *Open as administrator* re-checks the password and sends the browser to the site's own address with a
  one-time link (signed with that site's key, bound to its address, valid once and for one minute). It starts a
  30-minute session there, marked as a handoff by a banner that says who came in, from which site and until
  when; it cannot be extended and ends when the network administrator is removed from the network. Every
  handoff is recorded in the network's audit log (issued, redeemed, refused) and in the site's own
  (`auth.network_handoff`). The session works under a dedicated, clearly labelled account of the site
  (`network.<login>`), created by the first handoff, that cannot sign in by itself, cannot be edited by the
  site's administrators and cannot mint API tokens or agent connections. Not for the main site, a suspended
  site, an API token or an agent. New routes: `POST /api/v1/network/sites/:id/handoff` and
  `POST /api/v1/auth/handoff`. See [multisite.md](documentation/multisite.md#opening-a-site-as-administrator).
- **Members-only content, in core and on every surface.** A post can require an access level (the
  `_wjs_access` meta, chosen as **Acceso** in the editor once a provider plugin is active). A reader who
  does not hold the level — and does not manage the post — receives its *teaser*, cut at the access break
  (an `<hr class="wjs-access-break">` in the HTML body, or the first Verso block declaring
  `contentAccessBreak`), on every read surface: REST (and therefore GraphQL), the cached public page, the
  RSS / Atom / JSON and taxonomy feeds, search (a gated post matches by title only) and the post's
  comments (not listed, fetchable, writable or in the comments feed). The excerpt is never derived from
  the withheld body. Levels come from two new filters, `content_access_levels` and
  `content_access_grants`, which only a plugin holding the new **`content_access:provider`** grant may
  answer; an unknown or malformed level fails closed. The page-builder tree is cut the same way on
  `GET /posts/:id/meta`, files attached to a gated entry are listed and served only to who manages it, a
  gated entry never ranks by its withheld body in search, and answers to a signed-in reader are sent
  `Cache-Control: private`. Signed-in members get the full body in the
  browser, with their own session, so the cached HTML never carries it. See `documentation/memberships.md`.
- **`memberships` plugin (1.0.0) in the marketplace catalog.** Free and paid tiers, a paywall block that
  ends a post's free teaser and shows the plans, a member account block (change tier, cancel / resume),
  Stripe Checkout subscriptions verified by signed webhooks, and complimentary memberships granted by the
  admin. Members are the site's own user accounts. Stripe runs in **test mode only** in this version (live
  keys are refused).
- **Plugin webhook routes and an HMAC bridge.** `wordjs.http.route('post', path, { webhook: true }, …)`
  receives the raw request body and the sender's signature headers and is exempt from the CSRF gate — and
  never carries an identity (no user, no cookies; it cannot be combined with `auth`/`admin`).
  `wordjs.crypto.hmac()` and `wordjs.crypto.timingSafeEqual()` let a sandboxed plugin verify the signature.
- The sign-in and sign-up pages honour `?redirect=<same-origin path>`, so a reader returns to the post
  they were reading.
- **Newsletters to members (`memberships` 1.1.0).** Publishing a post can email it to all, free or paid
  members (chosen in the editor), Ghost-style. Sends are queued and rate-limited by the plugin's worker,
  never inline in the publish request, and go out through the site's mail provider; failures retry with
  backoff and the admin sees a send log with delivered / failed counts, approves sends requested by
  authors, retries failures and sends tests. A post that requires an access level goes out in full only to
  members who hold it — everyone else gets the teaser and a link. Every mail has a one-click unsubscribe
  link (an HMAC token per account) plus RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers, and
  members manage newsletters from their account block. Newsletters go only to addresses the member has
  confirmed (a fixed-text confirmation mail, at most once every 30 days); what each member receives is
  decided when their mail is sent, and every step is claimed in the database, so several workers never
  send the same mail twice.
- **Mercado Pago and Wompi payments for memberships (`memberships` 1.2.0).** Payments now go through one
  provider interface, and the admin picks **Stripe**, **Mercado Pago** or **Wompi** in Ajustes (Stripe
  behaves as before). Mercado Pago uses preapproval subscriptions verified by the `x-signature` HMAC. Wompi
  has no subscriptions: each Web Checkout payment (card, PSE, Nequi, Bancolombia) buys one period in COP,
  with the amount fixed by the integrity signature; paying again prepays the next period, and automatic
  renewal is opt-in with a Nequi payment source the site charges before the period ends (declines retried
  daily, canceled after three). Wompi events are verified by the events-secret checksum. Every provider
  applies each event once and accepts sandbox / test credentials only. Paid memberships whose period ran
  out without a renewal are marked expired. Plugins get **`wordjs.crypto.hash()`** (an unkeyed SHA
  digest), and webhook routes also receive `*checksum*` headers and `x-request-id`.
  Every webhook re-reads the object it names from the provider's API and applies that, so late, replayed
  or out-of-order events only ever apply the current state. A tier upgrade is granted once it is paid
  (Stripe invoices the difference at once; Mercado Pago and Wompi from the next charge). A full refund or a
  dispute (Stripe) and a voided payment (Wompi) take access back. A membership whose renewal failed keeps
  access for 3 days from that moment. Tiers rank by their price per month. Amounts in zero-decimal
  currencies are sent in whole units. Starting a checkout retires the account's earlier unpaid ones, and
  each Wompi renewal is claimed before it is charged, so no period is charged twice.
- **Plugin fields in the post editor.** Through the new `post_editor_fields` filter a plugin declares a
  field (select, radio or text, validated by core) that the editor shows in the entry's settings and saves
  as unprefixed post meta (`GET /api/v1/editor/fields`).
- **`wordjs.posts.get(id)`** (grant `posts:read`) reads a published, public entry with its access level;
  **`wordjs.users.search()`** takes an `offset` to page through every account.
- **conference-manager 2.31.0: «Requiere hospedaje».** A new field template adds a Sí / No switch to the
  registration form (admin and coordinators' portal; `switch` is also a field type of its own). Whoever answers
  «No» is skipped by the automatic room assignment — the conference-wide run, each location's run and «Sugerir
  reparto» — and can't be given a room by hand: the administration's explorer and the coordinators' Hospedajes
  tab no longer offer them, and the server refuses the assignment (400). They no longer count as «sin
  habitación»; the portal lists them apart. Switching an attendee to «No» frees the bed they held. Conferences
  without the field behave as before.
- **conference-manager 2.30.0: everything since 2.17.2, in one release.** Versions 2.18.0 to 2.29.0 were built
  and tried on a test site but never released; they ship together now, and the entries below keep the version
  each change was made in: «Pagos de cuotas», split fee payments in the admin and the portal (2.18.0); rooms
  shared by several locations (2.18.0); «Escarapelas», each registrant's badge and its PDF (2.19.0); the
  fewest rooms and «Sugerir reparto» (2.20.0–2.21.0); lodging dates, held rooms and fixed people (2.21.0); the
  registration code as a QR Code (2.22.0); «Mi inscripción», the registrant's own page behind that QR
  (2.23.0); hotels on a map (2.24.0); «Verificar abordaje» (2.25.0); transport sold as packages of buses
  (2.26.0); boarding notices on the passengers' phones by Web Push (2.27.0); badge links that lead to «Mi
  inscripción» (2.28.0); and a free-form badge designer (2.29.0). They carry every security fix of 2.17.1 and
  2.17.2: the new portal routes use the opaque portal sessions and the per-location seat lock, and roles
  without «Inscripciones» never see an ID document. «Mi inscripción» signs in under the portal's rule: only
  the caller's own attempts can refuse it — other people's wrong documents make a sign-in wait, never fail.
  **Upgrading from 2.17.x:** update the core and the plugin together (the portal moved into the plugin, see
  *Changed*). The plugin now also asks for the `network` permission, used only to send the bus notices to
  the browsers' push services; until an administrator grants it in **Plugins**, the notices still show on
  the passengers' open page.
- **Plugin portal pages: sub-pages, a service worker and file downloads.** A plugin's `frontend.portalPage`
  can now describe its sub-pages (`pages`: a title; `private` — never indexed, never stored, no `Referer`;
  `app` — installable to a phone's home screen, with a web app manifest at
  `/portal/<slug>/app.webmanifest?page=<page>`), ship a service worker (`serviceWorker`, served as-is at
  `/portal/<slug>/sw.js`) and name a public route that turns a short-lived ticket into a file (`file`; the
  core answers the bytes at `/portal/<slug>/file?d=<ticket>`, PDF and images only). The menu editor's
  «System pages» offers every portal that is served (`GET /api/v1/plugins/portals`) instead of a fixed
  conference link. See [plugins.md §10.6](documentation/plugins.md).
- **conference-manager 2.29.0: a free-form badge designer, in the manner of Canva.** The site owner: the badge
  design should work like Canva, professional. «Escarapelas › Diseño» is now a canvas: start from one of six
  templates (horizontal and vertical); add texts in 14 typefaces (Montserrat, Poppins, Lato, Raleway, Open Sans,
  Roboto, Nunito, Oswald, Bebas Neue, Playfair Display, Merriweather, Lora, Dancing Script, Helvetica) whose content
  may carry the registrant's data as tokens (name, code, location, room, dates, conference, any form field — a
  text whose data is empty is not drawn), shapes (rectangles with rounded corners, circles, tags, bands, frames),
  lines, images (uploaded once to the conference's gallery; JPEG, or PNG keeping its transparency; any one can be
  the background) and the QR. Every element can be dragged, resized and rotated on the card with magnetic guides
  (the card's edges and centre, the other elements), aligned, ordered in layers, locked, duplicated, made
  translucent; undo / redo and keyboard shortcuts. Texts shrink to fit their box. The canvas draws the display list
  of the same layout code the server runs, measured with the same font files, so the designer, the badge on
  «Mi inscripción», the person sheet and the PDF match; the PDF embeds the typefaces it uses (TrueType, once
  each), the images (PNG transparency as a soft mask), rotation and opacity. A pre-2.29 design opens converted
  (its background and logo join the gallery) and keeps printing as it was until it is saved. The policy and
  «Mi inscripción» settings move to an «Ajustes» tab. The typefaces ship with the plugin (SIL Open Font License,
  `fonts/OFL.txt`) as modules, so the plugin reads no file and needs no new permission; they are served at
  `GET /public/badge/font`.
- **conference-manager 2.28.0: a badge link no longer shows the badge.** The site owner: the link the
  administration or a coordinator shares must not show the badge at once (it carried no check of any kind), but
  lead to «Mi inscripción». Opening a badge link (`/portal/conference/badge#t=…`, including every link sent
  before this version) now only goes to `/portal/conference/yo#c=<code>`, where the person confirms their
  identity document before seeing the badge; the plugin answers such a link with that address alone (no badge,
  no name), and the link's PDF route is gone (410). With «Mi inscripción» off, or no document field to ask, a
  link shows nothing. The badge stays available to staff (preview, PDFs) and, after the document, on «Mi
  inscripción». What the admin's person sheet and «Escarapelas › Personas», and the coordinators' portal, open,
  copy, export and send by WhatsApp is now that page's own address (each link carries `self`), not the old link.
- **conference-manager 2.27.0: boarding notices on the passengers' phones.** The site owner: tell a bus's
  passengers that it is boarding, by browser notification, from a boarding section in Transporte. Each bus card
  now shows its state (Programado / Embarcando / Salió) and how many of its passengers have the notices on, with
  «Iniciar embarque», «Marcar salida», «Mensaje» (free text, up to 240 characters, with the bus's notice history)
  and a reset. On «Mi inscripción» a new «Mi transporte» section lists the person's buses with that state and the
  team's messages (refreshed every 30 s while the page is open), and offers «Activar avisos del bus»: the page
  registers its own service worker (`/portal/conference/yo-sw.js`, scoped to the page) and the plugin sends real
  Web Push notifications, which arrive with the page closed. The payload is encrypted per RFC 8291 (checked
  against the RFC's own test vector) and signed per RFC 8292 (VAPID; the site's key pair is generated once), with
  no new dependency. A subscription belongs to the page's session and goes when the person leaves, when the
  session expires, or when the push service reports it gone; only push services' hosts are accepted as endpoints.
  Sending needs the new optional «network» permission; without it the notices still show on the open page and
  the admin is told. On iPhone, Safari delivers web notifications only to a page added to the home screen (iOS
  16.4+); the page is installable for that (web app manifest) and explains the steps there.
- **conference-manager 2.26.0: transport is sold as packages of buses.** The site owner: create packages of buses
  and sell the packages. A package (Transporte › Paquetes) is a fixed list of buses (e.g. «Ida y regreso» = Bus 1
  + Bus 4) with one price; selling it to a person creates the sale (its own price, payments and status) and a
  seat on every bus of the list — all-or-nothing, never beyond a bus's free seats, never for someone who already
  sits on one of those buses. The list of a sold package is locked; its price changes for new sales, and with
  «aplicar a los ya vendidos» for the sold ones, never below what a sale has been paid. Payments are recorded per
  sale (never beyond its balance) and are the transport income of Contabilidad; a sale or a package with
  payments, or a bus in a sold package, cannot be removed until those payments are. Single bus tickets are no
  longer sold (`POST /buses/:id/passengers` and ticket payments answer 410); the bus keeps its seats, its
  passenger list (now showing each person's package and its payment status), the Excel manifests and the
  boarding check. On upgrade every ticket sold the old way becomes a sale of a one-bus package named after its
  bus, with its price and its payments moved over (once; nothing counted twice). The transport workbook gains a
  «Paquetes» sheet with the money, the per-bus sheets show the package, and the custom roster's transport columns
  count each package once. Server in `server/transport-packages.js`; routes under `/transport/packages` and
  `/transport/package-sales`.
- **conference-manager 2.25.0: «Verificar abordaje» — scan a badge to know whether the person travels on the bus
  being boarded.** The site owner: in Transporte, choose the bus, scan each person's QR and see whether they belong
  to that bus. A full-screen scanner (from the page header, or the QR button of a bus card, which opens on that
  bus) reuses the meal scanner's camera, readers (BarcodeDetector where it reads QR, else jsQR and the built-in
  barcode reader), aiming frame and beeps; a USB / Bluetooth reader or a typed code works too (keys typed while
  nothing has the focus go to the code box). New read-only `POST /transport/check { bus_id, code }` (transport
  view or manage) reads the code, the «Mi inscripción» link of the QR or an older Code 128 badge
  (findByScanCode) and answers `ok` (with what the ticket still owes, shown as information), `other_bus` (naming
  the person's bus), `no_ticket`, `cancelled` or `unknown` (also for a code of another conference). Nothing is
  recorded.
- **conference-manager 2.24.0: the hotel form finds the hotel and pins it on a map; «Mi inscripción» no longer
  shows the payment.** The site owner wanted to search the place and see it on a map instead of pasting a link.
  The hotel form now has a search box (OpenStreetMap's Nominatim, called from the admin's browser on an explicit
  «Buscar» only and at most once per second, as its usage policy asks; results in Spanish, limited to the
  browser's country) whose results put the pin on the map, and a map of OpenStreetMap tiles drawn as images
  (drag to move, buttons or a double click to zoom, a click to put or move the pin, «Centrar» / «Quitar punto»).
  Picking a result fills an empty address. Pasting a Google Maps link or coordinates is still there, as an
  option. No map library and no CSP change. The participant page and its server answer drop «Mi pago» (the
  owner: not to be shown there).
- **conference-manager 2.23.0: «Mi inscripción», the registrant's own page behind their badge's QR.** The site
  owner: scanning their own QR, each person confirms their document type and number and sees all their
  registration — the virtual badge (and its PDF), their answers, their payment, the meals already delivered and
  when, those still to come, and their hotel, room and a map of the hotel. The badge QR (PDF, previews, the code
  viewer and the Excel column) now carries `<site>/portal/conference/yo#c=<code>`; the meal scanner, the camera
  readers and the server's scan lookup take the code out of that link, so the kitchen scans the same QR as
  before. The page lives in the core portal (`/portal/conference/yo`, noindex, no Referer, the code in the
  fragment) and talks to new public plugin routes (`/public/me/start | verify | view | ticket | logout`,
  `server/selfpage.js`): the document must match the registration's (punctuation and accents ignored; the type
  only when one is recorded), then a session token — stored only as its SHA-256, 30 days or the badges' expiry —
  lets that phone reopen the page without asking again until the person leaves. Failures are throttled per code
  (5 in 15 minutes lock only that code), per client and globally; an unknown code and a wrong document answer the
  same 401; nothing about another person (no roommates) is ever shown. «Escarapelas › Uso» turns the page on or
  off (on by default) and chooses the document fields (detected by their labels otherwise). Hotels can now be
  edited and get a position: a full Google Maps or OpenStreetMap link, or coordinates (`server/geo.js`, the
  place's pin preferred over the map's centre; a short `maps.app.goo.gl` link is refused with instructions, as
  it does not carry the position), stored as TEXT `hotels.geo`. The map is OpenStreetMap tiles drawn as images
  with the hotel's pin and the OSM credit (no script or frame, so the site's CSP is unchanged), plus «Cómo
  llegar» / «Google Maps» links. The plugin now requests `settings:read` to read the site's address for the
  link; without the grant the QR keeps the bare code. The portrait badge's QR strip grows (the six field rows
  keep their places) since a link is a denser symbol, drawn at error correction M.
- **conference-manager 2.18.0: «Pagos de cuotas», split fee payments in the admin and the coordinators'
  portal.** A payment is now one receipt (a bank transfer or a cash handover) split among the people it
  covers, and the parts must add up to its amount to the cent. The split is «Iguales» (the default; the
  leftover cents go to the first people, 100.00 / 3 = 33.34 + 33.33 + 33.33) or «Manual»; the server, the
  admin and the portal run one set of split vectors. Nobody can be paid more than they still owe, counting
  money awaiting validation, in the admin and the portal alike (`409 over_cap`); validating checks it again
  after a re-price, and refuses a payment that still holds a person cancelled since — a cancelled
  inscription owes nothing (`409 cancelled_people` until the split is corrected, the person reactivated or
  the payment rejected). On a multi-node install the rule holds across nodes too: every write that adds money
  checks it again after writing, and the one that would overpay is undone and answers `409 over_cap`; each
  correction of a payment works on a split generation of its own, so two corrections at once (or a node
  restarting meanwhile) never delete each other's split, and a correction that backs off never undoes a
  validation another node made in the meantime, nor does a validation whose last write lands late undo another
  node's void; a correction undone that way puts the previous split back even when a node restarting meanwhile
  had already cleared it, so the payment and its receipt never vanish. Deleting a person is safe across nodes
  too: a payment another node records with that person at the same moment either makes the delete answer
  `409 shared` or backs off itself (`400 unknown_people` / `cancelled_people`) — a receipt is never left with
  a part missing; a 1-person payment of theirs that another node re-splits at that moment is never deleted
  with them: moved to someone else, it stays (now theirs) while the person goes; made shared, the delete
  answers `409 stale` and leaves the person as they were — every payment is read again before anything is
  deleted, validated ones (whose split never changes) go last, and in the instant between two deletes the
  answer names any payment already deleted — and a correction or a
  validation whose payment another node deleted meanwhile answers `409 stale`, never success — and while the payment tables are unavailable a person with payments cannot be deleted
  (`503 unavailable`; cancel the inscription instead). A correction never changes which voided payment a
  payment records again: a `PUT` naming another `duplicate_of` / `copy_proof_from` answers `400 source_fixed`,
  so a copy can never leave its receipt's payment free to count a second time. A payment interrupted halfway through being written never counts as income, not even while the
  payment tables are unavailable or after a downgrade — a correction interrupted halfway does not either,
  also after a healthy restart in between — and deleting a
  location waits for a payment its coordinator is recording at that moment (which then names no location
  instead of the deleted one — also when the two happen on different nodes, and «Devolver» checks that the
  recording location still exists). The receipt is required for a transfer and
  optional for cash, is shrunk in the browser to at most 1,000,000 characters (a file over 15 MB is
  refused), is stored once per payment and is loaded only when someone opens it; the server refuses
  (`400`) an image whose header declares more than 8192 px on a side or 24 megapixels, which a browser
  showing it could not decode, and a receipt stored before 2.18.0 that fails the same check is never shown
  (`422 invalid_proof`), copied by «Duplicar» or kept by a correction. A payment is «Por validar», «Validado», «Devuelto» (sent back with a note,
  then corrected and resent by whoever recorded it: the administration or the recording location's
  portal — a payment from before 2.18.0, or one of a deleted location, has nobody to correct it and is
  edited, validated or rejected instead, `409 no_recorder`) or «Rechazado» (a reason is required). A shared payment
  is validated all or nothing, exactly as the reviewer saw it (`expected: { status, alloc_gen }`,
  `409 stale` otherwise). A validated payment is never edited: it is voided with a reason, and then
  «Duplicar» records it again with the same receipt, date and reference. «Duplicar» is offered only on a
  voided payment, and the server refuses to copy the receipt of one that still counts or can still count
  (`409 proof_source_live`): one receipt never stands behind two live payments. A voided payment is recorded
  again only once: while its copy counts, a second «Duplicar» of it and validating it again are refused
  (`409 source_used`, also between nodes and for cash without a photo), and the two say so — the voided one
  «Registrado de nuevo en el pago #N», the copy which payment it records again; voiding or deleting the copy
  frees it. A payment back in «Por validar» after a correction or a resend shows no «Revisado por» (it
  awaits a new review; its history keeps who returned it). A payment the admin registers is validated at
  once unless «Dejar por validar» is ticked, and may cover several locations; a portal payment is always
  pending and holds only that location's people, also when the administration corrects it (`400
  unknown_people` for anyone added from elsewhere; a person who moved away since may stay). A retried
  request never records twice (`client_key`) and repairs the balances of a first attempt that failed after
  writing — but only the same request: one sent again under its key with other data (a send whose answer
  was lost, corrected on screen and sent again) answers `409 client_key_changed` naming the payment that was
  recorded, never «registered» for a payment that is not the one on screen, and the admin and the portal say
  so and reload; a transfer reference already used by another live payment asks for confirmation — also when
  any payment is validated, pending, returned or voided (`409 duplicate_reference` unless the admin confirms it
  is another transfer: the same bank transfer recorded again by hand as a new payment — or confirmed by a
  coordinator with «Registrar de todas formas», or sent by an older portal — never counts twice unseen; a
  confirmed one says so in its history, «Referencia repetida confirmada: también cuenta en el pago #N»), and of
  two payments recorded with one reference at the same moment on two nodes, one backs off. Old payments
  become one-person payments at boot, with their amounts, statuses and receipts. If the boot migration of
  the payments fails, the plugin keeps working on the old payment rows (coordinators still sign in and see
  their people and balances; the roster and the reports work), but no payment can be recorded until the
  migration completes: the «Pagos de cuotas» routes answer `503 unavailable` until a later attempt completes
  it — to an account with the payments permission; any other gets its `403` first and starts no migration
  attempt — and the portal's payment form, the older one included, says «Los pagos no están disponibles en
  este momento; inténtalo más tarde.» instead of a message meant for the administrator. Deleting a person who is part of a shared payment answers `409 shared`
  saying what to do for that payment's status (take them out of a pending or returned split, void a
  validated payment and record it again, delete a rejected one — or cancel the inscription); a role without
  Pagos › gestionar gets only «La inscripción tiene pagos registrados…», never the payments' numbers,
  statuses or sizes; and a role with Inscripciones but without Pagos › ver reads a person's payments as each
  part's amount, date, method and status only — never the payment behind it (its number, size, people), its
  reference, its receipt or its review (`GET /inscriptions/:id/payments`; the person sheet shows the same).
  - **Admin.** A «Pagos de cuotas» tab next to «Contabilidad» (`payments:view` to look, `payments:manage` to
    register and review) has four parts: «Resumen» (fees, validated, awaiting validation, returned, still
    to collect, one bar that adds up to the fees, one line per location — the same figures the coordinator
    sees — with an «A favor» column whenever any money is held in credit); «Por validar», oldest first, with
    the payment beside the list on a wide screen (the list narrows on a 1280 px window so the
    «Devolver… / Rechazar… / Validar y siguiente» bar keeps to one row), the list and that bar kept in view —
    the bar is the payment card's last row — while the receipt scrolls (no bulk validation; «Editar
    reparto · Eliminar» come first, above the receipt, so a short payment never hides them under the bar);
    the receipt shown is always the payment's current one, also right after the coordinator resent it with a
    new photo; «Pagos», every payment with filters — on a desktop its columns follow the room the card has
    (at 1280 px beside the sidebar the people's names got no room at all and two headers were drawn over
    each other): «#», the people, the total, the status and «⋮» always, the date and the method, then the
    location and the reference as they fit, and what does not fit is written under the names; and «Saldos»,
    one row per person, where up to 200 people are selected for «Registrar pago (n)»; its filters wrap
    instead of scrolling sideways and carry their counts, which follow the search. A returned payment's
    note shows on two lines in the phone list, and a reference («Ref. KEEP-77») is never split across two
    lines. The «Por validar» count beside the section's tabs is legible (AA contrast). Escape typed in a
    field belongs to the field (it clears a search box) and no longer closes the sheet around it;
    «Registrar pago» and the inscription form ask before Escape throws changes away, and in a payment Escape
    closes an empty «Devolver… / Rechazar…» reason box and keeps a typed reason («Cancelar» discards it) —
    never the payment with the reason in it. In
    «Registrar pago» each person reads «debe $X», or «$Y por validar · falta $X» while some of their money
    awaits validation; a part says «Queda pagado al validarse lo pendiente» when it is that other money
    that still has to be validated, and «Supera lo que falta: máximo $X» past what the person may receive
    — the portal's words, as are «Forma de pago» for the one method of a payment, «Referencia de la
    transferencia» / «Referencia (opcional)» and the sum line «Asignado $X de $Y · ✓ Cuadra / Faltan /
    Sobran» (the payment sheet says it the same way); an amount typed «250» reads «250,00» once its field is
    left; an empty sheet's button reads «Registrar pago» without «$0,00»; the person search's placeholder is
    «Buscar persona», whole on any phone; the footer says how much is missing or left over in the split. The
    dashboard gains «Pagos por validar · N · $X», and its «Sin pagar» card becomes «Con saldo» (people with
    something no payment covers yet — the «Saldos» filter of that name); «Pagados» no longer counts
    cancelled inscriptions. «Contabilidad» shows one line
    per payment («Pago de cuotas · 3 personas», «· 1 persona», in the admin's language; expandable; its lock
    opens the payment; its origin line says «Pago de cuotas», like the Excel), a location filter
    that keeps each payment's share of that location's people (the locations add up to the whole), and a
    «Detalle de cuotas» Excel sheet. Its layout follows the room the panel really has, not the window: at
    1280 px beside the sidebar the movements no longer overflow their card (the amount was cut to «+$50…»),
    «Por categoría» moves beside them only on a wide page, Categoría and Forma de pago fold into each line's
    description when the columns do not fit, on a phone each movement is a block with its date and amount
    on top, and the filters wrap with whole dates (16 px on a phone). Fee amounts read like the portal's («$1.550,00»); the payment history
    names the coordinator's location («Portal de Bogotá»); on phones every control of the payment sheets is
    at least 44 px tall (the manual entries' edit / delete in «Contabilidad» too, now always visible), the
    sections wrap instead of scrolling sideways, and a sheet's pinned buttons stay above the iPhone home
    indicator. Every in-app confirmation is announced with its question. «Reportes» computes its figures
    like «Resumen»: a cancelled inscription owes nothing, «Recaudado» is the validated money up to each fee,
    «Saldo pendiente» (awaiting validation plus still to collect) is never negative, «A favor» shows apart,
    and the Pagado / Abono / Sin pagar counts are of active people, with the cancelled ones counted apart.
    «Reportes» and the CSV export gain a «Por validar» column, the
    roster Excel «Por validar» and «Devuelto», and a «Pagos de cuotas» workbook lists the payments, their
    split and each person's balance. Phones and real amounts: a sheet's footer keeps «Cancelar» and its main
    button on one row and the sheet scrolls a focused field clear of the footer's real height (on an iPhone SE
    the wrapped footer of «Registrar pago» covered «Monto total»); totals of $1.000.000,00 and more stay on
    one line in their tiles, shrinking to fit, and «Saldos» writes «debe» / «falta» over a whole amount;
    every field is 16 px on a touch screen held sideways too; an e-mail in the person sheet wraps at «@» and
    «.». «Validar» on a voided payment whose transfer reference another live payment uses asks «Esa
    referencia ya cuenta en el pago #N. ¿Validar de todas formas?». A part's «Supera lo que falta: máximo $X»
    comes into view with its field — also the moment it turns red while the amount is typed — instead of
    under the pinned footer, and so does «Usar lo que falta» with «Monto total». On a phone held sideways the
    sheets pin their header (title, ✕) and their footer (the main button and why it is disabled) as they do
    upright. The receipt pickers' «Tomar foto o elegir archivo» / «Cambiar» are buttons a keyboard reaches
    with a visible ring, and the method, split and section strips are one Tab stop moved with the arrow keys,
    as their radio / tab roles promise — and going «Manual» → «Iguales» → «Manual» gives back the amounts typed
    (they used to be replaced by a new split). «Contabilidad» never splits «1 persona» / «3 personas» from its
    count, nor leaves its «·» alone («Pago de cuotas» / «· 3 personas»; its origin, people and «Categoría ·
    Forma de pago» lines too, and «Carlos G.» stays whole), a location card says «1 pagado», and a payment's
    facts never leave a «·» alone at a line's end — the payment's header, recorder and history lines, the
    review queue's cards, the phone «Pagos» rows and the person sheet's payments («$200,00 · de $550,00 ·
    compartido con 2») alike; a coordinator reads «Portal de Bogotá», one fact, on screen and in the Excel.
    The clickable «Por validar» tile lines up with the others. On a phone, what «Eliminar», «Cancelar
    inscripción» and «Reactivar» did comes into view above the person sheet's pinned buttons (a refused
    «Eliminar» showed nothing until the sheet was scrolled to its end), and «Usar lo que falta» comes into view
    with «Monto total» also when it appears while the amount is typed on a phone held sideways. Sideways, the
    payment and person sheets pin only their title row (the payment's facts, recorder and reviewer, the
    person's chips scroll with the body: pinned, they left the receipt a 176 px slit), and the person picker of
    «Registrar pago» is capped by the room it has. On a phone «Pagos» keeps its status chips and search in
    the page and folds location, method, «Registrado por» and the dates into «Filtros (n)» (an iPhone SE
    showed no payment on its first screen). Choosing or removing a receipt keeps the keyboard focus in the
    picker («Cambiar», or the empty picker's button) instead of dropping it outside the dialog. «Asignado $X de
    $Y» is green «✓ Cuadra» only when the split can go — beside a part over what someone owes it says «Una
    parte supera lo que falta». The «Contabilidad» Excel and its date filter use the browser's day of a server
    stamp, as its screen does (a transport payment recorded at 21:52 in Bogotá was dated the next day in the
    Excel). The «Pagos de cuotas» workbook writes
    «Revisado el» in the browser's time zone (a review at 18:40 in Bogotá read «23:40», after 19:00 the next
    day) and «Registrado por» as «Portal de Bogotá», not «portal:1». What a person still owes reads «debe $X», or «falta $X» beside «$Y por validar», in the picker,
    «Saldos» and the sheet alike; the «Pagos» status chips always show their count («Devuelto (0)»); a queue
    card never splits «1 persona». In the desktop review queue the list and the payment are two columns as
    tall as the panel's room, each scrolling on its own: the payment opens whole, only its body (receipt,
    split, history) scrolls, and its «Devolver… / Rechazar… / Validar y siguiente» bar is its last row —
    never over the payment (at 1280 × 800 the pinned bar covered a short payment's «Historial»). What an
    action did is said above the list, and in a payment sheet in its header, instead of a toast over
    «Rechazar… / Validar y siguiente». In «Contabilidad» a
    transport line (or a fee line one may not open) says «Se gestiona en Transporte» / «… en Pagos de
    cuotas» in words instead of a faint hover-only lock, and on a phone a line's actions sit beside its
    description. A focused field of a sheet comes whole into view — above the pinned footer and the keyboard,
    on a phone held sideways too (only the caret line used to be revealed: the field's border, or the second
    row of «Nota», stayed under the footer) — and dialogs are compact on a short screen. What fits follows the
    room a block has, not the window, wherever the admin sidebar narrows the panel (an iPhone held sideways, an
    iPad in portrait): the «Pagos de cuotas» tabs wrap inside it («Saldos» stuck out of the strip), «Por
    localidad» is a table only in a wide card, the «Pagos» filters lay out as many columns as fit (the dates
    ran under each other and the selects were cut mid-word), and the «Contabilidad» totals sit side by side
    only while each fits, on one line («Ingresos» ran into «Egresos»). In «Inscripciones» a form column keeps a
    domain whole («iglesiaevangelica» broke mid-word at 1366 px: there the second column now folds under the
    name). In the review queue the keyboard focus moves to the next payment after «Validar y siguiente»,
    «Devolver» or «Rechazar» (it fell outside the dialog), the reason form takes the focus and «Cancelar» gives
    it back to its button; a disabled «Validar» says why right above it, in words; a quick reason is added to
    the typed text instead of replacing it; a tap beside the payment sheet keeps a typed reason; and a voided
    payment that another one records again no longer says «Supera lo que debe». «Registrar pago» says a failed
    send in its footer (a toast covered the button and was never announced), a part's «Supera lo que falta:
    máximo $X» is read with its field, and money fields group thousands once left («1.250.000,00», as every
    other amount reads). «Columnas» opens to the side that keeps it inside the panel; «Saldos» says when the
    200-person cap is reached instead of ignoring the tick, and a 15-figure amount stays inside its row; the
    «Por localidad» location is a 44 px target and its phone line breaks between facts, never before a lone
    «· $580,00 por validar»; «Contabilidad» opens a fee payment with «Ver pago #N» (the padlock means
    read-only) and keeps «· Bogotá» with its name; the person search's name starts with its visible words.
  - **Portal.** A «Pagos de cuotas» tab with a badge («2 devueltos», «3 por validar») has the same
    «Resumen», «Saldos» (chips for family groups of two or more people who can be paid, filtered by the
    search, at most eight with «Ver más grupos»; a page or up to 200 people; a sticky «Registrar pago (n)» bar)
    and «Pagos», where returned payments come first with the administration's note, to be corrected and
    resent or deleted (the note stays at the top of the correction). «Registrar pago» says why «Enviar» is
    still disabled right above it, offers «Repartir según lo que debe cada uno» when «Iguales» would
    overpay someone, waits while a photo is being shrunk (no second photo can be picked meanwhile; the
    latest one wins), shows the live reason again as soon as a refused draft is changed, and keeps the
    receipt, reference and date when it is reopened for other people — saying so, with «Empezar de cero».
    Each part reads like the admin's («Queda pagado al validarse», «… lo pendiente», «Faltará $X»), a
    «Manual» amount typed «250» reads «250,00» once its field is left, and the receipt is «obligatorio para
    una transferencia», as the admin says. «Ver comprobante» on a payment just corrected and resent shows the
    new photo, never the one seen before. The «Saldos» chips count the people the search finds, and the
    administration's note on a «Pagos» row shows on two lines.
    «Registrar pago de esta persona» loads the payments once more for someone registered after they were
    loaded, and says why when the person cannot be paid instead of opening an empty sheet. Empty states and
    the loading label are legible outdoors (AA contrast). Payments the administration recorded for the location's people show as «Registrado
    por la administración» with only their part, without receipt or reference. Only the location's people
    and its enabled forms of payment are offered. The tab loads with one request; receipts load on demand.
    A correction («Editar», «Corregir y reenviar», «Registrar de nuevo») closed without sending — Escape,
    ✕ or «Cancelar» — comes back as it was left when that payment is opened again, saying so, with
    «Empezar de cero», and Escape typed in a filled field (the person search) clears the field instead of
    closing the sheet. A rejected payment already registered again offers no second «Duplicar» and says
    so. The «Manual» split fits a six-digit peso part («250.000,00»), a part over what someone owes keeps
    its «Supera lo que falta: máximo $X» in view above the footer, totals stay on one line in their tiles,
    every field is 16 px on a phone held sideways, the picker says «falta $X» and «$Y por validar» when some
    of the person's money awaits validation, and the pager's size select is named «Mostrar pagos por
    página» / «Mostrar participantes por página». On a phone held sideways a sheet keeps room for its form
    (its header and footer are compact below 500 px of height: the body had about one field). While a sheet is
    open, what the payments have to say is said in it — who was left out when «Registrar pago» opened for
    several people, a delete that failed, a payment sent from a participant's sheet — instead of a toast over
    its buttons. A part's «máximo» is read with its field, money fields group thousands once left, the
    «Participantes» caption counts active people with «· 1 cancelada» apart (as the hero does), its facts
    never leave a «•» alone at a line's end, the «Pagos de cuotas» badge stays on one line, and the search
    fields' names start with their visible words («Buscar participante…», «Buscar persona en los saldos»).
    A payment's «Revisado» and a participant's registration date are the local day, as in the admin: a
    payment returned at 19:05 in Bogotá no longer reads «Revisado 09/10» beside «Fecha del pago 08/10».
    «29 inscritos · 1 cancelada» keeps each count with its noun and its «·» with the next count, a payment
    row's facts and a person's money line («$250,00 por validar · falta $250,00») never leave a «·» alone, the
    «Por validar» tile lines up with the others, the method and split strips move with the arrow keys (and
    «Manual» gives back the amounts typed before a look at «Iguales»; «Repartir según lo que debe cada uno»
    still splits by what each one owes), the receipt picker is a button a keyboard reaches and keeps the focus
    once a photo is chosen or removed, «✓ Cuadra» shows only when the split can go, and on a phone held
    sideways the person picker's list is capped by the room and hands the scroll on to the sheet («Pago»,
    «Reparto» and «Comprobante» stayed out of reach). What a sheet has to say (a delete that failed, people
    left out) is scrolled into view when it changes. A payment sent again with other data after its answer was
    lost says it was already recorded and reloads the payments, instead of «Ese pago ya estaba registrado». While the plugin's payment tables are unavailable, the older payment form says «Los
    pagos no están disponibles en este momento; inténtalo más tarde.»
  - **API.** `GET`/`POST /fee-payments`, `GET`/`PUT`/`DELETE /fee-payments/:id`,
    `POST /fee-payments/:id/validate | return | reject`, `GET /fee-payments/:id/proof`;
    `GET`/`POST /portal/fee-payments`, `PUT`/`DELETE /portal/fee-payments/:id`,
    `GET /portal/fee-payments/:id/proof`. «Duplicar» sends `duplicate_of` (the voided payment, with or
    without `copy_proof_from`); a payment carries `duplicate_of` and `reused_by` (the portal: `duplicate_of`,
    `reused`, `reused_by` of its own payments), and a second copy answers `409 source_used`.
    `/portal/me` and `/portal/login` report `features.fee_payments`
    and the badge counters; the core portal shows the tab only when the plugin reports the flag and keeps
    its previous payment form otherwise. An older core portal keeps working through
    `POST /portal/payments/bulk`, which now records one pending payment of N equal parts and refuses the
    whole request when any person is outside the location; it accepts a transfer reference already used
    (that portal cannot ask for confirmation; the admin's queue flags it «Referencia repetida»). Documented in
    `documentation/plugins-reference.md`.
- **conference-manager 2.18.0: inscription lists with pages and a person sheet.** «Inscripciones» downloads
  the roster once and searches, filters and pages it in the browser: one card per location with a header
  that stays in view and its own pager, 20 people per page («Mostrar 10 / 20 / 50 / 100», remembered on
  the device; a page change brings that location's card back to the top of the list — moving only the list's
  own scroller, so the conference title and tabs never slide away), a search that ignores accents and case, and filters for location, payment, «Por validar»,
  room and «Ocultar canceladas». On a phone each person is one compact row (name, payment with balance,
  room, wrapping instead of cutting «Sin habitación» short); on a desktop a slim table with up to three form
  columns chosen in «Columnas» — as many as the location card fits, and a chosen one that does not fit is
  written under the name («Iglesia: Betel»): the name column never narrows below 12rem, so names no longer
  break mid-word, and a card too narrow for the table shows the compact rows. Nothing in the table is cut
  short behind a hover-only title: the room wraps («Hab 101 · Hotel Central»), the «Alojamiento» column
  widens when the card has room to spare, a form value wraps (an e-mail at «@» and «.»), and the column
  headers stay in view under the location's header while its rows scroll. The registration code is a 44 px
  button, the location and «Columnas» menus close with Escape or a press anywhere else (the admin sidebar
  too), and the room filter is «Alojamiento», like the column. Screen readers hear each row's state
  («Ana Pérez: Abono, $200,00 de $250,00, Sin habitación, $50,00 por validar») and the desktop payment
  button's («Abono: pagos de Ana Pérez»), in the admin and the portal.
  The ⋮ (or a tap on
  the row on a phone) opens the person's sheet with every field and every action, including the new
  «Cancelar inscripción / Reactivar» (its confirmation reads «No, mantenerla» / «Sí, cancelar
  inscripción»); cancelled people are struck through and labelled «Cancelada». What «Cancelar inscripción»,
  «Reactivar» and «Eliminar» did is said in the sheet, right above its buttons — an error stays until the
  next action and is announced — instead of a toast that covered those buttons on a phone and vanished
  before a refusal's steps could be read; after «Eliminar» the keyboard focus goes to the neighbouring row
  (it fell to the page's start); the sheet's details are a valid list for screen readers; and the roster
  Excel's «Fecha de inscripción» is in the browser's time zone. The conference header's back
  arrow is a 44 px button with a name. After
  an action only the people it touched are read again (`GET /inscriptions/:id`, new). The coordinators'
  «Participantes» gets the same pages, search, compact rows and person sheet, with «Registrar pago de esta
  persona» and «Ver sus pagos»; its desktop table's values wrap instead of being cut, its headers are
  legible (AA contrast) and wrap between words (a long form label ran over the next one), its two form
  columns show only where the card has room for them and fold under the name otherwise (an iPad in
  portrait), its search reads «Buscar participante», whole on any phone, and the sheet's subtitle reads
  «Inscripción: 15/09/2026».

- **conference-manager 2.18.0: beds per location — one hotel room shared by several locations.** The
  administration could only give a location whole rooms, so giving it 5 beds in rooms of 4 left 3 beds
  that no other location could use. A room can now be split: «Repartir camas» on a room (Hospedaje) gives
  each location some of its beds and leaves the rest in the pool, and «Dar camas a una localidad» on a hotel
  gives a location N free beds — empty rooms whole first, then the free beds of a room, shared. It never
  moves anybody and is all or nothing (`409 not_enough_beds` with how many are free); the location's people
  the administration had already put on pool beds of a room become part of its beds there. A person takes one
  of their location's beds first, then a pool bed: the admin's manual assignment, the conference-wide
  run and the coordinators' portal all hold to it. The admin's conference-wide run fills each location's
  beds with its own people and the pool beds with the people of no location (or of a location without
  beds), and then — last, so it never takes a bed from them — places the people a location's own beds
  could not hold in the pool beds still free («2 en camas del pool» on that location's line of the run
  report). That last step is the administration's: it applies the administration's rules only and fills
  pool beds only, never a bed of the location's own. A submitted or validated location is still left as
  it is; the coordinator's own run never uses a pool bed, and the coordinator can neither empty nor move
  the people the administration put on pool beds of a room the location shares. A location's own rules
  only ever judge its own people (in a shared room they never read another location's attendees), and the
  run reports each unmet companion rule once, on the final rooms. The portal shows a shared room as
  «Compartida · tuyas 2 de 4 camas», with only its
  own beds and people, and never fills a pool bed. Hotel cards, room tiles and the lodging explorer show
  each location's beds (taken / given) and the pool's; the explorer refuses a drop that has no bed for the
  person's location. Every bed to one location is its whole room; allotting a shared room whole, resizing
  it (never below the beds given), deleting it, its hotel or a sharing location keep the split consistent,
  and a split that changes a submitted or validated arrangement is recorded as an administration adjustment.
- **Per-site media storage quotas (multisite).** **Admin → Network** shows how much media each site stores
  and takes a quota per site and a network default (`GET /network/quotas`, `PUT /network/quotas/default`,
  `PUT /network/sites/:id/quota`). An upload or a WXR import download over a site's quota answers
  `413 rest_upload_quota_exceeded`. No quota is set by default, and the main site never has one — see
  [multisite.md](documentation/multisite.md#media-storage-quotas).
- **Theme permissions.** A theme's `functions.js` can now be granted permissions the plugin way: the
  theme declares them in `theme.json` (`permissions`), and **Admin → Themes** asks the administrator on
  activation, with each permission's reason, risk and a switch, and offers a **Permissions** button later
  (`GET`/`PUT /api/v1/themes/:slug/permissions`). Nothing is granted implicitly; a theme that declares
  nothing keeps running with no permission, as before — see
  [themes.md](documentation/themes.md#theme-permissions-functionsjs).
- **Widget settings.** Each widget instance in **Appearance → Widgets** now has a settings form drawn from
  the fields its widget declares (`registerWidget(id, name, { fields })`); only those fields are stored,
  coerced and bounded (`GET`/`PUT /api/v1/widgets/:widgetId/instances/:instanceId`).
- **Sandboxed plugins register widgets and GraphQL fields.** `wordjs.widgets.register` adds a sidebar widget
  whose renderer runs in the plugin's sandbox (output sanitized, 2 s cap), and `wordjs.graphql.extend` adds
  GraphQL types and `Query` fields, each resolved by one of the plugin's own GET routes called as the
  GraphQL caller, so the route's authorization applies — see
  [plugins.md](documentation/plugins.md#102-widgets-api) and
  [graphql.md](documentation/graphql.md#extending-the-schema).
- **`npm run media` takes `--site <id>` and `--all-sites`** on a network of sites, and **Settings → Media
  storage** lists each site's library state.
- **Multisite on Postgres and MySQL, and on several nodes.** A network of sites now runs on the `postgres`
  driver (each site is a schema of the database, `wordjs_site_<id>`) and on `mysql`/`mariadb` (each site is
  a database, `<db.name>_site_<id>`), with the network store on the same server, so a network runs on
  several backend nodes over shared Postgres/MySQL and Redis: the registry, per-site cache invalidation,
  cron leases and plugin workers follow every node. Settings → Database migration moves a whole network
  (every site and the network store) to another engine.
- **A TLS certificate per site (SNI).** Admin → Network gets a certificate for each site's address from
  Let's Encrypt (HTTP-01, automatic with ACME on) or installs one you bring; the gateway and the monolith
  select it by SNI. HTTP-01 answers are shared by every backend node.
- **Per-site backups and co-editing.** Every site of a network has its own Settings → Backups (its
  database, uploads and private files) and real-time collaboration in its editor.
- **Deleting a site** (`DELETE /network/sites/:id`, Admin → Network): a suspended site and everything it
  holds are removed; its id is never reused. See the upgrade notes in
  [multisite.md](documentation/multisite.md#upgrading-from-27).
- **Every site of a network has its own document.** Another site's pages, its sign-in, registration and
  password screens and its admin now carry that site's `<html lang>` and text direction, the `@font-face`
  rules of its own uploaded fonts and its own name in every title; before, all three came from the main
  site. The frontend has a root layout per tree instead of a single `app/layout.tsx`
  (`app/_root/RootDocument.tsx`), so moving between the public site, the admin and the sign-in screens is
  a full page load. The main site and single-site installs render the same document as before. See
  [frontend.md](documentation/frontend.md).

### ⚠️ Upgrade note — mail-server 3.1.1 with this release

The "Professional mail account" grant is no longer a core concept: mail-server **3.1.1** declares it as its
account capability `mail_server_mailbox`, and schema migration `0019` moves every existing
`professional_mailbox` value to it unchanged at boot. Update the plugin together with the core. A 3.0.x copy
still installed keeps working — its mailboxes, menu, address lock and its own user-form toggle are bridged
onto the migrated grant, behind the same `edit_users` gate — until it is updated; the bridge
(`core/legacy-account-flags.ts`) goes away in the next major.

### ⚠️ Upgrade note — Node.js 22 or newer is required

WordJS now requires **Node.js 22 or newer** (Node 22 LTS or 24 LTS recommended). Node 20 reached end of
life in April 2026, and graphql 17 (the GraphQL endpoint) and several native modules declare Node 22.
Every `package.json` declares `engines.node >= 22.0.0`, and `npm start`, the monolith, the gateway, the
backend, `npm run setup` and `create-wordjs` all stop with a clear message on an older Node. **Before
upgrading** a site that runs Node 20, install Node 22 (`node --version` must print v22 or later), then
reinstall dependencies (`npm run install:all`, or the release bundle's `npm run release:install`) so the
native modules are rebuilt for it. The Docker image and Helm chart already run Node 22, so nothing
changes there.

### ⚠️ Upgrade note — database TLS is now verified

Sites with `dbSsl: true` on a **managed database whose CA is not in Node.js's trust store** — Amazon RDS /
Aurora, DigitalOcean Managed Databases, Azure Database for PostgreSQL / MySQL and any private CA — stop at
boot after this upgrade until the CA is configured. **Before upgrading**, download your provider's CA
bundle and set it, e.g. for RDS:

```json
{ "dbSsl": true, "dbSslCa": "./certs/rds-global-bundle.pem" }
```

(`https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`; Docker/Helm: `WORDJS_DB_SSL_CA`).
Per-provider downloads and the last-resort opt-out are in
[database.md — Upgrade note](documentation/database.md#upgrade-note-database-tls-is-verified-by-default);
the boot error links there too.

### Changed

- **Settings ▸ Motions: the interaction presets screen is a motion library.** It explains what a preset is and how to
  use one in three steps; shows the site's motions as cards with a live preview (the real compiler, played on a sample
  card), a plain-language description («appears sliding up when it scrolls into view, its items one after another») and
  the pages that use each, with links; offers templates and the included motions as starting points; and edits a motion
  in a simple mode (effect, when, speed, delay, this block or its items one by one) with a preview that replays on every
  change, the full step and timeline editor behind *Advanced*. Deleting a motion in use names the pages it leaves still.
  Previews respect *reduce motion*. In Verso, the block's Motion panel opens with the same «Choose a motion» picker. The
  presets, their storage and how pages compile them are unchanged.
- **The admin works on a phone and a tablet.** Every core list (posts, pages, media, comments, users,
  categories, tags, audit log, form submissions, API tokens, backups, site addresses) renders through one
  responsive table: labelled cards on a phone, columns that wait for room on a tablet, row actions that never
  hide behind hover on a touch screen and a keyboard-accessible *More actions* menu. The sidebar is a drawer
  below 1024 px, so a tablet gets the whole width; core screens have 44 px touch targets, phone-sized gutters
  and readable 11 px labels; dialogs fit the viewport. Labels are tied to their fields, icon-only buttons are
  named, and the media library and two sidebar entries that were Spanish-only are translated.
- **The Footer settings page was retired.** `/admin/footer` redirects to the footer in the header &
  footer editor. Its settings are converted into the site footer composition by
  `POST /api/v1/chrome/migrate-legacy` (the editor's *Convert* button): losslessly (the old options are
  kept, so *Restore* brings the built-in footer back) and idempotently (it never overwrites an existing
  composition). A site whose theme ships `chrome/footer.json` is not converted — that file is what
  renders there — and the editor offers the old footer text as blocks to insert instead. The social
  profiles moved to the editor's *Social profiles* panel. New read-only route:
  `GET /api/v1/chrome/:part/legacy`.
- **The core no longer knows about mailboxes.** `user_meta.professional_mailbox`, `User.hasProfessionalMailbox`,
  the `professionalMailbox` field of `POST /users` / `PUT /users/:id`, the `hasProfessionalMailbox`
  projection and the `requiresProfessionalMailbox` menu flag are replaced by the generic account
  capabilities above; the user API now takes and returns `accountCapabilities`. `core/mailbox.ts` became
  `core/email-address.ts` (the address-shape rule and the self-service email-write rule — reserved site
  email domain, `locksEmail`); the error codes are unchanged. The deprecated fields are still served to a
  mail-server older than 3.1.1 (`core/legacy-account-flags.ts`) and will be removed in the next major.
- **mail-server 3.1.1: the mailbox grant is a declared account capability.** The plugin declares
  `mail_server_mailbox` (`locksEmail`, on by default for new accounts), gates its routes, delivery and menu
  on `accountCapabilities`, and its user-form extension now only keeps a mailbox holder's address on
  `<username>@<mail domain>` — the toggle itself is rendered by the core.
- **conference-manager 2.30.0: the conference portal is the plugin's own page.** The coordinators' portal
  (`/portal/conference`), «Mi inscripción» (`/portal/conference/yo`) and the badge links
  (`/portal/conference/badge`) were pages of the core (`frontend/src/app/portal/conference`); they are now the
  plugin's portal page (`client/portal`, declared in `frontend.portalPage`), so they follow the plugin's
  version and leave with it. The addresses people were given do not change. A badge PDF now opens at
  `/portal/conference/file?d=…` (its tickets last two minutes, so no link in use breaks), and «Mi inscripción»'s
  service worker is `/portal/conference/sw.js`: a phone that turned the bus notices on moves to it on its next
  visit and keeps them on. A core from this release with a conference-manager older than 2.30.0 has no
  conference portal until the plugin is updated.
- **conference-manager 2.22.0: the registration code is a QR Code instead of a Code 128 barcode.** The site owner
  asked for a QR. The badge (its PDF, the designer's preview and the credential page), the code viewer of a
  person, its print and SVG download, and the optional image column of the custom Excel now carry a QR
  (version 1, error correction H — it still holds the 10-character code) drawn by the plugin's own encoder,
  one copy on the server (`server/badge-qr.js`) and one in the browser (`client/lib/qr.ts`), kept equal by a
  test that also decodes what they draw. The landscape badge gives the QR a column on the right (about
  19 mm) and the name and the fields the rest; the portrait one puts it at the left of the bottom strip with
  the code beside it. «Mostrar para escanear» on the credential page shows the QR large. The meal scanner
  reads QR everywhere: on Android through `BarcodeDetector` (it is now used only when it reads QR), and on an
  iPhone, whose Safari has none, through jsQR 1.4.0 (Apache-2.0, vendored unchanged in
  `client/lib/vendor/`, see THIRD-PARTY-NOTICES.md) on a square around the aiming frame, before the built-in
  barcode reader — so the Code 128 badges printed before keep working. The server's Code 128 encoder is
  removed.
- **conference-manager 2.21.0: «Sugerir reparto» when the beds do not reach everyone, and from every lodging page.** The
  site owner, with 1000 registrants and 40 beds, saw 0 rooms for every location: a hard «mantener juntos» rule by
  gender made every gender one group bigger than any room, and the plan gave nothing; once that was fixed, it gave
  every bed to the biggest location. When the free beds do not reach everyone they now go **location by location, in
  order** («en orden por localidad»): the Localidades order, or the one set with the arrows in the sheet (POST
  `/assignment/location-order`, Hospedaje › gestionar). First each location in turn takes only the rooms it fills,
  then whatever is still free goes in order again, so no bed stays empty while someone could use it; the score
  puts the earlier locations' people before rooms and empty beds. A hard «mantener juntos» group bigger than every
  room is split into the fewest pieces a room holds (a family of 5 and rooms of 4: 4 + 1), and the sheet explains a
  rule misused on a whole gender apart from a family that simply does not fit. «Sugerir reparto»
  also opens from Asignación and Localidades. And it can be used again: **«Rehacer todo el reparto»** thinks the draft
  locations' whole arrangement again, as if nobody had a bed (e.g. after a rule changed); applying it says how many
  people change rooms and moves them; submitted or validated locations are not touched (before, a second suggestion
  had nothing to do: nobody with a bed is ever moved). Every location is listed — one with everyone in a bed as
  such, with the hard rules its arrangement breaks today and a one-click «Rehacer todo» — and the order keeps every
  location's place (it used to drop one that had nothing left to wait for).
- **conference-manager 2.21.0: a preferred mixed family gives way when beds are short; plans show what they can
  prove.** With a mixed family's room its own, families of 2 or 3 in rooms of 4 to 6 left beds empty while people had
  none. When someone would otherwise be left without a bed, a family under a preferred «mantener juntos» is divided by
  the «separar por» values (its men together, its women together) — first only the families no room fits exactly,
  then the rest — and only when that beds more people; with beds enough, families stay together. «Sugerir reparto»
  says how many families it divided, and the bounds no allotment can beat (no more people with a bed than beds; no
  fewer rooms than the biggest rooms holding them): «Demostrado» when the suggestion reaches them, the gap otherwise.
- **conference-manager 2.21.0: a room «Sugerir reparto» shares keeps the gender the plan gave it.** The site owner:
  when the engine shares a room between two locations, the gender it gave that room must stay. «Aplicar» now writes on
  each shared room the value its people have for every hard «separar por» field (`rooms.share_lock`), and every bed of
  it keeps that value from then on — even while the room is empty: the automatic assignment (each location's, the
  pool's and the overflow), the planner, a coordinator's placement and the admin's never put anyone with another value
  there (`409` by hand, with the reason). The admin sees «Solo hombres» / «Solo mujeres» on the room and in the plan,
  the coordinator on the shared-room badge; the pickers and drag & drop leave such people out. The class goes with the
  share, binds only while a hard «separar por» on that field is enabled, and the admin frees it in «Repartir camas»
  («Liberarla»).
- **conference-manager 2.21.0: the administration can block a room or fix a person in their room.** The site
  owner: the admin must be able to block someone in a room, or a whole room, so that the next suggestion leaves
  them out; only the admin changes them by hand. «Bloquear habitación» (in the room's view) and «Fijar en esta
  habitación» (on each occupant) hold until lifted: no «Sugerir reparto» (not even «Rehacer todo»), automatic
  assignment (the admin's, a coordinator's, the overflow), «Dar camas» or reset places anyone in a blocked room or
  takes anyone out of it, nor moves a fixed person. Coordinators see «Bloqueada por la administración» / «Fijada por
  la administración» and can change neither (409), nor can an edit by someone without «Hospedaje» free such a bed;
  the admin still can, by hand. A fix holds only in its room: whatever takes the person out of it (the admin by
  hand, a cancellation, a change of location, the room, hotel or location deleted) ends it, so no later placement
  inherits it; deleting a location leaves its blocked rooms and fixed people where they are. The suggestion says how
  many rooms and people it leaves as they are (within the hotel chosen).
- **conference-manager 2.21.0: «Sugerir reparto» never suggests something worse than today.** The site owner, on a
  suggestion for one hotel that used 180 rooms and left 5 beds empty where the arrangement already applied used 179
  with none: review it. Today's arrangement (everything left as it is, the automatic assignment for whoever waits)
  is now scored like every arrangement the plan tries and replaces an answer it beats — families together or
  divided, each on its own terms — or ties with one that would move someone who has a bed or change nothing (an
  answer that moves nobody and only gives empty rooms back keeps its tie; fewer preferences broken still counts).
  When nothing beats it the sheet says «Lo mejor es dejarlo como está» — or, with people waiting, that no room needs
  to change and applying beds them through the automatic assignment, with a confirmation of its own — and an answer
  that is today's says so on its card. Only as an allotment at least as good as the answer it replaces: of the
  people whose beds the plan decides, no more outside their location's rooms (not before the rooms are given out).
  On the testbed data: thought again for each hotel, the divided answer is now today's arrangement (179 rooms, none
  empty; it was 180 with 5 empty for one hotel), two hotels with nothing to gain no longer move anyone, and an
  answer applied and thought again moves nobody (it moved 62).
- **conference-manager 2.21.0: «Sugerir reparto» answers both ways, families together and families divided.** The
  site owner: dividing the families must be an option; calculate both, tell the admin how many rooms each uses and,
  when the families are divided, how many were. With beds enough, every suggestion now computes two answers, each
  the best of every arrangement the plan tries: «Familias juntas» (the fewest families divided without leaving
  anyone without a bed, then the fewest rooms) and «Dividiendo familias» (the fewest rooms, preferred mixed families
  going as their men and their women, then the fewest families divided). Both search how many families can stay
  whole, those a free room fits exactly first; the search is shorter for big events (by size, so «Aplicar» re-plans
  the same answer). The sheet shows both side by side (rooms used, rooms left free and their beds, empty beds in the
  rooms used, people without a bed, families divided, rooms saved) and the admin picks the one planned and applied
  (`divide_families`). The room numbers count the rooms the plan may fill (the hotel chosen; not a blocked room nor
  one of a location with nobody waiting), free or used, and as used any other room holding the people it places; two
  answers that bed the same people leave the same number of beds over — the owner: shouldn't the same beds be left
  empty, with only the number of empty rooms changing? — so the sheet says so when the two answers place them
  differently: how many stay empty inside the rooms used and how many in whole free rooms. The comparison with today
  counts the same way. A family (one per location, of a rule whose groups can be divided) counts as divided
  when its people sleep in more than one room. With beds short there is no second answer: every free room is used
  and families already give way only to bed more people. On the testbed data: together 190 rooms, 46 empty beds, 37 families divided (the most families
  whole possible, 52); divided 179 rooms and 11 free (the same 46 beds), 66 families divided (the fewest rooms
  possible, and the fewest families for them).
- **conference-manager 2.21.0: Alojamiento lists the hotels; their rooms show once a hotel is entered.** The site
  owner: the rooms should not fill the lodging page. Each hotel shows its summary (rooms, beds, taken, free, how full,
  the locations with rooms there) and «Ver habitaciones»; inside, its rooms and the tools that act on them (allot to a
  location, give beds, select rooms), with «Todos los hoteles» back.
- **conference-manager 2.21.0: a family's mixed room is the family's alone.** The site owner: when a family is
  placed in a mixed room, nobody outside the family may be added to it. A hard «separar por» used to judge a room
  without the members an outranking «mantener juntos» explained, comparing only the others among themselves — a
  woman from outside could join a room with a family's men, a man a women-only family's room. Now two people with
  different values share a room only when they are of the same family, everywhere the rule is judged (the automatic
  assignment, «Sugerir reparto», the reviews and the portal); a single-gender family's room may still be completed
  by people of that gender. A mixed family no room takes whole is divided along the «separar por» values instead of
  in arbitrary pieces.
- **conference-manager 2.21.0: assignment rule priorities explained, and never shared.** The site owner could not
  tell whether a higher or a lower number goes first: the rule form and the coordinator's portal now say the
  HIGHEST number applies first (a rule of 90 prevails over one of 10), and each rule shows its place (1.ª, 2.ª…), the
  administrator's and the location's together. Two rules that apply together may not share a number (409 naming the
  rule that has it; the forms say so as it is typed): a conference rule's number is no other rule's of the
  conference, a location's rule's no conference rule's and no other of that location's — a rule saved again with
  its own number is never refused for an older tie. A new rule takes a free number below the others. Number boxes
  that snapped an emptied value back to 1 or 0 (a group's minimum size, «al menos», priorities, a room's or hotel's
  capacity, the bulk room range, the base fee) stay empty while typing.
- **conference-manager 2.21.0: lodging dates — a general opening and closing, and a location's own dates.** The
  site owner: the coordinators may not arrange their lodging right away («hay una fecha para todos donde se les
  habilita»), and the closing should be one for everyone «a menos que se configure una específica para una
  localidad». Localidades › «Fechas para acomodar hospedajes» now has an **opening** beside the **closing**:
  before the opening and after the closing every portal lodging write answers 403 and the coordinator's
  Hospedaje tab is read-only with «Los hospedajes se habilitan el …» / the closing it had; the administration
  arranges whenever it likes. Each location card shows its window («Se habilita el …», «Abierto hasta el …»,
  «Cerrado») and may take **dates of its own** that replace the general ones — its own opening (a date, or no
  wait) and its own closing (a date, earlier or later, or none) — or go back to the general ones. The former
  «Permiso fuera de plazo» became such a closing (moved once, on upgrade: the later of the general deadline and
  its date; without a date, no closing), and the old `lodging_permission` fields still set it. A bare date is
  a whole day in the zone of the admin who saved the dates (`lodging_tz`; UTC until they are saved again), so a
  closing day ends at midnight there, not at 19:00. A window that could never open is refused. GET
  /portal/lodging adds `opens` and `not_yet_open`; `deadline` / `deadline_passed` are the closing that applies
  to that location.
- **conference-manager 2.20.0: the automatic assignment uses the fewest rooms, and «Sugerir reparto».** The
  site owner: allotting rooms to locations by head count left arrangements the automatic assignment could not
  fill without breaking a rule, and the engine had to use «la menor cantidad de habitaciones» and leave «la
  menor cantidad de camas vacías». The engine now packs: the hard «separar por» rules split people into classes
  that never share a room, and each class takes the fewest rooms, then the fewest spare beds (an exact choice of
  rooms, then Best Fit Decreasing, then an exact search for a few groups), filling rooms that already hold people
  first; a child travels with the adult a companion rule asks for; a preference (a soft rule) is kept when that
  costs nothing and gives way when keeping it would cost a room or beds, and the run reports it. Each run tries
  that packing and the 2.19 placement — per location and for the whole conference — and keeps the best: fewer
  hard rules broken, then fewer people without a bed, then fewer rooms, then fewer empty beds. Hospedajes gets **«Sugerir
  reparto»**: which free rooms — or beds of a shared room, or free beds next to people already placed, only where
  that saves a room — to give each location, and who sleeps where; it is shown next to what the current
  allotment and the automatic assignment would give today, and «Aplicar» gives the rooms, places the people
  exactly so (nobody who has a bed is moved) and runs the automatic assignment for whoever is left — only while it
  is still the same plan and never when it would be worse than today. Options: redo the empty allotments of locations with people waiting, share rooms, one hotel.
  Submitted or validated locations are never touched. `/assignment/simulate` shows what a run would do (every
  bed it would change) without writing anything.
- **conference-manager 2.19.0: «Escarapelas», each registrant's digital badge, with a PDF to print.** A new
  «Escarapelas» tab designs one badge per conference: landscape or portrait ID-card size (CR80, 85.6 × 54 mm),
  a title, colours, a background image, a logo, a legibility panel behind the text and the fields to show (with
  their own labels, in their order; contact fields carry a warning). The name and the registration code — the
  very Code 128 bars the meal scanner reads — are always on it. Each registrant gets a private link (a 128-bit
  token in the URL fragment) to a credential page that shows the badge, a «Mostrar para escanear» mode with the
  bars large and the screen kept on, the PDF and sharing; the link stops working while the inscription is
  cancelled (and comes back when it is reactivated), after the expiry date the administration picks, or with
  badges turned off, and «Regenerar enlace» / «Anular enlace» replace or remove it. The admin's person sheet
  gets «Escarapela» (open, copy, share, WhatsApp to the person's phone, PDF); the tab has two views, «Personas»
  (every active registrant, found by name, code or location, each with view / copy / WhatsApp) and «Diseño»,
  and bulk tools per location (copy every link with its name, the links in Excel, a PDF to print on Letter
  sheets with cut guides, or one per page); the coordinators' portal offers the same for its own location's
  people (and re-reads the conference's switches when the coordinator comes back to it) while the
  conference lets coordinators share badges. The PDF is generated by the plugin with no dependency (standard
  fonts, vector bars, the background embedded once), and the page, the admin and the PDF draw one display list
  the server computes, so they match. A new team permission «Escarapelas» (view: see and share, with
  Inscripciones › ver since a badge carries the meal code; manage: the design and revoking links); existing
  roles get none.

- **conference-manager 2.18.0: «Inscripciones» no longer opens with the payments section alone.** A team
  role needs Inscripciones › ver to see the roster; a role with Pagos and without Inscripciones gets the
  «Pagos de cuotas» tab instead (Pagos › ver to look, Pagos › gestionar to register and review). The server
  enforces it too: `GET /inscriptions` and `GET /inscriptions/:id` answer `403` to a payments-only role (it
  could read every attendee's contacts and form answers through the API), and «Pagos de cuotas» learns who
  each person is from its own `GET /fee-payments` (`people[]`: name, location, family group, status; the
  registration code only with Inscripciones › ver) — for such a role its person sheet shows the payment and
  nothing of the form, and the conference cards count the people of «Pagos de cuotas». The payment screens moved there: the
  admin's per-person «Pagos de …» modal, its receipt lightbox and the roster's hover-only row actions are
  gone (every action is in the person sheet), and the portal's three totals cards, its «Registrar Pago
  (N)» button, the row checkboxes and the «Registrar Pago Grupal» dialog are replaced by its «Pagos de
  cuotas» tab. The payment state reads Pagado / Abono / Sin pagar everywhere in the admin (the roster, the
  Excel export filter and file, «Reportes»), as in the portal («Parcial» and «Pendiente» before).
  `GET /inscriptions/:id/payments` no longer carries the receipt images (`has_proof`; `?with_proof=1` or
  `GET /fee-payments/:id/proof` return them). The pre-2.18 payment routes still work on one-person
  payments: `POST /inscriptions/:id/payments` records a pending payment, now with the same cap and with the
  receipt optional for cash, and `POST /payments/:id/validate | reject` and `DELETE /payments/:id` answer
  `409 shared` for a payment of several people, and `409 stale` when the payment changed between their
  check and their action. After a downgrade below 2.18.0 the balances stay right, but
  receipts of new payments are not visible in the old screens, and reviews made while downgraded are
  overwritten by the payment on the next upgrade.
- **conference-manager 2.17.0: the administration can change a lodging arrangement that a location submitted,
  or that it validated, without reopening it.** Until now a submitted or validated arrangement was read-only for
  everyone, and every admin change answered 409 «reábrelo antes de …». The coordinator's portal still cannot
  change it (409, as before). The admin side now can: placing, moving and freeing its attendees in
  Asignación (drag and drop and both pickers) and in Inscripciones (the room dialog), allotting rooms to it or
  taking them away, resizing or deleting its rooms, and deleting a hotel that holds them. Attendees follow
  one rule in both directions: only someone who holds a bed is part of an arrangement. Moving one of its
  attendees who holds a bed to another location, or moving an attendee into it with the bed they keep (a
  pool bed), also needs Hospedaje › gestionar; a role that may only manage inscriptions gets 409, while its
  cancellations and deletions still free the bed as before. That refusal, and the form's hint before it, say
  when it becomes possible through that door: once a validated location is reopened, or once a submitted one
  is returned to its coordinator (a submitted one cannot be reopened). An attendee without a bed enters and leaves
  alike, with Inscripciones › gestionar alone, and that is never an adjustment (nor is cancelling, deleting
  or registering them). The status does not change (a validated arrangement stays validated) and the review stamps
  stay. Each change to who sleeps where, or to the location's rooms and beds, is recorded on the location:
  when, who and how many changes since the coordinator's last submission. That includes deleting a pool
  room or a hotel where one of its attendees sleeps. The record is written under the same lock as every status
  transition and only while the location is still submitted or validated, so a coordinator submitting or
  withdrawing at the same time never leaves a record that disagrees with the change. The inscription and
  room edits decide on the rows as they are under that lock. Inscription edits and deletions that touch no bed
  no longer wait for it, so a long automatic assignment does not hold them up. Validating keeps the record and
  the coordinator's next submission clears it. «Validar» and «Devolver» send what the admin was looking at:
  if the arrangement changed after the review was opened (an adjustment by someone else, or a new
  submission), they answer 409 `lodging_changed` and the review reloads. The admin sees the record on the
  location card (below its row, in two lines: «Ajustado · N cambios» and when / by whom, the whole sentence in
  its tooltip) and in the lodging review, which also offers
  «Ajustar en Asignación». The explorer, the pickers and the room dialog mark such a location instead of
  locking it, once per location, saying its actual state («ya está validado» / «está enviado a
  validación»); so do the hotels when the location filter points at it. «Sin asignar» shows the state as a
  visible label. Confirmations name the reviewed arrangements a deletion or re-allotment changes, including
  those of the rooms' occupants, and the change's own toast says when it was recorded (`lodging_adjusted` in
  the responses). The coordinator's portal shows «Ajustado por la administración el …» without naming the
  admin, and its «Enviar a validación» confirmation says the administration may adjust the arrangement.
  «Reabrir» is unchanged. The conference-wide automatic assignment and reset still skip these locations, and
  their report now points to «Acomodación». The run's report also counts the attendees it left without a bed
  in those locations (`skipped_unassigned`), so its «Pendientes» match the explorer's «sin asignar» and say
  how many were not touched. Three columns are added on boot (`lodging_admin_changed_at`,
  `lodging_admin_changed_by`, `lodging_admin_changes`), and every path keeps working while they are missing.
- **Certificates no longer depend on node-forge or acme-client.** The cluster CA, the service identities
  made by `npm run setup` and the installer, and enrolment CSR signing now use a small X.509 toolkit on
  Node's own `crypto` (`gateway/src/x509.js`, `setup/x509.js`, `backend/src/core/x509.js`), and Let's
  Encrypt issuance uses a built-in RFC 8555 client (`backend/src/core/acme-client.ts`). Nothing to do on
  upgrade: cluster CAs, keys, identities and ACME account keys made by earlier releases keep working
  and keep signing (covered by tests on PEMs produced by v2.7.0). node-forge is no longer installed.
- **The two-step DNS-01 flow finishes from the server's own record.** Step 1 stores the order it opened
  (`backend/data/ssl/pending-dns-01.json`, owner-only), and step 2 acts on that copy. The URLs the
  browser sends back are no longer used, and the ACME client only ever requests URLs on its CA's origin.
  A request started before the upgrade has to be started again.
- **graphql 17.** The GraphQL endpoint runs on graphql-js 17; its depth and cost limits are unchanged, and
  graphql 17's experimental fragment arguments stay disabled (the cost walk measures each fragment once).
- Dependency updates: next 16.4.2, react 19.3.1, @anthropic-ai/sdk 0.135, @modelcontextprotocol/sdk 1.32,
  zod 4.6, nodemailer 10.1, smtp-server 3.20, mailparser 3.10, mysql2 3.24.6, sql.js 1.15,
  sanitize-html 2.18.1, dotenv 18.0.8, express-rate-limit 8.7.1, puppeteer-core 25.14 and patch updates.
- file-type 22 (upload MIME detection; its single entry replaces the `file-type/core` subpath). The unused
  `dnsbl` dependency is removed: the mail-server plugin has done its own DNSBL lookups for a while.
- **Password-reset and verification email has its own transport.** WordJS now sends these links itself
  through an SMTP relay you configure in **Settings → Account email** (host, port, TLS mode, credentials,
  test message). A mail provider plugin carries them only if an administrator allows that plugin by name
  there, with the warning that it can then take over any account. **Upgrading:** a site whose provider
  plugin held `email:provider` keeps that plugin allowed (migration `0018`), so recovery keeps working;
  Settings shows a banner until you configure the built-in transport or confirm the plugin. A new site
  needs the built-in transport (or an explicit allowance) before "Forgot password?" is offered.
- **Old author URLs from before the public-identity change are opt-in.** The author slugs that used to be
  derived from sign-in names resolve on the archive, `?author=` and the author feed only when
  **Settings → Keep old author URLs working** is on (off by default, with a warning); otherwise they are
  answered like any unknown slug.

- **Database TLS verifies the server certificate.** With `dbSsl: true`, Postgres and MySQL connections
  (including the per-plugin MySQL pools and the installer's connection test) now check the server
  certificate chain and host name instead of accepting any certificate. New settings: `dbSslCa` (the CA
  that signed the server certificate, as a PEM file path or PEM text) and `dbSslRejectUnauthorized: false`
  as an explicit, logged opt-out. A site whose database presents a certificate Node cannot verify stops at
  boot with a message explaining both options — see [database.md](documentation/database.md). The install
  wizard and **Admin → Database migration** offer both settings when *Use SSL* is ticked (the opt-out with
  a warning), and the Docker/Helm entrypoint reads `WORDJS_DB_SSL`, `WORDJS_DB_SSL_CA` and
  `WORDJS_DB_SSL_REJECT_UNAUTHORIZED`.

### Removed

- **No plugin ships with the core any more.** A fresh install listed two plugins nobody installed: the
  *Hello World* sample and *Test Schema*, a test fixture that created a table when activated. `backend/plugins/`
  now ships empty — in a checkout, the release bundle and the Docker image — and the packager drops anything
  committed under it. *Hello World* moved to `documentation/examples/plugins/hello-world/` (copy it into
  `backend/plugins/`, or call `POST /api/v1/plugins/sample`); tests write the plugins they need. An existing
  site keeps whichever of the two it already has on disk; delete the folder to remove it.

- **`backend/src/models/Email.ts`** — an unused copy of the mail plugin's store (the plugin has its own in
  `lib/email-store.js`), together with the `uploads/mail-attachments` directory it created at load and the
  `backend/cli/debug-inbox.js` script that used it.

### Fixed

- **Security Center: the protocol confirmation and the save notices in the admin's language.** After saving the HTTPS switch or the port, the notice (saved, the main address now, plain HTTP now, review the suggested address) was English-only. Both it and the protocol confirmation said "the gateway" even on a single-process (monolith) install, which has no gateway. They are now translated, and on a monolith the confirmation says "the server" and the notices name WordJS.

- **Sign-in and account screens speak the admin's language, from the first paint.**
  - **Language decided on the server.** The admin's language was kept only in the browser, so the server rendered every sign-in screen in Spanish and it switched after loading. A fresh browser also started in Spanish on an English site. The choice now travels in a cookie too: `/login`, `/register`, `/reset-password`, `/verify-email` (also on network sites) and the admin render in it from the server. With no choice stored, the site's language decides, and `<html lang>` follows the screen.
  - **Screens no longer English- or Spanish-only.** `/reset-password` was English-only, while `/register` and `/verify-email` were Spanish-only. The same applies to the two-factor gate and an administrator's two-factor reset.
  - **Translated server errors.** Errors from the server ("Invalid username or password.", the sign-in lockout with its minutes, a wrong 2FA code, an expired reset link…) are shown in the admin's language, keyed on their stable code.
  - **Fixed in passing.** The reset confirmation now says what happens when the user's role requires two-factor authentication. The final reset screen no longer offers two links to sign-in.
- **Account screens at tablet width (1024px).**
  - **My account.** The two-factor status pill no longer pushes out of its card, which had caused horizontal scroll. The manual key and the 6-digit code box no longer collapse to a narrow strip.
  - **API tokens and Account mail.** The two pages keep their form full width until there is room for the side column, and the SMTP port field fits five digits.

- **"Also delete this plugin's data" leaves nothing of the plugin behind.** Beyond its tables it now deletes the
  options the plugin created (recorded when the plugin first writes them; a site setting it merely changed is
  never touched), revokes the account capabilities it declared from every account, and removes its private
  storage folders — a reinstall no longer inherits the configuration the administrator asked to erase.
- **No more "tried to READ outside safe zones" for plugins every few seconds.** While serving a plugin's call
  (for example resolving which accounts hold its capabilities) the server listed the installed plugins under
  that plugin's sandbox rules; the read was refused, logged on every pass and came back empty. It now runs as
  the server's own read.

- **`localhost` is only local from this machine.** A client on another machine that connected directly with
  `Host: localhost`, `127.0.0.1` or `[::1]` was treated like a request from the server itself. Such a request is
  now refused with `421`, at the gateway and in the monolith; a browser or a proxy on the server is unaffected.

- **Site address no longer says signing in over an IP is impossible when the main address is an IP.** The
  note now says the main address is the exception, which is how sign-in already worked.

- **A second monolith on other ports keeps them after install.** Started with `PORT` and `WORDJS_LOOPBACK_PORT`
  (another install beside one already running), the wizard recorded the default ports 3000 and 4000, so after a
  restart its pages could read the data of the install listening on :4000. It now records the ports it runs on.

- **Public pages and the editor no longer request block bundles that do not exist.** Every active plugin was
  asked for its editor-block bundle, so each plugin without blocks (analytics, cookie consent, lightbox,
  announcement bar, mail server…) cost a 404 and a console error on every page view and every editor mount.
  `GET /api/v1/plugins/registry` now states `blocks` per active plugin (whether its block bundle is served),
  and the loaders ask only those; without that answer they ask every plugin, as before.

- **The admin, the editor and the bundled themes, from a three-mode QA pass.**
  - *Dark mode:* with the OS in dark mode the admin stays fully light and readable (the Security Center,
    Media storage, Network and the Dashboard chart had near-white text on white). The Verso editor's own dark
    scheme is complete: pickers, menus, accent buttons and field boxes follow it.
  - *404 and errors:* the public 404's button is visible again, and its texts, the error page and the
    public controls of the Audio, Video, Off-canvas and Back-to-top blocks follow the site's language. An
    unknown `/admin/…` address shows a not-found page inside the admin.
  - *Themes:* a static front page now uses the theme's `front-page.json` → `page-{slug}.json` → `page.json`
    instead of the blog index's `home.json`, so Gaceta and Vergel no longer squeeze the demo home page into a
    narrow card with split words. Grid, Columns and Stats also collapse to their tablet / phone layout when
    the content area itself is that narrow. The bundled themes ship English texts and a `screenshot.jpg`;
    Circuito's header button points to a page that exists; archives and search no longer list the same
    posts twice; the demo home page takes its colours from the active theme.
  - *Editor:* the "More options" menu on phones and tablets shows its icons, not their names; the canvas
    shows the site's real header and footer; the Motion panel no longer opens on every click; on a touch
    screen a block can be tapped into an empty container; colour fields get a colour picker and size fields
    their unit; a post's inspector says "Post"; internal block ids are no longer shown.
  - *Admin:* the sidebar is grouped by task (Content, Appearance, Users, Plugins, Settings, Advanced);
    screens that were still partly in Spanish or English are translated (Import, Site Health, Widgets,
    Network, Account and more) and `<html lang>` follows the admin language; counters use singular forms;
    tables wrap between words instead of mid-word; status tabs, the header & footer selector and dialogs
    fit a phone; the mobile menu and dialogs move and keep keyboard focus and close with Escape; form
    fields are labelled.
  - *Default theme:* blocks placed outside a Section keep the site's column; a Quote's citation and an
    Audio player's title are no longer painted as dark or gradient strips.

- **Isolated plugins with their own tables start on PostgreSQL and MySQL/MariaDB servers on a private
  address, and a plugin's request can no longer take the whole process down.** While the host answered a
  plugin's database call it opened its own pool connections under that plugin's sandbox rules, so a database
  on a LAN address was refused as "plugin egress": the plugin stopped at every restart (only deactivating and
  activating it again brought it back). The host's own modules now always get the real network modules and
  the database driver runs as the host. An exception raised while the host serves a plugin is logged with the
  plugin's name and the process keeps running; any other fatal error exits cleanly with code 1 for the
  supervisor instead of aborting. A plugin card whose worker is stopped now shows why, and its *Restart*
  button starts it again (it used to answer that the plugin was not loaded).
- **Deactivating or deleting a plugin no longer uninstalls packages the core needs.** The dependency clean-up
  removed every package of the plugin that no other active plugin declared, so deactivating the last gallery
  plugin uninstalled `uuid` — which WordJS itself requires — and the next restart failed to start. It now
  removes only packages it installed for plugins, never one the server has loaded or another active plugin
  declares.
- **Database users without `GRANT OPTION`.** On MySQL/MariaDB (and PostgreSQL) a plugin activated without a
  restart was routed through its own database login even when the server refused to grant it its new tables,
  so every query failed with "access denied" until the next restart. The plugin now falls back to the SQL
  guard at once, as it already did at boot.
- **"Also delete this plugin's data" deletes every table.** Tables linked by foreign keys were dropped in
  catalog order, the first refusal stopped the rest, and the admin was told everything was gone. They are now
  dropped in dependency order; any table that something outside the plugin still references is kept and named
  in the confirmation.
- **Files uploaded to a plugin route are readable by the plugin.** The host staged multipart uploads in the OS
  temp directory, which the plugin sandbox does not let a plugin read, so attachments were lost. They are now
  staged in the plugin's own private temporary storage (still removed when the response is sent).
- **An approved private relay works over STARTTLS.** "Sandbox access → Allow host:port" was approved for the
  TCP connection but the TLS upgrade on that same connection was judged again without its port and refused.
  A TLS layer over an already-connected socket is no longer re-judged.

- **The gateway's HTTPS switch means what it says.** Every gateway worker served HTTPS as soon as a
  certificate was stored, even with HTTPS switched off, so the panel could not turn it off and showed HTTP
  while HTTPS was served. A site-address change no longer turns HTTPS on at the next restart, and installing
  a certificate stores it without switching protocols. Admin → Security shows the protocol the gateway
  actually serves, no longer generates a certificate (and switches the gateway to HTTPS) just by being
  opened, asks before changing the protocol, and offers a self-signed certificate as an explicit button.
  Switching HTTPS off on the gateway's own address moves the main address to `http://` with it, so the
  panel stays reachable.
- **Separate mode follows the panel.** A frontend node on another machine now keeps its site address, the
  gateway's protocol and port, and its server-side API address in step with the gateway on its own
  (`GET /edge-info`, every 30 s): changing the main address or the HTTPS switch no longer leaves the public
  site answering 500 until three machines are edited by hand. On one machine, the frontend restarts itself
  when the gateway next to it changes protocol or certificate.
- **The gateway keeps what the installer wrote.** Its first certificate upload or TLS change after the
  install wizard no longer erases the gateway secret, the site address and the mTLS paths from
  `gateway-config.json`, and the panel now receives the answer to a TLS change.
- **A visitor whose page cannot be served sees a page.** When the service behind a page is starting or
  down, browsers get a small "back in a moment" page (503 with `Retry-After`) instead of raw JSON; API
  clients keep the JSON body.
- **A split backend waits quietly for its certificates before install** instead of retrying `/register`
  against the gateway's public port every few seconds.
- **Address-bound refusals explain themselves.** A user save or a Servers action refused because the
  session was started at a secondary address now names the main address to sign in at; on a network site,
  Settings → Site address points to the network administrator; Network warns about an `https://` site the
  gateway serves over plain HTTP, asks before removing a network administrator, clears the action password
  after each action, and the two-factor field on the login screen is labelled for assistive technology. A
  join token's role, TTL and address are checked before the two-factor code is spent on it.
- **Content, comments and accounts: what the admin screens promised now happens.** Found by testing a site
  end to end in all three deployment modes:
  - *Media*: picking or dropping several files uploads every one of them (only the first was sent); a file
    the server refuses is listed with its reason (too large, refused type); UTF-8 file names keep their
    accents in the title, and the stored file name folds them (`ñandú` → `nandu`). The upload size limit
    is set in Settings → Media and applies on save (it was `wordjs-config.json` only); a refused upload
    names the limit, and the media screen checks a file against it before sending it.
  - *Posts and pages*: «Delete» moves an entry to the trash, and the list now has a **Trash** tab with
    **Restore** (back to the status it had) and **Delete permanently**; `POST /posts/:id/restore` is the API.
    The featured-image, logo and icon pickers list images only (they offered PDFs and videos), and the
    picker's counter follows the admin language. «Duplicate» carries categories, tags and SEO fields over, and opening the copy no longer gives it back the
    original's title and slug. The editor's Slug field shows the entry's slug, a published entry keeps its URL
    when its title changes, and an entry created or saved without a category lands in the default category.
  - *Public site*: search shows the real number of results and pages through them; the «Latest posts»
    front page pages at `/page/{n}`. OpenGraph and JSON-LD dates are ISO 8601
    (from the UTC time) and carry `article:modified_time` / `dateModified`; a site with no icon of its own
    gets a bundled one instead of a `/favicon.ico` 404 on every page; a missing optional theme template is
    logged as information, not as a warning on every render.
  - *Reusable symbols* can be saved again («Save block as symbol» always failed); a site where the symbol
    type had been registered as internal is corrected on the next save.
  - *Comments*: Approve / Unapprove appear, pending comments are highlighted, the Spam tab offers «Not spam»
    and «Delete permanently», and times are shown in the viewer's time zone. `POST /comments/:id/unapprove`
    lets an editor take an approval back. «Enable comments» and «Registered users only» now take effect on the
    public form and on `POST /comments`, and a signed-in visitor comments under their own name.
  - *Accounts*: «Sign out» ends this browser's session only; My Account → **Sessions** signs out everywhere.
    A two-factor challenge completes one sign-in only. The one-time secret window (API tokens, webhook
    secrets, backup codes) follows the admin language, and for backup codes it says to regenerate them
    rather than to «revoke and create a new one». Avatar bubbles show the first letter of a name, not a
    leading «[». A rate-limited (429) or unreachable server no longer looks like a sign-out: the admin says so and retries
    on its own. The live notification stream is shared by every tab of a browser, backs off properly when
    refused, and past the per-user cap the server answers `429` with `Retry-After`.
  - *Users and roles*: the Team and Subscribers lists page, search and filter by role on the server (they
    showed the first ten accounts); deleting a user names them and can attribute their posts and pages to
    another user (`DELETE /users/:id?reassign=`); every password the admin sets needs 8 characters; a custom
    role still held by users cannot be deleted; core roles offer no delete button; `edit_comments` can be
    granted from the Roles screen.
  - *Settings*: the sign-up default role cannot be one that runs the site, `posts_per_page` and
    `admin_email` are validated, a refused save shows the server's reason, the admin email no longer promises
    a confirmation message that does not exist, the logo and icon are stored as site-relative paths (they
    embedded the address the admin happened to use), and the dashboard counters show real totals. In a
    monolith the dashboard no longer reports «mTLS: OK / certificates valid» for a link that does not exist.
  - *Single posts* show the featured image under the title and link their categories and tags. Deleting a
    media item that is an entry's featured image says so first (`GET /media/:id/usage`) and removes the
    reference, instead of leaving the entry announcing an image that no longer exists. The sitemap submits
    the category, tag and author archives on every site (only very large, chunked sitemaps listed the
    taxonomies). Settings refuse a site language the platform does not know (`xx_YY`) and a front page
    that is not a published page. Authors and contributors see their own totals on the dashboard, and an
    uninstalled site no longer writes an error to the log on every request.
  - *Categories*: the screen shows the hierarchy (children indented under their parent) and edits a
    category's name, slug, description and parent; the API refuses a parent that does not exist, the
    category itself or one of its subcategories (`rest_term_invalid_parent`).
  - *Old WordPress addresses*: a nested page address (`/level-1/level-2/level-3`) and a nested category
    address (`/category/parent/child`) redirect to the page's or category's own address when they name its
    ancestry exactly; any other prefix is a 404 (`/anything/<page>` used to serve the page under every
    prefix). The comments screen's «In response to» opens the entry (it linked to a route that does not exist).
- **Public API: answers and documentation agree.** An `Authorization: Bearer` token that is invalid, expired
  or revoked is answered `401 rest_token_invalid` with `WWW-Authenticate` on public reads and on GraphQL (it
  silently read as a visitor, so a client whose token expired stopped seeing its drafts without being told); a
  stale session cookie still reads as a visitor. An MCP client that sends no token gets the MCP `401` with
  `WWW-Authenticate` instead of a CSRF `403`. `GET /comments` accepts `status=all`, `approved` and `hold`.
  The OpenAPI document describes `title` and `content` as the strings the API returns, documents
  `X-WP-Total` / `X-WP-TotalPages` and the 1–100 page size on `GET /posts`, marks `POST /setup/migrate` as
  deprecated, and states that the network routes answer 404 on a single-site install. The API tokens screen
  links the REST reference and the GraphQL endpoint and has the GraphQL introspection switch; AI agents
  keeps a refused «Create connection» on screen with its reason, and an agent's refused SVG upload says why.

- **PostgreSQL: a dropped database connection no longer stops WordJS.** When the server closed a pooled
  connection (a restart or failover of the database, pgbouncer or a firewall recycling idle connections,
  `pg_terminate_backend`), the pool's unhandled `'error'` event ended the whole process. The pool now
  discards the connection and opens a new one, and a read that lost its connection is retried once. The
  backend supervisor (`backend/server.js`) no longer gives up after five fast crashes: it backs off (1 s up to
  30 s) and keeps restarting. A deadlock victim is run again on MySQL (`ER_LOCK_DEADLOCK`) and Postgres
  (`40P01`) instead of failing the request, so concurrent meta writes on one post are no longer lost.
- **A cancelled request no longer stops the server.** When a client closed its connection mid-request,
  Node could report the abort (`Error: aborted`, `ECONNRESET`) as an uncaught exception, and WordJS exited:
  in development every fresh install of the monolith died right after setup (its own cache purge gave up on
  a page Next was still compiling), and a reload during a compile did the same. Every listener of the
  monolith, the backend, the frontend server and the gateway workers now gives each request a permanent
  handler for that error, and the last-resort crash handlers log a client abort instead of exiting (any other
  uncaught exception still restarts the process).
- **`npm run verify:f0` works on a multisite install.** It loaded the OpenAPI document outside any site
  and stopped with `site_context_missing`; it now loads it as site 1, as the server does at boot.
- **Switching the database engine from the panel works.** From a SQLite-native site, *Database migration*
  sent the SQLite search index (`CREATE VIRTUAL TABLE … fts5`) to the target and always failed; to
  PostgreSQL with an ordinary role it failed on `session_replication_role` ("current transaction is
  aborted"); and when a copy did finish, the restart read the flat `dbPassword` generated for the SQLite
  install instead of the new password and the site could not start. The index tables are no longer copied
  (the target builds its own search index and unique keys), generated columns are recomputed by the target,
  the foreign-key switch is tried in a savepoint, Postgres sequences are moved past the copied ids, and the
  new connection is written where the next boot reads it and opened before the restart — settings that would
  not connect are not written and the site stays on its current database. Between PostgreSQL and MySQL,
  timestamps and 64-bit values cross over, and the core's own tables are built by the target's migrations
  with their keys (a bare column copy lost them, and the first post written afterwards failed). A refused
  target answers `400` and the status reads `failed`; the progress bar no longer stays frozen during the
  restart, and the screen no longer overflows at 1024 px. A legacy → native move now builds the FTS5 index.
- **Posts over 64 K characters can be saved.** Creating one answered `500`, and a post that grew past the
  limit (or was imported that way) could no longer be edited at all ("Could not snapshot the current
  version"): the revision snapshot bounded the post's content, which it does not even store.
- **MySQL/MariaDB enforce unique emails and slugs.** The expression and partial indexes the other engines use
  do not exist there and failed with only a warning, so concurrent sign-ups or posts could create the same
  email or slug several times. Generated key columns with UNIQUE indexes (migration `0020`) hold both rules
  now; existing duplicates are listed in the log. Two posts created at once with one title get distinct
  slugs on every engine (the second used to fail with `500` on Postgres).
- **Backups of PostgreSQL and MySQL work without `pg_dump` / `mysqldump`.** Every backup failed with
  "internal error" on a host without the client tools, scheduled ones included. WordJS now writes its own
  dump of every table when the tool is missing and restores it in one transaction; the panel shows the reason
  when a backup fails, and Site Health says which kind of dump backups carry.
- **PostgreSQL search finds words in any language and ignores accents.** It used the English configuration
  for every site ("About" found nothing, "cancion" did not find "canción"); it now uses `simple` + `unaccent`
  (migration `0021`), with a prefix match on the last word like SQLite. The installer refuses a database
  that is not UTF8 (search and case rules break on `SQL_ASCII`), and Site Health warns about one.
- **Same answers on every database engine.** Dates that took a column default on PostgreSQL read
  `2026-10-21 11:19:18.683525+00` instead of `YYYY-MM-DD HH:MM:SS` (migration `0022` rewrites them); a search
  for `%` or `_` returned every post on MySQL and sqlite-legacy; the user search was case-sensitive on
  PostgreSQL; MySQL treated "Café"/"cafe" and even different emoji as the same term; an invalid post date
  (`not-a-date`, `2025-02-30`) became "now" or rolled into the next month instead of a `400`. A term with the same
  name under another parent, or with its own slug from a WordPress import, is no longer dropped as a
  duplicate. The installer's *Test connection* says which field to check, and SQLite database files are
  created owner-only.

- **WordPress import: a failed media download no longer breaks the image.** In download mode every
  `/wp-content/uploads/` URL was rewritten to this install's `/uploads/`, including the files that could
  not be downloaded, which turned working images into 404s (and a later run that did download them skipped
  the posts already imported). Attachments are now imported before the posts that embed them, a URL is
  rewritten only when its file is here (WordPress's `-WxH` sizes follow their original), and a re-run moves
  the references of posts imported earlier once their files are stored.

- **WordPress import: nothing the export carries is dropped.** A page whose address belongs to unrelated
  content of this site (the sample "About") is imported under another address instead of being discarded
  with its children re-hung on the sample page; a re-run still recognises it. Sticky posts stay sticky, and
  the front page lists them first. `[gallery]` shows the post's images instead of nothing. A
  password-protected post can be unlocked by its readers with its password, and the post and page editors
  show and change the password. In link mode the featured image and `og:image` point at the old site's
  file and an attachment without a MIME type is typed by its extension. A WordPress on a private network
  (LAN, intranet, staging) can provide its media with an explicit opt-in that covers that site only; the
  refusal no longer talks about "plugins". Imported dates use the same clock as the site's own posts.
- **Edits, searches and orderings that depended on the engine.** Two editors saving one post that has no
  live session no longer overwrite each other silently: the second save asks first. The same tag created
  twice at once is one tag on every engine, and concurrent saves no longer leave more revisions than the
  cap. On sqlite-native the LIKE search (users, and posts when the full-text index cannot answer)
  ignores case and accents in any language; title order ignores case, and accents where the engine can. `og:article:published_time` and JSON-LD
  `datePublished` are ISO 8601. Settings → General has a Time zone, and the public site prints dates in
  it. The installer explains what the legacy SQLite engine costs. In split mode, a second install on the
  same host uses its own ports before it is set up instead of the first install's.

- **Mail on MySQL/MariaDB: sending works with the default settings.** mail-server **3.2.0** stores the send time
  of the undo-send window, scheduled sends, retries and rate-limit deferrals in the one date format every
  database accepts; MariaDB refused the old one, so every message failed with "Incorrect datetime value". On
  PostgreSQL the check that lists mail from before per-account ownership no longer fails on every call.
- **Site mail is never sent from the administrator's personal address.** Notices from the core and other
  plugins, form notifications and the delivery test are sent as the configured *From email* when it is on the
  mail domain, otherwise as `noreply@<mail domain>` — no longer as the administrator's account email.
  Configuration refuses an off-domain *From email* and shows which address site mail uses.
- **Attachments are no longer dropped.** The file is copied when it is uploaded (the upload's temporary file
  is deleted as soon as that request ends) and the composer gets a token instead of a server path. A message
  whose attachment cannot be read is refused with the file's name instead of being sent without it.
- **A relay on a private address works once allowed.** With *Sandbox access → Allow host:port*, a LAN smarthost
  that offers STARTTLS stayed blocked: the TLS upgrade did not carry the port the approval names. The relay
  error now names the address the sandbox refused.
- **Newsletter double opt-in.** newsletter **1.0.3** asks for *Read site settings*, which it needs to build the
  confirmation link — without it no confirmation was ever sent and every subscriber stayed pending. The
  subscribe block no longer says "subscription confirmed" (subscribing never confirms); when the confirmation
  cannot be sent the visitor is told to try later. Confirming works on PostgreSQL and MySQL, and the link opens
  the page the visitor subscribed from. Grant the new permission when you update the plugin.
- **Webmail and server console.** Links in received HTML mail keep their query string (`&amp;` was escaped twice,
  so a password-reset link lost its token) and `&` shows as `&`. *Reply* goes to a message's Reply-To — a
  form notification's is the visitor (contact-forms 1.0.2). A mailbox reached directly and through an alias
  gets one copy. The schedule-send and quota menus are no longer cut off. Search understands quoted phrases
  and `-word`, and `is:unread` leaves out your own sent mail. Quotas are hard limits. Sent shows a message once
  the undo window ends. Webmail sends carry the account's display name. GTUBE is filed as spam. A failed
  delivery test is not retried. Aliases appear in the recipient suggestions. *Professional mail account* is no
  longer on by default for new users. Inbound SMTP greets with the HELO name and offers STARTTLS with the
  install's own certificate instead of the library's public example one. The overview shows the address and
  port this node receives mail on and whether password recovery can use the server; the DNS tab proposes the
  node's public IPv4 and the PTR name.
- **Settings → Account email** says when the allowed mail plugin has not yet confirmed outside delivery, which
  is why password recovery is still off. Deactivating a plugin asks for confirmation. bookings 1.0.3: the
  confirmation link opens the booking page even when the visitor used another accepted address. memberships
  1.2.1: the newsletter confirmation names the site, not its host.
- **Plugins: install, update and permissions.** An update is offered only when the catalog has a *newer* version
  (an installed build newer than the catalog's was offered a downgrade). The activation dialog has a switch per requested permission, so a permission
  can be left off before the plugin first starts. A plugin request refused for a missing permission answers
  `403 plugin_permission_denied` naming the permission and where to grant it, instead of "Isolated plugin
  error". A plugin screen that could not be fetched while the server restarts says it is temporarily
  unavailable, with a retry, instead of "Plugin not found".
- **Plugin blocks on public pages.** Blocks that are not configured yet (contact form, poll, card gallery, photo
  carousel, video gallery, YouTube videos, digital downloads, event tickets, social share) show their setup hint
  in the editor only and render nothing for visitors. The store search, store orders and share buttons no longer
  touch the edge of the screen. In the editor palette plugin blocks are grouped with the core blocks (Media,
  Marketing, Dynamic…) with their group's icon, instead of all under *More*. video-gallery **1.1.0** offers its
  block in the editor, with the gallery picked from a list.
- **Payment and forms plugin screens follow the admin language.** The admin screens of contact-forms, bookings,
  donations, digital-downloads, memberships, invoices and event-tickets are in English, Spanish and Portuguese
  (they were Spanish only), with dates and amounts in the admin's locale.
- **Admin menus follow the admin language.** Plugin menu entries can carry a label per language and every
  marketplace plugin does (English, Spanish, Portuguese). The core form-submissions screen is *Form submissions* and the contact-forms
  plugin's is *Contact forms*, instead of two entries called "Forms".
- **Payments and forms plugins.** memberships: the paywall no longer offers *Create account* when registration is
  closed, nor *Subscribe* when no payment provider is set up; the settings warn about both. The core members-only
  notice no longer offers *Create an account* on a site with registration closed either, and plugins can ask
  `site.registrationOpen()` (with *Read site settings*) instead of reading the protected option. Switching the
  payment provider after a key was refused no longer re-sends the refused key. bookings: the *New service* window
  is no longer partly hidden behind the sidebar. contact-forms: a failed *Save form* (no connection) says so next
  to the button. Updated: analytics-tag 1.0.2, auctions 1.1.2, card-gallery 1.0.2, cookie-consent 1.0.2,
  digital-downloads 1.1.2, donations 1.0.3, event-tickets 1.1.2, events-calendar 1.0.2, faq 1.0.2, image-lightbox
  1.0.2, invoices 1.0.2, job-board 1.0.2, notification-bar 1.0.2, online-store 2.0.3, photo-carousel 2.1.1, polls
  1.0.2, popup-builder 1.0.2, restaurant-menu 2.0.3, social-share 1.0.2, testimonials 1.0.2, vendor-marketplace
  1.0.4, youtube-videos 1.0.4.

- **Admin screens that ignored the admin language now follow it.** The database migration, interactions
  (including the preset editor), live hooks timeline, plugins, login and Security Center screens (SSL
  certificates and automatic renewal included) had their copy hard-coded in English or Spanish; it now comes
  from the catalogue in English, Spanish and Portuguese. The built-in public footer's *Quick Links* and *Connect*
  headings follow the site language, like the other visitor-facing strings.

- **Verso on a phone or a tablet: nothing is desktop-only any more.** Below 768 px the block's motion (entrance
  animation, interaction preset, steps and timeline) had no way in at all: the motion dock is a desktop/tablet panel
  and those fields are not in the inspector. Its body now opens as a *Motion* section of the properties sheet. Below
  1280 px a *More options* menu in the header holds what only the desktop header and rail showed: undo/redo,
  publication status and date, preview, replaying the entrance animations, guides, templates, the media library,
  review comments, revision history, the accessibility check and the command palette.
- **Public header and footer on a touch screen.** Menu links, the site title and the logo are at least 44 px
  tall where the pointer is a finger (a mouse keeps the theme's own line height), the drawer's close button is
  44 px, and a header menu with submenus uses the drawer up to 1024 px on a touch screen: its dropdowns open on
  hover or focus, and a tap on the parent link navigated away before either could happen.
- **Static front page: plugin `[tag]` embeds come from the plugins' manifests.** The front page kept its
  own list (`[cards]` → card-gallery, `[vgallery]` → video-gallery). It now renders whatever tags the
  active plugins declare in their manifest `shortcodes` and render with their own site component, with
  attributes passed as props (`[vgallery id="…"]` — the form video-gallery's own handler emits — used to
  stay as text). New public route `GET /api/v1/plugins/shortcodes`.
- **photo-carousel 2.1.0: `[carousel]` works in sanitized post HTML.** Its output relied on a `<style>`
  block the sanitizer always removed, plus an initialiser the core mounted on every post. It now renders
  plain markup on the core's new, plugin-neutral `wjs-snap-strip` classes (a swipeable, scroll-snapping
  row in `wordjs-ui.css`, no script), and the core no longer carries that initialiser. Autoplay and arrow
  buttons remain on the Verso block.
- **mail-server 3.1.1: an account sends as its mailbox address, never its personal email.** An account an
  administrator gave a mailbox while its account email was a personal address (or one whose email later
  moved off the mail domain) could still open the composer, and its mail went out with that personal
  address — in From on local delivery, on the stored Sent copy and on the relay path, and in Reply-To on
  direct-to-MX delivery, so replies reached the private inbox. The sending identity is now the account's
  address on the mail domain, the same rule as delivery. Without one, sending is refused with a clear
  message (`mail_no_mailbox_address`): from the composer, the scheduled queue (the message goes back to
  Drafts and the owner is told), the retry queue and a manual retry. The address is never replaced by
  another. Drafts store that address too, the alignment rewrite no longer puts an account's address in
  Reply-To, and Server → Mailboxes flags an account that has the grant but no address on the domain. An
  administrator without a mailbox of their own still answers catch-all mail, as the site.
- **Multisite on Windows: a plugin's or a site's AppContainer profiles go with it.** Each (site, plugin)
  worker of a network runs under its own AppContainer profile. Deleting a plugin removed only the main
  site's; it now removes the profile (and the folder permissions given to it) of the plugin's worker on
  every site. Deleting a site now removes the profiles of all its plugin and theme workers and their private
  storage under `data/`, `logs/` and `os-tmp/plugins/`, which stayed behind on every platform. No other
  site's or plugin's profile is touched; Linux and macOS have no persistent profile to remove.

- **A Postgres or MySQL site installed with the wizard reaches its database after a restart.** The wizard
  wrote the database as `db.database`, which the configuration never read (the install itself ran against
  the user's default database), and wrote the password only in the nested `db.password`, which a flat
  `dbPassword` generated at the next boot then shadowed. It now writes `db.name` and the flat `dbPassword`,
  `db.database` is read as the name, and no flat password is generated over a real nested one.
- **A plugin's `db.run('CREATE TABLE …')` works on Postgres.** The SQLite dialect was translated only in
  `exec()`, so a plugin creating its table through `run()` (the FAQ plugin does) failed to activate with
  "syntax error at or near AUTOINCREMENT"; MySQL already translated it.
- **conference-manager 2.18.0: a hotel holds each room number once.** Creating a range of rooms sent one
  request per room with no sign of progress, and each extra tap started the whole batch again — the test
  hotel ended with every room seven times. The server now refuses a number the hotel already has (trimmed,
  inner spaces collapsed, any case) with `409 duplicate_room`, on create and on rename; the form shows
  «Creando n/N», ignores a second tap, and skips the numbers that already exist instead of failing.

- **conference-manager: the location card's lodging line and the lodging explorer read cleanly on a laptop
  and a phone.** The card's counts («4 hab. · 9 camas · …») wrap between items only, never leaving a «·» alone
  at the start or end of a line. In «Asignación», a room's or a hotel's header lays out by its own width, so
  at 1280 px with the admin sidebar open «Habitación 103» is no longer cut as «Habitaci/ón», and the
  explorer's breadcrumb pins flush with the top of the panel instead of 24 px below it, where the scrolled
  content showed through. The automatic assignment's report now writes «Sur: 3 asignados» without a space
  before the colon.

- **conference-manager: dragging a placed attendee to another room no longer stops as soon as it starts.**
  With no location filter and the «Sin asignar» list scrolled near the top of the panel, starting the drag
  inserted «Suelta aquí para quitar la habitación» above that list; the browser's scroll anchoring scrolled the
  panel to compensate, the attendee slid out from under the pointer and the drag was cancelled. The hint now
  covers the search box while the drag lasts, so nothing moves. The coordinators' portal shows its «Suelta
  aquí para liberar la cama» the same way.

- **Toasts no longer cover a sheet's buttons on a phone.** Below 640 px, and on a phone held sideways, the
  toast stack sits at the top, below the safe area and clear of a sheet's ✕, instead of at the bottom over
  the pinned action row of whatever sheet or dialog is open (a person sheet's «Eliminar», a payment's
  «Validar»); a desktop keeps it at the bottom right. Toasts are now announced to screen readers, and a
  toast's ✕ has a name («Cerrar», or the admin's language) and a 44 px target.
- **conference-manager 2.18.0: the coordinators' portal totals add up.** «Saldo Pendiente» was the sum of
  every inscription's fee minus what it had paid: a cancelled inscription still counted as owing its fee,
  and one person's overpayment was subtracted from what the others owed. The «Resumen» of «Pagos de
  cuotas» works per person in integer cents: a cancelled inscription owes nothing, money paid beyond a fee
  is shown apart («A favor»), money awaiting validation counts only up to what each person still owes, and
  Validado + Por validar + Por cobrar add up to the fees exactly — the same figures as the admin's
  «Resumen». Cancelled inscriptions were also listed unmarked and could be paid: they are now labelled
  «Cancelada», owe nothing and cannot be selected or paid. The admin dashboard's «Sin pagar» no longer counts
  cancelled people or people whose payment only awaits validation.
- **conference-manager 2.18.0: four-digit amounts are grouped in the admin.** In a Spanish browser the admin
  printed «$1550,00» next to «$13.550,00» (the browser's Spanish leaves a four-digit number ungrouped); every
  amount now groups its thousands. In the coordinators' portal the labels and captions of the payment
  screens meet WCAG AA contrast, a page change brings the list back to its top, and the page is laid out
  under `viewport-fit=cover`, so its sheets and the selection bar keep clear of the iPhone home indicator.
- **conference-manager 2.17.0: «Últimas entregas» says what was delivered.** In «Alimentación» › «Entrega»
  each row of the delivery history named the person, the location, the method and who recorded it, but not
  the meal. A row now shows the person, the meal («Desayuno · Vie 11/12», with the service's own label), a
  chip for the method («Escaneo», «Manual», «Sin derecho (autorizado)» in amber), the time, the location and
  who recorded it, and the card's header names the service. On a phone nothing is cut (lines wrap instead
  of ending in «…»), and «Deshacer» is a 44 px target whose inline confirmation names the meal and the
  person. `GET /meals/services/:id/deliveries` returns the `service` and each row's `service_id`. The
  «Entregado» and «Ya recibió» cards, in «Entrega» and in the phone scanner, name the meal under their title,
  and a delivery from «Por persona» names it in its notice. The list and the counters beside it reload as
  soon as the phone scanner records or undoes a delivery, and when it closes; they waited for the next
  15-second poll, and a poll that answered after a newer reload could put back a list without the latest
  delivery. During a rush every newer answer is applied, so the list and the counters keep moving instead
  of freezing until scanning pauses. While the scanner is open, the page totals reload at most every
  2 seconds and «Entrega» skips its own poll underneath; closing the scanner reloads everything at once. In
  the phone scanner the verdict card stays inside the camera area and, on every phone from 320×460 up,
  shows its status, the meal, the person's name and all its buttons without scrolling inside the card. On a
  tall card the top used to be cut off, the meal included; on short phones the name and the location
  scrolled away, a not-entitled card cut its title («Sin derecho a Jue 08/10 · Almuerzo — …») mid-phrase,
  and «Sí, entregar» / «Cancelar» were hidden on a first-generation iPhone SE. The status is now short
  («Entregado», «Ya recibió», «Sin derecho»), with the meal under it: on a short phone the meal line keeps
  to one line where only the service's label gives way with an ellipsis, and a tap shows it whole. The name
  has its own line and gives way last; the location and the other details give way first and scroll, ending
  on a whole line with «Más abajo ↓» under the cut — never on a lone label or the top half of a value, as the
  fade they had showed them. After «Entregar de todas formas», «Sí, entregar» and «Cancelar» sit side by side
  under a short question that drops whole sentences when room is short (the full question, with the person
  and the service, stays the dialog's accessible name). Short phones get a more compact card, and the
  shortest fold the counters while it is shown. The card's buttons («Deshacer», «Entregar de todas formas»,
  «Sí, entregar», «Cancelar») are 44 px targets, in «Entrega» too. In «Entrega», the inline «¿Deshacer…?»
  of «Últimas entregas» and the verdict card's inline «¿Entregar de todas formas?» scroll themselves into
  view when they open; on an iPhone SE their buttons landed at, or below, the bottom edge. On a 320×460 phone
  that «¿Entregar de todas formas?» was a 16-line column indented under the icon, taller than the screen, and
  its buttons stayed below the edge: it now spans the card, asks the short question (the whole sentence, with
  the person and the service, stays its accessible name), and brings its buttons into view first when it is
  still taller than the screen. The phone scanner's confirmation card (2.16.0) keeps the status and the
  person's name on screen from 320×460 up: they sat in a header inside the part that scrolls, and on a
  320×460 phone with a long service label that part was shorter than the header, so the name was cut — or,
  on a not-entitled card, hidden, and staff could authorise without seeing who. The status and the name are
  now the card's own header and give way last (the name never below one line); the meal takes at most three
  lines, and one on a short phone where only the service's label gives way (a tap shows it whole);
  «Entregar sin derecho (autorizar)» reads «Autorizar» wherever the whole label would take more than two
  lines, which is every phone width, on both confirmation cards. It wrapped to four lines in a narrow button
  from 320 px to 412 px wide. «Cancelar» stays the big button and the accessible name stays whole. On the
  narrowest phones the hand icon gives way so «Autorizar» fits on one line. The reason a not-entitled person
  has no right to the meal («No está en el plan de su localidad», «Se la quitaron a esta persona») is now a
  line under the status that never gives way. On a 320×460 phone it disappeared with the details. The person's
  other details end on a whole line as on the verdict card.
  «Entrega»'s confirmation card does the same with its meal and «Autorizar» on a narrow and short phone: on
  a 320×460 phone its buttons stayed below the edge. Desktop and taller phones keep its layout. On a 320 px
  phone its «Cancelar» and «Entregar» (or «Autorizar») now fit side by side inside the card, with tighter
  paddings and 14 px labels; «Entregar» ran 28 px past the card's edge and was cut («Entrega»). The row wraps
  rather than cut a button, and «Registrando…» shortens with «…» instead of pushing «Cancelar» to a second
  row. A tap on the meal, on either card, shows it whole: on a 320×460 phone it showed two lines cut
  mid-phrase with no cue, and the day that was on screen before the tap disappeared. The person's other
  details give way to it; only when the card cannot hold it without cutting the status, the name or the
  buttons does it keep the whole lines that fit, with «Más abajo ↓», and scroll to the rest. «Entrega»'s
  «Entregado» / «Ya recibió» card is now capped to the visible part of the screen like its confirmation card:
  on a 320×460 phone it was 888 px tall, the name broke inside a word («Villavicen/cio») in a 124 px column
  under the icon, and «Deshacer» was far below the fold. On a phone its meal and the person's data take the
  card's whole width, the name breaks only between words, the meal keeps to one line (only the label gives
  way; a tap shows it whole), and the other details give way and scroll with «Más abajo ↓», so the status,
  the meal, the name and «Deshacer» are on screen together. With the confirmation off (a USB scanner
  delivers at once), every verdict is now capped and brought into view the same way, whether it came from a
  scan, a name picked or «Sí, entregar»: «Sin derecho», «Entregado» and «Ya recibió» opened uncapped below
  the fold — on a 320×460 phone «Entregar de todas formas» sat 570 px under it, and on a 1280×800 desktop the
  card started at the bottom edge. «Entrega»'s «Sin derecho» card has the short status too, with the meal
  under it: «Sin derecho a Jue 08/10 · Almuerzo — …» took eight lines beside the icon on a 320 px phone. Its
  «¿Entregar de todas formas?» drops whole sentences when the card is short, puts «Sí, entregar» and
  «Cancelar» side by side on a phone, and brings the whole card into view, so the status and the name stay on
  screen while staff decide; they had scrolled above the top edge. Otherwise desktop keeps the card's layout.
  The camera's aiming hint, the «En pausa» heartbeat and the focus hint under the aiming frame hide while a
  card reaches them instead of showing letters cut in half. When «¿Deshacer…?» opens in «Últimas entregas», the
  whole row now comes into view below the admin header, with the person's name, the question and its buttons.
  On a 320×460 phone only the question was brought in, and the header's edge cut the row's name. «Deshacer» and
  «Cancelar» share one row, and where the row with the full question would still be taller than the screen,
  the question is the short one («¿Deshacer la entrega de Almuerzo?»). The row above already names the person
  and the meal, and the full question stays the dialog's accessible name.
- **WordPress import stores attachments like uploads.** An imported image now gets the same size ladder
  and WebP/AVIF derivatives as an uploaded one, an imported SVG is stored sanitized instead of being refused,
  and with an S3 media store the imported files go to the bucket like uploads do.
- **`create-wordjs` survives a timed-out prebuilt download.** When the `better-sqlite3` binary download
  timed out on a server without a compiler, the installer ended in a raw `gyp ERR!`. It now retries the
  dependency install with backoff and, if it still fails, explains what to do (retry, or install
  `build-essential`/`python3`), keeps the config (and the `--systemd` unit), and running the same command
  again resumes the install.
- **MCP tools say where every id comes from.** Each `id` argument (and every enum) of the MCP server's
  tools is described, and the tool descriptions spell out the create → update → publish flow, so small
  models stop sending `id: 1` instead of the id `create_draft` returned.

- **Uploads on a network of sites.** A file upload larger than the first network packet (most real photos)
  could fail with "No site context" on a multisite install, because the body was read outside the
  request's site. Every middleware that reads a request body now runs as the request's site.

- **Multisite: network-wide actions on the main site take a network administrator.** Installing, updating,
  packing, downloading or deleting plugins, writing theme files, the marketplace, backups, the database
  migration tool, the site's addresses, certificates, the hooks registry and the Redis object-cache switch
  now answer `403 rest_forbidden_network` (`rest_network_only` for the cache switch) to an administrator of
  the main site who is not a network administrator. Activating plugins, granting their permissions and
  everything else the main site owns stay with its administrators, and the admin screens hide what they
  cannot use. A single site behaves exactly as before.
- **Query-string credentials are short-lived tickets.** The two routes that accept `?token=` (the
  notifications stream and the plugin package download) take only a 60-second ticket for that path, from
  the new `POST /api/v1/auth/query-ticket`; a session token or an API token in the query string is no
  longer accepted. The admin uses the session cookie for both and is unaffected.

### Fixed

- **`/readyz` no longer hangs when the database stops answering.** The readiness check now has a deadline
  (3 s, `WORDJS_READINESS_TIMEOUT_MS`): past it the probe answers `503 not_ready` (`db: "timeout"`)
  instead of leaving every later probe waiting on the stuck one, and no second query is started while
  the first is still pending. On Postgres and MySQL the check also runs with a server-side statement
  timeout.
- **WebSocket upgrades behind an untrusted CDN or reverse proxy.** Without `trustProxy` every visitor
  behind such a proxy shared one upgrade budget, so collaboration, presence and HMR sockets could be
  refused for the whole site. The gateway now gives each forwarded client behind a shared address its own
  per-client budget and raises that address's total with the number of distinct clients behind it (up to
  `rateLimit.upgradeSharedMultiplier`, default 20×). It also logs its trust posture at boot and warns once
  when one address carries many forwarded clients, naming `trustProxy` / `WORDJS_TRUST_PROXY`.

### Security

- **Provider grants are labelled administrator-level.** `email:provider` and `notifications:provider` are
  shown with an "administrator-level" badge and plain wording on every grant screen, and every other
  administrator gets an in-app notice when a password is reset through an emailed link.
- **A plugin's admin stylesheet needs `browser:script` and is confined.** `GET /plugins/:slug/admin-style/css`
  is served under the same gate as `dist/`, with `@import` and any resource-loading value (other than
  `data:` URLs) removed and every rule scoped so it cannot restyle the admin's own interface.
- **AI agents:** the Agents screen warns about the `content:others` + `content:publish` combination, an
  optional site-wide setting makes a person confirm everything agents publish (with a queue on the Agents
  screen), and revisions created by an agent's write are labelled so the change can be undone in one restore.
- **Content types cannot borrow core capability names.** A content type whose operations (or capability
  family) name a core non-content capability such as `edit_users` or `manage_options` is refused, and the
  agent capability mapping never grants those names.

- **Each site of a network has its own space in the media bucket.** With S3 media storage, every site other
  than the main one now stores and serves its objects under `<prefix>/sites/<id>/`, so sites no longer
  share object keys; the main site's keys and URLs are unchanged. Objects stored before this release move
  into their site's space once, at startup (verified by size, idempotent) — see
  [media-storage.md](documentation/media-storage.md).
- **Moving media to the bucket and back covers every site of a network.** `POST /media-storage/migrate`
  (and the screen's buttons) now offloads or restores each site's library in turn, so a network can
  switch back to local storage.
- **Plugin activation, deactivation and reload are rate-limited** per site and account, together with the
  routes that restart a plugin's worker (grants, egress hosts, private destinations, port):
  `429 rest_plugin_lifecycle_rate_limited` beyond 60 in 10 minutes.
- **Private destinations can never be approved in their IPv6 spellings either.** The metadata, link-local
  and multicast addresses that NAT64, 6to4, ISATAP or Teredo addresses embed, and `fd00:ec2::254`, are
  refused like their plain form.
- **Network administrator accounts are managed by network administrators.** With multisite on, a network
  administrator's email, password, role, two-factor reset, AI agent connections and the account itself can
  be changed only by a network administrator (or by its owner), and a site import leaves those accounts and
  the network-wide settings untouched. Deleting an account removes it from the network administrators, and
  each network-administrator entry is bound to its account's login and re-checked at boot and after a
  backup restore.
- **The two-factor code ceiling on the account security doors lasts a day.** Past ten wrong codes on
  `/auth/mfa/disable`, `/auth/mfa/backup-codes` or a token step-up, the account password stays required
  for 24 hours (or until a correct code or a password sign-in), on the Redis and in-memory stores alike,
  and concurrent attempts are counted one by one.
- **The gateway's debug "Proxying" line redacts query values,** like the access log, so one-time tokens
  in reset, verification and invitation links are not written to debug logs.
- **A plugin's JavaScript under `public/` now needs `browser:script`, like its `dist/` bundles.** The static
  `/plugins/<slug>/public/*.js|.mjs|.cjs` files are served only while the plugin is active and granted
  `browser:script`; styles, images and fonts keep the active-only rule. Every marketplace plugin that
  enqueues a public script already declares it.
- **mail-server 3.0.4: inbound sender authentication.** A `From` that names several domains is now
  evaluated against the DMARC policy of each of them and gets the strictest outcome (RFC 7489 §6.6.1);
  such mail is never shown as a verified sender, the stored verdict lists every From domain and the
  reading pane shows **Several senders**. A message with several `From` header fields is refused.
  Relaxed DMARC alignment now finds organizational domains with the **Public Suffix List**, vendored as
  data in the plugin (`lib/public-suffix-list.js`, regenerated by
  `backend/scripts/update-public-suffix-list.js`); a domain whose suffix the list does not know aligns
  only on an exact match. A DKIM signature whose `l=` leaves part of the body unsigned is a *pass with
  unsigned content*: it no longer counts for DMARC alignment or for the local-domain check, and the
  webmail shows **Partly signed by …** with a notice instead of a verified badge.
- **mail-server 3.0.4: the outbound retry queue charges a message once.** Automatic retries no longer
  count against the sender's hourly limit again on every pass, and site/provider mail (`user_id = 0`)
  retries on its own budget (1000 messages / 5000 recipients per hour) instead of a shared 100-message
  bucket.
- **A plugin route's `req.user` carries the caller's email and login only with `users:read`.** Without the
  grant a route still receives `id`, `role`, `hasProfessionalMailbox` and `pluginCapabilities`.
- **Real-time collaboration hardening.** The `/collab` routes now require an interactive sign-in; API
  tokens and agent connections get `403 rest_session_required`. An open editing stream is re-checked at
  once, on every node, when the user signs out, changes password, signs out everywhere, changes role,
  falls under a two-factor requirement, or when the post's status or author changes; a check that cannot
  complete closes the stream after a short grace, and deleting a post closes its streams and removes its
  session rows. Messages on the `wordjs:collab` cluster bus are signed with a key derived from the site
  secret, limited to the events the nodes publish, and their operations are validated like an upload.
  Writing a page's content outside a live session (restoring a revision, saving from another editor)
  resets that session so its members reload the saved content, and the collaborative editor's saves carry
  `X-Collab-Epoch` so a save from a replaced session answers `409 collab_epoch_stale` instead of
  overwriting it. New caps: connections per room and per user across the cluster, a per-user write budget
  shared by all of the user's tabs, and a per-user share of a session's operation log. Structural edits
  are sanitized with the same key-aware rules as `PUT /posts/:id`, and presence shows each member's
  account number next to their display name.

### Fixed

- **`auctions` 1.1.1: signed-in bidding works again.** The plugin now requests `users:read`, so a signed-in
  bidder bids as the address of their own account (the host shares a caller's email with a plugin route only
  under that permission). Until an administrator approves it on an updated site, a signed-in bidder types an
  address and confirms it with a mailed code, in `login` mode too. Every bid is now held to the per-auction and
  site-wide bid windows, a mailed verification code stays charged to the requesting client's window, and
  verification codes are bounded per client and site-wide (200 an hour) as well as per address.
- **`vendor-marketplace` 1.0.3 and `conference-manager` 2.17.2: a right portal code is never refused for other
  callers' wrong ones.** The per-client budget is the only one that refuses a portal sign-in; past the
  per-portal and site-wide budgets every attempt waits a little longer instead, and only wrong codes for a
  store or location that exists count toward them. The `vendor-marketplace` block now sends the CSRF header
  with its sign-in, portal, application and inquiry requests, so a visitor who is signed in to the site can
  use them.
- **`event-tickets` 1.1.1: unpaid holds.** Unpaid orders of a ticket type together hold at most
  `pendingHoldPercent` of its capacity (never less than one seat), the first order included. On a site without
  a mail transport an order is held to the same per-address unpaid-seat window as a confirmed one, and the
  confirmation codes the site mails are bounded site-wide (200 an hour).
- **`digital-downloads` 1.1.1: the download and order-received mails carry only the site's own text** (no
  longer the name typed in the order form), like the other public-form plugins' mails. Its block now sends
  the CSRF header with the order request, so a visitor who is signed in to the site can order.

## [2.7.0] - 2026-10-17

### Added

- **Update a plugin or a theme by uploading a newer zip.** Uploading a zip whose plugin is already
  installed used to fail twice — "deactivate it", then "uninstall it" — and uninstalling dropped the
  plugin's grants. Now **Plugins → Upload Plugin** answers `409 plugin_exists` with both versions and the
  screen offers **Update** (`POST /api/v1/plugins/:slug/update`): the new code is extracted to a staging
  directory and validated there first (a bad zip leaves the installed plugin running, untouched), then
  swapped in and restarted if it was active. `data/`, the plugin's tables, its grants and its egress list
  are kept; permissions the new version adds are reported and stay off, and the permissions dialog opens
  on them. Themes get the same: **Install Theme** with an installed theme's zip offers **Update**
  (`POST /api/v1/themes/:slug/update`, staged and compiled first, then swapped; an active theme stays
  active and keeps its customizer settings). See `documentation/plugins.md` and `documentation/themes.md`.

- **`wordjs.js pack theme <slug>`** zips a theme with the single `<slug>/` root folder the upload and the
  update expect. The admin's theme download now has the same layout, so it can be uploaded back.

- **A plugin can reach an administrator-approved private address — one host, one port.** Plugins still
  reach public addresses only, but an administrator can now approve an exact `host:port` for a plugin
  (`GET`/`POST /api/v1/plugins/:slug/private-egress`, at most 4 entries). The case it exists for is an
  SMTP smarthost on the LAN, which the Mail Server could not use at all. An approval opens that host on
  that port and nothing else; link-local addresses (including `169.254.169.254`), unspecified and
  multicast addresses cannot be approved; it lives beside the egress allowlist without changing it; saving
  restarts the plugin and is recorded in the audit log (`plugin.private_egress`); and an API token may
  withdraw an approval but never make one. See `documentation/plugins.md` and `documentation/api.md`.

### Changed

- **The release smoke gate deploys split mode with the default HTTPS too**, installing, restarting and
  requesting a content page, and checks that the frontend listens on loopback only. The release
  workflow's jobs run on `ubuntu-24.04` instead of `ubuntu-latest`, which moves to Ubuntu 26.04 on
  2026-10-19; pull-request CI keeps `ubuntu-latest`, so the new image is met there first.

- **AI provider: a longer, configurable timeout for local models.** A loopback OpenAI-compatible
  provider (Ollama, LM Studio…) now gets 300 s per request instead of 60 s, enough for a CPU model's first
  load, a queue or an image; `WORDJS_AI_TIMEOUT_MS` overrides it for every provider.

- **AI provider failures say what went wrong.** A timeout (`ai_provider_timeout`, 504), a model that does
  not accept images asked for alt text (`ai_provider_no_vision`, 422), an unknown model, an unreachable or
  unavailable server and a refused request now have their own codes and messages, and the editor shows a
  translated message for each instead of one generic "did not answer correctly".

- **Post and page `link` is the canonical URL.** REST and GraphQL answer `<siteUrl>/<slug>` — what the
  page declares in `rel=canonical` and the sitemap and feeds publish — instead of `/post/<slug>/`, which
  answered with a 308 redirect. Other content types keep `/<type>/<slug>`, without the trailing slash.

- **Anonymous `status=draft` (pending, private, future) lists are empty.** `GET /posts` and GraphQL
  `posts(status:)` used to answer an anonymous request for unpublished entries with the published ones;
  they now answer an empty list. `status=any` still lists the published entries.

- **The installer no longer reports a fake test run.** It used to "run" the core test suite with a filter
  that matched none of its TypeScript files and report "0 tests, OK"; the install response now says
  `tests.skipped: true`. `runCoreTests()` finds `*.test.ts` files, runs them with the secret-free env, and
  reports `skipped` when there is no suite or no dev dependencies.

- **The admin follows the site's language until you pick one.** With no choice saved in the sidebar's
  language menu, the admin now speaks the site's own language (`<html lang>`, from the site locale) when it
  is English, Spanish or Portuguese, instead of always starting in Spanish. An English site no longer
  shows Spanish Backups or Marketplace screens next to English ones. A language picked in the sidebar still
  wins, on every site.

- **Bundled theme descriptions are translatable.** `theme.json` accepts
  `"translations": { "<lang>": { "description": "…" } }`; the admin shows the description for its own
  language and falls back to `description`. The four bundled themes ship English descriptions with Spanish
  and Portuguese translations (Circuito's was Spanish only).

- **Mail Server 3.0.2: a relay that does not answer is reported, not bypassed.** When the configured
  relay failed its check, outgoing mail silently went direct-to-MX instead. Now it waits in the retry
  queue and the console says **Relay unavailable: <reason>** (server health, the Configuration tab and
  the Test tab; `relay_status` in `GET /settings`); a failed relay is re-checked at most once a minute.
  The Configuration tab has a **Sandbox access** section to approve a private relay's exact address. A
  relay given by name now works inside the sandbox (the plugin resolves it and keeps the name for TLS),
  and relay credentials are optional, for a smarthost that relays for its network by address. With
  **Require STARTTLS** off, a relay that advertises STARTTLS and then refuses it with an SMTP reply gets
  the mail without TLS, as direct-to-MX delivery already does.

- **Mail Server: password recovery works with a relay.** Recovery (and e-mail verification) waited for
  the DNS check to find MX, A, SPF, DKIM and DMARC on the site's own domain, which a site that sends
  through a relay never passes. Now a relay that answers its check is what makes mail ready, and one
  that does not turns recovery off again.

- **Mail Server: switched-off settings stay off.** A setting saved as `0` came back from the host as a
  number and was read as on, so **Require STARTTLS: No** (and other switches turned off in the console)
  had no effect and showed as **Yes** again after saving.

- **Mail Server: a non-standard `smtp_listen_port` works with "Receive internet email".** WordJS now
  opens any unprivileged port (1024 and up) for the plugin, besides the ones its manifest declares. A port
  it refuses no longer leaves the server without a listener: the plugin listens on 25 and the console
  says which port was refused and why.

- **Mail Server: the console warns when the mail domain is not a public domain.** On a site reached by
  IP, `localhost` or a LAN name, mailboxes become `@localhost` (or similar) and no other server can
  deliver to them. Server health, the Configuration tab and the startup log now say so and how to fix it
  (`mail_domain` / `mail_domain_public` in `GET /settings`).

- **Multisite: the database migration tool, like backups, is now available on the main site only in a
  multisite network.** `/api/v1/db-migration/*` answers 404 on every other site, exactly as `/backups`
  does there (the admin screen already hid it). Single-site installs and the main site are unchanged.

- **`GET /api/v1/` reports the product version and the full route map.** `version` now comes from the
  release manifest (the same value `/api-docs` publishes) instead of a fixed `1.0.0`, and `routes` lists
  every mounted route group, including the ones added since the map was written (AI, MCP, agents,
  webhooks, audit, forms, collab, presence, media storage, site address, network, backups,
  db-migration, ...). A test fails when a mounted group is missing from the map. Compatibility: the
  API index now reports the product version and every mounted route group; every key it published
  before is still there with the same path, so clients that read it only see additional keys and a
  real version number.

- **Theme logic: the default permission declaration uses the real vocabulary.** A theme without a
  `manifest.json` declared a `content:read` scope that no permission gate knows; it now declares only
  `settings:read`, from one shared definition used by both the runtime gate and the static scan. No
  effective behaviour changes: a theme's `functions.js` still holds no permission grant.

### Fixed

- **A page rendered while the backend was down is no longer cached.** Public pages rendered with the
  defaults (title "WordJS", no menus) or as a 404 when the backend did not answer, and the page cache kept
  serving that copy after the backend was back; a site created a moment earlier could answer its own
  address with it. A render that gets no answer (a failed connection, or the gateway's 502/504) now
  fails instead: the last good copy keeps being served, or an error that is not cached, and the next
  request renders the page again.

- **The share image of a post follows the media library to the CDN.** With the library in an
  S3-compatible bucket, the page body already loaded images from the CDN, but `og:image`,
  `twitter:image` and the JSON-LD image still named `<site>/uploads/…`, which only answers with a
  redirect to the bucket. They now use the same CDN URL as the body.

- **The admin's media CSP no longer slips back to the old origin after a storage change.** The settings
  purge re-read the media origin at once, but the next page render put the stale cached value back, so a
  reload within about 20 seconds of saving could still refuse the new bucket. The fresh value now holds
  until the cache has caught up.

- **The Verso canvas links the theme stylesheet once.** The site chrome drawn inside the canvas added its
  own copy of the theme and framework stylesheets, and the canvas's theme check then compared against the
  wrong one and added a third.

- **The WordPress import summary points at Menus.** It said "Appearance → Menus" (WordPress's name); it
  now links to **Menus** in the admin sidebar.

- **`npm run media -- …` works on a network of sites.** With multisite on, every command failed with
  "No site context: this work did not say which site it belongs to.", because the CLI process never said
  which site it was working for. It now works on the main site's media library, as its help text says.

- **`npm run media -- status` prints only JSON on stdout.** The config boot notes ("Config loaded from
  wordjs-config.json", the secret auto-generation lines) still went to stdout ahead of the command's
  output, so piping it to `jq` failed. With `WORDJS_LOG_TO_STDERR=1`, which the CLI sets, they go to
  stderr like every other log line.

- **Edits show on a split site right after an HTTPS install, and on any single-host split site behind
  a public name.** The backend sent its on-demand cache purges to `frontendUrl`, which the installer
  derives from the site address (`https://example.com`, or `https://example.com:3001`): not this
  machine's frontend, which listens on loopback when the gateway is local. And right after an install
  with the default HTTPS the frontend still listens on the plain-HTTP socket it opened before the
  certificates existed, while an `https://` purge target never falls back to plain HTTP, so every purge
  failed and pages changed only when their cache window ran out (60 s for the home page) or after a
  restart. A single-host split now purges the frontend installed next to the backend on `127.0.0.1`
  at its own port, and for that loopback target the purge follows the listener the frontend really
  opened.

- **A split install keeps serving HTTPS after its first restart, and its content pages render.** Two
  problems hit a split-mode site installed from the release bundle with the default self-signed HTTPS
  (no `WORDJS_HTTP=1`). First, the installer rewrote `gateway/gateway-config.json` with `ssl` taken
  from the backend's config, which has none, so the key was dropped and the gateway came back from its
  next restart serving plain HTTP on a site whose address is `https://`. The installer now only replaces
  gateway keys the backend config actually sets. Second, once the cluster certificates exist the
  frontend's server-side reads go through the gateway's public origin, but the frontend trusted only the
  cluster CA, not the gateway's own self-signed certificate, so every read failed and pages such as
  `/about` or a post answered 404 while the home page fell back to defaults. The frontend now also
  trusts the certificate the gateway on the same machine serves (`gateway/ssl-auto.crt`, or the one set
  in `gateway-config.json`), and nothing wider. Sites behind a TLS-terminating proxy with
  `WORDJS_HTTP=1`, monolith installs and separate mode were not affected.

- **Behind a reverse proxy on the same machine, visitors keep their own address.** The gateway's public
  rate limit counted per connection address and the gateway never trusted a fronting proxy, so behind
  nginx every visitor was `127.0.0.1`: the whole site shared one 1000-requests-a-minute bucket, and the
  backend was told the proxy's address for everyone. `trustProxy` in `gateway/gateway-config.json` (or
  `WORDJS_TRUST_PROXY` for the gateway; same syntax as the backend's, e.g. `"loopback"`) now sets which
  proxy the gateway believes, and the gateway then forwards the client it resolved to the backend.
  Unset, nothing changes. Both the gateway and the backend now log one warning the first time a request
  arrives from a local proxy that nothing trusts, naming the setting to add.

- **The gateway honours `LOG_LEVEL` and `logging.level`.** Its logger was fixed at `info`; it now follows
  the backend's order (`LOG_LEVEL`, then the config, then `info`) and understands the backend's level
  names too.

- **AI requests are no longer cut at 60 s in split mode.** The gateway gave every proxied request 60 s;
  `/api/v1/ai/…` now waits the AI provider timeout plus 30 s (`WORDJS_AI_TIMEOUT_MS`, default 300 s), so
  a slow local model answers, or the backend reports its own timeout.

- **Split mode on one machine stays on the machine.** The frontend's server-side reads went to the
  gateway's public address, so behind a proxy they left the server and came back through it; they now go
  to the gateway next to it over loopback (when its certificate covers a loopback name, which the
  auto-generated one does). The frontend also listened on every interface and registered the site's
  public name with the gateway; it now listens on `127.0.0.1` and registers that, unless its config sets
  a routable `advertiseHost` (or `WORDJS_FRONTEND_BIND` names the address). And a split site installed
  with the default HTTPS no longer renders default content until its first restart: the frontend trusts
  the local gateway's own certificate from its first boot, not only once the install has issued the
  cluster certificates.

- **The backend honours `PORT`, and the install keeps the configured ports.** In split and development
  mode the backend ignored `PORT`, and `POST /setup/install` wrote `port: 4000` (and the default
  frontend and gateway ports) over the values the config already had. `PORT` now wins over `port` in
  `wordjs-config.json` (not in the monolith, where `PORT` is the public port), and the install keeps the
  ports it finds.

- **Command-line tools no longer lock the service out of its own files.** Run as root in an install that
  belongs to another account, `npm run network`, `npm run site`, `npm run media` and `npm run migrate`
  left `wordjs-config.json` and new database files owned by root, and the service could no longer write
  them (creating a site failed with "attempt to write a readonly database"). They now refuse and print
  the command to run as the owner (`WORDJS_ALLOW_ROOT=1` overrides). `npx create-wordjs upgrade` run as
  root now gives the files it wrote back to the owner of the site directory, so `frontend/.next/cache`
  can be created again.

- **Small output fixes.** The install banner printed its hint as `WORDJS_PRINT_INSTALL_TOKEN=[redacted]`
  (the log scrubber took the `=1` for a credential); the production monolith suggested `npm run dev` to
  switch to split mode instead of `npm start`; `create-wordjs` printed npm's own "new major version"
  notice in the middle of its output.

- **MCP: a call to a tool the agent connection was not granted** is answered with a tool error that names
  the missing grant and is recorded as `agent.denied` in the audit trail, as documented.

- **MCP `get_site_info`** answers the effective language tag and time zone (`en`/`UTC` on a site that never
  saved them) instead of empty strings.

- **Media storage: the public URL is checked for the mistakes the server can see.** The settings and the
  connection test answer `warnings` for a public URL that already ends with the key prefix (media URLs
  would read `…/uploads/uploads/…`), a path-style endpoint without the bucket, and plain http on an https
  site.

- **Media storage on a multisite network:** a file another site does not hold on disk is redirected to the
  bucket, like on the main site, instead of a 404.

- **Media storage: "a migration is already running" is cluster-wide.** A node that is not running the
  migration itself now refuses a second start (409) and reports it as running, from a progress record the
  running node refreshes at least every 30 s.

- **Media storage: a saved public URL reaches the admin page's CSP at once.** The frontend re-reads the
  media origin when the backend purges its settings cache, so **Test connection** works right after a save
  instead of failing for up to a minute.

- **`npm run media -- status` prints only its JSON on stdout**; backend log lines go to stderr
  (`WORDJS_LOG_TO_STDERR=1`), so it can be piped to `jq`.

- **Backup archives are now created owner-only** (0600, in a 0700 directory), and archives already on disk
  are tightened at boot.

- **Docs:** `gateway.md` documents `GET /revalidate-secret`, and its endpoint test reads the routes
  mounted from `gateway/src/purge.js`; `media-storage.md` names Garage and SeaweedFS next to MinIO for a
  self-hosted bucket; `ai-agents.md` notes that **Last used** is written at most once a minute.

- **Plugins → Marketplace speaks the admin's language.** The catalog tab, its source settings and the
  install dialog were hard-coded Spanish ("Cargando el catálogo…", "Instalar", "Bloque …", "Permisos que
  solicitará", "Cancelar", the source line and the toasts); they are translated now, including the
  catalog's categories and the review badges. The broken-plugin card and its cleanup messages too.

- **The delete-plugin dialog is one sentence.** It read "…This action cannot be undone. Reading List?";
  the plugin's name now sits inside the question.

- **Restoring a backup says it worked and what to do next.** The page reloaded a second after the restore,
  throwing away the only feedback; it now stays on a success notice that tells the admin to restart the
  WordJS service, with a reload button.

- **Webhook delivery times are local.** The delivery log showed UTC database timestamps as if they were
  local, next to a "Last delivery" in local time.

- **Network → Create site shows why it failed.** A failed create (a server error included) now leaves an
  error on the form as well as a toast.

- **Media storage shows the server's advice about the public URL.** Non-blocking `warnings` from the media
  storage API (a URL that repeats the key prefix, misses the bucket, or would be mixed content) are listed
  under the fields, a failed public check in "Test connection" explains what to try, and the endpoint
  hints name Garage and SeaweedFS next to MinIO.

- **AI agents → New connection is no longer cramped.** Below 1536 px the form sits above the connection
  list instead of in a narrow column that cut its labels at 1280 px.

- **The Verso editor speaks the admin language everywhere.** With the admin in English the editor still
  showed Spanish in many places: the mobile header ("Editando · …"), the canvas and navigation labels,
  the entrance-animation effects, speeds and delays, the device tabs and every section of the
  appearance panel (background, border and shadow, spacing and size, typography, hover motion), the
  image and link fields, the list, menu, symbol and featured-image pickers, the interactions panel and
  its timeline, collaboration status texts and the block palette's catalogue. All of them now go through
  the editor dictionary in English, Spanish and Portuguese; a new test parses the editor sources and
  fails on any visible string without a translation.

- **New blocks start with text in the admin language.** A freshly inserted Hero, Button, Text, Form,
  pricing table and the other core blocks — and the built-in patterns — used to start with the same
  starter text whatever the language ("Un titular que atrapa" in an English admin). The starter text
  now follows the admin language; blocks already on a page keep their text.

- **The main editor button shows the published state.** After publishing, with nothing pending, the
  button reads "Published" (or "Scheduled") with a check mark instead of offering the "Publish" action
  again.

- **Plugin blocks have readable names.** A plugin's Verso block can declare an optional `label` in
  `versoComponentDef` / each `versoComponents` entry; without one the editor splits the block id into
  words ("ReadingList" → "Reading List") instead of showing the raw id. See `documentation/plugins.md`.

- **WordPress import keeps featured images.** `_thumbnail_id` names the attachment's id on the old site;
  it is now remapped to the imported attachment, also when the attachment is listed after the post or was
  matched on a re-run, and a re-run repairs posts an earlier import left pointing at the source id. A
  reference that resolves to no imported attachment is dropped instead of naming an unrelated row.

- **Imported comments keep their dates.** `wp:comment_date` / `wp:comment_date_gmt` are restored instead of
  the import time.

- **Re-importing content re-links menus.** When a menu is matched on a re-run, an item whose page, post or
  term no longer exists (deleted and imported again under a new id) is re-pointed at the re-imported copy;
  items whose target still exists, including ones edited by hand, are left alone. The summary reports them
  as `menus.items.relinked`.

- **Public dates follow the site language.** Post dates on single posts, the home page and search results,
  and comment dates, are formatted in the site's language (`WPLANG`, the same value as `<html lang>`)
  instead of the visitor's browser or the server's locale, so an English site no longer shows `2/3/2024`
  for 2 March to a Spanish reader.

- **A freshly installed site runs cron and outgoing webhooks without a restart.** The process that
  finished the install wizard (or `POST /api/v1/setup/install`) had booted in setup mode, and the boot
  starts cron, the coherence and cluster buses, the webhook dispatcher and the content outbox only on an
  installed site. Until the first restart, webhooks delivered only the manual test ping (no post,
  comment, term or settings event was ever queued) and scheduled posts were not published. The install
  now starts these services in the running process, as the boot does (`core/runtime-services`).

- **Release bundles no longer include a stray test backup in `backend/backups/`.** The 2.6.0 bundle
  carried a backup left over from a local test run (a throwaway test database, no site data), and
  `npx create-wordjs upgrade` copied it into the upgraded site, where it listed under Admin → Settings →
  Backups. If a site upgraded to 2.6.0 shows a backup dated 2026-10-15 that it did not create, delete it
  from that page; do not restore it. The packager now excludes `backend/backups/` by name,
  `.gitignore` covers it, and CI fails if the repository tracks a backup or a database file outside test
  fixtures or if a built bundle contains one. `create-wordjs upgrade` also treats `backend/backups/`
  as site state, like `backend/data/` and `backend/uploads/`: it never adds to or replaces the site's
  own backups.

- `wordjs.js pack <slug> --build` on a production install stopped with a raw `Cannot find module
  'esbuild'`; it now says the backend's development dependencies are missing and how to build instead.
  Its closing hint names the real button (**Upload Plugin**, not "Add New").

- A theme generated from valid seeds could get a `--wjs-color-text-muted` under AA (4.42:1 for
  `#2b211c` on `#fbf7f2`), which the doctor then flagged. The derivation now washes the text less when
  needed and always reaches 4.5:1; palettes that already passed are unchanged.

- A theme's `styles.hero.bg` / `--wjs-hero-bg` never showed: the framework's default hero gradient was
  painted over it. Both ends of that default gradient now fall back to `--wjs-hero-bg`; an explicit
  gradient or image still wins. A bundled theme that set only `--wjs-hero-bg` now shows that colour.

- After activating a theme, the first visit to each cached page still got the previous theme
  (stale-while-revalidate). Activation, and updating the active theme, now expire those pages at once.

- An isolated plugin's `comments:pre_insert` filter that threw or timed out was skipped and the comment
  accepted, against the hook's contract. That hook now fails closed: the comment is refused with the
  plugin's own 4xx status and `rest_*` code when it gave one, `503 rest_plugin_check_failed` otherwise.
  Other filters keep falling back to the unchanged value.

- `backend/types/wordjs-bridge.d.ts` declares `WordJSRouteUser.pluginCapabilities`,
  `res.sendPrivateMedia()` and `wordjs.media.getPrivate()`.

- The `hello-world` sample filtered `the_content`, a hook core never applies, and its test claimed to
  run before activation; it now registers a `[hello]` shortcode and says its tests are the author's to
  run. `POST /plugins/sample` writes the same isolated sample (it wrote an in-process one without a
  manifest). The `test-schema` fixture declares `database:write` instead of an access level the upload
  refuses, and drops its unused `main` / `active` keys.

- **Diagnostic scripts in `backend/cli` run again.** `inspect-roles.js`, `inspect-user.js`,
  `verify-roles.js` and `force-sync-roles.js` use the backend's current database initialization (the same
  driver and `dbPath` as the server) and are run from `backend/` as
  `node -r ts-node/register cli/<name>.js`. `force-sync-roles.js` resets the built-in roles to the
  server's defaults (plus any `roles` override in the config) and keeps plugin and custom roles;
  `inspect-user.js` takes the login as an argument and never prints credential columns.
  `check_plugins.js` reads `dbPath` (or the `dbDriver` default file) from `backend/wordjs-config.json`.
  `backend/scripts/migrate-media-urls.js` loads the TypeScript sources by itself (compiled `dist/` when
  present), so a plain `node scripts/migrate-media-urls.js` works.

- **Plugin bridge typings.** `backend/types/wordjs-bridge.d.ts` now describes `wordjs.paths`
  (`data`, `logs`, `tmp`) and the `wordjs.smtp` namespace (`listen`, `status`) used with the
  `smtp:inbound` permission, with its session, handler, option and status types.


## [2.6.0] - 2026-10-16

### Added

- **Strict database driver mode.** `"dbStrictDriver": true` in `backend/wordjs-config.json`, or
  `WORDJS_DB_STRICT=1` in the backend's environment (the variable wins, in both directions), turns the
  fallback to the pure-JS `sqlite-legacy` driver into a boot error. The error names the driver that failed,
  its load error, what the fallback would have cost (no FTS5, so site search on `LIKE` instead of ranked
  results) and the fix (`npm rebuild better-sqlite3` in `backend/` for the native driver). In strict mode
  migration `0008_posts_fts5` also fails, rather than skipping, on a SQLite build without FTS5; an
  explicitly configured `sqlite-legacy` still boots. Off by default, so nothing changes for existing
  installs: the fallback, its admin notice and `/health/details` report work as before. See
  `documentation/database.md`.
- **Webhooks cover the whole site lifecycle, not just six content events.** The catalogue grows from 6 to
  31 events, grouped by entity: posts and pages (`post.scheduled`, `post.unpublished`, `post.trashed`,
  `post.restored` next to the existing four), comments (`comment.updated`, `comment.approved`,
  `comment.spam`, `comment.trashed`), users (`user.created`, `user.updated`, `user.deleted`, and
  `user.login`, which is opt-in: no wildcard includes it), media (`media.uploaded/updated/deleted`),
  categories and tags (`term.created/updated/deleted`), menus (`menu.updated`, naming what changed),
  plugins (`plugin.installed/activated/deactivated/uninstalled`), themes (`theme.activated`) and settings
  (`settings.updated`, key names only). The events come from the hooks core already fires and from a new
  host-only observer of the audit trail (`onAuditRecorded`), so there are no emit calls scattered through
  the routes; signing, retries, the SSRF guard and the delivery log are unchanged, and existing
  subscriptions (`*`, `post.*`, …) keep their format and simply receive the new events in their scope.
  Every payload is built by an allowlisted per-entity serializer, so no password hash, MFA secret, token,
  email address, option value or private-media URL can reach a receiver. `POST /webhooks/:id/ping` sends a
  signed test delivery to one endpoint, and the admin page gets an event picker grouped by entity (with a
  per-entity "All") and a **Send test** button. Every event and its payload is documented in
  `documentation/webhooks.md`.

- **The audit trail records media, taxonomy, menu, comment-moderation and plugin install/uninstall
  changes, profile saves and self-registrations.** New actions: `media.upload/update/delete`,
  `term.create/update/delete`, `menu.create/update/delete`, `comment.approve/spam/trash/update/delete`,
  `plugin.install` (zip upload), `plugin.uninstall`, `user.update` (field names only) and
  `auth.password.change`; a self-registration now records `user.create`. This closes the two call sites
  `documentation/security.md` listed as missing (the media routes and the profile password change).
- **A read-only GraphQL API at `/api/v1/graphql`.** Posts, pages, custom post types, categories and tags,
  taxonomies and content types, media, menus, approved comments, the public settings and the current
  viewer, with cursor pagination (`first`/`after`, `pageInfo`, `totalCount`), filtering and the same
  full-text search as REST. Every field resolves through the matching REST read, in process and as the
  same caller, so drafts, private and password-protected entries, non-public types, hidden attachments and
  scoped API tokens behave exactly as they do on REST; a parity suite compares the two for anonymous
  callers, owners, other authors and editors. The server is protected by a depth limit (10), a query-cost
  limit (1000), a parser token cap, a 100-item page cap and the existing API rate limiter; introspection
  is off in production unless the new admin-only `graphql_introspection` setting turns it on. Host code
  can extend the schema with `registerGraphQLExtension()` or the `wordjs_graphql_register_types` hook.
  Mutations are not part of this release. Built on `graphql` 16 and `graphql-http` (both MIT, no
  transitive dependencies). See `documentation/graphql.md`.
- **Optional media offload to an S3-compatible bucket and CDN.** Media could only live on the backend's
  local disk. Settings → Media storage (or a `mediaStorage` block in `wordjs-config.json` / the
  `WORDJS_MEDIA_*` env vars) now sends public uploads — the original and every stored derivative, the size
  ladder and its WebP/AVIF siblings included — to AWS S3, Cloudflare R2, MinIO, Backblaze B2 or any
  S3-compatible store, reusing the dependency-free SigV4 signer of the backup offload. The database keeps
  the same relative `/uploads/...` paths: `/uploads` redirects to the CDN for files a node does not hold,
  the API adds a `deliveryUrl`, and once the whole library is offloaded the public SSR emits CDN URLs
  directly. The page CSP gains exactly the configured media origin in `img-src` and `media-src`, at
  response time. `npm run media -- offload | restore | status | test` (and buttons on the screen) move an
  existing library to the bucket and back, idempotent and resumable, one run at a time across the
  cluster. The screen has a "Test connection" button: the server writes and reads a probe object, the
  admin's browser loads it from the public URL, and the server deletes it; credentials are write-only (only a four-character hint is ever returned). With offload
  on, backend nodes no longer need a shared uploads directory for media. Private media stays on local
  disk. See `documentation/media-storage.md`.
- **AI agents can work on a site through a built-in MCP server, with the plugin permission model.**
  `POST /api/v1/mcp` speaks the Model Context Protocol (Streamable HTTP, stateless, JSON responses, via the
  official `@modelcontextprotocol/sdk`), so Claude Code, Claude Desktop and other MCP clients can list,
  search and read content, create and edit drafts, submit them for review, publish, upload media, create
  categories and tags, moderate comments and read the site's public identity. Each client authenticates
  with a dedicated **agent connection** token (`Bearer wja_…`) bound to one user. The connection
  **requests** capabilities (`content:read`, `content:draft`, `content:publish`, `media:upload`,
  `taxonomy:write`, `comments:moderate`, `settings:read`) and an **administrator grants** a subset; every
  call then runs as the bound user with its capabilities narrowed to the grant, so an agent can never do
  more than its user (a contributor's agent granted `content:publish` still cannot publish) and no grant
  reaches deletion, users, roles, plugins, themes, settings writes, tokens or backups. Tools run through
  the REST router in-process, so every REST rule, hook and audit row applies; new content is always a
  draft; site content returned to the model is labelled untrusted data. Agent tokens are refused by the
  REST API and `/mcp` refuses API tokens and session cookies. A new admin screen, **AI agents**
  (`/admin/agents`), creates connections, reviews and grants requested capabilities (showing grants the
  user cannot exercise as inert), revokes them, shows each agent's audit trail and copies ready-made
  client configuration. New audit actions: `agent.create`, `agent.grant`, `agent.revoke`, `agent.write`
  (every agent write, success or refusal) and `agent.denied`. Rate limits: 240 requests/min per agent
  token, plus 120 tool calls and 30 writes per minute per agent. New routes `GET/POST /api/v1/agents`,
  `PUT /api/v1/agents/:id/grant`, `DELETE /api/v1/agents/:id`, `GET /api/v1/agents/:id/audit`; migration
  `0016_create_agent_connections`. A password change/reset or account deletion revokes the user's agent
  connections, and agent tokens follow the MFA policy's `enforceForApiTokens` like API tokens. See
  `documentation/ai-agents.md`.
- **An AI provider layer, with editor suggestions and an `ai:use` plugin permission.** Administrators
  connect a provider under **Settings → AI** (`/admin/settings/ai`): **Anthropic** (Claude — default model
  `claude-sonnet-5-5`, also `claude-haiku-5-5` and `claude-opus-5-5`, through the official
  `@anthropic-ai/sdk`) or any **OpenAI-compatible** server (OpenAI, Ollama, LM Studio, vLLM…; https unless
  loopback), with a connection test. The API key is write-only: no route returns it (the screen shows
  only that one is stored and its last four characters), it is never logged or audited, and plugins can
  neither read it nor redirect the provider (`ai_provider` and `ai_provider_api_key` are protected
  options). The editor gets **Suggest with AI** under a post's or page's excerpt and meta description
  (it reads the live canvas, unsaved edits included) and under an image's alt text in the media library
  (the image is read server-side behind the same rule as editing it and downscaled before it leaves the
  site). A suggestion is only ever shown — Use / Try again / Dismiss — and nothing is saved until the user
  accepts it; the material is sent as data the model is told not to obey, and the answer is reduced to a
  single line of plain text with a length cap. Plugins get `wordjs.ai.complete({ prompt, system?,
  maxTokens? })` → `{ text, model }`, gated on the new `ai:use` permission that a manifest requests and
  an administrator grants (30 calls/minute per plugin). New routes `GET /api/v1/ai/status`,
  `GET`/`PUT /api/v1/ai/settings`, `POST /api/v1/ai/test` and `POST /api/v1/ai/suggest` (20/minute per
  user); new audit action `ai.settings.update`. See `documentation/ai-provider.md`.
- **Multisite, phase 1: one install can serve a network of sites.** Off unless turned on with
  `npm run network -- enable --admin <login>`; a single-site install keeps the same database, files,
  URLs, cache keys and tokens. Once on, the existing install is site 1, the main site, and network
  administrators (listed administrators of the main site) create, suspend and resume sites from
  **Admin → Network**. Each site has its own main address, its own SQLite database and its own uploads
  under `<data dir>/sites/<id>/`, and its own users, roles, sessions, settings, menus and theme choice.
  A request belongs to the site whose address it was sent to (an unknown address is still a 421); one
  site's sessions and API tokens are refused on every other (a per-site signing key and a site claim),
  in-process caches, cache keys, purge tags and the frontend's Data Cache and Full Route Cache are kept
  per site, and work that loses track of its site fails instead of touching the main site. Phase 1 needs
  the `sqlite-native` driver and one backend host; plugins, theme server code, backups, certificates and
  real-time collaboration stay on the main site. The design, the isolation guarantees and the next
  phases are in `documentation/multisite-design.md`; running a network is in
  `documentation/multisite.md`.
- **Multisite, phase 2: plugins and theme code run per site.** Plugin code stays network-wide (installed,
  updated and deleted on the main site), but every site can now activate plugins and grant them
  permissions on its own. A network administrator first **offers** a plugin to the sites from
  **Admin → Network → Plugins for the sites**, choosing a grant ceiling; a site administrator can never
  grant beyond it (`403 plugin_grant_beyond_ceiling`), and lowering it takes effect at once. Each site
  runs its **own sandboxed worker** of each plugin it activates, keyed by site: its routes, hooks,
  shortcodes, scheduled events, notification transports and mail provider answer only for that site, its
  bridge calls read and write only that site's database, and its private storage is that site's. On
  Postgres and MySQL the per-plugin database principal is per site too. Each site also runs its own
  theme server code (`functions.js`). New isolation tests prove guarantees I5 (a plugin active on one site
  cannot act on another) and I8 (the ceiling). See `documentation/multisite.md`.

### Changed

- **The WordPress import API downloads attachments by default, like the importer and the admin screen.**
  A `POST /api/v1/import/wordpress` that sent neither `media` nor the legacy `importAttachments` switch
  used to skip every attachment, while the core importer and the admin screen both default to
  `download`. The route now uses `download` too; `media=skip` and `importAttachments=0` still opt out, and
  `importAttachments=1` still means `download`. The OpenAPI description documents the default.
- **Backend log lines go through per-module structured loggers instead of `console`.** A new
  `core/module-logger` gives each backend module `moduleLogger('<dir>/<file>')`: every line carries a
  `mod` field and, inside a request, the request's `requestId`; errors are logged as `{ err }` instead
  of being pasted into the message; values such as a slug, a table or a path travel as fields; and the
  message keeps its wording, so existing greps still match. Message text still goes through the same
  credential scrub the console bridge applies, and `err` is now serialized by allow-list (type, message,
  stack, `code`/`errno`/`syscall`/`status`/`statusCode`, `cause`), so an HTTP-client error can no
  longer carry its request headers into the log. All of `backend/src` is migrated except an explicit
  allowlist — the modules loaded inside the isolated plugin child (their output is still captured and
  slug-tagged by the host), `config/app` and the two first-boot banners — and
  `src/tests/no-console-in-backend.test.ts` fails on any new `console.*` call outside it. The
  development-only per-request line (`NODE_ENV=development`) is now `debug`: the access log already
  records every request at `info`. See `documentation/observability.md`.

### Fixed

- **mail-server 3.0.1: findings from a production-like lab.** A fresh install now loads the plugin
  grants and egress policy right after setup, so a network-granted plugin is not deny-all until the next
  restart. Unknown recipients are refused at `RCPT TO` (`550 5.1.1` / `5.7.1`) instead of being accepted
  and dropped. Quota usage between refreshes counts attachment bytes. An MX that refuses STARTTLS with a
  reply (e.g. `454`) gets one plaintext retry, as opportunistic TLS does everywhere; a failed handshake
  still never downgrades. Forwarding keeps the original attachments (only those of a message the user may
  read). Received HTML keeps an allowlist of safe inline styles. The DNSBL check works inside the sandbox
  through the host DNS bridge. The Bayesian filter needs real evidence before it files mail as spam. Plus
  webmail and server-console polish: scrolling tab bars, address entry, translations.
- **mail-server: vacation auto-replies go out with a null return path (RFC 3834).** The envelope sender
  is `MAIL FROM:<>` on the direct and relay paths, and the retry queue keeps it, so an auto-reply that
  cannot be delivered is dropped by the remote MTA instead of bouncing back into the user's inbox. The
  header From, DKIM and `Auto-Submitted` are unchanged; normal sends and forwards keep their sender.

- **`GET /api/v1/pages` answered `404 rest_post_invalid_id`.** The alias forced `type=page` but handed the request to the posts router with its URL still `/pages`, so it matched the single-post route instead of the list. It now reaches the list route and behaves as documented: the same filters, authorization, `X-WP-Total`/`X-WP-TotalPages` headers and refusal of repeated scalars as `GET /posts`, with any caller-supplied `type` overwritten.
- **Opening a post or page in the editor no longer crashes or blanks the canvas when live collaboration
  is on.** A record with no saved editor document (an imported or legacy post, one created through the
  API, or the demo posts of a fresh install) joined the collaboration room, whose snapshot for it is
  `{}`. The room's welcome then replaced the locally seeded document: the canvas, title, slug and
  excerpt opened empty, and every field edit threw `Cannot read properties of undefined (reading
  'length')`. The Verso store now always publishes `content` as an array (a document whose `content`
  key is absent is published as `[]`; a corrupt one is still passed through untouched), and an editor
  whose record has no saved document stays out of the room until it has been saved once. Records that
  already have a saved document collaborate as before.
- **A refused upload answers with a 4xx and its reason instead of a 500.** An SVG uploaded by a
  non-administrator, a file type or extension the media library does not take, a non-zip plugin or theme
  package, a WordPress import that is not a WXR file, and a file over the upload size limit all reached the
  error handler without a status and were answered `500 rest_internal_error` with the reason discarded.
  They now answer `403 rest_upload_svg_forbidden`, `415 rest_upload_invalid_type` and
  `413 rest_upload_too_large` (multer's other limits: `400 rest_upload_invalid`), with the message.
- **`comment.created` webhook payloads now carry the comment's id.** The serializer read a field the
  comment model does not have, so `data.id` was always missing.

### Security

- **API tokens and the MFA-by-role policy: a deliberate, visible choice.** Personal API tokens (`wjt_…`)
  stay exempt from the two-factor compliance gate by default, so existing integrations keep working, but
  the trade-off is no longer silent. A user whose role requires 2FA can now create a token only from a
  session that signed in with the second factor, or by confirming a current authenticator or backup
  code when creating it (`mfaCode` on `POST /auth/tokens`; otherwise `403 rest_mfa_step_up_required`, and
  a wrong code is `400 rest_mfa_invalid`). Sessions issued by a two-factor sign-in carry an `amr: ["mfa"]`
  claim, which `/auth/refresh` keeps. Roles outside the policy create tokens exactly as before. The
  `auth.token.create` audit row now records how the second factor was proven (`mfa`: `session`,
  `step_up` or `not_required`), a failed step-up writes `auth.token.create_refused`, and policy changes
  write `auth.mfa.policy_update`. `GET /auth/mfa/policy` also returns `tokenExposure`: how many active
  tokens belong to users in a required role, and how many of their owners have not enrolled. The
  Security screen shows a notice with those numbers while the policy requires 2FA and tokens are
  exempt, and explains the "Also enforce for personal API tokens" switch. The API tokens screen asks for
  the code when it is needed.
- **New installs hold API tokens to the MFA policy by default; upgraded sites keep them exempt.** On a site
  created by the install wizard, the first time an administrator requires 2FA for a role the "Also enforce
  for personal API tokens" switch is on (pre-checked on the Security screen, and the default when
  `PUT /auth/mfa/policy` omits the field); the administrator can still turn it off. A site upgraded from an
  earlier version keeps it off, even on its first policy save after the upgrade, so no existing token
  starts failing. `GET /auth/mfa/policy` reports this as `enforceForApiTokensDefault`.

## [2.5.0] - 2026-10-15

### Added

- **A fresh install opens on a showcase home page, and the default theme (2.1.0) can carry it.** The
  install wizard's starter page used to be a heading, a paragraph and three cards. It is now twelve
  sections built only from core blocks and the interaction engine: an animated hero, marquee ribbons,
  stats, a feature grid, a pinned scroll scene, a swipeable carousel, tabs, a pricing table, the latest
  posts, an FAQ with a working contact form, a call to action and social links. That is 26 interactions,
  within Verso's 30-per-page budget, plus two sample posts and a menu in the header and footer. The
  default theme adds design hooks by element-ID prefix (`gradient`, `outline`, `marquee`, and a Grid
  holding a `carousel…` block becomes a scroll-snap carousel), all honouring `prefers-reduced-motion`. It
  also fixes outline buttons that wore the primary gradient, lets per-block Heading colour and weight
  apply, gives posts without an image a brand gradient, and ships a composed footer. See
  `documentation/themes.md`.

- **Plugins can ship a public portal page at `/portal/<slug>`.** A plugin declares
  `frontend.portalPage { entry, slug, title?, themeColor?, viewportFit? }` in its manifest and gets a
  standalone page — no theme chrome, no admin shell — for people who are not WordJS users (coordinators,
  vendors, a field team opening a QR link); the query string and hash reach the plugin's component
  untouched, and so do sub-paths (`/portal/<slug>/a/b` arrives as `path: ["a", "b"]`). It works like the
  other frontend entries: `browser:script` is required, `build-plugin.js`
  compiles `dist/portal.bundle.js` and its Tailwind classes into `dist/portal.bundle.css`, a plugin present
  at build time is compiled in (`frontend/scripts/generate-portal-plugin-registry.js`, wired into
  `predev`/`prebuild`, CI and the release build) and one installed at runtime is loaded from its bundle.
  The new anonymous `GET /api/v1/plugins/:slug/portal` tells the frontend whether an active, granted
  plugin serves the portal (otherwise the page is a real `404`) and returns only its optional head details;
  it and `GET /api/v1/plugins/:slug/bundle{,/css}?type=portal` resolve the **portal** slug alone and
  answer every refusal with the same `404`. Upload and activation refuse a malformed declaration or a
  portal slug another installed plugin already declares. Portal pages get `ModalProvider`,
  `I18nProvider` and `ToastProvider`, are always `noindex`, and plugin bundles may now import
  `@/lib/csrf`. A static route under `frontend/src/app/portal/` (today `/portal/conference`) keeps
  precedence. See `documentation/plugins.md` §10.6.

### Changed

- **Verso editor UX pass.** At 1280–1366 px with both panels open, the "Desktop" viewport rendered the
  site's mobile layout; the chosen device now renders at its real width, scaled. The block action bar
  keeps its real size inside the scaled canvas and gains *select parent*. The inspector shows a
  selection path (Page › Columns › Heading) and readable, translated labels for unlabelled fields.
  Backspace deletes a block, Esc selects the parent, and `?` opens a shortcuts dialog. The structure
  tree collapses and follows the canvas selection. Leaving with unsaved changes now asks first instead
  of discarding them. Publishing a draft works from 1280 px laptops. The motion dock can save a block's
  motion as a preset, groups presets by trigger and switches to tabs below 760 px. On touch screens a
  swipe scrolls instead of dragging the block; a block drags only after a still long-press.

- **The Verso inspector is translated into English and Portuguese.** About 245 field labels, hints and
  option labels of the core blocks and the page settings had only a Spanish text, so English and
  Portuguese editors saw a Spanish inspector. A test now fails when a core block field has no entry in
  the editor dictionary.

- **Dependencies.** multer 2.4 (the 1.x line carries denial-of-service advisories), dotenv 18 in the
  backend and the gateway, c8 12, qrcode-generator 2, and the weekly minor and patch groups for the
  backend and the frontend. Dependabot no longer proposes majors that need Node 22 or newer
  (better-sqlite3 13, dnsbl 6, vitest 5) while the supported floor is Node 20.9, nor TypeScript 7, which
  `@typescript-eslint` 8 cannot install alongside. Their minor and patch updates still arrive.

- **The backend CI runs its unit suite in four parallel shards.** The suite (~310 files, run one file at
  a time on purpose) took ~16 of the Backend job's ~18 minutes, and the coverage ratchet ran it again
  under c8 for 20-28 minutes. Both now split the files four ways with `node --test --test-shard=k/4`:
  `backend-test` runs the plain suite, `backend-coverage-shard` runs it with `NODE_V8_COVERAGE` and
  uploads the raw profiles, and `backend-coverage` merges all four with `c8 report` and applies the
  same floor as `test:coverage:check` (`npm run test:coverage:report`; a test fails if the two scripts'
  options ever differ). Lint, build, the F0-F6 gates, perf:f0, the integration suite and the marketplace
  check run once, in `backend-gates`. The required checks keep their names: **Backend (typecheck +
  test)** and **Backend coverage (c8 ratchet)** are now aggregate jobs that fail unless every job they
  depend on succeeded. `scripts/test-with-flake-retry.mjs` moves `--flag=value` arguments in front of
  the file patterns, because `npm test -- --test-shard=1/4` appended the flag after the glob, where
  `node --test` reads it as one more file pattern and runs the whole suite.

- **YouTube Videos (1.0.3) takes its keyless list from the channel's RSS feed only.** Without a Data API
  key the plugin first tried to scrape the channel's public Videos tab and fell back to the RSS feed when
  that failed. On YouTube's current markup the scraper finds no videos, so every keyless site has been
  showing the RSS feed all along: the latest 15 uploads, live streams included, with their publication
  dates. The scraper is removed, and those sites keep showing the same list. A keyless `@handle` is still
  resolved by reading the channel's page. For the full upload history (up to 500 videos), add a Data API
  key.

### Fixed

- **A split install registers its frontend without a restart.** `npm start` starts the frontend before
  the install wizard writes any config or certificate. The frontend read both once, at boot, so it kept
  sending its gateway registration to the public port without an identity (a 405 in the log every 5
  seconds, for as long as the process ran) and never joined the gateway's registry; pages kept loading
  only through the gateway's pre-install route until the frontend was restarted. It now re-reads them
  on every attempt, waits for the certificate instead of sending requests that cannot succeed, and
  registers in the scheme its server actually listens with (plain HTTP on loopback until its first
  restart, HTTPS with mutual TLS after). The gateway replaces a node's earlier registration at the same
  host and port in the other scheme, so the persisted plain-HTTP entry cannot outlive that restart.

- **The confirm and alert dialogs speak the admin's language.** The host dialog that core pages and
  plugin admin pages open through `useModal()` had English buttons and titles next to a Spanish message,
  and the unsaved-changes guard was entirely English. Labels now follow the language the admin chose
  (es/en/pt), with or without an `I18nProvider` above the dialog, and `confirm()` / `alert()` accept
  optional custom labels.

- **Public-site interface strings follow the site language.** The motion pause control and the Form
  block's empty option, sending state and default submit, success and error texts were hard-coded in
  Spanish, so English sites showed them to visitors. They now follow `WPLANG` (es/en/pt, English when
  unset). Text the author wrote in a form is never changed, and Spanish sites render as before.

- **YouTube Videos (1.0.2) shows the configured channel, not one it links to.** Without a Data API key,
  an `@handle` was resolved by reading the channel's public page and taking the first `"channelId"` on
  it. A channel page also carries the ids of other channels (featured channels, shelves, subscribe
  buttons), and the first one is often one of those, so the block silently listed another channel's
  videos. The plugin now reads only signals that describe the page itself, most authoritative first:
  the canonical `…/channel/UC…` link, the channel metadata's `externalId`, `<meta itemprop="identifier">`,
  then the channel header and the browse id of the tab the page opened. A page that carries none of them
  is refused with an error on the plugin's admin page instead of being guessed at. UC ids, channel URLs
  and handles resolved through the Data API work as before.
- **A Columns block with a gap no longer runs past its container.** Each column was a percentage of
  the whole block (`54% 46%`), so the gap came on top and the last column ended one gap past the
  block's right edge — on a full-width section, horizontal page scroll. Every Columns block with a gap
  did this, the default gap (`--wjs-lg`, 24px) and the Columns in theme templates included. Columns are
  now proportional tracks (`minmax(0, 0.54fr) minmax(0, 0.46fr)`) that share the width left after the
  gaps, in the ratio set in the editor. A block with a gap of 0 renders exactly as before, widths that
  add up to less than 100 still leave the rest of the row empty, and below 768px the columns still stack.

- **Network-granted isolated plugins lost all network on Node 25.** Node 25 extended its permission
  model to the network: with `--permission` on, every DNS lookup, connect, listen and UDP send is refused
  with `ERR_ACCESS_DENIED` unless the process is started with `--allow-net`. The isolate launcher never
  passed that flag (on Node 20–24 it is a bad option that aborts the child), so a plugin holding the
  network grant failed every outbound call, allowlisted hosts included (for example
  `getaddrinfo ERR_ACCESS_DENIED www.youtube.com` from youtube-videos). The launcher now probes once
  whether this Node gates the network and which flags restore it, and adds `--allow-net` only for a
  plugin that holds the network grant; plugins without it keep zero network. The flag takes no host list,
  so the egress guard is still what decides which hosts a granted plugin may reach. The production Docker
  image (Node 22) was not affected.

## [2.4.0] - 2026-10-12

### Security

- **An anonymous caller can no longer tell which plugins are installed, or in which version.** The
  static `/plugins/<slug>/…` mount answered for every *installed* plugin, active or not:
  `/plugins/<slug>/manifest.json` handed out its name, exact version, author, requested permissions and
  dependencies — the inventory an attacker matches against known-vulnerable releases, deactivated plugins
  included — and `client/admin/admin.css`, `dist/component.bundle.css` and `public/**` confirmed a slug
  was on disk. A slug→folder rewrite in front of the mount also resolved the admin-page slug of an
  inactive plugin, and did measurably more work for an unknown slug than for an installed one. The bundle
  routes had the same oracle in another shape: an unknown slug got a `200` empty stylesheet from
  `/bundle/css` and a build hint from `/bundle` where an inactive plugin got a `404`, and
  `/bundle/manifest` passed `dist/manifest.build.json` through whole, exact `version` included. Now the
  static mount serves a plugin's files only while it is **active** — `public/**` while active,
  `dist/component.bundle.css` only while active and granted `browser:script` (the gate of the bundle
  it belongs to, revalidated on every load) — and never serves `manifest.json` or
  `client/admin/admin.css`; it is addressed by plugin folder only. The bundle routes resolve a slug
  among active plugins only, answer "not installed", "inactive" and "not granted" with one identical
  `404`, and `/bundle/manifest` returns only `{ bundles }`. A refusal never reads the refused plugin's
  folder. The generated plugin admin page reads its styling from two new authenticated
  routes, `GET /api/v1/plugins/:slug/admin-style` (only the manifest's `style` and `theme`, never the
  manifest) and `GET /api/v1/plugins/:slug/admin-style/css` (`Cache-Control: private, no-cache`), for
  any signed-in user and an active plugin; anonymous callers get `401` before the slug is looked at.
  Which plugins are *active* stays public (`GET /plugins/active`), because the public site needs it.
  **Upgrade:** rebuild the frontend so the regenerated `/admin/plugin/<slug>` page uses the admin-style
  routes (a self-built image without the rebuild renders plugin admin pages unstyled). Anything that
  linked `/plugins/<slug>/manifest.json` or `/plugins/<slug>/client/admin/admin.css`, or addressed plugin
  files by admin-page slug instead of folder, now gets a `404`. A cache that already holds a deactivated
  plugin's `public/` asset may keep serving it for up to an hour (`max-age=3600`).
- **The plugin sandbox works when WordJS runs as a non-root user that holds a capability.** A service
  started with `AmbientCapabilities=CAP_NET_BIND_SERVICE` (to listen on 443 without root) ended with the
  sandbox `degraded` and every plugin refused: the Landlock/seccomp shim treated any capability as root
  and called `setgroups`, `PR_SET_SECUREBITS` and `PR_CAPBSET_DROP`, which need `CAP_SETGID`/`CAP_SETPCAP`
  (`SHIM-FAIL: setgroups(clear): Operation not permitted`). Each privilege-drop step now runs only when the
  process holds the capability it needs: the ambient set is cleared and the permitted, effective and
  inheritable sets are emptied in every case, groups, securebits and the bounding set when they can be,
  and a setuid-root wrapper's real/saved uids are collapsed. The result is verified (inheritable,
  permitted, effective and ambient empty; the bounding set only when it was dropped — `no_new_privs`
  means a plugin can gain nothing across `exec`). The same change fixes root services with a reduced
  bounding set (`CapabilityBoundingSet=` in the unit). The shim's read grants no longer include
  `/etc/ssl/private`.
- **The cause is reported, not just the symptom.** When the node process itself holds capabilities or a
  root uid, the boot log and `GET /api/v1/health/details` (`sandbox.hostPrivilege`) say where they come
  from (root, an ambient capability, file capabilities on the node binary, a setuid-root wrapper) and how
  to remove them. Activating, reloading or updating a plugin the sandbox refuses to launch now answers
  `409 sandbox_unavailable` with the mechanism, its state, the failure line and the operator action
  (paths redacted) instead of a generic 500, and the admin plugins screen shows it; a plugin refused at
  boot is listed as `refused`.
- **`create-wordjs` no longer recommends `setcap cap_net_bind_service=+ep` on node** (it hands that
  capability to every node script on the machine and is lost on each node upgrade). For ports below 1024
  it recommends `net.ipv4.ip_unprivileged_port_start` in `/etc/sysctl.d/` or a reverse proxy. The new
  `--systemd` option (with `--port` and `--service-user`) writes a systemd unit for a dedicated user with
  no capabilities, `NoNewPrivileges=yes` and `NODE_ENV=production` into a private temporary directory and
  prints the root-owned install steps. mail-server 2.2.5 explains a port-25 bind failure accurately
  (permission vs. the sandbox) instead of suggesting `setcap`.
- **`create-wordjs` no longer installs world-writable files.** Extraction went through adm-zip's
  `extractAllTo`, which ends each file with `chmod(path, attr || 0o666)` — and `chmod` ignores the umask —
  so every installed file, code that may later run as root, was writable by any local user, and
  `upgrade` turned an existing `0644` install into `0666` as well. Files are now written one by one as
  `0644` (`0755` when the archive marks them executable), an upgrade tightens an existing file before
  writing into it, and it refuses to write through a symbolic link planted in the existing install.
  Installs made by earlier versions keep their `0666` files until the next `create-wordjs upgrade`, or
  `find <site> -type f -perm -o+w -exec chmod go-w {} +`.
- **Handlebars 4.7.10 for the advisories published against 4.0.0–4.7.9.** The CI audit gate blocked every
  pull request on GHSA-8r5x-fm3f-whwj and GHSA-p8wg-vrv2-v86f (critical: JavaScript injection through
  `compile`) and GHSA-xw65-4hp5-5hc7 (medium: precompiled templates embedded inline). The backend's
  `handlebars` range is now `^4.7.10`.
- **Next.js 16.3.8 for the advisories published against 16.0.0–16.3.7.** The CI audit gate blocked every
  pull request on GHSA-cjq9-62q9-8jv4 (high: server-side request forgery in Image Optimization). The same
  release fixes cache poisoning of SSG/ISR pages in self-hosted applications (GHSA-4jqv-mc3x-m676,
  GHSA-mcj8-r9mp-w47p), Draft Mode content leaking through a pending `use cache` fill (GHSA-3w37-wq28-93x7),
  metadata image routes bypassing `dynamicParams` (GHSA-f87g-xv8r-7p7x) and the development server's MCP
  endpoint disclosing information (GHSA-39w2-rjm5-chcv). `next` and `eslint-config-next` are pinned to the
  16.3.8 patch in the lockfile, not the 16.4 minor that the range would also allow.
- **`create-wordjs` verifies the release ZIP before extracting it.** The release workflow now publishes
  `wordjs-<tag>.zip.sha256` (`sha256sum` format) next to every tag-named bundle, and `create-wordjs` —
  create, `upgrade`, `gateway` and `join` — downloads it and refuses a ZIP whose SHA-256 differs.
  Releases published before the checksum asset existed still install, with a warning that the download
  was not verified. A new `--sha256 <hex>` option pins a checksum for `--zip` sources (and is checked on
  top of the release checksum when both apply). `--zip` URLs must now be `https://`: plain `http://` and
  other schemes are refused, and a redirect to a non-https URL is never followed. Local file paths are
  unchanged.
- **`create-wordjs` vets every ZIP entry before extracting any.** An archive containing an absolute path
  (POSIX, drive letter or UNC), a `..` segment, an entry that resolves outside the target directory, or a
  symbolic-link entry is refused as a whole, instead of relying on adm-zip silently rewriting such names.
- **Separate-mode enrollment no longer trusts on first use.** `scripts/node-join.js` and
  `create-wordjs join` now require `--ca-hash`, and the pin is enforced **before** the join token is sent:
  the gateway's enroll listener presents the cluster CA in its TLS chain, the node accepts it only if its
  SHA-256 matches, and the tokened request is made with full TLS verification against that CA and a
  `CN=gateway-internal` server-identity check. Previously the request ran with TLS verification off and
  the fingerprint, when given at all, was compared only after the gateway's response (token, cluster
  secret and signed cert) had already been received — so an on-path attacker relaying the call was not
  stopped even with `--ca-hash`. There is no opt-out: enrolling without a pinned CA is no longer
  possible. **Upgrade the gateway before joining new
  nodes:** a gateway from an earlier release sends no CA in its chain, so a pinned join against it fails
  closed. `create-wordjs gateway` now fails instead of printing join commands with a placeholder
  fingerprint.
- **An API token can no longer create administrators or open registration through the import and
  settings routes.** `POST /users` refused an administrator's `wjt_` token, but the same token could still
  import accounts (`POST /import` with `importUsers`, which also moves an existing account's email when
  `updateExisting` is set, so forgot-password then mails that account's reset link to the caller), set
  `users_can_register` and `default_role: administrator` (`PUT /settings`, `PUT /settings/:key`) so the
  next anonymous sign-up became an administrator, redefine a role (`POST`/`DELETE /roles`), or create an
  account per unmatched author (`POST /import/wordpress`). Each of these is now refused to an API token
  with `403 rest_token_management_forbidden` (`data.params` names the refused fields where the route
  judges fields), through the same check that refuses them to a session started at a secondary address.
  A token can still save the other settings and run a site import without accounts or registration
  changes.
- **An API token can no longer restore, create or download a backup, export the site archive or move the
  database.** `POST /backups/:filename/restore` checked only that the caller was an administrator, so an
  administrator's `wjt_` token could put back an older snapshot: the accounts and roles became the
  snapshot's, and from a full snapshot (the default) so did the passwords, two-factor enrolments, API
  tokens, plugin grants and registration settings. An administrator demoted since then was an
  administrator again, with the password they had then. A restore is now refused to an API token
  (`403 rest_token_management_forbidden`) and to a session started at a secondary address
  (`403 rest_account_bound_session`), like the account import, before anything is read. There is no
  backup upload endpoint, so this was the only way in. The same token could also create and download an
  archive (`POST /backups`, `GET /backups/:filename/download`), which holds the bcrypt password hashes,
  the two-factor seeds stored in clear, the API token hashes and the plugins' secrets with the key files
  that decrypt them — what an interactive login needs; read the site archive (`GET /export`), which
  carries every plugin's own tables, such as a payment plugin's write-only Stripe key; and move the site
  to a database server it named (`POST /db-migration/migrate`), which copies every table there and then
  runs the site on it. All four are now refused to an API token, the migration also to a session started
  at a secondary address. Scheduled backups run in the server's own cron and are not affected; the WXR
  export stays available to tokens. The JSON site archive never contained password hashes: the
  `password` field the export code meant to fill was always absent, and that code has been removed.
- **An API token can no longer give a plugin more than an administrator approved.** A token could add
  any grant through `POST /plugins/:slug/permissions` (`database:write`, `email:provider`, `network`, or
  `browser:script`, which runs the plugin's code in the admin pages with the viewer's session), widen or
  clear the egress allowlist through `POST /plugins/:slug/egress-hosts` (an empty list allows every public
  host), and activate a plugin for the first time through `POST /plugins/:slug/activate`, which grants
  everything its manifest declares and records that as the administrator's decision. Each of these is
  now refused to an API token with `403 rest_token_management_forbidden`, `data.params` naming what
  would have been added, and nothing is written. A token can still revoke grants and narrow the egress
  list, install and update plugins, and deactivate and re-activate a plugin whose grants an
  administrator decided (a revoke of every grant included: it starts with nothing granted), so a headless
  deploy needs one interactive activation per plugin that declares permissions.
  Interactive administrators are not affected. On a multi-node install the check compared the token's
  request with the copy of the grants and allowlists a node keeps in memory, which a revoke made through
  another node does not reach, so a token could save a grant again that an administrator had just revoked
  elsewhere. A token's write to the grants or the allowlist is now decided on the stored record, read at
  the moment of the write, and written only if the record has not changed since — also when there was no
  record yet, where the first write used to overwrite whatever another node had stored in between. A
  token's activation starts the plugin with the stored grants and the stored egress allowlist (the child
  was still given that node's copy of the list). Everything else on a node — the bridge's per-call
  checks, a reload, the admin screens — reads its copy, which the policy re-sync brings up to date
  within about 10 seconds (see `documentation/multi-node.md`).
- **Updating a plugin no longer brings back a revoked grant or a wider egress list.** An in-place update
  (`POST /marketplace/update`, or `/marketplace/install` on an installed plugin) cleared the plugin's
  stored grants and egress allowlist and wrote back the copy the node serving the request kept in memory.
  On a multi-node install that copy does not see a revoke made through another node, so an update served
  by such a node granted the revoked permission again and replaced a narrowed allowlist with that node's
  list — an empty one allows every public host. A failed update's rollback did the same. An update now
  leaves both records as they are stored and reactivates the plugin with them. The one write it still
  makes is an empty grant record for a plugin that has none, stored before anything moves and only if no
  record appeared meanwhile: every boot grants an active plugin with no record whatever its manifest —
  after an update, the new version's — declares, so without that record a token could activate a plugin
  that declared nothing, update it to a version declaring `network` and `database:write`, and have both
  granted at the next restart. No administrator decision is recorded with that empty record, so a plugin that was never
  activated still gets what it declares when an administrator first activates it. The boot step that grants an
  active plugin with no grant record what its manifest declares now decides "no record" on the stored row,
  under the plugin-policy lock, and writes nothing while the grants cannot be read: a record stored in the
  meantime (an administrator's decision made through another node, an update's empty record) is kept, and
  a database error at boot no longer turns a partial revoke back into everything the manifest declares.
- **The database cleanup no longer deletes the database the site is running on.**
  `POST /db-migration/cleanup` accepted any of its three file names without checking which database was
  in use, so `{"file": "wordjs-native.db"}` deleted the live default SQLite file with its `-wal` and `-shm`
  (Windows usually refuses to delete a file SQLite holds open; other systems do not), and an
  administrator's API token could send it. When the native SQLite driver falls back to the pure-JS one,
  which reads the same file, the migration screen even listed the live file for cleanup. The cleanup now
  refuses (`409 db_cleanup_active_database`) any file of the database in use — the configured file and
  its `-wal`, `-shm` and `-journal`, however a symlink, a junction or (on Windows and macOS) letter case
  spells them — and, like the migration, is refused to an API token and to a session started at a
  secondary address. A migration whose SQLite target file is the database in use (a `dbPath` pinned to
  the other driver's default name) is refused the same way (`409 db_migration_target_is_active`) before
  anything is read or written. Leftover files are still removed, now with their `-journal` too.
- **Registration settings are recognised under every spelling MySQL treats as the same name.** On MySQL
  and MariaDB option names are compared without regard to case, but the check that refuses a change to
  who may register compared them exactly, so a site import from an API token or from a session started
  at a secondary address carrying `REQUIRE_EMAIL_VERIFICATION: "0"` or `MAIL_DELIVERY_READY: "0"` wrote
  the real setting and turned email verification off. The check now compares names the way the
  database does, for `POST /import`, `PUT /settings` and `PUT /settings/:key` alike. (`users_can_register`
  and `default_role` were already protected from the import under every spelling.)
- **The plugin asset list can no longer be held by a shared cache.** `GET /api/v1/plugins/assets` was sent
  `Cache-Control: public, max-age=60`, so a cache in front of the API could keep emitting a deactivated or
  revoked plugin's `<script>` for a minute that no purge reached. It is now `private, no-cache`; the
  public site's own cached copy is purged on every change, as before.
- **Entries of a post type the site does not know are no longer public.** Read checks fell back to the
  public `post` rules for a type missing from the registry, so published entries of types a WordPress
  import brought in (contact-form submission stores, shop coupons), of a non-public custom type an
  administrator deleted, or of any custom type during the first moments after a restart were served to
  anonymous callers by `GET /posts?type=`, `GET /posts/:id`, `GET /posts/slug/:slug` and the public site,
  and their comments by `GET /comments`. Such entries are now readable only by their author and by users
  who can edit or read others' posts. Built-in types keep their rules while the registry loads, and the
  public comment list now filters on the types that are public instead of excluding the ones that are not.
  `GET /seo/meta/:postId` applies the same read check, so a contributor no longer reads the published
  entries of a non-public type there. The same rule covers what hangs off such an entry: its attachments
  are no longer visible to anonymous callers on `GET /media/:id`, in the media list or in its totals, and
  a published translation sibling of an unknown type is no longer named to every reader of a public post.
- **Changing your email no longer reveals whether another account uses an address.** `PUT /users/me` (and
  a self-edit through `PUT /users/:id`) checked whether the address was taken before checking the current
  password, so without the password a taken address answered `400 rest_invalid_email` and a free one
  `403 rest_bad_current_password`. The address is now looked up only after the password is confirmed; a
  malformed address is still refused first.
- **Per-client limits count an IPv6 /64 as one client.** The login throttle, the API, collaboration,
  analytics, auth, failed-login, upload, forms, setup and comment rate limits, the password-confirmation
  in-flight limit and the `clientKey` plugin routes receive were keyed on the full address, so a client
  holding an IPv6 /64 got a fresh limit per address.
  IPv6 addresses are now grouped by /64; IPv4 addresses, including IPv4-mapped IPv6 addresses, stay per
  address. The plugin `clientKey` is now keyed with the site's secret as intended, so it no longer changes
  on every restart or differs between nodes.
- **`settings:write` no longer lets a plugin put its own script on every public page.** The enqueue
  registry is an ordinary option (`plugin_assets`) that the options bridge did not protect, so a plugin
  granted `settings:write` but not `assets:write` could write its own `public/*.js` into it and have it
  emitted as a `<script src>` on every public page, which share the admin app's origin. The bridge now
  refuses the name, and `GET /api/v1/plugins/assets` only emits the entries of plugins that hold
  `assets:write` at the time of the request, so revoking the grant also takes the tags off. A change to
  the registry, the grants or the active plugins now also purges the public site's cached copy of that
  list, which otherwise kept a revoked script on already-rendered pages for up to two minutes. The same
  protection now covers the announcement bar (`site_chrome_announcement`, written only through
  `PUT /api/v1/chrome/announcement` like the header and footer) and the custom content-type and taxonomy
  registries (`custom_post_types`, `custom_content_schemas`, `custom_taxonomies`), which decide at boot
  who may read and edit each type.
- **A plugin can no longer replay the `browser:script` upgrade to undo revocations.** The one-time step
  that grants `browser:script` to plugins that were already active recorded completion in an unprotected
  option, so a plugin with `settings:write` could clear it and the next boot granted `browser:script`
  again to every active plugin with browser code, its own included. Completion is now recorded inside the
  grant store, which only a writer that can already change every grant can reset, and the old option is
  refused to the bridge (where it already exists it still counts as done). On a site installed through
  the setup wizard the step had never run, so it first ran at the first restart after real use and
  granted `browser:script` back to plugins the administrator had revoked it from. The installer now
  records the step as done on the site it creates, and the step never changes a plugin whose permissions
  an administrator has set (on activation or on the permissions screen).
- **Protected option names are protected under every spelling the database treats as the same.** On
  MySQL and MariaDB the options table compares names case-, accent- and invisible-character-insensitively
  and ignores trailing spaces, while the options bridge compared them byte for byte, so `plugin_grants `,
  `plugin_grànts` or `plugin_grants` followed by a zero-width space reached the protected row. Any name
  outside printable ASCII, or with a leading or trailing space, is now refused by the bridge, the theme
  backstop and the site import. The theme backstop now uses the bridge's own list instead of a copy that
  had fallen behind it.
- **`GET /posts?type=` authorizes the rows it returns on MySQL.** The list chose its read policy by an
  exact lookup of the requested type while MySQL matched `post_type` without regard to case, accents or
  trailing spaces, so `?type=INVOICE` found no registered type, applied the public `post` policy and
  returned a non-public type's published entries to anyone (and every status of them to an editor
  without that type's capabilities), and `?type=nav_menu_item%20` listed menu items. A `type` must now be
  spelled the way registered names are (lowercase letters, digits, `_` and `-`), on the list and on
  `GET /posts/slug/:slug`, or the request is `400 rest_invalid_post_type`. The WordPress importer skips
  items whose type is spelled any other way, which kept `Revision` or `NAV_MENU_ITEM` from becoming
  revisions or menu items on MySQL. Imported statuses had the same problem: the WordPress importer and the
  site import (including a logical backup restore) stored the status as written, so a `Publish` entry was
  unpublished to the read checks while MySQL listed it, with its comments, as published. Imported statuses
  are now folded onto the ones the site writes (`Publish` becomes `publish`); `inherit`, a status added by
  a WordPress plugin, or any other value imports as `draft`, and a trashed item is skipped in any case.
- **Self-registration no longer reveals whether an address has an account, even with a second request.**
  With email verification on, a taken and a free address already got the same `201`, but a free one
  also got an unverified account named after the submitted username. Logging in as that username
  (`403 rest_email_unverified` against `401`) or registering it again (`400` against `201`) told the two
  apart. A registration now creates nothing until its emailed link is followed: it is kept under the hash
  of the link's token, `POST /auth/verify-email` creates the account, and until then no username is taken
  and no account exists. If the name or address was taken in the meantime the link answers
  `409 rest_registration_unavailable`. Links sent by earlier versions (`?uid=…&token=…`) still work. A
  non-string `password` used to answer `201` for a taken address and `500` for a free one; `username`,
  `email`, `password` and `displayName` must now be strings (`400 rest_invalid_param`), and a failure
  after the identity checks is answered with the same `201`.
- **An Author can no longer take over a page's public URL with a post of the same slug.** Slugs were
  unique per post type, but the public site resolves `/<slug>` without a type and tried posts before
  pages, so an Author with no page capability could publish a post `contact` and `/contact`, with its
  menu entry and sitemap line, served the Author's content instead of the page. Slugs written through
  `POST`/`PUT /posts` are now unique across every publicly routed type (the second entry gets
  `contact-2`), and a post and page that already share a slug resolve to the page. The two importers
  keep a source site's per-type slugs, as WordPress does, and re-saving an entry under its current slug
  keeps it. Restoring a revision applies the same rule to the slug it brings back, which used to be
  written as is. For such a pair, `/<category>/<post-slug>` still shows the post and a draft preview
  opened from the editor or the content list shows the entry it was opened for (the preview link now
  carries the type). The legacy backend page renderer, which was not mounted and still looked up posts
  before pages, has been removed.
- **Scheduled and private posts now need the published-post capability.** The edit and delete gates
  applied `edit_published_*` / `delete_published_*` only to `publish`, so a contributor could rewrite
  their own scheduled post after an editor approved it (the unreviewed copy then went live on its own)
  and could mark their own draft `private`. `future` and `private` now carry the same bar on every write
  surface, moving a post into `private` needs the publish capability (`403 rest_cannot_publish`), and
  `POST`/`PUT /posts` accept only `draft`, `pending`, `publish`, `future` and `private` as `status`.
- **Comments follow the readability of their post.** `GET /comments` and `GET /comments/:id` served
  the approved comments of drafts, private, trashed and password-protected posts to anyone, and
  `POST /comments` accepted comments on any existing post, answering differently for missing and
  unreadable ids. Callers without `moderate_comments` now only see and add comments on posts they may
  read, and every refusal is the same `404`. Comment search no longer matches the commenter's email for
  non-moderators.
- **Internal post meta is no longer public.** `GET /posts*` and `GET /posts/:id/meta` returned every
  meta key, including `_wjs_review_comments` (the editorial review thread). Callers who cannot edit the
  post now get unprefixed keys plus `_puck_data`, `_wjs_template` and `_thumbnail_id`.
- **Password-protected posts are no longer served in full.** Posts imported from WordPress keep
  `post_password`, but nothing checked it. For callers who cannot edit the post, responses now carry
  `protected: true` with empty `content`, `excerpt` and `meta._puck_data`, searches do not match them,
  feeds show a placeholder summary and the sitemap omits them. The public theme shows "This content is
  password protected."; unlocking a post with its password is not implemented yet.
- **Shortcode parsing no longer freezes the server on hostile post content.** The matcher was a regex whose
  attribute run had no bound, so every `[tag` without a closing `]` scanned to the end of the document
  before the next one did the same: `"[gallery ".repeat(n)` cost O(n²), about 5 s for 360 KB and 87 s for
  1.4 MB, on every serialization of the post (content and excerpt), from a draft any contributor can
  save. `doShortcode`, `doShortcodeAsync` and `stripShortcodes` now share a single-pass scanner that
  matches exactly the same shortcodes (1.4 MB now takes about 40 ms). Output is rebuilt in one join
  instead of one string copy per shortcode, and at most 2000 shortcodes are processed per document; any
  beyond that are left as written.
- **The anonymous sidebar render endpoint escapes what it outputs.** `GET /api/v1/widgets/sidebars/:id/render`
  is public and returns `text/html` from the API origin, but the Categories and Recent Posts widgets
  and the widget title wrote category names, post titles and slugs into the HTML unescaped. An editor
  could name a category `<img src=x onerror=…>` and get script running for anyone who opened the
  URL, administrators included. All of these values are now escaped, and the response carries
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` and `X-Content-Type-Options: nosniff`.
  Category and tag names are also stripped of HTML tags when created or updated; a name made only of
  markup is rejected with 400. Plugins can no longer filter the rendered sidebar: `dynamic_sidebar` joins
  `wordjs_head`/`wordjs_footer` on the list of raw-HTML hooks denied to every plugin.
- **Widgets added since instance ids became UUIDs render again.** The renderer split
  `<widgetId>-<instanceId>` keys on the last `-`, which cut a UUID in half, so those widgets were
  skipped without error and the sidebar came back empty. Keys are now matched against the registered
  widget ids, so old-style keys, UUID keys and widget ids containing `-` all resolve. The admin widgets
  page labels them the same way.
- **Installed font names and URLs can no longer break out of the server-rendered `<style>`.** The
  `@font-face` builder removed quotes from the family name only. It now removes quotes, backslashes,
  `<`, `>` and control characters from both the family name and the URL.
- **An installed site no longer starts with a JWT secret published in this repository.** With
  `WORDJS_PRESEED_CONFIG=1` and no `WORDJS_JWT_SECRET`, `docker/entrypoint.sh` wrote an *installed* config
  signed with `wordjs-shared-dev-secret-change-me` (the root `docker-compose.yml` set that very value), and
  boot kept it because the site was installed — anyone could sign a session for the bootstrap
  administrator (user id 1). The backend now refuses to start on an installed config whose `jwtSecret` is
  any published placeholder, with instructions to set a real one (it does not rotate it silently, which
  would split replicas). The entrypoint requires `WORDJS_JWT_SECRET` (≥ 64 characters, no default) when
  pre-seeding, and the root compose file refuses to render without it (`openssl rand -hex 64`).
  **Upgrade note:** a volume pre-seeded without the variable needs its `jwtSecret` replaced, the same value
  on every replica. The docs no longer claim the root stack cannot be logged into: its bootstrap `admin`
  password is written to `backend/data/initial-admin-password`.
- **A username can no longer take over another account's email.** Sign-in and password recovery tried an
  identifier as a username before an email, and any string was a valid username, so registering the
  username `boss@gmail.com` broke that account's email sign-in and sent its reset link to the attacker;
  `Boss` and ` boss` also registered beside `boss`. New logins are limited to letters, digits, `.`, `_`, `-`
  (≤ 60 characters), must not collide case-insensitively with any login or email (nor a new email with a
  login), and an identifier containing `@` is now resolved as an email first. Existing accounts are not
  re-validated; importers convert an invalid source login.
- **Transactional emails escape what they interpolate.** The verification and password-reset mails put the
  login and site name into their HTML unescaped, and the Auctions plugin's outbid mail did the same with
  the bidder name and auction title, so markup (a phishing link) could arrive in a message the site sent.
  They now use `escHtml`.
- **`POST /auth/register` no longer reveals whether an email has an account.** It answered "Email already
  exists" / "Username already exists" verbatim. With email verification required, a taken email now gets
  the same 201 as a new one (the owner is notified instead; the body no longer carries `user`); otherwise
  both duplicates get one generic `400 rest_user_exists`. A username's availability, and an email's when
  verification is off, remain observable — see `documentation/security.md`.
- **A sandboxed plugin's hook subscriptions are now gated by the data they expose.** Subscribing to a
  hook makes the host serialize the hook's arguments into the plugin's process, but the isolate
  `register` handler (and the bridge's `hooks.addAction`/`addFilter`) checked only count caps and the
  raw-HTML denylist. A plugin with **zero** grants could therefore subscribe to `wp_insert_comment` and
  receive every commenter's email and IP address, to `notification_sent` and receive every user's
  notifications including reset codes and tokens, and to `wp_insert_post` / `post_updated` and receive
  draft, private and password-protected post bodies. Every hook core fires is now classified in one
  table (`backend/src/core/hook-access.ts`): public hooks (`init`, `activated_plugin`, `switch_theme`,
  `registered_*`) stay open; data hooks require the matching grant — new **`comments:read`**,
  **`comments:pii`**, **`posts:read`** and **`notifications:read`** permissions, and `settings:read`
  for `updated_option`; raw-HTML hooks (now including `dynamic_sidebar`, whose result is served as
  `text/html`), the host-only `admin_menu_items` filter and core cron hooks are denied to every plugin;
  unclassified names in a core namespace (`wp_*`, `wordjs_*`, `core:*`, `comments:*`, …) are refused,
  while a plugin's own hook names keep working. The decision is made host-side at registration and
  again on every delivery, so a revoked grant stops the flow at once. Payloads are minimized at the
  boundary whatever the grants: commenter email, IP and user agent only with `comments:pii`; never a
  post password; protected option values redacted; and `notification_sent` is redacted at the source
  (secret-named `data` keys and link parameters, and the message and link of reset / verification /
  OTP notifications), as `updated_option` already was (audit F-02). A new completeness test fails when
  core fires a hook missing from the table. No first-party plugin subscribes to a gated hook, so no
  manifest changes were needed; a third-party plugin that relied on one must declare the new permission.
  Documented in `documentation/security.md` §5 and §8.1 and `documentation/plugins.md` §10.5.
- **Backend: file-type 21.3.4 (GHSA-5v7r-6r5c-r473, moderate).** Releases before 21.3.1 can loop forever
  on a malformed ASF header, which would hang the event loop from a media upload or a WordPress (WXR)
  attachment import. The 2.3.0 notes said the fixed line requires Node 22; only file-type 22+ does, and
  21.3.1–21.3.4 support Node 20, so the backend moves from 16.5.4 to 21.3.4 without changing the engines
  floor (Node >= 20.9.0). file-type is ESM-only since 17 and the backend compiles to CommonJS, so the new
  `core/file-type-detect.ts` loads its `file-type/core` entry with a real dynamic `import()` (a `require()`
  of an ES module needs Node 20.19). The upload route and the WXR importer keep their existing bounds
  (header-only buffer, ASF skipped, 3 s timeout) as defence in depth. Detection results for the upload
  allowlist are unchanged except two: WAV is now reported as `audio/wav` (16.x said `audio/vnd.wave`, which
  the allowlist refused, so WAV uploads now pass the content check), and a DOCX/XLSX/PPTX head is reported as
  `application/zip` (allowed, and these types do not require a matching signature, so they are still
  accepted). Dependabot keeps file-type on the 21.x line.
- **Accepted, with no fixed release anywhere:**
  - `node-forge` 1.4.0 (GHSA-86w9-cpqp-85rv, high) in the backend, gateway and setup. Every release is
    affected and acme-client 5.4.0 (latest) depends on it. The flaw is in RSA PKCS#1 v1.5 signature
    verification, and WordJS never verifies a signature with node-forge: the cluster CSR check uses Node's
    crypto, and the remaining uses (acme-client's key and CSR helpers, the gateway cluster CA, setup,
    certManager, system-health) only generate keys, sign and parse PEM. It stays under its dated exception
    in `scripts/audit-exceptions.json` (expires 2026-11-05).
  - `braces` 3.0.3 (GHSA-vfj7-8cjw-p6xm, high) in the frontend, reached only through `eslint-config-next` →
    `@next/eslint-plugin-next` → `fast-glob` → `micromatch`. It is a development dependency (lint), not
    shipped or run by the server, and the glob patterns it expands come from the repository's own lint
    configuration, not from input. The latest `@next/eslint-plugin-next` (16.4.0 and canary) still pins
    `fast-glob` 3.3.1, so there is no upgrade or override that removes it.
- **Paid Digital Downloads files could be downloaded by anyone (HIGH).** The bundled `digital-downloads`
  plugin protected a product only by never listing its media-library URL, but the core media API listed
  every unattached item to anonymous callers (`GET /api/v1/media?mime_type=application/zip` returned the
  paid files with their `sourceUrl`) and `/uploads` served them with no authentication and a one-year
  `immutable` cache; a buyer who saw the URL once also kept it past the link's expiry and use limit.
  Fixed with **private media** in core: a media item can be `visibility: "private"`
  (`POST /api/v1/media?visibility=private`, or `PUT /api/v1/media/:id {"visibility":…}`, which moves the
  files). Its files live under `config.uploads.privateDir` (default `data/private-uploads/`, included in
  backups), which nothing serves; the row (`post_status = 'private'`) is excluded from the anonymous media
  list and its `X-WP-Total`, `GET /media/:id` (404), `/posts`, sitemaps, feeds, search and featured-image
  projections. Only a caller who may edit the item sees it, and its bytes are reachable only through the
  authenticated `GET /api/v1/media/:id/file` or a plugin route replying `res.sendPrivateMedia(id)` under the
  new default-deny **`media:private_read`** permission — in both cases streamed by the host as an
  attachment with `no-store`, never through a URL and never over the plugin IPC channel
  (`backend/src/core/private-media.ts`). Public media behaves exactly as before. The admin media library
  gets a "Subir como privado" option, a visibility filter, a private badge and a private/public toggle;
  the content image picker lists public items only.
- **`digital-downloads` 1.1.0: products are private media files streamed per download.** A product now
  references a private media item (selected or uploaded as private from the plugin's admin page); the
  token route re-checks paid + expiry + max-uses and consumes a use on **every** download, then has the
  host stream the file, so no permanent URL is ever revealed. A file the host cannot deliver (no longer
  private, deleted, or grant missing) answers 503 without consuming a use. Products created before 1.1.0
  keep their public `file_url` working, but the admin list and editor flag them as public until their file
  is re-selected as private (re-selecting drops the old URL). The plugin now requests `media:private_read`.
  **Operators: grant it in `/admin/plugins` after updating, re-select every flagged product's file as
  private, and treat files that were public before as already exposed** (re-upload them under a new name
  if that matters — old copies may persist in caches).
- **A post's featured image no longer reveals posts and files its reader may not see (HIGH).**
  `featuredMedia` was resolved from the author-written `_thumbnail_id` meta, which accepts any id, and
  copied the target's title and file URL without checking that the target was an attachment or that the
  reader could see it. A contributor could point a draft at an editor's draft or private post and read
  its title back; an author could publish such a pointer, and every anonymous reader of `GET /posts`,
  `GET /posts/:id` and `GET /posts/slug/:slug` (and the page's `og:image`) received the hidden title, or
  the real `/uploads/…` URL of a file attached to an unpublished entry, which `GET /media/:id` answers 404
  for. Walking ids disclosed every unpublished title. `featuredMedia` is now projected only when the id
  names an attachment this caller could read through `GET /media/:id`: never another post type, never an
  item whose parent entry the caller may not read (next entry), never someone else's private item.
  A private item reaches only a caller who may edit it, and then with its authenticated
  `/api/v1/media/:id/file` route, never an `/uploads` path. Single-post and list responses apply the same
  rule (`backend/src/core/attachment-visibility.ts`). `GET /media/:id` now uses that rule too, so an
  attachment row in another status (a draft created through `POST /posts`) is 404 to anyone who may not
  read it, instead of returning its title to anonymous callers.
- **Attachments of entries the reader may not read are hidden from the media API and `featuredMedia` (HIGH).** An
  attachment inherits its parent entry's visibility, but `GET /media/:id`, the media list and
  `featuredMedia` only asked whether the parent was *published*, never whether the reader may read it. A
  published entry of a `public: false` content type (`GET /posts/:id` → 404 for anonymous callers) — an
  invoice, an order, a members-only record, or a private WordPress type brought in by the WXR importer
  with its attachments — therefore handed every attached file's title and `/uploads/…` URL to anyone:
  `GET /media/:id` answered 200, the anonymous media list listed and counted it, and any public post naming
  it as featured image projected it. The media list kept its own copy of the rule and also skipped it
  outright for any holder of `edit_others_posts`, whatever the parent's type, so an editor listed the
  attachments of entries of a type with its own capability family that they may not read. All three
  surfaces now ask the parent the question `GET /posts/:id` asks, under the parent type's read policy
  (`backend/src/core/attachment-visibility.ts`): an unpublished entry, or a published entry of a
  non-public type, shows its attachments only to its author and to holders of that type's
  `edit_others_*` / `read_private_*` capability; an internal parent (a menu item, a revision) never makes
  an attachment public, also before the type registry has loaded at boot; and a **password-protected**
  entry's attachments are part of what the password protects and reach only a caller who manages the
  entry (its author, or `edit_others_*` for its type) — its featured image is covered by an entry
  below. Unattached items and published public entries are unchanged. The rule governs the item's
  metadata (title, URL, existence); a public file is served at its `/uploads/…` path to whoever has that
  URL, so a file that must stay confidential belongs in private media. The next four entries apply the
  same rule to the media list's totals and searches, private downloads, the generic `/posts` surface and
  an entry's fields.
- **The media list's totals and searches no longer reveal hidden attachments (MEDIUM).** `GET /media`
  applied the parent rule to the fetched page only and subtracted the items hidden on *that* page from a
  total that counted everything, so every other page — a page past the end above all — and every
  `?search=` still counted them: their existence and number, and, through the full-text prefix / substring
  search, their title one character at a time (the title defaults to the uploaded file name, which leads
  to its `/uploads/…` URL). The rule is now part of the query itself (`Post.buildWhere`
  `attachmentViewer`), so the rows, `X-WP-Total` and `X-WP-TotalPages` are computed over the visible set
  for every caller, page and search. The SQL is derived from the same functions `GET /media/:id` asks — by
  evaluating them on every combination of the facts they read — not written a second time, and a test
  compares the two on real rows for every role, including the boot window. The twin,
  `GET /posts?type=attachment`, listed and counted to an editor every attachment of the entries of a type
  with its own capability family; it takes the same condition — and the type it is asked for is now
  compared **exactly** on every engine (`backend/src/core/sql-exact-text.ts`, used by `Post.buildWhere`
  and `Post.findBySlug`). Under MySQL/MariaDB's case-insensitive, PAD SPACE collation
  `?type=ATTACHMENT&status=inherit` (or `attachment%20`) selected the attachments while the condition,
  decided on the exact name, was never applied (the same comparison exposed other types too; see the
  `GET /posts?type=` entry above, which now refuses such a spelling with `400 rest_invalid_post_type`).
  Inside the query, too, a spelling that differs from the stored type now selects nothing, whoever calls
  it; SQLite and PostgreSQL already compared exactly. The query path resolves the comparison helper, the
  database module, the type registry and the capability helpers once per process rather than on every
  call (a fresh module resolution per call had taken `Post.buildWhere` from about 1 µs to about 50 µs,
  over the F6 query budget, and an attachment list paid some fifty of them).
- **Private attachment downloads follow the parent entry (MEDIUM).** `GET /api/v1/media/:id/file` asked
  only whether the caller may edit the item (its uploader, or any `edit_others_posts` holder), so an
  editor downloaded the private file of a published entry of a type with its own capability family while
  `GET /media/:id` answered 404 for the same item. It now applies the same rule as `GET /media/:id`. A
  plugin route replying `res.sendPrivateMedia(id)` keeps delivering under the plugin's own rule (for
  example `digital-downloads`' paid, unexpired download tokens): the default-deny `media:private_read`
  grant is a site-wide delegation by the administrator, not a per-caller read.
- **Attachments on the generic `/posts` surface, and every attachment write, follow the parent entry
  (LOW).** The record gate alone let an editor read such an attachment through `GET /posts/:id`, its meta
  (`_wp_attached_file`), `GET /posts/slug/:slug?type=attachment`, its translations and its revision
  history, and change it: `PUT /media/:id` answered 200 and edited it. Reads of an attachment now also
  need the right to read its entry (404 otherwise); writes — `PUT`/`DELETE /media/:id`, `PUT`/`DELETE`
  `/posts/:id`, its meta, language and translations, collaboration, presence and revision restore/delete —
  also need the right to **edit** the entry (403), the gate attaching a file to that entry already takes,
  and answer 404 when the caller may not see the attachment at all. The other routes that take an id
  follow too: `GET /seo/meta/:postId` (it returned such an attachment's title and slug to an editor),
  commenting on an attachment and reading its comments by id or by `?post=` without `moderate_comments`
  (`POST /comments` answered 201 where a missing id is 404 — confirming the item exists — and stored the
  comment; `GET /comments/:id` and `GET /comments?post=` returned its comments), and the
  collaboration channel (403 for a hidden attachment, 404 for a missing id): each now answers exactly what
  it answers for an id that does not exist. Two visible, intended consequences: a write to someone else's
  private media item that the caller may not see now answers 404 instead of 403, like the read; and an
  author or contributor can no longer edit or delete **their own** upload once it is attached to an entry
  they may not edit. Naming such an attachment, or any row the caller may not read, as an entry's `parent`
  (`POST /posts`, `PUT /posts/:id`) now answers the `400 rest_invalid_post_parent` of a missing id (it
  answered 403, and an editor could create a post under an attachment `GET /media/:id` hides from them),
  and an attachment parent also takes the attachment write rule (403 when the caller may not edit its
  entry). The site-wide `GET /comments` list shows callers without `moderate_comments` only the comments
  of published, unprotected entries of a public type (the `publicOnlyTypes` filter of `Comment.findAll`).
  A plugin route holding `media:private_read` serves under the plugin's own rule (`res.sendPrivateMedia`),
  and comment moderators' views are site-wide.
- **An entry's fields reach only callers who may read the entry (LOW).** Three surfaces answered more
  than `GET /posts/:id` does. `GET /seo/meta/:postId` kept its own copy of the read rule ("unpublished
  needs the author or `edit_others_posts`"), blind to the type: an editor read the title of the
  unpublished entries of a type with its own capability family, a contributor the title and excerpt of
  every **published** entry of a `public: false` type, and anyone who may read a password-protected entry
  its excerpt; it now asks the content API's rule (`canReadRecordThroughRest`) and withholds the excerpt as
  the content API does. Translation refs were filtered only when the post being serialized was of a
  non-public type, so a public post linked to the published entry of a `public: false` type named it (id
  and slug) to every reader, and `POST /posts/:id/translations` answered the whole group, members the
  caller may not read included; each sibling is now checked. And `GET /posts/slug/:slug` answered
  `rest_post_invalid_id` when a row the caller may not read held the slug and `rest_post_invalid_slug`
  when none did — the same 404 status, but an exact-slug existence oracle over drafts, non-public entries
  and hidden attachments (whose slug comes from the uploaded file name); every miss is now
  `rest_post_invalid_slug`.
- **A password-protected entry's featured image is withheld whatever it names (LOW).** Only attachments
  *of* the protected entry were withheld, so an unattached library image set as its `_thumbnail_id` was
  still projected as `featuredMedia` to every reader. `featuredMedia` and the `_thumbnail_id` naming it
  (in the post's `meta` and in `GET /posts/:id/meta`) are now omitted for a caller who may not read the
  entry's content (who does not manage it); the image itself stays an ordinary public library item.
- **Marketplace plugins: abuse limits that one visitor could exhaust for everyone are now per client.**
  Each fix has a regression test that boots the real plugin (`backend/src/tests/marketplace-plugin-abuse.test.ts`,
  `mail-server-vacation.test.ts`, new cases in `mail-server-spf.test.ts`).
  - **auctions 1.0.1** — the bid throttle counted every attempt, valid or not, in one site-wide 60 s window,
    so about 121 malformed bids a minute blocked all bidding and the flooder won at its own price. Attempts
    are now counted only per client (`req.clientKey`); the per-auction, per-client-per-auction, per-email
    and site-wide caps count bids that actually inserted. Those caps are claimed in the same step as the
    check and refunded when the bid does not land: plugin route handlers run concurrently, and checking
    first and counting after the INSERT let a burst of simultaneous bids from one client pass its 10/min
    cap together (30 landed), so two clients could fill an auction's window and lock out every other bidder.
  - **online-store 2.0.1** — unpaid orders reserved stock and consumed coupon uses forever, so one
    anonymous checkout could empty the shop or burn a limited coupon. Orders still `new` + `pending`
    past a reservation TTL (card: `cardPendingTtlMinutes`, default 60, and the Stripe Checkout Session gets
    a matching `expires_at`; manual: `manualPendingTtlHours`, default 72, `0` disables) are cancelled by a
    compare-and-set sweep that returns their stock and coupon use; card orders are re-verified with Stripe
    first. Orders are capped per line (`maxLineQty`, default 99) and in total (`maxOrderQty`, default 100),
    and the site-wide checkout cap (20/min) is replaced by per-client buckets (6/min, 30/h). The admin's
    order-status change wrote any status with a plain UPDATE, so re-opening a cancelled order (its stock
    and coupon use already returned), or one the sweep cancelled between the admin's read and the write,
    left an order to fulfil with no stock held for it and the last unit was sold twice. A cancelled order
    is no longer re-opened (409). The admin's payment-status change was just as unconditional: a cancelled
    order could be marked paid, and the customer was mailed a receipt for an order nobody fulfils. The
    flip into `paid` is now conditional on the order not being cancelled (409 otherwise, also when the
    sweep cancels it between the admin's read and the write) and on it not being paid already, so two
    admins marking it paid at the same time mail one receipt. The other payment statuses stay free.
  - **bookings 1.0.1** — public bookings were `confirmed` instantly under global limiters, so one client
    could fill the calendar or lock everyone out of lookups. Bookings now start `pending`, hold the slot for
    1 h and are confirmed through a link mailed to the customer (the token is no longer returned to the
    requester). They degrade to confirmed only when the site has no mail transport at all (no mail
    provider registered, or the plugin not granted `email:admin`): any other send failure — the provider
    refusing the address, a timeout, bridge back-pressure — releases the booking and asks the visitor to
    retry, instead of confirming an unverified, non-expiring booking and returning its token. Addresses
    the mail provider always refuses (IP-literal or `:` domains, control characters) are rejected up
    front. Active future bookings are capped per email (3). Per client (5), only bookings no mailbox has
    verified count — pending holds and, without mail, bookings created in the last 24 h — because a client
    key is an HMAC of the IP and is shared behind a NAT or a proxy missing from `trustProxy`; counting
    verified bookings there turned the cap into a site-wide limit of 5 future bookings for up to 90 days.
    The slot and both caps are enforced by unique indexes on claim columns that the INSERT creating the
    booking fills (`slot_claim`, `email_claim`, `client_claim`; cleared when the booking stops counting),
    so a burst of simultaneous public requests cannot pass them together on SQLite, MySQL or Postgres. A
    guard inside the INSERT (`WHERE NOT EXISTS` plus the cap counts) was not enough: on Postgres each plugin
    statement runs under READ COMMITTED on its own connection and reads a snapshot that the INSERTs
    racing it are not in, so simultaneous requests could each book the same slot. Bookings made before
    the upgrade still count toward the caps (an address that already held more than 3 keeps them and gets
    no new booking until it is back under the cap). Staff re-opening a completed, cancelled or expired
    booking as confirmed puts it back under the email cap: it takes an email claim like a public booking
    and is refused (409) while the address already holds 3 active bookings. A re-open used to add an
    active booking that held no claim, and the claim picker — which offered the free claims below
    `3 − unclaimed`, assuming the held ones sat in that range — then offered two claims with room for
    one, so a burst reached 4 active bookings. The picker now offers only the lowest free claims there is
    room for, and reads which claims are held through the claim column itself: on MySQL the collation
    folds case and accents (`josé@` and `jose@` are one key), so comparing the strings in the plugin
    offered a claim the index kept refusing until the retries ran out and the visitor got a 500. Claims
    that keep colliding now answer 409. The staff status change chose its path from a read of the
    booking and then wrote with a plain `UPDATE ... WHERE id = ?`: a booking read as pending or confirmed
    that expired, or that its customer cancelled, before the write was confirmed again with no claim —
    one over the cap once the address had booked again with the freed claim. The write is now
    conditional on the status and claims it read; a booking that changed is read again and decided from
    what is found — a confirm of one that stopped counting is a re-open (409 while the cap is full). A
    re-open did not look at the slot: confirming a booking that expired, or that its customer cancelled,
    after the agenda showed it or between the route's read and its write, re-opened it next to the
    booking another visitor had made in the freed slot — two active bookings at one time on one calendar.
    A re-open now takes the slot claim in the same UPDATE as its email claim and is refused (409) while
    another active booking holds the slot. A failed confirmation mail answers 422 instead of 502, so a
    CDN or proxy cannot replace the message asking the visitor to check the address. The booking/lookup
    limiters are per client. The owner is notified only once a booking is confirmed.
  - **invoices 1.0.1** — the failed-token throttle was global, so 60 wrong tokens in 10 min made every
    customer's invoice link answer 429. It is now keyed per client, and each lookup is counted in the same
    step as the check (refunded when the token is valid), so simultaneous guesses cannot all pass it.
  - **vendor-marketplace 1.0.1** — a vendor's product update set `is_published = 1`, undoing an admin's
    "hide". Hiding now sets an `admin_hidden` moderation flag the vendor portal cannot clear. Image and
    logo URLs that are protocol-relative (`//evil.host/x.png`), contain a backslash or whitespace, or use
    any scheme other than http(s) are refused. The vendor-application (5/min) and buyer-inquiry (10/min)
    limits were site-wide, so one client closed both forms for everyone; they are now per client (3/min
    and 5/min). One store per email address is now a unique index on a new `email_claim` column that the
    INSERT creating the store fills: the duplicate check ran before an await and the INSERT after it, so
    simultaneous applications for one address each stored a pending store, on every engine (the admin's
    create and email edit had the same gap and now answer 409). Stores from before the upgrade hold no
    claim, so duplicates already stored do not block the index; the duplicate check still sees them. Two
    simultaneous applications with the same store name no longer answer 500 with the UNIQUE constraint's
    text — the second gets a fresh slug. The application reply is the same whether or not the address
    already has a store (it differed, which told a probe), and public and vendor-portal errors no longer
    echo the driver's message. Approving a store read its access code and wrote it back, so a code
    rotation landing in between was undone and the code it retired opened the portal again; the approval
    now keeps the stored code in the same UPDATE (a fresh one only when the store has none) and mails that.
  - **job-board 1.0.1** — the application limit (10/min) was one site-wide window, checked before the
    handler's first await and counted only after the INSERT: 40 simultaneous applications from one client
    all passed it, were all stored and each mailed the job's `apply_email`, and the full window then
    answered 429 to every other applicant. The limit is now per client (10/min), claimed in the same
    synchronous step as the check and refunded when nothing is stored. One application per job and
    email is now also a unique index: the `WHERE NOT EXISTS` guard alone reads a READ COMMITTED snapshot
    on Postgres, so simultaneous duplicates could all be stored.
  - **polls 1.0.1** — the one-vote-per-client mark and the per-poll window (30/min) were recorded only
    after the vote's INSERT, so 40 simultaneous votes from one client all landed and then closed the poll
    to everyone for a minute. Both are now claimed in the same synchronous step as their checks and
    refunded if the vote is not stored.
  - **digital-downloads 1.1.0**, **restaurant-menu 2.0.1**, **donations 1.0.1**, **contact-forms 1.0.1**,
    **testimonials 1.0.1**, **popup-builder 1.0.1**, **cookie-consent 1.0.1** — each public limiter was one
    window for the whole site (contact-forms: per form), so one client could close ordering, downloads,
    reservations, donations, a contact form, testimonial submissions, or popup and consent statistics for
    every other visitor. They are now per client: digital-downloads orders 10/min, downloads 60/min and
    status 120/min; restaurant-menu reservations 5/min and 20/h, orders 30/min (the old site-wide size,
    because table guests on the restaurant's Wi-Fi share one client key) and the token lookups at their
    old sizes; donations 10/min and Stripe returns 20/min; contact-forms 5/min per form; testimonials
    5/min; popup-builder events 30/min; cookie-consent logs 10/min. digital-downloads also sends at most 5
    mails an hour to one customer address, whatever clients order (past that the order is created and its
    token shown on screen, without a mail).
    In donations, two admins marking one donation paid at the same time each mailed the donor a receipt;
    the admin's flip into `paid` is now conditional and its result gates the receipt, like the Stripe
    return leg's.
  - **newsletter 1.0.1** — when the confirmation mail could not be sent the subscriber was confirmed
    without opt-in. It now stays `pending` and the admin dashboard shows the mail failure. The subscribe
    limiter was one site-wide window (20/min), so one script closed the form for every visitor; it is now
    per client (10/min), and each address receives at most 3 confirmation mails an hour whatever clients
    ask — past that the reply is unchanged and the token is not rotated, so the mailed link keeps working.
    Simultaneous subscribes for a new address answered 500 to all but one (the email is UNIQUE); they now
    get the uniform reply. A subscribe that read the subscriber before its confirmation link was followed
    reset it to `pending` with a new token; the re-subscribe no longer touches a confirmed subscriber.
  - **Public error replies** (auctions 1.0.1, digital-downloads 1.1.0, invoices 1.0.1, polls 1.0.1,
    conference-manager 2.15.1, online-store 2.0.1, restaurant-menu 2.0.1) — public routes answered 500
    `{ error: e.message }`, and the driver's message names the plugin's tables and constraints
    (`no such table: wjp_conference_manager_conferences`); conference-manager's shared error helper did it
    for its public form and its location portal. online-store and restaurant-menu put Stripe's error
    message in the checkout warning and the payment-return reply, and Stripe's message can name the
    account's key (`Invalid API Key provided: sk_live_****1234`). The details now go to the server log;
    conference-manager still answers its deliberate refusals (validation, 403, 409) with their own
    message. Public routes with no catch of their own — in analytics-tag, card-gallery, contact-forms,
    donations, events-calendar, faq, image-lightbox, notification-bar, online-store, photo-carousel,
    popup-builder, testimonials, video-gallery and youtube-videos, and conference-manager's portal
    summary — now catch a failing read and answer 500 with a generic message, the details going to the
    server log.
  - **event-tickets 1.0.1** — free tickets were limited only per email, so rotating addresses claimed all
    capacity. Free seats are now capped per order (4); per email per event (4), a durable quota claimed
    with one conditional UPDATE on a per-address counter row, so concurrent requests cannot exceed it
    (free orders placed before the upgrade count, and a cancelled order gives its seats back); and per
    client per event (4 every 10 minutes). The per-client limit is a rolling window, not a durable count,
    because a client key is shared behind a NAT or a proxy missing from `trustProxy`: a durable cap let
    the first 4 free seats lock everyone behind it out of the event. Orders are rate-limited per email,
    per client and site-wide, and every window is claimed in the same step as the check and refunded when
    no order is created — checking first and counting after the INSERT let 25 simultaneous orders from
    one client all land (all 100 free seats) and let one client fill the site-wide order window. An
    unpaid order's seats went back more than once: the expiry sweep released them before its conditional
    `pending → expired` flip, so two overlapping sweeps released one order twice and an order the admin
    confirmed under the sweep lost its seats; the admin's cancel accepted any status but `cancelled`, so
    cancelling an expired order (the order list offers it) released its seats again. The type could then
    sell more tickets than its capacity. Seats are now released only by the flip that wins, from a status
    that holds them; confirming the payment of an order that expired meanwhile answers 409 instead of
    "already paid" with no tickets; and a capacity cut is written only while it still covers the seats sold.
  - **conference-manager 2.15.1** — editing an inscription read the attendee, decided whether to free its
    bed and wrote outside the assignment lock that placements, the auto-assignment and the lodging
    submit/review run under, and the admin's manual placement read the attendee before taking that lock:
    a cancellation and a placement landing in each other's gap left a cancelled attendee holding a bed.
    Both now read and write under the lock. A bus capacity cut is checked under the lock ticket sales
    use, so a sale can no longer land between the check and the write and leave more tickets than seats.
    Transport payments check what a ticket still owes under that lock too. Repricing a bus's sold tickets
    checked under it that nothing was paid beyond the new price, but wrote the tickets' new price after
    releasing it: a payment landing in between was accepted against the old price and the ticket ended
    up paid beyond the new one. Deleting a bus, removing a passenger and deleting an attendee checked for
    (or erased) transport payments outside it, so a payment landing in the gap was answered as recorded
    and then erased with its ticket. All of them now check and write under the lock.
  - **mail-server 2.2.5** — the vacation auto-responder replied to any claimed sender, which made a
    vacationing mailbox a reflector for forged mail. Inbound mail now gets a reply only when SPF passed for
    the envelope domain and that domain is the header From domain, replies are capped at 50 distinct
    recipients per mailbox per 24 h, and a second transaction in the same SMTP session no longer inherits
    the previous transaction's SPF verdict.
- **A network-granted plugin can no longer recover a raw DNS resolver from the guarded `dns` module.**
  The `dns` module a plugin receives is a guarded stand-in: it permits `dns.lookup`/`dns.lookupService`
  (system-resolver lookups whose name is checked against the plugin's egress policy before it is
  resolved; the private-address filter applies when a connection is made) and refuses the raw c-ares
  resolver surface (`resolve*`, `Resolver`, `setServers`), which does DNS over its own sockets, below the
  egress filter. The stand-in was a Proxy with only a `get` trap, so
  `Object.getOwnPropertyDescriptor(require('dns'), 'resolveTxt'`
  `|'Resolver'|'promises')` handed back the real member and `new Resolver()` built a raw resolver — a
  plugin resolved any name (exfiltration) under an allowlist or deny-all, and probed internal hosts. It is
  now a frozen object holding only the permitted members and a clear-error stub for every resolver
  function, named or not, so a resolver a newer Node adds (`dns.resolveTlsa`, in Node 22.15 and 23.9)
  is refused by default rather than forwarded. `require('dns')`, `require('dns/promises')` and their `node:` spellings
  are covered identically (`dns/promises` gets the promise-returning stand-in), and `import()` of any of
  them stays refused. The egress guard also reads `net.isIP` captured at load: `import('net')` gives a
  network-granted plugin the real `net` module, whose `isIP` is writable, and with it overwritten a
  loopback address was no longer recognised as an address and a connection to it went through.
- **A host name given to a server's `listen()` or a UDP socket's `bind()` now obeys the plugin's egress
  policy, like a connection's host.** Those calls resolve their host through Node's own `dns.lookup`,
  not through a connect path, so a network-granted plugin could make the system resolver query any name
  (`listen(0, '<data>.attacker.example')` sends that name to the attacker's nameserver) under an
  allowlist or deny-all. Inside the plugin's process that lookup is now gated: an IP literal or no host
  behaves exactly as before, and a name is checked against the egress policy before it is resolved — a
  name off the allowlist, or any name under deny-all, is refused with the sandbox's egress error on the
  server's or socket's `error` event. A plugin with no allowlist configured is unaffected. Regression test:
  `backend/src/tests/egress-listen-bind-host.test.ts` (a real isolated plugin under each policy state).
- **Plugin grant and egress-allowlist changes now reach every backend node.** On a multi-node cluster,
  revoking a plugin's grants or narrowing its egress allowlist took effect only on the node that served the
  admin request; every other node kept the old grants and the old (allow-all) allowlist — including the
  `wordjs.dns` name check, the exact exfiltration path the allowlist exists to close — until it restarted.
  The change is now published over the Redis coherence bus, and each node re-reads both policies from the
  database and respawns any running plugin child whose spawn-time grants or allowlist no longer match.
  Pub/sub drops messages silently (a Redis restart, a subscriber reconnect, the moments before a booting
  node subscribes), so each node also re-reads both policies as soon as it has subscribed, whenever its
  bus reconnects and every 10 seconds: a lost broadcast now delays a revoke by about that plus the time
  the plugin's child takes to restart, instead of until a restart. Each re-read restarts every affected
  child at once (at most four at a time) without waiting for them, so one child slow to start does not
  hold back the others or the next re-read. A grant change also no longer races a re-read on the node
  that made it: the change is written to the database before memory, and re-reads and writes run one at
  a time, so a re-read landing mid-write cannot put the old grants back in memory — from where the
  permission route was about to respawn the plugin's child, still holding a revoked network grant.
  Memory is updated as soon as the row is written, before plugins that listen for option changes are
  notified: that notification reaches each of them in turn, and until it finished a revoked grant stayed
  in force on the node that wrote the revoke, with the cluster-wide policy lock held. The permission and
  egress-allowlist routes now also restart the plugin's child at that point — or deactivate the plugin,
  when its code needs a capability just revoked — and only then wait for the notification: the child
  holds what it was started with, so until every listener had been told it kept a revoked network or
  filesystem grant, or the old allowlist. The write itself reads the stored policy from the database
  under that lock rather than through the option cache, so it cannot write back a stale copy over another
  node's change to a different plugin. A grant token that is neither `network` nor `scope:access` is no
  longer stored: every re-read dropped it again, which restarted the plugin's child once and logged a
  warning on every node every 10 seconds; a malformed entry already in the store is now reported once.
  When an admin activates a plugin, the grants it is given are now stored before the other nodes are
  told about the activation (they used to load it first, without its grants, or refuse it as "declared
  but not granted"), and a node loading a plugin that another node activated re-reads the policy before
  checking it. Activation grants a plugin its declared permissions when its record is missing, or empty
  with no administrator decision recorded for it: since 1.12.12 every in-place update of a plugin with no
  grant record has stored an empty one (it still does, see the update entry above), so on an existing
  site an empty record alone does not mean an administrator revoked everything. Grants set through the
  permissions screen (and the ones the activation dialog approves) are now recorded as the
  administrator's decision, so a partial revoke and a revoke of every permission both survive a
  re-activation.
- **A plugin deactivated on one node no longer keeps running on a node that missed the broadcast.**
  Every node now stops a plugin it still runs once the shared list of active plugins has not included it
  on two consecutive re-syncs (10 seconds apart), never while an activation of it is in progress on that
  node. The read-modify-write of that list also reads it from the database inside its lock: through the
  option cache, a node that missed a peer's change wrote the old list back (re-activating a plugin the
  peer had just deactivated), and a database read error came back as an empty list, which the activation
  then saved — deactivating every other plugin on the site.
- **The `wordjs.dns` bridge obeys the plugin's egress allowlist.** `resolveMx`, `resolveTxt`, `resolve4`,
  `resolve6` and `resolve` now check the name being resolved against the plugin's egress allowlist
  before querying, in addition to the `network` grant. Before, only the A/AAAA answers were filtered, so
  a plugin limited to one vendor could still look up any name. That is outbound traffic in itself: a
  query for `<data>.attacker.example` reaches the attacker's nameserver. An empty allowlist still allows
  every public name. While the egress policy has not loaded, every lookup is refused, the same fail-closed
  rule the plugin's sockets follow. A name containing a control character is refused in every state: the
  resolver stops at the first NUL, so `<data>.attacker.example\u0000.vendor.example` passed an allowlist
  of `vendor.example` and was queried as `<data>.attacker.example`.
- **The plugin egress allowlist judges the host that is actually resolved.** Inside a network-granted
  plugin's process, `net`, `tls`, `http`, `https`, `dgram` and the `fetch` pre-check compared a host such
  as `any-public-host\u0000.vendor.example` with the allowlist by its suffix, while the system resolver
  resolved only the part before the NUL, so a plugin limited to one vendor could reach any public server.
  While an allowlist is set, a host now matches only if it is a plain ASCII hostname (letters, digits,
  `-`, `_`, dots) or an IP literal; a NUL or other control character, a backslash, whitespace or a
  non-ASCII name (which Node maps with IDNA before resolving) is refused. Internationalised names must be
  passed in punycode form (`fetch` and `URL` already do this). The plugin's own `dns.lookup`,
  `dns.lookupService` and `dns.promises.lookup` now obey the allowlist too: before, a plugin limited to one
  vendor could look up `<data>.attacker.example` through them, and the query reached the attacker's
  nameserver.
- **A plugin whose egress policy could not be loaded now reaches no public host.** If the host fails to
  load the egress allowlists at boot (a database error, for example), it starts network-granted plugins
  in a deny-all state. Every connection check in the plugin's process ran only when an allowlist was
  installed, and deny-all installs none, so those plugins got unrestricted public egress (TCP, HTTP,
  `fetch`, WebSocket and UDP) instead of none. Every check now applies the policy in all three states
  (no allowlist, allowlist, deny-all), and under deny-all `dns.lookup` resolves nothing either. A
  database error now actually leads to that state: the host read the policy through a function that
  answers a failed read with an empty default, so the error looked like a successfully loaded, empty
  policy — every public host allowed. The grant and egress policies are now read strictly; a failure at
  boot leaves network-granted plugins deny-all until a later re-read succeeds (and their children are
  then respawned with the real policy), and a failure on a later re-read keeps the policy last read,
  instead of dropping every plugin's grants.
- **A frontend replica no longer relays client forwarding headers to its backend.** With
  `WORDJS_BACKEND_URL` set, the frontend's own proxy copied a client's `X-Forwarded-For` (and
  `Forwarded`, `X-Real-IP`, `X-Forwarded-Port`, `X-Forwarded-Server`) through unchanged. The backend trusts
  forwarded headers from a loopback hop, so a client could choose the IP address used for rate limiting,
  lockouts and the audit log. The proxy now removes every client forwarding header and sets
  `X-Forwarded-For` to the socket's peer address, `X-Forwarded-Host` to the Host it received and
  `X-Forwarded-Proto` to its own listener's scheme, as the gateway does at its edge. The replica's own
  proxy is not the only route to the backend: Next's `/api` rewrite forwards too and relays headers
  unchanged, and it took dot-segment paths (`/x/../api/v1/auth/login`, `/x/%2e%2e/api/…`, which Next
  resolves into `/api`) and every WebSocket upgrade, which Next's own upgrade listener rewrote. The
  replica now restates the forwarding headers on every request and upgrade before either route sees it,
  and answers a path with a dot segment or a backslash with `400 rest_bad_path`, as the gateway and the
  monolith do. On the replica's mutual-TLS listener, a request presenting the gateway's own client
  certificate (`CN=gateway-internal`) keeps the forwarding headers the gateway already stated at its
  edge, so a replica behind the gateway no longer overwrites the gateway's judged `X-Forwarded-Host` with
  its own internal host or the client's address with the gateway's. Any other cluster certificate on
  that listener — a backend node's or another frontend's, which mutual TLS accepts just the same — has
  its headers restated like a client's, as does every request on the client-facing (HTTP) listener.
- **The first TOTP use when the replay counter is missing is accepted exactly once.** TOTP anti-replay
  advances `mfa_totp_last_step` with a compare-and-set. If the row was missing (a partial restore, an
  imported database, or an enrollment written by other tooling), the compare-and-set matched nothing and
  every TOTP code was refused, which locked the account out of TOTP (codes were never replayable).
  Enrollment already creates the row. Now the first use creates it with an insert-if-absent inside a
  transaction that locks the user's secret row, so exactly one of several concurrent submissions is
  accepted and a replay of that code is refused. Enrollment now writes the counter before the secret.
- **Plugin `dependencies` accept only plain npm registry version ranges.** The host installs a plugin's
  manifest `dependencies` with `npm install` in its own root at activation, and npm runs the `prepare`
  script of a `git+…`/`github:` or `file:` directory dependency even with `--ignore-scripts` — so a
  manifest entry such as `"x": "file:../evil"` was code execution on the server. `npm:` aliases and
  tarball URLs installed unscanned code under a benign name. A dependency must now be an npm package name
  mapped to a semver range (`^1.2.3`, `~1.0`, `1.x`, `>=1 <2`, `*`); git, GitHub, `file:`, `link:`,
  `workspace:`, `npm:` aliases, paths, URLs and dist-tags are refused at upload and marketplace install,
  again inside the dependency installer before npm runs (including at boot), by `npm run pack:plugin` and
  by the marketplace submission gate. The install also sets `npm_config_ignore_scripts=true`.
- **Running plugin code in the browser is now an explicit, default-deny capability: `browser:script`.**
  A plugin's compiled frontend bundles (admin page, admin hooks, Verso blocks) run unsandboxed and
  unscanned in the admin app's origin with the viewer's session, and were served unauthenticated for any
  installed plugin, active or not — so a plugin granted only `settings:read` could act as every
  administrator who opened the admin. Now a plugin that ships browser code must declare `browser:script`
  (upload, activation and packing refuse it otherwise); the activation and permissions dialogs show it
  as high risk with the warning "runs code in your browser with your administrator session"; and
  `GET /api/v1/plugins/:slug/bundle` (and `/bundle/css`, `/bundle/manifest`) serve a plugin's files only
  while it is **active and the capability is granted**, otherwise 404. This is a mitigation: granted code
  still runs in the admin origin, and separate-origin sandboxed iframes are planned
  (`documentation/security.md` §1.3b).
  **Upgrade:** the first boot after upgrading grants `browser:script` once to every plugin that was
  already active and already shipped browser code, so working sites keep their plugin pages, hooks and
  blocks; it is logged and recorded as done inside the grant store (see the entry above on replaying
  this step), and never runs again. A plugin installed before this release that does not declare the
  permission keeps running while active and shows a flagged `browser:script` row in Admin → Plugins, but
  must be updated before it can be activated again. Every catalog plugin and the `wordjs` CLI plugin
  template now declare it; the
  catalog plugins get a patch version bump so installed copies are offered the update.
- **`GET /api/v1/plugins/registry` no longer publishes plugin manifests.** The unauthenticated registry
  returned every active plugin's name, exact version, author, requested permissions and dependencies — a
  ready-made fingerprint of the install. It now returns only `{ id, path, browser, frontend: { hooks } }`,
  which is what the admin's hooks loader reads.
- **Plugin downloads no longer include runtime data.** `GET /api/v1/plugins/:slug/download` zipped the
  whole plugin folder, including its top-level `data/` (mail-server's `data/.mailenc` encryption key and
  attachments), `node_modules/` and `.git`. It now uses the same file rule as the plugin packer: no
  top-level `data/`, no `node_modules/` or `.git`, no OS junk and no symbolic links.

### Added

- **`npm run pack:plugin -- <slug> [--dir <folder>]` packages a plugin into an installable ZIP.** It
  checks the manifest, builds the frontend bundles, runs the installer's permission check and AST scan
  on exactly what is packed, and writes `release/plugins/<slug>-<version>.zip` without `data/`, the
  working `node_modules/` or OS junk, refusing anything the upload would reject. npm dependencies are
  handled without flags: the plugin's `package.json` dependencies are declared in the packed manifest
  for the server to install, or — for `"bundled": true` and for packages the server will not install
  itself, such as native builds — a fresh production-only `node_modules/` ships in the ZIP; a required
  package declared nowhere stops the pack.
- **Dev-mode "Build & download ZIP" in `/admin/plugins`.** With `NODE_ENV=development`, each plugin card
  offers a button that runs the same packer on the installed plugin (`POST /api/v1/plugins/:slug/pack`,
  admin-only) and saves `<slug>-<version>.zip`, or shows the packer's refusal reason. Outside development
  the route answers 404 and `GET /plugins` reports `packable: false`, so the button is hidden. `--dir` (and `WORDJS_PLUGINS_DIR` for `build-plugin.js`)
  lets a private plugin live outside `backend/plugins/`. Documented in `documentation/plugins.md` §4–5.
- **conference-manager 2.16.0: the kitchen confirms each meal before it is recorded.** A scan used to be
  recorded as delivered the moment the code was read. Now the phone scanner and the «Entrega» tab first ask
  the new read-only `POST /meals/check` (same lookup and decision as `/meals/deliver`, shared code, nothing
  written) and show a confirmation card with the meal (day and meal), the person's data and the status:
  «Entregar» or «Cancelar»; «Entregar sin derecho (autorizar)» or «Cancelar» without entitlement;
  «Cerrar» for an attendee already served, cancelled, unknown or from another conference. «Cancelar»
  records nothing: the person stays pending and the next scan shows the card again. On the phone, decoding
  pauses while the card is open and the badge must leave the camera before it opens a card again (shown
  again too soon after «Cancelar», it says so; after a reset or a failed request it is not held); on a short
  phone the card takes the whole camera area and the status and name stay at the top of the part that
  scrolls. In «Entrega» Enter on the empty input delivers (never the override), Esc cancels, and a
  USB-scanner code read while a card is open is queued behind it instead of touching it; Enter only answers a
  card that has been on screen for half a second and never as a held-down key or the second Enter of a
  CR+LF scanner suffix, the queue waits until a delivery's result has been seen («Entregado» for a moment,
  any failure until Enter, Esc or a click), and a person picked by name replaces the open card. Whatever
  appears under the scan input («Comprobando…», the card, a delivery's result) is scrolled into view at once
  (on common desktop sizes it opened below the fold) and the card is capped to the visible area, so its meal,
  name and buttons are on screen together; giving the focus back to the scan input never scrolls it away. The
  meal counters (page header, «Entrega» panel, «Reporte») sit side by side only where their labels fit, one
  per row otherwise («ENTREGADOS» spilled into the next tile at 1280 px). Both
  screens ignore taps on a card's buttons for a moment after it appears, so a second tap on «Entregar»
  cannot hit «Deshacer» on the «Entregado» card. On a not-entitled card «Cancelar» is the large button and
  the override the smaller, outlined one. A ready card has its own sound. A per-device switch, «Confirmar
  antes de entregar» (on by default), brings back the immediate delivery. **The data on the card is
  configurable** per conference («Qué se muestra al entregar», `GET`/`PUT /meals/display-fields`,
  `meals:manage` to change it): the location, registration code, payment status, room and any
  registration-form field, in the chosen order, under the full name, which is always shown first (the server
  enforces it), with a live preview; the default is name + location, and «Restablecer» only refills the form.
  `/meals/check` and `/meals/deliver` (which also returns them, so the «Entregado» card shows the same data)
  carry the configured values in `person.fields`, so form answers, payment status and room reach the
  delivery device only when chosen; `person` keeps the 2.15 projection (name, location, family group, masked
  code) that delivery staff already get from the search by name. Stored in a new `meal_display_fields`
  column of the conferences table, added idempotently on boot.
- **Plugins can declare user roles, and such a role can only ever reach its own plugin.** A manifest may
  carry a `roles` block (`[{ slug, name, description, capabilities }]`), requested through the new
  `roles:declare` permission and registered when the plugin is activated with that grant. Every role slug
  and capability must start with the plugin's namespace (`conference-manager` → `conference_manager_`);
  the only other capabilities such a role ever holds are `read` and `access_admin_panel`, which the core
  adds itself. A name from the core's own capability vocabulary (`manage_…`, `edit_…`, `list_…` and the
  other core verbs) is never a plugin capability, so a plugin called `manage` cannot declare
  `manage_options`, and a capability that gates a content type (whose operations an administrator names
  freely) is never a plugin role's either. Anything else refuses the whole block — at upload, in the
  marketplace submission gate (`scan-plugin.mjs`) and at activation, which checks it before the plugin's
  code runs and so never half-applies. A plugin role never replaces a core role, an administrator's role or
  another plugin's role, and a slug or capability inside another installed plugin's (nested) namespace is
  refused; a namespace two installed plugins share is owned by neither. The same rule holds on every later
  path: `POST /roles` refuses a foreign capability on a plugin role (`400 rest_role_plugin_capability`) and
  renaming or deleting it while the plugin is installed (`409 rest_role_plugin_managed`); the boot-time role
  sync cuts what does not belong and orphans the role of a plugin that is no longer installed; and the
  capabilities a user actually holds are computed from the namespace, so a hand-edited option cannot widen
  a plugin role either. An administrator's accepted edit of a plugin role's capabilities is kept across
  every refresh from the manifest (`adminChanges`). Every write of the roles map — a plugin role's
  registration, refresh or retirement, `POST`/`DELETE /roles` and the boot-time sync — runs one at a time,
  in each process and across nodes (the `wordjs:roles` lock), computes the new map on the one stored in the
  database rather than on the node's cached copy, and saves it only if the stored map is still the one it
  read (otherwise it reads and computes again): a role change made on another node is never written back
  over, even by a node that has not heard of it yet. On several nodes a grant or revoke of
  `roles:declare` reaches every node through the Redis option signal. Without the grant the role is inert;
  while the plugin is deactivated it is kept; when the plugin is deleted it is removed if nobody holds it,
  otherwise kept as orphaned with `read`/`access_admin_panel` only, and it can be deleted once nobody holds
  it (`409 rest_role_in_use`). Roles carry their provenance (`source: "plugin"`, `plugin`), and the Roles
  screen shows them as the plugin's, read-only. A plugin route receives the caller's capabilities in its
  own namespace as `req.user.pluginCapabilities` (an administrator receives every capability the plugin's
  roles confer), and the users bridge adds the same list to every account it returns. A plugin's admin
  menu item may point only at its own admin page: `/admin/plugin/<slug>` belongs to the plugin installed in
  that folder, otherwise to the one installed plugin whose manifest declares it as its admin page — never
  to a plugin just because its manifest names it. An upload or activation whose declared admin page is
  another installed plugin's folder or admin page, or whose folder another installed plugin declares as
  its admin page, is refused (`Invalid admin page`). The grant screens list the roles a plugin will register
  and how many users already hold each one (an orphaned role from an earlier installation comes back to
  them with the grant). Documented in `documentation/plugins.md` §12a.
- **The user forms offer every role.** The role dropdowns of the user create and edit forms list all roles
  from the roles API — core, administrator-made and plugin roles, grouped and labelled — instead of a
  hardcoded subscriber/author/editor/administrator. When the list cannot be read (it is
  administrator-only) they keep those four.
- **A page you cannot see in the admin menu is a page you cannot open.** The admin layout now applies one
  route → capability map (`frontend/src/lib/adminAccess.ts`, shared with the sidebar) after the sign-in and
  MFA gates: a screen the user lacks the capability for is not rendered and they are sent to the first page
  their sidebar offers; `/admin/plugin/<slug>` opens only through a plugin menu item the user has (a plugin
  menu item never opens a core screen); `/admin/account` is always open. Signing in, or opening `/admin`
  without the dashboard capability, lands on that first admin page — a plugin team member goes straight to
  the plugin's screen; a user whose sidebar offers nothing else lands on their account page. The plugin
  menu is reloaded when the signed-in user, their role or their two-factor block changes (a team member who
  just enrolled reaches their plugin screen without reloading), and a failed load is retried before it
  counts. The dashboard's shortcuts and the sidebar logo lead only to pages the user may open, and the
  pages screens ask for `edit_pages` like the guard. Administrators keep every page, and the editor's
  fullscreen routes keep their bypass. This is a navigation guard in the browser, not access control:
  every API still enforces its own capability.

### Changed

- **`create-wordjs` is published to npm with trusted publishing, not a stored token.** npm restricted the
  long-lived tokens that bypass two-factor authentication, and the release workflow's `NPM_TOKEN` stopped
  being accepted (the 2.3.0 publish failed with E404). The `npm-publish` job in `release.yml` now
  exchanges its GitHub OIDC token for a one-time publish credential (`id-token: write`, npm ≥ 11.5.1), so
  no npm credential is stored in the repository and each version carries provenance. It needs a trusted
  publisher configured once on npmjs.com for `jaimemartinez/wordjs`, workflow `release.yml`.
- **conference-manager 2.17.0: the conference team gets its own WordJS role, and the registration form
  starts empty.** The plugin declares the role «Equipo de conferencia» (`conference_manager_team`, permission
  `roles:declare`), whose only capability is `conference_manager_access`. The «Conference» menu entry now
  needs that capability, so it shows for administrators and the holders of the capability only. A team
  member's account is created in Users with that role and then added to the team. It can open the
  conference screens and its own account page and no other admin page. An administrator can still put an
  editor (or any other role) on the team, as in 2.15: by giving that role `conference_manager_access` in
  Users › Roles. `POST /staff/members` accepts only accounts whose role holds the capability
  (`400 not_team_role` otherwise), and so do a role change and a reactivation through `PUT` that leave the
  member active, while deactivating is always allowed (and without the `users:read` grant every change is
  made, as in 2.15). A member added before 2.17.0 whose account lacks the capability is kept, flagged in
  the team list, and gets no section until it is given (`GET /staff/members` reports `team_role` per member
  and `roles_ready`; `GET /staff/me` reports `teamRole` and `member`, and the no-access screen says which
  is missing). When the role is not active — an in-place update keeps the old grants, without
  `roles:declare` — «Equipo y permisos» says so and where to grant it. The team picker shows each account's
  WordJS role and explains why an account cannot be added. A new conference, including the default conference of
  a fresh install, has no form field and no assignment rule. A restart no longer seeds the old default
  form back onto a conference without fields; existing conferences keep their fields.
  «Nuevo campo» offers the base fields (Nombre, Apellido, Email, Teléfono, Género, Grupo familiar) as
  templates. `POST /fields { template }` creates each one with the exact column, type, options and role
  the other features read, adds it at the end of the form, and refuses a second copy (`409 field_exists`,
  also on a double click). Every field can be edited and deleted while the form is unpublished; the
  published-form lock is unchanged. Deleting a field asks first and names what stops working: the display
  name, the lodging gender hints, the portal groups, the duplicate check, and the price and assignment
  rules that read the field. The features cope without a base field. A price rule on a deleted field is
  skipped instead of being matched against an empty value, and the Precios and Asignación pages flag such
  rules. Without a «Género» field the lodging views show no gender hints or room-type filter and the
  report has no gender breakdown, and the lodging gender hints read the word («Mujer» is F). The location
  is not a form field: the portal login sets it, or the admin picks it from Localidades — and a price rule
  on the location keeps applying. An assignment rule on a field the form no longer has is skipped by the
  engine and the lodging audits (a new one is refused), and the delete confirmation also names the
  coordinators' own rules. A form with no field cannot be published (`400 form_empty`). Without Nombre /
  Apellido, people are named by the other form fields fit for a name — never an ID document, a contact or
  notes, which the meals screens would otherwise show to a kitchen role that cannot read the roster — and
  the coordinators' portal names them the same way (`display_name`), with no gender shown when the form
  collects none. On phones every field can be edited, deleted and reordered (the row's buttons are visible
  on screens without hover, with ↑ / ↓ next to them), and «Nuevo campo» opens above the admin header.
  Deleting a conference (`DELETE /:id`) takes its attendees, fee payments, transport payments and
  accounting ledger with it, so it now asks for what erasing each of those asks for: «Configuración»
  (manage) alone deletes a conference that holds none of them, and one that does also needs manage on
  «Inscripciones», «Pagos», «Transporte» and «Contabilidad» for its attendees, fee payments, transport
  payments and ledger entries respectively — otherwise `409 conference_has_records`, naming them in
  `sections`, and nothing is deleted. Administrators delete any conference, as before, and the
  confirmation says what goes with it. The meals people search (`GET /meals/people`) returns an attendee's
  ID document (`document_number`) only to a role with «Inscripciones» (view), like the registration code;
  without it (the kitchen's «Entrega de comidas») a document finds a person only when typed whole.

### Fixed

- **Admin row actions are visible on phones and tablets.** Several admin screens hid their row actions
  with `opacity-0 group-hover:opacity-100`, and Tailwind v4 only applies `group-hover:` where the device
  can hover. On touch screens those buttons therefore stayed invisible but still tappable, including the
  delete buttons on Users, Categories and Menus, and the revoke button on Tokens. Media, Backups and the
  posts table used a width-based variant that failed the same way on tablets. These controls are now
  visible by default and hidden only where hover exists. Hovering or keyboard focus still reveals them on
  desktop. Also covered: Roles, Plugins, the Settings logo/favicon remove buttons, the notification
  centre (whose delete button sits in the card's bottom-right corner on touch screens) and the Verso
  saved-pattern delete. Purely decorative hover layers stay hover-only and no longer intercept taps. A
  test now fails on any admin or shared-component class list that reveals a control only on hover.
- **A failed install no longer leaves the site half-installed.** `POST /setup/install` wrote
  `wordjs-config.json` before it opened the database, and that file marks the site installed: when a
  later step failed, every retry of the wizard was answered `Already installed` — with no database and no
  administrator — until the file was deleted by hand. A failure before the administrator account exists
  now puts the config back exactly as it was (no file at all on a fresh box), and the steps before that
  point can be repeated, so the wizard simply runs again.
- **The install wizard checks the native SQLite driver before it writes anything.** `better-sqlite3`
  loads without its compiled binary and only fails at the first connection, so an install made with
  `npm install --ignore-scripts` (which skips the step that puts the binary in place) failed halfway
  through with `Could not locate the bindings file`. The wizard now stops first and says how to fix it
  (`npm rebuild better-sqlite3` in `backend/`, or the pure-JS SQLite option); `POST /setup/test-db`
  reports the same. See *Install scripts* in `documentation/development.md`.
- **The install wizard works in split-mode development.** Before the wizard has run, nothing can register
  with the gateway, so it reaches the local backend and frontend through its pre-install bootstrap — for
  HTTP requests only. WebSocket upgrades were dropped, Next.js's HMR socket (`/_next/hmr`) with them, and
  the wizard page never became interactive ("Next Step" stayed disabled). Upgrades now use the same
  bootstrap.
- **A fresh clone no longer starts with somebody else's gateway routes.** `gateway/gateway-registry.json`
  (the gateway's runtime state, gitignored) had been committed, so every new checkout routed all traffic
  to `https://127.0.0.1:3001`/`:4000` while the services still spoke plain HTTP: every page answered
  `502 Upstream Error` for about 90 seconds, until the health checks evicted those targets, and the
  gateway then rewrote a tracked file. The file is no longer in the repository. A checkout whose copy was
  changed by a running gateway may need `git checkout -- gateway/gateway-registry.json` before pulling.
- **A split install made through the wizard serves its pages after a restart.** The frontend registered
  with the gateway on the port of `frontendUrl` — the site's public origin, which the wizard sets to the
  address visitors use (on one host, the gateway's own `:3000`). The gateway then proxied every page to
  itself (`502`, `EPROTO`) until a health check evicted the target about 90 seconds later, after every
  restart, and its cache purge had no frontend to reach. The frontend now registers the port its server
  listens on.
- **Cluster certificates are always loadable by OpenSSL.** The gateway's cluster CA drew certificate
  serials as `'0'` + 15 random bytes and relied on node-forge stripping one leading zero byte; when the
  first random byte was itself `0x00` (about 1 draw in 512) the certificate carried a non-minimal DER
  INTEGER that OpenSSL 3 refuses (`illegal padding`), so that identity — or, if it was the CA itself,
  every enrollment — failed. Serials are now 16 random bytes with a first byte of `0x01`–`0x7f`.
- **A plugin admin page is never blank: without `browser:script` it says why and links to the switch.**
  With a plugin active but its `browser:script` permission not granted, `/admin/plugin/<slug>` rendered an
  empty page with no explanation: the bundle loader turned the refused bundle (404) into an empty
  component, so neither its fallback nor the page's "Plugin Not Found" could ever render. The load now
  fails with its cause. When the public plugin registry says the plugin is active and not granted
  (resolving an admin-page slug such as `emails` to its plugin through the admin menu), the page shows
  "This plugin's interface is not served until you grant 'Run code in your browser' (browser:script) in
  Admin → Plugins → Permissions", in the admin's language (Spanish, English or Portuguese), to a viewer
  who can open the plugins screen (`activate_plugins`), with a link to `/admin/plugins?permissions=<plugin>`.
  Anyone else — a plugin team member, whose role opens the plugin's page and not the plugins screen —
  reads that the screen is not available yet and to ask an administrator, with no link the admin guard
  would send them back from. The link opens that
  plugin's permissions dialog once — the screen then drops the parameter from the address bar, and its
  later list reloads (after a save, an activation, a deactivation) or a page reload do not reopen it; any
  other failure renders the not-found fallback. A refusal is not
  cached, so the page loads on the next visit once the permission is granted. (The permission gates the
  bundle the backend serves, which on a release build is every plugin admin page. A frontend you build
  yourself also compiles in, from source, the admin pages of the plugins its backend reports active at
  build time (every plugin on disk when the generator cannot reach the backend), so build it only with
  plugins you trust with the admin session; see `documentation/security.md` §1.3b.) The runtime hooks loader
  also stops requesting `bundle?type=hooks` from every active plugin on every admin screen: it reads the
  registry once per pass and asks only the plugins that declare `frontend.hooks` (and any it cannot
  vouch for), instead of collecting a silent 404 per hook-less plugin.
- **The F6 performance budget no longer fails the Linux CI on unchanged code.** Its ratio ceilings were
  measured on one Windows host and judged on the Linux runners too, where the reference workload
  (autocommit inserts) is cheaper and the mostly-CPU operations read up to ~2.5x their Windows ratios —
  `contentRender` failed the Backend job at 0.183x and 0.187x against a 0.18x ceiling.
  `performanceBudget` in `backend/f0-baseline.json` (schema 2) now keeps the host-independent fields once
  and one calibration per platform under `calibrations.<platform>`: `linux` minted from 104 rounds the CI
  perf job had recorded, at 1.5x the worst round, and the existing `win32` one. A platform with no
  calibration has its ratio comparison skipped with the reason instead of borrowing another platform's;
  `verify:f0` requires a `linux` calibration. `perf-calibrate.mjs` mints one platform's calibration,
  can reduce already-recorded CI artifacts with `--from`, and reports a re-mint looser than the committed
  ceiling as an error. The CI `Performance budgets` job now enforces the `linux` calibration on every
  push and pull request (it is still not a required check). The `linux` calibration covers the tails of
  the jobs that enforce it, not only the isolated perf job: a first version minted from that job alone
  failed the F6 phase suites on unchanged code (`contentUpdate` 10.742x against 10.662x), so it was
  re-minted from 145 rounds including the measurements of failing enforcing jobs (`--from` now also
  accepts the harness's own `measured:` rounds).
- **Marketplace plugins render with all of their styles on a live site.** A plugin installed from the
  marketplace is loaded at runtime from its own bundle, and a release build only compiled the Tailwind
  classes of the plugins git tracks, so every class only a plugin used was missing in production while
  development looked right. On an iPhone the conference-manager meal scanner was a transparent band over
  the page with a white dot for a frame (`bg-black`, `bg-black/80`, `w-[82%]`, `aspect-[2.6/1]` did not
  exist). `build-plugin.js` now compiles the classes a plugin's sources use with the Tailwind v4 already in
  the repository (`backend/scripts/plugin-stylesheet.js`: the host's theme, no preflight, not scoped so
  portalled overlays get them, byte-identical across rebuilds). Every compiled rule is nested ONE cascade
  sub-layer below the host's own (`@layer utilities { @layer wjs-plugin { … } }`, likewise the theme), so a
  plugin sheet can add the classes the host lacks but never restyle the host: a flat copy, linked after
  the host CSS, made its `.flex`/`.hidden`/`.fixed` beat the host's `md:` variants, and a desktop showed
  the phone layout of the admin (mobile header, sidebar fixed over the page, no collapse toggle) on a
  plugin page, on every admin page with mail-server's hooks, on public pages with a plugin block. The
  price on a core that did not compile the plugin's classes: a plugin-only variant (`sm:text-sm`) loses to
  a host base class (`text-base`) on the same element. They ship where the host already
  loads plugin CSS: the catalog, `pack:plugin` and `wordjs pack` put the plugin's own `admin.css` followed
  by the compiled classes at `client/admin/admin.css` (the file every released admin shell links, so an
  updated plugin is styled on an older core too), block and hooks bundles get them in
  `dist/<name>.bundle.css`, and the runtime loader now links the hooks stylesheet. `verify-marketplace.js`
  refuses a package without them. Rebuilding or re-packing an installed plugin keeps exactly one compiled
  block (it used to stack one more per cycle); class names whose arbitrary value holds quotes
  (`content-['']`, `font-['Inter']`, `bg-[url('…')]`) are found; a missing host stylesheet stops the build
  instead of silently dropping the host's theme tokens, and a test pins that the plugins and the host
  compile with the same Tailwind. `dist/component.bundle.css` on the `/plugins` mount and
  `client/admin/admin.css` from `GET /api/v1/plugins/:slug/admin-style/css` (see Security; it reaches
  every signed-in user who can open the plugin's page, not only administrators) are served `no-cache`
  with their ETag (was `max-age=3600`): their URLs carry no version, and for up to an hour after an
  update a browser ran the new bundle with the old classes. The host stylesheet also scans
  the first-party catalog sources (`@source "../../../marketplace/plugins/**/*.{ts,tsx}"`, about +5 KB
  gzipped), which puts the catalog's own variants in the host's order on a newer core and keeps an older
  package styled there. Every catalog package now carries its compiled classes, and installed copies
  receive them with the patch version this release offers each catalog plugin (the `browser:script`
  bump above). `wordjs pack` honours `WORDJS_PLUGINS_DIR`, like `build-plugin.js`.
- **The admin no longer slides and bounces as a whole on iOS.** The shell and the sidebar were `h-screen`
  (100vh, the LARGE viewport on iOS), so the document was taller than the screen and a drag moved the
  whole page, header included. They are `h-dvh` now; the admin document does not overscroll vertically
  (`overscroll-behavior-y: none` on `html`/`body`, horizontal left alone so desktop swipe-back keeps
  working); the generated plugin page wrapper contains its own overscroll; the mobile header drops a
  `sticky` that never stuck. The admin exports `viewport-fit=cover`, so `env(safe-area-inset-*)` works for
  full-screen plugin UI, and the shell, the header, the fullscreen editor and the toast stack keep
  themselves clear of the insets, so nothing moves under the notch in landscape or under the home
  indicator. Desktop is unchanged (the insets are 0 there).
- **Chromium browsers can open the camera for the conference-manager meal scanner.** The site sent
  `Permissions-Policy: camera=()`, which Chrome, Edge and every Android Chromium browser enforce: the
  camera was refused before any prompt, and the scanner asked the operator for a permission no setting
  could grant. Safari does not enforce the header, which is why iPhones still got a picture. The policy is
  now `camera=(self)` on every route: the site's own pages may ask (the browser still prompts), embedded
  third-party frames may not, and the microphone, geolocation and the Topics API stay denied. It is one
  value for every route because a document keeps the policy it was loaded with, and the admin is usually
  reached by a client-side navigation from `/login`.
- **conference-manager 2.15.1: the phone scanner shows whatever it reads, and every plugin dialog works on
  a phone.** On an iPhone in production the meal scanner reacted to nothing, a product box included, and
  the «Nueva conferencia» form opened under the admin header.
  - **Scanner.** Its structure is inline (black, full screen at z-6000, opaque bars padded by the
    safe-area insets, the 82% × 2.6:1 aiming frame with a sweeping scan line), so it no longer depends on
    compiled plugin classes; the page behind is pinned the way iOS honours (`position: fixed` at
    `-scrollY`, restored on close) and the camera area takes no pan or pinch. The built-in reader (iPhone
    Safari has no `BarcodeDetector`) reads EAN-13, EAN-8, UPC-A, UPC-E (number system 0: a number-system-1
    UPC-E is bar for bar half an EAN-13, and a box half out of the aiming band or under glare read as a
    wrong number) and Code 39 besides Code 128, and
    decodes the band under the aiming frame at the camera's full resolution (1920×1080 requested) instead
    of a downscaled whole frame. Nothing read is dropped any more: a value that is not a registration code
    shows «Código leído: … — no es un código de inscripción» with its symbology and is never posted
    (2.15.0 could turn an EAN-13 into a 10-character "code" by stripping its 0s and 1s); an unknown
    registration code still gets «Código no encontrado». `BarcodeDetector` is asked for every format it
    supports. A heartbeat driven by the decode loop shows «Escaneando…» until the first frame is analysed,
    then «Escaneando · N cuadros/s», or «En pausa»; «La cámara no entrega imagen» with «Reintentar» after
    2 seconds without an analysed frame (a slow native `detect()` in flight, such as the first one on a
    low-end Android, does not count), and «Toca para activar la cámara» when `video.play()` is refused (Low
    Power Mode). The scan line moves with `transform`, so it keeps moving while the built-in reader holds
    the main thread, and the loop waits at least as long as the last decode took. Bars, cards and buttons
    stay clear of the notch in landscape. The beep's audio context is
    unlocked inside the tap that opens the scanner and on every press in it; a hint gives the focus
    distance (15–20 cm).
  - **Dialogs.** Every modal and sheet of the plugin renders through one `Overlay`: portalled to `<body>`
    in the 6000 band (above the admin header and sidebar, below the toasts, the old stacking order kept),
    scrolling itself at `100dvh`, anchored to the bottom on a phone and centred from 640px, with the page
    behind pinned, 16px fields (no iOS zoom), date inputs that can shrink, compact paddings and the
    home-indicator inset on a phone; it closes only on a press that starts and ends on the backdrop. Fields
    autofocus only with a mouse, so the keyboard no longer covers a dialog as it opens. A card capped at
    `92vh` is capped by the dynamic viewport instead (`vh` is the large viewport on iOS, and its Guardar
    footer started below the screen). On a desktop the sidebar is now dimmed behind a plugin dialog too (it
    used to stay clickable above the old z-100 backdrop).
  - **Conference list.** It no longer asks a third-party host for a decorative texture: once the host
    stylesheet compiled the catalog's classes, `bg-[url('https://grainy-gradients.vercel.app/noise.svg')]`
    became a request to that host from every admin who opened the list (it answers 402, so it never even
    painted).
    `catalogClassAssets.test.ts` keeps every catalog source the host compiles free of `url()` to another
    host.
- **Core admin dialogs open above the admin chrome at every screen width.** They were `fixed inset-0 z-50`
  (or `z-[100]`) inside the page, under the admin shell (5000–5003): on a phone «Nuevo Usuario» opened under
  the header with its close button cut off, and on a desktop the sidebar was not dimmed and its collapse
  toggle sat on the dialog's corner. These dialogs now render on `<body>` through one `DialogLayer` with
  one stacking scale (`frontend/src/lib/adminLayers.ts`): shell < dialogs (6000) < plugin overlays
  (6010–6090) < a dialog over a dialog (6100) < select lists (6500) < toasts. Moved: the shared confirm/alert
  dialog (also used for unsaved changes and the media and menus deletes), which no longer opens underneath a
  plugin's own overlay or the media lightbox; the one-time secret dialog (tokens, webhooks, two-factor
  setup); the media picker; the user form; the seven dialogs and the detail drawer of the Plugins screen;
  the Marketplace install confirmation; the database-migration overlays, which now also cover the sidebar
  during a migration or restart; the media lightbox; and the site-address dialog. They keep the admin's
  left-to-right direction once outside its layout, and the moved cards are capped with `dvh` so their footer
  stays on screen on iOS. A test refuses a new page-local `fixed inset-0` overlay in the admin.
- **Select lists always fit the visible screen, and show every option whole whenever they can.**
  `ModernSelect` and `ui/Select` share one placement rule (`frontend/src/lib/dropdownPlacement.ts`). A list
  opens below the field when the whole list fits there, otherwise above the field's label (above the field
  itself only when it has no label). Opened from a dialog, it tries the dialog's scrolling body first, then
  the dialog's card, then the screen. When the list does not fit as things are, the dialog's body scrolls
  by the few pixels that let the whole list fit beside the field; the field stays in view and a page is
  never scrolled. Only when the whole list fits nowhere beside the field does it go over the field's label,
  covering all of it. A list is shortened and scrolls inside only when not even that fits. On an iPhone SE,
  in «Nuevo usuario» scrolled to the bottom, the role list was clamped to 300 px and its last option,
  «Equipo de conferencia · plugin conference-manager», was cut at the list's edge; it is now whole. On an
  iPhone 13 the list's top edge cut the dialog's subtitle in half; it now stays inside the dialog's body.
  The list follows the visible viewport, so the on-screen keyboard and zoom count, and it is placed again
  once its real height is known. The role list no longer runs past the dialog and the bottom of the screen,
  and long option labels wrap instead of being cut off. The group headings «ROLES DEL SISTEMA» and «ROLES DE
  PLUGINS» meet WCAG AA even over a dark page behind the translucent list (they were 2.5:1), and so do the
  empty-list line and the placeholder.
- **Plugin grant screens: the note under a plugin role that users already hold matches the grant.** While
  `roles:declare` is granted it only counts the holders ("Held by N user(s)") instead of saying they "get
  its permissions back when you grant this". When the grant is not in effect, the note no longer says the
  holders come from an earlier installation only: they may also have been given the role before the
  permission was revoked. The platform's description of `roles:declare`, shown in every state, no longer
  talks about an earlier installation either. Each role's slug and permissions meet WCAG AA (they were
  2.5:1) and the permissions line is labelled (es/en/pt).
- **Plugin grant screens on a phone: identifiers no longer break in the middle.** A role slug, a permission
  and a token were `break-all`, so a phone broke them at any letter («conference_manage|r_team»,
  «conference_manager_acce|ss»). Each one now moves to the next line whole when it fits there, and a longer
  one wraps only after a `_`, `:`, `.`, `/` or `,`. The same applies to the token in the plugin detail
  drawer and the slug on a broken plugin's card. In the Permissions dialog, a permission's description, the
  plugin's reason and the declared roles now use the row's full width on a phone. They had stopped about
  75 px short of the card's edge, beside the switch.
- **The plugin activation dialog says what activating grants.** Activating grants a plugin's requested
  permissions only while no administrator has decided its grants, so a permission revoked earlier stays
  revoked (by design), and so does a revoke of every grant: `GET /plugins` reports which applies as
  `activationSeedsGrants`, since an empty grant list alone cannot tell a plugin that was never activated
  from one whose every permission was switched off. The dialog still listed such a permission like the
  others under "you are granting it strict access to these system capabilities", and for `roles:declare`
  said the role's holders get its permissions back; the
  plugin was activated without it and a team member kept landing on their account page. Such a permission
  is now drawn neutral with "Stays off: … grant it in Permissions", the note under the role says
  activating does not give its permissions back, the footer says activating keeps the grants on record, and
  the "This plugin runs code in your browser" banner is not shown when `browser:script` stays off.
  The Marketplace install confirmation no longer says "nothing is granted automatically": it says
  confirming the activation dialog grants what it lists, and that an update keeps the grants on record.
- **The plugin grant screens are in the admin's language.** The activation dialog, the Permissions dialog,
  the detail drawer and the plugin card showed the platform's labels and descriptions of every permission,
  the risk badges, "Plugin says:", "WordJS note:", the Permissions dialog's title, intro and buttons, and
  "granted"/"denied" in English. `permMeta(token, t)` reads `perm.<token>.label` / `.description` (es/en/pt),
  for every permission a plugin can request, `posts:read`, `comments:read`, `comments:pii`,
  `notifications:read` and `media:private_read` included.
  The token next to each label, "Plugin says:" and the activation footer meet WCAG AA (2.1:1, 2.6:1 and
  2.2:1 before).
- **«Nuevo usuario» is in the admin's language and readable.** The user dialog said «New User», «Role»,
  «Cancel», «Save User» and the rest in English; its labels and helper text, and those of the full-page
  user editor, were gray-400 on white (2.6:1) and are now WCAG AA.
- **The admin names a user's role instead of showing its slug.** The sidebar's user chip, the identity card
  of the account page and the Role column of the Users list showed the raw slug («ADMINISTRATOR» in a
  Spanish admin, «CONFERENCE_MANAGER_TEAM» on a plugin team member's own account page, while the sidebar
  said «EQUIPO DE CONFERENCIA»). A core role is named in the admin's language and any other role by its own
  name. `GET /auth/me` now returns that name as `roleName`, and the Users list reads it from `GET /roles`,
  which is administrator-only.
- **Square icon boxes stay square.** Next to long text, an icon box in a flex row shrank into a pill: the
  stat cards (18–30 px wide instead of 56 at 1280 px, labels clipped to «INSCRIP», «HOTELE»), the dashboard's
  «Comentarios Recientes» and quick-action icons, the system-status icons and the sidebar logo. Every square
  icon box of the admin (every screen, its dialogs and the shell), the shared components, the coordinators'
  portal and conference-manager now keeps its size (a test refuses one that can shrink);
  `StatCard` and `ActionCard` labels wrap instead of being cut («Agregar una nu…»), and so do the dashboard's
  system-status values («Conectado (…»). «Aún no hay comentarios» meets WCAG AA (it was 1.56:1).
- **No dashboard label breaks inside a word.** At 1280 px the system-health panel is about 565 px wide
  beside the sidebar and the comments column, and its three columns, chosen by the window's width, left
  «ALMACENAMIENTO» a 72 px line: it broke «ALMACENAM» / «IENTO» and its status dot touched it. The stat
  cards at 1024 px («PUBLICACIONES») and the quick actions («Publicación») had the same flaw. The
  dashboard's grids now pick their columns by their own width (container queries,
  `frontend/src/lib/dashboardStats.ts`): the health indicators one per row, or three side by side from
  48rem; the stat cards one, two or all in a row (four never three-and-one); the quick actions two from
  30rem. Each threshold keeps the widest word of every label whole in es, en and pt, and the status dot
  keeps a gap beside its label. «Comentarios recientes» sits beside the main column from 50rem of the
  page's own width (at 1024 px its title had about 61 px and was cut by the card; it now goes under the
  main column there, and comes back beside it when the sidebar is collapsed). The header's small health
  pill no longer wraps «SQLITE-» / «NATIVE». The welcome line, that pill, the chart's subtitle and period
  buttons and the comment dates meet WCAG AA.
- **The admin shell's edges on a phone.** The closed phone menu no longer casts its shadow onto the page's
  left edge; the sidebar logo's glow is no longer cut to a hard box; the phone header's bottom rule is light
  grey instead of black (a bare `border-b` is `currentColor` in Tailwind v4), which also showed, sharp,
  through the edge of every dialog's blurred backdrop.
- **The admin sidebar and phone menu draw no heading over an empty section.** A team member whose plugin
  lost `roles:declare` saw an empty «Principal» heading.
- **The dashboard hides the numbers and panels the viewer cannot read instead of showing 0.** The users
  count needs `list_users`; the comments count and the recent-comments panel need `moderate_comments` (a
  contributor or author saw 0 comments and an empty panel; the main column now takes the full width); the
  activity chart and the system-health panel are for administrators, like their endpoints (a
  non-administrator saw an empty chart and a 403). A non-administrator role holding `manage_options` no
  longer gets every count left at 0: the system-health request it could not make rejected the whole load.
- **conference-manager 2.17.0 on phones: the conference screens scroll with the page.**
  - **Scrolling.** Below 768 px wide or 600 px high the title, the tabs and the white panel take their
    natural height, so the screen scrolls with the admin's plugin page. Before, every tab, Campos and Equipo
    y permisos included, scrolled inside a fixed box about 500 px tall that cut headings and buttons. The
    rules are rendered by the component itself (`client/lib/phoneLayout.ts`), so they do not depend on
    compiled plugin classes. Below 640 px the panel paddings are compacted. The desktop keeps the fixed
    panel and the fields beside the preview. After a reload the tab strip scrolls the saved tab into view.
  - **Campos.** Publishing a form with no field is refused next to «Publicar» instead of in a toast, which
    stayed on top of the «Nuevo campo» dialog opened to fix it; opening that dialog or adding a field
    clears the notice. The intro no longer says the preview is "on the right" (it is below on a phone), and
    it and the published-form text are translated (es/en/pt). On a phone a field card shows its move, edit
    and delete buttons in a row under the label instead of a column of four, and the form card and the
    empty state use smaller paddings. Below 640 px the builder card puts its icon above «Constructor Visual
    de Formularios» (at 320 px «Formularios» was cut at the card's edge), and so does the «Localidades»
    public-link card. Those cards, each location card and the form preview's header keep their decorative
    blobs in a clipped layer of their own: a blob hanging below the `overflow-hidden` card gave it 80 px to
    scroll, and bringing the «no puedes publicar» notice into view scrolled the card's own content up inside
    it on an iPhone SE, cutting the title and the wand icon, with nothing able to scroll it back.
  - **«Nuevo campo».** The «Campos básicos» hint, the templates' descriptions and notes, the form's labels
    and helper lines, the «O un campo propio» divider and the placeholders meet WCAG AA (2.6:1 and 1.5:1
    before). A template already in the form is no longer faded to half opacity: it shows a check mark and
    says where the field is, readable. The close button has an accessible name.
  - **Equipo y permisos.** The role editor's sections × levels table fits a phone: each section is a row
    with its three levels side by side, each labelled. Before, a 560 px table scrolled sideways inside the
    dialog and only «Sin acceso» was in view. The header row (Sección, Sin acceso, Ver, Gestionar; the three
    levels on a phone) now stays at the top of the editor while the eleven sections scroll under it, on a
    desktop and on a phone; it used to scroll away, leaving the radio columns unlabelled. The table layout
    starts at 680 px, where its 560 px fit without a sideways scroll. The screen's labels, hints and notes
    meet WCAG AA, and its icon-only buttons (edit, delete, close, remove) 3:1. The notes under a team member drop their indent on a phone.
    In the «Añadir una persona al equipo» results, a person's name, email and WordJS role keep at least
    12rem, so «Ya está en el equipo» wraps under them instead of overlapping a role chip squeezed into four
    lines (iPhone SE); emails break only where they must («ana@ex / ample.test» before), there and in the
    team list.
  - **Panel.** The stat cards take as many columns as fit (six fixed columns at 1280 px clipped their
    labels), and the conference status is translated («ACTIVE» before).
  - **Tabs.** The conference tab strip fades out on the side that has more tabs, instead of cutting a tab at
    its edge with nothing saying it scrolls. A tab tapped at the strip's edge is scrolled out from under the
    fade: on an iPhone SE, «Campos» and its underline stayed faded out until a reload. The «Alimentación»
    sub-tabs, which have the same fade, now keep their active tab in view too.
  - **Dialogs.** On a phone, a dialog taller than the screen keeps its title and close button pinned at the
    top while it scrolls, and its Cancel / Save row pinned at the bottom. This covers «Crear conferencia»,
    «Nuevo campo», the inscription, hotel, room, price-rule and location forms. On an iPhone SE, with the
    fee field in view, the «Crear conferencia» title was cut at the top edge; at the top of the form,
    «Crear conferencia» was cut at the bottom. A focused field is scrolled into view clear of both pinned
    rows. The desktop is unchanged.
  - **Scanner.** A camera that cannot open says why in the admin's language instead of the browser's
    English message («Not supported»); the service in the top bar takes up to two lines, so its own label
    is no longer cut to «Almuerzo — Al…».
  - **Reload.** After a reload the plugin reopens the conference you were working on; it reopened the
    newest active one.
  - **Conference list.** «Comenzar nuevo evento», «Estadísticas» and the card descriptions meet WCAG AA
    contrast, and «Comenzar nuevo evento» is translated (es/en/pt). The card footer wraps, so «Gestionar»
    no longer runs into the stats label or out of a narrow card. The delete button has an accessible name.
- **One query for the parent entries of a media page.** The media list's per-item visibility check
  resolved each parent with its own `Post.findById` — up to 100 lookups per page. The page's parents are
  now loaded with a single `IN` query (`Post.findByIds`).
- **Editing-presence rooms are reclaimed.** `POST /api/v1/presence/:postId` keeps one in-memory room per
  post, and only an explicit `leave` deleted one. An editor that closed the tab without sending it (a
  crash, a dropped beacon, lost network) left its room in memory for the life of the process. A periodic
  sweep now removes rooms whose editors have all expired. It runs only while rooms exist and does not keep
  the process alive.

## [2.3.0] - 2026-10-07

### Security

- **Production dependencies updated for the advisories that blocked every CI run.** Next.js 16.3.6
  (critical: RCE in `next/og` `ImageResponse`), proxy-addr 2.0.8 (critical: IP spoofing through an
  IPv4-mapped IPv6 trust subnet; via Express 4.22.3), shell-quote 1.12.0 (critical, under `concurrently`),
  nodemailer 10.0.15 with mailparser 3.9.36 and smtp-server 3.19.17, adm-zip 0.6.1, sharp 0.35.5,
  compression 1.8.2, axios 1.20.0, brace-expansion 5.0.12, source-map-js 1.2.2 and js-yaml 4.3.2. Express
  stays on 4.x.
- **Cluster enrolment verifies the CSR signature with Node's crypto instead of node-forge.** Every
  node-forge release is affected by advisory GHSA-86w9-cpqp-85rv (its RSA PKCS#1 v1.5 verifier accepts
  extra nested DigestAlgorithm elements) and none is fixed; the gateway's proof-of-possession check was the
  only place WordJS verified a signature with it. Enrolment now accepts `sha256WithRSAEncryption` CSRs only,
  and `node-join` asks openssl for SHA-256 explicitly.
- **The CI audit gate can carry a dated, per-advisory exception** (`scripts/audit-exceptions.json`) for an
  advisory with no fixed release anywhere: one advisory id on one package, with the reachability reasoning,
  expiring at most 60 days after it was added and printed as a workflow warning on every run. The node-forge
  advisory above is the only entry (until 2026-11-05); a test fails if a node-forge signature verification
  returns to the code.
- **The release packager no longer names private plugins in its public source.** `scripts/make-release.js`
  kept two private, untracked plugin directories out of the bundle by listing them in `IGNORE_PATTERNS`,
  which published in the repository the names it was meant to protect. They are now kept out without being
  named: the packager already drops everything git does not track, and for a tree where git cannot answer it
  reads extra exclusions from `.release-exclude`, a gitignored local file that is itself never bundled. A
  test packages a throwaway repository and checks that untracked plugin and theme directories — and the
  paths listed in `.release-exclude` — do not reach the bundle, and fails if the packager names an
  individual plugin or theme.
- **The site has one main address and any number of other addresses; every other name gets `421`.**
  The migration guard (409 `migration_required` plus a `/migration` page that asked for an administrator
  password on any host and repointed the site at the request's `Host`) is replaced by a host policy
  (`backend/src/core/host-policy.js`, byte-identical copy in the gateway) and a single writer
  (`core/site-address.ts`). The main address (`siteUrl`) is the only base for links built outside the
  browser, and it changes only through **Settings → Site address** (administrator browser session, MFA
  policy, current password, revision check, audit, a notice to every administrator) or on the server with
  the new **`npm run site`** CLI (`list`, `check`, `add`, `remove`, `canonical`, `ip-literals`,
  `ip-signin`). Other addresses (aliases, optionally expiring or redirecting with a 308) are declared in
  the same places or in `WORDJS_ALLOWED_HOSTS`; loopback and IP literals are always answered, because they
  cannot be used for DNS rebinding (`hostPolicy.ipLiterals` / `WORDJS_IP_HOSTS` narrows that, and an IP
  that arrives through an untrusted proxy is refused). An undeclared name gets `421 rest_host_not_allowed`
  with no redirect on every API path, `/api/v1/setup/*` included once installed, and — at the monolith and
  gateway edges — a static 421 page for pages, static files and WebSockets too; a malformed or repeated
  `Host` gets `400`. In split and separate mode the backend pushes the policy to the gateway
  (`POST /host-policy`, mTLS CN `backend`) after every change, at boot, after registering, and every
  30 seconds from then on, so a gateway that comes back without its stored policy is armed again within
  about 40 seconds (a worker started on an unreadable policy file says it holds none, instead of claiming
  to keep the last good one, and one whose file is deleted says once that it now enforces nothing); an
  unchanged push rewrites nothing, and the gateway answers with what its
  edge refused, which **Recently refused** lists next to the backend's own refusals, each entry labelled
  with who refused it (edge, backend or both); that periodic push only
  arms a gateway holding no policy, so backends whose settings differ cannot make the edge switch between
  them. Every change is audited, one row per revision, committed in the same transaction as the revision:
  those made with `npm run site` too, from a 20-entry change log in the config (older ones the backend
  never applied become `site.address.gap` rows), also when an admin-screen change overtakes them,
  `--force` and **Change anyway** with what they went past; administrators get one notice per batch, which
  names the IP sign-in switch, a main address confirmed rather than moved, and an upgrade conflict it ends
  (`npm run site` prints the same sentence for the revision it saved).
  Writers of `wordjs-config.json` hold a lock file, so two of them never both save the same revision.
  `X-Forwarded-Host` / `-Proto` are believed only from a trusted hop (the mTLS gateway, a loopback peer
  that addressed a loopback name, or an address-based `trustProxy` peer, whose forwarded host is believed
  only when the `Host` it sent is an IP, loopback or single-label name), which closes the `127.0.0.1:4000`
  forged-`X-Forwarded-Host` rebinding path; the gateway also drops a client's `X-Forwarded-Proto`. The
  edges apply that same rule (the backend's own function), so they judge the address the backend judges
  and forward exactly that one, an empty `X-Forwarded-Host` from a local hop included (http-proxy's `xfwd`
  replaced it with the hop's own loopback `Host`, which the backend judged as loopback; the gateway now
  removes that `Host` before proxying, so this holds for a request with `Expect: 100-continue` and for one
  that waited for an upstream connection too, and Next.js's per-user server-side reads pass the empty value
  on as well). Probes (`/healthz`, `/health`, `/readyz`, `/metrics`) and ACME challenges
  (`/.well-known/acme-challenge/<token>`) stay answered on any address, matched exactly: a path below them
  or with `..` is checked like any other. A path with a dot segment or a backslash gets
  `400 rest_invalid_path` at the edges, and Next.js rewrites are case-sensitive, so no request reaches the
  API through Next's own rewrite. Sign-in on an address other than the main one follows new rules in production: IP literals, tunnel
  names and `.local` names are off by default (`hostPolicy.ipSignIn` / per-alias `signIn` opt in), and on
  an https site the connection must really be https (`403 rest_insecure_transport`). Every session except
  a loopback one is bound to the address it was started on, the main address included: removing that
  address (or dropping the old main address in a move) revokes its sessions, a refresh keeps the
  binding, and a session from an address other than the main one cannot mint API tokens. A removal made
  in Settings → Site address or with `npm run site` is recorded, so adding the address back does not
  revive its sessions, a sign-in in the five seconds after a retirement answers `503 rest_address_retiring`
  with `Retry-After` instead of handing out a cookie that is already dead (judged on the config file as it
  is at that moment, so a removal and re-add made with `npm run site` within the two-second config cache
  counts too; the installer's auto-login is skipped instead), and a session that is already dead cannot
  sign its user out elsewhere. Behind a gateway, `ipLiterals: own` means the gateway's own
  addresses, which it reports in its answer to every push: the backend's gate, its session check and the
  sessions a narrowing ends use them (`npm run site` too, from `backend/data/gateway-own-addresses.json`;
  its `list` and `check` say which list they judged with), so in separate mode a session started on the
  backend node's IP no longer outlives a narrowing that the public edge applies. The report is kept only
  as unicast IP literals, at most 64, and dropped when a gateway too old to send one answers and when a
  monolith boots; Settings → Site address then calls the `own` choice "Only the gateway's addresses". The
  backend's calls to the gateway's control plane (certificate uploads, the TLS switch, the address and
  policy pushes) now also check that the peer presents the gateway's certificate CN (`gateway-internal`
  or `gateway`), not just any certificate the cluster CA issued for `localhost`. A session
  from an address other than the main one also cannot create or change another user's account, import
  accounts, or change roles, the two-factor policy or who may register (`403 rest_account_bound_session`);
  a site import never writes the two-factor policy. No session is started on a request without a `Host`,
  and a host-less cookie write fails the CSRF check whatever its `Origin` says. Reset and verification links, feeds, the sitemap and plugin `site.url()` never
  come from the request any more; `PUT /settings` refuses `siteurl` / `home`; `POST /setup/migrate`
  answers `410`. After an SSL toggle in split mode the main address follows the same host from http to
  https at once (audited) instead of at the next restart. Guide: `documentation/site-address.md`.

  **Upgrading.** Nothing to migrate by hand: at the first boot the config and the database are
  reconciled, and if they name different main addresses nothing is written and administrators get a
  banner to choose either one (or `npm run site -- canonical <url>`, the config's own address included).
  A fresh install records itself as revision 1 (`lastChange.kind: "install"`). No name is accepted automatically, so declare any other name browsers use (a `www`
  twin, a LAN name) or it gets 421. A reverse proxy must forward the browser's `Host`
  (`proxy_set_header Host $host`). A frontend replica that reaches a backend directly
  (`WORDJS_BACKEND_URL`, or SSR via `internalApiUrl` to another machine) needs `WORDJS_TRUST_PROXY` on that
  backend set to the replica addresses, or every proxied call is 421. `WORDJS_SITE_URL` is now only the
  install wizard's suggested address (its new **Site address** field is prefilled from the address being
  browsed). The Helm chart exports `WORDJS_ALLOWED_HOSTS` from `siteUrl`, the ingress hosts (new
  `ingress.extraHosts`) and the new `allowedHosts`, and `trustProxy` as `WORDJS_TRUST_PROXY`.
- **The site-address code paths cannot be used to forge log lines or to make a request read slowly.** The
  `for=` values of a `Forwarded` header are read in a single left-to-right pass instead of a backtracking
  pattern whose value class also matched the port's characters; a test checks that the scan gives the
  pattern's exact answers on random headers and stays linear on long hostile ones. A new
  `core/log-safe` turns a logged value into one inert line (line breaks, other control characters, ANSI
  escapes, Unicode line separators and bidirectional controls removed); the CSRF guard's refusals, the
  site-address warnings, every certificate-manager and certificate-route error and the ACME renewal
  warning now log through it, and an error is logged by
  its message and code instead of as an object. The backend's control-plane calls to the gateway carry the
  node's mTLS key and certificate in one TLS context instead of as request options.
- **Remaining dependency advisories with a fix are closed.** Frontend: DOMPurify 3.4.16 (GHSA-p98j-92pf-mc4p,
  GHSA-6688-9rhm-gjv2), and js-yaml and brace-expansion moved to fixed releases in the lint toolchain;
  `@tailwindcss/typography` is removed — nothing loaded it (Tailwind 4 needs an `@plugin` line, and there is
  none), and it pinned a `postcss-selector-parser` affected by GHSA-rj75-hqrm-r3gf. Root workspace: `uuid` is
  overridden to 11.1.1 under `autocannon` (GHSA-w5hq-g745-h8pq), as the frontend already did. Every workspace
  now audits clean for production dependencies apart from node-forge (no fixed release; dated exception
  above). Left as they are: `braces` in the frontend lint toolchain (development only, no fixed release) and
  `file-type` in the backend (GHSA-5v7r-6r5c-r473, moderate; the fixed line requires Node 22, and the upload
  path already bounds detection by size and time).

### Added

- **Conference Manager 2.3.0 — every location has a maximum number of registrants.** The cap is required when
  a location is created and can be raised or lowered afterwards, never below the people already registered
  (the request is refused with the current count). A full location refuses new registrations from the
  coordinator portal and from the admin, including moving an attendee into it or reinstating a cancelled one;
  cancelling or deleting an attendee frees the seat. The admin cards show taken / maximum with an inline
  editor; the portal shows the count and closes its form when the location is full. Locations created before
  this version have no limit until one is set.
- **Conference Manager 2.4.0 — forms of payment per location.** The plugin now accepts exactly two forms of
  payment, cash (`Efectivo`) and bank transfer (`Transferencia`). When a location is created the admin picks which of
  them it receives (both by default) and can enable or disable either one later from the location card. The
  coordinator portal only offers the enabled ones and the server refuses a payment recorded with a form the
  location does not receive; the admin's own entries must name one of the two. Locations created before this
  version receive both.
- **Conference Manager 2.5.0 — lodging per location: the coordinator arranges, the admin validates.** The admin
  allots hotel rooms to a location (a whole hotel or a selection of its rooms); the coordinator portal gains a
  *Hospedajes* tab where the coordinator places their own attendees into those rooms by hand or with the automatic
  assignment, driven by the admin's rules plus the location's own rules, and then submits the arrangement. The admin
  reviews it (rooms, unplaced attendees, every broken rule — split families, mixed rooms, missing companions,
  over-capacity) and validates it, returns it with observations or reopens it. A submitted or validated
  arrangement is protected: its rooms cannot be deleted, shrunk or re-allotted and its attendees cannot be moved
  until the admin reopens it. The admin keeps everything it had: the conference-wide automatic assignment still
  covers every location (each with its rooms and rules) and the manual assignment still reaches any free room the
  attendee may occupy. Rule predicates are now validated against the form's fields on both the admin and the portal
  route, and the state changes are single conditional updates.
- **Conference Manager 2.6.0 — a deadline for the coordinators' lodging arrangements.** The admin sets a date on
  the conference (Localidades page); until that day, inclusive, coordinators arrange, submit or withdraw their
  lodging from the portal. Afterwards every portal lodging change is refused with the date in the message, the
  portal shows the arrangement read-only with a notice, and only the administrator changes it — the admin's own
  tools are not affected. No deadline means no limit; the date can be moved or removed at any time.
- **Conference Manager 2.7.0 — first-match rules, an editable lodging board, drag & drop.** Assignment rules now
  work first-match: they are consulted in priority order and the first one that applies wins a conflict, so a
  family kept together by a higher-priority rule may share a room across genders without the gender rule being
  reported, and a family divided by a higher-priority gender rule is reported as information, not as a broken
  rule — in the assignment report, the admin review and the coordinator portal alike. The admin's Assignment
  page gains an always-visible *Acomodación* board (every hotel, room and occupant, the unplaced attendees
  grouped by location, a search and a location filter) where attendees are moved by drag & drop or through a
  room picker, honouring every server rule (capacity, allotment, frozen arrangements, cancelled attendees). The
  coordinator portal gains the same drag & drop in its Hospedajes tab, and its whole interface now shares the
  admin's design language.
- **Conference Manager 2.8.0 — per-location permission after the lodging deadline.** Once the conference's
  lodging deadline has passed, the admin can let one location keep arranging (and submit or withdraw its
  arrangement) from the location card: until a chosen date, inclusive, or until the permission is revoked.
  Every other location stays closed; a submitted or validated arrangement still has to be withdrawn or
  reopened first. The portal explains whether the location is working under such a permission, and an
  expired permission is named in the refusal. The admin's own tools are never limited by the deadline.
- **Conference Manager 2.9.0 — a unique registration code and barcode per attendee.** Every attendee gets a
  random 10-character code (no ambiguous characters, drawn from the host CSPRNG) when registered from the portal
  or the admin, and existing attendees receive one at the next start. The code is shown only in the admin
  panel: a column in the roster opens its Code 128 barcode, which can be printed, downloaded as SVG or copied;
  the roster search finds an attendee by code and the CSV export includes it. No portal response carries it,
  no request can set or change it, and a unique index guarantees it is never repeated.
- **Conference Manager 2.10.0 — Excel exports.** A custom Excel export (Inscriptions and Reports pages) lets the
  admin pick and order the columns — every form field plus code, location, status, payment status, fee, paid,
  balance, hotel, room, registration date and admin notes — filter by location, payment status and cancelled
  attendees, and add a column with each attendee's registration barcode as an image; the choice is remembered
  per conference. A hotel assignment report (Reports and Hotels pages, or one hotel from its card) produces a
  summary sheet and one sheet per hotel listing every room, its allotment and occupants. The files are real
  .xlsx workbooks built in the browser without new dependencies; text that looks like a formula stays text.
- **Conference Manager 2.11.0 — transport, sold apart from the participation fee.** A new *Transporte* tab lists
  buses (name, origin → destination, departure, seats, price per seat) with seats sold, amount sold, collected
  and outstanding. The admin sells seats to attendees (never beyond the seats left, never to a cancelled
  attendee, never twice on the same bus); each ticket keeps the price it was sold at and is paid with its own
  payments (cash or transfer, with reference and date), so it has its own paid / partial / pending status and
  never touches the attendee's fee, payments or balance. A new price applies to future sales, or to the
  tickets already sold when asked (refused if it would fall below what a ticket already paid); a ticket or a
  bus with payments cannot be removed until those payments are. A transport workbook (summary + passenger
  list per bus, or one bus) and four transport columns in the custom Excel complete it.
- **Conference Manager 2.12.0 — accounting.** A new *Contabilidad* tab records the income and expenses of a
  conference (type, date, category, description, amount, form of payment, reference). The money the plugin
  already receives — validated registration payments and transport payments — appears automatically as
  read-only income, so the balance is complete without entering anything twice. Totals (income, expenses,
  balance) and a per-category breakdown follow the date, type, category, source and text filters; the
  filtered ledger exports to Excel (summary and entries).
- **Conference Manager 2.13.0 — a lodging explorer you can walk into.** Hotel assignment, in the admin and in
  the coordinator portal, now opens on the hotels (beds taken and free, rooms full or with space), enters a
  hotel to see every room with its occupants' full names and free beds, and enters a room to see each occupant
  in full: location, family group, document, email, phone, payment status, registration code and the
  conference's own fields. *Volver*, breadcrumbs and Esc step back one level; *Anterior / Siguiente* walk the
  rooms; the last hotel and room are remembered per browser tab (the search text and the gender filter are
  not: they never reach browser storage). From a room you assign people to a free bed
  (searchable, optionally moving someone from another room), move or unassign an occupant, with the same
  rules the server enforces (allotted locations, frozen or validated arrangements, capacity). In a
  women-only or men-only room the picker lists that gender first and flags the others. Everything the
  previous board did still works inside the explorer (dragging people from the unassigned panel onto a hotel
  or room, the location filter, pool rooms), and the lodging tile in the attendee view jumps to the room.
- **Conference Manager 2.14.0 — meals per location and per person, delivered with the attendee's barcode.** A
  new *Alimentación* tab defines meal services (breakfast, lunch or dinner on a given day, created in bulk
  from a date range) and a location × service matrix that says which locations get which meals — all of
  them or only some. Each attendee can be adjusted per service (inherit from the location, include, exclude).
  The *Entrega* screen records deliveries from the registration-code barcode: a USB or Bluetooth scanner
  types into a large always-focused field, and a full-screen *scanner mode* turns a phone into the reader
  (camera with torch and camera switch, Code 128 decoding via the browser's BarcodeDetector or a built-in
  decoder on iPhone and Firefox, screen kept awake, beep and vibration). Every scan gets a clear verdict —
  delivered, already received (with the time and who recorded it), not entitled (with *Deliver anyway*,
  recorded as authorized), cancelled or unknown code — and the server guarantees one delivery per person and
  service even when two phones scan at once. Live counters, the latest deliveries with undo, and a per-service
  report (per location, pending / served, Excel export) complete it.
- **Conference Manager 2.15.0 — a team with per-section permissions.** Several people can now work in the
  conference manager with their own WordJS accounts, each seeing only what their role allows. Roles are
  defined in a new *Equipo y permisos* view (administrators only): for each section — summary, registrations,
  payments, locations, lodging, transport, accounting, meals, meal delivery, reports and settings — a role
  gives no access, view-only access or full management. Two example roles are created on first use
  («Solo lectura» and «Cocina», which can only record meal deliveries). Members are WordJS users found by
  name, e-mail or login (the plugin asks for the users:read permission) and can be given another role,
  deactivated or removed, with immediate effect. Every route checks the caller's level on the server; the
  panel shows only the sections and actions the role allows, registration codes travel only with access to
  registrations, and deleting an attendee who has payments requires the right to manage those payments.
  WordJS administrators keep full access and do not need to be on the team.

### Changed

- CI runs once per event: `push` builds only `main` and the release tags (branch pushes are covered by
  `pull_request`), and a newer push to the same pull request cancels the run it supersedes.
- The backend coverage ratchet runs in its own CI job (`backend-coverage`), in parallel with the Backend
  job instead of re-running the whole suite as its last step, and `test:coverage` / `test:coverage:check`
  now wrap `npm test` instead of repeating its command line.

### Fixed

- **A plugin scaffolded with `wordjs create plugin` works out of the box.** The template's manifest
  requested only `settings` read/write while its `index.js` registers routes and an admin menu item, so a
  fresh plugin lost its routes and `adminMenu.add` threw on activation. The template now declares
  `express: register_route` and `admin_menu: register`.
- **Sessions issued right after the install survive the first restart.** A fresh instance signs with a
  per-boot random JWT secret until it is configured, and `POST /setup/install` generated a *different* one
  and wrote it to `wordjs-config.json` while the running process kept signing with the first — so the
  wizard's own auto-login and every login made before the first backend restart were answered `401
  rest_token_invalid` once the restart loaded the persisted secret. The same happened on an enrolled
  separate-mode node, where the installer also rotated away the secret `node-join` had written. The
  installer now persists the secret the process is already signing with, so the live and persisted values
  never differ and the live secret never changes mid-process (keys derived from it at load, such as the
  collaborative editor's replica identity, stay valid). **A `jwtSecret` written into a config before the
  install (by hand, `node-join`, `npm run setup`) is therefore now kept, where the installer used to
  replace it.** So that a weak value cannot become the permanent key, a not-yet-installed config's
  `jwtSecret` is replaced at boot, before anything signs with it, when it is shorter than 64 characters,
  not a string, or a placeholder printed in this repository (such as the `auto-generated-secure-secret` of
  the deployment guide's old example config, which the guide no longer shows). An installed site's
  secret is never rotated. Every JWT secret the backend generates (the per-boot one and the boot-time
  replacement) is now 64 random bytes, as the installer's was. Covered in monolith, split and enrolled-node
  modes by a backend test that installs, restarts and re-authenticates, including a session forged with a
  pre-seeded placeholder, and by the split-mode leg of `scripts/smoke-deploy.sh`.
- **Mail Server 2.2.3 — direct-MX delivery to a host with an invalid certificate takes the logged
  downgrade again.** The plugin verifies the MX host's STARTTLS certificate and, when that verification
  fails, retries that one host with verification off and logs `[MailServer][TLS]`. The check matched the
  error's `code` against the certificate-failure codes, but nodemailer rewrites `code` to `ESOCKET` for every
  socket error, so it never matched: mail to an MX with a self-signed, expired or mismatched certificate
  failed instead. The failure is now recognised from what nodemailer leaves intact — the verify reason Node
  puts in the message, anchored and only on the socket-error shape. The policy is unchanged: the same five
  failures (self-signed leaf or chain root, an issuer neither sent nor trusted, expired, hostname mismatch)
  and nothing else — a reset, a TLS protocol error, a refused connection or an SMTP reply quoting the same
  text is never downgraded, and the downgraded retry still upgrades to STARTTLS when the host offers it. A
  new suite drives each case through the real nodemailer against a local TLS server.
- **A release bundle packaged on a developer machine no longer ships that machine's site.** `npm run
  bundle-release` runs `next build`, which prerenders pages, and its server-side reads went to whatever
  backend the machine offered — `wordjs-config.json`, or `http://localhost:4000` without one. CI builds
  from a clean checkout with nothing listening, so published releases were unaffected; a local build with
  a dev backend running prerendered private content from that running dev backend into the bundle (its
  site title on every prerendered page, its posts as prerendered paths) and baked that machine's gateway
  into the `/api` rewrite. `.next/cache/fetch-cache` also carried an earlier build's backend answers into
  the next build. The packager now deletes `frontend/.next/cache` and builds with
  `WORDJS_HERMETIC_BUILD=1` (`frontend/hermetic-build.js`): server-side reads go to a base `fetch()`
  refuses outright (port 1 is on the Fetch standard's bad-port list) — still issued, so every page keeps
  the same ISR window a CI build gives it — and the rewrite is the compiled-in default whatever the
  config or `WORDJS_BACKEND_URL`/`WORDJS_MODE` say. The same flag closes the prebuild plugin registries:
  they used to ask the running backend which plugins are active and otherwise list every folder under
  `backend/plugins`, untracked private ones included, so `next build` compiled that machine's local
  plugins into the shipped `.next`; now they list only the plugins git tracks and ask nothing
  (`frontend/scripts/hermetic-plugins.js`). The shell's `NEXT_PUBLIC_*` variables are dropped from the
  build, and a `frontend/.env*` file that sets one stops it, since Next inlines those values. A post-build
  check (`scripts/release-hermetic-check.js`) then fails the bundle on any trace of a live backend — a
  fetch-cache entry, a path prerendered from `generateStaticParams`, a prerendered title other than the
  default `WordJS`, a non-default API rewrite — or on a plugin module git does not track in the generated
  registries; a check that cannot look (a missing registry, a page whose HTML is not where it reads it)
  fails instead of passing.
- **`/api/revalidate/<anything>` looped back into the public port.** Every dispatcher (gateway, monolith,
  frontend replica) handed everything below the Next-owned `/api/revalidate` to Next, which has no
  handler there and sent it through its own `/api/:path*` rewrite back to the gateway's port, which handed
  it to Next again: one anonymous request became an endless chain of loopback requests. Only the route
  itself (and its trailing-slash form) is Next's now; anything below it goes to the backend.
- **Monolith: one WebSocket request could start an endless loop of loopback connections.** Next.js attached
  its own `upgrade` listener to the public port on the first page request, so every upgrade was handled a
  second time, and its `/api` rewrite (baked into the build as `http://localhost:<port>`) proxied an upgrade
  to `/api/…` back into the same port, forever: about 500 connections a second and journald dropping log
  lines, from one anonymous `new WebSocket()`. The monolith's own handler is now the only `upgrade`
  listener (Next's goes to an emitter handed to it as `httpServer`, anything else that attaches is moved
  behind the handler, and the server delivers every upgrade to that handler alone); the only WebSocket
  served is Next's development HMR channel.
- **Conference Manager 2.2.0 — the plugin can be activated again, and 23 defects from a functional audit are
  closed.** Activation had failed since the 2026-08-15 hardening (a `DEFAULT '{}'` column definition was
  refused by the column-definition allowlist — fixed in core, see below). In the plugin: the portal's bulk
  payment is bounded (200 unique ids, batched by size) so a coordinator can no longer take the plugin down;
  portal isolation is keyed by the location **id** instead of its editable name (a one-off backfill maps
  existing attendees; location names are now unique per conference); number fields are canonicalised on the
  server for both entry surfaces and an empty required number is refused; editing an attendee re-prices and
  ignores a client-sent total; the portal shows the estimated fee before submitting; the admin menu is gated on
  the capability the routes require; dynamic field names cannot shadow real columns; the coordinator listing
  is an explicit projection; the assignment report names every violated rule incl. hard ones; a malformed
  row no longer 500s the roster; money is computed in integer cents with an upper bound; payments follow an
  explicit state machine with review audit and the proof must be an image; `is_unique` also holds on edit;
  LIKE wildcards are escaped; re-pricing and auto-assignment are paged and bounded; inscription status is a
  closed vocabulary. Core: a request body the sandbox bridge cannot serialise now answers `400` instead of
  reporting the plugin as not running.
- The plugin registry regenerator (the dev-HMR hop after activate/deactivate/delete) is inert under the
  test runner: it rewrote frontend registry sources from tests and echoed its output asynchronously to
  stdout, which corrupts node:test's result channel and made the flake-retry wrapper re-run the whole
  backend suite — three suites per CI job, past its timeout.
- **An "active" plugin whose files are gone is no longer a dead end.** A plugin directory left holding
  only build output — no `manifest.json`, no entry file — while `active_plugins` still named it put three
  surfaces in contradiction: the admin's Installed tab did not show it (the scan skips a directory it
  cannot load), every reinstall was refused with `409 Plugin '<slug>' is currently active. Deactivate it
  before re-uploading` (the guard read the option alone), and boot never reconciled the two, so the state
  survived every restart. One definition of "orphaned" now covers all three: boot prunes the stale entry
  and raises a persistent admin notice per slug (retired automatically once the plugin is loadable again),
  an install over an orphan drops the entry and removes the leftover directory before proceeding, the
  admin screen shows the entry as a broken card offering *Reinstalar desde el Marketplace* and *Quitar
  restos*, and `POST /plugins/:slug/deactivate` is the cleanup door for it. Real plugin files are never
  removed on this path: a directory is only deleted when it holds no manifest and no entry file, its
  `data/` subdir is preserved, and a genuinely running plugin is still refused an in-place overwrite.
- **Plugins whose tables declare a quoted default containing `{}` or `#` can be activated again.** Since
  the 2.0.x column-definition hardening, `core/safe-sql` applied its closed character allowlist to the
  whole definition, including the inside of a `DEFAULT '…'` string literal — so `params TEXT DEFAULT
  '{}'` (an empty-JSON default), `color TEXT DEFAULT '#3b82f6'` and `availability TEXT NOT NULL DEFAULT
  '{}'` were refused, the isolated child of every plugin declaring one (three catalog plugins did) died
  at boot with `createTable: … is not an acceptable column definition`, and its routes answered 500. The
  allowlist is now applied outside string literals only; inside a literal any printable character except
  `'`, `\` and control characters/line breaks is accepted once the quoting is proven balanced and
  unescaped, and every structural check (`--`, parentheses, the single-statement guard) reads the code
  around the literals rather than their text. A regression guard walks every shipped
  `marketplace/plugins/*/index.js` and runs its column definitions through the producer, and the F6
  compatibility bridge now hands each plugin's `createTable` columns to the real `buildCreateTable`.
- **Plugins that write to the database load again on the pure-JS SQLite driver.** Under `sqlite-legacy`
  (the fallback when the native module is missing) sql.js saves the database file from the host after every
  write, and that save ran under the calling plugin's context, so io-guard refused it and every plugin
  holding `database:write` failed to load. The host may now write the configured database file and its
  sidecars under a plugin's context (an isolated child is still refused), and the table-prefix registry
  (`data/wjp-prefix-registry.json`) is saved as the host instead of being refused and re-seeded at every boot.
- Public navigation marks the current page: the link whose path is the page being viewed carries
  `aria-current="page"` in the chrome nav and its mobile drawer, the NavMenu and MegaMenu blocks and the
  default Header and Footer — a cue for screen readers and a hook for themes (no default style is added).

## [2.2.0] - 2026-09-05

### Security

- **Comments are no longer a free write channel.** `POST /comments` has its own rate limiter (5 per 10
  minutes for anonymous callers, 30 for signed-in ones, keyed separately), a honeypot field that silently
  discards bot submissions, a 64 KB size cap, a duplicate guard, and a `comments:pre_insert` hook a spam
  plugin can veto through. Before, only the global API limiter applied.
- **The audit log records what an operator needs to answer.** Login success and failure, logout, password
  and MFA changes, API token creation and revocation, content create/update/publish/trash/restore/delete,
  backup create/restore/delete and marketplace installs are audited (thirty call sites against a typed
  action catalogue that a test enforces); rows older than `audit_retention_days` (default 365) are pruned
  daily.
- **MFA-by-role can cover personal API tokens.** A new policy switch, `enforceForApiTokens` (off by
  default), refuses a `wjt_` token whose owner is in a required role and has no second factor; the
  enrolment routes stay reachable and a compliant owner's token passes untouched.
- **Silent degradations now speak.** A fallback to the pure-JS `sqlite-legacy` driver (no full-text
  search) and a Linux cgroup scope without a CPU quota each raise a persistent admin notice, and
  `GET /health/details` reports the real active driver and the sandbox CPU bound.
- **The OpenAPI document is validated structurally** on every test run: thirteen operations that lacked a
  `responses` object made the published spec invalid; an unparsable `@swagger` block now fails loudly.
- **Public author identity is never the login.** Posts, archives and feeds address an author by
  `user_nicename` (derived at account creation, backfilled by migration 0015) or by id; a login only
  resolves for an account that has no nicename, so `?author=<login>` and `/author/<login>/feed.xml` no
  longer confirm which sign-in names exist. Login failures for unknown accounts are audited as a keyed
  digest, not the typed identifier.
- **The comment honeypot is indistinguishable from a real insert**: a discarded submission answers with
  the id the next real row would take and the repeat guard behaves identically on both paths, so a bot
  cannot learn it was trapped. Anonymous duplicate detection is scoped to the caller.
- **RSS `<link>` and `<guid>` are escaped**, so a slug containing `&` no longer produces a feed readers
  reject; term and author feeds name their canonical URL rather than the spelling they were asked with.
- **Bootstrap secrets stay out of log aggregators.** The one-time install token and the generated initial
  admin password are printed only when stdout is a terminal (or `WORDJS_PRINT_INSTALL_TOKEN=1`); headless
  deployments read them from the 0600 files under `backend/data/` or supply `WORDJS_INSTALL_TOKEN`.
  Bridged `console.*` lines are scrubbed for credential shapes, an incoming `X-Request-Id` is honoured
  only behind a trusted proxy, and public SEO operations are declared unauthenticated in OpenAPI.
- **WordPress import cannot overwrite an upload or forge its own bookkeeping**: colliding file names are
  disambiguated, dot-leading path segments refused, files land via temp-and-rename and are removed if the
  row fails, the per-run byte budget is enforced per chunk, and the importer's idempotency meta keys are
  protected from post meta writes.
- **A plugin's "Reviewed" badge only comes from the official catalog.** Records fetched from any other
  source are shown as unreviewed, `first-party` is checked against the manifest author, review evidence
  is refused on non-reviewed ledger records, a review is bound to the reviewed version and a source digest,
  and a pull request cannot change a plugin and its review record at once.

### Added

- **Public archives**: `/category/<slug>`, `/tag/<slug>`, `/author/<slug>`, `/archive/<yyyy>[/<mm>]` and
  `/taxonomy/<tax>/<term>`, paginated by path, served from the ISR cache and purged on publish; themes
  receive a documented archive template context.
- **Sitemap index and feeds**: `sitemap.xml` becomes a `<sitemapindex>` above 1,000 URLs with chunked
  children; Atom, JSON Feed 1.1, per-category, per-tag, per-author and comments feeds; all of them and
  `robots.txt` at their public root URLs, proxied by the frontend in every deployment mode.
- **WordPress import that brings the site**: attachments are downloaded (same SSRF guard as marketplace
  and webhooks, 50 MB per file, 1 GB per run, resumable, failures reported per item) and menus are imported
  with hierarchy, targets and locations. Content URLs are rewritten. The import stays idempotent.
- **Modern image formats**: every raster upload gets WebP (and AVIF where the encoder supports it)
  derivatives beside the existing size ladder, and public pages render `<picture>` with them. The markup
  follows the image: picking one from the media library stores its variants on the block, so a page saved
  earlier keeps its plain `<img>` until the image is picked again.
- **Structured logging and real metrics**: pino with request correlation ids, secret redaction and a
  console bridge that turns the legacy `console.*` lines into structured JSON; `/metrics` gains request
  rate, latency histogram, error rate, DB pool and sandbox state series. See `documentation/observability.md`.
- **Docker built, booted and installed in CI**, plus ready-to-run templates under `deploy/` (single-container
  compose and a monolith Helm chart).
- **A third-party plugin review programme**: public criteria (`marketplace/REVIEW.md`), a committed review
  ledger, a PR-triggered review workflow, a submission template, `verify:marketplace` rules that catch a
  permission change after review, and a review badge in the admin Marketplace.
- **Real filters on the posts API**: `?categories=`, `?tags=` and `?author=` accept ids or slugs (OR within,
  AND across) in both the list and its total; posts serialise `author` as `{ id, displayName, slug }` as the
  content contract always declared.
- **Coverage is measured** (c8 for the backend, vitest coverage for the frontend) with a ratchet floor in
  CI, and a performance-budget job runs the bench on the Linux runner and can emit a Linux calibration.
- **Repository hygiene**: `main` requires a pull request and sixteen green checks; Dependabot alerts,
  security updates and grouped updates are on; the release gate tests every shipped workspace and fails a
  tag whose npm publish could not run; the OpenAPI document reports the real product version.

### Changed

- **Headless deployments no longer see the install token in the logs** (see Security above). Docker,
  systemd and CI operators read `backend/data/install-token`, pre-set `WORDJS_INSTALL_TOKEN`, or opt back
  in with `WORDJS_PRINT_INSTALL_TOKEN=1`. Interactive terminals are unchanged.
- The admin Marketplace label reads **Reviewed** instead of "Sandboxed & reviewed"; the sandbox statement
  moved into every badge's tooltip, because it is true of every plugin and was not what the badge attested.
- The Linux performance-budget CI job measures on push and pull requests and enforces only on manual
  dispatch, until the Linux calibration lands; the Windows-calibrated budget test in the backend suite keeps
  enforcing on every run.

### Fixed

- The F6 "Redis connected" certification leg failed about one run in four with no failing assertion: the
  object cache logged its connect banner to stdout from an asynchronous callback and corrupted the frame
  stream node:test uses to report results. The banner now goes to stderr, `closeAll()` really closes the
  sockets, and the C05 gate reuses the shared flake-retry wrapper instead of a local copy that never fired.
- The home page walk over more than 100 posts repeated the first page's tail instead of fetching the next
  page; the archive pages filtered the whole site in memory instead of asking the API.
- `<picture>` could serve a smaller image than the plain `<img>` when the modern-format derivative
  stopped short of the original's widest size; such formats are dropped from the `<source>` list.
- The WebP/AVIF encode budget was per request, so parallel uploads could exceed it; it is now per process.
- The comment rate ceilings are options (`comment_rate_anon`, `comment_rate_auth`) and the limiter is no
  longer constructed inside the request handler.
- Dismissing an admin notice bypassed the locked writer the rest of the notice system uses.
- The audit health surface reports the retention window and whether pruning is behind.

- The Docker image always came up "installed": the entrypoint wrote `wordjs-config.json` unconditionally,
  so the setup wizard was unreachable and no administrator could be created. Pre-seeding is now opt-in
  (`WORDJS_PRESEED_CONFIG=1`), the config lives in the data volume, and the container health check is a
  liveness probe so a fresh container is not reported unhealthy while it waits for the wizard.
- `GET /posts?categories=…&tags=…` accepted both parameters and ignored them.
- Posts returned `author` as a bare id while the generated contract said `{ id, displayName }`, so the
  public author name, OpenGraph `authors` and JSON-LD `author` were always empty.
- The home page blog roll was capped at ten posts because the server fetch never sent `per_page`.
- The one documented analytics operation was published at `/api/v1/api/v1/analytics/stats`; four public
  routes were advertised as authenticated.
- Dependabot could not update `nodemailer` because a fixed `overrides` entry conflicted with the direct
  dependency; the override now follows it.

## [2.1.0] - 2026-09-04

### Security

- **Cookie-authenticated writes need a CSRF token.** Every session-cookie request that mutates state
  must carry an `X-CSRF-Token` header equal to the `wjs_csrf` cookie the server issues at login (the
  cookie is readable by scripts and otherwise shares the session cookie's attributes). The check is
  combined with the existing Origin/Host allow-list rather than replacing it, Bearer requests are
  exempt — as are requests whose session cookie no longer verifies (a dead cookie authenticates
  nothing) and the two steps of sign-in, `POST /auth/login` and `POST /auth/mfa`, which credentials
  and a signed MFA challenge authenticate rather than the cookie; the Origin/Host allow-list still
  applies to all of them. A mismatch answers `403 rest_csrf_token`, and the cookie is back-filled
  on the next authenticated request for sessions that predate this release. The frontend attaches
  the header through `lib/csrf.ts`; every in-tree mutating fetch path was updated, and the editor
  presence beacon moved from `sendBeacon` to `fetch` with `keepalive` so it can carry the header.
  `X-CSRF-Token` is now an allowed CORS request header.
- **A runaway isolated plugin is killed.** The sandbox's memory poll now also samples CPU time: a
  child that stays at or above 95% of one core for `sandbox.cpuBurstSeconds` seconds (default 60;
  `0` disables the check) is sent SIGKILL and its health record says why. Linux reads
  `/proc/<pid>/stat`, macOS uses `ps`, Windows reads the CPU-time column of `tasklist /V` (sampled
  every 30 s, so a Windows kill lands within about one and a half windows). The watchdog stands down
  only where a preventive cap is actually installed — `sandbox.cpuQuotaPercent` on Windows (Job
  Object rate control) or inside the Linux cgroup scope; that quota stays opt-in, and a Linux cgroup
  scope enabled without it is the one configuration the watchdog cannot sample (the server warns at
  launch).
- **A plugin's shipped `node_modules` are scanned before load.** The pre-load AST scanner used to
  stop at the plugin's own sources; it now walks the dependency tree the plugin ships, under bounds
  (4,000 files, 1 MB per file, depth 32). Reaching a bound is itself reported as a finding rather
  than letting the remainder pass unseen, and a symlink that leaves the plugin directory is refused.
- **The install token travels in the URL fragment.** The CLI now prints `/install#token=…`, so the
  token never reaches server logs, reverse proxies or a `Referer` header. The install page reads the
  fragment first, still accepts the query form for instructions already written down, and scrubs the
  token from the address bar either way.
- **`'unsafe-eval'` is gone from the production `script-src`** of the frontend security header, the
  gateway and the backend's own helmet policy (which only ever serves the Swagger UI as HTML). The
  visual editor that needed it no longer exists and the shipped client chunks contain no `eval`;
  development builds keep the keyword because React's development build requires it. Tests pin the
  strict production shape.
- **Isolated plugin children on Linux start with the working directory at the filesystem root**, as
  they already did on macOS, so `process.cwd()` no longer discloses the deployment path to a plugin.

### Added

- **A scheduled dependency audit.** `dependency-audit.yml` runs `npm audit` for all six workspaces
  every day (and on demand through `workflow_dispatch`) and opens an issue when one fails, so an
  advisory published between releases no longer waits for the next push to be noticed.

### Changed

- `SECURITY.md` and the security, frontend, gateway, deployment, plugins, architecture and CLI
  documents describe the controls above; the items that used to be listed as known limitations are
  now documented as controls, with the remaining limitations stated plainly.

### Fixed

- **Swagger UI "Try it out" keeps working under the CSRF token.** The interactive reference at
  `/api/v1/docs` now attaches the session's `wjs_csrf` token as `X-CSRF-Token` on every request it
  sends, so a mutating call from that page is accepted instead of answering `403 rest_csrf_token`.
- **The advice in the dependency-scan finding pointed the wrong way.** When a plugin's shipped
  `node_modules/` cannot be scanned in full, the finding told authors to "declare `bundled` and let the
  host install" their packages — but `bundled` is what tells the host to *skip* that install. It now
  says to stop shipping `node_modules/`, leave `bundled` unset and declare the packages in the
  manifest's `dependencies`.
- **Windows: isolated plugins no longer stop loading after a rebuild or an upgrade.** The AppContainer
  grant cache remembered a successful `icacls` grant by SID, path and access shape alone. When
  `backend/dist` or `node_modules` was deleted and recreated at the same path (a rebuild, `npm ci`,
  unpacking a new release bundle) the recreated tree had lost the package-SID ACE while the cache still
  said it was granted, and every isolated plugin child failed at boot with `MODULE_NOT_FOUND` for a file
  that exists. The cache key now includes the directory's own identity (NTFS file id and creation time),
  so a recreated directory is a miss and the grant is redone; the cache moved to `v4` so no marker
  written under the old key is trusted.

## [2.0.0] - 2026-09-04

### Breaking changes

Every one of these replaces behaviour that was wrong, but each is observable to an existing caller, so
the release is a major.

- **A scalar query parameter sent twice is refused with `400 rest_invalid_param`.** `?force=true` is the
  string `true`; `?force=true&force=true` is an array, and the guards that compared it to a string
  answered false for it. `DELETE /posts/:id` and `DELETE /comments/:id` therefore answered `200` and
  *trashed* a row the caller had asked to delete permanently; a repeated `hide_empty` silently dropped
  the filter; a repeated `users` on `/export` produced an archive with no user rows; a repeated `order`
  on `/users` was a `500`. The value is not resolved to the first or last occurrence: any resolution
  rule hands the decision to whoever can append to a URL, and on `force` either guess can be steered
  into a permanent delete. Sending the same scalar twice was never meaningful, so an honest caller sees
  no change.
- **A malformed route id answers that router's own 404 instead of serving a row or failing.**
  `parseInt('1abc', 10)` is `1`, so `GET /api/v1/posts/1abc` used to serve post 1. An id wider than the
  id columns reached the driver: on PostgreSQL, an anonymous `GET /api/v1/posts/9999999999` answered
  `500` with SQLSTATE 22003. A route id is now the id or it is nothing, in every router that takes one
  — fourteen of them. Routers that already refused with `400` keep their `400`; only the predicate is
  shared.
- **An unexpected 5xx no longer returns internal error text.** The error handler rendered `err.code` and
  `err.message` verbatim on every error, so a driver failure handed the caller its SQLSTATE and message.
  Deliberate API errors — including the `rest_invalid_param` shape above — still render as before.
- **`req.userId` is gone.** It was stamped on ten authenticated paths and read nowhere, including
  through the plugin bridge. Nothing in-tree consumed it.
- **`ownerOrCan()` is no longer imported by core routes.** `routes/posts.ts` and `routes/users.ts`
  destructured it from the permissions middleware and never called it; those dead imports are removed.
  The middleware still exports `ownerOrCan(capability, getOwnerId)` for extensions — its documented call
  form previously omitted `getOwnerId` and would have thrown; the API reference now shows the two-argument
  form. Core content routes gate on `canEditPostRecord` instead.

### Added

- **The F0–F6 content programme.** A declarative content schema (F1) from which the runtime validators,
  wire DTOs, OpenAPI and the frontend client are generated (F2); transactional content writes with a
  durable outbox, so a post, its terms, its meta, its revision and its event commit or fail together
  (F3); versioned, extensible revisions whose snapshots keep their meaning across schema changes (F4);
  one visual contract shared by backend, frontend and editor (F5); and migration certification (F6).
  Each phase carries a numbered ADR under `documentation/adr/` and an executable verifier under
  `backend/scripts/`, so the guarantees are gates rather than prose.
- **A rollout ramp for content validation** (`off` / `shadow` / `enforce`, per type). `shadow` records
  what enforcement *would* reject without rejecting it, so a cut-over is decided on evidence; `off` is
  the emergency downgrade. `contentRolloutReport()` publishes the divergences, which carry field paths,
  issue codes and the *shape* of the offending value — never the value.
- **`config.api.rateLimit`** — the per-IP budget for `/api/v1/*`, previously hard-coded. Defaults are
  unchanged at 1000 requests per 15 minutes and both bounds are clamped, so a typo cannot switch the
  limiter off.
- **The JS guard layer is certified on Linux, macOS and Windows.** The kernel floor already was; the
  layer above it — io-guard, secure-require, the ESM/net guards and the bridge allowlist, exercised by
  booting real malicious plugins in the real fork — ran only on Linux. It now runs on every runner.
- **`scripts/record-editor-demo.mjs`** regenerates the README's editor demo, so the picture can be
  refreshed instead of ageing.

- **Editor: the motion dock wears its Stitch design.** The dock's look now comes from the same
  Stitch project that designed the whole editor ("Architectural Precision"): a solid-indigo play
  button in the transport, a millisecond ruler over the lanes, a vertical playhead line that
  follows the manual scrub, clips drawn as labeled lavender bars (each showing the properties it
  animates) with an integrated trim grip, and the active lane marked with the design system's
  left-accent tint. The timeline component stays token-agnostic — the dock provides the indigo
  ink, the preset admin keeps its gray — and every accessible name and behavior is unchanged.
  A follow-up pass made the match exact, measured computed-style against computed-style on the
  rendered Stitch screen: 2px radii on the transport and active clip, 24px lavender clips with
  their 11px deep-indigo captions, the 10px monospace ruler, 35px lanes with the active row
  tinted at 30%, and gray lane labels. The same pass caught a real bug: the playhead callback
  was recreated every render, which silently disarmed the scrubber — it is now stable, and the
  playhead line verifiably follows the manual scrub.

- **Editor: motion presets become draggable clips.** The dock's stage gains a clip palette: every
  motion preset is a block you drag onto the timeline — it lands as a new track at the exact drop
  position, video-editor style — or apply with a plain click (the same path, no mouse required).
  On a block with no interaction yet, dropping a clip applies the preset by reference, so site-wide
  preset propagation stays intact. Clips also grew a trim handle: drag the right edge of a lane's
  bar (or press the arrow keys on it) to resize its duration, with the inspector's numeric fields
  tracking live. One writer, one undo history, no new data shapes.

- **Editor: the motion dock gets a video-editor anatomy.** The dock now splits into an inspector
  column (the full interactions control) and a stage: a transport bar with the play buttons and
  the manual scrubber as a playhead, and the multi-lane timeline promoted to protagonist — always
  visible at canvas width, no disclosure to open. Inspector and stage share the active track and
  the same pure writers, so dragging a marker on the stage updates the inspector's numeric fields
  live, and everything stays on the one undo history.

- **Editor: motion gets its own bottom dock.** Interactions and the entrance animation move out of
  the right-hand inspector into a collapsible dock under the canvas — the natural home of a
  horizontal timeline, with the full canvas width instead of a 320-pixel column. Same controls,
  same tests, same undo path; the inspector keeps style and visibility, and each property has
  exactly one owner on screen. Collapsing the dock gives the canvas its space back instantly.

- **Interactions: a real multi-lane timeline.** The step strip grew into a timeline: one lane per
  track on a shared scale (milliseconds for clock triggers, 0–100% for scroll and pointer), where
  the active lane's step markers and delay bar drag with the pointer or move with arrow keys —
  every change announced to screen readers, every value still editable in the numeric fields below,
  which remain the canonical path. First and last steps render as fixed anchors (the data model
  pins them to 0 and 100, so the UI doesn't pretend otherwise), and preset-linked blocks show the
  whole timeline read-only.

- **Interactions: SVG stroke drawing, and word cascades that count.** A new *Trazado* property
  animates an SVG stroke being drawn (or undrawn) — compiled to pure CSS `stroke-dashoffset`
  against a documented contract (`class="wjs-ixd"` + `pathLength="1"`) that first-party and plugin
  blocks can adopt; the HTML sanitizer deliberately keeps refusing raw `<svg>` in rich text, so the
  capability ships without widening any security surface. And word-by-word cascades from the end or
  the center are now *exact*: the renderer stamps each span with the real word count, so a
  six-word headline no longer times itself as if it had eight.

- **Interactions: optional scroll smoothing.** Scroll-driven interactions can opt into a chase —
  the animation eases toward the scroll position with an exponential decay measured in
  milliseconds, the same deterministic chase the pointer trigger uses. It's honest about its cost:
  the panel and the compiler both say it trades the pure-CSS path for the JavaScript runtime, and
  it stays off unless an author asks for it.

- **Interactions: a custom event trigger for plugin code.** Plugins can now drive interactions by
  dispatching `wjs:ix:<name>` DOM events — the name is a closed slug the normalizer enforces, the
  prefix is added by code (author strings never reach an event listener or the CSS), and the
  trigger behaves like click: latch once, or toggle in and out.

- **Interactions: a curated motion library, and per-block intensity.** The system catalog grows
  from 16 to 26 presets, showcasing everything the engine learned: physics entrances (bounce,
  elastic — compiled to CSS, zero JS), 3D flips and skewed slides, card cascades and grid ripples
  over a block's children, cursor tilt and parallax, and scroll-driven reveal and color washes.
  And every block gets an intensity dial (×0.1–×3) that scales the *movement* of whatever preset
  or custom interaction it uses — never the fades or colors — without forking the preset: it's a
  block-level choice, like the per-device switch, and survives changing the trigger or the preset.
  The preset admin now shows live usage counts and previews a preset before saving.

- **Interactions: pointer-driven motion (parallax, tilt, follow) — loaded only when used.** A new
  trigger positions an animation with the cursor: normalize over the block itself (tilt) or the
  whole page (parallax), pick a chase smoothing in milliseconds, and give each track its own axis —
  two tracks, one per axis, compose the classic 3D tilt. It ships zero CSS and zero JavaScript
  unless a page actually uses it; off-screen blocks ignore the cursor entirely; touch devices and
  visitors with reduced motion simply see the block at rest.

- **Interactions: three parallel tracks, editable, with a visual step strip.** An interaction could
  always carry up to three tracks (background parallax + rising foreground + staggered children,
  say), but the panel only edited the first. Now every track is editable — add (new tracks are
  born neutral so nothing jumps), remove, and switch between them — and a horizontal strip shows
  each step of the active track at its true position, with keyboard-navigable markers that jump to
  the step's controls. Preview got block-scoped: "Probar" replays just the block you're editing,
  "Probar todo" replays the page.

- **Interactions: stagger that can count, and per-device control.** Staggered children can now
  start from the center or the end exactly, spread a fixed total time across however many siblings
  exist, or ripple diagonally across an author-declared grid — all in pure CSS via the new
  `sibling-index()`/`sibling-count()` functions where the browser has them (Chrome, Safari, and
  Firefox as of this week), with the classic per-child rules as fallback and the JavaScript path
  sharing the exact same formulas. And any interaction can be switched off per device
  (mobile/tablet/desktop, the same cutoffs as block visibility): the styles are fenced behind the
  matching media query and the runtime doesn't even arm on a disabled device.

- **Interactions: 14 new animatable properties, still zero layout shift by construction.** Full 3D
  (rotate on the Y axis, real depth on Z, per-track perspective), skew, independent X/Y scale, a
  filter family (brightness, contrast, saturation, grayscale, hue), and color animation for text,
  background and border. Colors travel as plain integers and only ever appear in the steps that
  declare them, so a color step animates *from the block's natural color* — and the closed property
  list still cannot express a single layout-shifting property. The clip reveal gained directions
  (left/right/up/down/center), and rotation and scale can pick their transform origin.

- **Interactions: real motion curves, with zero JavaScript.** Every step can now carry its own
  easing curve — either drawn/typed as a custom cubic-bezier in a new visual curve editor (fully
  keyboard-operable), or picked from two new physical curves, *Rebote* (bounce) and *Elástico*
  (elastic). The physics run once, in the compiler, which samples them into the CSS `linear()`
  easing function (supported by every current browser) — the visitor's browser just interpolates a
  list of points. Competing engines ship a JavaScript animation library to every visitor to get
  the same look.

- **Interactions: full trigger and playback controls in the panel.** What the engine's data model
  already supported now has switches an author can reach: repeat count / infinite / ping-pong
  playback, click-to-toggle (second click undoes), a trigger delay for load animations, the choice
  of which scroll drives a scrub (the block's own journey or the page), and a range editor for
  scroll-driven triggers in author language. Options a given path cannot express (repeat on a
  scroll-driven track, stagger without siblings) now surface as visible warnings instead of
  silently doing nothing.

- **Verso, WordJS's own visual editor.** The editor is no longer a vendored fork with a wrapper
  around it: the document model, the canvas, drag-and-drop, undo/redo, the inline text engine and the
  block registry are all in-house. What that buys you day to day: block ids stay stable across edits,
  undo restores the document byte-for-byte, the canvas renders through the same components the public
  site uses (so what you see is what gets published), and the whole editor is keyboard-operable —
  insert, move, edit and save without touching the mouse.

  **Your content is untouched.** Existing pages open in Verso and save back byte-identically; the
  `_puck_data` post-meta key keeps its name and its shape. That was rehearsed against a copy of a real
  installation before shipping: every stored document round-tripped byte-exact, revisions restored to
  byte-identical bodies, and a full WXR export/import cycle came back unchanged.

- **Real-time collaboration, on by default.** Two or more people can edit the same page at the same
  time, in the same paragraph, without a lock and without losing keystrokes — a CRDT decides the
  merge, so both screens converge on the same document whatever the order things arrive in. You see
  who else is here and what they have selected, by name. If the connection drops you keep editing
  locally and the editor says so; nothing is thrown away silently, and reconnecting replays what you
  wrote.

  Turn it off for a deployment with `NEXT_PUBLIC_WORDJS_COLLAB=off`, or for one browser with
  `localStorage.wordjs_collab="off"`.

- **Timeline interactions.** Blocks can carry entrance, hover, click and scroll-linked animations,
  authored from a panel in the editor with a timeline of steps. They compile to native CSS
  scroll-driven animations, so the common cases cost no JavaScript at all; the runtime is fetched only
  by a page that needs something CSS cannot express, and never by a theme. `prefers-reduced-motion` is
  honoured at three levels. Site-wide presets can be authored in **Settings → Interactions** and
  applied by name, so changing one preset restyles every block that uses it without touching a single
  page's stored data.

- **`npm run gate:separate`** — a reproducible gate for the three-machine deployment. It stands up a
  gateway/backend/frontend topology, enrols it over mutual TLS, verifies enrolment, mTLS role
  enforcement, install, identity survival across a restart, and the public site serving complete, then
  tears it down. It is proven to fail: reverting any of the three bugs fixed below turns it red on the
  matching check.

- **`WORDJS_BACKEND_URL`** — points one frontend replica at one backend, so N replicas can share the
  same files and config and still each talk to their own upstream. Unset means "no opinion"; an
  unusable value is a startup error rather than a silent fallback.

### Changed

- **Blocks now carry WordJS's own class, `wjs-block-*`, alongside the historical `wp-block-*` one —
  which is deprecated.** The public HTML emits both, own identity first:
  `class="wjs-block-heading wp-block-heading"`. The framework stylesheet inverts authority to match —
  `.wjs-block-heading, .wp-block-heading { … }` — so `.wjs-block-*` is the source and `.wp-block-*` is
  an alias in the same grouped selector.

  **Nothing breaks, by construction.** A theme written against `.wp-block-*` keeps matching, because
  that class is still on every element. Content already saved in your database, and everything a WXR
  import brings over from WordPress, keeps its framework styling, because the alias is still in the
  stylesheet. Plugins are unaffected: they style their own `.wjs-p-<slug>-*` namespace, which the
  manifest validator enforces and which this change does not widen.

  **`wp-block-*` will be removed in the next major version.** Write new themes, plugins and custom CSS
  against `.wjs-block-*`. The compatibility window, what is on each side of it, and the exact edits the
  removal takes are documented in
  [documentation/block-class-identity.md](documentation/block-class-identity.md).

  Cost, measured on production HTML with gzip (what the server negotiates): +0.24 % to +0.90 % on a
  blog post, +1.92 % on the home page. Block-catalogue demo pages, which stack every block many times
  over, are the outlier at +2.2 % to +4.8 %; the duplication ends when the alias does.

- **The visual editor is now called Verso, and the code carries that name.** WordJS's block editor
  started life as a vendored fork of [Puck](https://github.com/measuredco/puck) and the whole surface
  around it — modules, folders, CSS classes, generated registries — was named after it. The fork is
  retired: there is no `@measured/puck`/`@wordjs/puck` dependency left, no vendored-editor build step,
  and no third-party notice to carry. This release renames the surface to match.

  **The rename does not touch the public HTML contract.** Every `wp-block-*` class name and every
  `--wjs-*` design token a theme is written against is unchanged, and so is the `.puck-content` wrapper
  class — that one keeps its historical spelling precisely because themes may be selecting on it. A
  theme built before this change keeps working with no edit.

  **The post-meta key `_puck_data` is deliberately unchanged.** It is not a name in our source — it is
  a value already written into the `postmeta` table of every existing install and into every WXR export
  ever taken from one. Renaming it would mean a data migration whose failure mode is losing the body of
  every block-built page, in exchange for cosmetics. It stays exactly as it is, and the reasoning is
  recorded next to the constants that hold it (`CONTENT_META_KEY`, `EDITOR_DATA_META_KEY`).

- **Plugin block API: new spellings, old ones still accepted — permanently.** This is the same block
  API it has always been, under Verso names. A plugin now declares its block with
  `frontend.versoComponents` (or the folder convention `client/verso/<Pascal>Verso.tsx`) and exports
  `versoComponentDef` + a default render component, or a `versoComponents` map for several blocks.

  The pre-rename spellings — `frontend.puckComponents`, `client/puck/<Pascal>Puck.tsx`,
  `puckComponentDef` / `puckComponents` — are still resolved, and are not scheduled for removal: a
  published plugin is a third-party artifact nobody here can rewrite. Finding an old spelling logs one
  deprecation line per plugin and then behaves identically; when both are present, the Verso spelling
  wins. Render components also still receive the legacy `puck` prop
  (`{ isEditing, metadata, dragRef, renderDropZone }`), so a bundle compiled against the old contract
  runs without a recompile. Resolution lives in one shared module,
  `backend/scripts/plugin-block-contract.js`, required by the registry generator and by all three
  marketplace build/verify scripts, so they cannot drift apart.

  Renamed for authors: `frontend/scripts/generate-puck-plugin-registry.js` →
  `generate-verso-plugin-registry.js`, and the registry it writes,
  `frontend/src/lib/puckPluginRegistry.ts` → `versoPluginRegistry.ts` (generated per machine and
  gitignored, as before). The `wordjs create plugin` scaffold now emits `client/verso/`.

### Fixed

- **MySQL: no content-driven webhook had ever been delivered.** `WebhookDelivery.enqueue` writes
  `ON CONFLICT DO NOTHING` with no conflict target — legal in SQLite and PostgreSQL. The MySQL driver
  translated only the parenthesised form, so the clause survived, the statement was rejected, and the
  webhook listener swallowed the error as non-fatal. Silent since the outbox shipped, and invisible to a
  test suite that runs on SQLite.
- **MySQL: a duplicate username or email answered a driver 500 instead of "already exists".**
  `isUniqueViolation()` existed twice — `core/revisions.ts` knew all three drivers, `models/User.ts`
  knew only SQLite and PostgreSQL, and its own doc comment enumerated exactly those two, so it read as
  complete. There is now one predicate, in `core/db-errors.ts`, and a test that fails if a second
  appears. On SQLite this also narrows what counts as a collision: a NOT NULL or CHECK failure during
  user creation used to be reported as "Username or email already exists" and now surfaces as itself.
- **`npx create-wordjs` could download a plugin and try to boot it as a site.** It took the first
  release asset matching `wordjs-*.zip`, and the same release carries all 31 marketplace plugin zips —
  so a plugin slug beginning with `wordjs-` would sort ahead of the bundle. It now asks for the
  tag-named bundle by name. The loose match survives only as a fallback for earlier releases, and only
  when it is **unambiguous** — with two or more candidates the installer refuses and names them rather
  than choosing, because the fallback is the old rule and letting it guess would reinstate the same bug
  on every path where the tag-named asset is absent. The package also gains a test suite and a CI job:
  it had neither, while being the first command a new user runs and the one thing here published to an
  immutable registry.
- **The release now refuses to package a compiled tree that does not match its source.** Production
  loads `backend/dist/`, and that is what the ZIP and the npm package ship — so a compiled file that is
  missing, older than its source, or left behind after its source was deleted is a behaviour the
  artefact has and the tree everyone reads does not. Two audit findings stayed exploitable exactly this
  way after being fixed. The suite already had a gate for it, but that gate skips on a checkout that
  never built — which is most CI runs — and the walk it exported for the packaging step had **no
  caller**: the suite could report the artefact stale while the packaging script zipped it anyway. The
  walk now lives in `backend/scripts/stale-compiled-files.js` with two callers, and
  `make-release.js` aborts on any drift. "We remembered to rebuild" is no longer the control.
- **The accidental `/health/health` route is gone.** A nested duplicate of the frontend health handler,
  answering a different shape, requested by nothing, and built into the route manifest regardless.
- **Two marketplace plugins were dead on install.** `contact-forms` and `invoices` declared
  `DEFAULT '[]'` and `DEFAULT '$'` in their schema; the host SQL guard refuses `[` and `$` anywhere in a
  plugin statement, so `initSchema()` threw, `init()` failed and the plugin registered nothing.
- **Five plugin manifests declared fewer permissions than their code uses**, which the default-deny
  bridge refuses at runtime.
- **`mail-server` could not be installed.** The install-time scanner flags a bare `exec` call as
  possible `child_process` use and exempted only a literal `/re/.exec(s)`, not a regex held in a
  `const` — which is how its HTML sanitiser iterates.
- **`POST /import` leaked its upload on every malformed file**: the parse threw between reading the
  multer temp file and unlinking it.
- **A plugin that dies mid-line no longer dies silently.** The log forwarder emitted only on a newline,
  so a short unterminated write — what a launcher prints when it refuses — was buffered and lost.
- **`/api/v1/fonts` and the theme download** did their work inside a node-style callback under
  `asyncHandler`, so a throw there was an unhandled rejection rather than a 500.

- **Editor: palette cards insert on tap again, reliably.** Block cards inserted via the synthetic
  `click` event, and when the editor re-rendered between press and release the browser silently
  suppressed that click — cards "did nothing" with no error. Insertion now runs on pointer-up
  with the same 5px threshold the drag sensor uses: less than that is a tap (insert), more is a
  drag (the drop zones take over). Keyboard insertion (Enter/Space) is unchanged.

- **Blocks: the particle field is visible the moment you insert it.** Freshly inserted at page
  root — with no positioned, sized ancestor — the field's background-layer wrapper measured 0px
  and nothing showed. New insertions now default to an in-flow 420px band via the block's own
  CSS defaults; to use it as a section's background layer, clear those two entries and it
  returns to its classic cover-the-parent behavior. Existing pages are untouched.

- **Interactions: page-linked scrub now measures the same thing in every browser.** The fallback
  driver used by browsers without native scroll-driven animations measured the element's journey
  through the viewport even when the interaction was linked to the page's scroll; it now measures
  document scroll progress, exactly like the native `scroll()` timeline. The compiler also stopped
  emitting view-timeline range names for `scroll()` timelines — percentages only, which is the
  portable meaning.

- **Interactions: the editor canvas can no longer disagree with the published page about which
  animation a block gets.** The canvas now resolves block classes from the same whole-page
  compilation the public site uses, closing a corner case where two different interactions sharing
  a 32-bit hash showed the first one's motion on the second block in the canvas (guarded by a test
  built on a real hash collision found by brute force).

- **Separate mode (three machines) was unusable, in three ways that only appear when the tiers are
  actually apart.** The installer recorded the *backend's* address as the public site origin — it read
  the raw `Host` header, which the gateway rewrites — so every API call afterwards answered 409 asking
  for a migration. Installing on an already-enrolled node re-minted the cluster CA over the one the
  gateway issued and left the CA *private key* on the backend, which would have killed the cluster at
  the next restart. And `/public` was never routed, so 161 KB of block CSS and 73 KB of icons 404'd —
  that one also affected split mode on a single host.

- **On-demand cache purge now works across machines.** It assumed backend and frontend shared a disk,
  so in a cluster publishing fell back to timed revalidation. Measured on the three-machine lab:
  ~25 s → ~0.8 s. A node enrolled before this repairs itself on next start instead of needing a manual
  re-enrolment.

- **A dead Redis bus was silent, and never came back.** With Redis down, cross-node fan-out reported
  events as delivered without publishing them, and the client stopped reconnecting for good after
  three attempts — one blip left cluster collaboration dead until the process was restarted, with
  nothing in the log.

- **The editor canvas selected by the author's block id**, which stops matching the store's key once a
  document has been through a collaboration room. The page rendered perfectly and could not be
  touched: clicking selected nothing, double-click opened no editor, dragging picked up nothing.

- **Presence lied in a cluster**: the roster handed to someone joining was built from one node's
  connections, so with one author per node the second to arrive was told nobody else was editing.

- **The release packager shipped the developer's local directory.** A bundle built from a working tree
  carried `.claude/` — 46 MB of a 97 MB artifact, including git worktrees and local tool configuration
  that can hold credentials. Releases built by CI from a clean checkout were never affected. What
  belongs in an artifact is now decided by what git tracks, plus an explicit allowlist of build output,
  rather than by a list of names that is always one tool behind: 12 169 entries → 2 649, 97 MB → 17.7 MB.

- **Cache purge named the wrong paths for pages** (`/<slug>` instead of `/pages/<slug>`, the URL the
  menu builder links to). It worked only because the tag covered it.

- **The sandbox's own memory watchdog could not act cleanly, and every uncaught plugin error was reported
  as the plugin attacking the sandbox.** secure-require replaces `process.exit` with a guard that throws
  whenever a plugin context is on the stack — right for plugin code, but the worker calls `process.exit`
  in its own lifecycle paths too (guard-install failure, the ESM `import()` guard abort, the 512 MB memory
  watchdog), and timer callbacks are deliberately re-entered in the plugin's context, so the watchdog's
  exit was refused as if the plugin had called it. Worse, Node's own fatal path calls `process.exit()`,
  so the guard fired during crash handling and replaced every uncaught plugin error with a "RUNTIME
  SECURITY BLOCK: process.exit" message. The worker now binds `process.exit` before any guard installs and
  reports uncaught errors itself, so the real cause is printed and the limit fires with the right code.
- **A missing or broken `better-sqlite3` did not fall back to the pure-JS `sqlite-legacy` driver.** The
  documented fallback caught a failing `require('sqlite-native')`, but that module loads the native
  binding lazily inside `init()`, so its `require` never fails; the module that requires the binding at
  load time is the async driver, whose failure was only logged. A host without a working binary got a
  warning and then died later in `init()`. The fallback now fires for exactly that case.
- **Gateway workers served plain HTTP when `ssl` was enabled without a key and certificate** — the exact
  shape `npm run setup` writes. The primary honoured it by generating `ssl-auto.key`/`.crt` but never
  recorded the paths, and each worker re-read the config, found no key/cert and listened on HTTP while the
  config, the docs and the primary all said HTTPS. Workers now serve from the auto-generated pair.
- **The mail server retried a relay `5xx` as if it were transient.** Only the direct-to-MX path classified
  by SMTP reply code; the relay/smarthost path pushed every failure as retryable, so a permanent reject was
  attempted again up to the retry limit before it bounced. Both paths now apply the documented policy.
- **`CREATE TEMP TABLE` was refused by the plugin DDL guard** while `CREATE TEMPORARY TABLE` passed — a
  missing `?` in one regex, where the sibling patterns and the documented allowlist accept both spellings.
- **A plugin table could declare `FOREIGN KEY … REFERENCES users(id)`.** The SQL guard's table walker and
  the protected-table check never treated `REFERENCES` as introducing a table, so a plugin could constrain
  a core row (its delete then fails) and probe its existence. `REFERENCES` is now a table position: core
  tables are refused, and another plugin's table is refused by the ownership rule.
- **Compiled integration tests shipped in the release ZIP.** `tsconfig.build.json` excluded `src/tests`
  but not `src/tests-integration`, so `dist/tests-integration/*.js` was emitted and packaged. Excluded.
- **`documentation/stitch-brief.md` said "GENERATED — do not edit by hand" and carried a hand-written
  block list**, because its generator read the chrome-block allowlist from a file that no longer holds it
  and emitted an empty list. The generator now reads the generated visual contract, and the file is
  regenerated and true to its header.

### Security

- **`create-wordjs` shipped a HIGH advisory.** The install channel — the first command a new user runs —
  depended on `adm-zip` below 0.6.0 ("a crafted ZIP triggers a 4GB allocation") while the three audited
  workspaces were clean, because the audit gate enumerated backend, gateway and frontend and this
  package is none of them. Upgraded, and the gate now covers it.
- **An absent `Host` header became a permitted origin.** The CSRF same-origin allow-list was built as
  `http://${host}`, so with no header it admitted the literal strings `http://undefined` and
  `https://undefined`. Both the middleware and its byte-identical twin in the collaboration route now
  fail closed.
- **The force-delete bypass** described under breaking changes was reachable by anyone who could get a
  repeated parameter into a URL.
- **The plugin grant screen understated `assets:write`.** `permissionMeta.ts` claims, above its table,
  to cover "Every KNOWN_PERMISSIONS token" — and nothing checked. It was missing this one, and the
  lookup falls back to `{ label: token, risk: 'med' }`, so nothing broke: an admin was shown the raw
  string `assets:write`, no explanation, behind a MEDIUM badge, for a permission that lets a plugin put
  a script on public pages — code that runs in every visitor's browser. A missing entry did not look
  like a bug, it looked like a low-stakes permission. Both directions are now gated, plus a check that
  write-shaped grants are rated high.

- **Arbitrary file write via `POST /api/v1/certs/dns-finish`.** The `domain` field from the request
  body went straight into the path where `privkey.pem` and `fullchain.pem` are written, with
  `mkdir -p`. Demonstrated end to end before the fix: a traversal value returned `{"success":true}` and
  wrote both files outside the certificate directory — an arbitrary write as the server user, with the
  operator's own key material as the payload.

- **Stored open redirect in menus and site chrome.** Link guards decided on the raw string while the
  browser strips tab, newline and carriage return *before* parsing, and only `//host` was rejected —
  never `/\host`, which is equally authority-relative. Both spellings navigated off-site from a menu
  item or a footer social link. Menu URLs are not revalidated at render, so that guard was the only
  defense.

- **SQL identifier injection reachable from `POST /api/v1/import`.** Column definitions were checked by
  a denylist applied to a *copy* of the value while the original was interpolated into the DDL; quote,
  backtick and backslash all passed. Identifiers and column definitions now go through a shape
  allowlist that rebuilds the value from a constant alphabet.

- **A zip upload could silently overwrite an installed theme**, because the theme's identity came from
  the multipart filename while extraction was driven by the zip entries — and an entry could write into
  a *different* theme's directory.

- **A revoked session kept reading live drafts.** The collaboration stream's credential handling had
  drifted from the shared authenticator: `Authorization: Bearer null` plus a valid session cookie took
  a branch that never re-verified the token, so the stream survived logout, a password change and JWT
  expiry — a removed editor kept receiving every keystroke.

- **Hardening against remote property injection** in the collaboration operation validator, and the
  video block no longer classifies providers by substring (`youtube.com.evil.test/watch?v=…` let an
  attacker choose both the provider and the id that reached the player).

- **Plugin sandbox: an adversarial audit closed a network-grant bypass, two unenforced permissions, a
  native host-kill and an unbounded reply clone.** Node's underscore-prefixed internal builtins
  (`_http_client`, `_tls_wrap`, `_stream_wrap`, `_http_agent`, …) were handed to plugins raw — named by
  neither the network list nor the block list — and they expose HTTP/TLS/socket primitives *below*
  `net.Socket.prototype.connect`, the egress chokepoint, so a plugin with no `network` grant had outbound
  reach; every `_`-prefixed builtin is now denied to plugins on the `require` path and the ESM `import()`
  path alike (`import('tty')` is denied too). `express:register_route` and `admin_menu:register` were
  admin-grantable permissions that nothing enforced — a plugin mounted host routes and admin-menu items
  regardless of grant or revoke; both are now checked like `email:provider`. `process.reallyExit`, the
  native primitive `process.exit` wraps, was not blocked, so an in-process plugin or theme could kill the
  host; it is. The reply-size guard bounded node count, not bytes, so a giant string, an `ArrayBuffer` or
  a `Map`/`Set` cloned hundreds of megabytes onto the host heap; it now bounds estimated size.
- **Plugin sandbox: a plugin could forge the control frames the host trusts.** The host accepted an
  inbound IPC frame by its `kind` alone, and the child inherits the IPC descriptor (fd 3), reachable
  through a socket built over the fd, a path-less `fs` write stream or a raw `fs.writeSync(3, …)` — a
  synthesised `{kind:'ready'}` resolved a plugin's load before `init()` had run. Blocking each write
  vector is whack-a-mole, so the origin is authenticated instead: every frame carries a per-spawn nonce
  the worker scrubs from the child's `argv` before plugin code runs, and unstamped frames are dropped.
  Building a socket over an existing fd is refused as well.
- **Plugin sandbox: the isolate's environment leaked the operator's identity, and two egress tunnels were
  missed.** `HOMEDRIVE`/`HOMEPATH` were on the child's environment allow-list, handing every isolate the
  host account's home path — the recon the `os.homedir()`/`os.userInfo()` scrub exists to hide; dropped.
  On Windows, libuv additionally merged `LOGONSERVER`/`USERNAME`/`USERPROFILE`/`USERDOMAIN` into every
  child environment regardless of the allow-list; the worker now prunes its own environment to the list.
  The egress filter handled IPv4-mapped, NAT64 and 6to4 embedded addresses but not their ISATAP and Teredo
  twins; both are classified now. The plugin-derived `fatal` message is bounded and stripped of control
  characters. `tty` is blocked: `new tty.WriteStream(3)` wrapped the IPC descriptor and destroying it
  severed the bridge.
- **Plugin sandbox: platform confinement narrowed on all three operating systems, and the static permission
  scanner reads `network` correctly.** On Linux the cgroup teardown tracked the `systemd-run` wrapper, not
  the scope, so "stopped" could be reported while the plugin still ran; it now waits for the scope to be
  gone. On macOS the Node runtime read grant degenerated to all of `/usr/local` for a nodejs.org or
  Intel-Homebrew install; a shared package prefix is now narrowed to the runtime subdirectories. On
  Windows the AppContainer `traverse` grant used `(RX)`, which on a directory includes list access, so a
  plugin could enumerate the application root and the plugin roster; it is now traverse-and-stat only.
  The static scanner mis-read a bare `{"scope":"network"}` declaration as absent, reporting a missing
  network permission against manifests that had declared it; `network` is scope-only and now matches on
  scope alone.

### Documentation

- **2423 claims were checked against the code; 225 were corrected and 23 deleted.** The README described
  a Linux sandbox of unprivileged users, dropped capabilities, namespaces and a read-only filesystem —
  none of which is in the code; the shipped mechanism is Landlock with seccomp-bpf, and Windows and
  macOS run AppContainer and Seatbelt. Six places advertised "64 first-party themes": the theme
  catalogue was retired, its built index is empty, and four themes ship bundled instead.
  `frontend/README.md` still described the editor as Puck-based, citing two paths that no longer exist.
- **Two documents moved to English**, which is the rule for anything public here.
  `documentation/plugin-database.md` is linked from the README and is plugin-author documentation; ADR
  0006 was the only Spanish one among seven. The sixteen `documentation/verso/*` programme notes are
  still Spanish; nothing links to them, and they are a separate pass.
- The ADRs were left as written — apart from that translation, they record decisions as they were taken.

- README and `documentation/**` updated to describe Verso and the current block API, including the
  compatibility guarantees above. Several claims that no longer matched the code were corrected rather
  than reworded — the inline text toolbar's real feature set, the editor canvas being a same-origin
  route rather than a `srcdoc` iframe, the removed `build:editor` CI step, and the `GET /api/v1/themes`
  call the canvas actually makes. The retired editor's `eval` and `srcdoc` iframe were also two of the
  stated reasons the CSP is widened; that is now flagged as an open cleanup rather than a live
  justification, because the policy itself has **not** been re-narrowed.
- `docs/media/puck-editor-demo.gif` → `docs/media/verso-editor-demo.gif`, and **re-recorded**. The old
  picture had been taken by hand and had drifted: seventy-seven commits touched `frontend/src` since,
  four of them changing exactly what the caption promised — what you drag is now the block itself rather
  than a card with its name, and the drag preview hangs from where you grabbed it. It was a picture of
  an editor that no longer behaves that way. `scripts/record-editor-demo.mjs` makes the recording
  repeatable, driving the same palette attributes and the same real pointer drag the e2e specs drive,
  so it records a path the suite also exercises.
- **Every documentation file was audited against the code a second time, after the changes above
  landed.** 128 claims were re-checked, each by an adversarial verifier reading the doc and the code;
  114 were real incongruences. 105 were the documentation being wrong and are corrected in place —
  commands that did not exist, permission names and defaults that had drifted, endpoints and status
  codes, the environment allow-list, the security posture text, third-party notices. The other 9 were the
  *code* deviating from clearly documented intent; those are fixed in the code and listed above rather
  than edited out of the docs.

### Notes for upgraders

- **Release tags before this one point at a rewritten history.** No previous tag (`v1.14.1` and earlier)
  is an ancestor of the current `main`: the public history was rewritten and the existing tags were left
  where they were, so `v2.0.0` is the first tag on the current history, and comparisons such as
  `git diff v1.14.1..v2.0.0` or `git merge-base` against an earlier tag will not be meaningful.
- **`express:register_route` and `admin_menu:register` are now enforced.** A plugin that mounts an HTTP
  route or adds an admin-menu item must declare the permission in its manifest, and the operator must
  grant it in `/admin/plugins`; previously both worked regardless of grant or revoke. Every marketplace
  plugin already declares them. A private plugin that relied on the gap logs a denial, and its route or
  menu item does not appear until the permission is granted.
- **An isolated plugin did not start on macOS in source mode — found while preparing this release and
  fixed the same day, after the release commit.** Nothing in CI had ever booted a plugin on macOS before,
  so the first run failed during startup with nothing on stderr while every Seatbelt profile variant
  booted cleanly on its own. Bisecting the launch layers named the cause: ts-node calls `process.cwd()`
  to find `tsconfig.json`, and macOS resolves a working directory by reading each of its ancestors, which
  the Seatbelt profile withholds on purpose (`EPERM: uv_cwd`). The compiled worker was never affected.
  The fix widens no grant: the child starts in `/`, the ts-node preload is resolved to an absolute path
  and `TS_NODE_PROJECT` is passed explicitly. The guard suite now gates on all three platforms.

## [1.14.1] - 2026-08-11

Ships the dependency fix that v1.14.0 was published without, and closes the pipeline hole that let it
be published at all. **Anyone on v1.14.0 should upgrade.**

### Security

- **A HIGH-severity advisory in a production dependency was bundled into the v1.14.0 release ZIP.**
  `js-yaml` (reached through `swagger-jsdoc` → `@apidevtools/swagger-parser` →
  `json-schema-ref-parser`) was pinned at 4.3.0, which carries **CVE-2026-59870** — quadratic CPU
  consumption resolving `!!omap`, with the fix not backported. Bumped to 4.3.1. `nanoid` 3.3.16 →
  3.3.18 in the same pass (GHSA-2v37-7h3g-55p8: a custom generator can loop indefinitely when size is
  zero). Two transitive version bumps, no API change.

- **The release pipeline could publish while CI was red — that is how the above shipped.**
  `release.yml` and `ci.yml` are independent workflows: both fire on the tag push, neither waits for
  the other, and nothing in the release ever asked whether CI had passed. CI *did* catch the advisory
  — `npm audit --omit=dev --audit-level=high` failed on the very tag that published — and the release
  went out regardless.

  The gates release.yml already had (smoke-boot the built bundle in all three deploy modes, verify the
  marketplace catalog against its artifacts) answer *"does this artifact boot, and is it
  self-consistent?"*. They cannot answer *"is the code correct and are its dependencies safe?"*.

  A `verify` job now runs the prod audit in every workspace CI audits, plus the backend typecheck and
  test suite, and `build-release` **needs** it — so nothing is built and nothing is published unless
  that gate is green (`npm-publish` was already downstream of `build-release`). The checks are
  duplicated here rather than waiting on `ci.yml` deliberately: the two workflows start together, so a
  cross-workflow wait would be a race, while this is deterministic and self-contained.

## [1.14.0] - 2026-08-06

A security audit, and the theme system moves decisively onto its token contract: `theme.json` is the
theme, and `style.css` is compiled from it. 54 of the 64 catalogue themes are now pure generated output
(the other 10 keep a little hand-written CSS for chrome decoration, which the compiler preserves
untouched outside its markers). The minor bump carries **two breaking changes to themes** — a custom
theme must be recompiled, and one that relied on the archetype preset stylesheet must move those values
into its tokens.

### Security

- **Stored XSS: an author could ship an executing `<script>` to every visitor (critical).** The Heading
  block used its `level` prop as the React element *type* and then set `dangerouslySetInnerHTML` on it.
  `level` comes from `_puck_data`, which any holder of `edit_posts` writes, and the write-side sanitizer
  classifies string leaves as HTML-bearing or URL-bearing only — a *structural* prop like this one passed
  through untouched by design. `level: "script"` therefore rendered a script element whose body was the
  (HTML-)sanitized title; an HTML sanitizer is inert when the sink is JavaScript. Author → Administrator:
  the script ran for every visitor of the public page, the admin included. Fixed with an allowlist of the
  six heading tags. The same line also 500'd the page on a void tag such as `img`.
- **The plugin SQL guard scoped DDL by the tables it named — so DDL that names none passed vacuously
  (critical).** A statement whose object class is a SCHEMA, DATABASE, ROLE, FUNCTION, EXTENSION or SYSTEM
  yields no table tokens, so the default-deny prefix rule was satisfied by an empty loop while `db.run`
  routed create/alter/drop to the **admin** connection. `DROP SCHEMA public CASCADE`, `CREATE ROLE …
  SUPERUSER` and a `SECURITY DEFINER` function reading `user_pass` were all permitted. Now a positive
  object-class allowlist: a plugin may only create/alter/drop its own TABLE, INDEX, VIEW or TRIGGER, and
  `RENAME TO` is prefix-checked.
- **Postgres' `*_to_xml` family let a read-only plugin read anything (high).** The guard blanks string
  literals precisely so their contents can never be read as SQL structure; these functions take a SQL
  *query* as a string argument and execute it, laundering a whole statement past both the prefix rule and
  the core-table denylist. Denied textually on every driver, as the file/extension functions already are.
- **An anonymous GET could force an unbounded full-resolution transcode (high).** `/uploads` sits behind
  no rate limiter, and `limitInputPixels` bounds *pixels* while the cost that OOMs a host is the decoded
  buffer plus the encoder's working set — a 24MP source cost **1120 MB and 18 s** for one request. Worse,
  the derivative cache key hashed the raw request path while the lookup used `path.join`, which
  normalizes: `/a/b.jpg` and `/a//b.jpg` were the same file under different keys, so one image was an
  unlimited supply of cache misses. The path is now canonicalized before the key is derived, and a source
  over a decoded-byte budget is served as-is rather than transcoded.
- **A plugin route registered with the `all` verb outlived its worker (medium).** Express implements
  `app.all()` by looping the concrete methods, so `route.methods` never has an `all` key and the
  verb-keyed unmount never matched. The endpoint of a deactivated plugin stayed live, and each request
  reached a dead child whose IPC failure is asynchronous — so it held a socket for the full 30 s RPC
  timeout. Teardown now matches the handler it mounted, and `rpcSend` fails fast when the child is gone.
- **A data-modifying CTE counted as a read (low).** `WITH t AS (INSERT …) SELECT 1` demanded only
  `database:read`; on Postgres the CTE executes regardless, so a plugin whose write grant had been revoked
  could still mutate its own tables.

### Themes

- **BREAKING — the legacy theme model is retired.** The archetype presets appended a stylesheet to every
  compiled theme: `.theme-container`, `.theme-hero`, `.theme-card-grid`, `.theme-card`, `.theme-badge`,
  `button.theme-btn`, plus bare `body` and `h1, h2, h3` rules. Nothing in the CMS renders those demo
  classes — they were dead bytes shipped to every visitor of 58 of the 64 catalogue themes — and the two
  element rules duplicated what `wordjs-ui.css` already derives from the tokens while leaking into
  surfaces a theme has no business styling. **3663 lines of CSS removed.** `archetype` remains a validated
  label; it emits no CSS and never fed a token.
- **BREAKING — the 44 archetype themes are rebuilt from their Stitch design systems**, and font family
  names are no longer mangled on import.
- **Heading typography moved into the token contract.** Retiring the preset stylesheet dropped
  `text-transform` and `letter-spacing`, which no theme's tokens covered, so 40 themes silently lost their
  heading treatment. The values are recovered verbatim from the retired presets and expressed as
  `--wjs-heading-transform` / `--wjs-heading-tracking` / weight — as *tokens*, because the framework
  styles headings through class selectors that outrank an element rule.
- **A stale marketplace catalog made installs fail, and the error surfaced three steps away.** The catalog
  was cached for 5 minutes keyed on source URLs alone, treating a local directory like a remote host.
  After `npm run build:marketplace` it advertised a zip filename that no longer existed: install 404'd,
  the theme never landed in `themes/`, and **activating it then reported "Theme not found"** — the only
  message an admin ever saw. Local sources are now stamped with their index file's mtime+size.
- **A missing active theme no longer promotes an arbitrary one.** `getActiveTheme()` fell back to whatever
  directory enumeration listed first, so deleting the active theme silently switched the site to an
  unrelated look while every derived answer disagreed with the `template` option. It now returns `null`.
- New `syncActiveThemeLayout()` reconciles `active_theme_layout` at boot — idempotently, since that option
  is on the purge allowlist and a needless write would evict the public cache on every restart.

### Frontend

- **An expired session is handled as the expected end state it is.** A dead session is now a global
  condition — like the install redirect and the MFA gate — announced once on `wjs:session-ended` and
  consumed by `AuthContext`, instead of surfacing as a console error from whichever background refresh
  happened to notice first. Classification keys on the backend's stable error code, never on the message;
  `rest_csrf_invalid` is deliberately excluded, because quietly signing a user out would bury a security
  signal.

### Documentation

- **Reconciled the whole set against the shipped code again** (18 files): the retired theme model, the
  theme token counts (753 tokens / 1724 `var()` uses across 73 groups, and 260–325 tokens per marketplace
  theme), and the chrome token family — 9 `--wjs-nav-*`, 2 `--wjs-logo-*`, 7 `--wjs-footer-*` — which the
  docs previously said did not exist.
- **Three new diagrams** (`docs/media/`): the declarative theme model, the plugin sandbox, and the three
  deployment modes. Animated SVG — diffable, ~8 KB each, and labelled for screen readers.

## [1.13.7] - 2026-08-01

Makes the v1.13.6 runtime code-generation block actually take effect, and reconciles the entire
documentation set against the shipped code.

### Security
- **Runtime code generation (`eval` / `new Function(string)`) is now genuinely blocked by default in
  the plugin worker.** v1.13.6 flipped the isolate's local default to on, but `config/app.ts`
  normalized `sandbox.blockCodeGen` with `=== true`, so on any stock install (config present, key
  unset) the value resolved to `false` — which the isolate reads as an explicit opt-out, leaving
  `--disallow-code-generation-from-strings` **off** on every normal boot (the v1.13.6 hardening was
  effectively inert). The normalization is now `!== false`, so the two layers agree: unset → **on**,
  `false` → off (deliberate opt-out for a trusted plugin whose deps need runtime codegen), `true` →
  on. Still force-disabled under `ts-node` (dev needs codegen to compile TS); only the compiled
  production worker applies the V8 flag.

### Documentation
- **Reconciled the whole documentation set against the shipped code, and redesigned the README.**
  Corrects accumulated drift across 20+ docs: the marketplace ships **31 plugins / 64 themes** (was
  28 / 12–13); plugin isolation is **`child_process`-only** (no live `worker_threads` fallback); the
  install wizard offers **four** database engines (SQLite native/legacy, PostgreSQL, MySQL/MariaDB);
  Linux kernel hardening is **default-on / opt-out**; `create-wordjs` is at the current release; plus
  assorted endpoint, config-key, CI, and cross-link fixes. The README is rewritten to be shorter and
  accessible to non-technical readers (plain-language intro, a new banner, feature cards, collapsible
  deep-dives). Internal working docs moved out of the user-facing tree to `docs/internal/`.

## [1.13.6] - 2026-08-01

Hardening of the plugin sandbox after a white-box guard audit + live escape attempts. A malicious plugin
could not exfiltrate anything in testing (the runtime guards held through ~70 black-box payloads and every
live escape attempt), but the audit surfaced a real weakening of the *static* layer and a latent flaw in
the fail-closed backstop. All three are closed and re-verified live.

### Security
- **The install-time AST scanner could be bypassed via the plugin's `dist/` directory.** The scanner skips
  a plugin's `dist/`, `client/` and `frontend/` folders (browser bundles that trip the source scan), on the
  assumption those never run in the backend worker — but a plugin could `require('./dist/x.js')` at runtime
  and execute un-vetted code there (an `eval` payload, or raw `process.binding('fs')`). The secure-require
  worker guard now refuses to load code from a plugin's `dist`/`client`/`frontend` (mirroring the scanner's
  skip so the two cannot diverge); a plugin has no legitimate reason to require its browser bundles
  server-side. Live-confirmed: `require('./dist/x.js')` now blocks with *"loading code from a plugin's
  browser-bundle dir is not permitted"*.
- **Runtime code generation (`eval` / `new Function(string)`) is now blocked by default in the plugin
  worker.** It was opt-in (`config.sandbox.blockCodeGen`); combined with the `dist/` gap above, a plugin
  could run engine-level `eval` the scanner never saw. The V8 `--disallow-code-generation-from-strings`
  flag is now on by default for the isolate, with an explicit opt-out for a trusted plugin whose deps
  genuinely need it. Verified not to break the worker (plugins still activate).
- **The isolation backstop read a reassignable global.** `getEffectivePlugin()`'s fail-closed
  backstop — and the io-guard DB-file block, secure-require's network check, and config/app's secret-load
  gate — read the isolation marker off the free identifier `global`, which is a writable property of the
  global object. A plugin doing a bare `global = {}` (flagged by no scanner visitor) could swap it and make
  the marker read `undefined`, collapsing the backstop to "host context" and handing the plugin the raw fs.
  All readers now use `globalThis` (unreassignable per spec) with the locked markers, so the reassignment
  cannot defeat them. Adds a regression test.



A deep zero-day hunt — ten agents each taking a high-complexity subsystem (SQL-guard, egress-guard, the
plugin↔host RPC bridge, gateway/cluster PKI, the auth state machine, novel XSS, supply-chain, crypto/ACME,
install/migration, authz chains). Seven subsystems came back genuinely hardened; these are the real
findings.

### Security
- **A self-edit could reset its own password without the current password (sudo re-auth bypass).**
  `PUT /users/me` requires the current password before changing it — a deliberate control against a hijacked
  session / same-origin XSS silently resetting the credential (the change also stamps `token_valid_after`,
  logging the victim out). The sibling `PUT /users/:id` self-edit branch (`isOwn`) reached the same password
  sink with **no** current-password check, so `PUT /users/:ownId {password}` bypassed the guard entirely —
  upgrading a transient session compromise into persistent account (or admin) takeover with victim lockout.
  Live-confirmed: `/me` → 403, `/:ownId` → 200. The re-auth is now a shared helper applied to **both** doors
  so they cannot drift; an `edit_users` admin resetting *another* user's password is unaffected.
- **The backend's mTLS did not verify it was talking to the gateway (split/separate mode).** The backend
  enforced `rejectUnauthorized` — the peer must present a cert chaining to the cluster CA — but never checked
  the peer's CN, so **any** cluster identity (e.g. a compromised frontend node's `CN=frontend` cert) could
  open a direct connection to the backend API, bypassing the gateway edge and forging `X-Forwarded-For` /
  `X-Forwarded-Host` to defeat the per-IP login throttle, CSRF same-origin and the migration guard (all of
  which trust the gateway to pin those headers). The backend now pins the peer CN to `{gateway,
  gateway-internal}` at the TLS layer, mirroring the gateway's own CN allow-lists; the gateway's
  `gateway-internal` client cert is the only legitimate peer, so nothing breaks.
- **Defense-in-depth hardening.** The plugin SQL-guard now denies `VACUUM` (a `VACUUM INTO '<file>'` produced
  no table token and slipped the prefix allowlist, though only a since-removed in-process path could reach
  it); `admin_notices` joins the protected-option denylist (so a plugin with an admin-granted `settings:write`
  cannot stash admin-context HTML there); and backend `sanitize-html` moves to `^2.17.5` to clear a latent
  `javascript:`-URI advisory (no reachable sink in any current config).

### Notes
- The hunt's other two candidates did **not** result in changes: a reported SPF DNS-lookup amplification in
  the mail-server plugin was a **false positive** against a stale on-disk copy — the shipped
  `marketplace/plugins/mail-server` evaluator already enforces the RFC 7208 §4.6.4 lookup budget and handles
  `redirect=`. Three exotic IPv6 egress-classifier gaps (Teredo `2001::/32`, RFC 8215 NAT64 `64:ff9b:1::/48`)
  are non-exploitable (unreachable on any normal host) and were left to avoid regressing the security-critical
  IP classifier for no live benefit.

## [1.13.4] - 2026-07-31

A second adversarial red-team pass (a fresh fan-out of exotic attack classes plus a hands-on plugin-sandbox
escape battery) over the running v1.13.3 lab deployment. The sandbox held on every one of ~40 escape
vectors across all five layers; these six findings are everything else that surfaced, each fixed and
re-verified live.

### Security
- **Comment API leaked commenter PII (email + IP) to anonymous callers.** `Comment.toJSON()` emitted
  `authorEmail` and `authorIp` with no gating, and the public `GET /comments` / `GET /comments/:id`
  (optionalAuth) returned them for every approved comment — so anyone could harvest the real email and IP
  of every commenter, administrators included, silently negating the `settings.ts` control that strips
  `admin_email` from public `/settings`. `toJSON(canModerate)` now omits both fields unless the caller
  holds `moderate_comments`.
- **Unbounded SSE connections were a denial-of-service.** `notificationService.addClient()` added every
  `/notifications/stream` to an unbounded set with no per-user or global cap, and each stream pins a socket
  plus a 5s keepalive timer — so one low-privilege account could open thousands of streams to exhaust file
  descriptors, timers and memory on the single shared process. A per-user cap (8) and a global cap (1000)
  now refuse and close excess streams.
- **`--allow-net` broke every network-capable isolated plugin in production.** The isolate launcher pushed
  `--allow-net` for a network-granted plugin, but Node's permission model has no such flag — the child
  aborted on startup with `bad option: --allow-net` (exit 9), so a plugin needing network (mail, Stripe,
  etc.) could not activate under the compiled/permission-model path. The invalid flag is removed; the JS
  egress guard remains — as it always was — the sole authority on a plugin's outbound traffic.
- **A self-service profile URL could store a `javascript:` scheme (second-order XSS).** `PUT /users/me`
  wrote `user_url` verbatim (no scheme check, unlike the guest-comment and admin-edit paths), and the
  logged-in comment path then copied it to a comment's `authorUrl` without `safeAuthorUrl`, reaching an
  `<a href>` in the moderation UI and public post page. `User.update()` now stores only http(s) absolute
  URLs, and the logged-in comment path applies `safeAuthorUrl` — both doors now match the guest door.
- **A plugin-activation race could corrupt the shared dependency tree.** The dependency conflict-check and
  the `npm install --save` into the app root ran outside the active-plugins lock, so two concurrent
  activations of mutually-incompatible non-bundled plugins each passed the conflict check and ran
  concurrent installs. Activations are now serialized end-to-end so the second cannot start until the first
  has committed to `active_plugins`.
- **The font upload was weaker than the media pipeline.** It accepted a file when *either* a font MIME *or*
  a font extension matched (so a `.html`/`.svg` with a `font/ttf` MIME slipped through) and kept the
  client's original name (allowing overwrite of existing/system fonts). It now gates on the font extension
  alone, stores under a random-suffixed font-only name, and returns a clean 400 on rejection.

## [1.13.3] - 2026-07-31

Found by an adversarial red-team pass over the **published 1.13.2 bundle** running in the lab — a fan-out
that invented novel attack classes beyond the standard families. Three issues, each fixed and re-verified
live where reachable.

### Security
- **A Host-header parser differential poisoned the SSR canonical / OpenGraph / JSON-LD base and slipped
  past the migration guard.** The request-host allowlist compared `host.split(':')[0]`, but the base URL
  was then built with `new URL()`. For a crafted `Host: <configured>:1@evil.example` the two parsers
  disagree — the naive split reads the userinfo as `host:port` and returns the configured hostname (so the
  allowlist passes), while `new URL()` resolves the true host to `evil.example`. Every server-rendered
  page's canonical/og:url/JSON-LD then anchored to the attacker's origin, and the API migration guard let
  the crafted host through. Both sides now derive the hostname with the WHATWG URL parser — the same one
  that builds the base — so the allowlist and the URL builder can no longer disagree. (backend migration
  guard in `index.ts`; frontend `metadataBase` and `resolveSiteBase`.)
- **The plugin-marketplace catalog/zip fetch was a host-side SSRF.** Unlike the webhook dispatcher and the
  plugin egress guard, the marketplace download ran through Node's global `fetch()` — invisible to the
  egress-guard's module hooks — with `redirect: 'follow'` and a source validator that whitelisted
  `http://localhost` and checked only the *scheme* for https. An admin-set source could therefore reach any
  loopback / RFC1918 / link-local target (a blind port-scan oracle via the catalog error body), and a
  public https source could 302-redirect to `169.254.169.254` cloud metadata. The fetch now uses the native
  http/https client through `assertUrlAllowed` + `validatingLookup` (rejecting internal targets and pinning
  the resolved IP against DNS rebinding), follows redirects manually while re-validating every hop, and
  permits `http://localhost` only outside production.
- **`PUT /users/me` (and `/users/:id`) was an authenticated account-existence oracle.** Setting the primary
  email to one already registered threw `Email already in use`, surfaced as a 500 — distinct from the 200 a
  free address returned. It now returns a uniform 400 whose code and message are identical to a malformed
  address, matching the anti-enumeration posture of registration and password reset.

## [1.12.13] - 2026-07-28

Everything here was found by installing the **published 1.12.12 bundle** on a real machine in all three
deploy modes. Nothing in it is reachable from the monolith, which is the only mode the release gate
booted — so the last item closes the hole that let the rest ship.

### Security
- **A node joined to a cluster came up with a default administrator.** `isInstalled()` meant "a
  `wordjs-config.json` exists", and `scripts/node-join.js` writes exactly that file to carry the gateway
  wiring onto a brand-new node. The node therefore reported itself installed, the setup wizard never ran,
  and the CMS bootstrap seeded `admin` / `admin123` on a backend already published through the gateway —
  logging in with those credentials through the public origin returned 200 with the `administrator` role.
  Install state now keys off a marker only the installer writes (`installedAt`, or `dbDriver` for sites
  that predate it), so an enrolled node correctly asks for the wizard. An unreadable config reports
  *installed*, so a parse error can never reopen the installer on a live site.
- **The bootstrap administrator no longer has a guessable password.** For the paths that still create
  one, it is now a random `base64url(24)`, written `0600` to `backend/data/initial-admin-password` and
  printed once, instead of a hardcoded `admin123` suggested in the log.

### Fixed
- **Split mode could not be installed at all.** The installer generates the cluster certificates and then
  calls the distribution step directly, which read an unset `genCertsDir` — after having emptied
  `backend/certs`. It threw, the installer logged a warning and still answered `{"success":true}`, and no
  certificate survived anywhere. The gateway then never started its control plane, no service could
  register, and every route 404'd — including the install wizard needed to create those certificates.
  Distribution now reads from wherever the certificates actually are and never empties the directory it
  is about to read; the gateway waits for the cluster identity to appear instead of giving up at boot,
  and answers on a loopback-only bootstrap route while the service owning a route has never registered.
- **The backend never noticed certificates issued after it started.** It read its client certificates
  once at boot, so a freshly installed instance kept retrying registration in the clear against a port
  with no such route. They are re-read on every attempt.
- **Server-side rendering could not reach an installed split backend.** SSR resolved to
  `http://localhost:4000` while the backend serves HTTPS with mTLS enforced, so every server-side fetch
  failed silently: public pages rendered default settings and content pages 404'd, while client-side
  calls through the gateway worked. SSR now goes through the gateway when the backend holds certificates.
- **The default theme hid the page title behind the header.** `.container` set the `padding`
  *shorthand*, which reset the layout's top and bottom padding to zero and left the fixed header sitting
  on top of every page's `<h1>`. It now sets `padding-inline`.
- **Starter cards rendered white on white.** The theme forced `.wp-block-card`'s background with
  `!important` but left the block's paired text colours alone, so an accent card lost its background and
  kept its light text. The card is styled through `--wjs-card-*` tokens instead.
- **A setting the installer was not given stored the text "undefined".** Options serialised with
  `String(value)`, so a headless install left `blogdescription` as the literal word, which rendered into
  `<title>`, `og:title` and `twitter:title`. Absent values now store empty, guarded at the writer.
- The backend boot banner printed `undefined/admin` for the admin URL in split and separate mode.

### CI
- **The release gate now deploys every mode, not just the monolith.** `scripts/smoke-deploy.sh` replaces
  the inline smoke step in both the PR and release workflows (one script, so they cannot drift) and
  drives the compiled bundle the way an operator does: the monolith must boot *and* be the thing
  answering `/healthz`; split must expose the wizard through the gateway before install, complete the
  install through the gateway, leave all three services holding certificates, render real settings, keep
  doing so after a restart onto HTTPS+mTLS, and refuse `admin/admin123`; an enrollment-shaped config must
  enter setup mode and seed no administrator. Verified to fail on each of the defects above and to pass
  once they are fixed.

## [1.12.12] - 2026-07-28

### Security — plugin sandbox hardening
- **A plugin could escape the sandbox to host RCE via `node:sqlite`.** The runtime module blocklists are
  keyed by name, and `node:sqlite` (unflagged since Node ~22.13) was not on them. Its `DatabaseSync` is
  C++-backed, so it never routes through the `fs`/`require` proxies or `io-guard`: a plugin could open and
  write **arbitrary files** by native code (reading the core credential DB — `users.user_pass`, stored
  option secrets — and writing host payloads) and, via `new DatabaseSync(path, { allowExtension: true })`
  → `enableLoadExtension(true)` → `loadExtension(dll)`, load a native addon (`process.dlopen` is blocked,
  but SQLite's extension loader is a separate native path) for full host code execution. `sqlite` is now
  blocked for plugins in both the CommonJS require guard and the isolate's ESM `import()` resolve hook.
- **The same escape class via `node:wasi`.** `new WASI({ preopens: { '/': hostDir } })` maps a host
  directory into a WASM instance whose native `path_open`/`fd_read`/`fd_write` bypass the filesystem
  guard; a plugin bundling a small `.wasm` could read/write host files. `wasi` is now blocked too.
- **The in-process `config/database` SQL guard diverged from the RPC bridge guard.** In-process plugins
  and every theme's `functions.js` reached a weaker, regex-based guard that `SELECT … FROM/**/users`,
  `FROM"users"` and `FROM(users)` evaded — and which applied no cross-plugin prefix restriction, so it
  could read any other plugin's tables. It now delegates to the same lexer-based `assertSqlAllowed` used by
  the bridge (comment/quote/dollar/bracket denial, catalog and file-function denial, single-statement
  enforcement, and the positive `wjp_<slug>_` prefix allowlist).
- **`process.report.getReport()` could leak the host environment to an in-process plugin/theme.**
  `writeReport()` had a runtime block but `getReport()`/`getReportSync()` did not, and the report includes
  `environmentVariables` — the full host `process.env` (secrets) for code running in the host process. All
  three report methods are now blocked in plugin context (core and the scrubbed isolate are unaffected).

### Security — supply chain
- **Marketplace integrity verification was optional.** Installs verified a package's SHA-256 only when the
  catalog entry carried one, so a remote source that simply omitted the field installed unverified
  server-side code. SHA-256 is now **mandatory for remote plugin and theme installs** (fail-closed); every
  official catalog entry already ships one, so this is a no-op for the default catalog.

### Added — editor & content
- Gutenberg-style block editor refinements continuing #274: an appearance/animation field system, reusable
  **Symbol** blocks, a **Form** block with server-side submissions, responsive image `srcset`, and dynamic
  block resolution on the public site.
- **Plugin provenance & one-click updates.** Each installed plugin is bound to the catalog source it came
  from (`plugin_origins`), gating updates so a second admin-added source cannot take over an installed
  plugin (with its approved grants and preserved data). `plugin_origins` is a protected option, off-limits
  to plugin SQL.

### Changed — themes & UI
- Marketplace theme catalog resync and a refreshed editor UI (Stitch design system) across the admin chrome
  and the shared `wordjs-ui` block-style framework.

## [1.12.11] - 2026-07-23

### Changed — editor
- **Gutenberg-style editor chrome with a reliable canvas contract (#274).** The block overlay and action
  bar are portaled out of the editor iframe to a parent layer, so they are immune to the page's own CSS;
  the canvas persists its layout contract, and tall pages scroll correctly inside the editor frame.

## [1.12.10] - 2026-07-23

### Fixed — admin UI
- **The media library's upload button did nothing.** The trigger was a real `<button>` nested inside a
  `<label>` wrapping the hidden file input; per HTML an interactive descendant cancels the label's
  activation, so the click never reached the input and the file picker never opened. It now triggers the
  input directly.
- **The media picker was untranslated and heavy-handed.** "Select Media", "Search media…", "Cancel",
  "Refresh", "No media found" and "Select" were hardcoded English in an otherwise localized UI, over a
  flat gray slab. All strings now route through i18n (es/en/pt) and the backdrop is a soft dark blur
  matching the app's other modals.

### Changed — security
- **Creating, listing and revoking personal API tokens now requires a `manage_api_tokens` capability.**
  It was self-service for every logged-in user; minting a token is a privileged action even though the
  token inherits the owner's own permissions. Administrators hold the capability via the `*` wildcard,
  and it is assignable to other roles in Users → Roles. Enforced at the backend routes and hidden from
  the sidebar for users who lack it.

### Fixed — mail-server plugin (2.2.1)
- **The preferences modal (gear) and the undo-send countdown rendered behind the page.** They used
  arbitrary Tailwind z-index classes (`z-[6500]`, `z-[7000]`) that are only present in the served CSS
  when Tailwind happens to scan the plugin at frontend-build time; when absent, the z-index resolves to
  `auto` and the elements stack behind the plugin's own content — so the settings modal looked broken and
  the "undo send" toast never appeared. The z-index is now set inline, which always applies. The
  overlay's backdrop-blur was also removed.

## [1.12.9] - 2026-07-23

### Fixed — TLS certificates (Let's Encrypt / ACME)
- **No certificate could ever be issued — by either validation method.** The final step handed
  acme-client a hand-made `{ url }` stub instead of the order the CA issued. acme-client requires
  `order.finalize` (the URL the CA returns when the order is created) and refuses without it, so every
  request ended in *"Unable to finalize order, URL not found"*. `createOrder` had the CA's full order
  object and kept only its `url`, discarding `finalize` before it could be used. HTTP-01 failed
  identically; it simply went unreported because the flow rarely got that far. Both paths now re-read
  the order from its URL and finalize that, which also picks up the order's current state — relevant to
  the two-step DNS flow, where minutes or hours pass between starting and finishing.
- **A domain that had already passed validation could no longer get a certificate at all**, failing with
  *"Challenge type http-01 not found for this domain"*. A CA reuses an authorization it has validated
  (Let's Encrypt keeps them for about a month) and returns it without the challenge menu a pending one
  carries — there is nothing left to prove. Insisting on finding a challenge turned that into a hard
  error by **both** methods, which is exactly the dead end left behind by a successful validation
  followed by the failed finalize above. Such an order now skips straight to finalization; no challenge
  is served and, for HTTP-01, port 80 is not needed at all.

## [1.12.8] - 2026-07-23

### Fixed — login lockouts
- **One user's failed logins no longer lock out everyone sharing their IP.** Brute-force protection
  keyed on the client IP alone, with a 10/hour budget that counted successful requests too — so every
  account behind one public address (office NAT, VPN, household) shared it, and one person mistyping a
  password answered *"Too many login attempts"* to all of them. A user who merely enabled and then
  disabled their own 2FA burned the same budget and locked themselves out of login.
  The primary control is now an escalating per-**(IP + account)** lockout: 5 consecutive failures block
  that pair for 5 → 10 → 30 → 60 minutes (the last rung repeating), and a successful login wipes the
  ladder. Attempts made during a block do not extend it. Tunable under `auth` in `wordjs-config.json`.
- The account-wide lockout is unchanged and still runs alongside it — keyed on the account alone, it is
  the backstop against a distributed attack on one account from many IPs, which per-IP keying cannot
  see. The per-IP limiter remains as a third layer but now counts **only failed** attempts, so
  successful logins never consume the budget.

### Fixed — TLS certificates (Let's Encrypt / ACME)
- **DNS-01 could fail with "No such challenge" after a correct TXT record was published.** The ACME
  directory was process-global sticky state (`if (useStaging)` with no else, on a singleton), so an
  auto-renewal configured for staging pinned the whole process to staging and later "production" orders
  went there silently; a restart then reset it to production. An order's challenge URL exists at exactly
  one endpoint, so a two-step flow that crossed that boundary was rejected — while the operator's DNS
  record was correct all along. The finish step is now paired with the directory that minted the
  challenge, which holds even across a restart mid-flow, and the CA's raw message is mapped to an
  actionable one.

## [1.12.7] - 2026-07-23

### Fixed — TLS certificates (Let's Encrypt / ACME)
- **DNS-01 issuance could never succeed.** The TXT value shown in the admin UI was hashed twice, so it
  could never match what the CA looked up. `getChallengeKeyAuthorization()` is challenge-type aware: for
  `http-01` it returns the file content, but for `dns-01` acme-client **already** applies RFC 8555 §8.4
  (`base64url(sha256(token.thumbprint))`). The old `getDNSDigest()` helper digested that result a second
  time. The value acme-client returns is now published verbatim and the helper is gone.
- **The propagation check reported "record not found" indefinitely** even when `dig` showed the record.
  It used the OS stub resolver, which negative-caches the NXDOMAIN from a check clicked before the record
  existed (for the zone's negative TTL), and on split-horizon DNS may never see public records at all.
  It now queries public resolvers (1.1.1.1, 8.8.8.8) with an OS-resolver fallback, follows CNAME chains
  (delegating `_acme-challenge` to another zone is a common DNS-provider pattern) and joins multi-chunk
  TXT records per record instead of comparing individual 255-byte chunks.
- **A local pre-verify miss no longer aborts a valid order.** `verifyChallenge()` fetches the challenge
  from *this* machine; behind NAT without hairpin, the server often cannot reach its own public hostname
  even though the CA can. The local check is now advisory — the authoritative verdict comes from the CA
  via `completeChallenge` + `waitForValidStatus`.
- **The admin request no longer hangs for minutes.** Outbound ACME HTTP is bounded (10s) and the retry
  backoff is capped (5 attempts, 3s–10s); the defaults let validation spin roughly four minutes inside a
  single admin request, and an unreachable port 80 hung on the OS TCP timeout.
- **A failed gateway push no longer reports success.** `updateSSLConfig()` is async and was not awaited,
  so the rejection went unhandled and the admin was told the certificate had been installed.

### Changed
- `react` and `react-dom` to 19.2.8, in both trees that install them. The root package is the gateway's
  and the copy that reaches a browser is pinned by `frontend/package-lock.json`; bumping only the root
  would have moved a version nobody executes.

## [1.12.6] - 2026-07-23

### Fixed — inbound mail
- **A `~all` (softfail) SPF result no longer rejects the message.** `spfAction()` let softfail fall through
  to the same permanent 550 as a hard `-all` fail. RFC 7208 §8.5 says a softfail is weak evidence and
  SHOULD NOT be used on its own to reject — and `~all` is what **gmail, google and microsoft all publish**,
  so legitimate forwarded and mailing-list mail from the largest senders was permanently bounced. Softfail
  is now accepted and tagged, like permerror; the verdict is still recorded in `Received-SPF`. A hard
  `-all` still rejects. *(Found on a live MTA: it was the one lab row whose outcome never changed between
  the broken and the fixed build while its cause did.)*
- An `ip6:` network written with an IPv4 dotted quad is now parsed as the address it names (RFC 4291
  §2.2(3)), and the CIDR-prefix guard is pinned by tests — reverting it previously left the suite green
  while `ip4:198.51.100.0/0x1f` re-parsed to `/0` and produced a **forged SPF pass for any sender**.

### Fixed — corporate mailboxes (behaviour change, read this)
- **Only an administrator (or an `edit_users` delegate) can decide who has a mailbox.** The grant is now
  explicit admin-owned state (`user_meta.professional_mailbox`) set by the "Professional Mail Account"
  toggle, instead of being inferred from the account's own email address — which the account could rewrite
  itself, making the mailbox self-issuable. `PUT /users/me` and `POST /auth/register` now also refuse to
  put an unprivileged account on the site's mail domain.
- **On upgrade, migration 0006 grants the mailbox only to administrators and `edit_users` holders.** Every
  other account whose address is on the mail domain is left DISABLED, listed in the boot log and recorded
  in the `professional_mailbox_migration_pending` option: a provisioned address and a self-assigned one are
  indistinguishable after the fact, so the safe side is chosen. **A legitimate mailbox holder loses webmail
  until an admin re-enables them** — their mail is not lost (catch-all, or a normal SMTP 5xx).
- The mail plugin now publishes its resolved mail domain to the host as the `mail_domain` option. The host
  previously read `mail_security_dkim_domain`, which is stored as a plugin secret and never appears in the
  options table, so on a `www.` install the address reservation protected the wrong name.

### Fixed — plugin & theme process lifecycle
- Switching a theme no longer leaves the OUTGOING theme's isolate running with its hooks, shortcodes and
  routes still wired to the host.
- A second concurrent load of the same plugin or theme can no longer orphan the first child; a load that
  fails now tears down anything it registered instead of leaving a live, unreachable process.
- Repeated theme re-inits COALESCE instead of each running a full reload: `render()` re-inits lazily, so
  concurrent page requests used to queue one sweep-and-re-fork cycle each, and renders landing between them
  got no theme logic at all.
- Activating a theme no longer reports success for a theme the site is not on (overlapping activations
  could silently discard the last click).

## [1.12.5] - 2026-07-22

### Fixed

- **Marketplace plugins' frontend hooks now register in production.** A plugin can extend core admin UI
  through the hook system (`manifest.frontend.hooks`), but those hooks were resolved *only* from the
  registry compiled into the frontend at build time — the same build-time-baking root cause already fixed
  for admin pages and Puck blocks in 1.12.3. On a production install that registry is frozen (and a release
  ships zero plugins), so a marketplace-installed plugin's hooks never registered and its UI extension was
  simply absent: the mail server's **"Professional Mail Account"** toggle never appeared in the user form,
  even though the plugin was active and its `dist/hooks.bundle.js` was installed and served. The admin shell
  now also loads every **active** plugin's pre-compiled hooks bundle at runtime and invokes its `register*`
  exports, which register into the host's own `pluginHooks` singleton.
- **A plugin activated from the admin UI takes effect without a manual page reload.** The runtime loader
  memoized the list of active plugins for the whole session, on the assumption that activating one reloads
  the page — it does not; the plugins screen only re-fetches into React state. So the plugin just activated
  was missing from every later lookup and its hooks and Puck blocks stayed dead until the admin reloaded
  the tab by hand. Activating or deactivating now invalidates that list and re-runs hook registration
  immediately; plugins already registered are skipped, so nothing is loaded or registered twice.
- **Block-only marketplace plugins ship their compiled block again.** The catalog builder re-derived which
  frontend entries a plugin declares instead of asking the bundler, and its copy had drifted from the real
  manifest shape (it read `frontend.component.entry` — the key is `puckComponents.entry` — and treated
  `frontend.hooks` as an object when it is a string). Any plugin without an admin page therefore compiled
  **nothing**: `breadcrumbs`, `related-posts` and `table-of-contents` shipped without the
  `dist/component.bundle.js` their Puck block needs to load at runtime. Entry resolution now lives solely in
  `build-plugin.js`.
- **A declared-but-missing frontend entry fails the plugin build.** `build-plugin.js` silently skipped an
  entry whose file did not exist and still reported success, so a typo in `manifest.frontend` produced a
  plugin that installs cleanly and whose UI is merely invisible at runtime. It is now a build error.

## [1.12.4] - 2026-07-22

### Fixed

- **Marketplace plugins install their declared npm dependencies on activation** (regression from 1.12.3).
  Since 1.12.3, `build-marketplace` compiles a `dist/*.bundle.js` (the plugin's frontend) into every
  catalog zip — but `isBundledPlugin` treated the presence of a `dist/*.bundle.js` as "dependencies
  packaged", so **every** marketplace plugin skipped its dependency install. A plugin that needs backend
  npm packages at runtime — e.g. the mail server (`smtp-server`, `nodemailer`, `mailparser`) — then failed
  to activate with `Cannot find module 'smtp-server'`. Now a plugin is only "self-contained" when it ships
  a non-empty `node_modules/` or declares `"bundled": true`; a compiled frontend bundle no longer counts.
  The dependency installer also checks whether each declared dependency is already **resolvable** (in any
  `node_modules/` the plugin's `require()` walks through — its own, the backend's, or the root's) before
  installing, so present dependencies aren't reinstalled and only genuinely-missing ones are.

## [1.12.3] - 2026-07-22

Marketplace plugins now work **fully** on a production install — both their admin pages and their
Puck editor blocks load at runtime — and every plugin ships from the marketplace rather than the core
bundle.

### Fixed

- **Marketplace-installed plugins render their admin page in production.** A plugin installed at runtime
  from the marketplace showed **"Plugin Not Found"** (or a blank/unstyled panel) for its admin page on any
  production (pre-built) install, because the admin UI was resolved only from a registry compiled into the
  frontend at *build* time. The admin router now falls back to loading the plugin's pre-compiled
  `dist/admin.bundle.js` **at runtime**; `build-marketplace` compiles each plugin's bundle into its catalog
  zip; plugin bundles resolve `react` and the 12 host modules they use (`@/lib/api`, i18n, the modal/toast/
  auth contexts, media picker, ui components — via the `@/` alias *or* legacy relative paths) to
  host-injected `window.WordJS.*` globals; and the `/plugins` handler maps a plugin's admin URL slug to its
  on-disk folder so `admin.css`/`manifest.json` resolve. (Hardening: request-slug filesystem access is
  containment-checked; unmapped host imports fail the build loudly.)
- **Marketplace plugins' Puck editor blocks load at runtime too.** Their blocks were likewise baked at
  build time, so a marketplace plugin's blocks never appeared in the editor palette and rendered as
  nothing on published pages. `build-plugin` now builds the block (`component`) bundle from
  `puckComponents.entry`, and a new client hook merges active plugins' block configs into the Puck config
  for the editor **and** the public site. Hydration-safe: SSR and the first client render use the base
  config (Puck already skips unknown block types), then the block appears once its bundle loads.

### Changed

- **All first-party plugins now ship from the marketplace, not the core release bundle** (`card-gallery`,
  `photo-carousel`, `video-gallery` moved to `marketplace/plugins/`). A fresh install ships with no
  pre-bundled plugins; install what you need from the marketplace. (Unpublished private plugins are
  unaffected — they are never part of the catalog.)

Validated end-to-end on a clean production install (Proxmox LXC): a plugin installed from the marketplace
renders its styled admin page, its block appears in the editor palette and canvas, and a published page
renders the block with zero hydration errors.

## [1.12.2] - 2026-07-22

A documentation patch.

### Docs

- **`create-wordjs` now documents `npx create-wordjs@latest …` everywhere** (README, `--help`, the
  gateway-printed `join` commands, and `documentation/`). `npx` caches downloaded packages, so a bare
  `npx create-wordjs` could silently re-run an **old cached copy** — one that predates the `upgrade`
  subcommand and rejects it with a confusing `✖ Unexpected extra argument`. Pinning `@latest` (the
  standard convention for `create-*` tools) always fetches the current release. The README also adds a
  note and the `rm -rf ~/.npm/_npx` cache-clear escape hatch. No runtime code changed.

## [1.12.1] - 2026-07-22

A security patch tightening the v1.12.0 DNS bridge.

### Security

- **The plugin DNS bridge now reuses the egress-guard's `isBlockedIp` policy** to strip private-IP
  answers, instead of a hand-rolled filter that had drifted from it. The old filter classified IPv6 by
  textual prefix and so leaked private answers in several forms a real system resolver can return:
  hex-form IPv4-mapped metadata (`::ffff:a9fe:a9fe`), expanded loopback (`0:0:0:0:0:0:0:1`), NAT64
  (`64:ff9b::/96`) / 6to4 (`2002::/16`) wrapping a private v4, `fec0::/10` site-local, and IPv4/IPv6
  multicast + reserved. `isBlockedIp` classifies by numeric bytes, so every spelling is caught, and it
  fails closed on unparseable input. Network-grant-gated and low-severity — the socket connection was
  always egress-guarded, so this was internal-IP *recon* via `resolve4`/`resolve6`, not direct reach —
  but now closed. `resolveMx`/`resolveTxt` behavior is unchanged.

## [1.12.0] - 2026-07-22

A **mail + connectivity** release: a sandbox-safe way for plugins to resolve DNS records, a full webmail
upgrade for the mail server, and a fix that makes local split-mode deployments work out of the box.

### Added

- **Host-mediated DNS bridge** (`wordjs.dns.{resolveMx,resolveTxt,resolve4,resolve6,resolve}`, gated on the
  `network` grant). The raw c-ares resolver surface stays denied inside the sandbox (it bypasses egress
  filtering and enables internal DNS recon), but a real mail server needs MX (direct-to-MX delivery) and
  TXT (SPF/DKIM/DMARC) records that `dns.lookup` can't provide. The **host** performs those queries and
  **strips any answer pointing at a private/internal/metadata IP**, so the capability can't be used for
  SSRF or internal recon — and the actual SMTP connection still goes through the egress guard.
- **Mail server v2.1** (first-party plugin) — a full webmail: a spam folder, custom labels, undo-send,
  vacation auto-replies, search operators (`from:` / `has:attachment` / `is:unread`), and contact
  suggestions, on a per-user ownership model with indexed (not full-table-scan) listings.

### Fixed

- **Local split mode works out of the box.** A fresh install running `npm start` (gateway + backend +
  frontend on one machine) now serves correctly through the gateway. The gateway and frontend fall back to
  `backend/certs` for their mTLS certs (the install generates them there; only the *separate*-mode flow
  populated `gateway/certs` / `frontend/certs`), and the backend binds `127.0.0.1` instead of `localhost`
  → `::1`, matching the IPv4 address it advertises to the gateway. Separate mode and monolith are unaffected.

### Security

- Dependency bumps clearing fresh advisories: **sharp → 0.35.x** (bundled-libvips CVEs), plus
  `body-parser`, `fast-uri`, and a `postcss` frontend override.

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
