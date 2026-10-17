# Tutorial 12 — Run several sites from one install

One WordJS install can serve a **network** of sites, each with its own address, content, users,
uploads, settings and theme choice. In this tutorial you turn an existing site into a network and add
a second site, `shop.example.com`, with its own administrator. Then you check that the two sites
share nothing.

**Time:** about 15 minutes.
**You need:**

- a WordJS site installed with the **`sqlite-native`** database, the default. Networks on Postgres and
  MySQL are not available yet;
- shell access to the server;
- a second domain name pointing at the same server.

This tutorial assumes the install from [Tutorial 1](01-install-on-a-linux-server.md): the code in
`/srv/wordjs`, run by the `wordjs` user as the `wordjs` service.

## 1. Point the new name at the server

Create a DNS record for `shop.example.com` with the same address as your main site, as you did for
the main domain. If nginx is in front ([Tutorial 2](02-nginx-and-https.md)), add the new name to
`server_name` and to the certificate.

To try this without DNS, use a wildcard DNS service: `shop.192-168-1-20.sslip.io` resolves to
`192.168.1.20`.

## 2. Turn the network on

On the server, run the command **as the `wordjs` user**. It writes the network database and the
config file, and the service must still be able to write them afterwards. Run as root, it refuses
and prints the command to use instead:

```bash
cd /srv/wordjs && sudo -u wordjs npm run network -- enable --admin admin
```

```
Multisite is on. Site 1 is https://www.example.com; network administrators: admin.
Restart the backend, then create sites from Admin → Network.
```

`--admin` names the main site's administrators (comma-separated logins) who will manage the network.
Your existing site becomes **site 1, the main site**, and nothing about it changes. Restart:

```bash
sudo systemctl restart wordjs
```

```bash
sudo -u wordjs npm run network -- status
```

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
- Backups, database migration and network management stay on the main site.
  [multisite.md](../multisite.md) covers the limits of this version, the REST API and how to turn the
  network off.

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
