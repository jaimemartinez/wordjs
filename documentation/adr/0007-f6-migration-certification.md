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

- 143 `req: any` annotations still sit on the request boundary, across 24 of the 43 files under
  `src/routes` and `src/middleware`. Nineteen of those files are now fully typed; seven are half
  migrated, carrying typed handlers next to untyped ones.
- The built-in content types declare their fields through the F1 feature mapper, but three of those
  declarations bind to a posts column that does not exist (see F6-INV-04).
- Thirty-one plugins ship in the marketplace and nine of them are named by any backend test.
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
when it RISES. Three numbers are ratcheted: total `req: any` occurrences, the number of boundary files
that still contain one, and the number of boundary files that are fully migrated. Together they say the
thing that matters: the debt may shrink, and a file that has been migrated may not slide back.

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

Every plugin under `marketplace/plugins` is either named by a backend test or counted against the
uncovered ceiling, and that ceiling may not rise. **Violated by**: adding a plugin directory with no test
naming it; deleting a plugin's test to make an unrelated change green.

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

One piece of wiring is still open. The gate's verdict reaches CI today only through
`backend/src/tests/f6-final-criteria.test.ts`, which asserts it reports no failures and which the backend
suite runs. That is enforcement, but it is the weaker form: an F6 file left uncommitted would fail CI as
a broken suite rather than as a missing gate. `.github/workflows/ci.yml` should also carry an explicit
`npm run verify:f6` step beside the F0-F5 gate steps, and its "Gates that travel" manifest should list
`backend/scripts/verify-f6-migration.ts` and `backend/src/tests/f6-final-criteria.test.ts`. The gate
prints this as a note on every run until the step exists.

## How to advance the migration

1. Migrate a file's handlers to typed requests and remove its `req: any` annotations.
2. Run `npm run verify:f6 -- --print` and read the notes; they name the new values.
3. Lower `MAX_REQUEST_ANY_OCCURRENCES` and `MAX_UNTYPED_BOUNDARY_FILES`, raise
   `MIN_FULLY_TYPED_BOUNDARY_FILES`, and update `backend/f0-baseline.json` with `verify:f0 --print`.
4. Run `npm run verify:f6`, the backend suite and `npm run typecheck`.
