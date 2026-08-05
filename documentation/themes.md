# WordJS Themes Documentation

WordJS uses a **CSS Variable-based theming system** that allows complete visual customization without code changes.

## Theme Structure

Each theme is located in `backend/themes/{theme-slug}/`. A theme can be as simple as a single `style.css`, or include the full server-side template set:

```
themes/
├── my-theme/
│   ├── style.css         # Main stylesheet (the file the Next.js frontend loads)
│   ├── theme.json        # Optional: Theme metadata (name, version, description, author) + a `layout` block
│   ├── functions.js      # Optional: Theme logic/hooks, loaded by the backend theme engine
│   ├── templates/        # Optional: Handlebars page templates (index.html, single.html, archive.html)
│   ├── partials/         # Optional: Shared Handlebars partials (header.html, footer.html)
│   └── screenshot.png    # Optional: Theme preview (also .jpg/.webp); none shipped today
```

> **One live renderer: Next.js.** The public site is rendered entirely by Next.js
> (`frontend/src/app/(public)/`) in **both** the split and monolith modes. WordJS still ships a
> backend Handlebars template engine (`backend/src/core/themes.ts` + `theme-engine`, which can
> consume `templates/`, `partials/`, and `functions.js`), but its public catch-all is **no longer
> mounted** (`backend/src/index.ts`): it was unreachable behind the gateway/monolith routing, so it
> is kept on disk as a marked *legacy* / library path, not the renderer. What the live site consumes
> from a theme is its **`style.css`** (design tokens + rules), injected as a `<link>` by
> `ThemeLoader`, plus an optional **`theme.json` `layout`** block and the admin **customizer**
> overrides (see "Theme integration with the live site" below). So for the live site's **rendering**,
> `style.css` + `theme.json` are what matter, and `templates/`/`partials/` belong only to the legacy
> engine. A theme's optional `functions.js` still loads at boot — now in an **isolated child process**
> (see the sandbox note below) — so it can register hooks/shortcodes, but it does not drive the
> Next.js page render.
>
> Theme metadata is parsed from `theme.json` by `parseThemeMetadata()`; missing fields fall
> back to defaults (name = slug, version = `1.0.0`). A `screenshot.{png,jpg,webp}`, if present,
> is auto-detected and exposed in the theme picker.

> **`functions.js` runs OS-isolated (like an isolated plugin).** A theme's optional `functions.js`
> is *not* trusted code. When the theme engine loads it (`loadThemeLogic()` in
> `backend/src/core/theme-engine.ts`, invoked from `themeEngine.init()` at boot and on a theme
> switch) it first runs the same install-time **AST static scanner** as plugins
> (`validatePluginPermissions`, which fails closed and blocks `eval`/`Function`, `exec`/`spawn`,
> `require()`/`import()` of sensitive builtins such as `child_process`, etc.); if that scan trips,
> `functions.js` is blocked and the rest of the theme still loads. It then runs the logic in a
> **separate OS process** — exactly like an isolated plugin — via
> `loadIsolatedPlugin('theme:<slug>', …)` (`child_process.fork` of `plugin-worker.js`), **not**
> in-process. This closed the in-process-theme RCE cluster: theme code on the host main thread had
> no runtime `eval`/`Function`/dynamic-import guard, so a malicious theme could achieve host RCE that
> no static scan can fully prevent. Any hooks/shortcodes/mail the theme registers now flow through the
> **same RPC bridge** isolated plugins use (the isolate layer already namespaces `theme:` slugs), and
> the runtime guards (`secure-require`/`io-guard`) confine `fs`/`require` to the theme's own directory
> and deny secret/DB files. By default a theme is granted only `settings:read` + `content:read`; a
> theme that needs more must ship a `manifest.json`. (Handlebars helpers stay built-in and host-side —
> they are not registered from `functions.js`.)

## Available Themes

WordJS offers **65 first-party themes**. Only **default** (WordJS) ships bundled in
`backend/themes/`; the other 64 (`marketplace/themes/`) install on demand through the **theme
marketplace** (see *Installing a Theme* below). A representative selection:

| Theme               | Aesthetic          | Key Features                                |
| ------------------- | ------------------ | ------------------------------------------- |
| **default** (WordJS)| Clean, Modern      | Indigo→violet gradient, Space Grotesk, deep-indigo footer |
| **neo-digital**     | Cyberpunk/Terminal | Green glow, monospace fonts, dark mode      |
| **brutalist-paper** | Neo-brutalist      | Sharp corners, bold borders, offset shadows |
| **soft-glass**      | Glassmorphism      | Blur effects, transparency, pastels         |
| **swiss-minimal**   | Bauhaus/Flat       | No shadows, high contrast B/W/Red           |
| **midnight-luxury** | Dark Premium       | Gold accents, serif fonts, elegant          |
| **aurora-gradient** | Mesh Gradient      | Flowing gradients, purple/cyan/magenta      |
| **neon-pulse**      | Tech Noir          | Neon glow, dark mode, rose accents          |
| **carbon-terminal** | OLED Dev/Docs      | OLED-dark, terminal-green accent            |
| **noir-or**         | Luxury             | Gold accents on deep charcoal               |
| **pop-studio**      | Bold Creative      | Vibrant pink/cyan, big rounded shapes       |
| **sage-calm**       | Wellness           | Organic sage greens on soft cream           |
| **sepia-press**     | Editorial Magazine | Serif headlines on warm paper               |

