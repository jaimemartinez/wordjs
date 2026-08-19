# Running WordJS multi-node (horizontal scaling)

WordJS can run as **N backend replicas behind one gateway**, behind a load balancer, against shared
infrastructure. This guide covers what's required and how the pieces coordinate.

> Single-host deployments need none of this — with the SQLite driver every coordination primitive
> below is a no-op, and one backend + one gateway just works. Multi-node is opt-in.

> **"Three machines" ≠ "this guide."** Running the gateway, **one** backend, and **one** frontend on
> **separate machines** (one replica per role) does **not** need Postgres, Redis, or a shared
> filesystem — SQLite stays on the single backend node and the frontend reaches its uploads through the
> gateway. That is **SEPARATE mode**; use the join-token walkthrough in
> **[separate-mode.md](separate-mode.md)** and stop there. **This** guide is for the next step:
> scaling **one role to N replicas** (e.g. 3 backends), which is what forces the shared network
> database (Postgres or MySQL) + Redis + filesystem below.

## Topology

```
            ┌────────────┐
   clients →│  gateway   │  (one node — terminates TLS, round-robins to backends)
            └─────┬──────┘
        ┌─────────┼──────────┐
   ┌────▼───┐ ┌───▼────┐ ┌───▼────┐
   │backend │ │backend │ │backend │   (N replicas — stateless app tier)
   └────┬───┘ └───┬────┘ └───┬────┘
        └─────────┼──────────┘
        ┌─────────┼──────────┬───────────────┐
   ┌────▼────┐ ┌──▼───┐ ┌────▼─────┐  shared infrastructure
   │ Postgres│ │ Redis│ │ shared FS│
   └─────────┘ └──────┘ └──────────┘
```

The frontend (Next.js SSR) is stateless and can also be replicated; point its upstream at the gateway
as usual.

## Hard requirements

Running **multiple replicas of a role** requires all three shared backends. Without them, replicas
diverge. (A single-replica-per-role split across machines needs none of them — see the callout above.)

| Requirement | Why | How |
|---|---|---|
| **A shared network database** | SQLite is a single-host file; every node must share one database. | Set `dbDriver: "postgres"` (recommended) **or** `"mysql"` + `db: { host, port, user, password, name }` in `wordjs-config.json` and point every node at the SAME server. Both engines carry a real distributed lease lock — see below. |
| **Shared Redis** | Cross-node cache coherence, shared rate limiting, and realtime (SSE) fan-out. | Set `redis: { "enabled": true, host, port, password }` identically on every node, all pointing at ONE Redis. (`db` selects the Redis database index; it defaults to `0`.) |
| **Shared filesystem** | Uploads, themes, plugins, backups, ACME challenge files and certs are written to local disk. | Mount shared storage (NFS / EFS / SMB) at the backend's `uploads/`, `themes/`, `plugins/`, `backups/`, `public/` and `ssl/` directories on every node (see below). |

### Shared filesystem mount points

Mount the same shared volume at these paths on every backend node (paths are relative to the backend
working directory):

- `backend/uploads/` — media + fonts (`config.uploads.dir`)
- `backend/themes/` — installed themes
- `backend/plugins/` — installed plugin code
- `backend/backups/` — backup archives. After every backup only the newest `backup_retention` archives
  are kept (default 7; set `0` to keep all), so scheduled backups on the shared volume cannot fill the
  disk. Backups are still on-host — off-host/S3 storage remains on the roadmap.
- `backend/public/` — **including `public/.well-known/acme-challenge/`** so an ACME HTTP-01 token
  written by the renewing node is visible to whichever node answers the validation request
- `backend/ssl/` and `backend/data/ssl/` — issued certs + the ACME account key

A file uploaded to node A must be readable by node B (the load balancer routes the later `GET` anywhere).
Sticky sessions do **not** substitute for shared storage — a different visitor's request still lands on
a node without the file.

## Per-node configuration

Each node shares the same `wordjs-config.json` EXCEPT `advertiseHost`, which must be the address the
gateway uses to reach that specific node:

```jsonc
{
  "dbDriver": "postgres",
  "db": { "host": "db.internal", "port": 5432, "user": "wordjs", "password": "…", "name": "wordjs" },
  "redis": { "enabled": true, "host": "redis.internal", "port": 6379, "password": "…" },
  "advertiseHost": "10.0.1.23",      // THIS node's routable IP/DNS (NOT 127.0.0.1)
  "gatewayHost": "gateway.internal", // where to register
  "siteUrl": "https://example.com"
}
```

