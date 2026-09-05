/**
 * `/feed.xml` — the site's RSS 2.0 channel, at the URL every reader and every autodiscovery tool
 * tries first. The items are the backend's (`/api/v1/seo/feed.xml`); this route only publishes them
 * where they can be found.
 */
import { proxySeo } from '../_seo/upstream';

/** The window the upstream advertises (`public, max-age=900`, backend/src/routes/seo.ts). */
export const revalidate = 900;

export async function GET() {
    return proxySeo('/seo/feed.xml', { revalidate, tags: ['posts', 'settings'] });
}
