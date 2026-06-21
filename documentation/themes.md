# WordJS Themes Documentation

WordJS uses a **CSS Variable-based theming system** that allows complete visual customization without code changes.

## Theme Structure

Each theme is located in `backend/themes/{theme-slug}/`. A theme can be as simple as a single `style.css`, or include the full server-side template set:

```
themes/
├── my-theme/
│   ├── style.css         # Main stylesheet (the file the Next.js frontend loads)
│   ├── theme.json        # Optional: Theme metadata (name, version, description, author)
│   ├── functions.js      # Optional: Theme logic/hooks, loaded by the backend theme engine
│   ├── templates/        # Optional: Handlebars page templates (index.html, single.html, archive.html)
│   ├── partials/         # Optional: Shared Handlebars partials (header.html, footer.html)
│   └── screenshot.png    # Optional: Theme preview (also .jpg/.webp); none shipped today
```

> **Two rendering paths.** WordJS ships *both* a backend Handlebars template engine
> (`backend/src/core/themes.ts` + `theme-engine`, which consumes `templates/`, `partials/`,
> and `functions.js`) **and** the React/Puck public site under `frontend/src/app/(public)/`.
> The Next.js public site is the primary renderer; it does **not** use a theme's Handlebars
> templates. What it *does* consume is the active theme's **`style.css`**, injected as a
> `<link>` tag by `ThemeLoader` (see "Activating a Theme" below). So for styling the live
> Next.js site, only `style.css` (and its CSS variables) matters; `templates/`/`partials/`/
> `functions.js` belong to the backend template engine.
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
| **vidaParaTodos**   | Corporate          | Clean professional blue; full template set  |

> **`--wjs-` variable adoption.** All themes except **default** are built on the `--wjs-*`
> variable system documented below (each defines dozens of `--wjs-` declarations). The **default**
> theme predates that convention and uses a smaller, legacy set (`--primary`, `--text`, `--bg`,
> `--border`, …) — copy a `--wjs-` theme (e.g. `aurora-gradient`) as a starting point rather
> than `default` if you want full variable coverage.

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
  --puck-accordion-header-bg: transparent;
  
  /* Tabs */
  --puck-tabs-border: var(--wjs-border-subtle);
  --puck-tabs-active-color: var(--wjs-color-primary);
  
  /* Pricing */
  --puck-pricing-bg: var(--wjs-bg-surface);
  --puck-pricing-featured-bg: var(--wjs-color-primary);
  
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
the `template` and `stylesheet` options and re-initializes the backend theme engine. On the
public site, `frontend/src/components/public/ThemeLoader.tsx` polls `themesApi.list()`, finds the
active theme, and injects `<link rel="stylesheet" href="/themes/{slug}/style.css?v=…">`
(id `wjs-theme-stylesheet`). It re-checks on `window` `focus`, so switching the theme in one tab
applies in an open public tab when you return to it. A cache-buster query string forces a fresh
stylesheet fetch.

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