Each backend registers `https://<advertiseHost>:<port>` with the gateway; the gateway keeps all
registered backends in its route group and round-robins across them. (`advertiseHost` defaults to
`127.0.0.1`, which is correct only when the gateway and backend are co-located.)

> ⚠️ **Set the database password as the flat `dbPassword` key, not only inside `db`.** The config
> normalizer resolves it as `dbPassword || db.password`, and on boot it **generates and persists a
> random `dbPassword`** whenever that flat key is missing — which would then shadow the `db.password`
> shown above and break every replica's connection to the shared Postgres. Add
> `"dbPassword": "…"` alongside the `db` block (or set both to the same value) on every node. See
> [database.md §1.6](database.md#16-configuration).

> The `advertiseHost` / `gatewayHost` / `gatewaySecret` / mTLS-cert plumbing per node is written for you
> by `scripts/node-join.js` when you enroll each node with a join token (**[separate-mode.md](separate-mode.md)**).
> For an N-replica role, run `node scripts/cluster.js token <backend|frontend>` + `node-join` once **per
> replica** (each with its own `--advertise`), then layer the shared Postgres/Redis and `jwtSecret` from
> this guide onto every replica's `wordjs-config.json`.

## Pinning a frontend replica to a backend — `WORDJS_BACKEND_URL`

Normally you do **not** need this. The browser only ever calls the **relative** `/api/v1`
(`frontend/src/lib/api.ts` — including the collaboration `EventSource`), and in the standard topology
the gateway is the front door: it answers the public origin, sends `/api` to a backend and everything
else to a frontend, so a frontend replica never has to know a backend address at all.

You need it when a frontend replica is reached **directly** — no gateway in front of it, or an L7 load
balancer that routes to frontends and lets them reach the API themselves. Then `/api/v1` lands on the
frontend's own port and the frontend has to forward it. Which upstream it forwards to used to be
readable only from `wordjs-config.json` (`gatewayPort` → `https://localhost:<port>`), i.e. from a file
that is otherwise **identical on every replica** — so N frontends could not each be pointed at a
different backend without editing N config files. Set the environment variable instead:

```bash
# frontend replica A
WORDJS_BACKEND_URL=http://10.0.1.23:4000 npm start
# frontend replica B
WORDJS_BACKEND_URL=http://10.0.1.24:4000 npm start
```

**Precedence** (strongest first), resolved in `frontend/backend-proxy-target.js`:

| # | Source | Value |
|---|---|---|
| 1 | `WORDJS_BACKEND_URL` | used as given (validated + canonicalised) |
| 2 | `wordjs-config.json` → `gatewayPort` | `https://localhost:<gatewayPort>` |
| 3 | compiled-in default | `http://localhost:3000` |

Empty or unset means "no opinion" and falls through to 2. A value that is **not** a usable origin
(bad scheme, credentials, a query string, an out-of-range port…) **fails the boot** with a message
naming the variable and the value — it is never silently replaced by `localhost`, because that would
send a replica's editors, and their live collaboration stream, to the wrong node with nothing in the
logs pointing back at the typo.

**It works on the pre-compiled release, and that is not free.** Next resolves `next.config.ts`'s
`rewrites()` **once, during `next build`**, and freezes the result into
`.next/routes-manifest.json`; `next start` reads that file and never calls the config again. An env
var honoured only by `next.config.ts` would therefore work in `next dev` and in a build from source
and do **nothing at all** on the release ZIP, which ships a prebuilt `.next` — precisely the artifact
you deploy to N nodes. So `frontend/server.js` applies the same resolution **at runtime**: when
`WORDJS_BACKEND_URL` is set it proxies `/api/*` and `/uploads/*` itself, ahead of Next, mirroring
what Next's own rewrite proxy sends (upstream `Host` = the target, caller's host preserved in
`x-forwarded-host`) so the backend's CSRF/Origin and host guards see exactly what they saw before.
Streaming is passed straight through, which is what keeps the collaboration SSE channel live.

Set it at **build** time as well if you build from source and want the baked rewrite to agree.

Two knock-on settings when a frontend is reached directly rather than through the gateway:

