# Stitch prompts — WordJS Puck block library

How to use: paste **Prompt A** first (it sets the design system). Then paste **one batch prompt**
per run from Prompt B. Don't ask for all 28 blocks in a single run — the output collapses into
generic variations.

## Driving Stitch (learned the hard way, 2026-07-25)

Stitch is Flutter Web — the whole UI is one `<canvas>`. There is no DOM to select, the
accessibility tree is empty, and CSS selectors find nothing. Consequences:

- **Hover before every click.** A bare click is ignored; Flutter needs the pointer-enter first.
  This is what made the Aplicación/Web toggle look broken.
- **Press Enter to send.** The circular arrow button does not respond to synthetic clicks.
- **Type prompts as ONE paragraph, no newlines** — Enter submits, so a multi-line prompt would be
  sent in fragments.
- Switch to **Web** mode before the first prompt, or it designs native mobile screens.
- A prompt can silently fail to register. Check the agent log entry count before assuming it ran.

Run state as of 2026-07-25: project **"WordJS Luminous Design System"** contains the design system,
batch 1 and batch 2. Batches 3 and 4 were still pending.

Whatever Stitch returns is a *design reference*, not shippable code. The value is in the tokens: the
prompts force it to name every value, and those names map 1:1 onto the `--wjs-<block>-<prop>`
contract in `backend/public/css/wordjs-ui.css`, so porting a design is find-and-replace, not a
rewrite.

---

## Prompt A — design system (run once, first)

```
You are designing a block library for a CMS visual page builder (like WordPress Gutenberg or
Webflow). Site owners drop these blocks onto a page and restyle them without writing code.

Establish the design system first. I want the level of craft of a top product-design studio:
deliberate spacing rhythm, a real type scale, layered shadows rather than one flat blur, and
restraint with colour.

Design direction: <<< REPLACE: e.g. "modern SaaS — near-black surfaces, subtle mesh gradients,
1px luminous borders, tight display typography, one electric accent" >>>

Deliver:
1. A colour system: surface, surface-raised, text-primary, text-muted, border-subtle, accent,
   accent-contrast — in BOTH light and dark. State contrast ratios; body text must pass WCAG AA.
2. A type scale: h1/h2/h3/body/small, with size, weight, line-height and letter-spacing for each.
   Use a fluid clamp() for h1 and h2.
3. A spacing scale (4px base) and a radius scale (sm/md/lg/pill).
4. Four elevation levels, each as a TWO-STOP shadow (a tight contact shadow plus a wide soft one).
5. One hover/motion rule: the standard duration and easing curve for the whole library.

Output every value as a CSS custom property. Name them exactly `--wjs-<role>`, for example
`--wjs-color-primary`, `--wjs-space-md`, `--wjs-radius-lg`, `--wjs-shadow-2`.

Hard constraints for everything that follows:
- Each block is INDEPENDENT. It can appear anywhere on a page, at any width, next to any other
  block. No block may assume it is full-bleed, first, or last.
- Fluid from 320px to 1600px. No fixed pixel widths on containers.
- Both light and dark must work. Never hardcode a colour that only reads in one of them.
- No external images, icon fonts or web fonts. Use system font stacks and simple inline SVG or
  geometric shapes as placeholders.
- Motion is entrance + hover only. No autoplaying loops, no parallax that breaks on mobile.
```

---

## Prompt B — block batches

Reuse this wrapper for each batch, swapping the list:

```
Using the design system above, design these blocks. For EACH block give me:
 (a) the default state, at desktop and at 375px;
 (b) every variant listed;
 (c) the hover state, if the block has interactive parts;
 (d) a token table: every value you chose, named `--wjs-<block>-<property>`
     (e.g. --wjs-card-pad, --wjs-hero-title-size, --wjs-pricing-accent).

Rule for (d): if a value could reasonably differ between sites, it MUST be a token. Only truly
structural values (display, position, flex-direction) may be literals. Assume a theme author will
override every token, so each one needs a sensible standalone fallback.

Blocks in this batch:
<<< PASTE ONE LIST BELOW >>>
```

### Batch 1 — hero and conversion (highest impact, do this one first)

```
1. HERO — full-width banner. Parts: background (image with adjustable dark overlay, OR a gradient
   when no image), inner content column, title, subtitle, action buttons row.
   Variants: image background; gradient background; left-aligned; centred.
   Must stay legible over a busy photograph.

2. CTA BANNER — a conversion strip inside a page. Parts: title, subtitle, one button.
   Variants: solid accent; dark; gradient.

3. PRICING TABLE — a row of plan cards. Parts per plan: name, price with period suffix, feature
   list with check icons, action button. One plan is "highlighted" and must read as the
   recommended choice without simply being bigger and louder.
   Show 3 plans. Solve what the highlighted plan does when the row stacks on mobile.

4. STATS — a row of figures. Parts per item: value (large) and label (small, above or below).
   Show 3 and 4 item versions.

5. TESTIMONIAL — a single quote card. Parts: quote mark, quote text, avatar (with an initials
   fallback when no image), author name, role/company.
```

