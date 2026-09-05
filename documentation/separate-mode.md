# Separate mode — running WordJS across multiple machines

WordJS normally runs as a **monolith** (`npm run start:mono`, one process) or a **split** on one host
(`npm start`, gateway + backend + frontend side by side). **Separate mode** is the split spread across
**different machines** — a gateway box, a backend box, and a frontend box — joined into one cluster.

The hard part of a multi-machine setup is trust: the services talk over **mutual TLS**, so every node
needs a certificate signed by a shared cluster CA. Copying certs around by hand is tedious and
error-prone. Instead, WordJS uses **join tokens**, exactly like `kubeadm join` or `docker swarm join`:

1. The **gateway** is the cluster's certificate authority. Init mints the CA (and keeps the CA
   private key, `0600`, on the gateway only).
2. The gateway prints a **single-use, time-limited token** bound to a role.
3. On the new machine, joining makes **one** call to the gateway's enrollment endpoint,
   sending a CSR. The gateway validates the token and signs the node an mTLS identity
   (`CN=backend`/`CN=frontend`), returning it plus the cluster CA and the shared bootstrap config.
4. The service starts and **registers** itself with the gateway over mTLS; the gateway begins proxying
   traffic to it. The token is burned after that first call.

No cert is ever hand-copied. The token authorizes exactly the *first* communication; everything after
is mTLS.

```
                 join token (backend)   ┌───────────────┐
      ┌────────────────────────────────▶│    GATEWAY    │  :3000 public
      │  (paste token on backend box)   │  cluster CA   │  :3100 mTLS /register
      │                                 │  (CA key kept)│  :3101 token /enroll
      │  1. POST /enroll {token, CSR} ─▶ └──────┬────────┘
   ┌──┴───────┐   2. ◀─ signed cert + CA        │ proxies /api,/uploads → backend
   │ BACKEND  │──── 3. mTLS /register ──────────┤          /  → frontend
   │  :4000   │                                 │
   └──────────┘        ┌──────────┐             │
                       │ FRONTEND │─ /enroll ───┘
                       │  :3001   │─ /register (mTLS) ─┘
                       └──────────┘
```

## Prerequisites

* Node.js ≥ 20.9 on every machine; `openssl` on the PATH of the machines that **join** (backend/frontend).
* Network reachability (open only to the app-tier subnet / VPN, **not** the public internet):
  * backend & frontend → gateway `:3100` (register) and `:3101` (enroll)
  * gateway → backend `:4000` and frontend `:3001` (proxy + health checks)

## Quickstart — one command per machine (recommended)

`npx create-wordjs` downloads the pre-compiled release, enrolls the machine and starts the service —
no repo checkout, no build step.

**Machine 1 — gateway:**

```bash
npx create-wordjs@latest gateway --host <gateway-ip>
```

This scaffolds `wordjs-gateway/`, initializes the cluster CA, mints one single-use token per role
(2 h TTL), prints the exact **ready-to-paste** `join` commands for the other machines — gateway
address, token and CA fingerprint included — and then starts the gateway (`--no-start` leaves it to
you: `cd wordjs-gateway && npm run prod:gateway`).

**Machine 2 — backend** (paste what the gateway printed; it looks like this):

```bash
npx create-wordjs@latest join backend --gateway <gateway-ip> --token <token> \
     --ca-hash <fingerprint> --advertise <backend-ip>
```

**Machine 3 — frontend:**

```bash
npx create-wordjs@latest join frontend --gateway <gateway-ip> --token <token> \
     --ca-hash <fingerprint> --advertise <frontend-ip>
```

