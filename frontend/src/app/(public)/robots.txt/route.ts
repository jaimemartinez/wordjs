/**
 * `/robots.txt` — the first file every crawler asks for, and the one URL it will never look for
 * anywhere else. The document is the backend's (`/api/v1/seo/robots.txt`, generated from the
 * configured `siteurl`); this route is the only address it can usefully be served at.
 *
 * Until now nothing answered the site root, so a crawler got the Next 404 page: no `Disallow` was
 * ever honoured, and the `Sitemap:` line — the one hint that `/sitemap.xml` exists — was never read.
 * It is also the file that makes the rest of this directory necessary: it disallows `/api/`, which
 * is why every feed and every sitemap child is advertised at its public URL rather than at the mount
 * that generates it.
 *
 * A route handler, not Next's `robots.ts` convention: the content is generated server-side per
 * install from an option row, so this must be a proxy on the same cache window as its upstream, not
 * a build-time object.
 */
import { proxySeo } from '../_seo/upstream';

/** The window the upstream advertises (`public, max-age=86400`, backend/src/routes/seo.ts). */
export const revalidate = 86400;

export async function GET() {
    // `settings` is the tag that matters here — the body is built from `siteurl`, not from content —
    // but a purge of either must refresh it, exactly like the sitemap it advertises.
    return proxySeo('/seo/robots.txt', { revalidate, tags: ['settings'] });
}
