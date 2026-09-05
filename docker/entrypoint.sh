#!/bin/sh
# WordJS container entrypoint.
#
# Two jobs, both about WHERE the install state lives:
#
#   1. Anchor `backend/wordjs-config.json` INSIDE the data volume (via a symlink), so an installed site
#      survives `docker compose down && up` — a recreated container gets a fresh writable layer, and
#      without this the config the wizard wrote would be gone while its database was still there.
#   2. OPTIONALLY materialize that config from environment variables, for deployments that must come up
#      already installed (an external Postgres/MySQL, or a second replica joining a site that another
#      replica installed). This is OPT-IN — see WORDJS_PRESEED_CONFIG below.
#
# WHY OPT-IN (this is the whole point): `core/configManager.isInstalled()` keys off `installedAt ||
# dbDriver`, so ANY config written here marks the instance INSTALLED — and `POST /api/v1/setup/install`
# early-returns `400 Already installed`. An unconditionally pre-seeded container therefore boots as a
# site that can never be installed: no administrator is ever created (the CMS bootstrap deliberately
# seeds none — see scripts/smoke-deploy.sh's enrollment leg) and nobody can log in. So the DEFAULT is to
# write nothing and let the instance boot into SETUP MODE, mint an install token, and serve /install.
set -e

BACKEND_DIR="/app/backend"
DATA_DIR="$BACKEND_DIR/data"
CONFIG="$BACKEND_DIR/wordjs-config.json"
# The real file lives in the data volume; $CONFIG is a symlink to it (see below).
PERSISTED_CONFIG="$DATA_DIR/wordjs-config.json"

# The runtime resolves data/, uploads/ and wordjs-config.json relative to its cwd, and monolith.js
# chdir()s into backend/ — so these are the paths a volume must cover. Create them before anything
# writes, so a fresh container without mounts behaves the same as one with them.
mkdir -p "$DATA_DIR" "$BACKEND_DIR/uploads"

# ── 1. Anchor the config in the data volume ──────────────────────────────────────────────────────────
# A REGULAR file at $CONFIG (baked into an image, or bind-mounted by the operator) is authoritative and
# left alone. Otherwise point $CONFIG at the volume. The symlink may dangle: `configManager` stats the
# path (fs.statSync throws on a dangling link) so a dangling link reads as "no config" => SETUP MODE,
# which is exactly right on a first boot. Every writer of this file (configManager.saveConfig,
# config/app.ts's secret regeneration) uses a plain fs.writeFileSync — no atomic rename — so the write
# FOLLOWS the symlink and lands in the volume instead of replacing the link.
#
# THE DIRECTORY CASE IS NOT HYPOTHETICAL, AND IT IS THE ONE THAT FAILS SILENTLY. `docker run -v
# /host/path/that/does/not/exist:/app/backend/wordjs-config.json` (or the same thing as a compose
# `volumes:` entry — the usual typo when an operator means to bind-mount the config) makes the daemon
# create a DIRECTORY at that path. Without the arm below, `-f` is false and `! -L` is true, so we would
# reach `ln -s TARGET DIR` — which does NOT fail: it creates DIR/wordjs-config.json INSIDE the directory
# and exits 0. `set -e` never fires, nothing looks wrong, and configManager then stats a directory and
# reads "no config". The container boots into setup mode, the operator completes the wizard, the install
# state is written somewhere nothing will look for it, and every restart re-offers the wizard on top of a
# populated database. So: fail loudly, and name the mount, because the fix is on the host.
if [ -d "$CONFIG" ]; then
    echo "[entrypoint] FATAL: $CONFIG is a DIRECTORY, not a file." >&2
    echo "[entrypoint] Docker creates a directory when a bind mount points at a host path that does not exist," >&2
    echo "[entrypoint] so this almost always means a '-v /host/wordjs-config.json:$CONFIG' (or a compose volumes:" >&2
    echo "[entrypoint] entry) whose host side is missing. Create the host FILE first, or drop the mount and let the" >&2
    echo "[entrypoint] config live in the data volume, where this entrypoint anchors it by default." >&2
    exit 1
elif [ -f "$CONFIG" ] && [ ! -L "$CONFIG" ]; then
    echo "[entrypoint] A regular $CONFIG is present — using it as-is (not anchoring to the data volume)."
elif [ ! -L "$CONFIG" ]; then
    ln -s "$PERSISTED_CONFIG" "$CONFIG"
    # `ln -s` into anything unexpected would have exited 0 above; assert the shape we actually wanted
    # rather than trusting that the command "worked".
    [ -L "$CONFIG" ] || { echo "[entrypoint] FATAL: failed to anchor $CONFIG as a symlink to $PERSISTED_CONFIG." >&2; exit 1; }
    echo "[entrypoint] Anchored $CONFIG -> $PERSISTED_CONFIG (install state persists in the data volume)."
fi

