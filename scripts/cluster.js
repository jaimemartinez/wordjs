#!/usr/bin/env node
'use strict';
/**
 * WordJS cluster control (run ON the gateway machine).
 *
 *   node scripts/cluster.js init   [--host <gw-ip/dns>] [--bind <ip>] [--port 3000]
 *                                  [--internal-port 3100] [--enroll-port 3101] [--site-url <url>]
 *   node scripts/cluster.js token  <backend|frontend> [--host <node-ip>] [--ttl <minutes>]
 *   node scripts/cluster.js tokens                       # list outstanding tokens
 *   node scripts/cluster.js revoke-tokens                # burn all outstanding tokens
 *   node scripts/cluster.js info                         # show CA fingerprint + endpoints
 *
 * `init` mints the cluster CA (keeping the CA key, 0600) + the gateway's own identity cert and writes a
 * multi-node gateway-config.json (routable internal bind, ports, shared secret). Then `token` mints a
 * single-use join token and prints the exact `node:join` command to paste on the new machine.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GW = path.join(ROOT, 'gateway');
const CERTS = path.join(GW, 'certs');
const CONFIG = path.join(GW, 'gateway-config.json');
const REGISTRY = path.join(GW, 'gateway-registry.json');
const TOKENS = path.join(GW, 'cluster-tokens.json');

const ca = require(path.join(GW, 'src', 'cluster-ca.js'));
const crypto = require('crypto');

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) { const k = a.slice(2); const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; out[k] = v; }
        else out._.push(a);
    }
    return out;
}

function readJson(p, fallback = {}) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function firstLanIp() {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const i of ifaces || []) {
            if (!i.internal && (i.family === 'IPv4' || i.family === 4)) return i.address;
        }
    }
    return '127.0.0.1';
}

function cmdInit(args) {
    const host = args.host || firstLanIp();
    const bind = args.bind || host;             // internal control plane binds the routable iface (NOT 0.0.0.0)
    const port = Number(args.port || 3000);
    const internalPort = Number(args['internal-port'] || 3100);
    const enrollPort = Number(args['enroll-port'] || (internalPort + 1));
    const siteUrl = args['site-url'] || `https://${host}:${port}`;

    console.log(`🔐 Initializing WordJS cluster gateway on host ${host} ...`);
    const { caCertPem, caKeyPem, created } = ca.ensureClusterCA(CERTS);
    console.log(created ? '   • cluster CA generated (key kept 0600 on this gateway)' : '   • existing cluster CA reused');

    // Gateway's own identity cert (server+client). SANs cover the advertise host + internal bind so both
    // the public listener and the internal mTLS server validate.
    const { keyPem, certPem } = ca.issueIdentity({
        caKeyPem, caCertPem, cn: 'gateway-internal',
        sans: [host, bind, 'localhost'].filter(Boolean)
    });
    fs.writeFileSync(path.join(CERTS, 'gateway-internal.key'), keyPem, { mode: 0o600 });
    try { fs.chmodSync(path.join(CERTS, 'gateway-internal.key'), 0o600); } catch { /* Windows */ }
    fs.writeFileSync(path.join(CERTS, 'gateway-internal.crt'), certPem);
    console.log('   • gateway-internal identity cert issued');

    // Public front-door cert, ALSO signed by the cluster CA. A separate-machine frontend trusts
    // cluster-ca.crt (via NODE_EXTRA_CA_CERTS), so it can validate the gateway's public origin for
    // server-side (SSR) fetches without disabling TLS verification.
    const sslDir = path.join(GW, 'ssl');
    fs.mkdirSync(sslDir, { recursive: true });
    const pub = ca.issueIdentity({ caKeyPem, caCertPem, cn: host, sans: [host, bind, 'localhost'].filter(Boolean) });
    fs.writeFileSync(path.join(sslDir, 'cluster-public.key'), pub.keyPem, { mode: 0o600 });
    try { fs.chmodSync(path.join(sslDir, 'cluster-public.key'), 0o600); } catch { /* Windows */ }
    fs.writeFileSync(path.join(sslDir, 'cluster-public.crt'), pub.certPem);
    console.log('   • public front-door cert issued (cluster-CA-signed)');

    const cfg = readJson(CONFIG, {});
    cfg.gatewaySecret = cfg.gatewaySecret && cfg.gatewaySecret !== 'secure-your-gateway-secret'
        ? cfg.gatewaySecret : crypto.randomBytes(32).toString('hex');
    // Cache-purge secret: cluster-wide, so the gateway owns it and enrollment hands the same value to
    // every node (the frontend authenticates purges with it from ITS OWN config; the gateway presents it
    // when fanning a backend's purge out to the frontends). Minted here so it exists before any node
    // joins; the gateway also mints it lazily for clusters initialized before this existed.
    if (!cfg.revalidateSecret) cfg.revalidateSecret = crypto.randomBytes(32).toString('hex');
    cfg.gatewayPort = port;
    cfg.gatewayInternalPort = internalPort;
    cfg.gatewayEnrollPort = enrollPort;
    cfg.gatewayInternalBind = bind;
    cfg.gatewayAdvertiseHost = host;
    cfg.siteUrl = siteUrl;
    cfg.ssl = { enabled: true, key: './ssl/cluster-public.key', cert: './ssl/cluster-public.crt' };
    cfg.updatedAt = new Date().toISOString();
    writeJson(CONFIG, cfg);
    console.log('   • gateway-config.json written (multi-node profile)');

    // Start from an empty registry so no stale localhost targets are served before nodes register.
    writeJson(REGISTRY, {});
    console.log('   • gateway-registry.json cleared (targets come from live registration)');

    const fp = ca.caFingerprint(caCertPem);
    console.log('\n✅ Gateway cluster initialized.');
    console.log(`   CA fingerprint (sha256): ${fp}`);
    console.log(`   Public:   https://${host}:${port}`);
    console.log(`   Internal: ${bind}:${internalPort} (mTLS register)   Enroll: ${bind}:${enrollPort} (token)`);
    console.log('\nNext: start the gateway, then mint join tokens:');
    console.log('   node scripts/cluster.js token backend  --host <backend-ip>');
    console.log('   node scripts/cluster.js token frontend --host <frontend-ip>');
}

