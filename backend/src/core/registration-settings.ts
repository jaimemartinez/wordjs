/**
 * WordJS — THE REGISTRATION SETTINGS: the options that decide who may create an account on their own and
 * with which role. POST /auth/register reads `users_can_register` (may anyone sign up), `default_role`
 * (as what) and `require_email_verification` (must the new account prove its address before it signs in).
 *
 * WHY A MODULE. A session bound to a secondary address may not change them (middleware/auth.ts
 * refuseBoundSession): "anyone may register, as an administrator" is an administrator account created by
 * whoever registers next, after the address and the session that opened the door are gone. Two writers
 * reach these options — PUT /settings and the site import (core/import-export, POST /import) — and both
 * must ask the same question, so it is answered once, here.
 *
 * "Change" means a change in what the reader makes of the value, not in its spelling: the settings screen
 * sends every field on every save, so a save that carries the current value back (`"0"` where 0 is stored)
 * changes nothing and must not be refused.
 *
 * `require_email_verification` only takes effect while a mail provider has declared itself delivery-ready
 * (`mail_delivery_ready` === '1', routes/auth.ts emailVerificationRequired), so writing that flag turns
 * verification off as surely as writing the setting itself; a site import can write it. It counts as a
 * change when it flips readiness while verification is (or is being) required.
 */

const { getOption } = require('./options');

interface RegistrationSetting {
    /** What POST /auth/register falls back to when the option row does not exist. */
    fallback: unknown;
    /** What the reader makes of a stored value, as a comparable string. */
    effective: (value: unknown) => string;
}

const REGISTRATION_SETTINGS: ReadonlyMap<string, RegistrationSetting> = new Map<string, RegistrationSetting>([
    // routes/auth.ts: `if (!registrationAllowed || registrationAllowed == '0')` refuses.
    ['users_can_register', { fallback: 0, effective: (v) => (!v || v == '0' ? 'off' : 'on') }],
    // The role User.create receives for a self-registered account.
    ['default_role', { fallback: 'subscriber', effective: (v) => (v === null || v === undefined ? '' : String(v)) }],
    // routes/auth.ts: `String(await getOption('require_email_verification', '0')) !== '1'` means off.
    ['require_email_verification', { fallback: '0', effective: (v) => (String(v) === '1' ? 'on' : 'off') }],
]);

/** The provider's "I can deliver" flag, which require_email_verification depends on (see above). */
const MAIL_DELIVERY_READY = 'mail_delivery_ready';

/**
 * The value a write stores, as getOption will read it back: updateOption stores '' for null/undefined,
 * JSON for an object and String() for anything else; getOption JSON-parses it, falling back to the text.
 */
function asStored(value: unknown): unknown {
    const serialized = value === undefined || value === null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    try {
        return JSON.parse(serialized);
    } catch {
        return serialized;
    }
}

/**
 * The registration settings that writing `values` (a key → value map, as PUT /settings or an import's
 * `settings` carry it) would CHANGE, in the order of REGISTRATION_SETTINGS, then mail_delivery_ready. Keys
 * it does not carry are not looked at.
 *
 * A key is matched by its CANONICAL name (core/option-names canonicalOptionName), never byte for byte: on
 * MySQL/MariaDB the options table compares names case-insensitively, so a site import carrying
 * `REQUIRE_EMAIL_VERIFICATION: "0"` or `Mail_Delivery_Ready: "0"` wrote the real row while an exact-name
 * check saw neither. Every spelling a map carries is judged — any one of them may be the write that
 * lands last — and the setting is reported under its canonical name. A name with no canonical form is
 * written by nobody (the site import and the options bridge refuse it, PUT /settings writes only its own
 * allowlist), so it is not looked at here.
 */
async function changedRegistrationSettings(values: unknown): Promise<string[]> {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return [];
    const { canonicalOptionName } = require('./option-names');
    // canonical name → every value the map carries under a spelling of it.
    const carried = new Map<string, unknown[]>();
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
        const name = canonicalOptionName(key);
        if (name === null || !(REGISTRATION_SETTINGS.has(name) || name === MAIL_DELIVERY_READY)) continue;
        const list = carried.get(name) || [];
        list.push(value);
        carried.set(name, list);
    }
    const changed: string[] = [];
    for (const [key, setting] of REGISTRATION_SETTINGS) {
        const nexts = carried.get(key);
        if (!nexts) continue;
        const current = setting.effective(await getOption(key, setting.fallback));
        if (nexts.some((next) => setting.effective(asStored(next)) !== current)) changed.push(key);
    }
    const readiness = carried.get(MAIL_DELIVERY_READY);
    if (readiness) {
        const ready = (v: unknown) => String(v) === '1';
        const verification = REGISTRATION_SETTINGS.get('require_email_verification')!;
        // Required after the write if it is now, or if any spelling the map carries turns it on.
        const verificationNexts = carried.get('require_email_verification') || [];
        const requiredNext = verification.effective(await getOption('require_email_verification', verification.fallback)) === 'on'
            || verificationNexts.some((next) => verification.effective(asStored(next)) === 'on');
        const readyNow = ready(await getOption(MAIL_DELIVERY_READY, '0'));
        const flips = readiness.some((next) => ready(asStored(next)) !== readyNow);
        if (flips && requiredNext) changed.push(MAIL_DELIVERY_READY);
    }
    return changed;
}

module.exports = { REGISTRATION_SETTINGS, MAIL_DELIVERY_READY, changedRegistrationSettings };
