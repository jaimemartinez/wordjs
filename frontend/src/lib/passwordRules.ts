/**
 * The password length rules the backend applies (models/User.ts passwordTooLong), for the screens that
 * set a password to say so before the round trip.
 *
 * The upper limit is 72 BYTES, not characters: bcrypt reads no more than that and would silently ignore
 * the rest. In UTF-8 an accented letter takes 2 bytes and an emoji 4, so "72 characters" is only true of
 * plain letters, digits and symbols.
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX_BYTES = 72;

/** The size bcrypt sees: UTF-8 bytes. */
export function passwordBytes(password: string): number {
    return new TextEncoder().encode(String(password ?? "")).length;
}

export function passwordTooLong(password: string): boolean {
    return passwordBytes(password) > PASSWORD_MAX_BYTES;
}
