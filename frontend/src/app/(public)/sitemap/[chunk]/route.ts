/**
 * ONE CHILD OF THE SITEMAP INDEX — `/sitemap/posts-1.xml`, `/sitemap/pages-1.xml`,
 * `/sitemap/terms-2.xml` … Above 1 000 URLs the backend's `/sitemap.xml` becomes a `<sitemapindex>`
 * whose children are `sitemap-{posts|pages|terms}-{n}.xml`; this route is where those documents live
 * under the public origin.
 *
 * WHY THE SEGMENT IS `/sitemap/<kind>-<n>.xml` AND NOT THE FLAT `/sitemap-<kind>-<n>.xml`
 * -------------------------------------------------------------------------------------
 * The App Router has no partial dynamic segments. A folder called `sitemap-[chunk].xml` is not a
 * parameterised route at all — Next's own `isDynamicRoute('/sitemap-[chunk].xml')` answers **false**
 * (next/dist/shared/lib/router/utils/is-dynamic), so the segment stays a LITERAL and the route would
 * only ever answer a request for the path `/sitemap-[chunk].xml`. Worse, the regex builder does
 * match a parameter inside a segment but drops its prefix and suffix unless `includePrefix` /
 * `includeSuffix` are set (they are set only for `.rsc` data routes), which turns the pattern into
 * `^/([^/]+?)$` — a route that would swallow `/about` and every other top-level page. A dynamic
 * segment of its own is therefore the only shape that both matches and stays contained, and it may
 * not be a second name at the root (`/[chunk]` beside `(public)/[slug]` is the "different slug names
 * for the same dynamic path" build error), so it nests under a static `sitemap/`.
 *
 * This shape is the CONTRACT the backend's index prints: `publicSeoUrl()` (backend/src/core/feeds.ts)
 * turns each child's file name into `<siteUrl>/sitemap/<kind>-<n>.xml`, and the handler below turns
 * that last segment back into the file name by prepending `sitemap-`. The two halves are asserted
 * against each other in backend/src/tests/seo.test.ts — see documentation/frontend.md.
 */
import { proxySeo, seoNotFound } from '../../_seo/upstream';

export const revalidate = 3600;

/**
 * The exact shape the sitemap index prints. Anything else never existed as a chunk, so it is a 404
 * here rather than a request the backend has to refuse.
 */
const CHUNK_NAME = /^sitemap-(posts|pages|terms)-\d+\.xml$/;

export async function GET(_req: Request, ctx: { params: Promise<{ chunk: string }> }) {
    const { chunk } = await ctx.params;
    const name = `sitemap-${chunk}`;
    if (!CHUNK_NAME.test(name)) return seoNotFound();
    return proxySeo(`/seo/${name}`, { revalidate, tags: ['posts', 'settings'] });
}
