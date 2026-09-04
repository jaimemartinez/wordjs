# ADR-0007: F6 migration and certification

- Status: accepted
- Date: 2026-08-24
- Depends on: ADR-0001 through ADR-0006
- Gate: `npm run verify:f6` (`backend/scripts/verify-f6-migration.ts`)
- Evidence: `backend/src/tests/f6-final-criteria.test.ts`

## Context

F0 through F5 each replaced a piece of implicit behaviour with a declared contract: a frozen
architectural baseline, a declarative content schema, generated DTOs and validators, a pinned
transactional unit of work with a durable outbox, versioned revisions, and one visual contract with
generated projections. Every one of them shipped with an ADR, a CI gate and an executable test.

None of them finished the job, because a contract that only the new code obeys is a second system, not
a migration. What is left is the part no generator produces:

- When F6 opened (2026-08-24), 143 `req: any` annotations sat on the request boundary, across 24 of
  the 43 files under `src/routes` and `src/middleware`; nineteen files were fully typed and seven were
  half migrated, carrying typed handlers next to untyped ones. That debt was paid down to zero the next
  day (`f95f139f`): all 43 boundary files are fully typed, and the gate's ratchets now hold at zero
  `req: any`, zero `(req as any)` casts, zero `res: any`, zero untyped boundary files and a floor of 43
  fully typed files. The ratchets stay in place so the debt cannot come back.
- The built-in content types declare their fields through the F1 feature mapper, but three of those
  declarations bind to a posts column that does not exist (see F6-INV-04).
- Thirty-one plugins ship in the marketplace. When F6 opened, none of them had executable
  compatibility evidence: the only available signal was whether a backend test file mentioned a
  plugin's slug, and even that count was inflated by slugs that appeared only in comments and packaging
  paths (it read 9 with comments included and 4 without). Coverage is now measured by running
  `backend/src/tests/f6-plugin-compatibility.test.ts`, which derives its population from
  `marketplace/plugins/` and gives every plugin a top-level test: the manifest parses and matches its
  directory, the declared frontend entries exist, the install-time validator accepts it, the entry
  loads, and `init()` completes against a bridge that refuses undeclared capabilities. All thirty-one
  pass today (`MIN_COVERED_MARKETPLACE_PLUGINS = 31`, `MAX_UNCOVERED_MARKETPLACE_PLUGINS = 0`), and the
  gate counts coverage only from that run, so a slug in a comment or a skipped test no longer counts.
  This proves each plugin loads and boots; it does not test the plugins' behaviour (no HTTP handler,
  query or rendered block is asserted).
- The three-OS confinement certification, the three-engine SQL certification, the outbox failure
  injection and the multi-node coherence job all already exist — as separate facts nothing ties
  together, so no single artefact can say whether the certification matrix is intact.

F6 is therefore not "one more contract". It is the phase that turns the previous six into a state the
project can be released from, and it must do that without breaking installations that are still running
the old shapes.

## Decision

### The rollout is gradual, and each stage is a state the tree can be left in

1. **Shadow mode.** New validation runs beside the pre-migration baseline, records what it would have
   rejected, and rejects nothing. A disagreement is data, not a 400.
2. **Comparison.** The baseline and the new validator are run against the same inputs and their verdicts
   are compared. The comparison is what makes stage 3 a decision rather than a hope.
3. **Built-in types first.** `post`, `page`, `attachment`, `nav_menu_item` and `revision` move to the new
   service. They are the types the project controls, so a defect costs a fix, not a broken plugin.
4. **Plugins opt in.** A plugin asks for the new service; nothing is moved underneath it. The legacy
   adapters keep working unchanged, and the compatibility tests are what prove it.
5. **On by default.** The new system becomes the default for everything that has not opted out. Opting
   out is still possible and still supported.
6. **Deprecation warnings.** The legacy path warns. It still works.
7. **Adapters retired in a major version only.** Removal is a breaking change and is released as one.

No stage is allowed to be skipped by making the gate quieter. Stages 1 and 2 exist precisely so that
stage 3 is taken with evidence.

#### The baseline is "accept", not the legacy descriptor's rules

The first implementation of stages 1 and 2 built the baseline by round-tripping the declarative schema
through the legacy post-type descriptor. That round trip is the **identity** for every type an
installation can actually have: the built-ins build their fields with `fieldsForFeatures(features)` and
`adaptLegacyPostType` recomputes exactly that, while `registerPostType` stores the already-adapted
schema. Since the validator reads only `fields` and the discriminator, the baseline verdict was
bit-for-bit the enforcing verdict.

Two things in this document were therefore false as shipped. Stage 5's "opting out is still possible"
was not: `off` rejected exactly what `enforce` rejects, so an operator whose writes began failing could
set it, restart every node, and see the same 400s. And the evidence stage 3 is meant to rest on was a
tautology — the ramp compared the enforcing validator against itself, so it reported "no divergence"
for precisely the five built-in types stage 3 names.

