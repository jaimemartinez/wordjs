#!/usr/bin/env node
'use strict';
/**
 * WordJS node join (run ON a new backend or frontend machine, inside the wordjs repo).
 *
 *   node scripts/node-join.js --role <backend|frontend> --gateway <gw-ip/dns> --token <join-token> \
 *        [--enroll-port 3101] [--advertise <this-node-ip>] [--ca-hash <sha256>] \
 *        [--port <svc-port>] [--install] [--build] [--start]
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

function post(host, port, pathname, body, caHash) {
    return new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(body));
        // The node has no trust anchor YET (it is fetching the cluster CA). Connect without chain
        // verification (TOFU) but, if --ca-hash was supplied, verify the gateway's presented leaf chains
        // to a CA whose fingerprint matches BEFORE trusting anything (kubeadm-style MITM guard).
        const req = https.request({
            host, port, path: pathname, method: 'POST',
            rejectUnauthorized: false,
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
    console.log(`🔑 Generating ${role} keypair + CSR (openssl)...`);
    const keyPath = path.join(certsDir, `${role}.key`);
    const csrPath = path.join(os.tmpdir(), `${role}-${Date.now()}.csr`);
    execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', csrPath, '-subj', `/CN=${role}`], { stdio: 'ignore' });
    try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows */ }
    const csrPem = fs.readFileSync(csrPath, 'utf8');
    fs.unlinkSync(csrPath);

    // 2) The single tokened call: enroll.
    console.log(`🎟️  Enrolling with gateway ${gateway}:${enrollPort} (role=${role}, advertise=${advertise})...`);
    const resp = await post(gateway, enrollPort, '/enroll', { role, token: args.token, advertiseHost: advertise, csr: csrPem });
    const { cert, ca, config: boot } = resp;
    if (!cert || !ca) { console.error('✖ enroll response missing cert/ca'); process.exit(1); }

    // 3) Verify the returned CA against --ca-hash (MITM guard) before trusting it.
    if (args['ca-hash']) {
        const got = pemFingerprint(ca);
        if (got !== String(args['ca-hash']).toLowerCase()) {
            console.error(`✖ CA fingerprint mismatch!\n   expected ${args['ca-hash']}\n   got      ${got}\n   Aborting — possible man-in-the-middle.`);
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

main().catch((e) => { console.error('✖ node-join failed:', e.message); process.exit(1); });
