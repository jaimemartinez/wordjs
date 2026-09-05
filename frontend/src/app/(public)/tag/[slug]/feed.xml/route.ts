/**
 * `/tag/<slug>/feed.xml` — the scoped RSS channel for one tag. Same precedence note as the category
 * feed: the static segment beats the archive's `[[...paged]]` catch-all.
 */
import { proxySeo, seoNotFound } from '../../../_seo/upstream';

export const revalidate = 900;

const SLUG_MAX = 200;

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
    const { slug } = await ctx.params;
    if (!slug || slug.length > SLUG_MAX) return seoNotFound();
    return proxySeo(`/seo/tag/${encodeURIComponent(slug)}/feed.xml`, { revalidate, tags: ['posts', 'settings'] });
}
