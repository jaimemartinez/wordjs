#!/usr/bin/env node
/**
 * Generate the Ed25519 key pair that signs the marketplace catalog.
 *
 *   node backend/scripts/generate-marketplace-signing-key.js [--out <private-key-file>] [--force]
 *
 * - Writes the PRIVATE key (PKCS#8 PEM, mode 0600) to --out (default: ./marketplace-signing-key.pem in
 *   the current directory). Keep that file OUT of git: store it in the repository secret
 *   MARKETPLACE_SIGNING_KEY and in your own offline backup, then delete the local copy.
 * - Prints the PUBLIC key (base64 SPKI DER, one line) to paste into OFFICIAL_CATALOG_PUBLIC_KEY in
 *   backend/src/routes/marketplace.ts.
 *
 * Refuses to overwrite an existing file unless --force is given, so a key in use is never lost by
 * re-running the command.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function arg(name) {
    const i = process.argv.indexOf(name);
    return i !== -1 ? process.argv[i + 1] : undefined;
}

const out = path.resolve(arg('--out') || 'marketplace-signing-key.pem');
const force = process.argv.includes('--force');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

// The open itself decides whether the file may be written: 'wx' fails if it already exists (no separate
// existence check that could go stale before the write), and the mode is set on the descriptor we hold.
let fd;
try {
    fd = fs.openSync(out, force ? 'w' : 'wx', 0o600);
} catch (e) {
    if (e && e.code === 'EEXIST') {
        console.error(`✗ ${out} already exists. Pass --force to overwrite it (the old key would stop verifying).`);
        process.exit(1);
    }
    throw e;
}
try {
    try { fs.fchmodSync(fd, 0o600); } catch { /* best-effort on Windows */ }
    fs.writeSync(fd, privatePem);
} finally {
    fs.closeSync(fd);
}

console.log(`Private key written to: ${out}`);
console.log('  -> Do NOT commit it. Put its full contents (including the BEGIN/END lines) in the GitHub');
console.log('     repository secret MARKETPLACE_SIGNING_KEY, keep an offline backup, then delete this file.');
console.log('');
console.log('Public key (paste as OFFICIAL_CATALOG_PUBLIC_KEY in backend/src/routes/marketplace.ts):');
console.log(publicB64);
