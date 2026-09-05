/**
 * `/feed.json` — the same items as `/feed.xml`, as JSON Feed 1.1. The upstream sends it with the
 * `application/feed+json` type (not `application/json`), and that header is carried through.
 */
import { proxySeo } from '../_seo/upstream';

export const revalidate = 900;

export async function GET() {
    return proxySeo('/seo/feed.json', { revalidate, tags: ['posts', 'settings'] });
}
