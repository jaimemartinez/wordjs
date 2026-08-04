#!/usr/bin/env bash
#
# Deploy-mode smoke gate for the COMPILED release bundle.
#
# Why this exists: the previous gate booted the MONOLITH and asked for /healthz. That is a real check —
# it caught the v1.6.0 unbootable bundle — but it is also the reason a whole class of bugs shipped green.
# v1.12.12 was published with split mode unable to install AT ALL (the installer wiped the certificates
# it had just generated, so the gateway never started its control plane and every route 404'd, including
# the wizard) and with cluster enrollment marking a brand-new node "installed", which made the CMS
# bootstrap seed a default administrator on a node already published through the gateway. Neither is
# visible from `start:mono` + /healthz.
#
# So this drives the bundle the way an operator does, in the modes CI never exercised:
#
#   mono    boot, /healthz                                    (what the old gate did)
#   split   gateway + backend + frontend as three processes:
#             the wizard must be REACHABLE through the gateway before anything is installed
#             the install must complete THROUGH the gateway
#             all three services must end up holding their certificates
#             the public site must render REAL settings (SSR must reach the backend)
#             and it must still do so after a restart, when the backend switches to HTTPS + mTLS
#             admin/admin123 must not log in
#   enroll  a node carrying an enrollment-shaped config must ask for the wizard,
#             not come up installed and seed an administrator
#
# Usage: scripts/smoke-deploy.sh <app-root>          (the root of an extracted, release:install'ed bundle)
#
# The HTTP legs run against the gateway's plain-HTTP mode: this gate is about wiring, and the TLS paths
# have their own tests. Exits non-zero with the relevant log on the first failure.

set -uo pipefail

APP="${1:-}"
[ -n "$APP" ] && [ -d "$APP" ] || { echo "::error::usage: smoke-deploy.sh <app-root>"; exit 1; }
APP="$(cd "$APP" && pwd)"
LOGS="$(mktemp -d)"

GW="http://localhost:3000"
SITE_NAME="Smoke Gate $$"
ADMIN_USER="smokeadmin"
ADMIN_PASS="Smoke-Deploy-Gate-1"

