/**
 * WordJS — OLD AUTHOR SLUGS ARE RESOLVED ONLY WHEN AN ADMINISTRATOR SAYS SO.
 *
 * Migration 0017 moved every author off a public slug that had been derived from the account's LOGIN and
 * kept the slug it moved them off as `previous_nicename` user meta, so archive and feed URLs already in
 * the wild could keep working. But that kept slug IS the login (slugified): resolving it for anyone who
 * asks — `?author=<slug>`, `/author/<slug>/feed.xml` — answers "an account signs in with this name" for
 * every guess, one request at a time, which is the fact 0017 exists to stop publishing. No answer that
 * resolves the alias can avoid it: a redirect to the new slug, a 200 instead of a 404, even a different
 * response time all tell a known login apart from an unknown one.
 *
 * So resolving the aliases is an explicit opt-in, OFF unless an administrator turns it on in Settings
 * (with the warning that it confirms logins of authors who published before the upgrade). While it is
 * off an old slug is exactly an unknown slug on every anonymous surface; the meta rows are kept, so
 * turning it on later restores the old URLs without re-running anything.
 */

/** The admin-only option (routes/settings ALL_SETTINGS; protected from plugins in core/plugin-api). */
const LEGACY_AUTHOR_SLUGS_OPTION = 'author_legacy_slugs';

function truthy(v: unknown): boolean {
    return v === true || v === 1 || v === '1' || v === 'on' || v === 'true';
}

/** Does this site resolve the author slugs migration 0017 retired? False unless explicitly enabled. */
async function legacyAuthorSlugsEnabled(): Promise<boolean> {
    try {
        return truthy(await require('./options').getOption(LEGACY_AUTHOR_SLUGS_OPTION, '0'));
    } catch {
        return false;
    }
}

module.exports = { LEGACY_AUTHOR_SLUGS_OPTION, legacyAuthorSlugsEnabled };