- **`siteUrl`** on the backend that replica talks to must be the origin the **browser** uses
  (e.g. `http://10.0.1.23:3001`), or the backend's same-origin CSRF check rejects every POST —
  including every collaboration op.
- **`internalApiUrl`** / **`INTERNAL_API_URL`** points **server-side rendering** at the same backend
  (`http://10.0.1.23:4000/api/v1`). `WORDJS_BACKEND_URL` covers the browser's path; SSR has its own
  resolution (see [frontend.md](frontend.md)). Set both, to the same backend.

### Real-time collaboration across replicas

Collaborative editing (CRDT over SSE + POST) is cluster-aware: ops are persisted in the shared
network database and fanned out between nodes over Redis, so two authors editing the same page through
two different backends converge. Both requirements above apply — it is the shared **database** that
makes the ops durable and the shared **Redis** that makes the other node hear about them. With Redis down,
cross-node fan-out degrades **visibly** (the editors are told) and nothing is written silently into a
void; when Redis returns, the bus reconnects and fan-out resumes without restarting the nodes.

## How coordination works (automatic)

- **Concurrent boot** — the first replica to boot takes a distributed lease lock (`wordjs:boot`) and
  runs schema migrations + default seeding; the others wait, then find everything seeded and no-op. No
  duplicate admin/category rows, no double-applied migrations.
- **Scheduled jobs** — cron runs on every node, but each tick is gated by a leader lease
  (`wordjs:cron`), so a due job (backup, ACME renewal, plugin job) executes on exactly **one** node.
  This is what keeps Let's Encrypt renewal from firing N concurrent orders.
- **Role/permission edits** — propagated across nodes over Redis (`wordjs:option-changed`), so a
  capability change on one node is reflected everywhere without a restart.
- **In-process (L1) cache invalidation** — every node keeps a small in-process cache in front of
  Redis, so a write must drop it on the *peers* too: `cache.del()`/`cache.flush()` broadcast the key
  (or `'*'`) on `wordjs:cache-del` and each node evicts its own L1. When Redis is configured, L1
  entries additionally self-expire within **30s** as the bound on any missed broadcast.
- **Plugin activate/deactivate** — the handling node writes the active set under the
  `wordjs:active-plugins` lock and publishes `wordjs:plugin-changed`; every other node loads/unloads
  that one isolated plugin **live** (forked child + routes/hooks/menus) via `coherence.ts` →
  `plugins.loadOnePlugin`/`unloadOnePlugin`, skipping its own publish. No rolling restart needed.
- **Realtime notifications (SSE)** — published over Redis (`wordjs:notify`) and re-broadcast by every
  node to its own connected clients, so a notification reaches a user regardless of which node holds
  their stream. Notifications are also persisted, so a brief Redis hiccup degrades to "appears on next
  load," never lost.
- **Rate limits** — backed by the shared Redis store, so caps are enforced globally instead of
  per-node (N× looser).