> **`--wjs-` variable adoption.** All first-party themes ship the `--wjs-*` token set documented in
> [`theming.md`](./theming.md) — from compact token-first themes (~20 declarations) up to heavily
> parameterized ones (~270; e.g. `carbon-terminal` declares 172, the bundled `default` 75) —
> including the `--wjs-color-on-*` contrast set. The **default** theme's `:root` is entirely
> `--wjs-*` (no older bare `--primary`/`--text` aliases remain). Copy any theme as a starting point.

## The WordJS UI Framework

Beyond a theme's own `style.css`, WordJS ships **one shared, token-driven CSS framework** —
`backend/public/css/wordjs-ui.css` (served at `/public/css/wordjs-ui.css`). It is the
"Bootstrap-like" base that every theme builds on:

- **Auto-styles every standard HTML element** (typography, forms, tables, lists, etc.).
- **Bootstrap-compatible components**: `.btn`/`.card`/`.alert`/`.badge`/`.table`/`.nav`/
  `.list-group`/`.pagination`/`.progress`/`.modal`/`.dropdown`, plus a flexbox grid
  (`.container`/`.row`/`.col-*`).
- **A utility layer**: spacing, display, flexbox, text, colors, borders, sizing, and shadow helpers.

Everything in the framework is driven by the same `--wjs-*` design tokens (see the *CSS Variables
Reference* below and the manifest `backend/public/theme-tokens.json`), each with
a sensible fallback. Because the tokens are declared in each theme's **`style.css :root`** (not
`theme.json`), a theme re-skins the entire framework — every element, component, and utility — just by
overriding tokens. Per-variant `--wjs-color-on-*` tokens carry the max-contrast text color
(black/white) for each solid color, computed per theme so text on `.btn-primary`, `.badge`, etc.
stays legible against that theme's palette.

**Where it loads (and where it does not):**

- On **public pages**, `ThemeLoader` (`frontend/src/components/public/ThemeLoader.tsx`) injects
  `wordjs-ui.css` **first** (id `wjs-ui-framework`), then the active theme's `style.css` — so the
  theme's `:root` tokens and custom rules win at equal specificity.
- In the **editor preview iframe** (`frontend/src/components/PuckEditor.tsx`), the same framework +
  active-theme stylesheet are injected (framework first), so the WYSIWYG canvas matches the live site.
- *(Legacy engine — not the live renderer.)* The backend Handlebars `wordjs_head` helper (`backend/src/core/theme-engine.ts`) emits the framework
  (`wordjs-ui.css`, before `core.css`). The active theme's `style.css` is linked separately by the theme's
  `header.html` partial via the `get_stylesheet_uri` helper (in the bundled partials that link comes *before*
  `{{wordjs_head}}`, so on the backend Handlebars path the theme stylesheet precedes the framework).
- It is **never** loaded into the admin UI. Selectors are intentionally low-specificity, so themed
  chrome built with utility/Tailwind classes keeps winning; in practice the framework styles raw
  content HTML and offers opt-in classes wherever it's loaded.

**Responsive out of the box (v1.5.4).** First-party themes are browser-verified at mobile, tablet
and desktop widths. The framework contributes the shared guards: below `768px` it caps the
visual-editor heading sizes through the `--wjs-h{1..6}-size` aliases (`min(var(--wjs-hN), cap)`, so a
theme whose scale is already smaller wins), and at **every** width it contains wide content — tables
and `pre` scroll inside their own container, long unbroken strings wrap — so nothing forces body-level
horizontal scroll. It also ships the editor's per-block device-visibility classes `.wjs-hide-mobile` /
`.wjs-hide-tablet` / `.wjs-hide-desktop` (breakpoints `<768` / `768–1023` / `≥1024`). Themes layer
their own scoped media queries on top where their design needs it (e.g. narrow-viewport header-fit
rules). When a theme hides or rearranges header pieces such as `.wjs-header-actions`, keep those rules
**scoped to the intended breakpoint/selector** — an unscoped `display: none` there also kills the
mobile nav toggle.

All first-party themes ship a `--wjs-*` token set tuned to their palette (see the adoption note
above for the real per-theme declaration counts). For the full token + class reference, see
[`documentation/theming.md`](./theming.md).

## Theme integration with the live site

The active theme drives the **entire** live (Next.js) site — not just raw content — through four seams,
all of which default to today's look so the existing themes render unchanged:

