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
const { getOption, updateOption, deleteOption } = require('./options');
const { getRoles } = require('./roles');

const META = { enabled: 'mfa_enabled', secret: 'mfa_totp_secret', pending: 'mfa_pending_secret', backup: 'mfa_recovery_codes', lastStep: 'mfa_totp_last_step', usedChallenges: 'mfa_used_challenges' };
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

/**
 * A 5-minute signed token proving the password step passed, so the 2nd factor can't be reached alone.
 * It is good for ONE session: its id (`jti`) is recorded when a code completes the sign-in, and a used
 * challenge is refused (it used to mint a second session with the next code for as long as it lived).
 */
function signChallenge(userId: number): string {
    const jti = crypto.randomBytes(12).toString('base64url');
    return require('./site-keys').signForSite({ userId, purpose: 'mfa_challenge', jti }, { algorithm: 'HS256', expiresIn: CHALLENGE_TTL });
}
function verifyChallenge(token: string): { userId: number; jti?: string; exp?: number } | null {
    try {
        const d = require('./site-keys').verifyForSite(token);
        if (d.purpose !== 'mfa_challenge' || !d.userId) return null;
        return { userId: d.userId, jti: typeof d.jti === 'string' ? d.jti : undefined, exp: Number(d.exp) || undefined };
    } catch { return null; }
}

/** The used-challenge list (`{ jti: exp }`) with expired entries dropped. */
async function readUsedChallenges(userId: number): Promise<Record<string, number>> {
    const raw = await User.getMeta(userId, META.usedChallenges);
    const now = Math.floor(Date.now() / 1000);
    try {
        const parsed = raw ? JSON.parse(String(raw)) : {};
        const out: Record<string, number> = Object.create(null);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed)) if (Number(v) > now) out[k] = Number(v);
        }
        return out;
    } catch { return Object.create(null); }
}

/** Has this challenge already completed a sign-in? (A challenge from before ids were issued has none.) */
async function challengeUsed(userId: number, challenge: { jti?: string }): Promise<boolean> {
    if (!challenge.jti) return false;
    return Object.prototype.hasOwnProperty.call(await readUsedChallenges(userId), challenge.jti);
}

/** Record that this challenge completed a sign-in, until it would have expired anyway. */
async function markChallengeUsed(userId: number, challenge: { jti?: string; exp?: number }): Promise<void> {
    if (!challenge.jti) return;
    const used = await readUsedChallenges(userId);
    used[challenge.jti] = challenge.exp || Math.floor(Date.now() / 1000) + 300;
    await User.updateMeta(userId, META.usedChallenges, JSON.stringify(used));
}

async function isEnabled(userId: number): Promise<boolean> {
    return (await User.getMeta(userId, META.enabled)) === '1';
}

/**
 * Consume TOTP time-step `step` for `userId` exactly once. Tracks the last consumed step in
 * `mfa_totp_last_step`; a step <= it is refused, and the counter is advanced ATOMICALLY so two
 * concurrent submissions of the same step cannot both pass (the loser's compare-and-set finds a changed
 * value).
 *
 * The counter row is created at enrollment, but it can still be missing (a partial restore, a
 * hand-edited or imported database, an enrollment written by other tooling). A compare-and-set against a
 * row that does not exist updates nothing, so without the branch below every TOTP code would be refused
 * forever (fail-closed lockout). Instead, the FIRST use claims the counter with an atomic
 * insert-if-absent carrying the consumed step itself, serialized on the user's secret row: exactly one
 * caller inserts it, and every concurrent caller then finds the row and is refused by the step check.
 */
async function consumeTotpStep(userId: number, step: number): Promise<boolean> {
    let values: string[] = await User.getMetaValues(userId, META.lastStep);
    if (values.length === 0) {
        if (await User.insertMetaIfAbsent(userId, META.lastStep, String(step), META.secret)) return true;
        values = await User.getMetaValues(userId, META.lastStep);
        if (values.length === 0) return false; // secret removed concurrently (MFA disabled) — refuse
    }
    // Normally a single row. Should a legacy race have left duplicates, the HIGHEST value is the truth
    // (the counter is monotonic), so a replay can never pass by reading a stale lower duplicate.
    const parsed = values.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n));
    if (parsed.length === 0) return false; // corrupt counter — refuse rather than guess
    const last = Math.max(...parsed);
    if (step <= last) return false;
    return await User.compareAndSetMeta(userId, META.lastStep, String(last), String(step));
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
            // Anti-replay (RFC 6238 §5.2): a code's time-step is one-time-use.
            return await consumeTotpStep(userId, step);
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
    // The replay counter row must exist for the atomic compare-and-set; write it BEFORE the secret so no
    // window exists in which a secret is verifiable without its counter.
    await User.updateMeta(userId, META.lastStep, '-1');
    await User.updateMeta(userId, META.secret, pending);
    await User.updateMeta(userId, META.backup, JSON.stringify(hashes));
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
/**
 * The stored policy. `enforceForApiTokens` extends the gate to `wjt_` personal API tokens: it defaults to
 * FALSE so an existing install keeps today's behaviour (headless tokens categorically exempt), and only
 * ever ADDS enforcement when an admin turns it on. See mfaComplianceGate in middleware/auth.ts.
 */
