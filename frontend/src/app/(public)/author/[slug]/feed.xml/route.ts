/**
 * `/author/<slug>/feed.xml` — the scoped RSS channel for one author.
 *
 * The slug here is the author's NICENAME/login, which is what the backend feed resolves against the
 * database; the archive page one level up takes a numeric user id instead (documentation/frontend.md
 * records that mismatch). Both spellings reach this route; the backend decides which one exists.
 */
import { proxySeo, seoNotFound } from '../../../_seo/upstream';

export const revalidate = 900;

const SLUG_MAX = 200;

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
    const { slug } = await ctx.params;
    if (!slug || slug.length > SLUG_MAX) return seoNotFound();
    return proxySeo(`/seo/author/${encodeURIComponent(slug)}/feed.xml`, { revalidate, tags: ['posts', 'settings'] });
}