1. **Token-driven chrome.** The fixed React chrome consumes `--wjs-*` tokens instead of hardcoded
   colors: the header/nav/burger (`Header.tsx`), the footer (`Footer.tsx`), the post/page meta and
   cards (`PostContent.tsx`), and the blog roll (`app/(public)/page.tsx`). Text on solid fills uses the
   `--wjs-color-on-*` contrast tokens, so a theme re-skins the whole shell by setting tokens. The chrome
   also honors the **menu editor** (`menusApi.getByLocation('header'|'footer')`) and the **footer
   editor** (`footer_text`/`footer_socials`/`footer_copyright`).
2. **Themed post content.** Rendered post/page bodies are wrapped in `.wjs-content` (the framework's
   long-form content rules) so headings, links, lists, tables, code, etc. pick up the theme's tokens.
3. **Widget areas.** The widget editor's sidebars are now rendered: `footer-1` inside the footer, and
   an opt-in primary `sidebar-1` (see `layout.sidebar` below), both via
   `PublicSidebar.tsx` → `widgetsApi.renderSidebar` (sanitized). Each area collapses to nothing when it
   has no assigned widgets, so there is no empty column. Widgets are themed by token-driven
   `.widget`/`.widget-title`/`.widget-area` rules in `wordjs-ui.css`.
4. **`theme.json` `layout` (structure config).** A theme may declare a `layout` block, e.g.:

   ```json
   { "layout": { "containerWidth": "72rem", "sidebar": true } }
   ```

   `parseThemeMetadata()`/`switchTheme()` surface it into the `active_theme_layout` option (in
   `PUBLIC_SETTINGS`), and the SSR public layout (`app/(public)/layout.tsx`) honors it — `containerWidth`
   caps the main column, `sidebar: true` switches content/archive pages to two columns with `sidebar-1`.
   Omitting the block (as every first-party theme does today) keeps the current single-column, default-width layout.
   The full v2 schema is documented in "Structure config (layout)" below.

### Structure config (layout)

`theme.json` may declare a `layout` block (schema v2 — machine-readable copy in
`backend/public/theme-layouts.schema.json`). Every key is **optional**: omitting a key — or the
whole block, as the default theme does — keeps the current design exactly.

```json
{
  "layout": {
    "header": { "variant": "centered", "sticky": true, "transparent": false },
    "footer": { "variant": "minimal" },
    "sidebar": { "position": "left" },
    "containerWidth": "72rem"
  }
}
```

| Key | Values (default) | Meaning |
| --- | --- | --- |
| `header.variant` | `classic` \| `centered` \| `minimal` (`classic`) | `classic` = today's markup unchanged; `centered` = logo centered on top, nav in a row below; `minimal` = logo + hamburger only (nav always in the mobile panel). |
| `header.sticky` | boolean (`true`) | `false` renders the header static in flow — no fixed positioning and no main offset. |
| `header.transparent` | boolean (`false`) | `true` = no header background over the start of the page until the first scroll (`data-scrolled` restores it). |
| `footer.variant` | `columns` \| `minimal` (`columns`) | `minimal` = a single row: copyright + socials, no column grid. |
| `footer.columns` | `1`–`4` (`4`) | Footer grid column count; only applies to `variant: "columns"`. |
| `sidebar` | boolean or `{ "position": "left" \| "right" }` | `true` ≡ `{ "position": "right" }` (back-compat with the existing boolean form). |
| `containerWidth` | CSS length | Caps the main column (existing key, kept as-is). |

The variants themselves are implemented by the platform chrome (`Header.tsx`/`Footer.tsx`/
`PublicLayoutShell.tsx`) — a theme only *declares* them here; no markup or CSS ships in the theme,
so every declared value renders consistently across themes. `node backend/cli/wordjs.js doctor theme <slug>`
lints the block against the schema: unrecognized keys warn as `LAYOUT_UNKNOWN_KEY` (with a
did-you-mean suggestion) and invalid enum/type values as `LAYOUT_INVALID_VALUE`.

### Composable chrome (`chrome/*.json`)

Beyond the layout *variants* above, a theme (or the site itself) can compose the header/footer
from blocks. A composition is **Puck Data JSON** — `{ "root": { "props": {} }, "content": [ { "type", "props" } ] }` —
validated on the backend by `core/chrome-validate.ts` (contract v1, the write authority) and
rendered by the public SSR layout without mounting any editor runtime.

**Effective chrome precedence** (header and footer resolve independently; any invalid/unreadable
level falls through to the next — fail-closed, never a partial render):

1. **Site composition** — options `site_chrome_header` / `site_chrome_footer` (JSON strings),
   written only via `PUT /api/v1/chrome/:part` (admin; a 400 carries the validator's
   `errors: [{ code, path, message }]`) and cleared via `DELETE /api/v1/chrome/:part`. Both
   travel in the public `/api/v1/settings` payload.
2. **Theme composition** — `chrome/header.json` / `chrome/footer.json` inside the active theme,
   served statically at `/themes/<slug>/chrome/*.json`.
