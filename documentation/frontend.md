# WordJS Frontend Documentation

The Frontend (`frontend/`) is a **Next.js** application serving both the public site and the admin dashboard.

## Structure

*   **App Router:** Uses the modern Next.js App Router (`src/app`).
*   **Public Site:** `src/app/(public)/` - Server-rendered blog posts, pages, search, and themes (see **Public Site Rendering (SSR)** below).
*   **Admin Dashboard:** `src/app/admin/` - Management interface. Includes the self-service `/admin/account` page, reachable by **every** logged-in user (including subscribers): profile + personal/recovery email and change-own-password.
*   **Other top-level routes:** `/login`, `/register`, `/verify-email`, `/install`, `/migration`, `/reset-password` (the forgot-password flow), and `/portal` (plugin-provided public portals).

### The frontend's own route handlers

Not every route under `src/app/` is a page — two are Next **route handlers** the frontend serves itself, without touching the backend API:

| Route | Method | Auth | What it does |
| :--- | :--- | :--- | :--- |
| `/api/revalidate` | `POST` | `x-revalidate-secret` | The on-demand cache purge the backend's `core/frontend-purge.ts` calls when content changes. Body `{ tags, paths }` (each list deduped, entries ≤200 chars, capped at 100; `paths` must start with `/`), then `revalidateTag()` / `revalidatePath()`. |
| `/health` | `GET` | No | Liveness for the gateway's health-checks: `{ status: 'healthy', timestamp }`. |

> `/api/internal/gateway-update` is **not** one of them: the Next twin that used to serve it was deleted, and every dispatcher now sends that path to the backend's own `/api/internal` router. `frontend/backend-proxy-target.js` keeps the path in `CONTESTED_API_PATHS` so a route handler re-created there collides instead of shipping dead code again, and `gateway/test/dispatcher-parity.test.js` walks `frontend/src/app/api/**` and fails on any route handler the module does not classify (and on any `NEXT_OWNED_API_PATHS` entry that has no route handler).

> **`/api/revalidate` fails closed.** With no `revalidateSecret` anywhere it answers **503** — never open access — and a wrong secret gets **403** from a constant-time compare (both sides hashed first, so a length mismatch can't throw). The blast radius is bounded by construction: purging can only force a re-render, it can never inject content.
>
> The secret is looked up by `lib/revalidateSecret.ts`, **per key, not per file**: this node's own `wordjs-config.json` first (separate mode — enrollment writes the gateway-minted secret there, and the caller is the gateway fanning a backend purge out to every frontend node), then `../backend/wordjs-config.json` (monolith / single-host split, where the backend's config shares the disk). A local config that merely *exists* without the key must not end the search — that was exactly why cross-machine purges used to 503.

## Gateway Integration

The frontend registers itself with the Gateway automatically on startup.
This is handled in **`src/instrumentation.ts`** (`register()`, Node runtime only):

1.  Next.js starts and calls `register()`.
2.  Reads config, preferring a local `wordjs-config.json` (distributed deploy) and falling back to `../backend/wordjs-config.json` (monolith) for the gateway host/ports (`gatewayHost`, `gatewayInternalPort`, `gatewayPort`), `gatewaySecret`, and `frontendUrl`.
3.  Resolves the **advertised** URL it hands the gateway (`https://<hostname>:<port>`). The hostname defaults to `127.0.0.1` (co-located); it takes the host of `frontendUrl` if set, and an explicit **`advertiseHost`** wins over both. On a **separate machine** you must set `advertiseHost` to this node's routable address — otherwise the gateway records `127.0.0.1` and proxies `/` back to its own loopback instead of the real frontend node.
4.  If cluster mTLS certs are present (`certs/` locally or `../backend/certs`), it POSTs to the gateway's **internal** port over HTTPS with the client cert; otherwise it falls back to plain HTTP on the public gateway port.
5.  Sends `POST /register` with its route prefixes: `/`, `/admin`, `/login`, `/install`, `/migration`, `/portal`, `/_next` (authenticated by `x-gateway-secret`). It retries until the gateway accepts, backing off 250 ms → 1 s → 2 s and then every 5 s.

> **Separate mode.** When the three services live on **different machines**, the frontend node first joins the cluster (mints its mTLS identity from a gateway-issued join token) via `scripts/node-join.js`, which also writes its `wordjs-config.json` (`advertiseHost`, `gatewayHost`, `internalApiUrl`, `gatewaySecret`, …). See [`documentation/separate-mode.md`](./separate-mode.md) for the full enrollment flow.

## Visual Editing (Verso)

WordJS ships **Verso**, its own visual editor — no third-party editor package is installed.
*   **Editor:** `src/components/verso/` (canvas, overlay, DnD, inline engine, panels) and `src/lib/verso/` (store, registry, commands, block definitions).
*   **Shared block field controls:** `src/components/blocks/` (`AppearanceField`, `AnimationField`, `VisibilityField`, `LinkField`, `CSSControls`, `blockShell.ts`, `blockVars.ts`) — used by both the editor panels and the public renderers.
*   **Plugin Integration:** plugins ship their own blocks; see **Plugin blocks in the editor** below.

## Development vs Production

*   **Internal Port:** `3001` (default).
*   **Public Access:** Accessed via Gateway on port `3000` (or `80`/`443` in prod).

