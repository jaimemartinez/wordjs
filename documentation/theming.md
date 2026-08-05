# Theming & the WordJS UI framework

WordJS themes share a single, token-driven CSS framework — **WordJS UI** — that styles every standard
HTML element and ships Bootstrap-like components and utilities. A theme customizes the framework
primarily by declaring **design tokens** (`--wjs-*` CSS custom properties) in its own stylesheet,
plus its own CSS for whatever the tokens don't parameterize (see *What tokens cover today* below).

> **Declarative alternative:** instead of hand-writing the token block, a theme can declare
> `seeds` / `archetype` / `tokens` / `styles` in its `theme.json` and have WordJS compile the
> `style.css` block (`node backend/cli/wordjs.js build theme <slug>`). The full contract is
> documented in **[themes.md — Declarative theming (`theme.json`)](themes.md#declarative-theming-themejson)**.
> The compiler is stricter than plain CSS about what it will emit: token values use a portable
> charset that has no `+` and no `*` (so `calc()` with addition or multiplication cannot live in a
> token) and must have every parenthesis and quote **balanced** (an unclosed one would swallow the
> rest of the stylesheet into the value, so it is refused as `TOKEN_VALUE_INVALID`), and `styles`
> declaration values cannot contain `var()` (they are matched against the property's grammar,
> which `var()` defeats). The compiler additionally *warns* (`TOKEN_VALUE_GRAMMAR`) when a token
> value matches no grammar of any property the manifest lists as consuming that token — a
> best-effort check with deliberately partial coverage, described in
> [themes.md](themes.md#is-the-token-value-valid-for-the-properties-that-read-it). Hand-written CSS
> outside the generated block — the rest of this page — has none of these limits.

## How it fits together

```
public page / editor preview
  └─ <link href="/public/css/wordjs-ui.css?v=…">      ← the framework (base elements + components + utilities)
  └─ <link href="/themes/<slug>/style.css?v=…">       ← the theme: its :root tokens + any custom rules
  └─ <style id="wjs-theme-mods">:root{…}</style>      ← optional admin customizer overrides (last, wins)
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
- Admins can override individual tokens live in the **theme customizer** (`/admin/themes/customize`).
  The overrides are saved in the `active_theme_mods` option and SSR-injected as an inline
  `<style id="wjs-theme-mods">:root{…}</style>` **after** the theme stylesheet, so they win at equal
  specificity. Switching themes clears them. `active_theme_mods` is the one theme-related option the
  customizer writes through the **generic** settings API (`PUT /api/v1/settings`, admin-gated) —
  `template`, `stylesheet`, `active_theme_layout` and `site_chrome_*` are refused there and have
  dedicated endpoints; see
  [themes.md — Options with a dedicated write API](themes.md#options-with-a-dedicated-write-api).
  Plugins and site imports cannot write `active_theme_mods` either way.

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

### Alias tokens (visual-editor block names) — do not override

The framework `:root` also defines **21 alias tokens** that map the token names referenced by the
visual-editor (Puck) block renderer onto the canonical tokens above: `--wjs-h{1..6}-size` →
`--wjs-h{1..6}`, `--wjs-h{1..6}-weight` → `--wjs-heading-weight`, plus `--wjs-font-family`,
`--wjs-color-text-heading`, `--wjs-color-text-dim`, `--wjs-color-primary-text` (→
`--wjs-color-on-primary`), `--wjs-foreground`, `--wjs-bg-surface-hover`, `--wjs-border-radius`,
`--wjs-space-md`, and `--wjs-space-sm`. Themes must override the **canonical** tokens (e.g.
`--wjs-h1`, never `--wjs-h1-size`) — custom properties resolve at use time, so the aliases pick up
the theme's values automatically, while overriding the alias itself detaches it from the canonical
token. These 21 are flagged `"alias"` in the manifest (see below).

### Spacing & shape
`--wjs-spacer` (`1rem`, the base unit for every spacing utility), `--wjs-radius-sm`/`--wjs-radius`/
`--wjs-radius-md`/`--wjs-radius-lg`/`--wjs-radius-pill`, and `--wjs-shadow-sm`/`--wjs-shadow`/
`--wjs-shadow-md`/`--wjs-shadow-lg`.

### Per-block tokens (~600 more — see the manifest)

The tables above are only the **core** tokens. Most of the framework's **738** tokens style
individual visual-editor blocks (`--wjs-<block>-*`); they are documented exhaustively in the
machine-readable manifest (next section), not here. Real group sizes, read from the manifest:
`cta` 55 · `pricing` 49 · `card` 40 · `accordion` 38 · `form` 37 · `hero` 37 · `audio` 34 ·
`tabs` 29 · `testimonial` 29 · `search` 26 · `button` 25 · `catposts` 24 · `stats` 22 ·
`posts` 20 · `video` 20 · `heading` 14 · `table` 13 · `icon` 12 · `quote` 12 · `social` 8 ·
`divider` 6 — plus smaller layout/shape groups (`columns`, `col`, `flex`, `grid`, `section`,
`image`, `spacer`, …), 71 groups in total (a token's group is the first segment of its name).

### Editor-internal tokens (`--wjs-r-*`) — never set these in a theme

The 22 tokens matching `--wjs-r-<prop>-{tb,mb}` (flagged `"editor-internal"` in the manifest) are
the visual editor's per-instance responsive override channel: the editor injects them **inline on
the block element** (tablet `-tb` / mobile `-mb` values for padding, font size, alignment, …) and
the framework's breakpoint rules read them. Declaring one in a theme `:root` would silently
override every block instance on every page — themes must never set them.

### Chrome-consumed tokens invisible to CSS (`chrome-phantom`)

Four tokens are read only by the React chrome (via Tailwind arbitrary values), so no CSS rule in
`wordjs-ui.css` references them: `--wjs-bg-footer`, `--wjs-color-text-footer-main`,
`--wjs-color-text-footer-dim`, `--wjs-bg-surface-glass`. They are force-included in the manifest
with the `"chrome-phantom"` flag; themes **may** set them (footer surface/text colors, translucent
header surface) even though a CSS-only audit would report them unused.

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

## What tokens cover today (and what still needs your own CSS)

A token block like the one above re-skins everything **the framework owns**: the auto-styled HTML
elements, the components and utilities below, `.wjs-content` long-form rules, and the visual-editor
`.wp-block-*` blocks. The public React chrome (header, footer, blog roll) reads the core tokens
too. That makes tokens a real starting point — but no first-party theme is tokens-only:

- **Covered by tokens** — everything styled through `wordjs-ui.css`, i.e. content HTML, components,
  utilities and the editor blocks, plus the chrome colors/typography listed above.
- **Still the theme's own CSS** — a distinctive chrome (header/nav/footer layout and decorations),
  hero/section flourishes, narrow-viewport header-fit rules, and any look the 738 tokens don't
  parameterize. In practice first-party `style.css` files run ~95–525 lines, with `:root` blocks
  declaring anywhere from 17 to 270 tokens (the bundled **default** declares 75 tokens in a
  ~400-line stylesheet).

The complete machine-readable contract is `backend/public/theme-tokens.json` (next section).

## The machine-readable contract (`theme-tokens.json`)

`backend/public/theme-tokens.json` is the generated, complete token contract — the source of truth
whenever this document and the CSS disagree. Current counts: **738 tokens**, **1691 `var()` uses**,
**33 element entries**. For every token it records:

- `group` — first segment of the name (`hero`, `cta`, `color`, `radius`, …);
- `declaredDefault` — the value declared in the `:root` of `wordjs-ui.css`, or `null` when the
  token is only ever consumed through fallbacks;
- `fallbacks` — the fallback chains observed in `var()` uses;
- `consumers` — every `{ selector, property }` pair that reads the token;
- `flags` — `alias` (the 21 do-not-override remaps), `editor-internal` (the 22 `--wjs-r-*`),
  `chrome-phantom` (the 4 React-chrome tokens); omitted when empty.

An `elements` registry (33 entries) maps each `.wp-block-*` class seen in `wordjs-ui.css` — plus
chrome entries for `header` (`.wjs-header`), `logo` (`.wjs-header-logo`), `nav`
(`.wjs-header-nav`) and `footer` — to its platform selector and observed structured child
selectors.

The manifest is deterministic (stable key order, no timestamps), so it diffs cleanly. Regenerate it
after any change to `wordjs-ui.css`:

```bash
node scripts/generate-token-manifest.js
```

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

## Responsive behavior

The framework is responsive by default, and all bundled themes are verified at mobile/tablet/desktop
on top of it:

- **Mobile type scale** — below `768px` the visual-editor heading sizes are capped through the
  `--wjs-hN-size` aliases (`min(var(--wjs-hN), cap)`), and `.wjs-content h1–h3` get the same caps, so
  oversized desktop headings shrink on phones while a smaller theme scale still wins.
- **Content containment (every width)** — wide tables and `pre` blocks scroll inside their own
  container, and long unbreakable strings (URLs, tokens) wrap, in both `.wjs-content` and the visual
  editor's `.puck-content` / `.wp-block-*`, so author content never forces body-level horizontal
  scroll.
- **Device visibility** — the editor's per-block "hide on device" renders as `.wjs-hide-mobile` /
  `.wjs-hide-tablet` / `.wjs-hide-desktop` (breakpoints `<768` / `768–1023` / `≥1024`).

Themes add their own scoped media queries where their design needs them (several bundled themes ship
narrow-viewport header-fit rules).

## Long-form content

Wrap a post/page body in `class="wjs-content"` for tuned vertical rhythm (heading spacing, rounded media,
paragraph/table spacing) on top of the bare-element styles.

## Reference

The framework source (with section comments) is `backend/public/css/wordjs-ui.css`; its complete
token contract is `backend/public/theme-tokens.json` (regenerate with
`node scripts/generate-token-manifest.js`). The bundled **default** theme
(`backend/themes/default/style.css`) and the first-party catalog under
`marketplace/themes/*/style.css` show real token sets for light, dark, mono, glass and brutalist
looks.
