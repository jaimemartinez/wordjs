/**
 * An on/off site option as GET /settings returns it.
 *
 * The settings endpoint JSON-parses stored values, so a switch saved as "0" arrives as the NUMBER 0 and
 * `settings.comments_enabled !== "0"` was true for every saved value: turning comments off left the
 * form on every post. Mirrors backend core/options `toBooleanOption`: 1/"1"/true/"true"/"yes"/"on" are
 * on, 0/"0"/false/"false"/"no"/"off"/"" are off, anything else is `fallback`.
 */
export function optionEnabled(value: unknown, fallback: boolean): boolean {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        if (["1", "true", "yes", "on"].includes(v)) return true;
        if (["0", "false", "no", "off", ""].includes(v)) return false;
    }
    return fallback;
}