The browser calls a **relative** `/api/v1` path (`frontend/src/lib/api.ts`), so it reaches the backend through the gateway automatically — there is **no** client-side API-URL env var to set. When a frontend replica is reached **directly**, with no gateway in front of it, that relative path lands on the frontend's own port and the frontend forwards it: which backend it forwards to is `WORDJS_BACKEND_URL` (env) → `wordjs-config.json`'s `gatewayPort` → `http://localhost:3000`, resolved in `frontend/backend-proxy-target.js` and applied both by the `next.config.ts` rewrite (build time) and by `server.js` (runtime, which is the one that works on the pre-compiled release). That is what lets N frontend replicas each be pinned to a different backend from one artifact — see **[multi-node.md](multi-node.md#pinning-a-frontend-replica-to-a-backend--wordjs_backend_url)**. Server-side rendering resolves the backend base **on the server** (see the SSR data layer below) across all three run modes: **monolith** hits the in-process backend's loopback origin (`WORDJS_MONO_ORIGIN`, default `http://127.0.0.1:4000`); **split** (same host) reads the backend port from `wordjs-config.json` and hits `http://localhost:<port>`; **separate machine** points SSR at `internalApiUrl` (config) / `INTERNAL_API_URL` (env) — typically the gateway's public origin, whose cluster-CA-signed cert the frontend trusts because `start-frontend.js` sets `NODE_EXTRA_CA_CERTS` to `certs/cluster-ca.crt`.


## Public Site Rendering (SSR) 🌐

The public site is **real server-side rendering (SSR)**, not client-only skeletons. Every route under `src/app/(public)/` — the home page (`page.tsx`), single posts (`[slug]/page.tsx`), category posts (`[slug]/[postSlug]/page.tsx`), static pages (`pages/[slug]/page.tsx`), search (`search/page.tsx`) and the draft preview (`preview/[slug]/page.tsx`) — is an **async React Server Component** that fetches its content **on the server**. The initial HTML sent to crawlers and the first paint already contain the real title and body.

> **The preview route is the deliberate exception to the caching rules below.** `preview/[slug]/page.tsx` is `export const dynamic = "force-dynamic"` and reads through `getPostBySlugPreview()`, which forwards the session cookie and therefore stays `cache: 'no-store'` — an unpublished draft must never land in a shared cache. It also sets `robots: { index: false, follow: false }`, so a leaked preview URL cannot be indexed.

### Server data layer: `src/lib/server-api.ts`
A **server-only** module (must never be imported from a `"use client"` file). It:

*   **Resolves the backend base URL** for SSR fetches (`resolveServerBase()`, mirrored by `lib/api.ts`' `getBaseUrl()` so every SSR path agrees): monolith (`WORDJS_MODE === 'mono'`) uses the loopback origin (`WORDJS_MONO_ORIGIN`, default `http://127.0.0.1:4000`); otherwise an `INTERNAL_API_URL` (full `.../api/v1`) env override wins; failing that it reads `wordjs-config.json` (local file preferred over `../backend`) and tries, in order, an `internalApiUrl` key (separate-machine: the gateway's reachable API base, trusted via `NODE_EXTRA_CA_CERTS`), then — only when cluster certs are already issued (`certs/backend.crt` beside the config, i.e. the backend serves mTLS HTTPS and will not answer plain HTTP) — the gateway's own origin (`gatewayUrl` / `siteUrl`) + `/api/v1`, then `http://localhost:<port>` built from the backend `port` (default `4000`). No candidate is used as it was read: each must pass a shape allowlist (http/https only, no credentials/query/fragment, host and path from a positive character allowlist) and the base that is actually used is **rebuilt** from the validated pieces; a candidate that fails is dropped, never repaired, and resolution falls through to the next one. Every request URL is then re-parsed after the endpoint is appended and refused unless it is still on the base's origin and under its path (`backendUrl()`).
*   **Deduplicates requests** — the content loaders (`getSettings`, `getPublicAssets`, `getFonts`, `getMenuByLocation`, `getMenuById`, `getMenuByRef`, `getThemeChrome`, `getThemeTemplate`, `getThemeManifest`, `getPostBySlug`, `getPostBySlugPreview`, `getPostById`, `getPosts`, plus `checkSetupRequired`/`resolveSiteBase`) are wrapped in React `cache()`, so `generateMetadata()` and the page body share a single request-scoped backend call instead of fetching the same resource twice. (`searchPosts()` is a plain async function — it issues two parallel fetches per call and is not memoized.)
*   **Caches public reads (ISR), never per-user reads** — `serverFetch()` opts a **public** read into Next's Data Cache when the caller passes a `revalidate` window (with cache `tags` for on-demand `revalidateTag()` purging) — e.g. `getSettings` 60s, `getPosts`/`getPostBySlug` 30s, `getFonts` 300s — collapsing repeat backend hits until the content changes. Next 15 no longer caches `fetch` by default, so this is strictly opt-in. Reads that forward the session cookie (`forwardCookies`, e.g. `getPostBySlugPreview`) or pass no `revalidate` stay `cache: 'no-store'` — per-user content must never be shared.
*   **Forwards the public host** — `serverFetch()` sends `x-forwarded-host` / `x-forwarded-proto` to the backend. Because SSR fetches hit the loopback origin, without this the backend's host-based logic (the **Site-URL/migration guard**, **CSRF origin** check, **canonical/OpenGraph** URLs) would see `localhost:4000` instead of the public host and reject SSR requests (e.g. `409 migration_required`). Where the host comes from depends on the read: a **public** read never touches the request — it forwards the **configured** origin (`wordjs-config.json`'s `siteUrl`, module-cached for 10 s), or no host at all when none is configured (mid-install), because calling `headers()` during the runtime render of a prerendered route is a Next 16 hard error. Only a **cookie-forwarded** read (`forwardCookies`, whose routes are `force-dynamic`) relays the inbound `x-forwarded-host` / `x-forwarded-proto` / `cookie` headers.
*   **Builds SEO metadata** — `buildPostMetadata()` (title, description, canonical, OpenGraph/Twitter) and `htmlToText()` (tag-stripping excerpt builder for `<meta>` values). These are server-safe and do **not** go through `sanitize.ts` at all.
*   **Builds JSON-LD structured data** — `buildWebSiteJsonLd()` (WebSite + SearchAction) and `buildPostJsonLd()` (BlogPosting/WebPage), emitted via the `src/components/public/JsonLd.tsx` component with `jsonLdString()` escaping `<` so `</script>` can't break out. These hand-rendered `<script>` tags are **not** absolutized by `metadataBase`, so they take an explicit absolute base from `resolveSiteBase()` — same trust model as `metadataBase`: the **configured** site URL (`settings.siteurl || home || site_url`) is the sole authority, with no request-header fallback at all, and an unconfigured site falls back to the literal `http://localhost:3000`.

### Content renderers (Server Components + client islands)
The actual content markup lives in `src/components/public/PostContent.tsx` (single post / page / category-post) and `src/components/public/HomeContent.tsx` (static home page). Both receive the already-fetched `post` as a prop from the route's Server Component and are **themselves Server Components** — no `"use client"`, so the page body ships as HTML with no body hydration.

