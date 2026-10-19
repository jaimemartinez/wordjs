/**
 * `/feed.json` — the same items as `/feed.xml`, as JSON Feed 1.1. The upstream sends it with the
 * `application/feed+json` type (not `application/json`), and that header is carried through.
 */
import { proxySeo, siteHostOf } from '../_seo/upstream';

export const revalidate = 900;

export async function GET(_req?: Request, ctx?: { params?: Promise<Record<string, string>> }) {
    return proxySeo('/seo/feed.json', { revalidate, tags: ['posts', 'settings'], siteHost: await siteHostOf(ctx) });
}