3. **Layout variant** — `theme.json` `layout` (v2, previous section).
4. **Default** — today's built-in chrome.

**Block allowlist (closed)** — a type outside it invalidates the whole composition. Props marked
`?` are optional; every block also accepts the editor's per-instance `id` string:

| Block | Props |
| --- | --- |
| `ChromeLogo` | `size?: "sm" \| "md" \| "lg"` |
| `ChromeSiteTitle` | `showTagline?: boolean` |
| `ChromeNav` | `location: "header" \| "footer"`, `orientation: "horizontal" \| "vertical"` |
| `ChromeSearch` | `placeholder?: string` |
| `ChromeSocials` | `source: "settings"` |
| `ChromeText` | `text: string` (plain text — always rendered escaped) |
| `ChromeButton` | `label: string`, `href: string`, `variant: "primary" \| "ghost"` |
| `ChromeSpacer` | `size: "sm" \| "md" \| "lg"` |
| `ChromeRow` | `items` (slot: array of blocks), `align: "start" \| "center" \| "end" \| "between"`, `gap: "sm" \| "md" \| "lg"`, `wrap?: boolean` |

**Budgets & security**: JSON ≤ **64KB**, ≤ **100 blocks**, nesting depth ≤ **3** (only via
`ChromeRow.items`); `ChromeButton.href` must be site-relative (`/…`, never `//`) or `http(s)://`
— `javascript:` and every other scheme are rejected. Blocks are presentational: data (menus,
logo, socials) is resolved by the renderer from already-fetched settings, never fetched by a
block. Styling rides the existing `.wjs-chrome-*` hook classes + `--wjs-*` tokens.

Minimal `chrome/header.json`:

```json
{
  "root": { "props": {} },
  "content": [
    { "type": "ChromeRow", "props": { "align": "between", "gap": "md", "items": [
      { "type": "ChromeLogo", "props": { "size": "md" } },
      { "type": "ChromeNav", "props": { "location": "header", "orientation": "horizontal" } }
    ] } }
  ]
}
```

`node backend/cli/wordjs.js doctor theme <slug>` validates shipped compositions: contract
violations are **errors** (`CHROME_INVALID`, with the offending block path); a file that cannot
be read or parsed is a **warning** (`CHROME_UNREADABLE`).

### Theme customizer (live `--wjs-*` overrides)

`/admin/themes/customize` lets an admin edit the active theme's `--wjs-*` tokens with a live `<iframe>`
preview. Saving stores the overrides as JSON in the `active_theme_mods` option (admin-gated write,
public read for SSR). `ThemeTokenOverlay.tsx` (a server component) SSR-injects them as a single
`<style id="wjs-theme-mods">:root{…}</style>` **after** the theme stylesheet, so overrides win at equal
specificity with no flash-of-unstyled-content. The overlay is **strictly sanitized** — only keys
matching `^--wjs-[a-z0-9-]+$` and values free of `;{}:<>` are emitted (no CSS injection). It renders
nothing when empty, and `switchTheme()` resets it, so changing themes starts from that theme's own look.

## CSS Variables Reference

The narrative reference (core tables, alias/editor-internal rules, per-block groups) lives in
[`theming.md`](./theming.md); the **complete machine-readable contract** is
`backend/public/theme-tokens.json`, regenerated from `wordjs-ui.css` with
`node scripts/generate-token-manifest.js`. The manifest currently tracks **717 tokens** and
**1664 `var()` uses** across 64 name groups — mostly per-block groups such as `cta` (55),
`pricing` (49), `card` (40), `accordion` (38), `form` (37), `hero` (37), `audio` (34), `tabs` and
`testimonial` (29 each), `search` (26), `button` (25).

### Core variables (defaults as declared in `wordjs-ui.css`)

```css
:root {
  /* Primary Brand Color */
  --wjs-color-primary: #2563eb;
  --wjs-color-primary-dark: #1e40af;

  /* Background Colors */
  --wjs-bg-canvas: #ffffff;        /* Page background */
  --wjs-bg-surface: #ffffff;       /* Card/panel background */
  --wjs-bg-muted: #f8f9fa;         /* Subtle fills: code, thead, inputs */

  /* Text Colors */
  --wjs-color-text-main: #1f2937;  /* Main text */
  --wjs-color-text-muted: #6b7280; /* Secondary text */

  /* Border */
  --wjs-border-subtle: #e5e7eb;
}
```

### Chrome (header/footer) tokens

The React chrome reads the **canonical** tokens (`--wjs-bg-surface`, `--wjs-color-heading`,
`--wjs-color-primary`, `--wjs-color-text-muted`, …) — there are no separate
`--wjs-nav-*`/`--wjs-logo-*` tokens. Four tokens are consumed *only* by the React chrome (no CSS
rule in `wordjs-ui.css` references them) and carry the `chrome-phantom` flag in the manifest:
`--wjs-bg-footer`, `--wjs-color-text-footer-main`, `--wjs-color-text-footer-dim`,
`--wjs-bg-surface-glass`. Themes may set them (footer surface/text, translucent header surface)
even though a CSS-only audit would report them unused.