*   **Public block rendering lives in `src/components/content/`.** `ContentRenderer.tsx` walks `meta._puck_data` and dispatches each core block to the shared, server-compatible components in `blocks.tsx` (`HeadingBlock`, `TextBlock`, `ImageBlock`, `SectionBlock`, `HeroBlock`, `CardBlock`, …), each wrapped in `SharedBlockShell.tsx` — the server twin of the editor's shared-field wrapper. `blocks.tsx` is the single source of truth: the Verso block registry (`src/lib/verso/coreBlocks.tsx`) points each block's `render` at the same components, so the editor canvas and the live site cannot drift, and the block class names live here rather than in the registry — built by `bc()` (`src/components/blocks/blockVars.ts`), the single point that emits WordJS's own `wjs-block-*` class plus its deprecated `wp-block-*` alias ([block-class-identity.md](block-class-identity.md)).
*   **Only genuinely interactive pieces hydrate**, each its own island module in the same directory (so its chunk code-splits away from pages that don't use it): `AccordionBlock.tsx`, `TabsBlock.tsx`, `SearchBarBlock.tsx`, `AudioTransport.tsx`, `SelfHostedVideo.tsx`, `AnimatedShell.tsx`, `LocalizedDate.tsx`, `BackToTop.tsx`, `ParticleField.tsx`, `OffCanvasClient.tsx`, `NavMenuMobile.tsx`, `NavClickSubmenus.tsx`, `TocScrollSpy.tsx`, `IxRuntimeIsland.tsx`, `LegacyCarousels.tsx` (the legacy `[photo-carousel]` initialiser), and `PluginBlockIsland.tsx` / `PluginBlockHeavy.tsx` for plugin and Symbol blocks. Comments (`CommentsSection`) and `[shortcode]` plugin embeds (`PluginLoader`) stay client components as before.
*   **Structural props are never trusted.** `blocks.tsx`'s `HeadingBlock` resolves `level` against a fixed `HEADING_TAGS` allowlist (`h1`–`h6`, defaulting to `h2`): the write-side meta sanitizer only classifies string leaves as HTML- or URL-bearing, so a structural prop reaches the renderer untouched — and since these are server components the resulting tag lands in the cached initial document.

### SEO & behavior
*   **`generateMetadata`** — each page exports it for a per-page `<title>` (the root layout applies a `%s | site` template; the home page uses `title.absolute` to avoid doubling), description, canonical, and OpenGraph/Twitter tags. Per-route `generateMetadata` returns **relative** canonical/`og:url` values (e.g. `/my-post`).
*   **`metadataBase` is anchored to the configured site URL (FE-SSR-01)** — the root layout's `generateMetadata` (`src/app/layout.tsx`) sets `Metadata.metadataBase` so the relative canonical/OpenGraph URLs absolutize correctly. The base is taken from the **configured** site URL (`settings.siteurl || home || site_url`), **not** the raw `Host`/`X-Forwarded-Host` header, and there is no request-header fallback: when no site URL is configured the key is simply omitted, and Next resolves the relative metadata against the request origin. This prevents an attacker-controlled `Host` header from rewriting every canonical/`og:url` to their own domain (SEO/phishing poisoning).
*   **Real 404s** — when content is missing, pages call `notFound()` (a real HTTP 404), and their `generateMetadata` returns `robots: { index: false }`.
*   **Search is no-JS** — `search/page.tsx` is a plain `<form action="/search" method="get">`, so it works with JavaScript disabled; it server-fetches results via `searchPosts()` and is marked `robots: { index: false }`.
*   **`suppressHydrationWarning`** — sanitized-HTML blocks (`dangerouslySetInnerHTML`) carry `suppressHydrationWarning` because the server (`sanitize-html`) and client (DOMPurify) serialize styles slightly differently (see **HTML Sanitization** below).

> **`sanitize.ts` is a shared module (no `"use client"`)** — `sanitizeHTML()` is therefore callable from a Server Component, which is what `PostContent`/`HomeContent`/`blocks.tsx` do. The `typeof window` branch inside each export does the splitting: `sanitize-html` on the server, DOMPurify in the browser. (Marking the file `"use client"` turned every export into a client *reference* when imported from a Server Component, which throws on call.) For server-side metadata you still want the plain-text `htmlToText()` from `server-api.ts`.


## Theme UI Framework (`wordjs-ui.css`) 🎨

The theme system ships a single token-driven, Bootstrap-like CSS framework. The frontend loads it on **public pages** and inside the **editor preview iframe** — never on the admin UI — so authored content renders the same in both places. The full reference is in `documentation/theming.md`; this section covers only how the frontend wires it in.

*   **What it is:** `backend/public/css/wordjs-ui.css` (served at `/public/css/wordjs-ui.css`) — one shared static stylesheet that auto-styles every HTML element plus Bootstrap-compatible components (`.btn`/`.card`/`.alert`/`.badge`/`.table`/`.nav`/`.list-group`/`.pagination`/`.progress`/`.modal`/`.dropdown` and a flexbox grid `.container`/`.row`/`.col-*`) and a utility layer (spacing/display/flex/text/colors/borders/sizing/shadow).
*   **Driven by `--wjs-*` design tokens** that land in each theme's `style.css :root` — compiled there from the theme's `theme.json` for a declarative theme (`circuito`, `gaceta`, `vergel` — their `style.css` opens with a `@wjs-generated:start` marker), or hand-written for `default`. The framework has fallbacks, so a theme re-skins everything just by setting tokens. **Four** themes ship bundled in `backend/themes/` — `default`, `circuito`, `gaceta`, `vergel` — each with a full `--wjs-*` token set tuned to its palette (including per-variant `--wjs-color-on-*` max-contrast text tokens). The theme **catalogue** was retired: `marketplace/themes/` no longer exists and the built theme index is `{"count": 0, "themes": []}`, so the marketplace adds no themes on top of those four.
*   **Public load order (`src/components/public/ThemeLoader.tsx`):** the `<link id="wjs-ui-framework" href="/public/css/wordjs-ui.css?v=…">` is emitted **first**, then the active theme's `style.css?v=…` (`id="wjs-theme-stylesheet"`); both hrefs are cache-busted with `ASSET_VERSION` (the sha256 of `wordjs-ui.css`, generated — see below) and the theme href additionally with the active theme's `theme.json` version, so an in-place theme edit busts the browser copy too. Because the framework loads before the theme, the theme's `:root` tokens and custom rules override it at equal specificity. **No FOUC:** the active slug **and version** are resolved on the **server** (the public layout's `getSettings()` passes them down as `initialSlug` / `initialThemeVersion`) so the first server-rendered paint already carries the correct theme, and both `<link>`s carry a React 19 **`precedence`** attribute — without it React leaves them in the body as non-render-blocking, so the page painted with fallback token values and restyled once the CSS loaded. **No per-visitor query:** the loader no longer polls on tab focus — the `settings` purge + ISR deliver a theme switch on the next navigation. The one client-side resolve left in the loader is for the surface that gets no server props (the Verso editor preview, which renders `PublicLayoutShell` bare): it reads `settingsApi.get()` **once**, never on a timer, and takes `template` / `active_theme_version` from it. When the href does change at runtime the loader evicts the previous theme's `<link>`, matched on the exact href (precedence stylesheets are add-only, so React never removes the stale one itself).
*   **`ASSET_VERSION` is generated, never hand-bumped (`src/lib/assetVersion.ts`):** it re-exports the sha256 in `src/lib/assetVersion.generated.ts` (falling back to `NEXT_PUBLIC_WORDJS_VERSION`, then `"dev"`, only if the generated value is not a plausible hash), written by the repo-root `scripts/generate-asset-version.js` from `backend/public/css/wordjs-ui.css` (CRLF-normalized so Windows and CI hash the same bytes). It runs in `predev`/`prebuild` and CI regenerates + diffs the committed file (`git ls-files` guard + `git diff --exit-code`), so shipping a CSS change without the matching token fails the build instead of leaving browsers on a day-old stylesheet — which is exactly what the old manual constant did.
*   **Editor canvas (`src/app/admin/canvas-frame/page.tsx`):** the Verso canvas is a real iframe whose document is its own admin route, and that route emits the same two links — framework first (`uiFrameworkHref`), then the active theme's `style.css` (`themeStylesheetHref`, `id="wjs-theme-stylesheet"`) — for true WYSIWYG. Both hrefs come from the same `src/lib/assetVersion.ts` helpers the public `ThemeLoader` uses, so canvas and live site can't disagree on the cache-busting version. The route resolves the active slug/version itself via `themesApi.list()` → `GET /api/v1/themes` (falling back to `default` if that request fails, so the canvas is never left without a theme sheet) and re-checks every 10 s, swapping the `<link>` imperatively — new link inserted, `onload` awaited, old one removed — so a theme activated in another tab reaches an already-open canvas without a flash. Switching theme from the editor itself goes through `FrameController.swapThemeCss()`, which appends the new `<link>`, waits for its `onload` and only then removes the old one — no FOUC. Only the iframe canvas is themed; the editor's own chrome (panels, overlay, action bar) lives in the parent document and stays unthemed.
*   **Customizer overlay (`src/components/public/ThemeTokenOverlay.tsx`):** a Server Component emits a sanitized `<style id="wjs-theme-mods">:root{…}</style>` from the active theme's `active_theme_mods` overrides (set by the admin customizer at `/admin/themes/customize`) **after** the theme stylesheet, so live `--wjs-*` edits win with no FOUC. Two filters run, the narrower one last. `isValidThemeMod()` (`src/lib/themeTokenPolicy.ts`, reading the generated theme contract) keeps only `^--wjs-[a-z0-9-]+$` keys and values that are non-empty, ≤120 chars, drawn from a character allowlist (so `;{}:<>` can never close the declaration) and free of `url(`, `//` or a backslash. Then `safeCustomPropValue(name, value)` (`src/components/blocks/safeStyle.ts`) applies the **name-aware** criterion the object style channel already used: a name the stylesheet expands into a `transform:` or a length gets a parsed, magnitude-bounded grammar, because the declaration a value lands in is chosen by the sheet, not by whoever typed the value. A charset-only pass let `--wjs-card-hover-transform: translateY(-4000px)` through, and a `:root` mod applies to every block on every page.
*   **Theme structure (`src/app/(public)/layout.tsx`):** the (now async) public layout reads `active_theme_layout` (from `theme.json`'s `layout`) via `getSettings()` and hands the raw option to `src/components/public/PublicLayoutShell.tsx`, which normalizes it with `parseThemeLayout()` (`src/lib/themeLayout.ts`) and applies `containerWidth` + an opt-in two-column sidebar (`SidebarLayout.tsx`). The layout may additionally pass a server-composed `headerSlot`/`footerSlot` (`resolveEffectiveChrome()` from `src/lib/chromeData.ts` → `src/components/chrome/ChromeRenderer.tsx`); when no composition survives, the shell falls back to the built-in `Header`/`Footer` unchanged. The chrome (`Header`/`Footer`/`PostContent`/blog roll) consumes `--wjs-*` tokens and post bodies use `.wjs-content`, so the active theme drives the whole live look. See [themes.md → Theme integration](themes.md#theme-integration-with-the-live-site).
*   **Legacy backend rendering:** the Handlebars `wordjs_head` helper (`backend/src/core/theme-engine.ts`) links the same stylesheet, but that public path is **no longer mounted** (Next.js renders the live site) — it applies only to the on-disk legacy template engine.

> The admin UI is intentionally **not** styled by this framework — it keeps the "Premium" design system below.


## Context Providers & State

The app uses React Contexts to manage global state:
*   **`AuthContext`**: Fetches the current user (including the `capabilities` array) from `GET /auth/me`, and exposes role-based capabilities and login/logout methods. The auth token lives in an HttpOnly cookie the frontend cannot read, so there is no client-side JWT parsing. It also clears the user centrally when **any** request discovers the session is over: `src/lib/api.ts` classifies a 401 whose code is one of `rest_token_expired` / `rest_token_revoked` / `rest_token_invalid` / `rest_not_logged_in` / `rest_user_invalid` and dispatches `SESSION_ENDED_EVENT` (`"wjs:session-ended"`) on `window`, which `AuthContext` listens for. Deliberately **excluded**: `rest_csrf_invalid` (a security signal — the session itself is fine), `rest_token_scope_insufficient`, and any 403 (authenticated-but-forbidden is not a session problem). `isSessionEnded(error)` is exported from `api.ts` so callers can stay quiet about an expected sign-out instead of reporting it as a failure.
*   **`MenuContext`**: Fetches and caches the admin sidebar menu items from `/api/v1/plugins/menus`.

## System Components

### Installed fonts — SSR `@font-face` + `SystemFontsLoader`
**Location:** `src/lib/fontFaceCss.ts` + `src/components/SystemFontsLoader.tsx`
The `@font-face` rules for WordJS-installed fonts are built by the shared, isomorphic `buildFontFaceCss()` (`src/lib/fontFaceCss.ts` — numeric weight parsed from the variant label, `format()` hint derived from the file extension, family names escaped). The root layout (`src/app/layout.tsx`) injects them into the **initial SSR `<head>`** (fonts fetched via the request-deduped, ISR-cached `getFonts()` from `server-api.ts`), so a page whose blocks reference a custom font paints in that font on first render — previously the faces were injected only client-side, so first paint fell back to the theme font (permanently, if client JS was blocked). `SystemFontsLoader` is the client-side refresher: it re-fetches `/fonts` and injects the **same builder's** output, picking up fonts uploaded after the SSR cache window and covering the admin editor.

### Verso inline text engine (in-place editing)
**Location:** `src/lib/verso/inline-engine/` (pure model/ops/parse/serialize — no React, no DOM) +
`src/components/verso/inline/` (`VersoInline`, `VersoTextSurface`, `VersoBubbleMenu`).
The in-place editor for text-bearing blocks edits the block's **own** text node on the canvas, so the
editable inherits the block's real typography (`h2`, `.wp-block-text`, …) instead of approximating it.
There is **no Tiptap and no ProseMirror** — the engine is in-house, and its document model is
deliberately minimal.
*   **What the model supports:** paragraphs and `ul`/`ol` lists (one paragraph per `<li>`), hard
    breaks, and exactly three marks — **bold**, **italic** and **link** (`href` verbatim, plus a
    new-tab flag that serializes to `target="_blank" rel="noopener noreferrer"`).
*   **Floating toolbar (`VersoBubbleMenu`):** bold, italic, link (with the open-in-new-tab toggle and
    a remove-link action), bullet list, numbered list, and clear formatting. Colour, font family,
    size and line height are **not** here — they are per-block properties in the **Appearance** panel
    (`src/components/blocks/AppearanceField.tsx`), which also carries tablet/mobile overrides.
*   **Usage:** opens on double-click on the canvas, or from the block action bar when the block's
    definition declares `inline` (`src/components/verso/overlay/actionBarCommands.ts`).
*   **Commits:** partial commits are throttled through `handle.transact(setProps)` with a coalesce key,
    so a burst of typing collapses into one undo entry; `Escape` or a click outside flushes and closes
    the session. The serialized output is passed through the same isomorphic `sanitizeHTML` before it
    reaches the document — defence in depth, since the engine's own output is already a fixed point of
    the sanitizer.

## Navigation Components

### `SmartLink`
A wrapper around `next/link` that guards against losing unsaved changes. It intercepts the click and routes through the unsaved-changes confirmation via `useUnsavedChanges()` / `checkAndNavigate(href)`.
*   Located at: `src/components/SmartLink.tsx`
*   Usage: `<SmartLink href="/admin/posts">Posts</SmartLink>`

## UI Component Library 💅

WordJS uses a standardized "Premium" design system. Plugins and core pages should use these components to maintain visual consistency.

### `PageHeader`
**Location:** `src/components/ui/PageHeader.tsx`
Standard header for all admin pages.
*   **Props:**
    *   `title` (string): Main page title.
    *   `subtitle` (string): Helper text below title.
    *   `icon` (string): FontAwesome class (e.g., `fa-users`).
    *   `actions` (ReactNode): Buttons or controls to show on the right.
    *   `backButton` (`{ label?: string; onClick: () => void }`, optional): Shows a back arrow; `onClick` handles navigation and `label` overrides the default text.

### `Card`
**Location:** `src/components/ui/Card.tsx`
The primary container for content. Enforces the `rounded-[40px]` premium styling.
*   **Props:**
    *   `children`: Content.
    *   `variant` ('default' | 'glass' | 'dark' | 'accent'): Visual style.
    *   `color` ('blue' | 'green' | 'red' | 'orange' | 'purple' | 'indigo'): Accent color (used with `variant="accent"`).
    *   `padding` ('none' | 'sm' | 'md' | 'lg'): Internal padding.
    *   `hoverable` (boolean), `overflow` ('hidden' | 'visible'), `className` (string).

### `ActionCard`
**Location:** `src/components/ui/ActionCard.tsx`
Clickable cards for dashboards or quick actions.
*   **Props:**
    *   `icon`: FontAwesome class.
    *   `title`: Main text.
    *   `description`: Subtext.
    *   `onClick` / `href`: Action handler.
    *   `color` ('blue' | 'purple' | 'green' | 'orange' | 'indigo' | 'gray'): Color theme (default: `blue`).

### `Input` / `ModernSelect`
**Location:** `src/components/ui/Input.tsx`, `src/components/ModernSelect.tsx`
Form controls with consistent rounded styling and focus states.

---

## Visual Editing (Verso) — the editor in detail

**Verso** is WordJS's own visual page builder. Nothing here is a wrapper around a third-party editor:
the document store, the drop-target resolver and the rich-text engine are all in-tree.

### Configuration
*   **Block registry**: `src/lib/verso/registry.ts` defines the field contract; `src/lib/verso/coreBlocks.tsx` declares the 39 core blocks against it and reuses the shared field controls from `src/components/blocks/` and the custom pickers still exported by `src/components/versoConfig.tsx` (`CategoryField`, `TemplateField`, `ColumnDistributionControl`, `ColumnStyleAccordion`) — one implementation, no drift. `CORE_BLOCK_TYPES` is no longer a literal here: it is re-exported from the generated visual contract (`src/generated/verso-registry.generated.ts` / `visual-contract.types.generated.ts`), so the editor's block list and the public serialization contract are the same list.
*   **Plugin blocks**: active plugins' Verso components are compiled into the auto-generated `src/lib/versoPluginRegistry.ts` (`node scripts/generate-verso-plugin-registry.js`). The manifest declaration (`frontend.versoComponents`), the export contract (single `versoComponentDef` + default render vs. multi `versoComponents`), the deprecated-but-still-supported pre-rename spellings, the activate → regenerate → restart flow and `--wjs-*` token theming are documented in `documentation/plugins.md` §13.
*   **Editor Page**: `src/app/admin/pages/[id]/page.tsx` and `src/app/admin/posts/[id]/page.tsx` mount `src/components/verso/editor/VersoEditor.tsx`. The site chrome has its own thin variant of the same engine at `/admin/chrome` (`ChromeVersoEditor`).
*   **Document store**: `src/lib/verso/store.ts` keeps the document as a normalized id→node map. It changes **only** through commands inside `transact()`, and history is stored as inverse patches, so undo/redo is a replay of inverses rather than a snapshot diff. A transaction that throws rolls back whole, and the `tx` object is sealed on exit so a stray async continuation can't mutate a committed document.
*   **Canvas & responsive preview**: the canvas is an iframe (`src/components/verso/canvas/FrameController.tsx`) whose document is the `/admin/canvas-frame` route; the React tree is teleported into it through a portal, so no stylesheet mixes with the parent. The selection/drag/action-bar layer stays in the **parent** document, measured by `src/components/verso/overlay/GeometryStore.ts`. The device switcher (`ViewportControls.tsx` + the pure arithmetic in `canvas/viewport.ts`) sets the canvas container's CSS width to the real device width — desktop 1280, tablet 768, mobile 375 — and scales it down to fit, so the site's actual `@media` breakpoints fire instead of being simulated.
*   **Drag and drop**: `src/lib/verso/dnd/resolve.ts` is a pure drop-target resolver with no DnD library behind it. (`@dnd-kit` is still a dependency, but only `/admin/widgets` uses it — the editor does not.)
*   **Render Pages**: the public routes — `src/app/(public)/page.tsx` (home), `src/app/(public)/[slug]/page.tsx`, `src/app/(public)/[slug]/[postSlug]/page.tsx`, `src/app/(public)/pages/[slug]/page.tsx`, and `src/app/(public)/preview/[slug]/page.tsx` (the `force-dynamic`, `noindex` draft preview) — are **async Server Components** that fetch content server-side (see **Public Site Rendering (SSR)**) and hand it to the `PostContent`/`HomeContent` renderers — themselves Server Components, which render editor-authored layouts through `src/components/content/ContentRenderer.tsx` and sanitized HTML for classic content. (`search/page.tsx` is the sixth `(public)` route; it renders its own result list rather than `PostContent`. There is no `[...slug]` catch-all route.)

### Available Components

#### Content Components

| Component   | Description          | Key Properties                                      |
| ----------- | -------------------- | --------------------------------------------------- |
| **Heading** | Text headings H1-H3  | `title`, `level`, `elementId`, `css`                |
| **Text**    | Rich text content    | `elementId`, `css` (text edited in place)           |
| **Image**   | Responsive images    | `src`, `elementId`, `css`                           |
| **Button**  | Clickable buttons    | `label`, `href`, `variant`, `align`, `css`          |
| **Divider** | Horizontal separator | `type`, `css`                                       |
| **Spacer**  | Vertical spacing     | `css`                                               |
| **Card**    | Content container    | `title`, `description`, `icon`, `theme`, `css`      |

#### Layout Components

| Component   | Description       | Key Properties                                        |
| ----------- | ----------------- | ----------------------------------------------------- |
| **Columns** | Multi-column grid | `distribution` (column widths), `columnStyles`, `css` |
| **Section** | Container wrapper | `maxWidth`, `css`                                     |
| **Grid**    | CSS Grid layout   | `columns`, `gap`, `css`                               |
| **FlexRow** | Flexbox container | `justify`, `align`, `gap`, `wrap`, `css`              |

#### Interactive Components

| Component     | Description        | Key Properties                          |
| ------------- | ------------------ | --------------------------------------- |
| **Accordion** | Collapsible panels | `items` (array of title/content), `css` |
| **Tabs**      | Tabbed content     | `tabs` (array of label/content), `css`  |

#### Media Components

| Component       | Description         | Key Properties              |
| --------------- | ------------------- | --------------------------- |
| **VideoEmbed**  | YouTube/Vimeo embed | `url`, `aspectRatio`, `css` |
| **AudioPlayer** | Audio player        | `src`, `title`, `css`       |

#### Marketing Components

| Component        | Description     | Key Properties                                                       |
| ---------------- | --------------- | -------------------------------------------------------------------- |
| **PricingTable** | Pricing plans   | `plans` (array with name, price, features), `css`                    |
| **Testimonial**  | Customer quotes | `quote`, `author`, `role`, `avatar`, `css`                           |
| **CTABanner**    | Call-to-action  | `title`, `subtitle`, `buttonText`, `buttonLink`, `variant`, `css`   |

#### Dynamic Content Components

| Component         | Description          | Key Properties                                                     |
| ----------------- | -------------------- | ------------------------------------------------------------------ |
| **PostsGrid**     | Display recent posts | `count`, `columns`, `css`                                          |
| **CategoryPosts** | Posts by category    | `categorySlug`, `count`, `layout`, `css`                          |
| **SearchBar**     | Search input         | `placeholder`, `buttonText`, `searchPage`, `align`, `width`, `css` |

#### Other Built-in Components

| Component       | Description                          | Key Properties                                                     |
| --------------- | ------------------------------------ | ------------------------------------------------------------------ |
| **Hero**        | Hero banner w/ background + overlay  | `title`, `subtitle`, `bgImage`, `overlay`, `height`, `align`, `buttons`, `elementId`, `css` |
| **Quote**       | Blockquote / pull-quote              | `text`, `cite`, `style`, `css`                                    |
| **Table**       | Data table                           | `header`, `rows`, `striped`, `css`                                |
| **IconList**    | Icon feature list                    | `items`, `columns`, `css`                                         |
| **SocialLinks** | Social profile links                 | `items`, `align`, `css`                                           |
| **Stats**       | Stat / metric counters               | `items`, `css`                                                    |
| **HTMLEmbed**   | Raw HTML block (sanitized on render) | `html`, `css`                                                     |
| **Form**        | Real form with stored submissions (`/api/v1/forms`) | `formName`, `fields` (array of type/label/required/options/placeholder), `submitLabel`, `successMessage`, `errorMessage` |
| **Symbol**      | Synced reusable block group — edit one, all update | `symbolId`                                                        |
| **ParticleField** | Animated particle background (client island)       | `count`, `color`, `speed`, `linkLines`, `linkDistance`, `pointer`, `css` |

#### Site Navigation & Chrome Components

These bind to data the site already owns rather than copying it: `NavMenu` and `MegaMenu` store only a menu *reference* (the `nav_menu` store stays the source of truth), `SiteLogo` binds to `blogname` + `site_logo`, and `Breadcrumbs` / `LangSwitcher` / `TableOfContents` are resolved per-post on the server (`src/lib/resolveDynamicBlocks.ts`).

| Component           | Description                                          | Key Properties                                                                          |
| ------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **NavMenu**         | The site menu, by location or by id                  | `source`, `location`, `menuId`, `orientation`, `depth`, `submenuTrigger`, `mobileBehavior`, `align`, `css` |
| **MegaMenu**        | Menu whose top-level items open authored panels      | `source`, `location`, `menuId`, `fullWidth`, `trigger`, `panel0`…`panel5` (slots, mapped to the first six top-level items in order), `css` |
| **SiteLogo**        | Site logo and/or title, linked home                  | `mode`, `linkToHome`, `maxHeight`, `altOverride`, `css`                                  |
| **BackToTop**       | Floating scroll-to-top control (whole block is an island) | `showAfter`, `position`, `smoothScroll`, `label`, `icon`, `css`                     |
| **OffCanvas**       | Slide-in drawer with a content slot                  | `content` (slot), `triggerLabel`, `triggerIcon`, `side`, `breakpoint`, `closeOnEsc`, `scrollLock`, `css` |
| **Breadcrumbs**     | Ancestor trail for this page (`post_parent`)         | `separator`, `showHome`, `homeLabel`, `hideOnHome`, `css`                                |
| **LangSwitcher**    | Links to this page's translations                    | `style`, `labelMode`, `showCurrent`, `css`                                               |
| **TableOfContents** | Index of this page's anchored headings               | `title`, `minLevel`, `maxLevel`, `ordered`, `scrollSpy`, `css`                           |

### Component Security

Two render-time components self-enforce XSS hardening (independent of the HTML sanitizer). Both now live under `src/components/content/` — `VideoEmbedBlock` in `blocks.tsx`, `SearchBarBlock` in its own island module — and the Verso block registry delegates to them, so the editor canvas and the live site enforce the same rules:

*   **VideoEmbed** takes one of three paths, in order. A **root-relative same-origin path** (decided by `sameOriginPath()`, which rejects both authority-relative spellings `//host/x` and `/\host/x` after stripping the control characters the URL parser drops) plays in a real `<video>` via the `SelfHostedVideo` island — no third party in the request path at all. Otherwise `resolveVideoEmbedUrl()` parses the URL, compares the **whole** host against the provider table and rebuilds the src from our own constants, so an `<iframe>` appears only for a canonical `https:` URL on `www.youtube.com`, `www.youtube-nocookie.com` or `player.vimeo.com`. Anything else (arbitrary `src`, `javascript:`/`data:`, a non-embed host, `https://youtube.com.evil.test/watch?v=…`) renders a placeholder. Every embed carries `sandbox="allow-scripts allow-same-origin allow-presentation"` (from the generated contract) + `referrerPolicy="strict-origin-when-cross-origin"`.
*   **SearchBar** confines navigation to a same-origin **relative path**: the editor-controlled `searchPage` is resolved against `window.location.origin` and only its `pathname` is used when the origin matches; otherwise it falls back to `/search`. So an absolute/scheme/protocol-relative URL cannot become an open redirect or a `javascript:` navigation.

### Component CSS Properties

All components include a `css` field that allows custom styling with:
- `margin`, `padding`
- `backgroundColor`, `color`
- `borderRadius`, `borderWidth`, `borderColor`
- And more...

### Registering Custom Blocks
Plugins can inject custom blocks into Verso via the frontend plugin registry.
1. Declare the block as `frontend.versoComponents: { "entry": "client/verso/MyPluginVerso.tsx" }` in `manifest.json`, or just drop the file at `client/verso/<Pascal>Verso.tsx` and let the folder convention find it.
2. Export `versoComponentDef` plus a default render component for a single block, or a `versoComponents` map for several.
3. The build auto-generates `src/lib/versoPluginRegistry.ts`, which exports `versoPluginComponents`; `src/lib/verso/pluginBlocks.tsx` adapts those entries to `BlockDefinition`s and registers them in the editor's `BlockRegistry`, so plugin blocks appear alongside the built-in ones and go through the same shared-field wrapper.

**Compatibility, permanently:** the pre-rename spellings all still resolve — manifest key `frontend.puckComponents`, folder `client/puck/<Pascal>Puck.tsx`, exports `puckComponentDef` / `puckComponents`. When both spellings are present the Verso one wins; finding an old one logs one deprecation line per plugin and otherwise behaves identically. Plugin render components also still receive the legacy `puck` prop (`{ isEditing, metadata, dragRef, renderDropZone }`), with `renderDropZone({ zone })` mapped onto the engine's slots — so a bundle compiled against the old contract keeps working without a recompile. The single resolver behind all of this is `backend/scripts/plugin-block-contract.js`, shared by the registry generator and the plugin bundlers. Full walkthrough: `documentation/plugins.md` §13.

---

## Plugin Marketplace (admin) 🛒

`/admin/plugins` now has two tabs — **Installed** and **Marketplace** (`src/app/admin/plugins/page.tsx`, `tab: 'installed' | 'marketplace'`).

*   **`MarketplaceTab.tsx`** (`src/app/admin/plugins/MarketplaceTab.tsx`) browses the merged plugin catalog with search + category filters, showing each entry's version, size, requested permissions (rendered via `permMeta` from `src/lib/permissionMeta.ts`) and installed/active/update state; the per-source status (`sources[]`, each URL's `ok`/`count`/`error`) is surfaced in the tab, and the source list itself is admin-editable.
*   **API client:** `marketplaceApi` in `src/lib/api.ts` — `catalog(refresh?)` → `GET /marketplace/catalog`, `install(id)` → `POST /marketplace/install`, `getSources()` → `GET /marketplace/sources`, `setSources(urls)` → `PUT /marketplace/sources` (admin-configurable catalog sources — no hard-coded URL).
*   **Install flow:** a confirm dialog previews the plugin's requested permissions, then the backend downloads the zip **server-side**, verifies its **sha256** against the catalog entry and runs the exact same security pipeline as a manual upload. The plugin then appears in the **Installed** tab **inactive** with **default-deny** grants, where the admin activates it and grants its capabilities.
*   **Registries:** marketplace-installed plugins flow through the same auto-generated registries as bundled ones — `src/lib/pluginRegistry.ts` (admin pages, hybrid dev/prod loading) and `src/lib/versoPluginRegistry.ts` (editor blocks) — via the standard activate → regenerate → restart flow. Both files are generated per machine and **gitignored**; never commit them.

