/**
 * WordJS - small shared crypto helpers (introduced for outgoing webhooks).
 *
 * Two concerns:
 *  1. HMAC signing of webhook payloads (like GitHub's X-Hub-Signature-256).
 *  2. Reversible encryption-at-rest for a webhook's signing SECRET. Unlike an API token (which is only
 *     ever compared, so a one-way sha256 suffices), a signing secret must be re-read as plaintext to
 *     compute the HMAC on every delivery — so it is stored ENCRYPTED, not hashed. The encryption key is
 *     derived (HKDF-SHA256) from the app secret (`config.jwt.secret`), which lives in the config file,
 *     NOT the database — so a database-only dump cannot decrypt stored webhook secrets.
 */

const crypto = require('crypto');
const config = require('../config/app');

const ENC_PREFIX = 'enc:v1:';

// Derived lazily (config.jwt.secret is resolved at boot) and cached. If jwt.secret ever rotates, existing
// envelopes become undecryptable — a deliberate, documented coupling (rotate webhook secrets after a
// jwt.secret rotation, same as any at-rest secret keyed off the app secret).
let _kek: Buffer | null = null;
function kek(): Buffer {
    if (_kek) return _kek;
    const secret = config.jwt && config.jwt.secret ? String(config.jwt.secret) : '';
    if (!secret) throw new Error('crypto-utils: jwt.secret is not configured; cannot derive the webhook encryption key');
    const salt = Buffer.from('wordjs/webhook/secret-enc/v1');
    _kek = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), salt, Buffer.from('aes-256-gcm-key'), 32));
    return _kek;
}

/** Encrypt a secret for storage. Returns an `enc:v1:<iv>:<tag>:<ct>` envelope (all base64). */
function encryptSecret(plaintext: string): string {
    const iv = crypto.randomBytes(12); // 96-bit nonce, the GCM standard
    const cipher = crypto.createCipheriv('aes-256-gcm', kek(), iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ENC_PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Decrypt an `enc:v1:` envelope. Throws on a malformed envelope or a failed auth tag (tamper/wrong key). */
function decryptSecret(envelope: string): string {
    if (typeof envelope !== 'string' || !envelope.startsWith(ENC_PREFIX)) {
        throw new Error('crypto-utils: not an encrypted secret envelope');
    }
    const parts = envelope.slice(ENC_PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('crypto-utils: malformed secret envelope');
    const [ivB64, tagB64, ctB64] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', kek(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/** HMAC-SHA256 of `data` under `secret`, hex-encoded (the wire format for the signature header). */
function hmacSha256Hex(secret: string, data: string | Buffer): string {
    return crypto.createHmac('sha256', String(secret)).update(data).digest('hex');
}

module.exports = { encryptSecret, decryptSecret, hmacSha256Hex, ENC_PREFIX };
