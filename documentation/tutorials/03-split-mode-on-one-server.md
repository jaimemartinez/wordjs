# Tutorial 3 — Run WordJS in split mode on one server

The monolith from [Tutorial 1](01-install-on-a-linux-server.md) runs everything in one process. In
**split mode** the same release runs as three services: the **gateway** (the public port, routing,
health checks), the **backend** (API, plugins, database) and the **frontend** (the public site and the
admin). You can restart, monitor and size each one on its own, and it is the step before spreading them
over several machines ([Tutorial 4](04-separate-mode-three-machines.md)).

In this tutorial you install split mode on a fresh server, run each service under systemd as an
unprivileged account, and put nginx with HTTPS in front, as in [Tutorial 2](02-nginx-and-https.md).

**Time:** about 30 minutes.
**You need:** a fresh Debian 12 / Ubuntu 22.04+ server with root access, 2 GB of RAM or more, Node.js 22
([Tutorial 1, step 1](01-install-on-a-linux-server.md#1-install-nodejs)), and a domain pointing at the
server. This tutorial uses `www.example.com`.

| Service | Port | Listens on |
|---|---|---|
| gateway | 3000 (public entry, behind nginx here) | all interfaces |
| frontend | 3001 | loopback (the gateway is on the same machine) |
| backend | 4000 | loopback |
| gateway internal (mTLS) | 3100 | loopback |

## 1. Download WordJS without starting it

```bash
sudo npx -y create-wordjs@latest /srv/wordjs --no-start --yes
sudo useradd --system --home-dir /srv/wordjs --shell /usr/sbin/nologin wordjs
```

## 2. Let nginx do TLS

`create-wordjs` prepares the gateway to serve HTTPS with a self-signed certificate. Behind nginx the
gateway should speak plain HTTP on its local port instead, and trust nginx to tell it each visitor's
address. Set both **before the first start**:

```bash
echo '{ "ssl": false, "trustProxy": "loopback" }' | sudo tee /srv/wordjs/gateway/gateway-config.json
sudo chown -R wordjs: /srv/wordjs
```

The installer adds the gateway's secret, ports and certificate paths to this file later, and keeps
these two settings. `trustProxy: "loopback"` makes the gateway's rate limit count real visitors instead
of counting every request as coming from nginx's `127.0.0.1`.

## 3. One systemd unit per service

```bash
sudo tee /etc/systemd/system/wordjs-backend.service >/dev/null <<'EOF'
[Unit]
Description=WordJS backend (API, plugins)
After=network-online.target
Wants=network-online.target

[Service]
User=wordjs
WorkingDirectory=/srv/wordjs/backend
Environment=NODE_ENV=production
# Visitors reach the backend through nginx and the gateway, both on loopback: trust both hops so
# rate limiting, account lockout and the audit log see the visitor's real address.
Environment=WORDJS_TRUST_PROXY=loopback
ExecStart=/usr/bin/node server.js
Restart=on-failure
NoNewPrivileges=yes
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/wordjs-frontend.service >/dev/null <<'EOF'
[Unit]
Description=WordJS frontend (public site and admin)
After=wordjs-backend.service

[Service]
User=wordjs
WorkingDirectory=/srv/wordjs/frontend
Environment=NODE_ENV=production
ExecStart=/usr/bin/node scripts/start-frontend.js prod
Restart=on-failure
NoNewPrivileges=yes
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/wordjs-gateway.service >/dev/null <<'EOF'
[Unit]
Description=WordJS gateway (public port, routing)
After=wordjs-backend.service wordjs-frontend.service

[Service]
User=wordjs
WorkingDirectory=/srv/wordjs/gateway
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
NoNewPrivileges=yes
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/wordjs.target >/dev/null <<'EOF'
[Unit]
Description=WordJS (split mode: gateway + backend + frontend)
Wants=wordjs-backend.service wordjs-frontend.service wordjs-gateway.service

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now wordjs-backend wordjs-frontend wordjs-gateway wordjs.target
```

Check them:

```bash
systemctl is-active wordjs-backend wordjs-frontend wordjs-gateway   # active ×3
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/install  # 200
```

The gateway log shows the other two registering:
`sudo journalctl -u wordjs-gateway | grep registered`.

## 4. nginx and the certificate

Follow [Tutorial 2, steps 3 and 4](02-nginx-and-https.md#3-install-nginx-and-get-a-certificate)
unchanged: nginx forwards to `http://127.0.0.1:3000`, which is now the gateway instead of the monolith.

## 5. Install the site

Read the install token and open the wizard through nginx:

```bash
sudo cat /srv/wordjs/backend/data/install-token
# then open https://www.example.com/install#token=<the token>
```

In the wizard, set the **Site address** to `https://www.example.com`, keep **SQLite**, and create your
administrator, as in [Tutorial 1, step 5](01-install-on-a-linux-server.md#5-finish-the-setup-in-the-browser).
During the install WordJS issues the cluster certificates, so from then on the gateway, backend and
frontend talk to each other over mutual TLS. The frontend renders pages through the gateway next to it,
over loopback, so the site serves its content as soon as the install finishes. There is nothing to
point at the gateway by hand.

## 6. Close the service ports

Only nginx should reach the gateway from outside. The frontend and the backend already listen on
loopback only.

```bash
sudo apt-get install -y nftables
sudo tee /etc/nftables.conf >/dev/null <<'EOF'
#!/usr/sbin/nft -f
flush ruleset
table inet filter {
  chain input {
    type filter hook input priority 0; policy accept;
    iif "lo" accept
    tcp dport 3000 drop
  }
}
EOF
sudo systemctl enable --now nftables && sudo systemctl restart nftables
```

## 7. Check it

```bash
curl -I https://www.example.com/                      # 200
curl -I https://www.example.com/about                 # 200 (a content page, rendered by the frontend)
curl -m 5 http://www.example.com:3000/                # times out
sudo systemctl restart wordjs-backend wordjs-frontend wordjs-gateway && sleep 30
curl -I https://www.example.com/about                 # still 200 after a restart
```

Sign in at `https://www.example.com/login`: the session cookie is marked `Secure`, and **Admin → Audit
log** records your real IP address for sign-ins.

## Good to know

- **Rate limits and real addresses:** the gateway's own limit (`rateLimit` in `gateway-config.json`,
  1000 requests per minute by default) and the backend's limits, account lockout and audit log all see
  the visitor's address, thanks to `trustProxy` (gateway) and `WORDJS_TRUST_PROXY` (backend). Without
  them every visitor looks like `127.0.0.1`. The gateway logs a warning when it receives
  `X-Forwarded-For` from a local proxy it does not trust.
- **Switching back to the monolith** needs no migration. Stop the three services and run the monolith
  unit from Tutorial 1 instead: both modes share the configuration, database and uploads.
- **Logs:** `journalctl -u wordjs-gateway`, `-u wordjs-backend`, `-u wordjs-frontend`.

---
*Tested on 2026-10-17 with a WordJS 2.7.0 release build on a fresh Debian 12 container (Node.js 22.23,
nginx 1.22.1), with the domain `split.wordjs.test`. The lab has no public DNS, so the certificate came
from a private test CA instead of Let's Encrypt. The install (step 5) was done through the setup API
with the token, the same request the wizard sends.

Checked through nginx:

- **Right after the install, with no further step:** home, an About page, a post and a category
  archive at 200.
- **After restarting all three services:** the same pages at 200 again, with the gateway still on
  `ssl: false`, and the frontend listening on `127.0.0.1:3001` only.
- **Sign-in and writes:** sign-in with a `Secure` cookie, a cookie-authenticated write, and the refusal
  of a cross-site `Origin`.
- **Streams:** the notifications and collaboration SSE streams.
- **Real addresses:** a failed sign-in from another machine was recorded with that machine's address.*