### Two token families a theme must NOT declare

- **The 21 alias tokens** (flagged `alias` in the manifest): `--wjs-h{1..6}-size`,
  `--wjs-h{1..6}-weight`, `--wjs-font-family`, `--wjs-foreground`, `--wjs-color-text-heading`,
  `--wjs-color-text-dim`, `--wjs-color-primary-text`, `--wjs-bg-surface-hover`,
  `--wjs-border-radius`, `--wjs-space-md`, `--wjs-space-sm`. They remap the names used by the
  visual-editor block renderer onto the canonical tokens — override the **canonical** token
  (`--wjs-h1`, not `--wjs-h1-size`) and the alias follows automatically.
- **The 22 `--wjs-r-*` tokens** (flagged `editor-internal`): the visual editor's per-instance
  responsive channel (`--wjs-r-<prop>-{tb,mb}`), injected **inline** on each block by the editor.
  Declaring one in a theme `:root` would silently override every block instance on every page.

## Creating a Custom Theme

### 1. Scaffold with the CLI

```bash
node backend/cli/wordjs.js create theme my-custom-theme
```

This creates `backend/themes/my-custom-theme/` from the CLI template
(`backend/cli/templates/theme/`): a `style.css` whose `:root` is pre-filled with a 67-token
`--wjs-*` contract, plus a `theme.json`. Restart the backend once so the theme is discovered, then
activate it in **Admin → Themes**. (Creating the folder by hand still works — the CLI just writes
the boilerplate for you.)

Prefer generating instead of editing boilerplate? Pass the four seed colors
(`--primary --secondary --bg --text`, optionally `--archetype`) and the CLI writes a
**declarative `theme.json`** and compiles `style.css` from it — see
[Declarative theming (`theme.json`)](#declarative-theming-themejson) below.

At any point, lint your theme against the machine-readable contract with the doctor:

```bash
node backend/cli/wordjs.js doctor theme my-custom-theme
```

It flags unknown token names (with a closest-match suggestion), overrides of the 21 readonly
aliases, missing `--wjs-color-on-*` contrast pairs, external `@import`s/`url()`s, and `:root`
values that would not be portable to declarative tokens. Admins can also fetch the same report
from `GET /api/v1/themes/:slug/doctor`.

### 2. Edit style.css

```css
/* =========================================
   THEME: My Custom Theme
   ========================================= */

/* Avoid external @import (Google Fonts etc.) — the doctor flags it (EXTERNAL_REF): it adds a
   render-blocking third-party request on every page view. Ship font files with the theme (or use
   the framework's font tokens) instead. */

:root {
  /* Override variables here */
  --wjs-color-primary: #your-color;
  --wjs-bg-canvas: #your-bg;
  /* ... */
}

/* Visual Overrides */
body {
  background-color: var(--wjs-bg-canvas) !important;
  font-family: 'YourFont', sans-serif !important;
}

/* Header Customization */
header {
  background-color: var(--wjs-bg-surface) !important;
  /* Add your styles */
}

/* Component Overrides */
.wp-block-accordion {
  /* Your accordion styles */
}

.wp-block-search input {
  /* Your search input styles */
}
```

### 3. Edit theme.json (Optional)

```json
{
  "name": "My Custom Theme",
  "version": "1.0.0",
  "description": "A beautiful custom theme",
  "author": "Your Name"
}
```

### 4. Add a Screenshot (Optional)

Add a `screenshot.png` (400x300px recommended) for the theme picker.

## Declarative theming (`theme.json`)

Instead of hand-writing the whole `style.css`, a theme can describe itself **declaratively** in
`theme.json` and have WordJS compile the CSS. The compiler is
`backend/src/core/theme-compile.ts` (`compileTheme()`), driven by:

```bash
# create a theme from four seed colors (writes theme.json + compiled style.css + functions.js stub)
node backend/cli/wordjs.js create theme neon-shop \
  --primary "#7c3aed" --secondary "#0ea5e9" --bg "#0b1020" --text "#e5e7eb" \
  --archetype cyber --name "Neon Shop"

# after editing theme.json, recompile style.css in place
node backend/cli/wordjs.js build theme neon-shop
```

Admins can do the same over the API: `POST /api/v1/themes` (create) and `PUT /api/v1/themes/:slug`
(rebuild) in `backend/src/routes/themes.ts`, both `authenticate` + `isAdmin`.

All declarative keys are **optional and additive** to the existing `name` / `version` /
`description` / `author` / `layout` keys — a `theme.json` without them keeps working exactly as
before.

### `generator: "wordjs"`

The writer's mark. Every **declarative** `theme.json` written by WordJS carries it (the CLI's
seeded `create theme` and the API's `POST /api/v1/themes` both stamp it; the plain template
scaffold does not). `PUT /api/v1/themes/:slug` refuses to rebuild themes that lack it, so
hand-crafted themes can never be overwritten through the API. The `build theme` CLI command
compiles any `theme.json` that has declarative keys.

