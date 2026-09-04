# ADR-0001: F0 foundation contract

Status: accepted

## Context

WordJS already has extensive security, database, editor and sandbox tests, but the architectural surfaces that later phases will change were not captured by one reproducible baseline. F0 establishes that baseline without changing storage or claiming atomic content mutations before F3.

The machine-readable snapshot is `backend/f0-baseline.json`. `npm run verify:f0` recomputes it from source and fails on drift. An intentional change must update the snapshot and explain its compatibility impact in the same change.

## Invariants

### F0-INV-01 — Request validation precedes mutation

All request shapes and bounded structured values must be validated before the first durable write. A validation error must not create a post, meta row, term relationship or revision.

### F0-INV-02 — A content mutation has one future atomic boundary

The target boundary is post columns, metadata, terms and counters, translations, scheduling state, revision and the durable event describing the change. F0 characterizes current gaps; F3 must move this boundary into one pinned database transaction.

### F0-INV-03 — External effects observe committed state

Cache invalidation, cross-node publication, webhooks, notifications and externally visible plugin callbacks must run only after commit. F3 will enforce this with an outbox. Until then, F0 records the existing order.

### F0-INV-04 — Revision restore is scoped and recoverable

A revision may modify only fields it explicitly versions. Restoring a revision must never delete unrelated plugin or workflow metadata. Existing revisions remain readable through later schema versions.

### F0-INV-05 — Backend authorization is authoritative

Frontend visibility is not authorization. Every REST and plugin path must authenticate, resolve the content-type capability family and authorize the exact normalized value that reaches the sink.

### F0-INV-06 — Cache is derived state

Database state is authoritative. A failed or unavailable cache may reduce performance but must not authorize access, lose content or manufacture a successful mutation. Invalidation must cover local and multi-node readers.

### F0-INV-07 — Plugin compatibility is explicit

The serialisable `backend/types/wordjs-bridge.d.ts` surface and the runtime `registerPostType` defaults are compatibility contracts. Removal, renaming or semantic narrowing requires a versioned adapter and a documented migration window.

### F0-INV-08 — Native plugin isolation fails closed

Compiled production loads an isolated plugin only after the platform probe certifies its native boundary. Linux uses Landlock plus seccomp, Windows AppContainer, and macOS Seatbelt. A weaker fallback requires an explicit operator decision; it must never be silent.

### F0-INV-09 — Portability is proved by conformance

SQLite, PostgreSQL and MySQL must execute the same driver and transaction contracts. A configured CI database that is unreachable is a failure, not a skip.

### F0-INV-10 — Performance changes are budgeted

Performance ceilings live in `backend/f0-performance-budgets.json`. They are regression budgets, not claims about production throughput. Changes to a ceiling are contract changes and therefore visible through the F0 baseline gate.

## REST compatibility policy

- Existing `/api/v1` paths, HTTP methods, authentication requirements, request schemas, response status codes and response schemas remain compatible within the current major version.
- Additive optional fields and new endpoints are allowed, but they intentionally update the baseline.
- Removing a path, making an optional field required, narrowing an accepted value or changing a success/error status requires a versioned endpoint or a major-version migration.
- `backend/f0-baseline.json` records both Express declarations and the semantic OpenAPI projection. Documentation prose is excluded from the semantic hash.

## Plugin and content-type compatibility policy

- `registerPostType(name, args)` remains available while the declarative schema introduced in F1 is adopted.
- Unknown extension keys currently carried by the registry remain carried by the compatibility adapter.
- Built-in post types cannot be unregistered.
- The isolated plugin bridge remains data-serialisable; F1 schemas may not smuggle executable host functions across it.
- A bridge ABI change must provide feature detection or protocol version negotiation before old plugins are rejected.

## Failure characterization

`f0-content-mutation-failures.test.ts` injects failures at the post, term, meta and revision boundaries of a content create and update. In F0 it was a characterization suite that recorded the partial states those failures left behind. F3 inverted its assertions: every injected failure must now return an error, leave the pre-mutation database state (no post row, no meta, no recovery snapshot) and add no `content_outbox` row. `npm run verify:f3` fails if that inversion is missing (`backend/scripts/verify-f3-transactional-content.ts`), and the F6 certification matrix (`backend/scripts/verify-f6-migration.ts`) cites the file as the evidence for the "process failure during a content mutation" leg. The success path — the event committed in the same transaction and dispatched only after commit — is covered by `f3-content-outbox.test.ts`, not by this file.

## Performance measurement

- `npm run perf:f0` measures warmed content operations against an isolated SQLite database and enforces the committed p95 ceilings.
- `npm run perf:bench` measures steady-state HTTP throughput against a production build.
- The existing Verso Playwright suite owns editor input, transaction and time-to-interactive budgets.
- Performance runs must record Node version, platform, sample count and raw millisecond samples so results can be compared honestly.

## Decision

F0 is complete when the baseline gate, compatibility tests, failure-characterization tests, performance harness and existing backend/frontend suites pass. Later phases may intentionally change the snapshot, but cannot silently bypass it.