# ── 2. Optional env-driven pre-seed ──────────────────────────────────────────────────────────────────
# Set WORDJS_PRESEED_CONFIG=1 to have the container come up ALREADY INSTALLED, wired from the variables
# below, with the setup wizard skipped. Use it for an external database, for extra replicas of a site
# that is already installed, or for any deploy whose config is reproduced from the environment rather
# than persisted. Leave it unset for a normal single-container deploy: you want the wizard.
if [ "${WORDJS_PRESEED_CONFIG:-0}" = "1" ] && [ ! -e "$PERSISTED_CONFIG" ] && [ ! -f "$CONFIG" ]; then
    echo "[entrypoint] WORDJS_PRESEED_CONFIG=1 and no config found — generating one from environment."

    # GOTCHA (see documentation/multi-node.md): backend/src/config/app.ts REGENERATES and persists a
    # random dbPassword whenever the flat key is missing OR literally 'password', and a random jwtSecret
    # whenever it is missing OR the placeholder. On multi-node that would give each replica a DIFFERENT
    # secret and break both the shared-Postgres login and cross-node token validation. So we always write
    # concrete, non-'password' values here — supply WORDJS_DB_PASSWORD / WORDJS_JWT_SECRET (identical on
    # every replica) via the environment.
    DB_DRIVER="${WORDJS_DB_DRIVER:-sqlite-native}"
    DB_HOST="${WORDJS_DB_HOST:-localhost}"
    DB_PORT="${WORDJS_DB_PORT:-5432}"
    DB_USER="${WORDJS_DB_USER:-postgres}"
    DB_NAME="${WORDJS_DB_NAME:-wordjs}"
    DB_PASSWORD="${WORDJS_DB_PASSWORD:-wordjs}"
    JWT_SECRET="${WORDJS_JWT_SECRET:-wordjs-shared-dev-secret-change-me}"
    SITE_URL="${WORDJS_SITE_URL:-http://localhost:3000}"
    BACKEND_PORT="${WORDJS_BACKEND_PORT:-4000}"
    PUBLIC_PORT="${PORT:-3000}"
    REDIS_ENABLED="${WORDJS_REDIS_ENABLED:-false}"
    REDIS_HOST="${WORDJS_REDIS_HOST:-127.0.0.1}"
    REDIS_PORT="${WORDJS_REDIS_PORT:-6379}"

    cat > "$CONFIG" <<EOF
{
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "port": ${BACKEND_PORT},
  "gatewayPort": ${PUBLIC_PORT},
  "siteUrl": "${SITE_URL}",
  "dbDriver": "${DB_DRIVER}",
  "dbHost": "${DB_HOST}",
  "dbPort": ${DB_PORT},
  "dbUser": "${DB_USER}",
  "dbName": "${DB_NAME}",
  "dbPassword": "${DB_PASSWORD}",
  "db": {
    "host": "${DB_HOST}",
    "port": ${DB_PORT},
    "user": "${DB_USER}",
    "name": "${DB_NAME}",
    "password": "${DB_PASSWORD}"
  },
  "jwtSecret": "${JWT_SECRET}",
  "redis": {
    "enabled": ${REDIS_ENABLED},
    "host": "${REDIS_HOST}",
    "port": ${REDIS_PORT}
  }
}
EOF
    echo "[entrypoint] Wrote ${PERSISTED_CONFIG} (driver=${DB_DRIVER}, db=${DB_HOST}:${DB_PORT}/${DB_NAME}, redis.enabled=${REDIS_ENABLED})."
    echo "[entrypoint] This instance reports INSTALLED — the setup wizard is skipped and no administrator is seeded."
elif [ -e "$PERSISTED_CONFIG" ] || [ -f "$CONFIG" ]; then
    echo "[entrypoint] Existing wordjs-config.json found — leaving it untouched."
else
    # WORDJS_SITE_URL only LABELS this line on the setup path — nothing writes it anywhere. The origin
    # that ends up in wordjs-config.json is the `siteUrl` the wizard POSTs to /api/v1/setup/install, so
    # install through the URL you will actually browse. (The pre-seed branch above is the one place this
    # variable is persisted.) The app prints its own banner next, deriving the scheme from WORDJS_HTTP
    # and the port from PORT — the same two values used here, so the two lines agree. That banner carries
    # the TOKEN ITSELF only when stdout is a TTY (an attached `docker run -it` / `docker compose up`
    # without -d) or when WORDJS_PRINT_INSTALL_TOKEN=1; otherwise it prints the /install URL WITHOUT the
    # #token= fragment, because a detached container's stdout is a log stream that gets shipped and
    # indexed. The token file below is the reliable source either way.
    echo "[entrypoint] No wordjs-config.json — booting into SETUP MODE; finish setup at ${WORDJS_SITE_URL:-http://localhost:${PORT:-3000}}/install"
    echo "[entrypoint] The one-time install token is WRITTEN to ${DATA_DIR}/install-token (mode 0600), and removed once the site is installed."
    echo "[entrypoint] Read it with:  docker compose exec wordjs cat ${DATA_DIR}/install-token   (or: docker exec <container> cat ${DATA_DIR}/install-token)"
    echo "[entrypoint] It is NOT printed in these logs unless stdout is a TTY or you set WORDJS_PRINT_INSTALL_TOKEN=1. You can also supply your own out-of-band via WORDJS_INSTALL_TOKEN (>= 16 chars)."
fi

exec "$@"
