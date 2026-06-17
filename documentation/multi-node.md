# Running WordJS multi-node (horizontal scaling)

WordJS can run as **N backend replicas behind one gateway**, behind a load balancer, against shared
infrastructure. This guide covers what's required and how the pieces coordinate.

> Single-host deployments need none of this — with the SQLite driver every coordination primitive
> below is a no-op, and one backend + one gateway just works. Multi-node is opt-in.

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

Multi-node requires all three shared backends. Without them, replicas diverge.

| Requirement | Why | How |
|---|---|---|
| **External PostgreSQL** | SQLite is a single-host file; `embedded-postgres` is single-host too. | Set `dbDriver: "postgres"` + `db: { host, port, user, password, name }` in `wordjs-config.json` and point every node at the SAME server. |
| **Shared Redis** | Cross-node cache coherence, shared rate limiting, and realtime (SSE) fan-out. | Set `redis: { "enabled": true, host, port, password }` identically on every node, all pointing at ONE Redis. |
| **Shared filesystem** | Uploads, themes, plugins, backups, ACME challenge files and certs are written to local disk. | Mount shared storage (NFS / EFS / SMB) at the backend's `uploads/`, `themes/`, `plugins/`, `backups/`, `public/` and `ssl/` directories on every node (see below). |

### Shared filesystem mount points

Mount the same shared volume at these paths on every backend node (paths are relative to the backend
working directory):

- `backend/uploads/` — media + fonts (`config.uploads.dir`)
- `backend/themes/` — installed themes
- `backend/plugins/` — installed plugin code
- `backend/backups/` — backup archives
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

## How coordination works (automatic)

- **Concurrent boot** — the first replica to boot takes a distributed lease lock (`wordjs:boot`) and
  runs schema migrations + default seeding; the others wait, then find everything seeded and no-op. No
  duplicate admin/category rows, no double-applied migrations.
- **Scheduled jobs** — cron runs on every node, but each tick is gated by a leader lease
  (`wordjs:cron`), so a due job (backup, ACME renewal, plugin job) executes on exactly **one** node.
  This is what keeps Let's Encrypt renewal from firing N concurrent orders.
- **Role/permission edits** — propagated across nodes over Redis (`wordjs:option-changed`), so a
  capability change on one node is reflected everywhere without a restart.
- **Realtime notifications (SSE)** — published over Redis (`wordjs:notify`) and re-broadcast by every
  node to its own connected clients, so a notification reaches a user regardless of which node holds
  their stream. Notifications are also persisted, so a brief Redis hiccup degrades to "appears on next
  load," never lost.
- **Rate limits** — backed by the shared Redis store, so caps are enforced globally instead of
  per-node (N× looser).

The lease locks are DB-clock based (immune to node clock skew) and auto-expire, so a crashed node never
deadlocks the cluster.

## TLS / ACME (one gateway)

The gateway terminates TLS. The cron leader runs ACME renewal and pushes the renewed certificate to the
gateway over the internal mTLS channel; the gateway hot-reloads it. For HTTP-01 validation to succeed,
the challenge must be reachable on port 80 — either:

- set `acme.http01Port: 80` so the gateway serves `/.well-known/acme-challenge/` (from the shared
  `public/` webroot) and redirects the rest to HTTPS, or
- front the site with a reverse proxy that forwards port 80 `/.well-known/acme-challenge/` to the
  gateway.

ACME auto-renewal runs in split (gateway) mode only — see `documentation/deployment.md`.

## Load balancer

Point your L4/L7 load balancer at the gateway. Health probes (added for orchestration):

- `GET /healthz` — liveness (always 200 while the process is up; answered by the gateway directly).
- `GET /readyz` — readiness (200 only when installed, booted and the DB is reachable; 503 otherwise) —
  use this as the LB's "in rotation" check so traffic isn't sent to a node that's still migrating.

## Known limitations

- **Plugin activate/deactivate** changes plugin code/worker state in-process on the handling node and
  the active set in the DB. Other nodes do not hot-reload plugin workers live — do a **rolling restart**
  to propagate a plugin activation/deactivation across the cluster. (Role/capability and option changes
  do propagate live.)
- The **service registry and certificate live on the single gateway**; running multiple active-active
  gateway nodes would additionally require registry replication and cross-gateway cert distribution,
  which this topology intentionally avoids.
