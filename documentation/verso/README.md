# Verso — specs and records

Verso is WordJS's own visual editor (`frontend/src/lib/verso/`, `frontend/src/components/verso/`); how
it works today is described in [frontend.md → Visual Editing (Verso)](../frontend.md#visual-editing-verso--the-editor-in-detail).
This folder holds the documents written while it was designed and built. Most are in Spanish, the
working language of that program. They fall into two groups: **live specs and contracts**, which the
code and tests still follow, and **historical records**, which describe the editor Verso replaced or a
decision that has already been carried out. Each file's header states which it is.

## Live specs and contracts

| Document | What it defines |
| --- | --- |
| [chrome-oracle.md](chrome-oracle.md) | The parity contract for the site-chrome editor (`/admin/chrome`): block types, data shape, budgets and endpoints. §1–§3 are current; §4 describes the retired editor. |
| [crdt-spec.md](crdt-spec.md) | Real-time collaboration (F8): the decisions behind the CRDT, the transport and the gates, with what was built after it. |
| [dnd-spec.md](dnd-spec.md) | Drag-and-drop behaviour: the 48-case fixture `frontend/src/lib/verso/__fixtures__/dnd-cases.json` that Verso's resolver (`lib/verso/dnd/resolve.ts`) is tested against. Its source citations point at the deleted fork. |
| [inline-engine-spec.md](inline-engine-spec.md) | The in-house inline text engine (F3.5): model, parse, serialize, operations and the DOM layer. Implemented. |
| [interactions-spec.md](interactions-spec.md) | The interactions engine (F9): normalize, compile, presets and runtime. Implemented. |
| [interactions-scorecard.md](interactions-scorecard.md) | The competitive benchmark that ordered the interactions work, with a log of what shipped (commit ids from a squash-merged branch do not resolve). |
| [f7-drills.md](f7-drills.md) | The re-runnable no-content-loss drills (`scripts/verso-drills/`) run against a copy of a development install. |

## Historical records

| Document | What it records |
| --- | --- |
| [editor-decision-f0f1.html](editor-decision-f0f1.html) | The F0+F1 write-up that chose to build a new editor. |
| [f0-audit-core.md](f0-audit-core.md), [f0-audit-digest.md](f0-audit-digest.md) | The F0 audit of the previous editor stack (the vendored fork and its wrapper), now deleted. |
| [f0-bench-digest.md](f0-bench-digest.md) | The F0 competitor benchmark, a snapshot that was not re-verified. |
| [f1-panel.json](f1-panel.json), [f1-proposal-A.md](f1-proposal-A.md), [f1-verdicts-digest.md](f1-verdicts-digest.md) | The three F1 proposals put to the judging panel (A in full) and the panel's verdicts. |
| [derivation-audit.md](derivation-audit.md) | The derivation analysis that authorised deleting the fork; the deletion has happened. |
| [f3-parity-checklist.md](f3-parity-checklist.md) | The F3 feature-parity log, written wave by wave against the legacy editor. |
| [legacy-surface.md](legacy-surface.md) | The inventory of the legacy surface the retirement had to reach; every `file:line` is a dead pointer. |
| [retirement-plan.md](retirement-plan.md) | The plan to retire the fork and the legacy editor; every phase has landed. |
| [wrapper-blueprint.md](wrapper-blueprint.md) | The skin of the retired editor that `VersoEditor` was built to reproduce. |

The persisted page tree keeps its historical post-meta key, `_puck_data`, on purpose; see
[plugins.md §13](../plugins.md).
