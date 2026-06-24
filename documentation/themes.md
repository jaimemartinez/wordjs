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
> overrides (see "Theme integration with the live site" below). So for the live site `style.css` +
> `theme.json` matter; `templates/`/`partials/`/`functions.js` belong only to the legacy engine.
>
> Theme metadata is parsed from `theme.json` by `parseThemeMetadata()`; missing fields fall
> back to defaults (name = slug, version = `1.0.0`). A `screenshot.{png,jpg,webp}`, if present,
> is auto-detected and exposed in the theme picker.

> **`functions.js` is sandboxed.** A theme's optional `functions.js` is *not* trusted code. When
> the backend theme engine loads it (`loadThemeLogic()` in `backend/src/core/theme-engine.ts`)
> it first runs the same install-time **AST static scanner** as plugins
> (`validatePluginPermissions`, which fails closed and blocks `eval`/`Function`, `exec`/`spawn`,
> `require()`/`import()` of sensitive builtins such as `child_process`, etc.). It then executes
> the logic **in-process** inside an AsyncLocalStorage security context under the slug
> `theme:<slug>` (`runWithContext`), which activates the runtime guards in `secure-require.ts`:
> dangerous Node builtins are blocked and `fs`/`require` access is confined to the theme's own
> directory (reads of `.env`/secret files and the database are denied). By default a theme is
> granted only `settings:read` + `content:read`; a theme that needs more must ship a
> `manifest.json`. This is the lighter in-process guard model — distinct from the full OS-process
> isolation (`child_process.fork`) used for plugins marked `"isolated": true`. If the AST scan
> trips, the theme's `functions.js` is blocked and the rest of the theme still loads.

## Available Themes

There are **14 shipped themes**:

| Theme               | Aesthetic          | Key Features                                |
| ------------------- | ------------------ | ------------------------------------------- |
| **default**         | Clean, Modern      | Blue primary, white background              |
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
| **vidaParaTodos**   | Corporate          | Clean professional blue                     |

> **`--wjs-` variable adoption.** All 14 themes ship the full `--wjs-*` token set documented below (dozens
> of declarations each — e.g. `carbon-terminal` has 71, `default` 53 — including the `--wjs-color-on-*`
> contrast set). The **default** theme additionally keeps a few older bare aliases (`--primary`,
> `--primary-dark`, `--text`, `--text-muted`, `--bg`, `--border`) at the top of its `:root` for its legacy
> rules, but it carries the complete `--wjs-*` set too. Copy any theme as a starting point.

## The WordJS UI Framework

Beyond a theme's own `style.css`, WordJS ships **one shared, token-driven CSS framework** —
`backend/public/css/wordjs-ui.css` (served at `/public/css/wordjs-ui.css`). It is the
"Bootstrap-like" base that every theme builds on:

- **Auto-styles every standard HTML element** (typography, forms, tables, lists, etc.).
- **Bootstrap-compatible components**: `.btn`/`.card`/`.alert`/`.badge`/`.table`/`.nav`/
  `.list-group`/`.pagination`/`.progress`/`.modal`/`.dropdown`, plus a flexbox grid
  (`.container`/`.row`/`.col-*`).
- **A utility layer**: spacing, display, flexbox, text, colors, borders, sizing, and shadow helpers.

Everything in the framework is driven by the same `--wjs-*` design tokens documented below, each with
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

All 14 bundled themes ship a complete `--wjs-*` token set tuned to their palette. For the full token +
class reference, see [`documentation/theming.md`](./theming.md).

## Theme integration with the live site

The active theme drives the **entire** live (Next.js) site — not just raw content — through four seams,
all of which default to today's look so the 14 existing themes render unchanged:

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
   Omitting the block (all 14 shipped themes) keeps the current single-column, default-width layout.

### Theme customizer (live `--wjs-*` overrides)

`/admin/themes/customize` lets an admin edit the active theme's `--wjs-*` tokens with a live `<iframe>`
preview. Saving stores the overrides as JSON in the `active_theme_mods` option (admin-gated write,
public read for SSR). `ThemeTokenOverlay.tsx` (a server component) SSR-injects them as a single
`<style id="wjs-theme-mods">:root{…}</style>` **after** the theme stylesheet, so overrides win at equal
specificity with no flash-of-unstyled-content. The overlay is **strictly sanitized** — only keys
matching `^--wjs-[a-z0-9-]+$` and values free of `;{}:<>` are emitted (no CSS injection). It renders
nothing when empty, and `switchTheme()` resets it, so changing themes starts from that theme's own look.

