/**
 * WordJS - small shared crypto helper (outgoing webhooks).
 *
 * Only HMAC signing lives here now. The webhook signing secret is stored in PLAINTEXT (see Webhook.ts):
 * an earlier version encrypted it at rest with an AES key derived from `config.jwt.secret`, but that
 * coupled webhook delivery to a rotatable app secret — any jwt.secret change (rotation, or a config
 * regeneration on boot) made every stored secret undecryptable and SILENTLY dead-lettered all deliveries.
 * A signing secret must be re-read verbatim to sign each delivery and to stay stable across restarts and
 * across all deploy modes (monolith / split / multi-node), so app-level encryption of this one field was
 * removed. At-rest protection is the job of DB/disk encryption, which covers every field uniformly.
 */

const crypto = require('crypto');

/** HMAC-SHA256 of `data` under `secret`, hex-encoded (the wire format for the signature header). */
function hmacSha256Hex(secret: string, data: string | Buffer): string {
    return crypto.createHmac('sha256', String(secret)).update(data).digest('hex');
}

module.exports = { hmacSha256Hex };
