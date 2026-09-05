/**
 * `/sitemap.xml` — the URL `robots.txt` has always advertised (`Sitemap: <siteUrl>/sitemap.xml`) and
 * that nothing served until now. The document itself is the backend's: a single `<urlset>` while the
 * site fits in one file, a `<sitemapindex>` above SITEMAP_MAX_URLS.
 */
import { proxySeo } from '../_seo/upstream';

/** The window the upstream advertises (`public, max-age=3600`, backend/src/routes/seo.ts). */
export const revalidate = 3600;

export async function GET() {
    return proxySeo('/seo/sitemap.xml', { revalidate, tags: ['posts', 'settings'] });
}
