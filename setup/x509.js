'use strict';
/**
 * WordJS X.509 toolkit — builds and signs certificates and certification requests, and parses a
 * certification request, with Node's own crypto doing every cryptographic step (key generation,
 * signing, signature verification, key parsing). No third-party code.
 *
 * WHY HAND-WRITTEN DER. node-forge (the previous engine) has unfixed advisories and no maintained
 * release. The maintained alternatives (@peculiar/x509, pkijs) are WebCrypto-only — every call is
 * async — and pull ten-plus transitive packages, while the callers here are synchronous (the cluster
 * CLI, the installer, the gateway's /enroll handler) and need exactly ONE certificate shape: a
 * version-3 certificate with basicConstraints, keyUsage, extKeyUsage and subjectAltName. That shape is
 * a fixed DER template; what has to be right is the cryptography, and that is OpenSSL's (crypto.sign,
 * crypto.verify, crypto.createPublicKey). Every certificate produced is re-read by OpenSSL
 * (crypto.X509Certificate) and its signature checked before it is returned, so a malformed encoding
 * can never leave this module.
 *
 * THIS FILE EXISTS THREE TIMES, BYTE FOR BYTE: gateway/src/x509.js, setup/x509.js and
 * backend/src/core/x509.js — each package installs and ships on its own (a cluster node may run only
 * one of them). backend/src/tests/x509-toolkit.test.ts fails if the copies drift apart.
 */
const crypto = require('crypto');
const net = require('net');

// ─── DER encoding ────────────────────────────────────────────────────────────────────────────────

function derLength(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, ...parts) {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const NULL = Buffer.from([0x05, 0x00]);

function oid(dotted) {
    const arcs = String(dotted).split('.').map((a) => {
        if (!/^\d+$/.test(a)) throw new Error(`Invalid OID ${dotted}`);
        return BigInt(a);
    });
    if (arcs.length < 2 || arcs[0] > 2n || (arcs[0] < 2n && arcs[1] > 39n)) throw new Error(`Invalid OID ${dotted}`);
    const out = [];
    const push = (v) => {
        const chunk = [Number(v & 0x7fn)];
        v >>= 7n;
        while (v > 0n) { chunk.unshift(Number(v & 0x7fn) | 0x80); v >>= 7n; }
        out.push(...chunk);
    };
    push(arcs[0] * 40n + arcs[1]);
    for (const a of arcs.slice(2)) push(a);
    return tlv(0x06, Buffer.from(out));
}

// A non-negative INTEGER from big-endian magnitude bytes, minimally encoded (DER: no redundant leading
// zero byte, and one zero byte when the high bit is set so it stays positive).
function uint(bytes) {
    let b = Buffer.from(bytes);
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.subarray(i);
    if (b.length === 0) b = Buffer.from([0]);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return tlv(0x02, b);
}

const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const octets = (buf) => tlv(0x04, buf);
const bitString = (buf, unused = 0) => tlv(0x03, Buffer.from([unused]), buf);
const utf8 = (s) => tlv(0x0c, Buffer.from(String(s), 'utf8'));
const printable = (s) => tlv(0x13, Buffer.from(String(s), 'ascii'));
const explicit = (n, inner) => tlv(0xa0 | n, inner);

// RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050. Whole seconds, Zulu.
function time(date) {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) throw new Error('Invalid certificate date');
    const iso = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
    const digits = iso.slice(0, 19).replace(/[-T:]/g, '') + 'Z'; // YYYYMMDDHHMMSSZ
    const year = d.getUTCFullYear();
    if (year >= 1950 && year < 2050) return tlv(0x17, Buffer.from(digits.slice(2), 'ascii'));
    return tlv(0x18, Buffer.from(digits, 'ascii'));
}

const OID = {
    commonName: '2.5.4.3',
    countryName: '2.5.4.6',
    localityName: '2.5.4.7',
    stateOrProvinceName: '2.5.4.8',
    organizationName: '2.5.4.10',
    organizationalUnitName: '2.5.4.11',
    rsaEncryption: '1.2.840.113549.1.1.1',
    sha256WithRSAEncryption: '1.2.840.113549.1.1.11',
    sha384WithRSAEncryption: '1.2.840.113549.1.1.12',
    sha512WithRSAEncryption: '1.2.840.113549.1.1.13',
    sha1WithRSAEncryption: '1.2.840.113549.1.1.5',
    ecdsaWithSHA256: '1.2.840.10045.4.3.2',
    extensionRequest: '1.2.840.113549.1.9.14',
    basicConstraints: '2.5.29.19',
    keyUsage: '2.5.29.15',
    extKeyUsage: '2.5.29.37',
    subjectAltName: '2.5.29.17',
    subjectKeyIdentifier: '2.5.29.14',
    authorityKeyIdentifier: '2.5.29.35',
    serverAuth: '1.3.6.1.5.5.7.3.1',
    clientAuth: '1.3.6.1.5.5.7.3.2',
};
const OID_NAMES = new Map(Object.entries(OID).map(([name, dotted]) => [dotted, name]));

