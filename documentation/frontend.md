# WordJS Frontend Documentation

The Frontend (`frontend/`) is a **Next.js** application serving both the public site and the admin dashboard.

## Structure

*   **App Router:** Uses the modern Next.js App Router (`src/app`).
*   **Public Site:** `src/app/(public)/` - Server-rendered blog posts, pages, search, and themes (see **Public Site Rendering (SSR)** below).
*   **Admin Dashboard:** `src/app/admin/` - Management interface.

## Gateway Integration

The frontend registers itself with the Gateway automatically on startup.
This is handled in **`src/instrumentation.ts`** (`register()`, Node runtime only):

1.  Next.js starts and calls `register()`.
2.  Reads config, preferring a local `wordjs-config.json` (distributed deploy) and falling back to `../backend/wordjs-config.json` (monolith) for the gateway host/ports, `gatewaySecret`, and `frontendUrl`.
3.  If cluster mTLS certs are present (`certs/` locally or `../backend/certs`), it POSTs to the gateway's **internal** port over HTTPS with the client cert; otherwise it falls back to plain HTTP on the public gateway port.
4.  Sends `POST /register` with its route prefixes: `/`, `/admin`, `/login`, `/install`, `/migration`, `/portal`, `/_next` (authenticated by `x-gateway-secret`). It retries every 5s until the gateway accepts.

## Visual Editing (Puck)

WordJS uses **Puck** for its visual editor.
*   **Components:** Located in `src/components/puck`.
*   **Plugin Integration:** Plugins can inject custom Puck components ensuring a modular page builder experience.

## Development vs Production

*   **Internal Port:** `3001` (default).
*   **Public Access:** Accessed via Gateway on port `3000` (or `80`/`443` in prod).

The browser calls a **relative** `/api/v1` path (`frontend/src/lib/api.ts`), so it reaches the backend through the gateway automatically — there is **no** client-side API-URL env var to set. Server-side rendering resolves the backend base on the server from `WORDJS_MONO_ORIGIN` (monolith) or `wordjs-config.json` (split), with an optional `INTERNAL_API_URL` override.


## Public Site Rendering (SSR) 🌐

The public site is **real server-side rendering (SSR)**, not client-only skeletons. Every route under `src/app/(public)/` — the home page (`page.tsx`), single posts (`[slug]/page.tsx`), category posts (`[slug]/[postSlug]/page.tsx`), static pages (`pages/[slug]/page.tsx`), and search (`search/page.tsx`) — is an **async React Server Component** that fetches its content **on the server**. The initial HTML sent to crawlers and the first paint already contain the real title and body.

### Server data layer: `src/lib/server-api.ts`
A **server-only** module (must never be imported from a `"use client"` file). It:

*   **Resolves the backend base URL** for SSR fetches (`resolveServerBase()`): monolith uses the loopback origin (`WORDJS_MONO_ORIGIN`, default `http://127.0.0.1:4000`); split mode reads the backend port from `wordjs-config.json` (default `4000`); `INTERNAL_API_URL` overrides both.
*   **Deduplicates requests** — the single-resource content loaders (`getSettings`, `getPostBySlug`, `getPostById`, `getPosts`) are wrapped in React `cache()`, so `generateMetadata()` and the page body share a single request-scoped backend call instead of fetching the same post twice. (`searchPosts()` is a plain async function — it issues two parallel fetches per call and is not memoized.) Fetches use `cache: 'no-store'` (per-request, fresh content).
*   **Forwards the public host** — `serverFetch()` relays the inbound `x-forwarded-host` / `x-forwarded-proto` to the backend. Because SSR fetches hit the loopback origin, without this the backend's host-based logic (the **Site-URL/migration guard**, **CSRF origin** check, **canonical/OpenGraph** URLs) would see `localhost:4000` instead of the public host and reject SSR requests (e.g. `409 migration_required`).
*   **Builds SEO metadata** — `buildPostMetadata()` (title, description, canonical, OpenGraph/Twitter) and `htmlToText()` (tag-stripping excerpt builder for `<meta>` values). These are server-safe and do **not** call the `"use client"` sanitizer.

