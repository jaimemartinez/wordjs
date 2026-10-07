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
 */
async function changedRegistrationSettings(values: unknown): Promise<string[]> {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return [];
    const carried = (key: string) => Object.prototype.hasOwnProperty.call(values, key);
    const changed: string[] = [];
    for (const [key, setting] of REGISTRATION_SETTINGS) {
        if (!carried(key)) continue;
        const next = (values as Record<string, unknown>)[key];
        const current = await getOption(key, setting.fallback);
        if (setting.effective(asStored(next)) !== setting.effective(current)) changed.push(key);
    }
    if (carried(MAIL_DELIVERY_READY)) {
        const ready = (v: unknown) => String(v) === '1';
        const verification = REGISTRATION_SETTINGS.get('require_email_verification')!;
        const requiredNext = carried('require_email_verification')
            ? verification.effective(asStored((values as Record<string, unknown>).require_email_verification))
            : verification.effective(await getOption('require_email_verification', verification.fallback));
        const flips = ready(asStored((values as Record<string, unknown>)[MAIL_DELIVERY_READY])) !== ready(await getOption(MAIL_DELIVERY_READY, '0'));
        if (flips && requiredNext === 'on') changed.push(MAIL_DELIVERY_READY);
    }
    return changed;
}

module.exports = { REGISTRATION_SETTINGS, MAIL_DELIVERY_READY, changedRegistrationSettings };