// Short attribute names accepted in a subject, mapped to their OID (C is a PrintableString per X.520).
const NAME_ATTRS = { CN: OID.commonName, C: OID.countryName, L: OID.localityName, ST: OID.stateOrProvinceName, O: OID.organizationName, OU: OID.organizationalUnitName };

/**
 * Encode a distinguished name. `name` is either a Buffer (an already-encoded Name, copied verbatim —
 * how an issuer is taken from its CA certificate) or a list of [shortName, value] pairs, one RDN each,
 * in order: [['CN', 'WordJS Cluster Root CA'], ['O', 'WordJS Internal Cluster']].
 */
function encodeName(name) {
    if (Buffer.isBuffer(name)) return name;
    if (!Array.isArray(name) || name.length === 0) throw new Error('A certificate name needs at least one attribute');
    return seq(...name.map(([key, value]) => {
        const attrOid = NAME_ATTRS[key];
        if (!attrOid) throw new Error(`Unsupported name attribute ${key}`);
        if (typeof value !== 'string' || value === '') throw new Error(`Empty name attribute ${key}`);
        return set(seq(oid(attrOid), key === 'C' ? printable(value) : utf8(value)));
    }));
}

const KEY_USAGE_BITS = ['digitalSignature', 'nonRepudiation', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly'];

// keyUsage BIT STRING (RFC 5280 §4.2.1.3): named bits, bit 0 = the high bit of the first byte; DER
// trims trailing zero bits, so the unused-bits count is what follows the highest usage set.
function keyUsageValue(usages) {
    const bits = usages.map((u) => {
        const i = KEY_USAGE_BITS.indexOf(u);
        if (i < 0) throw new Error(`Unknown keyUsage ${u}`);
        return i;
    });
    if (bits.length === 0) throw new Error('keyUsage needs at least one usage');
    const highest = Math.max(...bits);
    const out = Buffer.alloc((highest >> 3) + 1);
    for (const i of bits) out[i >> 3] |= 0x80 >> (i & 7);
    return bitString(out, 7 - (highest & 7));
}

// GeneralName for a SAN entry: an IP literal (v4 or v6) becomes iPAddress [7], anything else dNSName [2].
function generalName(host) {
    const h = String(host).replace(/^\[(.*)\]$/, '$1');
    const family = net.isIP(h);
    if (family === 4) return tlv(0x87, Buffer.from(h.split('.').map(Number)));
    if (family === 6) return tlv(0x87, ipv6Bytes(h));
    // A DNS name, label by label (no nested quantifiers): 1-63 letters, digits or inner hyphens each, a
    // leading `*` label allowed, 253 characters at most, one optional trailing dot.
    const name = h.endsWith('.') ? h.slice(0, -1) : h;
    const labels = name.split('.');
    const ok = name.length > 0 && name.length <= 253 && labels.every((label, i) =>
        (i === 0 && label === '*') || /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
    if (!ok) throw new Error(`Invalid subjectAltName ${JSON.stringify(h)}`);
    return tlv(0x82, Buffer.from(name, 'ascii'));
}

function ipv6Bytes(addr) {
    let a = addr.toLowerCase();
    if (a.includes('%')) throw new Error(`Invalid subjectAltName ${JSON.stringify(addr)}: zone ids are not allowed`);
    // An embedded IPv4 tail (::ffff:10.0.0.5) becomes two hex groups. (net.isIP already validated it.)
    const v4Tail = a.slice(a.lastIndexOf(':') + 1);
    if (v4Tail.includes('.')) {
        const p = v4Tail.split('.').map(Number);
        a = a.slice(0, a.length - v4Tail.length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
    }
    const halves = a.split('::');
    if (halves.length > 2) throw new Error(`Invalid IPv6 address ${addr}`);
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
    const groups = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail];
    if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) throw new Error(`Invalid IPv6 address ${addr}`);
    const out = Buffer.alloc(16);
    groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
    return out;
}

function extension(extOid, critical, value) {
    return seq(oid(extOid), ...(critical ? [bool(true)] : []), octets(value));
}

// ─── Keys ────────────────────────────────────────────────────────────────────────────────────────

const toPrivateKey = (k) => (k instanceof crypto.KeyObject ? k : crypto.createPrivateKey(k));

function toPublicKey(k) {
    if (k instanceof crypto.KeyObject) return k.type === 'private' ? crypto.createPublicKey(k) : k;
    if (Buffer.isBuffer(k)) return crypto.createPublicKey({ key: k, format: 'der', type: 'spki' });
    return crypto.createPublicKey(k);
}

/**
 * A fresh RSA key pair. The PEM is PKCS#1 ("RSA PRIVATE KEY") — the format every key WordJS has ever
 * written — so a key made today is interchangeable with one made by an older release.
 */
function generateRsaKeyPair(bits = 2048) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits, publicExponent: 0x10001 });
    return { privateKey, publicKey, privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }) };
}

