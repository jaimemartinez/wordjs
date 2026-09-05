/** `/feed.atom` — the same items as `/feed.xml`, as Atom 1.0. */
import { proxySeo } from '../_seo/upstream';

export const revalidate = 900;

export async function GET() {
    return proxySeo('/seo/feed.atom', { revalidate, tags: ['posts', 'settings'] });
}
