# @wordjs/puck — vendored fork of Puck

This package is a **fork of [Puck](https://github.com/measuredco/puck)
(`@measured/puck`) v0.20.2**, the open-source visual editor by The Puck
Contributors, vendored into the WordJS tree and built here as `@wordjs/puck`.
Puck is MIT-licensed (see `LICENSE`); that license and copyright are retained.

## Why it's vendored instead of a dependency

WordJS needs behaviour Puck's public API cannot express, and it needs it to
survive Puck version bumps. Previously the changes were injected by a
`postinstall` script (`frontend/scripts/patch-puck-actions.js`) that regex-rewrote
Puck's **compiled, minified** `dist/index.js` and a version-hashed chunk. That
patch silently broke on any Puck version bump. Owning the source lets the changes
live where they belong.

## Functional divergences from upstream v0.20.2

There is more than one. Every functional divergence is listed here, and every
change site in the source carries a `WORDJS` comment so the set is greppable
(`grep -rn WORDJS frontend/packages/puck --include='*.tsx'`). If you add, remove,
or move a divergence, update this list and the marker in the same change — the
regression suite (`frontend/src/lib/__tests__/puckForkDivergence.test.ts`) pins
both, and a stale "single change" claim here is exactly the kind of dishonest
in-tree note this project does not tolerate.

### 1. Editor chrome portalled OUTSIDE the canvas iframe (Gutenberg-style)

Upstream renders each block's overlay (selection outline + `ActionBar`) INTO the
canvas iframe's own `<body>`. There, the edited page's own CSS and stacking
context — a theme's `position:fixed` header, a `z-index`, a `transform` — can
cover, clip, or shift the editor chrome. WordJS moves the chrome into a layer in
the PARENT document that exactly overlays the iframe, so the page it edits can
never touch it. This one architectural change spans four sites:

- `components/Puck/components/Preview/index.tsx` — renders the
  `[data-puck-overlay-layer]` element: an absolutely-positioned, `inset:0`,
  `overflow:hidden`, `pointer-events:none` layer in the parent document, sitting
  on top of the canvas iframe. Overlays portal here instead of into the iframe.
  (Marked with a `WORDJS` comment.)
- `components/DraggableComponent/index.tsx` (portal target, ~L244) — resolves the
  portal target by bridging out of the iframe via `frameElement` to the
  `[data-puck-preview]` ancestor and its `[data-puck-overlay-layer]` child;
  falls back to the iframe `<body>` (upstream behaviour) if the layer is absent.
- `components/DraggableComponent/index.tsx` (`getStyle`, ~L271) — when the overlay
  lives in that parent layer, the block's iframe-viewport rect maps 1:1 into the
  layer, so the position is `rect.left`/`rect.top` verbatim, with **no** scroll
  term and **no** device-scale division (the transform wraps both iframe and
  layer). The upstream scroll/scale math still runs for the fallback path.
- `components/DraggableComponent/index.tsx` (scroll re-sync, ~L517) — a
  parent-layer overlay no longer scrolls with the canvas content, so a
  capture-phase `scroll` listener on the iframe document plus a `resize` listener
  re-sync the overlay position; wired only while the overlay is visible.

### 2. Per-block "Edit" action for Text/Heading blocks

- `components/DraggableComponent/index.tsx` (`ActionBar`, ~L686) — an
  `<ActionBar.Action label="Edit">`, rendered before Duplicate only when
  `componentType` is `"Text"` or `"Heading"`, that opens the WordJS inline text
  editor by calling `window.puckSetActiveEditorId(id)`. Puck's supported
  `overrides.actionBar` render prop receives `{ label, children, parentAction }`
  but **not** the block's `id` or component `type`, both of which this action
  requires — which is why it previously lived as a regex patch of the compiled
  bundle. `PuckEditor.tsx` installs the `window.puckSetActiveEditorId` global this
  action calls.

Everything else is upstream v0.20.2. Build-config plumbing was inlined (the
upstream monorepo's internal `tsup-config` / `tsconfig` workspace packages became
`tsup.config.ts`, `react-import.js`, and `tsconfig.json` here), but the build is
Puck's own `tsup` pipeline and produces a `dist/` equivalent to what the app
consumed from `@measured/puck`. Build plumbing is not a functional divergence and
is not marked.

## Updating from upstream

Do NOT re-sync casually. To move to a newer Puck: re-copy `packages/core` at the
target tag, re-inline the build config, then re-apply **every** `WORDJS`-marked
change listed above — both divergences, all five sites. Run
`frontend/src/lib/__tests__/puckForkDivergence.test.ts` afterwards; it fails if a
divergence's structural invariant is missing.
