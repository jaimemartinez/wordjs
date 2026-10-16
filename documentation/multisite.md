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
- [Suspending a site](#suspending-a-site)
- [What stays on the main site in this version](#what-stays-on-the-main-site-in-this-version)
- [Where a site's data lives](#where-a-sites-data-lives)
- [Turning it off](#turning-it-off)
- [Troubleshooting](#troubleshooting)

## What a network is

| | Main site (site 1) | Every other site |
|---|---|---|
| Address | `siteUrl` and its aliases ([Site address](site-address.md)) | One main address, set when the site is created |
| Database | `dbPath`, as before | `<data dir>/sites/<id>/wordjs-native.db` |
| Uploads | `uploads/` and `data/private-uploads/`, as before | `<data dir>/sites/<id>/uploads/` and `…/private-uploads/` |
| Users, roles, sessions | Its own | Its own. User ids repeat across sites; a session or API token of one site is refused on every other |
| Plugins | Installed and run here | Not active (see below) |
| Themes | Installed, edited and run here | Chosen and customised per site; the theme files are shared |

A request is assigned to a site by the address it was sent to. An address no site declares is answered
`421 Misdirected Request`, exactly as on a single site. Loopback addresses and IP literals always mean
the main site.

**Network administrators** are administrators of the main site that are listed as such. They see
**Admin → Network**, where sites are created, suspended and resumed. A site's own administrators manage
that site only and never learn that other sites exist.

## Requirements

- The `sqlite-native` database driver. Postgres and MySQL networks are planned; `npm run network --
  enable` refuses other drivers today.
- One backend host. In split and separate mode the gateway is told the network's addresses by the
  backend, as it is told the main site's.
- An installed site (the install wizard finished).

## Turning it on

On the backend's machine, from the installation:

```bash
npm run network -- enable --admin admin
```

`--admin` names one or more administrators of the main site (comma-separated logins) who become network
administrators. The command records the main site as site 1, creates the network store
(`<data dir>/network.db`) and sets `multisite.enabled` in `wordjs-config.json`. **Restart the backend**
(the monolith, or the backend process in split and separate mode): it reads the setting at start.

Then sign in on the main site as one of those administrators; **Network** appears in the admin menu.

```bash
npm run network -- status
npm run network -- admins add <login>
npm run network -- admins remove <login>
```

## Creating a site

Admin → Network → New site:

- **Site address** — `http(s)://host[:port]`, no path. A domain or subdomain (not an IP address, not
  `localhost`) that no site of the network answers yet.
- **Slug** — a short name for the site (lower-case letters, digits and dashes).
- **Site title**, and the **first administrator**'s username, email and password.
- **Your current password** — creating a site publishes a new address, so it re-authenticates you.

The site is provisioned all at once — its record and address, database, upload directories, default
options, a default category and its first administrator — or not at all. Its administrator then signs
in at `<site address>/login`. Within a few seconds the gateway answers the new address too.

## DNS, the gateway and TLS

Point the new name at the server the main site runs on, exactly as you did for the main address.

- **Monolith and split mode**: nothing else; the backend's address check answers the new name.
- **Separate mode**: the backend pushes the network's addresses to the gateway with the rest of the
  address policy, immediately after a change and every half minute. A frontend node renders another
  site by fetching that site's data through the gateway; the gateway lets a node it has registered name
  the site (only one of the network's addresses). A node registered by a DNS name rather than an IP
  address is not recognised that way: register nodes by address.
- **TLS**: in this version a site's address is covered by the install's one certificate. With ACME, add
  the new names to `acme.domains` (one certificate, up to 100 names), or terminate TLS in a reverse proxy
  in front of WordJS. A certificate per site (SNI) is planned.

## Suspending a site

Admin → Network → Suspend (your password confirms it). A suspended site answers `503` to every request,
pages and API alike; its data is kept. Resume brings it back. The main site cannot be suspended.

## What stays on the main site in this version

Plugins run on the main site only. On the other sites, plugin pages, routes, assets, hooks and shortcodes
do not exist, the Plugins screen is not offered, and a plugin that provides email does not send mail for
them (password recovery there fails closed, as on any site without a mail provider). The same holds for a
theme's server code (`functions.js`).

These screens are the main site's too, and are not offered elsewhere: Plugins, backups, the site
address, certificates, the hooks inspector, the database migration tool, and the network screen.
Real-time collaboration in the editor is available on the main site only.

## Where a site's data lives

Everything a site other than the main one owns is in **one directory**, `<data dir>/sites/<id>/` (the data
dir is the directory of `dbPath`, `backend/data` by default): its database (with its WAL files), its
public uploads and its private uploads. Back it up, move it or remove it as one folder, with the backend
stopped. The network's own records (sites, addresses, network administrators and their audit log) are
in `<data dir>/network.db`.

The main site's backups (Settings → Backups) cover the main site only.

## Turning it off

```bash
npm run network -- disable
```

Allowed while the main site is the only site. Restart the backend afterwards.

## Troubleshooting

| What you see | Why |
|---|---|
| `421` on a new site's address | The backend was not restarted after `enable`, or the address is not the site's main address, or (separate mode) the gateway has not received the network's addresses yet: check the backend log for "could not tell the gateway". |
| `npm run network -- enable` refuses | The install is not finished, the driver is not `sqlite-native`, or a login given to `--admin` is not an administrator of the main site. |
| A site answers `503` | It is suspended (Admin → Network). |
| Another site's pages are "not found" while its API answers | The frontend's server-side reads reached the backend as another site (they are refused rather than shown). In separate mode, check that the frontend node is registered with the gateway by IP address. |
| A site's admin has no Plugins screen | Plugins are the main site's in this version (see above). |
| Log: "the network store could not be opened" | `<data dir>/network.db` is unreadable; only the main site is answered until it is fixed. |