The corrected baseline is the behaviour that actually preceded F2: the write routes ran **no** contract
validation at all. So the low rungs accept, the checks that predate F2 (authentication, capability
gates, sanitisation, the model) run unchanged, and a divergence in shadow means exactly "enforcing
would have rejected this write". `legacyProjectionOfSchema` was deleted rather than left in place,
because a dead function whose documentation asserts the reasoning that produced the defect is a trap
for the next reader.

### Debt is ratcheted, not declared eliminated

A gate that demanded zero `req: any` on the day F6 opened would have been disabled within a day, and a
disabled gate protects nothing. The gate records where the debt stood when the phase opened and fails
when it RISES. Five numbers are ratcheted: total `req: any` occurrences; `req as any` casts at the
boundary (the parameter or any member of it, e.g. `(req.query as any)`, and the `<any>req` form);
`res: any` occurrences; the number of boundary files that still contain a `req: any`; and, as a floor
rather than a ceiling, the number of boundary files that are fully migrated (at least one typed `req`
and no `req: any` left). The cast and response counters exist because paying the debt down must not be
a search-and-replace that moves the `any` instead of removing it: typing the parameter and then widening
every use satisfies the `req: any` count while changing nothing about what is checked. The gate also
cross-checks its `req: any` count against the F0 baseline and fails if the two disagree. Together they
say the thing that matters: the debt may shrink, and a file that has been migrated may not slide back.

### Certification consumes the proofs that already exist

`.github/workflows/sandbox-parity.yml` already proves Landlock+seccomp, AppContainer and Seatbelt on
real runners, control-versus-confined, including the fail-closed case F6 asks for literally. F5's
verifier already proves the visual contracts have not diverged. F6 runs them and reports their verdict;
it does not restate their assertions, because a restated assertion is the third copy the programme has
spent six phases removing.

## Invariants

### F6-INV-01 — Migration debt may shrink and may not grow

`req: any` occurrences under `src/routes` and `src/middleware`, counted exactly as `verify-f0` counts
them, may never exceed the ceiling recorded in the gate. **Violated by**: a new handler written with
`req: any`; a new route file born untyped; raising the ceiling to make a commit green.

### F6-INV-02 — A migrated handler stays migrated

A boundary file with at least one typed request handler and no `req: any` is fully migrated. The number
of fully migrated files may not fall. **Violated by**: re-introducing `req: any` into a fully typed file,
which is how a migration silently reverses; deleting a migrated file without migrating its replacement.

### F6-INV-03 — Typing is judged by what the code does, not by what it is called

A handler counts as typed when its request parameter carries an explicit annotation that is not `any`.
No gate, test or review step may key off the NAME of a request type. **Violated by**: a check that greps
for `AuthenticatedRequest`, which would call a correctly typed handler untyped the moment a file imports
a shared alias instead of declaring a local one — the same defect the F5 gate shipped with when it
grepped for `require(`.

### F6-INV-04 — Every built-in field declaration resolves

Every field a built-in content type declares is exactly what the F1 feature mapper produces for its
declared features, and every storage binding resolves: a `column` binding names a column the posts table
really has, a `meta` binding carries a key. Three bindings do not resolve today — `authorId` binds to
`post_author` on `post`, `page` and `attachment` while the table declares `author_id` — and they are
recorded in the gate as debt, compared for equality so the exception retires itself when the defect is
fixed. **Violated by**: a new field bound to a column that does not exist; a column renamed in the DDL
and nowhere else; leaving the recorded exception in place after paying the debt.

### F6-INV-05 — A revisioned field is a versioned field

Every field declared `revisioned: true` appears in its type's revision projection, which is what F4
freezes into a snapshot envelope. **Violated by**: marking a field revisioned while the projection is
computed from something else, which produces snapshots that silently omit it.

### F6-INV-06 — The visual contract is certified by consuming F5, never by restating it

F6 runs the F5 generator in `--check` mode and the F5 gate itself, and reports their verdict as its own.
**Violated by**: copying an F5 assertion into the F6 gate, which creates the divergence F5 exists to
abolish; treating an F5 failure as out of scope for F6's certification.

### F6-INV-07 — A legacy plugin without compatibility evidence is not shipped

Every plugin directory under `marketplace/plugins` is exercised by
`backend/src/tests/f6-plugin-compatibility.test.ts`, which derives its population from that directory
and gives each plugin a top-level test named for its slug: the manifest parses and matches its
directory, the declared frontend entries exist, the shipping install-time validator accepts it, the
entry loads, `init()` completes against a bridge that refuses undeclared capabilities, and everything
`init()` registered satisfies the host's own acceptance rules. The F6 gate (`F6-C05`) runs that suite
itself and counts a plugin as covered only when its test **passed** — a failed or skipped test is not
evidence, and a plugin on disk that received no verdict fails the gate outright. The covered count is a
floor that may only rise (`MIN_COVERED_MARKETPLACE_PLUGINS`, currently 31) and the uncovered count is a
ceiling that may only fall (`MAX_UNCOVERED_MARKETPLACE_PLUGINS`, currently 0); neither can be satisfied
by naming a slug in a test file. **Violated by**: adding a plugin directory the compatibility suite
cannot load or that fails the host's acceptance rules; skipping or weakening the suite so an unloadable
plugin still reads as passed; lowering the floor or raising the ceiling to make an unrelated change
green.

