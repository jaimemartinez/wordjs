/**
 * Cache-busting version for long-lived, UNVERSIONED static CSS (the UI framework + theme stylesheets).
 *
 * `/public/css/wordjs-ui.css` and `/themes/<slug>/style.css` are served with a long Cache-Control
 * (max-age ~1 day) for performance. Their URLs are otherwise stable, so when their CONTENT changes in a
 * release, a browser that already cached them keeps the stale copy for up to a day and never sees the
 * fix. Appending `?v=<this>` to those links makes the URL change each release, forcing a fresh fetch.
 *
 * BUMP THIS on any release that changes wordjs-ui.css or a bundled theme's style.css (keep it in step
 * with the package version).
 */
export const ASSET_VERSION = "1.5.1";