## Theme Marketplace (admin) 🛒

Themes have a matching marketplace. `/admin/themes` (`src/app/admin/themes/page.tsx`, `tab: 'installed' | 'market'`) exposes **Installed** and **Marketplace** tabs, mirroring the plugin marketplace.

*   **API client:** `themesMarketplaceApi` in `src/lib/api.ts` — `catalog(refresh?)` → `GET /marketplace/themes/catalog`, `install(id)` → `POST /marketplace/themes/install`, `getSources()` / `setSources(urls)` / `resetSources()` → `GET`/`PUT /marketplace/themes/sources`.
*   **Independent sources:** the theme catalog sources are admin-editable and **separate** from the plugin marketplace (backed by their own `marketplace_theme_sources` option), so themes can point at a different origin than plugins.
*   **Install flow:** installs run through the same hardened pipeline as plugins — the backend downloads the zip server-side, verifies its **sha256** against the catalog entry, and runs it through the zip-guard before `installThemeFromZip()`. The **default catalog is empty**, though: the first-party theme catalogue was retired, `marketplace/themes/` no longer exists, and the built index (`marketplace/dist/marketplace-themes-index.json`) is `{"count": 0, "themes": []}`. The tab is the mechanism, kept for admin-configured sources; the four themes WordJS ships are bundled in `backend/themes/`, not installed from here.