// The signature algorithm a key signs with: sha256WithRSAEncryption for RSA, ecdsa-with-SHA256 for
// P-256. (ECDSA AlgorithmIdentifiers carry no parameters — RFC 5758 §3.2 — RSA ones carry NULL.)
function signatureAlgorithm(key) {
    if (key.asymmetricKeyType === 'rsa') return { algId: seq(oid(OID.sha256WithRSAEncryption), NULL), sign: (data) => crypto.sign('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PADDING }) };
    if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve === 'prime256v1') {
        return { algId: seq(oid(OID.ecdsaWithSHA256)), sign: (data) => crypto.sign('sha256', data, { key, dsaEncoding: 'der' }) };
    }
    throw new Error(`Unsupported signing key type ${key.asymmetricKeyType}`);
}

// ─── DER reading (strict, bounds-checked) ────────────────────────────────────────────────────────

/** Read one TLV at `off` inside buf[..limit]. Definite, minimal lengths only (DER). */
function readTlv(buf, off, limit = buf.length) {
    if (off + 2 > limit) throw new Error('Truncated DER');
    const tag = buf[off];
    if ((tag & 0x1f) === 0x1f) throw new Error('Unsupported DER tag');
    let len = buf[off + 1];
    let hdr = 2;
    if (len & 0x80) {
        const n = len & 0x7f;
        if (n === 0 || n > 4) throw new Error('Unsupported DER length');
        if (off + 2 + n > limit) throw new Error('Truncated DER');
        if (buf[off + 2] === 0) throw new Error('Non-minimal DER length');
        len = 0;
        for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
        if (len < 0x80) throw new Error('Non-minimal DER length');
        hdr = 2 + n;
    }
    const end = off + hdr + len;
    if (end > limit) throw new Error('Truncated DER');
    return { tag, start: off, body: off + hdr, end };
}

function expectTag(t, tag, what) {
    if (t.tag !== tag) throw new Error(`Malformed ${what}`);
    return t;
}

function decodeOid(buf) {
    if (buf.length === 0) throw new Error('Malformed OID');
    const arcs = [];
    let v = 0n;
    for (let i = 0; i < buf.length; i++) {
        if (v === 0n && buf[i] === 0x80) throw new Error('Malformed OID');
        v = (v << 7n) | BigInt(buf[i] & 0x7f);
        if (!(buf[i] & 0x80)) { arcs.push(v); v = 0n; }
        else if (i === buf.length - 1) throw new Error('Malformed OID');
    }
    const first = arcs[0] < 80n ? arcs[0] / 40n : 2n;
    return [first, arcs[0] - first * 40n, ...arcs.slice(1)].join('.');
}

const PEM_RE = (label) => new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`);

function pemBody(pem, labels) {
    const text = Buffer.isBuffer(pem) ? pem.toString('utf8') : String(pem);
    for (const label of labels) {
        const m = PEM_RE(label).exec(text);
        if (m) return Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
    }
    throw new Error(`Expected a PEM ${labels[0]}`);
}

function toPem(label, der) {
    return `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}

/**
 * The subject Name of a certificate, as its exact DER bytes — used as the issuer of the certificates
 * that CA signs, so the issuer field matches the CA's subject byte for byte whatever produced the CA
 * (node-forge on an older install, this module, openssl).
 */