- **Frontend cache purge (N frontend replicas)** — on publish the backend asks the **gateway** to
  purge, over the internal mTLS channel (`POST /purge`, `CN=backend`), and the gateway fans the
  `{ tags, paths }` out to **every** frontend it has registered. Next.js caches are per-process, so a
  purge that reached only one replica would leave the others serving stale HTML until their ISR window
  expired; routing it through the registry is what makes "instant publish" hold at N > 1. Nodes that
  cannot be reached fall back to TTL freshness and are logged, never failing the write. See
  [separate-mode.md](separate-mode.md#cache-purge-across-machines--instant-via-the-gateway).

The lease locks are DB-clock based (immune to node clock skew) and auto-expire, so a crashed node never
deadlocks the cluster.

> All of the pub/sub above is gated on Redis being **configured**, independently of the admin's object-cache
> master switch (the `redis_cache_enabled` option). Turning the object cache off disables the Redis
> *caching* tier only — coherence, plugin propagation, SSE fan-out and the shared rate-limit store
> keep working, because a cluster must stay coherent whether or not it is caching.

### Which databases the lease lock actually covers

`backend/src/core/dist-lock.ts` classifies the active driver into **three** answers, not two:

| Driver | Behaviour |
|---|---|
| `postgres`, `mysql` (incl. MariaDB) | A **real** lease: a `wordjs_locks` row claimed by an atomic compare-and-set, expiry computed **server-side** so every node reads one clock. Only the clock expression differs between the two engines. |
| `sqlite` | No-op that grants — a single file on a single host has no cross-process contention, so single-node behaviour is unchanged. |
| anything else | **Fails closed.** `acquireBlocking` returns `{ held: false }` and `runAsLeader` skips, both with a warning naming the lock. |

This distinction is the point. The lock originally gated on "is this Postgres?" and answered *granted*
to everything else, on the reasoning that non-Postgres meant SQLite and therefore a single host. Once a
MySQL driver existed that reasoning was answering the **wrong question**: "not Postgres" was being read
as "no lock needed" when the truth was "the lock is not implemented here". On `dbDriver: "mysql"` with
two replicas, the silent grant meant both nodes ran migrations and seeding simultaneously, cron fired on
every node (duplicate backups, N concurrent Let's Encrypt orders — enough to get the domain
rate-limited), and every `active_plugins` read-modify-write could lose an update. Nothing logged.

An engine with no implementation now refuses rather than lies: a boot that cannot take `wordjs:boot`
stops instead of double-seeding, and cron simply does not run. **A refusal is recoverable; a false grant
corrupts the database.** Note that the driver family is read from the driver name — not from
`getDbType().isSQLite`, which is defined as `!isPostgres` and is therefore *true* for MySQL. Asking that
flag is exactly how "not Postgres" became "single host" in the first place.

## TLS / ACME (one gateway)

The gateway terminates TLS. The cron leader runs ACME renewal and pushes the renewed certificate to the
gateway over the internal mTLS channel; the gateway loads it by restarting its workers. For HTTP-01 validation to succeed,
the challenge must be reachable on port 80 — either:

- set `acme.http01Port: 80` so the gateway serves `/.well-known/acme-challenge/` (from the shared
  `public/` webroot) and redirects the rest to HTTPS, or
- front the site with a reverse proxy that forwards port 80 `/.well-known/acme-challenge/` to the
  gateway.

ACME auto-renewal works in **both** deployment modes — see `documentation/deployment.md`. In split
(gateway) mode the cron leader pushes the renewed cert to the gateway over the internal mTLS channel; in
embedded/monolith mode `cert-manager` installs it in-process (writes the cert files **and** hot-reloads
the running HTTPS server via `setSecureContext`, no restart). Either way it needs the opt-in HTTP-01
listener (`acme.http01Port`, e.g. 80) reachable so the challenge can be validated.

## Load balancer

Point your L4/L7 load balancer at the gateway. Health probes (added for orchestration):

- `GET /healthz` — liveness (always 200 while the process is up; answered by the gateway directly).
- `GET /readyz` — readiness (200 only when installed, booted and the DB is reachable; 503 otherwise) —
  use this as the LB's "in rotation" check so traffic isn't sent to a node that's still migrating.

### Metrics

- `GET /metrics` — Prometheus scrape endpoint (default Node/process metrics plus a `wordjs_sse_clients`
  gauge per node). It is **disabled (returns 404)** unless a scrape token is configured at
  `config.metrics.token` (or the `METRICS_TOKEN` env), and is **never exposed without a token**. Scrape
  with `Authorization: Bearer <token>`. The route is part of each backend's registered route group, so
  the gateway round-robins to it like any other backend route (and it is served directly in monolith
  mode); each node reports its own SSE client count.

## Known limitations

- **No cross-node roles-coherence epoch yet (DATA-COH-01, deferred).** The Redis
  `wordjs:option-changed` pub/sub *does* propagate role/capability edits live, and a same-node
  local-write epoch stops a stale background TTL refresh from clobbering a just-applied local edit.
  But there is no **cross-node** epoch: if Redis drops a publish, a lagging replica corrects itself
  only via the in-process roles-cache TTL self-heal fallback — a missed cross-node revocation is
  bounded by that TTL (`ROLES_CACHE_TTL_MS`, **10s**, in `core/roles.ts`), the fail-open direction,
  not corrected instantly. Strengthening this into a cross-node coherence epoch is on the roadmap.
- **Residual multi-node lost-update edges.** The `active_plugins` read-modify-write **is** serialized
  across nodes (best-effort, under the `wordjs:active-plugins` distributed lock), but general
  concurrent option/row writes across nodes are not yet fully guarded against lost updates.
- The **service registry and certificate live on the single gateway**; running multiple active-active
  gateway nodes would additionally require registry replication and cross-gateway cert distribution,
  which this topology intentionally avoids.
