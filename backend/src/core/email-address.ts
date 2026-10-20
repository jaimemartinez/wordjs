/**
 * WordJS — ACCOUNT EMAIL ADDRESSES: the one address-shape rule, and the one self-service email-write rule.
 *
 * === THE SHAPE RULE ================================================================================
 * Every email-format check in the codebase routes through isValidAddress / domainOfAddress here, so the
 * host and any (sandboxed, so necessarily separate) plugin copy agree byte-for-byte on what an address is
 * and how its domain is taken — backend/src/tests/mail-server-mailbox-gate.test.ts asserts the mail
 * plugin's copy returns the same answer for a shared adversarial table.
 *
 * === THE SELF-SERVICE RULE =========================================================================
 * The account's own email (`user_email`) is written by the account itself: PUT /users/me is guarded by
 * `authenticate` only, and POST /auth/register (when `users_can_register` is on) takes the address from an
 * UNAUTHENTICATED request. So the address is never an authorization fact — what an account may do is
 * decided by its role and by the per-account grants an administrator gives it (core/account-capabilities).
 * Two things about the address still need the administrator, and refuseSelfServiceEmailChange enforces both:
 *
 *   - THE SITE'S OWN EMAIL DOMAIN is reserved. An address on it names the organisation (in the site's user
 *     directory, recipient autocomplete, and — when a plugin delivers mail for that domain — inbound mail
 *     matched to account emails), so only an `edit_users` caller may assign one.
 *   - AN ADDRESS BOUND TO A GRANT is locked. A plugin may declare that one of its account capabilities binds
 *     the account's address (`locksEmail`); while the account holds it, moving the address is the
 *     administrator's call, since the grant's service lives at that address.
 *
 * Core knows neither what the domain is used for nor what the grant means: the domain is the published
 * `mail_domain` option (any plugin that serves the site's mail may publish it, the site hostname otherwise),
 * and the lock is the generic declaration flag.
 */

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

// Length cap applied BEFORE EMAIL_FORMAT_RE runs. The pattern is polynomial (quadratic backtracking on a
// long run with no '@'), so testing it against an unbounded, attacker-controlled value is a ReDoS that
// pins the single-threaded event loop for minutes (CodeQL js/polynomial-redos, reachable unauthenticated
// via POST /register and guest comments). 254 = RFC 5321 max address length: no real address is rejected,
// and the cost is bounded at 254². Every email-format check in the codebase routes through here.
const MAX_EMAIL_LEN = 254;

/** The domain part of a well-formed address, or '' for anything that is not one. */
function domainOfAddress(email: any): string {
    const s = normalizeAddress(email);
    if (s.length > MAX_EMAIL_LEN || !EMAIL_FORMAT_RE.test(s)) return '';
    return s.slice(s.indexOf('@') + 1); // exactly one '@' — indexOf === lastIndexOf
}

/** True when `email` is a syntactically valid address (the one shape rule, exposed for validators). */
function isValidAddress(email: any): boolean {
    const s = normalizeAddress(email);
    return s.length <= MAX_EMAIL_LEN && EMAIL_FORMAT_RE.test(s);
}

/**
 * THE SITE'S OWN EMAIL DOMAIN — the domain whose addresses only an administrator assigns.
 *
 * The published `mail_domain` option when one is set, else the site's link hostname. The option exists
 * because the domain a site sends and receives mail as is not always its web hostname: an install at
 * https://www.acme.com typically uses acme.com addresses. Whatever serves the site's mail knows that answer
 * (often from settings core may not read, such as a DKIM domain kept with the plugin's secrets) and
 * publishes it here; with nothing publishing it the site hostname is the natural answer.
 */
async function getReservedEmailDomain(): Promise<string> {
    const { getOption } = require('./options');
    try {
        const published = String((await getOption('mail_domain', '')) || '')
            .trim().toLowerCase().replace(/\.$/, '');
        if (published) return published;
    } catch { /* option store unavailable — fall through to the site URL */ }
    try {
        // The site's link base (core/site-address): the same host every outgoing link uses.
        return (await require('./site-address').linkHostname()).toLowerCase();
    } catch { return ''; }
}

/** True when `email` is an address on the site's own email domain. */
async function isOnReservedEmailDomain(email: any): Promise<boolean> {
    const d = domainOfAddress(email);
    if (!d) return false;
    const reserved = await getReservedEmailDomain();
    return !!reserved && d === reserved;
}

/**
 * The refusal every SELF-SERVICE email write shares (PUT /users/me, PUT /users/:id by a caller without
 * edit_users, POST /auth/register). One constant so the three sites cannot drift. The code is part of the
 * public API (the registration form maps it), so it keeps its historical name.
 */
const RESERVED_EMAIL_DOMAIN_REFUSAL = {
    code: 'rest_reserved_mail_domain',
    message: 'Addresses on this site\'s own email domain can only be assigned by an administrator. Use a different address, or ask an administrator to set one up for you.',
    data: { status: 403 }
};

/**
 * The refusal for a self-service attempt to CHANGE an address that a granted account capability binds
 * (core/account-capabilities `locksEmail`). The code keeps its historical name (public API).
 */
const EMAIL_ADDRESS_LOCKED_REFUSAL = {
    code: 'rest_mailbox_address_locked',
    message: 'Your account email is tied to a service an administrator enabled for your account, so only an administrator can change it. Ask an administrator to update it (Users → edit user), or set a personal / recovery email instead.',
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
 * DELIBERATE scope call — the current-password re-auth in PUT /users/me covers the `password` field only,
 * and extending sudo re-auth to email changes is a broader session-hardening change.
 */
async function refuseSelfServiceEmailChange(target: any, nextEmail: any): Promise<any | null> {
    const next = normalizeAddress(nextEmail);
    if (!next) return null;                                      // no email in the payload — nothing to do
    const current = normalizeAddress(target && target.userEmail);
    if (next === current) return null;                           // unchanged resend
    // A granted account capability binds this address: only an administrator may move it.
    if (target && require('./account-capabilities').locksEmail(target)) return EMAIL_ADDRESS_LOCKED_REFUSAL;
    // …and nobody may self-assign an address on the site's own email domain in the first place.
    if (await isOnReservedEmailDomain(next)) return RESERVED_EMAIL_DOMAIN_REFUSAL;
    return null;
}

module.exports = {
    EMAIL_FORMAT_RE,
    RESERVED_EMAIL_DOMAIN_REFUSAL,
    EMAIL_ADDRESS_LOCKED_REFUSAL,
    normalizeAddress,
    domainOfAddress,
    isValidAddress,
    getReservedEmailDomain,
    isOnReservedEmailDomain,
    refuseSelfServiceEmailChange,
};
