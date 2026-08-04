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
const { getOption, updateOption } = require('./options');
const { getRoles } = require('./roles');

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

// ─── Admin-enforced MFA-by-role policy ─────────────────────────────────────────────────────────────
// An admin can require specific roles to have 2FA. A subject user gets a grace window to enroll, then is
// hard-blocked (by mfaComplianceGate) from everything except the enrollment flow. The policy is a single
// JSON option. mfaComplianceGate consults it on EVERY API request, so it carries a small bounded
// cache: setPolicy() and the local `updated_option` hook invalidate instantly in-process, and the
// 10s TTL bounds staleness on OTHER nodes (a policy toggle is an admin action whose grace windows
// are measured in DAYS — seconds of propagation are immaterial, per-request SELECTs are not).
const POLICY_OPTION = 'mfa_policy';
const POLICY_TTL_MS = 10_000;
let _policyCache: { value: { requiredRoles: string[]; graceDays: number; enforcedAt: number | null }; at: number } | null = null;
try {
    require('./hooks').addAction('updated_option', async (name: any) => {
        if (name === POLICY_OPTION) _policyCache = null;
    });
} catch { /* hooks unavailable in isolated unit tests */ }
const DEFAULT_POLICY = { requiredRoles: [] as string[], graceDays: 0, enforcedAt: null as number | null };
// Cap the grace window (~10 years) so a fat-fingered huge value can't silently turn enforcement into a
// permanent no-op (adversarial review #5).
const MAX_GRACE_DAYS = 3650;
function clampGraceDays(v: any): number {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(MAX_GRACE_DAYS, Math.floor(n)) : 0;
}

/** Read the enforcement policy, always fully-shaped + validated (getOption may return a partial/legacy row). */
async function getPolicy(): Promise<{ requiredRoles: string[]; graceDays: number; enforcedAt: number | null }> {
    if (_policyCache && Date.now() - _policyCache.at < POLICY_TTL_MS) return _policyCache.value;
    const p = await getOption(POLICY_OPTION, DEFAULT_POLICY);
    const requiredRoles = Array.isArray(p && p.requiredRoles)
        ? [...new Set(p.requiredRoles.map((r: any) => String(r)))] as string[]
        : [];
    const graceDays = clampGraceDays(p && p.graceDays);
    const enforcedAtNum = Number(p && p.enforcedAt);
    const enforcedAt = p && p.enforcedAt != null && Number.isFinite(enforcedAtNum) ? enforcedAtNum : null;
    const value = { requiredRoles, graceDays, enforcedAt };
    _policyCache = { value, at: Date.now() };
    return value;
}

/**
 * Persist the policy (validating role slugs against the live role map, graceDays as a non-negative int).
 * `enforcedAt` (epoch seconds) marks when enforcement STARTED and is managed here, not by the caller: it is
 * stamped when the policy first requires ≥1 role and cleared when it requires none — so it can't be back-
 * dated to retroactively expire everyone's grace, and toggling the feature off then on restarts the clock.
 */
async function setPolicy(input: any): Promise<{ requiredRoles: string[]; graceDays: number; enforcedAt: number | null }> {
    const validRoles = getRoles() || {};
    const requiredRoles = (Array.isArray(input && input.requiredRoles)
        ? ([...new Set(input.requiredRoles.map((r: any) => String(r)))] as string[])
        : []).filter((r: string) => Object.prototype.hasOwnProperty.call(validRoles, r));
    const graceDays = clampGraceDays(input && input.graceDays);

    const prev = await getPolicy();
    let enforcedAt = prev.enforcedAt;
    if (requiredRoles.length === 0) enforcedAt = null;                          // feature off → clear the clock
    else if (!enforcedAt) enforcedAt = Math.floor(Date.now() / 1000);          // just turned on → stamp now

    const policy = { requiredRoles, graceDays, enforcedAt };
    await updateOption(POLICY_OPTION, policy);
    _policyCache = { value: policy, at: Date.now() };  // write-through: this node enforces instantly
    return policy;
}

/** Parse a `user_registered` datetime string to epoch seconds (0 if absent/unparseable). */
function registeredEpoch(user: any): number {
    const raw = user && user.userRegistered;
    if (!raw) return 0;
    let s = String(raw);
    // SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC with NO zone marker; bare, Date.parse would
    // read it as LOCAL time and land the epoch off by the machine's UTC offset. Pin a bare timestamp to UTC.
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * Compliance status for a user against the current policy. READ-ONLY + stateless (no meta writes on this
 * hot path). A subject-but-unenrolled user is `withinGrace` until the deadline, then `enforced` (hard
 * block). The grace anchor is max(enforcedAt, the user's registration) so existing users get grace from
 * when the policy switched on and brand-new users get it from signup.
 *
 * Shape is the exact object surfaced to the client on login / /auth/me: { required, enabled, enforced,
 * withinGrace, graceDeadline(epoch seconds|null) }.
 */
async function evaluate(user: any): Promise<{ required: boolean; enabled: boolean; enforced: boolean; withinGrace: boolean; graceDeadline: number | null }> {
    const userId = user && (typeof user === 'object' ? user.id : user);
    if (userId == null) return { required: false, enabled: false, enforced: false, withinGrace: false, graceDeadline: null };
    const policy = await getPolicy();
    const enabled = await isEnabled(userId);

    // Read the role authoritatively from user_meta rather than trusting instance hydration (a freshly
    // authenticated user in the login handler may not have loadMeta()'d its role yet).
    const role = (await User.getMeta(userId, 'role')) || 'subscriber';

    const required = policy.requiredRoles.includes(role);
    if (!required || enabled) {
        return { required, enabled, enforced: false, withinGrace: false, graceDeadline: null };
    }
    // Subject + not enrolled → within grace until the deadline, then enforced. The anchor is the later of
    // the policy's enforcement start and the user's registration, but never in the future (clamp to now —
    // both are inherently past-or-present, so a future value can only be a mis-parse and must not extend
    // grace, which would let graceDays:0 fail to enforce).
    const nowSec = Math.floor(Date.now() / 1000);
    const anchor = Math.min(nowSec, Math.max(policy.enforcedAt || 0, registeredEpoch(user)));
    const graceDeadline = anchor + policy.graceDays * 86400;
    const withinGrace = nowSec < graceDeadline;
    return { required: true, enabled: false, enforced: !withinGrace, withinGrace, graceDeadline };
}

module.exports = {
    META, N_BACKUP,
    signChallenge, verifyChallenge, isEnabled, verifyLoginCode,
    beginEnroll, completeEnroll, regenerateBackupCodes, disable, backupCount, hashBackup,
    getPolicy, setPolicy, evaluate, POLICY_OPTION, DEFAULT_POLICY
};
