# Tutorial 2 — Put WordJS behind nginx with HTTPS

[Tutorial 1](01-install-on-a-linux-server.md) left WordJS answering HTTPS on port 3000 with a
self-signed certificate. For a public site you want a real certificate on the standard ports 80 and
443. In this tutorial nginx terminates TLS and forwards to WordJS, which serves plain HTTP on the
loopback side; port 3000 is closed to the outside.

**Time:** about 20 minutes.
**You need:** the site from Tutorial 1, a domain name whose DNS `A`/`AAAA` record points at the
server (this tutorial uses `www.example.com`; replace it everywhere), and ports 80 and 443 open.

> WordJS can also get Let's Encrypt certificates by itself (**Admin → Security → SSL Certificate
> Manager**, see [deployment.md](../deployment.md)). Use nginx when you want a proxy you already know,
> or when other sites share the server.

## 1. Tell WordJS it sits behind a proxy

Two settings change, both through a systemd drop-in so the generated unit stays untouched:

- `WORDJS_HTTP=1` — serve plain HTTP; nginx does TLS.
- `WORDJS_TRUST_PROXY=loopback` — believe the `X-Forwarded-*` headers only from nginx on the same
  machine. Without it every visitor looks like `127.0.0.1` to rate limiting and account lockout, and
  WordJS cannot tell that the browser used HTTPS.

```bash
sudo mkdir -p /etc/systemd/system/wordjs.service.d
sudo tee /etc/systemd/system/wordjs.service.d/proxy.conf >/dev/null <<'EOF'
[Service]
Environment=WORDJS_HTTP=1
Environment=WORDJS_TRUST_PROXY=loopback
EOF
sudo systemctl daemon-reload && sudo systemctl restart wordjs
```

## 2. Set the site's main address

Every link, feed and email is built from the site's **main address**, and WordJS answers only the
addresses it knows (anything else gets `421`). Make the public HTTPS address the main one. Run the
command as the service account, from the site directory:

```bash
cd /srv/wordjs
sudo -u wordjs npm run site -- canonical https://www.example.com --drop-old
sudo -u wordjs npm run site -- list
```

`--drop-old` stops answering the previous address (`localhost:3000` if you kept the wizard's
default); use `--redirect-old` instead to send visitors of the old address to the new one. The same
setting is in **Admin → Settings → Site address**. A running server applies it within seconds.

## 3. Install nginx and get a certificate

```bash
sudo apt-get install -y nginx certbot
```

Start with a site that only answers port 80, so Let's Encrypt can check that you control the domain:

```bash
sudo tee /etc/nginx/sites-available/wordjs >/dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name www.example.com;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}
EOF
sudo ln -sf /etc/nginx/sites-available/wordjs /etc/nginx/sites-enabled/wordjs
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo certbot certonly --webroot -w /var/www/html -d www.example.com
```

Certbot stores the certificate under `/etc/letsencrypt/live/www.example.com/` and installs a timer
that renews it.

## 4. The full nginx site

Replace the file with the complete configuration:

```nginx
# /etc/nginx/sites-available/wordjs
server {
    listen 80;
    listen [::]:80;
    server_name www.example.com;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name www.example.com;

    ssl_certificate     /etc/letsencrypt/live/www.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/www.example.com/privkey.pem;

    # Media and WordPress imports can be large (the importer accepts up to 100 MB).
    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # WordJS checks the address the browser used (host gate, CSRF origin check, links).
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        # Notifications and live collaboration are Server-Sent Events streams:
        # don't buffer them and don't cut them off after nginx's default 60 s.
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

On nginx 1.25.1 or newer you may write `listen 443 ssl;` plus `http2 on;` instead of
`listen 443 ssl http2;` (both work; newer versions print a deprecation notice for the old form).

Things this configuration relies on:

- **`Host` must reach WordJS unchanged.** The host gate, the CSRF origin check and every generated
  link use it.
- **Request headers are passed through.** In particular `X-CSRF-Token`, which the admin sends on
  every write. nginx forwards it by default; do not strip custom headers.
- **No WebSocket configuration is needed.** WordJS serves no WebSocket in production: live
  collaboration and notifications are SSE streams plus ordinary `POST` requests.

## 5. Close port 3000

WordJS still listens on every interface. Only nginx should reach it. With nftables:

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
sudo systemctl enable --now nftables
sudo systemctl restart nftables
```

If the server already has a firewall (ufw, a cloud security group), add the equivalent rule there
instead; `flush ruleset` above replaces any nftables rules that were loaded before.

## 6. Check it

From your own machine:

```bash
curl -I http://www.example.com/            # 301 → https://www.example.com/
curl -I https://www.example.com/           # 200
curl -m 5 http://www.example.com:3000/     # times out: the port is closed
```

Then sign in at `https://www.example.com/login`. Your browser shows a valid certificate, and the
session cookie is marked `Secure`.

## Next steps

- Split the site into gateway, backend and frontend processes: [Tutorial 3](03-split-mode-on-one-server.md).
- Back up the site and keep it updated: [Tutorial 15](15-backups-restore-and-upgrades.md).

---
*Tested on 2026-10-17 with WordJS 2.6.0 on Debian 12 (nginx 1.22.1, nftables), on the site from
Tutorial 1, with the domain `www.wordjs.test`. The lab has no public DNS, so Let's Encrypt could not
be used: step 3's certificate was replaced by one from a private test CA; everything else ran as
written. Checked through nginx: HTTP→HTTPS redirect, sign-in over HTTPS with a `Secure` session
cookie, a cookie-authenticated write (and refusal of a cross-site `Origin`), the notifications and
collaboration SSE streams, and port 3000 refused from another machine while 443 answered.*