### Batch 2 — content

```
1. CARD — icon, title, description. Variants: light, dark, accent. Include the hover state; this
   block is the one most often used in a grid of 3.
2. ICON LIST — a grid of icon + title + description items. Show 2 and 3 column versions.
3. QUOTE — a pull quote. Variants: left rule ("bar"), and large centred with a lead-in mark.
4. TABLE — a data table with header row and optional zebra striping. Solve horizontal overflow on
   mobile without shrinking the text to nothing.
5. BUTTON — a standalone button. Variants: primary, secondary, outline. Include hover, focus-visible
   and disabled. Focus must be visible against both light and dark surfaces.
6. IMAGE — a figure with optional caption, radius and shadow.
```

### Batch 3 — layout and typography

```
1. SECTION — a full-width band with a constrained inner column. Variants: transparent, tinted,
   and with a top/bottom divider shape.
2. GRID — an n-column responsive grid. Show 2/3/4 columns and the tablet and mobile collapse.
3. FLEX ROW — a horizontal row of arbitrary children, with alignment and wrap options.
4. COLUMNS — 2-3 columns with adjustable width distribution (50/50, 70/30, 33/33/33) and a
   per-column background/padding option.
5. HEADING and BODY TEXT — show the full type scale in situ: h1 through h3, body, and body with a
   list and an inline link. Set the optimal measure for body text.
6. DIVIDER — variants: solid rule, dashed, and a gradient fade to transparent at both ends.
```

### Batch 4 — interactive and dynamic

```
1. ACCORDION — collapsible FAQ items. Show collapsed, expanded, and the transition between them.
   Indicate the affordance without relying on colour alone.
2. TABS — a tab bar with panels. Solve what happens when the tabs overflow the width on mobile.
3. VIDEO EMBED — a responsive 16:9 player frame with a poster image and play affordance.
4. AUDIO PLAYER — a compact player: play/pause, progress, time, title.
5. SEARCH BAR — an input with a submit button. Include focus and the empty/typing states.
6. POSTS GRID — a grid of article cards: thumbnail, category chip, title, excerpt, date, author.
   Show the state where a post has no thumbnail.
```

---

## Paste-ready, single-paragraph versions

Stitch submits on Enter, so these are flattened to one line each. Batches 1 and 2 already ran.

### Batch 3 (layout and typography)

```
Now the layout and typography batch, same deliverables and same token rule. Name every token with the --wjs- prefix consistently (--wjs-stats-value-size, not --stat-value-font). Blocks: 1. SECTION - a full-width band with a constrained inner column; variants: transparent, tinted, and with top and bottom divider shapes. 2. GRID - an n-column responsive grid; show 2, 3 and 4 columns plus the tablet and mobile collapse behaviour. 3. FLEX ROW - a horizontal row of arbitrary children with alignment, gap and wrap options. 4. COLUMNS - two or three columns with adjustable width distribution (50/50, 70/30, 33/33/33) and per-column background and padding. 5. HEADING and BODY TEXT - the full type scale in situ: h1 to h3, body text, and body text containing a list and an inline link; set the optimal measure for body text. 6. DIVIDER - variants: solid rule, dashed rule, and a gradient fading to transparent at both ends. 7. SPACER - an adjustable vertical gap with a visible affordance in the editor but invisible on the published page.
```

### Batch 4 (interactive and dynamic)

```
Next batch: the interactive and dynamic blocks. Same deliverables and same token rule as before, and name every token with the --wjs- prefix consistently. Blocks: 1. ACCORDION - collapsible FAQ items; show the collapsed state, the expanded state, and the transition between them; indicate the affordance without relying on colour alone. 2. TABS - a tab bar with panels; solve what happens when the tabs overflow the available width on mobile. 3. VIDEO EMBED - a responsive 16:9 player frame with a poster image and a play affordance. 4. AUDIO PLAYER - a compact player with play and pause, a progress bar, elapsed time and a track title. 5. SEARCH BAR - an input with a submit button; include the empty, typing and focus states. 6. POSTS GRID - a grid of article cards showing thumbnail, category chip, title, excerpt, date and author; also show the state where a post has no thumbnail. 7. CATEGORY POSTS - a compact list of posts filtered by category, denser than the grid, suitable for a sidebar or a footer column.
```

---

## After Stitch

For each block, translate its token table into `wordjs-ui.css`:

```css
.wp-block-hero__title {
  font-size: var(--wjs-hero-title-size, <stitch's value>);
  font-weight: var(--wjs-hero-title-weight, <stitch's value>);
}
```

Stitch's value becomes the **fallback**, never a hardcoded declaration — that is what keeps themes
able to override it. The block's own render stays untouched; it already emits only the classes and
the author's overrides.

Blocks still awaiting the contract when this was written: Columns, Accordion, Tabs, VideoEmbed,
AudioPlayer, PostsGrid, CategoryPosts, SearchBar, HTMLEmbed.
