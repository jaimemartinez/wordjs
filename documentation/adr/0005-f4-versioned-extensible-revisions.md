# ADR-0005: F4 versioned and extensible revisions

- Status: accepted
- Date: 2026-08-20
- Depends on: ADR-0001 through ADR-0004

## Context

F3 made revision creation and restoration atomic, but the fields inside a revision were still chosen by
one fixed core metadata list. The F1 schema already declared `field.revisioned`, `revisions.fields`,
`metaKeys`, `schemaVersion` and `codecVersion`; the runtime ignored those declarations. Replacing the
fixed list with today's registry alone would be unsafe: upgrading or disabling a plugin would silently
change what an old snapshot means, and a future codec could reinterpret existing bytes.

## Decision

Every new revision stores a protected `_wjs_revision_snapshot` envelope beside its historical post/meta
payload. The envelope freezes the content type, schema version and fingerprint, codec version, field
descriptions, storage targets, presence and payload counts. The current codec is version 1. The runtime
decodes the frozen envelope and never consults the active plugin schema during restore. Rows without an
envelope use the immutable pre-F4 decoder (codec 0) and its seven historical metadata keys.

### F4-INV-01 — Per-field declarations are authoritative

`fields.<name>.revisioned: true` is sufficient to include a field. `revisions.fields` remains a
compatibility projection and normalization merges it into the per-field declaration. Revisionable
computed fields are rejected because they have no durable value to restore.

### F4-INV-02 — A snapshot freezes its meaning

The envelope records content type, content schema version, deterministic schema fingerprint, codec
version and every field's name, description and storage target. A later registry entry cannot add,
remove or redirect fields in an existing snapshot.

### F4-INV-03 — Codecs are explicit and fail closed

Every field and envelope names its codec. Version 1 is the only writable/readable F4 codec. Unknown
formats, unknown codecs, malformed descriptors, inconsistent presence counts, forbidden columns or
protected metadata abort before the safety snapshot and before any content write.

### F4-INV-04 — Legacy history is immutable compatibility data

A manifest-less revision is always decoded as codec 0: title, content, excerpt and the historical
`_puck_data`, `_wjs_template`, `_thumbnail_id`, `seo_title`, `seo_description`, `og_image`, `noindex`
set. Neither a current schema nor a new plugin may reinterpret that set.

### F4-INV-05 — Restore is exact only inside the frozen boundary

Declared metadata absent from a snapshot is cleared; declared raw values are reinserted byte-for-byte.
Metadata and columns absent from the frozen field list are untouched. Canonical key comparison follows
the weakest supported SQL collation, while deletion uses explicit `meta_id` values for engine parity.

### F4-INV-06 — Plugin deactivation preserves data and undo

The inactive-plugin policy is `snapshot-authoritative`: a valid frozen field restores without executing
plugin code or requiring the plugin registry. Before restore, the safety snapshot merges the target's
validated frozen fields with the current declaration, so restoring while a plugin is disabled remains
reversible. Fields introduced after the target snapshot are not cleared.

### F4-INV-07 — The envelope is a protected instruction

Generic REST metadata bags and WXR imports cannot write `_wjs_revision_snapshot`. Parsing is bounded and
strict, storage identifiers come from allowlists, values remain SQL parameters, duplicate canonical
targets are rejected and parent-chain cycles fail atomically.

### F4-INV-08 — F3 remains the mutation boundary

Decode and compatibility checks occur before mutation. The safety revision, column update, metadata
delete/insert, schedule reconciliation and durable `post.updated` event share the pinned F3 transaction.
Injected failure leaves both live content and revision history unchanged.

### F4-INV-09 — Restore cannot bypass field authorization

The REST route inspects the decoded intent after authorizing the parent. Restoring publish/future state
or publication dates requires the declared publish capability; changing parent requires authorization
on the target parent. Incompatible snapshots return conflict without mutation.

### F4-INV-10 — Portability and disclosure are executable

The API returns an additive restore descriptor with compatibility, versions, fingerprint and generated
field descriptions. Verso builds its destructive dialog from that descriptor, including plugin fields
and fields that will be cleared. CI runs the exact F4 update/delete/insert transaction and rollback on
SQLite, real PostgreSQL and real MySQL.

## Consequences

- Plugins add revisionable metadata through their portable content schema, without editing core lists.
- Existing revision REST fields remain compatible; the `restore` descriptor is additive and the
  protected envelope is excluded from `meta`.
- No schema migration is required because the envelope uses `post_meta` and is pruned with its revision.
- Codec evolution requires a new registered decoder; changing codec 1 in place is forbidden.
- The manifest adds bounded metadata per revision, while large author payloads remain in their existing
  raw revision rows rather than being duplicated inside JSON.