## RBAC & Sidebar Filtering

The Admin sidebar dynamically adjusts based on user permissions.
*   **Role-Based Access Control:** User objects now include a `capabilities` array.
*   **Dynamic Filtering:** Each sidebar menu item is mapped to a required backend capability (e.g., `edit_posts`, `manage_options`).
*   **Deduplication:** The `Sidebar` component (`src/components/Sidebar.tsx`) automatically filters out items from `pluginMenus` if they match core menu items (based on `plugin: 'core'` or `href` collisions) to prevent duplicates.

## Mobile & Responsive Behavior

The Admin Panel is fully responsive ("Mobile First").

### Sidebar Strategy
*   **Desktop:** Supports "Collapsed" (Icon only) vs "Expanded" (Full width) states, persisted in `localStorage`.
*   **Mobile:** Enforces "Expanded" layout whenever the menu is open.
    *   The `Sidebar.tsx` component overrides `isCollapsed` styles using `md:` prefixes (e.g., `md:w-28 w-80`) to ensure text labels are always visible on small screens.
    *   Uses a Backdrop (`z-[5001]`) and High Z-Index Sidebar (`z-[5002]`) to float above the interface.

*   **Top Bar:** Fetches site logo and title from the backend Settings API.
*   **Notification Center:** Integrated directly into the mobile header as an "Inline" variant for easy access.

