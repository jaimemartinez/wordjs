/**
 * Cache-busting version for long-lived, UNVERSIONED static CSS (the UI framework + theme stylesheets).
 *
 * `/public/css/wordjs-ui.css` and `/themes/<slug>/style.css` are served with a long Cache-Control
 * (max-age ~1 day) for performance. Their URLs are otherwise stable, so when their CONTENT changes in a
 * release, a browser that already cached them keeps the stale copy for up to a day and never sees the
 * fix. Appending `?v=<this>` to those links makes the URL change each release, forcing a fresh fetch.
 *
 * DERIVED, NOT MAINTAINED: this used to be a hand-bumped string and it drifted from the release the
 * first time someone shipped a ui.css change without bumping it — the exact failure the token exists to
 * prevent. It is now the content hash of ui.css itself (scripts/generate-asset-version.js → the
 * generated module below, regenerated in the frontend prebuild and diff-gated in CI), so it changes if
 * and only if the stylesheet does.
 */
import { UI_CSS_HASH } from "./assetVersion.generated";

// The generated hash is the authority; the app version is only a floor for the case where generation
// produced an empty/malformed value (a stale checkout of the generated module, a half-written file).
// Never fall back to a CONSTANT: that would pin every visitor to one cache key forever.
export const ASSET_VERSION = /^[0-9a-f]{8,64}$/.test(UI_CSS_HASH)
    ? UI_CSS_HASH
    : process.env.NEXT_PUBLIC_WORDJS_VERSION || "dev";

/** Framework stylesheet URL — busted by the ui.css content hash. */
export const uiFrameworkHref = () => `/public/css/wordjs-ui.css?v=${ASSET_VERSION}`;

/**
 * Active theme's stylesheet URL, busted by BOTH the release (ASSET_VERSION) and the theme's own
 * `theme.json` version, which the backend serves as the derived `active_theme_version` setting.
 * Editing a theme in place (PUT /api/v1/themes/:slug bumps the patch) changes no file the build can
 * see, so without the theme version the edited CSS stayed cached in every browser for a day.
 *
 * `version` must come from the SERVER (settings), never be recomputed on the client: the href is
 * rendered during SSR and must be byte-identical at hydration. Empty parts are dropped so a theme with
 * no version still yields a clean key.
 */
export const themeStylesheetHref = (slug: string, version?: string | null) =>
    `/themes/${slug}/style.css?v=${[slug, version, ASSET_VERSION].filter(Boolean).join("-")}`;