type MfaPolicy = { requiredRoles: string[]; graceDays: number; enforcedAt: number | null; enforceForApiTokens: boolean };
// One cached policy per site (each site has its own mfa_policy option); site 1's is the historical one.
const policyCacheBySite = require('./site-context').perSite(() => ({ entry: null as { value: MfaPolicy; at: number } | null }));
try {
    require('./hooks').addAction('updated_option', async (name: any) => {
        if (name === POLICY_OPTION) policyCacheBySite.get().entry = null;
    });
} catch { /* hooks unavailable in isolated unit tests */ }
const DEFAULT_POLICY: MfaPolicy = { requiredRoles: [], graceDays: 0, enforcedAt: null, enforceForApiTokens: false };

/**
 * FRESH-INSTALL DEFAULT for `enforceForApiTokens`.
 *
 * The flag is off on every site that existed before it, because turning it on can start refusing tokens
 * that work today. A site created by the install wizard has no such tokens, so there the FIRST policy that
 * requires a role brings API tokens under it unless the administrator says otherwise. The signal is a mark
 * the install itself writes (routes/setup.ts) — never inferred from "no policy saved yet", which is also
 * true of every upgraded site whose administrator has simply not opened the screen. It is consumed by the
 * first save that requires ≥1 role, whatever that save chose, so from then on the policy is the plain
 * full-replace it always was. The option name is on the plugin bridge's protected list (core/plugin-api),
 * which also keeps a site import from carrying it into an upgraded site.
 */
const FRESH_INSTALL_OPTION = 'mfa_policy_fresh_install';

/** Called once by the install wizard. */
async function recordFreshInstall(): Promise<void> {
    await updateOption(FRESH_INSTALL_OPTION, '1');
}

/** Would the next policy that requires a role default `enforceForApiTokens` to ON? (fresh install, first time) */
async function tokenEnforcementDefault(): Promise<boolean> {
    return String(await getOption(FRESH_INSTALL_OPTION, '')) === '1';
}
// Cap the grace window (~10 years) so a fat-fingered huge value can't silently turn enforcement into a
// permanent no-op (adversarial review #5).
const MAX_GRACE_DAYS = 3650;
function clampGraceDays(v: any): number {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(MAX_GRACE_DAYS, Math.floor(n)) : 0;
}

/** Read the enforcement policy, always fully-shaped + validated (getOption may return a partial/legacy row). */
async function getPolicy(): Promise<MfaPolicy> {
    const cached = policyCacheBySite.get().entry;
    if (cached && Date.now() - cached.at < POLICY_TTL_MS) return cached.value;
    const p = await getOption(POLICY_OPTION, DEFAULT_POLICY);
    const requiredRoles = Array.isArray(p && p.requiredRoles)
        ? [...new Set(p.requiredRoles.map((r: any) => String(r)))] as string[]
        : [];
    const graceDays = clampGraceDays(p && p.graceDays);
    const enforcedAtNum = Number(p && p.enforcedAt);
    const enforcedAt = p && p.enforcedAt != null && Number.isFinite(enforcedAtNum) ? enforcedAtNum : null;
    // Strict `=== true`: a row written before this field existed (and any truthy junk) reads as OFF, so an
    // upgrade can never silently start refusing tokens that worked yesterday.
    const enforceForApiTokens = (p && p.enforceForApiTokens) === true;
    const value = { requiredRoles, graceDays, enforcedAt, enforceForApiTokens };
    policyCacheBySite.get().entry = { value, at: Date.now() };
    return value;
}

/**
 * Persist the policy (validating role slugs against the live role map, graceDays as a non-negative int).
 * `enforcedAt` (epoch seconds) marks when enforcement STARTED and is managed here, not by the caller: it is
 * stamped when the policy first requires ≥1 role and cleared when it requires none — so it can't be back-
 * dated to retroactively expire everyone's grace, and toggling the feature off then on restarts the clock.
 */
