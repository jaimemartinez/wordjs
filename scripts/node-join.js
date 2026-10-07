#!/usr/bin/env node
'use strict';
/**
 * WordJS node join (run ON a new backend or frontend machine, inside the wordjs repo).
 *
 *   node scripts/node-join.js --role <backend|frontend> --gateway <gw-ip/dns> --token <join-token> \
 *        --ca-hash <sha256> [--enroll-port 3101] [--advertise <this-node-ip>] \
 *        [--port <svc-port>] [--install] [--build] [--start]
 *
 * --ca-hash (the cluster CA fingerprint `cluster.js token`/`info` prints on the gateway) is REQUIRED:
 * the gateway's TLS certificate must chain to that exact CA before the token is sent. Enrolling without
 * it would be trust-on-first-use — an on-path attacker would receive the token, the cluster's gateway
 * secret and a CA-signed cert — so there is deliberately no way to enroll without it.
 *
 * It performs the ONE tokened call to the gateway's /enroll endpoint: generates a keypair + CSR with
 * openssl, sends {role, token, advertiseHost, csr}, and receives a signed CN=<role> mTLS cert + the
 * cluster CA + the shared bootstrap config back. It then writes <role>/certs/* and a ready-to-run
 * <role>/wordjs-config.json, and (optionally) installs deps, builds, and starts the service — which
 * then registers itself with the gateway over mTLS. No certs are ever hand-copied.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) { const k = a.slice(2); const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; out[k] = v; }
        else out._.push(a);
    }
    return out;
}
function firstLanIp() {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const i of ifaces || []) if (!i.internal && (i.family === 'IPv4' || i.family === 4)) return i.address;
    }
    return '127.0.0.1';
}
function readJson(p, fb = {}) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function writeJson(p, o) { fs.writeFileSync(p, JSON.stringify(o, null, 2)); }

// The CN the gateway's own identity cert carries (scripts/cluster.js init). Enrollment FORCES CN=<role>
// on every node cert, so a cluster-CA cert with this CN can only have been minted on the gateway.
const GATEWAY_CN = 'gateway-internal';

/** Lower-case 64-char hex, or null. Accepts the `AA:BB:…` colon form some tools print. */
function normalizeCaHash(value) {
    const hex = String(value == null || value === true ? '' : value).trim().replace(/:/g, '').toLowerCase();
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

function derToPem(der) {
    return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * Phase 1 of a pinned enrollment: obtain the cluster CA certificate from the TLS chain the enroll
 * listener presents (it sends leaf + CA), and keep it ONLY if its SHA-256 equals --ca-hash. Nothing is
 * sent on this connection, and nothing it returns is trusted beyond "these bytes hash to the pin" —
 * the request that carries the token (phase 2) is then fully verified against that CA.
 */
function fetchPinnedCa(host, port, caHash, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({
            host, port, rejectUnauthorized: false,
            servername: require('net').isIP(host) ? undefined : host,
        }, () => {
            const seen = [];
            let cert = socket.getPeerCertificate(true);
            while (cert && cert.raw && !seen.includes(cert)) {
                seen.push(cert);
                if (crypto.createHash('sha256').update(cert.raw).digest('hex') === caHash) {
                    socket.destroy();
                    return resolve(derToPem(cert.raw));
                }
                cert = cert.issuerCertificate;
            }
            socket.destroy();
            reject(new Error('the gateway did not present a cluster CA matching --ca-hash in its TLS chain.\n'
                + '   Either the fingerprint is wrong, something is intercepting this connection, or the gateway\n'
                + '   predates CA-chained enrollment (upgrade it). Aborting — the token was NOT sent.'));
        });
        socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`timed out connecting to ${host}:${port}`)));
        socket.on('error', reject);
    });
}

/**
 * The single tokened call. With `ca` (the pinned cluster CA), the server certificate MUST chain to
 * exactly that CA (full OpenSSL verification, rejectUnauthorized) and carry CN=gateway-internal — so
 * the token and the secrets in the response can only reach the real gateway. The host name is not
 * matched against the cert's SANs: operators dial the gateway by whatever address routes, and the
 * pinned CA + gateway-only CN already identify it. There is no unverified variant.
 */
