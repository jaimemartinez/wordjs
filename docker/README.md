# WordJS in containers

This directory's `entrypoint.sh`, the root `Dockerfile`, and the root `docker-compose.yml` package the
**existing** WordJS runtime as a container image and a realistic multi-service stack. Nothing here
invents a new runtime — the image runs the same compiled build (`backend/dist` + frontend `.next`)
that `scripts/make-release.js` produces and the installer expects, launched via `monolith.js prod`
(single process, one HTTP port).

## Image (`Dockerfile`)

Multi-stage:

1. **builder** — installs every workspace and runs `npm run bundle-release`, i.e. the exact artifact
   `make-release.js` bundles: `next build`, backend `tsc -> dist`, and plugin bundles, copied into a
   clean `release/wordjs-package` tree (no `node_modules`, no dev/local/secret files).
2. **runtime** — slim, **non-root** (`wordjs`, uid 1001), `tini` as PID 1 for clean signal handling.
   Copies the compiled tree and runs `npm run release:install` (`--omit=dev`, so `ts-node`/`typescript`
   are absent) — the app runs the **compiled dist**, never TypeScript. A `HEALTHCHECK` polls
   **`/readyz`**, which returns 200 only once the app is installed, booted, and the database answers.

Because the app reads its **database** settings from `backend/wordjs-config.json` (only Redis + a few
flags are environment-read), `entrypoint.sh` materializes that file from environment variables on first
boot (idempotent; a pre-existing/mounted config is never overwritten). Writing `dbDriver` marks the app
installed, so `/readyz` can go green without the interactive wizard.

> **Password gotcha (real, load-bearing):** `backend/src/config/app.ts` regenerates and persists a
> random `dbPassword` when the flat key is missing **or literally `"password"`**, and a random
> `jwtSecret` when it is missing or the placeholder. On multi-node that hands each replica a *different*
> secret and breaks both the shared-Postgres login and cross-node token validation. The entrypoint
> therefore always writes concrete values — supply `WORDJS_DB_PASSWORD` and `WORDJS_JWT_SECRET`
> (identical on every replica, and **not** `"password"`) via the environment.

### Environment variables the entrypoint reads

| Variable | Default | Purpose |
|---|---|---|
| `WORDJS_DB_DRIVER` | `sqlite-native` | `postgres` for multi-node |
| `WORDJS_DB_HOST` / `WORDJS_DB_PORT` | `localhost` / `5432` | shared Postgres address |
| `WORDJS_DB_USER` / `WORDJS_DB_NAME` | `postgres` / `wordjs` | Postgres role + database |
| `WORDJS_DB_PASSWORD` | `wordjs` | **must not be `password`** (see gotcha) |
| `WORDJS_JWT_SECRET` | dev placeholder | **share across replicas** |
| `WORDJS_REDIS_ENABLED` | `false` | `true` turns on cross-node coherence |
| `WORDJS_REDIS_HOST` / `WORDJS_REDIS_PORT` | `127.0.0.1` / `6379` | shared Redis |
| `WORDJS_SITE_URL` | `http://localhost:3000` | public origin |
| `PORT` | `3000` | public HTTP port inside the container |

## Stack (`docker-compose.yml`)

`docker compose up --build` brings up **Postgres 16 + Redis 7 + two app replicas** (`app`, `app2`) that
share the same Postgres, the same Redis, and the same `jwtSecret` — two nodes of the horizontally-scaled
backend tier from [`documentation/multi-node.md`](../documentation/multi-node.md). Browse `app` on
`http://localhost:3000` and `app2` on `http://localhost:3001`.

### What this stack PROVES

- A working, browsable multi-service WordJS backed by external Postgres + Redis.
- **Cross-node coherence**: an option / role / capability change on one node is published over Redis
  (`wordjs:option-changed`) and reflected on the other without a restart, and concurrent first-boot is
  serialized by the Redis boot lease so schema migration + seeding run exactly once. (This is the
  property the CI `multinode` job asserts directly and deterministically — see below.)

### What this stack does NOT prove (honest limits)

- **No gateway / load balancer** sits in front, so it does not exercise gateway round-robin or the
  **mTLS node-enrollment** path (`scripts/node-join.js`, `scripts/cluster.js`). Each replica is reached
  on its own port. That is deliberate: the coherence bus lives entirely in the **backend core**, which
  *is* replicated here, so the multi-node property is covered; the gateway/mTLS layer adds transport and
  routing, not coherence. A production N-replica deployment still puts the gateway (or your own LB) in
  front — see `documentation/multi-node.md` and `documentation/separate-mode.md`.
- **Shared filesystem is only partially modeled.** A shared volume is mounted at `backend/uploads` so a
  file written by one node is visible to the other, but `themes/`, `plugins/`, `backups/`, `public/`
  and `ssl/` are **not** shared in this compose. A real N-replica deploy must mount all of them per
  `multi-node.md`; until then, plugin-activation fan-out across nodes is not representative here.
- **TLS is terminated as plain HTTP** inside the containers (`WORDJS_HTTP=1`). Put a reverse proxy
  (Nginx/Caddy/Cloudflare) or the built-in gateway HTTPS in front for a real deployment.

## CI coverage

The `multinode` job in `.github/workflows/ci.yml` runs the coherence property as a fast, deterministic
test instead of booting the full two-container stack on every PR: `npm run test:multinode` forks a
**second OS process** (`backend/src/tests-integration/multinode-peer.ts`) that shares the job's Postgres
16 + Redis 7, then asserts that an option written on node A is read back — as node A's exact,
freshly-random value — by node B through the shared infrastructure. Break the publish, the DB sharing,
or the cache invalidation and node B never observes it, so the job goes red. The same job also
`docker compose config`-validates this stack. Building and booting the two-container compose is left out
of the per-PR budget on purpose; it is a manual/local check (`docker compose up --build`).
