#!/bin/sh
# WordJS container entrypoint.
#
# The running app reads its DATABASE settings from backend/wordjs-config.json (NOT from environment
# variables — only Redis and a few flags are env-read). So, to keep `docker run`/`docker compose up`
# env-configurable, this script MATERIALIZES that config file from environment variables on first boot.
# It is idempotent and NON-destructive: a config that already exists (baked in, mounted, or written by a
# previous boot) is left untouched, so a completed install wizard is never clobbered.
#
# Writing a config with `dbDriver` set marks the app "installed" (core/configManager.isInstalled keys off
# installedAt || dbDriver), so it boots straight into serving mode and /readyz can go green.
set -e

CONFIG="/app/backend/wordjs-config.json"

if [ ! -f "$CONFIG" ]; then
    echo "[entrypoint] No wordjs-config.json found — generating one from environment."

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
    echo "[entrypoint] Wrote ${CONFIG} (driver=${DB_DRIVER}, db=${DB_HOST}:${DB_PORT}/${DB_NAME}, redis.enabled=${REDIS_ENABLED})."
else
    echo "[entrypoint] Existing wordjs-config.json found — leaving it untouched."
fi

exec "$@"
