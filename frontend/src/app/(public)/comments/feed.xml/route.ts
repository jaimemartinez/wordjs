/**
 * `/comments/feed.xml` — the site-wide comment channel (approved comments on published posts only;
 * the commenter's e-mail and IP are never selected upstream).
 */
import { proxySeo, siteHostOf } from '../../_seo/upstream';

export const revalidate = 900;

export async function GET(_req?: Request, ctx?: { params?: Promise<Record<string, string>> }) {
    return proxySeo('/seo/comments/feed.xml', { revalidate, tags: ['posts', 'comments'], siteHost: await siteHostOf(ctx) });
}
