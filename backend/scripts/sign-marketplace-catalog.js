#!/usr/bin/env node
/**
 * Sign marketplace catalog files with the Ed25519 private key (detached signature).
 *
 *   node backend/scripts/sign-marketplace-catalog.js <index.json> [<index.json> ...] [--key <file>] [--verify <public-key>]
 *
 * For every file given, writes `<file>.sig`: the base64 Ed25519 signature over the file's exact bytes.
 * This is the format routes/marketplace.ts (core/marketplace-signature) verifies.
 *
 * The private key (PKCS#8 PEM, as written by generate-marketplace-signing-key.js) is read from --key, or
 * from the MARKETPLACE_SIGNING_KEY environment variable when --key is absent. With neither, the script
 * prints a notice and exits 0 WITHOUT signing, so CI can call it unconditionally and it is a no-op
 * until the secret exists.
 *
 * Every signature is verified right after it is written (against the key's own public half, and
 * additionally against --verify when given), so a broken signature never reaches a release.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function parsePublic(text) {
    const raw = String(text || '').trim();
    if (raw.includes('-----BEGIN')) return crypto.createPublicKey({ key: raw, format: 'pem' });
    const der = Buffer.from(raw, 'base64');
    return crypto.createPublicKey({ key: der.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, der]) : der, format: 'der', type: 'spki' });
}

const argv = process.argv.slice(2);
const files = [];
let keyFile;
let verifyKey;
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--key') keyFile = argv[++i];
    else if (argv[i] === '--verify') verifyKey = argv[++i];
    else files.push(argv[i]);
}

if (!files.length) {
    console.error('usage: sign-marketplace-catalog.js <index.json> [...] [--key <private-key.pem>] [--verify <public-key>]');
    process.exit(2);
}

const pem = keyFile ? fs.readFileSync(path.resolve(keyFile), 'utf8') : String(process.env.MARKETPLACE_SIGNING_KEY || '');

if (!pem.trim()) {
    console.log('MARKETPLACE_SIGNING_KEY is not set and no --key was given: catalog NOT signed (sites will report it as unsigned).');
    process.exit(0);
}

let privateKey;
try {
    privateKey = crypto.createPrivateKey({ key: pem, format: 'pem' });
} catch (e) {
    console.error(`✗ the signing key could not be read: ${e.message}`);
    process.exit(1);
}
if (privateKey.asymmetricKeyType !== 'ed25519') {
    console.error(`✗ the signing key is ${privateKey.asymmetricKeyType}, not ed25519.`);
    process.exit(1);
}
const ownPublic = crypto.createPublicKey(privateKey);
const extraPublic = verifyKey ? parsePublic(verifyKey) : null;

for (const f of files) {
    const abs = path.resolve(f);
    const bytes = fs.readFileSync(abs);
    const sig = crypto.sign(null, bytes, privateKey);
    const sigText = sig.toString('base64');
    fs.writeFileSync(`${abs}.sig`, `${sigText}\n`);
    if (!crypto.verify(null, bytes, ownPublic, sig)) {
        console.error(`✗ self-check failed for ${f}`);
        process.exit(1);
    }
    if (extraPublic && !crypto.verify(null, bytes, extraPublic, sig)) {
        console.error(`✗ ${f}: the signature does not verify against the --verify public key (wrong key pair?)`);
        process.exit(1);
    }
    console.log(`signed ${path.basename(abs)} -> ${path.basename(abs)}.sig`);
}

console.log(`public key of this signer: ${ownPublic.export({ type: 'spki', format: 'der' }).toString('base64')}`);
