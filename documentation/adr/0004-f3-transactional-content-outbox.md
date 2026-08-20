# ADR-0004: F3 transactional content and durable outbox

- Status: accepted
- Date: 2026-08-20
- Depends on: ADR-0001, ADR-0002 and ADR-0003

## Context

F2 validated and authorized a content request before mutation, but its durable writes were still a
sequence of independently committed operations. A category, metadata or revision failure could leave
only part of the request stored. Model hooks also ran before the whole request committed, so caches,
plugins and webhooks could observe state that later failed or that did not yet include terms/meta.

All four drivers already exposed a transaction callback, but nested model helpers opened new
transactions and pooled engines required every statement to stay on one connection. SQLite additionally
mistook a concurrent transaction from another request for a re-entrant one.

## Decision

F3 introduces a transaction-scoped content unit of work and a durable `content_outbox`. Async-local
transaction propagation pins one driver connection across existing model APIs and joins nested helpers.
Post, metadata, taxonomy, revision, scheduling, language/translation state and the semantic event commit
or roll back together. The outbox dispatcher leases committed events across nodes and invokes cache
invalidation plus legacy content hooks after commit.

### F3-INV-01 — Validation and authorization precede the transaction

F1/F2 validation, normalization, sanitization, parent checks and capability decisions finish before the
first durable write. The transaction contains trusted normalized values, not request parsing policy.

### F3-INV-02 — One pinned connection

One logical content mutation uses one physical database connection from BEGIN through COMMIT/ROLLBACK.
Nested `dbAsync.transaction` calls join that scope. An independent concurrent SQLite request queues;
non-transactional async queries also wait outside that boundary, so their writes cannot be absorbed by
another request's COMMIT/ROLLBACK. Only a transaction invoked from its own callback is rejected by the
raw SQLite driver; synchronous legacy access fails closed while another transaction owns the connection.
Closed async-local scopes are explicitly invalidated, so a detached task cannot reuse a released pooled
connection or append an event after its outbox transaction has already committed.

### F3-INV-03 — One atomic content boundary

The boundary includes post columns/GUID, metadata, term relationships and materialized counts,
translations/language, scheduling state, required revision snapshots and the durable semantic event.
A failure in any stage leaves the pre-request database state.

### F3-INV-04 — The event is committed with the content

Each `post.created`, `post.updated` or `post.deleted` event has an immutable UUID and is inserted into
`content_outbox` before commit. A rolled-back mutation has no event; a committed mutation cannot lack
its event.

### F3-INV-05 — External effects run after commit

Content hooks, frontend purge, webhooks, cache publication and plugin callbacks never run inside the
content transaction. Cache reads bypass derived state while a transaction is active; cache writes and
generic non-content hooks defer until commit.

### F3-INV-06 — Delivery is at-least-once and leased

Workers claim one due row with an atomic guarded update, a unique claim token and a bounded lease.
A crashed worker's `processing` row becomes reclaimable. Lease, retry and retention timestamps use the
database clock, so skew between application nodes cannot reclaim live work early. Delivery retries with
bounded backoff and moves to `dead` after eight attempts. A database-clock failure stops claims rather
than falling back to a possibly skewed process clock; `/health/details.contentOutbox` exposes unavailable,
delayed and dead work.

### F3-INV-07 — Downstream deduplication has an event identity

Plugin hooks may see an event more than once and must treat its effects idempotently. Outgoing webhook
fan-out stores the source event UUID under a unique `(webhook_id, source_event_id, event)` key, so a hook
retry does not create duplicate delivery rows. HTTP delivery retains its documented at-least-once model.

### F3-INV-08 — Revisions fail closed

Initial revisions, pre-update snapshots and revision restores participate in the same transaction.
A snapshot failure aborts the destructive write. Restore changes only the explicit revisionable field/meta
set and its post-update event becomes visible with the restored state.

### F3-INV-09 — Portability is executable

SQLite native, SQLite legacy, PostgreSQL and MySQL implement the same pinned transaction semantics.
CI executes transaction commit/rollback and the exact outbox lease SQL against real PostgreSQL/MySQL;
SQLite suites cover concurrency, nesting, crash-retry behavior and the pure-JS fallback.

### F3-INV-10 — Compatibility and cost are bounded

Existing REST success/error shapes and legacy hook names/arguments remain. Outbox payloads are bounded
to the public request ceiling plus envelope headroom, workers process bounded batches, poll timers do not
keep a process alive, and the committed F0 performance budgets remain the regression gate. Processed
events are retained for seven days and pruned in portable batches; pending and dead-letter rows are never
removed by retention.

## Consequences

- A request cannot report a partial content save after a term/meta/revision failure.
- Hooks now observe the final committed aggregate, not an intermediate post row.
- A successful request is not converted to a misleading 500 by a post-commit plugin/cache failure;
  retry state remains in the database.
- `content_outbox` is a protected core table: logical imports cannot forge events and database clears
  remove stale events and already-fanned-out webhook deliveries before content identifiers are reused;
  that cleanup fails closed if either queue cannot be cleared.
- Successful-event history is storage-bounded without deleting retry or dead-letter evidence.
- Delivery is not globally exactly-once. The durable guarantee is atomic enqueue plus at-least-once
  processing; the immutable event ID is the idempotency key for downstream consumers.