function certificateSubject(certPem) {
    const der = pemBody(certPem, ['CERTIFICATE']);
    new crypto.X509Certificate(der); // OpenSSL must accept it before anything is taken from it
    const cert = expectTag(readTlv(der, 0), 0x30, 'certificate');
    const tbs = expectTag(readTlv(der, cert.body, cert.end), 0x30, 'tbsCertificate');
    let t = readTlv(der, tbs.body, tbs.end);
    if (t.tag === 0xa0) t = readTlv(der, t.end, tbs.end); // [0] version
    expectTag(t, 0x02, 'serialNumber');
    const sigAlg = expectTag(readTlv(der, t.end, tbs.end), 0x30, 'signature');
    const issuer = expectTag(readTlv(der, sigAlg.end, tbs.end), 0x30, 'issuer');
    const validity = expectTag(readTlv(der, issuer.end, tbs.end), 0x30, 'validity');
    const subject = expectTag(readTlv(der, validity.end, tbs.end), 0x30, 'subject');
    return Buffer.from(der.subarray(subject.start, subject.end));
}

// ─── Certificates ────────────────────────────────────────────────────────────────────────────────

/** A positive, minimally-encoded 128-bit serial (hex), first byte 0x01-0x7f. */
function randomSerial() {
    const bytes = crypto.randomBytes(16);
    bytes[0] = (bytes[0] & 0x7f) || 0x01;
    return bytes.toString('hex');
}

/**
 * Build and sign an X.509 v3 certificate; returns its PEM.
 *
 *   subject      [['CN', …], ['O', …]] or an encoded Name (Buffer)
 *   issuer       same; omit for self-signed (issuer = subject)
 *   publicKey    the key being certified (KeyObject, PEM, or SPKI DER)
 *   signingKey   the issuer's private key (KeyObject or PEM — PKCS#1 or PKCS#8)
 *   issuerCertPem  optional: when given, the issuer Name is taken verbatim from it and the result is
 *                  verified against its public key
 *   serialHex, notBefore, notAfter
 *   ca           true → basicConstraints cA:TRUE (critical); false → cA:FALSE; undefined → omitted
 *   keyUsage     ['digitalSignature', 'keyEncipherment', 'keyCertSign', 'cRLSign', …]
 *   extKeyUsage  ['serverAuth', 'clientAuth']
 *   altNames     ['localhost', '127.0.0.1', 'node1.example', …] (IP literals become iPAddress)
 */
function createCertificate(opts) {
    const signingKey = toPrivateKey(opts.signingKey);
    const publicKey = toPublicKey(opts.publicKey);
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const subject = encodeName(opts.subject);
    let issuer;
    let issuerPublicKey;
    if (opts.issuerCertPem) {
        issuer = certificateSubject(opts.issuerCertPem);
        issuerPublicKey = new crypto.X509Certificate(opts.issuerCertPem).publicKey;
        // A CA key that is not the CA certificate's key would sign certificates nothing can verify.
        if (!new crypto.X509Certificate(opts.issuerCertPem).checkPrivateKey(signingKey)) {
            throw new Error('The CA private key does not match the CA certificate');
        }
    } else {
        issuer = opts.issuer ? encodeName(opts.issuer) : subject;
        issuerPublicKey = crypto.createPublicKey(signingKey);
    }
    const serialHex = String(opts.serialHex || randomSerial());
    if (!/^[0-9a-fA-F]+$/.test(serialHex)) throw new Error('Certificate serial must be hex');
    const serial = uint(Buffer.from(serialHex.length % 2 ? `0${serialHex}` : serialHex, 'hex'));
    const notBefore = opts.notBefore || new Date();
    const notAfter = opts.notAfter;
    if (!notAfter) throw new Error('Certificate notAfter is required');

    const exts = [];
    if (opts.ca === true) exts.push(extension(OID.basicConstraints, true, seq(bool(true))));
    else if (opts.ca === false) exts.push(extension(OID.basicConstraints, false, seq()));
    if (opts.keyUsage && opts.keyUsage.length) exts.push(extension(OID.keyUsage, true, keyUsageValue(opts.keyUsage)));
    if (opts.extKeyUsage && opts.extKeyUsage.length) {
        exts.push(extension(OID.extKeyUsage, false, seq(...opts.extKeyUsage.map((u) => {
            if (!OID[u] || !['serverAuth', 'clientAuth'].includes(u)) throw new Error(`Unknown extKeyUsage ${u}`);
            return oid(OID[u]);
        }))));
    }
    if (opts.altNames && opts.altNames.length) {
        exts.push(extension(OID.subjectAltName, false, seq(...opts.altNames.map(generalName))));
    }

    const sig = signatureAlgorithm(signingKey);
    const tbs = seq(
        explicit(0, uint([2])), // v3
        serial,
        sig.algId,
        issuer,
        seq(time(notBefore), time(notAfter)),
        subject,
        spki,
        ...(exts.length ? [explicit(3, seq(...exts))] : []),
    );
    const der = seq(tbs, sig.algId, bitString(sig.sign(tbs)));
    const pem = toPem('CERTIFICATE', der);
    // Read back by OpenSSL and verified: nothing malformed or mis-signed leaves this module.
    const check = new crypto.X509Certificate(pem);
    if (!check.verify(issuerPublicKey)) throw new Error('Certificate signature self-check failed');
    return pem;
}