---

## Analytics & Tracking 📊

The frontend includes a native tracking component that logs page views to the backend without external scripts.

### `<AnalyticsTracker />`
**Location:** `src/components/AnalyticsTracker.tsx`

*   **Behavior:**
    *   Listens to route changes via `usePathname()` and `useSearchParams()`.
    *   Sends a `POST` request to `/api/v1/analytics/track` with the current URL and resource.
    *   Debounces duplicate calls (e.g., from React Strict Mode).
*   **Integration:**
    *   Mounted in `src/app/layout.tsx` (the Root Layout) so it runs on every page load (Frontend and Admin).

---

## Internationalization (i18n) 🌐

The admin dashboard is fully translated. The public-facing site renders user content as authored and is not driven by this dictionary.

*   **Supported languages:** Spanish (`es`), English (`en`), Portuguese (`pt`) — `type Language = 'es' | 'en' | 'pt'` in `src/lib/i18n.ts`.
*   **Dictionary:** `src/lib/i18n.ts` holds the `translations` map and the `t(key, lang)` lookup. Resolution order: requested language → English fallback → the raw key (so a missing translation degrades gracefully instead of rendering blank).
*   **Default & persistence:** the default is **Spanish** (`getStoredLanguage()` returns `'es'` during SSR and when nothing is stored). The user's choice is persisted in `localStorage` under `wordjs-lang`.
*   **Context:** `I18nProvider` / `useI18n()` live in `src/contexts/I18nContext.tsx`. The provider initializes to the deterministic `'es'` default during SSR (to avoid hydration mismatch) and then applies the stored language on mount. It is mounted in `src/app/admin/DashboardLayoutClient.tsx`, so i18n is scoped to the admin area.
*   **Usage:** `const { t, language, setLanguage } = useI18n();` then `t('nav.posts')`. The language switcher lives in `src/components/Sidebar.tsx`.
*   **Plugin translations:** plugins extend the dictionary via `registerTranslations({ es: {...}, en: {...}, pt: {...} })`; only the three supported languages are merged.