### F6-INV-08 — The sandbox fails closed on every platform it claims

For every platform in the kernel-mechanism map with a mechanism other than `none`, a launch decision in
any confinement state other than `active` must not use the sandbox, compiled production must require
native confinement, and a real CI runner of that OS family must certify it. **Violated by**: adding a
platform to the mechanism map without adding a runner to `sandbox-parity.yml`; a decision path that
treats `degraded` as good enough; a probe failure reported as a floor in force.

### F6-INV-09 — Every engine and every measurement is bounded

A module in `src/drivers` whose export implements the driver interface is a driver, and every driver is
named by `driver-conformance.test.ts`, which runs with `WORDJS_CI_DB=1` so an unreachable server fails
instead of skipping green. Every measurement the F0 bench emits has a numeric ceiling in
`f0-performance-budgets.json`, and every ceiling corresponds to a measurement. **Violated by**: a fourth
engine added without conformance coverage; dropping `WORDJS_CI_DB` so the suite self-skips and counts as
PASS; a new bench measurement with no budget, or a budget nothing measures.

### F6-INV-10 — Every certification leg names how it runs, and that run is checked

Each leg of the certification matrix names its evidence file and its runner — the backend suite, a named
package script, or a workflow — and the gate verifies the whole chain, including that CI invokes the
script. **Violated by**: evidence committed but never executed; deleting the CI step that runs a leg
while leaving its test file in the tree; a gate that checks only that the file exists.

## Consequences

The gate reports every finding it has. Each of its eleven checks runs inside its own boundary and
contributes failure strings to one list, so a broken check can no longer hide the checks behind it —
the defect that made the F5 gate report a phase as broken while ten of its assertions had never run.

The cost is that F6's gate is the noisiest in the ladder: it fails for other phases' regressions, for a
missing CI step, and for debt that grew by one line. That is the intent. The ratchet numbers and the
certification matrix are the only hand-written data in the gate, both are labelled as such, and both are
checked against something the tree computes.

`--print` reports the measured values without failing, which is how a ratchet is tightened after debt is
paid. Tightening is an ordinary commit. Loosening one is a decision that belongs in a review.

The gate's verdict reaches CI by two independent routes. `.github/workflows/ci.yml` runs an explicit
`npm run verify:f6` step beside the F0-F5 gate steps, and `backend/src/tests/f6-final-criteria.test.ts`,
which the backend suite runs, asserts the gate reports no failures. Both
`backend/scripts/verify-f6-migration.ts` and that test are listed in ci.yml's "Gates that travel"
manifest, so an uncommitted F6 file fails as a missing gate rather than as a broken suite. The gate
checks both routes itself: it fails if neither reaches it, and if the explicit step is ever removed it
prints a note on every run asking for it back.

## How to keep the migration closed

The request-boundary ratchets are fully tightened: `MAX_REQUEST_ANY_OCCURRENCES`,
`MAX_REQUEST_AS_ANY_CASTS`, `MAX_RESPONSE_ANY_OCCURRENCES` and `MAX_UNTYPED_BOUNDARY_FILES` are all `0`,
and `MIN_FULLY_TYPED_BOUNDARY_FILES` is `43` — every `.ts` file under `backend/src/routes` and
`backend/src/middleware`. A file counts as fully typed when it carries at least one typed `req` handler
and no `req: any`. The plugin ratchets are likewise closed: `MIN_COVERED_MARKETPLACE_PLUGINS` is `31`
and `MAX_UNCOVERED_MARKETPLACE_PLUGINS` is `0`. There is nothing left to lower; the job now is to keep
the numbers from moving the wrong way.

1. Write every new route or middleware handler with an explicit request and response type. A
   `req: any`, `res: any` or `(req as any)` anywhere under the boundary directories turns
   `npm run verify:f6` red.
2. When a boundary file is added, run `npm run verify:f6 -- --print`; if the notes report more than 43
   fully typed files, raise `MIN_FULLY_TYPED_BOUNDARY_FILES` to the reported value and refresh
   `backend/f0-baseline.json` with `verify:f0 --print`.
3. When a marketplace plugin is added, `backend/src/tests/f6-plugin-compatibility.test.ts` picks it up
   from `marketplace/plugins/` automatically; once its test passes, raise
   `MIN_COVERED_MARKETPLACE_PLUGINS` to the value the `--print` notes report. A plugin whose test fails
   counts as uncovered and fails the gate.
4. Run `npm run verify:f6`, the backend suite and `npm run typecheck`. Tightening a ratchet is an
   ordinary commit; loosening one is a decision that belongs in a review.
