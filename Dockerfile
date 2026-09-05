# syntax=docker/dockerfile:1
#
# WordJS — production image.
#
# Multi-stage: the BUILDER compiles the exact same artifact `scripts/make-release.js` bundles (frontend
# `next build`, backend `tsc -> dist`, plugin bundles), then the RUNTIME stage installs ONLY production
# dependencies (`--omit=dev`, so ts-node is absent) and runs the COMPILED build. `backend/server.js` and
# `monolith.js` both prefer `backend/dist/index.js` when present, so no TypeScript is transpiled at
# runtime — this packages the existing runtime, it does not invent one.
#
# Default command is the single-process "monolith" (gateway concerns + backend + Next.js frontend on one
# HTTP port), which is the simplest working WordJS. See docker-compose.yml for a Postgres + Redis +
# multi-replica stack, and docker/README.md for what that does and does not prove.
#
# A fresh container boots UNINSTALLED and serves the setup wizard at /install — see docker/entrypoint.sh
# for why that is the default and how to opt out. Ready-to-run templates live in deploy/: a one-click
# single-container compose (deploy/compose) and a monolith-only Helm chart (deploy/helm/wordjs).

# ---------------------------------------------------------------------------------------------------
# Stage 1 — builder: full toolchain, all workspaces, produce the compiled release tree.
# ---------------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

# Toolchain for any dependency that lacks a prebuilt binary for this platform (e.g. better-sqlite3
# falls back to node-gyp). Present ONLY in the builder — never shipped in the runtime image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Copy the whole repo (respecting .dockerignore) and install every workspace, then build the release.
# make-release.js builds frontend + backend(dist) + plugin bundles and copies a clean tree (no
# node_modules, no dev/local/secret files) into release/wordjs-package — that directory IS the artifact
# the installer expects, so we copy straight from it in the runtime stage (no zip round-trip needed).
COPY . .
RUN npm run install:all
RUN npm run bundle-release

# ---------------------------------------------------------------------------------------------------
# Stage 2 — runtime: slim, non-root, production dependencies only, runs the compiled build.
# ---------------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# tini for correct PID-1 signal handling (clean SIGTERM shutdown of the Node process + its plugin forks).
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 wordjs \
    && useradd --system --uid 1001 --gid wordjs --home-dir /app --shell /usr/sbin/nologin wordjs

WORKDIR /app

# The compiled, pre-pruned application tree (frontend .next, backend dist, plugin bundles, gateway).
COPY --from=builder /src/release/wordjs-package /app
COPY docker/entrypoint.sh /usr/local/bin/wordjs-entrypoint
RUN chmod +x /usr/local/bin/wordjs-entrypoint

# Production dependencies only: `--omit=dev` prunes ts-node/typescript. The monolith/backend run the
# compiled dist, so nothing needs them at runtime. better-sqlite3 normally installs a prebuilt binary,
# but if none matches this platform it falls back to node-gyp — so install a compiler TRANSIENTLY for
# the install and purge it in the SAME layer, keeping the runtime image slim.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends python3 make g++; \
    npm run release:install; \
    npm cache clean --force; \
    apt-get purge -y python3 make g++; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p /app/backend/data /app/backend/uploads; \
    chown -R wordjs:wordjs /app

# The two paths that hold state the image must NOT own. monolith.js chdir()s into backend/ and the
# runtime resolves both relative to that cwd, so these are the exact paths a volume has to cover:
#   backend/data     SQLite database, the 0600 install-token mirror, and — because the entrypoint
#                    anchors it here with a symlink — wordjs-config.json, i.e. the install state itself.
#   backend/uploads  the media library.
# Declared AFTER the chown above so the mount inherits wordjs-owned, writable directories (content added
# to a VOLUME path by a LATER layer would be discarded). compose/Helm mount named volumes / a PVC over
# these; a bare `docker run` gets anonymous volumes and still keeps its data across a container restart.
VOLUME ["/app/backend/data", "/app/backend/uploads"]

# HTTP on the public port inside the container — terminate TLS at a reverse proxy / the compose network.
# WORDJS_HTTP=1 makes monolith.js serve plain HTTP instead of resolving a TLS certificate, so the port is
# probe-able with no cert handling and the container never generates or renews a self-signed cert. Unset
# it only if you mount real certificates and want the container itself to terminate TLS.
ENV NODE_ENV=production \
    WORDJS_HTTP=1 \
    PORT=3000

EXPOSE 3000

# LIVENESS, not readiness. /healthz is answered directly by monolith.js's dispatcher (before the backend
# app), so it reports "this process is serving" even while the site is still uninstalled — which is the
# question Docker actually asks: should this container be restarted?
#
# It deliberately is NOT /readyz. /readyz returns 503 until the instance is installed AND booted AND the
# database answers, so a fresh container awaiting the setup wizard would sit `unhealthy` forever and any
# `depends_on: condition: service_healthy` would never fire — the one-click flow could not start. /readyz
# is the right probe for an orchestrator that must hold traffic off a not-yet-ready replica, and that is
# exactly where deploy/helm/wordjs uses it: livenessProbe /healthz, readinessProbe /readyz.
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=6 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

USER wordjs

# tini (PID 1) -> entrypoint (anchors the config in the data volume; pre-seeds it from env only when
# WORDJS_PRESEED_CONFIG=1) -> the app command.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/wordjs-entrypoint"]
CMD ["node", "monolith.js", "prod"]