/**
 * Build a PKCS#10 certification request signed by `privateKey`; returns its PEM. `altNames` become an
 * extensionRequest attribute (subjectAltName) — what an ACME CA reads the identifiers from.
 */
function createCsr({ privateKey, subject, altNames = [] }) {
    const key = toPrivateKey(privateKey);
    const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
    const attrs = altNames.length
        ? seq(oid(OID.extensionRequest), set(seq(extension(OID.subjectAltName, false, seq(...altNames.map(generalName))))))
        : null;
    const info = seq(uint([0]), encodeName(subject), spki, tlv(0xa0, ...(attrs ? [attrs] : [])));
    const sig = signatureAlgorithm(key);
    return toPem('CERTIFICATE REQUEST', seq(info, sig.algId, bitString(sig.sign(info))));
}

/**
 * Parse a PKCS#10 certification request (PEM). Returns the exact DER of the signed
 * CertificationRequestInfo, the signature algorithm OID (and its name when known), the signature
 * bytes, and the subject public key (a KeyObject, parsed by OpenSSL). Structure only — the caller
 * decides which algorithms it accepts and verifies the signature (verifyCsr).
 */
function parseCsr(pem) {
    const der = pemBody(pem, ['CERTIFICATE REQUEST', 'NEW CERTIFICATE REQUEST']);
    const outer = expectTag(readTlv(der, 0), 0x30, 'certification request');
    if (outer.end !== der.length) throw new Error('Trailing data after the certification request');
    const info = expectTag(readTlv(der, outer.body, outer.end), 0x30, 'certificationRequestInfo');
    const alg = expectTag(readTlv(der, info.end, outer.end), 0x30, 'signatureAlgorithm');
    const sig = expectTag(readTlv(der, alg.end, outer.end), 0x03, 'signature');
    if (sig.end !== outer.end) throw new Error('Malformed certification request');
    const algOid = expectTag(readTlv(der, alg.body, alg.end), 0x06, 'signatureAlgorithm');
    if (sig.body >= sig.end || der[sig.body] !== 0) throw new Error('Malformed signature BIT STRING');

    const version = expectTag(readTlv(der, info.body, info.end), 0x02, 'version');
    if (version.end - version.body !== 1 || der[version.body] !== 0) throw new Error('Unsupported certification request version');
    const subject = expectTag(readTlv(der, version.end, info.end), 0x30, 'subject');
    const spki = expectTag(readTlv(der, subject.end, info.end), 0x30, 'subjectPKInfo');
    const attributes = expectTag(readTlv(der, spki.end, info.end), 0xa0, 'attributes');
    if (attributes.end !== info.end) throw new Error('Malformed certificationRequestInfo');

    const signatureOid = decodeOid(der.subarray(algOid.body, algOid.end));
    return {
        info: Buffer.from(der.subarray(info.start, info.end)),
        signatureOid,
        signatureAlgorithm: OID_NAMES.get(signatureOid) || null,
        signature: Buffer.from(der.subarray(sig.body + 1, sig.end)),
        publicKey: crypto.createPublicKey({ key: Buffer.from(der.subarray(spki.start, spki.end)), format: 'der', type: 'spki' }),
    };
}

module.exports = {
    OID,
    generateRsaKeyPair,
    createCertificate,
    createCsr,
    parseCsr,
    certificateSubject,
    randomSerial,
    toPem,
    pemBody,
};
