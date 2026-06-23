# Theming & the WordJS UI framework

WordJS themes share a single, token-driven CSS framework — **WordJS UI** — that styles every standard
HTML element and ships Bootstrap-like components and utilities. A theme customizes the whole framework
just by declaring **design tokens** (`--wjs-*` CSS custom properties) in its own stylesheet.

## How it fits together

```
public page / editor preview
  └─ <link href="/public/css/wordjs-ui.css">     ← the framework (base elements + components + utilities)
  └─ <link href="/themes/<slug>/style.css">       ← the theme: its :root tokens + any custom rules
```

- **`backend/public/css/wordjs-ui.css`** is one static stylesheet, shared by every theme. Every value it
  uses is `var(--wjs-*, <fallback>)`, so it works standalone and adapts to whatever tokens a theme sets.
- The **theme stylesheet loads after** the framework, so a theme's `:root` tokens override the framework
  defaults, and a theme's own rules override component styles at equal specificity.
- It is loaded **only on public pages and the editor preview** (never the admin UI). Selectors are
  intentionally low-specificity (bare elements / single classes), so themed chrome built with utility
  classes keeps winning, and in practice the framework styles raw content HTML and offers opt-in classes.
- WYSIWYG: the page editor injects the same framework + active-theme stylesheet into its preview iframe,
  so the canvas matches the live site.

## Design tokens (`--wjs-*`)

Declare these in your theme's `themes/<slug>/style.css` under `:root`. Anything you omit falls back to
the framework default shown below.

### Colors
| Token | Default | Purpose |
|---|---|---|
| `--wjs-color-primary` | `#2563eb` | Brand / primary actions, links |
| `--wjs-color-primary-dark` | `#1e40af` | Hover/active of primary |
| `--wjs-color-secondary` | `#6b7280` | Secondary actions |
| `--wjs-color-secondary-dark` | `#4b5563` | Hover/active of secondary |
| `--wjs-color-accent` | `#7c3aed` | Accent highlights |
| `--wjs-color-success` | `#16a34a` | Success states |
| `--wjs-color-danger` | `#dc2626` | Errors / destructive |
| `--wjs-color-warning` | `#f59e0b` | Warnings |
| `--wjs-color-info` | `#0ea5e9` | Informational |
| `--wjs-color-light` | `#f8f9fa` | Light surface |
| `--wjs-color-dark` | `#1f2937` | Dark surface |

Each solid color also has a paired **`--wjs-color-on-{name}`** token — the text color used *on* that
color (buttons, badges, active states). These are precomputed for maximum contrast (black or white) per
theme, so a `.btn-primary` stays readable whether the theme's primary is navy or neon green. Override one
only if you want a specific on-color.

### Surfaces, text & borders
| Token | Default | Purpose |
|---|---|---|
| `--wjs-bg-canvas` | `#ffffff` | Page background |
| `--wjs-bg-surface` | `#ffffff` | Cards / panels / list groups |
| `--wjs-bg-muted` | `#f8f9fa` | Subtle fills: code, `thead`, inputs |
| `--wjs-color-text-main` | `#1f2937` | Body text |
| `--wjs-color-text-muted` | `#6b7280` | Secondary text / captions |
| `--wjs-color-heading` | `text-main` | Heading color |
| `--wjs-color-link` | `primary` | Links |
| `--wjs-color-link-hover` | `primary-dark` | Link hover |
| `--wjs-border-subtle` | `#e5e7eb` | Borders / dividers |
| `--wjs-border-width` | `1px` | Border width |
| `--wjs-focus-ring` | `rgba(37,99,235,.35)` | Focus glow |

### Typography
`--wjs-font-family-base`, `--wjs-font-family-heading`, `--wjs-font-family-mono`,
`--wjs-font-size-base` (`1rem`), `--wjs-line-height-base` (`1.6`), `--wjs-heading-weight` (`700`),
`--wjs-heading-line-height` (`1.2`), and the heading scale `--wjs-h1`…`--wjs-h6` (`2.5rem` → `1rem`).

### Spacing & shape
`--wjs-spacer` (`1rem`, the base unit for every spacing utility), `--wjs-radius-sm`/`--wjs-radius`/
`--wjs-radius-md`/`--wjs-radius-lg`/`--wjs-radius-pill`, and `--wjs-shadow-sm`/`--wjs-shadow`/
`--wjs-shadow-md`/`--wjs-shadow-lg`.

### Minimal theme example

