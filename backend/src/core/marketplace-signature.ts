/**
 * WordJS — Detached Ed25519 signatures for marketplace catalogs.
 *
 * WHY. Every package the marketplace installs is sha256-checked against its catalog entry, but that hash
 * comes from the same catalog document. Integrity of the zips therefore reduces to integrity of the
 * index: whoever can serve the index can also serve a matching hash. A detached signature moves the
 * trust anchor out of the download path and into a public key that ships with the code (official
 * catalog) or that the administrator pinned for a source (third-party catalogs).
 *
 * FORMAT. Next to each index file the publisher places `<index-file>.sig` (for example
 * `marketplace-index.json.sig`): the base64 Ed25519 signature over the EXACT bytes of the index file.
 * Signing raw bytes means there is no JSON canonicalisation to get wrong. The signer is
 * backend/scripts/sign-marketplace-catalog.js; the key pair comes from
 * backend/scripts/generate-marketplace-signing-key.js.
 *
 * PUBLIC KEY FORMAT. Either the base64 of the 32 raw Ed25519 public-key bytes, or the base64 of the
 * SPKI DER encoding (what generate-marketplace-signing-key.js prints), or a PEM "PUBLIC KEY" block.
 *
 * POLICY (decided by the caller, see routes/marketplace.ts catalogSignaturePolicy):
 *   - no key applies             → not verified, reported `unsigned`, never refused;
 *   - a key applies, required    → a missing OR invalid signature refuses the catalog;
 *   - a key applies, optional    → a present signature must verify (invalid → refused); a missing one
 *                                  is reported `unsigned`.
 */

const crypto = require('crypto');

/** Suffix of the detached signature published next to an index file. */
const SIGNATURE_SUFFIX = '.sig';
/** Upper bound for a signature file (an Ed25519 signature is 64 bytes, 88 in base64). */
const MAX_SIGNATURE_BYTES = 4096;

// DER prefix of an SPKI-wrapped Ed25519 public key (RFC 8410): SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING }.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type CatalogSignatureStatus = 'verified' | 'unsigned';

/**
 * Parse a public key in any of the accepted text forms. Throws on anything that is not an Ed25519 key,
 * so a mistyped key is a loud configuration error and never a silent "no key".
 */
function parsePublicKey(text: string): any {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('empty public key');
    let key: any;
    if (raw.includes('-----BEGIN')) {
        key = crypto.createPublicKey({ key: raw, format: 'pem' });
    } else {
        if (!/^[A-Za-z0-9+/=_-]+$/.test(raw)) throw new Error('the public key is not base64');
        const der = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        const spki = der.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, der]) : der;
        key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('the public key is not an Ed25519 key');
    return key;
}

/** Is `text` a usable Ed25519 public key? (For validating admin input before it is stored.) */
function isValidPublicKey(text: unknown): boolean {
    if (typeof text !== 'string') return false;
    try { parsePublicKey(text); return true; } catch { return false; }
}

/** Decode the text of a `.sig` file into the 64 signature bytes, or null when it is not one. */
function decodeSignature(sigText: string): Buffer | null {
    const s = String(sigText || '').trim();
    if (!s || !/^[A-Za-z0-9+/=]+$/.test(s)) return null;
    const buf = Buffer.from(s, 'base64');
    return buf.length === 64 ? buf : null;
}

/** Does `sigText` verify `bytes` under `publicKey`? Never throws: any malformed input is "no". */
function verifyDetached(bytes: Buffer, sigText: string, publicKey: string): boolean {
    try {
        const sig = decodeSignature(sigText);
        if (!sig) return false;
        return crypto.verify(null, bytes, parsePublicKey(publicKey), sig) === true;
    } catch {
        return false;
    }
}

/**
 * Apply the signing policy to one catalog document.
 *
 * @param bytes      the exact bytes of the index file as read/downloaded.
 * @param signature  the text of `<index>.sig`, or null when none was published.
 * @param publicKey  the key that applies to this source ('' / null = none configured).
 * @param required   whether a missing signature refuses the catalog (only meaningful with a key).
 * @returns the status to report, or throws an Error whose message is safe to show the administrator.
 */
function checkCatalogSignature(bytes: Buffer, signature: string | null, publicKey: string | null | undefined, required: boolean): CatalogSignatureStatus {
    const key = String(publicKey || '').trim();
    if (!key) return 'unsigned';
    if (signature == null || !String(signature).trim()) {
        if (required) throw new Error('El catálogo no incluye firma y esta fuente exige catálogos firmados — catálogo rechazado.');
        return 'unsigned';
    }
    if (!verifyDetached(bytes, signature, key)) {
        throw new Error('La firma del catálogo no es válida — catálogo rechazado.');
    }
    return 'verified';
}

module.exports = {
    SIGNATURE_SUFFIX,
    MAX_SIGNATURE_BYTES,
    parsePublicKey,
    isValidPublicKey,
    verifyDetached,
    checkCatalogSignature,
};