### `seeds` — four colors → the whole palette

```json
"seeds": { "primary": "#7c3aed", "secondary": "#0ea5e9", "bg": "#0b1020", "text": "#e5e7eb" }
```

Each seed must be a strict `#rrggbb` hex. `theme-derive.ts` (`deriveTokens()`) expands them into
the 17-token canonical palette emitted into `:root` — the same derivation the first-party theme
generator uses: `--wjs-bg-canvas`, `--wjs-bg-surface`, `--wjs-bg-surface-raised`,
`--wjs-color-primary`, `--wjs-color-primary-dark`, `--wjs-color-on-primary`,
`--wjs-color-accent`, `--wjs-color-on-accent`, `--wjs-color-text-main`,
`--wjs-color-text-muted`, `--wjs-color-heading`, `--wjs-color-link`, `--wjs-color-link-hover`,
`--wjs-border-subtle`, `--wjs-outline`, `--wjs-outline-variant`, `--wjs-focus-ring`.
Surfaces mix toward white on dark canvases (luminance of `bg` < 0.35) and toward black on light
ones; the `on-*` colors are picked for contrast against their base color.

### `archetype` — personality preset

```json
"archetype": "cyber"
```

One of `cyber`, `brutalist`, `editorial`, `glassmorphism`, `organic`, `obsidian`. Appends the
preset's CSS (interpolating your seeds) inside the generated block. Presets contain **no external
`@import`** — font stacks lead with the intended family and fall back to system fonts; the
compiler additionally strips any `@import` structurally. An unknown name is an error with a
closest-match suggestion.

### `tokens` — explicit token overrides

```json
"tokens": { "--wjs-hero-radius": "18px", "--wjs-button-weight": "700" }
```

A flat map. The name must exist in the token manifest (`backend/public/theme-tokens.json`,
738 tokens) — or be one of the documented `--wjs-footer-*` chrome-bridge tokens, which are valid
even before the manifest learns them. Editor-internal `--wjs-r-*` tokens are rejected. Values
follow the portable token rules: non-empty, ≤ 120 chars, charset `#a-zA-Z0-9 ,.%()/_'"-`
(spaces allowed), no backslash, no `//`, no `url()`.

### `styles` — nested element styling

Top-level keys are **themable elements**: every entry of the manifest's `elements` registry
(33 block elements — `hero`, `card`, `button`, `nav`, `footer`, `posts-grid`, … each with a
`selector` and optional `children`) plus three globals: `body` (selector `body`), `headings`
(`h1,h2,h3,h4,h5,h6`) and `links` (`a`). Inside an element you can nest:

- **CSS properties** — `"background": "#0f172a"`, `"letter-spacing": "0.08em"`, …
- **children** — one level, from the element's `children` in the manifest
  (e.g. `hero` → `title`, `subtitle`, `button`, `actions`, `inner`, `overlay`)
- **states** — `hover`, `focus`, `active`, `disabled` (cannot nest inside another state)
- **breakpoints** — `mobile`, `tablet`, `desktop` (cannot nest inside states or other
  breakpoints; states *can* nest inside breakpoints and children)

The framework's breakpoints are fixed:

| Key | Media query |
| :-- | :-- |
| `mobile` | `@media (max-width: 767.98px)` |
| `tablet` | `@media (min-width: 768px) and (max-width: 1023.98px)` |
| `desktop` | `@media (min-width: 1024px)` |

#### Token-vs-declaration resolution

For each property at the base level (not inside a state or breakpoint) the compiler builds
token-name candidates — `--wjs-<element>-<child>-<prop>` then `--wjs-<element>-<prop>` — from the
key **as written**. If a candidate exists in the manifest, the value is emitted as that **token**
in `:root` (token value rules above). That is why the short manifest suffixes work as keys:
`styles.hero.bg` → `--wjs-hero-bg`, `styles.hero.button.bg` → `--wjs-hero-button-bg`.

Otherwise the key must be a **standard CSS property**, and the pair is emitted as a **declaration**
on the element's mapped selector, validated with css-tree: the property must be known standard
CSS, the value must parse *and* match the property's grammar, and the output is re-serialized
from the parsed AST — the raw string from `theme.json` never reaches `style.css`, so
`red;} body{...}`-style injection cannot survive. `url()` is allowed **only** for the theme's own
assets (`/themes/<slug>/…`); `@import` and author-written selectors cannot be expressed at all.
Inside states and breakpoints everything is a declaration — `styles.hero.button.hover.background`
becomes `.wp-block-hero__button:hover { background: … }` even though a `bg` token exists for the
base level.

#### Caps