# ── process control ──────────────────────────────────────────────────────────
# Each service tree runs in its own process GROUP so we can signal the whole tree: killing just the npm
# pid leaves `concurrently`'s children holding the ports, and the next leg then fails for the wrong
# reason. NOTE the setsid trap — `setsid` FORKS when it is not already a group leader, so `$!` is the
# pid of a process that exits immediately and `-$!` names no group. The new leader therefore reports its
# own pid (which is its pgid) into a file, and that is what we signal.
PGDIR="$LOGS/pg"
mkdir -p "$PGDIR"
start_group() { # start_group <logfile> <cwd> <command...>
    local log="$1" cwd="$2"; shift 2
    local pgfile="$PGDIR/$(date +%s%N)"
    setsid bash -c "cd '$cwd' && echo \$\$ > '$pgfile' && exec $*" > "$log" 2>&1 &
    # Give the leader a moment to record its pgid.
    local i
    for ((i = 1; i <= 20; i++)); do [ -s "$pgfile" ] && break; sleep 0.2; done
}
PORTS='3000|3001|4000'
ports_busy() { ss -ltnH 2>/dev/null | grep -qE ":($PORTS)[[:space:]]"; }
listener_pids() { ss -ltnpH 2>/dev/null | grep -E ":($PORTS)[[:space:]]" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u; }
signal_all() { # signal_all <SIG>
    local sig="$1" f pgid pid
    for f in "$PGDIR"/*; do
        [ -f "$f" ] || continue
        pgid="$(cat "$f" 2>/dev/null)"
        [ -n "$pgid" ] && kill "-$sig" -- "-$pgid" 2>/dev/null
    done
    # Belt and braces: whatever still holds a port gets the same signal directly. The group signal is
    # the clean path, but a service that re-parents or is slow to die would otherwise leak its listener
    # into the NEXT leg — which silently tests the wrong process instead of failing.
    for pid in $(listener_pids); do kill "-$sig" "$pid" 2>/dev/null; done
}
stop_all() {
    local i
    signal_all TERM
    for ((i = 1; i <= 30; i++)); do ports_busy || break; sleep 1; done
    if ports_busy; then
        signal_all KILL
        for ((i = 1; i <= 20; i++)); do ports_busy || break; sleep 1; done
    fi
    rm -f "$PGDIR"/* 2>/dev/null
    if ports_busy; then
        echo "::error::a listener is still holding one of $PORTS after TERM+KILL; the next leg would test the wrong process"
        ss -ltnpH 2>/dev/null | grep -E ":($PORTS)[[:space:]]"
        exit 1
    fi
    sleep 1
    return 0
}
trap 'signal_all KILL' EXIT

# Guard against the failure mode that makes this whole gate meaningless: a leftover service from the
# previous leg answering on the same port. /healthz names the role that replied.
assert_role() { # assert_role <expected-role> <logfile>
    local want="$1" log="$2" got
    got="$(body "$GW/healthz")"
    case "$got" in
        *"\"role\":\"$want\""*) echo "   ✓ /healthz is served by the $want" ;;
        *) fail "expected /healthz to be served by the $want but got: $got" "$log" ;;
    esac
}

fail() {
    echo "::error::$1"
    shift
    local f
    for f in "$@"; do
        [ -f "$f" ] || continue
        echo "==== $(basename "$f") (last 150 lines) ===="
        tail -150 "$f"
    done
    exit 1
}

wait_for_url() { # wait_for_url <url> [tries]
    local url="$1" tries="${2:-60}" i
    for ((i = 1; i <= tries; i++)); do
        curl -fsS -o /dev/null --max-time 5 "$url" 2>/dev/null && { echo "   ✓ $url after ~$((i * 2))s"; return 0; }
        sleep 2
    done
    return 1
}
wait_for_log() { # wait_for_log <file> <grep-pattern> [tries]
    local file="$1" pat="$2" tries="${3:-60}" i
    for ((i = 1; i <= tries; i++)); do
        grep -qE "$pat" "$file" 2>/dev/null && { echo "   ✓ log matched /$pat/ after ~$((i * 2))s"; return 0; }
        sleep 2
    done
    return 1
}
code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -H "Origin: $GW" "$1" 2>/dev/null; }
body() { curl -sS --max-time 15 -H "Origin: $GW" "$1" 2>/dev/null; }

# ─────────────────────────────────────────────────────────────────────────────
# 1. MONOLITH — the original gate: does the compiled bundle boot at all?
# ─────────────────────────────────────────────────────────────────────────────
echo "── mono: boot + /healthz ────────────────────────────────────────────────"
start_group "$LOGS/mono.log" "$APP" "env WORDJS_HTTP=1 npm run start:mono"
wait_for_url "$GW/healthz" 60 \
    || fail "the compiled bundle did NOT serve /healthz — refusing an unbootable release" "$LOGS/mono.log"
assert_role monolith "$LOGS/mono.log"
echo "✅ mono boots and serves /healthz"
stop_all

# ─────────────────────────────────────────────────────────────────────────────
# 2. SPLIT — gateway + backend + frontend, installed THROUGH the gateway
# ─────────────────────────────────────────────────────────────────────────────
echo
echo "── split: install through the gateway ───────────────────────────────────"
rm -f  "$APP"/backend/data/*.db "$APP"/backend/wordjs-config.json "$APP"/frontend/wordjs-config.json
rm -rf "$APP"/backend/certs "$APP"/frontend/certs "$APP"/gateway/certs
printf '{"ssl": false}' > "$APP/gateway/gateway-config.json"
printf '{}'             > "$APP/gateway/gateway-registry.json"

start_group "$LOGS/split.log" "$APP" "npm start"
wait_for_url "$GW/healthz" 90 || fail "split mode never served /healthz" "$LOGS/split.log"
assert_role gateway "$LOGS/split.log"

# THE deadlock this gate exists for: with nothing installed there is no cluster identity, so no service
# can register — and if the gateway has no answer for that, the operator can never reach the wizard.
echo "   checking the wizard is reachable BEFORE anything is installed"
# The three services come up at their own pace; wait for the gateway to be able to REACH the backend
# rather than assuming it can the moment the gateway itself answers.
wait_for_url "$GW/api/v1/setup/status" 60 \
    || fail "the gateway could not reach the backend on a fresh instance — nothing is registered and there is no way in, so split mode cannot be installed at all" "$LOGS/split.log"
[ "$(code "$GW/install")" = 200 ] \
    || fail "GET /install through the gateway did not answer 200 on a fresh instance — the installer is unreachable" "$LOGS/split.log"
status="$(body "$GW/api/v1/setup/status")"
case "$status" in
    *'"installed":false'*) ;;
    *) fail "setup/status did not report an uninstalled instance: $status" "$LOGS/split.log" ;;
esac
echo "   ✓ /install is 200 and the instance reports uninstalled"

token="$(cat "$APP/backend/data/install-token" 2>/dev/null)"
[ -n "$token" ] || fail "no install token was minted" "$LOGS/split.log"

install_out="$(curl -sS --max-time 180 -X POST "$GW/api/v1/setup/install" \
    -H 'Content-Type: application/json' -H "Origin: $GW" -H "x-install-token: $token" \
    -d "{\"siteName\":\"$SITE_NAME\",\"adminUser\":\"$ADMIN_USER\",\"adminEmail\":\"smoke@example.test\",\"adminPassword\":\"$ADMIN_PASS\",\"dbDriver\":\"sqlite-native\",\"siteUrl\":\"$GW\"}" 2>&1)"
case "$install_out" in
    *'"success":true'*) ;;
    *) fail "the install through the gateway failed: $install_out" "$LOGS/split.log" ;;
esac
echo "   ✓ installed through the gateway"

# The installer used to report success having deleted every certificate it just generated.
for svc in backend gateway frontend; do
    n="$(ls "$APP/$svc/certs" 2>/dev/null | wc -l)"
    [ "$n" -gt 0 ] \
        || fail "$svc/certs is EMPTY after a successful install — certificate distribution failed silently, which leaves the cluster unable to form" "$LOGS/split.log"
done
echo "   ✓ all three services hold their certificates"

assert_serving() { # assert_serving <label> <logfile>
    local when="$1" log="$2" i html
    # The frontend registers a moment after the install; give the registry a beat to settle.
    for ((i = 1; i <= 30; i++)); do
        [ "$(code "$GW/")" = 200 ] && break
        sleep 2
    done
    [ "$(code "$GW/")" = 200 ] \
        || fail "[$when] the public home page is not 200 through the gateway" "$log"
    [ "$(code "$GW/about")" = 200 ] \
        || fail "[$when] a real content page 404'd — SSR cannot reach the backend, so every page falls back to defaults" "$log"
    # '/' is static + ISR now: right after an install the first hits serve the prerendered shell
    # while the on-demand purge (debounced ~1.5s) and the revalidation render land. POLL for the
    # name instead of asserting the first body — same lesson as the v1.12.12 theme-switch check.
    # A missing/broken purge still fails here: the shell never converges inside the window.
    html=""
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
        html="$(body "$GW/")"
        case "$html" in *"$SITE_NAME"*) break ;; esac
        sleep 2
    done
    case "$html" in
        *"$SITE_NAME"*) ;;
        *) fail "[$when] the home page does not contain the site name after 24s — the install purge/revalidation never landed and SSR is stuck on DEFAULT settings" "$log" ;;
    esac
    case "$html" in
        *'<title>'*undefined*'</title>'*)
            fail "[$when] the page title contains the literal text \"undefined\" — an absent setting was stored as a string" "$log" ;;
    esac
    echo "   ✓ [$when] serving real content"
}

assert_serving "fresh install" "$LOGS/split.log"

# A restarted backend finds its certificates and switches to HTTPS + mTLS. SSR used to be hardwired to
# http://localhost:4000, which that listener refuses — so the site silently reverted to defaults.
echo "   restarting so the backend comes up on HTTPS + mTLS"
stop_all
start_group "$LOGS/split-restart.log" "$APP" "npm start"
wait_for_url "$GW/healthz" 90 || fail "split mode did not come back up after a restart" "$LOGS/split-restart.log"
assert_role gateway "$LOGS/split-restart.log"
wait_for_log "$LOGS/split-restart.log" 'running via HTTPS' 30 >/dev/null \
    || echo "   note: the backend did not report HTTPS within 60s of the restart; the mTLS leg of this check is weaker than intended"
assert_serving "after restart" "$LOGS/split-restart.log"

# The credential the CMS bootstrap used to seed. It must not exist on an installed site.
login="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$GW/api/v1/auth/login" \
    -H 'Content-Type: application/json' -H "Origin: $GW" \
    -d '{"username":"admin","password":"admin123"}' 2>/dev/null)"
[ "$login" != 200 ] \
    || fail "admin/admin123 logged in — the instance shipped with a default credential" "$LOGS/split-restart.log"
echo "   ✓ admin/admin123 is refused ($login)"
echo "✅ split installs through the gateway and serves real content"
stop_all

# ─────────────────────────────────────────────────────────────────────────────
# 3. ENROLLMENT — a joined node must ask for the wizard, not self-install
# ─────────────────────────────────────────────────────────────────────────────
# scripts/node-join.js writes backend/wordjs-config.json to carry the gateway wiring onto a brand-new
# node. While "installed" meant "that file exists", such a node came up installed-but-empty and the
# bootstrap seeded an administrator with a known password, reachable through the gateway.
#
# Asserted on the BOOT LOG rather than over HTTP on purpose: a really-enrolled node holds cluster certs
# and therefore serves HTTPS with mTLS enforced, which a plain probe cannot talk to. What is under test
# is the install-state decision and the seeding, neither of which depends on the listener.
echo
echo "── enroll: a joined node must still require setup ───────────────────────"
rm -f "$APP"/backend/data/*.db "$APP"/backend/wordjs-config.json
cat > "$APP/backend/wordjs-config.json" <<'ENROLLED'
{
  "gatewayHost": "127.0.0.1",
  "gatewayPort": 3000,
  "gatewayInternalPort": 3100,
  "gatewaySecret": "smoke-gate-secret",
  "gatewaySsl": { "enabled": false },
  "siteUrl": "http://localhost:3000",
  "advertiseHost": "127.0.0.1",
  "host": "localhost",
  "port": 4000,
  "jwtSecret": "smoke-gate-jwt-secret-smoke-gate-jwt-secret-smoke-gate-jwt-secret",
  "mtls": { "ca": "./certs/cluster-ca.crt", "key": "./certs/backend.key", "cert": "./certs/backend.crt" }
}
ENROLLED

start_group "$LOGS/enroll.log" "$APP/backend" "npm start"
wait_for_log "$LOGS/enroll.log" 'SETUP MODE|Backend is running|Default admin created' 60 \
    || fail "the enrolled backend never reported its state" "$LOGS/enroll.log"
sleep 5   # let the CMS bootstrap run if it is going to

if grep -qiE 'admin123|Default admin created' "$LOGS/enroll.log"; then
    fail "the enrolled node seeded a default administrator — it skipped the wizard and published a known credential" "$LOGS/enroll.log"
fi
grep -q 'SETUP MODE' "$LOGS/enroll.log" \
    || fail "a node carrying an ENROLLMENT config did not enter setup mode — it considers itself installed and will bootstrap its own administrator" "$LOGS/enroll.log"
echo "   ✓ reports uninstalled and seeded no administrator"
echo "✅ enrollment leaves the node awaiting setup"

echo
echo "✅ deploy-mode smoke gate passed (mono + split + enrollment)"
