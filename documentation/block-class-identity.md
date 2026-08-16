# Block class identity — `wjs-block-*`, and the deprecation of `wp-block-*`

WordJS emits **two classes on every block element**, its own identity first:

```html
<h2 class="wjs-block-heading wp-block-heading heading-h2">…</h2>
<section class="wjs-block-section wp-block-section"> … </section>
```

`wjs-block-*` is the platform's own name and the **source** of the framework stylesheet.
`wp-block-*` is a **deprecated compatibility alias**, kept for one major version and scheduled for
removal (see *Removal* below).

## Why the platform has its own name

[POSITIONING.md](../POSITIONING.md) is explicit that WordJS is not sold as "WordPress, but
JavaScript" — the differentiator is the plugin sandbox, and the platform has an identity of its own.
The public HTML did not say so: every block carried `wp-block-*`, and 213 rules of
`backend/public/css/wordjs-ui.css`, 6 of `core.css` and the bundled themes all hung off that name.
Naming is contract surface. A theme author reading our markup was reading someone else's platform.

## Why it is an addition and not a rename

A straight rename would have broken three populations we cannot migrate:

1. **Themes already installed**, ours and third-party, are written against `.wp-block-*`. They would
   have silently unstyled themselves on upgrade — no error, just a page that looks wrong.
2. **Content already saved** in live databases, and everything a **WXR import** brings over from
   WordPress, carries `wp-block-*` in raw HTML that we never re-render.
3. **Plugins** whose CSS targets framework blocks.

So both classes are emitted, and the framework stylesheet lists both on every rule with the own class
first (`.wjs-block-heading, .wp-block-heading { … }`). Grouped selectors cost nothing at run time,
the alias keeps stored and imported content styled, and a new theme can be written entirely against
`.wjs-block-*`.

## Where each half lives

| Surface | State | File |
| --- | --- | --- |
| Block markup (public + editor canvas) | both classes, own first | `frontend/src/components/blocks/blockVars.ts` → `bc()` |
| Legacy `content` HTML fallback | both classes, own first | `frontend/src/lib/verso/contentFallback.ts` |
| Framework stylesheet | `.wjs-block-x, .wp-block-x` on every rule | `backend/public/css/wordjs-ui.css`, `core.css` |
| Bundled `default` theme | own class first, alias kept | `backend/themes/default/style.css` (+ the embedded copy in `backend/src/core/themes.ts`) |
| `toscano` theme | own class first, alias kept | `backend/themes/toscano/style.css` |
| `circuito` / `gaceta` / `vergel` | **alias only** — compiled output, see below | `backend/themes/*/style.css` `@wjs-generated` block |
| Token manifest | **alias only** — deliberate, see below | `backend/public/theme-tokens.json` |

### `bc()` is the single point

Block class names are built in exactly one function:

```ts
bc('heading')                    // "wjs-block-heading wp-block-heading"
cx(bc('section'), extraClass(className))
bc('divider', 'divider--gradient')
```

They used to be typed inline in 233 places across eight components. "Remember to emit both, own
first" would have been a convention, and a convention is what the next person adding a block forgets.
`frontend/src/components/content/__tests__/blockClassEmission.test.tsx` fails the build if a
`wp-block-*` literal reappears in block markup, and proves at render time that every emitted alias is
preceded by its own class — and that the own class never appears without the alias while the
compatibility window is open.

The one deliberate exception is the card block's three pre-BEM aliases (`wp-block-card-icon`,
`wp-block-card-title`, `wp-block-card-description`). Nothing styles them; they exist only so the very
first themes keep matching, so they get no own-identity twin. They are allowlisted by name in that
test, with that reason.

### Why the manifest and the compiled themes still say `wp-block-*`

`backend/public/theme-tokens.json` is the **token contract** a theme is compiled against, not a record
of which aliases exist, so it names each surface once. It keeps the historical spelling for now, and
`canonicalSelector()` in `scripts/generate-token-manifest.js` is what collapses the pair when the
manifest is regenerated from the aliased CSS — the regenerated file is **byte-identical** to the
committed one, which keeps the CI drift gate, the theme compiler, `theme-doctor` and every built
theme working untouched.

