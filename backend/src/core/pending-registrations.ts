/**
 * WordJS — self-registrations waiting for their email address to be confirmed.
 *
 * WHY THIS EXISTS. With email verification on, POST /auth/register used to create the account at once
 * (flagged `email_verification_pending`) and answer an already-registered address with the same 201,
 * creating nothing. The 201 was identical; the state it left behind was not. A fresh address got an
 * account named after the submitted username, a taken one did not, so a second request told the two
 * apart: logging in as that username answered 403 rest_email_unverified (account exists) or 401
 * (nothing was created), and registering the same username again answered 400 (taken) or 201 (free).
 * Two anonymous requests said whether any address had an account here.
 *
 * So a registration now creates NOTHING the rest of the site can see until the emailed link is followed.
 * It is kept here, keyed by the hash of the token in that link, and POST /auth/verify-email turns it into
 * the account. Both answers of /auth/register therefore leave the same observable state: no users row, no
 * username taken, nothing /auth/login can find. Several pending registrations may name the same username
 * or address; the first one confirmed gets it, and the later links answer that it is no longer available
 * (only their mailbox owners hold them).
 *
 * STORAGE: one `options` row per registration (autoload 'no'), named PREFIX + sha256(token). The name is
 * chosen to contain the word `token`, so every existing secret-name rule covers the row without a list
 * of its own: the plugin options bridge and the site import refuse it (plugin-api PROTECTED_OPTION_RE),
 * a theme cannot write it and the `updated_option` hook never carries its value (options
 * SECRET_OPTION_NAME_RE), and exportSite() only emits its fixed settings. The row holds the bcrypt hash
 * of the password, never the password, and only the hash of the token, never the token.
 */

const crypto = require('crypto');

const PREFIX = 'registration_pending_token_';
/** The raw token the link carries: 32 random bytes, hex. Anything else is refused before any lookup. */
const RAW_TOKEN_RE = /^[a-f0-9]{64}$/;
/** At most this many rows are examined per prune — registration is rate-limited, so this keeps up. */
const PRUNE_BATCH = 200;

interface PendingRegistration {
    username: string;
    email: string;
    passwordHash: string;
    displayName: string;
    expires: number;
}

function optionNameFor(rawToken: string): string {
    return PREFIX + crypto.createHash('sha256').update(rawToken).digest('hex');
}

function isRecord(v: any): v is PendingRegistration {
    return !!v && typeof v === 'object' && !Array.isArray(v)
        && typeof v.username === 'string' && typeof v.email === 'string'
        && typeof v.passwordHash === 'string' && typeof v.displayName === 'string'
        && typeof v.expires === 'number';
}

/**
 * Drop expired registrations (best effort — never fails the request that triggered it). Names are
 * matched in JavaScript as well as by LIKE, so `_` acting as a wildcard (and MySQL's case-insensitive
 * LIKE) can never select a row this module did not write.
 */
async function prunePendingRegistrations(now: number = Date.now()): Promise<number> {
    let removed = 0;
    try {
        const { dbAsync } = require('../config/database');
        const { deleteOption } = require('./options');
        const rows = await dbAsync.all(
            `SELECT option_name, option_value FROM options WHERE option_name LIKE ? LIMIT ${PRUNE_BATCH}`,
            [`${PREFIX}%`]);
        for (const row of rows || []) {
            const name = String(row && row.option_name);
            if (!name.startsWith(PREFIX)) continue;
            let rec: any = null;
            try { rec = JSON.parse(String(row.option_value)); } catch { rec = null; }
            if (isRecord(rec) && rec.expires > now) continue;
            if (await deleteOption(name)) removed++;
        }
    } catch (e: any) {
        console.warn('[registration] pruning expired pending registrations failed:', e && e.message);
    }
    return removed;
}

/** Keep a registration until its link is followed. Returns the RAW token for the link (stored hashed). */
async function createPendingRegistration(rec: Omit<PendingRegistration, 'expires'>, ttlMs: number): Promise<string> {
    const { addOption } = require('./options');
    const raw = crypto.randomBytes(32).toString('hex');
    const record: PendingRegistration = {
        username: rec.username,
        email: rec.email,
        passwordHash: rec.passwordHash,
        displayName: rec.displayName,
        expires: Date.now() + ttlMs,
    };
    if (!(await addOption(optionNameFor(raw), record, 'no'))) {
        // 256 random bits do not collide; if the row is somehow there, nothing was stored for THIS link.
        throw new Error('Could not store the pending registration');
    }
    await prunePendingRegistrations();
    return raw;
}

/**
 * The registration a link names, CONSUMED: the row is deleted before it is returned, and only the caller
 * whose delete removed it gets the record, so two concurrent clicks cannot both create the account.
 * null for a malformed, unknown, already-used or expired token.
 */
async function consumePendingRegistration(rawToken: unknown): Promise<PendingRegistration | null> {
    if (typeof rawToken !== 'string' || !RAW_TOKEN_RE.test(rawToken)) return null;
    const { getOption, deleteOption } = require('./options');
    const name = optionNameFor(rawToken);
    const rec = await getOption(name, null);
    if (rec === null || rec === undefined) return null;
    if (!(await deleteOption(name))) return null; // another request consumed it first
    if (!isRecord(rec) || !(Date.now() <= rec.expires)) return null;
    return rec;
}

module.exports = {
    createPendingRegistration,
    consumePendingRegistration,
    prunePendingRegistrations,
    PENDING_REGISTRATION_OPTION_PREFIX: PREFIX,
    pendingRegistrationOptionName: optionNameFor,
};
