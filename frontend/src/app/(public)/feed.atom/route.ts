/** `/feed.atom` — the same items as `/feed.xml`, as Atom 1.0. */
import { proxySeo, siteHostOf } from '../_seo/upstream';

export const revalidate = 900;

export async function GET(_req?: Request, ctx?: { params?: Promise<Record<string, string>> }) {
    return proxySeo('/seo/feed.atom', { revalidate, tags: ['posts', 'settings'], siteHost: await siteHostOf(ctx) });
}