Because `theme-compile.ts` takes its selectors from that manifest, the `@wjs-generated` block of a
declarative theme also compiles to `.wp-block-*`. Three of the five bundled themes (`circuito`,
`gaceta`, `vergel`) have **no hand-written block CSS at all**, so their block rules are alias-only.
They render identically, because every element carries both classes.

## Removal

The alias is supported for **one major version** and then removed. Nothing new should be written
against `wp-block-*`; themes, plugins and any CSS you author today should target `.wjs-block-*`.

When the major version lands, the removal is these four edits:

1. `bc()` in `frontend/src/components/blocks/blockVars.ts` stops appending the legacy class — every
   call site is already correct.
2. `backend/public/css/wordjs-ui.css` and `core.css` drop the `.wp-block-*` alternative from each
   grouped selector.
3. `canonicalSelector()` in `scripts/generate-token-manifest.js` flips to `wp-block-` →
   `wjs-block-`, which moves the manifest — and with it the compiled `@wjs-generated` block of every
   declarative theme — onto the own class. Rebuild the bundled themes
   (`node backend/cli/wordjs.js build theme <slug>`).
4. The card block's three pre-BEM aliases go with it.

At that point the HTML carries one class per element again, and the byte cost of the window
disappears. Content imported from WordPress before the removal will need the alias re-added as a
compatibility stylesheet, or a one-off content migration.

## The byte cost of the window, measured

Every public page of the reference site, served by a production build, gzip (the encoding the server
negotiates), measured before and after the change:

| Page | block classes | raw before → after | gzip before → after |
| --- | --- | --- | --- |
| `/editor-overlay-test` (demo) | 197 | 58 583 → 61 982 (+5.80 %) | 9 118 → 9 559 (**+4.84 %**) |
| `/wordjs-block-library-complete` (demo) | 812 | 121 929 → 138 798 (+13.84 %) | 21 814 → 22 838 (**+4.69 %**) |
| `/block-library` (demo) | 211 | 55 227 → 60 338 (+9.25 %) | 9 921 → 10 347 (**+4.29 %**) |
| `/block-library-vol4` (demo) | 195 | 53 790 → 56 796 (+5.59 %) | 9 284 → 9 590 (**+3.30 %**) |
| `/block-library-vol2` (demo) | 167 | 53 629 → 56 714 (+5.75 %) | 10 422 → 10 742 (**+3.07 %**) |
| `/block-library-vol3` (demo) | 140 | 52 190 → 54 676 (+4.76 %) | 10 557 → 10 789 (**+2.20 %**) |
| `/` (home) | 45 | 63 450 → 64 527 (+1.70 %) | 8 653 → 8 819 (**+1.92 %**) |
| `/test-visual` | 37 | 39 980 → 40 586 (+1.52 %) | 7 073 → 7 185 (**+1.58 %**) |
| 8 blog posts (typical content) | 19 each | ≈ +0.85 % | **+0.24 % … +0.90 %** |
| `/home-2` | 9 | 61 933 → 62 095 (+0.26 %) | 10 730 → 10 758 (**+0.26 %**) |
| **Whole corpus (17 pages)** | | 905 165 → 943 996 (**+4.29 %**) | 157 225 → 160 753 (**+2.24 %**) |

Roughly half of every duplicated class lands in the RSC flight payload rather than in the markup,
which is why the raw growth is about twice what the visible HTML suggests. The six pages above 2 %
are block-catalogue demos that stack every block many times over; the pages a real site serves —
posts and the home page — stay under 2 %.

That trade was accepted deliberately. A contract where `.wjs-block-card` exists but
`.wjs-block-card__title` does not would be paid every time somebody writes a theme; these bytes are
paid once and end when the alias does.

The framework stylesheet pays the same window: `wordjs-ui.css` goes from 160 152 to 167 200 bytes
raw (34.9 KB → 36.1 KB gzip, +3.6 %), `core.css` +113 bytes. Both are separate, cacheable assets and
do not travel with the HTML.