- ≤ **2,000** compiled declarations in total (`:root` tokens count toward it)
- declaration values ≤ **300** chars, token values ≤ **120** chars
- `theme.json` ≤ **256 KB**

### The generated block and manual CSS

The compiled CSS lives in `style.css` between exact markers:

```css
/* @wjs-generated:start — compiled from theme.json; DO NOT EDIT inside. Edit theme.json and run: node backend/cli/wordjs.js build theme <slug> */
...
/* @wjs-generated:end */
```

Recompiling replaces **only** that block (or prepends it, with a warning, when `style.css` has no
markers yet) — every byte outside the markers is preserved, so declarative theming and manual CSS
coexist in the same file. `build theme` prints every diagnostic (errors and warnings carry a code,
a `theme.json` path and, where possible, a closest-match suggestion) and **exits 1 without
writing anything** if there are errors.

### Example: minimal seeded theme

```json
{
  "name": "Neon Shop",
  "version": "1.0.0",
  "description": "A dark neon storefront theme.",
  "author": "You",
  "generator": "wordjs",
  "seeds": { "primary": "#7c3aed", "secondary": "#0ea5e9", "bg": "#0b1020", "text": "#e5e7eb" }
}
```

### Example: tokens + nested styles with children, states and breakpoints

```json
{
  "name": "Neon Shop",
  "version": "1.0.0",
  "generator": "wordjs",
  "seeds": { "primary": "#7c3aed", "secondary": "#0ea5e9", "bg": "#0b1020", "text": "#e5e7eb" },
  "archetype": "cyber",
  "tokens": { "--wjs-hero-radius": "18px" },
  "styles": {
    "hero": {
      "bg": "#11162a",
      "button": {
        "bg": "#7c3aed",
        "letter-spacing": "0.08em",
        "hover": { "background": "#0ea5e9", "transform": "translateY(-2px)" }
      }
    },
    "body": {
      "mobile": { "font-size": "15px" }
    }
  }
}
```

Compiled, that emits `--wjs-hero-radius`, `--wjs-hero-bg` and `--wjs-hero-button-bg` as `:root`
tokens; `letter-spacing` (no token candidate) as a declaration on `.wp-block-hero__button`; the
`hover` block as `.wp-block-hero__button:hover { background: #0ea5e9; transform: translateY(-2px) }`;
and the `body.mobile` block inside `@media (max-width: 767.98px)`.

## Installing a Theme

Building a theme by hand isn't the only way to add one. The **`default`** theme ships bundled in
`backend/themes/`; the other 64 first-party themes are
distributed through the **theme marketplace** and installed on demand. WordJS ships two admin-only
install paths — both land the theme in the same `backend/themes/{slug}/` layout described above.

### From the theme marketplace

In **Admin → Themes** the page has **Installed | Marketplace** tabs; the Marketplace tab lists the
first-party catalog and installs a theme in one click. The frontend `themesMarketplaceApi`
(`frontend/src/lib/api.ts`) drives the theme-catalog routes in `backend/src/routes/marketplace.ts` —
`GET /marketplace/themes/catalog` (browse) and `POST /marketplace/themes/install` (fetch, verify, then
unpack via `installThemeFromZip()`), both admin-gated. The catalog origin is admin-configurable and
independent of the plugin marketplace via `GET`/`PUT /marketplace/themes/sources` (backed by the
`marketplace_theme_sources` option).

> **The first-party catalog is declarative.** Every generated theme in `marketplace/themes/` now
> ships the hybrid declarative format: a `theme.json` with `generator: "wordjs"` plus `seeds`/
> `archetype`, and a `style.css` whose manual section (header + font `@import`s) sits above the
> compiled `@wjs-generated` block. New marketplace themes must follow the same declarative
> `theme.json` contract; hand-authored themes still work everywhere else, but the doctor flags
> them with an informational `LEGACY_THEME` finding to encourage migration.

### From a ZIP upload

You can also upload a packaged theme ZIP directly. **Admin → Themes** exposes an upload control backed
by `POST /themes/upload` (`backend/src/routes/themes.ts`, `authenticate` + `isAdmin`); the archive is
validated by the shared **zip-guard** (`assertZipWithinBudget` — rejects decompression bombs and
path-traversal entries) before it is extracted into `backend/themes/{slug}/`.

### Exporting a theme

Any installed theme can be packaged back into a ZIP for backup or transfer via
**Admin → Themes → Download** (`GET /themes/:slug/download` → `createThemeZip()` in
`backend/src/core/themes.ts`).

## Activating a Theme

1. Go to **Admin → Themes**
2. Click **Activate** on the desired theme
3. The frontend picks up the new theme on the next load (or when you refocus the public tab)