function post(host, port, pathname, body, { ca = null } = {}) {
    if (!ca) return Promise.reject(new Error('refusing to enroll without a pinned cluster CA'));
    return new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(body));
        const tlsOpts = {
            ca, rejectUnauthorized: true,
            checkServerIdentity: (_host, cert) => (cert && cert.subject && cert.subject.CN === GATEWAY_CN
                ? undefined
                : new Error(`enroll server certificate is not the gateway's (CN=${cert && cert.subject ? cert.subject.CN : '?'}, expected ${GATEWAY_CN})`)),
        };
        const req = https.request({
            host, port, path: pathname, method: 'POST', agent: false, ...tlsOpts,
            headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                let json; try { json = JSON.parse(data); } catch { json = { raw: data }; }
                if (res.statusCode !== 200) return reject(new Error(`enroll ${res.statusCode}: ${json.error || data}`));
                resolve(json);
            });
        });
        req.on('error', reject);
        req.write(payload); req.end();
    });
}

// sha256 fingerprint (hex) of a PEM cert's DER — same recipe as the gateway's caFingerprint.
function pemFingerprint(pem) {
    const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
    return crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const role = args.role;
    if (!['backend', 'frontend'].includes(role)) { console.error('✖ --role must be backend or frontend'); process.exit(1); }
    if (!args.gateway || !args.token) { console.error('✖ --gateway and --token are required'); process.exit(1); }
    const caHash = args['ca-hash'] === undefined ? null : normalizeCaHash(args['ca-hash']);
    if (args['ca-hash'] !== undefined && !caHash) {
        console.error(`✖ --ca-hash must be the 64-character hex CA fingerprint (got "${args['ca-hash'] === true ? '' : args['ca-hash']}")`);
        process.exit(1);
    }
    if (!caHash) {
        console.error('✖ --ca-hash <sha256> is required: the cluster CA fingerprint printed on the gateway by');
        console.error('  `node scripts/cluster.js token <role>` (or `node scripts/cluster.js info`).');
        console.error('  Without it the gateway cannot be authenticated and an on-path attacker would receive the token,');
        console.error('  the cluster secret and a signed cert.');
        process.exit(1);
    }

    const gateway = args.gateway;
    const enrollPort = Number(args['enroll-port'] || 3101);
    const advertise = args.advertise || firstLanIp();
    const svcPort = Number(args.port || (role === 'backend' ? 4000 : 3001));
    const roleDir = path.join(ROOT, role);
    const certsDir = path.join(roleDir, 'certs');
    if (!fs.existsSync(roleDir)) { console.error(`✖ ${roleDir} not found — run this inside the wordjs repo on the ${role} machine.`); process.exit(1); }
    fs.mkdirSync(certsDir, { recursive: true });

    // 1) Generate this node's private key + CSR with openssl (no node deps needed pre-install). The CN we
    //    request is cosmetic — the gateway FORCES CN=<role> from the token, so it cannot be spoofed here.
    //    `-sha256` is explicit because sha256WithRSAEncryption is the only CSR signature algorithm the
    //    gateway accepts (gateway/src/cluster-ca.js); a host openssl.cnf with another default_md must
    //    not turn into a refused enrolment.
    console.log(`🔑 Generating ${role} keypair + CSR (openssl)...`);
    const keyPath = path.join(certsDir, `${role}.key`);
    const csrPath = path.join(os.tmpdir(), `${role}-${Date.now()}.csr`);
    execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', keyPath, '-out', csrPath, '-subj', `/CN=${role}`], { stdio: 'ignore' });
    try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows */ }
    const csrPem = fs.readFileSync(csrPath, 'utf8');
    fs.unlinkSync(csrPath);

    // 2) Authenticate the gateway BEFORE the token leaves this machine: fetch the CA from its TLS chain,
    //    keep it only if it hashes to --ca-hash, then make the tokened call verified against it.
    console.log(`🔒 Verifying gateway ${gateway}:${enrollPort} against the pinned cluster CA...`);
    const pinnedCa = await fetchPinnedCa(gateway, enrollPort, caHash);
    console.log('   ✓ gateway presents the pinned cluster CA');

    // 3) The single tokened call: enroll.
    console.log(`🎟️  Enrolling with gateway ${gateway}:${enrollPort} (role=${role}, advertise=${advertise})...`);
    const resp = await post(gateway, enrollPort, '/enroll', { role, token: args.token, advertiseHost: advertise, csr: csrPem },
        { ca: pinnedCa });
    const { cert, ca, config: boot } = resp;
    if (!cert || !ca) { console.error('✖ enroll response missing cert/ca'); process.exit(1); }

    // The CA handed back must be the same pinned CA (belt-and-braces: the channel was already verified).
    if (caHash) {
        const got = pemFingerprint(ca);
        if (got !== caHash) {
            console.error(`✖ CA fingerprint mismatch!\n   expected ${caHash}\n   got      ${got}\n   Aborting — possible man-in-the-middle.`);
            process.exit(1);
        }
        console.log('   ✓ CA fingerprint verified');
    }

    // 4) Write cert material.
    fs.writeFileSync(path.join(certsDir, 'cluster-ca.crt'), ca);
    fs.writeFileSync(path.join(certsDir, `${role}.crt`), cert);
    console.log(`   ✓ wrote ${role}/certs/{${role}.key,${role}.crt,cluster-ca.crt}`);

    // 5) Write the node's wordjs-config.json.
    const cfgPath = path.join(roleDir, 'wordjs-config.json');
    const cfg = readJson(cfgPath, {});
    Object.assign(cfg, {
        gatewayHost: gateway,
        gatewayInternalPort: boot.gatewayInternalPort || 3100,
        gatewayPort: boot.gatewayPort || 3000,
        gatewaySecret: boot.gatewaySecret,
        gatewaySsl: { enabled: true },
        siteUrl: boot.siteUrl,
        advertiseHost: advertise,
        mtls: { ca: './certs/cluster-ca.crt', key: `./certs/${role}.key`, cert: `./certs/${role}.crt` }
    });
    // Cache-purge secret, minted by the gateway and handed to BOTH roles at enrollment. The frontend
    // authenticates purge requests with it (from this file, on this machine — never from the backend's
    // config, which lives on another host); a co-located backend signs its direct purges with it.
    if (boot.revalidateSecret) cfg.revalidateSecret = boot.revalidateSecret;
    if (role === 'backend') {
        cfg.host = '0.0.0.0';                 // accept the gateway from another machine
        cfg.port = svcPort;
        if (!cfg.jwtSecret) cfg.jwtSecret = crypto.randomBytes(64).toString('hex');
    } else {
        cfg.port = svcPort;
        cfg.frontendUrl = `https://${advertise}:${svcPort}`;
        // Frontend SSR reaches the backend THROUGH the gateway's public origin, whose cert is issued from
        // the cluster CA the frontend now trusts (start-frontend sets NODE_EXTRA_CA_CERTS).
        cfg.internalApiUrl = `${boot.siteUrl}/api/v1`;
    }
    cfg.updatedAt = new Date().toISOString();
    writeJson(cfgPath, cfg);
    console.log(`   ✓ wrote ${role}/wordjs-config.json (advertiseHost=${advertise}, gatewayHost=${gateway})`);

    // 6) Optional install / build / start.
    const run = (cmd, cwd) => execFileSync('npm', cmd, { cwd, stdio: 'inherit', shell: true });
    if (args.install) { console.log('📦 npm install...'); run(['install'], roleDir); }
    if (args.build && role === 'frontend') { console.log('🏗️  next build...'); run(['run', 'build'], roleDir); }
    if (args.build && role === 'backend') { console.log('🏗️  tsc build...'); try { run(['run', 'build'], roleDir); } catch { console.warn('   (build failed — server.js will fall back to ts-node)'); } }
    if (args.start) {
        const logFile = path.join(roleDir, 'cluster-start.log');
        const out = fs.openSync(logFile, 'a');
        const child = spawn('npm', ['start'], { cwd: roleDir, detached: true, stdio: ['ignore', out, out], shell: true });
        child.unref();
        console.log(`🚀 ${role} started (detached) — logs: ${logFile} (pid ${child.pid})`);
    }

    console.log(`\n✅ ${role} enrolled and configured. It will register with the gateway on start.`);
}

// Run only when invoked as a script, so the enrollment helpers can be required and tested.
if (require.main === module) {
    main().catch((e) => { console.error('✖ node-join failed:', e.message); process.exit(1); });
}

module.exports = { parseArgs, normalizeCaHash, fetchPinnedCa, post, pemFingerprint, GATEWAY_CN };
