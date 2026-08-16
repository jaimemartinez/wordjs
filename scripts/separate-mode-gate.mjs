#!/usr/bin/env node
'use strict';
/**
 * WordJS — SEPARATE-MODE GATE
 * ===========================
 *
 *   npm run gate:separate
 *
 * Stands up the THREE-MACHINE topology from documentation/separate-mode.md (a gateway box, a backend
 * box and a frontend box, joined by gateway-minted single-use tokens over mutual TLS), verifies it,
 * and tears it down. One command, re-runnable, self-cleaning.
 *
 * WHY THIS EXISTS
 * ---------------
 * Separate mode was unusable and nobody knew, because nothing exercised it. Standing it up for real
 * surfaced three bugs (fixed in dba59b2) that monolith and single-host split CANNOT see:
 *
 *   1. The installer recorded ITSELF as the site origin — it read `Host`, which the gateway rewrites
 *      (changeOrigin), so the BACKEND's address became the public siteUrl and every later API call
 *      answered 409 `migration_required`. Invisible elsewhere: there the upstream is loopback, which
 *      the migration guard exempts.
 *   2. Installing on an enrolled node re-minted the cluster CA, leaving the CA PRIVATE KEY on the
 *      backend and an identity the gateway does not trust — the node died at its next restart.
 *   3. `/public` was never routed, so 161 KB of block CSS and 73 KB of icons 404'd (this one also
 *      broke single-host split).
 *
 * Those fixes are in, but only a running three-machine cluster can keep them in. That is this gate.
 *
 * WHAT IT CHECKS (each is one of the failures, or the property that proves the mode)
 *   1 ENROLLMENT      the gateway is the CA; single-use tokens; backend/frontend get CN=<role> certs
 *   2 REAL mTLS       no client cert => REFUSED; with one => answered; a valid cert of one role
 *                     claiming another role's routes => rejected
 *   3 INSTALL         installed THROUGH the gateway; the public origin is the GATEWAY, never the
 *                     backend's internal address; API calls after install are 200, not 409
 *   4 IDENTITY        survives install AND a restart: the backend's CA is still the gateway's, and
 *                     the CA private key is NOT on the backend
 *   5 PUBLIC SITE     complete: HTML with block classes, /public/css/wordjs-ui.css 200 at its real
 *                     size, plus an editor round-trip (create a page with blocks, save, read back)
 *
 * INFRASTRUCTURE
 * --------------
 * Three fresh Debian 12 LXC containers on the Proxmox lab (ids 220/221/222), cloned from a base
 * template (id 229) the gate builds once and reuses. Containers are real machines as far as this
 * topology is concerned: their own filesystem, their own non-loopback address, reached through a
 * proxy that rewrites Host — which is exactly what all three bugs needed to become visible.
 *
 * The gate deploys the SELF-BUILT release bundle (`npm run bundle-release` ->
 * release/wordjs-compiled-release.zip), i.e. the artifact an operator actually ships, driven exactly
 * as documentation/separate-mode.md documents it.
 *
 * SELF-TEST — proving the gate is not decorative
 * ----------------------------------------------
 *   npm run gate:separate -- --sabotage install-host      (reverts fix 1 in the deployed tree)
 *   npm run gate:separate -- --sabotage install-identity   (reverts fix 2)
 *   npm run gate:separate -- --sabotage public-route       (reverts fix 3)
 *
 * Each reverts ONE fix in the DEPLOYED copy only (the repo is never touched) and the gate must go RED
 * on the matching check. A gate that stays green under sabotage is worthless, so this is part of it.
 *
 * USAGE
 *   node scripts/separate-mode-gate.mjs [options]
 *     --host <ip>          Proxmox host            (default 192.168.182.131)
 *     --key <path>         ssh key                 (default ~/.ssh/wordjs_lab)
 *     --bundle <path>      release ZIP             (default release/wordjs-compiled-release.zip)
 *     --build              run `npm run bundle-release` first
 *     --rebuild-base       force a rebuild of the base template (id 229)
 *     --keep               leave the topology running (for debugging)
 *     --teardown           destroy the runtime containers and exit
 *     --purge-base         with --teardown, also destroy the base template (frees ~2.7 GB)
 *     --sabotage <name>    self-test: revert one fix in the deployed tree (see above)
 *
 * The base template is keyed to the bundle's sha256: a run whose bundle differs rebuilds it (~8 min),
 * a run with the same bundle reuses it (~4 min end to end). Nothing else is left on the lab.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------
// Topology constants. 220-229 is the range reserved for this gate; 200-216 host other work and are
// never touched. 229 is the base TEMPLATE (built once, cloned per run); 220/221/222 are disposable.
// ---------------------------------------------------------------------------------------------
const BASE_CT = 229;
const GW = 220, BE = 221, FE = 222;
const RUNTIME_CTS = [GW, BE, FE];
const ROLE_OF = { [GW]: 'gateway', [BE]: 'backend', [FE]: 'frontend' };
// Stable MACs so the DHCP server hands back the SAME lease on every run instead of leaking one per
// run. `pct clone` copies the source's net config, so each clone must be given its own.
const MAC = { [GW]: 'BC:24:11:0A:0E:20', [BE]: 'BC:24:11:0A:0E:21', [FE]: 'BC:24:11:0A:0E:22' };
const APP = '/opt/wordjs';

// Install parameters. The install token is pinned via WORDJS_INSTALL_TOKEN (>= 16 chars) so the gate
// never has to scrape it out of interleaved service logs.
const INSTALL_TOKEN = 'wordjs-separate-mode-gate-install-token';
const ADMIN_USER = 'gateadmin';
const ADMIN_PASS = 'GateAdminPassw0rd!';
const ADMIN_MAIL = 'gate@wordjs.invalid';

const SABOTAGES = new Set(['install-host', 'install-identity', 'public-route']);

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const k = a.slice(2);
            const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
            out[k] = v;
        } else out._.push(a);
    }
    return out;
}
const args = parseArgs(process.argv.slice(2));
const PVE_HOST = String(args.host || '192.168.182.131');
const SSH_KEY = path.resolve(String(args.key || path.join(os.homedir(), '.ssh', 'wordjs_lab')));
const BUNDLE = path.resolve(String(args.bundle || path.join(ROOT, 'release', 'wordjs-compiled-release.zip')));
const SABOTAGE = args.sabotage === true ? '' : String(args.sabotage || '');
if (SABOTAGE && !SABOTAGES.has(SABOTAGE)) {
    console.error(`✖ --sabotage must be one of: ${[...SABOTAGES].join(', ')}`);
    process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------------------------
const T0 = Date.now();
const el = () => `${((Date.now() - T0) / 1000).toFixed(0)}s`.padStart(5);
const log = (m) => console.log(`[${el()}] ${m}`);
const phase = (m) => console.log(`\n[${el()}] ── ${m} ${'─'.repeat(Math.max(0, 74 - m.length))}`);

/** A failed assertion, carrying WHICH of the five checks broke so the operator is not left guessing. */
class GateFailure extends Error {
    constructor(checkNo, checkName, reason) {
        super(reason);
        this.checkNo = checkNo;
        this.checkName = checkName;
    }
}