```css
/* themes/my-theme/style.css */
:root {
  --wjs-color-primary: #e11d48;
  --wjs-bg-canvas: #fffaf5;
  --wjs-color-text-main: #1c1917;
  --wjs-font-family-base: "Georgia", serif;
  --wjs-radius: 0;            /* sharp corners everywhere */
}
/* …plus any custom rules; they win over the framework since they load after it. */
```

That single token block re-skins headings, links, buttons, cards, tables, forms, alerts, badges, the
grid and every utility — no other CSS required.

## What the framework styles

**Every HTML element** (auto-styled, no classes needed): headings, paragraphs, links, lists (`ul/ol/dl`),
`blockquote`, `hr`, `table`, `img`/`figure`/`figcaption`, `code`/`pre`/`kbd`, form controls
(`input`/`textarea`/`select`/`button`), `mark`, `abbr`, `sub`/`sup`, and more.

## Components (opt-in classes)

Bootstrap-compatible names:

- **Buttons** — `.btn` + `.btn-primary|secondary|success|danger|warning|info|light|dark`,
  `.btn-outline-*`, `.btn-sm|lg`, `.btn-link`, `.btn-group`.
- **Forms** — `.form-control`, `.form-select`, `.form-label`, `.form-text`, `.form-check`(+`-input`/
  `-label`), `.form-range`, `.input-group`(+`-text`), validation `.is-valid`/`.is-invalid`(+feedback).
- **Card** — `.card`, `.card-body|header|footer|title|subtitle|text|img-top`.
- **Alert** — `.alert` + `.alert-*`, `.alert-heading`, `.alert-link`, `.alert-dismissible`.
- **Badge** — `.badge` + `.badge-*`, `.rounded-pill`.
- **Navigation** — `.nav`/`.nav-link`, `.nav-tabs`, `.nav-pills`, `.navbar`/`.navbar-brand`/`.navbar-nav`,
  `.breadcrumb`/`.breadcrumb-item`, `.pagination`/`.page-item`/`.page-link`.
- **List group** — `.list-group`/`.list-group-item`(+`-action`/`.active`/`.disabled`).
- **Feedback** — `.progress`/`.progress-bar`(+`-striped`), `.spinner-border`(+`-sm`).
- **Overlays** — `.modal`(+`-dialog`/`-content`/`-header`/`-body`/`-footer`/`-backdrop`),
  `.dropdown`/`.dropdown-menu`/`.dropdown-item`, `.btn-close`. (Toggle `.show` from your own JS.)
- **Accordion** — CSS-only via `<details class="accordion-item"><summary>…`.

## Utilities

- **Spacing** — `.m{t,b,s,e,x,y}-{0..5}`, `.p{...}-{0..5}`, `.m-auto`, `.gap-{0..5}` (scale = 0, .25, .5,
  1, 1.5, 3 × `--wjs-spacer`).
- **Layout** — `.container`(`-sm|md|lg|xl|fluid`), `.row`, `.col`, `.col-{1..12}`, responsive
  `.col-{sm,md,lg,xl}-*`, `.g-{0..5}`, `.ratio`(`-16x9` etc.).
- **Display/flex** — `.d-{none,block,flex,inline-flex,grid,…}` (+ `-md-*`/`-lg-*`), `.flex-*`,
  `.justify-content-*`, `.align-items-*`, `.align-self-*`.
- **Text** — `.text-{start,center,end}`, `.text-{uppercase,lowercase,capitalize}`, `.fw-{light…bold}`,
  `.fst-italic`, `.text-truncate`, `.lh-*`, `.fs-{1..6}`, `.font-monospace`.
- **Color** — `.text-*` / `.bg-*` (primary, secondary, success, danger, warning, info, light, dark,
  body, muted, white, …).
- **Borders/shape** — `.border`(+sides/colors), `.rounded`(`-0|sm|lg|circle|pill|top|bottom`).
- **Sizing** — `.w-{25,50,75,100,auto}`, `.h-*`, `.mw-100`, `.vh-100`, `.min-vh-100`.
- **Misc** — `.shadow{,-sm,-lg,-none}`, `.position-*`, `.overflow-*`, `.opacity-*`, `.float-*`,
  `.visually-hidden`, `.img-fluid`, `.img-thumbnail`, `.clearfix`.

## Long-form content

Wrap a post/page body in `class="wjs-content"` for tuned vertical rhythm (heading spacing, rounded media,
paragraph/table spacing) on top of the bare-element styles.

## Reference

The framework source (with section comments) is `backend/public/css/wordjs-ui.css`. Existing themes under
`backend/themes/*/style.css` show real token sets for light, dark, mono, glass and brutalist looks.
