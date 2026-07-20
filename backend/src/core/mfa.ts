/**
 * WordJS - MFA (TOTP) orchestration: per-user secret/backup storage + the login challenge token.
 *
 * Secrets + backup-code hashes live in user_meta under keys that User.toJSON's SENSITIVE_META regex
 * strips (mfa_totp_secret / mfa_pending_secret / mfa_recovery_codes → matched by secret|otp|recovery),
 * so they are never serialized to a client. The TOTP secret is stored PLAINTEXT (it must be re-read to
 * verify each code, and — per the webhook lesson — coupling its encryption to a rotatable app key would
 * silently break MFA on any key change; DB/disk encryption is the at-rest control). Backup codes are
 * stored as sha256 HASHES (one-way — only ever compared) and consumed single-use.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/app');
const User = require('../models/User');
const totp = require('./totp');

const META = { enabled: 'mfa_enabled', secret: 'mfa_totp_secret', pending: 'mfa_pending_secret', backup: 'mfa_recovery_codes', lastStep: 'mfa_totp_last_step' };
const N_BACKUP = 10;
const CHALLENGE_TTL = '5m';

/** Normalize a user-typed code (backup or TOTP): drop spaces/dashes, upper-case. */
function normCode(c: string): string {
    return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function hashBackup(code: string): string {
    return crypto.createHash('sha256').update(normCode(code)).digest('hex');
}

/** Generate N human-friendly one-time recovery codes; returns plaintext (shown once) + sha256 hashes. */
function generateBackupCodes(n = N_BACKUP): { codes: string[]; hashes: string[] } {
    const codes: string[] = [], hashes: string[] = [];
    for (let i = 0; i < n; i++) {
        const raw = totp.base32Encode(crypto.randomBytes(7)).slice(0, 10); // 50 bits, base32
        const code = `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
        codes.push(code);
        hashes.push(hashBackup(code));
    }
    return { codes, hashes };
}

/** A 5-minute signed token proving the password step passed, so the 2nd factor can't be reached alone. */
function signChallenge(userId: number): string {
    return jwt.sign({ userId, purpose: 'mfa_challenge' }, config.jwt.secret, { algorithm: 'HS256', expiresIn: CHALLENGE_TTL });
}
function verifyChallenge(token: string): { userId: number } | null {
    try {
        const d = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
        if (d.purpose !== 'mfa_challenge' || !d.userId) return null;
        return { userId: d.userId };
    } catch { return null; }
}

async function isEnabled(userId: number): Promise<boolean> {
    return (await User.getMeta(userId, META.enabled)) === '1';
}

/**
 * Verify a login-time code: a valid TOTP (constant-time), OR a single-use backup code (consumed on
 * success). Returns true iff accepted.
 */
async function verifyLoginCode(userId: number, code: string): Promise<boolean> {
    const secret = await User.getMeta(userId, META.secret);
    if (secret) {
        const step = totp.verifyTotpStep(secret, String(code || '').replace(/\s+/g, ''));
        if (step >= 0) {
            // Anti-replay (RFC 6238 §5.2): a code's time-step is one-time-use. Track the last consumed
            // step; reject a step <= it, and advance it ATOMICALLY so two concurrent submissions of the
            // same step cannot both pass (the loser's compare-and-set finds a changed value).
            const lastRaw = await User.getMeta(userId, META.lastStep);
            const last = lastRaw != null ? parseInt(lastRaw, 10) : -1;
            if (step <= last) return false;
            return await User.compareAndSetMeta(userId, META.lastStep, String(last), String(step));
        }
    }

    // Backup code — single-use, consumed ATOMICALLY (compare-and-set on the exact list we read, so two
    // concurrent submissions of the same code cannot both consume it).
    const raw = await User.getMeta(userId, META.backup);
    if (!raw) return false;
    let hashes: string[];
    try { hashes = JSON.parse(raw); } catch { return false; }
    const h = hashBackup(code);
    const idx = hashes.findIndex((x) => x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
    if (idx === -1) return false;
    const next = hashes.slice();
    next.splice(idx, 1);
    return await User.compareAndSetMeta(userId, META.backup, raw, JSON.stringify(next));
}

/** Enroll: stash a pending secret; return it + the provisioning URI for the QR. */
async function beginEnroll(userId: number, account: string): Promise<{ secret: string; otpauthUri: string }> {
    const secret = totp.generateSecret();
    await User.updateMeta(userId, META.pending, secret);
    const issuer = (config.site && config.site.name) || 'WordJS';
    return { secret, otpauthUri: totp.otpauthUri(secret, { issuer, account }) };
}

/** Finish enroll: verify a code against the pending secret, then activate + return fresh backup codes. */
async function completeEnroll(userId: number, code: string): Promise<{ ok: boolean; backupCodes?: string[] }> {
    const pending = await User.getMeta(userId, META.pending);
    if (!pending || !totp.verifyTotp(pending, String(code || '').replace(/\s+/g, ''))) return { ok: false };
    const { codes, hashes } = generateBackupCodes();
    await User.updateMeta(userId, META.secret, pending);
    await User.updateMeta(userId, META.backup, JSON.stringify(hashes));
    await User.updateMeta(userId, META.lastStep, '-1'); // replay counter row must exist for the atomic CAS
    await User.updateMeta(userId, META.enabled, '1');
    await User.deleteMeta(userId, META.pending);
    return { ok: true, backupCodes: codes };
}

/** Regenerate backup codes (invalidates the old set). */
async function regenerateBackupCodes(userId: number): Promise<string[]> {
    const { codes, hashes } = generateBackupCodes();
    await User.updateMeta(userId, META.backup, JSON.stringify(hashes));
    return codes;
}

/** Turn MFA off + wipe all MFA meta. */
async function disable(userId: number): Promise<void> {
    for (const key of Object.values(META)) await User.deleteMeta(userId, key);
}

/** Remaining unused backup codes count (for the account UI). */
async function backupCount(userId: number): Promise<number> {
    const raw = await User.getMeta(userId, META.backup);
    if (!raw) return 0;
    try { return JSON.parse(raw).length; } catch { return 0; }
}

module.exports = {
    META, N_BACKUP,
    signChallenge, verifyChallenge, isEnabled, verifyLoginCode,
    beginEnroll, completeEnroll, regenerateBackupCodes, disable, backupCount, hashBackup
};
