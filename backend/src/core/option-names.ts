/**
 * WordJS — THE NAME THE GUARD SEES MUST BE THE NAME THE DATABASE SEES.
 *
 * `options.option_name` is compared by the database, not by JavaScript. On MySQL/MariaDB the column has
 * no binary collation (the pool speaks utf8mb4_unicode_ci and the schema declares none), so the engine
 * matches option names case-insensitively, accent-insensitively, ignoring zero-weight code points and —
 * under the PAD SPACE collations — trailing spaces. `PLUGIN_GRANTS`, `plugin_grànts`, `plugin_grants `
 * and `plugin_grants` + U+200B are four strings to a Set and ONE row to MySQL: a guard that compared the
 * name it was shown would refuse one spelling and then let another read or overwrite the row (an
 * `INSERT … ON DUPLICATE KEY UPDATE` lands on the existing row). Same "checked value is not the used
 * value" class core/protected-meta closes for post meta.
 *
 * So every check that protects an option BY NAME compares this canonical form: the options bridge and
 * the theme backstop (core/plugin-api isProtectedOption), the site import's settings loop, and the
 * registration-settings check that PUT /settings, PUT /settings/:key and POST /import ask
 * (core/registration-settings changedRegistrationSettings).
 *
 * Case is folded (ASCII has no other collation-equal pairs). Everything a fold cannot model soundly —
 * any character outside printable ASCII, a leading or trailing space, a non-string name the driver would
 * flatten into a string — has NO canonical form (null). A protecting check must answer such a name
 * "protected" (refuse it): no option the host or a shipped plugin uses is spelled that way, and refusing
 * a name is the only answer that is right under every engine's collation.
 */

const COMPARABLE_OPTION_NAME = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

/** The option name as every supported engine compares it, or null when no fold can say (see above). */
function canonicalOptionName(name: unknown): string | null {
    if (typeof name !== 'string' || !COMPARABLE_OPTION_NAME.test(name)) return null;
    return name.toLowerCase();
}

module.exports = { canonicalOptionName };
