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
    chown -R wordjs:wordjs /app

# HTTP on the public port inside the container — terminate TLS at a reverse proxy / the compose network.
# (WORDJS_HTTP=1 makes monolith.js serve plain HTTP so the healthcheck below needs no cert handling.)
ENV NODE_ENV=production \
    WORDJS_HTTP=1 \
    PORT=3000

EXPOSE 3000

# Readiness probe: /readyz returns 200 only once the app is installed, booted, AND the database answers
# (503 otherwise). Long start-period covers the first-boot schema migration + plugin isolate startup.
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=6 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

USER wordjs

# tini (PID 1) -> entrypoint (writes wordjs-config.json from env if absent) -> the app command.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/wordjs-entrypoint"]
CMD ["node", "monolith.js", "prod"]