Each `join` downloads the release into `wordjs-<role>/`, installs the runtime dependencies
(`npm run release:install`), then generates a keypair + CSR and enrolls against the gateway (writing
`wordjs-<role>/<role>/certs/*` and that node's `wordjs-config.json`), and finally starts the service,
which registers with the gateway over mTLS. Startup logs land in
`wordjs-<role>/<role>/cluster-start.log`.

Options: `--enroll-port <port>` if you changed the default `3101`; `--no-start` to scaffold + enroll
without starting; `[dir]` after the subcommand to pick the target directory.

Then jump to [Verify](#verify).

## Manual setup — from a pre-built release ZIP (advanced)

`npx create-wordjs` always downloads a **published** release from GitHub. When you need to deploy a
bundle you built yourself (`npm run bundle-release` → `release/wordjs-compiled-release.zip`, e.g. to
validate `main` before tagging), unpack that ZIP on each machine and drive `cluster.js` /
`node-join.js` from it — they ship inside the bundle, under `scripts/`.

The bundle is **already compiled** (`backend/dist/`, `frontend/.next/`) but ships **no**
`node_modules`. Install only the runtime dependencies for the role that machine plays, and do **not**
pass `--install`/`--build` to `node-join` (those run a full `npm install` including devDependencies,
and rebuild what the bundle already contains):

```bash
# every machine: unpack the bundle
mkdir -p /opt/wordjs && cd /opt/wordjs && unzip /path/to/wordjs-compiled-release.zip

# machine 1 — gateway
cd /opt/wordjs && npm install --omit=dev && (cd gateway && npm install --omit=dev)
node scripts/cluster.js init --host <gateway-ip>
(cd gateway && node src/index.js &)          # or a systemd unit
node scripts/cluster.js token backend  --host <backend-ip>
node scripts/cluster.js token frontend --host <frontend-ip>

# machine 2 — backend
cd /opt/wordjs/backend && npm install --omit=dev && cd /opt/wordjs
node scripts/node-join.js --role backend --gateway <gateway-ip> --enroll-port 3101 \
     --token <token> --ca-hash <fingerprint> --advertise <backend-ip>
(cd backend && npm start &)

# machine 3 — frontend
cd /opt/wordjs/frontend && npm install --omit=dev && cd /opt/wordjs
node scripts/node-join.js --role frontend --gateway <gateway-ip> --enroll-port 3101 \
     --token <token> --ca-hash <fingerprint> --advertise <frontend-ip>
(cd frontend && npm start &)
```

Then finish the install wizard (see [Verify](#verify)). **Keep the clocks in sync** across the build
machine and every node (`timedatectl set-ntp true`): the frontend serves prebuilt pages whose
freshness Next.js judges from file timestamps, so a node whose clock lags behind the machine that
built the bundle treats every prerendered page as "not yet stale" and serves the build-time
placeholder — including the pre-install *"Service Temporarily Unavailable"* homepage — forever.

## Manual setup — from a source checkout (advanced)

Use this when you run from a `git clone` instead of the release bundle (development, custom builds).
It is the same flow the npx commands automate.

### 1. Gateway machine

```bash
cd wordjs
npm run install:gateway            # gateway deps (includes node-forge for the CA)
node scripts/cluster.js init --host <gateway-ip>
#   → mints the cluster CA + the gateway's own identity + public cert,
#     writes gateway/gateway-config.json (routable internal bind, ports, shared secret),
#     clears the registry, and prints the CA fingerprint.
cd gateway && node src/index.js    # start the gateway (or `pm2 start src/index.js`)
```

`init` flags: `--host` (address nodes dial, default = first LAN IP), `--bind` (interface the internal
control plane binds, default = `--host`; **never** `0.0.0.0`), `--port` (public, 3000),
`--internal-port` (mTLS register, 3100), `--enroll-port` (token enroll, 3101), `--site-url`.

### 2. Mint a token for each node (on the gateway)

```bash
node scripts/cluster.js token backend  --host <backend-ip>
node scripts/cluster.js token frontend --host <frontend-ip>
```

Each prints the exact `node-join` command to paste on the target machine, including the gateway address,
enroll port, the token, and the CA fingerprint (`--ca-hash`, a MITM guard). Tokens default to a 60-minute
TTL (`--ttl <minutes>`) and are single-use.

### 3. Backend machine

Paste the command the gateway printed (it looks like this):

```bash
cd wordjs
npm run install:all                 # or: cd backend && npm install
node scripts/node-join.js --role backend --gateway <gateway-ip> \
     --enroll-port 3101 --token <token> --ca-hash <fingerprint> \
     --advertise <backend-ip> --install --start
```

`node-join` generates the keypair + CSR, enrolls, writes `backend/certs/*` and `backend/wordjs-config.json`
(with `host: 0.0.0.0`, `advertiseHost`, `gatewayHost`, the shared secret, and the mTLS paths), then
installs deps and starts the backend, which registers with the gateway.

### 4. Frontend machine

```bash
cd wordjs
node scripts/node-join.js --role frontend --gateway <gateway-ip> \
     --enroll-port 3101 --token <token> --ca-hash <fingerprint> \
     --advertise <frontend-ip> --install --build --start
```

The frontend's `wordjs-config.json` gets `internalApiUrl` pointed at the gateway's public origin (whose
cert is issued from the cluster CA, so SSR fetches validate — `start-frontend.js` sets
`NODE_EXTRA_CA_CERTS` to the cluster CA automatically).

## Verify

On the gateway, `gateway/gateway-registry.json` should list the **real** node IPs (not `127.0.0.1`):

```json
{ "/api": { "targets": ["https://<backend-ip>:4000"] },
  "/":    { "targets": ["https://<frontend-ip>:3001"] } }
```

Browse `https://<gateway-ip>:3000` — the gateway proxies `/` to the frontend (SSR pulls content from the
backend through the gateway) and `/api`, `/uploads`, `/themes`, `/public` to the backend.

First run shows the install wizard. Finish it in the browser, or headlessly against the gateway with
the one-time install token the backend mints at boot. Read it from `backend/data/install-token` (mode
`0600`) on the backend node: the boot banner prints the token itself only when the backend's stdout is a
TTY, so under systemd or any piped start it names that file instead. Set `WORDJS_PRINT_INSTALL_TOKEN=1`
to print it anyway, or supply your own out-of-band with `WORDJS_INSTALL_TOKEN` (≥ 16 chars):

```bash
curl -k -X POST https://<gateway-ip>:3000/api/v1/setup/install \
  -H 'Content-Type: application/json' -H "x-install-token: $TOKEN" \
  -H 'Origin: https://<gateway-ip>:3000' \
  -d '{"siteName":"…","adminUser":"admin","adminEmail":"…","adminPassword":"…","dbDriver":"sqlite-native","demoContent":true}'
```

Install **through the gateway**, not straight at the backend: the wizard derives `siteUrl` from the
request, and the address you install on becomes the site's canonical origin.

### Cache purge across machines — instant, via the gateway

Publishing is **instant** in separate mode, exactly like on a single host: an edit is visible on the
public site on the next request, not after the ISR window.

On one host the backend POSTs the purge straight at the frontend. Across machines it can't — its
`frontendUrl` is the gateway's public origin (whose `/api` prefix the gateway routes right back to the
backend), and a cluster may run several frontend replicas. So the purge takes the path the cluster
already trusts:

```
   BACKEND ──POST /purge (mTLS, CN=backend)──▶ GATEWAY ──POST /api/revalidate──▶ FRONTEND ①
     (content changed)                        (reads its own registry)      └──▶ FRONTEND ② …
```

* **Discovery** is the gateway's job. It already knows every frontend node — they register with it —
  so it fans one purge out to **all** of them. The backend guesses no addresses and needs no new
  discovery mechanism of its own.
* **Authorization** is the mTLS identity already used for `/register`: only a peer holding a
  cluster-CA certificate with `CN=backend` may ask, and the only thing it can ask for is cache
  **invalidation** — a purge can force a re-render, never inject content.
* **The shared secret rides enrollment.** `cluster.js init` mints `revalidateSecret` on the gateway and
  `/enroll` hands it to every node, so a frontend authenticates purges from **its own**
  `wordjs-config.json`, never from a backend config file on a disk it does not share.
* **Failure is a TTL fallback, never a write error.** If the gateway (or a frontend replica) can't be
  reached, publishing still succeeds and the content simply stays fresh-by-TTL — and both the backend
  (`[Purge] …`) and the gateway (`[Gateway] [Purge] …`) log it.

* **A node missing the secret repairs itself.** A cluster enrolled *before* `revalidateSecret` existed
  has a frontend with every other piece of cluster identity and no secret, so purges arrive and are
  refused (403) — permanently, and quietly. So on the boot after it registers, a frontend that has
  cluster identity but no secret asks the gateway for one over the mTLS channel it just used to
  register:

  ```
  FRONTEND ──GET /revalidate-secret (mTLS, CN=frontend)──▶ GATEWAY :3100
  ```

  The `CN=frontend` certificate **is** the authorization, exactly as `CN=backend` is the authorization
  to request a purge — a node that can present it is one `/enroll` would have handed the secret to
  anyway. The value is written into the node's own `wordjs-config.json`, so it survives restarts, and
  an existing secret is **never** overwritten. Nothing else changes: a monolith or single-host split
  has no cluster identity, so it never asks; and if the gateway cannot be reached or refuses, the node
  keeps serving TTL-fresh content and says so in its log:

  ```
  [Purge] this node has cluster identity but no revalidateSecret, and the gateway at …:3100 could not
  supply one: … — cache purges will be REFUSED (403) and content stays TTL-fresh
  ```

Monolith and single-host split are untouched: they keep purging the co-located frontend directly,
which is shorter and already instant.

> **Upgrading a cluster enrolled before this existed?** Nothing to do — restart the frontend node and
> it fetches the secret itself (`[Purge] recovered the missing revalidateSecret from the gateway…`).
> Only if that log line says it could **not** is manual action needed: copy `revalidateSecret` from
> `gateway/gateway-config.json` into the frontend's `wordjs-config.json`, or re-enroll the node per
> [Rotating / re-issuing](#rotating--re-issuing).

## What must match across nodes

| Thing | Where | Notes |
|---|---|---|
| `gatewaySecret` | all three configs | written automatically by `init`/`node-join` |
| `revalidateSecret` | gateway + every frontend | minted by `init`, handed out by `/enroll`, and re-fetched by a frontend that lacks it (`GET /revalidate-secret`, mTLS `CN=frontend`); authenticates cache purges. A mismatch means purges are refused (403) and content falls back to TTL freshness |
| cluster CA (`cluster-ca.crt`) | all three `certs/` | distributed automatically by enrollment |
| `siteUrl` | gateway + backend | its **hostname** must match the host browsers reach the gateway on, or the backend's migration guard 409s `migration_required` (scheme and port are ignored; loopback is always exempt) |
| `jwtSecret` | backend only | only needs to match if you run **multiple** backends |

The SQLite DB and `uploads/` stay on the **backend** node; the frontend reaches uploads through the
gateway, so no shared filesystem is needed for a single backend. To scale to **multiple** backends, move
to a networked driver (Postgres or MySQL/MariaDB) + a shared Redis and pin an identical `jwtSecret` — see
[multi-node.md](multi-node.md).

## The gate — verifying separate mode automatically

Everything above is manual, which is how separate mode came to be unusable without anyone noticing:
it needs three machines, so nothing exercised it. `npm run gate:separate` does exactly that, from one
command — it stands the whole topology up, verifies it, and tears it down.

```bash
npm run bundle-release          # the artifact the gate deploys
npm run gate:separate
```

It provisions three fresh Debian 12 LXC containers on the Proxmox lab (a gateway box, a backend box
and a frontend box, ids 220/221/222, cloned from a base template it builds once and reuses), deploys
the release ZIP to each, drives `cluster.js` / `node-join.js` exactly as documented above, and then
asserts the five things that are either a bug that actually happened or the property that proves the
mode:

| # | Check |
|---|---|
| 1 | **Enrollment** — the gateway is the CA (private key `0600`, gateway only), join tokens are single-use, each node holds a `CN=<role>` leaf that verifies against that CA, and the registry names the real node addresses |
| 2 | **Mutual TLS** — the internal ports refuse a request with **no** client certificate, answer one that presents the right certificate, and reject a **valid certificate of another role** claiming routes that are not its own |
| 3 | **Install** — installed *through the gateway*, the recorded public origin is the gateway and never the backend's internal address, and API calls afterwards are 200 rather than 409 `migration_required` |
| 4 | **Identity** — survives the install **and a restart**: the backend still trusts the gateway's CA, and the CA private key is not on the backend |
| 5 | **Public site** — HTML carrying `wp-block-*` classes, `/public/css/wordjs-ui.css` served 200 at its real size, plus an editor round-trip (create a page with blocks, save, read it back) |

Failure names the check that broke and what was observed. Options: `--keep` leaves the containers
running for inspection, `--teardown` destroys them, `--build` rebuilds the bundle first,
`--rebuild-base` rebuilds the base template, and `--host` / `--key` point it at a different lab.

The gate can also be pointed at itself. `--sabotage <install-host|install-identity|public-route>`
reverts one of the three fixes **in the deployed copy only** (never in the repo) and the gate must go
red on the matching check — a gate that stays green while a bug is reintroduced is worth nothing.

## Managing tokens (on the gateway)

```bash
node scripts/cluster.js tokens          # list outstanding tokens
node scripts/cluster.js token <role>    # mint a fresh one (e.g. to add/replace a node)
node scripts/cluster.js revoke-tokens   # burn them all
node scripts/cluster.js info            # CA fingerprint + endpoints
```

In an npx-scaffolded gateway these live in `wordjs-gateway/scripts/`.

## Rotating / re-issuing

The cluster CA private key lives only on the gateway. To add or replace a node later, mint a fresh token
and run `npx create-wordjs@latest join <role> …` (or `node-join` from a checkout) on that machine — no need to
touch the other nodes.
