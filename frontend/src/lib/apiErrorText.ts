/**
 * The text to show for an API error, in the admin's language.
 *
 * The backend answers every error with a STABLE `code` and an English `message`. Screens used to show
 * the message as it came, so a Spanish panel said «Invalid username or password.» in a red box. The
 * code is what identifies the error; the message is copy. This maps the code to a catalogue key
 * (`apiError.<code>`) and only falls back to the server's English when the catalogue has nothing.
 *
 * A few codes cover more than one situation and carry the detail in `data` (the login throttle's
 * remaining time); those get their own key with the number filled in.
 */
import { plural } from "./i18n";

export interface ApiErrorLike {
    code?: string | null;
    message?: string | null;
    data?: Record<string, unknown> | null;
}

type Translate = (key: string) => string;

const has = (t: Translate, key: string) => t(key) !== key;

/**
 * Codes that name a CLASS of error (`rest_invalid_param`, `rest_forbidden`) say too little on their own:
 * the message is what tells the reader which rule they hit. Those are matched on the exact English
 * text instead, and only the ones an account screen can actually show are listed.
 */
const BY_MESSAGE: Record<string, string> = {
    "Invalid email format.": "apiError.msg.invalidEmail",
    "Password must not exceed 72 characters.": "apiError.msg.passwordTooLong",
    "Password must be at least 8 characters.": "apiError.msg.passwordTooShort",
    "expiresInDays must be a positive number of days.": "apiError.msg.expiresInDays",
    "Only an administrator can assign the administrator role.": "apiError.msg.cannotAssignAdmin",
    "Only an administrator can edit a privileged account.": "apiError.msg.cannotEditPrivileged",
    "Only an administrator can reset two-factor authentication on a privileged account.": "apiError.msg.cannotResetPrivilegedMfa",
    "You are not allowed to change user roles.": "apiError.msg.cannotChangeRoles",
    "You cannot assign a role with capabilities beyond your own.": "apiError.msg.roleBeyondOwn",
    "You cannot edit this user.": "apiError.msg.cannotEditUser",
    "Only a user manager can grant or revoke an account capability.": "apiError.msg.capabilityManager",
};
const CLASS_CODES = new Set(["rest_invalid_param", "rest_forbidden"]);

/** Read code/message/data off anything a caller caught (an Error from lib/api, a JSON body, a string). */
export function asApiError(err: unknown): ApiErrorLike {
    if (!err) return {};
    if (typeof err === "string") return { message: err };
    if (typeof err !== "object") return {};
    const e = err as { code?: unknown; message?: unknown; error?: unknown; data?: unknown };
    return {
        code: typeof e.code === "string" ? e.code : typeof e.error === "string" && /^[a-z_]+$/.test(e.error) ? e.error : null,
        message: typeof e.message === "string" ? e.message : null,
        data: e.data && typeof e.data === "object" && !Array.isArray(e.data) ? (e.data as Record<string, unknown>) : null,
    };
}

/**
 * @param fallbackKey shown when the error has no code the catalogue knows AND no message (a network
 *                    failure, a non-JSON body). An unknown code with a message shows the message.
 */
export function apiErrorText(t: Translate, err: unknown, fallbackKey?: string): string {
    const { code, message, data } = asApiError(err);
    if (message && BY_MESSAGE[message] && has(t, BY_MESSAGE[message])) return t(BY_MESSAGE[message]);
    if (code && !CLASS_CODES.has(code)) {
        if (code === "rest_login_throttled" && typeof data?.retryAfterMs === "number" && data.retryAfterMs > 0) {
            const n = Math.max(1, Math.ceil(data.retryAfterMs / 60000));
            return plural(t, "apiError.rest_login_throttled.minutes", n).replace("{n}", String(n));
        }
        const key = `apiError.${code}`;
        if (has(t, key)) return t(key);
    }
    if (message) return message;
    return fallbackKey ? t(fallbackKey) : "";
}
