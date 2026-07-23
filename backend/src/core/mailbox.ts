/**
 * WordJS — ACTIVE CORPORATE (PROFESSIONAL) MAILBOX: the one host-side definition.
 *
 * === WHY THIS FILE EXISTS =======================================================================
 * "This account has a mailbox on the site's mail domain" used to be DERIVED from the account's own
 * email address (`user_email` ends in @siteDomain). That derivation is not an authorization fact,
 * because the field it reads is writable by the very account it is meant to exclude:
 *
 *   - PUT /users/me is guarded by `authenticate` only. Any subscriber could set their email to
 *     me@<siteDomain> and instantly hold every "professional mailbox" privilege — including sending
 *     through the site MTA, signed with the site's DKIM key.
 *   - POST /auth/register (when `users_can_register` is on) took the address verbatim from an
 *     UNAUTHENTICATED request, so the same grant was reachable without an account at all.
 *   - The mail plugin's inbound delivery used the same derivation, so self-assigning an unused
 *     corporate address ALSO redirected that address's incoming mail into the attacker's inbox.
 *
 * The fact is therefore stored EXPLICITLY, in `user_meta.professional_mailbox`, and only a caller
 * holding `edit_users` may write it (routes/users.ts). `User.update()` additionally lists the key in
 * PROTECTED_META so it can never be mass-assigned through the generic `data.meta` path.
 *
 * Every consumer reads it through `hasProfessionalMailbox()` here:
 *   - core admin-menu visibility            (routes/plugins.ts GET /plugins/menus)
 *   - the projections handed to plugins     (core/plugin-api.ts projectUser, core/plugin-isolate.ts)
 *   - the mail plugin's route gate + inbound delivery, off the projected boolean.
 * One fact, one reader: menu visibility and route access cannot disagree.
 *
 * The address-shape helpers live here too so the host and the (sandboxed, so necessarily separate)
 * plugin copy agree byte-for-byte on how a domain is taken from an address — see
 * backend/src/tests/mail-server-mailbox-gate.test.ts, which asserts the two implementations return
 * the same answer for a shared adversarial table.
 */

/**
 * The user_meta key holding the fact. '1' = enabled; anything else (including absent) = disabled.
 * Deliberately NOT matched by User.toJSON's SENSITIVE_META filter, so the admin user form can read
 * the current state back.
 */
const MAILBOX_META_KEY = 'professional_mailbox';

/**
 * The single address-shape rule, shared by every caller.
 *
 * It is the SAME regex User.update() has always enforced, which matters: because `[^\s@]+` cannot
 * contain '@', an address is accepted only when it holds EXACTLY ONE '@'. That kills the whole
 * "which @ is the separator?" ambiguity class — `a@gmail.com@acme.example` is simply not an address,
 * so no two readers can disagree about its domain (previously the plugin took the text after the
 * LAST '@' and the host after the FIRST, i.e. one saw acme.example and the other gmail.com).
 */
const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Canonicalize an address for comparison: the SAME fold User.normalizeEmail applies before storing
 * (trim + NFC + full-Unicode lowercase), so a comparison here can never miss a stored row.
 */
function normalizeAddress(email: any): string {
    return String(email == null ? '' : email).trim().normalize('NFC').toLowerCase();
}

/** The domain part of a well-formed address, or '' for anything that is not one. */
function domainOfAddress(email: any): string {
    const s = normalizeAddress(email);
    if (!EMAIL_FORMAT_RE.test(s)) return '';
    return s.slice(s.indexOf('@') + 1); // exactly one '@' — indexOf === lastIndexOf
}

/** True when `email` is a syntactically valid address (the one shape rule, exposed for validators). */
function isValidAddress(email: any): boolean {
    return EMAIL_FORMAT_RE.test(normalizeAddress(email));
}

/**
 * THE predicate. Accepts a core User instance (meta loaded), any object carrying the projected
 * `hasProfessionalMailbox` boolean (what plugins receive), or a bare user_meta map.
 *
 * NOT cached anywhere: `req.user` is rebuilt from the database by middleware/auth.ts on every
 * request, so an admin turning the toggle off denies the very next request instead of leaving a
 * stale grant alive in some process.
 */
function hasProfessionalMailbox(user: any): boolean {
    if (!user) return false;
    // A projection (plugin bridge / isolate req.user) carries the answer directly.
    if (typeof user.hasProfessionalMailbox === 'boolean') return user.hasProfessionalMailbox;
    const meta = (user.meta && typeof user.meta === 'object') ? user.meta : user;
    return String((meta && meta[MAILBOX_META_KEY]) ?? '') === '1';
}

/** Normalize any truthy/falsy input to the stored representation ('1' / '0'). */
function mailboxFlagValue(on: any): string {
    // Accept the JSON shapes a form/API client can send: true, 'true', 1, '1', 'on'.
    const s = String(on == null ? '' : on).trim().toLowerCase();
    return (on === true || s === '1' || s === 'true' || s === 'on') ? '1' : '0';
}