### Content renderers (client components fed server-fetched props)
The actual content markup lives in **client components** that receive the already-fetched `post` as a prop from the Server Component: `src/components/public/PostContent.tsx` (single post / page / category-post) and `src/components/public/HomeContent.tsx` (static home page). Because the data arrives as a prop (not via a browser-only `useEffect` fetch), these **render on the server during SSR** — real HTML body and sanitized content reach the crawler — and then **hydrate** the interactive bits (photo carousels, comments, locale-aware dates, plugin `[shortcode]` embeds).

### SEO & behavior
*   **`generateMetadata`** — each page exports it for a per-page `<title>` (the root layout applies a `%s | site` template; the home page uses `title.absolute` to avoid doubling), description, canonical, and OpenGraph/Twitter tags. Per-route `generateMetadata` returns **relative** canonical/`og:url` values (e.g. `/my-post`).
*   **`metadataBase` is anchored to the configured site URL (FE-SSR-01)** — the root layout's `generateMetadata` (`src/app/layout.tsx`) sets `Metadata.metadataBase` so the relative canonical/OpenGraph URLs absolutize correctly. The base is taken from the **configured** site URL (`settings.siteurl || home || site_url`), **not** the raw `Host`/`X-Forwarded-Host` header. The request host is honored only when its hostname matches the configured origin (a host allowlist); only when no site URL is configured does it fall back to the raw request host. This prevents an attacker-controlled `Host` header from rewriting every canonical/`og:url` to their own domain (SEO/phishing poisoning).
*   **Real 404s** — when content is missing, pages call `notFound()` (a real HTTP 404), and their `generateMetadata` returns `robots: { index: false }`.
*   **Search is no-JS** — `search/page.tsx` is a plain `<form action="/search" method="get">`, so it works with JavaScript disabled; it server-fetches results via `searchPosts()` and is marked `robots: { index: false }`.
*   **`suppressHydrationWarning`** — sanitized-HTML blocks (`dangerouslySetInnerHTML`) carry `suppressHydrationWarning` because the server (`sanitize-html`) and client (DOMPurify) serialize styles slightly differently (see **HTML Sanitization** below).

> **`sanitize.ts` is `"use client"`** — therefore `sanitizeHTML()` **cannot be called from a Server Component**. Sanitization happens inside the client renderers (`PostContent`/`HomeContent`), which still execute during SSR. For server-side metadata, use the plain-text `htmlToText()` from `server-api.ts` instead.


## Theme UI Framework (`wordjs-ui.css`) 🎨

The theme system ships a single token-driven, Bootstrap-like CSS framework. The frontend loads it on **public pages** and inside the **editor preview iframe** — never on the admin UI — so authored content renders the same in both places. The full reference is in `documentation/theming.md`; this section covers only how the frontend wires it in.

*   **What it is:** `backend/public/css/wordjs-ui.css` (served at `/public/css/wordjs-ui.css`) — one shared static stylesheet that auto-styles every HTML element plus Bootstrap-compatible components (`.btn`/`.card`/`.alert`/`.badge`/`.table`/`.nav`/`.list-group`/`.pagination`/`.progress`/`.modal`/`.dropdown` and a flexbox grid `.container`/`.row`/`.col-*`) and a utility layer (spacing/display/flex/text/colors/borders/sizing/shadow).
*   **Driven by `--wjs-*` design tokens** declared in each theme's `style.css :root` (not `theme.json`). The framework has fallbacks, so a theme re-skins everything just by setting tokens. All 14 bundled themes ship a full `--wjs-*` token set tuned to their palette (including per-variant `--wjs-color-on-*` max-contrast text tokens).
*   **Public load order (`src/components/public/ThemeLoader.tsx`):** the `<link id="wjs-ui-framework" href="/public/css/wordjs-ui.css">` is emitted **first**, then the active theme's `style.css?v=…` (`id="wjs-theme-stylesheet"`). Because the framework loads before the theme, the theme's `:root` tokens and custom rules override it at equal specificity. The framework is static so it always renders (even while the active theme is still resolving), which also avoids an unstyled flash.
*   **Editor preview (`src/components/PuckEditor.tsx`):** a `useEffect` injects the same two links — framework first, then the active theme's `style.css` — into the Puck preview **iframe** (`.puck-container iframe`) for true WYSIWYG. The injection is idempotent and id-guarded, so it's a safe no-op if the public layout already added them. Only the iframe canvas is themed; Puck's editing chrome stays outside it.
*   **Backend rendering** has its own equivalent: the Handlebars `wordjs_head` helper (`backend/src/core/theme-engine.ts`) links the same stylesheet for server-rendered theme output.