function cmdToken(args) {
    const role = args._[0];
    if (!['backend', 'frontend'].includes(role)) {
        console.error("Usage: cluster.js token <backend|frontend> [--host <node-ip>] [--ttl <minutes>]");
        process.exit(1);
    }
    const cfg = readJson(CONFIG, {});
    if (!fs.existsSync(path.join(CERTS, 'cluster-ca.key'))) {
        console.error('✖ No cluster CA found. Run `node scripts/cluster.js init` on the gateway first.');
        process.exit(1);
    }
    const ttlMin = Number(args.ttl || 60);
    const store = ca.tokenStore(TOKENS);
    const raw = store.mint(role, { ttlMs: ttlMin * 60000, host: args.host || null });

    const gwHost = cfg.gatewayAdvertiseHost || firstLanIp();
    const enrollPort = cfg.gatewayEnrollPort || ((cfg.gatewayInternalPort || 3100) + 1);
    const fp = ca.caFingerprint(fs.readFileSync(path.join(CERTS, 'cluster-ca.crt'), 'utf8'));

    console.log(`🎟️  Join token for role '${role}' (valid ${ttlMin} min, single use):\n`);
    console.log(`   ${raw}\n`);
    console.log('Run this on the new ' + role + ' machine (in the wordjs repo dir):\n');
    const adv = args.host ? ` --advertise ${args.host}` : ' --advertise <this-node-ip>';
    console.log(`   node scripts/node-join.js --role ${role} --gateway ${gwHost} \\`);
    console.log(`        --enroll-port ${enrollPort} --token ${raw} \\`);
    console.log(`        --ca-hash ${fp}${adv} --start\n`);
}

function cmdTokens() {
    const store = ca.tokenStore(TOKENS);
    const list = store.list();
    if (!list.length) return console.log('(no tokens)');
    for (const t of list) console.log(`${t.role.padEnd(9)} host=${t.host || '-'} used=${t.used} expired=${t.expired} exp=${t.expiresAt}`);
}

function cmdInfo() {
    const cfg = readJson(CONFIG, {});
    const caPath = path.join(CERTS, 'cluster-ca.crt');
    if (!fs.existsSync(caPath)) return console.log('Gateway not initialized (no cluster CA). Run: cluster.js init');
    console.log('CA fingerprint:', ca.caFingerprint(fs.readFileSync(caPath, 'utf8')));
    console.log('Advertise host:', cfg.gatewayAdvertiseHost);
    console.log('Public port   :', cfg.gatewayPort);
    console.log('Internal bind :', cfg.gatewayInternalBind, 'port', cfg.gatewayInternalPort);
    console.log('Enroll port   :', cfg.gatewayEnrollPort);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._.shift();
switch (cmd) {
    case 'init': cmdInit(args); break;
    case 'token': cmdToken(args); break;
    case 'tokens': cmdTokens(); break;
    case 'revoke-tokens': ca.tokenStore(TOKENS).revokeAll(); console.log('All tokens revoked.'); break;
    case 'info': cmdInfo(); break;
    default:
        console.log('WordJS cluster control');
        console.log('  init | token <role> | tokens | revoke-tokens | info');
}
