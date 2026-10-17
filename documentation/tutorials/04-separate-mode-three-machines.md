# Tutorial 4 — Separate mode: three machines

**Separate mode** is split mode spread over three machines: one runs the **gateway** (the public entry
point and the cluster's certificate authority), one the **backend**, one the **frontend**. They trust
each other through **mutual TLS**, and you never copy a certificate by hand: the gateway mints
single-use **join tokens**, and each machine enrolls with one command.

**Time:** about 40 minutes (three downloads).
**You need:** three Debian 12 / Ubuntu 22.04+ machines with root access and Node.js 22
([Tutorial 1, step 1](01-install-on-a-linux-server.md#1-install-nodejs)), 2 GB of RAM each, `openssl`
on the backend and frontend machines, and these addresses (replace them with yours):

| Machine | Address | Ports others must reach |
|---|---|---|
| gateway | `10.0.0.10` | 3000 (public), 3100 (mTLS register), 3101 (enroll) |
| backend | `10.0.0.11` | 4000 (from the gateway) |
| frontend | `10.0.0.12` | 3001 (from the gateway) |

Ports 3100, 3101, 4000 and 3001 belong on a private network or VPN, never on the public internet.
The full reference is [separate-mode.md](../separate-mode.md).

## 1. Gateway: create the cluster

On the gateway machine:

```bash
sudo mkdir -p /srv && cd /srv
sudo npx -y create-wordjs@latest gateway --host 10.0.0.10 --no-start --yes
```

It downloads the release into `/srv/wordjs-gateway`, creates the cluster CA (its private key stays on
this machine, mode `0600`), issues the gateway's own certificates, and prints two **ready-to-paste**
commands, one for each other machine. They look like this:

```text
npx create-wordjs@latest join backend --gateway 10.0.0.10 --token wjc.backend.… \
     --ca-hash 15bf6f61…a05b --advertise <this-backend-ip>
```

Keep them. These tokens are single-use and expire after two hours. Once the gateway runs as the
`wordjs` account (below), mint new ones with
`cd /srv/wordjs-gateway && sudo -u wordjs node scripts/cluster.js token backend` (or `frontend`); those
are valid for 60 minutes.

Run the gateway as a service. Enrollment needs it running:

```bash
sudo useradd --system --home-dir /srv/wordjs-gateway --shell /usr/sbin/nologin wordjs
sudo chown -R wordjs: /srv/wordjs-gateway
sudo tee /etc/systemd/system/wordjs-gateway.service >/dev/null <<'EOF'
[Unit]
Description=WordJS gateway (separate mode)
After=network-online.target
Wants=network-online.target

[Service]
User=wordjs
WorkingDirectory=/srv/wordjs-gateway/gateway
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
NoNewPrivileges=yes
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now wordjs-gateway
ss -ltn | grep -E ':(3000|3100|3101) '   # the three listeners
```

## 2. Backend: join the cluster

On the backend machine, paste the backend command, fill in `--advertise` with **this** machine's
address, and add `--no-start`:

```bash
sudo mkdir -p /srv && cd /srv
sudo npx -y create-wordjs@latest join backend --gateway 10.0.0.10 --token wjc.backend.… \
     --ca-hash <fingerprint> --advertise 10.0.0.11 --no-start --yes
```

Before it sends the token, `join` checks that the gateway presents the cluster CA matching
`--ca-hash`. A wrong fingerprint (or anything intercepting the connection) stops it there. It then
writes `backend/certs/` and `backend/wordjs-config.json`.

```bash
sudo useradd --system --home-dir /srv/wordjs-backend --shell /usr/sbin/nologin wordjs
sudo chown -R wordjs: /srv/wordjs-backend
sudo tee /etc/systemd/system/wordjs-backend.service >/dev/null <<'EOF'
[Unit]
Description=WordJS backend (separate mode)
After=network-online.target
Wants=network-online.target

[Service]
User=wordjs
WorkingDirectory=/srv/wordjs-backend/backend
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=on-failure
NoNewPrivileges=yes
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now wordjs-backend
sudo journalctl -u wordjs-backend | grep -i registered   # "backend Registered with Gateway via HTTPS (mTLS)"
```

## 3. Frontend: join the cluster

Same on the frontend machine, with the frontend command:

```bash
sudo mkdir -p /srv && cd /srv
sudo npx -y create-wordjs@latest join frontend --gateway 10.0.0.10 --token wjc.frontend.… \
     --ca-hash <fingerprint> --advertise 10.0.0.12 --no-start --yes

sudo useradd --system --home-dir /srv/wordjs-frontend --shell /usr/sbin/nologin wordjs
sudo chown -R wordjs: /srv/wordjs-frontend
sudo tee /etc/systemd/system/wordjs-frontend.service >/dev/null <<'EOF'
[Unit]
Description=WordJS frontend (separate mode)
After=network-online.target
Wants=network-online.target

[Service]
User=wordjs
WorkingDirectory=/srv/wordjs-frontend/frontend
Environment=NODE_ENV=production
ExecStart=/usr/bin/node scripts/start-frontend.js prod
Restart=on-failure
NoNewPrivileges=yes
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now wordjs-frontend
sudo journalctl -u wordjs-frontend | grep -E 'Trusting|Ready'   # trusts the cluster CA, "Ready … (mTLS)"
```

## 4. Install the site through the gateway

The install token lives on the **backend** machine:

```bash
sudo cat /srv/wordjs-backend/backend/data/install-token
```

Open `https://10.0.0.10:3000/install#token=<the token>` and complete the wizard as in
[Tutorial 1, step 5](01-install-on-a-linux-server.md#5-finish-the-setup-in-the-browser). The gateway's
public certificate is issued by the cluster CA, so the browser warns until you put a public
certificate in front of it (step 6). Set the **Site address** to the address visitors will use.

## 5. Check it

From any machine that can reach the gateway:

```bash
curl -k -o /dev/null -w '%{http_code}\n' https://10.0.0.10:3000/          # 200
curl -k -o /dev/null -w '%{http_code}\n' https://10.0.0.10:3000/about     # 200: rendered on the frontend machine
curl -k -o /dev/null -w '%{http_code}\n' https://10.0.0.10:3000/api/v1/health   # 200: answered by the backend machine
```

Restart all three services, in any order, and check again: each node keeps its identity and
re-registers with the gateway by itself.

## 6. Production touches

- **Public certificate:** put nginx with Let's Encrypt in front of the gateway as in
  [Tutorial 2](02-nginx-and-https.md) (forwarding to `https://127.0.0.1:3000` and
  `proxy_ssl_verify off`, or set `"ssl": false` in the gateway's `gateway-config.json` to forward to plain
  HTTP), or issue a certificate from **Admin → Security → SSL Certificate Manager**.
- **Firewall:** allow 3100/3101 only from the backend and frontend machines, 4000 and 3001 only from
  the gateway, and 3000 (or 443) from the world.
- **More replicas:** a second backend or frontend joins the same way with a fresh token. Several
  backends need PostgreSQL or MySQL instead of SQLite; see [multi-node.md](../multi-node.md).

---
*Tested on 2026-10-17 with WordJS 2.6.0 (`create-wordjs@2.6.0`) on three fresh Debian 12 containers
(Node.js 22.23) at 192.168.182.52/.53/.54, following these exact steps, with the pinned CA check passing
on both joins. The install (step 4) was done through the setup API with the token, the same request
the wizard sends. Checked from a fourth machine through the gateway: home, an About page, a post, a
category archive, sign-in, the admin, sitemap, feed and `/public` CSS at 200, and again after
restarting all three services. Step 6 is guidance and was not part of the test.*