> The admin UI is intentionally **not** styled by this framework — it keeps the "Premium" design system below.


## Context Providers & State

The app uses React Contexts to manage global state:
*   **`AuthContext`**: Handles JWT parsing, role-based capabilities, and login/logout methods.
*   **`MenuContext`**: Fetches and caches the admin sidebar menu items from `/api/v1/plugins/menus`.

## System Components

### `SystemFontsLoader`
**Location:** `src/components/SystemFontsLoader.tsx`
Injects font faces dynamically based on the site's configuration. It prevents FOUT (Flash of Unstyled Text) by loading fonts before the main content matches.

### `InlineTiptap` (in-place text editor)
**Location:** `src/components/InlineTiptap.tsx`
The in-place rich-text editor for Text/Heading blocks — edits the text **directly on the canvas**
(Tiptap / ProseMirror) so it looks identical to the rendered block, with a floating toolbar.
*   **Features:** bold / italic / underline / strikethrough, links, lists, **text color** (swatch
    palette + visual picker + screen **eyedropper**), **font family** (from the fonts installed in
    WordJS, via `/fonts`), **font size**, and **text alignment** (left/center/right/justify).
*   **Usage:** opens via the per-block pencil action in Puck's overlay; saves continuously. Runs
    inside the editor's iframe and is cross-frame aware (`editor.view.dom.ownerDocument`).
*   **Note:** `puckConfig.tsx` still exports a legacy standalone `RichTextEditor`, no longer used
    for inline editing.

## Navigation Components

### `SmartLink`
A wrapper around `next/link` that handles conditional prefetching and active state management.
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
    *   `backButton` (boolean): Show back arrow (default: false).

### `Card`
**Location:** `src/components/ui/Card.tsx`
The primary container for content. Enforces the `rounded-[40px]` premium styling.
*   **Props:**
    *   `children`: Content.
    *   `title` (string, optional): Card header title.
    *   `variant` ('default' | 'glass' | 'neo'): Visual style.
    *   `padding` ('none' | 'sm' | 'md' | 'lg'): Internal padding.

### `ActionCard`
**Location:** `src/components/ui/ActionCard.tsx`
Clickable cards for dashboards or quick actions.
*   **Props:**
    *   `icon`: FontAwesome class.
    *   `title`: Main text.
    *   `description`: Subtext.
    *   `onClick` / `href`: Action handler.
    *   `variant` ('primary' | 'danger' | 'success' | 'warning' | 'info'): Color theme.

### `Input` / `ModernSelect`
**Location:** `src/components/ui/Input.tsx`, `src/components/ModernSelect.tsx`
Form controls with consistent rounded styling and focus states.

---

## Visual Editing (Puck)

WordJS integrates **Puck** (by Measured) as its visual page builder.

### Configuration
*   **Config File**: `src/components/puckConfig.tsx` defines the available components (and exports the `RichTextEditor`).
*   **Editor Page**: `src/app/admin/pages/[id]/page.tsx` renders the editor interface (via `PuckEditor.tsx`).
*   **Canvas & responsive preview**: `PuckEditor.tsx` renders the canvas in Puck's **iframe** for true WYSIWYG (the page's own styles/fonts and the fixed header/scroll behave as on the live site). A device switcher (desktop/tablet/mobile) sizes the iframe to the device width via `PreviewFrame` — desktop is full-bleed, tablet/mobile use a scaled device frame — so the responsive breakpoints evaluate against the device width and match the live site. Text/heading blocks are edited in place by `InlineTiptap` (see above).
*   **Render Pages**: the public routes — `src/app/(public)/page.tsx` (home), `src/app/(public)/[slug]/page.tsx`, `src/app/(public)/[slug]/[postSlug]/page.tsx`, and `src/app/(public)/pages/[slug]/page.tsx` — are **async Server Components** that fetch content server-side (see **Public Site Rendering (SSR)**) and hand it to the `PostContent`/`HomeContent` client renderers, which use Puck's `<Render>` component for Puck-authored layouts (and sanitized HTML for classic content). (There is no `[...slug]` catch-all route.)