const results = [];
async function check(no, name, fn) {
    phase(`CHECK ${no} — ${name}`);
    const started = Date.now();
    const notes = [];
    const ok = (msg) => { notes.push(msg); console.log(`         ✓ ${msg}`); };
    const must = (cond, reason) => { if (!cond) throw new GateFailure(no, name, reason); };
    await fn({ ok, must });
    results.push({ no, name, notes, ms: Date.now() - started });
    console.log(`         ── CHECK ${no} PASSED (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

// ---------------------------------------------------------------------------------------------
// Remote execution. Everything on the lab runs over one ssh connection per call, with the script
// piped on STDIN — so no shell-quoting games and no escaping of embedded JSON/JS.
// ---------------------------------------------------------------------------------------------
const SSH_ARGS = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=20', '-i', SSH_KEY];

function pve(script, { allowFail = false, timeout = 900_000 } = {}) {
    const r = spawnSync('ssh', [...SSH_ARGS, `root@${PVE_HOST}`, 'bash -s'],
        { input: `set -o pipefail\n${script}\n`, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new Error(`ssh failed: ${r.error.message}`);
    const out = (r.stdout || '').replace(/\r/g, '');
    if (r.status !== 0 && !allowFail) {
        throw new Error(`remote command failed (exit ${r.status}):\n${out}\n${(r.stderr || '').trim()}`);
    }
    return { code: r.status, out, err: (r.stderr || '').replace(/\r/g, '') };
}

/**
 * Run a script INSIDE a container. The script is written to a file on the Proxmox host, pushed into
 * the container and executed there — `pct exec ... -- bash -c '<script>'` would need the script to
 * survive two more rounds of shell quoting, which JSON payloads and JS one-liners do not.
 */
function ct(id, script, opts = {}) {
    const heredoc = `cat > /tmp/wjs-step-${id}.sh <<'WJSGATEEOF'\n${script}\nWJSGATEEOF\n` +
        `pct push ${id} /tmp/wjs-step-${id}.sh /tmp/wjs-step.sh >/dev/null\n` +
        `pct exec ${id} -- bash /tmp/wjs-step.sh\n`;
    return pve(heredoc, opts);
}

/** Last non-empty line of a remote command's output — the convention every probe below prints. */
const lastLine = (s) => s.trim().split('\n').filter(Boolean).pop() || '';

// ---------------------------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------------------------
function preflight() {
    phase('PREFLIGHT');
    if (!fs.existsSync(SSH_KEY)) throw new Error(`ssh key not found: ${SSH_KEY}`);
    if (!fs.existsSync(BUNDLE)) {
        throw new Error(`release bundle not found: ${BUNDLE}\n  Build it first: npm run bundle-release (or pass --build)`);
    }
    const size = fs.statSync(BUNDLE).size;
    log(`bundle ${path.relative(ROOT, BUNDLE)} — ${(size / 1048576).toFixed(1)} MB`);

    const info = pve(`hostname; pveversion --verbose | head -1`);
    const lines = info.out.trim().split('\n');
    log(`lab ${lines[0]} — ${lines[1]}`);
    log(`thin pool pve/data at ${poolPercent().toFixed(1)}% used`);

    // Never run if any of the reserved ids collides with something that is NOT ours.
    const owned = pve(`for id in ${RUNTIME_CTS.join(' ')} ${BASE_CT}; do ` +
        `if [ -f /etc/pve/lxc/$id.conf ]; then echo "$id $(grep -m1 '^hostname:' /etc/pve/lxc/$id.conf | awk '{print $2}')"; fi; done`).out;
    for (const line of owned.trim().split('\n').filter(Boolean)) {
        const [id, host] = line.split(/\s+/);
        if (host && !String(host).startsWith('wjs-gate')) {
            throw new Error(`CT ${id} exists and is not ours (hostname '${host}') — refusing to touch it.`);
        }
    }
}

function teardown() {
    phase('TEARDOWN');
    const ids = args['purge-base'] ? [...RUNTIME_CTS, BASE_CT] : RUNTIME_CTS;
    const script = ids.map((id) =>
        `if [ -f /etc/pve/lxc/${id}.conf ]; then pct stop ${id} --skiplock 1 >/dev/null 2>&1 || true; ` +
        `sleep 1; pct destroy ${id} --force 1 --purge 1 >/dev/null 2>&1 || true; echo "destroyed ${id}"; fi`).join('\n');
    const r = pve(script + (args['purge-base'] ? '\nrm -f /var/lib/vz/wjs-gate/base-bundle.sha' : ''), { allowFail: true });
    for (const l of r.out.trim().split('\n').filter(Boolean)) log(l);
    log(args['purge-base']
        ? 'runtime containers AND the base template are gone — the lab is back to how it was'
        : 'runtime containers gone (base template kept for the next run; --purge-base removes it too)');
}

/**
 * Build the base template: Debian 12 + Node 22 + THIS bundle, unpacked, with its production
 * dependencies installed. The template records the bundle's sha256 (on the Proxmox host, since a
 * template cannot be started to be read), and a run rebuilds it whenever that sha does not match the
 * bundle being gated — so a run can never test yesterday's code, and the clones stay near-zero-delta
 * linked copies instead of each rewriting the whole tree into a thin pool with little room to spare.
 */
function buildBaseTemplate(bundleSha) {
    phase(`BASE TEMPLATE (CT ${BASE_CT}) — build from this bundle`);
    pve(`if [ -f /etc/pve/lxc/${BASE_CT}.conf ]; then pct destroy ${BASE_CT} --force 1 --purge 1 >/dev/null 2>&1 || true; fi
rm -f /var/lib/vz/wjs-gate/base-bundle.sha`, { allowFail: true });
    const pct = poolPercent();
    log(`thin pool at ${pct.toFixed(1)}% (old template released)`);
    if (pct > 90) throw new Error(`thin pool pve/data is ${pct.toFixed(1)}% full — the base template needs ~3 GB. Free space first.`);

    log('creating container from the Debian 12 template ...');
    pve(`set -e
TMPL=$(pveam list local | awk '/debian-12-standard/ {print $1}' | head -1)
[ -n "$TMPL" ] || { echo "no debian-12-standard template in local"; exit 1; }
echo "using $TMPL"
pct create ${BASE_CT} "$TMPL" --hostname wjs-gate-base --cores 2 --memory 2048 --swap 512 \\
    --rootfs local-lvm:8 --net0 name=eth0,bridge=vmbr0,ip=dhcp --features nesting=1 \\
    --unprivileged 1 --onboot 0 >/dev/null
pct start ${BASE_CT}
for i in $(seq 1 60); do pct exec ${BASE_CT} -- ping -c1 -W2 deb.debian.org >/dev/null 2>&1 && break; sleep 2; done`);

    log('installing node 22 + toolchain ...');
    ct(BASE_CT, `set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates openssl unzip xz-utils >/dev/null
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs >/dev/null
# Transient: better-sqlite3 falls back to node-gyp when no prebuilt matches for this platform.
# Purged after the install so the template — and therefore every clone — stays small.
# NOT python3: the NodeSource nodejs package DEPENDS on it, so purging python3 silently takes
# nodejs with it and seals a template whose containers have no \`node\` at all.
apt-get install -y -qq make g++ >/dev/null
node -v; npm -v`, { timeout: 1_200_000 });

    log('pushing the bundle and installing production dependencies (this is the slow part) ...');
    pushBundle();
    pve(`set -e
mkdir -p /var/lib/vz/wjs-gate
pct exec ${BASE_CT} -- mkdir -p ${APP}
pct push ${BASE_CT} /var/lib/vz/wjs-gate/bundle.zip /tmp/bundle.zip`);
    ct(BASE_CT, `set -e
cd ${APP} && unzip -oq /tmp/bundle.zip && rm -f /tmp/bundle.zip
echo ${bundleSha} > ${APP}/.gate-bundle-sha
cd ${APP} && npm run release:install >/tmp/npm.log 2>&1 || { tail -40 /tmp/npm.log; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get purge -y -qq make g++ >/dev/null 2>&1 || true
apt-get autoremove -y -qq >/dev/null 2>&1 || true
apt-get clean; rm -rf /var/lib/apt/lists/* /root/.npm /tmp/npm.log
# A template that boots without a runtime is the most expensive kind of broken: it only shows up
# minutes later, in a clone, as 'node: command not found'. Prove the runtime survived the purge.
command -v node >/dev/null || { echo 'FATAL: node was removed by the toolchain purge'; exit 1; }
node -v
du -sh ${APP}`, { timeout: 1_800_000 });

    log('sealing as a template ...');
    pve(`set -e
pct stop ${BASE_CT}
for i in $(seq 1 30); do pct status ${BASE_CT} | grep -q stopped && break; sleep 1; done
pct template ${BASE_CT}
echo ${bundleSha} > /var/lib/vz/wjs-gate/base-bundle.sha
echo "template ${BASE_CT} sealed"`);
    log(`thin pool now at ${poolPercent().toFixed(1)}%`);
}

const poolPercent = () =>
    parseFloat(lastLine(pve(`lvs --noheadings --units b -o data_percent pve/data 2>/dev/null | tr -d ' ' || echo 0`).out)) || 0;

function pushBundle() {
    const local = createHash('sha256').update(fs.readFileSync(BUNDLE)).digest('hex');
    const remote = pve(`mkdir -p /var/lib/vz/wjs-gate; sha256sum /var/lib/vz/wjs-gate/bundle.zip 2>/dev/null | cut -d' ' -f1 || true`).out.trim();
    if (remote === local) { log('bundle already on the lab (sha256 match) — skipping upload'); return; }
    log('uploading bundle to the lab ...');
    const r = spawnSync('scp', [...SSH_ARGS, BUNDLE, `root@${PVE_HOST}:/var/lib/vz/wjs-gate/bundle.zip`],
        { encoding: 'utf8', timeout: 900_000 });
    if (r.status !== 0) throw new Error(`scp failed: ${r.stderr || r.stdout}`);
    const check = pve(`sha256sum /var/lib/vz/wjs-gate/bundle.zip | cut -d' ' -f1`).out.trim();
    if (check !== local) throw new Error(`bundle sha256 mismatch after upload (${check} != ${local})`);
    log(`uploaded, sha256 ${local.slice(0, 16)}…`);
}

/** Clone the template into the three role containers and boot them. */
function cloneTopology() {
    phase('PROVISION — cloning the three machines');
    // Linked clones of the template, so three machines cost roughly one machine's worth of blocks.
    // Still: a thin pool that fills takes every OTHER guest on this host down with it, so refuse.
    const pct0 = poolPercent();
    if (pct0 > 96) throw new Error(`thin pool pve/data is ${pct0.toFixed(1)}% full — refusing to clone. Free space (npm run gate:separate -- --teardown --purge-base) first.`);
    const script = RUNTIME_CTS.map((id) => `
pct clone ${BASE_CT} ${id} --hostname wjs-gate-${ROLE_OF[id]} >/dev/null
pct set ${id} --net0 name=eth0,bridge=vmbr0,ip=dhcp,hwaddr=${MAC[id]} >/dev/null
pct set ${id} --memory ${id === FE ? 2048 : 1536} >/dev/null
pct start ${id}
echo "started ${id} (${ROLE_OF[id]})"`).join('\n');
    pve(`set -e\n${script}`, { timeout: 600_000 });

    log('waiting for DHCP ...');
    const ips = {};
    for (const id of RUNTIME_CTS) {
        let ip = '';
        for (let i = 0; i < 60 && !ip; i++) {
            const r = pve(`pct exec ${id} -- hostname -I 2>/dev/null | awk '{print $1}'`, { allowFail: true });
            ip = (lastLine(r.out) || '').trim();
            if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) { ip = ''; sleepSync(2000); }
        }
        if (!ip) throw new Error(`CT ${id} (${ROLE_OF[id]}) never got an IP address`);
        ips[id] = ip;
        log(`  ${ROLE_OF[id].padEnd(8)} CT ${id}  ${ip}`);
    }
    // Three machines means three ADDRESSES. If DHCP ever handed out a duplicate (clones sharing a
    // client identity), the whole topology would silently collapse into something that is not
    // separate mode — and checks written against distinct hosts would pass for the wrong reason.
    const distinct = new Set(Object.values(ips));
    if (distinct.size !== RUNTIME_CTS.length) throw new Error(`the three nodes did not get distinct addresses: ${JSON.stringify(ips)}`);
    return ips;
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/**
 * Bring each node to a virgin state and PROVE it carries the bundle under test. The application tree
 * came from the template, which is rebuilt whenever the bundle changes — so nothing has to be copied
 * here. But "nothing was copied" must never be indistinguishable from "the wrong code is deployed",
 * hence a sha check on every node rather than trust in the template.
 */
function prepareNodes(bundleSha) {
    phase('DEPLOY — verifying the bundle on each machine, wiping per-run state');
    for (const id of RUNTIME_CTS) {
        const r = ct(id, `set -e
cd ${APP}
got=$(cat .gate-bundle-sha 2>/dev/null || echo none)
[ "$got" = "${bundleSha}" ] || { echo "BUNDLE MISMATCH on ${ROLE_OF[id]}: $got"; exit 1; }
command -v node >/dev/null || { echo 'FATAL: no node runtime on ${ROLE_OF[id]}'; exit 1; }
# Every run starts clean: no config, no certs, no database, no log from a previous run.
rm -rf backend/wordjs-config.json backend/certs backend/data \\
       frontend/wordjs-config.json frontend/certs \\
       gateway/gateway-config.json gateway/gateway-registry.json \\
       gateway/cluster-tokens.json gateway/certs gateway/ssl
rm -f /var/log/wordjs.log
echo "node $(node -v)"`, { timeout: 600_000 });
        log(`  ${ROLE_OF[id].padEnd(8)} ${lastLine(r.out)}, bundle ${bundleSha.slice(0, 12)}…`);
    }
    if (SABOTAGE) applySabotage();
}

/**
 * SELF-TEST. Revert exactly one of dba59b2's three fixes in the DEPLOYED tree (never in the repo) so
 * the gate can be shown to go red when the bug comes back. Each patch is an exact-substring edit and
 * HARD-FAILS if its anchor is missing — a sabotage that silently did nothing would be worse than no
 * self-test at all.
 */
function applySabotage() {
    phase(`SABOTAGE — reverting fix '${SABOTAGE}' in the deployed tree (repo untouched)`);
    // The anchor and its replacement are real source fragments full of quotes, parentheses and `!!`,
    // so they travel through QUOTED HEREDOCS (no expansion, no escaping) rather than inside the shell
    // command line; the patcher itself is single-quoted and reads them from those files.
    const patch = (file, from, to) => `cat > /tmp/sab-from.txt <<'SABFROMEOF'
${from}
SABFROMEOF
cat > /tmp/sab-to.txt <<'SABTOEOF'
${to}
SABTOEOF
node -e '
const fs = require("fs");
const file = process.argv[1];
const strip = (p) => fs.readFileSync(p, "utf8").trimEnd();
const from = strip("/tmp/sab-from.txt"), to = strip("/tmp/sab-to.txt");
const src = fs.readFileSync(file, "utf8");
if (!src.includes(from)) { console.error("ANCHOR NOT FOUND in " + file + ": " + from); process.exit(1); }
fs.writeFileSync(file, src.split(from).join(to));
console.log("patched " + file);
' ${file}`;

    if (SABOTAGE === 'install-host') {
        // BUG 1: read the raw Host header again instead of preferring X-Forwarded-Host.
        ct(BE, `set -e\n` + patch(`${APP}/backend/dist/routes/setup.js`,
            `pickInstallHost(req.get('x-forwarded-host'), req.get('host'))`,
            `pickInstallHost(undefined, req.get('host'))`));
    } else if (SABOTAGE === 'install-identity') {
        // BUG 2: stop recognising an enrolled node, so the installer re-mints the cluster CA over it.
        ct(BE, `set -e\n` + patch(`${APP}/backend/dist/routes/setup.js`,
            `isEnrolledConfig(enrolledConfig, !!enrolledConfig.mtls?.cert && fs.existsSync(path.resolve(enrolledConfig.mtls.cert)))`,
            `false`));
    } else if (SABOTAGE === 'public-route') {
        // BUG 3: drop /public from what the backend declares AND from the gateway's role allowlist.
        ct(BE, `set -e\n` + patch(`${APP}/backend/dist/index.js`,
            `'/plugins', '/public', '/.well-known'`, `'/plugins', '/.well-known'`));
        ct(GW, `set -e\n` + patch(`${APP}/gateway/src/index.js`,
            `'/plugins', '/public', '/.well-known'`, `'/plugins', '/.well-known'`));
    }
}

/** systemd units, so a service can be restarted (CHECK 4) and a crash stays visible (Restart=no). */
function installUnits() {
    const unit = (name, dir, exec, env = '') => `cat > /etc/systemd/system/${name}.service <<'UNITEOF'
[Unit]
Description=WordJS ${name}
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${dir}
ExecStart=${exec}
Environment=NODE_ENV=production
${env}
Restart=no
StandardOutput=append:/var/log/wordjs.log
StandardError=append:/var/log/wordjs.log

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload`;

    ct(GW, `set -e\n${unit('wordjs-gateway', `${APP}/gateway`, '/usr/bin/node src/index.js')}\necho ok`);
    ct(BE, `set -e\n${unit('wordjs-backend', `${APP}/backend`, '/usr/bin/node server.js',
        `Environment=WORDJS_INSTALL_TOKEN=${INSTALL_TOKEN}`)}\necho ok`);
    ct(FE, `set -e\n${unit('wordjs-frontend', `${APP}/frontend`, '/usr/bin/node scripts/start-frontend.js prod')}\necho ok`);
}

// ---------------------------------------------------------------------------------------------
// Topology bring-up — exactly the flow documentation/separate-mode.md prescribes for a self-built
// release ZIP: cluster.js init on the gateway, one minted token per role, node-join on each node.
// ---------------------------------------------------------------------------------------------
function bringUp(ips) {
    phase('BRING-UP — cluster init, tokens, enrollment');
    const gwIp = ips[GW], beIp = ips[BE], feIp = ips[FE];
    installUnits();

    log('gateway: cluster.js init (mint the cluster CA) ...');
    const init = ct(GW, `set -e
cd ${APP}
rm -f /var/log/wordjs.log
node scripts/cluster.js init --host ${gwIp}
systemctl start wordjs-gateway
for i in $(seq 1 60); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 3 https://${gwIp}:3000/healthz || true)
  [ "$code" = "200" ] && { echo "GATEWAY_UP"; break; }
  sleep 2
done`);
    if (!init.out.includes('GATEWAY_UP')) throw new Error(`gateway never came up:\n${init.out}\n${logsOf(GW)}`);
    const caHash = (init.out.match(/CA fingerprint \(sha256\):\s*([0-9a-f]+)/) || [])[1];
    if (!caHash) throw new Error(`cluster.js init printed no CA fingerprint:\n${init.out}`);
    log(`gateway up — cluster CA ${caHash.slice(0, 16)}…`);

    const mint = (role, host) => {
        const r = ct(GW, `cd ${APP} && node scripts/cluster.js token ${role} --host ${host} --ttl 30`);
        const tok = (r.out.match(new RegExp(`(wjc\\.${role}\\.[A-Za-z0-9_-]{20,})`)) || [])[1];
        if (!tok) throw new Error(`could not mint a ${role} join token:\n${r.out}`);
        return tok;
    };
    const beTok = mint('backend', beIp);
    const feTok = mint('frontend', feIp);
    log(`minted single-use join tokens (backend ${beTok.slice(0, 8)}…, frontend ${feTok.slice(0, 8)}…)`);

    log('backend: node-join + start ...');
    const beJoin = ct(BE, `set -e
cd ${APP}
rm -f /var/log/wordjs.log
node scripts/node-join.js --role backend --gateway ${gwIp} --enroll-port 3101 \\
     --token ${beTok} --ca-hash ${caHash} --advertise ${beIp}
systemctl start wordjs-backend`);
    if (!/enrolled and configured/.test(beJoin.out)) throw new Error(`backend enrollment failed:\n${beJoin.out}`);

    log('frontend: node-join + start ...');
    const feJoin = ct(FE, `set -e
cd ${APP}
rm -f /var/log/wordjs.log
node scripts/node-join.js --role frontend --gateway ${gwIp} --enroll-port 3101 \\
     --token ${feTok} --ca-hash ${caHash} --advertise ${feIp}
systemctl start wordjs-frontend`);
    if (!/enrolled and configured/.test(feJoin.out)) throw new Error(`frontend enrollment failed:\n${feJoin.out}`);

    log('waiting for both nodes to register with the gateway over mTLS ...');
    waitForRegistry(gwIp, beIp, feIp);
    return { gwIp, beIp, feIp, caHash, beTok };
}

/** The gateway's registry is the honest readiness signal: a node is in it only after a real mTLS POST. */
function waitForRegistry(gwIp, beIp, feIp, timeoutMs = 240_000) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
        last = ct(GW, `cat ${APP}/gateway/gateway-registry.json 2>/dev/null || echo '{}'`, { allowFail: true }).out;
        if (last.includes(`${beIp}:4000`) && last.includes(`${feIp}:3001`)) return JSON.parse(last.match(/\{[\s\S]*\}/)[0]);
        sleepSync(3000);
    }
    throw new Error(`nodes never registered within ${timeoutMs / 1000}s.\nregistry: ${last}\n${logsOf(GW)}\n${logsOf(BE)}\n${logsOf(FE)}`);
}

const logsOf = (id) => `--- ${ROLE_OF[id]} log (tail) ---\n` +
    ct(id, `tail -40 /var/log/wordjs.log 2>/dev/null || echo '(no log)'`, { allowFail: true }).out;

// ---------------------------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------------------------
// NOTE: the `\n` in every -w format is load-bearing. A refused TLS handshake makes curl print `000`
// WITHOUT a trailing newline and exit non-zero, so the `|| echo 000` fallback would land on the SAME
// line and the probe would read `000000`.
/** HTTP status of a request made FROM the Proxmox host (a third party — neither gateway nor node). */
function httpFromHost(url, extra = '') {
    return lastLine(pve(`curl -sk -o /dev/null -w '%{http_code}\\n' --max-time 20 ${extra} '${url}' || echo 000`, { allowFail: true }).out);
}
/** Body of a request made from the Proxmox host. */
function bodyFromHost(url, extra = '') {
    return pve(`curl -sk --max-time 30 ${extra} '${url}' || true`, { allowFail: true }).out;
}
/** HTTP status of a request made from INSIDE a container (optionally presenting that node's cert). */
function httpFromCt(id, url, extra = '') {
    return lastLine(ct(id, `curl -sk -o /dev/null -w '%{http_code}\\n' --max-time 20 ${extra} '${url}' || echo 000`, { allowFail: true }).out);
}

// ---------------------------------------------------------------------------------------------
// THE FIVE CHECKS
// ---------------------------------------------------------------------------------------------
async function check1Enrollment(t, { must, ok }) {
    // The gateway is the CA and the CA private key stays there, 0600.
    const gw = ct(GW, `set -e
cd ${APP}/gateway/certs
stat -c '%a %n' cluster-ca.key cluster-ca.crt gateway-internal.crt
openssl x509 -in cluster-ca.crt -noout -fingerprint -sha256 | sed 's/.*=//;s/://g' | tr 'A-Z' 'a-z'`);
    const gwLines = gw.out.trim().split('\n');
    const caFp = gwLines.pop().trim();
    must(gwLines.some((l) => /^600 cluster-ca\.key$/.test(l.trim())),
        `the cluster CA private key is missing or not 0600 on the gateway:\n${gwLines.join('\n')}`);
    ok(`gateway holds the cluster CA (key 0600), sha256 ${caFp.slice(0, 16)}…`);

    // Each node holds a leaf with ITS role's CN, signed by that CA.
    for (const [id, role] of [[BE, 'backend'], [FE, 'frontend']]) {
        const r = ct(id, `set -e
cd ${APP}/${role}/certs
openssl x509 -in ${role}.crt -noout -subject | sed 's/.*CN *= *//'
openssl verify -CAfile cluster-ca.crt ${role}.crt
openssl x509 -in cluster-ca.crt -noout -fingerprint -sha256 | sed 's/.*=//;s/://g' | tr 'A-Z' 'a-z'`);
        const [cn, verify, nodeFp] = r.out.trim().split('\n').map((s) => s.trim());
        must(cn === role, `${role} node's certificate CN is '${cn}', expected '${role}'`);
        must(/: OK$/.test(verify), `${role} node's certificate does not verify against the cluster CA: ${verify}`);
        must(nodeFp === caFp, `${role} node trusts a DIFFERENT CA than the gateway (${nodeFp.slice(0, 16)}… vs ${caFp.slice(0, 16)}…)`);
        ok(`${role} enrolled: CN=${cn}, verifies against the gateway's CA`);
    }

    // The gateway's registry names the REAL node addresses, not loopback.
    const reg = ct(GW, `cat ${APP}/gateway/gateway-registry.json`).out;
    const registry = JSON.parse(reg.match(/\{[\s\S]*\}/)[0]);
    const apiTargets = (registry['/api'] && registry['/api'].targets) || [];
    const rootTargets = (registry['/'] && registry['/'].targets) || [];
    must(apiTargets.includes(`https://${t.beIp}:4000`), `/api is not routed to the backend node: ${JSON.stringify(apiTargets)}`);
    must(rootTargets.includes(`https://${t.feIp}:3001`), `/ is not routed to the frontend node: ${JSON.stringify(rootTargets)}`);
    must(!reg.includes('127.0.0.1'), `the registry still contains loopback targets — the nodes are not really separate:\n${reg}`);
    ok(`registry routes /api -> ${t.beIp}:4000 and / -> ${t.feIp}:3001 (no loopback)`);

    // Tokens are SINGLE USE: replaying the backend's burned token must be refused. Done with a
    // throwaway CSR from the gateway box so the backend's live key is never touched.
    const replay = ct(GW, `set -e
cd /tmp && rm -f replay.key replay.csr
openssl req -newkey rsa:2048 -nodes -keyout replay.key -out replay.csr -subj '/CN=backend' 2>/dev/null
node -e "
const fs=require('fs'),https=require('https');
const body=JSON.stringify({role:'backend',token:'${t.beTok}',advertiseHost:'${t.beIp}',csr:fs.readFileSync('/tmp/replay.csr','utf8')});
const req=https.request({host:'${t.gwIp}',port:3101,path:'/enroll',method:'POST',rejectUnauthorized:false,
  headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},
  r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log('REPLAY_STATUS='+r.statusCode))});
req.on('error',e=>console.log('REPLAY_STATUS=ERR '+e.message));req.write(body);req.end();"`);
    const replayStatus = (replay.out.match(/REPLAY_STATUS=(.+)/) || [])[1] || '';
    must(replayStatus.trim() !== '200', `a burned join token was accepted AGAIN (status ${replayStatus}) — tokens are not single-use`);
    ok(`replaying the burned backend token is refused (status ${replayStatus.trim()})`);
}

async function check2Mtls(t, { must, ok }) {
    // --- the backend's own port: mTLS required, and the peer must be the GATEWAY ---
    const noCert = httpFromHost(`https://${t.beIp}:4000/healthz`);
    must(noCert === '000', `the backend answered ${noCert} to a request with NO client certificate — it must refuse`);
    ok(`backend :4000 with no client certificate -> ${noCert} (refused at the TLS layer)`);

    const gwCert = `--cert ${APP}/gateway/certs/gateway-internal.crt --key ${APP}/gateway/certs/gateway-internal.key --cacert ${APP}/gateway/certs/cluster-ca.crt`;
    const withCert = httpFromCt(GW, `https://${t.beIp}:4000/healthz`, gwCert);
    must(withCert === '200', `the backend answered ${withCert} to the gateway's own certificate — expected 200`);
    ok(`backend :4000 with the gateway's certificate -> ${withCert}`);

    const feCert = `--cert ${APP}/frontend/certs/frontend.crt --key ${APP}/frontend/certs/frontend.key --cacert ${APP}/frontend/certs/cluster-ca.crt`;
    const crossCert = httpFromCt(FE, `https://${t.beIp}:4000/healthz`, feCert);
    must(crossCert === '000', `a valid CN=frontend certificate reached the backend API (${crossCert}) — the peer identity is not pinned`);
    ok(`backend :4000 with a valid CN=frontend certificate -> ${crossCert} (wrong role, rejected)`);

    // --- the gateway's internal control plane: same three properties ---
    const regNoCert = httpFromHost(`https://${t.gwIp}:3100/register`, `-X POST -H 'Content-Type: application/json' -d '{}'`);
    must(regNoCert === '000', `the gateway's internal port answered ${regNoCert} without a client certificate — it must refuse`);
    ok(`gateway :3100 with no client certificate -> ${regNoCert} (refused at the TLS layer)`);

    const beCert = `--cert ${APP}/backend/certs/backend.crt --key ${APP}/backend/certs/backend.key --cacert ${APP}/backend/certs/cluster-ca.crt`;
    // Re-register the EXACT set the backend currently owns, read back from the registry. Hard-coding
    // the list would make this probe evict every prefix it forgot to name (a registration that omits a
    // route removes it), and would fail here for a reason that belongs to CHECK 5 if the route list
    // itself ever regressed — which is precisely what the `public-route` self-test reverts.
    const registry = JSON.parse(ct(GW, `cat ${APP}/gateway/gateway-registry.json`).out.match(/\{[\s\S]*\}/)[0]);
    const owned = Object.entries(registry)
        .filter(([, g]) => (g.targets || []).includes(`https://${t.beIp}:4000`))
        .map(([route]) => route);
    must(owned.includes('/api'), `the backend does not own /api in the registry: ${JSON.stringify(owned)}`);
    const legitRoutes = JSON.stringify({ name: 'backend', url: `https://${t.beIp}:4000`, routes: owned });
    const legit = httpFromCt(BE, `https://${t.gwIp}:3100/register`,
        `${beCert} -X POST -H 'Content-Type: application/json' -d '${legitRoutes}'`);
    must(legit === '200', `the backend's own re-registration was refused (${legit}) — mTLS registration is broken`);
    ok(`gateway :3100 with the CN=backend certificate, its own ${owned.length} routes -> ${legit}`);

    // The load-bearing one: a VALID certificate of one role claiming ANOTHER role's routes.
    const stolen = JSON.stringify({ name: 'frontend', url: `https://${t.feIp}:3001`, routes: ['/api'] });
    const cross = httpFromCt(FE, `https://${t.gwIp}:3100/register`,
        `${feCert} -X POST -H 'Content-Type: application/json' -d '${stolen}'`);
    must(cross === '403', `a valid CN=frontend certificate was allowed to claim /api (status ${cross}) — role routing is not enforced`);
    ok(`gateway :3100 with a valid CN=frontend certificate claiming /api -> ${cross} (rejected)`);
}

async function check3Install(t, { must, ok }) {
    // Install THROUGH the gateway, deliberately WITHOUT an explicit siteUrl: the whole point is which
    // host the backend derives from the request it receives through a proxy that rewrites Host.
    const payload = JSON.stringify({
        siteName: 'WordJS Separate Gate', adminUser: ADMIN_USER, adminEmail: ADMIN_MAIL,
        adminPassword: ADMIN_PASS, dbDriver: 'sqlite-native', demoContent: true
    });
    log('installing through the gateway ...');
    const r = pve(`cat > /tmp/install.json <<'JSONEOF'\n${payload}\nJSONEOF\n` +
        `curl -sk --max-time 300 -X POST https://${t.gwIp}:3000/api/v1/setup/install ` +
        `-H 'Content-Type: application/json' -H 'x-install-token: ${INSTALL_TOKEN}' ` +
        `-H 'Origin: https://${t.gwIp}:3000' --data @/tmp/install.json -w '\\nHTTP_STATUS=%{http_code}'`,
        { allowFail: true, timeout: 600_000 });
    const status = (r.out.match(/HTTP_STATUS=(\d+)/) || [])[1];
    must(status === '200', `install through the gateway returned ${status}: ${r.out.slice(0, 600)}`);
    must(/"success"\s*:\s*true/.test(r.out), `install did not report success: ${r.out.slice(0, 600)}`);
    ok(`POST /api/v1/setup/install through the gateway -> 200 success`);

    // THE BUG-1 ASSERTION: the recorded public origin must be the GATEWAY, never this node's own address.
    const cfg = ct(BE, `node -e "const c=require('${APP}/backend/wordjs-config.json');console.log(JSON.stringify({siteUrl:c.siteUrl,host:c.host,advertiseHost:c.advertiseHost,gatewayHost:c.gatewayHost}))"`).out;
    const conf = JSON.parse(lastLine(cfg));
    const siteHost = new URL(conf.siteUrl).hostname;
    must(siteHost !== t.beIp, `the installer recorded the BACKEND's own address as the public site origin (siteUrl=${conf.siteUrl})`);
    must(siteHost === t.gwIp, `the public site origin is '${siteHost}', expected the gateway '${t.gwIp}' (siteUrl=${conf.siteUrl})`);
    ok(`siteUrl recorded as ${conf.siteUrl} (the gateway — not the backend at ${t.beIp})`);

    const options = readOptions(t);
    must(options.siteurl === `https://${t.gwIp}:3000`, `option siteurl is '${options.siteurl}', expected https://${t.gwIp}:3000`);
    ok(`option siteurl=${options.siteurl}`);

    // THE SYMPTOM the bug produced: every API call answering 409 migration_required.
    for (const p of ['/api/v1/posts', '/api/v1/settings', '/api/v1/setup/status']) {
        const code = httpFromHost(`https://${t.gwIp}:3000${p}`);
        must(code !== '409', `API call ${p} through the gateway answered 409 migration_required after install`);
        must(code === '200', `API call ${p} through the gateway answered ${code}, expected 200`);
    }
    ok('API through the gateway answers 200 (no 409 migration_required)');

    // Black-box confirmation: the sitemap is built from the stored siteurl.
    const sitemap = bodyFromHost(`https://${t.gwIp}:3000/sitemap.xml`);
    must(sitemap.includes(`https://${t.gwIp}:3000`), `sitemap.xml does not use the gateway origin:\n${sitemap.slice(0, 300)}`);
    must(!sitemap.includes(t.beIp), `sitemap.xml leaks the backend's internal address ${t.beIp}`);
    ok('sitemap.xml is published under the gateway origin and never names the backend');
}

async function check4Identity(t, { must, ok }) {
    const fp = (id, role) => lastLine(ct(id, `openssl x509 -in ${APP}/${role}/certs/cluster-ca.crt -noout -fingerprint -sha256 | sed 's/.*=//;s/://g' | tr 'A-Z' 'a-z'`).out);
    const gwFp = fp(GW, 'gateway');
    const beFp = fp(BE, 'backend');
    must(beFp === gwFp, `installing REPLACED the backend's cluster CA: gateway ${gwFp.slice(0, 16)}… vs backend ${beFp.slice(0, 16)}…`);
    ok(`after install the backend still trusts the gateway's CA (${beFp.slice(0, 16)}…)`);

    // The CA private key must exist on the gateway ONLY — and no other role's identity may be here.
    const stray = ct(BE, `ls ${APP}/backend/certs | sort | tr '\\n' ' '`).out;
    const files = lastLine(stray).trim().split(/\s+/).filter(Boolean);
    must(!files.includes('cluster-ca.key'), `the cluster CA PRIVATE KEY is on the backend node: ${files.join(' ')}`);
    for (const forbidden of ['gateway-internal.key', 'gateway-internal.crt', 'frontend.key', 'frontend.crt']) {
        must(!files.includes(forbidden), `the backend node holds another role's identity '${forbidden}': ${files.join(' ')}`);
    }
    ok(`backend certs/ holds only its own identity: ${files.join(' ')}`);

    // Enrollment's wiring must have survived the installer's single-host defaults.
    const conf = JSON.parse(lastLine(ct(BE, `node -e "const c=require('${APP}/backend/wordjs-config.json');console.log(JSON.stringify({host:c.host,advertiseHost:c.advertiseHost,gatewayHost:c.gatewayHost,gatewaySecret:c.gatewaySecret}))"`).out));
    const gwSecret = lastLine(ct(GW, `node -e "console.log(require('${APP}/gateway/gateway-config.json').gatewaySecret)"`).out).trim();
    must(conf.host === '0.0.0.0', `the installer re-bound the backend to '${conf.host}' — a gateway on another machine cannot reach it`);
    must(conf.advertiseHost === t.beIp, `advertiseHost is '${conf.advertiseHost}', expected ${t.beIp}`);
    must(conf.gatewayHost === t.gwIp, `gatewayHost is '${conf.gatewayHost}', expected ${t.gwIp}`);
    must(conf.gatewaySecret === gwSecret, `the installer rotated gatewaySecret away from the gateway's value`);
    ok(`enrollment wiring intact (host=0.0.0.0, advertiseHost=${conf.advertiseHost}, gatewayHost=${conf.gatewayHost}, shared secret unchanged)`);

    // `home` is the origin visitors are sent to. The single-host default (siteUrl with :3000 swapped
    // for :3001) names the GATEWAY's host on the FRONTEND's private port — an address nobody serves.
    // On an enrolled cluster the public origin is the gateway, full stop.
    const options = readOptions(t);
    must(options.home === `https://${t.gwIp}:3000`,
        `option home is '${options.home}', expected the gateway origin https://${t.gwIp}:3000 — the installer applied its single-host default to an enrolled node`);
    ok(`option home=${options.home} (the gateway, not its host on the frontend's private port)`);

    // The real test of an identity: a RESTART. The pre-fix node kept running on in-memory certs and
    // only died here.
    log('restarting the backend service ...');
    ct(BE, `systemctl restart wordjs-backend`);
    sleepSync(4000);
    const active = lastLine(ct(BE, `systemctl is-active wordjs-backend || true`, { allowFail: true }).out).trim();
    must(active === 'active', `the backend did not survive a restart (systemd: ${active})\n${logsOf(BE)}`);

    // Serving again THROUGH the gateway is the only honest proof: the registry can still hold a stale
    // entry for a backend that is gone, and a node whose identity the gateway no longer trusts fails
    // the mTLS handshake — which shows up here as a 502, not as a missing registration.
    let code = '000';
    for (let i = 0; i < 40 && code !== '200'; i++) {
        code = httpFromHost(`https://${t.gwIp}:3000/api/v1/posts`);
        if (code !== '200') sleepSync(3000);
    }
    must(code === '200', `after restarting the backend the API through the gateway answers ${code}\n${logsOf(BE)}\n${logsOf(GW)}`);
    const afterFp = fp(BE, 'backend');
    must(afterFp === gwFp, `after restart the backend's CA no longer matches the gateway's`);
    ok(`backend restarted, re-registered over mTLS with the same identity, API still 200`);
}

async function check5PublicSite(t, { must, ok }) {
    // --- /public: the 161 KB of block CSS and 73 KB of icons that silently went missing ---
    const assets = [
        { url: '/public/css/wordjs-ui.css', file: `${APP}/backend/public/css/wordjs-ui.css`, min: 100_000 },
        { url: '/public/vendor/fontawesome/css/all.min.css', file: `${APP}/backend/public/vendor/fontawesome/css/all.min.css`, min: 50_000 },
    ];
    for (const a of assets) {
        const r = pve(`curl -sk --max-time 30 -o /tmp/asset.bin -w '%{http_code} %{size_download}\\n' 'https://${t.gwIp}:3000${a.url}' || echo '000 0'`, { allowFail: true });
        const [code, bytes] = lastLine(r.out).trim().split(/\s+/);
        const onDisk = parseInt(lastLine(ct(BE, `stat -c %s ${a.file}`).out).trim(), 10);
        must(code === '200', `${a.url} through the gateway answered ${code} — the /public prefix is not routed to the backend`);
        must(parseInt(bytes, 10) === onDisk, `${a.url} served ${bytes} bytes but the backend holds ${onDisk}`);
        must(parseInt(bytes, 10) >= a.min, `${a.url} served only ${bytes} bytes (expected at least ${a.min})`);
        ok(`${a.url} -> 200, ${Number(bytes).toLocaleString('en-US')} bytes (matches the file on the backend)`);
    }

    // --- the public HTML actually carries block markup ---
    const html = bodyFromHost(`https://${t.gwIp}:3000/`);
    const blockHits = (html.match(/wp-block-[a-z0-9-]+/g) || []);
    const blockTypes = new Set(blockHits);
    must(html.length > 2000, `the public homepage returned ${html.length} bytes — that is not a rendered site`);
    must(blockHits.length >= 5, `the public homepage carries only ${blockHits.length} wp-block-* occurrences`);
    must(blockTypes.size >= 3, `the public homepage carries only ${blockTypes.size} distinct block types`);
    must(html.includes('/public/css/wordjs-ui.css'), `the public homepage does not even link the block stylesheet`);
    ok(`homepage: ${blockHits.length} wp-block-* occurrences across ${blockTypes.size} block types, linking the block stylesheet`);

    // --- editor round-trip: create a page with blocks, save it, read it back ---
    log('editor round-trip: login, create a page with blocks, read it back ...');
    const jwt = login(t);
    const slug = `gate-roundtrip-${Date.now()}`;
    // Real core block types with their real props (coreBlocks.tsx CORE_BLOCK_TYPES), so the payload
    // is one the editor would actually save and the public renderer would actually render.
    const puck = {
        root: { props: { title: 'Separate mode round-trip' } },
        zones: {},
        content: [
            { type: 'Heading', props: { id: 'Heading-gate-1', title: 'Separate mode round-trip', level: 'h2' } },
            { type: 'Text', props: { id: 'Text-gate-1', content: 'Saved through the gateway, read back from the backend.' } },
            { type: 'Button', props: { id: 'Button-gate-1', label: 'Back home', href: '/', variant: 'primary' } },
        ],
    };
    const content = '<h2 class="wp-block-heading">Separate mode round-trip</h2>' +
        '<p>Saved through the gateway, read back from the backend.</p>';
    const created = apiJson(t, 'POST', '/api/v1/posts', jwt, {
        title: 'Separate mode round-trip', slug, type: 'page', status: 'publish', content,
        meta: { _puck_data: JSON.stringify(puck) },
    });
    must(created && created.id, `creating the page failed: ${JSON.stringify(created).slice(0, 400)}`);
    ok(`page created through the gateway (id ${created.id}, slug ${slug})`);

    const readBack = apiJson(t, 'GET', `/api/v1/posts/${created.id}`, jwt);
    must(readBack && String(readBack.id) === String(created.id), `reading the page back failed: ${JSON.stringify(readBack).slice(0, 400)}`);
    must(String(readBack.content || '').includes('wp-block-heading'), `the saved block markup did not come back:\n${String(readBack.content).slice(0, 300)}`);

    const meta = apiJson(t, 'GET', `/api/v1/posts/${created.id}/meta`, jwt);
    const rawPuck = meta && (meta._puck_data ?? (meta.meta && meta.meta._puck_data));
    must(rawPuck, `the editor payload (_puck_data) did not come back: ${JSON.stringify(meta).slice(0, 300)}`);
    const back = typeof rawPuck === 'string' ? JSON.parse(rawPuck) : rawPuck;
    must(Array.isArray(back.content) && back.content.length === puck.content.length,
        `the editor payload came back with ${back.content && back.content.length} blocks, saved ${puck.content.length}`);
    must(back.content.map((b) => b.type).join(',') === puck.content.map((b) => b.type).join(','),
        `the editor payload came back with different blocks: ${back.content.map((b) => b.type).join(',')}`);
    must(back.content[1].props.content === puck.content[1].props.content,
        `block text changed across the round-trip: '${back.content[1].props.content}'`);
    must(back.content[0].props.title === puck.content[0].props.title, `heading text changed across the round-trip`);
    ok(`editor round-trip intact: ${back.content.length} blocks (${back.content.map((b) => b.type).join(', ')}) survived save + read-back`);

    // The new page must also RENDER through the gateway, with its block classes.
    let pageHtml = '', pageCode = '000';
    for (let i = 0; i < 30; i++) {
        pageCode = httpFromHost(`https://${t.gwIp}:3000/${slug}`);
        if (pageCode === '200') {
            pageHtml = bodyFromHost(`https://${t.gwIp}:3000/${slug}`);
            if (/wp-block-/.test(pageHtml)) break;
        }
        sleepSync(3000);
    }
    must(pageCode === '200', `the new page did not render through the gateway (status ${pageCode})`);
    must(/wp-block-/.test(pageHtml), `the new page rendered without any wp-block-* classes`);
    ok(`the new page renders publicly through the gateway with block classes`);
}

/** The site's stored origin options, read straight from the backend node's own database. */
function readOptions(t) {
    const out = ct(BE, `node -e "
const db=require('${APP}/backend/node_modules/better-sqlite3')('${APP}/backend/data/wordjs-native.db',{readonly:true});
const r=db.prepare(\\"select option_name,option_value from options where option_name in ('siteurl','home')\\").all();
console.log(JSON.stringify(Object.fromEntries(r.map(o=>[o.option_name,o.option_value]))));"`).out;
    return JSON.parse(lastLine(out));
}

// --- small API helpers (run from the Proxmox host, i.e. through the gateway like a browser) ---
function login(t) {
    const body = JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS });
    const r = pve(`cat > /tmp/login.json <<'JSONEOF'\n${body}\nJSONEOF\n` +
        `curl -sk --max-time 30 -c /tmp/jar.txt -X POST https://${t.gwIp}:3000/api/v1/auth/login ` +
        `-H 'Content-Type: application/json' -H 'Origin: https://${t.gwIp}:3000' --data @/tmp/login.json >/dev/null; ` +
        `awk '/wordjs_token/ {print $7}' /tmp/jar.txt`, { allowFail: true });
    const jwt = lastLine(r.out).trim();
    if (!jwt || jwt.length < 20) throw new Error(`admin login through the gateway failed: ${r.out.slice(0, 300)}`);
    return jwt;
}
function apiJson(t, method, apiPath, jwt, body) {
    // Bearer + no Origin/Referer is the non-browser API path (see csrfProtection) — no CSRF dance.
    const data = body ? `cat > /tmp/req.json <<'JSONEOF'\n${JSON.stringify(body)}\nJSONEOF\n` : '';
    const dataArg = body ? `--data @/tmp/req.json -H 'Content-Type: application/json'` : '';
    const r = pve(`${data}curl -sk --max-time 60 -X ${method} 'https://${t.gwIp}:3000${apiPath}' ` +
        `-H 'Authorization: Bearer ${jwt}' ${dataArg}`, { allowFail: true });
    const body_ = r.out.trim();
    const start = [body_.indexOf('{'), body_.indexOf('[')].filter((i) => i >= 0).sort((a, b) => a - b)[0];
    try { return JSON.parse(body_.slice(start)); }
    catch { throw new Error(`${method} ${apiPath} did not return JSON: ${r.out.slice(0, 400)}`); }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
async function main() {
    console.log('╔════════════════════════════════════════════════════════════════════════════════════╗');
    console.log('║  WordJS — SEPARATE-MODE GATE  (gateway + backend + frontend, joined over mTLS)      ║');
    console.log('╚════════════════════════════════════════════════════════════════════════════════════╝');
    if (SABOTAGE) console.log(`\n  ⚠  SELF-TEST RUN — fix '${SABOTAGE}' will be reverted in the deployed tree. The gate MUST go red.\n`);

    if (args.teardown) { preflightLite(); teardown(); return; }
    if (args.build) {
        phase('BUILD — npm run bundle-release');
        const r = spawnSync('npm', ['run', 'bundle-release'], { cwd: ROOT, stdio: 'inherit', shell: true });
        if (r.status !== 0) throw new Error('bundle-release failed');
    }

    preflight();

    // The template is keyed to the bundle it was built from: same sha, reuse it (seconds); different
    // sha, rebuild it. That is what guarantees a run always gates the code you just built.
    const bundleSha = createHash('sha256').update(fs.readFileSync(BUNDLE)).digest('hex');
    const sealed = pve(`test -f /etc/pve/lxc/${BASE_CT}.conf && grep -q '^template:' /etc/pve/lxc/${BASE_CT}.conf && ` +
        `cat /var/lib/vz/wjs-gate/base-bundle.sha 2>/dev/null || echo none`).out.trim().split('\n').pop().trim();
    if (args['rebuild-base']) { log('--rebuild-base given'); buildBaseTemplate(bundleSha); }
    else if (sealed !== bundleSha) { log(`base template is stale (has ${sealed.slice(0, 12)}…, need ${bundleSha.slice(0, 12)}…) — rebuilding`); buildBaseTemplate(bundleSha); }
    else log(`base template CT ${BASE_CT} already carries this bundle (${bundleSha.slice(0, 12)}…) — reusing it`);

    teardown();                       // start from a clean slate even after an aborted run
    const ips = cloneTopology();
    prepareNodes(bundleSha);
    const t = bringUp(ips);

    await check(1, 'ENROLLMENT — the gateway is the CA, tokens are single-use, nodes get role certs', (a) => check1Enrollment(t, a));
    await check(2, 'MUTUAL TLS — no cert refused, cert accepted, cross-role cert rejected', (a) => check2Mtls(t, a));
    await check(3, 'INSTALL — through the gateway, public origin correct, no 409 afterwards', (a) => check3Install(t, a));
    await check(4, 'IDENTITY — survives the install and a restart, CA key never on the backend', (a) => check4Identity(t, a));
    await check(5, 'PUBLIC SITE — complete HTML + /public assets + editor round-trip', (a) => check5PublicSite(t, a));

    console.log('\n╔════════════════════════════════════════════════════════════════════════════════════╗');
    console.log('║  GATE GREEN — separate mode works end to end                                       ║');
    console.log('╚════════════════════════════════════════════════════════════════════════════════════╝');
    for (const r of results) console.log(`  CHECK ${r.no}  ${String((r.ms / 1000).toFixed(1) + 's').padStart(7)}  ${r.name}`);
    console.log(`\n  topology: gateway ${t.gwIp} · backend ${t.beIp} · frontend ${t.feIp}`);
    console.log(`  total: ${((Date.now() - T0) / 1000 / 60).toFixed(1)} min\n`);
}

function preflightLite() { if (!fs.existsSync(SSH_KEY)) throw new Error(`ssh key not found: ${SSH_KEY}`); }

main()
    .then(() => { if (!args.keep && !args.teardown) teardown(); process.exit(0); })
    .catch((e) => {
        console.log('\n╔════════════════════════════════════════════════════════════════════════════════════╗');
        if (e instanceof GateFailure) {
            console.log('║  GATE RED                                                                          ║');
            console.log('╚════════════════════════════════════════════════════════════════════════════════════╝');
            console.log(`\n  CHECK ${e.checkNo} FAILED — ${e.checkName}\n`);
            console.log(`  ${e.message}\n`);
            for (const r of results) console.log(`  CHECK ${r.no}  passed`);
            // The three service logs are what an operator would reach for next, and they are about to
            // be destroyed with the containers — so print them here rather than make the failure
            // un-diagnosable without a --keep re-run.
            try { for (const id of RUNTIME_CTS) console.log(`\n${logsOf(id)}`); } catch { /* nodes may be gone */ }
        } else {
            console.log('║  GATE RED — the topology could not be brought up                                   ║');
            console.log('╚════════════════════════════════════════════════════════════════════════════════════╝');
            console.log(`\n  ${e.message}\n`);
        }
        console.log(`  total: ${((Date.now() - T0) / 1000 / 60).toFixed(1)} min`);
        if (args.keep) console.log('  (--keep: the containers were left running for inspection)');
        else { try { teardown(); } catch { /* best effort */ } }
        process.exit(1);
    });