## CSS Variables Reference

### Core Color Variables

```css
:root {
  /* Primary Brand Color */
  --wjs-color-primary: #2563eb;
  --wjs-color-primary-dark: #1d4ed8;

  /* Background Colors */
  --wjs-bg-canvas: #ffffff;        /* Page background */
  --wjs-bg-surface: #f9fafb;       /* Card/panel background */

  /* Text Colors */
  --wjs-color-text-main: #111827;  /* Main text */
  --wjs-color-text-muted: #6b7280; /* Secondary text */

  /* Border */
  --wjs-border-subtle: #e5e7eb;
}
```

### Navigation Variables

```css
:root {
  --wjs-nav-font-family: 'Inter', sans-serif;
  --wjs-nav-font-size: 0.875rem;
  --wjs-nav-font-weight: 500;
  --wjs-nav-text-transform: none;      /* or 'uppercase' */
  --wjs-nav-letter-spacing: normal;    /* or '0.1em' */
  
  --wjs-nav-color: #6b7280;            /* Default link color */
  --wjs-nav-color-hover: #111827;      /* Hover color */
  --wjs-nav-transition: color 200ms ease;
  
  --wjs-logo-color: #111827;
}
```

### Footer Variables

```css
:root {
  --wjs-footer-bg: #111827;
  --wjs-footer-text-heading: #ffffff;
  --wjs-footer-text-body: #9ca3af;
  --wjs-footer-text-hover: #ffffff;
  --wjs-footer-icon-bg: #1f2937;
  --wjs-footer-icon-color: #ffffff;
}
```

### Puck Component Variables

```css
:root {
  /* Accordion */
  --puck-accordion-bg: var(--wjs-bg-surface);
  --puck-accordion-border: var(--wjs-border-subtle);
  --puck-accordion-header-bg: var(--wjs-bg-surface);
  
  /* Tabs */
  --puck-tabs-border: var(--wjs-border-subtle);
  --puck-tabs-active-color: var(--wjs-color-primary);
  
  /* Pricing */
  --puck-pricing-bg: var(--wjs-bg-surface);
  --puck-pricing-highlight-bg: var(--wjs-color-primary);
  
  /* Search */
  --puck-search-input-bg: var(--wjs-bg-surface);
  --puck-search-input-border: var(--wjs-border-subtle);
  --puck-search-btn-bg: var(--wjs-color-primary);
}
```

## Creating a Custom Theme

### 1. Create the Theme Folder

```bash
mkdir backend/themes/my-custom-theme
```

### 2. Create style.css

```css
/* =========================================
   THEME: My Custom Theme
   ========================================= */

@import url('https://fonts.googleapis.com/css2?family=YourFont:wght@400;700&display=swap');

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

### 3. Create theme.json (Optional)

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

## Activating a Theme

1. Go to **Admin → Themes**
2. Click **Activate** on the desired theme
3. The frontend picks up the new theme on the next load (or when you refocus the public tab)

Under the hood, activation calls `switchTheme()` in `backend/src/core/themes.ts`, which writes
the `template` and `stylesheet` options, publishes the new theme's `theme.json` `layout` to the
`active_theme_layout` option, clears any customizer overrides (`active_theme_mods`), and
re-initializes the (legacy) theme engine. On the
public site, `frontend/src/components/public/ThemeLoader.tsx` polls `themesApi.list()`, finds the
active theme, and injects `<link rel="stylesheet" href="/themes/{slug}/style.css?v=…">`
(id `wjs-theme-stylesheet`). It re-checks on `window` `focus`, so switching the theme in one tab
applies in an open public tab when you return to it. The `?v=` query string is a **stable**
cache-buster (the theme's `version`, falling back to its `slug`) — deliberately deterministic, not
`Date.now()`, so the href is identical across SSR and hydration; it busts the cache only when the
theme's version or slug changes.

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

All Puck components have built-in overflow containment:

```css
/* Already defined in core.css */
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

All media should be constrained by the containment rules in `core.css`. If not:

```css
img, iframe, video {
  max-width: 100%;
  height: auto;
}
```