## HTML Sanitization (isomorphic) 🛡️

User-generated and editor-rendered HTML is sanitized before it hits `dangerouslySetInnerHTML`. `src/lib/sanitize.ts` is **isomorphic** — it sanitizes on both the server (SSR) and the client so there is no pre-hydration XSS window.

> The file carries **no** `"use client"` directive — it is a shared module, so Server Components (`PostContent`/`HomeContent`, `components/content/blocks.tsx`) call `sanitizeHTML()` directly during RSC render, and Client Components keep using it through the DOMPurify path. The `typeof window` checks inside each export choose the implementation. Server Components that need plain text (SEO metadata) still use `htmlToText()` from `src/lib/server-api.ts`. Because server (`sanitize-html`) and client (DOMPurify) serialize styles slightly differently, the rendered HTML blocks set `suppressHydrationWarning`.

*   **Client (browser):** uses **DOMPurify** with an explicit tag/attribute allowlist (text formatting, headings, lists, links, media incl. `iframe` for video embeds, tables, read-only form elements) — the lists themselves come from the generated visual contract (`src/generated/visual-contract.generated.ts`), not from literals in this file. The `<style>` **tag** is intentionally **not** allowed (CSS-injection / data-exfiltration vector — `@import`/`url()` beacons and attribute-selector exfil need no script). The `style` **attribute** survives only as a narrow typographic allowlist: an `afterSanitizeAttributes` hook rewrites it through `filterInlineStyle()`, keeping just `color`, `background-color`, `font-size`, `font-family`, `font-weight`, `font-style`, `text-decoration`, `text-align`, `line-height` and `text-transform`, and only with values that pass the shared `UNSAFE_STYLE_VALUE` criterion (`url(`, `image-set(`, `expression`, `javascript:` and the characters `; { } < > \ @` are all rejected) — an attribute with nothing left is removed. The same hook filters `class` token by token through `safeClassAttribute()`, the same predicate the block-prop channel uses. `<iframe>` is allowed only when its `src` matches the embed-host allowlist (`www.youtube.com`, `player.vimeo.com`, `www.youtube-nocookie.com`); a DOMPurify `uponSanitizeElement` hook drops any other iframe and force-applies `sandbox="allow-scripts allow-same-origin allow-presentation"` on the survivors, and the `afterSanitizeAttributes` hook forces `rel="noopener noreferrer"` on any `target="_blank"` link. `on*` handlers and `<script>/<object>/<embed>/<base>/<meta>/<link>` are forbidden.
*   **Server (SSR):** uses **`sanitize-html`** with `SERVER_SANITIZE_OPTIONS`, which mirrors the DOMPurify allowlist (schemes limited to `http/https/mailto/tel`, plus `data:` for `img`/`source`). To stay symmetric with the client, it restricts `<iframe>` to the same embed-host allowlist (`allowedIframeHostnames`), force-applies a `sandbox` on every surviving iframe and `rel="noopener noreferrer"` on `target="_blank"` links via `transformTags`, mirrors the inline-style allowlist through `allowedStyles` (the same ten typographic properties, each with its own value pattern), filters `class` on every surviving element via the `'*'` transform (sanitize-html runs the per-tag transform *and* then `'*'`, so `a` and `iframe` are covered too), and no longer opts `<style>` in (the previous `allowVulnerableTags`/`<style>` opt-in is gone). If the library is unavailable it **fails closed** by stripping all tags via regex.
*   **Exports:**
    *   `sanitizeHTML(dirty)` — the default; safe HTML for rendering.
    *   `sanitizeHTMLCustom(dirty, options)` — extra DOMPurify options on the client; falls back to the base server allowlist during SSR.
    *   `stripHTML(dirty)` — text only (uses `sanitize-html` with an empty allowlist on the server, not a bypassable regex).
    *   `hasDangerousContent(html)` — heuristic check for `<script>`, `javascript:`, inline `on*=`, `data:text/html`, etc.

