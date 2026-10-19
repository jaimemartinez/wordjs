# Tutorial 1 — Install WordJS on a Linux server

In this tutorial you install WordJS on a fresh Linux server, run it as a systemd service under its own
account, and finish the setup in the browser. At the end you have a working site with a sample home
page, an admin account and the visual editor.

**Time:** about 15 minutes (most of it is `npm` downloading dependencies).
**You need:** a Debian 12 or Ubuntu 22.04+ server with root access (a VM or a container is fine), at
least 2 GB of RAM, and a way to open port 3000 in a browser (directly, or through an SSH tunnel).

WordJS runs here in **monolith mode**: one Node.js process serves the public site, the admin and the
API on port 3000. That is what `npx create-wordjs` sets up, and it is the right starting point for a
single server. The other deploy modes are covered in [Tutorial 3](03-split-mode-on-one-server.md) and
[Tutorial 4](04-separate-mode-three-machines.md).

## 1. Install Node.js

WordJS needs Node.js 20.9 or newer; Node.js 22 is what it is built and tested on. On Debian/Ubuntu the
simplest source is NodeSource:

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
node -v   # v22.x
```

## 2. Download and install WordJS

`create-wordjs` downloads the latest pre-compiled release from GitHub (nothing is built on your
server), unpacks it and installs the runtime dependencies. With `--systemd` it also prepares a service
unit instead of starting the site in your terminal:

```bash
sudo npx -y create-wordjs@latest /srv/wordjs --systemd --port 3000 --yes
```

When it finishes it prints the exact commands for the next step, including the path of the unit it
prepared (a directory under `/tmp`). Keep that output open.

> **Why a separate account?** The service runs as a dedicated `wordjs` user with no Linux
> capabilities. The unit file is staged outside the site directory on purpose: the service account
> owns the site, and must not be able to edit what root installs.

## 3. Create the service account and start the service

Run the commands the installer printed. They look like this — use the `/tmp/wordjs-systemd-…`
directory from **your** output:

```bash
sudo useradd --system --home-dir /srv/wordjs --shell /usr/sbin/nologin wordjs
sudo chown -R wordjs: /srv/wordjs
sudo install -o root -g root -m 0644 /tmp/wordjs-systemd-XXXXXX/wordjs.service /etc/systemd/system/wordjs.service
sudo systemctl daemon-reload && sudo systemctl enable --now wordjs
sudo rm -r /tmp/wordjs-systemd-XXXXXX
```

Check that it is running:

```bash
systemctl is-active wordjs          # active
sudo journalctl -u wordjs -n 20     # look for "WordJS MONOLITH (prod)"
curl -k -o /dev/null -w '%{http_code}\n' https://localhost:3000/   # 200
```

By default WordJS serves **HTTPS with a self-signed certificate** on port 3000, so `curl` needs `-k`
and your browser will show a certificate warning the first time. To put a real certificate in front of
it, follow [Tutorial 2](02-nginx-and-https.md).

## 4. Get the install token

Until the site is installed, anyone who reaches the setup page could claim it. WordJS prevents that
with a **one-time install token**. A service does not print it to the log (logs are often shipped
elsewhere); it writes it to a file only root and the service account can read:

```bash
sudo cat /srv/wordjs/backend/data/install-token
```

> **The token changes on every restart** until the site is installed. If you restart the service
> before finishing the setup, read the file again.

## 5. Finish the setup in the browser

Open `https://<your-server>:3000/install#token=<the token>` (accept the certificate warning). If the
server is not reachable directly, tunnel the port first and use `localhost`:

```bash
ssh -N -L 3000:localhost:3000 you@your-server
# then open https://localhost:3000/install#token=<the token>
```

The token is pre-filled from the link. The wizard has three steps:

1. **Site** — the site title and tagline, the token, *Start with example content* (leave it on for a
   designed home page, a sample post, an About page and a menu) and the **Site address**. The site
   address is the main address every link, feed and email is built from: set it to the address you
   will really use (for example `https://www.example.com`), not `localhost`. You can add more
   addresses later in **Settings → Site address**.
2. **Database** — keep **SQLite (recommended)** for a single server. PostgreSQL and MySQL/MariaDB are
   for larger or multi-node installs and need a running database server.
3. **Admin** — your administrator username, email and password.

Click **Install WordJS**. The wizard confirms the install and warns you about one thing: **password
recovery is off** until the site can send account email. Open **Admin → Settings → Account email** and
enter an SMTP mail server (your provider's relay, for example `smtp.example.com`, port 587, STARTTLS),
then send yourself a test. Password-reset and verification links are sent that way, by WordJS itself —
never handed to a plugin unless you allow one there (see [Tutorial 16](16-send-email-from-your-site.md)).
Keep your admin password safe until then.

Click **Continue to Dashboard**. You are in the admin. Open the site's address in another tab to see
the sample home page.

## 6. Where things are

| What | Where |
|---|---|
| The site | `/srv/wordjs` (owned by `wordjs`) |
| Configuration | `/srv/wordjs/backend/wordjs-config.json` |
| SQLite database | `/srv/wordjs/backend/data/` |
| Uploads | `/srv/wordjs/backend/uploads/` |
| Logs | `journalctl -u wordjs` (JSON lines; see [observability.md](../observability.md)) |
| Restart | `sudo systemctl restart wordjs` |

## Next steps

- Put the site behind nginx with a real HTTPS certificate: [Tutorial 2](02-nginx-and-https.md).
- Build a page with the visual editor: [Tutorial 5](05-your-first-page-with-verso.md).
- Keep it up to date and backed up: [Tutorial 15](15-backups-restore-and-upgrades.md).

---
*Tested on 2026-10-17 with WordJS 2.6.0 (`create-wordjs@2.6.0`) on a fresh Debian 12 container
with Node.js 22.23, following these exact steps; HTTPS on port 3000 answered 200. The wizard itself was
completed in a browser through an SSH tunnel, with the service switched to plain HTTP for that step
(the test browser cannot accept a self-signed certificate); the wizard is the same over HTTPS.*
