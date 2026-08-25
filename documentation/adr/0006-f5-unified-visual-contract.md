# ADR 0006 — F5: one visual contract, and generated artifacts

- Status: accepted
- Date: 2026-08-20
- Canonical source: `contracts/visual-contract.v1.json`

## Context

Templates, chrome, themes, the public renderer and Verso each restated types, properties, slots,
limits, file names and sanitisation rules by hand. A parity test caught only some of the differences,
and only after two copies had been written; it did not stop a third being created, and it did not
guarantee that a change reached every consumer.

F5 keeps the two programs separate — the backend is not imported from Next.js — while removing the
two definitions. The canonical JSON describes the template/chrome/theme formats, Verso's core
registry, and the visual policies for URLs, HTML, classes and styles.
`scripts/generate-visual-contract.mjs` validates that definition and emits per-package projections,
TypeScript types, the Verso registry, and plugin documentation.

## Decision

The backend remains the security authority: it validates before persisting and sanitises untrusted
content. The frontend uses its projection to fail early and to render only data that satisfies the
same contract. That read-side validation does not make the browser an authority.

Generated artifacts are committed. `npm run verify:f5` runs the generator in `--check` mode and fails
if a file is missing or does not correspond to the definition. The core, chrome and template render
maps are exhaustive via `satisfies Record<GeneratedType, ...>`. Verso's registry uses the generated
order and rejects implementations that are missing, extra, differently categorised, or carrying
different slots.

## Invariants

- **F5-INV-01** — `contracts/visual-contract.v1.json` is the only hand-written definition of shared visual limits and allowlists.
- **F5-INV-02** — backend and frontend consume separate artifacts, generated from the same contract version.
- **F5-INV-03** — no frontend module imports backend implementation.
- **F5-INV-04** — the backend validates and sanitises before persisting; the frontend parser is read-side defence, not authority.
- **F5-INV-05** — template and chrome fail closed on types, properties, depth, count or size outside the contract.
- **F5-INV-06** — the shared URL, HTML, iframe, class and style rules originate in the canonical `security` section.
- **F5-INV-07** — every core type has exactly one generated entry for type, category, renderer and slots.
- **F5-INV-08** — the core, chrome and template renderers must cover their generated unions exhaustively.
- **F5-INV-09** — a missing or stale generated artifact breaks CI before the product is built or tested.
- **F5-INV-10** — plugin documentation is regenerated alongside the code and is never edited as a second source of truth.

## How to change the contract

1. Change `contracts/visual-contract.v1.json`, raising `version` when the persisted format changes.
2. Run `npm run generate:f5` from the repository root.
3. Implement the component for any new type; TypeScript and Verso's registry name every surface still outstanding.
4. Run `npm run verify:f5`, the backend and frontend tests, and the builds.

For plugin extensions, the core registry is not a closed list of plugins: a plugin keeps its own
registry. The backend's sanitisation policy does apply to any tree, a plugin block included, so
extending the editor does not create an alternative route for HTML, URLs or styles.

## Consequences

Silent drift is eliminated, and locating the blast radius of a change becomes mechanical. In exchange,
the `*.generated.ts` files and the generated documentation are part of the commit, and editing one by
hand achieves nothing: the gate rejects it. A valid definition does not invent a visual implementation
either — a new block still needs its component, but it cannot be half-integrated, because the
exhaustive maps and the registry fail until it exists.
