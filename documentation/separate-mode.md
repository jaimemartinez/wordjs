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
npx create-wordjs gateway --host <gateway-ip>
```

This scaffolds `wordjs-gateway/`, initializes the cluster CA, starts the gateway, mints one
single-use token per role (2 h TTL) and prints the exact **ready-to-paste** `join` commands for the
other machines — gateway address, enroll port, token and CA fingerprint included.

**Machine 2 — backend** (paste what the gateway printed; it looks like this):

```bash
npx create-wordjs join backend --gateway <gateway-ip> --token <token> \
     --ca-hash <fingerprint> --advertise <backend-ip>
```

**Machine 3 — frontend:**

```bash
npx create-wordjs join frontend --gateway <gateway-ip> --token <token> \
     --ca-hash <fingerprint> --advertise <frontend-ip>
```

Each `join` downloads the release into `wordjs-<role>/`, generates a keypair + CSR, enrolls against
the gateway (writes `certs/*` and the node's `wordjs-config.json`), installs dependencies, then starts
the service, which registers with the gateway over mTLS. Startup logs land in
`wordjs-<role>/<role>/cluster-start.log`.

Options: `--enroll-port <port>` if you changed the default `3101`; `--no-start` to scaffold + enroll
without starting; `[dir]` after the subcommand to pick the target directory.

Then jump to [Verify](#verify).

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
backend through the gateway) and `/api`, `/uploads`, `/themes` to the backend.

## What must match across nodes

| Thing | Where | Notes |
|---|---|---|
| `gatewaySecret` | all three configs | written automatically by `init`/`node-join` |
| cluster CA (`cluster-ca.crt`) | all three `certs/` | distributed automatically by enrollment |
| `siteUrl` | gateway + backend | must equal the gateway's public origin or the migration guard 409s |
| `jwtSecret` | backend only | only needs to match if you run **multiple** backends |

The SQLite DB and `uploads/` stay on the **backend** node; the frontend reaches uploads through the
gateway, so no shared filesystem is needed for a single backend. To scale to **multiple** backends, move
to the Postgres driver + a shared Redis and pin an identical `jwtSecret` — see
[multi-node.md](multi-node.md).

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
and run `npx create-wordjs join <role> …` (or `node-join` from a checkout) on that machine — no need to
touch the other nodes.