> Note: the backend has its own content-sanitization layer (`backend/src/core/formatting.ts`); the frontend `sanitize.ts` is the rendering-time defense in depth.

## Content Security Policy 🔒

`next.config.ts` `headers()` sets a baseline Content-Security-Policy (and companion headers) on **every** route (`source: '/:path*'`):

```text
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https:;
worker-src 'self' blob:;
style-src 'self' 'unsafe-inline' https:;
img-src 'self' data: blob: https:;
font-src 'self' data: https:;
connect-src 'self' https: http: ws: wss:;
frame-src 'self' https://www.youtube.com https://player.vimeo.com https://www.youtube-nocookie.com;
frame-ancestors 'self';
object-src 'none';
base-uri 'self';
```

> **`frame-src` is derived, not hand-written.** The embed hosts come from `frontend/embed-hosts.js` (`ALLOWED_EMBED_HOSTS`), the same module `src/lib/sanitize.ts` reads, and `next.config.ts` maps that list into the directive. It used to be typed out by hand beside a comment claiming it matched the sanitizer — it did not: `www.youtube-nocookie.com` (what YouTube hands you when you tick *Enable privacy-enhanced mode* under Share → Embed) was accepted by `resolveVideoEmbedUrl` and **blocked by the CSP**, so the VideoEmbed block resolved the URL, rendered a real `<iframe>`, and the browser refused the frame — an empty hole with no "Unsupported video URL" marker, because nothing in the code thought anything had gone wrong. The same header is served on `/admin`, so the author saw the hole the instant they pasted the URL. `embed-hosts.js` is itself derived: both of its exports read `security.html.iframeHosts` out of `contracts/visual-contract.v1.json`, so adding a provider means editing that contract and regenerating — never editing a list in the frontend. `src/lib/__tests__/embedHostsCsp.test.ts` fails if the CSP and the list ever disagree. (`embed-hosts.js` is plain `.js` because `next.config.ts` is executed by Next with Node resolving its imports at runtime — it cannot read a `.ts` module.)

Companion headers: `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()` (`payment` is deliberately left unrestricted — the online-store plugin's Stripe Elements uses the Payment Request API). `poweredByHeader: false` also drops Next's `X-Powered-By` version fingerprint. A second rule caches `/fonts/:path*` with `public, max-age=31536000, immutable`.

**Honest caveats** (documented in the code comments — this CSP is *not* the XSS backstop):

*   **`script-src` is permissive by necessity, so it is not the XSS control** — the server-side sanitizer in `sanitize.ts` is. Its directives stay because removing them is a regression:
    *   `blob:` is **required** — the admin loads each plugin's frontend bundle via `import(URL.createObjectURL(blob))` (`lib/pluginBundleLoader.ts`); without it every plugin admin UI and its icons fail (the "no icons" regression).
    *   `'unsafe-eval'` — some bundled libs use `Function()`/`eval` at runtime. Note that the original reason for this directive was the retired Puck editor; Verso itself does not need it, and the directive has **not** been re-narrowed since the rewrite (see the caveat below).
    *   `'unsafe-inline'` — Next.js App Router emits inline bootstrap/hydration `<script>` tags (a per-request nonce migration is out of scope).
*   **`https:` on `font-src`/`style-src`/`img-src`/`script-src`** covers the app's own theme assets (fonts under `/uploads/fonts`, theme CSS, images). It was widened for a second reason that **no longer applies**: the old editor rendered the theme inside an `about:srcdoc` iframe, where the CSP keyword `'self'` does not resolve to the page origin. Verso's canvas is an ordinary same-origin route (`<iframe src="/admin/canvas-frame">`) and there is no `srcdoc` iframe left in the frontend, so that justification is gone — but the policy in `frontend/next.config.ts` has not been re-narrowed yet, and its code comment still cites the retired editor. Tightening it is an open, unverified cleanup; do not assume it has happened.
*   The **real structural value** is `frame-ancestors 'self'` (clickjacking, plus the legacy `X-Frame-Options: SAMEORIGIN`), `object-src 'none'`, and `base-uri 'self'`. `frame-ancestors` is `self` (not `none`) so WordJS can frame its OWN pages same-origin (the theme Customizer previews the live site in an iframe); cross-origin framing stays blocked.
