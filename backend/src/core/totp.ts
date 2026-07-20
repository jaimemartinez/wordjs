/**
 * WordJS - RFC 6238 TOTP (+ RFC 4226 HOTP) and RFC 4648 base32, for multi-factor auth.
 *
 * Implemented on Node's built-in crypto (HMAC-SHA1) with a tiny base32 codec — no external OTP/QR
 * dependency (the codebase deliberately avoids gratuitous deps). Standard authenticator-app parameters:
 * SHA1, 6 digits, 30s period, ±1 step verification window. The secret is stored/handled as base32.
 */

const crypto = require('crypto');

// RFC 4648 base32 alphabet (no padding — that's what authenticator apps + otpauth:// URIs expect).
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
    let bits = 0, value = 0, out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

function base32Decode(str: string): Buffer {
    const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
    let bits = 0, value = 0;
    const out: number[] = [];
    for (const ch of clean) {
        const idx = B32_ALPHABET.indexOf(ch);
        if (idx === -1) throw new Error('Invalid base32 character');
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

/** A fresh 160-bit secret, base32-encoded (the length recommended for SHA1 TOTP). */
function generateSecret(): string {
    return base32Encode(crypto.randomBytes(20));
}

/** RFC 4226 HOTP: HMAC-SHA1 over the 8-byte big-endian counter → dynamic-truncated `digits`-digit code. */
function hotp(secretBuf: Buffer, counter: number, digits = 6): string {
    const buf = Buffer.alloc(8);
    // 64-bit counter, big-endian. Values fit in 53-bit JS numbers for any realistic time, so split hi/lo.
    buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buf.writeUInt32BE(counter >>> 0, 4);
    const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
    return String(bin % 10 ** digits).padStart(digits, '0');
}

/** RFC 6238 TOTP at a given time (seconds). */
function totp(secretBase32: string, opts: { time?: number; step?: number; digits?: number } = {}): string {
    const step = opts.step || 30;
    const time = opts.time != null ? opts.time : Math.floor(Date.now() / 1000);
    return hotp(base32Decode(secretBase32), Math.floor(time / step), opts.digits || 6);
}

/**
 * Verify a submitted code against the secret, allowing ±`window` steps of clock drift. Constant-time
 * per-candidate compare so a byte-by-byte timing side channel can't leak the expected code.
 */
function verifyTotp(secretBase32: string, code: string, opts: { window?: number; step?: number; digits?: number; time?: number } = {}): boolean {
    const digits = opts.digits || 6;
    const step = opts.step || 30;
    const window = opts.window != null ? opts.window : 1;
    const submitted = String(code || '').replace(/\s+/g, '');
    if (!/^[0-9]+$/.test(submitted) || submitted.length !== digits) return false;
    let secretBuf: Buffer;
    try { secretBuf = base32Decode(secretBase32); } catch { return false; }
    const counter = Math.floor((opts.time != null ? opts.time : Math.floor(Date.now() / 1000)) / step);
    const want = Buffer.from(submitted);
    let ok = false;
    for (let w = -window; w <= window; w++) {
        const cand = Buffer.from(hotp(secretBuf, counter + w, digits));
        // timingSafeEqual needs equal lengths; both are exactly `digits` bytes.
        if (cand.length === want.length && crypto.timingSafeEqual(cand, want)) ok = true;
    }
    return ok;
}

/** otpauth:// provisioning URI for authenticator apps / QR codes. */
function otpauthUri(secretBase32: string, opts: { issuer: string; account: string }): string {
    const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
    const params = new URLSearchParams({
        secret: secretBase32,
        issuer: opts.issuer,
        algorithm: 'SHA1',
        digits: '6',
        period: '30'
    });
    return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { base32Encode, base32Decode, generateSecret, hotp, totp, verifyTotp, otpauthUri };
