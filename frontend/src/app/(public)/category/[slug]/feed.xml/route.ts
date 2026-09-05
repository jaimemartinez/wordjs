/**
 * `/category/<slug>/feed.xml` — the scoped RSS channel for one category, at the URL the archive page
 * advertises and a reader guesses.
 *
 * PRECEDENCE: this static `feed.xml` segment sits beside `[[...paged]]/page.tsx`, which would
 * otherwise match `/category/news/feed.xml` (as `paged = ['feed.xml']`) and 404 it. Next sorts a
 * static segment ahead of an optional catch-all, so the route handler wins — asserted in
 * `src/app/(public)/__tests__/archiveRoutes.test.tsx` against Next's own `getSortedRoutes`.
 */
import { proxySeo, seoNotFound } from '../../../_seo/upstream';

export const revalidate = 900;

/** The bound the backend puts on a slug arriving in a URL (`usableSlug`, routes/seo.ts). */
const SLUG_MAX = 200;

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
    const { slug } = await ctx.params;
    if (!slug || slug.length > SLUG_MAX) return seoNotFound();
    return proxySeo(`/seo/category/${encodeURIComponent(slug)}/feed.xml`, { revalidate, tags: ['posts', 'settings'] });
}
