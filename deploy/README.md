# deploy/

Ready-to-run deployment templates. Both run the **monolith** — one process serving gateway concerns, the
backend API and the Next.js frontend on a single HTTP port — from the image built by the repository's
root `Dockerfile`.

| | |
|---|---|
| [`compose/`](compose) | One-click Docker Compose: a single container, SQLite, two volumes. Three commands from nothing to the setup wizard |
| [`helm/wordjs/`](helm/wordjs) | A minimal Helm chart: one pod, two PVCs, optional ingress. Monolith only, `replicaCount` pinned to 1 |

Neither terminates TLS: the container serves plain HTTP (`WORDJS_HTTP=1`) and expects a reverse proxy or
ingress in front.

## Not here

- **The multi-node stack** — Postgres + Redis + two replicas demonstrating cross-node coherence — is the
  compose file at the **repository root**. It is a different artifact answering a different question,
  and because a second replica can only join a site that is already installed, it comes up pre-installed
  and cannot be logged into. See `docker/README.md` for what it does and does not prove.
- **Horizontal scaling in general.** An external database, Redis, and the shared `themes/`, `plugins/`,
  `backups/`, `public/`, `ssl/` mounts are described in `documentation/multi-node.md`.
- **Split and separate modes** (gateway + backend + frontend as distinct services, optionally on
  distinct machines) are documented in `documentation/deployment.md` and
  `documentation/separate-mode.md`. Neither has a container template here.
