# @wordjs/puck — vendored fork of Puck

This package is a **fork of [Puck](https://github.com/measuredco/puck)
(`@measured/puck`) v0.20.2**, the open-source visual editor by The Puck
Contributors, vendored into the WordJS tree and built here as `@wordjs/puck`.
Puck is MIT-licensed (see `LICENSE`); that license and copyright are retained.

## Why it's vendored instead of a dependency

WordJS needs one behavior Puck's public API cannot express: a per-block **"Edit"**
action, shown only for `Text`/`Heading` blocks, that opens the WordJS inline
text editor via `window.puckSetActiveEditorId(id)`. Puck's supported
`overrides.actionBar` render prop receives `{ label, children, parentAction }` but
**not** the block's `id` or component `type`, both of which this action requires.

Previously this was injected by a `postinstall` script
(`frontend/scripts/patch-puck-actions.js`) that regex-rewrote Puck's **compiled,
minified** `dist/index.js` and a version-hashed chunk. That patch silently broke on
any Puck version bump. Owning the source lets the change live where it belongs.

## The only functional change from upstream

- `components/DraggableComponent/index.tsx` — an `<ActionBar.Action label="Edit">`
  rendered before the Duplicate action when `componentType` is `"Text"` or
  `"Heading"`. It is annotated with a `WORDJS` comment.

Everything else is upstream v0.20.2. Build-config plumbing was inlined (the
upstream monorepo's internal `tsup-config` / `tsconfig` workspace packages became
`tsup.config.ts`, `react-import.js`, and `tsconfig.json` here), but the build is
Puck's own `tsup` pipeline and produces a `dist/` equivalent to what the app
consumed from `@measured/puck`.

## Updating from upstream

To move to a newer Puck: re-copy `packages/core` at the target tag, re-inline the
build config, and re-apply the single `WORDJS`-marked change in
`DraggableComponent/index.tsx`.
