/**
 * `/comments/feed.xml` — the site-wide comment channel (approved comments on published posts only;
 * the commenter's e-mail and IP are never selected upstream).
 */
import { proxySeo } from '../../_seo/upstream';

export const revalidate = 900;

export async function GET() {
    return proxySeo('/seo/comments/feed.xml', { revalidate, tags: ['posts', 'comments'] });
}