### Available Components

#### Content Components

| Component   | Description          | Key Properties                                      |
| ----------- | -------------------- | --------------------------------------------------- |
| **Heading** | Text headings H1-H6  | `title`, `level`, `align`, `css`                    |
| **Text**    | Rich text content    | `content`, `align`, `css`                           |
| **Image**   | Responsive images    | `src`, `alt`, `width`, `height`, `objectFit`, `css` |
| **Button**  | Clickable buttons    | `text`, `href`, `variant`, `size`, `css`            |
| **Divider** | Horizontal separator | `style`, `color`, `thickness`, `css`                |
| **Spacer**  | Vertical spacing     | `height`, `css`                                     |
| **Card**    | Content container    | `title`, `content`, `image`, `link`, `css`          |

#### Layout Components

| Component   | Description       | Key Properties                                        |
| ----------- | ----------------- | ----------------------------------------------------- |
| **Columns** | Multi-column grid | `distribution` (column widths), `columnStyles`, `css` |
| **Section** | Container wrapper | `backgroundColor`, `padding`, `maxWidth`, `css`       |
| **Grid**    | CSS Grid layout   | `columns`, `gap`, `minItemWidth`, `css`               |
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
| **Testimonial**  | Customer quotes | `quote`, `author`, `role`, `image`, `css`                            |
| **CTABanner**    | Call-to-action  | `title`, `description`, `buttonText`, `buttonLink`, `variant`, `css` |

#### Dynamic Content Components

| Component         | Description          | Key Properties                                                     |
| ----------------- | -------------------- | ------------------------------------------------------------------ |
| **PostsGrid**     | Display recent posts | `count`, `columns`, `css`                                          |
| **CategoryPosts** | Posts by category    | `categoryId`, `layout`, `css`                                      |
| **SearchBar**     | Search input         | `placeholder`, `buttonText`, `searchPage`, `align`, `width`, `css` |

### Component Security

Two render-time components self-enforce XSS hardening (independent of the HTML sanitizer):

*   **VideoEmbed** renders an `<iframe>` only when the resolved URL is `https:` with a hostname in `{www.youtube.com, (www.)youtube-nocookie.com, player.vimeo.com}`; anything else (arbitrary `src`, `javascript:`/`data:`, a non-embed host) renders a placeholder instead. Every embed carries `sandbox="allow-scripts allow-same-origin allow-presentation"` + `referrerPolicy="strict-origin-when-cross-origin"`.
*   **SearchBar** confines navigation to a same-origin **relative path**: the editor-controlled `searchPage` is resolved against `window.location.origin` and only its `pathname` is used when the origin matches; otherwise it falls back to `/search`. So an absolute/scheme/protocol-relative URL cannot become an open redirect or a `javascript:` navigation.

### Component CSS Properties

All components include a `css` field that allows custom styling with:
- `margin`, `padding`
- `backgroundColor`, `color`
- `borderRadius`, `borderWidth`, `borderColor`
- And more...

### Registering Custom Blocks
Plugins can inject custom blocks into Puck via the frontend plugin registry.
1. Define the block in your plugin's `client/puck/` folder.
2. The build auto-generates `src/lib/puckPluginRegistry.ts`, which exports `puckPluginComponents` — a map merged into the core Puck config so plugin blocks appear alongside the built-in ones.