Under the hood, activation calls `switchTheme()` in `backend/src/core/themes.ts`, which writes
the `template` and `stylesheet` options, publishes the new theme's `theme.json` `layout` to the
`active_theme_layout` option, clears any customizer overrides (`active_theme_mods`), and
re-initializes the (legacy) theme engine. On the
public site, `frontend/src/components/public/ThemeLoader.tsx` receives the active-theme slug **and
version** resolved on the **server** (`app/(public)/layout.tsx` → `getSettings()` → `template` +
`active_theme_version`) as `initialSlug` / `initialThemeVersion`, so the first
SSR paint already carries the right stylesheet. It renders
`<link rel="stylesheet" href="/themes/{slug}/style.css?v={slug}-{themeVersion}-{ASSET_VERSION}">` (id
`wjs-theme-stylesheet`) with a React 19 **`precedence`** attribute — required so React hoists the
link into `<head>` and treats it as render-blocking; without it the page painted with fallback token
values and only restyled once the CSS finished loading (a flash of unthemed content). The framework
link (`wjs-ui-framework`) is declared in an earlier precedence group, so the theme's `:root` still
cascades after it.

**No per-visitor theme query.** The loader used to re-fetch `themesApi.list()` on every `window`
`focus` — an unauthenticated request per visitor per focus, running a themes-dir scan on the server.
It doesn't any more: switching or editing a theme purges the `settings` tag
(`backend/src/core/frontend-purge.ts`), so the next navigation serves HTML with the new slug/version.
An already-open public tab keeps the theme it was rendered with until it navigates. The only client
resolve left is the Puck editor preview, which reuses the public shell without server props and reads
`GET /api/v1/settings` **once** (cheap, cached, no fs). When the href does change at runtime the
loader still removes the previous `<link>` — matched on the exact href, so a version-only change
evicts it too (React treats `precedence` stylesheets as add-only, so the stale stylesheet would
otherwise stay applied alongside the new one).

The `?v=` query string is the **theme slug**, the theme's **`theme.json` version** and
**`ASSET_VERSION`**, built by `themeStylesheetHref()` in `frontend/src/lib/assetVersion.ts` — a
deterministic value identical across SSR and hydration (the version always comes from the server,
never recomputed on the client). Theme CSS and `wordjs-ui.css` are served with a long `Cache-Control`
(~1 day), so both parts matter: the theme version busts an **in-place theme edit**
(`PUT /api/v1/themes/:slug` bumps the patch — a change no build can see), and `ASSET_VERSION` busts a
**release** that changes `wordjs-ui.css`. `ASSET_VERSION` is no longer hand-maintained: it is the
sha256 of `backend/public/css/wordjs-ui.css`, generated into the committed
`frontend/src/lib/assetVersion.generated.ts` by `scripts/generate-asset-version.js` (run in the
frontend `prebuild`, diff-gated in CI). Nothing to bump — edit the CSS and the token follows.

## Theme Previews in Admin

WordJS provides live previews of components (like the Footer) within the Admin panel. To ensure your theme renders correctly in these isolated previews:

1.  **Scope Injection:** The system automatically scopes your CSS by replacing `:root` and `body` selectors with a unique ID (e.g., `#preview-theme-scope`).
2.  **Avoid Global Assumptions:** Do not rely on `html` or `window` properties for styling. Rely on CSS variables defined in your `style.css`.

## Component Styling Best Practices

### Use CSS Variables

Always reference CSS variables for consistent theming:

```css
/* ✅ Good */
.my-component {
  background: var(--wjs-bg-surface);
  color: var(--wjs-color-text-main);
}

/* ❌ Avoid */
.my-component {
  background: #f9fafb;
  color: #111827;
}
```

### Override with `!important` Sparingly

Use `!important` only when necessary to ensure your theme overrides core styles:

```css
header {
  background-color: var(--wjs-bg-canvas) !important;
}
```

### Containment Rules

All Puck components have built-in overflow containment (shipped in the framework `backend/public/css/wordjs-ui.css`, which contains wide content — tables/`pre` scroll in their own container, long strings wrap — at every width):

```css
/* Already defined in wordjs-ui.css */
[class*="wp-block-"] {
  overflow: hidden;
  max-width: 100%;
}
```

## Dark Mode Considerations

For dark themes, invert the color semantics:

```css
:root {
  --wjs-bg-canvas: #0a0a0a;           /* Dark background */
  --wjs-bg-surface: #1a1a1a;          /* Slightly lighter */
  --wjs-color-text-main: #f5f5f5;     /* Light text */
  --wjs-color-text-muted: #a3a3a3;    /* Dimmed text */
  --wjs-border-subtle: #2a2a2a;       /* Subtle borders */
}
```

## Troubleshooting

### Theme Not Loading

1. Check that `style.css` exists in the theme folder
2. Verify the theme is activated in Admin → Themes
3. Clear browser cache (Ctrl+Shift+R)

### Styles Not Applying

1. Increase specificity or use `!important`
2. Check for CSS syntax errors
3. Verify CSS variable names are correct

### Videos/Images Overflow

All media should be constrained by the containment rules in the framework (`wordjs-ui.css`). If not:

```css
img, iframe, video {
  max-width: 100%;
  height: auto;
}
```
