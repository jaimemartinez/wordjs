# Tutorial 12 — Run several sites from one install

One WordJS install can serve a **network** of sites, each with its own address, content, users,
uploads, settings and theme choice. In this tutorial you turn an existing site into a network and add
a second site, `shop.example.com`, with its own administrator. Then you check that the two sites
share nothing.

**Time:** about 15 minutes.
**You need:**

- a WordJS site you administer. Settings → Network checks the rest for you: the database engine (an
  older `sqlite-legacy` install is moved to `sqlite-native` there, with one click), the database user's
  rights on Postgres and MySQL, and the main address;
- a second domain name pointing at the same server — or nothing at all to try it on your own computer
  (step 1).

No terminal is needed.

This tutorial assumes the install from [Tutorial 1](01-install-on-a-linux-server.md): the code in
`/srv/wordjs`, run by the `wordjs` user as the `wordjs` service.

## 1. Point the new name at the server

Create a DNS record for `shop.example.com` with the same address as your main site, as you did for
the main domain. If nginx is in front ([Tutorial 2](02-nginx-and-https.md)), add the new name to
`server_name` and to the certificate.

To try this without DNS, use a wildcard DNS service: `shop.192-168-1-20.sslip.io` resolves to
`192.168.1.20`.

**Trying it on your own computer** (the main site is `http://localhost:3000`)? Skip this step: use
`http://shop.localhost:3000` as the address in step 3. Every browser opens `*.localhost` names on the
computer itself, without DNS.

## 2. Turn the network on

Sign in to the main site as an administrator and open **Settings → Network**.

1. **What the network needs** shows a tick next to each requirement. If one is missing, the line says
   what to do; on an older `sqlite-legacy` install, click **Move to the current SQLite engine**: WordJS
   makes a backup, moves the database (a progress bar shows it) and restarts by itself.
2. Under **Network administrators**, keep yourself ticked (and tick anyone else who should run the
   network).
3. Enter your password (and the code from your authenticator app, if your account has two-factor
   authentication), and click **Turn the network on**.

WordJS restarts itself (a few seconds) and opens **Admin → Network**. Your existing site is now **site 1,
the main site**; nothing about it changed.

> From a terminal instead: `cd /srv/wordjs && sudo -u wordjs npm run network -- enable --admin admin`,
> then `sudo systemctl restart wordjs`.

## 3. Create the second site

Sign in to the main site as a network administrator. **Admin → Network** now appears. Under
**New site**:

| Field | Value |
|---|---|
| **Site address** | `https://shop.example.com` (scheme, host and optional port, no path) |
| **Slug** | `shop` |
| **Site title** | `Corner Roasters Shop` |
| **First administrator** username, email, password | the new site's own administrator |
| **Your current password** | yours, to confirm |

Click **Create site**. In one step, WordJS creates the site's database, upload folders, default
settings, a default category and its administrator. The site appears under **Sites** as **Active**.

## 4. Use it

Open `https://shop.example.com`. It is a fresh site with the title *Corner Roasters Shop* and no
posts. Sign in at `https://shop.example.com/login` as the administrator you just created, and write
and publish a post as on any site.

## 5. Check that the sites are separate

- The main site's posts don't appear on the shop, and the shop's post doesn't appear on the main
  site.
- The main site's administrator **can't** sign in to the shop: *invalid credentials*. Each site has
  its own users.
- A session from one site is refused on the other (`401`). This holds for API tokens too.
- An address that no site declares, such as `other.example.com` pointed at the same server, gets
  `421 Misdirected Request`.

Uploads, menus, roles and settings are separate in the same way. Each site's files live in
`backend/data/sites/<id>/`.

## 6. Plugins and themes on the sites

Plugins and themes are installed once, on the main site, for the whole network.

- **Plugins:** under **Admin → Network → Plugins for the sites**, click **Offer to the sites** on a
  plugin and choose the most a site may grant it. Each site's administrator then activates it on
  their own site.
- **Themes:** each site picks and customizes its own theme from the installed ones.

## Good to know

- **Suspend** on a site takes it offline without deleting anything. **Resume** brings it back.
- In split and separate mode, the backend tells the gateway about the network's addresses by itself.
  In every mode, only DNS (and your proxy's `server_name`) needs the new name.
- Each site has its own **certificate** (Admin → Network → Get certificate, or install your own), its
  own **backups** (its Settings → Backups) and **real-time co-editing** in its editor.
- Installing plugin and theme code, the database migration tool and network management are the
  network's, on the main site. [multisite.md](../multisite.md) covers deleting a site, several backend
  nodes and the REST API.
- **Turning the network off**: delete the other sites, then **Settings → Network → Turn the network off**.

---
*Tested on 2026-10-17 with WordJS 2.6.0 on a fresh monolith install (Debian 12, `sqlite-native`),
using `shop.<ip>.sslip.io` names instead of DNS records:

- `network enable` and the restart;
- **Admin → Network → Create site**, in a browser;
- the new site's home page.

Then, over HTTP:

- the shop's administrator signed in and published a post, shown on the shop and absent from the main
  site;
- the main site's administrator got `401 rest_invalid_credentials` on the shop;
- a shop session got `401` on the main site;
- an undeclared host name got `421`.

On the 2.6.0 run, `network enable` run as root left the network database owned by root, and site
creation then failed with a server error. Hence the `sudo -u wordjs` in step 2. On a 2.7.0 release
build, the command refuses to run as root in an install another account owns, and prints the
`sudo -u wordjs …` command to use instead.*