---

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
    *   The `Sidebar.tsx` component overrides `isCollapsed` styles using `md:` prefixes (e.g., `md:w-24 w-80`) to ensure text labels are always visible on small screens.
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
*   **Usage:** `const { t, language, setLanguage } = useI18n();` then `t('nav.posts')`. The language switcher lives in `src/components/Sidebar.tsx` (and the Puck editor in `src/components/PuckEditor.tsx`).
*   **Plugin translations:** plugins extend the dictionary via `registerTranslations({ es: {...}, en: {...}, pt: {...} })`; only the three supported languages are merged.

## HTML Sanitization (isomorphic) 🛡️

User-generated and Puck-rendered HTML is sanitized before it hits `dangerouslySetInnerHTML`. `src/lib/sanitize.ts` is **isomorphic** — it sanitizes on both the server (SSR) and the client so there is no pre-hydration XSS window.

> The file is marked `"use client"`, so it executes during SSR only when invoked from a Client Component (e.g. `PostContent`/`HomeContent`) — it **cannot be imported into a Server Component**. Server Components that need plain text (SEO metadata) use `htmlToText()` from `src/lib/server-api.ts` instead. Because server (`sanitize-html`) and client (DOMPurify) serialize styles slightly differently, the rendered HTML blocks set `suppressHydrationWarning`.

*   **Client (browser):** uses **DOMPurify** with an explicit tag/attribute allowlist (text formatting, headings, lists, links, media incl. `iframe` for video embeds, tables, read-only form elements). The `<style>` **tag** and the `style` **attribute** are intentionally **not** allowed (CSS-injection / data-exfiltration vector — `@import`/`url()` beacons and attribute-selector exfil need no script). `<iframe>` is allowed only when its `src` matches the embed-host allowlist (`www.youtube.com`, `player.vimeo.com`); a DOMPurify `uponSanitizeElement` hook drops any other iframe and force-applies `sandbox="allow-scripts allow-same-origin allow-presentation"` on the survivors, and an `afterSanitizeAttributes` hook forces `rel="noopener noreferrer"` on any `target="_blank"` link. `on*` handlers and `<script>/<object>/<embed>/<base>/<meta>/<link>` are forbidden.
*   **Server (SSR):** uses **`sanitize-html`** with `SERVER_SANITIZE_OPTIONS`, which mirrors the DOMPurify allowlist (schemes limited to `http/https/mailto/tel`, plus `data:` for `img`/`source`). To stay symmetric with the client, it restricts `<iframe>` to the same embed-host allowlist (`allowedIframeHostnames`), force-applies a `sandbox` on every surviving iframe and `rel="noopener noreferrer"` on `target="_blank"` links via `transformTags`, and no longer opts `<style>` in (the previous `allowVulnerableTags`/`<style>` opt-in is gone). If the library is unavailable it **fails closed** by stripping all tags via regex.
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
frame-src 'self' https://www.youtube.com https://player.vimeo.com;
frame-ancestors 'none';
object-src 'none';
base-uri 'self';
```

Companion headers: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.

**Honest caveats** (documented in the code comments — this CSP is *not* the XSS backstop):

*   **`script-src` is permissive by necessity, so it is not the XSS control** — the server-side sanitizer in `sanitize.ts` is. Its directives stay because removing them is a regression:
    *   `blob:` is **required** — the admin loads each plugin's frontend bundle via `import(URL.createObjectURL(blob))` (`lib/pluginBundleLoader.ts`); without it every plugin admin UI and its icons fail (the "no icons" regression).
    *   `'unsafe-eval'` — the Puck visual editor and some bundled libs use `Function()`/`eval` at runtime.
    *   `'unsafe-inline'` — Next.js App Router emits inline bootstrap/hydration `<script>` tags (a per-request nonce migration is out of scope).
*   **`https:` on `font-src`/`style-src`/`img-src`/`script-src`** is needed because the app loads its own theme assets and, crucially, the Puck editor renders the theme inside an `about:srcdoc` iframe where the CSP keyword `'self'` does **not** resolve to the page origin — same-origin `https:` assets would otherwise be blocked.
*   The **real structural value** is `frame-ancestors 'none'` (clickjacking, plus the legacy `X-Frame-Options: DENY`), `object-src 'none'`, and `base-uri 'self'`.
