# Multisite — several sites from one install

A WordJS install can serve a **network** of sites. Each site has its own address, its own database, its
own uploads, users, roles, settings, menus and theme choice, and none of it is visible to any other site.
The install that existed before multisite was turned on is **site 1, the main site**: nothing of it moves
or changes. The design, the isolation guarantees and the road ahead are in
[Multisite: design](multisite-design.md).

- [What a network is](#what-a-network-is)
- [Requirements](#requirements)
- [Turning it on](#turning-it-on)
- [Creating a site](#creating-a-site)
- [DNS, the gateway and TLS](#dns-the-gateway-and-tls)
- [Changing a site's address](#changing-a-sites-address)
- [Suspending a site](#suspending-a-site)
- [Opening a site as administrator](#opening-a-site-as-administrator)
- [Deleting a site](#deleting-a-site)
- [What the network manages on the main site](#what-the-network-manages-on-the-main-site)
- [Backups](#backups)
- [Real-time collaboration](#real-time-collaboration)
- [Where a site's data lives](#where-a-sites-data-lives)
- [Several backend nodes](#several-backend-nodes)
- [Changing the database engine](#changing-the-database-engine)
- [REST API](#rest-api)
- [Turning it off](#turning-it-off)
- [Upgrading from 2.7](#upgrading-from-27)
- [Troubleshooting](#troubleshooting)

## What a network is

| | Main site (site 1) | Every other site |
|---|---|---|
| Address | `siteUrl` and its aliases ([Site address](site-address.md)) | One main address, set when the site is created |
| Database | Its database, as before | Its own: a SQLite file, a Postgres schema or a MySQL database ([below](#where-a-sites-data-lives)) |
| Uploads | `uploads/` and `data/private-uploads/`, as before | `<data dir>/sites/<id>/uploads/` and `…/private-uploads/` |
| Users, roles, sessions | Its own | Its own. User ids repeat across sites; a session or API token of one site is refused on every other |
| Plugins | Installed here, for the whole network; activated and granted here | Activated and granted per site, among the plugins the network offers ([below](#plugins-on-the-sites)) |
| Themes | Installed and edited here | Chosen and customised per site; the theme files are shared; each site runs its own theme server code |
| Pages and sign-in screens | Rendered as before | Rendered in the site's own document: `<html lang>` and text direction from its language settings, its uploaded fonts, its name in every title (the sign-in, registration and password screens included) |
| TLS certificate | Security → Automatic Certificate Renewal, as before | Its own, for its address, served by SNI ([below](#dns-the-gateway-and-tls)) |
| Backups | Settings → Backups (network administrators) | Its own, made and restored by its administrators ([below](#backups)) |

A request is assigned to a site by the address it was sent to. An address no site declares is answered
`421 Misdirected Request`, exactly as on a single site. Loopback addresses and IP literals always mean
the main site.

**Network administrators** are administrators of the main site that are listed as such. They see
**Admin → Network**, where sites are created, suspended and resumed, and from which they can open any
other site's admin through an audited, 30-minute handoff ([below](#opening-a-site-as-administrator)). A
site's own administrators manage that site only and never learn that other sites exist.

On the main site, what reaches the whole network is for network administrators only: installing,
updating, packing, downloading or deleting plugins, writing theme files, the marketplace, backups, the
database migration tool, the site's addresses, certificates, the hooks registry and the Redis
object-cache switch. An administrator of the main site who is not listed still runs the main site itself
(its content, users, plugin activations and grants, settings) and gets `403 rest_forbidden_network` for
the rest. A network administrator's account (email, password, role, two-factor reset, AI agent
connections, deletion) is changed only by a network administrator or by its owner. Deleting an account
removes it from the list, and each entry is bound to the account's login: at boot and after a backup
restore it follows that login, and is dropped when the account is gone.

## Requirements

**Settings → Network** checks all of this for you and says, in plain words, what is missing and how to
fix it from the panel.

- One of the `sqlite-native`, `postgres` or `mysql` (MariaDB too) database drivers. An install on
  `sqlite-legacy` is offered **Move to the current SQLite engine** right on that screen: WordJS makes a
  backup (Settings → Backups), copies every table into `sqlite-native` with a progress bar, keeps the old
  database file as it was, and restarts by itself.
  - **Postgres**: the WordJS database user needs `CREATE` on its database (each site is a schema of it).
    Without that right, create the schemas `wordjs_network` and `wordjs_site_<id>` for it beforehand.
  - **MySQL / MariaDB**: the user needs `CREATE` (each site is a database named `<db.name>_site_<id>`, and
    the network store is `<db.name>_network`), and `db.name` must be made of lower-case letters, digits
    and underscores. Without the right, create those databases beforehand.
  - To give each site's plugins their own database principals ([plugins](#plugins-on-the-sites)), the
    user needs `CREATEROLE` (Postgres) or `CREATE USER` and `GRANT OPTION` (MySQL), as on a single site.
- One backend host on `sqlite-native`; one or more on Postgres and MySQL ([Several backend
  nodes](#several-backend-nodes)). In split and separate mode the gateway is told the network's addresses
  by the backend, as it is told the main site's.
- An installed site (the install wizard finished), with a main address (Settings → Site address).
- Two-factor authentication on the account of whoever turns the network on or off (My account →
  Two-factor authentication): the switch asks for the password and a current code.

## Turning it on

**Settings → Network**, as an administrator of the main site:

1. **What the network needs** lists each requirement with a tick or what to do about it (see
   [Requirements](#requirements)).
2. **Network administrators**: tick the administrators of the main site who will run the network (you
   are ticked already). Only they see **Admin → Network**.
3. Enter your password and a current two-factor code, and click **Turn the network on**.

WordJS records the main site as site 1 (nothing of it moves), creates the network store
(`<data dir>/network.db` on SQLite, the `wordjs_network` schema on Postgres, the `<db.name>_network`
database on MySQL), writes `multisite.enabled` in `wordjs-config.json`, records the switch in the network's
audit log and in the site's (`network.enable`), and **restarts itself**: the page waits a few seconds and
opens **Admin → Network**. With several backend nodes, every node applies the change and restarts too
([below](#restarting-by-itself)).

Network administrators are added and removed later on the same screen (your password confirms each
change; the last one cannot be removed).

**From a terminal instead** (optional, the same result), on the backend's machine, as the install's owner:

```bash
npm run network -- enable --admin admin
npm run network -- status
npm run network -- admins add <login>
npm run network -- admins remove <login>
```

`--admin` names one or more administrators of the main site (comma-separated logins). The CLI does not
restart anything: restart the backend afterwards (the monolith, or every backend process in split and
separate mode).

### Restarting by itself

`multisite.enabled` and the database driver are read when the backend starts, so the panel restarts it
after turning the network on or off and after a database migration. How depends on how WordJS runs:

| Started with | Restarted by |
|---|---|
| `npm start` (split mode), `npm run start:mono` / `node monolith.js` (monolith, the Docker image) | Its own supervisor (`backend/server.js`, `monolith.js`): the app exits with code 75 and is started again at once. A crash is still a crash. |
| `npm run dev` | `node --watch` (the entry file is touched). |
| Docker's restart policy, Kubernetes, systemd, pm2 | The service manager (the process exits with code 75). |
| Anything else (for example `node dist/index.js` typed by hand) | Nobody: the screen says so before you switch, saves the change, and asks you to restart WordJS once. |

Several backend nodes (Postgres or MySQL): the node that made the change announces it on the Redis bus
(`wordjs:node-restart`); every other node writes the same `multisite.enabled` to its own
`wordjs-config.json` and restarts. A node that was down at the time reads the switch from the network store
when it starts, applies it and restarts once.

## Creating a site

Admin → Network → New site:

- **Site address** — `http(s)://host[:port]`, no path. A domain or subdomain (not an IP address, not
  `localhost`) that no site of the network answers yet. **On a local or development install** (the main
  site is `localhost`, a loopback IP or a `*.localhost` name), a name under `.localhost` works too, such as
  `http://blog.localhost:3000` with the main site's port: browsers resolve every `*.localhost` name to the
  computer itself, so it needs no DNS and no certificate (none is requested for it), and nobody else can
  reach it. The New site form says so when it applies. A public network refuses `.localhost` names.
- **Slug** — a short name for the site (lower-case letters, digits and dashes).
- **Site title**, and the **first administrator**'s username, email and password.
- **Your current password** — creating a site publishes a new address, so it re-authenticates you.

The site is provisioned all at once — its record and address, database (file, schema or database), upload
directories, default options, a default category and its first administrator — or not at all. Its
administrator then signs in at `<site address>/login`. Within a few seconds the gateway answers the new
address too, and so does every other backend node of the network. A site's id is never given to another
site, even after it is deleted.

## DNS, the gateway and TLS

Point the new name at the server the main site runs on, exactly as you did for the main address.

- **Monolith and split mode**: nothing else; the backend's address check answers the new name.
- **Separate mode**: the backend pushes the network's addresses to the gateway with the rest of the
  address policy, immediately after a change and every half minute. A frontend node renders another
  site by fetching that site's data through the gateway; the gateway lets a node it has registered name
  the site (only one of the network's addresses). A node registered by a DNS name rather than an IP
  address is not recognised that way: register nodes by address.
- **TLS: one certificate per site.** The main site keeps its certificate (Security → Automatic Certificate Renewal). Every
  other site has a certificate of its own for its main address, which the gateway — and the monolith —
  selects by the name the browser asks for (SNI); a name with no certificate of its own gets the main
  site's. Admin → Network shows each site's certificate and offers two ways to get one:
  - **Get certificate**: Let's Encrypt over HTTP-01, with the install's ACME account (the email of
    Security → Automatic Certificate Renewal). The address must already point at this server. With ACME enabled and the
    `http-01` challenge, this happens on its own: when a site is created, and in the twice-daily renewal
    pass, which renews each site's certificate inside `acme.renewBeforeDays` (30) of its expiry and leaves
    an address whose last attempt failed alone for six hours.
  - **Install your own**: paste a certificate (with its chain) and its key. It must name the site's
    address, match the key and still be valid.

  The certificates are kept in the network store and handed to the gateway, which keeps them under
  `gateway/ssl/live/sites/<host>/` and picks a new or renewed one up within seconds, without a restart. A
  gateway that restarts without them, or a new one, gets them back from the backend. The challenge
  answers of HTTP-01 are kept in the network store too, so whichever backend node the edge sends the CA
  to answers it; the gateway's own port-80 listener (`acme.http01Port`) redirects a token it does not
  hold to HTTPS, where the backends answer it. You can also terminate TLS in a reverse proxy in front of
  WordJS instead.

## Changing a site's address

Admin → Network → **Change address** (your password confirms it) moves a site to another main address and sets its other
addresses: host names such as the `www.` twin, or the old domain kept while visitors move. Each name is checked as at
creation (a DNS name no other site and not the main site answers). The other names are answered with the main
address's scheme and port, for the same site; links, feeds and emails keep naming the main address. The site's own
`siteurl`/`home` follow the main address, the certificate kept for the old main address is removed (get one for the new
address with **Get certificate**), and the gateway hears the new addresses at once. The main site's address is changed in
Settings → Site address. On a site of the network, that screen points its administrators here.

## Suspending a site

Admin → Network → Suspend (your password confirms it). A suspended site answers `503` (code `rest_site_suspended`) to
every request, pages and API alike; its data is kept, and its plugin and theme workers stop. Resume brings it back
(its workers start again on its next request). The main site cannot be suspended.

## Plugins on the sites

Plugin **code** is the network's: it is uploaded, updated and deleted on the main site, once, and every
site sees the same installed plugins. What each site does with them is its own:

1. **The network offers a plugin.** In Admin → Network → *Plugins for the sites*, a network administrator
   ticks the permissions any site may grant the plugin (its **ceiling**) and clicks *Offer to the sites*
   (the password field above the list confirms it). Until it is offered, only the main site can use it, and
   the other sites list it as *Not offered by the network*.
2. **A site activates it.** The site's administrator opens Admin → Plugins on the site's own address,
   activates the plugin and grants it permissions, as on a single site — but never beyond the ceiling:
   the switches past it are disabled, and the API refuses such a grant with `403
   plugin_grant_beyond_ceiling`.
3. **Each site runs its own copy.** A plugin active on several sites runs one sandboxed worker per site.
   Its routes (`/api/v1/plugin/<slug>/…`), hooks, shortcodes, scheduled events, notification transports
   and mail provider answer only for the site they were started for, it reads and writes that site's
   database (its own tables included) and its private storage is that site's. On a site where it is not
   active, its routes answer `404` and its hooks do not run.

Lowering a ceiling takes effect at once on every site (a permission outside it stops counting even
though the site's stored grant still names it, and running workers are restarted). *Stop offering*
deactivates the plugin on every other site; their grants are kept for a later offer. Deleting a plugin
on the main site removes it from the whole network (on Windows, with the AppContainer profile of its
worker on every site).

A plugin that provides email does so per site: a site sends mail only through a mail plugin active and
granted `email:provider` **on that site**. Account email (password-reset and verification links) is per
site too: each site's **Settings → Account email** has its own built-in transport and its own list of
allowed provider plugins; a secondary site's relay must be a public server (a relay on this machine or a
private network is accepted only on the main site).

Each site's theme server code (`functions.js`) also runs per site, in its own worker.

### Idle sites stop their workers

A site's plugin and theme workers start on its first need — a request to the site, a due scheduled event
or content event — not when the backend starts, and they stop again once the site has been idle (no
request, scheduled event, content event or bus message for it) for `multisite.workerIdleMinutes`
(`wordjs-config.json`, default **15**; `0` keeps them running). So a network of many quiet sites does not
keep one process per site and plugin. The next request starts them again before it is answered: nothing
is lost, the first request after a pause just takes a moment longer (the time the workers take to start).
A request in progress keeps its site's workers up however long it lasts. The site's activations, grants,
egress allowlist and the network's ceiling are kept as they are; the new workers start under them.

The main site's workers, and those of a single-site install, never stop. On a network, a plugin that needs
to do something regularly on another site uses a scheduled event (which starts the site's workers when it
is due), not a timer of its own: a timer stops with its worker.

## Opening a site as administrator

A network administrator's account belongs to the main site; on another site it means nothing. To work
in another site's admin, use **Admin → Network → Open as administrator** on that site's row (type your
password in the box above the list first). The browser goes to the site's own address and lands in its
admin, under a violet banner that says who you are, which site you came from and when the session ends.

- **One link, once, for a minute.** The main site re-checks your password and hands the browser a link
  to `https://<site>/login/handoff`, carrying a token in the part of the address that is never sent to a
  server. The token is signed with that site's own key, names you and the site's address, works once and
  only within 60 seconds. Opening it on another site, on another address of the site or after it was
  used is refused.
- **A 30-minute session, marked as a handoff.** It cannot be extended by staying active, and it ends at
  once if you stop being a network administrator. *Leave* on the banner signs you out of that site.
- **Recorded on both sides.** The network's audit log (`GET /api/v1/network/audit`) records the link
  being issued (`site.handoff.issued`), redeemed (`site.handoff.redeemed`) and refused
  (`site.handoff.refused`, with the reason). The site's own audit log records `auth.network_handoff`
  with your login, the main site's address, the IP and the end of the session, so the site's
  administrators see every visit.
- **Not on the main site** (administer it directly), **not on a suspended site**, and **never for an API
  token or an agent**: only an interactive session can ask for the link.

**The account it uses.** Everything done in an admin is attributed to an account of that site (a post's
author, a revision, an upload, the actor of an audit row), and user ids repeat across a network, so your
first handoff into a site creates one account there for you, named `network.<your login>` and shown as
"<your login> (network administrator)" in the site's Users list. It is marked as a network administrator's
handoff account and used by every later handoff of yours into that site. It has no password anyone knows
and an address under the reserved `.invalid` domain, and it cannot be used any other way:

- it cannot sign in with a password (the sign-in answers as for a wrong password);
- the site's administrators cannot edit it or reset its second factor (`403 rest_network_handoff_account`),
  and can cut its sessions or delete it — your next handoff creates it again;
- a handoff session cannot create API tokens or AI agent connections, enrol a second factor or change its
  own profile (`403 rest_network_handoff_session`): nothing it creates outlives the 30 minutes;
- the site's two-factor policy does not apply to it (you signed in on the main site, under the main site's
  policy); its role is set back to administrator on every handoff.

## Deleting a site

Suspend the site first, then Admin → Network → Delete: type the site's slug to confirm (your password
confirms it too). Everything the site holds is removed for good: its database (its SQLite file, its
Postgres schema or its MySQL database), its uploads and private files (on disk and in the media bucket),
its backups, its plugin and theme workers with their private storage (and, on Windows, each worker's
AppContainer profile), the database principals of its plugins, its cached entries,
its certificate and its addresses. Every node of the network forgets it within seconds. The main site
cannot be deleted, and the id of a deleted site is never given to a new one.

## What the network manages on the main site

What is the network's — not a site's — is managed on the main site by its network administrators, and is
not offered on the other sites: installing, updating and deleting plugin and theme code (the code is
shared by every site), the main site's address and its certificate (each site's own certificate is on the
network screen), the hooks inspector, the database migration tool (it moves the whole network) and the
network screen itself.

On another site the API enforces this too. The site address, marketplace, the main site's certificate
screen, system health details and hooks routes answer `404 rest_no_route`, as if they did not exist. A
write that would change network-wide files answers `403 rest_network_only`: uploading, deleting, packing or downloading
plugin code, installing a plugin's bundled theme or freeing a port for it, generating the sample plugin,
creating, rebuilding, uploading, restoring or deleting theme files, and every write to the installer
(`/setup`). Activating, deactivating, granting, setting the egress allowlist of and reloading the offered
plugins stay the site's.

## Media storage quotas

A network administrator can cap how much media each site other than the main one stores: **Admin →
Network** shows every site's usage and takes a quota per site and a default for the sites without one
(in MB; empty means no limit). With neither set there is no limit, which is also how a single-site
install and the main site always behave. Usage is counted from each site's attachments — public and
private, the original and every stored derivative — so it is the same whether the files are on disk or
in the media bucket. An upload (or a WXR import download) that would go over the quota is refused with
`413 rest_upload_quota_exceeded` and leaves nothing behind.

Activating, deactivating and reloading a plugin, and changing its grants, egress hosts, private
destinations or port (each of which restarts its worker), share a rate limit per site and per account
(60 in 10 minutes; `429 rest_plugin_lifecycle_rate_limited` beyond it).

With S3 media storage, each site's objects live in its own space of the shared bucket
([media-storage.md](media-storage.md)), and moving the library to the bucket or back runs for every site.

## Backups

Every site has its own backups, in its own **Settings → Backups**:

- On the **main site**, as before, for its network administrators: the main site's database, its uploads
  and private files, and the network's plugin and theme code. On a network over Postgres, its dump holds
  the main site's schema only, never the other sites'.
- On **another site**, for that site's administrators: its database (a copy of its SQLite file, or a
  `pg_dump` of its schema / a `mysqldump` of its database, which need the client tools on the backend
  host as on a single site), its uploads and its private files — never plugin or theme code. The
  archives are kept with the site, in `<data dir>/sites/<id>/backups/`, and an S3 copy goes under
  `sites/<id>/` in the backup bucket. Its schedule and retention are the site's own settings.

Restoring a site's backup replaces that site's database whole (its schema or database is dropped and
restored from the archive) and writes its files back; the site's plugins are started again with fresh
database principals. No other site is touched.

## Real-time collaboration

Co-editing in the editor works on every site. Rooms, presence, the operations log (kept in the site's own
database) and the per-user limits are the site's: the post with id 5 on one site and the post with id 5
on another are two rooms that never exchange an operation, even across backend nodes (the bus messages
carry the site, signed). Each site's idle rooms are swept by its own hourly job.

## Where a site's data lives

| Engine | Site 1 | Site N | Network store |
|---|---|---|---|
| `sqlite-native` | `dbPath`, as before | `<data dir>/sites/<N>/wordjs-native.db` | `<data dir>/network.db` |
| `postgres` | the configured database's schema (`public`) | schema `wordjs_site_<N>` of the same database | schema `wordjs_network` |
| `mysql` / `mariadb` | database `db.name` | database `<db.name>_site_<N>` | database `<db.name>_network` |

Postgres connections of a site are pinned to its schema when they open (`search_path` is a startup
parameter of the site's own small pool), and MySQL connections to its database, so every query of the
site — the core's and its plugins' — resolves there and nowhere else. Each site's pool is small (4
connections; `multisite.sitePoolMax` changes it), and is opened when the site is first used.

A site's files are in **one directory**, `<data dir>/sites/<id>/` (the data dir is the directory of
`dbPath`, `backend/data` by default): its uploads, its private uploads, its backups and, on SQLite, its
database. On several nodes, keep the uploads in the media bucket ([media-storage.md](media-storage.md)) or
the data directory on shared storage, as for a single site.

## Several backend nodes

On Postgres and MySQL a network runs on as many backend nodes as a single site does
([multi-node.md](multi-node.md)): every node shares the database server (every site's schema or database,
and the network store) and Redis.

- **The registry.** Each node keeps the network store in memory and reads it again when another node
  announces a change on the bus (`wordjs:network-changed`), and every 15 seconds in case an announcement
  was lost. A site created on one node is answered by the others within moments; one suspended stops its
  plugin and theme workers on every node; one deleted is forgotten by every node.
- **Caches.** Every cache invalidation, option change and plugin change on the bus carries its site, and
  a node applies it to that site only. A node that never served a site has nothing of it to update.
- **Background work.** Each site has its own cron leader (a lease in the site's own database), so a
  site's scheduled events run on one node at a time; the content outbox claims its events per site.
- **Plugin and theme workers.** Each node runs the workers of the sites it serves, started when it first
  needs them and kept in step with the other nodes' activations, grants and reloads; each node stops its
  own when a site has been idle there ([Idle sites stop their workers](#idle-sites-stop-their-workers)).
- **Certificates.** Each site's certificate is in the network store; any node renews it (the main site's
  cron leader runs the renewal pass) and the challenge answers are shared ([TLS](#dns-the-gateway-and-tls)).

## Changing the database engine

Settings → Database migration (network administrators, on the main site) moves the **whole network**:
site 1, every other site into its own file / schema / database on the target, and the network store. The
copy is complete and checked table by table; if any site fails, nothing switches and the network keeps
running on the source. Moving a network onto `sqlite-legacy`, or onto the engine it already runs on, is
refused.

## REST API

The network screen is backed by `/api/v1/network` (`backend/src/routes/network.ts`). `GET /status` answers
any signed-in user; `/setup`, `/enable` and `/disable` are described in the table. Every other route is for network administrators, on the main site, with an
interactive session (an API token is refused with `403 rest_token_management_forbidden`). A caller who is
not a network administrator gets `403 rest_forbidden_network`. With multisite off, or on another site,
the route answers `404 rest_no_route`. Every write re-authenticates with `currentPassword` in the body: a
wrong one is `403 rest_bad_current_password`.

| Method | Endpoint | Body | Answer |
|---|---|---|---|
| `GET` | `/status` | — | `{ enabled, networkAdmin }` |
| `GET` | `/setup` | — | `{ enabled, ready, requirements: [{ id, ok, blocking, message, fix }], administrators, mfaEnrolled, driver, otherSites, restart: { mode, automatic, bootId } }`. While multisite is off: for the main site's administrators (`403 rest_forbidden` otherwise) |
| `POST` | `/enable` | `{ admins: [userId…], currentPassword, mfaCode }` | `{ enabled: true, admins, restart }`, then the backend restarts. Interactive session at the main address only. `403 network_mfa_enrollment_required` / `rest_mfa_step_up_required`, `400 rest_mfa_invalid`, `400 network_admins_required` / `network_admin_not_administrator`, `409 network_already_enabled` / `network_requirements_unmet` |
| `POST` | `/disable` | `{ currentPassword, mfaCode }` | `{ enabled: false, restart }`, then the backend restarts. `409 network_has_sites` while another site exists, `409 network_not_enabled` |
| `GET` | `/admins` | — | `{ administrators: [{ id, login, displayName, networkAdmin }] }` |
| `POST` | `/admins` | `{ userId, currentPassword }` | `{ administrators }`. `400 network_admin_not_administrator` |
| `DELETE` | `/admins/:id` | `{ currentPassword }` | `{ administrators }`. `409 network_last_admin`, `404 network_admin_not_found` |
| `GET` | `/sites` | — | `{ sites: [{ id, slug, url, host, status, main, createdAt, updatedAt }], localAddresses }`, the main site first; `localAddresses` is true when a new site may use a `*.localhost` address |
| `POST` | `/sites` | `{ slug, url, title, adminUsername, adminEmail, adminPassword, currentPassword }` | `201 { site }`. `400` for an invalid field (`network_invalid_url`, `network_invalid_slug`, `network_invalid_title`, `network_invalid_admin`, `network_weak_password`), `409 network_host_taken` / `network_slug_taken` |
| `PUT` | `/sites/:id/address` | `{ url, aliases?, currentPassword }` | `{ site }` with `aliases`. `400 network_invalid_url` / `network_invalid_alias`, `400 network_primary_site`, `404 network_site_not_found`, `409 network_host_taken` |
| `POST` | `/sites/:id/suspend` | `{ currentPassword }` | `{ site }`. `400 network_primary_site` for the main site, `404 network_site_not_found` |
| `POST` | `/sites/:id/resume` | `{ currentPassword }` | `{ site }` |
| `DELETE` | `/sites/:id` | `{ confirmSlug, currentPassword }` | `{ deleted: id }`. `409 network_site_active` unless suspended, `400 network_confirm_mismatch`, `400 network_primary_site` |
| `POST` | `/sites/:id/handoff` | `{ currentPassword }` | `{ url, expiresAt }`: the one-time link into the site's admin ([above](#opening-a-site-as-administrator)). `400 network_primary_site`, `409 network_site_suspended`, `404 network_site_not_found` |
| `GET` | `/certificates` | — | `{ autoIssue, certificates: [{ siteId, host, installed, notAfter, issuer, daysLeft }] }` — never a key |
| `POST` | `/sites/:id/certificate` | `{ currentPassword }` | `{ certificate }`: issued now with Let's Encrypt (HTTP-01). `409 network_acme_unconfigured` / `network_acme_busy`, `502 network_acme_failed` |
| `PUT` | `/sites/:id/certificate` | `{ certPem, keyPem, currentPassword }` | `{ certificate }`. `400 network_invalid_certificate` when the pair does not name the site's address, does not match or has expired |
| `GET` | `/audit` | — (`?limit=` 1–500, default 100) | `{ entries }`, newest first: sites created, suspended, resumed and deleted, certificates, network administrators, handoffs |
| `GET` | `/plugins` | — | `{ plugins: [{ slug, name, version, requestedPermissions, ceiling }] }`; `ceiling: null` means not offered |
| `PUT` | `/plugins/:slug/ceiling` | `{ tokens: ["scope:access" \| "network", …], currentPassword }` | `{ slug, ceiling }`. Offers the plugin to the sites up to that ceiling (replacing a previous one) and restarts its workers on the other sites. `400 network_invalid_ceiling` for a malformed token, `404 plugin_not_found` |
| `DELETE` | `/plugins/:slug/ceiling` | `{ currentPassword }` | `{ slug, withdrawn, deactivatedOn }`. Stops offering it and deactivates it on every other site |
| `GET` | `/quotas` | — | `{ defaultQuota, sites: [{ id, quota, effectiveQuota, used }] }` in bytes; `null` = none / no limit, `used: null` when a site's database cannot be read |
| `PUT` | `/quotas/default` | `{ bytes, currentPassword }` | `{ defaultQuota }`. The quota of every site without its own; `bytes: null` removes it. `400 network_invalid_quota` for anything but a whole number of bytes |
| `PUT` | `/sites/:id/quota` | `{ bytes, currentPassword }` | `{ id, quota, effectiveQuota }`. One site's own quota; `bytes: null` makes it follow the default again. `400 network_primary_site` for the main site |

The link from `POST /sites/:id/handoff` is redeemed on the target site by `POST /api/v1/auth/handoff`
with `{ token }` (the page at `/login/handoff` does it). It answers `{ user, handoff: { networkAdmin, from,
expiresAt } }` and sets the session cookie, or `401` with `network_handoff_invalid`, `network_handoff_expired`,
`network_handoff_used` (a replay) or `network_handoff_wrong_host`, `403 network_handoff_not_admin`, `503
rest_site_suspended`; on the main site or a single site it is `404`. On that site, `GET /api/v1/auth/me`
carries `handoff: { networkAdmin, from, expiresAt }` for as long as the session lasts.

## Turning it off

**Settings → Network → Turn the network off** (network administrators), with your password and a current
two-factor code. Allowed while the main site is the only site: delete the others in Admin → Network first.
WordJS writes the change, audits it (`network.disable`) and restarts by itself, on every node.

From a terminal instead: `npm run network -- disable`, then restart the backend.

## Upgrading from 2.7

Nothing changes for a single site, or for an existing network on `sqlite-native`: no migration, no new
setting. What is new:

- A network can run on Postgres or MySQL, and on several backend nodes there.
- The network is turned on and off from Settings → Network, which restarts the backend by itself
  (`npm run network` still works).
- Each site other than the main one gets its own certificate (Admin → Network); with ACME on and
  `http-01`, Let's Encrypt issues them on its own after the upgrade, at the next renewal pass.
- Each site has its own backups and real-time collaboration.
- A suspended site can be deleted.
- The network store gains two tables (`network_acme_challenges`, `network_site_certs`), created at boot.
- Moving a SQLite network onto Postgres or MySQL: Settings → Database migration on the main site moves
  every site and the network store (above). Make sure the target user may create schemas or databases.

## Troubleshooting

| What you see | Why |
|---|---|
| `421` on a new site's address | The backend was not restarted after `npm run network -- enable` (the panel restarts it itself), or the address is not the site's main address, or (separate mode) the gateway has not received the network's addresses yet: check the backend log for "could not tell the gateway". |
| Settings → Network does not let you turn it on | Its list says what is missing: the install is not finished, the driver is `sqlite-legacy` (use **Move to the current SQLite engine** there), the database user may not create schemas/databases (the screen shows the `GRANT` to run), the main address is not set, or your account has no two-factor authentication. The CLI refuses for the same reasons, or when a login given to `--admin` is not an administrator of the main site. |
| "Restart WordJS to apply it" after a switch | WordJS was not started by something that restarts it (see [Restarting by itself](#restarting-by-itself)). Restart it once the way you started it. |
| Creating a site fails with "could not be created" | The database user may not create the site's Postgres schema or MySQL database: grant `CREATE`, or create `wordjs_site_<id>` / `<db.name>_site_<id>` for it. |
| A site's certificate is not served | Admin → Network shows it as installed? Then check the gateway log for "Site certificate installed"; a name must reach the gateway with SNI (any modern browser sends it). "Get certificate" fails while the address does not point at this server, or port 80 does not reach it. |
| Another node does not answer a new site | Its Redis connection is down: it catches up within 15 seconds (the periodic re-read of the network store). |
| A site answers `503` | It is suspended (Admin → Network). |
| A site's admin cannot activate a plugin ("Not offered by the network") | A network administrator has not offered it to the sites (Admin → Network → Plugins for the sites). |
| `403 plugin_grant_beyond_ceiling` | The permission is outside the ceiling the network set for that plugin. |
| Another site's pages are "not found" while its API answers | The frontend's server-side reads reached the backend as another site (they are refused rather than shown). In separate mode, check that the frontend node is registered with the gateway by IP address. |
| Log: "the network store could not be opened" | `<data dir>/network.db` is unreadable, or (Postgres/MySQL) the `wordjs_network` schema / `<db.name>_network` database cannot be reached or created; only the main site is answered until it is fixed. |
