/**
 * THE PUBLIC IDENTITY OF AN ACCOUNT IS NEVER ITS LOGIN.
 *
 * Every anonymous surface that names a person — a post byline (models/Post.ts getAuthorsForIds, which
 * REST, GraphQL and the MCP projection all serialise), the author feed (routes/seo.ts), the
 * `/author/<slug>` archive, the name stored on a signed-in commenter's comment — prints the DISPLAY
 * NAME and addresses them by the NICENAME. Both used to default to the login (WordPress parity), so a
 * default install published, for every account, the exact string its sign-in form takes.
 *
 * This module is the one place that rule is written down. It is pure (no database, no model), so the
 * writer (models/User.ts create), the readers, and the schema migration that repairs existing rows
 * (core/schema-migrations.ts 0017) all apply the SAME comparison and the SAME placeholder — a
 * migration cannot require a model (that re-enters config/database while it initialises), but it can
 * require this.
 */

const { sanitizeTitle } = require('./formatting');

function norm(value: any): string {
    return value == null ? '' : String(value).normalize('NFC').trim().toLowerCase();
}

/** Is this display name the login, as anything public would print it? (Case-insensitive, trimmed.) */
function isLoginDerivedName(value: any, login: any): boolean {
    const v = norm(value);
    const l = norm(login);
    return v !== '' && l !== '' && v === l;
}

/**
 * Is this public slug the login, or what the login slugifies to? `user_nicename` was derived from a
 * display name that defaulted to the login, so `sanitizeTitle(login)` is the shape those rows carry.
 */
function isLoginDerivedSlug(slug: any, login: any): boolean {
    const s = norm(slug);
    const l = norm(login);
    if (s === '' || l === '') return false;
    return s === l || s === sanitizeTitle(String(login));
}

/** The name an account that never chose one is shown under. Derived from the id, which is already public. */
function placeholderDisplayName(id: any): string {
    return `User ${id}`;
}

/**
 * The display name a PUBLIC surface prints for a row. A stored name that is empty or is the login
 * becomes the placeholder — the backstop for a row no writer has repaired (a direct import, a plugin
 * writing the column, a user who later typed their login as their name).
 */
function publicDisplayName(id: any, displayName: any, login: any): string {
    const name = displayName == null ? '' : String(displayName).trim();
    if (!name || isLoginDerivedName(name, login)) return placeholderDisplayName(id);
    return name;
}

/**
 * The display name an account is CREATED with: the given one, or '' (the caller then writes the
 * placeholder) when it is missing or is the login. A value, not a verdict — the writer stores what this
 * returns and never branches on the raw input itself.
 */
function ownDisplayName(displayName: any, login: any): string {
    const name = displayName == null ? '' : String(displayName);
    return isLoginDerivedName(name, login) ? '' : name;
}

/**
 * The explicit slug an account is CREATED with: the given one, or '' when it is missing or slugifies
 * to the login.
 */
function ownNicename(nicename: any, login: any): string {
    const slug = nicename == null ? '' : String(nicename);
    return isLoginDerivedSlug(sanitizeTitle(slug), login) ? '' : slug;
}

module.exports = { isLoginDerivedName, isLoginDerivedSlug, placeholderDisplayName, publicDisplayName, ownDisplayName, ownNicename };