async function setPolicy(input: any): Promise<MfaPolicy> {
    const validRoles = getRoles() || {};
    const requiredRoles = (Array.isArray(input && input.requiredRoles)
        ? ([...new Set(input.requiredRoles.map((r: any) => String(r)))] as string[])
        : []).filter((r: string) => Object.prototype.hasOwnProperty.call(validRoles, r));
    const graceDays = clampGraceDays(input && input.graceDays);
    // Same full-replace contract as requiredRoles/graceDays: an omitted field means "off", not "unchanged" —
    // except on a freshly INSTALLED site's first policy that requires a role, where omitted means "on" (see
    // tokenEnforcementDefault). An explicit true/false is always what is stored.
    const explicit = input && typeof input.enforceForApiTokens === 'boolean' ? input.enforceForApiTokens : null;
    const freshDefault = requiredRoles.length > 0 && await tokenEnforcementDefault();
    const enforceForApiTokens = explicit !== null ? explicit : freshDefault;

    const prev = await getPolicy();
    let enforcedAt = prev.enforcedAt;
    if (requiredRoles.length === 0) enforcedAt = null;                          // feature off → clear the clock
    else if (!enforcedAt) enforcedAt = Math.floor(Date.now() / 1000);          // just turned on → stamp now

    const policy = { requiredRoles, graceDays, enforcedAt, enforceForApiTokens };
    await updateOption(POLICY_OPTION, policy);
    policyCacheBySite.get().entry = { value: policy, at: Date.now() };  // write-through: this node enforces instantly
    // The first policy that requires a role has been decided, whatever it chose: the fresh-install default is spent.
    if (requiredRoles.length > 0 && await tokenEnforcementDefault()) await deleteOption(FRESH_INSTALL_OPTION);
    // A role that now requires 2FA applies to sessions that are already streaming too (core/collab-rooms).
    try { require('./collab-rooms').recheckAll(); } catch { /* periodic re-check still applies */ }
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
    // A network administrator's handoff account (core/network-handoff) never signs in by itself: the
    // person behind it signed in on the main site, under the main site's policy, and its sessions last
    // minutes. It cannot enrol (the handoff refuses it), so this site's policy does not apply to it.
    if (typeof user === 'object' && require('./network-handoff').isHandoffAccount(user)) {
        return { required: false, enabled: false, enforced: false, withinGrace: false, graceDeadline: null };
    }
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

/**
 * What the policy means for EXISTING API tokens — the numbers behind the admin notice that tokens are
 * exempt from the compliance gate unless `enforceForApiTokens` is on. Counts active tokens owned by users
 * whose role the policy requires, and how many of those belong to an owner who has NOT enrolled: with the
 * flag off, each of those is a working credential for a required role that never passes a second factor.
 * Metadata only (counts), and read-only.
 *
 * AI agent connections (`wja_`) count as tokens here: the compliance gate treats them exactly like a
 * `wjt_` token (headless, exempt unless `enforceForApiTokens`), so leaving them out under-reported the
 * very exposure this number exists to show. A live connection is one not revoked and not expired —
 * pending ones included, since they authenticate too.
 */
async function tokenExposure(): Promise<{ requiredRoleTokens: number; unenrolledOwnerTokens: number; unenrolledOwners: number }> {
    const policy = await getPolicy();
    const out = { requiredRoleTokens: 0, unenrolledOwnerTokens: 0, unenrolledOwners: 0 };
    if (!policy.requiredRoles.length) return out;
    const counts = new Map<number, number>();
    const add = (userId: number, n: number) => counts.set(userId, (counts.get(userId) || 0) + n);
    const ApiToken = require('../models/ApiToken');
    for (const { userId, count } of await ApiToken.activeCountsByOwner()) add(userId, count);
    const AgentConnection = require('../models/AgentConnection');
    const nowSec = Math.floor(Date.now() / 1000);
    for (const c of await AgentConnection.list()) {
        if (c.status === 'revoked' || (c.expiresAt != null && c.expiresAt <= nowSec)) continue;
        add(Number(c.userId), 1);
    }
    for (const [userId, count] of counts) {
        const role = (await User.getMeta(userId, 'role')) || 'subscriber';
        if (!policy.requiredRoles.includes(role)) continue;
        out.requiredRoleTokens += count;
        if (!(await isEnabled(userId))) {
            out.unenrolledOwnerTokens += count;
            out.unenrolledOwners += 1;
        }
    }
    return out;
}

module.exports = {
    META, N_BACKUP,
    signChallenge, verifyChallenge, challengeUsed, markChallengeUsed, isEnabled, verifyLoginCode,
    beginEnroll, completeEnroll, regenerateBackupCodes, disable, backupCount, hashBackup,
    getPolicy, setPolicy, evaluate, tokenExposure, POLICY_OPTION, DEFAULT_POLICY,
    recordFreshInstall, tokenEnforcementDefault, FRESH_INSTALL_OPTION
};