/**
 * THE DOMAIN THIS INSTALL IS AUTHORITATIVE FOR MAIL ON — the host-side half of the same SSOT the
 * mail plugin uses (`mail_security_dkim_domain || site hostname`).
 *
 * It is NOT simply the site hostname. An install at https://www.acme.com that publishes SPF/DKIM/MX
 * for `acme.com` sets `mail_security_dkim_domain` to acme.com; that override is the operator's
 * statement of which domain the server signs and sends as, so it is the domain whose local parts are
 * reserved corporate mailboxes. Deriving this from `siteurl` alone would reserve the wrong name.
 *
 * `mail_security_dkim_domain` is a plain site option (not a secret) and stays meaningful on an
 * install with no mail plugin at all, where it is simply unset and the site hostname is used.
 */
async function getMailDomain(): Promise<string> {
    const { getOption } = require('./options');
    try {
        const explicit = String((await getOption('mail_security_dkim_domain', '')) || '')
            .trim().toLowerCase().replace(/\.$/, '');
        if (explicit) return explicit;
    } catch { /* option store unavailable — fall through to the site URL */ }
    try {
        const url = await getOption('siteurl', await getOption('home', 'http://localhost'));
        return new URL(String(url)).hostname.toLowerCase();
    } catch { return ''; }
}

/** True when `email` is a local part on the mail domain — i.e. a corporate mailbox address. */
async function isOnMailDomain(email: any): Promise<boolean> {
    const d = domainOfAddress(email);
    if (!d) return false;
    const mail = await getMailDomain();
    return !!mail && d === mail;
}

/**
 * The refusal every SELF-SERVICE email write shares (PUT /users/me, PUT /users/:id by a caller
 * without edit_users, POST /auth/register). One constant so the three sites cannot drift.
 *
 * WHY REFUSE AT ALL, given the gate no longer reads the address: because the address IS the mailbox
 * on the mail domain. Letting an unprivileged account claim <someone>@<mailDomain> would still hand
 * it that mailbox's INBOUND mail (delivery matches the recipient against account emails), and would
 * let it impersonate the organisation in the site's own user directory and recipient autocomplete.
 * Administrators and `edit_users` delegates are unaffected: provisioning corporate addresses is
 * exactly their job.
 */
const RESERVED_MAIL_DOMAIN_REFUSAL = {
    code: 'rest_reserved_mail_domain',
    message: 'Addresses on this site\'s own mail domain are corporate mailboxes and can only be assigned by an administrator. Use a different address, or ask an administrator to enable a professional mail account for you.',
    data: { status: 403 }
};

/**
 * The refusal for a self-service attempt to CHANGE the address of an account that already has a
 * corporate mailbox: that address is the mailbox, so moving it off the domain silently orphans the
 * account's incoming mail (it starts falling to the catch-all, or bouncing). Admin-owned state,
 * admin-owned change.
 */
const MAILBOX_ADDRESS_LOCKED_REFUSAL = {
    code: 'rest_mailbox_address_locked',
    message: 'Your account email is your corporate mailbox address, so only an administrator can change it. Ask an administrator to update it (Users → edit user), or set a personal / recovery email instead.',
    data: { status: 403 }
};

/**
 * THE self-service email-write rule — one implementation, three callers (PUT /users/me, PUT
 * /users/:id when the caller does not hold `edit_users`, and POST /auth/register with `target` null).
 *
 * Returns `null` when the write is allowed, or the refusal body to answer 403 with.
 *
 * A resend of the UNCHANGED address is explicitly a no-op, not a change: the admin/profile forms post
 * every field on every save, so treating an identical value as an attempted change would 403 ordinary
 * "update my display name" saves — the same trap the role handling in routes/users.ts already
 * documents.
 *
 * NOTE what this does NOT do: it does not require re-authentication for an email change. That is a
 * DELIBERATE scope call, not an oversight — the current-password re-auth in PUT /users/me covers the
 * `password` field only, and extending sudo re-auth to email changes is a broader session-hardening
 * change (it would also want to cover the recovery address and would need a UI prompt) that belongs in
 * its own change. It is called out in the PR body rather than silently skipped. The privilege-relevant
 * half — that a self-service caller can never reach a corporate address — is closed here.
 */
async function refuseSelfServiceEmailChange(target: any, nextEmail: any): Promise<any | null> {
    const next = normalizeAddress(nextEmail);
    if (!next) return null;                                      // no email in the payload — nothing to do
    const current = normalizeAddress(target && target.userEmail);
    if (next === current) return null;                           // unchanged resend
    // The account's address IS its corporate mailbox: only an administrator may move it.
    if (hasProfessionalMailbox(target)) return MAILBOX_ADDRESS_LOCKED_REFUSAL;
    // …and nobody may self-assign an address on the mail domain in the first place.
    if (await isOnMailDomain(next)) return RESERVED_MAIL_DOMAIN_REFUSAL;
    return null;
}

module.exports = {
    MAILBOX_META_KEY,
    EMAIL_FORMAT_RE,
    RESERVED_MAIL_DOMAIN_REFUSAL,
    MAILBOX_ADDRESS_LOCKED_REFUSAL,
    normalizeAddress,
    domainOfAddress,
    isValidAddress,
    hasProfessionalMailbox,
    mailboxFlagValue,
    getMailDomain,
    isOnMailDomain,
    refuseSelfServiceEmailChange,
};
