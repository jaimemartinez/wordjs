# Site address — the main address, the other addresses, and which hosts WordJS answers

WordJS has **one main address** and any number of **other addresses** it also answers on. The main
address (`siteUrl` in `backend/wordjs-config.json`) is the only base used for links built outside the
browser: password-reset and verification emails, feeds, the sitemap, canonical and OpenGraph tags,
plugin `site.url()`, the mail domain. Every other accepted address (an alias, a server IP, `localhost`)
serves the same site, but never ends up in a link.

A request sent to an address the site does **not** answer gets `421 Misdirected Request`. Nothing about
the main address is ever taken from a request's `Host`. It changes only through Settings → Site address
(administrator session, password confirmation, audit, notice to every administrator), the server's
command line (`npm run site`) or the config file itself.

This page is the operator's reference. The design lives in the code: `backend/src/core/host-policy.js`
(parser, classifier, gate; byte-identical copy at `gateway/src/host-policy.js`),
`backend/src/core/site-address.ts` (the single writer), `gateway/src/host-edge.js` (the edge check used
by the gateway and the monolith) and `backend/scripts/site-address.js` (the CLI).

- [Which addresses are answered](#which-addresses-are-answered)
- [What an unaccepted address gets](#what-an-unaccepted-address-gets)
- [Signing in on an address other than the main one](#signing-in-on-an-address-other-than-the-main-one)
- [Managing addresses: admin screen](#managing-addresses-admin-screen)
- [Managing addresses: command line](#managing-addresses-command-line)
- [Environment variables and config keys](#environment-variables-and-config-keys)
- [Moving the site to a new address](#moving-the-site-to-a-new-address)
- [Reverse proxies, TLS termination and frontend replicas](#reverse-proxies-tls-termination-and-frontend-replicas)
- [Split and separate mode: the gateway](#split-and-separate-mode-the-gateway)
- [Docker, compose and Helm](#docker-compose-and-helm)
- [Upgrading from earlier versions](#upgrading-from-earlier-versions)
- [Troubleshooting](#troubleshooting)
- [Why not several main addresses?](#why-not-several-main-addresses)

## Which addresses are answered

Each request is classified by the address it was sent to (the `Host` header, or a forwarded host from
a [trusted hop](#which-header-names-the-host)). Addresses are matched by **hostname only**; the port is
ignored, as it always was.

| Class | What it is | Where it comes from |
|---|---|---|
| **main** | The main address. | `siteUrl` in `wordjs-config.json`. |
| **alias** | Another address the site answers on. Never used in links. Ignored once its `expiresAt` has passed. | `siteAliases` in `wordjs-config.json`, written by the admin screen or the CLI. |
| **environment** | Extra addresses set by whoever runs the server. Read-only in the admin screen. | `WORDJS_ALLOWED_HOSTS` (comma-separated hosts or URLs). |
| **loopback** | `localhost`, `127.0.0.0/8`, `[::1]`. In development also `*.localhost`. | Always accepted. |
| **IP address** | Any IPv4 or IPv6 literal (`http://192.168.1.50:3000`, `http://[2001:db8::5]`). | `hostPolicy.ipLiterals`: `any` (default), `own` (only this server's own interface addresses, re-read every 5 s) or `none`. `WORDJS_IP_HOSTS` overrides it. |
| **development origin** | Named hosts for local development (a `.test` name, another machine's name). | `WORDJS_DEV_ORIGINS`, honoured only when `NODE_ENV=development`. |
| **unknown** | Everything else. | Refused with 421. |

Two rules keep this safe to widen:

- **IP literals cannot be used for DNS rebinding.** A rebinding attack needs a *name* the attacker
  controls that resolves to your server; an IP address or `localhost` is not such a name. That is why
  any IP is accepted by default. One exception: an IP literal is **refused** when the request came
  through a proxy WordJS does not trust (it carries `X-Forwarded-For`, `X-Real-IP`, `Forwarded` or
  `Via`, or, except at the gateway, where frontend nodes relay it legitimately, an `X-Forwarded-Host`
  that differs from `Host`). That is the signature of a reverse proxy
  that rewrote `Host` to its upstream address, and accepting it would switch the named-host check off
  for every name that proxy serves. An IP you list explicitly as an alias is matched before this rule,
  so it is answered even through a proxy.
- **Named hosts must be declared.** No name is ever accepted automatically: not on install, not on
  upgrade, not from the database. Wildcards, CIDR ranges and suffixes (`*.example.com`) are refused, so
  a forgotten subdomain cannot become an attacker's rebinding name.

Address values are parsed by one strict parser. Things that browsers and resolvers read differently
(`127.1`, `0x7f.0.0.1`, `2130706433`, `01.2.3.4`, zone ids, user-info tricks such as
`localhost:1@evil.example`, two `Host` headers) are refused with `400 rest_invalid_host`. One trailing
dot is ignored (`example.com.` is `example.com`), and IPv6 is compared in its compressed form.

## What an unaccepted address gets

There are two layers.

**The backend gate** runs on every backend request, right after the security headers and before CORS,
cookies, rate limiters and CSRF:

| Request | Answer |
|---|---|
| Unknown address on any API path, including `/api/v1/setup/*` once the site is installed | `421` `{"code":"rest_host_not_allowed"}`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`. No redirect, and no hint of the real address. |
| Malformed `Host`, or two `Host` headers | `400 rest_invalid_host` |
| No `Host` at all (HTTP/1.0 health checks) | Passed. Writes still fail the CSRF check. |
| `/uploads`, `/themes`, `/plugins`, `/.well-known`, `/public`, `/health`, `/healthz`, `/readyz`, `/metrics`, `/favicon.ico` | Not checked by the backend gate (as before). |
| Site not installed yet | Everything passes, so the install wizard is reachable at any address. |
| `siteUrl` missing or invalid in the config | Everything passes, an error is logged once, and administrators get a notice. Fix it in Settings → Site address or with `npm run site -- canonical <url>`. |

**The edge** (the monolith's public listener, and the gateway worker in split and separate mode) checks
pages, static files, uploads and WebSocket upgrades too:

- An unknown address gets a static 421 page: no script, no form, one link to the main address
  (`Content-Security-Policy: default-src 'none'`). API paths get the same JSON 421 as the backend gate.
- An alias with `"mode": "redirect"` answers `GET`/`HEAD` page requests with a `308` to the same path
  on the main address (`Cache-Control: max-age=3600`). API calls and WebSockets on it are served
  normally.
- A WebSocket upgrade to an unknown address is refused on the socket.
- The optional port-80 ACME listener redirects to an address the site answers (the requested one when
  accepted, otherwise the main address), never to a raw `Host`.
- `/healthz`, `/health`, `/readyz`, `/metrics` and `/.well-known/acme-challenge/*` are answered on any
  address: probes use pod and container IPs, and a challenge is fetched for a name whose certificate
  does not exist yet.

The monolith's edge uses the backend's own policy. The gateway's edge uses the policy the backend
[pushes to it](#split-and-separate-mode-the-gateway).

**In the browser** the client never navigates on a 421. A page served from an unaccepted address shows
a bar with one link to the main address and no form, and the admin replaces its sign-in form with the
same notice. A `redirect` in a response body is never followed; the only automatic navigations left
are the fixed ones (`/install` on `503 setup_required`, and the MFA enrolment page).

Refusals are logged once per host per minute (at most ten lines a minute overall), with a hint when the
cause is recognisable, and the last 32 refused hosts are listed under **Recently refused** in Settings →
Site address.

## Signing in on an address other than the main one

Before this release no session could exist anywhere but the main address and loopback, because every
other address answered 409. Accepting more addresses must not quietly turn each of them into a place
where a 7-day session cookie is handed out, so in production a session is minted only where it is safe.

| Address | Development | Production |
|---|---|---|
| Main address, loopback | Allowed | Allowed (unchanged) |
| Named alias or `WORDJS_ALLOWED_HOSTS` entry | Allowed | Allowed by default. On an **https** main address the connection itself must really be https (see [TLS termination](#tls-terminating-proxies)). |
| `http://` alias on an `https` main address | Allowed | Refused, unless the alias was added with sign-in explicitly on (`--http-signin`, or the checkbox). The cookie then crosses the network in clear text; the admin screen says so. An `http://` entry in `WORDJS_ALLOWED_HOSTS` cannot opt in. |
| IP address (class **IP address**, or an alias that is an IP) | Allowed | Refused, unless `hostPolicy.ipSignIn` is on (Settings → Site address, IP addresses, or `npm run site -- ip-signin on`) or the alias has sign-in explicitly on. On an https main address the connection must also be https, unless the alias is declared `http://` with sign-in explicitly on. |
| Tunnel names (`*.ngrok-free.app`, `*.trycloudflare.com`, `*.loca.lt`, …) and `.local` names | Allowed | Refused unless the alias has sign-in explicitly on. |

Why IPs, tunnels and `.local` names default to off: the session outlives the name. DHCP gives the IP to
another device, the tunnel service hands the name to its next customer, anyone on the LAN can answer
mDNS for a `.local` name — and a returning browser then sends its cookie to the new holder.

A refused sign-in answers `403 rest_insecure_transport` with `data.reason` `transport` (the connection
is not https) or `address` (sign-in is not enabled here). The login page shows the reason before any
password is typed: `GET /auth/me` tells it whether this address may sign in.

**Sessions remember where they were started.** Every session except a loopback one is bound to the
address it was started on; one started on an alias also expires no later than the alias's `expiresAt`.
When that address stops being accepted (alias removed or expired, `WORDJS_ALLOWED_HOSTS` entry gone, IP
policy narrowed, or the old main address dropped in a move), every session started there gets
`401 rest_token_revoked`, because a retired name can end up in someone else's hands and a returning
browser would send them its cookie. Moving the main address with *keep* or *redirect* turns the old one
into an alias, so its sessions keep working. The binding cannot be shed: `POST /auth/refresh` keeps it
(and the expiry cap) whichever address the refresh arrives on, and a session started on an address other
than the main one cannot create a personal API token (`403 rest_token_bound_session`). Create API tokens
from a session started at the main address (or on `localhost`).

The session cookie stays host-only (no `Domain` attribute), so each address keeps its own session; you
sign in separately on each. On the main address and loopback the cookie's `Secure` flag follows the
same rule as before (Secure when `siteUrl` is https or the listener serves TLS). On any other address it
is Secure when the address was declared `https://` or the request really arrived over TLS.

## Managing addresses: admin screen

**Settings → Site address** (`/admin/settings/site-address`), administrators only, browser session only
(an API token cannot read or change it).

- **Main address**, with **Change…**: pick one of the other addresses or type a URL, choose what happens
  to the current main address (keep answering on it, redirect it, or stop answering on it), read the
  consequences, confirm with your password.
- **Other addresses**: URL, label, behaviour (serve or redirect), sign-in, source (admin, command line,
  installer, config file), expiry, last seen. Actions: make main, edit, remove. Removing the address you
  are using right now asks for an explicit confirmation.
- **Always accepted**: loopback, this server's own addresses, the IP policy (`any` / `own` / `none`) and
  the sign-in-on-IP switch, the `WORDJS_ALLOWED_HOSTS` entries, and the development origins.
- **Recently refused**: host, count, last seen and a hint. **Add as address…** opens the add dialog
  prefilled. Only add names whose DNS you control.
- "You are connected via *host* (*class*)", for information only. There is no "adopt this address"
  button anywhere, on purpose.
- Banners for an [upgrade conflict](#upgrading-from-earlier-versions), a gateway that reports another
  address, a proxy that hides the visitors' address, and a missing main address. The dashboard also
  shows a banner when you browse the admin on an address other than the main one.

Every change:

- needs your current password, and is refused with `409 rest_site_address_stale` if someone else changed
  the addresses since you loaded the page (reload and retry);
- is refused with `409 rest_site_address_in_use` when an address you are removing is still in use: it is
  the host of `gatewayUrl` (server-side rendering goes through it in split mode) or of `frontendUrl`
  (cache purges go to it), or somebody signed in through it in the last 10 minutes. **Change anyway**
  overrides this, and the override is audited;
- writes the config file atomically and the database mirrors (`siteurl`, `home`, `site_address_rev`) in
  one step, rolling the file back if the database refuses;
- purges the page caches, records an audit row (`site.address.canonical`, `.aliases`, `.policy`,
  `.repair`, `.conflict_resolved`), and notifies every administrator in-app and, when mail is
  configured, by email. The email contains no links, on purpose.

The REST API behind it is `GET /api/v1/site-address` and `PUT /api/v1/site-address/{canonical,aliases,policy}`
(see [api.md](api.md#site-address)).

## Managing addresses: command line

The CLI is the way back in when the admin screen cannot be reached: the main address points at a
domain that no longer resolves, or a proxy sends the wrong `Host`. Whoever can run it can already edit
the config file, so it asks for no password.

```bash
npm run site -- list                               # main address, other addresses, IP policy, warnings
npm run site -- check www.example.com              # would the site answer this Host, and why (not)?
npm run site -- add https://www.example.com        # answer on another address
npm run site -- add https://ab12.ngrok-free.app    # tunnel names expire after 7 days by default
npm run site -- add https://shop.example.com --redirect --label shop
npm run site -- add http://cms.lan:3000 --http-signin   # allow signing in there over plain http
npm run site -- add https://kiosk.example.com --no-signin   # answer it, but never start a session there
npm run site -- add https://box.local --confirm-local   # .local names need explicit confirmation
npm run site -- add https://demo.example.com --expires 24h   # 90m, 24h, 7d, a date, or never
npm run site -- remove www.example.com [--force]   # stop answering on it
npm run site -- canonical https://example.com --keep-old     # change the main address
npm run site -- canonical https://example.com --redirect-old # old main address redirects (308)
npm run site -- canonical https://example.com --drop-old     # stop answering on the old one
npm run site -- ip-literals any|own|none           # which IP addresses are answered
npm run site -- ip-signin on|off                   # allow signing in on IP addresses (production)
```

- `--dir <path>` points the command at another installation's `backend/` directory.
- `remove` refuses when `gatewayUrl` or `frontendUrl` still use the address; `--force` overrides.
- It writes **only the config file**, through the same planners and the same atomic, compare-and-swap
  writer as the admin screen: an unreadable file is never rewritten, and a change that raced another
  writer is refused (run it again). The revision goes up with `lastChange.via: "cli"`.
- A running backend notices within about 2 seconds and applies the rest (database mirrors, gateway push,
  cache purge, audit, notices); a stopped one does so at its next start.
- In a container: `docker compose exec wordjs npm run site -- list`, or with the Helm chart
  `kubectl exec deployment/wordjs -- npm run site -- list` (the Deployment is named after the release).
  The config there is a symlink into the data volume; every writer follows it, so the change lands in
  the volume.

## Environment variables and config keys

| Variable | Effect |
|---|---|
| `WORDJS_SITE_URL` | **Before install only.** Offered by the install wizard as the server's suggested main address (`GET /setup/status` returns it as `suggestedSiteUrl`) when it is not a loopback address. It never prefills the field and never overrides an installed main address. Docker's entrypoint also writes it as `siteUrl` under `WORDJS_PRESEED_CONFIG=1`. |
| `WORDJS_ALLOWED_HOSTS` | Extra accepted addresses, comma-separated: `www.example.com, https://cms.example.com, 10.0.0.5`. A URL entry keeps its scheme, which matters for [signing in behind a TLS ingress](#tls-terminating-proxies). Never persisted; shown read-only. |
| `WORDJS_IP_HOSTS` | `any`, `own` or `none`; overrides `hostPolicy.ipLiterals`. |
| `WORDJS_DEV_ORIGINS` | Development only: extra named hosts, comma-separated. A `.local` entry logs a warning. |
| `WORDJS_TRUST_PROXY` | Which peers are your proxies (see [below](#which-header-names-the-host)). `trustProxy` in the config wins over it. |

| Config key (`wordjs-config.json`) | Meaning |
|---|---|
| `siteUrl` | The main address, `http(s)://host[:port]`, nothing else. |
| `siteAliases` | `[{ "url", "mode": "serve"\|"redirect", "label", "signIn", "expiresAt", "source", "addedBy", "addedAt" }]`, at most 50. Entries that do not parse are ignored with a warning. |
| `hostPolicy.ipLiterals` | `any` (default), `own`, `none`. |
| `hostPolicy.ipSignIn` | `true` allows sessions on IP addresses in production. Default off. |
| `trustProxy` | Which peers are your proxies: an IP, a CIDR, `loopback`, `linklocal`, `uniquelocal`, or a list of them. A hop count or `true` only affects the client IP used by rate limits. |
| `siteAddress` | `{ rev, lastChange }`. Written by WordJS; do not edit by hand. |

Prefer the CLI to editing these keys by hand. The CLI raises `siteAddress.rev`, and the revision is what
makes the running backend (or the next start) update the database mirrors, push to the gateway and purge
the caches. A hand edit without it changes the address check within seconds, but links keep using the
database's copy of the main address and the gateway keeps its last policy until the next change made
through the CLI or the admin screen.

## Moving the site to a new address

A planned move takes four steps and never locks you out:

1. **Add the new address** as another address (Settings → Site address → Add address, or
   `npm run site -- add https://new.example.com`).
2. **Browse to it** and check DNS and TLS. Sign in there; it is a separate session, because cookies are
   per address.
3. **Make it the main address** (Make main, or `npm run site -- canonical https://new.example.com`).
   The old main address stays answered as an alias (`keep`, the default), becomes a redirecting alias
   (`redirect`), or is dropped (`drop`). `frontendUrl` and `gatewayUrl` are rewritten in the same change
   when they named exactly the old main address.
4. **Remove the old address** later, once nothing uses it.

What follows a move: password-reset and verification links already sent keep the old address; the mail
domain follows the new address unless `mail_domain` is set; the new address needs its own TLS
certificate; sitemap, feeds and canonical tags switch; page caches are purged. Removing an address
(or dropping the old main address) revokes every session that was started on it; with `keep` or
`redirect` those sessions keep working until you remove the old address.

**Locked out** (the main address no longer reaches the server):

- on the server, `npm run site -- canonical https://reachable.example.com --keep-old`, or
  `npm run site -- add https://reachable.example.com`;
- or open the admin through the server's IP address or through `localhost` (for example
  `ssh -L 3000:localhost:3000 your-server`, then `http://localhost:3000/admin`). `localhost` is always
  accepted and always signs in. An IP address is accepted while `hostPolicy.ipLiterals` is `any` (the
  default) or `own` (this server's own addresses), and not when it is `none`; on an IP address sign-in
  may be off in production (`npm run site -- ip-signin on` enables it).

## Reverse proxies, TLS termination and frontend replicas

### Forward the browser's `Host`

The proxy in front of WordJS must forward the `Host` the browser sent:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

nginx's default is `Host $proxy_host` (the upstream address). With it:

- a named upstream (`wordjs:3000`, `wordjs_upstream`) gets 421, logged with the hint "a reverse proxy in
  front of WordJS is probably not forwarding the browser's Host";
- an IP upstream (`192.168.5.20:3000`) gets 421 for the same reason (an IP literal arriving with proxy
  headers from a proxy WordJS does not trust);
- a loopback upstream (`127.0.0.1:3000`) is still answered, as before, but every visitor then looks like
  `localhost`: the site logs a warning and shows administrators a "proxy hides the visitors' address"
  notice.

`X-Forwarded-Host` is not a substitute. The edge judges the `Host` it received and then overwrites
`X-Forwarded-Host` with it.

### Which header names the host

`X-Forwarded-Host` and `X-Forwarded-Proto` are believed only from a **trusted hop**:

- the WordJS gateway, identified by its mTLS certificate (`CN=gateway` / `gateway-internal`);
- a loopback peer that addressed a loopback name (the monolith's internal SSR listener, a gateway or
  nginx on the same machine dialling `127.0.0.1`). A DNS-rebinding page that reaches `127.0.0.1:4000`
  sends its own name as `Host`, so its forged `X-Forwarded-Host` is ignored;
- a peer inside `trustProxy` / `WORDJS_TRUST_PROXY`. Only **address-based** settings count here: an IP,
  a CIDR, `loopback`, `linklocal`, `uniquelocal`, or a list. A hop count (`1`) or `true` still drives
  the client IP for rate limiting, but never makes a forwarded host trustworthy (a warning says so).
  From such a peer, `X-Forwarded-Proto` is believed; `X-Forwarded-Host` is believed only when the `Host`
  that peer sent is an IP address, a loopback name or a single-label name (`backend:4000`). A peer
  that sends a dotted name as `Host` is judged by that name, so a rebinding page on a trusted network
  cannot pass `X-Forwarded-Host: <your site>` off as its address.

Everyone else is judged by `Host`, which a browser cannot forge.

### TLS-terminating proxies

The main address is unaffected by where TLS ends: sign-in there is always allowed and its cookie is
Secure when `siteUrl` is https. Other addresses sign in on an https site only when the request really
arrived over https, which WordJS can only know from a trusted hop:

- **Monolith, Docker, Helm** (plain HTTP inside the container): set `trustProxy` / `WORDJS_TRUST_PROXY`
  to the proxy's or ingress controller's address or subnet (`loopback` for a proxy on the same
  machine). The monolith then passes that proxy's `X-Forwarded-Proto` through; without it, every
  request looks like plain http and only the main address and loopback can sign in.
- **Split and separate mode:** the gateway reports the scheme of its own listener and drops the
  client's `X-Forwarded-Proto`. Let the gateway terminate TLS (`ssl.enabled`); behind an external TLS
  proxy in front of a plain-http gateway, only the main address and loopback can sign in.

This only ever refuses a sign-in; it never grants one.

### Frontend replicas that reach a backend directly

A frontend replica pinned to one backend (`WORDJS_BACKEND_URL=http://10.0.1.23:4000`, see
[multi-node.md](multi-node.md#pinning-a-frontend-replica-to-a-backend--wordjs_backend_url)), or whose
server-side rendering uses `internalApiUrl` / `INTERNAL_API_URL` pointing at a backend on another
machine, sends `Host: 10.0.1.23:4000` and the browser's host in `X-Forwarded-Host`. The replica is not a
trusted hop by default, so the backend judges `10.0.1.23:4000` arriving through a proxy and answers
**421 to every proxied `/api` call and every SSR fetch**. Set, on **each backend**:

```bash
WORDJS_TRUST_PROXY=10.0.1.30,10.0.1.31      # the replicas' addresses, or their subnet: 10.0.1.0/24
```

Address the backend by IP (or a single-label service name), not by a dotted DNS name, or its
`X-Forwarded-Host` is not believed (see above). When this is missing, the backend logs
`<peer> forwards X-Forwarded-Host but is not in trustProxy; if it is your frontend replica or proxy, set WORDJS_TRUST_PROXY=<peer> …`.
The address browsers use to reach the replica must itself be one the site answers (the main address,
another declared address, or an IP under `ipLiterals: any`).

## Split and separate mode: the gateway

The gateway has no `wordjs-config.json` of its own in separate mode, so the **backend pushes the host
policy** to the gateway's internal mTLS listener: `POST /host-policy` (CN `backend` only; see
[gateway.md](gateway.md#host-policy-push)). The body is the main address, the aliases, `hostPolicy`,
`trustProxy`, the backend's `WORDJS_ALLOWED_HOSTS` / `WORDJS_IP_HOSTS` / `WORDJS_DEV_ORIGINS` /
`WORDJS_TRUST_PROXY` and its `NODE_ENV`, so the edge and the backend apply the same policy. The
backend pushes:

- after every change (main address, aliases, IP policy, automatic repair), from the admin screen or
  the CLI;
- at the end of its boot reconciliation, after every successful registration with the gateway (so a
  restarted gateway is re-armed), and right after a fresh install completes;
- `{ "enforce": false }` while the site is not installed, so the install wizard is reachable anywhere.

The gateway stores the push in `gateway/gateway-host-policy.json` (git-ignored, never shipped in a
release). Workers re-read it when it changes, without a restart. Until the first push the gateway's edge
enforces nothing and the backend gate still guards the API. A failed push is a warning on the change,
never a failed change.

**Reinstalling.** The `{ "enforce": false }` push needs the backend's mTLS identity, which lives in
`wordjs-config.json`. If you reinstall by deleting that file, also delete `gateway/gateway-host-policy.json`;
otherwise the gateway keeps enforcing the previous site's addresses and a wizard opened at a different
address gets the gateway's 421 page.

**SSL or port changes.** After `POST /api/v1/system/certs/config`, and at every backend start, the
gateway reports the address it now serves. If it is the same host moving from `http` to `https` (with or without a port change), the main
address follows automatically and the change is audited as `site.address.repair`, so reset links are
never emailed as `http://` after TLS was turned on. Any other difference (another host, a downgrade) is
only suggested: the certificates page opens the Change dialog prefilled, and Settings → Site address
shows a "the gateway reports a different address" banner.

**Separate mode.** Server-side rendering on a frontend node reaches the gateway by the address in its
`internalApiUrl`, usually an IP. With the default `ipLiterals: any` that works as is. With `own` or
`none`, add that address as an alias.

## Docker, compose and Helm

- **`WORDJS_SITE_URL`** is a suggestion for the install wizard, not the main address. The wizard
  prefills the address you are browsing and offers the server's suggestion as a button. Under
  `WORDJS_PRESEED_CONFIG=1` the entrypoint still writes it as `siteUrl`, because the wizard is skipped.
- **Behind a proxy**, forward `Host` (above). If other addresses must sign in over https, set
  `WORDJS_TRUST_PROXY` to the proxy's address or network.
- **Helm** exports `WORDJS_ALLOWED_HOSTS` from `siteUrl`, every ingress host (`ingress.host` plus
  `ingress.extraHosts`) and `allowedHosts`, with `https://` for hosts covered by an ingress TLS entry. So
  every name the ingress routes is answered, whatever main address the wizard recorded. `trustProxy`
  exports `WORDJS_TRUST_PROXY`. See [`deploy/helm/wordjs`](../deploy/helm/wordjs/README.md).
- The CLI works inside the container (`npm run site -- …`); the config is a symlink into the data
  volume, and writes follow it.

## Upgrading from earlier versions

Nothing to migrate by hand. At the first boot the backend reconciles the config with the database:

- the config's `siteUrl` and the database's `siteurl` agree, or the database has none: the revision is
  set to 1 and everything continues;
- they **disagree**: nothing is written. The gate keeps using the config's host, links keep using the
  database value exactly as before, and administrators see a "two different main addresses" banner
  with *Use A* / *Use B*. Resolve it there or with `npm run site -- canonical <url>`;
- a `siteUrl` corrupted by the old `/setup/migrate` (`https,http://example.com`) is repaired to `https`
  automatically and audited. A list without `https` is never guessed at: it becomes a conflict.

No address is added automatically. If the site was reached under several names before (a `www` twin,
the server's name on the LAN), add them as aliases, or they will get 421.

| | Before | Now |
|---|---|---|
| IP address, `[::1]`, `127.0.0.2`, `example.com.` | Was `409 migration_required` | Answered (an IP through an untrusted proxy: 421) |
| Unknown name, API | Was 409 with a redirect to `/migration` | 421, no redirect |
| Unknown name, pages and static files | Served | 421 page at the monolith and gateway edges |
| Unknown name, `/api/v1/setup/*` after install | Answered | 421 |
| Malformed or repeated `Host` | Passed | 400 |
| `/migration` page and `POST /setup/migrate` | Password form that repointed the site at the request's host | The page redirects to Settings → Site address; the endpoint answers `410 rest_migrate_removed` |
| `GET /setup/status` | Reported the request's host and a mismatch | `{ installed }`, plus `suggestedSiteUrl` before install |
| `PUT /settings` with `siteurl` / `home` | Written, unvalidated | Refused (400 for the single key, skipped in bulk saves) |
| `X-Forwarded-Host` / `-Proto` | Believed from any peer | Believed only from a trusted hop |
| Sitemap, robots and feeds without a stored address | Built from the request's host | Built from the main address |
| Split mode, SSL turned on | Links switched scheme silently at the next backend restart | Same host http to https follows at once (audited); anything else is suggested |
| Sign-in on other addresses | Impossible (409) | [The rules above](#signing-in-on-an-address-other-than-the-main-one) |

Deployments to check after upgrading: a reverse proxy that does not forward `Host`; frontend replicas
that reach a backend directly (they need [`WORDJS_TRUST_PROXY`](#frontend-replicas-that-reach-a-backend-directly));
LAN or `www` names that were never declared.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `421 rest_host_not_allowed` | The address is not declared. `npm run site -- check <host>` prints the class and the reason; add it in Settings → Site address or with `npm run site -- add <url>`. |
| 421 with the hint "not forwarding the browser's Host", reason `proxied-ip` | A proxy rewrote `Host` to its upstream. Add `proxy_set_header Host $host`. If the peer is your own frontend replica, set `WORDJS_TRUST_PROXY` on the backend (the log names the peer). |
| Log: `<peer> forwards X-Forwarded-Host but is not in trustProxy; …` | A frontend replica or proxy addresses the backend by IP and relays the browser's host. Set `WORDJS_TRUST_PROXY=<peer>` (or `trustProxy` in the config) on that backend. |
| Log: `<peer> is in trustProxy but addresses WordJS as <name>, a DNS name, so its X-Forwarded-Host is not read` | The trusted peer dials WordJS by a dotted name. Point it at WordJS by IP (or a single-label name), or make it forward the browser's `Host`. |
| 421 on an address that used to work | The alias expired (`expired-alias`), or `ipLiterals` is `own`/`none` (`ip-not-own`, `ip-literals-none`). |
| `400 rest_invalid_host` | A malformed `Host`, or two of them. Usually a misconfigured client or proxy. |
| `403 rest_insecure_transport`, `data.reason: "transport"` | An https site reached over plain http on an address other than the main one. Use https, or make the proxy's scheme trusted (`WORDJS_TRUST_PROXY`). |
| `403 rest_insecure_transport`, `data.reason: "address"` | Sign-in is off for this address in production: an IP (`npm run site -- ip-signin on`), a tunnel or `.local` name, or an `http://` alias on an https site (re-add it with `--http-signin`). |
| `401 rest_token_revoked` right after removing an address | Expected: sessions started on a removed address end with it. Sign in again on an accepted address. |
| "The site has two different main addresses" | Upgrade conflict; choose one (above). |
| "A reverse proxy is hiding the address visitors use" | A local proxy rewrites `Host` to `localhost`; forward `Host`. |
| `trustProxy … is not address-based` in the log | A hop count or `true` was set; it still drives rate-limit client IPs, but no forwarded host is believed from it. Use an IP, a CIDR or `loopback`. |

## Why not several main addresses?

You can have as many addresses as you like that **work**. You cannot have several that are written into
**links**, because links built outside a request (reset emails, feeds, plugin `site.url()`, mail domain,
payment return URLs, ACME) cannot follow a request, and because letting the request choose the link
base would let anyone who triggers a password reset choose which listed address receives the token.
Caches have no host in their key either. Pages in the browser use relative URLs (`Media.sourceUrl`,
`featuredMedia.path`), so browsing works the same on every accepted address. Several domains, each with
its own identity in links, is multisite or domain mapping: a separate feature.
